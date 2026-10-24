#pragma once

#include "AuthConfig.h"
#include "common/Types.h"
#include <QObject>
#include <QHash>
#include <QNetworkAccessManager>

class AuthManager;
class HttpServer;

class OidcClient : public QObject
{
public:
    OidcClient(AuthManager& auth, HttpServer& server);

private:
    struct Pending
    {
        QString cookieHash, verifier, nonce, machine, ip, previousToken;
        QByteArray publicKey;
        bool remember = true;
        qint64 issued = 0;
        QJsonObject metadata;
    };
    using JsonCallback = std::function<void(bool, QJsonObject)>;
    void requestJson(const QUrl& url, const QByteArray& body, const QByteArray& basic, bool post,
                     JsonCallback callback);
    void prepare(const HttpRequest& req, ResponseCallback respond);
    void callback(const HttpRequest& req, ResponseCallback respond);
    void purge();
    static QString random();
    static QString digest(const QString& value);
    AuthManager& m_auth;
    HttpServer& m_server;
    QNetworkAccessManager m_network;
    QHash<QString, Pending> m_pending;
};
