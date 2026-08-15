/**
 * audio.ts — Ghibli/Celtic orchestral acoustic score ("Flight Over Azure Waters")
 * plus a restrained synthesized vehicle layer.
 *
 * Graph (built lazily on first resume(), i.e. first user gesture):
 *
 *   engine:  saw(−7¢) ─┐
 *            saw(+6¢) ─┼─► waveshaper(light grit) ─► lowpass ─► engineGain ──┐
 *            sine(sub)─┤   ▲                                                  │
 *            saw(+1oct)─► boostGain ──────────────────────────────────────────┤
 *   score:   HTMLAudioElement ─► media source ─► music bus ───────────────────┤
 *   music / ambience events / vehicle / event buses ─► master ─► limiter ─► destination
 *
 * All continuous params move via setTargetAtTime (no zipper noise), and the
 * set* hot paths allocate nothing — every node there is built once in build().
 * One-shots allocate their short-lived nodes per call and self-disconnect.
 * Every method is a harmless no-op until resume() has built the context.
 */
import gliderThemeOgg from '../assets/audio/wind-glider-theme.ogg?url';
import gliderThemeMp3 from '../assets/audio/wind-glider-theme.mp3?url';

export type CountdownStartDisposition = 'played' | 'context_suspended' | 'muted' | 'unavailable';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const AUDIO_STORAGE_KEY = 'board-race.audio.v1';
const SAFETY_HIGHPASS_HZ = 48;
const LIMITER_THRESHOLD_DB = -14;
const LIMITER_RATIO = 16;
const COUNTDOWN_TICK_HZ = 880;
const COUNTDOWN_TICK_PEAK = 0.15;
const START_SIGNAL_TOP_HZ = 1320;
const START_SIGNAL_PEAK = 0.28;

export type GameAudioScene =
  | 'ready'
  | 'countdown'
  | 'racing'
  | 'flight'
  | 'medal'
  | 'defeat'
  | 'lesson'
  | 'hidden';

export interface AudioSettings {
  master: number;
  music: number;
  sfx: number;
  ambience: number;
  muted: boolean;
}

const DEFAULT_SETTINGS: AudioSettings = {
  master: 0.7,
  music: 0.78,
  sfx: 0.65,
  ambience: 0.12,
  muted: false,
};

const gainCurve = (value: number): number => clamp01(value) ** 1.5;

/** Soft acoustic-wood saturation curve for natural wooden hull resonance. */
const makeGritCurve = (): Float32Array<ArrayBuffer> => {
  const n = 256;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(1.5 * x) / Math.tanh(1.5);
  }
  return curve;
};

