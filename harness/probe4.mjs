/* probe4.mjs — NaN attribute scan + per-subtree visibility toggle screenshots. */
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

  // 1) NaN / insane-value scan in all geometry attributes
  const nanReport = await page.evaluate(() => {
    const out = [];
    window.__scene.traverse((o) => {
      if (!o.isMesh || !o.geometry?.attributes) return;
      for (const [name, attr] of Object.entries(o.geometry.attributes)) {
        const a = attr.array;
        let bad = 0;
        let maxAbs = 0;
        for (let i = 0; i < a.length; i++) {
          const v = a[i];
          if (Number.isNaN(v)) bad++;
          else if (Math.abs(v) > maxAbs) maxAbs = Math.abs(v);
        }
        if (bad > 0 || (name === 'position' && maxAbs > 5000) || (name !== 'position' && maxAbs > 1e6)) {
          out.push({ mesh: o.name || o.type, parent: o.parent?.name, attr: name, nan: bad, maxAbs: Math.round(maxAbs) });
        }
      }
    });
    return out;
  });
  console.log('NaN/insane scan:', JSON.stringify(nanReport));

  // 2) toggle subtrees: riders off, outlines off, boats off
  const toggles = [
    ['riders-off', `window.__scene.traverse(o => { if (o.parent?.name === 'riderMount' || o.name === 'rider') o.visible = false; })`],
    ['outlines-off', `window.__scene.traverse(o => { if (o.name === 'outline') o.visible = false; })`],
  ];
  for (const [name, code] of toggles) {
    await page.evaluate((c) => {
      window.__scene.traverse((o) => (o.visible = true));
      eval(c);
      window.__harness.render();
    }, code);
    await page.screenshot({ path: path.join(root, `shots/elim-${name}.png`) });
    console.log('elim-' + name);
  }
} finally {
  if (browser) await browser.close();
  server.kill();
}
