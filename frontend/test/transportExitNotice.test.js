/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { describe, it, expect, vi } from 'vitest';
import { WebRtcDataChannel } from '../js/api/WebRtcDataChannel.js';
import { WebRtcMedia } from '../js/api/WebRtcMedia.js';

/**
 * Exit notices ("takeover" / "revoked") are sent by the backend relays
 * (DataChannelRelay / MediaTrackRelay, `sendExitNotice`) as JSON on the input
 * DataChannel, just before the relay closes it. StreamView wires onTakeover and
 * onRevoked unconditionally, so BOTH transports must route them — webrtc-media
 * used to drop them on the floor, leaving no graceful exit in that mode.
 */

// Minimal stand-in for an RTCDataChannel: _setupDataChannel only assigns the
// event handlers, so capturing `onmessage` is enough to drive it.
function fakeDc() {
    return { binaryType: '', onopen: null, onclose: null, onerror: null, onmessage: null };
}

/** Wire a transport's input channel and return a `send(msg)` driver. */
function inputChannel(transport, label) {
    const dc = fakeDc();
    transport._setupDataChannel(label, dc);
    return (obj) => dc.onmessage({ data: JSON.stringify(obj) });
}

describe.each([
    ['WebRtcDataChannel', () => new WebRtcDataChannel('ws://test.invalid'), 'input'],
    ['WebRtcMedia', () => new WebRtcMedia('ws://test.invalid'), 'input'],
])('%s — input DC exit notices', (_name, make, label) => {
    it('invokes onTakeover for a takeover message', () => {
        const t = make();
        const onTakeover = vi.fn();
        t.onTakeover = onTakeover;
        inputChannel(t, label)({ type: 'takeover' });
        expect(onTakeover).toHaveBeenCalledTimes(1);
    });

    it('invokes onRevoked for a revoked message', () => {
        const t = make();
        const onRevoked = vi.fn();
        t.onRevoked = onRevoked;
        inputChannel(t, label)({ type: 'revoked' });
        expect(onRevoked).toHaveBeenCalledTimes(1);
    });

    it('does not confuse the two, and still routes stats', () => {
        const t = make();
        t.onTakeover = vi.fn();
        t.onRevoked = vi.fn();
        t.onStats = vi.fn();
        const send = inputChannel(t, label);

        send({ type: 'stats', fps: 60 });
        expect(t.onStats).toHaveBeenCalledWith({ type: 'stats', fps: 60 });
        expect(t.onTakeover).not.toHaveBeenCalled();
        expect(t.onRevoked).not.toHaveBeenCalled();

        send({ type: 'takeover' });
        expect(t.onRevoked).not.toHaveBeenCalled();
    });

    // Sent on a graceful host termination (the app was closed on the host), so
    // StreamView exits cleanly instead of toasting a connection error.
    it('invokes onHostEnded for a host-ended message', () => {
        const t = make();
        t.onHostEnded = vi.fn();
        t.onSessionEnded = vi.fn();
        inputChannel(t, label)({ type: 'host-ended' });
        expect(t.onHostEnded).toHaveBeenCalledTimes(1);
        expect(t.onSessionEnded).not.toHaveBeenCalled();
    });

    it('tolerates an exit notice with no handler attached', () => {
        const t = make();
        const send = inputChannel(t, label);
        expect(() => send({ type: 'takeover' })).not.toThrow();
        expect(() => send({ type: 'revoked' })).not.toThrow();
        expect(() => send({ type: 'host-ended' })).not.toThrow();
    });
});

describe.each(['webrtc-dc', 'webrtc-media', 'wss', 'fallback-wss'])(
    '%s clipboard channel lifetime',
    (mode) => {
        it('forwards clipboard capabilities, chunks and errors only while active', () => {
            const t =
                mode === 'webrtc-media'
                    ? new WebRtcMedia('wss://fixture.invalid')
                    : new WebRtcDataChannel('wss://fixture.invalid');
            t.onStats = vi.fn();
            const receive =
                mode === 'wss'
                    ? (obj) => t._onWssMessage({ data: JSON.stringify(obj) })
                    : mode === 'fallback-wss'
                      ? (obj) => t._onWsFallbackMessage({ data: JSON.stringify(obj) })
                      : inputChannel(t, 'input');
            const messages = [
                { type: 'clipboardcaps', remote: true, read: true, write: true },
                { type: 'clipboardchunk', id: 'copy', index: 0, total: 1, data: 'aGk=' },
                { type: 'clipboarderror', code: 'write_failed' },
            ];
            for (const message of messages) receive(message);
            expect(t.onStats.mock.calls.map(([m]) => m)).toEqual(messages);
            t._stopping = true;
            receive(messages[1]);
            expect(t.onStats).toHaveBeenCalledTimes(3);
        });
    },
);

it('honors revocation through signaling WSS fallback', () => {
    const t = new WebRtcDataChannel('wss://fixture.invalid');
    t.onRevoked = vi.fn();
    t._onWsFallbackMessage({ data: JSON.stringify({ type: 'revoked' }) });
    expect(t.onRevoked).toHaveBeenCalledOnce();
});
