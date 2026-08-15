import { PALETTE, cssColor } from '../core/palette';
import './finaleCelebration.css';

export type FinaleVisualPhase = 'idle' | 'impact' | 'crown' | 'hero' | 'settled';

export interface FinaleVisualState {
  phase: FinaleVisualPhase;
  progress: number;
  flash: number;
  crown: number;
  impact: number;
  actionsVisible: boolean;
}

// ---------------------------------------------------------------------------
// Pre-allocated Particle & Ray Pools (Deterministic, 0 GC per frame)
// ---------------------------------------------------------------------------

interface Petal {
  readonly angle: number;
  readonly burstSpeed: number;
  readonly fallSpeed: number;
  readonly swayFreq: number;
  readonly swayAmp: number;
  readonly swayPhase: number;
  readonly rotSpeed: number;
  readonly tumbleFreq: number;
  readonly tumblePhase: number;
  readonly size: number;
  readonly colorIndex: number;
  readonly petalType: number; // 0: sakura notched, 1: rose oval, 2: clover/leaf
  readonly delay: number;
}

interface ConfettiRibbon {
  readonly xFrac: number;
  readonly yFrac: number;
  readonly speedX: number;
  readonly speedY: number;
  readonly length: number;
  readonly width: number;
  readonly rotSpeed: number;
  readonly curlFreq: number;
  readonly colorIndex: number;
  readonly phase: number;
}

interface Spark {
  readonly angle: number;
  readonly distance: number;
  readonly length: number;
  readonly speed: number;
  readonly size: number;
  readonly phase: number;
}

interface SunRay {
  readonly angle: number;
  readonly lengthFactor: number;
  readonly widthFactor: number;
  readonly alphaFactor: number;
}

const PETAL_COUNT = 76;
const PETALS: readonly Petal[] = Array.from({ length: PETAL_COUNT }, (_, index) => {
  const seed = index * 1.6180339887;
  const angle = (seed * Math.PI * 2) % (Math.PI * 2);
  const colorIndex = index % 6; // 0: Pink, 1: Canvas White, 2: Sun Gold, 3: Vine Green, 4: Lilac, 5: Turquoise
  const petalType = index % 3;
  return {
    angle,
    burstSpeed: 0.22 + (index % 11) * 0.038,
    fallSpeed: 0.12 + (index % 7) * 0.024,
    swayFreq: 2.2 + (index % 5) * 0.65,
    swayAmp: 0.04 + (index % 8) * 0.012,
    swayPhase: (seed * 3.1415) % (Math.PI * 2),
    rotSpeed: (index % 2 === 0 ? 1 : -1) * (1.1 + (index % 4) * 0.55),
    tumbleFreq: 3.0 + (index % 6) * 0.8,
    tumblePhase: (seed * 2.7182) % (Math.PI * 2),
    size: 0.018 + (index % 9) * 0.0028,
    colorIndex,
    petalType,
    delay: (index % 13) * 0.012,
  };
});

const CONFETTI_COUNT = 42;
const CONFETTIS: readonly ConfettiRibbon[] = Array.from({ length: CONFETTI_COUNT }, (_, index) => {
  const seed = index * 2.399963;
  return {
    xFrac: 0.08 + (seed % 0.84),
    yFrac: -0.15 - ((index * 0.032) % 0.4),
    speedX: (index % 2 === 0 ? 1 : -1) * (0.04 + (index % 5) * 0.02),
    speedY: 0.14 + (index % 6) * 0.032,
    length: 0.032 + (index % 5) * 0.008,
    width: 0.006 + (index % 3) * 0.002,
    rotSpeed: (index % 2 === 0 ? 1 : -1) * (1.8 + (index % 4) * 0.6),
    curlFreq: 2.8 + (index % 5) * 0.7,
    colorIndex: index % 6,
    phase: (seed * 3.14) % (Math.PI * 2),
  };
});

