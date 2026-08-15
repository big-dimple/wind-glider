/**
 * rider.ts — procedural cel-shaded rider with a code-driven forward-kinematic rig.
 *
 * One `Rider` is parented to `boat.riderMount` (+Z = boat forward, +Y = up).
 * The character is built from primitives only (no external assets), posed in a
 * permanent riding crouch, and animated purely from `BoatState` each frame:
 *
 *   - lean into turns ∝ lateralG (head counter-lean, inside-knee flare)
 *   - weight shift ∝ longG (pitch back on accel, hunch on braking)
 *   - drift hip twist, throttle wrist, rpm vibration
 *   - airborne "whee" pose, springy landing crouch on landImpulse
 *   - idle breathing + secondary motion lagging the boat's pitch/roll
 *   - celebration loop (arm pumps, head nod) blended in over ~0.4s
 *
 * All animation state lives in a handful of scalar damped springs; update()
 * applies DELTA rotations on top of the baked rest pose. Zero per-frame
 * allocation; stable at fixed dt = 1/60.
 */
import * as THREE from 'three';
import { markInk, type BoatState } from '../contracts';
import { PALETTE } from '../core/palette';
import { createToonMaterial } from '../cel/toonMaterial';
import { addOutline } from '../cel/outline';

// ------------------------------------------------------------- tuning ----
// Every number a polish pass might want to touch lives here. Angles in
// radians, frequencies in Hz, spring omegas in rad/s (zeta: 1 = critical).
const TUNING = {
  // Lean into turns: 28° max, reached at ~1g lateral.
  leanMax: 0.49,          // ~28°
  leanGRef: 9.8,          // lateralG that maps to full lean
  leanSign: -1,           // flip if lean goes the wrong way on screen
  leanOmega: 8, leanZeta: 0.95,
  leanHips: 0.45, leanSpine: 0.55, leanChest: 0.15, // distribution up the chain
  headCounter: 0.35,      // head counter-lean fraction
  kneeFlare: 0.55,        // inside knee opens this much at full lean
  elbowDrop: 0.4,         // outside elbow drops this much at full lean

  // Weight shift from longG: pitch back on hard accel, hunch on braking.
  pitchPerG: 0.032, pitchMax: 0.22,
  pitchOmega: 6, pitchZeta: 1,

  // Drift: hips twist into the slide.
  driftTwist: 0.45, driftSign: 1,
  driftOmega: 8, driftZeta: 1,

  // Controls: throttle wrist twist + speed/rpm vibration on the arms.
  throttleWrist: 0.5,
  vibAmp: 0.014, vibF1: 47, vibF2: 31.3,

  // Airborne "whee" pose.
  airOmega: 6, airZeta: 1,
  airArmRise: 0.28, airElbowTuck: 0.2, airLegExtend: 0.22,
  airBodyOpen: 0.16, airHeadUp: 0.2,

  // Controlled anti-gravity flight: a compact, braced pose rather than the
  // natural-airborne "whee" animation used for wave jumps.
  flightOmega: 7, flightZeta: 1,
  flightHipsDrop: 0.08, flightHunch: 0.12,
  flightArmBrace: 0.08, flightKnee: 0.14,

  // Landing crouch: kicked by landImpulse (m/s), springy ~0.4s recovery.
  landKick: 0.05, landMax: 1.2,
  landOmega: 16, landZeta: 0.35,
  landHipsDrop: 0.16, landSpine: 0.45, landKnee: 0.6, landHip: 0.35,

  // Idle: breathing + secondary motion lagging boat pitch/roll.
  breathHz: 0.35, breathAmp: 0.03, breathBob: 0.008,
  followOmega: 3.5, followZeta: 1, followGain: 0.6, followMax: 0.12,
  lockSpeed: 12,          // m/s where idle bob is fully replaced by bracing
  braceShoulder: 0.08, braceElbow: 0.06,
  armTuck: 0.22,          // constant shoulder z-tuck: arms angle in to the grips

  // Celebration: ~0.4s blend in, loops while `celebrating`.
  celOmega: 7, celZeta: 1,
  pumpHz: 1.7, pumpAmp: 0.45, pumpRaise: -2.3,
  celLeftRaise: -1.6, celLeftLag: 1.1, // left hand rejoins late, returns each cycle
  celNodHz: 0.9, celNodAmp: 0.12,
  celUpright: 0.35,
} as const;

