/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { StreamView } from '../js/ui/StreamView.js';

/** A late pointer-lock event must never resurrect the removed permanent hint.
 * Capture failures are reported by _applyExclusiveState with a transient notice. */
function view({ gaming, locked }) {
    const inputEl = document.createElement('div');
    const hintEl = document.createElement('div');
    hintEl.style.display = 'flex';
    Object.defineProperty(document, 'pointerLockElement', {
        configurable: true,
        get: () => (locked ? inputEl : null),
    });
    return {
        _gamingMode: gaming,
        inputEl,
        hintEl,
        _disarmPointerCapture() {},
        _syncKeyboardLock() {},
        _updateGamingOverlay() {},
        _sendCursorMode() {},
    };
}

describe('the click-to-capture hint', () => {
    afterEach(() => {
        delete document.pointerLockElement;
    });

    it('stays hidden after capture is disabled', () => {
        const v = view({ gaming: false, locked: false });
        StreamView.prototype.handlePointerLockChange.call(v);
        expect(v.hintEl.style.display).toBe('none');
    });

    it('stays hidden when the mouse is released with capture still enabled', () => {
        const v = view({ gaming: true, locked: false });
        v.hintEl.style.display = 'none';
        StreamView.prototype.handlePointerLockChange.call(v);
        expect(v.hintEl.style.display).toBe('none');
    });

    it('stays hidden when capture takes the mouse', () => {
        const v = view({ gaming: true, locked: true });
        StreamView.prototype.handlePointerLockChange.call(v);
        expect(v.hintEl.style.display).toBe('none');
    });
});
