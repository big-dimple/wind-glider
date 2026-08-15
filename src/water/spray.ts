/**
 * spray.ts — Ghibli & Solarpunk watercolor droplets and iridescent rainbow mist.
 * ONE instanced draw call with zero per-frame allocation (0 GC).
 *
 * Visual Features:
 *  - 4-quadrant procedural watercolor texture atlas (teardrop droplets, iridescent
 *    rainbow beads, soft watercolor mist puffs, and wave impact splash blooms).
 *  - Meniscus pigment pooling with soft turquoise & warm sepia hand-drawn ink rims.
 *  - Optical sunlight rainbow dispersion (prism refraction in sun direction).
 *  - Kinetic velocity streaking for high-speed droplets.
 *  - Live Gerstner wave collision (waves.ts waterHeight) with secondary impact blooms.
 */

import * as THREE from 'three';
import type { ISpray } from '../contracts';
import { PALETTE } from '../core/palette';
import { waterHeight } from './waves';

const GRAVITY = 12.5; // m/s^2 (buoyant anime gravity)
const DRAG_DROPLET = 1.12; // linear air drag for dense droplets
const DRAG_MIST = 2.45; // higher drag for floating airborne mist puffs
const POOF_SPEED = -1.8; // downward impact speed triggering a water splash bloom

/** Deterministic mulberry32 PRNG for reproducible texture generation. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build 256x256 4-quadrant watercolor spray sprite atlas:
 * - [0, 0] (TL): Teardrop Watercolor Droplet with pigment rim & sun glint
 * - [1, 0] (TR): Iridescent Rainbow Water Bead with star glint
 * - [0, 1] (BL): Soft Multi-lobed Watercolor Mist Cloudlet
 * - [1, 1] (BR): Wave Impact Splash Bloom & Foam Ripple
 */
