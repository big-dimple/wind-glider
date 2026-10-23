import type { RacerDefinition } from '../contracts';
import { PALETTE } from '../core/palette';
import sushiPortrait from '../assets/drivers/sushi.webp';
import qingzhaoPortrait from '../assets/drivers/qingzhao.webp';
import xiaofengPortrait from '../assets/drivers/xiaofeng.webp';
import zhoubotongPortrait from '../assets/drivers/zhoubotong.webp';
import kongmingPortrait from '../assets/drivers/kongming.webp';
import wawaPortrait from '../assets/drivers/wawa.webp';

export type DriverMood = '沉稳' | '骄傲' | '愤怒' | '专注' | '兴奋' | '冷酷';

export interface DriverHandling {
  acceleration: number;
  steering: number;
  driftCharge: number;
  airControl: number;
}

export type PilotCapeType =
  | 'twin_scarf'
  | 'silk_ribbon'
  | 'hero_cape'
  | 'storm_cloak'
  | 'scholar_mantle'
  | 'furin_cloak';

export type PilotHeadgearType =
  | 'scholar_topknot'
  | 'qing_ribbon_bun'
  | 'hero_longhair'
  | 'aviator_beard_hat'
  | 'astrolabe_crown'
  | 'cat_ear_hood';

export type PilotGogglesType =
  | 'brass_pilot'
  | 'gold_thin'
  | 'leather_brow'
  | 'brass_monocle'
  | 'silver_scholar'
  | 'brass_round';

export interface PilotVisualConfig {
  suitColor: number;
  secondaryColor: number;
  capeColor: number;
  capeTrimColor: number;
  gogglesColor: number;
  gogglesLensColor: number;
  skinColor: number;
  hairColor: number;
  headgearColor: number;
  capeType: PilotCapeType;
  headgearType: PilotHeadgearType;
  gogglesType: PilotGogglesType;
  hasShoulderPads?: boolean;
  hasBeard?: boolean;
  hasFurinBell?: boolean;
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
  pilotVisual: PilotVisualConfig;
  rivalRank: number;
}

const DRIVER_STORAGE_KEY = 'board-race:driver:v1';

