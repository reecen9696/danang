import {
  WORLD_X, WORLD_Y, WORLD_Z, CHUNK, CHUNKS_X, CHUNKS_Y, CHUNKS_Z,
  voxelIndex, inBounds, MATERIALS, Mat,
} from '../core/constants';
import { AIR } from './palette';

/**
 * Flat, typed-array voxel store for the whole map.
 *
 * Three parallel arrays keep the hot path (is this voxel solid?) to a single
 * Uint8 read, while material and HP live alongside for the damage system.
 * Nothing here allocates during gameplay.
 */
export class VoxelWorld {
  /** Palette colour index. 0 == air. */
  readonly blocks = new Uint8Array(WORLD_X * WORLD_Y * WORLD_Z);
  /** Material tier (see Mat). Only meaningful where blocks != 0. */
  readonly mat = new Uint8Array(WORLD_X * WORLD_Y * WORLD_Z);
  /** Remaining hit points of the voxel. */
  readonly hp = new Uint16Array(WORLD_X * WORLD_Y * WORLD_Z);

  /**
   * Height of the highest solid voxel + 1 for every column, maintained
   * incrementally on every edit. Bot navigation reads this every frame, so
   * rescanning columns on demand would be far too slow.
   */
  readonly heights = new Int16Array(WORLD_X * WORLD_Z);
  /** Columns whose height changed since the nav grid last rebuilt. */
  readonly dirtyColumns = new Set<number>();

  /** Chunk indices awaiting a remesh. */
  readonly dirtyChunks = new Set<number>();
  /** Voxels whose HP changed since the last decal sync: index -> nothing. */
  readonly damagedVoxels = new Set<number>();

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------
  get(x: number, y: number, z: number): number {
    if (!inBounds(x, y, z)) return AIR;
    return this.blocks[voxelIndex(x, y, z)];
  }

  isSolid(x: number, y: number, z: number): boolean {
    // Out of bounds is solid on the sides/bottom so players can't leave the map,
    // but open at the top so you can build and jump freely.
    if (y >= WORLD_Y) return false;
    if (x < 0 || z < 0 || y < 0 || x >= WORLD_X || z >= WORLD_Z) return true;
    return this.blocks[(y * WORLD_Z + z) * WORLD_X + x] !== AIR;
  }

  materialAt(x: number, y: number, z: number): number {
    if (!inBounds(x, y, z)) return Mat.Bedrock;
    return this.mat[voxelIndex(x, y, z)];
  }

  hpAt(x: number, y: number, z: number): number {
    if (!inBounds(x, y, z)) return 0;
    return this.hp[voxelIndex(x, y, z)];
  }

