#include "AuthConfig.h"

#include <QFile>
#include <QFileInfo>
#include <QDir>
#include <QSaveFile>
#include <QJsonDocument>
#include <QCryptographicHash>
#include <QUrl>
#include <QStandardPaths>
#include <QSslCertificate>
#include <stdexcept>

AuthConfig AuthConfig::fromEnvironment()
{
    AuthConfig c;
    const QString methods = qEnvironmentVariable("MW_AUTH_METHODS", "pin").trimmed();
    const QStringList names = methods.split(',', Qt::SkipEmptyParts);
    c.pin = false;
    for (const QString& name : names) {
        if (name.trimmed() == QLatin1String("pin"))
            c.pin = true;
        else if (name.trimmed() == QLatin1String("sso"))
            c.sso = true;
        else
            throw std::runtime_error("MW_AUTH_METHODS accepts pin, sso, or pin,sso");
    }
    c.issuer = qEnvironmentVariable("MW_OIDC_ISSUER").trimmed();
    c.clientId = qEnvironmentVariable("MW_OIDC_CLIENT_ID").trimmed();
    c.scopes = qEnvironmentVariable("MW_OIDC_SCOPES", c.scopes).simplified();
    c.publicUrl = qEnvironmentVariable("MW_PUBLIC_URL").trimmed();
    while (c.publicUrl.endsWith('/'))
        c.publicUrl.chop(1);
    if (!c.sso) {
        if (!c.pin) throw std::runtime_error("At least one authentication method must be enabled");
        return c;
    }
    c.issuer = qEnvironmentVariable("MW_OIDC_ISSUER").trimmed();
    c.clientId = qEnvironmentVariable("MW_OIDC_CLIENT_ID").trimmed();
    c.clientSecret = qEnvironmentVariable("MW_OIDC_CLIENT_SECRET");
    const QString secretFile = qEnvironmentVariable("MW_OIDC_CLIENT_SECRET_FILE");
    if (!secretFile.isEmpty()) {
        QFile file(secretFile);
        if (!file.open(QIODevice::ReadOnly))
            throw std::runtime_error("Cannot read MW_OIDC_CLIENT_SECRET_FILE");
        c.clientSecret = QString::fromUtf8(file.readAll()).trimmed();
    }
    c.publicUrl = qEnvironmentVariable("MW_PUBLIC_URL").trimmed();
    c.caFile = qEnvironmentVariable("MW_OIDC_CA_FILE");
    while (c.publicUrl.endsWith('/'))
        c.publicUrl.chop(1);
    for (const QString& subject : qEnvironmentVariable("MW_OIDC_ADMIN_SUBJECTS").split(',')) {
        if (!subject.trimmed().isEmpty()) c.adminSubjects.append(subject.trimmed());
    }
    const QString error = c.error();
    if (!error.isEmpty()) throw std::runtime_error(error.toStdString());
    return c;
}

QString AuthConfig::error() const
{
    if (!pin && !sso) return QStringLiteral("At least one authentication method must be enabled");
    const auto scopeNames = scopes.split(' ', Qt::SkipEmptyParts);
    if (!scopeNames.contains(QStringLiteral("openid")) || scopes.size() > 2048)
        return QStringLiteral("OIDC scopes must include openid and fit in 2048 characters");
    for (const QChar ch : scopes)
        if (ch.unicode() < 0x20 || ch.unicode() > 0x7e || ch == '"' || ch == '\\')
            return QStringLiteral("Invalid OIDC scope character");
    if (!sso) return {};
    const QUrl url(issuer), origin(publicUrl);
    if (!url.isValid() || url.scheme() != QLatin1String("https") || url.host().isEmpty() ||
        !url.userInfo().isEmpty() || url.hasQuery() || url.hasFragment())
        return QStringLiteral("MW_OIDC_ISSUER must be an HTTPS issuer URL");
    if (!origin.isValid() || origin.scheme() != QLatin1String("https") || origin.host().isEmpty() ||
        !origin.userInfo().isEmpty() || !origin.path().isEmpty() || origin.hasQuery() ||
        origin.hasFragment())
        return QStringLiteral("SSO requires MW_PUBLIC_URL as an HTTPS origin");
    if (!caFile.isEmpty() && QSslCertificate::fromPath(caFile).isEmpty())
        return QStringLiteral("MW_OIDC_CA_FILE contains no readable CA certificate");
    if (clientId.isEmpty()) return QStringLiteral("SSO requires MW_OIDC_CLIENT_ID");
    return {};
}

