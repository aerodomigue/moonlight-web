let revision = 0;
let account = null;
let channel;
let storageListener;
const listeners = new Set();

export function accountRevision() {
    return revision;
}
export function requireAccountRevision(expected) {
    if (expected !== revision) throw new Error('account_changed');
}
function clearAccountCaches() {
    try {
        for (const key of Object.keys(localStorage)) {
            if (
                (key.startsWith('mw-') || key.startsWith('mw_')) &&
                key !== 'mw-auth-user' &&
                key !== 'mw-streaming-settings'
            )
                localStorage.removeItem(key);
        }
    } catch {
        /* Storage is optional; authority lives on the server. */
    }
}
function publish(kind) {
    try {
        localStorage.setItem(
            'mw-auth-notification',
            JSON.stringify({ kind, account, event: crypto.randomUUID() }),
        );
    } catch {
        /* BroadcastChannel also works without browser storage. */
    }
    try {
        channel?.postMessage({ kind, account });
    } catch {
        /* Storage events remain available. */
    }
}
// Notifications only invalidate local state. They never grant authority or
// revoke the shared cookie, which may already belong to the next account.
export function watchAccountChanges(listener) {
    listeners.add(listener);
    if (listeners.size === 1) {
        const receive = (message) => {
            if (!account || !['login', 'logout'].includes(message?.kind)) return;
            if (message.kind === 'login' && message.account === account) return;
            if (message.kind === 'logout' && message.account && message.account !== account) return;
            ++revision;
            account = null;
            for (const callback of listeners) callback(message);
        };
        try {
            if (typeof BroadcastChannel !== 'undefined') {
                channel = new BroadcastChannel('moonlight-account');
                channel.onmessage = (event) => receive(event.data);
            }
        } catch {
            /* Restricted browser; storage events remain available. */
        }
        storageListener = (event) => {
            if (event.key === 'mw-auth-notification' && event.newValue) {
                try {
                    receive(JSON.parse(event.newValue));
                } catch {
                    /* Untrusted hint. */
                }
            }
            if (event.key === 'mw-auth-user')
                receive({
                    kind: event.newValue ? 'login' : 'logout',
                    account: event.newValue || event.oldValue,
                });
        };
        window.addEventListener('storage', storageListener);
    }
    return () => {
        listeners.delete(listener);
        if (!listeners.size) {
            channel?.close();
            channel = undefined;
            window.removeEventListener('storage', storageListener);
        }
    };
}
export function leaveAccount() {
    ++revision;
    clearAccountCaches();
    publish('logout');
    account = null;
    // Keep only the last account marker so returning to the same account can
    // retain video preferences; a different validated account clears them.
}
// Machine lists and preferences from one account must not survive an account
// switch in a shared browser. Pairing keys remain in IndexedDB: they authenticate
// this browser to this server and are bound independently to each server session.
export function acceptAccount(user) {
    if (!user?.id) return;
    if (account && account !== user.id) ++revision;
    account = user.id;
    try {
        const previous = localStorage.getItem('mw-auth-user');
        if (previous !== user.id && (previous !== null || user.id !== 'local-owner')) {
            for (const key of Object.keys(localStorage)) {
                if ((key.startsWith('mw-') || key.startsWith('mw_')) && key !== 'mw-auth-user') {
                    localStorage.removeItem(key);
                }
            }
        }
        localStorage.setItem('mw-auth-user', user.id);
    } catch {
        // Storage may be unavailable in private browsing. Authorization remains
        // server-side; no browser storage value grants access to a machine.
    }
    publish('login');
}
