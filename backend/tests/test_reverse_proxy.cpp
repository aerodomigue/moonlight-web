#include "test_framework.h"
#include "common/Edition.h"
#include "network/RendezvousClient.h"
#include "network/SessionMetrics.h"
#include "server/AppSettings.h"
#include "server/AuthManager.h"
#include "server/ProxyHeaders.h"
#include "server/StreamClientPolicy.h"
#include "streaming/TransportPriorities.h"

#include <QCoreApplication>
#include <QElapsedTimer>
#include <QTemporaryDir>
#include <QTcpServer>
#include <QThread>

void run_reverse_proxy_tests()
{
    SECTION("Trusted proxy client classification remains valid for ICE");
    qputenv("MW_TRUSTED_PROXIES", "10.2.10.103/32");
    for (const auto& peer : {QString("10.2.100.122"), QString("203.0.113.20")}) {
        HttpRequest request;
        request.clientAddress = "10.2.10.103";
        request.headers["x-forwarded-for"] = peer;
        request.headers["x-forwarded-proto"] = "https";
        CHECK(ProxyHeaders::apply(request));
        CHECK(request.viaProxy);
        CHECK(StreamClientPolicy::classify(request) == NetClassify::classify(peer));
    }
    HttpRequest spoofed;
    spoofed.clientAddress = "10.2.100.122";
    spoofed.hostTrusted = true;
    spoofed.headers["x-forwarded-for"] = "127.0.0.1";
    CHECK(!ProxyHeaders::apply(spoofed));
    CHECK(StreamClientPolicy::classify(spoofed) == NetClassify::Kind::Public);
    spoofed.headers.clear();
    CHECK(StreamClientPolicy::classify(spoofed) == NetClassify::Kind::Private);
    qunsetenv("MW_TRUSTED_PROXIES");

    SECTION("Self-hosted reverse proxy defaults");
    qunsetenv("MW_REVERSE_PROXY");
    qunsetenv("MW_LAN_ONLY");
    CHECK(mw::edition::reverseProxy());
    qputenv("MW_REVERSE_PROXY", "typo");
    CHECK(mw::edition::reverseProxy());
    qunsetenv("MW_REVERSE_PROXY");
    CHECK(!mw::edition::lanOnly());
    CHECK(mw::edition::externalServicesDisabled());
    CHECK(TransportPriorities::orderedTransports().contains(QStringLiteral("webrtc-dc-udp")));
    CHECK(TransportPriorities::orderedTransports(true).contains(QStringLiteral("wss")));

    QTemporaryDir tmp;
    CHECK(tmp.isValid());
    AppSettings settings;
    settings.m_FilePath = tmp.path() + "/settings.json";
    // A migrated settings file and old project credentials cannot opt us back in.
    settings.setInternetAccessEnabled(true);
    settings.setUpnpEnabled(true);
    settings.setAutoIpDetection(true);
    settings.setMetricsReporting(true);
    settings.setSessionLocationEnabled(true);
    settings.setTransportMode(QStringLiteral("webrtc-dc-udp"));
    CHECK(settings.internetAccessEnabled());
    settings.setInternetAccessEnabled(false);
    CHECK(!settings.internetAccessEnabled());
    settings.setInternetAccessEnabled(true);
    CHECK(settings.upnpEnabled());
    settings.setUpnpEnabled(false);
    CHECK(!settings.upnpEnabled());
    settings.setUpnpEnabled(true);
    CHECK(settings.upnpEnabled());
    qputenv("MW_LAN_ONLY", "1");
    CHECK(!settings.upnpEnabled());
    qputenv("MW_LAN_ONLY", "0");
    CHECK(settings.autoIpDetection());
    CHECK(!settings.sessionMetricsAllowed());
    CHECK(!settings.updateRelayAllowed());
    CHECK(!settings.sessionLocationEnabled());
    CHECK_EQ(settings.stunServer(), QStringLiteral("stun:stun.cloudflare.com:3478"));
    CHECK_EQ(settings.transportMode(), QStringLiteral("webrtc-dc-udp"));
    settings.setStunServer(QStringLiteral("stun:ice.example.test:3478"));
    CHECK_EQ(settings.stunServer(), QStringLiteral("stun:ice.example.test:3478"));
    settings.setStunServer(QStringLiteral("stun:stream.moonlightweb.top:3478"));
    CHECK_EQ(settings.stunServer(), QStringLiteral("stun:stun.cloudflare.com:3478"));

    qputenv("MW_DOMAIN", "example.invalid");
    qputenv("MW_PDNS_TOKEN", "test-token");
    SessionMetrics metrics(QStringLiteral("0.3.0"), true);
    CHECK(!metrics.active());
    metrics.setEnabled(true);
    CHECK(!metrics.active());
    qunsetenv("MW_DOMAIN");
    qunsetenv("MW_PDNS_TOKEN");

    // Even an explicit rendezvous URL must not initiate an outbound connection.
    QTcpServer listener;
    CHECK(listener.listen(QHostAddress::LocalHost, 0));
    qputenv("MW_RENDEZVOUS_URL",
            QStringLiteral("http://127.0.0.1:%1").arg(listener.serverPort()).toUtf8());
    RendezvousClient rendezvous(&settings);
    rendezvous.start();
    QElapsedTimer timer;
    timer.start();
    while (timer.elapsed() < 100) {
        QCoreApplication::processEvents();
        QThread::msleep(1);
    }
    CHECK(!listener.hasPendingConnections());
    CHECK(rendezvous.entryUrl().isEmpty());
    qunsetenv("MW_RENDEZVOUS_URL");

    for (const QByteArray& invalid :
         {QByteArray("http://example.test"), QByteArray("https://user:pass@example.test"),
          QByteArray("https://example.test/path"), QByteArray("https://example.test?query=x"),
          QByteArray("https://example.test#token"), QByteArray("garbage")}) {
        qputenv("MW_PUBLIC_URL", invalid);
        CHECK(mw::edition::publicUrl().isEmpty());
    }
    qputenv("MW_PUBLIC_URL", "https://games.example.test:9443/");
    CHECK_EQ(mw::edition::publicUrl(), QStringLiteral("https://games.example.test:9443"));

    SECTION("Trusted proxy headers");
    qunsetenv("MW_TRUSTED_PROXIES");
    CHECK(ProxyHeaders::trusted(QHostAddress::LocalHost));
    CHECK(ProxyHeaders::trusted(QHostAddress::LocalHostIPv6));
    CHECK(ProxyHeaders::trusted(QHostAddress("::ffff:127.0.0.1")));
    CHECK(!ProxyHeaders::trusted(QHostAddress("10.20.0.5")));
    HttpRequest direct;
    direct.clientAddress = QStringLiteral("203.0.113.8");
    direct.headers["x-forwarded-for"] = QStringLiteral("127.0.0.1");
    direct.headers["x-forwarded-proto"] = QStringLiteral("https");
    CHECK(!ProxyHeaders::apply(direct));
    CHECK(!direct.viaProxy);
    CHECK_EQ(direct.clientAddress, QStringLiteral("203.0.113.8"));

    HttpRequest proxy = direct;
    proxy.clientAddress = QStringLiteral("127.0.0.1");
    proxy.headers["x-forwarded-for"] = QStringLiteral("127.0.0.1, 203.0.113.8");
    CHECK(ProxyHeaders::apply(proxy));
    CHECK(proxy.viaProxy);
    CHECK_EQ(proxy.clientAddress, QStringLiteral("203.0.113.8"));
    // A forged left-most address cannot override the first untrusted hop.
    qputenv("MW_TRUSTED_PROXIES", "10.20.0.5/32,127.0.0.1/32,::1/128");
    proxy.clientAddress = QStringLiteral("10.20.0.5");
    proxy.headers["x-forwarded-for"] = QStringLiteral("127.0.0.1, 203.0.113.8, 127.0.0.1");
    CHECK(ProxyHeaders::apply(proxy));
    CHECK_EQ(proxy.clientAddress, QStringLiteral("203.0.113.8"));
    proxy.clientAddress = QStringLiteral("10.20.0.5");
    proxy.headers["x-forwarded-for"] = QStringLiteral("invalid");
    CHECK(ProxyHeaders::apply(proxy));
    CHECK_EQ(proxy.clientAddress, QStringLiteral("0.0.0.0"));
    proxy.clientAddress = QStringLiteral("10.20.0.5");
    proxy.headers.remove("x-forwarded-for");
    CHECK(ProxyHeaders::apply(proxy));
    CHECK(proxy.viaProxy);
    CHECK_EQ(proxy.clientAddress, QStringLiteral("0.0.0.0"));
    proxy.clientAddress = QStringLiteral("10.20.0.5");
    proxy.headers["x-forwarded-proto"] = QStringLiteral("http");
    CHECK(!ProxyHeaders::apply(proxy));

    // Public administration remains an explicit password-based opt-in.
    CHECK(!AuthManager::canUnlockAdmin("203.0.113.8", true, false, false, true));
    CHECK(!AuthManager::canUnlockAdmin("203.0.113.8", true, false, true, false));
    CHECK(!AuthManager::canUnlockAdmin("203.0.113.8", false, false, true, true));
    CHECK(AuthManager::canUnlockAdmin("203.0.113.8", true, false, true, true));
    CHECK(AuthManager::canUnlockAdmin("10.20.0.8", true, false, false, true));
    qunsetenv("MW_TRUSTED_PROXIES");
    qunsetenv("MW_PUBLIC_URL");
    qputenv("MW_REVERSE_PROXY", "0");
    CHECK(!mw::edition::reverseProxy());
    CHECK(!mw::edition::externalServicesDisabled());
}
