import * as THREE from 'three';
import { SMOKE } from '../ui/gfx';

/**
 * The smoke a blast leaves behind.
 *
 * Particles (fx/Particles) are the *event*: fire, grit and splinters thrown out
 * in the first half-second. They are point sprites, they are gone almost at
 * once, and nothing about them says anything happened here. Smoke is the
 * aftermath -- it hangs, it climbs, it drifts downwind and it thins out over
 * several seconds, so a grenade that went off in the street is still readable
 * from across the field long after the noise.
 *
 * Drawn as camera-facing textured quads, which is the standard way to fake a
 * volume: a handful of big soft billboards at different depths and rotations
 * read as one cloud far more cheaply than any number of small opaque puffs. The
 * texture is a flipbook (`ui/gfx` SMOKE) whose own frames boil and thin as they
 * play, so the dissipation is in the art rather than in a fade we have to
 * invent; each puff plays the sequence once across its life, and consecutive
 * frames are cross-faded in the shader so a puff living six seconds doesn't
 * play at a visible seven frames a second.
 *
 * Everything is one instanced draw call. Puffs live in flat arrays and a dead
 * one is swapped with the last live one, exactly as the particle pool works.
 */

/**
 * Puffs alive at once. A blast spends about eighteen of them, so this is room
 * for a dozen-odd overlapping explosions before the newest one starts going
 * unspawned -- more than a fight ever stacks up in one place.
 */
const MAX_PUFFS = 256;

const { cols: COLS, rows: ROWS, frames: FRAMES } = SMOKE.thin;

/**
 * Blocks/sec^2 of lift. Smoke is hot and it climbs, and the climb is what
 * separates it from dust: a cloud that only spreads reads as debris settling.
 */
const BUOYANCY = 0.85;

/**
 * The prevailing wind, matched to the one the paddy leans into (fx/Rice), and
 * how hard it pushes in blocks/sec^2. Small on purpose -- the point is that a
 * cloud left standing slowly leaves the place it was made, not that it is blown
 * off the map.
 */
const WIND_X = 0.82;
const WIND_Z = 0.57;
const WIND_PUSH = 0.55;

/**
 * Smoke cools as it thins: whatever tint a puff is born with drifts toward this
 * pale grey, and `COOL` is how far along it gets by the end of its life. A
 * black core that stays black to the last frame reads as a hole in the world.
 */
const COOL_R = 0.62;
const COOL_G = 0.61;
const COOL_B = 0.60;
const COOL = 0.75;

