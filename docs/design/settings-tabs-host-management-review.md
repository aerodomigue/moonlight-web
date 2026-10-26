# Settings tabs and host registration management: review

Branch: `feat/settings-tabs-host-management`, based on main `a5db3c2d`.

## Changes and review boundaries

- Tab navigation moves existing controls instead of rendering forms again. Unsaved
  OIDC values stay in memory, without a browser storage entry. Personal defaults
  still belong to Settings; stream shortcuts and fullscreen code are unchanged.
- Users are searchable. SSO-only mode hides local creation/PIN generation. Existing
  Authentik role authority, recovery owner, linking and deletion checks remain.
  Returning from verified account linking selects Users so confirmation is visible.
- PCs have their own administrator view and an explicit safe list representation.
  Existing move/clone/delete operations retain their pairing/collision rules.
  Counts refresh without destroying an edited user form. List refresh responses
  are revision-checked, and closing a confirmation after destruction cannot mutate.
- Activation is stored per registration, defaults true for old records, and is not
  overwritten by discovery. Copies retain it. Native capture cannot be disabled.
- Functional user host routes check activation before dispatch. Stream WebSockets
  check the slot's registration; guest launches already acquire the same host
  lease, which now refuses disabled registrations. Other accounts remain isolated.
- Every in-flight functional host request retains a shared operation marker through
  its asynchronous HTTP response. Unlike the existing exclusive owner lease, this
  marker does not prohibit reads by different owners. Administrative operations
  check the physical PC for markers, launch leases, pairing and stream workers.
- Persistence failures restore both the host field and Qt's pending settings cache,
  preventing a failed enable operation from being replayed on subsequent flush.

## Validation

- Targeted frontend tests and diff review before each feature commit.
- Full frontend suite: 1,737 tests passed before the two final count/activation tests;
  final exact-source suite is also required by GitHub CI. Coverage: 93.63% lines.
- Backend unit checks: 17,076 / 17,081 passed. The five failures are the pre-existing
  Windows Steam path expectations in `test_launcher_detect.cpp` on Linux.
- OIDC/administration HTTPS integration: 44 scenarios passed, including new host
  activation, persistence, write-failure rollback, clone/transfer isolation, access
  denial, rediscovery and concurrent asynchronous operations.
- Five additional CTest suites passed: security, Apollo clipboard, stream negotiation,
  native host and licence boundary. C++ formatting and targeted cppcheck passed.
- French Chromium desktop/mobile: tabs, draft retention, SSO-only actions, user
  creation/search, owner-filtered PC navigation, native app confirmation and capture
  settings verified. Screenshots inspected. A populated PC card uses a controlled
  list fixture; real mutations and persisted pairing are tested by the HTTPS suite.
- Chromium identity renewal, Authentik roles, PIN password unlock and SSO lifecycle
  passed against the isolated HTTPS provider. This does not replace a real Apollo
  stream or a real Authentik login after deployment.

## Delivery

Merge only after GitHub checks on the exact final revision. Deploy a native Linux
bundle with full application/state backup and rollback, only with no active stream.
Preserve the currently configured authentication modes, secrets, identities, pairings,
Internet, UPnP and WOL. Existing audit findings are not marked resolved by this work.
