import { afterEach, describe, expect, it, vi } from 'vitest';
import { StreamView } from '../js/ui/StreamView.js';
import { exclusiveSettings } from '../js/stream/ExclusiveInput.js';
import { BackendClient } from '../js/api/BackendClient.js';

function viewFor(settings = {}) {
    const view = Object.create(StreamView.prototype);
    view._exclusive = {
        ...exclusiveSettings(settings),
        toggle() {
            this.enabled = !this.enabled;
        },
        disable() {
            this.enabled = false;
        },
    };
    return view;
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
    document.body.replaceChildren();
});

describe('settings remain authoritative', () => {
    it.each(['mouse', 'keyboard', 'both'])(
        'keeps %s preferences across temporary M/Z changes and new streams',
        (mode) => {
            const post = vi.spyOn(BackendClient, 'post');
            for (const enabled of [false, true]) {
                const settings = {
                    exclusive_mode: mode,
                    exclusive_enabled: enabled,
                    stream_fps: 180,
                };
                const stored = JSON.stringify(settings);
                localStorage.setItem('mw-streaming-settings', stored);
                const view = viewFor(settings);
                view.toggleMouseMode();
                expect(view._exclusive.enabled).toBe(!enabled);
                expect(localStorage.getItem('mw-streaming-settings')).toBe(stored);
                view._exitGamingMode();
                expect(view._exclusive.enabled).toBe(false);
                expect(localStorage.getItem('mw-streaming-settings')).toBe(stored);
                const next = viewFor(JSON.parse(localStorage.getItem('mw-streaming-settings')));
                expect(next._exclusive).toMatchObject({ mode, enabled });
            }
            expect(post).not.toHaveBeenCalled();
        },
    );
});

describe('discreet stream reminders', () => {
    it('shows M even with capture disabled, retaining the existing floating fade policy', () => {
        const view = viewFor({ exclusive_enabled: false });
        Object.assign(view, {
            _gamingOverlay: document.createElement('div'),
            _firstFrameRendered: true,
            _positionGamingOverlay: () => true,
            _setGamingOverlayFloating: vi.fn(),
        });
        view._buildGamingOverlayContent();
        view._updateGamingOverlay();
        expect(view._gamingOverlay.classList.contains('visible')).toBe(true);
        expect(view._gamingOverlay.textContent).toContain('M');
        expect(view._gamingOverlay.textContent).toContain('stream.scMouseMode');
        expect(view._setGamingOverlayFloating).toHaveBeenLastCalledWith(false);
        view._positionGamingOverlay = () => false;
        view._updateGamingOverlay();
        expect(view._setGamingOverlayFloating).toHaveBeenLastCalledWith(true);
    });
    it('reports a capture refusal once per attempt without a permanent panel', () => {
        const view = viewFor();
        Object.assign(view, {
            _setExclusiveMouse: vi.fn(),
            handlePointerLockChange: vi.fn(),
            _updateGamingOverlay: vi.fn(),
            _showTransientHint: vi.fn(),
            hintEl: document.createElement('div'),
        });
        const state = { enabled: true, wantsMouse: true, pointerLocked: false, needsGesture: true };
        view._applyExclusiveState(state);
        view._applyExclusiveState(state);
        expect(view._showTransientHint).toHaveBeenCalledOnce();
        expect(view.hintEl.style.display).toBe('none');
        view._applyExclusiveState({ ...state, needsGesture: false, pointerLocked: true });
        view._applyExclusiveState(state);
        expect(view._showTransientHint).toHaveBeenCalledTimes(2);
    });
    it('keeps rejected Apollo clipboard text for a later gesture without adding controls', async () => {
        const view = viewFor();
        const root = document.createElement('div');
        root.innerHTML = '<header class="stream-header"></header>';
        document.body.append(root);
        Object.assign(view, { _rootEl: root, streamEl: root, webrtc: { send: vi.fn() } });
        const writeText = vi
            .fn()
            .mockRejectedValueOnce(new Error('NotAllowed'))
            .mockResolvedValue();
        vi.stubGlobal('navigator', { clipboard: { writeText } });
        vi.spyOn(document, 'hasFocus').mockReturnValue(true);
        try {
            view._handleStatsMessage({
                type: 'clipboardcaps',
                remote: true,
                read: true,
                write: true,
            });
            view._handleStatsMessage({
                type: 'clipboardchunk',
                id: 'x',
                index: 0,
                total: 1,
                data: btoa('hello'),
            });
            await Promise.resolve();
            expect(view._apolloClipboard.text).toBe('hello');
            expect(root.querySelector('.clipboard-copy-action, .clipboard-capabilities')).toBe(
                null,
            );
            await view._apolloClipboard.copyPending();
            expect(writeText).toHaveBeenLastCalledWith('hello');
            expect(view._apolloClipboard.text).toBe(null);
        } finally {
            view._apolloClipboard?.destroy();
        }
    });
});
