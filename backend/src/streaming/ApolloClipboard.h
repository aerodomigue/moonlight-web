#pragma once

#include <QByteArray>
#include <QElapsedTimer>
#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QPointer>
#include <QTimer>
#include <QUrl>
#include <atomic>
#include <functional>

// One authenticated stream, one clipboard. Construct before the relay's move;
// network objects are created lazily on its thread. No process-wide clipboard.
class ApolloClipboard : public QObject
{
    Q_OBJECT
public:
    struct Config
    {
        QUrl origin;
        QByteArray certificate, key, serverCertificate;
        QString uniqueId;
        bool appleHost = false;
    };
    static constexpr int MaxBytes = 256 * 1024;
    static constexpr int ChunkBytes = 4096;
    explicit ApolloClipboard(Config config, QObject* parent);
    void start();
    void receive(const QJsonObject& message);
    void stop(); // terminal, thread-safe: no queued completion may inject input
signals:
    void message(const QJsonObject& message);
    void chord(int key); // emitted only after the remote clipboard write succeeds
private:
    void discover();
    void handle(const QJsonObject& message);
    void request(const QString& path, const QByteArray* body,
                 std::function<void(int, const QByteArray&)> done);
    void caps();
    void error(const QString& code);
    void sendText(const QByteArray& text);
    Config m_Config;
    std::atomic_bool m_Stopped{false};
    bool m_Keyboard = false;
    QStringList m_Completed;
    bool m_Started = false, m_Read = false, m_Write = false, m_Post = false;
    QNetworkAccessManager* m_Network = nullptr;
    QPointer<QNetworkReply> m_Reply;
    QElapsedTimer m_LastRead, m_AssemblyAge;
    QByteArray m_LastText, m_Assembly;
    QString m_AssemblyId;
    int m_NextChunk = 0, m_TotalChunks = 0;
    bool m_HaveText = false;
};
