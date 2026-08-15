import * as THREE from 'three';
import type { IBoat } from '../contracts';

const HALF_LENGTH = 1.62;
const RADIUS = 0.82;
const DIAMETER = RADIUS * 2;
const Y_SEPARATION = 1.45;
const RESTITUTION = 0.05;
const FRICTION = 0.11;
const MAX_PAIR_CORRECTION = 0.4;
const SAMPLE_OFFSETS = [-HALF_LENGTH, 0, HALF_LENGTH] as const;

export interface CollisionHit {
  a: number;
  b: number;
  strength: number;
  toi: number;
  correction: number;
}

interface PairContact {
  hit: boolean;
  toi: number;
  nx: number;
  nz: number;
  aOffset: number;
  bOffset: number;
}

const _va = new THREE.Vector2();
const _vb = new THREE.Vector2();

/** Swept three-disc hull capsules catch high-speed contacts at the fixed 60 Hz step. */
export class BoatCollisionSystem {
  private prevX = new Float32Array(0);
  private prevZ = new Float32Array(0);
  private prevHeading = new Float32Array(0);
  private readonly hits: CollisionHit[] = [];
  private readonly contact: PairContact = { hit: false, toi: 1, nx: 1, nz: 0, aOffset: 0, bOffset: 0 };
  private cooldowns = new Float32Array(0);
  private maxCorrection = 0;

  capture(boats: readonly IBoat[]): void {
    this.ensure(boats.length);
    for (const boat of boats) {
      this.prevX[boat.id] = boat.state.position.x;
      this.prevZ[boat.id] = boat.state.position.z;
      this.prevHeading[boat.id] = boat.state.heading;
    }
    for (let i = 0; i < this.cooldowns.length; i++) this.cooldowns[i] = Math.max(0, this.cooldowns[i] - 1 / 60);
  }

  reset(): void {
    this.hits.length = 0;
    this.cooldowns.fill(0);
    this.maxCorrection = 0;
  }

  resolve(boats: readonly IBoat[]): readonly CollisionHit[] {
    this.hits.length = 0;
    this.maxCorrection = 0;
    for (let a = 0; a < boats.length - 1; a++) {
      for (let b = a + 1; b < boats.length; b++) this.resolvePair(boats[a], boats[b]);
    }
    for (let pass = 0; pass < 2; pass++) {
      for (let a = 0; a < boats.length - 1; a++) {
        for (let b = a + 1; b < boats.length; b++) this.separateCurrent(boats[a], boats[b]);
      }
    }
    return this.hits;
  }

  debugState(): { collisions: number; maxCorrection: number } {
    return { collisions: this.hits.length, maxCorrection: this.maxCorrection };
  }

  private resolvePair(a: IBoat, b: IBoat): void {
    if (Math.abs(a.state.position.y - b.state.position.y) > Y_SEPARATION) return;
    const contact = this.findEarliestContact(a, b);
    if (!contact.hit) return;
    a.collisionVelocity(_va);
    b.collisionVelocity(_vb);
    const rvx = _va.x - _vb.x;
    const rvz = _va.y - _vb.y;
    const closing = -(rvx * contact.nx + rvz * contact.nz);
    const flightMul = a.state.flightPhase !== 'surface' || b.state.flightPhase !== 'surface' ? 0.68 : 1;
    const j = Math.max(0, closing) * (1 + RESTITUTION) * 0.5 * flightMul;
    const aAttack = Math.max(0, -(_va.x * contact.nx + _va.y * contact.nz)) * (a.state.boosting ? 1.28 : 1);
    const bAttack = Math.max(0, _vb.x * contact.nx + _vb.y * contact.nz) * (b.state.boosting ? 1.28 : 1);
    const aIsAttacker = aAttack > bAttack + 1.2;
    const bIsAttacker = bAttack > aAttack + 1.2;
    const aTake = aIsAttacker ? 0.42 : bIsAttacker ? 1.2 : 1;
    const bTake = bIsAttacker ? 0.42 : aIsAttacker ? 1.2 : 1;
    const tx = -contact.nz;
    const tz = contact.nx;
    const tangentRel = rvx * tx + rvz * tz;
    const frictionJ = Math.max(-j * FRICTION, Math.min(j * FRICTION, -tangentRel * 0.5));
    const distance = this.currentSampleDistance(a, b, contact.aOffset, contact.bOffset);
    const correction = Math.min(MAX_PAIR_CORRECTION, Math.max(0.04, (DIAMETER - distance) * 0.52));
    const cx = contact.nx * correction * 0.5;
    const cz = contact.nz * correction * 0.5;
    a.applyCollisionResponse(cx, cz, (contact.nx * j + tx * frictionJ) * aTake, (contact.nz * j + tz * frictionJ) * aTake);
    b.applyCollisionResponse(-cx, -cz, (-contact.nx * j - tx * frictionJ) * bTake, (-contact.nz * j - tz * frictionJ) * bTake);
    this.maxCorrection = Math.max(this.maxCorrection, correction);
    const pairKey = this.pairKey(a.id, b.id);
    if (this.cooldowns[pairKey] <= 0 && closing > 0.35) {
      this.hits.push({ a: a.id, b: b.id, strength: Math.max(0, closing) * Math.max(aTake, bTake), toi: contact.toi, correction });
      this.cooldowns[pairKey] = 0.32;
    }
  }

