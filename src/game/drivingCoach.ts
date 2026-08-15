import type { BoatInput, BoatState, FlightRouteFailReason } from '../contracts';

export type CoachStatus = 'dormant' | 'active' | 'disabled' | 'complete' | 'expert';
export type CoachInputDevice = 'keyboard' | 'gamepad' | 'mobile';
export type CoachFocus =
  | 'steer-control'
  | 'drift-control'
  | 'drift-meter'
  | 'flight-stock'
  | 'flight-control'
  | 'flight-meter';

export interface CoachMastery {
  steered: boolean;
  bankedCharge: boolean;
  launched: boolean;
  passedRoute: boolean;
  airBrakedInTurn: boolean;
  extendedFlight: boolean;
}

export interface CoachKnowledge {
  bankRule: boolean;
  inventory: boolean;
  flightGauge: boolean;
  extension: boolean;
}

export interface DrivingCoachProgress {
  status: CoachStatus;
  /** Fresh saves and a narrowly repaired dormant rollout may arm once after failure. */
  automaticEligible: boolean;
  mastery: CoachMastery;
  knowledge: CoachKnowledge;
}

export interface CoachControls {
  steer: string;
  drift: string;
  flight: string;
}

export interface CoachPresentation {
  id: 'steer' | 'drift' | 'bank' | 'release' | 'banked' | 'launch' | 'flight-gauge' | 'air-brake' | 'extension';
  focus: CoachFocus;
  stage: string;
  control: string;
  kicker: string;
  title: string;
  detail: string;
  tone: 'surface' | 'flight' | 'warning' | 'info';
}

export interface CoachFrame {
  state: BoatState;
  input: BoatInput;
  guideActive: boolean;
  turnWarning: boolean;
  presentationBlocked: boolean;
}

const CORE_MASTERY: readonly (keyof CoachMastery)[] = [
  'steered', 'bankedCharge', 'launched', 'passedRoute', 'airBrakedInTurn',
];

export function freshCoachProgress(status: CoachStatus = 'dormant', automaticEligible = true): DrivingCoachProgress {
  return {
    status,
    automaticEligible,
    mastery: {
      steered: false,
      bankedCharge: false,
      launched: false,
      passedRoute: false,
      airBrakedInTurn: false,
      extendedFlight: false,
    },
    knowledge: {
      bankRule: false,
      inventory: false,
      flightGauge: false,
      extension: false,
    },
  };
}

export function migratedCoachProgress(bestFlights: number, ordinaryUnlocked: boolean): DrivingCoachProgress {
  const expert = bestFlights >= 3 || ordinaryUnlocked;
  // A legacy save is a returning player, not a first-time arrival. Preserve
  // proven actions but never surprise it with the new automatic guide.
  const progress = freshCoachProgress(expert ? 'expert' : 'dormant', false);
  if (bestFlights >= 1 || ordinaryUnlocked) {
    progress.mastery.bankedCharge = true;
    progress.mastery.launched = true;
    progress.mastery.passedRoute = true;
  }
  if (expert) {
    progress.mastery.steered = true;
    progress.knowledge.bankRule = true;
    progress.knowledge.inventory = true;
    progress.knowledge.flightGauge = true;
  }
  return progress;
}

