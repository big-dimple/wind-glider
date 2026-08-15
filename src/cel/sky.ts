/**
 * sky.ts — Ghibli hand-drawn watercolor clear sky dome and dynamic cumulonimbus cloudscape.
 *
 * Visual aesthetic:
 * - 3-band Ghibli watercolor gradient dome: zenith azure -> clear sky mid-blue -> warm horizon haze.
 * - Graphic anime sun disc with warm corona halo, stepped 12-segment sunburst rays, and crepuscular God rays (丁达尔光柱).
 * - Multi-tier dynamic hand-painted watercolor cumulonimbus cloudscape (hero towering thunderheads, mid massifs, and drifting wisps).
 * - Multi-tier cel cloud shading: golden rim highlight, luminous body, and soft blue-gray shaded underbelly.
 *
 * Performance & Pipeline:
 * - Rig is centered on camera (infinite sky illusion).
 * - 3 depth tiers of clouds with differential drift speeds and sinusoidal vertical floating undulation.
 * - Zero per-frame memory allocations — update() uses preallocated Float32Array buffers.
 * - Colors pulled directly from PALETTE (NoColorSpace) with zero unauthored drift.
 */
import * as THREE from 'three';
import { PALETTE } from '../core/palette';
import { SUN_DIR } from './toonMaterial';

const SKY_RADIUS = 4500;

// Cloud distribution counts across 3 depth tiers
const HERO_COUNT = 6;   // Towering monumental cumulonimbus pillars (far & massive)
const MID_COUNT = 12;   // Floating cumulonimbus massifs & clusters (medium depth)
const NEAR_COUNT = 14;  // Dynamic light cumulus & wind-swept wisps (near/fast drift)
const TOTAL_CLOUD_COUNT = HERO_COUNT + MID_COUNT + NEAR_COUNT; // 32

