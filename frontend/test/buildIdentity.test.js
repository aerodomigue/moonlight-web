import { describe, it, expect } from 'vitest';
import { showBuildIdentity } from '../js/util/buildIdentity.js';

describe('independent UI and server identities', () => {
    it('shows the loaded frontend revision even when the binary stays unchanged', () => {
        const el = document.createElement('span');
        showBuildIdentity(el, '0.2.1.g68e.stg', {
            revision: '867f577d314fd9447dbfce4a0ceb1ce3666142a5',
            dirty: false,
        });
        expect(el.textContent).toContain('867f577d');
        expect(el.textContent).toContain('0.2.1.g68e.stg');
        expect(el.title).toContain('867f577d314fd9447dbfce4a0ceb1ce3666142a5');
        expect(el.hidden).toBe(false);
    });
    it('does not invent a revision in an unstamped development checkout', () => {
        const el = document.createElement('span');
        showBuildIdentity(el, 'old-server');
        expect(el.textContent).toContain('old-server');
        expect(el.textContent).not.toContain('undefined');
        expect(el.textContent).not.toContain('[object');
    });
    it('marks modified trees and uses text rather than HTML', () => {
        const el = document.createElement('span');
        showBuildIdentity(el, '<b>server</b>', { revision: 'a'.repeat(40), dirty: true });
        expect(el.textContent).toContain(' + ');
        expect(el.children.length).toBe(0);
    });
});
