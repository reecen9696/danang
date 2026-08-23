import * as THREE from 'three';
import type { VoxelWorld } from '../voxel/VoxelWorld';
import { WORLD_Y } from '../core/constants';

/** Splats alive at once. Oldest are recycled once the pool is full. */
const MAX_SPLATS = 256;
/** Distinct splatter shapes, picked at random per splat. */
const SHAPES = 3;
/** How far above the surface a splat sits, to keep it off the ground plane. */
const LIFT = 0.03;

const VERT = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>
  attribute float aAlpha;
  attribute float aShape;
  varying float vAlpha;
  varying vec2 vUv;
  void main() {
    // Each splat picks one of the shapes stacked side by side in the atlas.
    vUv = vec2((uv.x + aShape) / ${SHAPES}.0, uv.y);
    vAlpha = aAlpha;
    vec4 mvPosition = vec4(position, 1.0);
    #ifdef USE_INSTANCING
      mvPosition = instanceMatrix * mvPosition;
    #endif
    mvPosition = modelViewMatrix * mvPosition;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const FRAG = /* glsl */ `
  #include <common>
  #include <fog_pars_fragment>
  uniform sampler2D uMap;
  uniform vec3 uColor;
  varying float vAlpha;
  varying vec2 vUv;
  void main() {
    float mask = texture2D(uMap, vUv).a;
    float a = mask * vAlpha;
    if (a < 0.02) discard;
    // The thick middle of a pool is darker than its edges.
    gl_FragColor = vec4(uColor * (0.55 + 0.45 * mask), a);
    #include <fog_fragment>
  }
`;

/**
 * Blood on the ground.
 *
 * Every hit throws a little onto the floor and a body leaves a pool where it
 * comes to rest, drawn as flat instanced quads laid on the surface under them
 * — one draw call for the whole battlefield. Splats grow in over a moment
 * rather than popping, and fade out well after the body they came from has
 * gone, so a firefight leaves the ground marked.
 */
export class BloodSystem {
  readonly mesh: THREE.InstancedMesh;

  private readonly alpha = new Float32Array(MAX_SPLATS);
  private readonly age = new Float32Array(MAX_SPLATS);
  private readonly life = new Float32Array(MAX_SPLATS);
  /** Radius the splat eases out to, in blocks. */
  private readonly target = new Float32Array(MAX_SPLATS);
  private readonly radius = new Float32Array(MAX_SPLATS);
  private readonly px = new Float32Array(MAX_SPLATS);
  private readonly py = new Float32Array(MAX_SPLATS);
  private readonly pz = new Float32Array(MAX_SPLATS);
  private readonly spin = new Float32Array(MAX_SPLATS);

  private readonly alphaAttr: THREE.InstancedBufferAttribute;
  private readonly shapeAttr: THREE.InstancedBufferAttribute;

  private count = 0;
  /** Where the next splat goes once the pool is full. */
  private cursor = 0;

  private readonly matrix = new THREE.Matrix4();
  private readonly pos = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(private readonly world: VoxelWorld) {
    // A unit quad laid flat, so an instance's scale is its diameter.
    const geom = new THREE.PlaneGeometry(1, 1);
    geom.rotateX(-Math.PI * 0.5);

    const mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { uMap: { value: null }, uColor: { value: null } },
      ]),
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
      // Sitting flat on a voxel face, a decal needs pulling toward the camera
      // or it fights the ground for the same depth.
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });

    // Assigned after the merge above, which deep-clones anything it's handed.
    mat.uniforms.uMap.value = makeSplatterAtlas();
    mat.uniforms.uColor.value = new THREE.Color(0x6b0a08);

    this.mesh = new THREE.InstancedMesh(geom, mat, MAX_SPLATS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.name = 'blood';

    this.alphaAttr = new THREE.InstancedBufferAttribute(this.alpha, 1);
    this.shapeAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SPLATS), 1);
    this.alphaAttr.setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute('aAlpha', this.alphaAttr);
    geom.setAttribute('aShape', this.shapeAttr);
  }

  /**
   * Lays one splat on the ground under (x, y, z).
   *
   * The surface is found by looking down from the given height, so blood
   * thrown off a bot standing on a roof lands on the roof rather than
   * somewhere under it. Nothing is drawn if there's no floor within reach.
   */
  splat(x: number, y: number, z: number, radius: number, life: number, grow = 0.35): void {
    const groundY = surfaceBelow(this.world, x, y, z, 5);
    if (groundY < 0) return;

    let i: number;
    if (this.count < MAX_SPLATS) {
      i = this.count++;
    } else {
      i = this.cursor;
      this.cursor = (this.cursor + 1) % MAX_SPLATS;
    }

    this.px[i] = x;
    this.py[i] = groundY + LIFT;
    this.pz[i] = z;
    this.target[i] = radius;
    // Small splats land as they are; a pool spreads.
    this.radius[i] = radius * (1 - Math.min(0.9, grow));
    this.age[i] = 0;
    this.life[i] = life;
    this.alpha[i] = 0;
    this.spin[i] = Math.random() * Math.PI * 2;
    this.shapeAttr.array[i] = Math.floor(Math.random() * SHAPES);
    this.shapeAttr.needsUpdate = true;
  }

  /** A body's pool: one wide splat with a ring of smaller ones around it. */
  pool(x: number, y: number, z: number, radius: number, life: number): void {
    this.splat(x, y, z, radius, life, 0.75);
    const ring = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < ring; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = radius * (0.45 + Math.random() * 0.6);
      this.splat(
        x + Math.cos(a) * d, y, z + Math.sin(a) * d,
        radius * (0.3 + Math.random() * 0.45), life * (0.7 + Math.random() * 0.3), 0.6,
      );
    }
  }

  /** Loose spatter thrown off a body that's just been hit. */
  spatter(x: number, y: number, z: number, count: number, spread: number): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.random() * spread;
      this.splat(
        x + Math.cos(a) * d, y, z + Math.sin(a) * d,
        0.22 + Math.random() * 0.4, 16 + Math.random() * 8, 0.3,
      );
    }
  }

  update(dt: number): void {
    for (let i = 0; i < this.count;) {
      this.age[i] += dt;
      const left = this.life[i] - this.age[i];
      if (left <= 0) {
        this.swapRemove(i);
        continue;
      }

      // Spreads out over the first moment, then dries and fades at the end.
      this.radius[i] += (this.target[i] - this.radius[i]) * Math.min(1, dt * 2.2);
      const fadeIn = Math.min(1, this.age[i] * 5);
      const fadeOut = Math.min(1, left / 3);
      this.alpha[i] = 0.92 * fadeIn * fadeOut;

      this.pos.set(this.px[i], this.py[i], this.pz[i]);
      this.quat.setFromAxisAngle(this.up, this.spin[i]);
      this.scale.set(this.radius[i], 1, this.radius[i]);
      this.matrix.compose(this.pos, this.quat, this.scale);
      this.mesh.setMatrixAt(i, this.matrix);
      i++;
    }

    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
  }

  clear(): void {
    this.count = 0;
    this.cursor = 0;
    this.mesh.count = 0;
  }

  private swapRemove(i: number): void {
    const last = --this.count;
    if (i !== last) {
      this.px[i] = this.px[last];
      this.py[i] = this.py[last];
      this.pz[i] = this.pz[last];
      this.alpha[i] = this.alpha[last];
      this.age[i] = this.age[last];
      this.life[i] = this.life[last];
      this.target[i] = this.target[last];
      this.radius[i] = this.radius[last];
      this.spin[i] = this.spin[last];
      this.shapeAttr.array[i] = this.shapeAttr.array[last];
      this.shapeAttr.needsUpdate = true;
    }
    // The cursor indexes a full pool; once we're dropping splats it's stale.
    this.cursor = 0;
  }
}