export function sanitizeCoachProgress(
  value: unknown,
  bestFlights: number,
  ordinaryUnlocked: boolean,
  automaticDefault = false,
): DrivingCoachProgress {
  const migrated = automaticDefault
    ? freshCoachProgress(bestFlights >= 3 || ordinaryUnlocked ? 'expert' : 'dormant', !(bestFlights >= 3 || ordinaryUnlocked))
    : migratedCoachProgress(bestFlights, ordinaryUnlocked);
  if (!value || typeof value !== 'object') return migrated;
  const source = value as Partial<DrivingCoachProgress>;
  const statuses: readonly CoachStatus[] = ['dormant', 'active', 'disabled', 'complete', 'expert'];
  const progress = freshCoachProgress(
    statuses.includes(source.status as CoachStatus) ? source.status as CoachStatus : migrated.status,
    typeof source.automaticEligible === 'boolean' ? source.automaticEligible : migrated.automaticEligible,
  );
  const mastery = source.mastery && typeof source.mastery === 'object' ? source.mastery as Partial<CoachMastery> : {};
  const knowledge = source.knowledge && typeof source.knowledge === 'object' ? source.knowledge as Partial<CoachKnowledge> : {};
  for (const key of Object.keys(progress.mastery) as (keyof CoachMastery)[]) {
    progress.mastery[key] = mastery[key] === true || migrated.mastery[key];
  }
  for (const key of Object.keys(progress.knowledge) as (keyof CoachKnowledge)[]) {
    progress.knowledge[key] = knowledge[key] === true || migrated.knowledge[key];
  }
  if ((bestFlights >= 3 || ordinaryUnlocked) && progress.status === 'dormant') progress.status = 'expert';
  if (progress.status !== 'dormant') progress.automaticEligible = false;
  return progress;
}

/**
 * Presentation-only teaching policy. It observes successful simulation edges
 * but never writes input, physics, race phase, or course state.
 */
export class DrivingCoach {
  readonly progress: DrivingCoachProgress;
  private previousCharges = 0;
  private previousPhase: BoatState['flightPhase'] = 'surface';
  private previousRouteState: BoatState['flightRouteState'] = 'idle';
  private sawBankReady = false;
  private airBrakeAppliedThisRoute = false;
  private runElapsed = 0;
  private reinforcement: 'banked' | 'inventory' | null = null;
  private reinforcementTimer = 0;
  private flightGaugeTimer = 0;
  private extensionTimer = 0;
  private preferSteerLesson = false;

  constructor(progress: DrivingCoachProgress, private readonly persist: (progress: DrivingCoachProgress) => void) {
    this.progress = progress;
  }

  resetRun(state: BoatState): void {
    this.previousCharges = state.flightCharges;
    this.previousPhase = state.flightPhase;
    this.previousRouteState = state.flightRouteState;
    this.sawBankReady = false;
    this.airBrakeAppliedThisRoute = false;
    this.runElapsed = 0;
    this.reinforcement = null;
    this.reinforcementTimer = 0;
    this.flightGaugeTimer = 0;
    this.extensionTimer = 0;
  }

  onFailure(flightsCleared: number, reason: FlightRouteFailReason, medalAlreadyEarned: boolean): boolean {
    if (this.progress.status !== 'dormant') return false;
    if (flightsCleared >= 3 || medalAlreadyEarned) {
      this.setStatus('expert');
      return false;
    }
    if (!this.progress.automaticEligible) return false;
    this.preferSteerLesson = reason === 'off_course' || reason === 'wrong_way';
    this.setStatus('active');
    // A no-input course failure is the only time the automatic-throttle fact
    // needs to enter the core sequence. Other failures keep a proven steer bit.
    if ((reason === 'off_course' || reason === 'wrong_way') && !this.progress.mastery.steered) {
      this.runElapsed = 0;
    }
    return true;
  }

  enable(): void {
    if (this.progress.status === 'active') return;
    this.setStatus('active');
  }

  disable(): void {
    if (this.progress.status === 'disabled') return;
    this.setStatus('disabled');
  }

  markExpert(): void {
    if (this.progress.status === 'dormant' || this.progress.status === 'active') this.setStatus('expert');
  }

