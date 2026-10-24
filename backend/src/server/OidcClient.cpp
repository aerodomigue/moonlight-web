#include "OidcClient.h"
#include "AuthManager.h"
#include "AppSettings.h"
#include "HttpServer.h"
#include "OidcToken.h"
#include "RestRouter.h"
#include "common/PairingCrypto.h"
#include <QCryptographicHash>
#include <QDateTime>
#include <QJsonArray>
#include <QJsonDocument>
#include <QNetworkReply>
#include <QRandomGenerator>
#include <QTimer>
#include <QUrlQuery>
#include <QSslCertificate>
#include <QSslConfiguration>
#include <openssl/crypto.h>
#include <stdexcept>

namespace {
bool httpsEndpoint(const QString& endpoint)
{
    const QUrl url(endpoint);
    return url.isValid() && url.scheme() == QLatin1String("https") && !url.host().isEmpty() &&
           url.userInfo().isEmpty() && !url.hasFragment();
}
HttpResponse redirect(const QString& url)
{
    HttpResponse response;
    response.statusCode = 303;
    response.headers["Location"] = url;
    response.headers["Cache-Control"] = "no-store";
    response.headers["Referrer-Policy"] = "no-referrer";
    return response;
}
} // namespace

OidcClient::OidcClient(AuthManager& auth, HttpServer& server, AppSettings& settings)
    : QObject(&server)
    , m_auth(auth)
    , m_server(server)
    , m_settings(settings)
    , m_network(this)
{
    server.router()->postAsync("/api/auth/oidc/prepare",
                               [this](const HttpRequest& req, ResponseCallback respond) {
                                   prepare(req, std::move(respond));
                               });
    server.router()->getAsync("/api/auth/oidc/callback",
                              [this](const HttpRequest& req, ResponseCallback respond) {
                                  callback(req, std::move(respond));
                              });
    server.router()->postAsync("/api/auth/oidc/backchannel-logout",
                               [this](const HttpRequest& req, ResponseCallback done) {
                                   backchannel(req, std::move(done));
                               });
    server.router()->post("/api/auth/oidc/activate", [this](const HttpRequest& req) {
        const auto ticket = QJsonDocument::fromJson(req.body).object()["ticket"].toString();
        if (!m_auth.activateSso(HttpServer::sessionTokenFromRequest(req), ticket, req))
            return HttpResponse::error(401, "sso_revalidation_required");
        return HttpResponse::json({{"ok", true}});
    });
    server.router()->post("/api/auth/ws-ticket", [this](const HttpRequest& req) {
        const auto path = QJsonDocument::fromJson(req.body).object()["path"].toString();
        const auto ticket = req.ssoAuthorized
                                ? m_auth.ssoWsTicket(HttpServer::sessionTokenFromRequest(req),
                                                     req.headers.value("x-mw-page-id"), path)
                                : QString();
        if (ticket.isEmpty()) return HttpResponse::error(403, "Not authorised");
        return HttpResponse::json({{"ticket", ticket}, {"expires_in", 10}});
    });
    registerAdminRoutes();
    connect(&auth, &AuthManager::authConfigChanged, this, [this]() {
        m_pending.clear();
        m_links.clear();
        m_recentLogins.clear();
    });
    auto timer = new QTimer(this);
    connect(timer, &QTimer::timeout, this, &OidcClient::purge);
    timer->start(60000);
}

QString OidcClient::random()
{
    QByteArray bytes(32, '\0');
    for (int i = 0; i < bytes.size(); ++i)
        bytes[i] = static_cast<char>(QRandomGenerator::system()->generate() & 255);
    return QString::fromLatin1(
        bytes.toBase64(QByteArray::Base64UrlEncoding | QByteArray::OmitTrailingEquals));
}

QString OidcClient::digest(const QString& value)
{
    return QString::fromLatin1(
        QCryptographicHash::hash(value.toUtf8(), QCryptographicHash::Sha256)
            .toBase64(QByteArray::Base64UrlEncoding | QByteArray::OmitTrailingEquals));
}

