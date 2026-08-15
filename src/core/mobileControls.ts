import type { BoatInput, RouteTurnDirection } from '../contracts';
import type { AbilityHudState } from './abilityTelemetry';
import './mobileControls.css';

type ControlMode = 'tilt' | 'touch';
type ActivationState = 'idle' | 'requesting' | 'calibrating' | 'ready';
type ControlPhase = 'inactive' | 'presentation' | 'preparing' | 'racing';
type PointerAction = 'left' | 'right' | 'drift' | 'flight';

const ZERO: BoatInput = {
  throttle: 0,
  steer: 0,
  drift: false,
  flightTrigger: false,
  airBrake: false,
};

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const CALIBRATION_MS = 300;
const SENSOR_TIMEOUT_MS = 1500;
const MIN_CALIBRATION_SAMPLES = 6;

/** Landscape mobile controls with touch steering and opt-in tilt calibration. */
export class MobileControls {
  readonly enabled: boolean;

  private readonly root: HTMLDivElement | null;
  private readonly start: HTMLButtonElement | null;
  private readonly modeButton: HTMLButtonElement | null;
  private readonly driftLabel: HTMLElement | null;
  private readonly driftSubLabel: HTMLElement | null;
  private readonly flightLabel: HTMLElement | null;
  private readonly flightSubLabel: HTMLElement | null;
  private readonly tiltMeter: HTMLDivElement | null;
  private readonly onFirstGesture: () => void;
  private readonly activePointers = new Map<number, PointerAction>();
  private readonly buttons = new Map<PointerAction, HTMLButtonElement>();

  private mode: ControlMode = 'touch';
  private activation: ActivationState = 'idle';
  private controlPhase: ControlPhase = 'inactive';
  private permissionPending = false;
  private tiltAuthorized = false;
  private calibrationStartedAt = 0;
  private calibrationAngle = 0;
  private calibrationSamples: number[] = [];
  private calibrationTimer = 0;
  private calibration = 0;
  private rawTilt = 0;
  private filteredTilt = 0;
  private touchSteer = 0;
  private flightQueued = false;
  private anyPressQueued = false;
  private goQueued = false;
  private pendingGoAfterActivation = false;
  private showGo = false;
  private goLabel = '开始游戏';
  private landscape = matchMedia('(orientation: landscape)').matches;
  private fullscreenRequests = 0;
  private fullscreenRequestPending = false;
  private firstImmersiveGestureHandled = false;
  private activitySerialValue = 0;
  private previousTiltActivity = 0;
  private finalMode = false;

  get ready(): boolean {
    return !this.enabled || this.landscape && this.activation === 'ready';
  }

  get isLandscape(): boolean {
    return !this.enabled || this.landscape;
  }

  get activitySerial(): number {
    return this.activitySerialValue;
  }

  controlLabels(): { steer: string; drift: string; flight: string } {
    return {
      steer: this.mode === 'tilt' ? '倾斜手机' : '左侧方向区',
      drift: '右下「漂」',
      flight: '右上「飞」',
    };
  }

