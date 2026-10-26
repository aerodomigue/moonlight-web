# Discovery confirmation and SSO account isolation review

## Backend change

Discovery previously called the persistence path as soon as mDNS/serverinfo
answered. It now writes only an owner-scoped, bounded in-memory observation.
Candidate IDs are opaque, different per owner, expire 120 seconds after their
last observation, and confer no host/resource access.

Reviewed: exact route exceptions preserve the global signature/CSRF gates;
owner comes from the authenticated request; confirmation re-fetches serverinfo,
checks physical identity, registration collisions (including disabled records),
account activity and discovery generation after the asynchronous reply. A pending
confirmation cannot duplicate itself or survive disable/re-enable. Persistence
failure removes the new record and restores the settings cache before responding.
Each confirmed addition gets a fresh certificate seat, including when an older
administratively cloned seat survives. Existing registrations and explicit
administrator clone/transfer semantics are unchanged.

Validation: 52 HTTPS integration scenarios pass, including confirmation, concurrent
clicks/cancellation, identity mismatch, forbidden cross-account IDs, CSRF/signature
requirements, disabled collision, restart and write failure. Unit checks cover
TTL boundaries, refresh, owner isolation and bounds; the full unit executable
reports 17094/17099, with only the five existing Linux launcher-path failures.

An additional HTTPS regression reproduces add → administrator clone → delete
source → rediscover/add: the clone retains its old seat, while the re-added source
gets a different seat and stays unpaired. Targeted test passed before commit.

## Frontend change

Reviewed the authoritative host snapshot, removal of obsolete cached apps, ordering
of concurrent snapshots, candidate list lifecycle, double-click handling, and
in-flight response/body/signing cancellation on account revision changes.
Admin-key lookup and retry cannot send an old action under the new account.
Browser pairing keys remain in IndexedDB; signatures, role enforcement and SSO
expiry are unchanged. Video preferences survive same-account logout/login and
are cleared on a validated different-account switch as before.

Cross-tab hints carry no authority. They synchronously hide the old document and
close its local stream/view before navigation. They never call server logout.
A Chromium reproduction caught automatic SSO reconnect in the second tab after
logout; explicit logout hints now navigate to the login marker instead of a bare
reload. Stale logout hints naming another account are ignored.

Chromium with the HTTPS provider fixture (French): A explicitly adds X; two tabs
see A; logout clears both; B sees only X as a candidate, no registered machine or
admin capabilities. Foreign apps/image/backend/launch are denied, admin token is
empty, control WebSocket upgrade refused. Reload remains isolated. Changing the
provider subject during silent revalidation yields `sso_account_changed` without
private data; explicit login restores A and X, with the second tab revalidating
without revoking A's new session. Back navigation/reload preserve isolation.
This exercises the Authentik-equivalent OIDC subject change, not Authentik's own
impersonation UI; final production confirmation still uses the real provider.

Production preflight inspection found the expected single ordinary-user row for
DESKTOP-HRULL7G: not paired, no stored server certificate, own seat identity.
Both administrator/local-owner paired rows remain present. Cleanup will compare
its exact frozen IDs and current state after a full backup.

The six findings of the earlier broader audit remain separate.

Final frontend validation: 1766 tests pass, 93.50% line coverage; Prettier,
ESLint and all three translation catalogs pass. Advisory TypeScript diagnostics
have no additions (135 distinct diagnostics versus 136 on the prior baseline).
C++ cppcheck passes. Full backend integration and exact-commit GitHub gates are
required again for delivery; the earlier Linux launcher-path failures remain
separately identified.

Final review follow-up: a refused SSO request previously read sessionStorage
without a guard, which could leave stale UI visible when storage was blocked.
The failure path now hides the document and revalidates even without storage,
without calling server logout. A regression test covers this fallback; it does
not alter role/session authorization or resolve the six separate audit findings.

Address-refresh regression: a known PC advertised on a different port stayed on
its old address when all discovery replies were treated only as new candidates.
The new HTTPS reproduction failed before correction (old port retained), then
passed. Discovery now refreshes metadata only for an already registered, enabled
PC owned by the caller; it never creates that registration, changes its seat or
pairing, updates a disabled record, or changes native capture. Unknown PCs still
require explicit confirmation. Reviewed the owner/collision and native-host guards.
