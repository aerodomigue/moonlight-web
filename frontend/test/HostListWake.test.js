import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../js/api/BackendClient.js', () => ({
    BackendClient: { setWakeConfig: vi.fn(), getHosts: vi.fn(), getAppList: vi.fn() },
}));
vi.mock('../js/i18n/i18n.js', () => ({ t: (key) => key }));

import { BackendClient } from '../js/api/BackendClient.js';
import { HostListView } from '../js/ui/HostListView.js';
import { Host } from '../js/models/Host.js';

let view;
beforeEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    BackendClient.adminLocked = false;
    view = Object.create(HostListView.prototype);
    view.hosts = [new Host({ uuid: 'h1', name: 'Desk', state: 'offline', wakeSupported: true })];
    view.refresh = vi.fn().mockResolvedValue(undefined);
});

afterEach(() => {
    document.querySelector('.wol-cancel')?.click();
});

describe('Wake-on-LAN for saved offline hosts', () => {
    it('offers Wake with saved LAN information, and configuration in the menu', () => {
        const html = view.renderCard(view.hosts[0]);
        expect(html).toContain('btn-wol"');
        expect(html).toContain('btn-wol-config');
        BackendClient.adminLocked = true;
        const booth = view.renderCard(view.hosts[0]);
        expect(booth).toContain('btn-wol"');
        expect(booth).not.toContain('btn-wol-config');
    });

    it('refreshes the card when LAN wake support becomes available', () => {
        view.hosts[0].wakeSupported = false;
        const before = view._fingerprint();
        expect(view.renderCard(view.hosts[0])).not.toContain('btn-wol"');
        view.hosts[0].wakeSupported = true;
        expect(view._fingerprint()).not.toBe(before);
        expect(view.renderCard(view.hosts[0])).toContain('btn-wol"');
    });

    it('saves a legacy host configuration without waking it', async () => {
        BackendClient.setWakeConfig.mockResolvedValue({ status: 'ok' });
        view._configureWake(view.hosts[0]);
        document.querySelector('[name="address"]').value = '192.168.1.20';
        document.querySelector('[name="mac"]').value = '02:11:22:33:44:55';
        document.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
        await vi.waitFor(() => expect(view.refresh).toHaveBeenCalledOnce());
        expect(BackendClient.setWakeConfig).toHaveBeenCalledWith(
            'h1',
            '192.168.1.20',
            '02:11:22:33:44:55',
        );
        expect(document.querySelector('.host-wol-overlay')).toBeNull();
    });

    it('keeps invalid configuration visible so it can be corrected', async () => {
        BackendClient.setWakeConfig.mockRejectedValue(new Error('Private IPv4 required'));
        view._configureWake(view.hosts[0]);
        document.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
        await vi.waitFor(() =>
            expect(document.querySelector('[role="alert"]').textContent).toBe(
                'Private IPv4 required',
            ),
        );
        expect(document.querySelector('.wol-save').disabled).toBe(false);
        expect(view.refresh).not.toHaveBeenCalled();
    });

    it('closes on Escape after a disabled submit button loses focus', () => {
        view._configureWake(view.hosts[0]);
        document.querySelector('[name="address"]').blur();
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(document.querySelector('.host-wol-overlay')).toBeNull();
        expect(BackendClient.setWakeConfig).not.toHaveBeenCalled();
    });

    it('closes without changes on Escape', () => {
        view._configureWake(view.hosts[0]);
        document
            .querySelector('[name="address"]')
            .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(document.querySelector('.host-wol-overlay')).toBeNull();
        expect(BackendClient.setWakeConfig).not.toHaveBeenCalled();
    });
});
