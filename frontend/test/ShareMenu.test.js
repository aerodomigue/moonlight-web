import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../js/api/BackendClient.js', () => ({
    BackendClient: { canManageShares: true, getShareStatus: vi.fn() },
}));
vi.mock('../js/i18n/i18n.js', () => ({ t: (key) => key }));
import { BackendClient } from '../js/api/BackendClient.js';
import { ShareMenu } from '../js/ui/ShareMenu.js';

describe('share menu authorization and lifecycle', () => {
    let menu;
    beforeEach(() => {
        vi.useFakeTimers();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        document.body.innerHTML = '<header><button id="stop"></button></header>';
        BackendClient.canManageShares = true;
        BackendClient.getShareStatus.mockReset().mockResolvedValue({ slots: [] });
        menu = new ShareMenu(document.querySelector('header'), document.querySelector('#stop'));
    });
    afterEach(() => {
        menu.destroy();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });
    it('does not request or render sharing without the capability', async () => {
        BackendClient.canManageShares = false;
        expect(await menu.mount()).toBe(false);
        await vi.advanceTimersByTimeAsync(30000);
        expect(BackendClient.getShareStatus).not.toHaveBeenCalled();
    });
    it.each([401, 403, 404])('stops permanently on %i', async (statusCode) => {
        BackendClient.getShareStatus.mockRejectedValue({ statusCode });
        expect(await menu.mount()).toBe(false);
        await vi.advanceTimersByTimeAsync(60000);
        expect(BackendClient.getShareStatus).toHaveBeenCalledTimes(1);
        expect(document.querySelector('.share-menu')).toBeNull();
    });
    it('aborts mounting and ignores its late response after destruction', async () => {
        let finish;
        BackendClient.getShareStatus.mockImplementation(
            () =>
                new Promise((r) => {
                    finish = r;
                }),
        );
        const mounting = menu.mount();
        const signal = BackendClient.getShareStatus.mock.calls[0][1].signal;
        menu.destroy();
        expect(signal.aborted).toBe(true);
        finish({ slots: [] });
        expect(await mounting).toBe(false);
        expect(document.querySelector('.share-menu')).toBeNull();
    });
    it('does not overlap requests and backs off transient failures', async () => {
        await menu.mount();
        let reject;
        BackendClient.getShareStatus.mockImplementation(
            () =>
                new Promise((_, r) => {
                    reject = r;
                }),
        );
        await vi.advanceTimersByTimeAsync(20000);
        expect(BackendClient.getShareStatus).toHaveBeenCalledTimes(2);
        reject({ statusCode: 503 });
        await vi.advanceTimersByTimeAsync(9999);
        expect(BackendClient.getShareStatus).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(BackendClient.getShareStatus).toHaveBeenCalledTimes(3);
    });
    it('removes the menu when permission is lost after mounting', async () => {
        await menu.mount();
        BackendClient.getShareStatus.mockRejectedValue({ statusCode: 403 });
        await vi.advanceTimersByTimeAsync(60000);
        expect(BackendClient.getShareStatus).toHaveBeenCalledTimes(2);
        expect(document.querySelector('.share-menu')).toBeNull();
    });
});
