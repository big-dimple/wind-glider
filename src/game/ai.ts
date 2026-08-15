/**
 * ai.ts — spline-following AI drivers.
 *
 * Lookahead steering (P-controller on the signed angle to a spline point
 * 12-42m ahead, scaling with speed) + throttle from a precomputed curvature
 * table (sampled every ~4m, braking distances propagated backwards), plus:
 *   - personalities (see PERSONALITIES, per-field comments)
 *   - externally directed rivalry pace with hysteresis (never teleporting)
 *   - traffic avoidance steer bias + staggered lateral lanes (-4/0/+4m)
 *   - seeded mistakes: short degraded-steering events (mulberry32 — the
 *     screenshot harness gets deterministic runs)
 *
 * Zero per-frame allocation: module temps + one reused BoatInput per
 * controller (the returned object is overwritten every call — consume it
 * immediately).
 */
import * as THREE from 'three';
import type { IBoat, ICourse, BoatInput, Personality, CourseSample } from '../contracts';

const VMAX = 34; // normalization reference top speed (m/s)
const A_LAT = 6.5; // lateral grip budget (m/s^2) behind the corner speed table
const V_MIN_CORNER = 10; // corner speed floor (m/s)
const AVOID_DIST = 5.6; // m; close enough that contact remains a deliberate racing option

interface PersonalityTune {
  cornerMul: number; // multiplier on the curvature-table speed targets
  lookMul: number; // lookahead distance multiplier (short = twitchy, long = smooth)
  steerGain: number; // P gain on signed angle error
  steerRate: number; // 1/s steering smoothing (higher = sharper hands)
  brake: number; // decel (m/s^2) used for brake-point planning — higher = later braking
  apexHug: number; // metres of lateral offset toward the inside of corners
  driftKappa: number; // |curvature| (1/m) above which it holds a drift
  driftMinSpeed: number; // m/s, no drifting below this
  wanderAmp: number; // lateral wander amplitude (m)
  paceJitter: number; // random pace wobble amplitude
  mistakeEvery: readonly [number, number]; // seconds between mistakes [min, max]
  mistakeDur: readonly [number, number]; // mistake length [min, max] seconds
  mistakeSteer: number; // 0..1 how badly steering degrades
}

const PERSONALITIES: Record<Personality, PersonalityTune> = {
  // REEF — sends it: +12% corner speeds, short lookahead, late braking, hugs
  // apexes, drifts to charge boost and boosts out of corners.
  aggressive: {
    cornerMul: 1.12, lookMul: 0.78, steerGain: 2.8, steerRate: 9, brake: 8.0,
    apexHug: 2.8, driftKappa: 0.018, driftMinSpeed: 13,
    wanderAmp: 0, paceJitter: 0,
    mistakeEvery: [42, 65], mistakeDur: [0.35, 0.6], mistakeSteer: 0.4,
  },
  // KAI — textbook: full table speeds, longest smoothest lookahead, earliest
  // braking, tiny apex trim, essentially never drifts, rarest mistakes.
  clean: {
    cornerMul: 1.05, lookMul: 1.0, steerGain: 2.1, steerRate: 5, brake: 6.0,
    apexHug: 0.6, driftKappa: 0.021, driftMinSpeed: 14,
    wanderAmp: 0, paceJitter: 0,
    mistakeEvery: [60, 90], mistakeDur: [0.3, 0.5], mistakeSteer: 0.25,
  },
  // JINX — wanders the course on smooth noise, random over/understeer events,
  // pace comes and goes, bins it often but never for long.
  erratic: {
    cornerMul: 1.0, lookMul: 0.92, steerGain: 2.4, steerRate: 6, brake: 5.5,
    apexHug: 0, driftKappa: 0.024, driftMinSpeed: 15,
    wanderAmp: 2.6, paceJitter: 0.05,
    mistakeEvery: [16, 28], mistakeDur: [0.55, 0.9], mistakeSteer: 0.7,
  },
};

/** Deterministic PRNG so harness screenshots are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Wrap to (-PI, PI]. */
function wrapAngle(a: number): number {
  a = a % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  else if (a <= -Math.PI) a += Math.PI * 2;
  return a;
}

// module temps — zero per-frame allocation
const _sample: CourseSample = {
  u: 0,
  distance: 0,
  point: new THREE.Vector3(),
  tangent: new THREE.Vector3(),
  routeId: 'surface',
};
const _tp = new THREE.Vector3();
const _tt = new THREE.Vector3();

