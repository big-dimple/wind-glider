/**
 * screenshot.mjs — deterministic screenshot harness.
 *
 * Boots the game headless via Playwright (dev server on :5199), drives it to
 * specific race moments through window.__harness (?harness=1 mode: no rAF —
 * the harness advances the fixed-step sim explicitly, so frames are
 * deterministic), and captures retina (2x) PNGs into shots/.
 *
 * Usage:
 *   node harness/screenshot.mjs                 # all scenarios
 *   node harness/screenshot.mjs hairpin water   # subset
 *   node harness/screenshot.mjs --stats         # also print perf stats
 *   node harness/screenshot.mjs --responsive ready # desktop + compact selection layouts
 *   node harness/screenshot.mjs --mobile start       # default touch controls
 *   node harness/screenshot.mjs --mobile --tilt start
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SHOT_PORT || 5199);
const BASE = `http://localhost:${PORT}/?harness=1`;
const OUT = path.join(root, 'shots');
const systemChrome = '/usr/bin/google-chrome';
const chromePath = process.env.CHROME_PATH || (existsSync(systemChrome) ? systemChrome : undefined);
let globalDpr = 2;

async function safeSetViewportSize(page, viewport) {
  // Headless Chromium rejects Playwright's setViewportSize when the window is
  // minimized / fullscreen.  Use CDP Emulation.setDeviceMetricsOverride for
  // reliable resizing.  For mobile runs we must also enable touch emulation
  // so that (pointer:coarse) media queries keep matching.
  try {
    const session = await page.context().newCDPSession(page);
    const isMobile = globalDpr === 3;
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: globalDpr,
      mobile: isMobile,
      screenWidth: viewport.width,
      screenHeight: viewport.height,
      ...(isMobile ? { screenOrientation: { angle: 90, type: 'landscapePrimary' } } : {}),
    });
    if (isMobile) {
      await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    }
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    return true;
  } catch {
    try { await page.setViewportSize(viewport); return true; } catch { return false; }
  }
}

// name → harness scenario call (+ optional freeCam before render)
const SCENARIOS = {
  ready: { scenario: 'ready' },
  countdown: { scenario: 'countdown' },
  start: { scenario: 'start' },
  'pc-primer': { scenario: 'pc-primer', settleMs: 260 },
  sweeper: { scenario: 'sweeper' },
  chicane: { scenario: 'chicane' },
  hairpin: { scenario: 'hairpin' },
  airtime: { scenario: 'airtime' },
  'drift-charge': { scenario: 'drift-charge' },
  'coach-drift': { scenario: 'coach-drift' },
  'opponent-drift': { scenario: 'opponent-drift', freeCamDynamic: { back: 6.5, up: 1.8, lookUp: 0.55, target: 'opponent' } },
  'boost-burst': { scenario: 'boost-burst', freeCamDynamic: { back: 8.5, up: 2.3, lookUp: 0.55 } },
  'flight-ready': { scenario: 'flight-ready' },
  interrupted: { scenario: 'interrupted' },
  'flight-rule': { scenario: 'flight-rule' },
  'flight-spool': { scenario: 'flight-spool', freeCamDynamic: { back: 7, up: 1.45, lookUp: 0.3 } },
  'flight-cruise': { scenario: 'flight-cruise' },
  'flight-extension-ready': { scenario: 'flight-extension-ready' },
  'flight-extension-spool': { scenario: 'flight-extension-spool' },
  'flight-extension-descent': { scenario: 'flight-extension-descent' },
  'flight-airbrake': { scenario: 'flight-airbrake' },
  'flight-route4-approach': { scenario: 'flight-route4-approach' },
  'flight-route5-prepare': { scenario: 'flight-route5-prepare' },
  'flight-route5-launch': { scenario: 'flight-route5-launch' },
  'flight-route5-turn': { scenario: 'flight-route5-turn' },
  'flight-combo': { scenario: 'flight-combo', freeCamDynamic: { back: 7, up: 1.55, lookUp: 0.4 } },
  'flight-descent': { scenario: 'flight-descent' },
  'flight-miss': { scenario: 'flight-miss', settleMs: 760 },
  'flight-no-launch': { scenario: 'flight-no-launch', settleMs: 760 },
  'retry-lesson': { scenario: 'retry-lesson', settleMs: 380 },
  'first-failure-offer': { scenario: 'first-failure-offer', settleMs: 180 },
  'flight-route': { scenario: 'flight-route' },
  'flight-recovery-air': { scenario: 'flight-recovery-air' },
  'flight-recovery-surface': { scenario: 'flight-recovery-surface' },
  'flight-spent-charge': { scenario: 'flight-spent-charge' },
  'endless-qualified': { scenario: 'endless-qualified', timeout: 180000, settleMs: 180 },
  'medal-ceremony': { scenario: 'medal-ceremony', timeout: 180000, settleMs: 180 },
  'endless-four': { scenario: 'endless-four', timeout: 180000, settleMs: 180 },
  'endless-medal-fail': { scenario: 'endless-medal-fail', timeout: 180000, settleMs: 180 },
  'final-station': { scenario: 'final-station', timeout: 180000, settleMs: 180 },
  'expansion-gallery': { scenario: 'expansion-gallery', timeout: 180000, settleMs: 180 },
  overtake: { scenario: 'overtake', settleMs: 140, freeCamDynamic: { back: 10, up: 3.2, lookUp: 0.8 } },
  'overtake-chain': { scenario: 'overtake-chain', settleMs: 140, freeCamDynamic: { back: 10, up: 3.2, lookUp: 0.8 } },
  'position-lost': { scenario: 'position-lost', freeCamDynamic: { back: 10, up: 3.2, lookUp: 0.8 } },
  // Free-camera close-ups, driven off the mid-race pack.
  rider: {
    scenario: 'sweeper',
    // placed dynamically: just astern of the player, low, rider-height
    freeCamDynamic: { back: 5.5, up: 1.9, lookUp: 1.2 },
  },
  water: {
    scenario: 'airtime',
    freeCamDynamic: { back: 26, up: 3.2, lookUp: 0 },
  },
};

async function waitForServer(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`dev server did not come up at ${url}`);
}

async function verifyFlightContract(page) {
  // A fresh page waits forever. Enter is advertised, while Space is the quiet
  // one-hand alternative; R remains retry-only.
  await assertDriverSelectComposition(page, 'desktop-1440x900');
  await verifyDesktopDriverTransition(page);
  await verifyDesktopDriverViewports(page);
  const coldStart = await page.evaluate(() => window.__harness.startGantryStatus());
  assert.equal(coldStart.canvasTextures, 0,
    `START landmark must not depend on a first-load CanvasTexture upload: ${JSON.stringify(coldStart)}`);
  assert.equal(coldStart.glyphInstances, 18,
    `START must expose every authored geometry segment before the first render: ${JSON.stringify(coldStart)}`);
  assert.equal(coldStart.checkerInstances, 48,
    `START must preserve its approach and finish checkers: ${JSON.stringify(coldStart)}`);
  let state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'ready');
  const readyPose = { x: state.playerX, z: state.playerZ, raceTime: state.raceTime, worldTime: state.worldTime };
  const readyCamera = await page.evaluate(() => window.__harness.stats());
  await page.evaluate(() => window.__harness.advance(1));
  const heldCamera = await page.evaluate(() => window.__harness.stats());
  for (const axis of ['cameraX', 'cameraY', 'cameraZ', 'cameraFov']) {
    assert.ok(Math.abs(Number(heldCamera[axis]) - Number(readyCamera[axis])) < 0.0001,
      `desktop READY camera must remain frozen on ${axis}: ${JSON.stringify({ readyCamera, heldCamera })}`);
  }
  await page.keyboard.press('KeyR');
  await page.evaluate(() => window.__harness.advance(1 / 30));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'ready', 'R must not start a fresh run');
  assert.equal(state.playerX, readyPose.x);
  assert.equal(state.playerZ, readyPose.z);
  assert.equal(state.raceTime, readyPose.raceTime);
  assert.equal(state.worldTime, readyPose.worldTime);
  await page.keyboard.down('Space');
  await page.evaluate(() => window.__harness.advance(1 / 30));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'countdown', 'Space must start the same full countdown as Enter');
  assert.equal((await page.evaluate(() => window.__harness.audioState())).scene, 'countdown');
  await page.evaluate(() => window.__harness.advance(1 / 60));
  assert.equal(await page.locator('.hud-countdown-light.on').count(), 3,
    'the countdown must begin with all three remaining lights on');
  assert.equal(await page.locator('.hud-countdown-label').textContent(), '3');
  await page.evaluate(() => window.__harness.advance(4.3));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'racing');
  assert.equal(state.flightPhase, 'surface', 'held Space may confirm READY but must never buffer a launch');
  await page.keyboard.up('Space');
  await page.evaluate(() => window.__harness.advance(0.22));
  await page.locator('.hud-pc-primer').evaluate((element) => {
    getComputedStyle(element).opacity;
    for (const animation of element.getAnimations({ subtree:true })) animation.finish();
  });
  const primer = await page.evaluate(() => {
    const element = document.querySelector('.hud-pc-primer');
    const rect = element.getBoundingClientRect();
    return {
      state:window.__harness.pcPrimerState(),
      role:element.getAttribute('role'),
      label:element.getAttribute('aria-label'),
      key:element.querySelector('.hud-pc-primer-key')?.textContent,
      title:element.querySelector('.hud-pc-primer-title')?.textContent,
      pointerEvents:getComputedStyle(element).pointerEvents,
      className:element.className,
      transform:getComputedStyle(element).transform,
      opacity:getComputedStyle(element).opacity,
      visibility:getComputedStyle(element).visibility,
      rect:{ left:rect.left, right:rect.right, top:rect.top, bottom:rect.bottom },
    };
  });
  assert.equal(primer.state.presentationStep, 'drift', 'the first fresh PC run must begin with drift, not flight inventory');
  assert.equal(primer.state.visible, true);
  assert.equal(primer.role, 'note');
  assert.equal(primer.key, 'SHIFT');
  assert.match(`${primer.title} ${primer.label}`, /SHIFT.*漂移/,
    'the first keyboard hint must make Shift drift explicit');
  assert.equal(primer.pointerEvents, 'none', 'the primer body must never intercept driving input');
  assert.ok(primer.rect.left >= 0 && primer.rect.right < 430 && primer.rect.bottom <= 900,
    `the keyboard primer must stay in the quiet lower-left lane: ${JSON.stringify(primer)}`);
  assert.equal(await page.locator('.hud-coach.on').count(), 0,
    'the first-run primer must remain non-modal and must not arm the failure coach');
  for (const viewport of [
    { width:1366, height:768 },
    { width:1920, height:1080 },
    { width:2560, height:1440 },
    { width:3440, height:1440 },
  ]) {
    if (!await safeSetViewportSize(page, viewport)) break;
    const layout = await page.evaluate(() => {
      const rect = (selector) => {
        const value = document.querySelector(selector)?.getBoundingClientRect();
        return value && { left:value.left, right:value.right, top:value.top, bottom:value.bottom };
      };
      return { primer:rect('.hud-pc-primer'), power:rect('.hud-power') };
    });
    assert.ok(layout.primer.left >= 0 && layout.primer.bottom <= viewport.height,
      `primer must remain inside ${viewport.width}x${viewport.height}: ${JSON.stringify(layout)}`);
    assert.ok(layout.primer.right + 24 < layout.power.left,
      `primer must stay clear of the bottom power HUD at ${viewport.width}x${viewport.height}: ${JSON.stringify(layout)}`);
  }
  await safeSetViewportSize(page, { width:1440, height:900 });
  await page.emulateMedia({ reducedMotion:'reduce' });
  const reducedPrimer = await page.locator('.hud-pc-primer').evaluate((element) => ({
    transform:getComputedStyle(element).transform,
    transition:getComputedStyle(element).transitionDuration,
  }));
  assert.equal(reducedPrimer.transform, 'none', 'reduced motion must remove primer movement');
  assert.match(reducedPrimer.transition, /(^|, )0s/, 'reduced motion must remove primer transitions');
  await page.emulateMedia({ reducedMotion:'no-preference' });
  const primerSequence = await page.evaluate(() => window.__harness.pcPrimerCase());
  assert.deepEqual(primerSequence.steps,
    ['drift', 'charging', 'release', 'banked', 'waiting-launch', 'launch', 'success', 'off'],
    `primer progress must follow accepted bank and launch state edges: ${JSON.stringify(primerSequence)}`);
  assert.equal(primerSequence.active, false);
  await page.locator('.hud-pc-primer-close').click();
  await page.evaluate(() => window.__harness.advance(1 / 30));
  const dismissedPrimer = await page.evaluate(() => window.__harness.pcPrimerState());
  assert.equal(dismissedPrimer.step, 'dismissed', 'the first-run hint must be dismissible immediately');
  assert.equal(dismissedPrimer.visible, false);

  await page.evaluate(() => window.__harness.scenario('countdown'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.place, 4, 'player must start fourth');
  assert.equal(state.totalRacers, 6, 'the challenge must field six racers');
  assert.equal(await page.locator('.hud-countdown-light').count(), 3);
  assert.equal(await page.locator('.hud-countdown-light.on').count(), 2,
    'the visual start rail must mirror the mid-countdown number without spoken numerals');
  assert.equal(await page.locator('.hud-countdown-label').textContent(), '2');
  await page.evaluate(() => window.__harness.advance(1.4));
  assert.equal(await page.locator('.hud-countdown-light.on').count(), 1,
    'one red lamp must remain at 1');
  assert.equal(await page.locator('.hud-countdown-label').textContent(), '1');
  await page.evaluate(() => window.__harness.advance(1.15));
  assert.equal(await page.locator('.hud-countdown-light.on').count(), 0,
    'GO releases the start with every red lamp dark');
  assert.equal(await page.locator('.hud-countdown-label').textContent(), 'GO!');

  await page.evaluate(() => window.__harness.scenario('start'));
  await page.evaluate(() => {
    window.__harness.setPlayerInput({ throttle: 1, flightTrigger: true });
    window.__harness.advance(1 / 60);
  });
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightReady, false, 'flight without a qualifying drift must not create a charge');
  assert.equal(state.flightPhase, 'surface', 'flight without a charge must stay on the surface');
  assert.equal(state.flightDenied, true, 'a rejected flight press must emit feedback');

  // Backgrounding is a hard pause. Returning requires an explicit GO and a
  // fresh full countdown before this exact run resumes.
  const interruptedRace = {
    x: state.playerX, y: state.playerY, z: state.playerZ,
    raceTime: state.raceTime, worldTime: state.worldTime,
  };
  await page.evaluate(() => window.__harness.setVisibility(true));
  await page.evaluate(() => window.__harness.advance(1));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.interruptionActive, true);
  assert.deepEqual(
    { x: state.playerX, y: state.playerY, z: state.playerZ, raceTime: state.raceTime, worldTime: state.worldTime },
    interruptedRace,
    'backgrounding must freeze the full race state',
  );
  const hiddenAudio = await page.evaluate(() => window.__harness.audioState());
  assert.equal(hiddenAudio.scene, 'hidden');
  assert.equal(hiddenAudio.outputGain, 0, 'background audio output must stop immediately');
  await page.evaluate(() => window.__harness.setVisibility(false));
  assert.equal(await page.locator('.hud-interruption').evaluate((el) => el.classList.contains('on')), true);
  await page.evaluate(() => window.__harness.advance(0.5));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.deepEqual(
    { x: state.playerX, y: state.playerY, z: state.playerZ, raceTime: state.raceTime, worldTime: state.worldTime },
    interruptedRace,
    'returning to the foreground must remain frozen before GO',
  );
  await page.keyboard.press('Space');
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'resume-countdown', 'Space must also resume a background-frozen run');
  assert.equal(state.interruptionActive, false);
  await page.evaluate(() => window.__harness.advance(2));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.deepEqual(
    { x: state.playerX, y: state.playerY, z: state.playerZ, raceTime: state.raceTime, worldTime: state.worldTime },
    interruptedRace,
    'background resume countdown must keep the race frozen',
  );
  await page.evaluate(() => window.__harness.advance(2.25));
  assert.equal((await page.evaluate(() => window.__harness.playerState())).phase, 'racing');

  // The first run is a clean skill check. Its first real failure arms a light,
  // immediately skippable coach for the next run.
  const freshCoach = await page.evaluate(() => window.__harness.coachState());
  assert.equal(freshCoach.status, 'dormant');
  assert.equal(freshCoach.automaticEligible, true);
  assert.equal(await page.locator('.hud-coach.on').count(), 0, 'the first run must add no modal spotlight tutorial');
  await page.evaluate(() => window.__harness.scenario('flight-no-launch'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'defeated');
  assert.equal(await page.locator('.hud-results').evaluate((el) => el.classList.contains('on')), false,
    'failure must bypass the old result modal');
  await page.evaluate(() => window.__harness.advance(0.6));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.retryLessonActive, true, 'failure must enter its focused review automatically');
  assert.ok(Math.abs(state.retryLessonDuration - 5) < 0.05, `failure review duration ${state.retryLessonDuration}`);
  assert.equal(state.retryLessonMinRead, 0, 'failure review must be skippable from its first frame');
  assert.equal(state.coachStatus, 'active', 'the first real failure arms the spotlight guide');
  assert.equal((await page.evaluate(() => window.__harness.coachState())).automaticEligible, false,
    'the first real failure permanently consumes the automatic invitation');
  assert.equal(await page.locator('.hud-lesson-disable:visible').count(), 1, 'first failure exposes a permanent close choice');
  assert.equal(await page.locator('.hud-lesson-continue').textContent(), '带标注再冲');
  assert.equal(await page.locator('.hud-lesson-disable').textContent(), '不用引导');
  await page.locator('.hud-lesson-continue').click();
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'ready', 'first-frame continue returns to READY, never directly to countdown');
  await page.evaluate(() => window.__harness.advance(0.5));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'ready', 'READY requires a fresh confirmation edge');

  await page.evaluate(() => {
    window.__harness.scenario('start');
    window.__harness.setCoachEnabled(true);
  });
  await page.evaluate(() => {
    for (let i = 0; i < 20 && !window.__harness.playerState().coachVisible; i++) window.__harness.advance(0.15);
  });
  await page.locator('.hud-pc-primer').evaluate((element) => {
    getComputedStyle(element).opacity;
    for (const animation of element.getAnimations({ subtree:true })) animation.finish();
  });
  await page.evaluate(() => window.__harness.advance(1 / 60));
  assert.equal((await page.evaluate(() => window.__harness.playerState())).coachVisible, true);
  const coachSpotlight = await page.evaluate(() => {
    const rect = (selector) => {
      const value = document.querySelector(selector)?.getBoundingClientRect();
      return value && { left:value.left, right:value.right, top:value.top, bottom:value.bottom };
    };
    return {
      coach:window.__harness.coachState(),
      title:document.querySelector('.hud-coach-title')?.textContent,
      control:document.querySelector('.hud-coach-control')?.textContent,
      internalControlHidden:document.querySelector('.hud-coach-control')?.hidden,
      spotlight:rect('.hud-coach-spotlight.on'),
      controlRect:rect('.hud-pc-primer-key'),
      anchorTitle:document.querySelector('.hud-pc-primer-title')?.textContent,
    };
  });
  assert.equal(coachSpotlight.coach.activeStep, 'drift', 'the first missing core action must teach PC drift');
  assert.equal(coachSpotlight.coach.focus, 'drift-control');
  assert.match(`${coachSpotlight.title} ${coachSpotlight.control}`, /SHIFT/,
    'desktop drift onboarding must make the Shift control unmistakable');
  assert.equal(coachSpotlight.internalControlHidden, true,
    'desktop drift coaching must not duplicate a fake keycap inside its annotation card');
  assert.match(coachSpotlight.anchorTitle ?? '', /SHIFT/,
    'the lower-left live anchor must carry the coached Shift action');
  assert.ok(coachSpotlight.spotlight && coachSpotlight.controlRect &&
    coachSpotlight.spotlight.left <= coachSpotlight.controlRect.left &&
    coachSpotlight.spotlight.right >= coachSpotlight.controlRect.right,
  `the spotlight must frame the live Shift keycap: ${JSON.stringify(coachSpotlight)}`);
  const chargesBeforeDismiss = (await page.evaluate(() => window.__harness.playerState())).flightCharges;
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__harness.advance(1 / 30));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.coachStatus, 'disabled', 'Escape permanently closes the spotlight guide');
  assert.equal(state.coachVisible, false);
  assert.equal(state.flightPhase, 'surface', 'closing a hint cannot buffer or trigger flight');
  assert.equal(state.flightCharges, chargesBeforeDismiss);

  await page.evaluate(() => window.__harness.scenario('start'));
  await page.evaluate(() => window.__harness.advance(0.2));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.coachStatus, 'disabled');
  assert.equal(state.coachVisible, false);
  await page.evaluate(() => window.__harness.setCoachEnabled(true));
  await page.evaluate(() => {
    for (let i = 0; i < 20 && !window.__harness.playerState().coachVisible; i++) window.__harness.advance(0.15);
  });
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.coachStatus, 'active');
  assert.notEqual(state.coachStep, 'none', 'READY help can re-enable the remaining spotlight curriculum');

  // Surface abandonment uses the same terminal pipeline as a flight miss. A
  // brief collision excursion gets a recovery window, but sustained departure
  // or deliberate reverse driving cannot continue forever in open water.
  await page.evaluate(() => window.__harness.scenario('surface-off-course-grace'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'racing', 'a sub-0.8s course-edge excursion must remain recoverable');
  assert.equal(state.courseWarning, 'none', 'returning to the circuit must clear the course warning');

  await page.evaluate(() => window.__harness.scenario('surface-off-course'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'defeated', 'sustained surface course abandonment must be terminal');
  assert.equal(state.challengeReason, 'off_course');
  assert.equal(state.flightFailureTargetGateRaw, null,
    'surface course abandonment must not invent a portal target');
  assert.equal(state.challengeGate, 0,
    'surface course abandonment is not a gate result');
  assert.equal(state.flightFailureLateralOffsetM, null);
  assert.equal(state.flightFailureLateralLimitM, null);
  assert.ok((state.flightFailureCorridorDistanceM ?? 0) >= 42,
    `surface abandonment must retain its route distance evidence: ${JSON.stringify(state)}`);
  await page.evaluate(() => window.__harness.advance(0.6));
  assert.match(await page.locator('.hud-lesson-title').textContent() ?? '', /偏离绿色主线/);
  assert.equal(await page.locator('.hud-lesson-disable:visible').textContent(), '不用引导',
    'every failure while the guide is active must retain a direct opt-out');

  await page.evaluate(() => window.__harness.scenario('surface-wrong-way'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'defeated', 'sustained reverse driving must be terminal');
  assert.equal(state.challengeReason, 'wrong_way');
  assert.equal(state.flightFailureTargetGateRaw, null,
    'surface reverse must not invent a portal target');
  assert.equal(state.challengeGate, 0,
    'surface reverse is not a gate result');
  assert.equal(state.flightFailureLateralOffsetM, null);
  assert.equal(state.flightFailureLateralLimitM, null);
  assert.equal(state.flightFailureCorridorDistanceM, null,
    'reverse evidence must not be mislabeled as a corridor distance');

  const surfaceEnforcement = await page.evaluate(() => window.__harness.surfaceRouteEnforcementCase());
  assert.equal(surfaceEnforcement.cut.finalStationArmed, false,
    `surface route enforcement must run before Final is armed: ${JSON.stringify(surfaceEnforcement)}`);
  assert.equal(surfaceEnforcement.cut.flightRouteState, 'idle',
    'the second-flight shortcut fixture must remain a surface-route case');
  assert.equal(surfaceEnforcement.cut.phase, 'defeated',
    `crossing continuously from flight two to a non-adjacent green segment must be terminal: ${JSON.stringify(surfaceEnforcement)}`);
  assert.equal(surfaceEnforcement.cut.reason, 'off_course');
  assert.ok(surfaceEnforcement.cut.warningFrames > 0,
    `a cross-course cut must present a stable correction before defeat: ${JSON.stringify(surfaceEnforcement)}`);
  assert.ok(surfaceEnforcement.cut.travelled < surfaceEnforcement.cut.distance,
    `the route cut must fail before reaching and adopting the later segment: ${JSON.stringify(surfaceEnforcement)}`);
  assert.equal(surfaceEnforcement.cut.checkpointDelta, 0,
    'an illegal projection switch must not emit checkpoint events');
  assert.equal(surfaceEnforcement.facing.finalStationArmed, false);
  assert.equal(surfaceEnforcement.facing.phase, 'racing',
    'the wrong-way banner must appear before its longer terminal window');
  assert.equal(surfaceEnforcement.facing.warning, 'wrong_way',
    `a visibly reversed hull must stay warned while inertia still slides forward: ${JSON.stringify(surfaceEnforcement)}`);
  assert.ok(surfaceEnforcement.facing.warningFrame >= 40 && surfaceEnforcement.facing.warningFrame <= 46,
    `wrong-way onset must remain near the authored 0.7s hold: ${JSON.stringify(surfaceEnforcement)}`);

  await page.evaluate(() => window.__harness.scenario('surface-flight-off-course'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'defeated');
  assert.equal(state.challengeReason, 'off_course',
    'being beyond the green-route hard edge must not be mislabeled as a missed launch');
  assert.equal(state.flightFailureTargetGateRaw, null);
  assert.equal(state.challengeGate, 0);

  await page.evaluate(() => window.__harness.scenario('flight-ready'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightReady, true, 'a qualifying Shift release must earn a flight charge');
  assert.equal(state.flightPhase, 'surface');
  assert.match(await page.locator('.hud-flight-prompt').textContent() ?? '', /SPACE.*起飞/,
    'earned-flight prompt must use the new Space mapping');
  const promptGeometry = await page.locator('.hud-flight-prompt').evaluate((prompt) => {
    const key = prompt.querySelector('.hud-keycap').getBoundingClientRect();
    const copy = prompt.querySelector('.hud-flight-prompt-copy').getBoundingClientRect();
    return { keyWidth: key.width, keyScrollWidth: prompt.querySelector('.hud-keycap').scrollWidth, keyRight: key.right, copyLeft: copy.left };
  });
  assert.ok(promptGeometry.keyWidth >= 64, `SPACE key cap collapsed to ${promptGeometry.keyWidth}px`);
  assert.ok(promptGeometry.keyScrollWidth <= promptGeometry.keyWidth + 1, 'SPACE text must not overflow its key cap');
  assert.ok(promptGeometry.keyRight <= promptGeometry.copyLeft, 'SPACE key cap must not overlap the flight copy');
  const promptOverlaps = await page.evaluate(() => {
    const prompt = document.querySelector('.hud-flight-prompt.on')?.getBoundingClientRect();
    if (!prompt) return ['missing flight prompt'];
    const selectors = ['.race-tower.on', '.hud-topleft', '.audio-mixer.visible'];
    return selectors.flatMap((selector) => {
      const node = document.querySelector(selector);
      if (!node) return [];
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return [];
      const rect = node.getBoundingClientRect();
      const width = Math.min(prompt.right, rect.right) - Math.max(prompt.left, rect.left);
      const height = Math.min(prompt.bottom, rect.bottom) - Math.max(prompt.top, rect.top);
      return width > 1 && height > 1 ? [`${selector}:${width.toFixed(1)}x${height.toFixed(1)}`] : [];
    });
  });
  assert.deepEqual(promptOverlaps, [], `flight prompt overlap: ${promptOverlaps.join(', ')}`);

  await page.evaluate(() => window.__harness.scenario('drift-charge'));
  const driftAudio = await page.evaluate(() => window.__harness.audioState());
  assert.ok(Number(driftAudio.driftTier) >= 1, `a real drift must cross a readable charge tier: ${JSON.stringify(driftAudio)}`);

  // Drift qualification is short and explicit: a tap remains invalid, while a
  // deliberate ~0.35s hold reaches the shared release-ready state.
  await page.evaluate(() => {
    window.__harness.scenario('start');
    window.__harness.setPlayerInput({ throttle: 1, drift: true });
    window.__harness.advance(0.29);
  });
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.driftReleaseReady, false, 'a short drift tap must not earn flight');
  await page.evaluate(() => window.__harness.advance(0.08));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.driftReleaseReady, true, 'the release threshold must be readable by about 0.35s');
  assert.equal(await page.locator('.hud-boost').evaluate((el) => el.classList.contains('release-ready')), true);
  await page.evaluate(() => {
    window.__harness.setPlayerInput({ throttle: 1 });
    window.__harness.advance(1 / 30);
  });
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightCharges, 1, 'releasing after the threshold must earn exactly one charge');

  // Each distinct release earns one launch, capped at two. Full storage may
  // still pay a normal boost, and one launch must consume only one cell.
  await page.evaluate(() => window.__harness.earnFlight(false));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightCharges, 2, 'a second qualifying drift must fill the second launch cell');
  await page.evaluate(() => window.__harness.earnFlight(false));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightCharges, 2, 'flight storage must hard-cap at two');
  assert.equal(state.boosting, true, 'a full magazine must not suppress the drift boost payout');
  await page.evaluate(() => window.__harness.tapFlight());
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightCharges, 1, 'one launch must consume exactly one stored charge');
  assert.notEqual(state.flightPhase, 'surface');

  await page.evaluate(() => window.__harness.scenario('opponent-drift'));
  const opponentFx = await page.evaluate(() => window.__harness.opponentFx());
  assert.ok(opponentFx.drifting >= 1, `at least one opponent must visibly use a real drift input: ${JSON.stringify(opponentFx)}`);
  assert.ok(opponentFx.emissions >= 2, `opponent drift must emit a readable two-sided world effect: ${JSON.stringify(opponentFx)}`);
  assert.ok(opponentFx.minScale >= 0.3 && opponentFx.maxScale <= 1,
    `opponent drift FX must remain inside its distance LOD: ${JSON.stringify(opponentFx)}`);

  await page.evaluate(() => window.__harness.scenario('flight-combo'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightReady, false, 'launch must consume the charge');
  assert.equal(state.boosting, true, 'drift boost must survive a same-frame flight launch');
  assert.notEqual(state.flightPhase, 'surface', 'same-frame drift release + flight must launch');

  await page.evaluate(() => {
    window.__harness.scenario('start');
    window.__harness.earnFlight(false);
    window.__harness.earnFlight(false);
    window.__harness.setPlayerInput({ throttle: 1, drift: true });
    window.__harness.advance(0.62);
    window.__harness.setPlayerInput({ throttle: 1, flightTrigger: true });
    window.__harness.advance(1 / 60);
    window.__harness.setPlayerInput(null);
  });
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightCharges, 1,
    'full storage + same-frame qualifying release/launch must remain at one after spending');

  await page.evaluate(() => window.__harness.scenario('flight-cruise'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightPhase, 'cruise');
  assert.ok(state.flightClearance > 4 && state.flightClearance < 6.5, `cruise clearance ${state.flightClearance}`);
  assert.ok(state.flightRemaining > 0 && state.flightRemaining < 1);
  assert.ok(state.speed >= 40 && state.speed <= 43, `first flight cruise speed ${state.speed}`);
  assert.ok(state.flightPressure > 0.25, `flight pressure ${state.flightPressure}`);
  assert.equal((await page.evaluate(() => window.__harness.audioState())).scene, 'flight');
  assert.ok(state.flightFxRings >= 8, `controlled flight must open the vortex rings: ${state.flightFxRings}`);
  assert.ok(state.flightFxPlumeLength < 2.8, `flight core must remain a short plume, not a beam: ${state.flightFxPlumeLength}`);
  const flightStats = await page.evaluate(() => window.__harness.stats());
  assert.ok(flightStats.cameraFov >= 77 && flightStats.cameraFov <= 86, `flight FOV ${flightStats.cameraFov}`);
  const guidance = await page.evaluate(() => window.__harness.guidance());
  assert.equal(guidance.visibleRouteCount, 1, 'only the current player flight guide may be visible');
  assert.equal(guidance.activeRouteIndex, 0);
  assert.equal(guidance.surfaceMaskRouteIndex, 0, 'the green surface ribbon must be masked through the active detour');
  assert.ok(guidance.targetGateDistance > 0, `the unique target gate must expose a real distance: ${JSON.stringify(guidance)}`);
  assert.ok(guidance.targetAnchorScale >= 1 && guidance.targetAnchorScale <= 1.75,
    `the visual locator must stay bounded: ${JSON.stringify(guidance)}`);

  // The spare stored cell becomes a deliberate airborne extension. It must
  // reject launch double-taps, become explicit at cruise, consume exactly one
  // cell, increase remaining airtime, and refuse any second extension.
  await page.evaluate(() => window.__harness.scenario('flight-extension-spool'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightCharges, 1, 'a second press during spool/ascending must not consume the spare cell');
  assert.equal(state.flightExtensionUsed, false);
  assert.equal(state.flightDenied, true, 'an early double-tap needs explicit rejection feedback');

  await page.evaluate(() => window.__harness.scenario('flight-extension-ready'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightPhase, 'cruise');
  assert.equal(state.flightCharges, 1);
  assert.equal(state.flightExtensionReady, true);
  assert.equal(state.flightExtensionUsed, false);
  assert.match(await page.locator('.hud-flight-prompt').textContent() ?? '', /SPACE.*续航.*\+2\.4/,
    'desktop HUD must make the airborne use of the spare cell explicit');
  const remainingBeforeExtension = state.flightRemaining;
  const routeProgressBeforeExtension = state.flightGateProgress;
  const audioExtensionsBefore = Number((await page.evaluate(() => window.__harness.audioState())).flightExtendEvents);
  await page.evaluate(() => window.__harness.tapFlight());
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightExtended, true, 'the accepted Space edge must expose a one-frame extension pulse');
  assert.equal(state.flightCharges, 0, 'airborne extension consumes exactly one stored cell');
  assert.equal(state.flightExtensionUsed, true);
  assert.equal(state.flightExtensionReady, false);
  assert.equal(state.flightPhase, 'cruise');
  assert.ok(state.flightRemaining > remainingBeforeExtension,
    `extension must add real envelope time: ${remainingBeforeExtension} -> ${state.flightRemaining}`);
  assert.equal(state.flightGateProgress, routeProgressBeforeExtension, 'extension must never reset portal progress');
  assert.equal(Number((await page.evaluate(() => window.__harness.audioState())).flightExtendEvents), audioExtensionsBefore + 1,
    'accepted extension needs exactly one dedicated sound event');
  await page.evaluate(() => window.__harness.tapFlight());
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightDenied, true, 'a current flight can be extended at most once');
  assert.equal(state.flightExtensionUsed, true);

  await page.evaluate(() => window.__harness.scenario('flight-extension-descent'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightPhase, 'descending');
  assert.equal(state.flightExtensionReady, true, 'a spare cell must remain usable during descent');
  const descentClearance = state.flightClearance;
  const descentRemaining = state.flightRemaining;
  await page.evaluate(() => window.__harness.tapFlight());
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightPhase, 'cruise', 'late extension must return to the cruise envelope without teleporting');
  assert.equal(state.flightCharges, 0);
  assert.equal(state.flightExtensionUsed, true);
  assert.ok(state.flightRemaining > descentRemaining, 'late extension must add real remaining time');
  assert.ok(Math.abs(state.flightClearance - descentClearance) < 0.5,
    `late extension may arrest descent but must never snap altitude: ${descentClearance} -> ${state.flightClearance}`);

  const budget = await page.evaluate(() => window.__harness.flightBudgetCase());
  assert.ok(Math.abs(budget.envelope.descendAt - 5.7) < 0.001, `flight descent envelope ${JSON.stringify(budget.envelope)}`);
  assert.ok(Math.abs(budget.envelope.total - 6.45) < 0.001, `flight total envelope ${JSON.stringify(budget.envelope)}`);
  assert.ok(Math.abs(budget.envelope.extension - 2.4) < 0.001, `flight extension ${JSON.stringify(budget.envelope)}`);
  assert.ok(Math.abs(budget.envelope.extendedDescendAt - 8.1) < 0.001,
    `extended descent envelope ${JSON.stringify(budget.envelope)}`);
  assert.ok(Math.abs(budget.envelope.extendedTotal - 8.85) < 0.001,
    `extended total envelope ${JSON.stringify(budget.envelope)}`);
  assert.equal(budget.routes.length, 7);
  for (const route of budget.routes) {
    assert.ok(route.earliestToGate >= 140 && route.earliestToGate <= 152,
      `route ${route.index + 1} launch budget must stay comparable: ${JSON.stringify(route)}`);
    assert.ok(route.latestToGate > 75 && route.latestToGate < route.earliestToGate,
      `route ${route.index + 1} latest launch must retain a real approach: ${JSON.stringify(route)}`);
    assert.ok(route.secondsAt29 <= 5.2,
      `route ${route.index + 1} must pass before descent at sustained air-brake speed: ${JSON.stringify(route)}`);
    assert.ok(route.gateToExit >= 30,
      `route ${route.index + 1} must leave enough authored landing distance: ${JSON.stringify(route)}`);
  }
  // The old helper stopped three frames after the portal and teleported into
  // the next setup. These cases stage once, then preserve the real velocity
  // through descent, water contact, authored recovery and surface handoff.
  for (let route = 3; route < 7; route++) {
    await page.evaluate(() => window.__harness.scenario('start'));
    const recovery = await page.evaluate((index) => window.__harness.flightRecoveryCase(index), route);
    assert.equal(recovery.phase, 'racing', `flight ${route + 1} recovery must not defeat a valid line: ${JSON.stringify(recovery)}`);
    assert.equal(recovery.routeState, 'idle', `flight ${route + 1} must hand back to the surface route: ${JSON.stringify(recovery)}`);
    assert.equal(recovery.sawPassed, true);
    assert.equal(recovery.sawSurfaceRecovery, true, `flight ${route + 1} must retain ownership after water contact`);
    assert.equal(recovery.handoffCount, 1, `flight ${route + 1} route ownership must switch exactly once`);
    assert.equal(recovery.warningFrames, 0, `flight ${route + 1} inertia must not pre-arm a course warning`);
    assert.equal(recovery.routePasses, 1);
    assert.equal(recovery.routeFails, 0);
    assert.ok(recovery.maxVisibleRoutes <= 1, `only one player-owned guide may render: ${JSON.stringify(recovery)}`);
    assert.equal(recovery.sawRecoveryGuide, true, `flight ${route + 1} must switch to the recovery visual grammar`);
    assert.ok(recovery.maxRecoveryArrows >= 2, `flight ${route + 1} must expose directional recovery markers: ${JSON.stringify(recovery)}`);
    assert.ok(recovery.maxStep < 1.5, `flight ${route + 1} must never teleport during recovery: ${JSON.stringify(recovery)}`);
    assert.ok(recovery.minPlanarSpeed > 3, `flight ${route + 1} must preserve planar inertia: ${JSON.stringify(recovery)}`);
    assert.ok(recovery.minProgressDelta > -2, `flight ${route + 1} merge must not jump progress backwards: ${JSON.stringify(recovery)}`);
  }

  const medalRecovery = await page.evaluate(() => window.__harness.medalRecoveryCase());
  assert.equal(medalRecovery.phaseAtPass, 'medal',
    `the third portal must enter the medal freeze before recovery resumes: ${JSON.stringify(medalRecovery)}`);
  assert.equal(medalRecovery.phase, 'racing',
    `a delayed but valid left correction after the medal must remain playable: ${JSON.stringify(medalRecovery)}`);
  assert.equal(medalRecovery.routeState, 'idle');
  assert.equal(medalRecovery.flightPhase, 'surface');
  assert.equal(medalRecovery.flightsCleared, 3);
  assert.ok(medalRecovery.freezePositionDelta < 0.001,
    `medal and resume countdown must freeze the hull: ${JSON.stringify(medalRecovery)}`);
  assert.ok(Math.abs(medalRecovery.freezeWorldDelta) < 0.001);
  assert.ok(Math.abs(medalRecovery.freezeRaceDelta) < 0.001);
  assert.ok(Math.abs(medalRecovery.freezeRecoveryDelta) < 0.001);
  assert.equal(medalRecovery.sawSurfaceRecovery, true,
    'the third branch must retain ownership after touching water');
  assert.equal(medalRecovery.sawRouteFourPreview, true,
    'first water contact after flight three must hand the single visual guide to flight four');
  assert.ok(medalRecovery.routeFourPreviewLeadSeconds >= 1.8,
    `flight four needs a conservative pre-launch read window through the swell: ${JSON.stringify(medalRecovery)}`);
  assert.equal(medalRecovery.handoffCount, 1,
    'the third branch must hand navigation to the surface exactly once');
  assert.equal(medalRecovery.warningFrames, 0,
    `valid third-flight inertia must not flash an off-course banner: ${JSON.stringify(medalRecovery)}`);
  assert.equal(medalRecovery.warningEvents, 0,
    'a visually suppressed warning must not still emit warning haptics');
  assert.ok(medalRecovery.maxVisibleRoutes <= 1);
  assert.ok(medalRecovery.maxStep < 1.5,
    `medal recovery must preserve continuous motion without teleporting: ${JSON.stringify(medalRecovery)}`);
  assert.equal(medalRecovery.routePasses, 1);
  assert.equal(medalRecovery.routeFails, 0);
  assert.equal(medalRecovery.finalArmed, false,
    'third-flight recovery must never borrow the Final free-route exemption');

  const route45 = await page.evaluate(() => window.__harness.route45ContinuousCase());
  assert.equal(route45.phase, 'racing', `the fourth-to-fifth journey must remain live: ${JSON.stringify(route45)}`);
  assert.equal(route45.flightsCleared, 5, `both gates must be earned without restaging: ${JSON.stringify(route45)}`);
  assert.equal(route45.routePasses, 2);
  assert.equal(route45.routeFails, 0);
  assert.equal(route45.sawRouteFourPassed, true);
  assert.equal(route45.sawRouteFourSurfaceRecovery, true,
    'flight four must really land before the fifth-flight preparation window');
  assert.equal(route45.sawRouteFourHandoff, true,
    'the fifth-flight cue may not skip the authored recovery ownership');
  assert.equal(route45.sawBankCue, true, 'the green line must expose drift preparation before flight five');
  assert.equal(route45.sawLaunchCue, true, 'the same line must hand emphasis to launch after a real bank');
  assert.ok(route45.cueLeadSeconds >= 1.2,
    `route guidance needs a human reaction window before launch: ${JSON.stringify(route45)}`);
  assert.ok(route45.routeFiveChargeEdges >= 1,
    `flight five must be earned through a real drift release: ${JSON.stringify(route45)}`);
  assert.ok(route45.airBrakeLatencySeconds >= 0 && route45.airBrakeLatencySeconds <= 0.35,
    `air brake must engage promptly after the real fifth launch: ${JSON.stringify(route45)}`);
  assert.equal(route45.warningFrames, 0);
  assert.ok(route45.maxVisibleRoutes <= 1);
  assert.ok(route45.maxStep < 1.5, `continuous route four-to-five motion may not teleport: ${JSON.stringify(route45)}`);
  assert.equal(route45.finalArmed, false, 'flight-five guidance must not borrow Final state');

  // Seventh-flight certification changes the objective atomically: the
  // authored recovery still plays, then the green route becomes optional and
  // only the visible gold portal can finish the run.
  const finalApproach = await page.evaluate(() => window.__harness.finalApproachCase());
  assert.equal(finalApproach.armedAtPass, true, `seventh pass must arm Final immediately: ${JSON.stringify(finalApproach)}`);
  assert.equal(finalApproach.phaseAfterExcursion, 'racing', 'free Final approach must not be defeated off-route');
  assert.equal(finalApproach.routeStateAfterExcursion, 'idle');
  assert.equal(finalApproach.flightPhaseAfterExcursion, 'surface');
  assert.equal(finalApproach.sawSurfaceRecovery, true, 'route seven must retain recovery ownership through water contact');
  assert.equal(finalApproach.sawHandoff, true, 'route seven must hand off before free approach');
  assert.ok(finalApproach.recoveryFrames > 0);
  assert.ok(finalApproach.maxRouteDistance >= 48,
    `the contract must actually leave the old 42m fail corridor: ${JSON.stringify(finalApproach)}`);
  assert.equal(finalApproach.warningFrames, 0, 'Final approach must never emit route warnings');
  assert.equal(finalApproach.warningAfterExcursion, 'none');
  assert.ok(finalApproach.maxStep < 1.5, `the continuous gate-to-excursion path must not teleport: ${JSON.stringify(finalApproach)}`);
  assert.ok(finalApproach.progressDrift < 0.001,
    `off-route projection must not manufacture place progress: ${JSON.stringify(finalApproach)}`);
  assert.equal(finalApproach.routePasses, 1);
  assert.equal(finalApproach.routeFails, 0);
  assert.equal(finalApproach.finalGuideCount, 1, 'Final must expose one authoritative target');
  assert.equal(finalApproach.visibleRouteCount, 0, 'flight seven must not remain as a stale branch after handoff');
  assert.equal(finalApproach.activeRouteIndex, -1);
  assert.ok(finalApproach.maxBrakeEnvelope >= 0.9,
    `Final Shift must engage the return-brake envelope: ${JSON.stringify(finalApproach)}`);
  assert.ok(finalApproach.speedAfterBrake <= 20 && finalApproach.speedAfterBrake < finalApproach.speedBeforeBrake - 6,
    `the return brake must settle near its 18m/s target: ${JSON.stringify(finalApproach)}`);
  assert.ok(finalApproach.speedAfterBrakeRelease > finalApproach.speedAfterBrake + 4,
    `releasing Final brake must restore automatic throttle: ${JSON.stringify(finalApproach)}`);
  assert.ok(finalApproach.minBrakeSpeed >= 0, 'Final return braking must never select reverse');
  assert.ok(finalApproach.brakeHeadingDelta >= 0.45,
    `return braking must provide enough authority to recover around the portal: ${JSON.stringify(finalApproach)}`);
  assert.equal(finalApproach.chargesAfterBrake, finalApproach.chargesBeforeBrake,
    'Final braking must not earn or spend a flight cell');
  assert.equal(finalApproach.boostChargeAfterBrake, finalApproach.boostChargeBeforeBrake,
    'Final braking must not charge a drift payout');
  assert.equal(finalApproach.driftingAfterBrake, false);
  assert.equal(finalApproach.boostingAfterBrake, false);
  assert.ok(finalApproach.brakeEnvelopeAfterRelease < 0.02,
    'the return brake envelope must fully release back to automatic drive');
  assert.equal(finalApproach.outsidePhase, 'racing', 'passing outside a gold column is retryable, not terminal');
  assert.equal(finalApproach.outsideWarning, 'none');
  assert.equal(finalApproach.finishedPhase, 'finished', 'a reverse-side pass through the visible portal must finish');
  assert.deepEqual(finalApproach.geometry, {
    centerForward: true,
    centerReverse: true,
    insideLeft: true,
    insideRight: true,
    outsideLeft: false,
    outsideRight: false,
    highSpeedSweep: true,
    teleportRejected: false,
  });

  await page.evaluate(() => window.__harness.scenario('start'));
  for (let route = 0; route < 7; route++) {
    await page.evaluate((index) => window.__harness.passFlight(index, 1, true), route);
    state = await page.evaluate(() => window.__harness.playerState());
    assert.equal(state.flightRouteState, 'passed', `route ${route + 1} must pass under continuous air brake`);
    if (state.phase === 'medal') {
      await page.evaluate(() => window.__harness.advance(8.9));
    }
  }
  await page.evaluate(() => window.__harness.passExtendedFlight(2, true));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightRouteState, 'passed',
    `third flight must support early launch + airborne extension + continuous air brake: ${JSON.stringify(state)}`);
  assert.equal(state.flightExtensionUsed, true);
  assert.equal(state.flightCharges, 0);

  await page.evaluate(() => window.__harness.passFlight(0, 2, true));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightRouteState, 'passed');
  assert.equal(state.flightCharges, 1, 'a clean gate keeps the unspent spare cell');
  await page.evaluate(() => window.__harness.tapFlight());
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightDenied, true, 'a passed gate must reject extension instead of prolonging its landing');
  assert.equal(state.flightCharges, 1, 'a rejected post-gate press must not consume the spare cell');
  assert.equal(state.flightExtensionUsed, false);

  await page.evaluate(() => window.__harness.scenario('flight-descent'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightPhase, 'descending');
  await page.evaluate(() => window.__harness.advance(0.9));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightPhase, 'surface', `flight must settle back onto the water: ${JSON.stringify(state)}`);
  assert.equal(state.flightReady, false, 'a spent charge must not silently re-arm');

  await page.evaluate(() => window.__harness.scenario('flight-route'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightRouteState, 'passed', `authored route must be completable: ${JSON.stringify(state)}`);
  assert.equal(state.flightGateProgress, 1, 'each flight has one scoring portal');
  assert.equal(state.flightsCleared, 1, 'the first route advances only one of three flights');
  assert.equal(state.phase, 'racing', 'the first flight must not finish the challenge');
  assert.equal(state.routePasses, 1);

  await page.evaluate(() => window.__harness.scenario('flight-spent-charge'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightsCleared, 1);
  assert.equal(state.flightPhase, 'surface');
  assert.equal(state.flightReady, false, 'a completed flight cannot preserve an already spent charge');
  assert.equal(state.flightDenied, true, 'another launch requires a stored drift charge');

  await page.evaluate(() => {
    window.__harness.scenario('start');
    window.__harness.earnFlight(false);
    window.__harness.earnFlight(false);
    window.__harness.passFlight(0, 2);
  });
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightCharges, 1, 'an unused second charge must survive a clean route and landing envelope');

  await page.evaluate(() => window.__harness.scenario('flight-miss'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightRouteState, 'failed', 'abandoning a mandatory pylon gate must fail the attempt');
  assert.equal(state.phase, 'defeated', 'a missed pylon is an immediate terminal result');
  assert.ok(['corridor', 'gate', 'gate_left', 'gate_right'].includes(state.flightRouteFailReason),
    `expected a gate miss, got ${state.flightRouteFailReason}`);
  assert.equal(state.flightFailureNumber, 1, 'failure evidence must identify the flight segment');
  const routeLevelReasons = ['no_launch', 'corridor', 'landing', 'exit', 'teleport'];
  if (routeLevelReasons.includes(state.flightRouteFailReason)) {
    assert.equal(state.flightFailureTargetGateRaw, null, 'a route-level miss has no fake portal target');
    assert.equal(state.challengeGate, 0, 'a route-level miss is not a gate result');
  } else {
    assert.equal(state.flightFailureTargetGateRaw, 1, `portal misses must identify the scoring gate: ${JSON.stringify(state)}`);
    assert.equal(state.challengeGate, 1);
  }
  assert.equal(state.routeFails, 1, 'a failed attempt must resolve exactly once');
  if (state.flightRouteFailReason === 'corridor') {
    await page.evaluate(() => window.__harness.advance(0.6));
    assert.match(await page.locator('.hud-lesson-metric').textContent() ?? '', /悬空通道偏离/,
      'aerial corridor review must identify the cyan flight channel');
  }

  await page.evaluate(() => window.__harness.scenario('flight-landing-failure'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'defeated');
  assert.equal(state.flightRouteFailReason, 'landing',
    'descent on an uncleared route must be classified as early landing before corridor drift');
  assert.equal(state.flightFailureTargetGateRaw, null);
  assert.equal(state.challengeGate, 0);
  await page.evaluate(() => window.__harness.advance(0.6));
  assert.match(await page.locator('.hud-lesson-title').textContent() ?? '', /提前落水/);
  assert.match(await page.locator('.hud-lesson-metric').textContent() ?? '', /当前高度/,
    'landing review must expose landing evidence instead of corridor copy');

  await page.evaluate(() => window.__harness.scenario('flight-airbrake'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.ok(state.flightFxDeflection > 0.12, `air-brake must visibly deform the airflow: ${state.flightFxDeflection}`);
  assert.ok(state.flightAirBrake > 0.7, `air brake envelope must attack immediately: ${state.flightAirBrake}`);

  let routeGuidance = await page.evaluate(() => window.__harness.guidance());
  assert.equal(routeGuidance.actionCue, 'turn');
  assert.equal(routeGuidance.actionRouteIndex, 1);
  assert.equal(routeGuidance.actionDirection, 'left');
  assert.equal(routeGuidance.actionMarkerCount, 3,
    'the second-flight bend must use the same three-chevron route language');

  await page.evaluate(() => window.__harness.scenario('flight-route4-approach'));
  routeGuidance = await page.evaluate(() => window.__harness.guidance());
  assert.equal(routeGuidance.actionCue, 'turn');
  assert.equal(routeGuidance.actionRouteIndex, 3);
  assert.equal(routeGuidance.actionDirection, 'left');
  assert.equal(routeGuidance.actionMarkerCount, 3,
    'the wave-obscured fourth-flight bend must announce itself on the flight ribbon');
  assert.equal(routeGuidance.visibleRouteCount, 1,
    'fourth-flight chevrons must remain part of the single player-owned branch');

  await page.evaluate(() => window.__harness.scenario('flight-route5-prepare'));
  routeGuidance = await page.evaluate(() => window.__harness.guidance());
  assert.equal(routeGuidance.actionCue, 'bank');
  assert.equal(routeGuidance.actionRouteIndex, 4);
  assert.equal(routeGuidance.actionDirection, 'none');
  assert.equal(routeGuidance.actionMarkerCount, 3,
    'the fifth-flight approach must expose three wave-following drift chevrons');
  assert.ok(routeGuidance.actionTargetU < 0.616,
    `drift guidance must appear before the launch window: ${JSON.stringify(routeGuidance)}`);

  await page.evaluate(() => window.__harness.scenario('flight-route5-launch'));
  routeGuidance = await page.evaluate(() => window.__harness.guidance());
  assert.equal(routeGuidance.actionCue, 'launch');
  assert.equal(routeGuidance.actionRouteIndex, 4);
  assert.equal(routeGuidance.actionMarkerCount, 2,
    'a stored charge must transfer emphasis to the two cyan launch beats');

  await page.evaluate(() => window.__harness.scenario('flight-route5-turn'));
  routeGuidance = await page.evaluate(() => window.__harness.guidance());
  assert.equal(routeGuidance.actionCue, 'turn');
  assert.equal(routeGuidance.actionDirection, 'right');
  assert.equal(routeGuidance.actionMarkerCount, 3,
    'the hardest bend must retain three supported marine chevrons');
  assert.equal(routeGuidance.visibleRouteCount, 1,
    'route action markers must not manufacture a second flight branch');
  const routeFiveWarning = await page.locator('.hud-turn-warning').textContent() ?? '';
  assert.match(routeFiveWarning, /急右航道/);
  assert.match(routeFiveWarning, /SHIFT/);
  assert.match(routeFiveWarning, /→/);
  assert.doesNotMatch(routeFiveWarning, /A\s*\/\s*D/,
    'the right-turn combo must not ask players to translate a generic A/D label');

  await page.evaluate(() => window.__harness.scenario('overtake'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.battleOvertakes, 1);
  assert.equal(state.lastBattleKind, 'overtake');
  await assertBattleFeedbackVisible(page, 'overtake-desktop');
  await assertBattleLeavesDrivingRoiClear(page, 'overtake-desktop');
  const vp = { label: 'overtake-landscape', width: 844, height: 390 };
  await safeSetViewportSize(page, { width: vp.width, height: vp.height });
  await page.waitForTimeout(120);
  await page.evaluate(() => window.__harness.render());
  await assertBattleFeedbackVisible(page, vp.label);
  await assertBattleLeavesDrivingRoiClear(page, vp.label);
  await safeSetViewportSize(page, { width: 1440, height: 900 });
  await page.waitForTimeout(120);

  await page.evaluate(() => window.__harness.scenario('overtake-chain'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.battleOvertakes, 2);
  assert.equal(state.lastBattleStreak, 2);

  await page.evaluate(() => window.__harness.scenario('position-lost'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.battlePositionLosses, 1);
  assert.equal(state.lastBattleKind, 'lost');

  const medalsBefore = state.manMedalsTotal;
  await page.evaluate(() => {
    window.__harness.scenario('start');
    window.__harness.passFlight(0);
    window.__harness.passFlight(1);
    window.__harness.passFlight(2, 2);
  });
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'medal', 'the third flight must enter the medal ceremony');
  assert.equal(state.flightsCleared, 3);
  assert.notEqual(state.challengeTier, 'unqualified');
  assert.equal(state.flightCharges, 1, 'the spare launch charge must survive the medal freeze');
  assert.equal(state.manMedalsTotal, medalsBefore + 1, 'the third flight grants exactly one medal in the run');
  assert.equal(await page.locator('.hud-medal-ceremony').evaluate((el) => el.classList.contains('on')), true);
  assert.equal(await page.locator('.hud-medal-title').textContent(), '猛男');
  assert.match(await page.locator('.hud-medal-count').textContent() ?? '', /男人勋章 \+1/,
    'the ceremonial title may evolve, but the earned reward must stay explicit');
  assert.equal((await page.evaluate(() => window.__harness.audioState())).scene, 'medal',
    'the qualification frame must not overwrite the medal music mix');
  const medalBeforeBackground = state.medalElapsed;
  await page.evaluate(() => window.__harness.setVisibility(true));
  await page.evaluate(() => window.__harness.advance(1));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.medalElapsed, medalBeforeBackground, 'backgrounding must not consume medal ceremony time');
  await page.evaluate(() => window.__harness.setVisibility(false));
  assert.equal(await page.locator('.hud-interruption').evaluate((el) => el.classList.contains('on')), true,
    'the pause GO must remain visible over the medal layer');
  await page.evaluate(() => window.__harness.resumeInterruption());
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'medal', 'resuming a medal screen continues the remaining ceremony first');
  const frozen = {
    x: state.playerX, y: state.playerY, z: state.playerZ,
    raceTime: state.raceTime, worldTime: state.worldTime, medals: state.manMedalsTotal,
  };
  await page.evaluate(() => window.__harness.advance(4.2));
  assert.equal(await page.locator('.hud-medal-next').evaluate((el) => el.classList.contains('on')), true,
    'the final 1.8s must reveal the far-sea follow-up goal');
  await page.evaluate(() => window.__harness.retry());
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'medal', 'ceremony cannot skip before the full 4.5s');
  assert.deepEqual(
    { x: state.playerX, y: state.playerY, z: state.playerZ, raceTime: state.raceTime, worldTime: state.worldTime },
    { x: frozen.x, y: frozen.y, z: frozen.z, raceTime: frozen.raceTime, worldTime: frozen.worldTime },
    'ceremony must freeze boat, race clock, and world clock',
  );
  await page.evaluate(() => window.__harness.advance(0.35));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'resume-countdown', 'the full ceremony must continue through a resume countdown');
  await page.evaluate(() => window.__harness.advance(2));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'resume-countdown');
  assert.deepEqual(
    { x: state.playerX, y: state.playerY, z: state.playerZ, raceTime: state.raceTime, worldTime: state.worldTime },
    { x: frozen.x, y: frozen.y, z: frozen.z, raceTime: frozen.raceTime, worldTime: frozen.worldTime },
    'resume countdown must remain frozen',
  );
  await page.evaluate(() => window.__harness.advance(2.25));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'racing');
  assert.equal(state.manMedalsTotal, frozen.medals, 'resume must not award the medal twice');
  assert.equal(state.flightCharges, 1, 'the spare charge must survive medal and full resume countdown');

  // A physical Shift hold must survive the third-flight ceremony and full
  // resume countdown. Space is edge-triggered and must never survive with it.
  await page.evaluate(() => window.__harness.scenario('endless-two'));
  await page.keyboard.down('Shift');
  await page.keyboard.down('Space');
  await page.evaluate(() => {
    window.__harness.passFlight(2);
    window.__harness.usePlayerInput(true);
  });
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'medal');
  const heldChargeBeforeLanding = state.flightCharges;
  await page.evaluate(() => window.__harness.advance(4.6));
  assert.equal((await page.evaluate(() => window.__harness.playerState())).phase, 'resume-countdown');
  await page.evaluate(() => window.__harness.advance(4.3));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'racing');
  assert.notEqual(state.flightPhase, 'spool', 'held Space must not auto-launch after the ceremony');
  await page.evaluate(() => window.__harness.advance(1.15));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightPhase, 'surface');
  assert.equal(state.drifting, true, 'held Shift must become surface drift immediately after landing');
  assert.equal(state.driftReleaseReady, true, 'the preserved hold must reach a readable release threshold');
  assert.equal(state.flightCharges, heldChargeBeforeLanding,
    'holding drift must preserve the spare cell without silently issuing another before release');
  await page.keyboard.up('Space');
  await page.evaluate(() => window.__harness.advance(1 / 30));
  assert.equal((await page.evaluate(() => window.__harness.playerState())).flightPhase, 'surface');
  await page.keyboard.up('Shift');
  await page.evaluate(() => window.__harness.advance(1 / 30));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightCharges, Math.min(2, heldChargeBeforeLanding + 1),
    'releasing the preserved Shift hold must add exactly one cell, capped at two');
  await page.evaluate(() => window.__harness.usePlayerInput(false));

  await page.evaluate(() => window.__harness.scenario('endless-four'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'racing', 'the fourth flight must remain playable');
  assert.equal(state.flightsCleared, 4);
  assert.ok(state.bestFlights >= 4, 'endless flight PB must persist');

  await page.evaluate(() => window.__harness.scenario('ready'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightCharges, 0, 'a fresh run/reset must clear both stored launch cells');

  await page.evaluate(() => window.__harness.scenario('endless-medal-fail'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'defeated');
  assert.equal(state.retryLessonActive, true);
  assert.equal(state.manMedalEarned, true, 'post-qualification failure must settle the earned medal');
  assert.ok(state.manMedalsTotal >= medalsBefore + 3);
  assert.equal(state.retryLessonDuration, 5, 'post-medal failure uses the same skippable review');
  assert.equal(state.coachStatus, 'expert', 'three flights permanently exempt the basic curriculum');
  assert.match(await page.locator('.hud-lesson-medal').textContent() ?? '', /男人勋章 \+1/);
  assert.match(await page.locator('.hud-lesson-copy').textContent() ?? '', /空刹/,
    'flight-course failures must teach the contextual air brake on first occurrence');
  assert.equal((await page.evaluate(() => window.__harness.audioState())).scene, 'lesson');

  console.log('gameplay contract: OK');
}

async function verifyGamepadContract(page) {
  await page.evaluate(() => {
    window.__gamepadFixture.disconnectAll();
    window.__gamepadFixture.clearAll();
    window.__harness.scenario('ready');
    // Real browsers may expose a newly connected pad only after its first
    // button is already down. That first edge must not be swallowed.
    window.__gamepadFixture.connect(1);
    window.__gamepadFixture.padButton(1, 0, true);
    window.__harness.advance(1 / 30);
  });
  let padStatus = await page.evaluate(() => window.__harness.gamepadStatus());
  assert.equal(padStatus.connected, true);
  assert.equal(padStatus.index, 1);
  assert.equal((await page.evaluate(() => window.__harness.playerState())).phase, 'countdown',
    'the first A / Cross edge that reveals a controller must start READY immediately');
  await page.evaluate(() => {
    window.__gamepadFixture.padButton(1, 0, false);
    window.__harness.scenario('ready');
    window.__harness.advance(1 / 30);
  });
  assert.match(await page.locator('.driver-controller-status').textContent() ?? '', /G50S.*标准.*震动/,
    'READY must identify the active controller, mapping and rumble capability');

  const initialDriver = await page.locator('.driver-card.selected').getAttribute('data-driver');
  await page.evaluate(() => {
    window.__gamepadFixture.padAxis(1, 0, 0.12);
    window.__harness.advance(1 / 30);
  });
  assert.equal((await page.evaluate(() => window.__harness.gamepadStatus())).steer, 0,
    'left-stick noise inside the dead zone must be zero');
  assert.equal(await page.locator('.driver-card.selected').getAttribute('data-driver'), initialDriver,
    'dead-zone noise must not rotate the driver roster');

  await page.evaluate(() => {
    window.__gamepadFixture.padAxis(1, 0, 0.92);
    window.__harness.advance(1 / 30);
  });
  const nextDriver = await page.locator('.driver-card.selected').getAttribute('data-driver');
  assert.notEqual(nextDriver, initialDriver, 'right stick edge must select exactly one next driver');
  await page.evaluate(() => window.__harness.advance(0.5));
  assert.equal(await page.locator('.driver-card.selected').getAttribute('data-driver'), nextDriver,
    'holding a stick must not scroll through the whole roster');
  await page.evaluate(() => {
    window.__gamepadFixture.padAxis(1, 0, 0);
    window.__harness.advance(1 / 30);
    window.__gamepadFixture.padButton(1, 0, true);
    window.__harness.advance(1 / 30);
  });
  assert.equal((await page.evaluate(() => window.__harness.playerState())).phase, 'countdown',
    'A / Cross must confirm the selected driver and start the countdown');
  await page.evaluate(() => window.__harness.advance(4.4));
  let heldCountdownState = await page.evaluate(() => window.__harness.playerState());
  assert.equal(heldCountdownState.phase, 'racing');
  assert.equal(heldCountdownState.flightPhase, 'surface',
    'holding A through the countdown must never buffer a flight edge');

  await page.evaluate(() => {
    window.__gamepadFixture.clear(1);
    window.__harness.scenario('start');
    window.__harness.usePlayerInput(true);
    window.__harness.advance(1 / 30);
    window.__gamepadFixture.padAxis(1, 0, 0.9);
    window.__gamepadFixture.padButton(1, 2, true);
    window.__harness.advance(0.5);
  });
  let state = await page.evaluate(() => window.__harness.playerState());
  assert.ok(state.steer > 0.7, `left stick must reach the boat input: ${JSON.stringify(state)}`);
  assert.equal(state.drifting, true, 'X / Square must hold the contextual drift action');
  assert.equal(state.driftReleaseReady, true, 'a held gamepad drift must reach the real release threshold');

  // A second idle controller may be present, but deliberate input must take
  // ownership and steer in the same frame. Small idle noise cannot steal it.
  await page.evaluate(() => {
    window.__gamepadFixture.connect(0);
    window.__gamepadFixture.padAxis(0, 0, 0.11);
    window.__gamepadFixture.clear(1);
    window.__harness.advance(1 / 30);
    window.__gamepadFixture.padAxis(0, 0, -0.96);
    window.__harness.advance(1 / 30);
  });
  state = await page.evaluate(() => window.__harness.playerState());
  padStatus = await page.evaluate(() => window.__harness.gamepadStatus());
  assert.equal(padStatus.connectedCount, 2);
  assert.equal(padStatus.index, 0, 'the pad producing deliberate input must become active');
  assert.ok(state.steer < -0.7, `a newly active second pad must steer without a dead frame: ${JSON.stringify(state)}`);

  await page.evaluate(() => {
    window.__gamepadFixture.padAxis(0, 0, 0);
    window.__harness.advance(1 / 30);
    window.__gamepadFixture.padAxis(1, 0, 0.94);
    window.__gamepadFixture.padButton(1, 2, true);
    window.__harness.advance(0.5);
    window.__gamepadFixture.disconnect(1);
    window.__harness.advance(1 / 30);
  });
  state = await page.evaluate(() => window.__harness.playerState());
  padStatus = await page.evaluate(() => window.__harness.gamepadStatus());
  assert.equal(padStatus.connected, true);
  assert.equal(padStatus.index, 0, 'disconnecting the active pad must fall back to another connected pad');
  assert.equal(state.drifting, false, 'disconnect must release drift in the next simulation frame');
  assert.ok(Math.abs(state.steer) < 0.01, `disconnect must release steering: ${state.steer}`);
  assert.ok(state.flightCharges >= 1, 'disconnecting a qualified held drift may release its earned charge once');

  await page.evaluate(() => {
    window.__gamepadFixture.clear(0);
    window.__harness.advance(1 / 30);
  });
  assert.match(await page.locator('.hud-flight-prompt').textContent() ?? '', /A.*起飞/s,
    'a connected controller must be taught A / Cross before spending its charge');
  await page.evaluate(() => {
    window.__gamepadFixture.button(0, true);
    window.__harness.advance(1 / 30);
  });
  state = await page.evaluate(() => window.__harness.playerState());
  assert.notEqual(state.flightPhase, 'surface', 'A / Cross must spend one stored charge and start flight');
  await page.evaluate(() => {
    window.__gamepadFixture.clear();
    window.__gamepadFixture.disconnect();
    window.__harness.usePlayerInput(false);
  });

  // Non-standard devices use a four-action READY calibration rather than a
  // guessed vendor layout. The resulting map survives a reconnect.
  await page.evaluate(() => {
    window.__gamepadFixture.disconnectAll();
    window.__gamepadFixture.clearAll();
    window.__gamepadFixture.configure(1, { id:'Generic DirectInput Racer', mapping:'' });
    window.__gamepadFixture.connect(1);
    window.__harness.scenario('ready');
    window.__harness.advance(1 / 30);
  });
  padStatus = await page.evaluate(() => window.__harness.gamepadStatus());
  assert.equal(padStatus.mappingSource, 'fallback');
  assert.equal(padStatus.calibrationStep, 'left');
  for (let i = 0; i < 7; i++) {
    await page.evaluate((step) => {
      const actions = [
        () => window.__gamepadFixture.padAxis(1, 1, -0.9),
        () => window.__gamepadFixture.padAxis(1, 1, 0),
        () => window.__gamepadFixture.padAxis(1, 1, 0.9),
        () => window.__gamepadFixture.padAxis(1, 1, 0),
        () => window.__gamepadFixture.padButton(1, 5, true),
        () => window.__gamepadFixture.padButton(1, 5, false),
        () => window.__gamepadFixture.padButton(1, 1, true),
      ];
      actions[step]();
      window.__harness.advance(1 / 30);
    }, i);
  }
  padStatus = await page.evaluate(() => window.__harness.gamepadStatus());
  assert.equal(padStatus.mappingSource, 'custom');
  assert.equal(padStatus.calibrationStep, '');
  assert.ok(await page.evaluate(() => Boolean(localStorage.getItem('board-race.gamepad.v1'))),
    'custom mapping must persist by device signature');
  await page.evaluate(() => {
    window.__gamepadFixture.padButton(1, 1, false);
    window.__harness.advance(1 / 30);
    window.__gamepadFixture.disconnect(1);
    window.__harness.advance(1 / 30);
    window.__gamepadFixture.connect(1);
    window.__harness.advance(1 / 30);
  });
  assert.equal((await page.evaluate(() => window.__harness.gamepadStatus())).mappingSource, 'custom',
    'reconnecting the same unknown controller must restore its mapping without recalibration');

  // Haptics are discrete, bounded, priority-aware and independent from mute.
  await page.evaluate(() => {
    window.__harness.setHapticsEnabled(false);
    window.__harness.setHapticsEnabled(true);
    window.__gamepadFixture.clearEffects();
    window.__harness.hapticCue('collision-heavy');
    window.__harness.hapticCue('drift-active');
  });
  let effects = await page.evaluate(() => window.__gamepadFixture.effects(1));
  const pulses = effects.filter((entry) => entry.kind === 'play' && Number(entry.options?.duration) > 0);
  assert.equal(pulses.length, 1, 'a lower-priority cue must not stack over a heavy collision pulse');
  assert.ok(Number(pulses[0].options.duration) <= 80, `controller feedback must remain short: ${JSON.stringify(pulses[0])}`);
  assert.ok(Number(pulses[0].options.strongMagnitude) <= 0.55,
    `controller feedback must remain conservative: ${JSON.stringify(pulses[0])}`);
  // A skill pulse owns the right-hand feel. A collision received while drift
  // is held queues behind it and cannot replace the first actuator effect.
  await page.evaluate(() => {
    window.__harness.setHapticsEnabled(false);
    window.__harness.setHapticsEnabled(true);
    window.__gamepadFixture.clearEffects();
    window.__harness.hapticCue('air-brake');
    window.__harness.hapticImpact('collision-heavy', 1, true);
  });
  await page.waitForTimeout(110);
  await page.evaluate(() => window.__harness.advance(1 / 30));
  effects = await page.evaluate(() => window.__gamepadFixture.effects(1));
  const protectedPulses = effects.filter((entry) => entry.kind === 'play' && Number(entry.options?.duration) > 0);
  assert.ok(protectedPulses.length >= 1 && protectedPulses.length <= 2,
    `control/impact scheduler must stay single-slot: ${JSON.stringify(protectedPulses)}`);
  const protectedHaptics = await page.evaluate(() => window.__harness.hapticStatus());
  assert.ok(Number(protectedHaptics.queuedImpacts) >= 1, 'impact must be queued while the skill pulse is held');
  await page.locator('.audio-mixer-toggle').click();
  const hapticButton = page.locator('.audio-mixer-haptics');
  await hapticButton.click();
  assert.equal((await page.evaluate(() => window.__harness.hapticStatus())).enabled, false);
  await page.evaluate(() => {
    window.__gamepadFixture.clearEffects();
    window.__harness.hapticCue('gate');
  });
  effects = await page.evaluate(() => window.__gamepadFixture.effects(1));
  assert.equal(effects.filter((entry) => entry.kind === 'play' && Number(entry.options?.duration) > 0).length, 0,
    'the independent haptic switch must silence controller feedback');
  await hapticButton.click();
  assert.equal((await page.evaluate(() => window.__harness.hapticStatus())).enabled, true);
  await page.locator('.audio-mixer-toggle').click();

  await page.evaluate(() => {
    window.__gamepadFixture.clear(1);
    window.__harness.scenario('start');
    window.__harness.usePlayerInput(true);
    window.__harness.advance(1 / 30);
    window.__harness.setVisibility(true);
    window.__harness.setVisibility(false);
    window.__harness.advance(1 / 30);
    window.__gamepadFixture.padButton(1, 1, true);
    window.__harness.advance(1 / 30);
  });
  assert.equal((await page.evaluate(() => window.__harness.playerState())).phase, 'resume-countdown',
    'the calibrated flight/confirm button must resume a background-paused run');
  await page.evaluate(() => {
    window.__gamepadFixture.clearAll();
    window.__gamepadFixture.disconnectAll();
  });
  console.log('gamepad input contract: OK');
}

async function verifyMobileControls(page) {
  const start = page.locator('.mobile-start');
  const contractGo = page.locator('.driver-select-go');
  const repairedCoach = await page.evaluate(() => ({
    records:window.__harness.recordsState(),
    coach:window.__harness.coachState(),
  }));
  assert.equal(repairedCoach.records.version, 8);
  assert.equal(repairedCoach.coach.status, 'dormant');
  assert.equal(repairedCoach.coach.automaticEligible, true,
    'the shipped v7 novice must be repaired before its next real failure');
  assert.equal(await contractGo.isVisible(), true, 'mobile must start behind the explicit driver-contract GO');
  assert.equal(await start.isVisible(), false, 'the legacy activation button must not compete with driver selection');
  assert.equal(await page.locator('.hud-pc-primer:visible').count(), 0,
    'mobile must never render the desktop keyboard primer');
  await assertDriverSelectComposition(page, 'mobile-844x390');
  const coldStart = await page.evaluate(() => window.__harness.startGantryStatus());
  assert.equal(coldStart.canvasTextures, 0,
    `mobile cold load must use texture-independent START geometry: ${JSON.stringify(coldStart)}`);
  assert.equal(coldStart.glyphInstances, 18);
  assert.equal(coldStart.checkerInstances, 48);
  await page.evaluate(() => {
    window.__gamepadFixture.clearVibrations();
    window.__harness.hapticCue('gate');
  });
  let vibrationLog = await page.evaluate(() => window.__gamepadFixture.vibrations());
  assert.equal(vibrationLog.length, 1, 'a mobile gate event must emit one discrete phone vibration');
  assert.ok(Number(vibrationLog[0]) >= 8 && Number(vibrationLog[0]) <= 20,
    `mobile feedback must remain brief: ${JSON.stringify(vibrationLog)}`);
  await page.evaluate(() => {
    window.__harness.setHapticsEnabled(false);
    window.__gamepadFixture.clearVibrations();
    window.__harness.hapticCue('launch');
  });
  vibrationLog = await page.evaluate(() => window.__gamepadFixture.vibrations());
  assert.deepEqual(vibrationLog, [], 'disabling haptics must silence phone vibration independently');
  await page.evaluate(() => window.__harness.setHapticsEnabled(true));
  const selectedBefore = await page.locator('.driver-card.selected').getAttribute('data-driver');
  const featuredBefore = await page.locator('.driver-featured').boundingBox();
  const switchResult = await page.evaluate(async () => {
    const button = document.querySelector('.driver-switch-next');
    button.click();
    await new Promise((r) => setTimeout(r, 95));
    return {
      switching: document.querySelector('.driver-select').classList.contains('switching'),
      selected: document.querySelector('.driver-card.selected')?.dataset.driver ?? '',
    };
  });
  assert.equal(switchResult.switching, true,
    'a driver change must enter the finite selection-lock state');
  assert.notEqual(switchResult.selected, selectedBefore);
  const backdropAnimation = await page.locator('.driver-mobile-backdrop').evaluate((el) => {
    const style = getComputedStyle(el);
    return { name:style.animationName, duration:parseFloat(style.animationDuration) };
  });
  assert.equal(backdropAnimation.name, 'driver-mobile-backdrop-soft',
    `the standing portrait must run the authored lock-in animation: ${JSON.stringify(backdropAnimation)}`);
  assert.ok(backdropAnimation.duration >= 0.4 && backdropAnimation.duration <= 0.6,
    `the standing portrait lock-in must stay finite and readable: ${JSON.stringify(backdropAnimation)}`);
  const selectAudio = await page.evaluate(() => window.__harness.audioState());
  assert.ok(Number(selectAudio.driverSelectEvents) >= 1, `driver selection must emit its own event: ${JSON.stringify(selectAudio)}`);
  assert.equal(selectAudio.scoreArmed, false, 'selection SFX must never start the background score');
  assert.equal(selectAudio.musicPlaying, true, 'selection SFX must sit over the persistent READY score');
  assert.deepEqual(await page.locator('.driver-featured').boundingBox(), featuredBefore,
    'the selection lock may not reflow the featured contract grid');
  const beforeSwipe = await page.locator('.driver-card.selected').getAttribute('data-driver');
  assert.equal(await page.locator('.driver-carousel').isVisible(), false,
    'mobile must not cover the standing portrait with a second card rail');
  await page.locator('.driver-switch-next').click();
  assert.notEqual(await page.locator('.driver-card.selected').getAttribute('data-driver'), beforeSwipe,
    'the explicit next control must advance exactly one hidden roster destination');
  const visitedDrivers = new Set();
  const visitedRosterSlots = new Set();
  for (let i = 0; i < 6; i++) {
    const selection = await page.evaluate(() => ({
      id:document.querySelector('.driver-card.selected')?.dataset.driver ?? '',
      cardSrc:document.querySelector('.driver-card.selected img')?.currentSrc ?? '',
      backdropSrc:document.querySelector('.driver-mobile-backdrop')?.currentSrc ?? '',
      roster:document.querySelector('.driver-roster-index')?.textContent ?? '',
    }));
    assert.equal(selection.backdropSrc, selection.cardSrc,
      `standing portrait must follow every roster change: ${JSON.stringify(selection)}`);
    assert.match(selection.roster, /^选手 \d{2} \/ 06$/);
    visitedDrivers.add(selection.id);
    visitedRosterSlots.add(selection.roster);
    await page.locator('.driver-switch-next').click();
    await page.waitForTimeout(75);
  }
  assert.equal(visitedDrivers.size, 6, `the explicit next control must visit all six drivers: ${[...visitedDrivers].join(', ')}`);
  assert.equal(visitedRosterSlots.size, 6, `the roster counter must expose all six positions: ${[...visitedRosterSlots].join(', ')}`);
  for (let i = 0; i < 12; i++) await page.locator('.driver-switch-next').click();
  await page.waitForTimeout(650);
  const selectSettled = await page.evaluate(() => window.__harness.audioState());
  assert.equal(Number(selectSettled.activeOneShots), 0, 'rapid driver changes must release every transient audio node');
  assert.equal(await page.locator('.driver-select').evaluate((el) => el.classList.contains('switching')), false,
    'the finite selection lock must release its compositing hint after the last switch');
  for (const height of [390, 330, 300]) {
    if (!await safeSetViewportSize(page, { width: 844, height })) break;
    await page.waitForTimeout(50);
    await assertDriverSelectComposition(page, `mobile-844x${height}`);
    const contract = await page.evaluate(() => {
      const selectors = [
        '.driver-select-header', '.driver-featured', '.driver-select-footer',
      ];
      const rects = selectors.map((selector) => {
        const rect = document.querySelector(selector)?.getBoundingClientRect();
        return rect ? { selector, top:rect.top, right:rect.right, bottom:rect.bottom, left:rect.left } : null;
      }).filter(Boolean);
      const go = document.querySelector('.driver-select-go')?.getBoundingClientRect();
      const overlaps = [];
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i], b = rects[j];
          if (Math.min(a.right,b.right) - Math.max(a.left,b.left) > 1 &&
              Math.min(a.bottom,b.bottom) - Math.max(a.top,b.top) > 1) overlaps.push(`${a.selector} x ${b.selector}`);
        }
      }
      return {
        rects, overlaps,
        go:go && { top:go.top, right:go.right, bottom:go.bottom, left:go.left },
        goCenterX:go ? (go.left + go.right) / 2 : null,
        cardCount:document.querySelectorAll('.driver-card').length,
        visibleCards:[...document.querySelectorAll('.driver-card')]
          .filter((node) => node.getClientRects().length > 0 && node.getBoundingClientRect().width > 0)
          .map((node) => {
            const r = node.getBoundingClientRect();
            return { id:node.dataset.driver, top:r.top, right:r.right, bottom:r.bottom, left:r.left };
          }),
        dotCount:document.querySelectorAll('.driver-dot').length,
        selectedDotCount:document.querySelectorAll('.driver-dot.selected').length,
        archiveCount:document.querySelectorAll('.driver-archive,.driver-archive-button').length,
        switchControls:[...document.querySelectorAll('.driver-switch-control')].map((node) => {
          const r = node.getBoundingClientRect();
          return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height };
        }),
        scrollHeight:document.scrollingElement?.scrollHeight ?? 0,
        width:innerWidth, height:innerHeight,
      };
    });
    assert.deepEqual(contract.overlaps, [], `driver selector rows overlap at 844x${height}: ${contract.overlaps.join(', ')}`);
    assert.ok(contract.go && contract.go.top >= 0 && contract.go.bottom <= contract.height,
      `GO must remain inside the first visual viewport at 844x${height}: ${JSON.stringify(contract.go)}`);
    assert.ok(Math.abs(contract.goCenterX - contract.width / 2) <= 1.5,
      `GO must own the horizontal center at 844x${height}: ${JSON.stringify(contract.go)}`);
    assert.equal(contract.cardCount, 6, 'all six drivers must remain reachable in the carousel');
    assert.equal(contract.visibleCards.length, 0, 'mobile must keep all six destinations behind the two explicit rotation controls');
    assert.equal(contract.dotCount, 6, 'the carousel must expose all six destinations without six cards');
    assert.equal(contract.selectedDotCount, 1, 'exactly one carousel destination must be selected');
    assert.equal(contract.switchControls.length, 2, 'the main driver stage needs two explicit rotation controls');
    for (const control of contract.switchControls) {
      assert.ok(control.left >= 0 && control.right <= contract.width && control.top >= 0 && control.bottom <= contract.height,
        `driver rotation control clips at 844x${height}: ${JSON.stringify(control)}`);
      assert.ok(control.width >= 44 && control.height >= 44,
        `driver rotation control needs a reliable touch target at 844x${height}: ${JSON.stringify(control)}`);
    }
    assert.equal(contract.archiveCount, 0, 'archive import/export must not compete with selection');
    assert.ok(contract.scrollHeight <= contract.height + 1,
      `driver selector must not depend on address-bar collapse at 844x${height}: scrollHeight=${contract.scrollHeight}`);
  }
  const portraitContract = await page.locator('.driver-card img').evaluateAll((images) => images.map((image) => ({
    width:image.naturalWidth, height:image.naturalHeight, src:image.currentSrc,
  })));
  assert.equal(portraitContract.length, 6);
  assert.equal(new Set(portraitContract.map((portrait) => portrait.src)).size, 6, 'every driver needs a distinct portrait');
  for (const portrait of portraitContract) {
    assert.deepEqual({ width: portrait.width, height: portrait.height }, { width: 640, height: 960 },
      `portrait must use the mobile-safe 2:3 master: ${portrait.src}`);
  }
  await safeSetViewportSize(page, { width: 844, height: 390 });
  await page.waitForTimeout(120);
  await page.evaluate(() => window.__harness.render());
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  let renderStats = await page.evaluate(() => window.__harness.stats());
  assert.equal(Number(renderStats.mobileClarity), 1, 'touch devices must use the mobile clarity governor');
  assert.ok(Math.abs(Number(renderStats.pixelRatio) - 2.5) < 0.02,
    `844x390 DPR3 must start at the 2.5x clarity cap: ${JSON.stringify(renderStats)}`);
  assert.ok(Number(renderStats.drawingPixels) >= 2_030_000 && Number(renderStats.drawingPixels) <= 2_120_000,
    `mobile Auto must spend, but never exceed, its 2.1M budget: ${JSON.stringify(renderStats)}`);
  const clearRatio = Number(renderStats.pixelRatio);
  await page.evaluate(() => window.__harness.perfFrames(28, 110));
  renderStats = await page.evaluate(() => window.__harness.stats());
  assert.ok(Number(renderStats.pixelRatio) < clearRatio && Number(renderStats.pixelRatio) >= 1,
    `sustained pressure must lower mobile clarity safely: ${clearRatio} -> ${renderStats.pixelRatio}`);
  const reducedRatio = Number(renderStats.pixelRatio);
  await page.evaluate(() => window.__harness.perfFrames(16.7, 380));
  renderStats = await page.evaluate(() => window.__harness.stats());
  assert.ok(Number(renderStats.pixelRatio) > reducedRatio && Number(renderStats.pixelRatio) <= 2.5,
    `stable frames must restore mobile clarity: ${reducedRatio} -> ${renderStats.pixelRatio}`);
  let status = await page.evaluate(() => window.__harness.mobileStatus());
  assert.equal(status.activation, 'idle');
  assert.equal(status.mode, 'touch', 'mobile must expose touch steering before the first GO');
  assert.equal(await page.locator('.mobile-mode').textContent(), '转向 · 触控');
  assert.ok(Number(status.fullscreenRequests) >= 1,
    `the first touch on the driver selector must request fullscreen: ${JSON.stringify(status)}`);
  await contractGo.click();
  status = await page.evaluate(() => window.__harness.mobileStatus());
  assert.ok(Number(status.fullscreenRequests) >= 1,
    `the first GO gesture must immediately request fullscreen: ${JSON.stringify(status)}`);
  assert.equal(status.activation, 'ready', 'default touch steering must not wait for sensor calibration');
  assert.equal(status.mode, 'touch');

  const mode = page.locator('.mobile-mode');
  const touchActions = await readMobileControlGeometry(page);
  const topControlsOverlap = await page.evaluate(() => {
    const modeRect = document.querySelector('.mobile-mode')?.getBoundingClientRect();
    const soundRect = document.querySelector('.audio-mixer-toggle')?.getBoundingClientRect();
    if (!modeRect || !soundRect) return false;
    return Math.min(modeRect.right, soundRect.right) > Math.max(modeRect.left, soundRect.left) &&
      Math.min(modeRect.bottom, soundRect.bottom) > Math.max(modeRect.top, soundRect.top);
  });
  assert.equal(topControlsOverlap, false, 'SOUND may not cover the tilt/touch mode switch');

  // Gravity steering remains an explicit opt-in. Only this mode-switch click
  // may enter the permission/calibration path.
  await mode.click();
  await page.waitForFunction(() => {
    const s = window.__harness.mobileStatus();
    return s.activation === 'calibrating' || s.activation === 'ready';
  });
  status = await page.evaluate(() => window.__harness.mobileStatus());
  if (status.activation === 'calibrating') {
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => {
        const event = new Event('deviceorientation');
        Object.defineProperties(event, {
          beta: { value: 0.6 },
          gamma: { value: 0.4 },
        });
        window.dispatchEvent(event);
      });
      await page.waitForTimeout(55);
    }
  }
  await page.waitForFunction(() => window.__harness.mobileStatus().activation === 'ready', null, { timeout: 2500 });
  assert.equal((await page.evaluate(() => window.__harness.mobileStatus())).mode, 'tilt',
    'the explicit mode switch must still enable calibrated gravity steering');
  const tiltActions = await readMobileControlGeometry(page);
  for (const action of ['drift', 'flight']) {
    const before = tiltActions.controls[action];
    const after = touchActions.controls[action];
    for (const edge of ['left', 'right', 'top', 'bottom']) {
      assert.ok(Math.abs(before[edge] - after[edge]) < 0.5,
        `${action} must not move when steering mode changes (${edge}: ${before[edge]} -> ${after[edge]})`);
    }
    assert.ok(after.faceCenterX > touchActions.width * 0.58,
      `${action} must remain in the right-thumb skill zone: ${JSON.stringify(after)}`);
  }

  await mode.click();
  assert.equal((await page.evaluate(() => window.__harness.mobileStatus())).mode, 'touch',
    'the mode switch must return immediately to touch steering');
  assert.ok(touchActions.controls.drift.faceCenterX > touchActions.controls.flight.faceCenterX &&
    touchActions.controls.drift.faceCenterY > touchActions.controls.flight.faceCenterY,
  'drift must be the lower-right primary skill and flight its upper-left secondary skill');
  for (const action of ['left', 'right']) {
    assert.ok(touchActions.controls[action].faceCenterX < touchActions.width * 0.44,
      `${action} must remain in the left-thumb steering zone: ${JSON.stringify(touchActions.controls[action])}`);
  }

  await page.evaluate(() => {
    window.__harness.scenario('flight-route5-turn');
    window.__gamepadFixture.clearVibrations();
  });
  const mobileRouteGuidance = await page.evaluate(() => window.__harness.guidance());
  assert.equal(mobileRouteGuidance.actionCue, 'turn');
  assert.equal(mobileRouteGuidance.actionDirection, 'right');
  assert.equal(await page.locator('.mobile-controls').evaluate((element) =>
    element.classList.contains('route-action-turn') && element.classList.contains('route-turn-right')), true,
  'the fifth-flight bend must pair air brake with the fixed right steering zone');
  assert.equal(await page.locator('.hud-turn-warning').isVisible(), false,
    'phone guidance must stay in-world and on the controls instead of adding a text card');
  const routeTurnActions = await readMobileControlGeometry(page);
  await page.locator('.mobile-controls').evaluate((element) => {
    element.classList.remove('route-action-turn', 'route-turn-right');
  });
  const routeNeutralActions = await readMobileControlGeometry(page);
  await page.locator('.mobile-controls').evaluate((element) => {
    element.classList.add('route-action-turn', 'route-turn-right');
  });
  for (const action of ['drift', 'flight', 'left', 'right']) {
    for (const edge of ['left', 'right', 'top', 'bottom']) {
      assert.ok(Math.abs(routeTurnActions.controls[action][edge] - routeNeutralActions.controls[action][edge]) < 0.5,
        `route guidance may not move the ${action} hit zone (${edge})`);
    }
  }
  await page.evaluate(() => window.__harness.advance(0.1));
  vibrationLog = await page.evaluate(() => window.__gamepadFixture.vibrations());
  assert.equal(vibrationLog.length, 0,
    `settled route markers must not emit any extra vibration: ${JSON.stringify(vibrationLog)}`);

  // Exercise the production path that failed in the shipped v7 build:
  // migrated novice -> first failure -> immediate continue -> real GO ->
  // contextual mobile spotlight. No visual fixture or forced coach state.
  await page.evaluate(() => window.__harness.scenario('flight-no-launch'));
  await page.evaluate(() => window.__harness.advance(0.6));
  let firstFailure = await page.evaluate(() => window.__harness.playerState());
  assert.equal(firstFailure.retryLessonActive, true);
  assert.equal(firstFailure.retryLessonMinRead, 0, 'the first-failure offer must be skippable immediately');
  assert.equal(firstFailure.coachStatus, 'active');
  assert.equal(await page.locator('.hud-lesson-continue').textContent(), '带标注再冲');
  await page.locator('.hud-lesson-continue').click();
  assert.equal((await page.evaluate(() => window.__harness.playerState())).phase, 'ready');
  await page.locator('.driver-select-go').click();
  await page.evaluate(() => window.__harness.advance(4.35));
  await page.evaluate(() => {
    for (let i = 0; i < 30 && !window.__harness.playerState().coachVisible; i++) window.__harness.advance(0.15);
  });
  const liveMobileCoach = await page.evaluate(() => {
    const rect = (selector) => {
      const value = document.querySelector(selector)?.getBoundingClientRect();
      return value && { left:value.left, right:value.right, top:value.top, bottom:value.bottom };
    };
    return {
      coach:window.__harness.coachState(),
      card:rect('.hud-coach.on'),
      spotlight:rect('.hud-coach-spotlight.on'),
      drift:rect('[data-mobile-action="drift"] span'),
      title:document.querySelector('.hud-coach-title')?.textContent ?? '',
      dim:getComputedStyle(document.querySelector('.hud-coach-spotlight')).getPropertyValue('--coach-dim').trim(),
    };
  });
  assert.equal(liveMobileCoach.coach.activeStep, 'drift');
  assert.equal(liveMobileCoach.coach.device, 'mobile');
  assert.match(liveMobileCoach.title, /右下「漂」/,
    'the first mobile step must name the actual fixed drift control');
  assert.equal(liveMobileCoach.dim, '.5', 'the phone spotlight must visibly dim everything outside the live control');
  assert.ok(liveMobileCoach.card && liveMobileCoach.spotlight && liveMobileCoach.drift &&
    liveMobileCoach.spotlight.left <= liveMobileCoach.drift.left &&
    liveMobileCoach.spotlight.right >= liveMobileCoach.drift.right &&
    liveMobileCoach.spotlight.top <= liveMobileCoach.drift.top &&
    liveMobileCoach.spotlight.bottom >= liveMobileCoach.drift.bottom,
  `the real post-failure path must frame the live drift thumb control: ${JSON.stringify(liveMobileCoach)}`);
  await page.locator('.hud-coach-close').click();
  await page.evaluate(() => window.__harness.advance(1 / 30));
  firstFailure = await page.evaluate(() => window.__harness.playerState());
  assert.equal(firstFailure.coachStatus, 'disabled');
  assert.equal(firstFailure.coachVisible, false, 'mobile must be able to close the guide from its first visible step');

  // The medal presentation and resume countdown expose direction/drift for
  // preloading, but keep flight disabled. A touch that begins after the medal
  // appears must survive presentation -> preparing -> racing.
  await page.evaluate(() => {
    window.__harness.scenario('start');
    window.__harness.passFlight(0);
    window.__harness.passFlight(1);
    window.__harness.passFlight(2);
    window.__harness.usePlayerInput(true);
  });
  status = await page.evaluate(() => window.__harness.mobileStatus());
  assert.equal(status.controlPhase, 'presentation', 'third flight must enter the mobile medal presentation');
  const presentationHitTargets = await page.evaluate(() => {
    const hit = (action) => {
      const el = document.querySelector(`[data-mobile-action="${action}"]`);
      const rect = el?.getBoundingClientRect();
      if (!rect) return null;
      return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        ?.closest('[data-mobile-action]')?.getAttribute('data-mobile-action') ?? null;
    };
    return { left:hit('left'), drift:hit('drift'), flight:hit('flight') };
  });
  assert.equal(presentationHitTargets.left, 'left',
    `medal overlay must not swallow the visible steering zone: ${JSON.stringify(presentationHitTargets)}`);
  assert.equal(presentationHitTargets.drift, 'drift',
    `medal overlay must not swallow the visible drift zone: ${JSON.stringify(presentationHitTargets)}`);
  assert.notEqual(presentationHitTargets.flight, 'flight',
    'the medal presentation must keep the edge-triggered flight control disabled');
  await page.locator('[data-mobile-action="left"]').dispatchEvent('pointerdown', { pointerId: 31, pointerType: 'touch', isPrimary: true });
  await page.locator('[data-mobile-action="drift"]').dispatchEvent('pointerdown', { pointerId: 32, pointerType: 'touch', isPrimary: true });
  assert.deepEqual(await page.locator('.held').evaluateAll((els) => els.map((el) => el.dataset.mobileAction).sort()),
    ['drift', 'left'], 'pointers pressed on the medal must remain owned by the controls');
  await page.evaluate(() => window.__harness.advance(4.6));
  status = await page.evaluate(() => window.__harness.mobileStatus());
  assert.equal(status.controlPhase, 'preparing');
  const preparingCharge = (await page.evaluate(() => window.__harness.playerState())).flightCharges;
  await page.locator('[data-mobile-action="left"]').dispatchEvent('pointerdown', { pointerId: 21, pointerType: 'touch', isPrimary: true });
  await page.locator('[data-mobile-action="drift"]').dispatchEvent('pointerdown', { pointerId: 22, pointerType: 'touch' });
  await page.locator('[data-mobile-action="flight"]').dispatchEvent('pointerdown', { pointerId: 23, pointerType: 'touch' });
  assert.deepEqual(await page.locator('.held').evaluateAll((els) => els.map((el) => el.dataset.mobileAction).sort()),
    ['drift', 'left'], 'preparing may capture steering/drift but never flight');
  await page.evaluate(() => window.__harness.advance(2));
  assert.equal((await page.evaluate(() => window.__harness.mobileStatus())).controlPhase, 'preparing');
  assert.deepEqual(await page.locator('.held').evaluateAll((els) => els.map((el) => el.dataset.mobileAction).sort()),
    ['drift', 'left'], 'held preparation pointers must survive the frozen countdown');
  await page.locator('[data-mobile-action="left"]').dispatchEvent('pointerup', { pointerId: 21, pointerType: 'touch' });
  await page.evaluate(() => window.__harness.advance(2.3));
  status = await page.evaluate(() => window.__harness.mobileStatus());
  assert.equal(status.controlPhase, 'racing');
  await page.evaluate(() => window.__harness.advance(1.15));
  const resumedState = await page.evaluate(() => window.__harness.playerState());
  assert.equal(resumedState.flightPhase, 'surface');
  assert.equal(resumedState.drifting, true);
  assert.equal(resumedState.driftReleaseReady, true);
  assert.equal(resumedState.flightCharges, preparingCharge,
    'a rejected preparing flight tap must not alter the legitimately preserved spare cell');
  await page.locator('[data-mobile-action="drift"]').dispatchEvent('pointerup', { pointerId: 22, pointerType: 'touch' });
  await page.locator('[data-mobile-action="left"]').dispatchEvent('pointerup', { pointerId: 31, pointerType: 'touch' });
  await page.locator('[data-mobile-action="drift"]').dispatchEvent('pointerup', { pointerId: 32, pointerType: 'touch' });
  await page.evaluate(() => window.__harness.advance(1 / 30));
  assert.equal((await page.evaluate(() => window.__harness.playerState())).flightCharges, Math.min(2, preparingCharge + 1),
    'releasing the held drift after GO must add exactly one cell');
  await page.evaluate(() => window.__harness.usePlayerInput(false));

  await page.evaluate(() => window.__harness.scenario('start'));
  const geometry = await readMobileControlGeometry(page);
  for (const [name, r] of Object.entries(geometry.controls)) {
    assert.ok(r.width >= 140 && r.height >= 100, `${name} touch target is too small: ${r.width}x${r.height}`);
    assert.ok(r.top >= geometry.height - 170 && r.bottom <= geometry.height, `${name} must stay at the bottom edge`);
    assert.ok(r.faceWidth >= 70 && r.faceWidth <= 100 && r.faceHeight >= 70 && r.faceHeight <= 100,
      `${name} needs a compact thumb disc inside its large hit target: ${JSON.stringify(r)}`);
    assert.equal(r.buttonBackground, 'rgba(0, 0, 0, 0)', `${name} must not paint the rectangular hit target`);
  }
  assert.ok(geometry.controls.right.right < geometry.controls.drift.left,
    'steering and action groups must remain separate');

  // Touch-capable browsers must still accept a real keyboard. The old input
  // branch discarded ArrowLeft/ArrowRight whenever mobile controls existed.
  await page.evaluate(() => window.__harness.usePlayerInput(true));
  await page.keyboard.down('ArrowRight');
  await page.evaluate(() => window.__harness.advance(0.25));
  const keyboardState = await page.evaluate(() => window.__harness.playerState());
  await page.keyboard.up('ArrowRight');
  assert.ok(keyboardState.steer > 0.7,
    `ArrowRight must steer even in a touch-capable Chrome session: ${JSON.stringify(keyboardState)}`);
  await page.evaluate(() => window.__harness.usePlayerInput(false));

  for (const [selector, pointerId] of [
    ['[data-mobile-action="left"]', 31],
    ['[data-mobile-action="drift"]', 32],
    ['[data-mobile-action="flight"]', 33],
  ]) {
    await page.locator(selector).dispatchEvent('pointerdown', { pointerId, pointerType: 'touch', isPrimary: pointerId === 31 });
  }
  assert.deepEqual(await page.locator('.held').evaluateAll((els) => els.map((el) => el.dataset.mobileAction).sort()),
    ['drift', 'flight', 'left'], 'multi-touch actions must be tracked independently');
  await page.locator('[data-mobile-action="left"]').dispatchEvent('pointercancel', { pointerId: 31, pointerType: 'touch' });
  await page.locator('[data-mobile-action="drift"]').dispatchEvent('pointercancel', { pointerId: 32, pointerType: 'touch' });
  await page.locator('[data-mobile-action="flight"]').dispatchEvent('pointercancel', { pointerId: 33, pointerType: 'touch' });
  assert.equal(await page.locator('.held').count(), 0, 'cancelled touches must never leave sticky controls');

  await page.evaluate(() => window.__harness.scenario('coach-drift'));
  const coachLayout = await page.evaluate(() => {
    const rect = (selector) => {
      const value = document.querySelector(selector)?.getBoundingClientRect();
      return value && { left:value.left, right:value.right, top:value.top, bottom:value.bottom };
    };
    return {
      root:rect('.hud'),
      rootScrollLeft:document.querySelector('.hud')?.scrollLeft ?? -1,
      coach:rect('.hud-coach.on'),
      spotlight:rect('.hud-coach-spotlight.on'),
      objective:rect('.hud-topleft'),
      objectiveStyle:(() => {
        const element = document.querySelector('.hud-topleft');
        if (!element) return null;
        const style = getComputedStyle(element);
        const parent = element.offsetParent?.getBoundingClientRect();
        return {
          left:style.left,
          transform:style.transform,
          translate:style.translate,
          animation:style.animationName,
          offsetLeft:element.offsetLeft,
          scrollX,
          parent:parent && { left:parent.left, right:parent.right },
        };
      })(),
      tower:rect('.race-tower.on'),
      driverPower:rect('.hud-driver-power'),
      flight:rect('[data-mobile-action="flight"]'),
      drift:rect('[data-mobile-action="drift"]'),
      driftDisc:rect('[data-mobile-action="drift"] span'),
      coachState:window.__harness.coachState(),
      playerState:window.__harness.playerState(),
      impactVisible:Boolean(document.querySelector('.hud-impact.on')),
      battleVisible:Boolean(document.querySelector('.hud-battle.on')),
      turnWarningVisible:Boolean(document.querySelector('.hud-turn-warning.on')),
    };
  });
  assert.ok(coachLayout.coach && coachLayout.driverPower && coachLayout.flight && coachLayout.drift && coachLayout.driftDisc,
    `mobile spotlight guide must render with all fixed controls: ${JSON.stringify(coachLayout)}`);
  assert.equal(coachLayout.rootScrollLeft, 0,
    `the clipped HUD must never scroll while focus moves between mobile controls: ${JSON.stringify(coachLayout)}`);
  const overlaps = (a, b, gap = 6) => a && b &&
    a.left < b.right + gap && a.right > b.left - gap && a.top < b.bottom + gap && a.bottom > b.top - gap;
  assert.equal(overlaps(coachLayout.coach, coachLayout.driverPower), false,
    `coach must not cover the near-boat meter: ${JSON.stringify(coachLayout)}`);
  assert.equal(overlaps(coachLayout.coach, coachLayout.flight), false,
    `coach must not cover the fixed right-thumb flight zone: ${JSON.stringify(coachLayout)}`);
  assert.equal(overlaps(coachLayout.coach, coachLayout.drift), false,
    `coach must not cover the fixed right-thumb drift zone: ${JSON.stringify(coachLayout)}`);
  assert.equal(overlaps(coachLayout.coach, coachLayout.objective), false,
    `coach must not cover the objective block: ${JSON.stringify(coachLayout)}`);
  assert.equal(overlaps(coachLayout.coach, coachLayout.tower), false,
    `coach must not cover the race tower: ${JSON.stringify(coachLayout)}`);
  assert.equal(coachLayout.coachState.focus, 'drift-control');
  assert.ok(coachLayout.spotlight &&
    coachLayout.spotlight.left <= coachLayout.driftDisc.left && coachLayout.spotlight.right >= coachLayout.driftDisc.right &&
    coachLayout.spotlight.top <= coachLayout.driftDisc.top && coachLayout.spotlight.bottom >= coachLayout.driftDisc.bottom,
  `mobile drift onboarding must frame the actual fixed thumb control: ${JSON.stringify(coachLayout)}`);

  // Browsers may discard a hidden 2D backing store. Re-entering READY after a
  // real death must redraw the selected driver's radar, not show an empty box.
  await page.evaluate(() => window.__harness.scenario('flight-no-launch'));
  await page.evaluate(() => window.__harness.advance(0.6));
  await page.locator('.driver-radar').evaluate((canvas) => {
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  });
  await page.evaluate(() => window.__harness.advance(4.1));
  await page.evaluate(() => window.__harness.retry());
  await page.waitForTimeout(50);
  assert.equal((await page.evaluate(() => window.__harness.playerState())).phase, 'ready');
  const radarPixels = await page.locator('.driver-radar').evaluate((canvas) => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let visible = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 8) visible++;
    return visible;
  });
  assert.ok(radarPixels > 1200, `radar must redraw after death and READY restore: ${radarPixels} pixels`);

  await page.evaluate(() => window.__harness.scenario('start'));

  await safeSetViewportSize(page, { width: 390, height: 844 });
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.mobile-orientation').isVisible(), true, 'portrait must show the landscape blocker');
  assert.match(await page.locator('.mobile-orientation').textContent() ?? '', /仅支持横屏/);
  assert.equal(await page.locator('.driver-select-go').isVisible(), false, 'portrait blocker must own the whole interaction surface');
  assert.equal(await page.locator('[data-mobile-action="flight"]').isVisible(), false, 'portrait must expose no driving controls');
  const portraitFrozen = await page.evaluate(() => window.__harness.playerState());
  await page.evaluate(() => window.__harness.advance(1));
  const portraitAfter = await page.evaluate(() => window.__harness.playerState());
  assert.deepEqual(
    { raceTime: portraitAfter.raceTime, worldTime: portraitAfter.worldTime, x: portraitAfter.playerX, z: portraitAfter.playerZ },
    { raceTime: portraitFrozen.raceTime, worldTime: portraitFrozen.worldTime, x: portraitFrozen.playerX, z: portraitFrozen.playerZ },
    'portrait blocker must freeze gameplay instead of failing behind the overlay',
  );
  await safeSetViewportSize(page, { width: 844, height: 390 });
  await page.waitForTimeout(120);
  assert.equal(await page.locator('.mobile-orientation').isVisible(), false, 'rotating back must dismiss the blocker');
  assert.equal(await page.locator('[data-mobile-action="flight"]').isVisible(), true, 'landscape controls must recover after rotation');

  const mobileFinal = await page.evaluate(() => window.__harness.finalApproachCase());
  assert.ok(mobileFinal.maxBrakeEnvelope >= 0.9,
    `the mobile Final path must exercise the same return brake: ${JSON.stringify(mobileFinal)}`);
  await page.evaluate(() => window.__harness.advance(1 / 60));
  const finalControls = await page.evaluate(() => {
    const drift = document.querySelector('[data-mobile-action="drift"]');
    const flight = document.querySelector('[data-mobile-action="flight"]');
    const root = document.querySelector('.mobile-controls');
    return {
      drift:drift?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      driftLabel:drift?.getAttribute('aria-label') ?? '',
      flight:flight?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      flightDisabled:flight?.getAttribute('aria-disabled') ?? '',
      overlayHidden:root?.classList.contains('overlay-hidden') ?? false,
    };
  });
  assert.match(finalControls.drift, /刹.*BRAKE/);
  assert.equal(finalControls.driftLabel, '回港刹车');
  assert.match(finalControls.flight, /终.*FINAL/);
  assert.equal(finalControls.flightDisabled, 'true', 'Final flight control must be visibly and semantically inert');
  assert.equal(finalControls.overlayHidden, true,
    'the frozen mobile finale must hide the entire gameplay control layer');
  console.log('mobile controls contract: OK');
}

async function assertDriverSelectComposition(page, label) {
  const geometry = await page.evaluate(() => {
    const rect = (selector) => {
      const r = document.querySelector(selector)?.getBoundingClientRect();
      return r && { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height,
        centerX:(r.left + r.right) / 2, centerY:(r.top + r.bottom) / 2 };
    };
    return {
      width:innerWidth,
      height:innerHeight,
      featured:rect('.driver-featured'),
      portrait:rect('.driver-portrait-frame'),
      identity:rect('.driver-identity'),
      radar:rect('.driver-radar-wrap'),
      backdrop:rect('.driver-mobile-backdrop'),
      go:rect('.driver-select-go'),
      mobileBackdropStyle:(() => {
        const backdrop = document.querySelector('.driver-mobile-backdrop');
        const portrait = document.querySelector('.driver-portrait-frame > .driver-portrait-primary');
        if (!backdrop || !portrait) return null;
        const style = getComputedStyle(backdrop);
        const portraitStyle = getComputedStyle(portrait);
        return {
          display:style.display,
          opacity:Number(style.opacity),
          objectFit:style.objectFit,
          backdropSrc:backdrop.currentSrc,
          portraitSrc:portrait.currentSrc,
          portraitDisplay:getComputedStyle(portrait).display,
          portraitOpacity:Number(portraitStyle.opacity),
          portraitBlend:portraitStyle.mixBlendMode,
          naturalWidth:backdrop.naturalWidth,
          naturalHeight:backdrop.naturalHeight,
          coarse:matchMedia('(pointer:coarse)').matches,
          desktopStage:matchMedia('(pointer:fine) and (min-width:1366px) and (min-height:768px)').matches,
        };
      })(),
      radarBacking:(() => {
        const canvas = document.querySelector('.driver-radar');
        return canvas && { width:canvas.width, height:canvas.height, cssWidth:canvas.clientWidth, cssHeight:canvas.clientHeight, dpr:devicePixelRatio };
      })(),
      rosterIndex:document.querySelector('.driver-roster-index')?.textContent ?? '',
      switchControls:[...document.querySelectorAll('.driver-switch-control')].map((node) => rect(`.${node.classList.contains('driver-switch-previous') ? 'driver-switch-previous' : 'driver-switch-next'}`)),
      cardCount:document.querySelectorAll('.driver-card').length,
      visibleCardCount:[...document.querySelectorAll('.driver-card')]
        .filter((node) => node.getClientRects().length > 0 && node.getBoundingClientRect().width > 0).length,
      dotCount:document.querySelectorAll('.driver-dot').length,
      selectedDotCount:document.querySelectorAll('.driver-dot.selected').length,
      archiveCount:document.querySelectorAll('.driver-archive,.driver-archive-button').length,
    };
  });
  const { featured, portrait, identity, radar, go } = geometry;
  assert.ok(featured && portrait && identity && radar && go, `${label} driver composition is incomplete`);
  assert.ok(Math.abs(featured.centerX - geometry.width / 2) <= 1.5,
    `${label} featured stage is not centered: ${JSON.stringify(geometry)}`);
  assert.ok(Math.abs(go.centerX - geometry.width / 2) <= 1.5,
    `${label} contract GO must sit on the center axis: ${JSON.stringify(go)}`);
  assert.match(geometry.rosterIndex, /^选手 \d{2} \/ 06$/, `${label} must expose the current place in the six-driver roster`);
  assert.equal(geometry.switchControls.length, 2, `${label} needs previous and next driver controls`);
  if (geometry.mobileBackdropStyle?.coarse) {
    assert.ok(geometry.backdrop, `${label} needs a standing mobile portrait`);
    assert.equal(geometry.mobileBackdropStyle.display, 'block', `${label} standing portrait must be visible`);
    assert.equal(geometry.mobileBackdropStyle.objectFit, 'contain', `${label} standing portrait must never be cropped`);
    assert.ok(geometry.mobileBackdropStyle.opacity >= 0.06 && geometry.mobileBackdropStyle.opacity <= 0.18,
      `${label} standing portrait must remain a restrained background echo: ${JSON.stringify(geometry.mobileBackdropStyle)}`);
    assert.equal(geometry.mobileBackdropStyle.backdropSrc, geometry.mobileBackdropStyle.portraitSrc,
      `${label} background and selected driver must stay in sync`);
    assert.deepEqual(
      { width:geometry.mobileBackdropStyle.naturalWidth, height:geometry.mobileBackdropStyle.naturalHeight },
      { width:640, height:960 },
      `${label} standing portrait must use the 2:3 master`,
    );
    assert.ok(Math.abs(geometry.backdrop.width / geometry.backdrop.height - 2 / 3) < 0.02,
      `${label} standing portrait element lost its vertical aspect: ${JSON.stringify(geometry.backdrop)}`);
    assert.notEqual(geometry.mobileBackdropStyle.portraitDisplay, 'none', `${label} must retain a solid foreground portrait`);
    assert.ok(geometry.mobileBackdropStyle.portraitOpacity >= 0.9,
      `${label} foreground portrait must be solid enough to inspect: ${JSON.stringify(geometry.mobileBackdropStyle)}`);
    assert.equal(geometry.mobileBackdropStyle.portraitBlend, 'normal',
      `${label} foreground portrait must not inherit screen blending: ${JSON.stringify(geometry.mobileBackdropStyle)}`);
    assert.ok(radar.left - portrait.right >= 4 && radar.left - portrait.right <= 18,
      `${label} mobile decision column must sit beside, not over, the driver: ${JSON.stringify(geometry)}`);
    assert.ok(Math.abs(identity.left - radar.left) <= 2 && Math.abs(identity.right - radar.right) <= 2,
      `${label} identity and radar must form one right-side decision column: ${JSON.stringify(geometry)}`);
    assert.ok(radar.bottom <= identity.top + 1,
      `${label} radar and identity must not overlap: ${JSON.stringify(geometry)}`);
  } else {
    assert.ok(Math.abs(identity.centerX - geometry.width / 2) <= 1.5,
      `${label} desktop identity must anchor the screen center: ${JSON.stringify(identity)}`);
    assert.ok(portrait.right < identity.left && identity.right < radar.left,
      `${label} desktop stage must read portrait / identity / radar: ${JSON.stringify(geometry)}`);
    assert.ok(identity.left - portrait.right >= 20 && radar.left - identity.right >= 20,
      `${label} desktop panels need stable breathing room: ${JSON.stringify(geometry)}`);
    assert.ok(Math.abs(portrait.centerY - radar.centerY) <= 2,
      `${label} desktop portrait and radar left their shared axis: ${portrait.centerY} vs ${radar.centerY}`);
    assert.ok(Math.abs(portrait.width / portrait.height - 2 / 3) < 0.01,
      `${label} desktop portrait must preserve the 2:3 source frame: ${JSON.stringify(portrait)}`);
    assert.equal(geometry.mobileBackdropStyle?.display, 'none', `${label} desktop must retain the framed portrait composition`);
    assert.notEqual(geometry.mobileBackdropStyle?.portraitDisplay, 'none', `${label} desktop framed portrait disappeared`);
    const requiredDpr = Math.min(2, Math.max(1, geometry.radarBacking.dpr));
    assert.ok(geometry.radarBacking.width >= Math.floor(geometry.radarBacking.cssWidth * requiredDpr) - 1 &&
      geometry.radarBacking.height >= Math.floor(geometry.radarBacking.cssHeight * requiredDpr) - 1,
    `${label} radar backing store must cover CSS pixels at bounded DPR: ${JSON.stringify(geometry.radarBacking)}`);
  }
  assert.equal(geometry.cardCount, 6, `${label} must keep all six carousel destinations`);
  assert.equal(geometry.visibleCardCount, geometry.mobileBackdropStyle?.coarse
    ? 0
    : geometry.mobileBackdropStyle?.desktopStage ? 6 : 3,
    `${label} must use the viewport-appropriate roster presentation`);
  assert.equal(geometry.dotCount, 6, `${label} must expose six compact destination marks`);
  assert.equal(geometry.selectedDotCount, 1, `${label} must select one destination mark`);
  assert.equal(geometry.archiveCount, 0, `${label} must not render archive tools`);
  for (const [name, surface] of Object.entries({ featured, portrait, identity, radar })) {
    assert.ok(surface.left >= -1 && surface.right <= geometry.width + 1 && surface.top >= -1 && surface.bottom <= geometry.height + 1,
      `${label} ${name} clips outside the viewport: ${JSON.stringify(surface)}`);
  }
}

async function verifyDesktopDriverTransition(page) {
  const { before, during } = await page.evaluate(async () => {
    const frame = document.querySelector('.driver-portrait-frame').getBoundingClientRect();
    const before = {
      selected:document.querySelector('.driver-card.selected')?.dataset.driver ?? '',
      primary:document.querySelector('.driver-portrait-primary')?.currentSrc ?? '',
      frame:{ left:frame.left, top:frame.top, width:frame.width, height:frame.height },
    };
    const button = document.querySelector('.driver-switch-next');
    const selected = document.querySelector('.driver-card.selected');
    const cards = [...document.querySelectorAll('.driver-card')];
    const index = cards.indexOf(selected);
    const targetImage = cards[(index + 1) % cards.length]?.querySelector('img');
    await targetImage?.decode?.().catch(() => undefined);
    button.click();
    // Let the already-decoded portrait promise create its WAAPI animation,
    // then pin the intermediate frame before any wall-clock timer can fire.
    await Promise.resolve();
    await Promise.resolve();
    const animation = document.querySelector('.driver-portrait-incoming').getAnimations()[0];
    if (!animation) throw new Error('desktop portrait reveal animation did not start');
    animation.pause();
    animation.currentTime = 90;
    const root = document.querySelector('.driver-select');
    const incoming = document.querySelector('.driver-portrait-incoming');
    const primary = document.querySelector('.driver-portrait-primary');
    const frame2 = document.querySelector('.driver-portrait-frame').getBoundingClientRect();
    const style = getComputedStyle(incoming);
    const during = {
      selected:document.querySelector('.driver-card.selected')?.dataset.driver ?? '',
      switching:root.classList.contains('switching'),
      mode:root.dataset.transitionMode ?? '',
      primary:primary.currentSrc,
      incoming:incoming.currentSrc,
      incomingOpacity:Number(style.opacity),
      incomingClip:style.clipPath,
      contractCards:document.querySelectorAll('.driver-contract-card').length,
      frame:{ left:frame2.left, top:frame2.top, width:frame2.width, height:frame2.height },
    };
    return { before, during };
  });
  assert.notEqual(during.selected, before.selected, 'desktop next must change the logical selection immediately');
  assert.equal(during.switching, true, `desktop reveal must be active at 90ms: ${JSON.stringify(during)}`);
  assert.equal(during.mode, 'desktop');
  assert.equal(during.primary, before.primary, 'the old portrait must remain the stable reveal backing');
  assert.notEqual(during.incoming, during.primary, 'the incoming layer must contain only the destination portrait');
  assert.ok(during.incomingOpacity >= 0.99);
  assert.notEqual(during.incomingClip, 'inset(0px)',
    `the intermediate frame must be directionally clipped, never a full-image double exposure: ${JSON.stringify(during)}`);
  assert.equal(during.contractCards, 0, 'browse changes must not fabricate a DRIVER CONTRACT card');
  assert.deepEqual(during.frame, before.frame, 'portrait reveal must not reflow the stage');
  await page.evaluate(() => {
    document.querySelector('.driver-portrait-incoming').getAnimations()[0]?.finish();
  });
  await page.waitForFunction(() => !document.querySelector('.driver-select').classList.contains('switching'));
  let settled = await page.evaluate(() => ({
    switching:document.querySelector('.driver-select').classList.contains('switching'),
    selected:document.querySelector('.driver-card.selected')?.dataset.driver ?? '',
    selectedSrc:document.querySelector('.driver-card.selected img')?.currentSrc ?? '',
    primary:document.querySelector('.driver-portrait-primary')?.currentSrc ?? '',
    incomingOpacity:Number(getComputedStyle(document.querySelector('.driver-portrait-incoming')).opacity),
  }));
  assert.equal(settled.switching, false);
  assert.equal(settled.primary, settled.selectedSrc, 'settled hero must match the final logical selection');
  assert.equal(settled.incomingOpacity, 0);

  for (let i = 0; i < 8; i++) await page.locator('.driver-switch-next').click();
  const rapidTarget = await page.locator('.driver-card.selected').getAttribute('data-driver');
  await page.waitForTimeout(300);
  settled = await page.evaluate(() => ({
    switching:document.querySelector('.driver-select').classList.contains('switching'),
    selected:document.querySelector('.driver-card.selected')?.dataset.driver ?? '',
    selectedSrc:document.querySelector('.driver-card.selected img')?.currentSrc ?? '',
    primary:document.querySelector('.driver-portrait-primary')?.currentSrc ?? '',
    incomingOpacity:Number(getComputedStyle(document.querySelector('.driver-portrait-incoming')).opacity),
  }));
  assert.equal(settled.selected, rapidTarget, 'rapid browsing must keep the latest requested driver');
  assert.equal(settled.primary, settled.selectedSrc, 'rapid browsing must settle the hero on the latest driver');
  assert.equal(settled.switching, false);
  assert.equal(settled.incomingOpacity, 0);

  await page.emulateMedia({ reducedMotion:'reduce' });
  await page.locator('.driver-switch-next').click();
  await page.waitForTimeout(20);
  const reduced = await page.evaluate(() => ({
    switching:document.querySelector('.driver-select').classList.contains('switching'),
    selectedSrc:document.querySelector('.driver-card.selected img')?.currentSrc ?? '',
    primary:document.querySelector('.driver-portrait-primary')?.currentSrc ?? '',
    incomingOpacity:Number(getComputedStyle(document.querySelector('.driver-portrait-incoming')).opacity),
  }));
  assert.equal(reduced.switching, false, 'reduced motion must switch immediately');
  assert.equal(reduced.primary, reduced.selectedSrc);
  assert.equal(reduced.incomingOpacity, 0);
  await page.emulateMedia({ reducedMotion:'no-preference' });
}

async function waitForDriverRadarBacking(page) {
  await page.waitForFunction(() => {
    const radar = document.querySelector('.driver-radar');
    if (!(radar instanceof HTMLCanvasElement)) return false;
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const expectedWidth = Math.max(1, Math.round(radar.clientWidth * dpr));
    const expectedHeight = Math.max(1, Math.round(radar.clientHeight * dpr));
    return Math.abs(radar.width - expectedWidth) <= 1 &&
      Math.abs(radar.height - expectedHeight) <= 1;
  }, undefined, { timeout:2_000 });
}

async function verifyDesktopDriverViewports(page) {
  for (const viewport of [
    { width:1366, height:768 },
    { width:1920, height:1080 },
    { width:2560, height:1440 },
    { width:3440, height:1440 },
  ]) {
    try {
      await page.setViewportSize(viewport);
    } catch {
      // In headless browser environments, viewport resizing may be restricted by headless-shell window state
      break;
    }
    await waitForDriverRadarBacking(page);
    await assertDriverSelectComposition(page, `desktop-${viewport.width}x${viewport.height}`);
    const layout = await page.evaluate(() => {
      const selectors = ['.driver-select-header', '.driver-featured', '.driver-carousel', '.driver-select-footer'];
      const rects = selectors.map((selector) => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return { selector, left:rect.left, right:rect.right, top:rect.top, bottom:rect.bottom };
      });
      const cards = [...document.querySelectorAll('.driver-card')].map((card) => {
        const rect = card.getBoundingClientRect();
        return { id:card.dataset.driver, width:rect.width, height:rect.height };
      });
      return { rects, cards, scrollWidth:document.documentElement.scrollWidth, scrollHeight:document.documentElement.scrollHeight };
    });
    for (let i = 1; i < layout.rects.length; i++) {
      assert.ok(layout.rects[i - 1].bottom <= layout.rects[i].top + 1,
        `desktop bands must not overlap at ${viewport.width}x${viewport.height}: ${JSON.stringify(layout)}`);
    }
    assert.ok(layout.scrollWidth <= viewport.width && layout.scrollHeight <= viewport.height,
      `desktop selection must not scroll at ${viewport.width}x${viewport.height}: ${JSON.stringify(layout)}`);
    const widths = layout.cards.map((card) => card.width);
    assert.ok(Math.max(...widths) - Math.min(...widths) <= 1,
      `selected desktop card must not reflow the roster: ${JSON.stringify(layout.cards)}`);
  }
  await safeSetViewportSize(page, { width:1440, height:900 });
  await waitForDriverRadarBacking(page);
}

async function readMobileControlGeometry(page) {
  return page.evaluate(() => {
    const result = {};
    for (const action of ['left', 'right', 'drift', 'flight']) {
      const el = document.querySelector(`[data-mobile-action="${action}"]`);
      const r = el.getBoundingClientRect();
      const face = el.querySelector('span').getBoundingClientRect();
      const faceStyle = getComputedStyle(el.querySelector('span'));
      result[action] = {
        left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height,
        faceWidth:face.width, faceHeight:face.height, faceRadius:faceStyle.borderRadius,
        faceCenterX:(face.left + face.right) / 2, faceCenterY:(face.top + face.bottom) / 2,
        buttonBackground:getComputedStyle(el).backgroundColor,
      };
    }
    return { controls:result, width:innerWidth, height:innerHeight };
  });
}

async function assertMobileControlLayout(page, label, mode) {
  const geometry = await readMobileControlGeometry(page);
  const { drift, flight, left, right } = geometry.controls;
  for (const [name, control] of Object.entries({ drift, flight })) {
    assert.ok(control.width >= 140 && control.height >= 100,
      `${label} ${name} touch target is too small: ${control.width}x${control.height}`);
    assert.ok(control.faceCenterX > geometry.width * 0.58,
      `${label} ${name} left the right-thumb skill zone: ${JSON.stringify(control)}`);
    assert.ok(control.faceCenterY > geometry.height * 0.42 && control.bottom <= geometry.height,
      `${label} ${name} is outside the lower thumb-reach band: ${JSON.stringify(control)}`);
  }
  assert.ok(drift.faceCenterX > flight.faceCenterX && drift.faceCenterY > flight.faceCenterY,
    `${label} skill arc must keep drift lower-right and flight upper-left`);
  const faceGap = Math.hypot(drift.faceCenterX - flight.faceCenterX, drift.faceCenterY - flight.faceCenterY);
  assert.ok(faceGap > (drift.faceWidth + flight.faceWidth) * 0.52,
    `${label} skill faces visually collide: gap=${faceGap}`);
  if (mode === 'touch') {
    for (const [name, control] of Object.entries({ left, right })) {
      assert.ok(control.width >= 140 && control.height >= 100,
        `${label} ${name} touch target is too small: ${control.width}x${control.height}`);
      assert.ok(control.faceCenterX < geometry.width * 0.44,
        `${label} ${name} left the left-thumb steering zone: ${JSON.stringify(control)}`);
    }
    assert.ok(right.right < flight.left, `${label} steering and skill hit regions overlap`);
  }
  const hudCollisions = await page.evaluate(() => {
    const controls = [...document.querySelectorAll('.mobile-action-zones span, .mobile-steer-zones span')]
      .filter((element) => {
        const style = getComputedStyle(element.closest('button'));
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
      })
      .map((element) => ({ name:element.closest('button')?.dataset.mobileAction ?? 'control', rect:element.getBoundingClientRect() }));
    const surfaces = ['.race-tower-list', '.race-radio.on'].map((selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return null;
      return { name:selector, rect:element.getBoundingClientRect() };
    }).filter(Boolean);
    const hits = [];
    for (const control of controls) {
      for (const surface of surfaces) {
        const width = Math.min(control.rect.right, surface.rect.right) - Math.max(control.rect.left, surface.rect.left);
        const height = Math.min(control.rect.bottom, surface.rect.bottom) - Math.max(control.rect.top, surface.rect.top);
        if (width > 1 && height > 1) hits.push(`${control.name} x ${surface.name} (${width.toFixed(1)}x${height.toFixed(1)})`);
      }
    }
    return hits;
  });
  assert.deepEqual(hudCollisions, [], `${label} controls cover race context: ${hudCollisions.join(', ')}`);
  return geometry;
}

async function activateMobileForScreenshots(page, tiltControls) {
  const contractGo = page.locator('.driver-select-go');
  const legacyStart = page.locator('.mobile-start');
  if (await contractGo.isVisible()) await contractGo.click();
  else if (await legacyStart.isVisible()) await legacyStart.click();
  await page.waitForFunction(() => window.__harness.mobileStatus().activation === 'ready', null, { timeout: 3500 });
  let status = await page.evaluate(() => window.__harness.mobileStatus());
  const mode = page.locator('.mobile-mode');
  if (tiltControls && status.mode !== 'tilt') {
    await mode.click();
    await page.waitForFunction(() => {
      const s = window.__harness.mobileStatus();
      return s.activation === 'calibrating' || s.activation === 'ready';
    });
    status = await page.evaluate(() => window.__harness.mobileStatus());
  }
  if (tiltControls && status.activation === 'calibrating') {
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => {
        const event = new Event('deviceorientation');
        Object.defineProperties(event, {
          beta: { value: 0.6 },
          gamma: { value: 0.4 },
        });
        window.dispatchEvent(event);
      });
      await page.waitForTimeout(55);
    }
  }
  await page.waitForFunction(() => window.__harness.mobileStatus().activation === 'ready', null, { timeout: 3500 });
  assert.equal((await page.evaluate(() => window.__harness.mobileStatus())).mode,
    tiltControls ? 'tilt' : 'touch', `mobile screenshot must use the requested ${tiltControls ? 'tilt' : 'touch'} mode`);
}

async function verifyPerformanceContract(page) {
  const assertBudget = async (label) => {
    const stats = await page.evaluate(() => window.__harness.stats());
    assert.equal(stats.quality, 'auto');
    assert.ok(stats.drawingPixels <= 2_120_000,
      `${label} drawing buffer exceeds Auto budget: ${stats.drawingPixels}`);
    assert.ok(stats.pixelRatio >= 0.5 && stats.pixelRatio <= 1.25,
      `${label} pixel ratio out of bounds: ${stats.pixelRatio}`);
    return stats;
  };

  await page.evaluate(() => window.__harness.scenario('start'));
  await page.evaluate(() => window.__harness.render());
  let stats = await assertBudget('1440x900');
  assert.ok(stats.calls <= 600, `Auto start draw calls ${stats.calls} exceed 600`);
  assert.equal(stats.desktopClarity, 1, 'desktop Auto must expose the headroom clarity governor');
  const baseRatio = stats.pixelRatio;
  await page.evaluate(() => window.__harness.perfFrames(16.7, 260));
  stats = await page.evaluate(() => window.__harness.stats());
  assert.ok(stats.pixelRatio > baseRatio, `sustained headroom must sharpen desktop Auto (${baseRatio} -> ${stats.pixelRatio})`);
  assert.ok(stats.drawingPixels <= stats.clarityPixelBudget + 25_000,
    `clarity governor exceeded its hard drawing budget: ${stats.drawingPixels}`);
  const sharpRatio = stats.pixelRatio;
  await page.evaluate(() => window.__harness.perfFrames(28, 90));
  stats = await page.evaluate(() => window.__harness.stats());
  assert.ok(stats.pixelRatio < sharpRatio, `frame pressure must quickly lower clarity (${sharpRatio} -> ${stats.pixelRatio})`);

  const beforeBurst = stats.resizeCount;
  await page.evaluate(() => {
    for (let i = 0; i < 12; i++) window.dispatchEvent(new Event('resize'));
  });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  stats = await page.evaluate(() => window.__harness.stats());
  assert.equal(stats.resizeCount, beforeBurst + 1, 'one resize burst must rebuild render targets exactly once');

  for (const viewport of [
    { label: '1920x1080', width: 1920, height: 1080 },
    { label: '4k', width: 3840, height: 2160 },
  ]) {
    if (!await safeSetViewportSize(page, { width: viewport.width, height: viewport.height })) break;
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await assertBudget(viewport.label);
  }

  await safeSetViewportSize(page, { width: 1440, height: 900 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const sample = await page.evaluate(() => window.__harness.perfSample(45));
  assert.ok(sample.calls <= 600, `sampled Auto start draw calls ${sample.calls} exceed 600`);
  console.log(`performance contract: OK (${sample.drawingPixels} px, calls ${sample.calls}, ` +
    `software p50/p95/p99 ${Number(sample.p50).toFixed(1)}/${Number(sample.p95).toFixed(1)}/${Number(sample.p99).toFixed(1)}ms)`);
}

async function assertHudDoesNotOverlap(page, label) {
  const overlaps = await page.evaluate(() => {
    const selectors = ['.hud-topleft', '.hud-map', '.hud-power', '.hud-speedo', '.hud-flight-prompt'];
    const items = selectors.map((selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const style = getComputedStyle(el);
      if (style.display === 'none' || Number(style.opacity) === 0) return null;
      const r = el.getBoundingClientRect();
      return { selector, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    }).filter(Boolean);
    const hits = [];
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w > 1 && h > 1) hits.push(`${a.selector} x ${b.selector} (${w.toFixed(1)}x${h.toFixed(1)})`);
      }
    }
    return hits;
  });
  assert.deepEqual(overlaps, [], `${label} HUD overlap: ${overlaps.join(', ')}`);
}

async function assertBattleLeavesDrivingRoiClear(page, label) {
  const hits = await page.evaluate(() => {
    const battle = document.querySelector('.hud-battle');
    if (!battle?.classList.contains('on')) return [];
    const w = innerWidth;
    const h = innerHeight;
    const portrait = w <= 600 && h > 520;
    const roi = portrait
      ? { left: w * 0.16, right: w * 0.84, top: h * 0.30, bottom: h * 0.88 }
      : { left: w * 0.28, right: w * 0.72, top: h * 0.24, bottom: h * 0.84 };
    const selectors = [
      '.hud-battle-sky',
      '.hud-battle-copy',
      '.hud-battle-sky-flash',
      '.hud-battle-shard',
    ];
    const collisions = [];
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        const iw = Math.min(r.right, roi.right) - Math.max(r.left, roi.left);
        const ih = Math.min(r.bottom, roi.bottom) - Math.max(r.top, roi.top);
        if (iw > 1 && ih > 1) collisions.push(`${selector} (${iw.toFixed(1)}x${ih.toFixed(1)})`);
      }
    }
    return collisions;
  });
  assert.deepEqual(hits, [], `${label} battle obscures driving ROI: ${hits.join(', ')}`);
}

async function assertBattleFeedbackVisible(page, label) {
  const feedback = await page.evaluate(() => {
    const battle = document.querySelector('.hud-battle');
    const sky = document.querySelector('.hud-battle-sky');
    const copy = document.querySelector('.hud-battle-copy');
    if (!battle || !sky || !copy) return { active: false, visible: false, detail: 'missing DOM' };
    const rootStyle = getComputedStyle(battle);
    const copyStyle = getComputedStyle(copy);
    const compact = innerHeight <= 520;
    const starStyle = getComputedStyle(sky, '::before');
    const visible = compact
      ? starStyle.content !== 'none' && Number(starStyle.opacity) > 0.2
      : copyStyle.display !== 'none' && Number(copyStyle.opacity) > 0.5 && copy.getBoundingClientRect().width > 80;
    return {
      active: battle.classList.contains('on'),
      visible,
      detail: compact ? `star=${starStyle.content}/${starStyle.opacity}` : `copy=${copyStyle.display}/${copyStyle.opacity}`,
      transparentRoot: rootStyle.backgroundColor === 'rgba(0, 0, 0, 0)',
      text: copy.textContent ?? '',
    };
  });
  assert.equal(feedback.active, true, `${label} battle channel is not active`);
  assert.equal(feedback.visible, true, `${label} has no visible overtake feedback (${feedback.detail})`);
  assert.equal(feedback.transparentRoot, true, `${label} battle root must not add a full-screen plate`);
  assert.match(feedback.text, /OVERTAKE|LEAD TAKEN/, `${label} must name the competitive event`);
}

async function assertCompactActionPromptLeavesDrivingRoiClear(page, label) {
  const hit = await page.evaluate(() => {
    if (innerHeight > 520) return null;
    const prompt = document.querySelector('.hud-flight-prompt.on');
    if (!prompt) return null;
    const r = prompt.getBoundingClientRect();
    const roi = {
      left: innerWidth * 0.28,
      right: innerWidth * 0.72,
      top: innerHeight * 0.24,
      bottom: innerHeight * 0.84,
    };
    const w = Math.min(r.right, roi.right) - Math.max(r.left, roi.left);
    const h = Math.min(r.bottom, roi.bottom) - Math.max(r.top, roi.top);
    return w > 1 && h > 1 ? `${w.toFixed(1)}x${h.toFixed(1)}` : null;
  });
  assert.equal(hit, null, `${label} F prompt obscures the compact driving ROI (${hit})`);
}

async function main() {
  const args = process.argv.slice(2);
  const wantStats = args.includes('--stats');
  const responsive = args.includes('--responsive');
  const verifyFlight = args.includes('--verify-flight');
  const verifyMobile = args.includes('--verify-mobile');
  const verifyPerformance = args.includes('--verify-performance');
  const mobile = args.includes('--mobile');
  globalDpr = mobile ? 3 : 2;
  const tiltControls = args.includes('--tilt');
  const names = args.filter((a) => !a.startsWith('--'));
  const selected = names.length ? names : (verifyFlight || verifyMobile || verifyPerformance) ? [] : Object.keys(SCENARIOS);

  mkdirSync(OUT, { recursive: true });

  const server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));

  let browser;
  try {
    await waitForServer(`http://localhost:${PORT}/`);
    browser = await chromium.launch({
      headless: true,
      ...(chromePath ? { executablePath: chromePath } : {}),
      // CI containers commonly expose no /dev/dri. ANGLE's software backend
      // still exercises the real WebGL pipeline and keeps screenshots usable.
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist',
        '--disable-gpu-sandbox',
      ],
    });
    const page = await browser.newPage({
      viewport: mobile ? { width: 844, height: 390 } : { width: 1440, height: 900 },
      deviceScaleFactor: mobile ? 3 : 2,
      reducedMotion: 'no-preference',
      ...(mobile ? { hasTouch: true, isMobile: true } : {}),
    });
    await safeSetViewportSize(page, mobile ? { width: 844, height: 390 } : { width: 1440, height: 900 });
    await page.addInitScript(() => {
      const createPad = (index, id) => {
        const buttons = Array.from({ length: 18 }, () => ({ pressed:false, touched:false, value:0 }));
        const effects = [];
        const actuator = {
          effects:['dual-rumble'],
          playEffect(type, options) {
            effects.push({ kind:'play', type, options:{ ...options } });
            return Promise.resolve('complete');
          },
          reset() {
            effects.push({ kind:'reset' });
            return Promise.resolve('complete');
          },
        };
        return {
          connected:false,
          effects,
          gamepad:{
            id, index, connected:true, timestamp:0, mapping:'standard',
            axes:[0,0,0,0], buttons, vibrationActuator:actuator,
          },
        };
      };
      const pads = [
        createPad(0, 'Board Race Idle Controller'),
        createPad(1, 'Thunderobot G50S Test Controller'),
      ];
      const padAt = (index) => {
        const pad = pads[index];
        if (!pad) throw new Error(`unknown virtual pad ${index}`);
        return pad;
      };
      const clearPad = (pad) => {
        pad.gamepad.axes.fill(0);
        for (const button of pad.gamepad.buttons) Object.assign(button, { pressed:false, touched:false, value:0 });
        pad.gamepad.timestamp++;
      };
      const fixture = {
        connect(index = 0) { const pad = padAt(index); pad.connected = true; pad.gamepad.timestamp++; },
        disconnect(index = 0) { const pad = padAt(index); pad.connected = false; pad.gamepad.timestamp++; },
        axis(index, value) { this.padAxis(0, index, value); },
        padAxis(padIndex, index, value) {
          const pad = padAt(padIndex);
          pad.gamepad.axes[index] = value;
          pad.gamepad.timestamp++;
        },
        button(index, pressed) { this.padButton(0, index, pressed); },
        padButton(padIndex, index, pressed) {
          const pad = padAt(padIndex);
          const button = pad.gamepad.buttons[index];
          Object.assign(button, { pressed, touched:pressed, value:pressed ? 1 : 0 });
          pad.gamepad.timestamp++;
        },
        clear(index = 0) { clearPad(padAt(index)); },
        clearAll() { for (const pad of pads) clearPad(pad); },
        disconnectAll() { for (const pad of pads) { pad.connected = false; pad.gamepad.timestamp++; } },
        configure(index, { id, mapping } = {}) {
          const pad = padAt(index);
          if (id !== undefined) pad.gamepad.id = id;
          if (mapping !== undefined) pad.gamepad.mapping = mapping;
          pad.gamepad.timestamp++;
        },
        effects(index = 0) { return padAt(index).effects.map((entry) => structuredClone(entry)); },
        clearEffects(index = null) {
          if (index === null) for (const pad of pads) pad.effects.length = 0;
          else padAt(index).effects.length = 0;
        },
        vibrations() { return [...vibrationLog]; },
        clearVibrations() { vibrationLog.length = 0; },
      };
      const vibrationLog = [];
      Object.defineProperty(window, '__gamepadFixture', { value:fixture });
      Object.defineProperty(navigator, 'vibrate', {
        configurable:true,
        value:(pattern) => {
          vibrationLog.push(pattern);
          return true;
        },
      });
      Object.defineProperty(navigator, 'getGamepads', {
        configurable:true,
        value:() => pads.map((pad) => pad.connected ? pad.gamepad : null),
      });
    });
    page.on('pageerror', (err) => console.error(`[pageerror] ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') console.error(`[console.${msg.type()}] ${msg.text()}`);
    });

    await page.goto(`${BASE}${mobile ? '&mobile=1' : ''}`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => window.__harness?.ready, null, { timeout: 60000 });

    if (verifyFlight) {
      await page.evaluate(() => localStorage.clear());
      await page.reload({ waitUntil: 'load', timeout: 60000 });
      await page.waitForFunction(() => window.__harness?.ready, null, { timeout: 60000 });
      await safeSetViewportSize(page, mobile ? { width: 844, height: 390 } : { width: 1440, height: 900 });
      await verifyFlightContract(page);
      await verifyGamepadContract(page);
    }
    if (verifyMobile) {
      // Reproduce the exact browser state created by the rejected v7 release:
      // a complete dormant novice record whose automatic eligibility was false.
      await page.evaluate(() => {
        localStorage.clear();
        localStorage.setItem('board-race:challenge:v7', JSON.stringify({
          version:7, runs:2, ordinaryUnlocked:false, manMedalsTotal:0, excellentCount:0,
          bestQualificationTime:null, bestExcellentTime:null, bestFlights:0,
          bestRouteProgress:0, closestMissM:null, bestFlightsByDriver:{},
          farSeaDossierUnlocked:false, rivalWins:0, finaleCompletions:0,
          expansionSeenMask:0, finaleScreenshotCount:0,
          coach:{
            status:'dormant', automaticEligible:false,
            mastery:{ steered:false, bankedCharge:false, launched:false, passedRoute:false, airBrakedInTurn:false, extendedFlight:false },
            knowledge:{ bankRule:false, inventory:false, flightGauge:false, extension:false },
          },
        }));
      });
      await page.reload({ waitUntil: 'load', timeout: 60000 });
      await page.waitForFunction(() => window.__harness?.ready, null, { timeout: 60000 });
      await safeSetViewportSize(page, mobile ? { width: 844, height: 390 } : { width: 1440, height: 900 });
      await verifyMobileControls(page);
    }
    if (verifyPerformance) await verifyPerformanceContract(page);
    if (mobile && selected.length) {
      await activateMobileForScreenshots(page, tiltControls);
      const mode = page.locator('.mobile-mode');
      if (!tiltControls) {
        assert.equal(await page.locator('.mobile-controls').evaluate((el) => el.classList.contains('touch-steer')), true,
          'default touch steering must expose the two steering zones');
        assert.equal(await mode.textContent(), '转向 · 触控', 'the mode switch must identify default touch steering');
      }
    }

    const mobileSuffix = mobile ? (tiltControls ? '-mobile-tilt' : '-mobile') : '';

    for (const name of selected) {
      const def = SCENARIOS[name];
      if (!def) {
        console.error(`unknown scenario "${name}" — known: ${Object.keys(SCENARIOS).join(', ')}`);
        continue;
      }
      let releaseExpansionImage = null;
      let expansionRoutePattern = null;
      let expansionRouteHandler = null;
      let expansionRequestListener = null;
      const expansionImageRequests = [];
      if (name === 'expansion-gallery') {
        let releaseGate;
        const loadGate = new Promise((resolve) => { releaseGate = resolve; });
        let delayed = false;
        releaseExpansionImage = () => releaseGate();
        expansionRoutePattern = /\/desert(?:-[^/]*)?\.webp(?:\?.*)?$/;
        expansionRouteHandler = async (route) => {
          if (!delayed) {
            delayed = true;
            await loadGate;
            await route.abort('failed');
            return;
          }
          await route.continue();
        };
        expansionRequestListener = (request) => {
          if (/\/assets\/expansions\/[^/?]+\.webp(?:\?.*)?$/.test(request.url())) {
            expansionImageRequests.push(request.url());
          }
        };
        page.on('request', expansionRequestListener);
        await page.route(expansionRoutePattern, expansionRouteHandler);
      }
      console.log(`scenario: ${name} ...`);
      await page.evaluate((n) => window.__harness.scenario(n), def.scenario);
      if (name === 'final-station') {
        const finalState = await page.evaluate(() => window.__harness.playerState());
        assert.equal(finalState.phase, 'finished', `final station must finish after seven routes: ${JSON.stringify(finalState)}`);
        assert.equal(finalState.flightsCleared, 7);
        assert.equal(finalState.finaleActive, true);
      }
      if (name === 'expansion-gallery') {
        const gallery = page.locator('.expansion-gallery');
        const galleryImage = page.locator('.expansion-gallery-image');
        const galleryLoader = page.locator('.expansion-gallery-loader');
        const mobileControls = page.locator('.mobile-controls');
        const title = page.locator('.expansion-gallery-name');
        const tabs = page.locator('.expansion-gallery-dots button');
        const waitForImage = () => page.waitForFunction(() => {
          const root = document.querySelector('.expansion-gallery');
          const image = document.querySelector('.expansion-gallery-image');
          return root?.classList.contains('on') && !root.classList.contains('loading') &&
            !root.classList.contains('load-error') && image?.classList.contains('ready');
        }, null, { timeout: 10000 });
        assert.equal(await gallery.evaluate((element) => element.classList.contains('on')), true,
          'expansion gallery must open from the frozen finale');
        await page.waitForFunction(() => document.querySelector('.expansion-gallery')?.classList.contains('loading'));
        assert.equal(await gallery.getAttribute('aria-busy'), 'true', 'slow images must expose a busy loading state');
        assert.equal(await galleryLoader.isVisible(), true, 'slow images must show a visible loading surface');
        assert.equal(await galleryLoader.locator('strong').textContent(), '正在载入资料片');
        assert.equal(await galleryLoader.locator('span').textContent(), '01 / 07');
        assert.equal(await page.locator('.expansion-gallery-return').isVisible(), true,
          'return to results must remain available during image loading');
        await page.screenshot({ path: path.join(OUT, `expansion-gallery-loading${mobileSuffix}.png`) });
        if (mobile) {
          assert.equal(await mobileControls.evaluate((element) => element.classList.contains('overlay-hidden')), true,
            'the mobile control layer must yield every game-control pixel to the dossier');
          for (const selector of ['.mobile-start', '.mobile-mode', '.mobile-action-zones', '.mobile-steer-zones', '.mobile-tilt-meter']) {
            assert.equal(await page.locator(selector).isVisible(), false,
              `${selector} must stay hidden while the dossier is open`);
          }
        }
        releaseExpansionImage();
        await page.waitForFunction(() => document.querySelector('.expansion-gallery')?.classList.contains('load-error'));
        assert.equal(await galleryLoader.locator('strong').textContent(), '图片载入失败');
        assert.equal(await galleryLoader.locator('button').isVisible(), true,
          'a failed image must offer an explicit retry instead of a blank screen');
        await page.unroute(expansionRoutePattern, expansionRouteHandler);
        await galleryLoader.locator('button').click();
        await waitForImage();
        assert.equal(await galleryLoader.isVisible(), false, 'the loading surface must leave after the image is decoded');
        assert.equal(await galleryImage.evaluate((image) => image.naturalWidth > 0), true);
        assert.deepEqual([...new Set(expansionImageRequests.map((url) => new URL(url).pathname.split('/').pop()))], ['desert.webp'],
          'opening page one must not prefetch neighboring expansion images');
        assert.equal(await tabs.count(), 7, 'expansion gallery must list seven planned games');
        assert.deepEqual(await tabs.allTextContents(), [
          '沙漠：圣甲虫', '城市：磁轨轮滑手', '雪地：北极狐', '沼泽：树蛙',
          '丛林：长臂猿', '外星：浮空鳐形生命', '肠道：益生菌',
        ]);
        assert.equal(await title.textContent(), '沙漠：圣甲虫');
        await page.keyboard.press('ArrowRight');
        await waitForImage();
        assert.equal(await title.textContent(), '城市：磁轨轮滑手', 'right arrow must advance one page');
        await tabs.nth(6).click();
        await waitForImage();
        assert.equal(await title.textContent(), '肠道：益生菌', 'Chinese game tab must jump directly to its page');
        assert.equal(await page.locator('.expansion-gallery-arrow.next').isDisabled(), true,
          'last page must not wrap to the first page');
        await page.keyboard.press('Escape');
        assert.equal(await gallery.evaluate((element) => element.classList.contains('on')), false,
          'Escape must return to the frozen finale');
        if (mobile) {
          assert.equal(await mobileControls.evaluate((element) => element.classList.contains('overlay-hidden')), true,
            'returning to the frozen finale must keep gameplay controls out of the result composition');
        }
        await page.locator('[data-action="gallery"]').click();
        if (mobile) {
          assert.equal(await mobileControls.evaluate((element) => element.classList.contains('overlay-hidden')), true,
            'reopening the dossier must hide mobile controls again');
        }
        await waitForImage();
        assert.equal(await title.textContent(), '沙漠：圣甲虫', 'reopening starts from the first dossier page');
        const galleryBox = await gallery.boundingBox();
        assert.ok(galleryBox, 'visible gallery must expose a swipe surface');
        await page.mouse.move(galleryBox.x + galleryBox.width * 0.68, galleryBox.y + galleryBox.height * 0.6);
        await page.mouse.down();
        await page.mouse.move(galleryBox.x + galleryBox.width * 0.54, galleryBox.y + galleryBox.height * 0.6, { steps: 4 });
        await page.mouse.up();
        await waitForImage();
        assert.equal(await title.textContent(), '城市：磁轨轮滑手', 'left swipe must advance one page');
        await tabs.nth(0).click();
        await waitForImage();
        if (expansionRequestListener) page.off('request', expansionRequestListener);
      }
      if (def.timeout) await page.waitForTimeout(0); // scenario itself blocks in evaluate
      if (def.settleMs) await page.waitForTimeout(def.settleMs);

      if (def.freeCamDynamic) {
        await page.evaluate((cfg) => {
          const h = window.__harness;
          // Ask the game for the player pose via stats-free path: use chaseCam-relative math in page.
          const p = cfg.target === 'opponent'
            ? window.__harness.driftingOpponentPose()
            : window.__harness.playerPose();
          const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
          h.freeCam(
            p.x - fx * cfg.back, p.y + cfg.up, p.z - fz * cfg.back,
            p.x + fx * 2, p.y + cfg.lookUp, p.z + fz * 2,
          );
        }, def.freeCamDynamic);
      }

      await page.evaluate(() => window.__harness.render());
      await assertBattleLeavesDrivingRoiClear(page, name);
      await assertCompactActionPromptLeavesDrivingRoiClear(page, name);
      await page.screenshot({ path: path.join(OUT, `${name}${mobileSuffix}.png`) });
      if (name === 'final-station') {
        const impactState = await page.evaluate(() => window.__harness.playerState());
        assert.ok(['impact', 'crown'].includes(impactState.finaleVisualPhase),
          `final station impact phase must be visible: ${JSON.stringify(impactState)}`);
        const frozenPose = {
          x: impactState.playerX, y: impactState.playerY, z: impactState.playerZ,
          heading: impactState.heading, raceTime: impactState.raceTime, worldTime: impactState.worldTime,
        };
        await page.evaluate(() => window.__harness.advance(0.65));
        await page.evaluate(() => window.__harness.render());
        const heroState = await page.evaluate(() => window.__harness.playerState());
        assert.ok(['crown', 'hero'].includes(heroState.finaleVisualPhase),
          `final station hero phase must be visible: ${JSON.stringify(heroState)}`);
        assert.deepEqual({
          x: heroState.playerX, y: heroState.playerY, z: heroState.playerZ,
          heading: heroState.heading, raceTime: heroState.raceTime, worldTime: heroState.worldTime,
        }, frozenPose, 'finale presentation must freeze race state during the hero beat');
        await page.screenshot({ path: path.join(OUT, `final-station-hero${mobileSuffix}.png`) });
        await page.evaluate(() => window.__harness.advance(2.6));
        await page.evaluate(() => window.__harness.render());
        const settledState = await page.evaluate(() => window.__harness.playerState());
        assert.equal(settledState.finaleVisualPhase, 'settled');
        assert.equal(settledState.finaleActionsVisible, true, 'finale actions must wait for the minimum read');
        assert.equal(settledState.finaleFocusedAction, 'gallery',
          'the mysterious dossier must own default keyboard/gamepad confirmation');
        assert.match(await page.locator('[data-action="gallery"]').textContent() ?? '', /神秘资料片/);
        if (mobile) {
          assert.equal(await page.locator('.mobile-controls').evaluate((element) =>
            element.classList.contains('overlay-hidden')), true,
          'the frozen finale must not leave touch controls over the primary dossier action');
        }
        await page.screenshot({ path: path.join(OUT, `final-station-settled${mobileSuffix}.png`) });
      }
      if (wantStats) console.log(JSON.stringify(await page.evaluate(() => window.__harness.stats())));
      console.log(`  -> shots/${name}${mobileSuffix}.png`);

      if (responsive) {
        const viewports = mobile ? [
          { suffix: tiltControls ? 'tilt-844x390' : 'touch-844x390', width:844, height:390 },
          { suffix: tiltControls ? 'tilt-844x330' : 'touch-844x330', width:844, height:330 },
          { suffix: tiltControls ? 'tilt-844x300' : 'touch-844x300', width:844, height:300 },
          { suffix: tiltControls ? 'tilt-932x430' : 'touch-932x430', width:932, height:430 },
        ] : name === 'ready' ? [
          { suffix:'844x390', width:844, height:390 },
          { suffix:'844x330', width:844, height:330 },
          { suffix:'844x300', width:844, height:300 },
          { suffix:'932x430', width:932, height:430 },
        ] : [
          { suffix:'landscape', width:844, height:390 },
        ];
        for (const vp of viewports) {
          if (!await safeSetViewportSize(page, { width: vp.width, height: vp.height })) break;
          await page.waitForTimeout(120); // allow ResizeObserver + renderer targets to settle
          await page.evaluate(() => window.__harness.render());
          await page.waitForTimeout(20);
          if (name === 'ready') await assertDriverSelectComposition(page, `${name}-${vp.suffix}`);
          if (mobile) await assertMobileControlLayout(page, `${name}-${vp.suffix}`, tiltControls ? 'tilt' : 'touch');
          await assertHudDoesNotOverlap(page, `${name}-${vp.suffix}`);
          await assertBattleLeavesDrivingRoiClear(page, `${name}-${vp.suffix}`);
          await assertCompactActionPromptLeavesDrivingRoiClear(page, `${name}-${vp.suffix}`);
          await page.screenshot({ path: path.join(OUT, `${name}-${vp.suffix}.png`) });
          console.log(`  -> shots/${name}-${vp.suffix}.png`);
        }
        await safeSetViewportSize(page, mobile ? { width:844, height:390 } : { width:1440, height:900 });
        await page.waitForTimeout(120);
      }
    }
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
