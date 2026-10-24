import assert from 'node:assert/strict';
const { chromium } = await import(process.env.MW_PLAYWRIGHT_MODULE || 'playwright');
const base = process.argv[2];
const browser = await chromium.launch();
const options = {
    ignoreHTTPSErrors: true,
    locale: 'fr-FR',
    extraHTTPHeaders: { 'X-Forwarded-For': '203.0.113.20', 'X-Forwarded-Proto': 'https' },
};
const errors = [];
async function sso(subject) {
    const context = await browser.newContext(options);
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/authorize?**', (route) => {
        const url = new URL(route.request().url());
        url.searchParams.set('fixture_subject', subject);
        return route.continue({ url: url.href });
    });
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.locator('#btn-login-sso').click();
    await page.locator('#view-hosts').waitFor();
    return { context, page };
}
try {
    const { page: admin } = await sso('admin-subject');
    assert.equal(await admin.locator('#btn-admin').isVisible(), true);
    await admin.locator('#btn-admin').click();
    await admin.locator('#admin-oidc-scopes').waitFor();
    assert.equal(await admin.locator('#admin-oidc-scopes').inputValue(), 'openid profile email moonlight_role');
    assert.match(await admin.locator('#admin-section-login h3').innerText(), /connexion/i);
    const adminId = await admin.evaluate(async () => (await (await fetch('/api/auth/status')).json()).user.id);
    await admin.locator('#admin-user-select').selectOption(adminId);
    await admin.locator('[data-role-source]').waitFor();
    assert.match(await admin.locator('[data-role-source]').innerText(), /Source : Authentik/);
    assert.equal(await admin.locator('#admin-edit-user [name="role"]').isDisabled(), true);
    await admin.screenshot({ path: process.env.MW_ROLES_SCREENSHOT || 'work/roles-admin-fr.png', fullPage: true });
    const pin = await admin.evaluate(async () => {
        const { BackendClient: api } = await import('/js/api/BackendClient.js');
        await api.post('/api/admin/password', { password: 'fixture-admin-password', enabled: true, internet: true });
        return (await api.generateAccountPin()).pin;
    });
    console.log('PASS: SSO administrator opens the French console without a password; scopes and read-only Authentik role are displayed.');

    const pinContext = await browser.newContext(options);
    const pinPage = await pinContext.newPage();
    pinPage.on('pageerror', (e) => errors.push(e.message));
    await pinPage.goto(base, { waitUntil: 'networkidle' });
    await pinPage.locator('#btn-login-pin').click();
    await pinPage.locator('#login-pin-input').fill(pin);
    await pinPage.locator('#btn-login-unlock').click();
    await pinPage.locator('#view-hosts').waitFor();
    const status = await pinPage.evaluate(async () => (await (await fetch('/api/auth/status')).json()));
    assert.equal(status.auth_method, 'pin');
    assert.equal(status.admin_access, false);
    assert.equal(status.admin_unlock_available, true);
    await pinPage.locator('#btn-admin').click();
    await pinPage.locator('#admin-unlock-input').waitFor();
    assert.equal(await pinPage.locator('#admin-oidc-scopes').count(), 0);
    await pinPage.locator('#admin-unlock-input').fill('fixture-admin-password');
    await pinPage.locator('#btn-admin-unlock').click();
    await pinPage.waitForLoadState('networkidle');
    await pinPage.locator('#admin-oidc-scopes').waitFor();
    console.log('PASS: the same account through PIN requires the administrator password before showing settings.');

    const { page: user } = await sso('ordinary-subject');
    assert.equal(await user.locator('#btn-admin').isVisible(), false);
    await user.goto(`${base}/admin`, { waitUntil: 'networkidle' });
    assert.equal(await user.locator('#admin-oidc-scopes').count(), 0);
    assert.equal(await user.locator('#btn-admin').isVisible(), false);
    const denied = await user.evaluate(async () => {
        const config = await fetch('/api/admin/auth-config');
        const unlock = await fetch('/api/auth/admin-unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'fixture-admin-password' }) });
        return [config.status, unlock.status];
    });
    assert.deepEqual(denied, [403, 403]);
    assert.deepEqual(errors, []);
    console.log('PASS: ordinary SSO user has no Admin button; direct console navigation, API and password unlock are refused. No JavaScript errors.');
} finally {
    await browser.close();
}