export class AIController {
  private readonly personality: Personality;
  private readonly tune: PersonalityTune;
  private readonly course: ICourse;
  private rng: () => number;
  private readonly seed: number;
  private readonly paceScale: number;
  private readonly preferredLane: number;
  private readonly elite: boolean;
  private readonly input: BoatInput = {
    throttle: 0,
    steer: 0,
    drift: false,
    flightTrigger: false,
    airBrake: false,
  };

  private t = 0;
  private steerSm = 0;
  private drifting = false;
  private driftExitT = 0;
  private mistakeT = 0;
  private mistakeBias = 0;
  private nextMistakeAt: number;
  private readonly pacePhase: number;
  private readonly wanderW1: number;
  private readonly wanderW2: number;
  private readonly wanderP1: number;
  private readonly wanderP2: number;
  private flightWindowSeen = false;
  private flightWantsRoute = false;
  private qualifyingFlight = false;
  private upcomingFlightIndex = -1;

  // curvature / speed tables, built once from the course
  private tableN = 0;
  private tableStep = 0;
  private kappa = new Float32Array(0); // signed, + = left
  private vmax = new Float32Array(0); // per-sample speed targets (pre-personality)

  constructor(personality: Personality, course: ICourse, seed = 1, paceScale = 1, preferredLane = 0, elite = false) {
    this.personality = personality;
    this.tune = PERSONALITIES[personality];
    this.course = course;
    this.seed = seed;
    this.rng = mulberry32(seed);
    this.paceScale = paceScale;
    this.preferredLane = preferredLane;
    this.elite = elite;
    this.nextMistakeAt = this.mistakeEvery();
    this.pacePhase = this.rng() * Math.PI * 2;
    this.wanderW1 = 0.4 + this.rng() * 0.3;
    this.wanderW2 = 1.1 + this.rng() * 0.7;
    this.wanderP1 = this.rng() * Math.PI * 2;
    this.wanderP2 = this.rng() * Math.PI * 2;
    this.buildTables();
  }

  private mistakeEvery(): number {
    const [lo, hi] = this.tune.mistakeEvery;
    return lo + this.rng() * (hi - lo);
  }

  reset(): void {
    this.rng = mulberry32(this.seed);
    this.t = 0;
    this.steerSm = 0;
    this.drifting = false;
    this.driftExitT = 0;
    this.mistakeT = 0;
    this.mistakeBias = 0;
    this.nextMistakeAt = this.mistakeEvery();
    this.flightWindowSeen = false;
    this.flightWantsRoute = false;
    this.qualifyingFlight = false;
    this.upcomingFlightIndex = -1;
  }

