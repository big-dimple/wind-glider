/**
 * chaseCamera.ts — camera rig: countdown orbit, spring chase cam, results hero orbit.
 *
 * The chase cam is deliberately NOT a rigid stick: a damped spring drags the
 * camera toward a rest pose behind the boat, the rest distance breathes with
 * longitudinal G (hangs back under throttle, tucks in under braking), the FOV
 * stretches with speed and kicks under boost, and shake() injects decaying
 * positional noise. The horizon stays stable — the camera only yaws with the
 * boat, plus a tiny roll into turns proportional to lateralG.
 *
 * Mode switches blend position + lookAt + FOV over ~0.8s.
 * Zero per-frame allocation: every scratch vector is a reused field.
 * dt is the fixed sim step (1/60).
 */
import * as THREE from 'three';
import type { IBoat, CameraMode } from '../contracts';
import { waterHeight } from '../water/waves';
import { BASE_FOV } from '../core/stage';

// ---- chase tuning -----------------------------------------------------------
const V_MAX = 34; // speed (m/s) that maps to max FOV
const MAX_FOV = 74; // FOV at V_MAX
const BOOST_FOV = 7; // the old Space payout now opens a visible speed tunnel
const FLIGHT_FOV = [78, 80, 82] as const;
const FOV_HARD_MAX = 86;
const FOV_RATE = 6; // /s base FOV smoothing
const BOOST_IN = 14; // /s boost FOV attack (fast in)
const BOOST_OUT = 1.8; // /s boost FOV release (slow out)
const CHASE_BACK = 9.5; // rest distance behind the boat (m)
const CHASE_UP = 3.6; // rest height above the boat (m)
const CHASE_MIN_DIST = 6.5; // hard floor for the brake tuck-in (m)
const LOOK_AHEAD = 4; // look-at point this far past the bow (m)
const SPRING_K = 58; // follow-spring stiffness
const SPRING_DAMP = 11; // slightly under critical (2*sqrt(K) ≈ 15.2)
const FLIGHT_SPRING_K = 32; // slower vertical follow makes the lift readable
const FLIGHT_SPRING_DAMP = 9;
const FLIGHT_CAMERA_DROP = 0.85; // reveal the lift emitters without losing the horizon
const FLIGHT_LOOK_GAIN = 0.52;
const FLIGHT_BLEND_RATE = 6;
const ACCEL_LAG = 0.24; // extra hang-back meters per m/s² of longG
const ACCEL_LAG_MAX = 2.2;
const ACCEL_LAG_RATE = 4; // /s smoothing on the lag term
const ROLL_PER_G = 0.008; // rad of camera roll per m/s² lateralG
const ROLL_MAX = 0.061; // ≈ 3.5°
const ROLL_RATE = 7; // /s roll smoothing
const LOOK_RATE = 12; // /s look-at smoothing (chase)
const ORBIT_RATE = 2.6; // /s position smoothing (orbit/results)
const ORBIT_LOOK_RATE = 5; // /s look-at smoothing (orbit/results)
const WATER_CLEARANCE = 0.6; // camera never closer than this to the waves (m)

// ---- orbit / results tuning ---------------------------------------------------
const ORBIT_RADIUS = 14;
const ORBIT_HEIGHT = 5;
const ORBIT_OMEGA = (Math.PI * 2) / 12; // ~12 s/rev
const ORBIT_BOB = 0.5; // gentle vertical bob amplitude (m)
const RESULTS_RADIUS = 8;
const RESULTS_HEIGHT = 2.2;
const RESULTS_OMEGA = (Math.PI * 2) / 10;
const RESULTS_DUTCH = 0.14; // ≈ 8° dutch angle

