/* probe.mjs — one-off race-progress diagnostic: advance the harness game in
 * chunks and print racer lap/progress so we can see where lap credit dies. */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5199;

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
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(`http://localhost:${PORT}/?harness=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__harness?.ready, null, { timeout: 60000 });
  await page.evaluate(() => window.__harness.scenario('start'));
  for (let i = 0; i < 24; i++) {
    await page.evaluate(() => window.__harness.advance(20));
    const s = await page.evaluate(() => window.__harness.stats());
    console.log(`t=${Math.round(s.simTime)}s phase=${s.phase} ${s.racers}`);
    if (s.phase === 'finished') break;
  }
} finally {
  if (browser) await browser.close();
  server.kill();
}
