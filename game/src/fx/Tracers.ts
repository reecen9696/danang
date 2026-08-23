import * as THREE from 'three';

const MAX_TRACERS = 512;

/**
 * Bullet tracers as one pooled LineSegments draw call.
 * Each tracer is a short bright streak that fades over ~0.1s.
 */
export class TracerSystem {
  readonly lines: THREE.LineSegments;

  private readonly positions = new Float32Array(MAX_TRACERS * 6);
  private readonly colors = new Float32Array(MAX_TRACERS * 8); // rgba per vertex
  private readonly life = new Float32Array(MAX_TRACERS);
  private readonly maxLife = new Float32Array(MAX_TRACERS);
  private count = 0;

  private readonly posAttr: THREE.BufferAttribute;
  private readonly colAttr: THREE.BufferAttribute;

  constructor() {
    const geom = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.positions, 3);
    this.colAttr = new THREE.BufferAttribute(this.colors, 4);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute('position', this.posAttr);
    geom.setAttribute('color', this.colAttr);
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(128, 32, 128), 400);

    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });

    this.lines = new THREE.LineSegments(geom, mat);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 6;
  }

  spawn(
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    r = 1, g = 0.92, b = 0.62, life = 0.09,
  ): void {
    if (this.count >= MAX_TRACERS) return;
    const i = this.count++;
    const p = i * 6;
    this.positions[p] = x0; this.positions[p + 1] = y0; this.positions[p + 2] = z0;
    this.positions[p + 3] = x1; this.positions[p + 4] = y1; this.positions[p + 5] = z1;
    const c = i * 8;
    // Tail is dimmer than the head for a sense of direction.
    this.colors[c] = r * 0.25; this.colors[c + 1] = g * 0.25; this.colors[c + 2] = b * 0.25; this.colors[c + 3] = 1;
    this.colors[c + 4] = r; this.colors[c + 5] = g; this.colors[c + 6] = b; this.colors[c + 7] = 1;
    this.life[i] = life;
    this.maxLife[i] = life;
  }

  update(dt: number): void {
    for (let i = 0; i < this.count;) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.swapRemove(i);
        continue;
      }
      const a = this.life[i] / this.maxLife[i];
      const c = i * 8;
      this.colors[c + 3] = a * 0.5;
      this.colors[c + 7] = a;
      i++;
    }

    const n = this.count;
    this.lines.geometry.setDrawRange(0, n * 2);
    if (n > 0) {
      this.posAttr.needsUpdate = true;
      this.colAttr.needsUpdate = true;
    }
  }

  private swapRemove(i: number): void {
    const last = --this.count;
    if (i === last) return;
    this.positions.copyWithin(i * 6, last * 6, last * 6 + 6);
    this.colors.copyWithin(i * 8, last * 8, last * 8 + 8);
    this.life[i] = this.life[last];
    this.maxLife[i] = this.maxLife[last];
  }

  clear(): void {
    this.count = 0;
    this.lines.geometry.setDrawRange(0, 0);
  }
}
