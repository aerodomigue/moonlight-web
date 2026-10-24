#pragma once

#include "common/Types.h"
#include "common/PairingCrypto.h"
#include <QCryptographicHash>
#include <QRegularExpression>
#include <optional>

// Strict RFC 9421 application profile. No caller-selected algorithms/components/keys.
namespace HttpSignature {
inline QString digest(const QByteArray& body)
{
    return "sha-256=:" +
           QString::fromLatin1(
               QCryptographicHash::hash(body, QCryptographicHash::Sha256).toBase64()) +
           ":";
}
inline QString parameters(qint64 created, qint64 expires, const QString& nonce,
                          const QString& keyId)
{
    return QStringLiteral(
               "(\"@method\" \"@path\" \"@query\" \"content-digest\" \"x-mw-session-id\" "
               "\"x-mw-page-id\");created=%1;expires=%2;nonce=\"%3\";keyid=\"%4\";alg=\"ecdsa-p256-"
               "sha256\";tag=\"moonlight-session\"")
        .arg(created)
        .arg(expires)
        .arg(nonce, keyId);
}
inline QByteArray base(const HttpRequest& req, const QString& params)
{
    const auto target = req.rawTarget.isEmpty() ? req.path.toUtf8() : req.rawTarget;
    const auto query = target.indexOf('?');
    const auto path = query < 0 ? target : target.left(query);
    const auto search = query < 0 ? QByteArray("?") : target.mid(query);
    return "\"@method\": " + req.method.toUtf8() + "\n\"@path\": " + path +
           "\n\"@query\": " + search +
           "\n\"content-digest\": " + req.headers.value("content-digest").toUtf8() +
           "\n\"x-mw-session-id\": " + req.headers.value("x-mw-session-id").toUtf8() +
           "\n\"x-mw-page-id\": " + req.headers.value("x-mw-page-id").toUtf8() +
           "\n\"@signature-params\": " + params.toUtf8();
}
struct Proof
{
    QString nonce;
    qint64 expires;
};
inline std::optional<Proof> verify(const HttpRequest& req, const QByteArray& key,
                                   const QString& sessionId, qint64 now)
{
    const auto input = req.headers.value("signature-input");
    if (input.size() > 1024 || req.headers.value("x-mw-session-id") != sessionId ||
        req.headers.value("content-digest") != digest(req.body))
        return std::nullopt;
    static const QRegularExpression grammar(QStringLiteral(
        "^mw=(\\(\"@method\" \"@path\" \"@query\" \"content-digest\" \"x-mw-session-id\" "
        "\"x-mw-page-id\"\\);created=([0-9]{1,12});expires=([0-9]{1,12});nonce=\"([A-Za-z0-9_-]{22,"
        "86})\";keyid=\"([A-Za-z0-9_-]{43})\";alg=\"ecdsa-p256-sha256\";tag=\"moonlight-session\")"
        "$"));
    const auto match = grammar.match(input);
    if (!match.hasMatch()) return std::nullopt;
    const auto created = match.captured(2).toLongLong(), expires = match.captured(3).toLongLong();
    if (created > now + 30 || expires <= now || expires <= created || expires - created > 60 ||
        created < now - 90 || match.captured(5) != PairingCrypto::keyId(key))
        return std::nullopt;
    static const QRegularExpression signatureGrammar(
        QStringLiteral("^mw=:([A-Za-z0-9+/]{86}==):$"));
    const auto sig = signatureGrammar.match(req.headers.value("signature"));
    if (!sig.hasMatch() ||
        !PairingCrypto::verify(key, base(req, match.captured(1)),
                               QByteArray::fromBase64(sig.captured(1).toLatin1())))
        return std::nullopt;
    return Proof{match.captured(4), expires};
}
} // namespace HttpSignature
