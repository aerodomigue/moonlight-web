/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { describe, it, expect } from 'vitest';
import { forceOpusStereo, stripVideoFec } from '../js/util/SdpUtils.js';

// Minimal Chrome-style answer: CRLF line endings, Opus PT=111, default fmtp
// (minptime + useinbandfec, NO stereo — the exact case that triggers the mono
// decoder and the ~-6 dB downmix).
const CHROME_ANSWER = [
    'v=0',
    'o=- 123 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 minptime=10;useinbandfec=1',
    'a=recvonly',
    'm=video 9 UDP/TLS/RTP/SAVPF 96',
    'a=rtpmap:96 H264/90000',
    'a=fmtp:96 packetization-mode=1;profile-level-id=42e01f',
    'a=recvonly',
    '',
].join('\r\n');

describe('forceOpusStereo', () => {
    it('appends stereo=1;sprop-stereo=1 to the Opus fmtp line', () => {
        const out = forceOpusStereo(CHROME_ANSWER);
        expect(out).toContain('a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1');
    });

    it('keeps CRLF line structure intact (no CR swallowed into the fmtp)', () => {
        const out = forceOpusStereo(CHROME_ANSWER);
        expect(out).toContain('sprop-stereo=1\r\na=recvonly');
        expect(out).not.toContain('\r;stereo');
    });

    it('does not touch the video fmtp line', () => {
        const out = forceOpusStereo(CHROME_ANSWER);
        expect(out).toContain('a=fmtp:96 packetization-mode=1;profile-level-id=42e01f\r\n');
    });

    it('is idempotent when stereo is already negotiated', () => {
        const once = forceOpusStereo(CHROME_ANSWER);
        expect(forceOpusStereo(once)).toBe(once);
    });

    it('adds an fmtp line after the rtpmap when none exists', () => {
        const noFmtp = CHROME_ANSWER.replace('a=fmtp:111 minptime=10;useinbandfec=1\r\n', '');
        const out = forceOpusStereo(noFmtp);
        expect(out).toContain('a=rtpmap:111 opus/48000/2\r\na=fmtp:111 stereo=1;sprop-stereo=1');
    });

    it('returns the SDP unchanged when there is no Opus codec', () => {
        const videoOnly = [
            'v=0',
            'm=video 9 UDP/TLS/RTP/SAVPF 96',
            'a=rtpmap:96 H264/90000',
            '',
        ].join('\r\n');
        expect(forceOpusStereo(videoOnly)).toBe(videoOnly);
    });

    it('passes non-string input through untouched', () => {
        expect(forceOpusStereo(null)).toBe(null);
        expect(forceOpusStereo(undefined)).toBe(undefined);
    });
});

describe('video FEC removal preserves valid media sections', () => {
    const lines = [
        'v=0',
        'm=audio 9 RTP/SAVPF 111 63',
        'a=rtpmap:111 opus/48000/2',
        'a=rtpmap:63 red/48000/2',
        'a=fmtp:63 111/111',
        'm=video 9 RTP/SAVPF 96 97 63 64 100',
        'a=rtpmap:96 H264/90000',
        'a=fmtp:96 packetization-mode=1',
        'a=rtpmap:97 rtx/90000',
        'a=fmtp:97 apt=96',
        'a=rtpmap:63 red/90000',
        'a=rtpmap:64 rtx/90000',
        'a=fmtp:64 apt=63',
        'a=rtcp-fb:64 nack',
        'a=rtpmap:100 ulpfec/90000',
        '',
    ];
    for (const separator of ['\r\n', '\n']) {
        it(
            'keeps audio RED and H264/RTX; removes video FEC and its RTX with ' +
                JSON.stringify(separator),
            () => {
                const out = stripVideoFec(lines.join(separator));
                expect(out).toContain('m=audio 9 RTP/SAVPF 111 63');
                expect(out).toContain('a=rtpmap:63 red/48000/2');
                expect(out).toContain('m=video 9 RTP/SAVPF 96 97' + separator);
                expect(out).toContain('a=fmtp:96 packetization-mode=1');
                expect(out).toContain('a=fmtp:97 apt=96');
                expect(out).not.toContain('red/90000');
                expect(out).not.toContain('ulpfec/90000');
                expect(out).not.toContain('a=fmtp:64');
                expect(out).not.toContain('a=rtcp-fb:64');
                expect(out).not.toContain(separator + separator);
            },
        );
    }
    it('leaves an ordinary Opus/H264 answer unchanged', () => {
        expect(stripVideoFec(CHROME_ANSWER)).toBe(CHROME_ANSWER);
    });
    it('keeps a repair-only rejected media line valid', () => {
        const rejected = 'm=video 0 RTP/SAVPF 63\r\na=rtpmap:63 red/90000\r\n';
        expect(stripVideoFec(rejected)).toBe(rejected);
    });
});
