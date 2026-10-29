import { afterEach, describe, expect, it, vi } from 'vitest';
import { MoonlightApp } from '../js/app.js';
import { Toast } from '../js/ui/Toast.js';

afterEach(() => vi.restoreAllMocks());
function app(overrides = {}) {
    vi.spyOn(Toast, 'warning').mockImplementation(() => {});
    return Object.assign(Object.create(MoonlightApp), {
        _nav: { overlay: 'streaming' },
        _standbyView: null,
        _lastStreamNative: false,
        _sharePinsQuality: () => false,
        _lastDegradeTime: 0,
        _lastUpgradeTime: 0,
        _degradeOverrides: {},
        _degradeLevel: 0,
        _fpsAuto: false,
        _resolutionAuto: false,
        _transportChain: ['webrtc-media-udp'],
        _transportIndex: 0,
        _lastStreamingSettings: {
            stream_fps: 144,
            stream_height: 2160,
            stream_bitrate: 90000,
            stream_bitrate_auto: false,
            video_enhancement: 'off',
        },
        _qualityRelaunch: vi.fn(),
        ...overrides,
    });
}
describe('congestion respects manually selected quality', () => {
    it('does not silently replace 4K/144 FPS/90 Mbit/s or restart a fully manual stream', () => {
        const a = app();
        a._onStreamCongested();
        expect(a._degradeOverrides).toEqual({});
        expect(a._qualityRelaunch).not.toHaveBeenCalled();
    });
    it('can lower Auto resolution without replacing manual FPS or bitrate or forcing an enhancer', () => {
        const a = app({ _resolutionAuto: true });
        a._onStreamCongested();
        expect(a._degradeOverrides).toEqual({ stream_height: 1440 });
        expect(a._qualityRelaunch).toHaveBeenCalledOnce();
    });
    it('can lower Auto bitrate while keeping manual resolution and frame rate', () => {
        const a = app();
        a._lastStreamingSettings.stream_bitrate_auto = true;
        a._onStreamCongested();
        expect(a._degradeOverrides).toEqual({ stream_bitrate: 45000 });
    });
    it('retains the Auto FPS adjustment', () => {
        const a = app({ _fpsAuto: true });
        a._onStreamCongested();
        expect(a._degradeOverrides).toEqual({ stream_fps: 60 });
    });
});
