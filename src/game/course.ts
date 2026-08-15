/**
 * course.ts — the circuit: spline, racing-line ribbon, start/finish checker
 * strip + gantry, gates, buoys, grid.
 *
 * One closed centripetal CatmullRom through 18 designed control points:
 *   (1) start/finish on a ~290m straight heading +Z through the origin,
 *   (2) fast right-hand sweeper,
 *   (3) L-R chicane,
 *   (4) a 180-degree hairpin (reached via a long right loop corner that
 *       drops down off the chicane plateau),
 *   (5) a 350m straight running ~85-90 degrees ACROSS the primary swell
 *       [0.94, 0.34] — the AIRTIME section, boats launch off crests,
 *   (6) a wide carousel back to the line.
 *   DESIGN NOTE: the brief asked for a LEFT carousel. With a +Z start
 *   straight, an early right sweeper and a swell-perpendicular airtime
 *   straight, a left carousel geometrically cannot close a compact
 *   non-crossing loop (it always exits ~2R to the wrong side or crosses
 *   the hairpin corridor); the carousel is therefore right-handed.
 *   Everything else matches the brief. Verified by the module-load sanity
 *   log below: lap 2511m, min non-adjacent clearance ~67m.
 *
 * u is ALWAYS arc-length-normalized here (getPointAt/getTangentAt), so
 * progress, splits and ribbon dashes are all true meters.
 *
 * Also exports:
 *   CHECKPOINT_US — gate u-positions (race.ts consumes these so splits and
 *                   the anti-cheat order line up with the physical gates)
 *   GRID_SLOTS    — four staggered start positions, with the player at the back
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  markInk,
  LAYER_ENERGY,
  LAYER_INK,
  type CourseRouteId,
  type CourseGuidanceStatus,
  type CourseSample,
  type FlightCourseRouteId,
  type FlightRouteDefinition,
  type FlightRouteFailReason,
  type IBoat,
  type ICourse,
} from '../contracts';
import { PALETTE } from '../core/palette';
import { RACER_DEFS } from './racers';
import { WAVES_GLSL, waterHeight, waterNormalInto } from '../water/waves';
import { createToonMaterial } from '../cel/toonMaterial';
import { addOutline } from '../cel/outline';

// -------------------------------------------------------------- spline ----

const CONTROL_POINTS: readonly (readonly [number, number])[] = [
  [0, 0],         //  0 start/finish line (u = 0), main straight heading +Z
  [0, 280],       //  1 main straight end
  [22.8, 365],    //  2 fast right sweeper
  [98.2, 434.1],  //  3 sweeper
  [199.5, 447.4], //  4 sweeper exit
  [240, 445],     //  5 chicane kink L
  [310, 500],     //  6 chicane apex
  [393.8, 475.3], //  7 chicane kink R
  [433.2, 468.3], //  8 chicane exit
  [506.5, 430.1], //  9 right loop corner (~240 deg, descends to the hairpin)
  [528.4, 264.1], // 10 loop corner
  [373.7, 200.1], // 11 loop corner
  [256.5, 350.8], // 12 hairpin entry
  [198.8, 377.8], // 13 hairpin apex
  [171.9, 320.2], // 14 hairpin exit -> airtime straight
  [291, -8.7],    // 15 airtime straight end -> carousel
  [225, -189.9],  // 16 carousel
  [10, -130],     // 17 carousel exit -> back to the straight
];

const CURVE = new THREE.CatmullRomCurve3(
  CONTROL_POINTS.map(([x, z]) => new THREE.Vector3(x, 0, z)),
  true,
  'centripetal',
);
CURVE.arcLengthDivisions = 800;

const LAP_LENGTH = CURVE.getLength();

/** Surface distance at which the run is no longer a missed launch attempt. */
export const SURFACE_ROUTE_FAIL_DISTANCE_M = 42;
const FINAL_PORTAL_HALF_WIDTH_M = 7.15;
const FINAL_PORTAL_MAX_STEP_M = 4;

// ---------------------------------------------------- arc-length table ----

const TABLE_N = 2048;
const TAB_X = new Float32Array(TABLE_N);
const TAB_Z = new Float32Array(TABLE_N);
const TAB_TX = new Float32Array(TABLE_N);
const TAB_TZ = new Float32Array(TABLE_N);

{
  const p = new THREE.Vector3();
  const t = new THREE.Vector3();
  for (let i = 0; i < TABLE_N; i++) {
    CURVE.getPointAt(i / TABLE_N, p);
    CURVE.getTangentAt(i / TABLE_N, t);
    TAB_X[i] = p.x;
    TAB_Z[i] = p.z;
    const il = 1 / (Math.hypot(t.x, t.z) || 1);
    TAB_TX[i] = t.x * il;
    TAB_TZ[i] = t.z * il;
  }
}

/** Module temp for nearestOnSpline — reused, never allocated per call. */
const _near = { u: 0, x: 0, z: 0, tx: 0, tz: 1 };

/**
 * Nearest point on the spline to world (x, z): coarse scan over the 2048-entry
 * table + local parabolic refine between the best sample's neighbours.
 * Result in _near (u arc-length 0..1, point, unit XZ tangent).
 */
function nearestOnSpline(x: number, z: number): void {
  let bi = 0;
  let bd = Infinity;
  for (let i = 0; i < TABLE_N; i++) {
    const dx = x - TAB_X[i];
    const dz = z - TAB_Z[i];
    const d = dx * dx + dz * dz;
    if (d < bd) {
      bd = d;
      bi = i;
    }
  }
  const im = (bi - 1 + TABLE_N) % TABLE_N;
  const ip = (bi + 1) % TABLE_N;
  const dxm = x - TAB_X[im];
  const dzm = z - TAB_Z[im];
  const dm = dxm * dxm + dzm * dzm;
  const dxp = x - TAB_X[ip];
  const dzp = z - TAB_Z[ip];
  const dp = dxp * dxp + dzp * dzp;
  const denom = dm - 2 * bd + dp;
  let off = denom > 1e-9 ? (0.5 * (dm - dp)) / denom : 0;
  if (off > 1) off = 1;
  else if (off < -1) off = -1;
  _near.u = (((bi + off) / TABLE_N) % 1 + 1) % 1;
  if (off >= 0) {
    _near.x = TAB_X[bi] + (TAB_X[ip] - TAB_X[bi]) * off;
    _near.z = TAB_Z[bi] + (TAB_Z[ip] - TAB_Z[bi]) * off;
    _near.tx = TAB_TX[bi] + (TAB_TX[ip] - TAB_TX[bi]) * off;
    _near.tz = TAB_TZ[bi] + (TAB_TZ[ip] - TAB_TZ[bi]) * off;
  } else {
    _near.x = TAB_X[bi] + (TAB_X[bi] - TAB_X[im]) * -off;
    _near.z = TAB_Z[bi] + (TAB_Z[bi] - TAB_Z[im]) * -off;
    _near.tx = TAB_TX[bi] + (TAB_TX[bi] - TAB_TX[im]) * -off;
    _near.tz = TAB_TZ[bi] + (TAB_TZ[bi] - TAB_TZ[im]) * -off;
  }
  const il = 1 / (Math.hypot(_near.tx, _near.tz) || 1);
  _near.tx *= il;
  _near.tz *= il;
}

// ------------------------------------------------------------ checkpoints ----

/** World-XZ anchors for the 8 checkpoint gates, snapped to the spline below. */
const GATE_ANCHORS: readonly (readonly [number, number])[] = [
  [60, 400],     // sweeper mid
  [240, 445],    // chicane in
  [310, 500],    // chicane apex
  [528, 340],    // loop corner mid
  [230, 372],    // hairpin
  [180, 300],    // airtime entry
  [291, -8.7],   // airtime end
  [215, -180],   // carousel mid
];

/** Gate u-positions on the closed spline, ascending. race.ts relies on the order. */
export const CHECKPOINT_US: readonly number[] = GATE_ANCHORS.map(([x, z]) => {
  nearestOnSpline(x, z);
  return _near.u;
});

// ---------------------------------------------------- anti-grav branches ----

export const FLIGHT_ROUTES: readonly FlightRouteDefinition[] = [
  {
    id: 'flight-1',
    index: 0,
    entryU: 0.06,
    exitU: 0.115,
    gateUs: [0.1],
    nodes: [
      { u: 0.06, lateral: 0, height: 0 },
      { u: 0.075, lateral: 0, height: 4.5 },
      { u: 0.1, lateral: 0, height: 4.5 },
      { u: 0.115, lateral: 0, height: 0 },
    ],
    corridorHalfWidth: 6.5,
    gateHalfWidth: 6.5,
    passHalfWidth: 6.825,
    targetSpeed: 42,
    qualifyFromU: 0.012,
    launchFromU: 0.045,
    launchToU: 0.067,
    turnWarningFromU: 0.06,
    turnWarningToU: 0.06,
  },
  {
    id: 'flight-2',
    index: 1,
    entryU: CHECKPOINT_US[1],
    exitU: 0.315,
    gateUs: [0.3],
    nodes: [
      { u: CHECKPOINT_US[1], lateral: 0, height: 0 },
      { u: 0.262, lateral: 18, height: 4.5 },
      { u: CHECKPOINT_US[2], lateral: 41, height: 4.5 },
      { u: 0.3, lateral: 23, height: 4.5 },
      { u: 0.315, lateral: 0, height: 0 },
    ],
    corridorHalfWidth: 5.5,
    gateHalfWidth: 5.5,
    passHalfWidth: 5.775,
    targetSpeed: 46,
    qualifyFromU: 0.205,
    launchFromU: 0.233,
    launchToU: 0.253,
    turnWarningFromU: 0.258,
    turnWarningToU: 0.292,
    navigation: {
      turn: { fromU: 0.258, toU: 0.292, direction: 'left' },
    },
  },
  {
    id: 'flight-3',
    index: 2,
    entryU: 0.39,
    exitU: 0.47,
    gateUs: [0.45],
    nodes: [
      { u: 0.39, lateral: 0, height: 0 },
      { u: 0.404, lateral: 13, height: 4.5 },
      { u: 0.419, lateral: 22, height: 4.5 },
      { u: 0.435, lateral: 11, height: 4.5 },
      { u: 0.47, lateral: 0, height: 0 },
    ],
    corridorHalfWidth: 5,
    gateHalfWidth: 5,
    passHalfWidth: 5.25,
    targetSpeed: 48,
    qualifyFromU: 0.33,
    launchFromU: 0.375,
    launchToU: 0.398,
    turnWarningFromU: 0.397,
    turnWarningToU: 0.447,
    navigation: {
      turn: { fromU: 0.397, toU: 0.447, direction: 'left' },
      postGateRecovery: { handoffMarginM: 18, maxDurationS: 5.2 },
    },
  },
  {
    id: 'flight-4',
    index: 3,
    entryU: 0.515,
    exitU: 0.58,
    gateUs: [0.56],
    nodes: [
      { u: 0.515, lateral: 0, height: 0 },
      { u: 0.535, lateral: 0, height: 4.5 },
      { u: 0.55, lateral: 0, height: 4.5 },
      { u: 0.565, lateral: 0, height: 4.5 },
      { u: 0.58, lateral: 0, height: 0 },
    ],
    corridorHalfWidth: 8,
    gateHalfWidth: 8,
    passHalfWidth: 8,
    targetSpeed: 46,
    qualifyFromU: 0.482,
    launchFromU: 0.503,
    launchToU: 0.522,
    turnWarningFromU: 0.515,
    turnWarningToU: 0.558,
    navigation: {
      turn: { fromU: 0.515, toU: 0.558, direction: 'left' },
      locatorU: 0.56,
    },
  },
  {
    id: 'flight-5',
    index: 4,
    entryU: 0.635,
    exitU: 0.72,
    gateUs: [0.69875],
    nodes: [
      { u: 0.635, lateral: 0, height: 0 },
      { u: 0.647, lateral: -15, height: 4.5 },
      { u: 0.661, lateral: -28, height: 4.5 },
      { u: 0.677, lateral: -11, height: 4.5 },
      { u: 0.72, lateral: 0, height: 0 },
    ],
    // The strongest lateral route needs a recovery funnel before its precise
    // 5.775m scoring portal. At full vector air-brake the lower approach speed
    // otherwise lets a correct late correction trip the corridor first.
    corridorHalfWidth: 7,
    gateHalfWidth: 5.5,
    passHalfWidth: 5.775,
    targetSpeed: 48,
    qualifyFromU: 0.59,
    launchFromU: 0.62,
    launchToU: 0.642,
    turnWarningFromU: 0.645,
    turnWarningToU: 0.694,
    navigation: {
      action: {
        bankFromU: 0.58,
        bankToU: 0.616,
        launchFromU: 0.616,
        launchToU: 0.624,
      },
      turn: { fromU: 0.645, toU: 0.694, direction: 'right' },
    },
  },
  {
    id: 'flight-6',
    index: 5,
    entryU: 0.775,
    exitU: 0.855,
    gateUs: [0.835],
    nodes: [
      { u: 0.775, lateral: 0, height: 0 },
      { u: 0.788, lateral: 12, height: 4.5 },
      { u: 0.803, lateral: 21, height: 4.5 },
      { u: 0.819, lateral: 10, height: 4.5 },
      { u: 0.855, lateral: 0, height: 0 },
    ],
    corridorHalfWidth: 5,
    gateHalfWidth: 5,
    passHalfWidth: 5.25,
    targetSpeed: 50,
    qualifyFromU: 0.73,
    launchFromU: 0.76,
    launchToU: 0.782,
    turnWarningFromU: 0.785,
    turnWarningToU: 0.831,
    navigation: {
      turn: { fromU: 0.785, toU: 0.831, direction: 'left' },
    },
  },
  {
    id: 'flight-7',
    index: 6,
    entryU: 0.905,
    exitU: 0.975,
    gateUs: [0.9575],
    nodes: [
      { u: 0.905, lateral: 0, height: 0 },
      { u: 0.917, lateral: -3, height: 4.5 },
      { u: 0.933, lateral: -6, height: 4.5 },
      { u: 0.948, lateral: -3, height: 4.5 },
      { u: 0.975, lateral: 0, height: 0 },
    ],
    corridorHalfWidth: 5.5,
    gateHalfWidth: 5.5,
    passHalfWidth: 5.775,
    targetSpeed: 50,
    qualifyFromU: 0.865,
    launchFromU: 0.89,
    launchToU: 0.912,
    turnWarningFromU: 0.916,
    turnWarningToU: 0.954,
  },
] as const;

/** Compatibility aliases used by a few deterministic harness helpers. */
export const FLIGHT_ENTRY_U = FLIGHT_ROUTES[0].entryU;
export const FLIGHT_EXIT_U = FLIGHT_ROUTES[0].exitU;
export const FLIGHT_GATE_US = FLIGHT_ROUTES[0].gateUs;
const FLIGHT_CORRIDOR_GRACE = 0.12;
const FLIGHT_CORRIDOR_FAIL = 0.35;
const FLIGHT_CORRIDOR_FAIL_DISTANCE = 10;
const FLIGHT_GATE_BYPASS_U = 2.5 / LAP_LENGTH;
const FLIGHT_ATTEMPT_EARLY_U = 0.012;

interface FlightRouteRuntime {
  def: FlightRouteDefinition;
  curve: THREE.CatmullRomCurve3;
  recoveryCurve: THREE.CubicBezierCurve3 | null;
  tableN: number;
  routeLength: number;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  tx: Float32Array;
  ty: Float32Array;
  tz: Float32Array;
  u: Float32Array;
  gateFraction: number;
  gateToExitDistance: number;
  near: { u: number; x: number; y: number; z: number; tx: number; ty: number; tz: number; distance: number };
}

function buildFlightRuntime(def: FlightRouteDefinition): FlightRouteRuntime {
  const points: THREE.Vector3[] = [];
  const p = new THREE.Vector3();
  const t = new THREE.Vector3();
  for (const node of def.nodes) {
    CURVE.getPointAt(node.u, p);
    CURVE.getTangentAt(node.u, t);
    const il = 1 / (Math.hypot(t.x, t.z) || 1);
    points.push(new THREE.Vector3(p.x + t.z * il * node.lateral, node.height, p.z - t.x * il * node.lateral));
  }
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  curve.arcLengthDivisions = 320;
  const lastGateU = def.gateUs[def.gateUs.length - 1];
  let recoveryCurve: THREE.CubicBezierCurve3 | null = null;
  if (def.navigation?.postGateRecovery) {
    const gatePoint = curve.getPoint(flightCurveT(def, lastGateU), new THREE.Vector3());
    const gateTangent = curve.getTangent(flightCurveT(def, lastGateU), new THREE.Vector3()).setY(0).normalize();
    const exitPoint = CURVE.getPointAt(def.exitU, new THREE.Vector3());
    exitPoint.y = 0;
    const exitTangent = CURVE.getTangentAt(def.exitU, new THREE.Vector3()).setY(0).normalize();
    const planarDistance = Math.hypot(exitPoint.x - gatePoint.x, exitPoint.z - gatePoint.z);
    const startHandle = Math.min(34, planarDistance * 0.34);
    const endHandle = Math.min(38, planarDistance * 0.4);
    recoveryCurve = new THREE.CubicBezierCurve3(
      gatePoint,
      gatePoint.clone().addScaledVector(gateTangent, startHandle),
      exitPoint.clone().addScaledVector(exitTangent, -endHandle),
      exitPoint,
    );
    recoveryCurve.arcLengthDivisions = 160;
  }
  const authoredLength = curve.getLength() + (recoveryCurve?.getLength() ?? 0);
  const tableN = Math.max(256, Math.ceil(authoredLength / 0.45));
  const runtime: FlightRouteRuntime = {
    def,
    curve,
    recoveryCurve,
    tableN,
    routeLength: 0,
    x: new Float32Array(tableN),
    y: new Float32Array(tableN),
    z: new Float32Array(tableN),
    tx: new Float32Array(tableN),
    ty: new Float32Array(tableN),
    tz: new Float32Array(tableN),
    u: new Float32Array(tableN),
    gateFraction: 0,
    gateToExitDistance: 0,
    near: { u: def.entryU, x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 1, distance: Infinity },
  };
  for (let i = 0; i < tableN; i++) {
    const f = i / (tableN - 1);
    const u = def.entryU + (def.exitU - def.entryU) * f;
    runtimePointAt(runtime, u, p);
    runtimeTangentAt(runtime, u, t).normalize();
    runtime.x[i] = p.x;
    runtime.y[i] = p.y;
    runtime.z[i] = p.z;
    runtime.tx[i] = t.x;
    runtime.ty[i] = t.y;
    runtime.tz[i] = t.z;
    runtime.u[i] = u;
    if (i > 0) {
      runtime.routeLength += Math.hypot(
        runtime.x[i] - runtime.x[i - 1],
        runtime.y[i] - runtime.y[i - 1],
        runtime.z[i] - runtime.z[i - 1],
      );
    }
  }
  runtime.gateFraction = flightCurveT(def, lastGateU);
  const gateIndex = Math.max(0, Math.min(tableN - 1, Math.round(runtime.gateFraction * (tableN - 1))));
  for (let i = gateIndex + 1; i < tableN; i++) {
    runtime.gateToExitDistance += Math.hypot(runtime.x[i] - runtime.x[i - 1], runtime.z[i] - runtime.z[i - 1]);
  }
  return runtime;
}

function runtimePointAt(runtime: FlightRouteRuntime, u: number, out: THREE.Vector3): THREE.Vector3 {
  const recovery = runtime.recoveryCurve;
  const gateU = runtime.def.gateUs[runtime.def.gateUs.length - 1];
  if (recovery && u > gateU) {
    return recovery.getPoint(THREE.MathUtils.clamp((u - gateU) / Math.max(1e-6, runtime.def.exitU - gateU), 0, 1), out);
  }
  return runtime.curve.getPoint(flightCurveT(runtime.def, u), out);
}

function runtimeTangentAt(runtime: FlightRouteRuntime, u: number, out: THREE.Vector3): THREE.Vector3 {
  const recovery = runtime.recoveryCurve;
  const gateU = runtime.def.gateUs[runtime.def.gateUs.length - 1];
  if (recovery && u > gateU) {
    return recovery.getTangent(THREE.MathUtils.clamp((u - gateU) / Math.max(1e-6, runtime.def.exitU - gateU), 0, 1), out);
  }
  return runtime.curve.getTangent(flightCurveT(runtime.def, u), out);
}

const FLIGHT_RUNTIME = FLIGHT_ROUTES.map(buildFlightRuntime);

function flightRuntime(routeId: FlightCourseRouteId): FlightRouteRuntime {
  return FLIGHT_RUNTIME[Number(routeId.slice(-1)) - 1];
}

function nearestOnFlight(runtime: FlightRouteRuntime, x: number, z: number): void {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < runtime.tableN; i++) {
    const dx = x - runtime.x[i];
    const dz = z - runtime.z[i];
    // Route progress and rail clearance are planar. Height is validated by
    // each authored gate; including it here makes a correctly aligned boat
    // project backward while it is still climbing, producing a false miss.
    const d = dx * dx + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  const near = runtime.near;
  near.u = runtime.u[best];
  near.x = runtime.x[best];
  near.y = runtime.y[best];
  near.z = runtime.z[best];
  near.tx = runtime.tx[best];
  near.ty = runtime.ty[best];
  near.tz = runtime.tz[best];
  near.distance = Math.hypot(x - near.x, z - near.z);
}

