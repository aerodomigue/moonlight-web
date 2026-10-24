#include "AuthConfig.h"

#include <QFile>
#include <QUrl>
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
