import { WORLD_X, WORLD_Z, WORLD_Y, WATER_LEVEL, MATERIALS } from '../core/constants';
import type { VoxelWorld } from '../voxel/VoxelWorld';

const CELLS = WORLD_X * WORLD_Z;

/** Cost of a cell that could not be reached by any route. */
export const UNREACHABLE = 0x3fffffff;

/** Straight and diagonal step costs. Everything else is expressed in these. */
const ORTHO = 10;
const DIAG = 14;

/** Height a bot can walk up without help. */
const STEP_UP = 1;
/** Tallest wall an assault ramp can beat. */
const MAX_CLIMB = 5;
/**
 * Tallest face worth pricing a bore through. Player walls are a few blocks;
 * anything taller is a cliff, and skipping those keeps the rebuild off the
 * mountains, which is most of the map.
 */
const MAX_DIG_RISE = 8;
/** Drops beyond this hurt; beyond MAX_DROP they're refused outright. */
const SAFE_DROP = 3;
const MAX_DROP = 8;
const DROP_PENALTY = 6;
/** Wading is slow and leaves you in the open. */
const WATER_PENALTY = 14;
/** Fixed overhead for stopping to build a ramp, plus a per-block term. */
const CLIMB_COST = 60;
const CLIMB_PER_BLOCK = 10;

/**
 * Cost of chewing through one voxel of each material, on the same scale as a
 * walking step. Derived from effective HP (raw HP scaled by the material's
 * damage resistance) so a dirt berm is barely a detour, stone is worth walking
 * around unless the detour is long, and steel is a last resort.
 */
const DIG_COST: readonly number[] = MATERIALS.map((m) =>
  m.indestructible ? -1 : Math.min(300, Math.max(4, Math.round(m.hp / Math.max(0.05, m.resist) / 8))));

/** Deepest wall a bore will be priced through before it's called a mountain. */
const MAX_BORE = 8;
/**
 * Past this, walking around is always the better answer — and capping the bore
 * is also what keeps every edge weight inside the bucket range below.
 */
const MAX_BORE_COST = 1500;

/**
 * Buckets for Dial's algorithm. Must strictly exceed the largest possible edge
 * cost, which is DIAG + WATER_PENALTY + MAX_BORE_COST.
 */
const BUCKETS = 2048;
const BUCKET_MASK = BUCKETS - 1;

const NEIGHBOR_X = [1, -1, 0, 0, 1, 1, -1, -1];
const NEIGHBOR_Z = [0, 0, 1, -1, 1, -1, 1, -1];

/**
 * Weighted flow field over the world surface.
 *
 * The important difference from a plain BFS is that walls are *expensive*
 * rather than impassable: an edge that a bot can only take by digging through
 * or by ramping over carries the cost of doing so. One Dijkstra sweep from the
 * objectives therefore answers "go around, dig through, or build over?" for
 * every cell on the map at once, and each bot reads its answer in O(1).
 *
 * Without that, a sealed base makes every cell unreachable and the horde
 * degenerates into walking at the nearest wall in a straight line.
 *
 * Dial's algorithm (bucket queue) is used instead of a heap: edge costs are
 * small bounded integers, so push and pop are both O(1) and a full rebuild
 * stays in the same ballpark as the BFS it replaces.
 */
export class NavGrid {
  /** Total cost from each cell to the nearest objective, or UNREACHABLE. */
  readonly cost = new Int32Array(CELLS);
  /** Step toward the objective, quantised to -1/0/1. */
  readonly flowX = new Int8Array(CELLS);
  readonly flowZ = new Int8Array(CELLS);

  /** Cells seeded at cost 0 — the core, and the player when they're alive. */
  private readonly seeds: number[] = [];

  private readonly buckets: Int32Array[] = new Array(BUCKETS);
  private readonly bucketLen = new Int32Array(BUCKETS);
  private pending = 0;

  private rebuildTimer = 0;
  /** Wall-clock cost of the last rebuild, surfaced in the perf overlay. */
  lastRebuildMs = 0;

  constructor(private readonly world: VoxelWorld) {
    this.cost.fill(UNREACHABLE);
  }