function flightCurveT(def: FlightRouteDefinition, u: number): number {
  return Math.min(1, Math.max(0, (u - def.entryU) / (def.exitU - def.entryU)));
}

// -------------------------------------------------------------- grid ----

export interface GridSlot {
  x: number;
  z: number;
  heading: number;
  startPlace: number;
}

/** Three-column six-racer grid in boat-id order. The player starts fourth. */
export const GRID_SLOTS: readonly GridSlot[] = RACER_DEFS.map((racer) => {
    const u = (1 - racer.startDistance / LAP_LENGTH) % 1;
    const i = u * TABLE_N;
    const i0 = Math.floor(i) % TABLE_N;
    const i1 = (i0 + 1) % TABLE_N;
    const f = i - Math.floor(i);
    const px = TAB_X[i0] + (TAB_X[i1] - TAB_X[i0]) * f;
    const pz = TAB_Z[i0] + (TAB_Z[i1] - TAB_Z[i0]) * f;
    const tx = TAB_TX[i0] + (TAB_TX[i1] - TAB_TX[i0]) * f;
    const tz = TAB_TZ[i0] + (TAB_TZ[i1] - TAB_TZ[i0]) * f;
    return {
      x: px + tz * racer.startLateral,
      z: pz - tx * racer.startLateral,
      heading: Math.atan2(-tx, tz),
      startPlace: racer.startPlace,
    };
});

// -------------------------------------------------------- sanity check ----

{
  const step = LAP_LENGTH / TABLE_N;
  const SKIP = Math.round(90 / step); // "non-adjacent": >= 90m apart along the lap
  let min = Infinity;
  let mi = 0;
  let mj = 0;
  for (let i = 0; i < TABLE_N; i++) {
    for (let j = i + SKIP; j < i + TABLE_N - SKIP; j++) {
      const jj = j % TABLE_N;
      const dx = TAB_X[i] - TAB_X[jj];
      const dz = TAB_Z[i] - TAB_Z[jj];
      const d = dx * dx + dz * dz;
      if (d < min) {
        min = d;
        mi = i;
        mj = jj;
      }
    }
  }
  console.info(
    `[course] lap ${LAP_LENGTH.toFixed(0)}m, ${CONTROL_POINTS.length} control points, ` +
      `${CHECKPOINT_US.length} checkpoints, min non-adjacent clearance ${Math.sqrt(min).toFixed(1)}m ` +
      `(at ${(mi * step).toFixed(0)}m / ${(mj * step).toFixed(0)}m along the lap)`,
  );
}

// -------------------------------------------------------- module temps ----

const UP = new THREE.Vector3(0, 1, 0);
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _sp = new THREE.Vector3();
const _ta = new THREE.Vector3();
const _routeSample: CourseSample = {
  u: 0,
  distance: 0,
  point: new THREE.Vector3(),
  tangent: new THREE.Vector3(),
  routeId: 'surface',
};
const _recoveryVelocity = new THREE.Vector2();
const _hiddenRecoveryArrow = new THREE.Matrix4().makeScale(0, 0, 0);

/** Central-difference span for tangents (~0.6m of arc). */
const TAN_DU = 0.6 / LAP_LENGTH;

function wrapU(u: number): number {
  return ((u % 1) + 1) % 1;
}

// ------------------------------------------------------- canvas textures ----

function hexCss(hex: number): string {
  return '#' + hex.toString(16).padStart(6, '0');
}

/**
 * Hard-banded horizontal stripe texture for the gate buoys: foam white bands
 * (lower half shaded so the white never reads as a blown #fff slab) + deep
 * ink separators + one committed orange accent band. Crisp rects only
 * (no AA mush), NearestFilter on BOTH filters with no mipmaps so the bands
 * stay razor-hard at any distance instead of blending to gray-green.
 */
function makeStripeTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  // big stripe period: accent band reads at range, ink separators stay crisp
  // (canvas y=0 maps to the cylinder TOP: each foam band is bright on its
  // upper half, shade-toned on its lower half)
  const bands: readonly (readonly [number, number])[] = [
    [PALETTE.foam, 10],
    [PALETTE.cloudShade, 10],
    [PALETTE.ink, 8],
    [PALETTE.hullReef, 18],
    [PALETTE.ink, 8],
    [PALETTE.foam, 5],
    [PALETTE.cloudShade, 5],
  ];
  let y = 0;
  for (const [hex, h] of bands) {
    g.fillStyle = hexCss(hex);
    g.fillRect(0, y, 64, h);
    y += h;
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace; // palette values verbatim, like the toon pipeline
  tex.wrapS = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return tex;
}

/** Continuous block strokes keep START legible without a canvas upload. */
const START_GLYPHS: Record<string, readonly (readonly [number, number, number, number])[]> = {
  S: [[0, .78, 1, .22], [0, .39, 1, .22], [0, 0, 1, .22], [0, .5, .22, .5], [.78, 0, .22, .5]],
  T: [[0, .78, 1, .22], [.39, 0, .22, 1]],
  A: [[0, .39, 1, .22], [0, .78, 1, .22], [0, 0, .22, 1], [.78, 0, .22, 1]],
  R: [[0, .39, 1, .22], [0, .78, 1, .22], [0, 0, .22, 1], [.78, .5, .22, .5], [.55, 0, .22, .55]],
};

function makeStartGantryVisuals(): {
  towerMaterial: THREE.Material;
  bannerFront: THREE.Group;
  bannerBack: THREE.Group;
} {
  const foamMat = createToonMaterial({ color: PALETTE.foam, emissive: PALETTE.foam, emissiveIntensity: 0.12 });
  const inkMat = createToonMaterial({ color: PALETTE.ink });
  const accentMat = createToonMaterial({ color: PALETTE.uiAccent, emissive: PALETTE.uiAccent, emissiveIntensity: 0.28 });
  const bannerFront = new THREE.Group();
  const bannerBack = new THREE.Group();
  const panelGeo = new THREE.BoxGeometry(17, 2.6, 0.16);
  const panel = new THREE.Mesh(panelGeo, foamMat);
  panel.userData.noOutline = true;
  bannerFront.add(panel);
  const backPanel = new THREE.Mesh(panelGeo, foamMat);
  backPanel.userData.noOutline = true;
  bannerBack.add(backPanel);
  const edgeParts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 2; i++) {
    const edge = new THREE.BoxGeometry(0.3, 2.05, 0.18);
    edge.translate(i === 0 ? -8.32 : 8.32, 0, 0.15);
    edgeParts.push(edge);
  }
  const edgeGeo = mergeGeometries(edgeParts, false);
  edgeParts.forEach((part) => part.dispose());
  if (!edgeGeo) throw new Error('Unable to merge START banner edges');
  const edges = new THREE.Mesh(edgeGeo, accentMat);
  edges.name = 'start-banner-edges';
  edges.userData.noOutline = true;
  bannerFront.add(edges);
  const backEdges = edges.clone();
  backEdges.name = 'start-banner-edges-back';
  bannerBack.add(backEdges);

  // Restore the race-checker identity without restoring the CanvasTexture
  // upload that could turn the entire landmark black on a cold mobile load.
  // The approach face keeps one checker row above and below START; the exit
  // face is the original full 16 x 4 finish checker.
  const cellWidth = 17 / 16;
  const cellHeight = 2.6 / 4;
  const checkerParts = (fullFace: boolean): THREE.BufferGeometry[] => {
    const parts: THREE.BufferGeometry[] = [];
    for (let row = 0; row < 4; row++) {
      if (!fullFace && row !== 0 && row !== 3) continue;
      for (let col = 0; col < 16; col++) {
        if ((row + col) % 2 !== 0) continue;
        const part = new THREE.BoxGeometry(cellWidth, cellHeight, 0.12);
        part.translate(
          -8.5 + (col + 0.5) * cellWidth,
          -1.3 + (row + 0.5) * cellHeight,
          0.18,
        );
        parts.push(part);
      }
    }
    return parts;
  };
  const addChecker = (target: THREE.Group, fullFace: boolean, name: string): void => {
    const parts = checkerParts(fullFace);
    const geometry = mergeGeometries(parts, false);
    parts.forEach((part) => part.dispose());
    if (!geometry) throw new Error(`Unable to merge ${name}`);
    const checker = new THREE.Mesh(geometry, inkMat);
    checker.name = name;
    checker.userData.noOutline = true;
    checker.userData.startCheckerInstances = fullFace ? 32 : 16;
    target.add(checker);
  };
  addChecker(bannerFront, false, 'start-checker-front');
  addChecker(bannerBack, true, 'start-checker-back');

  const text = 'START';
  const letterWidth = 2.05;
  const startX = -(text.length - 1) * letterWidth * 0.5;
  const segmentCount = [...text].reduce((sum, glyph) => sum + START_GLYPHS[glyph].length, 0);
  const letterParts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < text.length; i++) {
    for (const [x, y, width, height] of START_GLYPHS[text[i]]) {
      const part = new THREE.BoxGeometry(width * 1.65, height * 1.45, 0.12);
      part.translate(
        startX + i * letterWidth + (x + width * 0.5 - 0.5) * 1.65,
        (y + height * 0.5 - 0.5) * 1.45,
        0.18,
      );
      letterParts.push(part);
    }
  }
  const letterGeo = mergeGeometries(letterParts, false);
  letterParts.forEach((part) => part.dispose());
  if (!letterGeo) throw new Error('Unable to merge START glyphs');
  const letters = new THREE.Mesh(letterGeo, inkMat);
  letters.name = 'start-glyphs';
  letters.userData.noOutline = true;
  letters.userData.startGlyphInstances = segmentCount;
  bannerFront.add(letters);
  bannerFront.name = 'start-banner-front';
  bannerBack.name = 'start-banner-back';
  return { towerMaterial: foamMat, bannerFront, bannerBack };
}

/** Pink low-altitude lock: the open cyan aperture only exists above this field. */
function makeFlightLockTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, c.width, c.height);
  g.strokeStyle = hexCss(PALETTE.uiWarn);
  g.lineWidth = 15;
  g.beginPath();
  g.moveTo(8, 10);
  g.lineTo(248, 118);
  g.moveTo(248, 10);
  g.lineTo(8, 118);
  g.stroke();
  g.fillStyle = hexCss(PALETTE.foam);
  g.font = '900 27px Arial Black, system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('AIR ONLY', 128, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return tex;
}

const STRIPE_SUN = new THREE.Vector3(PALETTE.sunDir[0], PALETTE.sunDir[1], PALETTE.sunDir[2]).normalize();
/** Fog target for striped surfaces: foam pulled toward the horizon color —
 *  far buoys/banner read as pale graphic poles, never black clusters. */
const STRIPE_FOG = new THREE.Color().setHex(PALETTE.foam, THREE.NoColorSpace)
  .lerp(new THREE.Color().setHex(PALETTE.skyHorizon, THREE.NoColorSpace), 0.35);

/**
 * Minimal banded-toon material with a map (createToonMaterial takes no map):
 * 3 hard lighting bands over the texture, palette sun direction. The shadow
 * floor stays high enough that the shadow band still reads as a COLOR
 * (never the dead-black void the old ink towers fell into). `shadowFloor`
 * 0.8 for the banner: a graphic panel that must read bright from BOTH sides.
 * Distance is tinted in two hard bands toward STRIPE_FOG (same banded-fog
 * language as the ocean/toon fog), so distant stripes melt pale instead of
 * aliasing into ink lumps.
 */
function makeStripeToon(map: THREE.Texture, shadowFloor = 0.52): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'StripeToon',
    uniforms: {
      uMap: { value: map },
      uSunDir: { value: STRIPE_SUN },
      uFloor: { value: shadowFloor },
      uFog: { value: STRIPE_FOG },
    },
    vertexShader: /* glsl */ `
      varying vec3 vN;
      varying vec2 vUv;
      varying float vDist;
      void main() {
        vN = normalize(mat3(modelMatrix) * normal);
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform vec3 uSunDir;
      uniform float uFloor;
      uniform vec3 uFog;
      varying vec3 vN;
      varying vec2 vUv;
      varying float vDist;
      void main() {
        vec3 base = texture2D(uMap, vUv).rgb;
        float ndl = dot(normalize(vN), uSunDir) * 0.5 + 0.5;
        float band = step(0.35, ndl) * 0.48 + step(0.72, ndl) * 0.52;
        vec3 col = base * (uFloor + (1.0 - uFloor) * band);
        // two hard distance bands toward the pale stripe-fog color
        float fog = step(240.0, vDist) * 0.35 + step(700.0, vDist) * 0.45;
        col = mix(col, uFog, min(fog, 1.0));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    side: THREE.FrontSide,
  });
}

// ---------------------------------------------------------------- ribbon ----

const RIBBON_SEGS = 1400;
// Eight-meter soft navigation field. The shader keeps the authored 3.4m
// directional spine bright; the outer width is translucent context, never a
// collision lane or a change to route validation.
const RIBBON_HALF_W = 4;

/**
 * Painted racing line: normal-blended (NOT additive — the old additive core
 * washed out to pale mint over crests and its dim rails/fade steps read as
 * wide dark "asphalt" bands over deep water). Hard-stepped zones across the
 * width: bright dash core flowing along the lap, always-on slim green rails
 * for wayfinding between dashes, thin ink under-stroke edging so the line
 * keeps contrast on pale-cyan crests. The outer glow is a SMOOTH radial
 * falloff to zero at the ribbon edge — the old hard-stepped translucent
 * flank read as a ghost polygon paralleling the line.
 */
function buildRibbonMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'RacingLine',
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color().setHex(PALETTE.racingLine, THREE.NoColorSpace) },
      uInk: { value: new THREE.Color().setHex(PALETTE.ink, THREE.NoColorSpace) },
      uPlayerS: { value: 0 },
      uLapLength: { value: LAP_LENGTH },
      uMaskStart: { value: 0 },
      uMaskEnd: { value: 0 },
      uGuideActive: { value: 0 },
      uFinalApproach: { value: 0 },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      varying float vS;
      varying float vSide;
      varying float vDist;
      ${WAVES_GLSL}
      void main() {
        vec3 p = position;
        // ride the swell instead of clipping through it. Lift compromise:
        // 0.22 read as an elevated rail bridging troughs; 0.1 clips under
        // far wave slopes (broken line). 0.17 survives both at chase angles.
        p.y = waveHeight(p.xz, uTime) + 0.17;
        vS = uv.x;
        vSide = uv.y;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uColor;
      uniform vec3 uInk;
      uniform float uPlayerS;
      uniform float uLapLength;
      uniform float uMaskStart;
      uniform float uMaskEnd;
      uniform float uGuideActive;
      uniform float uFinalApproach;
      varying float vS;
      varying float vSide;
      varying float vDist;
      void main() {
        float ahead = mod(vS - uPlayerS + uLapLength, uLapLength);
        float behind = mod(uPlayerS - vS + uLapLength, uLapLength);
        if (ahead > 170.0 && behind > 12.0) discard;
        if (uGuideActive > 0.5 && vS >= uMaskStart && vS <= uMaskEnd) discard;
        // hard dash band flowing along the 3.4m directional spine (~14m period)
        float dash = step(fract(vS * 0.07 - uTime * 0.6), 0.62);
        float a = abs(vSide);
        // The inner 42% is the original 3.4m line. Outside it, a faint field
        // makes distant bends legible without pretending to be a hard road.
        float core = 1.0 - step(0.42, a);
        float rail = step(0.42, a) * (1.0 - step(0.5, a));
        float edge = step(0.5, a) * (1.0 - step(0.59, a));
        float halo = step(0.59, a) * (1.0 - smoothstep(0.59, 1.0, a));
        // Preserve a stable locator spine through the full 170m navigation
        // horizon instead of fading the exact turn-away point to nothing.
        float localFade = 1.0 - smoothstep(125.0, 170.0, ahead) * 0.28;
        float fade = (vDist < 220.0 ? 1.0 : 0.62) * max(localFade, step(0.001, behind) * step(behind, 12.0));
        vec3 col = uColor * (core * (0.68 + 0.72 * dash) + rail * 0.9 + halo * 0.42)
                 + uInk * edge;
        float alpha = (core * (0.34 + dash * 0.66) + rail * 0.9 + edge * 0.92 + halo * 0.12) * fade;
        alpha *= mix(1.0, 0.18, uFinalApproach);
        gl_FragColor = vec4(col, alpha);
      }
    `,
    transparent: true,
    blending: THREE.NormalBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

// ---------------------------------------------------------------- gates ----

interface Floater {
  obj: THREE.Object3D;
  x: number;
  z: number;
  yawQ: THREE.Quaternion;
  routeU?: number;
}

interface FlightGate {
  u: number;
  center: THREE.Vector3;
  normal: THREE.Vector3;
  right: THREE.Vector3;
  halfWidth: number;
  halfHeight: number;
  targetY: number;
  deploy: number;
  group: THREE.Group;
  pulse: number;
  anchor: THREE.Mesh;
  cleared: boolean;
}

interface FlightRouteVisual {
  runtime: FlightRouteRuntime;
  group: THREE.Group;
  ribbonMesh: THREE.Mesh;
  ribbon: THREE.ShaderMaterial;
  rail: THREE.MeshBasicMaterial;
  ring: THREE.MeshBasicMaterial;
  recoveryArrows: THREE.InstancedMesh;
  recoveryArrowMaterial: THREE.MeshBasicMaterial;
  recoveryArrowFractions: number[];
  recoveryArrowMatrices: THREE.Matrix4[];
  turnChevronGroup: THREE.Group | null;
  turnChevronFill: THREE.MeshBasicMaterial | null;
  turnChevronCount: number;
  gates: FlightGate[];
  deployActive: boolean;
  deployTime: number;
  recoveryFade: number;
  recoveryProgress: number;
}

interface SurfaceActionVisual {
  group: THREE.Group;
  bankGroup: THREE.Group;
  launchGroup: THREE.Group;
}

