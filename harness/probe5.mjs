/* probe5.mjs — raycast the white-sail pixels to identify the object. */
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
  await page.evaluate(() => window.__harness.render());

  // violet-boat sail ≈ NDC (-0.3, 0.28); player-boat sail ≈ (0.0, 0.35); yellow sail ≈ (0.85, 0.3)
  const hits = await page.evaluate(() => {
    const S = window.__scene;
    const cam = window.__camera;
    const ray = new window.__THREE.Raycaster();
    const out = [];
    for (const [nx, ny] of [[-0.3, 0.28], [0.0, 0.35], [0.85, 0.3], [0.5, 0.2]]) {
      ray.setFromCamera(new window.__THREE.Vector2(nx, ny), cam);
      const hit = ray.intersectObjects(S.children, true)[0];
      out.push({
        ndc: [nx, ny],
        name: hit?.object?.name || hit?.object?.type || null,
        parentChain: (() => {
          const chain = [];
          let o = hit?.object;
          while (o) { chain.push(o.name || o.type); o = o.parent; }
          return chain.join(' < ');
        })(),
        geo: hit?.object?.geometry?.type,
        dist: hit ? Math.round(hit.distance * 10) / 10 : null,
      });
    }
    return out;
  });
  for (const h of hits) console.log(JSON.stringify(h));
} finally {
  if (browser) await browser.close();
  server.kill();
}
