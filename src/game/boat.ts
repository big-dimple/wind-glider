/**
 * boat.ts — procedural hard-chine race boat + arcade planing physics.
 *
 * Visuals: a ~5.2 m planing hull lofted from hand-placed cross-sections
 * (pointed V bow, flared sides, chine flats, color-wrapped deck with an ink
 * panel line, cockpit + coaming, side sponsons, faired-in jet pump, spoiler),
 * flat-shaded for the toon ramp and outlined once via cel/outline. Zero
 * assets: the racing-number decal is drawn into a canvas at build time.
 *
 * Physics: planar heading/velocity model with strong hydrodynamic grip,
 * speed-sensitive steering capped by lateral G, hold-to-powerslide with a
 * drift→boost payout, and 5-point buoyancy sampling of the Gerstner field
 * from water/waves.ts (the same sum the GPU displaces). Crest launches go
 * ballistic; re-contact impact speed is exposed via state.landImpulse for
 * camera shake + audio (>= TUNING.slamThreshold is a slam).
 *
 * update() runs on the fixed 1/60 sim step and allocates nothing per frame.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LAYER_ENERGY, markInk } from '../contracts';
import type { BoatInput, BoatState, CourseSample, FlightFailureSnapshot, FlightPhase, IBoat, ICourse, IJetTrail, IWake, ISpray } from '../contracts';
import { PALETTE } from '../core/palette';
import { waterHeight, waterNormalInto } from '../water/waves';
import { createToonMaterial } from '../cel/toonMaterial';
import { addOutline } from '../cel/outline';
import type { DriverHandling } from './racers';
export { Rider } from './rider';

export interface BoatOptions {
  id: number;
  color: number;
  wake: IWake;
  spray: ISpray;
  trail: IJetTrail;
  course?: ICourse;
  detailedInk?: boolean;
  driverId?: string;
}

// ---------------------------------------------------------------- tuning ----
// Handling tuning — the polish pass iterates HERE. Units: meters, seconds,
// radians. dt is fixed at 1/60, so per-second rates are integrated directly.
const TUNING = {
  // -- planar drive --
  topSpeed: 34,          // reference top speed, m/s (wake intensity + rpm scale too)
  taperHeadroom: 1.18,   // engine taper reference = topSpeed × this; quadratic drag
                         // settles the REAL top speed back at ≈ topSpeed
  reverseSpeed: 7,       // m/s
  accel: 14,             // m/s² at standstill, tapering to 0 at the taper reference
  reverseAccel: 9,       // m/s²
  brakeDecel: 16,        // m/s², throttle < 0 while still moving forward
  dragQuad: 0.0018,      // quadratic drag: a = −dragQuad · v · |v|
  lateralGrip: 7.5,      // 1/s exponential kill of sideways velocity (hydrodynamic grip)

  // -- steering --
  yawRateMax: 2.0,       // rad/s yaw authority once up to speed
  latGMax: 11,           // m/s² lateral-G cap → turn radius tightens with speed, then grows as v²
  steerFullSpeed: 5,     // m/s where steering reaches full authority (no spinning in place)
  yawDamp: 9,            // 1/s approach rate of yaw rate → target

  // -- drift / boost --
  driftGripMul: 0.45,    // lateral grip × this while drifting (−55%)
  driftYawDampMul: 0.5,  // yaw damping × this while drifting (looser rotation)
  driftScrub: 0.1,       // 1/s extra forward speed scrub while drifting (slight — not a brake)
  driftMinSpeed: 12,     // m/s — below this, drifting builds no charge
  driftChargeTime: 1.05, // s of held drift for a full 0→1 charge
  boostReleaseMin: 0.32, // minimum charge that pays out on release
  boostDuration: 1.1,    // s of boost per unit of charge
  boostTopMul: 1.42,     // taper reference × while boosting → ≈ +35% real top speed
  boostAccelMul: 1.4,    // accel × while boosting

  // -- controlled-flight vector braking --
  airBrakeTargetSpeed: 29,
  airBrakeDecel: 24,
  airBrakeLatG: 24,
  airBrakeYawDamp: 14,
  airBrakeGrip: 10,
  airBrakeAttack: 0.08,
  airBrakeRelease: 0.16,

  // -- Final return brake (same turn authority, lower surface target) --
  returnBrakeTargetSpeed: 18,
  returnBrakeDecel: 28,

  // -- earned glider flight & aerodynamics (Task 8.1) --
  flightSpool: 0.08,
  flightAscend: 0.42,
  flightCruise: 5.40,
  flightExtension: 2.60,
  flightDescend: 0.75,
  flightClearance: 4.5,  // hull-root height above the live mean water surface
  flightLandingLead: 0.45, // counter moving-wave lag so the landing envelope seats cleanly
  flightHardCap: 56,
  flightOmega: 14,         // rad/s, critically damped vertical tracking frequency
  flightAccelMax: 72,      // m/s², max vertical tracking acceleration
  flightDescentSpeed: 36,
  flightMissSpeedMul: 0.92,
  flightMissDriveMul: 0.88,
  flightMissDriveTime: 0.35,

  // -- glider aerodynamics core --
  glideRatio: 10.5,        // Lift/Drag ratio in neutral glide (~10.5:1)
  wingArea: 6.8,           // Effective canvas wing reference area, m²
  airDensity: 1.225,       // Standard sea-level air density, kg/m³
  gliderMass: 420,         // Glider mass, kg
  liftCoeff0: 0.32,        // Base camber lift coefficient at zero AoA
  liftSlope: 5.0,          // dCL/d(alpha) lift curve slope (per radian)
  stallAngle: 0.30,        // Stall angle of attack (rad, ~17.2 deg)
  stallLiftDrop: 0.65,     // Post-stall lift retention factor
  dragCoeff0: 0.030,       // Zero-lift parasite drag coefficient
  inducedDragK: 0.042,     // Induced drag factor k * CL^2
  airBrakeDragCoeff: 0.32, // Additional drag coefficient when air-brake is engaged
  divePitchMax: 0.36,      // Max nose-down pitch command in dive (rad, ~20.6 deg)
  climbPitchMax: 0.40,     // Max nose-up pitch command in climb (rad, ~22.9 deg)
  neutralPitchTrim: -0.035,// Natural slight nose-down trim for steady gliding (rad, ~-2 deg)
  pitchControlRate: 8.5,   // Pitch target convergence rate (1/s)
  glideSinkRate: 0.95,     // Natural sinking speed in steady level glide (m/s)
  diveSpeedCap: 56,        // Max forward speed achieved from steep dive conversion (m/s)
  climbSpeedDrain: 14.0,   // Rate of kinetic speed drainage during steep climb (m/s²)
  flightMaxAlt: 18.0,      // Max aerodynamic flight ceiling above water surface (m)
  airLateralDamping: 4.5,  // Lateral slip damping in flight (1/s)

  // -- ground effect & proximity resonance (Task 8.2) --
  groundEffectSpan: 3.8,      // Effective canvas wingspan for WIG (meters)
  groundEffectMinAlt: 0.25,   // Min clearance altitude to avoid ocean floor overlap (m)
  groundEffectMaxAlt: 3.2,    // Max clearance altitude for ground effect (m)
  groundEffectPeakAltLo: 0.9, // Lower bound for peak ground effect resonance (m)
  groundEffectPeakAltHi: 2.2, // Upper bound for peak ground effect resonance (m)
  groundEffectLiftMul: 0.32,  // Max lift coefficient boost from ram-air cushion (+32%)
  groundEffectDragCut: 0.52,  // Max induced drag reduction factor (-52%)
  groundEffectCushionK: 4.8,  // Soft spring anti-sink cushioning acceleration (m/s²)
  groundEffectThrustMul: 1.14,// Forward thrust / speed efficiency multiplier in ground effect
  groundResonanceSpeedMin: 20,// Min forward speed for proximity resonance charging (m/s)
  groundResonanceRate: 0.85,  // Charge buildup rate per second during sustained low skimming (1/s)
  groundEffectTrailPeriod: 0.05, // Particle emission period for surface wind vortices (s)
  groundAutoLevelAlt: 3.0,     // Clearance altitude threshold for ground auto-level & air cushion (m)
  groundAutoLevelFlare: 0.02,  // Gentle positive pitch flare angle in ground proximity (rad)
  groundCushionSinkDamp: 4.2,  // Aerodynamic ram air cushion sink damping rate (1/s)

  // -- thermal updrafts & wind tunnels (Task 8.3) --
  thermalCouplingK: 4.8,       // Vertical acceleration coupling rate to thermal column lift (1/s)
  thermalExtendRate: 0.75,     // Rate at which thermal updraft restores/extends flight duration (s/s)
  windTunnelBoostMul: 1.45,    // Slingshot velocity boost factor
  windTunnelDragCut: 0.72,     // Induced drag reduction inside wind tunnel (-72%)

  // -- buoyancy --
  gravity: 9.8,
  floatK: 38,            // vertical spring stiffness toward (sampled mean − draft)
  floatDamp: 7,          // vertical spring damping
  draft: 0.42,           // m the hull origin sits below the sampled mean surface
                         // (deep enough that the rub rail rides AT the water plane)
  sampleLong: 2.1,       // m, longitudinal offset of bow/stern sample points
  sampleLat: 0.85,       // m, lateral offset of side sample points
  takeoffG: 1.0,         // fraction of gravity: hull unloads when the spring would have to
                         // pull it down harder than this (water can't pull — it separates)
  takeoffDwell: 0.1,     // s of continuous unload before the hull counts as airborne —
                         // micro-skips over chop keep thrust; only crest-lip launches latch
  slamThreshold: 7,      // m/s — landImpulse above this is a slam (camera shake + audio)

  // -- orientation --
  tiltOmega: 7,          // rad/s, critically-damped pitch/roll spring frequency
  bankMax: 0.244,        // rad (14°) max steering bank into turns
  pitchAccelMax: 0.1,    // rad bow-up at full accel / nose-drop under braking
  idleBobTilt: 0.25,     // extra wave-normal tilt blended in at low speed
  idleBobFadeSpeed: 4,   // m/s where the idle bob finishes fading out
  airTiltKeep: 0.35,     // fraction of wave tilt targets kept while airborne

  // -- wake / spray --
  wakeDriftBoost: 0.4,   // wake intensity add while drifting
  wakeBoostBoost: 0.5,   // wake intensity add while boosting
  turnSprayG: 6,         // |lateralG| that starts leeward-chine spray
  turnSprayPeriod: 0.09, // s between chine spray bursts
  boostSprayPeriod: 0.08,// s between stern spray bursts while boosting
  slamSprayPer: 2.5,     // spray particles per m/s of landing impact
  slamSprayMax: 36,
} as const;

// -------------------------------------------------- module-scope temps ----
// Zero per-frame allocations: every update() scratches through these.
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _nrm = new THREE.Vector3();
const _euler = new THREE.Euler();
const _blobQ = new THREE.Quaternion();
const _fxMatrix = new THREE.Matrix4();
const _fxPos = new THREE.Vector3();
const _fxScale = new THREE.Vector3();
const _fxQBoost = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const _fxAxisY = new THREE.Vector3(0, 1, 0);
const _fxAxisZ = new THREE.Vector3(0, 0, 1);
const _fxFlowDir = new THREE.Vector3();
const _fxFlowQ = new THREE.Quaternion();
const _fxRingQ = new THREE.Quaternion();
const _fxRingSpinQ = new THREE.Quaternion();
const _fxLiftDirs = [
  new THREE.Vector3(-0.18, -0.98, -0.08).normalize(),
  new THREE.Vector3(0.18, -0.98, -0.08).normalize(),
] as const;
const _fxQLifts = _fxLiftDirs.map((dir) =>
  new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
const _fxColor = new THREE.Color();
const _guideSample: CourseSample = {
  u: 0,
  distance: 0,
  point: new THREE.Vector3(),
  tangent: new THREE.Vector3(),
  routeId: 'surface',
};

// ------------------------------------------------------------ blob shadow ----
// Hard-edged ink ellipse riding the water surface under each hull. Pins the
// boat visually to the ocean (the "seat") and sells airtime: when the hull
// flies, the blob stays on the water, swelling and thinning with the gap.
let _blobTex: THREE.CanvasTexture | null = null;
function blobTexture(): THREE.CanvasTexture {
  if (_blobTex) return _blobTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(16, 14, 40, 1)');
  grad.addColorStop(0.74, 'rgba(16, 14, 40, 1)');
  grad.addColorStop(0.8, 'rgba(16, 14, 40, 0)'); // near-hard cel edge
  grad.addColorStop(1, 'rgba(16, 14, 40, 0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  _blobTex = new THREE.CanvasTexture(c);
  _blobTex.colorSpace = THREE.SRGBColorSpace;
  return _blobTex;
}

function buildBlobShadow(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2); // flat, normal +Y
  const mat = new THREE.MeshBasicMaterial({
    map: blobTexture(),
    transparent: true,
    opacity: 0.36,
    depthWrite: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'blobShadow';
  mesh.renderOrder = 2; // over the ocean surface, under spray
  return mesh;
}

let _footprintTex: THREE.CanvasTexture | null = null;
function footprintTexture(): THREE.CanvasTexture {
  if (_footprintTex) return _footprintTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 3, 64, 64, 62);
  grad.addColorStop(0, 'rgba(255,255,255,0.62)');
  grad.addColorStop(0.22, 'rgba(255,255,255,0.18)');
  grad.addColorStop(0.23, 'rgba(255,255,255,0.72)');
  grad.addColorStop(0.3, 'rgba(255,255,255,0.08)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.05)');
  grad.addColorStop(0.56, 'rgba(255,255,255,0.82)');
  grad.addColorStop(0.65, 'rgba(255,255,255,0.12)');
  grad.addColorStop(0.78, 'rgba(255,255,255,0.64)');
  grad.addColorStop(0.83, 'rgba(255,255,255,0.04)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  _footprintTex = new THREE.CanvasTexture(c);
  _footprintTex.colorSpace = THREE.NoColorSpace;
  return _footprintTex;
}

function buildFlightFootprint(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    map: footprintTexture(),
    color: PALETTE.flight,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'anti-grav-footprint';
  mesh.renderOrder = 4;
  return mesh;
}

interface ThrustVisual {
  shell: THREE.InstancedMesh;
  outer: THREE.InstancedMesh;
  core: THREE.InstancedMesh;
  rings: THREE.InstancedMesh;
}

function buildThrustVisual(): ThrustVisual {
  const geo = new THREE.ConeGeometry(1, 1, 12, 1, true);
  const shellMat = new THREE.MeshBasicMaterial({
    color: PALETTE.flightDeep,
    transparent: true,
    opacity: 0.34,
    blending: THREE.NormalBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const outerMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.18,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const coreMat = new THREE.MeshBasicMaterial({
    color: PALETTE.foam,
    transparent: true,
    opacity: 0.22,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const shell = new THREE.InstancedMesh(geo, shellMat, 4);
  const outer = new THREE.InstancedMesh(geo, outerMat, 5);
  const core = new THREE.InstancedMesh(geo, coreMat, 5);
  const ringGeo = new THREE.TorusGeometry(1, 0.045, 4, 12, Math.PI * 1.18);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.52,
    blending: THREE.NormalBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const rings = new THREE.InstancedMesh(ringGeo, ringMat, 12);
  shell.name = 'thrust-shell';
  outer.name = 'thrust-outer';
  core.name = 'thrust-core';
  rings.name = 'thrust-flow-rings';
  shell.renderOrder = 7;
  outer.renderOrder = 8;
  core.renderOrder = 9;
  rings.renderOrder = 8;
  shell.frustumCulled = false;
  outer.frustumCulled = false;
  core.frustumCulled = false;
  rings.frustumCulled = false;
  shell.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  outer.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  core.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  rings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  outer.setColorAt(0, _fxColor.setHex(PALETTE.boost, THREE.NoColorSpace));
  outer.setColorAt(1, _fxColor.setHex(PALETTE.flight, THREE.NoColorSpace));
  outer.setColorAt(2, _fxColor.setHex(PALETTE.flight, THREE.NoColorSpace));
  outer.setColorAt(3, _fxColor.setHex(PALETTE.flight, THREE.NoColorSpace));
  outer.setColorAt(4, _fxColor.setHex(PALETTE.flight, THREE.NoColorSpace));
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < 4; i++) shell.setMatrixAt(i, hidden);
  for (let i = 0; i < 5; i++) {
    outer.setMatrixAt(i, hidden);
    core.setMatrixAt(i, hidden);
  }
  for (let i = 0; i < 12; i++) {
    rings.setMatrixAt(i, hidden);
    rings.setColorAt(i, _fxColor.setHex(i % 3 === 1 ? 0x9b7cff : i % 3 === 2 ? PALETTE.foam : PALETTE.flight, THREE.NoColorSpace));
  }
  shell.instanceMatrix.needsUpdate = true;
  outer.instanceMatrix.needsUpdate = true;
  core.instanceMatrix.needsUpdate = true;
  rings.instanceMatrix.needsUpdate = true;
  if (outer.instanceColor) outer.instanceColor.needsUpdate = true;
  if (rings.instanceColor) rings.instanceColor.needsUpdate = true;
  outer.layers.enable(LAYER_ENERGY);
  core.layers.enable(LAYER_ENERGY);
  return { shell, outer, core, rings };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function smooth01(v: number): number {
  const t = clamp(v, 0, 1);
  return t * t * (3 - 2 * t);
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

// ------------------------------------------------------------ hull loft ----

type Profile = Array<[number, number]>; // (x, y) points, port (+x) → starboard (−x)
interface LoftStation {
  z: number;
  pts: Profile;
}

/**
 * Loft stations (bow +Z → stern −Z) into a flat-shaded, non-indexed
 * BufferGeometry. Winding: profiles run port→starboard; `reverse` flips for
 * surfaces facing the other way (deck faces up, hull faces out).
 */
function loftInto(pos: number[], stations: LoftStation[], closed: boolean, reverse: boolean): void {
  const m = stations[0].pts.length;
  const bands = closed ? m : m - 1;
  for (let i = 0; i < stations.length - 1; i++) {
    const a = stations[i];
    const b = stations[i + 1];
    for (let j = 0; j < bands; j++) {
      const j2 = (j + 1) % m;
      const p00 = a.pts[j];
      const p01 = a.pts[j2];
      const p10 = b.pts[j2];
      const p11 = b.pts[j];
      if (!reverse) {
        pos.push(p00[0], p00[1], a.z, p01[0], p01[1], a.z, p10[0], p10[1], b.z);
        pos.push(p00[0], p00[1], a.z, p10[0], p10[1], b.z, p11[0], p11[1], b.z);
      } else {
        pos.push(p00[0], p00[1], a.z, p10[0], p10[1], b.z, p01[0], p01[1], a.z);
        pos.push(p00[0], p00[1], a.z, p11[0], p11[1], b.z, p10[0], p10[1], b.z);
      }
    }
  }
}

/** Fan-cap a closed (x, y, z) loop around its centroid. flip picks the normal side. */
function pushCap(pos: number[], loop: number[][], flip: boolean): void {
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const p of loop) {
    cx += p[0];
    cy += p[1];
    cz += p[2];
  }
  cx /= loop.length;
  cy /= loop.length;
  cz /= loop.length;
  for (let j = 0; j < loop.length; j++) {
    const a = loop[j];
    const b = loop[(j + 1) % loop.length];
    if (!flip) {
      pos.push(cx, cy, cz, a[0], a[1], a[2], b[0], b[1], b[2]);
    } else {
      pos.push(cx, cy, cz, b[0], b[1], b[2], a[0], a[1], a[2]);
    }
  }
}

function flatGeometry(pos: number[]): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals(); // non-indexed → per-face normals → flat facets
  return geo;
}

// [z, sheerHalfWidth, chineHalfWidth, keelY, chineY, sheerY]
// Keel rises to the bow (V entry), dead-flat planing bottom aft, flared sides.
type HullRow = readonly [number, number, number, number, number, number];
const HULL_TABLE: ReadonlyArray<HullRow> = [
  [2.6, 0.03, 0.02, 0.5, 0.54, 0.64],
  [2.3, 0.26, 0.2, 0.3, 0.35, 0.6],
  [1.8, 0.48, 0.4, 0.15, 0.2, 0.57],
  [1.2, 0.66, 0.57, 0.07, 0.12, 0.54],
  [0.6, 0.77, 0.69, 0.03, 0.07, 0.52],
  [0.0, 0.83, 0.75, 0.01, 0.05, 0.51],
  [-0.6, 0.86, 0.78, 0.0, 0.04, 0.51],
  [-1.2, 0.88, 0.8, 0.0, 0.04, 0.51],
  [-1.8, 0.88, 0.8, 0.0, 0.04, 0.52],
  [-2.6, 0.86, 0.79, 0.02, 0.05, 0.54],
];
const DECK_CROWN = 0.075;

function hullStations(): LoftStation[] {
  return HULL_TABLE.map((row): LoftStation => {
    const [z, sw, cw, ky, cy, sy] = row;
    return {
      z,
      pts: [
        [sw, sy], // sheer port
        [cw, cy], // chine port
        [0, ky], // keel
        [-cw, cy], // chine starboard
        [-sw, sy], // sheer starboard
      ],
    };
  });
}

/** Teak hull shell: bottom + flared sides, capped bow and transom. */
function buildHullGeometry(): THREE.BufferGeometry {
  const stations = hullStations();
  const pos: number[] = [];
  loftInto(pos, stations, false, false);
  const capLoop = (i: number): number[][] => {
    const st = stations[i];
    const loop = st.pts.map(([x, y]) => [x, y, st.z] as number[]);
    loop.push([0, HULL_TABLE[i][5] + DECK_CROWN, st.z]); // deck crown closes the top
    return loop;
  };
  pushCap(pos, capLoop(0), true); // bow faces +z
  pushCap(pos, capLoop(stations.length - 1), false); // transom faces −z
  return flatGeometry(pos);
}

/** Structural dark timber keel spine running along the hull centerline. */
function buildKeelBeamGeometry(): THREE.BufferGeometry {
  const stations: LoftStation[] = [
    { z: 2.65, pts: [[0.035, 0.64], [0.035, 0.48], [-0.035, 0.48], [-0.035, 0.64]] },
    ...HULL_TABLE.map((row): LoftStation => {
      const [z, , , ky] = row;
      return {
        z,
        pts: [
          [0.045, ky + 0.02],
          [0.035, ky - 0.055],
          [-0.035, ky - 0.055],
          [-0.045, ky + 0.02],
        ],
      };
    }),
    { z: -2.68, pts: [[0.045, 0.06], [0.035, -0.06], [-0.035, -0.06], [-0.045, 0.06]] },
  ];
  const pos: number[] = [];
  loftInto(pos, stations, true, false);
  const capLoop = (i: number): number[][] => stations[i].pts.map(([x, y]) => [x, y, stations[i].z] as number[]);
  pushCap(pos, capLoop(0), true);
  pushCap(pos, capLoop(stations.length - 1), false);
  return flatGeometry(pos);
}

/** Longitudinal dark timber spray rails / planing strakes along the chines. */
function buildPlaningStrakeGeometry(side: 1 | -1): THREE.BufferGeometry {
  const rows = HULL_TABLE.filter((row) => row[0] <= 1.8 && row[0] >= -2.4);
  const stations = rows.map((row): LoftStation => {
    const [z, , cw, , cy] = row;
    const sx = side * cw;
    return {
      z,
      pts: [
        [sx, cy + 0.03],
        [sx + side * 0.05, cy - 0.015],
        [sx, cy - 0.035],
      ],
    };
  });
  const pos: number[] = [];
  loftInto(pos, stations, true, side < 0);
  const capLoop = (i: number): number[][] => stations[i].pts.map(([x, y]) => [x, y, stations[i].z] as number[]);
  pushCap(pos, capLoop(0), side > 0);
  pushCap(pos, capLoop(stations.length - 1), side < 0);
  return flatGeometry(pos);
}

/** Base teak deck: sheer → crown → sheer. */
function buildDeckGeometry(): THREE.BufferGeometry {
  const stations = HULL_TABLE.map((row): LoftStation => {
    const [z, sw, , , , sy] = row;
    return {
      z,
      pts: [
        [sw + 0.02, sy - 0.01],
        [0, sy + DECK_CROWN],
        [-(sw + 0.02), sy - 0.01],
      ],
    };
  });
  const pos: number[] = [];
  loftInto(pos, stations, false, true); // faces up
  return flatGeometry(pos);
}

