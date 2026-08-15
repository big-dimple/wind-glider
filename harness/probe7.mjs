/* probe7.mjs — round 2 verification shots:
 * 1. clean sun view (disc + rays) from the hairpin, away from the gantry
 * 2. banner REVERSE face from beyond the line (should be race checker)
 * 3. buoy close-up at the hairpin gate
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5208;

async function waitForServer(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('no server');
}

const server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let browser;
try {
  await waitForServer(`http://localhost:${PORT}/`);
  browser = await chromium.launch({
    headless: true,
    args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(`http://localhost:${PORT}/?harness=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__harness?.ready, null, { timeout: 60000 });

  // --- 1. sun disc + rays: from the hairpin pack, looking sunward ---
  await page.evaluate(() => window.__harness.scenario('hairpin'));
  await page.evaluate(() => {
    const p = window.__harness.playerPose();
    const s = [0.5406, 0.5946, 0.5946]; // normalized PALETTE.sunDir
    window.__harness.freeCam(
      p.x, p.y + 2, p.z,
      p.x + s[0] * 200, p.y + 2 + s[1] * 200, p.z + s[2] * 200,
    );
    window.__harness.render();
  });
  await page.screenshot({ path: path.join(root, 'shots', 'debug-sun.png') });
  console.log('-> shots/debug-sun.png');

  // --- 2. banner reverse: beyond the line looking back at the gantry ---
  await page.evaluate(() => window.__harness.scenario('countdown'));
  await page.evaluate(() => {
    // line is at u=0 ≈ (0,0) heading +Z; stand 30m past it, look back
    window.__harness.freeCam(2, 4.2, 34, 0, 5.5, -6);
    window.__harness.render();
  });
  await page.screenshot({ path: path.join(root, 'shots', 'debug-bannerback.png') });
  console.log('-> shots/debug-bannerback.png');

  // --- 3. buoy close-up: hairpin gate pair, low camera ---
  await page.evaluate(() => window.__harness.scenario('hairpin'));
  await page.evaluate(() => {
    const p = window.__harness.playerPose();
    const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
    window.__harness.freeCam(
      p.x - fx * 14, p.y + 1.6, p.z - fz * 14,
      p.x + fx * 8, p.y + 1.2, p.z + fz * 8,
    );
    window.__harness.render();
  });
  await page.screenshot({ path: path.join(root, 'shots', 'debug-buoy.png') });
  console.log('-> shots/debug-buoy.png');
} finally {
  if (browser) await browser.close();
  server.kill();
}
