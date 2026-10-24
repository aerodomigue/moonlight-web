#include "test_framework.h"
#include "backend/NvHTTP.h"
#include <QNetworkAccessManager>
#include <QUrlQuery>

void run_stream_parameters_tests()
{
    SECTION("GameStream launch and resume carry the selected display mode");
    QNetworkAccessManager network;
    NvHTTP http(&network);
    const NvAddress address(QStringLiteral("127.0.0.1"));
    const QByteArray testKey(16, '\0');
    auto check = [](QNetworkReply* reply) {
        const QUrlQuery query(reply->request().url());
        CHECK_EQ(query.queryItemValue("mode"), QStringLiteral("3840x2160x240"));
        CHECK_EQ(query.queryItemValue("uniqueid"), QStringLiteral("test-client"));
        CHECK_EQ(query.queryItemValue("localAudioPlayMode"), QStringLiteral("0"));
        reply->abort();
        delete reply;
    };
    check(http.launchAppAsync(address, 1, 42, "test-client", testKey, 1, 3840, 2160, 240, 100000,
                              {}, {}));
    check(http.resumeAppAsync(address, 1, "test-client", testKey, 1, 3840, 2160, 240, {}, {}));
}
