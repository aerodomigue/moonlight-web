#include "AdminUserRoutes.h"
#include "server/AuthManager.h"
#include "server/HttpServer.h"
#include "server/RestRouter.h"
#include "server/SessionPool.h"
#include "backend/ComputerManager.h"
#include <QJsonArray>
#include <QJsonDocument>
#include <QTimer>

namespace {
QString physical(const NvComputer* host)
{
    return host->physicalUuid.isEmpty() ? host->uuid : host->physicalUuid;
}
bool busy(const QString& id, const ComputerManager& computers, const SessionPool& pool)
{
    const auto* host = computers.getHost(id);
    if (!host) return false;
    if (computers.hostOperationBusy(id)) return true;
    bool anyWorker = false;
    for (const auto& slot : pool) {
        if (!slot.worker) continue;
        anyWorker = true;
        const auto* other = computers.getHost(slot.hostUuid);
        if (other && physical(other) == physical(host)) return true;
    }
    return !anyWorker && computers.inProcessStreamActive();
}
QJsonObject row(const UserAccount& user, AuthManager& auth, ComputerManager& computers)
{
    auto o = user.adminJson();
    o["role"] = auth.userAdministrator(user) ? "admin" : user.role;
    o["machine_count"] = computers.getHostsJson(user.id).size();
    int count = 0;
    for (const auto& session : auth.sessions())
        if (session.userId == user.id) ++count;
    o["session_count"] = count;
    return o;
}
bool canKeepAccess(const UserAccount& candidate, AuthManager& auth)
{
    if (auth.config().pin) return true; // protected local owner remains recoverable.
    for (auto user : auth.users().all()) {
        if (user.id == candidate.id) user = candidate;
        const bool admin =
            user.role == "admin" || (!user.managedRole && user.issuer == auth.config().issuer &&
                                     auth.config().administrator(user.subject));
        if (user.enabled && !user.deleting && admin && user.issuer == auth.config().issuer &&
            !user.subject.isEmpty() && user.verifiedConfig == auth.config().signature())
            return true;
    }
    return false;
}
bool finishDeletion(const QString& id, AuthManager& auth, ComputerManager& computers,
                    const SessionPool& pool)
{
    const auto hosts = computers.getHostsJson(id);
    for (const auto& value : hosts)
        if (busy(value.toObject()["uuid"].toString(), computers, pool)) return false;
    for (const auto& value : hosts) {
        const auto result = computers.handleDeleteHost(value.toObject()["uuid"].toString());
        if (result.first != 200) return false;
    }
    auth.users().remove(id);
    return true;
}
} // namespace