  constructor(parent: HTMLElement, onFirstGesture: () => void, force = false) {
    this.enabled = force || navigator.maxTouchPoints > 0 || matchMedia('(pointer: coarse)').matches;
    this.onFirstGesture = onFirstGesture;
    if (!this.enabled) {
      this.root = null;
      this.start = null;
      this.modeButton = null;
      this.driftLabel = null;
      this.driftSubLabel = null;
      this.flightLabel = null;
      this.flightSubLabel = null;
      this.tiltMeter = null;
      return;
    }

    const root = document.createElement('div');
    root.className = 'mobile-controls touch-steer';
    root.dataset.activation = 'idle';
    root.innerHTML = `
      <div class="mobile-orientation" role="alert" aria-live="assertive">
        <div class="mobile-rotate-icon" aria-hidden="true">↻</div>
        <strong>请旋转至横屏</strong>
        <span>本游戏仅支持横屏</span>
      </div>
      <button class="mobile-start" type="button">开始游戏</button>
      <button class="mobile-mode" type="button" aria-label="当前触控转向，点击切换重力">转向 · 触控</button>
      <div class="mobile-tilt-meter" aria-hidden="true"><i></i></div>
      <div class="mobile-steer-zones" aria-label="触控转向">
        <button type="button" data-mobile-action="left" aria-label="左转"><span><b>‹</b><small>LEFT</small></span></button>
        <button type="button" data-mobile-action="right" aria-label="右转"><span><b>›</b><small>RIGHT</small></span></button>
      </div>
      <div class="mobile-action-zones" aria-label="动作按钮">
        <button type="button" data-mobile-action="drift" aria-label="漂移"><span><b>漂</b><small>DRIFT</small><i class="mobile-threshold" aria-hidden="true"></i></span></button>
        <button type="button" data-mobile-action="flight" aria-label="飞行"><span><b>飞</b><small>FLIGHT</small><i class="mobile-stock">x0</i></span></button>
      </div>
    `;
    parent.appendChild(root);
    this.root = root;
    this.start = root.querySelector<HTMLButtonElement>('.mobile-start');
    this.modeButton = root.querySelector<HTMLButtonElement>('.mobile-mode');
    this.driftLabel = root.querySelector<HTMLElement>('[data-mobile-action="drift"] b');
    this.driftSubLabel = root.querySelector<HTMLElement>('[data-mobile-action="drift"] small');
    this.flightLabel = root.querySelector<HTMLElement>('[data-mobile-action="flight"] b');
    this.flightSubLabel = root.querySelector<HTMLElement>('[data-mobile-action="flight"] small');
    this.tiltMeter = root.querySelector<HTMLDivElement>('.mobile-tilt-meter i');

    this.start?.addEventListener('click', () => {
      this.requestGo();
    });
    this.modeButton?.addEventListener('click', () => {
      this.requestImmersiveFromGesture();
      if (this.mode === 'touch') {
        void this.activateTilt();
      }
      else this.useTouch();
    });

    root.querySelectorAll<HTMLButtonElement>('[data-mobile-action]').forEach((button) => {
      const action = button.dataset.mobileAction as PointerAction;
      this.buttons.set(action, button);
      button.addEventListener('pointerdown', (event) => this.pointerDown(event, action));
      button.addEventListener('pointerup', (event) => this.pointerUp(event));
      button.addEventListener('pointercancel', (event) => this.pointerUp(event));
      button.addEventListener('lostpointercapture', (event) => this.pointerUp(event));
      button.addEventListener('contextmenu', (event) => event.preventDefault());
    });

    const orientationMedia = matchMedia('(orientation: landscape)');
    orientationMedia.addEventListener?.('change', () => this.orientationChanged());
    window.addEventListener('deviceorientation', (event) => this.orientation(event), { passive: true });
    window.addEventListener('orientationchange', () => this.orientationChanged());
    screen.orientation?.addEventListener?.('change', () => this.orientationChanged());
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.releaseAll();
      else if (this.mode === 'tilt' && this.tiltAuthorized) this.startCalibration();
    });
    window.addEventListener('pointerdown', () => {
      this.anyPressQueued = true;
      this.requestImmersiveFromGesture();
    }, { passive: true });
  }

  setControlPhase(phase: ControlPhase): void {
    if (phase === this.controlPhase) return;
    const wasInteractive = this.controlPhase !== 'inactive' && this.controlPhase !== 'presentation';
    this.controlPhase = phase;
    this.root?.classList.toggle('controls-visible', phase !== 'inactive');
    this.root?.classList.toggle('preparing', phase === 'preparing');
    this.root?.classList.toggle('presentation', phase === 'presentation');
    this.root?.classList.toggle('racing', phase === 'racing');
    if (phase === 'inactive') {
      this.releaseAll();
      this.flightQueued = false;
      this.anyPressQueued = false;
      this.goQueued = false;
    } else if (phase === 'presentation') {
      // Keep physical left/drift pointers alive across the frozen medal
      // presentation, but never carry an edge-triggered flight or confirm.
      this.flightQueued = false;
      this.anyPressQueued = false;
      this.goQueued = false;
    } else if (!wasInteractive || phase === 'preparing') {
      // Preparing accepts held steering/drift only. A flight edge must always
      // originate after GO, even if the player taps the disabled side early.
      this.flightQueued = false;
    }
  }

  read(dt: number, flightActive: boolean): BoatInput {
    if (!this.enabled || this.controlPhase !== 'racing' || this.activation !== 'ready') return ZERO;
    const leftHeld = this.hasAction('left');
    const rightHeld = this.hasAction('right');
    const touchTarget = leftHeld === rightHeld ? 0 : leftHeld ? -1 : 1;
    this.touchSteer = approach(this.touchSteer, touchTarget, 8 * dt);

    const response = 1 - Math.exp(-dt / 0.12);
    this.filteredTilt += (this.rawTilt - this.filteredTilt) * response;
    const tiltDegrees = Math.abs(this.filteredTilt);
    const tiltMagnitude = clamp((tiltDegrees - 3) / 19, 0, 1);
    const tiltSteer = Math.sign(this.filteredTilt) * tiltMagnitude;
    if (this.mode === 'tilt' && Math.abs(tiltSteer) >= 0.42 &&
        (Math.abs(this.previousTiltActivity) < 0.24 || Math.abs(tiltSteer - this.previousTiltActivity) >= 0.5)) {
      this.activitySerialValue++;
    }
    this.previousTiltActivity = tiltSteer;
    const steer = this.mode === 'tilt' ? tiltSteer : this.touchSteer;
    if (this.tiltMeter) this.tiltMeter.style.transform = `translateX(${steer * 34}px)`;

    const action = this.hasAction('drift');
    const flightTrigger = this.flightQueued;
    this.flightQueued = false;
    if (this.driftLabel) this.driftLabel.textContent = flightActive ? '空刹' : this.finalMode ? '刹' : '漂';
    if (this.driftSubLabel) this.driftSubLabel.textContent = flightActive ? 'AIR BRAKE' : this.finalMode ? 'BRAKE' : 'DRIFT';
    return {
      throttle: 1,
      steer,
      drift: action && !flightActive && !this.finalMode,
      flightTrigger: this.finalMode ? false : flightTrigger,
      airBrake: action && (flightActive || this.finalMode),
    };
  }

  consumeAnyPress(): boolean {
    const pressed = this.anyPressQueued;
    this.anyPressQueued = false;
    return pressed;
  }

  consumeGoRequest(): boolean {
    const queued = this.goQueued;
    this.goQueued = false;
    return queued;
  }

  /** Shared start gate used by the driver contract screen and fallback GO. */
  requestGo(): void {
    // Fullscreen must be requested synchronously from the GO click. Waiting
    // for the sensor permission promise loses browser user activation.
    this.onFirstGesture();
    this.enterImmersiveMode();
    if (this.activation === 'ready') {
      this.goQueued = true;
      return;
    }
    this.pendingGoAfterActivation = true;
    if (this.mode === 'touch') this.useTouch();
    else void this.activateTilt();
  }

  /** Try immersive mode from any first pre-game touch, before async work. */
  requestImmersiveFromGesture(force = false): void {
    this.onFirstGesture();
    if (this.firstImmersiveGestureHandled && !force) return;
    this.firstImmersiveGestureHandled = true;
    this.enterImmersiveMode();
  }

  setGoPrompt(show: boolean, label = '开始游戏'): void {
    this.showGo = show;
    this.goLabel = label;
    this.syncStartButton();
  }

  /** Hide game controls behind a full-screen viewer while preserving the portrait blocker. */
  setOverlayHidden(hidden: boolean): void {
    this.root?.classList.toggle('overlay-hidden', hidden);
    if (hidden) {
      this.releaseAll();
      this.flightQueued = false;
      this.anyPressQueued = false;
      this.goQueued = false;
    }
  }

  setActionState(
    state: AbilityHudState,
    turnWarning = false,
    routeAction: 'none' | 'bank' | 'launch' | 'turn' = 'none',
    routeDirection: RouteTurnDirection | 'none' = 'none',
  ): void {
    if (!this.root) return;
    this.finalMode = state.flightMode === 'finish';
    const charges = Math.round(clamp(state.flightCharges, 0, 2));
    this.root.style.setProperty('--mobile-drift-progress', String(clamp(state.boostCharge, 0, 1)));
    this.root.style.setProperty('--mobile-bank-progress', String(clamp(state.driftBankProgress, 0, 1)));
    this.root.style.setProperty('--mobile-boost-progress', String(clamp(state.boostRemaining, 0, 1)));
    this.root.style.setProperty('--mobile-flight-progress', String(clamp(state.flightRemaining, 0, 1)));
    this.root.style.setProperty('--mobile-airbrake-progress', String(clamp(state.flightAirBrake, 0, 1)));
    this.root.classList.toggle('drift-release-ready', state.driftReleaseReady && state.flightCharges < 2);
    this.root.classList.toggle('drift-bank-full', state.drifting && state.boostCharge >= 0.995);
    this.root.classList.toggle('flight-ready', state.flightMode === 'stored');
    this.root.classList.toggle('flight-extension-ready', state.flightMode === 'extend');
    this.root.classList.toggle('flight-urgent', state.urgency !== 'normal' && state.flightMode !== 'finish');
    this.root.classList.toggle('flight-critical', state.urgency === 'critical');
    this.root.dataset.flightCharges = String(charges);
    this.root.dataset.flightMode = state.flightMode;
    this.root.dataset.leftMode = state.leftMode;
    this.root.dataset.urgency = state.urgency;
    const flight = this.buttons.get('flight');
    if (flight) {
      const label = state.flightMode === 'extend'
        ? `空中续航，消耗 1 次蓄能，当前剩余 ${charges} 次`
        : state.flightMode === 'finish'
          ? '终点已就绪，保持水面航行并冲线'
        : state.flightMode === 'active'
          ? '飞行中，当前不可续航'
          : charges > 0 ? `飞行，已蓄能 ${charges} 次` : '飞行，尚未蓄能';
      flight.setAttribute('aria-label', label);
      flight.setAttribute('aria-disabled', this.finalMode ? 'true' : 'false');
    }
    if (this.flightLabel) this.flightLabel.textContent = state.flightMode === 'extend' ? '续' : state.flightMode === 'finish' ? '终' : '飞';
    if (this.flightSubLabel) this.flightSubLabel.textContent = state.flightMode === 'extend' ? 'EXTEND' : state.flightMode === 'finish' ? 'FINAL' : 'FLIGHT';
    const stock = this.buttons.get('flight')?.querySelector<HTMLElement>('.mobile-stock');
    if (stock) stock.textContent = `x${charges}`;
    this.root.classList.toggle('in-flight', state.flightPhase !== 'surface');
    this.root.classList.toggle('turn-warning', turnWarning);
    this.root.classList.toggle('route-action-bank', routeAction === 'bank');
    this.root.classList.toggle('route-action-launch', routeAction === 'launch');
    this.root.classList.toggle('route-action-turn', routeAction === 'turn');
    this.root.classList.toggle('route-turn-left', routeAction === 'turn' && routeDirection === 'left');
    this.root.classList.toggle('route-turn-right', routeAction === 'turn' && routeDirection === 'right');
    const leftLabel = state.flightPhase !== 'surface' ? '空刹' : state.leftMode === 'finish' ? '刹' : state.leftMode === 'boost' ? '加' : '漂';
    const leftSubLabel = state.flightPhase !== 'surface' ? 'AIR BRAKE' : state.leftMode === 'finish' ? 'BRAKE' : state.leftMode === 'boost' ? 'BOOST' : 'DRIFT';
    if (this.driftLabel) this.driftLabel.textContent = leftLabel;
    if (this.driftSubLabel) this.driftSubLabel.textContent = leftSubLabel;
    const drift = this.buttons.get('drift');
    if (drift) drift.setAttribute('aria-label', state.flightPhase !== 'surface' ? '空刹' : state.leftMode === 'finish' ? '回港刹车' : state.leftMode === 'boost' ? '加速中' : '漂移');
  }

  reset(): void {
    this.releaseAll();
    this.flightQueued = false;
    this.anyPressQueued = false;
    this.goQueued = false;
    this.touchSteer = 0;
    this.filteredTilt = 0;
    this.previousTiltActivity = 0;
  }

  /** Freeze presentation without releasing controls already held by touch. */
  suspendForPresentation(): void {
    this.setControlPhase('presentation');
  }

  /** Re-enter the resume countdown while retaining held steering/actions. */
  resumeFromPresentation(): void {
    this.setControlPhase('preparing');
    this.flightQueued = false;
    this.anyPressQueued = false;
    this.goQueued = false;
  }

  status(): {
    mode: ControlMode;
    activation: ActivationState;
    controlPhase: ControlPhase;
    sampleCount: number;
    angle: number;
    landscape: boolean;
    fullscreenRequests: number;
  } {
    return {
      mode: this.mode,
      activation: this.activation,
      controlPhase: this.controlPhase,
      sampleCount: this.calibrationSamples.length,
      angle: this.calibrationAngle,
      landscape: this.landscape,
      fullscreenRequests: this.fullscreenRequests,
    };
  }

  private async activateTilt(): Promise<void> {
    if (this.permissionPending) return;
    this.onFirstGesture();
    this.permissionPending = true;
    this.setActivation('requesting');
    const orientationType = (window as unknown as { DeviceOrientationEvent?: {
      requestPermission?: () => Promise<'granted' | 'denied'>;
    } }).DeviceOrientationEvent;
    const permissionPromise = orientationType?.requestPermission?.();
    try {
      if (!('DeviceOrientationEvent' in window)) {
        this.useTouch();
        return;
      }
      if (permissionPromise && await permissionPromise !== 'granted') {
        this.useTouch();
        return;
      }
      this.tiltAuthorized = true;
      this.mode = 'tilt';
      this.startCalibration();
    } catch {
      this.useTouch();
    } finally {
      this.permissionPending = false;
    }
  }

  private requestFullscreen(): Promise<void> {
    if (document.fullscreenElement || !document.documentElement.requestFullscreen) return Promise.resolve();
    if (this.fullscreenRequestPending) return Promise.resolve();
    this.fullscreenRequests++;
    this.fullscreenRequestPending = true;
    return document.documentElement.requestFullscreen({ navigationUI: 'hide' })
      .then(() => undefined)
      .finally(() => { this.fullscreenRequestPending = false; });
  }

  private enterImmersiveMode(): void {
    void this.requestFullscreen()
      .then(() => this.lockLandscape())
      .catch(() => this.lockLandscape());
  }

  private async lockLandscape(): Promise<void> {
    try {
      const orientation = screen.orientation as ScreenOrientation & {
        lock?: (orientation: 'landscape') => Promise<void>;
      };
      await orientation?.lock?.('landscape');
    } catch {
      // Portrait is still blocked by CSS when fullscreen/orientation lock is unavailable.
    }
  }

  private startCalibration(): void {
    if (!this.tiltAuthorized || this.mode !== 'tilt') return;
    window.clearTimeout(this.calibrationTimer);
    this.releaseAll();
    this.rawTilt = 0;
    this.filteredTilt = 0;
    this.calibrationSamples = [];
    this.calibrationStartedAt = performance.now();
    this.calibrationAngle = screenAngle();
    this.setActivation('calibrating');
    this.calibrationTimer = window.setTimeout(() => {
      if (this.activation === 'calibrating') this.useTouch();
    }, SENSOR_TIMEOUT_MS);
  }

  private finishCalibration(): void {
    const sorted = this.calibrationSamples.slice().sort((a, b) => a - b);
    this.calibration = sorted[Math.floor(sorted.length / 2)] ?? 0;
    this.rawTilt = 0;
    this.filteredTilt = 0;
    window.clearTimeout(this.calibrationTimer);
    this.setActivation('ready');
    this.resolvePendingGo();
  }

  private useTouch(): void {
    window.clearTimeout(this.calibrationTimer);
    this.mode = 'touch';
    this.releaseAll();
    this.setActivation('ready');
    this.resolvePendingGo();
  }

  private setActivation(state: ActivationState): void {
    this.activation = state;
    if (this.root) {
      this.root.dataset.activation = state;
      this.root.classList.toggle('touch-steer', this.mode === 'touch');
      this.root.classList.toggle('activated', state === 'ready');
    }
    if (this.modeButton) {
      this.modeButton.textContent = this.mode === 'tilt' ? '转向 · 重力' : '转向 · 触控';
      this.modeButton.setAttribute('aria-label', this.mode === 'tilt' ? '当前重力转向，点击切换触控' : '当前触控转向，点击切换重力');
    }
    this.syncStartButton();
  }

  private resolvePendingGo(): void {
    if (!this.pendingGoAfterActivation) return;
    this.pendingGoAfterActivation = false;
    this.goQueued = true;
  }

  private syncStartButton(): void {
    if (!this.start) return;
    const busy = this.activation === 'requesting' || this.activation === 'calibrating';
    this.start.hidden = !busy && !(this.showGo && (this.activation === 'idle' || this.activation === 'ready'));
    this.start.disabled = busy;
    this.start.textContent = this.activation === 'requesting'
      ? '正在请求…'
      : this.activation === 'calibrating'
        ? '正在校准…'
        : this.goLabel;
  }

  private orientation(event: DeviceOrientationEvent): void {
    if (!this.tiltAuthorized || this.mode !== 'tilt') return;
    const angle = screenAngle();
    const lateral = lateralTilt(event, angle);
    if (lateral === null) return;
    if (this.activation === 'calibrating') {
      if (angle !== this.calibrationAngle) {
        this.calibrationAngle = angle;
        this.calibrationStartedAt = performance.now();
        this.calibrationSamples = [];
      }
      this.calibrationSamples.push(lateral);
      if (this.calibrationSamples.length > 12) this.calibrationSamples.shift();
      const stable = this.calibrationSamples.length >= MIN_CALIBRATION_SAMPLES &&
        Math.max(...this.calibrationSamples) - Math.min(...this.calibrationSamples) <= 3.5;
      if (stable && performance.now() - this.calibrationStartedAt >= CALIBRATION_MS) this.finishCalibration();
      return;
    }
    if (this.activation !== 'ready') return;
    if (angle !== this.calibrationAngle) {
      this.startCalibration();
      return;
    }
    this.rawTilt = clamp(lateral - this.calibration, -32, 32);
  }

  private orientationChanged(): void {
    this.landscape = matchMedia('(orientation: landscape)').matches;
    this.releaseAll();
    if (this.landscape && this.mode === 'tilt' && this.tiltAuthorized) this.startCalibration();
  }

  private pointerDown(event: PointerEvent, action: PointerAction): void {
    this.requestImmersiveFromGesture();
    this.anyPressQueued = true;
    this.activitySerialValue++;
    if (this.controlPhase === 'inactive' || this.activation !== 'ready') return;
    if ((this.controlPhase === 'presentation' || this.controlPhase === 'preparing') && action === 'flight') return;
    if (this.finalMode && action === 'flight') return;
    event.preventDefault();
    const button = event.currentTarget as HTMLButtonElement;
    this.activePointers.set(event.pointerId, action);
    try {
      button.setPointerCapture(event.pointerId);
    } catch {
      // Some WebViews reject capture even though the pointer event is valid.
      // Window blur/visibility and the element's pointerup/cancel still release it.
    }
    if (action === 'flight') this.flightQueued = true;
    this.syncHeldButtons();
  }

  private pointerUp(event: PointerEvent): void {
    this.activePointers.delete(event.pointerId);
    this.syncHeldButtons();
  }

  private syncHeldButtons(): void {
    for (const [action, button] of this.buttons) button.classList.toggle('held', this.hasAction(action));
  }

  private hasAction(action: PointerAction): boolean {
    for (const value of this.activePointers.values()) if (value === action) return true;
    return false;
  }

  private releaseAll(): void {
    this.activePointers.clear();
    this.syncHeldButtons();
    this.touchSteer = 0;
  }
}

function screenAngle(): number {
  const raw = Number(screen.orientation?.angle ?? window.orientation ?? 0);
  return ((Math.round(raw / 90) * 90) % 360 + 360) % 360;
}

function lateralTilt(event: DeviceOrientationEvent, angle: number): number | null {
  const beta = event.beta;
  const gamma = event.gamma;
  if (angle === 90 && beta !== null && Number.isFinite(beta)) return beta;
  if (angle === 270 && beta !== null && Number.isFinite(beta)) return -beta;
  if (angle === 180 && gamma !== null && Number.isFinite(gamma)) return -gamma;
  if (gamma !== null && Number.isFinite(gamma)) return gamma;
  return null;
}

function approach(current: number, target: number, maxDelta: number): number {
  if (current < target) return Math.min(target, current + maxDelta);
  if (current > target) return Math.max(target, current - maxDelta);
  return current;
}