/** Deterministic pseudo-random hash → 0..1 (stable layout across runs/screenshots). */
function hash(i: number, k: number): number {
  const s = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Palette hex int → CSS '#rrggbb' for canvas 2D fills. */
function css(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

/** Palette hex → THREE.Color verbatim (no color-space conversion). */
function flat(hex: number): THREE.Color {
  return new THREE.Color().setHex(hex, THREE.NoColorSpace);
}

// ----------------------------------------------------------- sky dome shader ----

const skyVertexShader = /* glsl */ `
varying vec3 vDir; // camera-relative direction vector

void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const skyFragmentShader = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uMid;
uniform vec3 uHorizon;
uniform vec3 uSunDir;    // normalized, pointing TOWARD the sun
uniform vec3 uSunCore;
uniform vec3 uSunFlare;
uniform vec3 uSunColor;
uniform float uTime;     // seconds — drives slow stepped ray rotation & god ray drift

varying vec3 vDir;

void main() {
  vec3 dir = normalize(vDir);
  float h = dir.y;

  // ---------------------------------------------------------------
  // 3-BAND GHIBLI WATERCOLOR SKY GRADIENT:
  // Horizon warm haze -> Clear mid-sky blue -> Zenith deep azure.
  // ---------------------------------------------------------------
  vec3 col = uHorizon;
  col = mix(col, uMid, smoothstep(0.01, 0.14, h));
  col = mix(col, uZenith, smoothstep(0.24, 0.45, h));

  // ---------------------------------------------------------------
  // ATMOSPHERIC SUN GLOW & HORIZON HAZE:
  // Warm forward scattering around the sun and the horizon sector.
  // ---------------------------------------------------------------
  float sunCos = clamp(dot(dir, uSunDir), -1.0, 1.0);
  float sunScatter = max(0.0, sunCos);
  float halo = pow(sunScatter, 6.0) * 0.42;
  float horizSunHaze = max(0.0, sunCos) * (1.0 - smoothstep(0.0, 0.22, abs(h))) * 0.22;
  col = mix(col, uSunFlare, halo + horizSunHaze);

  // ---------------------------------------------------------------
  // SUN AZIMUTH & POLAR COORDINATES (relative to sun axis)
  // ---------------------------------------------------------------
  float ang = acos(sunCos); // radians off-sun
  vec3 t0 = normalize(cross(uSunDir, vec3(0.0, 1.0, 0.0)));
  vec3 t1 = cross(t0, uSunDir);
  float az = atan(dot(dir, t1), dot(dir, t0)); // azimuth around the sun vector

  // ---------------------------------------------------------------
  // GRAPHIC ANIME SUN — Hard core disc + stepped corona rings +
  // alternating long/short 12-segment sunburst rays.
  // ---------------------------------------------------------------
  // Hard sun core disc (~2.4 degrees).
  float disc = 1.0 - step(0.042, ang);

  // Inner warm corona ring hugging the disc.
  float ring0 = step(0.042, ang) * (1.0 - step(0.056, ang));

  // Outer subtle halo ring.
  float ring1 = step(0.064, ang) * (1.0 - step(0.072, ang)) * 0.7;

  // 12 rectangular rays, separated by gaps, alternating long/short radial extents.
  // Rotation advances in hard stepped increments for a graphic manga/anime look.
  float rot = floor(uTime * 1.5) * 0.004;
  float seg = 6.28318530718 / 12.0;
  float rayAz = 1.0 - step(seg * 0.22, abs(mod(az + rot, seg) - seg * 0.5));
  float longRay = step(0.5, mod(floor((az + rot) / seg), 2.0));
  float rayEnd = mix(0.12, 0.20, longRay);
  float burstRays = rayAz * step(0.080, ang) * (1.0 - step(rayEnd, ang));

  // ---------------------------------------------------------------
  // ATMOSPHERIC CREPUSCULAR GOD RAYS (丁达尔圣光柱):
  // Radiating multi-harmonic watercolor light beams with soft slow drift.
  // ---------------------------------------------------------------
  float rayBeam1 = sin(az * 7.0 + uTime * 0.05) * 0.5 + 0.5;
  float rayBeam2 = cos(az * 11.0 - uTime * 0.035 + 1.2) * 0.5 + 0.5;
  float rayBeam3 = sin(az * 17.0 + uTime * 0.07 - 0.8) * 0.5 + 0.5;
  float godRaysRaw = rayBeam1 * 0.50 + rayBeam2 * 0.30 + rayBeam3 * 0.20;
  float godRays = smoothstep(0.42, 0.78, godRaysRaw);
  float rayReach = smoothstep(1.25, 0.10, ang) * smoothstep(0.05, 0.25, ang);
  float godRayIntensity = godRays * rayReach * 0.28 * (0.6 + 0.4 * max(0.0, h));

  col = mix(col, uSunFlare, max(max(ring0, ring1), burstRays));
  col = mix(col, uSunFlare, godRayIntensity);
  col = mix(col, uSunCore, disc);

  gl_FragColor = vec4(col, 1.0);
}
`;

// -------------------------------------------------------------- cloud textures ----

/**
 * Generates hand-drawn Ghibli watercolor cloud textures on procedural HTML5 Canvas:
 * - Variant 0: Monumental Towering Cumulonimbus (入道云山·巨型积云柱).
 * - Variant 1: Sprawling Cumulonimbus Massif (连绵积雨云群·多峰云海).
 * - Variant 2: Wind-Swept Stratocumulus (风卷飞云·舒展流线).
 * - Variant 3: Low Horizon Summer Cumulus Bank (低空海天云层·平底积云).
 *
 * All variants feature 3-tier cel watercolor shading:
 * 1. Top/sunlit crest golden rim highlight (PALETTE.cloudRim).
 * 2. Luminous crisp anime cloud body (PALETTE.cloudBody).
 * 3. Stepped watercolor underbelly & crevice shading (PALETTE.cloudShade).
 */
function makeCloudTexture(variant: number): THREE.CanvasTexture {
  const w = 512;
  const h = variant === 2 ? 320 : variant === 3 ? 256 : 384;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;

  if (variant === 0) {
    // =========================================================================
    // Variant 0: Monumental Towering Cumulonimbus (入道云山·巨型积云柱)
    // =========================================================================
    const drawLobes = (dx: number, dy: number, fill: string): void => {
      ctx.fillStyle = fill;
      ctx.beginPath();
      // Flat grounding base
      ctx.ellipse(256 + dx, 315 + dy, 195, 48, 0, 0, Math.PI * 2);

      // Lower tier billows
      ctx.arc(130 + dx, 265 + dy, 68, 0, Math.PI * 2);
      ctx.arc(190 + dx, 215 + dy, 82, 0, Math.PI * 2);
      ctx.arc(315 + dx, 220 + dy, 80, 0, Math.PI * 2);
      ctx.arc(385 + dx, 270 + dy, 62, 0, Math.PI * 2);

      // Mid/Upper towering column
      ctx.arc(205 + dx, 145 + dy, 76, 0, Math.PI * 2);
      ctx.arc(265 + dx, 100 + dy, 90, 0, Math.PI * 2);
      ctx.arc(330 + dx, 138 + dy, 72, 0, Math.PI * 2);

      // Summit cauliflower crests
      ctx.arc(232 + dx, 62 + dy, 38, 0, Math.PI * 2);
      ctx.arc(272 + dx, 52 + dy, 42, 0, Math.PI * 2);
      ctx.arc(312 + dx, 68 + dy, 36, 0, Math.PI * 2);
      ctx.fill();
    };

    // 1. Golden rim highlight at sunlit crest
    drawLobes(0, 0, css(PALETTE.cloudRim));
    // 2. Bright sunlit cloud body
    drawLobes(2, 9, css(PALETTE.cloudBody));

    // 3. Stepped watercolor under-shade & internal lobe crevices
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = css(PALETTE.cloudShade);
    // Base shadow shelf
    ctx.fillRect(0, 275, w, h - 275);
    // Mid-tier overhang cavities
    ctx.beginPath();
    ctx.ellipse(220, 255, 88, 34, -0.12, 0, Math.PI * 2);
    ctx.ellipse(335, 250, 82, 30, 0.10, 0, Math.PI * 2);
    // Upper crevice shading
    ctx.ellipse(240, 162, 54, 24, -0.18, 0, Math.PI * 2);
    ctx.ellipse(312, 158, 48, 22, 0.15, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  } else if (variant === 1) {
    // =========================================================================
    // Variant 1: Sprawling Cumulonimbus Massif (连绵积雨云群·多峰云海)
    // =========================================================================
    const drawLobes = (dx: number, dy: number, fill: string): void => {
      ctx.fillStyle = fill;
      ctx.beginPath();
      // Broad base
      ctx.ellipse(256 + dx, 318 + dy, 225, 46, 0, 0, Math.PI * 2);

      // Left massif summit
      ctx.arc(100 + dx, 262 + dy, 56, 0, Math.PI * 2);
      ctx.arc(140 + dx, 212 + dy, 70, 0, Math.PI * 2);
      ctx.arc(160 + dx, 146 + dy, 66, 0, Math.PI * 2);

      // Central towering massif summit
      ctx.arc(220 + dx, 172 + dy, 78, 0, Math.PI * 2);
      ctx.arc(270 + dx, 112 + dy, 90, 0, Math.PI * 2);
      ctx.arc(320 + dx, 162 + dy, 74, 0, Math.PI * 2);
      ctx.arc(252 + dx, 76 + dy, 38, 0, Math.PI * 2);
      ctx.arc(288 + dx, 72 + dy, 40, 0, Math.PI * 2);

      // Right flank summit
      ctx.arc(382 + dx, 196 + dy, 70, 0, Math.PI * 2);
      ctx.arc(426 + dx, 248 + dy, 54, 0, Math.PI * 2);
      ctx.fill();
    };

    // 1. Golden rim highlight
    drawLobes(0, 0, css(PALETTE.cloudRim));
    // 2. Cloud body
    drawLobes(2, 9, css(PALETTE.cloudBody));

    // 3. Under-shade and saddle dip shadows
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = css(PALETTE.cloudShade);
    ctx.fillRect(0, 270, w, h - 270);
    ctx.beginPath();
    ctx.ellipse(186, 230, 64, 28, -0.15, 0, Math.PI * 2);
    ctx.ellipse(352, 220, 62, 26, 0.12, 0, Math.PI * 2);
    ctx.ellipse(270, 245, 95, 32, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  } else if (variant === 2) {
    // =========================================================================
    // Variant 2: Wind-Swept Stratocumulus (风卷飞云·舒展流线)
    // =========================================================================
    const drawLobes = (dx: number, dy: number, fill: string): void => {
      ctx.fillStyle = fill;
      ctx.beginPath();
      // Extended slanted base
      ctx.ellipse(256 + dx, 245 + dy, 215, 42, 0, 0, Math.PI * 2);

      // Sweeping left wisps
      ctx.arc(85 + dx, 238 + dy, 40, 0, Math.PI * 2);
      ctx.arc(135 + dx, 212 + dy, 52, 0, Math.PI * 2);
      ctx.arc(185 + dx, 188 + dy, 62, 0, Math.PI * 2);

      // Main central arches
      ctx.arc(248 + dx, 158 + dy, 72, 0, Math.PI * 2);
      ctx.arc(318 + dx, 152 + dy, 70, 0, Math.PI * 2);

      // Aerodynamic right tail
      ctx.arc(388 + dx, 184 + dy, 60, 0, Math.PI * 2);
      ctx.arc(442 + dx, 214 + dy, 48, 0, Math.PI * 2);
      ctx.fill();
    };

    // 1. Golden rim
    drawLobes(0, 0, css(PALETTE.cloudRim));
    // 2. Cloud body
    drawLobes(1, 8, css(PALETTE.cloudBody));

    // 3. Under-shade
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = css(PALETTE.cloudShade);
    ctx.fillRect(0, 222, w, h - 222);
    ctx.beginPath();
    ctx.ellipse(272, 212, 115, 30, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  } else {
    // =========================================================================
    // Variant 3: Low Horizon Summer Cumulus Bank (低空海天云层·平底积云)
    // =========================================================================
    const drawLobes = (dx: number, dy: number, fill: string): void => {
      ctx.fillStyle = fill;
      ctx.beginPath();
      // Flat ocean horizon shelf
      ctx.ellipse(256 + dx, 204 + dy, 235, 38, 0, 0, Math.PI * 2);

      // Gentle rounded summer top billows
      ctx.arc(110 + dx, 172 + dy, 54, 0, Math.PI * 2);
      ctx.arc(176 + dx, 148 + dy, 64, 0, Math.PI * 2);
      ctx.arc(252 + dx, 132 + dy, 70, 0, Math.PI * 2);
      ctx.arc(328 + dx, 142 + dy, 66, 0, Math.PI * 2);
      ctx.arc(398 + dx, 168 + dy, 56, 0, Math.PI * 2);
      ctx.fill();
    };

    // 1. Golden rim
    drawLobes(0, 0, css(PALETTE.cloudRim));
    // 2. Cloud body
    drawLobes(1, 7, css(PALETTE.cloudBody));

    // 3. Under-shade
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = css(PALETTE.cloudShade);
    ctx.fillRect(0, 178, w, h - 178);
    ctx.beginPath();
    ctx.ellipse(256, 175, 130, 26, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

// ------------------------------------------------------------------ Sky ----

export class Sky {
  readonly object: THREE.Object3D;

  private readonly skyUniforms: { [uniform: string]: THREE.IUniform };
  private readonly sprites: THREE.Sprite[] = [];

  // Per-cloud ring parameters (0..5 Hero, 6..17 Mid, 18..31 Near).
  private readonly cRadius = new Float32Array(TOTAL_CLOUD_COUNT);
  private readonly cAngle = new Float32Array(TOTAL_CLOUD_COUNT);
  private readonly cOmega = new Float32Array(TOTAL_CLOUD_COUNT);
  private readonly cBaseAlt = new Float32Array(TOTAL_CLOUD_COUNT);
  private readonly cBobFreq = new Float32Array(TOTAL_CLOUD_COUNT);
  private readonly cBobPhase = new Float32Array(TOTAL_CLOUD_COUNT);
  private readonly cBobAmp = new Float32Array(TOTAL_CLOUD_COUNT);

  constructor() {
    const group = new THREE.Group();
    group.name = 'sky';
    this.object = group;

    // --- 1. Hand-drawn watercolor sky dome with anime sun & god rays ---
    this.skyUniforms = {
      uZenith: { value: flat(PALETTE.skyZenith) },
      uMid: { value: flat(PALETTE.skyMid) },
      uHorizon: { value: flat(PALETTE.skyHorizon) },
      uSunDir: { value: SUN_DIR },
      uSunCore: { value: flat(PALETTE.sunCore) },
      uSunFlare: { value: flat(PALETTE.sunFlare) },
      uSunColor: { value: flat(PALETTE.sun) },
      uTime: { value: 0 },
    };

    const skyMat = new THREE.ShaderMaterial({
      name: 'CelSky',
      uniforms: this.skyUniforms,
      vertexShader: skyVertexShader,
      fragmentShader: skyFragmentShader,
      side: THREE.BackSide,
      depthWrite: false,
    });

    const dome = new THREE.Mesh(new THREE.SphereGeometry(SKY_RADIUS, 32, 16), skyMat);
    dome.frustumCulled = false;
    dome.renderOrder = -1000; // Paint first in opaque pass
    group.add(dome);

    // --- 2. 4 specialized procedural Ghibli cloud textures ---
    const texCumulonimbus = makeCloudTexture(0); // Monumental towering thunderhead
    const texMassif = makeCloudTexture(1);        // Sprawling multi-peak massif
    const texStratocumulus = makeCloudTexture(2); // Wind-swept aerodynamic wisps
    const texHorizonBank = makeCloudTexture(3);   // Low summer horizon cumulus shelf

    // Shared materials with atmospheric tinting
    const heroMatA = new THREE.SpriteMaterial({
      map: texCumulonimbus,
      color: flat(PALETTE.skyHorizon), // Subtle atmospheric distance tint
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    const heroMatB = new THREE.SpriteMaterial({
      map: texMassif,
      color: flat(PALETTE.skyHorizon),
      transparent: true,
      depthWrite: false,
      fog: false,
    });

    const midMatA = new THREE.SpriteMaterial({
      map: texCumulonimbus,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    const midMatB = new THREE.SpriteMaterial({
      map: texMassif,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    const midMatC = new THREE.SpriteMaterial({
      map: texHorizonBank,
      color: flat(PALETTE.skyHorizon),
      transparent: true,
      depthWrite: false,
      fog: false,
    });

    const nearMatA = new THREE.SpriteMaterial({
      map: texCumulonimbus,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    const nearMatB = new THREE.SpriteMaterial({
      map: texStratocumulus,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    const nearMatC = new THREE.SpriteMaterial({
      map: texHorizonBank,
      transparent: true,
      depthWrite: false,
      fog: false,
    });

    // --- 3. Construct 3 Depth Tiers (Hero, Mid, Near) ---
    for (let i = 0; i < TOTAL_CLOUD_COUNT; i++) {
      let mat: THREE.SpriteMaterial;
      let sx: number;
      let sy: number;

      if (i < HERO_COUNT) {
        // -------------------------------------------------------------
        // TIER 0: HERO TOWERING CUMULONIMBUS PILLARS (6 clouds)
        // Far distance, massive scale, slow majestic drift.
        // -------------------------------------------------------------
        const variant = i % 2;
        mat = variant === 0 ? heroMatA : heroMatB;

        const baseAngle = (i / HERO_COUNT) * Math.PI * 2;
        this.cAngle[i] = baseAngle + hash(i, 1) * 0.45;
        this.cRadius[i] = 3600 + hash(i, 2) * 650;
        this.cBaseAlt[i] = 420 + hash(i, 3) * 320;

        // Slow majestic drift
        const dir = hash(i, 4) > 0.3 ? 1 : -1;
        this.cOmega[i] = dir * (0.0007 + hash(i, 5) * 0.0005);

        // Sinusoidal vertical breathing
        this.cBobFreq[i] = 0.035 + hash(i, 6) * 0.025; // ~20s period
        this.cBobPhase[i] = hash(i, 7) * Math.PI * 2;
        this.cBobAmp[i] = 18 + hash(i, 8) * 12;

        sx = 1600 + hash(i, 9) * 600;
        sy = sx * 0.75;
      } else if (i < HERO_COUNT + MID_COUNT) {
        // -------------------------------------------------------------
        // TIER 1: MID-RANGE FLOATING CUMULONIMBUS MASSIFS (12 clouds)
        // Medium distance, substantial volume, moderate drift.
        // -------------------------------------------------------------
        const idx = i - HERO_COUNT;
        const variant = idx % 3;
        mat = variant === 0 ? midMatA : variant === 1 ? midMatB : midMatC;

        const baseAngle = (idx / MID_COUNT) * Math.PI * 2;
        this.cAngle[i] = baseAngle + hash(i, 1) * 0.50;
        this.cRadius[i] = 2200 + hash(i, 2) * 750;
        this.cBaseAlt[i] = 240 + hash(i, 3) * 260;

        // Moderate drift
        const dir = hash(i, 4) > 0.22 ? 1 : -1;
        this.cOmega[i] = dir * (0.0018 + hash(i, 5) * 0.0012);

        // Vertical bobbing
        this.cBobFreq[i] = 0.06 + hash(i, 6) * 0.04; // ~12-16s period
        this.cBobPhase[i] = hash(i, 7) * Math.PI * 2;
        this.cBobAmp[i] = 22 + hash(i, 8) * 16;

        sx = 800 + hash(i, 9) * 380;
        sy = sx * (variant === 2 ? 0.50 : 0.75);
      } else {
        // -------------------------------------------------------------
        // TIER 2: NEAR DYNAMIC LIGHT CUMULUS & WIND WISPS (14 clouds)
        // Near distance, crisp detail, responsive drift parallax.
        // -------------------------------------------------------------
        const idx = i - (HERO_COUNT + MID_COUNT);
        const variant = idx % 3;
        mat = variant === 0 ? nearMatA : variant === 1 ? nearMatB : nearMatC;

        const baseAngle = (idx / NEAR_COUNT) * Math.PI * 2;
        this.cAngle[i] = baseAngle + hash(i, 1) * 0.55;
        this.cRadius[i] = 1200 + hash(i, 2) * 550;
        this.cBaseAlt[i] = 130 + hash(i, 3) * 180;

        // Active drift
        const dir = hash(i, 4) > 0.18 ? 1 : -1;
        this.cOmega[i] = dir * (0.0036 + hash(i, 5) * 0.0024);

        // Dynamic bobbing
        this.cBobFreq[i] = 0.09 + hash(i, 6) * 0.06; // ~8-12s period
        this.cBobPhase[i] = hash(i, 7) * Math.PI * 2;
        this.cBobAmp[i] = 16 + hash(i, 8) * 14;

        sx = 380 + hash(i, 9) * 180;
        sy = sx * (variant === 1 ? 0.625 : variant === 2 ? 0.50 : 0.75);
      }

      const sprite = new THREE.Sprite(mat);
      sprite.frustumCulled = false;
      sprite.scale.set(sx, sy, 1);

      this.sprites.push(sprite);
      group.add(sprite);
    }

    this.update(0, new THREE.Vector3());
  }

  /** Follow camera and advance dynamic cloud drift and vertical undulation. Zero memory allocation per frame. */
  update(t: number, camPos: THREE.Vector3): void {
    this.object.position.copy(camPos);
    this.skyUniforms.uTime.value = t;

    for (let i = 0; i < TOTAL_CLOUD_COUNT; i++) {
      const a = this.cAngle[i] + t * this.cOmega[i];
      const r = this.cRadius[i];
      const y = this.cBaseAlt[i] + Math.sin(t * this.cBobFreq[i] + this.cBobPhase[i]) * this.cBobAmp[i];
      this.sprites[i].position.set(Math.cos(a) * r, y, Math.sin(a) * r);
    }
  }
}
