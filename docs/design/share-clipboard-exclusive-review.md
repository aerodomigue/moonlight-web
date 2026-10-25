# Sharing, Apollo clipboard and exclusive input review

## Sharing capability and request lifetime

Reproduction: `frontend/test/ShareMenu.test.js` fails six checks on the previous
implementation (unconditional requests, permanent refusal polling, late mount,
overlapping requests). Seven menu checks and 31 board checks now pass. The board also aborts a pending
load on closure and stops polling on permanent refusals.
The HTTPS OIDC integration exercises anonymous, ordinary SSO, SSO administrator,
ordinary PIN and local-owner PIN accounts. Administration does not grant sharing.
The REST authorizer remains authoritative, including checks on the selected host
and the primary stream. A contextual refusal removes the menu.

Review: capability is denied before SSO page activation; no authorization path or
request signature changed. Abort propagates through authenticatedFetch; completion
checks destruction before touching the DOM. A chained timer prevents overlapping
polls, backs off transient errors to 60 seconds, and stops on 401/403/404. Board
close callbacks cannot restart a destroyed menu. Both host-list and stream entry
points require the capability. Backend compilation and frontend check pass.

Performance: the old implementation makes one request every five seconds even
when denied. The new UI makes zero for an unauthorized account. This eliminates
unnecessary signing, network traffic and console errors; it does not yet prove
that those requests caused the reported micro-freezes. Frame timing measurements
and actual Apollo validation are tracked separately from unit-test results.

## Apollo text clipboard

The existing bridge explicitly enables only self-addressed hosts; therefore a
remote Apollo never advertises clipboard capability. The new per-stream adapter
uses Apollo's paired HTTPS API, pins the existing server certificate and presents
the same identitySeat certificate as the stream. No credentials or clipboard
contents are logged. Local QClipboard behavior is preserved.

Review: setup is restricted to unrestricted GameStream sessions; every input and
output rechecks the relay policy and lifecycle. Stop is terminal and immediately
blocks callbacks, with network cleanup on the owning thread. One asynchronous
request at a time, 3-second deadline, no redirects, connection pooling disabled.
Discovery reads Apollo's explicit permission bits; write additionally requires
keyboard input. POST failure never emits a paste chord. Read/write denial disables
that direction. Maximum 256 KiB UTF-8, 4096-byte chunks, strict ordering, bounded
assembly lifetime and completed-ID replay rejection. Paste cancels an outstanding
read so an old read cannot race the newly copied local text. The browser polls
only while focused/visible, at most once per second; only changes are returned.
Copy/cut/paste release local modifiers and use the remote OS modifier.

Validation: ten mutually authenticated HTTPS fixture tests cover certificate
pinning/client rejection, independent permissions, Unicode chunks and replay,
read deduplication/rate limits, delayed requests, unsuccessful writes and stopping
a pending write. Twenty-three browser unit checks include existing macOS modifier
regressions, clipboard permission refusal, foreground gating and oversized text.
Native compilation and frontend formatting/lint/translations pass. Real Apollo
permission configuration and OS clipboard behavior still require deployment tests.


## Exclusive input

The former focus handler restored cursor appearance but never requested Pointer
Lock. Capture selection, intention, suspension, pending permission requests and
browser-granted locks now live in a separate controller. A desktop switch releases
remote keys/buttons, keeps intention, and allows one foreground recovery attempt.
A refusal asks for a gesture; deliberate unlock disables recovery. Generation
checks release stale asynchronous grants and serialize rapid mode changes. All
listeners and pending loss timers are removed at destruction.

Review: keyboard capture is independent of pointer capture and requires native
fullscreen. M toggles/retries the chosen capture; Z releases without exiting
fullscreen, X retains its existing fullscreen action. No raw input path remains.
Video frame floors and held-input watchdog choices no longer depend on capture.
Legacy settings migrate without changing resolution/FPS/bitrate. The REST settings
route validates the new enum and boolean before any write; non-admin denial is
covered by the HTTPS OIDC suite.

Tests exercise all three modes, focus/visibility loss, one-shot recovery, denied
permissions, explicit Escape/unlock, late pointer/keyboard grants, independent
keyboard locking, settings migration and fullscreen preservation. The Chromium
French integration uses real Pointer Lock and clipboard APIs, mounts the actual
stream controls, switches all modes, exercises M and verifies cleanup. Native
Keyboard Lock/OS desktop-switch behavior still needs the user's browser.

## Performance comparison and limits

An identical synthetic 640×360/60 stream in Chromium headless ran for 15.5 seconds
in each condition with a real signed SSO session. The old five-second forbidden
share polling made four requests; the new capability-gated menu made zero. The
video presentation p95 was 16.7/16.8 ms, maximum 16.8/16.8 ms, with zero long tasks
in both conditions (927/929 presentation callbacks). No measurable micro-freeze
was reproduced. This isolates the unnecessary requests but does not establish
that they caused the user's Apollo/4K symptoms.

The adapter's HTTPS fixture verifies the exact paired certificate, no redirect,
bounded requests, explicit oversized response failure, independent permissions,
and cancellation before paste injection. This is distinct from a real Apollo
end-to-end test, and no PC is altered by these fixtures.
