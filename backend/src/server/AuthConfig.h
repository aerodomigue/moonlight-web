#pragma once

#include <QString>
#include <QStringList>
#include <QJsonObject>

// Persisted configuration overrides environment bootstrap settings. Authentication never trusts
// identity headers from a proxy.
struct AuthConfig
{
    bool pin = true;
    bool sso = false;
    QString issuer;
    QString clientId;
    QString clientSecret;
    QString publicUrl;
    QString scopes = QStringLiteral("openid profile email moonlight_role");
    QString caFile; // Optional additional CA for a private OIDC deployment.
    QStringList adminSubjects;

    static AuthConfig fromEnvironment();
    static AuthConfig forApplication();
    static AuthConfig load(const QString& path, const AuthConfig& bootstrap);
    static AuthConfig edited(const AuthConfig& current, const QJsonObject& json);
    void save(const QString& path) const;
    QJsonObject json(bool includeSecret = false) const;
    QString signature() const;
    QString error() const;
    QString callbackUrl() const { return publicUrl + QStringLiteral("/api/auth/oidc/callback"); }
    bool administrator(const QString& subject) const { return adminSubjects.contains(subject); }
};
