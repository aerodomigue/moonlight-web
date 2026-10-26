import { describe, expect, it, vi } from 'vitest';
import { Host } from '../js/models/Host.js';
import { HostListView } from '../js/ui/HostListView.js';
vi.mock('../js/i18n/i18n.js', () => ({ t: key => key }));
describe('disabled host registrations', () => {
    it.each(['online', 'offline'])('has no actions or app requests while %s', state => {
        const host = new Host({ uuid: 'one', name: '<PC>', enabled: false, state, pairState: 'paired', wakeSupported: true });
        expect(host.isAvailable).toBe(false);
        expect(host.canWake).toBe(false);
        const view = Object.create(HostListView.prototype);
        const html = view.renderCard(host);
        document.body.innerHTML = html;
        expect(document.querySelector('button')).toBeNull();
        expect(document.querySelector('pc')).toBeNull();
        expect(html).toContain('adminManagement.disabledByAdmin');
        const before = view._cardFingerprint(host);
        host.enabled = true;
        expect(view._cardFingerprint(host)).not.toBe(before);
        document.body.replaceChildren();
    });
    it('keeps existing hosts enabled by default', () => {
        expect(new Host({ state: 'online', pairState: 'paired' }).isAvailable).toBe(true);
    });
});
