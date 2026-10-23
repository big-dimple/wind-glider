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
  specColor?: number; specThreshold?: number; specThreshold2?: number; specPower?: number; specStrength?: number;
  translucency?: number;
  hatchDensity?: number;
  emissive?: number; emissiveIntensity?: number;
  shadowFloor?: number;
  shadowTint?: number;
  upTint?: number;
  upTintColor?: number;
  sunColor?: number;
  skyZenith?: number;
  skyMid?: number;
  skyHorizon?: number;
  groundBounceColor?: number;
  groundBounceStrength?: number;
  skylightStrength?: number;
  fogStart?: number;
  fogFar?: number;
  fogStrength?: number;
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
uniform sampler2D uRamp;        // 1D toon ramp
uniform vec3 uSunDir;           // world-space direction TOWARD the sun (normalized)
uniform vec3 uSunColor;         // warm solar light color (default: PALETTE.sun)
uniform vec3 uSkyZenith;        // zenith sky hue (default: PALETTE.skyZenith)
uniform vec3 uSkyMid;           // shadow-side sky hue source (default: PALETTE.skyMid)
uniform vec3 uSkyHorizon;       // horizon sky hue (default: PALETTE.skyHorizon)
uniform float uShadowTint;      // 0..1 how far shadows hue-shift toward shadow tint
uniform vec3 uShadowTintColor;  // custom shadow tint color (default: PALETTE.skyMid)
uniform vec3 uShadowFloor;      // absolute darkest a toon surface may render (default: PALETTE.ink)
uniform vec3 uGroundBounceColor;// ground/ocean bounce light (default: PALETTE.waterCrest)
uniform float uGroundBounceStrength; // strength of upward ground reflection
uniform float uSkylightStrength;// strength of hemispherical skylight diffuse

// Soft watercolor rim lighting
uniform vec3 uRimColor;         // fresnel rim color (default: PALETTE.sparkle)
uniform float uRimStrength;
uniform float uRimPower;
uniform float uRimThreshold;    // soft-step threshold on the fresnel term

// Soft watercolor specular & sunlight translucency sheen
uniform vec3 uSpecColor;        // banded specular color (default: PALETTE.sunCore)
uniform float uSpecPower;       // Blinn shininess
uniform float uSpecThreshold;   // soft threshold for broad sheen envelope
uniform float uSpecThreshold2;  // soft threshold for tighter warm core
uniform float uSpecStrength;    // overall specular sheen strength (0.0 removes spec)
uniform float uTranslucency;    // sunlight forward translucency strength
uniform float uHatchDensity;    // pencil cross-hatching density (0.0 disables)

uniform vec3 uEmissive;
uniform float uEmissiveIntensity;
uniform vec3 uUpTintColor;      // matcap-ish sky tint for up-facing normals
uniform float uUpTint;          // strength of that tint (0 disables)

// Aerial watercolor distance fog
uniform vec3 uFogColor;         // palette.skyHorizon
uniform float uFogStart;        // distance (m) where aerial perspective begins
uniform float uFogFar;          // distance (m) where aerial perspective saturates
uniform float uFogBand1;        // legacy distance band 1
uniform float uFogBand2;        // legacy distance band 2
uniform float uFogStrength;     // overall fog multiplier

varying vec3 vWorldNormal;
varying vec3 vWorldPos;

