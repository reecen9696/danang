import * as THREE from 'three';
import { TEX } from '../ui/gfx';
import { ACE_FOG_APPLY, ACE_FOG_FUNCTION } from '../core/fog';

const MAX_PARTICLES = 8000;

const VERT = /* glsl */ `
  attribute float aSize;
  attribute vec4 aColor;
  varying vec4 vColor;
  uniform float uScale;
  #ifdef USE_FOG
    varying vec3 vFogOfs;
  #endif
  void main() {
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = max(1.0, aSize * uScale / max(0.001, -mv.z));
    #ifdef USE_FOG
      // Rotate the view-space offset back into world space; see fog.ts.
      vFogOfs = mv.xyz * mat3(viewMatrix);
    #endif
  }
`;

const FRAG = /* glsl */ `
  varying vec4 vColor;
  uniform sampler2D uSprite;
  #ifdef USE_FOG
    uniform vec3 fogColor;
    uniform float fogFar;
    varying vec3 vFogOfs;
    ${ACE_FOG_FUNCTION}
    ${ACE_FOG_APPLY}
  #endif
  void main() {
    if (vColor.a < 0.02) discard;
    // SoftBall.png — the original soft round falloff, so particles read as
    // puffs rather than the hard squares a bare gl_Point gives you.
    float mask = texture2D(uSprite, gl_PointCoord).a;
    if (mask < 0.02) discard;
    gl_FragColor = vec4(vColor.rgb, vColor.a * mask);
    #ifdef USE_FOG
      gl_FragColor.rgb = aceFogApply(gl_FragColor.rgb, vFogOfs, fogColor, fogFar);
    #endif
  }
`;

/**
 * Pooled CPU-simulated particle system rendered as a single draw call.
 *
 * Particles live in flat typed arrays; dead ones are swapped with the last
 * live particle so the active range stays contiguous and we only upload the
 * portion that's actually in use.
 */
export class ParticleSystem {
  readonly points: THREE.Points;

  private readonly positions = new Float32Array(MAX_PARTICLES * 3);
  private readonly velocities = new Float32Array(MAX_PARTICLES * 3);
  private readonly colors = new Float32Array(MAX_PARTICLES * 4);
  private readonly baseAlpha = new Float32Array(MAX_PARTICLES);
  private readonly sizes = new Float32Array(MAX_PARTICLES);
  private readonly life = new Float32Array(MAX_PARTICLES);
  private readonly maxLife = new Float32Array(MAX_PARTICLES);
  private readonly gravity = new Float32Array(MAX_PARTICLES);
  private readonly drag = new Float32Array(MAX_PARTICLES);
  private readonly bounce = new Uint8Array(MAX_PARTICLES);

  private count = 0;

  private readonly posAttr: THREE.BufferAttribute;
  private readonly colAttr: THREE.BufferAttribute;
  private readonly sizeAttr: THREE.BufferAttribute;

