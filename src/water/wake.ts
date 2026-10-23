/**
 * wake.ts — persistent stylized wake ribbon behind a boat.
 *
 * Ring buffer of ~220 deposited stern points (min spacing 0.8 m), rendered
 * as a single triangle strip — one draw call, one preallocated geometry,
 * zero per-frame allocation (attributes are rewritten in place only when a
 * new deposit lands).
 *
 * Look (Wave Race 64 x anime ink), fully procedural — no texture:
 *  - ribbon is 2.5 m wide at the transom and spreads with DISTANCE ASTERN
 *    (fixed geometric V angle, speed-independent), capped by a speed-scaled
 *    max width — slow boats leave a narrow V, fast boats a wide one
 *  - silhouette = scalloped turbulent wash core + TWO DIVERGING V-ARMS at
 *    the ribbon rim, with negative space between; the arms persist longer
 *    than the core as the wake ages
 *  - interior breakup = STREAK GAPS cut in ribbon-UV space: cells elongated
 *    ~4:1 along the travel direction, every lateral row jittered along so
 *    holes never line up in neat rows. Cutouts use a shaped two-step
 *    threshold — a boundary cell shrinks to its center chunk instead of
 *    vanishing — so cutout edges step in 2-3 chunky blocks, never
 *    single-pixel staircase noise
 *  - scalloped foam-cap stamps at fixed distance intervals along the wash,
 *    broken into 2-3 lateral chunks (never full-width tread bars)
 *  - dissipation in HARD alpha steps + breakup-density steps, never smooth
 *  - intensity 0 (airborne) emits nothing — the strip segment just fades
 *  - Y rides waveHeight(worldXZ, uTime) + lift so the wake sits on the
 *    swell and never clips through waves
 *  - beyond ~180 m the pattern collapses to one flat center band (no shimmer)
 */

import * as THREE from 'three';
import type { IWake } from '../contracts';
import { PALETTE } from '../core/palette';
import { WAVES_GLSL } from './waves';

const MAX_POINTS = 220; // ring capacity -> 440 verts, 438 tris
const MIN_SPACING = 0.8; // meters between deposits
const TELEPORT_DIST = 8.0; // jump larger than this -> hard reset, no streak

