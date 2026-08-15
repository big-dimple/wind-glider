/* probe6.mjs — dump the scene graph: names, types, positions, geometry,
 * material names. Hunting the on-water checker strip near the start line. */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5207;

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
  await page.evaluate(() => window.__harness.scenario('countdown'));
  const dump = await page.evaluate(() => {
    const out = [];
    window.__scene.traverse((o) => {
      if (!o.isMesh && !o.isSprite) return;
      const g = o.geometry;
      const geo = g ? `${g.type}` : '-';
      const mat = Array.isArray(o.material) ? o.material[0] : o.material;
      const mname = mat ? (mat.name || mat.type) : '-';
      const p = o.getWorldPosition(new window.__THREE.Vector3());
      const bb = g && g.boundingBox ? g.boundingBox : null;
      if (g && !bb) g.computeBoundingBox();
      const size = g && g.boundingBox
        ? g.boundingBox.getSize(new window.__THREE.Vector3()).toArray().map((v) => v.toFixed(1)).join('x')
        : '-';
      out.push(`${o.name || '(anon)'} [${o.type}] geo=${geo} ${size} mat=${mname} pos=(${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)})`);
    });
    return out;
  });
  console.log(dump.join('\n'));
} finally {
  if (browser) await browser.close();
  server.kill();
}
