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

// Cloud distribution counts across 4 depth tiers
const HERO_COUNT = 6;   // Towering monumental cumulonimbus pillars (far & massive)
const MID_COUNT = 12;   // Floating cumulonimbus massifs & clusters (medium depth)
const NEAR_COUNT = 14;  // Dynamic light cumulus & wind-swept wisps (near/fast drift)
const CIRRUS_COUNT = 8; // High-altitude cirrus veil streamers (high altitude)
const TOTAL_CLOUD_COUNT = HERO_COUNT + MID_COUNT + NEAR_COUNT + CIRRUS_COUNT; // 40

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
  col = mix(col, uMid, smoothstep(0.01, 0.16, h));
  col = mix(col, uZenith, smoothstep(0.22, 0.48, h));

  // ---------------------------------------------------------------
  // ATMOSPHERIC SUN GLOW & HORIZON HAZE:
  // Warm forward scattering around the sun and the horizon sector.
  // ---------------------------------------------------------------
  float sunCos = clamp(dot(dir, uSunDir), -1.0, 1.0);
  float sunScatter = max(0.0, sunCos);
  float halo = pow(sunScatter, 5.5) * 0.45;
  float horizSunHaze = max(0.0, sunCos) * (1.0 - smoothstep(0.0, 0.25, abs(h))) * 0.25;
  col = mix(col, uSunFlare, halo + horizSunHaze);

  // ---------------------------------------------------------------
  // SUN AZIMUTH & POLAR COORDINATES (relative to sun axis)
  // ---------------------------------------------------------------
  float ang = acos(sunCos); // radians off-sun
  vec3 t0 = normalize(cross(uSunDir, vec3(0.0, 1.0, 0.0)));
  vec3 t1 = cross(t0, uSunDir);
  float az = atan(dot(dir, t1), dot(dir, t0)); // azimuth around the sun vector

  // ---------------------------------------------------------------
  // GRAPHIC ANIME SUN — Soft core disc + stepped corona rings +
  // alternating long/short 12-segment sunburst rays.
  // ---------------------------------------------------------------
  // Sun core disc (~2.4 degrees) with micro watercolor edge softening.
  float disc = 1.0 - smoothstep(0.038, 0.044, ang);

  // Inner warm corona ring hugging the disc.
  float ring0 = smoothstep(0.040, 0.044, ang) * (1.0 - smoothstep(0.056, 0.060, ang));

  // Outer subtle halo ring.
  float ring1 = smoothstep(0.062, 0.066, ang) * (1.0 - smoothstep(0.074, 0.078, ang)) * 0.75;

  // 12 rectangular rays, separated by gaps, alternating long/short radial extents.
  // Rotation advances in hard stepped increments for a graphic manga/anime look.
  float rot = floor(uTime * 1.5) * 0.004;
  float seg = 6.28318530718 / 12.0;
  float rayAz = 1.0 - step(seg * 0.22, abs(mod(az + rot, seg) - seg * 0.5));
  float longRay = step(0.5, mod(floor((az + rot) / seg), 2.0));
  float rayEnd = mix(0.12, 0.20, longRay);
  float burstRays = rayAz * smoothstep(0.076, 0.082, ang) * (1.0 - smoothstep(rayEnd - 0.006, rayEnd, ang));

  // ---------------------------------------------------------------
  // ATMOSPHERIC CREPUSCULAR GOD RAYS (丁达尔圣光柱):
  // Radiating multi-harmonic watercolor light beams with soft slow drift.
  // ---------------------------------------------------------------
  float rayBeam1 = sin(az * 7.0 + uTime * 0.05) * 0.5 + 0.5;
  float rayBeam2 = cos(az * 11.0 - uTime * 0.035 + 1.2) * 0.5 + 0.5;
  float rayBeam3 = sin(az * 17.0 + uTime * 0.07 - 0.8) * 0.5 + 0.5;
  float godRaysRaw = rayBeam1 * 0.50 + rayBeam2 * 0.30 + rayBeam3 * 0.20;
  float godRays = smoothstep(0.40, 0.76, godRaysRaw);
  float rayReach = smoothstep(1.30, 0.10, ang) * smoothstep(0.05, 0.25, ang);
  float godRayIntensity = godRays * rayReach * 0.30 * (0.6 + 0.4 * max(0.0, h));

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
 * - Variant 1: Sprawling Cumulonimbus Massif & Sky Island Cloud Deck (连绵积雨云群·多峰云海).
 * - Variant 2: Wind-Swept Stratocumulus Streamers (风卷飞云·舒展流线).
 * - Variant 3: Low Horizon Summer Cumulus Shelf (低空海天云层·平底积云).
 * - Variant 4: High Cirrus Veil & Crepuscular Streamers (高空卷云·水彩天幕).
 *
 * All variants feature multi-pass Ghibli watercolor technique:
 * 1. Warm golden sunlight crest glow on sunlit upper rims (PALETTE.cloudRim & warm amber halo).
 * 2. Volumetric bright cloud body with overlapping billows (PALETTE.cloudBody).
 * 3. Miyazaki signature soft lavender / violet-grey shaded underbelly & crevice cavities.
 * 4. Ambient turquoise/azure sky and sea bounce light on the base.
 */
