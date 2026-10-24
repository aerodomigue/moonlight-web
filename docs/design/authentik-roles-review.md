# Authentik role authorization review

## Scope and decisions

The signed ID token is the only source of an SSO role. `internal_admin` grants
administrator status; `internal_user`, absent claims and all unexpected JSON
values grant ordinary access. Signature, issuer, audience, nonce and time checks
precede role extraction. No email matching or UserInfo/header role input is used.
Legacy subject lists and local role assignments cannot grant SSO administration.

Local and verified SSO roles are stored separately in user-store version 3. IDs,
registrations and pairing material are unchanged. A role/configuration revision
invalidates previous sessions durably, including when a subsequent session-file
write fails. Existing sessions have no inferred SSO administrator proof. Each
fresh administrator SSO session records its own configuration-bound proof.

Account role, session administrator access and PIN password-unlock eligibility
are separate decisions. REST guards, administrator-token issuance and control
WebSockets consume those decisions. Demotion uses existing session-specific
teardown; other accounts retain their connections. The protected owner's PIN
recovery is explicit and cannot elevate its SSO session. IdP demotion is not
blocked by the last-administrator guard used for local administrative edits.

Scopes are private managed configuration, included in its signature. Editing
OIDC parameters cancels pending transactions and revokes obsolete linked
sessions. Disabling PIN requires a verified SSO administrator for the exact
configuration. Secret replacement/clearing and atomic 0600 persistence retain
their existing behavior.

## Incremental reproductions and review

- Configuration tests first reproduced three missing-scope failures. Persistence,
  signature changes and secret preservation passed after the first change.
- Session tests reproduced PIN direct-administration and legacy subject-list
  elevation. The verified-role implementation rejects both paths.
- Review checked callback/link ordering, exception boundaries, restored sessions,
  manual role edits, owner recovery, last-admin loss and configuration switches.
- A disabled administrator was incorrectly displayed as an ordinary local user.
  The HTTP reproduction failed before separating assigned role from availability;
  the regression now preserves that role without granting disabled access.
- Chromium/frontend tests exposed hostname-based administration rendering after
  a backend denial. Loaded backend authorization now wins, including loopback
  URLs and failed authorization refreshes. The backend already refused access.
- UI role controls omit synchronized roles from writes. The backend independently
  rejects local attempts to replace them. Translations explain ID-token roles
  and do not present discovery testing as secret/role verification.

## Local validation

- Frontend: 1,655 tests passed, 159 files; scoped line coverage 93.4%.
- Backend full Linux run: 16,962/16,967 checks. Only the five pre-existing Windows
  Steam-path assertions in `test_launcher_detect.cpp:54–58` fail on Linux.
- Four CTest suites passed, including the real HTTPS OIDC integration (23 cases),
  native-host checks and cryptographic security tests.
- Integration covers strict role mapping, missing/malformed claims, PIN password
  boundary, REST/token/control-WS denial, CSRF, promotion/demotion, restored
  sessions, scoped WS teardown, failed persistence, disabled users, confirmed
  linking, owner recovery and last SSO administrator demotion.
- Token tests explicitly reject replacing the signed user claim with an unsigned
  administrator claim. Provider-switch and legacy-session tests remain covered.
- Real Chromium in French: SSO admin console without password; same account via
  PIN with password; ordinary account without Admin button or direct access;
  scopes and read-only Authentik source. No uncaught browser errors.
- PR #6 identity renewal remains tested in Chromium: PIN/SSO renewal, retained
  browser private key, restored cookies, concurrent tabs, failed IndexedDB writes,
  both WebRTC transports and ten hostile offers rejected before negotiation.
- Frontend formatting/lint, translations and C++ formatting are checked locally.
  Full cppcheck and final GitHub checks gate the merge.

## Release boundaries

Deploy the successful final GitHub Linux bundle natively with a stopped-service
state backup and rollback of both binary and state. Retain PIN, configured SSO
and secret, identities/pairings, Internet, UPnP and WOL. Test the deployed PIN
path and run the HTTPS fixture as the service user before switching binaries.
The real Authentik administrator and ordinary user must sign in again to finish
provider-specific acceptance; fixture success alone is not that acceptance.

The six findings tracked separately in draft PR #7 remain open. This feature
neither merges that audit branch nor declares those findings fixed.
