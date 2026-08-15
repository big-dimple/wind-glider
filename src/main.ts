/**
 * main.ts — integration shell. Wires every subsystem together, owns the
 * game flow (countdown → racing → defeat/loading), and exposes the deterministic
 * screenshot-harness API (?harness=1) used by harness/screenshot.mjs.
 *
 * Step/render split: EVERYTHING that moves updates in step() at fixed
 * SIM_DT (deterministic — the harness can advance the sim with no rendering);
 * render() only draws (prepass + composer).
 */
import * as THREE from 'three';

// Cel pipeline contract: authored palette colors hit the screen verbatim
// (no sRGB→linear→sRGB round trip). Must run before any Color is constructed.
THREE.ColorManagement.enabled = false;

import { Stage, resolveQualityMode } from './core/stage';
import { PrePass } from './core/prePass';
import { Loop } from './core/loop';
import { Input } from './core/input';
import { GamepadInput } from './core/gamepadInput';
import { Haptics, type HapticCue } from './core/haptics';
import { MobileControls } from './core/mobileControls';
import { Ocean } from './water/ocean';
import { WakeRibbon } from './water/wake';
import { SpraySystem } from './water/spray';
import { Sky } from './cel/sky';
import { createPostPipeline } from './cel/postPipeline';
import { Boat } from './game/boat';
import { JetTrailSystem } from './game/jetTrail';
import { Rider } from './game/rider';
import { CHECKPOINT_US, Course, GRID_SLOTS } from './game/course';
import {
  buildRaceRoster,
  driverProfile,
  loadSelectedDriver,
  saveSelectedDriver,
} from './game/racers';
import { RecordsStore } from './game/records';
import {
  DrivingCoach,
  type CoachInputDevice,
  type CoachControls,
  type CoachPresentation,
} from './game/drivingCoach';
import {
  PcControlPrimer,
  type PcControlPrimerPresentation,
} from './game/pcControlPrimer';
import { Race } from './game/race';
import { AIController } from './game/ai';
import { RivalDirector } from './game/rivalDirector';
import { BoatCollisionSystem } from './game/collision';
import { CameraRig } from './game/chaseCamera';
import { HUD } from './hud/hud';
import { GameAudio } from './audio/audio';
import { MixerControls } from './audio/mixerControls';
import { DriverSelect } from './hud/driverSelect';
import { RaceTower } from './hud/raceTower';
import { FinaleOverlay } from './hud/finaleOverlay';
import { ExpansionGallery } from './hud/expansionGallery';
import { CaptureService } from './core/capture';
import { trackGameEvent } from './game/eventLog';
import type { BoatInput, BoatState, ChallengeTier, CourseGuidanceStatus, CourseSample, FlightRouteState } from './contracts';
import { deriveAbilityHudState } from './core/abilityTelemetry';

const params = new URLSearchParams(location.search);
const HARNESS = params.has('harness');
const DESKTOP_DRIVER_STAGE = window.matchMedia('(pointer: fine) and (min-width: 1366px) and (min-height: 768px)');
// Existing deterministic endurance probes intentionally exercise the optional
// post-finale continuation. Normal players always reach Final Station.
let harnessEndlessMode = HARNESS && !params.has('finale');

// ------------------------------------------------------------ construction
const app = document.getElementById('app')!;
const stage = new Stage(app, resolveQualityMode(params.get('quality')));
const prePass = new PrePass(4, 4);

const sky = new Sky();
stage.scene.add(sky.object);

const ocean = new Ocean({
  depthTexture: prePass.depthTexture,
  cameraNear: stage.camera.near,
  cameraFar: stage.camera.far,
});
stage.scene.add(ocean.object);

const spray = new SpraySystem();
stage.scene.add(spray.object);

const jetTrail = new JetTrailSystem();
stage.scene.add(jetTrail.object);

const course = new Course();
stage.scene.add(course.object);
const records = new RecordsStore();
const drivingCoach = new DrivingCoach(records.data.coach, (progress) => records.saveCoach(progress));
const pcControlPrimer = new PcControlPrimer();
let selectedDriverId = loadSelectedDriver();
let roster = buildRaceRoster(selectedDriverId);

// Boats + riders + wakes. Boat 0 is the player.
const boats: Boat[] = [];
const riders: Rider[] = [];
const wakes: WakeRibbon[] = [];
for (const racer of roster) {
  const detailedInk = racer.id === 0 || stage.quality.detailedAiInk;
  const wake = new WakeRibbon();
  stage.scene.add(wake.object);
  wakes.push(wake);
  const boat = new Boat({ id: racer.id, color: racer.color, wake, spray, trail: jetTrail, detailedInk });
  boat.setDriver(racer.color, driverProfile(racer.profileId).handling);
  stage.scene.add(boat.object);
  boats.push(boat);
  const rider = new Rider({ color: racer.color, detailedInk });
  boat.riderMount.add(rider.object);
  riders.push(rider);
}

const rivalDirector = new RivalDirector();
rivalDirector.setRoster(roster);
let ais = buildAiControllers();
const collisions = new BoatCollisionSystem();

const cameraRig = new CameraRig(stage.camera);
const audio = new GameAudio();
window.addEventListener('keydown', () => {
  audio.resume();
  audio.startReadyMusic();
});
window.addEventListener('pointerdown', () => {
  audio.resume();
  audio.startReadyMusic();
}, { passive: true });

const hudLayer = document.createElement('div');
hudLayer.id = 'hud-layer';
hudLayer.style.cssText = 'position:fixed;inset:0;pointer-events:none;overflow:hidden;';
app.appendChild(hudLayer);
const capture = new CaptureService(stage.renderer.domElement);
let medalCapture: Blob | null = null;
let finaleCapture: Blob | null = null;
const mobileInput = new MobileControls(app, () => {
  audio.resume();
  audio.startReadyMusic();
}, params.has('mobile'));
const hud = new HUD(
  hudLayer,
  course,
  requestRetry,
  records.data.bestFlights,
  resumeInterruption,
  stage.camera,
  saveMedalCapture,
  disableDrivingCoach,
  dismissPcControlPrimer,
);
const mixer = new MixerControls(app, audio);
const tower = new RaceTower(hudLayer);
tower.setRoster(roster);
const driverSelect = new DriverSelect(
  hudLayer,
  selectedDriverId,
  (profile, index, direction) => {
    audio.resume();
    audio.startReadyMusic();
    audio.driverSelected(index, direction);
    applySelectedDriver(profile.id);
  },
  requestFreshStart,
  () => {
    audio.resume();
    audio.startReadyMusic();
    mobileInput.requestImmersiveFromGesture(true);
  },
  toggleDrivingCoach,
);
const finale = new FinaleOverlay(hudLayer, continueAfterFinale, openExpansionGallery, saveFinaleCapture);
const expansionGallery = new ExpansionGallery(
  hudLayer,
  (index) => records.markExpansionSeen(index),
  () => {
    // Returning from the dossier restores the frozen finale, not gameplay.
    // Keep touch controls out of the result composition until a new run begins.
    mobileInput.setOverlayHidden(true);
    finale.focusPrimary();
  },
);

const input = new Input();
const gamepadInput = new GamepadInput();
let activeInputDevice: CoachInputDevice = mobileInput.enabled ? 'mobile' : 'keyboard';
const haptics = new Haptics(gamepadInput, () => activeInputDevice);
let lastKeyboardActivity = input.activitySerial;
let lastGamepadActivity = gamepadInput.activitySerial;
let lastMobileActivity = mobileInput.activitySerial;
let coachPresentation: CoachPresentation | null = null;
let pcPrimerPresentation: PcControlPrimerPresentation | null = null;
mixer.attachHaptics(() => haptics.enabled, (enabled) => haptics.setEnabled(enabled));
const pipeline = createPostPipeline(stage.renderer, stage.scene, stage.camera, prePass, stage.quality);
stage.onResize((w, h, pr) => {
  pipeline.setSize(w, h, pr);
  prePass.setSize(w * pr, h * pr);
  ocean.setResolution(w * pr, h * pr);
});

// -------------------------------------------------------------- race events
let resultsShown = false;
const DEFEAT_FREEZE_S = 0.35;
const FAILURE_REVIEW_AUTO_S = 5;
const MEDAL_CEREMONY_S = 4.5;
const MEDAL_MIN_READ_S = MEDAL_CEREMONY_S;
const FINALE_REVEAL_S = 4.8;
const FINALE_MIN_READ_S = 3.2;
const FINALE_CAMERA_HERO_S = 0.75;
const FINALE_CAPTURE_S = 0.78;
let retryLessonActive = false;
let retryLessonTimer = 0;
let retryLessonDuration = 0;
let retryLessonElapsed = 0;
let retryLessonMinRead = 0;
let retryLessonFrozenT = 0;
let defeatFreezeTimer = 0;
let pendingFailureNewBest = false;
let newBestThisRun = false;
let medalEarnedThisRun = false;
let ordinaryNewThisRun = false;
let excellentRecordedThisRun = false;
let previousChallengeTier: ChallengeTier = 'unqualified';
let currentRun = 0;
let worldTime = 0;
let presentationTime = 0;
let medalElapsed = 0;
let finaleElapsed = 0;
let finalePresentation = false;
let medalCapturePending = false;
let finaleCapturePending = false;
let medalCaptureCard = { title: '猛男', kicker: '三飞达成', lines: [] as string[] };
let interruptionActive = false;
let pageWasHidden = false;
let interruptionNeedsCountdown = false;
const retryReasonCounts = new Map<string, number>();
let prevFlightCharges = 0;
let prevDriftReleaseReady = false;
let prevFlightGateProgress = 0;
let prevFlightRouteState = boats[0].state.flightRouteState;
let prevFlightPhase = boats[0].state.flightPhase;
let prevBoosting = false;
let prevAirBraking = false;
let prevDrifting = false;
let prevTurnWarning = false;
let harnessBattleEvents = 0;
let harnessOvertakes = 0;
let harnessPositionLosses = 0;
let harnessLastBattleKind = 'none';
let harnessLastBattleCount = 0;
let harnessLastBattleStreak = 0;
let harnessCheckpointEvents = 0;
let harnessCourseWarningEvents = 0;
const harnessRoutePasses = new Array<number>(boats.length).fill(0);
const harnessRouteFails = new Array<number>(boats.length).fill(0);
const harnessPrevRouteStates: FlightRouteState[] = boats.map((boat) => boat.state.flightRouteState);
const routeLifecycleStates: FlightRouteState[] = boats.map((boat) => boat.state.flightRouteState);

const race = new Race(course, boats, {
  countdownTick: (n) => {
    audio.countdownStage(n);
    audio.countdownBeep(false);
  },
  go: (_resuming) => {
    audio.setScene('racing');
    const signaled = audio.startSignal() === 'played';
    if (!signaled) audio.countdownBeep(true);
    cameraRig.mode = 'chase';
    tower.announceGo(roster[0].name);
  },
  lapDone: () => {},
  checkpoint: () => {
    if (HARNESS) harnessCheckpointEvents++;
  },
  finish: (r) => {
    if (r.isPlayer) audio.finishSting();
  },
  courseWarning: (r, warning) => {
    if (r.isPlayer && warning !== 'none') {
      if (HARNESS) harnessCourseWarningEvents++;
      haptics.cue('warning');
    }
  },
  battle: (event) => {
    if (HARNESS) {
      harnessBattleEvents++;
      harnessLastBattleKind = event.kind;
      harnessLastBattleCount = event.opponents.length;
      harnessLastBattleStreak = event.streak;
      if (event.kind === 'overtake') harnessOvertakes += event.opponents.length;
      else harnessPositionLosses += event.opponents.length;
    }
    hud.showBattle(event);
    cameraRig.raceBattleKick(event.kind, event.opponents.length);
    audio.raceBattle(event.kind, event.opponents.length, event.toPlace);
    pipeline.pulse(event.kind, Math.min(1.35, 0.95 + event.opponents.length * 0.12));
    rivalDirector.notifyBattle();
    tower.announceBattle(event);
  },
}, roster);

function buildAiControllers(): AIController[] {
  return roster.map((racer) => new AIController(
    racer.personality,
    course,
    1000 + racer.id * 77,
    racer.pace,
    racer.lane,
    rivalDirector.isElite(racer.id),
  ));
}

function applySelectedDriver(id: string): void {
  if (race.phase !== 'ready') return;
  selectedDriverId = driverProfile(id).id;
  saveSelectedDriver(selectedDriverId);
  roster = buildRaceRoster(selectedDriverId);
  rivalDirector.setRoster(roster);
  for (const definition of roster) {
    const profile = driverProfile(definition.profileId);
    boats[definition.id].setDriver(definition.color, profile.handling);
    riders[definition.id].setColor(definition.color);
  }
  ais = buildAiControllers();
  race.setDefinitions(roster);
  tower.setRoster(roster);
  // Selection already happens on a frozen READY grid. Updating the six
  // definitions in place keeps the portrait reveal and its audio
  // transient alive; a full reset here would unnecessarily rebuild the
  // presentation state on every tap.
}

function requestFreshStart(): void {
  if (mobileInput.enabled) mobileInput.requestGo();
  else startFreshCountdown();
}

function toggleDrivingCoach(): void {
  if (drivingCoach.progress.status === 'active') drivingCoach.disable();
  else {
    pcControlPrimer.stop();
    pcPrimerPresentation = null;
    hud.showPcControlPrimer(null);
    drivingCoach.enable();
  }
  syncDrivingCoachUi();
}

function dismissPcControlPrimer(): void {
  pcControlPrimer.dismiss();
  pcPrimerPresentation = null;
  hud.showPcControlPrimer(null);
}

function disableDrivingCoach(): void {
  drivingCoach.disable();
  syncDrivingCoachUi();
  if (retryLessonActive) resetRace();
}

function syncDrivingCoachUi(): void {
  driverSelect.setCoachStatus(drivingCoach.progress.status);
  if (drivingCoach.progress.status !== 'active') {
    coachPresentation = null;
    hud.showCoach(null);
  }
}

function updateActiveInputDevice(): void {
  const keyboardSerial = input.activitySerial;
  const gamepadSerial = gamepadInput.activitySerial;
  const mobileSerial = mobileInput.activitySerial;
  if (keyboardSerial !== lastKeyboardActivity) activeInputDevice = 'keyboard';
  else if (gamepadSerial !== lastGamepadActivity) activeInputDevice = 'gamepad';
  else if (mobileSerial !== lastMobileActivity) activeInputDevice = 'mobile';
  lastKeyboardActivity = keyboardSerial;
  lastGamepadActivity = gamepadSerial;
  lastMobileActivity = mobileSerial;
  const labels = activeCoachControls();
  hud.setControlDevice(activeInputDevice, labels);
}

function activeCoachControls(): CoachControls {
  if (activeInputDevice === 'gamepad') return gamepadInput.controlLabels();
  if (activeInputDevice === 'mobile') return mobileInput.controlLabels();
  return { steer: 'A / D', drift: 'SHIFT', flight: 'SPACE' };
}

function requestRetry(): void {
  if (race.phase === 'medal') {
    if (medalElapsed >= MEDAL_MIN_READ_S) startResumeCountdown();
    return;
  }
  if (retryLessonActive) {
    if (retryLessonElapsed >= retryLessonMinRead) resetRace();
    return;
  }
  if (race.phase === 'finished') resetRace();
}

function resumeInterruption(): void {
  if (!interruptionActive || document.hidden) return;
  interruptionActive = false;
  stopInterruptionPadPoll();
  input.reset();
  gamepadInput.reset();
  haptics.stop();
  mobileInput.reset();
  hud.hideInterruption();
  if (interruptionNeedsCountdown && race.restartAfterInterruption()) {
    audio.startRaceScore(false);
    audio.setScene('countdown');
  } else {
    audio.resume();
  }
  interruptionNeedsCountdown = false;
  if (!HARNESS) loop.start();
}

function startFreshCountdown(): void {
  if (!race.startCountdown()) return;
  pcControlPrimer.arm(
    records.data.runs === 0 && DESKTOP_DRIVER_STAGE.matches && !mobileInput.enabled &&
      activeInputDevice === 'keyboard' && drivingCoach.progress.status === 'dormant',
    boats[0].state,
  );
  pcPrimerPresentation = null;
  hud.showPcControlPrimer(null);
  currentRun = records.beginRun();
  input.reset();
  gamepadInput.reset();
  mobileInput.reset();
  mobileInput.setGoPrompt(false);
  hud.hideReady();
  driverSelect.hide();
  mixer.setVisible(false);
  audio.startRaceScore(true);
  audio.setScene('countdown');
  drivingCoach.resetRun(boats[0].state);
  coachPresentation = null;
  hud.showCoach(null);
}

function startResumeCountdown(): void {
  if (!race.startResumeCountdown()) return;
  input.clearTransient();
  gamepadInput.clearTransient();
  mobileInput.resumeFromPresentation();
  hud.hideMedalCeremony();
  audio.startRaceScore(false);
  audio.setScene('countdown');
  coachPresentation = null;
  hud.showCoach(null);
  pcPrimerPresentation = null;
  hud.showPcControlPrimer(null);
}

function continueAfterFinale(): void {
  if (!finalePresentation || finaleElapsed < FINALE_MIN_READ_S || expansionGallery.visible()) return;
  if (!race.startFinalContinueCountdown()) return;
  finalePresentation = false;
  finaleElapsed = 0;
  resultsShown = false;
  course.resetFinalStation();
  finale.hide();
  input.clearTransient();
  gamepadInput.clearTransient();
  mobileInput.reset();
  mobileInput.setOverlayHidden(false);
  mobileInput.setControlPhase('preparing');
  cameraRig.mode = 'chase';
  audio.startRaceScore(false);
  audio.setScene('countdown');
  trackGameEvent('continue_game', { run: currentRun, flights: boats[0].state.flightsCleared });
}

