/**
 * jetTrail.ts — Ghibli & Solarpunk aerodynamic white wind streamlines (Wind Trails),
 * tumbling watercolor cherry/rose flower petals, and floating dandelion fluff particles.
 *
 * Implements IJetTrail using a high-resolution 4-quadrant procedural watercolor texture atlas
 * and GPU InstancedBufferGeometry with 0 GC allocation during gameplay simulation.
 *
 * Visual Features:
 *  - Quadrant 0 (Top-Left): Aerodynamic White Wind Streamlines (白色风流线 / 气流涡卷线)
 *    Kinetic velocity stretching along slipstream with warm watercolor contour ink.
 *  - Quadrant 1 (Top-Right): Falling Watercolor Flower Petals (飘落粉白花瓣 / 樱花花瓣)
 *    3D tumbling Euler rotations, natural wind turbulence sway, and backlit sunlight translucency.
 *  - Quadrant 2 (Bottom-Left): Floating Solarpunk Dandelion Pappus (蒲公英绒毛种子)
 *    Gossamer feathery umbrella rays with extreme anime buoyancy and drifting helical float.
 *  - Quadrant 3 (Bottom-Right): Sunlit Wind Sparkles / Golden Pollen Glints (太阳风尘微光)
 *    4-pointed diamond star core with radiant warm solar corona.
 */

import * as THREE from 'three';
import { LAYER_ENERGY } from '../contracts';
import type { IJetTrail } from '../contracts';
import { PALETTE } from '../core/palette';

export const TYPE_STREAMLINE = 0;
export const TYPE_PETAL = 1;
export const TYPE_DANDELION = 2;
export const TYPE_SPARKLE = 3;

const COUNT = 512;

/** Deterministic mulberry32 PRNG for reproducible texture atlas generation. */
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
 * Build 512x512 4-quadrant procedural watercolor sprite atlas:
 * - [0, 0] (TL): Aerodynamic White Wind Streamline & Air Wisps
 * - [1, 0] (TR): Hand-Drawn Watercolor Flower Petal (Cherry/Rose)
 * - [0, 1] (BL): Solarpunk Dandelion Fluff & Parachute Seed
 * - [1, 1] (BR): Radiant Sunlit Sparkle Star & Pollen Glint
 */
