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
  type ThermalUpdraftDef,
  type ThermalSample,
  type WindRingDef,
  type WindTunnelDef,
  type WindTunnelSample,
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
    corridorHalfWidth: 16.0,
    gateHalfWidth: 9.0,
    passHalfWidth: 12.5,
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
    corridorHalfWidth: 16.0,
    gateHalfWidth: 9.0,
    passHalfWidth: 12.5,
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
    corridorHalfWidth: 15.5,
    gateHalfWidth: 9.0,
    passHalfWidth: 12.0,
    targetSpeed: 48,
    qualifyFromU: 0.33,
    launchFromU: 0.375,
    launchToU: 0.398,
    turnWarningFromU: 0.397,
    turnWarningToU: 0.447,
    navigation: {
      turn: { fromU: 0.397, toU: 0.447, direction: 'left' },
      postGateRecovery: { handoffMarginM: 28, maxDurationS: 5.5 },
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
    corridorHalfWidth: 16.0,
    gateHalfWidth: 9.5,
    passHalfWidth: 13.0,
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
    corridorHalfWidth: 16.5,
    gateHalfWidth: 9.0,
    passHalfWidth: 12.5,
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
    corridorHalfWidth: 15.5,
    gateHalfWidth: 9.0,
    passHalfWidth: 12.0,
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
    corridorHalfWidth: 15.5,
    gateHalfWidth: 9.0,
    passHalfWidth: 12.0,
    targetSpeed: 50,
    qualifyFromU: 0.865,
    launchFromU: 0.89,
    launchToU: 0.912,
    turnWarningFromU: 0.916,
    turnWarningToU: 0.954,
  },
] as const;

// --------------------------------------------------- thermal updrafts ----

export const THERMAL_UPDRAFTS: readonly ThermalUpdraftDef[] = [
  {
    id: 'updraft-1-cape',
    name: '海岬暖气流柱',
    x: 142,
    z: 445,
    baseY: 0,
    height: 26,
    radius: 15,
    coreRadius: 6.5,
    liftSpeed: 12.5,
  },
  {
    id: 'updraft-2-plateau',
    name: '高原云阶暖气流柱',
    x: 310,
    z: 500,
    baseY: 0,
    height: 28,
    radius: 16,
    coreRadius: 7.0,
    liftSpeed: 13.5,
  },
  {
    id: 'updraft-3-canyon',
    name: '拉普达浮岛金色上升流',
    x: 460,
    z: 360,
    baseY: 0,
    height: 65,
    radius: 20,
    coreRadius: 8.5,
    liftSpeed: 14.0,
  },
  {
    id: 'updraft-4-airtime',
    name: '晴空大直道阳照上升流',
    x: 230,
    z: 160,
    baseY: 0,
    height: 65,
    radius: 20,
    coreRadius: 8.5,
    liftSpeed: 14.5,
  },
  {
    id: 'updraft-5-carousel',
    name: '外海回旋暖气流柱',
    x: 120,
    z: -160,
    baseY: 0,
    height: 26,
    radius: 16,
    coreRadius: 7.0,
    liftSpeed: 12.0,
  },
] as const;

// ------------------------------------------------------- wind tunnels ----

export const WIND_TUNNELS: readonly WindTunnelDef[] = [
  {
    id: 'tunnel-chicane-climb',
    name: '峡谷天梯加速风道',
    targetSpeed: 52,
    boostStrength: 1.25,
    rings: [
      { x: 260, y: 4.8, z: 462, dirX: 0.88, dirY: 0.12, dirZ: 0.46, radius: 7.2 },
      { x: 310, y: 5.2, z: 495, dirX: 0.94, dirY: 0.05, dirZ: -0.34, radius: 7.2 },
      { x: 360, y: 4.8, z: 485, dirX: 0.82, dirY: -0.08, dirZ: -0.57, radius: 7.2 },
    ],
  },
  {
    id: 'tunnel-canyon-pass',
    name: '高空悬廊穿云风道',
    targetSpeed: 54,
    boostStrength: 1.35,
    rings: [
      { x: 480, y: 38.0, z: 410, dirX: 0.42, dirY: 0.05, dirZ: -0.91, radius: 8.2 },
      { x: 505, y: 40.0, z: 340, dirX: 0.05, dirY: 0.02, dirZ: -1.0, radius: 8.2 },
      { x: 475, y: 44.0, z: 260, dirX: -0.55, dirY: 0.0, dirZ: -0.83, radius: 8.2 },
    ],
  },
  {
    id: 'tunnel-jetstream',
    name: '晴空大直道极速喷流风道',
    targetSpeed: 56,
    boostStrength: 1.45,
    rings: [
      { x: 200, y: 5.2, z: 240, dirX: 0.32, dirY: 0.0, dirZ: -0.95, radius: 7.8 },
      { x: 235, y: 5.4, z: 150, dirX: 0.35, dirY: 0.0, dirZ: -0.94, radius: 7.8 },
      { x: 268, y: 5.2, z: 60, dirX: 0.34, dirY: 0.0, dirZ: -0.94, radius: 7.8 },
    ],
  },
  {
    id: 'tunnel-carousel-slingshot',
    name: '外海回旋弹射风环',
    targetSpeed: 54,
    boostStrength: 1.35,
    rings: [
      { x: 260, y: 4.8, z: -100, dirX: -0.62, dirY: 0.0, dirZ: -0.78, radius: 7.5 },
      { x: 190, y: 5.0, z: -180, dirX: -0.92, dirY: 0.0, dirZ: -0.38, radius: 7.5 },
      { x: 100, y: 4.8, z: -170, dirX: -0.85, dirY: 0.0, dirZ: 0.52, radius: 7.5 },
    ],
  },
] as const;

/** Compatibility aliases used by a few deterministic harness helpers. */
export const FLIGHT_ENTRY_U = FLIGHT_ROUTES[0].entryU;
export const FLIGHT_EXIT_U = FLIGHT_ROUTES[0].exitU;
export const FLIGHT_GATE_US = FLIGHT_ROUTES[0].gateUs;
const FLIGHT_CORRIDOR_GRACE = 0.45;
const FLIGHT_CORRIDOR_FAIL = 1.6;
const FLIGHT_CORRIDOR_FAIL_DISTANCE = 32;
const FLIGHT_GATE_BYPASS_U = 4.5 / LAP_LENGTH;
const FLIGHT_ATTEMPT_EARLY_U = 0.018;

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
const _thermalSample: ThermalSample = {
  intensity: 0,
  liftSpeed: 0,
  centerX: 0,
  centerZ: 0,
};
const _windTunnelSample: WindTunnelSample = {
  inside: 0,
  boost: 0,
  dirX: 0,
  dirY: 0,
  dirZ: 1,
  ringPassed: false,
};
const _particlePos = new THREE.Vector3();
const _particleQ = new THREE.Quaternion();
const _particleScale = new THREE.Vector3();
const _particleMat = new THREE.Matrix4();

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
/**
 * Luminescent Sea & Wind Stream Navigation Ribbon (水彩海风涡流微光导流带).
 * Soft, feathered translucent watercolor aura with moving floating chevrons,
 * leaving over 80% of the underlying wave swells, foam, and caustics clear and luminous.
 */
function buildRibbonMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'RacingLine',
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color().setHex(PALETTE.waterMid, THREE.NoColorSpace) },
      uSkyColor: { value: new THREE.Color().setHex(PALETTE.skyMid, THREE.NoColorSpace) },
      uFoamColor: { value: new THREE.Color().setHex(PALETTE.foam, THREE.NoColorSpace) },
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
        // ride the swell gently above the surface
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
      uniform vec3 uSkyColor;
      uniform vec3 uFoamColor;
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

        float a = abs(vSide); // 0.0 at center spine, 1.0 at outer boundary

        // 1. Soft feathered watercolor falloff (no hard edges, zero dark ink borders)
        float lateralAura = 1.0 - smoothstep(0.04, 0.96, a);
        lateralAura = pow(lateralAura, 1.5);

        // 2. Harmonic sea wind & fluid ripple streamline motion
        float wave1 = sin(vS * 0.28 - uTime * 3.8 + vSide * 3.4) * 0.5 + 0.5;
        float wave2 = cos(vS * 0.14 - uTime * 2.1 - vSide * 2.6) * 0.5 + 0.5;
        float streamFlow = mix(wave1, wave2, 0.5);

        // 3. Floating Luminescent Watercolor Chevrons (轻盈微光导流箭头)
        float chevronPeriod = 14.0; // 14 meters per chevron
        float chevronPhase = fract((vS - uTime * 7.2) / chevronPeriod);
        float chevronV = a * 1.6; // V-shape pointing along travel direction
        float chevronDist = abs(chevronPhase - chevronV * 0.16 - 0.12);
        float chevronLine = 1.0 - smoothstep(0.012, 0.056, chevronDist);
        float chevronMask = 1.0 - smoothstep(0.08, 0.52, a);
        float chevrons = chevronLine * chevronMask;

        // 4. Watercolor Color Composition (浅海天青羽化渐变 + 纯净微光)
        vec3 azureAura = mix(uColor, uSkyColor, 0.55);
        vec3 seaWindCol = mix(azureAura, uFoamColor, streamFlow * 0.32);
        vec3 col = mix(seaWindCol, uFoamColor, chevrons * 0.75);

        // 5. Translucent Opacity Veil (0.22 ~ 0.26 peak, 80%+ sea transparency)
        float baseAlpha = lateralAura * (0.07 + streamFlow * 0.07);
        float chevronAlpha = chevrons * 0.12;
        float combinedAlpha = clamp(baseAlpha + chevronAlpha, 0.0, 0.24);

        // Fade out on the wooden launch pier (uLapLength - 34 to uLapLength - 16)
        float pierMask = smoothstep(uLapLength - 34.0, uLapLength - 30.0, vS) * (1.0 - smoothstep(uLapLength - 19.0, uLapLength - 15.0, vS));
        combinedAlpha *= (1.0 - pierMask);

        float localFade = 1.0 - smoothstep(125.0, 170.0, ahead) * 0.32;
        float fade = (vDist < 220.0 ? 1.0 : 0.65) * max(localFade, step(0.001, behind) * step(behind, 12.0));
        float alpha = combinedAlpha * fade * mix(1.0, 0.18, uFinalApproach);

        gl_FragColor = vec4(col, alpha);
      }
    `,
    transparent: true,
    blending: THREE.NormalBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

// ------------------------------------------------ dynamic 3d airflow guidance & god ray shaders ----

/**
 * Layer 1: Ambient Flow Aura Ribbon Shader Material.
 * Ethereal, soft-edged translucent wind mist corridor that wraps the 3D flight trajectory.
 */
function buildAuraRibbonMaterial(def: FlightRouteDefinition, runtime: FlightRouteRuntime): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: `AuraRibbon-${def.id}`,
    uniforms: {
      uTime: { value: 0 },
      uWarn: { value: 0 },
      uReady: { value: 0 },
      uTurn: { value: 0 },
      uRecovery: { value: 0 },
      uRecoveryProgress: { value: runtime.gateFraction },
      uGateF: { value: runtime.gateFraction },
      uFlight: { value: new THREE.Color().setHex(PALETTE.flight, THREE.NoColorSpace) },
      uSkyMid: { value: new THREE.Color().setHex(PALETTE.skyMid, THREE.NoColorSpace) },
      uFoam: { value: new THREE.Color().setHex(PALETTE.foam, THREE.NoColorSpace) },
      uSunFlare: { value: new THREE.Color().setHex(PALETTE.sunFlare, THREE.NoColorSpace) },
      uTurnColor: { value: new THREE.Color().setHex(PALETTE.sunFlare, THREE.NoColorSpace) },
      uWarnColor: { value: new THREE.Color().setHex(PALETTE.uiWarn, THREE.NoColorSpace) },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uRecovery;
      uniform float uGateF;
      varying vec2 vUv;
      varying float vDist;
      ${WAVES_GLSL}
      void main() {
        vUv = uv;
        vec3 p = position;
        float recoveryTail = uRecovery * step(uGateF - 0.003, uv.y);
        p.y = mix(p.y, waveHeight(p.xz, uTime) + 0.18, recoveryTail);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uWarn;
      uniform float uReady;
      uniform float uTurn;
      uniform float uRecovery;
      uniform float uRecoveryProgress;
      uniform float uGateF;
      uniform vec3 uFlight;
      uniform vec3 uSkyMid;
      uniform vec3 uFoam;
      uniform vec3 uSunFlare;
      uniform vec3 uTurnColor;
      uniform vec3 uWarnColor;
      varying vec2 vUv;
      varying float vDist;
      void main() {
        float side = abs(vUv.x - 0.5) * 2.0;
        float lateralAura = 1.0 - smoothstep(0.04, 0.96, side);
        lateralAura = pow(lateralAura, 1.5);

        float wave1 = sin(vUv.y * 36.0 - uTime * 4.0 + vUv.x * 3.1415) * 0.5 + 0.5;
        float wave2 = cos(vUv.y * 18.0 - uTime * 2.0 - vUv.x * 2.2) * 0.5 + 0.5;
        float windBillow = mix(wave1, wave2, 0.5);

        float pulse = sin(uTime * 4.5 - vUv.y * 10.0) * 0.5 + 0.5;
        float readyGlow = uReady * pulse * 0.35;

        vec3 softSkyFlight = mix(uFlight, uSkyMid, 0.48);
        vec3 baseColor = mix(softSkyFlight, uFoam, 0.18 + windBillow * 0.28);
        baseColor = mix(baseColor, uSunFlare, readyGlow);
        baseColor = mix(baseColor, uTurnColor, uTurn * 0.5);
        baseColor = mix(baseColor, uWarnColor, uWarn);

        float alpha = lateralAura * (0.07 + windBillow * 0.05 + readyGlow * 0.08);

        float recoveryTail = uRecovery * step(uGateF - 0.003, vUv.y);
        alpha *= (1.0 - recoveryTail * 0.85);

        float distFade = smoothstep(3.0, 16.0, vDist);
        alpha *= distFade;

        gl_FragColor = vec4(baseColor, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}

/**
 * Layer 2: Core Airflow Streamline Ribbon Shader Material.
 * Dynamic water-sky streamlines and soft floating watercolor chevrons, with 80%+ sea visibility.
 */
function buildCoreRibbonMaterial(def: FlightRouteDefinition, runtime: FlightRouteRuntime): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: `CoreRibbon-${def.id}`,
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
      uSkyMid: { value: new THREE.Color().setHex(PALETTE.skyMid, THREE.NoColorSpace) },
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
      uniform vec3 uSkyMid;
      uniform vec3 uRecoveryColor;
      uniform vec3 uInk;
      uniform vec3 uFoam;
      uniform vec3 uTurnColor;
      uniform vec3 uWarnColor;
      varying vec2 vUv;
      void main() {
        float lateralDist = abs(vUv.x - 0.5) * 2.0;
        float lateralEnvelope = 1.0 - smoothstep(0.04, 0.96, lateralDist);
        lateralEnvelope = pow(lateralEnvelope, 1.5);

        // Harmonic dual-wave streamlines
        float wave = sin(vUv.y * 42.0 - uTime * 4.5) * 0.022;
        float flowA = 1.0 - smoothstep(0.015, 0.040, abs(vUv.x - (0.42 + wave)));
        float flowB = 1.0 - smoothstep(0.015, 0.040, abs(vUv.x - (0.58 - wave)));
        float packetPhase = fract(vUv.y * 11.0 - uTime * 2.1);
        float packet = smoothstep(0.02, 0.18, packetPhase) * (1.0 - smoothstep(0.55, 0.85, packetPhase));
        float flow = max(flowA, flowB) * (0.35 + packet * 0.65);

        // Soft Floating Chevrons (微光水彩导流箭头)
        float chevronPeriod = 0.075;
        float chevronPhase = fract((vUv.y - uTime * 0.14) / chevronPeriod);
        float chevronV = abs(vUv.x - 0.5) * 2.0;
        float chevronDist = abs(chevronPhase - chevronV * 0.22 - 0.10);
        float chevronLine = 1.0 - smoothstep(0.012, 0.055, chevronDist);
        float chevronMask = 1.0 - smoothstep(0.08, 0.52, abs(vUv.x - 0.5));
        float chevrons = chevronLine * chevronMask;

        // Turn zone handling with soft warm amber transition
        float turnIn = smoothstep(uTurnFrom, min(uTurnFrom + 0.025, uTurnTo), vUv.y);
        float turnOut = 1.0 - smoothstep(max(uTurnFrom, uTurnTo - 0.025), uTurnTo, vUv.y);
        float turnZone = uHasTurn * turnIn * turnOut;

        vec3 softFlight = mix(uFlight, uSkyMid, 0.45);
        vec3 azureAir = mix(softFlight, uFoam, 0.20 + flow * 0.35);
        vec3 color = mix(azureAir, uTurnColor, min(0.65, turnZone * 0.55 + uTurn * turnZone * 0.25));
        color = mix(color, uWarnColor, uWarn);
        color = mix(color, uFoam, chevrons * 0.65);

        float ready = uReady * step(0.5, fract(uTime * 4.0));
        float alpha = lateralEnvelope * (0.05 + flow * 0.07 + chevrons * 0.07) + ready * 0.04;
        alpha += turnZone * (0.02 + packet * 0.03);
        alpha = clamp(alpha, 0.0, 0.16);

        // Recovery funnel phase
        float recoveryT = smoothstep(uGateF, 1.0, vUv.y);
        float recoverySide = abs(vUv.x - 0.5);
        float recoveryHalf = mix(0.48, 0.14, recoveryT);
        float recoveryCore = 1.0 - smoothstep(recoveryHalf * 0.18, recoveryHalf * 0.5, recoverySide);
        float recoveryEdge = 1.0 - smoothstep(0.025, 0.055, abs(recoverySide - recoveryHalf));
        float recoveryDash = step(0.46, fract(vUv.y * 18.0 - uTime * 1.8));
        float recoveryAlpha = recoveryCore * 0.18 + recoveryEdge * recoveryDash * 0.55;
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
}

/**
 * Volumetric God Ray (天光光柱) Shader Material.
 * Towering celestial light shaft descending from clouds to the ancient gate.
 */
function buildGodRayMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'GateGodRay',
    uniforms: {
      uTime: { value: 0 },
      uActive: { value: 0 },
      uDistance: { value: 100 },
      uSunColor: { value: new THREE.Color().setHex(PALETTE.sun, THREE.NoColorSpace) },
      uSunFlare: { value: new THREE.Color().setHex(PALETTE.sunFlare, THREE.NoColorSpace) },
      uSkyColor: { value: new THREE.Color().setHex(PALETTE.flight, THREE.NoColorSpace) },
      uCoreColor: { value: new THREE.Color().setHex(PALETTE.foam, THREE.NoColorSpace) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vViewDir;
      void main() {
        vUv = uv;
        vNormal = normalize(normalMatrix * normal);
        vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
        vViewDir = normalize(-mvPos.xyz);
        gl_Position = projectionMatrix * mvPos;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uActive;
      uniform float uDistance;
      uniform vec3 uSunColor;
      uniform vec3 uSunFlare;
      uniform vec3 uSkyColor;
      uniform vec3 uCoreColor;
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vViewDir;

      void main() {
        if (uActive < 0.01) discard;

        float vertFade = smoothstep(0.0, 0.16, vUv.y) * (1.0 - smoothstep(0.74, 1.0, vUv.y));

        float viewDot = abs(dot(normalize(vNormal), normalize(vViewDir)));
        float rim = pow(viewDot, 1.35);

        float beam1 = sin(vUv.x * 16.0 + uTime * 0.55 + vUv.y * 2.2) * 0.5 + 0.5;
        float beam2 = cos(vUv.x * 26.0 - uTime * 0.95 - vUv.y * 4.2) * 0.5 + 0.5;
        float beam3 = sin(vUv.x * 38.0 + uTime * 1.3) * 0.5 + 0.5;
        float sunShafts = mix(beam1, beam2, 0.5) * 0.7 + beam3 * 0.3;
        sunShafts = pow(sunShafts, 1.5);

        float distScale = smoothstep(18.0, 75.0, uDistance) * 0.72 + 0.28;

        float activePulse = 1.0 + (uActive > 0.6 ? 0.25 * sin(uTime * 3.4) : 0.0);
        float brightness = uActive * activePulse * distScale;

        vec3 rayColor = mix(uSkyColor, uSunColor, vUv.y * 0.6 + sunShafts * 0.4);
        rayColor = mix(rayColor, uCoreColor, sunShafts * 0.5 * (uActive > 0.5 ? 1.0 : 0.35));
        rayColor = mix(rayColor, uSunFlare, (1.0 - vUv.y) * 0.3 * (uActive > 0.5 ? 1.0 : 0.2));

        float alpha = vertFade * rim * (0.10 + sunShafts * 0.42) * brightness;
        if (alpha < 0.005) discard;

        gl_FragColor = vec4(rayColor, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
}

/**
 * Gate Passage Resonance Ripple (穿门共鸣冲击波) Shader Material.
 * Multi-layer expanding chromatic shockwave triggered when glider crosses the gate portal.
 */
function buildResonanceRippleMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'GateResonanceRipple',
    uniforms: {
      uProgress: { value: 0 },
      uTime: { value: 0 },
      uColorCore: { value: new THREE.Color().setHex(PALETTE.foam, THREE.NoColorSpace) },
      uColorMid: { value: new THREE.Color().setHex(PALETTE.flight, THREE.NoColorSpace) },
      uColorOuter: { value: new THREE.Color().setHex(PALETTE.sunFlare, THREE.NoColorSpace) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uProgress;
      uniform float uTime;
      uniform vec3 uColorCore;
      uniform vec3 uColorMid;
      uniform vec3 uColorOuter;
      varying vec2 vUv;

      void main() {
        if (uProgress <= 0.0 || uProgress >= 1.0) discard;

        vec2 centered = (vUv - 0.5) * 2.0;
        float r = length(centered);
        if (r > 1.0 || r < 0.02) discard;

        float waveRadius = smoothstep(0.0, 1.0, uProgress);
        float waveDist = abs(r - waveRadius);

        float waveFront = 1.0 - smoothstep(0.0, 0.14, waveDist);

        float innerRipples = sin((r - waveRadius) * 42.0) * 0.5 + 0.5;
        innerRipples *= step(r, waveRadius) * (1.0 - smoothstep(0.0, 0.45, waveRadius - r));

        float life = (1.0 - uProgress) * (1.0 - uProgress);

        vec3 col = mix(uColorMid, uColorCore, waveFront * 0.75);
        col = mix(col, uColorOuter, smoothstep(0.02, 0.12, waveDist) * 0.55);

        float alpha = (waveFront * 0.88 + innerRipples * 0.32) * life;
        if (alpha < 0.005) discard;

        gl_FragColor = vec4(col, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
}

/**
 * Gate Passage Water Surface Ripple (水面共鸣涟漪) Shader Material.
 * Expanding circular watercolor waves on the sea surface underneath the gate.
 */
function buildResonanceWaterMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'GateResonanceWater',
    uniforms: {
      uProgress: { value: 0 },
      uTime: { value: 0 },
      uColor: { value: new THREE.Color().setHex(PALETTE.seaShallow, THREE.NoColorSpace) },
      uFoam: { value: new THREE.Color().setHex(PALETTE.foam, THREE.NoColorSpace) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uProgress;
      uniform float uTime;
      uniform vec3 uColor;
      uniform vec3 uFoam;
      varying vec2 vUv;

      void main() {
        if (uProgress <= 0.0 || uProgress >= 1.0) discard;

        vec2 centered = (vUv - 0.5) * 2.0;
        float r = length(centered);
        if (r > 1.0 || r < 0.02) discard;

        float waveRadius = smoothstep(0.0, 1.0, uProgress);
        float waveDist = abs(r - waveRadius);
        float ring = 1.0 - smoothstep(0.0, 0.16, waveDist);

        float ripple = sin((r - waveRadius) * 36.0 - uTime * 3.0) * 0.5 + 0.5;
        ripple *= step(r, waveRadius) * (1.0 - smoothstep(0.0, 0.40, waveRadius - r));

        float life = (1.0 - uProgress) * (1.0 - uProgress);
        vec3 col = mix(uColor, uFoam, ring * 0.65);
        float alpha = (ring * 0.7 + ripple * 0.3) * life * 0.8;
        if (alpha < 0.005) discard;

        gl_FragColor = vec4(col, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
    toneMapped: false,
  });
}

function makeGodRayGeometry(): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(4.2, 8.8, 110, 28, 1, true);
  geo.translate(0, 55, 0);
  return geo;
}

function buildBeaconAstrolabeVisuals(
  passHalfWidth: number,
  gateHalfHeight: number,
): {
  beaconGroup: THREE.Group;
  beaconRingOuter: THREE.Mesh;
  beaconRingInner: THREE.Mesh;
} {
  const beaconGroup = new THREE.Group();
  beaconGroup.name = 'beacon-astrolabe';
  beaconGroup.position.set(0, gateHalfHeight + 2.75, 0.28);

  const dialMat = new THREE.MeshBasicMaterial({
    color: PALETTE.sunFlare,
    transparent: true,
    opacity: 0.82,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });

  const runeMat = new THREE.MeshBasicMaterial({
    color: PALETTE.flight,
    transparent: true,
    opacity: 0.88,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });

  const outerRingGeo = new THREE.RingGeometry(passHalfWidth * 0.32, passHalfWidth * 0.36, 32);
  const beaconRingOuter = new THREE.Mesh(outerRingGeo, dialMat);
  beaconRingOuter.userData.noOutline = true;

  const notchGeo = new THREE.BoxGeometry(0.08, 0.32, 0.04);
  const notchMesh = new THREE.InstancedMesh(notchGeo, dialMat, 12);
  notchMesh.userData.noOutline = true;
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3(1, 1, 1);
  const rOuter = passHalfWidth * 0.34;
  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2;
    p.set(Math.cos(angle) * rOuter, Math.sin(angle) * rOuter, 0.01);
    q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), angle);
    m.compose(p, q, s);
    notchMesh.setMatrixAt(i, m);
  }
  notchMesh.instanceMatrix.needsUpdate = true;
  beaconRingOuter.add(notchMesh);

  const innerRingGeo = new THREE.RingGeometry(passHalfWidth * 0.18, passHalfWidth * 0.22, 24);
  const beaconRingInner = new THREE.Mesh(innerRingGeo, runeMat);
  beaconRingInner.userData.noOutline = true;

  const pointerGeo = new THREE.BufferGeometry();
  pointerGeo.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0.55, 0,
    -0.12, 0, 0,
    0.12, 0, 0,
  ], 3));
  pointerGeo.computeVertexNormals();
  const pointerMesh = new THREE.InstancedMesh(pointerGeo, dialMat, 4);
  pointerMesh.userData.noOutline = true;
  const rInner = passHalfWidth * 0.20;
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2;
    p.set(Math.cos(angle) * rInner, Math.sin(angle) * rInner, 0.02);
    q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), angle - Math.PI / 2);
    m.compose(p, q, s);
    pointerMesh.setMatrixAt(i, m);
  }
  pointerMesh.instanceMatrix.needsUpdate = true;
  beaconRingInner.add(pointerMesh);

  beaconGroup.add(beaconRingOuter, beaconRingInner);
  beaconGroup.userData.noOutline = true;
  beaconGroup.layers.disable(LAYER_INK);
  beaconGroup.layers.enable(LAYER_ENERGY);
  beaconRingOuter.layers.disable(LAYER_INK);
  beaconRingOuter.layers.enable(LAYER_ENERGY);
  beaconRingInner.layers.disable(LAYER_INK);
  beaconRingInner.layers.enable(LAYER_ENERGY);

  return {
    beaconGroup,
    beaconRingOuter,
    beaconRingInner,
  };
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
  godRayMesh: THREE.Mesh;
  godRayMat: THREE.ShaderMaterial;
  beaconGroup: THREE.Group;
  beaconRingOuter: THREE.Mesh;
  beaconRingInner: THREE.Mesh;
  resonanceMesh: THREE.Mesh;
  resonanceMat: THREE.ShaderMaterial;
  resonanceWaterMesh: THREE.Mesh;
  resonanceWaterMat: THREE.ShaderMaterial;
  resonanceTimer: number;
}

interface FlightRouteVisual {
  runtime: FlightRouteRuntime;
  group: THREE.Group;
  auraRibbonMesh: THREE.Mesh;
  auraRibbon: THREE.ShaderMaterial;
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

// --------------------------------------------------- thermal & wind shaders ----

export interface ThermalUpdraftVisual {
  def: ThermalUpdraftDef;
  group: THREE.Group;
  material: THREE.ShaderMaterial;
  baseDiscMat: THREE.ShaderMaterial;
  baseDisc: THREE.Mesh;
  particles: THREE.InstancedMesh;
}

export interface WindRingVisual {
  def: WindRingDef;
  group: THREE.Group;
  outerRing: THREE.Mesh;
  innerGlow: THREE.Mesh;
  winglets: THREE.Group;
  apertureMat: THREE.ShaderMaterial;
  aperture: THREE.Mesh;
  pulse: number;
}

export interface WindTunnelVisual {
  def: WindTunnelDef;
  group: THREE.Group;
  ringVisuals: WindRingVisual[];
  guideRibbons: THREE.Mesh[];
  guideMat?: THREE.ShaderMaterial;
}

function makeThermalUpdraftMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'ThermalUpdraftToon',
    uniforms: {
      uTime: { value: 0 },
      uColorCore: { value: new THREE.Color(PALETTE.sun) },
      uColorOuter: { value: new THREE.Color(PALETTE.foam) },
      uColorSky: { value: new THREE.Color(PALETTE.skyHorizon) },
      uColorInk: { value: new THREE.Color(PALETTE.ink) },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
    vertexShader: /* glsl */ `
      uniform float uTime;
      varying vec2 vUv;
      varying vec3 vPos;

      void main() {
        vUv = uv;
        vec3 p = position;

        // Gentle organic radial airflow breathing and spiral wobble
        float breathe = sin(uTime * 2.4 + p.y * 0.35) * 0.04;
        float wobbleX = sin(uTime * 1.6 + p.y * 0.18) * 0.32;
        float wobbleZ = cos(uTime * 1.3 + p.y * 0.18) * 0.32;

        p.x = (p.x + wobbleX) * (1.0 + breathe);
        p.z = (p.z + wobbleZ) * (1.0 + breathe);

        vPos = p;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uColorCore;
      uniform vec3 uColorOuter;
      uniform vec3 uColorSky;
      uniform vec3 uColorInk;
      varying vec2 vUv;
      varying vec3 vPos;

      void main() {
        float h = vUv.y;

        // Multi-frequency spiral streamlines ascending up the thermal chimney
        float spiral1 = sin(vUv.x * 12.566 + vUv.y * 7.5 - uTime * 4.2);
        float spiral2 = cos(vUv.x * 18.849 - vUv.y * 11.0 - uTime * 6.5);
        float spiral3 = sin(vUv.x * 6.283 + vUv.y * 3.2 - uTime * 2.1);
        float stream = spiral1 * 0.42 + spiral2 * 0.34 + spiral3 * 0.24;

        // Soft envelope: smooth fade-in from sea level, wide peak at center, soft fade-out at ceiling
        float vFade = smoothstep(0.0, 0.14, h) * (1.0 - smoothstep(0.72, 1.0, h));

        // Streamline crispness (Ghibli cel-wind look)
        float wisp = smoothstep(0.12, 0.88, stream * 0.5 + 0.5);

        // Color gradient: warm golden sunlight core blending into celestial turquoise air
        vec3 col = mix(uColorOuter, uColorCore, clamp(stream * 0.6 + 0.4, 0.0, 1.0));

        // Final alpha with soft watercolor translucency
        float alpha = (0.07 + wisp * 0.24) * vFade;

        gl_FragColor = vec4(col, alpha);
      }
    `,
  });
}

function makeThermalSurfaceSwirlMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'ThermalSurfaceSwirl',
    uniforms: {
      uTime: { value: 0 },
      uColorCore: { value: new THREE.Color(PALETTE.sun) },
      uColorFizz: { value: new THREE.Color(PALETTE.foam) },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uColorCore;
      uniform vec3 uColorFizz;
      varying vec2 vUv;

      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float r = length(p);
        if (r > 1.0) discard;

        float theta = atan(p.y, p.x);
        float spiral = sin(theta * 3.0 - r * 14.0 + uTime * 2.8);
        float ring = smoothstep(0.15, 0.55, r) * (1.0 - smoothstep(0.85, 1.0, r));
        float alpha = ring * (0.15 + 0.35 * smoothstep(-0.2, 0.8, spiral));

        vec3 col = mix(uColorFizz, uColorCore, clamp(spiral * 0.5 + 0.5, 0.0, 1.0));
        gl_FragColor = vec4(col, alpha);
      }
    `,
  });
}

function makeWindRingApertureMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'WindRingAperture',
    uniforms: {
      uTime: { value: 0 },
      uPulse: { value: 0 },
      uColorFlight: { value: new THREE.Color(PALETTE.flight) },
      uColorSun: { value: new THREE.Color(PALETTE.sun) },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uPulse;
      uniform vec3 uColorFlight;
      uniform vec3 uColorSun;
      varying vec2 vUv;

      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float r = length(p);
        if (r > 1.0) discard;

        float theta = atan(p.y, p.x);
        float vortex = sin(theta * 4.0 - r * 8.0 + uTime * 6.5);
        float rim = smoothstep(0.4, 0.95, r);
        float alpha = rim * (0.18 + uPulse * 0.45 + vortex * 0.12);

        vec3 col = mix(uColorFlight, uColorSun, clamp(vortex * 0.5 + 0.5 + uPulse * 0.5, 0.0, 1.0));
        gl_FragColor = vec4(col, alpha);
      }
    `,
  });
}

function makeWindTunnelGuideMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'WindTunnelGuide',
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(PALETTE.flight) },
      uColorSun: { value: new THREE.Color(PALETTE.sun) },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uColor;
      uniform vec3 uColorSun;
      varying vec2 vUv;

      void main() {
        float wave = sin(vUv.x * 20.0 - uTime * 8.0);
        float packet = fract(vUv.x * 4.0 - uTime * 2.2);
        float dash = smoothstep(0.1, 0.4, packet) * (1.0 - smoothstep(0.6, 0.9, packet));
        float edge = smoothstep(0.0, 0.15, vUv.y) * (1.0 - smoothstep(0.85, 1.0, vUv.y));
        float alpha = edge * (0.14 + dash * 0.32);
        vec3 col = mix(uColor, uColorSun, dash * 0.6);
        gl_FragColor = vec4(col, alpha);
      }
    `,
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
  readonly thermalUpdrafts = THERMAL_UPDRAFTS;
  readonly windTunnels = WIND_TUNNELS;
  readonly flightEntryU = FLIGHT_ENTRY_U;
  readonly flightExitU = FLIGHT_EXIT_U;
  readonly flightGateUs = FLIGHT_GATE_US;

  private readonly ribbonMat: THREE.ShaderMaterial;
  private readonly stripMat: THREE.ShaderMaterial;
  private readonly prayerFlagMat: THREE.ShaderMaterial;
  private readonly flightVisuals: FlightRouteVisual[];
  private readonly thermalUpdraftVisuals: ThermalUpdraftVisual[] = [];
  private readonly windTunnelVisuals: WindTunnelVisual[] = [];
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
  private readonly sceneryWindmillRotors: THREE.Object3D[] = [];
  private readonly scenerySeagulls: {
    group: THREE.Group;
    wingLeft: THREE.Object3D;
    wingRight: THREE.Object3D;
    baseX: number;
    baseY: number;
    baseZ: number;
    radius: number;
    speed: number;
    phase: number;
    flapFreq: number;
    verticalAmp: number;
  }[] = [];
  private readonly sceneryLeapingCreatures: {
    group: THREE.Group;
    splashRing: THREE.Mesh;
    startX: number;
    startZ: number;
    endX: number;
    endZ: number;
    peakY: number;
    period: number;
    phase: number;
  }[] = [];
  private scenerySporesPoints: THREE.Points | null = null;
  private scenerySporesPositions: Float32Array | null = null;
  private scenerySporesBase: Float32Array | null = null;
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
    this.buildThermalUpdrafts();
    this.buildWindTunnels();
    this.buildWonderCourseScenery();
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

  sampleThermalUpdraft(pos: THREE.Vector3, out: ThermalSample = _thermalSample): ThermalSample | null {
    let bestIntensity = 0;
    let bestLift = 0;
    let bestCx = 0;
    let bestCz = 0;

    for (let i = 0; i < THERMAL_UPDRAFTS.length; i++) {
      const u = THERMAL_UPDRAFTS[i];
      const dx = pos.x - u.x;
      const dz = pos.z - u.z;
      const d2 = dx * dx + dz * dz;
      const r2 = u.radius * u.radius;
      if (d2 > r2) continue;

      const relY = pos.y - u.baseY;
      if (relY < -2.0 || relY > u.height + 4.0) continue;

      const normDist = Math.sqrt(d2) / u.radius;
      const radF = 1.0 - normDist * normDist;

      let hF = 1.0;
      if (relY < 0.5) hF = THREE.MathUtils.clamp((relY + 2.0) / 2.5, 0.2, 1.0);
      else if (relY > u.height) hF = THREE.MathUtils.clamp(1.0 - (relY - u.height) / 4.0, 0.0, 1.0);

      const intensity = radF * hF;
      if (intensity > bestIntensity) {
        bestIntensity = intensity;
        bestLift = u.liftSpeed;
        bestCx = u.x;
        bestCz = u.z;
      }
    }

    if (bestIntensity <= 0.01) return null;
    out.intensity = bestIntensity;
    out.liftSpeed = bestLift;
    out.centerX = bestCx;
    out.centerZ = bestCz;
    return out;
  }

  sampleWindTunnel(pos: THREE.Vector3, prevPos: THREE.Vector3, out: WindTunnelSample = _windTunnelSample): WindTunnelSample | null {
    let insideFactor = 0;
    let maxBoost = 0;
    let bestDirX = 0;
    let bestDirY = 0;
    let bestDirZ = 1;
    let passedRing = false;

    for (let tIdx = 0; tIdx < WIND_TUNNELS.length; tIdx++) {
      const tunnel = WIND_TUNNELS[tIdx];
      const visual = this.windTunnelVisuals[tIdx];

      for (let rIdx = 0; rIdx < tunnel.rings.length; rIdx++) {
        const ring = tunnel.rings[rIdx];
        const d0 = (prevPos.x - ring.x) * ring.dirX + (prevPos.y - ring.y) * ring.dirY + (prevPos.z - ring.z) * ring.dirZ;
        const d1 = (pos.x - ring.x) * ring.dirX + (pos.y - ring.y) * ring.dirY + (pos.z - ring.z) * ring.dirZ;

        if (d0 <= 0 && d1 > 0) {
          const denom = d0 - d1;
          const f = Math.abs(denom) > 1e-5 ? d0 / denom : 0.5;
          const ix = prevPos.x + (pos.x - prevPos.x) * f;
          const iy = prevPos.y + (pos.y - prevPos.y) * f;
          const iz = prevPos.z + (pos.z - prevPos.z) * f;

          const distSq = (ix - ring.x) ** 2 + (iy - ring.y) ** 2 + (iz - ring.z) ** 2;
          if (distSq <= ring.radius * ring.radius * 1.15) {
            passedRing = true;
            insideFactor = 1.0;
            maxBoost = Math.max(maxBoost, tunnel.boostStrength);
            bestDirX = ring.dirX;
            bestDirY = ring.dirY;
            bestDirZ = ring.dirZ;
            if (visual && visual.ringVisuals[rIdx]) {
              visual.ringVisuals[rIdx].pulse = 1.0;
            }
          }
        }
      }

      for (let rIdx = 0; rIdx < tunnel.rings.length - 1; rIdx++) {
        const r0 = tunnel.rings[rIdx];
        const r1 = tunnel.rings[rIdx + 1];
        const segX = r1.x - r0.x;
        const segY = r1.y - r0.y;
        const segZ = r1.z - r0.z;
        const segLenSq = segX * segX + segY * segY + segZ * segZ;
        if (segLenSq < 1e-4) continue;

        const toPosX = pos.x - r0.x;
        const toPosY = pos.y - r0.y;
        const toPosZ = pos.z - r0.z;

        const proj = THREE.MathUtils.clamp((toPosX * segX + toPosY * segY + toPosZ * segZ) / segLenSq, 0, 1);
        const closeX = r0.x + segX * proj;
        const closeY = r0.y + segY * proj;
        const closeZ = r0.z + segZ * proj;

        const dSq = (pos.x - closeX) ** 2 + (pos.y - closeY) ** 2 + (pos.z - closeZ) ** 2;
        const maxR = Math.max(r0.radius, r1.radius);
        if (dSq <= maxR * maxR) {
          const factor = 1.0 - Math.sqrt(dSq) / maxR;
          if (factor > insideFactor) {
            insideFactor = factor;
            maxBoost = Math.max(maxBoost, tunnel.boostStrength);
            const segLen = Math.sqrt(segLenSq);
            bestDirX = segX / segLen;
            bestDirY = segY / segLen;
            bestDirZ = segZ / segLen;
          }
        }
      }
    }

    if (insideFactor <= 0.02 && !passedRing) return null;
    out.inside = insideFactor;
    out.boost = maxBoost;
    out.dirX = bestDirX;
    out.dirY = bestDirY;
    out.dirZ = bestDirZ;
    out.ringPassed = passedRing;
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
        gate.resonanceTimer = 0;
        gate.resonanceMesh.visible = false;
        gate.resonanceWaterMesh.visible = false;
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

      const insideAttemptSpan = surfaceU >= def.entryU - FLIGHT_ATTEMPT_EARLY_U && surfaceU <= def.exitU + 0.008;
      const crossedChallengeEntry = surfaceU >= def.entryU - 0.002;
      // Wind-stream updraft auto-launch for player so missing the Spacebar window never kills the flow
      if (id === 0 && !flightActive && st.flightRouteState === 'idle' &&
          surfaceU >= def.launchFromU && surfaceU <= def.entryU + 0.014 &&
          _routeSample.distance <= 24) {
        st.flightClearance = Math.max(st.flightClearance, 0.35);
        boat.beginFlightRouteAttempt(routeIndex, st.flightRouteCursor, def.targetSpeed);
        this.flightDebug[id] = 'active';
        this.flightLatched[id] = routeIndex;
        this.flightOffCorridorT[id] = 0;
        this.flightOffCorridorD[id] = 0;
      }

      const nowFlightActive = st.flightPhase !== 'surface';
      if (nowFlightActive && st.flightRouteState === 'idle' && insideAttemptSpan &&
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

      if (!nowFlightActive && st.flightRouteState === 'idle' && insideAttemptSpan &&
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
        if (gate && nowFlightActive) {
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
            const certifiedPhase = st.flightPhase !== 'surface';
            if (!certifiedPhase || crossingClearance < 0.8) {
              this.flightDebug[id] = `late-height:f${routeIndex + 1}:y${crossingClearance.toFixed(2)}`;
              this.failFlight(boat, visual, 'late', gate.u, gateIndex + 1, lateral, lateralLimit);
            } else if (Math.abs(lateral) <= lateralLimit) {
              boat.applyFlightGatePass(gateIndex);
              if (id === 0) {
                gate.pulse = 0.45;
                gate.cleared = true;
                gate.anchor.visible = false;
                gate.resonanceTimer = 0.001;
                gate.resonanceMesh.visible = true;
                gate.resonanceWaterMesh.visible = true;
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
        if (!nowFlightActive) {
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
            gate.resonanceTimer = 0;
            gate.resonanceMesh.visible = false;
            gate.resonanceWaterMesh.visible = false;
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
        if (object.userData.isPennant) {
          const pIndex = Number(object.userData.pennantIndex ?? 0);
          object.rotation.y = Math.sin(t * 3.5 + pIndex * 0.45) * 0.35;
          object.rotation.z = Math.cos(t * 2.8 + pIndex * 0.6) * 0.15;
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
      // Update Layer 1: Aura Ribbon
      visual.auraRibbon.uniforms.uTime.value = this.flightFlowTime;
      visual.auraRibbon.uniforms.uWarn.value = warn;
      visual.auraRibbon.uniforms.uReady.value = upcoming && this.playerFlightReady ? 1 : 0;
      visual.auraRibbon.uniforms.uTurn.value = upcoming && this.flightTurnWarn[0] ? 1 : 0;
      const recovery = this.playerRecoveryRoute === routeIndex ? 1 : visual.recoveryFade > 0 ? visual.recoveryFade / 0.3 : 0;
      visual.auraRibbon.uniforms.uRecovery.value = recovery;
      visual.auraRibbon.uniforms.uRecoveryProgress.value = visual.recoveryProgress;
      if (recovery > 0) visual.auraRibbonMesh.layers.disable(LAYER_ENERGY);
      else visual.auraRibbonMesh.layers.enable(LAYER_ENERGY);

      // Update Layer 2: Core Ribbon
      visual.ribbon.uniforms.uTime.value = this.flightFlowTime;
      visual.ribbon.uniforms.uWarn.value = warn;
      visual.ribbon.uniforms.uReady.value = upcoming && this.playerFlightReady ? 1 : 0;
      visual.ribbon.uniforms.uTurn.value = upcoming && this.flightTurnWarn[0] ? 1 : 0;
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

        const distance = upcoming ? gate.center.distanceTo(this.playerPosition) : 0;
        const far = Math.max(0, Math.min(1, (distance - 70) / 150));
        const smoothFar = far * far * (3 - 2 * far);
        const anchorScale = 1 + smoothFar * 0.75;
        gate.anchor.scale.setScalar(anchorScale);
        if (upcoming) this.playerTargetAnchorScale = anchorScale;
        gate.anchor.rotation.z = this.flightFlowTime * 0.18;
        (gate.anchor.material as THREE.MeshBasicMaterial).opacity =
          0.68 + Math.sin(this.flightFlowTime * 3.4) * 0.12;

        // Volumetric God Ray (天光光柱) update
        const isTargetGate = upcoming && !gate.cleared;
        gate.godRayMat.uniforms.uTime.value = t;
        gate.godRayMat.uniforms.uActive.value = isTargetGate ? 1.0 : (!gate.cleared ? 0.35 : 0.0);
        gate.godRayMat.uniforms.uDistance.value = distance;

        // Astrolabe Landmark Beacon update
        gate.beaconRingOuter.rotation.z = t * 0.28;
        gate.beaconRingInner.rotation.z = -t * 0.45;
        const beaconScale = 1.0 + (isTargetGate ? smoothFar * 0.65 : 0.0);
        gate.beaconGroup.scale.setScalar(beaconScale);
        gate.beaconGroup.visible = !gate.cleared;

        // Gate Passage Resonance Ripple (3D shockwave & water ripple) update
        if (gate.resonanceTimer > 0) {
          gate.resonanceTimer += dt;
          if (gate.resonanceTimer >= 0.85) {
            gate.resonanceTimer = 0;
            gate.resonanceMesh.visible = false;
            gate.resonanceWaterMesh.visible = false;
          } else {
            const prog = gate.resonanceTimer / 0.85;
            gate.resonanceMesh.visible = true;
            gate.resonanceMat.uniforms.uProgress.value = prog;
            gate.resonanceMat.uniforms.uTime.value = t;
            const s = (gate.halfWidth * 2.5) * Math.pow(prog, 0.42);
            gate.resonanceMesh.scale.set(s, s, s);

            gate.resonanceWaterMesh.visible = true;
            gate.resonanceWaterMesh.position.y = surface - gate.center.y + 0.15;
            gate.resonanceWaterMat.uniforms.uProgress.value = prog;
            gate.resonanceWaterMat.uniforms.uTime.value = t;
            const sw = (gate.halfWidth * 3.5) * Math.pow(prog, 0.48);
            gate.resonanceWaterMesh.scale.set(sw, 1, sw);
          }
        } else {
          gate.resonanceMesh.visible = false;
          gate.resonanceWaterMesh.visible = false;
        }

        gate.group.visible = !gate.cleared || gate.pulse > 0.06 || gate.resonanceTimer > 0;
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

    // Update thermal updrafts
    for (let i = 0; i < this.thermalUpdraftVisuals.length; i++) {
      const visual = this.thermalUpdraftVisuals[i];
      visual.material.uniforms.uTime.value = t;
      visual.baseDiscMat.uniforms.uTime.value = t;
      visual.baseDisc.rotation.z = t * 0.75;
      for (let p = 0; p < 10; p++) {
        const pPhase = ((t * (0.06 + p * 0.008) + p * 0.1) % 1.0 + 1.0) % 1.0;
        const pY = pPhase * visual.def.height;
        const pAngle = pPhase * Math.PI * 5.5 + p * 1.6;
        const pRad = (visual.def.coreRadius + Math.sin(pAngle * 2.0) * 1.5) * (0.8 + 0.3 * (pY / visual.def.height));
        const px = Math.cos(pAngle) * pRad;
        const pz = Math.sin(pAngle) * pRad;
        const scale = Math.sin(pPhase * Math.PI) * 0.6 + 0.2;
        _particlePos.set(px, pY, pz);
        _particleScale.set(scale, scale, scale);
        _particleMat.compose(_particlePos, _particleQ, _particleScale);
        visual.particles.setMatrixAt(p, _particleMat);
      }
      visual.particles.instanceMatrix.needsUpdate = true;
    }

    // Update wind tunnels & rings
    for (let i = 0; i < this.windTunnelVisuals.length; i++) {
      const tunnel = this.windTunnelVisuals[i];
      if (tunnel.guideMat) tunnel.guideMat.uniforms.uTime.value = t;
      for (let r = 0; r < tunnel.ringVisuals.length; r++) {
        const ring = tunnel.ringVisuals[r];
        ring.pulse = Math.max(0, ring.pulse - dt * 3.5);
        const s = 1.0 + ring.pulse * 0.24;
        ring.group.scale.set(s, s, s);
        ring.winglets.rotation.z = t * 3.6;
        ring.apertureMat.uniforms.uTime.value = t;
        ring.apertureMat.uniforms.uPulse.value = ring.pulse;
      }
    }

    // Update wonder scenery windmill rotors
    for (let i = 0; i < this.sceneryWindmillRotors.length; i++) {
      this.sceneryWindmillRotors[i].rotation.z = t * 1.8;
    }

    // Update wonder scenery seagulls (flapping, banking, circling over haven)
    for (let i = 0; i < this.scenerySeagulls.length; i++) {
      const g = this.scenerySeagulls[i];
      const angle = t * g.speed + g.phase;
      const x = g.baseX + Math.cos(angle) * g.radius;
      const z = g.baseZ + Math.sin(angle) * g.radius;
      const y = g.baseY + Math.sin(t * 1.4 + g.phase) * g.verticalAmp;
      g.group.position.set(x, y, z);
      g.group.rotation.y = -angle + Math.PI / 2;
      g.group.rotation.z = -0.22;
      const wingFlap = Math.sin(t * g.flapFreq + g.phase) * 0.48;
      g.wingLeft.rotation.z = wingFlap;
      g.wingRight.rotation.z = -wingFlap;
    }

    // Update wonder scenery leaping dolphins & flying fish
    for (let i = 0; i < this.sceneryLeapingCreatures.length; i++) {
      const c = this.sceneryLeapingCreatures[i];
      const cycle = ((t / c.period + c.phase) % 1.0 + 1.0) % 1.0;
      if (cycle < 0.45) {
        c.group.visible = false;
        c.splashRing.visible = false;
      } else {
        const tau = (cycle - 0.45) / 0.55;
        const x = c.startX + (c.endX - c.startX) * tau;
        const z = c.startZ + (c.endZ - c.startZ) * tau;
        const y = Math.sin(tau * Math.PI) * c.peakY;
        c.group.position.set(x, y, z);
        const yaw = Math.atan2(c.endX - c.startX, c.endZ - c.startZ);
        const pitch = Math.atan2(Math.cos(tau * Math.PI) * c.peakY * 2.8, Math.hypot(c.endX - c.startX, c.endZ - c.startZ));
        c.group.rotation.set(pitch, yaw, 0, 'YXZ');
        c.group.visible = true;

        if (tau < 0.18 || tau > 0.82) {
          const isEntry = tau < 0.18;
          const sTau = isEntry ? tau / 0.18 : (1.0 - tau) / 0.18;
          c.splashRing.position.set(isEntry ? c.startX : c.endX, 0.05, isEntry ? c.startZ : c.endZ);
          const rScale = 0.5 + sTau * 1.8;
          c.splashRing.scale.set(rScale, rScale, rScale);
          (c.splashRing.material as THREE.MeshBasicMaterial).opacity = (1.0 - sTau) * 0.75;
          c.splashRing.visible = true;
        } else {
          c.splashRing.visible = false;
        }
      }
    }

    // Update wonder scenery dandelion spores & grass clippings
    if (this.scenerySporesPoints && this.scenerySporesPositions && this.scenerySporesBase) {
      const pos = this.scenerySporesPositions;
      const base = this.scenerySporesBase;
      const count = pos.length / 3;
      for (let i = 0; i < count; i++) {
        const o = i * 3;
        pos[o] = base[o] + Math.sin(t * 1.2 + i * 0.4) * 2.2;
        pos[o + 1] = base[o + 1] + Math.cos(t * 0.9 + i * 0.7) * 0.8;
        pos[o + 2] = base[o + 2] + Math.sin(t * 0.7 + i * 0.3) * 1.8;
      }
      (this.scenerySporesPoints.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
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
    const HALF_W_AURA = HALF_W * 1.35;
    const pos = new Float32Array((SEG + 1) * 2 * 3);
    const posAura = new Float32Array((SEG + 1) * 2 * 3);
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
      // Core ribbon (elevation +0.07)
      pos[o] = p.x + rx * HALF_W;
      pos[o + 1] = p.y + 0.07;
      pos[o + 2] = p.z + rz * HALF_W;
      pos[o + 3] = p.x - rx * HALF_W;
      pos[o + 4] = p.y + 0.07;
      pos[o + 5] = p.z - rz * HALF_W;

      // Aura ribbon (elevation +0.02, wider)
      posAura[o] = p.x + rx * HALF_W_AURA;
      posAura[o + 1] = p.y + 0.02;
      posAura[o + 2] = p.z + rz * HALF_W_AURA;
      posAura[o + 3] = p.x - rx * HALF_W_AURA;
      posAura[o + 4] = p.y + 0.02;
      posAura[o + 5] = p.z - rz * HALF_W_AURA;

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

    // Layer 1: Ambient Flow Aura Ribbon
    const auraRibbonGeo = new THREE.BufferGeometry();
    auraRibbonGeo.setAttribute('position', new THREE.BufferAttribute(posAura, 3));
    auraRibbonGeo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    auraRibbonGeo.setIndex(new THREE.BufferAttribute(idx, 1));
    const auraRibbonMat = buildAuraRibbonMaterial(def, runtime);
    const auraRibbonMesh = new THREE.Mesh(auraRibbonGeo, auraRibbonMat);
    auraRibbonMesh.name = `${def.id}-aura-ribbon`;
    auraRibbonMesh.renderOrder = 2;
    auraRibbonMesh.userData.noOutline = true;
    auraRibbonMesh.layers.disable(LAYER_INK);
    auraRibbonMesh.layers.enable(LAYER_ENERGY);
    routeGroup.add(auraRibbonMesh);

    // Layer 2: Core Airflow Streamline Ribbon
    const ribbonGeo = new THREE.BufferGeometry();
    ribbonGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    ribbonGeo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    ribbonGeo.setIndex(new THREE.BufferAttribute(idx, 1));
    const ribbonMat = buildCoreRibbonMaterial(def, runtime);
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
      const verticalInk = makeVerticalChevronGeometry();
      const verticalFill = makeVerticalChevronGeometry(0.055);
      const mastGeometry = new THREE.CylinderGeometry(0.08, 0.12, 1, 6);
      const mastCollarGeometry = new THREE.CylinderGeometry(0.13, 0.13, 0.12, 8);
      const buoyGeometry = new THREE.CylinderGeometry(0.38, 0.52, 0.52, 8);
      const buoyBandGeometry = new THREE.CylinderGeometry(0.53, 0.53, 0.08, 8);
      const boardGeometry = new THREE.BoxGeometry(1.65, 1.3, 0.09);
      const bracketGeometry = new THREE.BoxGeometry(1.68, 0.09, 0.11);
      const braceGeometry = new THREE.BoxGeometry(0.1, 0.85, 0.06);
      const foamGeometry = makeFoamRingGeometry();

      const mastMaterial = new THREE.MeshBasicMaterial({ color: PALETTE.boatWoodDark, toneMapped: false });
      const woodMaterial = new THREE.MeshBasicMaterial({ color: PALETTE.boatWood, toneMapped: false });
      const brassMaterial = new THREE.MeshBasicMaterial({ color: PALETTE.boatBrass, toneMapped: false });
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
        buoy.position.y = 0.26;
        const brassBand = new THREE.Mesh(buoyBandGeometry, brassMaterial);
        brassBand.position.y = 0.26;
        const foam = new THREE.Mesh(foamGeometry, foamMaterial);
        foam.position.y = 0.46;
        foam.scale.setScalar(0.42);
        const mastHeight = Math.max(3.8, p.y + 1.05);
        const mast = new THREE.Mesh(mastGeometry, mastMaterial);
        mast.position.y = mastHeight * 0.5;
        mast.scale.y = mastHeight;
        const brassCollar = new THREE.Mesh(mastCollarGeometry, brassMaterial);
        brassCollar.position.y = mastHeight - 0.7;

        const board = new THREE.Mesh(boardGeometry, woodMaterial);
        board.position.set(0, mastHeight, 0);
        const topBracket = new THREE.Mesh(bracketGeometry, brassMaterial);
        topBracket.position.set(0, mastHeight + 0.6, 0);
        const btmBracket = new THREE.Mesh(bracketGeometry, brassMaterial);
        btmBracket.position.set(0, mastHeight - 0.6, 0);
        const crossBrace = new THREE.Mesh(braceGeometry, mastMaterial);
        crossBrace.position.set(0, mastHeight, -0.06);

        // Front face (+Z)
        const signInk = new THREE.Mesh(verticalInk, backingMaterial);
        signInk.position.set(0, mastHeight, 0.05);
        signInk.scale.setScalar(1.05);
        const sign = new THREE.Mesh(verticalFill, turnChevronFill);
        sign.position.set(0, mastHeight, 0.056);
        sign.scale.setScalar(0.76);
        sign.renderOrder = 6;

        // Back face (-Z) for double-sided readability
        const signInkBack = new THREE.Mesh(verticalInk, backingMaterial);
        signInkBack.position.set(0, mastHeight, -0.05);
        signInkBack.rotation.y = Math.PI;
        signInkBack.scale.setScalar(1.05);
        const signBack = new THREE.Mesh(verticalFill, turnChevronFill);
        signBack.position.set(0, mastHeight, -0.056);
        signBack.rotation.y = Math.PI;
        signBack.scale.setScalar(0.76);
        signBack.renderOrder = 6;

        support.add(
          buoy, brassBand, foam, mast, brassCollar,
          board, topBracket, btmBracket, crossBrace,
          signInk, sign, signInkBack, signBack,
        );
        turnChevronGroup.add(support);
        const yaw = Math.atan2(-t.x, -t.z) + (turn.direction === 'left' ? Math.PI : 0);
        this.floaters.push({
          obj: support,
          x: support.position.x,
          z: support.position.z,
          yawQ: new THREE.Quaternion().setFromAxisAngle(UP, yaw),
        });
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

      // Volumetric God Ray (天光光柱)
      const godRayGeo = makeGodRayGeometry();
      const godRayMat = buildGodRayMaterial();
      const godRayMesh = new THREE.Mesh(godRayGeo, godRayMat);
      godRayMesh.name = `${def.id}-gate-${i + 1}-godray`;
      godRayMesh.position.set(0, gateHalfHeight + 0.5, 0);
      godRayMesh.renderOrder = 2;
      godRayMesh.userData.noOutline = true;
      godRayMesh.layers.disable(LAYER_INK);
      godRayMesh.layers.enable(LAYER_ENERGY);

      // Astrolabe Landmark Beacon
      const { beaconGroup, beaconRingOuter, beaconRingInner } = buildBeaconAstrolabeVisuals(
        def.passHalfWidth,
        gateHalfHeight,
      );
      beaconGroup.name = `${def.id}-gate-${i + 1}-beacon`;

      // Gate Passage Resonance Ripple (3D Ring Shockwave)
      const resonanceMat = buildResonanceRippleMaterial();
      const resonanceMesh = new THREE.Mesh(new THREE.RingGeometry(0.1, 1.0, 48), resonanceMat);
      resonanceMesh.name = `${def.id}-gate-${i + 1}-resonance`;
      resonanceMesh.position.set(0, 0, 0.12);
      resonanceMesh.visible = false;
      resonanceMesh.userData.noOutline = true;
      resonanceMesh.renderOrder = 7;
      resonanceMesh.layers.disable(LAYER_INK);
      resonanceMesh.layers.enable(LAYER_ENERGY);

      // Gate Passage Water Surface Ripple
      const resonanceWaterMat = buildResonanceWaterMaterial();
      const resonanceWaterMesh = new THREE.Mesh(new THREE.RingGeometry(0.1, 1.0, 48), resonanceWaterMat);
      resonanceWaterMesh.name = `${def.id}-gate-${i + 1}-resonance-water`;
      resonanceWaterMesh.rotation.x = -Math.PI / 2;
      resonanceWaterMesh.position.set(0, -center.y + 0.15, 0);
      resonanceWaterMesh.visible = false;
      resonanceWaterMesh.userData.noOutline = true;
      resonanceWaterMesh.renderOrder = 7;
      resonanceWaterMesh.layers.disable(LAYER_INK);
      resonanceWaterMesh.layers.enable(LAYER_ENERGY);

      gateGroup.add(surfaceLock, lockBeam, anchor, godRayMesh, beaconGroup, resonanceMesh, resonanceWaterMesh);

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
      godRayMesh.layers.disable(LAYER_INK);
      godRayMesh.layers.enable(LAYER_ENERGY);
      beaconRingOuter.layers.disable(LAYER_INK);
      beaconRingOuter.layers.enable(LAYER_ENERGY);
      beaconRingInner.layers.disable(LAYER_INK);
      beaconRingInner.layers.enable(LAYER_ENERGY);
      resonanceMesh.layers.disable(LAYER_INK);
      resonanceMesh.layers.enable(LAYER_ENERGY);
      resonanceWaterMesh.layers.disable(LAYER_INK);
      resonanceWaterMesh.layers.enable(LAYER_ENERGY);

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
        godRayMesh,
        godRayMat,
        beaconGroup,
        beaconRingOuter,
        beaconRingInner,
        resonanceMesh,
        resonanceMat,
        resonanceWaterMesh,
        resonanceWaterMat,
        resonanceTimer: 0,
      });
    }

    return {
      runtime,
      group: routeGroup,
      auraRibbonMesh,
      auraRibbon: auraRibbonMat,
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
   * 70-meter Sea-Sky Giant Triumphal Arch & Golden Weathervane finale landmark (70米海天巨拱与黄金太阳风向标终点盛典).
   * Dormant until all seven routes are cleared, then awakens with monumental ivory & brass triumphal archway,
   * radiant golden sunbeams, suspended 5-color prayer pennants, a pivoting brass feather vane, spinning anemometer wind cups,
   * and swirling celebration petals.
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

    // 1. 70-meter Monumental Ivory Chalk Stone & Brass Triumphal Arch Pillars (70米海天巨拱立柱)
    const archSpan = 35.0; // -35m to +35m = 70m total span
    for (const side of [-1, 1]) {
      // Main monumental pillar tower (70m span base)
      const pillarBase = new THREE.Mesh(
        new THREE.CylinderGeometry(2.4, 3.2, 5.0, 16),
        makeEnergyMaterial(PALETTE.boatBrass, 0.92),
      );
      pillarBase.position.set(side * archSpan, 2.5, 0);
      addEnergy(pillarBase, 0.92);

      const pillarCol = new THREE.Mesh(
        new THREE.CylinderGeometry(1.6, 2.0, 18.0, 16),
        makeEnergyMaterial(PALETTE.stoneAncient, 0.88),
      );
      pillarCol.position.set(side * archSpan, 12.0, 0);
      addEnergy(pillarCol, 0.88);

      const pillarCapital = new THREE.Mesh(
        new THREE.BoxGeometry(4.2, 1.8, 4.2),
        makeEnergyMaterial(PALETTE.boatBrass, 0.94),
      );
      pillarCapital.position.set(side * archSpan, 21.0, 0);
      addEnergy(pillarCapital, 0.94);

      // Flanking solar energy beacons
      const glowGeo = new THREE.CylinderGeometry(1.4, 2.2, 24.0, 12, 1, true);
      const glow = new THREE.Mesh(glowGeo, makeEnergyMaterial(PALETTE.sunFlare, 0.32));
      glow.position.set(side * archSpan, 12.0, 0);
      addEnergy(glow, 0.32);

      const coreGeo = new THREE.CylinderGeometry(0.45, 0.8, 22.0, 12, 1, true);
      const core = new THREE.Mesh(coreGeo, makeEnergyMaterial(PALETTE.sunCore, 0.92));
      core.position.set(side * archSpan, 12.0, 0);
      addEnergy(core, 0.92);

      // Inner channel light columns
      const innerGlow = new THREE.Mesh(
        new THREE.CylinderGeometry(0.85, 1.25, 14.0, 12, 1, true),
        makeEnergyMaterial(PALETTE.sunFlare, 0.28),
      );
      innerGlow.position.set(side * 7.5, 7.0, 0);
      addEnergy(innerGlow, 0.28);
    }

    // 2. 70-meter Sea-Sky Monumental Arch Span (70米海天巨拱天桥与太阳神拱)
    const archSegments = 24;
    for (let s = 0; s < archSegments; s++) {
      const u1 = (s / archSegments) * Math.PI;
      const u2 = ((s + 1) / archSegments) * Math.PI;
      const x1 = -Math.cos(u1) * archSpan;
      const y1 = 20.0 + Math.sin(u1) * 7.5;
      const x2 = -Math.cos(u2) * archSpan;
      const y2 = 20.0 + Math.sin(u2) * 7.5;
      const mx = (x1 + x2) * 0.5;
      const my = (y1 + y2) * 0.5;
      const len = Math.hypot(x2 - x1, y2 - y1);
      const angle = Math.atan2(y2 - y1, x2 - x1);

      const archSegment = new THREE.Mesh(
        new THREE.BoxGeometry(len * 1.05, 1.2, 2.8),
        makeEnergyMaterial(PALETTE.stoneAncient, 0.85),
      );
      archSegment.position.set(mx, my, 0);
      archSegment.rotation.z = angle;
      addEnergy(archSegment, 0.85);

      const goldTrim = new THREE.Mesh(
        new THREE.BoxGeometry(len * 1.05, 0.25, 3.1),
        makeEnergyMaterial(PALETTE.sunFlare, 0.92),
      );
      goldTrim.position.set(mx, my + 0.65, 0);
      goldTrim.rotation.z = angle;
      addEnergy(goldTrim, 0.92);
    }

    // 3. Suspended 5-Color Prayer Pennants across 70m Span (祈风五彩流苏彩旗阵)
    const pennantColors = [
      PALETTE.sunCore,
      PALETTE.petalPink,
      PALETTE.seaShallow,
      PALETTE.vineGreen,
      PALETTE.gliderCanvas,
    ] as const;

    const pennantCount = 36;
    for (let p = 0; p < pennantCount; p++) {
      const frac = (p + 0.5) / pennantCount;
      const px = -archSpan * 0.92 + frac * archSpan * 1.84;
      const catenaryDrop = Math.sin(frac * Math.PI) * 5.2;
      const py = 23.5 - catenaryDrop;
      const color = pennantColors[p % pennantColors.length];

      const flagMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(1.2, 1.8),
        makeEnergyMaterial(color, 0.88),
      );
      flagMesh.position.set(px, py - 0.9, 0);
      flagMesh.userData.isPennant = true;
      flagMesh.userData.pennantIndex = p;
      addEnergy(flagMesh, 0.88);
    }

    // 4. Overhead Solar Crown & Auroral Arch Beam at Apex (中央太阳日轮与能量横梁)
    const crown = new THREE.Mesh(
      new THREE.TorusGeometry(7.2, 0.28, 8, 48),
      makeEnergyMaterial(PALETTE.sunCore, 0.82),
    );
    crown.position.y = 23.5;
    crown.scale.set(1.28, 0.72, 1);
    addEnergy(crown, 0.82);

    const crownAura = new THREE.Mesh(
      new THREE.TorusGeometry(7.8, 0.55, 8, 48),
      makeEnergyMaterial(PALETTE.sunFlare, 0.32),
    );
    crownAura.position.y = 23.5;
    crownAura.scale.set(1.28, 0.72, 1);
    addEnergy(crownAura, 0.32);

    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(16.5, 0.28, 0.35),
      makeEnergyMaterial(PALETTE.sunFlare, 0.72),
    );
    beam.position.y = 24.2;
    addEnergy(beam, 0.72);

    // 5. Central Golden Weathervane & Anemometer Assembly (金色风向标与风速仪)
    // A: Brass Base Pedestal & Spindle Mast
    const basePedestal = new THREE.Mesh(
      new THREE.CylinderGeometry(0.42, 0.62, 0.65, 12),
      makeEnergyMaterial(PALETTE.boatBrass, 0.94),
    );
    basePedestal.position.set(0, 24.6, 0);
    addEnergy(basePedestal, 0.94);

    const spindleMast = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.12, 4.2, 10),
      makeEnergyMaterial(PALETTE.boatBrass, 0.96),
    );
    spindleMast.position.set(0, 26.8, 0);
    addEnergy(spindleMast, 0.96);

    // Turned collar beads
    for (const collarY of [25.2, 26.2, 27.8]) {
      const collar = new THREE.Mesh(
        new THREE.TorusGeometry(0.24, 0.065, 6, 16),
        makeEnergyMaterial(PALETTE.sunCore, 0.90),
      );
      collar.rotation.x = Math.PI / 2;
      collar.position.set(0, collarY, 0);
      addEnergy(collar, 0.90);
    }

    // B: 4-Way Cardinal Compass Arms (十字方位罗盘翼臂)
    const armX = new THREE.Mesh(
      new THREE.BoxGeometry(3.6, 0.075, 0.075),
      makeEnergyMaterial(PALETTE.boatBrass, 0.90),
    );
    armX.position.set(0, 25.8, 0);
    addEnergy(armX, 0.90);

    const armZ = new THREE.Mesh(
      new THREE.BoxGeometry(0.075, 0.075, 3.6),
      makeEnergyMaterial(PALETTE.boatBrass, 0.90),
    );
    armZ.position.set(0, 25.8, 0);
    addEnergy(armZ, 0.90);

    // 4 Cardinal brass finial spheres
    for (const [cx, cz] of [[1.85, 0], [-1.85, 0], [0, 1.85], [0, -1.85]]) {
      const finial = new THREE.Mesh(
        new THREE.SphereGeometry(0.16, 8, 8),
        makeEnergyMaterial(PALETTE.sunCore, 0.94),
      );
      finial.position.set(cx, 25.8, cz);
      addEnergy(finial, 0.94);
    }

    // C: Pivoting Golden Feather/Glider Vane (金色风之翼羽箭风向标)
    const vaneGroup = new THREE.Group();
    vaneGroup.name = 'weathervane-feather-arrow';
    vaneGroup.position.set(0, 27.2, 0);
    vaneGroup.userData.isWeathervane = true;

    // Vane central hub
    const vaneHub = new THREE.Mesh(
      new THREE.SphereGeometry(0.26, 10, 10),
      makeEnergyMaterial(PALETTE.boatBrass, 0.96),
    );
    vaneHub.userData.finalBaseOpacity = 0.96;
    vaneHub.layers.enable(LAYER_ENERGY);
    vaneGroup.add(vaneHub);

    // Arrow front shaft & pointer head
    const arrowShaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.052, 0.052, 3.0, 8),
      makeEnergyMaterial(PALETTE.boatBrass, 0.94),
    );
    arrowShaft.rotation.x = Math.PI / 2;
    arrowShaft.position.set(0, 0, 0.2);
    arrowShaft.userData.finalBaseOpacity = 0.94;
    arrowShaft.layers.enable(LAYER_ENERGY);
    vaneGroup.add(arrowShaft);

    const arrowHead = new THREE.Mesh(
      new THREE.ConeGeometry(0.32, 1.0, 8),
      makeEnergyMaterial(PALETTE.sunCore, 0.96),
    );
    arrowHead.rotation.x = Math.PI / 2;
    arrowHead.position.set(0, 0, 1.75);
    arrowHead.userData.finalBaseOpacity = 0.96;
    arrowHead.layers.enable(LAYER_ENERGY);
    vaneGroup.add(arrowHead);

    // Solar diamond on arrowhead
    const arrowDiamond = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.20, 0),
      makeEnergyMaterial(PALETTE.sunFlare, 0.96),
    );
    arrowDiamond.position.set(0, 0, 1.45);
    arrowDiamond.userData.finalBaseOpacity = 0.96;
    arrowDiamond.layers.enable(LAYER_ENERGY);
    vaneGroup.add(arrowDiamond);

    // Tail feather vane (stylized double wings)
    for (const side of [-1, 1]) {
      const featherFin = new THREE.Mesh(
        new THREE.BoxGeometry(0.05, 0.62, 1.35),
        makeEnergyMaterial(PALETTE.sunFlare, 0.90),
      );
      featherFin.rotation.x = 0.18;
      featherFin.rotation.z = side * 0.32;
      featherFin.position.set(side * 0.16, 0.22, -1.15);
      featherFin.userData.finalBaseOpacity = 0.90;
      featherFin.layers.enable(LAYER_ENERGY);
      vaneGroup.add(featherFin);

      const featherInlay = new THREE.Mesh(
        new THREE.BoxGeometry(0.06, 0.36, 0.95),
        makeEnergyMaterial(PALETTE.gliderCanvas, 0.94),
      );
      featherInlay.rotation.x = 0.18;
      featherInlay.rotation.z = side * 0.32;
      featherInlay.position.set(side * 0.17, 0.22, -1.15);
      featherInlay.userData.finalBaseOpacity = 0.94;
      featherInlay.layers.enable(LAYER_ENERGY);
      vaneGroup.add(featherInlay);
    }
    station.add(vaneGroup);

    // D: Spinning Anemometer Rotor (顶部旋转三杯式风速仪)
    const anemometerGroup = new THREE.Group();
    anemometerGroup.name = 'anemometer-rotor';
    anemometerGroup.position.set(0, 29.2, 0);
    anemometerGroup.userData.isAnemometer = true;

    const spireCone = new THREE.Mesh(
      new THREE.ConeGeometry(0.16, 0.68, 8),
      makeEnergyMaterial(PALETTE.sunCore, 0.96),
    );
    spireCone.position.set(0, 0.34, 0);
    spireCone.userData.finalBaseOpacity = 0.96;
    spireCone.layers.enable(LAYER_ENERGY);
    anemometerGroup.add(spireCone);

    for (let c = 0; c < 3; c++) {
      const armAngle = (c / 3) * Math.PI * 2;
      const spokeArm = new THREE.Mesh(
        new THREE.CylinderGeometry(0.034, 0.034, 0.95, 6),
        makeEnergyMaterial(PALETTE.boatBrass, 0.92),
      );
      spokeArm.rotation.z = Math.PI / 2;
      spokeArm.rotation.y = armAngle;
      spokeArm.position.set(Math.cos(armAngle) * 0.48, 0, Math.sin(armAngle) * 0.48);
      spokeArm.userData.finalBaseOpacity = 0.92;
      spokeArm.layers.enable(LAYER_ENERGY);
      anemometerGroup.add(spokeArm);

      // Hemispherical wind cup
      const cup = new THREE.Mesh(
        new THREE.SphereGeometry(0.20, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.5),
        makeEnergyMaterial(PALETTE.sunFlare, 0.94),
      );
      cup.rotation.z = Math.PI / 2;
      cup.rotation.y = armAngle + Math.PI / 2;
      cup.position.set(Math.cos(armAngle) * 0.95, 0, Math.sin(armAngle) * 0.95);
      cup.userData.finalBaseOpacity = 0.94;
      cup.layers.enable(LAYER_ENERGY);
      anemometerGroup.add(cup);
    }
    station.add(anemometerGroup);

    // 6. 3D Swirling Celebration Petals & Solar Sparkle Crystals (漫天花瓣与光尘粒子)
    const petalColors = [
      PALETTE.petalPink,
      PALETTE.gliderCanvas,
      PALETTE.vineGreen,
      PALETTE.sunFlare,
      PALETTE.sunCore,
    ] as const;

    const particleCount = 36;
    for (let i = 0; i < particleCount; i++) {
      const isPetal = i < 22;
      const color = isPetal ? petalColors[i % petalColors.length] : (i % 2 === 0 ? PALETTE.sunCore : PALETTE.sparkle);
      const geom = new THREE.OctahedronGeometry(isPetal ? 0.28 : 0.18, 0);
      if (isPetal) geom.scale(1.0, 0.28, 1.4);

      const particle = new THREE.Mesh(geom, makeEnergyMaterial(color, 0.85));
      particle.userData.finalParticle = i;
      particle.userData.finalBaseOpacity = 0.85;
      addEnergy(particle, 0.85);
    }

    station.traverse((object) => object.layers.enable(LAYER_ENERGY));
    gantry.add(station);
    this.finalStation = station;
  }

  private buildThermalUpdrafts(): void {
    const updraftMat = makeThermalUpdraftMaterial();
    const swirlMat = makeThermalSurfaceSwirlMaterial();
    const particleGeo = new THREE.OctahedronGeometry(0.22, 0);
    const particleMat = createToonMaterial({
      color: PALETTE.sun,
      emissive: PALETTE.sun,
      emissiveIntensity: 0.75,
    });

    for (const def of THERMAL_UPDRAFTS) {
      const group = new THREE.Group();
      group.name = `updraft-${def.id}`;
      group.position.set(def.x, def.baseY, def.z);

      // 1. Updraft ascending funnel cylinder
      const cylGeo = new THREE.CylinderGeometry(
        def.radius * 1.15,
        def.radius * 0.92,
        def.height,
        28,
        16,
        true,
      );
      cylGeo.translate(0, def.height * 0.5, 0);
      const cylMesh = new THREE.Mesh(cylGeo, updraftMat);
      cylMesh.userData.noOutline = true;
      cylMesh.layers.enable(LAYER_ENERGY);
      group.add(cylMesh);

      // 2. Base surface water swirl disc
      const discGeo = new THREE.PlaneGeometry(def.radius * 2.2, def.radius * 2.2);
      discGeo.rotateX(-Math.PI / 2);
      const baseDisc = new THREE.Mesh(discGeo, swirlMat);
      baseDisc.position.y = 0.08;
      baseDisc.userData.noOutline = true;
      baseDisc.layers.enable(LAYER_ENERGY);
      group.add(baseDisc);

      // 3. Ascending warm pollen / sun sparkle particle motes
      const particles = new THREE.InstancedMesh(particleGeo, particleMat, 10);
      particles.userData.noOutline = true;
      particles.layers.enable(LAYER_ENERGY);
      group.add(particles);

      this.object.add(group);
      this.thermalUpdraftVisuals.push({
        def,
        group,
        material: updraftMat,
        baseDiscMat: swirlMat,
        baseDisc,
        particles,
      });
    }
  }

  private buildWindTunnels(): void {
    const apertureMat = makeWindRingApertureMaterial();
    const guideMat = makeWindTunnelGuideMaterial();
    const outerRingMat = createToonMaterial({
      color: PALETTE.ink,
      emissive: PALETTE.hullPlayer,
      emissiveIntensity: 0.45,
    });
    const innerGlowMat = createToonMaterial({
      color: PALETTE.flight,
      emissive: PALETTE.flight,
      emissiveIntensity: 0.85,
    });
    const wingletMat = createToonMaterial({
      color: PALETTE.boatBrass,
      emissive: PALETTE.boatBrass,
      emissiveIntensity: 0.35,
    });

    for (const def of WIND_TUNNELS) {
      const group = new THREE.Group();
      group.name = `tunnel-${def.id}`;
      const ringVisuals: WindRingVisual[] = [];
      const guideRibbons: THREE.Mesh[] = [];

      for (let r = 0; r < def.rings.length; r++) {
        const ringDef = def.rings[r];
        const ringGroup = new THREE.Group();
        ringGroup.name = `ring-${def.id}-${r}`;
        ringGroup.position.set(ringDef.x, ringDef.y, ringDef.z);

        const dir = new THREE.Vector3(ringDef.dirX, ringDef.dirY, ringDef.dirZ).normalize();
        ringGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);

        // Outer sturdy ring
        const outerGeo = new THREE.TorusGeometry(ringDef.radius, 0.16, 8, 28);
        const outerRing = new THREE.Mesh(outerGeo, outerRingMat);
        outerRing.layers.enable(LAYER_ENERGY);
        ringGroup.add(outerRing);

        // Inner glowing speed ring
        const innerGeo = new THREE.TorusGeometry(ringDef.radius * 0.95, 0.08, 6, 28);
        const innerGlow = new THREE.Mesh(innerGeo, innerGlowMat);
        innerGlow.layers.enable(LAYER_ENERGY);
        ringGroup.add(innerGlow);

        // 4 aerofoil winglets around ring perimeter
        const winglets = new THREE.Group();
        for (let w = 0; w < 4; w++) {
          const angle = (w / 4) * Math.PI * 2;
          const wingletGeo = new THREE.BoxGeometry(0.12, 0.55, 0.28);
          const winglet = new THREE.Mesh(wingletGeo, wingletMat);
          winglet.position.set(Math.cos(angle) * ringDef.radius, Math.sin(angle) * ringDef.radius, 0);
          winglet.rotation.z = angle + 0.15;
          winglet.layers.enable(LAYER_ENERGY);
          winglets.add(winglet);
        }
        ringGroup.add(winglets);

        // Inner vortex aperture disc
        const apertureGeo = new THREE.PlaneGeometry(ringDef.radius * 1.9, ringDef.radius * 1.9);
        const aperture = new THREE.Mesh(apertureGeo, apertureMat);
        aperture.userData.noOutline = true;
        aperture.layers.enable(LAYER_ENERGY);
        ringGroup.add(aperture);

        group.add(ringGroup);
        ringVisuals.push({
          def: ringDef,
          group: ringGroup,
          outerRing,
          innerGlow,
          winglets,
          apertureMat,
          aperture,
          pulse: 0,
        });
      }

      // Connecting guide streamline ribbons
      for (let r = 0; r < def.rings.length - 1; r++) {
        const r0 = def.rings[r];
        const r1 = def.rings[r + 1];
        const p0 = new THREE.Vector3(r0.x, r0.y, r0.z);
        const p1 = new THREE.Vector3(r1.x, r1.y, r1.z);
        const dist = p0.distanceTo(p1);
        const mid = p0.clone().add(p1).multiplyScalar(0.5);
        const dir = p1.clone().sub(p0).normalize();

        const guideGeo = new THREE.CylinderGeometry(
          r1.radius * 0.98,
          r0.radius * 0.98,
          dist,
          16,
          1,
          true,
        );
        guideGeo.rotateX(Math.PI / 2);
        const guideMesh = new THREE.Mesh(guideGeo, guideMat);
        guideMesh.position.copy(mid);
        guideMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
        guideMesh.userData.noOutline = true;
        guideMesh.layers.enable(LAYER_ENERGY);
        group.add(guideMesh);
        guideRibbons.push(guideMesh);
      }

      this.object.add(group);
      this.windTunnelVisuals.push({
        def,
        group,
        ringVisuals,
        guideRibbons,
        guideMat,
      });
    }
  }

  // ---------------------------------------------------- 3D wonder scenery ----

  private buildWonderCourseScenery(): void {
    const stoneParts: THREE.BufferGeometry[] = [];
    const chalkParts: THREE.BufferGeometry[] = [];
    const canyonParts: THREE.BufferGeometry[] = [];
    const mountainGreenParts: THREE.BufferGeometry[] = [];
    const mountainRockParts: THREE.BufferGeometry[] = [];
    const waterfallParts: THREE.BufferGeometry[] = [];
    const wallParts: THREE.BufferGeometry[] = [];
    const roofParts: THREE.BufferGeometry[] = [];
    const grassParts: THREE.BufferGeometry[] = [];
    const woodParts: THREE.BufferGeometry[] = [];
    const brassParts: THREE.BufferGeometry[] = [];
    const sandParts: THREE.BufferGeometry[] = [];
    const coralPinkParts: THREE.BufferGeometry[] = [];
    const coralTealParts: THREE.BufferGeometry[] = [];
    const coralGoldParts: THREE.BufferGeometry[] = [];
    const foliageParts: THREE.BufferGeometry[] = [];

    // Helper to ensure geometry is indexed and clean for mergeGeometries
    const cleanGeo = (geo: THREE.BufferGeometry): THREE.BufferGeometry => {
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

    // 1. Procedural Chalk Sea Cliff Generator (Warm White Chalk Base & Emerald Grass Terraces)
    const makeChalkCapeCliff = (
      cx: number,
      cz: number,
      baseR: number,
      topR: number,
      height: number,
      segments = 18,
      stepCount = 5,
      seed = 0,
    ): void => {
      const layerCount = stepCount + 2;
      const pos: number[] = [];
      const uvs: number[] = [];
      const indices: number[] = [];

      for (let l = 0; l < layerCount; l++) {
        const f = l / (layerCount - 1);
        const y = -2.8 + (height + 2.8) * f;
        const baseRadius = THREE.MathUtils.lerp(baseR, topR, Math.pow(f, 0.85));
        let shelf = 1.0;
        if (l === 0) shelf = 1.18;
        else if (l === 1 && f < 0.25) shelf = 0.90;
        else if (l % 2 === 1 && l < layerCount - 1) shelf = 1.06;
        else shelf = 0.96;
        const layerR = baseRadius * shelf;

        for (let i = 0; i < segments; i++) {
          const angle = (i / segments) * Math.PI * 2;
          const noise = Math.sin(angle * 3 + seed * 1.7) * 0.14 + Math.cos(angle * 5 + seed * 2.3) * 0.08 + Math.sin(angle * 7 + l) * 0.04;
          const r = layerR * (1 + noise);
          pos.push(cx + Math.cos(angle) * r, y, cz + Math.sin(angle) * r);
          uvs.push(i / segments, f);
        }
      }

      for (let l = 0; l < layerCount - 1; l++) {
        for (let i = 0; i < segments; i++) {
          const nextI = (i + 1) % segments;
          const a = l * segments + i;
          const b = l * segments + nextI;
          const c = (l + 1) * segments + i;
          const d = (l + 1) * segments + nextI;
          indices.push(a, c, b, b, c, d);
        }
      }

      const topCenterIdx = pos.length / 3;
      pos.push(cx, height, cz);
      uvs.push(0.5, 0.5);
      const topLayerStart = (layerCount - 1) * segments;
      for (let i = 0; i < segments; i++) {
        const nextI = (i + 1) % segments;
        indices.push(topCenterIdx, topLayerStart + i, topLayerStart + nextI);
      }

      const rockGeo = new THREE.BufferGeometry();
      rockGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      rockGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      rockGeo.setIndex(indices);
      rockGeo.computeVertexNormals();
      chalkParts.push(rockGeo);

      // Top emerald grass cap
      const grassPos: number[] = [cx, height + 0.12, cz];
      const grassUvs: number[] = [0.5, 0.5];
      const grassIdx: number[] = [];
      for (let i = 0; i < segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        const noise = Math.sin(angle * 3 + seed * 1.7) * 0.14 + Math.cos(angle * 5 + seed * 2.3) * 0.08;
        const r = topR * 1.02 * (1 + noise);
        grassPos.push(cx + Math.cos(angle) * r, height + 0.12, cz + Math.sin(angle) * r);
        grassUvs.push(Math.cos(angle) * 0.5 + 0.5, Math.sin(angle) * 0.5 + 0.5);
        const nextI = (i + 1) % segments;
        grassIdx.push(0, i + 1, nextI + 1);
      }
      const grassGeo = new THREE.BufferGeometry();
      grassGeo.setAttribute('position', new THREE.Float32BufferAttribute(grassPos, 3));
      grassGeo.setAttribute('uv', new THREE.Float32BufferAttribute(grassUvs, 2));
      grassGeo.setIndex(grassIdx);
      grassGeo.computeVertexNormals();
      grassParts.push(grassGeo);
    };

    // 2. Procedural Canyon Sandstone Cliff Generator (Warm Terracotta Strata for Zone 3)
    const makeCanyonCliff = (
      cx: number,
      cz: number,
      baseR: number,
      topR: number,
      height: number,
      segments = 16,
      stepCount = 5,
      seed = 0,
    ): void => {
      const layerCount = stepCount + 2;
      const pos: number[] = [];
      const uvs: number[] = [];
      const indices: number[] = [];

      for (let l = 0; l < layerCount; l++) {
        const f = l / (layerCount - 1);
        const y = -2.5 + (height + 2.5) * f;
        const baseRadius = THREE.MathUtils.lerp(baseR, topR, f);
        const shelf = l % 2 === 1 && l < layerCount - 1 ? 1.08 : 0.95;
        const layerR = baseRadius * (l === 0 ? 1.15 : shelf);

        for (let i = 0; i < segments; i++) {
          const angle = (i / segments) * Math.PI * 2;
          const noise = Math.sin(angle * 3 + seed * 1.7) * 0.12 + Math.cos(angle * 5 + seed * 2.3) * 0.07;
          const r = layerR * (1 + noise);
          pos.push(cx + Math.cos(angle) * r, y, cz + Math.sin(angle) * r);
          uvs.push(i / segments, f);
        }
      }

      for (let l = 0; l < layerCount - 1; l++) {
        for (let i = 0; i < segments; i++) {
          const nextI = (i + 1) % segments;
          const a = l * segments + i;
          const b = l * segments + nextI;
          const c = (l + 1) * segments + i;
          const d = (l + 1) * segments + nextI;
          indices.push(a, c, b, b, c, d);
        }
      }

      const topCenterIdx = pos.length / 3;
      pos.push(cx, height, cz);
      uvs.push(0.5, 0.5);
      const topLayerStart = (layerCount - 1) * segments;
      for (let i = 0; i < segments; i++) {
        const nextI = (i + 1) % segments;
        indices.push(topCenterIdx, topLayerStart + i, topLayerStart + nextI);
      }

      const rockGeo = new THREE.BufferGeometry();
      rockGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      rockGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      rockGeo.setIndex(indices);
      rockGeo.computeVertexNormals();
      canyonParts.push(rockGeo);

      // Top grass cap
      const grassPos: number[] = [cx, height + 0.08, cz];
      const grassUvs: number[] = [0.5, 0.5];
      const grassIdx: number[] = [];
      for (let i = 0; i < segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        const noise = Math.sin(angle * 3 + seed * 1.7) * 0.12 + Math.cos(angle * 5 + seed * 2.3) * 0.07;
        const r = topR * 0.98 * (1 + noise);
        grassPos.push(cx + Math.cos(angle) * r, height + 0.08, cz + Math.sin(angle) * r);
        grassUvs.push(Math.cos(angle) * 0.5 + 0.5, Math.sin(angle) * 0.5 + 0.5);
        const nextI = (i + 1) % segments;
        grassIdx.push(0, i + 1, nextI + 1);
      }
      const grassGeo = new THREE.BufferGeometry();
      grassGeo.setAttribute('position', new THREE.Float32BufferAttribute(grassPos, 3));
      grassGeo.setAttribute('uv', new THREE.Float32BufferAttribute(grassUvs, 2));
      grassGeo.setIndex(grassIdx);
      grassGeo.computeVertexNormals();
      grassParts.push(grassGeo);
    };

    // 3. Mediterranean Red-Tiled Whitewashed Cottage Generator
    const makeVillageHouse = (
      cx: number,
      cy: number,
      cz: number,
      yaw: number,
      w = 6.2,
      l = 8.5,
      h = 5.2,
      hasAnnex = false,
      hasBalcony = true,
    ): void => {
      const houseWalls: THREE.BufferGeometry[] = [];
      const houseRoofs: THREE.BufferGeometry[] = [];
      const houseWood: THREE.BufferGeometry[] = [];
      const houseStone: THREE.BufferGeometry[] = [];

      const plinthH = 1.2;
      const plinth = new THREE.BoxGeometry(w + 0.6, plinthH, l + 0.6);
      plinth.translate(0, plinthH * 0.5, 0);
      houseStone.push(plinth);

      const wall = new THREE.BoxGeometry(w, h, l);
      wall.translate(0, plinthH + h * 0.5, 0);
      houseWalls.push(wall);

      const gableH = w * 0.42;
      const gableFrontPos = [
        -w * 0.5, plinthH + h, l * 0.5,
        w * 0.5, plinthH + h, l * 0.5,
        0, plinthH + h + gableH, l * 0.5,
      ];
      const gableFront = new THREE.BufferGeometry();
      gableFront.setAttribute('position', new THREE.Float32BufferAttribute(gableFrontPos, 3));
      gableFront.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0.5, 1], 2));
      gableFront.setIndex([0, 1, 2]);
      gableFront.computeVertexNormals();
      houseWalls.push(gableFront);

      const gableBackPos = [
        w * 0.5, plinthH + h, -l * 0.5,
        -w * 0.5, plinthH + h, -l * 0.5,
        0, plinthH + h + gableH, -l * 0.5,
      ];
      const gableBack = new THREE.BufferGeometry();
      gableBack.setAttribute('position', new THREE.Float32BufferAttribute(gableBackPos, 3));
      gableBack.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0.5, 1], 2));
      gableBack.setIndex([0, 1, 2]);
      gableBack.computeVertexNormals();
      houseWalls.push(gableBack);

      const eaveOverhang = 0.55;
      const roofThick = 0.22;
      const slopeLen = Math.hypot(w * 0.5 + eaveOverhang, gableH) + 0.15;
      const slopeAngle = Math.atan2(gableH, w * 0.5);

      const roofLeft = new THREE.BoxGeometry(slopeLen, roofThick, l + eaveOverhang * 2);
      roofLeft.rotateZ(-slopeAngle);
      roofLeft.translate(-w * 0.25 - eaveOverhang * 0.25, plinthH + h + gableH * 0.5, 0);
      houseRoofs.push(roofLeft);

      const roofRight = new THREE.BoxGeometry(slopeLen, roofThick, l + eaveOverhang * 2);
      roofRight.rotateZ(slopeAngle);
      roofRight.translate(w * 0.25 + eaveOverhang * 0.25, plinthH + h + gableH * 0.5, 0);
      houseRoofs.push(roofRight);

      const ridge = new THREE.CylinderGeometry(0.18, 0.18, l + eaveOverhang * 2.2, 6);
      ridge.rotateX(Math.PI / 2);
      ridge.translate(0, plinthH + h + gableH + 0.08, 0);
      houseRoofs.push(ridge);

      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const cornerPost = new THREE.BoxGeometry(0.25, h, 0.25);
          cornerPost.translate(sx * (w * 0.5 - 0.1), plinthH + h * 0.5, sz * (l * 0.5 - 0.1));
          houseWood.push(cornerPost);
        }
      }

      const door = new THREE.BoxGeometry(1.2, 2.2, 0.15);
      door.translate(0, plinthH + 1.1, l * 0.5 + 0.05);
      houseWood.push(door);

      const windowFront = new THREE.BoxGeometry(1.0, 1.2, 0.12);
      windowFront.translate(0, plinthH + 3.4, l * 0.5 + 0.05);
      houseWood.push(windowFront);

      for (const sz of [-l * 0.25, l * 0.25]) {
        const windowSide = new THREE.BoxGeometry(0.12, 1.1, 0.9);
        windowSide.translate(w * 0.5 + 0.05, plinthH + 2.5, sz);
        houseWood.push(windowSide);
      }

      const chimney = new THREE.BoxGeometry(0.85, 3.2, 0.85);
      chimney.translate(w * 0.3, plinthH + h + 1.2, -l * 0.25);
      houseStone.push(chimney);

      const chimPot = new THREE.CylinderGeometry(0.24, 0.28, 0.65, 8);
      chimPot.translate(w * 0.3, plinthH + h + 3.0, -l * 0.25);
      houseRoofs.push(chimPot);

      if (hasBalcony) {
        const balcDeck = new THREE.BoxGeometry(2.4, 0.15, 1.2);
        balcDeck.translate(0, plinthH + 2.7, l * 0.5 + 0.6);
        houseWood.push(balcDeck);

        const balcRail = new THREE.BoxGeometry(2.4, 0.75, 0.08);
        balcRail.translate(0, plinthH + 3.1, l * 0.5 + 1.15);
        houseWood.push(balcRail);

        const planter = new THREE.BoxGeometry(2.0, 0.25, 0.35);
        planter.translate(0, plinthH + 2.8, l * 0.5 + 0.85);
        houseWood.push(planter);
      }

      if (hasAnnex) {
        const aw = w * 0.65;
        const al = l * 0.55;
        const ah = h * 0.75;
        const annexWall = new THREE.BoxGeometry(aw, ah, al);
        annexWall.translate(w * 0.5 + aw * 0.45, plinthH + ah * 0.5, 0);
        houseWalls.push(annexWall);

        const aSlope = Math.atan2(gableH * 0.7, aw);
        const annexRoof = new THREE.BoxGeometry(aw * 1.15, 0.18, al + 0.6);
        annexRoof.rotateZ(aSlope);
        annexRoof.translate(w * 0.5 + aw * 0.5, plinthH + ah + 0.4, 0);
        houseRoofs.push(annexRoof);
      }

      const mergeAndAdd = (geos: THREE.BufferGeometry[], target: THREE.BufferGeometry[]): void => {
        const m = mergeGeometries(geos.map(cleanGeo), false);
        geos.forEach((g) => g.dispose());
        if (m) {
          m.rotateY(yaw);
          m.translate(cx, cy, cz);
          target.push(m);
        }
      };

      mergeAndAdd(houseWalls, wallParts);
      mergeAndAdd(houseRoofs, roofParts);
      mergeAndAdd(houseWood, woodParts);
      mergeAndAdd(houseStone, stoneParts);
    };

    // 4. Whitewashed Chalk Windmill Builder (4-Blade Rotating Sails & Terracotta Cone Roof)
    const makeChalkWindmill = (
      cx: number,
      cy: number,
      cz: number,
      baseRadius = 4.0,
      towerHeight = 14.5,
    ): void => {
      const chalkGeos: THREE.BufferGeometry[] = [];
      const roofGeos: THREE.BufferGeometry[] = [];
      const woodGeos: THREE.BufferGeometry[] = [];
      const brassGeos: THREE.BufferGeometry[] = [];

      const plinth = new THREE.CylinderGeometry(baseRadius * 1.15, baseRadius * 1.25, 1.4, 12);
      plinth.translate(0, 0.7, 0);
      chalkGeos.push(plinth);

      const tower = new THREE.CylinderGeometry(baseRadius * 0.72, baseRadius, towerHeight, 12);
      tower.translate(0, towerHeight * 0.5 + 0.7, 0);
      chalkGeos.push(tower);

      const balcony = new THREE.CylinderGeometry(baseRadius * 0.98, baseRadius * 0.98, 0.35, 12);
      balcony.translate(0, towerHeight * 0.68 + 0.7, 0);
      woodGeos.push(balcony);

      const railing = new THREE.CylinderGeometry(baseRadius * 0.98, baseRadius * 0.98, 0.8, 12, 1, true);
      railing.translate(0, towerHeight * 0.68 + 1.1, 0);
      woodGeos.push(railing);

      const roof = new THREE.ConeGeometry(baseRadius * 0.88, 4.8, 12);
      roof.translate(0, towerHeight + 3.1, 0);
      roofGeos.push(roof);

      const finial = new THREE.SphereGeometry(0.42, 8, 8);
      finial.translate(0, towerHeight + 5.6, 0);
      const vaneRod = new THREE.CylinderGeometry(0.05, 0.05, 1.6, 6);
      vaneRod.translate(0, towerHeight + 6.3, 0);
      brassGeos.push(finial, vaneRod);

      const mChalk = mergeGeometries(chalkGeos.map(cleanGeo), false);
      chalkGeos.forEach((p) => p.dispose());
      if (mChalk) {
        mChalk.translate(cx, cy, cz);
        chalkParts.push(mChalk);
      }

      const mRoof = mergeGeometries(roofGeos.map(cleanGeo), false);
      roofGeos.forEach((p) => p.dispose());
      if (mRoof) {
        mRoof.translate(cx, cy, cz);
        roofParts.push(mRoof);
      }

      const mWood = mergeGeometries(woodGeos.map(cleanGeo), false);
      woodGeos.forEach((p) => p.dispose());
      if (mWood) {
        mWood.translate(cx, cy, cz);
        woodParts.push(mWood);
      }

      const mBrass = mergeGeometries(brassGeos.map(cleanGeo), false);
      brassGeos.forEach((p) => p.dispose());
      if (mBrass) {
        mBrass.translate(cx, cy, cz);
        brassParts.push(mBrass);
      }

      // Dynamic 4-blade rotor
      const rotorGroup = new THREE.Group();
      rotorGroup.name = 'chalk-windmill-rotor';
      rotorGroup.position.set(cx, cy + towerHeight + 1.4, cz + baseRadius * 0.76);

      const rotorParts: THREE.BufferGeometry[] = [];
      const hub = new THREE.CylinderGeometry(0.65, 0.65, 0.8, 8);
      hub.rotateX(Math.PI / 2);
      rotorParts.push(hub);

      for (let b = 0; b < 4; b++) {
        const bladeAngle = (b / 4) * Math.PI * 2;
        const spar = new THREE.BoxGeometry(0.22, 0.22, 9.2);
        spar.rotateX(Math.PI / 2);
        spar.rotateZ(bladeAngle);
        const sail = new THREE.PlaneGeometry(1.85, 6.8);
        sail.rotateZ(bladeAngle);
        sail.translate(
          Math.cos(bladeAngle + Math.PI / 2) * 0.88 + Math.cos(bladeAngle) * 4.6,
          Math.sin(bladeAngle + Math.PI / 2) * 0.88 + Math.sin(bladeAngle) * 4.6,
          0.06,
        );
        rotorParts.push(spar, sail);
      }
      const mergedRotor = mergeGeometries(rotorParts.map(cleanGeo), false);
      rotorParts.forEach((p) => p.dispose());
      if (mergedRotor) {
        const rotorMat = createToonMaterial({ color: PALETTE.gliderCanvas, shadowTint: PALETTE.boatWoodDark });
        const rotorMesh = new THREE.Mesh(mergedRotor, rotorMat);
        addOutline(rotorMesh, { width: 0.75 });
        markInk(rotorMesh);
        rotorGroup.add(rotorMesh);
        this.object.add(rotorGroup);
        this.sceneryWindmillRotors.push(rotorGroup);
      }
    };

    // 5. Vintage Handcrafted Teak Launch Pier & Mooring Dock (复古手作老柚木出航小栈桥)
    // 5. Vintage Handcrafted Teak Launch Pier & Mooring Dock (复古手作老柚木出航小栈桥)
    const makeGliderLaunchPier = (
      width = 13.0,
      startZ = -30.0,
      endZ = -17.0,
    ): void => {
      const woodGeos: THREE.BufferGeometry[] = [];
      const darkWoodGeos: THREE.BufferGeometry[] = [];
      const brassGeos: THREE.BufferGeometry[] = [];

      const totalLength = endZ - startZ; // 13m
      const pileSpacing = 4.0;
      const pileCount = Math.floor(totalLength / pileSpacing);

      // Helper to compute dock top height at station z
      const dockYAt = (z: number): { y: number; pitch: number } => {
        const taperDist = 4.5;
        if (z > endZ - taperDist) {
          const rf = (z - (endZ - taperDist)) / taperDist;
          return { y: 0.38 - rf * 0.56, pitch: rf * 0.12 }; // slopes from 0.38m to -0.18m into the sea
        }
        return { y: 0.38, pitch: 0 };
      };

      // 1. Heavy timber pilings, crossbeams & support framework underneath
      for (let p = 0; p <= pileCount; p++) {
        const lz = startZ + p * pileSpacing;
        const { y: deckY } = dockYAt(lz);
        for (const sx of [-width * 0.48, width * 0.48]) {
          const pile = new THREE.CylinderGeometry(0.32, 0.40, 4.5, 8);
          pile.translate(sx, deckY - 2.3, lz);
          darkWoodGeos.push(pile);

          // Carved wooden pile cap collar
          const collar = new THREE.CylinderGeometry(0.38, 0.38, 0.16, 8);
          collar.translate(sx, deckY - 0.05, lz);
          woodGeos.push(collar);
        }
        // Crossbeam strictly below the deck planks
        const crossBeam = new THREE.BoxGeometry(width + 0.3, 0.22, 0.26);
        crossBeam.translate(0, deckY - 0.16, lz);
        darkWoodGeos.push(crossBeam);

        // Diagonal wooden bracing
        for (const side of [-1, 1]) {
          const brace = new THREE.BoxGeometry(0.18, 0.18, 2.4);
          brace.rotateX(side * 0.38);
          brace.translate(side * (width * 0.32), deckY - 0.8, lz);
          darkWoodGeos.push(brace);
        }
      }

      // 2. Individual warm old teak deck planks (#8B5A2B) with physical board separation
      const plankW = 0.34;
      const plankCount = Math.floor(totalLength / plankW);
      for (let i = 0; i < plankCount; i++) {
        const lz = startZ + (i + 0.5) * (totalLength / plankCount);
        const { y: rampY, pitch: rampPitch } = dockYAt(lz);
        const plank = new THREE.BoxGeometry(width, 0.08, plankW * 0.88);
        if (rampPitch !== 0) plank.rotateX(rampPitch);
        plank.translate(0, rampY, lz);
        woodGeos.push(plank);

        // Side curb segments that follow the plank slope perfectly
        for (const side of [-1, 1]) {
          const sx = side * (width * 0.5 - 0.15);
          const curbSeg = new THREE.BoxGeometry(0.24, 0.12, plankW * 0.95);
          if (rampPitch !== 0) curbSeg.rotateX(rampPitch);
          curbSeg.translate(sx, rampY + 0.08, lz);
          woodGeos.push(curbSeg);
        }
      }

      // 3. Vintage Brass Mooring Bollards (#C8963E) at landward base only
      const bollardZ = [startZ + 1.5, startZ + 5.5];
      for (const bz of bollardZ) {
        const { y: by } = dockYAt(bz);
        for (const side of [-1, 1]) {
          const bx = side * (width * 0.5 - 0.20);
          // Base plate
          const basePlate = new THREE.CylinderGeometry(0.26, 0.30, 0.06, 8);
          basePlate.translate(bx, by + 0.12, bz);
          brassGeos.push(basePlate);

          // Vertical post
          const post = new THREE.CylinderGeometry(0.14, 0.18, 0.32, 8);
          post.translate(bx, by + 0.28, bz);
          brassGeos.push(post);

          // Mooring cross-pin (T-peg)
          const crossPin = new THREE.CylinderGeometry(0.045, 0.045, 0.42, 6);
          crossPin.rotateZ(Math.PI / 2);
          crossPin.translate(bx, by + 0.38, bz);
          brassGeos.push(crossPin);

          // Rounded brass bollard cap
          const cap = new THREE.SphereGeometry(0.16, 8, 6);
          cap.translate(bx, by + 0.48, bz);
          brassGeos.push(cap);
        }
      }

      // 4. Shore base lantern posts & brass nautical lanterns (landward end only)
      const shoreZ = startZ + 0.8;
      const { y: sy } = dockYAt(shoreZ);
      for (const side of [-1, 1]) {
        const lx = side * (width * 0.5 + 0.18);
        const post = new THREE.BoxGeometry(0.22, 1.2, 0.22);
        post.translate(lx, sy + 0.65, shoreZ);
        woodGeos.push(post);

        // Brass nautical lantern
        const lanternBody = new THREE.CylinderGeometry(0.14, 0.17, 0.34, 6);
        lanternBody.translate(lx, sy + 1.35, shoreZ);
        brassGeos.push(lanternBody);

        const lanternCap = new THREE.ConeGeometry(0.20, 0.16, 6);
        lanternCap.translate(lx, sy + 1.58, shoreZ);
        brassGeos.push(lanternCap);
      }

      const mWood = mergeGeometries(woodGeos.map(cleanGeo), false);
      woodGeos.forEach((p) => p.dispose());
      if (mWood) woodParts.push(mWood);

      const mDarkWood = mergeGeometries(darkWoodGeos.map(cleanGeo), false);
      darkWoodGeos.forEach((p) => p.dispose());
      if (mDarkWood) woodParts.push(mDarkWood);

      const mBrass = mergeGeometries(brassGeos.map(cleanGeo), false);
      brassGeos.forEach((p) => p.dispose());
      if (mBrass) brassParts.push(mBrass);
    };

    // 6. Procedural Karst Sea Stack Generator
    const makeSeaStack = (
      cx: number,
      cz: number,
      radiusBase: number,
      radiusTop: number,
      height: number,
      segments = 12,
      seed = 0,
    ): void => {
      const tiers = [
        { y: -2.5, r: radiusBase * 1.2 },
        { y: 0.4, r: radiusBase * 0.72 },
        { y: 1.8, r: radiusBase * 0.88 },
        { y: height * 0.45, r: THREE.MathUtils.lerp(radiusBase, radiusTop, 0.45) * 1.05 },
        { y: height * 0.85, r: radiusTop * 1.12 },
        { y: height, r: radiusTop * 0.92 },
      ];
      const pos: number[] = [];
      const uvs: number[] = [];
      const indices: number[] = [];

      for (let l = 0; l < tiers.length; l++) {
        const t = tiers[l];
        for (let i = 0; i < segments; i++) {
          const angle = (i / segments) * Math.PI * 2;
          const noise = Math.sin(angle * 4 + seed) * 0.14 + Math.cos(angle * 2 + seed * 1.5) * 0.08;
          const r = t.r * (1 + noise);
          pos.push(cx + Math.cos(angle) * r, t.y, cz + Math.sin(angle) * r);
          uvs.push(i / segments, l / (tiers.length - 1));
        }
      }

      for (let l = 0; l < tiers.length - 1; l++) {
        for (let i = 0; i < segments; i++) {
          const nextI = (i + 1) % segments;
          const a = l * segments + i;
          const b = l * segments + nextI;
          const c = (l + 1) * segments + i;
          const d = (l + 1) * segments + nextI;
          indices.push(a, c, b, b, c, d);
        }
      }

      const topCenterIdx = pos.length / 3;
      pos.push(cx, height, cz);
      uvs.push(0.5, 0.5);
      const topLayerStart = (tiers.length - 1) * segments;
      for (let i = 0; i < segments; i++) {
        const nextI = (i + 1) % segments;
        indices.push(topCenterIdx, topLayerStart + i, topLayerStart + nextI);
      }

      const rockGeo = new THREE.BufferGeometry();
      rockGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      rockGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      rockGeo.setIndex(indices);
      rockGeo.computeVertexNormals();
      chalkParts.push(rockGeo);

      const grassPos: number[] = [cx, height + 0.08, cz];
      const grassUvs: number[] = [0.5, 0.5];
      const grassIdx: number[] = [];
      for (let i = 0; i < segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        const noise = Math.sin(angle * 4 + seed) * 0.14;
        const r = radiusTop * 0.95 * (1 + noise);
        grassPos.push(cx + Math.cos(angle) * r, height + 0.08, cz + Math.sin(angle) * r);
        grassUvs.push(Math.cos(angle) * 0.5 + 0.5, Math.sin(angle) * 0.5 + 0.5);
        const nextI = (i + 1) % segments;
        grassIdx.push(0, i + 1, nextI + 1);
      }
      const grassGeo = new THREE.BufferGeometry();
      grassGeo.setAttribute('position', new THREE.Float32BufferAttribute(grassPos, 3));
      grassGeo.setAttribute('uv', new THREE.Float32BufferAttribute(grassUvs, 2));
      grassGeo.setIndex(grassIdx);
      grassGeo.computeVertexNormals();
      grassParts.push(grassGeo);
    };

    // 7. Procedural Natural Sea Arch Generator
    const makeNaturalSeaArch = (
      cx: number,
      cz: number,
      heading: number,
      span: number,
      height: number,
      archHeight: number,
      thickness: number,
      segments = 18,
    ): void => {
      const halfSpan = span * 0.5;
      const halfThick = thickness * 0.5;
      const pos: number[] = [];
      const uvs: number[] = [];
      const indices: number[] = [];

      const cosH = Math.cos(heading);
      const sinH = Math.sin(heading);
      const transform = (lx: number, ly: number, lz: number): [number, number, number] => [
        cx + lx * cosH - lz * sinH,
        ly,
        cz + lx * sinH + lz * cosH,
      ];

      const outerProfile: [number, number][] = [];
      const innerProfile: [number, number][] = [];

      for (let i = 0; i <= segments; i++) {
        const f = i / segments;
        const angle = f * Math.PI;
        const ox = -Math.cos(angle) * halfSpan;
        const oy = Math.sin(angle) * (height + 2.5) - 2.5;
        outerProfile.push([ox, Math.max(-2.5, oy)]);

        const innerSpan = halfSpan * 0.68;
        const ix = -Math.cos(angle) * innerSpan;
        const iy = Math.sin(angle) * (archHeight + 2.5) - 2.5;
        innerProfile.push([ix, Math.max(-2.5, iy)]);
      }

      for (const zSide of [halfThick, -halfThick]) {
        const baseV = pos.length / 3;
        for (let i = 0; i <= segments; i++) {
          const [ox, oy] = outerProfile[i];
          const [wx, wy, wz] = transform(ox, oy, zSide);
          pos.push(wx, wy, wz);
          uvs.push(i / segments, 1.0);

          const [ix, iy] = innerProfile[i];
          const [iwx, iwy, iwz] = transform(ix, iy, zSide);
          pos.push(iwx, iwy, iwz);
          uvs.push(i / segments, 0.0);
        }
        for (let i = 0; i < segments; i++) {
          const a = baseV + i * 2;
          const b = baseV + i * 2 + 1;
          const c = baseV + (i + 1) * 2;
          const d = baseV + (i + 1) * 2 + 1;
          if (zSide > 0) indices.push(a, c, b, b, c, d);
          else indices.push(a, b, c, b, d, c);
        }
      }

      const outerRimBase = pos.length / 3;
      for (let i = 0; i <= segments; i++) {
        const [ox, oy] = outerProfile[i];
        const [fx, fy, fz] = transform(ox, oy, halfThick);
        const [bx, by, bz] = transform(ox, oy, -halfThick);
        pos.push(fx, fy, fz, bx, by, bz);
        uvs.push(i / segments, 1, i / segments, 0);
      }
      for (let i = 0; i < segments; i++) {
        const a = outerRimBase + i * 2;
        const b = outerRimBase + i * 2 + 1;
        const c = outerRimBase + (i + 1) * 2;
        const d = outerRimBase + (i + 1) * 2 + 1;
        indices.push(a, b, c, b, d, c);
      }

      const innerRimBase = pos.length / 3;
      for (let i = 0; i <= segments; i++) {
        const [ix, iy] = innerProfile[i];
        const [fx, fy, fz] = transform(ix, iy, halfThick);
        const [bx, by, bz] = transform(ix, iy, -halfThick);
        pos.push(fx, fy, fz, bx, by, bz);
        uvs.push(i / segments, 1, i / segments, 0);
      }
      for (let i = 0; i < segments; i++) {
        const a = innerRimBase + i * 2;
        const b = innerRimBase + i * 2 + 1;
        const c = innerRimBase + (i + 1) * 2;
        const d = innerRimBase + (i + 1) * 2 + 1;
        indices.push(a, c, b, b, c, d);
      }

      const rockGeo = new THREE.BufferGeometry();
      rockGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      rockGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      rockGeo.setIndex(indices);
      rockGeo.computeVertexNormals();
      chalkParts.push(rockGeo);

      // Top grass crest
      const grassPos: number[] = [];
      const grassUvs: number[] = [];
      const grassIdx: number[] = [];
      const topCrestStart = Math.floor(segments * 0.28);
      const topCrestEnd = Math.ceil(segments * 0.72);
      for (let i = topCrestStart; i <= topCrestEnd; i++) {
        const [ox, oy] = outerProfile[i];
        const [fx, fy, fz] = transform(ox, oy + 0.12, halfThick * 0.88);
        const [bx, by, bz] = transform(ox, oy + 0.12, -halfThick * 0.88);
        grassPos.push(fx, fy, fz, bx, by, bz);
        grassUvs.push((i - topCrestStart) / (topCrestEnd - topCrestStart), 1, (i - topCrestStart) / (topCrestEnd - topCrestStart), 0);
      }
      const crestCount = topCrestEnd - topCrestStart;
      for (let i = 0; i < crestCount; i++) {
        const a = i * 2;
        const b = i * 2 + 1;
        const c = (i + 1) * 2;
        const d = (i + 1) * 2 + 1;
        grassIdx.push(a, b, c, b, d, c);
      }
      const grassGeo = new THREE.BufferGeometry();
      grassGeo.setAttribute('position', new THREE.Float32BufferAttribute(grassPos, 3));
      grassGeo.setAttribute('uv', new THREE.Float32BufferAttribute(grassUvs, 2));
      grassGeo.setIndex(grassIdx);
      grassGeo.computeVertexNormals();
      grassParts.push(grassGeo);
    };

    // 8. Procedural Laputa Floating Sky Island Generator (Stratified Inverted Rock Spire, Overhanging Grass, Ivy & Satellite Islets)
    const makeLaputaFloatingIsland = (
      cx: number,
      cy: number,
      cz: number,
      radius: number,
      depth: number,
      segments = 16,
      seed = 0,
      hasPavedRuins = true,
    ): void => {
      const tiers = [
        { y: 0, r: radius * 1.0 },
        { y: -depth * 0.18, r: radius * 0.92 },
        { y: -depth * 0.42, r: radius * 0.68 },
        { y: -depth * 0.70, r: radius * 0.38 },
        { y: -depth * 0.92, r: radius * 0.14 },
      ];
      const pos: number[] = [];
      const uvs: number[] = [];
      const indices: number[] = [];

      for (let l = 0; l < tiers.length; l++) {
        const t = tiers[l];
        for (let i = 0; i < segments; i++) {
          const angle = (i / segments) * Math.PI * 2;
          const noise = Math.sin(angle * 4 + seed * 2.3) * 0.16 + Math.cos(angle * 7 + seed * 1.7) * 0.08;
          const r = t.r * (1 + noise);
          pos.push(cx + Math.cos(angle) * r, cy + t.y, cz + Math.sin(angle) * r);
          uvs.push(i / segments, l / tiers.length);
        }
      }

      for (let l = 0; l < tiers.length - 1; l++) {
        for (let i = 0; i < segments; i++) {
          const nextI = (i + 1) % segments;
          const a = l * segments + i;
          const b = l * segments + nextI;
          const c = (l + 1) * segments + i;
          const d = (l + 1) * segments + nextI;
          indices.push(a, c, b, b, c, d);
        }
      }

      // Stalactite rocky tip
      const tipIdx = pos.length / 3;
      pos.push(cx + Math.sin(seed * 3.1) * 1.5, cy - depth, cz + Math.cos(seed * 3.1) * 1.5);
      uvs.push(0.5, 1.0);
      const lastTierStart = (tiers.length - 1) * segments;
      for (let i = 0; i < segments; i++) {
        const nextI = (i + 1) % segments;
        indices.push(lastTierStart + i, tipIdx, lastTierStart + nextI);
      }

      // Top center cap
      const topCenterIdx = pos.length / 3;
      pos.push(cx, cy, cz);
      uvs.push(0.5, 0.5);
      for (let i = 0; i < segments; i++) {
        const nextI = (i + 1) % segments;
        indices.push(topCenterIdx, i, nextI);
      }

      const rockGeo = new THREE.BufferGeometry();
      rockGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      rockGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      rockGeo.setIndex(indices);
      rockGeo.computeVertexNormals();
      chalkParts.push(rockGeo);

      // Top Emerald Grass Plateau with terraced overhanging lip
      const grassPos: number[] = [cx, cy + 0.16, cz];
      const grassUvs: number[] = [0.5, 0.5];
      const grassIdx: number[] = [];
      for (let i = 0; i < segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        const noise = Math.sin(angle * 4 + seed * 2.3) * 0.16;
        const r = radius * 1.02 * (1 + noise);
        grassPos.push(cx + Math.cos(angle) * r, cy + 0.16, cz + Math.sin(angle) * r);
        grassUvs.push(Math.cos(angle) * 0.5 + 0.5, Math.sin(angle) * 0.5 + 0.5);
        const nextI = (i + 1) % segments;
        grassIdx.push(0, i + 1, nextI + 1);
      }
      const grassGeo = new THREE.BufferGeometry();
      grassGeo.setAttribute('position', new THREE.Float32BufferAttribute(grassPos, 3));
      grassGeo.setAttribute('uv', new THREE.Float32BufferAttribute(grassUvs, 2));
      grassGeo.setIndex(grassIdx);
      grassGeo.computeVertexNormals();
      grassParts.push(grassGeo);

      // Hanging Ivy tendrils & moss along the underbelly perimeter
      for (let i = 0; i < 6; i++) {
        const vineAngle = (i / 6) * Math.PI * 2 + seed * 0.8;
        const vineNoise = Math.sin(vineAngle * 4 + seed * 2.3) * 0.16;
        const vineR = radius * 0.88 * (1 + vineNoise);
        const vx = cx + Math.cos(vineAngle) * vineR;
        const vz = cz + Math.sin(vineAngle) * vineR;
        const vineLen = 4.5 + (i % 3) * 2.5;
        const vineMesh = new THREE.CylinderGeometry(0.12, 0.04, vineLen, 5);
        vineMesh.translate(vx, cy - vineLen * 0.5, vz);
        foliageParts.push(vineMesh);
      }

      // Ancient Marble Paved Ruin Flooring
      if (hasPavedRuins) {
        const ruinPlinth = new THREE.CylinderGeometry(radius * 0.62, radius * 0.65, 0.45, 12);
        ruinPlinth.translate(cx, cy + 0.25, cz);
        stoneParts.push(ruinPlinth);

        const innerDais = new THREE.CylinderGeometry(radius * 0.42, radius * 0.44, 0.35, 10);
        innerDais.translate(cx, cy + 0.60, cz);
        stoneParts.push(innerDais);
      }

      // Hanging Underbelly Stalactites
      for (let s = 0; s < 4; s++) {
        const sAngle = (s / 4) * Math.PI * 2 + seed + 0.4;
        const sDist = radius * 0.35 + (s % 2) * (radius * 0.2);
        const sx = cx + Math.cos(sAngle) * sDist;
        const sz = cz + Math.sin(sAngle) * sDist;
        const sHeight = 4.0 + (s % 3) * 2.2;
        const stalactite = new THREE.ConeGeometry(0.85, sHeight, 6);
        stalactite.rotateX(Math.PI);
        stalactite.translate(sx, cy - depth * 0.45 - sHeight * 0.5, sz);
        stoneParts.push(stalactite);
      }

      // Orbiting Satellite Mini-Islets (2~3 mini floating rock spires nearby)
      const satCount = 3;
      for (let k = 0; k < satCount; k++) {
        const satAngle = (k / satCount) * Math.PI * 2 + seed * 1.5;
        const satDist = radius * 1.55 + (k % 2) * 8.0;
        const satX = cx + Math.cos(satAngle) * satDist;
        const satY = cy + (Math.sin(k * 2.4 + seed) * 4.5);
        const satZ = cz + Math.sin(satAngle) * satDist;
        const satR = 3.2 + (k % 2) * 1.8;
        const satD = 5.5 + (k % 2) * 3.0;

        const satCone = new THREE.ConeGeometry(satR, satD, 7);
        satCone.rotateX(Math.PI);
        satCone.translate(satX, satY - satD * 0.5, satZ);
        chalkParts.push(satCone);

        const satGrass = new THREE.CylinderGeometry(satR * 0.95, satR, 0.35, 7);
        satGrass.translate(satX, satY + 0.15, satZ);
        grassParts.push(satGrass);
      }
    };

    // 9. Glider Launch Ramp Builder
    const makeGliderLaunchRamp = (
      cx: number,
      cy: number,
      cz: number,
      heading: number,
      width = 7.5,
      length = 26.0,
      slopeDeg = 12.0,
    ): void => {
      const woodGeos: THREE.BufferGeometry[] = [];
      const brassGeos: THREE.BufferGeometry[] = [];

      const slopeRad = (slopeDeg * Math.PI) / 180;
      const cosS = Math.cos(slopeRad);
      const sinS = Math.sin(slopeRad);

      const beamW = 0.55;
      const beamH = 0.85;
      for (const side of [-1, 1]) {
        const beam = new THREE.BoxGeometry(beamW, beamH, length);
        beam.rotateX(slopeRad);
        beam.translate(side * (width * 0.5 - 0.4), length * 0.5 * sinS, length * 0.5 * cosS);
        woodGeos.push(beam);

        const strut = new THREE.BoxGeometry(0.42, 0.42, length * 0.75);
        strut.rotateX(-0.52);
        strut.translate(side * (width * 0.5 - 0.4), length * 0.35 * sinS - 4.5, length * 0.4 * cosS);
        woodGeos.push(strut);

        const rail = new THREE.BoxGeometry(0.18, 0.85, length);
        rail.rotateX(slopeRad);
        rail.translate(side * (width * 0.5 + 0.1), length * 0.5 * sinS + 0.6, length * 0.5 * cosS);
        woodGeos.push(rail);

        for (let p = 0; p < 3; p++) {
          const bracket = new THREE.BoxGeometry(0.24, 0.32, 0.45);
          bracket.translate(side * (width * 0.5 + 0.1), length * (p / 2) * sinS + 0.4, length * (p / 2) * cosS);
          brassGeos.push(bracket);
        }
      }

      const plankCount = 20;
      for (let i = 0; i <= plankCount; i++) {
        const f = i / plankCount;
        const lz = f * length;
        const ly = lz * Math.tan(slopeRad);
        const plank = new THREE.BoxGeometry(width, 0.14, (length / plankCount) * 0.88);
        plank.rotateX(slopeRad);
        plank.translate(0, ly + 0.45, lz * cosS);
        woodGeos.push(plank);
      }

      const lip = new THREE.BoxGeometry(width + 0.4, 0.22, 0.35);
      lip.translate(0, length * sinS + 0.45, length * cosS);
      brassGeos.push(lip);

      const mergedWood = mergeGeometries(woodGeos.map(cleanGeo), false);
      woodGeos.forEach((p) => p.dispose());
      if (mergedWood) {
        mergedWood.rotateY(heading);
        mergedWood.translate(cx, cy, cz);
        woodParts.push(mergedWood);
      }

      const mergedBrass = mergeGeometries(brassGeos.map(cleanGeo), false);
      brassGeos.forEach((p) => p.dispose());
      if (mergedBrass) {
        mergedBrass.rotateY(heading);
        mergedBrass.translate(cx, cy, cz);
        brassParts.push(mergedBrass);
      }
    };

    // 10. Ancient Watchtower Builder
    const makeAncientWatchtower = (
      cx: number,
      cy: number,
      cz: number,
      baseRadius = 3.2,
      height = 18.0,
    ): void => {
      const stoneGeos: THREE.BufferGeometry[] = [];
      const brassGeos: THREE.BufferGeometry[] = [];

      const plinth = new THREE.CylinderGeometry(baseRadius * 1.25, baseRadius * 1.35, 1.8, 8);
      plinth.translate(0, 0.9, 0);
      stoneGeos.push(plinth);

      const shaft = new THREE.CylinderGeometry(baseRadius * 0.85, baseRadius * 1.1, height - 3.5, 8);
      shaft.translate(0, (height - 3.5) * 0.5 + 1.8, 0);
      stoneGeos.push(shaft);

      const parapet = new THREE.CylinderGeometry(baseRadius * 1.2, baseRadius * 0.95, 1.6, 8);
      parapet.translate(0, height - 1.0, 0);
      stoneGeos.push(parapet);

      const roof = new THREE.ConeGeometry(baseRadius * 1.25, 4.5, 8);
      roof.translate(0, height + 2.2, 0);
      stoneGeos.push(roof);

      const finial = new THREE.CylinderGeometry(0.06, 0.06, 2.4, 6);
      finial.translate(0, height + 5.2, 0);
      const finialBall = new THREE.SphereGeometry(0.32, 8, 8);
      finialBall.translate(0, height + 4.8, 0);
      brassGeos.push(finial, finialBall);

      const mergedStone = mergeGeometries(stoneGeos.map(cleanGeo), false);
      stoneGeos.forEach((p) => p.dispose());
      if (mergedStone) {
        mergedStone.translate(cx, cy, cz);
        stoneParts.push(mergedStone);
      }

      const mergedBrass = mergeGeometries(brassGeos.map(cleanGeo), false);
      brassGeos.forEach((p) => p.dispose());
      if (mergedBrass) {
        mergedBrass.translate(cx, cy, cz);
        brassParts.push(mergedBrass);
      }
    };

    // 11. Suspension Bridge Builder
    const makeSuspensionBridge = (
      p1: THREE.Vector3,
      p2: THREE.Vector3,
      width = 2.8,
      sag = 3.2,
      plankCount = 28,
    ): void => {
      const woodGeos: THREE.BufferGeometry[] = [];
      const stoneGeos: THREE.BufferGeometry[] = [];

      for (const p of [p1, p2]) {
        const abutment = new THREE.BoxGeometry(width + 1.8, 3.5, 3.5);
        abutment.translate(p.x, p.y - 1.5, p.z);
        stoneGeos.push(abutment);
      }

      const dir = p2.clone().sub(p1);
      const length = dir.length();
      const forward = dir.clone().normalize();
      const right = new THREE.Vector3(forward.z, 0, -forward.x).normalize();
      const yaw = Math.atan2(-forward.x, -forward.z);

      for (let i = 0; i <= plankCount; i++) {
        const f = i / plankCount;
        const pt = p1.clone().lerp(p2, f);
        pt.y += Math.sin(f * Math.PI) * -sag;

        const plank = new THREE.BoxGeometry(width, 0.14, (length / plankCount) * 0.85);
        plank.rotateY(yaw);
        plank.translate(pt.x, pt.y, pt.z);
        woodGeos.push(plank);
      }

      for (const side of [-1, 1]) {
        const cablePts: THREE.Vector3[] = [];
        for (let s = 0; s <= 20; s++) {
          const f = s / 20;
          const pt = p1.clone().lerp(p2, f);
          pt.y += Math.sin(f * Math.PI) * -sag + 1.2;
          pt.addScaledVector(right, side * (width * 0.5));
          cablePts.push(pt);
        }
        const cableCurve = new THREE.CatmullRomCurve3(cablePts, false, 'centripetal');
        const cableTube = new THREE.TubeGeometry(cableCurve, 20, 0.045, 5, false);
        woodGeos.push(cableTube);
      }

      const mergedWood = mergeGeometries(woodGeos.map(cleanGeo), false);
      woodGeos.forEach((p) => p.dispose());
      if (mergedWood) woodParts.push(mergedWood);

      const mergedStone = mergeGeometries(stoneGeos.map(cleanGeo), false);
      stoneGeos.forEach((p) => p.dispose());
      if (mergedStone) stoneParts.push(mergedStone);
    };

    // 12. Ancient Colonnade Ruin Builder
    const makeAncientColonnade = (
      p1: THREE.Vector3,
      p2: THREE.Vector3,
      columnRadius = 0.55,
      columnHeight = 5.5,
      count = 6,
    ): void => {
      const parts: THREE.BufferGeometry[] = [];
      const dir = p2.clone().sub(p1);
      const length = dir.length();
      const forward = dir.clone().normalize();
      const yaw = Math.atan2(-forward.x, -forward.z);

      const base = new THREE.BoxGeometry(columnRadius * 3.5, 0.45, length + 2.0);
      base.rotateY(yaw);
      const mid = p1.clone().add(p2).multiplyScalar(0.5);
      base.translate(mid.x, mid.y + 0.225, mid.z);
      parts.push(base);

      for (let i = 0; i < count; i++) {
        const f = i / (count - 1);
        const pt = p1.clone().lerp(p2, f);

        const col = new THREE.CylinderGeometry(columnRadius * 0.85, columnRadius, columnHeight, 10);
        col.translate(pt.x, pt.y + 0.45 + columnHeight * 0.5, pt.z);
        parts.push(col);

        const cap = new THREE.BoxGeometry(columnRadius * 2.4, 0.35, columnRadius * 2.4);
        cap.translate(pt.x, pt.y + 0.45 + columnHeight + 0.175, pt.z);
        parts.push(cap);
      }

      const beamLength = (length / (count - 1)) * 0.95;
      for (let i = 0; i < count - 1; i++) {
        if (i === 2) continue;
        const f0 = i / (count - 1);
        const f1 = (i + 1) / (count - 1);
        const pt0 = p1.clone().lerp(p2, f0);
        const pt1 = p1.clone().lerp(p2, f1);
        const bMid = pt0.clone().add(pt1).multiplyScalar(0.5);

        const beam = new THREE.BoxGeometry(columnRadius * 2.1, 0.65, beamLength);
        beam.rotateY(yaw);
        beam.translate(bMid.x, bMid.y + 0.45 + columnHeight + 0.65, bMid.z);
        parts.push(beam);
      }

      const merged = mergeGeometries(parts.map(cleanGeo), false);
      parts.forEach((p) => p.dispose());
      if (merged) stoneParts.push(merged);
    };

    // 13. Sky Aqueduct Viaduct Builder (Roman Multi-Arch Flying Conduit with Fly-Through Arches)
    const makeSkyAqueductViaduct = (
      p1: THREE.Vector3,
      p2: THREE.Vector3,
      archCount = 5,
      height = 14.0,
      width = 3.8,
      isDoubleTier = true,
    ): void => {
      const parts: THREE.BufferGeometry[] = [];
      const dir = p2.clone().sub(p1);
      const length = dir.length();
      const forward = dir.clone().normalize();
      const span = length / archCount;
      const yaw = Math.atan2(-forward.x, -forward.z);

      // Stone Pier Columns with stepped plinths
      for (let i = 0; i <= archCount; i++) {
        const f = i / archCount;
        const pt = p1.clone().lerp(p2, f);

        const pier = new THREE.BoxGeometry(width * 0.92, height, width * 0.92);
        pier.rotateY(yaw);
        pier.translate(pt.x, pt.y - height * 0.5, pt.z);
        parts.push(pier);

        const capital = new THREE.BoxGeometry(width * 1.25, 0.85, width * 1.25);
        capital.rotateY(yaw);
        capital.translate(pt.x, pt.y - 0.42, pt.z);
        parts.push(capital);

        if (i % 2 === 0) {
          const ivy = new THREE.CylinderGeometry(0.18, 0.08, height * 0.65, 5);
          ivy.translate(pt.x + (forward.z * width * 0.5), pt.y - height * 0.35, pt.z - (forward.x * width * 0.5));
          foliageParts.push(ivy);
        }
      }

      // Upper Water Conduit Trough & Stone Parapet Side Walls
      const conduit = new THREE.BoxGeometry(width, 1.6, length + 2.0);
      conduit.rotateY(yaw);
      const mid = p1.clone().add(p2).multiplyScalar(0.5);
      conduit.translate(mid.x, mid.y + 0.8, mid.z);
      parts.push(conduit);

      // Left and Right Balustrades / Parapets
      const rightVec = new THREE.Vector3(forward.z, 0, -forward.x).normalize();
      for (const side of [-1, 1]) {
        const parapet = new THREE.BoxGeometry(0.38, 0.95, length + 2.2);
        parapet.rotateY(yaw);
        const paraPos = mid.clone().addScaledVector(rightVec, side * (width * 0.5 - 0.19));
        parapet.translate(paraPos.x, paraPos.y + 1.85, paraPos.z);
        parts.push(parapet);

        for (let i = 1; i < archCount; i++) {
          const f = i / archCount;
          const pt = p1.clone().lerp(p2, f).addScaledVector(rightVec, side * (width * 0.5 + 0.35));
          const gargoyle = new THREE.CylinderGeometry(0.12, 0.18, 0.75, 6);
          gargoyle.rotateX(Math.PI / 2);
          gargoyle.rotateY(yaw);
          gargoyle.translate(pt.x, pt.y + 0.6, pt.z);
          brassParts.push(gargoyle);
        }
      }

      // Vaulted Arches (Tier 1)
      for (let i = 0; i < archCount; i++) {
        const f0 = i / archCount;
        const f1 = (i + 1) / archCount;
        const pt0 = p1.clone().lerp(p2, f0);
        const pt1 = p1.clone().lerp(p2, f1);
        const bMid = pt0.clone().add(pt1).multiplyScalar(0.5);

        const archRadius = span * 0.44;
        const arch = new THREE.TorusGeometry(archRadius, width * 0.38, 8, 14, Math.PI);
        arch.rotateX(Math.PI / 2);
        arch.rotateY(yaw);
        arch.translate(bMid.x, bMid.y - archRadius * 0.85, bMid.z);
        parts.push(arch);

        const keystone = new THREE.BoxGeometry(width * 0.82, 0.95, 0.75);
        keystone.rotateY(yaw);
        keystone.translate(bMid.x, bMid.y - 0.2, bMid.z);
        parts.push(keystone);
      }

      // Optional Double Tier Lower Vaults
      if (isDoubleTier && height > 12.0) {
        const lowerYOffset = -height * 0.52;
        const lowerBeam = new THREE.BoxGeometry(width * 0.95, 0.75, length);
        lowerBeam.rotateY(yaw);
        lowerBeam.translate(mid.x, mid.y + lowerYOffset, mid.z);
        parts.push(lowerBeam);

        for (let i = 0; i < archCount; i++) {
          const f0 = i / archCount;
          const f1 = (i + 1) / archCount;
          const pt0 = p1.clone().lerp(p2, f0);
          const pt1 = p1.clone().lerp(p2, f1);
          const bMid = pt0.clone().add(pt1).multiplyScalar(0.5);

          const lowerArch = new THREE.TorusGeometry(span * 0.40, width * 0.32, 6, 12, Math.PI);
          lowerArch.rotateX(Math.PI / 2);
          lowerArch.rotateY(yaw);
          lowerArch.translate(bMid.x, bMid.y + lowerYOffset - span * 0.32, bMid.z);
          parts.push(lowerArch);
        }
      }

      const merged = mergeGeometries(parts.map(cleanGeo), false);
      parts.forEach((p) => p.dispose());
      if (merged) stoneParts.push(merged);
    };

    // 14. Ancient Sun Temple Rotunda Builder
    const makeAncientSunTemple = (
      cx: number,
      cy: number,
      cz: number,
      radius = 10.5,
      columnCount = 8,
      columnHeight = 6.5,
    ): void => {
      const stoneGeos: THREE.BufferGeometry[] = [];
      const brassGeos: THREE.BufferGeometry[] = [];

      const step1 = new THREE.CylinderGeometry(radius * 1.35, radius * 1.40, 0.55, 16);
      step1.translate(cx, cy + 0.275, cz);
      stoneGeos.push(step1);

      const step2 = new THREE.CylinderGeometry(radius * 1.20, radius * 1.25, 0.50, 16);
      step2.translate(cx, cy + 0.75, cz);
      stoneGeos.push(step2);

      const floorDais = new THREE.CylinderGeometry(radius * 1.05, radius * 1.10, 0.45, 16);
      floorDais.translate(cx, cy + 1.15, cz);
      stoneGeos.push(floorDais);

      const altarBase = new THREE.CylinderGeometry(2.4, 2.8, 1.4, 10);
      altarBase.translate(cx, cy + 2.05, cz);
      stoneGeos.push(altarBase);

      const altarSunDisc = new THREE.CylinderGeometry(1.6, 1.6, 0.25, 12);
      altarSunDisc.translate(cx, cy + 2.85, cz);
      brassGeos.push(altarSunDisc);

      for (let i = 0; i < columnCount; i++) {
        const ang = (i / columnCount) * Math.PI * 2;
        const colX = cx + Math.cos(ang) * radius;
        const colZ = cz + Math.sin(ang) * radius;

        const colPlinth = new THREE.BoxGeometry(1.4, 0.4, 1.4);
        colPlinth.translate(colX, cy + 1.55, colZ);
        stoneGeos.push(colPlinth);

        const colShaft = new THREE.CylinderGeometry(0.55, 0.65, columnHeight, 10);
        colShaft.translate(colX, cy + 1.75 + columnHeight * 0.5, colZ);
        stoneGeos.push(colShaft);

        const colCap = new THREE.BoxGeometry(1.5, 0.55, 1.5);
        colCap.translate(colX, cy + 1.75 + columnHeight + 0.275, colZ);
        stoneGeos.push(colCap);

        const ivy = new THREE.CylinderGeometry(0.14, 0.06, columnHeight * 0.85, 5);
        ivy.translate(colX + 0.35, cy + 1.75 + columnHeight * 0.45, colZ + 0.35);
        foliageParts.push(ivy);
      }

      for (let i = 0; i < columnCount; i++) {
        if (i === 3) continue;
        const ang0 = (i / columnCount) * Math.PI * 2;
        const ang1 = ((i + 1) / columnCount) * Math.PI * 2;
        const pA = new THREE.Vector3(cx + Math.cos(ang0) * radius, cy + 1.75 + columnHeight + 0.85, cz + Math.sin(ang0) * radius);
        const pB = new THREE.Vector3(cx + Math.cos(ang1) * radius, cy + 1.75 + columnHeight + 0.85, cz + Math.sin(ang1) * radius);
        const beamMid = pA.clone().add(pB).multiplyScalar(0.5);
        const beamLen = pA.distanceTo(pB);
        const beamYaw = Math.atan2(-(pB.x - pA.x), -(pB.z - pA.z));

        const beam = new THREE.BoxGeometry(1.1, 0.85, beamLen + 0.3);
        beam.rotateY(beamYaw);
        beam.translate(beamMid.x, beamMid.y, beamMid.z);
        stoneGeos.push(beam);

        const medallion = new THREE.CylinderGeometry(0.35, 0.35, 0.15, 8);
        medallion.rotateX(Math.PI / 2);
        medallion.rotateY(beamYaw);
        medallion.translate(beamMid.x, beamMid.y, beamMid.z);
        brassGeos.push(medallion);
      }

      const mergedStone = mergeGeometries(stoneGeos.map(cleanGeo), false);
      stoneGeos.forEach((p) => p.dispose());
      if (mergedStone) stoneParts.push(mergedStone);

      const mergedBrass = mergeGeometries(brassGeos.map(cleanGeo), false);
      brassGeos.forEach((p) => p.dispose());
      if (mergedBrass) brassParts.push(mergedBrass);
    };

    // 15. Ancient Sundial Ruin Builder
    const makeAncientSundialRuin = (
      cx: number,
      cy: number,
      cz: number,
      radius = 3.2,
    ): void => {
      const stoneGeos: THREE.BufferGeometry[] = [];
      const brassGeos: THREE.BufferGeometry[] = [];

      const plinth = new THREE.CylinderGeometry(radius * 1.15, radius * 1.3, 0.65, 8);
      plinth.translate(cx, cy + 0.325, cz);
      stoneGeos.push(plinth);

      const dialBase = new THREE.CylinderGeometry(radius * 0.95, radius * 1.05, 0.45, 8);
      dialBase.translate(cx, cy + 0.85, cz);
      stoneGeos.push(dialBase);

      const dialPlate = new THREE.CylinderGeometry(radius * 0.82, radius * 0.82, 0.22, 16);
      dialPlate.translate(cx, cy + 1.15, cz);
      stoneGeos.push(dialPlate);

      const gnomon = new THREE.ConeGeometry(0.18, 2.2, 4);
      gnomon.rotateX(0.75);
      gnomon.rotateY(0.42);
      gnomon.translate(cx, cy + 1.95, cz);
      brassGeos.push(gnomon);

      const mast = new THREE.CylinderGeometry(0.08, 0.12, 6.5, 6);
      mast.translate(cx + radius * 0.65, cy + 3.4, cz + radius * 0.65);
      brassGeos.push(mast);

      const mastFinial = new THREE.SphereGeometry(0.32, 8, 8);
      mastFinial.translate(cx + radius * 0.65, cy + 6.75, cz + radius * 0.65);
      brassGeos.push(mastFinial);

      const weathervaneArrow = new THREE.BoxGeometry(0.12, 0.24, 1.8);
      weathervaneArrow.rotateY(0.65);
      weathervaneArrow.translate(cx + radius * 0.65, cy + 6.6, cz + radius * 0.65);
      brassGeos.push(weathervaneArrow);

      const mergedStone = mergeGeometries(stoneGeos.map(cleanGeo), false);
      stoneGeos.forEach((p) => p.dispose());
      if (mergedStone) stoneParts.push(mergedStone);

      const mergedBrass = mergeGeometries(brassGeos.map(cleanGeo), false);
      brassGeos.forEach((p) => p.dispose());
      if (mergedBrass) brassParts.push(mergedBrass);
    };

    // 16. Suspended Prayer Pennants Builder (5-Color Solarpunk High-Wind Pennants)
    const makeSuspendedPrayerPennants = (
      p1: THREE.Vector3,
      p2: THREE.Vector3,
      pennantCount = 8,
      sag = 2.0,
    ): void => {
      const woodGeos: THREE.BufferGeometry[] = [];
      const dir = p2.clone().sub(p1);
      const length = dir.length();
      const forward = dir.clone().normalize();
      const yaw = Math.atan2(-forward.x, -forward.z);

      const cablePts: THREE.Vector3[] = [];
      for (let s = 0; s <= 16; s++) {
        const f = s / 16;
        const pt = p1.clone().lerp(p2, f);
        pt.y -= Math.sin(f * Math.PI) * sag;
        cablePts.push(pt);
      }
      const cableCurve = new THREE.CatmullRomCurve3(cablePts, false, 'centripetal');
      const cableTube = new THREE.TubeGeometry(cableCurve, 16, 0.035, 4, false);
      woodGeos.push(cableTube);

      for (let i = 1; i < pennantCount; i++) {
        const f = i / pennantCount;
        const pt = p1.clone().lerp(p2, f);
        pt.y -= Math.sin(f * Math.PI) * sag;

        const pennantW = (length / pennantCount) * 0.65;
        const pennantH = 0.95 + (i % 3) * 0.25;
        const pennant = new THREE.BoxGeometry(pennantW, pennantH, 0.04);
        pennant.rotateY(yaw + 0.25 * Math.sin(i * 1.5));
        pennant.translate(pt.x, pt.y - pennantH * 0.5, pt.z);

        const colorIdx = i % 5;
        if (colorIdx === 0) coralGoldParts.push(pennant);
        else if (colorIdx === 1) coralTealParts.push(pennant);
        else if (colorIdx === 2) coralPinkParts.push(pennant);
        else if (colorIdx === 3) foliageParts.push(pennant);
        else wallParts.push(pennant);
      }

      const mergedWood = mergeGeometries(woodGeos.map(cleanGeo), false);
      woodGeos.forEach((p) => p.dispose());
      if (mergedWood) woodParts.push(mergedWood);
    };

    // 14. Coral Atoll Builder
    const makeCoralAtoll = (
      cx: number,
      cz: number,
      radius: number,
      innerRadius: number,
      lobeCount = 6,
      seed = 0,
    ): void => {
      const segments = 24;
      const sandPos: number[] = [];
      const sandUvs: number[] = [];
      const sandIdx: number[] = [];

      const reefPos: number[] = [];
      const reefUvs: number[] = [];
      const reefIdx: number[] = [];

      for (let i = 0; i < segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        const lobe = 1.0 + Math.sin(angle * lobeCount + seed) * 0.18 + Math.cos(angle * 2 + seed * 1.4) * 0.08;
        const rOut = radius * lobe;
        const rIn = innerRadius * (1.0 + Math.cos(angle * lobeCount + seed) * 0.12);

        const ox = cx + Math.cos(angle) * rOut;
        const oz = cz + Math.sin(angle) * rOut;
        const ix = cx + Math.cos(angle) * rIn;
        const iz = cz + Math.sin(angle) * rIn;

        // Submerged natural reef flat beneath clear turquoise ocean
        sandPos.push(ox, -1.85, oz, ix, -1.45, iz);
        sandUvs.push(Math.cos(angle) * 0.5 + 0.5, Math.sin(angle) * 0.5 + 0.5, 0.5, 0.5);

        reefPos.push(ox, -1.85, oz, cx + Math.cos(angle) * (rOut * 1.35), -5.2, cz + Math.sin(angle) * (rOut * 1.35));
        reefUvs.push(i / segments, 1.0, i / segments, 0.0);
      }

      for (let i = 0; i < segments; i++) {
        const nextI = (i + 1) % segments;
        const a = i * 2;
        const b = i * 2 + 1;
        const c = nextI * 2;
        const d = nextI * 2 + 1;
        sandIdx.push(a, c, b, b, c, d);
        reefIdx.push(a, c, b, b, c, d);
      }

      const sandGeo = new THREE.BufferGeometry();
      sandGeo.setAttribute('position', new THREE.Float32BufferAttribute(sandPos, 3));
      sandGeo.setAttribute('uv', new THREE.Float32BufferAttribute(sandUvs, 2));
      sandGeo.setIndex(sandIdx);
      sandGeo.computeVertexNormals();
      sandParts.push(sandGeo);

      const reefGeo = new THREE.BufferGeometry();
      reefGeo.setAttribute('position', new THREE.Float32BufferAttribute(reefPos, 3));
      reefGeo.setAttribute('uv', new THREE.Float32BufferAttribute(reefUvs, 2));
      reefGeo.setIndex(reefIdx);
      reefGeo.computeVertexNormals();
      coralTealParts.push(reefGeo);
    };

    // 15. Coral Cluster Builder
    const makeCoralCluster = (cx: number, cy: number, cz: number, scale = 1.0, type = 0, colorTarget = 'pink'): void => {
      const parts: THREE.BufferGeometry[] = [];
      if (type === 0) {
        for (let b = 0; b < 5; b++) {
          const angle = (b / 5) * Math.PI * 2 + b * 0.3;
          const branch = new THREE.CylinderGeometry(0.12 * scale, 0.22 * scale, 1.8 * scale, 6);
          branch.rotateZ(0.35);
          branch.rotateY(angle);
          branch.translate(cx + Math.cos(angle) * 0.4 * scale, cy + 0.9 * scale, cz + Math.sin(angle) * 0.4 * scale);
          parts.push(branch);
        }
      } else {
        for (let t = 0; t < 3; t++) {
          const disc = new THREE.CylinderGeometry((1.2 - t * 0.25) * scale, (1.1 - t * 0.25) * scale, 0.18 * scale, 8);
          disc.rotateZ(t * 0.1);
          disc.translate(cx + (t - 1) * 0.3 * scale, cy + (0.4 + t * 0.5) * scale, cz + (t % 2) * 0.2 * scale);
          parts.push(disc);
        }
      }
      const merged = mergeGeometries(parts.map(cleanGeo), false);
      parts.forEach((p) => p.dispose());
      if (merged) {
        if (colorTarget === 'pink') coralPinkParts.push(merged);
        else if (colorTarget === 'teal') coralTealParts.push(merged);
        else coralGoldParts.push(merged);
      }
    };

    // 16. Foliage Cluster Builder
    const makeFoliageCluster = (cx: number, cy: number, cz: number, scale = 1.0, count = 4, seed = 0): void => {
      const parts: THREE.BufferGeometry[] = [];
      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2 + seed;
        const r = i === 0 ? 0 : 0.85 * scale;
        const fY = i === 0 ? 0.7 * scale : 0.4 * scale;
        const fRadius = i === 0 ? 1.4 * scale : 1.0 * scale;

        const sphere = new THREE.DodecahedronGeometry(fRadius, 1);
        sphere.scale(1.0, 0.82, 1.0);
        sphere.translate(cx + Math.cos(angle) * r, cy + fY, cz + Math.sin(angle) * r);
        parts.push(sphere);
      }
      const merged = mergeGeometries(parts.map(cleanGeo), false);
      parts.forEach((p) => p.dispose());
      if (merged) foliageParts.push(merged);
    };

    // 17. Seagull Mesh Builder (Low-Poly Hand-Drawn Ghibli Seagull)
    const buildSeagullMesh = (): { group: THREE.Group; wingLeft: THREE.Object3D; wingRight: THREE.Object3D } => {
      const group = new THREE.Group();
      group.name = 'scenery-seagull';

      const bodyGeo = new THREE.ConeGeometry(0.22, 1.1, 6);
      bodyGeo.rotateX(Math.PI / 2);
      const headGeo = new THREE.SphereGeometry(0.18, 6, 6);
      headGeo.translate(0, 0.08, 0.52);
      const mergedBody = mergeGeometries([cleanGeo(bodyGeo), cleanGeo(headGeo)], false)!;
      const bodyMesh = new THREE.Mesh(
        mergedBody,
        createToonMaterial({ color: PALETTE.seagullWhite, shadowTint: PALETTE.skyMid, emissive: PALETTE.seagullWhite, emissiveIntensity: 0.12 }),
      );
      addOutline(bodyMesh, { width: 0.45 });
      markInk(bodyMesh);
      group.add(bodyMesh);

      const beakGeo = new THREE.ConeGeometry(0.06, 0.26, 5);
      beakGeo.rotateX(Math.PI / 2);
      beakGeo.translate(0, 0.04, 0.72);
      const beakMesh = new THREE.Mesh(
        cleanGeo(beakGeo),
        createToonMaterial({ color: PALETTE.seagullBeak, emissive: PALETTE.seagullBeak, emissiveIntensity: 0.3 }),
      );
      group.add(beakMesh);

      const wingLeftGroup = new THREE.Group();
      wingLeftGroup.position.set(0.14, 0.05, 0.05);
      const wingLGeo = new THREE.BufferGeometry();
      wingLGeo.setAttribute('position', new THREE.Float32BufferAttribute([
        0, 0, 0.18,
        1.1, 0.04, -0.05,
        0, 0, -0.22,
        1.1, 0.04, -0.05,
        1.7, 0.02, -0.15,
        0.7, 0.03, -0.28,
      ], 3));
      wingLGeo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 0.6, 0, 0, 0, 0.6, 0, 1, 0, 0.4, 0], 2));
      wingLGeo.setIndex([0, 1, 2, 1, 4, 5, 2, 1, 5]);
      wingLGeo.computeVertexNormals();
      const wingLMesh = new THREE.Mesh(
        wingLGeo,
        createToonMaterial({ color: PALETTE.seagullWhite, shadowTint: PALETTE.seagullWingGrey }),
      );
      addOutline(wingLMesh, { width: 0.45 });
      markInk(wingLMesh);
      wingLeftGroup.add(wingLMesh);
      group.add(wingLeftGroup);

      const wingRightGroup = new THREE.Group();
      wingRightGroup.position.set(-0.14, 0.05, 0.05);
      const wingRGeo = new THREE.BufferGeometry();
      wingRGeo.setAttribute('position', new THREE.Float32BufferAttribute([
        0, 0, 0.18,
        0, 0, -0.22,
        -1.1, 0.04, -0.05,
        -1.1, 0.04, -0.05,
        -0.7, 0.03, -0.28,
        -1.7, 0.02, -0.15,
      ], 3));
      wingRGeo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 0, 0, 0.6, 0, 0.6, 0, 0.4, 0, 1, 0], 2));
      wingRGeo.setIndex([0, 1, 2, 3, 4, 5, 1, 4, 3]);
      wingRGeo.computeVertexNormals();
      const wingRMesh = new THREE.Mesh(
        wingRGeo,
        createToonMaterial({ color: PALETTE.seagullWhite, shadowTint: PALETTE.seagullWingGrey }),
      );
      addOutline(wingRMesh, { width: 0.45 });
      markInk(wingRMesh);
      wingRightGroup.add(wingRMesh);
      group.add(wingRightGroup);

      return { group, wingLeft: wingLeftGroup, wingRight: wingRightGroup };
    };

    // 18. Leaping Dolphin Builder
    const buildDolphinMesh = (): THREE.Group => {
      const group = new THREE.Group();
      group.name = 'scenery-dolphin';

      const bodyGeo = new THREE.ConeGeometry(0.55, 3.2, 8);
      bodyGeo.rotateX(Math.PI / 2);
      const snoutGeo = new THREE.SphereGeometry(0.35, 8, 8);
      snoutGeo.scale(0.85, 0.65, 1.4);
      snoutGeo.translate(0, -0.05, 1.4);

      const finGeo = new THREE.BufferGeometry();
      finGeo.setAttribute('position', new THREE.Float32BufferAttribute([
        0, 0.4, 0.2,
        0, 1.15, -0.45,
        0, 0.35, -0.65,
      ], 3));
      finGeo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 0.5, 1, 1, 0], 2));
      finGeo.setIndex([0, 1, 2, 0, 2, 1]);
      finGeo.computeVertexNormals();

      const tailGeo = new THREE.BufferGeometry();
      tailGeo.setAttribute('position', new THREE.Float32BufferAttribute([
        0, 0, -1.5,
        0.85, 0.05, -2.1,
        -0.85, 0.05, -2.1,
        0, 0, -1.8,
      ], 3));
      tailGeo.setAttribute('uv', new THREE.Float32BufferAttribute([0.5, 0, 1, 1, 0, 1, 0.5, 0.5], 2));
      tailGeo.setIndex([0, 1, 3, 0, 3, 2]);
      tailGeo.computeVertexNormals();

      const merged = mergeGeometries([cleanGeo(bodyGeo), cleanGeo(snoutGeo), cleanGeo(finGeo), cleanGeo(tailGeo)], false)!;
      const dolphinMat = createToonMaterial({
        color: PALETTE.dolphinBody,
        shadowTint: PALETTE.seaDeep,
        emissive: PALETTE.dolphinBody,
        emissiveIntensity: 0.1,
      });
      const mesh = new THREE.Mesh(merged, dolphinMat);
      addOutline(mesh, { width: 0.65 });
      markInk(mesh);
      group.add(mesh);

      return group;
    };

    const buildSplashRing = (): THREE.Mesh => {
      const ringGeo = new THREE.RingGeometry(0.4, 2.2, 16);
      ringGeo.rotateX(-Math.PI / 2);
      const ringMat = new THREE.MeshBasicMaterial({
        color: PALETTE.foam,
        transparent: true,
        opacity: 0.8,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(ringGeo, ringMat);
      mesh.layers.disable(LAYER_INK);
      mesh.layers.enable(LAYER_ENERGY);
      return mesh;
    };

    // 19. Dandelion Spores & Floating Grass Particles
    const buildDandelionSpores = (): void => {
      const count = 160;
      const pos = new Float32Array(count * 3);
      const base = new Float32Array(count * 3);

      for (let i = 0; i < count; i++) {
        const side = i % 2 === 0 ? -1 : 1;
        const x = side === -1 ? -40 - ((i * 3.7) % 45) : 35 + ((i * 3.7) % 40);
        const z = -20 + ((i * 7.1) % 340);
        const y = 8 + ((i * 2.3) % 30);

        pos[i * 3] = x;
        pos[i * 3 + 1] = y;
        pos[i * 3 + 2] = z;

        base[i * 3] = x;
        base[i * 3 + 1] = y;
        base[i * 3 + 2] = z;
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const mat = new THREE.PointsMaterial({
        color: PALETTE.sunCore,
        size: 0.55,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
      });
      const points = new THREE.Points(geo, mat);
      points.name = 'dandelion-spores';
      points.layers.disable(LAYER_INK);
      this.object.add(points);

      this.scenerySporesPoints = points;
      this.scenerySporesPositions = pos;
      this.scenerySporesBase = base;
    };

    // Helper: push triangle (a, b, c) with winding guaranteed to face along outward vector (ox, oy, oz)
    const pushTriOutward = (
      pos: readonly number[],
      idx: number[],
      a: number,
      b: number,
      c: number,
      ox: number,
      oy: number,
      oz: number,
    ): void => {
      const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
      const bx = pos[b * 3] - ax, by = pos[b * 3 + 1] - ay, bz = pos[b * 3 + 2] - az;
      const cx = pos[c * 3] - ax, cy = pos[c * 3 + 1] - ay, cz = pos[c * 3 + 2] - az;
      const nx = by * cz - bz * cy;
      const ny = bz * cx - bx * cz;
      const nz = bx * cy - by * cx;
      if (nx * ox + ny * oy + nz * oz >= 0) {
        idx.push(a, b, c);
      } else {
        idx.push(a, c, b);
      }
    };

    // 20. Sculpted Studio Ghibli Canyon Wall & Terraced Gorge Builder (吉卜力层岩大峡谷与翠绿台地)
    const makeGhibliCanyonWall = (
      spine: readonly [number, number, number][], // [x, z, peakHeight]
      baseHalfW: number,
      topHalfW: number,
      seed = 0,
      rockTarget: 'canyon' | 'chalk' = 'canyon',
    ): void => {
      if (spine.length < 2) return;
      const curvePts = spine.map(([x, z, h]) => new THREE.Vector3(x, h, z));
      const curve = new THREE.CatmullRomCurve3(curvePts, false, 'centripetal');
      const segsAlong = Math.max(20, (spine.length - 1) * 10);
      const layersY = 7;
      const ringVerts = segsAlong * 2 + 2;

      const pos: number[] = [];
      const uvs: number[] = [];
      const indices: number[] = [];
      const ringSpineX: number[] = [];
      const ringSpineZ: number[] = [];

      const pt = new THREE.Vector3();
      const tan = new THREE.Vector3();
      const samples: { x: number; z: number; h: number; nx: number; nz: number; u: number }[] = [];
      for (let i = 0; i <= segsAlong; i++) {
        const u = i / segsAlong;
        curve.getPoint(u, pt);
        curve.getTangent(u, tan);
        const il = 1 / (Math.hypot(tan.x, tan.z) || 1);
        const nx = -tan.z * il;
        const nz = tan.x * il;
        const endTaper = Math.sin(u * Math.PI);
        const taperFactor = 0.52 + 0.48 * Math.pow(endTaper, 0.45);
        const cragMod = 1.0 + Math.sin(u * 18.0 + seed) * 0.10 + Math.cos(u * 31.0 + seed * 1.7) * 0.06;
        samples.push({ x: pt.x, z: pt.z, h: pt.y * taperFactor * cragMod, nx, nz, u });
      }

      for (let l = 0; l < layersY; l++) {
        const fy = l / (layersY - 1);
        const shelfProfile =
          l === 0 ? 1.24 :
          l === 1 ? 1.02 :
          l === 2 ? 1.10 :
          l === 3 ? 0.94 :
          l === 4 ? 1.04 :
          l === 5 ? 0.88 : 0.82;

        for (let side = 0; side < 2; side++) {
          for (let k = 0; k <= segsAlong; k++) {
            const idx = side === 0 ? k : segsAlong - k;
            const s = samples[idx];
            const sign = side === 0 ? 1 : -1;
            const endWidthTaper = 0.38 + 0.62 * Math.pow(Math.sin(s.u * Math.PI), 0.38);
            const wBase = THREE.MathUtils.lerp(baseHalfW, topHalfW, Math.pow(fy, 0.78)) * shelfProfile * endWidthTaper;
            const ribNoise =
              Math.sin(s.u * 24.0 + seed * 1.3 + side * 2.1) * 0.16 +
              Math.cos(s.u * 42.0 + l * 1.4 + seed) * 0.09;
            const w = wBase * (1.0 + ribNoise);
            const y = -3.2 + (s.h + 3.2) * fy;
            pos.push(s.x + s.nx * sign * w, y, s.z + s.nz * sign * w);
            uvs.push(s.u, fy);
            if (l === 0) {
              ringSpineX.push(s.x);
              ringSpineZ.push(s.z);
            }
          }
        }
      }

      for (let l = 0; l < layersY - 1; l++) {
        for (let i = 0; i < ringVerts; i++) {
          const nextI = (i + 1) % ringVerts;
          const a = l * ringVerts + i;
          const b = l * ringVerts + nextI;
          const c = (l + 1) * ringVerts + i;
          const d = (l + 1) * ringVerts + nextI;
          const ox = pos[a * 3] - ringSpineX[i];
          const oz = pos[a * 3 + 2] - ringSpineZ[i];
          pushTriOutward(pos, indices, a, b, c, ox, 0.25, oz);
          pushTriOutward(pos, indices, b, d, c, ox, 0.25, oz);
        }
      }

      // Close top plateau & build lush Ghibli emerald grass terrace crown
      const topStart = (layersY - 1) * ringVerts;
      const grassPos: number[] = [];
      const grassUvs: number[] = [];
      const grassIdx: number[] = [];

      for (let k = 0; k <= segsAlong; k++) {
        const s = samples[k];
        const iPos = topStart + k;
        const iNeg = topStart + (ringVerts - 1 - k);
        if (k < segsAlong) {
          pushTriOutward(pos, indices, iPos, iNeg, iPos + 1, 0, 1, 0);
          pushTriOutward(pos, indices, iPos + 1, iNeg, iNeg - 1, 0, 1, 0);
        }
        const vxP = pos[iPos * 3];
        const vyP = pos[iPos * 3 + 1] + 0.18;
        const vzP = pos[iPos * 3 + 2];
        const vxN = pos[iNeg * 3];
        const vyN = pos[iNeg * 3 + 1] + 0.18;
        const vzN = pos[iNeg * 3 + 2];
        const crownY = s.h + 2.4 + Math.sin(s.u * 15.0 + seed) * 1.1;

        grassPos.push(
          vxP, vyP, vzP,
          s.x, crownY, s.z,
          vxN, vyN, vzN,
        );
        grassUvs.push(s.u, 0, s.u, 0.5, s.u, 1);
      }

      for (let k = 0; k < segsAlong; k++) {
        const b = k * 3;
        pushTriOutward(grassPos, grassIdx, b, b + 1, b + 3, 0, 1, 0);
        pushTriOutward(grassPos, grassIdx, b + 1, b + 4, b + 3, 0, 1, 0);
        pushTriOutward(grassPos, grassIdx, b + 1, b + 2, b + 4, 0, 1, 0);
        pushTriOutward(grassPos, grassIdx, b + 2, b + 5, b + 4, 0, 1, 0);
      }

      const rockGeo = new THREE.BufferGeometry();
      rockGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      rockGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      rockGeo.setIndex(indices);
      rockGeo.computeVertexNormals();
      if (rockTarget === 'chalk') chalkParts.push(rockGeo);
      else canyonParts.push(rockGeo);

      const grassGeo = new THREE.BufferGeometry();
      grassGeo.setAttribute('position', new THREE.Float32BufferAttribute(grassPos, 3));
      grassGeo.setAttribute('uv', new THREE.Float32BufferAttribute(grassUvs, 2));
      grassGeo.setIndex(grassIdx);
      grassGeo.computeVertexNormals();
      grassParts.push(grassGeo);
    };

    // 21. Panoramic Studio Ghibli Mountain Range Builder (吉卜力连绵山峦与叠翠远峰)
    const makeGhibliMountainRidge = (
      spine: readonly [number, number, number][], // [x, z, peakHeight]
      baseHalfW: number,
      seed = 0,
    ): void => {
      if (spine.length < 2) return;
      const curvePts = spine.map(([x, z, h]) => new THREE.Vector3(x, h, z));
      const curve = new THREE.CatmullRomCurve3(curvePts, false, 'centripetal');
      const segsAlong = Math.max(24, (spine.length - 1) * 10);
      const pt = new THREE.Vector3();
      const tan = new THREE.Vector3();

      const greenPos: number[] = [];
      const greenUvs: number[] = [];
      const greenIdx: number[] = [];

      const rockPos: number[] = [];
      const rockUvs: number[] = [];
      const rockIdx: number[] = [];

      for (let i = 0; i <= segsAlong; i++) {
        const u = i / segsAlong;
        curve.getPoint(u, pt);
        curve.getTangent(u, tan);
        const il = 1 / (Math.hypot(tan.x, tan.z) || 1);
        const nx = -tan.z * il;
        const nz = tan.x * il;

        const endEnvelope = Math.pow(Math.sin(u * Math.PI), 0.42);
        const peakOsc =
          Math.abs(Math.sin(u * Math.PI * (spine.length + 1) + seed)) * 0.28 +
          Math.sin(u * 27.0 + seed * 1.9) * 0.10;
        const h = Math.max(12.0, pt.y * (0.35 + 0.65 * endEnvelope) * (0.86 + peakOsc));
        const spurL = baseHalfW * (0.45 + 0.55 * endEnvelope) * (1.0 + Math.sin(u * 19.0 + seed) * 0.22);
        const spurR = baseHalfW * (0.45 + 0.55 * endEnvelope) * (1.0 + Math.cos(u * 17.0 + seed * 1.4) * 0.22);
        const ridgeShift = Math.sin(u * 23.0 + seed * 0.7) * baseHalfW * 0.12;

        const midHL = h * (0.58 + Math.sin(u * 14.0 + seed) * 0.08);
        const midHR = h * (0.56 + Math.cos(u * 16.0 + seed) * 0.08);
        const crestGreenH = h * 0.88;

        greenPos.push(
          pt.x - nx * spurL, -4.0, pt.z - nz * spurL,
          pt.x - nx * (spurL * 0.46), midHL, pt.z - nz * (spurL * 0.46),
          pt.x + nx * ridgeShift, crestGreenH, pt.z + nz * ridgeShift,
          pt.x + nx * (spurR * 0.46), midHR, pt.z + nz * (spurR * 0.46),
          pt.x + nx * spurR, -4.0, pt.z + nz * spurR,
        );
        greenUvs.push(u, 0, u, 0.35, u, 0.7, u, 0.35, u, 0);

        const cragW = baseHalfW * 0.28 * (0.4 + 0.6 * endEnvelope);
        const baseRockH = h * 0.48;
        rockPos.push(
          pt.x + nx * (ridgeShift - cragW), baseRockH, pt.z + nz * (ridgeShift - cragW),
          pt.x + nx * ridgeShift, h + 4.5, pt.z + nz * ridgeShift,
          pt.x + nx * (ridgeShift + cragW), baseRockH, pt.z + nz * (ridgeShift + cragW),
        );
        rockUvs.push(u, 0.4, u, 1.0, u, 0.4);
      }

      for (let i = 0; i < segsAlong; i++) {
        const g = i * 5;
        for (let s = 0; s < 4; s++) {
          pushTriOutward(greenPos, greenIdx, g + s, g + s + 1, g + 5 + s, 0, 1, 0);
          pushTriOutward(greenPos, greenIdx, g + s + 1, g + 5 + s + 1, g + 5 + s, 0, 1, 0);
        }
        const r = i * 3;
        for (let s = 0; s < 2; s++) {
          pushTriOutward(rockPos, rockIdx, r + s, r + s + 1, r + 3 + s, 0, 1, 0);
          pushTriOutward(rockPos, rockIdx, r + s + 1, r + 3 + s + 1, r + 3 + s, 0, 1, 0);
        }
      }

      const greenGeo = new THREE.BufferGeometry();
      greenGeo.setAttribute('position', new THREE.Float32BufferAttribute(greenPos, 3));
      greenGeo.setAttribute('uv', new THREE.Float32BufferAttribute(greenUvs, 2));
      greenGeo.setIndex(greenIdx);
      greenGeo.computeVertexNormals();
      mountainGreenParts.push(greenGeo);

      const rockGeo = new THREE.BufferGeometry();
      rockGeo.setAttribute('position', new THREE.Float32BufferAttribute(rockPos, 3));
      rockGeo.setAttribute('uv', new THREE.Float32BufferAttribute(rockUvs, 2));
      rockGeo.setIndex(rockIdx);
      rockGeo.computeVertexNormals();
      mountainRockParts.push(rockGeo);
    };

    // 22. Cascading Canyon Waterfall Builder (峡谷白练飞瀑与水雾潭)
    const makeGhibliWaterfall = (
      cx: number,
      cz: number,
      topY: number,
      yaw: number,
      width = 5.5,
    ): void => {
      const steps = 10;
      const pos: number[] = [];
      const uvs: number[] = [];
      const idx: number[] = [];
      const cosY = Math.cos(yaw);
      const sinY = Math.sin(yaw);

      for (let i = 0; i <= steps; i++) {
        const f = i / steps;
        const y = THREE.MathUtils.lerp(topY, -0.5, f);
        const forwardOut = Math.pow(f, 1.55) * 8.5 + Math.sin(f * Math.PI * 3) * 0.45;
        const halfW = width * 0.5 * (1.0 + f * 0.45);
        for (const side of [-1, 1]) {
          const lx = side * halfW;
          const lz = forwardOut;
          const wx = cx + lx * cosY + lz * sinY;
          const wz = cz - lx * sinY + lz * cosY;
          pos.push(wx, y, wz);
          uvs.push(side * 0.5 + 0.5, f);
        }
      }
      for (let i = 0; i < steps; i++) {
        const b = i * 2;
        pushTriOutward(pos, idx, b, b + 1, b + 2, sinY, 0.5, cosY);
        pushTriOutward(pos, idx, b + 1, b + 3, b + 2, sinY, 0.5, cosY);
      }

      // Foaming plunge pool disc at water surface
      const poolX = cx + 8.5 * sinY;
      const poolZ = cz + 8.5 * cosY;
      const poolGeo = new THREE.CylinderGeometry(width * 1.15, width * 1.35, 0.45, 14);
      poolGeo.translate(poolX, 0.18, poolZ);
      waterfallParts.push(poolGeo);

      const fallGeo = new THREE.BufferGeometry();
      fallGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      fallGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      fallGeo.setIndex(idx);
      fallGeo.computeVertexNormals();
      waterfallParts.push(fallGeo);
    };

    // ==================== ASSEMBLE WONDER SECTIONS ====================

    // --- Section 0: Panoramic Studio Ghibli Mountain Ranges & Sculpted Grand Canyons ---
    // 1. West Harbor Fjord Limestone & Emerald Canyon Wall (frames the starting straight)
    makeGhibliCanyonWall(
      [
        [-88, -110, 42],
        [-82, -20, 54],
        [-86, 90, 68],
        [-78, 205, 58],
        [-72, 325, 52],
        [-45, 425, 44],
      ],
      26,
      16,
      1.1,
      'chalk',
    );
    // 2. East Harbor Headland Canyon Wall
    makeGhibliCanyonWall(
      [
        [78, 70, 38],
        [82, 175, 52],
        [92, 265, 62],
        [135, 345, 48],
      ],
      24,
      15,
      2.3,
      'chalk',
    );
    // 3. Grand Sweeper & Chicane Gorge — North Towering Canyon Wall (峡谷天梯北壁)
    makeGhibliCanyonWall(
      [
        [45, 515, 56],
        [145, 548, 74],
        [255, 578, 88],
        [355, 572, 94],
        [445, 552, 82],
        [535, 505, 68],
      ],
      32,
      19,
      3.7,
      'canyon',
    );
    // 4. Grand Chicane Gorge — South Inner Canyon Wall (峡谷天梯南壁，形成壮丽夹道峡谷)
    makeGhibliCanyonWall(
      [
        [255, 392, 58],
        [325, 402, 72],
        [395, 396, 68],
        [452, 388, 56],
      ],
      24,
      14,
      4.9,
      'canyon',
    );
    // 5. East Loop & Laputa Corridor Canyon Amphitheater (东侧大回环峡谷绝壁)
    makeGhibliCanyonWall(
      [
        [555, 470, 74],
        [595, 365, 86],
        [588, 245, 78],
        [520, 145, 62],
      ],
      30,
      18,
      6.1,
      'canyon',
    );
    // 6. Hairpin & Airtime Straight East Coastal Canyon Ridge
    makeGhibliCanyonWall(
      [
        [345, 120, 56],
        [365, -10, 66],
        [340, -145, 58],
        [275, -245, 48],
      ],
      26,
      15,
      7.4,
      'chalk',
    );

    // Cascading Canyon Waterfalls plunging down the cliffs into the sea
    makeGhibliWaterfall(-64, 145, 48, 1.45, 5.2);
    makeGhibliWaterfall(220, 548, 72, 3.05, 6.8);
    makeGhibliWaterfall(335, 545, 78, 3.12, 7.5);
    makeGhibliWaterfall(425, 525, 66, 3.35, 6.0);
    makeGhibliWaterfall(562, 315, 70, -1.55, 6.5);

    // 360-Degree Studio Ghibli Horizon Mountain Ranges (宫崎骏式层峦叠嶂远景山脉)
    // North Alpine Massif (behind the Grand Canyon & Sweeper)
    makeGhibliMountainRidge(
      [
        [-320, 620, 135],
        [-110, 710, 185],
        [120, 760, 225],
        [360, 740, 210],
        [620, 670, 175],
        [820, 520, 140],
      ],
      95,
      1.5,
    );
    // East & Southeast High Mountain Chain (framing Laputa & the Loop)
    makeGhibliMountainRidge(
      [
        [760, 480, 165],
        [840, 260, 215],
        [810, 20, 195],
        [710, -210, 168],
        [540, -390, 135],
      ],
      90,
      2.8,
    );
    // South & Southwest Coastal Mountain Range (framing the Carousel & Harbor Approach)
    makeGhibliMountainRidge(
      [
        [480, -410, 145],
        [240, -490, 190],
        [-20, -480, 175],
        [-260, -410, 160],
        [-440, -250, 138],
      ],
      88,
      4.1,
    );
    // West Fjord Mountain Range (towering behind the Windmill Village)
    makeGhibliMountainRidge(
      [
        [-410, -220, 142],
        [-460, 20, 195],
        [-440, 260, 210],
        [-350, 490, 172],
        [-160, 640, 145],
      ],
      92,
      5.4,
    );

    // --- Section 1: Chalk Haven, Terracotta Windmill Village & Launch Pier ---
    makeGliderLaunchPier(13.0, -30.0, -17.0);

    // West Chalk Haven Promontory & Layered Grass Terraces
    makeChalkCapeCliff(-58, -35, 26, 22, 22, 18, 5, 1.2);
    makeChalkCapeCliff(-68, 85, 34, 28, 34, 18, 6, 2.5);
    makeAncientWatchtower(-68, 34, 85, 3.2, 18.0);
    makeChalkCapeCliff(-58, 210, 30, 25, 28, 18, 5, 3.8);
    makeGliderLaunchRamp(-48, 16, 195, -0.25, 7.5, 24.0, 14.0);
    makeChalkWindmill(-65, 28, 235, 4.0, 14.0);
    makeChalkCapeCliff(-52, 320, 25, 20, 26, 18, 5, 4.1);

    // West Terraces Mediterranean Village Cottages
    makeVillageHouse(-56, 22, -25, 0.4, 6.5, 8.5, 5.2, true, true);
    makeVillageHouse(-64, 22, -45, -0.3, 5.8, 7.2, 4.8, false, true);
    makeVillageHouse(-68, 34, 65, 0.6, 7.0, 9.0, 5.5, true, true);
    makeVillageHouse(-74, 34, 105, -0.2, 6.0, 8.0, 5.0, false, false);
    makeVillageHouse(-56, 28, 185, 0.8, 6.8, 8.2, 5.2, true, true);
    makeVillageHouse(-64, 28, 245, -0.5, 5.5, 7.5, 4.8, false, true);
    makeVillageHouse(-48, 26, 305, 0.3, 6.2, 7.8, 5.0, false, true);

    // East Headland Promontory & Coastal Village
    makeChalkCapeCliff(58, 195, 24, 19, 20, 16, 4, 5.2);
    makeGliderLaunchRamp(46, 14, 205, 0.35, 6.8, 22.0, 12.0);
    makeChalkCapeCliff(72, 280, 28, 23, 24, 16, 5, 6.1);
    makeChalkWindmill(70, 24, 275, 3.8, 13.0);

    makeVillageHouse(52, 20, 175, -0.7, 6.0, 7.5, 4.8, false, true);
    makeVillageHouse(60, 20, 215, 0.4, 6.8, 8.5, 5.2, true, true);
    makeVillageHouse(68, 24, 265, -0.3, 7.2, 9.0, 5.4, true, true);

    // Coastal Foliage Clusters
    makeFoliageCluster(-68, 34, 98, 2.5, 5, 1.1);
    makeFoliageCluster(-58, 28, 220, 2.8, 6, 2.3);
    makeFoliageCluster(56, 20, 185, 2.2, 4, 3.4);
    makeFoliageCluster(72, 24, 290, 2.6, 5, 4.5);

    // Living Ecosystem: Dandelion Spores
    buildDandelionSpores();

    // Living Ecosystem: Seagull Flocks
    const seagullConfigs = [
      { x: 0, y: 12, z: 40, r: 18, spd: 0.45, ph: 0.0, flap: 7.2, vAmp: 1.8 },
      { x: 5, y: 14, z: 90, r: 22, spd: 0.40, ph: 1.2, flap: 6.8, vAmp: 2.2 },
      { x: -6, y: 11, z: 140, r: 20, spd: 0.48, ph: 2.4, flap: 7.5, vAmp: 1.6 },
      { x: 4, y: 15, z: 180, r: 24, spd: 0.38, ph: 3.6, flap: 6.5, vAmp: 2.0 },
      { x: -3, y: 13, z: 70, r: 16, spd: 0.52, ph: 4.8, flap: 8.0, vAmp: 1.5 },
      { x: -62, y: 44, z: 95, r: 28, spd: 0.32, ph: 0.8, flap: 5.5, vAmp: 2.8 },
      { x: -55, y: 40, z: 190, r: 26, spd: 0.35, ph: 2.1, flap: 5.8, vAmp: 2.5 },
      { x: -68, y: 48, z: 240, r: 30, spd: 0.30, ph: 3.9, flap: 5.2, vAmp: 3.0 },
      { x: -48, y: 38, z: 290, r: 24, spd: 0.36, ph: 5.0, flap: 6.0, vAmp: 2.2 },
      { x: 58, y: 32, z: 210, r: 22, spd: 0.42, ph: 1.5, flap: 6.6, vAmp: 2.0 },
      { x: 65, y: 36, z: 270, r: 25, spd: 0.38, ph: 4.2, flap: 6.2, vAmp: 2.4 },
    ];

    for (const cfg of seagullConfigs) {
      const g = buildSeagullMesh();
      this.object.add(g.group);
      this.scenerySeagulls.push({
        group: g.group,
        wingLeft: g.wingLeft,
        wingRight: g.wingRight,
        baseX: cfg.x,
        baseY: cfg.y,
        baseZ: cfg.z,
        radius: cfg.r,
        speed: cfg.spd,
        phase: cfg.ph,
        flapFreq: cfg.flap,
        verticalAmp: cfg.vAmp,
      });
    }

    // Living Ecosystem: Leaping Dolphins in Shallow Coastal Waters
    const dolphinConfigs = [
      { sx: 18, sz: 60, ex: 24, ez: 110, y: 4.2, per: 6.5, ph: 0.0 },
      { sx: -16, sz: 120, ex: -10, ez: 175, y: 4.6, per: 7.2, ph: 0.35 },
      { sx: 22, sz: 190, ex: 30, ez: 250, y: 4.0, per: 6.8, ph: 0.7 },
      { sx: -20, sz: 240, ex: -14, ez: 300, y: 4.5, per: 7.5, ph: 0.2 },
      { sx: 40, sz: 320, ex: 55, ez: 375, y: 4.4, per: 6.2, ph: 0.55 },
    ];

    for (const cfg of dolphinConfigs) {
      const dGroup = buildDolphinMesh();
      const splash = buildSplashRing();
      this.object.add(dGroup);
      this.object.add(splash);
      this.sceneryLeapingCreatures.push({
        group: dGroup,
        splashRing: splash,
        startX: cfg.sx,
        startZ: cfg.sz,
        endX: cfg.ex,
        endZ: cfg.ez,
        peakY: cfg.y,
        period: cfg.per,
        phase: cfg.ph,
      });
    }

    // --- Section 2: Coral Reef Lagoon & Karst Sea Stacks ---
    makeCoralAtoll(115, 365, 28, 14, 6, 1.1);
    makeCoralAtoll(45, 460, 24, 10, 5, 2.2);
    makeCoralAtoll(185, 515, 22, 11, 6, 3.3);

    makeCoralCluster(110, 0.4, 355, 1.4, 0, 'pink');
    makeCoralCluster(125, 0.4, 375, 1.3, 1, 'gold');
    makeCoralCluster(40, 0.4, 450, 1.2, 1, 'pink');
    makeCoralCluster(190, 0.4, 485, 1.5, 0, 'gold');

    makeSeaStack(28, 415, 6.0, 3.5, 28.0, 12, 1.5);
    makeNaturalSeaArch(82, 495, 0.52, 38.0, 28.0, 18.0, 10.0, 18);
    makeSeaStack(155, 495, 6.5, 4.0, 26.0, 12, 2.7);
    makeSeaStack(225, 510, 7.0, 4.5, 30.0, 12, 3.9);

    // --- Section 3: Canyon Stairway & Cloud Terraces (Warm Terracotta Sandstone) ---
    makeCanyonCliff(270, 565, 32, 28, 44, 16, 5, 4.5);
    makeCanyonCliff(355, 560, 35, 30, 48, 16, 6, 5.7);
    makeCanyonCliff(440, 545, 30, 26, 42, 16, 5, 6.3);

    makeCanyonCliff(275, 395, 28, 24, 36, 16, 5, 7.1);
    makeCanyonCliff(365, 395, 32, 28, 40, 16, 5, 8.2);
    makeCanyonCliff(445, 395, 28, 24, 38, 16, 5, 9.4);

    makeCanyonCliff(310, 580, 20, 16, 20, 12, 3, 1.3);
    makeCanyonCliff(380, 570, 18, 14, 24, 12, 3, 2.4);
    makeCanyonCliff(440, 555, 18, 14, 28, 12, 4, 3.5);

    makeSuspensionBridge(new THREE.Vector3(300, 36, 565), new THREE.Vector3(295, 36, 395), 2.8, 3.5, 26);
    makeSuspensionBridge(new THREE.Vector3(385, 40, 560), new THREE.Vector3(380, 40, 395), 2.6, 3.0, 24);

    makeFoliageCluster(270, 44, 565, 3.2, 5, 4.2);
    makeFoliageCluster(355, 48, 560, 3.5, 6, 5.1);

    // --- Section 4: Laputa Floating Sky Continents & Cloud Sea Corridor (Y = 25m ~ 60m) ---
    // 1. Primary Laputa Continent & Ancient Colonnade Ruin
    makeLaputaFloatingIsland(510, 36, 340, 34, 26, 16, 1.8, true);
    makeAncientColonnade(new THREE.Vector3(494, 36, 326), new THREE.Vector3(526, 36, 354), 0.65, 6.2, 7);
    makeAncientSundialRuin(520, 36.2, 335, 3.4);
    makeSuspendedPrayerPennants(new THREE.Vector3(494, 42.5, 326), new THREE.Vector3(526, 42.5, 354), 9, 2.2);

    // 2. Secondary Sun Temple Island & High Sky Viaduct 1
    makeLaputaFloatingIsland(460, 44, 240, 28, 22, 16, 2.9, true);
    makeAncientSunTemple(460, 44.2, 240, 10.5, 8, 6.5);
    makeAncientSundialRuin(460, 44.3, 240, 2.8);
    makeSuspendedPrayerPennants(new THREE.Vector3(450, 50.5, 230), new THREE.Vector3(470, 50.5, 250), 7, 1.8);
    makeSkyAqueductViaduct(new THREE.Vector3(500, 36, 320), new THREE.Vector3(468, 44, 255), 5, 14.0, 3.8, true);

    // 3. Tertiary Stepping Island & High Sky Viaduct 2
    makeLaputaFloatingIsland(350, 38, 145, 28, 20, 16, 3.7, true);
    makeAncientColonnade(new THREE.Vector3(338, 38, 135), new THREE.Vector3(362, 38, 155), 0.6, 5.8, 6);
    makeSkyAqueductViaduct(new THREE.Vector3(448, 44, 225), new THREE.Vector3(365, 38, 155), 6, 16.0, 3.6, true);

    // 4. Quaternary Apex Floating Crag & Watchtower Spire
    makeLaputaFloatingIsland(265, 46, 45, 25, 18, 16, 4.8, true);
    makeAncientWatchtower(265, 46, 45, 3.6, 20.0);
    makeGliderLaunchRamp(250, 46, 35, 0.45, 8.0, 26.0, 14.0);

    // 5. Rich high-altitude tree canopies
    makeFoliageCluster(510, 36, 340, 3.8, 7, 6.2);
    makeFoliageCluster(460, 44, 240, 3.4, 6, 7.3);
    makeFoliageCluster(350, 38, 145, 3.2, 5, 8.4);
    makeFoliageCluster(265, 46, 45, 3.0, 5, 9.5);

    // --- Section 5: Outer Sea Colossal Arch & Outpost Lighthouse ---
    makeNaturalSeaArch(225, -185, -0.45, 66.0, 36.0, 24.0, 14.0, 20);
    makeChalkCapeCliff(125, -245, 18, 15, 8, 14, 3, 5.5);
    makeAncientWatchtower(125, 8, -245, 3.4, 22.0);
    makeFoliageCluster(125, 8, -235, 2.4, 4, 9.1);

    // ==================== COMPOSE MATERIALS & SCENERY MESHES ====================

    const stoneMat = createToonMaterial({
      color: 0xd8cbb8,
      shadowTint: 0x7c8ca0,
      upTint: 0.04,
    });
    const chalkMat = createToonMaterial({
      color: 0xe6dac2,
      shadowTint: 0x7a8ea8,
      upTint: 0.05,
    });
    const canyonMat = createToonMaterial({
      color: 0xce8054,
      shadowTint: 0x6e525c,
      upTint: 0.05,
    });
    const mountainGreenMat = createToonMaterial({
      color: 0x3f8e54,
      shadowTint: 0x245652,
      upTintColor: 0x6ec468,
      upTint: 0.14,
      fogStart: 220.0,
      fogFar: 1350.0,
    });
    const mountainRockMat = createToonMaterial({
      color: 0xb4bfcc,
      shadowTint: 0x5c7494,
      upTintColor: 0xebe6d8,
      upTint: 0.12,
      fogStart: 220.0,
      fogFar: 1350.0,
    });
    const waterfallMat = createToonMaterial({
      color: 0xf2ffff,
      shadowTint: 0x5ccae0,
      emissive: 0x9ceeff,
      emissiveIntensity: 0.24,
      upTint: 0.08,
    });
    const wallMat = createToonMaterial({
      color: 0xf2eadc,
      shadowTint: 0x8294ad,
      upTint: 0.04,
    });
    const roofMat = createToonMaterial({
      color: PALETTE.roofTerracotta,
      shadowTint: PALETTE.woodDark,
      emissive: PALETTE.roofTerracotta,
      emissiveIntensity: 0.04,
    });
    const grassMat = createToonMaterial({
      color: 0x52a858,
      shadowTint: 0x2b684e,
      upTintColor: 0x7ed468,
      upTint: 0.12,
    });
    const woodMat = createToonMaterial({
      color: PALETTE.woodPlank,
      shadowTint: PALETTE.woodDark,
      upTint: 0.02,
    });
    const brassMat = createToonMaterial({
      color: PALETTE.boatBrass,
      emissive: PALETTE.boatBrass,
      emissiveIntensity: 0.25,
    });
    const sandMat = createToonMaterial({
      color: PALETTE.gliderCanvas,
      shadowTint: 0x8b9bb0,
    });
    const coralPinkMat = createToonMaterial({
      color: PALETTE.petalPink,
      shadowTint: PALETTE.uiWarn,
      emissive: PALETTE.petalPink,
      emissiveIntensity: 0.14,
    });
    const coralTealMat = createToonMaterial({
      color: 0x1d6f73,
      shadowTint: 0x113b3d,
      upTint: 0.02,
    });
    const coralGoldMat = createToonMaterial({
      color: PALETTE.sunFlare,
      shadowTint: PALETTE.boatWoodDark,
      emissive: PALETTE.sunFlare,
      emissiveIntensity: 0.16,
    });
    const foliageMat = createToonMaterial({
      color: 0x4ba356,
      shadowTint: 0x28624b,
      upTintColor: 0x7cd166,
      upTint: 0.10,
    });

    const addMergedMesh = (geos: THREE.BufferGeometry[], mat: THREE.Material, name: string, outline = true): void => {
      if (geos.length === 0) return;
      const merged = mergeGeometries(geos.map(cleanGeo), false);
      geos.forEach((g) => g.dispose());
      if (!merged) throw new Error(`Unable to merge ${name}`);
      const mesh = new THREE.Mesh(merged, mat);
      mesh.name = name;
      if (outline) addOutline(mesh, { width: 0.72 });
      markInk(mesh);
      this.object.add(mesh);
    };

    addMergedMesh(stoneParts, stoneMat, 'wonder-stone-structures', false);
    addMergedMesh(chalkParts, chalkMat, 'wonder-chalk-cliffs', false);
    addMergedMesh(canyonParts, canyonMat, 'wonder-canyon-rock', false);
    addMergedMesh(mountainGreenParts, mountainGreenMat, 'wonder-mountain-green', false);
    addMergedMesh(mountainRockParts, mountainRockMat, 'wonder-mountain-rock', false);
    addMergedMesh(waterfallParts, waterfallMat, 'wonder-waterfalls', false);
    addMergedMesh(wallParts, wallMat, 'wonder-village-walls', true);
    addMergedMesh(roofParts, roofMat, 'wonder-village-roofs', true);
    addMergedMesh(grassParts, grassMat, 'wonder-grass-caps', false);
    addMergedMesh(woodParts, woodMat, 'wonder-timber-structures', false);
    addMergedMesh(brassParts, brassMat, 'wonder-brass-accents', true);
    addMergedMesh(sandParts, sandMat, 'wonder-atoll-sand', false);
    addMergedMesh(coralPinkParts, coralPinkMat, 'wonder-coral-pink', false);
    addMergedMesh(coralTealParts, coralTealMat, 'wonder-coral-teal', false);
    addMergedMesh(coralGoldParts, coralGoldMat, 'wonder-coral-gold', false);
    addMergedMesh(foliageParts, foliageMat, 'wonder-foliage-crowns', false);
  }
}
