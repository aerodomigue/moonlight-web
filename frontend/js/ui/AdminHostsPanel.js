import { BackendClient } from '../api/BackendClient.js';
import { escapeHtml } from '../util/escapeHtml.js';
import { t } from '../i18n/i18n.js';
import { confirmAction } from './ConfirmDialog.js';

/** Administrative registrations, separate from the user's host routes. */
export class AdminHostsPanel {
    constructor(container, onChanged = () => {}) {
        this.container = container;
        this.onChanged = onChanged;
        this.hosts = [];
        this.users = [];
        this.owner = '';
        this.search = '';
        this.state = '';
        this.revision = 0;
        this.busy = false;
        this.destroyed = false;
        this.message = '';
    }
    destroy() {
        this.destroyed = true;
        this.revision++;
    }
    async start() {
        const revision = ++this.revision;
        try {
            const [hosts, users] = await Promise.all([
                BackendClient.get('/api/admin/hosts'),
                BackendClient.get('/api/admin/users'),
            ]);
            if (this.destroyed || revision !== this.revision) return;
            this.hosts = hosts.hosts;
            this.users = users.users;
            this.render();
        } catch (error) {
            if (!this.destroyed && revision === this.revision) {
                this.container.textContent = `${t('adminAccounts.loadError')} ${error.message}`;
            }
        }
    }
    async showOwner(id) {
        this.owner = id;
        await this.start();
    }
    render() {
        const esc = escapeHtml;
        this.container.innerHTML = `<section class="settings-section">
            <h3 class="settings-section-title">${t('settingsTabs.hosts')}</h3>
            <p class="settings-hint">${t('adminAccounts.sharedPairing')}</p>
            <div class="admin-host-filters">
                <label>${t('adminManagement.searchHosts')}<input type="search" class="settings-input" data-host-search value="${esc(this.search)}" /></label>
                <label>${t('adminManagement.owner')}<select class="settings-select" data-host-owner><option value="">${t('adminManagement.all')}</option>${this.users.map((u) => `<option value="${esc(u.id)}" ${this.owner === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>
                <label>${t('adminManagement.state')}<select class="settings-select" data-host-state><option value="">${t('adminManagement.all')}</option>${['enabled', 'disabled', 'online', 'offline', 'busy'].map((key) => `<option value="${key}" ${this.state === key ? 'selected' : ''}>${t(`adminManagement.${key}`)}</option>`).join('')}</select></label>
                <button class="btn btn-secondary" data-host-refresh>${t('adminManagement.refresh')}</button>
            </div>
            <p role="status" aria-live="polite" data-host-feedback>${esc(this.message)}</p>
            <div class="admin-host-list">${this.hosts
                .map((host) => {
                    const user = this.users.find((u) => u.id === host.owner_id);
                    const blocked = host.blocked_reason;
                    return `<article class="admin-host-row" data-host-row="${esc(host.uuid)}">
                    <div><strong>${esc(host.customName || host.name)}</strong><p>${esc(user?.name || host.owner_id)} · ${esc(host.backendType || 'GameStream')}</p>
                    <p>${t(host.state === 'online' ? 'adminManagement.online' : 'adminManagement.offline')} · ${t(host.enabled === false ? 'adminManagement.disabled' : 'adminManagement.enabled')}</p>
                    ${blocked ? `<p class="settings-hint">${t(blocked === 'native' ? 'adminManagement.nativeProtected' : 'adminManagement.busyReason')}</p>` : ''}</div>
                    <details><summary>${t('adminManagement.actions')}</summary>
                        <label>${t('adminAccounts.destination')}<select class="settings-select" data-host-target>${this.users
                            .filter((u) => u.id !== host.owner_id && u.enabled && !u.deleting)
                            .map((u) => `<option value="${esc(u.id)}">${esc(u.name)}</option>`)
                            .join('')}</select></label>
                        ${['transfer', 'duplicate', 'enabled', 'delete'].map((action) => `<button class="btn btn-secondary" data-host-action="${action}" ${blocked ? 'disabled' : ''}>${t(action === 'enabled' ? (host.enabled === false ? 'adminManagement.enable' : 'adminManagement.disable') : `adminManagement.${action}`)}</button>`).join('')}
                    </details>
                </article>`;
                })
                .join('')}</div><p data-host-empty hidden>${t('adminManagement.noResults')}</p>
        </section>`;
        const bind = (selector, key, event) =>
            this.container.querySelector(selector).addEventListener(event, (e) => {
                this[key] = e.target.value;
                this.filter();
            });
        bind('[data-host-search]', 'search', 'input');
        bind('[data-host-owner]', 'owner', 'change');
        bind('[data-host-state]', 'state', 'change');
        this.container.querySelector('[data-host-refresh]').addEventListener('click', () => {
            if (!this.busy) this.start();
        });
        this.container.querySelectorAll('[data-host-action]').forEach((button) =>
            button.addEventListener('click', () => {
                const row = button.closest('[data-host-row]');
                this.action(
                    button.dataset.hostAction,
                    this.hosts.find((h) => h.uuid === row.dataset.hostRow),
                    row.querySelector('[data-host-target]').value,
                );
            }),
        );
        this.filter();
    }
    filter() {
        let visible = 0;
        for (const row of this.container.querySelectorAll('[data-host-row]')) {
            const host = this.hosts.find((h) => h.uuid === row.dataset.hostRow);
            const states = {
                enabled: host.enabled !== false,
                disabled: host.enabled === false,
                online: host.state === 'online',
                offline: host.state !== 'online',
                busy: host.busy,
            };
            row.hidden =
                (!!this.owner && host.owner_id !== this.owner) ||
                (!!this.state && !states[this.state]) ||
                !row.textContent
                    .toLocaleLowerCase()
                    .includes(this.search.toLocaleLowerCase().trim());
            if (!row.hidden) visible++;
        }
        this.container.querySelector('[data-host-empty]').hidden = visible > 0;
    }
    async action(action, host, target) {
        if (this.busy || this.destroyed || host.blocked_reason) return;
        const destination = this.users.find((u) => u.id === target);
        if (
            ['transfer', 'duplicate'].includes(action) &&
            (!destination || destination.deleting || !destination.enabled)
        )
            return;
        const label = t(
            action === 'enabled'
                ? host.enabled === false
                    ? 'adminManagement.enable'
                    : 'adminManagement.disable'
                : `adminManagement.${action}`,
        );
        const message = `${label} — ${host.customName || host.name}${['transfer', 'duplicate'].includes(action) ? ` → ${destination.name}` : ''}\n${t(action === 'delete' ? 'adminAccounts.confirmDeleteMachine' : 'adminAccounts.confirmMachineAction')}`;
        this.busy = true;
        try {
            if (
                !(await confirmAction(message, {
                    inApp: true,
                    danger: action === 'delete',
                    confirmLabel: label,
                })) ||
                this.destroyed
            )
                return;
            this.container.querySelectorAll('button, select').forEach((node) => {
                node.disabled = true;
            });
            const path = `/api/admin/hosts/${encodeURIComponent(host.uuid)}`;
            if (action === 'delete') await BackendClient.del(path);
            else
                await BackendClient.post(
                    `${path}/${action}`,
                    action === 'enabled'
                        ? { enabled: host.enabled === false }
                        : { user_id: target },
                );
            if (this.destroyed) return;
            this.message = t('adminAccounts.saved');
            this.onChanged();
            await this.start();
        } catch (error) {
            if (!this.destroyed) {
                this.message = `${t('adminAccounts.operationError')} ${error.message}`;
                this.render();
            }
        } finally {
            this.busy = false;
        }
    }
}
