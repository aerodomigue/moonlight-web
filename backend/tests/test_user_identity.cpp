#include "test_framework.h"
#include "server/AuthConfig.h"
#include "server/AuthManager.h"
#include "server/RequestGuard.h"
#include "server/UserAccess.h"
#include "server/UserStore.h"
#include "common/PairingCrypto.h"
#include <QFile>
#include <QJsonDocument>
#include <QJsonArray>
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
    CHECK_EQ(store.upsert(config.issuer, "empty-profile", "").name, QString("User"));
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
    SECTION("Managed local accounts and explicit SSO binding");
    auto local = store.createLocal("Local player");
    CHECK(local.id.startsWith("local-"));
    CHECK(store.active(local.id));
    CHECK_EQ(local.role, QString("user"));
    store.bind(local.id, config.issuer, "linked-sub", "verified");
    CHECK_EQ(store.findIdentity(config.issuer, "linked-sub").id, local.id);
    CHECK_EQ(store.upsert(config.issuer, "linked-sub", "Provider rename").name,
             QString("Local player"));
    local = store.get(local.id);
    local.enabled = false;
    local.role = "admin";
    local.ssoRole = "user";
    local.roleRevision = 7;
    store.update(local);
    CHECK(!store.active(local.id));
    CHECK(!store.upsert(config.issuer, "linked-sub", "Still disabled").enabled);
    bool conflict = false;
    try {
        store.bind(bob.id, config.issuer, "linked-sub", "verified");
    } catch (const std::exception&) {
        conflict = true;
    }
    CHECK(conflict);
    UserStore managedReload(path);
    CHECK_EQ(managedReload.findIdentity(config.issuer, "linked-sub").id, local.id);
    CHECK(!managedReload.active(local.id));
    CHECK_EQ(managedReload.get(local.id).role, QString("admin"));
    CHECK_EQ(managedReload.get(local.id).ssoRole, QString("user"));
    CHECK_EQ(managedReload.get(local.id).roleRevision, quint64(7));
    const auto legacyPath = temporary.filePath("legacy-users.json");
    QFile legacyFile(legacyPath);
    CHECK(legacyFile.open(QIODevice::WriteOnly));
    legacyFile.write(
        QJsonDocument(QJsonObject{{"version", 2}, {"users", QJsonArray{local.adminJson()}}})
            .toJson());
    legacyFile.close();
    UserStore migrated(legacyPath);
    CHECK_EQ(migrated.get(local.id).id, local.id);
    CHECK_EQ(migrated.get(local.id).role, QString("admin"));
    CHECK_EQ(migrated.get(local.id).ssoRole, QString("user"));
    CHECK_EQ(migrated.get(local.id).roleRevision, quint64(0));
    CHECK(!migrated.active(local.id));
    auto owner = store.get(UserStore::localId());
    owner.enabled = false;
    conflict = false;
    try {
        store.update(owner);
    } catch (const std::exception&) {
        conflict = true;
    }
    CHECK(conflict);
    conflict = false;
    try {
        store.remove(UserStore::localId());
    } catch (const std::exception&) {
        conflict = true;
    }
    CHECK(conflict);
    store.remove(local.id);
    CHECK(!store.contains(local.id));
    CHECK(store.findIdentity(config.issuer, "linked-sub").id.isEmpty());

    SECTION("Private authentication configuration and precedence");
    auto saved = config;
    saved.pin = true;
    saved.clientSecret = "test-only-private-value";
    const auto authPath = temporary.filePath("auth-config.json");
    saved.save(authPath);
    CHECK(!saved.json().contains("client_secret"));
    CHECK(saved.json()["secret_configured"].toBool());
    auto bootstrap = saved;
    bootstrap.pin = false;
    bootstrap.clientSecret = "wrong-bootstrap-secret";
    auto loaded = AuthConfig::load(authPath, bootstrap);
    CHECK(loaded.pin);
    CHECK_EQ(loaded.clientSecret, saved.clientSecret);
