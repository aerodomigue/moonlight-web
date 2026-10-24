import {beforeEach, describe, expect, it, vi} from 'vitest';
vi.mock('../js/api/BackendClient.js', () => ({BackendClient:{logout:vi.fn()}}));
vi.mock('../js/ui/ConfirmDialog.js', () => ({confirmAction:vi.fn(async()=>true)}));
vi.mock('../js/ui/Toast.js', () => ({Toast:{error:vi.fn()}}));
import {BackendClient} from '../js/api/BackendClient.js';
import {Toast} from '../js/ui/Toast.js';
import {SettingsView} from '../js/ui/SettingsView.js';

describe('Settings logout storage failure', () => {
    beforeEach(()=>vi.clearAllMocks());
    it('keeps the page and enables retry when revocation cannot be committed', async () => {
        BackendClient.logout.mockRejectedValue(new Error('Storage unavailable'));
        const button=document.createElement('button');
        const url=location.href;
        await SettingsView.prototype._logout.call({}, button);
        expect(button.disabled).toBe(false);
        expect(Toast.error).toHaveBeenCalledWith('Storage unavailable');
        expect(location.href).toBe(url);
    });
});