  constructor(private readonly isSolid: (x: number, y: number, z: number) => boolean) {
    const geom = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.positions, 3);
    this.colAttr = new THREE.BufferAttribute(this.colors, 4);
    this.sizeAttr = new THREE.BufferAttribute(this.sizes, 1);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr.setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute('position', this.posAttr);
    geom.setAttribute('aColor', this.colAttr);
    geom.setAttribute('aSize', this.sizeAttr);
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(128, 32, 128), 400);

    const mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { uScale: { value: 500 }, uSprite: { value: null } },
      ]),
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
    });

    // Loaded async; until it arrives uSprite is null and three binds a 1x1
    // white texture, which just reproduces the old square particles.
    new THREE.TextureLoader().load(TEX.softBall, (map) => {
      map.colorSpace = THREE.SRGBColorSpace;
      mat.uniforms.uSprite.value = map;
      mat.needsUpdate = true;
    });

    this.points = new THREE.Points(geom, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  setViewportScale(heightPx: number): void {
    (this.points.material as THREE.ShaderMaterial).uniforms.uScale.value = heightPx * 0.9;
  }

  get activeCount(): number {
    return this.count;
  }

  spawn(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    r: number, g: number, b: number, a: number,
    size: number, life: number,
    gravity = 22, drag = 0.6, bounce = false,
  ): void {
    if (this.count >= MAX_PARTICLES) return;
    const i = this.count++;
    const i3 = i * 3;
    const i4 = i * 4;
    this.positions[i3] = x; this.positions[i3 + 1] = y; this.positions[i3 + 2] = z;
    this.velocities[i3] = vx; this.velocities[i3 + 1] = vy; this.velocities[i3 + 2] = vz;
    this.colors[i4] = r; this.colors[i4 + 1] = g; this.colors[i4 + 2] = b; this.colors[i4 + 3] = a;
    this.baseAlpha[i] = a;
    this.sizes[i] = size;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.gravity[i] = gravity;
    this.drag[i] = drag;
    this.bounce[i] = bounce ? 1 : 0;
  }

  update(dt: number): void {
    const step = Math.min(dt, 0.05);
    for (let i = 0; i < this.count;) {
      this.life[i] -= step;
      if (this.life[i] <= 0) {
        this.swapRemove(i);
        continue;
      }

      const i3 = i * 3;
      const i4 = i * 4;

      const damp = 1 - Math.min(0.95, this.drag[i] * step);
      this.velocities[i3] *= damp;
      this.velocities[i3 + 2] *= damp;
      this.velocities[i3 + 1] = this.velocities[i3 + 1] * damp - this.gravity[i] * step;

      const nx = this.positions[i3] + this.velocities[i3] * step;
      const ny = this.positions[i3 + 1] + this.velocities[i3 + 1] * step;
      const nz = this.positions[i3 + 2] + this.velocities[i3 + 2] * step;

      if (this.bounce[i] && this.isSolid(Math.floor(nx), Math.floor(ny), Math.floor(nz))) {
        // Cheap per-axis bounce so debris skitters off surfaces.
        if (!this.isSolid(Math.floor(this.positions[i3]), Math.floor(ny), Math.floor(this.positions[i3 + 2]))) {
          this.velocities[i3] *= -0.35;
          this.velocities[i3 + 2] *= -0.35;
        } else {
          this.velocities[i3 + 1] *= -0.32;
          this.velocities[i3] *= 0.7;
          this.velocities[i3 + 2] *= 0.7;
        }
        if (Math.abs(this.velocities[i3 + 1]) < 0.6) this.bounce[i] = 0;
      } else {
        this.positions[i3] = nx;
        this.positions[i3 + 1] = ny;
        this.positions[i3 + 2] = nz;
      }

      // Fade out over the last third of life.
      const t = this.life[i] / this.maxLife[i];
      this.colors[i4 + 3] = this.baseAlpha[i] * Math.min(1, t * 3);
      i++;
    }

    const n = this.count;
    this.points.geometry.setDrawRange(0, n);
    if (n > 0) {
      this.posAttr.updateRanges = [{ start: 0, count: n * 3 }];
      this.colAttr.updateRanges = [{ start: 0, count: n * 4 }];
      this.sizeAttr.updateRanges = [{ start: 0, count: n }];
      this.posAttr.needsUpdate = true;
      this.colAttr.needsUpdate = true;
      this.sizeAttr.needsUpdate = true;
    }
  }

  private swapRemove(i: number): void {
    const last = --this.count;
    if (i === last) return;
    const i3 = i * 3, l3 = last * 3;
    const i4 = i * 4, l4 = last * 4;
    for (let k = 0; k < 3; k++) {
      this.positions[i3 + k] = this.positions[l3 + k];
      this.velocities[i3 + k] = this.velocities[l3 + k];
    }
    for (let k = 0; k < 4; k++) this.colors[i4 + k] = this.colors[l4 + k];
    this.baseAlpha[i] = this.baseAlpha[last];
    this.sizes[i] = this.sizes[last];
    this.life[i] = this.life[last];
    this.maxLife[i] = this.maxLife[last];
    this.gravity[i] = this.gravity[last];
    this.drag[i] = this.drag[last];
    this.bounce[i] = this.bounce[last];
  }

  clear(): void {
    this.count = 0;
    this.points.geometry.setDrawRange(0, 0);
  }
}