/** Dark timber king plank down the foredeck centerline. */
function buildDeckKingPlankGeometry(): THREE.BufferGeometry {
  const stations = HULL_TABLE.filter((row) => row[0] <= 2.4 && row[0] >= -0.2).map((row): LoftStation => {
    const [z, , , , , sy] = row;
    return {
      z,
      pts: [
        [0.08, sy + DECK_CROWN + 0.006],
        [-0.08, sy + DECK_CROWN + 0.006],
      ],
    };
  });
  const pos: number[] = [];
  loftInto(pos, stations, false, true);
  return flatGeometry(pos);
}

/** Racer livery accent panels on the foredeck (custom racer color). */
function buildDeckLiveryGeometry(side: 1 | -1): THREE.BufferGeometry {
  const stations = HULL_TABLE.filter((row) => row[0] <= 2.2 && row[0] >= 0.0).map((row): LoftStation => {
    const [z, sw, , , , sy] = row;
    const innerX = side * 0.12;
    const outerX = side * (sw * 0.82);
    return {
      z,
      pts: side > 0 ? [
        [outerX, sy + DECK_CROWN * 0.68 + 0.004],
        [innerX, sy + DECK_CROWN + 0.004],
      ] : [
        [innerX, sy + DECK_CROWN + 0.004],
        [outerX, sy + DECK_CROWN * 0.68 + 0.004],
      ],
    };
  });
  const pos: number[] = [];
  loftInto(pos, stations, false, true);
  return flatGeometry(pos);
}

/** Polished brass inlay strips framing the foredeck livery panels. */
function buildDeckBrassInlayGeometry(side: 1 | -1): THREE.BufferGeometry {
  const stations = HULL_TABLE.filter((row) => row[0] <= 2.25 && row[0] >= -0.05).map((row): LoftStation => {
    const [z, sw, , , , sy] = row;
    const innerX = side * 0.10;
    const outerX = side * (sw * 0.84);
    return {
      z,
      pts: side > 0 ? [
        [outerX + 0.016, sy + DECK_CROWN * 0.68 + 0.007],
        [innerX - 0.012, sy + DECK_CROWN + 0.007],
      ] : [
        [innerX - 0.012, sy + DECK_CROWN + 0.007],
        [outerX + 0.016, sy + DECK_CROWN * 0.68 + 0.007],
      ],
    };
  });
  const pos: number[] = [];
  loftInto(pos, stations, false, true);
  return flatGeometry(pos);
}

/** Continuous polished brass rub rail along the sheer line and transom. */
function buildSheerRubRailGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  // Port sheer rail
  const portStations = HULL_TABLE.map((row): LoftStation => {
    const [z, sw, , , , sy] = row;
    return {
      z,
      pts: [
        [sw + 0.035, sy + 0.02],
        [sw + 0.035, sy - 0.025],
        [sw - 0.015, sy - 0.025],
        [sw - 0.015, sy + 0.02],
      ],
    };
  });
  loftInto(pos, portStations, true, false);

  // Starboard sheer rail
  const stbdStations = HULL_TABLE.map((row): LoftStation => {
    const [z, sw, , , , sy] = row;
    return {
      z,
      pts: [
        [-(sw - 0.015), sy + 0.02],
        [-(sw - 0.015), sy - 0.025],
        [-(sw + 0.035), sy - 0.025],
        [-(sw + 0.035), sy + 0.02],
      ],
    };
  });
  loftInto(pos, stbdStations, true, false);

  // Transom sheer rail
  const [tz, tsw, , , , tsy] = HULL_TABLE[HULL_TABLE.length - 1];
  const transomStations: LoftStation[] = [
    {
      z: tz + 0.02,
      pts: [
        [tsw + 0.032, tsy + 0.02],
        [tsw + 0.032, tsy - 0.025],
        [-(tsw + 0.032), tsy - 0.025],
        [-(tsw + 0.032), tsy + 0.02],
      ],
    },
    {
      z: tz - 0.035,
      pts: [
        [tsw + 0.032, tsy + 0.02],
        [tsw + 0.032, tsy - 0.025],
        [-(tsw + 0.032), tsy - 0.025],
        [-(tsw + 0.032), tsy + 0.02],
      ],
    },
  ];
  loftInto(pos, transomStations, true, false);
  const capLoop = (st: LoftStation): number[][] => st.pts.map(([x, y]) => [x, y, st.z] as number[]);
  pushCap(pos, capLoop(transomStations[0]), true);
  pushCap(pos, capLoop(transomStations[1]), false);

  return flatGeometry(pos);
}

/** Side sponson at the stern quarters. side = +1 port / −1 starboard. */
function buildSponsonGeometry(side: 1 | -1): THREE.BufferGeometry {
  const mk = (z: number, half: number, y: number, thick: number): LoftStation => ({
    z,
    pts: [
      [side * 0.78, y + thick], // top-inner (against the hull)
      [side * (0.78 + half), y], // outer tip
      [side * 0.78, y - thick], // bottom-inner
    ],
  });
  const stations = [mk(-1.3, 0.03, 0.18, 0.03), mk(-2.05, 0.18, 0.15, 0.08), mk(-2.66, 0.13, 0.2, 0.08)];
  const pos: number[] = [];
  loftInto(pos, stations, true, side < 0);
  const capLoop = (i: number): number[][] => stations[i].pts.map(([x, y]) => [x, y, stations[i].z] as number[]);
  pushCap(pos, capLoop(0), side > 0); // bow end faces +z
  pushCap(pos, capLoop(stations.length - 1), side < 0); // stern end faces −z
  return flatGeometry(pos);
}

/** Submerged dihedral hydrofoil wing with hydrodynamic cross section. */
function buildHydrofoilWingGeometry(side: 1 | -1): THREE.BufferGeometry {
  const rootX = side * 0.35;
  const tipX = side * 1.05;
  const rootY = -0.06;
  const tipY = -0.02; // slight dihedral upsweep for passive stability
  const zFwd = 0.52;
  const zAft = 0.28;
  const thick = 0.032;

  const ptsRoot: [number, number, number][] = [
    [rootX, rootY + thick * 0.5, zFwd - 0.02], // leading edge upper
    [rootX, rootY + thick, (zFwd + zAft) * 0.5], // upper crest
    [rootX, rootY, zAft], // trailing edge
    [rootX, rootY - thick * 0.5, (zFwd + zAft) * 0.5], // lower belly
  ];
  const ptsTip: [number, number, number][] = [
    [tipX, tipY + thick * 0.3, zFwd],
    [tipX, tipY + thick * 0.6, (zFwd + zAft) * 0.5],
    [tipX, tipY, zAft + 0.02],
    [tipX, tipY - thick * 0.3, (zFwd + zAft) * 0.5],
  ];

  const pos: number[] = [];
  for (let j = 0; j < 4; j++) {
    const j2 = (j + 1) % 4;
    const r0 = ptsRoot[j];
    const r1 = ptsRoot[j2];
    const t0 = ptsTip[j];
    const t1 = ptsTip[j2];
    if (side > 0) {
      pos.push(r0[0], r0[1], r0[2], t0[0], t0[1], t0[2], t1[0], t1[1], t1[2]);
      pos.push(r0[0], r0[1], r0[2], t1[0], t1[1], t1[2], r1[0], r1[1], r1[2]);
    } else {
      pos.push(r0[0], r0[1], r0[2], t1[0], t1[1], t1[2], t0[0], t0[1], t0[2]);
      pos.push(r0[0], r0[1], r0[2], r1[0], r1[1], r1[2], t1[0], t1[1], t1[2]);
    }
  }
  pushCap(pos, ptsTip, side < 0);
  return flatGeometry(pos);
}

/** Submerged aft stabilizer hydrofoil wing mounted beneath the stern keel. */
function buildAftHydrofoilGeometry(): THREE.BufferGeometry {
  const span = 0.72;
  const zFwd = -2.05;
  const zAft = -2.25;
  const y = -0.12;
  const thick = 0.028;

  const ptsPort: [number, number, number][] = [
    [span * 0.5, y + thick * 0.5, zFwd],
    [span * 0.5, y + thick, (zFwd + zAft) * 0.5],
    [span * 0.5, y, zAft],
    [span * 0.5, y - thick * 0.5, (zFwd + zAft) * 0.5],
  ];
  const ptsStbd: [number, number, number][] = [
    [-span * 0.5, y + thick * 0.5, zFwd],
    [-span * 0.5, y + thick, (zFwd + zAft) * 0.5],
    [-span * 0.5, y, zAft],
    [-span * 0.5, y - thick * 0.5, (zFwd + zAft) * 0.5],
  ];

  const pos: number[] = [];
  for (let j = 0; j < 4; j++) {
    const j2 = (j + 1) % 4;
    const p0 = ptsPort[j];
    const p1 = ptsPort[j2];
    const s0 = ptsStbd[j];
    const s1 = ptsStbd[j2];
    pos.push(p0[0], p0[1], p0[2], s0[0], s0[1], s0[2], s1[0], s1[1], s1[2]);
    pos.push(p0[0], p0[1], p0[2], s1[0], s1[1], s1[2], p1[0], p1[1], p1[2]);
  }
  pushCap(pos, ptsPort, false);
  pushCap(pos, ptsStbd, true);
  return flatGeometry(pos);
}

/** Racing-number decal texture on vintage parchment with brass/ink frame. */
function numberDecalTexture(num: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const g = canvas.getContext('2d');
  if (g) {
    const css = (hex: number): string => `#${hex.toString(16).padStart(6, '0')}`;
    // Vintage parchment plaque background
    g.fillStyle = css(PALETTE.uiParchment);
    g.beginPath();
    g.roundRect(12, 12, 232, 104, 22);
    g.fill();
    // Polished brass outer border
    g.lineWidth = 8;
    g.strokeStyle = css(PALETTE.boatBrass);
    g.stroke();
    // Sepia hand-inked inner border
    g.lineWidth = 2.5;
    g.strokeStyle = css(PALETTE.ink);
    g.stroke();

    // Hand-lettered racing number
    g.font = '900 68px "Arial Black", Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = css(PALETTE.ink);
    g.fillText(String(num), 128, 66);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * 3D double-surface canvas sail panel for the foldable glider wing.
 * side = +1 port (+X) / −1 starboard (−X).
 */
function buildGliderCanvasWingGeometry(side: 1 | -1): THREE.BufferGeometry {
  const stations = [
    { span: 0.08, leZ: 0.36, teZ: -0.32, chord: 0.68, camber: 0.042, thick: 0.020 },
    { span: 0.45, leZ: 0.34, teZ: -0.36, chord: 0.70, camber: 0.050, thick: 0.018 },
    { span: 0.90, leZ: 0.28, teZ: -0.34, chord: 0.62, camber: 0.045, thick: 0.016 },
    { span: 1.35, leZ: 0.20, teZ: -0.26, chord: 0.46, camber: 0.035, thick: 0.014 },
    { span: 1.70, leZ: 0.08, teZ: -0.12, chord: 0.20, camber: 0.020, thick: 0.010 },
  ];

  const pos: number[] = [];
  const stationPts: [number, number, number][][] = [];

  for (let i = 0; i < stations.length; i++) {
    const s = stations[i];
    const x = side * s.span;
    const leZ = s.leZ;
    const teZ = s.teZ;
    const chord = s.chord;
    const camber = s.camber;
    const thick = s.thick;

    // 8-point aerofoil contour in local wing space
    const pts: [number, number, number][] = [
      [x, 0, leZ],
      [x, camber * 0.75 + thick * 0.5, leZ - chord * 0.20],
      [x, camber + thick * 0.5, leZ - chord * 0.40],
      [x, camber * 0.55 + thick * 0.3, leZ - chord * 0.72],
      [x, 0, teZ],
      [x, camber * 0.20 - thick * 0.3, leZ - chord * 0.72],
      [x, camber * 0.40 - thick * 0.5, leZ - chord * 0.40],
      [x, camber * 0.22 - thick * 0.5, leZ - chord * 0.20],
    ];
    stationPts.push(pts);
  }

  // Loft between stations
  for (let i = 0; i < stations.length - 1; i++) {
    const curr = stationPts[i];
    const next = stationPts[i + 1];
    for (let j = 0; j < 8; j++) {
      const j2 = (j + 1) % 8;
      const c0 = curr[j];
      const c1 = curr[j2];
      const n0 = next[j];
      const n1 = next[j2];
      if (side > 0) {
        pos.push(c0[0], c0[1], c0[2], n0[0], n0[1], n0[2], n1[0], n1[1], n1[2]);
        pos.push(c0[0], c0[1], c0[2], n1[0], n1[1], n1[2], c1[0], c1[1], c1[2]);
      } else {
        pos.push(c0[0], c0[1], c0[2], n1[0], n1[1], n1[2], n0[0], n0[1], n0[2]);
        pos.push(c0[0], c0[1], c0[2], c1[0], c1[1], c1[2], n1[0], n1[1], n1[2]);
      }
    }
  }

  // End cap at wingtip
  pushCap(pos, stationPts[stations.length - 1], side < 0);
  pushCap(pos, stationPts[0], side > 0);
  return flatGeometry(pos);
}

/**
 * Transverse dark timber battens / ribs along the glider wing.
 */
function buildGliderWingBattensGeometry(side: 1 | -1): THREE.BufferGeometry {
  const battenSpans = [0.25, 0.65, 1.08, 1.48];
  const pos: number[] = [];

  for (const span of battenSpans) {
    const x = side * span;
    const halfW = 0.016;
    const pFrac = span / 1.70;
    const leZ = 0.36 - pFrac * 0.26;
    const teZ = -0.34 + pFrac * 0.20;
    const chord = leZ - teZ;
    const camber = 0.052 * (1 - pFrac * 0.55);

    const pts: [number, number, number][] = [
      [x - halfW, 0.005, leZ + 0.01],
      [x + halfW, 0.005, leZ + 0.01],
      [x + halfW, camber + 0.018, leZ - chord * 0.38],
      [x + halfW, 0.008, teZ - 0.03],
      [x - halfW, 0.008, teZ - 0.03],
      [x - halfW, camber + 0.018, leZ - chord * 0.38],
    ];

    const topY = (p: [number, number, number]): [number, number, number] => [p[0], p[1] + 0.012, p[2]];
    const p0 = pts[0];
    const p1 = pts[1];
    const p2 = pts[2];
    const p3 = pts[3];
    const p4 = pts[4];
    const p5 = pts[5];

    const quad = (a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number]) => {
      if (side > 0) {
        pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
        pos.push(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]);
      } else {
        pos.push(a[0], a[1], a[2], c[0], c[1], c[2], b[0], b[1], b[2]);
        pos.push(a[0], a[1], a[2], d[0], d[1], d[2], c[0], c[1], c[2]);
      }
    };

    quad(topY(p0), topY(p1), topY(p2), topY(p5));
    quad(topY(p5), topY(p2), topY(p3), topY(p4));
    quad(p0, topY(p0), topY(p5), p5);
    quad(p5, topY(p5), topY(p4), p4);
    quad(topY(p1), p1, p2, topY(p2));
    quad(topY(p2), p2, p3, topY(p3));
  }

  return flatGeometry(pos);
}

/**
 * Polished brass leading edge trim rod for the glider wing.
 */
function buildGliderWingLeadingEdgeGeometry(side: 1 | -1): THREE.BufferGeometry {
  const stations = [
    { span: 0.06, leZ: 0.37, y: 0.0 },
    { span: 0.45, leZ: 0.35, y: 0.005 },
    { span: 0.90, leZ: 0.29, y: 0.008 },
    { span: 1.35, leZ: 0.21, y: 0.006 },
    { span: 1.72, leZ: 0.09, y: 0.002 },
  ];

  const pos: number[] = [];
  const r = 0.016;
  const numSegs = 6;
  const loops: [number, number, number][][] = [];

  for (let i = 0; i < stations.length; i++) {
    const s = stations[i];
    const x = side * s.span;
    const loop: [number, number, number][] = [];
    for (let k = 0; k < numSegs; k++) {
      const a = (k / numSegs) * Math.PI * 2;
      loop.push([x, s.y + Math.sin(a) * r, s.leZ + Math.cos(a) * r]);
    }
    loops.push(loop);
  }

  for (let i = 0; i < loops.length - 1; i++) {
    const curr = loops[i];
    const next = loops[i + 1];
    for (let k = 0; k < numSegs; k++) {
      const k2 = (k + 1) % numSegs;
      const c0 = curr[k];
      const c1 = curr[k2];
      const n0 = next[k];
      const n1 = next[k2];
      if (side > 0) {
        pos.push(c0[0], c0[1], c0[2], n0[0], n0[1], n0[2], n1[0], n1[1], n1[2]);
        pos.push(c0[0], c0[1], c0[2], n1[0], n1[1], n1[2], c1[0], c1[1], c1[2]);
      } else {
        pos.push(c0[0], c0[1], c0[2], n1[0], n1[1], n1[2], n0[0], n0[1], n0[2]);
        pos.push(c0[0], c0[1], c0[2], c1[0], c1[1], c1[2], n1[0], n1[1], n1[2]);
      }
    }
  }
  pushCap(pos, loops[loops.length - 1], side < 0);
  pushCap(pos, loops[0], side > 0);
  return flatGeometry(pos);
}

/**
 * Wingtip brass aerodynamic feather fins.
 */
function buildGliderWingTipFeathersGeometry(side: 1 | -1): THREE.BufferGeometry {
  const pos: number[] = [];
  const tipX = side * 1.70;
  const feathers = [
    { dX: 0.12, dY: 0.03, dZ: 0.06, len: 0.24, angle: 0.25 },
    { dX: 0.16, dY: 0.05, dZ: -0.04, len: 0.30, angle: 0.05 },
    { dX: 0.11, dY: 0.02, dZ: -0.14, len: 0.22, angle: -0.22 },
  ];

  for (const f of feathers) {
    const x0 = tipX;
    const x1 = tipX + side * f.dX;
    const y0 = 0.005;
    const y1 = y0 + f.dY;
    const z0 = f.dZ;
    const z1 = f.dZ - f.len * Math.cos(f.angle);
    const w0 = 0.035;
    const w1 = 0.012;

    const p0: [number, number, number] = [x0, y0 + 0.004, z0 + w0];
    const p1: [number, number, number] = [x0, y0 - 0.004, z0 - w0];
    const p2: [number, number, number] = [x1, y1 + 0.002, z1 + w1];
    const p3: [number, number, number] = [x1, y1 - 0.002, z1 - w1];

    if (side > 0) {
      pos.push(p0[0], p0[1], p0[2], p2[0], p2[1], p2[2], p3[0], p3[1], p3[2]);
      pos.push(p0[0], p0[1], p0[2], p3[0], p3[1], p3[2], p1[0], p1[1], p1[2]);
    } else {
      pos.push(p0[0], p0[1], p0[2], p3[0], p3[1], p3[2], p2[0], p2[1], p2[2]);
      pos.push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p3[0], p3[1], p3[2]);
    }
  }

  return flatGeometry(pos);
}

/**
 * Aerodynamic carved teakwood rotor blade geometry.
 */
function buildRotorBladeGeometry(): THREE.BufferGeometry {
  const stations = [
    { r: 0.05, chord: 0.050, thick: 0.022, pitch: 0.32 },
    { r: 0.16, chord: 0.078, thick: 0.018, pitch: 0.26 },
    { r: 0.28, chord: 0.072, thick: 0.014, pitch: 0.20 },
    { r: 0.38, chord: 0.058, thick: 0.010, pitch: 0.14 },
    { r: 0.44, chord: 0.035, thick: 0.006, pitch: 0.08 },
  ];

  const pos: number[] = [];
  const stationLoops: [number, number, number][][] = [];

  for (const s of stations) {
    const cosP = Math.cos(s.pitch);
    const sinP = Math.sin(s.pitch);
    const halfC = s.chord * 0.5;
    const halfT = s.thick * 0.5;

    const loop: [number, number, number][] = [
      [s.r, halfC * sinP + halfT * cosP, halfC * cosP - halfT * sinP],
      [s.r, -halfC * sinP + halfT * cosP, -halfC * cosP - halfT * sinP],
      [s.r, -halfC * sinP - halfT * cosP, -halfC * cosP + halfT * sinP],
      [s.r, halfC * sinP - halfT * cosP, halfC * cosP + halfT * sinP],
    ];
    stationLoops.push(loop);
  }

  for (let i = 0; i < stationLoops.length - 1; i++) {
    const curr = stationLoops[i];
    const next = stationLoops[i + 1];
    for (let j = 0; j < 4; j++) {
      const j2 = (j + 1) % 4;
      const c0 = curr[j];
      const c1 = curr[j2];
      const n0 = next[j];
      const n1 = next[j2];
      pos.push(c0[0], c0[1], c0[2], n0[0], n0[1], n0[2], n1[0], n1[1], n1[2]);
      pos.push(c0[0], c0[1], c0[2], n1[0], n1[1], n1[2], c1[0], c1[1], c1[2]);
    }
  }
  pushCap(pos, stationLoops[stationLoops.length - 1], false);
  pushCap(pos, stationLoops[0], true);
  return flatGeometry(pos);
}

function normalizeGeo(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  if (!geo.index) {
    const pos = geo.attributes.position;
    if (pos) {
      const indices: number[] = [];
      for (let i = 0; i < pos.count; i++) indices.push(i);
      geo.setIndex(indices);
    }
  }
  const count = geo.attributes.position ? geo.attributes.position.count : 0;
  if (!geo.attributes.normal && count > 0) {
    geo.computeVertexNormals();
  }
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
}

function place(geo: THREE.BufferGeometry, px = 0, py = 0, pz = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): THREE.BufferGeometry {
  const g = geo.clone();
  if (sx !== 1 || sy !== 1 || sz !== 1) g.scale(sx, sy, sz);
  if (rx !== 0) g.rotateX(rx);
  if (ry !== 0) g.rotateY(ry);
  if (rz !== 0) g.rotateZ(rz);
  if (px !== 0 || py !== 0 || pz !== 0) g.translate(px, py, pz);
  return normalizeGeo(g);
}

function mergeMeshParts(parts: THREE.BufferGeometry[], mat: THREE.Material): THREE.Mesh | null {
  if (parts.length === 0) return null;
  const merged = mergeGeometries(parts.map(normalizeGeo), false);
  parts.forEach((p) => p.dispose());
  if (!merged) return null;
  return new THREE.Mesh(merged, mat);
}

// ------------------------------------------------------------ 6 Distinct Pilots' Craft Visuals ----

interface ExtraAnimatedParts {
  pinwheels?: THREE.Object3D[];
  baguaRing?: THREE.Object3D;
  canards?: THREE.Object3D[];
  nozzles?: THREE.Object3D[];
}

interface BoatVisualAssembly {
  root: THREE.Group;
  riderMount: THREE.Object3D;
  hullMaterial: THREE.ShaderMaterial;
  portWing: THREE.Group;
  stbdWing: THREE.Group;
  portRotorPylon: THREE.Group;
  stbdRotorPylon: THREE.Group;
  portRotorBlades: THREE.Group;
  stbdRotorBlades: THREE.Group;
  extra?: ExtraAnimatedParts;
}

// ------------------------------------------------------------ Pilot 1: 苏轼 · 晴空信天翁 (Classic Gull Wing) ----

