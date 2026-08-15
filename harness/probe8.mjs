/* probe8.mjs — rider pose side & 3/4 views to diagnose arm/head silhouette */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5209;

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

  await page.evaluate(() => window.__harness.scenario('sweeper'));

  // side view: 6m to the right of the boat, at rider height, tight crop
  await page.evaluate(() => {
    const p = window.__harness.playerPose();
    const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
    const rx = fz, rz = -fx; // right vector
    window.__harness.freeCam(
      p.x + rx * 6, p.y + 1.3, p.z + rz * 6,
      p.x, p.y + 0.9, p.z,
    );
    window.__harness.render();
  });
  await page.screenshot({ path: path.join(root, 'shots', 'debug-riderside.png') });
  console.log('-> shots/debug-riderside.png');

  // 3/4 front view
  await page.evaluate(() => {
    const p = window.__harness.playerPose();
    const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
    const rx = fz, rz = -fx;
    window.__harness.freeCam(
      p.x + fx * 5.5 + rx * 3.5, p.y + 1.6, p.z + fz * 5.5 + rz * 3.5,
      p.x, p.y + 0.8, p.z,
    );
    window.__harness.render();
  });
  await page.screenshot({ path: path.join(root, 'shots', 'debug-rider34.png') });
  console.log('-> shots/debug-rider34.png');
} finally {
  if (browser) await browser.close();
  server.kill();
}
