import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../js/util/pairingCrypto.js', () => ({
    loadOrCreateIdentity: vi.fn(),
    rememberHostIdentity: vi.fn(),
}));
import { loadOrCreateIdentity, rememberHostIdentity } from '../js/util/pairingCrypto.js';
import { BackendClient } from '../js/api/BackendClient.js';

const browser = { keyId: 'browser-key', publicKeyBase64: 'browser-spki', hostId: 'old-host' };
const identity = { host_public_key: 'current-spki', host_id: 'current-host' };
const status = () => ({ authenticated: true, has_session: true, browser_key_id: browser.keyId, ...identity });

beforeEach(() => {
    vi.restoreAllMocks();
    loadOrCreateIdentity.mockResolvedValue({ ...browser });
    rememberHostIdentity.mockResolvedValue(true);
    vi.spyOn(BackendClient, 'get').mockResolvedValue(status());
    vi.spyOn(BackendClient, 'post').mockImplementation(async path =>
        path === '/api/auth/identity/renew' ? identity : { status: 'ok', ...identity });
});

describe('Renew server identity after PIN or OIDC login', () => {
    it('automatically replaces a stale identity after a successful PIN login', async () => {
        await BackendClient.validatePin('123456', 'Laptop');
        expect(BackendClient.post).toHaveBeenCalledWith('/api/auth/identity/renew', { public_key: browser.publicKeyBase64 });
        expect(rememberHostIdentity).toHaveBeenCalledWith(identity.host_public_key, identity.host_id, {
            replace: true, expectedBrowserKey: browser.publicKeyBase64, expectedHostId: browser.hostId,
        });
    });
    it('never renews after an incorrect PIN', async () => {
        BackendClient.post.mockRejectedValue(new Error('invalid_pin'));
        await expect(BackendClient.validatePin('000000', 'Laptop')).rejects.toThrow('invalid_pin');
        expect(rememberHostIdentity).not.toHaveBeenCalled();
    });
    it('renews after a completed SSO login, using the grant advertised by the backend', async () => {
        BackendClient.get.mockResolvedValue({ ...status(), identity_renewal_available: true });
        expect((await BackendClient.getAuthStatus()).identity_error).toBeUndefined();
        expect(rememberHostIdentity).toHaveBeenCalledWith(identity.host_public_key, identity.host_id, expect.objectContaining({ replace: true }));
    });
    it('does not permit an ordinary status response to replace the pinned identity', async () => {
        await BackendClient.getAuthStatus();
        expect(BackendClient.post).not.toHaveBeenCalled();
        expect(rememberHostIdentity).toHaveBeenCalledWith(identity.host_public_key, identity.host_id, { expectedBrowserKey: browser.publicKeyBase64 });
    });
    it('detects a cleared browser keystore with a surviving cookie before streaming', async () => {
        loadOrCreateIdentity.mockResolvedValue({ ...browser, keyId: 'new-browser-key' });
        expect((await BackendClient.getAuthStatus()).identity_error).toBe('identityBrowserKeyChanged');
        expect(BackendClient.post).not.toHaveBeenCalled();
        expect(rememberHostIdentity).not.toHaveBeenCalled();
    });
    it('reports a failed renewal without claiming that the login is ready', async () => {
        rememberHostIdentity.mockResolvedValue(false);
        await expect(BackendClient.validatePin('123456', 'Laptop')).rejects.toMatchObject({ identityError: 'identityRenewalFailed' });
        BackendClient.get.mockResolvedValue({ ...status(), identity_renewal_available: true });
        expect((await BackendClient.getAuthStatus()).identity_error).toBe('identityRenewalFailed');
    });
    it('reports a stale pinned identity on a restored session without renewing it', async () => {
        rememberHostIdentity.mockResolvedValue(false);
        expect((await BackendClient.getAuthStatus()).identity_error).toBe('identityChanged');
        expect(BackendClient.post).not.toHaveBeenCalled();
    });
    it('reports unavailable private key storage before starting PIN or OIDC authentication', async () => {
        loadOrCreateIdentity.mockResolvedValue(null);
        await expect(BackendClient.validatePin('123456', 'Laptop')).rejects.toMatchObject({ identityError: 'identityStorageUnavailable' });
        await expect(BackendClient.beginSso('Laptop')).rejects.toMatchObject({ identityError: 'identityStorageUnavailable' });
        expect(BackendClient.post).not.toHaveBeenCalled();
    });
    it('waits for legacy pairing registration rather than skipping it after storing the host key', async () => {
        BackendClient.get.mockResolvedValue({ ...status(), browser_key_id: '' });
        await BackendClient.getAuthStatus();
        expect(BackendClient.post).toHaveBeenCalledWith('/api/auth/pairing-key', { public_key: browser.publicKeyBase64 });
    });
});

describe('Direct host access establishes a bound local session', () => {
    it('renews an old pin only after the backend creates a local key-bound session', async () => {
        BackendClient.get.mockResolvedValue({
            ...identity,
            authenticated: true,
            is_host_machine: true,
            has_session: false,
        });
        BackendClient.post.mockImplementation(async (path) =>
            path === '/api/auth/local-session'
                ? { ...identity, browser_key_id: browser.keyId, identity_renewal_available: true }
                : identity,
        );
        const result = await BackendClient.getAuthStatus();
        expect(BackendClient.post).toHaveBeenCalledWith('/api/auth/local-session', {
            public_key: browser.publicKeyBase64,
        });
        expect(rememberHostIdentity).toHaveBeenCalledWith(
            identity.host_public_key,
            identity.host_id,
            expect.objectContaining({ replace: true }),
        );
        expect(result.has_session).toBe(true);
        expect(result.identity_error).toBeUndefined();
    });
    it('does not bootstrap a remote viewer and cannot replace its cached identity', async () => {
        BackendClient.get.mockResolvedValue({
            ...identity,
            authenticated: true,
            is_host_machine: false,
            has_session: false,
        });
        await BackendClient.getAuthStatus();
        expect(BackendClient.post).not.toHaveBeenCalled();
        expect(rememberHostIdentity).toHaveBeenCalledWith(
            identity.host_public_key,
            identity.host_id,
            expect.not.objectContaining({ replace: true }),
        );
    });
});