  update(dt: number, frame: CoachFrame, controls: CoachControls): CoachPresentation | null {
    const { state, input } = frame;
    this.runElapsed += dt;
    let dirty = false;

    if (!this.progress.mastery.steered && Math.abs(input.steer) >= 0.35 && state.speed > 8) {
      this.progress.mastery.steered = true;
      dirty = true;
    }
    if (state.driftReleaseReady) this.sawBankReady = true;
    if (!this.progress.mastery.bankedCharge && state.flightCharges > this.previousCharges && this.sawBankReady) {
      this.progress.mastery.bankedCharge = true;
      if (this.progress.status === 'active') {
        this.progress.knowledge.bankRule = true;
        this.progress.knowledge.inventory = true;
        this.reinforcement = state.flightCharges >= 2 ? 'inventory' : 'banked';
        this.reinforcementTimer = 2.8;
      }
      this.sawBankReady = false;
      dirty = true;
    } else if (this.progress.status === 'active' && state.flightCharges >= 2 && this.previousCharges < 2 && !this.progress.knowledge.inventory) {
      this.progress.knowledge.inventory = true;
      this.reinforcement = 'inventory';
      this.reinforcementTimer = 3.8;
      dirty = true;
    }
    if (!this.progress.mastery.launched && state.flightPhase === 'spool' && this.previousPhase === 'surface' &&
        state.flightCharges < this.previousCharges) {
      this.progress.mastery.launched = true;
      dirty = true;
    }
    if (frame.turnWarning && state.flightAirBrake > 0.28 && Math.abs(state.steer) > 0.12) {
      this.airBrakeAppliedThisRoute = true;
    }
    if (state.flightRouteState === 'passed' && this.previousRouteState !== 'passed') {
      if (!this.progress.mastery.passedRoute) {
        this.progress.mastery.passedRoute = true;
        dirty = true;
      }
      if (this.airBrakeAppliedThisRoute && !this.progress.mastery.airBrakedInTurn) {
        this.progress.mastery.airBrakedInTurn = true;
        dirty = true;
      }
      this.airBrakeAppliedThisRoute = false;
    } else if (state.flightRouteState === 'failed' && this.previousRouteState !== 'failed') {
      this.airBrakeAppliedThisRoute = false;
    }
    if (state.flightExtended && !this.progress.mastery.extendedFlight) {
      this.progress.mastery.extendedFlight = true;
      this.progress.knowledge.extension = true;
      dirty = true;
    }
    if (this.progress.status === 'active' && state.flightPhase === 'cruise' && !this.progress.knowledge.flightGauge && state.flightsCleared === 0) {
      this.progress.knowledge.flightGauge = true;
      this.flightGaugeTimer = 3.2;
      dirty = true;
    }
    if (this.progress.status === 'active' && state.flightExtensionReady && !this.progress.knowledge.extension) {
      this.progress.knowledge.extension = true;
      this.extensionTimer = 3.8;
      dirty = true;
    }

    if (this.progress.status === 'active' && CORE_MASTERY.every((key) => this.progress.mastery[key]) &&
        this.progress.knowledge.bankRule && this.progress.knowledge.flightGauge) {
      this.progress.status = 'complete';
      dirty = true;
    }
    if (dirty) this.persist(this.progress);

    this.previousCharges = state.flightCharges;
    this.previousPhase = state.flightPhase;
    this.previousRouteState = state.flightRouteState;
    const presentationDt = frame.presentationBlocked ? 0 : dt;
    this.reinforcementTimer = Math.max(0, this.reinforcementTimer - presentationDt);
    this.flightGaugeTimer = Math.max(0, this.flightGaugeTimer - presentationDt);
    this.extensionTimer = Math.max(0, this.extensionTimer - presentationDt);

    if (this.progress.status !== 'active') return null;
    if (this.runElapsed < 1.45) return null;
    if (frame.turnWarning && state.flightsCleared >= 1 && !this.progress.mastery.airBrakedInTurn) {
      return {
        id: 'air-brake', focus: 'drift-control', stage: '空中转向', control: controls.drift,
        kicker: '急弯 · AIR BRAKE',
        title: `按住 ${controls.drift} 空刹`, detail: `${controls.steer} 对准青线 · 穿过两杆`, tone: 'warning',
      };
    }
    if (frame.presentationBlocked) return null;
    if (this.reinforcementTimer > 0 && this.reinforcement === 'banked') {
      return {
        id: 'banked', focus: 'flight-stock', stage: '入库完成', control: controls.flight,
        kicker: '已存 1 格 · 最多 2 格', title: '菱形 = 可用飞行次数',
        detail: '漂过黄线继续蓄，只延长水面 BOOST · 不会延长飞行', tone: 'info',
      };
    }
    if (this.reinforcementTimer > 0 && this.reinforcement === 'inventory') {
      return {
        id: 'banked', focus: 'flight-stock', stage: '飞行库存', control: controls.flight,
        kicker: '库存 2 / 2', title: '起飞用 1 格',
        detail: '备用格可留到下一飞 · 或在空中续航', tone: 'info',
      };
    }
    if (this.progress.mastery.bankedCharge && !this.progress.knowledge.bankRule &&
        state.flightPhase === 'surface' && state.speed > 12) {
      this.progress.knowledge.bankRule = true;
      this.progress.knowledge.inventory = true;
      this.reinforcement = 'banked';
      this.reinforcementTimer = 2.8;
      this.persist(this.progress);
      return {
        id: 'banked', focus: 'flight-stock', stage: '规则校准', control: controls.flight,
        kicker: `已会入库 · ${controls.flight} 起飞`, title: '菱形才是飞行库存',
        detail: '漂移时长只影响水面 BOOST · 基础飞行时间固定', tone: 'info',
      };
    }
    if (!this.progress.mastery.steered && this.runElapsed >= 0.7 &&
        (this.preferSteerLesson || this.progress.mastery.bankedCharge)) {
      return {
        id: 'steer', focus: 'steer-control', stage: '转向', control: controls.steer,
        kicker: 'AUTO THROTTLE', title: `船会自己冲 · 只管 ${controls.steer}`,
        detail: '轻调方向，回到主航线', tone: 'surface',
      };
    }
    if (!this.progress.mastery.bankedCharge && state.flightPhase === 'surface' && state.speed > 12 && state.flightCharges < 2) {
      if (state.driftReleaseReady) return {
        id: 'release', focus: 'drift-meter', stage: '漂移蓄能', control: controls.drift,
        kicker: '黄线 = 已够 1 格', title: `现在松开 ${controls.drift}`,
        detail: '松开才会存入飞行库存', tone: 'surface',
      };
      if (state.drifting) return {
        id: 'bank', focus: 'drift-meter', stage: '漂移蓄能', control: controls.drift,
        kicker: 'DRIFT CHARGE', title: `继续按住 ${controls.drift}`,
        detail: '看船边左条 · 到黄色刻度再松开', tone: 'surface',
      };
      return {
        id: 'drift', focus: 'drift-control', stage: controls.drift === 'SHIFT' ? 'PC 漂移' : '漂移', control: controls.drift,
        kicker: 'DRIFT → BANK', title: controls.drift.includes('「漂」') ? `按住 ${controls.drift}` : `按住 ${controls.drift} 漂移`,
        detail: '船边左条会开始蓄力 · 黄线后才够 1 格', tone: 'surface',
      };
    }
    if (!this.progress.mastery.launched && state.flightCharges > 0 && frame.guideActive && state.flightPhase === 'surface') {
      return {
        id: 'launch', focus: 'flight-control', stage: '起飞', control: controls.flight,
        kicker: '青色飞行分支已展开', title: `按 ${controls.flight} 起飞`,
        detail: '消耗 1 格 · 沿青线穿过两杆', tone: 'flight',
      };
    }
    if (state.flightPhase === 'cruise' && state.flightsCleared === 0 && this.flightGaugeTimer > 0) {
      return {
        id: 'flight-gauge', focus: 'flight-meter', stage: '飞行读条', control: '',
        kicker: 'FLIGHT TIMER', title: '右条 = 本次飞行剩余时间',
        detail: '两颗菱形才是可用库存', tone: 'flight',
      };
    }
    if (state.flightExtensionReady && state.flightCharges > 0 && this.extensionTimer > 0 && !this.progress.mastery.extendedFlight) {
      return {
        id: 'extension', focus: 'flight-control', stage: '可选续航', control: controls.flight,
        kicker: '备用格可续航', title: `再按 ${controls.flight} · 续航 +2.4s`,
        detail: '消耗 1 格 · 一飞最多续一次', tone: 'flight',
      };
    }
    return null;
  }

  private setStatus(status: CoachStatus): void {
    this.progress.status = status;
    if (status !== 'dormant') this.progress.automaticEligible = false;
    this.persist(this.progress);
  }
}