const VERT = /* glsl */ `
uniform float uTime;
uniform float uLife;      // seconds to full age / final fade step
uniform float uWidth0;    // half-width at the transom (m)
uniform float uSpread;    // half-width growth per meter astern (tan of arm angle)
uniform float uWidthMin;  // half-width cap at zero speed (m)
uniform float uWidthMax;  // half-width cap at full speed (m)
uniform float uLift;      // ride height above the wave surface (m)
uniform float uHeadAlong; // aAlong of the newest deposit (m)

attribute vec2 aPerp;       // unit lateral direction at deposit time
attribute float aSide;      // -1 / +1 ribbon edge
attribute float aBirth;     // deposit time (s)
attribute float aIntensity; // 0..1 at deposit time
attribute float aAlong;     // meters along the ribbon from the tail

varying float vLat;
varying float vAgeF;
varying float vIntensity;
varying float vAlong;
varying float vHalfW;
varying float vDist;
varying float vBehind;

${WAVES_GLSL}

void main() {
  float age = uTime - aBirth;
  float f = clamp(age / uLife, 0.0, 1.0);
  float behind = max(uHeadAlong - aAlong, 0.0);

  // the V shape: geometric spread with distance astern, capped by a
  // speed-scaled max width (foam density/width scale with speed)
  float wCap = mix(uWidthMin, uWidthMax, aIntensity);
  float halfW = min(uWidth0 + uSpread * behind, wCap);

  vec2 wxz = position.xz + aPerp * (aSide * halfW);

  // ride the swell, never clip through it
  float y = waveHeight(wxz, uTime) + uLift;

  vLat = aSide;
  vAgeF = f;
  // dead slots (never written / expired) emit nothing
  vIntensity = (age >= uLife || age < 0.0) ? 0.0 : aIntensity;
  vAlong = aAlong;
  vHalfW = halfW;
  vBehind = behind;

  vec4 mv = modelViewMatrix * vec4(wxz.x, y, wxz.y, 1.0);
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uColorFoam;
uniform vec3 uColorWash; // mid-age foam: one tone step between fresh and aged
uniform vec3 uColorAged; // aged foam: stepped toward the water tone (interior variation)
uniform float uTime;
uniform float uStamp;     // meters per scallop stamp along the ribbon
uniform float uFps;       // breakup flip rate (steps/sec)
uniform float uGapW;      // streak-gap cell width ACROSS the ribbon (m)
uniform float uGapL;      // streak-gap cell length ALONG the ribbon (m) — 3-5x uGapW
uniform float uLaceScale; // lace cellular pore scale

varying float vLat;
varying float vAgeF;
varying float vIntensity;
varying float vAlong;
varying float vHalfW;
varying float vDist;
varying float vBehind;

// stable 2D -> 1D hash for the breakup cells
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// stable 2D -> 2D hash for Voronoi cell jitter
vec2 hash22(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453123);
}

// 2D Voronoi returning F1 (nearest) and F2 (second nearest) distance
vec2 voronoi2D(vec2 p, float time) {
  vec2 n = floor(p);
  vec2 f = fract(p);
  float d1 = 8.0;
  float d2 = 8.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = hash22(n + g);
      vec2 pt = g + 0.5 + 0.35 * sin(time + 6.283185 * o) - f;
      float d = dot(pt, pt);
      if (d < d1) {
        d2 = d1;
        d1 = d;
      } else if (d < d2) {
        d2 = d;
      }
    }
  }
  return vec2(sqrt(d1), sqrt(d2));
}

// Ghibli watercolor wake lace pattern: delicate filigree bubble webbing
float wakeLacePattern(vec2 p, float time, float porosity) {
  vec2 vd = voronoi2D(p, time);
  float pore = smoothstep(0.14, 0.44, vd.x);
  float ridge = 1.0 - smoothstep(0.015, 0.18, vd.y - vd.x);
  return clamp(pore * 0.6 + ridge * 0.5 - porosity * 0.35, 0.0, 1.0);
}

void main() {
  // emission off (airborne / dead slot): no foam at all
  if (vIntensity < 0.03) discard;

  float lat = abs(vLat);
  float f = vAgeF;

  // far field: one flat center band, no pattern — kills ribbon shimmer
  if (vDist > 180.0) {
    if (lat > 0.45) discard;
    float af = f < 0.5 ? 0.5 : 0.25;
    gl_FragColor = vec4(uColorWash, af);
    #include <colorspace_fragment>
    return;
  }

  // ---- Studio Ghibli Watercolor V-Wake & Aerated Turquoise Wash -----------
  float latM = vLat * vHalfW;
  float waveRipple = sin(vAlong * 0.55 - uTime * 3.2) * 0.04 + sin(vAlong * 1.35 + uTime * 2.1) * 0.025;

  // 1. Center aerated turbulent wash core (narrows smoothly astern)
  float pinch = clamp(1.0 - vBehind / 68.0, 0.0, 1.0);
  float coreW = (0.46 + waveRipple) * pinch;
  float coreMask = (1.0 - smoothstep(coreW * 0.55, coreW, lat)) * pinch;

  // 2. Twin curling V-wave arms along the outer wake rim
  float armCenter = 0.78 + waveRipple * 0.8;
  float armHalfW = mix(0.14, 0.08, clamp(vBehind / 55.0, 0.0, 1.0));
  float armProfile = 1.0 - smoothstep(armHalfW * 0.35, armHalfW, abs(lat - armCenter));
  float armFade = clamp(1.0 - vBehind / 58.0, 0.0, 1.0);
  float armMask = armProfile * armFade;

  // 3. Delicate Voronoi bubble lace filigree (no blocky rectangular grid cutouts!)
  float porosity = clamp(vBehind / 52.0, 0.0, 0.85);
  vec2 laceUV = vec2(vAlong * 0.42, latM * 0.85) * uLaceScale;
  float lace = wakeLacePattern(laceUV, uTime * 1.4, porosity);

  // Combine V-arms and center wash with lace filigree
  float wakeDensity = max(armMask * (0.65 + 0.35 * lace), coreMask * (0.35 + 0.65 * lace));
  // Fresh white churn right behind the stern
  if (vBehind < 4.5) {
    float sternBoost = (1.0 - vBehind / 4.5) * (1.0 - smoothstep(0.45, 0.88, lat));
    wakeDensity = max(wakeDensity, sternBoost);
  }

  if (wakeDensity < 0.12) discard;

  // Watercolor pigment layering: creamy white foam crests -> turquoise aerated wash -> cerulean trail
  float foamHighlight = smoothstep(0.52, 0.82, wakeDensity) * clamp(1.0 - vBehind / 36.0, 0.0, 1.0);
  vec3 baseWash = mix(uColorAged, uColorWash, clamp(1.0 - vBehind / 45.0, 0.0, 1.0));
  vec3 col = mix(baseWash, uColorFoam, foamHighlight);

  float a = smoothstep(0.12, 0.42, wakeDensity) * (1.0 - smoothstep(42.0, 72.0, vBehind));
  a *= clamp(vIntensity * 1.15, 0.35, 0.92);

  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}
`;

