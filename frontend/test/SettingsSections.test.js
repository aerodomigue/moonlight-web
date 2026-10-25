import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsView } from '../js/ui/SettingsView.js';
import { BackendClient } from '../js/api/BackendClient.js';
import { hostUpdate } from '../js/ui/HostUpdate.js';

vi.mock('../js/util/BrowserDetect.js', async (original) => ({
    ...(await original()),
    supportsGamingMode: () => true,
}));

describe('settings without obsolete service sections', () => {
    let view;
    beforeEach(() => {
        document.body.innerHTML = '<div id="settings"></div>';
        view = new SettingsView(document.querySelector('#settings'), () => {});
    });
    afterEach(() => {
        view.destroy();
        vi.restoreAllMocks();
        localStorage.clear();
        document.body.replaceChildren();
    });
    it('keeps stream controls and reset without privacy, updater or donation panels', () => {
        view.render();
        expect(
            document.querySelector(
                '#settings-section-privacy, #settings-section-update, #settings-section-support',
            ),
        ).toBe(null);
        expect(document.querySelector('#settings-exclusive-mode')).not.toBe(null);
        expect(document.querySelector('#settings-gaming-mode')).not.toBe(null);
        expect(document.querySelector('#btn-settings-reset')).not.toBe(null);
    });
    it('opens without contacting the removed services or subscribing to updates', async () => {
        vi.spyOn(view, '_loadState').mockResolvedValue();
        vi.spyOn(view, '_checkCodecSupport').mockResolvedValue({ h264: true });
        vi.spyOn(view, '_loadPyrowaveHost').mockResolvedValue();
        vi.spyOn(view, '_checkWebGpuSupport').mockResolvedValue(false);
        vi.spyOn(view, '_checkSession').mockResolvedValue(false);
        vi.spyOn(view, 'bindEvents').mockImplementation(() => {});
        const metrics = vi
            .spyOn(BackendClient, 'getMetricsReporting')
            .mockResolvedValue({ available: false });
        const updates = vi
            .spyOn(BackendClient, 'checkForUpdate')
            .mockResolvedValue({ channel: 'self-hosted', checked_at: 1 });
        const subscribe = vi.spyOn(hostUpdate, 'subscribe').mockReturnValue(() => {});
        await view.start();
        expect(metrics).not.toHaveBeenCalled();
        expect(updates).not.toHaveBeenCalled();
        expect(subscribe).not.toHaveBeenCalled();
    });
});
