#pragma once

#include <QString>
#include <QStringList>

// Read once at startup. Authentication never trusts identity headers from a proxy.
struct AuthConfig
{
    bool pin = true;
    bool sso = false;
    QString issuer;
    QString clientId;
    QString clientSecret;
    QString publicUrl;
    QString caFile; // Optional additional CA for a private OIDC deployment.
    QStringList adminSubjects;

    static AuthConfig fromEnvironment();
    QString error() const;
    QString callbackUrl() const { return publicUrl + QStringLiteral("/api/auth/oidc/callback"); }
    bool administrator(const QString& subject) const { return adminSubjects.contains(subject); }
};
