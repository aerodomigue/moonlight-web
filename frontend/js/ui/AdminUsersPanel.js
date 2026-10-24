import { BackendClient } from '../api/BackendClient.js';
import { escapeHtml } from '../util/escapeHtml.js';
import { t } from '../i18n/i18n.js';

export class AdminUsersPanel {
    constructor(container) {
        this.container = container;
        this.users = [];
        this.hosts = [];
        this.selected = '';
        this.config = {};
        this.pending = null;
        this.message = '';
        this.busy = false;
        this.destroyed = false;
        this.revision = 0;
        this.pinTimer = null;
    }

    destroy() {
        this.destroyed = true;
        this.revision++;
        clearTimeout(this.pinTimer);
        this.container
            .querySelectorAll('[data-account-pin]')
            .forEach((node) => (node.textContent = ''));
    }

    async start() {
        try {
            const [users, config, pending] = await Promise.all([
                BackendClient.get('/api/admin/users'),
                BackendClient.get('/api/admin/auth-config'),
                BackendClient.get('/api/admin/users/sso/pending'),
            ]);
            if (this.destroyed) return;
            const url = new URL(window.location.href);
            const outcome = url.searchParams.get('oidc_link');
            if (outcome) {
                if (outcome !== 'ready') this.message = t('adminAccounts.linkFailed');
                url.searchParams.delete('oidc_link');
                window.history.replaceState({}, '', url);
            }
            this.users = users.users;
            this.config = config;
            this.pending = pending.pending ? pending : null;
            if (!this.users.some((u) => u.id === this.selected))
                this.selected = this.pending?.user_id || this.users[0]?.id || '';
            await this.loadHosts();
        } catch (error) {
            if (!this.destroyed)
                this.container.textContent = `${t('adminAccounts.loadError')} ${error.message}`;
        }
    }

    async loadHosts() {
        const revision = ++this.revision;
        const result = this.selected
            ? await BackendClient.get(`/api/admin/users/${encodeURIComponent(this.selected)}/hosts`)
            : { hosts: [] };
        if (this.destroyed || revision !== this.revision) return;
        this.hosts = result.hosts;
        this.render();
    }

