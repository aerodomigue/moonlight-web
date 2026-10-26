#include "UserStore.h"

#include <QCryptographicHash>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QSaveFile>
#include <QUuid>
#include <QRegularExpression>
#include <stdexcept>

QJsonObject UserAccount::json() const
{
    return {{"id", id}, {"name", name}};
}

QJsonObject UserAccount::adminJson() const
{
    auto o = json();
    o["issuer"] = issuer;
    o["subject"] = subject;
    o["role"] = role;
    o["sso_role"] = ssoRole;
    o["role_source"] = issuer.isEmpty() ? "local" : "authentik";
    o["enabled"] = enabled;
    o["deleting"] = deleting;
    o["protected"] = id == UserStore::localId();
    o["sso_linked"] = !issuer.isEmpty();
    return o;
}

QString UserStore::oidcId(const QString& issuer, const QString& subject)
{
    const QByteArray input =
        QByteArray::number(issuer.toUtf8().size()) + ':' + issuer.toUtf8() + subject.toUtf8();
    return QStringLiteral("oidc-") +
           QString::fromLatin1(QCryptographicHash::hash(input, QCryptographicHash::Sha256).toHex());
}

UserStore::UserStore(QString path)
    : m_path(std::move(path))
{
    UserAccount owner{localId(), {}, {}, QStringLiteral("Local owner")};
    owner.role = QStringLiteral("admin");
    m_users.insert(localId(), owner);
    if (m_path.isEmpty() || !QFile::exists(m_path)) return;
    QFile file(m_path);
    if (!file.open(QIODevice::ReadOnly)) throw std::runtime_error("Cannot read user store");
    QJsonParseError error;
    const auto doc = QJsonDocument::fromJson(file.readAll(), &error);
    if (error.error != QJsonParseError::NoError || !doc.isObject() || !doc["users"].isArray())
        throw std::runtime_error("Invalid user store; refusing to discard accounts");
    const int version = doc["version"].toInt(1);
    if (version != 1 && version != 2 && version != 3 && version != 4)
        throw std::runtime_error("Unsupported user store version");
    QMap<QString, bool> seen;
    for (const auto& value : doc["users"].toArray()) {
        const auto o = value.toObject();
        UserAccount u{o["id"].toString(), o["issuer"].toString(), o["subject"].toString(),
                      o["name"].toString()};
        if (u.name.simplified().isEmpty())
            u.name = u.id == localId() ? QStringLiteral("Local owner") : QStringLiteral("User");
        const bool legacy = version == 1;
        if ((legacy &&
             (u.issuer.isEmpty() || u.subject.isEmpty() || u.id != oidcId(u.issuer, u.subject))) ||
            (!legacy && u.id != localId() &&
             !QRegularExpression(QStringLiteral("^(local-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-"
                                                "f]{4}-[0-9a-f]{12}|oidc-[0-9a-f]{64})$"))
                  .match(u.id)
                  .hasMatch()) ||
            u.id.isEmpty() || seen.contains(u.id) || u.issuer.isEmpty() != u.subject.isEmpty())
            throw std::runtime_error("Invalid identity in user store");
        seen[u.id] = true;
        if (!u.issuer.isEmpty() && !findIdentity(u.issuer, u.subject).id.isEmpty())
            throw std::runtime_error("Duplicate OIDC identity in user store");
        u.role = o.value("role").toString(u.id == localId() ? "admin" : "user");
        if (u.role != "admin" && u.role != "user") throw std::runtime_error("Invalid user role");
        u.enabled = o.value("enabled").toBool(true);
        u.deleting = o.value("deleting").toBool(false);
        if (o.contains("discovery_enabled")) {
            if (!o["discovery_enabled"].isBool())
                throw std::runtime_error("Invalid discovery preference");
            u.discoveryEnabled = o["discovery_enabled"].toBool();
        }
        u.managedRole = o.value("managed_role").toBool(false);
        u.managedName = o.value("managed_name").toBool(false);
        u.verifiedConfig = o.value("verified_config").toString();
        // Old local/subject-list administrator assignments are not verified SSO roles.
        if (version >= 3) {
            u.ssoRole = o.value("sso_role").toString("user");
            u.roleRevision = o.value("role_revision").toVariant().toULongLong();
            if (u.ssoRole != "admin" && u.ssoRole != "user")
                throw std::runtime_error("Invalid SSO role");
        }
        if (u.id == localId() && (!u.enabled || u.deleting || u.role != "admin"))
            throw std::runtime_error("Local owner must remain available");
        m_users[u.id] = u;
    }
}

