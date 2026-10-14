// Audio feature sanity test: drives engine.update() at 60 Hz without rendering and checks that the
// demo track produces beats, a plausible BPM and well-ranged features. Usage: node tests/audio.mjs [--url ...]
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const urlArg = args.indexOf('--url');
const base = urlArg >= 0 ? args[urlArg + 1] : 'http://localhost:4173/';
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(base + '?demo=1&quality=low&nowelcome=1&nomenu=1', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.app, null, { timeout: 20000 });
await page.mouse.click(320, 180);
await page.waitForTimeout(500);
const result = await page.evaluate(async () => {
  const app = window.app;
  app.renderer.setAnimationLoop(null); // stop rendering; software GL is too slow to sample at 60 Hz
  const f = app.engine.features;
  const samples = [];
  let beats = 0;
  const start = performance.now();
  await new Promise((resolve) => {
    const id = setInterval(() => {
      app.engine.update();
      if (f.beat) beats++;
      samples.push([f.level, f.bass, f.mid, f.treble, f.onset, f.beatEnv]);
      if (performance.now() - start > 12000) { clearInterval(id); resolve(); }
    }, 1000 / 60);
  });
  const col = (i) => samples.map((s) => s[i]);
  const stats = (a) => ({ min: +Math.min(...a).toFixed(2), max: +Math.max(...a).toFixed(2), mean: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) });
  return {
    frames: samples.length, beats, bpm: Math.round(f.bpm), beatCount: f.beatCount, active: f.active, silence: f.silence,
    level: stats(col(0)), bass: stats(col(1)), mid: stats(col(2)), treble: stats(col(3)), onset: stats(col(4)),
  };
});
console.log(JSON.stringify(result, null, 1));
await browser.close();
const seconds = 12;
const ok = result.active && !result.silence && result.beats > seconds * 1.2 && result.beats < seconds * 4 && result.bpm > 100 && result.bpm < 140 && result.level.max > 0.5 && result.bass.max > 0.5;
console.log(ok ? 'AUDIO OK' : 'AUDIO CHECKS FAILED');
process.exit(ok ? 0 : 1);
