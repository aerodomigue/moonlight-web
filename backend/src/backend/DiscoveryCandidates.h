#pragma once

#include <QElapsedTimer>
#include <QMap>
#include <QString>
#include <QUuid>
#include <functional>
#include <optional>

// Observations are not registrations or pairing authority. Nothing here reaches disk.
class DiscoveryCandidates
{
public:
    struct Candidate
    {
        QString id, owner, physical, name, address;
        quint16 port;
        qint64 expires;
    };
    static constexpr qint64 LifetimeMs = 120000;
    explicit DiscoveryCandidates(std::function<qint64()> now = {})
        : m_now(std::move(now))
    {
        m_clock.start();
        if (!m_now) m_now = [this] { return m_clock.elapsed(); };
    }
    void observe(const QString& owner, const QString& physical, const QString& name,
                 const QString& address, quint16 port)
    {
        prune();
        if (owner.isEmpty() || physical.isEmpty()) return;
        for (auto& c : m_candidates)
            if (c.owner == owner && c.physical == physical) {
                c.name = name;
                c.address = address;
                c.port = port;
                c.expires = m_now() + LifetimeMs;
                return;
            }
        int owned = 0;
        for (const auto& c : m_candidates)
            if (c.owner == owner) ++owned;
        if (owned >= 128 || m_candidates.size() >= 1024) return;
        Candidate c{QUuid::createUuid().toString(QUuid::WithoutBraces),
                    owner,
                    physical,
                    name,
                    address,
                    port,
                    m_now() + LifetimeMs};
        m_candidates.insert(c.id, c);
    }
    QList<Candidate> list(const QString& owner)
    {
        prune();
        QList<Candidate> result;
        for (const auto& c : m_candidates)
            if (c.owner == owner) result.append(c);
        return result;
    }
    std::optional<Candidate> find(const QString& owner, const QString& id)
    {
        prune();
        const auto it = m_candidates.constFind(id);
        if (it == m_candidates.cend() || it->owner != owner) return std::nullopt;
        return *it;
    }
    void remove(const QString& owner, const QString& id)
    {
        if (find(owner, id)) m_candidates.remove(id);
    }
    void clear(const QString& owner)
    {
        for (auto it = m_candidates.begin(); it != m_candidates.end();)
            if (it->owner == owner)
                it = m_candidates.erase(it);
            else
                ++it;
    }

private:
    void prune()
    {
        const auto now = m_now();
        for (auto it = m_candidates.begin(); it != m_candidates.end();)
            if (it->expires <= now)
                it = m_candidates.erase(it);
            else
                ++it;
    }
    QElapsedTimer m_clock;
    std::function<qint64()> m_now;
    QMap<QString, Candidate> m_candidates;
};
