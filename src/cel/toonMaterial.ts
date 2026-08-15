/**
 * toonMaterial.ts — THE cel surface shader.
 *
 * One baked sun direction (no three.js lights, no PBR, no env maps):
 *   diffuse   = NdotL quantized through the 1D ramp (hard bands)
 *   rim       = fresnel through a hard step threshold
 *   specular  = Blinn half-vector through two hard step thresholds
 *   fog       = two hard distance bands toward the horizon color
 * Everything is a step — if it reads smooth/photographic, it's a bug.
 *
 * Color pipeline: palette hex values are loaded verbatim (NoColorSpace) and
 * the shader writes straight to the composer target (NoToneMapping, no
 * OutputPass), so authored palette colors are exactly what you see.
 */
import * as THREE from 'three';
import { PALETTE } from '../core/palette';
import { createToonRamp } from './ramp';

/** The ONE light direction: world space, pointing TOWARD the sun. Shared by sky, water spec and every toon material. */
export const SUN_DIR: THREE.Vector3 = new THREE.Vector3(
  PALETTE.sunDir[0],
  PALETTE.sunDir[1],
  PALETTE.sunDir[2],
).normalize();

export interface ToonOptions {
  color: number;
  rimColor?: number; rimStrength?: number; rimPower?: number; rimThreshold?: number;
  specColor?: number; specThreshold?: number; specThreshold2?: number; specPower?: number;
  emissive?: number; emissiveIntensity?: number;
  shadowFloor?: number;
  shadowTint?: number;
  upTint?: number;
  upTintColor?: number;
  sunColor?: number;
  ramp?: THREE.DataTexture;
}

/** Palette hex → THREE.Color with NO color-space conversion (verbatim to screen, see header). */
function flat(hex: number): THREE.Color {
  return new THREE.Color().setHex(hex, THREE.NoColorSpace);
}

/** All toon materials share one default 4-band ramp texture [0.45, 0.65, 0.85, 1.0].
 *  The darkest band is lifted (0.45) so shadow sides keep readable hue — never near-black. */
let sharedRamp: THREE.DataTexture | null = null;
export function getSharedToonRamp(): THREE.DataTexture {
  if (sharedRamp === null) sharedRamp = createToonRamp();
  return sharedRamp;
}

const vertexShader = /* glsl */ `
varying vec3 vWorldNormal;
varying vec3 vWorldPos;

void main() {
  // World-space normal for the sun dot / up-tint / rim / spec.
  // mat3(modelMatrix) assumes uniform scale, which holds for every mesh in
  // this project (boats, riders, buoys are built with uniform scales).
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPos.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const fragmentShader = /* glsl */ `
uniform vec3 uColor;            // flat albedo
uniform sampler2D uRamp;        // 1D toon ramp (NearestFilter => hard bands)
uniform vec3 uSunDir;           // world-space direction TOWARD the sun (normalized)
uniform vec3 uSunColor;         // warm solar light color (default: PALETTE.sun)
uniform vec3 uSkyMid;           // shadow-side sky hue source (default: PALETTE.skyMid)
uniform float uShadowTint;      // 0..1 how far shadows hue-shift toward uSkyMid
uniform vec3 uShadowFloor;      // absolute darkest a toon surface may render (default: PALETTE.ink)
uniform vec3 uRimColor;         // fresnel rim color (default: PALETTE.sparkle)
uniform float uRimStrength;
uniform float uRimPower;
uniform float uRimThreshold;    // hard step on the fresnel term
uniform vec3 uSpecColor;        // banded specular color (default: PALETTE.sunCore)
uniform float uSpecPower;       // Blinn shininess
uniform float uSpecThreshold;   // hard step for the broad band
uniform float uSpecThreshold2;  // hard step for the tighter hot core
uniform vec3 uEmissive;
uniform float uEmissiveIntensity;
uniform vec3 uUpTintColor;      // matcap-ish sky tint for up-facing normals
uniform float uUpTint;          // strength of that tint (0 disables)
uniform vec3 uFogColor;         // palette.skyHorizon
uniform float uFogBand1;        // distance (m) of the first fog step
uniform float uFogBand2;        // distance (m) of the second fog step
uniform float uFogStrength;     // overall fog multiplier

varying vec3 vWorldNormal;
varying vec3 vWorldPos;