function openExpansionGallery(): void {
  if (!finalePresentation || finaleElapsed < FINALE_MIN_READ_S) return;
  mobileInput.setOverlayHidden(true);
  expansionGallery.show(0);
}

async function saveMedalCapture(): Promise<void> {
  if (!medalCapture) return;
  hud.setMedalCaptureReady(false, '保存中');
  try {
    const outcome = await capture.saveOrShare(medalCapture, `board-race-macho-${currentRun}.png`);
    hud.setMedalCaptureReady(true, outcome === 'cancelled' ? '再次保存' : '已保存');
    if (outcome !== 'cancelled') trackGameEvent('screenshot_saved', { kind: 'medal', run: currentRun });
  } catch {
    hud.setMedalCaptureReady(true, '再次保存');
  }
}

async function saveFinaleCapture(): Promise<void> {
  if (!finaleCapture) return;
  finale.setCaptureReady(false);
  finale.setSaveLabel('保存中');
  try {
    const outcome = await capture.saveOrShare(finaleCapture, `board-race-final-${currentRun}.png`);
    finale.setCaptureReady(true);
    finale.setSaveLabel(outcome === 'cancelled' ? '再次保存' : '已保存');
    if (outcome !== 'cancelled') {
      records.recordFinaleScreenshot();
      trackGameEvent('screenshot_saved', { kind: 'finale', run: currentRun });
    }
  } catch {
    finale.setCaptureReady(true);
    finale.setSaveLabel('再次保存');
  }
}

async function createMedalCapture(): Promise<void> {
  try {
    medalCapture = await capture.create({ kind: 'medal', ...medalCaptureCard });
    hud.setMedalCaptureReady(true);
    trackGameEvent('screenshot_created', { kind: 'medal', run: currentRun });
  } catch {
    hud.setMedalCaptureReady(false);
  }
}

async function createFinaleCapture(): Promise<void> {
  const result = race.challengeResult;
  if (!result) return;
  try {
    finaleCapture = await capture.create({
      kind: 'finale', title: '七飞认证', kicker: 'FINAL STATION',
      lines: [`第 ${result.place} / ${result.totalRacers} 名`, `本局 ${result.flightsCleared} 飞`],
      overlayCanvas: finale.getCaptureCanvas(),
    });
    finale.setCaptureReady(true);
    trackGameEvent('screenshot_created', { kind: 'finale', run: currentRun });
  } catch {
    finale.setCaptureReady(false);
  }
}

function startMedalCeremony(tier: Exclude<ChallengeTier, 'unqualified'>, medals: number, best: number): void {
  if (!race.beginMedalCeremony()) return;
  medalElapsed = 0;
  retryLessonFrozenT = worldTime;
  input.clearTransient();
  gamepadInput.clearTransient();
  mobileInput.suspendForPresentation();
  hud.showQualification(tier, medals, best);
  hud.updateMedalCeremony(0, MEDAL_CEREMONY_S, false);
  medalCapture = null;
  medalCapturePending = true;
  medalCaptureCard = {
    title: '猛男',
    kicker: tier === 'excellent' ? '三飞达成 · 优秀已锁定' : '三飞达成',
    lines: [`男人勋章 +1 · 累计 ${medals}`, `本局 BEST ${best} 飞`],
  };
  audio.setScene('medal');
  audio.playMedalCeremony();
  haptics.cue('medal');
  coachPresentation = null;
  hud.showCoach(null);
  pcControlPrimer.stop();
  pcPrimerPresentation = null;
  hud.showPcControlPrimer(null);
}

function startRetryLesson(): void {
  const result = race.challengeResult;
  if (!result?.failure) return;
  const failure = result.failure;
  const reason = failure?.reason ?? result.reason;
  const key = `${failure?.routeSlot ?? 0}:${reason}`;
  const repeatCount = (retryReasonCounts.get(key) ?? 0) + 1;
  retryReasonCounts.set(key, repeatCount);
  const coachArmed = drivingCoach.onFailure(result.flightsCleared, failure.reason, result.manMedalEarned) ||
    drivingCoach.progress.status === 'active';
  retryLessonDuration = FAILURE_REVIEW_AUTO_S;
  retryLessonMinRead = 0;
  retryLessonTimer = retryLessonDuration;
  retryLessonElapsed = 0;
  retryLessonActive = true;
  retryLessonFrozenT = worldTime;
  input.reset();
  gamepadInput.reset();
  mobileInput.reset();
  audio.retryLesson();
  audio.setScene('lesson');
  mixer.setVisible(true);
  hud.showRetryLesson(
    result, currentRun, repeatCount, pendingFailureNewBest, activeInputDevice, coachArmed, drivingCoach.progress.mastery,
  );
  syncDrivingCoachUi();
  coachPresentation = null;
  hud.showCoach(null);
  pcControlPrimer.stop();
  pcPrimerPresentation = null;
  hud.showPcControlPrimer(null);
}

function updateFrozenPresentation(dt: number, phase = race.phase, finalPresentation = false): void {
  const frozen = boats[0].state;
  audio.setEngine(0, 0, false);
  audio.setWaterRush(0);
  audio.setAirborne(false);
  audio.setFlight(0, false);
  audio.setDrift(0);
  if (finalPresentation) {
    if (finaleElapsed >= FINALE_CAMERA_HERO_S && cameraRig.mode !== 'results') cameraRig.mode = 'results';
    cameraRig.update(dt, boats[0], presentationTime);
    ocean.update(presentationTime, stage.camera.position);
    sky.update(presentationTime, stage.camera.position);
    course.update(dt, presentationTime);
  }
  pipeline.update(dt, finalPresentation ? presentationTime : retryLessonFrozenT, frozen, phase);
  hud.update(dt, race, boats[0], boats);
  audio.update(dt);
}

function resetRace(): void {
  retryLessonActive = false;
  retryLessonTimer = 0;
  retryLessonDuration = 0;
  retryLessonElapsed = 0;
  retryLessonMinRead = 0;
  defeatFreezeTimer = 0;
  pendingFailureNewBest = false;
  newBestThisRun = false;
  medalEarnedThisRun = false;
  ordinaryNewThisRun = false;
  excellentRecordedThisRun = false;
  previousChallengeTier = 'unqualified';
  finalePresentation = false;
  finaleElapsed = 0;
  medalCapture = null;
  finaleCapture = null;
  medalCapturePending = false;
  finaleCapturePending = false;
  course.resetFlightChallenge();
  collisions.reset();
  input.reset();
  gamepadInput.reset();
  mobileInput.reset();
  mobileInput.setOverlayHidden(false);
  resultsShown = false;
  hud.hideResults();
  hud.clearTransientNotices();
  hud.hideRetryLesson();
  hud.hideMedalCeremony();
  coachPresentation = null;
  hud.showCoach(null);
  pcControlPrimer.stop();
  pcPrimerPresentation = null;
  hud.showPcControlPrimer(null);
  finale.hide();
  for (let i = 0; i < boats.length; i++) {
    const s = GRID_SLOTS[i];
    boats[i].object.visible = true;
    boats[i].teleport(s.x, s.z, s.heading);
    wakes[i].clear();
  }
  race.reset();
  currentRun = records.data.runs + 1;
  prevFlightCharges = boats[0].state.flightCharges;
  prevDriftReleaseReady = boats[0].state.driftReleaseReady;
  prevFlightGateProgress = boats[0].state.flightGateProgress;
  prevFlightRouteState = boats[0].state.flightRouteState;
  prevFlightPhase = boats[0].state.flightPhase;
  prevBoosting = boats[0].state.boosting;
  prevAirBraking = false;
  prevDrifting = boats[0].state.drifting;
  prevTurnWarning = false;
  drivingCoach.resetRun(boats[0].state);
  harnessBattleEvents = 0;
  harnessOvertakes = 0;
  harnessPositionLosses = 0;
  harnessLastBattleKind = 'none';
  harnessLastBattleCount = 0;
  harnessLastBattleStreak = 0;
  harnessCheckpointEvents = 0;
  harnessCourseWarningEvents = 0;
  for (let i = 0; i < boats.length; i++) {
    harnessRoutePasses[i] = 0;
    harnessRouteFails[i] = 0;
    harnessPrevRouteStates[i] = boats[i].state.flightRouteState;
    routeLifecycleStates[i] = boats[i].state.flightRouteState;
    ais[i].reset();
  }
  cameraRig.mode = 'orbit';
  if (DESKTOP_DRIVER_STAGE.matches) cameraRig.snapOrbit(boats[0], presentationTime);
  hud.hideReady();
  driverSelect.show();
  syncDrivingCoachUi();
  mobileInput.setGoPrompt(false);
  mixer.setVisible(!mobileInput.enabled);
  mixer.sync();
  audio.setScene('ready');
}

resetRace();

// ------------------------------------------------------------------- step
const ZERO_INPUT: BoatInput = {
  throttle: 0,
  steer: 0,
  drift: false,
  flightTrigger: false,
  airBrake: false,
};
let harnessPlayerInput: BoatInput | null = null;
let harnessFlightTriggerPulse = false;

