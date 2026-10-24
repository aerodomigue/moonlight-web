#define OPENSSL_SUPPRESS_DEPRECATED
#include "test_framework.h"
#include "server/OidcToken.h"
#include <QJsonArray>
#include <QJsonDocument>
#include <openssl/bn.h>
#include <openssl/ecdsa.h>
#include <openssl/evp.h>
#include <openssl/rsa.h>
#include <memory>

namespace {
QByteArray b64(const QByteArray& input)
{
    return input.toBase64(QByteArray::Base64UrlEncoding | QByteArray::OmitTrailingEquals);
}
QByteArray number(const BIGNUM* n)
{
    QByteArray result(BN_num_bytes(n), '\0');
    BN_bn2bin(n, reinterpret_cast<unsigned char*>(result.data()));
    return result;
}
QByteArray sign(EVP_PKEY* key, const QJsonObject& header, const QJsonObject& claims)
{
    const QByteArray input = b64(QJsonDocument(header).toJson(QJsonDocument::Compact)) + '.' +
                             b64(QJsonDocument(claims).toJson(QJsonDocument::Compact));
    std::unique_ptr<EVP_MD_CTX, decltype(&EVP_MD_CTX_free)> ctx(EVP_MD_CTX_new(), EVP_MD_CTX_free);
    if (!ctx || EVP_DigestSignInit(ctx.get(), nullptr, EVP_sha256(), nullptr, key) != 1) return {};
    size_t length = 0;
    if (EVP_DigestSign(ctx.get(), nullptr, &length,
                       reinterpret_cast<const unsigned char*>(input.constData()),
                       input.size()) != 1)
        return {};
    QByteArray signature(static_cast<int>(length), '\0');
    if (EVP_DigestSign(ctx.get(), reinterpret_cast<unsigned char*>(signature.data()), &length,
                       reinterpret_cast<const unsigned char*>(input.constData()),
                       input.size()) != 1)
        return {};
    signature.resize(static_cast<int>(length));
    if (header["alg"] == QLatin1String("ES256") && EVP_PKEY_base_id(key) == EVP_PKEY_EC) {
        const auto* bytes = reinterpret_cast<const unsigned char*>(signature.constData());
        ECDSA_SIG* parsed = d2i_ECDSA_SIG(nullptr, &bytes, signature.size());
        if (!parsed) return {};
        const BIGNUM *r = nullptr, *s = nullptr;
        ECDSA_SIG_get0(parsed, &r, &s);
        signature.resize(64);
        BN_bn2binpad(r, reinterpret_cast<unsigned char*>(signature.data()), 32);
        BN_bn2binpad(s, reinterpret_cast<unsigned char*>(signature.data()) + 32, 32);
        ECDSA_SIG_free(parsed);
    }
    return input + '.' + b64(signature);
}
} // namespace

