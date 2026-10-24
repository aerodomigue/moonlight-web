#pragma once

#include "AuthConfig.h"
#include "common/Types.h"
#include <QObject>
#include <QHash>
#include <QNetworkAccessManager>

class AuthManager;
class HttpServer;
class AppSettings;

class OidcClient : public QObject
{
public:
    OidcClient(AuthManager& auth, HttpServer& server, AppSettings& settings);

private:
    struct Pending
    {
        QString cookieHash, verifier, nonce, machine, ip, previousToken, page;
        QString returnPath = QStringLiteral("/");
        bool revalidate = false;
        QByteArray publicKey;
        bool remember = true;
        qint64 issued = 0;
        QJsonObject metadata;
        AuthConfig config;
        quint64 revision = 0;
        QString targetUser;
    };
    struct RecentLogin
    {
        QString token;
        qint64 issued = 0;
    };
    struct LinkGrant
    {
        QString user, issuer, subject, name, adminToken, signature, role;
        quint64 revision = 0;
        qint64 issued = 0;
    };
    using JsonCallback = std::function<void(bool, QJsonObject)>;
    void requestJson(const AuthConfig& config, const QUrl& url, const QByteArray& body,
                     const QByteArray& basic, bool post, JsonCallback callback);
    void prepare(const HttpRequest& req, ResponseCallback respond);
    void callback(const HttpRequest& req, ResponseCallback respond);
    void purge();
    bool adminAllowed(const HttpRequest& req) const;
    void testProvider(const AuthConfig& config, std::function<void(bool)> callback);
    void registerAdminRoutes();
    void backchannel(const HttpRequest& req, ResponseCallback respond);
    bool revoked(const QString& issuer, const QString& subject, const QString& sid,
                 qint64 issued) const;
    static QString random();
    static QString digest(const QString& value);
    AuthManager& m_auth;
    HttpServer& m_server;
    AppSettings& m_settings;
    QNetworkAccessManager m_network;
    QHash<QString, Pending> m_pending;
    QHash<QString, RecentLogin> m_recentLogins;
    QHash<QString, LinkGrant> m_links;
    QHash<QString, qint64> m_logoutReceipts, m_subjectRevocations, m_sidRevocations;
};
