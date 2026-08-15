import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.SYSTEMS_PORT || 5221);
const chrome = existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined;
const base = `http://127.0.0.1:${port}/?harness=1&quality=performance`;
const server = spawn(process.execPath, [
  path.join(root, 'node_modules/vite/bin/vite.js'),
  '--host', '127.0.0.1',
  '--port', String(port),
  '--strictPort',
], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(base)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('systems harness server did not start');
}

async function load(page) {
  await page.goto(base, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__harness?.ready, null, { timeout: 60000 });
}

async function replaceStorage(page, entries) {
  await page.evaluate((next) => {
    localStorage.clear();
    for (const [key, value] of Object.entries(next)) localStorage.setItem(key, JSON.stringify(value));
  }, entries);
  await page.reload({ waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__harness?.ready, null, { timeout: 60000 });
}

try {
  await waitForServer();
  const browser = await chromium.launch({
    headless: true,
    ...(chrome ? { executablePath: chrome } : {}),
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-sandbox'],
  });

  const recordsContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const recordsPage = await recordsContext.newPage();
  await load(recordsPage);
  const freshRecords = await recordsPage.evaluate(() => window.__harness.recordsState());
  assert.equal(freshRecords.version, 8);
  assert.equal(freshRecords.coach.status, 'dormant');
  assert.equal(freshRecords.coach.automaticEligible, true,
    'a brand-new v8 save must receive the one-time first-failure invitation');

  const portraits = await recordsPage.locator('.driver-card').evaluateAll((cards) => cards.map((card) => {
    const image = card.querySelector('img');
    return {
      id:card.dataset.driver,
      name:card.querySelector('strong')?.textContent,
      src:image?.currentSrc,
      width:image?.naturalWidth,
      height:image?.naturalHeight,
    };
  }));
  assert.equal(new Set(portraits.map((portrait) => portrait.id)).size, 6, 'character select must expose six adult drivers');
  assert.equal(new Set(portraits.map((portrait) => portrait.src)).size, 6, 'every local driver portrait must decode distinctly');
  assert.ok(portraits.every((portrait) => portrait.width === 640 && portrait.height === 960),
    `all portraits must use the mobile-safe 2:3 master: ${JSON.stringify(portraits)}`);
  assert.ok(portraits.some((portrait) => portrait.name === 'TIDE') && portraits.some((portrait) => portrait.name === 'SOL'),
    'both women must be selectable');
  assert.equal(await recordsPage.locator('.driver-card').count(), 6, 'six drivers must remain reachable');
  assert.equal(await recordsPage.locator('.driver-card:visible').count(), 3,
    'the carousel must show only previous, current, and next drivers');
  assert.equal(await recordsPage.locator('.driver-dot').count(), 6,
    'six compact destinations must replace the six-card wall');
  assert.equal(await recordsPage.locator('.driver-dot.selected').count(), 1);
  assert.match(await recordsPage.locator('.driver-radar-title').textContent() ?? '', /±6%/,
    'the radar must state its real physics ceiling');
  assert.match(await recordsPage.locator('.driver-radar-title').textContent() ?? '', /实机性能修正.*基准 0%/,
    'the radar must say that the values are live physics modifiers, not decoration');
  assert.match(await recordsPage.locator('.driver-radar').getAttribute('aria-label') ?? '', /加速 .+%，转向 .+%，漂移 .+%，空控 .+%/,
    'the radar must expose the four live handling modifiers');
  assert.equal(await recordsPage.locator('.driver-archive-button').count(), 0,
    'archive utilities must stay out of the selection viewport');

  const driverHandling = {
    axle: [1, 1, 1, 1.04],
    tide: [0.99, 1.01, 0.96, 1.06],
    sol: [1.05, 0.97, 1.02, 0.99],
    reef: [1.04, 1.03, 1.04, 0.98],
    kai: [1.01, 1.04, 0.99, 1.04],
    jinx: [0.98, 1.02, 1.06, 0.97],
  };
  for (const [id, expected] of Object.entries(driverHandling)) {
    await recordsPage.locator(`.driver-dot[data-driver="${id}"]`).click();
    const handling = await recordsPage.evaluate(() => {
      const state = window.__harness.playerState();
      return [state.driverAcceleration, state.driverSteering, state.driverDriftCharge, state.driverAirControl];
    });
    assert.deepEqual(handling, expected, `${id} radar values must reach live Boat physics unchanged`);
    const radar = await recordsPage.locator('.driver-radar').getAttribute('aria-label') ?? '';
    for (const value of expected) {
      const percent = Math.round((value - 1) * 100);
      assert.match(radar, new RegExp(`${percent > 0 ? '\\+' : ''}${percent}%`),
        `${id} radar must print every live handling modifier: ${radar}`);
    }
  }

  await replaceStorage(recordsPage, {
    'board-race:challenge:v3': {
      version: 3, runs: 7, ordinaryUnlocked: true, manMedalsTotal: 4, excellentCount: 2,
      bestQualificationTime: 31.2, bestExcellentTime: 29.8, bestFlights: 5,
      bestRouteProgress: 0.45, closestMissM: 0.12,
    },
  });
  let state = await recordsPage.evaluate(() => window.__harness.recordsState());
  assert.equal(state.version, 8);
  assert.equal(state.runs, 7);
  assert.equal(state.manMedalsTotal, 4);
  assert.equal(state.bestFlights, 5);
  assert.equal(state.farSeaDossierUnlocked, true);
  assert.deepEqual(state.bestFlightsByDriver, {});
  assert.equal(state.finaleCompletions, 0);
  assert.equal(state.coach.status, 'expert');
  assert.equal(state.coach.automaticEligible, false);

  await replaceStorage(recordsPage, {
    'board-race:challenge:v2': {
      version: 2, runs: 5, ordinaryUnlocked: true, legacyMedals: 3, excellentCount: 2,
      bestCompleteTime: 33, bestExcellentTime: 30, bestFlightsCleared: 3,
      bestRouteProgress: 0.33, closestMissM: 0.2,
    },
  });
  state = await recordsPage.evaluate(() => window.__harness.recordsState());
  assert.equal(state.version, 8);
  assert.equal(state.runs, 5);
  assert.equal(state.manMedalsTotal, 3);
  assert.equal(state.bestQualificationTime, 33);
  assert.equal(state.bestFlights, 3);
  assert.equal(state.farSeaDossierUnlocked, true);
  assert.equal(state.expansionSeenMask, 0);
  assert.equal(state.coach.status, 'expert');
  assert.equal(state.coach.automaticEligible, false);

  await replaceStorage(recordsPage, {
    'board-race:challenge:v4': {
      version: 4, runs: -8, ordinaryUnlocked: 'yes', manMedalsTotal: 'bad', excellentCount: -2,
      bestQualificationTime: -1, bestExcellentTime: null, bestFlights: -4,
      bestRouteProgress: -3, closestMissM: -0.2,
      bestFlightsByDriver: { tide: 4, '../bad': 99, sol: -2 }, farSeaDossierUnlocked: false, rivalWins: -9,
    },
  });
  state = await recordsPage.evaluate(() => window.__harness.recordsState());
  assert.equal(state.runs, 0);
  assert.equal(state.ordinaryUnlocked, false);
  assert.equal(state.excellentCount, 0);
  assert.equal(state.bestFlights, 0);
  assert.deepEqual(state.bestFlightsByDriver, { tide: 4, sol: 0 });
  assert.equal(state.bestQualificationTime, null);
  assert.equal(state.coach.status, 'dormant');
  assert.equal(state.coach.automaticEligible, false, 'legacy saves are returning players, regardless of runs');

  await replaceStorage(recordsPage, {
    'board-race:challenge:v5': {
      version: 5, runs: 11, ordinaryUnlocked: false, manMedalsTotal: 0, excellentCount: 0,
      bestQualificationTime: null, bestExcellentTime: null, bestFlights: 1,
      bestRouteProgress: 0.2, closestMissM: null, bestFlightsByDriver: { axle: 1 },
      farSeaDossierUnlocked: false, rivalWins: 0, finaleCompletions: 0,
      expansionSeenMask: 0, finaleScreenshotCount: 0,
    },
  });
  state = await recordsPage.evaluate(() => window.__harness.recordsState());
  assert.equal(state.version, 8);
  assert.equal(state.coach.status, 'dormant', 'legacy non-experts wait for their next real failure');
  assert.equal(state.coach.automaticEligible, false,
    'legacy non-experts may opt in from READY but are never interrupted automatically');
  assert.equal(state.coach.mastery.bankedCharge, true, 'one passed flight proves bank, launch, and route actions');
  assert.equal(state.coach.mastery.launched, true);
  assert.equal(state.coach.mastery.passedRoute, true);
  assert.equal(state.coach.knowledge.bankRule, false,
    'a passed route proves the action, not that the player knows extra drift does not extend base flight');

  await replaceStorage(recordsPage, {
    'board-race:challenge:v7': {
      version: 7, runs: 3, ordinaryUnlocked: false, manMedalsTotal: 0, excellentCount: 0,
      bestQualificationTime: null, bestExcellentTime: null, bestFlights: 0,
      bestRouteProgress: 0, closestMissM: null, bestFlightsByDriver: {},
      farSeaDossierUnlocked: false, rivalWins: 0, finaleCompletions: 0,
      expansionSeenMask: 0, finaleScreenshotCount: 0,
      coach: {
        status: 'dormant', automaticEligible: false,
        mastery: { steered: false, bankedCharge: false, launched: false, passedRoute: false, airBrakedInTurn: false, extendedFlight: false },
        knowledge: { bankRule: false, inventory: false, flightGauge: false, extension: false },
      },
    },
  });
  state = await recordsPage.evaluate(() => window.__harness.recordsState());
  assert.equal(state.coach.status, 'dormant');
  assert.equal(state.coach.automaticEligible, true,
    'the shipped v7 dormant novice must receive the one-time rollout repair');

  await replaceStorage(recordsPage, {
    'board-race:challenge:v7': {
      version: 7, runs: 3, ordinaryUnlocked: false, bestFlights: 0,
      coach: {
        status: 'disabled', automaticEligible: false,
        mastery: { steered: false, bankedCharge: false, launched: false, passedRoute: false, airBrakedInTurn: false, extendedFlight: false },
        knowledge: { bankRule: false, inventory: false, flightGauge: false, extension: false },
      },
    },
  });
  state = await recordsPage.evaluate(() => window.__harness.recordsState());
  assert.equal(state.coach.status, 'disabled');
  assert.equal(state.coach.automaticEligible, false,
    'the rollout repair must preserve an explicit skip');

  await replaceStorage(recordsPage, {
    'board-race:challenge:v7': {
      version: 7, runs: 1, ordinaryUnlocked: false, bestFlights: 0,
      coach: {
        status: 'dormant', automaticEligible: true,
        mastery: { steered: 'yes' }, knowledge: { bankRule: true },
      },
    },
  });
  state = await recordsPage.evaluate(() => window.__harness.recordsState());
  assert.equal(state.coach.automaticEligible, false,
    'malformed v7 mastery cannot forge first-failure eligibility');

  await replaceStorage(recordsPage, {
    'board-race:challenge:v6': {
      version: 6, runs: 2, ordinaryUnlocked: false, manMedalsTotal: 0, excellentCount: 0,
      bestQualificationTime: null, bestExcellentTime: null, bestFlights: 0,
      bestRouteProgress: 0, closestMissM: null, bestFlightsByDriver: {},
      farSeaDossierUnlocked: false, rivalWins: 0, finaleCompletions: 0,
      expansionSeenMask: 0, finaleScreenshotCount: 0,
      coach: { status: 'hacked', mastery: { steered: 'yes', bankedCharge: true }, knowledge: { bankRule: 1 } },
    },
  });
  state = await recordsPage.evaluate(() => window.__harness.recordsState());
  assert.equal(state.coach.status, 'dormant');
  assert.equal(state.coach.automaticEligible, false, 'malformed v6 state cannot forge repair eligibility');
  assert.equal(state.coach.mastery.steered, false);
  assert.equal(state.coach.mastery.bankedCharge, true);
  assert.equal(state.coach.knowledge.bankRule, false);
  await recordsPage.evaluate(() => {
    window.__harness.setCoachEnabled(true);
    window.__harness.setCoachEnabled(false);
  });
  assert.equal((await recordsPage.evaluate(() => window.__harness.coachState())).status, 'disabled');
  await recordsPage.reload({ waitUntil: 'load', timeout: 60000 });
  await recordsPage.waitForFunction(() => window.__harness?.ready);
  assert.equal((await recordsPage.evaluate(() => window.__harness.coachState())).status, 'disabled',
    'closing contextual tips must survive reload');

  await replaceStorage(recordsPage, {});
  state = await recordsPage.evaluate(() => window.__harness.recordsCase('progress'));
  assert.equal(state.runs, 1);
  assert.equal(state.bestFlights, 4);
  assert.deepEqual(state.bestFlightsByDriver, { tide: 4 });
  assert.equal(state.manMedalsTotal, 1);
  assert.equal(state.excellentCount, 1);
  assert.equal(state.rivalWins, 1);
  assert.equal(state.farSeaDossierUnlocked, true);
  assert.equal(state.coach.status, 'expert');
  await recordsPage.reload({ waitUntil: 'load', timeout: 60000 });
  await recordsPage.waitForFunction(() => window.__harness?.ready);
  assert.deepEqual(await recordsPage.evaluate(() => window.__harness.recordsState()), state, 'v4 records must survive reload');

  await recordsPage.evaluate(() => localStorage.setItem('board-race:driver:v1', 'tide'));
  await recordsPage.reload({ waitUntil: 'load', timeout: 60000 });
  await recordsPage.waitForFunction(() => window.__harness?.ready);
  const exported = JSON.parse(await recordsPage.evaluate(() => window.__harness.recordsExport()));
  assert.equal(exported.schema, 'board-race-save');
  assert.equal(exported.selectedDriverId, 'tide');
  assert.equal(exported.records.bestFlights, 4);

  const importedDriver = await recordsPage.evaluate(() => window.__harness.recordsImport(JSON.stringify({
    schema: 'board-race-save', selectedDriverId: 'sol', records: {
      version: 4, runs: 9, ordinaryUnlocked: true, manMedalsTotal: 6, excellentCount: 3,
      bestQualificationTime: 28.4, bestExcellentTime: 27.1, bestFlights: 8,
      bestRouteProgress: 0.7, closestMissM: 0.03, bestFlightsByDriver: { sol: 8 },
      farSeaDossierUnlocked: true, rivalWins: 2,
    },
  })));
  assert.equal(importedDriver.selectedDriverId, 'sol');
  state = await recordsPage.evaluate(() => window.__harness.recordsState());
  assert.equal(state.runs, 9);
  assert.equal(state.bestFlights, 8);
  assert.equal(state.manMedalsTotal, 6);
  assert.deepEqual(state.bestFlightsByDriver, { sol: 8 });
  assert.equal((await recordsPage.evaluate(() => window.__harness.coachState())).status, 'expert',
    'an imported expert save must update the live coach, not only the serialized record');
  await recordsPage.evaluate(() => window.__harness.setCoachEnabled(true));
  assert.equal((await recordsPage.evaluate(() => window.__harness.coachState())).status, 'active',
    'an expert may explicitly reopen contextual practice from READY');
  const invalidImport = await recordsPage.evaluate(() => {
    try {
      window.__harness.recordsImport('{"schema":"wrong","records":{}}');
      return 'accepted';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
  assert.match(invalidImport, /格式不正确/);

  const rival = await recordsPage.evaluate(() => window.__harness.rivalCase());
  assert.equal(rival.rivalIds.length, 2, 'exactly two elite rivals may receive director pacing');
  assert.ok(rival.chase.every((value) => value >= 1.044 && value <= 1.0451), `bounded chase: ${rival.chase}`);
  assert.ok(rival.release.every((value) => value >= 0.9649 && value <= 0.966), `bounded release: ${rival.release}`);
  assert.deepEqual(rival.duringLock, rival.beforeLock, 'battle hysteresis must prevent an instant pace reversal');
  assert.ok(rival.duringGrace.every((value) => Math.abs(value - 1) < 1e-6), `impact grace: ${rival.duringGrace}`);
  assert.ok(rival.afterGrace.every((value) => value > 1 && value < 1.02), `pace must ramp after grace: ${rival.afterGrace}`);
  assert.equal(rival.nonRivalPace, 1, 'non-elite racers must keep authored pace');
  await recordsContext.close();

  const enduranceContext = await browser.newContext({ viewport: { width: 844, height: 390 } });
  const endurancePage = await enduranceContext.newPage();
  await load(endurancePage);
  const endurance = await endurancePage.evaluate(() => window.__harness.enduranceCase(14));
  assert.equal(endurance.phase, 'racing');
  assert.equal(endurance.flights, 14, 'two complete seven-route cycles must remain playable');
  assert.equal(endurance.routeCursor, 14);
  assert.equal(endurance.routeSlot, 0);
  assert.equal(endurance.passes, 14);
  assert.equal(endurance.medalCount, 1, 'the qualification ceremony may run only once per attempt');
  assert.equal(endurance.finite, true);
  assert.ok(endurance.maxSpeed <= 50, `endurance velocity must remain bounded: ${endurance.maxSpeed}`);
  assert.ok(endurance.visibleRoutes <= 1, `at most one route guide may survive: ${endurance.visibleRoutes}`);
  assert.equal(endurance.resetPhase, 'ready');
  assert.equal(endurance.resetFlights, 0);
  assert.equal(endurance.resetRouteCursor, 0);
  assert.equal(endurance.resetVisibleRoutes, 0);
  await enduranceContext.close();

  console.log('records, roster, rivals, and endurance contracts: OK');
  console.log(JSON.stringify({ rival, endurance }, null, 2));
  await browser.close();
} finally {
  server.kill('SIGTERM');
}
