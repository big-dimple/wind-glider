/* probe3.mjs — find meshes with anomalous world bounding boxes. */
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
  const report = await page.evaluate(() => {
    const out = [];
    window.__scene.updateMatrixWorld(true);
    window.__scene.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      const bb = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
      const sx = bb.max.x - bb.min.x;
      const sy = bb.max.y - bb.min.y;
      const sz = bb.max.z - bb.min.z;
      const vol = Math.max(sx, sy, sz);
      // suspicious: medium objects (not ocean/sky) that are big
      if (vol > 6 && vol < 800) {
        out.push({
          name: o.name || o.type,
          parent: o.parent?.name || o.parent?.type,
          size: [sx, sy, sz].map((v) => Math.round(v * 10) / 10),
          pos: [bb.min.x + sx / 2, bb.min.y + sy / 2, bb.min.z + sz / 2].map((v) => Math.round(v * 10) / 10),
          mat: o.material?.type,
          uniforms: o.material?.uniforms ? Object.keys(o.material.uniforms).slice(0, 6) : null,
        });
      }
    });
    return out;
  });
  for (const r of report) console.log(JSON.stringify(r));
} finally {
  if (browser) await browser.close();
  server.kill();
}
