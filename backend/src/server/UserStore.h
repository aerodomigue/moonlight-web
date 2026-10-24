#pragma once

#include <QJsonObject>
#include <QMap>
#include <QString>

struct UserAccount
{
    QString id;
    QString issuer;
    QString subject;
    QString name;
    QJsonObject json() const;
};

class UserStore
{
public:
    // Empty path gives a hermetic in-memory store for unit tests.
    explicit UserStore(QString path = {});
    static QString localId() { return QStringLiteral("local-owner"); }
    static QString oidcId(const QString& issuer, const QString& subject);
    UserAccount upsert(const QString& issuer, const QString& subject, const QString& name);
    UserAccount get(const QString& id) const { return m_users.value(id); }
    bool contains(const QString& id) const { return m_users.contains(id); }
    bool hasExternalAccounts() const { return m_users.size() > 1; }

private:
    void save() const;
    QString m_path;
    QMap<QString, UserAccount> m_users;
};
