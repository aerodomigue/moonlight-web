# Shortcut lifecycle and build identity review

## Confirmed failures

- Keyboard recapture waited for Pointer Lock to finish. A pending pointer grant
  left Escape unprotected; the Escape handler then disabled capture intent.
- Native Chromium can emit `pointerlockchange` before `blur` in a later task.
  The zero-delay loss handler misclassified the window switch as voluntary release.
- Pointer success cleared the shared permission-failure flag, hiding a denied
  keyboard grant. Old asynchronous keyboard requests also needed their own generation.
- On macOS Ctrl+Option incorrectly matched the documented Ctrl+Option+Cmd chord.
  Windows could substitute Meta for Ctrl. Local shortcut key releases leaked to the host.
- The header read only `/api/health.version`: hot frontend deployments kept showing
  the binary's older commit, even with correctly revalidated static files.

## Changes and boundaries

Keyboard capture starts independently of pointer capture. Its grants are fenced
across focus, mode and fullscreen changes. Pointer loss without Escape while
Keyboard Lock is granted preserves intent and requests a gesture rather than
starting a recapture loop. Blur releases remote input; focus attempts recovery.
Explicit M/Z release and browser Escape remain authoritative. Saved preferences
remain unchanged, and standard OS-adjusted Pointer Lock is retained.

Without granted Keyboard Lock (including mouse-only mode), the browser retains
its Escape behavior. Long Escape remains Chromium's escape hatch. A website
cannot guarantee capture without browser permission or a required user gesture.
There is no forced fullscreen re-entry following an external exit.

The loaded UI imports a package-generated source revision, separately from the
server version. `cmake --install ... --component Frontend` stages frontend-only
updates and stamps the actual source HEAD (full hash, eight characters displayed).
Modified trees are labelled. Archives without Git require an explicit full
`MW_SOURCE_REVISION`, otherwise the UI says development rather than guessing.
Archive builds can pass that revision to CMake. Without it, the
checkout is explicitly unidentified; no shortened version is mistaken for a
full source hash. Metadata has no credentials.

## Validation

Deterministic tests first reproduced delayed pointer grants, lost permission
failures, stale focus grants, incomplete shortcut modifiers, unmatched keyups,
and pointer loss before delayed blur. Coverage includes stale promises, permission
refusal, three capture modes, AZERTY/macOS labels, held keys and saved preferences.

The French native Chromium harness uses Xvfb/xdotool and a separate application
window. It verifies real window/tab focus changes, fullscreen round trips,
short Escape forwarding, long Escape exit, M/Z/X and unchanged saved preferences.
Playwright's permanent focus emulation is explicitly avoided using a default
CDP context with `noDefaults`; disabling it on a second CDP session did not undo
Playwright's own override. Streams use a fixture transport, not a production account.

Frontend suites, lint, formatting and translations pass. Type checking is compared
with main (229 existing errors): no new diagnostics. Packaging tests cover clean,
modified, unknown and explicitly supplied revisions, malformed overrides and
refusal to overwrite the source checkout. A local CMake frontend install was verified.

Backend runtime and streaming negotiation are unchanged. Existing Linux backend
launcher-path failures are outside this frontend correction. Final macOS virtual-
desktop behavior still requires a user check; Linux browser tests cannot prove it.
