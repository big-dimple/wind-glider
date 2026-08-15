/* probe2.mjs — elimination test: toggle suspect objects, screenshot each state. */
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(`http://localhost:${PORT}/?harness=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__harness?.ready, null, { timeout: 60000 });
  await page.evaluate(() => window.__harness.scenario('start'));

  // expose the scene for toggling: walk from any known object — use __harness debug hook if present
  const hasDebug = await page.evaluate(() => !!window.__scene);
  console.log('scene hook:', hasDebug);
  if (hasDebug) {
    const states = [
      ['all-on', () => {}],
      ['no-spray', (S) => S.traverse((o) => { if (o.geometry?.isInstancedBufferGeometry) o.visible = false; })],
      ['no-wake', (S) => S.traverse((o) => { if (o.material?.uniforms?.uHeadAlong) o.visible = false; })],
    ];
    for (const [name, fn] of states) {
      await page.evaluate((src) => {
        const f = eval(src);
        // reset visibility first
        window.__scene.traverse((o) => (o.visible = true));
        f(window.__scene);
        window.__harness.render();
      }, fn.toString());
      await page.screenshot({ path: path.join(root, `shots/elim-${name}.png`) });
      console.log('elim-' + name);
    }
  }
} finally {
  if (browser) await browser.close();
  server.kill();
}
