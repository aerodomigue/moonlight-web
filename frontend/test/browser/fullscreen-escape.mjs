// Native Escape coverage: run under xvfb-run with MW_NATIVE_KEYBOARD=1,
// full Chromium and xdotool. The default uses Playwright key events.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { chromium } = await import(process.env.MW_PLAYWRIGHT_MODULE || 'playwright');
const nativeKeyboard = process.env.MW_NATIVE_KEYBOARD === '1';
let nativeProcess, profile;
let browser;
if (nativeKeyboard) {
    profile = mkdtempSync(join(tmpdir(), 'mw-keyboard-'));
    nativeProcess = spawn(
        chromium.executablePath(),
        [
            '--no-sandbox',
            '--no-first-run',
            '--remote-debugging-port=0',
            '--user-data-dir=' + profile,
            '--lang=fr-FR',
            'about:blank',
        ],
        { stdio: 'ignore' },
    );
    let port;
    for (let i = 0; i < 100; i++) {
        try {
            port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
            break;
        } catch (_) {}
        await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(port, 'native Chromium did not start');
    // noDefaults avoids Playwright's permanent focus emulation on its own CDP
    // session. Disabling it from a second CDP session does not cancel that one.
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { noDefaults: true });
} else browser = await chromium.launch();
try {
    const context = nativeKeyboard
        ? browser.contexts()[0]
        : await browser.newContext({
              ignoreHTTPSErrors: true,
              locale: 'fr-FR',
              extraHTTPHeaders: { 'X-Forwarded-For': '203.0.113.20', 'X-Forwarded-Proto': 'https' },
          });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const cdp = await browser.newBrowserCDPSession();
    const { browserContextIds } = await cdp.send('Target.getBrowserContexts');
    if (!nativeKeyboard) assert.equal(browserContextIds.length, 1);
    await cdp.send('Browser.grantPermissions', {
        origin: new URL(process.argv[2]).origin,
        ...(nativeKeyboard ? {} : { browserContextId: browserContextIds[0] }),
        permissions: ['keyboardLock', 'pointerLock'],
    });
    if (process.env.MW_STREAM_FIXTURE_ONLY === '1') {
        await page.route(new URL(process.argv[2]).origin + '/api/**', (route) =>
            route.fulfill({ json: {} }),
        );
        await page.route(process.argv[2], (route) =>
            route.fulfill({
                contentType: 'text/html',
                body: '<!doctype html><html lang="fr"><meta charset="utf-8"><link rel="stylesheet" href="/css/stream.css"><body><div id="app"></div></body></html>',
            }),
        );
    }
    await page.goto(process.argv[2], { waitUntil: 'networkidle' });
    if (process.env.MW_STREAM_FIXTURE_ONLY !== '1') {
        await page.locator('#btn-login-sso').click();
        await page.locator('#view-hosts').waitFor();
    }
    await page.evaluate(async () => {
        const { init } = await import('/js/i18n/i18n.js');
        await init();
        window.mountStreamFixture = async () => {
            const { exclusiveSettings } = await import('/js/stream/ExclusiveInput.js');
            const { StreamView } = await import('/js/ui/StreamView.js');
            const patched = ['setupWebRtc', 'startRenderLoop', 'initAudioAsync'];
            const originals = Object.fromEntries(patched.map((k) => [k, StreamView.prototype[k]]));
            StreamView.prototype.setupWebRtc = function () {
                this.webrtc = {
                    send(message) {
                        window.sent.push(message);
                    },
                    close() {},
                };
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
                    {
                        exclusiveInput: exclusiveSettings(
                            JSON.parse(localStorage.getItem('mw-streaming-settings')),
                        ),
                    },
                );
            } finally {
                Object.assign(StreamView.prototype, originals);
            }
            window.streamFixture._firstFrameRendered = true;
            window.streamFixture._hideStartupOverlay();
            window.streamFixture._updateGamingOverlay();
        };
    });
    for (const mode of ['both', 'keyboard']) {
        await page.evaluate((mode) => {
            window.sent = [];
            localStorage.setItem(
                'mw-streaming-settings',
                JSON.stringify({ exclusive_mode: mode, exclusive_enabled: false }),
            );
        }, mode);
        const preferences = await page.evaluate(() =>
            localStorage.getItem('mw-streaming-settings'),
        );
        await page.evaluate(() => window.mountStreamFixture());
        await page.keyboard.press('Control+Alt+Shift+X');
        await page.waitForFunction(() => !!document.fullscreenElement);
        await page.keyboard.press('Control+Alt+Shift+M');
        await page.waitForFunction(() => window.streamFixture._exclusive.keyboardLocked);
        await page.evaluate(() => (window.sent = []));
        if (nativeKeyboard) {
            await page.evaluate(() => {
                document.title = 'MW fullscreen Escape test';
            });
            // This mode runs inside its own Xvfb display. Keyboard Lock was
            // granted only while this browser had focus; target that window.
            const focusedWindow = execFileSync('xdotool', ['getwindowfocus']).toString().trim();
            assert.match(focusedWindow, /^\d+$/);
            execFileSync('xdotool', ['windowfocus', '--sync', focusedWindow]);
            execFileSync('xdotool', ['key', '--clearmodifiers', 'Escape']);
        } else {
            await page.keyboard.press('Escape');
        }
        // Let browser-level fullscreen/pointer-lock events settle as well.
        await page.evaluate(
            () =>
                new Promise((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(resolve)),
                ),
        );
        const state = await page.evaluate(() => ({
            fullscreen: !!document.fullscreenElement,
            enabled: window.streamFixture._exclusive.enabled,
            keyboard: window.streamFixture._exclusive.keyboardLocked,
            pointer: document.pointerLockElement === window.streamFixture.inputEl,
            keys: window.sent.filter((m) => m.keyCode === 0x1b).map((m) => m.type),
            held: window.streamFixture._heldPhysKeys.has('Escape'),
        }));
        assert.deepEqual(state, {
            fullscreen: true,
            enabled: true,
            keyboard: true,
            pointer: mode === 'both',
            keys: ['keydown', 'keyup'],
            held: false,
        });
        // Changing fullscreen must preserve runtime capture intent in both directions.
        for (const fullscreen of [false, true, false, true]) {
            await page.keyboard.press('Control+Alt+Shift+X');
            await page.waitForFunction(
                (expected) => !!document.fullscreenElement === expected,
                fullscreen,
            );
            await page.waitForFunction(
                ({ mode, fullscreen }) => {
                    const capture = window.streamFixture._exclusive;
                    return (
                        capture.enabled &&
                        capture.keyboardLocked === fullscreen &&
                        (document.pointerLockElement === window.streamFixture.inputEl) ===
                            (mode === 'both')
                    );
                },
                { mode, fullscreen },
            );
        }
        if (nativeKeyboard) {
            // A real second browser window changes OS focus without changing the
            // fullscreen intent in the stream window. Returning must protect Escape
            // even if pointer recapture is denied until a user gesture.
            const streamWindow = nativeKeyboard
                ? execFileSync('xdotool', ['getwindowfocus']).toString().trim()
                : null;
            const other = nativeKeyboard ? await context.newPage() : await browser.newPage();

            await other.goto('about:blank');
            await other.bringToFront();
            if (nativeKeyboard) {
                await other.evaluate(() => (document.title = 'MW other focus test'));
                await other.waitForTimeout(300);
                const id = execFileSync('xdotool', [
                    'search',
                    '--onlyvisible',
                    '--name',
                    'MW other focus test',
                ])
                    .toString()
                    .trim()
                    .split('\n')
                    .at(-1);
                execFileSync('xdotool', ['windowfocus', '--sync', id]);
            }
            await page.waitForFunction(() => window.streamFixture._exclusive.suspended, null, {
                polling: 50,
            });
            await page.bringToFront();
            if (nativeKeyboard) execFileSync('xdotool', ['windowfocus', '--sync', streamWindow]);
            await page.waitForFunction(() => document.hasFocus(), null, { polling: 50 });
            if (!(await page.evaluate(() => !!document.fullscreenElement))) {
                await page.keyboard.press('Control+Alt+Shift+X');
            }
            await page.waitForFunction(() => window.streamFixture._exclusive.keyboardLocked);
            if (nativeKeyboard) execFileSync('xdotool', ['key', '--clearmodifiers', 'Escape']);
            else await page.keyboard.press('Escape');
            await page.waitForTimeout(150);
            assert.equal(await page.evaluate(() => !!document.fullscreenElement), true);
            assert.equal(await page.evaluate(() => window.streamFixture._exclusive.enabled), true);
            await other.close();
            // Also leave the browser entirely while keeping its fullscreen document.
            const external = spawn('xmessage', ['-title', 'MW external focus', 'Focus test'], {
                stdio: 'ignore',
            });
            try {
                await page.waitForTimeout(300);
                const id = execFileSync('xdotool', [
                    'search',
                    '--onlyvisible',
                    '--name',
                    'MW external focus',
                ])
                    .toString()
                    .trim()
                    .split('\n')
                    .at(-1);
                execFileSync('xdotool', ['windowfocus', '--sync', id]);
                await page.waitForFunction(() => window.streamFixture._exclusive.suspended, null, {
                    polling: 50,
                });
                execFileSync('xdotool', ['windowfocus', '--sync', streamWindow]);
                await page.waitForFunction(
                    () => window.streamFixture._exclusive.keyboardLocked,
                    null,
                    { polling: 50 },
                );
                execFileSync('xdotool', ['key', '--clearmodifiers', 'Escape']);
                await page.waitForTimeout(150);
                assert.equal(await page.evaluate(() => !!document.fullscreenElement), true);
                assert.equal(
                    await page.evaluate(() => window.streamFixture._exclusive.enabled),
                    true,
                );
                console.log(
                    `PASS: native tab/window focus return preserves intent and short Escape (${mode}).`,
                );
            } finally {
                external.kill();
            }
        }
        await page.keyboard.press('Control+Alt+Shift+Z');
        await page.waitForFunction(
            () => !window.streamFixture._exclusive.enabled && !document.pointerLockElement,
        );
        assert.equal(await page.evaluate(() => !!document.fullscreenElement), true);
        await page.keyboard.press('Control+Alt+Shift+X');
        await page.waitForFunction(() => !document.fullscreenElement);
        if (nativeKeyboard) {
            // Exercise Chrome's native escape hatch, not a synthetic DOM event.
            await page.keyboard.press('Control+Alt+Shift+X');
            await page.waitForFunction(() => !!document.fullscreenElement);
            await page.keyboard.press('Control+Alt+Shift+M');
            await page.waitForFunction(() => window.streamFixture._exclusive.keyboardLocked);
            execFileSync('xdotool', ['keydown', 'Escape']);
            try {
                await page.waitForTimeout(2300);
            } finally {
                execFileSync('xdotool', ['keyup', 'Escape']);
            }
            await page.waitForFunction(
                () =>
                    !document.fullscreenElement && !window.streamFixture._exclusive.keyboardLocked,
            );
            console.log(
                `PASS: native short Escape retained capture; long Escape exited fullscreen (${mode}).`,
            );
        }
        assert.equal(
            await page.evaluate(() => localStorage.getItem('mw-streaming-settings')),
            preferences,
        );
        await page.evaluate(() => window.streamFixture.destroy());
    }
    for (const mode of ['mouse', 'keyboard', 'both']) {
        await page.evaluate((mode) => {
            window.sent = [];
            localStorage.setItem(
                'mw-streaming-settings',
                JSON.stringify({ exclusive_mode: mode, exclusive_enabled: false }),
            );
        }, mode);
        const preferences = await page.evaluate(() =>
            localStorage.getItem('mw-streaming-settings'),
        );
        await page.evaluate(() => window.mountStreamFixture());
        // Starting disabled must stay disabled through either transition.
        for (const fullscreen of [true, false]) {
            await page.keyboard.press('Control+Alt+Shift+X');
            await page.waitForFunction(
                (expected) => !!document.fullscreenElement === expected,
                fullscreen,
            );
            assert.equal(await page.evaluate(() => window.streamFixture._exclusive.enabled), false);
        }
        await page.keyboard.press('Control+Alt+Shift+M');
        for (const fullscreen of [true, false, true, false]) {
            await page.keyboard.press('Control+Alt+Shift+X');
            await page.waitForFunction(
                ({ mode, fullscreen }) => {
                    const capture = window.streamFixture._exclusive;
                    return (
                        !!document.fullscreenElement === fullscreen &&
                        capture.enabled &&
                        capture.keyboardLocked === (fullscreen && mode !== 'mouse') &&
                        (document.pointerLockElement === window.streamFixture.inputEl) ===
                            (mode !== 'keyboard')
                    );
                },
                { mode, fullscreen },
            );
        }
        await page.keyboard.press('Control+Alt+Shift+Z');
        assert.equal(
            await page.evaluate(() => localStorage.getItem('mw-streaming-settings')),
            preferences,
        );
        await page.evaluate(() => window.streamFixture.destroy());
        console.log(
            `PASS: fullscreen round trips preserve ${mode} capture, disabled intent and saved preferences.`,
        );
    }
    assert.deepEqual(errors, []);
    console.log(
        'PASS: Chromium with granted Keyboard Lock keeps fullscreen/capture on short Escape, forwards one Escape down/up, releases with Z, exits with X, and preserves settings (both and keyboard modes).',
    );
} finally {
    await browser.close();
    if (nativeProcess && nativeProcess.exitCode === null) {
        const exited = new Promise((r) => nativeProcess.once('exit', r));
        nativeProcess.kill();
        await exited;
    }
    if (profile) rmSync(profile, { recursive: true, force: true });
}
