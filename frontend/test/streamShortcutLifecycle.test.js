/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { StreamView } from '../js/ui/StreamView.js';

/** Application shortcuts consume exactly one action and no remote keystroke. */
function keySink() {
    const sent = [];
    return {
        sent,
        host: null,
        webrtc: { send: (m) => sent.push(m) },
        _heldPhysKeys: new Map(),
        _metaTapCodes: new Set(),
        _swallowKeyUpCodes: new Set(),
        _appleKeyboard: false,
        _quitting: false,
        _kbdCapture: null,
        _locksSynced: true,
        _cssFullscreen: false,
        _clipboardEnabled: false,
        _layoutMap: null,
        _gamingMode: false,
        _pendingPasteKey: null,
        _suppressPasteKeyUpCode: null,
        toggleMute: vi.fn(() => true),
        handleKeyDown: StreamView.prototype.handleKeyDown,
        handleKeyUp: StreamView.prototype.handleKeyUp,
        toggleFullscreen: vi.fn(),
        toggleMouseMode: vi.fn(),
        _exitGamingMode: vi.fn(),
        _handleManualQuit: vi.fn(),
        _toggleStatsFromMenu: vi.fn(),
        sendDesktopSwitch: vi.fn(),
        _sendKeyEvent: StreamView.prototype._sendKeyEvent,
        _reconcileModifiers: StreamView.prototype._reconcileModifiers,
        _forgetHeldKey: StreamView.prototype._forgetHeldKey,
        _holdsThroughStall: StreamView.prototype._holdsThroughStall,
        _releaseKeysHeldUnderMeta: StreamView.prototype._releaseKeysHeldUnderMeta,
        _sendPendingPasteKey: StreamView.prototype._sendPendingPasteKey,
        _syncLockState: () => {},
    };
}

function ev(code, key, mods = {}) {
    return {
        target: {},
        code,
        key,
        keyCode: 0,
        repeat: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        preventDefault() {},
        ...mods,
    };
}

const winCombo = { ctrlKey: true, altKey: true, shiftKey: true };

afterEach(() => vi.restoreAllMocks());
const actions = [
    ['x', 'toggleFullscreen'],
    ['m', 'toggleMouseMode'],
    ['z', '_exitGamingMode'],
    ['q', '_handleManualQuit'],
    ['s', 'toggleMute'],
    ['i', '_toggleStatsFromMenu'],
];
it.each(actions)('requires all three macOS modifiers for %s', (letter, action) => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    const v = keySink();
    v.handleKeyDown(ev('Key' + letter.toUpperCase(), letter, { ctrlKey: true, altKey: true }));
    expect(v[action]).not.toHaveBeenCalled();
    v.handleKeyDown(
        ev('Key' + letter.toUpperCase(), letter, { ctrlKey: true, altKey: true, metaKey: true }),
    );
    expect(v[action]).toHaveBeenCalledTimes(1);
});
it.each(actions)(
    'consumes %s down/repeat/up even if modifiers are released first',
    (letter, action) => {
        vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Linux');
        const v = keySink();
        const code = 'Key' + letter.toUpperCase();
        v.handleKeyDown(ev(code, letter, winCombo));
        v.handleKeyDown(ev(code, letter, { ...winCombo, repeat: true }));
        v.handleKeyUp(ev(code, letter));
        expect(v[action]).toHaveBeenCalledTimes(1);
        expect(v.sent).toEqual([]);
        v.handleKeyDown(ev(code, letter));
        v.handleKeyUp(ev(code, letter));
        expect(v.sent.map((m) => m.type)).toEqual(['keydown', 'keyup']);
    },
);
it('resolves AZERTY labels under macOS Option using the layout map', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    const v = keySink();
    v._layoutMap = new Map([
        ['Semicolon', 'm'],
        ['KeyM', ','],
    ]);
    const mods = { ctrlKey: true, altKey: true, metaKey: true };
    v.handleKeyDown(ev('Semicolon', 'µ', mods));
    v.handleKeyDown(ev('KeyM', '?', mods));
    expect(v.toggleMouseMode).toHaveBeenCalledTimes(1);
});
it('does not replace Ctrl with Meta on Windows', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
    const v = keySink();
    v.handleKeyDown(ev('KeyX', 'x', { metaKey: true, altKey: true, shiftKey: true }));
    expect(v.toggleFullscreen).not.toHaveBeenCalled();
});