// Rest pose (baked into joint positions, meters). Standing racing crouch at
// the helm: hips back, knees bent into the footwells, torso hinged FORWARD
// (hunchSpine/hunchChest, applied in update()), arms reaching down-forward so
// the hands land on the grips (~±0.26, 0.37, 0.40 in mount space — the bar
// height). Rider's left = +X.
const POSE = {
  hips: [0, 0.58, -0.22],
  spine: [0, 0.13, 0.05],
  chest: [0, 0.19, 0.09],
  head: [0, 0.2, 0.1],
  shoulderL: [0.2, 0.1, 0.03],
  elbowL: [0.045, -0.129, 0.293],
  handL: [-0.02, -0.17, 0.345],
  hipL: [0.11, -0.03, 0.05],
  kneeL: [0.09, -0.2, 0.26],
  footL: [-0.05, -0.28, 0.1],
  hunchSpine: 0.42,       // baked forward hinge at the waist (rad, pitch down)
  hunchChest: 0.18,       // extra hinge at the chest — together ~34°
  headTiltUp: -0.72,      // baked head.rotation.x: un-hunches the neck, eyes up over the bow
} as const;

const UP = new THREE.Vector3(0, 1, 0);
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Scalar damped spring. Semi-implicit Euler — rock solid at dt = 1/60. */
class Spring {
  x = 0;
  v = 0;
  update(target: number, omega: number, zeta: number, dt: number): number {
    const a = omega * omega * (target - this.x) - 2 * zeta * omega * this.v;
    this.v += a * dt;
    this.x += this.v * dt;
    return this.x;
  }
}

interface Rig {
  hips: THREE.Object3D;
  spine: THREE.Object3D;
  chest: THREE.Object3D;
  head: THREE.Object3D;
  shoulderL: THREE.Object3D;
  shoulderR: THREE.Object3D;
  elbowL: THREE.Object3D;
  elbowR: THREE.Object3D;
  handL: THREE.Object3D;
  handR: THREE.Object3D;
  hipL: THREE.Object3D;
  hipR: THREE.Object3D;
  kneeL: THREE.Object3D;
  kneeR: THREE.Object3D;
  footL: THREE.Object3D;
  footR: THREE.Object3D;
}

export class Rider {
  readonly object: THREE.Object3D;

  private readonly j: Rig;
  private readonly hipsBaseY: number;
  private readonly suitMaterial: THREE.ShaderMaterial;
  private readonly accentMaterial: THREE.ShaderMaterial;

  // Animation state (scalar springs).
  private readonly leanS = new Spring();
  private readonly pitchS = new Spring();
  private readonly driftS = new Spring();
  private readonly airS = new Spring();
  private readonly flightS = new Spring();
  private readonly crouchS = new Spring();
  private readonly celS = new Spring();
  private readonly boatPitchS = new Spring();
  private readonly boatRollS = new Spring();

  // Scratch (no per-frame allocation).
  private readonly tmp = new THREE.Vector3();