/** 6 Master Glider Pilots with unique 3D cockpit avatars & dynamic scarf physics. */
export const DRIVER_PROFILES: readonly DriverProfile[] = [
  {
    id: 'sushi', name: '苏轼', callsign: '御风客', age: 38, pronouns: '他', portraitUrl: sushiPortrait, portraitPosition: '50% 15%',
    color: PALETTE.hullPlayer, personality: 'clean', pace: 0.985, mood: '沉稳', moodIcon: '◆',
    specialty: '平衡全能型 · 晴空信天翁', strength: '长距滑翔稳健，入弯与空中修正极宽容', weakness: '爆发冲刺稍缓',
    quote: '九万里风斯在下，且引轻舟入碧霄。', handling: { acceleration: 1, steering: 1, driftCharge: 1, airControl: 1.04 },
    pilotVisual: {
      suitColor: 0x587D6B, secondaryColor: 0xFAF6EB,
      capeColor: 0xFAF6EB, capeTrimColor: 0xE6DCB8,
      gogglesColor: 0xDDA73A, gogglesLensColor: 0x80C4E8,
      skinColor: 0xF8D8BE, hairColor: 0xE8ECEE, headgearColor: 0x587D6B,
      capeType: 'twin_scarf', headgearType: 'scholar_topknot', gogglesType: 'brass_pilot',
      hasBeard: true,
    },
    rivalRank: 2,
  },
  {
    id: 'qingzhao', name: '清照', callsign: '乘风羽', age: 27, pronouns: '她', portraitUrl: qingzhaoPortrait, portraitPosition: '50% 15%',
    color: PALETTE.hullNova, personality: 'clean', pace: 0.99, mood: '专注', moodIcon: '◈',
    specialty: '轻量敏捷空刹型 · 风谷蜻蜓', strength: '空刹制动极精准，狭窄空岛航线姿态恢复最快', weakness: '大浪水面抗颠簸稍弱',
    quote: '风休住，蓬舟吹取三山去！', handling: { acceleration: 0.99, steering: 1.01, driftCharge: 0.96, airControl: 1.06 },
    pilotVisual: {
      suitColor: 0x4A8C7D, secondaryColor: 0x78B8AA,
      capeColor: 0x8AC8BA, capeTrimColor: 0xB5E5DA,
      gogglesColor: 0xE5B84B, gogglesLensColor: 0x9EE2EE,
      skinColor: 0xFCEDE0, hairColor: 0x221E20, headgearColor: 0x7A583A,
      capeType: 'silk_ribbon', headgearType: 'qing_ribbon_bun', gogglesType: 'gold_thin',
    },
    rivalRank: 4,
  },
  {
    id: 'xiaofeng', name: '萧峰', callsign: '九霄豪侠', age: 32, pronouns: '他', portraitUrl: xiaofengPortrait, portraitPosition: '50% 15%',
    color: PALETTE.hullKai, personality: 'aggressive', pace: 1.01, mood: '骄傲', moodIcon: '▲',
    specialty: '俯冲极速爆发型 · 赤炎狂龙', strength: '大角度俯冲推力狂暴，弯道超越窗口坚决果断', weakness: '极速转弯惯性大需提前收线',
    quote: '大丈夫顶天立地，自当乘长风破万里重浪！', handling: { acceleration: 1.05, steering: 0.97, driftCharge: 1.02, airControl: 0.99 },
    pilotVisual: {
      suitColor: 0x7A2A1E, secondaryColor: 0x5C3A24,
      capeColor: 0xC22B22, capeTrimColor: 0xE04838,
      gogglesColor: 0x4A2218, gogglesLensColor: 0xDDA73A,
      skinColor: 0xE6B898, hairColor: 0x18181A, headgearColor: 0x4A2218,
      capeType: 'hero_cape', headgearType: 'hero_longhair', gogglesType: 'leather_brow',
      hasShoulderPads: true,
    },
    rivalRank: 5,
  },
  {
    id: 'zhoubotong', name: '舟伯通', callsign: '海风老爹', age: 58, pronouns: '他', portraitUrl: zhoubotongPortrait, portraitPosition: '50% 15%',
    color: PALETTE.hullReef, personality: 'aggressive', pace: 1.025, mood: '愤怒', moodIcon: '!',
    specialty: '双体抗颠簸稳重型 · 顽童重锤', strength: '抗风浪冲击极强，晚刹卡位与贴海出弯力量十足', weakness: '机体自重稍大，爬升相对耗能',
    quote: '好玩好玩！看老夫左右互搏，把风头全抢过来！', handling: { acceleration: 1.04, steering: 1.03, driftCharge: 1.04, airControl: 0.98 },
    pilotVisual: {
      suitColor: 0x465A42, secondaryColor: 0xF0EAE1,
      capeColor: 0x1E422C, capeTrimColor: 0x3A6A4B,
      gogglesColor: 0xC8963E, gogglesLensColor: 0x58D4E2,
      skinColor: 0xE8BA9A, hairColor: 0xF0F0F0, headgearColor: 0x5C4A3A,
      capeType: 'storm_cloak', headgearType: 'aviator_beard_hat', gogglesType: 'brass_monocle',
      hasBeard: true,
    },
    rivalRank: 6,
  },
  {
    id: 'kongming', name: '孔明', callsign: '东风领航官', age: 35, pronouns: '他', portraitUrl: kongmingPortrait, portraitPosition: '50% 15%',
    color: PALETTE.hullVolt, personality: 'clean', pace: 1.02, mood: '冷酷', moodIcon: '●',
    specialty: '长展弦比高空巡航型 · 卧龙木鸢', strength: '精准借势暖气流与风道，高空巡航阻力极低', weakness: '被迫近身肉搏略显保守',
    quote: '万事俱备，只欠东风；风之所向，吾心所往。', handling: { acceleration: 1.01, steering: 1.04, driftCharge: 0.99, airControl: 1.04 },
    pilotVisual: {
      suitColor: 0x1C2D4A, secondaryColor: 0x2A4270,
      capeColor: 0x243B66, capeTrimColor: 0xE8C468,
      gogglesColor: 0xD0DCE8, gogglesLensColor: 0xB8E4F8,
      skinColor: 0xFAEFE4, hairColor: 0x1C1C20, headgearColor: 0xE2ECF2,
      capeType: 'scholar_mantle', headgearType: 'astrolabe_crown', gogglesType: 'silver_scholar',
    },
    rivalRank: 7,
  },
  {
    id: 'wawa', name: '娃娃', callsign: '风铃小童', age: 16, pronouns: '她', portraitUrl: wawaPortrait, portraitPosition: '50% 15%',
    color: PALETTE.hullJinx, personality: 'erratic', pace: 0.965, mood: '兴奋', moodIcon: '✦',
    specialty: '双翼敏捷起飞型 · 风之浮子', strength: '起飞蓄能极迅速，灵动漂移常跑出奇迹航线', weakness: '空中巡航颠簸容错略低',
    quote: '风铃叮当响，风儿带我飞向最高的那片云朵！', handling: { acceleration: 0.98, steering: 1.02, driftCharge: 1.06, airControl: 0.97 },
    pilotVisual: {
      suitColor: 0x2D7A47, secondaryColor: 0x48A866,
      capeColor: 0x369450, capeTrimColor: 0x6CD285,
      gogglesColor: 0xEAA836, gogglesLensColor: 0x78E0F0,
      skinColor: 0xFDEDE2, hairColor: 0x9C5A32, headgearColor: 0x2D7A47,
      capeType: 'furin_cloak', headgearType: 'cat_ear_hood', gogglesType: 'brass_round',
      hasFurinBell: true,
    },
    rivalRank: 1,
  },
] as const;

export function driverProfile(id: string): DriverProfile {
  return DRIVER_PROFILES.find((profile) => profile.id === id) ?? DRIVER_PROFILES[0];
}

export function pilotVisualForProfile(id: string): PilotVisualConfig {
  return driverProfile(id).pilotVisual;
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