function buildSushiWingAssembly(
  side: 1 | -1,
  woodMat: THREE.Material,
  darkWoodMat: THREE.Material,
  brassMat: THREE.Material,
  canvasMat: THREE.Material,
): THREE.Group {
  const wingGroup = new THREE.Group();
  wingGroup.name = side > 0 ? 'portWing' : 'stbdWing';
  wingGroup.position.set(side * 0.58, 0.74, -0.55);

  // 1. Double-sided Cotton Canvas Sail
  const canvasMesh = new THREE.Mesh(buildGliderCanvasWingGeometry(side), canvasMat);
  wingGroup.add(canvasMesh);

  // 2. Dark Timber Battens & Spar
  const darkWoodParts: THREE.BufferGeometry[] = [
    buildGliderWingBattensGeometry(side),
    place(new THREE.BoxGeometry(1.68, 0.035, 0.045), side * 0.88, 0.02, 0.12),
  ];
  const darkWoodMesh = mergeMeshParts(darkWoodParts, darkWoodMat);
  if (darkWoodMesh) {
    darkWoodMesh.userData.noOutline = true;
    wingGroup.add(darkWoodMesh);
  }

  // 3. Polished Brass Leading Edge & Wingtip Feathers
  const brassParts: THREE.BufferGeometry[] = [
    buildGliderWingLeadingEdgeGeometry(side),
    buildGliderWingTipFeathersGeometry(side),
    place(new THREE.CylinderGeometry(0.045, 0.045, 0.12, 14), 0, 0, 0, 0, 0, Math.PI / 2),
    place(new THREE.BoxGeometry(0.035, 0.08, 0.06), side * 0.28, -0.04, 0.08),
  ];
  const brassMesh = mergeMeshParts(brassParts, brassMat);
  if (brassMesh) {
    brassMesh.userData.noOutline = true;
    wingGroup.add(brassMesh);
  }

  return wingGroup;
}

function buildRotorAssembly(
  side: 1 | -1,
  woodMat: THREE.Material,
  darkWoodMat: THREE.Material,
  brassMat: THREE.Material,
): {
  pylon: THREE.Group;
  blades: THREE.Group;
} {
  const pylon = new THREE.Group();
  pylon.name = side > 0 ? 'portRotorPylon' : 'stbdRotorPylon';
  pylon.position.set(side * 0.68, 0.76, -1.62);

  const pylonWoodMesh = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.06, 0.16), darkWoodMat);
  pylon.add(pylonWoodMesh);

  const pylonBrassParts: THREE.BufferGeometry[] = [
    place(new THREE.CylinderGeometry(0.048, 0.058, 0.05, 12), 0, 0.04, 0),
    place(new THREE.CylinderGeometry(0.032, 0.038, 0.26, 12), 0, 0.14, 0),
    place(new THREE.CylinderGeometry(0.055, 0.045, 0.06, 14), 0, 0.27, 0),
  ];
  const pylonBrassMesh = mergeMeshParts(pylonBrassParts, brassMat);
  if (pylonBrassMesh) {
    pylonBrassMesh.userData.noOutline = true;
    pylon.add(pylonBrassMesh);
  }

  const blades = new THREE.Group();
  blades.name = side > 0 ? 'portRotorBlades' : 'stbdRotorBlades';
  blades.position.set(0, 0.31, 0);

  const bladeWoodParts: THREE.BufferGeometry[] = [];
  const bladeDarkWoodParts: THREE.BufferGeometry[] = [];
  const bladeBrassParts: THREE.BufferGeometry[] = [
    normalizeGeo(new THREE.CylinderGeometry(0.058, 0.058, 0.04, 14)),
    place(new THREE.ConeGeometry(0.048, 0.07, 14), 0, 0.045, 0),
  ];

  const bladeGeo = buildRotorBladeGeometry();
  for (let i = 0; i < 3; i++) {
    const bladeAngle = (i * Math.PI * 2) / 3;
    bladeDarkWoodParts.push(place(new THREE.CylinderGeometry(0.022, 0.022, 0.04, 8), 0.03 * Math.cos(bladeAngle), 0, -0.03 * Math.sin(bladeAngle), 0, bladeAngle, Math.PI / 2));
    bladeWoodParts.push(place(bladeGeo, 0, 0, 0, 0, bladeAngle, 0));
    bladeBrassParts.push(place(new THREE.SphereGeometry(0.014, 8, 8), 0.44 * Math.cos(bladeAngle), 0, -0.44 * Math.sin(bladeAngle)));
  }

  const bladesWoodMesh = mergeMeshParts(bladeWoodParts, woodMat);
  if (bladesWoodMesh) blades.add(bladesWoodMesh);

  const bladesDarkWoodMesh = mergeMeshParts(bladeDarkWoodParts, darkWoodMat);
  if (bladesDarkWoodMesh) {
    bladesDarkWoodMesh.userData.noOutline = true;
    blades.add(bladesDarkWoodMesh);
  }

  const bladesBrassMesh = mergeMeshParts(bladeBrassParts, brassMat);
  if (bladesBrassMesh) {
    bladesBrassMesh.userData.noOutline = true;
    blades.add(bladesBrassMesh);
  }

  pylon.add(blades);
  return { pylon, blades };
}

// ------------------------------------------------------------ Pilot 2: 清照 · 风谷蜻蜓 (Twin-Boom Translucent Mesh Dragonfly) ----

function buildDragonflyWingMeshGeometry(side: 1 | -1): THREE.BufferGeometry {
  const stations = [
    { span: 0.08, leZ: 0.32, teZ: -0.22, chord: 0.54, camber: 0.038, thick: 0.016 },
    { span: 0.55, leZ: 0.22, teZ: -0.26, chord: 0.48, camber: 0.042, thick: 0.014 },
    { span: 1.10, leZ: 0.08, teZ: -0.28, chord: 0.36, camber: 0.036, thick: 0.012 },
    { span: 1.60, leZ: -0.08, teZ: -0.26, chord: 0.18, camber: 0.024, thick: 0.009 },
    { span: 1.95, leZ: -0.22, teZ: -0.30, chord: 0.08, camber: 0.014, thick: 0.006 },
  ];
  const pos: number[] = [];
  const stationPts: [number, number, number][][] = [];
  for (let i = 0; i < stations.length; i++) {
    const s = stations[i];
    const x = side * s.span;
    const pts: [number, number, number][] = [
      [x, 0, s.leZ],
      [x, s.camber * 0.75 + s.thick * 0.5, s.leZ - s.chord * 0.22],
      [x, s.camber + s.thick * 0.5, s.leZ - s.chord * 0.45],
      [x, s.camber * 0.5 + s.thick * 0.3, s.leZ - s.chord * 0.75],
      [x, 0, s.teZ],
      [x, s.camber * 0.2 - s.thick * 0.3, s.leZ - s.chord * 0.75],
      [x, s.camber * 0.35 - s.thick * 0.5, s.leZ - s.chord * 0.45],
      [x, s.camber * 0.2 - s.thick * 0.5, s.leZ - s.chord * 0.22],
    ];
    stationPts.push(pts);
  }
  for (let i = 0; i < stations.length - 1; i++) {
    const curr = stationPts[i];
    const next = stationPts[i + 1];
    for (let j = 0; j < 8; j++) {
      const j2 = (j + 1) % 8;
      const c0 = curr[j];
      const c1 = curr[j2];
      const n0 = next[j];
      const n1 = next[j2];
      if (side > 0) {
        pos.push(c0[0], c0[1], c0[2], n0[0], n0[1], n0[2], n1[0], n1[1], n1[2]);
        pos.push(c0[0], c0[1], c0[2], n1[0], n1[1], n1[2], c1[0], c1[1], c1[2]);
      } else {
        pos.push(c0[0], c0[1], c0[2], n1[0], n1[1], n1[2], n0[0], n0[1], n0[2]);
        pos.push(c0[0], c0[1], c0[2], c1[0], c1[1], c1[2], n1[0], n1[1], n1[2]);
      }
    }
  }
  pushCap(pos, stationPts[stations.length - 1], side < 0);
  pushCap(pos, stationPts[0], side > 0);
  return flatGeometry(pos);
}

function buildDragonflyTwinBoomsGeometry(side: 1 | -1): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    // Outrigger boom tube
    place(new THREE.CylinderGeometry(0.024, 0.018, 2.35, 8), side * 0.65, 0.58, -1.65, Math.PI / 2, 0, 0),
    // Vertical tail fin / rudder
    place(new THREE.BoxGeometry(0.02, 0.52, 0.38), side * 0.65, 0.78, -2.75, 0.12, 0, 0),
    // Horizontal stabilizer fin
    place(new THREE.BoxGeometry(0.32, 0.02, 0.22), side * 0.58, 0.98, -2.75),
    // Structural diagonal truss
    place(new THREE.CylinderGeometry(0.012, 0.012, 0.78, 6), side * 0.35, 0.62, -1.1, 0, 0, side * 0.55),
  ];
  const merged = mergeGeometries(parts.map(normalizeGeo), false);
  parts.forEach((p) => p.dispose());
  return merged ?? new THREE.BufferGeometry();
}

function buildQingzhaoWingAssembly(
  side: 1 | -1,
  woodMat: THREE.Material,
  darkWoodMat: THREE.Material,
  brassMat: THREE.Material,
  dragonflyMat: THREE.Material,
): THREE.Group {
  const wingGroup = new THREE.Group();
  wingGroup.name = side > 0 ? 'portWing' : 'stbdWing';
  wingGroup.position.set(side * 0.55, 0.74, -0.55);

  // 1. Translucent cyan mesh wing membrane
  const meshWing = new THREE.Mesh(buildDragonflyWingMeshGeometry(side), dragonflyMat);
  meshWing.userData.noOutline = true;
  wingGroup.add(meshWing);

  // 2. Carbon-wood frame ribs & main leading edge spar
  const sparParts: THREE.BufferGeometry[] = [
    place(new THREE.CylinderGeometry(0.022, 0.014, 1.95, 8), side * 0.98, 0.015, 0.06, 0, 0, -side * 0.12),
    place(new THREE.BoxGeometry(0.018, 0.022, 0.42), side * 0.45, 0.01, -0.02),
    place(new THREE.BoxGeometry(0.016, 0.018, 0.34), side * 0.95, 0.01, -0.08),
    place(new THREE.BoxGeometry(0.014, 0.016, 0.24), side * 1.45, 0.01, -0.16),
  ];
  const sparMesh = mergeMeshParts(sparParts, darkWoodMat);
  if (sparMesh) {
    sparMesh.userData.noOutline = true;
    wingGroup.add(sparMesh);
  }

  // 3. Delicate brass joint caps & wingtip needle
  const brassParts: THREE.BufferGeometry[] = [
    place(new THREE.CylinderGeometry(0.008, 0.002, 0.32, 6), side * 1.95, 0.0, -0.26, Math.PI / 2, 0, side * 0.2),
    place(new THREE.SphereGeometry(0.024, 8, 8), 0, 0, 0),
  ];
  const brassMesh = mergeMeshParts(brassParts, brassMat);
  if (brassMesh) {
    brassMesh.userData.noOutline = true;
    wingGroup.add(brassMesh);
  }

  return wingGroup;
}

function buildDragonflyDuctedRotorAssembly(
  side: 1 | -1,
  darkWoodMat: THREE.Material,
  brassMat: THREE.Material,
  dragonflyMat: THREE.Material,
): {
  pylon: THREE.Group;
  blades: THREE.Group;
} {
  const pylon = new THREE.Group();
  pylon.name = side > 0 ? 'portRotorPylon' : 'stbdRotorPylon';
  pylon.position.set(side * 0.65, 0.76, -1.62);

  // Carbon-wood streamlined nacelle ring duct
  const ductParts: THREE.BufferGeometry[] = [
    place(new THREE.CylinderGeometry(0.38, 0.36, 0.16, 16, 1, true), 0, 0.32, 0),
    place(new THREE.CylinderGeometry(0.038, 0.046, 0.28, 8), 0, 0.14, 0),
  ];
  const ductMesh = mergeMeshParts(ductParts, darkWoodMat);
  if (ductMesh) {
    ductMesh.userData.noOutline = true;
    pylon.add(ductMesh);
  }

  const brassCollar = new THREE.Mesh(new THREE.TorusGeometry(0.38, 0.016, 6, 16), brassMat);
  brassCollar.position.set(0, 0.38, 0);
  brassCollar.rotation.x = Math.PI / 2;
  brassCollar.userData.noOutline = true;
  pylon.add(brassCollar);

  const blades = new THREE.Group();
  blades.name = side > 0 ? 'portRotorBlades' : 'stbdRotorBlades';
  blades.position.set(0, 0.32, 0);

  const bladeParts: THREE.BufferGeometry[] = [
    place(new THREE.SphereGeometry(0.048, 8, 8), 0, 0, 0),
  ];
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI * 2) / 4;
    bladeParts.push(place(new THREE.BoxGeometry(0.014, 0.038, 0.32), 0.16 * Math.cos(a), 0, 0.16 * Math.sin(a), 0, a + 0.35, 0));
  }
  const bladesMesh = mergeMeshParts(bladeParts, dragonflyMat);
  if (bladesMesh) blades.add(bladesMesh);

  pylon.add(blades);
  return { pylon, blades };
}

// ------------------------------------------------------------ Pilot 3: 萧峰 · 赤炎狂龙 (Forward-Swept Dragon Wing & Solar PV & Twin Jet Nozzles) ----

function buildForwardSweptDragonWingGeometry(side: 1 | -1): THREE.BufferGeometry {
  const stations = [
    { span: 0.08, leZ: 0.18, teZ: -0.42, chord: 0.60, camber: 0.032, thick: 0.022 },
    { span: 0.50, leZ: 0.28, teZ: -0.32, chord: 0.60, camber: 0.035, thick: 0.018 },
    { span: 0.95, leZ: 0.42, teZ: -0.16, chord: 0.58, camber: 0.038, thick: 0.015 },
    { span: 1.45, leZ: 0.56, teZ: 0.08, chord: 0.48, camber: 0.030, thick: 0.012 },
    { span: 1.85, leZ: 0.68, teZ: 0.38, chord: 0.30, camber: 0.018, thick: 0.008 },
  ];
  const pos: number[] = [];
  const stationPts: [number, number, number][][] = [];
  for (let i = 0; i < stations.length; i++) {
    const s = stations[i];
    const x = side * s.span;
    const pts: [number, number, number][] = [
      [x, 0, s.leZ],
      [x, s.camber * 0.7 + s.thick * 0.5, s.leZ - s.chord * 0.2],
      [x, s.camber + s.thick * 0.5, s.leZ - s.chord * 0.4],
      [x, s.camber * 0.5 + s.thick * 0.3, s.leZ - s.chord * 0.7],
      [x, 0, s.teZ],
      [x, s.camber * 0.2 - s.thick * 0.3, s.leZ - s.chord * 0.7],
      [x, s.camber * 0.35 - s.thick * 0.5, s.leZ - s.chord * 0.4],
      [x, s.camber * 0.2 - s.thick * 0.5, s.leZ - s.chord * 0.2],
    ];
    stationPts.push(pts);
  }
  for (let i = 0; i < stations.length - 1; i++) {
    const curr = stationPts[i];
    const next = stationPts[i + 1];
    for (let j = 0; j < 8; j++) {
      const j2 = (j + 1) % 8;
      const c0 = curr[j];
      const c1 = curr[j2];
      const n0 = next[j];
      const n1 = next[j2];
      if (side > 0) {
        pos.push(c0[0], c0[1], c0[2], n0[0], n0[1], n0[2], n1[0], n1[1], n1[2]);
        pos.push(c0[0], c0[1], c0[2], n1[0], n1[1], n1[2], c1[0], c1[1], c1[2]);
      } else {
        pos.push(c0[0], c0[1], c0[2], n1[0], n1[1], n1[2], n0[0], n0[1], n0[2]);
        pos.push(c0[0], c0[1], c0[2], c1[0], c1[1], c1[2], n1[0], n1[1], n1[2]);
      }
    }
  }
  pushCap(pos, stationPts[stations.length - 1], side < 0);
  pushCap(pos, stationPts[0], side > 0);
  return flatGeometry(pos);
}

function buildSolarPVPanelsGeometry(side: 1 | -1): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    // 3 Inlaid hexagonal/rectangular solar cell tiles on upper wing surface
    place(new THREE.BoxGeometry(0.35, 0.015, 0.32), side * 0.52, 0.042, -0.02),
    place(new THREE.BoxGeometry(0.38, 0.015, 0.30), side * 0.98, 0.045, 0.12),
    place(new THREE.BoxGeometry(0.32, 0.015, 0.24), side * 1.45, 0.038, 0.30),
  ];
  const merged = mergeGeometries(parts.map(normalizeGeo), false);
  parts.forEach((p) => p.dispose());
  return merged ?? new THREE.BufferGeometry();
}

function buildXiaofengWingAssembly(
  side: 1 | -1,
  woodMat: THREE.Material,
  darkWoodMat: THREE.Material,
  brassMat: THREE.Material,
  solarMat: THREE.Material,
): THREE.Group {
  const wingGroup = new THREE.Group();
  wingGroup.name = side > 0 ? 'portWing' : 'stbdWing';
  wingGroup.position.set(side * 0.58, 0.74, -0.55);

  // 1. Forward-swept wing main structure
  const wingMesh = new THREE.Mesh(buildForwardSweptDragonWingGeometry(side), darkWoodMat);
  wingGroup.add(wingMesh);

  // 2. Solar photovoltaic cell panels on top
  const solarMesh = new THREE.Mesh(buildSolarPVPanelsGeometry(side), solarMat);
  solarMesh.userData.noOutline = true;
  wingGroup.add(solarMesh);

  // 3. Angular brass strike fences and leading edge armor
  const brassParts: THREE.BufferGeometry[] = [
    place(new THREE.BoxGeometry(0.025, 0.08, 0.48), side * 1.85, 0.02, 0.42, 0, 0, side * 0.3),
    place(new THREE.CylinderGeometry(0.018, 0.018, 1.85, 6), side * 0.95, 0.01, 0.42, 0, 0, side * 0.28),
  ];
  const brassMesh = mergeMeshParts(brassParts, brassMat);
  if (brassMesh) {
    brassMesh.userData.noOutline = true;
    wingGroup.add(brassMesh);
  }

  return wingGroup;
}

function buildXiaofengTwinJetNozzlesGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    // Twin circular gathering combustion nacelles
    parts.push(place(new THREE.CylinderGeometry(0.18, 0.22, 0.52, 16), side * 0.36, 0.54, -2.62, Math.PI / 2, 0, 0));
    // Brass exhaust lip
    parts.push(place(new THREE.TorusGeometry(0.19, 0.022, 8, 16), side * 0.36, 0.54, -2.88));
    // 4 thrust vectoring vanes
    for (let v = 0; v < 4; v++) {
      const a = (v / 4) * Math.PI * 2;
      parts.push(place(new THREE.BoxGeometry(0.018, 0.12, 0.18), side * 0.36 + 0.16 * Math.cos(a), 0.54 + 0.16 * Math.sin(a), -2.88, 0, 0, a));
    }
  }
  const merged = mergeGeometries(parts.map(normalizeGeo), false);
  parts.forEach((p) => p.dispose());
  return merged ?? new THREE.BufferGeometry();
}

function buildXiaofengRotorAssembly(
  side: 1 | -1,
  darkWoodMat: THREE.Material,
  brassMat: THREE.Material,
  solarMat: THREE.Material,
): {
  pylon: THREE.Group;
  blades: THREE.Group;
} {
  const pylon = new THREE.Group();
  pylon.name = side > 0 ? 'portRotorPylon' : 'stbdRotorPylon';
  pylon.position.set(side * 0.68, 0.76, -1.62);

  const pylonBrass = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.058, 0.32, 12), brassMat);
  pylonBrass.position.set(0, 0.16, 0);
  pylonBrass.userData.noOutline = true;
  pylon.add(pylonBrass);

  const blades = new THREE.Group();
  blades.name = side > 0 ? 'portRotorBlades' : 'stbdRotorBlades';
  blades.position.set(0, 0.32, 0);

  const bladeParts: THREE.BufferGeometry[] = [
    place(new THREE.ConeGeometry(0.058, 0.09, 12), 0, 0.045, 0),
  ];
  for (let i = 0; i < 3; i++) {
    const a = (i * Math.PI * 2) / 3;
    bladeParts.push(place(new THREE.BoxGeometry(0.022, 0.045, 0.38), 0.18 * Math.cos(a), 0, 0.18 * Math.sin(a), 0, a + 0.28, 0));
  }
  const bladesMesh = mergeMeshParts(bladeParts, solarMat);
  if (bladesMesh) blades.add(bladesMesh);

  pylon.add(blades);
  return { pylon, blades };
}

// ------------------------------------------------------------ Pilot 4: 舟伯通 · 顽童重锤/旋转飞燕 (Catamaran Flagship & Heavy Paddle Rotors) ----

function buildCatamaranTwinHullsGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    // Twin parallel pontoon hulls
    parts.push(place(new THREE.BoxGeometry(0.38, 0.34, 4.6), side * 0.74, 0.26, -0.2));
    parts.push(place(new THREE.ConeGeometry(0.24, 0.95, 12), side * 0.74, 0.32, 2.45, Math.PI / 2, 0, 0));
  }
  // Heavy arched timber bridge crossbeams
  parts.push(place(new THREE.BoxGeometry(1.85, 0.12, 0.28), 0, 0.65, 0.85));
  parts.push(place(new THREE.BoxGeometry(1.85, 0.12, 0.28), 0, 0.65, -0.65));
  parts.push(place(new THREE.BoxGeometry(1.85, 0.12, 0.28), 0, 0.65, -2.15));
  const merged = mergeGeometries(parts.map(normalizeGeo), false);
  parts.forEach((p) => p.dispose());
  return merged ?? new THREE.BufferGeometry();
}

function buildCatamaranBrassBumpersGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    // Bow heavy rounded brass rivet caps
    parts.push(place(new THREE.SphereGeometry(0.26, 8, 8), side * 0.74, 0.32, 2.35));
    // Stern brass bumper corner
    parts.push(place(new THREE.BoxGeometry(0.42, 0.38, 0.18), side * 0.74, 0.28, -2.48));
  }
  const merged = mergeGeometries(parts.map(normalizeGeo), false);
  parts.forEach((p) => p.dispose());
  return merged ?? new THREE.BufferGeometry();
}

function buildZhoubotongWingGeometry(side: 1 | -1): THREE.BufferGeometry {
  const stations = [
    { span: 0.08, leZ: 0.42, teZ: -0.42, chord: 0.84, camber: 0.048, thick: 0.026 },
    { span: 0.60, leZ: 0.40, teZ: -0.40, chord: 0.80, camber: 0.052, thick: 0.024 },
    { span: 1.15, leZ: 0.36, teZ: -0.36, chord: 0.72, camber: 0.048, thick: 0.020 },
    { span: 1.65, leZ: 0.28, teZ: -0.28, chord: 0.56, camber: 0.035, thick: 0.016 },
  ];
  const pos: number[] = [];
  const stationPts: [number, number, number][][] = [];
  for (let i = 0; i < stations.length; i++) {
    const s = stations[i];
    const x = side * s.span;
    const pts: [number, number, number][] = [
      [x, 0, s.leZ],
      [x, s.camber * 0.75 + s.thick * 0.5, s.leZ - s.chord * 0.2],
      [x, s.camber + s.thick * 0.5, s.leZ - s.chord * 0.4],
      [x, s.camber * 0.55 + s.thick * 0.3, s.leZ - s.chord * 0.7],
      [x, 0, s.teZ],
      [x, s.camber * 0.2 - s.thick * 0.3, s.leZ - s.chord * 0.7],
      [x, s.camber * 0.4 - s.thick * 0.5, s.leZ - s.chord * 0.4],
      [x, s.camber * 0.22 - s.thick * 0.5, s.leZ - s.chord * 0.2],
    ];
    stationPts.push(pts);
  }
  for (let i = 0; i < stations.length - 1; i++) {
    const curr = stationPts[i];
    const next = stationPts[i + 1];
    for (let j = 0; j < 8; j++) {
      const j2 = (j + 1) % 8;
      const c0 = curr[j];
      const c1 = curr[j2];
      const n0 = next[j];
      const n1 = next[j2];
      if (side > 0) {
        pos.push(c0[0], c0[1], c0[2], n0[0], n0[1], n0[2], n1[0], n1[1], n1[2]);
        pos.push(c0[0], c0[1], c0[2], n1[0], n1[1], n1[2], c1[0], c1[1], c1[2]);
      } else {
        pos.push(c0[0], c0[1], c0[2], n1[0], n1[1], n1[2], n0[0], n0[1], n0[2]);
        pos.push(c0[0], c0[1], c0[2], c1[0], c1[1], c1[2], n1[0], n1[1], n1[2]);
      }
    }
  }
  pushCap(pos, stationPts[stations.length - 1], side < 0);
  pushCap(pos, stationPts[0], side > 0);
  return flatGeometry(pos);
}