  private buildTables(): void {
    const L = this.course.length;
    const n = Math.max(64, Math.round(L / 4)); // sample curvature every ~4m
    this.tableN = n;
    this.tableStep = L / n;
    const tan = new Float32Array(n * 2);
    const v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      this.course.tangentAt(i / n, v);
      const il = 1 / (Math.hypot(v.x, v.z) || 1);
      tan[i * 2] = v.x * il;
      tan[i * 2 + 1] = v.z * il;
    }
    const kappa = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const k = (i - 1 + n) % n;
      kappa[i] = (tan[k * 2] * tan[j * 2 + 1] - tan[k * 2 + 1] * tan[j * 2]) / (2 * this.tableStep);
    }
    // smooth twice (3-tap), so one noisy sample doesn't spike a brake point
    for (let pass = 0; pass < 2; pass++) {
      const src = Float32Array.from(kappa);
      for (let i = 0; i < n; i++) {
        kappa[i] = (src[(i - 1 + n) % n] + src[i] * 2 + src[(i + 1) % n]) * 0.25;
      }
    }
    this.kappa = kappa;
    const vmax = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const k = Math.abs(kappa[i]);
      vmax[i] = clamp(Math.sqrt(A_LAT / Math.max(k, 1e-4)), V_MIN_CORNER, VMAX);
    }
    // backward braking pass (twice around the loop): targets must be reachable
    const a = this.tune.brake;
    for (let pass = 0; pass < 2; pass++) {
      for (let s = 2 * n - 1; s >= 0; s--) {
        const i = s % n;
        const j = (i + 1) % n;
        const reachable = Math.sqrt(vmax[j] * vmax[j] + 2 * a * this.tableStep);
        if (vmax[i] > reachable) vmax[i] = reachable;
      }
    }
    this.vmax = vmax;
  }

  update(
    dt: number,
    me: IBoat,
    all: IBoat[],
    myProgress: number,
    playerProgress: number,
    rivalryPace = 1,
  ): BoatInput {
    const tune = this.tune;
    this.t += dt;
    const speed = Math.max(0, me.state.speed);

    this.course.sample(me.state.position, _sample, this.course.routeForBoat(me.id));
    const myU = _sample.u;
    const idx = Math.floor(myU * this.tableN) % this.tableN;

    const upcomingIndex = me.state.flightRouteCursor % this.course.flightRoutes.length;
    const upcomingRoute = this.course.flightRoutes[upcomingIndex];
    if (upcomingIndex !== this.upcomingFlightIndex) {
      this.upcomingFlightIndex = upcomingIndex;
      this.flightWindowSeen = false;
      this.flightWantsRoute = false;
      this.qualifyingFlight = false;
    }
    const flightWindow = myU >= upcomingRoute.qualifyFromU && myU <= upcomingRoute.exitU + 0.02;
    const qualificationWindow = flightWindow && myU < upcomingRoute.launchFromU &&
      me.state.flightPhase === 'surface';
    if (me.state.flightCharges >= 2 || !qualificationWindow) {
      this.qualifyingFlight = false;
    } else if (!this.qualifyingFlight && me.state.boostCharge < 0.38 && speed > 14) {
      this.qualifyingFlight = true;
    } else if (this.qualifyingFlight && me.state.boostCharge >= 0.5) {
      // Releasing here pays out the unchanged drift boost and earns flight exactly
      // as it does for the player.
      this.qualifyingFlight = false;
    }
    if (!flightWindow) {
      this.flightWindowSeen = false;
      this.flightWantsRoute = false;
    } else if (!this.flightWindowSeen && myU >= upcomingRoute.launchFromU - 0.006) {
      this.flightWindowSeen = true;
      this.flightWantsRoute = this.personality !== 'erratic' || me.state.flightRouteCursor < 2 || this.rng() < 0.9;
    }
    const launchNow =
      this.flightWantsRoute &&
      me.state.flightCharges > 0 &&
      me.state.flightPhase === 'surface' &&
      myU >= upcomingRoute.launchFromU &&
      myU <= upcomingRoute.launchToU;
    const extendNow =
      me.state.flightExtensionReady &&
      me.state.flightRouteState === 'active' &&
      (me.state.flightPhase === 'descending' || me.state.flightRemaining < 0.3);
    const activeRoute = this.course.routeForBoat(me.id);
    const flightRoute =
      activeRoute !== 'surface' ||
      launchNow ||
      (me.state.flightPhase !== 'surface' && flightWindow);
    const routeId = activeRoute !== 'surface' ? activeRoute : upcomingRoute.id;

    // --- lookahead target, with lateral lane/wander/apex offset
    const look = (12 + 30 * clamp01(speed / VMAX)) * tune.lookMul;
    const uAhead = myU + look / this.course.length;
    this.course.routePointAt(flightRoute ? routeId : 'surface', uAhead, _tp);
    this.course.routeTangentAt(flightRoute ? routeId : 'surface', uAhead, _tt);

    // mean + peak signed curvature over the lookahead window (+ = turning left)
    const nAhead = Math.max(2, Math.round(look / this.tableStep));
    let kSum = 0;
    let kMax = 0;
    for (let s = 0; s < nAhead; s++) {
      const k = this.kappa[(idx + s) % this.tableN];
      kSum += k;
      if (Math.abs(k) > kMax) kMax = Math.abs(k);
    }
    const kAvg = kSum / nAhead;

    let lateral = flightRoute ? 0 : this.preferredLane;
    if (tune.wanderAmp > 0) {
      lateral +=
        (tune.wanderAmp *
          (Math.sin(this.t * this.wanderW1 + this.wanderP1) +
            0.5 * Math.sin(this.t * this.wanderW2 + this.wanderP2))) /
        1.5;
    }
    // hug the apex: offset toward the inside of the upcoming corner
    if (!flightRoute) lateral += Math.sign(kAvg) * tune.apexHug * Math.min(1, Math.abs(kAvg) / 0.02);
    lateral = clamp(lateral, -5.5, 5.5);
    _tp.x += -_tt.z * lateral; // left normal of the tangent
    _tp.z += _tt.x * lateral;

    // --- steering: P-controller on the signed angle to the target
    const dx = _tp.x - me.state.position.x;
    const dz = _tp.z - me.state.position.z;
    // world angle of a direction in boat-heading convention: α = atan2(x, z)
    const err = wrapAngle(Math.atan2(dx, dz) - me.state.heading); // + = target left
    const steerRaw = clamp(-err * tune.steerGain, -1, 1); // steer: -1 = full left
    this.steerSm += (steerRaw - this.steerSm) * Math.min(1, dt * tune.steerRate);
    let steer = this.steerSm;

    // --- throttle: slowest reachable target inside the braking window
    let target = Infinity;
    const nWin = Math.max(2, Math.ceil((look + speed * 1.4) / this.tableStep));
    for (let s = 0; s < nWin; s++) {
      const v = this.vmax[(idx + s) % this.tableN];
      if (v < target) target = v;
    }
    // `playerProgress` remains in the signature for deterministic harness
    // compatibility; RivalDirector is now the only source of competitive pace.
    void playerProgress;
    target *= this.paceScale * clamp(rivalryPace, 0.955, 1.05) * tune.cornerMul *
      (1 + tune.paceJitter * Math.sin(this.t * 0.43 + this.pacePhase));
    let throttle = clamp((target - speed) * 0.5, -1, 1);
    if (Math.abs(err) > 1.2) throttle = Math.min(throttle, 0.4); // spun out: recover gently

    // --- drift to charge boost; releasing on corner exit pays it out
    if (!this.drifting) {
      if (kMax > tune.driftKappa && speed > tune.driftMinSpeed) {
        this.drifting = true;
        this.driftExitT = 0;
      }
    } else if (kMax < tune.driftKappa * 0.6) {
      this.driftExitT += dt;
      if (this.driftExitT > 0.35) this.drifting = false; // corner over: release -> boost
    } else {
      this.driftExitT = 0;
    }

    // --- traffic: steer bias away from boats ahead-ish, lift if stuffed
    const fx = Math.sin(me.state.heading);
    const fz = Math.cos(me.state.heading);
    for (const b of all) {
      if (b === me) continue;
      const ox = b.state.position.x - me.state.position.x;
      const oz = b.state.position.z - me.state.position.z;
      if (Math.abs(b.state.position.y - me.state.position.y) > 2.5) continue;
      const d2 = ox * ox + oz * oz;
      if (d2 > AVOID_DIST * AVOID_DIST || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const aheadness = (ox * fx + oz * fz) / d;
      if (aheadness < 0.25) continue;
      const cross = fx * oz - fz * ox; // <0: they are on my left (boat frame)
      const w = (1 - d / AVOID_DIST) * aheadness;
      steer = clamp(steer - 0.55 * Math.sign(cross) * w, -1, 1);
      if (d < 3.1 && aheadness > 0.72) throttle = Math.min(throttle, this.elite ? 0.72 : 0.35);
    }

    // --- seeded mistakes: a short burst of degraded steering (late turn-in / overshoot)
    if (this.mistakeT > 0) {
      this.mistakeT -= dt;
      steer = clamp(steer * (1 - tune.mistakeSteer) + this.mistakeBias * tune.mistakeSteer, -1, 1);
      throttle *= 0.85;
    } else if (!this.elite && this.t >= this.nextMistakeAt) {
      const [dLo, dHi] = tune.mistakeDur;
      this.mistakeT = dLo + this.rng() * (dHi - dLo);
      this.mistakeBias = (this.rng() * 2 - 1) * 0.8;
      this.nextMistakeAt = this.t + this.mistakeT + this.mistakeEvery();
    }

    const out = this.input;
    out.throttle = throttle;
    out.steer = steer;
    out.drift = me.state.flightPhase === 'surface' && (this.drifting || this.qualifyingFlight);
    out.flightTrigger = launchNow || extendNow;
    // The authored air route has a hard first bend. AI uses the same vector
    // air-brake available to the player, without changing water handling.
    out.airBrake = flightRoute && me.state.flightPhase !== 'surface' &&
      speed > 27 && (Math.abs(err) > 0.075 || this.course.flightTurnWarning(me.id));
    return out;
  }
}
