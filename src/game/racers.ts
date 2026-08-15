import type { RacerDefinition } from '../contracts';
import { PALETTE } from '../core/palette';
import lingfengPortrait from '../assets/drivers/lingfeng.webp';
import yunquePortrait from '../assets/drivers/yunque.webp';
import riyuPortrait from '../assets/drivers/riyu.webp';
import bolanPortrait from '../assets/drivers/bolan.webp';
import qinglanPortrait from '../assets/drivers/qinglan.webp';
import fenglinPortrait from '../assets/drivers/fenglin.webp';

export type DriverMood = '沉稳' | '骄傲' | '愤怒' | '专注' | '兴奋' | '冷酷';

export interface DriverHandling {
  acceleration: number;
  steering: number;
  driftCharge: number;
  airControl: number;
}

export interface DriverProfile {
  id: string;
  name: string;
  callsign: string;
  age: number;
  pronouns: '他' | '她';
  portraitUrl: string;
  /** CSS object-position for portraits with different source compositions. */
  portraitPosition: string;
  color: number;
  personality: RacerDefinition['personality'];
  pace: number;
  mood: DriverMood;
  moodIcon: string;
  specialty: string;
  strength: string;
  weakness: string;
  quote: string;
  handling: DriverHandling;
  rivalRank: number;
}

const DRIVER_STORAGE_KEY = 'board-race:driver:v1';

/** Adult glider pilots. Every player-facing handling modifier stays within +/-6%. */
export const DRIVER_PROFILES: readonly DriverProfile[] = [
  {
    id: 'lingfeng', name: '凌风', callsign: '晴空手', age: 28, pronouns: '他', portraitUrl: lingfengPortrait, portraitPosition: '50% 15%',
    color: PALETTE.hullPlayer, personality: 'clean', pace: 0.985, mood: '沉稳', moodIcon: '◆',
    specialty: '平衡滑翔手', strength: '入弯稳健，空中修正宽容', weakness: '爆发力并非最高',
    quote: '让气流替我说话。', handling: { acceleration: 1, steering: 1, driftCharge: 1, airControl: 1.04 }, rivalRank: 2,
  },
  {
    id: 'yunque', name: '云雀', callsign: '风谷女儿', age: 27, pronouns: '她', portraitUrl: yunquePortrait, portraitPosition: '50% 15%',
    color: PALETTE.hullNova, personality: 'clean', pace: 0.99, mood: '冷酷', moodIcon: '◈',
    specialty: '飞行专家', strength: '空刹精准，姿态恢复最快', weakness: '水面蓄能稍慢',
    quote: '别眨眼，高空只给一次机会。', handling: { acceleration: 0.99, steering: 1.01, driftCharge: 0.96, airControl: 1.06 }, rivalRank: 4,
  },
  {
    id: 'riyu', name: '日羽', callsign: '天空信使', age: 26, pronouns: '她', portraitUrl: riyuPortrait, portraitPosition: '50% 15%',
    color: PALETTE.hullKai, personality: 'aggressive', pace: 1.01, mood: '骄傲', moodIcon: '▲',
    specialty: '起飞猎手', strength: '加速强，超越窗口大胆', weakness: '急弯容易推头',
    quote: '第一名的云层，阳光最好。', handling: { acceleration: 1.05, steering: 0.97, driftCharge: 1.02, airControl: 0.99 }, rivalRank: 5,
  },
  {
    id: 'bolan', name: '波澜', callsign: '海风老手', age: 51, pronouns: '他', portraitUrl: bolanPortrait, portraitPosition: '50% 15%',
    color: PALETTE.hullReef, personality: 'aggressive', pace: 1.025, mood: '愤怒', moodIcon: '!',
    specialty: '贴身强压', strength: '晚刹、卡位、出弯速度极强', weakness: '持续压迫时线路偏险',
    quote: '我在天上跑了三十年，轮到你了。', handling: { acceleration: 1.04, steering: 1.03, driftCharge: 1.04, airControl: 0.98 }, rivalRank: 6,
  },
  {
    id: 'qinglan', name: '晴岚', callsign: '山岚导航', age: 30, pronouns: '他', portraitUrl: qinglanPortrait, portraitPosition: '50% 15%',
    color: PALETTE.hullVolt, personality: 'clean', pace: 1.02, mood: '专注', moodIcon: '●',
    specialty: '精准领航员', strength: '航线近乎无误，后程持续追击', weakness: '被迫近身时略保守',
    quote: '误差会累积，我不会。', handling: { acceleration: 1.01, steering: 1.04, driftCharge: 0.99, airControl: 1.04 }, rivalRank: 7,
  },
  {
    id: 'fenglin', name: '风铃', callsign: '漂浮少年', age: 25, pronouns: '他', portraitUrl: fenglinPortrait, portraitPosition: '50% 15%',
    color: PALETTE.hullJinx, personality: 'erratic', pace: 0.965, mood: '兴奋', moodIcon: '✦',
    specialty: '漂移赌徒', strength: '蓄能快，偶尔跑出神级航线', weakness: '节奏波动明显',
    quote: '稳有什么意思，风才是老师！', handling: { acceleration: 0.98, steering: 1.02, driftCharge: 1.06, airControl: 0.97 }, rivalRank: 1,
  },
] as const;

