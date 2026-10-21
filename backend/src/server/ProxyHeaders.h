#pragma once

#include "common/Types.h"
#include "common/Edition.h"
#include <QHostAddress>
#include <QUrl>

// Forwarded headers are authoritative only for explicitly trusted socket peers.
// A proxy must overwrite X-Forwarded-Proto and append the actual peer to XFF.
namespace ProxyHeaders {
inline bool trusted(const QHostAddress& address)
{
    bool ipv4 = false;
    const quint32 v4 = address.toIPv4Address(&ipv4);
    const QHostAddress normalized = ipv4 ? QHostAddress(v4) : address;
    const QByteArray configured = qgetenv("MW_TRUSTED_PROXIES");
    const QString peers = configured.isEmpty() ? QStringLiteral("127.0.0.1/32,::1/128")
                                               : QString::fromUtf8(configured);
    for (const QString& peer : peers.split(',', Qt::SkipEmptyParts)) {
        const auto subnet = QHostAddress::parseSubnet(peer.trimmed());
        if (subnet.second >= 0 && normalized.isInSubnet(subnet)) return true;
    }
    return false;
}

// Returns true only when a trusted proxy confirms that TLS terminated upstream.
inline bool apply(HttpRequest& request)
{
    if (!trusted(QHostAddress(request.clientAddress))) return false;
    const QString chain = request.headers.value(QStringLiteral("x-forwarded-for"));
    const QString proto = request.headers.value(QStringLiteral("x-forwarded-proto"));
    const QString publicHost = QUrl(mw::edition::publicUrl()).host();
    const QString host = QUrl(QStringLiteral("https://") + request.headers.value("host")).host();
    if (chain.isEmpty() && proto.isEmpty() &&
        (publicHost.isEmpty() || host.compare(publicHost, Qt::CaseInsensitive) != 0))
        return false;

    request.viaProxy = true;
    // Missing/malformed forwarding information must never inherit a proxy's LAN
    // address or local privileges. No X-Real-IP fallback with different semantics.
    request.clientAddress = QStringLiteral("0.0.0.0");
    const QStringList addresses = chain.split(',', Qt::SkipEmptyParts);
    for (auto it = addresses.crbegin(); it != addresses.crend(); ++it) {
        const QHostAddress address(it->trimmed());
        if (address.isNull()) {
            request.clientAddress = QStringLiteral("0.0.0.0");
            break;
        }
        request.clientAddress = address.toString();
        if (!trusted(address)) break;
    }
    return proto.trimmed().compare(QStringLiteral("https"), Qt::CaseInsensitive) == 0;
}
} // namespace ProxyHeaders