function makeWindGliderAtlas(): THREE.CanvasTexture {
  const S = 512;
  const H = S / 2; // 256
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d')!;
  const rng = mulberry32(13377);

  // -----------------------------------------------------------------
  // Quadrant 0 (Top-Left, 0..256, 0..256): Aerodynamic White Wind Streamline
  // -----------------------------------------------------------------
  {
    const cx = H * 0.5; // 128
    const cy = H * 0.5; // 128

    ctx.save();

    // Main curved aerodynamic slipstream ribbon
    ctx.beginPath();
    // Curved tapered ribbon path
    ctx.moveTo(38, cy + 85);
    ctx.bezierCurveTo(cx - 45, cy + 40, cx - 30, cy - 20, cx + 45, cy - 65);
    ctx.bezierCurveTo(cx + 85, cy - 88, cx + 105, cy - 92, cx + 112, cy - 90);
    ctx.bezierCurveTo(cx + 98, cy - 80, cx + 72, cy - 60, cx + 32, cy - 28);
    ctx.bezierCurveTo(cx - 20, cy + 18, cx - 25, cy + 62, 38, cy + 85);
    ctx.closePath();

    const streamGrad = ctx.createLinearGradient(38, cy + 85, cx + 112, cy - 90);
    streamGrad.addColorStop(0.0, 'rgba(255, 255, 255, 0.05)');
    streamGrad.addColorStop(0.25, 'rgba(232, 244, 248, 0.75)');
    streamGrad.addColorStop(0.65, 'rgba(255, 255, 255, 0.98)');
    streamGrad.addColorStop(0.88, 'rgba(255, 248, 225, 0.95)');
    streamGrad.addColorStop(1.0, 'rgba(255, 255, 255, 0.85)');
    ctx.fillStyle = streamGrad;
    ctx.fill();

    // Subtle warm sepia ink edge
    ctx.strokeStyle = 'rgba(44, 29, 17, 0.26)';
    ctx.lineWidth = 2.0;
    ctx.stroke();

    // Secondary companion micro-wisp (top-right flank)
    ctx.beginPath();
    ctx.moveTo(cx - 10, cy - 45);
    ctx.bezierCurveTo(cx + 25, cy - 85, cx + 65, cy - 105, cx + 95, cy - 110);
    ctx.bezierCurveTo(cx + 70, cy - 98, cx + 35, cy - 75, cx + 5, cy - 40);
    ctx.closePath();
    const wispGrad1 = ctx.createLinearGradient(cx - 10, cy - 45, cx + 95, cy - 110);
    wispGrad1.addColorStop(0, 'rgba(255, 255, 255, 0.1)');
    wispGrad1.addColorStop(0.6, 'rgba(255, 255, 255, 0.85)');
    wispGrad1.addColorStop(1, 'rgba(255, 248, 225, 0.3)');
    ctx.fillStyle = wispGrad1;
    ctx.fill();

    // Secondary companion micro-wisp (bottom-left flank)
    ctx.beginPath();
    ctx.moveTo(25, cy + 60);
    ctx.bezierCurveTo(cx - 65, cy + 20, cx - 45, cy - 25, cx - 15, cy - 48);
    ctx.bezierCurveTo(cx - 35, cy - 15, cx - 50, cy + 18, 30, cy + 50);
    ctx.closePath();
    const wispGrad2 = ctx.createLinearGradient(25, cy + 60, cx - 15, cy - 48);
    wispGrad2.addColorStop(0, 'rgba(255, 255, 255, 0.05)');
    wispGrad2.addColorStop(0.5, 'rgba(232, 244, 248, 0.7)');
    wispGrad2.addColorStop(1, 'rgba(255, 255, 255, 0.1)');
    ctx.fillStyle = wispGrad2;
    ctx.fill();

    ctx.restore();
  }

  // -----------------------------------------------------------------
  // Quadrant 1 (Top-Right, 256..512, 0..256): Hand-Drawn Flower Petal
  // -----------------------------------------------------------------
  {
    const ox = H; // 256
    const oy = 0;
    const cx = ox + H * 0.5; // 384
    const cy = oy + H * 0.5; // 128
    const r = H * 0.38; // 97.28

    ctx.save();
    ctx.beginPath();

    // Classic Ghibli cherry / rose petal with gentle heart notch at top and tapered base
    const topY = cy - r * 1.05;
    const notchY = cy - r * 0.75;
    const botY = cy + r * 1.1;

    ctx.moveTo(cx, notchY);
    // Left lobe
    ctx.bezierCurveTo(cx - r * 0.45, topY, cx - r * 0.95, cy - r * 0.4, cx - r * 0.85, cy + r * 0.25);
    ctx.bezierCurveTo(cx - r * 0.75, cy + r * 0.75, cx - r * 0.35, botY - r * 0.2, cx, botY);
    // Right lobe
    ctx.bezierCurveTo(cx + r * 0.35, botY - r * 0.2, cx + r * 0.75, cy + r * 0.75, cx + r * 0.85, cy + r * 0.25);
    ctx.bezierCurveTo(cx + r * 0.95, cy - r * 0.4, cx + r * 0.45, topY, cx, notchY);
    ctx.closePath();

    // Watercolor body wash gradient (warm peach/white center -> rich sakura rose petal pink)
    const petalGrad = ctx.createRadialGradient(cx - r * 0.2, cy - r * 0.1, r * 0.1, cx, cy, r * 1.15);
    petalGrad.addColorStop(0.0, 'rgba(255, 248, 225, 0.98)');
    petalGrad.addColorStop(0.35, 'rgba(255, 205, 210, 0.94)');
    petalGrad.addColorStop(0.72, 'rgba(255, 128, 171, 0.92)');
    petalGrad.addColorStop(0.94, 'rgba(240, 98, 146, 0.88)');
    petalGrad.addColorStop(1.0, 'rgba(216, 27, 96, 0.92)');
    ctx.fillStyle = petalGrad;
    ctx.fill();

    // Meniscus pigment rim (deeper rose-magenta + warm ink)
    ctx.strokeStyle = 'rgba(194, 24, 91, 0.78)';
    ctx.lineWidth = 3.5;
    ctx.stroke();

    ctx.strokeStyle = 'rgba(44, 29, 17, 0.28)';
    ctx.lineWidth = 1.4;
    ctx.stroke();

    // Delicate translucent petal vein lines
    ctx.beginPath();
    ctx.moveTo(cx, botY - 5);
    ctx.quadraticCurveTo(cx - 2, cy, cx, notchY + 12);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.65)';
    ctx.lineWidth = 2.0;
    ctx.stroke();

    // Left vein branch
    ctx.beginPath();
    ctx.moveTo(cx - 1, cy + r * 0.35);
    ctx.quadraticCurveTo(cx - r * 0.35, cy + r * 0.1, cx - r * 0.55, cy - r * 0.15);
    ctx.strokeStyle = 'rgba(255, 248, 225, 0.45)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Right vein branch
    ctx.beginPath();
    ctx.moveTo(cx + 1, cy + r * 0.4);
    ctx.quadraticCurveTo(cx + r * 0.35, cy + r * 0.15, cx + r * 0.58, cy - r * 0.1);
    ctx.strokeStyle = 'rgba(255, 248, 225, 0.45)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Curved sunlight highlight glint on left petal lobe
    ctx.beginPath();
    ctx.ellipse(cx - r * 0.42, cy - r * 0.28, r * 0.28, r * 0.14, -Math.PI / 3.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.fill();

    ctx.restore();
  }

  // -----------------------------------------------------------------
  // Quadrant 2 (Bottom-Left, 0..256, 256..512): Solarpunk Dandelion Pappus
  // -----------------------------------------------------------------
  {
    const ox = 0;
    const oy = H; // 256
    const cx = ox + H * 0.5; // 128
    const cy = oy + H * 0.5; // 384
    const rad = H * 0.42; // 107.52

    ctx.save();

    const hubX = cx;
    const hubY = cy - 8;
    const seedY = cy + rad * 0.82;

    // 1. Teak/sepia tiny seed achene at bottom
    ctx.beginPath();
    ctx.moveTo(hubX, seedY - rad * 0.42);
    ctx.bezierCurveTo(hubX - 6, seedY - rad * 0.25, hubX - 5, seedY, hubX, seedY + 6);
    ctx.bezierCurveTo(hubX + 5, seedY, hubX + 6, seedY - rad * 0.25, hubX, seedY - rad * 0.42);
    ctx.closePath();
    ctx.fillStyle = 'rgba(93, 64, 55, 0.95)'; // dark teak
    ctx.fill();
    ctx.strokeStyle = 'rgba(44, 29, 17, 0.85)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // 2. Fine seed stem connecting seed to parachute hub
    ctx.beginPath();
    ctx.moveTo(hubX, hubY);
    ctx.lineTo(hubX, seedY - rad * 0.4);
    ctx.strokeStyle = 'rgba(141, 110, 99, 0.85)';
    ctx.lineWidth = 2.0;
    ctx.stroke();

    // 3. 28 gossamer parachute rays radiating from hub
    const rayCount = 28;
    for (let k = 0; k < rayCount; k++) {
      const angle = -Math.PI * 0.95 + (k / (rayCount - 1)) * Math.PI * 0.9;
      const rayLen = rad * (0.82 + (rng() - 0.5) * 0.22);
      const tipX = hubX + Math.cos(angle) * rayLen;
      const tipY = hubY + Math.sin(angle) * rayLen * 0.85;

      // Primary ray filament
      ctx.beginPath();
      ctx.moveTo(hubX, hubY);
      ctx.lineTo(tipX, tipY);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.88)';
      ctx.lineWidth = 1.2;
      ctx.stroke();

      // Delicate feathery micro-barbs near tip
      const barbCount = 3;
      for (let b = 1; b <= barbCount; b++) {
        const u = 0.65 + b * 0.1;
        const bx = hubX + (tipX - hubX) * u;
        const by = hubY + (tipY - hubY) * u;
        const bAngle1 = angle + 0.38;
        const bAngle2 = angle - 0.38;
        const bLen = 6 + rng() * 5;

        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(bx + Math.cos(bAngle1) * bLen, by + Math.sin(bAngle1) * bLen);
        ctx.moveTo(bx, by);
        ctx.lineTo(bx + Math.cos(bAngle2) * bLen, by + Math.sin(bAngle2) * bLen);
        ctx.strokeStyle = 'rgba(255, 250, 230, 0.75)';
        ctx.lineWidth = 0.85;
        ctx.stroke();
      }

      // Glowing sunlight dot at filament tip
      ctx.beginPath();
      ctx.arc(tipX, tipY, 1.8, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 248, 225, 0.95)';
      ctx.fill();
    }

    // Soft central fluff corona at the hub
    const hubGrad = ctx.createRadialGradient(hubX, hubY, 2, hubX, hubY, 18);
    hubGrad.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
    hubGrad.addColorStop(0.5, 'rgba(255, 248, 225, 0.65)');
    hubGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.beginPath();
    ctx.arc(hubX, hubY, 18, 0, Math.PI * 2);
    ctx.fillStyle = hubGrad;
    ctx.fill();

    ctx.restore();
  }

  // -----------------------------------------------------------------
  // Quadrant 3 (Bottom-Right, 256..512, 256..512): Sunlit Sparkle / Pollen Glint
  // -----------------------------------------------------------------
  {
    const ox = H; // 256
    const oy = H; // 256
    const cx = ox + H * 0.5; // 384
    const cy = oy + H * 0.5; // 384
    const r = H * 0.4; // 102.4

    ctx.save();

    // 1. Soft radial solar corona halo
    const halo = ctx.createRadialGradient(cx, cy, r * 0.08, cx, cy, r * 0.95);
    halo.addColorStop(0.0, 'rgba(255, 255, 255, 0.95)');
    halo.addColorStop(0.25, 'rgba(255, 241, 118, 0.75)'); // sun yellow
    halo.addColorStop(0.65, 'rgba(255, 213, 79, 0.35)');  // sun flare
    halo.addColorStop(1.0, 'rgba(255, 179, 0, 0)');
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.95, 0, Math.PI * 2);
    ctx.fillStyle = halo;
    ctx.fill();

    // 2. 4-pointed radiant anime diamond star
    const starLenX = r * 0.88;
    const starLenY = r * 0.98;
    const starThick = r * 0.16;

    ctx.beginPath();
    ctx.moveTo(cx, cy - starLenY);
    ctx.quadraticCurveTo(cx + starThick * 0.25, cy - starThick * 0.25, cx + starLenX, cy);
    ctx.quadraticCurveTo(cx + starThick * 0.25, cy + starThick * 0.25, cx, cy + starLenY);
    ctx.quadraticCurveTo(cx - starThick * 0.25, cy + starThick * 0.25, cx - starLenX, cy);
    ctx.quadraticCurveTo(cx - starThick * 0.25, cy - starThick * 0.25, cx, cy - starLenY);
    ctx.closePath();

    const starGrad = ctx.createRadialGradient(cx, cy, 2, cx, cy, starLenY);
    starGrad.addColorStop(0, 'rgba(255, 255, 255, 0.98)');
    starGrad.addColorStop(0.4, 'rgba(255, 253, 231, 0.92)');
    starGrad.addColorStop(0.85, 'rgba(255, 241, 118, 0.85)');
    starGrad.addColorStop(1.0, 'rgba(255, 179, 0, 0.7)');
    ctx.fillStyle = starGrad;
    ctx.fill();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // 3. Diagonal secondary 4-star mini-rays
    const diagLen = r * 0.38;
    const dThick = r * 0.08;
    ctx.beginPath();
    const d45 = Math.PI / 4;
    for (let d = 0; d < 4; d++) {
      const a = d * (Math.PI / 2) + d45;
      const dx = Math.cos(a) * diagLen;
      const dy = Math.sin(a) * diagLen;
      const px = Math.cos(a + Math.PI / 2) * dThick;
      const py = Math.sin(a + Math.PI / 2) * dThick;
      if (d === 0) ctx.moveTo(cx + dx, cy + dy);
      else ctx.lineTo(cx + dx, cy + dy);
      ctx.lineTo(cx + px, cy + py);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.fill();

    // 4. Satellite micro-sparkle motes
    for (let s = 0; s < 6; s++) {
      const sAngle = (s / 6) * Math.PI * 2 + rng() * 0.5;
      const sDist = r * (0.65 + rng() * 0.3);
      const sx = cx + Math.cos(sAngle) * sDist;
      const sy = cy + Math.sin(sAngle) * sDist;
      ctx.beginPath();
      ctx.arc(sx, sy, 2.0 + rng() * 1.5, 0, Math.PI * 2);
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
attribute float aType;        // 0=streamline, 1=petal, 2=dandelion, 3=sparkle
attribute vec2 aLifeParam;    // x = life, y = maxLife
attribute vec4 aColorMod;     // rgb = tint, a = seed/phase
attribute vec4 aRot;          // x = roll, y = pitch, z = yaw, w = swayAmp

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

  float s = aSize;
  if (aType < 0.5) {
    // Type 0: Wind streamline — expands fast then smoothly tapers
    float envelope = ageF < 0.18 ? smoothstep(0.0, 0.18, ageF) : (1.0 - smoothstep(0.38, 1.0, ageF));
    s *= mix(0.75, 1.28, envelope);
  } else if (aType < 1.5) {
    // Type 1: Flower Petal — maintains natural size with slight wind flutter wobble
    s *= 1.0 + 0.12 * sin(ageF * 9.42 + aColorMod.a * 6.28);
  } else if (aType < 2.5) {
    // Type 2: Dandelion Pappus — fluffy expansion
    s *= mix(0.85, 1.22, smoothstep(0.0, 0.35, ageF));
  } else {
    // Type 3: Sunlit Sparkle — twinkle pulse
    float pulse = 0.5 + 0.5 * sin(ageF * 22.0 + aColorMod.a * 6.28);
    s *= mix(0.65, 1.45, pulse) * (1.0 - ageF * 0.65);
  }

  // Camera basis vectors
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 camFwd   = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);

  vec3 offset = vec3(0.0);

  if (aType < 0.5) {
    // -------------------------------------------------------------
    // Type 0: Aerodynamic Wind Streamline — Kinetic Velocity Streaking
    // -------------------------------------------------------------
    vec2 vScreen = vec2(dot(aVel, camRight), dot(aVel, camUp));
    float spd = length(vScreen);
    if (spd > 0.35) {
      vec2 dir = vScreen / spd;
      vec2 norm = vec2(-dir.y, dir.x);
      float stretch = clamp(1.25 + spd * 0.16, 1.25, 3.2);
      vec2 localP = position.xy;
      vec2 stretched = dir * (localP.y * stretch) + norm * (localP.x * 0.48);
      offset = (camRight * stretched.x + camUp * stretched.y) * s;
    } else {
      offset = (camRight * position.x + camUp * position.y) * s;
    }
  } else if (aType < 1.5) {
    // -------------------------------------------------------------
    // Type 1: Falling Flower Petal — 3D Tumbling Euler Rotation
    // -------------------------------------------------------------
    float roll  = aRot.x + ageF * 4.2;
    float pitch = aRot.y + ageF * 2.8;
    float yaw   = aRot.z + sin(ageF * 5.0) * 0.85;

    float cr = cos(roll),  sr = sin(roll);
    float cp = cos(pitch), sp = sin(pitch);
    float cy = cos(yaw),   sy = sin(yaw);

    // Composite 3D rotation matrix around camera-relative axes
    vec3 localX = camRight * (cy * cr - sy * sp * sr) + camUp * (-cp * sr) + camFwd * (sy * cr + cy * sp * sr);
    vec3 localY = camRight * (cy * sr + sy * sp * cr) + camUp * (cp * cr)  + camFwd * (sy * sr - cy * sp * cr);

    offset = (localX * (position.x * 0.92) + localY * (position.y * 1.22)) * s;
  } else if (aType < 2.5) {
    // -------------------------------------------------------------
    // Type 2: Dandelion Pappus — Buoyant Tilting Billboarding
    // -------------------------------------------------------------
    float tilt = sin(ageF * 3.5 + aColorMod.a * 6.28) * 0.28;
    float ct = cos(tilt), st = sin(tilt);
    vec3 rightTilted = camRight * ct - camUp * st;
    vec3 upTilted    = camRight * st + camUp * ct;
    offset = (rightTilted * position.x + upTilted * position.y) * s;
  } else {
    // -------------------------------------------------------------
    // Type 3: Sunlit Sparkle — Twinkling Camera-Facing Billboard
    // -------------------------------------------------------------
    float rot = aRot.x + ageF * 14.0;
    float crot = cos(rot), srot = sin(rot);
    vec3 rVec = camRight * crot - camUp * srot;
    vec3 uVec = camRight * srot + camUp * crot;
    offset = (rVec * position.x + uVec * position.y) * s;
  }

  vec3 worldPos = aPos + offset;

  // Sunlight forward scattering calculation
  vec3 viewDir = normalize(worldPos - cameraPosition);
  vSunScatter = dot(viewDir, uSunDir);

  // 4-quadrant UV indexing:
  // Type 0: [0, 0] (TL)
  // Type 1: [1, 0] (TR)
  // Type 2: [0, 1] (BL)
  // Type 3: [1, 1] (BR)
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
uniform vec3 uPetalPink;
uniform vec3 uGliderCanvas;
uniform vec3 uSkyHorizon;
uniform vec3 uInk;

varying vec2 vUv;
varying float vType;
varying float vAgeF;
varying float vSunScatter;
varying vec4 vColorMod;

void main() {
  vec4 tex = texture2D(uTex, vUv);
  if (tex.a < 0.015) discard;

  vec3 col = tex.rgb;
  float alpha = tex.a;

  if (vType < 0.5) {
    // -------------------------------------------------------------
    // Type 0: Aerodynamic White Wind Streamline
    // -------------------------------------------------------------
    // Soft pure white stream with subtle Ghibli warm sunlight tint
    vec3 streamCol = mix(vec3(1.0, 1.0, 1.0), vColorMod.rgb, 0.22);
    streamCol = mix(streamCol, uSunColor, max(0.0, vSunScatter) * 0.28);
    col = mix(col, streamCol, 0.88);

    // 3-step anime watercolor fade
    float fade = (1.0 - smoothstep(0.65, 1.0, vAgeF)) * smoothstep(0.0, 0.12, 1.0 - vAgeF);
    alpha *= fade * 0.92;
  } else if (vType < 1.5) {
    // -------------------------------------------------------------
    // Type 1: Falling Watercolor Flower Petal
    // -------------------------------------------------------------
    // Harmonious pink/rose watercolor wash modulated by instance tint
    vec3 petalBase = mix(uPetalPink, vColorMod.rgb, 0.32);
    // Sunlight backlighting translucency (Ghibli sunlight transmission)
    float backScatter = max(0.0, vSunScatter);
    vec3 sunlitPetal = mix(petalBase, uSunColor, backScatter * 0.42);
    col = mix(col * petalBase, sunlitPetal, 0.38);

    // Natural tumbling opacity curve (lingers gently)
    float fade = 1.0 - smoothstep(0.75, 1.0, vAgeF);
    alpha *= fade * 0.95;
  } else if (vType < 2.5) {
    // -------------------------------------------------------------
    // Type 2: Dandelion Pappus
    // -------------------------------------------------------------
    // Gossamer white seed fibers with warm sunlight corona
    vec3 dandelionCol = mix(uGliderCanvas, vec3(1.0, 1.0, 1.0), 0.72);
    dandelionCol = mix(dandelionCol, uSunColor, max(0.0, vSunScatter) * 0.35);
    col = mix(col, dandelionCol, 0.85);

    // Long buoyant lingering fade
    float fade = 1.0 - smoothstep(0.82, 1.0, vAgeF);
    alpha *= fade * 0.9;
  } else {
    // -------------------------------------------------------------
    // Type 3: Sunlit Sparkle / Golden Pollen Glint
    // -------------------------------------------------------------
    // Radiant solar gold star core
    vec3 sparkleCol = mix(uSunColor, vec3(1.0, 0.98, 0.9), 0.55);
    col = mix(col, sparkleCol, 0.92);

    float fade = 1.0 - smoothstep(0.6, 1.0, vAgeF);
    float twinkle = 0.55 + 0.45 * sin(vAgeF * 28.0 + vColorMod.a * 6.28);
    alpha *= fade * twinkle;
  }

  gl_FragColor = vec4(col, alpha);
}
`;

/**
 * Preallocated, zero-GC instanced particle system for Wind Trails,
 * Flower Petals, Dandelion Seeds, and Sunlit Sparkles.
 */
export class JetTrailSystem implements IJetTrail {
  readonly object: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;

  // CPU particle state arrays (512 particles)
  private readonly px = new Float32Array(COUNT);
  private readonly py = new Float32Array(COUNT);
  private readonly pz = new Float32Array(COUNT);
  private readonly vx = new Float32Array(COUNT);
  private readonly vy = new Float32Array(COUNT);
  private readonly vz = new Float32Array(COUNT);
  private readonly size = new Float32Array(COUNT);
  private readonly type = new Float32Array(COUNT);
  private readonly life = new Float32Array(COUNT);
  private readonly maxLife = new Float32Array(COUNT);
  private readonly rotX = new Float32Array(COUNT);
  private readonly rotY = new Float32Array(COUNT);
  private readonly rotZ = new Float32Array(COUNT);
  private readonly rotSpeed = new Float32Array(COUNT);
  private readonly swayPhase = new Float32Array(COUNT);
  private readonly swaySpeed = new Float32Array(COUNT);
  private readonly swayAmp = new Float32Array(COUNT);
  private readonly colR = new Float32Array(COUNT);
  private readonly colG = new Float32Array(COUNT);
  private readonly colB = new Float32Array(COUNT);
  private readonly phase = new Float32Array(COUNT);

  private cursor = 0;
  private emissionIndex = 0;

  // GPU Buffer Attributes
  private readonly attrPos: THREE.InstancedBufferAttribute;
  private readonly attrVel: THREE.InstancedBufferAttribute;
  private readonly attrSize: THREE.InstancedBufferAttribute;
  private readonly attrType: THREE.InstancedBufferAttribute;
  private readonly attrLife: THREE.InstancedBufferAttribute;
  private readonly attrColor: THREE.InstancedBufferAttribute;
  private readonly attrRot: THREE.InstancedBufferAttribute;

  private readonly atlasTexture: THREE.CanvasTexture;

  constructor() {
    this.atlasTexture = makeWindGliderAtlas();

    // Base billboard quad geometry (-0.5 .. 0.5)
    const baseGeo = new THREE.PlaneGeometry(1, 1);
    const instGeo = new THREE.InstancedBufferGeometry();
    instGeo.index = baseGeo.index;
    instGeo.attributes.position = baseGeo.attributes.position;
    instGeo.attributes.uv = baseGeo.attributes.uv;

    this.attrPos = new THREE.InstancedBufferAttribute(new Float32Array(COUNT * 3), 3);
    this.attrVel = new THREE.InstancedBufferAttribute(new Float32Array(COUNT * 3), 3);
    this.attrSize = new THREE.InstancedBufferAttribute(new Float32Array(COUNT), 1);
    this.attrType = new THREE.InstancedBufferAttribute(new Float32Array(COUNT), 1);
    this.attrLife = new THREE.InstancedBufferAttribute(new Float32Array(COUNT * 2), 2);
    this.attrColor = new THREE.InstancedBufferAttribute(new Float32Array(COUNT * 4), 4);
    this.attrRot = new THREE.InstancedBufferAttribute(new Float32Array(COUNT * 4), 4);

    this.attrPos.setUsage(THREE.DynamicDrawUsage);
    this.attrVel.setUsage(THREE.DynamicDrawUsage);
    this.attrSize.setUsage(THREE.DynamicDrawUsage);
    this.attrType.setUsage(THREE.DynamicDrawUsage);
    this.attrLife.setUsage(THREE.DynamicDrawUsage);
    this.attrColor.setUsage(THREE.DynamicDrawUsage);
    this.attrRot.setUsage(THREE.DynamicDrawUsage);

    instGeo.setAttribute('aPos', this.attrPos);
    instGeo.setAttribute('aVel', this.attrVel);
    instGeo.setAttribute('aSize', this.attrSize);
    instGeo.setAttribute('aType', this.attrType);
    instGeo.setAttribute('aLifeParam', this.attrLife);
    instGeo.setAttribute('aColorMod', this.attrColor);
    instGeo.setAttribute('aRot', this.attrRot);

    const sunDirVec = new THREE.Vector3(PALETTE.sunDir[0], PALETTE.sunDir[1], PALETTE.sunDir[2]).normalize();

    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTex: { value: this.atlasTexture },
        uSunDir: { value: sunDirVec },
        uSunColor: { value: new THREE.Color(PALETTE.sun) },
        uPetalPink: { value: new THREE.Color(PALETTE.petalPink) },
        uGliderCanvas: { value: new THREE.Color(PALETTE.gliderCanvas) },
        uSkyHorizon: { value: new THREE.Color(PALETTE.skyHorizon) },
        uInk: { value: new THREE.Color(PALETTE.ink) },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    this.object = new THREE.Mesh(instGeo, mat);
    this.object.name = 'wind-jet-trail';
    this.object.frustumCulled = false;
    this.object.renderOrder = 8;
    this.object.layers.enable(LAYER_ENERGY);
  }

  /**
   * Emit a dynamic particle into the ring buffer pool.
   * Context-aware selection creates an organic Solarpunk blend of
   * white wind streamlines, dancing cherry petals, dandelion seeds, and sun sparkles.
   */
  emit(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    color: number,
    size: number,
    life: number,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % COUNT;
    this.emissionIndex++;

    let pType = TYPE_STREAMLINE;
    let pSize = size;
    let pLife = life;

    const isFlight = color === PALETTE.flight || color === 0x9b7cff;
    const isBoost = color === PALETTE.boost || color === 0xffac3d || color === 0xffdc7a;

    if (isFlight) {
      // Glider flight vortices: white streamlines + floating sakura petals + buoyant dandelions
      const cycle = this.emissionIndex % 10;
      if (cycle < 4) {
        pType = TYPE_STREAMLINE;
        pSize = size * 1.2;
        pLife = life * 0.95;
      } else if (cycle < 7) {
        pType = TYPE_PETAL;
        pSize = size * 1.35;
        pLife = life * 1.75;
      } else if (cycle < 9) {
        pType = TYPE_DANDELION;
        pSize = size * 1.45;
        pLife = life * 2.1;
      } else {
        pType = TYPE_SPARKLE;
        pSize = size * 0.95;
        pLife = life * 0.85;
      }
    } else if (isBoost) {
      // Boost slipstream: energetic white wind lines + golden sparkles + whirling petals
      const cycle = this.emissionIndex % 10;
      if (cycle < 6) {
        pType = TYPE_STREAMLINE;
        pSize = size * 1.25;
        pLife = life * 0.95;
      } else if (cycle < 8) {
        pType = TYPE_PETAL;
        pSize = size * 1.2;
        pLife = life * 1.4;
      } else {
        pType = TYPE_SPARKLE;
        pSize = size * 1.1;
        pLife = life * 0.85;
      }
    } else {
      // Drift & hull turbulence
      const cycle = this.emissionIndex % 8;
      if (cycle < 5) {
        pType = TYPE_STREAMLINE;
        pSize = size * 1.1;
        pLife = life * 0.95;
      } else if (cycle < 7) {
        pType = TYPE_PETAL;
        pSize = size * 1.25;
        pLife = life * 1.5;
      } else {
        pType = TYPE_SPARKLE;
        pSize = size * 0.9;
        pLife = life * 0.8;
      }
    }

    // Color decoding
    const r = ((color >> 16) & 255) / 255;
    const g = ((color >> 8) & 255) / 255;
    const b = (color & 255) / 255;

    this.px[i] = x;
    this.py[i] = y;
    this.pz[i] = z;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    this.size[i] = pSize;
    this.type[i] = pType;
    this.life[i] = pLife;
    this.maxLife[i] = pLife;

    // Pseudo-random phase & rotation seeds
    const seed = ((i * 1.6180339887) % 1.0);
    this.phase[i] = seed;
    this.rotX[i] = seed * Math.PI * 2;
    this.rotY[i] = ((seed * 3.14159) % 1.0) * Math.PI * 2;
    this.rotZ[i] = ((seed * 2.71828) % 1.0) * Math.PI * 2;
    this.rotSpeed[i] = (0.7 + seed * 1.8) * (seed > 0.5 ? 1 : -1);
    this.swayPhase[i] = seed * Math.PI * 2;
    this.swaySpeed[i] = 3.2 + seed * 3.8;
    this.swayAmp[i] = 0.28 + seed * 0.42;

    this.colR[i] = r;
    this.colG[i] = g;
    this.colB[i] = b;
  }

  /**
   * Explicitly emit a typed particle (e.g. for custom flower petals or dandelion events).
   */
  emitTyped(
    type: number,
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    color: number,
    size: number,
    life: number,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % COUNT;
    this.emissionIndex++;

    const r = ((color >> 16) & 255) / 255;
    const g = ((color >> 8) & 255) / 255;
    const b = (color & 255) / 255;

    this.px[i] = x;
    this.py[i] = y;
    this.pz[i] = z;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    this.size[i] = size;
    this.type[i] = type;
    this.life[i] = life;
    this.maxLife[i] = life;

    const seed = ((i * 1.6180339887) % 1.0);
    this.phase[i] = seed;
    this.rotX[i] = seed * Math.PI * 2;
    this.rotY[i] = ((seed * 3.14159) % 1.0) * Math.PI * 2;
    this.rotZ[i] = ((seed * 2.71828) % 1.0) * Math.PI * 2;
    this.rotSpeed[i] = (0.7 + seed * 1.8) * (seed > 0.5 ? 1 : -1);
    this.swayPhase[i] = seed * Math.PI * 2;
    this.swaySpeed[i] = 3.2 + seed * 3.8;
    this.swayAmp[i] = 0.28 + seed * 0.42;

    this.colR[i] = r;
    this.colG[i] = g;
    this.colB[i] = b;
  }

  /**
   * 60Hz physics and animation step. 0 dynamic allocations (0 GC).
   */
  update(dt: number): void {
    const delta = Math.min(dt, 0.05);

    const posArr = this.attrPos.array as Float32Array;
    const velArr = this.attrVel.array as Float32Array;
    const sizeArr = this.attrSize.array as Float32Array;
    const typeArr = this.attrType.array as Float32Array;
    const lifeArr = this.attrLife.array as Float32Array;
    const colArr = this.attrColor.array as Float32Array;
    const rotArr = this.attrRot.array as Float32Array;

    for (let i = 0; i < COUNT; i++) {
      const curLife = this.life[i];
      if (curLife <= 0) {
        sizeArr[i] = 0;
        lifeArr[i * 2] = 0;
        continue;
      }

      const nextLife = curLife - delta;
      this.life[i] = nextLife <= 0 ? 0 : nextLife;

      if (this.life[i] <= 0) {
        sizeArr[i] = 0;
        lifeArr[i * 2] = 0;
        continue;
      }

      const t = this.type[i];
      const maxL = this.maxLife[i];

      // Organic anime physics per particle type
      if (t === TYPE_STREAMLINE) {
        // White wind streamline: high drag, velocity stretching, gentle thermal rise
        const drag = Math.max(0, 1.0 - 2.8 * delta);
        this.vx[i] *= drag;
        this.vy[i] = (this.vy[i] + 0.18 * delta) * drag;
        this.vz[i] *= drag;
        this.px[i] += this.vx[i] * delta;
        this.py[i] += this.vy[i] * delta;
        this.pz[i] += this.vz[i] * delta;
      } else if (t === TYPE_PETAL) {
        // Falling flower petal: gentle gravity, air drag, turbulence flutter & 3D tumble
        const drag = Math.max(0, 1.0 - 1.5 * delta);
        this.vx[i] *= drag;
        this.vz[i] *= drag;
        this.vy[i] = (this.vy[i] - 1.15 * delta) * drag;

        this.swayPhase[i] += this.swaySpeed[i] * delta;
        const sway = Math.sin(this.swayPhase[i]);
        const swayCos = Math.cos(this.swayPhase[i] * 0.72);
        const amp = this.swayAmp[i];

        this.px[i] += (this.vx[i] + sway * amp) * delta;
        this.py[i] += this.vy[i] * delta;
        this.pz[i] += (this.vz[i] + swayCos * amp) * delta;

        this.rotX[i] += this.rotSpeed[i] * delta * 1.5;
        this.rotY[i] += this.rotSpeed[i] * delta * 0.9;
        this.rotZ[i] += sway * delta * 2.2;
      } else if (t === TYPE_DANDELION) {
        // Dandelion seed puff: extreme buoyancy, gentle updrafts, slow helical floating
        const drag = Math.max(0, 1.0 - 2.2 * delta);
        this.vx[i] *= drag;
        this.vz[i] *= drag;
        this.vy[i] = (this.vy[i] - 0.26 * delta + 0.12 * Math.sin(this.swayPhase[i])) * drag;

        this.swayPhase[i] += this.swaySpeed[i] * delta * 0.75;
        const swayX = Math.sin(this.swayPhase[i] * 1.1) * this.swayAmp[i] * 1.1;
        const swayZ = Math.cos(this.swayPhase[i] * 1.1) * this.swayAmp[i] * 1.1;

        this.px[i] += (this.vx[i] * 0.4 + swayX) * delta;
        this.py[i] += this.vy[i] * delta;
        this.pz[i] += (this.vz[i] * 0.4 + swayZ) * delta;

        this.rotZ[i] += Math.sin(this.swayPhase[i] * 0.6) * delta * 0.8;
      } else {
        // Sparkle: quick air brake, upward solar dust drift
        const drag = Math.max(0, 1.0 - 3.8 * delta);
        this.vx[i] *= drag;
        this.vz[i] *= drag;
        this.vy[i] = (this.vy[i] + 0.35 * delta) * drag;

        this.px[i] += this.vx[i] * delta;
        this.py[i] += this.vy[i] * delta;
        this.pz[i] += this.vz[i] * delta;

        this.rotX[i] += delta * 6.5;
      }

      // Update GPU buffer attributes
      const i3 = i * 3;
      posArr[i3] = this.px[i];
      posArr[i3 + 1] = this.py[i];
      posArr[i3 + 2] = this.pz[i];

      velArr[i3] = this.vx[i];
      velArr[i3 + 1] = this.vy[i];
      velArr[i3 + 2] = this.vz[i];

      sizeArr[i] = this.size[i];
      typeArr[i] = this.type[i];

      const i2 = i * 2;
      lifeArr[i2] = this.life[i];
      lifeArr[i2 + 1] = maxL;

      const i4 = i * 4;
      colArr[i4] = this.colR[i];
      colArr[i4 + 1] = this.colG[i];
      colArr[i4 + 2] = this.colB[i];
      colArr[i4 + 3] = this.phase[i];

      rotArr[i4] = this.rotX[i];
      rotArr[i4 + 1] = this.rotY[i];
      rotArr[i4 + 2] = this.rotZ[i];
      rotArr[i4 + 3] = this.swayAmp[i];
    }

    this.attrPos.needsUpdate = true;
    this.attrVel.needsUpdate = true;
    this.attrSize.needsUpdate = true;
    this.attrType.needsUpdate = true;
    this.attrLife.needsUpdate = true;
    this.attrColor.needsUpdate = true;
    this.attrRot.needsUpdate = true;
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.object.material.dispose();
    this.atlasTexture.dispose();
  }
}