void OidcClient::purge()
{
    const qint64 now = QDateTime::currentSecsSinceEpoch();
    for (auto it = m_recentLogins.begin(); it != m_recentLogins.end();)
        if (now - it->issued >= 30)
            it = m_recentLogins.erase(it);
        else
            ++it;
    for (auto* table : {&m_sidRevocations, &m_subjectRevocations})
        for (auto it = table->begin(); it != table->end();)
            if (it.value() < now - SsoSessionSecurity::Lifetime - 300)
                it = table->erase(it);
            else
                ++it;
    for (auto it = m_links.begin(); it != m_links.end();) {
        if (now - it->issued >= 300)
            it = m_links.erase(it);
        else
            ++it;
    }
    for (auto it = m_pending.begin(); it != m_pending.end();) {
        if (now - it->issued >= 300)
            it = m_pending.erase(it);
        else
            ++it;
    }
}

void OidcClient::requestJson(const AuthConfig& config, const QUrl& url, const QByteArray& body,
                             const QByteArray& basic, bool post, JsonCallback callback)
{
    QNetworkRequest request(url);
    if (!config.caFile.isEmpty()) {
        auto ssl = QSslConfiguration::defaultConfiguration();
        ssl.setCaCertificates(ssl.caCertificates() + QSslCertificate::fromPath(config.caFile));
        request.setSslConfiguration(ssl);
    }
    request.setTransferTimeout(10000);
    request.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                         QNetworkRequest::ManualRedirectPolicy);
    request.setRawHeader("Accept", "application/json");
    if (!basic.isEmpty()) request.setRawHeader("Authorization", "Basic " + basic);
    request.setHeader(QNetworkRequest::ContentTypeHeader, "application/x-www-form-urlencoded");
    QNetworkReply* reply = post ? m_network.post(request, body) : m_network.get(request);
    connect(reply, &QIODevice::readyRead, reply, [reply]() {
        if (reply->bytesAvailable() > 1024 * 1024) reply->abort();
    });
    connect(reply, &QNetworkReply::finished, this, [reply, callback = std::move(callback)]() {
        const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        const QByteArray bytes = reply->readAll();
        QJsonParseError parse;
        const auto doc = QJsonDocument::fromJson(bytes, &parse);
        const bool ok = reply->error() == QNetworkReply::NoError && status == 200 &&
                        bytes.size() <= 1024 * 1024 && parse.error == QJsonParseError::NoError &&
                        doc.isObject();
        reply->deleteLater();
        callback(ok, doc.object());
    });
}

