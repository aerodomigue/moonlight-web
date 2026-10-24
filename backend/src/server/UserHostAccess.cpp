#include "UserHostAccess.h"
#include "AuthManager.h"
#include "HttpServer.h"
#include "RequestGuard.h"
#include "SessionPool.h"
#include "UserAccess.h"
#include "backend/ComputerManager.h"
#include <QJsonDocument>

namespace {
bool localPeer(const HttpRequest& req)
{
    return !req.viaProxy && !req.viaTunnel && HttpServer::isLocalRequest(req.clientAddress) &&
           RequestGuard::isLocalHostName(req.headers.value("host"));
}
QString physical(const NvComputer* host)
{
    return host->physicalUuid.isEmpty() ? host->uuid : host->physicalUuid;
}
} // namespace

void installUserHostAccess(HttpServer& server, AuthManager& auth, ComputerManager& computers,
                           SessionPool& pool)
{
    computers.setOwnerActivePredicate(
        [&auth](const QString& id) { return auth.users().active(id); });
    server.setRequestAuthorizer([&computers,
                                 &pool](HttpRequest& req) -> std::optional<HttpResponse> {
        if (req.path.startsWith("/api/share/") && !req.path.startsWith("/api/share/player/")) {
            if (req.userId != UserStore::localId())
                return HttpResponse::error(
                    403, "Invitations are currently restricted to the local owner");
            const auto* primary = computers.getHost(pool.at(0).hostUuid);
            if (primary && primary->ownerId != req.userId)
                return HttpResponse::error(403, "Not authorised for this sharing board");
            const auto body = QJsonDocument::fromJson(req.body).object();
            const QString id = body.value("host_uuid").toString(req.queryParams.value("host"));
            if (!id.isEmpty()) {
                const auto* host = computers.getHost(id);
                if (!host || host->ownerId != req.userId)
                    return HttpResponse::error(404, "Host not found");
            }
        }
        if (!req.path.startsWith("/api/hosts")) return std::nullopt;
        if (req.userId.isEmpty()) return HttpResponse::error(401, "Not authenticated");
        const auto segments = req.path.split('/');
        const bool createOrScan = req.method == QLatin1String("POST") &&
                                  (req.path == QLatin1String("/api/hosts/manual") ||
                                   req.path == QLatin1String("/api/hosts/scan"));
        if (segments.size() >= 4 && !createOrScan) {
            const NvComputer* host = computers.getHost(segments[3]);
            if (!host || !UserAccess::owns(req.userId, host->ownerId))
                return HttpResponse::error(404, "Host not found");
            if (req.method == QLatin1String("DELETE") && computers.hostOperationBusy(host->uuid))
                return HttpResponse::error(
                    409, "Stop the active host operation before deleting this registration");
            if (req.method == QLatin1String("DELETE")) {
                bool anyWorker = false;
                for (const auto& slot : pool) {
                    if (!slot.worker) continue;
                    anyWorker = true;
                    const auto* other = computers.getHost(slot.hostUuid);
                    if (other && physical(other) == physical(host))
                        return HttpResponse::error(
                            409, "Stop the active stream before deleting this registration");
                }
                if (!anyWorker && computers.inProcessStreamActive())
                    return HttpResponse::error(
                        409, "Stop the active stream before deleting this registration");
            }
            // A single-user Sunshine/Apollo cannot isolate simultaneous desktops.
            // Refuse a takeover of somebody else's independently registered PC.
            const bool changesStream =
                segments.size() >= 5 &&
                (segments[4] == QLatin1String("start") || segments[4] == QLatin1String("quit") ||
                 segments[4] == QLatin1String("resume") ||
                 segments[4] == QLatin1String("stop-session") ||
                 segments[4] == QLatin1String("restart"));
            if (changesStream &&
                (host->backendType.isEmpty() || host->backendType == QLatin1String("gamestream"))) {
                for (const auto& slot : pool) {
                    const auto* other = computers.getHost(slot.hostUuid);
                    if (slot.worker && other && other->ownerId != req.userId &&
                        physical(other) == physical(host))
                        return HttpResponse::error(409, "This PC is in use by another account");
                }
            }
            if (changesStream &&
                (host->backendType.isEmpty() || host->backendType == QLatin1String("gamestream"))) {
                req.authorizationLease = computers.acquireHostLease(host->uuid, req.userId);
                if (!req.authorizationLease)
                    return HttpResponse::error(
                        409, "This PC has an operation in progress for another account");
            }
            if (segments.size() >= 5 && segments[4] == QLatin1String("start")) {
                const auto body = QJsonDocument::fromJson(req.body).object();
                if (body.value("standby").toBool()) {
                    const int index = qBound(0, body.value("session_slot").toInt(1), 1);
                    const auto& slot = pool.at(index);
                    const QString token = HttpServer::sessionTokenFromRequest(req);
                    if (slot.worker && slot.sessionToken != token)
                        return HttpResponse::error(409,
                                                   "This standby slot belongs to another session");
                }
            }
        }
        const QString device = req.queryParams.value("client_uniqueid");
        if (!device.isEmpty())
            req.queryParams["client_uniqueid"] = UserAccess::deviceId(req.userId, device);
        if (!req.body.isEmpty()) {
            auto body = QJsonDocument::fromJson(req.body).object();
            if (body.contains("client_uniqueid")) {
                body["client_uniqueid"] =
                    UserAccess::deviceId(req.userId, body["client_uniqueid"].toString());
                req.body = QJsonDocument(body).toJson(QJsonDocument::Compact);
            }
        }
        return std::nullopt;
    });

    server.setOwnerSlotAuthorizer([&auth, &pool](const HttpRequest& req, int slot) {
        const QString token = HttpServer::sessionTokenFromRequest(req);
        if (slot < 0) // /ws/control drives the administration UI, not a stream.
            return localPeer(req) || auth.isHostSession(token) || auth.isAdminSession(token) ||
                   auth.isSsoAdmin(token);
        if (!pool.isValid(slot)) return false;
        const auto& owned = pool.at(slot);
        if (!owned.sessionToken.isEmpty())
            return auth.validateSession(token) && token == owned.sessionToken;
        // The legacy local-only path may run without a stream worker/session.
        if (localPeer(req)) return true;
        return !auth.config().sso && auth.validateSession(token) &&
               auth.sessionForToken(token).userId == UserStore::localId() && !owned.worker;
    });
}
