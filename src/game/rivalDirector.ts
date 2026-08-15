import type { RacerDefinition, RacerState } from '../contracts';

const MAX_CHASE = 1.045;
const MAX_RELEASE = 0.965;
const CHANGE_RATE = 0.015;

/** Coordinates only the two strongest opponents; all other AI stays on authored pace. */
export class RivalDirector {
  private biases = new Float32Array(0);
  private rivalIds: number[] = [];
  private grace = 0;
  private lock = 0;

  setRoster(definitions: readonly RacerDefinition[]): void {
    this.biases = new Float32Array(definitions.length);
    this.biases.fill(1);
    this.rivalIds = definitions.filter((definition) => !definition.isPlayer)
      .sort((a, b) => b.pace - a.pace)
      .slice(0, 2)
      .map((definition) => definition.id);
    this.grace = 0;
    this.lock = 0;
  }

  update(dt: number, racers: readonly RacerState[]): void {
    this.grace = Math.max(0, this.grace - dt);
    this.lock = Math.max(0, this.lock - dt);
    const player = racers.find((racer) => racer.isPlayer);
    if (!player) return;
    for (let id = 0; id < this.biases.length; id++) {
      const racer = racers[id];
      if (!racer || racer.isPlayer || !this.rivalIds.includes(id)) {
        this.biases[id] = approach(this.biases[id], 1, CHANGE_RATE * 2 * dt);
        continue;
      }
      const gap = player.progress - racer.progress;
      let target = 1;
      if (this.grace > 0) target = Math.min(1, this.biases[id]);
      else if (this.lock > 0) target = this.biases[id];
      else if (gap > 18) target = MAX_CHASE;
      else if (gap < -14) target = MAX_RELEASE;
      else if (gap > 6) target = 1.018;
      else if (gap < -6) target = 0.986;
      this.biases[id] = approach(this.biases[id], target, CHANGE_RATE * dt);
    }
  }

  paceFor(id: number): number {
    return this.biases[id] || 1;
  }

  isElite(id: number): boolean {
    return this.rivalIds.includes(id);
  }

  notifyBattle(): void {
    this.lock = 2;
  }

  notifyPlayerImpact(): void {
    this.grace = 2.5;
  }

  debugState(): { rivals: readonly number[]; pace: readonly number[]; grace: number; lock: number } {
    return { rivals: this.rivalIds, pace: Array.from(this.biases), grace: this.grace, lock: this.lock };
  }
}

function approach(current: number, target: number, maxDelta: number): number {
  if (current < target) return Math.min(target, current + maxDelta);
  if (current > target) return Math.max(target, current - maxDelta);
  return current;
}
