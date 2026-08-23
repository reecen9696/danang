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

const CANDIDATE_DIRS = 8;

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
  const chest = Math.floor(y + 1);
  for (let step = 1; step <= 2; step++) {
    const sx = Math.floor(x + towardX * step);
    const sz = Math.floor(z + towardZ * step);
    if (world.isSolid(sx, chest, sz)) return true;
  }
  return false;
}

/**
 * Rates a standing position against a shooter.
 *
 * The good spot isn't the one that hides you — that's a spot you can't fight
 * from. It's the one that hides your chest while leaving your eyeline clear, so
 * you're shooting over the top of something instead of standing beside it.
 */
export function rateCover(
  world: VoxelWorld,
  x: number, footY: number, z: number,
  height: number,
  px: number, py: number, pz: number,
): number {
  const chestY = footY + height * 0.55;
  const eyeY = footY + height * 0.82;
  const chestClear = hasLineOfSight(world, px, py, pz, x, chestY, z);
  if (chestClear) return 0;
  const eyeClear = hasLineOfSight(world, px, py, pz, x, eyeY, z);
  return eyeClear ? 2 : 1;
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
  const radius = 3.5 + (bot.phase % 1) * 3;
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
