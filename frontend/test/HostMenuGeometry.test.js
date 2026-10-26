import { describe, it, expect, vi } from 'vitest';
import { HostListView } from '../js/ui/HostListView.js';
describe('host menu viewport placement', () => {
    function menuAt(anchor, rect) {
        document.body.innerHTML = '<div class="host-card menu-open"><div><div class="host-menu"></div></div></div>';
        const menu = document.querySelector('.host-menu');
        menu.parentElement.getBoundingClientRect = () => anchor;
        menu.getBoundingClientRect = () => rect;
        HostListView.prototype._positionMenu(menu);
        return menu;
    }
    it('opens upward and remains scrollable near the bottom', () => {
        const menu = menuAt({ top: innerHeight - 50, bottom: innerHeight - 20 }, { height: 180, left: 100, right: 250 });
        expect(menu.style.top).toBe('auto');
        expect(menu.style.bottom).toBe('calc(100% + 4px)');
        expect(parseFloat(menu.style.maxHeight)).toBeLessThan(innerHeight);
    });
    it('corrects overflow at either horizontal edge', () => {
        const menu = menuAt({ top: 50, bottom: 80 }, { height: 180, left: -40, right: 110 });
        expect(menu.style.right).toBe('-48px');
        const right = menuAt({ top: 50, bottom: 80 }, { height: 180, left: innerWidth - 100, right: innerWidth + 50 });
        expect(right.style.right).toBe('58px');
    });
    it('does not reposition a menu while scrolling inside it', () => {
        document.body.innerHTML = '<main></main>';
        const view = new HostListView(document.querySelector('main'));
        try {
            view.container.insertAdjacentHTML('beforeend', '<div class="host-menu"><button>Action</button></div>');
            const place = vi.spyOn(view, '_positionMenu').mockImplementation(() => {});
            view.container.querySelector('.host-menu').dispatchEvent(new Event('scroll'));
            expect(place).not.toHaveBeenCalled();
            window.dispatchEvent(new Event('resize'));
            expect(place).toHaveBeenCalledOnce();
        } finally { view.destroy(); }
    });
    it('clears the raised card when the menu closes', () => {
        menuAt({ top: 50, bottom: 80 }, { height: 180, left: 100, right: 250 });
        HostListView.prototype._closeAllMenus.call({ container: document.body });
        expect(document.querySelector('.menu-open')).toBeNull();
        expect(document.querySelector('.host-menu').hidden).toBe(true);
    });
});
