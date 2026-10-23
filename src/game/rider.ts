/**
 * rider.ts — 3D Ghibli Pilot in Cockpit with Articulated Rig & Dynamic Scarf Physics.
 *
 * Each boat cockpit features a fully articulated 3D character configured for the
 * active pilot (Su Shi, Qingzhao, Xiao Feng, Zhou Botong, Kongming, Wawa):
 *
 *   - Head: bespoke Ghibli hairstyles (topknot, braided bun, hero mane, scholar crown),
 *     headgear (aviator cap, cat-ear hood), goggles (brass pilot, gold thin, monocle, silver scholar),
 *     and expressive watercolor facial features.
 *   - Torso & Arms: artisan flight suits, shoulder guards, hands gripping the cockpit controls.
 *   - Body Dynamics: bank leaning into high-G turns and rolls, forward aerodynamic tuck
 *     during high-speed dives, upright pull-back during steep climbs, landing compression,
 *     idle breathing, and victory celebration.
 *   - Dynamic Flowing Scarf / Cape Physics: 5-segment spring-mass cloth simulation
 *     driven by airspeed slipstream, AoA airflow, lateral inertia, and Ghibli harmonic ripples.
 *
 * Runs at fixed 1/60s sim step with zero per-frame garbage collection allocations.
 */
import * as THREE from 'three';
import { markInk, type BoatState } from '../contracts';
import { PALETTE } from '../core/palette';
import { createToonMaterial } from '../cel/toonMaterial';
import { addOutline } from '../cel/outline';
import { pilotVisualForProfile, type PilotVisualConfig } from './racers';

// ------------------------------------------------------------- tuning ----
const TUNING = {
  // Lean into turns: ~30° max at 1g lateral + hull roll
  leanMax: 0.54,
  leanGRef: 9.8,
  leanSign: -1,
  leanOmega: 8.5,
  leanZeta: 0.92,
  leanHips: 0.42,
  leanSpine: 0.56,
  leanChest: 0.22,
  headCounter: 0.44,
  kneeFlare: 0.52,
  elbowDrop: 0.38,

  // Longitudinal weight shift & aerodynamic dive tuck / climb arch
  pitchPerG: 0.034,
  pitchMax: 0.24,
  pitchOmega: 6.5,
  pitchZeta: 1.0,
  diveTuckMax: 0.55,
  climbArchMax: 0.48,

  // Drift twist
  driftTwist: 0.42,
  driftSign: 1,
  driftOmega: 8,
  driftZeta: 1,

  // Controls & engine micro-vibration
  throttleWrist: 0.45,
  vibAmp: 0.012,
  vibF1: 45,
  vibF2: 32.5,

  // Glider flight bracing & landing crouch
  airOmega: 6,
  airZeta: 1,
  flightOmega: 7.5,
  flightZeta: 1,
  landKick: 0.055,
  landMax: 1.2,
  landOmega: 16,
  landZeta: 0.35,
  landHipsDrop: 0.15,
  landSpine: 0.42,
  landKnee: 0.58,

  // Idle breathing & motion
  breathHz: 0.35,
  breathAmp: 0.03,
  breathBob: 0.008,
  followOmega: 3.5,
  followZeta: 1,
  followGain: 0.6,
  followMax: 0.14,
  lockSpeed: 14,
  braceShoulder: 0.08,
  braceElbow: 0.06,
  armTuck: 0.20,

  // Victory celebration
  celOmega: 7,
  celZeta: 1,
  pumpHz: 1.75,
  pumpAmp: 0.48,
  pumpRaise: -2.3,
  celLeftRaise: -1.6,
  celLeftLag: 1.1,
  celNodHz: 0.9,
  celNodAmp: 0.12,
  celUpright: 0.36,
} as const;

// Seated cockpit racing rest pose
const POSE = {
  hips: [0, 0.58, -0.22],
  spine: [0, 0.13, 0.05],
  chest: [0, 0.19, 0.09],
  head: [0, 0.20, 0.10],
  shoulderL: [0.20, 0.10, 0.03],
  elbowL: [0.045, -0.129, 0.293],
  handL: [-0.02, -0.17, 0.345],
  hipL: [0.11, -0.03, 0.05],
  kneeL: [0.09, -0.20, 0.26],
  footL: [-0.05, -0.28, 0.10],
  hunchSpine: 0.40,
  hunchChest: 0.16,
  headTiltUp: -0.68,
} as const;

const UP = new THREE.Vector3(0, 1, 0);
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

class DampedSpring {
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

// ------------------------------------------------ dynamic cloth physics ----
const CLOTH_SEGS = 5;
const NUM_CLOTH_NODES = CLOTH_SEGS + 1;

interface ClothNode {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
}

interface DynamicClothRibbon {
  nodes: ClothNode[];
  geo: THREE.BufferGeometry;
  mesh: THREE.Mesh;
  targetLen: number;
  widthStart: number;
  widthEnd: number;
  lateralOffset: number;
}

export interface RiderOptions {
  profileId?: string;
  color: number;
  detailedInk?: boolean;
}

export class Rider {
  readonly object: THREE.Object3D;

  private profileId: string;
  private detailedInk: boolean;
  private j!: Rig;
  private hipsBaseY = 0.58;

  // Materials
  private suitMat!: THREE.ShaderMaterial;
  private secondaryMat!: THREE.ShaderMaterial;
  private skinMat!: THREE.ShaderMaterial;
  private hairMat!: THREE.ShaderMaterial;
  private headgearMat!: THREE.ShaderMaterial;
  private gogglesMat!: THREE.ShaderMaterial;
  private lensMat!: THREE.ShaderMaterial;
  private capeMat!: THREE.ShaderMaterial;
  private inkMat!: THREE.ShaderMaterial;
  private whiteMat!: THREE.ShaderMaterial;

  // Dynamic Scarf / Cape Physics Chains
  private ribbons: DynamicClothRibbon[] = [];
  private readonly scarfAnchor = new THREE.Object3D();

  // Animation Springs
  private readonly leanS = new DampedSpring();
  private readonly pitchS = new DampedSpring();
  private readonly diveS = new DampedSpring();
  private readonly climbS = new DampedSpring();
  private readonly driftS = new DampedSpring();
  private readonly airS = new DampedSpring();
  private readonly flightS = new DampedSpring();
  private readonly crouchS = new DampedSpring();
  private readonly celS = new DampedSpring();
  private readonly boatPitchS = new DampedSpring();
  private readonly boatRollS = new DampedSpring();

  // Temps
  private readonly tmpVec = new THREE.Vector3();
  private readonly tmpVec2 = new THREE.Vector3();
  private readonly anchorWorldPos = new THREE.Vector3();

  constructor(opts: RiderOptions) {
    this.profileId = opts.profileId ?? 'sushi';
    this.detailedInk = opts.detailedInk !== false;

    this.object = new THREE.Group();
    this.object.name = 'rider';

    this.rebuildPilot(this.profileId);
  }

  setProfile(profileId: string, _color?: number): void {
    if (this.profileId === profileId) return;
    this.profileId = profileId;
    this.rebuildPilot(profileId);
  }

  setColor(_color: number): void {
    // Preserve pilot's authentic suitColor & watercolor character design.
    // Hull color must never overwrite tailored pilot costume colors.
  }

