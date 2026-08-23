import type { VoxelWorld } from './VoxelWorld';
import { WORLD_Y } from '../core/constants';

export interface RayHit {
  hit: boolean;
  /** Voxel that was struck. */
  x: number;
  y: number;
  z: number;
  /** Empty voxel immediately before the hit — where a new block would go. */
  px: number;
  py: number;
  pz: number;
  /** Face normal of the struck voxel. */
  nx: number;
  ny: number;
  nz: number;
  /** Distance along the ray. */
  distance: number;
}

const scratch: RayHit = {
  hit: false, x: 0, y: 0, z: 0, px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz: 0, distance: 0,
};

/**
 * Amanatides-Woo voxel traversal. Steps voxel-to-voxel with no per-block
 * colliders, so a shot or a dig is a handful of adds and compares.
 *
 * Returns a shared object — copy anything you need to keep.
 */
export function raycastVoxels(
  world: VoxelWorld,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxDistance: number,
): RayHit {
  scratch.hit = false;
  scratch.distance = maxDistance;

  let x = Math.floor(ox);
  let y = Math.floor(oy);
  let z = Math.floor(oz);

  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;

  const invX = dx !== 0 ? 1 / Math.abs(dx) : Infinity;
  const invY = dy !== 0 ? 1 / Math.abs(dy) : Infinity;
  const invZ = dz !== 0 ? 1 / Math.abs(dz) : Infinity;

  // Distance to the first voxel boundary on each axis.
  let tMaxX = stepX === 0 ? Infinity : ((stepX > 0 ? x + 1 - ox : ox - x) * invX);
  let tMaxY = stepY === 0 ? Infinity : ((stepY > 0 ? y + 1 - oy : oy - y) * invY);
  let tMaxZ = stepZ === 0 ? Infinity : ((stepZ > 0 ? z + 1 - oz : oz - z) * invZ);

  let nx = 0, ny = 0, nz = 0;
  let t = 0;

  // Generous cap: the longest possible traversal for the given distance.
  const maxSteps = Math.ceil(maxDistance * 3) + 3;

  for (let i = 0; i < maxSteps; i++) {
    if (y >= 0 && y < WORLD_Y && world.isSolid(x, y, z)) {
      scratch.hit = true;
      scratch.x = x; scratch.y = y; scratch.z = z;
      scratch.nx = nx; scratch.ny = ny; scratch.nz = nz;
      scratch.px = x + nx; scratch.py = y + ny; scratch.pz = z + nz;
      scratch.distance = t;
      return scratch;
    }

    if (tMaxX < tMaxY) {
      if (tMaxX < tMaxZ) {
        if (tMaxX > maxDistance) break;
        x += stepX; t = tMaxX; tMaxX += invX; nx = -stepX; ny = 0; nz = 0;
      } else {
        if (tMaxZ > maxDistance) break;
        z += stepZ; t = tMaxZ; tMaxZ += invZ; nx = 0; ny = 0; nz = -stepZ;
      }
    } else if (tMaxY < tMaxZ) {
      if (tMaxY > maxDistance) break;
      y += stepY; t = tMaxY; tMaxY += invY; nx = 0; ny = -stepY; nz = 0;
    } else {
      if (tMaxZ > maxDistance) break;
      z += stepZ; t = tMaxZ; tMaxZ += invZ; nx = 0; ny = 0; nz = -stepZ;
    }
  }

  scratch.hit = false;
  return scratch;
}

/** Cheap line-of-sight test used by bot AI. */
export function hasLineOfSight(
  world: VoxelWorld,
  ox: number, oy: number, oz: number,
  tx: number, ty: number, tz: number,
): boolean {
  let dx = tx - ox, dy = ty - oy, dz = tz - oz;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-4) return true;
  dx /= len; dy /= len; dz /= len;
  const hit = raycastVoxels(world, ox, oy, oz, dx, dy, dz, len);
  return !hit.hit;
}
