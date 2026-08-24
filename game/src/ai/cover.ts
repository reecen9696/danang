import { WORLD_X, WORLD_Z } from '../core/constants';
import type { VoxelWorld } from '../voxel/VoxelWorld';
import { hasLineOfSight } from '../voxel/raycast';
import { findStandingY } from './Bot';
import type { Bot } from './Bot';

export interface CoverSpot {
  x: number;
  y: number;
  z: number;
  /** 0 = exposed, 1 = hidden, 2 = hidden but can still shoot back. */
  quality: number;
}

const CANDIDATE_DIRS = 12;

/**
 * Body heights as fractions of the standing height, matching Bot.poseHeight.
 *
 * Cover is rated against the *ducked* chest and the *standing* eye, because
 * that's the deal a parapet actually offers: get down and it covers you, stand
 * up and you can shoot over it. Rating it against the standing chest instead
 * throws away every wall under about waist height — which is most of the cover
 * on a voxel map, and all of the cover the bots build themselves.
 */
const DUCKED_CHEST = 0.66 * 0.55;
const STANDING_EYE = 0.82;

/**
 * Cheap prefilter: is there something solid immediately between this spot and
 * the shooter, at the height that matters? Real occlusion still needs a ray,
 * but this rejects open ground for the price of two array reads and keeps the
 * ray budget for candidates that might actually work.
 */
function hasNearbyShield(
  world: VoxelWorld,
  x: number, y: number, z: number,
  towardX: number, towardZ: number,
): boolean {
  const low = Math.floor(y);
  const chest = Math.floor(y + 1);
  for (let step = 1; step <= 2; step++) {
    const sx = Math.floor(x + towardX * step);
    const sz = Math.floor(z + towardZ * step);
    // A single course of blocks at foot height is still a parapet to duck
    // behind, so the prefilter has to look there as well as at chest height.
    if (world.isSolid(sx, low, sz) || world.isSolid(sx, chest, sz)) return true;
  }
  return false;
}

/**
 * Rates a position against a shooter.
 *
 * The good spot isn't the one that hides you — that's a spot you can't fight
 * from. It's the one that hides you when you're down and lets you see when
 * you're up, so you're shooting over the top of something rather than standing
 * beside it. So the chest is measured ducked and the eyeline standing: quality
 * 2 is a firing position, quality 1 is a hole to sit in.
 */
export function rateCover(
  world: VoxelWorld,
  x: number, footY: number, z: number,
  height: number,
  px: number, py: number, pz: number,
): number {
  const duckedChestY = footY + height * DUCKED_CHEST;
  if (hasLineOfSight(world, px, py, pz, x, duckedChestY, z)) return 0;

  // Something covers the ducked body. Can it be fought from? Only if standing
  // back up clears the top of it — otherwise this is a hole to sit in, not a
  // firing position.
  const eyeY = footY + height * STANDING_EYE;
  return hasLineOfSight(world, px, py, pz, x, eyeY, z) ? 2 : 1;
}

/**
 * Looks for a better place to fight from within a short move of the bot.
 *
 * Candidates are sampled on a ring so the bot sidesteps to the nearest usable
 * edge rather than sprinting across the map, and `biasX/biasZ` nudges the
 * choice toward wherever the bot was already trying to get to — cover that
 * costs ground is only worth taking when the bot is being hit.
 */
export function findCoverSpot(
  world: VoxelWorld,
  bot: Bot,
  px: number, py: number, pz: number,
  biasX: number, biasZ: number,
  out: CoverSpot,
): boolean {
  const radius = 3 + (bot.phase % 1) * 4;
  const height = bot.def.height;
  const bx = bot.position.x;
  const bz = bot.position.z;

  let bestScore = -Infinity;
  let found = false;

  for (let i = 0; i < CANDIDATE_DIRS; i++) {
    const a = bot.phase + (i / CANDIDATE_DIRS) * Math.PI * 2;
    const cx = bx + Math.cos(a) * radius;
    const cz = bz + Math.sin(a) * radius;
    if (cx < 3 || cz < 3 || cx > WORLD_X - 4 || cz > WORLD_Z - 4) continue;

    const fx = Math.floor(cx);
    const fz = Math.floor(cz);
    const y = findStandingY(world, fx, fz, bot.position.y, 1, 4);
    if (y < 0) continue;

    // Point from the candidate at the shooter, for the prefilter.
    let tx = px - cx;
    let tz = pz - cz;
    const tl = Math.hypot(tx, tz);
    if (tl < 1e-3) continue;
    tx /= tl;
    tz /= tl;
    if (!hasNearbyShield(world, cx, y, cz, tx, tz)) continue;

    const quality = rateCover(world, cx, y, cz, height, px, py, pz);
    if (quality === 0) continue;

    // Prefer cover you can shoot from, that's close, and that doesn't give up
    // ground the bot was trying to take.
    const progress = (cx - bx) * biasX + (cz - bz) * biasZ;
    const score = quality * 10 + progress * 1.5 - tl * 0.05;
    if (score <= bestScore) continue;

    bestScore = score;
    out.x = cx;
    out.y = y;
    out.z = cz;
    out.quality = quality;
    found = true;
  }

  return found;
}
