#include "ApolloClipboard.h"
#include <QXmlStreamReader>
#include <QJsonDocument>
#include <QNetworkReply>
#include <QSslCertificate>
#include <QSslConfiguration>
#include <QSslKey>
#include <QUuid>
#include <QUrlQuery>
#include <QStringDecoder>

ApolloClipboard::ApolloClipboard(Config config, QObject* parent)
    : QObject(parent)
    , m_Config(std::move(config))
{}

void ApolloClipboard::start()
{
    QMetaObject::invokeMethod(
        this,
        [this] {
            if (m_Stopped || m_Started) return;
            m_Started = true;
            discover();
        },
        Qt::QueuedConnection);
}

void ApolloClipboard::stop()
{
    m_Stopped.store(true);
    QMetaObject::invokeMethod(
        this,
        [this] {
            m_Assembly.clear();
            m_LastText.clear();
            m_Config.key.clear();
            if (m_Reply) m_Reply->abort();
        },
        Qt::QueuedConnection);
}

void ApolloClipboard::receive(const QJsonObject& msg)
{
    // Bound queued memory even before parsing/assembling on the relay thread.
    if (m_Stopped || QJsonDocument(msg).toJson(QJsonDocument::Compact).size() > 8192) return;
    QMetaObject::invokeMethod(
        this,
        [this, msg] {
            if (!m_Stopped) handle(msg);
        },
        Qt::QueuedConnection);
}

void ApolloClipboard::caps()
{
    if (!m_Stopped)
        emit message({{"type", "clipboardcaps"},
                      {"remote", true},
                      {"available", m_Read || m_Write},
                      {"read", m_Read},
                      {"write", m_Write},
                      {"maxBytes", MaxBytes}});
}

void ApolloClipboard::error(const QString& code)
{
    if (!m_Stopped) emit message({{"type", "clipboarderror"}, {"code", code}});
}

void ApolloClipboard::request(const QString& path, const QByteArray* body,
                              std::function<void(int, const QByteArray&)> done)
{
    if (m_Stopped || m_Reply) return;
    if (!m_Network) m_Network = new QNetworkAccessManager(this);
    QUrl url = m_Config.origin;
    url.setPath(path);
    QUrlQuery query;
    query.addQueryItem("uniqueid", m_Config.uniqueId);
    if (path != "/serverinfo") query.addQueryItem("type", "text");
    url.setQuery(query);
    QNetworkRequest req(url);
    req.setTransferTimeout(3000);
    req.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                     QNetworkRequest::ManualRedirectPolicy);
    // Same close/loopback protections as NvHTTP: never retain a pooled Apollo
    // connection or inherit local administration on a user-selected host.
    req.setRawHeader("X-MW-Internal-Fetch", "1");
    req.setAttribute(QNetworkRequest::ConnectionCacheExpiryTimeoutSecondsAttribute, 0);
    req.setRawHeader("Connection", "close");
    req.setHeader(QNetworkRequest::ContentTypeHeader, "text/plain; charset=utf-8");
    auto ssl = req.sslConfiguration();
    ssl.setLocalCertificate(QSslCertificate(m_Config.certificate));
    ssl.setPrivateKey(QSslKey(m_Config.key, QSsl::Rsa));
    // The self-signed Apollo leaf is pinned to the existing pairing.
    ssl.setPeerVerifyMode(QSslSocket::VerifyPeer);
    req.setSslConfiguration(ssl);
    auto* reply = body ? m_Network->post(req, *body) : m_Network->get(req);
    m_Reply = reply;
    const auto expected = QSslCertificate(m_Config.serverCertificate);
    connect(reply, &QNetworkReply::sslErrors, this, [reply, expected](const QList<QSslError>&) {
        if (!expected.isNull() && reply->sslConfiguration().peerCertificate() == expected)
            reply->ignoreSslErrors();
    });
    connect(reply, &QNetworkReply::encrypted, this, [reply, expected] {
        if (expected.isNull() || reply->sslConfiguration().peerCertificate() != expected)
            reply->abort();
    });
    // Never buffer an unbounded response from a paired machine.
    connect(reply, &QNetworkReply::readyRead, this, [reply] {
        if (reply->bytesAvailable() > MaxBytes) {
            reply->setProperty("clipboardOversized", true);
            reply->abort();
        }
    });
    connect(reply, &QNetworkReply::finished, this, [this, reply, done = std::move(done)] {
        if (m_Reply == reply) m_Reply = nullptr;
        const int status =
            reply->error() == QNetworkReply::NoError
                ? reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt()
                : (reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt() >= 400
                       ? reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt()
                       : 0);
        const bool oversized = reply->property("clipboardOversized").toBool();
        const QByteArray bytes = reply->read(MaxBytes + 1);
        reply->deleteLater();
        if (!m_Stopped) done(oversized || bytes.size() > MaxBytes ? 413 : status, bytes);
    });
}