function step(dt: number, _t: number): void {
  gamepadInput.poll(race.phase === 'ready' && !interruptionActive);
  updateActiveInputDevice();
  haptics.update();
  if (interruptionActive) {
    if (gamepadInput.consumeConfirm()) resumeInterruption();
    return;
  }
  if (mobileInput.enabled && !mobileInput.isLandscape) {
    input.reset();
    gamepadInput.reset();
    mobileInput.reset();
    mobileInput.setControlPhase('inactive');
    return;
  }
  const frozenDesktopReady = race.phase === 'ready' && DESKTOP_DRIVER_STAGE.matches;
  if (!frozenDesktopReady) presentationTime += dt;
  // Consume retry edges in every phase. Otherwise a key pressed during the
  // race remains queued and can erase the defeat screen on the failure frame.
  const enterPressed = input.consumePress('Enter');
  const retryPressed = input.consumePress('KeyR');
  const spaceConfirmPressed = race.phase === 'racing' ? false : input.consumePress('Space');
  const gamepadConfirm = gamepadInput.consumeConfirm();
  const coachDismissed = input.consumePress('Escape') || gamepadInput.consumeDismiss();

  if (coachDismissed && pcControlPrimer.active && pcPrimerPresentation) dismissPcControlPrimer();
  else if (coachDismissed && drivingCoach.progress.status === 'active') disableDrivingCoach();

  if (race.phase === 'medal') {
    mobileInput.consumeAnyPress();
    medalElapsed += dt;
    const canContinue = medalElapsed >= MEDAL_MIN_READ_S;
    hud.updateMedalCeremony(medalElapsed, MEDAL_CEREMONY_S, canContinue);
    updateFrozenPresentation(dt, 'medal');
    if (medalElapsed >= MEDAL_CEREMONY_S || ((enterPressed || spaceConfirmPressed || gamepadConfirm) && canContinue)) startResumeCountdown();
    return;
  }

  if (retryLessonActive) {
    const lessonPressed = enterPressed || spaceConfirmPressed || retryPressed || gamepadConfirm;
    mobileInput.consumeAnyPress();
    retryLessonTimer = Math.max(0, retryLessonTimer - dt);
    retryLessonElapsed += dt;
    const canContinue = true;
    hud.updateRetryLesson(retryLessonDuration > 0 ? retryLessonElapsed / retryLessonDuration : 1, canContinue);
    updateFrozenPresentation(dt);
    if (retryLessonTimer <= 0 || (lessonPressed && canContinue)) resetRace();
    return;
  }

  if (defeatFreezeTimer > 0) {
    mobileInput.consumeAnyPress();
    defeatFreezeTimer = Math.max(0, defeatFreezeTimer - dt);
    updateFrozenPresentation(dt);
    if (defeatFreezeTimer <= 0) startRetryLesson();
    return;
  }

  if (finalePresentation) {
    mobileInput.consumeAnyPress();
    finaleElapsed += dt;
    const canContinue = finaleElapsed >= FINALE_MIN_READ_S;
    finale.update(finaleElapsed, FINALE_REVEAL_S, canContinue);
    updateFrozenPresentation(dt, 'finished', true);
    if (!expansionGallery.visible() && canContinue) {
      const focusLeft = input.consumePress('ArrowLeft') || input.consumePress('ArrowUp') || gamepadInput.consumeSelectLeft();
      const focusRight = input.consumePress('ArrowRight') || input.consumePress('ArrowDown') || gamepadInput.consumeSelectRight();
      if (focusLeft) finale.moveFocus(-1);
      if (focusRight) finale.moveFocus(1);
      if (enterPressed || spaceConfirmPressed || gamepadConfirm) finale.activateFocused();
    }
    return;
  }

  if ((enterPressed || spaceConfirmPressed || retryPressed || gamepadConfirm) && race.phase === 'finished') requestRetry();

  if (race.phase === 'ready') {
    const mobileGo = mobileInput.consumeGoRequest();
    const selectLeft = input.consumePress('ArrowLeft') || input.consumePress('KeyA');
    const selectRight = input.consumePress('ArrowRight') || input.consumePress('KeyD');
    if (selectLeft || gamepadInput.consumeSelectLeft()) driverSelect.move(-1);
    if (selectRight || gamepadInput.consumeSelectRight()) driverSelect.move(1);
    mobileInput.consumeAnyPress();
    mobileInput.setControlPhase('inactive');
    driverSelect.updateControllerStatus(gamepadInput.status());
    driverSelect.setCoachStatus(drivingCoach.progress.status);
    if (!frozenDesktopReady) cameraRig.update(dt, boats[0], presentationTime);
    ocean.update(worldTime, stage.camera.position);
    sky.update(worldTime, stage.camera.position);
    course.update(0, worldTime);
    tower.update(dt, race);
    hud.update(dt, race, boats[0], boats);
    pipeline.update(dt, worldTime, boats[0].state, 'ready');
    audio.update(dt);
    if (enterPressed || spaceConfirmPressed || mobileGo || gamepadConfirm) startFreshCountdown();
    return;
  }

  if (race.phase === 'countdown' || race.phase === 'resume-countdown') {
    const resuming = race.phase === 'resume-countdown';
    gamepadInput.consumeFlight();
    mobileInput.consumeAnyPress();
    mobileInput.setControlPhase(resuming ? 'preparing' : 'inactive');
    race.update(dt);
    if (!resuming) {
      worldTime += dt;
      cameraRig.update(dt, boats[0], presentationTime);
      ocean.update(worldTime, stage.camera.position);
      sky.update(worldTime, stage.camera.position);
      course.update(0, worldTime);
    }
    tower.update(dt, race);
    hud.update(dt, race, boats[0], boats);
    pipeline.update(dt, worldTime, boats[0].state, race.phase);
    audio.update(dt);
    return;
  }

  const waitingForMobile = mobileInput.enabled && !mobileInput.ready && !gamepadInput.connected && !HARNESS;
  const racing = race.phase === 'racing' && !waitingForMobile;
  mobileInput.setControlPhase(racing && (!HARNESS || params.has('mobile')) ? 'racing' : 'inactive');

  // Inputs: player keyboard (or AI autopilot in harness), AI for the rest.
  const flightActive = boats[0].state.flightPhase !== 'surface';
  let playerInput = ZERO_INPUT;
  if (racing) {
    const keyboardInput = input.read(dt, flightActive);
    const padInput = gamepadInput.read(flightActive);
    if (mobileInput.enabled) {
      const touchInput = mobileInput.read(dt, flightActive);
      playerInput = {
        throttle: 1,
        steer: input.steeringHeld() ? keyboardInput.steer : gamepadInput.steeringHeld() ? padInput.steer : touchInput.steer,
        drift: keyboardInput.drift || padInput.drift || touchInput.drift,
        flightTrigger: keyboardInput.flightTrigger || padInput.flightTrigger || touchInput.flightTrigger,
        airBrake: keyboardInput.airBrake || padInput.airBrake || touchInput.airBrake,
      };
    } else {
      playerInput = {
        throttle: 1,
        steer: input.steeringHeld() ? keyboardInput.steer : gamepadInput.steeringHeld() ? padInput.steer : keyboardInput.steer,
        drift: keyboardInput.drift || padInput.drift,
        flightTrigger: keyboardInput.flightTrigger || padInput.flightTrigger,
        airBrake: keyboardInput.airBrake || padInput.airBrake,
      };
    }
  }
  if (!retryLessonActive) mobileInput.consumeAnyPress();
  if (!racing) input.consumePress('Space'); // never buffer a flight press through the countdown
  worldTime += dt;
  rivalDirector.update(dt, race.racers);
  if (racing) collisions.capture(boats);
  for (let i = 0; i < boats.length && racing; i++) {
    if (i > 0) boats[i].setOpponentEffectDistance(boats[i].state.position.distanceTo(boats[0].state.position));
    let inp: BoatInput;
    if (!racing) {
      inp = ZERO_INPUT;
    } else if (i === 0 && !HARNESS) {
      inp = playerInput;
    } else if (i === 0 && harnessUsePlayerInput) {
      inp = playerInput;
    } else if (i === 0 && harnessPlayerInput) {
      inp = harnessPlayerInput;
    } else {
      inp = ais[i].update(
        dt,
        boats[i],
        boats,
        race.racers[i].progress,
        race.racers[0].progress,
        rivalDirector.paceFor(i),
      );
    }
    if (i === 0 && harnessForceAirBrake && boats[0].state.flightPhase !== 'surface') {
      inp = { ...inp, drift: false, airBrake: true };
    }
    if (i === 0 && harnessSuppressAirborneFlightTrigger && boats[0].state.flightPhase !== 'surface') {
      inp = { ...inp, flightTrigger: false };
    }
    if (i === 0 && harnessFlightTriggerPulse) inp = { ...inp, flightTrigger: true };
    if (i === 0 && course.finalStationArmed()) {
      const returnBrake = inp.drift || inp.airBrake;
      inp = { ...inp, drift: false, airBrake: returnBrake, flightTrigger: false };
    }
    boats[i].update(dt, inp, worldTime);
    if (i === 0) harnessFlightTriggerPulse = false;
  }

  if (racing) course.updateFlightRoute(dt, boats);

  let playerPassedFlight = false;
  if (racing) {
    for (let i = 0; i < boats.length; i++) {
      const state = boats[i].state;
      const routeState = state.flightRouteState;
      if (i > 0 && routeState === 'failed' && state.flightPhase === 'surface') {
        boats[i].recoverFailedFlightRoute();
        routeLifecycleStates[i] = boats[i].state.flightRouteState;
        harnessPrevRouteStates[i] = boats[i].state.flightRouteState;
        continue;
      }
      if (HARNESS && routeState !== harnessPrevRouteStates[i]) {
        if (routeState === 'passed') harnessRoutePasses[i]++;
        else if (routeState === 'failed') harnessRouteFails[i]++;
        harnessPrevRouteStates[i] = routeState;
      }
      if (routeState === routeLifecycleStates[i]) continue;
      routeLifecycleStates[i] = routeState;
      if (routeState === 'failed') {
        if (i === 0) {
          if (state.flightFailure) race.defeatFlight(state.flightFailure);
        }
      } else if (routeState === 'passed') {
        if (i === 0) playerPassedFlight = true;
      }
    }
  }
  if (!waitingForMobile && race.phase === 'racing') race.update(dt);
  if (racing && race.phase === 'racing') {
    const hits = collisions.resolve(boats);
    // Preserve route-projection continuity on untouched frames. Re-basing
    // every frame lets a continuous cross-course shortcut become the new
    // legal segment; only an actual contact correction needs absorption.
    if (collisions.debugState().maxCorrection > 0) {
      course.syncFlightTrackingAfterCollisions(boats);
      race.syncCollisionCorrections();
    }
    presentPlayerCollisions(hits);
  }
  let enteredMedal = false;
  if (playerPassedFlight && race.phase === 'racing') {
    const flights = boats[0].state.flightsCleared;
    const pass = records.recordFlightPass(flights, selectedDriverId);
    newBestThisRun ||= pass.newBest;
    hud.showFlightPass(flights, pass.bestFlights, pass.newBest);
    tower.announceFlight(flights, pass.bestFlights);
    if (flights === 3 && race.challengeTier === 'unqualified') {
      drivingCoach.markExpert();
      syncDrivingCoachUi();
      const tier = race.qualifyChallenge();
      const qualification = records.qualifyRun(race.raceTime);
      medalEarnedThisRun = true;
      ordinaryNewThisRun = qualification.ordinaryNew;
      if (tier !== 'unqualified') {
        startMedalCeremony(tier, qualification.manMedalsTotal, pass.bestFlights);
        enteredMedal = true;
      }
    } else if (!harnessEndlessMode && flights > 0 && flights % course.flightRoutes.length === 0 && race.armFinale()) {
      course.armFinalStation();
      hud.showFinalReady();
      tower.announceFlight(flights, pass.bestFlights);
      pipeline.pulse('finish', 0.55);
      trackGameEvent('final_station_armed', { run: currentRun, flights, elapsed: race.raceTime });
    }
  }
  if (race.challengeTier === 'excellent' && !excellentRecordedThisRun) {
    const excellent = records.recordExcellent(race.raceTime);
    excellentRecordedThisRun = true;
    if (previousChallengeTier === 'ordinary') hud.showExcellentLocked(excellent.excellentTotal);
  }
  previousChallengeTier = race.challengeTier;

  const playerState = boats[0].state;
  if (playerState.drifting && !prevDrifting && playerState.speed > 12) haptics.cue('drift-active');
  if (playerState.driftReleaseReady && !prevDriftReleaseReady) {
    audio.driftReleaseReady();
    haptics.cue('drift-ready');
  }
  if (playerState.flightCharges > prevFlightCharges) {
    audio.flightReady(playerState.flightCharges);
    cameraRig.flightReadyKick();
    pipeline.pulse('ready');
    haptics.cue('charge', playerState.flightCharges >= 2 ? 1 : 0.82);
  }
  if (playerState.flightExtended) {
    audio.flightExtend();
    cameraRig.flightExtendKick();
    pipeline.pulse('ready', 0.68);
    haptics.cue('extend');
  }
  if (playerState.boosting && !prevBoosting) {
    pipeline.pulse('boost', 0.92);
    haptics.cue('boost');
  }
  if (playerState.flightPhase === 'spool' && prevFlightPhase !== 'spool') {
    pipeline.pulse('launch', 1.05);
    haptics.cue('launch');
  }
  const airBraking = playerState.flightPhase !== 'surface' && playerState.flightAirBrake > 0.28;
  if (airBraking && !prevAirBraking) {
    audio.airBrakeSnap();
    haptics.cue('air-brake');
  }
  if (playerState.flightGateProgress > prevFlightGateProgress) {
    const flightNumber = Math.max(1, playerState.flightsCleared);
    const feedbackStep = Math.min(3, ((flightNumber - 1) % 3) + 1);
    audio.flightGate(feedbackStep);
    cameraRig.flightGateKick(feedbackStep);
    pipeline.pulse('gate', flightNumber === 3 ? 0.72 : 0.4);
    haptics.cue('gate');
  }
  if (playerState.flightRouteState !== prevFlightRouteState) {
    if (playerState.flightRouteState === 'passed') {
      audio.routeClear(Math.min(3, ((playerState.flightsCleared - 1) % 3) + 1));
    }
    else if (playerState.flightRouteState === 'failed') cameraRig.routeMissKick();
  }
  prevFlightCharges = playerState.flightCharges;
  prevDriftReleaseReady = playerState.driftReleaseReady;
  prevFlightGateProgress = playerState.flightGateProgress;
  prevFlightRouteState = playerState.flightRouteState;
  prevFlightPhase = playerState.flightPhase;
  prevBoosting = playerState.boosting;
  prevAirBraking = airBraking;
  prevDrifting = playerState.drifting;
  const turnWarning = course.flightTurnWarning(boats[0].id);
  if (turnWarning && !prevTurnWarning) haptics.cue('warning');
  prevTurnWarning = turnWarning;

  const controls = activeCoachControls();
  coachPresentation = drivingCoach.update(dt, {
    state: playerState,
    input: HARNESS && harnessPlayerInput ? harnessPlayerInput : playerInput,
    guideActive: course.guidanceStatus().activeRouteIndex >= 0,
    turnWarning,
    presentationBlocked: hud.coachPresentationBlocked() || turnWarning,
  }, controls);
  if (turnWarning && coachPresentation?.id !== 'air-brake') coachPresentation = null;
  pcPrimerPresentation = pcControlPrimer.update(dt, {
    state: playerState,
    racing: race.phase === 'racing',
    guideActive: course.guidanceStatus().activeRouteIndex >= 0,
    keyboardActive: activeInputDevice === 'keyboard',
    presentationBlocked: hud.coachPresentationBlocked() || turnWarning || coachPresentation !== null,
  });
  const coachPrimerPresentation = coachPresentation && activeInputDevice === 'keyboard' &&
      (coachPresentation.focus === 'drift-control' || coachPresentation.focus === 'drift-meter')
    ? {
        step: coachPresentation.id === 'release' ? 'release' as const :
          coachPresentation.id === 'bank' ? 'charging' as const : 'drift' as const,
        key: controls.drift,
        kicker: coachPresentation.kicker,
        title: coachPresentation.title,
        detail: coachPresentation.detail,
        tone: coachPresentation.tone === 'warning' ? 'warning' as const : 'drift' as const,
      }
    : null;
  hud.showPcControlPrimer(coachPrimerPresentation ?? pcPrimerPresentation, pcPrimerPresentation !== null);

  // Landing feedback: camera shake + thud on slams, splash on soft landings.
  for (let i = 0; i < boats.length; i++) {
    const imp = boats[i].state.landImpulse;
    if (imp > 7) {
      if (i === 0) {
        cameraRig.shake(Math.min(1, imp / 16));
        audio.thud(Math.min(1, imp / 14));
        haptics.impact('landing', Math.min(1, imp / 14), boats[0].state.drifting || boats[0].state.flightAirBrake > 0.28);
        // Opponent splashes remain visual-only until a spatial environment
        // sample is explicitly approved; otherwise pile-ups sound like an
        // unexplained noise wall at the player's position.
        audio.splash(Math.min(1, imp / 12));
      }
    }
  }

  for (let i = 0; i < boats.length; i++) riders[i].update(dt, boats[i].state, worldTime, race.racers[i].finished);

  cameraRig.update(dt, boats[0], worldTime);
  ocean.update(worldTime, stage.camera.position);
  sky.update(worldTime, stage.camera.position);
  course.update(dt, worldTime);
  for (let i = 0; i < boats.length; i++) wakes[i].update(dt, worldTime);
  spray.update(dt, worldTime);
  jetTrail.update(dt);

  const ps = boats[0].state;
  tower.update(dt, race, ps.flightPhase !== 'surface');
  hud.update(dt, race, boats[0], boats);
  const routeGuidance = course.guidanceStatus();
  mobileInput.setActionState(
    deriveAbilityHudState(ps, course.finalStationArmed()),
    course.flightTurnWarning(boats[0].id),
    routeGuidance.actionCue,
    routeGuidance.actionDirection,
  );
  // Position the education slot only after the objective block, race tower,
  // near-boat meter, and contextual thumb controls have their final geometry
  // for this frame. Measuring earlier leaves the card one layout frame stale.
  hud.showCoach(coachPresentation);

  audio.setScene(enteredMedal ? 'medal' : ps.flightPhase === 'surface' ? 'racing' : 'flight');
  audio.setEngine(ps.rpm, ps.throttle, ps.boosting);
  audio.setWaterRush(Math.min(1, Math.abs(ps.speed) / 34));
  audio.setAirborne(ps.airborne);
  audio.setFlight(
    ps.flightThrust,
    ps.flightPhase !== 'surface',
    ps.flightPressure,
    Math.max(0, ps.flightClearance),
    ps.flightPhase === 'surface' ? 0 : ps.flightAirBrake,
    ps.steer,
    ps.flightRouteIndex >= 0 ? ps.flightRouteIndex : ps.flightsCleared,
  );
  audio.setDrift(ps.drifting ? Math.min(1, ps.boostCharge * 0.75 + Math.abs(ps.lateralG) / 18) : 0);
  if (ps.flightRouteMiss) audio.flightMiss();
  pipeline.update(dt, worldTime, ps, race.phase);

  // Failures freeze for one impact beat and then enter the adaptive loading
  // loop directly. The legacy finished branch remains available to scripted modes.
  if ((race.phase === 'finished' || race.phase === 'defeated') && !resultsShown) {
    resultsShown = true;
    cameraRig.mode = race.phase === 'defeated' ? 'defeat' : 'chase';
    if (race.phase === 'defeated') {
      cameraRig.defeatKick();
      audio.setScene('defeat');
      audio.defeat();
      pipeline.pulse('defeat', 1.35);
      if (race.challengeResult) {
        const progressBest = records.recordFailure(race.challengeResult);
        pendingFailureNewBest = newBestThisRun || progressBest;
        race.challengeResult.ordinaryNew = ordinaryNewThisRun;
        records.decorateResult(race.challengeResult, pendingFailureNewBest, medalEarnedThisRun);
      }
      defeatFreezeTimer = DEFEAT_FREEZE_S;
      retryLessonFrozenT = worldTime;
      input.reset();
      gamepadInput.reset();
      mobileInput.reset();
      mobileInput.setControlPhase('inactive');
      haptics.cue('defeat');
      coachPresentation = null;
      hud.showCoach(null);
      pcControlPrimer.stop();
      pcPrimerPresentation = null;
      hud.showPcControlPrimer(null);
    } else {
      cameraRig.finishKick();
      pipeline.pulse('finish', 1.35);
      if (race.challengeResult) {
        race.challengeResult.ordinaryNew = ordinaryNewThisRun;
        records.decorateResult(race.challengeResult, newBestThisRun, medalEarnedThisRun);
        records.recordFinale();
        course.triggerFinaleCelebration();
        finale.show(race.challengeResult);
        finaleElapsed = 0;
        finalePresentation = true;
        finaleCapture = null;
        finaleCapturePending = true;
        retryLessonFrozenT = worldTime;
        input.reset();
        gamepadInput.reset();
        mobileInput.reset();
        mobileInput.setOverlayHidden(true);
        mobileInput.setControlPhase('inactive');
        audio.setScene('medal');
        haptics.cue('medal');
        trackGameEvent('final_station_crossed', {
          run: currentRun, flights: race.challengeResult.flightsCleared, elapsed: race.challengeResult.raceTime,
        });
        trackGameEvent('finale_shown', { run: currentRun, place: race.challengeResult.place });
      }
    }
  }
  audio.update(dt);
}

function render(frameMs: number): void {
  stage.renderer.info.reset(); // autoReset is off: gather whole-frame stats
  pipeline.render();
  processCaptureQueue();
  stage.updatePerf(frameMs);
}

function processCaptureQueue(): void {
  if (medalCapturePending) {
    medalCapturePending = false;
    void createMedalCapture();
  }
  if (finaleCapturePending && finaleElapsed >= FINALE_CAPTURE_S) {
    finaleCapturePending = false;
    void createFinaleCapture();
  }
}

const loop = new Loop(step, render);
let interruptionPadRaf = 0;

function stopInterruptionPadPoll(): void {
  cancelAnimationFrame(interruptionPadRaf);
  interruptionPadRaf = 0;
}

function startInterruptionPadPoll(): void {
  if (HARNESS || interruptionPadRaf || document.hidden || !interruptionActive) return;
  const poll = () => {
    interruptionPadRaf = 0;
    if (document.hidden || !interruptionActive) return;
    gamepadInput.poll();
    if (gamepadInput.consumeConfirm()) {
      resumeInterruption();
      return;
    }
    interruptionPadRaf = requestAnimationFrame(poll);
  };
  interruptionPadRaf = requestAnimationFrame(poll);
}

function handleVisibility(hidden: boolean): void {
  audio.setVisibility(hidden);
  haptics.stop();
  input.reset();
  gamepadInput.reset();
  mobileInput.reset();
  mobileInput.setControlPhase('inactive');
  if (hidden) {
    stopInterruptionPadPoll();
    pageWasHidden = true;
    interruptionNeedsCountdown = race.phase === 'racing' || race.phase === 'countdown' || race.phase === 'resume-countdown';
    interruptionActive = race.phase !== 'ready';
    if (!HARNESS) loop.stop();
    return;
  }
  if (!pageWasHidden) return;
  pageWasHidden = false;
  if (race.phase === 'ready') {
    if (!HARNESS) loop.start();
    return;
  }
  interruptionActive = true;
  hud.showInterruption(interruptionNeedsCountdown);
  startInterruptionPadPoll();
  if (!HARNESS) requestAnimationFrame(() => render(16.7));
}

document.addEventListener('visibilitychange', () => handleVisibility(document.hidden));
window.addEventListener('keydown', (event) => {
  if (interruptionActive && (event.code === 'Enter' || event.code === 'Space') && !event.repeat) {
    event.preventDefault();
    resumeInterruption();
  }
});

// ---------------------------------------------------------------- harness
// Deterministic drive-by-wire API for harness/screenshot.mjs. In harness
// mode the rAF pump never runs: the harness advances the sim explicitly
// (all boats AI-driven) and renders single frames on demand.
interface Harness {
  ready: boolean;
  scenario(name: string): void;
  advance(seconds: number): void;
  render(): void;
  freeCam(px: number, py: number, pz: number, lx: number, ly: number, lz: number): void;
  chaseCam(): void;
  playerPose(): { x: number; y: number; z: number; heading: number };
  driftingOpponentPose(): { x: number; y: number; z: number; heading: number };
  setPlayerInput(input: Partial<BoatInput> | null): void;
  usePlayerInput(enabled: boolean): void;
  earnFlight(combo?: boolean): void;
  tapFlight(): void;
  passFlight(routeCursor: number, initialCharges?: number, forceAirBrake?: boolean): void;
  passExtendedFlight(routeCursor: number, forceAirBrake?: boolean): void;
  flightRecoveryCase(routeCursor: number): Record<string, number | string | boolean>;
  medalRecoveryCase(): Record<string, number | string | boolean>;
  route45ContinuousCase(): Record<string, number | string | boolean>;
  finalApproachCase(): Record<string, unknown>;
  surfaceRouteEnforcementCase(): Record<string, unknown>;
  flightBudgetCase(): Record<string, unknown>;
  retry(): void;
  setCoachEnabled(enabled: boolean): void;
  coachState(): Record<string, unknown>;
  pcPrimerState(): Record<string, unknown>;
  pcPrimerCase(): Record<string, unknown>;
  playerState(): Record<string, number | string | boolean | null>;
  stats(): Record<string, number | string>;
  guidance(): CourseGuidanceStatus;
  startGantryStatus(): Record<string, number>;
  finalStationStatus(): Record<string, number | string | boolean>;
  mobileStatus(): Record<string, number | string | boolean>;
  gamepadStatus(): Record<string, number | string | boolean>;
  hapticStatus(): Record<string, number | string | boolean>;
  hapticCue(cue: HapticCue): boolean;
  hapticImpact(cue: HapticCue, scale?: number, controlHeld?: boolean): boolean;
  setHapticsEnabled(enabled: boolean): void;
  audioState(): Record<string, number | string | boolean>;
  audioEventLog(): ReadonlyArray<{ source: string; time: number; strength: number }>;
  opponentFx(): Record<string, number | string>;
  setVisibility(hidden: boolean): void;
  resumeInterruption(): void;
  perfSample(frames: number): Promise<Record<string, number | string>>;
  perfFrames(frameMs: number, frames: number): void;
  collisionCase(name: string): Record<string, number | string | boolean>;
  recordsState(): Record<string, unknown>;
  recordsExport(): string;
  recordsImport(raw: string): { selectedDriverId: string | null };
  recordsCase(name: string): Record<string, unknown>;
  rivalCase(): Record<string, unknown>;
  enduranceCase(flights: number): Record<string, unknown>;
  collisionFeedbackCase(): Record<string, unknown>;
}

