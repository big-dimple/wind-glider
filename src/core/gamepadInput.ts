import type { BoatInput } from '../contracts';

type GamepadProvider = () => readonly (Gamepad | null)[];
const EMPTY_GAMEPADS: readonly (Gamepad | null)[] = [];

const ZERO: BoatInput = {
  throttle: 1,
  steer: 0,
  drift: false,
  flightTrigger: false,
  airBrake: false,
};

const DEAD_ZONE = 0.18;
const NAV_THRESHOLD = 0.62;
const ACTIVE_AXIS_THRESHOLD = 0.55;
const GAMEPAD_STORAGE_KEY = 'board-race.gamepad.v1';

interface GamepadBindings {
  steerAxis: number | null;
  steerScale: -1 | 1;
  steerLeftButton: number | null;
  steerRightButton: number | null;
  driftButton: number;
  flightButton: number;
  confirmButton: number;
}

interface PadSnapshot {
  buttons: boolean[];
  axes: number[];
}

interface PadCandidate {
  pad: Gamepad;
  key: string;
  current: PadSnapshot;
  previous: PadSnapshot;
  activity: number;
}

type CalibrationStep = 'left' | 'right' | 'drift' | 'flight';

interface CalibrationState {
  signature: string;
  step: CalibrationStep;
  awaitNeutral: boolean;
  steerAxis: number | null;
  leftAxisSign: -1 | 1;
  steerLeftButton: number | null;
  steerRightButton: number | null;
  driftButton: number | null;
}

interface HapticActuatorLike {
  effects?: readonly string[];
  playEffect?: (type: string, options: Record<string, number>) => Promise<unknown>;
  pulse?: (value: number, duration: number) => Promise<unknown>;
  reset?: () => Promise<unknown>;
}

type GamepadWithHaptics = Gamepad & {
  vibrationActuator?: HapticActuatorLike;
  hapticActuators?: readonly HapticActuatorLike[];
};

const STANDARD_BINDINGS: GamepadBindings = {
  steerAxis: 0,
  steerScale: 1,
  steerLeftButton: 14,
  steerRightButton: 15,
  driftButton: 2,
  flightButton: 0,
  confirmButton: 9,
};

const CALIBRATION_PROMPTS: Record<CalibrationStep, string> = {
  left: '自定义手柄 · 向左推摇杆或按左方向键',
  right: '自定义手柄 · 向右推摇杆或按右方向键',
  drift: '自定义手柄 · 按下你要用的漂移 / 空刹键',
  flight: '自定义手柄 · 按下你要用的起飞 / 确认键',
};

/** Browser Gamepad adapter. It translates controls but never owns vehicle physics. */
export class GamepadInput {
  private readonly provider: GamepadProvider;
  private pad: Gamepad | null = null;
  private bindings: GamepadBindings = STANDARD_BINDINGS;
  private bindingsSignature = '';
  private bindingSource: 'standard' | 'custom' | 'fallback' = 'standard';
  private connectedCount = 0;
  private readonly snapshots = new Map<string, PadSnapshot>();
  private calibration: CalibrationState | null = null;
  private suppressActionsUntilRelease = false;
  private steer = 0;
  private steerActive = false;
  private driftHeld = false;
  private flightPressed = false;
  private confirmPressed = false;
  private selectLeftPressed = false;
  private selectRightPressed = false;
  private activitySerialValue = 0;
  private dismissPressed = false;

  constructor(provider: GamepadProvider = () => navigator.getGamepads?.() ?? EMPTY_GAMEPADS) {
    this.provider = provider;
    window.addEventListener('gamepaddisconnected', (event) => {
      const disconnected = (event as GamepadEvent).gamepad;
      this.snapshots.delete(padKey(disconnected));
      if (this.pad?.index !== disconnected.index) return;
      this.stopPadRumble(this.pad);
      this.pad = null;
      this.bindingsSignature = '';
      this.clearGameplayState();
    });
    window.addEventListener('blur', () => {
      this.reset();
      this.stopRumble();
    });
  }

  get connected(): boolean {
    return this.pad !== null;
  }

