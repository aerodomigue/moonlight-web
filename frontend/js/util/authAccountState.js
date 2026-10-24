// Machine lists and preferences from one account must not survive an account
// switch in a shared browser. Pairing keys remain in IndexedDB: they authenticate
// this browser to this server and are bound independently to each server session.
export function acceptAccount(user) {
    if (!user?.id) return;
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
}
