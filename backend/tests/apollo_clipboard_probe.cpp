#include "streaming/ApolloClipboard.h"
#include <QCoreApplication>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <cstdio>

static QByteArray readFile(const QString& path)
{
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly)) return {};
    return file.readAll();
}
int main(int argc, char** argv)
{
    QCoreApplication app(argc, argv);
    if (argc != 2) return 2;
    const auto scenario =
        QJsonDocument::fromJson(readFile(QString::fromLocal8Bit(argv[1]))).object();
    ApolloClipboard::Config config;
    config.origin = QUrl(scenario["origin"].toString());
    config.certificate = readFile(scenario["certificate"].toString());
    config.key = readFile(scenario["key"].toString());
    config.serverCertificate = readFile(scenario["serverCertificate"].toString());
    config.uniqueId = "fixture-stream";
    ApolloClipboard clipboard(config, &app);
    auto output = [](QJsonObject object) {
        auto line = QJsonDocument(object).toJson(QJsonDocument::Compact);
        std::fwrite(line.constData(), 1, line.size(), stdout);
        std::fputc('\n', stdout);
        std::fflush(stdout);
    };
    QObject::connect(&clipboard, &ApolloClipboard::message, &app, output);
    QObject::connect(&clipboard, &ApolloClipboard::chord, &app,
                     [output](int key) { output({{"type", "injected"}, {"key", key}}); });
    for (const auto item : scenario["commands"].toArray()) {
        const auto command = item.toObject();
        QTimer::singleShot(command["at"].toInt(), &app, [&clipboard, command] {
            if (command["stop"].toBool())
                clipboard.stop();
            else
                clipboard.receive(command["message"].toObject());
        });
    }
    clipboard.start();
    QTimer::singleShot(scenario["duration"].toInt(1500), &app, &QCoreApplication::quit);
    return app.exec();
}
