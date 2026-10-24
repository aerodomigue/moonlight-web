/*
 * MoonlightWeb — browser-based Sunshine/GameStream client.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * this program. If not, see <https://www.gnu.org/licenses/>.
 */

#include "server/routes/AuthRoutes.h"

#include "server/HttpServer.h"
#include "server/RestRouter.h"
#include "server/AuthManager.h"
#include "server/OidcClient.h"
#include "server/AppSettings.h"
#include "server/NetClassify.h"
#include "network/GeoIpService.h"
#include "common/Logger.h"
#include "common/PairingCrypto.h"

#include <QCoreApplication>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>

namespace {

/**
 * The session cookie handed back to the browser.
 *
 * Remembered sessions carry a 90-day Max-Age, matching the server-side sliding
 * TTL. A session the visitor asked not to remember deliberately carries none:
 * a cookie without Max-Age/Expires is session-scoped and dies with the browser
 * process, which is what someone on a public machine expects. Never add one
 * later either — the periodic refresh in /api/auth/status would otherwise
 * promote a temporary login to 90 days behind the user's back.
 */
QString sessionCookie(const QString& token, bool remember)
{
    QString cookie =
        QStringLiteral("__Host-mw_session=%1; HttpOnly; Secure; Path=/; SameSite=Strict")
            .arg(token);
    if (remember) cookie += QStringLiteral("; Max-Age=7776000");
    return cookie;
}

/// Expire the session cookie immediately (logout).
QString clearedSessionCookie()
{
    return QStringLiteral(
        "__Host-mw_session=; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=0");
}

/// "remember me" is opt-out: a body without the field keeps the old 90-day
/// behaviour, so older clients and the share flow are unaffected.
bool wantsRemember(const QJsonObject& body)
{
    return body.value(QStringLiteral("remember")).toBool(true);
}

/// The MW-BIND-v1 identity a browser needs to verify this host's SDP offers.
/// `host_id` is the host key's own identifier: it goes inside every signature so
/// one captured from another installation cannot be replayed here.
QJsonObject hostPairingIdentity(AppSettings& settings)
{
    const QByteArray spki = settings.hostSigningPublicKey();
    QJsonObject obj;
    obj["host_public_key"] = QString::fromLatin1(spki.toBase64());
    obj["host_id"] = PairingCrypto::keyId(spki);
    return obj;
}

/// Bind the browser public key carried in a login body, when there is one.
/// Pairing with a PIN is the one moment a key may be registered from anywhere,
/// including the internet: the visitor has just proven they hold the secret.
void bindKeyFromLoginBody(AuthManager& authManager, const QString& token, const QJsonObject& body,
                          QJsonObject& reply, AppSettings& settings)
{
    const QString b64 = body.value(QStringLiteral("public_key")).toString();
    if (b64.isEmpty()) return; // older frontend: nothing to bind, nothing to fail

    if (!authManager.bindSessionKey(token, QByteArray::fromBase64(b64.toUtf8()))) {
        reply["pairing_key"] = "rejected";
        return;
    }
    reply["pairing_key"] = "bound";
    const QJsonObject identity = hostPairingIdentity(settings);
    for (auto it = identity.constBegin(); it != identity.constEnd(); ++it)
        reply[it.key()] = it.value();
}

} // namespace

