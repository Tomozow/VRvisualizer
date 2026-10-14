// Headless smoke + screenshot test. Usage: node tests/screenshots.mjs [--url http://localhost:4173/]
// Builds are served with `vite preview`; this script loads every preset with the demo signal running,
// waits a few seconds, captures console errors and saves screenshots to tests/out/.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const urlArg = args.indexOf('--url');
const base = urlArg >= 0 ? args[urlArg + 1] : 'http://localhost:4173/';
const outDir = resolve('tests/out');
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
  ],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));

await page.goto(base + '?demo=1&quality=low&nowelcome=1', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.app, null, { timeout: 20000 });
// Some browsers need a gesture before audio starts
await page.mouse.click(800, 450);
await page.waitForTimeout(1500);

const presets = await page.evaluate(() => window.app.store.state.presets.map((p) => p.id));
const palettes = await page.evaluate(() => window.app.store.state.palettes.map((p) => p.id));
console.log('presets:', presets.join(', '));
console.log('palettes:', palettes.join(', '));

const report = [];
for (let i = 0; i < presets.length; i++) {
  const id = presets[i];
  const pal = palettes[i % palettes.length];
  await page.evaluate(({ id, pal }) => {
    window.app.setPreset(id);
    window.app.setPalette(pal);
    window.app.setMenuVisible(false);
  }, { id, pal });
  await page.waitForTimeout(2500);
  const stats = await page.evaluate(() => {
    const r = window.app.renderer.info.render;
    const f = window.app.engine.features;
    return { calls: r.calls, triangles: r.triangles, points: r.points, lines: r.lines, fps: window.app.store.state.fps,
      level: +f.level.toFixed(2), bass: +f.bass.toFixed(2), bpm: Math.round(f.bpm), active: f.active, silence: f.silence };
  });
  await page.screenshot({ path: `${outDir}/${String(i + 1).padStart(2, '0')}-${id}.png` });
  report.push({ id, pal, ...stats });
  console.log(id, JSON.stringify(stats));
}

// Menu panel screenshot (desktop fallback raycast) and DOM overlay
await page.evaluate(() => { window.app.setPreset('spectrum'); window.app.setMenuVisible(true); window.app.recenter(); });
await page.waitForTimeout(1200);
await page.screenshot({ path: `${outDir}/90-menu-player.png` });
for (const tab of ['scenes', 'sources', 'settings']) {
  await page.evaluate((t) => window.app.setTab(t), tab);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${outDir}/91-menu-${tab}.png` });
}
await page.evaluate(() => { window.app.overlay.setHidden(false); });
await page.waitForTimeout(400);
await page.screenshot({ path: `${outDir}/95-overlay.png` });

const unique = [...new Set(errors)];
console.log(`\nconsole errors/warnings (${unique.length}):`);
for (const e of unique.slice(0, 40)) console.log('  ' + e);
await browser.close();
process.exit(unique.some((e) => e.startsWith('[pageerror]') || /THREE\.WebGLProgram|Shader Error/.test(e)) ? 1 : 0);