let freeCamPose: { p: [number, number, number]; l: [number, number, number] } | null = null;
let harnessUsePlayerInput = false;
let harnessForceAirBrake = false;
let harnessSuppressAirborneFlightTrigger = false;

function advanceUntil(cond: () => boolean, maxSeconds: number): void {
  let elapsed = 0;
  while (!cond() && elapsed < maxSeconds) {
    loop.advance(0.25);
    elapsed += 0.25;
  }
}

const tmpP = new THREE.Vector3();
const tmpT = new THREE.Vector3();

/** Place all boats around course position u, staggered like a racing pack. */
function placePack(uPlayer: number): void {
  const offsets = [0, -0.012, -0.006, -0.018, -0.024, -0.03];
  const laterals = [0, 4, -4, 2, -5.5, 5.5];
  for (let i = 0; i < boats.length; i++) {
    const u = (((uPlayer + offsets[i]) % 1) + 1) % 1;
    course.pointAt(u, tmpP);
    course.tangentAt(u, tmpT);
    const heading = Math.atan2(tmpT.x, tmpT.z);
    boats[i].teleport(tmpP.x + tmpT.z * laterals[i], tmpP.z - tmpT.x * laterals[i], heading);
    wakes[i].clear();
  }
}

/** Put real opponents in the player's forward view before a surface hairpin. */
function placeOpponentDriftPack(uPlayer: number): void {
  const offsets = [0, 0.004, 0.008, 0.012, -0.01, -0.016];
  const laterals = [0, -2.2, 2.2, -4.2, 4.2, 0];
  for (let i = 0; i < boats.length; i++) {
    const u = (((uPlayer + offsets[i]) % 1) + 1) % 1;
    course.pointAt(u, tmpP);
    course.tangentAt(u, tmpT);
    const heading = Math.atan2(tmpT.x, tmpT.z);
    boats[i].teleport(tmpP.x + tmpT.z * laterals[i], tmpP.z - tmpT.x * laterals[i], heading);
    wakes[i].clear();
  }
}

function setHarnessInput(input: Partial<BoatInput> | null): void {
  harnessPlayerInput = input ? {
    throttle: input.throttle ?? 0,
    steer: input.steer ?? 0,
    drift: input.drift ?? false,
    flightTrigger: input.flightTrigger ?? false,
    airBrake: input.airBrake ?? false,
  } : null;
}

function harnessPcPrimerCase(): Record<string, unknown> {
  const primer = new PcControlPrimer();
  const base = boats[0].state;
  const state = (overrides: Partial<BoatState> = {}): BoatState => ({
    ...base,
    drifting: false,
    driftReleaseReady: false,
    flightCharges: 0,
    flightPhase: 'surface',
    ...overrides,
  });
  const steps: string[] = [];
  const run = (dt: number, current: BoatState, guideActive = false): void => {
    const presentation = primer.update(dt, {
      state: current,
      racing: true,
      guideActive,
      keyboardActive: true,
      presentationBlocked: false,
    });
    steps.push(presentation?.step ?? primer.step);
  };
  const initial = state();
  primer.arm(true, initial);
  run(0.26, initial);
  run(1 / 60, state({ drifting: true }));
  run(1 / 60, state({ drifting: true, driftReleaseReady: true }));
  run(1 / 60, state({ flightCharges: 1 }));
  run(0.7, state({ flightCharges: 1 }));
  run(1 / 60, state({ flightCharges: 1 }), true);
  run(1 / 60, state({ flightCharges: 0, flightPhase: 'spool' }), true);
  run(0.5, state({ flightCharges: 0, flightPhase: 'spool' }), true);
  return { steps, finalStep: primer.step, active: primer.active };
}

function tapHarnessFlight(throttle = 1): void {
  setHarnessInput({ throttle, flightTrigger: true });
  loop.advance(1 / 60);
  setHarnessInput({ throttle, flightTrigger: false });
}

/** Trigger one Space edge while preserving the real AI steer/throttle output. */
function pulseHarnessFlightOverAi(): void {
  harnessFlightTriggerPulse = true;
  loop.advance(1 / 60);
  harnessFlightTriggerPulse = false;
}

/** Earn through the real Space path; used to guard the core drift→flight contract. */
function earnHarnessFlight(combo = false): void {
  setHarnessInput({ throttle: 1 });
  advanceUntil(() => boats[0].state.speed >= 18, 5);
  setHarnessInput({ throttle: 1, drift: true });
  loop.advance(0.62);
  setHarnessInput({ throttle: 1, flightTrigger: combo });
  loop.advance(1 / 60);
  setHarnessInput(null);
}

function beginHarnessRouteFlight(routeCursor = 0, initialCharges = 1): void {
  const routeIndex = routeCursor % course.flightRoutes.length;
  const route = course.flightRoutes[routeIndex];
  course.resetFlightChallenge();
  placePack(route.entryU - 0.035);
  for (const boat of boats) {
    boat.state.flightsCleared = routeCursor;
    boat.state.flightRouteCursor = routeCursor;
    boat.state.flightRouteIndex = -1;
    boat.state.flightRouteState = 'idle';
  }
  // Staging starts behind the launch window. Flight-charge earning itself is
  // covered separately; route scenarios focus on flight handling and gates.
  boats[0].state.flightCharges = Math.max(1, Math.min(2, Math.round(initialCharges)));
  setHarnessInput(null);
  advanceUntil(() => boats[0].state.flightPhase !== 'surface', 15);
}

function passHarnessFlight(routeCursor: number, initialCharges = 1, forceAirBrake = false): void {
  beginHarnessRouteFlight(routeCursor, initialCharges);
  harnessForceAirBrake = forceAirBrake;
  harnessSuppressAirborneFlightTrigger = true;
  try {
    advanceUntil(() => boats[0].state.flightRouteState === 'passed' || race.phase === 'defeated', 14);
    if (boats[0].state.flightRouteState !== 'passed') {
      const st = boats[0].state;
      throw new Error(`harness could not pass flight ${routeCursor + 1}: ${st.flightRouteFailReason}; ` +
        `${course.flightDebugStatus(0)}; speed=${st.speed.toFixed(2)}; ` +
        `clearance=${st.flightClearance.toFixed(2)}; gate=${st.flightGateProgress}`);
    }
    loop.advance(0.05);
  } finally {
    harnessForceAirBrake = false;
    harnessSuppressAirborneFlightTrigger = false;
  }
}

function passHarnessExtendedFlight(routeCursor: number, forceAirBrake = false): void {
  beginHarnessRouteFlight(routeCursor, 2);
  harnessForceAirBrake = forceAirBrake;
  harnessSuppressAirborneFlightTrigger = true;
  try {
    advanceUntil(() => boats[0].state.flightExtensionReady || race.phase === 'defeated', 3);
    if (!boats[0].state.flightExtensionReady) {
      throw new Error(`flight ${routeCursor + 1} never exposed its airborne extension`);
    }
    pulseHarnessFlightOverAi();
    advanceUntil(() => boats[0].state.flightRouteState === 'passed' || race.phase === 'defeated', 14);
    if (boats[0].state.flightRouteState !== 'passed') {
      const st = boats[0].state;
      throw new Error(`extended harness could not pass flight ${routeCursor + 1}: ${st.flightRouteFailReason}; ` +
        `${course.flightDebugStatus(0)}; speed=${st.speed.toFixed(2)}; clearance=${st.flightClearance.toFixed(2)}`);
    }
    loop.advance(0.05);
  } finally {
    harnessForceAirBrake = false;
    harnessSuppressAirborneFlightTrigger = false;
  }
}

function harnessFlightRecoveryCase(routeCursor: number): Record<string, number | string | boolean> {
  beginHarnessRouteFlight(routeCursor, 1);
  harnessForceAirBrake = true;
  harnessSuppressAirborneFlightTrigger = true;
  let frames = 0;
  let recoveryFrames = 0;
  let surfaceFrames = 0;
  let maxStep = 0;
  let minPlanarSpeed = Infinity;
  let warningFrames = 0;
  let maxVisibleRoutes = 0;
  let maxRecoveryArrows = 0;
  let sawRecoveryGuide = false;
  let minProgressDelta = Infinity;
  let previousProgress = race.racers[0].progress;
  let previousX = boats[0].state.position.x;
  let previousZ = boats[0].state.position.z;
  let sawPassed = false;
  let sawSurfaceRecovery = false;
  let handoffCount = 0;
  let lastRecoveryActive = false;
  const velocity = new THREE.Vector2();
  try {
    while (frames < 60 * 18 && race.phase === 'racing') {
      loop.advance(1 / 60);
      frames++;
      const state = boats[0].state;
      const guidance = course.guidanceStatus();
      const stepDistance = Math.hypot(state.position.x - previousX, state.position.z - previousZ);
      maxStep = Math.max(maxStep, stepDistance);
      previousX = state.position.x;
      previousZ = state.position.z;
      minProgressDelta = Math.min(minProgressDelta, race.racers[0].progress - previousProgress);
      previousProgress = race.racers[0].progress;
      maxVisibleRoutes = Math.max(maxVisibleRoutes, guidance.visibleRouteCount);
      maxRecoveryArrows = Math.max(maxRecoveryArrows, guidance.recoveryArrowCount);
      sawRecoveryGuide ||= guidance.recoveryGuideOpacity > 0;
      if (race.racers[0].courseWarning !== 'none') warningFrames++;
      if (state.flightRouteState === 'passed') {
        sawPassed = true;
        recoveryFrames++;
        if (state.flightPhase === 'surface') sawSurfaceRecovery = true;
        boats[0].collisionVelocity(velocity);
        minPlanarSpeed = Math.min(minPlanarSpeed, velocity.length());
      }
      const recoveryActive = guidance.recoveryActive > 0;
      if (lastRecoveryActive && !recoveryActive) handoffCount++;
      lastRecoveryActive = recoveryActive;
      if (sawPassed && state.flightRouteState === 'idle') break;
    }
    for (let i = 0; i < 150 && race.phase === 'racing'; i++) {
      loop.advance(1 / 60);
      surfaceFrames++;
      if (race.racers[0].courseWarning !== 'none') warningFrames++;
      maxVisibleRoutes = Math.max(maxVisibleRoutes, course.guidanceStatus().visibleRouteCount);
    }
    const state = boats[0].state;
    return {
      route: routeCursor + 1,
      phase: race.phase,
      routeState: state.flightRouteState,
      sawPassed,
      sawSurfaceRecovery,
      recoveryFrames,
      surfaceFrames,
      handoffCount,
      handoffDebug: course.flightDebugStatus(0),
      warningFrames,
      maxVisibleRoutes,
      maxRecoveryArrows,
      sawRecoveryGuide,
      maxStep,
      minPlanarSpeed: Number.isFinite(minPlanarSpeed) ? minPlanarSpeed : -1,
      minProgressDelta,
      flightsCleared: state.flightsCleared,
      routePasses: harnessRoutePasses[0],
      routeFails: harnessRouteFails[0],
    };
  } finally {
    harnessForceAirBrake = false;
    harnessSuppressAirborneFlightTrigger = false;
  }
}

function harnessMedalRecoveryCase(): Record<string, number | string | boolean> {
  const previousEndlessMode = harnessEndlessMode;
  harnessEndlessMode = true;
  resetRace();
  startFreshCountdown();
  advanceUntil(() => race.phase === 'racing', 8);
  beginHarnessRouteFlight(2, 1);
  harnessForceAirBrake = true;
  harnessSuppressAirborneFlightTrigger = true;
  const dt = 1 / 60;
  try {
    advanceUntil(() => race.phase === 'medal' || race.phase === 'defeated', 14);
    const passState = boats[0].state;
    const passedAtMedal = race.phase === 'medal' && passState.flightRouteState === 'passed';
    const frozenX = passState.position.x;
    const frozenY = passState.position.y;
    const frozenZ = passState.position.z;
    const frozenWorldTime = worldTime;
    const frozenRaceTime = race.raceTime;
    const recoveryAtMedal = course.guidanceStatus().recoveryElapsed;
    const warningEventsAtMedal = harnessCourseWarningEvents;
    loop.advance(MEDAL_CEREMONY_S - 0.1);
    const freezePositionDelta = Math.hypot(
      boats[0].state.position.x - frozenX,
      boats[0].state.position.y - frozenY,
      boats[0].state.position.z - frozenZ,
    );
    const freezeWorldDelta = worldTime - frozenWorldTime;
    const freezeRaceDelta = race.raceTime - frozenRaceTime;
    const freezeRecoveryDelta = course.guidanceStatus().recoveryElapsed - recoveryAtMedal;
    loop.advance(0.15);
    advanceUntil(() => race.phase === 'racing', 5);

    harnessForceAirBrake = false;
    harnessSuppressAirborneFlightTrigger = false;
    setHarnessInput({ throttle: 1, steer: 0 });
    let frames = 0;
    let warningFrames = 0;
    let maxVisibleRoutes = 0;
    let handoffCount = 0;
    let handoffDebug = 'none';
    let handoffSurfaceDistance = -1;
    let sawRouteFourPreview = false;
    let routeFourPreviewLeadSeconds = -1;
    let lastRecovery = course.guidanceStatus().recoveryActive > 0;
    let sawSurfaceRecovery = false;
    let maxStep = 0;
    let previousX = boats[0].state.position.x;
    let previousZ = boats[0].state.position.z;
    const surfaceSample: CourseSample = {
      u: 0,
      point: new THREE.Vector3(),
      tangent: new THREE.Vector3(),
      distance: 0,
      routeId: 'surface',
    };
    while (frames < 36 && race.phase === 'racing') {
      loop.advance(dt);
      frames++;
      const state = boats[0].state;
      const guidance = course.guidanceStatus();
      warningFrames += race.racers[0].courseWarning === 'none' ? 0 : 1;
      maxVisibleRoutes = Math.max(maxVisibleRoutes, guidance.visibleRouteCount);
      sawSurfaceRecovery ||= state.flightRouteState === 'passed' && state.flightPhase === 'surface';
      if (!sawRouteFourPreview && state.flightRouteState === 'passed' && state.flightPhase === 'surface' &&
          guidance.activeRouteIndex === 3) {
        sawRouteFourPreview = true;
        const remainingU = Math.max(0, course.flightRoutes[3].launchFromU - guidance.playerSurfaceU);
        routeFourPreviewLeadSeconds = remainingU * course.length / 50;
      }
      const recovery = guidance.recoveryActive > 0;
      if (lastRecovery && !recovery) {
        handoffCount++;
        handoffDebug = course.flightDebugStatus(0);
        course.sample(state.position, surfaceSample, 'surface');
        handoffSurfaceDistance = surfaceSample.distance;
      }
      lastRecovery = recovery;
      maxStep = Math.max(maxStep, Math.hypot(state.position.x - previousX, state.position.z - previousZ));
      previousX = state.position.x;
      previousZ = state.position.z;
    }
    setHarnessInput({ throttle: 1, steer: -1 });
    let stableSurfaceFrames = 0;
    let correctionFrames = 0;
    let releasedToAi = false;
    while (frames < 60 * 8 && race.phase === 'racing' && stableSurfaceFrames < 120) {
      loop.advance(dt);
      frames++;
      correctionFrames++;
      const state = boats[0].state;
      const guidance = course.guidanceStatus();
      warningFrames += race.racers[0].courseWarning === 'none' ? 0 : 1;
      maxVisibleRoutes = Math.max(maxVisibleRoutes, guidance.visibleRouteCount);
      sawSurfaceRecovery ||= state.flightRouteState === 'passed' && state.flightPhase === 'surface';
      if (!sawRouteFourPreview && state.flightRouteState === 'passed' && state.flightPhase === 'surface' &&
          guidance.activeRouteIndex === 3) {
        sawRouteFourPreview = true;
        const remainingU = Math.max(0, course.flightRoutes[3].launchFromU - guidance.playerSurfaceU);
        routeFourPreviewLeadSeconds = remainingU * course.length / 50;
      }
      const recovery = guidance.recoveryActive > 0;
      if (lastRecovery && !recovery) {
        handoffCount++;
        handoffDebug = course.flightDebugStatus(0);
        course.sample(state.position, surfaceSample, 'surface');
        handoffSurfaceDistance = surfaceSample.distance;
      }
      lastRecovery = recovery;
      maxStep = Math.max(maxStep, Math.hypot(state.position.x - previousX, state.position.z - previousZ));
      previousX = state.position.x;
      previousZ = state.position.z;
      if (!releasedToAi && correctionFrames >= 72) {
        releasedToAi = true;
        setHarnessInput(null);
      }
      stableSurfaceFrames = releasedToAi && state.flightRouteState === 'idle' && state.flightPhase === 'surface'
        ? stableSurfaceFrames + 1 : 0;
    }
    const state = boats[0].state;
    return {
      phaseAtPass: passedAtMedal ? 'medal' : 'invalid',
      phase: race.phase,
      routeState: state.flightRouteState,
      flightPhase: state.flightPhase,
      flightsCleared: state.flightsCleared,
      freezePositionDelta,
      freezeWorldDelta,
      freezeRaceDelta,
      freezeRecoveryDelta,
      warningFrames,
      warningEvents: harnessCourseWarningEvents - warningEventsAtMedal,
      maxVisibleRoutes,
      handoffCount,
      handoffDebug,
      handoffSurfaceDistance,
      sawSurfaceRecovery,
      sawRouteFourPreview,
      routeFourPreviewLeadSeconds,
      maxStep,
      routePasses: harnessRoutePasses[0],
      routeFails: harnessRouteFails[0],
      finalArmed: course.finalStationArmed(),
    };
  } finally {
    setHarnessInput(null);
    harnessForceAirBrake = false;
    harnessSuppressAirborneFlightTrigger = false;
    harnessEndlessMode = previousEndlessMode;
  }
}