    render() {
        const esc = escapeHtml;
        const user = this.users.find((u) => u.id === this.selected);
        const methods = (user) =>
            [this.config.pin ? 'PIN' : '', this.config.sso && user.sso_linked ? 'SSO' : '']
                .filter(Boolean)
                .join(' / ') || t('adminAccounts.noMethod');
        const roleOptions = (role) =>
            `<option value="user" ${role === 'user' ? 'selected' : ''}>${t('adminAccounts.userRole')}</option><option value="admin" ${role === 'admin' ? 'selected' : ''}>${t('adminAccounts.adminRole')}</option>`;
        this.container.innerHTML = `<section class="settings-section" id="admin-section-users">
            <h3 class="settings-section-title">${t('adminAccounts.usersTitle')}</h3>
            <form id="admin-create-user" class="settings-field"><label for="admin-new-user">${t('adminAccounts.createLocal')}</label>
                <input class="settings-input" name="name" id="admin-new-user" maxlength="256" required />
                <select class="settings-select" aria-label="${t('adminAccounts.role')}" name="role">${roleOptions('user')}</select>
                <button class="btn btn-secondary" type="submit">${t('adminAccounts.create')}</button></form>
            <div class="settings-field"><label for="admin-user-select">${t('adminAccounts.account')}</label>
                <select id="admin-user-select" class="settings-select">${this.users.map((u) => `<option value="${esc(u.id)}" ${u.id === this.selected ? 'selected' : ''}>${esc(u.name)} · ${methods(u)} · ${t(u.role === 'admin' ? 'adminAccounts.adminRole' : 'adminAccounts.userRole')} · ${t(u.deleting ? 'adminAccounts.deleting' : u.enabled ? 'adminAccounts.enabled' : 'adminAccounts.disabled')}</option>`).join('')}</select></div>
            ${user ? `<p class="settings-hint" data-user-counts>${t('adminAccounts.counts', { machines: user.machine_count, sessions: user.session_count })}</p>` : ''}
            <p id="admin-users-feedback" role="status" aria-live="polite">${esc(this.message)}</p>
            <div data-account-pin role="status"></div>
            ${
                user
                    ? `<form id="admin-edit-user"><div class="settings-field"><label for="admin-user-name">${t('adminAccounts.name')}</label>
                <input id="admin-user-name" class="settings-input" name="name" maxlength="256" required value="${esc(user.name)}" />
                <select class="settings-select" aria-label="${t('adminAccounts.role')}" name="role" ${user.protected ? 'disabled' : ''}>${roleOptions(user.role)}</select>
                <label><input type="checkbox" name="enabled" ${user.enabled ? 'checked' : ''} ${user.protected ? 'disabled' : ''} /> ${t('adminAccounts.enabled')}</label>
                <button class="btn btn-secondary" type="submit" ${user.deleting ? 'disabled' : ''}>${t('adminAccounts.saveUser')}</button></div></form>
                <button class="btn btn-secondary" data-user-action="pin" ${!this.config.pin || !user.enabled || user.deleting ? 'disabled' : ''}>${t('adminAccounts.generatePin')}</button>
                <button class="btn btn-secondary" data-user-action="revoke">${t('adminAccounts.revokeSessions')}</button>
                ${user.sso_linked ? `<p class="settings-hint">${esc(user.issuer)}<br />${esc(user.subject)}</p><button class="btn btn-secondary" data-user-action="unlink">${t('adminAccounts.unlinkSso')}</button>` : `<button class="btn btn-secondary" data-user-action="link" ${!this.config.sso || !user.enabled ? 'disabled' : ''}>${t('adminAccounts.linkSso')}</button>`}
                <button class="btn btn-secondary" data-user-action="delete" ${user.protected ? 'disabled' : ''}>${t('adminAccounts.deleteUser')}</button>
                ${this.pending?.user_id === user.id ? `<div class="settings-field"><p>${t('adminAccounts.confirmIdentity')} ${esc(this.pending.name)} — ${esc(this.pending.issuer)} — ${esc(this.pending.subject)}</p><button class="btn btn-primary" data-user-action="confirm-link">${t('adminAccounts.confirmLink')}</button></div>` : ''}
                <h4>${t('adminAccounts.machines')}</h4><p class="settings-hint">${t('adminAccounts.sharedPairing')}</p>
                ${
                    this.hosts.length
                        ? this.hosts
                              .map(
                                  (
                                      host,
                                  ) => `<div class="settings-field" data-host-row="${esc(host.uuid)}"><strong>${esc(host.customName || host.name || host.uuid)}</strong>
                    <select class="settings-select" aria-label="${t('adminAccounts.destination')}">${this.users
                        .filter((u) => u.id !== user.id && !u.deleting)
                        .map((u) => `<option value="${esc(u.id)}">${esc(u.name)}</option>`)
                        .join('')}</select>
                    <button class="btn btn-secondary" data-host-action="transfer" ${host.backendType === 'native' ? 'disabled' : ''}>${t('adminAccounts.transfer')}</button>
                    <button class="btn btn-secondary" data-host-action="duplicate" ${host.backendType === 'native' ? 'disabled' : ''}>${t('adminAccounts.duplicate')}</button>
                    <button class="btn btn-secondary" data-host-action="delete" ${host.backendType === 'native' ? 'disabled' : ''}>${t('adminAccounts.deleteMachine')}</button></div>`,
                              )
                              .join('')
                        : `<p>${t('adminAccounts.noMachines')}</p>`
                }
                `
                    : ''
            }
            </section>`;
        this.container.querySelector('#admin-create-user').addEventListener('submit', (event) => {
            event.preventDefault();
            const fields = new FormData(event.currentTarget);
            this.act(async () => {
                const result = await BackendClient.post('/api/admin/users', {
                    name: fields.get('name'),
                    role: fields.get('role'),
                });
                this.selected = result.user.id;
            });
        });
        this.container.querySelector('#admin-user-select').addEventListener('change', (event) => {
            if (this.busy) return;
            this.selected = event.target.value;
            this.message = '';
            this.act(() => this.loadHosts(), false);
        });
        this.container.querySelector('#admin-edit-user')?.addEventListener('submit', (event) => {
            event.preventDefault();
            const fields = new FormData(event.currentTarget);
            this.act(() =>
                BackendClient.post(`/api/admin/users/${encodeURIComponent(user.id)}`, {
                    name: fields.get('name'),
                    role: user.protected ? 'admin' : fields.get('role'),
                    enabled: user.protected || fields.get('enabled') === 'on',
                }),
            );
        });
        this.container
            .querySelectorAll('[data-user-action]')
            .forEach((button) =>
                button.addEventListener('click', () =>
                    this.userAction(button.dataset.userAction, user),
                ),
            );
        this.container
            .querySelectorAll('[data-host-action]')
            .forEach((button) =>
                button.addEventListener('click', () =>
                    this.hostAction(button.dataset.hostAction, button.closest('[data-host-row]')),
                ),
            );
    }

