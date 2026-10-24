#pragma once

#include <QJsonObject>
#include <QMap>
#include <QString>

struct UserAccount
{
    QString id, issuer, subject, name;
    QString role = QStringLiteral("user");
    bool enabled = true;
    bool deleting = false;
    bool managedRole = false;
    bool managedName = false;
    QString verifiedConfig;
    // Local role stays intact for recovery. Only a verified ID-token claim sets ssoRole.
    QString ssoRole = QStringLiteral("user");
    quint64 roleRevision = 0;
    QJsonObject json() const;
    QJsonObject adminJson() const;
};

class UserStore
{
public:
    explicit UserStore(QString path = {});
    static QString localId() { return QStringLiteral("local-owner"); }
    static QString oidcId(const QString& issuer, const QString& subject);
    UserAccount upsert(const QString& issuer, const QString& subject, const QString& name);
    UserAccount createLocal(const QString& name, const QString& role = QStringLiteral("user"));
    UserAccount findIdentity(const QString& issuer, const QString& subject) const;
    void update(const UserAccount& user);
    void bind(const QString& id, const QString& issuer, const QString& subject,
              const QString& verifiedConfig, const QString& ssoRole = QStringLiteral("user"));
    void remove(const QString& id);
    QList<UserAccount> all() const { return m_users.values(); }
    UserAccount get(const QString& id) const { return m_users.value(id); }
    bool contains(const QString& id) const { return m_users.contains(id); }
    bool active(const QString& id) const
    {
        const auto u = get(id);
        return !u.id.isEmpty() && u.enabled && !u.deleting;
    }
    bool hasExternalAccounts() const { return m_users.size() > 1; }

private:
    void commit(const QMap<QString, UserAccount>& users);
    QString m_path;
    QMap<QString, UserAccount> m_users;
};
