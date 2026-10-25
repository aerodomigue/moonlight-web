export function exclusiveSettings(settings = {}) {
    const legacy = Object.prototype.hasOwnProperty.call(settings, 'gaming_mode');
    return {
        mode: ['mouse', 'keyboard', 'both'].includes(settings.exclusive_mode)
            ? settings.exclusive_mode
            : legacy && settings.gaming_mode
              ? 'both'
              : 'mouse',
        enabled:
            typeof settings.exclusive_enabled === 'boolean'
                ? settings.exclusive_enabled
                : legacy
                  ? settings.gaming_mode === true
                  : true,
    };
}

// Desired capture and browser-granted capture are deliberately separate.
export class ExclusiveInput {
    constructor({
        element,
        mode,
        enabled,
        releaseInputs,
        change,
        doc = document,
        win = window,
        keyboard = navigator.keyboard,
    }) {
        Object.assign(this, { element, mode, enabled, releaseInputs, change, doc, win, keyboard });
        this.suspended = false;
        this.closed = false;
        this.pointerPending = false;
        this.keyboardPending = false;
        this.keyboardLocked = false;
        this.pointerLocked = false;
        this.needsGesture = false;
        this.keyboardUnavailable = false;
        this.generation = 0;
        this.expectedUnlock = false;
        this.onBlur = () => this.suspend();
        this.onFocus = () => this.resume();
        this.onVisibility = () => (doc.hidden ? this.suspend() : this.resume());
        this.onPointer = () => this.pointerChanged();
        this.onPointerError = () => {
            if (this.wantsMouse && !this.suspended && !this.closed) {
                this.needsGesture = true;
                this.notify();
            }
        };
        this.onFullscreen = () => this.syncKeyboard();
        this.onEscape = (event) => {
            // A granted Keyboard Lock delivers short Escape presses to the
            // stream. Releasing it here would swallow the remote key and hand
            // fullscreen back to the browser. Its long-Escape escape hatch is
            // still handled by the browser, not by this keydown listener.
            if (event.key === 'Escape' && this.enabled && !this.keyboardLocked) this.disable();
        };
        win.addEventListener('blur', this.onBlur);
        win.addEventListener('focus', this.onFocus);
        doc.addEventListener('visibilitychange', this.onVisibility);
        doc.addEventListener('pointerlockchange', this.onPointer);
        doc.addEventListener('pointerlockerror', this.onPointerError);
        doc.addEventListener('fullscreenchange', this.onFullscreen);
        doc.addEventListener('keydown', this.onEscape, true);
    }
    get wantsMouse() {
        return this.enabled && this.mode !== 'keyboard';
    }
    get wantsKeyboard() {
        return this.enabled && this.mode !== 'mouse';
    }
    get foreground() {
        return !this.doc.hidden && this.doc.hasFocus();
    }
    notify() {
        if (!this.closed) this.change(this);
    }
    async attempt() {
        if (this.closed || !this.enabled || this.suspended || !this.foreground) return;
        this.needsGesture = false;
        const generation = this.generation;
        if (
            this.wantsMouse &&
            !this.pointerPending &&
            this.doc.pointerLockElement !== this.element
        ) {
            if (this.doc.pointerLockElement) {
                this.needsGesture = true;
                this.syncKeyboard();
                this.notify();
                return;
            }
            this.pointerPending = true;
            try {
                // Standard, OS-adjusted motion. No raw input permission request.
                await this.element.requestPointerLock();
                if (this.closed || generation !== this.generation) {
                    if (this.doc.pointerLockElement === this.element) {
                        this.expectedUnlock = true;
                        this.doc.exitPointerLock();
                    }
                }
            } catch (_) {
                if (!this.closed && generation === this.generation) this.needsGesture = true;
            } finally {
                this.pointerPending = false;
                if (
                    generation !== this.generation &&
                    !this.closed &&
                    this.enabled &&
                    !this.suspended
                )
                    this.attempt();
            }
        }
        if (generation === this.generation && !this.closed) {
            this.syncKeyboard();
            this.notify();
        }
    }
    syncKeyboard() {
        if (this.closed) return;
        if (
            !this.wantsKeyboard ||
            this.suspended ||
            !this.foreground ||
            !this.doc.fullscreenElement
        ) {
            if (this.keyboardLocked || this.keyboardPending) this.keyboard?.unlock?.();
            this.keyboardLocked = false;
            this.keyboardUnavailable = this.wantsKeyboard && !this.doc.fullscreenElement;
            this.notify();
            return;
        }
        if (!this.keyboard?.lock) {
            this.keyboardUnavailable = true;
            this.notify();
            return;
        }
        if (this.keyboardPending || this.keyboardLocked) return;
        const generation = this.generation;
        this.keyboardPending = true;
        Promise.resolve()
            .then(() => {
                if (generation !== this.generation || this.closed) return;
                return this.keyboard.lock();
            })
            .then(
                () => {
                    if (
                        generation !== this.generation ||
                        this.closed ||
                        this.suspended ||
                        !this.wantsKeyboard ||
                        !this.doc.fullscreenElement ||
                        !this.foreground
                    ) {
                        this.keyboard.unlock();
                        return;
                    }
                    this.keyboardLocked = true;
                    this.keyboardUnavailable = false;
                },
                () => {
                    if (generation === this.generation) {
                        this.keyboardUnavailable = true;
                        this.needsGesture = true;
                    }
                },
            )
            .finally(() => {
                this.keyboardPending = false;
                if (
                    generation !== this.generation &&
                    !this.closed &&
                    this.enabled &&
                    !this.suspended
                )
                    this.syncKeyboard();
                this.notify();
            });
    }
    pointerChanged() {
        const wasLocked = this.pointerLocked;
        this.pointerLocked = this.doc.pointerLockElement === this.element;
        if (this.pointerLocked) {
            this.expectedUnlock = false;
            if (!this.wantsMouse || this.suspended || this.closed) {
                this.expectedUnlock = true;
                this.doc.exitPointerLock();
                return;
            }
            this.needsGesture = false;
        } else if (this.expectedUnlock) {
            this.expectedUnlock = false;
        } else if (wasLocked) {
            // Give blur/visibility events from a desktop switch the same turn.
            clearTimeout(this.lossTimer);
            this.lossTimer = setTimeout(() => {
                if (this.closed || this.doc.pointerLockElement === this.element) return;
                if (!this.foreground || this.suspended) this.suspend();
                else this.disable(); // explicit browser unlock: never recapture it
            }, 0);
        }
        this.notify();
    }
    dropLocks() {
        ++this.generation;
        this.releaseInputs();
        if (this.doc.pointerLockElement === this.element) {
            this.expectedUnlock = true;
            this.doc.exitPointerLock();
        }
        this.keyboard?.unlock?.();
        this.keyboardLocked = false;
        this.pointerLocked = false;
    }
    suspend() {
        if (this.closed || this.suspended) return;
        this.suspended = true;
        this.dropLocks();
        this.notify();
    }
    resume() {
        if (this.closed || !this.foreground || !this.suspended) return;
        this.suspended = false;
        this.attempt();
    }
    disable() {
        this.enabled = false;
        this.needsGesture = false;
        this.dropLocks();
        this.notify();
    }
    toggle() {
        if (this.closed) return;
        if (
            this.enabled &&
            !this.suspended &&
            !this.needsGesture &&
            (!this.wantsMouse || this.doc.pointerLockElement === this.element)
        ) {
            this.disable();
        } else {
            this.enabled = true;
            this.suspended = false;
            this.notify();
            this.attempt();
        }
    }
    select(mode) {
        if (!['mouse', 'keyboard', 'both'].includes(mode)) return;
        this.dropLocks();
        this.mode = mode;
        this.notify();
        this.attempt();
    }
    destroy() {
        this.closed = true;
        this.enabled = false;
        this.dropLocks();
        clearTimeout(this.lossTimer);
        this.win.removeEventListener('blur', this.onBlur);
        this.win.removeEventListener('focus', this.onFocus);
        this.doc.removeEventListener('visibilitychange', this.onVisibility);
        this.doc.removeEventListener('pointerlockchange', this.onPointer);
        this.doc.removeEventListener('pointerlockerror', this.onPointerError);
        this.doc.removeEventListener('fullscreenchange', this.onFullscreen);
        this.doc.removeEventListener('keydown', this.onEscape, true);
    }
}
