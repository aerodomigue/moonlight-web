// Wake-on-LAN regression tests. GPL-3.0-or-later.
#include "test_framework.h"
#include "backend/WakeOnLan.h"
#include "backend/NvComputer.h"
#include <QSettings>
#include <QTemporaryDir>

void run_wake_on_lan_tests()
{
    SECTION("LAN-only Wake-on-LAN");
    const QByteArray mac = WakeOnLan::parseMac("02:11:22:33:44:55");
    CHECK_EQ(mac.size(), 6);
    CHECK_EQ(WakeOnLan::parseMac("02-11-22-33-44-55"), mac);
    for (const auto* invalid : {"", "00:00:00:00:00:00", "ff:ff:ff:ff:ff:ff",
                               "01:11:22:33:44:55", "02:11:22:33:44:zz", "02:11"})
        CHECK(WakeOnLan::parseMac(invalid).isEmpty());
    const QByteArray packet = WakeOnLan::magicPacket(mac);
    CHECK_EQ(packet.size(), 102);
    CHECK_EQ(packet.left(6), QByteArray(6, char(0xFF)));
    for (int i = 0; i < 16; ++i) CHECK_EQ(packet.mid(6 + 6 * i, 6), mac);
    CHECK(WakeOnLan::magicPacket(QByteArray(6, '\0')).isEmpty());

    QNetworkAddressEntry lan;
    lan.setIp(QHostAddress("10.2.10.124"));
    lan.setPrefixLength(16);
    auto targets = WakeOnLan::targets({"10.2.42.5", "198.51.100.20"}, {lan});
    CHECK_EQ(targets.size(), 1);
    if (!targets.isEmpty()) {
        CHECK_EQ(targets[0].source, QHostAddress("10.2.10.124"));
        CHECK_EQ(targets[0].broadcast, QHostAddress("10.2.255.255"));
    }
    for (const auto* invalid : {"198.51.100.20", "8.8.8.8", "100.64.0.1", "127.0.0.1",
                               "::1", "fd00::2", "host.example", "10.3.0.5", "10.2.0.0",
                               "10.2.255.255", "10.2.10.124"})
        CHECK(WakeOnLan::targets({invalid}, {lan}).isEmpty());
    QNetworkAddressEntry other;
    other.setIp(QHostAddress("192.168.5.2"));
    other.setPrefixLength(23);
    auto multiple = WakeOnLan::targets({"10.2.42.5", "192.168.4.20"}, {lan, other});
    CHECK_EQ(multiple.size(), 2);
    if (multiple.size() == 2)
        CHECK_EQ(multiple[1].broadcast, QHostAddress("192.168.5.255"));
    QNetworkAddressEntry publicInterface;
    publicInterface.setIp(QHostAddress("198.51.100.2"));
    publicInterface.setPrefixLength(24);
    CHECK(WakeOnLan::targets({"198.51.100.20"}, {publicInterface}).isEmpty());
    lan.setPrefixLength(7);
    CHECK(WakeOnLan::targets({"10.2.10.20"}, {lan}).isEmpty());
    lan.setPrefixLength(24);
    targets = WakeOnLan::targets({"10.2.10.20", "10.2.10.30"}, {lan});
    CHECK_EQ(targets.size(), 1);
    if (!targets.isEmpty()) CHECK_EQ(targets[0].broadcast, QHostAddress("10.2.10.255"));
    lan.setPrefixLength(32);
    CHECK(WakeOnLan::targets({"10.2.10.20"}, {lan}).isEmpty());

    const QString arp = "IP address HW type Flags HW address Mask Device\n"
                        "10.2.10.20 0x1 0x2 02:11:22:33:44:55 * eth0\n"
                        "10.2.10.21 0x1 0x0 00:00:00:00:00:00 * eth0\n"
                        "198.51.100.20 0x1 0x2 02:11:22:33:44:55 * eth0\n";
    CHECK_EQ(WakeOnLan::macFromArpTable(arp, "10.2.10.20"), mac);
    CHECK(WakeOnLan::macFromArpTable(arp, "10.2.10.21").isEmpty());
    CHECK(WakeOnLan::macFromArpTable(arp, "10.2.10.22").isEmpty());
    CHECK(WakeOnLan::macFromArpTable(arp, "198.51.100.20").isEmpty());

    NvComputer host("<root><uniqueid>test</uniqueid><hostname>Desk</hostname>"
                    "<LocalIP>10.2.10.20</LocalIP><mac>02:11:22:33:44:55</mac></root>",
                    NvAddress(QStringLiteral("198.51.100.20"), 47989));
    CHECK_EQ(host.macAddress, mac);
    CHECK(host.wakeAddresses().contains("10.2.10.20"));
    QTemporaryDir tmp;
    CHECK(tmp.isValid());
    QSettings settings(tmp.filePath("host.ini"), QSettings::IniFormat);
    host.serialize(settings);
    settings.sync();
    NvComputer restored(settings);
    CHECK_EQ(restored.state, NvComputer::CS_OFFLINE);
    CHECK_EQ(restored.wakeMac(), mac);
    CHECK_EQ(restored.localAddress, host.localAddress);
    NvComputer polled;
    polled.uuid = host.uuid;
    polled.macAddress = QByteArray(6, '\0');
    restored.update(polled);
    CHECK_EQ(restored.wakeMac(), mac);

    host.wakeAddress = "10.2.10.30";
    host.wakeMacOverride = WakeOnLan::parseMac("02:aa:bb:cc:dd:ee");
    host.serialize(settings);
    NvComputer configured(settings);
    CHECK_EQ(configured.wakeAddresses(), QStringList{"10.2.10.30"});
    CHECK_EQ(configured.wakeMac(), host.wakeMacOverride);
    configured.update(host);
    CHECK_EQ(configured.wakeMac(), host.wakeMacOverride);
    const auto json = configured.toJson();
    CHECK(json.value("wakeConfigured").toBool());
    CHECK(!json.contains("wakeAddress"));
    CHECK(!json.contains("wakeMacOverride"));
}