export class WakeRibbon implements IWake {
  readonly object: THREE.Object3D;

  private readonly uniforms: Record<string, THREE.IUniform>;

  // deposit ring buffer (slot data)
  private readonly cx = new Float32Array(MAX_POINTS);
  private readonly cz = new Float32Array(MAX_POINTS);
  private readonly px = new Float32Array(MAX_POINTS);
  private readonly pz = new Float32Array(MAX_POINTS);
  private readonly birth = new Float32Array(MAX_POINTS);
  private readonly inten = new Float32Array(MAX_POINTS);
  private readonly along = new Float32Array(MAX_POINTS);

  // geometry attribute backing arrays (2 verts per deposit)
  private readonly aPos = new Float32Array(MAX_POINTS * 2 * 3);
  private readonly aPerp = new Float32Array(MAX_POINTS * 2 * 2);
  private readonly aSide = new Float32Array(MAX_POINTS * 2);
  private readonly aBirth = new Float32Array(MAX_POINTS * 2);
  private readonly aInten = new Float32Array(MAX_POINTS * 2);
  private readonly aAlong = new Float32Array(MAX_POINTS * 2);
  private readonly attrPos: THREE.BufferAttribute;
  private readonly attrPerp: THREE.BufferAttribute;
  private readonly attrSide: THREE.BufferAttribute;
  private readonly attrBirth: THREE.BufferAttribute;
  private readonly attrInten: THREE.BufferAttribute;
  private readonly attrAlong: THREE.BufferAttribute;

  private readonly geometry: THREE.BufferGeometry;
  private cursor = 0;
  private count = 0;
  private lastX = 0;
  private lastZ = 0;
  private lastAlong = 0;
  private hasLast = false;
  private time = 0;
  private dirty = true;

  constructor() {
    const geometry = new THREE.BufferGeometry();
    this.geometry = geometry;

    const dyn = THREE.DynamicDrawUsage;
    this.attrPos = new THREE.BufferAttribute(this.aPos, 3).setUsage(dyn);
    this.attrPerp = new THREE.BufferAttribute(this.aPerp, 2).setUsage(dyn);
    this.attrSide = new THREE.BufferAttribute(this.aSide, 1).setUsage(dyn);
    this.attrBirth = new THREE.BufferAttribute(this.aBirth, 1).setUsage(dyn);
    this.attrInten = new THREE.BufferAttribute(this.aInten, 1).setUsage(dyn);
    this.attrAlong = new THREE.BufferAttribute(this.aAlong, 1).setUsage(dyn);
    // dead slots: birth far in the past -> shader alpha 0
    this.aBirth.fill(-1e9);
    geometry.setAttribute('position', this.attrPos);
    geometry.setAttribute('aPerp', this.attrPerp);
    geometry.setAttribute('aSide', this.attrSide);
    geometry.setAttribute('aBirth', this.attrBirth);
    geometry.setAttribute('aIntensity', this.attrInten);
    geometry.setAttribute('aAlong', this.attrAlong);

    // static strip indices over the ordered (oldest -> newest) vertex pairs
    const indices: number[] = [];
    for (let i = 0; i < MAX_POINTS - 1; i++) {
      const v = i * 2;
      indices.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
    }
    geometry.setIndex(indices);
    geometry.setDrawRange(0, 0);

    this.uniforms = {
      uTime: { value: 0 },
      uLife: { value: 6.0 },
      uWidth0: { value: 1.0 },
      uSpread: { value: 0.16 },
      uWidthMin: { value: 1.7 },
      uWidthMax: { value: 2.8 },
      uLift: { value: 0.14 },
      uHeadAlong: { value: 0 },
      uStamp: { value: 2.4 },
      uFps: { value: 6.0 },
      uGapW: { value: 0.45 },
      uGapL: { value: 1.8 },
      uLaceScale: { value: 1.8 },
      uColorFoam: { value: new THREE.Color(PALETTE.foam) },
      uColorWash: {
        value: new THREE.Color(PALETTE.foam).lerp(new THREE.Color(PALETTE.waterCrest), 0.32),
      },
      uColorAged: {
        value: new THREE.Color(PALETTE.foam).lerp(new THREE.Color(PALETTE.waterMid), 0.48),
      },
    };

    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    this.object = mesh;
  }

