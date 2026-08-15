/**
 * contracts.ts — shared types crossing subsystem boundaries.
 *
 * Every subsystem (water / cel / boat / course+AI / riders / HUD+camera+audio)
 * implements against these exact shapes. main.ts wires them together.
 * Do not change these without updating every consumer.
 */
import type * as THREE from 'three';

// ---------------------------------------------------------------- boats ----

/** Per-frame driving input, produced by the player keyboard or an AI controller. */
export interface BoatInput {
  /** -1 (full reverse/brake) .. 1 (full throttle). */
  throttle: number;
  /** -1 (full left) .. 1 (full right). */
  steer: number;
  /** Held = powerslide. Releasing after a long drift pays out boost. */
  drift: boolean;
  /** Edge-triggered. Starts flight on water, or spends the spare cell to extend an active flight. */
  flightTrigger: boolean;
  /** Held context brake: vector air-braking in flight, return braking after Final arms. */
  airBrake: boolean;
}

export type FlightPhase = 'surface' | 'spool' | 'ascending' | 'cruise' | 'descending';
export type FlightCourseRouteId =
  | 'flight-1'
  | 'flight-2'
  | 'flight-3'
  | 'flight-4'
  | 'flight-5'
  | 'flight-6'
  | 'flight-7';
export type CourseRouteId = 'surface' | FlightCourseRouteId;
export type FlightRouteState = 'idle' | 'active' | 'passed' | 'failed';
export type CourseWarning = 'none' | 'off_course' | 'wrong_way';
export type FlightRouteFailReason =
  | 'none'
  | 'off_course'
  | 'wrong_way'
  | 'no_launch'
  | 'corridor'
  | 'gate'
  | 'gate_left'
  | 'gate_right'
  | 'late'
  | 'landing'
  | 'exit'
  | 'teleport';

/** Immutable evidence captured on the exact frame a flight attempt fails. */
export interface FlightFailureSnapshot {
  reason: FlightRouteFailReason;
  /** Absolute 1-based flight attempt in this run. */
  flightNumber: number;
  /** Zero-based physical route slot reused on later laps. */
  routeSlot: number;
  /** Number of complete flight segments before this failure. */
  flightsCleared: number;
  gatesPassed: number;
  gateCount: number;
  /** Next required gate inside the segment, or null for a route-level failure. */
  targetGate: number | null;
  routeU: number;
  /** Signed offset from the gate centre; negative is left. Null for surface failures. */
  lateralOffsetM: number | null;
  /** Portal pass limit; surface failures use corridorDistanceM instead. */
  lateralLimitM: number | null;
  /** Distance from the authored flight/surface guide, depending on reason. */
  corridorDistanceM: number | null;
  clearanceM: number;
}

export interface FlightRouteNode {
  u: number;
  lateral: number;
  height: number;
}

export type RouteTurnDirection = 'left' | 'right';

export interface FlightRouteNavigation {
  /** Authored bend markers. Direction names the steering action, not screen space. */
  turn?: {
    fromU: number;
    toU: number;
    direction: RouteTurnDirection;
  };
  /** Optional surface preparation and launch markings before this branch. */
  action?: {
    bankFromU: number;
    bankToU: number;
    launchFromU: number;
    launchToU: number;
  };
  /** Keep the scoring curve intact, but author a tangent-matched tail after its final gate. */
  postGateRecovery?: {
    handoffMarginM: number;
    maxDurationS: number;
  };
  /** World-space locator used when the branch is hidden by swell or outside the camera. */
  locatorU?: number;
}

export interface FlightRouteDefinition {
  id: FlightCourseRouteId;
  index: number;
  entryU: number;
  exitU: number;
  gateUs: readonly number[];
  nodes: readonly FlightRouteNode[];
  corridorHalfWidth: number;
  gateHalfWidth: number;
  /** Explicit horizontal pass limit. Kept separate so visuals and rules never drift. */
  passHalfWidth: number;
  targetSpeed: number;
  qualifyFromU: number;
  launchFromU: number;
  launchToU: number;
  turnWarningFromU: number;
  turnWarningToU: number;
  navigation?: FlightRouteNavigation;
}

/**
 * Everything other subsystems need to know about a boat each frame.
 * Owned and written by Boat.update(); read-only for everyone else.
 */
