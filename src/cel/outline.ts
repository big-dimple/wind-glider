/**
 * outline.ts — inverted-hull ink outlines.
 *
 * Every Mesh in the target subtree gets a BackSide child mesh that shares
 * the geometry but pushes vertices along SMOOTHED normals (hard-edged
 * procedural geometry would otherwise split the hull open along seams).
 *
 * The push distance grows linearly with camera distance, which cancels
 * perspective shrink — the ink line keeps a constant SCREEN-space width:
 * never fat up close, never vanishing far away.
 *
 * Outlines render in the main pass only. They stay OFF LAYER_INK (default
 * layer 0 exclusively) so the normal/depth prepass never sees them: the
 * prepass override material would flatten the BackSide hull, and the Sobel
 * pass would double-detect silhouettes the hull already owns.
 */
import * as THREE from 'three';
import { PALETTE } from '../core/palette';
import { LAYER_INK } from '../contracts';

export interface OutlineOptions {
  width?: number;
  color?: number;
  minPush?: number;
  maxPush?: number;
  widthFactor?: number;
}

const vertexShader = /* glsl */ `
attribute vec3 aOutlineNormal; // smoothed per-vertex normal (see getOutlineNormals)

uniform float uWidth;       // artist-facing width multiplier
uniform float uWidthFactor; // world-units-per-meter scale (~0.0015)
uniform float uMinPush;     // world-space floor: the line never thins to nothing
uniform float uMaxPush;     // world-space ceiling: distant objects don't blow up

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  // mat3(modelMatrix) assumes uniform scale (true for all meshes here).
  vec3 worldNormal = normalize(mat3(modelMatrix) * aOutlineNormal);
  // Offset proportional to camera distance => constant screen-space width,
  // clamped between minPush (close-ups) and maxPush (far vista).
  float dist = distance(worldPos.xyz, cameraPosition);
  float push = clamp(uWidth * uWidthFactor * dist, uMinPush, uMaxPush);
  worldPos.xyz += worldNormal * push;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const fragmentShader = /* glsl */ `
uniform vec3 uColor;