  private separateCurrent(a: IBoat, b: IBoat): void {
    if (Math.abs(a.state.position.y - b.state.position.y) > Y_SEPARATION) return;
    let best = Infinity;
    let nx = 1;
    let nz = 0;
    for (const ao of SAMPLE_OFFSETS) {
      const ax = a.state.position.x + Math.sin(a.state.heading) * ao;
      const az = a.state.position.z + Math.cos(a.state.heading) * ao;
      for (const bo of SAMPLE_OFFSETS) {
        const dx = ax - (b.state.position.x + Math.sin(b.state.heading) * bo);
        const dz = az - (b.state.position.z + Math.cos(b.state.heading) * bo);
        const d2 = dx * dx + dz * dz;
        if (d2 < best) {
          best = d2;
          const d = Math.sqrt(Math.max(d2, 1e-8));
          nx = d > 1e-4 ? dx / d : Math.cos((a.id * 2.39 + b.id) * 1.7);
          nz = d > 1e-4 ? dz / d : Math.sin((a.id * 2.39 + b.id) * 1.7);
        }
      }
    }
    const distance = Math.sqrt(best);
    if (distance >= DIAMETER) return;
    const correction = Math.min(0.18, (DIAMETER - distance) * 0.35);
    a.applyCollisionResponse(nx * correction * 0.5, nz * correction * 0.5, 0, 0);
    b.applyCollisionResponse(-nx * correction * 0.5, -nz * correction * 0.5, 0, 0);
    this.maxCorrection = Math.max(this.maxCorrection, correction);
  }

  private findEarliestContact(a: IBoat, b: IBoat): PairContact {
    const out = this.contact;
    out.hit = false;
    out.toi = 1;
    const afx0 = Math.sin(this.prevHeading[a.id]);
    const afz0 = Math.cos(this.prevHeading[a.id]);
    const bfx0 = Math.sin(this.prevHeading[b.id]);
    const bfz0 = Math.cos(this.prevHeading[b.id]);
    const afx1 = Math.sin(a.state.heading);
    const afz1 = Math.cos(a.state.heading);
    const bfx1 = Math.sin(b.state.heading);
    const bfz1 = Math.cos(b.state.heading);
    for (const ao of SAMPLE_OFFSETS) {
      const ax0 = this.prevX[a.id] + afx0 * ao;
      const az0 = this.prevZ[a.id] + afz0 * ao;
      const ax1 = a.state.position.x + afx1 * ao;
      const az1 = a.state.position.z + afz1 * ao;
      for (const bo of SAMPLE_OFFSETS) {
        const bx0 = this.prevX[b.id] + bfx0 * bo;
        const bz0 = this.prevZ[b.id] + bfz0 * bo;
        const bx1 = b.state.position.x + bfx1 * bo;
        const bz1 = b.state.position.z + bfz1 * bo;
        const rx = ax0 - bx0;
        const rz = az0 - bz0;
        const vx = (ax1 - ax0) - (bx1 - bx0);
        const vz = (az1 - az0) - (bz1 - bz0);
        const c = rx * rx + rz * rz - DIAMETER * DIAMETER;
        let toi = Infinity;
        if (c <= 0) toi = 0;
        else {
          const qa = vx * vx + vz * vz;
          const qb = 2 * (rx * vx + rz * vz);
          const disc = qb * qb - 4 * qa * c;
          if (qa > 1e-8 && qb < 0 && disc >= 0) toi = (-qb - Math.sqrt(disc)) / (2 * qa);
        }
        if (toi < 0 || toi > 1 || toi >= out.toi) continue;
        const nxRaw = rx + vx * toi;
        const nzRaw = rz + vz * toi;
        const length = Math.hypot(nxRaw, nzRaw);
        out.hit = true;
        out.toi = toi;
        out.nx = length > 1e-4 ? nxRaw / length : Math.cos((a.id * 2.39 + b.id) * 1.7);
        out.nz = length > 1e-4 ? nzRaw / length : Math.sin((a.id * 2.39 + b.id) * 1.7);
        out.aOffset = ao;
        out.bOffset = bo;
      }
    }
    return out;
  }

  private currentSampleDistance(a: IBoat, b: IBoat, ao: number, bo: number): number {
    const dx = a.state.position.x + Math.sin(a.state.heading) * ao -
      (b.state.position.x + Math.sin(b.state.heading) * bo);
    const dz = a.state.position.z + Math.cos(a.state.heading) * ao -
      (b.state.position.z + Math.cos(b.state.heading) * bo);
    return Math.hypot(dx, dz);
  }

  private ensure(size: number): void {
    if (this.prevX.length >= size) return;
    this.prevX = new Float32Array(size);
    this.prevZ = new Float32Array(size);
    this.prevHeading = new Float32Array(size);
    this.cooldowns = new Float32Array(size * size);
  }

  private pairKey(a: number, b: number): number {
    const size = Math.round(Math.sqrt(this.cooldowns.length));
    return Math.min(a, b) * size + Math.max(a, b);
  }
}
