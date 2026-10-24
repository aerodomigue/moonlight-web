import { describe, it, expect, afterEach } from 'vitest';
import { AdminView } from '../js/ui/AdminView.js';

describe('Administration authentication methods', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });
    const render = (pin) => {
        const view = new AdminView(document.body, () => {});
        view._hasAdminAccess = true;
        view._pinLoginEnabled = pin;
        view.render();
    };
    it('keeps PIN and certificate controls in PIN mode', () => {
        render(true);
        expect(document.querySelector('#btn-regenerate-pin')).not.toBeNull();
        expect(document.querySelector('#chk-cert-auth')).not.toBeNull();
    });
    it('hides unusable PIN and certificate controls in SSO-only mode', () => {
        render(false);
        expect(document.querySelector('#btn-regenerate-pin')).toBeNull();
        expect(document.querySelector('#chk-cert-auth')).toBeNull();
    });
});
