# Effective stream dimensions after client limits

The resolution reported by the user was 1920×1080 at 120 FPS on a 4K/240 Hz
screen. Browser diagnostics confirmed correct screen detection, with both
resolution and FPS set to Auto. The existing 120 FPS ceiling and 250 Mpixel/s
budget deliberately produce 1080p120. The user confirmed that “Match my screen”
works and requested changes only for an actual Auto bug. These policies remain
unchanged.

A separate correctness defect was reproduced in the full Chromium application:
`launchApp` resolved the frame, applied the pixel budget and decoder limit, then
restored the original aspect ratio. On a 5120×2160 screen with a decoder accepting
1920×1080 at most, the request became height 1080 with aspect `5120:2160`.
The backend derives 2560×1080 from that pair, exceeding the accepted width.
The console also reported the original 2160-line request after reducing it.

The correction retains `bounded.aspect`, already selected by the existing limit
function, and logs the height and aspect actually passed to `/start`. The size
policy, decoder probing, FPS, manual bitrate, screen following, native capture
and all authentication/ownership rules are unchanged.

## Regression test and review

The new browser runner uses the existing temporary HTTPS OIDC/PIN fixture and
ordinary accounts. It selects settings in the French UI, reloads to verify their
persistence, then calls the initialized application through its exact versioned
module. `/start` is intercepted before reaching a host. No real PC is launched,
cancelled, captured or powered on/off. Only the decoder capability response is
controlled for the limit case; this is not a decoder performance benchmark.

Cases cover:

- The existing Auto budget on a 4K/240 Hz client, still requesting 1080p120.
- An ultrawide client constrained to 1920×1080, preserving the accepted aspect.
- “Match my screen” with fixed FPS, keeping the requested 4K frame.
- Auto resolution with fixed FPS, preserving the existing 4K request.

Each checks the API request, manual 100 Mbit/s setting and effective-resolution
console message. The old code fails the ultrawide assertion (`5120:2160` instead
of `1920:1080`). Review also checks that native box semantics and session-only
degradation overrides remain applied before logging.

Run from the repository root:

```sh
MW_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
  python3 backend/tests/run_stream_preferences_browser.py build/MoonlightWeb
```

Frontend tests, translations and the existing backend CTest integration suite
are run separately. GitHub must validate the final commit before merging.
