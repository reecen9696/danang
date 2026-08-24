/**
 * Ground and collision for the things living in the village.
 *
 * The villagers, the merchants and the buffalo are scenery: no pathing, no
 * server state, no business knowing anything about the AI. What they do need
 * is the one thing every moving body on this map needs, which is not to walk
 * through a wall. A villager who strolls out through the side of a hut reads
 * as a bug the instant you see it, however good the rest of him looks, and it
 * undoes the only job he has — making the place look lived in.
 *
 * This is deliberately much less than `BotManager.tryMove`. A civilian is not
 * assaulting anything: no climbing a parapet, no dropping off a roof, no
 * squeezing through a gap. He walks on the ground, steps over a doorstep, and
 * everything else stops him.
 */
import { blockingVoxel, findStandingY } from '../ai/Bot';
import { WORLD_X, WORLD_Z } from '../core/constants';
import type { VoxelWorld } from '../voxel/VoxelWorld';

/** Anything with feet and somewhere to be. */
export interface Walker {
  x: number;
  y: number;
  z: number;
}

/** How far up someone steps without thinking about it. A doorstep. */
const STEP_UP = 1;
/** How far down they will walk off. More than this is a drop, and they refuse. */
const MAX_DROP = 1;

/**
 * Moves `w` by (stepX, stepZ), refusing to enter anything solid.
 *
 * Blocked head-on, each axis is tried alone, so somebody walking into the
 * corner of a hut slides along its wall instead of stopping dead with his legs
 * still going.
 *
 * `w.y` comes out on whatever they ended up standing on. A caller that owns
 * its own ground — the farmers sit at the paddy's water line rather than on
 * the voxel surface — simply writes `y` again afterwards.
 *
 * Returns whether any ground was actually covered, so a walker who has run out
 * of road can go and want something else rather than grinding into it.
 */
export function walkClear(
  world: VoxelWorld,
  w: Walker,
  stepX: number,
  stepZ: number,
  radius: number,
): boolean {
  /**
   * Is the body standing at (x, z) with its feet on `footY` inside something?
   *
   * The whole footprint, not just the centre: a body has width, and somebody
   * who only ever tests his own middle walks half of himself into a wall
   * before anything stops him.
   *
   * The height matters as much as the position. Testing the footprint where
   * they are standing *now* and then stepping them up onto a doorstep puts
   * them a block higher than anything was ever checked at, which is a body
   * inside the wall above the step.
   */
  const blocked = (x: number, z: number, footY: number): boolean => {
    for (let cx = -1; cx <= 1; cx += 2) {
      for (let cz = -1; cz <= 1; cz += 2) {
        const fx = Math.floor(x + cx * radius);
        const fz = Math.floor(z + cz * radius);
        if (blockingVoxel(world, fx, footY, fz) >= 0) return true;
      }
    }
    return false;
  };

  const tryTo = (x: number, z: number): boolean => {
    if (x < 2 || z < 2 || x > WORLD_X - 3 || z > WORLD_Z - 3) return false;
    const y = findStandingY(world, Math.floor(x), Math.floor(z), w.y, STEP_UP, MAX_DROP);
    if (y < 0 || y - w.y > STEP_UP + 0.05) return false;
    if (blocked(x, z, Math.floor(y))) return false;
    w.x = x;
    w.z = z;
    w.y = y;
    return true;
  };

  if (tryTo(w.x + stepX, w.z + stepZ)) return true;
  if (stepX !== 0 && tryTo(w.x + stepX, w.z)) return true;
  if (stepZ !== 0 && tryTo(w.x, w.z + stepZ)) return true;

  // Nowhere clear to put them. Somebody who is *already* inside geometry — a
  // hut raised on top of him, a spawn that was never clear — is walked out of
  // it anyway rather than being pinned there for the rest of the run, which
  // would be a worse bug than the one this exists to fix. Everyone else has
  // simply arrived at a wall, and stops.
  if (blocked(w.x, w.z, Math.floor(w.y))) {
    w.x += stepX;
    w.z += stepZ;
    const y = findStandingY(world, Math.floor(w.x), Math.floor(w.z), w.y, STEP_UP, MAX_DROP);
    if (y >= 0) w.y = y;
    return true;
  }
  return false;
}