function buildZhoubotongWingAssembly(
  side: 1 | -1,
  woodMat: THREE.Material,
  darkWoodMat: THREE.Material,
  brassMat: THREE.Material,
  canvasMat: THREE.Material,
): THREE.Group {
  const wingGroup = new THREE.Group();
  wingGroup.name = side > 0 ? 'portWing' : 'stbdWing';
  wingGroup.position.set(side * 0.68, 0.74, -0.55);

  const canvasMesh = new THREE.Mesh(buildZhoubotongWingGeometry(side), canvasMat);
  wingGroup.add(canvasMesh);

  const darkWoodParts: THREE.BufferGeometry[] = [
    place(new THREE.BoxGeometry(1.65, 0.045, 0.055), side * 0.82, 0.02, 0.18),
    place(new THREE.BoxGeometry(1.65, 0.045, 0.055), side * 0.82, 0.02, -0.18),
  ];
  const darkWoodMesh = mergeMeshParts(darkWoodParts, darkWoodMat);
  if (darkWoodMesh) wingGroup.add(darkWoodMesh);

  const brassParts: THREE.BufferGeometry[] = [
    place(new THREE.BoxGeometry(0.045, 0.12, 0.62), side * 1.65, 0.02, 0.0),
  ];
  const brassMesh = mergeMeshParts(brassParts, brassMat);
  if (brassMesh) {
    brassMesh.userData.noOutline = true;
    wingGroup.add(brassMesh);
  }

  return wingGroup;
}

function buildZhoubotongHeavyPaddleRotorAssembly(
  side: 1 | -1,
  woodMat: THREE.Material,
  darkWoodMat: THREE.Material,
  brassMat: THREE.Material,
): {
  pylon: THREE.Group;
  blades: THREE.Group;
} {
  const pylon = new THREE.Group();
  pylon.name = side > 0 ? 'portRotorPylon' : 'stbdRotorPylon';
  pylon.position.set(side * 0.88, 0.78, -1.62);

  const pylonBrass = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.085, 0.35, 12), brassMat);
  pylonBrass.position.set(0, 0.16, 0);
  pylonBrass.userData.noOutline = true;
  pylon.add(pylonBrass);

  const blades = new THREE.Group();
  blades.name = side > 0 ? 'portRotorBlades' : 'stbdRotorBlades';
  blades.position.set(0, 0.34, 0);

  const bladeWoodParts: THREE.BufferGeometry[] = [];
  const bladeBrassParts: THREE.BufferGeometry[] = [
    place(new THREE.CylinderGeometry(0.078, 0.078, 0.06, 14), 0, 0, 0),
    place(new THREE.SphereGeometry(0.055, 8, 8), 0, 0.04, 0),
  ];

  // 4 Broad carved paddle blades
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI * 2) / 4;
    bladeWoodParts.push(place(new THREE.BoxGeometry(0.022, 0.088, 0.44), 0.24 * Math.cos(a), 0, 0.24 * Math.sin(a), 0, a + 0.32, 0));
    bladeBrassParts.push(place(new THREE.SphereGeometry(0.018, 6, 6), 0.44 * Math.cos(a), 0, 0.44 * Math.sin(a)));
  }

  const bladesWoodMesh = mergeMeshParts(bladeWoodParts, woodMat);
  if (bladesWoodMesh) blades.add(bladesWoodMesh);

  const bladesBrassMesh = mergeMeshParts(bladeBrassParts, brassMat);
  if (bladesBrassMesh) {
    bladesBrassMesh.userData.noOutline = true;
    blades.add(bladesBrassMesh);
  }

  pylon.add(blades);
  return { pylon, blades };
}

// ------------------------------------------------------------ Pilot 5: 孔明 · 卧龙天机/木鸢 (Trimaran & Multi-stage Folding Kite Wings & Bagua Ring) ----

function buildTrimaranOutriggersGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    // Streamlined outrigger pontoon floats
    parts.push(place(new THREE.CylinderGeometry(0.14, 0.18, 2.6, 12), side * 1.18, 0.22, -0.15, Math.PI / 2, 0, 0));
    // Arched wooden outrigger struts
    parts.push(place(new THREE.BoxGeometry(0.65, 0.05, 0.12), side * 0.88, 0.66, 0.6, 0, 0, -side * 0.35));
    parts.push(place(new THREE.BoxGeometry(0.65, 0.05, 0.12), side * 0.88, 0.66, -1.1, 0, 0, -side * 0.35));
  }
  const merged = mergeGeometries(parts.map(normalizeGeo), false);
  parts.forEach((p) => p.dispose());
  return merged ?? new THREE.BufferGeometry();
}

function buildLuBanKiteWingGeometry(side: 1 | -1): THREE.BufferGeometry {
  const stations = [
    { span: 0.08, leZ: 0.38, teZ: -0.28, chord: 0.66, camber: 0.038, thick: 0.018 },
    { span: 0.65, leZ: 0.32, teZ: -0.24, chord: 0.56, camber: 0.042, thick: 0.015 },
    { span: 1.25, leZ: 0.24, teZ: -0.18, chord: 0.42, camber: 0.036, thick: 0.012 },
    { span: 1.75, leZ: 0.14, teZ: -0.12, chord: 0.26, camber: 0.024, thick: 0.009 },
    { span: 2.15, leZ: 0.02, teZ: -0.06, chord: 0.08, camber: 0.012, thick: 0.005 },
  ];
  const pos: number[] = [];
  const stationPts: [number, number, number][][] = [];
  for (let i = 0; i < stations.length; i++) {
    const s = stations[i];
    const x = side * s.span;
    const pts: [number, number, number][] = [
      [x, 0, s.leZ],
      [x, s.camber * 0.75 + s.thick * 0.5, s.leZ - s.chord * 0.2],
      [x, s.camber + s.thick * 0.5, s.leZ - s.chord * 0.4],
      [x, s.camber * 0.5 + s.thick * 0.3, s.leZ - s.chord * 0.7],
      [x, 0, s.teZ],
      [x, s.camber * 0.2 - s.thick * 0.3, s.leZ - s.chord * 0.7],
      [x, s.camber * 0.35 - s.thick * 0.5, s.leZ - s.chord * 0.4],
      [x, s.camber * 0.2 - s.thick * 0.5, s.leZ - s.chord * 0.2],
    ];
    stationPts.push(pts);
  }
  for (let i = 0; i < stations.length - 1; i++) {
    const curr = stationPts[i];
    const next = stationPts[i + 1];
    for (let j = 0; j < 8; j++) {
      const j2 = (j + 1) % 8;
      const c0 = curr[j];
      const c1 = curr[j2];
      const n0 = next[j];
      const n1 = next[j2];
      if (side > 0) {
        pos.push(c0[0], c0[1], c0[2], n0[0], n0[1], n0[2], n1[0], n1[1], n1[2]);
        pos.push(c0[0], c0[1], c0[2], n1[0], n1[1], n1[2], c1[0], c1[1], c1[2]);
      } else {
        pos.push(c0[0], c0[1], c0[2], n1[0], n1[1], n1[2], n0[0], n0[1], n0[2]);
        pos.push(c0[0], c0[1], c0[2], c1[0], c1[1], c1[2], n1[0], n1[1], n1[2]);
      }
    }
  }
  pushCap(pos, stationPts[stations.length - 1], side < 0);
  pushCap(pos, stationPts[0], side > 0);
  return flatGeometry(pos);
}

function buildBaguaAstrolabeRingAssembly(
  darkWoodMat: THREE.Material,
  brassMat: THREE.Material,
  silverMat: THREE.Material,
): THREE.Group {
  const ringGroup = new THREE.Group();
  ringGroup.name = 'baguaAstrolabeRing';
  ringGroup.position.set(0, 0.96, -2.12);

  // Outer brass astrolabe ring
  const outerRing = new THREE.Mesh(new THREE.TorusGeometry(0.48, 0.024, 8, 32), brassMat);
  outerRing.rotation.x = Math.PI / 2;
  outerRing.userData.noOutline = true;
  ringGroup.add(outerRing);

  // Inner silver celestial ring
  const innerRing = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.018, 8, 24), silverMat);
  innerRing.rotation.x = Math.PI / 2;
  innerRing.userData.noOutline = true;
  ringGroup.add(innerRing);

  // 8 Bagua trigram brass studs
  const studParts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    studParts.push(place(new THREE.BoxGeometry(0.04, 0.02, 0.08), 0.42 * Math.cos(a), 0, 0.42 * Math.sin(a), 0, a, 0));
  }
  const studMesh = mergeMeshParts(studParts, brassMat);
  if (studMesh) {
    studMesh.userData.noOutline = true;
    ringGroup.add(studMesh);
  }

  // Central celestial pointer
  const pointerMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.018, 0.72, 8), silverMat);
  pointerMesh.rotation.z = Math.PI / 2;
  pointerMesh.userData.noOutline = true;
  ringGroup.add(pointerMesh);

  return ringGroup;
}

function buildKongmingWingAssembly(
  side: 1 | -1,
  woodMat: THREE.Material,
  darkWoodMat: THREE.Material,
  brassMat: THREE.Material,
  canvasMat: THREE.Material,
): THREE.Group {
  const wingGroup = new THREE.Group();
  wingGroup.name = side > 0 ? 'portWing' : 'stbdWing';
  wingGroup.position.set(side * 0.58, 0.74, -0.55);

  const canvasMesh = new THREE.Mesh(buildLuBanKiteWingGeometry(side), canvasMat);
  wingGroup.add(canvasMesh);

  const darkWoodParts: THREE.BufferGeometry[] = [
    place(new THREE.BoxGeometry(2.15, 0.032, 0.042), side * 1.08, 0.018, 0.08),
    place(new THREE.CylinderGeometry(0.035, 0.035, 0.06, 8), side * 1.25, 0.02, 0.08), // Articulated knuckle
  ];
  const darkWoodMesh = mergeMeshParts(darkWoodParts, darkWoodMat);
  if (darkWoodMesh) wingGroup.add(darkWoodMesh);

  const brassParts: THREE.BufferGeometry[] = [
    place(new THREE.SphereGeometry(0.028, 8, 8), side * 1.25, 0.02, 0.08),
    place(new THREE.CylinderGeometry(0.012, 0.002, 0.45, 6), side * 2.15, 0.01, -0.05, Math.PI / 2, 0, side * 0.15),
  ];
  const brassMesh = mergeMeshParts(brassParts, brassMat);
  if (brassMesh) {
    brassMesh.userData.noOutline = true;
    wingGroup.add(brassMesh);
  }

  return wingGroup;
}

function buildKongmingKiteRotorAssembly(
  side: 1 | -1,
  woodMat: THREE.Material,
  darkWoodMat: THREE.Material,
  brassMat: THREE.Material,
): {
  pylon: THREE.Group;
  blades: THREE.Group;
} {
  const pylon = new THREE.Group();
  pylon.name = side > 0 ? 'portRotorPylon' : 'stbdRotorPylon';
  pylon.position.set(side * 0.68, 0.76, -1.62);

  const pylonBrass = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.048, 0.30, 10), brassMat);
  pylonBrass.position.set(0, 0.15, 0);
  pylonBrass.userData.noOutline = true;
  pylon.add(pylonBrass);

  const blades = new THREE.Group();
  blades.name = side > 0 ? 'portRotorBlades' : 'stbdRotorBlades';
  blades.position.set(0, 0.31, 0);

  const bladeWoodParts: THREE.BufferGeometry[] = [];
  const bladeBrassParts: THREE.BufferGeometry[] = [
    place(new THREE.ConeGeometry(0.042, 0.085, 12), 0, 0.045, 0),
  ];
  const bladeGeo = buildRotorBladeGeometry();
  for (let i = 0; i < 3; i++) {
    const bladeAngle = (i * Math.PI * 2) / 3;
    bladeWoodParts.push(place(bladeGeo, 0, 0, 0, 0, bladeAngle, 0, 0.92, 0.92, 1.15));
    bladeBrassParts.push(place(new THREE.SphereGeometry(0.012, 6, 6), 0.48 * Math.cos(bladeAngle), 0, -0.48 * Math.sin(bladeAngle)));
  }

  const bladesWoodMesh = mergeMeshParts(bladeWoodParts, woodMat);
  if (bladesWoodMesh) blades.add(bladesWoodMesh);

  const bladesBrassMesh = mergeMeshParts(bladeBrassParts, brassMat);
  if (bladesBrassMesh) {
    bladesBrassMesh.userData.noOutline = true;
    blades.add(bladesBrassMesh);
  }

  pylon.add(blades);
  return { pylon, blades };
}

// ------------------------------------------------------------ Pilot 6: 娃娃 · 风之浮子/彩虹雨燕 (Biplane Glider & Wingtip Pinwheels) ----

function buildWawaBuoysGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    // Cheerful spherical buoyant floats
    parts.push(place(new THREE.SphereGeometry(0.32, 12, 12), side * 0.88, 0.22, 0.25));
    // Brass mounting hoops
    parts.push(place(new THREE.TorusGeometry(0.33, 0.024, 6, 16), side * 0.88, 0.22, 0.25));
  }
  const merged = mergeGeometries(parts.map(normalizeGeo), false);
  parts.forEach((p) => p.dispose());
  return merged ?? new THREE.BufferGeometry();
}

function buildBiplaneWingAssembly(
  side: 1 | -1,
  woodMat: THREE.Material,
  darkWoodMat: THREE.Material,
  brassMat: THREE.Material,
  canvasMat: THREE.Material,
  patchworkPinkMat: THREE.Material,
  solarMat: THREE.Material,
  dragonflyMat: THREE.Material,
  patchworkVineMat: THREE.Material,
): {
  wingGroup: THREE.Group;
  pinwheelGroup: THREE.Group;
} {
  const wingGroup = new THREE.Group();
  wingGroup.name = side > 0 ? 'portWing' : 'stbdWing';
  wingGroup.position.set(side * 0.58, 0.74, -0.55);

  // 1. Lower Canvas Wing
  const lowerWing = new THREE.Mesh(buildGliderCanvasWingGeometry(side), patchworkPinkMat);
  wingGroup.add(lowerWing);

  // 2. Upper Canvas Wing (mounted +0.52m higher)
  const upperWing = new THREE.Mesh(buildGliderCanvasWingGeometry(side), dragonflyMat);
  upperWing.position.set(0, 0.52, -0.06);
  wingGroup.add(upperWing);

  // 3. Vertical wooden interplane struts & diagonal cross-wires
  const strutParts: THREE.BufferGeometry[] = [
    place(new THREE.CylinderGeometry(0.016, 0.016, 0.52, 6), side * 0.85, 0.26, 0.18),
    place(new THREE.CylinderGeometry(0.016, 0.016, 0.52, 6), side * 0.85, 0.26, -0.18),
    place(new THREE.CylinderGeometry(0.016, 0.016, 0.52, 6), side * 1.62, 0.26, 0.08),
    place(new THREE.CylinderGeometry(0.016, 0.016, 0.52, 6), side * 1.62, 0.26, -0.12),
  ];
  const strutMesh = mergeMeshParts(strutParts, darkWoodMat);
  if (strutMesh) wingGroup.add(strutMesh);

  // 4. Wingtip spinning 4-blade colorful pinwheel
  const pinwheelGroup = new THREE.Group();
  pinwheelGroup.name = 'wawaPinwheel';
  pinwheelGroup.position.set(side * 1.68, 0.26, 0.0);

  const pinwheelHub = new THREE.Mesh(new THREE.SphereGeometry(0.028, 8, 8), brassMat);
  pinwheelHub.userData.noOutline = true;
  pinwheelGroup.add(pinwheelHub);

  const petalMats = [patchworkPinkMat, solarMat, dragonflyMat, patchworkVineMat];
  for (let p = 0; p < 4; p++) {
    const a = (p / 4) * Math.PI * 2;
    const petalMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.075, 0.16), petalMats[p % petalMats.length]);
    petalMesh.position.set(0.08 * Math.cos(a), 0.08 * Math.sin(a), 0);
    petalMesh.rotation.z = a + 0.35;
    petalMesh.userData.noOutline = true;
    pinwheelGroup.add(petalMesh);
  }
  wingGroup.add(pinwheelGroup);

  return { wingGroup, pinwheelGroup };
}

function buildWawaRotorAssembly(
  side: 1 | -1,
  woodMat: THREE.Material,
  darkWoodMat: THREE.Material,
  brassMat: THREE.Material,
): {
  pylon: THREE.Group;
  blades: THREE.Group;
} {
  const pylon = new THREE.Group();
  pylon.name = side > 0 ? 'portRotorPylon' : 'stbdRotorPylon';
  pylon.position.set(side * 0.68, 0.76, -1.62);

  const pylonWoodMesh = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.06, 0.16), darkWoodMat);
  pylon.add(pylonWoodMesh);

  const pylonBrass = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.048, 0.28, 10), brassMat);
  pylonBrass.position.set(0, 0.15, 0);
  pylonBrass.userData.noOutline = true;
  pylon.add(pylonBrass);

  const blades = new THREE.Group();
  blades.name = side > 0 ? 'portRotorBlades' : 'stbdRotorBlades';
  blades.position.set(0, 0.31, 0);

  const bladeWoodParts: THREE.BufferGeometry[] = [];
  const bladeBrassParts: THREE.BufferGeometry[] = [
    place(new THREE.SphereGeometry(0.048, 8, 8), 0, 0, 0),
  ];
  const bladeGeo = buildRotorBladeGeometry();
  for (let i = 0; i < 3; i++) {
    const bladeAngle = (i * Math.PI * 2) / 3;
    bladeWoodParts.push(place(bladeGeo, 0, 0, 0, 0, bladeAngle, 0, 0.85, 0.85, 0.85));
    bladeBrassParts.push(place(new THREE.SphereGeometry(0.014, 8, 8), 0.38 * Math.cos(bladeAngle), 0, -0.38 * Math.sin(bladeAngle)));
  }

  const bladesWoodMesh = mergeMeshParts(bladeWoodParts, woodMat);
  if (bladesWoodMesh) blades.add(bladesWoodMesh);

  const bladesBrassMesh = mergeMeshParts(bladeBrassParts, brassMat);
  if (bladesBrassMesh) {
    bladesBrassMesh.userData.noOutline = true;
    blades.add(bladesBrassMesh);
  }

  pylon.add(blades);
  return { pylon, blades };
}

// ------------------------------------------------------------ Master Visual Dispatcher ----