function makeWatercolorSprayAtlas(): THREE.CanvasTexture {
  const S = 256;
  const H = S / 2; // 128
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d')!;
  const rng = mulberry32(42069);

  // -------------------------------------------------------------
  // Quadrant 0 (Top-Left, 0..128, 0..128): Teardrop Watercolor Droplet
  // -------------------------------------------------------------
  {
    const cx = H * 0.5; // 64
    const cy = H * 0.56; // 71.68
    const r = H * 0.34; // 43.52

    ctx.save();
    ctx.beginPath();
    // Teardrop path: sharp top tip, bulbous round bottom
    const tipY = cy - r * 1.35;
    ctx.moveTo(cx, tipY);
    ctx.bezierCurveTo(cx - r * 0.85, cy - r * 0.3, cx - r * 0.95, cy + r * 0.5, cx, cy + r * 0.95);
    ctx.bezierCurveTo(cx + r * 0.95, cy + r * 0.5, cx + r * 0.85, cy - r * 0.3, cx, tipY);
    ctx.closePath();

    // Watercolor body wash
    const grad = ctx.createRadialGradient(cx - r * 0.25, cy - r * 0.2, r * 0.1, cx, cy, r * 1.1);
    grad.addColorStop(0, 'rgba(255, 255, 255, 0.96)');
    grad.addColorStop(0.35, 'rgba(224, 247, 250, 0.88)');
    grad.addColorStop(0.72, 'rgba(38, 198, 218, 0.78)');
    grad.addColorStop(1.0, 'rgba(30, 136, 229, 0.85)');
    ctx.fillStyle = grad;
    ctx.fill();

    // Wet-edge pigment rim (darker turquoise with warm sepia ink touch)
    ctx.strokeStyle = 'rgba(21, 101, 192, 0.88)';
    ctx.lineWidth = 3.2;
    ctx.stroke();

    ctx.strokeStyle = 'rgba(44, 29, 17, 0.35)';
    ctx.lineWidth = 1.4;
    ctx.stroke();

    // Crisp sun specular gleam
    ctx.beginPath();
    ctx.ellipse(cx - r * 0.32, cy - r * 0.32, r * 0.22, r * 0.14, -Math.PI / 4, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.98)';
    ctx.fill();

    // Warm gold sun flare dot
    ctx.beginPath();
    ctx.arc(cx - r * 0.15, cy - r * 0.12, r * 0.09, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 241, 118, 0.92)';
    ctx.fill();
    ctx.restore();
  }

  // -------------------------------------------------------------
  // Quadrant 1 (Top-Right, 128..256, 0..128): Iridescent Rainbow Bead
  // -------------------------------------------------------------
  {
    const cx = H + H * 0.5; // 192
    const cy = H * 0.5; // 64
    const r = H * 0.36; // 46.08

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);

    // Prismatic water sphere gradient
    const grad = ctx.createRadialGradient(cx - r * 0.28, cy - r * 0.28, r * 0.08, cx, cy, r);
    grad.addColorStop(0, 'rgba(255, 255, 255, 0.98)');
    grad.addColorStop(0.4, 'rgba(232, 244, 248, 0.88)');
    grad.addColorStop(0.75, 'rgba(126, 200, 227, 0.72)');
    grad.addColorStop(0.92, 'rgba(255, 128, 171, 0.65)'); // iridescent rose
    grad.addColorStop(1.0, 'rgba(38, 198, 218, 0.82)');
    ctx.fillStyle = grad;
    ctx.fill();

    // Meniscus rainbow stroke
    ctx.strokeStyle = 'rgba(255, 179, 0, 0.65)'; // gold rim
    ctx.lineWidth = 2.4;
    ctx.stroke();

    ctx.strokeStyle = 'rgba(186, 104, 200, 0.45)'; // lavender rim
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // 4-point anime sparkle star
    ctx.fillStyle = 'rgba(255, 255, 255, 0.98)';
    const sx = cx - r * 0.3;
    const sy = cy - r * 0.3;
    const sLen = r * 0.26;
    ctx.beginPath();
    ctx.moveTo(sx, sy - sLen);
    ctx.quadraticCurveTo(sx, sy, sx + sLen, sy);
    ctx.quadraticCurveTo(sx, sy, sx, sy + sLen);
    ctx.quadraticCurveTo(sx, sy, sx - sLen, sy);
    ctx.quadraticCurveTo(sx, sy, sx, sy - sLen);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // -------------------------------------------------------------
  // Quadrant 2 (Bottom-Left, 0..128, 128..256): Watercolor Mist Cloudlet
  // -------------------------------------------------------------
  {
    const ox = 0;
    const oy = H; // 128
    const cx = ox + H * 0.5; // 64
    const cy = oy + H * 0.5; // 192

    ctx.save();
    // Composite 6 soft watercolor puffs with organic jitter
    const lobes = [
      { dx: 0, dy: 0, rad: H * 0.28, alpha: 0.55 },
      { dx: -14, dy: -8, rad: H * 0.22, alpha: 0.45 },
      { dx: 15, dy: -6, rad: H * 0.24, alpha: 0.48 },
      { dx: -10, dy: 12, rad: H * 0.21, alpha: 0.42 },
      { dx: 12, dy: 10, rad: H * 0.23, alpha: 0.44 },
      { dx: 0, dy: -14, rad: H * 0.18, alpha: 0.5 },
    ];

    for (const lobe of lobes) {
      const lx = cx + lobe.dx;
      const ly = cy + lobe.dy;
      const lg = ctx.createRadialGradient(lx, ly, lobe.rad * 0.1, lx, ly, lobe.rad);
      lg.addColorStop(0, `rgba(255, 255, 255, ${lobe.alpha * 0.95})`);
      lg.addColorStop(0.45, `rgba(232, 244, 248, ${lobe.alpha * 0.8})`);
      lg.addColorStop(0.8, `rgba(126, 200, 227, ${lobe.alpha * 0.5})`);
      lg.addColorStop(1.0, 'rgba(38, 198, 218, 0)');
      ctx.beginPath();
      ctx.arc(lx, ly, lobe.rad, 0, Math.PI * 2);
      ctx.fillStyle = lg;
      ctx.fill();
    }

    // Fine organic watercolor stipples
    for (let i = 0; i < 24; i++) {
      const px = cx + (rng() - 0.5) * H * 0.65;
      const py = cy + (rng() - 0.5) * H * 0.65;
      const pr = 1.5 + rng() * 2.5;
      ctx.beginPath();
      ctx.arc(px, py, pr, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 248, 225, ${0.3 + rng() * 0.35})`;
      ctx.fill();
    }
    ctx.restore();
  }

  // -------------------------------------------------------------
  // Quadrant 3 (Bottom-Right, 128..256, 128..256): Wave Impact Splash Bloom
  // -------------------------------------------------------------
  {
    const ox = H; // 128
    const oy = H; // 128
    const cx = ox + H * 0.5; // 192
    const cy = oy + H * 0.5; // 192
    const rOut = H * 0.42; // 53.76
    const rIn = H * 0.22; // 28.16

    ctx.save();
    // Scalloped splash ripple crown
    ctx.beginPath();
    const petals = 10;
    for (let i = 0; i < petals; i++) {
      const a0 = (i / petals) * Math.PI * 2;
      const a1 = ((i + 0.5) / petals) * Math.PI * 2;
      const a2 = ((i + 1) / petals) * Math.PI * 2;
      const pR = rOut + (rng() - 0.5) * 6;
      const pRx = cx + Math.cos(a1) * pR;
      const pRy = cy + Math.sin(a1) * pR;
      const endX = cx + Math.cos(a2) * (rOut * 0.85);
      const endY = cy + Math.sin(a2) * (rOut * 0.85);
      if (i === 0) {
        ctx.moveTo(cx + Math.cos(a0) * (rOut * 0.85), cy + Math.sin(a0) * (rOut * 0.85));
      }
      ctx.quadraticCurveTo(pRx, pRy, endX, endY);
    }
    ctx.closePath();

    // Fill with soft sea foam wash
    const bloomGrad = ctx.createRadialGradient(cx, cy, rIn * 0.5, cx, cy, rOut);
    bloomGrad.addColorStop(0, 'rgba(255, 255, 255, 0.1)');
    bloomGrad.addColorStop(0.5, 'rgba(255, 255, 255, 0.75)');
    bloomGrad.addColorStop(0.85, 'rgba(38, 198, 218, 0.7)');
    bloomGrad.addColorStop(1.0, 'rgba(21, 101, 192, 0.8)');
    ctx.fillStyle = bloomGrad;
    ctx.fill();

    // Ink meniscus line
    ctx.strokeStyle = 'rgba(21, 101, 192, 0.82)';
    ctx.lineWidth = 2.2;
    ctx.stroke();

    ctx.strokeStyle = 'rgba(44, 29, 17, 0.35)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // Satellite micro-droplets around the bloom
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + rng() * 0.4;
      const dist = rOut + 5 + rng() * 8;
      const sx = cx + Math.cos(a) * dist;
      const sy = cy + Math.sin(a) * dist;
      ctx.beginPath();
      ctx.arc(sx, sy, 2.2, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
      ctx.fill();
    }
    ctx.restore();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const VERT = /* glsl */ `
attribute vec3 aPos;
attribute vec3 aVel;
attribute float aSize;
attribute float aType;        // 0=droplet, 1=rainbow bead, 2=mist puff, 3=impact bloom
attribute vec2 aLifeParam;    // x = life, y = maxLife
attribute vec4 aColorMod;     // rgb = tint, a = rainbow seed / phase

uniform vec3 uSunDir;

varying vec2 vUv;
varying float vType;
varying float vAgeF;
varying float vSunScatter;
varying vec4 vColorMod;

void main() {
  vType = aType;
  float maxL = max(aLifeParam.y, 0.0001);
  float ageF = clamp(1.0 - aLifeParam.x / maxL, 0.0, 1.0);
  vAgeF = ageF;
  vColorMod = aColorMod;

  // Scale particle based on type & age (stepped watercolor sizing)
  float s = aSize;
  if (aType < 1.5) {
    // Droplet & Rainbow bead: discrete anime shrink steps
    float shrink = ageF < 0.35 ? 1.0 : (ageF < 0.72 ? 0.72 : 0.42);
    s *= shrink;
  } else if (aType < 2.5) {
    // Mist puff: expands and billows gently in the air
    s *= mix(0.72, 1.48, ageF);
  } else {
    // Impact bloom: expands horizontally on the wave surface
    s *= mix(0.65, 1.85, ageF);
  }

  // Camera billboard basis vectors
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);

  vec3 offset = vec3(0.0);
  if (aType < 1.5) {
    // High-speed droplet velocity streaking
    vec2 vScreen = vec2(dot(aVel, camRight), dot(aVel, camUp));
    float spd = length(vScreen);
    if (spd > 3.0) {
      vec2 dir = vScreen / spd;
      vec2 norm = vec2(-dir.y, dir.x);
      float stretch = min(1.65, 1.0 + spd * 0.038);
      vec2 localP = position.xy;
      vec2 stretched = dir * (localP.y * stretch) + norm * (localP.x * 0.82);
      offset = (camRight * stretched.x + camUp * stretched.y) * s;
    } else {
      offset = (camRight * position.x + camUp * position.y) * s;
    }
  } else if (aType > 2.5) {
    // Wave impact bloom: horizontal planar orientation on ocean
    offset = (camRight * position.x + vec3(0.0, position.y * 0.32, 0.0) + cross(camRight, vec3(0.0, 1.0, 0.0)) * position.y * 0.75) * s;
  } else {
    // Mist puff: camera-facing quad
    offset = (camRight * position.x + camUp * position.y) * s;
  }

  vec3 worldPos = aPos + offset;

  // Sunlight forward scattering alignment
  vec3 viewDir = normalize(worldPos - cameraPosition);
  vSunScatter = dot(viewDir, uSunDir);

  // Map 2x2 quadrant in the watercolor atlas
  vec2 tileOffset = vec2(
    mod(aType, 2.0) >= 0.5 ? 0.5 : 0.0,
    aType >= 1.5 ? 0.5 : 0.0
  );
  vUv = uv * 0.5 + tileOffset;

  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(worldPos, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uTex;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSeaShallow;
uniform vec3 uPetalPink;
uniform vec3 uLilac;
uniform vec3 uFoam;

varying vec2 vUv;
varying float vType;
varying float vAgeF;
varying float vSunScatter;
varying vec4 vColorMod;

// Fast pastel rainbow spectrum function (Pink -> Gold -> Turquoise -> Lilac -> Pink)
vec3 rainbowSpectrum(float phase) {
  float p = fract(phase) * 4.0;
  if (p < 1.0) {
    return mix(uPetalPink, uSunColor, p);
  } else if (p < 2.0) {
    return mix(uSunColor, uSeaShallow, p - 1.0);
  } else if (p < 3.0) {
    return mix(uSeaShallow, uLilac, p - 2.0);
  } else {
    return mix(uLilac, uPetalPink, p - 3.0);
  }
}

void main() {
  vec4 tex = texture2D(uTex, vUv);
  if (tex.a < 0.035) discard;

  vec3 col = tex.rgb;
  float alpha = tex.a;

  if (vType < 0.5) {
    // Type 0: Watercolor Droplet
    col *= vColorMod.rgb;
    // Sunlight forward scatter gleam
    float sunGleam = smoothstep(0.35, 0.95, vSunScatter);
    col = mix(col, uSunColor, sunGleam * 0.35);
    // 3-step anime watercolor dissipation
    float stepAlpha = vAgeF < 0.68 ? 1.0 : (vAgeF < 0.88 ? 0.72 : smoothstep(1.0, 0.88, vAgeF) * 0.72);
    alpha *= stepAlpha;
  } else if (vType < 1.5) {
    // Type 1: Iridescent Rainbow Water Bead
    float phase = vColorMod.a + vSunScatter * 0.55 + vAgeF * 0.45;
    vec3 rainbowCol = rainbowSpectrum(phase);
    col = mix(col * vColorMod.rgb, rainbowCol, 0.42);
    float glint = smoothstep(0.3, 0.9, vSunScatter);
    col += uSunColor * glint * 0.32;
    float stepAlpha = vAgeF < 0.65 ? 1.0 : (vAgeF < 0.88 ? 0.75 : smoothstep(1.0, 0.88, vAgeF) * 0.75);
    alpha *= stepAlpha;
  } else if (vType < 2.5) {
    // Type 2: Watercolor Mist Puff (Sunlit Rainbow Mist)
    float phase = vColorMod.a + vSunScatter * 0.5 + vAgeF * 0.35;
    vec3 rainbowMist = rainbowSpectrum(phase);
    col = mix(col, rainbowMist, 0.4);
    float fwd = max(0.0, vSunScatter);
    col = mix(col, uSunColor, fwd * 0.28);
    // Soft atmospheric mist fade
    alpha *= smoothstep(1.0, 0.55, vAgeF) * 0.88;
  } else {
    // Type 3: Wave Impact Splash Bloom
    col = mix(col, uSeaShallow, 0.28);
    alpha *= smoothstep(1.0, 0.45, vAgeF) * 0.92;
  }

  gl_FragColor = vec4(col, alpha);
  #include <colorspace_fragment>
}
`;

export class SpraySystem implements ISpray {
  readonly object: THREE.Object3D;

  private readonly capacity: number;

  // Particle simulation state (structure-of-arrays, preallocated for 0 GC)
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly size0: Float32Array;
  private readonly type: Float32Array;
  private readonly colorMod: Float32Array; // r, g, b, a (4 floats per particle)
  private cursor = 0;

  // Instanced attribute backing arrays
  private readonly aPos: Float32Array;
  private readonly aVel: Float32Array;
  private readonly aSize: Float32Array;
  private readonly aType: Float32Array;
  private readonly aLifeParam: Float32Array;
  private readonly aColorMod: Float32Array;

  private readonly attrPos: THREE.InstancedBufferAttribute;
  private readonly attrVel: THREE.InstancedBufferAttribute;
  private readonly attrSize: THREE.InstancedBufferAttribute;
  private readonly attrType: THREE.InstancedBufferAttribute;
  private readonly attrLifeParam: THREE.InstancedBufferAttribute;
  private readonly attrColorMod: THREE.InstancedBufferAttribute;

  constructor(capacity: number = 2048) {
    this.capacity = capacity;

    // Allocate particle simulation state
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.size0 = new Float32Array(capacity);
    this.type = new Float32Array(capacity);
    this.colorMod = new Float32Array(capacity * 4);

    // Allocate instanced GPU attribute buffers
    this.aPos = new Float32Array(capacity * 3);
    this.aVel = new Float32Array(capacity * 3);
    this.aSize = new Float32Array(capacity);
    this.aType = new Float32Array(capacity);
    this.aLifeParam = new Float32Array(capacity * 2);
    this.aColorMod = new Float32Array(capacity * 4);

    // Base camera-facing quad geometry
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3),
    );
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);

    const dyn = THREE.DynamicDrawUsage;
    this.attrPos = new THREE.InstancedBufferAttribute(this.aPos, 3).setUsage(dyn);
    this.attrVel = new THREE.InstancedBufferAttribute(this.aVel, 3).setUsage(dyn);
    this.attrSize = new THREE.InstancedBufferAttribute(this.aSize, 1).setUsage(dyn);
    this.attrType = new THREE.InstancedBufferAttribute(this.aType, 1).setUsage(dyn);
    this.attrLifeParam = new THREE.InstancedBufferAttribute(this.aLifeParam, 2).setUsage(dyn);
    this.attrColorMod = new THREE.InstancedBufferAttribute(this.aColorMod, 4).setUsage(dyn);

    geometry.setAttribute('aPos', this.attrPos);
    geometry.setAttribute('aVel', this.attrVel);
    geometry.setAttribute('aSize', this.attrSize);
    geometry.setAttribute('aType', this.attrType);
    geometry.setAttribute('aLifeParam', this.attrLifeParam);
    geometry.setAttribute('aColorMod', this.attrColorMod);
    geometry.instanceCount = capacity;

    const sunDirVec = new THREE.Vector3(...PALETTE.sunDir).normalize();

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTex: { value: makeWatercolorSprayAtlas() },
        uSunDir: { value: sunDirVec },
        uSunColor: { value: new THREE.Color(PALETTE.sun) },
        uSeaShallow: { value: new THREE.Color(PALETTE.seaShallow) },
        uPetalPink: { value: new THREE.Color(PALETTE.petalPink) },
        uLilac: { value: new THREE.Color(PALETTE.hullJinx) },
        uFoam: { value: new THREE.Color(PALETTE.foam) },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 3; // render over ocean & wake ribbons
    this.object = mesh;
  }

  /**
   * Emit `count` spray particles at pos with base speed (m/s).
   * Naturally balances watercolor droplets, iridescent rainbow beads, and mist puffs.
   */
  burst(pos: THREE.Vector3, count: number, speed: number): void {
    const n = Math.min(count, this.capacity);
    for (let i = 0; i < n; i++) {
      const az = Math.random() * Math.PI * 2;
      const r = Math.random() * 0.65;
      const dx = Math.cos(az) * r;
      const dy = 0.65 + Math.random() * 0.55;
      const dz = Math.sin(az) * r;
      const il = 1 / Math.hypot(dx, dy, dz);
      const s = speed * (0.55 + Math.random() * 0.65) * il;

      const roll = Math.random();
      let type = 0; // standard watercolor droplet
      let size = Math.min(0.38, (0.07 + 0.016 * speed) * (0.75 + Math.random() * 0.45));
      let life = 0.72 + Math.random() * 0.42;

      // Color tints: fresh foam / turquoise wash / warm sunlight gleam
      let cr = 1.0, cg = 1.0, cb = 1.0;
      const rainbowSeed = Math.random();

      if (roll < 0.58) {
        // Type 0: Teardrop droplet
        type = 0;
        if (Math.random() < 0.35) {
          cr = 0.92; cg = 0.98; cb = 1.0; // slight turquoise tint
        }
      } else if (roll < 0.82) {
        // Type 1: Iridescent rainbow water bead
        type = 1;
        size *= 0.9;
        life *= 1.15;
      } else {
        // Type 2: Soft watercolor mist puff
        type = 2;
        size *= 1.45;
        life = 0.55 + Math.random() * 0.35;
      }

      this.spawn(
        pos.x + (Math.random() - 0.5) * 0.35,
        pos.y + 0.06,
        pos.z + (Math.random() - 0.5) * 0.35,
        dx * s,
        dy * s,
        dz * s,
        life,
        size,
        type,
        cr, cg, cb, rainbowSeed,
      );
    }
  }

  /**
   * Directional launch sheet (for glider takeoff & booster exhaust).
   * Shoots lateral/aft water fan accompanied by trailing rainbow mist veil.
   */
  takeoff(pos: THREE.Vector3, forward: THREE.Vector3, right: THREE.Vector3, count: number, speed: number): void {
    const n = Math.min(count, this.capacity);
    for (let i = 0; i < n; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const lateral = side * (0.65 + Math.random() * 0.75);
      const aft = 0.6 + Math.random() * 0.75;
      const up = 0.42 + Math.random() * 0.42;
      const s = speed * (0.75 + Math.random() * 0.45);

      const roll = Math.random();
      let type = 0;
      let size = Math.min(0.42, 0.12 + speed * 0.018 + Math.random() * 0.1);
      let life = 0.65 + Math.random() * 0.38;

      let cr = 1.0, cg = 1.0, cb = 1.0;
      const rainbowSeed = Math.random();

      if (roll < 0.45) {
        type = 0;
      } else if (roll < 0.75) {
        type = 1; // prismatic rainbow bead
        size *= 0.95;
        life *= 1.18;
      } else {
        type = 2; // sunlit rainbow mist puff
        size *= 1.5;
        life = 0.68 + Math.random() * 0.32;
      }

      this.spawn(
        pos.x + right.x * side * (0.35 + Math.random() * 0.7) - forward.x * Math.random() * 1.6,
        pos.y + 0.04 + Math.random() * 0.14,
        pos.z + right.z * side * (0.35 + Math.random() * 0.7) - forward.z * Math.random() * 1.6,
        (right.x * lateral - forward.x * aft) * s,
        up * s,
        (right.z * lateral - forward.z * aft) * s,
        life,
        size,
        type,
        cr, cg, cb, rainbowSeed,
      );
    }
  }

  /**
   * Update particle physics and pack into instanced GPU attributes (0 GC).
   */
  update(dt: number, t: number): void {
    const dragDrop = Math.max(0, 1 - DRAG_DROPLET * dt);
    const dragMist = Math.max(0, 1 - DRAG_MIST * dt);
    const cap = this.capacity;

    for (let i = 0; i < cap; i++) {
      if (this.life[i] <= 0) {
        this.aSize[i] = 0;
        continue;
      }

      const i3 = i * 3;
      const i4 = i * 4;
      const i2 = i * 2;
      const pType = this.type[i];
      const drag = pType === 2 ? dragMist : dragDrop;

      // Integrate physics
      if (pType !== 3) {
        // Bloom floats flat on wave; droplets & mist feel gravity
        this.vel[i3 + 1] -= GRAVITY * dt;
        this.vel[i3] *= drag;
        this.vel[i3 + 1] *= drag;
        this.vel[i3 + 2] *= drag;
      } else {
        // Bloom expands and decelerates
        this.vel[i3] *= 0.88;
        this.vel[i3 + 2] *= 0.88;
      }

      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      this.life[i] -= dt;

      // Check collision against live Gerstner sea surface
      const surf = waterHeight(this.pos[i3], this.pos[i3 + 2], t);
      if (pType !== 3 && this.pos[i3 + 1] < surf) {
        // Droplets hitting water at speed pop a secondary wave impact splash bloom
        if (this.vel[i3 + 1] < POOF_SPEED && pType < 2) {
          const spread = 0.6 + Math.random() * 0.4;
          const az = Math.random() * Math.PI * 2;
          this.spawn(
            this.pos[i3],
            surf + 0.04, // slight lift above wave
            this.pos[i3 + 2],
            Math.cos(az) * spread,
            0.0,
            Math.sin(az) * spread,
            0.36,
            this.size0[i] * 1.25,
            3, // Type 3: Wave Impact Splash Bloom
            1.0, 1.0, 1.0, Math.random(),
          );
        }
        this.life[i] = 0;
        this.aSize[i] = 0;
        continue;
      }

      if (this.life[i] <= 0) {
        this.aSize[i] = 0;
        continue;
      }

      // If Type 3 (impact bloom), ride the live wave height
      if (pType === 3) {
        this.pos[i3 + 1] = surf + 0.04;
      }

      // Pack active particle state into instanced attribute backing arrays
      this.aPos[i3] = this.pos[i3];
      this.aPos[i3 + 1] = this.pos[i3 + 1];
      this.aPos[i3 + 2] = this.pos[i3 + 2];

      this.aVel[i3] = this.vel[i3];
      this.aVel[i3 + 1] = this.vel[i3 + 1];
      this.aVel[i3 + 2] = this.vel[i3 + 2];

      this.aSize[i] = this.size0[i];
      this.aType[i] = pType;

      this.aLifeParam[i2] = this.life[i];
      this.aLifeParam[i2 + 1] = this.maxLife[i];

      this.aColorMod[i4] = this.colorMod[i4];
      this.aColorMod[i4 + 1] = this.colorMod[i4 + 1];
      this.aColorMod[i4 + 2] = this.colorMod[i4 + 2];
      this.aColorMod[i4 + 3] = this.colorMod[i4 + 3];
    }

    this.attrPos.needsUpdate = true;
    this.attrVel.needsUpdate = true;
    this.attrSize.needsUpdate = true;
    this.attrType.needsUpdate = true;
    this.attrLifeParam.needsUpdate = true;
    this.attrColorMod.needsUpdate = true;
  }

  /**
   * Write one particle into the next ring slot. Zero heap allocation.
   */
  private spawn(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    life: number, size: number, type: number,
    cr: number, cg: number, cb: number, ca: number,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;

    const i3 = i * 3;
    const i4 = i * 4;

    this.pos[i3] = x;
    this.pos[i3 + 1] = y;
    this.pos[i3 + 2] = z;

    this.vel[i3] = vx;
    this.vel[i3 + 1] = vy;
    this.vel[i3 + 2] = vz;

    this.life[i] = life;
    this.maxLife[i] = life;
    this.size0[i] = size;
    this.type[i] = type;

    this.colorMod[i4] = cr;
    this.colorMod[i4 + 1] = cg;
    this.colorMod[i4 + 2] = cb;
    this.colorMod[i4 + 3] = ca;
  }
}
