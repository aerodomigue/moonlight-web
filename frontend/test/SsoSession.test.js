import { acceptAccount, leaveAccount } from '../js/util/authAccountState.js';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
vi.mock('../js/util/pairingCrypto.js', () => ({
    loadOrCreateIdentity: vi.fn(),
    bytesToBase64: (value) => Buffer.from(value).toString('base64'),
}));
import { loadOrCreateIdentity } from '../js/util/pairingCrypto.js';
import { SsoSession, authenticatedFetch } from '../js/api/SsoSession.js';
let pair;
let fetcher;
beforeEach(async () => {
    vi.stubGlobal('crypto', webcrypto);
    pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
        'sign',
        'verify',
    ]);
    const publicDer = await crypto.subtle.exportKey('spki', pair.publicKey);
    const keyId = Buffer.from(await crypto.subtle.digest('SHA-256', publicDer)).toString(
        'base64url',
    );
    loadOrCreateIdentity.mockResolvedValue({ privateKey: pair.privateKey, keyId });
    Object.assign(SsoSession, { sessionId: '', pageId: '', active: false, offset: 0 });
    fetcher = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetcher);
});
afterEach(() => vi.unstubAllGlobals());
describe('SSO request possession and document authority', () => {
    it('preserves ordinary PIN calls and never signs another origin', async () => {
        await SsoSession.fetch('/api/hosts');
        expect(fetcher).toHaveBeenCalledWith('/api/hosts', undefined);
        SsoSession.sessionId = 'session';
        await SsoSession.fetch('https://other.example/api/hosts');
        expect(fetcher).toHaveBeenLastCalledWith('https://other.example/api/hosts', undefined);
    });
    it('produces a verifiable RFC 9421 signature over exact URL, body, session and page', async () => {
        Object.assign(SsoSession, { sessionId: 'session', pageId: 'page' });
        await SsoSession.fetch('/api/hosts/a%2Fb?x=a%20b&x=c', {
            method: 'POST',
            body: '{"name":"é"}',
        });
        const [request, init] = fetcher.mock.calls[0];
        const h = init.headers;
        const params = h.get('Signature-Input').slice(3);
        expect(params).toContain('alg="ecdsa-p256-sha256";tag="moonlight-session"');
        const digest =
            'sha-256=:' +
            Buffer.from(
                await crypto.subtle.digest('SHA-256', new TextEncoder().encode('{"name":"é"}')),
            ).toString('base64') +
            ':';
        expect(h.get('Content-Digest')).toBe(digest);
        const canonical = [
            '"@method": POST',
            '"@path": /api/hosts/a%2Fb',
            '"@query": ?x=a%20b&x=c',
            '"content-digest": ' + digest,
            '"x-mw-session-id": session',
            '"x-mw-page-id": page',
            '"@signature-params": ' + params,
        ].join('\n');
        const signature = Buffer.from(h.get('Signature').slice(4, -1), 'base64');
        expect(
            await crypto.subtle.verify(
                { name: 'ECDSA', hash: 'SHA-256' },
                pair.publicKey,
                signature,
                new TextEncoder().encode(canonical),
            ),
        ).toBe(true);
        expect(await request.text()).toBe('{"name":"é"}');
        expect(pair.privateKey.extractable).toBe(false);
    });
    it('uses fresh nonces for retries and refuses sockets before document activation', async () => {
        SsoSession.sessionId = 'session';
        await SsoSession.fetch('/api/hosts');
        await SsoSession.fetch('/api/hosts');
        expect(fetcher.mock.calls[0][1].headers.get('Signature-Input')).not.toBe(
            fetcher.mock.calls[1][1].headers.get('Signature-Input'),
        );
        await expect(SsoSession.protocols('/ws')).rejects.toThrow('SSO revalidation required');
    });
    it('preserves Request bodies, methods and headers when attaching proofs', async () => {
        SsoSession.sessionId = 'session';
        const original = new Request(new URL('/api/action', location.href), {
            method: 'POST',
            body: 'payload',
            headers: { 'Content-Type': 'text/plain' },
        });
        await SsoSession.fetch(original);
        const [request, options] = fetcher.mock.calls[0];
        expect(request.method).toBe('POST');
        expect(await request.text()).toBe('payload');
        expect(options.headers.get('Content-Type')).toBe('text/plain');
        expect(options.headers.has('Signature')).toBe(true);
        expect(await original.text()).toBe('payload');
    });
    it('rejects an old account response even when its network request succeeded', async () => {
        acceptAccount({id:'a'});
        let resolve;
        fetcher.mockReturnValue(new Promise(r=>resolve=r));
        const pending=authenticatedFetch('/api/hosts');
        acceptAccount({id:'b'});
        resolve(new Response('{"hosts":[{"uuid":"a"}]}'));
        await expect(pending).rejects.toThrow('account_changed');
    });
    it('rejects body parsing that completes after logout', async () => {
        acceptAccount({id:'a'});
        let resolve;
        fetcher.mockResolvedValue({ok:true,json:()=>new Promise(r=>resolve=r)});
        const response=await authenticatedFetch('/api/hosts');
        const pending=response.json();
        leaveAccount();resolve({hosts:[{uuid:'private'}]});
        await expect(pending).rejects.toThrow('account_changed');
    });
    it('never sends an old action using a changed signing context', async () => {
        acceptAccount({id:'a'});
        Object.assign(SsoSession,{sessionId:'a',pageId:'page-a'});
        let resolve;
        loadOrCreateIdentity.mockReturnValue(new Promise(r=>resolve=r));
        const pending=SsoSession.fetch('/api/hosts/private/start',{method:'POST'});
        acceptAccount({id:'b'});
        Object.assign(SsoSession,{sessionId:'b',pageId:'page-b'});
        resolve({privateKey:pair.privateKey,keyId:'key'});
        await expect(pending).rejects.toThrow('account_changed');
        expect(fetcher).not.toHaveBeenCalled();
    });

});
