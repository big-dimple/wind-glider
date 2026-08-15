/**
 * Beauty + cel ink + selective energy-storm composite.
 *
 * Energy-tagged geometry is rendered into a half-resolution bloom buffer.
 * The final pass combines that local glow with authored, screen-space wind
 * streaks and short impact distortion. The whole scene never goes through a
 * photographic bloom pass, so hull colors and ink silhouettes stay crisp.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type { BoatState, RacePhase } from '../contracts';
import { LAYER_ENERGY } from '../contracts';
import type { PrePass } from '../core/prePass';
import type { RenderQualityProfile } from '../core/stage';
import { createEdgePass } from './edgePass';

export type ImpactPulse = 'ready' | 'boost' | 'launch' | 'gate' | 'overtake' | 'lost' | 'collision' | 'defeat' | 'finish';

export interface PostPipeline {
  render(): void;
  update(dt: number, t: number, state: BoatState, phase: RacePhase): void;
  pulse(kind: ImpactPulse, strength?: number): void;
  setSize(w: number, h: number, pr: number): void;
}

const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = /* glsl */ `
uniform sampler2D tDiffuse;
uniform sampler2D tEnergy;
uniform vec2 uResolution;
uniform float uTime;
uniform float uBoost;
uniform float uFlight;
uniform float uPressure;
uniform float uAirBrake;
uniform float uDrift;
uniform float uImpact;
uniform float uChroma;
uniform float uFlash;
uniform float uWarning;
uniform float uBattle;
uniform float uReduced;
varying vec2 vUv;

float hash11(float p) {
  return fract(sin(p * 127.1) * 43758.5453123);
}

void main() {
  vec2 p = vUv - 0.5;
  p.x *= uResolution.x / max(uResolution.y, 1.0);
  float r = length(p);
  vec2 dir = r > 0.0001 ? p / r : vec2(0.0);
  float motion = 1.0 - uReduced;

  // The impact bends the image away from the vanishing point for only a few
  // frames. Energy luminance adds a small local heat-haze displacement.
  vec3 e0 = texture2D(tEnergy, vUv).rgb;
  float eLum = dot(e0, vec3(0.22, 0.68, 0.10));
  vec2 warpUv = vUv - dir * (uImpact * 0.008 + eLum * (0.0015 + uFlight * 0.002)) * motion;
  vec2 aberr = dir * (uChroma * 2.0 + uBoost * 0.5) * motion / uResolution;
  vec3 col;
  col.r = texture2D(tDiffuse, clamp(warpUv + aberr, 0.001, 0.999)).r;
  col.g = texture2D(tDiffuse, clamp(warpUv, 0.001, 0.999)).g;
  col.b = texture2D(tDiffuse, clamp(warpUv - aberr, 0.001, 0.999)).b;

  // Polar lanes create a deterministic speed tunnel. Each lane owns a phase
  // and length, producing streaks rather than a uniform starburst.
  const float TAU = 6.28318530718;
  float angle = atan(p.y, p.x);
  float laneF = (angle + 3.14159265359) / TAU * 116.0;
  float lane = floor(laneF);
  float laneCenter = abs(fract(laneF) - 0.5);
  float laneWidth = mix(0.014, 0.045, hash11(lane + 17.0));
  float thin = 1.0 - smoothstep(laneWidth, laneWidth + 0.022, laneCenter);
  float phase = hash11(lane * 3.71);
  float travel = fract(r * 5.6 - uTime * (2.4 + uBoost * 6.0 + uPressure * 5.0) + phase);
  float dash = smoothstep(0.62, 0.24, travel) * smoothstep(0.02, 0.12, travel);
  float edgeMask = smoothstep(0.34, 0.58, r) * (1.0 - smoothstep(0.76, 1.02, r));
  float windAmount = clamp(uBoost * 0.85 + uFlight * (0.10 + uPressure * 0.16) + uImpact * 0.28, 0.0, 0.9) * motion;
  float streak = thin * dash * edgeMask * windAmount;
  vec3 windColor = mix(vec3(0.18, 0.82, 1.0), vec3(0.48, 1.0, 0.05), clamp(uBoost * 1.2, 0.0, 1.0));

  // Air braking cuts transverse cyan blades across the tunnel, making the
  // handling change visible before the player reads the HUD.
  float brakeBands = smoothstep(0.08, 0.0, abs(fract((p.y + p.x * 0.18) * 9.0 - uTime * 7.0) - 0.5));
  brakeBands *= smoothstep(0.42, 0.72, abs(p.x)) * uAirBrake * motion;

  // Darken the plate behind additive energy so the storm has contrast instead
  // of clipping the entire frame to white.
  col *= 1.0 - min(0.16, uImpact * 0.11 + uFlight * 0.035);
  vec3 energy = texture2D(tEnergy, clamp(vUv + dir * eLum * 0.003, 0.001, 0.999)).rgb;
  col += energy * (0.20 + uFlight * 0.08 + uImpact * 0.10);
  col += windColor * streak * (0.42 + uBoost * 0.68);
  col += vec3(0.42, 0.94, 1.0) * brakeBands * 0.48;

  // Overtake celebration lives in the sky strip. The cockpit/track region is
  // deliberately untouched so a reward can never hide the next gate.
  float skyMask = smoothstep(0.70, 0.79, vUv.y);
  float battleLane = abs(fract((vUv.x + vUv.y * 0.24) * 18.0) - 0.5);
  float battleCuts = 1.0 - smoothstep(0.035, 0.085, battleLane);
  battleCuts *= step(0.55, hash11(floor((vUv.x + vUv.y * 0.24) * 18.0) + 91.0));
  float battlePulse = uBattle * skyMask;
  col += mix(vec3(0.20, 0.88, 1.0), vec3(0.72, 1.0, 0.10), vUv.x) * battleCuts * battlePulse * 0.34;
  col = mix(col, vec3(0.92, 1.0, 1.0), battlePulse * (1.0 - smoothstep(0.0, 0.16, abs(vUv.x - 0.5))) * 0.13);

  float vignette = smoothstep(0.38, 0.86, r);
  col *= 1.0 - vignette * (0.10 + uBoost * 0.07 + uDrift * 0.04);
  col = mix(col, vec3(1.0, 0.16, 0.42), uWarning * vignette * 0.38);
  col = mix(col, vec3(0.92, 0.99, 1.0), uFlash * (1.0 - smoothstep(0.15, 0.72, r)) * 0.34);
  gl_FragColor = vec4(col, 1.0);
}
`;

