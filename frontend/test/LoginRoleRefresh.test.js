import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/api/BackendClient.js', () => ({
    BackendClient: { getAuthStatus: vi.fn(), ensurePairingKey: vi.fn(async () => null) },
}));
vi.mock('../js/ui/LoginView.js', () => ({
    LoginView: class {
        constructor(_container, onAuthenticated) {
            this.onAuthenticated = onAuthenticated;
        }
        start() {}
    },
}));
vi.mock('../js/ui/StreamView.js', () => ({ StreamView: class {} }));

import { MoonlightApp } from '../js/app.js';
import { BackendClient } from '../js/api/BackendClient.js';

describe('Account roles after a PIN login', () => {
    let app;
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = '<main id="main-content"></main>';
        app = Object.create(MoonlightApp);
        app.transition = vi.fn();
        app._offerHomeScreenHandoff = vi.fn();
        app._initNavButtons = vi.fn();
        app._initRouter = vi.fn();
        app._initAsync = vi.fn();
    });
    it('refreshes administrator rights before showing navigation', async () => {
        BackendClient.getAuthStatus
            .mockResolvedValueOnce({ authenticated: false })
            .mockResolvedValueOnce({
                authenticated: true,
                is_localhost: true,
                is_host_machine: false,
            });
        expect(await app._checkAuth()).toBe(false);
        expect(app._hasAdminAccess).toBe(false);
        const navigationRoles = [];
        app._initNavButtons.mockImplementation(() => navigationRoles.push(app._hasAdminAccess));
        await app.loginView.onAuthenticated();
        expect(app._hasAdminAccess).toBe(true);
        expect(app._isRealHostMachine).toBe(false);
        expect(navigationRoles).toEqual([true]);
        expect(app._initAsync).toHaveBeenCalledTimes(1);
    });
    it('keeps normal accounts without administrator privileges', async () => {
        BackendClient.getAuthStatus
            .mockResolvedValueOnce({ authenticated: false })
            .mockResolvedValueOnce({ authenticated: true, is_localhost: false });
        await app._checkAuth();
        await app.loginView.onAuthenticated();
        expect(app._hasAdminAccess).toBe(false);
        expect(app._initAsync).toHaveBeenCalledTimes(1);
    });
    it('does not enter the application when the renewed auth check fails', async () => {
        BackendClient.getAuthStatus
            .mockResolvedValueOnce({ authenticated: false })
            .mockRejectedValueOnce(new Error('server unavailable'));
        await app._checkAuth();
        await app.loginView.onAuthenticated();
        expect(app._initAsync).not.toHaveBeenCalled();
        expect(document.querySelector('.hosts-error')).not.toBeNull();
    });
});