const SPARKS: readonly Spark[] = Array.from({ length: 56 }, (_, index) => ({
  angle: index * 2.399963 + (index % 3) * 0.12,
  distance: 0.15 + (index % 9) * 0.082,
  length: 0.045 + (index % 5) * 0.016,
  speed: 0.46 + (index % 7) * 0.062,
  size: 1.8 + (index % 4) * 0.9,
  phase: (index * 0.173) % 1,
}));

const SUN_RAYS: readonly SunRay[] = Array.from({ length: 12 }, (_, index) => ({
  angle: (index / 12) * Math.PI * 2,
  lengthFactor: 0.85 + (index % 3) * 0.22,
  widthFactor: index % 2 === 0 ? 1.0 : 0.65,
  alphaFactor: 0.75 + (index % 4) * 0.15,
}));

// Palette colors mapped to CSS string constants
const COLOR_SUN_FLARE = cssColor(PALETTE.sunFlare);
const COLOR_PETAL_PINK = cssColor(PALETTE.petalPink);
const COLOR_CANVAS = cssColor(PALETTE.gliderCanvas);
const COLOR_VINE = cssColor(PALETTE.vineGreen);
const COLOR_TURQUOISE = cssColor(PALETTE.seaShallow);
const COLOR_LILAC = cssColor(PALETTE.hullJinx);
const COLOR_INK = cssColor(PALETTE.ink);

const CELEBRATION_COLORS = [
  COLOR_PETAL_PINK,
  COLOR_CANVAS,
  COLOR_SUN_FLARE,
  COLOR_VINE,
  COLOR_LILAC,
  COLOR_TURQUOISE,
] as const;