  /** Poll every simulation frame. Calibration is allowed only on the frozen READY screen. */
  poll(allowCalibration = false): void {
    let pads: readonly (Gamepad | null)[];
    try {
      pads = this.provider();
    } catch {
      this.clearDisconnected();
      return;
    }

    const candidates: PadCandidate[] = [];
    const liveKeys = new Set<string>();
    for (const candidate of pads) {
      if (!candidate?.connected) continue;
      const key = padKey(candidate);
      const current = snapshot(candidate);
      const previous = this.snapshots.get(key) ?? emptySnapshot(candidate);
      candidates.push({
        pad: candidate,
        key,
        current,
        previous,
        activity: activityScore(current, previous),
      });
      liveKeys.add(key);
    }
    this.connectedCount = candidates.length;
    for (const key of this.snapshots.keys()) if (!liveKeys.has(key)) this.snapshots.delete(key);

    if (candidates.length === 0) {
      this.clearDisconnected();
      return;
    }

    const oldPad = this.pad;
    const oldKey = oldPad ? padKey(oldPad) : '';
    const currentCandidate = candidates.find((candidate) => candidate.key === oldKey);
    let selected = currentCandidate ?? candidates[0];
    for (const candidate of candidates) {
      if (candidate.activity > selected.activity + 0.01) selected = candidate;
    }

    const changedPad = !oldPad || selected.key !== oldKey;
    if (changedPad && oldPad) this.stopPadRumble(oldPad);
    this.pad = selected.pad;
    const signature = deviceSignature(selected.pad);
    if (changedPad || this.bindingsSignature !== signature) {
      this.bindings = this.resolveBindings(selected.pad);
      this.bindingsSignature = signature;
    }
    if (changedPad) {
      this.clearEdges();
      this.steer = 0;
      this.steerActive = false;
      this.driftHeld = false;
      this.suppressActionsUntilRelease = false;
    }

    if (allowCalibration && selected.pad.mapping !== 'standard' && this.bindingSource !== 'custom') {
      this.ensureCalibration(selected.pad);
      this.processCalibration(selected);
      this.clearGameplayState();
    } else {
      this.processGameplay(selected);
    }

    for (const candidate of candidates) this.snapshots.set(candidate.key, candidate.current);
  }

  read(flightActive: boolean): BoatInput {
    if (!this.connected) return ZERO;
    const flightTrigger = this.flightPressed;
    this.flightPressed = false;
    return {
      throttle: 1,
      steer: this.steer,
      drift: this.driftHeld && !flightActive,
      flightTrigger,
      airBrake: this.driftHeld && flightActive,
    };
  }

  steeringHeld(): boolean {
    return this.steerActive;
  }

  consumeConfirm(): boolean {
    const value = this.confirmPressed;
    this.confirmPressed = false;
    return value;
  }

  consumeSelectLeft(): boolean {
    const value = this.selectLeftPressed;
    this.selectLeftPressed = false;
    return value;
  }

  consumeSelectRight(): boolean {
    const value = this.selectRightPressed;
    this.selectRightPressed = false;
    return value;
  }

  consumeFlight(): boolean {
    const value = this.flightPressed;
    this.flightPressed = false;
    return value;
  }

  consumeDismiss(): boolean {
    const value = this.dismissPressed;
    this.dismissPressed = false;
    return value;
  }

  get activitySerial(): number {
    return this.activitySerialValue;
  }

  controlLabels(): { steer: string; drift: string; flight: string } {
    if (this.bindingSource === 'standard') return { steer: '左摇杆 / D-PAD', drift: 'X / LB / RB', flight: 'A' };
    const drift = `B${this.bindings.driftButton + 1}`;
    const flight = `B${this.bindings.flightButton + 1}`;
    const steer = this.bindings.steerAxis === null ? '方向键' : `摇杆轴 ${this.bindings.steerAxis + 1}`;
    return { steer, drift, flight };
  }

  /** Hard lifecycle reset: preserve no edge, and block only actions already held now. */
  reset(): void {
    this.clearEdges();
    this.steer = 0;
    this.steerActive = false;
    this.driftHeld = false;
    const current = this.readCurrentPad();
    if (current && this.pad) {
      this.snapshots.set(padKey(this.pad), current);
      this.suppressActionsUntilRelease = this.actionHeld(current, this.bindings);
    } else {
      this.suppressActionsUntilRelease = false;
    }
    this.stopRumble();
  }

  clearTransient(): void {
    this.clearEdges();
  }