export interface BoatState {
  /** World transform of the hull root. */
  readonly position: THREE.Vector3;
  readonly quaternion: THREE.Quaternion;
  /** Signed forward speed along heading, m/s. */
  speed: number;
  /** Engine revs 0..1 for audio. */
  rpm: number;
  throttle: number;
  steer: number;
  drifting: boolean;
  /** 0..1, charged by drifting, spent by boosting. */
  boostCharge: number;
  /** 0..1 progress toward the release threshold, derived from boostCharge. */
  driftBankProgress: number;
  /** True once releasing the current surface drift will earn a flight charge. */
  driftReleaseReady: boolean;
  boosting: boolean;
  /** Normalized time left in the active boost, or 0 while inactive. */
  boostRemaining: number;
  /** Earned launch charges. Each qualifying surface-drift release adds one, capped at two. */
  flightCharges: number;
  flightPhase: FlightPhase;
  /** Normalized time left in the authored flight envelope. */
  flightRemaining: number;
  /** True when the stored spare cell can be spent to extend this active flight. */
  flightExtensionReady: boolean;
  /** Persistent for the current flight, preventing more than one airborne extension. */
  flightExtensionUsed: boolean;
  /** One-frame pulse emitted when an airborne extension is accepted. */
  flightExtended: boolean;
  /** Hull-root clearance above the live mean water surface, in meters. */
  flightClearance: number;
  /** 0..1 visual/audio thrust envelope for the anti-grav emitters. */
  flightThrust: number;
  /** 0..1 vector air-brake envelope used by handling and feedback. */
  flightAirBrake: number;
  /** Number of complete, independently earned flight segments. */
  flightsCleared: number;
  /** Number of mandatory route slots consumed in this run. */
  flightRouteCursor: number;
  /** Active/latest route index, or -1 while waiting for the next route. */
  flightRouteIndex: number;
  /** Actual-speed-derived 0..1 pressure used by camera, post and audio. */
  flightPressure: number;
  /** One-frame feedback pulses for rejected launches and missed flight gates. */
  flightDenied: boolean;
  flightRouteMiss: boolean;
  /** Authored flight-corridor challenge state; free flight elsewhere stays idle. */
  flightRouteState: FlightRouteState;
  /** Stable reason for the latest route failure, used by HUD and harness. */
  flightRouteFailReason: FlightRouteFailReason;
  flightFailure: FlightFailureSnapshot | null;
  /** Number of mandatory flight gates passed in the active/latest attempt. */
  flightGateProgress: number;
  /** Seconds of reduced forward drive remaining after a route failure. */
  flightPenaltyRemaining: number;
  airborne: boolean;
  airTime: number;
  /** >0 only on the frame a landing impact happens; magnitude = impact speed m/s. */
  landImpulse: number;
  /** Signed lateral acceleration (for rider lean + camera roll), m/s². */
  lateralG: number;
  /** Signed longitudinal acceleration (throttle/brake weight shift), m/s². */
  longG: number;
  /** Yaw heading, radians. 0 = +Z, positive turning left (CCW from above). */
  heading: number;
}

// ------------------------------------------------------ subsystem views ----
// Structural interfaces so subsystems depend on contracts, not on each
// other's implementation files. The concrete classes implement these.

export interface IBoat {
  readonly id: number;
  readonly object: THREE.Object3D;
  readonly state: BoatState;
  /** Attach point for the rider, positioned at the helm. */
  readonly riderMount: THREE.Object3D;
  update(dt: number, input: BoatInput, t: number): void;
  teleport(x: number, z: number, heading: number): void;
  beginFlightRouteAttempt(routeIndex: number, routeCursor: number, targetSpeed: number): void;
  applyFlightGatePass(gateIndex: number): void;
  completeFlightRoute(routeIndex: number, routeCursor: number): void;
  settleFlightRoute(): void;
  /** Recover an AI after a failed route and consume that route without scoring it. */
  recoverFailedFlightRoute(): void;
  applyFlightRouteMiss(failure: FlightFailureSnapshot): void;
  /** Copy the current planar velocity without exposing Boat's mutable integrator state. */
  collisionVelocity(out: THREE.Vector2): THREE.Vector2;
  /** Apply one bounded arcade-contact response after all boats have integrated. */
  applyCollisionResponse(correctionX: number, correctionZ: number, impulseX: number, impulseZ: number): void;
}