export class FinaleCelebrationCanvas {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly reducedMotion: boolean;
  private state: FinaleVisualState = {
    phase: 'idle', progress: 0, flash: 0, crown: 0, impact: 0, actionsVisible: false,
  };

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'finale-celebration-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    parent.appendChild(this.canvas);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Finale celebration canvas is unavailable');
    this.ctx = ctx;
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.resize();
    window.addEventListener('resize', () => this.resize(), { passive: true });
  }

  reset(): void {
    this.state = { phase: 'idle', progress: 0, flash: 0, crown: 0, impact: 0, actionsVisible: false };
    this.clear();
  }

  render(elapsed: number, actionsVisible: boolean): FinaleVisualState {
    const progress = Math.max(0, Math.min(1, elapsed / 2.4));
    const phase: FinaleVisualPhase = elapsed < 0.22 ? 'impact'
      : elapsed < 0.7 ? 'crown'
      : elapsed < 1.65 ? 'hero'
      : 'settled';
    const flash = this.reducedMotion ? (elapsed > 0 ? 0.16 : 0) : Math.max(0, 1 - Math.abs(elapsed - 0.1) / 0.16);
    const crown = this.reducedMotion ? 0.72 : Math.min(1, Math.max(0, (elapsed - 0.08) / 0.48));
    const impact = this.reducedMotion ? 0 : Math.max(0, 1 - elapsed / 0.52);
    this.state = { phase, progress, flash, crown, impact, actionsVisible };
    this.clear();
    if (elapsed <= 0) return this.state;

    const width = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const height = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    const scale = Math.min(width, height);
    const cx = width * 0.5;
    const cy = height * 0.40;
    const ctx = this.ctx;

    ctx.save();

    // 1. Warm Sunburst Flash Wash
    if (flash > 0) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = `rgba(255, 249, 214, ${flash * 0.58})`;
      ctx.fillRect(0, 0, width, height);
    }

    // 2. Radiant Tyndall Rays & Golden Watercolor Backing
    if (crown > 0.01) {
      this.drawWatercolorBackdrop(ctx, cx, cy, scale, crown);
      this.drawSunRays(ctx, cx, cy, scale, crown, elapsed);
    }

    // 3. Central Golden Weathervane & Solar Crown Crest
    if (crown > 0.02) {
      this.drawGoldenWeathervane(ctx, cx, cy, scale, crown, elapsed, impact);
    }

    // 4. Festive Confetti Ribbons Drifting in Wind
    if (!this.reducedMotion && elapsed > 0.12) {
      this.drawConfettiRibbons(ctx, width, height, scale, elapsed, progress);
    }

    // 5. Swirling Watercolor Flower Petals
    if (elapsed > 0.04) {
      this.drawPetals(ctx, cx, cy, width, height, scale, elapsed, progress, impact);
    }

    // 6. Radiant Golden Pollen & Sparkle Starbursts
    if (elapsed > 0.02) {
      this.drawSparksAndPollen(ctx, cx, cy, scale, elapsed, impact);
    }

    ctx.restore();
    return this.state;
  }

  visualState(): FinaleVisualState { return this.state; }

  // ---------------------------------------------------------------------------
  // Layer 2: Watercolor Radial Halo Backdrop
  // ---------------------------------------------------------------------------
  private drawWatercolorBackdrop(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    scale: number,
    crown: number,
  ): void {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const radius = scale * (0.12 + crown * 0.22);
    const alpha = 0.28 + crown * 0.65;

    // Outer warm gold wash
    const outerGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 1.6);
    outerGrad.addColorStop(0, `rgba(255, 248, 200, ${alpha * 0.72})`);
    outerGrad.addColorStop(0.35, `rgba(255, 213, 79, ${alpha * 0.32})`);
    outerGrad.addColorStop(0.7, `rgba(255, 128, 171, ${alpha * 0.12})`);
    outerGrad.addColorStop(1, 'rgba(255, 213, 79, 0)');
    ctx.fillStyle = outerGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 1.6, 0, Math.PI * 2);
    ctx.fill();

    // Inner bright core bloom
    const coreGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 0.65);
    coreGrad.addColorStop(0, `rgba(255, 253, 231, ${alpha * 0.92})`);
    coreGrad.addColorStop(0.6, `rgba(255, 241, 118, ${alpha * 0.45})`);
    coreGrad.addColorStop(1, 'rgba(255, 241, 118, 0)');
    ctx.fillStyle = coreGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.65, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Layer 2.5: Tyndall Sun Rays (丁达尔金色手绘光芒线)
  // ---------------------------------------------------------------------------
  private drawSunRays(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    scale: number,
    crown: number,
    elapsed: number,
  ): void {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const baseRadius = scale * (0.09 + crown * 0.14);
    const rayRot = this.reducedMotion ? 0 : elapsed * 0.18;
    const pulse = 0.88 + Math.sin(elapsed * 3.2) * 0.12;

    for (const ray of SUN_RAYS) {
      const angle = ray.angle + rayRot;
      const length = scale * (0.24 + crown * 0.28) * ray.lengthFactor * pulse;
      const widthAngle = 0.055 * ray.widthFactor;
      const alpha = crown * 0.22 * ray.alphaFactor;

      const p1x = cx + Math.cos(angle - widthAngle) * baseRadius;
      const p1y = cy + Math.sin(angle - widthAngle) * baseRadius * 0.68;
      const p2x = cx + Math.cos(angle + widthAngle) * baseRadius;
      const p2y = cy + Math.sin(angle + widthAngle) * baseRadius * 0.68;
      const tipX = cx + Math.cos(angle) * (baseRadius + length);
      const tipY = cy + Math.sin(angle) * (baseRadius + length) * 0.68;

      const grad = ctx.createRadialGradient(cx, cy, baseRadius, cx, cy, baseRadius + length);
      grad.addColorStop(0, `rgba(255, 248, 200, ${alpha * 1.2})`);
      grad.addColorStop(0.4, `rgba(255, 213, 79, ${alpha * 0.7})`);
      grad.addColorStop(1, 'rgba(255, 213, 79, 0)');

      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(p1x, p1y);
      ctx.lineTo(tipX, tipY);
      ctx.lineTo(p2x, p2y);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Layer 3: Central Golden Weathervane & Solar Crown (金色风向标与日漫太阳罗盘)
  // ---------------------------------------------------------------------------
  private drawGoldenWeathervane(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    scale: number,
    crown: number,
    elapsed: number,
    impact: number,
  ): void {
    ctx.save();
    const radius = scale * (0.075 + crown * 0.11);
    const alpha = 0.35 + crown * 0.65;
    const pulse = 1 + (impact > 0 ? impact * 0.15 : Math.sin(elapsed * 4.0) * 0.03);

    // A. Outer Compass Ring with Watercolor Dots & Cardinal Points
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = `rgba(255, 224, 130, ${alpha * 0.95})`;
    ctx.lineWidth = Math.max(2.4, scale * 0.0042);
    ctx.beginPath();
    ctx.arc(cx, cy, radius * pulse, 0, Math.PI * 2);
    ctx.stroke();

    // Inner fine ink accent ring
    ctx.strokeStyle = `rgba(44, 29, 17, ${alpha * 0.45})`;
    ctx.lineWidth = Math.max(1.0, scale * 0.0016);
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.94 * pulse, 0, Math.PI * 2);
    ctx.stroke();

    // 8 Cardinal/Intercardinal Compass Spikes (八方日芒与星罗盘刻度)
    const spikeCount = 8;
    for (let i = 0; i < spikeCount; i++) {
      const a = (i / spikeCount) * Math.PI * 2 + (this.reducedMotion ? 0 : elapsed * 0.05);
      const isMajor = i % 2 === 0;
      const inner = radius * 0.86 * pulse;
      const outer = radius * (isMajor ? 1.28 : 1.12) * pulse;

      const x1 = cx + Math.cos(a) * inner;
      const y1 = cy + Math.sin(a) * inner * 0.72;
      const x2 = cx + Math.cos(a) * outer;
      const y2 = cy + Math.sin(a) * outer * 0.72;

      ctx.strokeStyle = isMajor ? `rgba(255, 241, 118, ${alpha})` : `rgba(255, 213, 79, ${alpha * 0.75})`;
      ctx.lineWidth = Math.max(1.8, scale * (isMajor ? 0.0035 : 0.0022));
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();

      // Cardinal brass tip bead
      if (isMajor) {
        ctx.fillStyle = `rgba(255, 253, 231, ${alpha * 0.9})`;
        ctx.beginPath();
        ctx.arc(x2, y2, Math.max(2.2, scale * 0.0038), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();

    // B. Pivoting Golden Weathervane Arrow (金色风之翼羽箭风向标)
    ctx.save();
    const vaneAngle = this.reducedMotion ? -0.4 : Math.sin(elapsed * 1.8) * 0.22 - 0.35 + Math.cos(elapsed * 0.8) * 0.08;
    const vaneLen = radius * 1.45 * pulse;

    ctx.translate(cx, cy);
    ctx.rotate(vaneAngle);

    // Arrow stem (黄铜箭杆)
    ctx.strokeStyle = `rgba(255, 213, 79, ${alpha})`;
    ctx.lineWidth = Math.max(2.2, scale * 0.0036);
    ctx.beginPath();
    ctx.moveTo(-vaneLen * 0.72, 0);
    ctx.lineTo(vaneLen * 0.85, 0);
    ctx.stroke();

    // Arrow pointer head (太阳金菱形箭头)
    ctx.fillStyle = `rgba(255, 253, 231, ${alpha})`;
    ctx.strokeStyle = `rgba(44, 29, 17, ${alpha * 0.55})`;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(vaneLen * 0.98, 0);
    ctx.lineTo(vaneLen * 0.72, -scale * 0.014);
    ctx.lineTo(vaneLen * 0.78, 0);
    ctx.lineTo(vaneLen * 0.72, scale * 0.014);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Arrow tail: Dual-fluted Wind Glider feather vane (双层羽状风之翼尾翼)
    ctx.fillStyle = `rgba(255, 179, 0, ${alpha * 0.95})`;
    ctx.beginPath();
    ctx.moveTo(-vaneLen * 0.28, 0);
    ctx.lineTo(-vaneLen * 0.75, -scale * 0.024);
    ctx.lineTo(-vaneLen * 0.88, -scale * 0.018);
    ctx.lineTo(-vaneLen * 0.58, 0);
    ctx.lineTo(-vaneLen * 0.88, scale * 0.018);
    ctx.lineTo(-vaneLen * 0.75, scale * 0.024);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Canvas white accent feather stripe
    ctx.fillStyle = `rgba(255, 248, 225, ${alpha * 0.85})`;
    ctx.beginPath();
    ctx.moveTo(-vaneLen * 0.38, 0);
    ctx.lineTo(-vaneLen * 0.68, -scale * 0.015);
    ctx.lineTo(-vaneLen * 0.76, -scale * 0.011);
    ctx.lineTo(-vaneLen * 0.52, 0);
    ctx.lineTo(-vaneLen * 0.76, scale * 0.011);
    ctx.lineTo(-vaneLen * 0.68, scale * 0.015);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // C. Spinning Anemometer Rotor (旋转三杯式风速仪)
    ctx.save();
    ctx.translate(cx, cy);
    const anemometerAngle = this.reducedMotion ? 0 : elapsed * 5.2;
    const cupRadius = radius * 0.48 * pulse;

    for (let c = 0; c < 3; c++) {
      const a = anemometerAngle + (c / 3) * Math.PI * 2;
      const armX = Math.cos(a) * cupRadius;
      const armY = Math.sin(a) * cupRadius * 0.65;

      // Brass spoke arm
      ctx.strokeStyle = `rgba(255, 213, 79, ${alpha * 0.85})`;
      ctx.lineWidth = Math.max(1.6, scale * 0.0024);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(armX, armY);
      ctx.stroke();

      // Semi-circular cup
      ctx.fillStyle = `rgba(255, 241, 118, ${alpha * 0.95})`;
      ctx.strokeStyle = `rgba(44, 29, 17, ${alpha * 0.45})`;
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.arc(armX, armY, Math.max(3.2, scale * 0.0065), a + Math.PI * 0.2, a + Math.PI * 1.2);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    // Central Golden Solar Hub Core (中央太阳日核)
    const hubR = Math.max(5.5, scale * 0.012 * pulse);
    const hubGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, hubR * 1.6);
    hubGrad.addColorStop(0, `rgba(255, 253, 231, ${alpha})`);
    hubGrad.addColorStop(0.6, `rgba(255, 179, 0, ${alpha * 0.9})`);
    hubGrad.addColorStop(1, `rgba(44, 29, 17, ${alpha * 0.4})`);
    ctx.fillStyle = hubGrad;
    ctx.beginPath();
    ctx.arc(0, 0, hubR, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(255, 255, 255, ${alpha * 0.9})`;
    ctx.lineWidth = 1.4;
    ctx.stroke();

    ctx.restore();
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Layer 4: Festive Confetti Streamers (手绘水彩彩纸与风马彩带)
  // ---------------------------------------------------------------------------
  private drawConfettiRibbons(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    scale: number,
    elapsed: number,
    progress: number,
  ): void {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';

    for (const conf of CONFETTIS) {
      // Periodic falling drift with wind velocity
      const totalTime = elapsed + conf.phase * 0.5;
      const x = ((conf.xFrac * width + conf.speedX * scale * totalTime) % (width + 80)) - 40;
      const y = (((conf.yFrac * height + conf.speedY * scale * totalTime) % (height + 120)) + height + 120) % (height + 120) - 60;

      const angle = totalTime * conf.rotSpeed;
      const tumble = Math.cos(totalTime * conf.curlFreq + conf.phase);
      const len = scale * conf.length * (0.8 + progress * 0.2);
      const w = Math.max(2.4, scale * conf.width * Math.abs(tumble));

      const alpha = Math.max(0, Math.min(1, Math.min(1, y / 60) * Math.min(1, (height - y) / 80))) * 0.88;
      if (alpha <= 0.01) continue;

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);

      // Curled paper strip
      const color = CELEBRATION_COLORS[conf.colorIndex];
      ctx.fillStyle = color;
      ctx.globalAlpha = alpha;

      ctx.beginPath();
      ctx.moveTo(-w * 0.5, -len * 0.5);
      ctx.quadraticCurveTo(w * 0.8 * tumble, 0, -w * 0.5, len * 0.5);
      ctx.lineTo(w * 0.5, len * 0.5);
      ctx.quadraticCurveTo(w * 0.8 * tumble + w, 0, w * 0.5, -len * 0.5);
      ctx.closePath();
      ctx.fill();

      // Hand-drawn ink edge
      ctx.strokeStyle = COLOR_INK;
      ctx.lineWidth = 0.6;
      ctx.globalAlpha = alpha * 0.35;
      ctx.stroke();

      ctx.restore();
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Layer 5: Swirling Watercolor Flower Petals (漫天飞舞的手绘花瓣)
  // ---------------------------------------------------------------------------
  private drawPetals(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    width: number,
    height: number,
    scale: number,
    elapsed: number,
    progress: number,
    impact: number,
  ): void {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';

    const time = this.reducedMotion ? 0.8 : elapsed;

    for (const petal of PETALS) {
      if (elapsed < petal.delay) continue;
      const localT = time - petal.delay;

      // 1. Position Dynamics: Initial radial burst + gentle swirling downward breeze
      const burstDist = scale * petal.burstSpeed * Math.min(0.7, localT) * (1 + impact * 0.8);
      const burstX = cx + Math.cos(petal.angle) * burstDist;
      const burstY = cy + Math.sin(petal.angle) * burstDist * 0.62;

      // Continuous downward gravity + sinusoidal breeze sway
      const fallY = scale * petal.fallSpeed * Math.max(0, localT - 0.25);
      const swayX = Math.sin(localT * petal.swayFreq + petal.swayPhase) * scale * petal.swayAmp;
      const swayY = Math.cos(localT * petal.swayFreq * 0.7 + petal.swayPhase) * scale * (petal.swayAmp * 0.4);

      // Loop wrapped position for settled infinity
      const rawX = burstX + swayX;
      const rawY = burstY + fallY + swayY;
      const posX = ((rawX % (width + 60)) + width + 60) % (width + 60) - 30;
      const posY = ((rawY % (height + 80)) + height + 80) % (height + 80) - 40;

      // 2. 3D Tumbling and Planar Rotation
      const rot = localT * petal.rotSpeed;
      const tumble = Math.cos(localT * petal.tumbleFreq + petal.tumblePhase);
      const size = scale * petal.size * (0.8 + progress * 0.35);
      const aspectX = Math.abs(tumble) * 0.85 + 0.15;

      // Alpha fade in/out
      const fadeIn = Math.min(1, localT / 0.18);
      const alpha = fadeIn * 0.92;

      ctx.save();
      ctx.translate(posX, posY);
      ctx.rotate(rot);
      ctx.scale(aspectX, 1.0);

      // Draw Watercolor Petal Silhouette (Cherry / Camellia / Rose)
      const color = CELEBRATION_COLORS[petal.colorIndex];
      const isBackface = tumble < 0;

      // Petal body gradient
      const grad = ctx.createLinearGradient(0, size * 0.8, 0, -size * 0.8);
      if (petal.colorIndex === 0) { // Sakura pink
        grad.addColorStop(0, isBackface ? 'rgba(255, 230, 238, 0.95)' : 'rgba(255, 245, 248, 0.98)');
        grad.addColorStop(0.7, isBackface ? 'rgba(255, 140, 180, 0.9)' : 'rgba(255, 128, 171, 0.92)');
        grad.addColorStop(1, 'rgba(240, 98, 146, 0.95)');
      } else if (petal.colorIndex === 1) { // Canvas white
        grad.addColorStop(0, 'rgba(255, 255, 255, 0.98)');
        grad.addColorStop(0.7, 'rgba(255, 248, 225, 0.92)');
        grad.addColorStop(1, 'rgba(255, 224, 130, 0.85)');
      } else {
        grad.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
        grad.addColorStop(0.6, color);
        grad.addColorStop(1, color);
      }

      ctx.fillStyle = grad;
      ctx.globalAlpha = alpha;

      ctx.beginPath();
      if (petal.petalType === 0) {
        // Notched Cherry Blossom Petal
        ctx.moveTo(0, size * 0.7);
        ctx.bezierCurveTo(-size * 0.75, size * 0.2, -size * 0.85, -size * 0.5, -size * 0.35, -size * 0.85);
        ctx.lineTo(0, -size * 0.65); // Center notch
        ctx.lineTo(size * 0.35, -size * 0.85);
        ctx.bezierCurveTo(size * 0.85, -size * 0.5, size * 0.75, size * 0.2, 0, size * 0.7);
      } else if (petal.petalType === 1) {
        // Oval Rose Petal
        ctx.moveTo(0, size * 0.75);
        ctx.bezierCurveTo(-size * 0.68, size * 0.3, -size * 0.68, -size * 0.6, 0, -size * 0.88);
        ctx.bezierCurveTo(size * 0.68, -size * 0.6, size * 0.68, size * 0.3, 0, size * 0.75);
      } else {
        // Leaf / Clover Flake
        ctx.moveTo(0, size * 0.85);
        ctx.bezierCurveTo(-size * 0.55, size * 0.1, -size * 0.7, -size * 0.5, 0, -size * 0.95);
        ctx.bezierCurveTo(size * 0.7, -size * 0.5, size * 0.55, size * 0.1, 0, size * 0.85);
      }
      ctx.closePath();
      ctx.fill();

      // Hand-drawn sepia ink edge
      ctx.strokeStyle = COLOR_INK;
      ctx.lineWidth = Math.max(0.5, scale * 0.0008);
      ctx.globalAlpha = alpha * 0.28;
      ctx.stroke();

      ctx.restore();
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Layer 6: Radiant Golden Sparks & Pollen Glints (太阳金尘与闪烁星芒)
  // ---------------------------------------------------------------------------
  private drawSparksAndPollen(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    scale: number,
    elapsed: number,
    impact: number,
  ): void {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const sparkProgress = this.reducedMotion ? 0.35 : Math.min(1, elapsed / 1.15);

    for (const spark of SPARKS) {
      const distance = scale * spark.distance * sparkProgress;
      const x = cx + Math.cos(spark.angle) * distance;
      const y = cy + Math.sin(spark.angle) * distance * 0.58;
      const tail = scale * spark.length * (0.4 + sparkProgress * 0.8);
      const tx = x - Math.cos(spark.angle) * tail;
      const ty = y - Math.sin(spark.angle) * tail * 0.58;
      const alpha = Math.max(0, 1 - Math.max(0, elapsed - 0.15 - spark.phase * 0.55) / 1.5);
      if (alpha <= 0.01) continue;

      // Kinetic streaking spark line
      ctx.strokeStyle = `rgba(255, 238, 140, ${alpha * 0.88})`;
      ctx.lineWidth = Math.max(1.2, spark.size * (0.55 + impact * 0.7));
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(x, y);
      ctx.stroke();

      // 4-point Diamond Star Sparkle at head
      const starSize = Math.max(2.0, spark.size * (0.9 + impact * 0.8));
      ctx.fillStyle = `rgba(255, 253, 231, ${alpha * 0.95})`;
      ctx.beginPath();
      ctx.moveTo(x, y - starSize * 1.4);
      ctx.lineTo(x + starSize * 0.45, y);
      ctx.lineTo(x, y + starSize * 1.4);
      ctx.lineTo(x - starSize * 0.45, y);
      ctx.closePath();
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(x - starSize * 1.4, y);
      ctx.lineTo(x, y + starSize * 0.45);
      ctx.lineTo(x + starSize * 1.4, y);
      ctx.lineTo(x, y - starSize * 0.45);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  private resize(): void {
    const width = Math.max(1, Math.floor(this.canvas.clientWidth || window.innerWidth));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight || window.innerHeight));
    const dpr = Math.min(1.25, window.devicePixelRatio || 1);
    this.canvas.width = Math.floor(width * dpr);
    this.canvas.height = Math.floor(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private clear(): void {
    this.ctx.clearRect(0, 0, this.canvas.clientWidth || window.innerWidth, this.canvas.clientHeight || window.innerHeight);
  }
}

