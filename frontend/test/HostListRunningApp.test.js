/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../js/api/BackendClient.js', () => ({
    BackendClient: { getAppList: vi.fn(), stopHostSession: vi.fn(), getRunningApp: vi.fn() },
}));

import { HostListView } from '../js/ui/HostListView.js';
import { Host } from '../js/models/Host.js';
import { BackendClient } from '../js/api/BackendClient.js';

/**
 * Issue #24 — Moonlight's model on a host whose app outlives the stream: Stop
 * leaves the game running, and its card is where the viewer gets back to it
 * (click = resume) or closes it (Quit). Only that one card changes, and only
 * where the server says the app is ours to keep.
 */
describe('the running app card', () => {
    let view;
    let container;

    const APPS = [
        { id: 1, name: 'Desktop' },
        { id: 2, name: 'Cyberpunk 2077' },
    ];

    const mount = (hostData) => {
        localStorage.setItem(
            'mw-host-apps',
            JSON.stringify({ 'host-a': { ts: Date.now(), apps: APPS } }),
        );
        document.body.innerHTML = '<div id="root"></div>';
        container = document.getElementById('root');
        view = new HostListView(container);
        view.hosts = [
            new Host({
                uuid: 'host-a',
                name: 'BENCH-DESK',
                state: 'online',
                pairState: 'paired',
                ...hostData,
            }),
        ];
        view.renderList();
    };

    const cardOf = (id) => container.querySelector(`.app-card[data-app-id="${id}"]`);

    beforeEach(() => {
        vi.clearAllMocks();
        BackendClient.getAppList.mockReturnValue(new Promise(() => {})); // never answers
    });

    afterEach(() => {
        if (view) view.destroy();
        view = null;
        localStorage.clear();
        vi.restoreAllMocks();
    });

    it('marks the running app, and only that one, with a badge and a Quit button', () => {
        mount({ resumableApps: true, currentGameId: 2 });

        const running = cardOf(2);
        expect(running.classList.contains('app-card--running')).toBe(true);
        expect(running.querySelector('.app-card-badge')).not.toBeNull();
        expect(running.querySelector('.app-card-quit')).not.toBeNull();
        // Reads as a resume, not a launch (i18n keys: no locale is loaded here).
        expect(running.getAttribute('aria-label')).toBe('apps.resumeAria');

        const idle = cardOf(1);
        expect(idle.classList.contains('app-card--running')).toBe(false);
        expect(idle.querySelector('.app-card-quit')).toBeNull();
        expect(idle.getAttribute('aria-label')).toBe('apps.launchAria');
    });

    it('shows nothing where the app is not kept (Wolf, the native host)', () => {
        mount({ resumableApps: false, currentGameId: 2 });
        expect(container.querySelector('.app-card--running')).toBeNull();
        expect(container.querySelector('.app-card-quit')).toBeNull();
    });

    it('shows nothing when no app runs', () => {
        mount({ resumableApps: true, currentGameId: 0 });
        expect(container.querySelector('.app-card--running')).toBeNull();
    });

    it('Quit asks first, closes the app on the host, and never launches it', async () => {
        mount({ resumableApps: true, currentGameId: 2 });
        const onLaunch = vi.fn();
        view.onLaunchApp = onLaunch;
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        BackendClient.stopHostSession.mockResolvedValue({ status: 'stopped', currentGameId: 0 });
        vi.spyOn(view, 'refresh').mockResolvedValue(undefined);

        cardOf(2).querySelector('.app-card-quit').click();
        expect(BackendClient.stopHostSession).not.toHaveBeenCalled();
        document.querySelector('.mw-confirm-overlay [data-answer="yes"]').click();
        await vi.waitFor(() => expect(view.hosts[0].currentGameId).toBe(0));

        expect(window.confirm).not.toHaveBeenCalled();
        expect(BackendClient.stopHostSession).toHaveBeenCalledWith('host-a');
        expect(onLaunch).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(container.querySelector('.app-card--running')).toBeNull());
    });

    it('Quit declined leaves the app running', async () => {
        mount({ resumableApps: true, currentGameId: 2 });
        view.onLaunchApp = vi.fn();
        vi.spyOn(window, 'confirm').mockReturnValue(false);

        cardOf(2).querySelector('.app-card-quit').click();

        document.querySelector('.mw-confirm-overlay [data-answer="no"]').click();
        await Promise.resolve();
        expect(window.confirm).not.toHaveBeenCalled();
        expect(BackendClient.stopHostSession).not.toHaveBeenCalled();
        expect(view.onLaunchApp).not.toHaveBeenCalled();
        expect(cardOf(2).classList.contains('app-card--running')).toBe(true);
    });

    it('also confirms stopping from the host menu inside the app', async () => {
        mount({ resumableApps: true, currentGameId: 2 });
        const stop = container.querySelector('.btn-stop-session');
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        vi.spyOn(view, 'refresh').mockResolvedValue(undefined);
        BackendClient.stopHostSession.mockResolvedValue({ status: 'stopped' });
        stop.click();
        expect(BackendClient.stopHostSession).not.toHaveBeenCalled();
        document.querySelector('.mw-confirm-overlay [data-answer="yes"]').click();
        await vi.waitFor(() =>
            expect(BackendClient.stopHostSession).toHaveBeenCalledWith('host-a'),
        );
        expect(window.confirm).not.toHaveBeenCalled();
    });

    // MultiSeat: each device has its own seat, so the host's currentGameId —
    // the machine's own GameStream server — is nobody's here. The card shows
    // what THIS device's seat runs, as the host list asked it.
    it("on a per-device host, ignores the machine's app and shows this device's seat's", async () => {
        BackendClient.getRunningApp.mockResolvedValue({ currentGameId: 2 });
        mount({ resumableApps: true, runningAppPerDevice: true, currentGameId: 1 });
        expect(view.hosts[0].currentGameId).toBe(0);
        expect(container.querySelector('.app-card--running')).toBeNull();

        view._active = true;
        view._refreshDeviceRunning();

        expect(BackendClient.getRunningApp).toHaveBeenCalledWith('host-a');
        await vi.waitFor(() =>
            expect(cardOf(2).classList.contains('app-card--running')).toBe(true),
        );
        expect(cardOf(1).classList.contains('app-card--running')).toBe(false);
    });
});