const BLEND_TIME = 0.8; // mode-switch blend duration (s)
const SHAKE_AMP = 0.35; // meters of positional noise at strength 1
const SHAKE_W = 88; // ≈ 14 Hz in rad/s
const SHAKE_DECAY = 5; // /s exponential decay

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export class CameraRig {
  mode: CameraMode = 'orbit';

  private readonly camera: THREE.PerspectiveCamera;
  private readonly reducedMotion: boolean;
  private activeMode: CameraMode = 'orbit';
  private initialized = false;

  // live follow state
  private readonly pos = new THREE.Vector3();
  private readonly vel = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private fov = BASE_FOV;
  private boostFov = 0;
  private roll = 0;
  private accelLag = 0;
  private flightBlend = 0;
  private flightWasActive = false;
  private boostWasActive = false;
  private driftBlend = 0;
  private impactFov = 0;
  private impactBack = 0;
  private impactDip = 0;
  private shakeAmp = 0;
  private noiseT = 0;

  // mode-blend snapshot
  private blendT = 1;
  private readonly blendPos = new THREE.Vector3();
  private readonly blendLook = new THREE.Vector3();
  private blendFov = BASE_FOV;

  // scratch (reused every frame)
  private readonly target = new THREE.Vector3();
  private readonly targetLook = new THREE.Vector3();
  private readonly helm = new THREE.Vector3();
  private readonly finalPos = new THREE.Vector3();
  private readonly finalLook = new THREE.Vector3();

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /** Additive 0..1 shake impulse; decays exponentially at ~5/s. */
  shake(strength: number): void {
    if (this.reducedMotion) return;
    this.shakeAmp = Math.min(1, this.shakeAmp + clamp(strength, 0, 1));
  }

  flightGateKick(flightNumber = 1): void {
    if (this.reducedMotion) return;
    const final = flightNumber >= 3;
    this.shake(final ? 0.2 : 0.1);
    this.impactFov = Math.max(this.impactFov, final ? 2.2 : 0.9);
    this.impactBack = Math.max(this.impactBack, final ? 0.4 : 0.18);
  }

  routeMissKick(): void {
    if (this.reducedMotion) return;
    this.shake(0.48);
    this.impactFov = Math.min(this.impactFov, -2.2);
    this.impactBack = Math.min(this.impactBack, -0.45);
  }

  flightReadyKick(): void {
    if (this.reducedMotion) return;
    this.shake(0.18);
    this.impactFov = Math.max(this.impactFov, 3.2);
  }

  flightExtendKick(): void {
    if (this.reducedMotion) return;
    this.shake(0.12);
    this.impactFov = Math.max(this.impactFov, 1.8);
    this.impactBack = Math.max(this.impactBack, 0.28);
  }

  defeatKick(): void {
    if (this.reducedMotion) return;
    this.shake(1);
    this.impactFov = Math.min(this.impactFov, -7);
    this.impactBack = Math.min(this.impactBack, -1.8);
  }

  finishKick(): void {
    if (this.reducedMotion) return;
    this.shake(0.72);
    this.impactFov = Math.max(this.impactFov, 9);
    this.impactBack = Math.max(this.impactBack, 2.2);
  }

  raceBattleKick(kind: 'overtake' | 'lost', count: number): void {
    if (this.reducedMotion) return;
    if (kind === 'overtake') {
      this.shake(Math.min(0.42, 0.34 + Math.max(0, count - 1) * 0.08));
      this.impactFov = Math.max(this.impactFov, Math.min(7, 5.5 + Math.max(0, count - 1) * 1.5));
      this.impactBack = Math.max(this.impactBack, Math.min(1.8, 1.4 + Math.max(0, count - 1) * 0.4));
    } else {
      this.shake(0.11);
      this.impactFov = Math.min(this.impactFov, -1.6);
      this.impactBack = Math.min(this.impactBack, -0.3);
    }
  }

  collisionKick(strength: number): void {
    if (this.reducedMotion) return;
    const n = clamp(strength / 16, 0.08, 1);
    this.shake(0.08 + n * 0.26);
    this.impactFov = Math.min(this.impactFov, -0.7 - n * 1.6);
    this.impactBack = Math.min(this.impactBack, -0.12 - n * 0.32);
  }

  /** Freeze the desktop READY stage on one authored orbit pose. */
  snapOrbit(boat: IBoat, t: number): void {
    const st = boat.state;
    boat.riderMount.getWorldPosition(this.helm);
    const a = t * ORBIT_OMEGA + 0.8;
    const bob = Math.sin(t * 0.8) * ORBIT_BOB;
    this.mode = 'orbit';
    this.activeMode = 'orbit';
    this.initialized = true;
    this.pos.set(
      st.position.x + Math.cos(a) * ORBIT_RADIUS,
      st.position.y + ORBIT_HEIGHT + bob,
      st.position.z + Math.sin(a) * ORBIT_RADIUS,
    );
    this.look.copy(this.helm);
    this.vel.set(0, 0, 0);
    this.fov = BASE_FOV - 3;
    this.roll = 0;
    this.shakeAmp = 0;
    this.blendT = 1;
    this.camera.position.copy(this.pos);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.look);
    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();
  }

  update(dt: number, boat: IBoat, t: number): void {
    const st = boat.state;
    const bx = st.position.x;
    const by = st.position.y;
    const bz = st.position.z;
    // boat yaw frame (horizon-stable: yaw only, never pitch/roll of the hull)
    const fx = Math.sin(st.heading);
    const fz = Math.cos(st.heading);
    this.impactFov *= Math.exp(-7.5 * dt);
    this.impactBack *= Math.exp(-9 * dt);
    this.impactDip *= Math.exp(-8 * dt);

    // ---- mode switch: snapshot current state, restart the 0.8s blend ---------
    if (this.mode !== this.activeMode) {
      this.activeMode = this.mode;
      this.blendT = 0;
      this.blendPos.copy(this.pos);
      this.blendLook.copy(this.look);
      this.blendFov = this.fov;
    }

    // ---- per-mode targets -----------------------------------------------------
    const target = this.target;
    const look = this.targetLook;
    let fovTarget = BASE_FOV;
    let rollTarget = 0;

    if (this.activeMode === 'chase') {
      const flightActive = st.flightPhase !== 'surface';
      if (!this.reducedMotion && flightActive && !this.flightWasActive) {
        const index = clamp(st.flightRouteIndex >= 0 ? st.flightRouteIndex : st.flightsCleared, 0, 2);
        this.shake([0.22, 0.28, 0.34][index]);
        this.impactFov = Math.max(this.impactFov, [4, 5, 6][index]);
        this.impactBack = Math.max(this.impactBack, [0.55, 0.75, 0.95][index]);
        this.impactDip = [0.3, 0.4, 0.5][index];
      }
      if (!this.reducedMotion && !flightActive && this.flightWasActive) this.shake(0.06);
      this.flightWasActive = flightActive;
      this.flightBlend += ((flightActive ? 1 : 0) - this.flightBlend)
        * (1 - Math.exp(-FLIGHT_BLEND_RATE * dt));
      const driftTarget = !this.reducedMotion && st.drifting ? 1 : 0;
      this.driftBlend += (driftTarget - this.driftBlend) * (1 - Math.exp(-10 * dt));

      // accel lag: hang back under throttle, tuck in under braking
      const lagT = clamp(st.longG * ACCEL_LAG, -ACCEL_LAG_MAX, ACCEL_LAG_MAX);
      this.accelLag += (lagT - this.accelLag) * (1 - Math.exp(-ACCEL_LAG_RATE * dt));
      if (!this.reducedMotion && st.boosting && !this.boostWasActive) {
        this.shake(0.48);
        this.impactFov = Math.max(this.impactFov, 6.5);
        this.impactBack = Math.max(this.impactBack, 1.65);
      }
      this.boostWasActive = st.boosting;
      const dist = Math.max(
        CHASE_MIN_DIST,
        CHASE_BACK + this.accelLag + this.impactBack + st.flightPressure * 0.45 - st.flightAirBrake * 0.65,
      );
      const driftSide = st.steer * this.driftBlend * 0.65;
      target.set(
        bx - fx * dist + fz * driftSide,
        by + CHASE_UP - this.flightBlend * FLIGHT_CAMERA_DROP - this.impactDip,
        bz - fz * dist - fx * driftSide,
      );

      // look ~4m ahead of the bow, at water height
      const ax = bx + fx * LOOK_AHEAD;
      const az = bz + fz * LOOK_AHEAD;
      look.set(
        ax,
        waterHeight(ax, az, t) + Math.max(0, st.flightClearance) * this.flightBlend * FLIGHT_LOOK_GAIN,
        az,
      );

      // FOV: speed stretch + boost kick (fast in, slow out)
      const speedN = clamp(st.speed / V_MAX, 0, 1);
      const boostVisual = st.boosting && !flightActive;
      const bRate = boostVisual ? BOOST_IN : BOOST_OUT;
      this.boostFov += ((boostVisual ? BOOST_FOV : 0) - this.boostFov) * (1 - Math.exp(-bRate * dt));
      const surfaceFov = BASE_FOV + (MAX_FOV - BASE_FOV) * speedN + this.boostFov;
      const flightIndex = clamp(st.flightRouteIndex >= 0 ? st.flightRouteIndex : st.flightsCleared, 0, 2);
      const sustainedFlightFov = FLIGHT_FOV[flightIndex];
      fovTarget = clamp(
        surfaceFov + (sustainedFlightFov - surfaceFov) * this.flightBlend + this.impactFov,
        BASE_FOV - 8,
        FOV_HARD_MAX,
      );

      // tiny roll into turns, proportional to lateralG
      const driftRoll = 1 + this.driftBlend * 0.55;
      rollTarget = this.reducedMotion
        ? 0
        : clamp(
            st.lateralG * ROLL_PER_G * (driftRoll + st.flightAirBrake * 0.55),
            -ROLL_MAX * (driftRoll + st.flightAirBrake * 0.8),
            ROLL_MAX * (driftRoll + st.flightAirBrake * 0.8),
          );
    } else {
      // cinematic orbits around the helm
      boat.riderMount.getWorldPosition(this.helm);
      look.copy(this.helm);
      const isOrbit = this.activeMode === 'orbit';
      const isDefeat = this.activeMode === 'defeat';
      const omega = isOrbit ? ORBIT_OMEGA : isDefeat ? -RESULTS_OMEGA * 0.72 : RESULTS_OMEGA;
      const radius = isOrbit ? ORBIT_RADIUS : isDefeat ? 6.4 : RESULTS_RADIUS;
      const height = isOrbit ? ORBIT_HEIGHT : isDefeat ? 1.35 : RESULTS_HEIGHT;
      const a = t * omega + 0.8;
      const bob = isOrbit ? Math.sin(t * 0.8) * ORBIT_BOB : 0;
      target.set(bx + Math.cos(a) * radius, by + height + bob, bz + Math.sin(a) * radius);
      rollTarget = isOrbit ? 0 : isDefeat ? -0.22 : RESULTS_DUTCH;
      fovTarget = isDefeat ? BASE_FOV - 8 : BASE_FOV - 3;
    }
    this.roll += (rollTarget - this.roll) * (1 - Math.exp(-ROLL_RATE * dt));

    // ---- first frame: settle on target, sweep in from the staged camera ------
    if (!this.initialized) {
      this.initialized = true;
      this.pos.copy(target);
      this.vel.set(0, 0, 0);
      this.look.copy(look);
      this.fov = fovTarget;
      this.blendT = 0;
      this.blendPos.copy(this.camera.position);
      this.blendLook.set(bx, by + 1.5, bz);
      this.blendFov = this.camera.fov;
    }

    // ---- integrate ------------------------------------------------------------
    const p = this.pos;
    if (this.activeMode === 'chase') {
      // damped spring: a = (target - pos) * K - vel * D
      const v = this.vel;
      v.x += ((target.x - p.x) * SPRING_K - v.x * SPRING_DAMP) * dt;
      const yK = SPRING_K + (FLIGHT_SPRING_K - SPRING_K) * this.flightBlend;
      const yDamp = SPRING_DAMP + (FLIGHT_SPRING_DAMP - SPRING_DAMP) * this.flightBlend;
      v.y += ((target.y - p.y) * yK - v.y * yDamp) * dt;
      v.z += ((target.z - p.z) * SPRING_K - v.z * SPRING_DAMP) * dt;
      p.x += v.x * dt;
      p.y += v.y * dt;
      p.z += v.z * dt;
      const lk = 1 - Math.exp(-LOOK_RATE * dt);
      this.look.x += (look.x - this.look.x) * lk;
      this.look.y += (look.y - this.look.y) * lk;
      this.look.z += (look.z - this.look.z) * lk;
    } else {
      // lazy exponential drift for the cinematic modes
      const pk = 1 - Math.exp(-ORBIT_RATE * dt);
      p.x += (target.x - p.x) * pk;
      p.y += (target.y - p.y) * pk;
      p.z += (target.z - p.z) * pk;
      this.vel.set(0, 0, 0);
      const lk = 1 - Math.exp(-ORBIT_LOOK_RATE * dt);
      this.look.x += (look.x - this.look.x) * lk;
      this.look.y += (look.y - this.look.y) * lk;
      this.look.z += (look.z - this.look.z) * lk;
    }
    this.fov += (fovTarget - this.fov) * (1 - Math.exp(-FOV_RATE * dt));

    // ---- mode blend (position + lookAt + FOV) ----------------------------------
    let e = 1;
    if (this.blendT < 1) {
      this.blendT = Math.min(1, this.blendT + dt / BLEND_TIME);
      e = this.blendT * this.blendT * (3 - 2 * this.blendT); // smoothstep
    }
    const fp = this.finalPos;
    const fl = this.finalLook;
    fp.lerpVectors(this.blendPos, p, e);
    fl.lerpVectors(this.blendLook, this.look, e);
    const fov = clamp(this.blendFov + (this.fov - this.blendFov) * e, BASE_FOV - 8, FOV_HARD_MAX);

    // ---- shake: additive positional noise, applied post-spring -----------------
    this.noiseT += dt;
    this.shakeAmp *= Math.exp(-SHAKE_DECAY * dt);
    if (this.shakeAmp > 0.001) {
      const nt = this.noiseT;
      const a = this.shakeAmp * SHAKE_AMP;
      fp.x += (Math.sin(nt * SHAKE_W) * 0.62 + Math.sin(nt * SHAKE_W * 1.618 + 1.3) * 0.38) * a;
      fp.y += (Math.sin(nt * SHAKE_W * 1.13 + 2.1) * 0.62 + Math.sin(nt * SHAKE_W * 1.83 + 0.7) * 0.38) * a * 0.7;
      fp.z += (Math.sin(nt * SHAKE_W * 0.97 + 4.2) * 0.62 + Math.sin(nt * SHAKE_W * 1.42 + 2.9) * 0.38) * a;
    }

    // ---- never dip under the waves ----------------------------------------------
    const minY = waterHeight(fp.x, fp.z, t) + WATER_CLEARANCE;
    if (fp.y < minY) fp.y = minY;

    // ---- roll-aware up vector: roll about the view axis --------------------------
    let vx = fl.x - fp.x;
    let vy = fl.y - fp.y;
    let vz = fl.z - fp.z;
    const vlen = Math.hypot(vx, vy, vz) || 1;
    vx /= vlen;
    vy /= vlen;
    vz /= vlen;
    // view-perpendicular "left" in the XZ plane
    let px = vz;
    let pz = -vx;
    const plen = Math.hypot(px, pz) || 1;
    px /= plen;
    pz /= plen;
    const sr = Math.sin(this.roll);
    const cr = Math.cos(this.roll);

    const cam = this.camera;
    cam.position.copy(fp);
    cam.up.set(px * sr, cr, pz * sr);
    cam.lookAt(fl);
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  }
}
