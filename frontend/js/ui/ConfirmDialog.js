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

/** Page-owned confirmation for TV browsers and actions opting into the app UI.
 * Destructive actions start with Cancel focused and restore the caller's focus. */

import { t } from '../i18n/i18n.js';
import { escapeHtml } from '../util/escapeHtml.js';
import * as RemoteNav from './RemoteNav.js';

/**
 * @param {string} message
 * @param {{ confirmLabel?: string, danger?: boolean, inApp?: boolean, title?: string }} [opts]
 * @returns {Promise<boolean>} whether the user confirmed
 */
export function confirmAction(message, opts = {}) {
    if (document.querySelector('.mw-confirm-overlay')) return Promise.resolve(false);
    if (!opts.inApp && !RemoteNav.isActive()) return Promise.resolve(window.confirm(message));
    return new Promise((resolve) => {
        const previousFocus = document.activeElement;
        const el = document.createElement('div');
        el.className = 'share-popin-overlay mw-confirm-overlay';
        const label = escapeHtml(opts.confirmLabel || t('common.confirm'));
        el.innerHTML = `
            <div class="share-popin" role="alertdialog" aria-modal="true" aria-labelledby="mw-confirm-title" aria-describedby="mw-confirm-message">
                <h3 id="mw-confirm-title">${escapeHtml(opts.title || t('common.confirm'))}</h3>
                <p id="mw-confirm-message">${escapeHtml(message)}</p>
                <div class="share-popin-actions">
                    <button type="button" class="btn btn-secondary" data-answer="no" data-nav-initial>${escapeHtml(t('common.cancel'))}</button>
                    <button type="button" class="btn${opts.danger ? ' btn-danger' : ''}" data-answer="yes">${label}</button>
                </div>
            </div>
        `;
        const cancel = /** @type {HTMLButtonElement} */ (el.querySelector('[data-answer="no"]'));
        const confirm = /** @type {HTMLButtonElement} */ (el.querySelector('[data-answer="yes"]'));
        let settled = false;
        const done = (answer) => {
            if (settled) return;
            settled = true;
            document.removeEventListener('keydown', onKey, true);
            el.remove();
            if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
                previousFocus.focus();
            resolve(answer);
        };
        const onKey = (e) => {
            if (e.key === 'Tab') {
                e.preventDefault();
                e.stopPropagation();
                const next = e.shiftKey
                    ? document.activeElement === confirm
                        ? cancel
                        : confirm
                    : document.activeElement === cancel
                      ? confirm
                      : cancel;
                next.focus();
                return;
            }
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            done(false);
        };
        el.addEventListener('click', (e) => {
            const target = /** @type {Element} */ (e.target);
            if (target === el) {
                done(false);
                return;
            }
            const btn = target.closest('[data-answer]');
            if (btn) done(btn.getAttribute('data-answer') === 'yes');
        });
        document.addEventListener('keydown', onKey, true);
        document.body.appendChild(el);
        cancel.focus();
    });
}