#ifdef Q_OS_UNIX
    // POSIX mode bits are not NTFS ACLs. Windows still exercises the full save/load path.
    CHECK(!(QFile::permissions(authPath) & (QFile::ReadGroup | QFile::ReadOther)));
#endif
    CHECK_EQ(AuthConfig::edited(loaded, {{"client_secret", ""}}).clientSecret, saved.clientSecret);
    CHECK(AuthConfig::edited(loaded, {{"clear_secret", true}}).clientSecret.isEmpty());
    CHECK_EQ(loaded.json()["scopes"].toString(), QString("openid profile email moonlight_role"));
    const auto scoped = AuthConfig::edited(loaded, {{"scopes", "openid moonlight_role"}});
    CHECK(scoped.signature() != loaded.signature());
    CHECK_EQ(scoped.clientSecret, saved.clientSecret);
    scoped.save(authPath);
    CHECK_EQ(AuthConfig::load(authPath, bootstrap).json()["scopes"].toString(),
             QString("openid moonlight_role"));
    saved.save(authPath);
    auto ssoMode = saved;
    ssoMode.pin = false;
    CHECK_EQ(saved.signature(), ssoMode.signature());
    ssoMode.clientId = "changed-client";
    CHECK(saved.signature() != ssoMode.signature());
    conflict = false;
    try {
        AuthConfig::edited(saved, {{"pin", false}, {"sso", false}});
    } catch (const std::exception&) {
        conflict = true;
    }
    CHECK(conflict);
    conflict = false;
    try {
        AuthConfig::edited(saved, {{"pin", "false"}});
    } catch (const std::exception&) {
        conflict = true;
    }
    CHECK(conflict);

    SECTION("Storage failures leave the previous in-memory accounts intact");
    const auto blockedPath = temporary.filePath("not-a-directory");
    QFile blocker(blockedPath);
    CHECK(blocker.open(QIODevice::WriteOnly));
    blocker.write("block");
    blocker.close();
    UserStore failing(blockedPath + "/users.json");
    bool failedSave = false;
    try {
        failing.createLocal("Must not appear");
    } catch (const std::exception&) {
        failedSave = true;
    }
    CHECK(failedSave);
    CHECK_EQ(failing.all().size(), 1);
    failedSave = false;
    try {
        saved.save(blockedPath + "/auth-config.json");
    } catch (const std::exception&) {
        failedSave = true;
    }
    CHECK(failedSave);
    CHECK_EQ(AuthConfig::load(authPath, bootstrap).clientSecret, saved.clientSecret);

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
    CHECK(!auth.isSsoAdmin(adminSession)); // legacy subject lists are not role proof
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

    SECTION("Local roles, disabled accounts and safe runtime configuration");
    AuthManager managed(nullptr, nullptr, mixed);
    auto player = managed.users().createLocal("PIN administrator", "admin");
    const auto playerPin = managed.generateUserPin(player.id);
    CHECK(managed.validateAccountPin("10.2.10.45", playerPin, matched).result ==
          AuthManager::Valid);
    const auto playerToken =
        managed.createSession("10.2.10.45", "Local admin", false, false, false, player.id, "pin");
    CHECK(!managed.isSsoAdmin(playerToken)); // PIN always requires password unlock
    CHECK(!managed.isSsoAdmin(managed.createSession("10.2.10.46", "Legacy owner")));
    CHECK(managed.passwordUnlockEligible(playerToken));
    CHECK(!managed.isAdminSession(playerToken));
    CHECK(managed.promoteSessionToAdmin(playerToken));
    CHECK(managed.isAdminSession(playerToken));
    auto linked = managed.users().upsert(mixed.issuer, "roles-subject", "Roles");
    linked.role = "admin"; // An old manual assignment must never override the issuer.
    managed.users().update(linked);
    auto oldSso =
        managed.createSession("10.2.10.47", "Old SSO", false, false, false, linked.id, "sso");
    CHECK(!managed.isSsoAdmin(oldSso));
    linked = managed.synchronizeSsoRole(linked, "admin", mixed);
    CHECK(!managed.validateSession(oldSso));
    auto freshSso =
        managed.createSession("10.2.10.47", "Fresh SSO", false, false, false, linked.id, "sso");
    CHECK(!managed.isSsoAdmin(freshSso)); // A session alone is not verified-role proof.
    CHECK(managed.proveSsoAdministrator(freshSso));
    CHECK(managed.isSsoAdmin(freshSso));
    CHECK(!managed.passwordUnlockEligible(freshSso));
    auto linkedPin =
        managed.createSession("10.2.10.48", "Linked PIN", false, false, false, linked.id);
    CHECK(!managed.isSsoAdmin(linkedPin));
    CHECK(managed.passwordUnlockEligible(linkedPin));
    CHECK(managed.promoteSessionToAdmin(linkedPin));
    linked = managed.synchronizeSsoRole(linked, "user", mixed);
    CHECK_EQ(linked.role, QString("admin"));
    CHECK(!managed.userAdministrator(linked));
    CHECK(!managed.validateSession(freshSso));
    CHECK(!managed.isAdminSession(linkedPin));
    auto userPin = managed.createSession("10.2.10.48", "User PIN", false, false, false, linked.id);
    CHECK(!managed.passwordUnlockEligible(userPin));
    CHECK(!managed.promoteSessionToAdmin(userPin));
    auto userSso =
        managed.createSession("10.2.10.47", "User SSO", false, false, false, linked.id, "sso");
    CHECK(managed.proveSsoAdministrator(userSso));
    CHECK(!managed.isSsoAdmin(userSso));
    auto localOwner = managed.users().get(UserStore::localId());
    managed.users().bind(localOwner.id, mixed.issuer, "owner-sub", mixed.signature(), "user");
    auto ownerSso =
        managed.createSession("10.2.10.49", "Owner SSO", false, false, false, localOwner.id, "sso");
    CHECK(managed.proveSsoAdministrator(ownerSso));
    CHECK(!managed.isSsoAdmin(ownerSso));
    CHECK(!managed.passwordUnlockEligible(ownerSso));
    auto ownerPin = managed.createSession("10.2.10.49", "Recovery");
    CHECK(managed.passwordUnlockEligible(ownerPin));
    CHECK(managed.promoteSessionToAdmin(ownerPin));
    CHECK(managed.isAdminSession(ownerPin));
    player.enabled = false;
    managed.users().update(player);
    CHECK_EQ(managed.effectiveRole(player), QString("admin"));
    CHECK(!managed.userAdministrator(player));
    CHECK(!managed.validateSession(playerToken));
    CHECK(managed.generateUserPin(player.id).isEmpty());
    CHECK(
        managed.createSession("10.2.10.45", "Disabled", false, false, false, player.id).isEmpty());
    managed.revokeUserSessions(player.id);
    auto only = mixed;
    only.pin = false;
    bool unsafe = false;
    try {
        managed.applyConfig(only);
    } catch (const std::exception&) {
        unsafe = true;
    }
    CHECK(unsafe);
    CHECK(managed.config().pin);
    auto verifiedAdmin = managed.users().upsert(mixed.issuer, "verified-admin", "Verified");
    verifiedAdmin.role = "admin";
    verifiedAdmin.ssoRole = "admin";
    verifiedAdmin.managedRole = true;
    verifiedAdmin.verifiedConfig = mixed.signature();
    managed.users().update(verifiedAdmin);
    CHECK(managed.verifiedSsoAdministrator(only));
    managed.applyConfig(only);
    CHECK(!managed.config().pin);
    CHECK_EQ(managed.configRevision(), quint64(1));

    const auto beforeProviderChange = managed.createSession("10.2.10.50", "Verified SSO", false,
                                                            false, false, verifiedAdmin.id, "sso");
    CHECK(managed.proveSsoAdministrator(beforeProviderChange));
    CHECK(managed.isSsoAdmin(beforeProviderChange));
    auto otherProvider = only;
    otherProvider.pin = true;
    otherProvider.issuer += "other/";
    managed.applyConfig(otherProvider);
    CHECK(!managed.validateSession(beforeProviderChange));
    CHECK(!managed.userAdministrator(managed.users().get(verifiedAdmin.id)));
    CHECK(!managed.verifiedSsoAdministrator(otherProvider));
    CHECK(managed.passwordUnlockEligible(managed.createSession("10.2.10.51", "Owner recovery")));

    SECTION("Concurrent accounts keep independent streaming and revocation state");
    AuthManager concurrent(nullptr, nullptr, mixed);
    const auto firstUser = concurrent.users().createLocal("First");
    const auto secondUser = concurrent.users().createLocal("Second");
    const auto firstToken =
        concurrent.createSession("10.2.10.60", "First", false, false, false, firstUser.id);
    const auto secondToken =
        concurrent.createSession("10.2.10.61", "Second", false, false, false, secondUser.id);
    concurrent.setSessionStreaming(firstToken, true);
    concurrent.setSessionStreaming(secondToken, true);
    int streams = 0;
    for (const auto& entry : concurrent.sessions())
        if (entry.streaming) ++streams;
    CHECK_EQ(streams, 2);
    int revokedStreams = 0;
    QObject::connect(&concurrent, &AuthManager::streamingSessionRevoked,
                     [&revokedStreams]() { ++revokedStreams; });
    concurrent.revokeUserSessions(firstUser.id);
    CHECK(!concurrent.validateSession(firstToken));
    CHECK(concurrent.validateSession(secondToken));
    CHECK(concurrent.sessionForToken(secondToken).streaming);
    CHECK_EQ(revokedStreams, 1);

    SECTION("Identity renewal requires a fresh login and the original bound browser");
    AuthManager renewal(nullptr, nullptr, mixed);
    const auto hostKey =
        PairingCrypto::publicKeySpkiFromPrivatePem(PairingCrypto::generatePrivateKeyPem());
    const auto browserKey =
        PairingCrypto::publicKeySpkiFromPrivatePem(PairingCrypto::generatePrivateKeyPem());
    const auto otherKey =
        PairingCrypto::publicKeySpkiFromPrivatePem(PairingCrypto::generatePrivateKeyPem());
    const auto renewToken = renewal.createSession("10.2.10.90", "Renewal");
    CHECK(!renewal.authorizeIdentityRenewal(renewToken, hostKey, 1000));
    CHECK(renewal.bindSessionKey(renewToken, browserKey));
    CHECK(!renewal.canRenewIdentity(renewToken, browserKey, hostKey, 1000));
    CHECK(renewal.authorizeIdentityRenewal(renewToken, hostKey, 1000));
    CHECK(renewal.canRenewIdentity(renewToken, browserKey, hostKey, 1000));
    CHECK(renewal.canRenewIdentity(renewToken, browserKey, hostKey, 1299));
    CHECK(!renewal.canRenewIdentity(renewToken, browserKey, hostKey, 1300));
    CHECK(!renewal.canRenewIdentity(renewToken, otherKey, hostKey, 1001));
    CHECK(!renewal.canRenewIdentity(renewToken, browserKey, otherKey, 1001));
    CHECK(!renewal.canRenewIdentity(renewToken, browserKey, hostKey, 999));
    CHECK(!renewal.sessionForToken(renewToken).toJson().contains("identity_renewal"));
    renewal.applyConfig(mixed);
    CHECK(!renewal.canRenewIdentity(renewToken, browserKey, hostKey, 1001));
    CHECK(renewal.authorizeIdentityRenewal(renewToken, hostKey, 1002));
    renewal.logoutSession(renewToken);
    CHECK(!renewal.canRenewIdentity(renewToken, browserKey, hostKey, 1003));
    const auto hostToken = renewal.createSession("10.2.10.90", "Host", true);
    CHECK(renewal.bindSessionKey(hostToken, browserKey));
    CHECK(!renewal.authorizeIdentityRenewal(hostToken, hostKey, 1000));

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
