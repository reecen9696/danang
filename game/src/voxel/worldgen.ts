import { VoxelWorld } from './VoxelWorld';
import { WORLD_X, WORLD_Y, WORLD_Z, WATER_LEVEL, Mat } from '../core/constants';
import {
  COL_GRASS, COL_GRASS_DRY, COL_MOSS,
  COL_DIRT, COL_DIRT_DARK, COL_MUD,
  COL_SAND_DARK,
  COL_ROCK, COL_ROCK_DARK, COL_CLIFF, COL_CLIFF_DARK, COL_GRAVEL,
  COL_BEDROCK,
  COL_TRUNK, COL_TRUNK_DARK, COL_TRUNK_PALE,
  COL_LEAF, COL_PALM, COL_BUSH,
  COL_WOOD, COL_WOOD_DARK, COL_PLANK,
  COL_CONCRETE_DARK, COL_STEEL, COL_STEEL_DARK,
  COL_CORE, COL_SANDBAG, COL_CANVAS,
  COL_LATERITE, COL_LATERITE_DARK, COL_PADDY_WATER, COL_PADDY_MUD,
  COL_RICE, COL_RICE_DRY, COL_BAMBOO, COL_BAMBOO_DARK,
  COL_THATCH, COL_THATCH_DARK, COL_TILE, COL_TILE_DARK,
  COL_STUCCO, COL_STUCCO_OCHRE,
  COL_JUNGLE, COL_JUNGLE_DARK, COL_JUNGLE_LIGHT,
} from './palette';

// ---------------------------------------------------------------------------
// Deterministic noise. No dependencies, no allocation.
// ---------------------------------------------------------------------------
function hash2(x: number, y: number, seed: number): number {
  let h = x * 374761393 + y * 668265263 + seed * 2147483647;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = smooth(x - xi);
  const yf = smooth(y - yi);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return (a * (1 - xf) + b * xf) * (1 - yf) + (c * (1 - xf) + d * xf) * yf;
}

