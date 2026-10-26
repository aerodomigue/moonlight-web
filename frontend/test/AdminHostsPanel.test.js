import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { AdminHostsPanel } from '../js/ui/AdminHostsPanel.js';
import { BackendClient } from '../js/api/BackendClient.js';
import { confirmAction } from '../js/ui/ConfirmDialog.js';
vi.mock('../js/ui/ConfirmDialog.js', () => ({ confirmAction: vi.fn(async () => true) }));
let panel, hosts, get, post, del;
beforeEach(async () => {
    document.body.innerHTML = '<div id="panel"></div>';
    hosts = [{ uuid: 'one', name: '<PC>', owner_id: 'alice', enabled: true, state: 'online', blocked_reason: '' }, { uuid: 'two', name: 'Other', owner_id: 'bob', enabled: false, state: 'offline', blocked_reason: 'busy', busy: true }];
    get = vi.spyOn(BackendClient, 'get').mockImplementation(async path => path === '/api/admin/hosts' ? { hosts } : { users: [{ id: 'alice', name: 'Alice', enabled: true }, { id: 'bob', name: 'Bob', enabled: true }] });
    post = vi.spyOn(BackendClient, 'post').mockResolvedValue({});
    del = vi.spyOn(BackendClient, 'del').mockResolvedValue({});
    confirmAction.mockResolvedValue(true);
    panel = new AdminHostsPanel(document.querySelector('#panel'));
    await panel.start();
});
afterEach(() => { panel.destroy(); vi.restoreAllMocks(); document.body.replaceChildren(); });
describe('administrator host registrations', () => {
    it('escapes names, separates offline from disabled, and explains blocked operations', () => {
        expect(document.querySelector('pc')).toBeNull();
        expect(document.querySelector('[data-host-row="two"]').textContent).toContain('adminManagement.disabled');
        expect(document.querySelector('[data-host-row="two"]').textContent).toContain('adminManagement.offline');
        expect(document.querySelector('[data-host-row="two"] [data-host-action]').disabled).toBe(true);
    });
    it('filters by owner, activation and search', async () => {
        await panel.showOwner('bob');
        expect(document.querySelector('[data-host-row="one"]').hidden).toBe(true);
        panel.state = 'enabled'; panel.filter();
        expect(document.querySelector('[data-host-empty]').hidden).toBe(false);
        panel.owner = ''; panel.state = ''; panel.search = '<PC>'; panel.filter();
        expect(document.querySelector('[data-host-row="one"]').hidden).toBe(false);
    });
    it.each(['transfer', 'duplicate'])('confirms %s with exact source and destination', async action => {
        await panel.action(action, hosts[0], 'bob');
        expect(confirmAction).toHaveBeenCalledWith(expect.stringContaining('<PC> → Bob'), expect.objectContaining({ inApp: true }));
        expect(post).toHaveBeenCalledWith(`/api/admin/hosts/one/${action}`, { user_id: 'bob' });
    });
    it('deletes only the registration and honors cancellation', async () => {
        confirmAction.mockResolvedValueOnce(false);
        await panel.action('delete', hosts[0], '');
        expect(del).not.toHaveBeenCalled();
        await panel.action('delete', hosts[0], '');
        expect(del).toHaveBeenCalledWith('/api/admin/hosts/one');
        expect(post).not.toHaveBeenCalled();
    });
    it('reports a server rejection without discarding the registration', async () => {
        post.mockRejectedValueOnce(new Error('busy'));
        await panel.action('transfer', hosts[0], 'bob');
        expect(document.querySelector('[data-host-feedback]').textContent).toContain('busy');
        expect(document.querySelector('[data-host-row="one"]')).not.toBeNull();
    });
    it('does not execute after destruction during a confirmation', async () => {
        let resolve; confirmAction.mockReturnValueOnce(new Promise(done => { resolve = done; }));
        const pending = panel.action('delete', hosts[0], '');
        panel.destroy(); resolve(true); await pending;
        expect(del).not.toHaveBeenCalled();
    });
    it('ignores stale refresh responses and responses after closing', async () => {
        let resolve; get.mockReturnValue(new Promise(done => { resolve = done; }));
        const pending = panel.start(); panel.destroy();
        resolve({ hosts: [], users: [] }); await pending;
        expect(document.querySelector('[data-host-row="one"]')).not.toBeNull();
    });
});