function makeOpenChevronGeometry(depth = 0): THREE.BufferGeometry {
  const points = [
    -1.12, depth, 0.82, -0.86, depth, 1.08, 0.34, depth, 0.13,
    -1.12, depth, 0.82, 0.34, depth, 0.13, 0.06, depth, -0.1,
    -1.12, depth, -0.82, 0.06, depth, 0.1, 0.34, depth, -0.13,
    -1.12, depth, -0.82, 0.34, depth, -0.13, -0.86, depth, -1.08,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function makeVerticalChevronGeometry(depth = 0): THREE.BufferGeometry {
  const points = [
    -1.12, 0.82, depth, -0.86, 1.08, depth, 0.34, 0.13, depth,
    -1.12, 0.82, depth, 0.34, 0.13, depth, 0.06, -0.1, depth,
    -1.12, -0.82, depth, 0.06, 0.1, depth, 0.34, -0.13, depth,
    -1.12, -0.82, depth, 0.34, -0.13, depth, -0.86, -1.08, depth,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function makeForwardArrowGeometry(depth = 0): THREE.BufferGeometry {
  const points = [
    -1.3, depth, -0.42, 0.05, depth, -0.42, 0.05, depth, 0.42,
    -1.3, depth, -0.42, 0.05, depth, 0.42, -1.3, depth, 0.42,
    -0.12, depth, -1.08, 1.28, depth, 0, -0.12, depth, 1.08,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Scalloped foam collar for a buoy's waterline: a flat annulus whose outer
 * edge zigzags (hard scallops, geometry not alpha). Sits as a child of the
 * buoy so it bobs and tilts with it. Normals are straight up.
 */
function makeFoamRingGeometry(): THREE.BufferGeometry {
  const SEG = 28; // 14 scallops
  const R_IN = 1.02;
  const R_OUT = 1.52;
  const pos = new Float32Array(SEG * 2 * 3);
  const nrm = new Float32Array(SEG * 2 * 3);
  const idx: number[] = [];
  for (let i = 0; i < SEG; i++) {
    const a = (i / SEG) * Math.PI * 2;
    const ro = i % 2 === 0 ? R_OUT : R_OUT * 0.82; // zigzag => scalloped rim
    pos[i * 6] = Math.cos(a) * R_IN;
    pos[i * 6 + 2] = Math.sin(a) * R_IN;
    pos[i * 6 + 3] = Math.cos(a) * ro;
    pos[i * 6 + 5] = Math.sin(a) * ro;
    nrm[i * 6 + 1] = 1;
    nrm[i * 6 + 4] = 1;
  }
  for (let i = 0; i < SEG; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = ((i + 1) % SEG) * 2;
    const d = c + 1;
    idx.push(a, c, b, b, c, d); // +Y winding
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setIndex(idx);
  return geo;
}

export interface WindChimeNode {
  group: THREE.Group;
  catcher: THREE.Object3D;
  phase: number;
  freq: number;
  swayX: number;
  swayZ: number;
}

const PRAYER_FLAG_COLORS: readonly number[] = [
  PALETTE.skyZenith,    // Blue
  PALETTE.gliderCanvas, // White
  PALETTE.uiWarn,       // Red / Coral
  PALETTE.vineGreen,    // Green
  PALETTE.sunFlare,     // Gold / Yellow
];

function makePrayerFlagMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'PrayerFlagsToon',
    uniforms: {
      uTime: { value: 0 },
      uSunDir: { value: STRIPE_SUN },
      uSkyColor: { value: new THREE.Color(PALETTE.skyMid) },
      uInkColor: { value: new THREE.Color(PALETTE.ink) },
    },
    vertexShader: /* glsl */ `
      attribute vec3 color;
      varying vec3 vColor;
      varying vec3 vNormal;
      varying float vDist;
      varying vec2 vUv;
      uniform float uTime;

      void main() {
        vColor = color;
        vUv = uv;
        
        // uv.y: 0.0 at top suspension cable (pinned), 1.0 at free fluttering bottom tip
        float hang = clamp(uv.y, 0.0, 1.0);
        float hang2 = hang * hang;

        // Multi-frequency wind fluttering waves
        float w1 = sin(uTime * 8.5 + position.x * 2.8 + position.y * 1.6) * 0.15;
        float w2 = cos(uTime * 14.2 + position.x * 4.6 - position.y * 2.4) * 0.08;
        float w3 = sin(uTime * 3.1 + position.x * 0.9) * 0.10;
        
        vec3 displaced = position;
        // Flutter along local Z (wind blow direction) and slight lateral X sway
        displaced.z += (w1 + w2 + w3 + 0.16) * hang;
        displaced.x += sin(uTime * 4.8 + position.y * 3.2) * 0.05 * hang2;
        displaced.y += -abs(w1 + w2) * 0.03 * hang2;

        // Approximate displaced normal
        vec3 displacedNormal = normal;
        displacedNormal.z += (cos(uTime * 8.5 + position.x * 2.8) * 0.45) * hang;
        displacedNormal.x += (sin(uTime * 4.8 + position.y * 3.2) * 0.28) * hang;
        vNormal = normalize(mat3(modelMatrix) * displacedNormal);

        vec4 mv = modelViewMatrix * vec4(displaced, 1.0);
        vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir;
      uniform vec3 uSkyColor;
      uniform vec3 uInkColor;
      varying vec3 vColor;
      varying vec3 vNormal;
      varying float vDist;
      varying vec2 vUv;

      void main() {
        vec3 n = normalize(vNormal);
        if (!gl_FrontFacing) n = -n;

        float ndl = dot(n, uSunDir) * 0.5 + 0.5;
        // 3-step watercolor cel band
        float ramp = step(0.36, ndl) * 0.35 + step(0.68, ndl) * 0.45 + 0.20;
        
        // Base watercolor cloth tone with warm sunlight & ambient sky bounce
        vec3 lit = vColor * ramp;
        vec3 ambient = mix(uInkColor, uSkyColor, 0.45) * 0.15 * (1.0 - ramp);
        vec3 col = lit + ambient;

        // Subtle cloth watercolor border wash (pigment rim)
        float border = smoothstep(0.0, 0.08, vUv.x) * smoothstep(1.0, 0.92, vUv.x) * smoothstep(1.0, 0.92, vUv.y);
        col = mix(col * 0.88, col, border);

        // Distance fog softening
        float fog = step(220.0, vDist) * 0.25 + step(650.0, vDist) * 0.35;
        col = mix(col, vec3(0.91, 0.96, 0.98), min(fog, 0.75));

        gl_FragColor = vec4(col, 1.0);
      }
    `,
    side: THREE.DoubleSide,
  });
}

function buildSingleFlagGeometry(
  topCenter: THREE.Vector3,
  width: number,
  height: number,
  tangent: THREE.Vector3,
  normal: THREE.Vector3,
  colorHex: number,
  isSwallowTail = false,
): THREE.BufferGeometry {
  const col = new THREE.Color(colorHex);
  const r = col.r;
  const g = col.g;
  const b = col.b;

  const tX = tangent.x * width * 0.5;
  const tY = tangent.y * width * 0.5;
  const tZ = tangent.z * width * 0.5;

  const nX = normal.x;
  const nY = normal.y;
  const nZ = normal.z;

  const p0L = new THREE.Vector3(topCenter.x - tX, topCenter.y - tY, topCenter.z - tZ);
  const p0R = new THREE.Vector3(topCenter.x + tX, topCenter.y + tY, topCenter.z + tZ);

  const midY = topCenter.y - height * 0.48;
  const p1L = new THREE.Vector3(topCenter.x - tX * 0.92, midY, topCenter.z - tZ * 0.92);
  const p1R = new THREE.Vector3(topCenter.x + tX * 0.92, midY, topCenter.z + tZ * 0.92);

  const botY = topCenter.y - height;
  const p2L = new THREE.Vector3(topCenter.x - tX * 0.82, botY, topCenter.z - tZ * 0.82);
  const p2R = new THREE.Vector3(topCenter.x + tX * 0.82, botY, topCenter.z + tZ * 0.82);

  if (isSwallowTail) {
    const p2M = new THREE.Vector3(topCenter.x, botY + height * 0.22, topCenter.z);
    const positions = new Float32Array([
      p0L.x, p0L.y, p0L.z,
      p0R.x, p0R.y, p0R.z,
      p1L.x, p1L.y, p1L.z,
      p1R.x, p1R.y, p1R.z,
      p2L.x, p2L.y, p2L.z,
      p2M.x, p2M.y, p2M.z,
      p2R.x, p2R.y, p2R.z,
    ]);
    const uvs = new Float32Array([
      0, 0,
      1, 0,
      0.05, 0.48,
      0.95, 0.48,
      0.1, 1.0,
      0.5, 0.78,
      0.9, 1.0,
    ]);
    const normals = new Float32Array([
      nX, nY, nZ,
      nX, nY, nZ,
      nX, nY, nZ,
      nX, nY, nZ,
      nX, nY, nZ,
      nX, nY, nZ,
      nX, nY, nZ,
    ]);
    const colors = new Float32Array([
      r, g, b,
      r, g, b,
      r, g, b,
      r, g, b,
      r, g, b,
      r, g, b,
      r, g, b,
    ]);
    const indices = [
      0, 2, 1, 1, 2, 3,
      2, 4, 5, 2, 5, 3, 3, 5, 6,
    ];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setIndex(indices);
    return geo;
  } else {
    const positions = new Float32Array([
      p0L.x, p0L.y, p0L.z,
      p0R.x, p0R.y, p0R.z,
      p1L.x, p1L.y, p1L.z,
      p1R.x, p1R.y, p1R.z,
      p2L.x, p2L.y, p2L.z,
      p2R.x, p2R.y, p2R.z,
    ]);
    const uvs = new Float32Array([
      0, 0,
      1, 0,
      0.05, 0.48,
      0.95, 0.48,
      0.1, 1.0,
      0.9, 1.0,
    ]);
    const normals = new Float32Array([
      nX, nY, nZ,
      nX, nY, nZ,
      nX, nY, nZ,
      nX, nY, nZ,
      nX, nY, nZ,
      nX, nY, nZ,
    ]);
    const colors = new Float32Array([
      r, g, b,
      r, g, b,
      r, g, b,
      r, g, b,
      r, g, b,
      r, g, b,
    ]);
    const indices = [
      0, 2, 1, 1, 2, 3,
      2, 4, 3, 3, 4, 5,
    ];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setIndex(indices);
    return geo;
  }
}

function buildVerticalStreamerGeometry(
  topCenter: THREE.Vector3,
  width: number,
  length: number,
  colorHex: number,
): THREE.BufferGeometry {
  const col = new THREE.Color(colorHex);
  const r = col.r;
  const g = col.g;
  const b = col.b;

  const segs = 4;
  const positions: number[] = [];
  const uvs: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  const halfW = width * 0.5;

  for (let s = 0; s <= segs; s++) {
    const f = s / segs;
    const y = topCenter.y - length * f;
    const w = halfW * (1.0 - f * 0.15);

    positions.push(topCenter.x - w, y, topCenter.z);
    positions.push(topCenter.x + w, y, topCenter.z);

    uvs.push(0, f);
    uvs.push(1, f);

    normals.push(0, 0, 1);
    normals.push(0, 0, 1);

    colors.push(r, g, b);
    colors.push(r, g, b);

    if (s < segs) {
      const a = s * 2;
      indices.push(a, a + 1, a + 2);
      indices.push(a + 1, a + 3, a + 2);
    }
  }

  const botMidIdx = (segs + 1) * 2;
  const botY = topCenter.y - length;
  positions.push(topCenter.x, botY + length * 0.15, topCenter.z);
  uvs.push(0.5, 0.85);
  normals.push(0, 0, 1);
  colors.push(r, g, b);

  const lastL = segs * 2;
  const lastR = segs * 2 + 1;
  const prevL = (segs - 1) * 2;
  const prevR = (segs - 1) * 2 + 1;

  indices.splice(indices.length - 6, 6);
  indices.push(prevL, botMidIdx, prevR);
  indices.push(prevL, lastL, botMidIdx);
  indices.push(prevR, botMidIdx, lastR);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
  geo.setIndex(indices);
  return geo;
}

function buildWindChimeAssembly(
  attachX: number,
  attachY: number,
  attachZ: number,
  materials: AncientStoneArchMaterials,
  phase: number,
  freq: number,
  swayX: number,
  swayZ: number,
): { chimeGroup: THREE.Group; node: WindChimeNode } {
  const chimeGroup = new THREE.Group();
  chimeGroup.name = 'ancient-wind-chime';
  chimeGroup.position.set(attachX, attachY, attachZ);

  // 1. Top suspension eyelet & cord
  const topRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.045, 0.012, 6, 12),
    materials.brassMat,
  );
  topRing.position.set(0, 0, 0);
  chimeGroup.add(topRing);

  const topCord = new THREE.Mesh(
    new THREE.CylinderGeometry(0.008, 0.008, 0.32, 6),
    materials.cordMat,
  );
  topCord.position.set(0, -0.16, 0);
  chimeGroup.add(topCord);

  // 2. Ancient Bronze / Brass Temple Bell Body (Wind Cloche / 铜铎)
  const bellDome = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.5),
    materials.brassMat,
  );
  bellDome.position.set(0, -0.32, 0);
  chimeGroup.add(bellDome);

  const bellBody = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12, 0.18, 0.24, 12, 1, true),
    materials.brassMat,
  );
  bellBody.position.set(0, -0.44, 0);
  chimeGroup.add(bellBody);

  const bellRim = new THREE.Mesh(
    new THREE.TorusGeometry(0.185, 0.024, 6, 16),
    materials.brassMat,
  );
  bellRim.rotateX(Math.PI / 2);
  bellRim.position.set(0, -0.56, 0);
  chimeGroup.add(bellRim);

  const bellRib = new THREE.Mesh(
    new THREE.TorusGeometry(0.145, 0.015, 6, 16),
    materials.brassMat,
  );
  bellRib.rotateX(Math.PI / 2);
  bellRib.position.set(0, -0.40, 0);
  chimeGroup.add(bellRib);

  // 3. Clapper striker bead
  const clapper = new THREE.Mesh(
    new THREE.DodecahedronGeometry(0.052, 0),
    materials.woodMat,
  );
  clapper.position.set(0, -0.52, 0);
  chimeGroup.add(clapper);

  // 4. Secondary Wind-Catcher Pivot (Tanzaku / 祈福短册纸板)
  const catcherGroup = new THREE.Group();
  catcherGroup.name = 'chime-wind-catcher';
  catcherGroup.position.set(0, -0.56, 0);

  const dropCord = new THREE.Mesh(
    new THREE.CylinderGeometry(0.006, 0.006, 0.24, 6),
    materials.cordMat,
  );
  dropCord.position.set(0, -0.12, 0);
  catcherGroup.add(dropCord);

  // Tanzaku Paper / Wooden wind sail board
  const tanzaku = new THREE.Mesh(
    new THREE.BoxGeometry(0.14, 0.64, 0.012),
    materials.paperMat,
  );
  tanzaku.position.set(0, -0.54, 0);
  tanzaku.userData.noOutline = true;
  catcherGroup.add(tanzaku);

  // Talisman seal emblem on tanzaku
  const talisman = new THREE.Mesh(
    new THREE.BoxGeometry(0.07, 0.15, 0.016),
    materials.vineMat,
  );
  talisman.position.set(0, -0.48, 0);
  talisman.userData.noOutline = true;
  catcherGroup.add(talisman);

  // Bottom brass weight coin / bead
  const bottomWeight = new THREE.Mesh(
    new THREE.CylinderGeometry(0.032, 0.032, 0.018, 10),
    materials.brassMat,
  );
  bottomWeight.rotateX(Math.PI / 2);
  bottomWeight.position.set(0, -0.86, 0);
  catcherGroup.add(bottomWeight);

  chimeGroup.add(catcherGroup);

  const node: WindChimeNode = {
    group: chimeGroup,
    catcher: catcherGroup,
    phase,
    freq,
    swayX,
    swayZ,
  };

  return { chimeGroup, node };
}

interface AncientStoneArchMaterials {
  stoneMat: THREE.Material;
  brassMat: THREE.Material;
  vineMat: THREE.Material;
  leafMat: THREE.Material;
  flowerMat: THREE.Material;
  ringMat: THREE.Material;
  flagMat: THREE.ShaderMaterial;
  cordMat: THREE.Material;
  paperMat: THREE.Material;
  woodMat: THREE.Material;
}

/**
 * Procedural architecture for an Ancient White Stone Torii/Arch with climbing green vines,
 * wind-blown prayer flags, and rustic ancient wind chimes.
 * Solarpunk / Ghibli aesthetic: weathered white stone columns, stepped lintel,
 * brass sun medallion, spiraling vine tendrils, fresh green leaf foliage,
 * vibrant fluttering 5-color prayer flags, and swaying bronze temple chimes.
 */
