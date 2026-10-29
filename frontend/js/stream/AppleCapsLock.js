// macOS browsers report Caps Lock transitions, not reliable physical holds:
// Chrome can send only down for "on" and only up for "off"; Firefox only down.
export function handleAppleCapsLock(view, event, down) {
    if (!view._appleKeyboard || event.code !== 'CapsLock') return false;
    event.preventDefault();
    if (event.repeat) return true;
    const state =
        typeof event.getModifierState === 'function'
            ? event.getModifierState('CapsLock')
            : undefined;
    if (state === undefined ? !down : view._appleCapsLockState === state) return true;
    view._appleCapsLockState = state;
    if (!view._locksSynced) view._syncLockState(event);
    const key = { keyCode: 0x14, code: 'CapsLock', key: 'CapsLock' };
    view._sendKeyEvent({ type: 'keydown', ...key });
    view._sendKeyEvent({ type: 'keyup', ...key });
    return true;
}
