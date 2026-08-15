/**
 * ramp.ts — 1D luminance ramp texture for toon diffuse quantization.
 *
 * THE core of the cel look: the wrapped NdotL (0..1) is used as the U
 * coordinate and the texel value becomes the diffuse light level.
 * NearestFilter + no mipmaps = hard posterized bands, zero interpolation.
 *
 * Color pipeline note: the ramp stores raw bytes and is sampled verbatim
 * (NoColorSpace) — this project does no tone mapping or output conversion,
 * so authored band levels are exactly what hits the screen.
 */
import * as THREE from 'three';

/**
 * Default 4-band luminance levels, dark → lit [0.45, 0.65, 0.85, 1.0].
 * Ghibli watercolor tuning: The darkest band is lifted (0.45) so shadow sides
 * keep their vibrant hue and blend with ambient sky light instead of going dark.
 */
const DEFAULT_LEVELS: readonly number[] = [0.45, 0.65, 0.85, 1.0];

/** Texel count across the ramp. 256 makes band edges land on exact texels. */
const RAMP_WIDTH = 256;

/**
 * Build a 1D toon ramp texture. `levels` are the quantized luminance values
 * (0..1), one per band, darkest first. U = wrapped NdotL.
 */
export function createToonRamp(levels: number[] = [...DEFAULT_LEVELS]): THREE.DataTexture {
  const bands = Math.max(1, levels.length);
  const data = new Uint8Array(RAMP_WIDTH);
  for (let i = 0; i < RAMP_WIDTH; i++) {
    const u = i / (RAMP_WIDTH - 1);
    const band = Math.min(bands - 1, Math.floor(u * bands));
    const level = Math.min(1, Math.max(0, levels[band]));
    data[i] = Math.round(level * 255);
  }

  const tex = new THREE.DataTexture(data, RAMP_WIDTH, 1, THREE.RedFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace; // sampled verbatim — see header note
  tex.needsUpdate = true;
  return tex;
}