function makeCloudTexture(variant: number): THREE.CanvasTexture {
  const w = 512;
  const h = variant === 2 ? 320 : variant === 3 ? 256 : variant === 4 ? 256 : 384;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;

  const rimGold = css(PALETTE.cloudRim);
  const bodyWhite = css(PALETTE.cloudBody);

  // Helper to paint a single Ghibli gouache cloud billow with sunlit crown and soft azure underside
  const paintGouachePuff = (cx: number, cy: number, rx: number, ry: number): void => {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, ry / rx);
    // Soft outer rim glow
    const rimGrad = ctx.createRadialGradient(-rx * 0.14, -rx * 0.18, rx * 0.1, 0, 0, rx * 1.04);
    rimGrad.addColorStop(0, 'rgba(255, 252, 242, 0.98)');
    rimGrad.addColorStop(0.62, 'rgba(255, 249, 236, 0.96)');
    rimGrad.addColorStop(0.88, 'rgba(244, 240, 228, 0.85)');
    rimGrad.addColorStop(1.0, 'rgba(244, 240, 228, 0.0)');
    ctx.fillStyle = rimGrad;
    ctx.beginPath();
    ctx.arc(0, 0, rx * 1.04, 0, Math.PI * 2);
    ctx.fill();

    // Main volumetric puff with warm sunlit top and soft cerulean-lavender lower shade
    const bodyGrad = ctx.createLinearGradient(-rx * 0.2, -rx * 0.85, rx * 0.2, rx * 0.92);
    bodyGrad.addColorStop(0, '#fffdf6');
    bodyGrad.addColorStop(0.48, '#fbf8ef');
    bodyGrad.addColorStop(0.78, '#dce8f5');
    bodyGrad.addColorStop(1.0, '#b8cde6');
    ctx.fillStyle = bodyGrad;
    ctx.beginPath();
    ctx.arc(0, 0, rx * 0.92, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  // Soft bottom grounding atmospheric blend
  const applyCloudBaseAtmosphere = (baseStartY: number): void => {
    ctx.globalCompositeOperation = 'source-atop';
    const baseGrad = ctx.createLinearGradient(0, baseStartY - 36, 0, h);
    baseGrad.addColorStop(0, 'rgba(182, 206, 232, 0.0)');
    baseGrad.addColorStop(0.55, 'rgba(158, 190, 224, 0.42)');
    baseGrad.addColorStop(1.0, 'rgba(142, 184, 220, 0.68)');
    ctx.fillStyle = baseGrad;
    ctx.fillRect(0, baseStartY - 36, w, h - (baseStartY - 36));
    ctx.globalCompositeOperation = 'source-over';
  };

  if (variant === 0) {
    // =========================================================================
    // Variant 0: Monumental Towering Cumulonimbus (入道云山·巨型积云柱)
    // =========================================================================
    // Lower pedestal billows
    paintGouachePuff(256, 308, 195, 54);
    paintGouachePuff(126, 268, 78, 66);
    paintGouachePuff(386, 272, 74, 62);
    // Mid-tier cauliflower billows
    paintGouachePuff(186, 218, 92, 84);
    paintGouachePuff(320, 220, 90, 82);
    paintGouachePuff(254, 232, 102, 86);
    // Upper towering column
    paintGouachePuff(202, 146, 84, 78);
    paintGouachePuff(328, 140, 80, 74);
    paintGouachePuff(264, 104, 100, 92);
    // Sunlit cauliflower summit crowns
    paintGouachePuff(226, 64, 52, 48);
    paintGouachePuff(308, 68, 50, 46);
    paintGouachePuff(268, 52, 58, 54);
    applyCloudBaseAtmosphere(258);
  } else if (variant === 1) {
    // =========================================================================
    // Variant 1: Sprawling Cumulonimbus Massif & Sky Island Cloud Deck (连绵积雨云群·多峰云海)
    // =========================================================================
    paintGouachePuff(256, 312, 224, 50);
    // Left massif
    paintGouachePuff(98, 258, 66, 58);
    paintGouachePuff(142, 206, 80, 74);
    paintGouachePuff(162, 146, 74, 68);
    // Right flank
    paintGouachePuff(426, 246, 64, 56);
    paintGouachePuff(382, 194, 80, 72);
    // Central massif
    paintGouachePuff(220, 172, 88, 80);
    paintGouachePuff(320, 162, 84, 76);
    paintGouachePuff(270, 114, 98, 90);
    paintGouachePuff(248, 76, 50, 46);
    paintGouachePuff(292, 72, 52, 48);
    applyCloudBaseAtmosphere(255);
  } else if (variant === 2) {
    // =========================================================================
    // Variant 2: Wind-Swept Stratocumulus Streamers (风卷飞云·舒展流线)
    // =========================================================================
    paintGouachePuff(256, 242, 220, 44);
    paintGouachePuff(86, 232, 52, 44);
    paintGouachePuff(136, 206, 64, 56);
    paintGouachePuff(188, 182, 74, 64);
    paintGouachePuff(392, 182, 70, 60);
    paintGouachePuff(444, 210, 56, 48);
    paintGouachePuff(248, 154, 84, 74);
    paintGouachePuff(322, 150, 80, 70);
    applyCloudBaseAtmosphere(210);
  } else if (variant === 3) {
    // =========================================================================
    // Variant 3: Low Horizon Summer Cumulus Shelf (低空海天云层·平底积云)
    // =========================================================================
    paintGouachePuff(256, 202, 234, 40);
    paintGouachePuff(108, 168, 64, 54);
    paintGouachePuff(176, 144, 74, 64);
    paintGouachePuff(332, 140, 76, 66);
    paintGouachePuff(402, 164, 66, 56);
    paintGouachePuff(254, 128, 82, 72);
    applyCloudBaseAtmosphere(168);
  } else {
    // =========================================================================
    // Variant 4: High Cirrus Veil & Crepuscular Streamers (高空卷云·水彩天幕)
    // =========================================================================
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = bodyWhite;

    // Dynamic feathered brush streaks
    const drawStreak = (x0: number, y0: number, x1: number, y1: number, width: number, alpha: number): void => {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.bezierCurveTo(x0 + 120, y0 - 15, x1 - 120, y1 + 15, x1, y1);
      ctx.lineWidth = width;
      ctx.lineCap = 'round';
      ctx.strokeStyle = bodyWhite;
      ctx.stroke();
      ctx.restore();
    };

    drawStreak(30, 180, 480, 80, 24, 0.45);
    drawStreak(80, 210, 460, 120, 18, 0.55);
    drawStreak(150, 150, 490, 60, 14, 0.40);
    drawStreak(20, 130, 380, 50, 12, 0.35);

    // Delicate golden sunlight edge and lavender trailing tint
    ctx.globalCompositeOperation = 'source-atop';
    const cirrusGrad = ctx.createLinearGradient(0, 0, w, h);
    cirrusGrad.addColorStop(0, rimGold);
    cirrusGrad.addColorStop(0.35, bodyWhite);
    cirrusGrad.addColorStop(0.85, 'rgba(255, 255, 255, 0.85)');
    cirrusGrad.addColorStop(1, 'rgba(146, 143, 168, 0.35)');
    ctx.fillStyle = cirrusGrad;
    ctx.fillRect(0, 0, w, h);
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

  // Per-cloud ring parameters (0..5 Hero, 6..17 Mid, 18..31 Near, 32..39 Cirrus).
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

    // --- 2. 5 specialized procedural Ghibli cloud textures ---
    const texCumulonimbus = makeCloudTexture(0); // Monumental towering thunderhead
    const texMassif = makeCloudTexture(1);        // Sprawling multi-peak massif
    const texStratocumulus = makeCloudTexture(2); // Wind-swept aerodynamic wisps
    const texHorizonBank = makeCloudTexture(3);   // Low summer horizon cumulus shelf
    const texCirrus = makeCloudTexture(4);        // High-altitude cirrus veil streamers

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

    const cirrusMat = new THREE.SpriteMaterial({
      map: texCirrus,
      color: flat(PALETTE.skyHorizon),
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      fog: false,
    });

    // --- 3. Construct 4 Depth Tiers (Hero, Mid, Near, Cirrus) ---
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
        this.cRadius[i] = 3700 + hash(i, 2) * 650;
        this.cBaseAlt[i] = 450 + hash(i, 3) * 350;

        // Slow majestic drift
        const dir = hash(i, 4) > 0.3 ? 1 : -1;
        this.cOmega[i] = dir * (0.0007 + hash(i, 5) * 0.0005);

        // Sinusoidal vertical breathing
        this.cBobFreq[i] = 0.035 + hash(i, 6) * 0.025; // ~20s period
        this.cBobPhase[i] = hash(i, 7) * Math.PI * 2;
        this.cBobAmp[i] = 18 + hash(i, 8) * 12;

        sx = 1750 + hash(i, 9) * 600;
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
        this.cRadius[i] = 2300 + hash(i, 2) * 750;
        this.cBaseAlt[i] = 260 + hash(i, 3) * 260;

        // Moderate drift
        const dir = hash(i, 4) > 0.22 ? 1 : -1;
        this.cOmega[i] = dir * (0.0018 + hash(i, 5) * 0.0012);

        // Vertical bobbing
        this.cBobFreq[i] = 0.06 + hash(i, 6) * 0.04; // ~12-16s period
        this.cBobPhase[i] = hash(i, 7) * Math.PI * 2;
        this.cBobAmp[i] = 22 + hash(i, 8) * 16;

        sx = 880 + hash(i, 9) * 380;
        sy = sx * (variant === 2 ? 0.50 : 0.75);
      } else if (i < HERO_COUNT + MID_COUNT + NEAR_COUNT) {
        // -------------------------------------------------------------
        // TIER 2: NEAR DYNAMIC LIGHT CUMULUS & WIND WISPS (14 clouds)
        // Near distance, crisp detail, responsive drift parallax.
        // -------------------------------------------------------------
        const idx = i - (HERO_COUNT + MID_COUNT);
        const variant = idx % 3;
        mat = variant === 0 ? nearMatA : variant === 1 ? nearMatB : nearMatC;

        const baseAngle = (idx / NEAR_COUNT) * Math.PI * 2;
        this.cAngle[i] = baseAngle + hash(i, 1) * 0.55;
        this.cRadius[i] = 1250 + hash(i, 2) * 550;
        this.cBaseAlt[i] = 140 + hash(i, 3) * 180;

        // Active drift
        const dir = hash(i, 4) > 0.18 ? 1 : -1;
        this.cOmega[i] = dir * (0.0036 + hash(i, 5) * 0.0024);

        // Dynamic bobbing
        this.cBobFreq[i] = 0.09 + hash(i, 6) * 0.06; // ~8-12s period
        this.cBobPhase[i] = hash(i, 7) * Math.PI * 2;
        this.cBobAmp[i] = 16 + hash(i, 8) * 14;

        sx = 420 + hash(i, 9) * 180;
        sy = sx * (variant === 1 ? 0.625 : variant === 2 ? 0.50 : 0.75);
      } else {
        // -------------------------------------------------------------
        // TIER 3: HIGH CIRRUS VEIL STREAMERS (8 clouds)
        // High altitude, sweeping veil across upper sky dome.
        // -------------------------------------------------------------
        const idx = i - (HERO_COUNT + MID_COUNT + NEAR_COUNT);
        mat = cirrusMat;

        const baseAngle = (idx / CIRRUS_COUNT) * Math.PI * 2;
        this.cAngle[i] = baseAngle + hash(i, 1) * 0.40;
        this.cRadius[i] = 3100 + hash(i, 2) * 600;
        this.cBaseAlt[i] = 720 + hash(i, 3) * 220;

        // Fast high-altitude wind drift
        this.cOmega[i] = 0.0012 + hash(i, 5) * 0.0008;

        // Gentle breathing
        this.cBobFreq[i] = 0.025 + hash(i, 6) * 0.015;
        this.cBobPhase[i] = hash(i, 7) * Math.PI * 2;
        this.cBobAmp[i] = 12 + hash(i, 8) * 8;

        sx = 1300 + hash(i, 9) * 450;
        sy = sx * 0.35;
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