function fbm(x: number, y: number, seed: number, octaves: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * freq, y * freq, seed + i * 97) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/** Ridged noise — gives sharp mountain crests rather than rolling blobs. */
function ridged(x: number, y: number, seed: number, octaves: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(valueNoise(x * freq, y * freq, seed + i * 131) * 2 - 1);
    sum += n * n * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/** Simple RNG so scatter placement is reproducible for a given seed. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Map layout
// ---------------------------------------------------------------------------
export const BASE_CENTER = { x: WORLD_X / 2, z: WORLD_Z / 2 };
/** Height of the firebase hilltop's flat top. */
export const BASE_PLATEAU_Y = 30;
/**
 * Flat buildable top.
 *
 * Sized off the real thing rather than off castle logic: a Vietnam fire support
 * base was a hilltop an engineer platoon scraped flat in a day or two, and the
 * perimeter was something you could walk in well under a minute. Small is the
 * point -- the whole position has to sit inside the range at which the men on
 * the berm can cover each other, so the compound is barely wider than a couple
 * of hooches end to end, and everything beyond the wire is cleared field of
 * fire.
 */
const MESA_TOP_R = 14;
/** Cliff band — deliberately too steep to climb, so ramps are the way in. */
const MESA_CLIFF_R = 18;
const MESA_BLEND_R = 30;
/** Three approach ramps: the chokepoints the whole defense is built around. */
const RAMP_COUNT = 3;
const RAMP_OUTER_R = 30;
const RAMP_HALF_WIDTH = 4;

export const TOWN_CENTER = { x: WORLD_X / 2 + 64, z: WORLD_Z / 2 - 10 };
export const TOWN_RADIUS = 17;
const TOWN_Y = 24;

/**
 * Rice paddies, on the flat immediately south of the firebase.
 *
 * A paddy is a grid of flooded plots held apart by earth bunds, and it steps
 * *down* towards the water because that is the only way it can be irrigated --
 * each terrace drains into the one below. So the field is one block taller per
 * plot column going east, and the bunds double as the footpaths through it.
 *
 * This one sits right under the hill, close enough that it is the first thing
 * the player sees off the spawn and inside the fog distance from the parapet.
 * That proximity is the point: the field is worked ground with people on it,
 * so the approach the enemy uses is somewhere that visibly belongs to someone.
 *
 * Placement is constrained on three sides: clear of the mesa's blend skirt
 * (MESA_BLEND_R + 4) so the flattening doesn't eat the cliff, clear of the
 * river channel to the west so it doesn't dam it, and clear of the town shelf.
 */
export const PADDY_CENTER = { x: WORLD_X / 2 - 4, z: WORLD_Z / 2 + 52 };
/** Interior span of one plot; +1 for the bund on each axis gives the pitch. */
const PADDY_PLOT = 9;
const PADDY_PITCH = PADDY_PLOT + 1;
const PADDY_PLOTS_X = 5;
const PADDY_PLOTS_Z = 4;
const PADDY_X0 = Math.round(PADDY_CENTER.x - (PADDY_PLOTS_X * PADDY_PITCH) / 2);
const PADDY_Z0 = Math.round(PADDY_CENTER.z - (PADDY_PLOTS_Z * PADDY_PITCH) / 2);
const PADDY_X1 = PADDY_X0 + PADDY_PLOTS_X * PADDY_PITCH;
const PADDY_Z1 = PADDY_Z0 + PADDY_PLOTS_Z * PADDY_PITCH;
/** Level of the lowest (westernmost) terrace. Must clear WATER_LEVEL. */
const PADDY_BASE_Y = 21;

/** Terrace level of the plot column containing `x`. */
function paddyLevel(x: number): number {
  const col = clamp(Math.floor((x - PADDY_X0) / PADDY_PITCH), 0, PADDY_PLOTS_X - 1);
  return PADDY_BASE_Y + col;
}

/**
 * The field's extent and terracing, for anything that needs to walk it.
 *
 * Exported because the farmers working the paddy (fx/Farmers.ts) are drawn as
 * sub-voxel scenery rather than as blocks, so they need to know where the mud
 * is and how high each terrace sits without re-deriving it from the world.
 */
export const PADDY = {
  x0: PADDY_X0,
  x1: PADDY_X1,
  z0: PADDY_Z0,
  z1: PADDY_Z1,
  pitch: PADDY_PITCH,
  plotsX: PADDY_PLOTS_X,
  plotsZ: PADDY_PLOTS_Z,
  baseY: PADDY_BASE_Y,
} as const;

/**
 * Standing height for a point in the field.
 *
 * The flooded floor of a plot is one voxel of paddy water at `level`, so you
 * stand on top of it at `level + 1`; the bunds between plots are laid a block
 * proud of that, so the footpaths are at `level + 2`. Outside the field this
 * returns the nearest terrace's plot floor, which is close enough for the
 * short walk in off the margin.
 */
export function paddyGroundY(x: number, z: number): number {
  const level = paddyLevel(x);
  const onBundX = Math.abs(((x - PADDY_X0) % PADDY_PITCH + PADDY_PITCH) % PADDY_PITCH) < 1;
  const offZ = ((z - PADDY_Z0) % PADDY_PITCH + PADDY_PITCH) % PADDY_PITCH;
  const onBundZ = offZ < 1;
  return level + (onBundX || onBundZ ? 2 : 1);
}

/** True if `x, z` is inside a flooded plot (not on a bund, not off the field). */
export function inPaddyMud(x: number, z: number): boolean {
  if (x < PADDY_X0 + 1 || x > PADDY_X1 - 1 || z < PADDY_Z0 + 1 || z > PADDY_Z1 - 1) return false;
  const offX = ((x - PADDY_X0) % PADDY_PITCH + PADDY_PITCH) % PADDY_PITCH;
  const offZ = ((z - PADDY_Z0) % PADDY_PITCH + PADDY_PITCH) % PADDY_PITCH;
  return offX >= 1 && offX <= PADDY_PITCH - 1 && offZ >= 1 && offZ <= PADDY_PITCH - 1;
}

export interface MapLayout {
  baseCenter: { x: number; y: number; z: number };
  townCenter: { x: number; y: number; z: number };
  spawnPoints: { x: number; y: number; z: number }[];
  corePosition: { x: number; y: number; z: number };
  playerSpawn: { x: number; y: number; z: number };
  merchantSpots: { x: number; y: number; z: number }[];
  /** World-space positions of the ramp mouths, for HUD hints and spawn biasing. */
  rampMouths: { x: number; z: number }[];
  /**
   * Where flags fly. Only the client draws these -- they're sub-voxel scenery
   * built as mesh geometry (see fx/Flags.ts), not blocks -- so the server
   * receives the field and ignores it.
   */
  flagSites: { x: number; y: number; z: number; dirX: number; dirZ: number; us?: boolean }[];
}

function plateauBlend(dist: number, radius: number, feather: number): number {
  if (dist <= radius) return 1;
  if (dist >= radius + feather) return 0;
  return smooth(1 - (dist - radius) / feather);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ---------------------------------------------------------------------------
export function generateWorld(world: VoxelWorld, seed = 1337): MapLayout {
  const heights = new Int16Array(WORLD_X * WORLD_Z);
  const rockiness = new Float32Array(WORLD_X * WORLD_Z);
  const moisture = new Float32Array(WORLD_X * WORLD_Z);
  const rng = makeRng(seed * 7919 + 13);

  const rampAngles: number[] = [];
  for (let i = 0; i < RAMP_COUNT; i++) rampAngles.push((i / RAMP_COUNT) * Math.PI * 2 + 0.6);

  // --- river path: a gentle S sweeping across the lowlands -------------------
  const riverAt = (z: number): number =>
    WORLD_X * 0.22
    + Math.sin(z / 58) * 26
    + Math.sin(z / 23 + 1.7) * 9;

  // -------------------------------------------------------------------------
  // 1. Heightmap
  // -------------------------------------------------------------------------
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      const i = z * WORLD_X + x;

      // Domain warp: pushes the noise around so ridges meander instead of
      // looking like obvious lumpy fBm.
      const wx = fbm(x / 140, z / 140, seed + 501, 3) - 0.5;
      const wz = fbm(x / 140, z / 140, seed + 977, 3) - 0.5;
      const nx = (x + wx * 60) / 96;
      const nz = (z + wz * 60) / 96;

      const base = fbm(nx, nz, seed, 5);

      // Highland mask puts the rocky ridges on one side of the map.
      const region = fbm(x / 190, z / 190, seed + 313, 3);
      const highland = clamp((region - 0.46) * 3.4, 0, 1);
      const crest = ridged(nx * 1.7, nz * 1.7, seed + 61, 4);

      let height = 12 + base * 22 + highland * crest * 30;

      // Coastal falloff so the map reads as an island.
      const ex = Math.min(x, WORLD_X - 1 - x) / (WORLD_X * 0.5);
      const ez = Math.min(z, WORLD_Z - 1 - z) / (WORLD_Z * 0.5);
      const edge = clamp(Math.min(ex, ez) * 3.0, 0, 1);
      height = (WATER_LEVEL - 7) + (height - (WATER_LEVEL - 7)) * smooth(edge);

      // River carving.
      const rx = riverAt(z);
      const riverDist = Math.abs(x - rx);
      const riverW = 7 + fbm(x / 40, z / 40, seed + 733, 2) * 5;
      if (riverDist < riverW + 9) {
        const cut = 1 - smooth(clamp((riverDist - riverW) / 9, 0, 1));
        const bed = WATER_LEVEL - 3.5;
        height = lerp(height, Math.min(height, bed), cut);
      }

      rockiness[i] = highland * crest;
      moisture[i] = fbm(x / 70, z / 70, seed + 211, 3);
      heights[i] = Math.round(height);
    }
  }

  // -------------------------------------------------------------------------
  // 2. Carve the fort mesa and its ramps
  // -------------------------------------------------------------------------
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      const i = z * WORLD_X + x;
      const dx = x - BASE_CENTER.x;
      const dz = z - BASE_CENTER.z;
      const d = Math.hypot(dx, dz);
      if (d > MESA_BLEND_R + 4) continue;

      const natural = heights[i];
      let h: number;

      if (d <= MESA_TOP_R) {
        h = BASE_PLATEAU_Y;
      } else if (d <= MESA_CLIFF_R) {
        // Near-vertical drop: unclimbable, so the ramps matter.
        const t = (d - MESA_TOP_R) / (MESA_CLIFF_R - MESA_TOP_R);
        h = lerp(BASE_PLATEAU_Y, BASE_PLATEAU_Y - 9, smooth(t));
      } else {
        const t = clamp((d - MESA_CLIFF_R) / (MESA_BLEND_R - MESA_CLIFF_R), 0, 1);
        h = lerp(BASE_PLATEAU_Y - 9, natural, smooth(t));
      }

      // Ramps override the cliff with a walkable grade.
      const angle = Math.atan2(dz, dx);
      for (const ra of rampAngles) {
        let da = angle - ra;
        while (da > Math.PI) da -= Math.PI * 2;
        while (da < -Math.PI) da += Math.PI * 2;
        const lateral = Math.abs(da) * d;
        // Ramp widens slightly as it descends.
        const halfW = RAMP_HALF_WIDTH + (d - MESA_TOP_R) * 0.12;
        if (lateral > halfW || d > RAMP_OUTER_R) continue;

        const t = clamp((d - MESA_TOP_R) / (RAMP_OUTER_R - MESA_TOP_R), 0, 1);
        const outerH = heights[i];
        const rampH = lerp(BASE_PLATEAU_Y, outerH, smooth(t));
        // Blend the ramp edges into the cliff so it reads as a cut, not a bridge.
        const edgeT = clamp(1 - (lateral / halfW), 0, 1);
        h = lerp(h, rampH, smooth(clamp(edgeT * 1.6, 0, 1)));
      }

      heights[i] = Math.round(h);
    }
  }

  // -------------------------------------------------------------------------
  // 3. Town shelf
  // -------------------------------------------------------------------------
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      const d = Math.hypot(x - TOWN_CENTER.x, z - TOWN_CENTER.z);
      const b = plateauBlend(d, TOWN_RADIUS, 14);
      if (b <= 0) continue;
      const i = z * WORLD_X + x;
      heights[i] = Math.round(lerp(heights[i], TOWN_Y, b));
    }
  }

  // Paddy terraces. Flattened per plot column rather than to one level, so the
  // field steps down towards the river instead of sitting on a plinth.
  for (let z = PADDY_Z0 - 8; z <= PADDY_Z1 + 8; z++) {
    if (z < 0 || z >= WORLD_Z) continue;
    for (let x = PADDY_X0 - 8; x <= PADDY_X1 + 8; x++) {
      if (x < 0 || x >= WORLD_X) continue;
      // How far outside the field rectangle this column is, feathered so the
      // surrounding jungle floor ramps up to the bunds instead of stepping.
      const ox = Math.max(0, Math.max(PADDY_X0 - x, x - PADDY_X1));
      const oz = Math.max(0, Math.max(PADDY_Z0 - z, z - PADDY_Z1));
      const b = plateauBlend(Math.hypot(ox, oz), 0, 8);
      if (b <= 0) continue;
      const i = z * WORLD_X + x;
      heights[i] = Math.round(lerp(heights[i], paddyLevel(x), b));
    }
  }

  for (let i = 0; i < heights.length; i++) {
    heights[i] = clamp(heights[i], 2, WORLD_Y - 14);
  }

  // -------------------------------------------------------------------------
  // 4. Fill columns, colouring by slope / height / moisture
  // -------------------------------------------------------------------------
  const heightAt = (x: number, z: number): number => {
    if (x < 0 || z < 0 || x >= WORLD_X || z >= WORLD_Z) return 0;
    return heights[z * WORLD_X + x];
  };

  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      const i = z * WORLD_X + x;
      const h = heights[i];

      // Slope drives whether we see grass or exposed rock.
      const slope = Math.max(
        Math.abs(h - heightAt(x + 1, z)),
        Math.abs(h - heightAt(x - 1, z)),
        Math.abs(h - heightAt(x, z + 1)),
        Math.abs(h - heightAt(x, z - 1)),
      );

      const speck = hash2(x, z, seed + 555);
      const wet = moisture[i];
      const rock = rockiness[i];

      for (let y = 0; y <= h; y++) {
        let color: number;
        let material: number;

        if (y === 0) {
          color = COL_BEDROCK;
          material = Mat.Bedrock;
        } else if (y < h - 5) {
          color = speck > 0.5 ? COL_ROCK : COL_ROCK_DARK;
          material = Mat.Stone;
        } else if (y < h) {
          // Subsurface: rock under cliffs, dirt under soil.
          if (slope >= 3 || rock > 0.42) {
            color = speck > 0.5 ? COL_CLIFF_DARK : COL_ROCK_DARK;
            material = Mat.Stone;
          } else {
            color = speck > 0.5 ? COL_DIRT : COL_DIRT_DARK;
            material = Mat.Dirt;
          }
        } else {
          // Surface voxel.
          // Delta silt, not holiday sand: the waterline here is mud with a
          // little washed grit in it.
          if (h <= WATER_LEVEL + 1) {
            color = speck > 0.5 ? COL_PADDY_MUD : COL_MUD;
            material = Mat.Dirt;
          } else if (h <= WATER_LEVEL + 3 && slope < 2) {
            color = speck > 0.6 ? COL_SAND_DARK : COL_MUD;
            material = Mat.Dirt;
          } else if (slope >= 3) {
            // Bare karst. The grey limestone crags are as much a part of the
            // look as the green is.
            color = speck > 0.5 ? COL_CLIFF : COL_CLIFF_DARK;
            material = Mat.Stone;
          } else if (rock > 0.5) {
            color = speck > 0.5 ? COL_GRAVEL : COL_ROCK;
            material = Mat.Stone;
          } else if (slope >= 2) {
            // Laterite. Anywhere the ground tips enough to shed its cover, the
            // red earth underneath shows -- cut banks, trail sides, hillsides.
            color = speck > 0.5 ? COL_LATERITE : COL_LATERITE_DARK;
            material = Mat.Dirt;
          } else if (wet < 0.36) {
            color = speck > 0.5 ? COL_LATERITE : COL_GRASS_DRY;
            material = Mat.Dirt;
          } else if (wet > 0.60) {
            color = speck > 0.5 ? COL_JUNGLE_DARK : COL_MOSS;
            material = Mat.Dirt;
          } else {
            color = speck > 0.66 ? COL_JUNGLE_LIGHT : (speck > 0.33 ? COL_GRASS : COL_JUNGLE);
            material = Mat.Dirt;
          }
        }
        world.setFast(x, y, z, color, material);
      }

      // Muddy riverbed just under the waterline.
      if (h < WATER_LEVEL - 1 && h > 1) {
        world.setFast(x, h, z, speck > 0.5 ? COL_MUD : COL_DIRT_DARK, Mat.Dirt);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 5. Layout anchors
  // -------------------------------------------------------------------------
  const layout: MapLayout = {
    baseCenter: { x: BASE_CENTER.x, y: BASE_PLATEAU_Y + 1, z: BASE_CENTER.z },
    townCenter: { x: TOWN_CENTER.x, y: TOWN_Y + 1, z: TOWN_CENTER.z },
    spawnPoints: [],
    corePosition: { x: BASE_CENTER.x, y: BASE_PLATEAU_Y + 2, z: BASE_CENTER.z },
    playerSpawn: { x: BASE_CENTER.x, y: BASE_PLATEAU_Y + 1, z: BASE_CENTER.z + 5 },
    merchantSpots: [],
    rampMouths: [],
    flagSites: [],
  };

  for (const ra of rampAngles) {
    layout.rampMouths.push({
      x: BASE_CENTER.x + Math.cos(ra) * RAMP_OUTER_R,
      z: BASE_CENTER.z + Math.sin(ra) * RAMP_OUTER_R,
    });
  }

  // -------------------------------------------------------------------------
  // 6. Scenery — the part that makes it feel like a place
  // -------------------------------------------------------------------------
  const nearBase = (x: number, z: number): number => Math.hypot(x - BASE_CENTER.x, z - BASE_CENTER.z);
  const nearTown = (x: number, z: number): number => Math.hypot(x - TOWN_CENTER.x, z - TOWN_CENTER.z);

  const onRamp = (x: number, z: number): boolean => {
    const dx = x - BASE_CENTER.x;
    const dz = z - BASE_CENTER.z;
    const d = Math.hypot(dx, dz);
    if (d > RAMP_OUTER_R + 3 || d < MESA_TOP_R - 2) return false;
    const angle = Math.atan2(dz, dx);
    for (const ra of rampAngles) {
      let da = angle - ra;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      if (Math.abs(da) * d < RAMP_HALF_WIDTH + 4) return true;
    }
    return false;
  };

  scatterScenery(world, heights, rockiness, moisture, rng, {
    nearBase, nearTown, onRamp, heightAt, riverAt,
  });

  // -------------------------------------------------------------------------
  // 7. Structures
  // -------------------------------------------------------------------------
  buildStarterFort(world, layout);
  buildTown(world, layout, heights);
  buildRicePaddies(world, layout, heights, rng);

  // -------------------------------------------------------------------------
  // 8. Perimeter spawns, biased toward the ramp approaches
  // -------------------------------------------------------------------------
  const spawnRadius = 100;
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    const sx = clamp(Math.round(BASE_CENTER.x + Math.cos(a) * spawnRadius), 6, WORLD_X - 7);
    const sz = clamp(Math.round(BASE_CENTER.z + Math.sin(a) * spawnRadius), 6, WORLD_Z - 7);
    layout.spawnPoints.push({
      x: sx + 0.5,
      y: Math.max(WATER_LEVEL + 1, heightAt(sx, sz) + 1),
      z: sz + 0.5,
    });
  }

  return layout;
}

