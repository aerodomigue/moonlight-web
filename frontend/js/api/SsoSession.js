import { loadOrCreateIdentity, bytesToBase64 } from '../util/pairingCrypto.js';

const encoder = new TextEncoder();
const random = () =>
    bytesToBase64(crypto.getRandomValues(new Uint8Array(32)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

// Page authority lives only in this document. Reload/BFCache restoration must repeat OIDC.
export const SsoSession = {
    sessionId: '',
    pageId: '',
    active: false,
    offset: 0,
    reset() {
        Object.assign(this, { sessionId: '', pageId: '', active: false, offset: 0 });
    },
    page() {
        return this.pageId || (this.pageId = random());
    },
    async fetch(input, init) {
        if (!this.sessionId) return fetch(input, init);
        const url = new URL(input instanceof Request ? input.url : input, location.href);
        if (url.origin !== location.origin || !url.pathname.startsWith('/api/'))
            return fetch(input, init);
        const identity = await loadOrCreateIdentity();
        if (!identity) throw new Error('Browser identity unavailable');
        const request = new Request(input instanceof Request ? input.clone() : url.href, init);
        const body = await request.clone().arrayBuffer();
        const digest = `sha-256=:${bytesToBase64(await crypto.subtle.digest('SHA-256', body))}:`;
        const created = Math.floor(Date.now() / 1000) + this.offset;
        const params = `("@method" "@path" "@query" "content-digest" "x-mw-session-id" "x-mw-page-id");created=${created};expires=${created + 60};nonce="${random()}";keyid="${identity.keyId}";alg="ecdsa-p256-sha256";tag="moonlight-session"`;
        const canonical = [
            `"@method": ${request.method}`,
            `"@path": ${url.pathname}`,
            `"@query": ${url.search || '?'}`,
            `"content-digest": ${digest}`,
            `"x-mw-session-id": ${this.sessionId}`,
            `"x-mw-page-id": ${this.page()}`,
            `"@signature-params": ${params}`,
        ].join('\n');
        const signature = await crypto.subtle.sign(
            { name: 'ECDSA', hash: 'SHA-256' },
            identity.privateKey,
            encoder.encode(canonical),
        );
        const headers = new Headers(request.headers);
        headers.set('Content-Digest', digest);
        headers.set('X-MW-Session-Id', this.sessionId);
        headers.set('X-MW-Page-Id', this.page());
        headers.set('Signature-Input', `mw=${params}`);
        headers.set('Signature', `mw=:${bytesToBase64(signature)}:`);
        return fetch(request, { headers });
    },
    async startup() {
        const response = await fetch('/api/auth/status', { cache: 'no-store' });
        if (!response.ok) throw new Error('Authentication unavailable');
        const status = await response.json();
        if (!status.sso_revalidation_required) return true;
        this.sessionId = status.sso_session_id;
        this.offset = Math.floor(status.server_time - Date.now() / 1000);
        const fragment = new URLSearchParams(location.hash.slice(1));
        const result = fragment.get('mw-sso');
        if (result) {
            fragment.delete('mw-sso');
            history.replaceState(
                {},
                '',
                location.pathname + location.search + (fragment.size ? '#' + fragment : ''),
            );
            const [ticket, page] = result.split('.');
            this.pageId = page;
            const activation = await this.fetch('/api/auth/oidc/activate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ticket }),
            });
            if (activation.ok) {
                this.active = true;
                return true;
            }
            this.pageId = random();
            history.replaceState({}, '', '/?auth_error=sso');
            return true;
        }
        if (new URLSearchParams(location.search).has('auth_error')) return true;
        const identity = await loadOrCreateIdentity();
        if (!identity) {
            history.replaceState({}, '', '/?auth_error=sso');
            return true;
        }
        const prepared = await this.fetch('/api/auth/oidc/prepare', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                purpose: 'revalidate',
                page_id: this.page(),
                return_path: this.returnPath(),
                public_key: identity.publicKeyBase64,
            }),
        });
        if (!prepared.ok) {
            history.replaceState({}, '', '/?auth_error=sso');
            return true;
        }
        location.assign((await prepared.json()).authorization_url);
        return false;
    },
    returnPath() {
        const path = ['/admin', '/sessions'].includes(location.pathname) ? location.pathname : '/';
        const outcome = new URLSearchParams(location.search).get('oidc_link');
        return path === '/admin' && ['ready', 'error', 'conflict'].includes(outcome)
            ? `${path}?oidc_link=${outcome}`
            : path;
    },
    async protocols(url) {
        if (!this.sessionId) return undefined;
        if (!this.active) throw new Error('SSO revalidation required');
        const target = new URL(url, location.href);
        const response = await this.fetch('/api/auth/ws-ticket', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: target.pathname }),
        });
        if (!response.ok) throw new Error('WebSocket authorization failed');
        return ['moonlight-session-v1', `mw-auth.${(await response.json()).ticket}`];
    },
};
export const authenticatedFetch = (...args) =>
    SsoSession.sessionId ? SsoSession.fetch(...args) : fetch(...args);
