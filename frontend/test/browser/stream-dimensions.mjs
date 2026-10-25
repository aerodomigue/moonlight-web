import assert from 'node:assert/strict';
const { chromium } = await import(process.env.MW_PLAYWRIGHT_MODULE || 'playwright');
const pins = JSON.parse(process.env.MW_FIXTURE_PINS);
const browser = await chromium.launch();
const cases = [
    {
        name: 'Auto budget',
        width: 3840,
        height: 2160,
        mode: 'auto',
        fps: 0,
        requestedHeight: 1080,
        requestedAspect: '1920:1080',
        requestedFps: 120,
    },
    {
        name: 'decoder limit on an ultrawide screen',
        width: 5120,
        height: 2160,
        mode: 'auto',
        fps: 240,
        limit: true,
        requestedHeight: 1080,
        requestedAspect: '1920:1080',
        requestedFps: 240,
    },
    {
        name: 'match my screen',
        width: 3840,
        height: 2160,
        mode: 'device',
        fps: 120,
        requestedHeight: 2160,
        requestedAspect: '3840:2160',
        requestedFps: 120,
    },
    {
        name: 'Auto size with fixed FPS',
        width: 3840,
        height: 2160,
        mode: 'auto',
        fps: 240,
        requestedHeight: 2160,
        requestedAspect: '3840:2160',
        requestedFps: 240,
    },
];
try {
    for (const [index, sample] of cases.entries()) {
        const context = await browser.newContext({
            ignoreHTTPSErrors: true,
            locale: 'fr-FR',
            viewport: { width: 1920, height: 1080 },
            screen: { width: sample.width, height: sample.height },
            deviceScaleFactor: 1,
            extraHTTPHeaders: { 'X-Forwarded-For': '203.0.113.20', 'X-Forwarded-Proto': 'https' },
        });
        if (sample.limit) {
            // Capability fixture only: no video is decoded. Model a decoder
            // accepting 1080p but rejecting 1440p/4K, independent of runner GPU.
            await context.addInitScript(() => {
                VideoDecoder.isConfigSupported = async (config) => ({
                    config,
                    supported: !(config.codedWidth > 1920 || config.codedHeight > 1080),
                });
            });
        }
        const page = await context.newPage();
        const errors = [],
            logs = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('console', (message) => {
            if (message.text().startsWith('[MW] Resolution ')) logs.push(message.text());
        });
        await page.goto(process.argv[2], { waitUntil: 'networkidle' });
        await page.locator('#btn-login-pin').click();
        await page.locator('#login-pin-input').fill(pins[index]);
        await page.locator('#btn-login-unlock').click();
        await page.locator('#view-hosts').waitFor();
        await page.locator('#btn-settings').click();
        await page.locator('#settings-video-codec').selectOption('h264');
        await page.locator('#settings-stream-height').selectOption(sample.mode);
        await page.locator('#settings-stream-fps').selectOption(String(sample.fps));
        await page.locator('#settings-stream-bitrate').evaluate((input) => {
            input.value = '100';
            input.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await page.waitForFunction((fps) => {
            const s = JSON.parse(localStorage.getItem('mw-streaming-settings') || '{}');
            return s.stream_fps === fps && s.stream_bitrate === 100000;
        }, sample.fps);
        await page.reload({ waitUntil: 'networkidle' });
        await page.locator('#view-hosts').waitFor();
        await page.locator('#btn-settings').click();
        assert.equal(await page.locator('#settings-stream-height').inputValue(), sample.mode);
        assert.equal(await page.locator('#settings-stream-fps').inputValue(), String(sample.fps));
        assert.equal(await page.locator('#settings-stream-bitrate').inputValue(), '100');
        await page.locator('#btn-settings-close').click();
        if (!sample.fps) {
            await page.evaluate(async () => {
                const rate = await import('/js/util/RefreshRate.js');
                await rate.measureRefreshRate();
                const original = requestAnimationFrame;
                let stamp = 0;
                window.requestAnimationFrame = (cb) =>
                    queueMicrotask(() => cb((stamp += 1000 / 240)));
                try {
                    await rate.measureRefreshRate({ frames: 30 });
                } finally {
                    window.requestAnimationFrame = original;
                }
            });
        }
        let resolveRequest;
        const captured = new Promise((resolve) => {
            resolveRequest = resolve;
        });
        // This endpoint is intercepted before it reaches the backend: no real
        // PC, launch, cancellation, video capture or host power change occurs.
        await page.route('**/api/hosts/preferences-test/start', async (route) => {
            resolveRequest(route.request().postDataJSON());
            await route.fulfill({
                status: 502,
                contentType: 'application/json',
                body: JSON.stringify({ error: 'fixture_stops_before_host' }),
            });
        });
        await page.evaluate(async () => {
            // Use the exact versioned module that initialized this document.
            const url = performance
                .getEntriesByType('resource')
                .map((r) => r.name)
                .find((name) => new URL(name).pathname === '/js/app.js');
            const { MoonlightApp: app } = await import(url);
            if (!app.hostListView) throw new Error('Application is not initialized');
            await app.launchApp(
                {
                    uuid: 'preferences-test',
                    displayName: 'Fixture PC',
                    backendType: 'gamestream',
                    isLocalHost: false,
                    resumableApps: false,
                },
                { id: 42, name: 'Desktop' },
            );
        });
        const sent = await Promise.race([
            captured,
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('No launch request')), 30000).unref(),
            ),
        ]);
        assert.equal(sent.stream_height, sample.requestedHeight);
        assert.equal(sent.stream_aspect, sample.requestedAspect);
        assert.equal(sent.stream_fps, sample.requestedFps);
        assert.equal(sent.stream_bitrate, 100000);
        assert.equal(sent.stream_bitrate_auto, false);
        assert.equal(sent.stream_match_display, sample.mode === 'device');
        assert.ok(
            logs.some((log) =>
                log.includes(`${sample.requestedHeight} @ ${sample.requestedAspect}`),
            ),
            logs.join('\n'),
        );
        assert.deepEqual(errors, []);
        console.log(
            `PASS: ${sample.name}: saved settings, effective request dimensions and resolution log agree.`,
        );
        await context.close();
    }
} finally {
    await browser.close();
}