/**
 * Top face of the first solid voxel at or below (x, y, z), or -1 if there's
 * nothing to land on within `maxDrop` blocks.
 */
function surfaceBelow(
  world: VoxelWorld, x: number, y: number, z: number, maxDrop: number,
): number {
  const fx = Math.floor(x);
  const fz = Math.floor(z);
  const top = Math.min(WORLD_Y - 1, Math.floor(y + 0.5));
  const bottom = Math.max(0, top - maxDrop);
  for (let vy = top; vy >= bottom; vy--) {
    if (world.isSolid(fx, vy, fz)) return vy + 1;
  }
  return -1;
}

/**
 * Procedural splatter shapes, packed side by side into one texture.
 *
 * Each is a ragged blob — a lumpy core with a scatter of droplets around it —
 * so pools don't read as circles, and rotating each instance hides the fact
 * there are only a handful of shapes.
 */
function makeSplatterAtlas(): THREE.Texture {
  const cell = 128;
  const canvas = document.createElement('canvas');
  canvas.width = cell * SHAPES;
  canvas.height = cell;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';

  // Deterministic, so the shapes are the same every run.
  let seed = 0x9e3779b9;
  const rand = (): number => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return ((seed >>> 0) % 10000) / 10000;
  };

  for (let s = 0; s < SHAPES; s++) {
    const ox = s * cell + cell * 0.5;
    const oy = cell * 0.5;

    // Core: a ring of overlapping discs at varying radii, which gives a lumpy
    // outline in a way a single circle never will.
    const lobes = 9 + Math.floor(rand() * 4);
    for (let i = 0; i < lobes; i++) {
      const a = (i / lobes) * Math.PI * 2 + rand() * 0.4;
      const d = cell * (0.06 + rand() * 0.13);
      const r = cell * (0.16 + rand() * 0.1);
      ctx.beginPath();
      ctx.arc(ox + Math.cos(a) * d, oy + Math.sin(a) * d, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Droplets flung clear of the main body.
    const drops = 10 + Math.floor(rand() * 8);
    for (let i = 0; i < drops; i++) {
      const a = rand() * Math.PI * 2;
      const d = cell * (0.26 + rand() * 0.2);
      const r = cell * (0.012 + rand() * 0.035);
      ctx.beginPath();
      ctx.arc(ox + Math.cos(a) * d, oy + Math.sin(a) * d, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  // Shapes sit in one atlas, so nothing may sample across a cell boundary.
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}
