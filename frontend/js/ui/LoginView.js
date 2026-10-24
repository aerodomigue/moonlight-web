/*
 * MoonlightWeb — browser-based Sunshine/GameStream client.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * MoonlightWeb — Login View
 *
 * Authentication for remote visitors. Supports two methods:
 *   1. PIN-based (default): user enters the PIN shown on the admin page
 *   2. Certificate-based (alternative): user uploads a certificate file
 *
 * When certificate authentication is enabled on the server, the UI shows
 * a toggle between PIN and certificate modes.
 */
import { BackendClient } from '../api/BackendClient.js';
import { Toast } from './Toast.js';
import { t } from '../i18n/i18n.js';
import { escapeHtml } from '../util/escapeHtml.js';
import { InstanceMenu } from './InstanceMenu.js';
import { currentInstanceRef, listInstances } from '../util/instances.js';
import { tunnelHostId } from '../net/tunnelBridge.js';

/** The session name last signed in under (see rememberedMachineName). */
const MACHINE_NAME_KEY = 'mw-session-name';

export class LoginView {
    constructor(container, onAuthenticated) {
        this.container = container;
        this.onAuthenticated = onAuthenticated || (() => {});

        // Internal state
        this._loading = true;
        this._error = '';
        this._remaining = 3;
        this._lockoutRemaining = 0;
        this._lockoutTimer = null;
        this._submitting = false;
        this._machineName = '';
        this._certAuthAvailable = false; // Server has cert auth enabled
        this._certMode = false; // User chose cert upload mode
        this._pinEnabled = true;
        this._ssoEnabled = false;
        this._selectedMethod = 'pin';
        this._ssoOrigin = '';

        this._selectedFileName = '';
        this._localUrl = ''; // https://localhost[:port] — the host machine's way back in
        // The other machines this browser has already been to (see _renderServerField).
        this._otherInstances = [];
        this._currentInstanceId = '';
        this._serverMenu = null;
        // Keep the session across browser restarts. On by default: most people
        // log in from their own device and should never see this page twice.
        // Unchecking it is what someone on a borrowed machine wants — the cookie
        // then dies with the browser and the server expires the session in hours
        // rather than 90 days.
        this._remember = true;
        this._destroyed = false;
    }

    async start() {
        this._loading = true;
        this._error = '';
        this._lockoutRemaining = 0;
        this._certMode = false;
        this.render();
        this.bindEvents();
        this._focusInput();

        // Build default machine name from client OS + browser
        this._suggestMachineName();

        // The machines this browser can leave for, read once per visit to this
        // screen: nothing writes to that register while a login is on screen.
        this._otherInstances = this._readOtherInstances();
        this._renderServerField();

        // Offer the host machine its way back in (see _buildLocalUrl).
        await this._resolveLocalUrl();

        // Check auth status — maybe already authenticated
        try {
            const status = await BackendClient.getAuthStatus();
            if (status.authenticated) {
                this._releaseServerField();
                this.onAuthenticated();
                return;
            }
            this._loading = false;
            this._certAuthAvailable = status.cert_auth_enabled || false;
            this._pinEnabled = status.pin_enabled !== false;
            this._ssoEnabled = status.sso_enabled === true;
            this._ssoOrigin = status.sso_origin || '';
            this._selectedMethod = this._ssoEnabled ? (this._pinEnabled ? '' : 'sso') : 'pin';
            const query = new URLSearchParams(window.location.search);
            const error = query.has('auth_error');
            if (error) this._error = t('login.ssoError');

            this._remaining = status.remaining !== undefined ? status.remaining : 3;
            if (status.lockout_seconds > 0) {
                this._startLockoutTimer(status.lockout_seconds);
            }
            this.render();
            this.bindEvents();
            this._focusInput();
            let loggedOut = false;
            try {
                loggedOut = sessionStorage.getItem('mw-sso-logged-out') === '1';
            } catch {
                /* optional storage */
            }
            if (
                this._ssoEnabled &&
                !error &&
                !loggedOut &&
                (!this._pinEnabled || query.get('sso') === '1')
            ) {
                await this._beginSso();
            }
        } catch (err) {
            console.warn('[Login] Failed to check auth status:', err);
            this._loading = false;
            this._error = t('login.unableToConnect');
            this.render();
            this.bindEvents();
        }
    }

