/**
 * The downed slick.
 *
 * A UH-1 that came through the canopy north of the village and did not stop
 * until it was most of the way into the treeline. It is the one structure on
 * the map that nobody built: everything else out there was put up by somebody
 * who meant to, and this arrived.
 *
 * Two things make it worth having. It is a landmark on the walk to the shop --
 * the road runs west into the village, so the wreck is the reason to go north
 * instead -- and it is the only place in the game you get a weapon by finding
 * it rather than by paying for it. The crates in the cargo bay are what the
 * ship was carrying when it went in.
 *
 * ## Why it is stamped rather than modelled
 *
 * Everything else in worldgen is written along the world axes, which is fine
 * for a hut and hopeless for a wreck: an airframe square to the grid reads as
 * a parked helicopter, and a parked helicopter is not a crash. So the airframe
 * is authored in its own coordinates -- +X out the nose, +Y up, +Z out the
 * starboard door -- as a short list of boxes, and {@link stamp} walks the world
 * voxels its rotated bounding box covers, transforms each one back into model
 * space, and asks the list what should be there. Yaw, pitch and roll come out
 * of that for free, which is the whole point.
 *
 * The one rule that falls out of doing it that way: **no wall thinner than a
 * block**. A slab of thickness `t` sampled on the unit lattice is guaranteed to
 * catch at least one sample along every axis-aligned line that crosses it only
 * when `t >= 1`; any thinner and the hull comes out full of holes you can see
 * daylight through from inside. That is why the cabin here is a size and a half
 * over a real Huey -- at life size the walls would have to be thinner than the
 * grid can express, and there would be no standing up inside it either.
 *
 * Detail finer than that -- rotor, skids, tail rotor, the gun still on its
 * pintle -- is not here at all. It is drawn client-side as sub-voxel mesh
 * geometry (see fx/Wreck.ts), the same trick the flags use, because a rotor
 * blade a block thick is a plank.
 */

import type { VoxelWorld } from './VoxelWorld';
import { WORLD_X, WORLD_Y, WORLD_Z, WATER_LEVEL, Mat } from '../core/constants';
import { WeaponId } from '../weapons/definitions';
import {
  buildPaletteIndex,
  COL_RUST, COL_BEDROCK, COL_DIRT_DARK, COL_LATERITE, COL_LATERITE_DARK,
  COL_MUD, COL_GRAVEL,
} from './palette';

// ---------------------------------------------------------------------------
// What the rest of the game gets back
// ---------------------------------------------------------------------------

/** One arms crate, already placed in world space and lying at the hull's angle. */
export interface WeaponCacheSpot {
  x: number; y: number; z: number;
  yaw: number; pitch: number; roll: number;
  /** What comes out of it. Empty crates are dressing and aren't listed. */
  weapon: WeaponId;
}

/** The wreck, as the client needs it to hang the fine detail off. */
export interface CrashSite {
  /** Origin of the airframe: centre of the cabin, underside of the floor. */
  x: number; y: number; z: number;
  /** How it came to rest. Applied as yaw, then pitch, then roll. */
  yaw: number; pitch: number; roll: number;
  /** The tail boom, which is somewhere else entirely. Same convention. */
  boom: { x: number; y: number; z: number; yaw: number; pitch: number; roll: number };
  /** Unit vector the ship was travelling along when it went in, in world XZ. */
  headingX: number; headingZ: number;
  /** Ground level under the hull, for anything that needs to sit on it. */
  groundY: number;
  caches: WeaponCacheSpot[];
}

