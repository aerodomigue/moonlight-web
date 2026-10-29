# Clipboard ownership on join and Apple Caps Lock

## Confirmed defects and correction

ApolloClipboard published its first read, including an empty clipboard. That
snapshot now establishes a backend-only baseline without writing to the client.
Later remote changes still propagate. Explicit copy/cut delivers unchanged text
and is not consumed by an older in-flight read. A transient failure retains the
request; a successful client paste supersedes pending reads/copies. No automatic
read/upload of the client clipboard, new endpoint, or authentication change.

Chrome on macOS can emit only CapsLock keydown for enable and only keyup for
disable (Apache Guacamole GUACAMOLE-1823). Forwarding those as held physical keys
lost every second host toggle. Apple transitions now produce complete taps,
deduplicated by modifier state; paired events and repeats do not toggle twice.
State is reset when inputs are released after focus loss. Conventional keyboards,
local dialogs, exclusive capture and shortcut handling keep their existing paths.

The remote initial lock state is still unavailable through GameStream. This fix
does not claim to discover or enforce an arbitrary initial host Caps Lock state.

## Reproduction and review

Before correction: initial nonempty/empty Apollo reads overwrite the client;
four Apple-event regression tests fail. After correction: mutually authenticated
HTTPS fixture covers initial snapshots, subsequent empty/nonempty changes,
explicit identical copies, first-copy-before-baseline, copy during read, transient
failure, client-paste priority, permissions, certificates, timeouts, Unicode,
chunk bounds, disposal and session isolation. Keyboard tests cover Chrome-style,
Firefox-style, paired/repeated events, initial keyup synchronization, focus loss,
local text fields and conventional Windows/Linux press/release.

Reviewed interactions: no clipboard payload or credential in diagnostics; reads
remain foreground-requested and rate limited; no extra polling; paste waits for
Apollo write success; clipboard cancellation prevents stale reads; lock taps leave
no key in the held-input heartbeat; no changes to saved capture preferences,
fullscreen, roles, account ownership or stream authorization.

Validation: 1,829 frontend tests, 18 Apollo HTTPS integration scenarios, 822 security
checks. Backend suite: 17,103/17,108; the same five pre-existing Linux Steam-launcher
checks fail. Frontend formatting/lint/translations and targeted C++ static analysis.
Actual macOS hardware behavior remains to be confirmed by the user after deployment.
