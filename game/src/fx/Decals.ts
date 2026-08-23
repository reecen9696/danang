import * as THREE from 'three';
import { WORLD_X, WORLD_Z } from '../core/constants';
import type { VoxelWorld } from '../voxel/VoxelWorld';

const STAGES = 4;
const MAX_PER_STAGE = 512;

/**
 * Damage fraction at which each crack stage kicks in. Back-loaded on purpose:
 * a couple of hits should only chip a block, and the heavy shattered look is
 * reserved for a wall you have really worked on.
 */
const STAGE_THRESHOLDS = [0.12, 0.4, 0.65, 0.85];

/**
 * Crack overlays for damaged voxels.
 *
 * Re-meshing a chunk on every bullet hit would be far too expensive, so damage
 * is shown with instanced crack decals instead: four draw calls total, rebuilt
 * only when the set of damaged voxels actually changes.
 */
export class DecalSystem {
  readonly group = new THREE.Group();

  private readonly meshes: THREE.InstancedMesh[] = [];
  private readonly matrix = new THREE.Matrix4();
  private dirty = true;
  private lastCount = -1;

  constructor(private readonly world: VoxelWorld) {
    this.group.name = 'damage-decals';
    const geom = new THREE.BoxGeometry(1.02, 1.02, 1.02);

    for (let s = 0; s < STAGES; s++) {
      const tex = makeCrackTexture(s);
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        alphaTest: 0.35,
        depthWrite: false,
        fog: true,
        color: 0x1a1410,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      });
      const mesh = new THREE.InstancedMesh(geom, mat, MAX_PER_STAGE);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.renderOrder = 2;
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
  }

  markDirty(): void {
    this.dirty = true;
  }

  update(): void {
    // Cheap change detection: the set size is enough to catch adds/removes, and
    // we force a rebuild on explicit damage events.
    if (!this.dirty && this.world.damagedVoxels.size === this.lastCount) return;
    this.dirty = false;
    this.lastCount = this.world.damagedVoxels.size;

    const counts = [0, 0, 0, 0];

    for (const idx of this.world.damagedVoxels) {
      const x = idx % WORLD_X;
      const rest = (idx / WORLD_X) | 0;
      const z = rest % WORLD_Z;
      const y = (rest / WORLD_Z) | 0;

      const hp = this.world.hp[idx];
      if (hp === 0) continue;
      const max = this.world.maxHpAt(x, y, z);

      // 0 = barely chipped, 3 = about to break.
      const damage = 1 - hp / max;
      if (damage < STAGE_THRESHOLDS[0]) continue;
      let stage = 0;
      while (stage + 1 < STAGES && damage >= STAGE_THRESHOLDS[stage + 1]) stage++;
      if (counts[stage] >= MAX_PER_STAGE) continue;

      this.matrix.makeTranslation(x + 0.5, y + 0.5, z + 0.5);
      this.meshes[stage].setMatrixAt(counts[stage]++, this.matrix);
    }

    for (let s = 0; s < STAGES; s++) {
      this.meshes[s].count = counts[s];
      this.meshes[s].instanceMatrix.needsUpdate = true;
    }
  }

  clear(): void {
    for (const m of this.meshes) m.count = 0;
    this.lastCount = -1;
  }
}

/** Procedural crack texture — no external assets to load. */
function makeCrackTexture(stage: number): THREE.Texture {
  const size = 64;
  // Cracks are rasterised onto a coarse grid so they read as chunky little
  // blocks rather than thin strokes, matching the voxel look of the world.
  const grid = 16;
  const cell = size / grid;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = '#ffffff';

  // Deterministic pseudo-random so every run looks the same.
  let seed = 0x2545f491 + stage * 7919;
  const rand = (): number => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return ((seed >>> 0) % 10000) / 10000;
  };

  const filled = new Uint8Array(grid * grid);
  const put = (gx: number, gy: number): void => {
    if (gx < 0 || gy < 0 || gx >= grid || gy >= grid) return;
    filled[gy * grid + gx] = 1;
  };

  // Every branch starts at the impact point and radiates outward, so the
  // damage reads as a single hit rather than scattered noise.
  const branches = 1 + stage * 2;
  const segments = 1 + stage;
  for (let b = 0; b < branches; b++) {
    let x = grid * 0.5 + (rand() - 0.5) * 1.5;
    let y = grid * 0.5 + (rand() - 0.5) * 1.5;
    let angle = (b / branches) * Math.PI * 2 + (rand() - 0.5) * 0.9;
    for (let s = 0; s < segments; s++) {
      angle += (rand() - 0.5) * 1.0;
      const len = 1.4 + rand() * 1.4;
      const nx = x + Math.cos(angle) * len;
      const ny = y + Math.sin(angle) * len;

      // Step along the segment in sub-cell increments and stamp every grid
      // square the line passes through, so the run of blocks stays connected.
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(nx - x), Math.abs(ny - y)) * 2));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const gx = Math.floor(x + (nx - x) * t);
        const gy = Math.floor(y + (ny - y) * t);
        put(gx, gy);
        // Later stages occasionally spread into a neighbouring block so the
        // damage looks heavier without the crack thickening into a solid slab.
        if (stage >= 2 && rand() < 0.12) put(gx + (rand() < 0.5 ? 1 : -1), gy);
        if (stage >= 3 && rand() < 0.12) put(gx, gy + (rand() < 0.5 ? 1 : -1));
      }
      x = nx;
      y = ny;
    }
  }

  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      if (filled[gy * grid + gx]) ctx.fillRect(gx * cell, gy * cell, cell, cell);
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  // Nearest magnification keeps the block edges hard instead of smearing them.
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  return tex;
}
