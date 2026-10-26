import { confirmAction } from '../js/ui/ConfirmDialog.js';
vi.mock('../js/ui/ConfirmDialog.js', () => ({ confirmAction: vi.fn(async () => true) }));
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { BackendClient } from '../js/api/BackendClient.js';
import { AdminLoginSettings } from '../js/ui/AdminLoginSettings.js';
import { AdminUsersPanel } from '../js/ui/AdminUsersPanel.js';
import { AdminView } from '../js/ui/AdminView.js';

const config = () => ({ pin: true, sso: true, issuer: 'https://auth.example/app/', client_id: 'client', public_url: window.location.origin, callback_url: `${window.location.origin}/api/auth/oidc/callback`, secret_configured: true, ca_file: '' });
const owner = () => ({ id: 'local-owner', name: 'Local owner', role: 'admin', enabled: true, protected: true, machine_count: 1, session_count: 2 });
const member = () => ({ id: 'local-player', name: '<Alice>', role: 'user', enabled: true, machine_count: 2, session_count: 3 });
let view;
let users;
let hosts;
let get;
let post;
let del;

beforeEach(() => {
    document.body.innerHTML = '<div id="panel"></div>';
    history.replaceState({}, '', '/admin');
    users = [owner(), member()];
    hosts = [{ uuid: 'host-one', name: '<PC>', backendType: 'gamestream' }];
    get = vi.spyOn(BackendClient, 'get').mockImplementation(async (path) => {
        if (path === '/api/admin/auth-config') return config();
        if (path === '/api/admin/users') return { users };
        if (path === '/api/admin/users/sso/pending') return { pending: false };
        if (path.endsWith('/hosts')) return { hosts };
        throw new Error('unexpected GET');
    });
    post = vi.spyOn(BackendClient, 'post').mockResolvedValue({});
    del = vi.spyOn(BackendClient, 'del').mockResolvedValue({});
    confirmAction.mockResolvedValue(true);
});
afterEach(() => {
    view?.destroy();
    view = null;
    vi.restoreAllMocks();
    document.body.innerHTML = '';
});
const openLogin = async (changed) => {
    view = new AdminLoginSettings(document.querySelector('#panel'), changed);
    await view.start();
};
const openUsers = async () => {
    view = new AdminUsersPanel(document.querySelector('#panel'));
    await view.start();
};