  /** Short, bounded controller feedback. Mobile vibration is coordinated by Haptics. */
  rumble(strongMagnitude: number, weakMagnitude: number, durationMs: number): boolean {
    if (!this.pad || document.hidden) return false;
    const actuator = actuatorFor(this.pad);
    if (!actuator) return false;
    const duration = Math.max(8, Math.min(80, durationMs));
    const strong = clamp01(strongMagnitude);
    const weak = clamp01(weakMagnitude);
    if (actuator.playEffect) {
      void actuator.playEffect('dual-rumble', {
        duration,
        startDelay: 0,
        strongMagnitude: strong,
        weakMagnitude: weak,
      }).catch(() => undefined);
      return true;
    }
    if (actuator.pulse) {
      void actuator.pulse(Math.max(strong, weak), duration).catch(() => undefined);
      return true;
    }
    return false;
  }

  stopRumble(): void {
    if (this.pad) this.stopPadRumble(this.pad);
  }

  recalibrate(): void {
    if (!this.pad || this.pad.mapping === 'standard') return;
    removeStoredBindings(deviceSignature(this.pad));
    this.bindingSource = 'fallback';
    this.calibration = null;
    this.ensureCalibration(this.pad);
    this.reset();
  }

  status(): Record<string, number | string | boolean> {
    const calibrationStep = this.calibration?.step ?? '';
    return {
      connected: this.connected,
      connectedCount: this.connectedCount,
      id: this.pad?.id ?? '',
      index: this.pad?.index ?? -1,
      mapping: this.pad?.mapping ?? '',
      mappingSource: this.bindingSource,
      calibrationStep,
      calibrationPrompt: calibrationStep ? CALIBRATION_PROMPTS[calibrationStep] : '',
      rumble: Boolean(this.pad && actuatorFor(this.pad)),
      steer: this.steer,
      drift: this.driftHeld,
      driftLabel: this.controlLabels().drift,
      flightLabel: this.controlLabels().flight,
    };
  }

  private processGameplay(selected: PadCandidate): void {
    const { current, previous } = selected;
    const left = button(current, this.bindings.steerLeftButton);
    const right = button(current, this.bindings.steerRightButton);
    const prevLeft = button(previous, this.bindings.steerLeftButton);
    const prevRight = button(previous, this.bindings.steerRightButton);
    const analogRaw = this.bindings.steerAxis === null ? 0 : current.axes[this.bindings.steerAxis] ?? 0;
    const prevAnalogRaw = this.bindings.steerAxis === null ? 0 : previous.axes[this.bindings.steerAxis] ?? 0;
    const analog = deadZone(analogRaw * this.bindings.steerScale);
    const prevAnalog = deadZone(prevAnalogRaw * this.bindings.steerScale);
    this.steer = left === right ? analog : left ? -1 : 1;
    this.steerActive = left || right || Math.abs(analog) > 0;
    const navLeft = left || analog <= -NAV_THRESHOLD;
    const navRight = right || analog >= NAV_THRESHOLD;
    const prevNavLeft = prevLeft || prevAnalog <= -NAV_THRESHOLD;
    const prevNavRight = prevRight || prevAnalog >= NAV_THRESHOLD;
    const drift = this.driftButtonHeld(current);
    const flight = button(current, this.bindings.flightButton);
    const confirm = flight || button(current, this.bindings.confirmButton);
    const prevFlight = button(previous, this.bindings.flightButton);
    const prevConfirm = prevFlight || button(previous, this.bindings.confirmButton);
    const dismissSafe = ![this.bindings.driftButton, this.bindings.flightButton, this.bindings.confirmButton].includes(8);
    const dismiss = dismissSafe && button(current, 8);
    const prevDismiss = dismissSafe && button(previous, 8);

    if (selected.activity > 0.01) this.activitySerialValue++;

    if (this.suppressActionsUntilRelease && !drift && !flight && !confirm) {
      this.suppressActionsUntilRelease = false;
    }
    this.driftHeld = !this.suppressActionsUntilRelease && drift;
    this.flightPressed = !this.suppressActionsUntilRelease && flight && !prevFlight;
    this.confirmPressed = !this.suppressActionsUntilRelease && confirm && !prevConfirm;
    this.selectLeftPressed = navLeft && !prevNavLeft;
    this.selectRightPressed = navRight && !prevNavRight;
    this.dismissPressed = dismiss && !prevDismiss;
  }

  private ensureCalibration(pad: Gamepad): void {
    const signature = deviceSignature(pad);
    if (this.calibration?.signature === signature) return;
    this.calibration = {
      signature,
      step: 'left',
      // Ignore the input that merely woke/selected this controller. Mapping
      // begins after the user releases it and deliberately pushes left.
      awaitNeutral: true,
      steerAxis: null,
      leftAxisSign: -1,
      steerLeftButton: null,
      steerRightButton: null,
      driftButton: null,
    };
  }

