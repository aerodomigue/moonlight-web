import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
vi.mock('../js/api/BackendClient.js', () => ({
    BackendClient: {
        getDiscovery: vi.fn(),
        setDiscovery: vi.fn(),
        scanHosts: vi.fn(),
    },
}));
vi.mock('../js/ui/Toast.js', () => ({ Toast: { error: vi.fn() } }));
import { HostListView } from '../js/ui/HostListView.js';
import { BackendClient as api } from '../js/api/BackendClient.js';
import { Toast } from '../js/ui/Toast.js';
describe('account discovery preference', () => {
    let view;
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = '<main></main>';
        view = new HostListView(document.querySelector('main'));
        view._active = true;
    });
    afterEach(() => view.destroy());
    it('waits for backend authority before scanning', async () => {
        let resolve;
        api.getDiscovery.mockReturnValue(new Promise((r) => (resolve = r)));
        const pending = view._autoScan();
        expect(api.scanHosts).not.toHaveBeenCalled();
        resolve({ enabled: false });
        await pending;
        expect(api.scanHosts).not.toHaveBeenCalled();
        expect(document.querySelector('#btn-discovery').getAttribute('aria-pressed')).toBe('false');
    });
    it('scans when enabled, without overlapping requests', async () => {
        api.getDiscovery.mockResolvedValue({ enabled: true });
        await Promise.all([view._autoScan(), view._autoScan()]);
        expect(api.scanHosts).toHaveBeenCalledTimes(1);
    });
    it('does not scan after closing the view while loading the preference', async () => {
        let resolve;
        api.getDiscovery.mockReturnValue(new Promise((r) => (resolve = r)));
        const pending = view._autoScan();
        view.stop();
        resolve({ enabled: true });
        await pending;
        expect(api.scanHosts).not.toHaveBeenCalled();
    });
    it('reloads authority after returning before an obsolete request finishes', async () => {
        let resolve;
        api.getDiscovery.mockReturnValueOnce(new Promise((r) => (resolve = r)));
        api.getDiscovery.mockResolvedValue({ enabled: false });
        const pending = view._autoScan();
        view.stop();
        view._active = true;
        await view._autoScan();
        resolve({ enabled: true });
        await pending;
        await vi.waitFor(() => expect(api.getDiscovery).toHaveBeenCalledTimes(2));
        expect(api.scanHosts).not.toHaveBeenCalled();
        expect(view._discoveryEnabled).toBe(false);
    });
    it('persists activation before starting its scan', async () => {
        view._discoveryEnabled = false;
        api.setDiscovery.mockResolvedValue({ enabled: true });
        api.getDiscovery.mockResolvedValue({ enabled: true });
        await view._toggleDiscovery();
        expect(api.setDiscovery).toHaveBeenCalledWith(true);
        expect(api.scanHosts).toHaveBeenCalledTimes(1);
    });
    it('retains its state on persistence failure', async () => {
        view._discoveryEnabled = true;
        api.setDiscovery.mockRejectedValue(new Error('Storage unavailable'));
        await view._toggleDiscovery();
        expect(view._discoveryEnabled).toBe(true);
        expect(Toast.error).toHaveBeenCalled();
        expect(api.scanHosts).not.toHaveBeenCalled();
    });
});