describe('Administration sign-in configuration', () => {
    it('shows the callback and a configured-secret indicator without a secret value', async () => {
        await openLogin();
        expect(document.querySelector('#admin-oidc-secret').value).toBe('');
        expect(document.querySelector('#admin-oidc-callback').textContent).toContain('/api/auth/oidc/callback');
        expect(document.querySelector('#admin-login-mode').value).toBe('pin,sso');
    });
    it('saves the selected mode and does not invent a replacement secret', async () => {
        const changed = vi.fn();
        post.mockResolvedValue(config());
        await openLogin(changed);
        document.querySelector('#admin-login-mode').value = 'pin';
        document.querySelector('#admin-login-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
        expect(post).toHaveBeenCalledWith('/api/admin/auth-config', expect.objectContaining({ pin: true, sso: false, client_secret: '', clear_secret: false }));
    });
    it('saves custom scopes while retaining the configured secret', async () => {
        await openLogin();
        expect(document.querySelector('[name="scopes"]').value).toBe('openid profile email moonlight_role');
        document.querySelector('[name="scopes"]').value = 'openid moonlight_role';
        await view.submit(false);
        expect(post).toHaveBeenCalledWith('/api/admin/auth-config', expect.objectContaining({ scopes: 'openid moonlight_role', client_secret: '', clear_secret: false }));
    });
    it('tests discovery separately and states that the secret remains unverified', async () => {
        await openLogin();
        document.querySelector('#admin-test-oidc').click();
        await vi.waitFor(() => expect(document.querySelector('#admin-login-feedback').textContent).toContain('adminAccounts.providerOk'));
        expect(post).toHaveBeenCalledWith('/api/admin/auth-config/test', expect.any(Object));
    });
    it('preserves a replacement secret through discovery and clears it only after saving', async () => {
        const changed = vi.fn();
        await openLogin(changed);
        document.querySelector('#admin-oidc-secret').value = 'fixture-only-secret';
        document.querySelector('[name="clear_secret"]').checked = true;
        await view.submit(true);
        expect(post).toHaveBeenCalledWith('/api/admin/auth-config/test', expect.objectContaining({ client_secret: 'fixture-only-secret', clear_secret: true }));
        expect(document.querySelector('#admin-oidc-secret').value).toBe('fixture-only-secret');
        expect(changed).not.toHaveBeenCalled();
        post.mockResolvedValue(config());
        await view.submit(false);
        expect(post).toHaveBeenLastCalledWith('/api/admin/auth-config', expect.objectContaining({ client_secret: 'fixture-only-secret', clear_secret: true }));
        expect(document.querySelector('#admin-oidc-secret').value).toBe('');
        expect(changed).toHaveBeenCalledOnce();
    });
    it('retains an unsaved secret after a failed request and clears it on closing', async () => {
        await openLogin();
        document.querySelector('#admin-oidc-secret').value = 'fixture-only-secret';
        post.mockRejectedValue(new Error('provider unreachable'));
        await view.submit(true);
        expect(document.querySelector('#admin-oidc-secret').value).toBe('fixture-only-secret');
        await view.submit(false);
        expect(document.querySelector('#admin-oidc-secret').value).toBe('fixture-only-secret');
        view.destroy();
        expect(document.querySelector('#admin-oidc-secret').value).toBe('');
    });
    it('shows a failed validation without invoking the saved callback', async () => {
        post.mockRejectedValue(new Error('invalid issuer'));
        const changed = vi.fn();
        await openLogin(changed);
        await view.submit(false);
        expect(changed).not.toHaveBeenCalled();
        expect(document.querySelector('#admin-login-feedback').textContent).toContain('invalid issuer');
        expect(document.querySelector('#admin-test-oidc').disabled).toBe(false);
    });
    it('ignores a late response after destruction', async () => {
        let resolve;
        post.mockReturnValue(new Promise((done) => { resolve = done; }));
        const changed = vi.fn();
        await openLogin(changed);
        const pending = view.submit(false);
        view.destroy();
        resolve(config());
        await pending;
        expect(changed).not.toHaveBeenCalled();
    });
});

describe('Administration accounts and machine assignments', () => {
    it('shows counts and roles while escaping names and protecting the owner', async () => {
        await openUsers();
        expect(document.querySelector('#admin-user-list').textContent).toContain('<Alice>');
        expect(document.querySelector('#panel alice')).toBeNull();
        expect(document.querySelector('[data-user-action="delete"]').disabled).toBe(true);
        expect(document.querySelector('#admin-edit-user [name="role"]').disabled).toBe(true);
        expect(document.querySelector('[data-user-action="hosts"]')).not.toBeNull();
    });
    it('shows the Authentik role as read-only and omits it from account updates', async () => {
        users[1] = { ...member(), sso_linked: true, role_source: 'authentik', issuer: 'https://auth.example/' };
        await openUsers();
        view.selected = users[1].id;
        view.render();
        expect(document.querySelector('#admin-edit-user [name="role"]').disabled).toBe(true);
        expect(document.querySelector('[data-role-source]').textContent).toContain('adminAccounts.authentikRole');
        document.querySelector('#admin-edit-user').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await vi.waitFor(() => expect(post).toHaveBeenCalled());
        const [path, body] = post.mock.calls[0];
        expect(path).toBe('/api/admin/users/local-player');
        expect(body).not.toHaveProperty('role');
        expect(body).toMatchObject({ name: '<Alice>', enabled: true });
    });
    it('creates a local account with the selected role', async () => {
        post.mockImplementation(async (path, body) => {
            if (path === '/api/admin/users') {
                const user = { ...member(), ...body, id: 'local-new' };
                users.push(user);
                return { user };
            }
            return {};
        });
        await openUsers();
        document.querySelector('#admin-new-user').value = 'New administrator';
        document.querySelector('#admin-create-user [name="role"]').value = 'admin';
        document.querySelector('#admin-create-user').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await vi.waitFor(() => expect(view.selected).toBe('local-new'));
        expect(post).toHaveBeenCalledWith('/api/admin/users', { name: 'New administrator', role: 'admin' });
    });
    it('keeps a generated PIN visible and does not enable protected controls', async () => {
        post.mockResolvedValue({ pin: '123456', expires_in: 0 });
        await openUsers();
        await view.userAction('pin', users[0]);
        expect(document.querySelector('[data-account-pin]').textContent).toContain('123456');
        expect(document.querySelector('[data-user-action="delete"]').disabled).toBe(true);
        view.destroy();
        expect(document.querySelector('[data-account-pin]').textContent).toBe('');
    });
    it('requires confirmation with counts before deleting a user', async () => {
        await openUsers();
        confirmAction.mockResolvedValue(false);
        await view.userAction('delete', users[1]);
        expect(confirmAction).toHaveBeenCalledWith(expect.any(String), { inApp: true, danger: true });
        expect(del).not.toHaveBeenCalled();
    });
    it('hides local creation and PIN in SSO-only mode while retaining management', async () => {
        await openUsers();
        view.config.pin = false;
        view.render();
        expect(document.querySelector('#admin-create-user')).toBeNull();
        expect(document.querySelector('[data-user-action="pin"]')).toBeNull();
        expect(document.querySelector('[data-user-action="revoke"]')).not.toBeNull();
        const callback = vi.fn(); view.onHosts = callback;
        await view.userAction('hosts', users[1]);
        expect(callback).toHaveBeenCalledWith('local-player');
    });
    it('searches users without replacing the current draft form', async () => {
        await openUsers();
        const name = document.querySelector('#admin-user-name'); name.value = 'Draft';
        const search = document.querySelector('#admin-user-search'); search.value = 'Alice';
        search.dispatchEvent(new Event('input'));
        expect(document.querySelector('[data-user-id="local-owner"]').hidden).toBe(true);
        expect(document.querySelector('[data-user-id="local-player"]').hidden).toBe(false);
        expect(document.querySelector('#admin-user-name')).toBe(name);
        expect(name.value).toBe('Draft');
    });
    it('shows a verified identity for explicit confirmation', async () => {
        const base = get.getMockImplementation();
        get.mockImplementation((path) => path === '/api/admin/users/sso/pending' ? Promise.resolve({ pending: true, user_id: 'local-player', name: '<OIDC>', issuer: 'https://issuer.example', subject: 'verified-sub' }) : base(path));
        await openUsers();
        expect(view.selected).toBe('local-player');
        expect(document.querySelector('[data-user-action="confirm-link"]')).not.toBeNull();
        await view.userAction('confirm-link', users[1]);
        expect(post).toHaveBeenCalledWith('/api/admin/users/local-player/sso/confirm', {});
    });
    it('requires the configured public origin for an identity-link redirect', async () => {
        await openUsers();
        view.config.public_url = 'https://public.example';
        await view.userAction('link', users[1]);
        expect(post).not.toHaveBeenCalled();
        expect(document.querySelector('#admin-users-feedback').textContent).toContain('adminAccounts.usePublicAdmin');
    });
    it('does not reveal a PIN after closing while its request is pending', async () => {
        await openUsers();
        let resolve;
        post.mockReturnValue(new Promise((done) => { resolve = done; }));
        const pending = view.userAction('pin', users[0]);
        view.destroy();
        resolve({ pin: '123456', expires_in: 0 });
        await pending;
        expect(document.querySelector('[data-account-pin]').textContent).toBe('');
    });
});


describe('Administration server authority', () => {
    it('honors a server denial even on a loopback URL', async () => {
        vi.spyOn(BackendClient, 'getAuthStatus').mockResolvedValue({ authenticated: true, is_localhost: false, admin_unlock_available: false });
        view = new AdminView(document.querySelector('#panel'));
        await view._loadAuthStatus();
        expect(view._isLocalhost()).toBe(false);
        view.render();
        expect(document.querySelector('#admin-section-login')).toBeNull();
    });
    it('closes the console when the current authorization check fails', async () => {
        vi.spyOn(BackendClient, 'getAuthStatus').mockRejectedValue(new Error('offline'));
        view = new AdminView(document.querySelector('#panel'));
        view._hasAdminAccess = true;
        await view._loadAuthStatus();
        expect(view._isLocalhost()).toBe(false);
        expect(view._adminUnlockAvailable).toBe(false);
    });
});

describe('Administration navigation during settings save', () => {
    it('does not replace the next view after closing during the auth-status refresh', async () => {
        const admin = new AdminView(document.querySelector('#panel'), () => {});
        admin._hasAdminAccess = true;
        admin._accountAdministration = true;
        admin.render();
        admin.bindEvents();
        let resolve;
        vi.spyOn(admin, '_loadAuthStatus').mockReturnValue(new Promise((done) => { resolve = done; }));
        const saved = admin._accountPanels[0].onChanged();
        admin.destroy();
        document.querySelector('#panel').innerHTML = '<p id="next-view">Hosts</p>';
        resolve();
        await saved;
        expect(document.querySelector('#next-view')?.textContent).toBe('Hosts');
        expect(document.querySelector('#view-admin')).toBeNull();
    });
});
