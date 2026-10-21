import { describe, it, expect, vi, afterEach } from 'vitest';
import { t } from '../js/i18n/i18n.js';
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
            internet_access_enabled: true,
            active: true,
            upnp_enabled: true,
            upnp_available: true,
        })),
        enableInternet: vi.fn(async () => ({ status: 'enabled', domain: 'games.example.test' })),
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
    it('uses public ICE discovery without the MoonlightWeb infrastructure', () => {
        expect(defaultIceServers()).toEqual([{ urls: 'stun:stun.cloudflare.com:3478' }]);
    });

    it('shows the configured public URL while retaining Internet activation and UPnP', async () => {
        const container = document.createElement('div');
        document.body.append(container);
        const view = new AdminView(container, () => {});
        await view._loadInternetState();
        view.render();
        const section = container.querySelector('#admin-section-internet');
        expect(section.textContent).toContain('https://games.example.test');
        expect(section.textContent).not.toContain('moonlightweb.top');
        expect(section.querySelector('#chk-internet-enable').checked).toBe(true);
        expect(section.textContent).toContain(t('admin.upnpLabel'));
        expect(view._awaitingRdv).toBe(false);
        view._awaitRendezvousUrl();
        expect(view._awaitingRdv).toBe(false);
        view.destroy();
    });

    it('runs Internet activation without waiting for the removed rendezvous', async () => {
        const container = document.createElement('div');
        document.body.append(container);
        const view = new AdminView(container, () => {});
        await view._loadInternetState();
        view.render = vi.fn();
        view.bindEvents = vi.fn();
        await view._enableInternet();
        expect(BackendClient.enableInternet).toHaveBeenCalledWith(
            expect.objectContaining({
                internet_access_enabled: true,
                auto_ip_detection: true,
            }),
        );
        expect(view._internetEnabled).toBe(true);
        expect(view._awaitingRdv).toBe(false);
        expect(view._internetConsentText()).not.toContain('moonlightweb.top');
        view.destroy();
    });

    it('keeps the Internet question during setup with wording for the self-hosted network', async () => {
        const container = document.createElement('div');
        document.body.append(container);
        const view = new SetupView(container, () => {});
        await view.start();
        expect(container.querySelector('#btn-internet-accept')).not.toBeNull();
        expect(container.querySelector('#btn-internet-skip')).not.toBeNull();
        expect(view._internetNeedsAnswer()).toBe(true);
        container.querySelector('#btn-internet-accept').click();
        expect(view._internetNeedsAnswer()).toBe(false);
        expect(view._publicAddress()).toBe('https://games.example.test');
        await view._apply();
        expect(BackendClient.applySetup).toHaveBeenCalledWith(
            expect.objectContaining({ internet_access_authorized: true }),
        );
        view.destroy();
    });
});