function harnessRoute45ContinuousCase(): Record<string, number | string | boolean> {
  const previousEndlessMode = harnessEndlessMode;
  harnessEndlessMode = true;
  resetRace();
  startFreshCountdown();
  advanceUntil(() => race.phase === 'racing', 8);

  // One staging operation before flight four. From this point through the
  // fifth gate the case uses only real fixed-step input, drift, launch,
  // descent and route handoff paths.
  course.resetFlightChallenge();
  placePack(course.flightRoutes[3].launchFromU - 0.006);
  for (const boat of boats) {
    boat.state.flightsCleared = 3;
    boat.state.flightRouteCursor = 3;
    boat.state.flightRouteIndex = -1;
    boat.state.flightRouteState = 'idle';
  }
  boats[0].state.flightCharges = 1;
  setHarnessInput(null);
  harnessForceAirBrake = true;
  harnessSuppressAirborneFlightTrigger = true;

  const dt = 1 / 60;
  let elapsed = 0;
  let firstActionCueAt = -1;
  let routeFiveLaunchAt = -1;
  let airBrakeReadyAt = -1;
  let sawBankCue = false;
  let sawLaunchCue = false;
  let sawRouteFourPassed = false;
  let sawRouteFourSurfaceRecovery = false;
  let sawRouteFourHandoff = false;
  let routeFiveChargeEdges = 0;
  let warningFrames = 0;
  let maxVisibleRoutes = 0;
  let maxStep = 0;
  let previousX = boats[0].state.position.x;
  let previousZ = boats[0].state.position.z;
  let previousCharges = boats[0].state.flightCharges;
  let previousPhase = boats[0].state.flightPhase;
  let previousRouteState = boats[0].state.flightRouteState;

  try {
    while (elapsed < 30 && race.phase === 'racing' && boats[0].state.flightsCleared < 5) {
      loop.advance(dt);
      elapsed += dt;
      const state = boats[0].state;
      const guidance = course.guidanceStatus();
      maxStep = Math.max(maxStep, Math.hypot(state.position.x - previousX, state.position.z - previousZ));
      previousX = state.position.x;
      previousZ = state.position.z;
      maxVisibleRoutes = Math.max(maxVisibleRoutes, guidance.visibleRouteCount);
      warningFrames += race.racers[0].courseWarning === 'none' ? 0 : 1;

      if (state.flightsCleared >= 4) sawRouteFourPassed = true;
      if (state.flightRouteCursor === 4 && state.flightRouteState === 'passed' && state.flightPhase === 'surface') {
        sawRouteFourSurfaceRecovery = true;
      }
      if (state.flightRouteCursor === 4 && previousRouteState === 'passed' && state.flightRouteState === 'idle') {
        sawRouteFourHandoff = true;
      }
      if (guidance.actionRouteIndex === 4 && (guidance.actionCue === 'bank' || guidance.actionCue === 'launch')) {
        if (firstActionCueAt < 0) firstActionCueAt = elapsed;
        sawBankCue ||= guidance.actionCue === 'bank';
        sawLaunchCue ||= guidance.actionCue === 'launch';
      }
      if (state.flightRouteCursor === 4 && state.flightPhase === 'surface' &&
          state.flightCharges > previousCharges) routeFiveChargeEdges++;
      if (state.flightRouteCursor === 4 && previousPhase === 'surface' && state.flightPhase !== 'surface') {
        routeFiveLaunchAt = elapsed;
      }
      if (routeFiveLaunchAt >= 0 && airBrakeReadyAt < 0 && state.flightAirBrake >= 0.7) {
        airBrakeReadyAt = elapsed;
      }

      previousCharges = state.flightCharges;
      previousPhase = state.flightPhase;
      previousRouteState = state.flightRouteState;
    }
    const state = boats[0].state;
    return {
      phase: race.phase,
      flightsCleared: state.flightsCleared,
      routeState: state.flightRouteState,
      routePasses: harnessRoutePasses[0],
      routeFails: harnessRouteFails[0],
      sawRouteFourPassed,
      sawRouteFourSurfaceRecovery,
      sawRouteFourHandoff,
      sawBankCue,
      sawLaunchCue,
      cueLeadSeconds: firstActionCueAt >= 0 && routeFiveLaunchAt >= 0 ? routeFiveLaunchAt - firstActionCueAt : -1,
      routeFiveChargeEdges,
      airBrakeLatencySeconds: routeFiveLaunchAt >= 0 && airBrakeReadyAt >= 0 ? airBrakeReadyAt - routeFiveLaunchAt : -1,
      warningFrames,
      maxVisibleRoutes,
      maxStep,
      elapsed,
      finalArmed: course.finalStationArmed(),
    };
  } finally {
    setHarnessInput(null);
    harnessForceAirBrake = false;
    harnessSuppressAirborneFlightTrigger = false;
    harnessEndlessMode = previousEndlessMode;
  }
}

function finalPortalGeometryCase(): Record<string, boolean> {
  const center = course.pointAt(0, new THREE.Vector3());
  const forward = course.tangentAt(0, new THREE.Vector3());
  const right = new THREE.Vector3(forward.z, 0, -forward.x).normalize();
  const crossing = (lateral: number, direction: -1 | 1, span: number): boolean => {
    const previous = center.clone()
      .addScaledVector(right, lateral)
      .addScaledVector(forward, -span * 0.5 * direction);
    const current = center.clone()
      .addScaledVector(right, lateral)
      .addScaledVector(forward, span * 0.5 * direction);
    return course.crossFinalStation(previous, current);
  };
  return {
    centerForward: crossing(0, 1, 2),
    centerReverse: crossing(0, -1, 2),
    insideLeft: crossing(-7.1, 1, 2),
    insideRight: crossing(7.1, 1, 2),
    outsideLeft: crossing(-7.25, 1, 2),
    outsideRight: crossing(7.25, 1, 2),
    highSpeedSweep: crossing(0, 1, 3.9),
    teleportRejected: crossing(0, 1, 4.1),
  };
}

function harnessFinalApproachCase(): Record<string, unknown> {
  const previousEndlessMode = harnessEndlessMode;
  harnessEndlessMode = false;
  resetRace();
  startFreshCountdown();
  advanceUntil(() => race.phase === 'racing', 8);
  passHarnessFlight(course.flightRoutes.length - 1, 2, true);

  const armedAtPass = course.finalStationArmed();
  const progressAtPass = race.racers[0].progress;
  const routeSample: CourseSample = {
    u: 0,
    point: new THREE.Vector3(),
    tangent: new THREE.Vector3(),
    distance: 0,
    routeId: 'surface',
  };
  let maxRouteDistance = 0;
  let maxStep = 0;
  let warningFrames = 0;
  let recoveryFrames = 0;
  let sawSurfaceRecovery = false;
  let sawHandoff = false;
  let releasedReturnBrake = false;
  let previousX = boats[0].state.position.x;
  let previousZ = boats[0].state.position.z;
  let framesAfterHandoff = 0;

  harnessForceAirBrake = true;
  harnessSuppressAirborneFlightTrigger = true;
  setHarnessInput({ throttle: 1, steer: -1, drift: true, airBrake: true });
  try {
    for (let frame = 0; frame < 60 * 10 && race.phase === 'racing'; frame++) {
      loop.advance(1 / 60);
      const state = boats[0].state;
      const stepDistance = Math.hypot(state.position.x - previousX, state.position.z - previousZ);
      maxStep = Math.max(maxStep, stepDistance);
      previousX = state.position.x;
      previousZ = state.position.z;
      course.sample(state.position, routeSample, 'surface');
      maxRouteDistance = Math.max(maxRouteDistance, routeSample.distance);
      if (race.racers[0].courseWarning !== 'none') warningFrames++;
      if (state.flightRouteState === 'passed') {
        recoveryFrames++;
        if (state.flightPhase === 'surface') sawSurfaceRecovery = true;
      }
      if (state.flightRouteState === 'idle' && state.flightPhase === 'surface') {
        sawHandoff = true;
        framesAfterHandoff++;
        if (!releasedReturnBrake) {
          releasedReturnBrake = true;
          setHarnessInput({ throttle: 1, steer: -1 });
        }
      }
      if (sawHandoff && framesAfterHandoff >= 150 && maxRouteDistance >= 48) break;
    }

    const stateAfterExcursion = boats[0].state;
    const guidanceAfterExcursion = course.guidanceStatus();
    const phaseAfterExcursion = race.phase;
    const warningAfterExcursion = race.racers[0].courseWarning;
    const progressAfterExcursion = race.racers[0].progress;
    const routeStateAfterExcursion = stateAfterExcursion.flightRouteState;
    const flightPhaseAfterExcursion = stateAfterExcursion.flightPhase;
    if (phaseAfterExcursion !== 'racing' || routeStateAfterExcursion !== 'idle' ||
        flightPhaseAfterExcursion !== 'surface') {
      throw new Error(`final free approach did not settle: ${phaseAfterExcursion}/${routeStateAfterExcursion}/${flightPhaseAfterExcursion}`);
    }

    const chargesBeforeBrake = stateAfterExcursion.flightCharges;
    const boostChargeBeforeBrake = stateAfterExcursion.boostCharge;
    const speedBeforeBrake = stateAfterExcursion.speed;
    const headingBeforeBrake = stateAfterExcursion.heading;
    let minBrakeSpeed = speedBeforeBrake;
    let maxBrakeEnvelope = 0;
    setHarnessInput({ throttle: 1, steer: 1, drift: true });
    for (let frame = 0; frame < 90 && race.phase === 'racing'; frame++) {
      loop.advance(1 / 60);
      minBrakeSpeed = Math.min(minBrakeSpeed, boats[0].state.speed);
      maxBrakeEnvelope = Math.max(maxBrakeEnvelope, boats[0].state.flightAirBrake);
    }
    const speedAfterBrake = boats[0].state.speed;
    const headingAfterBrake = boats[0].state.heading;
    const chargesAfterBrake = boats[0].state.flightCharges;
    const boostChargeAfterBrake = boats[0].state.boostCharge;
    const driftingAfterBrake = boats[0].state.drifting;
    const boostingAfterBrake = boats[0].state.boosting;
    setHarnessInput({ throttle: 1, steer: 0 });
    for (let frame = 0; frame < 90 && race.phase === 'racing'; frame++) loop.advance(1 / 60);
    const speedAfterBrakeRelease = boats[0].state.speed;
    const brakeEnvelopeAfterRelease = boats[0].state.flightAirBrake;

    const center = course.pointAt(0, new THREE.Vector3());
    const forward = course.tangentAt(0, new THREE.Vector3());
    const right = new THREE.Vector3(forward.z, 0, -forward.x).normalize();
    const setPortalPose = (plane: number, lateral: number, direction: -1 | 1): void => {
      const position = center.clone().addScaledVector(forward, plane).addScaledVector(right, lateral);
      const fx = forward.x * direction;
      const fz = forward.z * direction;
      boats[0].setCollisionTestMotion(
        position.x,
        position.z,
        Math.atan2(fx, fz),
        fx * 24,
        fz * 24,
      );
    };

    // A pass outside either gold column is simply a miss. It must not finish
    // or revive the retired surface-route failure timers.
    setPortalPose(-1, 7.25, 1);
    course.syncFlightTrackingAfterCollisions(boats);
    race.syncCollisionCorrections();
    setPortalPose(1, 7.25, 1);
    race.update(1 / 60);
    const outsidePhase = race.phase;
    const outsideWarning = race.racers[0].courseWarning;

    // Re-approach from the reverse side to prove Final is the visible portal,
    // not an invisible spline heading requirement.
    setPortalPose(1, 0, -1);
    course.syncFlightTrackingAfterCollisions(boats);
    race.syncCollisionCorrections();
    setPortalPose(-1, 0, -1);
    race.update(1 / 60);

    return {
      armedAtPass,
      phaseAfterExcursion,
      routeStateAfterExcursion,
      flightPhaseAfterExcursion,
      warningAfterExcursion,
      warningFrames,
      recoveryFrames,
      sawSurfaceRecovery,
      sawHandoff,
      maxRouteDistance,
      maxStep,
      progressDrift: Math.abs(progressAfterExcursion - progressAtPass),
      routePasses: harnessRoutePasses[0],
      routeFails: harnessRouteFails[0],
      finalGuideCount: guidanceAfterExcursion.finalGuideCount,
      visibleRouteCount: guidanceAfterExcursion.visibleRouteCount,
      activeRouteIndex: guidanceAfterExcursion.activeRouteIndex,
      chargesBeforeBrake,
      chargesAfterBrake,
      boostChargeBeforeBrake,
      boostChargeAfterBrake,
      speedBeforeBrake,
      speedAfterBrake,
      speedAfterBrakeRelease,
      minBrakeSpeed,
      maxBrakeEnvelope,
      brakeEnvelopeAfterRelease,
      brakeHeadingDelta: Math.abs(Math.atan2(
        Math.sin(headingAfterBrake - headingBeforeBrake),
        Math.cos(headingAfterBrake - headingBeforeBrake),
      )),
      driftingAfterBrake,
      boostingAfterBrake,
      outsidePhase,
      outsideWarning,
      finishedPhase: race.phase,
      geometry: finalPortalGeometryCase(),
    };
  } finally {
    harnessForceAirBrake = false;
    harnessSuppressAirborneFlightTrigger = false;
    setHarnessInput(null);
    harnessEndlessMode = previousEndlessMode;
  }
}

function harnessSurfaceRouteEnforcementCase(): Record<string, unknown> {
  const previousEndlessMode = harnessEndlessMode;
  harnessEndlessMode = false;
  const dt = 1 / 60;
  try {
    resetRace();
    startFreshCountdown();
    advanceUntil(() => race.phase === 'racing', 8);

    // These are the closest non-adjacent surface sections: flight two's
    // entry and the later hairpin approach are only about 67m apart. Moving
    // between them in sub-metre fixed steps used to switch the global-nearest
    // projection and silently legalise a cross-course shortcut.
    const cutFrom = course.pointAt(0.238, new THREE.Vector3());
    const cutTo = course.pointAt(0.604, new THREE.Vector3());
    const cutVector = cutTo.clone().sub(cutFrom);
    const cutDistance = cutVector.length();
    const cutDirection = cutVector.clone().multiplyScalar(1 / cutDistance);
    const cutHeading = Math.atan2(cutDirection.x, cutDirection.z);
    const player = boats[0];
    player.state.flightsCleared = 1;
    player.state.flightRouteCursor = 1;
    player.state.flightRouteIndex = -1;
    player.state.flightRouteState = 'idle';
    player.setCollisionTestMotion(
      cutFrom.x,
      cutFrom.z,
      cutHeading,
      cutDirection.x * 33,
      cutDirection.z * 33,
    );
    course.resetFlightChallenge();
    course.updateFlightRoute(0, boats);
    course.syncFlightTrackingAfterCollisions(boats);
    race.syncCollisionCorrections();

    const checkpointBefore = harnessCheckpointEvents;
    let cutTravelled = 0;
    let cutWarningFrames = 0;
    for (let frame = 1; frame <= 60 * 4 && race.phase === 'racing'; frame++) {
      cutTravelled = frame * 0.55;
      player.setCollisionTestMotion(
        cutFrom.x + cutDirection.x * cutTravelled,
        cutFrom.z + cutDirection.z * cutTravelled,
        cutHeading,
        cutDirection.x * 33,
        cutDirection.z * 33,
      );
      course.updateFlightRoute(dt, boats);
      race.update(dt);
      if (race.racers[0].courseWarning !== 'none') cutWarningFrames++;
    }
    const cutResult = {
      phase: race.phase,
      reason: race.challengeResult?.reason ?? 'none',
      warning: race.racers[0].courseWarning,
      warningFrames: cutWarningFrames,
      travelled: cutTravelled,
      distance: cutDistance,
      checkpointDelta: harnessCheckpointEvents - checkpointBefore,
      finalStationArmed: course.finalStationArmed(),
      flightRouteState: player.state.flightRouteState,
    };

    // A boat visibly pointing backwards must get a stable warning even while
    // its old momentum is still carrying it forward. Legitimate post-gate
    // inertia remains excluded by flight-route ownership before this branch.
    resetRace();
    startFreshCountdown();
    advanceUntil(() => race.phase === 'racing', 8);
    const reverseStart = course.pointAt(0.14, new THREE.Vector3());
    const reverseTangent = course.tangentAt(0.14, new THREE.Vector3()).normalize();
    const reverseHeading = Math.atan2(reverseTangent.x, reverseTangent.z) + Math.PI;
    boats[0].setCollisionTestMotion(
      reverseStart.x,
      reverseStart.z,
      reverseHeading,
      reverseTangent.x * 12,
      reverseTangent.z * 12,
    );
    course.updateFlightRoute(0, boats);
    course.syncFlightTrackingAfterCollisions(boats);
    race.syncCollisionCorrections();
    let facingWarningFrame = -1;
    for (let frame = 1; frame <= 54 && race.phase === 'racing'; frame++) {
      const forwardSlide = frame * 0.18;
      boats[0].setCollisionTestMotion(
        reverseStart.x + reverseTangent.x * forwardSlide,
        reverseStart.z + reverseTangent.z * forwardSlide,
        reverseHeading,
        reverseTangent.x * 12,
        reverseTangent.z * 12,
      );
      course.updateFlightRoute(dt, boats);
      race.update(dt);
      if (facingWarningFrame < 0 && race.racers[0].courseWarning === 'wrong_way') {
        facingWarningFrame = frame;
      }
    }

    return {
      cut: cutResult,
      facing: {
        phase: race.phase,
        warning: race.racers[0].courseWarning,
        warningFrame: facingWarningFrame,
        finalStationArmed: course.finalStationArmed(),
      },
    };
  } finally {
    setHarnessInput(null);
    harnessEndlessMode = previousEndlessMode;
  }
}

