import { describe, it, expect, vi, afterEach } from 'vitest';
import { StreamDiagnostics, numericFields } from '../js/stream/StreamDiagnostics.js';

afterEach(() => vi.unstubAllGlobals());
function setup() {
    let raf, rvfc;
    vi.stubGlobal(
        'requestAnimationFrame',
        vi.fn((cb) => {
            raf = cb;
            return 7;
        }),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const video = {
        requestVideoFrameCallback: vi.fn((cb) => {
            rvfc = cb;
            return 8;
        }),
        cancelVideoFrameCallback: vi.fn(),
    };
    const diag = new StreamDiagnostics(video);
    return {
        diag,
        video,
        raf: (t) => raf(t),
        present: (t, n) =>
            rvfc(t, { presentedFrames: n, presentationTime: t, expectedDisplayTime: t + 4 }),
    };
}
describe('opt-in bounded streaming diagnostics', () => {
    it('exports only allowed numeric data, never a host, token or payload', () => {
        const { diag } = setup();
        diag.sample(diag.start, {
            counters: { received: 42, token: 'SECRET' },
            backend: { submitted: 39, secret: 'SECRET' },
            renderer: 'SECRET',
            host: 'SECRET',
            latency: { decodeP99: 7, password: 'SECRET' },
        });
        const result = diag.export();
        expect(JSON.stringify(result)).not.toContain('SECRET');
        expect(result.samples[0].counters).toEqual({ received: 42 });
        expect(result.samples[0].latency).toEqual({ decodeP99: 7 });
        expect(numericFields({ received: Infinity }, ['received'])).toEqual({});
        diag.stop();
    });
    it('keeps at most 180 one-second snapshots in order, and exports copies', () => {
        const { diag } = setup();
        diag.start = 0;
        for (let i = 0; i < 300; i++) {
            diag.sample(diag.start + i * 1000, { counters: { received: i } });
            diag.sample(diag.start + i * 1000 + 1, { counters: { received: 999 } });
        }
        const result = diag.export();
        expect(result.samples).toHaveLength(180);
        expect(result.samples[0].counters.received).toBe(120);
        expect(result.samples[179].counters.received).toBe(299);
        result.samples[0].counters.received = -1;
        expect(diag.export().samples[0].counters.received).toBe(120);
        diag.stop();
    });
    it('counts composition metadata, not callbacks, and bounds frame observations', () => {
        const { diag, present, raf } = setup();
        present(10, 1);
        present(20, 4);
        expect(diag.composed).toBe(4);
        expect(diag.callbackGaps).toBe(2);
        for (let i = 0; i < 17000; i++) {
            raf(i * 4);
            present(30 + i * 4, 5 + i);
        }
        expect(diag.export().videoFrames).toHaveLength(16384);
        expect(diag.export().refreshIntervalsMs.p50).toBe(4);
        diag.stop();
    });
    it('cancels observers and ignores late callbacks after stream/session teardown', () => {
        const { diag, video, present, raf } = setup();
        diag.stop();
        present(10, 1);
        raf(10);
        diag.sample(1000, {});
        expect(video.cancelVideoFrameCallback).toHaveBeenCalledWith(8);
        expect(cancelAnimationFrame).toHaveBeenCalledWith(7);
        expect(diag.export().samples).toEqual([]);
        expect(diag.export().videoFrames).toEqual([]);
        expect(video.requestVideoFrameCallback).toHaveBeenCalledTimes(1);
    });
});
