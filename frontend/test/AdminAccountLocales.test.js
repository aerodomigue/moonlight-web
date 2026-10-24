import { afterEach, describe, expect, it, vi } from 'vitest';
import { init, t } from '../js/i18n/i18n.js';
import en from '../locales/en.json';
import fr from '../locales/fr.json';
import zh from '../locales/zh.json';

const dictionaries = { en, fr, zh };
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
describe('Account administration translated confirmations', () => {
    it.each(['en', 'fr', 'zh'])('renders actual account names and deletion counts in %s', async (language) => {
        localStorage.setItem('mw-lang', language);
        vi.stubGlobal('fetch', vi.fn(async (url) => ({ ok: true, json: async () => dictionaries[url.includes('/fr.json') ? 'fr' : url.includes('/zh.json') ? 'zh' : 'en'] })));
        await init();
        const confirmation = t('adminAccounts.confirmDeleteUser', { name: 'Alice', machines: 7, sessions: 9 });
        expect(confirmation).toContain('Alice');
        expect(confirmation).toContain('7');
        expect(confirmation).toContain('9');
        expect(confirmation).not.toContain('{');
        expect(t('adminAccounts.counts', { machines: 7, sessions: 9 })).not.toContain('{');
        expect(t('adminAccounts.pinFor', { name: 'Alice' })).toContain('Alice');
    });
});
