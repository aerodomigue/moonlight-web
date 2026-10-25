/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { confirmAction } from '../js/ui/ConfirmDialog.js';
import * as RemoteNav from '../js/ui/RemoteNav.js';

/**
 * TV Bro blocks window.confirm() — no dialog, an answer of "no" a few
 * milliseconds later — so on a TV the question is the page's own dialog.
 * Desktop quit actions opt into the same dialog; other actions keep their existing behavior.
 */

const dialog = () => document.querySelector('.mw-confirm-overlay');
const answer = (a) => dialog().querySelector(`[data-answer="${a}"]`).click();

describe('confirmAction', () => {
    afterEach(() => {
        RemoteNav._setActiveForTest(null);
        vi.restoreAllMocks();
        document.body.innerHTML = '';
    });

    it("asks the browser's own confirm on a desktop", async () => {
        const spy = vi.spyOn(window, 'confirm').mockReturnValue(true);
        expect(await confirmAction('Quit?')).toBe(true);
        spy.mockReturnValue(false);
        expect(await confirmAction('Quit?')).toBe(false);
        expect(dialog()).toBe(null);
    });

    it('asks in a dialog of its own on a TV, Cancel first', async () => {
        RemoteNav._setActiveForTest(true);
        const spy = vi.spyOn(window, 'confirm');
        const asked = confirmAction('Quit Steam?', { danger: true });
        expect(dialog().textContent).toContain('Quit Steam?');
        expect(dialog().querySelector('[data-nav-initial]').getAttribute('data-answer')).toBe('no');
        expect(dialog().querySelector('[data-answer="yes"]').classList.contains('btn-danger')).toBe(
            true,
        );
        answer('yes');
        expect(await asked).toBe(true);
        expect(dialog()).toBe(null);
        expect(spy).not.toHaveBeenCalled();
    });

    it('takes Escape and a click beside the box as a no', async () => {
        RemoteNav._setActiveForTest(true);
        const first = confirmAction('Stop?');
        document.body.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
        expect(await first).toBe(false);
        const second = confirmAction('Stop?');
        dialog().click();
        expect(await second).toBe(false);
        const third = confirmAction('Stop?');
        answer('no');
        expect(await third).toBe(false);
    });
    it('uses an accessible in-app dialog on desktop when requested, without native confirmation', async () => {
        RemoteNav._setActiveForTest(false);
        const spy = vi.spyOn(window, 'confirm').mockReturnValue(true);
        const trigger = document.createElement('button');
        document.body.append(trigger);
        trigger.focus();
        const asked = confirmAction('Quit <img src=x onerror=alert(1)>?', {
            inApp: true,
            title: 'Quit application?',
            confirmLabel: 'Quit',
            danger: true,
        });
        const box = dialog().querySelector('[role="alertdialog"]');
        expect(document.getElementById(box.getAttribute('aria-labelledby')).textContent).toBe(
            'Quit application?',
        );
        expect(document.getElementById(box.getAttribute('aria-describedby')).textContent).toContain(
            '<img',
        );
        expect(box.querySelector('img')).toBe(null);
        expect(document.activeElement.dataset.answer).toBe('no');
        expect(box.querySelector('[data-answer="yes"]').textContent).toBe('Quit');
        answer('no');
        expect(await asked).toBe(false);
        expect(document.activeElement).toBe(trigger);
        expect(spy).not.toHaveBeenCalled();
    });

    it('keeps keyboard focus inside the dialog and cancels with Escape', async () => {
        const asked = confirmAction('Quit?', { inApp: true });
        document.activeElement.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Tab',
                shiftKey: true,
                bubbles: true,
                cancelable: true,
            }),
        );
        expect(document.activeElement.dataset.answer).toBe('yes');
        document.activeElement.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
        );
        expect(document.activeElement.dataset.answer).toBe('no');
        document.activeElement.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
        expect(await asked).toBe(false);
        expect(dialog()).toBe(null);
    });

    it('does not stack confirmations or resolve twice on repeated clicks', async () => {
        const asked = confirmAction('Quit?', { inApp: true });
        expect(await confirmAction('Quit again?', { inApp: true })).toBe(false);
        expect(document.querySelectorAll('.mw-confirm-overlay')).toHaveLength(1);
        const button = dialog().querySelector('[data-answer="yes"]');
        button.click();
        button.click();
        expect(await asked).toBe(true);
        expect(dialog()).toBe(null);
    });
});
