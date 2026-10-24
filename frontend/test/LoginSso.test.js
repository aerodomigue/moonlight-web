import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../js/api/BackendClient.js', () => ({
    BackendClient: {
        getAuthStatus: vi.fn(),
        beginSso: vi.fn(),
    },
}));
vi.mock('../js/ui/Toast.js', () => ({ Toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../js/i18n/i18n.js', () => ({ t: (key) => key }));
vi.mock('../js/net/tunnelBridge.js', () => ({ tunnelHostId: () => null }));

import { BackendClient } from '../js/api/BackendClient.js';
import { LoginView } from '../js/ui/LoginView.js';

describe('PIN and SSO connection modes', () => {
    let view;
    let navigate;
    const status = (pin, sso) => ({ authenticated: false, pin_enabled: pin, sso_enabled: sso });
    const open = async (value) => {
        BackendClient.getAuthStatus.mockResolvedValue(value);
        document.body.innerHTML = '<main id="login"></main>';
        view = new LoginView(document.getElementById('login'), vi.fn());
        await view.start();
    };

    beforeEach(() => {
        vi.clearAllMocks();
        sessionStorage.clear();
        localStorage.clear();
        history.replaceState(null, '', '/');
        BackendClient.beginSso.mockResolvedValue('https://auth.example/authorize?state=opaque');
        navigate = vi.spyOn(LoginView.prototype, '_navigate').mockImplementation(() => {});
    });
    afterEach(() => {
        view?.destroy();
        vi.restoreAllMocks();
        history.replaceState(null, '', '/');
    });

    it('preserves the PIN form when SSO is disabled', async () => {
        await open(status(true, false));
        expect(document.querySelector('#login-pin-input')).not.toBeNull();
        expect(document.querySelector('#btn-login-sso')).toBeNull();
        expect(BackendClient.beginSso).not.toHaveBeenCalled();
    });
    it('asks for a method when both are enabled', async () => {
        await open(status(true, true));
        expect(document.querySelector('#btn-login-pin')).not.toBeNull();
        expect(document.querySelector('#btn-login-sso')).not.toBeNull();
        expect(document.querySelector('#login-pin-input')).toBeNull();
        expect(BackendClient.beginSso).not.toHaveBeenCalled();
        document.querySelector('#btn-login-pin').click();
        expect(document.querySelector('#login-pin-input')).not.toBeNull();
        expect(document.querySelector('#btn-login-sso')).not.toBeNull();
    });
    it('starts SSO only after choosing it in mixed mode', async () => {
        await open(status(true, true));
        document.querySelector('#btn-login-sso').click();
        await vi.waitFor(() => expect(navigate).toHaveBeenCalled());
        expect(BackendClient.beginSso).toHaveBeenCalledWith(expect.any(String), true);
        expect(navigate).toHaveBeenCalledWith('https://auth.example/authorize?state=opaque');
    });
    it('automatically starts SSO in SSO-only mode', async () => {
        await open(status(false, true));
        expect(document.querySelector('#login-pin-input')).toBeNull();
        expect(BackendClient.beginSso).toHaveBeenCalledTimes(1);
        expect(navigate).toHaveBeenCalledTimes(1);
    });
    it('does not restart SSO after an authentication error', async () => {
        history.replaceState(null, '', '/?auth_error=sso');
        await open(status(false, true));
        expect(BackendClient.beginSso).not.toHaveBeenCalled();
        expect(document.querySelector('.login-error').textContent).toContain('login.ssoError');
        expect(document.querySelector('#btn-login-sso')).not.toBeNull();
    });
    it('does not automatically log back in after an explicit logout', async () => {
        sessionStorage.setItem('mw-sso-logged-out', '1');
        await open(status(false, true));
        expect(BackendClient.beginSso).not.toHaveBeenCalled();
        document.querySelector('#btn-login-sso').click();
        await vi.waitFor(() => expect(BackendClient.beginSso).toHaveBeenCalledTimes(1));
    });
    it('shows a retry after provider failure without an automatic loop', async () => {
        BackendClient.beginSso.mockRejectedValue(new Error('provider unavailable'));
        await open(status(false, true));
        expect(BackendClient.beginSso).toHaveBeenCalledTimes(1);
        expect(navigate).not.toHaveBeenCalled();
        expect(document.querySelector('#btn-login-sso').disabled).toBe(false);
        expect(document.querySelector('.login-error')).not.toBeNull();
    });
    it('uses the configured public origin before starting SSO from the LAN', async () => {
        await open({ ...status(false, true), sso_origin: 'https://moonlight.example' });
        expect(BackendClient.beginSso).not.toHaveBeenCalled();
        expect(navigate).toHaveBeenCalledWith('https://moonlight.example/?sso=1');
    });
    it('honours an explicit SSO choice carried to the canonical origin', async () => {
        history.replaceState(null, '', '/?sso=1');
        await open(status(true, true));
        expect(BackendClient.beginSso).toHaveBeenCalledTimes(1);
    });
    it('does not redirect a browser that already has an authenticated session', async () => {
        await open({ ...status(false, true), authenticated: true });
        expect(BackendClient.beginSso).not.toHaveBeenCalled();
        expect(view.onAuthenticated).toHaveBeenCalledTimes(1);
    });
    it('does not redirect after the visitor has left the login view', async () => {
        let finish;
        BackendClient.beginSso.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        await open(status(true, true));
        document.querySelector('#btn-login-sso').click();
        view.destroy();
        finish('https://auth.example/authorize');
        await Promise.resolve();
        expect(navigate).not.toHaveBeenCalled();
    });
    it('does not follow an insecure authorization URL', async () => {
        BackendClient.beginSso.mockResolvedValue('http://auth.example/authorize');
        await open(status(false, true));
        expect(navigate).not.toHaveBeenCalled();
        expect(document.querySelector('.login-error')).not.toBeNull();
    });
});
