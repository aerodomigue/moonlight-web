#pragma once
#include "HttpSignature.h"
#include <QDateTime>
#include <QHash>
#include <functional>

// Runtime authorization is never restored from sessions.json. A disk failure therefore cannot
// resurrect SSO authority after restart. Cookie records only identify a revalidation candidate.
class SsoSessionSecurity
{
public:
    static constexpr qint64 Lifetime = 8 * 3600;
    static QString random()
    {
        return QString::fromLatin1(PairingCrypto::generateNonce().toBase64(
            QByteArray::Base64UrlEncoding | QByteArray::OmitTrailingEquals));
    }
    struct Session
    {
        QByteArray key;
        qint64 expires = 0;
    };
    struct Grant
    {
        QString session, page, path;
        qint64 expires = 0;
    };
    explicit SsoSessionSecurity(std::function<qint64()> clock =
                                    [] { return QDateTime::currentSecsSinceEpoch(); })
        : m_clock(std::move(clock))
    {}
    qint64 now() const { return m_clock(); }
    void start(const QString& id, const QByteArray& key, qint64 created)
    {
        m_sessions[id] = {key, created + Lifetime};
    }
    bool live(const QString& id, qint64 time = 0) const
    {
        if (!time) time = now();
        return m_sessions.contains(id) && m_sessions.value(id).expires > time;
    }
    bool proof(const QString& id, const QByteArray& key, const HttpRequest& req, qint64 time = 0)
    {
        if (!time) time = now();
        auto& nonces = m_nonces[id];
        for (auto it = nonces.begin(); it != nonces.end();)
            if (it.value() <= time)
                it = nonces.erase(it);
            else
                ++it;
        const auto p = HttpSignature::verify(req, key, id, time);
        if (!p || nonces.contains(p->nonce) || nonces.size() >= 4096) return false;
        nonces[p->nonce] = p->expires + 30;
        return true;
    }
    QString activation(const QString& id, const QString& page)
    {
        purge();
        if (!live(id) || !pageName(page) || m_activations.size() >= 1024) return {};
        const auto ticket = random();
        m_activations[ticket] = {id, page, {}, now() + 30};
        return ticket;
    }
    bool activate(const QString& id, const QString& ticket, const HttpRequest& req)
    {
        purge();
        const auto grant = m_activations.value(ticket);
        if (m_pages.size() >= 4096 && !m_pages.contains(id + ":" + grant.page)) return false;
        int pages = 0;
        for (const auto& p : m_pages)
            if (p.session == id) ++pages;
        if (pages >= 64 && !m_pages.contains(id + ":" + grant.page)) return false;
        if (!live(id) || grant.session != id || grant.page != req.headers.value("x-mw-page-id") ||
            !proof(id, m_sessions.value(id).key, req))
            return false;
        m_activations.remove(ticket);
        m_pages[id + ":" + grant.page] = {id, grant.page, {}, m_sessions.value(id).expires};
        return true;
    }
    bool authorize(const QString& id, const HttpRequest& req)
    {
        purge();
        const auto page = m_pages.value(id + ":" + req.headers.value("x-mw-page-id"));
        return live(id) && page.session == id && proof(id, m_sessions.value(id).key, req);
    }
    QString wsTicket(const QString& id, const QString& page, const QString& path)
    {
        purge();
        if (!live(id) || m_pages.value(id + ":" + page).session != id || m_ws.size() >= 1024 ||
            !QRegularExpression(QStringLiteral("^/ws(?:[0-9]+)?(?:/stream)?$|^/ws/control$"))
                 .match(path)
                 .hasMatch())
            return {};
        const auto ticket = random();
        m_ws[ticket] = {id, page, path, now() + 10};
        return ticket;
    }
    bool websocket(const QString& id, const HttpRequest& req)
    {
        purge();
        const auto protocols = req.headers.value("sec-websocket-protocol").split(',');
        QString ticket;
        for (auto p : protocols) {
            p = p.trimmed();
            if (!p.startsWith("mw-auth.")) continue;
            if (!ticket.isEmpty()) return false;
            ticket = p.mid(8);
        }
        const auto grant = m_ws.value(ticket);
        if (!live(id) || grant.session != id || grant.path != req.path ||
            m_pages.value(id + ":" + grant.page).session != id)
            return false;
        m_ws.remove(ticket);
        return true;
    }
    void erase(const QString& id)
    {
        m_sessions.remove(id);
        m_nonces.remove(id);
        for (auto* table : {&m_pages, &m_ws, &m_activations})
            for (auto it = table->begin(); it != table->end();)
                if (it->session == id)
                    it = table->erase(it);
                else
                    ++it;
    }
    static bool pageName(const QString& page)
    {
        return QRegularExpression(QStringLiteral("^[A-Za-z0-9_-]{43}$")).match(page).hasMatch();
    }

private:
    void purge()
    {
        const auto time = now();
        for (auto* table : {&m_pages, &m_ws, &m_activations})
            for (auto it = table->begin(); it != table->end();)
                if (it->expires <= time)
                    it = table->erase(it);
                else
                    ++it;
    }
    std::function<qint64()> m_clock;
    QHash<QString, Session> m_sessions;
    QHash<QString, Grant> m_pages, m_ws, m_activations;
    QHash<QString, QHash<QString, qint64>> m_nonces;
};
