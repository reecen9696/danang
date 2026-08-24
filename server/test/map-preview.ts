/**
 * Renders the generated map from above, as a PNG, so a layout change can be
 * looked at rather than reasoned about. Not part of any suite -- it is a
 * development tool, run by hand:
 *
 *   npx tsx test/map-preview.ts [seed] [out.png]
 */
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { VoxelWorld } from '../../game/src/voxel/VoxelWorld';
import { generateWorld } from '../../game/src/voxel/worldgen';
import { palette } from '../../game/src/voxel/palette';
import { WORLD_X, WORLD_Y, WORLD_Z, WATER_LEVEL } from '../../game/src/core/constants';

const seed = Number(process.argv[2] ?? 4242);
const out = process.argv[3] ?? '/tmp/map.png';
/** Optional crop, as `cx,cz,span`, magnified to fill the same image. */
const crop = process.argv[4] ? process.argv[4].split(',').map(Number) : null;

const world = new VoxelWorld();
const layout = generateWorld(world, seed);
world.rebuildHeights();

const rgb = new Uint8Array(WORLD_X * WORLD_Z * 3);
for (let z = 0; z < WORLD_Z; z++) {
  for (let x = 0; x < WORLD_X; x++) {
    let y = WORLD_Y - 1;
    for (; y > 0; y--) if (world.get(x, y, z) !== 0) break;
    const c = world.get(x, y, z);
    let r = palette[c * 3], g = palette[c * 3 + 1], b = palette[c * 3 + 2];
    // Cheap hillshade so relief reads.
    const hl = world.surfaceHeight(x - 1, z) - world.surfaceHeight(x + 1, z);
    const hd = world.surfaceHeight(x, z - 1) - world.surfaceHeight(x, z + 1);
    const shade = Math.max(0.35, Math.min(1.8, 1 + (hl + hd) * 0.16));
    r *= shade; g *= shade; b *= shade;
    if (y <= WATER_LEVEL) { r = r * 0.3 + 40; g = g * 0.3 + 60; b = b * 0.3 + 110; }
    const i = (z * WORLD_X + x) * 3;
    rgb[i] = Math.min(255, r); rgb[i + 1] = Math.min(255, g); rgb[i + 2] = Math.min(255, b);
  }
}

/** Markers get in the way when the point is to look at the ground: NOMARK=1. */
const marks = !process.env.NOMARK;
const mark = (x: number, z: number, r: number, g: number, b: number, s = 3): void => {
  if (!marks) return;
  for (let dz = -s; dz <= s; dz++)
    for (let dx = -s; dx <= s; dx++) {
      const px = Math.round(x) + dx, pz = Math.round(z) + dz;
      if (px < 0 || pz < 0 || px >= WORLD_X || pz >= WORLD_Z) continue;
      const i = (pz * WORLD_X + px) * 3;
      rgb[i] = r; rgb[i + 1] = g; rgb[i + 2] = b;
    }
};
mark(layout.baseCenter.x, layout.baseCenter.z, 255, 255, 255, 4);
mark(layout.townCenter.x, layout.townCenter.z, 255, 0, 255, 4);
if (layout.crashSite) mark(layout.crashSite.x, layout.crashSite.z, 255, 60, 0, 4);
for (const o of layout.outposts) mark(o.x, o.z, 255, 0, 0, 3);
for (const s of layout.spawnPoints) mark(s.x, s.z, 0, 0, 0, 2);
for (const h of layout.spiderHoles) mark(h.x, h.z, 255, 255, 0, 1);

// --- PNG ------------------------------------------------------------------
let table: number[] | null = null;
function crc32(buf: Buffer): number {
  if (!table) {
    table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table.push(c);
    }
  }
  let c = 0xffffffff;
  for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crcBuf]);
};
// The crop is nearest-neighbour magnified: this is a map, and a smoothed one
// hides exactly the single-block detail it is being looked at for.
const outW = crop ? 512 : WORLD_X;
const outH = crop ? 512 : WORLD_Z;
const raw = Buffer.alloc((outW * 3 + 1) * outH);
for (let oz = 0; oz < outH; oz++) {
  const row = oz * (outW * 3 + 1);
  raw[row] = 0;
  for (let ox = 0; ox < outW; ox++) {
    const sx = crop ? Math.round(crop[0] - crop[2] / 2 + (ox / outW) * crop[2]) : ox;
    const sz = crop ? Math.round(crop[1] - crop[2] / 2 + (oz / outH) * crop[2]) : oz;
    const si = (Math.max(0, Math.min(WORLD_Z - 1, sz)) * WORLD_X
      + Math.max(0, Math.min(WORLD_X - 1, sx))) * 3;
    raw[row + 1 + ox * 3] = rgb[si];
    raw[row + 2 + ox * 3] = rgb[si + 1];
    raw[row + 3 + ox * 3] = rgb[si + 2];
  }
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(outW, 0); ihdr.writeUInt32BE(outH, 4);
ihdr[8] = 8; ihdr[9] = 2;
writeFileSync(out, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]));

console.log('wrote', out);
console.log('base', layout.baseCenter, 'town', layout.townCenter);
console.log('crash', layout.crashSite && { x: layout.crashSite.x, z: layout.crashSite.z });
console.log('outposts', layout.outposts.map((o) => `${Math.round(o.x)},${Math.round(o.z)}`).join('  '));
console.log('spawns', layout.spawnPoints.length, 'spiderholes', layout.spiderHoles.length,
  'rice', layout.ricePatches.length, 'merchants', layout.merchantSpots.length);