export interface CrashContext {
  /** Centre of the village. The wreck is placed north of it. */
  town: { x: number; z: number };
  /** Terrain heights, in the worldgen layout. Updated where the scar is cut. */
  heights: Int16Array;
  /** True where the road runs, so the wreck doesn't land on it. */
  onRoad: (x: number, z: number) => boolean;
  /** True on ground something else has already claimed. */
  occupied: (x: number, z: number) => boolean;
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/**
 * Where to look, measured north of the village shelf's northern edge.
 *
 * Near enough that it is visibly *the village's* wreck and you can see the
 * rotor over the huts from the market square; far enough out that the fight
 * over it, when the garrison comes to see what the noise was, happens in the
 * trees rather than in the street.
 */
const NORTH_MIN = 26;
const NORTH_MAX = 40;
/** How far either side of the village's axis it may sit. */
const LATERAL = 16;
const TRIES = 160;

/**
 * Ground the wreck needs, as a radius around the hull centre.
 *
 * Only the hull is checked. The scar behind it runs out over another twenty
 * blocks and is allowed to cross anything, because a furrow ploughed through
 * uneven ground is a furrow ploughed through uneven ground.
 */
const PAD_R = 9;
/** Steepest ground it will settle on, in blocks across the pad. */
const MAX_RELIEF = 5;

/**
 * How the ship is lying.
 *
 * It came in from the north-east on a shallow descent, so the nose points
 * south-west and off the grid by a comfortable margin -- far enough that no
 * face of it lines up with a chunk boundary, which is what would give the
 * whole thing away as level geometry. Nose down nine degrees where it dug in,
 * and settled fifteen onto the port side, which lifts the starboard cargo door
 * clear of the dirt. That last number is doing real work: any more and the
 * doorway becomes a hatch in the ceiling and the crates are unreachable.
 */
const YAW = -1.94;
const PITCH = -0.16;
const ROLL = -0.26;
/** Height of the underside above the surface. The port chine digs in from here. */
const BELLY_LIFT = 0.5;

// ---------------------------------------------------------------------------
// The airframe
// ---------------------------------------------------------------------------

/**
 * The wreck's colours, taken out of the build palette rather than the fixed
 * range.
 *
 * Not a shortcut -- the fixed range is full, every one of its sixty-three
 * entries is already spoken for, and the three that come closest to olive drab
 * are grass, jungle canopy and leaf. Painting an airframe in any of them gives
 * you a helicopter you cannot see: the whole reason a wreck reads at two
 * hundred blocks is that it is the one thing in the valley that is not green.
 *
 * So it is drawn in faded khaki instead, which is where olive drab actually
 * goes after a year in the sun, and khaki against jungle is a warm-against-cool
 * contrast rather than a darker-green-against-green one. The greys underneath
 * it do the rest: the deck is burnt out, and burnt is the most legible thing
 * you can put next to foliage.
 */
const HULL = buildPaletteIndex(2, 4);
const HULL_SHADE = buildPaletteIndex(2, 2);
/** Burnt out: the engine deck and everything the fire ran along. */
const SCORCH = buildPaletteIndex(0, 3);
const SOOT = buildPaletteIndex(0, 6);
/** Torn metal, where the paint went with the panel. */
const BARE = buildPaletteIndex(0, 14);
const BARE_DARK = buildPaletteIndex(0, 9);

/**
 * One box in model space, in blocks.
 *
 * `x0..x1` etc. are half-open, so boxes that share a face don't fight over the
 * voxels on it. A `color` of 0 cuts instead of filling -- that is how the
 * doorways and the smashed windscreen are made, and why order matters: the
 * list is read back to front and the first box that contains a voxel wins.
 */
interface Slab {
  x0: number; y0: number; z0: number;
  x1: number; y1: number; z1: number;
  /** Palette index, or 0 to cut air. */
  color: number;
  material?: number;
  /** Leaves this box alone, making the slab a shell. Walls must stay >= 1 thick. */
  inner?: readonly [number, number, number, number, number, number];
  /** Second colour dithered in at `altRate`, so no panel is one flat tone. */
  alt?: number;
  altRate?: number;
}

/**
 * The hull, nose to break.
 *
 * Read as a section: a floor you can stand on, a shell around it, the
 * transmission deck on the roof, and a nose that is shorter and lower than it
 * should be because it hit first. Both cargo doors are cut out -- the starboard
 * one rolled back on its rail, the port one torn off somewhere up the furrow --
 * and the port opening is half in the dirt, which is what makes the starboard
 * side the way in without anything having to say so.
 *
 * Every wall is 1.2 blocks rather than the 1.0 the lattice strictly needs. The
 * extra fifth is margin: at exactly 1.0 the guarantee holds along the world
 * axes and nowhere else, and a wreck that is watertight from the front and
 * porous from the corner is worse than one that is simply a little heavy.
 */
const HULL_SLABS: readonly Slab[] = [
  // --- Cabin shell -----------------------------------------------------
  // Interior 4.8 x 3.0 x 3.2: enough to stand upright in and turn round, which
  // is the floor for somewhere the player is meant to go rather than look at.
  {
    x0: -4.4, y0: 0, z0: -2.8, x1: 2.4, y1: 5.4, z1: 2.8,
    inner: [-3.4, 1.2, -1.6, 1.4, 4.2, 1.6],
    color: HULL, alt: HULL_SHADE, altRate: 0.3,
  },
  // Cabin floor, laid over the shell's own so it reads as a deck from inside.
  { x0: -3.4, y0: 0.4, z0: -1.6, x1: 1.4, y1: 1.2, z1: 1.6, color: HULL_SHADE, alt: BARE_DARK, altRate: 0.18 },

  // --- Cockpit ---------------------------------------------------------
  {
    x0: 2.4, y0: 0.8, z0: -2.6, x1: 4.4, y1: 4.6, z1: 2.6,
    inner: [2.4, 1.8, -1.4, 3.4, 3.6, 1.4],
    color: HULL, alt: HULL_SHADE, altRate: 0.25,
  },
  // Chin, crushed and folded under. Two steps rather than one box: a nose that
  // ends in a flat wall reads as a shipping container with a rotor on it.
  { x0: 4.4, y0: 1.0, z0: -2.2, x1: 5.7, y1: 3.4, z1: 2.2, color: BARE_DARK, alt: SOOT, altRate: 0.35 },
  { x0: 5.7, y0: 1.2, z0: -1.5, x1: 6.6, y1: 2.6, z1: 1.5, color: SOOT, alt: BARE, altRate: 0.3 },

  // --- Transmission deck and engine ------------------------------------
  // Where the fire was, so it is the blackest thing on the map from above and
  // the first part of the wreck you pick out coming down the hill.
  { x0: -2.4, y0: 5.4, z0: -1.8, x1: 1.6, y1: 6.6, z1: 1.8, color: SCORCH, alt: SOOT, altRate: 0.35 },
  // Exhaust stub, aft of the deck and out the back of it.
  { x0: -3.9, y0: 5.2, z0: -1.1, x1: -2.4, y1: 6.4, z1: 1.1, color: COL_RUST, alt: SOOT, altRate: 0.4 },
  // Mast housing the rotor stands on. The blades themselves are mesh.
  { x0: -0.9, y0: 6.6, z0: -0.9, x1: 0.9, y1: 8.0, z1: 0.9, color: BARE_DARK },

  // --- Tail stub, snapped clean ----------------------------------------
  // Everything past this is lying somewhere else. The stub is left ragged and
  // bright, because a break shows bare metal and a cut shows paint.
  { x0: -6.3, y0: 2.6, z0: -1.3, x1: -4.4, y1: 4.8, z1: 1.3, color: HULL, alt: BARE, altRate: 0.45 },

  // --- Openings, cut last so they win ----------------------------------
  // Starboard cargo door, rolled back on its rail. The way in, and the only
  // opening left square enough to walk through rather than climb.
  { x0: -2.7, y0: 1.2, z0: 1.4, x1: 0.1, y1: 4.3, z1: 3.0, color: 0 },
  // Port door, torn off. Opens half into the dirt the ship is lying on.
  { x0: -2.5, y0: 1.8, z0: -3.0, x1: -0.1, y1: 4.3, z1: -1.4, color: 0 },
  // Windscreen and chin bubble, both gone.
  { x0: 3.3, y0: 2.0, z0: -1.6, x1: 4.6, y1: 3.8, z1: 1.6, color: 0 },
  // The tear where the tail let go: a bite out of the top of the stub.
  { x0: -6.4, y0: 3.6, z0: -0.4, x1: -5.1, y1: 4.9, z1: 1.5, color: 0 },
];

/**
 * The tail boom, which is thirty feet away with the fin still on it.
 *
 * Its own origin is the break, so it is stamped with its own transform: a boom
 * that snapped off and then came to rest at the same angle as the hull is a
 * boom that did not snap off. Solid rather than shelled -- nothing gets inside
 * a tail boom, and at this diameter a shell would be one block of wall and one
 * block of nothing.
 */
const BOOM_SLABS: readonly Slab[] = [
  { x0: -5.0, y0: -0.7, z0: -0.7, x1: 0.4, y1: 0.7, z1: 0.7, color: HULL, alt: HULL_SHADE, altRate: 0.3 },
  { x0: -7.6, y0: -0.6, z0: -0.6, x1: -5.0, y1: 0.6, z1: 0.6, color: HULL, alt: BARE_DARK, altRate: 0.2 },
  // Synchronised elevator, the little wing halfway along.
  { x0: -4.1, y0: -0.4, z0: -2.8, x1: -3.0, y1: 0.7, z1: 2.8, color: HULL_SHADE, alt: HULL, altRate: 0.3 },
  // Fin and the 42-degree gearbox at the top of it.
  { x0: -8.6, y0: -0.5, z0: -0.5, x1: -7.4, y1: 2.8, z1: 0.5, color: HULL, alt: HULL_SHADE, altRate: 0.25 },
  { x0: -8.9, y0: 1.9, z0: -0.7, x1: -7.5, y1: 3.2, z1: 0.7, color: BARE_DARK },
  // Ragged break at the near end, matching the stub still on the hull.
  { x0: 0.4, y0: -0.55, z0: -0.55, x1: 1.5, y1: 0.55, z1: 0.55, color: BARE, alt: COL_RUST, altRate: 0.4 },
];

// ---------------------------------------------------------------------------
// Placing it
// ---------------------------------------------------------------------------

/** Cheap hash in [0,1), so the same panel is scorched the same way every run. */
function grain(x: number, y: number, z: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function heightAt(heights: Int16Array, x: number, z: number): number {
  if (x < 0 || z < 0 || x >= WORLD_X || z >= WORLD_Z) return 0;
  return heights[z * WORLD_X + x];
}

/**
 * Rotation as three basis vectors, composed yaw then pitch then roll.
 *
 * Kept as columns rather than as a matrix type so the inverse is just three dot
 * products against the same three vectors -- the transform is applied a few
 * hundred thousand times and there is no reason for it to allocate.
 */
interface Basis {
  /** Model +X, +Y, +Z expressed in world axes. */
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  cx: number; cy: number; cz: number;
}

function makeBasis(yaw: number, pitch: number, roll: number): Basis {
  const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
  const cosP = Math.cos(pitch), sinP = Math.sin(pitch);
  const cosR = Math.cos(roll), sinR = Math.sin(roll);

  // Rz(pitch) * Rx(roll), written out. Model +X is the nose, so pitch is the
  // rotation about +Z (nose up positive) and roll the one about +X.
  const m00 = cosP, m01 = -sinP * cosR, m02 = sinP * sinR;
  const m10 = sinP, m11 = cosP * cosR, m12 = -cosP * sinR;
  const m20 = 0, m21 = sinR, m22 = cosR;

  // Premultiplied by Ry(yaw), one column at a time.
  return {
    ax: cosY * m00 + sinY * m20, ay: m10, az: -sinY * m00 + cosY * m20,
    bx: cosY * m01 + sinY * m21, by: m11, bz: -sinY * m01 + cosY * m21,
    cx: cosY * m02 + sinY * m22, cy: m12, cz: -sinY * m02 + cosY * m22,
  };
}

/** Model space -> world, into the three out params. */
function toWorld(
  b: Basis, ox: number, oy: number, oz: number,
  x: number, y: number, z: number,
  out: { x: number; y: number; z: number },
): void {
  out.x = ox + b.ax * x + b.bx * y + b.cx * z;
  out.y = oy + b.ay * x + b.by * y + b.cy * z;
  out.z = oz + b.az * x + b.bz * y + b.cz * z;
}

function inSlab(s: Slab, x: number, y: number, z: number): boolean {
  if (x < s.x0 || x >= s.x1 || y < s.y0 || y >= s.y1 || z < s.z0 || z >= s.z1) return false;
  const i = s.inner;
  if (i && x >= i[0] && x < i[3] && y >= i[1] && y < i[4] && z >= i[2] && z < i[5]) return false;
  return true;
}

/**
 * Writes one rigid body of slabs into the world at an arbitrary attitude.
 *
 * Sweeps the world box the rotated model covers rather than the model itself:
 * stepping the model and rounding to voxels leaves seams wherever two boxes
 * meet at an angle, and sweeping the destination cannot, because every voxel is
 * decided exactly once. The slab list is read back to front so a cut listed
 * after a shell takes a door out of it.
 */
function stamp(
  world: VoxelWorld,
  slabs: readonly Slab[],
  ox: number, oy: number, oz: number,
  yaw: number, pitch: number, roll: number,
): void {
  const b = makeBasis(yaw, pitch, roll);

  // World bounds: every corner of the model's own bounds, rotated.
  let lx0 = Infinity, ly0 = Infinity, lz0 = Infinity;
  let lx1 = -Infinity, ly1 = -Infinity, lz1 = -Infinity;
  for (const s of slabs) {
    lx0 = Math.min(lx0, s.x0); ly0 = Math.min(ly0, s.y0); lz0 = Math.min(lz0, s.z0);
    lx1 = Math.max(lx1, s.x1); ly1 = Math.max(ly1, s.y1); lz1 = Math.max(lz1, s.z1);
  }
  let wx0 = Infinity, wy0 = Infinity, wz0 = Infinity;
  let wx1 = -Infinity, wy1 = -Infinity, wz1 = -Infinity;
  const p = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < 8; i++) {
    toWorld(
      b, ox, oy, oz,
      i & 1 ? lx1 : lx0, i & 2 ? ly1 : ly0, i & 4 ? lz1 : lz0,
      p,
    );
    wx0 = Math.min(wx0, p.x); wx1 = Math.max(wx1, p.x);
    wy0 = Math.min(wy0, p.y); wy1 = Math.max(wy1, p.y);
    wz0 = Math.min(wz0, p.z); wz1 = Math.max(wz1, p.z);
  }

  const x0 = Math.max(0, Math.floor(wx0)), x1 = Math.min(WORLD_X - 1, Math.ceil(wx1));
  const y0 = Math.max(0, Math.floor(wy0)), y1 = Math.min(WORLD_Y - 1, Math.ceil(wy1));
  const z0 = Math.max(0, Math.floor(wz0)), z1 = Math.min(WORLD_Z - 1, Math.ceil(wz1));

  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        // World -> model: the basis is orthonormal, so its inverse is three
        // dot products against the same three columns.
        const dx = x + 0.5 - ox, dy = y + 0.5 - oy, dz = z + 0.5 - oz;
        const mx = b.ax * dx + b.ay * dy + b.az * dz;
        const my = b.bx * dx + b.by * dy + b.bz * dz;
        const mz = b.cx * dx + b.cy * dy + b.cz * dz;

        for (let i = slabs.length - 1; i >= 0; i--) {
          const s = slabs[i];
          if (!inSlab(s, mx, my, mz)) continue;
          if (s.color === 0) {
            world.setFast(x, y, z, 0, 0);
          } else {
            const useAlt = s.alt !== undefined && grain(x, y, z) < (s.altRate ?? 0.3);
            world.setFast(x, y, z, useAlt ? s.alt! : s.color, s.material ?? Mat.Steel);
          }
          break;
        }
      }
    }
  }
}