function stageHarnessFlightRecovery(routeCursor: number, beat: 'air' | 'surface'): void {
  beginHarnessRouteFlight(routeCursor, 1);
  harnessForceAirBrake = true;
  harnessSuppressAirborneFlightTrigger = true;
  try {
    let guard = 0;
    while (boats[0].state.flightRouteState !== 'passed' && race.phase === 'racing' && guard++ < 60 * 16) {
      loop.advance(1 / 60);
    }
    if (boats[0].state.flightRouteState !== 'passed') {
      throw new Error(`could not stage recovery for flight ${routeCursor + 1}: ${course.flightDebugStatus(0)}`);
    }
    if (beat === 'air') {
      loop.advance(0.4);
    } else {
      guard = 0;
      while (boats[0].state.flightPhase !== 'surface' && boats[0].state.flightRouteState === 'passed' && guard++ < 180) {
        loop.advance(1 / 60);
      }
      if (boats[0].state.flightPhase !== 'surface' || boats[0].state.flightRouteState !== 'passed') {
        throw new Error(`flight ${routeCursor + 1} skipped its surface recovery beat`);
      }
      loop.advance(0.08);
    }
    // Recovery screenshots inspect the navigation handoff itself. Keep the
    // deterministic pack from parking a full hull across that visual target.
    for (let i = 1; i < boats.length; i++) boats[i].object.visible = false;
  } finally {
    harnessForceAirBrake = false;
    harnessSuppressAirborneFlightTrigger = false;
  }
}

function flightRouteDistance(routeId: (typeof course.flightRoutes)[number]['id'], fromU: number, toU: number): number {
  const point = new THREE.Vector3();
  const previous = new THREE.Vector3();
  course.routePointAt(routeId, fromU, previous);
  let distance = 0;
  const segments = 512;
  for (let i = 1; i <= segments; i++) {
    course.routePointAt(routeId, fromU + (toU - fromU) * (i / segments), point);
    distance += point.distanceTo(previous);
    previous.copy(point);
  }
  return distance;
}

function flightBudgetCase(): Record<string, unknown> {
  const envelope = boats[0].debugFlightEnvelope();
  const routes = course.flightRoutes.map((route) => {
    const gateU = route.gateUs[0];
    const earliestToGate = flightRouteDistance(route.id, route.launchFromU, gateU);
    const latestToGate = flightRouteDistance(route.id, route.launchToU, gateU);
    const gateToExit = flightRouteDistance(route.id, gateU, route.exitU);
    return {
      index: route.index,
      earliestToGate,
      latestToGate,
      gateToExit,
      secondsAt29: earliestToGate / 29,
      secondsAtTarget: earliestToGate / route.targetSpeed,
      targetSpeed: route.targetSpeed,
    };
  });
  return { envelope, routes };
}

function qualifyHarnessRun(): void {
  passHarnessFlight(0);
  passHarnessFlight(1);
  passHarnessFlight(2);
}

function stageHarnessCoachDrift(): void {
  const progress = drivingCoach.progress;
  progress.status = 'active';
  for (const key of Object.keys(progress.mastery) as (keyof typeof progress.mastery)[]) progress.mastery[key] = false;
  for (const key of Object.keys(progress.knowledge) as (keyof typeof progress.knowledge)[]) progress.knowledge[key] = false;
  progress.mastery.steered = true;
  // This is a visual fixture, not a save-migration fixture. The mobile suite
  // may already have earned three flights, whose records sanitizer correctly
  // restores proven mastery if this synthetic state is persisted.
  drivingCoach.resetRun(boats[0].state);
  syncDrivingCoachUi();
}

function stageHarnessFirstFailureOffer(): void {
  const progress = drivingCoach.progress;
  progress.status = 'dormant';
  progress.automaticEligible = true;
  for (const key of Object.keys(progress.mastery) as (keyof typeof progress.mastery)[]) progress.mastery[key] = false;
  for (const key of Object.keys(progress.knowledge) as (keyof typeof progress.knowledge)[]) progress.knowledge[key] = false;
  drivingCoach.resetRun(boats[0].state);
  syncDrivingCoachUi();
}

function resumeHarnessQualifiedRun(): void {
  if (race.phase !== 'medal') return;
  loop.advance(MEDAL_CEREMONY_S + 0.05);
  advanceUntil(() => race.phase === 'racing', 5);
}

function placeHarnessBoat(id: number, u: number, lateral = 0): void {
  const wrappedU = ((u % 1) + 1) % 1;
  course.pointAt(wrappedU, tmpP);
  course.tangentAt(wrappedU, tmpT);
  const heading = Math.atan2(tmpT.x, tmpT.z);
  boats[id].teleport(tmpP.x + tmpT.z * lateral, tmpP.z - tmpT.x * lateral, heading);
  wakes[id].clear();
}

/** Move staged boats in small, non-teleport progress increments for battle UX. */
function battleFrame(playerU: number, opponentUs: readonly number[]): void {
  placeHarnessBoat(0, playerU);
  for (let i = 0; i < opponentUs.length; i++) placeHarnessBoat(i + 1, opponentUs[i]);
  loop.advance(1 / 60);
}

function stageOvertake(chain: boolean): void {
  const base = 0.16;
  const opponents = chain
    ? [base, base + 0.0015, base + 0.022, base - 0.015, base - 0.022]
    : [base, base + 0.02, base + 0.03, base - 0.015, base - 0.022];
  battleFrame(base - 0.003, opponents); // tracking resync; no event
  const end = chain ? base + 0.0032 : base + 0.0012;
  for (let i = 1; i <= 10; i++) {
    battleFrame(base - 0.003 + (end - (base - 0.003)) * (i / 10), opponents);
  }
  battleFrame(end, opponents);
}

function stagePositionLoss(): void {
  const base = 0.16;
  const opponentU = base + 0.006;
  const before = [base, base + 0.02, base + 0.03, base - 0.015, base - 0.022];
  battleFrame(base + 0.003, before);
  let after = before;
  for (let i = 1; i <= 10; i++) {
    after = [base + (opponentU - base) * (i / 10), base + 0.02, base + 0.03, base - 0.015, base - 0.022];
    battleFrame(base + 0.003, after);
  }
  battleFrame(base + 0.003, after);
}

function presentPlayerCollisions(hits: readonly { a: number; b: number; strength: number }[]): void {
  const playerHits = hits.filter((hit) => (hit.a === 0 || hit.b === 0) && hit.strength >= 0.8);
  if (playerHits.length === 0) return;
  const hit = playerHits.reduce((best, candidate) => candidate.strength > best.strength ? candidate : best);
  const opponentId = hit.a === 0 ? hit.b : hit.a;
  const strength = hit.strength;
  audio.collision(strength);
  cameraRig.collisionKick(strength);
  pipeline.pulse('collision', Math.min(1.1, 0.3 + strength / 20));
  haptics.impact(
    strength > 10 ? 'collision-heavy' : 'collision-light',
    Math.min(1, 0.45 + strength / 16),
    boats[0].state.drifting || boats[0].state.flightAirBrake > 0.28,
  );
  rivalDirector.notifyPlayerImpact();
  tower.announceCollision(race.racers[opponentId]?.name ?? '对手');
}

function runCollisionCase(name: string): Record<string, number | string | boolean> {
  resetRace();
  collisions.reset();
  const a = boats[0];
  const b = boats[1];
  const park = (): void => {
    for (let i = 0; i < boats.length; i++) {
      boats[i].setCollisionTestMotion(100 + i * 12, 100, 0, 0, 0);
      boats[i].state.boosting = false;
    }
  };
  const allFinite = (): boolean => boats.every((boat) => {
    const velocity = boat.collisionVelocity(new THREE.Vector2());
    return [boat.state.position.x, boat.state.position.y, boat.state.position.z, velocity.x, velocity.y]
      .every(Number.isFinite);
  });
  park();

  if (name === 'route4-inside' || name === 'route4-outside') {
    const def = course.flightRoutes[3];
    const gate = new THREE.Vector3();
    const tangent = new THREE.Vector3();
    course.routePointAt(def.id, def.gateUs[0], gate);
    course.routeTangentAt(def.id, def.gateUs[0], tangent).normalize();
    const right = new THREE.Vector3(tangent.z, 0, -tangent.x);
    const offset = name === 'route4-inside' ? 7.95 : 8.05;
    const before = gate.clone().addScaledVector(tangent, -0.65).addScaledVector(right, offset);
    const after = gate.clone().addScaledVector(tangent, 0.65).addScaledVector(right, offset);
    const heading = Math.atan2(tangent.x, tangent.z);
    a.setCollisionTestMotion(before.x, before.z, heading, 0, 0, before.y);
    a.state.flightsCleared = 3;
    a.state.flightRouteCursor = 3;
    a.state.flightPhase = 'cruise';
    a.state.flightClearance = 4.5;
    a.beginFlightRouteAttempt(3, 3, def.targetSpeed);
    course.updateFlightRoute(0, boats);
    a.setCollisionTestMotion(after.x, after.z, heading, 0, 0, after.y);
    a.state.flightClearance = 4.5;
    course.updateFlightRoute(1 / 60, boats);
    return {
      name,
      configuredLimit: def.passHalfWidth,
      visualHalfWidth: def.gateHalfWidth,
      corridorHalfWidth: def.corridorHalfWidth,
      requestedOffset: offset,
      measuredOffset: Math.abs(a.state.flightFailure?.lateralOffsetM ?? offset),
      routeState: a.state.flightRouteState,
      gates: a.state.flightGateProgress,
      flights: a.state.flightsCleared,
      reason: a.state.flightRouteFailReason,
      finite: allFinite(),
    };
  }

  if (name === 'pair-matrix') {
    let pairCount = 0;
    let hitPairs = 0;
    let maxSpeed = 0;
    let minOpponentThrow = Infinity;
    let maxCorrection = 0;
    let finite = true;
    for (let ai = 0; ai < boats.length - 1; ai++) {
      for (let bi = ai + 1; bi < boats.length; bi++) {
        pairCount++;
        park();
        collisions.reset();
        const attacker = boats[ai];
        const defender = boats[bi];
        attacker.setCollisionTestMotion(-4, 0, Math.PI / 2, 42, 0);
        defender.setCollisionTestMotion(0, 0.2, 0, 0, 29);
        attacker.state.boosting = true;
        collisions.capture(boats);
        attacker.setCollisionTestMotion(1.1, 0, Math.PI / 2, 42, 0);
        defender.setCollisionTestMotion(0, 3, 0, 0, 29);
        const pairHits = collisions.resolve(boats);
        if (pairHits.some((hit) => hit.a === ai && hit.b === bi)) hitPairs++;
        const defenderVelocity = defender.collisionVelocity(new THREE.Vector2());
        minOpponentThrow = Math.min(minOpponentThrow, Math.abs(defenderVelocity.x));
        for (const boat of [attacker, defender]) {
          maxSpeed = Math.max(maxSpeed, boat.collisionVelocity(new THREE.Vector2()).length());
        }
        maxCorrection = Math.max(maxCorrection, collisions.debugState().maxCorrection);
        finite &&= allFinite();
      }
    }
    return { name, pairCount, hitPairs, maxSpeed, minOpponentThrow, maxCorrection, finite };
  }

  if (name === 'three-boat-pileup') {
    const c = boats[2];
    a.setCollisionTestMotion(-4, 0, Math.PI / 2, 42, 0);
    b.setCollisionTestMotion(0, 0, 0, 0, 24);
    c.setCollisionTestMotion(4, 0, -Math.PI / 2, -42, 0);
    collisions.capture(boats);
    a.setCollisionTestMotion(-1.1, 0, Math.PI / 2, 42, 0);
    b.setCollisionTestMotion(0, 0.4, 0, 0, 24);
    c.setCollisionTestMotion(1.1, 0, -Math.PI / 2, -42, 0);
    const hits = collisions.resolve(boats);
    const speeds = [a, b, c].map((boat) => boat.collisionVelocity(new THREE.Vector2()).length());
    return {
      name,
      hits: hits.length,
      distinctPairs: new Set(hits.map((hit) => `${hit.a}:${hit.b}`)).size,
      maxSpeed: Math.max(...speeds),
      maxCorrection: collisions.debugState().maxCorrection,
      finite: allFinite(),
    };
  }

  if (name === 'contact-cooldown') {
    let firstWindowEvents = 0;
    let totalEvents = 0;
    for (let frame = 0; frame < 34; frame++) {
      park();
      a.setCollisionTestMotion(0, -4, 0, 0, 42);
      b.setCollisionTestMotion(0, -0.4, 0, 0, 24);
      collisions.capture(boats);
      a.setCollisionTestMotion(0, -0.2, 0, 0, 42);
      b.setCollisionTestMotion(0, 2, 0, 0, 24);
      const events = collisions.resolve(boats).length;
      totalEvents += events;
      if (frame < 12) firstWindowEvents += events;
    }
    return {
      name,
      firstWindowEvents,
      totalEvents,
      finite: allFinite(),
      maxCorrection: collisions.debugState().maxCorrection,
    };
  }

  if (name === 'flight-gate-isolation') {
    const def = course.flightRoutes[3];
    const gateU = def.gateUs[0];
    const gate = new THREE.Vector3();
    const before = new THREE.Vector3();
    const tangent = new THREE.Vector3();
    course.routePointAt(def.id, gateU, gate);
    course.routePointAt(def.id, gateU - 0.000004, before);
    course.routeTangentAt(def.id, gateU, tangent).normalize();
    const heading = Math.atan2(tangent.x, tangent.z);
    a.setCollisionTestMotion(before.x, before.z, heading, 0, 0, before.y);
    a.state.flightsCleared = 3;
    a.state.flightRouteCursor = 3;
    a.state.flightPhase = 'cruise';
    a.state.flightClearance = 4.5;
    a.beginFlightRouteAttempt(3, 3, def.targetSpeed);
    b.setCollisionTestMotion(before.x - tangent.x * 0.1, before.z - tangent.z * 0.1, heading, 0, 0, before.y);
    course.updateFlightRoute(0, boats);
    const signedBefore = (a.state.position.x - gate.x) * tangent.x + (a.state.position.z - gate.z) * tangent.z;
    const gateBefore = a.state.flightGateProgress;
    collisions.capture(boats);
    collisions.resolve(boats);
    const signedAfter = (a.state.position.x - gate.x) * tangent.x + (a.state.position.z - gate.z) * tangent.z;
    course.syncFlightTrackingAfterCollisions(boats);
    course.updateFlightRoute(1 / 60, boats);
    return {
      name,
      signedBefore,
      signedAfter,
      gateBefore,
      gateAfter: a.state.flightGateProgress,
      routeState: a.state.flightRouteState,
      finite: allFinite(),
    };
  }

  if (name === 'checkpoint-isolation') {
    startFreshCountdown();
    loop.advance(4.3);
    const targetU = CHECKPOINT_US[0];
    for (let u = 0; u < targetU - 0.000002; u += 0.005) {
      placeHarnessBoat(0, Math.min(u, targetU - 0.000002));
      race.update(1 / 60);
    }
    placeHarnessBoat(0, targetU - 0.000002);
    race.update(1 / 60);
    park();
    course.pointAt(targetU, tmpP);
    course.tangentAt(targetU, tmpT).normalize();
    const before = new THREE.Vector3().copy(tmpP).addScaledVector(tmpT, -0.005);
    const heading = Math.atan2(tmpT.x, tmpT.z);
    a.setCollisionTestMotion(before.x, before.z, heading, 0, 0, before.y);
    b.setCollisionTestMotion(before.x - tmpT.x * 0.1, before.z - tmpT.z * 0.1, heading, 0, 0, before.y);
    race.update(1 / 60);
    const checkpointBefore = harnessCheckpointEvents;
    const progressBefore = race.racers[0].progress;
    const signedBefore = (a.state.position.x - tmpP.x) * tmpT.x + (a.state.position.z - tmpP.z) * tmpT.z;
    collisions.capture(boats);
    collisions.resolve(boats);
    const signedAfter = (a.state.position.x - tmpP.x) * tmpT.x + (a.state.position.z - tmpP.z) * tmpT.z;
    course.syncFlightTrackingAfterCollisions(boats);
    race.syncCollisionCorrections();
    race.update(1 / 60);
    return {
      name,
      signedBefore,
      signedAfter,
      checkpointDelta: harnessCheckpointEvents - checkpointBefore,
      progressDelta: race.racers[0].progress - progressBefore,
      finite: allFinite(),
    };
  }

  if (name === 'side-boost') {
    a.setCollisionTestMotion(-4, 0, Math.PI / 2, 42, 0);
    b.setCollisionTestMotion(0, 0.2, 0, 0, 29);
    a.state.boosting = true;
    collisions.capture(boats);
    a.setCollisionTestMotion(1.1, 0, Math.PI / 2, 42, 0);
    b.setCollisionTestMotion(0, 3.0, 0, 0, 29);
  } else if (name === 'head-on-ccd') {
    a.setCollisionTestMotion(0, -4, 0, 0, 42);
    b.setCollisionTestMotion(0, 4, Math.PI, 0, -38);
    collisions.capture(boats);
    a.setCollisionTestMotion(0, 2, 0, 0, 42);
    b.setCollisionTestMotion(0, -2, Math.PI, 0, -38);
  } else if (name === 'rear-end') {
    a.setCollisionTestMotion(0, -4, 0, 0, 42);
    b.setCollisionTestMotion(0, -0.4, 0, 0, 24);
    collisions.capture(boats);
    a.setCollisionTestMotion(0, -0.2, 0, 0, 42);
    b.setCollisionTestMotion(0, 2.0, 0, 0, 24);
  } else if (name === 'height-separated') {
    a.setCollisionTestMotion(0, -2, 0, 0, 35, 0);
    b.setCollisionTestMotion(0, 2, Math.PI, 0, -35, 3);
    collisions.capture(boats);
    a.setCollisionTestMotion(0, 0, 0, 0, 35, 0);
    b.setCollisionTestMotion(0, 0, Math.PI, 0, -35, 3);
  } else if (name === 'resting-overlap') {
    a.setCollisionTestMotion(0, 0, 0, 0, 0);
    b.setCollisionTestMotion(0.2, 0, 0, 0, 0);
    collisions.capture(boats);
  } else {
    throw new Error(`unknown collision case: ${name}`);
  }

  const hits = collisions.resolve(boats);
  const av = a.collisionVelocity(new THREE.Vector2());
  const bv = b.collisionVelocity(new THREE.Vector2());
  const debug = collisions.debugState();
  const finite = [a.state.position.x, a.state.position.z, b.state.position.x, b.state.position.z, av.x, av.y, bv.x, bv.y]
    .every(Number.isFinite);
  return {
    name,
    hits: hits.length,
    strength: hits[0]?.strength ?? 0,
    toi: hits[0]?.toi ?? -1,
    playerVX: av.x,
    playerVZ: av.y,
    opponentVX: bv.x,
    opponentVZ: bv.y,
    playerSpeed: av.length(),
    opponentSpeed: bv.length(),
    centerDistance: Math.hypot(a.state.position.x - b.state.position.x, a.state.position.z - b.state.position.z),
    maxCorrection: debug.maxCorrection,
    finite,
  };
}