export function createPostPipeline(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  prePass: PrePass,
  quality: RenderQualityProfile,
): PostPipeline {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const target = new THREE.WebGLRenderTarget(size.x, size.y, {
    type: THREE.UnsignedByteType,
    samples: quality.samples,
    depthBuffer: true,
    stencilBuffer: false,
  });
  const energyTarget = new THREE.WebGLRenderTarget(
    Math.max(1, Math.floor(size.x * quality.energyScale)),
    Math.max(1, Math.floor(size.y * quality.energyScale)), {
    type: THREE.HalfFloatType,
    depthBuffer: true,
    stencilBuffer: false,
    },
  );

  const energyComposer = new EffectComposer(renderer, energyTarget);
  energyComposer.renderToScreen = false;
  energyComposer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(size.x * quality.energyScale, size.y * quality.energyScale),
    0.58, 0.32, 0.38,
  );
  energyComposer.addPass(bloom);

  const finalMaterial = new THREE.ShaderMaterial({
    name: 'EnergyStormComposite',
    uniforms: {
      tDiffuse: { value: null },
      tEnergy: { value: energyComposer.readBuffer.texture },
      uResolution: { value: size.clone() },
      uTime: { value: 0 },
      uBoost: { value: 0 },
      uFlight: { value: 0 },
      uPressure: { value: 0 },
      uAirBrake: { value: 0 },
      uDrift: { value: 0 },
      uImpact: { value: 0 },
      uChroma: { value: 0 },
      uFlash: { value: 0 },
      uWarning: { value: 0 },
      uBattle: { value: 0 },
      uReduced: { value: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : 0 },
    },
    vertexShader,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
  });
  const finalPass = new ShaderPass(finalMaterial);

  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(createEdgePass(prePass, camera));
  composer.addPass(finalPass);

  let impact = 0;
  let flash = 0;
  let warning = 0;
  let battle = 0;
  let boost = 0;
  let flight = 0;
  const oldClear = new THREE.Color();

  return {
    render(): void {
      prePass.render(renderer, scene, camera);

      const previousMask = camera.layers.mask;
      const previousBackground = scene.background;
      renderer.getClearColor(oldClear);
      const previousAlpha = renderer.getClearAlpha();
      camera.layers.set(LAYER_ENERGY);
      scene.background = null;
      renderer.setClearColor(0x000000, 0);
      energyComposer.render();
      camera.layers.mask = previousMask;
      scene.background = previousBackground;
      renderer.setClearColor(oldClear, previousAlpha);

      finalMaterial.uniforms.tEnergy.value = energyComposer.readBuffer.texture;
      composer.render();
    },
    update(dt: number, t: number, state: BoatState, phase: RacePhase): void {
      impact *= Math.exp(-6.8 * dt);
      flash *= Math.exp(-11.5 * dt);
      warning *= Math.exp(-3.9 * dt);
      battle *= Math.exp(-4.2 * dt);
      boost += ((state.boosting ? 1 : 0) - boost) * (1 - Math.exp(-(state.boosting ? 14 : 3.4) * dt));
      const flightTarget = state.flightPhase === 'surface' ? 0 : Math.max(0.35, state.flightThrust);
      flight += (flightTarget - flight) * (1 - Math.exp(-(flightTarget > flight ? 10 : 3.6) * dt));
      finalMaterial.uniforms.uTime.value = t;
      finalMaterial.uniforms.uBoost.value = boost;
      finalMaterial.uniforms.uFlight.value = flight;
      finalMaterial.uniforms.uPressure.value = state.flightPressure;
      finalMaterial.uniforms.uAirBrake.value = state.flightAirBrake;
      finalMaterial.uniforms.uDrift.value = state.drifting ? Math.max(0.25, state.boostCharge) : 0;
      finalMaterial.uniforms.uImpact.value = impact;
      finalMaterial.uniforms.uChroma.value = impact;
      finalMaterial.uniforms.uFlash.value = flash;
      finalMaterial.uniforms.uWarning.value = phase === 'defeated' ? Math.max(0.2, warning) : warning;
      finalMaterial.uniforms.uBattle.value = battle;
    },
    pulse(kind: ImpactPulse, strength = 1): void {
      const s = Math.max(0, Math.min(1.5, strength));
      const impactGain = kind === 'gate' ? 0.2 : kind === 'ready' ? 0.38 : kind === 'lost' ? 0.34 : kind === 'overtake' ? 0.32 : kind === 'collision' ? 0.48 : 1;
      impact = Math.max(impact, s * impactGain);
      const flashGain = kind === 'defeat' ? 0.72 : kind === 'gate' ? 0.14 : kind === 'overtake' ? 0.15 : kind === 'lost' ? 0.12 : 0.48;
      flash = Math.max(flash, s * flashGain);
      if (kind === 'overtake') battle = Math.max(battle, s);
      if (kind === 'defeat' || kind === 'lost') warning = Math.max(warning, s);
    },
    setSize(w: number, h: number, pr: number): void {
      const dw = Math.max(1, Math.floor(w * pr));
      const dh = Math.max(1, Math.floor(h * pr));
      composer.setSize(dw, dh);
      energyComposer.setSize(
        Math.max(1, Math.floor(dw * quality.energyScale)),
        Math.max(1, Math.floor(dh * quality.energyScale)),
      );
      finalMaterial.uniforms.uResolution.value.set(dw, dh);
    },
  };
}