void registerAuthRoutes(HttpServer& server, AuthManager& authManager, GeoIpService& geoIpService,
                        AppSettings& settings)
{
    new OidcClient(authManager, server, settings);

    server.router()->post(
        "/api/auth/local-session", [&authManager, &settings](const HttpRequest& req) {
            // Only the backend's direct host-machine decision can authorize this.
            // A private address forwarded by a proxy or tunnel never qualifies.
            if (!req.isHostMachine || req.viaProxy || req.viaTunnel)
                return HttpResponse::error(403, "Direct host-machine access required");
            const auto body = QJsonDocument::fromJson(req.body).object();
            const auto key = QByteArray::fromBase64(body["public_key"].toString().toLatin1());
            if (!PairingCrypto::isValidP256Spki(key))
                return HttpResponse::error(400, "Invalid browser pairing key");
            const auto hostKey = settings.hostSigningPublicKey();
            if (!PairingCrypto::isValidP256Spki(hostKey))
                return HttpResponse::error(503, "Host identity unavailable");
            auto token = HttpServer::sessionTokenFromRequest(req);
            const bool created = !authManager.validateSession(token);
            if (created)
                token = authManager.createSession(req.clientAddress, "Local browser", true, true);
            else if (!authManager.isHostSession(token))
                return HttpResponse::error(409, "A different authenticated session already exists");
            if (token.isEmpty() || !authManager.bindSessionKey(token, key)) {
                if (created) authManager.logoutSession(token);
                return HttpResponse::error(409, "Browser key could not be bound");
            }
            if (!authManager.authorizeLocalIdentityRenewal(token, hostKey)) {
                if (created) authManager.logoutSession(token);
                return HttpResponse::error(503, "Local identity authorization unavailable");
            }
            auto response =
                HttpResponse::json({{"host_public_key", QString::fromLatin1(hostKey.toBase64())},
                                    {"host_id", PairingCrypto::keyId(hostKey)},
                                    {"browser_key_id", PairingCrypto::keyId(key)},
                                    {"identity_renewal_available", true}});
            if (created) response.headers["Set-Cookie"] = sessionCookie(token, false);
            return response;
        });

    server.router()->post("/api/auth/identity/renew", [&authManager,
                                                       &settings](const HttpRequest& req) {
        const auto error = [](int status, const QString& message) {
            auto response = HttpResponse::error(status, message);
            response.headers["Cache-Control"] = "no-store";
            return response;
        };
        const auto token = HttpServer::sessionTokenFromRequest(req);
        if (!authManager.validateSession(token)) return error(401, "authentication_required");
        const auto body = QJsonDocument::fromJson(req.body).object();
        const auto browserKey = QByteArray::fromBase64(body["public_key"].toString().toLatin1());
        if (browserKey.isEmpty() || browserKey != authManager.sessionPairingKey(token))
            return error(409, "browser_key_changed");
        const auto hostKey = settings.hostSigningPublicKey();
        if (!authManager.canRenewIdentity(token, browserKey, hostKey))
            return error(403, "identity_reauthentication_required");
        auto response =
            HttpResponse::json({{"host_public_key", QString::fromLatin1(hostKey.toBase64())},
                                {"host_id", PairingCrypto::keyId(hostKey)}});
        response.headers["Cache-Control"] = "no-store";
        return response;
    });

    // ── Auth routes ─────────────────────────────────────────────────────────
    // POST /api/auth/validate — validate PIN or certificate, create session, set cookie
    server.router()->post("/api/auth/validate", [&authManager, &geoIpService,
                                                 &settings](const HttpRequest& req) {
        QJsonDocument doc = QJsonDocument::fromJson(req.body);
        QJsonObject body = doc.object();
        QString pin = body["pin"].toString();
        QString certificate = body["certificate"].toString();
        if (!authManager.config().pin)
            return HttpResponse::error(403, "PIN authentication is disabled");
        QString machineName = body["machine_name"].toString();
        const bool remember = wantsRemember(body);

        // ── Certificate authentication (alternative to PIN) ────────────
        if (!certificate.isEmpty() && authManager.certAuthEnabled()) {
            if (authManager.validateCertificate(certificate)) {
                // Certificate valid — create session (same flow as PIN success)
                QString token =
                    authManager.createSession(req.clientAddress, machineName, false, !remember,
                                              false, UserStore::localId(), "certificate");
                geoIpService.lookupIp(
                    req.clientAddress,
                    [&authManager, token](const QString& city, const QString& country) {
                        authManager.setSessionGeo(token, city, country);
                    });

                QJsonObject obj;
                authManager.logoutSession(HttpServer::sessionTokenFromRequest(req));
                obj["status"] = "ok";
                obj["auth_method"] = "certificate";
                obj["user"] = authManager.users().get(UserStore::localId()).json();
                obj["remembered"] = remember;
                bindKeyFromLoginBody(authManager, token, body, obj, settings);
                HttpResponse resp = HttpResponse::json(obj);
                resp.headers["Set-Cookie"] = sessionCookie(token, remember);
                return resp;
            } else {
                // Certificate invalid
                QJsonObject obj;
                obj["status"] = "error";
                obj["error"] = "invalid_certificate";
                return HttpResponse::json(obj, 401);
            }
        }

        // ── PIN validation (default path) ──────────────────────────────
        if (pin.isEmpty()) return HttpResponse::error(400, "Missing 'pin' field");

        // Counted against the socket peer, or the visitor a local reverse proxy
        // names (AuthManager::attemptAddress).
        QString userId;
        auto result = authManager.validateAccountPin(
            (req.viaProxy ? req.clientAddress
                          : AuthManager::attemptAddress(req.clientAddress, req.headers)),
            pin, userId);

        QJsonObject obj;
        switch (result.result) {
        case AuthManager::Valid: {
            QString token = authManager.createSession(req.clientAddress, machineName, false,
                                                      !remember, false, userId, "pin");

            // Look up the IP geolocation asynchronously and store in the session
            geoIpService.lookupIp(req.clientAddress, [&authManager, token](const QString& city,
                                                                           const QString& country) {
                authManager.setSessionGeo(token, city, country);
            });

            authManager.logoutSession(HttpServer::sessionTokenFromRequest(req));

            // Auto-regenerate PIN — immediately invalidate the just-used PIN
            if (userId == UserStore::localId()) authManager.autoRegeneratePin();

            obj["status"] = "ok";
            obj["pin_regenerated"] = true;
            obj["user"] = authManager.users().get(userId).json();
            obj["remembered"] = remember;
            bindKeyFromLoginBody(authManager, token, body, obj, settings);
            if (obj["pairing_key"] == "bound")
                authManager.authorizeIdentityRenewal(token, settings.hostSigningPublicKey());
            HttpResponse resp = HttpResponse::json(obj);
            resp.headers["Set-Cookie"] = sessionCookie(token, remember);
            return resp;
        }
        case AuthManager::InvalidPin:
            obj["status"] = "error";
            obj["error"] = "invalid_pin";
            obj["remaining"] = result.remainingAttempts;
            obj["lockout_seconds"] = result.lockoutSeconds;
            return HttpResponse::json(obj, 401);
        case AuthManager::RateLimited:
            obj["status"] = "error";
            obj["error"] = "rate_limited";
            obj["lockout_seconds"] = result.lockoutSeconds;
            return HttpResponse::json(obj, 429);
        }
        return HttpResponse::error(500, "Internal error");
    });

    // POST /api/auth/home-screen — a home-screen shortcut's first start.
    //
    // The shortcut opens with the key its manifest carried (see
    // AuthManager::homeScreenKey) and spends it here for a session of its own,
    // registering its own MW-BIND-v1 key like a PIN login does: this browser
    // context has never seen the host, and the key proves the person holding
    // it was signed in on this same device a moment ago.
    //
    // Tunnel only, because the key is only ever written into a manifest served
    // through the tunnel. A failure counts against the abuse guard like a wrong
    // PIN, so the endpoint is no cheaper to guess at than the PIN it stands in for.
    server.router()->post("/api/auth/home-screen", [&server, &authManager, &geoIpService,
                                                    &settings](const HttpRequest& req) {
        const QJsonObject body = QJsonDocument::fromJson(req.body).object();
        const QString key = body.value(QStringLiteral("key")).toString();
        const std::optional<AuthManager::HomeScreenHandoff> handoff =
            req.viaTunnel ? authManager.redeemHomeScreenKey(key) : std::nullopt;
        if (!handoff) {
            server.reportAuthFailure(req.clientAddress);
            Logger::warning(QStringLiteral("[Auth] Home-screen key refused for %1")
                                .arg(AuthManager::cleanClientAddress(req.clientAddress)));
            return HttpResponse::error(403, "This shortcut's key is spent or expired");
        }

        QString machineName = body.value(QStringLiteral("machine_name")).toString().trimmed();
        if (machineName.isEmpty()) machineName = handoff->machineName;
        const QString token =
            authManager.createSession(req.clientAddress, machineName, false, false, false,
                                      handoff->userId, handoff->authMethod);
        geoIpService.lookupIp(req.clientAddress,
                              [&authManager, token](const QString& city, const QString& country) {
                                  authManager.setSessionGeo(token, city, country);
                              });
        Logger::info(QStringLiteral("[Auth] Home-screen shortcut signed in as '%1' (from '%2')")
                         .arg(machineName, handoff->machineName));

        QJsonObject obj;
        obj["status"] = "ok";
        obj["remembered"] = true;
        obj["instances"] = handoff->instances;
        bindKeyFromLoginBody(authManager, token, body, obj, settings);
        HttpResponse resp = HttpResponse::json(obj);
        resp.headers["Set-Cookie"] = sessionCookie(token, true);
        return resp;
    });

    // POST /api/auth/home-screen/key — the key a shortcut made ELSEWHERE would
    // open this machine with.
    //
    // The manifest carries the key of the machine the page is on. For each of
    // the other machines it knows, the page asks this over a connection of its
    // own and writes the answer beside that key, so the shortcut signs in on
    // every machine that was on the line when it was made — and asks the PIN
    // only of the ones that were not. Same key as the manifest would give this
    // session, same terms: signed in, remembered, through the tunnel.
    server.router()->post("/api/auth/home-screen/key", [&authManager](const HttpRequest& req) {
        if (!req.viaTunnel) return HttpResponse::error(404, "Not Found");
        const QString token = HttpServer::sessionTokenFromRequest(req);
        if (!authManager.validateSession(token))
            return HttpResponse::error(401, "Not authenticated");
        const QString key = authManager.homeScreenKey(token);
        if (key.isEmpty())
            return HttpResponse::error(403, "A session that is not remembered hands out no key");
        return HttpResponse::json(QJsonObject{{"key", key}});
    });

    // POST /api/auth/home-screen/instances — the machines this browser knows,
    // kept beside its session for a shortcut made from it. Capped and reduced to
    // the three fields the register reads; anything else is dropped unread.
    server.router()->post("/api/auth/home-screen/instances", [&authManager](
                                                                 const HttpRequest& req) {
        const QString token = HttpServer::sessionTokenFromRequest(req);
        if (!authManager.validateSession(token))
            return HttpResponse::error(401, "Not authenticated");

        const QJsonArray given =
            QJsonDocument::fromJson(req.body).object().value(QStringLiteral("instances")).toArray();
        QJsonArray kept;
        for (const QJsonValue& v : given) {
            const QJsonObject e = v.toObject();
            const QString id = e.value(QStringLiteral("id")).toString();
            const QString name = e.value(QStringLiteral("name")).toString();
            const QString url = e.value(QStringLiteral("url")).toString();
            if (id.isEmpty() || name.isEmpty() || url.isEmpty() || id.size() > 256 ||
                name.size() > 128 || url.size() > 512)
                continue;
            kept.append(QJsonObject{{"id", id}, {"name", name}, {"url", url}});
            if (kept.size() >= 16) break;
        }
        authManager.setHomeScreenInstances(token, kept);
        return HttpResponse::json(QJsonObject{{"status", "ok"}});
    });

    // POST /api/auth/pairing-key — register this browser's MW-BIND-v1 public key
    // on a session that predates the mechanism, and collect the host's own.
    //
    // This is trust-on-first-use over a channel that is already authenticated by
    // the session cookie, so that browsers paired before MW-BIND-v1 existed do
    // not all have to re-enter a PIN. It is deliberately restricted to peers
    // that reached us without crossing the internet — loopback, the LAN, or a
    // mesh VPN. From anywhere else the browser must pair with a PIN, which is
    // the path that carries its key in the login body.
    //
    // A session that already has a key gets the same answer as long as it sends
    // the same key; a *different* key is refused by bindSessionKey().
    server.router()->post("/api/auth/pairing-key", [&authManager,
                                                    &settings](const HttpRequest& req) {
        const QString token = HttpServer::sessionTokenFromRequest(req);
        if (!authManager.validateSession(token))
            return HttpResponse::error(401, "Not authenticated");

        const NetClassify::Kind kind = NetClassify::classify(req.clientAddress);
        if (!NetClassify::isTrustedPeer(kind)) {
            Logger::warning(QStringLiteral("[Auth] Refused silent pairing-key registration from %1 "
                                           "(%2) — PIN required from the internet")
                                .arg(req.clientAddress, NetClassify::toString(kind)));
            return HttpResponse::error(403, "Pair with a PIN from this network");
        }

        const QJsonObject body = QJsonDocument::fromJson(req.body).object();
        const QString b64 = body.value(QStringLiteral("public_key")).toString();
        if (b64.isEmpty()) return HttpResponse::error(400, "Missing 'public_key' field");

        if (!authManager.bindSessionKey(token, QByteArray::fromBase64(b64.toUtf8()))) {
            return HttpResponse::error(409, "This session is already bound to another key");
        }

        QJsonObject obj = hostPairingIdentity(settings);
        obj["status"] = "ok";
        return HttpResponse::json(obj);
    });

    // POST /api/admin/pin/generate — generate a new PIN without revoking sessions (localhost only)
    server.router()->post("/api/admin/pin/generate", [&authManager](const HttpRequest& req) {
        if (!req.isLocal) return HttpResponse::error(403, "Only available from localhost");
        if (!authManager.config().pin)
            return HttpResponse::error(403, "PIN authentication is disabled");

        QString pin = authManager.generatePin();
        QJsonObject obj;
        obj["status"] = "ok";
        obj["pin"] = pin;
        return HttpResponse::json(obj);
    });

    // POST /api/auth/regenerate — regenerate PIN (localhost only)
    server.router()->post("/api/auth/regenerate", [&authManager](const HttpRequest& req) {
        if (!req.isLocal) return HttpResponse::error(403, "Only available from localhost");
        if (!authManager.config().pin)
            return HttpResponse::error(403, "PIN authentication is disabled");

        authManager.regeneratePin();
        QJsonObject obj;
        obj["status"] = "ok";
        obj["pin"] = authManager.currentPin();
        return HttpResponse::json(obj);
    });

    // POST /api/admin/pin/clear — reset PIN to "--------" (localhost only)
    server.router()->post("/api/admin/pin/clear", [&authManager](const HttpRequest& req) {
        if (!req.isLocal) return HttpResponse::error(403, "Only available from localhost");

        authManager.clearPin();
        QJsonObject obj;
        obj["status"] = "ok";
        obj["pin"] = authManager.currentPin();
        return HttpResponse::json(obj);
    });

    // ── Remote admin unlock ─────────────────────────────────────────────────
    // Admin access is granted by address: the host machine has it, nobody else
    // does. These two routes add a second door for a LAN machine that is not
    // the host — the operator sets a password from the host, and any other
    // machine on the same network can spend it to get the same admin page.
    // The owner may also open it to the internet, through the rendezvous only
    // (remote_admin_internet, off by default).
    //
    // POST /api/auth/admin-unlock — spend the password to promote this session.
    server.router()->post("/api/auth/admin-unlock", [&authManager](const HttpRequest& req) {
        // Already an admin (host machine, or unlocked earlier): nothing to do.
        // Answering "ok" keeps the frontend's flow simple and, more to the
        // point, means the host can never burn attempts on its own bucket.
        // isHostMachine as well as isLocal, because isLocal additionally wants
        // the admin key on a POST and the host has no session to fall back on.
        if (req.isLocal || req.isHostMachine) {
            QJsonObject obj;
            obj["status"] = "ok";
            return HttpResponse::json(obj);
        }

        if (!authManager.passwordUnlockEligible(HttpServer::sessionTokenFromRequest(req)))
            return HttpResponse::error(403, "Account is not an administrator");

        // The LAN's door by default: the password is a convenience for the
        // machines in the same house, and a front door on the internet only
        // when the owner opened that side, through the rendezvous or a trusted proxy.
        // What "on this LAN" is worth proving with differs by arrival — see
        // AuthManager::canUnlockAdmin. Every device now reaches an instance
        // through the rendezvous, LAN ones included, so the tunnel case is not
        // an exception carved out of this door: it is the door.
        if (!AuthManager::canUnlockAdmin(req.clientAddress, req.hostTrusted, req.viaTunnel,
                                         authManager.remoteAdminInternet(), req.viaProxy)) {
            QJsonObject obj;
            obj["status"] = "error";
            obj["error"] = "lan_only";
            return HttpResponse::json(obj, 403);
        }

        // The unlock upgrades an existing session rather than creating one, so
        // a device still has to pass the PIN first: the password raises what an
        // already-admitted device may do, it does not admit anyone.
        const QString token = HttpServer::sessionTokenFromRequest(req);
        if (!authManager.validateSession(token)) {
            QJsonObject obj;
            obj["status"] = "error";
            obj["error"] = "not_authenticated";
            return HttpResponse::json(obj, 401);
        }

        // Either the operator turned remote administration off, or they never
        // set a password — there is no built-in default, so an unset password
        // means the door does not open for anyone. Say so plainly instead of
        // letting the caller burn attempts against something nothing can match.
        if (!authManager.remoteAdminEnabled() || !authManager.adminPasswordSet()) {
            QJsonObject obj;
            obj["status"] = "error";
            obj["error"] = "not_configured";
            return HttpResponse::json(obj, 403);
        }

        const QString password = QJsonDocument::fromJson(req.body).object()["password"].toString();
        const auto result = authManager.validateAdminPassword(req.clientAddress, password);

        QJsonObject obj;
        switch (result.result) {
        case AuthManager::Valid:
            if (!authManager.promoteSessionToAdmin(token))
                return HttpResponse::error(500, "Administrator session could not be saved");
            obj["status"] = "ok";
            return HttpResponse::json(obj);
        case AuthManager::InvalidPin:
            obj["status"] = "error";
            obj["error"] = "invalid_password";
            obj["remaining"] = result.remainingAttempts;
            obj["lockout_seconds"] = result.lockoutSeconds;
            return HttpResponse::json(obj, 401);
        case AuthManager::RateLimited:
            obj["status"] = "error";
            obj["error"] = "rate_limited";
            obj["lockout_seconds"] = result.lockoutSeconds;
            return HttpResponse::json(obj, 429);
        }
        return HttpResponse::error(500, "Internal error");
    });

    // POST /api/admin/password — change the remote admin password and/or turn
    // remote administration on and off, from the LAN or also from the internet
    // (admin only). Body may carry any of {password, clear, enabled, internet}; the
    // toggles are applied first so a single call can re-enable the door and set
    // a password behind it.
    server.router()->post("/api/admin/password", [&authManager](const HttpRequest& req) {
        if (!req.isLocal) return HttpResponse::error(403, "Only available from localhost");

        const QJsonObject body = QJsonDocument::fromJson(req.body).object();
        const QString password = body["password"].toString();

        // Changing any setting revokes every unlock the old password bought,
        // which would include the caller's own if they are a remote admin doing
        // the reset. They just proved they are an admin, so hand it back — as
        // long as the door still lets them in from where they are: closing the
        // internet side from the internet closes it on the caller too.
        const QString token = HttpServer::sessionTokenFromRequest(req);
        const bool callerWasRemoteAdmin = authManager.isAdminSession(token);

        if (body.contains("enabled")) authManager.setRemoteAdminEnabled(body["enabled"].toBool());
        if (body.contains("internet"))
            authManager.setRemoteAdminInternet(body["internet"].toBool());

        // {"clear": true} forgets the password; one given alongside replaces it.
        if (body["clear"].toBool(false) && password.isEmpty()) authManager.clearAdminPassword();
        if (!password.isEmpty() && !authManager.setAdminPassword(password)) {
            QJsonObject obj;
            obj["status"] = "error";
            obj["error"] = "too_short";
            obj["min_length"] = AuthManager::MIN_ADMIN_PASSWORD_LEN;
            return HttpResponse::json(obj, 400);
        }
        // Removing the password removes the caller's way in along with everyone's.
        if (callerWasRemoteAdmin && authManager.remoteAdminEnabled() &&
            authManager.adminPasswordSet() &&
            AuthManager::canUnlockAdmin(req.clientAddress, req.hostTrusted, req.viaTunnel,
                                        authManager.remoteAdminInternet(), req.viaProxy))
            if (!authManager.promoteSessionToAdmin(token))
                return HttpResponse::error(500, "Administrator session could not be saved");

        QJsonObject obj;
        obj["status"] = "ok";
        obj["remote_admin_enabled"] = authManager.remoteAdminEnabled();
        obj["remote_admin_internet"] = authManager.remoteAdminInternet();
        obj["admin_password_set"] = authManager.adminPasswordSet();
        return HttpResponse::json(obj);
    });

    // GET /api/auth/status — check current auth status
    server.router()->get("/api/auth/status", [&authManager, &geoIpService,
                                              &settings](const HttpRequest& req) {
        QJsonObject obj;
        QString authedToken; // set when a valid session cookie is found below
        const QString currentToken = HttpServer::sessionTokenFromRequest(req);
        const auto candidate = authManager.sessionForToken(currentToken);
        if (!candidate.token.isEmpty() && candidate.authMethod == "sso" && !req.ssoAuthorized) {
            auto response = HttpResponse::json({{"authenticated", false},
                                                {"is_localhost", false},
                                                {"is_host_machine", false},
                                                {"auth_method", "sso"},
                                                {"sso_revalidation_required", true},
                                                {"sso_session_id", candidate.token},
                                                {"server_time", QDateTime::currentSecsSinceEpoch()},
                                                {"pin_enabled", authManager.config().pin},
                                                {"sso_enabled", authManager.config().sso},
                                                {"sso_origin", authManager.config().publicUrl}});
            response.headers["Cache-Control"] = "no-store";
            return response;
        }
        if (authManager.validateSession(currentToken)) {
            authedToken = currentToken;
            authManager.touchSession(currentToken);
        }

        bool isLocal = req.isLocal;
        // Historical name: it means "has admin access", which since the remote
        // admin password is no longer the same thing as "is the host machine".
        obj["is_localhost"] = isLocal;
        obj["is_host_machine"] = req.isHostMachine;
        // --noadmin: nobody administers, the browser on the host still streams.
        obj["admin_locked"] = req.adminLocked;
        const bool hostTrusted = isLocal || (req.adminLocked && req.isHostMachine);

        if (isLocal) {
            obj["authenticated"] = true; // localhost is always authenticated
            obj["pin"] = authManager.currentPin();
            obj["pin_consumed"] = authManager.isPinConsumed();
            obj["remote_admin_enabled"] = authManager.remoteAdminEnabled();
            obj["remote_admin_internet"] = authManager.remoteAdminInternet();
            // Drives the admin page's banner: remote administration is on but no
            // password has been set, so the LAN door is advertised and shut. The
            // owner is the only one who can open it, and only from here.
            obj["admin_password_set"] = authManager.adminPasswordSet();
        } else if (hostTrusted) {
            obj["authenticated"] = true; // the booth itself: streams, never asked a PIN
        } else {
            // Check session cookie
            bool auth = false;
            const QString token = HttpServer::sessionTokenFromRequest(req);
            if (authManager.validateSession(token)) {
                auth = true;
                authedToken = token;
                authManager.touchSession(token);
                if (authManager.updateSessionAddress(token, req.clientAddress)) {
                    geoIpService.lookupIp(
                        req.clientAddress,
                        [&authManager, token](const QString& city, const QString& country) {
                            authManager.setSessionGeo(token, city, country);
                        });
                }
            }
            obj["authenticated"] = auth;
            if (!auth) {
                obj["remaining"] = authManager.remainingAttempts(
                    (req.viaProxy ? req.clientAddress
                                  : AuthManager::attemptAddress(req.clientAddress, req.headers)));
                int lockoutSecs = authManager.lockoutSeconds(
                    (req.viaProxy ? req.clientAddress
                                  : AuthManager::attemptAddress(req.clientAddress, req.headers)));
                if (lockoutSecs > 0) obj["lockout_seconds"] = lockoutSecs;
            }
        }

        const auto currentSession = authManager.sessionForToken(currentToken);
        obj["auth_method"] = currentSession.token.isEmpty()
                                 ? (req.isHostMachine ? QStringLiteral("host") : QString())
                                 : currentSession.authMethod;
        obj["effective_role"] =
            (req.isHostMachine ||
             (authManager.validateSession(currentToken) &&
              (authManager.userAdministrator(authManager.users().get(req.userId)) ||
               authManager.passwordUnlockEligible(currentToken))))
                ? "admin"
                : "user";
        obj["admin_access"] = isLocal;
        obj["user_admin_enabled"] = true;
        obj["pin_enabled"] = authManager.config().pin;
        obj["sso_enabled"] = authManager.config().sso;
        obj["sso_origin"] = authManager.config().sso ? authManager.config().publicUrl : QString();
        if (!req.userId.isEmpty()) obj["user"] = authManager.users().get(req.userId).json();
        if (obj["authenticated"].toBool()) {
            const auto identity = hostPairingIdentity(settings);
            for (auto it = identity.constBegin(); it != identity.constEnd(); ++it)
                obj[it.key()] = it.value();
        }
        obj["identity_renewal_available"] =
            authManager.canRenewIdentity(currentToken, authManager.sessionPairingKey(currentToken),
                                         settings.hostSigningPublicKey());
        obj["browser_key_id"] = PairingCrypto::keyId(authManager.sessionPairingKey(currentToken));
        obj["requires_pin"] = !hostTrusted && authManager.config().pin;
        obj["active_sessions"] = authManager.activeSessionCount();
        obj["cert_auth_enabled"] = authManager.config().pin && authManager.certAuthEnabled();
        // Tells the frontend to offer the admin page behind a password prompt.
        // Mirrors exactly what /api/auth/admin-unlock will accept, so the
        // button never appears where the unlock would be refused.
        obj["admin_unlock_available"] =
            !isLocal && !req.adminLocked && obj["authenticated"].toBool() &&
            authManager.passwordUnlockEligible(currentToken) && authManager.remoteAdminEnabled() &&
            authManager.adminPasswordSet() &&
            AuthManager::canUnlockAdmin(req.clientAddress, req.hostTrusted, req.viaTunnel,
                                        authManager.remoteAdminInternet(), req.viaProxy);

        // Whether this browser holds a session cookie at all — true even on
        // localhost, where authenticated is hardcoded. It is what tells the UI
        // that there is something to log out of: the loopback page has no
        // session, a host-key browser on the public domain has one.
        obj["has_session"] = authManager.validateSession(HttpServer::sessionTokenFromRequest(req));

        HttpResponse resp = HttpResponse::json(obj);
        resp.headers["Cache-Control"] = "no-store";
        // Slide the cookie browser-side too, so an active client keeps a fresh
        // 90-day window without ever re-entering the PIN. A session the visitor
        // asked not to remember stays session-scoped — see sessionCookie().
        if (!authedToken.isEmpty()) {
            resp.headers["Set-Cookie"] = sessionCookie(
                authedToken, authManager.sessionForToken(authedToken).authMethod != "sso" &&
                                 !authManager.isEphemeralSession(authedToken));
        }
        return resp;
    });

    // Generate a short-lived one-use pairing PIN for this account (or an admin target).
    server.router()->post("/api/auth/pin", [&authManager](const HttpRequest& req) {
        if (req.userId.isEmpty()) return HttpResponse::error(401, "Not authenticated");
        const auto body = QJsonDocument::fromJson(req.body).object();
        const QString target = body.value("user_id").toString(req.userId);
        if (target != req.userId && !req.isLocal) return HttpResponse::error(403, "Not authorised");
        const QString pin = authManager.generateUserPin(target);
        if (pin.isEmpty())
            return HttpResponse::error(403, "PIN is disabled or account does not exist");
        return HttpResponse::json({{"pin", pin},
                                   {"user_id", target},
                                   {"expires_in", target == UserStore::localId() ? 0 : 300}});
    });

    // POST /api/auth/logout — end *this* browser's session.
    //
    // Deliberately not localhost-gated, unlike /api/auth/sessions/revoke: a
    // visitor holds nothing but their own cookie, so the worst they can do is
    // lock themselves out. That is the whole point — leaving a public machine
    // must not require reaching the host's admin page.
    server.router()->post("/api/auth/logout", [&authManager](const HttpRequest& req) {
        const QString token = HttpServer::sessionTokenFromRequest(req);
        const bool destroyed = authManager.logoutSession(token);

        QJsonObject obj;
        obj["status"] = "ok";
        obj["had_session"] = destroyed;
        HttpResponse resp = HttpResponse::json(obj);
        // Clear the cookie either way: a token the server does not know is
        // exactly what a stale cookie looks like, and it should go too.
        resp.headers["Set-Cookie"] = clearedSessionCookie();
        return resp;
    });

    // GET /api/auth/sessions — list active sessions with metadata (localhost only)
    server.router()->get(
        "/api/auth/sessions", [&authManager, &geoIpService](const HttpRequest& req) {
            if (!req.isLocal) return HttpResponse::error(403, "Only available from localhost");

            // Which row is the caller itself. Revoking it logs this browser out
            // — and for the host machine's own session, costs it its admin
            // access until it redeems a fresh host key — so the UI must be able
            // to say so before the click rather than after.
            const QString currentId =
                authManager.sessionIdForToken(HttpServer::sessionTokenFromRequest(req));

            QJsonArray arr;
            const auto sessions = authManager.sessions();
            for (const auto& s : sessions) {
                QJsonObject entry = s.toJson();
                if (s.userId != UserStore::localId())
                    entry["user_name"] = authManager.users().get(s.userId).name;
                // "Local" for private IPs, else city/country from stored geo data
                entry["location"] = AuthManager::isPrivateIP(s.ip);
                entry["current"] = !currentId.isEmpty() && s.token == currentId;
                arr.append(entry);
            }
            QJsonObject obj;
            obj["sessions"] = arr;
            return HttpResponse::json(obj);
        });

    // POST /api/auth/sessions/revoke — revoke a session (token in JSON body, localhost only)
    server.router()->post("/api/auth/sessions/revoke", [&authManager](const HttpRequest& req) {
        if (!req.isLocal) return HttpResponse::error(403, "Only available from localhost");

        QJsonDocument doc = QJsonDocument::fromJson(req.body);
        QString token = doc.object().value("token").toString();
        Logger::info(QString("[Auth] Revoke request — token='%1', size=%2")
                         .arg(token, QString::number(token.size())));
        if (token.isEmpty()) return HttpResponse::error(400, "Missing 'token' in request body");

        // Never the session making the request. Revoking yourself is not an
        // operation anyone wants — on the host machine's own session it costs
        // the admin access that was being used to click, and takes the stream
        // that session is flagged with down with it. The admin page does not
        // even list that row; this is the half of the guard a stray or replayed
        // request cannot get around.
        const QString currentId =
            authManager.sessionIdForToken(HttpServer::sessionTokenFromRequest(req));
        if (!currentId.isEmpty() && token == currentId) {
            Logger::warning("[Auth] Refused to revoke the caller's own session");
            QJsonObject obj;
            obj["status"] = "error";
            obj["error"] = "cannot_revoke_self";
            return HttpResponse::json(obj, 409);
        }

        authManager.destroySession(token);
        QJsonObject obj;
        obj["status"] = "revoked";
        return HttpResponse::json(obj);
    });

    // GET /api/admin/certificate/download — download certificate token (localhost only)
    server.router()->get("/api/admin/certificate/download", [&authManager](const HttpRequest& req) {
        if (!req.isLocal) return HttpResponse::error(403, "Only available from localhost");

        QString token = authManager.certificateToken();
        if (token.isEmpty()) return HttpResponse::error(500, "Certificate token not initialized");

        HttpResponse resp;
        resp.statusCode = 200;
        resp.contentType = "text/plain; charset=utf-8";
        resp.headers["Content-Disposition"] =
            "attachment; filename=\"moonlightweb-certificate.txt\"";
        resp.body = token.toUtf8();
        return resp;
    });

    // POST /api/admin/certificate/regenerate — generate a new certificate token (localhost only)
    server.router()->post("/api/admin/certificate/regenerate",
                          [&authManager](const HttpRequest& req) {
                              if (!req.isLocal)
                                  return HttpResponse::error(403, "Only available from localhost");

                              QString newToken = authManager.generateCertificateToken();
                              QJsonObject obj;
                              obj["status"] = "ok";
                              obj["certificate_regenerated"] = true;
                              Logger::info("[Auth] Certificate token regenerated by admin");
                              return HttpResponse::json(obj);
                          });
}
