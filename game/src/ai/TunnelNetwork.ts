import { WORLD_X, WORLD_Z, WORLD_Y, WATER_LEVEL, MATERIALS } from '../core/constants';
import type { VoxelWorld } from '../voxel/VoxelWorld';

/**
 * The tunnels under the valley, and the mouths they come up out of.
 *
 * The network is not a graph the bots path along. Underground there is nothing
 * to path around: a burrower moves in a straight line through the earth at
 * digging speed, and what the network actually holds is the set of *mouths* —
 * the places a man can come up out of the ground and be standing on it.
 *
 * That distinction is the whole design. The interesting decision a tunnel rat
 * makes is never "which corridor", it's "which hole, and when". Modelling the
 * corridors would cost a pathfinder and buy nothing the player can see; the
 * mouths are what they can see, so the mouths are what's modelled.
 *
 * Some are dug into the map at first light (see worldgen), so the valley
 * already has a network in it when the run starts and the player can find and
 * drop into one. The rest are cut during the run by the bots themselves, and
 * they persist — by wave ten the hill is worked through like an anthill, and
 * every hole in it is one somebody came up out of.
 */

/** How far under the surface the tunnels run. */
export const TUNNEL_DEPTH = 5;

/** Seconds a mouth stays hot after someone has come up out of it. */
const MOUTH_COOLDOWN = 6;
/** A claim that isn't consumed expires, so a dead bot doesn't lock a mouth. */
const CLAIM_TIMEOUT = 25;

export interface SpiderHole {
  /** The shaft column: the hole you can see in the ground, and fall down. */
  x: number;
  z: number;
  /** Floor of the gallery the shaft drops into. */
  floorY: number;
  /**
   * The lip: the block of ground beside the shaft that a man coming up out of
   * it ends up standing on, and steps off to go back down.
   *
   * A mouth is a hole, and there is by definition no floor in a hole — a bot
   * "emerging" onto the shaft column itself would be standing on the air it
   * just dug out and would drop straight back down it. So the shaft is what
   * the rise is drawn through and the lip is where the man ends up, which is
   * also what it looks like: up out of the hole, and out of it.
   */
  standX: number;
  standZ: number;
  y: number;
  /** Bot slot that has called this exit, or -1. */
  claimedBy: number;
  claimTimer: number;
  /** Seconds before anyone uses this mouth again. */
  cooldown: number;
  /** Cut during the run rather than being there at first light. */
  fresh: boolean;
}

export class TunnelNetwork {
  readonly holes: SpiderHole[] = [];

  /**
   * Ceiling on mouths. Fresh ones accumulate for the whole run, and every one
   * of them is a hole in the terrain mesh; past this the oldest fresh cut is
   * recycled rather than letting a long run turn the map into lace.
   */
  private readonly limit = 96;

  add(
    x: number, z: number,
    floorY: number,
    standX: number, standY: number, standZ: number,
    fresh: boolean,
  ): SpiderHole {
    if (this.holes.length >= this.limit) {
      // Recycle the oldest cut of the run. Never one of the original mouths:
      // those are terrain, and the player has learned where they are.
      const i = this.holes.findIndex((h) => h.fresh);
      if (i >= 0) this.holes.splice(i, 1);
      else this.holes.shift();
    }
    const hole: SpiderHole = {
      x, z, floorY, standX, standZ, y: standY,
      claimedBy: -1, claimTimer: 0, cooldown: 0, fresh,
    };
    this.holes.push(hole);
    return hole;
  }

  update(dt: number): void {
    for (const h of this.holes) {
      if (h.cooldown > 0) h.cooldown = Math.max(0, h.cooldown - dt);
      if (h.claimedBy < 0) continue;
      h.claimTimer -= dt;
      if (h.claimTimer <= 0) h.claimedBy = -1;
    }
  }

  /** Drops any claim held by this slot — call when a burrower dies or resets. */
  release(slot: number): void {
    for (const h of this.holes) {
      if (h.claimedBy === slot) h.claimedBy = -1;
    }
  }

  /** Marks a mouth as just used, so the next man picks a different one. */
  markUsed(hole: SpiderHole): void {
    hole.cooldown = MOUTH_COOLDOWN;
    hole.claimedBy = -1;
  }

