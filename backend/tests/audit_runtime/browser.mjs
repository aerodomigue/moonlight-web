import assert from 'node:assert/strict';
const { chromium } = await import(process.env.MW_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch();
try {
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    await page.goto(process.argv[2] + '/js/util/pairingCrypto.js');
    const results = await page.evaluate(async () => {
        const { WebRtcMedia } = await import('/js/api/WebRtcMedia.js');
        const p = await import('/js/util/pairingCrypto.js');
        const host = new RTCPeerConnection({ iceServers: [] });
        host.createDataChannel('input', { negotiated: true, id: 2 });
        host.addTransceiver('audio', { direction: 'sendonly' });
        const video = host.addTransceiver('video', { direction: 'sendonly' });
        video.setCodecPreferences(RTCRtpSender.getCapabilities('video').codecs.filter(codec => codec.mimeType.toLowerCase() === 'video/vp8'));
        await host.setLocalDescription(await host.createOffer());
        const offer = host.localDescription.sdp;
        const control = new RTCPeerConnection({ iceServers: [] });
        await control.setRemoteDescription({ type: 'offer', sdp: offer });
        await control.setLocalDescription(await control.createAnswer());
        const rawAnswerWorks = !!control.localDescription;
        control.close();
        const errors = [];
        const transport = new WebRtcMedia('wss://test.invalid');
        const connection = transport.pc = new RTCPeerConnection({ iceServers: [] });
        transport.onError = error => errors.push(error.message);
        transport._startIceTimer = () => {};
        transport._sendSignaling = () => {};
        try { await transport._handleSdpOffer({ sdp: offer }); }
        finally { connection.close(); }
        const fec = { probe: 'media-red-sdp', rawAnswerWorks, offerHasAudioRed: /a=rtpmap:\d+ red\/48000/i.test(offer), applicationErrors: errors };

        const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
        const spki = new Uint8Array(await crypto.subtle.exportKey('spki', key.publicKey));
        const id = p.bytesToBase64(await crypto.subtle.digest('SHA-256', spki)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        await p.loadOrCreateIdentity();
        await p.rememberHostIdentity(p.bytesToBase64(spki), id);
        const local = new WebRtcMedia('wss://test.invalid');
        local._mwBind = await p.beginHandshake();
        const localConnection = local.pc = new RTCPeerConnection({ iceServers: [] });
        const localErrors = [];
        local.onError = error => localErrors.push(error.message);
        try { await local._handleSdpOffer({ sdp: offer }); }
        finally { localConnection.close(); host.close(); }
        return [fec, { probe: 'local-sessionless-cached-identity', errors: localErrors, cachedHostIdentity: !!local._mwBind?.hostPublicKey }];
    });
    assert.equal(results[0].rawAnswerWorks, true);
    assert.equal(results[0].offerHasAudioRed, true);
    assert.deepEqual(results[0].applicationErrors, []);
    assert.deepEqual(results[1].errors, ['identity_refused']);
    const localPage = await browser.newPage({ignoreHTTPSErrors:true});
    await localPage.goto(process.argv[2].replace('127.0.0.1','localhost') + '/js/util/pairingCrypto.js');
    const boot = await localPage.evaluate(async () => {
        const p = await import('/js/util/pairingCrypto.js');
        const identity = await p.loadOrCreateIdentity();
        const stale = await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'}, false, ['sign','verify']);
        const publicKey = new Uint8Array(await crypto.subtle.exportKey('spki',stale.publicKey));
        const oldId = p.bytesToBase64(await crypto.subtle.digest('SHA-256',publicKey)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
        await p.rememberHostIdentity(p.bytesToBase64(publicKey),oldId);
        const {BackendClient} = await import('/js/api/BackendClient.js');
        const status = await BackendClient.getAuthStatus();
        const renewed = await p.loadOrCreateIdentity();
        return {session:status.has_session, bound:status.browser_key_id===renewed.keyId,
            keyPreserved:identity.keyId===renewed.keyId, hostMatches:renewed.hostId===status.host_id,
            hostReplaced:oldId!==renewed.hostId, error:status.identity_error};
    });
    assert.deepEqual(boot,{session:true,bound:true,keyPreserved:true,hostMatches:true,hostReplaced:true,error:undefined});
    console.log('PASS: direct local bootstrap binds a session and renews the old host pin; unsigned offers remain refused.');
    for (const result of results) console.log(JSON.stringify(result));
} finally { await browser.close(); }
