import * as THREE from 'three';

/**
 * The sun rig: one directional light with a shadow map, plus the hemispheric
 * ambient that fills everything it doesn't reach.
 *
 * The world used to be lit entirely by numbers baked into vertex colours -- a
 * fixed brightness per face direction plus corner AO -- which is flat by
 * construction: a wall facing away from the sun looked identical whether it
 * stood in the open or inside a bunker. Real lighting replaces the per-face
 * constant with an actual N.L term and a shadow lookup, so buildings shade
 * themselves, towers throw shadows across the ground, and enemies darken as
 * they run into cover.
 *
 * Two details make it hold together at voxel scale:
 *
 *  - The shadow camera *follows the player*. A single map over the whole
 *    256x256 world would either be too coarse for 1-unit blocks or too
 *    expensive; a tight box around the player keeps the texel density high
 *    (well under one texel per block) and keeps most of the world out of the
 *    shadow pass entirely. Its edge sits far enough out that the fog has
 *    already eaten the transition.
 *  - The box is snapped to whole shadow texels in light space. Without that,
 *    sub-texel movement makes every shadow edge crawl and sparkle as you walk,
 *    which is far more distracting on hard voxel edges than on organic
 *    geometry.
 *
 * Intensities look large because three.js divides by PI on the way through the
 * Lambert BRDF; the comments below give the resulting surface brightness, which
 * is what was actually tuned. Note also that shading happens *before* the sRGB
 * transfer (see core/fog.ts), so these ratios read softer on screen than the
 * raw numbers suggest.
 *
 * The ambient terms are kept on a tight leash. Sun + sky + fill has to land
 * just under 1.0 on a fully lit upward face: any more and every bright surface
 * clips to white at once, which is exactly what "washed out" looks like. The
 * headroom that buys goes into the shadow side instead.
 */

/** Unit vector pointing from the world towards the sun. Late afternoon: ~46°
 * above the horizon, low enough to rake long shadows across the ground. */
export const SUN_TO_LIGHT = new THREE.Vector3(0.42, 0.62, 0.43).normalize();

export const LIGHT = {
  /** Warm direct sun. ~0.53 surface brightness at full N.L. */
  sunColor: 0xfff2d8,
  sunIntensity: 1.66,
  /** Sky ambient: cool, and the dominant term on upward faces (~0.28). */
  skyColor: 0xbcd8f5,
  /** Bounce off the ground: warm, and all a downward face ever gets (~0.16). */
  groundColor: 0x6e6252,
  hemiIntensity: 0.83,
  /** Flat fill so nothing ever bottoms out to pure black (~0.03). */
  fillColor: 0xffffff,
  fillIntensity: 0.095,
  /**
   * How dark a fully shadowed surface goes. Slightly under 1 leaves a little
   * direct light leaking into shadow, which reads as bounce rather than as the
   * sun being switched off.
   */
  shadowStrength: 0.95,
  /**
   * Baked corner AO is contact shading -- physically it belongs to the ambient
   * term. Letting a fraction of it touch direct light as well keeps creases
   * defined when the sun is shining straight into them.
   */
  aoDirectFactor: 0.35,
} as const;

export const enum ShadowQuality {
  Off = 0,
  Low = 1,
  Medium = 2,
  High = 3,
}

interface ShadowPreset {
  readonly label: string;
  readonly mapSize: number;
  /** Half-width of the shadowed box around the player, in blocks. */
  readonly radius: number;
}

export const SHADOW_PRESETS: readonly ShadowPreset[] = [
  { label: 'off', mapSize: 0, radius: 0 },
  { label: 'low', mapSize: 1024, radius: 56 },
  { label: 'medium', mapSize: 2048, radius: 80 },
  { label: 'high', mapSize: 4096, radius: 104 },
];

/**
 * Distance the light is pulled back along its own axis. Only has to clear the
 * tallest geometry; the ortho depth range is linear so being generous is free.
 */
const LIGHT_DISTANCE = 220;

/**
 * Material for a mesh that should cast a shadow but never be drawn: the local
 * player's own body, which needs a shadow on the ground without a torso
 * appearing across the middle of a first-person view.
 *
 * Layers would be the obvious tool, but three.js' shadow pass layer-tests
 * against the *scene* camera rather than the shadow camera, so anything hidden
 * from the player is hidden from the sun as well. Writing neither colour nor
 * depth gets there instead: the main pass runs the draw and discards
 * everything, while the shadow pass -- which substitutes its own depth
 * material -- is unaffected.
 */
export function makeShadowOnlyMaterial(): THREE.Material {
  return new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
}


const ORIGIN = new THREE.Vector3(0, 0, 0);
const UP = new THREE.Vector3(0, 1, 0);
const tmpBasis = new THREE.Matrix4();

export class SunRig {
  /** Everything is parented here so the caller adds one object to the scene. */
  readonly group = new THREE.Group();

  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly fill: THREE.AmbientLight;