function runCollisionFeedbackCase(): Record<string, unknown> {
  resetRace();
  startFreshCountdown();
  advanceUntil(() => race.phase === 'racing', 8);
  for (let i = 2; i < boats.length; i++) boats[i].setCollisionTestMotion(100 + i * 12, 100, 0, 0, 0);
  const player = boats[0];
  const opponent = boats[1];
  player.setCollisionTestMotion(-4, 0, Math.PI / 2, 42, 0);
  opponent.setCollisionTestMotion(0, 0.2, 0, 0, 29);
  player.state.boosting = true;
  collisions.reset();
  collisions.capture(boats);
  player.setCollisionTestMotion(1.1, 0, Math.PI / 2, 42, 0);
  opponent.setCollisionTestMotion(0, 3, 0, 0, 29);
  const hits = [...collisions.resolve(boats)];
  course.syncFlightTrackingAfterCollisions(boats);
  race.syncCollisionCorrections();
  const beforeAudioEvents = audio.audioEventLog().length;
  // Feed a same-frame duplicate to the presentation layer. The physical hit
  // list remains untouched, while the player feedback contract must coalesce
  // it to one maximum-strength event.
  presentPlayerCollisions(hits.length > 0 ? [...hits, { ...hits[0], strength: hits[0].strength * 0.72 }] : hits);
  const radio = document.querySelector<HTMLElement>('.race-radio');
  const afterAudioEvents = audio.audioEventLog();
  return {
    hits: hits.length,
    strength: hits[0]?.strength ?? 0,
    musicDuck: Number(audio.debugState().musicDuck),
    collisionAudioEvents: afterAudioEvents.slice(beforeAudioEvents).filter((event) => event.source === 'collision').length,
    hapticLane: haptics.status().lastLane,
    hapticQueuedImpacts: haptics.status().queuedImpacts,
    radioVisible: radio?.classList.contains('on') ?? false,
    radioText: radio?.textContent?.trim() ?? '',
    finite: boats.every((boat) => [boat.state.position.x, boat.state.position.y, boat.state.position.z, boat.state.speed]
      .every(Number.isFinite)),
  };
}

function recordsSnapshot(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(records.data)) as Record<string, unknown>;
}

function runRecordsCase(name: string): Record<string, unknown> {
  if (name !== 'progress') throw new Error(`unknown records case: ${name}`);
  records.beginRun();
  records.recordFlightPass(4, 'tide');
  records.qualifyRun(31.25);
  records.recordExcellent(29.5);
  records.recordRivalWin();
  return recordsSnapshot();
}

function runRivalCase(): Record<string, unknown> {
  const makeRacers = () => race.racers.map((racer) => ({ ...racer }));
  const advanceDirector = (director: RivalDirector, racers: ReturnType<typeof makeRacers>, seconds: number): void => {
    for (let elapsed = 0; elapsed < seconds; elapsed += 1 / 60) director.update(1 / 60, racers);
  };

  const boundsDirector = new RivalDirector();
  boundsDirector.setRoster(roster);
  const racers = makeRacers();
  const player = racers.find((racer) => racer.isPlayer)!;
  const rivalIds = [...boundsDirector.debugState().rivals];
  const nonRival = racers.find((racer) => !racer.isPlayer && !rivalIds.includes(racer.id))!;
  player.progress = 100;
  for (const id of rivalIds) racers[id].progress = 70;
  advanceDirector(boundsDirector, racers, 4);
  const chase = rivalIds.map((id) => boundsDirector.paceFor(id));
  for (const id of rivalIds) racers[id].progress = 130;
  advanceDirector(boundsDirector, racers, 6);
  const release = rivalIds.map((id) => boundsDirector.paceFor(id));

  const lockDirector = new RivalDirector();
  lockDirector.setRoster(roster);
  const lockRacers = makeRacers();
  const lockPlayer = lockRacers.find((racer) => racer.isPlayer)!;
  lockPlayer.progress = 100;
  for (const id of rivalIds) lockRacers[id].progress = 70;
  advanceDirector(lockDirector, lockRacers, 4);
  const beforeLock = rivalIds.map((id) => lockDirector.paceFor(id));
  lockDirector.notifyBattle();
  for (const id of rivalIds) lockRacers[id].progress = 130;
  advanceDirector(lockDirector, lockRacers, 1.5);
  const duringLock = rivalIds.map((id) => lockDirector.paceFor(id));

  const graceDirector = new RivalDirector();
  graceDirector.setRoster(roster);
  const graceRacers = makeRacers();
  const gracePlayer = graceRacers.find((racer) => racer.isPlayer)!;
  gracePlayer.progress = 100;
  for (const id of rivalIds) graceRacers[id].progress = 70;
  graceDirector.notifyPlayerImpact();
  advanceDirector(graceDirector, graceRacers, 2);
  const duringGrace = rivalIds.map((id) => graceDirector.paceFor(id));
  advanceDirector(graceDirector, graceRacers, 1.25);
  const afterGrace = rivalIds.map((id) => graceDirector.paceFor(id));

  return {
    rivalIds,
    chase,
    release,
    beforeLock,
    duringLock,
    duringGrace,
    afterGrace,
    nonRivalId: nonRival.id,
    nonRivalPace: boundsDirector.paceFor(nonRival.id),
  };
}

function runEnduranceCase(requestedFlights: number): Record<string, unknown> {
  const previousEndlessMode = harnessEndlessMode;
  harnessEndlessMode = true;
  const targetFlights = Math.max(7, Math.min(21, Math.floor(requestedFlights)));
  resetRace();
  startFreshCountdown();
  advanceUntil(() => race.phase === 'racing', 8);
  let medalCount = 0;
  for (let cursor = 0; cursor < targetFlights; cursor++) {
    passHarnessFlight(cursor);
    if (race.phase === 'medal') {
      medalCount++;
      resumeHarnessQualifiedRun();
    }
    if (race.phase !== 'racing') break;
  }
  const velocities = boats.map((boat) => boat.collisionVelocity(new THREE.Vector2()).length());
  const final = {
    phase: race.phase,
    flights: boats[0].state.flightsCleared,
    routeCursor: boats[0].state.flightRouteCursor,
    routeSlot: boats[0].state.flightRouteCursor % course.flightRoutes.length,
    passes: harnessRoutePasses[0],
    medalCount,
    challengeTier: race.challengeTier,
    visibleRoutes: course.guidanceStatus().visibleRouteCount,
    maxSpeed: Math.max(...velocities),
    finite: boats.every((boat, i) => [
      boat.state.position.x,
      boat.state.position.y,
      boat.state.position.z,
      boat.state.speed,
      velocities[i],
    ].every(Number.isFinite)),
  };
  resetRace();
  harnessEndlessMode = previousEndlessMode;
  return {
    ...final,
    resetPhase: race.phase,
    resetFlights: boats[0].state.flightsCleared,
    resetRouteCursor: boats[0].state.flightRouteCursor,
    resetVisibleRoutes: course.guidanceStatus().visibleRouteCount,
  };
}

function scenario(name: string): void {
  // Normal harness scenarios exercise the legacy continuation path. The
  // authored finish is isolated to its explicit scenario (or ?finale=1).
  harnessEndlessMode = HARNESS && !params.has('finale');
  if (name === 'final-station' || name === 'expansion-gallery') harnessEndlessMode = false;
  freeCamPose = null;
  harnessUsePlayerInput = false;
  harnessSuppressAirborneFlightTrigger = false;
  setHarnessInput(null);
  resetRace();
  if (name !== 'ready') startFreshCountdown();
  switch (name) {
    case 'ready':
      loop.advance(1.5);
      break;
    case 'countdown':
      loop.advance(1.7); // mid "2"
      break;
    case 'start':
      advanceUntil(() => race.phase === 'racing', 8);
      loop.advance(2.2);
      break;
    case 'pc-primer':
      advanceUntil(() => race.phase === 'racing', 8);
      harnessUsePlayerInput = true;
      setHarnessInput({ throttle: 1 });
      loop.advance(0.35);
      break;
    case 'sweeper':
    case 'chicane':
    case 'hairpin':
    case 'airtime': {
      advanceUntil(() => race.phase === 'racing', 8);
      const u = { sweeper: 0.152, chicane: 0.238, hairpin: 0.63, airtime: 0.762 }[name];
      placePack(u);
      if (name === 'airtime') {
        // Run until the player is actually airborne (or 7s of trying).
        advanceUntil(() => boats[0].state.airborne, 7);
      } else {
        loop.advance(2.6);
      }
      break;
    }
    case 'flight-ready':
      advanceUntil(() => race.phase === 'racing', 8);
      earnHarnessFlight(false);
      loop.advance(0.12);
      break;
    case 'interrupted':
      advanceUntil(() => race.phase === 'racing', 8);
      loop.advance(1.2);
      handleVisibility(true);
      handleVisibility(false);
      break;
    case 'flight-rule':
      advanceUntil(() => race.phase === 'racing', 8);
      placePack(course.flightEntryU + 0.001);
      boats[0].state.flightCharges = 1;
      setHarnessInput({ throttle: 0 });
      loop.advance(0.8);
      break;
    case 'boost-burst':
      advanceUntil(() => race.phase === 'racing', 8);
      earnHarnessFlight(false);
      // Isolate Space's payout so the visual regression is not covered by the
      // larger F-ready prompt. This mutates harness state only.
      boats[0].state.flightCharges = 0;
      loop.advance(0.07);
      break;
    case 'drift-charge':
      advanceUntil(() => race.phase === 'racing', 8);
      setHarnessInput({ throttle: 1 });
      advanceUntil(() => boats[0].state.speed >= 18, 5);
      setHarnessInput({ throttle: 1, drift: true });
      loop.advance(0.9);
      break;
    case 'coach-drift':
      advanceUntil(() => race.phase === 'racing', 8);
      stageHarnessCoachDrift();
      setHarnessInput({ throttle: 1 });
      advanceUntil(() => boats[0].state.speed >= 18, 5);
      loop.advance(1.55);
      // Isolate the coach layout from legitimate battle/impact priority. The
      // production arbiter must still let those notices win during real play.
      hud.clearTransientNotices();
      loop.advance(1 / 60);
      break;
    case 'opponent-drift':
      advanceUntil(() => race.phase === 'racing', 8);
      setHarnessInput({ throttle: 1 });
      placeOpponentDriftPack(0.585);
      advanceUntil(() => boats.slice(1).some((boat) => boat.state.drifting && boat.debugDriftEffects().emissions > 0), 8);
      loop.advance(0.09);
      break;
    case 'flight-spool':
      advanceUntil(() => race.phase === 'racing', 8);
      earnHarnessFlight(false);
      tapHarnessFlight();
      loop.advance(0.055);
      setHarnessInput(null);
      break;
    case 'flight-cruise':
      advanceUntil(() => race.phase === 'racing', 8);
      beginHarnessRouteFlight();
      loop.advance(1.1);
      break;
    case 'flight-extension-ready':
      advanceUntil(() => race.phase === 'racing', 8);
      beginHarnessRouteFlight(2, 2);
      advanceUntil(() => boats[0].state.flightExtensionReady, 2);
      break;
    case 'flight-extension-spool':
      advanceUntil(() => race.phase === 'racing', 8);
      beginHarnessRouteFlight(2, 2);
      tapHarnessFlight();
      break;
    case 'flight-extension-descent':
      advanceUntil(() => race.phase === 'racing', 8);
      placePack(0.8);
      boats[0].state.flightCharges = 2;
      setHarnessInput({ throttle: 0, flightTrigger: true });
      loop.advance(1 / 60);
      setHarnessInput({ throttle: 0 });
      advanceUntil(() => boats[0].state.flightPhase === 'descending', 7);
      break;
    case 'flight-airbrake':
      advanceUntil(() => race.phase === 'racing', 8);
      beginHarnessRouteFlight(1);
      advanceUntil(() => course.flightTurnWarning(boats[0].id), 4);
      setHarnessInput({ throttle: 1, steer: -1, airBrake: true });
      loop.advance(0.24);
      break;
    case 'flight-route4-approach':
      advanceUntil(() => race.phase === 'racing', 8);
      beginHarnessRouteFlight(3);
      advanceUntil(() => {
        const guidance = course.guidanceStatus();
        return guidance.actionCue === 'turn' && guidance.actionRouteIndex === 3;
      }, 3);
      loop.advance(0.08);
      break;
    case 'flight-route5-prepare':
    case 'flight-route5-launch':
      advanceUntil(() => race.phase === 'racing', 8);
      course.resetFlightChallenge();
      placePack(name === 'flight-route5-launch' ? 0.606 : 0.574);
      for (const boat of boats) {
        boat.state.flightsCleared = 4;
        boat.state.flightRouteCursor = 4;
        boat.state.flightRouteIndex = -1;
        boat.state.flightRouteState = 'idle';
      }
      boats[0].state.flightCharges = name === 'flight-route5-launch' ? 1 : 0;
      setHarnessInput({ throttle: 0 });
      loop.advance(1.55);
      break;
    case 'flight-route5-turn':
      advanceUntil(() => race.phase === 'racing', 8);
      beginHarnessRouteFlight(4);
      advanceUntil(() => course.guidanceStatus().actionCue === 'turn', 3);
      setHarnessInput({ throttle: 1, steer: 1, airBrake: true });
      loop.advance(0.16);
      break;
    case 'flight-combo':
      advanceUntil(() => race.phase === 'racing', 8);
      earnHarnessFlight(true);
      loop.advance(0.28);
      break;
    case 'flight-descent':
      advanceUntil(() => race.phase === 'racing', 8);
      beginHarnessRouteFlight();
      boats[0].state.flightCharges = 0;
      advanceUntil(() => boats[0].state.flightRouteState === 'passed', 12);
      setHarnessInput({ throttle: 1 });
      loop.advance(0.18);
      break;
    case 'flight-miss':
      advanceUntil(() => race.phase === 'racing', 8);
      beginHarnessRouteFlight();
      setHarnessInput({ throttle: 1, steer: 1 });
      advanceUntil(() => race.phase === 'defeated', 8);
      setHarnessInput(null);
      break;
    case 'flight-no-launch':
      advanceUntil(() => race.phase === 'racing', 8);
      placePack(course.flightEntryU - 0.025);
      setHarnessInput({ throttle: 1 });
      advanceUntil(() => race.phase === 'defeated', 8);
      setHarnessInput(null);
      break;
    case 'flight-landing-failure':
      advanceUntil(() => race.phase === 'racing', 8);
      beginHarnessRouteFlight();
      advanceUntil(() => boats[0].state.flightRouteState === 'active', 3);
      // Hold the planar test fixture before the portal while the real flight
      // envelope expires. This reaches descending through Boat physics; Course
      // still owns the landing-vs-corridor precedence.
      {
        const anchorX = boats[0].state.position.x;
        const anchorZ = boats[0].state.position.z;
        let guard = 0;
        while (race.phase === 'racing' && guard++ < 60 * 9) {
          loop.advance(1 / 60);
          boats[0].state.position.x = anchorX;
          boats[0].state.position.z = anchorZ;
        }
      }
      setHarnessInput(null);
      break;
    case 'surface-flight-off-course':
      advanceUntil(() => race.phase === 'racing', 8);
      placeHarnessBoat(0, course.flightRoutes[0].gateUs[0], 55);
      setHarnessInput({ throttle: 0 });
      advanceUntil(() => race.phase === 'defeated', 3);
      setHarnessInput(null);
      break;
    case 'surface-off-course':
      advanceUntil(() => race.phase === 'racing', 8);
      placeHarnessBoat(0, 0.14, 55);
      setHarnessInput({ throttle: 1 });
      advanceUntil(() => race.phase === 'defeated', 3);
      setHarnessInput(null);
      break;
    case 'surface-off-course-grace':
      advanceUntil(() => race.phase === 'racing', 8);
      placeHarnessBoat(0, 0.14, 55);
      setHarnessInput({ throttle: 0 });
      loop.advance(0.55);
      placeHarnessBoat(0, 0.14, 0);
      loop.advance(0.4);
      setHarnessInput(null);
      break;
    case 'surface-wrong-way':
      advanceUntil(() => race.phase === 'racing', 8);
      course.pointAt(0.14, tmpP);
      course.tangentAt(0.14, tmpT);
      boats[0].teleport(tmpP.x, tmpP.z, Math.atan2(tmpT.x, tmpT.z) + Math.PI);
      setHarnessInput({ throttle: 1 });
      advanceUntil(() => race.phase === 'defeated', 6);
      setHarnessInput(null);
      break;
    case 'retry-lesson':
      advanceUntil(() => race.phase === 'racing', 8);
      placePack(course.flightEntryU - 0.025);
      setHarnessInput({ throttle: 1 });
      advanceUntil(() => race.phase === 'defeated', 8);
      setHarnessInput(null);
      advanceUntil(() => retryLessonActive, 1);
      loop.advance(0.78);
      break;
    case 'first-failure-offer':
      stageHarnessFirstFailureOffer();
      advanceUntil(() => race.phase === 'racing', 8);
      placePack(course.flightEntryU - 0.025);
      setHarnessInput({ throttle: 1 });
      advanceUntil(() => race.phase === 'defeated', 8);
      setHarnessInput(null);
      advanceUntil(() => retryLessonActive, 1);
      loop.advance(0.32);
      break;
    case 'flight-route':
      advanceUntil(() => race.phase === 'racing', 8);
      beginHarnessRouteFlight();
      advanceUntil(() => boats[0].state.flightRouteState === 'passed' || boats[0].state.flightRouteState === 'failed', 12);
      loop.advance(0.08);
      break;
    case 'flight-recovery-air':
      advanceUntil(() => race.phase === 'racing', 8);
      stageHarnessFlightRecovery(5, 'air');
      break;
    case 'flight-recovery-surface':
      advanceUntil(() => race.phase === 'racing', 8);
      stageHarnessFlightRecovery(5, 'surface');
      break;
    case 'flight-spent-charge':
      advanceUntil(() => race.phase === 'racing', 8);
      beginHarnessRouteFlight();
      boats[0].state.flightCharges = 0;
      advanceUntil(() => boats[0].state.flightRouteState === 'passed', 12);
      setHarnessInput({ throttle: 1 });
      advanceUntil(() => boats[0].state.flightPhase === 'surface' && boats[0].state.flightRouteState === 'idle', 2);
      tapHarnessFlight();
      break;
    case 'endless-qualified':
      advanceUntil(() => race.phase === 'racing', 8);
      qualifyHarnessRun();
      break;
    case 'endless-two':
      advanceUntil(() => race.phase === 'racing', 8);
      passHarnessFlight(0);
      passHarnessFlight(1);
      break;
    case 'medal-ceremony':
      advanceUntil(() => race.phase === 'racing', 8);
      qualifyHarnessRun();
      loop.advance(0.9);
      break;
    case 'endless-four':
      advanceUntil(() => race.phase === 'racing', 8);
      qualifyHarnessRun();
      resumeHarnessQualifiedRun();
      passHarnessFlight(3);
      break;
    case 'endless-medal-fail': {
      advanceUntil(() => race.phase === 'racing', 8);
      qualifyHarnessRun();
      resumeHarnessQualifiedRun();
      beginHarnessRouteFlight(3);
      setHarnessInput({ throttle: 1, steer: 1 });
      advanceUntil(() => race.phase === 'defeated', 10);
      setHarnessInput(null);
      advanceUntil(() => retryLessonActive, 1);
      break;
    }
    case 'final-station': {
      harnessEndlessMode = false;
      advanceUntil(() => race.phase === 'racing', 8);
      for (let i = 0; i < course.flightRoutes.length; i++) {
        passHarnessFlight(i);
        if (race.phase === 'medal') resumeHarnessQualifiedRun();
      }
      // The authored station sits one short straight beyond route seven. Let
      // the player settle and cross the actual line for a deterministic finish.
      advanceUntil(() => race.phase === 'finished', 8);
      break;
    }
    case 'expansion-gallery': {
      harnessEndlessMode = false;
      advanceUntil(() => race.phase === 'racing', 8);
      for (let i = 0; i < course.flightRoutes.length; i++) {
        passHarnessFlight(i);
        if (race.phase === 'medal') resumeHarnessQualifiedRun();
      }
      advanceUntil(() => race.phase === 'finished', 8);
      loop.advance(FINALE_MIN_READ_S + 0.05);
      openExpansionGallery();
      break;
    }
    case 'overtake':
      advanceUntil(() => race.phase === 'racing', 8);
      loop.advance(1.25);
      stageOvertake(false);
      break;
    case 'overtake-chain':
      advanceUntil(() => race.phase === 'racing', 8);
      loop.advance(1.25);
      stageOvertake(true);
      break;
    case 'position-lost':
      advanceUntil(() => race.phase === 'racing', 8);
      loop.advance(1.25);
      stagePositionLoss();
      break;
    default:
      throw new Error(`unknown scenario: ${name}`);
  }
}

