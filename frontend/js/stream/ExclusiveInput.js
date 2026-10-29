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
        this.pointerNeedsGesture = false;
        this.keyboardNeedsGesture = false;
        this.keyboardUnavailable = false;
        this.generation = 0;
        this.keyboardGeneration = 0;
        this.expectedUnlock = false;
        this.escapeHeld = false;
        this.onBlur = () => this.suspend();
        this.onFocus = () => {
            if (this.closed || !this.foreground) return;
            if (this.suspended) this.resume();
            else if (this.keyboardLocked) {
                // A remembered grant is not proof after an OS/window switch.
                this.invalidateKeyboard();
                this.syncKeyboard();
            }
        };
        this.onVisibility = () => (doc.hidden ? this.suspend() : this.resume());
        this.onPointer = () => this.pointerChanged();
        this.onPointerError = () => {
            if (this.wantsMouse && !this.suspended && !this.closed) {
                this.pointerNeedsGesture = true;
                this.notify();
            }
        };
        this.onFullscreen = () => this.syncKeyboard();
        this.onEscape = (event) => {
            // A granted Keyboard Lock delivers short Escape presses to the
            // stream. Releasing it here would swallow the remote key and hand
            // fullscreen back to the browser. Its long-Escape escape hatch is
            // still handled by the browser, not by this keydown listener.
            if (event.key !== 'Escape') return;
            this.escapeHeld = true;
            if (this.enabled && !this.keyboardLocked) this.disable();
        };
        this.onEscapeUp = (event) => {
            if (event.key === 'Escape') this.escapeHeld = false;
        };
        win.addEventListener('blur', this.onBlur);
        win.addEventListener('focus', this.onFocus);
        doc.addEventListener('visibilitychange', this.onVisibility);
        doc.addEventListener('pointerlockchange', this.onPointer);
        doc.addEventListener('pointerlockerror', this.onPointerError);
        doc.addEventListener('fullscreenchange', this.onFullscreen);
        doc.addEventListener('keydown', this.onEscape, true);
        doc.addEventListener('keyup', this.onEscapeUp, true);
    }
    get wantsMouse() {
        return this.enabled && this.mode !== 'keyboard';
    }
    get wantsKeyboard() {
        return this.enabled && this.mode !== 'mouse';
    }
    get needsGesture() {
        return (
            (this.wantsMouse && this.pointerNeedsGesture) ||
            (this.wantsKeyboard && this.keyboardNeedsGesture)
        );
    }
    get foreground() {
        return !this.doc.hidden && this.doc.hasFocus();
    }
    notify() {
        if (!this.closed) this.change(this);
    }
    // Fullscreen can release locks on some browser/platform combinations.
    // Fence those releases before invoking the API, without changing intent.
    async transitionFullscreen(operation) {
        if (this.closed || this.fullscreenPending) return;
        this.fullscreenPending = true;
        clearTimeout(this.lossTimer);
        this.dropLocks();
        try {
            // Invoke synchronously: requestFullscreen consumes user activation.
            await operation();
        } finally {
            this.fullscreenPending = false;
            this.attempt();
        }
    }
    async attempt() {
        if (
            this.closed ||
            this.fullscreenPending ||
            !this.enabled ||
            this.suspended ||
            !this.foreground
        )
            return;
        this.pointerNeedsGesture = false;
        // Never wait for pointer permission/grant before protecting Escape.
        const keyboardAttempt = this.syncKeyboard();
        const generation = this.generation;
        if (
            this.wantsMouse &&
            !this.pointerPending &&
            this.doc.pointerLockElement !== this.element
        ) {
            if (this.doc.pointerLockElement) {
                this.pointerNeedsGesture = true;
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
                if (!this.closed && generation === this.generation) this.pointerNeedsGesture = true;
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
        await keyboardAttempt;
        if (generation === this.generation && !this.closed) {
            this.notify();
        }
    }
    syncKeyboard() {
        if (this.closed || this.fullscreenPending) return;
        if (
            !this.wantsKeyboard ||
            this.suspended ||
            !this.foreground ||
            !this.doc.fullscreenElement
        ) {
            this.invalidateKeyboard();
            this.keyboardUnavailable = this.wantsKeyboard && !this.doc.fullscreenElement;
            this.notify();
            return;
        }
        if (!this.keyboard?.lock) {
            this.keyboardUnavailable = true;
            this.notify();
            return;
        }
        if (this.keyboardPending) return this.keyboardCompletion;
        if (this.keyboardLocked) return;
        const generation = this.keyboardGeneration;
        this.keyboardNeedsGesture = false;
        this.keyboardPending = true;
        return (this.keyboardCompletion = Promise.resolve()
            .then(() => {
                if (generation !== this.keyboardGeneration || this.closed) return;
                return this.keyboard.lock();
            })
            .then(
                () => {
                    if (
                        generation !== this.keyboardGeneration ||
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
                    if (generation === this.keyboardGeneration) {
                        this.keyboardUnavailable = true;
                        this.keyboardNeedsGesture = true;
                    }
                },
            )
            .finally(() => {
                this.keyboardPending = false;
                this.notify();
                if (
                    generation !== this.keyboardGeneration &&
                    !this.closed &&
                    this.enabled &&
                    !this.suspended
                )
                    return this.syncKeyboard();
            }));
    }

    pointerChanged() {
        const wasLocked = this.pointerLocked;
        this.pointerLocked = this.doc.pointerLockElement === this.element;
        if (this.pointerLocked) {
            this.expectedUnlock = false;
            if (!this.wantsMouse || this.suspended || this.closed || this.fullscreenPending) {
                this.expectedUnlock = true;
                this.doc.exitPointerLock();
                return;
            }
            this.pointerNeedsGesture = false;
        } else if (this.expectedUnlock) {
            this.expectedUnlock = false;
        } else if (wasLocked) {
            // Chromium may drop pointer lock a task BEFORE blur/visibility.
            // With Keyboard Lock, Escape is observable: an unexplained loss
            // must not permanently disable the user's capture intent.
            const unexpected = this.keyboardLocked && !this.escapeHeld;
            clearTimeout(this.lossTimer);
            this.lossTimer = setTimeout(() => {
                if (this.closed || this.doc.pointerLockElement === this.element) return;
                if (!this.foreground || this.suspended) this.suspend();
                else if (unexpected) {
                    this.pointerNeedsGesture = true;
                    this.notify(); // no automatic pointer retry while still focused
                } else this.disable(); // browser/user escape: never recapture it
            }, 0);
        }
        this.notify();
    }
    invalidateKeyboard() {
        ++this.keyboardGeneration;
        if (this.keyboardLocked || this.keyboardPending) this.keyboard?.unlock?.();
        this.keyboardLocked = false;
    }
    dropLocks() {
        ++this.generation;
        this.releaseInputs();
        if (this.doc.pointerLockElement === this.element) {
            this.expectedUnlock = true;
            this.doc.exitPointerLock();
        }
        this.invalidateKeyboard();
        this.pointerLocked = false;
    }
    suspend() {
        if (this.closed || this.suspended) return;
        this.suspended = true;
        this.escapeHeld = false;
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
        this.pointerNeedsGesture = false;
        this.keyboardNeedsGesture = false;
        this.dropLocks();
        this.notify();
    }
    toggle() {
        if (this.closed) return;
        if (
            this.enabled &&
            !this.suspended &&
            !this.needsGesture &&
            (this.fullscreenPending ||
                !this.wantsMouse ||
                this.doc.pointerLockElement === this.element)
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
        this.doc.removeEventListener('keyup', this.onEscapeUp, true);
    }
}
