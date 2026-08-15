/**
 * waves.ts — SINGLE SOURCE OF TRUTH for the ocean surface.
 *
 * The same wave set drives:
 *   - the GPU vertex displacement of the ocean mesh (via WAVES_GLSL below),
 *   - the racing-line ribbon and wake ribbons (same GLSL chunk),
 *   - CPU sampling for boat buoyancy, gate bobbing, AI and spawn placement.
 *
 * Model: sum of Gerstner waves (GPU Gems 1, ch.1 style).
 *   k = 2π / wavelength          (wave number)
 *   ω = sqrt(g·k) · speedMul     (angular frequency, natural dispersion)
 *   A = amplitude                (vertical)
 *   Q = steepness                (horizontal displacement scale → crest sharpening)
 *
 *   φ(p,t) = k·(D·p.xz) + ω·t + phase
 *   P.x  += Q·A·D.x·cos(φ)
 *   P.z  += Q·A·D.z·cos(φ)
 *   P.y   = A·sin(φ)
 *
 * CPU height sampling ignores the horizontal displacement term (standard
 * approximation): waterHeight(x,z,t) = Σ A·sin(φ). The error is small for
 * our steepness values and it keeps buoyancy cheap and stable. The CPU
 * normal uses the analytic derivative of the same height sum, so CPU and
 * GPU never drift apart visually or physically.
 */

export interface GerstnerWave {
  /** Normalized XZ travel direction. */
  dir: [number, number];
  /** Vertical amplitude in meters. */
  amplitude: number;
  /** 0..1 horizontal sharpness — higher = sharper crests. Keep Σ(Q·A·k) < 1 to avoid loops. */
  steepness: number;
  /** Meters crest-to-crest. */
  wavelength: number;
  /** Multiplier on natural phase speed sqrt(g/k). */
  speedMul: number;
  /** Fixed phase offset so waves don't align at t=0. */
  phase: number;
}

const G = 9.8;

/**
 * The wave set. Two long swells travelling at an angle to each other, one
 * mid sea, two chops. Tuned by eye against screenshots — do not "rebalance"
 * mathematically, the look is the spec.
 */
export const WAVES: readonly GerstnerWave[] = [
  { dir: [0.94, 0.34], amplitude: 1.15, steepness: 0.55, wavelength: 72.0, speedMul: 0.55, phase: 0.0 },
  { dir: [0.68, -0.73], amplitude: 0.62, steepness: 0.5, wavelength: 38.0, speedMul: 0.7, phase: 1.7 },
  { dir: [-0.29, 0.96], amplitude: 0.3, steepness: 0.45, wavelength: 19.0, speedMul: 0.9, phase: 3.9 },
  { dir: [0.99, -0.12], amplitude: 0.14, steepness: 0.35, wavelength: 9.5, speedMul: 1.1, phase: 2.3 },
  { dir: [-0.72, -0.69], amplitude: 0.07, steepness: 0.3, wavelength: 5.2, speedMul: 1.3, phase: 5.1 },
];

export const MAX_AMPLITUDE = WAVES.reduce((s, w) => s + w.amplitude, 0);

interface CompiledWave {
  dx: number;
  dz: number;
  k: number;
  omega: number;
  amp: number;
  q: number;
  phase: number;
}

const COMPILED: CompiledWave[] = WAVES.map((w) => {
  const len = Math.hypot(w.dir[0], w.dir[1]) || 1;
  const k = (Math.PI * 2) / w.wavelength;
  return {
    dx: w.dir[0] / len,
    dz: w.dir[1] / len,
    k,
    omega: Math.sqrt(G * k) * w.speedMul,
    amp: w.amplitude,
    q: w.steepness,
    phase: w.phase,
  };
});

/** Water surface height (meters) at world (x, z) and sim time t. CPU mirror of the GPU sum. */
export function waterHeight(x: number, z: number, t: number): number {
  let y = 0;
  for (let i = 0; i < COMPILED.length; i++) {
    const w = COMPILED[i];
    y += w.amp * Math.sin(w.k * (w.dx * x + w.dz * z) + w.omega * t + w.phase);
  }
  return y;
}

/**
 * Analytic water normal at (x, z, t), written into `out` (any object with x/y/z).
 * Derived from the same height sum: dh/dx = Σ A·k·Dx·cos(φ).
 */
export function waterNormalInto(out: { x: number; y: number; z: number }, x: number, z: number, t: number): void {
  let dhx = 0;
  let dhz = 0;
  for (let i = 0; i < COMPILED.length; i++) {
    const w = COMPILED[i];
    const c = w.amp * w.k * Math.cos(w.k * (w.dx * x + w.dz * z) + w.omega * t + w.phase);
    dhx += c * w.dx;
    dhz += c * w.dz;
  }
  const inv = 1 / Math.hypot(dhx, 1, dhz);
  out.x = -dhx * inv;
  out.y = inv;
  out.z = -dhz * inv;
}

/**
 * GLSL chunk generated from the same WAVES table — shader and CPU can never drift.
 * Provides:
 *   float waveHeight(vec2 p, float t)      — height only (ribbons, foam logic)
 *   vec3  gerstnerDisplace(vec3 p, float t) — full Gerstner displacement (ocean mesh)
 *   vec3  gerstnerNormal(vec2 p, float t)   — analytic normal of the height field
 */
export const WAVES_GLSL: string = (() => {
  const n = COMPILED.length;
  const f = (v: number) => v.toFixed(7);
  let body = '';
  body += `const int NUM_WAVES = ${n};\n`;
  body += `// per wave: dir.xy, k, omega | amp, steepness, phase, unused\n`;
  body += `const vec4 WAVE_A[NUM_WAVES] = vec4[NUM_WAVES](\n`;
  body += COMPILED.map((w) => `  vec4(${f(w.dx)}, ${f(w.dz)}, ${f(w.k)}, ${f(w.omega)})`).join(',\n');
  body += `\n);\n`;
  body += `const vec4 WAVE_B[NUM_WAVES] = vec4[NUM_WAVES](\n`;
  body += COMPILED.map((w) => `  vec4(${f(w.amp)}, ${f(w.q)}, ${f(w.phase)}, 0.0)`).join(',\n');
  body += `\n);\n`;
  body += `
float waveHeight(vec2 p, float t) {
  float y = 0.0;
  for (int i = 0; i < NUM_WAVES; i++) {
    vec4 a = WAVE_A[i];
    vec4 b = WAVE_B[i];
    y += b.x * sin(a.z * dot(a.xy, p) + a.w * t + b.z);
  }
  return y;
}

vec3 gerstnerDisplace(vec3 p, float t) {
  vec3 d = p;
  for (int i = 0; i < NUM_WAVES; i++) {
    vec4 a = WAVE_A[i];
    vec4 b = WAVE_B[i];
    float ph = a.z * dot(a.xy, p.xz) + a.w * t + b.z;
    float qa = b.y * b.x;
    d.x += qa * a.x * cos(ph);
    d.z += qa * a.y * cos(ph);
    d.y += b.x * sin(ph);
  }
  return d;
}

vec3 gerstnerNormal(vec2 p, float t) {
  float dhx = 0.0;
  float dhz = 0.0;
  for (int i = 0; i < NUM_WAVES; i++) {
    vec4 a = WAVE_A[i];
    vec4 b = WAVE_B[i];
    float c = b.x * a.z * cos(a.z * dot(a.xy, p) + a.w * t + b.z);
    dhx += c * a.x;
    dhz += c * a.y;
  }
  return normalize(vec3(-dhx, 1.0, -dhz));
}
`;
  return body;
})();