UserAccount UserStore::findIdentity(const QString& issuer, const QString& subject) const
{
    if (issuer.isEmpty() || subject.isEmpty()) return {};
    for (const auto& u : m_users)
        if (u.issuer == issuer && u.subject == subject) return u;
    return {};
}

UserAccount UserStore::upsert(const QString& issuer, const QString& subject, const QString& name)
{
    if (issuer.isEmpty() || subject.isEmpty()) throw std::runtime_error("Missing OIDC identity");
    const auto displayName =
        name.simplified().isEmpty() ? QStringLiteral("User") : name.simplified().left(256);
    auto u = findIdentity(issuer, subject);
    if (u.id.isEmpty())
        u = {oidcId(issuer, subject), issuer, subject, displayName};
    else if (!u.managedName)
        u.name = displayName;
    auto users = m_users;
    users[u.id] = u;
    commit(users);
    return u;
}

UserAccount UserStore::createLocal(const QString& name, const QString& role)
{
    UserAccount u{QStringLiteral("local-") + QUuid::createUuid().toString(QUuid::WithoutBraces),
                  {},
                  {},
                  name.simplified()};
    u.role = role;
    u.managedRole = u.managedName = true;
    auto users = m_users;
    if (u.name.isEmpty() || u.name.size() > 256 || (role != "user" && role != "admin"))
        throw std::runtime_error("Invalid user name or role");
    users[u.id] = u;
    commit(users);
    return u;
}

void UserStore::update(const UserAccount& u)
{
    if (!contains(u.id) || u.name.simplified().isEmpty() || u.name.size() > 256 ||
        (u.role != "user" && u.role != "admin") || (u.ssoRole != "user" && u.ssoRole != "admin") ||
        (u.id == localId() && (!u.enabled || u.deleting || u.role != "admin")))
        throw std::runtime_error("Invalid user update");
    auto users = m_users;
    users[u.id] = u;
    commit(users);
}

void UserStore::bind(const QString& id, const QString& issuer, const QString& subject,
                     const QString& verifiedConfig, const QString& ssoRole)
{
    auto user = get(id);
    const auto existing = findIdentity(issuer, subject);
    if (user.id.isEmpty() || issuer.isEmpty() || subject.isEmpty() ||
        (!existing.id.isEmpty() && existing.id != id))
        throw std::runtime_error("Identity already assigned or account missing");
    user.issuer = issuer;
    user.subject = subject;
    user.verifiedConfig = verifiedConfig;
    user.ssoRole = ssoRole;
    ++user.roleRevision;
    update(user);
}

void UserStore::remove(const QString& id)
{
    if (id == localId()) throw std::runtime_error("Cannot delete the local owner");
    auto users = m_users;
    users.remove(id);
    commit(users);
}

void UserStore::commit(const QMap<QString, UserAccount>& users)
{
    if (!m_path.isEmpty()) {
        QDir().mkpath(QFileInfo(m_path).absolutePath());
        QJsonArray entries;
        for (const auto& u : users) {
            auto o = u.adminJson();
            if (u.discoveryEnabled.has_value()) o["discovery_enabled"] = *u.discoveryEnabled;
            o["managed_role"] = u.managedRole;
            o["managed_name"] = u.managedName;
            o["verified_config"] = u.verifiedConfig;
            o["role_revision"] = static_cast<qint64>(u.roleRevision);
            entries.append(o);
        }
        QSaveFile file(m_path);
        if (!file.open(QIODevice::WriteOnly)) throw std::runtime_error("Cannot write user store");
        file.setPermissions(QFile::ReadOwner | QFile::WriteOwner);
        const auto bytes = QJsonDocument(QJsonObject{{"version", 4}, {"users", entries}}).toJson();
        if (file.write(bytes) != bytes.size() || !file.commit())
            throw std::runtime_error("Cannot commit user store");
    }
    m_users = users;
}
