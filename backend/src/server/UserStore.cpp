#include "UserStore.h"

#include <QCryptographicHash>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QSaveFile>
#include <stdexcept>

QJsonObject UserAccount::json() const
{
    return {{"id", id}, {"name", name}};
}

QString UserStore::oidcId(const QString& issuer, const QString& subject)
{
    // Length framing prevents ambiguous issuer/subject concatenations.
    const QByteArray input =
        QByteArray::number(issuer.toUtf8().size()) + ':' + issuer.toUtf8() + subject.toUtf8();
    return QStringLiteral("oidc-") +
           QString::fromLatin1(QCryptographicHash::hash(input, QCryptographicHash::Sha256).toHex());
}

UserStore::UserStore(QString path)
    : m_path(std::move(path))
{
    m_users.insert(localId(), {localId(), {}, {}, QStringLiteral("Local owner")});
    if (m_path.isEmpty() || !QFile::exists(m_path)) return;
    QFile file(m_path);
    if (!file.open(QIODevice::ReadOnly)) throw std::runtime_error("Cannot read user store");
    QJsonParseError error;
    const auto doc = QJsonDocument::fromJson(file.readAll(), &error);
    if (error.error != QJsonParseError::NoError || !doc.isObject() || !doc["users"].isArray())
        throw std::runtime_error("Invalid user store; refusing to discard accounts");
    for (const auto& value : doc["users"].toArray()) {
        const auto o = value.toObject();
        UserAccount u{o["id"].toString(), o["issuer"].toString(), o["subject"].toString(),
                      o["name"].toString()};
        if (u.issuer.isEmpty() || u.subject.isEmpty() || u.id != oidcId(u.issuer, u.subject))
            throw std::runtime_error("Invalid identity in user store");
        m_users.insert(u.id, u);
    }
}

UserAccount UserStore::upsert(const QString& issuer, const QString& subject, const QString& name)
{
    if (issuer.isEmpty() || subject.isEmpty()) throw std::runtime_error("Missing OIDC identity");
    UserAccount user{oidcId(issuer, subject), issuer, subject, name.left(256)};
    const auto previous = m_users.value(user.id);
    if (previous.id.isEmpty() || previous.name != user.name) {
        m_users.insert(user.id, user);
        try {
            save();
        } catch (...) {
            if (previous.id.isEmpty())
                m_users.remove(user.id);
            else
                m_users.insert(user.id, previous);
            throw;
        }
    }
    return user;
}

void UserStore::save() const
{
    if (m_path.isEmpty()) return;
    QDir().mkpath(QFileInfo(m_path).absolutePath());
    QJsonArray users;
    for (const auto& user : m_users) {
        if (user.id == localId()) continue;
        auto o = user.json();
        o["issuer"] = user.issuer;
        o["subject"] = user.subject;
        users.append(o);
    }
    QSaveFile file(m_path);
    if (!file.open(QIODevice::WriteOnly)) throw std::runtime_error("Cannot write user store");
    file.setPermissions(QFile::ReadOwner | QFile::WriteOwner);
    const QByteArray bytes = QJsonDocument(QJsonObject{{"users", users}}).toJson();
    if (file.write(bytes) != bytes.size() || !file.commit())
        throw std::runtime_error("Cannot commit user store");
}
