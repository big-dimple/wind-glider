import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.COLLISION_PORT || 5208);
const useBundledChromium = process.env.PLAYWRIGHT_BUNDLED === '1';
const chrome = !useBundledChromium && existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined;
const server = spawn(process.execPath, [
  path.join(root, 'node_modules/vite/bin/vite.js'),
  '--host', '127.0.0.1',
  '--port', String(port),
  '--strictPort',
], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverError = '';
server.stderr.on('data', (chunk) => { serverError += String(chunk); });

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    if (server.exitCode !== null) throw new Error(`collision Vite server exited (${server.exitCode}): ${serverError}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`collision Vite server was not ready on ${port}: ${serverError}`);
}

try {
  await waitForServer();
  const browser = await chromium.launch({
    headless: true,
    ...(chrome ? { executablePath: chrome } : {}),
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 844, height: 390 } });
  page.on('pageerror', (error) => console.error(`[collision pageerror] ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      console.error(`[collision console.${message.type()}] ${message.text()}`);
    }
  });
  console.log(`collision browser: ${chrome ? 'system-chrome' : 'playwright-chromium'}`);
  await page.goto(`http://127.0.0.1:${port}/?harness=1&quality=performance`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__harness?.ready, null, { timeout: 120000 });

  const run = (name) => page.evaluate((caseName) => window.__harness.collisionCase(caseName), name);

  const feedback = await page.evaluate(() => window.__harness.collisionFeedbackCase());
  assert.equal(feedback.hits, 1, 'the integrated collision path must receive the physical hit');
  assert.equal(feedback.finite, true);
  assert.ok(feedback.musicDuck <= 0.55, `collision impact must clear space in the mix: ${feedback.musicDuck}`);
  assert.equal(feedback.collisionAudioEvents, 1, 'same-frame player hits must coalesce to one audio event');
  assert.ok(['impact', ''].includes(String(feedback.hapticLane)),
    `collision feedback must use the impact lane: ${feedback.hapticLane}`);
  assert.equal(feedback.radioVisible, true, 'a player collision must reach the race-radio UI');
  assert.match(feedback.radioText, /接触|碰撞/, 'radio copy must explain the physical event');

  const side = await run('side-boost');
  assert.equal(side.finite, true);
  assert.equal(side.hits, 1, 'boost side impact should report one cooled-down collision event');
  assert.ok(side.toi >= 0 && side.toi <= 1, `side impact TOI ${side.toi}`);
  assert.ok(side.opponentVX > 7, `side impact should throw the opponent laterally, vx=${side.opponentVX}`);
  assert.ok(side.playerSpeed >= side.opponentSpeed * 0.75,
    `boost attacker should preserve the route instead of losing all speed: ${side.playerSpeed}/${side.opponentSpeed}`);

  const headOn = await run('head-on-ccd');
  assert.equal(headOn.finite, true);
  assert.equal(headOn.hits, 1, 'two hulls crossing fully between frames must still collide');
  assert.ok(headOn.toi > 0 && headOn.toi < 1, `head-on CCD TOI ${headOn.toi}`);
  assert.ok(headOn.playerSpeed <= 50 && headOn.opponentSpeed <= 50, 'impact may not create a speed explosion');

  const rear = await run('rear-end');
  assert.equal(rear.hits, 1);
  assert.ok(rear.opponentVZ > 24, `rear-end contact should transfer forward speed, vz=${rear.opponentVZ}`);
  assert.ok(rear.playerVZ < 42, `attacker should pay a bounded impact cost, vz=${rear.playerVZ}`);

  const separated = await run('height-separated');
  assert.equal(separated.hits, 0, 'boats separated vertically must not collide');

  const resting = await run('resting-overlap');
  assert.equal(resting.hits, 0, 'resting separation should not spam impact feedback');
  assert.equal(resting.finite, true);
  assert.ok(resting.maxCorrection <= 0.4 + 1e-5, `bounded correction ${resting.maxCorrection}`);
  assert.ok(resting.centerDistance > 0.2, 'three solver passes should separate an overlap');

  const matrix = await run('pair-matrix');
  assert.equal(matrix.pairCount, 15, 'six boats must exercise all 15 unordered collision pairs');
  assert.equal(matrix.hitPairs, 15, 'collision behavior must not depend on boat id/order');
  assert.equal(matrix.finite, true);
  assert.ok(matrix.minOpponentThrow > 7, `every defender should receive a useful side throw: ${matrix.minOpponentThrow}`);
  assert.ok(matrix.maxSpeed <= 50, `the pair matrix must remain energy bounded: ${matrix.maxSpeed}`);
  assert.ok(matrix.maxCorrection <= 0.4 + 1e-5, `matrix correction bound ${matrix.maxCorrection}`);

  const pileup = await run('three-boat-pileup');
  assert.equal(pileup.finite, true);
  assert.ok(pileup.distinctPairs >= 2, `a three-boat sandwich should solve both sides: ${pileup.distinctPairs}`);
  assert.ok(pileup.maxSpeed <= 50, `multi-contact must not create a velocity explosion: ${pileup.maxSpeed}`);
  assert.ok(pileup.maxCorrection <= 0.4 + 1e-5, `pileup correction bound ${pileup.maxCorrection}`);

  const cooldown = await run('contact-cooldown');
  assert.equal(cooldown.finite, true);
  assert.equal(cooldown.firstWindowEvents, 1, 'sustained rubbing may emit only one initial feedback event');
  assert.ok(cooldown.totalEvents >= 2 && cooldown.totalEvents <= 3,
    `contact feedback should rearm after cooldown without firing every frame: ${cooldown.totalEvents}`);

  const flightIsolation = await run('flight-gate-isolation');
  assert.equal(flightIsolation.finite, true);
  assert.ok(flightIsolation.signedBefore < 0 && flightIsolation.signedAfter > 0,
    `the contact correction must physically cross the flight gate: ${flightIsolation.signedBefore}/${flightIsolation.signedAfter}`);
  assert.equal(flightIsolation.gateBefore, 0);
  assert.equal(flightIsolation.gateAfter, 0, 'contact-only correction must never award a flight gate');
  assert.equal(flightIsolation.routeState, 'active');

  const route4Inside = await run('route4-inside');
  assert.equal(route4Inside.finite, true);
  assert.equal(route4Inside.configuredLimit, 8, 'route 4 pass rule must be exactly 8m');
  assert.equal(route4Inside.visualHalfWidth, 8, 'route 4 visual portal must match its pass rule');
  assert.equal(route4Inside.corridorHalfWidth, 8, 'route 4 corridor must not be narrower than its portal');
  assert.equal(route4Inside.routeState, 'passed', '7.95m inside the route 4 portal must pass');
  assert.equal(route4Inside.flights, 4);

  const route4Outside = await run('route4-outside');
  assert.equal(route4Outside.finite, true);
  assert.equal(route4Outside.routeState, 'failed', '8.05m outside the route 4 portal must fail');
  assert.equal(route4Outside.gates, 0);
  assert.ok(['gate_left', 'gate_right'].includes(route4Outside.reason));

  const checkpointIsolation = await run('checkpoint-isolation');
  assert.equal(checkpointIsolation.finite, true);
  assert.ok(checkpointIsolation.signedBefore < 0 && checkpointIsolation.signedAfter > 0,
    `the contact correction must physically cross the checkpoint plane: ${checkpointIsolation.signedBefore}/${checkpointIsolation.signedAfter}`);
  assert.equal(checkpointIsolation.checkpointDelta, 0, 'contact-only correction must never award a race checkpoint');
  assert.ok(Math.abs(checkpointIsolation.progressDelta) < 0.2,
    `contact baseline sync should absorb progress correction: ${checkpointIsolation.progressDelta}`);

  console.log('collision contract: OK');
  console.log(JSON.stringify({
    feedback,
    side,
    headOn,
    rear,
    separated,
    resting,
    matrix,
    pileup,
    cooldown,
    flightIsolation,
    route4Inside,
    route4Outside,
    checkpointIsolation,
  }, null, 2));
  await browser.close();
} finally {
  server.kill('SIGTERM');
}