export function driverProfile(id: string): DriverProfile {
  return DRIVER_PROFILES.find((profile) => profile.id === id) ?? DRIVER_PROFILES[0];
}

export function loadSelectedDriver(): string {
  try {
    const id = localStorage.getItem(DRIVER_STORAGE_KEY) ?? '';
    return DRIVER_PROFILES.some((profile) => profile.id === id) ? id : DRIVER_PROFILES[0].id;
  } catch {
    return DRIVER_PROFILES[0].id;
  }
}

export function saveSelectedDriver(id: string): void {
  try {
    localStorage.setItem(DRIVER_STORAGE_KEY, driverProfile(id).id);
  } catch {
    // Selection persistence is optional; the active session still uses the choice.
  }
}

const GRID = [
  { startPlace: 4, startDistance: 22, startLateral: 0, lane: 0 },
  { startPlace: 1, startDistance: 9, startLateral: 0, lane: 0 },
  { startPlace: 2, startDistance: 15, startLateral: -5.5, lane: -4 },
  { startPlace: 3, startDistance: 15, startLateral: 5.5, lane: 4 },
  { startPlace: 5, startDistance: 28, startLateral: -5.5, lane: -4 },
  { startPlace: 6, startDistance: 28, startLateral: 5.5, lane: 4 },
] as const;

/** Put the selected profile in physical slot 0 and seed the two strongest remaining rivals ahead. */
export function buildRaceRoster(selectedId: string): readonly RacerDefinition[] {
  const selected = driverProfile(selectedId);
  const opponents = DRIVER_PROFILES.filter((profile) => profile.id !== selected.id)
    .sort((a, b) => b.rivalRank - a.rivalRank);
  const profiles = [selected, ...opponents];
  return profiles.map((profile, id) => ({
    id,
    profileId: profile.id,
    name: id === 0 ? profile.name : profile.name,
    color: profile.color,
    portraitUrl: profile.portraitUrl,
    isPlayer: id === 0,
    personality: profile.personality,
    pace: id === 0 ? 1 : profile.pace,
    lane: GRID[id].lane,
    startPlace: GRID[id].startPlace,
    startDistance: GRID[id].startDistance,
    startLateral: GRID[id].startLateral,
  }));
}

/** Single source of truth for construction, AI pace, lanes and the six-place grid. */
export const RACER_DEFS: readonly RacerDefinition[] = buildRaceRoster(DRIVER_PROFILES[0].id);

export const RACER_COLORS: readonly number[] = RACER_DEFS.map((racer) => racer.color);
export const RACER_NAMES: readonly string[] = RACER_DEFS.map((racer) => racer.name);