void main() {
  vec3 N = normalize(vWorldNormal);
  vec3 V = normalize(cameraPosition - vWorldPos); // world-space view dir
  vec3 L = uSunDir;                               // already normalized

  // ------------------------------------------------------------------
  // 1. WET-IN-WET WATERCOLOR DIFFUSE (水彩湿画法柔和渐变漫射)
  // Eliminates hard 3-step staircases. Replaces with soft feathering wash,
  // delicate pigment boundary accumulation, and smooth ramp transition.
  // ------------------------------------------------------------------
  float rawNdotL = dot(N, L);
  float halfLambert = clamp(rawNdotL * 0.5 + 0.5, 0.0, 1.0);

  // Sample ramp with soft filter blend
  float rampSample = texture2D(uRamp, vec2(halfLambert, 0.5)).r;

  // Multi-tier wet-in-wet watercolor feathering (soft gradient wash)
  float wetFeather = smoothstep(0.18, 0.82, halfLambert);
  // Organic pigment wash edge (subtle watercolor accumulation along terminator)
  float washEdge = smoothstep(0.32, 0.48, halfLambert) * (1.0 - smoothstep(0.48, 0.64, halfLambert)) * 0.08;

  // Blended diffuse wash factor
  float diffuseWash = clamp(mix(wetFeather, rampSample, 0.25) + washEdge, 0.0, 1.0);

  // ------------------------------------------------------------------
  // 2. STUDIO GHIBLI GOUACHE LIGHTING & WORLD-SPACE BRUSHWORK (吉卜力水粉厚涂与岩层笔触)
  // Rich sunlit vs. cool cerulean shadow separation so cliffs, canyons,
  // mountains, and villages never clip to flat #FFFFFF.
  // ------------------------------------------------------------------
  // World-space procedural gouache texture (rock strata on cliffs, dappled brush on meadows)
  float strataWave = sin(vWorldPos.y * 0.55 + sin(vWorldPos.x * 0.07 + vWorldPos.z * 0.07) * 2.2);
  float fineStrata = sin(vWorldPos.y * 1.85 + cos(vWorldPos.x * 0.19 - vWorldPos.z * 0.17) * 1.4);
  float verticalCrevice = sin(vWorldPos.x * 0.24 + vWorldPos.z * 0.21 + sin(vWorldPos.y * 0.35) * 1.2);
  float cliffMask = clamp((0.72 - abs(N.y)) * 2.5, 0.0, 1.0);
  float meadowMask = clamp((N.y - 0.55) * 2.5, 0.0, 1.0);

  // Geological strata & mineral tint on steep canyon/mountain faces
  vec3 warmOchreShift = vec3(1.05, 0.98, 0.88);
  vec3 coolSlateShift = vec3(0.86, 0.91, 0.98);
  float strataFactor = clamp(strataWave * 0.5 + 0.5, 0.0, 1.0);
  vec3 rockTint = mix(coolSlateShift, warmOchreShift, strataFactor);
  rockTint *= 1.0 + fineStrata * 0.055 - clamp(verticalCrevice, 0.0, 1.0) * 0.065;

  // Dappled gouache foliage/meadow variation on upward faces
  float dapple = sin(vWorldPos.x * 0.16 + vWorldPos.z * 0.14) * cos(vWorldPos.x * 0.09 - vWorldPos.z * 0.18);
  vec3 meadowTint = mix(vec3(0.92, 0.97, 0.89), vec3(1.06, 1.03, 0.92), dapple * 0.5 + 0.5);

  // Waterline moss & sea-spray dampening near y = 0..4.2m
  float waterlineMask = clamp(1.0 - smoothstep(0.2, 4.2, vWorldPos.y), 0.0, 1.0) * clamp(1.0 - abs(N.y) * 0.7, 0.0, 1.0);
  vec3 mossyWaterline = vec3(0.42, 0.58, 0.52);

  // Prevent overly pale albedos (like chalkStone 0xfff8e7) from saturating to 1.0 before lighting
  vec3 basePigment = min(uColor, vec3(0.92, 0.90, 0.85));
  basePigment *= mix(vec3(1.0), rockTint, cliffMask * 0.65);
  basePigment *= mix(vec3(1.0), meadowTint, meadowMask * 0.45);
  basePigment = mix(basePigment, basePigment * mossyWaterline, waterlineMask * 0.38);

  float skyWashFactor = clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 skyDomeWash = mix(uSkyHorizon, uSkyZenith, pow(skyWashFactor, 1.15));

  // Ground bounce (emerald sea & lush terrain reflection from below)
  float groundBounceFactor = clamp(-N.y * 0.65 + 0.30 * (1.0 - halfLambert), 0.0, 1.0);
  vec3 groundBounceWash = uGroundBounceColor * groundBounceFactor * (uGroundBounceStrength * 0.55);

  vec3 ambientEnv = skyDomeWash * (uSkylightStrength * 0.42) + groundBounceWash;

  // Authentic Miyazaki cool-cerulean/periwinkle shadow wash vs. warm sunlit gouache
  vec3 customShadow = mix(vec3(0.52, 0.61, 0.76), uShadowTintColor * 0.78, 0.42);
  vec3 ghibliShadowWash = mix(vec3(0.58, 0.65, 0.78), customShadow, clamp(uShadowTint, 0.0, 1.0));
  vec3 shadowAlbedo = basePigment * ghibliShadowWash + ambientEnv * basePigment * 0.22;
  vec3 litAlbedo = basePigment * mix(vec3(0.97, 0.95, 0.90), uSunColor, 0.18) + ambientEnv * basePigment * 0.08;
  vec3 color = mix(shadowAlbedo, litAlbedo, diffuseWash);

  // ------------------------------------------------------------------
  // 3. PENCIL CROSS-HATCHING SHADER (手绘铅笔排线阴影)
  // Procedural hand-drawn micro-jitter cross-hatching in terminator / shadow transition zone.
  // ------------------------------------------------------------------
  float terminatorZone = clamp((0.55 - halfLambert) / 0.45, 0.0, 1.0);
  if (uHatchDensity > 0.01 && terminatorZone > 0.02) {
    vec3 absN = abs(N);
    vec2 hatchUv = absN.y > 0.65 ? vWorldPos.xz : (absN.x > 0.5 ? vWorldPos.yz : vWorldPos.xy);
    vec2 hp = hatchUv * (3.6 * uHatchDensity);

    float j1 = sin(hp.y * 3.2 + vWorldPos.x * 1.8) * 0.15 + sin(hp.x * 4.5) * 0.08;
    float j2 = cos(hp.x * 3.0 - vWorldPos.z * 2.0) * 0.15 + cos(hp.y * 4.2) * 0.08;

    float stroke1 = sin((hp.x + hp.y + j1) * 6.283);
    float line1 = smoothstep(0.20, 0.80, stroke1);

    float stroke2 = sin((hp.x - hp.y + j2) * 6.283);
    float line2 = smoothstep(0.20, 0.80, stroke2);

    float layer1 = mix(1.0, line1, clamp(terminatorZone * 1.4, 0.0, 1.0) * 0.16);
    float layer2 = mix(1.0, line2, clamp((terminatorZone - 0.35) * 1.8, 0.0, 1.0) * 0.16);
    float hatchFactor = layer1 * layer2;

    vec3 softGraphite = mix(shadowAlbedo * 0.84, color, hatchFactor);
    color = softGraphite;
  }

  // ------------------------------------------------------------------
  // 4. SUNLIGHT TRANSLUCENCY (暖阳透光微晕)
  // ------------------------------------------------------------------
  if (uTranslucency > 0.001) {
    vec3 forwardLightDir = normalize(L + N * 0.32);
    float translucency = pow(clamp(dot(V, -forwardLightDir), 0.0, 1.0), 3.2) * clamp(1.0 - rawNdotL * 0.8, 0.0, 1.0);
    color += uSunColor * translucency * (uTranslucency * 0.10) * basePigment;
  }

  // ------------------------------------------------------------------
  // 5. MATCAP-ISH UP TINT — Soft sky wash for upward-facing surfaces
  // ------------------------------------------------------------------
  float up = smoothstep(0.55, 0.92, N.y) * uUpTint * 0.55;
  color = mix(color, uUpTintColor * 0.90, up);

  // ------------------------------------------------------------------
  // 6. SHADOW FLOOR — Warm sepia deep tone minimum clamp
  // ------------------------------------------------------------------
  color = max(color, uShadowFloor);

  // ------------------------------------------------------------------
  // 7. ENERGY-CONSERVING WATERCOLOR HIGHLIGHT (水彩留白高光，防止过曝死白)
  // ------------------------------------------------------------------
  if (uSpecStrength > 0.001) {
    vec3 H = normalize(L + V);
    float nDotH = max(dot(N, H), 0.0);
    float specEnvelope = pow(nDotH, uSpecPower * 0.55);

    float softSheen = smoothstep(uSpecThreshold * 0.82, 1.0, specEnvelope) * uSpecStrength * 0.35;
    vec3 paperGlowTone = mix(uSpecColor, uSunColor, 0.45) * 0.95;
    color = mix(color, paperGlowTone, clamp(softSheen, 0.0, 0.35));
  }

  // ------------------------------------------------------------------
  // 8. WATERCOLOR FRESNEL RIM (柔和轮廓边缘光，受亮度抑制不溢出)
  // ------------------------------------------------------------------
  if (uRimStrength > 0.001) {
    float nDotV = max(dot(N, V), 0.0);
    float fresnel = pow(1.0 - nDotV, max(uRimPower, 2.8));
    float rimStep = smoothstep(uRimThreshold, uRimThreshold + 0.16, fresnel) * uRimStrength * 0.28;

    float sunFacing = dot(N, L) * 0.5 + 0.5;
    vec3 activeRimColor = mix(uSkyMid * 0.88, uRimColor * 0.94, sunFacing);
    float luma = dot(color, vec3(0.299, 0.587, 0.114));
    color = mix(color, activeRimColor, clamp(rimStep * (1.0 - luma * 0.45), 0.0, 0.32));
  }

  // Soft gouache highlight shoulder so non-emissive surfaces never clip to flat #FFFFFF
  color = color / (1.0 + max(vec3(0.0), color - vec3(0.78)) * 0.55);

  // ------------------------------------------------------------------
  // 9. EMISSIVE — Flat add (boost glows, gate resonance, lantern windows)
  // ------------------------------------------------------------------
  color += uEmissive * uEmissiveIntensity;

  // ------------------------------------------------------------------
  // 10. MULTI-STAGE GHIBLI AERIAL PERSPECTIVE (吉卜力远山多层次大气透视)
  // Near haze shifts shadows toward cerulean sky; far haze blends peaks into warm horizon mist.
  // ------------------------------------------------------------------
  float dist = distance(vWorldPos, cameraPosition);
  float midHaze = smoothstep(uFogStart, mix(uFogStart, uFogFar, 0.52), dist) * uFogStrength * 0.42;
  float farHaze = smoothstep(mix(uFogStart, uFogFar, 0.35), uFogFar, dist) * uFogStrength * 0.78;
  vec3 aerialMidColor = mix(uSkyMid, uFogColor, 0.52);
  color = mix(color, aerialMidColor, clamp(midHaze, 0.0, 0.48));
  color = mix(color, uFogColor, clamp(farHaze, 0.0, 0.82));

  gl_FragColor = vec4(color, 1.0);
}
`;

/**
 * Build a cel-shaded material. The sun is a baked uniform (SUN_DIR) — no
 * three.js lights involved. All thresholds/strengths live in
 * `material.uniforms` for screenshot-driven tuning.
 */
export function createToonMaterial(opts: ToonOptions): THREE.ShaderMaterial {
  const isColor = typeof opts.shadowTint === 'number' && opts.shadowTint > 1;
  const shadowTintColor = isColor ? flat(opts.shadowTint!) : flat(opts.skyMid ?? PALETTE.skyMid);
  const shadowTintFactor = isColor ? 0.45 : (opts.shadowTint ?? 0.45);

  return new THREE.ShaderMaterial({
    name: 'CelToon',
    uniforms: {
      uColor: { value: flat(opts.color) },
      uSunDir: { value: SUN_DIR },
      uSunColor: { value: flat(opts.sunColor ?? PALETTE.sun) },
      uRamp: { value: opts.ramp ?? getSharedToonRamp() },
      uSkyZenith: { value: flat(opts.skyZenith ?? PALETTE.skyZenith) },
      uSkyMid: { value: flat(opts.skyMid ?? PALETTE.skyMid) },
      uSkyHorizon: { value: flat(opts.skyHorizon ?? PALETTE.skyHorizon) },
      uShadowTintColor: { value: shadowTintColor },
      uShadowTint: { value: shadowTintFactor },
      // Deep warm sepia ink, verbatim to screen: the darkest any toon surface renders.
      uShadowFloor: { value: flat(opts.shadowFloor ?? PALETTE.ink) },
      uGroundBounceColor: { value: flat(opts.groundBounceColor ?? PALETTE.waterCrest) },
      uGroundBounceStrength: { value: opts.groundBounceStrength ?? 0.22 },
      uSkylightStrength: { value: opts.skylightStrength ?? 0.32 },
      uRimColor: { value: flat(opts.rimColor ?? PALETTE.sparkle) },
      uRimStrength: { value: opts.rimStrength ?? 0.8 },
      uRimPower: { value: opts.rimPower ?? 2.6 },
      uRimThreshold: { value: opts.rimThreshold ?? 0.58 },
      uSpecColor: { value: flat(opts.specColor ?? PALETTE.sunCore) },
      uSpecPower: { value: opts.specPower ?? 64.0 },
      uSpecThreshold: { value: opts.specThreshold ?? 0.88 },
      uSpecThreshold2: { value: opts.specThreshold2 ?? 0.96 },
      uSpecStrength: { value: opts.specStrength ?? 0.32 },
      uTranslucency: { value: opts.translucency ?? 1.0 },
      uHatchDensity: { value: opts.hatchDensity ?? 1.0 },
      uEmissive: { value: flat(opts.emissive ?? 0x000000) },
      uEmissiveIntensity: { value: opts.emissiveIntensity ?? 1.0 },
      uUpTintColor: { value: flat(opts.upTintColor ?? PALETTE.skyHorizon) },
      uUpTint: { value: opts.upTint ?? 0.12 },
      uFogColor: { value: flat(PALETTE.skyHorizon) },
      uFogStart: { value: opts.fogStart ?? 180.0 },
      uFogFar: { value: opts.fogFar ?? 1200.0 },
      uFogBand1: { value: 260.0 },
      uFogBand2: { value: 760.0 },
      uFogStrength: { value: opts.fogStrength ?? 1.0 },
    },
    vertexShader,
    fragmentShader,
  });
}