void main() {
  gl_FragColor = vec4(uColor, 1.0);
}
`;

/** One material per (width, color, minPush, maxPush, widthFactor) combo — shared by every hull with that look. */
const materialCache = new Map<string, THREE.ShaderMaterial>();

function getOutlineMaterial(
  width: number,
  color: number,
  minPush: number = 0.003,
  maxPush: number = 0.06,
  widthFactor: number = 0.0015,
): THREE.ShaderMaterial {
  const key = `${width}|${color}|${minPush}|${maxPush}|${widthFactor}`;
  let mat = materialCache.get(key);
  if (mat === undefined) {
    mat = new THREE.ShaderMaterial({
      name: 'CelOutline',
      uniforms: {
        uColor: { value: new THREE.Color().setHex(color, THREE.NoColorSpace) },
        uWidth: { value: width },
        uWidthFactor: { value: widthFactor },
        uMinPush: { value: minPush },
        uMaxPush: { value: maxPush },
      },
      vertexShader,
      fragmentShader,
      side: THREE.BackSide, // the inverted hull
      // Nudge the hull toward the camera in depth so the base mesh never
      // eats slivers of the line at grazing angles (the "dashed" look).
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    materialCache.set(key, mat);
  }
  return mat;
}

/**
 * Smoothed-normal cache, one entry per geometry. Procedural geometry here is
 * hard-edged (per-face normals), which would split an inverted hull along
 * every seam — so the outline expands along position-keyed AVERAGED normals
 * instead. Stored as an extra `aOutlineNormal` attribute on the shared
 * geometry; materials that don't declare it simply ignore it.
 */
const normalCache = new WeakMap<THREE.BufferGeometry, THREE.BufferAttribute>();

function getOutlineNormals(geometry: THREE.BufferGeometry): THREE.BufferAttribute | null {
  const cached = normalCache.get(geometry);
  if (cached !== undefined) return cached;

  const pos = geometry.attributes.position as THREE.BufferAttribute | undefined;
  if (pos === undefined) return null;
  const count = pos.count;
  const nrm = geometry.attributes.normal as THREE.BufferAttribute | undefined;
  const index = geometry.index;

  // Accumulate normals into buckets keyed by quantized position: vertices
  // duplicated for hard edges share a bucket, so their normals average out.
  // Math.round quantization (not toFixed) so mirror-pair verts that differ
  // only by float noise or negative zero still land in the same bucket.
  const buckets = new Map<string, THREE.Vector3>();
  const keyOf = (i: number): string =>
    `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
  const scratch = new THREE.Vector3();
  const addTo = (i: number, x: number, y: number, z: number): void => {
    const key = keyOf(i);
    let acc = buckets.get(key);
    if (acc === undefined) {
      acc = new THREE.Vector3();
      buckets.set(key, acc);
    }
    acc.x += x; acc.y += y; acc.z += z;
  };

  if (nrm !== undefined) {
    // Easy path: sum the (possibly duplicated) vertex normals per position.
    for (let i = 0; i < count; i++) addTo(i, nrm.getX(i), nrm.getY(i), nrm.getZ(i));
  } else {
    // No normal attribute: accumulate per-face normals per corner position.
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const cb = new THREE.Vector3();
    const triCount = index !== null ? index.count : count;
    for (let t = 0; t < triCount; t += 3) {
      const i0 = index !== null ? index.getX(t) : t;
      const i1 = index !== null ? index.getX(t + 1) : t + 1;
      const i2 = index !== null ? index.getX(t + 2) : t + 2;
      a.fromBufferAttribute(pos, i0);
      b.fromBufferAttribute(pos, i1);
      c.fromBufferAttribute(pos, i2);
      ab.subVectors(b, a);
      cb.subVectors(b, c);
      scratch.crossVectors(cb, ab); // area-weighted face normal
      addTo(i0, scratch.x, scratch.y, scratch.z);
      addTo(i1, scratch.x, scratch.y, scratch.z);
      addTo(i2, scratch.x, scratch.y, scratch.z);
    }
  }

  // Write the normalized per-position average back per vertex.
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const acc = buckets.get(keyOf(i));
    if (acc !== undefined && acc.lengthSq() > 1e-12) {
      scratch.copy(acc).normalize();
    } else {
      scratch.set(0, 1, 0); // degenerate: any direction will do
    }
    out[i * 3] = scratch.x;
    out[i * 3 + 1] = scratch.y;
    out[i * 3 + 2] = scratch.z;
  }

  const attr = new THREE.BufferAttribute(out, 3);
  attr.setUsage(THREE.StaticDrawUsage);
  geometry.setAttribute('aOutlineNormal', attr);
  normalCache.set(geometry, attr);
  return attr;
}

/**
 * Add constant-screen-width inverted-hull outlines to every Mesh in the
 * subtree. Skips objects named 'no-outline' and anything with
 * userData.noOutline. Returns `target` for chaining. Call ONCE per tree,
 * after it is fully built (safe to call before or after markInk — the
 * outline children refuse the ink layer either way).
 */
export function addOutline(target: THREE.Object3D, opts: OutlineOptions = {}): THREE.Object3D {
  const width = opts.width ?? 1.0;
  const color = opts.color ?? PALETTE.ink;
  const minPush = opts.minPush ?? 0.003;
  const maxPush = opts.maxPush ?? 0.06;
  const widthFactor = opts.widthFactor ?? 0.0015;
  const material = getOutlineMaterial(width, color, minPush, maxPush, widthFactor);

  // Collect first: we are about to mutate the subtree.
  const meshes: THREE.Mesh[] = [];
  target.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.name === 'no-outline') return;
    if (mesh.userData.noOutline === true) return;
    meshes.push(mesh);
  });

  for (const mesh of meshes) {
    const geometry = mesh.geometry as THREE.BufferGeometry;
    if (getOutlineNormals(geometry) === null) continue;

    // Child of the mesh: inherits its full transform (position/rotation/
    // scale and any later animation) while sharing its geometry.
    const outline = new THREE.Mesh(geometry, material);
    outline.name = 'outline';
    outline.userData.noOutline = true;
    outline.raycast = () => {}; // hulls are visual only; never eat gameplay raycasts

    // Default layer 0 ONLY — and refuse the ink layer even if markInk()
    // runs over this subtree afterwards (see header).
    outline.layers.set(0);
    const enableLayer = outline.layers.enable.bind(outline.layers);
    outline.layers.enable = (layer: number): void => {
      if (layer !== LAYER_INK) enableLayer(layer);
    };

    mesh.add(outline);
  }

  return target;
}