void OidcClient::prepare(const HttpRequest& req, ResponseCallback respond)
{
    const auto& config = m_auth.config();
    if (!config.sso) {
        respond(HttpResponse::error(404, "SSO is disabled"));
        return;
    }
    purge();
    int fromAddress = 0;
    for (const auto& pending : m_pending)
        if (pending.ip == req.clientAddress) ++fromAddress;
    if (m_pending.size() >= 256 || fromAddress >= 32 || m_auth.isRateLimited(req.clientAddress)) {
        respond(HttpResponse::error(429, "Too many login attempts"));
        return;
    }
    const auto body = QJsonDocument::fromJson(req.body).object();
    Pending pending;
    pending.config = config;
    pending.revision = m_auth.configRevision();
    if (req.path.startsWith("/api/admin/")) {
        if (!adminAllowed(req) || !m_auth.users().active(req.pathParams.value("id"))) {
            respond(HttpResponse::error(403,
                                        "Administrator access and an active account are required"));
            return;
        }
        pending.targetUser = req.pathParams.value("id");
    }
    pending.page = body.value("page_id").toString();
    pending.revalidate = body.value("purpose").toString() == "revalidate";
    pending.publicKey = QByteArray::fromBase64(body["public_key"].toString().toLatin1());
    if ((!pending.targetUser.isEmpty() ? !pending.publicKey.isEmpty() : true) &&
        !PairingCrypto::isValidP256Spki(pending.publicKey)) {
        respond(HttpResponse::error(400, "Invalid browser pairing key"));
        return;
    }
    pending.machine = body["machine_name"].toString().left(128);
    pending.previousToken = HttpServer::sessionTokenFromRequest(req);
    if (pending.targetUser.isEmpty() && !SsoSessionSecurity::pageName(pending.page)) {
        respond(HttpResponse::error(400, "Invalid page context"));
        return;
    }
    const auto previous = m_auth.sessionForToken(pending.previousToken);
    if (previous.authMethod == "sso" && !previous.token.isEmpty()) {
        const bool proven =
            previous.pairingKey == pending.publicKey &&
            (req.ssoAuthorized || m_auth.authorizeSsoProof(pending.previousToken, req));
        if (pending.revalidate && !proven) {
            respond(HttpResponse::error(401, "Browser proof required"));
            return;
        }
        if (!proven && pending.targetUser.isEmpty()) pending.previousToken.clear();
    } else if (pending.revalidate) {
        respond(HttpResponse::error(401, "SSO session missing"));
        return;
    }
    pending.remember = body["remember"].toBool(true);
    pending.ip = req.clientAddress;
    pending.issued = QDateTime::currentSecsSinceEpoch();
    pending.verifier = random();
    pending.nonce = random();
    const QString state = random(), cookie = random();
    pending.cookieHash = digest(cookie);
    // Reserve before network I/O so parallel discovery requests are bounded too.
    m_pending.insert(state, pending);
    QString discovery = config.issuer;
    if (!discovery.endsWith('/')) discovery += '/';
    discovery += ".well-known/openid-configuration";
    requestJson(config, QUrl(discovery), {}, {}, false,
                [this, state, cookie, respond](bool ok, const QJsonObject& metadata) {
                    const auto& c = m_auth.config();
                    auto it = m_pending.find(state);
                    if (!ok || it == m_pending.end() || it->revision != m_auth.configRevision() ||
                        metadata["issuer"].toString() != c.issuer ||
                        !httpsEndpoint(metadata["authorization_endpoint"].toString()) ||
                        !httpsEndpoint(metadata["token_endpoint"].toString()) ||
                        !httpsEndpoint(metadata["jwks_uri"].toString()) ||
                        !metadata["code_challenge_methods_supported"].toArray().contains(
                            QStringLiteral("S256"))) {
                        m_pending.remove(state);
                        respond(HttpResponse::error(
                            502, "OIDC discovery failed or provider does not support PKCE S256"));
                        return;
                    }
                    it->metadata = metadata;
                    QUrl authorization(metadata["authorization_endpoint"].toString());
                    QUrlQuery query(authorization);
                    query.addQueryItem("response_type", "code");
                    query.addQueryItem("client_id", c.clientId);
                    query.addQueryItem("redirect_uri", c.callbackUrl());
                    query.addQueryItem("scope", it->config.scopes);
                    if (!it->targetUser.isEmpty())
                        query.addQueryItem("prompt", "select_account");
                    else if (it->revalidate)
                        query.addQueryItem("prompt", "none");
                    query.addQueryItem("state", state);
                    query.addQueryItem("nonce", it->nonce);
                    query.addQueryItem("code_challenge", digest(it->verifier));
                    query.addQueryItem("code_challenge_method", "S256");
                    authorization.setQuery(query);
                    auto response = HttpResponse::json(
                        {{"authorization_url", authorization.toString(QUrl::FullyEncoded)}});
                    response.headers["Set-Cookie"] =
                        "__Host-mw_oidc_" + state + "=" + cookie +
                        "; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=300";
                    respond(response);
                });
}

