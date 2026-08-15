import type { BoatState, FlightPhase, FlightRouteState } from '../contracts';

export type AbilityMode = 'idle' | 'drift' | 'boost' | 'airbrake' | 'flight' | 'finish';
export type FlightUiMode = 'stored' | 'locked' | 'active' | 'extend' | 'finish';
export type AbilityUrgency = 'normal' | 'soon' | 'critical';

export interface ActionTelemetry {
  boostCharge: number;
  driftBankProgress: number;
  boostRemaining: number;
  drifting: boolean;
  boosting: boolean;
  driftReleaseReady: boolean;
  flightPhase: FlightPhase;
  flightRemaining: number;
  flightCharges: number;
  flightExtensionReady: boolean;
  flightExtensionUsed: boolean;
  flightAirBrake: number;
  flightRouteState: FlightRouteState;
  flightsCleared: number;
}

export interface AbilityHudState extends ActionTelemetry {
  leftMode: AbilityMode;
  flightMode: FlightUiMode;
  urgency: AbilityUrgency;
  extendUrgent: boolean;
  showNearRail: boolean;
}

export const FLIGHT_SOON = 0.28;
export const FLIGHT_CRITICAL = 0.16;

export function actionTelemetry(st: BoatState): ActionTelemetry {
  return {
    boostCharge: st.boostCharge,
    driftBankProgress: st.driftBankProgress,
    boostRemaining: st.boostRemaining,
    drifting: st.drifting,
    boosting: st.boosting,
    driftReleaseReady: st.driftReleaseReady,
    flightPhase: st.flightPhase,
    flightRemaining: st.flightRemaining,
    flightCharges: st.flightCharges,
    flightExtensionReady: st.flightExtensionReady,
    flightExtensionUsed: st.flightExtensionUsed,
    flightAirBrake: st.flightAirBrake,
    flightRouteState: st.flightRouteState,
    flightsCleared: st.flightsCleared,
  };
}

export function deriveAbilityHudState(st: BoatState, finalStationArmed = false): AbilityHudState {
  const flightActive = st.flightPhase !== 'surface';
  const finalRoute = finalStationArmed;
  const airbraking = flightActive && st.flightAirBrake > 0.18;
  const leftMode: AbilityMode = finalRoute
    ? 'finish'
    : airbraking ? 'airbrake' : st.drifting ? 'drift' : st.boosting ? 'boost' : 'idle';
  const canExtend = st.flightExtensionReady && !finalRoute;
  const urgency: AbilityUrgency = flightActive && st.flightRemaining <= FLIGHT_CRITICAL
    ? 'critical'
    : flightActive && st.flightRemaining <= FLIGHT_SOON
      ? 'soon'
      : 'normal';
  const flightMode: FlightUiMode = finalRoute
    ? 'finish'
    : canExtend ? 'extend' : flightActive ? 'active' : st.flightCharges > 0 ? 'stored' : 'locked';
  return {
    ...actionTelemetry(st),
    leftMode,
    flightMode,
    urgency,
    extendUrgent: canExtend && urgency !== 'normal',
    showNearRail: st.drifting || st.boosting || flightActive || st.flightCharges > 0 || finalRoute,
  };
}
