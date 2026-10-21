// LAN-only Wake-on-LAN helpers. GPL-3.0-or-later.
#include "WakeOnLan.h"
#include "server/NetClassify.h"

#include <QFile>
#include <QtEndian>
#include <QRegularExpression>

#ifdef Q_OS_WIN
extern "C" __declspec(dllimport) unsigned long __stdcall
SendARP(unsigned long, unsigned long, void*, unsigned long*);
#endif

namespace WakeOnLan {
bool isLocalIpv4(const QString& ip)
{
    return QHostAddress(ip).protocol() == QAbstractSocket::IPv4Protocol &&
           NetClassify::classify(ip) == NetClassify::Kind::Private;
}

bool isValidMac(const QByteArray& mac)
{
    return mac.size() == 6 && mac != QByteArray(6, '\0') &&
           (static_cast<unsigned char>(mac[0]) & 1) == 0;
}

QByteArray parseMac(const QString& text)
{
    static const QRegularExpression syntax(
        QStringLiteral("^(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$"));
    QString normalized = text.trimmed();
    normalized.replace('-', ':');
    if (!syntax.match(normalized).hasMatch()) return {};
    QByteArray mac = QByteArray::fromHex(normalized.toLatin1());
    return isValidMac(mac) ? mac : QByteArray();
}

QByteArray magicPacket(const QByteArray& mac)
{
    if (!isValidMac(mac)) return {};
    QByteArray packet(6, static_cast<char>(0xFF));
    for (int i = 0; i < 16; ++i) packet.append(mac);
    return packet;
}

QList<QNetworkAddressEntry> lanEntries()
{
    QList<QNetworkAddressEntry> entries;
    for (const auto& iface : QNetworkInterface::allInterfaces()) {
        const auto flags = iface.flags();
        if (!flags.testFlag(QNetworkInterface::IsUp) ||
            !flags.testFlag(QNetworkInterface::IsRunning) ||
            !flags.testFlag(QNetworkInterface::CanBroadcast) ||
            flags.testFlag(QNetworkInterface::IsLoopBack)) continue;
        entries.append(iface.addressEntries());
    }
    return entries;
}

QVector<Target> targets(const QStringList& addresses, const QList<QNetworkAddressEntry>& entries)
{
    QVector<Target> result;
    for (const auto& entry : entries) {
        if (!isLocalIpv4(entry.ip().toString()) || entry.prefixLength() <= 0 ||
            entry.prefixLength() >= 31) continue;
        const quint32 mask = entry.netmask().toIPv4Address();
        const quint32 network = entry.ip().toIPv4Address() & mask;
        const QHostAddress broadcast(network | ~mask);
        if (!isLocalIpv4(broadcast.toString())) continue;
        for (const QString& text : addresses) {
            if (!isLocalIpv4(text)) continue;
            const QHostAddress host(text);
            if (host == entry.ip() || host == broadcast || host.toIPv4Address() == network ||
                !host.isInSubnet(entry.ip(), entry.prefixLength())) continue;
            result.append({entry.ip(), broadcast});
            break;
        }
    }
    return result;
}

QByteArray macFromArpTable(const QString& table, const QString& ip)
{
    if (!isLocalIpv4(ip)) return {};
    static const QRegularExpression whitespace(QStringLiteral("\\s+"));
    for (const auto& line : table.split('\n')) {
        const auto fields = line.simplified().split(whitespace);
        if (fields.size() < 6 || fields[0] != ip) continue;
        bool ok = false;
        const uint flags = fields[2].toUInt(&ok, 16);
        if (ok && (flags & 2)) return parseMac(fields[3]);
    }
    return {};
}

QByteArray resolveMac(const QString& ip)
{
    // Never learn a router's MAC for a public or routed destination.
    if (targets({ip}, lanEntries()).isEmpty()) return {};
#ifdef Q_OS_WIN
    const quint32 host = QHostAddress(ip).toIPv4Address();
    const quint32 dest = qToBigEndian(host);
    unsigned char mac[8] = {};
    unsigned long len = 6;
    if (SendARP(dest, 0, mac, &len) == 0 && len == 6) {
        const QByteArray result(reinterpret_cast<const char*>(mac), 6);
        if (isValidMac(result)) return result;
    }
#elif defined(Q_OS_LINUX)
    QFile arp(QStringLiteral("/proc/net/arp"));
    if (arp.open(QIODevice::ReadOnly))
        return macFromArpTable(QString::fromLatin1(arp.readAll()), ip);
#else
    Q_UNUSED(ip)
#endif
    return {};
}
} // namespace WakeOnLan