function buildAncientStoneArchVisuals(
  passHalfWidth: number,
  gateHalfWidth: number,
  gateHalfHeight: number,
  materials: AncientStoneArchMaterials,
  gateIndex = 0,
): {
  archGroup: THREE.Group;
  portalRingMesh: THREE.Mesh;
  flagsMesh: THREE.Mesh;
  chimes: WindChimeNode[];
} {
  const stoneParts: THREE.BufferGeometry[] = [];
  const brassParts: THREE.BufferGeometry[] = [];
  const vineParts: THREE.BufferGeometry[] = [];
  const leafParts: THREE.BufferGeometry[] = [];
  const flowerParts: THREE.BufferGeometry[] = [];
  const cordParts: THREE.BufferGeometry[] = [];
  const flagParts: THREE.BufferGeometry[] = [];
  const chimes: WindChimeNode[] = [];

  const span = passHalfWidth;
  const pillarX = span + 0.65;
  const pillarHeight = gateHalfHeight * 2 + 2.2;
  const halfH = pillarHeight * 0.5;

  // 1. Left and Right Ancient Stone Pillars
  for (const side of [-1, 1]) {
    const px = side * pillarX;

    // Stepped plinth foundation
    const baseLow = new THREE.BoxGeometry(1.65, 0.45, 1.65);
    baseLow.translate(px, -halfH + 0.225, 0);
    stoneParts.push(baseLow);

    const baseMid = new THREE.BoxGeometry(1.35, 0.35, 1.35);
    baseMid.translate(px, -halfH + 0.625, 0);
    stoneParts.push(baseMid);

    const baseCollar = new THREE.CylinderGeometry(0.65, 0.76, 0.35, 12);
    baseCollar.translate(px, -halfH + 0.975, 0);
    stoneParts.push(baseCollar);

    // Tapered column shaft
    const shaftH = pillarHeight - 1.8;
    const shaft = new THREE.CylinderGeometry(0.52, 0.62, shaftH, 12);
    shaft.translate(px, -halfH + 1.15 + shaftH * 0.5, 0);
    stoneParts.push(shaft);

    // Carved stone relief rings
    const ring1 = new THREE.TorusGeometry(0.58, 0.07, 8, 16);
    ring1.rotateX(Math.PI / 2);
    ring1.translate(px, -0.8, 0);
    stoneParts.push(ring1);

    const ring2 = new THREE.TorusGeometry(0.54, 0.07, 8, 16);
    ring2.rotateX(Math.PI / 2);
    ring2.translate(px, 1.0, 0);
    stoneParts.push(ring2);

    // Brass inset trim rings
    const brassTrim = new THREE.TorusGeometry(0.57, 0.04, 8, 16);
    brassTrim.rotateX(Math.PI / 2);
    brassTrim.translate(px, gateHalfHeight + 0.22, 0);
    brassParts.push(brassTrim);

    // Flared capital block & abacus
    const capital = new THREE.CylinderGeometry(0.76, 0.52, 0.48, 12);
    capital.translate(px, gateHalfHeight + 0.38, 0);
    stoneParts.push(capital);

    const abacus = new THREE.BoxGeometry(1.4, 0.28, 1.4);
    abacus.translate(px, gateHalfHeight + 0.72, 0);
    stoneParts.push(abacus);

    // Corner arch corbel bracket (diagonal stone brace linking column to beam)
    const bracket = new THREE.BoxGeometry(0.3, 1.25, 0.42);
    bracket.rotateZ(side * -0.62);
    bracket.translate(side * (span - 0.22), gateHalfHeight + 0.15, 0);
    stoneParts.push(bracket);

    // Spiraling climbing vine tendrils
    const vinePoints: THREE.Vector3[] = [];
    const vineTurns = 3.2;
    const vineSteps = 36;
    const startY = -halfH + 0.9;
    const endY = gateHalfHeight + 0.75;
    for (let s = 0; s <= vineSteps; s++) {
      const f = s / vineSteps;
      const vy = startY + (endY - startY) * f;
      const angle = (f * vineTurns * Math.PI * 2 * side) + (side > 0 ? 0.8 : 2.4);
      const r = THREE.MathUtils.lerp(0.66, 0.56, f) + Math.sin(f * 14) * 0.04;
      vinePoints.push(new THREE.Vector3(
        px + Math.cos(angle) * r,
        vy,
        Math.sin(angle) * r,
      ));
    }
    const vineCurve = new THREE.CatmullRomCurve3(vinePoints, false, 'centripetal');
    const vineTube = new THREE.TubeGeometry(vineCurve, 32, 0.052, 6, false);
    vineParts.push(vineTube);

    // Secondary vine branch
    const branchPoints: THREE.Vector3[] = [];
    for (let s = 0; s <= 18; s++) {
      const f = s / 18;
      const vy = startY + (endY - startY) * (0.3 + f * 0.65);
      const angle = (-f * 2.1 * Math.PI * 2 * side) + (side > 0 ? 2.1 : 0.4);
      const r = 0.58 + Math.cos(f * 10) * 0.03;
      branchPoints.push(new THREE.Vector3(
        px + Math.cos(angle) * r,
        vy,
        Math.sin(angle) * r,
      ));
    }
    const branchCurve = new THREE.CatmullRomCurve3(branchPoints, false, 'centripetal');
    const branchTube = new THREE.TubeGeometry(branchCurve, 16, 0.038, 5, false);
    vineParts.push(branchTube);

    // Foliage leaf clusters along pillar
    for (let s = 0; s < 7; s++) {
      const f = (s + 0.5) / 7;
      const vy = startY + (endY - startY) * f;
      const angle = (f * vineTurns * Math.PI * 2 * side) + (side > 0 ? 0.8 : 2.4);
      const r = THREE.MathUtils.lerp(0.68, 0.58, f) + 0.04;
      const lx = px + Math.cos(angle) * r;
      const lz = Math.sin(angle) * r;

      for (let l = 0; l < 3; l++) {
        const leaf = new THREE.ConeGeometry(0.14, 0.28, 4);
        leaf.rotateX(Math.PI * 0.5);
        leaf.rotateZ(angle + (l - 1) * 0.7);
        leaf.translate(
          lx + (l - 1) * 0.06 * Math.sin(angle),
          vy + (l - 1) * 0.05,
          lz + (l - 1) * 0.06 * Math.cos(angle),
        );
        leafParts.push(leaf);
      }

      if (s % 2 === 0) {
        const bud = new THREE.DodecahedronGeometry(0.065, 0);
        bud.translate(lx, vy + 0.08, lz);
        flowerParts.push(bud);
      }
    }
  }

  // 2. Torii / Arch Crossbeams
  const totalSpan = pillarX * 2;

  // Lower tie-beam (Nuki / 穿梁)
  const nukiBeam = new THREE.BoxGeometry(totalSpan + 1.4, 0.44, 0.52);
  nukiBeam.translate(0, gateHalfHeight + 0.38, 0);
  stoneParts.push(nukiBeam);

  // Upper master lintel (Kasagi / 笠木主梁)
  const kasagiBody = new THREE.BoxGeometry(totalSpan + 2.6, 0.58, 0.72);
  kasagiBody.translate(0, gateHalfHeight + 1.05, 0);
  stoneParts.push(kasagiBody);

  // Eaves ridge cap
  const ridgeCap = new THREE.BoxGeometry(totalSpan + 3.0, 0.22, 0.86);
  ridgeCap.translate(0, gateHalfHeight + 1.42, 0);
  stoneParts.push(ridgeCap);

  // Lintel flared wingtips (Kasagi upward tilted ends)
  for (const side of [-1, 1]) {
    const tip = new THREE.BoxGeometry(0.85, 0.38, 0.76);
    tip.rotateZ(side * 0.16);
    tip.translate(side * (pillarX + 1.6), gateHalfHeight + 1.22, 0);
    stoneParts.push(tip);
  }

  // Central keystone strut (Gakuzuka / 额束)
  const keystone = new THREE.BoxGeometry(0.75, 0.48, 0.56);
  keystone.translate(0, gateHalfHeight + 0.72, 0);
  stoneParts.push(keystone);

  // Solar medallions on keystone
  for (const face of [-1, 1]) {
    const solarRing = new THREE.TorusGeometry(0.48, 0.065, 8, 20);
    solarRing.translate(0, gateHalfHeight + 0.72, face * 0.32);
    brassParts.push(solarRing);

    const sunCore = new THREE.OctahedronGeometry(0.24, 0);
    sunCore.scale(1, 1, 0.35);
    sunCore.translate(0, gateHalfHeight + 0.72, face * 0.32);
    brassParts.push(sunCore);

    for (let r = 0; r < 4; r++) {
      const ray = new THREE.BoxGeometry(0.06, 0.75, 0.04);
      ray.rotateZ((r * Math.PI) / 4);
      ray.translate(0, gateHalfHeight + 0.72, face * 0.32);
      brassParts.push(ray);
    }
  }

  // Vines across the crossbeam
  const beamVinePoints: THREE.Vector3[] = [];
  const beamVineSteps = 24;
  for (let s = 0; s <= beamVineSteps; s++) {
    const f = s / beamVineSteps;
    const vx = -pillarX * 1.1 + (pillarX * 2.2) * f;
    const vy = gateHalfHeight + 0.58 + Math.sin(f * 10) * 0.22;
    const vz = 0.32 + Math.cos(f * 8) * 0.08;
    beamVinePoints.push(new THREE.Vector3(vx, vy, vz));
  }
  const beamVineCurve = new THREE.CatmullRomCurve3(beamVinePoints, false, 'centripetal');
  const beamVineTube = new THREE.TubeGeometry(beamVineCurve, 24, 0.045, 5, false);
  vineParts.push(beamVineTube);

  // Leaves on crossbeam
  for (let s = 0; s < 10; s++) {
    const f = (s + 0.5) / 10;
    const lx = -pillarX * 0.95 + (pillarX * 1.9) * f;
    const ly = gateHalfHeight + 0.58 + Math.sin(f * 10) * 0.22;
    const lz = 0.36;

    for (let l = 0; l < 2; l++) {
      const leaf = new THREE.ConeGeometry(0.13, 0.26, 4);
      leaf.rotateX(Math.PI * 0.5);
      leaf.rotateZ(s * 1.1 + l * 1.4);
      leaf.translate(lx + (l - 0.5) * 0.1, ly + (l - 0.5) * 0.08, lz);
      leafParts.push(leaf);
    }

    if (s % 3 === 0) {
      const bud = new THREE.DodecahedronGeometry(0.065, 0);
      bud.translate(lx, ly + 0.08, lz + 0.04);
      flowerParts.push(bud);
    }
  }

  // 3. Prayer Flags Catenary Strings & Fluttering Pennants
  const catenaryCables: { start: THREE.Vector3; end: THREE.Vector3; sag: number; normal: THREE.Vector3 }[] = [
    // Front face
    {
      start: new THREE.Vector3(0, gateHalfHeight + 0.72, 0.32),
      end: new THREE.Vector3(-pillarX - 1.5, gateHalfHeight + 1.22, 0.32),
      sag: 0.28,
      normal: new THREE.Vector3(0, 0, 1),
    },
    {
      start: new THREE.Vector3(0, gateHalfHeight + 0.72, 0.32),
      end: new THREE.Vector3(pillarX + 1.5, gateHalfHeight + 1.22, 0.32),
      sag: 0.28,
      normal: new THREE.Vector3(0, 0, 1),
    },
    // Rear face
    {
      start: new THREE.Vector3(0, gateHalfHeight + 0.72, -0.32),
      end: new THREE.Vector3(-pillarX - 1.5, gateHalfHeight + 1.22, -0.32),
      sag: 0.28,
      normal: new THREE.Vector3(0, 0, -1),
    },
    {
      start: new THREE.Vector3(0, gateHalfHeight + 0.72, -0.32),
      end: new THREE.Vector3(pillarX + 1.5, gateHalfHeight + 1.22, -0.32),
      sag: 0.28,
      normal: new THREE.Vector3(0, 0, -1),
    },
  ];

  let flagColorSeq = 0;
  for (const cable of catenaryCables) {
    const cablePoints: THREE.Vector3[] = [];
    const cableSteps = 16;
    for (let s = 0; s <= cableSteps; s++) {
      const f = s / cableSteps;
      const x = THREE.MathUtils.lerp(cable.start.x, cable.end.x, f);
      const baseY = THREE.MathUtils.lerp(cable.start.y, cable.end.y, f);
      const sagY = Math.sin(f * Math.PI) * cable.sag;
      const y = baseY - sagY;
      const z = cable.start.z;
      cablePoints.push(new THREE.Vector3(x, y, z));
    }
    const cableCurve = new THREE.CatmullRomCurve3(cablePoints, false, 'centripetal');
    const cableTube = new THREE.TubeGeometry(cableCurve, 16, 0.022, 5, false);
    cordParts.push(cableTube);

    // Place 6 flags along cable
    const numFlags = 6;
    for (let i = 0; i < numFlags; i++) {
      const f = (i + 0.5) / numFlags;
      const pt = cableCurve.getPoint(f);
      const tang = cableCurve.getTangent(f).normalize();
      const flagColor = PRAYER_FLAG_COLORS[flagColorSeq % PRAYER_FLAG_COLORS.length];
      flagColorSeq++;

      const isSwallow = i % 2 === 1;
      const flagGeo = buildSingleFlagGeometry(
        pt,
        0.36,
        0.54,
        tang,
        cable.normal,
        flagColor,
        isSwallow,
      );
      flagParts.push(flagGeo);
    }
  }

  // 4. Vertical Pillar Streamers (经幡长幡)
  for (const side of [-1, 1]) {
    const px = side * (pillarX + 0.72);
    const streamerY = gateHalfHeight + 0.45;

    // Top horizontal wooden slat
    const slat = new THREE.BoxGeometry(0.55, 0.04, 0.04);
    slat.translate(px, streamerY + 0.04, 0);
    cordParts.push(slat);

    // 2 Layered streamers per pillar
    for (let l = 0; l < 2; l++) {
      const offZ = l === 0 ? 0.08 : -0.08;
      const streamerColor = PRAYER_FLAG_COLORS[(flagColorSeq + l * 2) % PRAYER_FLAG_COLORS.length];
      const streamerGeo = buildVerticalStreamerGeometry(
        new THREE.Vector3(px + (l - 0.5) * 0.08, streamerY, offZ),
        0.26,
        2.2,
        streamerColor,
      );
      flagParts.push(streamerGeo);
    }
  }

  // 5. Ancient Wind Chimes (古朴风铃)
  const chimeLocs = [
    // Outer eaves tips
    { x: -(pillarX + 1.35), y: gateHalfHeight + 1.05, z: 0 },
    { x: pillarX + 1.35, y: gateHalfHeight + 1.05, z: 0 },
    // Inner corbels
    { x: -(span - 0.35), y: gateHalfHeight - 0.20, z: 0 },
    { x: span - 0.35, y: gateHalfHeight - 0.20, z: 0 },
  ];

  const chimeGroups: THREE.Group[] = [];
  for (let c = 0; c < chimeLocs.length; c++) {
    const loc = chimeLocs[c];
    const phase = (gateIndex * 1.618 + c * 2.399) % (Math.PI * 2);
    const freq = 2.4 + ((gateIndex * 3 + c * 7) % 5) * 0.25;
    const swayX = 0.11 + ((gateIndex + c) % 3) * 0.03;
    const swayZ = 0.07 + ((gateIndex * 2 + c) % 4) * 0.02;

    const { chimeGroup, node } = buildWindChimeAssembly(
      loc.x,
      loc.y,
      loc.z,
      materials,
      phase,
      freq,
      swayX,
      swayZ,
    );
    chimes.push(node);
    chimeGroups.push(chimeGroup);
  }

  const ensureIndexed = (geo: THREE.BufferGeometry): THREE.BufferGeometry => {
    if (!geo.index) {
      const count = geo.attributes.position ? geo.attributes.position.count : 0;
      const indices = count > 65535 ? new Uint32Array(count) : new Uint16Array(count);
      for (let i = 0; i < count; i++) indices[i] = i;
      geo.setIndex(new THREE.BufferAttribute(indices, 1));
    }
    const count = geo.attributes.position ? geo.attributes.position.count : 0;
    if (!geo.attributes.normal && count > 0) geo.computeVertexNormals();
    if (!geo.attributes.uv && count > 0) {
      const uvs = new Float32Array(count * 2);
      geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    }
    for (const key of Object.keys(geo.attributes)) {
      if (key !== 'position' && key !== 'normal' && key !== 'uv') {
        geo.deleteAttribute(key);
      }
    }
    return geo;
  };

  // Merge geometries
  const mergedStone = mergeGeometries(stoneParts.map(ensureIndexed), false);
  stoneParts.forEach((p) => p.dispose());
  if (!mergedStone) throw new Error('Unable to merge ancient stone arch geometries');

  const mergedBrass = mergeGeometries(brassParts.map(ensureIndexed), false);
  brassParts.forEach((p) => p.dispose());
  if (!mergedBrass) throw new Error('Unable to merge ancient brass geometries');

  const mergedVine = mergeGeometries(vineParts.map(ensureIndexed), false);
  vineParts.forEach((p) => p.dispose());
  if (!mergedVine) throw new Error('Unable to merge vine geometries');

  const mergedLeaf = mergeGeometries(leafParts.map(ensureIndexed), false);
  leafParts.forEach((p) => p.dispose());
  if (!mergedLeaf) throw new Error('Unable to merge leaf geometries');

  const mergedFlower = mergeGeometries(flowerParts.map(ensureIndexed), false);
  flowerParts.forEach((p) => p.dispose());
  if (!mergedFlower) throw new Error('Unable to merge flower geometries');

  const mergedCords = mergeGeometries(cordParts.map(ensureIndexed), false);
  cordParts.forEach((p) => p.dispose());
  if (!mergedCords) throw new Error('Unable to merge cord geometries');

  const mergedFlags = mergeGeometries(flagParts.map(ensureIndexed), false);
  flagParts.forEach((p) => p.dispose());
  if (!mergedFlags) throw new Error('Unable to merge flag geometries');

  const stoneMesh = new THREE.Mesh(mergedStone, materials.stoneMat);
  stoneMesh.name = 'arch-stone-body';

  const brassMesh = new THREE.Mesh(mergedBrass, materials.brassMat);
  brassMesh.name = 'arch-brass-crest';

  const vineMesh = new THREE.Mesh(mergedVine, materials.vineMat);
  vineMesh.name = 'arch-vines';

  const leafMesh = new THREE.Mesh(mergedLeaf, materials.leafMat);
  leafMesh.name = 'arch-leaves';

  const flowerMesh = new THREE.Mesh(mergedFlower, materials.flowerMat);
  flowerMesh.name = 'arch-flowers';

  const cordMesh = new THREE.Mesh(mergedCords, materials.cordMat);
  cordMesh.name = 'arch-prayer-cords';

  const flagsMesh = new THREE.Mesh(mergedFlags, materials.flagMat);
  flagsMesh.name = 'arch-prayer-flags';
  flagsMesh.userData.noOutline = true;

  // Inner portal energy aperture contour
  const portalRingGeo = new THREE.TorusGeometry(gateHalfWidth * 0.98, 0.075, 8, 36);
  const portalRingMesh = new THREE.Mesh(portalRingGeo, materials.ringMat);
  portalRingMesh.name = 'arch-portal-ring';
  portalRingMesh.position.set(0, 0, 0.05);

  const archGroup = new THREE.Group();
  archGroup.name = 'ancient-stone-arch';
  archGroup.add(
    stoneMesh,
    brassMesh,
    vineMesh,
    leafMesh,
    flowerMesh,
    cordMesh,
    flagsMesh,
    portalRingMesh,
    ...chimeGroups,
  );

  return { archGroup, portalRingMesh, flagsMesh, chimes };
}

// ================================================================ Course ====

export class Course implements ICourse {
  readonly object: THREE.Object3D;
  readonly length = LAP_LENGTH;
  readonly checkpoints = CHECKPOINT_US.length;
  readonly flightRoutes = FLIGHT_ROUTES;
  readonly flightEntryU = FLIGHT_ENTRY_U;
  readonly flightExitU = FLIGHT_EXIT_U;
  readonly flightGateUs = FLIGHT_GATE_US;

  private readonly ribbonMat: THREE.ShaderMaterial;
  private readonly stripMat: THREE.ShaderMaterial;
  private readonly prayerFlagMat: THREE.ShaderMaterial;
  private readonly flightVisuals: FlightRouteVisual[];
  private readonly surfaceActionVisual: SurfaceActionVisual;
  private readonly floaters: Floater[] = [];
  private readonly windChimes: WindChimeNode[] = [];
  private readonly flightPrev: THREE.Vector3[] = [];
  private readonly flightPrevClearance: number[] = [];
  private readonly flightLatched: number[] = [];
  private readonly flightOffCorridorT: number[] = [];
  private readonly flightOffCorridorD: number[] = [];
  private readonly flightRecoveryT: number[] = [];
  private readonly flightRecoveryLimit: number[] = [];
  private readonly flightDebug: string[] = [];
  private readonly flightTurnWarn: boolean[] = [];
  private flightWarn = 0;
  private flightWarnRoute = -1;
  private playerFlightReady = false;
  private playerFlightIndex = 0;
  private playerFlightPressure = 0;
  private flightFlowTime = 0;
  private playerSurfaceU = 0;
  private readonly playerPosition = new THREE.Vector3();
  private playerTargetGateDistance = -1;
  private playerTargetAnchorScale = 1;
  private playerActionCue: CourseGuidanceStatus['actionCue'] = 'none';
  private playerActionRouteIndex = -1;
  private playerActionDirection: CourseGuidanceStatus['actionDirection'] = 'none';
  private playerActionTargetU = -1;
  private playerActionMarkerCount = 0;
  private activeGuideRoute = -1;
  private playerRecoveryRoute = -1;
  private playerPreviewRoute = -1;
  private playerPreviewFinal = false;
  private playerRecoveryElapsed = 0;
  private playerRecoveryLimit = 0;
  private startGantry: THREE.Group | null = null;
  private finalStation: THREE.Group | null = null;
  private finalStationBlend = 0;
  private finalArmed = false;
  private finalCelebrating = false;
  private finalCelebrationTime = 0;
  private readonly finalPortalCenter = new THREE.Vector3();
  private readonly finalPortalForward = new THREE.Vector3();
  private readonly finalPortalRight = new THREE.Vector3();

  constructor() {
    this.object = new THREE.Group();
    this.object.name = 'course';
    this.prayerFlagMat = makePrayerFlagMaterial();
    this.ribbonMat = this.buildRibbon();
    this.stripMat = this.buildStartStrip();
    this.flightVisuals = FLIGHT_RUNTIME.map((runtime) => this.buildFlightRoute(runtime));
    this.buildGates();
    this.surfaceActionVisual = this.buildSurfaceActionVisual();
    this.pointAt(0, this.finalPortalCenter);
    this.tangentAt(0, this.finalPortalForward);
    this.finalPortalRight.set(this.finalPortalForward.z, 0, -this.finalPortalForward.x).normalize();
  }

