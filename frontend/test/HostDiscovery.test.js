import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
vi.mock('../js/api/BackendClient.js', () => ({
    BackendClient: {
        getDiscovery: vi.fn(),
        getDiscoveryCandidates: vi.fn(),
        addDiscoveryCandidate: vi.fn(),
        getHosts: vi.fn(),
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
        api.getDiscoveryCandidates.mockResolvedValue({candidates: []});
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
    it('shows candidates separately with only an explicit Add action', async () => {
        api.getDiscoveryCandidates.mockResolvedValue({ candidates: [{id:'candidate-a',name:'PC <Alice>',address:'10.0.0.2'}] });
        await view._refreshCandidates();
        expect(view.hosts).toEqual([]);
        expect(document.querySelectorAll('.host-card')).toHaveLength(0);
        expect(document.querySelector('[data-add-candidate]').dataset.addCandidate).toBe('candidate-a');
        expect(document.querySelector('#discovery-candidates').textContent).toContain('PC <Alice>');
        expect(document.querySelector('#discovery-candidates').querySelectorAll('button')).toHaveLength(1);
        expect(api.addDiscoveryCandidate).not.toHaveBeenCalled();
    });
    it('deduplicates clicks while confirmation is pending', async () => {
        let resolve;
        api.addDiscoveryCandidate.mockReturnValue(new Promise(r=>resolve=r));
        api.getHosts.mockResolvedValue({hosts:[]});
        api.getDiscovery.mockResolvedValue({enabled:false});
        const button=document.createElement('button');button.dataset.addCandidate='candidate';
        const first=view._addCandidate(button);
        await view._addCandidate(button);
        expect(api.addDiscoveryCandidate).toHaveBeenCalledTimes(1);
        resolve({hosts:[]});await first;
    });
    it('discards a late candidate response after closing the dashboard', async () => {
        let resolve;
        api.getDiscoveryCandidates.mockReturnValueOnce(new Promise(r=>resolve=r));
        const pending=view._refreshCandidates(); view.stop();
        resolve({candidates:[{id:'late',name:'Private PC',address:'10.0.0.1'}]});await pending;
        expect(document.body.textContent).not.toContain('Private PC');
    });
    it('removes registrations absent from an authoritative successful snapshot', async () => {
        api.getHosts.mockResolvedValueOnce({hosts:[{uuid:'a',name:'Private A',state:'offline',pairState:'not_paired'}]});
        await view.refresh();expect(view.hosts).toHaveLength(1);
        api.getHosts.mockResolvedValueOnce({hosts:[]});
        await view.refresh();expect(view.hosts).toEqual([]);
        expect(document.querySelectorAll('.host-card')).toHaveLength(0);
        expect(document.body.textContent).not.toContain('Private A');
    });

    it('does not resurrect a removed host from an older concurrent snapshot', async () => {
        let resolve;
        api.getHosts.mockReturnValueOnce(new Promise(r=>resolve=r));
        const older=view.refresh();
        api.getHosts.mockResolvedValueOnce({hosts:[]});await view.refresh();
        resolve({hosts:[{uuid:'removed',name:'Old private PC',state:'offline'}]});await older;
        expect(view.hosts).toEqual([]);
    });
    it('does not restore candidates from an older refresh after disabling', async () => {
        let resolve;
        api.getDiscoveryCandidates.mockReturnValueOnce(new Promise(r=>resolve=r));
        const older=view._refreshCandidates();
        api.getDiscoveryCandidates.mockResolvedValueOnce({candidates:[]});await view._refreshCandidates();
        resolve({candidates:[{id:'old',name:'Old candidate',address:'10.0.0.1'}]});await older;
        expect(document.querySelector('#discovery-candidates').hidden).toBe(true);
    });

});