void main() {
  vec3 N = normalize(vWorldNormal);
  vec3 V = normalize(cameraPosition - vWorldPos); // world-space view dir
  vec3 L = uSunDir;                               // already normalized

  // ------------------------------------------------------------------
  // DIFFUSE — NdotL wrapped to 0..1 and quantized through the 1D ramp.
  // NearestFilter on the ramp means every band edge is razor hard.
  // ------------------------------------------------------------------
  float ndl = clamp(dot(N, L) * 0.5 + 0.5, 0.0, 1.0);
  float band = texture2D(uRamp, vec2(ndl, 0.5)).r;

  // Ghibli watercolor lighting:
  // - Shadows receive ambient sky diffuse (uSkyMid), preserving vibrant hue without dead black.
  // - Lit highlights receive subtle warm sun radiance (uSunColor).
  // - Quantized through the 4-band ramp [0.45, 0.65, 0.85, 1.0] for crisp posterized steps.
  vec3 shadowAlbedo = uColor * mix(vec3(1.0), uSkyMid, uShadowTint);
  vec3 litAlbedo = uColor * mix(vec3(1.0), uSunColor, 0.15);
  vec3 color = mix(shadowAlbedo, litAlbedo, band);

  // ------------------------------------------------------------------
  // MATCAP-ISH UP TINT — one hard step on upward-facing normals, faking
  // the sky bounce a matcap would give. Flat and graphic, strength subtle.
  // ------------------------------------------------------------------
  float up = step(0.72, N.y) * uUpTint;
  color = mix(color, uUpTintColor, up);

  // ------------------------------------------------------------------
  // SHADOW FLOOR — clamp at deep warm ink minimum (PALETTE.ink).
  // Nothing toon-shaded may render as a dead black void: even the darkest
  // ramp band on the darkest albedo (ink) keeps a readable hue. Clamping
  // the already-quantized color preserves the hard band edges; only albedos
  // darker than the floor are touched. Ink OUTLINES (separate shader) are
  // intentionally exempt and may go darker.
  // ------------------------------------------------------------------
  color = max(color, uShadowFloor);

  // ------------------------------------------------------------------
  // BANDED SPECULAR — Blinn half-vector through two hard thresholds:
  // a broad band plus a tighter hot core. Crisp cartoon highlight SHAPES
  // with zero smooth falloff. This replaces any environment reflection.
  // ------------------------------------------------------------------
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), uSpecPower);
  float specBand = step(uSpecThreshold, spec) * 0.45
                 + step(uSpecThreshold2, spec) * 0.55;
  color += uSpecColor * specBand;

  // ------------------------------------------------------------------
  // FRESNEL RIM — pow(1 - NdotV, rimPower) through a hard step.
  // Silhouettes pop with crisp watercolor edge glow against the water.
  // ------------------------------------------------------------------
  float fresnel = pow(1.0 - max(dot(N, V), 0.0), uRimPower);
  float rim = step(uRimThreshold, fresnel) * uRimStrength;
  color += uRimColor * rim;

  // ------------------------------------------------------------------
  // EMISSIVE — flat add (boost glows, gate lights, etc).
  // ------------------------------------------------------------------
  color += uEmissive * uEmissiveIntensity;

  // ------------------------------------------------------------------
  // FOG — two hard distance bands toward the horizon color.
  // Banded, not smooth: aerial perspective as a graphic device.
  // ------------------------------------------------------------------
  float dist = distance(vWorldPos, cameraPosition);
  float fog = (step(uFogBand1, dist) * 0.35 + step(uFogBand2, dist) * 0.45) * uFogStrength;
  color = mix(color, uFogColor, min(fog, 1.0));

  gl_FragColor = vec4(color, 1.0);
}
`;

/**
 * Build a cel-shaded material. The sun is a baked uniform (SUN_DIR) — no
 * three.js lights involved. All thresholds/strengths live in
 * `material.uniforms` for screenshot-driven tuning.
 */
export function createToonMaterial(opts: ToonOptions): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'CelToon',
    uniforms: {
      uColor: { value: flat(opts.color) },
      uSunDir: { value: SUN_DIR },
      uSunColor: { value: flat(opts.sunColor ?? PALETTE.sun) },
      uRamp: { value: opts.ramp ?? getSharedToonRamp() },
      uSkyMid: { value: flat(PALETTE.skyMid) },
      uShadowTint: { value: opts.shadowTint ?? 0.45 },
      // Deep warm sepia ink, verbatim to screen: the darkest any toon surface renders.
      uShadowFloor: { value: flat(opts.shadowFloor ?? PALETTE.ink) },
      uRimColor: { value: flat(opts.rimColor ?? PALETTE.sparkle) },
      uRimStrength: { value: opts.rimStrength ?? 0.9 },
      uRimPower: { value: opts.rimPower ?? 2.6 },
      uRimThreshold: { value: opts.rimThreshold ?? 0.58 },
      uSpecColor: { value: flat(opts.specColor ?? PALETTE.sunCore) },
      uSpecPower: { value: opts.specPower ?? 72.0 },
      uSpecThreshold: { value: opts.specThreshold ?? 0.92 },
      uSpecThreshold2: { value: opts.specThreshold2 ?? 0.985 },
      uEmissive: { value: flat(opts.emissive ?? 0x000000) },
      uEmissiveIntensity: { value: opts.emissiveIntensity ?? 1.0 },
      uUpTintColor: { value: flat(opts.upTintColor ?? PALETTE.skyHorizon) },
      uUpTint: { value: opts.upTint ?? 0.12 },
      uFogColor: { value: flat(PALETTE.skyHorizon) },
      uFogBand1: { value: 260.0 },
      uFogBand2: { value: 760.0 },
      uFogStrength: { value: 1.0 },
    },
    vertexShader,
    fragmentShader,
  });
}