void OidcClient::callback(const HttpRequest& req, ResponseCallback respond)
{
    if (!m_auth.config().sso) {
        respond(HttpResponse::error(404, "SSO is disabled"));
        return;
    }
    purge();
    const QString state = req.queryParams.value("state");
    const QString cookie = HttpServer::cookieFromRequest(req, "__Host-mw_oidc_" + state);
    const QByteArray expectedCookie = m_pending.value(state).cookieHash.toLatin1();
    const QByteArray actualCookie = digest(cookie).toLatin1();
    if (!m_pending.contains(state) || cookie.isEmpty() ||
        expectedCookie.size() != actualCookie.size() ||
        CRYPTO_memcmp(expectedCookie.constData(), actualCookie.constData(), actualCookie.size()) !=
            0 ||
        !httpsEndpoint(m_pending.value(state).metadata["token_endpoint"].toString())) {
        m_server.reportAuthFailure(req.clientAddress);
        respond(redirect("/?auth_error=sso"));
        return;
    }
    const Pending pending = m_pending.take(state); // one use, even after a provider error
    const auto originalRespond = respond;
    respond = [originalRespond, state](HttpResponse response) {
        response.additionalCookies.append("__Host-mw_oidc_" + state +
                                          "=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
        originalRespond(std::move(response));
    };
    const QString code = req.queryParams.value("code");
    if (code.isEmpty() || code.size() > 4096 || req.queryParams.contains("error") ||
        (req.queryParams.contains("iss") &&
         req.queryParams.value("iss") != m_auth.config().issuer)) {
        respond(redirect("/?auth_error=sso"));
        return;
    }
    const auto config = pending.config;
    if (pending.revision != m_auth.configRevision()) {
        respond(redirect("/?auth_error=sso"));
        return;
    }
    QUrlQuery form;
    form.addQueryItem("grant_type", "authorization_code");
    form.addQueryItem("code", code);
    form.addQueryItem("redirect_uri", config.callbackUrl());
    form.addQueryItem("code_verifier", pending.verifier);
    QByteArray basic;
    const auto methods = pending.metadata["token_endpoint_auth_methods_supported"].toArray();
    if (!config.clientSecret.isEmpty() &&
        (methods.isEmpty() || methods.contains(QStringLiteral("client_secret_basic")))) {
        basic = (QUrl::toPercentEncoding(config.clientId) + ':' +
                 QUrl::toPercentEncoding(config.clientSecret))
                    .toBase64();
    } else if (!config.clientSecret.isEmpty() &&
               methods.contains(QStringLiteral("client_secret_post"))) {
        form.addQueryItem("client_id", config.clientId);
        form.addQueryItem("client_secret", config.clientSecret);
    } else if (config.clientSecret.isEmpty() && methods.contains(QStringLiteral("none"))) {
        form.addQueryItem("client_id", config.clientId);
    } else {
        respond(redirect("/?auth_error=sso"));
        return;
    }
    const QByteArray encoded = form.query(QUrl::FullyEncoded).toUtf8().replace("+", "%2B");
    requestJson(
        config, QUrl(pending.metadata["token_endpoint"].toString()), encoded, basic, true,
        [this, pending, req, respond](bool ok, const QJsonObject& tokens) {
            if (pending.revision != m_auth.configRevision() || !ok ||
                tokens["id_token"].toString().isEmpty()) {
                respond(redirect("/?auth_error=sso"));
                return;
            }
            const QByteArray jwt = tokens["id_token"].toString().toLatin1();
            requestJson(
                pending.config, QUrl(pending.metadata["jwks_uri"].toString()), {}, {}, false,
                [this, pending, req, respond, jwt](bool keysOk, const QJsonObject& keys) {
                    const auto claims =
                        keysOk && pending.revision == m_auth.configRevision()
                            ? OidcToken::verify(jwt, keys, pending.config, pending.nonce,
                                                QDateTime::currentSecsSinceEpoch())
                            : std::nullopt;
                    if (!claims) {
                        respond(redirect("/?auth_error=sso"));
                        return;
                    }
                    try {
                        const auto sidClaim = (*claims)["sid"];
                        const auto sid = sidClaim.toString();
                        if ((claims->contains("sid") &&
                             (!sidClaim.isString() || sid.isEmpty() || sid.size() > 1024)) ||
                            revoked(pending.config.issuer, (*claims)["sub"].toString(), sid,
                                    (*claims)["iat"].toVariant().toLongLong())) {
                            respond(redirect("/?auth_error=sso"));
                            return;
                        }
                        const auto role = (*claims)["moonlight_role"];
                        const auto ssoRole = role.isString() && role.toString() == "internal_admin"
                                                 ? QStringLiteral("admin")
                                                 : QStringLiteral("user");
                        if (!pending.targetUser.isEmpty()) {
                            if (!m_auth.users().active(pending.targetUser)) {
                                respond(redirect("/admin?oidc_link=error"));
                                return;
                            }
                            const auto existing = m_auth.users().findIdentity(
                                pending.config.issuer, (*claims)["sub"].toString());
                            if (!existing.id.isEmpty() && existing.id != pending.targetUser) {
                                respond(redirect("/admin?oidc_link=conflict"));
                                return;
                            }
                            purge();
                            if (m_links.size() >= 256) {
                                respond(redirect("/admin?oidc_link=error"));
                                return;
                            }
                            const auto grant = random();
                            m_links[grant] = {pending.targetUser,
                                              pending.config.issuer,
                                              (*claims)["sub"].toString(),
                                              (*claims)["name"].toString(),
                                              digest(pending.previousToken),
                                              pending.config.signature(),
                                              ssoRole,
                                              pending.revision,
                                              QDateTime::currentSecsSinceEpoch()};
                            auto response = redirect("/admin?oidc_link=ready");
                            response.headers["Set-Cookie"] =
                                "__Host-mw_oidc_link=" + grant +
                                "; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=300";
                            respond(response);
                            return;
                        }
                        const auto before = m_auth.sessionForToken(pending.previousToken);
                        const auto expectedUser = m_auth.users().get(before.userId);
                        if (pending.revalidate &&
                            (before.authMethod != "sso" ||
                             expectedUser.issuer != pending.config.issuer ||
                             expectedUser.subject != (*claims)["sub"].toString())) {
                            m_auth.logoutSession(pending.previousToken);
                            respond(redirect("/?auth_error=sso_account_changed"));
                            return;
                        }
                        auto user = m_auth.users().upsert(
                            pending.config.issuer, (*claims)["sub"].toString(),
                            (*claims)["name"].toString(
                                (*claims)["preferred_username"].toString("User")));
                        if (!m_auth.users().active(user.id)) {
                            respond(redirect("/?auth_error=sso"));
                            return;
                        }
                        user = m_auth.synchronizeSsoRole(user, ssoRole, pending.config);
                        // Unchanged revalidation preserves the cookie and other tabs/streams.
                        const bool reuse =
                            pending.revalidate && m_auth.validateSession(pending.previousToken) &&
                            before.userId == user.id && before.pairingKey == pending.publicKey &&
                            before.ssoSid == sid;
                        const auto recentKey =
                            digest(pending.config.signature() + ':' + user.id + ':' +
                                   PairingCrypto::keyId(pending.publicKey) + ':' + sid + ':' +
                                   QString::number(pending.remember));
                        const auto recent = m_recentLogins.value(recentKey);
                        const bool concurrent =
                            !reuse && !m_auth.validateSession(pending.previousToken) &&
                            recent.issued >= pending.issued && m_auth.validateSession(recent.token);
                        const QString token =
                            reuse ? pending.previousToken
                            : concurrent
                                ? recent.token
                                : m_auth.createSession(req.clientAddress, pending.machine, false,
                                                       !pending.remember, false, user.id, "sso");
                        if (token.isEmpty() ||
                            (!reuse && !concurrent &&
                             !m_auth.establishSso(token, pending.config.issuer, user.subject, sid,
                                                  pending.publicKey)) ||
                            !m_auth.proveSsoAdministrator(
                                token, (*claims)["iat"].toVariant().toLongLong())) {
                            m_auth.logoutSession(token);
                            respond(redirect("/?auth_error=sso"));
                            return;
                        }
                        if (!reuse && !concurrent && m_recentLogins.size() < 1024)
                            m_recentLogins[recentKey] = {token, QDateTime::currentSecsSinceEpoch()};
                        if (!pending.publicKey.isEmpty() &&
                            !m_auth.bindSessionKey(token, pending.publicKey)) {
                            m_auth.logoutSession(token);
                            respond(redirect("/?auth_error=sso"));
                            return;
                        }
                        if (!reuse) m_auth.logoutSession(pending.previousToken);
                        m_auth.authorizeIdentityRenewal(token, m_settings.hostSigningPublicKey());
                        const auto activation = m_auth.ssoActivation(token, pending.page);
                        if (activation.isEmpty()) {
                            m_auth.logoutSession(token);
                            respond(redirect("/?auth_error=sso"));
                            return;
                        }
                        auto response = redirect("/#mw-sso=" + activation + "." + pending.page);
                        response.headers["Set-Cookie"] =
                            "__Host-mw_session=" + token +
                            "; HttpOnly; Secure; SameSite=Strict; Path=/";
                        respond(response);
                    } catch (const std::exception&) {
                        respond(redirect("/?auth_error=sso"));
                    }
                });
        });
}

bool OidcClient::adminAllowed(const HttpRequest& req) const
{
    if (!req.isLocal) return false;
    const auto token = HttpServer::sessionTokenFromRequest(req);
    if (token.isEmpty()) return req.isHostMachine;
    return m_auth.isHostSession(token) || m_auth.isAdminSession(token) || m_auth.isSsoAdmin(token);
}

void OidcClient::testProvider(const AuthConfig& candidate, std::function<void(bool)> done)
{
    auto config = candidate;
    config.sso = true;
    if (!config.error().isEmpty()) {
        done(false);
        return;
    }
    auto discovery = config.issuer;
    if (!discovery.endsWith('/')) discovery += '/';
    requestJson(config, QUrl(discovery + ".well-known/openid-configuration"), {}, {}, false,
                [this, config, done](bool ok, const QJsonObject& metadata) {
                    if (!ok || metadata["issuer"].toString() != config.issuer ||
                        !httpsEndpoint(metadata["authorization_endpoint"].toString()) ||
                        !httpsEndpoint(metadata["token_endpoint"].toString()) ||
                        !httpsEndpoint(metadata["jwks_uri"].toString()) ||
                        !metadata["code_challenge_methods_supported"].toArray().contains(
                            QStringLiteral("S256"))) {
                        done(false);
                        return;
                    }
                    requestJson(config, QUrl(metadata["jwks_uri"].toString()), {}, {}, false,
                                [done](bool keysOk, const QJsonObject& keys) {
                                    bool supported = false;
                                    for (const auto& value : keys["keys"].toArray()) {
                                        const auto k = value.toObject();
                                        supported |=
                                            (k["kty"] == "RSA" && !k["n"].toString().isEmpty() &&
                                             !k["e"].toString().isEmpty()) ||
                                            (k["kty"] == "EC" && k["crv"] == "P-256" &&
                                             !k["x"].toString().isEmpty() &&
                                             !k["y"].toString().isEmpty());
                                    }
                                    done(keysOk && supported);
                                });
                });
}

void OidcClient::registerAdminRoutes()
{
    m_server.router()->get("/api/admin/auth-config", [this](const HttpRequest& req) {
        if (!adminAllowed(req)) return HttpResponse::error(403, "Administrator access required");
        auto o = m_auth.config().json();
        o["sso_only_ready"] = m_auth.verifiedSsoAdministrator(m_auth.config());
        return HttpResponse::json(o);
    });
    m_server.router()->postAsync(
        "/api/admin/auth-config/test", [this](const HttpRequest& req, ResponseCallback respond) {
            if (!adminAllowed(req)) {
                respond(HttpResponse::error(403, "Administrator access required"));
                return;
            }
            try {
                auto config =
                    AuthConfig::edited(m_auth.config(), QJsonDocument::fromJson(req.body).object());
                testProvider(config, [respond](bool ok) {
                    respond(HttpResponse::json({{"ok", ok}, {"secret_verified", false}},
                                               ok ? 200 : 502));
                });
            } catch (const std::exception& e) {
                respond(HttpResponse::error(400, e.what()));
            }
        });
    m_server.router()->postAsync(
        "/api/admin/auth-config", [this](const HttpRequest& req, ResponseCallback respond) {
            if (!adminAllowed(req)) {
                respond(HttpResponse::error(403, "Administrator access required"));
                return;
            }
            try {
                const auto config =
                    AuthConfig::edited(m_auth.config(), QJsonDocument::fromJson(req.body).object());
                const auto revision = m_auth.configRevision();
                auto apply = [this, config, req, respond, revision](bool ok) {
                    if (!ok) {
                        respond(HttpResponse::error(
                            502, "OIDC discovery, TLS or signing keys could not be verified"));
                        return;
                    }
                    if (revision != m_auth.configRevision() || !adminAllowed(req)) {
                        respond(HttpResponse::error(
                            409, "Authentication configuration changed; reload before saving"));
                        return;
                    }
                    try {
                        m_auth.applyConfig(config);
                        auto o = config.json();
                        o["sso_only_ready"] = m_auth.verifiedSsoAdministrator(config);
                        respond(HttpResponse::json(o));
                    } catch (const std::exception& e) {
                        respond(HttpResponse::error(400, e.what()));
                    }
                };
                if (config.sso)
                    testProvider(config, apply);
                else
                    apply(true);
            } catch (const std::exception& e) {
                respond(HttpResponse::error(400, e.what()));
            }
        });
    m_server.router()->postAsync("/api/admin/users/:id/sso/prepare",
                                 [this](const HttpRequest& req, ResponseCallback respond) {
                                     prepare(req, std::move(respond));
                                 });
    auto grantFor = [this](const HttpRequest& req) -> QString {
        purge();
        if (!adminAllowed(req)) return {};
        const auto cookie = HttpServer::cookieFromRequest(req, "__Host-mw_oidc_link");
        auto it = m_links.constFind(cookie);
        if (it == m_links.cend() || it->revision != m_auth.configRevision() ||
            it->adminToken != digest(HttpServer::sessionTokenFromRequest(req)))
            return {};
        return cookie;
    };
    m_server.router()->get("/api/admin/users/sso/pending",
                           [this, grantFor](const HttpRequest& req) {
                               if (!adminAllowed(req))
                                   return HttpResponse::error(403, "Administrator access required");
                               const auto key = grantFor(req);
                               if (key.isEmpty()) return HttpResponse::json({{"pending", false}});
                               const auto grant = m_links.value(key);
                               return HttpResponse::json({{"pending", true},
                                                          {"user_id", grant.user},
                                                          {"issuer", grant.issuer},
                                                          {"subject", grant.subject},
                                                          {"name", grant.name}});
                           });
    m_server.router()->post("/api/admin/users/:id/sso/confirm", [this,
                                                                 grantFor](const HttpRequest& req) {
        const auto key = grantFor(req);
        if (key.isEmpty())
            return HttpResponse::error(403, "Verified identity or administrator session missing");
        const auto grant = m_links.take(key);
        if (grant.user != req.pathParams.value("id") || !m_auth.users().active(grant.user))
            return HttpResponse::error(409, "Account changed during SSO verification");
        const auto user = m_auth.users().get(grant.user);
        if (!user.issuer.isEmpty() &&
            (user.issuer != grant.issuer || user.subject != grant.subject))
            return HttpResponse::error(409, "Account already has a different SSO identity");
        try {
            m_auth.users().bind(grant.user, grant.issuer, grant.subject, grant.signature,
                                grant.role);
            m_auth.revokeUserSessions(grant.user);
            auto response = HttpResponse::json({{"status", "ok"}});
            response.headers["Set-Cookie"] =
                "__Host-mw_oidc_link=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0";
            return response;
        } catch (const std::exception&) {
            return HttpResponse::error(409, "OIDC identity is already assigned");
        }
    });
}

bool OidcClient::revoked(const QString& issuer, const QString& subject, const QString& sid,
                         qint64 issued) const
{
    const auto prefix = issuer + QChar(0);
    return m_subjectRevocations.value(prefix + subject, -1) >= issued ||
           (!sid.isEmpty() && qMax(m_sidRevocations.value(prefix + sid + QChar(0) + subject, -1),
                                   m_sidRevocations.value(prefix + sid + QChar(0), -1)) >= issued);
}
void OidcClient::backchannel(const HttpRequest& req, ResponseCallback done)
{
    const auto config = m_auth.config();
    if (!config.sso || req.body.size() > 65536) {
        done(HttpResponse::error(400, "Invalid logout"));
        return;
    }
    const QUrlQuery form(QString::fromUtf8(req.body));
    const auto jwt = form.queryItemValue("logout_token", QUrl::FullyDecoded).toLatin1();
    if (form.allQueryItemValues("logout_token").size() != 1 || jwt.isEmpty()) {
        done(HttpResponse::error(400, "Invalid logout"));
        return;
    }
    const auto revision = m_auth.configRevision();
    auto discovery = config.issuer;
    if (!discovery.endsWith('/')) discovery += '/';
    requestJson(
        config, QUrl(discovery + ".well-known/openid-configuration"), {}, {}, false,
        [this, config, revision, jwt, done](bool ok, const QJsonObject& metadata) {
            if (!ok || revision != m_auth.configRevision() ||
                metadata["issuer"].toString() != config.issuer ||
                !httpsEndpoint(metadata["jwks_uri"].toString())) {
                done(HttpResponse::error(503, "Provider unavailable"));
                return;
            }
            requestJson(
                config, QUrl(metadata["jwks_uri"].toString()), {}, {}, false,
                [this, config, revision, jwt, done](bool keysOk, const QJsonObject& keys) {
                    if (!keysOk || revision != m_auth.configRevision()) {
                        done(HttpResponse::error(503, "Provider unavailable"));
                        return;
                    }
                    const auto time = QDateTime::currentSecsSinceEpoch();
                    const auto claims = keysOk && revision == m_auth.configRevision()
                                            ? OidcToken::verifyLogout(jwt, keys, config, time)
                                            : std::nullopt;
                    if (!claims) {
                        done(HttpResponse::error(400, "Invalid logout"));
                        return;
                    }
                    for (auto it = m_logoutReceipts.begin(); it != m_logoutReceipts.end();)
                        if (it.value() <= time)
                            it = m_logoutReceipts.erase(it);
                        else
                            ++it;
                    const auto receipt = config.signature() + ':' + (*claims)["jti"].toString();
                    if (m_logoutReceipts.contains(receipt)) {
                        done(HttpResponse::json({{"ok", true}}));
                        return;
                    }
                    const auto sid = (*claims)["sid"].toString(), sub = (*claims)["sub"].toString();
                    const auto issued = (*claims)["iat"].toVariant().toLongLong();
                    auto& tombstones = sid.isEmpty() ? m_subjectRevocations : m_sidRevocations;
                    const auto target =
                        config.issuer + QChar(0) + (sid.isEmpty() ? sub : sid + QChar(0) + sub);
                    tombstones[target] = qMax(tombstones.value(target, -1), issued);
                    try {
                        m_auth.revokeSso(config.issuer, sub, sid, issued);
                        m_logoutReceipts[receipt] = time + 600;
                        done(HttpResponse::json({{"ok", true}}));
                    } catch (const std::exception&) {
                        done(HttpResponse::error(503, "Revocation could not be persisted"));
                    }
                });
        });
}
