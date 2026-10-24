# SSO session lifecycle and request possession review

## Existing behavior reproduced

The previous native GitHub bundle (`cfc843ff`, merged by PR #8) accepted a copied
SSO cookie in a fresh browser context. The new cookie-copy integration regression
fails against that exact bundle (`authenticated: true`) and passes against this
change. This is an isolated reproduction, not evidence of an incident in production.

The existing Code + PKCE flow, token verification, role mapping and MW-BIND keys
are retained. OIDC Core, Back-Channel Logout 1.0, RFC 9421 and RFC 9530 define the
new lifecycle, logout token validation and request signatures. Upstream OAuth
credentials/tokens never reach browser code.

## Authorization and persistence review

- Runtime SSO authority is separate from the disk cookie record. Restoring that
  record or its old admin flag cannot authenticate a request after restart.
- SSO expires absolutely after eight hours. A one-second purge timer emits the
  existing scoped session-destroyed signal to close sockets and stream workers.
  PIN sessions and local recovery retain their independent policy.
- No account data, host identity, PIN or admin key is returned by unsigned SSO
  status requests. Signatures are checked before privilege assignment, inline
  routes and request-body transformations. The original encoded target, method
  and body bytes are preserved by the HTTP parser.
- The fixed signature profile covers method/path/query, body digest, session and
  page identifiers, created/expires, key identifier, nonce, algorithm and purpose.
  Only the session-bound P-256 key is trusted. Nonces are bounded, session-scoped
  and replay-checked. Page names are namespaced by session, avoiding collisions
  between accounts. Authority is issued by the backend after OIDC, never by a
  browser storage flag.
- Page activation is one use/30 seconds; WS tickets are one use/10 seconds and
  bind the requested path and session/page. Invalid tickets are denied before
  owner-channel authorization. The consumed credential is stripped before the
  internal WS server; only the fixed negotiated subprotocol is forwarded.
- Browser requests, downloads, private covers, diagnostics and manifest requests
  use the signed fetch adapter. Cover blobs have bounded caching and object-URL
  cleanup. PIN fetch behavior is unchanged.
- Private keys remain non-exportable. Possession checks do not claim to protect
  an already compromised browser or stolen identity-provider credentials.

## OIDC and logout race review

- A closed return-path allowlist preserves Admin/session screens and link outcomes
  across silent checks; external and arbitrary redirect targets are refused.
- Every transaction has its own state cookie; completed callbacks clear it using
  separate Set-Cookie fields. A pending transaction cannot overwrite another tab.
- An unchanged revalidation retains the active cookie and grants a new document.
  Concurrent initial callbacks coalesce only for the same verified account,
  browser key, provider session and configuration, using a bounded 30-second
  in-memory result cache. The raw cookie is held only in this short-lived cache; it is never written to disk or logs.
- A provider account switch during silent verification is refused before creating
  another local account. Explicit login remains the account-switch path.
- Logout and ID tokens use separate claim validation over shared signature
  verification. Nonce-bearing ID tokens cannot trigger logout; logout tokens
  cannot authenticate a browser. Unknown keys/issuers/audiences, bad events,
  malformed subjects/session IDs, stale/future dates and tampering are rejected.
- Signed logout events record a revocation cutoff to reject an in-flight old
  token exchange. The verified ID-token issue time distinguishes a newer login
  from an older repeated logout, including after backend restart. SID and subject
  targeting preserves other accounts and PIN sessions.
- Persistence failure returns 503 and blocks the affected runtime session; the
  notification is not acknowledged as successfully persisted. Restored SSO
  records always need OIDC, preventing resurrection of authority after restart.
- SSO-only mode requires a live verified SSO administrator, not a disk role proof.
  Provider/scopes/secret edits invalidate pending transactions and obsolete proofs.

## Validation

- 293 targeted identity/token/signature/context checks passed before final review.
- 33 real-server HTTPS OIDC integration cases include copied cookies and wrong
  keys, request replay/tampering, concurrent transactions, unchanged revalidation,
  notifications during token exchange, notification targeting and replay after
  restart, failed persistence and local-owner/PIN recovery.
- Full backend Linux reference: 17,003/17,008; only the five pre-existing Windows
  Steam-path assertions fail. Final CI/backend counts are recorded in the PR.
- Frontend reference: 1,659 tests in 160 files, scoped line coverage 93.4%.
- Chromium in French covers fresh OIDC on reload/history, retained keys and other
  page authority, cookie-copy refusal, successful subprotocol negotiation, scoped
  WS shutdown, provider logout/discovery outage and no redirect loop/PIN fallback.
- PR #6 remains covered: stale identity renewal after PIN/SSO, storage failures,
  concurrent keys, both stream binding implementations and ten hostile offers.
- Formatting/lint/i18n and all four CTest targets passed. Local cppcheck reports
  only two unchanged `LogArchive` copy-management warnings, reproduced on main;
  no changed-file warning. The GitHub analyzer is still required.
- A parallel stress run also hit seven feed-IPC timing assertions; an isolated
  rerun passed all of those and retained only the five documented Linux failures.
  Final GitHub checks are required before merge. No workflows are modified.

## Release boundary

Ship the exact successful Linux artifact after checking its digest and equality
with the merged source tree. Test it as the service user on 10.2.10.105 before
switching binaries; archive binary/state and retain rollback instructions. Keep
PIN, SSO/secret, pairing/signing keys, WOL, Internet and UPnP.

The user configures the provider back-channel URI and the exact proxy POST
exception. Real notification delivery must be validated through that proxy and
with an active stream; fixture success does not establish this installation step.
The six earlier audit findings remain separate and are not declared fixed by
this feature, including their generic PIN/storage-failure paths.

## Primary references

- [OIDC Core](https://openid.net/specs/openid-connect-core-1_0.html)
- [Back-Channel Logout](https://openid.net/specs/openid-connect-backchannel-1_0.html)
- [HTTP Message Signatures](https://www.rfc-editor.org/rfc/rfc9421.html)
- [Authentik logout configuration](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/frontchannel_and_backchannel_logout/)