QJsonObject AuthConfig::json(bool includeSecret) const
{
    QJsonObject o{{"pin", pin},
                  {"sso", sso},
                  {"issuer", issuer},
                  {"client_id", clientId},
                  {"public_url", publicUrl},
                  {"callback_url", callbackUrl()},
                  {"backchannel_logout_url", publicUrl + "/api/auth/oidc/backchannel-logout"},
                  {"ca_file", caFile},
                  {"scopes", scopes},
                  {"secret_configured", !clientSecret.isEmpty()}};
    if (includeSecret) o["client_secret"] = clientSecret;
    return o;
}

AuthConfig AuthConfig::edited(const AuthConfig& current, const QJsonObject& o)
{
    AuthConfig c = current;
    for (const auto& key : {QString("pin"), QString("sso")})
        if (o.contains(key) && !o[key].isBool())
            throw std::runtime_error("Authentication switches must be booleans");
    if (o.contains("pin")) c.pin = o["pin"].toBool();
    if (o.contains("sso")) c.sso = o["sso"].toBool();
    for (const auto& key : {QString("issuer"), QString("client_id"), QString("client_secret"),
                            QString("ca_file"), QString("scopes")})
        if (o.contains(key) && !o[key].isString())
            throw std::runtime_error("Authentication fields must be strings");
    if (o.contains("scopes")) c.scopes = o["scopes"].toString().simplified();
    if (o.contains("issuer")) c.issuer = o["issuer"].toString().trimmed();
    if (o.contains("client_id")) c.clientId = o["client_id"].toString().trimmed();
    if (o.contains("ca_file")) c.caFile = o["ca_file"].toString().trimmed();
    if (o.value("clear_secret").toBool()) c.clientSecret.clear();
    if (!o.value("client_secret").toString().isEmpty())
        c.clientSecret = o["client_secret"].toString();
    if (c.clientSecret.size() > 16384 || c.issuer.size() > 2048 || c.clientId.size() > 1024 ||
        c.caFile.size() > 4096)
        throw std::runtime_error("Authentication configuration too large");
    const auto error = c.error();
    if (!error.isEmpty()) throw std::runtime_error(error.toStdString());
    return c;
}

AuthConfig AuthConfig::load(const QString& path, const AuthConfig& bootstrap)
{
    if (path.isEmpty() || !QFile::exists(path)) return bootstrap;
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly))
        throw std::runtime_error("Cannot read authentication configuration");
    QJsonParseError error;
    const auto doc = QJsonDocument::fromJson(file.readAll(), &error);
    if (error.error != QJsonParseError::NoError || !doc.isObject() || doc["version"].toInt() != 1)
        throw std::runtime_error("Invalid authentication configuration");
    auto c = bootstrap;
    // A managed empty secret explicitly replaces any bootstrap secret.
    c.clientSecret.clear();
    return edited(c, doc.object());
}

void AuthConfig::save(const QString& path) const
{
    if (path.isEmpty()) return;
    QDir().mkpath(QFileInfo(path).absolutePath());
    QSaveFile file(path);
    if (!file.open(QIODevice::WriteOnly))
        throw std::runtime_error("Cannot write authentication configuration");
    file.setPermissions(QFile::ReadOwner | QFile::WriteOwner);
    auto o = json(true);
    o["version"] = 1;
    const auto bytes = QJsonDocument(o).toJson();
    if (file.write(bytes) != bytes.size() || !file.commit())
        throw std::runtime_error("Cannot commit authentication configuration");
}

QString AuthConfig::signature() const
{
    return QString::fromLatin1(
        QCryptographicHash::hash(QJsonDocument(QJsonObject{{"issuer", issuer},
                                                           {"client_id", clientId},
                                                           {"secret", clientSecret},
                                                           {"origin", publicUrl},
                                                           {"ca", caFile},
                                                           {"scopes", scopes}})
                                     .toJson(QJsonDocument::Compact),
                                 QCryptographicHash::Sha256)
            .toHex());
}

AuthConfig AuthConfig::forApplication()
{
    const auto path =
        QStandardPaths::writableLocation(QStandardPaths::AppDataLocation) + "/auth-config.json";
    if (!QFile::exists(path)) return fromEnvironment();
    AuthConfig bootstrap;
    bootstrap.publicUrl = qEnvironmentVariable("MW_PUBLIC_URL").trimmed();
    while (bootstrap.publicUrl.endsWith('/'))
        bootstrap.publicUrl.chop(1);
    bootstrap.adminSubjects =
        qEnvironmentVariable("MW_OIDC_ADMIN_SUBJECTS").split(',', Qt::SkipEmptyParts);
    for (auto& subject : bootstrap.adminSubjects)
        subject = subject.trimmed();
    return load(path, bootstrap);
}
