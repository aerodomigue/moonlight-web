# Dashboard discovery, menus and sign-out review

Branch: `fix/dashboard-discovery-login`, from main `6669150d`.

## Review boundaries

- Discovery preference uses the existing copy-before-commit user store; format 4
  reads legacy versions 1–3 and preserves IDs, roles, enabled state and identities.
  Null/absent preference derives from enabled registrations, never reachability.
  Explicit false survives identity synchronization and process restart.
- Only exact GET/POST discovery paths bypass the per-host UUID lookup. Existing
  HTTP authentication, CSRF, SSO proof and account activation checks still apply.
- Scan authorization is checked before querying and again before adding a result.
  Cancellation increments an account generation, so disable/re-enable cannot
  resurrect a delayed serverinfo response. Other owners keep their shared mDNS
  window. Cancelling the last owner releases the socket; a fresh activation can
  reopen it despite the scan cooldown. Existing PC polling is unchanged.
- Frontend waits for server authority, serializes discovery requests and discards
  replies after stop/destroy. There is no new periodic discovery timer.
- Card decoration alone is clipped. The open card is raised, and the menu is
  bounded/repositioned on resize and scroll. List refresh stability and keyboard
  dismissal remain intact; viewport listeners are removed on destruction.
- Chromium reproduced the no-op path when the native logout dialog is suppressed
  or dismissed. This does not prove which condition occurred in the user's browser.
  Sign-out now uses the existing in-app confirmation. Revocation failures retain a
  retry path; successful logout clears private app/history caches and in-memory
  SSO authority, then reloads a method-aware login page. Streaming preferences and
  IndexedDB browser keys are retained. Competing expired requests cannot force a
  reload during the logout call.
- The explicit-logout URL marker grants no authority and bypasses only automatic
  OIDC navigation. Protected requests still require validated page activation.
  Provider-wide logout is intentionally outside this change.

## Evidence

- Discovery regression initially failed all five frontend cases, then passed.
- HTTPS integration covers account defaults, durable choices, second browser,
  copied-cookie refusal and write failures; a local unicast mDNS fixture delays
  serverinfo until cancellation and verifies that only the other owner adds it.
- Chromium French desktop/mobile: menus overflow short cards and remain clickable;
  in-app sign-out, SSO-only landing, no remember checkbox, reload with sessionStorage
  unavailable, and explicit reconnect all passed.
- Full suites, exact-commit GitHub checks and native artifact validation are required
  before deployment. Five known Linux Steam-path unit failures remain separate.
- The six earlier audit findings are not declared resolved by this change.

Final local validation before the re-entry regression: 1,750 frontend tests passed (93.59% line coverage), 47
HTTPS integration scenarios passed, and all three authentication-mode browser
scenarios passed. Backend serial run: 17,083/17,088 checks; only the five known
Linux Steam-path failures. A concurrent run also failed seven assertions in the
IPC frame-delivery fixture; its isolated rerun passed, and no IPC code changed.
Prettier, ESLint, translations (1,167 keys / three locales) and C++ formatting pass.
Advisory TypeScript comparison: 136 distinct diagnostics before and after, none new.

Final review also caught a quick leave/return during preference loading: the old
request was discarded but the new dashboard could remain uninitialized. A targeted
regression now verifies a fresh authority read without executing the obsolete scan.
The bounded menu's own scroll events are excluded from viewport repositioning:
resetting its height during an internal scroll could otherwise move the scroll
position. A regression covers internal scroll versus window resize.
