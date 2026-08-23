import { VoxelWorld } from './VoxelWorld';
import { WORLD_X, WORLD_Y, WORLD_Z, Mat } from '../core/constants';
import { nearestPaletteIndex, COL_BEDROCK, AIR } from './palette';

/**
 * Importer for the classic Ace of Spades `.vxl` map format.
 *
 * The format stores a 512 x 512 grid of columns, 64 voxels deep, with Z
 * increasing *downwards*. Each column is a chain of run-length spans that
 * describe only the *visible* surface voxels; anything between a span's top run
 * and the next span's bottom run is solid but hidden, and is never given a
 * colour. Loading therefore starts from "everything is solid" and carves the
 * air out, which is the opposite of how you'd usually read a heightmap.
 *
 * Span header (4 bytes), then 4-byte BGRA colours:
 *   0: N  — length of this span in 4-byte words; 0 marks the final span
 *   1: S  — first z of the top (visible) colour run
 *   2: E  — last z of the top colour run
 *   3: A  — start of the air run above; only read from the *next* header
 *
 * Only this data layout was taken from the reference implementation. No code
 * was copied, and no map files are bundled with the game.
 */

export interface VxlLoadOptions {
  /**
   * Which part of the 512 x 512 source to import, since our world is 256 wide.
   * Defaults to the centre.
   */
  originX?: number;
  originZ?: number;
  /** Material assigned to imported terrain. */
  material?: number;
  /** Lay an indestructible floor at y = 0. */
  bedrockFloor?: boolean;
}

const SRC_SIZE = 512;
const SRC_DEPTH = 64;

/** Cache packed RGB -> palette index; nearest-colour search is not cheap. */
const colorCache = new Map<number, number>();

function mapColor(r: number, g: number, b: number): number {
  const key = (r << 16) | (g << 8) | b;
  const hit = colorCache.get(key);
  if (hit !== undefined) return hit;
  const idx = nearestPaletteIndex(r, g, b);
  colorCache.set(key, idx);
  return idx;
}

export interface VxlLoadResult {
  /** Highest solid voxel found, useful for placing spawns. */
  maxHeight: number;
  columnsRead: number;
}

/**
 * Decodes a `.vxl` buffer into the voxel world.
 *
 * The source is cropped (not scaled) so voxel detail is preserved 1:1.
 */
export function loadVxl(
  world: VoxelWorld,
  buffer: ArrayBuffer,
  options: VxlLoadOptions = {},
): VxlLoadResult {
  const bytes = new Uint8Array(buffer);
  const material = options.material ?? Mat.Dirt;
  const originX = options.originX ?? Math.floor((SRC_SIZE - WORLD_X) / 2);
  const originZ = options.originZ ?? Math.floor((SRC_SIZE - WORLD_Z) / 2);
  const bedrockFloor = options.bedrockFloor ?? true;

  world.blocks.fill(AIR);
  world.mat.fill(0);
  world.hp.fill(0);
  world.damagedVoxels.clear();

  // Our Y is up; the source's Z is down. depth d maps to y = (SRC_DEPTH-1) - d.
  const toY = (d: number): number => SRC_DEPTH - 1 - d;

  let pos = 0;
  let maxHeight = 0;
  let columnsRead = 0;

  // The format is a flat stream in (y-major, x-minor) column order, so every
  // column must be walked even when it falls outside our crop window.
  for (let sz = 0; sz < SRC_SIZE; sz++) {
    for (let sx = 0; sx < SRC_SIZE; sx++) {
      const wx = sx - originX;
      const wz = sz - originZ;
      const inside = wx >= 0 && wz >= 0 && wx < WORLD_X && wz < WORLD_Z;

      // Columns start fully solid; the spans carve the air out.
      if (inside) {
        for (let d = 0; d < SRC_DEPTH; d++) {
          const y = toY(d);
          if (y < WORLD_Y) world.setFast(wx, y, wz, 1, material);
        }
      }

      let d = 0;
      for (;;) {
        if (pos + 3 >= bytes.length) {
          return finish();
        }
        const n = bytes[pos];
        const top = bytes[pos + 1];
        const bottom = bytes[pos + 2];

        // Everything above the top run is open air.
        if (inside) {
          for (; d < top; d++) {
            const y = toY(d);
            if (y >= 0 && y < WORLD_Y) world.setFast(wx, y, wz, AIR, 0);
          }
        }

        let colorOffset = pos + 4;
        const topRunLen = bottom - top + 1;

        if (inside) {
          for (let z = top; z <= bottom; z++) {
            const b = bytes[colorOffset];
            const g = bytes[colorOffset + 1];
            const r = bytes[colorOffset + 2];
            colorOffset += 4;
            const y = toY(z);
            if (y < 0 || y >= WORLD_Y) continue;
            world.setFast(wx, y, wz, mapColor(r, g, b), material);
            if (y > maxHeight) maxHeight = y;
          }
        } else {
          colorOffset += topRunLen * 4;
        }
        d = bottom + 1;

        if (n === 0) {
          pos += 4 * (topRunLen + 1);
          break;
        }

        const bottomRunLen = n - 1 - topRunLen;
        pos += n * 4;

        // The next header tells us where the underside run ends.
        if (pos + 3 >= bytes.length) return finish();
        const nextBottomEnd = bytes[pos + 3];
        const bottomStart = nextBottomEnd - bottomRunLen;

        if (inside) {
          for (let z = bottomStart; z < nextBottomEnd; z++) {
            const b = bytes[colorOffset];
            const g = bytes[colorOffset + 1];
            const r = bytes[colorOffset + 2];
            colorOffset += 4;
            const y = toY(z);
            if (y < 0 || y >= WORLD_Y) continue;
            world.setFast(wx, y, wz, mapColor(r, g, b), material);
            if (y > maxHeight) maxHeight = y;
          }
        }
      }

      if (inside) columnsRead++;
    }
  }

  return finish();

  function finish(): VxlLoadResult {
    if (bedrockFloor) {
      for (let z = 0; z < WORLD_Z; z++) {
        for (let x = 0; x < WORLD_X; x++) {
          world.setFast(x, 0, z, COL_BEDROCK, Mat.Bedrock);
        }
      }
    }
    world.rebuildHeights();
    return { maxHeight, columnsRead };
  }
}

/** Fetches and imports a `.vxl` map. */
export async function loadVxlFromUrl(
  world: VoxelWorld,
  url: string,
  options?: VxlLoadOptions,
): Promise<VxlLoadResult> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not fetch map "${url}": ${res.status} ${res.statusText}`);
  return loadVxl(world, await res.arrayBuffer(), options);
}
