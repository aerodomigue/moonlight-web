import { afterEach, describe, expect, it, vi } from 'vitest';
import { MoonlightApp } from '../js/app.js';
import { BackendClient } from '../js/api/BackendClient.js';
import { resolveStreamSize } from '../js/util/StreamResolution.js';

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('4K client with fixed 240 FPS and manual 100 Mbit/s', () => {
    it('sends the measured screen size and preserves both explicit settings to /start', async () => {
        vi.stubGlobal('screen', { width: 3840, height: 2160 });
        vi.stubGlobal('devicePixelRatio', 1);
        const app = Object.create(MoonlightApp);
        const settings = { stream_fps: 240, stream_bitrate: 100000, stream_bitrate_auto: false };
        app._applyResolvedFps(settings);
        const size = resolveStreamSize({ mode: 'auto' }, { nativeHost: false });
        app._applyResolvedSize(settings, app._applyPixelBudget(settings, size, 'auto', false));
        const post = vi.spyOn(BackendClient, 'post').mockResolvedValue({ status: 'streaming' });
        await BackendClient.launchApp('test-host', 42, settings);
        expect(post.mock.calls[0][0]).toBe('/api/hosts/test-host/start');
        expect(post.mock.calls[0][1]).toMatchObject({
            stream_height: 2160,
            stream_aspect: '3840:2160',
            stream_fps: 240,
            stream_bitrate: 100000,
            stream_bitrate_auto: false,
        });
        expect(settings.stream_fps_max).toBeUndefined();
    });
    it('never reduces an explicit rate through Auto resolution pixel budgeting', () => {
        const app = Object.create(MoonlightApp);
        const settings = { stream_fps: 240 };
        const size = { height: 2160, aspect: '3840:2160' };
        expect(app._applyPixelBudget(settings, size, 'auto', false)).toEqual(size);
        expect(settings.stream_fps).toBe(240);
    });
});
