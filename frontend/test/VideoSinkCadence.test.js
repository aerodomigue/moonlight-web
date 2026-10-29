import { afterEach, describe, expect, it, vi } from 'vitest';
import { StreamView } from '../js/ui/StreamView.js';
import { PipelineDiag } from '../js/stream/PipelineDiag.js';
import { DRAW_ACCEPTED } from '../js/stream/renderers/VideoRenderer.js';

afterEach(() => vi.unstubAllGlobals());
async function run({ fps, rafHz, kind }) {
    let animation;
    vi.stubGlobal('requestAnimationFrame', (cb) => {
        animation = cb;
        return 1;
    });
    const v = Object.create(StreamView.prototype);
    Object.assign(v, {
        renderRunning: false,
        _transport: 'webrtc',
        _tearing: false,
        _tvSink: false,
        _renderer: {
            kind,
            serialDrawsOnly: true,
            isContextLost: () => false,
            draw: async (f) => {
                f.close();
                return DRAW_ACCEPTED;
            },
        },
        frameQueue: [],
        _drawsInFlight: 0,
        _vsyncGrid: { aimed: false },
        stats: { rendered: 0, dropped: 0 },
        _diag: new PipelineDiag(),
        _frameLog: { noteDrawn: () => NaN },
        _clientRenderStats: { addSample() {} },
    });
    v.startRenderLoop();
    const events = [];
    for (let n = 0; n < fps; n++) events.push({ t: (n * 1000) / fps, input: true });
    for (let n = 0; n <= rafHz; n++) events.push({ t: (n * 1000) / rafHz + 0.1, input: false });
    events.sort((a, b) => a.t - b.t);
    for (const event of events) {
        if (event.input) {
            v.frameQueue.push({ close: vi.fn() });
            // Same dispatch as onDecodedFrame, with decoding removed from this cadence test.
            if (v._immediateRender) v._pumpRender();
        } else animation(event.t);
        for (let i = 0; i < 8; i++) await Promise.resolve();
    }
    v.stopRenderLoop();
    return v.stats;
}

describe('video sink cadence is independent of page animation cadence', () => {
    it.each([120, 144, 240])('submits %i FPS without an extra 60 Hz page gate', async (fps) => {
        const stats = await run({ fps, rafHz: 60, kind: 'video-element' });
        expect(stats.rendered).toBe(fps);
        expect(stats.dropped).toBe(0);
    });
    it('preserves all 144 submissions on the 240 Hz reference display', async () => {
        expect((await run({ fps: 144, rafHz: 240, kind: 'video-element' })).rendered).toBe(144);
    });
    it('keeps the existing VSync policy for a canvas', async () => {
        const stats = await run({ fps: 144, rafHz: 60, kind: 'canvas2d' });
        expect(stats.rendered).toBeLessThanOrEqual(61);
        expect(stats.dropped).toBeGreaterThan(0);
    });
});
