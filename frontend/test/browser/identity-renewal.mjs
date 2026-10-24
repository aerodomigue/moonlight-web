import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const { chromium } = await import(process.env.MW_PLAYWRIGHT_MODULE || 'playwright');
const base = process.argv[2];
const browser = await chromium.launch();
const options = {
    ignoreHTTPSErrors: true,
    locale: 'fr-FR',
    extraHTTPHeaders: { 'X-Forwarded-For': '203.0.113.20', 'X-Forwarded-Proto': 'https' },
};
try {
    const context = await browser.newContext(options);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(base, { waitUntil: 'networkidle' });
    const first = await page.evaluate(async () => {
        const p = await import('/js/util/pairingCrypto.js');
        const browser = await p.loadOrCreateIdentity();
        const old = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
            'sign',
            'verify',
        ]);
        const key = new Uint8Array(await crypto.subtle.exportKey('spki', old.publicKey));
        const id = p
            .bytesToBase64(await crypto.subtle.digest('SHA-256', key))
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
        if (!(await p.rememberHostIdentity(p.bytesToBase64(key), id)))
            throw new Error('Cannot seed stale host identity');
        return { browserKey: browser.keyId, oldId: id, oldKey: p.bytesToBase64(key) };
    });
    await page.locator('#btn-login-sso').click();
    await page.locator('#view-hosts').waitFor({ timeout: 15000 });
    const afterSso = await page.evaluate(async () => {
        const { loadOrCreateIdentity } = await import('/js/util/pairingCrypto.js');
        const i = await loadOrCreateIdentity();
        const status = await (await import('/js/api/BackendClient.js')).BackendClient.getAuthStatus();
        return {
            browserKey: i.keyId,
            hostId: i.hostId,
            apiId: status.host_id,
            extractable: i.privateKey.extractable,
        };
    });
    assert.equal(afterSso.browserKey, first.browserKey);
    assert.equal(afterSso.hostId, afterSso.apiId);
    assert.notEqual(afterSso.hostId, first.oldId);
    assert.equal(afterSso.extractable, false);
    console.log(
        'PASS: stale IndexedDB identity automatically renewed after real OIDC login; browser private key preserved.',
    );

    const pin = await page.evaluate(async (old) => {
        const { BackendClient: api } = await import('/js/api/BackendClient.js');
        const p = await import('/js/util/pairingCrypto.js');
        const current = await p.loadOrCreateIdentity();
        const pin = (await api.generateAccountPin()).pin;
        await api.post('/api/admin/auth-config', {}); // cancel fresh-login grants, retain the cookie
        if (
            !(await p.rememberHostIdentity(old.oldKey, old.oldId, {
                replace: true,
                expectedBrowserKey: current.publicKeyBase64,
                expectedHostId: current.hostId,
            }))
        )
            throw new Error('Cannot reproduce stale pre-upgrade browser record');
        return pin;
    }, first);
    const stale = await page.evaluate(async () => (await import('/js/api/BackendClient.js')).BackendClient.getAuthStatus());
    assert.equal(stale.identity_error, 'identityChanged');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#view-hosts').waitFor({ timeout: 15000 });
    assert.equal(await page.evaluate(async () => (await (await import('/js/util/pairingCrypto.js')).loadOrCreateIdentity()).hostId), afterSso.apiId);
    console.log('PASS: reload performs fresh OIDC and renews identity; a cached cookie alone cannot renew it.');
    await page.evaluate(async () => (await import('/js/api/BackendClient.js')).BackendClient.logout());
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#btn-login-pin').waitFor();
    await page.locator('#btn-login-pin').click();
    await page.locator('#login-pin-input').fill(pin);
    await page.locator('#btn-login-unlock').click();
    await page.locator('#view-hosts').waitFor({ timeout: 15000 });
    assert.deepEqual(
        await page.evaluate(async () => {
            const { loadOrCreateIdentity } = await import('/js/util/pairingCrypto.js');
            const i = await loadOrCreateIdentity();
            return { browserKey: i.keyId, hostId: i.hostId };
        }),
        { browserKey: first.browserKey, hostId: afterSso.hostId },
    );
    console.log(
        'PASS: restored cookie cannot replace stale identity; PIN renews it without clearing browser keys.',
    );

    const storage = await page.evaluate(async (old) => {
        const p = await import('/js/util/pairingCrypto.js');
        const current = await p.loadOrCreateIdentity();
        const options = {
            replace: true,
            expectedBrowserKey: current.publicKeyBase64,
            expectedHostId: 'obsolete-reply',
        };
        const lateReplyRejected = !(await p.rememberHostIdentity(old.oldKey, old.oldId, options));
        const inconsistentIdRejected = !(await p.rememberHostIdentity(old.oldKey, current.hostId));
        const transaction = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function (...args) {
            if (args[1] === 'readwrite') throw new Error('Test storage write failure');
            return transaction.apply(this, args);
        };
        let failedWriteRejected;
        try {
            failedWriteRejected = !(await p.rememberHostIdentity(
                current.hostPublicKey,
                current.hostId,
            ));
        } finally {
            IDBDatabase.prototype.transaction = transaction;
        }
        return { lateReplyRejected, inconsistentIdRejected, failedWriteRejected };
    }, first);
    assert.deepEqual(storage, {
        lateReplyRejected: true,
        inconsistentIdRejected: true,
        failedWriteRejected: true,
    });
    console.log(
        'PASS: late replies, inconsistent key/id pairs and IndexedDB write failures are refused.',
    );

    await page.evaluate(async (old) => {
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('mw-pairing', 1);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        try {
            await new Promise((resolve, reject) => {
                const tx = db.transaction('keys', 'readwrite');
                const store = tx.objectStore('keys');
                const request = store.get('mw-bind-v1');
                request.onsuccess = () => {
                    const record = request.result;
                    record.hostPublicKey = old.oldKey;
                    delete record.hostId;
                    store.put(record, 'mw-bind-v1');
                };
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
        } finally {
            db.close();
        }
        const { BackendClient } = await import('/js/api/BackendClient.js');
        if ((await BackendClient.getAuthStatus()).identity_error)
            throw new Error('Legacy identity metadata could not be renewed');
    }, first);
    console.log('PASS: a legacy record with no host-id metadata renews after fresh login.');

    const clean = await browser.newContext(options);
    const fresh = await clean.newPage();
    await fresh.goto(base, { waitUntil: 'networkidle' });
    await fresh.locator('#btn-login-sso').click();
    await fresh.locator('#view-hosts').waitFor({ timeout: 15000 });
    const freshKey = await fresh.evaluate(
        async () =>
            (await (await import('/js/util/pairingCrypto.js')).loadOrCreateIdentity()).keyId,
    );
    assert.notEqual(freshKey, first.browserKey);
    console.log(
        'PASS: a new browser signs in with its own key and receives the current server identity.',
    );

    const tabs = await browser.newContext(options);
    const a = await tabs.newPage(),
        b = await tabs.newPage();
    await Promise.all([
        a.goto(base + '/js/util/pairingCrypto.js'),
        b.goto(base + '/js/util/pairingCrypto.js'),
    ]);
    const keys = await Promise.all(
        [a, b].map((page) =>
            page.evaluate(
                async () =>
                    (await (await import('/js/util/pairingCrypto.js')).loadOrCreateIdentity())
                        .keyId,
            ),
        ),
    );
    assert.equal(keys[0], keys[1]);
    await a.exposeFunction('nativePairingFixture', (input) =>
        JSON.parse(
            execFileSync(process.env.MW_BINDING_FIXTURE, ['--browser-fixture'], {
                input: JSON.stringify(input) + '\n',
                encoding: 'utf8',
            }),
        ),
    );
    const negotiation = await a.evaluate(async () => {
        const p = await import('/js/util/pairingCrypto.js');
        const { WebRtcDataChannel } = await import('/js/api/WebRtcDataChannel.js');
        const { WebRtcMedia } = await import('/js/api/WebRtcMedia.js');
        const host = new RTCPeerConnection({ iceServers: [] });
        host.createDataChannel('video', { negotiated: true, id: 0 });
        host.createDataChannel('input', { negotiated: true, id: 2 });
        const audio = host.addTransceiver('audio', { direction: 'sendonly' });
        // Match Moonlight-Web's Opus-only RTP offer. Chrome's additional RED
        // codec exercises a separate pre-existing SDP rewrite issue, recorded
        // for the audit after the identity fix has been deployed.
        audio.setCodecPreferences(
            RTCRtpSender.getCapabilities('audio').codecs.filter(
                (codec) => codec.mimeType.toLowerCase() === 'audio/opus',
            ),
        );
        await host.setLocalDescription(await host.createOffer());
        const identity = await p.beginHandshake();
        const offer = await window.nativePairingFixture({
            mode: 'offer',
            browser_key: identity.publicKeyBase64,
            browser_nonce: p.bytesToBase64(identity.nonceB),
            sdp: host.localDescription.sdp,
        });
        const bound = { ...identity, hostPublicKey: offer.host_public_key, hostId: offer.host_id };
        let accepted = 0,
            refused = 0;
        try {
            for (const Transport of [WebRtcDataChannel, WebRtcMedia]) {
                for (const kind of [
                    'honest',
                    'host-id',
                    'fingerprint',
                    'signature',
                    'replay',
                    'missing-identity',
                ]) {
                    const transport = new Transport('wss://test.invalid');
                    transport.pc = new RTCPeerConnection({ iceServers: [] });
                    const connection = transport.pc;
                    transport._mwBind = kind === 'missing-identity' ? identity : { ...bound };
                    if (kind === 'replay') transport._mwBind.nonceB = p.generateNonce();
                    const message = { ...offer };
                    if (kind === 'host-id') message.host_id = 'different-host';
                    if (kind === 'fingerprint')
                        message.sdp = message.sdp.replace(
                            /a=fingerprint:sha-256 ([0-9A-F]{2})/i,
                            (_, byte) =>
                                'a=fingerprint:sha-256 ' +
                                (byte.toUpperCase() === '00' ? '01' : '00'),
                        );
                    if (kind === 'signature') delete message.sig;
                    const failures = [];
                    transport.onError = (error) => failures.push(error.message);
                    transport._startIceTimer = () => {};
                    let answer;
                    transport._sendSignaling = (msg) => {
                        answer = msg;
                    };
                    let negotiated = false;
                    const original = transport.pc.setRemoteDescription.bind(transport.pc);
                    transport.pc.setRemoteDescription = async (...args) => {
                        negotiated = true;
                        return original(...args);
                    };
                    try {
                        await transport._handleSdpOffer(message);
                        if (kind === 'honest') {
                            if (!negotiated || failures.length || !answer?.sig)
                                throw new Error(
                                    'Honest handshake failed: ' +
                                        Transport.name +
                                        ' ' +
                                        JSON.stringify({
                                            negotiated,
                                            failures,
                                            hasAnswer: !!answer,
                                        }),
                                );
                            const verified = await window.nativePairingFixture({
                                mode: 'answer',
                                browser_key: identity.publicKeyBase64,
                                host_id: offer.host_id,
                                host_nonce: offer.nonce,
                                host_sdp: offer.sdp,
                                sdp: answer.sdp,
                                sig: answer.sig,
                            });
                            if (!verified.valid) throw new Error('C++ refused real browser answer');
                            accepted++;
                        } else {
                            if (negotiated || failures[0] !== p.IDENTITY_REFUSED || answer)
                                throw new Error('Untrusted offer negotiated: ' + kind);
                            refused++;
                        }
                    } finally {
                        connection.close();
                    }
                }
            }
        } finally {
            host.close();
        }
        return { accepted, refused };
    });
    assert.deepEqual(negotiation, { accepted: 2, refused: 10 });
    console.log(
        'PASS: both WebRTC transports accept real C++ signatures and produce C++-verified answers; 10 hostile offers refused before negotiation.',
    );
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('PASS: simultaneous first-use tabs retain one browser key.');
} finally {
    await browser.close();
}