  private processCalibration(selected: PadCandidate): void {
    const calibration = this.calibration;
    if (!calibration) return;
    if (calibration.awaitNeutral) {
      if (isNeutral(selected.current)) calibration.awaitNeutral = false;
      return;
    }
    if (calibration.step === 'left' || calibration.step === 'right') {
      const direction = strongestDirection(selected.current, selected.previous);
      if (!direction) return;
      if (calibration.step === 'left') {
        if (direction.axis !== null) {
          calibration.steerAxis = direction.axis;
          calibration.leftAxisSign = direction.sign;
        } else {
          calibration.steerLeftButton = direction.button;
        }
        calibration.step = 'right';
      } else {
        if (direction.axis !== null) {
          if (calibration.steerAxis !== null &&
              (direction.axis !== calibration.steerAxis || direction.sign === calibration.leftAxisSign)) return;
          calibration.steerAxis = direction.axis;
        } else {
          if (direction.button === calibration.steerLeftButton) return;
          calibration.steerRightButton = direction.button;
        }
        calibration.step = 'drift';
      }
      calibration.awaitNeutral = true;
      return;
    }

    const pressedButton = firstNewButton(selected.current, selected.previous);
    if (pressedButton < 0 || pressedButton === calibration.steerLeftButton || pressedButton === calibration.steerRightButton) return;
    if (calibration.step === 'drift') {
      calibration.driftButton = pressedButton;
      calibration.step = 'flight';
      calibration.awaitNeutral = true;
      return;
    }
    if (pressedButton === calibration.driftButton) return;

    const bindings: GamepadBindings = {
      steerAxis: calibration.steerAxis,
      steerScale: calibration.steerAxis === null ? 1 : calibration.leftAxisSign > 0 ? -1 : 1,
      steerLeftButton: calibration.steerLeftButton,
      steerRightButton: calibration.steerRightButton,
      driftButton: calibration.driftButton ?? STANDARD_BINDINGS.driftButton,
      flightButton: pressedButton,
      confirmButton: pressedButton,
    };
    saveStoredBindings(calibration.signature, bindings);
    this.bindings = bindings;
    this.bindingSource = 'custom';
    this.calibration = null;
    this.suppressActionsUntilRelease = true;
  }

  private resolveBindings(pad: Gamepad): GamepadBindings {
    if (pad.mapping === 'standard') {
      this.bindingSource = 'standard';
      this.calibration = null;
      return STANDARD_BINDINGS;
    }
    const stored = loadStoredBindings(deviceSignature(pad));
    if (stored) {
      this.bindingSource = 'custom';
      this.calibration = null;
      return stored;
    }
    this.bindingSource = 'fallback';
    return STANDARD_BINDINGS;
  }

  private actionHeld(state: PadSnapshot, bindings: GamepadBindings): boolean {
    return this.driftButtonHeld(state) || button(state, bindings.flightButton) ||
      button(state, bindings.confirmButton);
  }

  private driftButtonHeld(state: PadSnapshot): boolean {
    if (button(state, this.bindings.driftButton)) return true;
    return this.bindingSource === 'standard' && (button(state, 4) || button(state, 5));
  }

  private readCurrentPad(): PadSnapshot | null {
    if (!this.pad) return null;
    try {
      const current = this.provider()[this.pad.index];
      if (current?.connected && current.id === this.pad.id) {
        this.pad = current;
        return snapshot(current);
      }
    } catch {
      return null;
    }
    return null;
  }

  private stopPadRumble(pad: Gamepad): void {
    const actuator = actuatorFor(pad);
    if (!actuator) return;
    if (actuator.reset) void actuator.reset().catch(() => undefined);
    else if (actuator.playEffect) {
      void actuator.playEffect('dual-rumble', {
        duration: 0,
        startDelay: 0,
        strongMagnitude: 0,
        weakMagnitude: 0,
      }).catch(() => undefined);
    } else if (actuator.pulse) {
      void actuator.pulse(0, 0).catch(() => undefined);
    }
  }

  private clearDisconnected(): void {
    if (this.pad) this.stopPadRumble(this.pad);
    this.pad = null;
    this.bindingsSignature = '';
    this.connectedCount = 0;
    this.calibration = null;
    this.suppressActionsUntilRelease = false;
    this.clearGameplayState();
  }

  private clearGameplayState(): void {
    this.steer = 0;
    this.steerActive = false;
    this.driftHeld = false;
    this.clearEdges();
  }

