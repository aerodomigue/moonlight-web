# Browser identity renewal: review and validation

Branch: `fix/browser-identity-renewal`, based on main after the secret-field fix (#5).

## Confirmed incident

The public API and signed WebRTC offer named the same server identity. The failing
browser retained a different identity in IndexedDB. Clearing cookies did not clear
that store. `rememberHostIdentity()` refused replacement after PIN sign-in and its
caller ignored the failure. Available deployment backups retained the server key.

## Backend change review

- Only successful PIN authentication and a completed OIDC callback authorize
  renewal; preparing OIDC, linking accounts, restoring a session or unlocking the
  admin page do not. Authorization is bound to the existing browser public key.
- Authorization expires after five minutes, is not serialized, and checks the
  server public key and auth configuration revision on every request. Sessions
  revoked or owned by disabled accounts fail the existing session validation.
- The new user route has explicit session/key checks and inherits the existing
  cross-site/content-type protections. It grants no administrator permissions and
  returns public material only. Success and route errors are not cacheable.
- Identity units cover expiration, revocation, config changes, wrong browser and
  wrong server keys. The real-server OIDC fixture covers PIN, SSO, CSRF, retries,
  unfinished OIDC and persistence across restart. All 15 integration scenarios pass.

## Browser change review

- Host SPKI is parsed as P-256 and its SHA-256 identifier is checked before storage.
  Replacement is enabled only by the caller of the fresh-login renewal route.
- IndexedDB updates compare the browser key and previous host identity in one
  transaction. Concurrent first-use tabs keep the first committed browser key.
  A late response cannot overwrite another newly accepted host identity.
- Stale identity or missing browser key takes the user back to PIN/SSO without
  promoting an ordinary session into a fresh login. SSO errors do not cause a loop.
- Restored legacy sessions wait for the existing network-restricted pairing route;
  recording the host key first no longer accidentally bypasses that registration.
- Both WebRTC implementations refuse a signed offer if the pinned host identity
  is missing. An identity refusal still terminates the transport chain.
- Chromium uses real IndexedDB, non-extractable WebCrypto keys and the HTTPS OIDC
  fixture. It verifies renewal after PIN and SSO, a clean browser, stale restored
  cookie, concurrent tabs, delayed replies, malformed identities and write failure.
- Each WebRTC implementation also negotiates a real browser SDP with a C++-signed
  offer and produces a browser answer verified by C++. Ten hostile variants
  (identity/fingerprint/signature substitution, replay and absent pin) are refused
  before `setRemoteDescription`.

## Validation and delivery gate

Frontend quality and coverage, identity units, all four CTest suites and the real
Chromium scenarios are checked before the final commit. The five Linux Steam-path
expectations are a known baseline, separately checked from new regressions. Merge
requires successful GitHub checks for the final commit. Native deployment retains
PIN, configured SSO, server keys, users, machine registrations, Internet, UPnP and WOL
with a state backup and rollback. The end user's actual video stream is validated
after deployment; synthetic browser negotiation does not establish that result.

## Findings reserved for the subsequent audit

The extended fixture exposed a pre-existing `WebRtcMedia` SDP rewrite failure when
the peer advertises Chrome's RED audio codec: removing FEC mapping lines can leave
an invalid SDP answer. The renewal fixture matches the service's Opus-only offer;
the RED case is kept for a separate regression and fix after deployment, as agreed.
The audit must also examine session persistence failures, local sessionless access,
remaining identity-storage callers, sensitive logging, account-change races and
upgrade/rollback state preservation. These are investigation targets, not all
confirmed vulnerabilities.