// ---------------------------------------------------------------------------
// Scenery scattering
// ---------------------------------------------------------------------------
interface ScatterCtx {
  nearBase: (x: number, z: number) => number;
  nearTown: (x: number, z: number) => number;
  onRamp: (x: number, z: number) => boolean;
  heightAt: (x: number, z: number) => number;
  riverAt: (z: number) => number;
}

function scatterScenery(
  world: VoxelWorld,
  heights: Int16Array,
  rockiness: Float32Array,
  moisture: Float32Array,
  rng: () => number,
  ctx: ScatterCtx,
): void {
  // Jittered grid keeps things evenly spread without expensive Poisson sampling.
  // Tighter than a temperate map wants: jungle canopy is near-continuous, and
  // at CELL 5 the gaps between trees read as parkland rather than as jungle.
  const CELL = 4;
  for (let cz = 0; cz < WORLD_Z; cz += CELL) {
    for (let cx = 0; cx < WORLD_X; cx += CELL) {
      const x = cx + Math.floor(rng() * CELL);
      const z = cz + Math.floor(rng() * CELL);
      if (x < 3 || z < 3 || x >= WORLD_X - 3 || z >= WORLD_Z - 3) continue;

      const i = z * WORLD_X + x;
      const h = heights[i];
      if (h <= WATER_LEVEL) continue;

      // Keep the fort's top, the ramps and the town clear.
      const db = ctx.nearBase(x, z);
      if (db < MESA_CLIFF_R + 4) continue;
      if (ctx.onRamp(x, z)) continue;
      if (ctx.nearTown(x, z) < TOWN_RADIUS + 5) continue;
      // Paddies are worked ground; nothing self-seeds in them.
      if (x >= PADDY_X0 - 3 && x <= PADDY_X1 + 3 && z >= PADDY_Z0 - 3 && z <= PADDY_Z1 + 3) continue;

      const slope = Math.max(
        Math.abs(h - ctx.heightAt(x + 1, z)),
        Math.abs(h - ctx.heightAt(x - 1, z)),
        Math.abs(h - ctx.heightAt(x, z + 1)),
        Math.abs(h - ctx.heightAt(x, z - 1)),
      );

      const rock = rockiness[i];
      const wet = moisture[i];
      const roll = rng();

      // Boulders like steep, rocky ground.
      if (rock > 0.45 || slope >= 3) {
        if (roll < 0.22) placeBoulder(world, x, h, z, rng);
        continue;
      }

      if (slope > 2) continue;

      const beach = h <= WATER_LEVEL + 3;
      const riverDist = Math.abs(x - ctx.riverAt(z));

      if (beach || riverDist < 14) {
        // Riverbank: coconut palms over banana and scrub.
        if (roll < 0.18) plantPalm(world, x, h, z, rng);
        else if (roll < 0.32) plantBanana(world, x, h, z, rng);
        else if (roll < 0.50) plantBush(world, x, h, z, rng, COL_BUSH);
        continue;
      }

      // Canopy density from the moisture field. The floor is much higher than a
      // temperate forest's -- dry ground still carries scrub and bamboo, and
      // there is no altitude band where the trees stop.
      const forest = clamp((wet - 0.16) * 2.1, 0, 1);
      if (roll < forest * 0.80) {
        const pick = rng();
        if (pick < 0.30) plantBamboo(world, x, h, z, rng);
        else if (pick < 0.40) plantPalm(world, x, h, z, rng);
        else if (pick < 0.48) plantBanana(world, x, h, z, rng);
        else plantBroadleaf(world, x, h, z, rng);
      } else if (roll < forest * 0.80 + 0.16) {
        plantBush(world, x, h, z, rng, rng() < 0.5 ? COL_BUSH : COL_JUNGLE_DARK);
      } else if (roll > 0.96) {
        placeBoulder(world, x, h, z, rng);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Foliage
// ---------------------------------------------------------------------------
function setIfAir(world: VoxelWorld, x: number, y: number, z: number, color: number, mat: number): void {
  if (x < 0 || z < 0 || y < 0 || x >= WORLD_X || z >= WORLD_Z || y >= WORLD_Y) return;
  if (world.get(x, y, z) !== 0) return;
  world.setFast(x, y, z, color, mat);
}

/** Broadleaf jungle tree: tall bare trunk under a heavy rounded crown. */
function plantBroadleaf(world: VoxelWorld, x: number, groundY: number, z: number, rng: () => number): void {
  const height = 7 + Math.floor(rng() * 5);
  const trunkCol = rng() < 0.25 ? COL_TRUNK_PALE : (rng() < 0.5 ? COL_TRUNK : COL_TRUNK_DARK);
  // No autumn in the tropics -- the variation comes from new growth catching
  // the light against the older, darker canopy instead.
  const leafA = COL_JUNGLE;
  const leafB = COL_JUNGLE_DARK;
  const leafC = rng() < 0.5 ? COL_JUNGLE_LIGHT : COL_LEAF;

  const base = groundY + 1;
  for (let y = 0; y < height; y++) {
    setIfAir(world, x, base + y, z, trunkCol, Mat.Wood);
  }

  // Canopy: a squashed ellipsoid with a noisy edge.
  const cy = base + height;
  const rx = 2 + Math.floor(rng() * 2);
  const ry = 2 + Math.floor(rng() * 2);
  for (let dy = -ry; dy <= ry; dy++) {
    for (let dz = -rx; dz <= rx; dz++) {
      for (let dx = -rx; dx <= rx; dx++) {
        const n = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry * 1.1) + (dz * dz) / (rx * rx);
        if (n > 1) continue;
        if (n > 0.62 && rng() < 0.42) continue;
        const c = n < 0.3 ? leafB : (rng() < 0.3 ? leafC : leafA);
        setIfAir(world, x + dx, cy + dy, z + dz, c, Mat.Wood);
      }
    }
  }
}

/**
 * Bamboo clump. Bamboo is the plant that actually reads as "Vietnam" at voxel
 * scale: dead-straight, taller than it has any right to be, and growing in
 * tight stands rather than scattered like trees. Leaves only at the tip, so a
 * stand reads as a screen of vertical lines with a green haze on top.
 */
function plantBamboo(world: VoxelWorld, x: number, groundY: number, z: number, rng: () => number): void {
  const culms = 3 + Math.floor(rng() * 5);
  for (let c = 0; c < culms; c++) {
    const ox = Math.round((rng() - 0.5) * 4);
    const oz = Math.round((rng() - 0.5) * 4);
    const height = 7 + Math.floor(rng() * 7);
    const col = rng() < 0.4 ? COL_BAMBOO_DARK : COL_BAMBOO;
    const base = groundY + 1;
    for (let y = 0; y < height; y++) {
      setIfAir(world, x + ox, base + y, z + oz, col, Mat.Wood);
    }
    const tip = base + height;
    for (let k = 0; k < 5; k++) {
      setIfAir(
        world,
        x + ox + Math.round((rng() - 0.5) * 3),
        tip - Math.floor(rng() * 3),
        z + oz + Math.round((rng() - 0.5) * 3),
        rng() < 0.4 ? COL_JUNGLE_LIGHT : COL_JUNGLE,
        Mat.Wood,
      );
    }
  }
}

/**
 * Banana / elephant ear: a stubby trunk carrying a few outsized leaves that
 * droop a block as they reach out. Fills the understory the bamboo leaves bare.
 */
function plantBanana(world: VoxelWorld, x: number, groundY: number, z: number, rng: () => number): void {
  const height = 2 + Math.floor(rng() * 2);
  const base = groundY + 1;
  for (let y = 0; y < height; y++) {
    setIfAir(world, x, base + y, z, COL_BAMBOO_DARK, Mat.Wood);
  }
  const cy = base + height;
  setIfAir(world, x, cy, z, COL_JUNGLE, Mat.Wood);
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]];
  for (const [dx, dz] of dirs) {
    if (rng() < 0.25) continue;
    setIfAir(world, x + dx, cy, z + dz, COL_JUNGLE_LIGHT, Mat.Wood);
    setIfAir(world, x + dx * 2, cy - 1, z + dz * 2, COL_JUNGLE, Mat.Wood);
  }
}

/** Palm — bare curved trunk with a frond crown. */
function plantPalm(world: VoxelWorld, x: number, groundY: number, z: number, rng: () => number): void {
  const height = 6 + Math.floor(rng() * 4);
  const leanX = rng() < 0.5 ? 1 : -1;
  const leanZ = rng() < 0.5 ? 1 : -1;
  let tx = x;
  let tz = z;
  const base = groundY + 1;
  for (let y = 0; y < height; y++) {
    setIfAir(world, tx, base + y, tz, COL_TRUNK_PALE, Mat.Wood);
    // Curve the trunk as it rises.
    if (y === Math.floor(height * 0.55)) tx += leanX;
    if (y === Math.floor(height * 0.8)) tz += leanZ;
  }

  const cy = base + height;
  setIfAir(world, tx, cy, tz, COL_TRUNK, Mat.Wood);
  // Four drooping fronds.
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [dx, dz] of dirs) {
    for (let s = 1; s <= 3; s++) {
      const fy = cy + (s >= 3 ? -1 : 0);
      setIfAir(world, tx + dx * s, fy, tz + dz * s, COL_PALM, Mat.Wood);
      if (s === 2) {
        setIfAir(world, tx + dx * s + dz, fy, tz + dz * s + dx, COL_PALM, Mat.Wood);
        setIfAir(world, tx + dx * s - dz, fy, tz + dz * s - dx, COL_PALM, Mat.Wood);
      }
    }
  }
}

