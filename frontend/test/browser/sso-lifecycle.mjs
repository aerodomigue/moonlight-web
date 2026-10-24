import assert from 'node:assert/strict';
import https from 'node:https';
import { readFileSync } from 'node:fs';
const { chromium } = await import(process.env.MW_PLAYWRIGHT_MODULE || 'playwright');
const base = process.argv[2];
const browser = await chromium.launch();
const options = { ignoreHTTPSErrors: true, locale: 'fr-FR', extraHTTPHeaders: { 'X-Forwarded-For': '203.0.113.20', 'X-Forwarded-Proto': 'https' } };
const errors = [];
const control = (data) => new Promise((resolve, reject) => {
    const request = https.request(process.env.MW_FIXTURE_ISSUER + '/fixture-control', {
        method: 'POST', ca: readFileSync(process.env.MW_FIXTURE_CA),
        headers: { 'Content-Type': 'application/json', 'X-Fixture-Control': process.env.MW_FIXTURE_CONTROL },
    }, response => { let body = ''; response.on('data', chunk => body += chunk); response.on('end', () => response.statusCode === 200 ? resolve(JSON.parse(body)) : reject(new Error('Fixture control failed'))); });
    request.on('error', reject); request.end(JSON.stringify(data));
});
async function login(subject) {
    const context = await browser.newContext(options); const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    let checks = 0;
    await page.route('**/authorize?**', route => { const url = new URL(route.request().url()); url.searchParams.set('fixture_subject', subject); if (url.searchParams.get('prompt') === 'none') checks++; return route.continue({url:url.href}); });
    await page.goto(base); await page.locator('#btn-login-sso').click(); await page.locator('#view-hosts').waitFor();
    return {context,page, checks:()=>checks};
}
try {
    const {context,page,checks} = await login('admin-subject');
    const cookie = (await context.cookies()).find(c=>c.name==='__Host-mw_session');
    const before = await page.evaluate(async()=>{const {SsoSession:s}=await import('/js/api/SsoSession.js');return {page:s.pageId,session:s.sessionId};});
    await page.reload({waitUntil:'domcontentloaded'}); await page.locator('#view-hosts').waitFor();
    assert.equal(checks(),1);
    const after = await page.evaluate(async()=>{const {SsoSession:s}=await import('/js/api/SsoSession.js');return {page:s.pageId,session:s.sessionId,active:s.active};});
    assert.notEqual(after.page,before.page); assert.equal(after.session,before.session); assert.equal(after.active,true);
    assert.equal((await context.cookies()).find(c=>c.name==='__Host-mw_session').value,cookie.value);
    assert.equal((await context.cookies()).find(c=>c.name==='__Host-mw_session').expires,-1);
    console.log('PASS: each reload performs prompt=none, validates a new document and preserves the active session; SSO cookie has no 90-day expiry.');
    await page.goto(base + '/locales/en.json');
    await page.goBack({waitUntil:'domcontentloaded'});
    await page.locator('#view-hosts').waitFor();
    assert.equal(checks(),2);
    console.log('PASS: returning through browser history rechecks SSO.');
    await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
    await page.waitForURL(url=>!url.hash && checks()===3).catch(()=>{});
    await page.locator('#view-hosts').waitFor();
    assert.equal(checks(),3);
    console.log('PASS: a persisted pageshow event forces a fresh OIDC check before restoring data.');
    const copied = await browser.newContext(options); await copied.addCookies([cookie]);
    const intruder = await copied.newPage(); await intruder.goto(base+'/js/api/SsoSession.js');
    const denied = await intruder.evaluate(async()=>{
        const status=await(await fetch('/api/auth/status')).json();
        const paths=['/api/hosts','/api/admin/users','/api/admin/token','/api/admin/certificate/download'];
        const codes=[]; for(const path of paths)codes.push((await fetch(path)).status);
        return {authenticated:status.authenticated,privateData:!!status.user,codes};
    });
    assert.deepEqual(denied,{authenticated:false,privateData:false,codes:[401,401,401,401]});
    console.log('PASS: copying the live SSO cookie into another Chromium context grants neither user data nor administrator access.');
    const other=await login('other-subject');
    const recoveryPin = await other.page.evaluate(async()=>(await import('/js/api/BackendClient.js')).BackendClient.generateAccountPin().then(r=>r.pin));
    await page.evaluate(async()=>{const {SsoSession:s}=await import('/js/api/SsoSession.js');const url=location.origin.replace('https:','wss:')+'/ws/control';window.testSocket=new WebSocket(url,await s.protocols(url));await new Promise((resolve,reject)=>{testSocket.onopen=resolve;testSocket.onerror=reject;});window.socketClosed=false;testSocket.onclose=()=>window.socketClosed=true;});
    assert.equal((await control({action:'logout'})).status,200);
    await page.waitForFunction(()=>window.socketClosed);
    const revoked = await page.evaluate(async()=>{const {authenticatedFetch:f}=await import('/js/api/SsoSession.js');return(await f('/api/hosts')).status;});
    assert.equal(revoked,401);
    assert.equal(await other.page.evaluate(async()=>(await(await import('/js/api/BackendClient.js')).BackendClient.getAuthStatus()).authenticated),true);
    console.log('PASS: signed back-channel logout closes the administrator control socket and blocks API access without revoking another account.');
    await control({action:'authenticated',value:false});
    const n=other.checks();
    await other.page.reload({waitUntil:'domcontentloaded'}); await other.page.locator('#btn-login-sso').waitFor();
    assert.equal(other.checks(),n+1); assert.equal(await other.page.locator('#btn-admin').isVisible(),false);
    await other.page.waitForTimeout(600); assert.equal(other.checks(),n+1);
    assert.equal(await other.page.evaluate(async()=>{const {authenticatedFetch:f}=await import('/js/api/SsoSession.js');return(await f('/api/hosts')).status;}),401);
    console.log('PASS: absent Authentik session blocks the page and API without a redirect loop or automatic PIN fallback.');
    await control({action:'authenticated',value:true});
    await control({action:'provider_available',value:false});
    await other.page.reload({waitUntil:'domcontentloaded'});
    await other.page.locator('#btn-login-sso').waitFor();
    assert.equal(await other.page.evaluate(async()=>{const {authenticatedFetch:f}=await import('/js/api/SsoSession.js');return(await f('/api/hosts')).status;}),401);
    console.log('PASS: provider discovery outage blocks access and leaves an explicit retry/login screen.');
    await other.page.locator('#btn-login-pin').click();
    await other.page.locator('#login-pin-input').fill(recoveryPin);
    await other.page.locator('#btn-login-unlock').click();
    await other.page.locator('#view-hosts').waitFor();
    assert.deepEqual(await other.page.evaluate(async()=>{const {SsoSession:s}=await import('/js/api/SsoSession.js');const status=await(await import('/js/api/BackendClient.js')).BackendClient.getAuthStatus();return{session:s.sessionId,method:status.auth_method,protocols:await s.protocols('/ws/control')};}),{session:'',method:'pin',protocols:undefined});
    console.log('PASS: explicitly choosing a valid PIN after SSO failure clears the old SSO request/socket context.');
    assert.deepEqual(errors,[]);
} finally { await control({action:'authenticated',value:true}).catch(()=>{});await control({action:'provider_available',value:true}).catch(()=>{});await browser.close(); }