if (HARNESS) {
  const harness: Harness = {
    ready: true,
    scenario,
    advance: (seconds) => loop.advance(seconds),
    render: () => {
      if (freeCamPose) {
        stage.camera.position.set(...freeCamPose.p);
        stage.camera.lookAt(...freeCamPose.l);
      }
      stage.renderer.info.reset();
      pipeline.render();
      processCaptureQueue();
    },
    freeCam: (px, py, pz, lx, ly, lz) => {
      freeCamPose = { p: [px, py, pz], l: [lx, ly, lz] };
    },
    chaseCam: () => {
      freeCamPose = null;
    },
    playerPose: () => ({
      x: boats[0].state.position.x,
      y: boats[0].state.position.y,
      z: boats[0].state.position.z,
      heading: boats[0].state.heading,
    }),
    driftingOpponentPose: () => {
      const player = boats[0].state.position;
      const target = boats.slice(1)
        .filter((boat) => boat.state.drifting)
        .sort((a, b) => a.state.position.distanceToSquared(player) - b.state.position.distanceToSquared(player))[0] ?? boats[1];
      return {
        x: target.state.position.x,
        y: target.state.position.y,
        z: target.state.position.z,
        heading: target.state.heading,
      };
    },
    setPlayerInput: setHarnessInput,
    usePlayerInput: (enabled) => {
      harnessUsePlayerInput = enabled;
      if (enabled) setHarnessInput(null);
    },
    earnFlight: earnHarnessFlight,
    tapFlight: tapHarnessFlight,
    passFlight: passHarnessFlight,
    passExtendedFlight: passHarnessExtendedFlight,
    flightRecoveryCase: harnessFlightRecoveryCase,
    medalRecoveryCase: harnessMedalRecoveryCase,
    route45ContinuousCase: harnessRoute45ContinuousCase,
    finalApproachCase: harnessFinalApproachCase,
    surfaceRouteEnforcementCase: harnessSurfaceRouteEnforcementCase,
    flightBudgetCase,
    retry: requestRetry,
    setCoachEnabled: (enabled) => {
      if (enabled) drivingCoach.enable();
      else drivingCoach.disable();
      syncDrivingCoachUi();
    },
    coachState: () => ({
      status: drivingCoach.progress.status,
      automaticEligible: drivingCoach.progress.automaticEligible,
      mastery: { ...drivingCoach.progress.mastery },
      knowledge: { ...drivingCoach.progress.knowledge },
      activeStep: coachPresentation?.id ?? 'none',
      focus: coachPresentation?.focus ?? 'none',
      device: activeInputDevice,
      visible: Boolean(coachPresentation),
    }),
    pcPrimerState: () => ({
      step: pcControlPrimer.step,
      active: pcControlPrimer.active,
      visible: Boolean(pcPrimerPresentation),
      presentationStep: pcPrimerPresentation?.step ?? 'none',
      key: pcPrimerPresentation?.key ?? '',
      activeInputDevice,
    }),
    pcPrimerCase: harnessPcPrimerCase,
    playerState: () => {
      const s = boats[0].state;
      const handling = boats[0].debugDriverHandling();
      const failure = race.challengeResult?.failure;
      return {
        speed: s.speed,
        drifting: s.drifting,
        boostCharge: s.boostCharge,
        driftBankProgress: s.driftBankProgress,
        driftReleaseReady: s.driftReleaseReady,
        boosting: s.boosting,
        boostRemaining: s.boostRemaining,
        flightCharges: s.flightCharges,
        flightReady: s.flightCharges > 0,
        flightPhase: s.flightPhase,
        flightRemaining: s.flightRemaining,
        flightExtensionReady: s.flightExtensionReady,
        flightExtensionUsed: s.flightExtensionUsed,
        flightExtended: s.flightExtended,
        driverAcceleration: handling.acceleration,
        driverSteering: handling.steering,
        driverDriftCharge: handling.driftCharge,
        driverAirControl: handling.airControl,
        flightClearance: s.flightClearance,
        flightThrust: s.flightThrust,
        flightAirBrake: s.flightAirBrake,
        flightDenied: s.flightDenied,
        flightRouteMiss: s.flightRouteMiss,
        flightRouteState: s.flightRouteState,
        flightRouteFailReason: s.flightRouteFailReason,
        flightGateProgress: s.flightGateProgress,
        flightsCleared: s.flightsCleared,
        flightRouteIndex: s.flightRouteIndex,
        flightPressure: s.flightPressure,
        flightPenaltyRemaining: s.flightPenaltyRemaining,
        place: race.racers[0].place,
        courseWarning: race.racers[0].courseWarning,
        wrongWay: race.racers[0].courseWarning === 'wrong_way',
        totalRacers: race.racers.length,
        battleEvents: harnessBattleEvents,
        battleOvertakes: harnessOvertakes,
        battlePositionLosses: harnessPositionLosses,
        lastBattleKind: harnessLastBattleKind,
        lastBattleCount: harnessLastBattleCount,
        lastBattleStreak: harnessLastBattleStreak,
        routePasses: harnessRoutePasses[0],
        routeFails: harnessRouteFails[0],
        phase: race.phase,
        challengeTier: race.challengeTier,
        challengeOutcome: race.challengeResult?.outcome ?? 'none',
        challengeGate: race.challengeResult?.gate ?? 0,
        challengeReason: race.challengeResult?.reason ?? 'none',
        flightFailureTargetGate: failure?.targetGate ?? 0,
        flightFailureTargetGateRaw: failure?.targetGate ?? null,
        flightFailureNumber: failure?.flightNumber ?? 0,
        flightFailureGatesPassed: failure?.gatesPassed ?? 0,
        flightFailureClearance: failure?.clearanceM ?? -1,
        flightFailureLateralOffsetM: failure?.lateralOffsetM ?? null,
        flightFailureLateralLimitM: failure?.lateralLimitM ?? null,
        flightFailureCorridorDistanceM: failure?.corridorDistanceM ?? null,
        flightRouteCursor: s.flightRouteCursor,
        manMedalEarned: race.challengeResult?.manMedalEarned ?? medalEarnedThisRun,
        manMedalsTotal: race.challengeResult?.manMedalsTotal ?? records.data.manMedalsTotal,
        bestFlights: records.data.bestFlights,
        retryLessonActive,
        retryLessonTimer,
        retryLessonDuration,
        retryLessonElapsed,
        retryLessonMinRead,
        retryLessonProgress: retryLessonActive && retryLessonDuration > 0
          ? retryLessonElapsed / retryLessonDuration
          : 0,
        coachStatus: drivingCoach.progress.status,
        coachStep: coachPresentation?.id ?? 'none',
        coachVisible: Boolean(coachPresentation),
        activeInputDevice,
        medalElapsed,
        medalActive: race.phase === 'medal',
        finaleElapsed,
        finaleActive: finalePresentation,
        finalStationArmed: course.finalStationArmed(),
        finalStationCelebrating: course.finaleCelebrating(),
        finaleVisualPhase: finale.visualState().phase,
        finaleFxProgress: finale.visualState().progress,
        finaleFxFlash: finale.visualState().flash,
        finaleFxCrown: finale.visualState().crown,
        finaleFxImpact: finale.visualState().impact,
        finaleActionsVisible: finale.visualState().actionsVisible,
        finaleFocusedAction: finale.focusedAction(),
        finaleCompleted: race.finaleCompleted,
        expansionSeenMask: records.data.expansionSeenMask,
        interruptionActive,
        raceTime: race.raceTime,
        worldTime,
        playerX: s.position.x,
        playerY: s.position.y,
        playerZ: s.position.z,
        steer: s.steer,
        heading: s.heading,
        flightFxRings: boats[0].debugFlightEffects().rings,
        flightFxPlumeLength: boats[0].debugFlightEffects().plumeLength,
        flightFxDeflection: boats[0].debugFlightEffects().deflection,
      };
    },
    stats: () => ({
      ...stage.stats(),
      simTime: loop.simTime,
      worldTime,
      phase: race.phase,
      playerSpeed: boats[0].state.speed,
      playerProgress: race.racers[0].progress,
      flightPhase: boats[0].state.flightPhase,
      flightCharges: boats[0].state.flightCharges,
      flightReady: String(boats[0].state.flightCharges > 0),
      flightClearance: boats[0].state.flightClearance,
      flightRemaining: boats[0].state.flightRemaining,
      boostRemaining: boats[0].state.boostRemaining,
      playerPlace: race.racers[0].place,
      totalRacers: race.racers.length,
      playerFlights: boats[0].state.flightsCleared,
      flightPressure: boats[0].state.flightPressure,
      cameraFov: stage.camera.fov,
      cameraX: stage.camera.position.x,
      cameraY: stage.camera.position.y,
      cameraZ: stage.camera.position.z,
      routeState: boats[0].state.flightRouteState,
      routeFailReason: boats[0].state.flightRouteFailReason,
      routeGate: boats[0].state.flightGateProgress,
      routePasses: harnessRoutePasses.join(','),
      routeFails: harnessRouteFails.join(','),
      routeDebug: boats.map((boat) => course.flightDebugStatus(boat.id)).join(' | '),
      battleEvents: harnessBattleEvents,
      overtakes: harnessOvertakes,
      positionLosses: harnessPositionLosses,
      retryLessonActive: String(retryLessonActive),
      retryLessonTimer,
      racers: race.racers
        .map((r) => `${r.name}:L${r.lap} p${Math.round(r.progress)}${r.finished ? ' FIN' : ''}` +
          `${r.courseWarning === 'wrong_way' ? ' WW' : r.courseWarning === 'off_course' ? ' OFF' : ''}`)
        .join(' | '),
    }),
    guidance: () => course.guidanceStatus(),
    startGantryStatus: () => course.startGantryStatus(),
    finalStationStatus: () => ({
      armed: course.finalStationArmed(),
      celebrating: course.finaleCelebrating(),
      visible: course.finalStationArmed() || course.finaleCelebrating(),
      finalePhase: finale.visualState().phase,
    }),
    mobileStatus: () => mobileInput.status(),
    gamepadStatus: () => gamepadInput.status(),
    hapticStatus: () => haptics.status(),
    hapticCue: (cue) => haptics.cue(cue),
    hapticImpact: (cue, scale, controlHeld) => {
      if (cue !== 'landing' && cue !== 'collision-light' && cue !== 'collision-heavy') return false;
      return haptics.impact(cue, scale, controlHeld);
    },
    setHapticsEnabled: (enabled) => haptics.setEnabled(enabled),
    audioState: () => audio.debugState(),
    audioEventLog: () => audio.audioEventLog(),
    opponentFx: () => {
      const opponents = boats.slice(1);
      const fx = opponents.map((boat) => boat.debugDriftEffects());
      return {
        drifting: opponents.filter((boat) => boat.state.drifting).length,
        emissions: fx.reduce((sum, item) => sum + item.emissions, 0),
        maxEmissions: Math.max(...fx.map((item) => item.emissions)),
        minScale: Math.min(...fx.map((item) => item.scale)),
        maxScale: Math.max(...fx.map((item) => item.scale)),
      };
    },
    setVisibility: handleVisibility,
    resumeInterruption,
    collisionCase: runCollisionCase,
    collisionFeedbackCase: runCollisionFeedbackCase,
    recordsState: recordsSnapshot,
    recordsExport: () => records.exportJson(selectedDriverId),
    recordsImport: (raw) => {
      const result = records.importJson(raw);
      syncDrivingCoachUi();
      return result;
    },
    recordsCase: runRecordsCase,
    rivalCase: runRivalCase,
    enduranceCase: runEnduranceCase,
    perfSample: (frames) => new Promise((resolve) => {
      const times: number[] = [];
      let previous = performance.now();
      const tick = (now: number): void => {
        const frameMs = Math.max(0.01, now - previous);
        previous = now;
        stage.renderer.info.reset();
        pipeline.render();
        stage.updatePerf(frameMs);
        times.push(frameMs);
        if (times.length < Math.max(1, frames)) {
          requestAnimationFrame(tick);
          return;
        }
        times.sort((a, b) => a - b);
        const percentile = (p: number): number => times[Math.min(times.length - 1, Math.floor(times.length * p))];
        resolve({ ...stage.stats(), p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) });
      };
      requestAnimationFrame(tick);
    }),
    perfFrames: (frameMs, frames) => stage.debugPerfFrames(frameMs, frames),
  };
  (window as unknown as { __harness: Harness }).__harness = harness;
  (window as unknown as { __scene: THREE.Scene }).__scene = stage.scene; // harness debugging
  (window as unknown as { __camera: THREE.Camera }).__camera = stage.camera;
  (window as unknown as { __THREE: typeof THREE }).__THREE = THREE;
} else {
  loop.start();
}
