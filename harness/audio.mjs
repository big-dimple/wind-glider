import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.AUDIO_PORT || 5216);
const chrome = existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined;
const server = spawn(process.execPath, [
  path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1',
  '--port', String(port), '--strictPort',
], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let serverError = '';
server.stderr.on('data', (chunk) => { serverError += String(chunk); });

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    if (server.exitCode !== null) throw new Error(`audio Vite server exited (${server.exitCode}): ${serverError}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`audio Vite server was not ready on ${port}: ${serverError}`);
}

async function advanceWithWallClock(page, seconds, step = 0.1) {
  let elapsed = 0;
  while (elapsed < seconds) {
    const dt = Math.min(step, seconds - elapsed);
    await page.evaluate((amount) => window.__harness.advance(amount), dt);
    await page.waitForTimeout(dt * 1000);
    elapsed += dt;
  }
}

try {
  await waitForServer();
  const browser = await chromium.launch({
    headless: true,
    ...(chrome ? { executablePath: chrome } : {}),
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-sandbox'],
  });
  const requests = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (error) => console.error(`[audio pageerror] ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      console.error(`[audio console.${message.type()}] ${message.text()}`);
    }
  });
  page.on('request', (request) => requests.push(request.url()));
  await page.goto(`http://127.0.0.1:${port}/?harness=1&quality=performance`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__harness?.ready, null, { timeout: 120000 });

  await page.locator('.audio-mixer-toggle').click();
  await page.waitForFunction(() => window.__harness.audioState().contextState === 'running');
  await page.waitForTimeout(180);
  let state = await page.evaluate(() => window.__harness.audioState());
  assert.equal(state.scene, 'ready');
  assert.equal(state.scoreArmed, false);
  assert.equal(state.readyMusicActive, true);
  assert.equal(state.musicPlaying, true);
  assert.ok(Number(state.musicBusGain) > 0.01, `READY music must open: ${state.musicBusGain}`);
  assert.ok(Number(state.ambience) <= 0.12, `environment default must stay restrained: ${state.ambience}`);
  assert.equal(state.continuousAmbienceActive, false, 'continuous water/air loops must stay disabled');
  assert.ok(Number(state.startSignalTopHz) > Number(state.countdownTickHz),
    'GO must resolve to a higher pitch than the 3/2/1 tick');
  assert.ok(Number(state.startSignalPeak) > Number(state.countdownTickPeak),
    'GO must be intentionally louder than the 3/2/1 ticks');
  assert.equal(requests.filter((url) => /countdown-go-/.test(url)).length, 0,
    'GO must not request voice assets');

  const sliders = {
    master: ['总音量', 'outputGain'],
    music: ['摇滚', 'musicBusGain'],
    sfx: ['音效', 'eventBusGain'],
    ambience: ['环境事件', 'ambienceBusGain'],
  };
  for (const [key, [label, gainKey]] of Object.entries(sliders)) {
    const slider = page.getByLabel(label);
    await slider.fill('0');
    await slider.dispatchEvent('input');
    await page.waitForTimeout(260);
    state = await page.evaluate(() => window.__harness.audioState());
    assert.ok(Number(state[gainKey]) < 0.008, `${key} 0% must silence ${gainKey}: ${state[gainKey]}`);
    assert.equal(await slider.evaluate((el) => el.parentElement.querySelector('output').textContent), '0%');
    await slider.fill('100');
    await slider.dispatchEvent('input');
    await page.waitForTimeout(300);
    state = await page.evaluate(() => window.__harness.audioState());
    assert.ok(Number(state[gainKey]) > 0.08, `${key} 100% must restore ${gainKey}: ${state[gainKey]}`);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('board-race.audio.v1')));
    assert.equal(saved[key], 1, `${key} must persist independently`);
    if (key !== 'music') assert.equal(state.scoreArmed, false);
  }

  await page.evaluate(() => window.__harness.scenario('countdown'));
  await page.waitForTimeout(180);
  state = await page.evaluate(() => window.__harness.audioState());
  assert.equal(state.scene, 'countdown');
  assert.equal(state.scoreArmed, true);
  assert.equal(state.countdownStage, 2);
  const signalBeforeGo = Number(state.startSignalEvents);
  assert.equal(signalBeforeGo, 0, '3/2/1 must not fire GO');
  const goSnapshot = await page.evaluate(() => {
    window.__harness.advance(2.7);
    return window.__harness.audioState();
  });
  assert.equal(goSnapshot.scene, 'racing');
  assert.equal(Number(goSnapshot.startSignalEvents), signalBeforeGo + 1, 'GO must emit exactly one start signal');
  assert.ok(Number(goSnapshot.musicDuck) <= 0.55, `GO signal should briefly clear score: ${goSnapshot.musicDuck}`);
  await page.waitForTimeout(220);
  state = await page.evaluate(() => window.__harness.audioState());
  assert.ok(Number(state.musicFilterHz) > 4200, `GO must open score filter: ${state.musicFilterHz}`);
  await page.waitForTimeout(700);
  state = await page.evaluate(() => window.__harness.audioState());
  assert.ok(Number(state.musicFilterHz) > 9000, `score filter must recover: ${state.musicFilterHz}`);

  const beforeNextRun = Number(state.musicTime);
  await page.evaluate(() => window.__harness.scenario('countdown'));
  await page.waitForTimeout(220);
  state = await page.evaluate(() => window.__harness.audioState());
  assert.equal(Number(state.startSignalEvents), signalBeforeGo + 1, 'second countdown must stay quiet before GO');
  assert.ok(Number(state.musicTime) >= beforeNextRun, `BGM timeline must not restart: ${beforeNextRun} -> ${state.musicTime}`);
  await page.evaluate(() => window.__harness.advance(2.7));
  await page.waitForTimeout(120);
  state = await page.evaluate(() => window.__harness.audioState());
  assert.equal(Number(state.startSignalEvents), signalBeforeGo + 2);

  await page.evaluate(() => window.__harness.scenario('drift-charge'));
  state = await page.evaluate(() => window.__harness.audioState());
  assert.ok(Number(state.driftTier) >= 1, `drift tier should remain audible: ${state.driftTier}`);
  await page.evaluate(() => window.__harness.advance(0.35));
  state = await page.evaluate(() => window.__harness.audioState());
  assert.ok(Number(state.driftTier) >= 2, `drift tier should advance: ${state.driftTier}`);

  const beforeEvents = await page.evaluate(() => window.__harness.audioEventLog());
  await page.evaluate(() => window.__harness.collisionFeedbackCase());
  const afterEvents = await page.evaluate(() => window.__harness.audioEventLog());
  assert.ok(afterEvents.length >= beforeEvents.length, 'audio event audit must be readable');
  state = await page.evaluate(() => window.__harness.audioState());
  assert.equal(state.continuousAmbienceActive, false);
  assert.ok(Number(state.maxOneShots) >= 16);

  await page.evaluate(() => window.__harness.setVisibility(true));
  state = await page.evaluate(() => window.__harness.audioState());
  assert.equal(state.scene, 'hidden');
  assert.equal(state.outputGain, 0);
  assert.equal(state.musicPlaying, false);
  await page.evaluate(() => window.__harness.setVisibility(false));
  await page.waitForTimeout(150);
  state = await page.evaluate(() => window.__harness.audioState());
  assert.equal(state.outputGain, 0, 'foreground remains silent until explicit resume');
  assert.equal(state.musicPlaying, false);
  await page.evaluate(() => window.__harness.resumeInterruption());
  await page.waitForTimeout(450);
  state = await page.evaluate(() => window.__harness.audioState());
  assert.ok(Number(state.outputGain) > 0.08);
  assert.equal(state.musicPlaying, true);

  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__harness?.ready);
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('board-race.audio.v1')));
  assert.deepEqual(
    { master: persisted.master, music: persisted.music, sfx: persisted.sfx, ambience: persisted.ambience },
    { master: 1, music: 1, sfx: 1, ambience: 1 },
    'mixer settings must survive reload',
  );

  // A real touch GO still uses the same exact-time non-verbal path.
  const mobileContext = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });
  const mobilePage = await mobileContext.newPage();
  const mobileRequests = [];
  mobilePage.on('request', (request) => mobileRequests.push(request.url()));
  await mobilePage.goto(`http://127.0.0.1:${port}/?harness=1&mobile=1&quality=performance`, { waitUntil: 'load', timeout: 60000 });
  await mobilePage.waitForFunction(() => window.__harness?.ready, null, { timeout: 60000 });
  await mobilePage.locator('.driver-select-go').click();
  await advanceWithWallClock(mobilePage, 6.2);
  const mobileAudio = await mobilePage.evaluate(() => window.__harness.audioState());
  assert.equal((await mobilePage.evaluate(() => window.__harness.playerState())).phase, 'racing');
  assert.equal(mobileAudio.contextStateAtGo, 'running');
  assert.equal(mobileAudio.lastGoDisposition, 'played');
  assert.equal(Number(mobileAudio.startSignalEvents), 1);
  assert.equal(mobileRequests.filter((url) => /countdown-go-/.test(url)).length, 0);
  await mobileContext.close();

  console.log('audio contract: OK');
  await browser.close();
} finally {
  server.kill('SIGTERM');
}