  private rebuildPilot(profileId: string): void {
    // Clear existing children
    while (this.object.children.length > 0) {
      const child = this.object.children[0];
      this.object.remove(child);
    }
    this.ribbons = [];

    const visual = pilotVisualForProfile(profileId);
    const suitColor = visual.suitColor;

    // Build Ghibli cel materials
    this.suitMat = createToonMaterial({
      color: suitColor,
      rimColor: PALETTE.sparkle,
      rimStrength: 1.15,
      rimThreshold: 0.55,
      emissive: suitColor,
      emissiveIntensity: 0.12,
    });
    this.secondaryMat = createToonMaterial({
      color: visual.secondaryColor,
      rimColor: PALETTE.foam,
      rimStrength: 0.85,
    });
    this.skinMat = createToonMaterial({
      color: visual.skinColor,
      rimColor: PALETTE.foam,
      rimStrength: 0.65,
      specColor: PALETTE.sparkle,
      specThreshold: 0.82,
    });
    this.hairMat = createToonMaterial({
      color: visual.hairColor,
      rimColor: PALETTE.sparkle,
      rimStrength: 0.75,
    });
    this.headgearMat = createToonMaterial({
      color: visual.headgearColor,
      rimColor: PALETTE.foam,
      rimStrength: 0.9,
    });
    this.gogglesMat = createToonMaterial({
      color: visual.gogglesColor,
      rimColor: PALETTE.sparkle,
      rimStrength: 1.2,
      specColor: PALETTE.sparkle,
      specThreshold: 0.6,
    });
    this.lensMat = createToonMaterial({
      color: visual.gogglesLensColor,
      rimColor: PALETTE.foam,
      rimStrength: 1.4,
      emissive: visual.gogglesLensColor,
      emissiveIntensity: 0.35,
    });
    this.capeMat = createToonMaterial({
      color: visual.capeColor,
      rimColor: PALETTE.sparkle,
      rimStrength: 0.95,
      specColor: PALETTE.sparkle,
      specThreshold: 0.75,
    });
    this.capeMat.side = THREE.DoubleSide;

    const leatherMat = createToonMaterial({
      color: 0x6B4423,
      rimColor: PALETTE.foam,
      rimStrength: 0.75,
      specColor: PALETTE.sparkle,
      specThreshold: 0.85,
    });
    const darkLeatherMat = createToonMaterial({
      color: 0x2E1E14,
      rimColor: PALETTE.foam,
      rimStrength: 0.65,
    });
    const brassMat = createToonMaterial({
      color: 0xDDA73A,
      rimColor: PALETTE.sparkle,
      rimStrength: 1.3,
      specColor: PALETTE.sparkle,
      specThreshold: 0.55,
      emissive: 0x8A6418,
      emissiveIntensity: 0.15,
    });
    const silverMat = createToonMaterial({
      color: 0xD8E4EE,
      rimColor: PALETTE.sparkle,
      rimStrength: 1.2,
      specColor: PALETTE.sparkle,
      specThreshold: 0.6,
    });
    const goldTrimMat = createToonMaterial({
      color: visual.capeTrimColor || 0xD8B868,
      rimColor: PALETTE.sparkle,
      rimStrength: 1.1,
    });
    this.inkMat = createToonMaterial({
      color: 0x221E1C,
      rimColor: PALETTE.foam,
      rimStrength: 0.5,
    });
    this.whiteMat = createToonMaterial({
      color: 0xFAF6EB,
      specColor: PALETTE.sparkle,
      rimStrength: 0.85,
    });
    const blushMat = createToonMaterial({
      color: 0xFFA090,
      rimColor: PALETTE.foam,
      rimStrength: 0.45,
    });

    const joint = (parent: THREE.Object3D, name: string, p: readonly number[], mirror = 1): THREE.Object3D => {
      const o = new THREE.Object3D();
      o.name = name;
      o.position.set(p[0] * mirror, p[1], p[2]);
      parent.add(o);
      return o;
    };

    const bone = (a: THREE.Object3D, b: THREE.Object3D, r: number, mat: THREE.Material): THREE.Mesh => {
      const dir = b.position.clone();
      const len = dir.length();
      const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(0.02, len - r * 0.6), 4, 14), mat);
      m.position.copy(dir).multiplyScalar(0.5);
      m.quaternion.setFromUnitVectors(UP, dir.normalize());
      a.add(m);
      return m;
    };

