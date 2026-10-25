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
    const errors = [],
        nativeDialogs = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', async (dialog) => {
        nativeDialogs.push(dialog.type());
        await dialog.dismiss();
    });
    await page.goto(process.argv[2], { waitUntil: 'networkidle' });
    await page.locator('#btn-login-sso').click();
    await page.locator('#view-hosts').waitFor();
    // Real host/app cards, but no calls to an actual Apollo PC.
    await page.evaluate(async () => {
        const { HostListView } = await import('/js/ui/HostListView.js');
        const { Host } = await import('/js/models/Host.js');
        const { BackendClient } = await import('/js/api/BackendClient.js');
        const apps = [
            { id: 1, name: 'Desktop' },
            { id: 2, name: 'Cyberpunk 2077' },
        ];
        localStorage.setItem(
            'mw-host-apps',
            JSON.stringify({ 'dialog-fixture': { ts: Date.now(), apps } }),
        );
        BackendClient.getAppList = () => new Promise(() => {});
        window.stops = [];
        BackendClient.stopHostSession = async (uuid) => {
            window.stops.push(uuid);
            return { currentGameId: 0 };
        };
        const container = document.createElement('div');
        container.id = 'quit-dialog-fixture';
        container.style.cssText =
            'position:fixed;inset:70px 0 0;z-index:100;background:var(--surface-1);padding:24px;overflow:auto';
        document.body.append(container);
        const view = new HostListView(container);
        window.dialogView = view;
        view.refresh = async () => {};
        view.hosts = [
            new Host({
                uuid: 'dialog-fixture',
                name: 'PC Apollo',
                state: 'online',
                pairState: 'paired',
                resumableApps: true,
                currentGameId: 2,
            }),
        ];
        view.renderList();
    });
    const quit = page.locator('#quit-dialog-fixture .app-card-quit');
    await quit.click();
    const dialog = page.getByRole('alertdialog', { name: 'Quitter l’application ?' });
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /Cyberpunk 2077/);
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Annuler');
    assert.deepEqual(await page.evaluate(() => window.stops), []);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Quitter');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Annuler');
    if (process.env.MW_UI_SCREENSHOT) await page.screenshot({ path: process.env.MW_UI_SCREENSHOT });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.deepEqual(await page.evaluate(() => window.stops), []);
    await quit.click();
    await dialog.getByRole('button', { name: 'Annuler', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.stops), []);
    await quit.click();
    await dialog.getByRole('button', { name: 'Quitter', exact: true }).click();
    await page.waitForFunction(() => window.stops.length === 1);
    assert.deepEqual(await page.evaluate(() => window.stops), ['dialog-fixture']);
    await quit.waitFor({ state: 'detached' });
    await page.evaluate(() => {
        window.dialogView.hosts[0].currentGameId = 2;
        window.dialogView.renderList();
    });
    const menu = page.locator('#quit-dialog-fixture .btn-host-menu');
    await menu.click();
    await page.locator('#quit-dialog-fixture .btn-stop-session').click();
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Annuler', exact: true }).click();
    assert.equal(await menu.evaluate((el) => document.activeElement === el), true);
    assert.deepEqual(await page.evaluate(() => window.stops), ['dialog-fixture']);
    assert.deepEqual(nativeDialogs, []);
    assert.deepEqual(errors, []);
    await page.evaluate(() => {
        window.dialogView.destroy();
        document.querySelector('#quit-dialog-fixture').remove();
    });
    console.log(
        'PASS: French in-app quit confirmation, initial Cancel focus, Tab containment, Escape/cancel, and exactly one stop after explicit approval; no browser dialog.',
    );
} finally {
    await browser.close();
}