  /** Replaces the objective list. Cheap — takes effect on the next rebuild. */
  setSeeds(points: readonly { x: number; z: number }[]): void {
    this.seeds.length = 0;
    for (const p of points) {
      const x = Math.max(1, Math.min(WORLD_X - 2, Math.floor(p.x)));
      const z = Math.max(1, Math.min(WORLD_Z - 2, Math.floor(p.z)));
      this.seeds.push(z * WORLD_X + x);
    }
  }

  /**
   * Rebuilds on a timer, or sooner when the map has changed a lot — but never
   * more than a few times a second, or a firefight tearing up a wall would
   * rebuild every frame.
   */
  update(dt: number): void {
    this.rebuildTimer -= dt;
    const churned = this.world.dirtyColumns.size > 40;
    if (this.rebuildTimer <= 0 || (churned && this.rebuildTimer < 1.15)) {
      this.rebuild();
      this.rebuildTimer = 1.5;
    }
  }

  rebuild(): void {
    const t0 = performance.now();
    const cost = this.cost;
    const heights = this.world.heights;

    cost.fill(UNREACHABLE);
    this.flowX.fill(0);
    this.flowZ.fill(0);
    this.bucketLen.fill(0);
    this.pending = 0;
    this.world.dirtyColumns.clear();

    // Seed a small patch around each objective so bots converge on a footprint
    // rather than fighting over one cell.
    for (const seed of this.seeds) {
      const sx = seed % WORLD_X;
      const sz = (seed / WORLD_X) | 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = sx + dx;
          const z = sz + dz;
          if (x < 1 || z < 1 || x >= WORLD_X - 1 || z >= WORLD_Z - 1) continue;
          const c = z * WORLD_X + x;
          if (cost[c] === 0) continue;
          cost[c] = 0;
          this.push(c, 0);
        }
      }
    }

    let key = 0;
    while (this.pending > 0 && key < UNREACHABLE) {
      const b = key & BUCKET_MASK;
      const len = this.bucketLen[b];
      if (len === 0) { key++; continue; }

      const arr = this.buckets[b];
      this.bucketLen[b] = 0;
      this.pending -= len;

      for (let i = 0; i < len; i++) {
        const c = arr[i];
        // Lazy deletion: a cheaper route reached this cell after we queued it.
        if (cost[c] !== key) continue;

        const cx = c % WORLD_X;
        const cz = (c / WORLD_X) | 0;
        const hc = heights[c];

        for (let k = 0; k < 8; k++) {
          const ox = NEIGHBOR_X[k];
          const oz = NEIGHBOR_Z[k];
          const nx = cx + ox;
          const nz = cz + oz;
          if (nx < 1 || nz < 1 || nx >= WORLD_X - 1 || nz >= WORLD_Z - 1) continue;
          const n = nz * WORLD_X + nx;
          if (cost[n] <= key) continue;

          const hn = heights[n];
          const diagonal = ox !== 0 && oz !== 0;
          if (diagonal) {
            // Don't let a diagonal squeeze through the corner of a wall.
            const a = heights[cz * WORLD_X + nx];
            const b2 = heights[nz * WORLD_X + cx];
            if (a - hn > STEP_UP && b2 - hn > STEP_UP) continue;
          }

          // (ox, oz) points from c to n; the bot walks the other way.
          const w = this.edgeCost(cx, cz, -ox, -oz, hc, hn, diagonal);
          if (w < 0) continue;

          const nk = key + w;
          if (nk >= cost[n]) continue;
          cost[n] = nk;
          // The bot stands at n and steps to c, so the flow points back at c.
          this.flowX[n] = ox === 0 ? 0 : (ox > 0 ? -1 : 1);
          this.flowZ[n] = oz === 0 ? 0 : (oz > 0 ? -1 : 1);
          this.push(n, nk);
        }
      }
      key++;
    }

    this.lastRebuildMs = performance.now() - t0;
  }

  /**
   * Cost for a bot standing at height `hn` to move into the column (cx, cz),
   * travelling along (ox, oz). Negative means there is no way through at all.
   */
  private edgeCost(
    cx: number, cz: number,
    travelX: number, travelZ: number,
    hc: number, hn: number,
    diagonal: boolean,
  ): number {
    if (hc >= WORLD_Y - 3 || hn >= WORLD_Y - 3) return -1;

    let w = diagonal ? DIAG : ORTHO;
    if (hn <= WATER_LEVEL) w += WATER_PENALTY;

    const rise = hc - hn;
    if (rise <= STEP_UP) {
      const drop = -rise;
      if (drop > MAX_DROP) return -1;
      if (drop > SAFE_DROP) w += (drop - SAFE_DROP) * DROP_PENALTY;
      return w;
    }

    // Blocked. Two ways past: bore through at foot height, or ramp over.
    const dig = rise <= MAX_DIG_RISE ? this.boreCost(cx, cz, travelX, travelZ, hn) : -1;
    const climb = rise <= MAX_CLIMB ? CLIMB_COST + rise * CLIMB_PER_BLOCK : -1;

    if (dig < 0 && climb < 0) return -1;
    if (dig < 0) return w + climb;
    if (climb < 0) return w + dig;
    return w + Math.min(dig, climb);
  }

  /**
   * Prices a two-high bore that carries on *past* (cx, cz) in the direction the
   * bot is travelling.
   *
   * The exit check is the point of this. A flow field is 2D, so it assumes that
   * entering a cell leaves you standing on that cell's surface — which is true
   * of a wall you tunnel through and badly false of a cliff you tunnel into.
   * Without walking the bore to a cell the bot can actually stand on at its own
   * height, the field prices "dig into the mountain" as two blocks of stone and
   * the whole horde parks itself at the bottom of a rock face.
   */
  private boreCost(cx: number, cz: number, travelX: number, travelZ: number, hn: number): number {
    const world = this.world;
    const heights = this.world.heights;
    let total = 0;

    for (let step = 0; step < MAX_BORE; step++) {
      const x = cx + travelX * step;
      const z = cz + travelZ * step;
      if (x < 1 || z < 1 || x >= WORLD_X - 1 || z >= WORLD_Z - 1) return -1;

      // Somewhere to stand at roughly our own height means we're through.
      const h = heights[z * WORLD_X + x];
      if (h - hn <= STEP_UP && hn - h <= SAFE_DROP) return total;

      for (let dy = 0; dy < 2; dy++) {
        const y = hn + dy;
        if (y < 0 || y >= WORLD_Y) return -1;
        if (!world.isSolid(x, y, z)) continue;
        const c = DIG_COST[world.materialAt(x, y, z)];
        if (c < 0) return -1;
        total += c;
        if (total > MAX_BORE_COST) return -1;
      }
    }
    // Never found the far side within a sane digging distance.
    return -1;
  }

  private push(cell: number, key: number): void {
    const b = key & BUCKET_MASK;
    let arr = this.buckets[b];
    const len = this.bucketLen[b];
    if (arr === undefined) {
      arr = new Int32Array(64);
      this.buckets[b] = arr;
    } else if (len >= arr.length) {
      const grown = new Int32Array(arr.length * 2);
      grown.set(arr);
      arr = grown;
      this.buckets[b] = arr;
    }
    arr[len] = cell;
    this.bucketLen[b] = len + 1;
    this.pending++;
  }

  cellAt(x: number, z: number): number {
    const cx = Math.max(0, Math.min(WORLD_X - 1, Math.floor(x)));
    const cz = Math.max(0, Math.min(WORLD_Z - 1, Math.floor(z)));
    return cz * WORLD_X + cx;
  }

  costAt(x: number, z: number): number {
    return this.cost[this.cellAt(x, z)];
  }

  /** Writes the flow direction into out[0]/out[1]. False when there's no route. */
  sample(x: number, z: number, out: Float32Array): boolean {
    const c = this.cellAt(x, z);
    out[0] = 0;
    out[1] = 0;
    if (this.cost[c] === UNREACHABLE) return false;
    const fx = this.flowX[c];
    const fz = this.flowZ[c];
    if (fx === 0 && fz === 0) return true;
    const len = Math.hypot(fx, fz);
    out[0] = fx / len;
    out[1] = fz / len;
    return true;
  }
}