    const ball = (parent: THREE.Object3D, r: number, mat: THREE.Material, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1): THREE.Mesh => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), mat);
      m.position.set(x, y, z);
      if (sx !== 1 || sy !== 1 || sz !== 1) m.scale.set(sx, sy, sz);
      parent.add(m);
      return m;
    };

    const box = (parent: THREE.Object3D, w: number, h: number, d: number, mat: THREE.Material,
      x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): THREE.Mesh => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, rz);
      parent.add(m);
      return m;
    };

    const cyl = (parent: THREE.Object3D, rt: number, rb: number, h: number, mat: THREE.Material,
      x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, segs = 14): THREE.Mesh => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, segs), mat);
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, rz);
      parent.add(m);
      return m;
    };

    // ---------------------------------------------------- Skeleton ----
    const hips = joint(this.object, 'hips', POSE.hips);
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

    // Scarf/Cape anchor at the back of neck
    this.scarfAnchor.position.set(0, 0.12, -0.08);
    chest.add(this.scarfAnchor);

    // --------------------------------------------- 1. Torso & Clothing Layers ----
    // Pelvis & Lower Torso Base
    const pelvis = ball(hips, 0.15, this.suitMat, 0, 0.02, 0.02, 1.0, 0.62, 0.8);
    bone(spine, chest, 0.15, this.suitMat);

    // Character-Specific Torso Layering & Costumes
    switch (profileId) {
      case 'sushi': {
        // 苏轼 (Su Shi): Sage Daoist robe with gold frog buttons, cream inner robe, leather travel belt & shoulder scroll bag
        // Inner off-white cross-collar
        box(chest, 0.18, 0.14, 0.18, this.whiteMat, 0, 0.12, 0.04);
        box(chest, 0.03, 0.18, 0.03, goldTrimMat, 0.05, 0.08, 0.15, 0, 0, -0.22);
        box(chest, 0.03, 0.18, 0.03, goldTrimMat, -0.05, 0.08, 0.15, 0, 0, 0.22);

        // Sage Daoist over-robe vest
        const vest = new THREE.Mesh(new THREE.CapsuleGeometry(0.165, 0.12, 4, 16), this.suitMat);
        vest.position.set(0, 0.05, 0.01);
        chest.add(vest);

        // Off-white silk neck cowl/wrap
        cyl(chest, 0.11, 0.13, 0.07, this.whiteMat, 0, 0.18, 0.02);
        cyl(chest, 0.13, 0.14, 0.04, this.whiteMat, 0, 0.15, 0.02);

        // Traditional gold frog buttons (盘扣) down chest
        for (let i = 0; i < 3; i++) {
          const fy = 0.12 - i * 0.06;
          ball(chest, 0.016, brassMat, 0, fy, 0.165);
          box(chest, 0.06, 0.012, 0.015, goldTrimMat, 0, fy, 0.162);
        }

        // Leather belt & brass buckle
        box(spine, 0.33, 0.065, 0.26, leatherMat, 0, 0.02, 0.03);
        box(spine, 0.09, 0.075, 0.04, brassMat, 0, 0.02, 0.165);
        box(spine, 0.05, 0.045, 0.045, leatherMat, 0, 0.02, 0.166);

        // Diagonal travel bag strap across chest (right shoulder to left hip)
        box(chest, 0.04, 0.32, 0.02, leatherMat, -0.02, 0.04, 0.155, 0, 0, 0.55);
        // Leather travel pouch on left hip
        box(hips, 0.08, 0.12, 0.14, leatherMat, 0.19, -0.02, 0.04, 0, 0, -0.15);
        ball(hips, 0.018, brassMat, 0.235, -0.02, 0.06);

        // Robe skirt flaps over hips with cream hem trim
        box(hips, 0.35, 0.18, 0.30, this.suitMat, 0, -0.07, 0.02);
        box(hips, 0.37, 0.035, 0.32, this.whiteMat, 0, -0.16, 0.02);
        box(hips, 0.38, 0.015, 0.33, goldTrimMat, 0, -0.175, 0.02);
        break;
      }
      case 'qingzhao': {
        // 清照 (Qingzhao): Light cyan wrap blouse, dark inner V-neck, leather belt with poet's notebook & brass pen holster
        // Dark inner shirt
        box(chest, 0.15, 0.12, 0.15, this.inkMat, 0, 0.11, 0.04);

        // Light cyan wrap blouse with folded lapel
        const blouse = new THREE.Mesh(new THREE.CapsuleGeometry(0.155, 0.11, 4, 16), this.suitMat);
        blouse.position.set(0, 0.05, 0.01);
        chest.add(blouse);

        // Folded lapels
        box(chest, 0.04, 0.20, 0.03, this.secondaryMat, 0.06, 0.07, 0.15, 0, 0, -0.28);
        box(chest, 0.04, 0.20, 0.03, this.secondaryMat, -0.06, 0.07, 0.15, 0, 0, 0.28);
        box(chest, 0.20, 0.06, 0.18, this.secondaryMat, 0, 0.16, 0.02);

        // Brown leather belt with brass buckle
        box(spine, 0.31, 0.055, 0.24, leatherMat, 0, 0.02, 0.03);
        box(spine, 0.075, 0.065, 0.035, brassMat, 0, 0.02, 0.155);

        // Poet's Notebook & Brass Pen holster on left hip
        const book = box(hips, 0.04, 0.14, 0.11, this.whiteMat, 0.18, -0.03, 0.02, 0, 0, -0.2);
        box(book, 0.045, 0.145, 0.02, leatherMat, 0, 0, -0.05); // book spine
        cyl(hips, 0.008, 0.008, 0.12, brassMat, 0.19, -0.02, 0.09, 0, 0, -0.2); // brass quill/pen

        // Lower tunic flare over cream pants
        box(hips, 0.33, 0.12, 0.26, this.suitMat, 0, -0.04, 0.02);
        box(hips, 0.34, 0.03, 0.28, this.secondaryMat, 0, -0.10, 0.02);
        break;
      }
      case 'xiaofeng': {
        // 萧峰 (Xiao Feng): Crimson martial robe, brown leather brigandine chest cuirass with dual straps, studded pauldrons, wide girdle
        // Dark slate martial under-tunic
        box(chest, 0.16, 0.14, 0.16, this.inkMat, 0, 0.12, 0.04);

        // Crimson warrior robe
        const robe = new THREE.Mesh(new THREE.CapsuleGeometry(0.175, 0.13, 4, 16), this.suitMat);
        robe.position.set(0, 0.05, 0.01);
        chest.add(robe);

        // Brown leather chest cuirass / brigandine
        box(chest, 0.28, 0.18, 0.14, this.secondaryMat, 0, 0.04, 0.09);
        // Dual horizontal leather buckle straps across chest
        box(chest, 0.29, 0.03, 0.03, leatherMat, 0, 0.09, 0.16);
        ball(chest, 0.015, brassMat, 0.08, 0.09, 0.175);
        ball(chest, 0.015, brassMat, -0.08, 0.09, 0.175);
        box(chest, 0.29, 0.03, 0.03, leatherMat, 0, 0.01, 0.16);
        ball(chest, 0.015, brassMat, 0.08, 0.01, 0.175);
        ball(chest, 0.015, brassMat, -0.08, 0.01, 0.175);

        // Golden shoulder cape fastener brooches
        ball(chest, 0.028, brassMat, 0.12, 0.16, 0.05);
        ball(chest, 0.028, brassMat, -0.12, 0.16, 0.05);

        // Wide warrior leather girdle / belt
        box(spine, 0.35, 0.09, 0.28, darkLeatherMat, 0, 0.02, 0.03);
        box(spine, 0.10, 0.08, 0.04, brassMat, 0, 0.02, 0.17);
        // Side leather utility pouch
        box(hips, 0.09, 0.11, 0.12, leatherMat, 0.20, -0.01, 0.03);

        // Crimson skirt flaps
        box(hips, 0.36, 0.20, 0.30, this.suitMat, 0, -0.08, 0.02);
        box(hips, 0.38, 0.04, 0.32, darkLeatherMat, 0, -0.18, 0.02);
        break;
      }
      case 'zhoubotong': {
        // 舟伯通 (Zhou Botong): Earthy olive storm coat, cream cable-knit fisherman sweater, bright blue neckerchief, courier bag strap
        // Cable-knit fisherman sweater
        box(chest, 0.18, 0.20, 0.18, this.secondaryMat, 0, 0.07, 0.05);
        // Sweater ribbed neck
        cyl(chest, 0.10, 0.11, 0.05, this.secondaryMat, 0, 0.17, 0.02);

        // Bright sky-blue neckerchief / bandanna
        cyl(chest, 0.115, 0.125, 0.04, this.lensMat, 0, 0.16, 0.03);
        ball(chest, 0.022, this.lensMat, 0, 0.14, 0.15); // knot

        // Olive storm jacket coat body
        const coat = new THREE.Mesh(new THREE.CapsuleGeometry(0.18, 0.14, 4, 16), this.suitMat);
        coat.position.set(0, 0.05, 0.01);
        chest.add(coat);

        // Wide storm coat lapels & brass buttons
        box(chest, 0.05, 0.22, 0.04, this.suitMat, 0.08, 0.06, 0.15, 0, 0, -0.2);
        box(chest, 0.05, 0.22, 0.04, this.suitMat, -0.08, 0.06, 0.15, 0, 0, 0.2);
        for (let i = 0; i < 3; i++) {
          ball(chest, 0.016, brassMat, 0.09, 0.11 - i * 0.07, 0.165);
        }

        // Diagonal canvas courier bag strap
        box(chest, 0.04, 0.34, 0.02, this.secondaryMat, -0.01, 0.04, 0.165, 0, 0, 0.58);
        box(hips, 0.10, 0.14, 0.15, this.secondaryMat, 0.20, -0.03, 0.03, 0, 0, -0.15);

        // Leather belt with brass buckle
        box(spine, 0.34, 0.06, 0.26, leatherMat, 0, 0.02, 0.03);
        box(spine, 0.08, 0.07, 0.04, brassMat, 0, 0.02, 0.165);

        // Heavy coat lower body flaps
        box(hips, 0.36, 0.20, 0.30, this.suitMat, 0, -0.08, 0.02);
        break;
      }
      case 'kongming': {
        // 孔明 (Kongming): Scholar deep indigo trenchcoat, midnight sapphire inner robe with silver cloud embroidery, Bagua disc, crane feather fan
        // Midnight sapphire inner robe with white collar insert
        box(chest, 0.16, 0.14, 0.16, this.whiteMat, 0, 0.13, 0.04);
        box(chest, 0.18, 0.18, 0.17, this.secondaryMat, 0, 0.08, 0.04);

        // Silver cloud embroidery border
        box(chest, 0.03, 0.18, 0.03, silverMat, 0.05, 0.08, 0.15, 0, 0, -0.2);
        box(chest, 0.03, 0.18, 0.03, silverMat, -0.05, 0.08, 0.15, 0, 0, 0.2);

        // Scholar indigo trenchcoat duster
        const duster = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.13, 4, 16), this.suitMat);
        duster.position.set(0, 0.05, 0.01);
        chest.add(duster);

        // Double-breasted silver buttons
        for (let i = 0; i < 3; i++) {
          const by = 0.11 - i * 0.06;
          ball(chest, 0.014, silverMat, 0.055, by, 0.165);
          ball(chest, 0.014, silverMat, -0.055, by, 0.165);
        }

        // Golden Bagua trigram medallion at waist
        cyl(spine, 0.045, 0.045, 0.015, brassMat, 0, 0.02, 0.17, Math.PI / 2, 0, 0);
        ball(spine, 0.015, this.secondaryMat, 0, 0.02, 0.18);
        // Golden hanging tassels
        cyl(spine, 0.005, 0.008, 0.12, goldTrimMat, 0.03, -0.06, 0.165);
        cyl(spine, 0.005, 0.008, 0.12, goldTrimMat, -0.03, -0.06, 0.165);

        // White crane feather fan tucked at left hip
        const fan = box(hips, 0.03, 0.18, 0.12, this.whiteMat, 0.20, 0.02, 0.05, 0, 0, -0.35);
        cyl(fan, 0.006, 0.006, 0.10, goldTrimMat, 0, -0.10, 0);

        // Long duster skirt flaps
        box(hips, 0.35, 0.22, 0.30, this.suitMat, 0, -0.09, 0.02);
        box(hips, 0.36, 0.03, 0.31, goldTrimMat, 0, -0.20, 0.02);
        break;
      }
      case 'wawa': {
        // 娃娃 (Wawa): Emerald green hooded poncho capelet, sprout green trim, wooden toggle frog clasps, brass Furin bell with rainbow wish strip
        // Cream linen undershirt
        box(chest, 0.15, 0.14, 0.15, this.whiteMat, 0, 0.10, 0.03);

        // Emerald poncho capelet
        const poncho = new THREE.Mesh(new THREE.CapsuleGeometry(0.165, 0.11, 4, 16), this.suitMat);
        poncho.position.set(0, 0.05, 0.01);
        chest.add(poncho);

        // Hood collar & green border
        cyl(chest, 0.12, 0.14, 0.06, this.suitMat, 0, 0.16, 0.01);
        cyl(chest, 0.135, 0.15, 0.02, this.secondaryMat, 0, 0.14, 0.01);

        // Wooden toggle clasps (牛角扣) down chest
        for (let i = 0; i < 2; i++) {
          const cy = 0.09 - i * 0.06;
          cyl(chest, 0.008, 0.008, 0.045, leatherMat, 0, cy, 0.165, 0, 0, Math.PI / 2);
          ball(chest, 0.012, this.whiteMat, 0, cy, 0.17);
        }

        // Brass Furin Windchime Bell on collar with fluttering rainbow wish strip
        if (visual.hasFurinBell) {
          ball(chest, 0.026, brassMat, 0, 0.12, 0.18);
          // Rainbow wish paper strip hanging below bell
          box(chest, 0.025, 0.09, 0.005, blushMat, 0, 0.04, 0.18, 0.1, 0, 0);
          box(chest, 0.025, 0.03, 0.006, this.lensMat, 0, 0.015, 0.183, 0.1, 0, 0);
        }

        // Rope cord belt
        box(spine, 0.31, 0.04, 0.24, this.whiteMat, 0, 0.02, 0.03);

        // Poncho hem flare
        box(hips, 0.34, 0.14, 0.28, this.suitMat, 0, -0.05, 0.02);
        box(hips, 0.35, 0.03, 0.29, this.secondaryMat, 0, -0.12, 0.02);
        break;
      }
    }

    // --------------------------------------------- 2. Arms & Cockpit Controls ----
    // Character-Specific Shoulders
    if (visual.hasShoulderPads) {
      // Xiao Feng warrior pauldrons with brass rivets
      const padL = box(shoulderL, 0.14, 0.08, 0.16, this.secondaryMat, 0.02, 0.05, 0);
      const padR = box(shoulderR, 0.14, 0.08, 0.16, this.secondaryMat, -0.02, 0.05, 0);
      ball(padL, 0.022, brassMat, 0.04, 0.04, 0.04);
      ball(padL, 0.022, brassMat, 0.04, 0.04, -0.04);
      ball(padR, 0.022, brassMat, -0.04, 0.04, 0.04);
      ball(padR, 0.022, brassMat, -0.04, 0.04, -0.04);
    } else {
      ball(shoulderL, 0.072, this.suitMat, 0.01, 0.02, 0.01);
      ball(shoulderR, 0.072, this.suitMat, -0.01, 0.02, 0.01);
    }

    // Arms
    bone(shoulderL, elbowL, 0.058, this.suitMat);
    bone(shoulderR, elbowR, 0.058, this.suitMat);
    bone(elbowL, handL, 0.050, this.suitMat);
    bone(elbowR, handR, 0.050, this.suitMat);

    // Artisan Sleeve Cuffs & Vambraces
    if (profileId === 'xiaofeng') {
      // Golden dragon vambraces on forearms
      box(elbowL, 0.12, 0.10, 0.13, leatherMat, 0, -0.07, 0.10);
      box(elbowR, 0.12, 0.10, 0.13, leatherMat, 0, -0.07, 0.10);
      box(elbowL, 0.125, 0.06, 0.08, goldTrimMat, 0, -0.07, 0.14);
      box(elbowR, 0.125, 0.06, 0.08, goldTrimMat, 0, -0.07, 0.14);
      ball(handL, 0.062, darkLeatherMat);
      ball(handR, 0.062, darkLeatherMat);
    } else if (profileId === 'sushi') {
      // Daoist wide sleeve cuffs
      box(elbowL, 0.13, 0.11, 0.14, this.whiteMat, 0, -0.07, 0.10);
      box(elbowR, 0.13, 0.11, 0.14, this.whiteMat, 0, -0.07, 0.10);
      box(elbowL, 0.135, 0.03, 0.145, goldTrimMat, 0, -0.07, 0.15);
      box(elbowR, 0.135, 0.03, 0.145, goldTrimMat, 0, -0.07, 0.15);
      ball(handL, 0.062, leatherMat);
      ball(handR, 0.062, leatherMat);
    } else {
      box(elbowL, 0.11, 0.09, 0.12, this.secondaryMat, 0, -0.07, 0.10);
      box(elbowR, 0.11, 0.09, 0.12, this.secondaryMat, 0, -0.07, 0.10);
      ball(handL, 0.062, leatherMat);
      ball(handR, 0.062, leatherMat);
    }

    // Hands gripping yoke controls
    box(handL, 0.045, 0.085, 0.10, leatherMat, 0, 0.02, 0);
    box(handR, 0.045, 0.085, 0.10, leatherMat, 0, 0.02, 0);

    // --------------------------------------------- 3. Legs & Seated Boots ----
    // Seated Legs in Footwells
    bone(hipL, kneeL, 0.085, this.suitMat);
    bone(hipR, kneeR, 0.085, this.suitMat);
    bone(kneeL, footL, 0.065, this.suitMat);
    bone(kneeR, footR, 0.065, this.suitMat);

    // Character-Specific Leather Boots
    const bootColorMat = profileId === 'xiaofeng' || profileId === 'kongming'
      ? darkLeatherMat
      : profileId === 'zhoubotong'
      ? this.inkMat
      : leatherMat;

    // Boot shafts with cuffs & buckles
    box(kneeL, 0.135, 0.13, 0.16, bootColorMat, 0, -0.15, 0.05);
    box(kneeR, 0.135, 0.13, 0.16, bootColorMat, 0, -0.15, 0.05);
    // Boot foot / shoe
    box(footL, 0.115, 0.095, 0.27, bootColorMat, 0, -0.01, 0.06);
    box(footR, 0.115, 0.095, 0.27, bootColorMat, 0, -0.01, 0.06);
    // Boot buckle straps
    box(footL, 0.12, 0.025, 0.06, brassMat, 0, 0.02, 0.06);
    box(footR, 0.12, 0.025, 0.06, brassMat, 0, 0.02, 0.06);

    // ---------------------------------------------------- 4. Head & Face ----
    // Base Face Sphere with Watercolor Skin
    ball(head, 0.135, this.skinMat, 0, 0.09, 0.03);

    // Expressive Watercolor Eyes & Eyebrows
    // Eyebrows
    const browMat = profileId === 'sushi' || profileId === 'zhoubotong' ? this.hairMat : this.inkMat;
    const browThick = profileId === 'xiaofeng' ? 0.018 : 0.012;
    box(head, 0.045, browThick, 0.01, browMat, 0.045, 0.125, 0.155, 0, 0, -0.12);
    box(head, 0.045, browThick, 0.01, browMat, -0.045, 0.125, 0.155, 0, 0, 0.12);

    // Eye ink arcs
    box(head, 0.035, 0.014, 0.01, this.inkMat, 0.048, 0.095, 0.158);
    box(head, 0.035, 0.014, 0.01, this.inkMat, -0.048, 0.095, 0.158);
    // Eye white catchlights
    ball(head, 0.008, this.whiteMat, 0.042, 0.10, 0.162);
    ball(head, 0.008, this.whiteMat, -0.042, 0.10, 0.162);

    // Nose bridge
    ball(head, 0.018, this.skinMat, 0, 0.075, 0.165);

    // Watercolor Cheek Blushes
    ball(head, 0.035, blushMat, 0.075, 0.07, 0.13);
    ball(head, 0.035, blushMat, -0.075, 0.07, 0.13);

    // ---------------------------------------- 5. Headgear & Hairstyle ----
    this.buildHeadgear(head, visual, profileId);

    // --------------------------------------------- 6. Goggles & Glasses ----
    this.buildGoggles(head, visual, profileId);

    // ---------------------------------------- 7. Dynamic Scarf / Cape ----
    this.buildDynamicCloth(visual);

    if (this.detailedInk) {
      markInk(this.object);
      addOutline(this.object);
    }
  }

  private buildHeadgear(head: THREE.Object3D, visual: PilotVisualConfig, profileId: string): void {
    const ball = (r: number, mat: THREE.Material, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1): THREE.Mesh => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), mat);
      m.position.set(x, y, z);
      if (sx !== 1 || sy !== 1 || sz !== 1) m.scale.set(sx, sy, sz);
      head.add(m);
      return m;
    };
    const box = (w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): THREE.Mesh => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, rz);
      head.add(m);
      return m;
    };
    const cyl = (rt: number, rb: number, h: number, mat: THREE.Material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, segs = 14): THREE.Mesh => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, segs), mat);
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, rz);
      head.add(m);
      return m;
    };

    switch (visual.headgearType) {
      case 'scholar_topknot': {
        // 苏轼 (Su Shi): Silver-white hair, neat Daoist scholar topknot bun, horizontal white jade/ivory hairpin, mustache & goatee
        // Hair volume
        ball(0.146, this.hairMat, 0, 0.11, -0.01, 1.0, 1.02, 1.05);
        // Topknot bun
        cyl(0.048, 0.058, 0.09, this.hairMat, 0, 0.23, -0.02);
        ball(0.055, this.hairMat, 0, 0.27, -0.02);
        // Horizontal White Jade / Ivory Hairpin (簪子)
        cyl(0.009, 0.009, 0.22, this.whiteMat, 0, 0.25, -0.02, 0, 0, Math.PI / 2);
        ball(0.016, this.whiteMat, 0.11, 0.25, -0.02); // hairpin carved bulb end
        ball(0.012, this.whiteMat, -0.11, 0.25, -0.02);

        if (visual.hasBeard) {
          // Dignified silver-white mustache: dual sweeping volumes
          ball(0.038, this.hairMat, 0.034, 0.038, 0.135, 1.3, 0.8, 1.0);
          ball(0.038, this.hairMat, -0.034, 0.038, 0.135, 1.3, 0.8, 1.0);
          // Tapered scholar goatee / beard
          cyl(0.028, 0.012, 0.11, this.hairMat, 0, -0.02, 0.12, 0.28, 0, 0);
          ball(0.035, this.hairMat, 0, 0.02, 0.12);
        }
        break;
      }
      case 'qing_ribbon_bun': {
        // 清照 (Qingzhao): Aviator brown leather flight cap with earflaps, twin cyan silk ribbons trailing
        // Aviator leather helmet/cap
        ball(0.148, this.headgearMat, 0, 0.11, -0.01, 1.02, 1.04, 1.05);
        // Cap earflaps
        box(0.04, 0.14, 0.12, this.headgearMat, 0.13, 0.04, 0.02, 0, 0, -0.12);
        box(0.04, 0.14, 0.12, this.headgearMat, -0.13, 0.04, 0.02, 0, 0, 0.12);
        // Chin strap
        box(0.24, 0.02, 0.02, this.headgearMat, 0, -0.02, 0.08);

        // Windblown dark hair locks emerging from under cap
        box(0.04, 0.18, 0.06, this.hairMat, 0.10, 0.02, -0.04, 0.3, 0, -0.25);
        box(0.04, 0.18, 0.06, this.hairMat, -0.10, 0.02, -0.04, 0.3, 0, 0.25);
        box(0.14, 0.22, 0.08, this.hairMat, 0, 0.02, -0.12, 0.35, 0, 0);

        // Hair ribbon anchor knot
        ball(0.035, this.capeMat, 0, 0.14, -0.12);
        break;
      }
      case 'hero_longhair': {
        // 萧峰 (Xiao Feng): Wild heroic flowing black mane, leather browband with brass medallion
        // Wild mane volume
        ball(0.148, this.hairMat, 0, 0.11, -0.01);
        // Layered windblown locks billowing backward
        box(0.26, 0.30, 0.16, this.hairMat, 0, 0.04, -0.14, -0.22, 0, 0);
        box(0.22, 0.24, 0.12, this.hairMat, 0, 0.15, -0.12, -0.35, 0, 0);
        // Side locks
        box(0.07, 0.26, 0.09, this.hairMat, 0.13, 0.03, -0.02, 0.1, 0, -0.28);
        box(0.07, 0.26, 0.09, this.hairMat, -0.13, 0.03, -0.02, 0.1, 0, 0.28);

        // Leather brow headband with central golden dragon medallion
        box(0.27, 0.04, 0.27, this.headgearMat, 0, 0.135, 0.02);
        cyl(0.032, 0.032, 0.015, this.lensMat, 0, 0.135, 0.155, Math.PI / 2, 0, 0);
        ball(0.014, this.gogglesMat, 0, 0.135, 0.162);
        break;
      }
      case 'aviator_beard_hat': {
        // 舟伯通 (Zhou Botong): Aviator felt cap with fleece earflaps, wild fluffy white hair & full bushy beard
        // Felt cap
        ball(0.152, this.headgearMat, 0, 0.12, -0.01);
        // Cream fleece earflaps
        box(0.055, 0.16, 0.14, this.headgearMat, 0.13, 0.03, 0, 0, 0, -0.15);
        box(0.055, 0.16, 0.14, this.headgearMat, -0.13, 0.03, 0, 0, 0, 0.15);
        box(0.058, 0.04, 0.145, this.whiteMat, 0.13, -0.05, 0, 0, 0, -0.15); // fleece trim
        box(0.058, 0.04, 0.145, this.whiteMat, -0.13, -0.05, 0, 0, 0, 0.15);

        // Wild fluffy white hair curls sticking out
        ball(0.05, this.hairMat, 0.12, 0.10, -0.08);
        ball(0.05, this.hairMat, -0.12, 0.10, -0.08);
        ball(0.06, this.hairMat, 0, 0.06, -0.14);

        // Full fluffy snow-white mustache & big bushy beard
        ball(0.065, this.hairMat, 0, 0.01, 0.13, 1.2, 0.9, 1.1);
        ball(0.055, this.hairMat, 0.06, 0.02, 0.125);
        ball(0.055, this.hairMat, -0.06, 0.02, 0.125);
        ball(0.085, this.hairMat, 0, -0.05, 0.10, 1.1, 1.2, 1.1);
        ball(0.065, this.hairMat, 0.05, -0.04, 0.08);
        ball(0.065, this.hairMat, -0.05, -0.04, 0.08);

        // Wooden smoking pipe at side
        cyl(0.008, 0.006, 0.08, this.gogglesMat, 0.08, 0.01, 0.14, 0.4, 0.3, 0);
        cyl(0.016, 0.012, 0.035, this.gogglesMat, 0.11, 0.03, 0.17);
        break;
      }
      case 'astrolabe_crown': {
        // 孔明 (Kongming): Scholar astronomy jade/silver crown, ivory hairpin, long sleek black hair
        // Hair volume
        ball(0.145, this.hairMat, 0, 0.11, -0.01);
        box(0.22, 0.34, 0.12, this.hairMat, 0, 0.01, -0.11, -0.12, 0, 0);

        // Daoist Scholar Lun-jin / Astronomy Crown (Jade & Silver)
        cyl(0.055, 0.065, 0.10, this.headgearMat, 0, 0.23, 0.01);
        cyl(0.075, 0.075, 0.02, this.gogglesMat, 0, 0.28, 0.01);
        // Horizontal Ivory Hairpin (簪子)
        cyl(0.008, 0.008, 0.22, this.whiteMat, 0, 0.23, 0.01, 0, 0, Math.PI / 2);
        ball(0.014, this.whiteMat, 0.11, 0.23, 0.01);
        ball(0.014, this.whiteMat, -0.11, 0.23, 0.01);

        // Twin Celestial silk ribbons trailing from crown
        box(0.025, 0.28, 0.01, this.capeMat, 0.04, 0.10, -0.08, 0.25, 0, 0.1);
        box(0.025, 0.28, 0.01, this.capeMat, -0.04, 0.10, -0.08, 0.25, 0, -0.1);
        break;
      }
      case 'cat_ear_hood': {
        // 娃娃 (Wawa): Emerald green cat-ear aviator hood, reddish-brown hair tufts
        // Emerald hood
        ball(0.155, this.headgearMat, 0, 0.11, 0.01);
        // Pointed Cat Ears
        cyl(0.01, 0.042, 0.085, this.headgearMat, 0.08, 0.245, 0.02, 0, 0, -0.35);
        cyl(0.01, 0.042, 0.085, this.headgearMat, -0.08, 0.245, 0.02, 0, 0, 0.35);
        // Pink inner ear felt
        const innerEarMat = createToonMaterial({ color: 0xF5A6B8, rimStrength: 0.6 });
        cyl(0.005, 0.026, 0.065, innerEarMat, 0.08, 0.245, 0.038, 0.1, 0, -0.35);
        cyl(0.005, 0.026, 0.065, innerEarMat, -0.08, 0.245, 0.038, 0.1, 0, 0.35);

        // Fluffy reddish-brown hair fringe & side tufts
        ball(0.04, this.hairMat, 0.08, 0.08, 0.11);
        ball(0.04, this.hairMat, -0.08, 0.08, 0.11);
        ball(0.035, this.hairMat, 0, 0.15, 0.12);
        break;
      }
    }
  }

  private buildGoggles(head: THREE.Object3D, visual: PilotVisualConfig, profileId: string): void {
    const box = (w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): THREE.Mesh => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, rz);
      head.add(m);
      return m;
    };
    const cyl = (rt: number, rb: number, h: number, mat: THREE.Material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, segs = 16): THREE.Mesh => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, segs), mat);
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, rz);
      head.add(m);
      return m;
    };

    switch (visual.gogglesType) {
      case 'brass_pilot': {
        // 苏轼 (Su Shi) & 飞行员: Forehead twin brass pilot goggles with sky-blue lenses & leather strap
        // Leather head strap
        box(0.26, 0.032, 0.26, this.inkMat, 0, 0.155, 0.01);
        // Brass goggle frames & barrels
        cyl(0.044, 0.044, 0.035, this.gogglesMat, 0.058, 0.165, 0.125, Math.PI / 2, 0, 0.14);
        cyl(0.044, 0.044, 0.035, this.gogglesMat, -0.058, 0.165, 0.125, Math.PI / 2, 0, -0.14);
        // Sky-blue glass lenses
        cyl(0.035, 0.035, 0.038, this.lensMat, 0.058, 0.165, 0.125, Math.PI / 2, 0, 0.14);
        cyl(0.035, 0.035, 0.038, this.lensMat, -0.058, 0.165, 0.125, Math.PI / 2, 0, -0.14);
        // Central brass bridge & rivets
        box(0.045, 0.02, 0.022, this.gogglesMat, 0, 0.165, 0.14);
        break;
      }
      case 'gold_thin': {
        // 清照 (Qingzhao): Delicate gold-wire spectacles on nose bridge + aviator goggles on cap
        // Gold spectacles on nose
        box(0.068, 0.048, 0.012, this.gogglesMat, 0.048, 0.095, 0.152, 0, 0.08, 0);
        box(0.068, 0.048, 0.012, this.gogglesMat, -0.048, 0.095, 0.152, 0, -0.08, 0);
        box(0.056, 0.038, 0.016, this.lensMat, 0.048, 0.095, 0.152, 0, 0.08, 0);
        box(0.056, 0.038, 0.016, this.lensMat, -0.048, 0.095, 0.152, 0, -0.08, 0);
        box(0.035, 0.01, 0.01, this.gogglesMat, 0, 0.095, 0.155);

        // Aviator goggles perched on top of helmet
        cyl(0.040, 0.040, 0.030, this.gogglesMat, 0.052, 0.18, 0.08, Math.PI / 2.5, 0, 0.12);
        cyl(0.040, 0.040, 0.030, this.gogglesMat, -0.052, 0.18, 0.08, Math.PI / 2.5, 0, -0.12);
        cyl(0.032, 0.032, 0.034, this.lensMat, 0.052, 0.18, 0.08, Math.PI / 2.5, 0, 0.12);
        cyl(0.032, 0.032, 0.034, this.lensMat, -0.052, 0.18, 0.08, Math.PI / 2.5, 0, -0.12);
        break;
      }
      case 'leather_brow': {
        // 萧峰 (Xiao Feng): Leather browband with golden dragon plate (already in headgear)
        break;
      }
      case 'brass_monocle': {
        // 舟伯通 (Zhou Botong): Monocle wind gauge over right eye with gear rim & brass chain
        cyl(0.044, 0.044, 0.026, this.gogglesMat, 0.052, 0.098, 0.145, Math.PI / 2, 0, 0);
        cyl(0.036, 0.036, 0.030, this.lensMat, 0.052, 0.098, 0.145, Math.PI / 2, 0, 0);
        // Brass monocle chain
        cyl(0.005, 0.005, 0.14, this.gogglesMat, 0.085, 0.03, 0.12, 0.35, 0, -0.4);
        break;
      }
      case 'silver_scholar': {
        // 孔明 (Kongming): Elegant silver spectacles with crystal lenses
        box(0.068, 0.048, 0.012, this.gogglesMat, 0.048, 0.095, 0.152, 0, 0.08, 0);
        box(0.068, 0.048, 0.012, this.gogglesMat, -0.048, 0.095, 0.152, 0, -0.08, 0);
        box(0.056, 0.038, 0.016, this.lensMat, 0.048, 0.095, 0.152, 0, 0.08, 0);
        box(0.056, 0.038, 0.016, this.lensMat, -0.048, 0.095, 0.152, 0, -0.08, 0);
        box(0.035, 0.01, 0.01, this.gogglesMat, 0, 0.095, 0.155);
        break;
      }
      case 'brass_round': {
        // 娃娃 (Wawa): Big cute round brass goggles on hood brow
        box(0.26, 0.03, 0.26, this.inkMat, 0, 0.14, 0.01);
        cyl(0.046, 0.046, 0.030, this.gogglesMat, 0.058, 0.14, 0.138, Math.PI / 2, 0, 0.12);
        cyl(0.046, 0.046, 0.030, this.gogglesMat, -0.058, 0.14, 0.138, Math.PI / 2, 0, -0.12);
        cyl(0.038, 0.038, 0.034, this.lensMat, 0.058, 0.14, 0.138, Math.PI / 2, 0, 0.12);
        cyl(0.038, 0.038, 0.034, this.lensMat, -0.058, 0.14, 0.138, Math.PI / 2, 0, -0.12);
        box(0.045, 0.02, 0.02, this.gogglesMat, 0, 0.14, 0.15);
        break;
      }
    }
  }

  private buildDynamicCloth(visual: PilotVisualConfig): void {
    const createRibbon = (lateralOffset: number, targetLen: number, wStart: number, wEnd: number): DynamicClothRibbon => {
      const nodes: ClothNode[] = [];
      const nodeStep = targetLen / CLOTH_SEGS;

      for (let i = 0; i < NUM_CLOTH_NODES; i++) {
        // Initialize nodes extending softly behind the pilot
        nodes.push({
          pos: new THREE.Vector3(lateralOffset, -i * 0.06, -i * nodeStep),
          vel: new THREE.Vector3(0, 0, 0),
        });
      }

      // Generate dynamic quad strip geometry (2 vertices per node)
      const numVerts = NUM_CLOTH_NODES * 2;
      const positions = new Float32Array(numVerts * 3);
      const normals = new Float32Array(numVerts * 3);
      const uvs = new Float32Array(numVerts * 2);
      const indices: number[] = [];

      for (let i = 0; i < CLOTH_SEGS; i++) {
        const a = i * 2;
        const b = i * 2 + 1;
        const c = (i + 1) * 2;
        const d = (i + 1) * 2 + 1;
        // Two-sided triangles
        indices.push(a, b, c);
        indices.push(b, d, c);
        indices.push(a, c, b);
        indices.push(b, c, d);
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
      geo.setIndex(indices);

      const mesh = new THREE.Mesh(geo, this.capeMat);
      mesh.frustumCulled = false;
      this.scarfAnchor.add(mesh);

      return {
        nodes,
        geo,
        mesh,
        targetLen: nodeStep,
        widthStart: wStart,
        widthEnd: wEnd,
        lateralOffset,
      };
    };

    switch (visual.capeType) {
      case 'twin_scarf': {
        // 苏轼 (Su Shi): Twin flowing white scarves
        this.ribbons.push(createRibbon(0.08, 0.96, 0.085, 0.06));
        this.ribbons.push(createRibbon(-0.08, 0.96, 0.085, 0.06));
        break;
      }
      case 'silk_ribbon': {
        // 清照 (Qingzhao): Flowing light-cyan silk ribbons
        this.ribbons.push(createRibbon(0.065, 0.88, 0.055, 0.038));
        this.ribbons.push(createRibbon(-0.065, 0.88, 0.055, 0.038));
        break;
      }
      case 'hero_cape': {
        // 萧峰 (Xiao Feng): Broad billowing crimson warrior cape (3-section rolling folds)
        this.ribbons.push(createRibbon(0.13, 1.18, 0.17, 0.24));
        this.ribbons.push(createRibbon(0.0, 1.22, 0.19, 0.27));
        this.ribbons.push(createRibbon(-0.13, 1.18, 0.17, 0.24));
        break;
      }
      case 'storm_cloak': {
        // 舟伯通 (Zhou Botong): Heavy weather storm cloak
        this.ribbons.push(createRibbon(0.10, 1.06, 0.16, 0.20));
        this.ribbons.push(createRibbon(-0.10, 1.06, 0.16, 0.20));
        break;
      }
      case 'scholar_mantle': {
        // 孔明 (Kongming): Scholar duster mantle
        this.ribbons.push(createRibbon(0.09, 1.12, 0.15, 0.18));
        this.ribbons.push(createRibbon(-0.09, 1.12, 0.15, 0.18));
        break;
      }
      case 'furin_cloak': {
        // 娃娃 (Wawa): Emerald hooded cape
        this.ribbons.push(createRibbon(0.075, 0.90, 0.13, 0.16));
        this.ribbons.push(createRibbon(-0.075, 0.90, 0.13, 0.16));
        break;
      }
    }
  }



  /**
   * Main per-frame update at fixed 1/60s sim step.
   * Solves pilot body kinematics & dynamic flowing cloth physics with 0 allocations.
   */
  update(dt: number, boat: BoatState, t: number, celebrating: boolean): void {
    const T = TUNING;
    const j = this.j;

    // -------------------------------------------------- Kinematic Targets ----
    // 1. Bank Leaning
    const rawG = boat.lateralG / T.leanGRef;
    const leanT = T.leanSign * clamp(rawG, -1.2, 1.2) * T.leanMax;

    // 2. Weight shift & Aerodynamic Dive / Climb Postures
    const pitchT = clamp(-boat.longG * T.pitchPerG, -T.pitchMax, T.pitchMax);

    // Dynamic extraction of pitch angle and forward speed
    const q = boat.quaternion;
    this.tmpVec.set(0, 0, 1).applyQuaternion(q);
    const boatPitch = Math.asin(clamp(this.tmpVec.y, -1, 1));
    this.tmpVec.set(1, 0, 0).applyQuaternion(q);
    const boatRoll = Math.asin(clamp(this.tmpVec.y, -1, 1));

    // High speed forward dive tuck (W / dive)
    const diveTarget = boatPitch < -0.06
      ? clamp(-boatPitch * 1.6 + (boat.speed > 26 ? (boat.speed - 26) / 28 * 0.35 : 0), 0, T.diveTuckMax)
      : 0;

    // Steep climb arch (S / pull back)
    const climbTarget = boatPitch > 0.08 ? clamp(boatPitch * 1.4, 0, T.climbArchMax) : 0;

    const driftT = boat.drifting ? T.driftSign * boat.steer * T.driftTwist : 0;
    const airT = boat.airborne ? 1 : 0;
    const flightT = boat.flightPhase !== 'surface' ? 1 : 0;
    const celT = celebrating ? 1 : 0;

    const lean = this.leanS.update(leanT, T.leanOmega, T.leanZeta, dt);
    const pitch = this.pitchS.update(pitchT, T.pitchOmega, T.pitchZeta, dt);
    const dive = this.diveS.update(diveTarget, T.pitchOmega, T.pitchZeta, dt);
    const climb = this.climbS.update(climbTarget, T.pitchOmega, T.pitchZeta, dt);
    const drift = this.driftS.update(driftT, T.driftOmega, T.driftZeta, dt);
    const air = this.airS.update(airT, T.airOmega, T.airZeta, dt);
    const flight = this.flightS.update(flightT, T.flightOmega, T.flightZeta, dt);
    const cel = this.celS.update(celT, T.celOmega, T.celZeta, dt);

    // Landing crouch
    if (boat.landImpulse > 0) this.crouchS.v += boat.landImpulse * T.landKick;
    const crouch = clamp(this.crouchS.update(0, T.landOmega, T.landZeta, dt), -0.3, T.landMax);

    // Idle weight: 1 at standstill, 0 at racing speed
    const idleW = 1 - clamp(boat.speed / T.lockSpeed, 0, 1);

    // Secondary motion
    const lagP = boatPitch - this.boatPitchS.update(boatPitch, T.followOmega, T.followZeta, dt);
    const lagR = boatRoll - this.boatRollS.update(boatRoll, T.followOmega, T.followZeta, dt);
    const secP = clamp(lagP * T.followGain, -T.followMax, T.followMax) * idleW;
    const secR = clamp(lagR * T.followGain, -T.followMax, T.followMax) * idleW;

    // Breathing & micro-vibrations
    const breath = Math.sin(t * 2 * Math.PI * T.breathHz) * T.breathAmp * idleW;
    const bob = Math.sin(t * 2 * Math.PI * T.breathHz + 0.6) * T.breathBob * idleW;
    const vib = (Math.sin(t * T.vibF1) + Math.sin(t * T.vibF2)) * 0.5 * T.vibAmp * boat.rpm;

    const drive = 1 - cel * 0.85;

    // ---------------------------------------------------- Composite Poses ----
    // Hips: bank roll, drift twist, crouch drop
    j.hips.rotation.set(
      -air * 0.06 + flight * 0.04 - cel * 0.1 - dive * 0.15 + climb * 0.1,
      drift * drive,
      lean * T.leanHips * drive + secR * 0.45,
    );
    j.hips.position.y = this.hipsBaseY - crouch * T.landHipsDrop + bob - dive * 0.05;

    // Spine & Chest: Aerodynamic Streamline Tuck in Dives / Pull-back in Climbs
    j.spine.rotation.set(
      POSE.hunchSpine + pitch + breath + secP + crouch * T.landSpine + dive * 0.45 - climb * 0.32 - cel * T.celUpright,
      0,
      lean * T.leanSpine * drive,
    );
    j.chest.rotation.set(
      POSE.hunchChest + pitch * 0.4 + secP * 0.5 + dive * 0.30 - climb * 0.22 - cel * T.celUpright * 0.4,
      drift * 0.3 * drive,
      lean * T.leanChest * drive,
    );

    // Head: Counter-lean horizon lock, gaze forward in dives, lookup in climbs
    j.head.rotation.set(
      POSE.headTiltUp - pitch * 0.5 - dive * 0.42 - climb * 0.28 + cel * Math.sin(t * 2 * Math.PI * T.celNodHz) * T.celNodAmp,
      0,
      -lean * T.headCounter * drive - secR * 0.35,
    );

    // Seated Legs in Footwells
    const flareL = Math.max(0, -lean) / T.leanMax * T.kneeFlare * drive;
    const flareR = Math.max(0, lean) / T.leanMax * T.kneeFlare * drive;
    j.hipL.rotation.set(crouch * 0.35 + dive * 0.1, 0, flareL);
    j.hipR.rotation.set(crouch * 0.35 + dive * 0.1, 0, -flareR);
    j.kneeL.rotation.set(-crouch * T.landKnee - dive * 0.12, 0, 0);
    j.kneeR.rotation.set(-crouch * T.landKnee - dive * 0.12, 0, 0);

    // Arms: gripping yoke controls, tucking in on dive, pulling back on climb
    const brace = (1 - idleW) * drive;
    const dropL = Math.max(0, lean) / T.leanMax * T.elbowDrop * drive;
    const dropR = Math.max(0, -lean) / T.leanMax * T.elbowDrop * drive;
    const armBase = -brace * T.braceShoulder + vib + dive * 0.22 - climb * 0.18;
    const elbBase = brace * T.braceElbow + vib * 1.2 + dive * 0.28 + climb * 0.14;

    // Victory celebration pump
    const pumpT = t * 2 * Math.PI * T.pumpHz;
    const pumpR = T.pumpRaise + Math.sin(pumpT) * T.pumpAmp;
    const gateL = Math.pow(Math.max(0, Math.sin(pumpT - T.celLeftLag)), 1.5);
    const pumpL = T.celLeftRaise * gateL;

    j.shoulderL.rotation.set(armBase * (1 - cel) + cel * pumpL, 0, -T.armTuck * (1 - cel) - 0.1 * cel);
    j.shoulderR.rotation.set(armBase * (1 - cel) + cel * pumpR, 0, T.armTuck * (1 - cel) + 0.1 * cel);
    j.elbowL.rotation.set(elbBase + dropL, 0, 0);
    j.elbowR.rotation.set(elbBase + dropR + cel * (Math.sin(pumpT) * 0.3 - 0.3), 0, 0);

    // Hands on Cockpit Levers
    const thr = clamp(boat.throttle, 0, 1);
    j.handR.rotation.set(-thr * T.throttleWrist * (1 - cel) - climb * 0.2, 0, 0);
    j.handL.rotation.set(vib * 0.5 - climb * 0.2, 0, 0);

    // ------------------------------------ Dynamic Scarf / Cape Physics ----
    this.updateDynamicCloth(dt, boat, t);
  }

  private updateDynamicCloth(dt: number, boat: BoatState, t: number): void {
    const speed = Math.max(0, boat.speed);
    const speedFrac = clamp(speed / 36, 0, 1.5);

    // Relative Airflow in Scarf Anchor space
    // Glider airspeed pushes cloth directly backward into -Z
    const windSpeedZ = -Math.max(3.0, speed * 1.15);
    // Vertical climb/dive airflow
    const windSpeedY = -boat.longG * 0.12 - boatPitchAngle(boat) * speed * 0.35;
    // Centrifugal turn drift
    const windSpeedX = -boat.lateralG * 0.22;

    // Ghibli Traveling Harmonic Wave Parameters
    const waveFreq = 2.4 + speedFrac * 6.5;
    const waveAmpY = (0.035 + speedFrac * 0.14);
    const waveAmpX = (0.025 + speedFrac * 0.08);

    const gravY = -5.5 * (1 - clamp(speed / 28, 0, 0.88));

    for (let r = 0; r < this.ribbons.length; r++) {
      const ribbon = this.ribbons[r];
      const nodes = ribbon.nodes;
      const targetLen = ribbon.targetLen;

      // Node 0 fixed at root
      nodes[0].pos.set(ribbon.lateralOffset, 0, 0);
      nodes[0].vel.set(0, 0, 0);

      // Solve Node Physics
      for (let i = 1; i < NUM_CLOTH_NODES; i++) {
        const node = nodes[i];
        const frac = i / CLOTH_SEGS;

        // Wave phase along chain
        const wavePhase = t * waveFreq - frac * Math.PI * 2.8 + r * 0.8;
        const waveY = Math.sin(wavePhase) * waveAmpY * frac;
        const waveX = Math.cos(wavePhase * 0.75 + 0.5) * waveAmpX * frac;

        // Target aerodynamic slipstream force
        const forceX = (windSpeedX + waveX * 18 - node.vel.x * 4.5);
        const forceY = (windSpeedY + gravY + waveY * 20 - node.vel.y * 5.0);
        const forceZ = (windSpeedZ - node.vel.z * 5.5);

        // Integrate
        node.vel.x += forceX * dt;
        node.vel.y += forceY * dt;
        node.vel.z += forceZ * dt;

        node.pos.x += node.vel.x * dt;
        node.pos.y += node.vel.y * dt;
        node.pos.z += node.vel.z * dt;

        // Air damping
        node.vel.multiplyScalar(0.91);
      }

      // Distance Constraint Relaxation (3 iterations)
      for (let iter = 0; iter < 3; iter++) {
        for (let i = 0; i < CLOTH_SEGS; i++) {
          const n0 = nodes[i];
          const n1 = nodes[i + 1];

          this.tmpVec.subVectors(n1.pos, n0.pos);
          const dist = this.tmpVec.length();
          if (dist > 0.0001) {
            const diff = (dist - targetLen) / dist;
            if (i === 0) {
              n1.pos.sub(this.tmpVec.multiplyScalar(diff));
            } else {
              this.tmpVec.multiplyScalar(diff * 0.5);
              n0.pos.add(this.tmpVec);
              n1.pos.sub(this.tmpVec);
            }
          }
        }
      }

      // Update Dynamic Mesh Geometry
      const posAttr = ribbon.geo.attributes.position as THREE.BufferAttribute;
      const positions = posAttr.array as Float32Array;

      for (let i = 0; i < NUM_CLOTH_NODES; i++) {
        const node = nodes[i];
        const frac = i / CLOTH_SEGS;
        const halfW = (ribbon.widthStart * (1 - frac) + ribbon.widthEnd * frac) * 0.5;

        // Forward tangent
        if (i < CLOTH_SEGS) {
          this.tmpVec.subVectors(nodes[i + 1].pos, node.pos).normalize();
        } else {
          this.tmpVec.subVectors(node.pos, nodes[i - 1].pos).normalize();
        }

        // Side vector orthogonal to tangent and up
        this.tmpVec2.crossVectors(this.tmpVec, UP).normalize();
        if (this.tmpVec2.lengthSq() < 0.01) this.tmpVec2.set(1, 0, 0);

        const vIdx = i * 2;
        // Left vertex
        positions[vIdx * 3] = node.pos.x + this.tmpVec2.x * halfW;
        positions[vIdx * 3 + 1] = node.pos.y + this.tmpVec2.y * halfW;
        positions[vIdx * 3 + 2] = node.pos.z + this.tmpVec2.z * halfW;

        // Right vertex
        positions[(vIdx + 1) * 3] = node.pos.x - this.tmpVec2.x * halfW;
        positions[(vIdx + 1) * 3 + 1] = node.pos.y - this.tmpVec2.y * halfW;
        positions[(vIdx + 1) * 3 + 2] = node.pos.z - this.tmpVec2.z * halfW;
      }

      posAttr.needsUpdate = true;
      ribbon.geo.computeVertexNormals();
    }
  }
}

function boatPitchAngle(boat: BoatState): number {
  const q = boat.quaternion;
  const fwdY = 2 * (q.y * q.z + q.w * q.x);
  return Math.asin(clamp(fwdY, -1, 1));
}