const VERT = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>
  attribute vec3 aOffset;
  attribute vec3 aTint;
  attribute float aScale;
  attribute float aRot;
  attribute float aAlpha;
  attribute float aFrame;
  varying vec2 vUvA;
  varying vec2 vUvB;
  varying float vBlend;
  varying float vAlpha;
  varying vec3 vTint;

  // Row 0 of the atlas is the top of the image, and v runs the other way.
  vec2 cellUv( float f ) {
    float col = mod( f, ${COLS}.0 );
    float row = floor( f / ${COLS}.0 );
    return ( uv + vec2( col, ${ROWS}.0 - 1.0 - row ) ) / vec2( ${COLS}.0, ${ROWS}.0 );
  }

  void main() {
    float f0 = floor( aFrame );
    vBlend = aFrame - f0;
    vUvA = cellUv( f0 );
    vUvB = cellUv( min( f0 + 1.0, ${FRAMES}.0 - 1.0 ) );
    vAlpha = aAlpha;
    vTint = aTint;

    // Billboard: the quad's corners are added in view space, so it always
    // faces the camera without anyone having to build a matrix per puff.
    vec4 mvPosition = modelViewMatrix * vec4( aOffset, 1.0 );
    float s = sin( aRot );
    float c = cos( aRot );
    mvPosition.xy += vec2(
      position.x * c - position.y * s,
      position.x * s + position.y * c
    ) * aScale;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const FRAG = /* glsl */ `
  #include <common>
  #include <fog_pars_fragment>
  uniform sampler2D uMap;
  varying vec2 vUvA;
  varying vec2 vUvB;
  varying float vBlend;
  varying float vAlpha;
  varying vec3 vTint;

  void main() {
    vec4 t = mix( texture2D( uMap, vUvA ), texture2D( uMap, vUvB ), vBlend );
    float a = t.a * vAlpha;
    if ( a < 0.004 ) discard;
    // The sprite is grey with its own folds in it; keeping that as a multiplier
    // is what stops a tinted puff going flat.
    gl_FragColor = vec4( vTint * min( 1.0, t.r * 1.35 ), a );
    #include <fog_fragment>
  }
`;

export class SmokeSystem {
  readonly mesh: THREE.Mesh;

  /** Attribute buffers, written straight by the simulation. */
  private readonly offset = new Float32Array(MAX_PUFFS * 3);
  private readonly tint = new Float32Array(MAX_PUFFS * 3);
  private readonly scale = new Float32Array(MAX_PUFFS);
  private readonly rot = new Float32Array(MAX_PUFFS);
  private readonly alpha = new Float32Array(MAX_PUFFS);
  private readonly frame = new Float32Array(MAX_PUFFS);

  /** Simulation state that never reaches the GPU. */
  private readonly vel = new Float32Array(MAX_PUFFS * 3);
  private readonly born = new Float32Array(MAX_PUFFS * 3);
  private readonly grow = new Float32Array(MAX_PUFFS);
  private readonly spin = new Float32Array(MAX_PUFFS);
  private readonly drag = new Float32Array(MAX_PUFFS);
  private readonly base = new Float32Array(MAX_PUFFS);
  private readonly age = new Float32Array(MAX_PUFFS);
  private readonly life = new Float32Array(MAX_PUFFS);

  private count = 0;

  private readonly geom: THREE.InstancedBufferGeometry;
  private readonly attrs: THREE.InstancedBufferAttribute[];

  constructor() {
    // A unit quad; `aScale` is its width in blocks.
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geom = new THREE.InstancedBufferGeometry();
    this.geom.index = quad.index;
    this.geom.setAttribute('position', quad.getAttribute('position'));
    this.geom.setAttribute('uv', quad.getAttribute('uv'));
    this.geom.instanceCount = 0;

    const offsetAttr = new THREE.InstancedBufferAttribute(this.offset, 3);
    const tintAttr = new THREE.InstancedBufferAttribute(this.tint, 3);
    const scaleAttr = new THREE.InstancedBufferAttribute(this.scale, 1);
    const rotAttr = new THREE.InstancedBufferAttribute(this.rot, 1);
    const alphaAttr = new THREE.InstancedBufferAttribute(this.alpha, 1);
    const frameAttr = new THREE.InstancedBufferAttribute(this.frame, 1);
    this.attrs = [offsetAttr, tintAttr, scaleAttr, rotAttr, alphaAttr, frameAttr];
    for (const a of this.attrs) a.setUsage(THREE.DynamicDrawUsage);
    this.geom.setAttribute('aOffset', offsetAttr);
    this.geom.setAttribute('aTint', tintAttr);
    this.geom.setAttribute('aScale', scaleAttr);
    this.geom.setAttribute('aRot', rotAttr);
    this.geom.setAttribute('aAlpha', alphaAttr);
    this.geom.setAttribute('aFrame', frameAttr);

    const mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { uMap: { value: null } },
      ]),
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
    });

    // Loaded async, like the particle sprite: until it lands three binds a 1x1
    // white texture, which draws nothing worth looking at but costs nothing
    // either, and the first blast after it arrives is correct.
    new THREE.TextureLoader().load(SMOKE.thin.url, (map) => {
      map.colorSpace = THREE.SRGBColorSpace;
      // No mips: a mip of an atlas blends neighbouring cells together, and a
      // puff would pick up the frame next to it as it went off into the fog.
      map.generateMipmaps = false;
      map.minFilter = THREE.LinearFilter;
      map.wrapS = THREE.ClampToEdgeWrapping;
      map.wrapT = THREE.ClampToEdgeWrapping;
      mat.uniforms.uMap.value = map;
      mat.needsUpdate = true;
    });

    this.mesh = new THREE.Mesh(this.geom, mat);
    this.mesh.frustumCulled = false;
    // Behind the particles: the sparks a blast throws are in front of its
    // smoke, never lost inside it.
    this.mesh.renderOrder = 4;
    this.mesh.name = 'smoke';
  }

  get activeCount(): number {
    return this.count;
  }

  /**
   * One puff. `size` is its width in blocks at birth and `grow` how many blocks
   * a second it widens by; `drag` bleeds off whatever it was thrown with.
   */
  puff(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    size: number, grow: number, life: number,
    r: number, g: number, b: number,
    alpha: number, drag: number,
  ): void {
    if (this.count >= MAX_PUFFS) return;
    const i = this.count++;
    const i3 = i * 3;
    this.offset[i3] = x; this.offset[i3 + 1] = y; this.offset[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.born[i3] = r; this.born[i3 + 1] = g; this.born[i3 + 2] = b;
    this.tint[i3] = r; this.tint[i3 + 1] = g; this.tint[i3 + 2] = b;
    this.scale[i] = size;
    this.grow[i] = grow;
    this.rot[i] = Math.random() * Math.PI * 2;
    this.spin[i] = (Math.random() - 0.5) * 0.7;
    this.drag[i] = drag;
    this.base[i] = alpha;
    this.alpha[i] = 0;
    this.frame[i] = 0;
    this.age[i] = 0;
    this.life[i] = life;
  }

  /**
   * The cloud an explosion leaves, in three layers.
   *
   * A blast is not one puff: there is a dark heart where the charge was, a ring
   * of it shoved outward along the ground, and a column that keeps going up
   * after the rest has stopped moving. Building it that way is what makes the
   * cloud read as having a shape instead of a radius -- and the column is the
   * part that is still visible from the far side of the field, which is the
   * whole reason a mortar in the village is worth knowing about.
   */
  blast(x: number, y: number, z: number, radius: number): void {
    // The dark heart. Dense, overlapping, and the first thing to go.
    for (let i = 0; i < 5; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = radius * 0.2 * Math.random();
      this.puff(
        x + Math.cos(a) * d, y + (Math.random() - 0.3) * radius * 0.25, z + Math.sin(a) * d,
        (Math.random() - 0.5) * 3, 1.5 + Math.random() * 2, (Math.random() - 0.5) * 3,
        radius * (0.6 + Math.random() * 0.25), radius * 0.28,
        2.8 + Math.random() * 0.8,
        0.24, 0.22, 0.21,
        0.95, 2.2,
      );
    }

    // Thrown outward. This is the bulk of the cloud and most of its lifetime.
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + Math.random() * 0.6;
      const d = radius * (0.35 + Math.random() * 0.3);
      const s = 2.5 + Math.random() * 3;
      this.puff(
        x + Math.cos(a) * d, y + Math.random() * radius * 0.4, z + Math.sin(a) * d,
        Math.cos(a) * s, 0.6 + Math.random() * 1.6, Math.sin(a) * s,
        radius * (0.45 + Math.random() * 0.2), radius * 0.26,
        4 + Math.random() * 1.6,
        0.38, 0.36, 0.34,
        0.8, 1.8,
      );
    }

    // The column, which outlives everything else and marks the spot.
    for (let i = 0; i < 4; i++) {
      this.puff(
        x + (Math.random() - 0.5) * radius * 0.5,
        y + radius * (0.25 + i * 0.2),
        z + (Math.random() - 0.5) * radius * 0.5,
        (Math.random() - 0.5) * 2, 2 + Math.random() * 2.5, (Math.random() - 0.5) * 2,
        radius * (0.4 + Math.random() * 0.2), radius * 0.28,
        5.5 + Math.random() * 2.5,
        0.48, 0.46, 0.44,
        0.5, 1.2,
      );
    }
  }

  update(dt: number): void {
    const step = Math.min(dt, 0.05);
    for (let i = 0; i < this.count;) {
      this.age[i] += step;
      const t = this.age[i] / this.life[i];
      if (t >= 1) {
        this.swapRemove(i);
        continue;
      }

      const i3 = i * 3;
      const damp = 1 - Math.min(0.9, this.drag[i] * step);
      this.vel[i3] = this.vel[i3] * damp + WIND_X * WIND_PUSH * step;
      this.vel[i3 + 1] = this.vel[i3 + 1] * damp + BUOYANCY * step;
      this.vel[i3 + 2] = this.vel[i3 + 2] * damp + WIND_Z * WIND_PUSH * step;
      this.offset[i3] += this.vel[i3] * step;
      this.offset[i3 + 1] += this.vel[i3 + 1] * step;
      this.offset[i3 + 2] += this.vel[i3 + 2] * step;

      this.scale[i] += this.grow[i] * step;
      this.rot[i] += this.spin[i] * step;

      // The flipbook thins the puff out on its own; these two only take the
      // edge off the frame it pops in on and guarantee it reaches zero.
      this.alpha[i] = this.base[i] * Math.min(1, this.age[i] * 8) * Math.min(1, (1 - t) * 4);
      this.frame[i] = t * (FRAMES - 1);

      const cool = t * COOL;
      this.tint[i3] = this.born[i3] + (COOL_R - this.born[i3]) * cool;
      this.tint[i3 + 1] = this.born[i3 + 1] + (COOL_G - this.born[i3 + 1]) * cool;
      this.tint[i3 + 2] = this.born[i3 + 2] + (COOL_B - this.born[i3 + 2]) * cool;
      i++;
    }

    const n = this.count;
    this.geom.instanceCount = n;
    if (n > 0) {
      for (const a of this.attrs) {
        a.updateRanges = [{ start: 0, count: n * a.itemSize }];
        a.needsUpdate = true;
      }
    }
  }

  clear(): void {
    this.count = 0;
    this.geom.instanceCount = 0;
  }

  private swapRemove(i: number): void {
    const last = --this.count;
    if (i === last) return;
    const i3 = i * 3, l3 = last * 3;
    for (let k = 0; k < 3; k++) {
      this.offset[i3 + k] = this.offset[l3 + k];
      this.tint[i3 + k] = this.tint[l3 + k];
      this.vel[i3 + k] = this.vel[l3 + k];
      this.born[i3 + k] = this.born[l3 + k];
    }
    this.scale[i] = this.scale[last];
    this.rot[i] = this.rot[last];
    this.alpha[i] = this.alpha[last];
    this.frame[i] = this.frame[last];
    this.grow[i] = this.grow[last];
    this.spin[i] = this.spin[last];
    this.drag[i] = this.drag[last];
    this.base[i] = this.base[last];
    this.age[i] = this.age[last];
    this.life[i] = this.life[last];
  }
}