export interface IWake {
  readonly object: THREE.Object3D;
  /** Deposit a wake point at the stern. dirX/dirZ = normalized boat forward direction. intensity 0..1. */
  push(pos: THREE.Vector3, dirX: number, dirZ: number, intensity: number): void;
  update(dt: number, t: number): void;
  clear(): void;
}

export interface ISpray {
  /** Emit `count` spray particles at pos with base speed (m/s). */
  burst(pos: THREE.Vector3, count: number, speed: number): void;
  /** Directional launch sheet: forward and right are planar unit vectors. */
  takeoff(pos: THREE.Vector3, forward: THREE.Vector3, right: THREE.Vector3, count: number, speed: number): void;
  update(dt: number, t: number): void;
}

export interface IJetTrail {
  readonly object: THREE.Object3D;
  emit(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    color: number,
    size: number,
    life: number,
  ): void;
  update(dt: number): void;
}

export interface CourseSample {
  /** Normalized position on the closed spline, 0..1. */
  u: number;
  /** Lateral distance from the spline center line, meters. */
  distance: number;
  /** Nearest point on the spline (y = 0, water level). */
  point: THREE.Vector3;
  /** Unit tangent at that point, XZ plane. */
  tangent: THREE.Vector3;
  /** Route used for this projection. The canonical u remains shared. */
  routeId: CourseRouteId;
}

export interface ICourse {
  readonly object: THREE.Object3D;
  /** Total lap length in meters. */
  readonly length: number;
  /** Number of checkpoint gates (start/finish excluded). */
  readonly checkpoints: number;
  readonly flightRoutes: readonly FlightRouteDefinition[];
  /** Compatibility aliases for the first authored segment. */
  readonly flightEntryU: number;
  readonly flightExitU: number;
  readonly flightGateUs: readonly number[];
  pointAt(u: number, out: THREE.Vector3): THREE.Vector3;
  tangentAt(u: number, out: THREE.Vector3): THREE.Vector3;
  routePointAt(routeId: CourseRouteId, u: number, out: THREE.Vector3): THREE.Vector3;
  routeTangentAt(routeId: CourseRouteId, u: number, out: THREE.Vector3): THREE.Vector3;
  /** Nearest-spline lookup for progress + wrong-way detection. */
  sample(pos: THREE.Vector3, out: CourseSample, routeHint?: CourseRouteId): CourseSample;
  routeForBoat(id: number): CourseRouteId;
  flightTurnWarning(id: number): boolean;
  /** Swept, bidirectional crossing of the visible golden Final portal. */
  crossFinalStation(previous: THREE.Vector3, current: THREE.Vector3): boolean;
  armFinalStation(): void;
  finalStationArmed(): boolean;
  triggerFinaleCelebration(): void;
  finaleCelebrating(): boolean;
  resetFinalStation(): void;
  guidanceStatus(): CourseGuidanceStatus;
  resetFlightChallenge(): void;
  updateFlightRoute(dt: number, boats: readonly IBoat[]): void;
  update(dt: number, t: number): void;
}

export interface CourseGuidanceStatus {
  activeRouteIndex: number;
  visibleRouteCount: number;
  surfaceMaskRouteIndex: number;
  /** Passed flight still owns navigation until its authored surface handoff completes. */
  recoveryRouteIndex: number;
  recoveryActive: number;
  recoveryElapsed: number;
  recoveryLimit: number;
  recoveryArrowCount: number;
  recoveryGuideOpacity: number;
  handoffOverlapMeters: number;
  playerSurfaceU: number;
  /** Meters to the current scoring portal, or -1 while no portal is active. */
  targetGateDistance: number;
  /** Visual-only locator-ring scale; never changes the scoring opening. */
  targetAnchorScale: number;
  /** Final becomes the sole scored destination after all seven routes clear. */
  finalActive: boolean;
  /** Planar meters from the player to the visible Final portal. */
  finalDistance: number;
  /** Deterministic count of active Final targets (always zero or one). */
  finalGuideCount: number;
  /** Current route-authored action; this never changes input or physics. */
  actionCue: 'none' | 'bank' | 'launch' | 'turn';
  actionRouteIndex: number;
  actionDirection: RouteTurnDirection | 'none';
  actionTargetU: number;
  /** World markers currently carrying the cue. */
  actionMarkerCount: number;
}