  push(pos: THREE.Vector3, dirX: number, dirZ: number, intensity: number): void {
    const dx = pos.x - this.lastX;
    const dz = pos.z - this.lastZ;
    if (this.hasLast) {
      const d2 = dx * dx + dz * dz;
      if (d2 < MIN_SPACING * MIN_SPACING) return; // too soon, keep last deposit
      if (d2 > TELEPORT_DIST * TELEPORT_DIST) this.clear(); // respawn: no streak
    }
    const i = this.cursor;
    const dist = this.hasLast ? Math.sqrt(dx * dx + dz * dz) : 0;
    this.lastAlong += dist;

    this.cx[i] = pos.x;
    this.cz[i] = pos.z;
    // lateral = perpendicular of the boat forward dir (V-spread direction)
    this.px[i] = -dirZ;
    this.pz[i] = dirX;
    this.birth[i] = this.time;
    this.inten[i] = Math.min(1, Math.max(0, intensity));
    this.along[i] = this.lastAlong;

    this.cursor = (this.cursor + 1) % MAX_POINTS;
    if (this.count < MAX_POINTS) this.count++;
    this.lastX = pos.x;
    this.lastZ = pos.z;
    this.hasLast = true;
    this.dirty = true;
  }

  update(dt: number, t: number): void {
    void dt; // age is driven by absolute time (aBirth), not integration
    this.time = t;
    this.uniforms.uTime.value = t;
    this.uniforms.uHeadAlong.value = this.lastAlong;
    if (!this.dirty) return;
    this.dirty = false;

    // rewrite the strip oldest -> newest from the ring, in place
    const n = this.count;
    for (let i = 0; i < n; i++) {
      const slot = (this.cursor - n + i + MAX_POINTS) % MAX_POINTS;
      const v = i * 2;
      this.aPos[v * 3] = this.cx[slot];
      this.aPos[v * 3 + 1] = 0;
      this.aPos[v * 3 + 2] = this.cz[slot];
      this.aPos[v * 3 + 3] = this.cx[slot];
      this.aPos[v * 3 + 4] = 0;
      this.aPos[v * 3 + 5] = this.cz[slot];
      this.aPerp[v * 2] = this.px[slot];
      this.aPerp[v * 2 + 1] = this.pz[slot];
      this.aPerp[v * 2 + 2] = this.px[slot];
      this.aPerp[v * 2 + 3] = this.pz[slot];
      this.aSide[v] = -1;
      this.aSide[v + 1] = 1;
      this.aBirth[v] = this.birth[slot];
      this.aBirth[v + 1] = this.birth[slot];
      this.aInten[v] = this.inten[slot];
      this.aInten[v + 1] = this.inten[slot];
      this.aAlong[v] = this.along[slot];
      this.aAlong[v + 1] = this.along[slot];
    }
    this.attrPos.needsUpdate = true;
    this.attrPerp.needsUpdate = true;
    this.attrSide.needsUpdate = true;
    this.attrBirth.needsUpdate = true;
    this.attrInten.needsUpdate = true;
    this.attrAlong.needsUpdate = true;
    this.geometry.setDrawRange(0, n >= 2 ? (n - 1) * 6 : 0);
  }

  clear(): void {
    this.count = 0;
    this.cursor = 0;
    this.hasLast = false;
    this.lastAlong = 0;
    this.dirty = true;
  }
}