    async act(action, reload = true) {
        if (this.busy || this.destroyed) return;
        this.busy = true;
        const disabled = new Map();
        this.container.querySelectorAll('button, input, select').forEach((node) => {
            disabled.set(node, node.disabled);
            node.disabled = true;
        });
        try {
            await action();
            if (this.destroyed) return;
            if (reload) {
                this.message = t('adminAccounts.saved');
                await this.start();
            }
        } catch (error) {
            if (!this.destroyed) {
                this.message = `${t('adminAccounts.operationError')} ${error.message}`;
                this.render();
            }
        } finally {
            this.busy = false;
            if (!this.destroyed)
                disabled.forEach((value, node) => {
                    if (node.isConnected) node.disabled = value;
                });
        }
    }

    userAction(action, user) {
        const path = `/api/admin/users/${encodeURIComponent(user.id)}`;
        if (action === 'pin') {
            return this.act(async () => {
                const result = await BackendClient.post(`${path}/pin`, {});
                if (this.destroyed) return;
                const area = this.container.querySelector('[data-account-pin]');
                area.textContent = `${t('adminAccounts.pinFor', { name: user.name })} ${result.pin} — ${t(result.expires_in ? 'adminAccounts.pinExpiry' : 'adminAccounts.ownerPinExpiry')}`;
                clearTimeout(this.pinTimer);
                this.pinTimer = setTimeout(() => {
                    if (!this.destroyed) area.textContent = '';
                }, 300000);
            }, false);
        }
        if (
            action === 'delete' &&
            !confirm(
                t('adminAccounts.confirmDeleteUser', {
                    name: user.name,
                    machines: user.machine_count,
                    sessions: user.session_count,
                }),
            )
        )
            return;
        if (action === 'revoke' && !confirm(t('adminAccounts.confirmRevoke', { name: user.name })))
            return;
        if (action === 'unlink' && !confirm(t('adminAccounts.confirmUnlink'))) return;
        if (action === 'link') {
            if (
                this.config.public_url &&
                new URL(this.config.public_url).origin !== window.location.origin
            ) {
                this.message = t('adminAccounts.usePublicAdmin', {
                    url: `${this.config.public_url}/admin`,
                });
                this.render();
                return;
            }
            return this.act(async () => {
                const result = await BackendClient.post(`${path}/sso/prepare`, {});
                if (!this.destroyed) window.location.assign(result.authorization_url);
            }, false);
        }
        return this.act(async () => {
            if (action === 'delete') await BackendClient.del(path);
            if (action === 'revoke') await BackendClient.post(`${path}/revoke-sessions`, {});
            if (action === 'unlink') await BackendClient.post(path, { unlink_sso: true });
            if (action === 'confirm-link') await BackendClient.post(`${path}/sso/confirm`, {});
        });
    }

    hostAction(action, row) {
        const target = row.querySelector('select').value;
        const path = `/api/admin/hosts/${encodeURIComponent(row.dataset.hostRow)}`;
        if (action !== 'delete' && !target) return;
        if (
            !confirm(
                t(
                    action === 'delete'
                        ? 'adminAccounts.confirmDeleteMachine'
                        : 'adminAccounts.confirmMachineAction',
                ),
            )
        )
            return;
        return this.act(() =>
            action === 'delete'
                ? BackendClient.del(path)
                : BackendClient.post(`${path}/${action}`, { user_id: target }),
        );
    }
}
