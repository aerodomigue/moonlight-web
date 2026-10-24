#include "test_framework.h"
#include "server/AuthConfig.h"
#include "server/AuthManager.h"
#include "server/RequestGuard.h"
#include "server/UserAccess.h"
#include "server/UserStore.h"
#include <QFile>
#include <QTemporaryDir>
#include <stdexcept>

void run_user_identity_tests()
{
    SECTION("User identities and machine isolation");
    AuthConfig config;
    CHECK(config.error().isEmpty());
    config.pin = false;
    CHECK(!config.error().isEmpty());
    config.sso = true;
    CHECK(!config.error().isEmpty());
    config.issuer = "https://auth.example/application/o/moonlight/";
    config.publicUrl = "https://moonlight.example";
    config.clientId = "moonlight";
    CHECK(config.error().isEmpty());
    CHECK_EQ(config.callbackUrl(), QString("https://moonlight.example/api/auth/oidc/callback"));
    for (const QString& bad :
         {QString("http://auth.example"), QString("https://user@auth.example"),
          QString("https://auth.example/?query=1"), QString("https://auth.example/#fragment")}) {
        auto invalid = config;
        invalid.issuer = bad;
        CHECK(!invalid.error().isEmpty());
    }
    for (const QString& bad :
         {QString("http://moonlight.example"), QString("https://moonlight.example/path"),
          QString("https://user@moonlight.example"), QString("https://moonlight.example?x=1")}) {
        auto invalid = config;
        invalid.publicUrl = bad;
        CHECK(!invalid.error().isEmpty());
    }
    config.adminSubjects = {QStringLiteral("admin-subject")};
    CHECK(config.administrator("admin-subject"));
    CHECK(!config.administrator("another-subject"));

    QTemporaryDir temporary;
    CHECK(temporary.isValid());
    const QString path = temporary.filePath("users.json");
    UserStore store(path);
    CHECK(store.contains(UserStore::localId()));
    auto alice = store.upsert(config.issuer, "alice-sub", "Alice");
    auto bob = store.upsert(config.issuer, "bob-sub", "Bob");
    CHECK(alice.id != bob.id);
    CHECK_EQ(store.upsert(config.issuer, "alice-sub", "New display name").id, alice.id);
    CHECK_EQ(store.get(alice.id).name, QString("New display name"));
    CHECK(UserStore::oidcId("ab", "c") != UserStore::oidcId("a", "bc"));
    CHECK(UserStore::oidcId("https://other.example/", "alice-sub") != alice.id);
    UserStore restored(path);
    CHECK_EQ(restored.get(alice.id).subject, QString("alice-sub"));
    CHECK_EQ(restored.get(bob.id).name, QString("Bob"));
    CHECK(!restored.contains("invented-account"));
    CHECK(UserAccess::owns(alice.id, alice.id));
    CHECK(!UserAccess::owns(alice.id, bob.id));
    CHECK(!UserAccess::owns({}, {}));
    CHECK_EQ(UserAccess::hostId(UserStore::localId(), "pc-uuid"), QString("pc-uuid"));
    CHECK(UserAccess::hostId(alice.id, "pc-uuid") != UserAccess::hostId(bob.id, "pc-uuid"));
    CHECK_EQ(UserAccess::hostId(alice.id, "pc-uuid"), UserAccess::hostId(alice.id, "pc-uuid"));
    CHECK(UserAccess::hostId(alice.id, "pc-uuid") != UserAccess::hostId(alice.id, "other-pc"));
    CHECK_EQ(UserAccess::deviceId(UserStore::localId(), "ABC"), QString("ABC"));
    CHECK(UserAccess::deviceId(alice.id, "ABC") != UserAccess::deviceId(bob.id, "ABC"));
    CHECK_EQ(UserAccess::deviceId(alice.id, "ABC").size(), 16);
    CHECK(UserAccess::deviceId(alice.id, {}).isEmpty());
    UserAccess::HostLeases leases;
    CHECK(!leases.acquire({}, alice.id));
    CHECK(!leases.acquire("pc", {}));
    auto first = leases.acquire("pc", alice.id);
    CHECK(first != nullptr);
    CHECK(leases.busy("pc"));
    auto second = leases.acquire("pc", alice.id);
    CHECK(second != nullptr);
    CHECK(!leases.acquire("pc", bob.id));
    auto otherPc = leases.acquire("another-pc", bob.id);
    CHECK(otherPc != nullptr);
    first.reset();
    CHECK(!leases.acquire("pc", bob.id));
    second.reset();
    CHECK(!leases.busy("pc"));
    CHECK(leases.acquire("pc", bob.id) != nullptr);
    bool refused = false;
    try {
        store.upsert({}, "subject", "Name");
    } catch (const std::exception&) {
        refused = true;
    }
    CHECK(refused);
    QFile corrupt(path);
    CHECK(corrupt.open(QIODevice::WriteOnly));
    corrupt.write("not-json");
    corrupt.close();
    refused = false;
    try {
        UserStore invalid(path);
    } catch (const std::exception&) {
        refused = true;
    }
    CHECK(refused);

    SECTION("Account PINs and SSO sessions");
    AuthConfig mixed = config;
    mixed.pin = true;
    AuthManager auth(nullptr, nullptr, mixed);
    alice = auth.users().upsert(config.issuer, "alice-sub", "Alice");
    bob = auth.users().upsert(config.issuer, "bob-sub", "Bob");
    const auto administrator = auth.users().upsert(config.issuer, "admin-subject", "Admin");
    const auto session =
        auth.createSession("10.2.10.20", "Laptop", false, false, false, alice.id, "sso");
    CHECK(auth.validateSession(session));
    CHECK_EQ(auth.sessionForToken(session).userId, alice.id);
    CHECK(!auth.isSsoAdmin(session));
    const auto adminSession =
        auth.createSession("10.2.10.21", "Admin", false, false, false, administrator.id, "sso");
    CHECK(auth.isSsoAdmin(adminSession));
    CHECK(!auth.isSsoAdmin("invented-cookie"));
    CHECK(auth.createSession("10.2.10.21", "Unknown", false, false, false, "unknown", "sso")
              .isEmpty());
    const QString alicePin = auth.generateUserPin(alice.id);
    const QString bobPin = auth.generateUserPin(bob.id);
    CHECK(!alicePin.isEmpty());
    CHECK(alicePin != bobPin);
    QString matched;
    CHECK(
        auth.validateAccountPin("10.2.10.29", alicePin + QString(256, QChar(0)), matched).result ==
        AuthManager::InvalidPin);
    CHECK(auth.validateAccountPin("10.2.10.22", alicePin, matched).result == AuthManager::Valid);
    CHECK_EQ(matched, alice.id);
    CHECK(auth.validateAccountPin("10.2.10.22", alicePin, matched).result ==
          AuthManager::InvalidPin);
    CHECK(matched.isEmpty());
    CHECK(auth.validateAccountPin("10.2.10.23", bobPin, matched).result == AuthManager::Valid);
    CHECK_EQ(matched, bob.id);
    CHECK(auth.generateUserPin("invented-account").isEmpty());
    const QString replaced = auth.generateUserPin(alice.id);
    const QString replacement = auth.generateUserPin(alice.id);
    CHECK(replaced != replacement);
    CHECK(auth.validateAccountPin("10.2.10.24", replaced, matched).result ==
          AuthManager::InvalidPin);
    CHECK(auth.validateAccountPin("10.2.10.24", replacement, matched).result == AuthManager::Valid);
    const auto pinSession =
        auth.createSession("10.2.10.24", "PIN laptop", false, true, false, matched, "pin");
    CHECK(auth.validateSession(pinSession));
    CHECK_EQ(auth.sessionForToken(pinSession).userId, alice.id);
    CHECK(auth.isEphemeralSession(pinSession));
    CHECK(auth.logoutSession(pinSession));
    CHECK(!auth.validateSession(pinSession));
    const QString localPin = auth.generatePin();
    CHECK(auth.validateAccountPin("10.2.10.25", localPin, matched).result == AuthManager::Valid);
    CHECK_EQ(matched, UserStore::localId());
    AuthManager ssoOnly(nullptr, nullptr, config);
    ssoOnly.generatePin();
    CHECK(ssoOnly.generateUserPin(UserStore::localId()).isEmpty());
    CHECK(ssoOnly.validateAccountPin("10.2.10.26", ssoOnly.currentPin(), matched).result ==
          AuthManager::InvalidPin);
    CHECK(!ssoOnly.validateSession(ssoOnly.createSession("10.2.10.26")));
    CHECK(ssoOnly.validateSession(ssoOnly.createSession("10.2.10.26", "Recovery", true)));
    CHECK(auth.validateSession(
        session)); // another browser logging out did not end Alice's SSO session

    const QString beforeExpiry = auth.generateUserPin(alice.id, 1000);
    CHECK(auth.validateAccountPin("10.2.10.30", beforeExpiry, matched, 1299).result ==
          AuthManager::Valid);
    CHECK_EQ(matched, alice.id);
    const QString expired = auth.generateUserPin(alice.id, 1000);
    CHECK(auth.validateAccountPin("10.2.10.31", expired, matched, 1300).result ==
          AuthManager::InvalidPin);
    CHECK(matched.isEmpty());

    SECTION("Only the OIDC callback allows a cross-site GET");
    HttpRequest req;
    req.method = "GET";
    req.path = "/api/auth/oidc/callback";
    req.headers["host"] = "moonlight.example";
    req.headers["sec-fetch-site"] = "cross-site";
    RequestGuard::Context context;
    context.publicDomain = "moonlight.example";
    CHECK(RequestGuard::evaluate(RequestGuard::describe(req), context).outcome ==
          RequestGuard::Outcome::Allow);
    req.method = "POST";
    CHECK(RequestGuard::evaluate(RequestGuard::describe(req), context).outcome ==
          RequestGuard::Outcome::BlockCrossSite);
    req.method = "GET";
    for (const QString& other :
         {QString("/api/auth/status"), QString("/api/auth/oidc/prepare"), QString("/api/hosts")}) {
        req.path = other;
        CHECK(RequestGuard::evaluate(RequestGuard::describe(req), context).outcome ==
              RequestGuard::Outcome::BlockCrossSite);
    }
}
