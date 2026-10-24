#define OPENSSL_SUPPRESS_DEPRECATED
#include "OidcToken.h"
#include <QJsonArray>
#include <QJsonDocument>
#include <QRegularExpression>
#include <openssl/bn.h>
#include <openssl/ec.h>
#include <openssl/ecdsa.h>
#include <openssl/evp.h>
#include <openssl/rsa.h>
#include <memory>
#include <cmath>

namespace {
QByteArray decode(const QByteArray& input)
{
    static const QRegularExpression encoding(QStringLiteral("^[A-Za-z0-9_-]+$"));
    if (!encoding.match(QString::fromLatin1(input)).hasMatch()) return {};
    return QByteArray::fromBase64(input, QByteArray::Base64UrlEncoding |
                                             QByteArray::AbortOnBase64DecodingErrors);
}

EVP_PKEY* keyFromJwk(const QJsonObject& jwk, const QString& alg)
{
    EVP_PKEY* key = EVP_PKEY_new();
    if (!key) return nullptr;
    bool ok = false;
    if (alg == QLatin1String("RS256") && jwk["kty"] == QLatin1String("RSA")) {
        const QByteArray n = decode(jwk["n"].toString().toLatin1());
        const QByteArray e = decode(jwk["e"].toString().toLatin1());
        if (n.size() >= 256 && n.size() <= 1024 && !e.isEmpty() && e.size() <= 8) {
            RSA* rsa = RSA_new();
            BIGNUM* modulus =
                BN_bin2bn(reinterpret_cast<const unsigned char*>(n.constData()), n.size(), nullptr);
            BIGNUM* exponent =
                BN_bin2bn(reinterpret_cast<const unsigned char*>(e.constData()), e.size(), nullptr);
            if (rsa && modulus && exponent && RSA_set0_key(rsa, modulus, exponent, nullptr) == 1) {
                ok = EVP_PKEY_assign_RSA(key, rsa) == 1;
                if (!ok) RSA_free(rsa);
            } else {
                RSA_free(rsa);
                BN_free(modulus);
                BN_free(exponent);
            }
        }
    } else if (alg == QLatin1String("ES256") && jwk["kty"] == QLatin1String("EC") &&
               jwk["crv"] == QLatin1String("P-256")) {
        const auto x = decode(jwk["x"].toString().toLatin1());
        const auto y = decode(jwk["y"].toString().toLatin1());
        EC_KEY* ec = EC_KEY_new_by_curve_name(NID_X9_62_prime256v1);
        if (ec && x.size() == 32 && y.size() == 32) {
            const auto group = EC_KEY_get0_group(ec);
            EC_POINT* point = EC_POINT_new(group);
            const QByteArray encoded = QByteArray(1, '\x04') + x + y;
            if (point &&
                EC_POINT_oct2point(group, point,
                                   reinterpret_cast<const unsigned char*>(encoded.constData()),
                                   encoded.size(), nullptr) == 1 &&
                EC_KEY_set_public_key(ec, point) == 1 && EC_KEY_check_key(ec) == 1)
                ok = EVP_PKEY_assign_EC_KEY(key, ec) == 1;
            EC_POINT_free(point);
        }
        if (!ok) EC_KEY_free(ec);
    }
    if (!ok) {
        EVP_PKEY_free(key);
        return nullptr;
    }
    return key;
}

bool numericDate(const QJsonValue& value, qint64& result)
{
    if (!value.isDouble()) return false;
    const double number = value.toDouble();
    if (!std::isfinite(number) || number < 0 || number > 9007199254740991.0 ||
        std::floor(number) != number)
        return false;
    result = static_cast<qint64>(number);
    return true;
}
} // namespace

