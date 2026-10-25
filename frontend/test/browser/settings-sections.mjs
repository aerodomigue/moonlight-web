import assert from 'node:assert/strict';
const { chromium } = await import(process.env.MW_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch();
try {
    const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        locale: 'fr-FR',
        extraHTTPHeaders: { 'X-Forwarded-For': '203.0.113.20', 'X-Forwarded-Proto': 'https' },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(process.argv[2], { waitUntil: 'networkidle' });
    await page.locator('#btn-login-sso').click();
    await page.locator('#view-hosts').waitFor();
    for (let visit = 0; visit < 2; visit++) {
        await page.locator('#btn-settings').click();
        await page.locator('#settings-exclusive-mode').waitFor();
        assert.equal(
            await page
                .locator(
                    '#settings-section-privacy, #settings-section-update, #settings-section-support',
                )
                .count(),
            0,
        );
        assert.equal(await page.locator('#settings-exclusive-mode option').count(), 3);
        assert.equal(await page.locator('#settings-gaming-mode').count(), 1);
        assert.equal(await page.locator('#settings-video-codec').count(), 1);
        assert.equal(await page.locator('#btn-settings-reset').count(), 1);
        await page.locator('#btn-settings-reset').scrollIntoViewIfNeeded();
        if (process.env.MW_UI_SCREENSHOT)
            await page.screenshot({ path: process.env.MW_UI_SCREENSHOT });
        await page.locator('#btn-settings-close').click();
        await page.locator('#view-hosts').waitFor();
    }
    assert.deepEqual(errors, []);
    console.log(
        'PASS: French Chromium settings open/reopen without privacy, update or donation sections; stream controls, capture and reset remain available.',
    );
} finally {
    await browser.close();
}