  private quality: ShadowQuality = ShadowQuality.Medium;
  private preset = SHADOW_PRESETS[ShadowQuality.Medium];

  /** World -> light-space rotation, and its inverse. Constant: the sun is fixed. */
  private readonly toLightSpace = new THREE.Quaternion();
  private readonly toWorldSpace = new THREE.Quaternion();
  private readonly center = new THREE.Vector3();

  constructor() {
    this.group.name = 'sun-rig';

    this.sun = new THREE.DirectionalLight(LIGHT.sunColor, LIGHT.sunIntensity);
    this.sun.castShadow = true;
    this.sun.shadow.intensity = LIGHT.shadowStrength;
    // Voxel faces are perfectly flat, so a plain depth bias would need to be
    // huge to survive grazing sun angles and would detach shadows from their
    // casters. `normalBias` walks the sample point along the surface normal
    // instead, which is exactly the right fix for axis-aligned geometry.
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.06;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = LIGHT_DISTANCE * 2;

    this.hemi = new THREE.HemisphereLight(LIGHT.skyColor, LIGHT.groundColor, LIGHT.hemiIntensity);
    this.fill = new THREE.AmbientLight(LIGHT.fillColor, LIGHT.fillIntensity);

    this.group.add(this.sun, this.sun.target, this.hemi, this.fill);

    tmpBasis.lookAt(SUN_TO_LIGHT, ORIGIN, UP);
    this.toWorldSpace.setFromRotationMatrix(tmpBasis);
    this.toLightSpace.copy(this.toWorldSpace).invert();

    this.applyPreset();
  }

  get shadowQuality(): ShadowQuality {
    return this.quality;
  }

  get qualityLabel(): string {
    return this.preset.label;
  }

  /** Half-width of the shadowed region, in blocks. 0 when shadows are off. */
  get shadowRadius(): number {
    return this.quality === ShadowQuality.Off ? 0 : this.preset.radius;
  }

  setShadowQuality(q: ShadowQuality): void {
    if (q === this.quality) return;
    this.quality = q;
    this.preset = SHADOW_PRESETS[q];
    this.applyPreset();
  }

  cycleShadowQuality(): ShadowQuality {
    this.setShadowQuality(((this.quality + 1) % SHADOW_PRESETS.length) as ShadowQuality);
    return this.quality;
  }

  private applyPreset(): void {
    const shadow = this.sun.shadow;
    const on = this.quality !== ShadowQuality.Off;
    this.sun.castShadow = on;
    if (!on) return;

    shadow.mapSize.set(this.preset.mapSize, this.preset.mapSize);
    const cam = shadow.camera;
    cam.left = -this.preset.radius;
    cam.right = this.preset.radius;
    cam.top = this.preset.radius;
    cam.bottom = -this.preset.radius;
    cam.updateProjectionMatrix();

    // The render target is allocated lazily from `mapSize`, so the old one has
    // to go for a resolution change to take effect.
    if (shadow.map) {
      shadow.map.dispose();
      shadow.map = null;
    }
  }

  /**
   * Re-centres the shadow box on the player. Call once per frame, before
   * rendering.
   */
  update(focus: THREE.Vector3): void {
    if (this.quality === ShadowQuality.Off) return;

    const texel = (this.preset.radius * 2) / this.preset.mapSize;
    this.center.copy(focus).applyQuaternion(this.toLightSpace);
    // Snapping the two axes that span the shadow map is what stops the edges
    // crawling; depth is snapped too purely for consistency.
    this.center.x = Math.round(this.center.x / texel) * texel;
    this.center.y = Math.round(this.center.y / texel) * texel;
    this.center.z = Math.round(this.center.z / texel) * texel;
    this.center.applyQuaternion(this.toWorldSpace);

    this.sun.target.position.copy(this.center);
    this.sun.position.copy(this.center).addScaledVector(SUN_TO_LIGHT, LIGHT_DISTANCE);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
  }

  dispose(): void {
    this.sun.shadow.dispose();
  }
}

/**
 * Teaches a lit material about the mesher's baked `ao` vertex attribute.
 *
 * three.js' own `aoMap` needs a texture and a second UV set, neither of which a
 * greedy-meshed chunk has, so the AO travels as one byte per vertex and is
 * folded in at the same point in the shader that `aoMap` would have been.
 */
export function useBakedVertexAO(material: THREE.Material): void {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float ao;\nvarying float vBakedAO;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvBakedAO = ao;',
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying float vBakedAO;',
      )
      .replace(
        '#include <aomap_fragment>',
        `reflectedLight.indirectDiffuse *= vBakedAO;
         reflectedLight.directDiffuse *= mix( 1.0, vBakedAO, ${LIGHT.aoDirectFactor.toFixed(3)} );`,
      );
  };
  // Materials are cached by program key; a custom compile hook has to declare
  // its own or it would share a program with an un-patched material.
  material.customProgramCacheKey = () => 'baked-vertex-ao';
}