    destroy() {
        this._destroyed = true;
        this._releaseServerField();
        this._stopLockoutTimer();
        this._releaseSubmitInView();
        this._releasePinCaret();
    }

    /**
     * The way home for whoever is sitting at the machine: once the host session
     * is gone (revoked, expired) this PIN page is all they get, even though the
     * machine is right in front of them. Loopback is the one address that proves
     * where the browser runs, so the offer is simply "open this on localhost".
     *
     * The port is taken from the address bar, not asked for. It used to come
     * from /api/server/status, which is session-gated — so on the one screen
     * that has no session the request answered 401 every time, the link never
     * appeared, and BackendClient turned that 401 into a full page reload. A
     * first visit therefore loaded the application twice, and once the seal
     * existed you could watch it happen. The 401 also fed the ban guard, which
     * spent one of the visitor's attempts before they had typed anything.
     *
     * Offered only when an IP literal names us, which is the case where the
     * address bar's port IS the port this server listens on. Under a name — the
     * rendezvous, a legacy sub-domain — the public port can be a different one
     * mapped through the router, and a link to the wrong local port is worse
     * than no link.
     */
    async _resolveLocalUrl() {
        const { hostname, port } = window.location;
        if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') return;
        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) && !hostname.startsWith('[')) return;
        this._localUrl = 'https://localhost' + (port ? ':' + port : '') + '/';
    }

    /**
     * The name this browser signed in under last time, else one built from
     * client OS + browser, e.g. "Windows Chrome", "macOS Safari".
     */
    _suggestMachineName() {
        this._machineName = LoginView.rememberedMachineName();
    }

    /**
     * The name typed into "Name this session" at the last successful sign-in.
     *
     * The host lists every device by that name, so someone who took the
     * trouble to call their phone "Living-room tablet" should not find it back
     * as "Android Chrome" after the session ends and they unlock again. Kept
     * only when it differs from the suggestion: an untouched field keeps
     * following the browser, which is what the suggestion is for.
     */
    static rememberedMachineName() {
        try {
            const stored = (localStorage.getItem(MACHINE_NAME_KEY) || '').trim();
            if (stored) return stored.slice(0, 24);
        } catch {
            /* no storage: the suggestion, as before */
        }
        return LoginView.suggestedMachineName();
    }

    static _rememberMachineName(name) {
        try {
            if (name && name !== LoginView.suggestedMachineName()) {
                localStorage.setItem(MACHINE_NAME_KEY, name);
            } else {
                localStorage.removeItem(MACHINE_NAME_KEY);
            }
        } catch {
            /* the field just starts from the suggestion next time */
        }
    }

    /** The name suggestion alone, for a session created without this form. */
    static suggestedMachineName() {
        const ua = navigator.userAgent;
        let os = 'Unknown';
        if (ua.includes('Windows')) os = 'Windows';
        else if (ua.includes('Android')) os = 'Android';
        else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';
        else if (ua.includes('Mac OS') || ua.includes('Macintosh')) os = 'macOS';
        else if (ua.includes('Linux') && !ua.includes('Android')) os = 'Linux';
        else if (ua.includes('CrOS')) os = 'ChromeOS';

        let browser = 'Browser';
        if (ua.includes('Firefox')) browser = 'Firefox';
        else if (ua.includes('Edg')) browser = 'Edge';
        else if (ua.includes('Chrome')) browser = 'Chrome';
        else if (ua.includes('Safari') && !ua.includes('Chrome')) browser = 'Safari';
        else if (ua.includes('OPR') || ua.includes('Opera')) browser = 'Opera';

        return `${os} ${browser}`;
    }

    render() {
        this.container.innerHTML = `
            <div class="login-view" id="view-login">
                <div class="login-box">
                    <div class="login-logo">
                        <span class="login-logo-img" role="img" aria-label="Moonlight"></span>
                    </div>
                    <h1 class="login-title">MoonlightWeb</h1>

                    <div id="login-form-area">
                        ${
                            this._loading
                                ? `
                            <div class="login-loading">
                                <div class="login-spinner"></div>
                                <p>${t('login.connecting')}</p>
                            </div>
                        `
                                : this._ssoEnabled && !this._selectedMethod
                                  ? this._renderMethodChoice()
                                  : this._selectedMethod === 'sso'
                                    ? this._renderSsoForm()
                                    : this._certMode
                                      ? this._renderCertForm()
                                      : this._renderPinForm()
                        }
                    </div>

                    ${
                        !this._loading && this._ssoEnabled && this._selectedMethod === 'pin'
                            ? `<button id="btn-login-sso" class="btn btn-link">${t('login.useSso')}</button>`
                            : ''
                    }
                    ${
                        !this._loading && this._certAuthAvailable && this._selectedMethod === 'pin'
                            ? `
                        <div id="login-method-toggle" class="u-mt-3 u-center">
                            <button id="btn-toggle-auth-method" class="btn btn-link">
                                ${
                                    this._certMode
                                        ? t('login.usePinInstead')
                                        : t('login.useCertInstead')
                                }
                            </button>
                        </div>
                    `
                            : ''
                    }

                    ${
                        !this._loading && !this._certMode && this._selectedMethod === 'pin'
                            ? `
                        <p class="login-hint">${t('login.pinHint')}</p>
                    `
                            : ''
                    }

                    ${
                        !this._loading && this._localUrl
                            ? `
                        <p class="login-hint login-host-hint">
                            ${t('login.onHostMachine')}
                            <a href="${this.esc(this._localUrl)}" id="login-host-link">${t('login.openLocally')}</a>
                        </p>
                    `
                            : ''
                    }
                </div>
            </div>
        `;
    }

    _renderPinForm() {
        return `
            <div class="login-form login-form--pin">
                <p class="login-subtitle">${t('login.pinSubtitle')}</p>

                <!-- Machine name -->
                <div class="login-field">
                    <label class="login-label" for="login-machine-input">${t('login.nameSession')}</label>
                    <input type="text" id="login-machine-input" class="login-input"
                           placeholder="${this.esc(t('login.namePlaceholder'))}"
                           value="${this.esc(this._machineName)}"
                           maxlength="24"
                           autocomplete="off" />
                </div>

                <!-- PIN input -->
                <div class="login-field login-field--pin">
                    <label class="login-label" for="login-pin-input">${t('login.pinLabel')}</label>
                    <div class="login-pin-input-wrap">
                        <input type="text" id="login-pin-input" class="login-pin-input"
                               inputmode="numeric" pattern="[0-9]*"
                               placeholder="${this.esc(t('login.pinPlaceholder'))}"
                               autocomplete="off"
                               ${this._lockoutRemaining > 0 ? 'disabled' : ''} />
                    </div>
                </div>

                ${this._renderRememberField()}

                ${this._error ? `<p id="login-error" class="login-error">${this.esc(this._error)}</p>` : '<p id="login-error" class="login-error"></p>'}
                <p id="login-remaining" class="login-remaining">${this._remaining > 0 && this._remaining <= 3 ? this.esc(t('login.attemptsRemaining', { count: this._remaining })) : ''}</p>
                ${
                    this._lockoutRemaining > 0
                        ? `
                    <div id="login-lockout" class="login-lockout">
                        ${t('login.lockout', { seconds: `<span id="login-lockout-countdown">${this._lockoutRemaining}</span>` })}
                    </div>
                `
                        : '<div id="login-lockout" class="login-lockout" style="display:none;"></div>'
                }
                <button id="btn-login-unlock" class="btn btn-neutral login-submit"
                        disabled
                        ${this._lockoutRemaining > 0 || this._submitting ? 'disabled' : ''}>
                    ${this._submitting ? t('common.verifying') : t('login.unlock')}
                </button>
            </div>
        `;
    }

    /**
     * Every machine in this browser's register except the one being unlocked.
     *
     * The register is written by the application after a machine has answered,
     * so an entry here means this browser has actually been to that machine —
     * it is a list of places the person can go, not a list of guesses.
     *
     * The address is checked to be http(s) before it is offered. Nothing in the
     * product writes anything else there, and that is the point: this screen
     * turns a stored string into a navigation, and the one shape of string that
     * must never become one is a javascript: URL.
     */
    _readOtherInstances() {
        try {
            const currentId = currentInstanceRef(tunnelHostId()).id;
            this._currentInstanceId = currentId;
            return listInstances().filter((e) => e.id !== currentId && this._isWebUrl(e.url));
        } catch {
            // No storage (private mode, a quota refusal). The login screen is
            // complete without the offer; it just cannot make it.
            return [];
        }
    }

    /** True for an address a browser may be sent to from here. */
    _isWebUrl(url) {
        try {
            const scheme = new URL(url, window.location.href).protocol;
            return scheme === 'https:' || scheme === 'http:';
        } catch {
            return false;
        }
    }

    /**
     * "Server selection" — the way to a different machine, from the one screen
     * that used to be a dead end.
     *
     * Someone who runs MoonlightWeb on two PCs and follows a link to the one
     * that is switched off, or whose session there expired, lands here with no
     * route to the other except a bookmark they may not have. The register
     * behind the header menu already holds every machine this browser has
     * reached, and it costs nothing to offer it before the PIN rather than
     * after it.
     *
     * What it deliberately does NOT say is which machine this is. The name of
     * the machine being unlocked is not on this screen and must not be put
     * there: this is the screen shown to whoever holds the link, including
     * someone who should not have it, and a name is the one thing that turns an
     * opaque identifier into a machine worth attacking. The rows below name
     * only machines this browser has already paired with, which tells that
     * visitor nothing they could not learn by opening any of them — and the
     * selected row is a neutral label, never the current name.
     *
     * Absent entirely when there is nowhere to go, rather than shown empty: a
     * chooser with one unusable entry is a question with no answer.
     *
     * It lives in the page header, where the machine menu sits once inside —
     * the same component, the same place, so the way out of this screen is
     * where the way to another machine always is. Among the fields of the
     * form, or beside the title in the box, it read as one more question to
     * answer before the PIN.
     */
    _renderServerField() {
        const mount = document.getElementById('instance-menu');
        if (!mount || this._otherInstances.length === 0) return;

        if (!this._serverMenu) this._serverMenu = new InstanceMenu(mount);
        const label = t('login.serverCurrent');
        this._serverMenu.render(this._currentInstanceId, label, [
            { id: this._currentInstanceId, name: label, url: '' },
            ...this._otherInstances,
        ]);
    }

    /** Hand the header back empty: the app draws its own menu once inside. */
    _releaseServerField() {
        this._serverMenu?.destroy();
        this._serverMenu = null;
    }

    /**
     * "Remember me", shared by both authentication forms. Checked by default —
     * unchecking is the deliberate act of someone on a machine they are about to
     * walk away from, and the hint spells out what they get for it.
     */
    _renderMethodChoice() {
        return `<p>${t('login.chooseMethod')}</p>
            <button id="btn-login-pin" class="btn btn-neutral">${t('login.usePin')}</button>
            <button id="btn-login-sso" class="btn btn-neutral">${t('login.useSso')}</button>
            ${this._error ? `<p class="login-error">${this.esc(this._error)}</p>` : ''}`;
    }

    _renderSsoForm() {
        return `${this._renderRememberField()}
            ${this._error ? `<p class="login-error">${this.esc(this._error)}</p>` : ''}
            <button id="btn-login-sso" class="btn btn-neutral" ${this._submitting ? 'disabled' : ''}>${t('login.useSso')}</button>`;
    }

    _navigate(url) {
        window.location.assign(url);
    }

    async _beginSso() {
        if (this._submitting) return;
        if (this._ssoOrigin && window.location.origin !== this._ssoOrigin) {
            this._navigate(`${this._ssoOrigin}/?sso=1`);
            return;
        }
        this._selectedMethod = 'sso';
        this._submitting = true;
        this._error = '';
        this.render();
        this.bindEvents();
        try {
            const url = await BackendClient.beginSso(this._machineName, this._remember);
            if (this._destroyed) return;
            if (!url || new URL(url).protocol !== 'https:') throw new Error('Invalid SSO URL');
            this._navigate(url);
        } catch {
            if (this._destroyed) return;
            this._submitting = false;
            this._error = t('login.ssoError');
            this.render();
            this.bindEvents();
        }
    }

    _renderRememberField() {
        return `
            <div class="login-field login-remember">
                <label class="login-remember-label" for="login-remember">
                    <input type="checkbox" id="login-remember" ${this._remember ? 'checked' : ''} />
                    <span>${t('login.rememberMe')}</span>
                </label>
                <span class="login-remember-hint">${t('login.rememberMeHint')}</span>
            </div>
        `;
    }

    _renderCertForm() {
        return `
            <div class="login-form">
                <p class="login-subtitle">${t('login.certSubtitle')}</p>

                <!-- Machine name -->
                <div class="login-field">
                    <label class="login-label" for="login-machine-input">${t('login.nameSession')}</label>
                    <input type="text" id="login-machine-input" class="login-input"
                           placeholder="${this.esc(t('login.namePlaceholder'))}"
                           value="${this.esc(this._machineName)}"
                           maxlength="24"
                           autocomplete="off" />
                </div>

                <!-- File upload -->
                <div class="login-field">
                    <label class="login-label" for="login-cert-input">${t('login.certLabel')}</label>
                    <div class="login-cert-upload-wrap">
                        <input type="file" id="login-cert-input" class="login-cert-input"
                               accept=".txt,.cert,.pem,.key,text/plain"
                               ${this._submitting ? 'disabled' : ''} />
                    </div>
                    ${
                        this._selectedFileName
                            ? `
                        <p class="login-file-selected">
                            ${this.esc(t('login.selected', { name: this._selectedFileName }))}
                        </p>
                    `
                            : ''
                    }
                </div>

                ${this._renderRememberField()}

                ${this._error ? `<p id="login-error" class="login-error">${this.esc(this._error)}</p>` : '<p id="login-error" class="login-error"></p>'}
                <button id="btn-login-cert-auth" class="btn btn-neutral login-submit"
                        disabled
                        ${this._submitting ? 'disabled' : ''}>
                    ${this._submitting ? t('common.verifying') : t('login.certAuthBtn')}
                </button>
            </div>
        `;
    }

    bindEvents() {
        this.container.querySelector('#btn-login-pin')?.addEventListener('click', () => {
            this._selectedMethod = 'pin';
            this.render();
            this.bindEvents();
            this._focusInput();
        });
        this.container
            .querySelector('#btn-login-sso')
            ?.addEventListener('click', () => this._beginSso());

        const formArea = this.container.querySelector('#login-form-area');
        if (!formArea) return;

        if (this._certMode) {
            this._bindCertEvents();
        } else {
            this._bindPinEvents();
        }

        // The session name, kept in state for the same reason as "Remember
        // me" below: a wrong PIN re-renders the form, and the name typed a
        // moment ago used to come back as the suggestion.
        const machineInput = this.container.querySelector('#login-machine-input');
        if (machineInput) {
            machineInput.addEventListener('input', () => {
                this._machineName = machineInput.value;
            });
        }

        // "Remember me" — shared by both forms, kept in state so a failed
        // attempt (which re-renders) does not silently flip it back on.
        const rememberCheck = this.container.querySelector('#login-remember');
        if (rememberCheck) {
            rememberCheck.addEventListener('change', () => {
                this._remember = rememberCheck.checked;
            });
        }

        // Auth method toggle button
        const toggleBtn = this.container.querySelector('#btn-toggle-auth-method');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this._certMode = !this._certMode;
                this._error = '';
                this._selectedFileName = '';
                this.render();
                this.bindEvents();
                this._focusInput();
            });
        }
    }

    _bindPinEvents() {
        const input = this.container.querySelector('#login-pin-input');
        const machineInput = this.container.querySelector('#login-machine-input');
        const btn = this.container.querySelector('#btn-login-unlock');

        if (!input || !btn) return;

        // Right after the last digit (start when none yet): the only place the
        // caret may be. Anywhere else, the next digit lands among the dashes
        // or between two digits, and the mask then reads them back in an
        // order the person never typed.
        const caretSlot = () => {
            const count = input.value.replace(/\D/g, '').length;
            return count + (count > 3 ? 1 : 0);
        };
        const pinCaret = () => {
            if (document.activeElement !== input) return;
            const slot = caretSlot();
            if (input.selectionStart !== slot || input.selectionEnd !== slot) {
                input.setSelectionRange(slot, slot);
            }
        };

        input.addEventListener('input', () => {
            // Mask: fill a "DDD DDD" template left-to-right — each typed digit
            // replaces the next dash. Caret stays right after the last digit.
            const digits = input.value.replace(/\D/g, '').slice(0, 6);
            const filled = digits.padEnd(6, '-');
            input.value = filled.slice(0, 3) + ' ' + filled.slice(3);
            const caret = caretSlot();
            input.setSelectionRange(caret, caret);
            btn.disabled = digits.length === 0 || this._lockoutRemaining > 0 || this._submitting;
            // All six typed on a phone: put the keyboard away, so Unlock is in
            // plain sight instead of under it.
            if (digits.length === 6 && window.matchMedia?.('(pointer: coarse)').matches) {
                input.blur();
            }
        });

        // Show the "--- ---" template (centered) while focused, caret on the
        // first dash; clear it on blur so the dim placeholder shows when empty.
        input.addEventListener('focus', () => {
            const digits = input.value.replace(/\D/g, '');
            if (digits.length === 0) {
                input.value = '--- ---';
            }
            // Defer so it wins over the mouse-click caret placement.
            setTimeout(pinCaret, 0);
        });

        // A click, a tap, an arrow key or a long-press selection would all move
        // the caret off its slot: each is put straight back. selectionchange
        // covers taps and drags on every engine; the key and pointer events are
        // there for the ones that do not fire it for text fields.
        input.addEventListener('keydown', (e) => {
            if (/^(Arrow(Left|Right|Up|Down)|Home|End|PageUp|PageDown)$/.test(e.key)) {
                e.preventDefault();
            }
        });
        for (const type of ['select', 'click', 'keyup']) input.addEventListener(type, pinCaret);
        input.addEventListener('pointerup', () => setTimeout(pinCaret, 0));
        this._releasePinCaret();
        document.addEventListener('selectionchange', pinCaret);
        this._pinCaretCleanup = () => document.removeEventListener('selectionchange', pinCaret);
        input.addEventListener('blur', () => {
            if (input.value.replace(/\D/g, '').length === 0) {
                input.value = '';
            }
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && input.value.length > 0 && !btn.disabled) {
                e.preventDefault();
                this._submitPin(input, machineInput, btn);
            }
        });

        // Enter on "Name this session" triggers submit too
        if (machineInput) {
            machineInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && input.value.length > 0 && !btn.disabled) {
                    e.preventDefault();
                    this._submitPin(input, machineInput, btn);
                }
            });
        }

        btn.addEventListener('click', () => {
            if (input.value.length > 0) {
                this._submitPin(input, machineInput, btn);
            }
        });

        this._keepSubmitInView(input, btn);
    }

    /**
     * Keep Unlock in sight while the PIN is typed on a phone.
     *
     * The soft keyboard covers the bottom of the screen and the browser only
     * brings the focused field into view, so the button just under it stayed
     * behind the keyboard: the code was typed, the keyboard put away, and the
     * page scrolled by hand to find Unlock. While the field has focus, the
     * scroll area gets the keyboard's height as room at the bottom and is
     * scrolled just far enough for the button to clear it.
     *
     * Measured against the visual viewport, which is the part of the page the
     * keyboard leaves visible, on iOS and Android alike. A no-op on desktop,
     * where there is no keyboard to cover anything.
     */
    _keepSubmitInView(input, btn) {
        this._releaseSubmitInView();
        const vv = window.visualViewport;
        // On a TV the document scrolls, not #main-content (layout.css).
        const docScrolls = document.documentElement.classList.contains('remote-nav');
        const scroller = /** @type {HTMLElement|null} */ (
            docScrolls ? document.scrollingElement : this.container.closest('#main-content')
        );
        if (!vv || !scroller || !window.matchMedia('(pointer: coarse)').matches) return;

        const reveal = () => {
            if (document.activeElement !== input || !btn.isConnected) return;
            const covered = Math.max(0, document.documentElement.clientHeight - vv.height);
            scroller.style.paddingBottom = covered > 0 ? `${covered}px` : '';
            // Whichever ends first: the keyboard's top edge, or the scroll
            // area's own (the footer sits under it).
            const visibleBottom = docScrolls
                ? vv.offsetTop + vv.height
                : Math.min(vv.offsetTop + vv.height, scroller.getBoundingClientRect().bottom);
            const overflow = btn.getBoundingClientRect().bottom + 12 - visibleBottom;
            if (overflow > 0) scroller.scrollTop += overflow;
        };
        const stop = () => {
            vv.removeEventListener('resize', reveal);
            vv.removeEventListener('scroll', reveal);
            scroller.style.paddingBottom = '';
        };
        const onFocus = () => {
            vv.addEventListener('resize', reveal);
            vv.addEventListener('scroll', reveal);
            // The keyboard slides in over ~300 ms, and not every browser
            // reports the viewport change as it happens.
            setTimeout(reveal, 350);
        };
        input.addEventListener('focus', onFocus);
        input.addEventListener('blur', stop);
        input.addEventListener('input', reveal);
        this._submitInViewCleanup = stop;
    }

    _releaseSubmitInView() {
        if (this._submitInViewCleanup) this._submitInViewCleanup();
        this._submitInViewCleanup = null;
    }

    _releasePinCaret() {
        if (this._pinCaretCleanup) this._pinCaretCleanup();
        this._pinCaretCleanup = null;
    }

    _bindCertEvents() {
        const certInput = this.container.querySelector('#login-cert-input');
        const machineInput = this.container.querySelector('#login-machine-input');
        const btn = this.container.querySelector('#btn-login-cert-auth');

        if (!certInput || !btn) return;

        certInput.addEventListener('change', () => {
            const file = certInput.files && certInput.files[0];
            this._selectedFileName = file ? file.name : '';
            btn.disabled = !file || this._submitting;

            // Show selected file name
            const fileLabel = this.container.querySelector('.login-file-selected');
            if (fileLabel && file) {
                fileLabel.textContent = t('login.selected', { name: file.name });
            } else if (fileLabel) {
                fileLabel.textContent = '';
            }
        });

        btn.addEventListener('click', () => {
            const file = certInput.files && certInput.files[0];
            if (file) {
                this._submitCertificate(file, machineInput, btn, certInput);
            }
        });

        // Submit on Enter (if file selected)
        certInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && certInput.files && certInput.files[0] && !btn.disabled) {
                e.preventDefault();
                this._submitCertificate(certInput.files[0], machineInput, btn, certInput);
            }
        });

        // Enter on "Name this session" triggers submit (with file selected)
        if (machineInput) {
            machineInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && certInput.files && certInput.files[0] && !btn.disabled) {
                    e.preventDefault();
                    this._submitCertificate(certInput.files[0], machineInput, btn, certInput);
                }
            });
        }
    }

    async _submitPin(input, machineInput, btn) {
        if (this._submitting) return;
        this._submitting = true;
        btn.disabled = true;
        btn.textContent = t('common.verifying');

        const pin = input.value.replace(/\D/g, '');
        const machineName = machineInput ? machineInput.value.trim() : '';

        try {
            const result = await BackendClient.validatePin(pin, machineName, this._remember);

            if (result.status === 'ok') {
                LoginView._rememberMachineName(machineName);
                Toast.success(t('login.authSuccess'));
                this._releaseServerField();
                this.onAuthenticated();
                return;
            }
        } catch (err) {
            this._handlePinError(err, input, btn);
        }
    }

    async _submitCertificate(file, machineInput, btn, certInput) {
        if (this._submitting) return;
        this._submitting = true;
        btn.disabled = true;
        btn.textContent = t('common.verifying');

        const machineName = machineInput ? machineInput.value.trim() : '';

        try {
            // Read the file content as text
            const content = await this._readFileAsText(file);

            // Send to server for validation
            const result = await BackendClient.validateCertificate(
                content,
                machineName,
                this._remember,
            );

            if (result.status === 'ok') {
                LoginView._rememberMachineName(machineName);
                Toast.success(t('login.authSuccess'));
                this._releaseServerField();
                this.onAuthenticated();
                return;
            }
        } catch (err) {
            this._handleCertError(err, btn, certInput);
        }
    }

    _readFileAsText(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = (e) => reject(new Error(t('login.readFileError')));
            reader.readAsText(file);
        });
    }

    _handlePinError(err, input, btn) {
        this._submitting = false;
        btn.disabled = false;
        btn.textContent = t('login.unlock');
        input.value = '';
        input.focus();

        let errorMsg = t('login.invalidPin');
        const statusCode = err.statusCode || 0;
        const body = err.responseBody || {};

        if (statusCode === 429) {
            errorMsg = t('login.tooManyAttempts');
            if (body.lockout_seconds > 0) {
                this._startLockoutTimer(body.lockout_seconds);
            }
        } else if (statusCode === 401) {
            errorMsg = t('login.invalidPin');
            if (body.lockout_seconds > 0) {
                this._startLockoutTimer(body.lockout_seconds);
            }
            if (body.remaining !== undefined) {
                this._remaining = body.remaining;
            } else {
                this._remaining = Math.max(0, this._remaining - 1);
            }
        } else {
            errorMsg = err.message || t('login.connectionError');
        }

        this._error = errorMsg;
        this.render();
        this.bindEvents();
    }

    _handleCertError(err, btn, certInput) {
        this._submitting = false;
        btn.disabled = false;
        btn.textContent = t('login.certAuthBtn');

        // Reset file input for retry
        if (certInput) certInput.value = '';

        const statusCode = err.statusCode || 0;
        const body = err.responseBody || {};
        let errorMsg = '';

        if (statusCode === 401 && body.error === 'invalid_certificate') {
            errorMsg = t('login.invalidCert');
        } else {
            errorMsg = err.message || t('login.verificationFailed');
        }

        this._error = errorMsg;
        this.render();
        this.bindEvents();
    }

    _startLockoutTimer(seconds) {
        this._stopLockoutTimer();
        this._lockoutRemaining = seconds;
        this._updateLockoutDisplay();

        this._lockoutTimer = setInterval(() => {
            this._lockoutRemaining--;
            if (this._lockoutRemaining <= 0) {
                this._stopLockoutTimer();
                this._lockoutRemaining = 0;
                this._error = '';
                this.render();
                this.bindEvents();
                this._focusInput();
            } else {
                this._updateLockoutDisplay();
            }
        }, 1000);
    }

    _stopLockoutTimer() {
        if (this._lockoutTimer) {
            clearInterval(this._lockoutTimer);
            this._lockoutTimer = null;
        }
    }

    _updateLockoutDisplay() {
        const lockout = this.container.querySelector('#login-lockout');
        const countdown = this.container.querySelector('#login-lockout-countdown');
        const input = this.container.querySelector('#login-pin-input');
        const btn = this.container.querySelector('#btn-login-unlock');

        if (lockout) lockout.style.display = '';
        if (countdown) countdown.textContent = this._lockoutRemaining;
        if (input) input.disabled = this._lockoutRemaining > 0;
        if (btn) btn.disabled = this._lockoutRemaining > 0;
    }

    _focusInput() {
        if (this._certMode) {
            const input = this.container.querySelector('#login-cert-input');
            if (input && !input.disabled) {
                setTimeout(() => input.focus(), 100);
            }
        } else {
            const input = this.container.querySelector('#login-pin-input');
            if (input && !input.disabled) {
                setTimeout(() => input.focus(), 100);
            }
        }
    }

    esc(text) {
        return escapeHtml(text);
    }
}