void ApolloClipboard::discover()
{
    request("/serverinfo", nullptr, [this](int status, const QByteArray& bytes) {
        bool ok = false;
        quint32 permissions = 0;
        QXmlStreamReader xml(bytes);
        while (!xml.atEnd()) {
            xml.readNext();
            if (xml.isStartElement() && xml.name() == QLatin1String("Permission"))
                permissions = xml.readElementText().toUInt(&ok);
        }
        ok = ok && !xml.hasError();
        m_Keyboard = permissions & (1u << 12);
        const bool view = permissions & ((1u << 25) | (1u << 26));
        m_Read = status == 200 && ok && view && (permissions & (1u << 17));
        // A paste requires keyboard input too, not just the clipboard operation.
        m_Write =
            status == 200 && ok && view && (permissions & (1u << 16)) && (permissions & (1u << 12));
        caps();
    });
}

void ApolloClipboard::sendText(const QByteArray& bytes)
{
    const QString id = QUuid::createUuid().toString(QUuid::WithoutBraces);
    const int total = qMax(1, (bytes.size() + ChunkBytes - 1) / ChunkBytes);
    for (int i = 0; i < total && !m_Stopped; ++i)
        emit message(
            {{"type", "clipboardchunk"},
             {"id", id},
             {"index", i},
             {"total", total},
             {"data", QString::fromLatin1(bytes.mid(i * ChunkBytes, ChunkBytes).toBase64())}});
}

void ApolloClipboard::handle(const QJsonObject& msg)
{
    const QString type = msg["type"].toString();
    if (type == "clipboardread") {
        if (!m_Read || m_Reply || (m_LastRead.isValid() && m_LastRead.elapsed() < 1000)) return;
        m_LastRead.restart();
        request("/actions/clipboard", nullptr, [this](int status, const QByteArray& bytes) {
            if (status == 200) {
                QStringDecoder decoder(QStringDecoder::Utf8);
                decoder(bytes);
                if (decoder.hasError()) {
                    m_Read = false;
                    caps();
                    error("invalid_text");
                    return;
                }
                if (!m_HaveText || bytes != m_LastText) {
                    m_HaveText = true;
                    m_LastText = bytes;
                    sendText(bytes);
                }
            } else if (status == 413) {
                m_Read = false;
                caps();
                error("too_large");
            } else if (status == 401 || status == 403 || status == 404) {
                m_Read = false;
                caps();
            }
            // Transient read failures retry only on the next foreground poll.
        });
        return;
    }
    if (type == "clipboardcopy") {
        if (m_Read && m_Keyboard) emit chord(msg["cut"].toBool() ? 0x58 : 0x43);
        return;
    }
    if (type != "clipboardchunk" || !m_Write) return;
    const int index = msg["index"].toInt(-1), total = msg["total"].toInt(-1);
    const QString id = msg["id"].toString();
    const auto decoded = QByteArray::fromBase64Encoding(msg["data"].toString().toLatin1(),
                                                        QByteArray::AbortOnBase64DecodingErrors);
    if (!decoded || decoded.decoded.size() > ChunkBytes || id.isEmpty() || id.size() > 64 ||
        total < 1 || total > MaxBytes / ChunkBytes || index < 0 || index >= total) {
        m_Assembly.clear();
        m_AssemblyId.clear();
        error("invalid_text");
        return;
    }
    if (index == 0) {
        if (m_Post) {
            error("busy");
            return;
        }
        if (m_Completed.contains(id)) {
            error("invalid_text");
            return;
        }
        m_Assembly.clear();
        m_AssemblyId = id;
        m_TotalChunks = total;
        m_NextChunk = 0;
        m_AssemblyAge.restart();
    }
    if (id != m_AssemblyId || index != m_NextChunk || total != m_TotalChunks ||
        !m_AssemblyAge.isValid() || m_AssemblyAge.elapsed() > 10000) {
        m_Assembly.clear();
        m_AssemblyId.clear();
        error("invalid_text");
        return;
    }
    m_Assembly += decoded.decoded;
    if (++m_NextChunk != total) return;
    m_Completed.append(id);
    if (m_Completed.size() > 128) m_Completed.removeFirst();
    QByteArray text = std::move(m_Assembly);
    m_Assembly.clear();
    m_AssemblyId.clear();
    QStringDecoder decoder(QStringDecoder::Utf8);
    decoder(text);
    if (decoder.hasError()) {
        error("invalid_text");
        return;
    }
    // Give paste priority over a background read. Disconnect its completion so
    // a cancelled stale read cannot overwrite the just-pasted local text.
    if (m_Reply) {
        disconnect(m_Reply, nullptr, this, nullptr);
        m_Reply->abort();
        m_Reply->deleteLater();
        m_Reply = nullptr;
    }
    m_Post = true;
    request("/actions/clipboard", &text, [this, text](int status, const QByteArray&) {
        m_Post = false;
        if (status == 200 || status == 204) {
            m_LastText = text;
            m_HaveText = true;
            emit chord(0x56);
        } else {
            if (status == 401 || status == 403 || status == 404) {
                m_Write = false;
                caps();
            }
            error("write_failed");
        }
    });
}
