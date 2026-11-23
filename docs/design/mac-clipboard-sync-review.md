# Mac clipboard shortcut synchronization

## Confirmed cause and behavior

The deployed Apple keyboard branch explicitly forwarded Ctrl+V as ordinary
remote input. Only Cmd+V armed the native browser paste event, so Ctrl+V pasted
Apollo's previous clipboard. The existing keyboard test asserted that behavior.
Ctrl+C/X similarly bypassed explicit Apollo copy requests: passive polling only
published changes and could miss unchanged text or the first baseline snapshot.

With the Apollo adapter enabled, Mac Ctrl+V now reads the local clipboard within
the keyboard gesture, then uses the existing bounded chunk upload. The backend
still injects paste only after the authenticated Apollo write succeeds. Cmd+V
keeps the native paste-event path. Both Ctrl and Cmd copy/cut shortcuts request
an explicit remote copy, including unchanged text, for delivery to the client.
The legacy local clipboard and non-Apple native paste paths are unchanged.

Local read permission waits are limited to ten seconds. Failure, absent API,
empty/non-text content, or cancellation never forwards a stale paste. Pending
reads are cancelled on focus loss, stream destruction, a new native paste or an
explicit copy. They recheck foreground state and write capability on completion.
Remote clipboard polling/publication pauses during the local read/upload to
avoid overwriting the client's source text. No clipboard text is logged, stored
on disk, read at stream startup, or sent through a new endpoint.

## Review and validation

Before implementation, the new keyboard tests reproduced the missing Ctrl+V
upload and missing explicit Ctrl+C/X requests. Tests now cover Unicode, denied
permissions, missing APIs, empty content, timeouts, concurrent reads, closure,
focus loss, permission changes, stale replies, native paste supersession,
modifier release and key repeat. Existing tests cover remote clipboard writes,
permission refusal/retry, chunk bounds and independent Apollo permissions.

Chromium in French exercised the real Clipboard API with an Apple keyboard
profile and a simulated Apollo channel: Ctrl+V uploads once; Ctrl/Cmd+C/X returns
remote Unicode text to the local clipboard; no held keys remain. Denied reads
show the translated error without sending a paste. This Linux browser fixture
is not a real macOS/Apollo end-to-end validation.

Validation: 1,848 frontend tests; 18 mutually authenticated HTTPS Apollo adapter
scenarios (including write-before-paste, unchanged explicit copy, initial
clipboard preservation, errors, timeouts and session isolation); 822 security
checks; formatting, ESLint and translation checks. TypeScript reports 218
existing diagnostics versus 229 on the base revision, with no new error
signatures. The constructor's explicit callback fields remove its previously
unrecognized Object.assign properties. No C++ behavior changed; the full native
suite and its five known Linux launcher failures were not rerun for this
frontend-only change.

Reviewed keyboard, clipboard transport, focus/disposal and backend permission
interactions. The change does not affect SSO, host ownership, pairing, streaming
parameters or saved input preferences. Browser clipboard permission remains
required for Ctrl+V on Mac. Cmd+V remains available through the native paste
event when permission is refused; remote-to-client writes retain their existing
retry on a pointer gesture if browser policy prevents immediate writing.