  maxHpAt(x: number, y: number, z: number): number {
    return MATERIALS[this.materialAt(x, y, z)].hp;
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------
  /** Places a voxel and marks the affected chunks dirty. */
  set(x: number, y: number, z: number, color: number, material: number): void {
    if (!inBounds(x, y, z)) return;
    const i = voxelIndex(x, y, z);
    this.blocks[i] = color;
    this.mat[i] = material;
    this.hp[i] = MATERIALS[material].hp;
    this.damagedVoxels.delete(i);
    this.raiseHeight(x, y, z);
    this.markDirtyAround(x, y, z);
  }

  /** Silent variant used by world generation, which meshes everything once. */
  setFast(x: number, y: number, z: number, color: number, material: number): void {
    const i = voxelIndex(x, y, z);
    this.blocks[i] = color;
    this.mat[i] = material;
    this.hp[i] = MATERIALS[material].hp;
  }

  remove(x: number, y: number, z: number): boolean {
    if (!inBounds(x, y, z)) return false;
    const i = voxelIndex(x, y, z);
    if (this.blocks[i] === AIR) return false;
    if (MATERIALS[this.mat[i]].indestructible) return false;
    this.blocks[i] = AIR;
    this.hp[i] = 0;
    this.damagedVoxels.delete(i);
    this.lowerHeight(x, y, z);
    this.markDirtyAround(x, y, z);
    return true;
  }

  /**
   * Applies block damage. Returns the amount of HP actually removed, and
   * whether the voxel was destroyed.
   */
  damage(x: number, y: number, z: number, amount: number): { destroyed: boolean; applied: number } {
    if (!inBounds(x, y, z)) return { destroyed: false, applied: 0 };
    const i = voxelIndex(x, y, z);
    if (this.blocks[i] === AIR) return { destroyed: false, applied: 0 };
    const def = MATERIALS[this.mat[i]];
    if (def.indestructible) return { destroyed: false, applied: 0 };

    const scaled = Math.max(1, Math.round(amount * def.resist));
    const before = this.hp[i];
    if (scaled >= before) {
      this.blocks[i] = AIR;
      this.hp[i] = 0;
      this.damagedVoxels.delete(i);
      this.lowerHeight(x, y, z);
      this.markDirtyAround(x, y, z);
      return { destroyed: true, applied: before };
    }
    this.hp[i] = before - scaled;
    this.damagedVoxels.add(i);
    return { destroyed: false, applied: scaled };
  }

  /**
   * One spade swing. Takes off a `1 / digHits` slice of the material's full
   * HP, so a fresh block always breaks in exactly `digHits` swings while a
   * block already softened by gunfire or explosives gives way sooner.
   *
   * Unlike `damage` this skips `resist`: the swing count is read straight off
   * the material rather than falling out of two multipliers.
   */
  dig(x: number, y: number, z: number): { destroyed: boolean; applied: number } {
    if (!inBounds(x, y, z)) return { destroyed: false, applied: 0 };
    const i = voxelIndex(x, y, z);
    if (this.blocks[i] === AIR) return { destroyed: false, applied: 0 };
    const def = MATERIALS[this.mat[i]];
    if (def.indestructible) return { destroyed: false, applied: 0 };

    const bite = Math.max(1, Math.ceil(def.hp / def.digHits));
    const before = this.hp[i];
    if (bite >= before) {
      this.blocks[i] = AIR;
      this.hp[i] = 0;
      this.damagedVoxels.delete(i);
      this.lowerHeight(x, y, z);
      this.markDirtyAround(x, y, z);
      return { destroyed: true, applied: before };
    }
    this.hp[i] = before - bite;
    this.damagedVoxels.add(i);
    return { destroyed: false, applied: bite };
  }

  /** Restores HP during the repair phase. Returns HP actually restored. */
  repair(x: number, y: number, z: number, amount: number): number {
    if (!inBounds(x, y, z)) return 0;
    const i = voxelIndex(x, y, z);
    if (this.blocks[i] === AIR) return 0;
    const max = MATERIALS[this.mat[i]].hp;
    const before = this.hp[i];
    if (before >= max) return 0;
    const next = Math.min(max, before + amount);
    this.hp[i] = next;
    if (next >= max) this.damagedVoxels.delete(i);
    return next - before;
  }

  // -------------------------------------------------------------------------
  // Surface heightmap
  // -------------------------------------------------------------------------
  /** Full rebuild — only used once after world generation. */
  rebuildHeights(): void {
    for (let z = 0; z < WORLD_Z; z++) {
      for (let x = 0; x < WORLD_X; x++) {
        this.heights[z * WORLD_X + x] = this.scanColumn(x, z);
      }
    }
    this.dirtyColumns.clear();
  }

  surfaceHeight(x: number, z: number): number {
    if (x < 0 || z < 0 || x >= WORLD_X || z >= WORLD_Z) return WORLD_Y;
    return this.heights[z * WORLD_X + x];
  }

  private scanColumn(x: number, z: number): number {
    for (let y = WORLD_Y - 1; y >= 0; y--) {
      if (this.blocks[(y * WORLD_Z + z) * WORLD_X + x] !== AIR) return y + 1;
    }
    return 0;
  }

  private raiseHeight(x: number, y: number, z: number): void {
    const c = z * WORLD_X + x;
    if (y + 1 > this.heights[c]) {
      this.heights[c] = y + 1;
      this.dirtyColumns.add(c);
    }
  }

  private lowerHeight(x: number, y: number, z: number): void {
    const c = z * WORLD_X + x;
    if (this.heights[c] === y + 1) {
      this.heights[c] = this.scanColumn(x, z);
      this.dirtyColumns.add(c);
    }
  }

  // -------------------------------------------------------------------------
  // Chunk bookkeeping
  // -------------------------------------------------------------------------
  static chunkIndex(cx: number, cy: number, cz: number): number {
    return (cy * CHUNKS_Z + cz) * CHUNKS_X + cx;
  }

  markChunkDirty(cx: number, cy: number, cz: number): void {
    if (cx < 0 || cy < 0 || cz < 0 || cx >= CHUNKS_X || cy >= CHUNKS_Y || cz >= CHUNKS_Z) return;
    this.dirtyChunks.add(VoxelWorld.chunkIndex(cx, cy, cz));
  }

  markAllDirty(): void {
    for (let cy = 0; cy < CHUNKS_Y; cy++)
      for (let cz = 0; cz < CHUNKS_Z; cz++)
        for (let cx = 0; cx < CHUNKS_X; cx++)
          this.dirtyChunks.add(VoxelWorld.chunkIndex(cx, cy, cz));
  }

  /**
   * Dirties the chunk owning (x,y,z) plus any neighbour whose border faces
   * could newly be exposed or hidden by the edit.
   */
  private markDirtyAround(x: number, y: number, z: number): void {
    const cx = (x / CHUNK) | 0;
    const cy = (y / CHUNK) | 0;
    const cz = (z / CHUNK) | 0;
    this.markChunkDirty(cx, cy, cz);
    const lx = x - cx * CHUNK;
    const ly = y - cy * CHUNK;
    const lz = z - cz * CHUNK;
    if (lx === 0) this.markChunkDirty(cx - 1, cy, cz);
    else if (lx === CHUNK - 1) this.markChunkDirty(cx + 1, cy, cz);
    if (ly === 0) this.markChunkDirty(cx, cy - 1, cz);
    else if (ly === CHUNK - 1) this.markChunkDirty(cx, cy + 1, cz);
    if (lz === 0) this.markChunkDirty(cx, cy, cz - 1);
    else if (lz === CHUNK - 1) this.markChunkDirty(cx, cy, cz + 1);
  }

  /**
   * True when the column below (x,z) starting at y is unsupported, used to make
   * blasted-away overhangs collapse like they do in AoS.
   */
  columnHeight(x: number, z: number): number {
    if (x < 0 || z < 0 || x >= WORLD_X || z >= WORLD_Z) return 0;
    for (let y = WORLD_Y - 1; y >= 0; y--) {
      if (this.blocks[(y * WORLD_Z + z) * WORLD_X + x] !== AIR) return y + 1;
    }
    return 0;
  }
}
