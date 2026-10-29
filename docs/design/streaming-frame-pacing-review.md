# Streaming cadence review — October 2026

## Confirmed defects and changes

1. The video sink returned success-shaped promises even when no image was written
   (backpressure timeout, disposed sink, rejected write). Canvas/WebGL/WebGPU also
   had silent failure returns. Renderers now return an explicit accepted/dropped
   result. Both pipeline consumers count accepted submissions and render drops
   separately; unexpected errors release the frame and the draw guard. Completion
   after teardown does not publish stale counters.
2. Desktop HEVC HDR used the page animation loop to feed a video element already
   paced by the compositor. A 60 Hz page gate discarded high-rate decoded frames
   before the sink could receive them. Video sinks now receive frames on decode,
   retaining serial writes, the existing queue bound and backpressure. Canvas
   VSync, renderer selection and the experimental pacer are unchanged. Native
   cadence stepping must not interpret a video submission as immediate display.
3. The GameStream congestion ladder could replace explicit FPS, resolution and
   bitrate, and force an enhancer the viewer had disabled. Only Auto knobs may
   now change. A fully manual stream reports congestion without a quality relaunch.
   These changes do not persist new user preferences.

Five renderer-result assertions, three high-rate cadence assertions and four
manual-quality assertions failed before their respective fixes and pass afterward.

## Pipeline review and limits

- Negotiation: the VM logs confirm 3840×2160 at 144 FPS in SDR and HDR. HTTPS/RTSP
  fixtures check the actual launch/resume and ANNOUNCE values, including 144 FPS
  with a client display running at 240 Hz. Manual choices bypass the generic Auto
  pixel budget; no new resolution, codec, HDR or bitrate cap was introduced.
- Relay: examined worker delivery, FrameSender queue/fragmentation and pacing,
  SCTP backpressure and IDR gates, and WSS submission. New cumulative counters
  distinguish complete frames delivered to the relay, worker/sender drops,
  transport submissions and buffered bytes. Transport submission is **not** a
  network acknowledgement. Native RTP without those counters reports them absent.
  Existing recovery/queue policies are unchanged pending measurements on the real
  link. In particular, WSS buffering and SCTP recovery remain possible bottlenecks;
  the audit does not claim they cannot stall.
- Decoder: reviewed timestamp matching, reference recovery, queue thresholds and
  worker handoff. The decoded FPS counter is not a presentation counter. New
  diagnostics preserve those distinctions; no speculative decoder reset/queue
  threshold changes were made.
- Presentation: reviewed the main-thread and worker consumers, renderer ownership,
  GPU waits and the video writer. The synthetic tests isolate the extra page gate;
  they do not show that the user's SDR or 4K/HDR hardware bottleneck is solved.
- Concurrent work: clipboard requests remain asynchronous, bounded and serialized;
  share polling still respects its capability. Auth signatures, session isolation,
  input and audio protocols are unchanged. Long-task/event-loop observations help
  attribute future stalls rather than assume a polling or SSO cause.

The opt-in export uses closed allowlists and bounded rings (180 one-second samples,
16384 frame/refresh observations). No frame pixels, clipboard text, host address,
user identity, OAuth material or keys are exported. No callback or observer is
installed for this new capture unless `mw_perf_diag` is enabled. Stop clears its
buffers and cancels observers; an old view cannot clear a newer view's global
handle. Quantile work runs only for an enabled capture, outside the frame path.

`requestVideoFrameCallback` metadata measures submission for composition, not
physical scanout. Missed callbacks do not necessarily mean missing video frames:
use the `presentedFrames` counter, not callback count. See the
[API specification](https://wicg.github.io/video-rvfc/). Canvas submissions are not
renamed as physical presentation. Worker stage p99s use the worker's measurements,
not percentiles calculated from its periodic averages.

## Reproduction and measured results

Deterministic cadence fixtures cover 120/144/240 FPS and a 60/240 Hz page clock.
The canvas control retains its existing VSync policy. A real Chromium harness also
feeds synthetic 960×540 VideoFrames through the production video renderer and
pipeline. In a 4-second 144 FPS run, with the page near 60 Hz:

| Metric | Old page gate | Video sink on decode |
|---|---:|---:|
| Generated frames | 577 | 577 |
| Accepted submissions | 242 | 577 |
| Render queue drops | 335 | 0 |
| Mean decoded-to-draw wait | 10.84 ms | 0.82 ms |

This Linux headless check exercises real browser APIs, not the user's Mac GPU.
Its requested 240 FPS series generated only about 203 FPS; it must not be reported
as a successful 240 FPS end-to-end result. No physical-screen latency was measured.
The deterministic 240 FPS fixture separately verifies the scheduling algorithm.

The user's Mac comparison remains required: identical moving content, resolution,
codec, HDR and bitrate, three 60-second samples after 10 seconds of warm-up for
native Moonlight and Moonlight-Web. Compare 120/144/240 FPS separately. At 144 FPS
on a 240 Hz display, uneven refresh occupancy alone is not a dropped-frame count.
Do not accept an apparent smoothness gain produced by growing latency or reduced
quality. The broad review does not close previously tracked unrelated audit findings.

## Real-client observation before deployment

The supplied Mac trace settles near 103 decoded/submitted FPS, with approximately
9.7 ms between complete frame arrivals, no counted client drops and usually no
decode queue. A transient event-loop stall is visible, but not a continuous render
backlog. The video writer's old `draw 0+0` was an unpopulated split: it now measures
its waits, and a rejected ready promise clears its timeout (two regression tests).

Production negotiated `0x800`, HEVC RExt 4:4:4 10-bit, at 3840×2160/144, HDR on,
150000 kbit/s configured. Relay logs show no growing worker/sender/SCTP drop count
after startup. This narrows the sustained deficit to before browser decoding; it
does **not** establish the host, network or receiver as its cause. A comparison
with only 4:4:4 disabled was requested to isolate profile cost. The user settings
are not changed automatically, and native Moonlight must use the same profile for
a meaningful comparison. The new relay counters will resolve the remaining hop.

## Validation and delivery

Frontend tests cover refusal/teardown/error paths, counters, bounded/private capture,
late callbacks, explicit quality and Auto behavior. Full suites also retain input,
fullscreen, clipboard and authentication/isolation coverage. Backend unit tests
report the same five Linux launcher-path baseline failures. Run permission-failure
integration tests as an unprivileged user: running as root makes chmod-based failure
fixtures invalid. Isolate LAN discovery in a network namespace with loopback only.

Final delivery requires exact-commit GitHub checks, the matching native artifact,
backup of binary/frontend/state and an idle service (activity API, session flags and
worker process checks). Keep the real authentication configuration and pairing/network
state. Real Mac 4K/144 FPS measurements are a post-deployment acceptance check, not
replaced by CI or the synthetic results above.