/** What the HUD and camera are allowed to know about the race. */
export interface RaceView {
  readonly phase: RacePhase;
  /** 3, 2, 1, or 0 (GO). */
  readonly countdownValue: number;
  readonly raceTime: number;
  /** null means the race has no lap finish. */
  readonly totalLaps: number | null;
  readonly racers: readonly RacerState[];
  readonly challengeResult: ChallengeResult | null;
  readonly challengeTier: ChallengeTier;
  readonly qualificationTime: number | null;
  /** True after a complete seven-flight set has armed the finish station. */
  readonly finalStationArmed: boolean;
  /** True after the player has crossed the final station in this presentation. */
  readonly finaleCompleted: boolean;
}

// ----------------------------------------------------------------- race ----

export type RacePhase =
  | 'ready'
  | 'countdown'
  | 'racing'
  | 'medal'
  | 'resume-countdown'
  | 'defeated'
  | 'finished';

export type ChallengeOutcome = 'defeated' | 'ordinary' | 'excellent';
export type ChallengeTier = 'unqualified' | 'ordinary' | 'excellent';

export interface ChallengeResult {
  outcome: ChallengeOutcome;
  reason: FlightRouteFailReason;
  /** Gate inside the failed route, or 0 when not applicable. */
  gate: number;
  place: number;
  totalRacers: number;
  raceTime: number;
  flightsCleared: number;
  leaderGapSeconds: number | null;
  leaderGapMeters: number | null;
  overtakes: number;
  excellentTotal: number;
  ordinaryNew: boolean;
  manMedalEarned: boolean;
  manMedalsTotal: number;
  bestFlights: number;
  newBest: boolean;
  failure: FlightFailureSnapshot | null;
}

export type Personality = 'aggressive' | 'clean' | 'erratic';

export interface RacerDefinition {
  id: number;
  profileId: string;
  name: string;
  color: number;
  portraitUrl: string;
  isPlayer: boolean;
  personality: Personality;
  pace: number;
  lane: number;
  startPlace: number;
  startDistance: number;
  startLateral: number;
}

export interface RacerState {
  id: number;
  name: string;
  isPlayer: boolean;
  color: number;
  /** 1-based current lap. */
  lap: number;
  /** Total race distance along the course spline, meters (lap * length + segment). */
  progress: number;
  /** 1-based place, updated each frame. */
  place: number;
  /** Last completed lap time, seconds. -1 if none. */
  lastLapTime: number;
  bestLapTime: number;
  /** Split delta vs leader at last checkpoint gate, seconds. 0 if none. */
  splitDelta: number;
  finished: boolean;
  eliminated: boolean;
  finishTime: number;
  courseWarning: CourseWarning;
}

export type RaceBattleKind = 'overtake' | 'lost';

export interface RaceBattleOpponent {
  id: number;
  name: string;
  color: number;
}

export interface RaceBattleEvent {
  kind: RaceBattleKind;
  opponents: readonly RaceBattleOpponent[];
  fromPlace: number;
  toPlace: number;
  /** Consecutive confirmed overtakes inside the combo window; zero for losses. */
  streak: number;
  rankChanged: boolean;
  rankDelta: number;
  raceTime: number;
}

// --------------------------------------------------------------- camera ----

export type CameraMode = 'orbit' | 'chase' | 'results' | 'defeat';

// --------------------------------------------------------------- layers ----

/**
 * Layer for "solid ink" objects: boats, riders, gates, buoys.
 * The normal/depth prepass camera renders ONLY this layer, and the Sobel
 * edge pass + ocean foam-ring mask read that prepass. Ocean, sky, racing
 * line, wakes and spray stay OFF this layer (they handle their own style).
 */
export const LAYER_INK = 1;
/** Selective energy/glow layer. Never contributes to the ink prepass. */
export const LAYER_ENERGY = 2;

/** Recursively enable the ink layer on an object subtree (call after building a mesh tree). */
export function markInk(root: THREE.Object3D): void {
  root.traverse((o) => o.layers.enable(LAYER_INK));
}