function plantBush(world: VoxelWorld, x: number, groundY: number, z: number, rng: () => number, color: number): void {
  const r = rng() < 0.4 ? 2 : 1;
  const base = groundY + 1;
  for (let dy = 0; dy <= r; dy++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy + dz * dz > r * r + 1) continue;
        if (rng() < 0.25) continue;
        setIfAir(world, x + dx, base + dy, z + dz, color, Mat.Wood);
      }
    }
  }
}

function placeBoulder(world: VoxelWorld, x: number, groundY: number, z: number, rng: () => number): void {
  const r = 1 + Math.floor(rng() * 3);
  const base = groundY - Math.floor(r * 0.4);
  for (let dy = 0; dy <= r + 1; dy++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const n = (dx * dx + dz * dz) / (r * r) + (dy * dy) / ((r + 1) * (r + 1));
        if (n > 1.05) continue;
        if (n > 0.7 && rng() < 0.3) continue;
        const c = rng() < 0.5 ? COL_ROCK : (rng() < 0.5 ? COL_ROCK_DARK : COL_GRAVEL);
        setIfAir(world, x + dx, base + dy, z + dz, c, Mat.Stone);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Structures
// ---------------------------------------------------------------------------
function fillBox(
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

function clearBox(
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

/**
 * Records where a flag should fly. The geometry is built client-side at
 * sub-voxel scale (fx/Flags.ts); at one block per cell a flag legible enough to
 * show its star would be nine metres wide, which is why none are placed here.
 *
 * `y` is the foot of the pole and (dirX, dirZ) is the axis it flies along.
 */
function addFlagSite(
  layout: MapLayout,
  x: number, y: number, z: number,
  dirX: number, dirZ: number,
  us = false,
): void {
  layout.flagSites.push({ x: x + 0.5, y, z: z + 0.5, dirX, dirZ, us });
}

/**
 * Nhà sàn -- the stilt house.
 *
 * Timber posts lift the floor clear of ground that is wet for half the year,
 * bamboo-matting walls sit on top, and the thatch oversails the walls by a
 * block on every side. That deep eave is the detail that makes the silhouette
 * read as Vietnamese rather than as a generic hut: the roof is visibly wider
 * than the box under it, and it is by far the biggest thing about the building.
 */
function buildStiltHouse(world: VoxelWorld, hx: number, groundY: number, hz: number): void {
  const y = groundY + 1;
  const FLOOR = y + 3;

  // Posts on a 3-block grid, dug a block in so they don't float on slopes.
  for (let dx = -3; dx <= 3; dx += 3) {
    for (let dz = -3; dz <= 3; dz += 3) {
      fillBox(world, hx + dx, y - 1, hz + dz, hx + dx, FLOOR - 1, hz + dz, COL_TRUNK_DARK, Mat.Wood);
    }
  }

  fillBox(world, hx - 3, FLOOR, hz - 3, hx + 3, FLOOR, hz + 3, COL_PLANK, Mat.Wood);

  // Walls, with a doorway on the -Z face.
  fillBox(world, hx - 3, FLOOR + 1, hz - 3, hx + 3, FLOOR + 3, hz + 3, COL_BAMBOO_DARK, Mat.Wood);
  clearBox(world, hx - 2, FLOOR + 1, hz - 2, hx + 2, FLOOR + 3, hz + 2);
  clearBox(world, hx, FLOOR + 1, hz - 3, hx, FLOOR + 2, hz - 3);
  // Shuttered window openings.
  clearBox(world, hx + 3, FLOOR + 2, hz - 1, hx + 3, FLOOR + 2, hz + 1);
  clearBox(world, hx - 3, FLOOR + 2, hz - 1, hx - 3, FLOOR + 2, hz + 1);

  // Thatch, stepping in twice from an eave that oversails the walls by two.
  fillBox(world, hx - 5, FLOOR + 4, hz - 5, hx + 5, FLOOR + 4, hz + 5, COL_THATCH, Mat.Wood);
  fillBox(world, hx - 4, FLOOR + 5, hz - 4, hx + 4, FLOOR + 5, hz + 4, COL_THATCH, Mat.Wood);
  fillBox(world, hx - 2, FLOOR + 6, hz - 2, hx + 2, FLOOR + 6, hz + 2, COL_THATCH_DARK, Mat.Wood);

  // Steps up to the doorway.
  for (let s = 0; s < 3; s++) {
    fillBox(world, hx, y + s, hz - 4 - (2 - s), hx, y + s, hz - 4 - (2 - s), COL_WOOD_DARK, Mat.Wood);
  }
}

/**
 * Village house: ochre stucco under a terracotta hip roof. Sits on the ground
 * rather than on stilts, so a hamlet built from both types has two silhouettes
 * in it instead of one repeated.
 */
function buildTileHouse(world: VoxelWorld, hx: number, groundY: number, hz: number): void {
  const y = groundY + 1;
  fillBox(world, hx - 4, y, hz - 3, hx + 4, y + 3, hz + 3, COL_STUCCO_OCHRE, Mat.Stone);
  clearBox(world, hx - 3, y, hz - 2, hx + 3, y + 3, hz + 2);
  clearBox(world, hx, y, hz - 3, hx + 1, y + 2, hz - 3);
  clearBox(world, hx - 3, y + 2, hz + 3, hx - 2, y + 2, hz + 3);
  clearBox(world, hx + 2, y + 2, hz + 3, hx + 3, y + 2, hz + 3);
  // Whitewashed band under the eaves, the way these are usually painted.
  fillBox(world, hx - 4, y + 3, hz - 3, hx + 4, y + 3, hz + 3, COL_STUCCO, Mat.Stone);
  clearBox(world, hx - 3, y + 3, hz - 2, hx + 3, y + 3, hz + 2);
  // Tile roof: two courses, overhanging on all four sides.
  fillBox(world, hx - 5, y + 4, hz - 4, hx + 5, y + 4, hz + 4, COL_TILE, Mat.Wood);
  fillBox(world, hx - 3, y + 5, hz - 2, hx + 3, y + 5, hz + 2, COL_TILE_DARK, Mat.Wood);
}

/**
 * Rice paddies: flooded plots inside a grid of earth bunds.
 *
 * The bunds are laid one block proud of the water so they work as the footpath
 * network through the field -- which is what they are for in reality, and what
 * makes the field playable rather than a hole you fall into. The flooded floor
 * is a solid voxel of paddy-water colour: there is only one real water plane in
 * the world (WATER_LEVEL) and it is far below this shelf.
 *
 * The field is deliberately *open*. It sits in the firebase's field of fire, so
 * nothing in it stands tall enough to hide a man: the tallest thing here is a
 * bund, and the crop is a single voxel of stubble. Plots are at different points
 * in the cycle -- some in rice, some just transplanted, some still bare mud
 * under the hoe -- which is what gives the farmers something to be doing and
 * keeps forty plots from reading as one green rectangle.
 */
const enum PlotState {
  /** Turned mud, no crop yet. This is where the hoes are working. */
  Bare = 0,
  /** Just transplanted: thin, ragged rows. */
  Young = 1,
  /** Standing crop. */
  Grown = 2,
}

function buildRicePaddies(
  world: VoxelWorld,
  layout: MapLayout,
  heights: Int16Array,
  rng: () => number,
): void {
  for (let px = 0; px < PADDY_PLOTS_X; px++) {
    const x0 = PADDY_X0 + px * PADDY_PITCH;
    const level = paddyLevel(x0 + 1);
    for (let pz = 0; pz < PADDY_PLOTS_Z; pz++) {
      const z0 = PADDY_Z0 + pz * PADDY_PITCH;
      const x1 = x0 + PADDY_PITCH;
      const z1 = z0 + PADDY_PITCH;

      // Bund ring. Adjacent plots share an edge, so this is drawn per plot and
      // simply overwrites the neighbour's -- cheaper than tracking shared runs.
      fillBox(world, x0, level + 1, z0, x1, level + 1, z0, COL_LATERITE_DARK, Mat.Dirt);
      fillBox(world, x0, level + 1, z1, x1, level + 1, z1, COL_LATERITE_DARK, Mat.Dirt);
      fillBox(world, x0, level + 1, z0, x0, level + 1, z1, COL_LATERITE_DARK, Mat.Dirt);
      fillBox(world, x1, level + 1, z0, x1, level + 1, z1, COL_LATERITE_DARK, Mat.Dirt);

      // Where this plot is in the cycle. Bare plots cluster towards the low
      // (western) terraces, because that is the end you flood and work first.
      const roll = rng() + px * 0.13;
      const state = roll < 0.42 ? PlotState.Bare : roll < 0.72 ? PlotState.Young : PlotState.Grown;
      const density = state === PlotState.Grown ? 0.5 : state === PlotState.Young ? 0.22 : 0;
      // A bare plot is under the hoe, so it carries the ridge-and-furrow of
      // ground that has been turned but not yet levelled and flooded flat.
      const furrowed = state === PlotState.Bare;

      for (let z = z0 + 1; z < z1; z++) {
        for (let x = x0 + 1; x < x1; x++) {
          clearBox(world, x, level + 1, z, x, level + 4, z);
          const furrow = furrowed && ((z - z0) & 1) === 0;
          const mud = furrow || rng() < 0.18;
          world.setFast(x, level, z, mud ? COL_PADDY_MUD : COL_PADDY_WATER, Mat.Dirt);
          // Rice stands in rows, thinning towards the bunds.
          const edge = x === x0 + 1 || x === x1 - 1 || z === z0 + 1 || z === z1 - 1;
          if (!edge && rng() < density) {
            world.setFast(x, level + 1, z, rng() < 0.25 ? COL_RICE_DRY : COL_RICE, Mat.Dirt);
          }
        }
      }
    }
  }

  // A hamlet on the natural ground off the high (eastern) end, looking back
  // down the terraces, with the flag up. Placed off the field's own heightmap
  // rather than off the terrace level, because the flattening feathers out
  // here and the terrace number would leave the houses on stilts over nothing.
  const groundAt = (x: number, z: number): number =>
    (x < 0 || z < 0 || x >= WORLD_X || z >= WORLD_Z) ? PADDY_BASE_Y : heights[z * WORLD_X + x];

  const hx = PADDY_X1 + 6;
  const hz1 = PADDY_Z0 + 8;
  const hz2 = PADDY_Z1 - 8;
  buildStiltHouse(world, hx, groundAt(hx, hz1), hz1);
  buildStiltHouse(world, hx + 4, groundAt(hx + 4, hz2), hz2);
  const fz = Math.round((hz1 + hz2) / 2);
  addFlagSite(layout, hx - 1, groundAt(hx - 1, fz) + 1, fz, -1, 0);
}

// ---------------------------------------------------------------------------
// The firebase
// ---------------------------------------------------------------------------
/** Outer face of the sandbag parapet, measured from the base centre. */
const FORT_R = 9;
/** Belt of concertina and pickets, out on the cleared glacis. */
const WIRE_R = 11.8;
/** Half-width of a gate opening at the parapet, in blocks. */
const GATE_HALF = 2.4;

/** Deterministic per-voxel jitter, so a sandbag wall reads as stacked bags. */
function grain(x: number, y: number, z: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function sandbagCol(x: number, y: number, z: number): number {
  const g = grain(x, y, z);
  return g < 0.4 ? COL_SANDBAG : g < 0.78 ? COL_SAND_DARK : COL_CANVAS;
}

/**
 * The player's firebase.
 *
 * A Vietnam fire support base was not a fort. Engineers put a dozer on a
 * hilltop, scraped it flat, and the infantry filled sandbags until dark; a week
 * later it might be abandoned again. Everything below follows from that:
 *
 *  - It is *small*. The perimeter is a berm you can see the whole of from the
 *    middle, because the position only works if every man on the line can be
 *    covered by the next one along.
 *  - Nothing is tall. Height is what indirect fire ranges on, so the bunkers
 *    are dug down to the parapet line and roofed with timber under sandbags,
 *    and the one thing that does stand up -- the tower -- is a stick frame that
 *    can be rebuilt in an afternoon.
 *  - Nothing is permanent. Corrugated tin, engineer stakes, ammunition crates,
 *    a mortar on a steel baseplate. The only concrete on the hill is the slab
 *    the fire direction centre sits on.
 *
 * The hilltop is left deliberately bare out to the wire: field of fire is the
 * whole reason the position is on this hill and not the next one.
 */
function buildStarterFort(world: VoxelWorld, layout: MapLayout, baseY = BASE_PLATEAU_Y, center = BASE_CENTER): void {
  const cx = center.x;
  const cz = center.z;
  /** Ground surface. Structures stand on the layer above it. */
  const g = baseY;
  const y = baseY + 1;

  // Local frame: offsets are relative to the base centre, heights to `y`.
  const box = (
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    col: number, mat: number,
  ): void => fillBox(world, cx + x0, y + y0, cz + z0, cx + x1, y + y1, cz + z1, col, mat);

  const put = (dx: number, dy: number, dz: number, col: number, mat: number): void =>
    box(dx, dy, dz, dx, dy, dz, col, mat);

  const bags = (
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
  ): void => {
    for (let dy = y0; dy <= y1; dy++)
      for (let dz = z0; dz <= z1; dz++)
        for (let dx = x0; dx <= x1; dx++)
          put(dx, dy, dz, sandbagCol(cx + dx, y + dy, cz + dz), Mat.Dirt);
  };

  /** Dig a cell one below the compound floor — fighting positions sit down in it. */
  const digIn = (dx: number, dz: number): void => clearBox(world, cx + dx, g, cz + dz, cx + dx, g, cz + dz);

  const gateAngles = layout.rampMouths.map((m) => Math.atan2(m.z - cz, m.x - cx));
  /** True where a gate lane of the given half-width crosses this offset. */
  const atGate = (dx: number, dz: number, half: number): boolean => {
    const d = Math.hypot(dx, dz);
    if (d < 1) return false;
    const a = Math.atan2(dz, dx);
    for (const ga of gateAngles) {
      let da = a - ga;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      if (Math.abs(da) * d < half) return true;
    }
    return false;
  };

  // -------------------------------------------------------------------------
  // 1. Scrape the hilltop. Compound floor is churned laterite; outside the berm
  //    it is the raw cut the dozer left, and nothing is allowed to grow on it.
  // -------------------------------------------------------------------------
  for (let dz = -MESA_TOP_R; dz <= MESA_TOP_R; dz++) {
    for (let dx = -MESA_TOP_R; dx <= MESA_TOP_R; dx++) {
      const d = Math.hypot(dx, dz);
      if (d > MESA_TOP_R) continue;
      const gx = cx + dx;
      const gz = cz + dz;
      if (gx < 1 || gz < 1 || gx >= WORLD_X - 1 || gz >= WORLD_Z - 1) continue;
      if (world.get(gx, g, gz) === 0) continue;
      const n = grain(gx, 0, gz);
      const col = d > FORT_R + 1.5
        ? (n < 0.55 ? COL_LATERITE : COL_LATERITE_DARK)
        : (n < 0.4 ? COL_DIRT_DARK : n < 0.78 ? COL_LATERITE : COL_MUD);
      world.setFast(gx, g, gz, col, Mat.Dirt);
    }
  }

  // -------------------------------------------------------------------------
  // 2. The berm: a chest-high sandbag parapet with a fire step behind it, so
  //    you stand *on* the step to shoot and drop behind the bags to reload.
  // -------------------------------------------------------------------------
  for (let dz = -FORT_R - 2; dz <= FORT_R + 2; dz++) {
    for (let dx = -FORT_R - 2; dx <= FORT_R + 2; dx++) {
      const d = Math.hypot(dx, dz);
      const parapet = d >= FORT_R - 0.5 && d <= FORT_R + 0.5;
      const firestep = d >= FORT_R - 1.5 && d < FORT_R - 0.5;
      if (!parapet && !firestep) continue;
      if (atGate(dx, dz, GATE_HALF)) continue;
      bags(dx, 0, dz, dx, parapet ? 1 : 0, dz);
    }
  }

  // -------------------------------------------------------------------------
  // 3. Gates. Two engineer stakes and a plank lintel across the top — every
  //    firebase had a hand-painted board up there with the unit's name on it.
  // -------------------------------------------------------------------------
  for (const ga of gateAngles) {
    const ux = Math.cos(ga);
    const uz = Math.sin(ga);
    const px = -uz;
    const pz = ux;
    const posts: Array<[number, number]> = [];
    for (const side of [-1, 1]) {
      const ox = Math.round(ux * FORT_R + px * side * (GATE_HALF + 0.6));
      const oz = Math.round(uz * FORT_R + pz * side * (GATE_HALF + 0.6));
      box(ox, 0, oz, ox, 2, oz, COL_WOOD_DARK, Mat.Wood);
      posts.push([ox, oz]);
    }
    // Lintel: step from one post to the other so it spans whatever the
    // rounding above landed on.
    const [ax, az] = posts[0];
    const [bx, bz] = posts[1];
    const span = Math.max(Math.abs(bx - ax), Math.abs(bz - az));
    for (let i = 0; i <= span; i++) {
      const t = span === 0 ? 0 : i / span;
      put(Math.round(ax + (bx - ax) * t), 3, Math.round(az + (bz - az) * t), COL_PLANK, Mat.Wood);
    }
  }

  // -------------------------------------------------------------------------
  // 4. Wire: concertina strung between engineer stakes, out where a satchel
  //    charge has to be walked to it in the open.
  // -------------------------------------------------------------------------
  for (let a = 0; a < 360; a += 4) {
    const rad = (a * Math.PI) / 180;
    const wx = Math.round(Math.cos(rad) * WIRE_R);
    const wz = Math.round(Math.sin(rad) * WIRE_R);
    if (atGate(wx, wz, GATE_HALF + 2)) continue;
    if (a % 24 === 0) box(wx, 0, wz, wx, 1, wz, COL_WOOD_DARK, Mat.Wood);
    else put(wx, 0, wz, COL_STEEL_DARK, Mat.Wood);
  }

  // -------------------------------------------------------------------------
  // 5. The compound is left open. A firebase's interior is its manoeuvre
  //    space: the whole reason for the berm is that men can cross the position
  //    to whichever side is being hit, and anything standing in the middle is
  //    a wall between you and the fight -- as well as something for indirect
  //    fire to range on. So the centre holds exactly two things: the radio on
  //    its block, and the colours beside it.
  // -------------------------------------------------------------------------
  put(0, 0, 0, COL_CONCRETE_DARK, Mat.Reinforced);
  world.setFast(layout.corePosition.x, layout.corePosition.y, layout.corePosition.z, COL_CORE, Mat.Core);
  // Whip antenna off the set.
  box(1, 0, 0, 1, 6, 0, COL_STEEL_DARK, Mat.Steel);
  put(1, 7, 0, COL_STEEL, Mat.Steel);

  // -------------------------------------------------------------------------
  // 6. The LZ: pierced steel planking with a painted H, laid flat into the
  //    dirt so it costs the open ground nothing.
  // -------------------------------------------------------------------------
  for (let dz = 3; dz <= 7; dz++) {
    for (let dx = -2; dx <= 2; dx++) {
      const mark = Math.abs(dx) === 1 || (dx === 0 && dz === 5);
      fillBox(world, cx + dx, g, cz + dz, cx + dx, g, cz + dz,
        mark ? COL_STUCCO : COL_STEEL_DARK, Mat.Steel);
    }
  }

  // -------------------------------------------------------------------------
  // 10. Two roofed fighting bunkers let into the berm, dug down so the firing
  //     slit sits at the parapet line rather than above it.
  // -------------------------------------------------------------------------
  for (const bearing of [99, -51]) {
    const ba = (bearing * Math.PI) / 180;
    const bx = Math.round(Math.cos(ba) * FORT_R);
    const bz = Math.round(Math.sin(ba) * FORT_R);
    // Outward normal, snapped to the axis it leans on, so the slit and the
    // doorway land on cell faces rather than between them.
    const nx = Math.abs(Math.cos(ba)) > Math.abs(Math.sin(ba)) ? Math.sign(Math.cos(ba)) : 0;
    const nz = nx === 0 ? Math.sign(Math.sin(ba)) : 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const out = dx === nx && dz === nz;
        const inn = dx === -nx && dz === -nz;
        if (inn) continue;                       // doorway, from the compound
        bags(bx + dx, 0, bz + dz, bx + dx, out ? 0 : 1, bz + dz); // slit over the front bags
      }
    }
    // The parapet pass already ran bags through here; hollow the position and
    // its doorway back out, then dig the floor a block below the compound.
    box(bx, 0, bz, bx, 1, bz, 0, 0);
    box(bx - nx, 0, bz - nz, bx - nx, 1, bz - nz, 0, 0);
    digIn(bx, bz);
    digIn(bx - nx, bz - nz);
    box(bx - 1, 2, bz - 1, bx + 1, 2, bz + 1, COL_WOOD_DARK, Mat.Wood);
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++)
        if (grain(cx + bx + dx, 3, cz + bz + dz) < 0.6) bags(bx + dx, 3, bz + dz, bx + dx, 3, bz + dz);
  }

  // The colours, on their pole right next to the set. The compound is the
  // player's, so it flies the Stars and Stripes; every other pole on the map
  // flies the star flag.
  addFlagSite(layout, cx - 2, y, cz, 0, 1, true);
}

/** The safe town: a walled plaza with merchant stalls and a few houses. */
function buildTown(world: VoxelWorld, layout: MapLayout, heights: Int16Array, townY = TOWN_Y, center = TOWN_CENTER, base = BASE_CENTER): void {
  const cx = center.x;
  const cz = center.z;
  const y = townY + 1;

  // Packed-earth plaza. Colour only -- the material stays Reinforced so the
  // village floor can't be dug out from under the merchants.
  fillBox(world, cx - 12, y - 1, cz - 10, cx + 12, y - 1, cz + 10, COL_LATERITE_DARK, Mat.Reinforced);
  clearBox(world, cx - 12, y, cz - 10, cx + 12, y + 8, cz + 10);

  // Low perimeter wall so it reads as a settlement.
  for (let x = cx - 12; x <= cx + 12; x++) {
    fillBox(world, x, y, cz - 10, x, y + 1, cz - 10, COL_STUCCO_OCHRE, Mat.Stone);
    fillBox(world, x, y, cz + 10, x, y + 1, cz + 10, COL_STUCCO_OCHRE, Mat.Stone);
  }
  for (let z = cz - 10; z <= cz + 10; z++) {
    fillBox(world, cx - 12, y, z, cx - 12, y + 1, z, COL_STUCCO_OCHRE, Mat.Stone);
    fillBox(world, cx + 12, y, z, cx + 12, y + 1, z, COL_STUCCO_OCHRE, Mat.Stone);
  }
  // Gate facing the fort.
  clearBox(world, cx - 12, y, cz - 2, cx - 12, y + 2, cz + 2);

  // Market stall: bamboo uprights under an awning, open on the plaza side.
  const stall = (sx: number, sz: number, roof: number): { x: number; y: number; z: number } => {
    fillBox(world, sx - 3, y, sz - 2, sx + 3, y + 3, sz - 2, COL_BAMBOO_DARK, Mat.Wood);
    fillBox(world, sx - 3, y, sz + 2, sx - 3, y + 3, sz + 2, COL_BAMBOO, Mat.Wood);
    fillBox(world, sx + 3, y, sz + 2, sx + 3, y + 3, sz + 2, COL_BAMBOO, Mat.Wood);
    fillBox(world, sx - 4, y + 4, sz - 3, sx + 4, y + 4, sz + 3, roof, Mat.Wood);
    fillBox(world, sx - 4, y + 5, sz - 2, sx + 4, y + 5, sz + 2, roof, Mat.Wood);
    // Counter.
    fillBox(world, sx - 3, y, sz + 2, sx + 3, y + 1, sz + 2, COL_WOOD, Mat.Wood);
    return { x: sx + 0.5, y: y, z: sz + 0.5 };
  };

  layout.merchantSpots.push(stall(cx - 7, cz - 4, COL_THATCH));
  layout.merchantSpots.push(stall(cx + 7, cz - 4, COL_CANVAS));

  // Two silhouettes rather than one: a stilt house and a tile-roofed house.
  buildStiltHouse(world, cx - 7, y - 1, cz + 5);
  buildTileHouse(world, cx + 7, y - 1, cz + 5);

  // Village flagpole, in the open between the stalls and the houses.
  addFlagSite(layout, cx, y, cz + 2, 1, 0);

  // Dirt road from the town gate to the fort.
  const bx = base.x;
  const bz = base.z;
  const steps = Math.ceil(Math.hypot(cx - bx, cz - bz));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const rx = Math.round(bx + (cx - bx) * t);
    const rz = Math.round(bz + (cz - bz) * t);
    for (let ox = -2; ox <= 2; ox++) {
      for (let oz = -2; oz <= 2; oz++) {
        const px = rx + ox;
        const pz = rz + oz;
        if (px < 1 || pz < 1 || px >= WORLD_X - 1 || pz >= WORLD_Z - 1) continue;
        const h = heights[pz * WORLD_X + px];
        if (h > WATER_LEVEL) world.setFast(px, h, pz, COL_DIRT_DARK, Mat.Dirt);
      }
    }
  }
}


// ---------------------------------------------------------------------------
// Imported maps
// ---------------------------------------------------------------------------
/**
 * Turns an arbitrary imported map (e.g. a classic `.vxl`) into something
 * playable: levels a pad for the fort and the town on top of whatever terrain
 * was loaded, then drops the same structures and spawns onto it.
 */
export function prepareImportedMap(world: VoxelWorld): MapLayout {
  const cx = Math.floor(WORLD_X / 2);
  const cz = Math.floor(WORLD_Z / 2);

  const surfaceAt = (x: number, z: number): number => {
    const h = world.surfaceHeight(x, z);
    return clamp(h, 1, WORLD_Y - 12);
  };

  // Median surface height over the fort footprint, so one spike doesn't skew it.
  const samples: number[] = [];
  for (let dz = -MESA_TOP_R; dz <= MESA_TOP_R; dz += 3)
    for (let dx = -MESA_TOP_R; dx <= MESA_TOP_R; dx += 3)
      samples.push(surfaceAt(cx + dx, cz + dz));
  samples.sort((a, b) => a - b);
  const baseY = clamp(samples[samples.length >> 1], WATER_LEVEL + 2, WORLD_Y - 16);

  // Level the fort pad: fill up to baseY, clear everything above it.
  for (let dz = -MESA_TOP_R - 2; dz <= MESA_TOP_R + 2; dz++) {
    for (let dx = -MESA_TOP_R - 2; dx <= MESA_TOP_R + 2; dx++) {
      const d = Math.hypot(dx, dz);
      if (d > MESA_TOP_R + 2) continue;
      const x = cx + dx;
      const z = cz + dz;
      if (x < 1 || z < 1 || x >= WORLD_X - 1 || z >= WORLD_Z - 1) continue;
      for (let y = 1; y <= baseY; y++) {
        if (world.get(x, y, z) === 0) world.setFast(x, y, z, COL_DIRT, Mat.Dirt);
      }
      for (let y = baseY + 1; y < WORLD_Y; y++) {
        if (world.get(x, y, z) !== 0) world.setFast(x, y, z, 0, 0);
      }
      world.setFast(x, baseY, z, COL_GRASS, Mat.Dirt);
    }
  }

  const townCenter = { x: clamp(cx + 64, 20, WORLD_X - 20), z: clamp(cz - 10, 20, WORLD_Z - 20) };
  const townY = clamp(surfaceAt(townCenter.x, townCenter.z), WATER_LEVEL + 2, WORLD_Y - 16);
  for (let dz = -TOWN_RADIUS - 2; dz <= TOWN_RADIUS + 2; dz++) {
    for (let dx = -TOWN_RADIUS - 2; dx <= TOWN_RADIUS + 2; dx++) {
      if (Math.hypot(dx, dz) > TOWN_RADIUS + 2) continue;
      const x = townCenter.x + dx;
      const z = townCenter.z + dz;
      if (x < 1 || z < 1 || x >= WORLD_X - 1 || z >= WORLD_Z - 1) continue;
      for (let y = 1; y <= townY; y++) {
        if (world.get(x, y, z) === 0) world.setFast(x, y, z, COL_DIRT, Mat.Dirt);
      }
      for (let y = townY + 1; y < WORLD_Y; y++) {
        if (world.get(x, y, z) !== 0) world.setFast(x, y, z, 0, 0);
      }
    }
  }

  world.rebuildHeights();

  const base = { x: cx, z: cz };
  const layout: MapLayout = {
    baseCenter: { x: cx, y: baseY + 1, z: cz },
    townCenter: { x: townCenter.x, y: townY + 1, z: townCenter.z },
    spawnPoints: [],
    corePosition: { x: cx, y: baseY + 2, z: cz },
    playerSpawn: { x: cx, y: baseY + 1, z: cz + 5 },
    merchantSpots: [],
    rampMouths: [],
    flagSites: [],
  };

  // No carved ramps on an imported map, so leave the ring wall open on four
  // sides instead and let the player decide where to seal it.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    layout.rampMouths.push({ x: cx + Math.cos(a) * 40, z: cz + Math.sin(a) * 40 });
  }

  const heights = new Int16Array(WORLD_X * WORLD_Z);
  for (let z = 0; z < WORLD_Z; z++)
    for (let x = 0; x < WORLD_X; x++)
      heights[z * WORLD_X + x] = Math.max(0, world.surfaceHeight(x, z) - 1);

  buildStarterFort(world, layout, baseY, base);
  buildTown(world, layout, heights, townY, townCenter, base);

  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    const sx = clamp(Math.round(cx + Math.cos(a) * 100), 6, WORLD_X - 7);
    const sz = clamp(Math.round(cz + Math.sin(a) * 100), 6, WORLD_Z - 7);
    layout.spawnPoints.push({ x: sx + 0.5, y: Math.max(WATER_LEVEL + 1, surfaceAt(sx, sz)), z: sz + 0.5 });
  }

  world.rebuildHeights();
  return layout;
}
