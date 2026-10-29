import { describe, it, expect, vi } from 'vitest';
import { StreamView } from '../js/ui/StreamView.js';
import { PipelineDiag } from '../js/stream/PipelineDiag.js';
import {
    drawVideoFrame,
    DRAW_ACCEPTED,
    DRAW_FAILED,
} from '../js/stream/renderers/VideoRenderer.js';
import { Canvas2DRenderer } from '../js/stream/renderers/Canvas2DRenderer.js';
import { WebGlRenderer } from '../js/stream/renderers/WebGlRenderer.js';
import { WebGpuRenderer } from '../js/stream/renderers/WebGpuRenderer.js';

const settle = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
};

function view(draw) {
    const v = Object.create(StreamView.prototype);
    Object.assign(v, {
        renderRunning: true,
        _renderer: { draw, serialDrawsOnly: true },
        _vsyncGrid: { aimed: false },
        _drawsInFlight: 0,
        frameQueue: [{ close: vi.fn() }],
        stats: { rendered: 0, dropped: 0 },
        _diag: new PipelineDiag(),
        _frameLog: { noteDrawn: () => NaN },
        _clientRenderStats: { addSample: vi.fn() },
    });
    return v;
}

describe('render accounting at the pipeline boundary', () => {
    it('separates complete network frames from decoder submissions, including worker handoff', () => {
        const v = Object.create(StreamView.prototype);
        Object.assign(v, {
            _completeVideoFrames: 0,
            stats: { received: 0, decoded: 0, rendered: 0, dropped: 0 },
            _fatalDecodeError: true,
            _ultraMode: () => false,
            _maxBackendTs: 100,
            decoderConfigured: true,
            _totalBytes: 0,
            _noteLinkArrival: vi.fn(),
            _stallDetector: { note: () => null },
            _firstFrameProcessed: true,
            _useWorker: true,
            _videoWorker: { postMessage: vi.fn() },
            _streamDiagnostics: { lastSample: -Infinity, sample: vi.fn() },
            _diag: new PipelineDiag(),
            _byteRate: { mbps: () => 0 },
        });
        v.handleVideoFrame(new Uint8Array(4), false, 50);
        v._fatalDecodeError = false;
        v.handleVideoFrame(new Uint8Array(4), false, 50); // Received but stale.
        v.handleVideoFrame(new Uint8Array(4), false, 150); // Handed to worker.
        expect(v._videoWorker.postMessage).toHaveBeenCalledOnce();
        expect(v.stats.received).toBe(0); // No worker decoder acknowledgement yet.
        v._sampleStreamDiagnostics();
        expect(v._streamDiagnostics.sample.mock.calls[0][1].counters).toMatchObject({
            received: 3,
            decodeSubmitted: 0,
            dropped: 1,
        });
        v._quitting = true;
        v.handleVideoFrame(new Uint8Array(4), false, 160);
        expect(v._completeVideoFrames).toBe(3);
    });

    it('keeps native media transport counters distinct from JavaScript decoder counters', () => {
        const v = Object.create(StreamView.prototype);
        Object.assign(v, {
            _transport: 'webrtc-media',
            _completeVideoFrames: 0,
            stats: { received: 0 },
            _mediaDiagnosticCounters: { received: 144, decoded: 142, dropped: 2 },
            _streamDiagnostics: { lastSample: -Infinity, sample: vi.fn() },
            _diag: new PipelineDiag(),
        });
        v._sampleStreamDiagnostics();
        expect(v._streamDiagnostics.sample.mock.calls[0][1].counters).toEqual(
            v._mediaDiagnosticCounters,
        );
    });

    it.each([DRAW_ACCEPTED, DRAW_FAILED])('counts only accepted draws: %o', async (result) => {
        const v = view(async () => result);
        v._pumpRender();
        await settle();
        expect(v.stats.rendered).toBe(result.accepted ? 1 : 0);
        expect(v.stats.dropped).toBe(result.accepted ? 0 : 1);
        expect(v._diag.snapshot().dropRender).toBe(result.accepted ? 0 : 1);
        expect(v._drawsInFlight).toBe(0);
    });
    it('closes a frame and releases the guard on an unexpected renderer error', async () => {
        const v = view(async () => {
            throw new Error('GPU gone');
        });
        const f = v.frameQueue[0];
        v._pumpRender();
        await settle();
        expect(f.close).toHaveBeenCalledOnce();
        expect(v.stats).toEqual({ rendered: 0, dropped: 1 });
        expect(v._drawsInFlight).toBe(0);
    });
    it('ignores completion after teardown', async () => {
        let done;
        const v = view(
            () =>
                new Promise((r) => {
                    done = r;
                }),
        );
        v._pumpRender();
        v.renderRunning = false;
        done(DRAW_ACCEPTED);
        await settle();
        expect(v.stats.rendered).toBe(0);
        expect(v._drawsInFlight).toBe(0);
    });
    it.each([Canvas2DRenderer, WebGlRenderer, WebGpuRenderer])(
        'does not count an unavailable renderer %s',
        async (Renderer) => {
            const f = { close: vi.fn() };
            const r = Object.create(Renderer.prototype);
            expect((await drawVideoFrame(r, f)).accepted).toBe(false);
            expect(f.close).toHaveBeenCalledOnce();
        },
    );
});