function buildBoatVisual(id: number, color: number, profileId = 'sushi'): BoatVisualAssembly {
  const root = new THREE.Group();
  root.name = 'hull';

  // Warm artisanal Ghibli & Solarpunk material palette
  const woodMat = createToonMaterial({
    color: PALETTE.boatWood,
    rimColor: PALETTE.sparkle,
    rimStrength: 0.65,
    specColor: PALETTE.sparkle,
    specThreshold: 0.78,
  });
  const darkWoodMat = createToonMaterial({
    color: PALETTE.boatWoodDark,
    rimColor: PALETTE.sparkle,
    rimStrength: 0.45,
    specColor: PALETTE.sparkle,
    specThreshold: 0.85,
  });
  const brassMat = createToonMaterial({
    color: PALETTE.boatBrass,
    rimColor: PALETTE.foam,
    rimStrength: 1.15,
    specColor: PALETTE.sparkle,
    specThreshold: 0.56,
  });
  const canvasMat = createToonMaterial({
    color: PALETTE.gliderCanvas,
    rimColor: PALETTE.sparkle,
    rimStrength: 0.5,
  });
  const hullMat = createToonMaterial({
    color,
    rimColor: PALETTE.foam,
    rimStrength: 0.95,
    rimThreshold: 0.55,
    specColor: PALETTE.sparkle,
    specThreshold: 0.72,
  });
  const inkMat = createToonMaterial({
    color: PALETTE.ink,
    rimColor: PALETTE.foam,
    rimStrength: 0.4,
  });
  const flightMat = createToonMaterial({
    color: PALETTE.flightDeep,
    emissive: PALETTE.flight,
    emissiveIntensity: 0.55,
    rimColor: PALETTE.foam,
    rimStrength: 0.7,
  });

  // Pilot-specific specialty materials
  const solarMat = createToonMaterial({
    color: PALETTE.sunFlare,
    emissive: PALETTE.sunCore,
    emissiveIntensity: 0.65,
    rimColor: PALETTE.sparkle,
  });
  const dragonflyMat = createToonMaterial({
    color: PALETTE.skyMid,
    shadowTint: PALETTE.waterDeep,
    rimColor: PALETTE.sparkle,
    rimStrength: 0.75,
  });
  const patchworkPinkMat = createToonMaterial({
    color: PALETTE.petalPink,
    rimColor: PALETTE.sparkle,
  });
  const patchworkVineMat = createToonMaterial({
    color: PALETTE.vineGreen,
    rimColor: PALETTE.sparkle,
  });
  const silverMat = createToonMaterial({
    color: PALETTE.foam,
    rimColor: PALETTE.sparkle,
    specColor: PALETTE.sparkle,
    specThreshold: 0.55,
  });

  // 1. Wood Hull Geometries (monohull base + pilot-specific additions)
  const woodParts: THREE.BufferGeometry[] = [
    buildHullGeometry(),
    buildDeckGeometry(),
    buildSponsonGeometry(1),
    buildSponsonGeometry(-1),
    place(new THREE.BoxGeometry(0.92, 0.28, 0.64), 0, 0.68, -2.25, -0.06, 0, 0),
    place(new THREE.CylinderGeometry(0.18, 0.15, 0.28, 16), 0, 0.2, -2.54, Math.PI / 2, 0, 0),
    place(new THREE.BoxGeometry(1.18, 0.05, 0.34), 0, 0.82, -2.42, -0.12, 0, 0),
  ];
  if (profileId === 'zhoubotong') {
    woodParts.push(buildCatamaranTwinHullsGeometry());
  } else if (profileId === 'kongming') {
    woodParts.push(buildTrimaranOutriggersGeometry());
  } else if (profileId === 'wawa') {
    woodParts.push(buildWawaBuoysGeometry());
  }

  const darkWoodParts: THREE.BufferGeometry[] = [
    buildKeelBeamGeometry(),
    buildPlaningStrakeGeometry(1),
    buildPlaningStrakeGeometry(-1),
    buildHydrofoilWingGeometry(1),
    buildHydrofoilWingGeometry(-1),
    buildAftHydrofoilGeometry(),
    buildDeckKingPlankGeometry(),
    place(new THREE.BoxGeometry(1.22, 0.16, 0.1), 0, 0.66, -0.32),
    place(new THREE.BoxGeometry(1.22, 0.16, 0.1), 0, 0.66, -1.88),
    place(new THREE.BoxGeometry(0.1, 0.16, 1.66), 0.56, 0.66, -1.1),
    place(new THREE.BoxGeometry(0.1, 0.16, 1.66), -0.56, 0.66, -1.1),
    place(new THREE.BoxGeometry(1.02, 0.05, 1.5), 0, 0.6, -1.1),
    place(new THREE.BoxGeometry(0.54, 0.18, 0.52), 0, 0.7, -1.58),
    place(new THREE.BoxGeometry(0.5, 0.18, 0.14), 0, 0.8, -1.84),
    place(new THREE.BoxGeometry(0.72, 0.14, 0.16), 0, 0.78, -0.38, -0.35, 0, 0),
    place(new THREE.CylinderGeometry(0.042, 0.042, 0.16, 12), 0.27, 1.0, -0.65, 0, 0, Math.PI / 2),
    place(new THREE.CylinderGeometry(0.042, 0.042, 0.16, 12), -0.27, 1.0, -0.65, 0, 0, Math.PI / 2),
    place(new THREE.BoxGeometry(0.06, 0.12, 0.38), 0.59, 0.82, -2.42, -0.12, 0, 0),
    place(new THREE.BoxGeometry(0.06, 0.12, 0.38), -0.59, 0.82, -2.42, -0.12, 0, 0),
  ];
  if (profileId === 'qingzhao') {
    darkWoodParts.push(buildDragonflyTwinBoomsGeometry(1));
    darkWoodParts.push(buildDragonflyTwinBoomsGeometry(-1));
  }

  const brassParts: THREE.BufferGeometry[] = [
    place(new THREE.ConeGeometry(0.09, 0.22, 12), 0.78, 0.18, -1.2, Math.PI / 2, 0, 0),
    place(new THREE.ConeGeometry(0.09, 0.22, 12), -0.78, 0.18, -1.2, Math.PI / 2, 0, 0),
    place(new THREE.CylinderGeometry(0.016, 0.016, 0.72, 8), 0.7, -0.04, 0.5, 0, 0, Math.PI / 2),
    place(new THREE.CylinderGeometry(0.016, 0.016, 0.72, 8), -0.7, -0.04, 0.5, 0, 0, Math.PI / 2),
    place(new THREE.BoxGeometry(0.02, 0.12, 0.26), 1.05, -0.02, 0.4),
    place(new THREE.BoxGeometry(0.02, 0.12, 0.26), -1.05, -0.02, 0.4),
    place(new THREE.CylinderGeometry(0.024, 0.024, 0.36, 10), 0.68, 0.08, 0.48, -0.15, 0, 0.45),
    place(new THREE.CylinderGeometry(0.024, 0.024, 0.36, 10), -0.68, 0.08, 0.48, -0.15, 0, -0.45),
    place(new THREE.CylinderGeometry(0.02, 0.02, 0.32, 10), 0.74, 0.07, 0.32, 0.15, 0, 0.45),
    place(new THREE.CylinderGeometry(0.02, 0.02, 0.32, 10), -0.74, 0.07, 0.32, 0.15, 0, -0.45),
    place(new THREE.BoxGeometry(0.05, 0.16, 0.12), 0, -0.04, -2.15),
    buildDeckBrassInlayGeometry(1),
    buildDeckBrassInlayGeometry(-1),
    buildSheerRubRailGeometry(),
    place(new THREE.BoxGeometry(0.1, 0.24, 0.28), 0, 0.58, 2.52, 0.55, 0, 0),
    place(new THREE.TorusGeometry(0.045, 0.012, 8, 16), 0, 0.66, 2.64, 0, Math.PI / 2, 0),
    place(new THREE.BoxGeometry(0.04, 0.025, 0.12), 0.38, 0.63, 1.1),
    place(new THREE.BoxGeometry(0.04, 0.025, 0.12), -0.38, 0.63, 1.1),
    place(new THREE.BoxGeometry(1.24, 0.025, 0.12), 0, 0.745, -0.32),
    place(new THREE.BoxGeometry(1.24, 0.025, 0.12), 0, 0.745, -1.88),
    place(new THREE.BoxGeometry(0.12, 0.025, 1.68), 0.56, 0.745, -1.1),
    place(new THREE.BoxGeometry(0.12, 0.025, 1.68), -0.56, 0.745, -1.1),
    place(new THREE.BoxGeometry(0.04, 0.16, 0.04), 0.23, 0.8, -1.84),
    place(new THREE.BoxGeometry(0.04, 0.16, 0.04), -0.23, 0.8, -1.84),
    place(new THREE.CylinderGeometry(0.048, 0.048, 0.025, 14), -0.2, 0.81, -0.41, Math.PI / 2 - 0.35, 0, 0),
    place(new THREE.CylinderGeometry(0.048, 0.048, 0.025, 14), 0, 0.81, -0.41, Math.PI / 2 - 0.35, 0, 0),
    place(new THREE.CylinderGeometry(0.048, 0.048, 0.025, 14), 0.2, 0.81, -0.41, Math.PI / 2 - 0.35, 0, 0),
    place(new THREE.CylinderGeometry(0.05, 0.07, 0.42, 16), 0, 0.8, -0.55, -0.25, 0, 0),
    place(new THREE.CylinderGeometry(0.055, 0.055, 0.1, 14), 0, 1.0, -0.65, 0, 0, Math.PI / 2),
    place(new THREE.CylinderGeometry(0.028, 0.028, 0.62, 16), 0, 1.0, -0.65, 0, 0, Math.PI / 2),
    place(new THREE.CylinderGeometry(0.045, 0.045, 0.03, 12), 0.34, 1.0, -0.65, 0, 0, Math.PI / 2),
    place(new THREE.CylinderGeometry(0.045, 0.045, 0.03, 12), -0.34, 1.0, -0.65, 0, 0, Math.PI / 2),
    place(new THREE.CylinderGeometry(0.016, 0.016, 0.26, 8), 0.32, 0.76, -0.18, -0.55, 0, 0),
    place(new THREE.CylinderGeometry(0.016, 0.016, 0.26, 8), -0.32, 0.76, -0.18, -0.55, 0, 0),
    place(new THREE.CylinderGeometry(0.155, 0.145, 0.12, 16), 0, 0.2, -2.62, Math.PI / 2, 0, 0),
    place(new THREE.CylinderGeometry(0.22, 0.24, 0.05, 16), 0.68, 0.13, -1.62),
    place(new THREE.CylinderGeometry(0.22, 0.24, 0.05, 16), -0.68, 0.13, -1.62),
    place(new THREE.CylinderGeometry(0.025, 0.035, 0.24, 10), 0.36, 0.68, -2.42, 0, 0, -0.12),
    place(new THREE.CylinderGeometry(0.025, 0.035, 0.24, 10), -0.36, 0.68, -2.42, 0, 0, 0.12),
    place(new THREE.CylinderGeometry(0.03, 0.04, 0.06, 8), 0.62, 0.84, -2.2),
    place(new THREE.CylinderGeometry(0.012, 0.012, 0.44, 8), 0.62, 1.06, -2.2),
  ];
  if (profileId === 'zhoubotong') {
    brassParts.push(buildCatamaranBrassBumpersGeometry());
  } else if (profileId === 'xiaofeng') {
    brassParts.push(buildXiaofengTwinJetNozzlesGeometry());
  }

  const hullLiveryParts: THREE.BufferGeometry[] = [
    buildDeckLiveryGeometry(1),
    buildDeckLiveryGeometry(-1),
    place(new THREE.BoxGeometry(0.72, 0.04, 0.58), 0, 0.83, -2.25, -0.06, 0, 0),
    place(new THREE.BoxGeometry(0.82, 0.02, 0.26), 0, 0.85, -2.42, -0.12, 0, 0),
  ];

  const canvasParts: THREE.BufferGeometry[] = [
    place(new THREE.BoxGeometry(0.48, 0.08, 0.46), 0, 0.76, -1.56),
    place(new THREE.BoxGeometry(0.44, 0.14, 0.06), 0, 0.8, -1.78),
  ];

  const inkParts: THREE.BufferGeometry[] = [
    place(new THREE.CylinderGeometry(0.038, 0.038, 0.028, 14), -0.2, 0.81, -0.41, Math.PI / 2 - 0.35, 0, 0),
    place(new THREE.CylinderGeometry(0.038, 0.038, 0.028, 14), 0, 0.81, -0.41, Math.PI / 2 - 0.35, 0, 0),
    place(new THREE.CylinderGeometry(0.038, 0.038, 0.028, 14), 0.2, 0.81, -0.41, Math.PI / 2 - 0.35, 0, 0),
    place(new THREE.BoxGeometry(0.66, 0.02, 0.32), 0, 0.74, -0.16, -0.55, 0, 0),
    place(new THREE.CylinderGeometry(0.08, 0.07, 0.1, 16), 0, 0.2, -2.66, Math.PI / 2, 0, 0),
  ];

  const flightParts: THREE.BufferGeometry[] = [
    place(new THREE.CylinderGeometry(0.16, 0.2, 0.08, 14), 0.68, 0.12, -1.62),
    place(new THREE.CylinderGeometry(0.16, 0.2, 0.08, 14), -0.68, 0.12, -1.62),
  ];

  const woodMesh = mergeMeshParts(woodParts, woodMat);
  if (woodMesh) root.add(woodMesh);

  const darkWoodMesh = mergeMeshParts(darkWoodParts, darkWoodMat);
  if (darkWoodMesh) root.add(darkWoodMesh);

  const brassMesh = mergeMeshParts(brassParts, brassMat);
  if (brassMesh) root.add(brassMesh);

  const hullLiveryMesh = mergeMeshParts(hullLiveryParts, hullMat);
  if (hullLiveryMesh) {
    hullLiveryMesh.userData.noOutline = true;
    root.add(hullLiveryMesh);
  }

  const canvasMesh = mergeMeshParts(canvasParts, canvasMat);
  if (canvasMesh) root.add(canvasMesh);

  const inkMesh = mergeMeshParts(inkParts, inkMat);
  if (inkMesh) root.add(inkMesh);

  const flightMesh = mergeMeshParts(flightParts, flightMat);
  if (flightMesh) {
    flightMesh.userData.noOutline = true;
    root.add(flightMesh);
  }

  // Vintage Racing Number Decals on Parchment Plaques
  const decalMat = new THREE.MeshBasicMaterial({
    map: numberDecalTexture(id + 1),
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
  const decalGeo = new THREE.PlaneGeometry(0.92, 0.46);
  const decalPort = new THREE.Mesh(decalGeo, decalMat);
  decalPort.position.set(0.55, 0.36, 1.5);
  decalPort.rotation.y = Math.PI / 2 - 0.28;
  decalPort.userData.noOutline = true;
  root.add(decalPort);

  const decalStbd = new THREE.Mesh(decalGeo, decalMat);
  decalStbd.position.set(-0.55, 0.36, 1.5);
  decalStbd.rotation.y = -(Math.PI / 2 - 0.28);
  decalStbd.userData.noOutline = true;
  root.add(decalStbd);

  // Pilot-specific glider wings and rotors assembly
  let portWing: THREE.Group;
  let stbdWing: THREE.Group;
  let portRotorPylon: THREE.Group;
  let stbdRotorPylon: THREE.Group;
  let portRotorBlades: THREE.Group;
  let stbdRotorBlades: THREE.Group;
  const extra: ExtraAnimatedParts = {};

  if (profileId === 'qingzhao') {
    portWing = buildQingzhaoWingAssembly(1, woodMat, darkWoodMat, brassMat, dragonflyMat);
    stbdWing = buildQingzhaoWingAssembly(-1, woodMat, darkWoodMat, brassMat, dragonflyMat);
    const portRotor = buildDragonflyDuctedRotorAssembly(1, darkWoodMat, brassMat, dragonflyMat);
    const stbdRotor = buildDragonflyDuctedRotorAssembly(-1, darkWoodMat, brassMat, dragonflyMat);
    portRotorPylon = portRotor.pylon;
    stbdRotorPylon = stbdRotor.pylon;
    portRotorBlades = portRotor.blades;
    stbdRotorBlades = stbdRotor.blades;
  } else if (profileId === 'xiaofeng') {
    portWing = buildXiaofengWingAssembly(1, woodMat, darkWoodMat, brassMat, solarMat);
    stbdWing = buildXiaofengWingAssembly(-1, woodMat, darkWoodMat, brassMat, solarMat);
    const portRotor = buildXiaofengRotorAssembly(1, darkWoodMat, brassMat, solarMat);
    const stbdRotor = buildXiaofengRotorAssembly(-1, darkWoodMat, brassMat, solarMat);
    portRotorPylon = portRotor.pylon;
    stbdRotorPylon = stbdRotor.pylon;
    portRotorBlades = portRotor.blades;
    stbdRotorBlades = stbdRotor.blades;
  } else if (profileId === 'zhoubotong') {
    portWing = buildZhoubotongWingAssembly(1, woodMat, darkWoodMat, brassMat, canvasMat);
    stbdWing = buildZhoubotongWingAssembly(-1, woodMat, darkWoodMat, brassMat, canvasMat);
    const portRotor = buildZhoubotongHeavyPaddleRotorAssembly(1, woodMat, darkWoodMat, brassMat);
    const stbdRotor = buildZhoubotongHeavyPaddleRotorAssembly(-1, woodMat, darkWoodMat, brassMat);
    portRotorPylon = portRotor.pylon;
    stbdRotorPylon = stbdRotor.pylon;
    portRotorBlades = portRotor.blades;
    stbdRotorBlades = stbdRotor.blades;
  } else if (profileId === 'kongming') {
    portWing = buildKongmingWingAssembly(1, woodMat, darkWoodMat, brassMat, canvasMat);
    stbdWing = buildKongmingWingAssembly(-1, woodMat, darkWoodMat, brassMat, canvasMat);
    const portRotor = buildKongmingKiteRotorAssembly(1, woodMat, darkWoodMat, brassMat);
    const stbdRotor = buildKongmingKiteRotorAssembly(-1, woodMat, darkWoodMat, brassMat);
    portRotorPylon = portRotor.pylon;
    stbdRotorPylon = stbdRotor.pylon;
    portRotorBlades = portRotor.blades;
    stbdRotorBlades = stbdRotor.blades;

    const baguaRing = buildBaguaAstrolabeRingAssembly(darkWoodMat, brassMat, silverMat);
    root.add(baguaRing);
    extra.baguaRing = baguaRing;
  } else if (profileId === 'wawa') {
    const portBiplane = buildBiplaneWingAssembly(1, woodMat, darkWoodMat, brassMat, canvasMat, patchworkPinkMat, solarMat, dragonflyMat, patchworkVineMat);
    const stbdBiplane = buildBiplaneWingAssembly(-1, woodMat, darkWoodMat, brassMat, canvasMat, patchworkPinkMat, solarMat, dragonflyMat, patchworkVineMat);
    portWing = portBiplane.wingGroup;
    stbdWing = stbdBiplane.wingGroup;
    const portRotor = buildWawaRotorAssembly(1, woodMat, darkWoodMat, brassMat);
    const stbdRotor = buildWawaRotorAssembly(-1, woodMat, darkWoodMat, brassMat);
    portRotorPylon = portRotor.pylon;
    stbdRotorPylon = stbdRotor.pylon;
    portRotorBlades = portRotor.blades;
    stbdRotorBlades = stbdRotor.blades;

    extra.pinwheels = [portBiplane.pinwheelGroup, stbdBiplane.pinwheelGroup];
  } else {
    // Default & 苏轼 · 晴空信天翁 (Classic Albatross Monohull)
    portWing = buildSushiWingAssembly(1, woodMat, darkWoodMat, brassMat, canvasMat);
    stbdWing = buildSushiWingAssembly(-1, woodMat, darkWoodMat, brassMat, canvasMat);
    const portRotor = buildRotorAssembly(1, woodMat, darkWoodMat, brassMat);
    const stbdRotor = buildRotorAssembly(-1, woodMat, darkWoodMat, brassMat);
    portRotorPylon = portRotor.pylon;
    stbdRotorPylon = stbdRotor.pylon;
    portRotorBlades = portRotor.blades;
    stbdRotorBlades = stbdRotor.blades;
  }

  root.add(portWing);
  root.add(stbdWing);
  root.add(portRotorPylon);
  root.add(stbdRotorPylon);

  // Rider attach point at the helm; local +Z = boat forward
  const riderMount = new THREE.Object3D();
  riderMount.name = 'riderMount';
  riderMount.position.set(0, 0.64, -1.05);
  root.add(riderMount);

  return {
    root,
    riderMount,
    hullMaterial: hullMat,
    portWing,
    stbdWing,
    portRotorPylon,
    stbdRotorPylon,
    portRotorBlades,
    stbdRotorBlades,
    extra,
  };
}

// ---------------------------------------------------------------- boat ----

export class Boat implements IBoat {
  readonly id: number;
  readonly object: THREE.Group; // main adds it to the scene; object.position IS state.position
  readonly state: BoatState;
  readonly riderMount: THREE.Object3D;

  private readonly wake: IWake;
  private readonly spray: ISpray;
  private readonly trail: IJetTrail;
  private visualAssembly: BoatVisualAssembly;
  private visualRoot: THREE.Group;
  private hullMaterial: THREE.ShaderMaterial;
  private portWing: THREE.Group;
  private stbdWing: THREE.Group;
  private portRotorPylon: THREE.Group;
  private stbdRotorPylon: THREE.Group;
  private portRotorBlades: THREE.Group;
  private stbdRotorBlades: THREE.Group;
  private detailedInk = true;
  private wingDeploy = 0;
  private rotorAngle = 0;
  private rotorSpeed = 0;
  private handling: DriverHandling = { acceleration: 1, steering: 1, driftCharge: 1, airControl: 1 };
  private driverProfileId = 'sushi';

  // planar dynamics
  private heading = 0;
  private velX = 0;
  private velZ = 0;
  private yawRate = 0;
  // vertical dynamics
  private vy = 0;
  private unloadTime = 0;
  // orientation springs
  private pitch = 0;
  private pitchVel = 0;
  private roll = 0;
  private rollVel = 0;
  // drift / boost
  private boostTimer = 0;
  private boostTotal = 0;
  private wasDrifting = false;
  // earned glider flight & aerodynamics
  private flightElapsed = 0;
  private flightExtensionTime = 0;
  private flightStartClearance = 0;
  private flightDesiredYPrev = 0;
  private flightTargetVy = 0;
  private flightPenaltyApplied = false;
  private aeroPitch = 0;
  private course?: ICourse;
  // ground effect & proximity resonance (Task 8.2)
  private groundEffect = 0;
  private groundResonance = 0;
  private groundResonanceCharge = 0;
  private groundTrailCd = 0;
  // thermal updrafts & wind tunnels (Task 8.3)
  private thermalUpdraft = 0;
  private windTunnelBoost = 0;
  private readonly prevPosForTunnel = new THREE.Vector3();
  // bookkeeping
  private prevSpeed = 0;
  private lateralG = 0;
  private turnSprayCd = 0;
  private boostSprayCd = 0;
  private trailCd = 0;
  private driftTrailCd = 0;
  private opponentDriftSprayCd = 0;
  private opponentFxScale = 1;
  private driftFxEmissions = 0;
  private lastT = 0;
  private readonly blob: THREE.Mesh;
  private readonly footprint: THREE.Mesh;
  private readonly thrustShell: THREE.InstancedMesh;
  private readonly thrustOuter: THREE.InstancedMesh;
  private readonly thrustCore: THREE.InstancedMesh;
  private readonly thrustRings: THREE.InstancedMesh;
  private boostFx = 0;
  private flightFx = 0;
  private liftBurstTimer = 0;
  private liftSplashPending = false;
  private flightMissFxTimer = 0;
  private airBrakeFx = 0;
  private flightTargetSpeed = 42;
  private flightRingActiveCount = 0;
  private flightPlumeLength = 0;
  private flightFlowDeflection = 0;

  constructor(opts: BoatOptions) {
    this.id = opts.id;
    this.wake = opts.wake;
    this.spray = opts.spray;
    this.trail = opts.trail;
    this.course = opts.course;
    this.driverProfileId = opts.driverId || 'sushi';
    this.detailedInk = opts.detailedInk !== false;

    this.object = new THREE.Group();
    this.object.name = `boat-${opts.id}`;

    this.visualAssembly = buildBoatVisual(opts.id, opts.color, this.driverProfileId);
    this.visualRoot = this.visualAssembly.root;
    this.object.add(this.visualRoot);
    this.riderMount = this.visualAssembly.riderMount;
    this.hullMaterial = this.visualAssembly.hullMaterial;
    this.portWing = this.visualAssembly.portWing;
    this.stbdWing = this.visualAssembly.stbdWing;
    this.portRotorPylon = this.visualAssembly.portRotorPylon;
    this.stbdRotorPylon = this.visualAssembly.stbdRotorPylon;
    this.portRotorBlades = this.visualAssembly.portRotorBlades;
    this.stbdRotorBlades = this.visualAssembly.stbdRotorBlades;

    // Initial folded resting pose for surface navigation
    this.portWing.rotation.set(-0.04, -1.45, -0.12, 'YXZ');
    this.stbdWing.rotation.set(-0.04, 1.45, 0.12, 'YXZ');
    this.portRotorPylon.rotation.x = -0.42;
    this.stbdRotorPylon.rotation.x = -0.42;

    if (this.detailedInk) {
      addOutline(this.visualRoot);
      markInk(this.visualRoot);
    }

    // Ink blob shadow — added AFTER outline/ink passes so it stays out of
    // both (transparent, world-flat; posed each frame in update()).
    this.blob = buildBlobShadow();
    this.object.add(this.blob);
    this.footprint = buildFlightFootprint();
    this.footprint.layers.enable(LAYER_ENERGY);
    this.object.add(this.footprint);
    const thrust = buildThrustVisual();
    this.thrustShell = thrust.shell;
    this.thrustOuter = thrust.outer;
    this.thrustCore = thrust.core;
    this.thrustRings = thrust.rings;
    this.object.add(this.thrustShell, this.thrustOuter, this.thrustCore, this.thrustRings);

    this.state = {
      position: this.object.position, // live reference — never reassigned
      quaternion: this.object.quaternion,
      speed: 0,
      rpm: 0,
      throttle: 0,
      steer: 0,
      drifting: false,
      boostCharge: 0,
      driftBankProgress: 0,
      driftReleaseReady: false,
      boosting: false,
      boostRemaining: 0,
      flightCharges: 0,
      flightPhase: 'surface',
      flightRemaining: 0,
      flightExtensionReady: false,
      flightExtensionUsed: false,
      flightExtended: false,
      flightClearance: -TUNING.draft,
      flightThrust: 0,
      flightAirBrake: 0,
      flightsCleared: 0,
      flightRouteCursor: 0,
      flightRouteIndex: -1,
      flightPressure: 0,
      flightDenied: false,
      flightRouteMiss: false,
      flightRouteState: 'idle',
      flightRouteFailReason: 'none',
      flightFailure: null,
      flightGateProgress: 0,
      flightPenaltyRemaining: 0,
      groundEffect: 0,
      groundResonance: 0,
      groundResonanceCharge: 0,
      thermalUpdraft: 0,
      windTunnelBoost: 0,
      airborne: false,
      airTime: 0,
      landImpulse: 0,
      lateralG: 0,
      longG: 0,
      heading: 0,
    };

    this.teleport(0, 0, 0); // snap onto the water surface
  }

  /** dt is FIXED 1/60 — no substepping needed. */
  update(dt: number, input: BoatInput, t: number): void {
    this.lastT = t;
    const st = this.state;
    const pos = this.object.position;

    const thr = clamp(input.throttle, -1, 1);
    const steer = clamp(input.steer, -1, 1);
    const flightWasActive = st.flightPhase !== 'surface';
    // Input adapters only send a surface air-brake after Final has armed. It
    // deliberately reuses the proven flight-brake envelope without becoming a
    // drift, charge source, boost payout, or reverse gear.
    const surfaceReturnBrake = !flightWasActive && input.airBrake;
    const airBrakeTarget = input.airBrake && (flightWasActive || surfaceReturnBrake) ? 1 : 0;
    const airBrakeTau = airBrakeTarget > this.airBrakeFx ? TUNING.airBrakeAttack : TUNING.airBrakeRelease;
    this.airBrakeFx += (airBrakeTarget - this.airBrakeFx) * (1 - Math.exp(-dt / airBrakeTau));
    st.flightDenied = false;
    st.flightExtended = false;
    st.flightRouteMiss = false;
    st.flightPenaltyRemaining = Math.max(0, st.flightPenaltyRemaining - dt);

    // boost timer (release payout from a previous frame)
    if (this.boostTimer > 0) this.boostTimer = Math.max(0, this.boostTimer - dt);
    let boosting = this.boostTimer > 0;
    const surfaceBoost = boosting && !flightWasActive && !surfaceReturnBrake;
    const taperRef = TUNING.topSpeed * TUNING.taperHeadroom * (surfaceBoost ? TUNING.boostTopMul : 1);
    const accel = TUNING.accel * this.handling.acceleration * (surfaceBoost ? TUNING.boostAccelMul : 1);

    // heading frame: forward (sinθ, cosθ) — θ=0 → +Z, +θ turns left (CCW from
    // above); port = local +X
    const sinH = Math.sin(this.heading);
    const cosH = Math.cos(this.heading);
    const fwdX = sinH;
    const fwdZ = cosH;
    const portX = cosH;
    const portZ = -sinH;

    // velocity in the boat frame
    let vF = this.velX * fwdX + this.velZ * fwdZ; // signed forward speed
    let vL = this.velX * portX + this.velZ * portZ; // + = sliding to port

    // Effective surface drift (including air-brake to drift landing handoff)
    const effectiveDrift = (input.drift || (st.flightPhase === 'surface' && input.airBrake && !surfaceReturnBrake)) && st.flightPhase === 'surface';

    if (flightWasActive) {
      // Aerodynamic directional stability (rudders + wing span damping side-slip)
      const flightGrip = 9.5 + 7.5 * this.airBrakeFx;
      vL *= Math.max(0, 1 - flightGrip * dt);
    } else if (surfaceReturnBrake) {
      const dragCompensation = TUNING.dragQuad * vF * Math.abs(vF);
      const maxDecel = TUNING.returnBrakeDecel * Math.max(0.5, this.airBrakeFx);
      const aF = clamp(
        (TUNING.returnBrakeTargetSpeed - vF) * 3.2 + dragCompensation,
        -maxDecel,
        0,
      );
      vF += aF * dt;
      vF = Math.max(0, vF);
      const brakeGrip = TUNING.lateralGrip + (TUNING.airBrakeGrip - TUNING.lateralGrip) * this.airBrakeFx;
      vL *= Math.max(0, 1 - brakeGrip * dt);
    } else if (!st.airborne) {
      let aF: number;
      if (thr >= 0) {
        const driveMul = st.flightPenaltyRemaining > 0 ? TUNING.flightMissDriveMul : 1;
        aF = thr * accel * driveMul * Math.max(0, 1 - vF / taperRef);
      } else if (vF > 0.5) {
        aF = thr * TUNING.brakeDecel; // braking while still moving forward
      } else {
        aF = thr * TUNING.reverseAccel * Math.max(0, 1 + vF / TUNING.reverseSpeed);
      }
      aF -= TUNING.dragQuad * vF * Math.abs(vF);
      if (effectiveDrift) aF -= TUNING.driftScrub * vF;
      vF += aF * dt;

      // lateral hydrodynamic grip — cut while drifting (powerslide)
      const brakeGrip = TUNING.lateralGrip + (TUNING.airBrakeGrip - TUNING.lateralGrip) * this.airBrakeFx;
      const driftCut = effectiveDrift ? TUNING.driftGripMul + (1 - TUNING.driftGripMul) * this.airBrakeFx : 1;
      const grip = brakeGrip * driftCut;
      vL *= Math.max(0, 1 - grip * dt);
    }
    // airborne: ballistic — horizontal velocity carries through untouched

    this.velX = fwdX * vF + portX * vL;
    this.velZ = fwdZ * vF + portZ * vL;

    // steering: full authority once moving, capped by lateral G at speed,
    // reversed in reverse
    const speedAbs = Math.abs(vF);
    const steeringMul = flightWasActive ? this.handling.airControl : this.handling.steering;
    const latGMax = (TUNING.latGMax + (TUNING.airBrakeLatG - TUNING.latGMax) * this.airBrakeFx) * steeringMul;
    const gCap = latGMax / Math.max(speedAbs, 0.5);
    const authority = Math.min(speedAbs / TUNING.steerFullSpeed, 1) * (vF < 0 ? -1 : 1);
    const yawTarget = -steer * Math.min(TUNING.yawRateMax * steeringMul, gCap) * authority;
    const baseYawDamp = TUNING.yawDamp + (TUNING.airBrakeYawDamp - TUNING.yawDamp) * this.airBrakeFx;
    const driftYawCut = effectiveDrift ? TUNING.driftYawDampMul + (1 - TUNING.driftYawDampMul) * this.airBrakeFx : 1;
    const yawDamp = baseYawDamp * driftYawCut;
    this.yawRate += (yawTarget - this.yawRate) * Math.min(1, yawDamp * dt);
    this.heading = wrapAngle(this.heading + this.yawRate * dt);
    this.lateralG = vF * this.yawRate; // + = turning left

    // drift charge / boost payout on release
    if (effectiveDrift && !flightWasActive) {
      if (speedAbs > TUNING.driftMinSpeed) {
        st.boostCharge = Math.min(1, st.boostCharge + dt * this.handling.driftCharge / TUNING.driftChargeTime);
      }
    } else if (this.wasDrifting) {
      if (st.boostCharge >= TUNING.boostReleaseMin) {
        this.boostTimer = st.boostCharge * TUNING.boostDuration;
        this.boostTotal = this.boostTimer;
        // Flying never replaces the old payout. A wave jump on the release
        // frame must not steal the earned charge; only controlled flight blocks
        // re-arming, which prevents an infinite airborne chain.
        if (!flightWasActive) st.flightCharges = Math.min(2, st.flightCharges + 1);
      }
      st.boostCharge = 0;
    }
    this.wasDrifting = effectiveDrift;
    boosting = this.boostTimer > 0;

    // Process the trigger after drift payout so releasing Shift and pressing Space
    // on the same simulation frame is a valid combo.
    // On the water surface, pressing Space ALWAYS launches the glider (spending a charge
    // if available, or catching a free sea-breeze launch if charges are 0).
    if (input.flightTrigger) {
      if (st.flightPhase === 'surface') {
        if (st.flightCharges > 0) st.flightCharges--;
        st.flightPhase = 'spool';
        st.flightRouteState = 'idle';
        st.flightRouteIndex = -1;
        st.flightRouteFailReason = 'none';
        st.flightGateProgress = 0;
        this.flightElapsed = 0;
        this.flightExtensionTime = 0;
        st.flightExtensionReady = false;
        st.flightExtensionUsed = false;
        this.liftBurstTimer = 0.22;
        this.liftSplashPending = true;
        this.flightPenaltyApplied = false;
        st.airborne = false;
        st.airTime = 0;
        this.unloadTime = 0;
      } else if (st.flightCharges > 0 && this.canExtendFlight()) {
        st.flightCharges--;
        this.flightExtensionTime = TUNING.flightExtension;
        st.flightExtensionUsed = true;
        st.flightExtensionReady = false;
        st.flightExtended = true;
        // Arrest a late descent without snapping the hull upward.
        this.vy = Math.max(this.vy, 2.5);
        this.flightTargetVy = Math.max(this.flightTargetVy, 0);
        this.liftBurstTimer = Math.max(this.liftBurstTimer, 0.22);
      } else {
        st.flightDenied = true;
      }
    }

    // ---- Aerodynamic Sky-Stream & Waterway Channel Assist (Player Comfort & Flow) ----
    if (this.id === 0 && this.course && speedAbs > 3.5) {
      const activeRoute = this.course.routeForBoat(this.id);
      this.course.sample(pos, _guideSample, activeRoute);
      const tx = _guideSample.tangent.x;
      const tz = _guideSample.tangent.z;
      const toCenterX = _guideSample.point.x - pos.x;
      const toCenterZ = _guideSample.point.z - pos.z;
      const dist = _guideSample.distance;

      if (st.flightPhase !== 'surface' && activeRoute !== 'surface') {
        // In-flight sky-stream alignment: gently guide heading & lateral path toward the active flight route
        const lookLead = Math.max(8, speedAbs * 0.28);
        const aimX = toCenterX + tx * lookLead;
        const aimZ = toCenterZ + tz * lookLead;
        const desiredHeading = Math.atan2(aimX, aimZ);
        const headingErr = wrapAngle(desiredHeading - this.heading);
        const steerOverride = 1.0 - Math.min(0.65, Math.abs(steer) * 0.65);
        const alignRate = (2.6 + clamp(dist / 6.0, 0, 2.4)) * steerOverride;
        this.heading = wrapAngle(this.heading + clamp(headingErr, -0.8, 0.8) * Math.min(1, alignRate * dt));
        // Gentle lateral centering stream so the glider stays comfortably inside the sky corridor
        if (dist > 1.2) {
          const pull = clamp((dist - 1.2) * 2.2, 0, 14) * steerOverride;
          const invD = 1 / Math.max(0.1, dist);
          this.velX += toCenterX * invD * pull * dt;
          this.velZ += toCenterZ * invD * pull * dt;
        }
      } else if (st.flightPhase === 'surface' && dist > 11.0) {
        // Surface waterway channel current: prevent spinning out or getting lost off-course
        const lookLead = Math.max(12, speedAbs * 0.42);
        const aimX = toCenterX + tx * lookLead;
        const aimZ = toCenterZ + tz * lookLead;
        const desiredHeading = Math.atan2(aimX, aimZ);
        const headingErr = wrapAngle(desiredHeading - this.heading);
        const offFactor = clamp((dist - 11.0) / 16.0, 0, 1);
        const alignRate = (1.8 + offFactor * 3.8) * (dist > 24.0 ? 1.0 : 1.0 - Math.abs(steer) * 0.45);
        this.heading = wrapAngle(this.heading + clamp(headingErr, -1.1, 1.1) * Math.min(1, alignRate * dt));
        if (dist > 16.0) {
          const pull = clamp((dist - 16.0) * 1.8, 0, 16);
          const invD = 1 / Math.max(0.1, dist);
          this.velX += toCenterX * invD * pull * dt;
          this.velZ += toCenterZ * invD * pull * dt;
        }
      }
    }

    // integrate planar position
    pos.x += this.velX * dt;
    pos.z += this.velZ * dt;

    // ---- buoyancy & flight aerodynamics ----
    const L = TUNING.sampleLong;
    const W = TUNING.sampleLat;
    const hBowL = waterHeight(pos.x + portX * W + fwdX * L, pos.z + portZ * W + fwdZ * L, t);
    const hBowR = waterHeight(pos.x - portX * W + fwdX * L, pos.z - portZ * W + fwdZ * L, t);
    const hMidL = waterHeight(pos.x + portX * W, pos.z + portZ * W, t);
    const hMidR = waterHeight(pos.x - portX * W, pos.z - portZ * W, t);
    const hSt = waterHeight(pos.x - fwdX * L, pos.z - fwdZ * L, t);
    const surfaceY = (hBowL + hBowR + hMidL + hMidR + hSt) / 5;
    const targetY = surfaceY - TUNING.draft;

    st.landImpulse = 0; // only landing frames report an impact
    if (st.flightPhase !== 'surface') {
      vF = this.updateFlight(dt, surfaceY, targetY, thr, vF, input, surfaceReturnBrake);
      this.velX = fwdX * vF + portX * vL;
      this.velZ = fwdZ * vF + portZ * vL;
    } else if (st.airborne) {
      const thermalSample = this.course?.sampleThermalUpdraft(pos);
      if (thermalSample && thermalSample.intensity > 0.01) {
        this.thermalUpdraft += (thermalSample.intensity - this.thermalUpdraft) * (1 - Math.exp(-12 * dt));
        this.vy += this.thermalUpdraft * Math.max(0, thermalSample.liftSpeed - this.vy) * TUNING.thermalCouplingK * dt;
      } else {
        this.thermalUpdraft = Math.max(0, this.thermalUpdraft - dt * 3.5);
      }
      this.windTunnelBoost = Math.max(0, this.windTunnelBoost - dt * 2.8);
      st.thermalUpdraft = this.thermalUpdraft;
      st.windTunnelBoost = this.windTunnelBoost;
      this.vy -= TUNING.gravity * dt;
      pos.y += this.vy * dt;
      st.airTime += dt;
      if (this.vy <= 0 && pos.y <= targetY) {
        // water re-contact
        pos.y = targetY;
        const impact = -this.vy;
        this.vy = 0;
        this.unloadTime = 0;
        st.airborne = false;
        st.airTime = 0;
        st.landImpulse = impact;
        _v1.set(pos.x - fwdX * 2.3, hSt + 0.05, pos.z - fwdZ * 2.3);
        if (impact > 0.5) {
          const n = Math.min(TUNING.slamSprayMax, Math.round(impact * TUNING.slamSprayPer));
          this.spray.burst(_v1, n, 2 + impact * 0.6);
        }
        this.wake.push(_v1, fwdX, fwdZ, 1); // slam push

        // Air-brake to Drift Landing Handoff (空中刹车/漂移落地触水无缝切入水面漂移)
        const brakingIntoLand = input.airBrake || this.airBrakeFx > 0.08 || input.drift;
        if (brakingIntoLand && !surfaceReturnBrake) {
          this.wasDrifting = true;
          st.drifting = true;
          if (speedAbs > TUNING.driftMinSpeed) {
            st.boostCharge = Math.min(1, st.boostCharge + dt * this.handling.driftCharge / TUNING.driftChargeTime);
          }
        }
      }
    } else {
      this.thermalUpdraft = Math.max(0, this.thermalUpdraft - dt * 4.0);
      this.windTunnelBoost = Math.max(0, this.windTunnelBoost - dt * 3.0);
      st.thermalUpdraft = this.thermalUpdraft;
      st.windTunnelBoost = this.windTunnelBoost;
      // Water can only push, never pull: downward accel clamps at −g, so brief
      // unloads become free-fall micro-skips that KEEP thrust and grip. The
      // airborne flag latches only after a sustained unload (dwell) — i.e. a
      // real crest-lip launch — and only then does re-contact report
      // landImpulse / spray / wake slam.
      const aY = TUNING.floatK * (targetY - pos.y) - TUNING.floatDamp * this.vy;
      this.vy += Math.max(aY, -TUNING.gravity * TUNING.takeoffG) * dt;
      pos.y += this.vy * dt;
      if (aY <= -TUNING.gravity * TUNING.takeoffG) {
        this.unloadTime += dt;
        if (this.unloadTime >= TUNING.takeoffDwell) {
          st.airborne = true;
          st.airTime = 0;
        }
      } else {
        this.unloadTime = 0;
      }
    }

    // ---- orientation: wave slope + drive feel, critically damped ----
    const bowH = (hBowL + hBowR) * 0.5;
    const portH = (hBowL + hMidL) * 0.5;
    const stbdH = (hBowR + hMidR) * 0.5;
    let pitchT = Math.atan2(bowH - hSt, L * 2); // bow-up positive
    let rollT = Math.atan2(portH - stbdH, W * 2); // port-up positive

    // idle bob: lean into the local water normal when slow
    const idleW = clamp(1 - speedAbs / TUNING.idleBobFadeSpeed, 0, 1);
    if (idleW > 0) {
      waterNormalInto(_nrm, pos.x, pos.z, t);
      const invY = 1 / Math.max(_nrm.y, 0.3);
      pitchT += -(_nrm.x * fwdX + _nrm.z * fwdZ) * invY * idleW * TUNING.idleBobTilt;
      rollT += -(_nrm.x * portX + _nrm.z * portZ) * invY * idleW * TUNING.idleBobTilt;
    }

    // bank into turns (∝ lateral G), bow-up on accel / nose-drop on braking
    rollT += -clamp(this.lateralG / TUNING.latGMax, -1.3, 1.3) * TUNING.bankMax;
    const longG = (vF - this.prevSpeed) / dt;
    this.prevSpeed = vF;
    pitchT += clamp(longG / TUNING.accel, -1, 1) * TUNING.pitchAccelMax;

    if (st.airborne) {
      pitchT *= TUNING.airTiltKeep;
      rollT *= TUNING.airTiltKeep;
    } else if (st.flightPhase !== 'surface') {
      pitchT = this.aeroPitch;
      rollT = -clamp(this.lateralG / TUNING.latGMax, -1.2, 1.2) * TUNING.bankMax * 1.35;
    }

    const w = st.flightPhase !== 'surface' ? 12 : TUNING.tiltOmega; // critically damped: ζ = 1
    this.pitchVel += (w * w * (pitchT - this.pitch) - 2 * w * this.pitchVel) * dt;
    this.pitch += this.pitchVel * dt;
    this.rollVel += (w * w * (rollT - this.roll) - 2 * w * this.rollVel) * dt;
    this.roll += this.rollVel * dt;

    _euler.set(-this.pitch, this.heading, this.roll, 'YXZ'); // euler.x is nose-down positive
    this.object.quaternion.setFromEuler(_euler);

    // ---- ink blob shadow on the water ----
    // Child of the boat group, counter-rotated so it stays world-flat, glued
    // to the local water surface. Gap above the water swells/thins it — the
    // classic anime "off the deck" airtime cue.
    {
      const hMid = (hMidL + hMidR) * 0.5;
      const gap = clamp(pos.y - targetY, 0, 6);
      const air = gap / 4.5;
      _blobQ.copy(this.object.quaternion).invert();
      this.blob.quaternion.copy(_blobQ);
      // biased ~0.45m astern so the ink kisses the transom corners (kills
      // the "levitating stern" daylight gap) without starving the bow
      this.blob.position
        .set(-fwdX * 0.45, hMid + 0.07 - pos.y, -fwdZ * 0.45)
        .applyQuaternion(_blobQ);
      const s = 1 + air * 0.5;
      this.blob.scale.set(2.4 * s, 1, 4.6 * s);
      // 0.36: dark enough to seat the hull, light enough to not read oil-slick
      (this.blob.material as THREE.MeshBasicMaterial).opacity = Math.max(0.11, 0.36 - air * 0.22);

      this.footprint.quaternion.copy(_blobQ);
      this.footprint.position.set(0, hMid + 0.09 - pos.y, 0).applyQuaternion(_blobQ);
      const burstN = clamp(this.liftBurstTimer / 0.22, 0, 1);
      const burstP = 1 - burstN;
      const footprintScale = this.liftBurstTimer > 0 ? 2.8 + burstP * 3.7 : 2.3 + gap * 0.55;
      this.footprint.scale.set(footprintScale, 1, footprintScale * 1.35);
      const footprintMat = this.footprint.material as THREE.MeshBasicMaterial;
      footprintMat.color.setHex(this.flightMissFxTimer > 0 ? PALETTE.uiWarn : PALETTE.flight, THREE.NoColorSpace);
      footprintMat.opacity = this.liftBurstTimer > 0
        ? 0.25 + burstN * 0.6
        : this.flightFx * (0.36 + 0.12 * (1 - air));
    }

    // ---- wake ribbon (every frame) ----
    _v1.set(pos.x - fwdX * 2.3, hSt + 0.04, pos.z - fwdZ * 2.3);
    const wakeI =
      clamp(vF / TUNING.topSpeed, 0, 1) + (input.drift ? TUNING.wakeDriftBoost : 0) + (boosting ? TUNING.wakeBoostBoost : 0);
    // Zero intensity while airborne: the ribbon coasts (no emission in flight)
    // instead of drawing an unbroken confetti trail beneath a flying boat.
    const flightWake = 1 - clamp(Math.max(0, st.flightClearance) / 1.5, 0, 1);
    this.wake.push(_v1, fwdX, fwdZ, st.airborne ? 0 : Math.min(1, wakeI) * flightWake);

    // ---- turn spray off the leeward chine ----
    if (!st.airborne && st.flightPhase === 'surface' && Math.abs(this.lateralG) > TUNING.turnSprayG) {
      this.turnSprayCd -= dt;
      if (this.turnSprayCd <= 0) {
        this.turnSprayCd = TUNING.turnSprayPeriod;
        const side = this.lateralG > 0 ? -1 : 1; // turning left → spray off the starboard chine
        _v2.set(
          pos.x + portX * side * (W + 0.1) - fwdX * 0.6,
          (side > 0 ? hMidL : hMidR) + 0.06,
          pos.z + portZ * side * (W + 0.1) - fwdZ * 0.6,
        );
        this.spray.burst(_v2, 2, 1.5 + speedAbs * 0.12);
      }
    } else {
      this.turnSprayCd = 0;
    }

    // ---- boost exhaust spray ----
    if (this.liftSplashPending) {
      this.liftSplashPending = false;
      _v2.set(pos.x, surfaceY + 0.08, pos.z);
      _v1.set(fwdX, 0, fwdZ);
      _v3.set(portX, 0, portZ);
      this.spray.takeoff(_v2, _v1, _v3, this.id === 0 ? 34 : Math.round(12 * this.opponentFxScale), 7.5);
    }

    if (boosting && !st.airborne && st.flightClearance < 1.2) {
      this.boostSprayCd -= dt;
      if (this.boostSprayCd <= 0) {
        this.boostSprayCd = TUNING.boostSprayPeriod;
        _v2.set(pos.x - fwdX * 2.4, hSt + 0.1, pos.z - fwdZ * 2.4);
        this.spray.burst(_v2, 3, 3 + speedAbs * 0.15);
      }
    }

    this.driftTrailCd -= dt;
    this.opponentDriftSprayCd -= dt;
    if (effectiveDrift && st.boostCharge > 0.04 && speedAbs > TUNING.driftMinSpeed && this.driftTrailCd <= 0) {
      const opponent = this.id > 0;
      this.driftTrailCd = opponent ? 0.052 / this.opponentFxScale : 0.05;
      const side = Math.abs(this.lateralG) > 0.5 ? (this.lateralG > 0 ? -1 : 1) : (steer >= 0 ? 1 : -1);
      const charge = st.boostCharge;
      const streams = opponent ? 2 : 1;
      for (let stream = 0; stream < streams; stream++) {
        const streamSide = opponent ? (stream === 0 ? -1 : 1) : side;
        this.trail.emit(
          pos.x + portX * streamSide * 0.88 - fwdX * 1.15,
          pos.y + 0.06,
          pos.z + portZ * streamSide * 0.88 - fwdZ * 1.15,
          -fwdX * (0.78 + charge) + portX * streamSide * (opponent ? 1.35 : 0.65),
          0.2 + charge * 0.45,
          -fwdZ * (0.78 + charge) + portZ * streamSide * (opponent ? 1.35 : 0.65),
          opponent ? (stream === 0 ? 0xffac3d : 0xffdc7a) : PALETTE.boost,
          (opponent ? 0.24 : 0.11) + charge * 0.14,
          (opponent ? 0.62 : 0.24) + charge * 0.18,
        );
        this.driftFxEmissions++;
      }
    }

    // Opponent technique must be readable in the world, not through another
    // HUD badge. Two short stern sprays mark a real drift input, with a simple
    // distance LOD to avoid filling the horizon when the field spreads out.
    if (this.id > 0 && effectiveDrift && !st.airborne && st.flightPhase === 'surface' &&
        speedAbs > TUNING.driftMinSpeed && this.opponentDriftSprayCd <= 0) {
      this.opponentDriftSprayCd = 0.075 / this.opponentFxScale;
      for (const streamSide of [-1, 1]) {
        _v2.set(
          pos.x + portX * streamSide * 0.8 - fwdX * 1.7,
          hSt + 0.06,
          pos.z + portZ * streamSide * 0.8 - fwdZ * 1.7,
        );
        this.spray.burst(_v2, 2, (2.25 + speedAbs * 0.09) * this.opponentFxScale);
        this.driftFxEmissions++;
      }
    }

    this.updateThrustVisual(dt, t, boosting, st.flightThrust, fwdX, fwdZ, portX, portZ);
    this.updateWingAndRotorVisual(dt, t, flightWasActive, vF, steer);

    // ---- surface ground effect update ----
    if (!flightWasActive) {
      const clearance = pos.y - surfaceY;
      let groundSigma = 0;
      if (clearance >= TUNING.groundEffectMinAlt && clearance <= TUNING.groundEffectMaxAlt) {
        if (clearance >= TUNING.groundEffectPeakAltHi) {
          const tPos = (TUNING.groundEffectMaxAlt - clearance) / (TUNING.groundEffectMaxAlt - TUNING.groundEffectPeakAltHi);
          groundSigma = tPos * tPos * (3 - 2 * tPos);
        } else if (clearance >= TUNING.groundEffectPeakAltLo) {
          groundSigma = 1.0;
        } else {
          const tPos = (clearance - TUNING.groundEffectMinAlt) / (TUNING.groundEffectPeakAltLo - TUNING.groundEffectMinAlt);
          groundSigma = tPos * tPos * (3 - 2 * tPos);
        }
      }
      this.groundEffect = groundSigma;
      st.groundEffect = groundSigma;
      this.groundResonance = 0;
      st.groundResonance = 0;
      if (st.flightCharges < 2 && speedAbs > 10) {
        this.groundResonanceCharge = Math.min(1.0, this.groundResonanceCharge + dt * 0.28);
        if (this.groundResonanceCharge >= 1.0) {
          st.flightCharges = Math.min(2, st.flightCharges + 1);
          this.liftBurstTimer = 0.22;
          this.groundResonanceCharge = 0;
        }
      } else {
        this.groundResonanceCharge = Math.max(0, this.groundResonanceCharge - dt * 0.5);
      }
      st.groundResonanceCharge = this.groundResonanceCharge;
    }

    // ---- ground effect surface wind vortex streamlines & resonance sparkles ----
    if (this.groundEffect > 0.15 && speedAbs > 14) {
      this.groundTrailCd -= dt;
      if (this.groundTrailCd <= 0) {
        const opponent = this.id > 0;
        this.groundTrailCd = TUNING.groundEffectTrailPeriod / this.opponentFxScale;
        const tipSpan = 1.85;
        const waterY = surfaceY + 0.05;
        const streamSpeed = 0.32 * vF;
        // Port wingtip ground vortex
        this.trail.emit(
          pos.x + portX * tipSpan - fwdX * 0.15,
          waterY,
          pos.z + portZ * tipSpan - fwdZ * 0.15,
          -fwdX * streamSpeed + portX * 1.6,
          0.12,
          -fwdZ * streamSpeed + portZ * 1.6,
          0xffffff,
          (opponent ? 0.22 : 0.16) + this.groundEffect * 0.08,
          0.36,
        );
        // Starboard wingtip ground vortex
        this.trail.emit(
          pos.x - portX * tipSpan - fwdX * 0.15,
          waterY,
          pos.z - portZ * tipSpan - fwdZ * 0.15,
          -fwdX * streamSpeed - portX * 1.6,
          0.12,
          -fwdZ * streamSpeed - portZ * 1.6,
          0xffffff,
          (opponent ? 0.22 : 0.16) + this.groundEffect * 0.08,
          0.36,
        );
        // Resonant sunlit sparkle motes when in active resonance
        if (this.groundResonance > 0.35 && !opponent) {
          this.trail.emit(
            pos.x - fwdX * 0.4,
            waterY + 0.04,
            pos.z - fwdZ * 0.4,
            -fwdX * 0.4,
            0.35,
            -fwdZ * 0.4,
            PALETTE.sun,
            0.12 + this.groundResonance * 0.06,
            0.32,
          );
        }
      }
    } else {
      this.groundTrailCd = 0;
    }

    // ---- thermal updraft sun motes & wind tunnel jet streamlines ----
    if (this.thermalUpdraft > 0.2 && this.id === 0) {
      this.trail.emit(
        pos.x + portX * (Math.sin(t * 19) * 1.5) - fwdX * 0.4,
        pos.y + 0.35,
        pos.z + portZ * (Math.sin(t * 19) * 1.5) - fwdZ * 0.4,
        -fwdX * 0.3,
        1.5 + this.thermalUpdraft * 1.8,
        -fwdZ * 0.3,
        PALETTE.sun,
        0.16 + this.thermalUpdraft * 0.1,
        0.42,
      );
    }
    if (this.windTunnelBoost > 0.25) {
      const tipSpan = 2.1;
      for (const side of [-1, 1]) {
        this.trail.emit(
          pos.x + portX * tipSpan * side - fwdX * 0.25,
          pos.y + 0.12,
          pos.z + portZ * tipSpan * side - fwdZ * 0.25,
          -fwdX * (1.5 + this.windTunnelBoost * 2.8),
          0.05,
          -fwdZ * (1.5 + this.windTunnelBoost * 2.8),
          0xffffff,
          0.18 + this.windTunnelBoost * 0.12,
          0.36,
        );
      }
    }

    // ---- state ----
    st.speed = vF;
    st.throttle = thr;
    st.steer = steer;
    const currentDrift = (input.drift || (st.flightPhase === 'surface' && input.airBrake && !surfaceReturnBrake)) && st.flightPhase === 'surface';
    st.drifting = currentDrift || this.wasDrifting;
    st.driftReleaseReady = st.drifting && st.flightPhase === 'surface' &&
      speedAbs > TUNING.driftMinSpeed && st.boostCharge >= TUNING.boostReleaseMin;
    st.boosting = boosting;
    st.boostRemaining = boosting && this.boostTotal > 0 ? clamp(this.boostTimer / this.boostTotal, 0, 1) : 0;
    st.driftBankProgress = clamp(st.boostCharge / TUNING.boostReleaseMin, 0, 1);
    st.flightClearance = pos.y - surfaceY;
    st.flightAirBrake = this.airBrakeFx;
    st.flightExtensionReady = this.canExtendFlight();
    st.flightPressure = flightWasActive ? smooth01(clamp((speedAbs - TUNING.topSpeed) / 14, 0, 1)) : 0;
    st.thermalUpdraft = this.thermalUpdraft;
    st.windTunnelBoost = this.windTunnelBoost;
    st.lateralG = this.lateralG;
    st.longG = longG;
    st.heading = this.heading;
    st.rpm = clamp(
      (speedAbs / (TUNING.topSpeed * (boosting ? TUNING.boostTopMul : 1))) * 0.85 + Math.abs(thr) * 0.15 + (boosting ? 0.12 : 0),
      0,
      1,
    );
    this.prevPosForTunnel.copy(pos);
    // st.position / st.quaternion are live references — already current.
  }

  private updateThrustVisual(
    dt: number,
    t: number,
    boosting: boolean,
    flightThrust: number,
    fwdX: number,
    fwdZ: number,
    portX: number,
    portZ: number,
  ): void {
    const st = this.state;
    const boostTarget = boosting ? 1 : 0;
    const flightTarget = Math.max(flightThrust, st.flightCharges > 0 ? 0.08 : 0);
    const boostRate = boostTarget > this.boostFx ? 22 : 6;
    this.boostFx += (boostTarget - this.boostFx) * (1 - Math.exp(-boostRate * dt));
    if (flightTarget >= this.flightFx) this.flightFx = flightTarget;
    else this.flightFx += (flightTarget - this.flightFx) * (1 - Math.exp(-7 * dt));
    this.liftBurstTimer = Math.max(0, this.liftBurstTimer - dt);
    this.flightMissFxTimer = Math.max(0, this.flightMissFxTimer - dt);

    const warn = st.flightDenied || st.flightRouteMiss || this.flightMissFxTimer > 0;
    const liftColor = warn ? PALETTE.uiWarn : PALETTE.flight;
    (this.thrustShell.material as THREE.MeshBasicMaterial).color.setHex(
      warn ? PALETTE.uiWarn : PALETTE.flightDeep,
      THREE.NoColorSpace,
    );
    this.thrustOuter.setColorAt(1, _fxColor.setHex(liftColor, THREE.NoColorSpace));
    this.thrustOuter.setColorAt(2, _fxColor.setHex(liftColor, THREE.NoColorSpace));
    if (this.thrustOuter.instanceColor) this.thrustOuter.instanceColor.needsUpdate = true;

    const boostPulse = 0.9 + 0.1 * Math.sin(t * 34 + this.id);
    // Surface boost hands off to the twin anti-grav emitters instead of
    // stacking three bright plumes on the launch frame.
    const boostVisual = this.boostFx * (1 - this.flightFx * 0.92);
    const boostLen = 0.06 + boostVisual * 2.3 * boostPulse;
    this.setThrustInstance('outer', 0, 0, 0.2, -2.64 - boostLen * 0.5, _fxQBoost, 0.3 * boostVisual, boostLen);
    this.setThrustInstance('core', 0, 0, 0.2, -2.64 - boostLen * 0.42, _fxQBoost, 0.085 * boostVisual, boostLen * 0.72);

    const burst = clamp(this.liftBurstTimer / 0.22, 0, 1);
    const pulseStep = Math.floor((t * 13 + this.id * 0.73) % 3);
    const pulse = pulseStep === 0 ? 0.88 : pulseStep === 1 ? 1 : 1.12;
    const missCut = warn ? 0.55 : 1;
    // The emitter is a short energy core. Height is conveyed by the moving
    // rings and footprint below, so flight can never turn it into a solid beam.
    const shellLen = (0.14 + this.flightFx * 1.12 + burst * 0.34) * pulse * missCut;
    const outerLen = (0.1 + this.flightFx * 0.82 + burst * 0.22) * pulse * missCut;
    const coreLen = (0.06 + this.flightFx * 0.48 + burst * 0.12) * pulse * missCut;
    const shellRadius = (0.02 + this.flightFx * 0.35 + burst * 0.09) * missCut;
    const outerRadius = (0.016 + this.flightFx * 0.23 + burst * 0.06) * missCut;
    const coreRadius = (0.01 + this.flightFx * 0.085 + burst * 0.024) * missCut;
    this.flightPlumeLength = shellLen;
    this.flightFlowDeflection = this.airBrakeFx * Math.abs(st.steer);
    this.flightRingActiveCount = 0;
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const dir = _fxFlowDir.set(
        side * 0.15 + st.steer * this.airBrakeFx * 0.32,
        -0.98,
        -0.08 - st.flightPressure * 0.1,
      ).normalize();
      const q = _fxFlowQ.setFromUnitVectors(_fxAxisY, dir);
      this.setThrustInstance(
        'shell', i,
        side * 0.68 + dir.x * shellLen * 0.5,
        0.12 + dir.y * shellLen * 0.5,
        -1.62 + dir.z * shellLen * 0.5,
        q, shellRadius, shellLen,
      );
      this.setThrustInstance(
        'outer', i + 1,
        side * 0.68 + dir.x * outerLen * 0.5,
        0.12 + dir.y * outerLen * 0.5,
        -1.62 + dir.z * outerLen * 0.5,
        q, outerRadius, outerLen,
      );
      this.setThrustInstance(
        'core', i + 1,
        side * 0.68 + dir.x * coreLen * 0.5,
        0.12 + dir.y * coreLen * 0.5,
        -1.62 + dir.z * coreLen * 0.5,
        q, coreRadius, coreLen,
      );

      // Broken travelling arcs shed into the downwash instead of forming a portal tube.
      for (let ring = 0; ring < 6; ring++) {
        const phase = ((t * 1.9 + ring / 6 + i * 0.11) % 1 + 1) % 1;
        const strength = clamp(this.flightFx * (1 - phase * 0.35) + burst * (1 - phase), 0, 1);
        const travel = 0.24 + phase * (1.4 + this.flightFx * 1.2);
        const radius = (0.11 + phase * 0.5) * strength * missCut;
        const spiralAngle = phase * Math.PI * 3.2 + t * 3.4 + i * Math.PI;
        const spiralRadius = Math.sin(phase * Math.PI) * (0.04 + phase * 0.24) * strength;
        _fxRingQ.setFromUnitVectors(_fxAxisZ, dir)
          .multiply(_fxRingSpinQ.setFromAxisAngle(_fxAxisZ, spiralAngle * 0.34));
        this.setFlowRingInstance(
          i * 6 + ring,
          side * 0.68 + dir.x * travel + Math.cos(spiralAngle) * spiralRadius,
          0.12 + dir.y * travel,
          -1.62 + dir.z * travel + Math.sin(spiralAngle) * spiralRadius,
          _fxRingQ,
          radius,
          1 + this.flightFlowDeflection * 0.4,
          1 - this.flightFlowDeflection * 0.22,
        );
        if (radius > 0.01) this.flightRingActiveCount++;
      }
    }

    // S+A/D vector braking: a broad lateral plasma wall on the outside pad.
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const turnAmount = side < 0 ? Math.max(0, -st.steer) : Math.max(0, st.steer);
      const n = this.airBrakeFx * turnAmount;
      _v2.set(side, -0.08, -0.18).normalize();
      _blobQ.setFromUnitVectors(_v1.set(0, 1, 0), _v2);
      const len = n * (2.8 + 0.35 * Math.sin(t * 29 + i));
      this.setThrustInstance('shell', i + 2, side * 0.72 + _v2.x * len * 0.5, 0.2 + _v2.y * len * 0.5,
        -1.45 + _v2.z * len * 0.5, _blobQ, 0.46 * n, len);
      this.setThrustInstance('outer', i + 3, side * 0.72 + _v2.x * len * 0.43, 0.2 + _v2.y * len * 0.43,
        -1.45 + _v2.z * len * 0.43, _blobQ, 0.32 * n, len * 0.86);
      this.setThrustInstance('core', i + 3, side * 0.72 + _v2.x * len * 0.3, 0.2 + _v2.y * len * 0.3,
        -1.45 + _v2.z * len * 0.3, _blobQ, 0.11 * n, len * 0.6);
    }
    this.thrustShell.instanceMatrix.needsUpdate = true;
    this.thrustOuter.instanceMatrix.needsUpdate = true;
    this.thrustCore.instanceMatrix.needsUpdate = true;
    this.thrustRings.instanceMatrix.needsUpdate = true;

    this.trailCd -= dt;
    if (this.trailCd <= 0 && (this.boostFx > 0.25 || this.flightFx > 0.3)) {
      this.trailCd = this.flightFx > 0.3 ? 0.1 : 0.055;
      const pos = this.object.position;
      const pulse = 0.85 + 0.15 * Math.sin(t * 19 + this.id * 2.3);
      if (this.boostFx > 0.25) {
        this.trail.emit(
          pos.x - fwdX * 2.85,
          pos.y + 0.2,
          pos.z - fwdZ * 2.85,
          -fwdX * (2.2 + this.boostFx),
          0.25,
          -fwdZ * (2.2 + this.boostFx),
          PALETTE.boost,
          0.15 * pulse,
          0.32,
        );
      }
      if (this.flightFx > 0.3) {
        for (const side of [-1, 1]) {
          const swirl = t * 15 + this.id * 1.7 + (side < 0 ? Math.PI : 0);
          const radial = 0.22 + this.flightFx * 0.18;
          const swirlX = Math.cos(swirl) * radial;
          const swirlZ = Math.sin(swirl) * radial;
          this.trail.emit(
            pos.x + portX * (side * 0.68 + swirlX) - fwdX * (1.62 + swirlZ),
            pos.y - 0.18,
            pos.z + portZ * (side * 0.68 + swirlX) - fwdZ * (1.62 + swirlZ),
            -fwdX * (0.22 + swirlZ) + portX * (side * 0.1 - Math.sin(swirl) * 0.7),
            -0.72 - this.flightFx * 0.38,
            -fwdZ * (0.22 + swirlZ) + portZ * (side * 0.1 - Math.sin(swirl) * 0.7),
            Math.floor(t * 18 + side) % 4 === 0 ? 0x9b7cff : PALETTE.flight,
            0.085 * pulse,
            0.3,
          );
        }
      }
    }
  }

  private setThrustInstance(
    layer: 'shell' | 'outer' | 'core',
    index: number,
    x: number,
    y: number,
    z: number,
    quaternion: THREE.Quaternion,
    radius: number,
    length: number,
  ): void {
    const mesh = layer === 'shell' ? this.thrustShell : layer === 'core' ? this.thrustCore : this.thrustOuter;
    const visible = radius > 0.001 && length > 0.001;
    _fxPos.set(x, y, z);
    _fxScale.set(visible ? radius : 0, visible ? length : 0, visible ? radius : 0);
    _fxMatrix.compose(_fxPos, quaternion, _fxScale);
    mesh.setMatrixAt(index, _fxMatrix);
  }

  private setFlowRingInstance(
    index: number,
    x: number,
    y: number,
    z: number,
    quaternion: THREE.Quaternion,
    radius: number,
    stretchX: number,
    stretchY: number,
  ): void {
    const visible = radius > 0.001;
    _fxPos.set(x, y, z);
    _fxScale.set(visible ? radius * stretchX : 0, visible ? radius * stretchY : 0, visible ? radius : 0);
    _fxMatrix.compose(_fxPos, quaternion, _fxScale);
    this.thrustRings.setMatrixAt(index, _fxMatrix);
  }

  private updateWingAndRotorVisual(
    dt: number,
    t: number,
    flightActive: boolean,
    vF: number,
    steer: number,
  ): void {
    const st = this.state;
    // Wing unfold / fold transition
    const wingDeployTarget = flightActive ? 1.0 : (st.airborne ? 0.25 : 0.0);
    const wingRate = wingDeployTarget > this.wingDeploy ? 4.8 : 3.2;
    this.wingDeploy += (wingDeployTarget - this.wingDeploy) * (1 - Math.exp(-wingRate * dt));

    // Rotor RPM spool (counter-rotating wooden blades)
    const speedAbs = Math.abs(vF);
    const targetRotorSpeed = flightActive
      ? 38.0 + clamp((speedAbs - TUNING.topSpeed) / 12, 0, 1) * 16.0
      : (speedAbs > 2.0 ? 2.5 + (speedAbs / TUNING.topSpeed) * 4.5 : 0.8);
    const rotorAccel = flightActive ? 9.5 : 4.0;
    this.rotorSpeed += (targetRotorSpeed - this.rotorSpeed) * (1 - Math.exp(-rotorAccel * dt));
    this.rotorAngle = (this.rotorAngle + this.rotorSpeed * dt) % (Math.PI * 2);

    // Dynamic wing angles with aerodynamic loading flex
    const deploy = this.wingDeploy;
    const steerTrim = flightActive ? steer * 0.12 : 0;
    // Thermal updraft: intensified high-freq flutter simulating convective turbulence
    const thermalFlutter = this.thermalUpdraft * Math.sin(t * 28 + this.id * 2.3) * 0.035;
    const flutter = flightActive ? Math.sin(t * 16 + this.id * 1.5) * 0.015 + thermalFlutter : 0;
    // Wood airframe stress & high-speed dive shudder (老柚木机翼高速俯冲与受力微震颤)
    const diveShudder = (this.aeroPitch < -0.15 ? (-this.aeroPitch - 0.15) * 0.05 : 0) * (speedAbs > 12 ? Math.min(1.4, speedAbs / 24) : 0);
    const gShudder = Math.abs(this.lateralG) > 6 ? (Math.abs(this.lateralG) - 6) * 0.0035 : 0;
    const woodShudder = flightActive ? Math.sin(t * 36.0 + this.id * 1.7) * (diveShudder + gShudder) : 0;
    // Wind tunnel: forward sweep flex as high-speed aerodynamic loading compresses wing
    const tunnelSweep = this.windTunnelBoost * 0.06;
    const aeroFlex = flightActive ? clamp((speedAbs - TUNING.topSpeed) / 20, -0.05, 0.08) + tunnelSweep : 0;
    const pitchTrim = flightActive ? this.aeroPitch * 0.25 : 0;

    // Port wing (left, +X): folded swept back -1.45 rad, deployed wide +0.04 rad
    const portYaw = -1.45 * (1 - deploy) + (0.04 - aeroFlex * 0.5) * deploy;
    const portRoll = -0.12 * (1 - deploy) + (0.08 + flutter + woodShudder - steerTrim + aeroFlex) * deploy;
    const portPitch = -0.04 * (1 - deploy) + (0.02 + flutter * 0.5 + pitchTrim + woodShudder * 0.3) * deploy;
    this.portWing.rotation.set(portPitch, portYaw, portRoll, 'YXZ');

    // Starboard wing (right, -X): folded swept back +1.45 rad, deployed wide -0.04 rad
    const stbdYaw = 1.45 * (1 - deploy) - (0.04 - aeroFlex * 0.5) * deploy;
    const stbdRoll = 0.12 * (1 - deploy) - (0.08 + flutter + woodShudder + steerTrim + aeroFlex) * deploy;
    const stbdPitch = -0.04 * (1 - deploy) + (0.02 + flutter * 0.5 + pitchTrim + woodShudder * 0.3) * deploy;
    this.stbdWing.rotation.set(stbdPitch, stbdYaw, stbdRoll, 'YXZ');

    // Rotor pylon mast tilt & rotor blade spin
    const pylonTilt = -0.42 * (1 - deploy);
    this.portRotorPylon.rotation.x = pylonTilt;
    this.stbdRotorPylon.rotation.x = pylonTilt;

    this.portRotorBlades.rotation.y = this.rotorAngle;
    this.stbdRotorBlades.rotation.y = -this.rotorAngle;

    // Pilot-specific auxiliary animations
    if (this.visualAssembly.extra?.pinwheels) {
      for (const pw of this.visualAssembly.extra.pinwheels) {
        pw.rotation.z = (pw.rotation.z + this.rotorSpeed * 2.2 * dt) % (Math.PI * 2);
      }
    }
    if (this.visualAssembly.extra?.baguaRing) {
      this.visualAssembly.extra.baguaRing.rotation.y = (this.visualAssembly.extra.baguaRing.rotation.y + (flightActive ? 1.8 : 0.45) * dt) % (Math.PI * 2);
      this.visualAssembly.extra.baguaRing.rotation.z = Math.sin(t * 1.5) * 0.08;
    }
    if (this.visualAssembly.extra?.canards) {
      for (const canard of this.visualAssembly.extra.canards) {
        canard.rotation.x = this.aeroPitch * 0.45 - (flightActive ? steer * 0.12 : 0);
      }
    }
    if (this.visualAssembly.extra?.nozzles) {
      const scaleN = 1 + (this.boostFx * 0.22 + this.flightFx * 0.14);
      for (const nz of this.visualAssembly.extra.nozzles) {
        nz.scale.set(scaleN, scaleN, 1 + this.boostFx * 0.35);
      }
    }
  }

  private rebuildVisual(color: number): void {
    // 1. Remove old visualRoot
    this.object.remove(this.visualRoot);
    this.visualRoot.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
      }
    });

    // 2. Build new visual assembly with current driver profile
    this.visualAssembly = buildBoatVisual(this.id, color, this.driverProfileId);
    this.visualRoot = this.visualAssembly.root;
    this.object.add(this.visualRoot);

    // 3. Update references
    this.hullMaterial = this.visualAssembly.hullMaterial;
    this.portWing = this.visualAssembly.portWing;
    this.stbdWing = this.visualAssembly.stbdWing;
    this.portRotorPylon = this.visualAssembly.portRotorPylon;
    this.stbdRotorPylon = this.visualAssembly.stbdRotorPylon;
    this.portRotorBlades = this.visualAssembly.portRotorBlades;
    this.stbdRotorBlades = this.visualAssembly.stbdRotorBlades;

    // 4. Re-apply initial pose
    this.portWing.rotation.set(-0.04, -1.45, -0.12, 'YXZ');
    this.stbdWing.rotation.set(-0.04, 1.45, 0.12, 'YXZ');
    this.portRotorPylon.rotation.x = -0.42;
    this.stbdRotorPylon.rotation.x = -0.42;

    if (this.detailedInk) {
      addOutline(this.visualRoot);
      markInk(this.visualRoot);
    }
  }

  beginFlightRouteAttempt(routeIndex: number, routeCursor: number, targetSpeed: number): void {
    const st = this.state;
    if (st.flightRouteState !== 'idle' || routeCursor !== st.flightRouteCursor || routeIndex < 0) return;
    if (st.flightPhase === 'surface') {
      this.flightElapsed = 0;
      this.flightExtensionTime = 0;
      st.flightExtensionUsed = false;
      st.flightPhase = 'spool';
    }
    st.flightRouteState = 'active';
    st.flightRouteIndex = routeIndex;
    this.flightTargetSpeed = clamp(targetSpeed, TUNING.topSpeed, TUNING.flightHardCap);
    st.flightRouteFailReason = 'none';
    st.flightFailure = null;
    st.flightGateProgress = 0;
    this.flightPenaltyApplied = false;
  }

  applyFlightGatePass(gateIndex: number): void {
    const st = this.state;
    if (st.flightRouteState !== 'active' || gateIndex !== st.flightGateProgress) return;
    st.flightGateProgress = gateIndex + 1;
  }

  completeFlightRoute(routeIndex: number, routeCursor: number): void {
    const st = this.state;
    if (st.flightRouteState !== 'active' || st.flightRouteIndex !== routeIndex || routeCursor !== st.flightRouteCursor) return;
    st.flightRouteState = 'passed';
    st.flightsCleared++;
    st.flightRouteCursor++;
    // A clean third gate is the authored end of the maneuver. Start the same
    // smooth landing envelope immediately instead of leaving a fast racer
    // hovering for the unused portion of the ten-second safety window.
    const descendAt = this.flightDescendAt();
    this.flightElapsed = Math.max(this.flightElapsed, descendAt);
    st.flightExtensionReady = false;
  }

  settleFlightRoute(): void {
    const st = this.state;
    if (st.flightRouteState !== 'passed' || st.flightPhase !== 'surface') return;
    st.flightRouteState = 'idle';
    st.flightRouteIndex = -1;
    st.flightRouteFailReason = 'none';
    st.flightFailure = null;
    st.flightGateProgress = 0;
  }

  recoverFailedFlightRoute(): void {
    const st = this.state;
    if (st.flightRouteState !== 'failed' || st.flightPhase !== 'surface') return;
    st.flightRouteCursor++;
    st.flightRouteState = 'idle';
    st.flightRouteIndex = -1;
    st.flightRouteFailReason = 'none';
    st.flightFailure = null;
    st.flightGateProgress = 0;
    this.flightPenaltyApplied = false;
  }

  /** Capture one stable miss; AI boats retain the physical slowdown while the player terminates. */
  applyFlightRouteMiss(failure: FlightFailureSnapshot): void {
    const st = this.state;
    if (st.flightRouteState !== 'active' || this.flightPenaltyApplied) return;
    this.flightPenaltyApplied = true;
    this.flightMissFxTimer = 0.4;
    this.velX *= TUNING.flightMissSpeedMul;
    this.velZ *= TUNING.flightMissSpeedMul;
    st.flightPenaltyRemaining = TUNING.flightMissDriveTime;
    st.flightRouteState = 'failed';
    st.flightRouteIndex = failure.routeSlot;
    st.flightRouteFailReason = failure.reason;
    st.flightFailure = failure;
    if (st.flightPhase !== 'surface') {
      const descentAt = this.flightDescendAt();
      this.flightElapsed = Math.max(this.flightElapsed, descentAt);
    }
    st.flightExtensionReady = false;
    st.flightRouteMiss = true;
  }

  setDriver(color: number, handling: DriverHandling, profileId?: string): void {
    this.handling = {
      acceleration: clamp(handling.acceleration, 0.94, 1.06),
      steering: clamp(handling.steering, 0.94, 1.06),
      driftCharge: clamp(handling.driftCharge, 0.94, 1.06),
      airControl: clamp(handling.airControl, 0.94, 1.06),
    };
    const nextProfile = profileId || this.driverProfileId;
    if (nextProfile !== this.driverProfileId) {
      this.driverProfileId = nextProfile;
      this.rebuildVisual(color);
    } else {
      this.hullMaterial.uniforms.uColor.value.setHex(color, THREE.NoColorSpace);
    }
  }

  /** Main-thread visual LOD; has no effect on physics or AI input. */
  setOpponentEffectDistance(distance: number): void {
    this.opponentFxScale = this.id === 0 ? 1 : clamp(1 - (distance - 24) / 150, 0.3, 1);
  }

  /** Deterministic harness evidence for AI technique visibility. */
  debugDriftEffects(): { emissions: number; scale: number } {
    return { emissions: this.driftFxEmissions, scale: this.opponentFxScale };
  }

  /** Deterministic evidence that the selection radar matches live physics. */
  debugDriverHandling(): DriverHandling {
    return { ...this.handling };
  }

  debugFlightEffects(): { rings: number; plumeLength: number; deflection: number } {
    return {
      rings: this.flightRingActiveCount,
      plumeLength: this.flightPlumeLength,
      deflection: this.flightFlowDeflection,
    };
  }

  debugGroundEffect(): { groundEffect: number; resonance: number; resonanceCharge: number } {
    return {
      groundEffect: this.groundEffect,
      resonance: this.groundResonance,
      resonanceCharge: this.groundResonanceCharge,
    };
  }

  debugThermalAndTunnel(): { thermalUpdraft: number; windTunnelBoost: number } {
    return {
      thermalUpdraft: this.thermalUpdraft,
      windTunnelBoost: this.windTunnelBoost,
    };
  }

  setCourse(course: ICourse): void {
    this.course = course;
  }

  /** Deterministic tuning evidence for the release harness. */
  debugFlightEnvelope(): {
    descendAt: number;
    total: number;
    extension: number;
    extendedDescendAt: number;
    extendedTotal: number;
  } {
    const descendAt = TUNING.flightSpool + TUNING.flightAscend + TUNING.flightCruise;
    return {
      descendAt,
      total: descendAt + TUNING.flightDescend,
      extension: TUNING.flightExtension,
      extendedDescendAt: descendAt + TUNING.flightExtension,
      extendedTotal: descendAt + TUNING.flightExtension + TUNING.flightDescend,
    };
  }

  private flightDescendAt(): number {
    return TUNING.flightSpool + TUNING.flightAscend + TUNING.flightCruise + this.flightExtensionTime;
  }

  private canExtendFlight(): boolean {
    const st = this.state;
    return st.flightCharges > 0 &&
      !st.flightExtensionUsed &&
      (st.flightPhase === 'cruise' || st.flightPhase === 'descending') &&
      st.flightRouteState !== 'passed' &&
      st.flightRouteState !== 'failed';
  }

  collisionVelocity(out: THREE.Vector2): THREE.Vector2 {
    return out.set(this.velX, this.velZ);
  }

  applyCollisionResponse(correctionX: number, correctionZ: number, impulseX: number, impulseZ: number): void {
    const correctionLength = Math.hypot(correctionX, correctionZ);
    if (correctionLength > 0.4) {
      const scale = 0.4 / correctionLength;
      correctionX *= scale;
      correctionZ *= scale;
    }
    this.object.position.x += correctionX;
    this.object.position.z += correctionZ;
    this.velX += impulseX;
    this.velZ += impulseZ;
    const speed = Math.hypot(this.velX, this.velZ);
    if (speed > TUNING.flightHardCap) {
      const scale = TUNING.flightHardCap / speed;
      this.velX *= scale;
      this.velZ *= scale;
    }
    this.yawRate = clamp(this.yawRate + (impulseX * Math.cos(this.heading) - impulseZ * Math.sin(this.heading)) * 0.018, -2.4, 2.4);
  }

  /** Deterministic collision-harness hook. Gameplay never calls this method. */
  setCollisionTestMotion(x: number, z: number, heading: number, velX: number, velZ: number, y = 0): void {
    this.object.position.set(x, y, z);
    this.heading = heading;
    this.velX = velX;
    this.velZ = velZ;
    this.state.heading = heading;
    this.state.speed = velX * Math.sin(heading) + velZ * Math.cos(heading);
    _euler.set(0, heading, 0, 'YXZ');
    this.object.quaternion.setFromEuler(_euler);
  }

  private updateFlight(
    dt: number,
    surfaceY: number,
    surfaceTargetY: number,
    thr: number,
    vF: number,
    input: BoatInput,
    surfaceReturnBrake: boolean,
  ): number {
    const st = this.state;
    const ascendAt = TUNING.flightSpool;
    const cruiseAt = ascendAt + TUNING.flightAscend;
    const descendAt = this.flightDescendAt();
    const total = descendAt + TUNING.flightDescend;

    const firstFlightFrame = this.flightElapsed === 0;
    if (firstFlightFrame) {
      this.flightStartClearance = this.object.position.y - surfaceY;
      this.flightTargetVy = 0;
      this.aeroPitch = 0;
    }
    this.flightElapsed += dt;

    let phase: FlightPhase;
    let targetClearance: number;
    let thrust: number;
    if (this.flightElapsed < ascendAt) {
      phase = 'spool';
      const p = clamp(this.flightElapsed / TUNING.flightSpool, 0, 1);
      targetClearance = this.flightStartClearance;
      thrust = p;
    } else if (this.flightElapsed < cruiseAt) {
      phase = 'ascending';
      const p = smooth01((this.flightElapsed - ascendAt) / TUNING.flightAscend);
      targetClearance = this.flightStartClearance + (TUNING.flightClearance - this.flightStartClearance) * p;
      thrust = 1;
    } else if (this.flightElapsed < descendAt) {
      phase = 'cruise';
      targetClearance = TUNING.flightClearance;
      thrust = 0.72;
    } else {
      phase = 'descending';
      const p = smooth01((this.flightElapsed - descendAt) / TUNING.flightDescend);
      const landingTarget = -TUNING.draft - TUNING.flightLandingLead;
      targetClearance = TUNING.flightClearance + (landingTarget - TUNING.flightClearance) * p;
      thrust = 0.72 * (1 - p);
    }

    // Pilot pitch control & AoA aerodynamics
    // Cruising trims to streamlined neutral glide trim (-0.035 rad, ~-2 deg nose down)
    // Air brake engagement flares nose up (+0.14 rad) for vector braking and aerodynamic deceleration
    let targetPitch = phase === 'descending'
      ? -0.06 + this.airBrakeFx * 0.12
      : TUNING.neutralPitchTrim + this.airBrakeFx * 0.16;

    // Ground effect proximity factor (Task 8.2 & Task 12.2: 翼地效应 1~3米浮力与气垫增益)
    const clearance = this.object.position.y - surfaceY;
    let groundSigma = 0;
    if (clearance >= TUNING.groundEffectMinAlt && clearance <= TUNING.groundEffectMaxAlt) {
      if (clearance >= TUNING.groundEffectPeakAltHi) {
        const t = (TUNING.groundEffectMaxAlt - clearance) / (TUNING.groundEffectMaxAlt - TUNING.groundEffectPeakAltHi);
        groundSigma = t * t * (3 - 2 * t);
      } else if (clearance >= TUNING.groundEffectPeakAltLo) {
        groundSigma = 1.0;
      } else {
        const t = (clearance - TUNING.groundEffectMinAlt) / (TUNING.groundEffectPeakAltLo - TUNING.groundEffectMinAlt);
        groundSigma = t * t * (3 - 2 * t);
      }
    }
    this.groundEffect = groundSigma;
    st.groundEffect = groundSigma;

    // Ground Auto-Level protection (防倒栽葱砸水：接近水面/地面 Y < 3m 时平缓拉平机头)
    if (clearance < TUNING.groundAutoLevelAlt) {
      const groundProximity = clamp((TUNING.groundAutoLevelAlt - clearance) / 2.5, 0, 1);
      const autoLevelWeight = smooth01(groundProximity);
      const flarePitch = TUNING.groundAutoLevelFlare + this.airBrakeFx * 0.14;
      if (targetPitch < flarePitch || this.vy < 0) {
        targetPitch = targetPitch * (1 - autoLevelWeight) + flarePitch * autoLevelWeight;
      }
      const pitchRate = TUNING.pitchControlRate + autoLevelWeight * 6.0;
      this.aeroPitch += (targetPitch - this.aeroPitch) * (1 - Math.exp(-pitchRate * dt));
    } else {
      this.aeroPitch += (targetPitch - this.aeroPitch) * (1 - Math.exp(-TUNING.pitchControlRate * dt));
    }

    const totalAirSpeed = Math.hypot(vF, this.vy);
    const safeAirSpeed = Math.max(2.0, totalAirSpeed);
    const gamma = Math.atan2(this.vy, Math.max(1.0, vF)); // Flight path trajectory angle
    const cosG = Math.cos(gamma);
    const sinG = Math.sin(gamma);
    const alpha = this.aeroPitch - gamma; // Angle of attack (迎角)

    // Lift coefficient (cambered airfoil + linear slope + smooth post-stall dropoff + ground effect cushion)
    let cL: number;
    const absAlpha = Math.abs(alpha);
    if (absAlpha <= TUNING.stallAngle) {
      cL = TUNING.liftCoeff0 + TUNING.liftSlope * alpha;
    } else {
      const peakCl = TUNING.liftCoeff0 + TUNING.liftSlope * Math.sign(alpha) * TUNING.stallAngle;
      const stallFade = Math.exp(-7.0 * (absAlpha - TUNING.stallAngle));
      cL = peakCl * (TUNING.stallLiftDrop + (1 - TUNING.stallLiftDrop) * stallFade);
    }
    cL *= (1.0 + TUNING.groundEffectLiftMul * groundSigma);

    // Drag coefficient (parasitic + induced + air-brake + separation drag, with ground effect + wind tunnel vortex suppression)
    const cDi = TUNING.inducedDragK * cL * cL;
    const cDiGround = cDi * (1.0 - TUNING.groundEffectDragCut * groundSigma)
      * (1.0 - TUNING.windTunnelDragCut * this.windTunnelBoost);
    const cDBrake = TUNING.airBrakeDragCoeff * this.airBrakeFx;
    const cDStall = absAlpha > TUNING.stallAngle
      ? 0.18 * (1 - Math.exp(-5.0 * (absAlpha - TUNING.stallAngle)))
      : 0;
    const cD = TUNING.dragCoeff0 + cDiGround + cDBrake + cDStall;

    // Aerodynamic forces per unit mass: Qm = 0.5 * rho * V^2 * (S / m)
    const qm = 0.5 * TUNING.airDensity * safeAirSpeed * safeAirSpeed * (TUNING.wingArea / TUNING.gliderMass);
    const aLift = qm * cL;
    const aDrag = qm * cD;

    // Forward longitudinal acceleration from aerodynamics + propulsion + ground effect speed efficiency
    const cruiseTarget = phase === 'descending'
      ? TUNING.flightDescentSpeed
      : this.flightTargetSpeed;
    const speedTarget = cruiseTarget + (TUNING.airBrakeTargetSpeed - cruiseTarget) * this.airBrakeFx;
    const speedError = speedTarget - vF;
    const propThrustF = clamp(speedError * 2.2, -14, 18) * this.handling.acceleration;
    // Aerodynamic gravity conversion & ground-effect forward acceleration
    const aFGe = 3.6 * groundSigma * clamp(vF / 25, 0.4, 1.25);
    const aF = -aDrag * cosG - aLift * sinG + propThrustF + aFGe;

    // Proximity resonance charging (贴海掠行充能)
    const speedAbs = Math.abs(vF);
    let resonance = 0;
    if (groundSigma > 0.15 && speedAbs > TUNING.groundResonanceSpeedMin && phase !== 'descending') {
      resonance = groundSigma * clamp((speedAbs - 18) / 16, 0.0, 1.0);
    }
    this.groundResonance = resonance;
    st.groundResonance = resonance;

    if (resonance > 0.15) {
      this.groundResonanceCharge = Math.min(1.0, this.groundResonanceCharge + dt * resonance * TUNING.groundResonanceRate);
      if (this.groundResonanceCharge >= 1.0) {
        if (st.flightCharges < 2) {
          st.flightCharges++;
          this.liftBurstTimer = 0.24;
        }
        this.groundResonanceCharge = 0;
      }
      if (st.boostCharge < 1.0) {
        st.boostCharge = Math.min(1.0, st.boostCharge + dt * resonance * 0.35);
      }
    } else if (resonance <= 0.05) {
      this.groundResonanceCharge = Math.max(0, this.groundResonanceCharge - dt * 0.4);
    }
    st.groundResonanceCharge = this.groundResonanceCharge;

    // Thermal updraft vertical lift & flight duration preservation (Task 8.3)
    const pos = this.object.position;
    const thermalSample = this.course?.sampleThermalUpdraft(pos);
    if (thermalSample && thermalSample.intensity > 0.01) {
      this.thermalUpdraft += (thermalSample.intensity - this.thermalUpdraft) * (1 - Math.exp(-12 * dt));
      // Vertical lift: pull vy toward thermal liftSpeed
      this.vy += this.thermalUpdraft * Math.max(0, thermalSample.liftSpeed - this.vy) * TUNING.thermalCouplingK * dt;
      // Preserve flight duration inside thermals (slow elapsed timer)
      if (phase !== 'descending') {
        this.flightElapsed -= dt * this.thermalUpdraft * TUNING.thermalExtendRate;
        this.flightElapsed = Math.max(0, this.flightElapsed);
      }
    } else {
      this.thermalUpdraft = Math.max(0, this.thermalUpdraft - dt * 3.5);
    }
    st.thermalUpdraft = this.thermalUpdraft;

    // Wind tunnel slingshot boost & induced drag reduction (Task 8.3)
    const tunnelSample = this.course?.sampleWindTunnel(pos, this.prevPosForTunnel);
    if (tunnelSample) {
      this.windTunnelBoost += (tunnelSample.inside - this.windTunnelBoost) * (1 - Math.exp(-8 * dt));
      if (tunnelSample.ringPassed) {
        // Slingshot forward velocity boost on ring crossing
        const boostTarget = vF * TUNING.windTunnelBoostMul;
        vF += clamp(boostTarget - vF, 0, 18) * 0.55;
        this.liftBurstTimer = Math.max(this.liftBurstTimer, 0.18);
      }
    } else {
      this.windTunnelBoost = Math.max(0, this.windTunnelBoost - dt * 2.8);
    }
    st.windTunnelBoost = this.windTunnelBoost;

    // Vertical tracking with wave feedforward + aerodynamic pitch authority + air cushion
    const desiredY = surfaceY + targetClearance;
    if (firstFlightFrame) this.flightDesiredYPrev = desiredY;
    const rawTargetVy = clamp((desiredY - this.flightDesiredYPrev) / Math.max(1e-4, dt), -14, 14);
    this.flightTargetVy += (rawTargetVy - this.flightTargetVy) * (1 - Math.exp(-18 * dt));
    this.flightDesiredYPrev = desiredY;

    const w = TUNING.flightOmega;
    const aY = clamp(
      w * w * (desiredY - this.object.position.y) + 2 * w * (this.flightTargetVy - this.vy),
      -TUNING.flightAccelMax,
      TUNING.flightAccelMax,
    );

    // Integrate velocities
    vF += aF * dt;
    this.vy += aY * dt;
    // Ground Air Cushion protection: when descending near surface (clearance < 3m & vy < 0)
    if (this.vy < 0 && clearance < TUNING.groundAutoLevelAlt) {
      const cushionIntensity = smooth01(clamp((TUNING.groundAutoLevelAlt - clearance) / 2.75, 0, 1));
      const sinkSpeed = Math.max(0, -this.vy);
      const dynamicLiftBoost = qm * 0.42 * cushionIntensity;
      const sinkDamping = sinkSpeed * TUNING.groundCushionSinkDamp * cushionIntensity;
      const aCushion = (TUNING.groundEffectCushionK * cushionIntensity + dynamicLiftBoost + sinkDamping) * Math.max(0.2, groundSigma);
      this.vy += aCushion * dt;
    }
    vF = clamp(vF, -TUNING.reverseSpeed, TUNING.diveSpeedCap);
    this.vy = clamp(this.vy, -22, 18);

    this.object.position.y += this.vy * dt;
    st.flightPhase = phase;
    st.flightRemaining = clamp(1 - this.flightElapsed / total, 0, 1);
    st.flightThrust = thrust;
    st.airborne = false;
    st.airTime = 0;

    const landingTimedOut = this.flightElapsed >= total + 0.3;
    const touchingWater = this.object.position.y <= surfaceTargetY + 0.25;
    if ((this.flightElapsed >= total && (touchingWater || landingTimedOut)) ||
        (phase === 'descending' && this.object.position.y <= surfaceTargetY + 0.1)) {
      this.object.position.y = surfaceTargetY;
      const landingImpact = Math.max(0, -this.vy);
      this.vy = 0;
      this.unloadTime = 0;
      this.flightElapsed = 0;
      this.flightExtensionTime = 0;
      this.flightTargetVy = 0;
      this.aeroPitch = 0;
      st.flightPhase = 'surface';
      st.flightRemaining = 0;
      st.flightExtensionReady = false;
      st.flightExtensionUsed = false;
      st.flightThrust = 0;
      st.landImpulse = Math.max(st.landImpulse, landingImpact);

      // Air-brake to Drift Landing Handoff (空中刹车落地无缝切入切水漂移)
      const brakingIntoLand = input.airBrake || this.airBrakeFx > 0.08 || input.drift;
      if (brakingIntoLand && !surfaceReturnBrake) {
        this.wasDrifting = true;
        st.drifting = true;
        if (Math.abs(vF) > TUNING.driftMinSpeed) {
          st.boostCharge = Math.min(1, st.boostCharge + dt * this.handling.driftCharge / TUNING.driftChargeTime);
        }
        const fwdX = Math.sin(this.heading);
        const fwdZ = Math.cos(this.heading);
        const portX = fwdZ;
        const portZ = -fwdX;
        const W = TUNING.sampleLat;
        _v1.set(this.object.position.x - fwdX * 2.1, surfaceY + 0.06, this.object.position.z - fwdZ * 2.1);
        this.spray.burst(_v1, this.id === 0 ? 16 : 8, 4.2 + Math.abs(vF) * 0.15);
        _v2.set(this.object.position.x + portX * (W + 0.15) - fwdX * 0.8, surfaceY + 0.06, this.object.position.z + portZ * (W + 0.15) - fwdZ * 0.8);
        _v3.set(this.object.position.x - portX * (W + 0.15) - fwdX * 0.8, surfaceY + 0.06, this.object.position.z - portZ * (W + 0.15) - fwdZ * 0.8);
        this.spray.burst(_v2, this.id === 0 ? 8 : 4, 3.2 + Math.abs(vF) * 0.1);
        this.spray.burst(_v3, this.id === 0 ? 8 : 4, 3.2 + Math.abs(vF) * 0.1);
      }
    }

    return vF;
  }

  teleport(x: number, z: number, heading: number): void {
    this.heading = heading;
    this.yawRate = 0;
    this.velX = 0;
    this.velZ = 0;
    this.vy = 0;
    this.unloadTime = 0;
    this.pitch = 0;
    this.pitchVel = 0;
    this.aeroPitch = 0;
    this.roll = 0;
    this.rollVel = 0;
    this.boostTimer = 0;
    this.boostTotal = 0;
    this.wasDrifting = false;
    this.flightElapsed = 0;
    this.flightExtensionTime = 0;
    this.flightStartClearance = 0;
    this.flightDesiredYPrev = 0;
    this.flightTargetVy = 0;
    this.flightPenaltyApplied = false;
    this.groundEffect = 0;
    this.groundResonance = 0;
    this.groundResonanceCharge = 0;
    this.groundTrailCd = 0;
    this.prevSpeed = 0;
    this.lateralG = 0;
    this.turnSprayCd = 0;
    this.boostSprayCd = 0;
    this.trailCd = 0;
    this.driftTrailCd = 0;
    this.opponentDriftSprayCd = 0;
    this.driftFxEmissions = 0;
    this.boostFx = 0;
    this.flightFx = 0;
    this.liftBurstTimer = 0;
    this.liftSplashPending = false;
    this.flightMissFxTimer = 0;
    this.airBrakeFx = 0;
    this.flightTargetSpeed = 42;
    this.flightRingActiveCount = 0;
    this.flightPlumeLength = 0;
    this.flightFlowDeflection = 0;
    this.thermalUpdraft = 0;
    this.windTunnelBoost = 0;
    this.groundEffect = 0;
    this.groundResonance = 0;
    this.groundResonanceCharge = 0;
    this.wingDeploy = 0;
    this.rotorAngle = 0;
    this.rotorSpeed = 0;
    this.portWing.rotation.set(-0.04, -1.45, -0.12, 'YXZ');
    this.stbdWing.rotation.set(-0.04, 1.45, 0.12, 'YXZ');
    this.portRotorPylon.rotation.x = -0.42;
    this.stbdRotorPylon.rotation.x = -0.42;
    this.portRotorBlades.rotation.y = 0;
    this.stbdRotorBlades.rotation.y = 0;

    const st = this.state;
    st.boostCharge = 0;
    st.driftBankProgress = 0;
    st.driftReleaseReady = false;
    st.boostRemaining = 0;
    st.flightCharges = this.id === 0 ? 2 : 1;
    st.flightPhase = 'surface';
    st.flightRemaining = 0;
    st.flightExtensionReady = false;
    st.flightExtensionUsed = false;
    st.flightExtended = false;
    st.flightClearance = -TUNING.draft;
    st.flightThrust = 0;
    st.flightAirBrake = 0;
    st.flightsCleared = 0;
    st.flightRouteCursor = 0;
    st.flightRouteIndex = -1;
    st.flightPressure = 0;
    st.flightDenied = false;
    st.flightRouteMiss = false;
    st.flightRouteState = 'idle';
    st.flightRouteFailReason = 'none';
    st.flightFailure = null;
    st.flightGateProgress = 0;
    st.flightPenaltyRemaining = 0;
    st.groundEffect = 0;
    st.groundResonance = 0;
    st.groundResonanceCharge = 0;
    st.thermalUpdraft = 0;
    st.windTunnelBoost = 0;
    st.airborne = false;
    st.airTime = 0;
    st.landImpulse = 0;
    st.speed = 0;
    st.rpm = 0;
    st.throttle = 0;
    st.steer = 0;
    st.drifting = false;
    st.boosting = false;
    st.lateralG = 0;
    st.longG = 0;
    st.heading = heading;

    this.object.position.set(x, waterHeight(x, z, this.lastT) - TUNING.draft, z);
    _euler.set(0, heading, 0, 'YXZ');
    this.object.quaternion.setFromEuler(_euler);
  }
}