  constructor(opts: { color: number; detailedInk?: boolean }) {
    // Rim turned up on every rider material: the silhouette must pop against
    // dark water even when the whole suit faces away from the sun. The suit
    // also carries a small self-color emissive so the racer color reads even
    // on the fully shadowed front (banding still steps on top of it).
    const suit = createToonMaterial({
      color: opts.color,
      rimStrength: 1.15,
      rimPower: 2.2,
      rimThreshold: 0.55,
      emissive: opts.color,
      emissiveIntensity: 0.14,
    });
    const ink = createToonMaterial({ color: PALETTE.ink, rimColor: PALETTE.foam, rimStrength: 0.7, rimThreshold: 0.55 });
    const white = createToonMaterial({ color: PALETTE.foam, specColor: PALETTE.sparkle, rimStrength: 0.9 });
    const accent = createToonMaterial({ color: opts.color, rimColor: PALETTE.sparkle, rimStrength: 0.9 });
    this.suitMaterial = suit;
    this.accentMaterial = accent;

    const root = new THREE.Group();
    root.name = 'rider';

    const joint = (parent: THREE.Object3D, name: string, p: readonly number[], mirror = 1): THREE.Object3D => {
      const o = new THREE.Object3D();
      o.name = name;
      o.position.set(p[0] * mirror, p[1], p[2]);
      parent.add(o);
      return o;
    };

    // Capsule limb from joint `a` to child joint `b`, in a's local space.
    // NOTE: radial segment count is deliberately high — coarse curved
    // primitives trip the Sobel normal-edge pass across their whole surface
    // (the ink multiply then crushes the limb to near-black). Smooth normals
    // keep the toon banding; only real creases should edge.
    const bone = (a: THREE.Object3D, b: THREE.Object3D, r: number, mat: THREE.Material): void => {
      const dir = b.position.clone();
      const len = dir.length();
      const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(0.02, len - r * 0.6), 4, 16), mat);
      m.position.copy(dir).multiplyScalar(0.5);
      m.quaternion.setFromUnitVectors(UP, dir.normalize());
      a.add(m);
    };
    const ball = (parent: THREE.Object3D, r: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 18, 14), mat);
      m.position.set(x, y, z);
      parent.add(m);
      return m;
    };
    const box = (parent: THREE.Object3D, w: number, h: number, d: number, mat: THREE.Material,
      x = 0, y = 0, z = 0, rx = 0): THREE.Mesh => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      m.rotation.x = rx;
      parent.add(m);
      return m;
    };

    // ------------------------------------------------------ skeleton ----
    const hips = joint(root, 'hips', POSE.hips);
    const spine = joint(hips, 'spine', POSE.spine);
    const chest = joint(spine, 'chest', POSE.chest);
    const head = joint(chest, 'head', POSE.head);
    head.rotation.x = POSE.headTiltUp;
    const shoulderL = joint(chest, 'shoulderL', POSE.shoulderL);
    const shoulderR = joint(chest, 'shoulderR', POSE.shoulderL, -1);
    const elbowL = joint(shoulderL, 'elbowL', POSE.elbowL);
    const elbowR = joint(shoulderR, 'elbowR', POSE.elbowL, -1);
    const handL = joint(elbowL, 'handL', POSE.handL);
    const handR = joint(elbowR, 'handR', POSE.handL, -1);
    const hipL = joint(hips, 'hipL', POSE.hipL);
    const hipR = joint(hips, 'hipR', POSE.hipL, -1);
    const kneeL = joint(hipL, 'kneeL', POSE.kneeL);
    const kneeR = joint(hipR, 'kneeR', POSE.kneeL, -1);
    const footL = joint(kneeL, 'footL', POSE.footL);
    const footR = joint(kneeR, 'footR', POSE.footL, -1);
    this.j = { hips, spine, chest, head, shoulderL, shoulderR, elbowL, elbowR, handL, handR, hipL, hipR, kneeL, kneeR, footL, footR };
    this.hipsBaseY = hips.position.y;

    // -------------------------------------------------------- flesh ----
    // At race distance, AI riders only need a readable color silhouette.
    // The full articulated mesh remains on the player and in High quality.
    if (opts.detailedInk === false) {
      const pelvis = ball(hips, 0.16, suit, 0, 0.02, 0.02);
      pelvis.scale.set(1, 0.62, 0.78);
      bone(spine, chest, 0.16, suit);
      bone(chest, head, 0.14, suit);
      bone(shoulderL, elbowL, 0.065, suit);
      bone(shoulderR, elbowR, 0.065, suit);
      ball(head, 0.15, white, 0, 0.1, 0.02);
      box(head, 0.21, 0.065, 0.07, ink, 0, 0.1, 0.14).userData.noOutline = true;
    } else {
    // Pelvis + wetsuit torso in rider color (slim — no bell silhouette).
    // Rounded pelvis: a square box read as a mecha "butt-pack" from behind.
    const pelvis = ball(hips, 0.15, suit, 0, 0.02, 0.02);
    pelvis.scale.set(1.0, 0.58, 0.75);
    bone(spine, chest, 0.15, suit);
    // Ink side panels + white chest stripe (panel lines as geometry, trim only).
    // Panels hug the ribcage — a deep panel's rear edge pokes past the hunched
    // back silhouette and reads as a floating backpack from the side.
    box(spine, 0.04, 0.18, 0.17, ink, 0.135, 0.1, 0.09);
    box(spine, 0.04, 0.18, 0.17, ink, -0.135, 0.1, 0.09);
    box(spine, 0.09, 0.2, 0.03, white, 0, 0.1, 0.19, 0.42);
    // Life vest over the chest in RIDER COLOR (the suit dominates the torso);
    // ink zipper + color buckle as trim.
    bone(chest, head, 0.13, suit);
    const vest = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.1, 4, 16), suit);
    vest.position.set(0, 0.05, 0.01);
    chest.add(vest);
    const zip = box(chest, 0.025, 0.22, 0.02, ink, 0, 0.05, 0.17);
    zip.userData.noOutline = true;
    box(chest, 0.07, 0.04, 0.03, accent, 0, -0.04, 0.165);
    // Shoulder pads.
    ball(shoulderL, 0.068, suit, 0.01, 0.02, 0.01);
    ball(shoulderR, 0.068, suit, -0.01, 0.02, 0.01);

    // Arms: wetsuit sleeves, ink gloves.
    bone(shoulderL, elbowL, 0.055, suit);
    bone(shoulderR, elbowR, 0.055, suit);
    bone(elbowL, handL, 0.048, suit);
    bone(elbowR, handR, 0.048, suit);
    ball(handL, 0.06, ink);
    ball(handR, 0.06, ink);

    // Legs: wetsuit thighs, ink boots planted in the footwells.
    bone(hipL, kneeL, 0.085, suit);
    bone(hipR, kneeR, 0.085, suit);
    bone(kneeL, footL, 0.065, suit);
    bone(kneeR, footR, 0.065, suit);
    box(footL, 0.11, 0.09, 0.26, ink, 0, -0.01, 0.06);
    box(footR, 0.11, 0.09, 0.26, ink, 0, -0.01, 0.06);

    // Helmet: white shell, ink visor band, rider-color crown stripe that
    // silhouettes front-to-back (kills the "pom on a ball" read from behind),
    // plus a color nape band at the rear rim, strap.
    ball(head, 0.14, white, 0, 0.1, 0.02);
    const visor = box(head, 0.2, 0.06, 0.06, ink, 0, 0.1, 0.135);
    visor.userData.noOutline = true;
    const stripe = box(head, 0.075, 0.035, 0.26, accent, 0, 0.228, -0.01);
    stripe.userData.noOutline = true;
    const nape = box(head, 0.18, 0.05, 0.05, accent, 0, 0.055, -0.115);
    nape.userData.noOutline = true;
    const strap = box(head, 0.16, 0.025, 0.02, ink, 0, 0.01, 0.1);
    strap.userData.noOutline = true;
    ball(head, 0.05, ink, 0, 0.02, 0.1); // chin guard

      markInk(root);
      addOutline(root);
    }
    this.object = root;
  }

  setColor(color: number): void {
    this.suitMaterial.uniforms.uColor.value.setHex(color, THREE.NoColorSpace);
    this.suitMaterial.uniforms.uEmissive.value.setHex(color, THREE.NoColorSpace);
    this.accentMaterial.uniforms.uColor.value.setHex(color, THREE.NoColorSpace);
  }

  /** dt is fixed 1/60. Applies delta rotations on top of the baked rest pose. */
  update(dt: number, boat: BoatState, t: number, celebrating: boolean): void {
    const T = TUNING;
    const j = this.j;

    // -------------------------------------------------- target state ----
    const leanT = T.leanSign * clamp(boat.lateralG / T.leanGRef, -1, 1) * T.leanMax;
    const pitchT = clamp(-boat.longG * T.pitchPerG, -T.pitchMax, T.pitchMax);
    const driftT = boat.drifting ? T.driftSign * boat.steer * T.driftTwist : 0;
    const airT = boat.airborne ? 1 : 0;
    const flightT = boat.flightPhase !== 'surface' ? 1 : 0;
    const celT = celebrating ? 1 : 0;

    const lean = this.leanS.update(leanT, T.leanOmega, T.leanZeta, dt);
    const pitch = this.pitchS.update(pitchT, T.pitchOmega, T.pitchZeta, dt);
    const drift = this.driftS.update(driftT, T.driftOmega, T.driftZeta, dt);
    const air = this.airS.update(airT, T.airOmega, T.airZeta, dt);
    const flight = this.flightS.update(flightT, T.flightOmega, T.flightZeta, dt);
    const cel = this.celS.update(celT, T.celOmega, T.celZeta, dt);

    // Landing crouch: impulse kicks the spring, underdamped ~0.4s recovery.
    if (boat.landImpulse > 0) this.crouchS.v += boat.landImpulse * T.landKick;
    const crouch = clamp(this.crouchS.update(0, T.landOmega, T.landZeta, dt), -0.3, T.landMax);

    // Idle weight: 1 at a standstill, 0 at racing speed (locked-in bracing).
    const idleW = 1 - clamp(boat.speed / T.lockSpeed, 0, 1);

    // Secondary motion: rider lags the boat's pitch/roll by a slow spring.
    const q = boat.quaternion;
    this.tmp.set(0, 0, 1).applyQuaternion(q);
    const boatPitch = Math.asin(clamp(this.tmp.y, -1, 1));
    this.tmp.set(1, 0, 0).applyQuaternion(q);
    const boatRoll = Math.asin(clamp(this.tmp.y, -1, 1)); // + = rolled left
    const lagP = boatPitch - this.boatPitchS.update(boatPitch, T.followOmega, T.followZeta, dt);
    const lagR = boatRoll - this.boatRollS.update(boatRoll, T.followOmega, T.followZeta, dt);
    const secP = clamp(lagP * T.followGain, -T.followMax, T.followMax) * idleW;
    const secR = clamp(lagR * T.followGain, -T.followMax, T.followMax) * idleW;

    // Breathing + micro vibration (two incommensurate sines, no noise state).
    const breath = Math.sin(t * 2 * Math.PI * T.breathHz) * T.breathAmp * idleW;
    const bob = Math.sin(t * 2 * Math.PI * T.breathHz + 0.6) * T.breathBob * idleW;
    const vib = (Math.sin(t * T.vibF1) + Math.sin(t * T.vibF2)) * 0.5 * T.vibAmp * boat.rpm;

    // Celebration suppresses the driving layer.
    const drive = 1 - cel * 0.85;

    // ------------------------------------------------------ composite ----
    // Hips: lean roll, drift twist, crouch drop, breathing bob.
    j.hips.rotation.set(
      -air * T.airBodyOpen * 0.4 + flight * 0.04 - cel * 0.1,
      drift * drive,
      lean * T.leanHips * drive + secR * 0.5,
    );
    j.hips.position.y = this.hipsBaseY - crouch * T.landHipsDrop - flight * T.flightHipsDrop + bob;

    // Spine: baked forward hunch + weight shift, lean, breathing, secondary
    // lag, celebration upright.
    j.spine.rotation.set(
      POSE.hunchSpine + pitch + breath + secP + crouch * T.landSpine
        - air * T.airBodyOpen + flight * T.flightHunch - cel * T.celUpright,
      0,
      lean * T.leanSpine * drive,
    );
    j.chest.rotation.set(
      POSE.hunchChest + pitch * 0.4 + secP * 0.5 - cel * T.celUpright * 0.4,
      drift * 0.3 * drive,
      lean * T.leanChest * drive,
    );

    // Head: counter-lean, tips up airborne, nods while celebrating.
    j.head.rotation.set(
      POSE.headTiltUp - air * T.airHeadUp - pitch * 0.5
        + cel * Math.sin(t * 2 * Math.PI * T.celNodHz) * T.celNodAmp,
      0,
      -lean * T.headCounter * drive - secR * 0.4,
    );

    // Legs: inside knee flares with lean (lean < 0 = turning left = left inside),
    // crouch flexes both knees, airborne extends them a touch.
    const flareL = Math.max(0, -lean) / T.leanMax * T.kneeFlare * drive;
    const flareR = Math.max(0, lean) / T.leanMax * T.kneeFlare * drive;
    j.hipL.rotation.set(crouch * T.landHip + air * 0.1 + flight * T.flightKnee * 0.65, 0, flareL);
    j.hipR.rotation.set(crouch * T.landHip + air * 0.1 + flight * T.flightKnee * 0.65, 0, -flareR);
    j.kneeL.rotation.set(-crouch * T.landKnee - air * T.airLegExtend - flight * T.flightKnee, 0, 0);
    j.kneeR.rotation.set(-crouch * T.landKnee - air * T.airLegExtend - flight * T.flightKnee, 0, 0);

    // Arms: bracing tension at speed, rise when airborne, outside elbow drops.
    const brace = (1 - idleW) * drive;
    const dropL = Math.max(0, lean) / T.leanMax * T.elbowDrop * drive;  // left elbow drops on right lean
    const dropR = Math.max(0, -lean) / T.leanMax * T.elbowDrop * drive;
    const armBase = -brace * T.braceShoulder - air * T.airArmRise - flight * T.flightArmBrace + vib;
    const elbBase = brace * T.braceElbow + air * T.airElbowTuck + flight * T.flightArmBrace * 0.75 + vib * 1.3;

    // Celebration pump: right arm overhead in a loop, left joins late and
    // returns to the grip every cycle.
    const pumpT = t * 2 * Math.PI * T.pumpHz;
    const pumpR = T.pumpRaise + Math.sin(pumpT) * T.pumpAmp;
    const gateL = Math.pow(Math.max(0, Math.sin(pumpT - T.celLeftLag)), 1.5);
    const pumpL = T.celLeftRaise * gateL;

    // Constant arm tuck: shoulders rotated inward so the arms angle toward
    // the bars and read "holding the grips" from behind, not flared out.
    j.shoulderL.rotation.set(armBase * (1 - cel) + cel * pumpL, 0, -T.armTuck * (1 - cel) - 0.1 * cel);
    j.shoulderR.rotation.set(armBase * (1 - cel) + cel * pumpR, 0, T.armTuck * (1 - cel) + 0.1 * cel);
    j.elbowL.rotation.set(elbBase + dropL, 0, 0);
    j.elbowR.rotation.set(elbBase + dropR + cel * (Math.sin(pumpT) * 0.3 - 0.3), 0, 0);

    // Right wrist works the throttle; left stays quiet on its grip.
    const thr = clamp(boat.throttle, 0, 1);
    j.handR.rotation.set(-thr * T.throttleWrist * (1 - cel), 0, 0);
    j.handL.rotation.set(vib * 0.5, 0, 0);
  }
}
