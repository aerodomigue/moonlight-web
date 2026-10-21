import { describe, it, expect, vi, afterEach } from 'vitest';
import { defaultIceServers } from '../js/api/IceServers.js';

vi.mock('../js/api/BackendClient.js', () => ({
    BackendClient: {
        getSetupStatus: vi.fn(async () => ({
            internet: { reverse_proxy: true, public_url: 'https://games.example.test' },
            sunshine: { installed: true, paired: true },
        })),
        getInternetStatus: vi.fn(async () => ({
            reverse_proxy: true,
            public_url: 'https://games.example.test',
            internet_access_enabled: false,
        })),
        applySetup: vi.fn(async () => ({ ok: true, internet_active: false })),
    },
}));
vi.mock('../js/ui/Toast.js', () => ({ Toast: { success: vi.fn(), error: vi.fn() } }));
import { AdminView } from '../js/ui/AdminView.js';
import { SetupView } from '../js/ui/SetupView.js';
import { BackendClient } from '../js/api/BackendClient.js';

afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
});

describe('Self-hosted reverse proxy', () => {
    it('never contacts a fallback STUN provider before receiving backend configuration', () => {
        expect(defaultIceServers()).toEqual([]);
    });

    it('shows the configured public URL without offering managed Internet access', async () => {
        const container = document.createElement('div');
        document.body.append(container);
        const view = new AdminView(container, () => {});
        await view._loadInternetState();
        view.render();
        const section = container.querySelector('#admin-section-internet');
        expect(section.textContent).toContain('https://games.example.test');
        expect(section.textContent).not.toContain('moonlightweb.top');
        expect(section.querySelector('input[type="checkbox"]')).toBeNull();
        view.destroy();
    });

    it('skips the relay consent during setup and never authorizes managed Internet access', async () => {
        const container = document.createElement('div');
        document.body.append(container);
        const view = new SetupView(container, () => {});
        await view.start();
        expect(container.querySelector('#btn-internet-accept')).toBeNull();
        expect(container.querySelector('#btn-internet-skip')).toBeNull();
        expect(view._internetNeedsAnswer()).toBe(false);
        expect(view._publicAddress()).toBe('https://games.example.test');
        await view._apply();
        expect(BackendClient.applySetup).toHaveBeenCalledWith(
            expect.objectContaining({ internet_access_authorized: false }),
        );
        view.destroy();
    });
});
