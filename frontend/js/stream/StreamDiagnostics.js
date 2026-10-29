// Opt-in, bounded numeric diagnostics. No host, user, URL, token or image data.
const LIMIT = 180;
const FRAME_LIMIT = 16384;
const COUNTERS = ['received', 'decoded', 'rendered', 'dropped', 'networkLost', 'recoveries'];
const BACKEND = [
    'relayReceived',
    'submitted',
    'workerDrops',
    'senderQueueDrops',
    'bpDrops',
    'pendingFrames',
    'bufferedBytes',
    'sendWaitUs',
];

export function numericFields(source, keys) {
    const result = {};
    for (const key of keys) if (Number.isFinite(source?.[key])) result[key] = source[key];
    return result;
}

class Ring {
    constructor(limit) {
        this.limit = limit;
        this.items = [];
        this.next = 0;
    }
    push(item) {
        this.items[this.next] = item;
        this.next = (this.next + 1) % this.limit;
    }
    values() {
        return this.items.length < this.limit
            ? [...this.items]
            : [...this.items.slice(this.next), ...this.items.slice(0, this.next)];
    }
    clear() {
        this.items.length = 0;
        this.next = 0;
    }
}

export function intervalSummary(samples) {
    if (!samples.length) return null;
    const sorted = [...samples].sort((a, b) => a - b);
    const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    return {
        n: sorted.length,
        p50: percentile(0.5),
        p95: percentile(0.95),
        p99: percentile(0.99),
        max: sorted[sorted.length - 1],
    };
}

export class StreamDiagnostics {
    constructor(video) {
        this.video = video;
        this.samples = new Ring(LIMIT);
        this.videoFrames = new Ring(FRAME_LIMIT);
        this.refreshIntervals = new Ring(FRAME_LIMIT);
        this.lastSample = -Infinity;
        this.stopped = false;
        this.composed = null;
        this.callbackGaps = 0;
        this.lastRefresh = null;
        this.raf = null;
        this.rvfc = null;
        this.start = performance.now();
        const tick = (now) => {
            if (this.stopped) return;
            if (this.lastRefresh !== null && now > this.lastRefresh)
                this.refreshIntervals.push(now - this.lastRefresh);
            this.lastRefresh = now;
            this.raf = requestAnimationFrame(tick);
        };
        this.raf = requestAnimationFrame(tick);
        if (typeof video?.requestVideoFrameCallback === 'function') {
            const presented = (now, meta) => {
                if (this.stopped) return;
                if (Number.isFinite(meta.presentedFrames)) {
                    if (this.composed !== null)
                        this.callbackGaps += Math.max(0, meta.presentedFrames - this.composed - 1);
                    this.composed = meta.presentedFrames;
                    this.videoFrames.push(
                        numericFields({ timeMs: now - this.start, ...meta }, [
                            'timeMs',
                            'presentedFrames',
                            'presentationTime',
                            'expectedDisplayTime',
                        ]),
                    );
                }
                this.rvfc = video.requestVideoFrameCallback(presented);
            };
            this.rvfc = video.requestVideoFrameCallback(presented);
        }
    }

    sample(now, data) {
        if (this.stopped || now - this.lastSample < 1000) return;
        this.lastSample = now;
        /** @type {Record<string, unknown>} */
        const sample = {
            timeMs: now - this.start,
            counters: numericFields(data.counters, COUNTERS),
            backend: numericFields(data.backend, BACKEND),
            requestedFps: Number.isFinite(data.requestedFps) ? data.requestedFps : null,
            ...numericFields(data, ['width', 'height', 'bitrateMbps']),
            codec: ['h264', 'hevc', 'av1', 'auto'].includes(data.codec) ? data.codec : 'unknown',
            composed: this.composed,
            callbackGaps: this.callbackGaps,
            fullscreen: data.fullscreen === true,
            visible: data.visible === true,
        };
        // Closed allowlists: future auth/host fields cannot leak into the export.
        sample.pipeline = numericFields(data.pipeline, [
            'arrivalAvgMs',
            'arrivalP50Ms',
            'arrivalP95Ms',
            'arrivalP99Ms',
            'arrivalMaxMs',
            'decodeQueueAvg',
            'decodeQueueMax',
            'frameQueueAvg',
            'frameQueueMax',
            'renderSubmitMs',
            'renderWaitMs',
            'dropStale',
            'dropQueueFull',
            'dropBackpressure',
            'dropRender',
            'recoverIdr',
            'recoverFlush',
            'recoverReset',
        ]);
        sample.mainThread = numericFields(data.mainThread, [
            'loopLagAvgMs',
            'loopLagMaxMs',
            'longTasks',
            'longTaskMaxMs',
            'inputsPerSec',
            'inputMsPerSec',
        ]);
        sample.latency = numericFields(data.latency, [
            'decodeP50',
            'decodeP95',
            'decodeP99',
            'queueP50',
            'queueP95',
            'queueP99',
            'renderP50',
            'renderP95',
            'renderP99',
        ]);
        sample.renderer = ['canvas2d', 'webgl', 'webgpu', 'video-element'].includes(data.renderer)
            ? data.renderer
            : 'unknown';
        sample.transport = ['webrtc', 'websocket', 'webrtc-media'].includes(data.transport)
            ? data.transport
            : 'unknown';
        sample.hdr = data.hdr === true;
        sample.worker = data.worker === true;
        this.samples.push(sample);
    }

    export() {
        return JSON.parse(
            JSON.stringify({
                version: 1,
                semantics: {
                    rendered: 'accepted by renderer, not physical display',
                    composed: 'video frames submitted for composition (rVFC), not physical display',
                    backend:
                        'relay complete frames and transport submissions, not delivery acknowledgements',
                    callbackGaps: 'composition callbacks missed, not necessarily dropped images',
                },
                samples: this.samples.values(),
                refreshIntervalsMs: intervalSummary(this.refreshIntervals.values()),
                videoFrames: this.videoFrames.values(),
            }),
        );
    }

    stop() {
        this.stopped = true;
        if (this.raf !== null) cancelAnimationFrame(this.raf);
        if (this.rvfc !== null) this.video?.cancelVideoFrameCallback?.(this.rvfc);
        this.video = null;
        this.samples.clear();
        this.videoFrames.clear();
        this.refreshIntervals.clear();
    }
}
