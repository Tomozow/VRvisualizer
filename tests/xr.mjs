// Emulated WebXR session test using IWER (Immersive Web Emulation Runtime, Quest 2 profile).
// Usage: node tests/xr.mjs [--url http://localhost:4173/]
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const urlArg = args.indexOf('--url');
const base = urlArg >= 0 ? args[urlArg + 1] : 'http://localhost:4173/';
const outDir = resolve('tests/out');
mkdirSync(outDir, { recursive: true });

const iwerSrc = readFileSync(resolve('node_modules/iwer/build/iwer.min.js'), 'utf8');

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));

await page.addInitScript(iwerSrc + `
  ;(() => {
    const device = new IWER.XRDevice(IWER.metaQuest2);
    device.installRuntime();
    device.position.set(0, 1.6, 0);
    window.__xr = device;
  })();
`);

await page.goto(base + '?demo=1&quality=low&nowelcome=1', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.app, null, { timeout: 20000 });
await page.mouse.click(800, 450);
await page.waitForTimeout(800);

const supported = await page.evaluate(() => window.app.store.state.xrSupported);
console.log('xrSupported:', supported);
await page.evaluate(() => window.app.enterVR());
await page.waitForFunction(() => window.app.renderer.xr.isPresenting, null, { timeout: 15000 });
await page.waitForTimeout(2000);
console.log('presenting, mode =', await page.evaluate(() => window.app.store.state.mode));
await page.screenshot({ path: `${outDir}/xr-01-session.png` });

// Aim the right controller at the panel centre and hover
await page.evaluate(() => {
  const d = window.__xr;
  const c = d.controllers.right;
  c.connected = true;
  const from = { x: 0.25, y: 1.15, z: -0.2 };
  const to = { x: 0, y: 1.3, z: -1.4 };
  c.position.set(from.x, from.y, from.z);
  const q = IWER.lookRotation(IWER.directionTo(from, to));
  c.quaternion.set(q.x, q.y, q.z, q.w);
  const l = d.controllers.left;
  l.connected = true;
  l.position.set(-0.25, 1.1, -0.2);
});
await page.waitForTimeout(800);
await page.screenshot({ path: `${outDir}/xr-02-hover.png` });

// Trigger click on the panel (should not throw); then thumbstick → next preset; A → play/pause; B → menu
const before = await page.evaluate(() => ({ preset: window.app.store.state.preset, playing: window.app.store.state.playback.playing, menu: window.app.store.state.menuVisible }));
await page.evaluate(() => { window.__xr.controllers.right.updateButtonValue('trigger', 1); });
await page.waitForTimeout(150);
await page.evaluate(() => { window.__xr.controllers.right.updateButtonValue('trigger', 0); });
await page.waitForTimeout(300);
await page.evaluate(() => { window.__xr.controllers.right.updateAxes('thumbstick', 1, 0); });
await page.waitForTimeout(250);
await page.evaluate(() => { window.__xr.controllers.right.updateAxes('thumbstick', 0, 0); });
await page.waitForTimeout(300);
await page.evaluate(() => { window.__xr.controllers.right.updateButtonValue('a-button', 1); });
await page.waitForTimeout(150);
await page.evaluate(() => { window.__xr.controllers.right.updateButtonValue('a-button', 0); });
await page.waitForTimeout(300);
const after = await page.evaluate(() => ({ preset: window.app.store.state.preset, playing: window.app.store.state.playback.playing, menu: window.app.store.state.menuVisible }));
console.log('before', before, 'after', after);
await page.screenshot({ path: `${outDir}/xr-03-after-input.png` });

await page.evaluate(() => { window.__xr.controllers.right.updateButtonValue('b-button', 1); });
await page.waitForTimeout(150);
await page.evaluate(() => { window.__xr.controllers.right.updateButtonValue('b-button', 0); });
await page.waitForTimeout(500);
const menuAfterB = await page.evaluate(() => window.app.store.state.menuVisible);
console.log('menu after B:', menuAfterB);
await page.screenshot({ path: `${outDir}/xr-04-menu-toggled.png` });

// Session end → 2d
await page.evaluate(() => window.app.enterVR());
await page.waitForFunction(() => !window.app.renderer.xr.isPresenting, null, { timeout: 10000 });
await page.waitForTimeout(500);
console.log('after exit, mode =', await page.evaluate(() => window.app.store.state.mode));

const unique = [...new Set(errors)];
console.log(`\nconsole errors/warnings (${unique.length}):`);
for (const e of unique.slice(0, 40)) console.log('  ' + e);
await browser.close();
const ok = after.preset !== before.preset && after.playing !== before.playing && menuAfterB === false;
console.log(ok ? 'XR INPUT OK' : 'XR INPUT CHECKS FAILED');
process.exit(unique.some((e) => e.startsWith('[pageerror]')) || !ok ? 1 : 0);