  /** Cold-load contract for the START landmark. No browser canvas upload is allowed. */
  startGantryStatus(): Record<string, number> {
    let canvasTextures = 0;
    let meshes = 0;
    let glyphInstances = 0;
    let checkerInstances = 0;
    this.startGantry?.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      meshes++;
      glyphInstances += Number(object.userData.startGlyphInstances ?? 0);
      checkerInstances += Number(object.userData.startCheckerInstances ?? 0);
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        for (const value of Object.values(material)) {
          if (value instanceof THREE.CanvasTexture) canvasTextures++;
        }
        if (material instanceof THREE.ShaderMaterial) {
          for (const uniform of Object.values(material.uniforms)) {
            if (uniform?.value instanceof THREE.CanvasTexture) canvasTextures++;
          }
        }
      }
    });
    return { canvasTextures, meshes, glyphInstances, checkerInstances };
  }

  /** Closed loop; u wraps. Arc-length normalized. */
  pointAt(u: number, out: THREE.Vector3): THREE.Vector3 {
    return CURVE.getPointAt(wrapU(u), out);
  }

  /**
   * Unit XZ tangent at arc-length u. Central difference on getPointAt —
   * Curve.getTangent would allocate two Vector3 per call.
   */
  tangentAt(u: number, out: THREE.Vector3): THREE.Vector3 {
    const w = wrapU(u);
    CURVE.getPointAt(wrapU(w + TAN_DU), out);
    CURVE.getPointAt(wrapU(w - TAN_DU), _ta);
    out.sub(_ta);
    out.y = 0;
    const l = Math.hypot(out.x, out.z) || 1;
    out.x /= l;
    out.z /= l;
    return out;
  }

  routePointAt(routeId: CourseRouteId, u: number, out: THREE.Vector3): THREE.Vector3 {
    // Lookahead is allowed to run through both joins. Returning to the surface
    // curve outside the authored span keeps AI from targeting a clamped end
    // point and spinning at the merge.
    if (routeId === 'surface') return this.pointAt(u, out);
    const runtime = flightRuntime(routeId);
    if (u < runtime.def.entryU || u > runtime.def.exitU) return this.pointAt(u, out);
    return runtimePointAt(runtime, u, out);
  }

  routeTangentAt(routeId: CourseRouteId, u: number, out: THREE.Vector3): THREE.Vector3 {
    if (routeId === 'surface') return this.tangentAt(u, out);
    const runtime = flightRuntime(routeId);
    if (u < runtime.def.entryU || u > runtime.def.exitU) return this.tangentAt(u, out);
    runtimeTangentAt(runtime, u, out);
    out.y = 0;
    const l = Math.hypot(out.x, out.z) || 1;
    out.x /= l;
    out.z /= l;
    return out;
  }

  /**
   * Nearest-spline lookup: table coarse scan + parabolic refine, then one
   * projection step against the TRUE curve (the table's linear interpolation
   * cuts tight corners by up to ~1.4m). Zero allocation.
   */
  sample(pos: THREE.Vector3, out: CourseSample, routeHint: CourseRouteId = 'surface'): CourseSample {
    nearestOnSpline(pos.x, pos.z);
    let u = _near.u;
    CURVE.getPointAt(u, _sp);
    this.tangentAt(u, out.tangent);
    const du = ((pos.x - _sp.x) * out.tangent.x + (pos.z - _sp.z) * out.tangent.z) / LAP_LENGTH;
    u = wrapU(u + du);
    CURVE.getPointAt(u, _sp);
    this.tangentAt(u, out.tangent);
    out.u = u;
    out.point.set(_sp.x, 0, _sp.z);
    out.distance = Math.hypot(pos.x - _sp.x, pos.z - _sp.z);
    out.routeId = 'surface';

    if (routeHint !== 'surface') {
      const runtime = flightRuntime(routeHint);
      nearestOnFlight(runtime, pos.x, pos.z);
      const near = runtime.near;
      // An explicit route hint is ownership, not a suggestion. Falling back
      // to the globally nearest surface segment during a fast merge can jump
      // progress to an unrelated bend and manufacture a wrong-way warning.
      out.u = near.u;
      out.point.set(near.x, near.y, near.z);
      const il = 1 / (Math.hypot(near.tx, near.tz) || 1);
      out.tangent.set(near.tx * il, 0, near.tz * il);
      out.distance = near.distance;
      out.routeId = routeHint;
    }
    return out;
  }

  routeForBoat(id: number): CourseRouteId {
    const index = this.flightLatched[id] ?? -1;
    return index >= 0 ? FLIGHT_ROUTES[index].id : 'surface';
  }

  flightTurnWarning(id: number): boolean {
    return this.flightTurnWarn[id] ?? false;
  }

  resetFlightChallenge(): void {
    this.flightPrev.length = 0;
    this.flightPrevClearance.length = 0;
    this.flightLatched.length = 0;
    this.flightOffCorridorT.length = 0;
    this.flightOffCorridorD.length = 0;
    this.flightRecoveryT.length = 0;
    this.flightRecoveryLimit.length = 0;
    this.flightDebug.length = 0;
    this.flightTurnWarn.length = 0;
    this.flightWarn = 0;
    this.flightWarnRoute = -1;
    this.playerFlightReady = false;
    this.playerFlightIndex = 0;
    this.playerFlightPressure = 0;
    this.flightFlowTime = 0;
    this.playerSurfaceU = 0;
    this.playerTargetGateDistance = -1;
    this.playerTargetAnchorScale = 1;
    this.playerActionCue = 'none';
    this.playerActionRouteIndex = -1;
    this.playerActionDirection = 'none';
    this.playerActionTargetU = -1;
    this.playerActionMarkerCount = 0;
    this.activeGuideRoute = -1;
    this.playerRecoveryRoute = -1;
    this.playerPreviewRoute = -1;
    this.playerPreviewFinal = false;
    this.playerRecoveryElapsed = 0;
    this.playerRecoveryLimit = 0;
    this.finalArmed = false;
    this.finalCelebrating = false;
    this.finalCelebrationTime = 0;
    this.finalStationBlend = 0;
    if (this.finalStation) this.finalStation.visible = false;
    this.ribbonMat.uniforms.uGuideActive.value = 0;
    this.ribbonMat.uniforms.uFinalApproach.value = 0;
    this.surfaceActionVisual.group.visible = false;
    for (const visual of this.flightVisuals) {
      visual.group.visible = false;
      visual.deployActive = false;
      visual.deployTime = 0;
      visual.recoveryFade = 0;
      visual.recoveryProgress = visual.runtime.gateFraction;
      for (const gate of visual.gates) {
        gate.deploy = 0;
        gate.pulse = 0;
        gate.cleared = false;
        gate.group.visible = true;
        gate.anchor.visible = true;
      }
    }
    for (const floater of this.floaters) floater.obj.visible = true;
  }

  armFinalStation(): void {
    this.finalArmed = true;
    this.ribbonMat.uniforms.uFinalApproach.value = 1;
    if (this.finalStation) this.finalStation.visible = true;
  }

  finalStationArmed(): boolean {
    return this.finalArmed;
  }

  crossFinalStation(previous: THREE.Vector3, current: THREE.Vector3): boolean {
    const dx = current.x - previous.x;
    const dz = current.z - previous.z;
    const stepSq = dx * dx + dz * dz;
    if (stepSq <= 1e-8 || stepSq > FINAL_PORTAL_MAX_STEP_M * FINAL_PORTAL_MAX_STEP_M) return false;
    const px = previous.x - this.finalPortalCenter.x;
    const pz = previous.z - this.finalPortalCenter.z;
    const cx = current.x - this.finalPortalCenter.x;
    const cz = current.z - this.finalPortalCenter.z;
    const fromPlane = px * this.finalPortalForward.x + pz * this.finalPortalForward.z;
    const toPlane = cx * this.finalPortalForward.x + cz * this.finalPortalForward.z;
    if ((fromPlane < 0 && toPlane < 0) || (fromPlane > 0 && toPlane > 0)) return false;
    const denominator = fromPlane - toPlane;
    if (Math.abs(denominator) < 1e-6) return false;
    const crossingT = fromPlane / denominator;
    if (crossingT < 0 || crossingT > 1) return false;
    const crossX = previous.x + dx * crossingT - this.finalPortalCenter.x;
    const crossZ = previous.z + dz * crossingT - this.finalPortalCenter.z;
    const lateral = crossX * this.finalPortalRight.x + crossZ * this.finalPortalRight.z;
    return Math.abs(lateral) <= FINAL_PORTAL_HALF_WIDTH_M;
  }

  triggerFinaleCelebration(): void {
    this.finalCelebrating = true;
    this.finalCelebrationTime = 0;
    if (this.finalStation) this.finalStation.visible = true;
  }

  finaleCelebrating(): boolean {
    return this.finalCelebrating;
  }

  resetFinalStation(): void {
    this.finalArmed = false;
    this.finalCelebrating = false;
    this.playerPreviewFinal = false;
    this.playerPreviewRoute = -1;
    this.finalCelebrationTime = 0;
    this.finalStationBlend = 0;
    this.ribbonMat.uniforms.uFinalApproach.value = 0;
    if (this.finalStation) this.finalStation.visible = false;
  }

  /** Deterministic harness diagnostic for the single-guide contract. */
  guidanceStatus(): CourseGuidanceStatus {
    const recoveryVisual = this.playerRecoveryRoute >= 0 ? this.flightVisuals[this.playerRecoveryRoute] : undefined;
    return {
      activeRouteIndex: this.activeGuideRoute,
      visibleRouteCount: this.flightVisuals.reduce((sum, visual) => sum + (visual.group.visible ? 1 : 0), 0),
      surfaceMaskRouteIndex: this.activeGuideRoute,
      recoveryRouteIndex: this.playerRecoveryRoute,
      recoveryActive: this.playerRecoveryRoute >= 0 ? 1 : 0,
      recoveryElapsed: this.playerRecoveryElapsed,
      recoveryLimit: this.playerRecoveryLimit,
      recoveryArrowCount: recoveryVisual
        ? recoveryVisual.recoveryArrowFractions.filter((f) => f >= recoveryVisual.recoveryProgress - 0.018).length
        : 0,
      recoveryGuideOpacity: recoveryVisual ? 1 : 0,
      handoffOverlapMeters: 16,
      playerSurfaceU: this.playerSurfaceU,
      targetGateDistance: this.playerTargetGateDistance,
      targetAnchorScale: this.playerTargetAnchorScale,
      finalActive: this.finalArmed,
      finalDistance: Math.hypot(
        this.playerPosition.x - this.finalPortalCenter.x,
        this.playerPosition.z - this.finalPortalCenter.z,
      ),
      finalGuideCount: this.finalArmed ? 1 : 0,
      actionCue: this.playerActionCue,
      actionRouteIndex: this.playerActionRouteIndex,
      actionDirection: this.playerActionDirection,
      actionTargetU: this.playerActionTargetU,
      actionMarkerCount: this.playerActionMarkerCount,
    };
  }

  /** Deterministic harness diagnostic; updated only on route state edges. */
  flightDebugStatus(id: number): string {
    return this.flightDebug[id] ?? 'idle';
  }

  private failFlight(
    boat: IBoat,
    visual: FlightRouteVisual,
    reason: FlightRouteFailReason,
    routeU: number,
    targetGate: number | null,
    lateralOffsetM: number | null = null,
    lateralLimitM: number | null = null,
    corridorDistanceM: number | null = null,
  ): void {
    const gatesPassed = boat.state.flightGateProgress;
    const routeLevelFailure = reason === 'no_launch' || reason === 'corridor' ||
      reason === 'landing' || reason === 'exit' || reason === 'teleport';
    boat.applyFlightRouteMiss({
      reason,
      flightNumber: boat.state.flightRouteCursor + 1,
      routeSlot: visual.runtime.def.index,
      flightsCleared: boat.state.flightsCleared,
      gatesPassed,
      gateCount: visual.gates.length,
      // A route-level miss is not evidence of a specific portal. The HUD may
      // derive the next suggested gate from gatesPassed, but the snapshot must
      // keep the distinction between "missed the corridor" and "missed gate".
      targetGate: routeLevelFailure ? null : targetGate,
      routeU,
      lateralOffsetM,
      lateralLimitM,
      corridorDistanceM,
      clearanceM: boat.state.flightClearance,
    });
  }

  updateFlightRoute(dt: number, boats: readonly IBoat[]): void {
    this.playerActionCue = 'none';
    this.playerActionRouteIndex = -1;
    this.playerActionDirection = 'none';
    this.playerActionTargetU = -1;
    this.playerActionMarkerCount = 0;
    for (const boat of boats) {
      const id = boat.id;
      const pos = boat.state.position;
      const st = boat.state;
      if (st.flightRouteState === 'idle') this.flightDebug[id] = 'idle';
      if (id === 0) {
        this.playerPosition.copy(pos);
        this.playerFlightReady = st.flightCharges > 0;
        const finalApproach = this.finalArmed && st.flightsCleared >= FLIGHT_ROUTES.length;
        this.playerFlightIndex = finalApproach ? -1 : st.flightRouteIndex >= 0
          ? st.flightRouteIndex
          : st.flightRouteCursor % FLIGHT_ROUTES.length;
        this.playerFlightPressure = st.flightPressure;
        const targetGate = this.flightVisuals[this.playerFlightIndex]?.gates[st.flightGateProgress];
        this.playerTargetGateDistance = targetGate ? targetGate.center.distanceTo(pos) : -1;
      }
      let prev = this.flightPrev[id];
      if (!prev) {
        prev = new THREE.Vector3().copy(pos);
        this.flightPrev[id] = prev;
        this.flightPrevClearance[id] = st.flightClearance;
        this.flightLatched[id] = -1;
        this.flightOffCorridorT[id] = 0;
        this.flightOffCorridorD[id] = 0;
        this.flightRecoveryT[id] = 0;
        this.flightRecoveryLimit[id] = 0;
        continue;
      }

      const jump = prev.distanceToSquared(pos) > 60 * 60;
      this.sample(pos, _routeSample, 'surface');
      const surfaceU = _routeSample.u;
      if (id === 0) this.playerSurfaceU = surfaceU;
      const flightActive = st.flightPhase !== 'surface';
      if (id === 0 && !this.finalArmed && !flightActive &&
          st.flightRouteCursor % FLIGHT_ROUTES.length === 4) {
        const action = FLIGHT_ROUTES[4].navigation?.action;
        if (action && surfaceU >= FLIGHT_ROUTES[3].gateUs[0] - 0.004 &&
            surfaceU <= FLIGHT_ROUTES[4].launchToU) {
          this.playerActionCue = st.flightCharges > 0 ? 'launch' : 'bank';
          this.playerActionRouteIndex = 4;
          this.playerActionTargetU = st.flightCharges > 0
            ? (action.launchFromU + action.launchToU) * 0.5
            : (action.bankFromU + action.bankToU) * 0.5;
          this.playerActionMarkerCount = st.flightCharges > 0 ? 2 : 3;
        }
      }
      if (id === 0 && this.finalArmed && st.flightsCleared >= FLIGHT_ROUTES.length &&
          st.flightRouteState === 'idle') {
        // The seventh pass owns the approach until Race certifies the line.
        prev.copy(pos);
        this.flightPrevClearance[id] = st.flightClearance;
        continue;
      }
      const routeIndex = st.flightRouteIndex >= 0
        ? st.flightRouteIndex
        : st.flightRouteCursor % FLIGHT_ROUTES.length;
      const visual = this.flightVisuals[routeIndex];
      if (!visual) {
        prev.copy(pos);
        this.flightPrevClearance[id] = st.flightClearance;
        continue;
      }
      const runtime = visual.runtime;
      const def = runtime.def;
      nearestOnFlight(runtime, pos.x, pos.z);
      const near = runtime.near;
      if (id === 0 && (flightActive || st.flightRouteState !== 'idle' ||
          (surfaceU >= def.qualifyFromU && surfaceU <= def.exitU + 0.01))) visual.deployActive = true;
      this.flightTurnWarn[id] = flightActive && st.flightRouteState === 'active' &&
        near.u >= def.turnWarningFromU && near.u <= def.turnWarningToU;
      if (id === 0 && !this.finalArmed && def.navigation?.turn &&
          flightActive && st.flightRouteState === 'active' &&
          near.u >= def.navigation.turn.fromU && near.u <= def.navigation.turn.toU) {
          this.playerActionCue = 'turn';
          this.playerActionRouteIndex = routeIndex;
          this.playerActionDirection = def.navigation.turn.direction;
          this.playerActionTargetU = Math.min(def.navigation.turn.toU, near.u + 0.008);
          this.playerActionMarkerCount = this.flightVisuals[routeIndex]?.turnChevronCount ?? 3;
      }

      if (jump) {
        if (st.flightRouteState === 'active') this.failFlight(boat, visual, 'teleport', surfaceU, null);
        if (st.flightRouteState !== 'passed') this.flightLatched[id] = -1;
        this.flightOffCorridorT[id] = 0;
        this.flightOffCorridorD[id] = 0;
        prev.copy(pos);
        this.flightPrevClearance[id] = st.flightClearance;
        continue;
      }

      if (st.flightRouteState === 'passed') {
        this.flightLatched[id] = routeIndex;
        const elapsed = (this.flightRecoveryT[id] ?? 0) + dt;
        const recoveryConfig = def.navigation?.postGateRecovery;
        const limit = this.flightRecoveryLimit[id] > 0
          ? this.flightRecoveryLimit[id]
          : recoveryConfig?.maxDurationS ??
            Math.max(2.5, Math.min(4, runtime.gateToExitDistance / Math.max(1, def.targetSpeed) + 1.5));
        this.flightRecoveryT[id] = elapsed;
        this.flightRecoveryLimit[id] = limit;
        if (id === 0) {
          this.playerRecoveryRoute = routeIndex;
          this.playerRecoveryElapsed = elapsed;
          this.playerRecoveryLimit = limit;
          visual.recoveryProgress = flightCurveT(def, near.u);
        }
        const end = runtime.tableN - 1;
        const tx = runtime.tx[end];
        const tz = runtime.tz[end];
        const il = 1 / (Math.hypot(tx, tz) || 1);
        const nx = tx * il;
        const nz = tz * il;
        const dx = pos.x - runtime.x[end];
        const dz = pos.z - runtime.z[end];
        const forwardOfExit = dx * nx + dz * nz >= 0;
        const signedLateralToExit = dx * nz - dz * nx;
        const lateralToExit = Math.abs(signedLateralToExit);
        boat.collisionVelocity(_recoveryVelocity);
        const forwardVelocity = _recoveryVelocity.x * nx + _recoveryVelocity.y * nz;
        const handoffMargin = recoveryConfig?.handoffMarginM ?? 24;
        const predictedLateral = Math.abs(
          signedLateralToExit + (_recoveryVelocity.x * nz - _recoveryVelocity.y * nx) * 0.35,
        );
        const stableRecovery = !recoveryConfig || predictedLateral < 24;
        const certifiedHandoff = !flightActive && forwardOfExit && lateralToExit <= handoffMargin &&
          stableRecovery && forwardVelocity >= 0;
        const timedOut = !flightActive && elapsed >= limit;
        this.flightDebug[id] = `recovery:${near.u.toFixed(4)}:${elapsed.toFixed(2)}/${limit.toFixed(2)}`;
        if (certifiedHandoff || timedOut) {
          boat.settleFlightRoute();
          this.flightLatched[id] = -1;
          this.flightRecoveryT[id] = 0;
          this.flightRecoveryLimit[id] = 0;
          this.flightDebug[id] = certifiedHandoff ? 'handoff:exit' : 'handoff:timeout';
          if (id === 0) {
            visual.recoveryFade = 0.3;
            this.playerRecoveryRoute = -1;
            this.playerRecoveryElapsed = 0;
            this.playerRecoveryLimit = 0;
          }
        }
        this.flightOffCorridorT[id] = 0;
        this.flightOffCorridorD[id] = 0;
        prev.copy(pos);
        this.flightPrevClearance[id] = st.flightClearance;
        continue;
      }

      const insideAttemptSpan = surfaceU >= def.entryU - FLIGHT_ATTEMPT_EARLY_U && surfaceU <= def.exitU + 0.006;
      const crossedChallengeEntry = surfaceU >= def.entryU - 0.001;
      if (flightActive && st.flightRouteState === 'idle' && insideAttemptSpan &&
          (near.distance <= def.corridorHalfWidth || crossedChallengeEntry)) {
        boat.beginFlightRouteAttempt(routeIndex, st.flightRouteCursor, def.targetSpeed);
        this.flightDebug[id] = 'active';
        this.flightLatched[id] = routeIndex;
        this.flightOffCorridorT[id] = 0;
        this.flightOffCorridorD[id] = 0;
        if (near.u > visual.gates[0].u + FLIGHT_GATE_BYPASS_U) {
          this.failFlight(boat, visual, 'late', near.u, 1);
        }
      }

      if (!flightActive && st.flightRouteState === 'idle' && insideAttemptSpan &&
          _routeSample.distance < SURFACE_ROUTE_FAIL_DISTANCE_M &&
          surfaceU >= def.gateUs[0] - FLIGHT_GATE_BYPASS_U) {
        boat.beginFlightRouteAttempt(routeIndex, st.flightRouteCursor, def.targetSpeed);
        this.flightDebug[id] = 'no-launch';
        this.failFlight(boat, visual, 'no_launch', surfaceU, 1);
      }

      if (st.flightRouteState === 'active') {
        this.flightLatched[id] = routeIndex;
        const gateIndex = st.flightGateProgress;
        const gate = visual.gates[gateIndex];
        if (gate && flightActive) {
          const d0 = (prev.x - gate.center.x) * gate.normal.x + (prev.z - gate.center.z) * gate.normal.z;
          const d1 = (pos.x - gate.center.x) * gate.normal.x + (pos.z - gate.center.z) * gate.normal.z;
          if (d0 <= 0 && d1 > 0) {
            const f = d0 / (d0 - d1);
            const ix = prev.x + (pos.x - prev.x) * f;
            const iz = prev.z + (pos.z - prev.z) * f;
            const previousClearance = this.flightPrevClearance[id] ?? st.flightClearance;
            const crossingClearance = previousClearance + (st.flightClearance - previousClearance) * f;
            const lateral = (ix - gate.center.x) * gate.right.x + (iz - gate.center.z) * gate.right.z;
            const lateralLimit = def.passHalfWidth;
            const certifiedPhase = st.flightPhase === 'ascending' || st.flightPhase === 'cruise';
            if (!certifiedPhase || crossingClearance < 2.8) {
              this.flightDebug[id] = `late-height:f${routeIndex + 1}:y${crossingClearance.toFixed(2)}`;
              this.failFlight(boat, visual, 'late', gate.u, gateIndex + 1, lateral, lateralLimit);
            } else if (Math.abs(lateral) <= lateralLimit) {
              boat.applyFlightGatePass(gateIndex);
              if (id === 0) {
                gate.pulse = 0.36;
                gate.cleared = true;
                gate.anchor.visible = false;
              }
              if (gateIndex + 1 >= visual.gates.length) {
                boat.completeFlightRoute(routeIndex, st.flightRouteCursor);
                this.flightRecoveryT[id] = 0;
                this.flightRecoveryLimit[id] = def.navigation?.postGateRecovery?.maxDurationS ??
                  Math.max(2.5, Math.min(4,
                    runtime.gateToExitDistance / Math.max(1, def.targetSpeed) + 1.5));
                if (id === 0) {
                  this.playerRecoveryRoute = routeIndex;
                  this.playerRecoveryElapsed = 0;
                  this.playerRecoveryLimit = this.flightRecoveryLimit[id];
                }
                this.flightDebug[id] = 'passed';
              }
            } else {
              const reason = lateral < 0 ? 'gate_left' : 'gate_right';
              this.flightDebug[id] = `gate${gateIndex + 1}:lat${lateral.toFixed(2)}:limit${lateralLimit.toFixed(2)}`;
              this.failFlight(boat, visual, reason, gate.u, gateIndex + 1, lateral, lateralLimit);
              if (id === 0) {
                this.flightWarn = 0.8;
                this.flightWarnRoute = routeIndex;
              }
            }
          }
          if (st.flightRouteState === 'active' && near.u > gate.u + FLIGHT_GATE_BYPASS_U) {
            this.flightDebug[id] = `bypass${gateIndex + 1}:u${near.u.toFixed(4)}`;
            this.failFlight(boat, visual, 'gate', near.u, gateIndex + 1);
            if (id === 0) {
              this.flightWarn = 0.8;
              this.flightWarnRoute = routeIndex;
            }
          }
        }
      }

      if (st.flightRouteState === 'active') {
        if (!flightActive || st.flightPhase === 'descending') {
          this.flightDebug[id] = `landing:g${st.flightGateProgress}`;
          this.failFlight(boat, visual, 'landing', near.u, null);
        } else {
          const outside = near.distance > def.corridorHalfWidth;
          const offT = outside
            ? (this.flightOffCorridorT[id] ?? 0) + dt
            : Math.max(0, (this.flightOffCorridorT[id] ?? 0) - dt * 2);
          const offD = outside
            ? (this.flightOffCorridorD[id] ?? 0) + Math.sqrt(prev.distanceToSquared(pos))
            : Math.max(0, (this.flightOffCorridorD[id] ?? 0) - dt * 20);
          this.flightOffCorridorT[id] = offT;
          this.flightOffCorridorD[id] = offD;
          if (offT >= FLIGHT_CORRIDOR_GRACE) {
            this.flightDebug[id] = `corridor:${near.distance.toFixed(2)}:f${routeIndex + 1}`;
            if (id === 0) {
              this.flightWarn = Math.max(this.flightWarn, 0.25);
              this.flightWarnRoute = routeIndex;
            }
          }
          if (offT >= FLIGHT_CORRIDOR_FAIL || offD >= FLIGHT_CORRIDOR_FAIL_DISTANCE) {
            this.failFlight(boat, visual, 'corridor', near.u, null, null, null, near.distance);
            if (id === 0) {
              this.flightWarn = 0.8;
              this.flightWarnRoute = routeIndex;
            }
          }
        }
      }

      if (st.flightRouteState === 'active' && surfaceU > def.exitU + 0.006) {
        this.flightDebug[id] = `exit:g${st.flightGateProgress}`;
        this.failFlight(boat, visual, 'exit', surfaceU, null);
        if (id === 0) {
          this.flightWarn = 0.8;
          this.flightWarnRoute = routeIndex;
        }
      }

      if (id === 0 && st.flightRouteMiss) {
        this.flightWarn = 0.8;
        this.flightWarnRoute = routeIndex;
      }

      if (st.flightRouteState !== 'active' &&
          (!flightActive || surfaceU < def.entryU - 0.03 || surfaceU > def.exitU + 0.006)) {
        this.flightLatched[id] = -1;
        this.flightOffCorridorT[id] = 0;
        this.flightOffCorridorD[id] = 0;
      }

      prev.copy(pos);
      this.flightPrevClearance[id] = st.flightClearance;
    }
    this.updatePlayerGuidance(boats[0]);
  }

  /** Contact separation changes the next frame's baseline, never the just-checked flight path. */
  syncFlightTrackingAfterCollisions(boats: readonly IBoat[]): void {
    for (const boat of boats) {
      const prev = this.flightPrev[boat.id];
      if (prev) prev.copy(boat.state.position);
      this.flightPrevClearance[boat.id] = boat.state.flightClearance;
    }
  }

  private updatePlayerGuidance(player: IBoat | undefined): void {
    let next = -1;
    if (player) {
      const st = player.state;
      if (this.playerRecoveryRoute >= 0 && st.flightRouteState === 'passed' && st.flightPhase === 'surface') {
        this.playerPreviewFinal = this.finalArmed && st.flightsCleared >= FLIGHT_ROUTES.length;
        this.playerPreviewRoute = this.playerPreviewFinal ? -1 : st.flightRouteCursor % FLIGHT_ROUTES.length;
      } else if (st.flightRouteState === 'active' || st.flightRouteState === 'failed') {
        this.playerPreviewRoute = -1;
        this.playerPreviewFinal = false;
      }
      const recoverySlot = this.playerRecoveryRoute >= 0
        ? this.playerRecoveryRoute
        : this.flightVisuals.findIndex((visual) => visual.recoveryFade > 0);
      // Validation keeps the passed branch until its authored handoff. The
      // visual guide can hand the player's eye to the next branch as soon as
      // the hull touches water, when the old airborne line has done its job.
      const landedRecovery = this.playerRecoveryRoute >= 0 &&
        st.flightRouteState === 'passed' && st.flightPhase === 'surface';
      const finalApproach = this.playerPreviewFinal ||
        (this.finalArmed && st.flightsCleared >= FLIGHT_ROUTES.length && (landedRecovery || recoverySlot < 0));
      const slot = this.playerPreviewFinal
        ? -1
        : this.playerPreviewRoute >= 0 ? this.playerPreviewRoute
        : landedRecovery
          ? finalApproach ? -1 : st.flightRouteCursor % FLIGHT_ROUTES.length
        : recoverySlot >= 0
          ? recoverySlot
          : finalApproach ? -1
            : st.flightRouteIndex >= 0 ? st.flightRouteIndex : st.flightRouteCursor % FLIGHT_ROUTES.length;
      const def = FLIGHT_ROUTES[slot];
      if (def && (this.playerPreviewRoute >= 0 || landedRecovery || recoverySlot >= 0 ||
          st.flightRouteState !== 'idle' || st.flightPhase !== 'surface' ||
          (this.playerSurfaceU >= def.qualifyFromU && this.playerSurfaceU <= def.exitU + 0.01))) {
        next = slot;
      }
    }
    if (next !== this.activeGuideRoute) {
      for (let i = 0; i < this.flightVisuals.length; i++) {
        const visual = this.flightVisuals[i];
        visual.group.visible = i === next;
        if (i !== next) {
          visual.deployActive = false;
          visual.deployTime = 0;
          for (const gate of visual.gates) {
            gate.deploy = 0;
            gate.pulse = 0;
            gate.cleared = false;
            gate.group.visible = true;
            gate.anchor.visible = true;
          }
        }
      }
      this.activeGuideRoute = next;
    }
    const active = next >= 0 ? FLIGHT_ROUTES[next] : null;
    const recovering = next >= 0 && (this.playerRecoveryRoute === next || this.flightVisuals[next].recoveryFade > 0);
    this.ribbonMat.uniforms.uGuideActive.value = active ? 1 : 0;
    this.ribbonMat.uniforms.uMaskStart.value = active ? Math.max(0, active.entryU * LAP_LENGTH - 4) : 0;
    this.ribbonMat.uniforms.uMaskEnd.value = active
      ? Math.min(LAP_LENGTH, active.exitU * LAP_LENGTH + (recovering ? -16 : 8))
      : 0;
    for (const floater of this.floaters) {
      floater.obj.visible = !active || floater.routeU === undefined ||
        floater.routeU <= active.entryU + 0.002 || floater.routeU > active.exitU;
    }
  }

  update(dt: number, t: number): void {
    this.ribbonMat.uniforms.uTime.value = t;
    this.ribbonMat.uniforms.uPlayerS.value = this.playerSurfaceU * LAP_LENGTH;
    const surfaceAction = this.playerActionCue === 'bank' || this.playerActionCue === 'launch';
    this.surfaceActionVisual.group.visible = surfaceAction;
    this.surfaceActionVisual.bankGroup.visible = this.playerActionCue === 'bank';
    this.surfaceActionVisual.launchGroup.visible = this.playerActionCue === 'launch';
    this.stripMat.uniforms.uTime.value = t;
    this.flightWarn = Math.max(0, this.flightWarn - dt);
    this.flightFlowTime += dt * (1 + this.playerFlightPressure * 1.4);
    if (this.finalStation) {
      if (this.finalCelebrating) this.finalCelebrationTime += dt;
      const target = this.finalArmed || this.finalCelebrating ? 1 : 0;
      this.finalStationBlend += (target - this.finalStationBlend) * (1 - Math.exp(-dt * 4.5));
      const blend = Math.max(0, Math.min(1, this.finalStationBlend));
      this.finalStation.visible = blend > 0.005;
      const burst = this.finalCelebrating ? Math.max(0, 1 - this.finalCelebrationTime / 1.2) : 0;
      this.finalStation.scale.set(1 + burst * 0.08, 0.24 + blend * (0.76 + burst * 0.32), 1 + burst * 0.08);
      const pulse = 0.82 + Math.sin(t * (this.finalCelebrating ? 8.5 : 3.2)) * (this.finalCelebrating ? 0.28 : 0.18) + burst * 0.22;
      this.finalStation.traverse((object) => {
        if (object.userData.isWeathervane) {
          object.rotation.y = Math.sin(t * 1.6) * 0.26 + Math.cos(t * 0.75) * 0.12;
        }
        if (object.userData.isAnemometer) {
          object.rotation.y = t * (this.finalCelebrating ? 10.5 : 5.8);
        }
        if (!(object instanceof THREE.Mesh)) return;
        const material = object.material as THREE.MeshBasicMaterial;
        const baseOpacity = Number(object.userData.finalBaseOpacity ?? 0);
        if (baseOpacity > 0 && 'opacity' in material) material.opacity = baseOpacity * blend * pulse;
        const particle = Number(object.userData.finalParticle ?? -1);
        if (particle >= 0) {
          const pY = 1.0 + ((t * (2.2 + particle * 0.045) + particle * 1.25) % 13.0);
          object.position.y = pY;
          const pSide = particle % 2 === 0 ? 1 : -1;
          const pLane = Math.floor(particle / 2);
          object.position.x = pSide * (3.6 + (pLane % 5) * 0.82) + Math.sin(t * 1.6 + particle * 1.8) * 1.1;
          object.position.z = Math.cos(t * 1.4 + particle * 2.3) * 1.2;
          object.rotation.x = t * (1.2 + particle * 0.06);
          object.rotation.y = t * (0.9 + particle * 0.04);
          object.rotation.z = Math.sin(t * 1.8 + particle) * 0.8;
          const yFade = pY < 2.5 ? (pY - 1.0) / 1.5 : pY > 10.5 ? Math.max(0, (13.0 - pY) / 2.5) : 1.0;
          if (baseOpacity > 0 && 'opacity' in material) material.opacity = baseOpacity * blend * pulse * yFade;
        }
      });
    }
    const readyStep = this.playerFlightReady && Math.floor(t * 4) % 2 === 0 ? 1 : 0;
    for (let routeIndex = 0; routeIndex < this.flightVisuals.length; routeIndex++) {
      const visual = this.flightVisuals[routeIndex];
      visual.recoveryFade = Math.max(0, visual.recoveryFade - dt);
      if (visual.deployActive) visual.deployTime += dt;
      const warn = this.flightWarnRoute === routeIndex ? Math.min(1, this.flightWarn * 4) : 0;
      const upcoming = routeIndex === this.playerFlightIndex;
      visual.ribbon.uniforms.uTime.value = this.flightFlowTime;
      visual.ribbon.uniforms.uWarn.value = warn;
      visual.ribbon.uniforms.uReady.value = upcoming && this.playerFlightReady ? 1 : 0;
      visual.ribbon.uniforms.uTurn.value = upcoming && this.flightTurnWarn[0] ? 1 : 0;
      const recovery = this.playerRecoveryRoute === routeIndex ? 1 : visual.recoveryFade > 0 ? visual.recoveryFade / 0.3 : 0;
      visual.ribbon.uniforms.uRecovery.value = recovery;
      visual.ribbon.uniforms.uRecoveryProgress.value = visual.recoveryProgress;
      if (recovery > 0) visual.ribbonMesh.layers.disable(LAYER_ENERGY);
      else visual.ribbonMesh.layers.enable(LAYER_ENERGY);
      visual.recoveryArrows.visible = recovery > 0.04;
      visual.recoveryArrowMaterial.opacity = 0.68 * recovery;
      if (recovery > 0) {
        for (let i = 0; i < visual.recoveryArrowFractions.length; i++) {
          const matrix = visual.recoveryArrowMatrices[i];
          matrix.elements[13] = waterHeight(matrix.elements[12], matrix.elements[14], t) + 0.28;
          visual.recoveryArrows.setMatrixAt(
            i,
            visual.recoveryArrowFractions[i] >= visual.recoveryProgress - 0.018
              ? matrix
              : _hiddenRecoveryArrow,
          );
        }
        visual.recoveryArrows.instanceMatrix.needsUpdate = true;
      }
      visual.rail.color.setHex(warn > 0.5 ? PALETTE.uiWarn : recovery > 0 ? PALETTE.racingLine : PALETTE.flight, THREE.NoColorSpace);
      visual.ring.color.setHex(warn > 0.5 ? PALETTE.uiWarn : recovery > 0 ? PALETTE.racingLine : PALETTE.flight, THREE.NoColorSpace);
      visual.rail.opacity = recovery > 0 ? 0 : warn > 0.5 ? 0.72 : 0.24 + (upcoming ? readyStep * 0.08 : 0);
      visual.ring.opacity = warn > 0.5 ? 1 : 0.78 + (upcoming ? readyStep * 0.2 : 0);
      for (let i = 0; i < visual.gates.length; i++) {
        const gate = visual.gates[i];
        const raw = Math.max(0, Math.min(1, (visual.deployTime - i * 0.12) / 0.5));
        gate.deploy = raw * raw * (3 - 2 * raw);
        const surface = waterHeight(gate.center.x, gate.center.z, t);
        const submerged = surface - gate.halfHeight - 2.8;
        gate.center.y = submerged + (gate.targetY - submerged) * gate.deploy;
        gate.group.position.y = gate.center.y;
        gate.pulse = Math.max(0, gate.pulse - dt);
        const p = gate.pulse / 0.36;
        gate.group.scale.setScalar(1 + p * 0.1);
        gate.group.visible = !gate.cleared || gate.pulse > 0.06;
        const distance = upcoming ? gate.center.distanceTo(this.playerPosition) : 0;
        const far = Math.max(0, Math.min(1, (distance - 70) / 150));
        const smoothFar = far * far * (3 - 2 * far);
        const anchorScale = 1 + smoothFar * 0.75;
        gate.anchor.scale.setScalar(anchorScale);
        if (upcoming) this.playerTargetAnchorScale = anchorScale;
        gate.anchor.rotation.z = this.flightFlowTime * 0.18;
        (gate.anchor.material as THREE.MeshBasicMaterial).opacity =
          0.68 + Math.sin(this.flightFlowTime * 3.4) * 0.12;
      }
    }
    for (const f of this.floaters) {
      f.obj.position.y = waterHeight(f.x, f.z, t);
      waterNormalInto(_n, f.x, f.z, t);
      _q.setFromUnitVectors(UP, _n).multiply(f.yawQ);
      f.obj.quaternion.copy(_q);
    }
    this.prayerFlagMat.uniforms.uTime.value = t;
    for (let i = 0; i < this.windChimes.length; i++) {
      const chime = this.windChimes[i];
      const phase = chime.phase;
      const f = chime.freq;
      const bx = Math.sin(t * f + phase) * chime.swayX + Math.sin(t * f * 1.73 + phase * 1.2) * (chime.swayX * 0.35);
      const bz = Math.cos(t * f * 0.92 + phase) * chime.swayZ + Math.cos(t * f * 2.1 + phase * 0.8) * (chime.swayZ * 0.28);
      chime.group.rotation.x = bx;
      chime.group.rotation.z = bz;

      const cx = Math.sin(t * f + phase - 0.48) * (chime.swayX * 2.4) + Math.cos(t * f * 2.3 + phase) * (chime.swayX * 0.7);
      const cz = Math.cos(t * f * 0.92 + phase - 0.42) * (chime.swayZ * 2.1);
      chime.catcher.rotation.x = cx;
      chime.catcher.rotation.z = cz;
    }
  }

  // ------------------------------------------------------- flight route ----

  private buildFlightRoute(runtime: FlightRouteRuntime): FlightRouteVisual {
    const def = runtime.def;
    const routeGroup = new THREE.Group();
    routeGroup.name = `${def.id}-guide`;
    routeGroup.visible = false;
    this.object.add(routeGroup);
    const SEG = Math.max(64, Math.ceil(runtime.routeLength / 1.8));
    const HALF_W = def.corridorHalfWidth;
    const pos = new Float32Array((SEG + 1) * 2 * 3);
    const uv = new Float32Array((SEG + 1) * 2 * 2);
    const idx = new Uint16Array(SEG * 6);
    const p = new THREE.Vector3();
    const t = new THREE.Vector3();

    for (let i = 0; i <= SEG; i++) {
      const f = i / SEG;
      const u = def.entryU + (def.exitU - def.entryU) * f;
      this.routePointAt(def.id, u, p);
      this.routeTangentAt(def.id, u, t);
      const rx = t.z;
      const rz = -t.x;
      const o = i * 6;
      pos[o] = p.x + rx * HALF_W;
      pos[o + 1] = p.y + 0.05;
      pos[o + 2] = p.z + rz * HALF_W;
      pos[o + 3] = p.x - rx * HALF_W;
      pos[o + 4] = p.y + 0.05;
      pos[o + 5] = p.z - rz * HALF_W;
      const q = i * 4;
      uv[q] = 0;
      uv[q + 1] = f;
      uv[q + 2] = 1;
      uv[q + 3] = f;
      if (i < SEG) {
        const k = i * 6;
        const a = i * 2;
        idx[k] = a;
        idx[k + 1] = a + 1;
        idx[k + 2] = a + 2;
        idx[k + 3] = a + 1;
        idx[k + 4] = a + 3;
        idx[k + 5] = a + 2;
      }
    }

    const ribbonGeo = new THREE.BufferGeometry();
    ribbonGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    ribbonGeo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    ribbonGeo.setIndex(new THREE.BufferAttribute(idx, 1));
    const ribbonMat = new THREE.ShaderMaterial({
      name: 'FlightRoute',
      uniforms: {
        uTime: { value: 0 },
        uWarn: { value: 0 },
        uReady: { value: 0 },
        uTurn: { value: 0 },
        uHasTurn: { value: def.navigation?.turn ? 1 : 0 },
        uTurnFrom: { value: def.navigation?.turn ? flightCurveT(def, def.navigation.turn.fromU) : 0 },
        uTurnTo: { value: def.navigation?.turn ? flightCurveT(def, def.navigation.turn.toU) : 1 },
        uRecovery: { value: 0 },
        uRecoveryProgress: { value: runtime.gateFraction },
        uGateF: { value: runtime.gateFraction },
        uFlight: { value: new THREE.Color().setHex(PALETTE.flight, THREE.NoColorSpace) },
        uRecoveryColor: { value: new THREE.Color().setHex(PALETTE.racingLine, THREE.NoColorSpace) },
        uInk: { value: new THREE.Color().setHex(PALETTE.ink, THREE.NoColorSpace) },
        uFoam: { value: new THREE.Color().setHex(PALETTE.foam, THREE.NoColorSpace) },
        uTurnColor: { value: new THREE.Color().setHex(PALETTE.sunFlare, THREE.NoColorSpace) },
        uWarnColor: { value: new THREE.Color().setHex(PALETTE.uiWarn, THREE.NoColorSpace) },
      },
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform float uRecovery;
        uniform float uGateF;
        varying vec2 vUv;
        ${WAVES_GLSL}
        void main() {
          vUv = uv;
          vec3 p = position;
          float recoveryTail = uRecovery * step(uGateF - 0.003, uv.y);
          p.y = mix(p.y, waveHeight(p.xz, uTime) + 0.22, recoveryTail);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uWarn;
        uniform float uReady;
        uniform float uTurn;
        uniform float uHasTurn;
        uniform float uTurnFrom;
        uniform float uTurnTo;
        uniform float uRecovery;
        uniform float uRecoveryProgress;
        uniform float uGateF;
        uniform vec3 uFlight;
        uniform vec3 uRecoveryColor;
        uniform vec3 uInk;
        uniform vec3 uFoam;
        uniform vec3 uTurnColor;
        uniform vec3 uWarnColor;
        varying vec2 vUv;
        void main() {
          float wave = sin(vUv.y * 52.0 - uTime * 5.5) * 0.026;
          float flowA = 1.0 - smoothstep(0.014, 0.034, abs(vUv.x - (0.43 + wave)));
          float flowB = 1.0 - smoothstep(0.014, 0.034, abs(vUv.x - (0.57 - wave)));
          float packetPhase = fract(vUv.y * 13.0 - uTime * 1.9);
          float packet = smoothstep(0.02, 0.16, packetPhase) * (1.0 - smoothstep(0.55, 0.82, packetPhase));
          float flow = max(flowA, flowB) * (0.3 + packet * 0.7);
          float turnIn = smoothstep(uTurnFrom, min(uTurnFrom + 0.025, uTurnTo), vUv.y);
          float turnOut = 1.0 - smoothstep(max(uTurnFrom, uTurnTo - 0.025), uTurnTo, vUv.y);
          float turnZone = uHasTurn * turnIn * turnOut;
          float foamBeat = 0.08 + packet * 0.2;
          vec3 airColor = mix(uFlight, uFoam, foamBeat);
          float brakeInk = turnZone * (0.32 + packet * 0.14);
          vec3 color = mix(airColor, uTurnColor, min(0.62, brakeInk + uTurn * turnZone * 0.22));
          color = mix(color, uWarnColor, uWarn);
          float ready = uReady * step(0.5, fract(uTime * 4.0));
          float edge = 1.0 - smoothstep(0.0, 0.08, min(vUv.x, 1.0 - vUv.x));
          float virtualPanel = (1.0 - edge) * (0.075 + step(0.72, fract(vUv.y * 22.0 - uTime * 0.8)) * 0.055);
          float centerVeil = 1.0 - smoothstep(0.08, 0.48, abs(vUv.x - 0.5));
          float alpha = virtualPanel + centerVeil * 0.045 + edge * 0.2 + flow * (0.34 + ready * 0.08);
          alpha += turnZone * (0.04 + packet * 0.04);
          float recoveryT = smoothstep(uGateF, 1.0, vUv.y);
          float recoverySide = abs(vUv.x - 0.5);
          float recoveryHalf = mix(0.48, 0.14, recoveryT);
          float recoveryCore = 1.0 - smoothstep(recoveryHalf * 0.18, recoveryHalf * 0.5, recoverySide);
          float recoveryEdge = 1.0 - smoothstep(0.025, 0.055, abs(recoverySide - recoveryHalf));
          float recoveryDash = step(0.46, fract(vUv.y * 18.0 - uTime * 1.8));
          float recoveryAlpha = recoveryCore * 0.2 + recoveryEdge * recoveryDash * 0.72;
          float recoveryVisible = step(max(uGateF - 0.003, uRecoveryProgress - 0.035), vUv.y);
          vec3 recoveryColor = mix(uInk, uRecoveryColor, 0.82 + recoveryCore * 0.18);
          color = mix(color, recoveryColor, uRecovery * recoveryVisible);
          alpha = mix(alpha, recoveryAlpha * recoveryVisible * uRecovery, uRecovery);
          gl_FragColor = vec4(color, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const ribbon = new THREE.Mesh(ribbonGeo, ribbonMat);
    ribbon.name = `${def.id}-ribbon`;
    ribbon.renderOrder = 3;
    ribbon.layers.enable(LAYER_ENERGY);
    routeGroup.add(ribbon);

    // Directional handoff markers appear only after the scoring portal. They
    // sit on the same authored curve as validation and remain separated so
    // the recovery funnel cannot be mistaken for a wall or a second road.
    const arrowGeo = new THREE.BufferGeometry();
    arrowGeo.setAttribute('position', new THREE.Float32BufferAttribute([
      -0.5, 0, -0.78,  0.5, 0, -0.78,  0.5, 0, -0.08,
      -0.5, 0, -0.78,  0.5, 0, -0.08, -0.5, 0, -0.08,
      -0.92, 0, -0.08,  0.92, 0, -0.08,  0, 0, 1.08,
    ], 3));
    arrowGeo.computeVertexNormals();
    const recoveryArrowMaterial = new THREE.MeshBasicMaterial({
      color: PALETTE.racingLine,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const recoveryArrows = new THREE.InstancedMesh(arrowGeo, recoveryArrowMaterial, 7);
    recoveryArrows.name = `${def.id}-recovery-arrows`;
    recoveryArrows.visible = false;
    recoveryArrows.renderOrder = 5;
    const arrowTransform = new THREE.Object3D();
    const recoveryArrowFractions: number[] = [];
    const recoveryArrowMatrices: THREE.Matrix4[] = [];
    for (let i = 0; i < 7; i++) {
      const f = runtime.gateFraction + (1 - runtime.gateFraction) * ((i + 0.7) / 7.7);
      recoveryArrowFractions.push(f);
      const u = def.entryU + (def.exitU - def.entryU) * f;
      runtimePointAt(runtime, u, p);
      runtimeTangentAt(runtime, u, t);
      arrowTransform.position.set(p.x, 0.28, p.z);
      arrowTransform.rotation.set(0, Math.atan2(t.x, t.z), 0);
      const taper = 0.96 - i * 0.025;
      arrowTransform.scale.setScalar(taper);
      arrowTransform.updateMatrix();
      recoveryArrowMatrices.push(arrowTransform.matrix.clone());
      recoveryArrows.setMatrixAt(i, arrowTransform.matrix);
    }
    recoveryArrows.instanceMatrix.needsUpdate = true;
    routeGroup.add(recoveryArrows);

    let turnChevronGroup: THREE.Group | null = null;
    let turnChevronFill: THREE.MeshBasicMaterial | null = null;
    let turnChevronCount = 0;
    const turn = def.navigation?.turn;
    if (turn) {
      turnChevronCount = 3;
      turnChevronGroup = new THREE.Group();
      turnChevronGroup.name = `${def.id}-marine-chevrons-${turn.direction}`;
      const backingMaterial = new THREE.MeshBasicMaterial({
        color: PALETTE.ink,
        transparent: true,
        opacity: 0.78,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      turnChevronFill = new THREE.MeshBasicMaterial({
        color: PALETTE.sunFlare,
        transparent: true,
        opacity: def.index === 4 ? 0.9 : 0.82,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const backing = new THREE.InstancedMesh(makeOpenChevronGeometry(), backingMaterial, turnChevronCount);
      const fill = new THREE.InstancedMesh(makeOpenChevronGeometry(0.055), turnChevronFill, turnChevronCount);
      backing.name = `${def.id}-chevron-ink`;
      fill.name = `${def.id}-chevron-fill`;
      backing.renderOrder = 5;
      fill.renderOrder = 6;
      const marker = new THREE.Object3D();
      const fillMarker = new THREE.Object3D();
      for (let i = 0; i < turnChevronCount; i++) {
        // Keep the three road-grade chevrons together near the decision point.
        // A compact, lane-width cluster reads through waves and perspective;
        // small markers spread across the whole bend disappear one by one.
        const f = 0.16 + i * 0.15;
        const u = THREE.MathUtils.lerp(turn.fromU, turn.toU, f);
        runtimePointAt(runtime, u, p);
        runtimeTangentAt(runtime, u, t).setY(0).normalize();
        marker.position.set(p.x, p.y + 0.17, p.z);
        marker.rotation.set(0, Math.atan2(t.x, t.z) + (turn.direction === 'left' ? Math.PI : 0), 0);
        marker.scale.set(Math.min(4.5, Math.max(3.4, HALF_W * 0.62)), 1.08, 1.85);
        marker.updateMatrix();
        backing.setMatrixAt(i, marker.matrix);
        fillMarker.position.copy(marker.position);
        fillMarker.rotation.copy(marker.rotation);
        fillMarker.scale.copy(marker.scale).multiplyScalar(0.7);
        fillMarker.updateMatrix();
        fill.setMatrixAt(i, fillMarker.matrix);
      }
      backing.instanceMatrix.needsUpdate = true;
      fill.instanceMatrix.needsUpdate = true;
      turnChevronGroup.add(backing, fill);
      if (def.index === 4) {
        const verticalInk = makeVerticalChevronGeometry();
        const verticalFill = makeVerticalChevronGeometry(0.055);
        const mastGeometry = new THREE.CylinderGeometry(0.07, 0.11, 1, 6);
        const buoyGeometry = new THREE.CylinderGeometry(0.34, 0.48, 0.5, 8);
        const foamGeometry = makeFoamRingGeometry();
        const mastMaterial = new THREE.MeshBasicMaterial({ color: PALETTE.ink, toneMapped: false });
        const buoyMaterial = new THREE.MeshBasicMaterial({ color: PALETTE.flightDeep, toneMapped: false });
        const foamMaterial = new THREE.MeshBasicMaterial({
          color: PALETTE.foam,
          transparent: true,
          opacity: 0.8,
          depthWrite: false,
          side: THREE.DoubleSide,
          toneMapped: false,
        });
        for (let i = 0; i < turnChevronCount; i++) {
          const f = (i + 0.75) / (turnChevronCount + 0.5);
          const u = THREE.MathUtils.lerp(turn.fromU, turn.toU, f);
          runtimePointAt(runtime, u, p);
          runtimeTangentAt(runtime, u, t).setY(0).normalize();
          const outside = turn.direction === 'right' ? 1 : -1;
          const support = new THREE.Group();
          support.name = `${def.id}-chevron-buoy-${i + 1}`;
          support.position.set(p.x + t.z * (HALF_W + 1.75) * outside, 0, p.z - t.x * (HALF_W + 1.75) * outside);
          const buoy = new THREE.Mesh(buoyGeometry, buoyMaterial);
          buoy.position.y = 0.24;
          const foam = new THREE.Mesh(foamGeometry, foamMaterial);
          foam.position.y = 0.45;
          foam.scale.setScalar(0.38);
          const mastHeight = Math.max(3.8, p.y + 1.05);
          const mast = new THREE.Mesh(mastGeometry, mastMaterial);
          mast.position.y = mastHeight * 0.5;
          mast.scale.y = mastHeight;
          const signInk = new THREE.Mesh(verticalInk, backingMaterial);
          signInk.position.y = mastHeight;
          signInk.scale.setScalar(1.08);
          const sign = new THREE.Mesh(verticalFill, turnChevronFill);
          sign.position.set(0, mastHeight, 0.055);
          sign.scale.setScalar(0.78);
          sign.renderOrder = 6;
          support.add(buoy, foam, mast, signInk, sign);
          turnChevronGroup.add(support);
          const yaw = Math.atan2(-t.x, -t.z) + (turn.direction === 'left' ? Math.PI : 0);
          this.floaters.push({
            obj: support,
            x: support.position.x,
            z: support.position.z,
            yawQ: new THREE.Quaternion().setFromAxisAngle(UP, yaw),
          });
        }
      }
      routeGroup.add(turnChevronGroup);
    }

    const railMat = new THREE.MeshBasicMaterial({
      color: PALETTE.flight,
      transparent: true,
      opacity: 0.68,
      depthWrite: false,
      toneMapped: false,
    });
    for (const side of [-1, 1]) {
      const railPoints: THREE.Vector3[] = [];
      for (let i = 0; i <= 36; i++) {
        const f = i / 36;
        const u = def.entryU + (def.exitU - def.entryU) * f;
        this.routePointAt(def.id, u, p);
        this.routeTangentAt(def.id, u, t);
        railPoints.push(new THREE.Vector3(p.x + t.z * HALF_W * side, p.y + 0.12, p.z - t.x * HALF_W * side));
      }
      const railCurve = new THREE.CatmullRomCurve3(railPoints, false, 'centripetal');
      const rail = new THREE.Mesh(new THREE.TubeGeometry(railCurve, 120, 0.085, 5, false), railMat);
      rail.name = `${def.id}-rail-${side > 0 ? 'r' : 'l'}`;
      rail.renderOrder = 4;
      rail.layers.enable(LAYER_ENERGY);
      routeGroup.add(rail);
    }

    const stoneMat = createToonMaterial({
      color: PALETTE.stoneAncient,
      shadowTint: PALETTE.skyMid,
      emissive: PALETTE.stoneAncient,
      emissiveIntensity: 0.06,
    });
    const brassMat = createToonMaterial({
      color: PALETTE.boatBrass,
      emissive: PALETTE.boatBrass,
      emissiveIntensity: 0.35,
    });
    const vineMat = createToonMaterial({
      color: PALETTE.uiAccent,
      shadowTint: PALETTE.ink,
    });
    const leafMat = createToonMaterial({
      color: PALETTE.vineGreen,
      shadowTint: PALETTE.uiAccent,
      emissive: PALETTE.vineGreen,
      emissiveIntensity: 0.12,
    });
    const flowerMat = createToonMaterial({
      color: PALETTE.petalPink,
      emissive: PALETTE.petalPink,
      emissiveIntensity: 0.32,
    });
    const cordMat = createToonMaterial({
      color: PALETTE.boatWoodDark,
      shadowTint: PALETTE.ink,
    });
    const paperMat = createToonMaterial({
      color: PALETTE.gliderCanvas,
      shadowTint: PALETTE.skyHorizon,
      emissive: PALETTE.gliderCanvas,
      emissiveIntensity: 0.12,
    });
    const woodMat = createToonMaterial({
      color: PALETTE.boatWood,
      shadowTint: PALETTE.boatWoodDark,
    });

    const ringMat = new THREE.MeshBasicMaterial({
      color: PALETTE.flight,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      toneMapped: false,
    });
    const lockMat = new THREE.MeshBasicMaterial({
      map: makeFlightLockTexture(),
      color: PALETTE.foam,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const lockBeamMat = new THREE.MeshBasicMaterial({
      color: PALETTE.uiWarn,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      toneMapped: false,
    });
    const anchorMat = new THREE.MeshBasicMaterial({
      color: PALETTE.sunFlare,
      transparent: true,
      opacity: 0.76,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    const forward = new THREE.Vector3(0, 0, 1);
    const tangent3 = new THREE.Vector3();
    const gates: FlightGate[] = [];
    const gateHalfHeight = 1.8;
    for (let i = 0; i < def.gateUs.length; i++) {
      const u = def.gateUs[i];
      const center = this.routePointAt(def.id, u, new THREE.Vector3());
      runtimeTangentAt(runtime, u, tangent3).normalize();
      const normal = new THREE.Vector3(tangent3.x, 0, tangent3.z).normalize();
      const right = new THREE.Vector3(normal.z, 0, -normal.x);
      const gateGroup = new THREE.Group();
      gateGroup.name = `${def.id}-gate-${i + 1}`;
      gateGroup.position.copy(center);
      gateGroup.quaternion.setFromUnitVectors(forward, tangent3);

      const { archGroup, portalRingMesh, flagsMesh, chimes } = buildAncientStoneArchVisuals(
        def.passHalfWidth,
        def.gateHalfWidth,
        gateHalfHeight,
        {
          stoneMat,
          brassMat,
          vineMat,
          leafMat,
          flowerMat,
          ringMat,
          flagMat: this.prayerFlagMat,
          cordMat,
          paperMat,
          woodMat,
        },
        def.index * 10 + i,
      );
      gateGroup.add(archGroup);
      this.windChimes.push(...chimes);

      const surfaceLock = new THREE.Mesh(new THREE.PlaneGeometry(def.gateHalfWidth * 2, 2.5), lockMat);
      surfaceLock.position.y = -center.y + 1.45;
      surfaceLock.position.z = 0.14;
      surfaceLock.userData.noOutline = true;

      const lockBeam = new THREE.Mesh(new THREE.BoxGeometry(def.gateHalfWidth * 2 + 0.6, 0.12, 0.18), lockBeamMat);
      lockBeam.position.set(0, -center.y + 2.8, 0.08);
      lockBeam.userData.noOutline = true;

      const anchor = new THREE.Mesh(
        new THREE.RingGeometry(def.passHalfWidth + 0.85, def.passHalfWidth + 1.35, 32),
        anchorMat,
      );
      anchor.position.z = 0.42;
      anchor.userData.noOutline = true;

      gateGroup.add(surfaceLock, lockBeam, anchor);

      if (def.navigation?.locatorU !== undefined && Math.abs(def.navigation.locatorU - u) < 0.012) {
        const locatorMaterial = new THREE.MeshBasicMaterial({
          color: PALETTE.flight,
          transparent: true,
          opacity: 0.72,
          depthTest: false,
          depthWrite: false,
          side: THREE.DoubleSide,
          toneMapped: false,
        });
        const locatorStem = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.7, 8), locatorMaterial);
        locatorStem.name = `${def.id}-locator-stem`;
        locatorStem.position.set(0, gateHalfHeight + 2.85, 0.46);
        locatorStem.userData.noOutline = true;

        const locator = new THREE.Mesh(new THREE.RingGeometry(1.05, 1.34, 4), locatorMaterial);
        locator.name = `${def.id}-locator-diamond`;
        locator.position.set(0, gateHalfHeight + 5.3, 0.48);
        locator.rotation.z = Math.PI * 0.25;
        locator.renderOrder = 8;
        locator.userData.noOutline = true;
        gateGroup.add(locatorStem, locator);
      }

      addOutline(gateGroup, { width: 0.85 });
      markInk(gateGroup);

      // Disable INK layer on non-solid and transparent energy/warning meshes; enable LAYER_ENERGY where needed
      portalRingMesh.layers.disable(LAYER_INK);
      portalRingMesh.layers.enable(LAYER_ENERGY);
      flagsMesh.layers.disable(LAYER_INK);
      flagsMesh.layers.disable(LAYER_ENERGY);
      surfaceLock.layers.disable(LAYER_INK);
      surfaceLock.layers.disable(LAYER_ENERGY);
      lockBeam.layers.disable(LAYER_INK);
      lockBeam.layers.disable(LAYER_ENERGY);
      anchor.layers.disable(LAYER_INK);
      anchor.layers.enable(LAYER_ENERGY);

      gateGroup.traverse((o) => {
        if (o.name.startsWith(`${def.id}-locator-`)) {
          o.layers.disable(LAYER_INK);
          o.layers.disable(LAYER_ENERGY);
        }
      });

      gateGroup.renderOrder = 5;
      routeGroup.add(gateGroup);
      gates.push({
        u,
        center,
        normal,
        right,
        halfWidth: def.gateHalfWidth,
        halfHeight: gateHalfHeight,
        targetY: center.y,
        deploy: 0,
        group: gateGroup,
        pulse: 0,
        anchor,
        cleared: false,
      });
    }

    return {
      runtime,
      group: routeGroup,
      ribbonMesh: ribbon,
      ribbon: ribbonMat,
      rail: railMat,
      ring: ringMat,
      recoveryArrows,
      recoveryArrowMaterial,
      recoveryArrowFractions,
      recoveryArrowMatrices,
      turnChevronGroup,
      turnChevronFill,
      turnChevronCount,
      gates,
      deployActive: false,
      deployTime: 0,
      recoveryFade: 0,
      recoveryProgress: runtime.gateFraction,
    };
  }

  // ------------------------------------------------------------- ribbon ----

  private buildSurfaceActionVisual(): SurfaceActionVisual {
    const group = new THREE.Group();
    group.name = 'flight-5-surface-actions';
    group.visible = false;
    this.object.add(group);
    const bankGroup = new THREE.Group();
    bankGroup.name = 'flight-5-bank-actions';
    const launchGroup = new THREE.Group();
    launchGroup.name = 'flight-5-launch-actions';
    group.add(bankGroup, launchGroup);
    const backing = new THREE.MeshBasicMaterial({
      color: PALETTE.ink,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const bankFill = new THREE.MeshBasicMaterial({
      color: PALETTE.sunFlare,
      transparent: true,
      opacity: 0.94,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const launchFill = new THREE.MeshBasicMaterial({
      color: PALETTE.foam,
      transparent: true,
      opacity: 0.94,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const bankInkGeometry = makeOpenChevronGeometry();
    const bankFillGeometry = makeOpenChevronGeometry(0.055);
    const launchInkGeometry = makeForwardArrowGeometry();
    const launchFillGeometry = makeForwardArrowGeometry(0.055);
    const action = FLIGHT_ROUTES[4].navigation!.action!;
    const addMarker = (
      parent: THREE.Group,
      u: number,
      inkGeometry: THREE.BufferGeometry,
      fillGeometry: THREE.BufferGeometry,
      fillMaterial: THREE.MeshBasicMaterial,
      scale: number,
      name: string,
    ): void => {
      this.pointAt(u, _sp);
      this.tangentAt(u, _ta);
      const marker = new THREE.Group();
      marker.name = name;
      marker.position.set(_sp.x, 0, _sp.z);
      const ink = new THREE.Mesh(inkGeometry, backing);
      ink.position.y = 0.22;
      ink.scale.setScalar(scale);
      const fill = new THREE.Mesh(fillGeometry, fillMaterial);
      fill.position.y = 0.22;
      fill.scale.setScalar(scale * 0.84);
      fill.renderOrder = 5;
      marker.add(ink, fill);
      parent.add(marker);
      this.floaters.push({
        obj: marker,
        x: _sp.x,
        z: _sp.z,
        yawQ: new THREE.Quaternion().setFromAxisAngle(UP, Math.atan2(-_ta.z, _ta.x)),
      });
    };
    // These read as broad paint beats inside the green route, not as props.
    // The nearest beat is deliberately early enough to survive the low chase
    // camera and the fifth approach's foreshortening on phone screens.
    const bankStations = [action.bankFromU + 0.001, 0.592, action.bankToU - 0.013];
    for (let i = 0; i < bankStations.length; i++) {
      addMarker(
        bankGroup,
        bankStations[i],
        bankInkGeometry,
        bankFillGeometry,
        bankFill,
        2.9,
        `flight-5-bank-chevron-${i + 1}`,
      );
    }
    for (let i = 0; i < 2; i++) {
      addMarker(
        launchGroup,
        THREE.MathUtils.lerp(action.launchFromU + 0.0005, action.launchToU - 0.0015, i),
        launchInkGeometry,
        launchFillGeometry,
        launchFill,
        2.35,
        `flight-5-launch-chevron-${i + 1}`,
      );
    }
    return { group, bankGroup, launchGroup };
  }

  /** 8m soft field with a 3.4m bright spine; one draw call; OFF LAYER_INK. */
  private buildRibbon(): THREE.ShaderMaterial {
    const rows = RIBBON_SEGS + 1;
    const pos = new Float32Array(rows * 2 * 3);
    const uv = new Float32Array(rows * 2 * 2);
    const idx = new Uint32Array(RIBBON_SEGS * 6);
    const p = new THREE.Vector3();
    const t = new THREE.Vector3();
    for (let i = 0; i < rows; i++) {
      const u = (i % RIBBON_SEGS) / RIBBON_SEGS; // last row closes the loop
      CURVE.getPointAt(u, p);
      CURVE.getTangentAt(u, t);
      const il = 1 / (Math.hypot(t.x, t.z) || 1);
      const lx = -t.z * il; // left normal of the tangent
      const lz = t.x * il;
      const s = i * (LAP_LENGTH / RIBBON_SEGS); // arc-length station (m)
      pos[i * 6] = p.x + lx * RIBBON_HALF_W;
      pos[i * 6 + 1] = 0;
      pos[i * 6 + 2] = p.z + lz * RIBBON_HALF_W;
      pos[i * 6 + 3] = p.x - lx * RIBBON_HALF_W;
      pos[i * 6 + 4] = 0;
      pos[i * 6 + 5] = p.z - lz * RIBBON_HALF_W;
      uv[i * 4] = s;
      uv[i * 4 + 1] = 1;
      uv[i * 4 + 2] = s;
      uv[i * 4 + 3] = -1;
    }
    for (let i = 0; i < RIBBON_SEGS; i++) {
      const a = i * 2;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;
      idx[i * 6] = a;
      idx[i * 6 + 1] = b;
      idx[i * 6 + 2] = c;
      idx[i * 6 + 3] = b;
      idx[i * 6 + 4] = d;
      idx[i * 6 + 5] = c;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const mat = buildRibbonMaterial();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'racing-line';
    mesh.frustumCulled = false; // spans the whole course
    mesh.renderOrder = 2; // over the water
    this.object.add(mesh);
    return mat;
  }

  // -------------------------------------------------------- start strip ----

  /**
   * Start/finish checker strip painted on the water at u=0: 2 rows of cells
   * laid ALONG the spline direction (never world-axis-aligned square soup).
   * Rides the swell exactly like the ribbon (+0.04 so it paints over the
   * ribbon where they cross); hard cells, same banded distance fade as the
   * ribbon. One draw call, OFF LAYER_INK.
   */
  private buildStartStrip(): THREE.ShaderMaterial {
    const W = 15; // across the gate (towers sit at ±8.5)
    const D = 2.6; // 2 rows of 1.3m cells
    const CELLS_X = 12;
    const CELLS_Y = 2;
    const geo = new THREE.PlaneGeometry(W, D, CELLS_X, CELLS_Y);
    geo.rotateX(-Math.PI / 2); // flat: local x across the track, z along it
    const p = new THREE.Vector3();
    const t = new THREE.Vector3();
    CURVE.getPointAt(0, p);
    CURVE.getTangentAt(0, t);
    geo.rotateY(Math.atan2(t.x, t.z)); // cells track the spline direction
    geo.translate(p.x, 0, p.z);
    const mat = new THREE.ShaderMaterial({
      name: 'StartStrip',
      uniforms: {
        uTime: { value: 0 },
        uFoam: { value: new THREE.Color().setHex(PALETTE.foam, THREE.NoColorSpace) },
        uInk: { value: new THREE.Color().setHex(PALETTE.ink, THREE.NoColorSpace) },
      },
      vertexShader: /* glsl */ `
        uniform float uTime;
        varying vec2 vUv;
        varying float vDist;
        ${WAVES_GLSL}
        void main() {
          vec3 p = position;
          // ride the swell instead of clipping through it (just above the ribbon)
          p.y = waveHeight(p.xz, uTime) + 0.26;
          vUv = uv;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vDist = -mv.z;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uFoam;
        uniform vec3 uInk;
        varying vec2 vUv;
        varying float vDist;
        void main() {
          // hard checker in strip space (u across, v along the track)
          vec2 cell = floor(vec2(vUv.x * ${CELLS_X}.0, vUv.y * ${CELLS_Y}.0));
          float parity = mod(cell.x + cell.y, 2.0);
          vec3 col = mix(uInk, uFoam, parity);
          // same 2-step banded distance fade as the racing line
          float fade = vDist < 220.0 ? 1.0 : (vDist < 600.0 ? 0.62 : 0.3);
          gl_FragColor = vec4(col, 0.95 * fade);
        }
      `,
      transparent: true,
      blending: THREE.NormalBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'start-strip';
    mesh.frustumCulled = false; // the vertex shader displaces y
    mesh.renderOrder = 3; // over the ribbon where they cross
    this.object.add(mesh);
    return mat;
  }

  // -------------------------------------------------------------- gates ----

  private buildGates(): void {
    const stripeTex = makeStripeTexture();
    const bodyMat = makeStripeToon(stripeTex);
    // committed accent: orange cap matching the body's accent band — no more
    // random green wizard hats fighting the racing line
    const coneMat = createToonMaterial({
      color: PALETTE.hullReef,
      emissive: PALETTE.hullReef,
      emissiveIntensity: 0.5,
    });
    // float collar: deep ink-blue (ink lightened 70% toward waterDeep) —
    // the old near-black read as a void disc / distant black lump
    const floatBlue = new THREE.Color()
      .setHex(PALETTE.ink, THREE.NoColorSpace)
      .lerp(new THREE.Color().setHex(PALETTE.waterDeep, THREE.NoColorSpace), 0.7)
      .getHex();
    const floatMat = createToonMaterial({ color: floatBlue });
    // scalloped foam collar at the waterline, seats the buoy on the surface
    const foamRingMat = createToonMaterial({
      color: PALETTE.foam,
      emissive: PALETTE.foam,
      emissiveIntensity: 0.4,
    });
    foamRingMat.side = THREE.DoubleSide;
    // START/FINISH uses pure geometry for its towers, panel and lettering.
    // This avoids a first-load mobile GPU race that could upload CanvasTexture
    // data as black until the page was refreshed.
    const startVisuals = makeStartGantryVisuals();
    const towerMat = startVisuals.towerMaterial;
    const towerBandMat = createToonMaterial({ color: PALETTE.ink });
    const towerAccentMat = createToonMaterial({
      color: PALETTE.uiAccent,
      emissive: PALETTE.uiAccent,
      emissiveIntensity: 0.28,
    });
    const towerCapMat = createToonMaterial({
      color: PALETTE.hullPlayer,
      emissive: PALETTE.hullPlayer,
      emissiveIntensity: 0.5,
    });
    // ~30% smaller float: the old disc was wider than the buoy above it is tall
    const floatGeo = new THREE.TorusGeometry(0.88, 0.3, 10, 20);
    floatGeo.rotateX(Math.PI / 2);
    const bodyGeo = new THREE.CylinderGeometry(0.75, 0.85, 1.9, 14);
    const coneGeo = new THREE.ConeGeometry(0.66, 0.85, 14); // short squat cap, not a spire
    const foamRingGeo = makeFoamRingGeometry();
    const towerGeo = new THREE.CylinderGeometry(0.72, 1.05, 10.0, 12);
    const towerRadiusAt = (y: number): number => THREE.MathUtils.lerp(1.05, 0.72, y / 10);
    const towerSection = (fromY: number, toY: number): THREE.BufferGeometry => {
      const geometry = new THREE.CylinderGeometry(
        towerRadiusAt(toY) + 0.035,
        towerRadiusAt(fromY) + 0.035,
        toY - fromY,
        12,
      );
      geometry.translate(0, (fromY + toY) * 0.5, 0);
      return geometry;
    };
    // Same proportions as the original texture: white / black / white /
    // black / green from the waterline to the cap, now expressed as geometry.
    const towerInkParts = [towerSection(1.875, 2.8125), towerSection(7.1875, 8.125)];
    const towerBandGeo = mergeGeometries(towerInkParts, false);
    towerInkParts.forEach((part) => part.dispose());
    if (!towerBandGeo) throw new Error('Unable to merge START tower bands');
    const towerAccentGeo = towerSection(8.125, 10);
    const towerCapGeo = new THREE.ConeGeometry(1.08, 1.5, 12);

    const makeBuoy = (): THREE.Group => {
      const g = new THREE.Group();
      const f = new THREE.Mesh(floatGeo, floatMat);
      f.position.y = 0.35;
      const b = new THREE.Mesh(bodyGeo, bodyMat);
      b.position.y = 1.55;
      const c = new THREE.Mesh(coneGeo, coneMat);
      c.position.y = 2.93; // base sits on the body top (2.5), tip at 3.35
      // scalloped foam ring at the waterline: bobs/tilts with the buoy;
      // never outlined, never written into the ink prepass
      const ring = new THREE.Mesh(foamRingGeo, foamRingMat);
      ring.position.y = 0.1;
      ring.userData.noOutline = true;
      g.add(f, b, c, ring);
      // thinner ink than the gantry: full-width outlines on a far buoy merge
      // into a black cluster — at 0.75 the silhouette stays light-striped
      addOutline(g, { width: 0.75 });
      markInk(g);
      ring.layers.disable(LAYER_INK);
      return g;
    };

    const p = new THREE.Vector3();
    const t = new THREE.Vector3();

    // checkpoint gates: buoy pairs 14m apart, centred on the spline
    for (const u of CHECKPOINT_US) {
      CURVE.getPointAt(u, p);
      CURVE.getTangentAt(u, t);
      const il = 1 / (Math.hypot(t.x, t.z) || 1);
      const rx = t.z * il; // right normal
      const rz = -t.x * il;
      for (const side of [-1, 1]) {
        const buoy = makeBuoy();
        const x = p.x + rx * 7 * side;
        const z = p.z + rz * 7 * side;
        buoy.position.set(x, 0, z);
        this.object.add(buoy);
        this.floaters.push({ obj: buoy, x, z, yawQ: new THREE.Quaternion(), routeU: u });
      }
    }

    // START/FINISH gantry: two tall striped towers + banner slung high enough
    // that the chase camera (and airborne free cams) pass cleanly underneath
    CURVE.getPointAt(0, p);
    CURVE.getTangentAt(0, t);
    const heading = Math.atan2(-t.x, t.z);
    const gantry = new THREE.Group();
    gantry.name = 'start-gantry';
    for (const side of [-1, 1]) {
      const tower = new THREE.Group();
      const shaft = new THREE.Mesh(towerGeo, towerMat);
      shaft.position.y = 5.0;
      const bands = new THREE.Mesh(towerBandGeo, towerBandMat);
      bands.name = 'start-tower-black-bands';
      bands.userData.noOutline = true;
      const collar = new THREE.Mesh(towerAccentGeo, towerAccentMat);
      collar.name = 'start-tower-accent-collar';
      collar.userData.noOutline = true;
      const cap = new THREE.Mesh(towerCapGeo, towerCapMat);
      cap.position.y = 10.6;
      tower.add(shaft, bands, collar, cap);
      tower.position.x = side * 8.5;
      gantry.add(tower);
    }
    // START faces the approaching pack. The reverse restores the full finish
    // checker instead of mirroring or duplicating the word.
    const bannerFront = startVisuals.bannerFront;
    bannerFront.rotation.y = Math.PI;
    bannerFront.position.set(0, 8.6, -0.06);
    const bannerBack = startVisuals.bannerBack;
    bannerBack.position.set(0, 8.6, 0.06);
    gantry.add(bannerFront, bannerBack);
    addOutline(gantry);
    markInk(gantry);
    gantry.position.set(p.x, 0, p.z);
    const yawQ = new THREE.Quaternion().setFromAxisAngle(UP, -heading);
    gantry.quaternion.copy(yawQ);
    this.object.add(gantry);
    this.startGantry = gantry;
    this.buildFinalStation(gantry);
    this.floaters.push({ obj: gantry, x: p.x, z: p.z, yawQ });
  }

  /**
   * Golden Weathervane & Solar Archway finale landmark (金色风向标与日轮终点盛典).
   * Dormant until all seven routes are cleared, then awakens with radiant golden sunbeams,
   * a pivoting brass feather vane, spinning anemometer wind cups, and swirling celebration petals.
   */
  private buildFinalStation(gantry: THREE.Group): void {
    const station = new THREE.Group();
    station.name = 'final-station';
    station.visible = false;

    const makeEnergyMaterial = (color: number, opacity: number): THREE.MeshBasicMaterial => new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const addEnergy = (mesh: THREE.Mesh, opacity: number): void => {
      mesh.userData.noOutline = true;
      mesh.userData.finalBaseOpacity = opacity;
      mesh.layers.enable(LAYER_ENERGY);
      station.add(mesh);
    };

    // 1. Dual Left & Right Golden Solar Energy Columns (两侧天光立柱)
    const coreGeo = new THREE.CylinderGeometry(0.34, 0.62, 12.0, 12, 1, true);
    const glowGeo = new THREE.CylinderGeometry(0.95, 1.35, 13.0, 12, 1, true);
    for (const side of [-1, 1]) {
      const glow = new THREE.Mesh(glowGeo, makeEnergyMaterial(PALETTE.sunFlare, 0.26));
      glow.position.set(side * 7.15, 6.2, 0);
      addEnergy(glow, 0.26);

      const core = new THREE.Mesh(coreGeo, makeEnergyMaterial(PALETTE.sunCore, 0.90));
      core.position.set(side * 7.15, 6.0, 0);
      addEnergy(core, 0.90);
    }

    // 2. Overhead Solar Crown & Auroral Arch Beam (古代太阳日轮光环与能量横梁)
    const crown = new THREE.Mesh(
      new THREE.TorusGeometry(6.2, 0.22, 8, 48),
      makeEnergyMaterial(PALETTE.sunCore, 0.78),
    );
    crown.position.y = 9.2;
    crown.scale.set(1.24, 0.65, 1);
    addEnergy(crown, 0.78);

    const crownAura = new THREE.Mesh(
      new THREE.TorusGeometry(6.6, 0.48, 8, 48),
      makeEnergyMaterial(PALETTE.sunFlare, 0.28),
    );
    crownAura.position.y = 9.2;
    crownAura.scale.set(1.24, 0.65, 1);
    addEnergy(crownAura, 0.28);

    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(14.6, 0.2, 0.24),
      makeEnergyMaterial(PALETTE.sunFlare, 0.68),
    );
    beam.position.y = 9.8;
    addEnergy(beam, 0.68);

    // 3. Central Golden Weathervane & Anemometer Assembly (金色风向标与风速仪)
    // A: Brass Base Pedestal & Spindle Mast
    const basePedestal = new THREE.Mesh(
      new THREE.CylinderGeometry(0.32, 0.46, 0.45, 12),
      makeEnergyMaterial(PALETTE.boatBrass, 0.92),
    );
    basePedestal.position.set(0, 10.1, 0);
    addEnergy(basePedestal, 0.92);

    const spindleMast = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.08, 3.2, 10),
      makeEnergyMaterial(PALETTE.boatBrass, 0.95),
    );
    spindleMast.position.set(0, 11.8, 0);
    addEnergy(spindleMast, 0.95);

    // Turned collar beads
    for (const collarY of [10.4, 11.2, 12.6]) {
      const collar = new THREE.Mesh(
        new THREE.TorusGeometry(0.16, 0.045, 6, 16),
        makeEnergyMaterial(PALETTE.sunCore, 0.88),
      );
      collar.rotation.x = Math.PI / 2;
      collar.position.set(0, collarY, 0);
      addEnergy(collar, 0.88);
    }

    // B: 4-Way Cardinal Compass Arms (十字方位罗盘翼臂)
    const armX = new THREE.Mesh(
      new THREE.BoxGeometry(2.6, 0.055, 0.055),
      makeEnergyMaterial(PALETTE.boatBrass, 0.88),
    );
    armX.position.set(0, 10.9, 0);
    addEnergy(armX, 0.88);

    const armZ = new THREE.Mesh(
      new THREE.BoxGeometry(0.055, 0.055, 2.6),
      makeEnergyMaterial(PALETTE.boatBrass, 0.88),
    );
    armZ.position.set(0, 10.9, 0);
    addEnergy(armZ, 0.88);

    // 4 Cardinal brass finial spheres
    for (const [cx, cz] of [[1.35, 0], [-1.35, 0], [0, 1.35], [0, -1.35]]) {
      const finial = new THREE.Mesh(
        new THREE.SphereGeometry(0.11, 8, 8),
        makeEnergyMaterial(PALETTE.sunCore, 0.92),
      );
      finial.position.set(cx, 10.9, cz);
      addEnergy(finial, 0.92);
    }

    // C: Pivoting Golden Feather/Glider Vane (金色风之翼羽箭风向标)
    const vaneGroup = new THREE.Group();
    vaneGroup.name = 'weathervane-feather-arrow';
    vaneGroup.position.set(0, 11.9, 0);
    vaneGroup.userData.isWeathervane = true;

    // Vane central hub
    const vaneHub = new THREE.Mesh(
      new THREE.SphereGeometry(0.18, 10, 10),
      makeEnergyMaterial(PALETTE.boatBrass, 0.95),
    );
    vaneHub.userData.finalBaseOpacity = 0.95;
    vaneHub.layers.enable(LAYER_ENERGY);
    vaneGroup.add(vaneHub);

    // Arrow front shaft & pointer head
    const arrowShaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.038, 0.038, 2.2, 8),
      makeEnergyMaterial(PALETTE.boatBrass, 0.92),
    );
    arrowShaft.rotation.x = Math.PI / 2;
    arrowShaft.position.set(0, 0, 0.1);
    arrowShaft.userData.finalBaseOpacity = 0.92;
    arrowShaft.layers.enable(LAYER_ENERGY);
    vaneGroup.add(arrowShaft);

    const arrowHead = new THREE.Mesh(
      new THREE.ConeGeometry(0.22, 0.72, 8),
      makeEnergyMaterial(PALETTE.sunCore, 0.95),
    );
    arrowHead.rotation.x = Math.PI / 2;
    arrowHead.position.set(0, 0, 1.25);
    arrowHead.userData.finalBaseOpacity = 0.95;
    arrowHead.layers.enable(LAYER_ENERGY);
    vaneGroup.add(arrowHead);

    // Solar diamond on arrowhead
    const arrowDiamond = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.14, 0),
      makeEnergyMaterial(PALETTE.sunFlare, 0.95),
    );
    arrowDiamond.position.set(0, 0, 1.05);
    arrowDiamond.userData.finalBaseOpacity = 0.95;
    arrowDiamond.layers.enable(LAYER_ENERGY);
    vaneGroup.add(arrowDiamond);

    // Tail feather vane (stylized double wings)
    for (const side of [-1, 1]) {
      const featherFin = new THREE.Mesh(
        new THREE.BoxGeometry(0.04, 0.42, 0.95),
        makeEnergyMaterial(PALETTE.sunFlare, 0.88),
      );
      featherFin.rotation.x = 0.18;
      featherFin.rotation.z = side * 0.32;
      featherFin.position.set(side * 0.12, 0.14, -0.82);
      featherFin.userData.finalBaseOpacity = 0.88;
      featherFin.layers.enable(LAYER_ENERGY);
      vaneGroup.add(featherFin);

      const featherInlay = new THREE.Mesh(
        new THREE.BoxGeometry(0.045, 0.24, 0.65),
        makeEnergyMaterial(PALETTE.gliderCanvas, 0.92),
      );
      featherInlay.rotation.x = 0.18;
      featherInlay.rotation.z = side * 0.32;
      featherInlay.position.set(side * 0.13, 0.14, -0.82);
      featherInlay.userData.finalBaseOpacity = 0.92;
      featherInlay.layers.enable(LAYER_ENERGY);
      vaneGroup.add(featherInlay);
    }
    station.add(vaneGroup);

    // D: Spinning Anemometer Rotor (顶部旋转三杯式风速仪)
    const anemometerGroup = new THREE.Group();
    anemometerGroup.name = 'anemometer-rotor';
    anemometerGroup.position.set(0, 13.3, 0);
    anemometerGroup.userData.isAnemometer = true;

    const spireCone = new THREE.Mesh(
      new THREE.ConeGeometry(0.11, 0.48, 8),
      makeEnergyMaterial(PALETTE.sunCore, 0.95),
    );
    spireCone.position.set(0, 0.24, 0);
    spireCone.userData.finalBaseOpacity = 0.95;
    spireCone.layers.enable(LAYER_ENERGY);
    anemometerGroup.add(spireCone);

    for (let c = 0; c < 3; c++) {
      const armAngle = (c / 3) * Math.PI * 2;
      const spokeArm = new THREE.Mesh(
        new THREE.CylinderGeometry(0.024, 0.024, 0.68, 6),
        makeEnergyMaterial(PALETTE.boatBrass, 0.90),
      );
      spokeArm.rotation.z = Math.PI / 2;
      spokeArm.rotation.y = armAngle;
      spokeArm.position.set(Math.cos(armAngle) * 0.34, 0, Math.sin(armAngle) * 0.34);
      spokeArm.userData.finalBaseOpacity = 0.90;
      spokeArm.layers.enable(LAYER_ENERGY);
      anemometerGroup.add(spokeArm);

      // Hemispherical wind cup
      const cup = new THREE.Mesh(
        new THREE.SphereGeometry(0.14, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.5),
        makeEnergyMaterial(PALETTE.sunFlare, 0.92),
      );
      cup.rotation.z = Math.PI / 2;
      cup.rotation.y = armAngle + Math.PI / 2;
      cup.position.set(Math.cos(armAngle) * 0.68, 0, Math.sin(armAngle) * 0.68);
      cup.userData.finalBaseOpacity = 0.92;
      cup.layers.enable(LAYER_ENERGY);
      anemometerGroup.add(cup);
    }
    station.add(anemometerGroup);

    // 4. 3D Swirling Celebration Petals & Solar Sparkle Crystals (漫天花瓣与光尘粒子)
    const petalColors = [
      PALETTE.petalPink,
      PALETTE.gliderCanvas,
      PALETTE.vineGreen,
      PALETTE.sunFlare,
      PALETTE.sunCore,
    ] as const;

    const particleCount = 24;
    for (let i = 0; i < particleCount; i++) {
      const isPetal = i < 14;
      const color = isPetal ? petalColors[i % petalColors.length] : (i % 2 === 0 ? PALETTE.sunCore : PALETTE.sparkle);
      const geom = new THREE.OctahedronGeometry(isPetal ? 0.20 : 0.13, 0);
      if (isPetal) geom.scale(1.0, 0.28, 1.4);

      const particle = new THREE.Mesh(geom, makeEnergyMaterial(color, 0.82));
      particle.userData.finalParticle = i;
      particle.userData.finalBaseOpacity = 0.82;
      addEnergy(particle, 0.82);
    }

    station.traverse((object) => object.layers.enable(LAYER_ENERGY));
    gantry.add(station);
    this.finalStation = station;
  }
}