static std::optional<QJsonObject> verifySigned(const QByteArray& jwt, const QJsonObject& jwks)
{
    if (jwt.size() > 65536) return std::nullopt;
    const auto parts = jwt.split('.');
    if (parts.size() != 3) return std::nullopt;
    const auto header = QJsonDocument::fromJson(decode(parts[0])).object();
    const auto claims = QJsonDocument::fromJson(decode(parts[1])).object();
    const QString alg = header["alg"].toString(), kid = header["kid"].toString();
    if ((alg != QLatin1String("RS256") && alg != QLatin1String("ES256")) || kid.isEmpty() ||
        header.contains("crit") || header.contains("jku") || header.contains("jwk") ||
        header.contains("x5u"))
        return std::nullopt;
    QJsonObject jwk;
    int matches = 0;
    for (const auto& item : jwks["keys"].toArray()) {
        const auto candidate = item.toObject();
        if (candidate["kid"].toString() != kid) continue;
        ++matches;
        jwk = candidate;
    }
    if (matches != 1 || (jwk.contains("alg") && jwk["alg"].toString() != alg) ||
        (jwk.contains("use") && jwk["use"].toString() != QLatin1String("sig")) ||
        (jwk.contains("key_ops") && !jwk["key_ops"].toArray().contains(QStringLiteral("verify"))))
        return std::nullopt;
    std::unique_ptr<EVP_PKEY, decltype(&EVP_PKEY_free)> key(keyFromJwk(jwk, alg), EVP_PKEY_free);
    if (!key) return std::nullopt;
    QByteArray signature = decode(parts[2]);
    if (alg == QLatin1String("ES256")) {
        if (signature.size() != 64) return std::nullopt;
        ECDSA_SIG* es = ECDSA_SIG_new();
        BIGNUM* r =
            BN_bin2bn(reinterpret_cast<const unsigned char*>(signature.constData()), 32, nullptr);
        BIGNUM* s = BN_bin2bn(reinterpret_cast<const unsigned char*>(signature.constData()) + 32,
                              32, nullptr);
        if (!es || !r || !s || ECDSA_SIG_set0(es, r, s) != 1) {
            ECDSA_SIG_free(es);
            BN_free(r);
            BN_free(s);
            return std::nullopt;
        }
        const int length = i2d_ECDSA_SIG(es, nullptr);
        signature.resize(length);
        auto* out = reinterpret_cast<unsigned char*>(signature.data());
        i2d_ECDSA_SIG(es, &out);
        ECDSA_SIG_free(es);
    }
    std::unique_ptr<EVP_MD_CTX, decltype(&EVP_MD_CTX_free)> ctx(EVP_MD_CTX_new(), EVP_MD_CTX_free);
    const QByteArray signedPart = parts[0] + '.' + parts[1];
    if (!ctx || EVP_DigestVerifyInit(ctx.get(), nullptr, EVP_sha256(), nullptr, key.get()) != 1 ||
        EVP_DigestVerify(ctx.get(), reinterpret_cast<const unsigned char*>(signature.constData()),
                         signature.size(),
                         reinterpret_cast<const unsigned char*>(signedPart.constData()),
                         signedPart.size()) != 1)
        return std::nullopt;
    return claims;
}

std::optional<QJsonObject> OidcToken::verify(const QByteArray& jwt, const QJsonObject& jwks,
                                             const AuthConfig& config, const QString& nonce,
                                             qint64 now)
{
    const auto signedClaims = verifySigned(jwt, jwks);
    if (!signedClaims || nonce.isEmpty()) return std::nullopt;
    const auto claims = *signedClaims;
    qint64 exp = 0, iat = 0, nbf = 0;
    if (claims["iss"].toString() != config.issuer || claims["sub"].toString().isEmpty() ||
        claims["sub"].toString().size() > 1024 || claims["nonce"].toString() != nonce ||
        !numericDate(claims["exp"], exp) || !numericDate(claims["iat"], iat) || exp <= now - 30 ||
        iat > now + 30 || iat > exp ||
        (claims.contains("nbf") && (!numericDate(claims["nbf"], nbf) || nbf > now + 30)))
        return std::nullopt;
    const auto aud = claims["aud"];
    const bool audience = aud.isString() ? aud.toString() == config.clientId
                                         : aud.isArray() && aud.toArray().contains(config.clientId);
    if (!audience ||
        (aud.isArray() && aud.toArray().size() > 1 &&
         claims["azp"].toString() != config.clientId) ||
        (claims.contains("azp") && claims["azp"].toString() != config.clientId))
        return std::nullopt;
    return claims;
}

std::optional<QJsonObject> OidcToken::verifyLogout(const QByteArray& jwt, const QJsonObject& jwks,
                                                   const AuthConfig& config, qint64 now)
{
    const auto verified = verifySigned(jwt, jwks);
    if (!verified) return std::nullopt;
    const auto c = *verified;
    qint64 issued = 0, exp = 0;
    const auto audience = c["aud"];
    const bool aud = audience.isString()
                         ? audience.toString() == config.clientId
                         : audience.isArray() && audience.toArray().contains(config.clientId);
    const auto events = c["events"].toObject();
    const auto event = events.value("http://schemas.openid.net/event/backchannel-logout");
    if (c["iss"].toString() != config.issuer || !aud || c.contains("nonce") ||
        !numericDate(c["iat"], issued) || issued > now + 30 || issued < now - 300 ||
        c["jti"].toString().isEmpty() || c["jti"].toString().size() > 256 || !event.isObject() ||
        !event.toObject().isEmpty() ||
        (c["sid"].toString().isEmpty() && c["sub"].toString().isEmpty()) ||
        (c.contains("sid") && (!c["sid"].isString() || c["sid"].toString().isEmpty() ||
                               c["sid"].toString().size() > 1024)) ||
        (c.contains("sub") && (!c["sub"].isString() || c["sub"].toString().isEmpty() ||
                               c["sub"].toString().size() > 1024)) ||
        (c.contains("exp") && (!numericDate(c["exp"], exp) || exp <= now)))
        return std::nullopt;
    return c;
}
