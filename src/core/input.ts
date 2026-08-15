/**
 * input.ts — keyboard state → BoatInput for the player.
 *
 * The boat advances automatically. A/D or arrows steer, Shift is the single
 * contextual hold action (surface drift / in-flight air brake), Space flies,
 * and Enter confirms. Steering returns to center smoothly.
 */
import type { BoatInput } from '../contracts';

export class Input {
  readonly keys = new Set<string>();
  /** Edge-triggered: true for one consume() call after keydown. */
  private pressed = new Set<string>();
  private steerVal = 0;
  private activitySerialValue = 0;

  constructor(target: Window = window) {
    target.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.pressed.add(e.code);
      if (['KeyA', 'KeyD', 'ArrowLeft', 'ArrowRight', 'Space', 'ShiftLeft', 'ShiftRight'].includes(e.code)) {
        this.activitySerialValue++;
      }
      if (['ArrowLeft', 'ArrowRight', 'Space', 'ShiftLeft', 'ShiftRight'].includes(e.code)) e.preventDefault();
    });
    target.addEventListener('keyup', (e) => this.keys.delete(e.code));
    target.addEventListener('blur', () => {
      this.keys.clear();
      this.pressed.clear();
      this.steerVal = 0;
    });
  }

  /** Was this key pressed since the last consume? Consumes the flag. */
  consumePress(code: string): boolean {
    const had = this.pressed.has(code);
    this.pressed.delete(code);
    return had;
  }

  read(dt: number, flightActive: boolean): BoatInput {
    const left = this.keys.has('KeyA') || this.keys.has('ArrowLeft');
    const right = this.keys.has('KeyD') || this.keys.has('ArrowRight');
    const action = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');

    const steerTarget = left ? -1 : right ? 1 : 0;
    this.steerVal = approach(this.steerVal, steerTarget, 7 * dt);

    return {
      throttle: 1,
      steer: this.steerVal,
      drift: action && !flightActive,
      flightTrigger: this.consumePress('Space'),
      airBrake: action && flightActive,
    };
  }

  /** True only while a physical steering key is held. */
  steeringHeld(): boolean {
    return this.keys.has('KeyA') || this.keys.has('ArrowLeft') ||
      this.keys.has('KeyD') || this.keys.has('ArrowRight');
  }

  get activitySerial(): number {
    return this.activitySerialValue;
  }

  reset(): void {
    this.keys.clear();
    this.pressed.clear();
    this.steerVal = 0;
  }

  /**
   * Clear one-shot presses at a presentation boundary without forgetting keys
   * that are physically still held. This lets Shift survive the medal/resume
   * sequence while Space can never be buffered into the next control frame.
   */
  clearTransient(): void {
    this.pressed.clear();
    this.steerVal = 0;
  }
}

function approach(cur: number, target: number, maxDelta: number): number {
  if (cur < target) return Math.min(cur + maxDelta, target);
  if (cur > target) return Math.max(cur - maxDelta, target);
  return cur;
}
