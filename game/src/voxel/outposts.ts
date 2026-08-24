/**
 * Jungle outposts.
 *
 * Camps that are already standing when the run starts, scattered through the
 * trees between the firebase and everywhere the player has to walk to. They are
 * not part of any wave: the men in them are waiting rather than advancing, and
 * they stay where they are until somebody gives them a reason not to.
 *
 * Two rules shape where they go. They sit *beside* the road rather than across
 * it — a camp you have to walk through is a toll gate, one you walk past is an
 * ambush you get to decide whether to spring — and they never sit on the
 * firebase's own hill, because the whole point of them is that the danger
 * starts the moment you leave it.
 *
 * Nothing here knows about the AI. This module builds the ground and hands back
 * where the posts are; who stands on them is Game's business.
 */

import type { VoxelWorld } from './VoxelWorld';
import { WORLD_X, WORLD_Y, WORLD_Z, WATER_LEVEL, Mat } from '../core/constants';
import {
  COL_SANDBAG, COL_BAMBOO, COL_BAMBOO_DARK, COL_THATCH, COL_THATCH_DARK,
  COL_PLANK, COL_WOOD, COL_WOOD_DARK, COL_CANVAS,
  COL_DIRT_DARK, COL_LATERITE, COL_LATERITE_DARK, COL_ROCK_DARK, COL_MUD,
} from './palette';

/** A camp, as the rest of the game sees it. */
export interface OutpostSite {
  /** Centre of the pad, at standing height. */
  x: number;
  y: number;
  z: number;
  /** How far from the centre its garrison holds, in blocks. */
  radius: number;
  /** Foot of the flag pole, and the axis it flies along. */
  flag: { x: number; y: number; z: number; dirX: number; dirZ: number };
  /**
   * Standing position on the watchtower platform.
   *
   * A man up here sees over the berm and the first row of trees, which is the
   * whole reason the tower is worth building and the whole reason clearing a
   * camp beats creeping past one: the spotter has a longer look at you than
   * anybody on the ground does.
   */
  tower: { x: number; y: number; z: number };
}

/**
 * How far from its anchor a camp will settle for, and how hard it looks.
 *
 * Each camp is asked for at a specific place (see OUTPOST_ANCHORS in
 * voxel/worldgen.ts) rather than at a random bearing and radius, because where
 * a camp is *is* what it is for: one watching the field, one covering the road,
 * one behind the village. The search here only has to find the flattest patch
 * of ground near the spot somebody already chose, and give up if there isn't
 * one.
 */
const ANCHOR_DRIFT = 34;
const OUTPOST_TRIES = 90;
/** No two camps closer than this: one firefight should not wake both. */
const OUTPOST_SPACING = 44;
/** Radius of the scraped pad. The berm stands just inside it. */
const OUTPOST_R = 8;
/** Ground within this of the road is too exposed to camp on. */
const ROAD_CLEAR = 7;
/** Steepest ground a camp will be scraped into, in blocks across the pad. */
const MAX_RELIEF = 6;

export interface OutpostContext {
  /** Centre of the firebase. Camps face it, and keep their distance from it. */
  base: { x: number; z: number };
  /** Where each camp wants to be, in world coordinates, in priority order. */
  anchors: readonly { x: number; z: number }[];
  /** Terrain heights, in the worldgen layout. Updated where the pad is levelled. */
  heights: Int16Array;
  /** True where the road runs, so camps keep off it. */
  onRoad: (x: number, z: number) => boolean;
  /** True on ground the camp has no business standing on (paddy, village shelf). */
  occupied: (x: number, z: number) => boolean;
}

function heightAt(heights: Int16Array, x: number, z: number): number {
  if (x < 0 || z < 0 || x >= WORLD_X || z >= WORLD_Z) return 0;
  return heights[z * WORLD_X + x];
}

function fill(
  world: VoxelWorld,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  color: number, material: number,
): void {
  for (let y = y0; y <= y1; y++)
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++)
        if (x >= 0 && z >= 0 && y >= 0 && x < WORLD_X && z < WORLD_Z && y < WORLD_Y)
          world.setFast(x, y, z, color, material);
}

function clear(
  world: VoxelWorld,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
): void {
  for (let y = y0; y <= y1; y++)
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++)
        if (x >= 0 && z >= 0 && y >= 0 && x < WORLD_X && z < WORLD_Z && y < WORLD_Y)
          world.setFast(x, y, z, 0, 0);
}

