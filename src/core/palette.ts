/**
 * palette.ts — the committed, game-wide color palette.
 *
 * Art direction: Ghibli & Solarpunk hand-drawn watercolor aesthetic.
 * Warm sunlight, lush blues and turquoise waters, teak wood, handwoven canvas,
 * and deep warm sepia ink outlines.
 *
 * Every surface in the game pulls from these values and nothing else.
 * Hex ints are for THREE.Color, CSS strings are for the HUD.
 */

export const PALETTE = {
  // Ink — deep warm sepia hand-drawn ink, never pure black or electric indigo.
  ink: 0x2c1d11,
  inkCss: '#2c1d11',
  inkWarm: 0x3d271d,

  // Sky & Atmosphere (晴空天顶、中景天蓝、地平线暖光、阳光与手绘积雨云)
  skyZenith: 0x4a90e2,
  skyMid: 0x7ec8e3,
  skyHorizon: 0xe8f4f8,
  sun: 0xfff176,
  sunCore: 0xfffde7,
  sunFlare: 0xffd54f,
  cloudBody: 0xffffff,
  cloudShade: 0xb0d4e3,
  cloudRim: 0xffe082,

  // Water & Ocean (水彩碧海、浅海绿松石、深海宝蓝、蕾丝浪花泡沫与焦散光斑)
  waterDeep: 0x1565c0,
  seaDeep: 0x1565c0,
  waterMid: 0x1e88e5,
  waterCrest: 0x26c6da,
  seaShallow: 0x26c6da,
  foam: 0xffffff,
  seaFoam: 0xffffff,
  sparkle: 0xfff9c4,

  // Woodcraft, Glider & Ancient Ruins (木质滑翔艇、龙骨、黄铜、手织帆布、古代石门与青藤)
  boatWood: 0x8d6e63,
  boatWoodDark: 0x5d4037,
  boatBrass: 0xffb300,
  gliderCanvas: 0xfff8e1,
  stoneAncient: 0xfaf0e6,
  vineGreen: 0x81c784,
  petalPink: 0xff80ab,
  windTrail: 0xffffff,

  // Gameplay & Energy (航道、风力蓄能、滑翔风羽、加速)
  racingLine: 0x4db6ac,
  boost: 0xffb74d,
  flight: 0x4fc3f7,
  flightDeep: 0x0288d1,

  // Racer hull accents: player (vintage coral) & opponents (warm anime tones)
  hullPlayer: 0xe57373,
  hullReef: 0xff8a65,
  hullKai: 0xffca28,
  hullJinx: 0xba68c8,
  hullVolt: 0x81c784,
  hullNova: 0x4dd0e1,

  // HUD & UI (手绘羊皮纸底色、原木面板、墨水文字与徽章强调色)
  uiParchment: 0xfbf7ee,
  uiParchmentDark: 0xede3ce,
  uiPanel: 0x3e2723,
  uiPanelCss: 'rgba(62, 39, 35, 0.88)',
  uiText: 0x3e2723,
  uiTextLight: 0xfff8e1,
  uiTextCss: '#3e2723',
  uiAccent: 0x2e7d32,
  uiAccentCss: '#2e7d32',
  uiWarn: 0xd32f2f,
  uiWarnCss: '#d32f2f',
  uiGold: 0xf57f17,
  uiGoldCss: '#f57f17',

  /** Direction TOWARD the sun (normalize before use). Shared by sky, toon lighting, water spec. */
  sunDir: [0.5, 0.55, 0.55] as readonly number[],
} as const;

export type Palette = typeof PALETTE;
export type PaletteKey = keyof Palette;

/**
 * Format numeric hex color into standard CSS string.
 */
export function cssColor(hex: number, alpha?: number): string {
  const hexStr = hex.toString(16).padStart(6, '0');
  if (alpha !== undefined && alpha < 1.0) {
    const r = (hex >> 16) & 255;
    const g = (hex >> 8) & 255;
    const b = hex & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return `#${hexStr}`;
}
