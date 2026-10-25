import { describe, it, expect } from 'vitest';
import { StreamView } from '../js/ui/StreamView.js';

describe('standard exclusive mouse input', () => {
    it('sends each adjusted movement once and ignores raw reports', () => {
        const sent = [];
        const view = {
            inputEl: document.createElement('div'),
            _mouseFocused: true,
            _onPointerLockChange() {},
            _mouseSensitivity: 1,
            _mouseCarryX: 0,
            _mouseCarryY: 0,
            _mainThreadProbe: null,
            _sendToHost: (msg) => sent.push(msg),
            _sendRelativeMouse: StreamView.prototype._sendRelativeMouse,
            _noteMouseSent: StreamView.prototype._noteMouseSent,
        };
        StreamView.prototype._bindGamingEvents.call(view);
        const raw = new Event('pointerrawupdate');
        Object.assign(raw, { pointerType: 'mouse', movementX: 3, movementY: -2 });
        view.inputEl.dispatchEvent(raw);
        expect(sent).toEqual([]);
        const adjusted = new MouseEvent('mousemove');
        Object.defineProperties(adjusted, { movementX: { value: 3 }, movementY: { value: -2 } });
        view.inputEl.dispatchEvent(adjusted);
        expect(sent).toEqual([{ type: 'mousemove', dx: 3, dy: -2 }]);
        document.removeEventListener('pointerlockchange', view._onPointerLockChange);
    });
    it('keeps pacing and watchdog decisions independent of capture', () => {
        const p = StreamView.prototype;
        for (const enabled of [true, false]) {
            expect(p._frameFloorFps.call({ _gamingMode: enabled })).toBe(0);
            expect(p._holdsThroughStall.call({ _gamingMode: enabled }, 'KeyW')).toBe(true);
            expect(p._holdsThroughStall.call({ _gamingMode: enabled }, 'KeyC')).toBe(false);
        }
    });
});
