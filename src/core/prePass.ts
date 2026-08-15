/**
 * prePass.ts — screen-space normals + depth of "ink solid" objects.
 *
 * Renders only LAYER_INK objects (boats, riders, gates, buoys) with an
 * override normal material into an RT with an attached depth texture.
 * Two consumers:
 *   - cel/edgePass.ts (Sobel): interior ink lines from normal+depth discontinuity
 *   - water/ocean.ts: depth-difference mask → foam ring around hulls
 *
 * The prepass camera is the main camera with layers masked to LAYER_INK,
 * so both consumers can sample with plain gl_FragCoord / resolution UVs.
 */
import * as THREE from 'three';
import { LAYER_INK } from '../contracts';

export class PrePass {
  readonly target: THREE.WebGLRenderTarget;
  /** View-space normals, RGB. */
  get normalTexture(): THREE.Texture {
    return this.target.texture;
  }
  /** Scene depth (ink solids only), sampled as float 0..1. */
  get depthTexture(): THREE.DepthTexture {
    return this.target.depthTexture!;
  }

  private readonly normalMat = new THREE.MeshNormalMaterial();

  constructor(width: number, height: number) {
    const depthTexture = new THREE.DepthTexture(width, height, THREE.UnsignedIntType);
    this.target = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthTexture,
      depthBuffer: true,
      stencilBuffer: false,
    });
  }

  setSize(width: number, height: number): void {
    this.target.setSize(Math.max(1, Math.floor(width)), Math.max(1, Math.floor(height)));
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    const prevTarget = renderer.getRenderTarget();
    const prevMask = camera.layers.mask;
    const prevOverride = scene.overrideMaterial;
    const prevBg = scene.background;

    camera.layers.set(LAYER_INK);
    scene.overrideMaterial = this.normalMat;
    scene.background = null;

    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, camera);

    camera.layers.mask = prevMask;
    scene.overrideMaterial = prevOverride;
    scene.background = prevBg;
    renderer.setRenderTarget(prevTarget);
  }
}