void registerAdminUserRoutes(HttpServer& server, AuthManager& auth, ComputerManager& computers,
                             SessionPool& pool)
{
    // A deleting account is inaccessible before any replayed storage operation.
    auto recover = [&auth, &computers, &pool]() {
        for (const auto& user : auth.users().all()) {
            if (!user.deleting) continue;
            try {
                auth.revokeUserSessions(user.id);
                finishDeletion(user.id, auth, computers, pool);
            } catch (const std::exception&) { /* Keep blocked and retry; never restore access. */
            }
        }
    };
    recover();
    auto* retry = new QTimer(&server);
    QObject::connect(retry, &QTimer::timeout, &server, recover);
    retry->start(10000);
    auto* router = server.router();
    router->get("/api/admin/users", [&auth, &computers](const HttpRequest& req) {
        if (!req.isLocal) return HttpResponse::error(403, "Administrator access required");
        QJsonArray users;
        for (const auto& user : auth.users().all())
            users.append(row(user, auth, computers));
        return HttpResponse::json({{"users", users}});
    });
    router->post("/api/admin/users", [&auth, &computers](const HttpRequest& req) {
        if (!req.isLocal) return HttpResponse::error(403, "Administrator access required");
        const auto body = QJsonDocument::fromJson(req.body).object();
        try {
            const auto user = auth.users().createLocal(body["name"].toString(),
                                                       body.value("role").toString("user"));
            return HttpResponse::json({{"user", row(user, auth, computers)}}, 201);
        } catch (const std::exception& e) {
            return HttpResponse::error(400, e.what());
        }
    });
    router->post("/api/admin/users/:id", [&auth, &computers](const HttpRequest& req) {
        if (!req.isLocal) return HttpResponse::error(403, "Administrator access required");
        const auto id = req.pathParams.value("id");
        auto user = auth.users().get(id);
        if (user.id.isEmpty()) return HttpResponse::error(404, "User not found");
        if (user.deleting) return HttpResponse::error(409, "Account deletion in progress");
        const auto body = QJsonDocument::fromJson(req.body).object();
        const auto before = user;
        const bool wasAdmin = auth.userAdministrator(before);
        if (body.contains("name")) {
            user.name = body["name"].toString().simplified();
            user.managedName = true;
        }
        if (body.contains("role")) {
            user.role = body["role"].toString();
            user.managedRole = true;
        }
        if (body.contains("enabled")) {
            if (!body["enabled"].isBool())
                return HttpResponse::error(400, "Enabled must be a boolean");
            user.enabled = body["enabled"].toBool();
        }
        if (body.value("unlink_sso").toBool()) {
            user.issuer.clear();
            user.subject.clear();
            user.verifiedConfig.clear();
        }
        if (id == UserStore::localId() && (!user.enabled || user.role != "admin"))
            return HttpResponse::error(403, "Local owner is protected");
        if ((!user.enabled || user.role != "admin") && id == req.userId &&
            auth.userAdministrator(before))
            return HttpResponse::error(
                409, "Use another administrator account to disable or demote this account");
        if (!canKeepAccess(user, auth))
            return HttpResponse::error(
                409, "Keep a verified SSO administrator before changing this account");
        try {
            const bool willBeAdmin =
                user.enabled && (user.role == "admin" ||
                                 (!user.managedRole && user.issuer == auth.config().issuer &&
                                  auth.config().administrator(user.subject)));
            const bool accessChanged = user.enabled != before.enabled || wasAdmin != willBeAdmin ||
                                       before.issuer != user.issuer ||
                                       before.subject != user.subject;
            if (accessChanged && user.enabled) auth.revokeUserSessions(id);
            auth.users().update(user);
            if (!user.enabled || wasAdmin != auth.userAdministrator(user) ||
                before.issuer != user.issuer || before.subject != user.subject)
                auth.revokeUserSessions(id);
            return HttpResponse::json({{"user", row(user, auth, computers)}});
        } catch (const std::exception& e) {
            return HttpResponse::error(400, e.what());
        }
    });
    router->post("/api/admin/users/:id/pin", [&auth](const HttpRequest& req) {
        if (!req.isLocal) return HttpResponse::error(403, "Administrator access required");
        const auto id = req.pathParams.value("id");
        const auto pin = auth.generateUserPin(id);
        if (pin.isEmpty())
            return HttpResponse::error(409, "PIN is disabled or account unavailable");
        return HttpResponse::json(
            {{"pin", pin}, {"expires_in", id == UserStore::localId() ? 0 : 300}});
    });
    router->post("/api/admin/users/:id/revoke-sessions", [&auth](const HttpRequest& req) {
        if (!req.isLocal) return HttpResponse::error(403, "Administrator access required");
        const auto id = req.pathParams.value("id");
        if (!auth.users().contains(id)) return HttpResponse::error(404, "User not found");
        auth.revokeUserSessions(id);
        return HttpResponse::json({{"status", "ok"}});
    });
    router->del("/api/admin/users/:id", [&auth, &computers, &pool](const HttpRequest& req) {
        if (!req.isLocal) return HttpResponse::error(403, "Administrator access required");
        const auto id = req.pathParams.value("id");
        if (id == UserStore::localId() || id == req.userId)
            return HttpResponse::error(403, "This administrative account is protected");
        auto user = auth.users().get(id);
        if (user.id.isEmpty()) return HttpResponse::error(404, "User not found");
        user.enabled = false;
        user.deleting = true;
        if (!canKeepAccess(user, auth))
            return HttpResponse::error(409, "Keep a verified SSO administrator");
        for (const auto& host : computers.getHostsJson(id))
            if (busy(host.toObject()["uuid"].toString(), computers, pool))
                return HttpResponse::error(
                    409, "Stop this account's active host operations before deletion");
        try {
            auth.users().update(user); // durable tombstone before removing any registration.
            auth.revokeUserSessions(id);
            if (!finishDeletion(id, auth, computers, pool))
                return HttpResponse::error(500, "Deletion will resume automatically");
            return HttpResponse::json({{"status", "ok"}});
        } catch (const std::exception&) {
            return HttpResponse::error(
                500, "Deletion could not finish; retry after resolving storage errors");
        }
    });
    router->get("/api/admin/users/:id/hosts", [&computers, &auth](const HttpRequest& req) {
        if (!req.isLocal) return HttpResponse::error(403, "Administrator access required");
        if (!auth.users().contains(req.pathParams.value("id")))
            return HttpResponse::error(404, "User not found");
        return HttpResponse::json({{"hosts", computers.getHostsJson(req.pathParams.value("id"))}});
    });
    for (const bool duplicate : {false, true}) {
        router->post(
            QString("/api/admin/hosts/:id/") + (duplicate ? "duplicate" : "transfer"),
            [&auth, &computers, &pool, duplicate](const HttpRequest& req) {
                if (!req.isLocal) return HttpResponse::error(403, "Administrator access required");
                const auto id = req.pathParams.value("id");
                const auto* source = computers.getHost(id);
                const auto target =
                    QJsonDocument::fromJson(req.body).object()["user_id"].toString();
                if (!source) return HttpResponse::error(404, "Host not found");
                if (!auth.users().contains(source->ownerId) ||
                    auth.users().get(source->ownerId).deleting || !auth.users().contains(target) ||
                    auth.users().get(target).deleting)
                    return HttpResponse::error(409, "Source or destination account unavailable");
                if (busy(id, computers, pool))
                    return HttpResponse::error(409,
                                               "Stop the active stream or host operation first");
                const auto result = computers.reassignHost(id, target, duplicate);
                return HttpResponse::json(result.second, result.first);
            });
    }
    router->del("/api/admin/hosts/:id", [&computers, &pool](const HttpRequest& req) {
        if (!req.isLocal) return HttpResponse::error(403, "Administrator access required");
        const auto id = req.pathParams.value("id");
        const auto* host = computers.getHost(id);
        if (!host) return HttpResponse::error(404, "Host not found");
        if (host->isNativeEngine())
            return HttpResponse::error(403, "Native capture belongs to the local owner");
        if (busy(id, computers, pool))
            return HttpResponse::error(409, "Stop the active stream or host operation first");
        const auto result = computers.handleDeleteHost(id);
        return HttpResponse::json(result.second, result.first);
    });
}
