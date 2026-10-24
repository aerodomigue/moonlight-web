import { BackendClient } from '../api/BackendClient.js';
import { escapeHtml } from '../util/escapeHtml.js';
import { t } from '../i18n/i18n.js';

/** Authentication settings are saved separately from the general server form. */
export class AdminLoginSettings {
    constructor(container, onChanged = () => {}) {
        this.container = container;
        this.onChanged = onChanged;
        this.config = null;
        this.destroyed = false;
        this.busy = false;
    }

    async start() {
        try {
            this.config = await BackendClient.get('/api/admin/auth-config');
            if (!this.destroyed) this.render();
        } catch (error) {
            if (!this.destroyed)
                this.container.textContent = `${t('adminAccounts.loadError')} ${error.message}`;
        }
    }

    destroy() {
        this.destroyed = true;
        const secret = this.container.querySelector('[name="client_secret"]');
        if (secret) secret.value = '';
    }

    render() {
        const c = this.config;
        const mode = c.pin ? (c.sso ? 'pin,sso' : 'pin') : 'sso';
        const esc = escapeHtml;
        this.container.innerHTML = `<section class="settings-section" id="admin-section-login">
            <h3 class="settings-section-title">${t('adminAccounts.loginTitle')}</h3>
            <form id="admin-login-form">
                <div class="settings-field"><label for="admin-login-mode">${t('adminAccounts.mode')}</label>
                    <select id="admin-login-mode" class="settings-select" name="mode">
                        <option value="pin" ${mode === 'pin' ? 'selected' : ''}>${t('adminAccounts.pinOnly')}</option>
                        <option value="pin,sso" ${mode === 'pin,sso' ? 'selected' : ''}>${t('adminAccounts.both')}</option>
                        <option value="sso" ${mode === 'sso' ? 'selected' : ''}>${t('adminAccounts.ssoOnly')}</option>
                    </select>
                    <p class="settings-hint">${t('adminAccounts.safeSsoOnly')}</p>
                </div>
                <div class="settings-field"><label for="admin-oidc-issuer">${t('adminAccounts.issuer')}</label>
                    <input class="settings-input" id="admin-oidc-issuer" name="issuer" type="url" maxlength="2048" value="${esc(c.issuer || '')}" /></div>
                <div class="settings-field"><label for="admin-oidc-client">${t('adminAccounts.clientId')}</label>
                    <input class="settings-input" id="admin-oidc-client" name="client_id" maxlength="1024" value="${esc(c.client_id || '')}" autocomplete="off" /></div>
                <div class="settings-field"><label for="admin-oidc-scopes">${t('adminAccounts.scopes')}</label>
                    <input class="settings-input" id="admin-oidc-scopes" name="scopes" maxlength="2048" value="${esc(c.scopes ?? 'openid profile email moonlight_role')}" />
                    <p class="settings-hint">${t('adminAccounts.roleClaimHint')}</p></div>
                <div class="settings-field"><label for="admin-oidc-secret">${t('adminAccounts.secret')}</label>
                    <input class="settings-input" id="admin-oidc-secret" name="client_secret" type="password" maxlength="16384" autocomplete="new-password" />
                    <p class="settings-hint">${t(c.secret_configured ? 'adminAccounts.secretKept' : 'adminAccounts.secretMissing')}</p>
                    <label><input type="checkbox" name="clear_secret" /> ${t('adminAccounts.clearSecret')}</label></div>
                <div class="settings-field"><label for="admin-oidc-ca">${t('adminAccounts.ca')}</label>
                    <input class="settings-input" id="admin-oidc-ca" name="ca_file" maxlength="4096" value="${esc(c.ca_file || '')}" /></div>
                <div class="settings-field"><label>${t('adminAccounts.publicUrl')}</label><code>${esc(c.public_url || '—')}</code></div>
                <div class="settings-field"><label>${t('adminAccounts.callback')}</label><code id="admin-oidc-callback">${esc(c.callback_url || '—')}</code>
                    <button type="button" class="btn btn-secondary" id="admin-copy-callback">${t('common.copy')}</button></div>
                <div class="settings-field"><label>${t('adminAccounts.backchannelUrl')}</label>
                    <code>${esc(c.backchannel_logout_url || '')}</code></div>
                <p class="settings-hint">${t('adminAccounts.backchannelHint')}</p>
                <p class="settings-hint">${t('adminAccounts.proxyHint')}</p>
                <p class="settings-hint" id="admin-login-feedback" role="status" aria-live="polite"></p>
                <button class="btn btn-secondary" type="button" id="admin-test-oidc">${t('adminAccounts.testProvider')}</button>
                <button class="btn btn-primary" type="submit">${t('adminAccounts.saveLogin')}</button>
            </form></section>`;
        this.container.querySelector('form').addEventListener('submit', (event) => {
            event.preventDefault();
            this.submit(false);
        });
        this.container
            .querySelector('#admin-test-oidc')
            .addEventListener('click', () => this.submit(true));
        this.container.querySelector('#admin-copy-callback').addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(c.callback_url);
                if (!this.destroyed) this.feedback(t('adminAccounts.copied'));
            } catch {
                if (!this.destroyed) this.feedback(t('adminAccounts.copyError'));
            }
        });
    }

    feedback(message) {
        this.container.querySelector('#admin-login-feedback').textContent = message;
    }

    async submit(test) {
        if (this.busy || this.destroyed) return;
        const form = this.container.querySelector('form');
        const fields = new FormData(form);
        const mode = String(fields.get('mode'));
        const data = {
            pin: mode.includes('pin'),
            sso: mode.includes('sso'),
            issuer: String(fields.get('issuer')).trim(),
            client_id: String(fields.get('client_id')).trim(),
            scopes: String(fields.get('scopes')).trim(),
            client_secret: String(fields.get('client_secret')),
            clear_secret: fields.get('clear_secret') === 'on',
            ca_file: String(fields.get('ca_file')).trim(),
        };
        this.busy = true;
        form.querySelectorAll('button').forEach((button) => (button.disabled = true));
        this.feedback(t('adminAccounts.working'));
        try {
            const result = await BackendClient.post(
                `/api/admin/auth-config${test ? '/test' : ''}`,
                data,
            );
            if (this.destroyed) return;
            if (!test) form.elements.client_secret.value = '';
            this.feedback(t(test ? 'adminAccounts.providerOk' : 'adminAccounts.saved'));
            if (!test) {
                this.config = result;
                await this.onChanged();
            }
        } catch (error) {
            if (!this.destroyed)
                this.feedback(`${t('adminAccounts.operationError')} ${error.message}`);
        } finally {
            this.busy = false;
            if (!this.destroyed)
                form.querySelectorAll('button').forEach((button) => (button.disabled = false));
        }
    }
}
