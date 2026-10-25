import assert from 'node:assert/strict';
const { chromium } = await import(process.env.MW_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch();
const errors = [];
try {
    const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        locale: 'fr-FR',
        permissions: ['clipboard-read', 'clipboard-write'],
        extraHTTPHeaders: { 'X-Forwarded-For': '203.0.113.20', 'X-Forwarded-Proto': 'https' },
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(process.argv[2], { waitUntil: 'networkidle' });
    await page.locator('#btn-login-sso').click();
    await page.locator('#view-hosts').waitFor();
    const status = await page.evaluate(async () =>
        (await import('/js/api/BackendClient.js')).BackendClient.getAuthStatus(),
    );
    assert.equal(status.auth_method, 'sso');
    assert.equal(status.can_manage_shares, false);
    await page.locator('#btn-settings').click();
    assert.match(
        await page.locator('label:has(#settings-gaming-mode)').innerText(),
        /Mode exclusif/,
    );
    for (const mode of ['mouse', 'keyboard', 'both']) {
        await page.locator('#settings-exclusive-mode').selectOption(mode);
        await page.waitForFunction(
            (value) =>
                JSON.parse(localStorage.getItem('mw-streaming-settings')).exclusive_mode === value,
            mode,
        );
    }
    await page.locator('#btn-settings-close').click();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#view-hosts').waitFor();
    await page.locator('#btn-settings').click();
    assert.equal(await page.locator('#settings-exclusive-mode').inputValue(), 'both');
    await page.locator('#btn-settings-close').click();
    // Test actual browser Pointer Lock and clipboard APIs on a local surface.
    await page.evaluate(async () => {
        const { ExclusiveInput } = await import('/js/stream/ExclusiveInput.js');
        const element = document.createElement('button');
        element.id = 'capture-fixture';
        element.textContent = 'Capture fixture';
        document.body.append(element);
        window.captureFixture = new ExclusiveInput({
            element,
            mode: 'mouse',
            enabled: false,
            releaseInputs() {},
            change() {},
        });
        element.onclick = () => window.captureFixture.toggle();
    });
    await page.locator('#capture-fixture').click();
    await page.waitForFunction(() => document.pointerLockElement?.id === 'capture-fixture');
    await page.evaluate(() => window.captureFixture.toggle());
    await page.waitForFunction(() => !document.pointerLockElement);
    assert.equal(await page.evaluate(() => window.captureFixture.enabled), false);
    await page.evaluate(() => {
        window.captureFixture.destroy();
        document.querySelector('#capture-fixture').remove();
    });
    // Mount the real stream UI with a silent transport fixture. No PC launch.
    await page.evaluate(async () => {
        const { StreamView } = await import('/js/ui/StreamView.js');
        const patched = ['setupWebRtc', 'startRenderLoop', 'initAudioAsync'];
        const originals = Object.fromEntries(patched.map((k) => [k, StreamView.prototype[k]]));
        StreamView.prototype.setupWebRtc = function () {
            this.webrtc = { send() {}, close() {} };
        };
        StreamView.prototype.startRenderLoop = function () {};
        StreamView.prototype.initAudioAsync = async function () {};
        const container = document.createElement('div');
        document.body.append(container);
        try {
            window.streamFixture = new StreamView(
                container,
                'wss://fixture.invalid',
                { name: 'Apollo fixture', uuid: 'fixture' },
                'h264',
                false,
                false,
                false,
                'webrtc',
                undefined,
                false,
                false,
                2,
                false,
                'auto',
                'off',
                'auto',
                false,
                false,
                false,
                true,
                { exclusiveInput: { mode: 'mouse', enabled: false } },
            );
        } finally {
            Object.assign(StreamView.prototype, originals);
        }
    });
    await page.locator('.exclusive-controls select').selectOption('keyboard');
    await page.locator('.exclusive-controls select').selectOption('both');
    await page.locator('.exclusive-controls select').selectOption('mouse');
    await page.locator('.exclusive-controls button').click();
    await page.waitForFunction(() => document.pointerLockElement === window.streamFixture.inputEl);
    await page.keyboard.press('Control+Alt+Shift+M');
    await page.waitForFunction(
        () => !document.pointerLockElement && !window.streamFixture._exclusive.enabled,
    );
    await page.keyboard.press('Control+Alt+Shift+M');
    await page.waitForFunction(() => document.pointerLockElement === window.streamFixture.inputEl);
    await page.evaluate(() => window.streamFixture.destroy());
    await page.waitForFunction(() => !document.pointerLockElement);
    const copied = await page.evaluate(async () => {
        const { ApolloClipboard } = await import('/js/stream/ApolloClipboard.js');
        const messages = [];
        const bridge = new ApolloClipboard({
            send: (m) => messages.push(m),
            pending() {},
            error: (e) => {
                throw Error(e);
            },
            foreground: () => true,
        });
        bridge.handle({ type: 'clipboardcaps', read: true, write: true });
        messages.length = 0;
        await bridge.paste('Bonjour 🌙\nCopier-coller Apollo');
        for (const message of messages) bridge.handle(message);
        await bridge.copyPending();
        const text = await navigator.clipboard.readText();
        bridge.destroy();
        return text;
    });
    assert.equal(copied, 'Bonjour 🌙\nCopier-coller Apollo');
    // A synthetic decoded video keeps the same main-thread/media workload in
    // both arms. This does not measure the user's GPU or Apollo network stream.
    const performance = await page.evaluate(async () => {
        const { BackendClient } = await import('/js/api/BackendClient.js');
        const { ShareMenu } = await import('/js/ui/ShareMenu.js');
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 360;
        const ctx = canvas.getContext('2d');
        const video = document.createElement('video');
        video.muted = true;
        video.srcObject = canvas.captureStream(60);
        document.body.append(video);
        let alive = true,
            frame = 0;
        const paint = () => {
            if (!alive) return;
            ctx.fillStyle = `hsl(${frame++ % 360} 80% 50%)`;
            ctx.fillRect(0, 0, 640, 360);
            requestAnimationFrame(paint);
        };
        paint();
        await video.play();
        const measure = async (legacy) => {
            let requests = 0,
                last = 0;
            const deltas = [],
                longTasks = [];
            const original = BackendClient.getShareStatus;
            BackendClient.getShareStatus = function (...args) {
                requests++;
                return original.apply(this, args);
            };
            const observer = new PerformanceObserver((items) =>
                longTasks.push(...items.getEntries().map((x) => x.duration)),
            );
            observer.observe({ type: 'longtask' });
            let running = true;
            const presented = (now) => {
                if (last) deltas.push(now - last);
                last = now;
                if (running) video.requestVideoFrameCallback(presented);
            };
            video.requestVideoFrameCallback(presented);
            let timer, menu;
            if (legacy) {
                const poll = () => {
                    BackendClient.getShareStatus().catch(() => {});
                };
                poll();
                timer = setInterval(poll, 5000);
            } else {
                const header = document.createElement('header'),
                    stop = document.createElement('button');
                header.append(stop);
                menu = new ShareMenu(header, stop);
                await menu.mount();
            }
            await new Promise((r) => setTimeout(r, 15500));
            running = false;
            clearInterval(timer);
            menu?.destroy();
            observer.disconnect();
            BackendClient.getShareStatus = original;
            deltas.sort((a, b) => a - b);
            return {
                requests,
                frames: deltas.length,
                p95ms: deltas[Math.floor(deltas.length * 0.95)] || 0,
                maxMs: Math.max(0, ...deltas),
                longTasks: longTasks.length,
            };
        };
        const before = await measure(true),
            after = await measure(false);
        alive = false;
        video.srcObject.getTracks().forEach((t) => t.stop());
        video.remove();
        return {
            before,
            after,
            fixture:
                'Chromium headless, synthetic 640x360/60 video; not a hardware micro-freeze diagnosis',
        };
    });
    assert.equal(performance.after.requests, 0);
    assert.ok(performance.before.requests >= 3);
    assert.deepEqual(errors, []);
    console.log(
        'PASS: French settings persist all exclusive modes across SSO revalidation; real Chromium pointer capture/release and Unicode clipboard succeed.',
    );
    console.log(JSON.stringify(performance));
} finally {
    await browser.close();
}