/**
 * Finds room north of the village and puts the wreck in it.
 *
 * Returns null when there is nowhere flat enough, which on a generated map
 * should not happen and on an imported one very well might. The caller treats
 * a missing wreck as a map without one rather than as an error: everything
 * downstream reads the site out of the layout and skips if it isn't there.
 */
export function placeCrashSite(
  world: VoxelWorld,
  rng: () => number,
  ctx: CrashContext,
): CrashSite | null {
  const { heights, town } = ctx;

  let best: { x: number; z: number; g: number; relief: number } | null = null;

  for (let t = 0; t < TRIES; t++) {
    const cx = Math.round(town.x + (rng() * 2 - 1) * LATERAL);
    const cz = Math.round(town.z - (NORTH_MIN + rng() * (NORTH_MAX - NORTH_MIN)));

    const margin = PAD_R + 12;
    if (cx < margin || cz < margin || cx >= WORLD_X - margin || cz >= WORLD_Z - margin) continue;

    const g = heightAt(heights, cx, cz);
    if (g <= WATER_LEVEL + 2) continue;

    let lo = g, hi = g;
    let blocked = false;
    for (let dz = -PAD_R; dz <= PAD_R && !blocked; dz++) {
      for (let dx = -PAD_R; dx <= PAD_R; dx++) {
        if (dx * dx + dz * dz > PAD_R * PAD_R) continue;
        const x = cx + dx, z = cz + dz;
        if (ctx.onRoad(x, z) || ctx.occupied(x, z)) { blocked = true; break; }
        const h = heightAt(heights, x, z);
        if (h <= WATER_LEVEL) { blocked = true; break; }
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
    }
    if (blocked) continue;
    const relief = hi - lo;
    if (relief > MAX_RELIEF) continue;

    // Flattest wins, and among equals the northernmost -- a wreck that settled
    // deeper into the trees is a better reason to walk out to it.
    if (!best || relief < best.relief || (relief === best.relief && cz < best.z)) {
      best = { x: cx, z: cz, g, relief };
    }
    if (relief === 0) break;
  }

  if (!best) return null;
  return build(world, heights, best.x, best.z, best.g, rng);
}

/**
 * Cuts the scar, beds the airframe into it and throws the tail clear.
 *
 * Order is the same discipline the outposts use: ground first, so everything
 * after it is standing on the level it will actually be standing on, then the
 * hull, then the pieces that came off it. Doing the scar afterwards would bury
 * the skids in churned earth.
 */
function build(
  world: VoxelWorld,
  heights: Int16Array,
  cx: number,
  cz: number,
  g: number,
  rng: () => number,
): CrashSite {
  const yaw = YAW + (rng() - 0.5) * 0.18;
  // Direction of travel. Model +X is the nose, so this is model +X in world.
  const hx = Math.cos(yaw);
  const hz = -Math.sin(yaw);

  carveScar(world, heights, cx, cz, hx, hz);

  const originY = g + 1 + BELLY_LIFT;
  stamp(world, HULL_SLABS, cx + 0.5, originY, cz + 0.5, yaw, PITCH, ROLL);

  // --- The tail ------------------------------------------------------------
  // Back up the furrow and off to one side, lying almost flat with the fin
  // stood up out of the dirt: that silhouette is legible from a long way off
  // and it is what tells you which way the ship was going before you get close
  // enough to read the hull.
  const boomYaw = yaw + 0.95;
  const boomX = cx + 0.5 - hx * 9.5 - hz * 4.5;
  const boomZ = cz + 0.5 - hz * 9.5 + hx * 4.5;
  const boomG = heightAt(heights, Math.round(boomX), Math.round(boomZ));
  const boom = {
    x: boomX, y: boomG + 1.6, z: boomZ,
    yaw: boomYaw, pitch: 0.1, roll: 1.15,
  };
  stamp(world, BOOM_SLABS, boom.x, boom.y, boom.z, boom.yaw, boom.pitch, boom.roll);

  // --- What it was carrying ------------------------------------------------
  // Both crates are on the cabin floor inside the starboard door, far enough
  // apart that the prompt never has to choose between them and close enough to
  // the opening that you can take either without climbing in -- though the
  // doorway is a block up and a block wide and climbing in is the better story.
  const basis = makeBasis(yaw, PITCH, ROLL);
  const p = { x: 0, y: 0, z: 0 };
  const cache = (lx: number, ly: number, lz: number, weapon: WeaponId): WeaponCacheSpot => {
    toWorld(basis, cx + 0.5, originY, cz + 0.5, lx, ly, lz, p);
    return { x: p.x, y: p.y, z: p.z, yaw, pitch: PITCH, roll: ROLL, weapon };
  };

  return {
    x: cx + 0.5, y: originY, z: cz + 0.5,
    yaw, pitch: PITCH, roll: ROLL,
    boom,
    headingX: hx, headingZ: hz,
    groundY: g + 1,
    caches: [
      cache(-2.1, 1.2, 0.75, WeaponId.MachineGun),
      cache(-0.6, 1.2, 0.55, WeaponId.Thumper),
    ],
  };
}

/**
 * The furrow.
 *
 * Everything about the wreck that says *crash* rather than *helicopter* is in
 * this function. The airframe on its own is a prop; the lane of snapped canopy
 * running back to the north-east, the earth thrown up on either side of it and
 * the ground getting deeper and blacker the closer it comes are the story of
 * how it got there.
 *
 * The lane is cut wider than the gouge and taller than anything standing in it,
 * because a helicopter that came through the trees took the trees with it, and
 * a wreck sitting in unbroken jungle reads as scenery that was placed there.
 */
function carveScar(
  world: VoxelWorld,
  heights: Int16Array,
  cx: number,
  cz: number,
  hx: number,
  hz: number,
): void {
  /** How far back up the approach the ground is disturbed. */
  const RUN = 30;
  /** Half-width of the churned earth at the wreck, tapering to nothing. */
  const WIDE = 6.5;
  /** Half-width of the lane cleared through the canopy. */
  const LANE = 9;

  for (let s = -RUN; s <= 8; s++) {
    // 0 at the far end of the run, 1 at the wreck and beyond it.
    const along = Math.min(1, (s + RUN) / RUN);
    const halfW = 1.5 + WIDE * along * along;
    const halfL = LANE * (0.35 + 0.65 * along);
    const span = Math.ceil(Math.max(halfW, halfL)) + 1;

    for (let o = -span; o <= span; o++) {
      // Step along the heading, offset across it by the perpendicular.
      const x = Math.round(cx + hx * s - hz * o);
      const z = Math.round(cz + hz * s + hx * o);
      if (x < 1 || z < 1 || x >= WORLD_X - 1 || z >= WORLD_Z - 1) continue;

      const d = Math.abs(o);
      const i = z * WORLD_X + x;
      const h = heights[i];
      if (h <= WATER_LEVEL) continue;

      // Anything standing in the lane came down with the ship.
      if (d <= halfL) clearAbove(world, x, h + 1, z);
      if (d > halfW) continue;

      // The gouge: deepest on the centreline, and only near the wreck, where
      // the ship was actually in the ground rather than still flying.
      const depth = along > 0.55 && d < halfW * 0.45 ? 1 : 0;
      const top = h - depth;
      if (depth > 0) {
        for (let y = top + 1; y <= h; y++) world.setFast(x, y, z, 0, 0);
      }

      // Torn earth, blackening toward the wreck. Laterite is what is under the
      // leaf litter here, so a furrow is red before it is anything else.
      const gr = grain(x, 0, z);
      const burn = Math.max(0, along - 0.7) / 0.3;
      const color = gr < burn * 0.55 ? COL_BEDROCK
        : gr < 0.3 ? COL_LATERITE_DARK
          : gr < 0.62 ? COL_LATERITE
            : gr < 0.84 ? COL_DIRT_DARK
              : COL_MUD;
      world.setFast(x, top, z, color, Mat.Dirt);
      heights[i] = top;

      // Spoil thrown up along the lip of the gouge, one block proud. It is the
      // only thing here that stands above the ground, and it is what stops the
      // furrow reading as a painted stripe.
      if (depth > 0 && d >= halfW * 0.45 - 1 && d < halfW * 0.45 + 1 && gr > 0.66) {
        world.setFast(x, top + 1, z, gr > 0.86 ? COL_GRAVEL : COL_DIRT_DARK, Mat.Dirt);
        heights[i] = top + 1;
      }
    }
  }
}

/** Takes out everything standing on a column, up to canopy height. */
function clearAbove(world: VoxelWorld, x: number, y0: number, z: number): void {
  const top = Math.min(WORLD_Y - 1, y0 + 26);
  for (let y = y0; y <= top; y++) world.setFast(x, y, z, 0, 0);
}
