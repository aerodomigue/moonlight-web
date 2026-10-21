// LAN-only Wake-on-LAN helpers. GPL-3.0-or-later.
#pragma once

#include <QByteArray>
#include <QHostAddress>
#include <QNetworkInterface>
#include <QStringList>
#include <QVector>

namespace WakeOnLan {
struct Target
{
    QHostAddress source;
    QHostAddress broadcast;
};
bool isLocalIpv4(const QString& ip);
bool isValidMac(const QByteArray& mac);
QByteArray parseMac(const QString& text);
QByteArray magicPacket(const QByteArray& mac);
QList<QNetworkAddressEntry> lanEntries();
QVector<Target> targets(const QStringList& addresses, const QList<QNetworkAddressEntry>& entries);
QByteArray macFromArpTable(const QString& table, const QString& ip);
QByteArray resolveMac(const QString& ip);
} // namespace WakeOnLan