  private clearEdges(): void {
    this.flightPressed = false;
    this.confirmPressed = false;
    this.selectLeftPressed = false;
    this.selectRightPressed = false;
    this.dismissPressed = false;
  }
}

function padKey(pad: Gamepad): string {
  return `${pad.index}:${pad.id}`;
}

function deviceSignature(pad: Gamepad): string {
  return `${pad.id}|${pad.mapping}|a${pad.axes.length}|b${pad.buttons.length}`;
}

function snapshot(pad: Gamepad): PadSnapshot {
  return {
    buttons: Array.from(pad.buttons, (item) => item.pressed || item.value > 0.55),
    axes: Array.from(pad.axes, (value) => Number.isFinite(value) ? clampSigned(value) : 0),
  };
}

function emptySnapshot(pad: Gamepad): PadSnapshot {
  return { buttons: new Array<boolean>(pad.buttons.length).fill(false), axes: new Array<number>(pad.axes.length).fill(0) };
}

function button(state: PadSnapshot, index: number | null): boolean {
  return index !== null && index >= 0 ? Boolean(state.buttons[index]) : false;
}

function firstNewButton(current: PadSnapshot, previous: PadSnapshot): number {
  for (let i = 0; i < current.buttons.length; i++) if (current.buttons[i] && !previous.buttons[i]) return i;
  return -1;
}

function activityScore(current: PadSnapshot, previous: PadSnapshot): number {
  let score = firstNewButton(current, previous) >= 0 ? 4 : 0;
  for (let i = 0; i < current.axes.length; i++) {
    const value = Math.abs(current.axes[i] ?? 0);
    const before = Math.abs(previous.axes[i] ?? 0);
    if (value >= ACTIVE_AXIS_THRESHOLD && (before < 0.35 || Math.abs(value - before) >= 0.45)) {
      score = Math.max(score, 2 + value);
    }
  }
  return score;
}

function strongestDirection(current: PadSnapshot, previous: PadSnapshot): { axis: number | null; sign: -1 | 1; button: number } | null {
  let axis = -1;
  let magnitude = ACTIVE_AXIS_THRESHOLD;
  for (let i = 0; i < current.axes.length; i++) {
    const value = Math.abs(current.axes[i] ?? 0);
    if (value > magnitude && Math.abs(previous.axes[i] ?? 0) < 0.35) {
      axis = i;
      magnitude = value;
    }
  }
  if (axis >= 0) return { axis, sign: current.axes[axis] < 0 ? -1 : 1, button: -1 };
  const pressed = firstNewButton(current, previous);
  return pressed >= 0 ? { axis: null, sign: -1, button: pressed } : null;
}

function isNeutral(state: PadSnapshot): boolean {
  return !state.buttons.some(Boolean) && state.axes.every((value) => Math.abs(value) < 0.3);
}

function actuatorFor(pad: Gamepad): HapticActuatorLike | null {
  const candidate = pad as GamepadWithHaptics;
  return candidate.vibrationActuator ?? candidate.hapticActuators?.[0] ?? null;
}

function loadStoredBindings(signature: string): GamepadBindings | null {
  try {
    const raw = localStorage.getItem(GAMEPAD_STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as Record<string, GamepadBindings>;
    const binding = data[signature];
    if (!binding || typeof binding.driftButton !== 'number' || typeof binding.flightButton !== 'number') return null;
    return binding;
  } catch {
    return null;
  }
}

function saveStoredBindings(signature: string, bindings: GamepadBindings): void {
  try {
    const raw = localStorage.getItem(GAMEPAD_STORAGE_KEY);
    const data = raw ? JSON.parse(raw) as Record<string, GamepadBindings> : {};
    data[signature] = bindings;
    localStorage.setItem(GAMEPAD_STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Custom mapping remains valid for this page even when storage is unavailable.
  }
}

function removeStoredBindings(signature: string): void {
  try {
    const raw = localStorage.getItem(GAMEPAD_STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw) as Record<string, GamepadBindings>;
    delete data[signature];
    localStorage.setItem(GAMEPAD_STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Storage is optional.
  }
}

function deadZone(raw: number): number {
  const value = clampSigned(raw);
  const magnitude = Math.abs(value);
  if (magnitude <= DEAD_ZONE) return 0;
  return Math.sign(value) * (magnitude - DEAD_ZONE) / (1 - DEAD_ZONE);
}

function clampSigned(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