void run_oidc_token_tests()
{
    SECTION("OIDC signatures, issuer, audience, nonce and token lifetime");
    std::unique_ptr<EVP_PKEY_CTX, decltype(&EVP_PKEY_CTX_free)> generation(
        EVP_PKEY_CTX_new_id(EVP_PKEY_RSA, nullptr), EVP_PKEY_CTX_free);
    CHECK(generation != nullptr);
    if (!generation) return;
    CHECK(EVP_PKEY_keygen_init(generation.get()) == 1);
    CHECK(EVP_PKEY_CTX_set_rsa_keygen_bits(generation.get(), 2048) == 1);
    EVP_PKEY* generated = nullptr;
    CHECK(EVP_PKEY_keygen(generation.get(), &generated) == 1);
    std::unique_ptr<EVP_PKEY, decltype(&EVP_PKEY_free)> key(generated, EVP_PKEY_free);
    if (!key) return;
    const RSA* rsa = EVP_PKEY_get0_RSA(key.get());
    const BIGNUM *n = nullptr, *e = nullptr;
    RSA_get0_key(rsa, &n, &e, nullptr);
    QJsonObject jwk{{"kty", "RSA"},
                    {"kid", "test-key"},
                    {"alg", "RS256"},
                    {"use", "sig"},
                    {"n", QString::fromLatin1(b64(number(n)))},
                    {"e", QString::fromLatin1(b64(number(e)))}};
    const QJsonObject keys{{"keys", QJsonArray{jwk}}};
    AuthConfig config;
    config.sso = true;
    config.issuer = "https://auth.example/application/o/moonlight/";
    config.clientId = "moonlight";
    const qint64 now = 1800000000;
    const QJsonObject header{{"alg", "RS256"}, {"kid", "test-key"}};
    const QJsonObject good{{"iss", config.issuer},   {"sub", "alice-sub"},
                           {"aud", config.clientId}, {"nonce", "test-nonce"},
                           {"iat", now - 10},        {"exp", now + 300},
                           {"name", "Alice"},        {"moonlight_role", "internal_user"}};
    const auto valid = sign(key.get(), header, good);
    CHECK(!valid.isEmpty());
    const auto verify = [&](const QByteArray& jwt, const QJsonObject& signingKeys = QJsonObject()) {
        return OidcToken::verify(jwt, signingKeys.isEmpty() ? keys : signingKeys, config,
                                 "test-nonce", now);
    };
    CHECK(verify(valid).has_value());
    CHECK_EQ(verify(valid)->value("sub").toString(), QString("alice-sub"));
    CHECK_EQ(verify(valid)->value("moonlight_role").toString(), QString("internal_user"));
    auto forgedRole = good;
    forgedRole["moonlight_role"] = "internal_admin";
    const auto parts = valid.split('.');
    CHECK(!verify(parts[0] + '.' + b64(QJsonDocument(forgedRole).toJson(QJsonDocument::Compact)) +
                  '.' + parts[2]));
    const QList<QPair<QString, QJsonValue>> invalidClaims{
        {"iss", "https://another.example/"},
        {"sub", ""},
        {"sub", QJsonValue::Null},
        {"aud", "other-client"},
        {"aud", QJsonArray{"other-client"}},
        {"aud", 123},
        {"nonce", "replayed-nonce"},
        {"nonce", QJsonValue::Null},
        {"exp", now - 60},
        {"exp", "1800000300"},
        {"exp", QJsonValue::Null},
        {"iat", now + 60},
        {"iat", QJsonValue::Null},
        {"nbf", now + 60},
        {"azp", "other-client"},
        {"aud", QJsonArray{config.clientId, "other-client"}}};
    for (const auto& item : invalidClaims) {
        auto claims = good;
        claims[item.first] = item.second;
        CHECK(!verify(sign(key.get(), header, claims)));
    }
    SECTION("Back-channel logout token separation and validation");
    auto logout = good;
    logout.remove("nonce");
    logout["jti"] = "one-logout";
    logout["sid"] = "provider-session";
    logout["events"] =
        QJsonObject{{"http://schemas.openid.net/event/backchannel-logout", QJsonObject{}}};
    CHECK(OidcToken::verifyLogout(sign(key.get(), header, logout), keys, config, now).has_value());
    CHECK(!OidcToken::verifyLogout(valid, keys, config, now));
    CHECK(!verify(sign(key.get(), header, logout)));
    for (const auto& item : QList<QPair<QString, QJsonValue>>{{"nonce", "forbidden"},
                                                              {"jti", ""},
                                                              {"iat", now - 301},
                                                              {"iat", now + 31},
                                                              {"sid", 123},
                                                              {"iss", "https://wrong.test/"},
                                                              {"aud", "other-client"},
                                                              {"events", QJsonObject{}}}) {
        auto invalid = logout;
        invalid[item.first] = item.second;
        CHECK(!OidcToken::verifyLogout(sign(key.get(), header, invalid), keys, config, now));
    }
    auto multiAudience = good;
    multiAudience["aud"] = QJsonArray{config.clientId, "other-client"};
    multiAudience["azp"] = config.clientId;
    CHECK(verify(sign(key.get(), header, multiAudience)).has_value());
    for (const auto& alg :
         {QString("none"), QString("HS256"), QString("RS512"), QString("ES256")}) {
        auto wrong = header;
        wrong["alg"] = alg;
        CHECK(!verify(sign(key.get(), wrong, good)));
    }
    for (const auto& field : {QString("crit"), QString("jku"), QString("jwk"), QString("x5u")}) {
        auto wrong = header;
        wrong[field] = "https://attacker.example/key";
        CHECK(!verify(sign(key.get(), wrong, good)));
    }
    auto unknown = header;
    unknown["kid"] = "unknown";
    CHECK(!verify(sign(key.get(), unknown, good)));
    CHECK(!verify(valid, {{"keys", QJsonArray{jwk, jwk}}}));
    auto wrongUse = jwk;
    wrongUse["use"] = "enc";
    CHECK(!verify(valid, {{"keys", QJsonArray{wrongUse}}}));
    wrongUse = jwk;
    wrongUse["key_ops"] = QJsonArray{"sign"};
    CHECK(!verify(valid, {{"keys", QJsonArray{wrongUse}}}));
    auto tampered = valid;
    tampered[tampered.size() - 8] = tampered[tampered.size() - 8] == 'A' ? 'B' : 'A';
    CHECK(!verify(tampered));
    CHECK(!verify(valid + '.'));
    CHECK(!verify(QByteArray(70000, 'A')));
    CHECK(!verify("not-a-token"));
    CHECK(!OidcToken::verify(valid, keys, config, {}, now));
    auto otherIssuer = config;
    otherIssuer.issuer += "another/";
    CHECK(!OidcToken::verify(valid, keys, otherIssuer, "test-nonce", now));

    SECTION("OIDC ES256 signatures and curve validation");
    EC_KEY* ec = EC_KEY_new_by_curve_name(NID_X9_62_prime256v1);
    CHECK(ec != nullptr);
    if (!ec) return;
    CHECK(EC_KEY_generate_key(ec) == 1);
    std::unique_ptr<EVP_PKEY, decltype(&EVP_PKEY_free)> ecKey(EVP_PKEY_new(), EVP_PKEY_free);
    CHECK(EVP_PKEY_assign_EC_KEY(ecKey.get(), ec) == 1);
    BIGNUM *x = BN_new(), *y = BN_new();
    CHECK(EC_POINT_get_affine_coordinates_GFp(EC_KEY_get0_group(ec), EC_KEY_get0_public_key(ec), x,
                                              y, nullptr) == 1);
    QByteArray xb(32, '\0'), yb(32, '\0');
    BN_bn2binpad(x, reinterpret_cast<unsigned char*>(xb.data()), 32);
    BN_bn2binpad(y, reinterpret_cast<unsigned char*>(yb.data()), 32);
    BN_free(x);
    BN_free(y);
    QJsonObject ecJwk{{"kty", "EC"},
                      {"crv", "P-256"},
                      {"kid", "ec-key"},
                      {"alg", "ES256"},
                      {"x", QString::fromLatin1(b64(xb))},
                      {"y", QString::fromLatin1(b64(yb))}};
    const QJsonObject ecKeys{{"keys", QJsonArray{ecJwk}}};
    const QByteArray ecToken = sign(ecKey.get(), {{"alg", "ES256"}, {"kid", "ec-key"}}, good);
    CHECK(verify(ecToken, ecKeys).has_value());
    auto wrongCurve = ecJwk;
    wrongCurve["crv"] = "P-384";
    CHECK(!verify(ecToken, {{"keys", QJsonArray{wrongCurve}}}));
    auto badCoordinate = ecJwk;
    badCoordinate["x"] = "AA";
    CHECK(!verify(ecToken, {{"keys", QJsonArray{badCoordinate}}}));
    CHECK(!verify(ecToken.left(ecToken.lastIndexOf('.') + 1) + "AA", ecKeys));
}