export class GameAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private musicFilter: BiquadFilterNode | null = null;
  private ambienceBus: GainNode | null = null;
  private vehicleBus: GainNode | null = null;
  private eventBus: GainNode | null = null;
  private musicElement: HTMLAudioElement | null = null;
  private musicSource: MediaElementAudioSourceNode | null = null;
  private musicReady = false;
  private musicFailed = false;
  private scoreArmed = false;
  private readyMusicActive = false;
  private ambiencePreviewToken = 0;
  private ambiencePreview = false;
  private countdownStageValue = 3;
  private startSignalEvents = 0;
  private countdownFallbackEvents = 0;
  private lastGoDisposition: CountdownStartDisposition = 'unavailable';
  private contextStateAtGo = 'unavailable';
  private resumeAttempts = 0;
  private resumeFailures = 0;
  private resumePending: Promise<void> | null = null;
  private raceScoreElapsed = 0;
  private lastFlowStep = -1;
  private lastDriftTier = 0;
  private musicDuckUntil = 0;
  private musicDuckMultiplier = 1;
  private vehicleDuckUntil = 0;
  private vehicleDuckMultiplier = 1;
  private noiseBuf: AudioBuffer | null = null;
  private settings: AudioSettings = loadAudioSettings();
  private scene: GameAudioScene = 'ready';
  private sceneBeforeHidden: GameAudioScene = 'ready';
  private retryVariation = 0;
  private lastFailureAt = -Infinity;
  private activeOneShots = 0;
  private readonly maxOneShots = 24;
  private noiseCursor = 0;
  private lastCollisionAt = -Infinity;
  private lastSplashAt = -Infinity;
  private collisionEvents = 0;
  private splashEvents = 0;
  private coalescedCollisionEvents = 0;
  private coalescedSplashEvents = 0;
  private readonly eventTrace: Array<{ source: string; time: number; strength: number }> = [];
  private flightExtendEvents = 0;
  private lastDriverSelectAt = -Infinity;
  private driverSelectEvents = 0;
  private lastDriverSelectIndex = -1;

  // engine nodes
  private saw1: OscillatorNode | null = null;
  private saw2: OscillatorNode | null = null;
  private sub: OscillatorNode | null = null;
  private boostOsc: OscillatorNode | null = null;
  private boostGain: GainNode | null = null;
  private engineGain: GainNode | null = null;
  private engineLp: BiquadFilterNode | null = null;

  // anti-grav nodes
  private flightOsc: OscillatorNode | null = null;
  private flightHarm: OscillatorNode | null = null;
  private flightGain: GainNode | null = null;
  private flightNoiseGain: GainNode | null = null;
  private flightNoiseBp: BiquadFilterNode | null = null;

  // drift carve noise
  private driftGain: GainNode | null = null;
  private driftBp: BiquadFilterNode | null = null;

  // continuous-state mirrors (also used to skip redundant param events)
  private speedNorm = 0;
  private airborne = false;
  private flightActive = false;
  private lastRpm = -1;
  private lastThrottle = -1;
  private lastBoost = false;
  private lastFlightThrust = -1;
  private lastFlightIndex = -1;
  private flightPressure = 0;
  private flightClearance = 0;
  private flightAirBrake = 0;
  private flightSteer = 0;

  /** Call on first user gesture. Safe to call repeatedly. */
  resume(): void {
    if (!this.ctx) {
      try {
        this.build();
      } catch {
        this.ctx = null; // audio unavailable — every call stays a no-op
        return;
      }
    }
    const c = this.ctx;
    if (c && !document.hidden) {
      if (c.state === 'suspended') {
        if (this.resumePending) return;
        this.resumeAttempts++;
        this.resumePending = c.resume().then(() => {
          this.applyMix(0.28);
          if (this.scoreArmed || this.readyMusicActive) this.ensureMusicPlaying();
        }).catch(() => {
          this.resumeFailures++;
        }).finally(() => {
          this.resumePending = null;
        });
      } else if (c.state === 'running') {
        // A very short app switch can restore visibility before the delayed
        // suspend runs. The next explicit gesture must still restore the mix.
        this.applyMix(0.28);
        if (this.scoreArmed || this.readyMusicActive) this.ensureMusicPlaying();
      }
    }
  }

  update(dt: number): void {
    if (this.ctx && this.musicDuckMultiplier < 1 && this.ctx.currentTime >= this.musicDuckUntil) {
      this.musicDuckMultiplier = 1;
      this.applyMix(0.06);
    }
    if (this.ctx && this.vehicleDuckMultiplier < 1 && this.ctx.currentTime >= this.vehicleDuckUntil) {
      this.vehicleDuckMultiplier = 1;
      this.applyMix(0.06);
    }
    if (!this.scoreArmed || (this.scene !== 'racing' && this.scene !== 'flight')) return;
    this.raceScoreElapsed += dt;
    const flowStep = Math.floor(this.raceScoreElapsed * 4);
    if (flowStep !== this.lastFlowStep) {
      this.lastFlowStep = flowStep;
      this.applyMix(0.42);
    }
  }

  getSettings(): AudioSettings {
    return { ...this.settings };
  }

  setSettings(next: Partial<AudioSettings>): void {
    this.settings = {
      master: clamp01(next.master ?? this.settings.master),
      music: clamp01(next.music ?? this.settings.music),
      sfx: clamp01(next.sfx ?? this.settings.sfx),
      ambience: clamp01(next.ambience ?? this.settings.ambience),
      muted: next.muted ?? this.settings.muted,
    };
    saveAudioSettings(this.settings);
    this.applyMix(0.04);
  }

  toggleMute(): boolean {
    this.setSettings({ muted: !this.settings.muted });
    return this.settings.muted;
  }

  setScene(scene: GameAudioScene): void {
    if (scene === this.scene) return;
    this.scene = scene;
    if (scene === 'ready') {
      // READY may carry the same score after the first explicit gesture. A
      // genuinely untouched page remains silent because browser autoplay
      // policy has not granted an audio gesture yet.
      if (!this.scoreArmed && !this.readyMusicActive) this.musicElement?.pause();
      if (!this.scoreArmed && !this.readyMusicActive && this.ctx && this.musicBus) {
        this.musicBus.gain.cancelScheduledValues(this.ctx.currentTime);
        this.musicBus.gain.value = 0;
      }
    }
    this.applyMix(scene === 'defeat' || scene === 'lesson' ? 0.08 : 0.14);
    if (scene !== 'hidden' && (this.scoreArmed || this.readyMusicActive)) this.ensureMusicPlaying();
  }

  /** Start the score behind the driver contract after a real user gesture. */
  startReadyMusic(): void {
    if (this.scoreArmed) {
      this.resume();
      return;
    }
    this.readyMusicActive = true;
    this.resume();
    if (this.ctx?.state === 'running') {
      this.applyMix(0.18);
      this.ensureMusicPlaying();
    }
  }

  /** Arm the formal score from an explicit GO without restarting READY music. */
  startRaceScore(fresh: boolean): void {
    const continuedReadyMusic = this.readyMusicActive && !this.scoreArmed;
    this.resume();
    const firstStart = !this.scoreArmed;
    this.scoreArmed = true;
    this.readyMusicActive = false;
    this.countdownStageValue = 3;
    if (fresh && firstStart && !continuedReadyMusic) {
      this.raceScoreElapsed = 0;
      this.lastFlowStep = -1;
      if (this.musicElement) {
        try {
          this.musicElement.currentTime = 0;
        } catch {
          // Metadata may still be loading. Playback starts from the browser's
          // initial position until the next fresh run.
        }
      }
    }
    this.applyMix(0.12);
    this.ensureMusicPlaying();
  }

  /** Open the score one layer at a time behind the 3/2/1 count. */
  countdownStage(n: number): void {
    this.countdownStageValue = Math.max(1, Math.min(3, Math.round(n)));
    this.applyMix(0.075);
  }

  /**
   * A single, non-verbal start signal at GO. 3/2/1 stay clean ticks and
   * lights. Keeping this entirely synthesized avoids a late/uncanny voice on
   * cold mobile audio contexts and gives the race a deterministic attack.
   */
  startSignal(): CountdownStartDisposition {
    const c = this.ctx;
    this.contextStateAtGo = c?.state ?? 'unavailable';
    if (this.settings.muted || this.settings.master <= 0 || this.settings.sfx <= 0) {
      return this.lastGoDisposition = 'muted';
    }
    if (!c || c.state !== 'running') {
      this.resume();
      return this.lastGoDisposition = 'context_suspended';
    }
    const t = c.currentTime;
    // A short low punch plus a bright, rising confirmation is legible on both
    // phone speakers and a controller headset without adding speech or noise.
    this.blip(196, t, 0.16, 0.25, 'sine');
    this.blip(1040, t + 0.025, 0.34, START_SIGNAL_PEAK, 'triangle');
    this.blip(START_SIGNAL_TOP_HZ, t + 0.07, 0.42, 0.18, 'triangle');
    this.startSignalEvents++;
    this.duckMusic(0.48, 0.32);
    this.duckVehicle(0.44, 0.32);
    return this.lastGoDisposition = 'played';
  }

  debugState(): Record<string, number | string | boolean> {
    return {
      scene: this.scene,
      contextState: this.ctx?.state ?? 'unavailable',
      muted: this.settings.muted,
      master: this.settings.master,
      music: this.settings.music,
      sfx: this.settings.sfx,
      ambience: this.settings.ambience,
      activeOneShots: this.activeOneShots,
      flightExtendEvents: this.flightExtendEvents,
      driverSelectEvents: this.driverSelectEvents,
      lastDriverSelectIndex: this.lastDriverSelectIndex,
      outputGain: this.master?.gain.value ?? 0,
      musicBusGain: this.musicBus?.gain.value ?? 0,
      musicFilterHz: this.musicFilter?.frequency.value ?? 0,
      ambienceBusGain: this.ambienceBus?.gain.value ?? 0,
      vehicleBusGain: this.vehicleBus?.gain.value ?? 0,
      eventBusGain: this.eventBus?.gain.value ?? 0,
      musicReady: this.musicReady,
      musicFailed: this.musicFailed,
      musicPlaying: this.musicElement ? !this.musicElement.paused : false,
      musicTime: this.musicElement?.currentTime ?? 0,
      musicDuration: Number.isFinite(this.musicElement?.duration) ? this.musicElement?.duration ?? 0 : 0,
      musicLoop: this.musicElement?.loop ?? false,
      scoreArmed: this.scoreArmed,
      readyMusicActive: this.readyMusicActive,
      countdownStage: this.countdownStageValue,
      startSignalEvents: this.startSignalEvents,
      countdownFallbackEvents: this.countdownFallbackEvents,
      lastGoDisposition: this.lastGoDisposition,
      countdownTickHz: COUNTDOWN_TICK_HZ,
      startSignalTopHz: START_SIGNAL_TOP_HZ,
      countdownTickPeak: COUNTDOWN_TICK_PEAK,
      startSignalPeak: START_SIGNAL_PEAK,
      contextStateAtGo: this.contextStateAtGo,
      resumeAttempts: this.resumeAttempts,
      resumeFailures: this.resumeFailures,
      scoreElapsed: this.raceScoreElapsed,
      driftTier: this.lastDriftTier,
      musicDuck: this.musicDuckMultiplier,
      vehicleDuck: this.vehicleDuckMultiplier,
      scorePreroll: 0,
      safetyHighpassHz: SAFETY_HIGHPASS_HZ,
      limiterThresholdDb: LIMITER_THRESHOLD_DB,
      limiterRatio: LIMITER_RATIO,
      continuousAmbienceActive: false,
      maxOneShots: this.maxOneShots,
      collisionEvents: this.collisionEvents,
      splashEvents: this.splashEvents,
      coalescedCollisionEvents: this.coalescedCollisionEvents,
      coalescedSplashEvents: this.coalescedSplashEvents,
    };
  }

  /** Immediately silence background tabs; an explicit gesture restores audio. */
  setVisibility(hidden: boolean): void {
    const c = this.ctx;
    if (!c) return;
    if (hidden) {
      if (this.scene !== 'hidden') {
        this.sceneBeforeHidden = this.scene;
        this.scene = 'hidden';
      }
      this.applyMix(0.04);
      if (this.master) {
        this.master.gain.cancelScheduledValues(c.currentTime);
        this.master.gain.value = 0;
      }
      this.musicElement?.pause();
      window.setTimeout(() => {
        if ((document.hidden || this.scene === 'hidden') && c.state === 'running') void c.suspend();
      }, 90);
      return;
    }
    if (this.scene === 'hidden') this.scene = this.sceneBeforeHidden;
    // Browser autoplay policies intentionally leave the output at zero until
    // the resume GO gesture calls resume().
  }

  /** Mixer preview. Every preview is short and routed through the selected bus. */
  audition(kind: 'master' | 'music' | 'sfx' | 'ambience'): void {
    this.resume();
    if (kind === 'music') {
      if (this.scoreArmed || this.readyMusicActive) {
        this.applyMix(0.06);
        this.ensureMusicPlaying();
        return;
      }
      // An explicit music control is itself a valid gesture. Keep the READY
      // score running instead of turning it into a one-shot audition.
      this.startReadyMusic();
      return;
    }
    const c = this.ctx;
    const target = kind === 'ambience' ? this.ambienceBus : this.eventBus;
    if (!c || !target) return;
    if (kind === 'ambience') {
      // Environment audio is intentionally audit-only for now. Opening the
      // slider changes the bus and records the preview, but never invents a
      // wave/noise sample that the owner has not approved.
      const token = ++this.ambiencePreviewToken;
      if (this.scene === 'ready') {
        this.ambiencePreview = true;
        this.ambienceBus?.gain.cancelScheduledValues(c.currentTime);
        this.ambienceBus?.gain.setValueAtTime(gainCurve(this.settings.ambience) * 0.35, c.currentTime);
      }
      window.setTimeout(() => {
        if (token !== this.ambiencePreviewToken) return;
        this.ambiencePreview = false;
        this.applyMix(0.08);
      }, 420);
      return;
    }
    this.blip(kind === 'master' ? 720 : 960, c.currentTime, 0.22, 0.11, 'triangle');
  }

  collision(strength: number): void {
    const c = this.ctx;
    if (!c) return;
    if (c.currentTime - this.lastCollisionAt < 0.12) {
      this.coalescedCollisionEvents++;
      return;
    }
    this.lastCollisionAt = c.currentTime;
    this.collisionEvents++;
    this.traceEvent('collision', strength);
    const n = clamp01(strength / 18);
    this.impactBurst(118 - n * 34, 44 - n * 12, 0.38 + n * 0.52, 0.13 + n * 0.14);
    this.blip(210 - n * 70, c.currentTime, 0.12, 0.08 + n * 0.08, 'square');
    this.duckMusic(0.72 - n * 0.18, 0.12 + n * 0.1);
  }

  /** rpm 0..1, throttle 0..1, boosting adds a bright solar-lift harmonic layer. */
  setEngine(rpm: number, throttle: number, boosting: boolean): void {
    const c = this.ctx;
    if (!c || !this.saw1 || !this.saw2 || !this.sub || !this.boostOsc || !this.boostGain || !this.engineGain || !this.engineLp) {
      return;
    }
    const t = c.currentTime;

    const r = clamp01(rpm);
    if (Math.abs(r - this.lastRpm) > 0.002) {
      this.lastRpm = r;
      // Warm organic teak hull acoustic frequency profile
      const f = 48 + (196 - 48) * r;
      this.saw1.frequency.setTargetAtTime(f, t, 0.04);
      this.saw2.frequency.setTargetAtTime(f, t, 0.04);
      this.sub.frequency.setTargetAtTime(f * 0.5, t, 0.04);
      this.boostOsc.frequency.setTargetAtTime(f * 2, t, 0.04);
      this.engineLp.frequency.setTargetAtTime(360 + 1750 * r, t, 0.06);
    }

    const th = clamp01(throttle);
    if (Math.abs(th - this.lastThrottle) > 0.004) {
      this.lastThrottle = th;
      // Idle purr at 0.09, swells to 0.38 with throttle
      this.engineGain.gain.setTargetAtTime(0.09 + 0.29 * th, t, 0.07);
    }

    if (boosting !== this.lastBoost) {
      this.lastBoost = boosting;
      this.boostGain.gain.setTargetAtTime(boosting ? 0.22 : 0, t, boosting ? 0.018 : 0.11);
      this.applyRush();
      if (boosting) this.boostIgnition();
    }
  }

  /**
   * Kept as a lifecycle hook for the mixer contract. Continuous water-rush
   * noise is deliberately disabled until an owner-approved sample exists.
   */
  setWaterRush(speedNorm: number): void {
    this.speedNorm = clamp01(speedNorm);
  }

  /** Continuous air/water noise is disabled; tonal flight layers remain. */
  setAirborne(on: boolean): void {
    if (on === this.airborne) return;
    this.airborne = on;
  }

  /** Controlled flight crossfades water into directional pressure and lift layers. */
  setFlight(
    thrust: number,
    active: boolean,
    pressure = 0,
    clearance = 0,
    airBrake = 0,
    steer = 0,
    flightIndex = 0,
  ): void {
    const c = this.ctx;
    if (!c || !this.flightOsc || !this.flightHarm || !this.flightGain) return;
    const t = c.currentTime;
    const n = clamp01(thrust);
    this.flightPressure = clamp01(pressure);
    this.flightClearance = clamp01(clearance / 4.5);
    this.flightAirBrake = clamp01(airBrake);
    this.flightSteer = Math.max(-1, Math.min(1, steer));
    const index = Math.max(0, Math.min(2, Math.floor(flightIndex)));
    if (active !== this.flightActive) {
      this.flightActive = active;
      if (active) {
        this.impactBurst(124, 46, 0.85, 0.26);
        this.furinChime(880, t, 0.42, 0.18);
        this.duckMusic(0.64, 0.24);
      } else {
        this.blip(440, t, 0.12, 0.08, 'triangle');
      }
    }
    if (Math.abs(n - this.lastFlightThrust) > 0.004 || index !== this.lastFlightIndex) {
      this.lastFlightThrust = n;
      this.lastFlightIndex = index;
      const harmonic = [1, 1.08, 1.15][index];
      this.flightOsc.frequency.setTargetAtTime(88 + n * 76, t, 0.04);
      this.flightHarm.frequency.setTargetAtTime((264 + n * 184) * harmonic, t, 0.04);
      this.flightGain.gain.setTargetAtTime(active ? 0.05 + n * 0.16 : 0, t, active ? 0.025 : 0.16);
    }
    if (this.flightNoiseGain && this.flightNoiseBp) {
      this.flightNoiseGain.gain.setTargetAtTime(0, t, 0.08);
      this.flightNoiseBp.frequency.setTargetAtTime(620, t, 0.08);
    }
    if (this.engineGain) {
      const engineLevel = (0.09 + 0.29 * Math.max(0, this.lastThrottle)) * (active ? 0.68 : 1);
      this.engineGain.gain.setTargetAtTime(engineLevel, t, 0.12);
    }
  }

  /** Drift carving acoustic profile with multi-tier Japanese wind bell feedback. */
  setDrift(intensity: number): void {
    const c = this.ctx;
    if (!c || !this.driftGain || !this.driftBp) return;
    const n = clamp01(intensity);
    const t = c.currentTime;
    this.driftGain.gain.setTargetAtTime(n * 0.14, t, n > 0 ? 0.035 : 0.12);
    this.driftBp.frequency.setTargetAtTime(680 + n * 1150, t, 0.055);
    const tier = n >= 0.88 ? 3 : n >= 0.58 ? 2 : n >= 0.28 ? 1 : 0;
    if (tier > this.lastDriftTier) {
      this.lastDriftTier = tier;
      if (tier === 1) this.furinChime(783.99, t, 0.18, 0.06);
      else if (tier === 2) this.furinChime(1046.5, t, 0.24, 0.08);
      else this.furinChime(1318.51, t, 0.32, 0.095);
    } else if (n < 0.06) {
      this.lastDriftTier = 0;
    }
  }

  /** Crystal-clear Furin wind chime / bronze bell energy readiness fanfare. */
  flightReady(charges = 1): void {
    const c = this.ctx;
    if (!c) return;
    const t = c.currentTime;
    this.impactBurst(140, 62, 0.42, 0.16);
    if (charges >= 2) {
      // Dual crystal wind chime fanfare (Solarpunk high wind bell chord)
      this.furinChime(1046.5, t, 0.45, 0.19);
      this.furinChime(1567.98, t + 0.06, 0.52, 0.18);
      this.furinChime(2093.0, t + 0.12, 0.62, 0.16);
    } else {
      // Single crystal wind chime ring (Pentatonic Furin pair + crystal shimmer)
      this.furinChime(880, t, 0.42, 0.18);
      this.furinChime(1318.51, t + 0.065, 0.48, 0.16);
      this.furinChime(1760, t + 0.13, 0.56, 0.14);
    }
  }

  /** Mid-air flight extension: ascending updraft wind chimes. */
  flightExtend(): void {
    const c = this.ctx;
    if (!c) return;
    const t = c.currentTime;
    this.flightExtendEvents++;
    this.furinChime(783.99, t, 0.32, 0.14);
    this.furinChime(1046.5, t + 0.05, 0.4, 0.13);
    this.furinChime(1567.98, t + 0.11, 0.48, 0.11);
    this.duckMusic(0.8, 0.16);
  }

  driverSelected(index: number, direction: -1 | 1): void {
    const c = this.ctx;
    if (!c) return;
    if (c.currentTime - this.lastDriverSelectAt < 0.055) return;
    this.lastDriverSelectAt = c.currentTime;
    this.driverSelectEvents++;
    this.lastDriverSelectIndex = index;
    const notes = [392, 440, 494, 587, 659, 784];
    const root = notes[Math.max(0, Math.min(notes.length - 1, index))];
    const t = c.currentTime;
    if (this.noiseBuf && this.eventBus) {
      const snap = c.createBufferSource();
      snap.buffer = this.noiseBuf;
      const bp = c.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1800 + index * 140;
      bp.Q.value = 1.35;
      const pan = c.createStereoPanner();
      pan.pan.value = direction * 0.12;
      const gain = c.createGain();
      gain.gain.setValueAtTime(0.075, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      snap.connect(bp);
      bp.connect(pan);
      pan.connect(gain);
      gain.connect(this.eventBus);
      this.trackOneShot(snap, [bp, pan, gain], t, t + 0.18);
    }
    this.furinChime(root * (direction > 0 ? 1 : 0.94), t, 0.24, 0.11);
    this.blip(root * 1.5, t + 0.05, 0.22, 0.08, 'triangle');
  }

  /** Drift threshold achieved: crisp waterdrop Furin ping. */
  driftReleaseReady(): void {
    const c = this.ctx;
    if (!c) return;
    const t = c.currentTime;
    this.furinChime(1318.51, t, 0.22, 0.09);
    this.furinChime(1975.53, t + 0.038, 0.28, 0.075);
  }

  /** Ancient white stone arch passage: bronze furin bell resonance. */
  flightGate(index: number): void {
    const c = this.ctx;
    if (!c) return;
    const t = c.currentTime;
    const stoneNotes = [659.25, 783.99, 880, 987.77, 1046.5, 1174.66, 1318.51];
    const root = stoneNotes[Math.max(0, index - 1) % stoneNotes.length];
    this.impactBurst(134 + index * 7, 68, 0.42 + index * 0.08, 0.15);
    this.furinChime(root, t, 0.45, 0.18);
    this.furinChime(root * 1.5, t + 0.045, 0.52, 0.14);
    this.duckMusic(0.72, 0.14);
  }

  /** Flight branch clearance: celebratory Solarpunk wind chime arpeggio. */
  routeClear(flightNumber = 1): void {
    const c = this.ctx;
    if (!c) return;
    const t = c.currentTime;
    const step = Math.max(0, Math.min(2, flightNumber - 1));
    const roots = [
      [659.25, 830.61, 987.77, 1318.51], // E major pentatonic chord
      [783.99, 987.77, 1174.66, 1567.98], // G major pentatonic chord
      [880.0, 1108.73, 1318.51, 1760.0], // A major pentatonic chord
    ];
    const chord = roots[step];
    for (let i = 0; i < chord.length; i++) {
      this.furinChime(chord[i], t + i * 0.055, 0.48 + i * 0.08, 0.15);
    }
    this.duckMusic(0.72, 0.2);
  }

  flightMiss(): void {
    const c = this.ctx;
    if (!c) return;
    if (c.currentTime - this.lastFailureAt < 0.18) return;
    this.lastFailureAt = c.currentTime;
    this.impactBurst(92, 38, 0.62, 0.24);
    this.blip(190, c.currentTime, 0.24, 0.18, 'square');
  }

  raceBattle(kind: 'overtake' | 'lost', count: number, newPlace: number): void {
    const c = this.ctx;
    if (!c) return;
    const positive = kind === 'overtake';
    const strength = positive ? Math.min(1, 0.95 + Math.max(0, count - 1) * 0.05) : 0.58;
    this.impactBurst(positive ? 118 : 82, positive ? 48 : 34, strength, positive ? 0.25 : 0.18);
    const t = c.currentTime;
    this.blip(positive ? 560 : 260, t + 0.025, positive ? 0.16 : 0.2, 0.15 * strength, positive ? 'square' : 'sawtooth');
    if (positive) {
      this.blip(760 + count * 90, t + 0.1, 0.24, 0.14, 'triangle');
      if (newPlace === 1) this.furinChime(1480, t + 0.18, 0.45, 0.18);
    }
    this.duckMusic(positive ? 0.66 : 0.8, positive ? 0.2 : 0.13);
  }

  boostIgnition(): void {
    const c = this.ctx;
    if (!c) return;
    this.impactBurst(155, 58, 0.88, 0.24);
    this.furinChime(987.77, c.currentTime + 0.035, 0.32, 0.15);
    this.blip(480, c.currentTime + 0.018, 0.18, 0.14, 'triangle');
    this.duckMusic(0.69, 0.18);
  }

  airBrakeSnap(): void {
    const c = this.ctx;
    if (!c) return;
    this.impactBurst(200, 78, 0.42, 0.15);
    this.blip(340, c.currentTime, 0.12, 0.11, 'triangle');
    this.duckMusic(0.78, 0.11);
  }

  defeat(): void {
    const c = this.ctx;
    if (!c) return;
    this.lastFailureAt = c.currentTime;
    this.impactBurst(78, 24, 1, 0.55);
    this.blip(310, c.currentTime + 0.03, 0.42, 0.2, 'sawtooth');
    this.blip(196, c.currentTime + 0.12, 0.52, 0.18, 'square');
  }

  retryLesson(): void {
    const c = this.ctx;
    if (!c) return;
    const roots = [220, 247, 196, 262];
    const root = roots[this.retryVariation++ % roots.length];
    this.impactBurst(126, 58, 0.34, 0.14);
    this.furinChime(root, c.currentTime, 0.24, 0.12);
    this.furinChime(root * 2, c.currentTime + 0.07, 0.32, 0.1);
  }

  playMedalCeremony(): void {
    const c = this.ctx;
    if (!c) return;
    const t = c.currentTime;
    const notes = [164.81, 196, 246.94, 329.63, 392, 493.88, 659.25];
    for (let i = 0; i < notes.length; i++) {
      this.furinChime(notes[i], t + i * 0.1, i === notes.length - 1 ? 0.9 : 0.32, 0.18);
    }
    for (let i = 0; i < 7; i++) this.firework(t + 0.4 + i * 0.49, i);
  }

  /** Landing slam: resonant teak wood hull impact + lowpassed acoustic knock. */
  thud(strength: number): void {
    const c = this.ctx;
    if (!c || !this.eventBus || !this.noiseBuf) return;
    const s = clamp01(strength);
    if (s <= 0.001) return;
    if (this.activeOneShots + 2 >= this.maxOneShots) return;
    const t0 = c.currentTime;
    this.traceEvent('landing-thud', s);

    // Wooden hull cavity impact resonance
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(140, t0);
    o.frequency.exponentialRampToValueAtTime(38, t0 + 0.2);
    const og = c.createGain();
    og.gain.setValueAtTime(0, t0);
    og.gain.linearRampToValueAtTime(0.52 * s, t0 + 0.008);
    og.gain.exponentialRampToValueAtTime(0.001, t0 + 0.29);
    o.connect(og);
    og.connect(this.eventBus);
    this.trackOneShot(o, [og], t0, t0 + 0.31);

    // Solid wood acoustic transient
    const n = c.createBufferSource();
    n.buffer = this.noiseBuf;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 290;
    lp.Q.value = 1.1;
    const ng = c.createGain();
    ng.gain.setValueAtTime(0.34 * s, t0);
    ng.gain.exponentialRampToValueAtTime(0.001, t0 + 0.15);
    n.connect(lp);
    lp.connect(ng);
    ng.connect(this.eventBus);
    this.trackOneShot(n, [lp, ng], t0, t0 + 0.17, this.nextNoiseOffset(0.17));
  }

  /** Landing splash: crystalline water droplet foam spray + teak hull water-slap body. */
  splash(strength: number): void {
    const c = this.ctx;
    const bus = this.ambienceBus ?? this.eventBus;
    if (!c || !bus || !this.noiseBuf) return;
    const s = clamp01(strength);
    if (s <= 0.001) return;
    const t0 = c.currentTime;
    if (t0 - this.lastSplashAt < 0.12) {
      this.coalescedSplashEvents++;
      return;
    }
    if (this.activeOneShots >= this.maxOneShots) return;
    this.lastSplashAt = t0;
    this.splashEvents++;
    this.traceEvent('landing-splash', s);

    // 1. Crystalline water droplet foam spray (bandpass sweeping down)
    const n = c.createBufferSource();
    n.buffer = this.noiseBuf;
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.Q.value = 0.8;
    hp.frequency.setValueAtTime(3200, t0);
    hp.frequency.exponentialRampToValueAtTime(540, t0 + 0.3);
    const g = c.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.38 * s, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.32);
    n.connect(hp);
    hp.connect(g);
    g.connect(bus);
    this.trackOneShot(n, [hp, g], t0, t0 + 0.35, this.nextNoiseOffset(0.35));

    // 2. Teak hull water-slap body droplet resonance
    if (this.activeOneShots + 1 < this.maxOneShots) {
      const o = c.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(280, t0);
      o.frequency.exponentialRampToValueAtTime(95, t0 + 0.14);
      const og = c.createGain();
      og.gain.setValueAtTime(0, t0);
      og.gain.linearRampToValueAtTime(0.22 * s, t0 + 0.006);
      og.gain.exponentialRampToValueAtTime(0.001, t0 + 0.18);
      o.connect(og);
      og.connect(bus);
      this.trackOneShot(o, [og], t0, t0 + 0.2);
    }
  }

  /** Countdown tick stays restrained; GO fallback is deliberately one step louder. */
  countdownBeep(isGo: boolean): void {
    const c = this.ctx;
    if (!c) return;
    if (isGo) this.countdownFallbackEvents++;
    this.blip(isGo ? START_SIGNAL_TOP_HZ : COUNTDOWN_TICK_HZ, c.currentTime, isGo ? 0.4 : 0.12,
      isGo ? 0.3 : COUNTDOWN_TICK_PEAK, 'square');
  }

  /** Race-start confirmation: a short, non-verbal filtered triad. */
  horn(delay = 0): void {
    const c = this.ctx;
    if (!c || !this.eventBus) return;
    const t0 = c.currentTime + Math.max(0, delay);

    const g = c.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.3, t0 + 0.012);
    g.gain.setValueAtTime(0.3, t0 + 0.25);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.46);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2200;
    g.connect(lp);
    lp.connect(this.eventBus);

    const freqs = [196, 294, 392];
    let last: OscillatorNode | null = null;
    for (let i = 0; i < freqs.length; i++) {
      const o = c.createOscillator();
      o.type = i === 0 ? 'sine' : 'triangle';
      o.frequency.value = freqs[i];
      o.detune.value = (i - 1) * 5;
      o.connect(g);
      o.start(t0);
      o.stop(t0 + 0.5);
      o.onended = () => o.disconnect();
      last = o;
    }
    this.activeOneShots++;
    if (last) {
      const done = last;
      done.onended = () => {
        done.disconnect();
        g.disconnect();
        lp.disconnect();
        this.activeOneShots = Math.max(0, this.activeOneShots - 1);
      };
    }
  }

  /** Finish sting: quick rising 4-note Furin bell arpeggio (C5 E5 G5 C6). */
  finishSting(): void {
    const c = this.ctx;
    if (!c) return;
    const t0 = c.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.5];
    for (let i = 0; i < notes.length; i++) {
      this.furinChime(notes[i], t0 + i * 0.085, i === notes.length - 1 ? 0.65 : 0.38, 0.19);
    }
  }

  /**
   * Crystal-clear Japanese Furin wind chime / bronze bell synthesis.
   * Generates a pure fundamental with inharmonic strike overtones (2.756x, 5.404x)
   * and clean exponential ringing decay.
   */
  private furinChime(freq: number, t0: number, dur: number, peak: number, bus?: GainNode): void {
    const c = this.ctx;
    const targetBus = bus ?? this.eventBus;
    if (!c || !targetBus) return;
    if (this.activeOneShots + 2 >= this.maxOneShots) {
      this.blip(freq, t0, dur, peak, 'sine');
      return;
    }

    // 1. Fundamental ringing tone (pure singing sine)
    const o1 = c.createOscillator();
    o1.type = 'sine';
    o1.frequency.value = freq;
    const g1 = c.createGain();
    g1.gain.setValueAtTime(0, t0);
    g1.gain.linearRampToValueAtTime(peak, t0 + 0.003);
    g1.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
    o1.connect(g1);
    g1.connect(targetBus);
    this.trackOneShot(o1, [g1], t0, t0 + dur + 0.04);

    // 2. Inharmonic chime overtone (2.756 * f0 - physical bell mode)
    const o2 = c.createOscillator();
    o2.type = 'sine';
    o2.frequency.value = freq * 2.756;
    const g2 = c.createGain();
    g2.gain.setValueAtTime(0, t0);
    g2.gain.linearRampToValueAtTime(peak * 0.38, t0 + 0.002);
    g2.gain.exponentialRampToValueAtTime(0.0008, t0 + dur * 0.45);
    o2.connect(g2);
    g2.connect(targetBus);
    this.trackOneShot(o2, [g2], t0, t0 + dur * 0.45 + 0.03);

    // 3. Shimmering high crystal partial (5.404 * f0)
    if (this.activeOneShots + 1 < this.maxOneShots) {
      const o3 = c.createOscillator();
      o3.type = 'sine';
      o3.frequency.value = freq * 5.404;
      const g3 = c.createGain();
      g3.gain.setValueAtTime(0, t0);
      g3.gain.linearRampToValueAtTime(peak * 0.16, t0 + 0.002);
      g3.gain.exponentialRampToValueAtTime(0.0008, t0 + dur * 0.24);
      o3.connect(g3);
      g3.connect(targetBus);
      this.trackOneShot(o3, [g3], t0, t0 + dur * 0.24 + 0.02);
    }
  }

  // ------------------------------------------------------------------ internals ----

  private applyMix(timeConstant = 0.08): void {
    const c = this.ctx;
    if (!c || !this.master || !this.musicBus || !this.musicFilter || !this.ambienceBus || !this.vehicleBus || !this.eventBus) return;
    const t = c.currentTime;
    const muted = this.settings.muted || this.scene === 'hidden';
    const master = muted ? 0 : gainCurve(this.settings.master);
    const sceneMusic = this.sceneMusicLevel();
    if (t >= this.musicDuckUntil) this.musicDuckMultiplier = 1;
    const duck = t < this.musicDuckUntil ? this.musicDuckMultiplier : 1;
    const sceneVehicle = this.scene === 'medal' ? 0.25
      : this.scene === 'lesson' || this.scene === 'defeat' || this.scene === 'ready' ? 0
        : this.scene === 'countdown' ? 0.18
          : 1;
    const sceneAmbience = this.scene === 'ready' ? (this.ambiencePreview ? 0.35 : 0)
      : this.scene === 'medal' ? 0.18
        : this.scene === 'lesson' || this.scene === 'defeat' ? 0.12
          : 0.62;
    this.master.gain.setTargetAtTime(master, t, timeConstant);
    const musicBase = gainCurve(this.settings.music) * sceneMusic;
    this.musicBus.gain.cancelScheduledValues(t);
    this.musicBus.gain.setTargetAtTime(musicBase * duck, t, timeConstant);
    if (duck < 1) this.musicBus.gain.setTargetAtTime(musicBase, this.musicDuckUntil, 0.08);
    this.ambienceBus.gain.setTargetAtTime(gainCurve(this.settings.ambience) * sceneAmbience, t, timeConstant);
    const vehicleDuck = t < this.vehicleDuckUntil ? this.vehicleDuckMultiplier : 1;
    this.vehicleBus.gain.setTargetAtTime(gainCurve(this.settings.sfx) * sceneVehicle * vehicleDuck, t, timeConstant);
    this.eventBus.gain.setTargetAtTime(gainCurve(this.settings.sfx), t, timeConstant);
    this.musicFilter.frequency.setTargetAtTime(
      this.scene === 'lesson' || this.scene === 'defeat' ? 2200
        : this.scene === 'ready' ? 7500
          : this.scene === 'countdown' ? (this.countdownStageValue === 3 ? 1200 : this.countdownStageValue === 2 ? 3200 : 6800)
            : 16000,
      t,
      timeConstant,
    );
  }

  private sceneMusicLevel(): number {
    const countdownMusic = this.countdownStageValue === 3 ? 0.08
      : this.countdownStageValue === 2 ? 0.18
        : 0.34;
    const flow = clamp01(this.raceScoreElapsed / 14);
    switch (this.scene) {
      case 'ready': return this.scoreArmed ? 0.28 : this.readyMusicActive ? 0.4 : 0;
      case 'lesson': return 0.18;
      case 'defeat': return 0.22;
      case 'medal': return 0.38;
      case 'countdown': return countdownMusic;
      case 'flight': return 0.62 + flow * 0.26;
      case 'racing': return 0.52 + flow * 0.24;
      case 'hidden': return 0;
    }
  }

  private duckMusic(multiplier: number, duration: number): void {
    const c = this.ctx;
    const bus = this.musicBus;
    if (!c || !bus) return;
    const t = c.currentTime;
    const base = gainCurve(this.settings.music) * this.sceneMusicLevel();
    const active = t < this.musicDuckUntil;
    this.musicDuckMultiplier = active ? Math.min(this.musicDuckMultiplier, multiplier) : multiplier;
    this.musicDuckUntil = Math.max(active ? this.musicDuckUntil : 0, t + duration);
    bus.gain.cancelScheduledValues(t);
    bus.gain.setTargetAtTime(base * this.musicDuckMultiplier, t, 0.018);
    bus.gain.setTargetAtTime(base, this.musicDuckUntil, 0.08);
  }

  private duckVehicle(multiplier: number, duration: number): void {
    const c = this.ctx;
    const bus = this.vehicleBus;
    if (!c || !bus) return;
    const t = c.currentTime;
    const active = t < this.vehicleDuckUntil;
    this.vehicleDuckMultiplier = active ? Math.min(this.vehicleDuckMultiplier, multiplier) : multiplier;
    this.vehicleDuckUntil = Math.max(active ? this.vehicleDuckUntil : 0, t + duration);
    const sceneVehicle = this.scene === 'medal' ? 0.25
      : this.scene === 'lesson' || this.scene === 'defeat' || this.scene === 'ready' ? 0
        : this.scene === 'countdown' ? 0.18
          : 1;
    const base = gainCurve(this.settings.sfx) * sceneVehicle;
    bus.gain.cancelScheduledValues(t);
    bus.gain.setTargetAtTime(base * this.vehicleDuckMultiplier, t, 0.018);
    bus.gain.setTargetAtTime(base, this.vehicleDuckUntil, 0.08);
  }

  private firework(time: number, index: number): void {
    const c = this.ctx;
    const bus = this.eventBus;
    if (!c || !bus || !this.noiseBuf) return;
    const noise = c.createBufferSource();
    noise.buffer = this.noiseBuf;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 700 + (index % 4) * 420;
    bp.Q.value = 0.7;
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.13, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.24);
    noise.connect(bp);
    bp.connect(gain);
    gain.connect(bus);
    this.trackOneShot(noise, [bp, gain], time, time + 0.27, this.nextNoiseOffset(0.27));
  }

  private trackOneShot(
    source: AudioScheduledSourceNode,
    nodes: AudioNode[],
    start: number,
    stop: number,
    offset?: number,
  ): void {
    if (this.activeOneShots >= this.maxOneShots) {
      source.disconnect();
      for (const node of nodes) node.disconnect();
      return;
    }
    this.activeOneShots++;
    if (offset === undefined) source.start(start);
    else (source as AudioBufferSourceNode).start(start, offset);
    source.stop(stop);
    source.onended = () => {
      source.disconnect();
      for (const node of nodes) node.disconnect();
      this.activeOneShots = Math.max(0, this.activeOneShots - 1);
    };
  }

  private applyRush(): void {
    // Deliberately empty. The former shared white-noise rush/air loops were
    // difficult to identify on small speakers and are disabled pending an
    // explicitly reviewed environment recording.
  }

  private ensureMusicPlaying(): void {
    const media = this.musicElement;
    if (!media || (!this.scoreArmed && !this.readyMusicActive) || this.musicFailed || document.hidden || this.scene === 'hidden' || this.settings.muted) return;
    void media.play().catch(() => {
      // Autoplay refusal is expected until the next explicit pointer/key gesture.
    });
  }

  private impactBurst(startHz: number, endHz: number, strength: number, duration: number): void {
    const c = this.ctx;
    if (!c || !this.eventBus || !this.noiseBuf) return;
    if (this.activeOneShots + 2 >= this.maxOneShots) return;
    const s = clamp01(strength);
    const t0 = c.currentTime;
    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(startHz, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, endHz), t0 + duration);
    const og = c.createGain();
    og.gain.setValueAtTime(0.3 * s, t0);
    og.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
    osc.connect(og);
    og.connect(this.eventBus);
    this.activeOneShots++;
    osc.start(t0);
    osc.stop(t0 + duration + 0.03);
    osc.onended = () => {
      osc.disconnect();
      og.disconnect();
      this.activeOneShots = Math.max(0, this.activeOneShots - 1);
    };

    const noise = c.createBufferSource();
    noise.buffer = this.noiseBuf;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(900, t0);
    bp.frequency.exponentialRampToValueAtTime(280, t0 + duration);
    bp.Q.value = 0.8;
    const ng = c.createGain();
    ng.gain.setValueAtTime(0.2 * s, t0);
    ng.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
    noise.connect(bp);
    bp.connect(ng);
    ng.connect(this.eventBus);
    this.activeOneShots++;
    noise.start(t0, this.nextNoiseOffset(duration + 0.03));
    noise.stop(t0 + duration + 0.03);
    noise.onended = () => {
      noise.disconnect();
      bp.disconnect();
      ng.disconnect();
      this.activeOneShots = Math.max(0, this.activeOneShots - 1);
    };
  }

  /** Shared short-envelope osc helper for beeps and the sting. */
  private blip(freq: number, t0: number, dur: number, peak: number, type: OscillatorType): void {
    const c = this.ctx;
    if (!c || !this.eventBus) return;
    if (this.activeOneShots >= this.maxOneShots) return;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = c.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    o.connect(g);
    g.connect(this.eventBus);
    this.trackOneShot(o, [g], t0, t0 + dur + 0.05);
  }

  private nextNoiseOffset(duration: number): number {
    // Deterministic phase rotation prevents simultaneous bursts from replaying
    // the same white-noise attack while keeping harness runs reproducible.
    const offset = this.noiseCursor;
    this.noiseCursor = (this.noiseCursor + Math.max(0.11, duration) + 0.173) % 1.65;
    return offset;
  }

  private traceEvent(source: string, strength: number): void {
    const time = this.ctx?.currentTime ?? 0;
    this.eventTrace.push({ source, time, strength: clamp01(strength) });
    if (this.eventTrace.length > 32) this.eventTrace.shift();
  }

  audioEventLog(): ReadonlyArray<{ source: string; time: number; strength: number }> {
    return this.eventTrace.map((entry) => ({ ...entry }));
  }

  /** Build the whole graph. Called once, from resume(). */
  private build(): void {
    const ctx = new AudioContext();
    this.ctx = ctx;

    // Four independently duckable buses feed a phone-safe high-pass and limiter.
    const master = ctx.createGain();
    master.gain.value = 0;
    const safetyHp = ctx.createBiquadFilter();
    safetyHp.type = 'highpass';
    safetyHp.frequency.value = SAFETY_HIGHPASS_HZ;
    safetyHp.Q.value = 0.6;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = LIMITER_THRESHOLD_DB;
    comp.knee.value = 10;
    comp.ratio.value = LIMITER_RATIO;
    comp.attack.value = 0.002;
    comp.release.value = 0.18;
    master.connect(safetyHp);
    safetyHp.connect(comp);
    comp.connect(ctx.destination);
    this.master = master;

    const musicBus = ctx.createGain();
    musicBus.gain.value = 0;
    const musicFilter = ctx.createBiquadFilter();
    musicFilter.type = 'lowpass';
    musicFilter.frequency.value = 16000;
    musicBus.connect(musicFilter);
    musicFilter.connect(master);
    this.musicBus = musicBus;
    this.musicFilter = musicFilter;

    const ambienceBus = ctx.createGain();
    const vehicleBus = ctx.createGain();
    const eventBus = ctx.createGain();
    ambienceBus.gain.value = 0;
    vehicleBus.gain.value = 0;
    eventBus.gain.value = 0;
    ambienceBus.connect(master);
    vehicleBus.connect(master);
    eventBus.connect(master);
    this.ambienceBus = ambienceBus;
    this.vehicleBus = vehicleBus;
    this.eventBus = eventBus;

    const music = new Audio();
    // Decode the local song ahead of time so the first READY gesture can fade
    // it in without reporting "playing" while the media clock is still empty.
    music.preload = 'auto';
    // Loop only after the complete song ends. New runs never seek or restart it.
    music.loop = true;
    music.crossOrigin = 'anonymous';
    music.src = music.canPlayType('audio/ogg; codecs="vorbis"') ? gliderThemeOgg : gliderThemeMp3;
    music.addEventListener('canplay', () => {
      this.musicReady = true;
      if (this.scoreArmed || this.readyMusicActive) this.ensureMusicPlaying();
    }, { once: true });
    music.addEventListener('error', () => { this.musicFailed = true; }, { once: true });
    const musicSource = ctx.createMediaElementSource(music);
    musicSource.connect(musicBus);
    this.musicElement = music;
    this.musicSource = musicSource;

    // Shared 2s buffer for short, audited event bursts only. It is never
    // connected as a continuous environment loop.
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;

    // ---- engine: warm saw + triangle + sub sine → shaper → lowpass → level --------
    const shaper = ctx.createWaveShaper();
    shaper.curve = makeGritCurve();
    shaper.oversample = '2x';
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    lp.Q.value = 1.15;
    const eng = ctx.createGain();
    eng.gain.value = 0;
    shaper.connect(lp);
    lp.connect(eng);
    eng.connect(vehicleBus);
    this.engineLp = lp;
    this.engineGain = eng;

    const mkOsc = (type: OscillatorType, freq: number, detune: number, gain: number): OscillatorNode => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      o.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g);
      g.connect(shaper);
      o.start();
      return o;
    };
    this.saw1 = mkOsc('sawtooth', 48, -6, 0.35);
    this.saw2 = mkOsc('triangle', 48, 6, 0.38);
    this.sub = mkOsc('sine', 36, 0, 0.24);
    // luminous solar breeze / turbine octave layer, gated by boostGain
    const bg = ctx.createGain();
    bg.gain.value = 0;
    const bosc = ctx.createOscillator();
    bosc.type = 'triangle';
    bosc.frequency.value = 96;
    bosc.detune.value = 3;
    bosc.connect(bg);
    bg.connect(shaper);
    bosc.start();
    this.boostOsc = bosc;
    this.boostGain = bg;

    // ---- anti-grav: sine fundamental + triangle harmonic → flight gain --------
    const fg = ctx.createGain();
    fg.gain.value = 0;
    fg.connect(vehicleBus);
    const flight = ctx.createOscillator();
    flight.type = 'sine';
    flight.frequency.value = 88;
    const flightHarm = ctx.createOscillator();
    flightHarm.type = 'triangle';
    flightHarm.frequency.value = 264;
    const flightBaseGain = ctx.createGain();
    flightBaseGain.gain.value = 0.65;
    const flightHarmGain = ctx.createGain();
    flightHarmGain.gain.value = 0.22;
    flight.connect(flightBaseGain);
    flightHarm.connect(flightHarmGain);
    flightBaseGain.connect(fg);
    flightHarmGain.connect(fg);
    flight.start();
    flightHarm.start();
    this.flightOsc = flight;
    this.flightHarm = flightHarm;
    this.flightGain = fg;

    // Continuous air pressure is intentionally absent. A future approved
    // sample can be added behind this field without changing setFlight().
    this.flightNoiseGain = null;
    this.flightNoiseBp = null;

    const driftNoise = ctx.createBufferSource();
    driftNoise.buffer = buf;
    driftNoise.loop = true;
    const driftBp = ctx.createBiquadFilter();
    driftBp.type = 'bandpass';
    driftBp.frequency.value = 680;
    driftBp.Q.value = 1.25;
    const driftGain = ctx.createGain();
    driftGain.gain.value = 0;
    driftNoise.connect(driftBp);
    driftBp.connect(driftGain);
    driftGain.connect(vehicleBus);
    driftNoise.start();
    this.driftBp = driftBp;
    this.driftGain = driftGain;

    this.applyMix(0.02);
  }
}

function loadAudioSettings(): AudioSettings {
  try {
    const raw = localStorage.getItem(AUDIO_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AudioSettings>;
    const savedAmbience = typeof parsed.ambience === 'number' ? clamp01(parsed.ambience) : DEFAULT_SETTINGS.ambience;
    return {
      master: typeof parsed.master === 'number' ? clamp01(parsed.master) : DEFAULT_SETTINGS.master,
      music: typeof parsed.music === 'number' ? clamp01(parsed.music) : DEFAULT_SETTINGS.music,
      sfx: typeof parsed.sfx === 'number' ? clamp01(parsed.sfx) : DEFAULT_SETTINGS.sfx,
      // Migrate the old shipped 22% default without overwriting values users
      // actually customized in the mixer.
      ambience: Math.abs(savedAmbience - 0.22) < 1e-6 ? DEFAULT_SETTINGS.ambience : savedAmbience,
      muted: parsed.muted === true,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveAudioSettings(settings: AudioSettings): void {
  try {
    localStorage.setItem(AUDIO_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Audio preferences are optional; sound remains usable for this session.
  }
}
