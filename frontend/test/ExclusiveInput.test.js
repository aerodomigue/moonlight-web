import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExclusiveInput, exclusiveSettings } from '../js/stream/ExclusiveInput.js';
describe('exclusive input lifecycle', () => {
    let capture, doc, win, keyboard, element, release, focus;
    const tick = async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
    };
    beforeEach(() => {
        vi.useFakeTimers();
        focus = true;
        doc = new EventTarget();
        win = new EventTarget();
        Object.assign(doc, {
            hidden: false,
            fullscreenElement: {},
            hasFocus: () => focus,
            pointerLockElement: null,
            exitPointerLock: vi.fn(() => {
                doc.pointerLockElement = null;
                doc.dispatchEvent(new Event('pointerlockchange'));
            }),
        });
        element = {
            requestPointerLock: vi.fn(async () => {
                doc.pointerLockElement = element;
                doc.dispatchEvent(new Event('pointerlockchange'));
            }),
        };
        keyboard = { lock: vi.fn().mockResolvedValue(), unlock: vi.fn() };
        release = vi.fn();
        capture = new ExclusiveInput({
            element,
            mode: 'both',
            enabled: true,
            releaseInputs: release,
            change: vi.fn(),
            doc,
            win,
            keyboard,
        });
    });
    afterEach(() => {
        capture.destroy();
        vi.useRealTimers();
    });
    it.each(['mouse', 'keyboard', 'both'])(
        'captures %s independently and toggles off without exiting fullscreen',
        async (mode) => {
            capture.mode = mode;
            await capture.attempt();
            await tick();
            expect(element.requestPointerLock).toHaveBeenCalledTimes(mode === 'keyboard' ? 0 : 1);
            expect(keyboard.lock).toHaveBeenCalledTimes(mode === 'mouse' ? 0 : 1);
            expect(element.requestPointerLock.mock.calls.every((c) => c.length === 0)).toBe(true);
            capture.toggle();
            expect(capture.enabled).toBe(false);
            expect(doc.fullscreenElement).not.toBe(null);
        },
    );
    it('suspends on desktop change and attempts one recapture at focus', async () => {
        await capture.attempt();
        focus = false;
        win.dispatchEvent(new Event('blur'));
        expect(capture.enabled).toBe(true);
        expect(release).toHaveBeenCalledTimes(1);
        focus = true;
        win.dispatchEvent(new Event('focus'));
        doc.dispatchEvent(new Event('visibilitychange'));
        await tick();
        expect(element.requestPointerLock).toHaveBeenCalledTimes(2);
    });
    it('waits for the shortcut when the browser requires a gesture', async () => {
        element.requestPointerLock.mockRejectedValueOnce(new Error('NotAllowedError'));
        await capture.attempt();
        expect(capture.needsGesture).toBe(true);
        win.dispatchEvent(new Event('focus'));
        await tick();
        expect(element.requestPointerLock).toHaveBeenCalledTimes(1);
        capture.toggle();
        await tick();
        expect(doc.pointerLockElement).toBe(element);
    });
    it('retries keyboard-only capture with the same shortcut after a permission refusal', async () => {
        capture.mode = 'keyboard';
        keyboard.lock.mockRejectedValueOnce(new Error('NotAllowedError'));
        await capture.attempt();
        await tick();
        expect(capture.needsGesture).toBe(true);
        win.dispatchEvent(new Event('focus'));
        await tick();
        expect(keyboard.lock).toHaveBeenCalledTimes(1);
        capture.toggle();
        await tick();
        expect(keyboard.lock).toHaveBeenCalledTimes(2);
        expect(capture.keyboardLocked).toBe(true);
        expect(capture.enabled).toBe(true);
    });
    it('never recaptures after voluntary release', async () => {
        await capture.attempt();
        doc.pointerLockElement = null;
        doc.dispatchEvent(new Event('pointerlockchange'));
        await vi.advanceTimersByTimeAsync(0);
        expect(capture.enabled).toBe(false);
        focus = false;
        win.dispatchEvent(new Event('blur'));
        focus = true;
        win.dispatchEvent(new Event('focus'));
        await tick();
        expect(element.requestPointerLock).toHaveBeenCalledTimes(1);
    });
    it('releases a late pointer grant after destruction', async () => {
        let complete;
        element.requestPointerLock.mockImplementation(
            () =>
                new Promise((r) => {
                    complete = () => {
                        doc.pointerLockElement = element;
                        r();
                    };
                }),
        );
        const attempt = capture.attempt();
        capture.destroy();
        complete();
        await attempt;
        expect(doc.pointerLockElement).toBe(null);
        expect(keyboard.lock).not.toHaveBeenCalled();
    });
    it('reports keyboard unavailable outside fullscreen without capturing the mouse', async () => {
        capture.mode = 'keyboard';
        doc.fullscreenElement = null;
        await capture.attempt();
        expect(capture.keyboardUnavailable).toBe(true);
        expect(keyboard.lock).not.toHaveBeenCalled();
        expect(element.requestPointerLock).not.toHaveBeenCalled();
    });
    it('captures the keyboard independently when another view owns the pointer', async () => {
        doc.pointerLockElement = {};
        await capture.attempt();
        await tick();
        expect(element.requestPointerLock).not.toHaveBeenCalled();
        expect(keyboard.lock).toHaveBeenCalledOnce();
        expect(capture.needsGesture).toBe(true);
    });
    it('Escape releases both captures and prevents focus recapture', async () => {
        await capture.attempt();
        await tick();
        const event = new Event('keydown');
        event.key = 'Escape';
        doc.dispatchEvent(event);
        expect(capture.enabled).toBe(false);
        expect(doc.pointerLockElement).toBe(null);
        expect(capture.keyboardLocked).toBe(false);
        focus = false;
        win.dispatchEvent(new Event('blur'));
        focus = true;
        win.dispatchEvent(new Event('focus'));
        await tick();
        expect(element.requestPointerLock).toHaveBeenCalledOnce();
    });
    it('migrates old settings while separating selection and activation', () => {
        expect(exclusiveSettings({ gaming_mode: true })).toEqual({ mode: 'both', enabled: true });
        expect(exclusiveSettings({ gaming_mode: false })).toEqual({
            mode: 'mouse',
            enabled: false,
        });
        expect(exclusiveSettings({})).toEqual({ mode: 'mouse', enabled: true });
        expect(
            exclusiveSettings({
                gaming_mode: true,
                exclusive_mode: 'keyboard',
                exclusive_enabled: false,
            }),
        ).toEqual({ mode: 'keyboard', enabled: false });
    });
});

describe('exclusive capture promise races', () => {
    it('does not keep a stale keyboard lock after a mode change', async () => {
        const doc = new EventTarget();
        Object.assign(doc, {
            hidden: false,
            fullscreenElement: {},
            hasFocus: () => true,
            pointerLockElement: null,
        });
        let grant;
        const keyboard = {
            lock: vi.fn(
                () =>
                    new Promise((r) => {
                        grant = r;
                    }),
            ),
            unlock: vi.fn(),
        };
        const capture = new ExclusiveInput({
            element: {},
            mode: 'keyboard',
            enabled: true,
            releaseInputs() {},
            change() {},
            doc,
            win: new EventTarget(),
            keyboard,
        });
        await capture.attempt();
        await Promise.resolve();
        capture.disable();
        grant();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(capture.keyboardLocked).toBe(false);
        expect(keyboard.unlock).toHaveBeenCalled();
        capture.destroy();
    });
});