  /**
   * Picks a mouth to come up out of.
   *
   * Wanted: close enough to the target to matter, far enough that the man isn't
   * surfacing inside their boots, and not one a squadmate has already called.
   * `bias` points the way the squad wants the ambush to close from, which is
   * what makes a fireteam come up on several sides at once instead of stacking
   * in one hole.
   */
  pickExit(
    px: number, pz: number,
    minR: number, maxR: number,
    slot: number, rand: () => number,
    biasX = 0, biasZ = 0,
    sees?: (x: number, y: number, z: number) => boolean,
    requireSee = false,
  ): SpiderHole | null {
    let best: SpiderHole | null = null;
    let bestScore = -Infinity;

    for (const h of this.holes) {
      if (h.cooldown > 0) continue;
      if (h.claimedBy >= 0 && h.claimedBy !== slot) continue;
      const dx = h.standX - px;
      const dz = h.standZ - pz;
      const d = Math.hypot(dx, dz);
      if (d < minR || d > maxR) continue;
      if (requireSee && (sees === undefined || !sees(h.standX, h.y, h.standZ))) continue;

      // Closer is better, but only down to the floor set by minR; past that
      // it's a coin toss between the near ones, so a squad doesn't all pick
      // the single closest mouth.
      let score = -d * 0.6 + rand() * 6;
      if (biasX !== 0 || biasZ !== 0) {
        const len = Math.max(1e-4, d);
        score += ((dx / len) * biasX + (dz / len) * biasZ) * 5;
      }
      // Worth more than everything else put together: a mouth you can shoot
      // out of beats a nearer one you can't by a distance the other terms
      // can't close.
      if (sees !== undefined && sees(h.standX, h.y, h.standZ)) score += 60;
      if (score <= bestScore) continue;
      bestScore = score;
      best = h;
    }

    if (best !== null) {
      best.claimedBy = slot;
      best.claimTimer = CLAIM_TIMEOUT;
    }
    return best;
  }

  /** The mouth nearest a point, used to drop back underground. */
  nearest(x: number, z: number, maxR: number): SpiderHole | null {
    let best: SpiderHole | null = null;
    let bestD = maxR;
    for (const h of this.holes) {
      const d = Math.hypot(h.standX - x, h.standZ - z);
      if (d >= bestD) continue;
      bestD = d;
      best = h;
    }
    return best;
  }

  clear(): void {
    this.holes.length = 0;
  }
}

/**
 * Depth a burrower travels at under a given column: below anything the player
 * has built, above the bedrock, and clear of the water table.
 */
export function tunnelY(world: VoxelWorld, x: number, z: number): number {
  const fx = Math.max(0, Math.min(WORLD_X - 1, Math.floor(x)));
  const fz = Math.max(0, Math.min(WORLD_Z - 1, Math.floor(z)));
  const surface = world.surfaceHeight(fx, fz);
  return Math.max(2, Math.min(WORLD_Y - 4, surface - TUNNEL_DEPTH));
}

/**
 * Can a mouth be cut here at all?
 *
 * Refuses water, refuses anything with indestructible material in the shaft —
 * a hole that would have to come up through the Core is not a hole — and
 * refuses ground so thin there's nothing to tunnel under.
 */
export function canCutMouth(world: VoxelWorld, x: number, z: number): boolean {
  const fx = Math.floor(x);
  const fz = Math.floor(z);
  if (fx < 4 || fz < 4 || fx >= WORLD_X - 4 || fz >= WORLD_Z - 4) return false;
  const surface = world.surfaceHeight(fx, fz);
  if (surface <= WATER_LEVEL + 1) return false;
  if (surface >= WORLD_Y - 3) return false;
  const floor = Math.max(2, surface - TUNNEL_DEPTH);
  if (surface - floor < 2) return false;
  for (let y = floor; y <= surface; y++) {
    if (MATERIALS[world.materialAt(fx, y, fz)].indestructible) return false;
  }
  return true;
}

/**
 * The block of ground beside a shaft that a man can stand on.
 *
 * Checked against the ground level the shaft was cut from, so the lip is
 * genuinely level with the surrounding surface rather than a ledge halfway
 * down. Returns null when the mouth is somewhere nobody could climb out of —
 * mid-cliff, or with a wall on every side — which is what stops one being cut
 * there in the first place.
 */
export function findLip(
  world: VoxelWorld,
  fx: number, fz: number,
  groundY: number,
): { x: number; z: number; y: number } | null {
  let best: { x: number; z: number; y: number } | null = null;
  let bestDrop = Infinity;

  for (let i = 0; i < LIP_X.length; i++) {
    const nx = fx + LIP_X[i];
    const nz = fz + LIP_Z[i];
    if (nx < 2 || nz < 2 || nx >= WORLD_X - 2 || nz >= WORLD_Z - 2) continue;
    // Solid underfoot, and two clear blocks of headroom to stand in.
    if (!world.isSolid(nx, groundY - 1, nz)) continue;
    if (world.isSolid(nx, groundY, nz) || world.isSolid(nx, groundY + 1, nz)) continue;
    const drop = Math.abs(LIP_X[i]) + Math.abs(LIP_Z[i]);
    if (drop >= bestDrop) continue;
    bestDrop = drop;
    best = { x: nx + 0.5, z: nz + 0.5, y: groundY };
  }
  return best;
}

const LIP_X = [1, -1, 0, 0, 1, 1, -1, -1];
const LIP_Z = [0, 0, 1, -1, 1, -1, 1, -1];
