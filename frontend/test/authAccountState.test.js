import { describe, it, expect, beforeEach } from 'vitest';
import { acceptAccount } from '../js/util/authAccountState.js';

describe('Browser state isolation on account changes', () => {
    beforeEach(() => localStorage.clear());
    it('preserves existing local-owner data during migration', () => {
        localStorage.setItem('mw-host-usage', 'old history');
        acceptAccount({ id: 'local-owner' });
        expect(localStorage.getItem('mw-host-usage')).toBe('old history');
    });
    it('clears machine history and browser device IDs before another account loads', () => {
        acceptAccount({ id: 'alice' });
        localStorage.setItem('mw-host-usage', 'Alice history');
        localStorage.setItem('mw_client_uniqueid', 'ALICE');
        localStorage.setItem('unrelated-application', 'keep');
        acceptAccount({ id: 'bob' });
        expect(localStorage.getItem('mw-host-usage')).toBeNull();
        expect(localStorage.getItem('mw_client_uniqueid')).toBeNull();
        expect(localStorage.getItem('mw-auth-user')).toBe('bob');
        expect(localStorage.getItem('unrelated-application')).toBe('keep');
    });
    it('preserves the same account data across browser sessions', () => {
        acceptAccount({ id: 'alice' });
        localStorage.setItem('mw-host-usage', 'Alice history');
        acceptAccount({ id: 'alice' });
        expect(localStorage.getItem('mw-host-usage')).toBe('Alice history');
    });
    it('clears legacy local history on the first SSO login', () => {
        localStorage.setItem('mw-host-usage', 'Local history');
        acceptAccount({ id: 'alice' });
        expect(localStorage.getItem('mw-host-usage')).toBeNull();
    });
    it('does not change storage for an anonymous response', () => {
        localStorage.setItem('mw-host-usage', 'Local history');
        acceptAccount(null);
        expect(localStorage.getItem('mw-host-usage')).toBe('Local history');
    });
});
