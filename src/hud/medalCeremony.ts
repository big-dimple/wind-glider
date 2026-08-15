import machoMedalUrl from '../assets/achievements/macho-medal.webp';

type MedalTier = 'ordinary' | 'excellent';

const TAU = Math.PI * 2;
const COLORS = ['#ffcf4a', '#55e7ff', '#ff3d7f', '#39ff88', '#f4feff'];

/** One low-resolution canvas for the entire medal ceremony. */
export class MedalCeremonyCanvas {
  readonly canvas: HTMLCanvasElement;
  private readonly medalArt: HTMLImageElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private width = 0;
  private height = 0;
  private ratio = 1;

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'hud-medal-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    parent.appendChild(this.canvas);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Medal ceremony requires Canvas2D');
    this.ctx = ctx;
    this.medalArt = document.createElement('img');
    this.medalArt.className = 'hud-medal-art';
    this.medalArt.src = machoMedalUrl;
    this.medalArt.alt = '';
    this.medalArt.setAttribute('aria-hidden', 'true');
    parent.appendChild(this.medalArt);
  }

  render(elapsed: number, duration: number, tier: MedalTier): void {
    this.resize();
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (!this.reducedMotion) {
      this.drawFireworks(elapsed, w, h);
      this.drawConfetti(elapsed, w, h);
      this.drawFirecrackerChains(elapsed, w, h);
    } else {
      this.drawStaticLaurel(w, h);
    }
    this.medalArt.dataset.tier = tier;

    if (!this.reducedMotion && elapsed > duration - 0.8) {
      const fade = Math.max(0, (elapsed - (duration - 0.8)) / 0.8);
      ctx.fillStyle = `rgba(4,7,20,${fade * 0.24})`;
      ctx.fillRect(0, 0, w, h);
    }
  }

  clear(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const ratio = Math.min(devicePixelRatio || 1, 1.25);
    if (width === this.width && height === this.height && ratio === this.ratio) return;
    this.width = width;
    this.height = height;
    this.ratio = ratio;
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
  }

  private drawFireworks(t: number, w: number, h: number): void {
    const ctx = this.ctx;
    const centers = [
      [w * 0.16, h * 0.23, 0.05],
      [w * 0.84, h * 0.19, 0.32],
      [w * 0.08, h * 0.58, 0.62],
      [w * 0.92, h * 0.55, 0.88],
    ] as const;
    for (let burst = 0; burst < centers.length; burst++) {
      const [cx, cy, delay] = centers[burst];
      const age = Math.max(0, (t - delay) % 1.45);
      if (age > 1.05) continue;
      const expansion = Math.min(1, age / 0.48);
      const alpha = Math.max(0, 1 - age / 1.05);
      for (let i = 0; i < 18; i++) {
        const angle = (i / 18) * TAU + burst * 0.31;
        const radius = (28 + (i % 4) * 9) * expansion;
        const x = cx + Math.cos(angle) * radius;
        const y = cy + Math.sin(angle) * radius + age * age * 16;
        ctx.strokeStyle = colorAlpha(COLORS[(i + burst) % COLORS.length], alpha);
        ctx.lineWidth = i % 3 === 0 ? 3 : 2;
        ctx.beginPath();
        ctx.moveTo(x - Math.cos(angle) * 8, y - Math.sin(angle) * 8);
        ctx.lineTo(x + Math.cos(angle) * 5, y + Math.sin(angle) * 5);
        ctx.stroke();
      }
    }
  }

  private drawConfetti(t: number, w: number, h: number): void {
    const ctx = this.ctx;
    const count = w < 900 ? 78 : 150;
    for (let i = 0; i < count; i++) {
      const seed = fract(Math.sin(i * 91.17) * 43758.5453);
      const side = i % 2 === 0 ? 1 : -1;
      const lane = fract(seed * 7.13 + i * 0.37);
      const x0 = side < 0 ? w * (0.03 + lane * 0.27) : w * (0.70 + lane * 0.27);
      const speed = 50 + seed * 92;
      const y = ((seed * h + t * speed) % (h + 50)) - 25;
      const sway = Math.sin(t * (2.4 + seed * 2) + i) * (9 + seed * 15);
      const x = x0 + sway;
      const rot = t * (2.2 + seed * 5) + i;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rot);
      ctx.fillStyle = colorAlpha(COLORS[i % COLORS.length], 0.82);
      if (i % 5 === 0) {
        ctx.beginPath();
        ctx.ellipse(0, 0, 3, 8, 0, 0, TAU);
        ctx.fill();
      } else {
        ctx.fillRect(-2, -6, 4, 12);
      }
      ctx.restore();
    }
  }

  private drawFirecrackerChains(t: number, w: number, h: number): void {
    const ctx = this.ctx;
    const compact = w < 900;
    // The vertical chains frame a phone naturally, but at desktop width they
    // read like two rulers. Fireworks and confetti already fill that space.
    if (!compact) return;
    for (const side of [-1, 1]) {
      const x = side < 0
        ? Math.max(22, w * 0.045)
        : Math.min(w - 22, w * 0.955);
      const top = h * 0.17;
      const bottom = h * 0.78;
      ctx.strokeStyle = '#ffcf4a';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      const count = 8;
      for (let i = 0; i < count; i++) {
        const y = top + (i + 0.65) * (bottom - top) / count;
        const pulse = 1 + Math.sin(t * 12 - i * 1.7) * 0.12;
        ctx.save();
        ctx.translate(x + side * (i % 2 ? 10 : -10), y);
        ctx.rotate(side * 0.24);
        ctx.scale(pulse, pulse);
        ctx.fillStyle = '#ff3d7f';
        ctx.strokeStyle = '#14122b';
        ctx.lineWidth = 3;
        const halfW = 7;
        const halfH = 12;
        ctx.fillRect(-halfW, -halfH, halfW * 2, halfH * 2);
        ctx.strokeRect(-halfW, -halfH, halfW * 2, halfH * 2);
        ctx.restore();
      }
    }
  }

  private drawStaticLaurel(w: number, h: number): void {
    const ctx = this.ctx;
    const cy = h * (h < 520 ? 0.3 : 0.34);
    ctx.fillStyle = '#39ff88';
    for (const side of [-1, 1]) {
      for (let i = 0; i < 7; i++) {
        const angle = -0.75 + i * 0.24;
        const x = w * 0.5 + side * (90 + i * 8);
        const y = cy + 44 - Math.sin(angle + 1) * 82;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(side * angle);
        ctx.beginPath();
        ctx.ellipse(0, 0, 5, 13, 0, 0, TAU);
        ctx.fill();
        ctx.restore();
      }
    }
  }

}

const fract = (value: number): number => value - Math.floor(value);

const colorAlpha = (hex: string, alpha: number): string => {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha))})`;
};
