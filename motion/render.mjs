// Deterministic frame render: dashboard.html?render is stepped via __seek(ms)
// per frame; PNGs stream into ffmpeg stdin (image2pipe) -> out/<name>.mp4.
//
// Usage: node render.mjs [--fps 30] [--out out/brti-r1r6-dust.mp4]

import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const FPS = parseInt(arg('--fps', '30'), 10);
const OUT = join(here, arg('--out', 'out/brti-r1r6-dust.mp4'));
const W = 1080, H = 1440;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(join(here, 'dashboard.html')).href + '?render');
await page.waitForFunction('typeof window.__seek === "function"');
const durMs = await page.evaluate('window.TIMELINE.meta.duration * 1000');
const frames = Math.round((durMs / 1000) * FPS);

const ff = spawn('ffmpeg', [
  '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium',
  '-movflags', '+faststart', OUT,
], { stdio: ['pipe', 'ignore', 'inherit'] });

const t0 = Date.now();
for (let f = 0; f < frames; f++) {
  await page.evaluate((ms) => window.__seek(ms), (f / FPS) * 1000);
  const png = await page.screenshot({ type: 'png' });
  if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once('drain', r));
  if (f % 150 === 0) {
    const rate = (f + 1) / ((Date.now() - t0) / 1000);
    console.log(`frame ${f}/${frames} (${rate.toFixed(1)} fps render)`);
  }
}
ff.stdin.end();
await new Promise((res, rej) => ff.on('close', (c) => (c === 0 ? res() : rej(new Error('ffmpeg exit ' + c)))));
await browser.close();
console.log(`done: ${OUT} (${frames} frames @ ${FPS}fps, ${(Date.now() - t0) / 1000 | 0}s)`);