/** Cheap hash in [0,1), so the same camp is scruffy the same way every time. */
function grain(x: number, y: number, z: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Shortest signed angular distance, for the gaps in the berm. */
function angleGap(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
}

/**
 * Places every camp it can find room for and builds them into the world.
 *
 * Runs last in worldgen, after the jungle and the road: the pad is scraped out
 * of whatever ended up there, which is why a camp always looks like it was cut
 * into the trees rather than planted before them.
 */
export function placeOutposts(
  world: VoxelWorld,
  rng: () => number,
  ctx: OutpostContext,
): OutpostSite[] {
  const sites: OutpostSite[] = [];
  const { heights, base } = ctx;

  const nearRoad = (cx: number, cz: number): boolean => {
    for (let dz = -ROAD_CLEAR; dz <= ROAD_CLEAR; dz += 2) {
      for (let dx = -ROAD_CLEAR; dx <= ROAD_CLEAR; dx += 2) {
        const x = cx + dx;
        const z = cz + dz;
        if (x < 0 || z < 0 || x >= WORLD_X || z >= WORLD_Z) continue;
        if (ctx.onRoad(x, z)) return true;
      }
    }
    return false;
  };

  /** Is (cx, cz) somewhere a camp could be scraped? Returns its relief, or -1. */
  const survey = (cx: number, cz: number): number => {
    const margin = OUTPOST_R + 6;
    if (cx < margin || cz < margin || cx >= WORLD_X - margin || cz >= WORLD_Z - margin) return -1;
    if (nearRoad(cx, cz)) return -1;

    for (const s of sites) {
      if (Math.hypot(s.x - cx, s.z - cz) < OUTPOST_SPACING) return -1;
    }

    // Flat, dry, unclaimed ground only. A camp half-buried in a hillside reads
    // as a bug, and one standing in the paddy has nothing to hide behind.
    const g = heightAt(heights, cx, cz);
    if (g <= WATER_LEVEL + 2) return -1;
    let lo = g;
    let hi = g;
    for (let dz = -OUTPOST_R; dz <= OUTPOST_R; dz++) {
      for (let dx = -OUTPOST_R; dx <= OUTPOST_R; dx++) {
        if (dx * dx + dz * dz > OUTPOST_R * OUTPOST_R) continue;
        const x = cx + dx;
        const z = cz + dz;
        if (ctx.occupied(x, z)) return -1;
        const h = heightAt(heights, x, z);
        if (h <= WATER_LEVEL) return -1;
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
    }
    const relief = hi - lo;
    return relief > MAX_RELIEF ? -1 : relief;
  };

  // One camp per anchor, each taking the flattest ground it can find within a
  // short walk of where the layout asked for it. The anchor itself is tried
  // first, so a camp that was asked for somewhere workable ends up exactly
  // there and only wanders when it has to.
  for (const anchor of ctx.anchors) {
    let best: { x: number; z: number } | null = null;
    let bestRelief = Infinity;
    for (let t = 0; t < OUTPOST_TRIES; t++) {
      let cx = Math.round(anchor.x);
      let cz = Math.round(anchor.z);
      if (t > 0) {
        // Spiralling outward, so near misses are looked at before distant ones
        // and a camp never drifts further than it had to.
        const a = rng() * Math.PI * 2;
        const r = (t / OUTPOST_TRIES) * ANCHOR_DRIFT;
        cx = Math.round(anchor.x + Math.cos(a) * r);
        cz = Math.round(anchor.z + Math.sin(a) * r);
      }
      const relief = survey(cx, cz);
      if (relief < 0 || relief >= bestRelief) continue;
      best = { x: cx, z: cz };
      bestRelief = relief;
      if (relief === 0) break;
    }
    if (!best) continue;
    sites.push(buildOutpost(
      world, heights, best.x, best.z, heightAt(heights, best.x, best.z), base, rng,
    ));
  }

  return sites;
}

/**
 * Cuts one camp into the jungle.
 *
 * The order matters: scrape first so everything after it stands on level
 * ground, then the berm, then the things that make it read as lived in. A ring
 * of sandbags on its own is a wall in the woods; the fire, the crates and the
 * washing line are what make it somewhere men have been sitting for a week.
 */
function buildOutpost(
  world: VoxelWorld,
  heights: Int16Array,
  cx: number,
  cz: number,
  g: number,
  base: { x: number; z: number },
  rng: () => number,
): OutpostSite {
  // --- the pad -------------------------------------------------------------
  const outer = OUTPOST_R + 3;
  for (let dz = -outer; dz <= outer; dz++) {
    for (let dx = -outer; dx <= outer; dx++) {
      const d = Math.hypot(dx, dz);
      if (d > outer) continue;
      const x = cx + dx;
      const z = cz + dz;
      if (x < 1 || z < 1 || x >= WORLD_X - 1 || z >= WORLD_Z - 1) continue;
      const i = z * WORLD_X + x;
      const h = heights[i];

      // Everything standing here comes down, pad and feather ring alike: the
      // feather is what stops the camp being a hole in a wall of canopy.
      clear(world, x, Math.min(h, g) + 1, z, x, g + 20, z);
      if (d > OUTPOST_R) continue;

      // Cut and fill to one level, then lay trodden earth over the top of it.
      if (h < g) fill(world, x, h + 1, z, x, g, z, COL_DIRT_DARK, Mat.Dirt);
      const gr = grain(x, 0, z);
      world.setFast(
        x, g, z,
        gr < 0.35 ? COL_LATERITE_DARK : gr < 0.8 ? COL_LATERITE : COL_MUD,
        Mat.Dirt,
      );
      heights[i] = g;
    }
  }

  // --- the berm ------------------------------------------------------------
  // Waist-high sandbags with two gaps in them. The gaps are the point: men
  // leave themselves a way in and out, and so does the player.
  const gapA = rng() * Math.PI * 2;
  const gapB = gapA + Math.PI * (0.6 + rng() * 0.8);
  const ringR = OUTPOST_R - 1;
  for (let dz = -ringR; dz <= ringR; dz++) {
    for (let dx = -ringR; dx <= ringR; dx++) {
      const d = Math.hypot(dx, dz);
      if (d < ringR - 1.1 || d > ringR + 0.2) continue;
      const ang = Math.atan2(dz, dx);
      if (angleGap(ang, gapA) < 0.4 || angleGap(ang, gapB) < 0.32) continue;
      const x = cx + dx;
      const z = cz + dz;
      // Ragged top course: a bagged parapet is stacked by hand, not poured.
      const tall = grain(x, 1, z) > 0.34 ? 2 : 1;
      fill(world, x, g + 1, z, x, g + tall, z, COL_SANDBAG, Mat.Reinforced);
    }
  }

  // --- the watchtower ------------------------------------------------------
  // On the side facing the firebase, because that is the approach these men
  // are here to watch. It is also the one thing in the camp tall enough to see
  // over the first row of trees, which is what makes clearing one worth doing
  // rather than walking around.
  const toBaseX = base.x - cx;
  const toBaseZ = base.z - cz;
  const bl = Math.max(1e-4, Math.hypot(toBaseX, toBaseZ));
  const tx = Math.round(cx + (toBaseX / bl) * (OUTPOST_R - 4));
  const tz = Math.round(cz + (toBaseZ / bl) * (OUTPOST_R - 4));
  const towerFloor = buildWatchtower(world, tx, g, tz);

  // --- the lean-to, opposite it -------------------------------------------
  const sx = Math.round(cx - (toBaseX / bl) * (OUTPOST_R - 4));
  const sz = Math.round(cz - (toBaseZ / bl) * (OUTPOST_R - 4));
  buildShelter(world, sx, g, sz, rng);

  // --- the fire, in the middle where it always is --------------------------
  buildFirePit(world, cx, g, cz);

  // --- odds and ends -------------------------------------------------------
  // Two crates against the berm. Nothing is in them; they are cover, and they
  // are the reason the camp has a silhouette from the outside.
  const ca = rng() * Math.PI * 2;
  for (let i = 0; i < 2; i++) {
    const aa = ca + i * (1.4 + rng());
    const rr = OUTPOST_R - 2.6;
    const bx = Math.round(cx + Math.cos(aa) * rr);
    const bz = Math.round(cz + Math.sin(aa) * rr);
    fill(world, bx, g + 1, bz, bx + 1, g + 2, bz + 1, COL_WOOD, Mat.Wood);
    world.setFast(bx, g + 3, bz, COL_WOOD_DARK, Mat.Wood);
  }

  // --- the flag ------------------------------------------------------------
  // Flown from the berm on the road side, where it can be seen from outside.
  // It is how the player learns to read the treeline: colours over the canopy
  // means men under it.
  const fa = gapA + Math.PI;
  const fx = Math.round(cx + Math.cos(fa) * (OUTPOST_R - 2));
  const fz = Math.round(cz + Math.sin(fa) * (OUTPOST_R - 2));

  return {
    x: cx + 0.5,
    y: g + 1,
    z: cz + 0.5,
    radius: OUTPOST_R,
    flag: {
      x: fx,
      y: g + 1,
      z: fz,
      dirX: Math.cos(fa + Math.PI * 0.5),
      dirZ: Math.sin(fa + Math.PI * 0.5),
    },
    tower: { x: tx + 0.5, y: towerFloor + 1, z: tz + 0.5 },
  };
}

/**
 * Bamboo watchtower: four culms, a plank platform and a thatch cap.
 *
 * Headroom under the cap is deliberate — a man can stand up there, and standing
 * up there he can see you a long way further out than anyone on the ground can.
 */
function buildWatchtower(world: VoxelWorld, tx: number, g: number, tz: number): number {
  const floor = g + 6;

  for (let ox = -1; ox <= 1; ox += 2) {
    for (let oz = -1; oz <= 1; oz += 2) {
      fill(world, tx + ox, g, tz + oz, tx + ox, floor - 1, tz + oz, COL_BAMBOO_DARK, Mat.Wood);
    }
  }

  fill(world, tx - 1, floor, tz - 1, tx + 1, floor, tz + 1, COL_PLANK, Mat.Wood);
  // Waist rail, open on the face the ladder comes up.
  fill(world, tx - 1, floor + 1, tz - 1, tx + 1, floor + 1, tz + 1, COL_BAMBOO, Mat.Wood);
  clear(world, tx, floor + 1, tz, tx, floor + 1, tz);
  clear(world, tx - 1, floor + 1, tz, tx - 1, floor + 1, tz);
  // Corner posts carry the cap three blocks clear of the rail: standing room.
  for (let ox = -1; ox <= 1; ox += 2) {
    for (let oz = -1; oz <= 1; oz += 2) {
      fill(world, tx + ox, floor + 2, tz + oz, tx + ox, floor + 4, tz + oz, COL_BAMBOO_DARK, Mat.Wood);
    }
  }
  fill(world, tx - 2, floor + 5, tz - 2, tx + 2, floor + 5, tz + 2, COL_THATCH, Mat.Wood);
  fill(world, tx - 1, floor + 6, tz - 1, tx + 1, floor + 6, tz + 1, COL_THATCH_DARK, Mat.Wood);

  // Ladder: rungs lashed up the outward face, one block clear of the posts so
  // there is somewhere to put your feet.
  for (let s = 1; s <= 6; s++) {
    fill(world, tx - 2, g + s, tz, tx - 2, g + s, tz, COL_BAMBOO, Mat.Wood);
  }

  return floor;
}

/**
 * Thatch lean-to: two low walls, a sloping roof and somewhere to sleep.
 *
 * Deliberately open on the long side. A closed hut would be a room the player
 * has to clear; an open one is a shape with men behind it, which is the fight
 * this camp is meant to produce.
 */
function buildShelter(world: VoxelWorld, sx: number, g: number, sz: number, rng: () => number): void {
  const y = g + 1;

  // Back wall and one gable of bamboo matting.
  fill(world, sx - 2, y, sz + 1, sx + 2, y + 2, sz + 1, COL_BAMBOO_DARK, Mat.Wood);
  fill(world, sx - 2, y, sz, sx - 2, y + 2, sz, COL_BAMBOO_DARK, Mat.Wood);

  // Roof, sloping down toward the open side.
  fill(world, sx - 3, y + 3, sz + 1, sx + 3, y + 3, sz + 2, COL_THATCH, Mat.Wood);
  fill(world, sx - 3, y + 2, sz - 1, sx + 3, y + 2, sz, COL_THATCH_DARK, Mat.Wood);
  // Posts holding the open eave up.
  fill(world, sx - 3, y, sz - 1, sx - 3, y + 1, sz - 1, COL_WOOD_DARK, Mat.Wood);
  fill(world, sx + 3, y, sz - 1, sx + 3, y + 1, sz - 1, COL_WOOD_DARK, Mat.Wood);

  // A sleeping mat and a hammock slung under the eave, one or the other.
  if (rng() < 0.6) {
    fill(world, sx - 1, y, sz, sx + 1, y, sz, COL_CANVAS, Mat.Wood);
  } else {
    fill(world, sx - 2, y + 1, sz - 1, sx + 2, y + 1, sz - 1, COL_CANVAS, Mat.Wood);
  }
}

/** Ring of stones around a bed of ash. Every camp has one and it is always cold. */
function buildFirePit(world: VoxelWorld, cx: number, g: number, cz: number): void {
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dz === 0) continue;
      if (dx !== 0 && dz !== 0) continue; // a cross, not a square: it reads rounder
      fill(world, cx + dx, g + 1, cz + dz, cx + dx, g + 1, cz + dz, COL_ROCK_DARK, Mat.Stone);
    }
  }
  world.setFast(cx, g, cz, COL_DIRT_DARK, Mat.Dirt);
  // Cooking tripod: three culms leaning in over the ash.
  world.setFast(cx, g + 2, cz, COL_BAMBOO_DARK, Mat.Wood);
}
