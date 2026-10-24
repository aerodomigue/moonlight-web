#pragma once

#include "UserStore.h"
#include <QCryptographicHash>
#include <QHash>
#include <memory>

namespace UserAccess {
// Keep a host reserved through asynchronous completion. A /cancel must not
// race a different account's /launch after the old worker has been detached.
class HostLeases
{
    struct Entry
    {
        QString owner;
        int references = 0;
    };
    using State = QHash<QString, Entry>;
    std::shared_ptr<State> m_state = std::make_shared<State>();

public:
    bool busy(const QString& host) const { return m_state->contains(host); }
    std::shared_ptr<void> acquire(const QString& host, const QString& user) const
    {
        if (host.isEmpty() || user.isEmpty()) return {};
        auto& entry = (*m_state)[host];
        if (entry.references && entry.owner != user) return {};
        entry.owner = user;
        ++entry.references;
        return std::shared_ptr<void>(new int(0), [state = m_state, host](void* value) {
            delete static_cast<int*>(value);
            auto it = state->find(host);
            if (it != state->end() && --it->references == 0) state->erase(it);
        });
    }
};

inline QString hostId(const QString& user, const QString& physicalUuid)
{
    // Preserve old URLs, certificates and appairages for the local owner.
    if (user == UserStore::localId()) return physicalUuid;
    return QStringLiteral("host-") +
           QString::fromLatin1(
               QCryptographicHash::hash(user.toUtf8() + '\0' + physicalUuid.toUtf8(),
                                        QCryptographicHash::Sha256)
                   .toHex());
}
inline bool owns(const QString& user, const QString& owner)
{
    return !user.isEmpty() && user == owner;
}
inline QString deviceId(const QString& user, const QString& browserId)
{
    if (user == UserStore::localId() || browserId.isEmpty()) return browserId;
    return QString::fromLatin1(QCryptographicHash::hash(user.toUtf8() + '\0' + browserId.toUtf8(),
                                                        QCryptographicHash::Sha256)
                                   .toHex()
                                   .left(16))
        .toUpper();
}
} // namespace UserAccess
