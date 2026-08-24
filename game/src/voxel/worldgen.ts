import { VoxelWorld } from './VoxelWorld';
import { placeOutposts, type OutpostSite } from './outposts';
import { placeCrashSite, type CrashSite } from './crashsite';
import { WORLD_X, WORLD_Y, WORLD_Z, WATER_LEVEL, Mat } from '../core/constants';
import {
  COL_GRASS, COL_GRASS_DRY, COL_MOSS,
  COL_DIRT, COL_DIRT_DARK, COL_MUD,
  COL_SAND_DARK,
  COL_ROCK, COL_ROCK_DARK, COL_CLIFF, COL_CLIFF_DARK, COL_GRAVEL,
  COL_BEDROCK,
  COL_TRUNK, COL_TRUNK_DARK, COL_TRUNK_PALE,
  COL_TRUNK_SHADOW, COL_TRUNK_WARM, COL_TRUNK_GREY,
  COL_LEAF, COL_LEAF_DARK, COL_LEAF_LIGHT, COL_PALM, COL_BUSH,
  COL_WOOD, COL_WOOD_DARK, COL_PLANK,
  COL_STONE, COL_STONE_DARK, COL_STEEL_DARK, COL_WATER,
  COL_CONCRETE_DARK,
  COL_CORE, COL_CANVAS,
  COL_LATERITE, COL_LATERITE_DARK, COL_PADDY_WATER, COL_PADDY_MUD,
  COL_RICE_DRY, COL_BAMBOO, COL_BAMBOO_DARK,
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
/**
 * Radius of the shelf on an imported map, where there is no village layout to
 * cut a rectangle for. The generated map uses {@link TOWN_HALF_X} instead.
 */
export const TOWN_RADIUS = 17;
const TOWN_Y = 24;

/**
 * The village shelf.
 *
 * A rectangle rather than a disc, because what stands on it is a rectangle: a
 * market square with a street through it and huts either side. Levelling to a
 * circle left the corner huts standing half a block off the ground, which is
 * exactly the sort of thing that makes a place read as scenery instead of as
 * somewhere people live.
 */
const TOWN_HALF_X = 24;
const TOWN_HALF_Z = 20;
/** The walled market square in the middle of it. */
const MARKET_HALF_X = 11;
const MARKET_HALF_Z = 9;
/** Half-width of the street that runs through both gates. */
const STREET_HALF = 2;

/**
 * Distance outside the village shelf, 0 anywhere on it.
 *
 * Same rounded-rectangle measure the paddy uses, so the flattening, the tree
 * exclusion and the floor all agree about where the village stops.
 */
function townDistance(x: number, z: number, center = TOWN_CENTER): number {
  const ox = Math.max(0, Math.abs(x - center.x) - TOWN_HALF_X);
  const oz = Math.max(0, Math.abs(z - center.z) - TOWN_HALF_Z);
  return Math.hypot(ox, oz);
}

/**
 * Rice paddies, on the flat immediately south of the firebase.
 *
 * A paddy is a grid of flooded plots held apart by earth bunds. This one is
 * laid *flush with the ground it sits on*: one level for the whole field, taken
 * from the natural height under it, with the bunds drawn as packed earth in the
 * surface layer rather than stacked a block proud of it. Nothing about the
 * field stands above the jungle floor around it -- walk in off the margin and
 * there is no step up, and from the parapet it reads as ground that has been
 * worked rather than a plinth someone built.
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
/** Fallback level, used only before a world has been generated. */
const PADDY_BASE_Y = 21;

/**
 * The y of the field's surface voxel, settled during worldgen from the natural
 * ground under the footprint rather than from a constant, so the field lies on
 * the terrain instead of on top of it.
 */
let paddyFloorY = PADDY_BASE_Y;

/** Level of the field's surface layer. Flat: one level for the whole thing. */
function paddyLevel(): number {
  return paddyFloorY;
}

/**
 * The field's extent and level, for anything that needs to walk it.
 *
 * Exported because the farmers working the paddy (fx/Farmers.ts) are drawn as
 * sub-voxel scenery rather than as blocks, so they need to know where the mud
 * is without re-deriving it from the world.
 */
export const PADDY = {
  x0: PADDY_X0,
  x1: PADDY_X1,
  z0: PADDY_Z0,
  z1: PADDY_Z1,
  pitch: PADDY_PITCH,
  plotsX: PADDY_PLOTS_X,
  plotsZ: PADDY_PLOTS_Z,
  get level(): number { return paddyFloorY; },
};

/**
 * Standing height for a point in the field.
 *
 * The whole field -- mud, water and bunds alike -- is one voxel thick at
 * `level`, so you stand on top of it at `level + 1` wherever you are. Outside
 * the field this returns the same thing, which is close enough for the short
 * walk in off the margin, because the margin is feathered into this level too.
 */
export function paddyGroundY(_x: number, _z: number): number {
  return paddyLevel() + 1;
}

/**
 * How tall standing rice grows, in blocks.
 *
 * Sized against the player: a crouched eye sits 1.35 above the mud and a
 * standing one 2.25, so a man who goes down in a grown plot is under the crop
 * and a man who stands up in it is a head and shoulders above it. Every
 * decision about hiding in the field comes out of that one number.
 */
export const RICE_HEIGHT = 1.55;

/**
 * What each plot is carrying, indexed `px * PADDY_PLOTS_Z + pz`.
 *
 * Filled during worldgen and read afterwards by anything that needs to know
 * where the crop is standing -- the client to draw it, the AI to decide
 * whether it can see through it. Both sides derive it from the same seed, so
 * this stays in step without being sent anywhere.
 */
const paddyPlots = new Uint8Array(PADDY_PLOTS_X * PADDY_PLOTS_Z);

/**
 * How much standing crop is at `x, z`: 1 in a grown plot, about half that in a
 * newly transplanted one, 0 on a bund, in a bare plot or off the field.
 *
 * The margin inside each bund is deliberately clear -- rice is not planted
 * hard against the path -- so walking the bunds never puts you in cover.
 */
export function riceCoverAt(x: number, z: number): number {
  if (x < PADDY_X0 || x > PADDY_X1 || z < PADDY_Z0 || z > PADDY_Z1) return 0;
  const px = clamp(Math.floor((x - PADDY_X0) / PADDY_PITCH), 0, PADDY_PLOTS_X - 1);
  const pz = clamp(Math.floor((z - PADDY_Z0) / PADDY_PITCH), 0, PADDY_PLOTS_Z - 1);
  const offX = x - (PADDY_X0 + px * PADDY_PITCH);
  const offZ = z - (PADDY_Z0 + pz * PADDY_PITCH);
  if (offX < 2 || offX > PADDY_PITCH - 1 || offZ < 2 || offZ > PADDY_PITCH - 1) return 0;
  const state = paddyPlots[px * PADDY_PLOTS_Z + pz];
  return state === PlotState.Grown ? 1 : state === PlotState.Young ? 0.55 : 0;
}

/**
 * True if the crop at `x, z` is standing high enough to hide an eye at `eyeY`.
 *
 * This is concealment, not cover: it stops something being *seen*, and stops
 * nothing else. Rounds go straight through rice, and so does everybody who
 * walks into it.
 */
export function riceConceals(x: number, z: number, eyeY: number): boolean {
  const cover = riceCoverAt(x, z);
  if (cover <= 0) return false;
  return eyeY < paddyLevel() + 1 + RICE_HEIGHT * cover;
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
  /**
   * Where a merchant stands, in the order the shop kinds are laid out along
   * the market street. `yaw` is the direction they face -- out over their own
   * counter -- so the client doesn't have to guess which side of a stall is
   * the front.
   */
  merchantSpots: { x: number; y: number; z: number; yaw: number }[];
  /** Idle spots for the villagers who aren't behind a counter. */
  villagerSpots: { x: number; y: number; z: number }[];
  /** World-space positions of the ramp mouths, for HUD hints and spawn biasing. */
  rampMouths: { x: number; z: number }[];
  /**
   * Mouths of the tunnel network that is already under the valley when the run
   * starts. The bots come up out of these; the player can drop into them.
   *
   * `x/z` is the shaft — the hole in the ground. `standX/standZ` is the block
   * of ground beside it that somebody climbing out ends up on, because a hole
   * has no floor to stand on. `floorY` is the gallery it drops into and `y` is
   * the surface at the lip.
   */
  spiderHoles: {
    x: number; z: number; floorY: number;
    standX: number; standZ: number; y: number;
  }[];
  /**
   * Enemy camps out in the trees. Built by voxel/outposts.ts; who stands in
   * them is game/Garrison.ts, and what they do while they wait is the Guard
   * state in the AI.
   */
  outposts: OutpostSite[];
  /**
   * The downed helicopter north of the village, or null on a map with nowhere
   * flat enough to put one. Built by voxel/crashsite.ts; the fine detail hung
   * off it and the crates inside it are client-side (fx/Wreck.ts,
   * game/WeaponCache.ts), so the server receives the field and ignores it.
   */
  crashSite: CrashSite | null;
  /**
   * Where flags fly. Only the client draws these -- they're sub-voxel scenery
   * built as mesh geometry (see fx/Flags.ts), not blocks -- so the server
   * receives the field and ignores it.
   */
  flagSites: { x: number; y: number; z: number; dirX: number; dirZ: number; us?: boolean }[];
  /**
   * Every clump of standing rice: where its base sits, whether it has gone
   * dry, and how tall it came up. Client-side scenery like the flags -- it is
   * drawn as mesh geometry (see fx/Rice.ts) rather than written into the world,
   * which is what lets you walk into a plot and disappear into it.
   */
  ricePatches: { x: number; y: number; z: number; dry: boolean; height: number }[];
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
      const b = plateauBlend(townDistance(x, z), 0, 14);
      if (b <= 0) continue;
      const i = z * WORLD_X + x;
      heights[i] = Math.round(lerp(heights[i], TOWN_Y, b));
    }
  }

  // The paddy. A field has to be level or it cannot hold water, but it is
  // levelled *to the ground it is on*: the target is the mean natural height
  // under the footprint, so the flattening shaves the high corners and fills
  // the low ones instead of lifting the whole field onto a shelf. Anything
  // that would sit at or under the waterline is nudged clear of it, since a
  // plot below the river is a pond.
  {
    let sum = 0;
    let n = 0;
    for (let z = PADDY_Z0; z <= PADDY_Z1; z++) {
      if (z < 0 || z >= WORLD_Z) continue;
      for (let x = PADDY_X0; x <= PADDY_X1; x++) {
        if (x < 0 || x >= WORLD_X) continue;
        sum += heights[z * WORLD_X + x];
        n++;
      }
    }
    paddyFloorY = clamp(Math.round(n > 0 ? sum / n : PADDY_BASE_Y), WATER_LEVEL + 2, WORLD_Y - 20);
  }

  const paddyY = paddyLevel();
  for (let z = PADDY_Z0 - 8; z <= PADDY_Z1 + 8; z++) {
    if (z < 0 || z >= WORLD_Z) continue;
    for (let x = PADDY_X0 - 8; x <= PADDY_X1 + 8; x++) {
      if (x < 0 || x >= WORLD_X) continue;
      // How far outside the field rectangle this column is, feathered so the
      // surrounding jungle floor eases into the field instead of stepping.
      const ox = Math.max(0, Math.max(PADDY_X0 - x, x - PADDY_X1));
      const oz = Math.max(0, Math.max(PADDY_Z0 - z, z - PADDY_Z1));
      const b = plateauBlend(Math.hypot(ox, oz), 0, 8);
      if (b <= 0) continue;
      const i = z * WORLD_X + x;
      heights[i] = Math.round(lerp(heights[i], paddyY, b));
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
    villagerSpots: [],
    rampMouths: [],
    spiderHoles: [],
    outposts: [],
    crashSite: null,
    flagSites: [],
    ricePatches: [],
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
  const nearTown = (x: number, z: number): number => townDistance(x, z);

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

  // The road is laid out before anything is planted, so the jungle can be told
  // to leave it alone: a road you have to clear a tree out of the middle of was
  // never a road, and cutting one through afterwards leaves sawn-off canopies
  // hanging over the gap.
  const road = planRoad(BASE_CENTER, TOWN_CENTER, rampAngles);
  const onRoad = (x: number, z: number): boolean =>
    road[z * WORLD_X + x] !== RoadCell.None;

  scatterScenery(world, heights, rockiness, moisture, rng, {
    nearBase, nearTown, onRamp, onRoad, heightAt, riverAt,
  });

  // -------------------------------------------------------------------------
  // 7. Structures
  // -------------------------------------------------------------------------
  buildStarterFort(world, layout);
  buildTown(world, layout, rng);
  // After the fort and the village, so the track runs over the scraped hilltop
  // and stops at the gate rather than being buried by either of them.
  paintRoad(world, heights, road, TOWN_CENTER);
  buildRicePaddies(world, layout, heights, rng);
  // The wreck goes in before the camps, because it is the only structure on the
  // map that gets to pick its own ground twice over -- it needs somewhere flat
  // *and* somewhere with a clear run of trees behind it to have come through --
  // and the camps can be placed around whatever it takes. Same reason it is
  // after the road and the village: it has to be able to keep off both.
  layout.crashSite = placeCrashSite(world, rng, {
    town: TOWN_CENTER,
    heights,
    onRoad,
    occupied: (x, z) => townDistance(x, z) < 10 || inPaddyMud(x, z),
  });

  // The jungle camps go in before the tunnels and after everything else: they
  // scrape their own pads out of whatever the scenery left there, and they need
  // the road to already exist so they can be placed off it.
  const crash = layout.crashSite;
  layout.outposts = placeOutposts(world, rng, {
    base: BASE_CENTER,
    heights,
    onRoad,
    occupied: (x, z) => townDistance(x, z) < 12
      || inPaddyMud(x, z)
      // The scar runs a long way back up the approach; a camp pitched in the
      // middle of it would be a camp pitched in a ploughed field.
      || (crash !== null && Math.hypot(x - crash.x, z - crash.z) < 26),
  });
  for (const o of layout.outposts) {
    addFlagSite(layout, o.flag.x, o.flag.y, o.flag.z, o.flag.dirX, o.flag.dirZ);
  }

  // Last, so the tunnels are cut under everything that stands on the ground
  // rather than being backfilled by it.
  digTunnelNetwork(world, layout, heights, rng);

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
  onRoad: (x: number, z: number) => boolean;
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
      if (ctx.onRoad(x, z)) continue;
      // The village clearing. Nothing self-seeds on the shelf itself, and the
      // ring outside it -- where the firewood came from -- thins out with
      // distance rather than stopping on a line, which is what stops the
      // clearing reading as a rectangle cut out of the map.
      const townD = ctx.nearTown(x, z);
      if (townD < 3) continue;
      if (townD < 12 && rng() * 8 > townD - 3) continue;
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
        else if (roll < 0.50) plantBush(world, x, h, z, rng, 2.2);
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
        plantBush(world, x, h, z, rng, rng() < 0.5 ? 2.2 : 1);
      } else if (roll > 0.96) {
        placeBoulder(world, x, h, z, rng);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Foliage
// ---------------------------------------------------------------------------
/**
 * Deterministic per-voxel jitter in 0..1. Depends only on position, so the
 * same block is the same shade every time the chunk is remeshed.
 */
function grain(x: number, y: number, z: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/**
 * Shade ramps, darkest first.
 *
 * A block of wood or leaf is drawn one voxel at a time, and a plant painted in
 * a single flat colour reads as plastic no matter how good its silhouette is.
 * So every plant below picks a *centre* on one of these ramps -- that is the
 * plant's own colour -- and then each voxel wanders a step or two either side
 * of it. The steps are small on purpose: this is grain, not dazzle camouflage.
 */
const BARK = [
  COL_TRUNK_SHADOW, COL_TRUNK_DARK, COL_TRUNK_WARM,
  COL_TRUNK, COL_TRUNK_GREY, COL_TRUNK_PALE,
] as const;

const CANOPY = [
  COL_JUNGLE_DARK, COL_LEAF_DARK, COL_JUNGLE,
  COL_LEAF, COL_JUNGLE_LIGHT, COL_LEAF_LIGHT,
] as const;

const CULM = [COL_BAMBOO_DARK, COL_BAMBOO, COL_RICE_DRY] as const;

const FROND = [COL_JUNGLE, COL_JUNGLE_LIGHT, COL_PALM, COL_LEAF_LIGHT] as const;

const SHRUB = [
  COL_JUNGLE_DARK, COL_LEAF_DARK, COL_BUSH,
  COL_JUNGLE, COL_LEAF, COL_JUNGLE_LIGHT,
] as const;

/** `centre` on `ramp`, nudged by `g` (0..1) up to `spread` steps either way. */
function shade(ramp: readonly number[], centre: number, spread: number, g: number): number {
  const i = Math.round(centre + (g - 0.5) * 2 * spread);
  return ramp[i < 0 ? 0 : i >= ramp.length ? ramp.length - 1 : i];
}

/**
 * Bark shade for one voxel of trunk.
 *
 * The grain is sampled on a half-height y so a shade holds for two blocks
 * before it changes. That reads as grain running *up* the trunk rather than as
 * per-block confetti -- and it halves the number of quads the greedy mesher has
 * to cut the trunk into, which matters when the map is mostly jungle.
 */
function barkCol(x: number, y: number, z: number, tone: number): number {
  return shade(BARK, tone, 1.4, grain(x, y >> 1, z));
}

function setIfAir(world: VoxelWorld, x: number, y: number, z: number, color: number, mat: number): void {
  if (x < 0 || z < 0 || y < 0 || x >= WORLD_X || z >= WORLD_Z || y >= WORLD_Y) return;
  if (world.get(x, y, z) !== 0) return;
  world.setFast(x, y, z, color, mat);
}

/** Broadleaf jungle tree: tall bare trunk under a heavy rounded crown. */
function plantBroadleaf(world: VoxelWorld, x: number, groundY: number, z: number, rng: () => number): void {
  const height = 7 + Math.floor(rng() * 5);
  // The tree's own bark tone; individual blocks wander either side of it.
  const tone = rng() < 0.25 ? 4.4 : (rng() < 0.5 ? 3 : 1.6);

  const base = groundY + 1;
  for (let y = 0; y < height; y++) {
    setIfAir(world, x, base + y, z, barkCol(x, base + y, z, tone), Mat.Wood);
  }

  // Canopy: a squashed ellipsoid with a noisy edge.
  //
  // No autumn in the tropics, so the shading is light rather than season: the
  // crown is darkest deep inside and underneath, and lifts towards the top and
  // the outer skin where new growth catches the sun. Per-voxel grain on top of
  // that keeps a face of it from going flat.
  const cy = base + height;
  const rx = 2 + Math.floor(rng() * 2);
  const ry = 2 + Math.floor(rng() * 2);
  for (let dy = -ry; dy <= ry; dy++) {
    for (let dz = -rx; dz <= rx; dz++) {
      for (let dx = -rx; dx <= rx; dx++) {
        const n = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry * 1.1) + (dz * dz) / (rx * rx);
        if (n > 1) continue;
        if (n > 0.62 && rng() < 0.42) continue;
        const lit = 0.55 * ((dy + ry) / (2 * ry)) + 0.45 * n;
        const c = shade(CANOPY, 0.6 + lit * 4.2, 1.1, grain(x + dx, cy + dy, z + dz));
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
    // One tone per culm -- a bamboo stem really is smooth and evenly coloured,
    // so the texture here is the node banding, not a random speckle. Nodes ring
    // the stem every few blocks and sit a shade paler where the sheath dried.
    const tone = rng() < 0.4 ? 0.4 : 1.2;
    const nodes = 3 + Math.floor(rng() * 2);
    const phase = Math.floor(rng() * nodes);
    const base = groundY + 1;
    for (let y = 0; y < height; y++) {
      const node = (y + phase) % nodes === 0;
      const col = shade(CULM, node ? tone + 0.8 : tone, 0.35, grain(x + ox, base + y, z + oz));
      setIfAir(world, x + ox, base + y, z + oz, col, Mat.Wood);
    }
    const tip = base + height;
    for (let k = 0; k < 5; k++) {
      const lx = x + ox + Math.round((rng() - 0.5) * 3);
      const ly = tip - Math.floor(rng() * 3);
      const lz = z + oz + Math.round((rng() - 0.5) * 3);
      setIfAir(world, lx, ly, lz, shade(CANOPY, 3.4, 1.3, grain(lx, ly, lz)), Mat.Wood);
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
    setIfAir(world, x, base + y, z, shade(CULM, 0.35, 0.7, grain(x, base + y, z)), Mat.Wood);
  }
  const cy = base + height;
  setIfAir(world, x, cy, z, shade(CANOPY, 1.6, 1, grain(x, cy, z)), Mat.Wood);
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]];
  for (const [dx, dz] of dirs) {
    if (rng() < 0.25) continue;
    // The blade is lit where it reaches out and shaded where it droops back.
    setIfAir(world, x + dx, cy, z + dz,
      shade(CANOPY, 4, 1.2, grain(x + dx, cy, z + dz)), Mat.Wood);
    setIfAir(world, x + dx * 2, cy - 1, z + dz * 2,
      shade(CANOPY, 2.4, 1.2, grain(x + dx * 2, cy - 1, z + dz * 2)), Mat.Wood);
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
  // A palm is the pale end of the bark ramp, and its trunk is ringed with old
  // frond scars -- so it takes a wider wander than a broadleaf's does.
  for (let y = 0; y < height; y++) {
    setIfAir(world, tx, base + y, tz, shade(BARK, 4.5, 1.5, grain(tx, base + y, tz)), Mat.Wood);
    // Curve the trunk as it rises.
    if (y === Math.floor(height * 0.55)) tx += leanX;
    if (y === Math.floor(height * 0.8)) tz += leanZ;
  }

  const cy = base + height;
  setIfAir(world, tx, cy, tz, shade(BARK, 2.6, 1.2, grain(tx, cy, tz)), Mat.Wood);
  // Four drooping fronds. Each runs from bright at the crown to dull at the
  // drooping tip, which is what makes a frond read as a frond and not a spar.
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const frond = (fx: number, fy: number, fz: number, s: number): void =>
    setIfAir(world, fx, fy, fz, shade(FROND, 3 - s * 0.7, 0.8, grain(fx, fy, fz)), Mat.Wood);
  for (const [dx, dz] of dirs) {
    for (let s = 1; s <= 3; s++) {
      const fy = cy + (s >= 3 ? -1 : 0);
      frond(tx + dx * s, fy, tz + dz * s, s);
      if (s === 2) {
        frond(tx + dx * s + dz, fy, tz + dz * s + dx, s);
        frond(tx + dx * s - dz, fy, tz + dz * s - dx, s);
      }
    }
  }
}

/** `tone` is a centre on the SHRUB ramp -- lower is a deeper jungle green. */
function plantBush(world: VoxelWorld, x: number, groundY: number, z: number, rng: () => number, tone: number): void {
  const r = rng() < 0.4 ? 2 : 1;
  const base = groundY + 1;
  for (let dy = 0; dy <= r; dy++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy + dz * dz > r * r + 1) continue;
        if (rng() < 0.25) continue;
        // Crown lit, skirt shaded, same as the broadleaf canopy.
        const c = shade(SHRUB, tone + dy * 0.5, 1, grain(x + dx, base + dy, z + dz));
        setIfAir(world, x + dx, base + dy, z + dz, c, Mat.Wood);
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
 * A pitched roof, stepped one block a course.
 *
 * The old roofs were two or three flat slabs stacked with a two-block step
 * between them, which from the ground reads as a stack of trays rather than a
 * roof. Stepping in a single block a course is the finest slope a voxel grid
 * can express -- 45 degrees -- and that is what makes the end of a building
 * read as a triangle instead of a wedding cake.
 *
 * The eave course is solid, because it has to close the gap between the wall
 * head and the roof; every course above it is a ring, since nothing sees the
 * inside of a roof and a solid one costs a hundred blocks a hut.
 *
 * `hip` slopes all four sides in to a short ridge, the way a tiled house is
 * roofed. Without it the ends stay vertical and get filled in `gable` -- the
 * triangular screen of matting you see under the ridge of a thatched one.
 */
function pitchedRoof(
  world: VoxelWorld,
  cx: number, y: number, cz: number,
  halfX: number, halfZ: number,
  cover: number, shade: number, ridge: number, gable: number,
  hip: boolean,
): void {
  /** Course fill with a per-voxel speckle, so a roof isn't one flat colour. */
  const course = (x0: number, y0: number, z0: number, x1: number, z1: number, c: number, alt: number): void => {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        if (x < 0 || z < 0 || x >= WORLD_X || z >= WORLD_Z || y0 < 0 || y0 >= WORLD_Y) continue;
        world.setFast(x, y0, z, grain(x, y0, z) < 0.34 ? alt : c, Mat.Wood);
      }
    }
  };

  // Eave: solid, and oversailing whatever is under it.
  course(cx - halfX, y, cz - halfZ, cx + halfX, cz + halfZ, cover, shade);

  let k = 1;
  for (; halfZ - k > 0; k++) {
    const yy = y + k;
    const z0 = cz - halfZ + k;
    const z1 = cz + halfZ - k;
    const x0 = hip ? cx - halfX + k : cx - halfX;
    const x1 = hip ? cx + halfX - k : cx + halfX;
    if (x1 < x0) break;
    // The two slopes.
    course(x0, yy, z0, x1, z0, cover, shade);
    course(x0, yy, z1, x1, z1, cover, shade);
    if (hip) {
      // Hipped: the ends are roof as well, sloping in with the rest of it.
      course(x0, yy, z0, x0, z1, cover, shade);
      course(x1, yy, z0, x1, z1, cover, shade);
    } else {
      // Gabled: the thatch runs out past the end as a verge, and the matting
      // screen that actually closes the roof sits a block back in its shadow.
      course(x0, yy, z0, x0, z1, cover, shade);
      course(x1, yy, z0, x1, z1, cover, shade);
      course(x0 + 1, yy, z0 + 1, x0 + 1, z1 - 1, gable, gable);
      course(x1 - 1, yy, z0 + 1, x1 - 1, z1 - 1, gable, gable);
    }
  }

  // Ridge cap.
  const yy = y + k;
  const rz0 = Math.min(cz - halfZ + k, cz + halfZ - k);
  const rz1 = Math.max(cz - halfZ + k, cz + halfZ - k);
  const rx0 = hip ? cx - halfX + k : cx - halfX;
  const rx1 = hip ? cx + halfX - k : cx + halfX;
  if (rx1 >= rx0) fillBox(world, rx0, yy, rz0, rx1, yy, rz1, ridge, Mat.Wood);
}

/**
 * Nhà sàn -- the stilt house.
 *
 * Timber posts on stone pads lift the floor clear of ground that is wet for
 * half the year, a verandah runs along the door side because that is where the
 * work gets done, and the thatch oversails the walls by two blocks on every
 * side. That deep eave is the detail that makes the silhouette read as
 * Vietnamese rather than as a generic hut: the roof is visibly wider than the
 * box under it, and it is by far the biggest thing about the building.
 */
function buildStiltHouse(world: VoxelWorld, hx: number, groundY: number, hz: number, face = -1): void {
  const y = groundY + 1;
  const FLOOR = y + 2;
  /** Which way the door, the verandah and the steps go. */
  const f = face < 0 ? -1 : 1;
  const WALL = FLOOR + 3;

  // Posts on a 3-block grid, each on a stone pad -- a post straight into wet
  // ground rots, and every house here is built by someone who knows that.
  for (let dx = -3; dx <= 3; dx += 3) {
    for (let dz = -3; dz <= 3; dz += 3) {
      world.setFast(hx + dx, y - 1, hz + dz, COL_STONE, Mat.Stone);
      fillBox(world, hx + dx, y, hz + dz, hx + dx, FLOOR - 1, hz + dz, COL_TRUNK_DARK, Mat.Wood);
    }
  }

  // Floor, and the verandah out in front of the door under the eave.
  fillBox(world, hx - 3, FLOOR, hz - 3, hx + 3, FLOOR, hz + 3, COL_PLANK, Mat.Wood);
  const vz = hz + 4 * f;
  fillBox(world, hx - 2, FLOOR, vz, hx + 2, FLOOR, vz, COL_PLANK, Mat.Wood);
  for (const dx of [-2, 2]) {
    fillBox(world, hx + dx, y, vz, hx + dx, FLOOR - 1, vz, COL_TRUNK_DARK, Mat.Wood);
    fillBox(world, hx + dx, FLOOR + 1, vz, hx + dx, FLOOR + 2, vz, COL_BAMBOO, Mat.Wood);
  }
  // Handrail, broken where you step up onto the deck.
  for (let dx = -1; dx <= 1; dx++) {
    if (dx === 0) continue;
    world.setFast(hx + dx, FLOOR + 2, vz, COL_BAMBOO_DARK, Mat.Wood);
  }

  // Walls: split-bamboo matting, woven light and dark, on a corner-post frame.
  for (let yy = FLOOR + 1; yy <= WALL; yy++) {
    for (let dz = -3; dz <= 3; dz++) {
      for (let dx = -3; dx <= 3; dx++) {
        if (Math.abs(dx) !== 3 && Math.abs(dz) !== 3) continue;
        const corner = Math.abs(dx) === 3 && Math.abs(dz) === 3;
        const c = corner ? COL_TRUNK_DARK
          : grain(hx + dx, yy, hz + dz) < 0.42 ? COL_BAMBOO : COL_BAMBOO_DARK;
        world.setFast(hx + dx, yy, hz + dz, c, Mat.Wood);
      }
    }
  }

  // Doorway, framed and lintelled.
  const dz = hz + 3 * f;
  clearBox(world, hx, FLOOR + 1, dz, hx, FLOOR + 2, dz);
  fillBox(world, hx - 1, FLOOR + 1, dz, hx - 1, FLOOR + 2, dz, COL_WOOD_DARK, Mat.Wood);
  fillBox(world, hx + 1, FLOOR + 1, dz, hx + 1, FLOOR + 2, dz, COL_WOOD_DARK, Mat.Wood);
  world.setFast(hx, WALL, dz, COL_WOOD, Mat.Wood);

  // Windows: a sill and a head in sawn timber, and the shutter propped open
  // on its stick, which is what they look like in daylight.
  const opening = (wx: number, wz: number, run: 'x' | 'z', ox: number, oz: number): void => {
    const x0 = run === 'x' ? wx - 1 : wx;
    const x1 = run === 'x' ? wx + 1 : wx;
    const z0 = run === 'z' ? wz - 1 : wz;
    const z1 = run === 'z' ? wz + 1 : wz;
    clearBox(world, x0, FLOOR + 2, z0, x1, FLOOR + 2, z1);
    fillBox(world, x0, FLOOR + 1, z0, x1, FLOOR + 1, z1, COL_WOOD, Mat.Wood);
    fillBox(world, x0, WALL, z0, x1, WALL, z1, COL_WOOD_DARK, Mat.Wood);
    // Shutter, lifted out and up on a pole.
    fillBox(world, x0 + ox, WALL, z0 + oz, x1 + ox, WALL, z1 + oz, COL_BAMBOO, Mat.Wood);
    world.setFast(x0 + ox, FLOOR + 2, z0 + oz, COL_TRUNK_PALE, Mat.Wood);
  };
  opening(hx - 3, hz, 'z', -1, 0);
  opening(hx + 3, hz, 'z', 1, 0);
  opening(hx, hz - 3 * f, 'x', 0, -f);

  // Thatch. Gabled, ridge along the long axis, with a matting screen closing
  // each end under it.
  pitchedRoof(
    world, hx, WALL + 1, hz, 5, 5,
    COL_THATCH, COL_THATCH_DARK, COL_THATCH_DARK, COL_BAMBOO_DARK, false,
  );
  // Corner braces under the eave, carrying the overhang.
  for (const bx of [-4, 4]) {
    for (const bz of [-4, 4]) {
      world.setFast(hx + bx, WALL, hz + bz, COL_TRUNK_DARK, Mat.Wood);
    }
  }

  // Up onto the deck: one step, under the eave.
  fillBox(world, hx, y + 1, hz + 5 * f, hx, y + 1, hz + 5 * f, COL_WOOD_DARK, Mat.Wood);
  // A jar of water at the foot of the steps, for your feet before you go up.
  world.setFast(hx + 2, y, hz + 5 * f, COL_TILE_DARK, Mat.Stone);
}

/**
 * Village house: ochre stucco on a stone footing under a hipped terracotta
 * roof. Sits on the ground rather than on stilts, so a hamlet built from both
 * types has two silhouettes in it instead of one repeated.
 */
function buildTileHouse(world: VoxelWorld, hx: number, groundY: number, hz: number, face = -1): void {
  const y = groundY + 1;
  const f = face < 0 ? -1 : 1;
  const HEAD = y + 4;

  // Walls: a stone footing course, ochre above it, whitewash under the eaves.
  fillBox(world, hx - 4, y, hz - 3, hx + 4, HEAD, hz + 3, COL_STUCCO_OCHRE, Mat.Stone);
  for (let dz = -3; dz <= 3; dz++) {
    for (let dx = -4; dx <= 4; dx++) {
      if (Math.abs(dx) !== 4 && Math.abs(dz) !== 3) continue;
      world.setFast(hx + dx, y, hz + dz, grain(hx + dx, y, hz + dz) < 0.5 ? COL_STONE : COL_STONE_DARK, Mat.Stone);
      world.setFast(hx + dx, HEAD, hz + dz, COL_STUCCO, Mat.Stone);
      // Damp rising out of the footing, which is what these walls always look
      // like a metre off the ground.
      if (grain(hx + dx, y + 1, hz + dz) < 0.3) {
        world.setFast(hx + dx, y + 1, hz + dz, COL_LATERITE_DARK, Mat.Stone);
      }
    }
  }
  clearBox(world, hx - 3, y, hz - 2, hx + 3, HEAD, hz + 2);

  // Doorway on the street face: three high, framed in timber, with a stone
  // threshold across it.
  const dz = hz + 3 * f;
  clearBox(world, hx, y, dz, hx, y + 2, dz);
  fillBox(world, hx - 1, y, dz, hx - 1, y + 2, dz, COL_WOOD_DARK, Mat.Wood);
  fillBox(world, hx + 1, y, dz, hx + 1, y + 2, dz, COL_WOOD_DARK, Mat.Wood);
  world.setFast(hx, y + 3, dz, COL_WOOD, Mat.Wood);
  world.setFast(hx, y - 1, dz + f, COL_STONE, Mat.Stone);

  /**
   * A window: one course high, with a sawn sill under it and a lintel over.
   *
   * One course, not two. Two reads as an arcade -- with six of them the front
   * of the house stops being a wall with holes in it and becomes a row of
   * columns, which is the opposite of what a window is for.
   */
  const opening = (x0: number, x1: number, z0: number, z1: number): void => {
    // High in the wall, above the eye of anyone stood outside. Down at eye
    // level the openings are all you see and the house reads as an arcade;
    // up here the wall stays a wall and the windows sit where a village
    // house actually puts them, under the eaves and out of the sun.
    clearBox(world, x0, y + 3, z0, x1, y + 3, z1);
    fillBox(world, x0, y + 2, z0, x1, y + 2, z1, COL_WOOD, Mat.Wood);
    fillBox(world, x0, HEAD, z0, x1, HEAD, z1, COL_WOOD_DARK, Mat.Wood);
  };
  const bz = hz - 3 * f;
  opening(hx - 3, hx - 2, dz, dz);
  opening(hx + 2, hx + 3, dz, dz);
  opening(hx - 3, hx - 2, bz, bz);
  opening(hx + 2, hx + 3, bz, bz);
  opening(hx - 4, hx - 4, hz - 1, hz + 1);
  opening(hx + 4, hx + 4, hz - 1, hz + 1);

  // Tile, hipped in on all four sides to a short ridge.
  pitchedRoof(
    world, hx, HEAD + 1, hz, 5, 4,
    COL_TILE, COL_TILE_DARK, COL_TILE_DARK, COL_TILE_DARK, true,
  );

  // A water jar and a stack of firewood against the front wall.
  world.setFast(hx + 3, y, dz + f, COL_TILE_DARK, Mat.Stone);
  world.setFast(hx + 3, y + 1, dz + f, COL_WOOD_DARK, Mat.Wood);
  fillBox(world, hx - 3, y, dz + f, hx - 2, y, dz + f, COL_TRUNK, Mat.Wood);
}

/**
 * Rice paddies: flooded plots inside a grid of earth bunds.
 *
 * Everything here lives in the *surface* layer: the flooded floor of a plot and
 * the bund that divides it from the next one are both a single voxel at the
 * field's level, differing only in colour. The field is dead flat and flush
 * with the ground around it -- no terraces, no raised footpaths, nothing to
 * step up onto. The bunds still read as the path network they are, because mud
 * and standing water are not the colour of packed earth.
 *
 * Nothing is *built* above that level, and the one thing that grows above it --
 * the crop -- is not a voxel at all. Rice is recorded into the layout here and
 * drawn as scenery (fx/Rice.ts), which is what makes a plot something you walk
 * into instead of onto, and what lets a man who gets down in one disappear
 * (see `riceConceals`). That is the whole tactical point of the field: it is
 * open ground under the firebase's guns, and the only way across it that isn't
 * suicide is on your belt buckle through the rice.
 *
 * Plots are at different points in the cycle -- some in standing rice, some
 * just transplanted, some still bare mud under the hoe -- which gives the
 * farmers something to be doing, keeps twenty plots from reading as one green
 * rectangle, and means the cover out there is patchy rather than total.
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
  const level = paddyLevel();

  for (let px = 0; px < PADDY_PLOTS_X; px++) {
    const x0 = PADDY_X0 + px * PADDY_PITCH;
    for (let pz = 0; pz < PADDY_PLOTS_Z; pz++) {
      const z0 = PADDY_Z0 + pz * PADDY_PITCH;
      const x1 = x0 + PADDY_PITCH;
      const z1 = z0 + PADDY_PITCH;

      // Bund ring, laid *in* the surface rather than on it. Adjacent plots
      // share an edge, so this is drawn per plot and simply overwrites the
      // neighbour's -- cheaper than tracking shared runs.
      clearBox(world, x0, level + 1, z0, x1, level + 4, z1);
      fillBox(world, x0, level, z0, x1, level, z0, COL_LATERITE_DARK, Mat.Dirt);
      fillBox(world, x0, level, z1, x1, level, z1, COL_LATERITE_DARK, Mat.Dirt);
      fillBox(world, x0, level, z0, x0, level, z1, COL_LATERITE_DARK, Mat.Dirt);
      fillBox(world, x1, level, z0, x1, level, z1, COL_LATERITE_DARK, Mat.Dirt);

      // Where this plot is in the cycle. Bare plots cluster towards the west,
      // because that is the end you flood and work first.
      const roll = rng() + px * 0.13;
      // Weighted towards standing crop: a field that is mostly bare mud is a
      // field with nowhere to hide, and the crop is the only reason to be out
      // there at all.
      const state = roll < 0.3 ? PlotState.Bare : roll < 0.55 ? PlotState.Young : PlotState.Grown;
      paddyPlots[px * PADDY_PLOTS_Z + pz] = state;
      // A grown plot is close to solid crop -- that is what makes it somewhere
      // a man can lie up -- while a transplanted one is still thin rows.
      const density = state === PlotState.Grown ? 0.92 : state === PlotState.Young ? 0.4 : 0;
      // A bare plot is under the hoe, so it carries the ridge-and-furrow of
      // ground that has been turned but not yet levelled and flooded flat.
      const furrowed = state === PlotState.Bare;

      for (let z = z0 + 1; z < z1; z++) {
        for (let x = x0 + 1; x < x1; x++) {
          const furrow = furrowed && ((z - z0) & 1) === 0;
          const mud = furrow || rng() < 0.18;
          world.setFast(x, level, z, mud ? COL_PADDY_MUD : COL_PADDY_WATER, Mat.Dirt);
          // The crop is *not* a voxel. Rice you can walk into is worth more
          // than rice you can stand on, so it is recorded here and drawn as
          // scenery (fx/Rice.ts) -- which is also why a round goes through it.
          // Nothing is planted in the margin against the bund, which keeps the
          // footpaths readable and keeps them out of cover.
          const margin = x < x0 + 2 || x > x1 - 2 || z < z0 + 2 || z > z1 - 2;
          if (!margin && rng() < density) {
            layout.ricePatches.push({
              x: x + 0.5, y: level + 1, z: z + 0.5,
              dry: rng() < 0.22,
              height: RICE_HEIGHT * (state === PlotState.Grown ? 0.85 + rng() * 0.3 : 0.4 + rng() * 0.25),
            });
          }
        }
      }
    }
  }

  // A hamlet on the natural ground off the eastern end, looking back across
  // the field, with the flag up. Placed off the heightmap rather than off the
  // field level, because the flattening feathers out here and the field level
  // would leave the houses standing over nothing.
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
// The road
// ---------------------------------------------------------------------------
/**
 * The dirt road between the firebase and the village.
 *
 * Everything the player does that isn't shooting happens at one end of this
 * road or the other -- resupply is in the village, the wave arrives at the hill
 * -- so the walk between them is the only quiet part of the loop, and it should
 * look like a road somebody's cart uses rather than a line drawn between two
 * markers. That means three things: it leaves the hill by the ramp, because the
 * cliff is unclimbable and a road that ignores that reads as paint; it bends,
 * because ground bends; and it is worn in the middle and ragged at the edges,
 * because that is what a track that gets walked is.
 *
 * The surface is colour only -- one voxel of packed earth swapped in at ground
 * level. Nothing is cut and nothing is raised, so the road climbs and dips with
 * whatever it crosses, and digging it up leaves a hole like any other dirt.
 */

/** Half-width of the packed running surface, in blocks. */
const ROAD_HALF = 2.5;
/** Half-width including the trodden margin either side of it. */
const ROAD_VERGE = 3.8;
/** Where the cart ruts sit, measured out from the crown. */
const RUT_INNER = 0.9;
const RUT_OUTER = 1.7;

const enum RoadCell {
  None = 0,
  /** Ragged trodden margin. Painted patchily, so the edge isn't a stencil. */
  Verge = 1,
  /** Packed earth. */
  Track = 2,
  /** The two wheel ruts, worn down to mud. */
  Rut = 3,
}

/** Catmull-Rom through a polyline, evaluated at `t` in segment `i`. */
function splineAt(pts: { x: number; z: number }[], i: number, t: number): { x: number; z: number } {
  const p = (k: number): { x: number; z: number } => pts[clamp(k, 0, pts.length - 1)];
  const p0 = p(i - 1), p1 = p(i), p2 = p(i + 1), p3 = p(i + 2);
  const t2 = t * t;
  const t3 = t2 * t;
  const f = (a: number, b: number, c: number, d: number): number => 0.5 * (
    2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - 3 * c + d - a) * t3
  );
  return { x: f(p0.x, p1.x, p2.x, p3.x), z: f(p0.z, p1.z, p2.z, p3.z) };
}

/**
 * Works out where the road runs and stamps it into a mask, before anything is
 * planted or built. Nothing is written to the world here.
 */
function planRoad(
  base: { x: number; z: number },
  town: { x: number; z: number },
  rampAngles: number[],
): Uint8Array {
  const mask = new Uint8Array(WORLD_X * WORLD_Z);

  // Leave by whichever ramp points nearest the village. The cliff band is
  // deliberately unclimbable, so this is the only honest way off the hill.
  const bearing = Math.atan2(town.z - base.z, town.x - base.x);
  let ramp = rampAngles[0];
  let bestTurn = Infinity;
  for (const ra of rampAngles) {
    let d = (ra - bearing) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    if (Math.abs(d) < bestTurn) {
      bestTurn = Math.abs(d);
      ramp = ra;
    }
  }
  const dirX = Math.cos(ramp);
  const dirZ = Math.sin(ramp);

  const pts: { x: number; z: number }[] = [
    // On the scraped hilltop, short of the Core.
    { x: base.x + dirX * (MESA_TOP_R - 6), z: base.z + dirZ * (MESA_TOP_R - 6) },
    // Down the ramp and out of its mouth, still running the ramp's line: a
    // road that starts turning before it is off the grade reads as a shortcut.
    { x: base.x + dirX * RAMP_OUTER_R, z: base.z + dirZ * RAMP_OUTER_R },
    { x: base.x + dirX * (RAMP_OUTER_R + 8), z: base.z + dirZ * (RAMP_OUTER_R + 8) },
  ];
  const gate = { x: town.x - TOWN_HALF_X - 4, z: town.z };
  // One long sweep around the foot of the hill, bulging away from the cliff so
  // the road holds its distance from the skirt instead of hugging it.
  const midX = (pts[2].x + gate.x) / 2;
  const midZ = (pts[2].z + gate.z) / 2;
  const away = Math.hypot(midX - base.x, midZ - base.z) || 1;
  pts.push({
    x: midX + ((midX - base.x) / away) * 5,
    z: midZ + ((midZ - base.z) / away) * 5,
  });
  pts.push(gate);
  // Past the gate, so the mask keeps the trees off the village approach.
  pts.push({ x: town.x - TOWN_HALF_X + 1, z: town.z });

  const stamp = (cx: number, cz: number, tx: number, tz: number): void => {
    // Perpendicular to the heading, for the ruts.
    const tl = Math.hypot(tx, tz) || 1;
    const nx = -tz / tl;
    const nz = tx / tl;
    const r = Math.ceil(ROAD_VERGE) + 1;
    const x0 = Math.round(cx);
    const z0 = Math.round(cz);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = x0 + dx;
        const z = z0 + dz;
        if (x < 1 || z < 1 || x >= WORLD_X - 1 || z >= WORLD_Z - 1) continue;
        const ox = x + 0.5 - cx;
        const oz = z + 0.5 - cz;
        const d = Math.hypot(ox, oz);
        if (d > ROAD_VERGE) continue;
        const lateral = Math.abs(ox * nx + oz * nz);
        let cell: RoadCell;
        if (d > ROAD_HALF) cell = RoadCell.Verge;
        else if (lateral >= RUT_INNER && lateral <= RUT_OUTER) cell = RoadCell.Rut;
        else cell = RoadCell.Track;
        const i = z * WORLD_X + x;
        if (mask[i] < cell) mask[i] = cell;
      }
    }
  };

  const SEG_STEPS = 24;
  for (let i = 0; i < pts.length - 1; i++) {
    for (let s = 0; s <= SEG_STEPS; s++) {
      const t = s / SEG_STEPS;
      const c = splineAt(pts, i, t);
      const ahead = splineAt(pts, i, Math.min(1, t + 0.02));
      let tx = ahead.x - c.x;
      let tz = ahead.z - c.z;
      if (tx === 0 && tz === 0) { tx = 1; tz = 0; }
      // A hand's worth of wander, so the centreline isn't drawn with a ruler.
      const phase = (i + t) * 1.7;
      const tl = Math.hypot(tx, tz) || 1;
      const wander = Math.sin(phase * 2.3) * 1.1 + Math.sin(phase * 0.8 + 1.3) * 0.7;
      stamp(c.x + (-tz / tl) * wander, c.z + (tx / tl) * wander, tx, tz);
    }
  }
  return mask;
}

/**
 * Cuts and fills the road's own cells so the track runs at a walkable grade.
 *
 * Painting a colour onto natural ground gives you a road you have to scramble
 * up in places, which is not a road. This levels each cell toward the mean of
 * its neighbours along the track -- shaving the humps, filling the dips -- but
 * only ever by a couple of blocks a pass, so it grades the ground the road
 * crosses instead of driving a trench through it. What is left where it cuts
 * is a laterite bank at the verge, which is what the real ones look like.
 */
function gradeRoad(
  world: VoxelWorld,
  heights: Int16Array,
  mask: Uint8Array,
  town: { x: number; z: number },
): void {
  const target = new Int16Array(WORLD_X * WORLD_Z);
  const onRoad = (x: number, z: number): boolean => {
    if (x < 1 || z < 1 || x >= WORLD_X - 1 || z >= WORLD_Z - 1) return false;
    const i = z * WORLD_X + x;
    return mask[i] !== RoadCell.None
      && townDistance(x, z, town) > 0
      && heights[i] > WATER_LEVEL;
  };

  for (let pass = 0; pass < 2; pass++) {
    for (let z = 1; z < WORLD_Z - 1; z++) {
      for (let x = 1; x < WORLD_X - 1; x++) {
        const i = z * WORLD_X + x;
        if (!onRoad(x, z)) { target[i] = heights[i]; continue; }
        let sum = 0;
        let n = 0;
        for (let dz = -2; dz <= 2; dz++) {
          for (let dx = -2; dx <= 2; dx++) {
            if (!onRoad(x + dx, z + dz)) continue;
            sum += heights[(z + dz) * WORLD_X + x + dx];
            n++;
          }
        }
        const mean = n > 0 ? sum / n : heights[i];
        target[i] = clamp(Math.round(mean), heights[i] - 2, heights[i] + 2);
      }
    }

    for (let z = 1; z < WORLD_Z - 1; z++) {
      for (let x = 1; x < WORLD_X - 1; x++) {
        const i = z * WORLD_X + x;
        if (!onRoad(x, z)) continue;
        const h = heights[i];
        const t = target[i];
        if (t > h) {
          // Fill: packed earth under the new surface.
          fillBox(world, x, h, z, x, t, z, COL_DIRT, Mat.Dirt);
        } else if (t < h) {
          clearBox(world, x, t + 1, z, x, h, z);
        }
        heights[i] = t;
      }
    }
  }
}

/**
 * Lays the planned road into the world's surface layer.
 *
 * Skips the village shelf: the market square has its own floor and its own
 * street, and the road's job is to arrive at the gate.
 */
function paintRoad(
  world: VoxelWorld,
  heights: Int16Array,
  mask: Uint8Array,
  town: { x: number; z: number },
): void {
  gradeRoad(world, heights, mask, town);

  for (let z = 1; z < WORLD_Z - 1; z++) {
    for (let x = 1; x < WORLD_X - 1; x++) {
      const i = z * WORLD_X + x;
      const cell = mask[i] as RoadCell;
      if (cell === RoadCell.None) continue;
      if (townDistance(x, z, town) <= 0) continue;

      const h = heights[i];
      if (h <= WATER_LEVEL) continue;

      const g = grain(x, 0, z);
      if (cell === RoadCell.Verge) {
        // Ragged: about a third of the margin keeps whatever was already
        // there, which is what stops the road having a drawn outline.
        if (g > 0.62) continue;
        world.setFast(x, h, z, g < 0.3 ? COL_LATERITE : COL_GRASS_DRY, Mat.Dirt);
        continue;
      }

      const col = cell === RoadCell.Rut
        ? (g < 0.5 ? COL_MUD : COL_DIRT_DARK)
        : (g < 0.3 ? COL_DIRT_DARK : g < 0.78 ? COL_LATERITE_DARK : COL_LATERITE);
      world.setFast(x, h, z, col, Mat.Dirt);
      // Insurance: the mask kept the jungle off the road at planting time, but
      // a bush seeded on the cell next door can still have a leaf over it.
      clearBox(world, x, h + 1, z, x, h + 2, z);
    }
  }
}

// ---------------------------------------------------------------------------
// The firebase
// ---------------------------------------------------------------------------
/**
 * The player's firebase.
 *
 * Nothing is built here. A Vietnam fire support base started as a hilltop an
 * engineer platoon put a dozer on and scraped flat, and that is the state the
 * player inherits it in: bare laterite out to the edge of the cut, with the
 * radio on its block in the middle and the colours beside it. Whatever gets
 * put up around them is the player's to place.
 */
function buildStarterFort(world: VoxelWorld, layout: MapLayout, baseY = BASE_PLATEAU_Y, center = BASE_CENTER): void {
  const cx = center.x;
  const cz = center.z;
  /** Ground surface. Structures stand on the layer above it. */
  const g = baseY;
  const y = baseY + 1;

  // -------------------------------------------------------------------------
  // 1. Scrape the hilltop: churned laterite, level, and clear to the sky. The
  //    open ground *is* the position -- field of fire is the whole reason the
  //    base is on this hill and not the next one.
  // -------------------------------------------------------------------------
  for (let dz = -MESA_TOP_R; dz <= MESA_TOP_R; dz++) {
    for (let dx = -MESA_TOP_R; dx <= MESA_TOP_R; dx++) {
      const d = Math.hypot(dx, dz);
      if (d > MESA_TOP_R) continue;
      const gx = cx + dx;
      const gz = cz + dz;
      if (gx < 1 || gz < 1 || gx >= WORLD_X - 1 || gz >= WORLD_Z - 1) continue;
      clearBox(world, gx, g + 1, gz, gx, Math.min(WORLD_Y - 1, g + 12), gz);
      if (world.get(gx, g, gz) === 0) continue;
      const n = grain(gx, 0, gz);
      const col = n < 0.4 ? COL_DIRT_DARK : n < 0.78 ? COL_LATERITE : COL_LATERITE_DARK;
      world.setFast(gx, g, gz, col, Mat.Dirt);
    }
  }

  // -------------------------------------------------------------------------
  // 2. The radio on its slab.
  // -------------------------------------------------------------------------
  fillBox(world, cx, y, cz, cx, y, cz, COL_CONCRETE_DARK, Mat.Reinforced);
  world.setFast(layout.corePosition.x, layout.corePosition.y, layout.corePosition.z, COL_CORE, Mat.Core);

  // The colours, on their pole right next to the set. The compound is the
  // player's, so it flies the Stars and Stripes; every other pole on the map
  // flies the star flag.
  addFlagSite(layout, cx - 2, y, cz, 0, 1, true);
}

/**
 * The village: a market square with a street through it and huts either side.
 *
 * This is the only place on the map that isn't either a firebase or a field of
 * fire, and it has one job beyond the shop menu: to be somewhere that people
 * live. That is almost entirely a question of layout. A ring of buildings
 * around a plaza reads as a level; a street with houses set back off it, each
 * with its own yard, its own water jar and its own path down to the road, reads
 * as a village -- because that is how a village is actually arranged, houses
 * facing the way people walk.
 *
 * So: the road arrives from the hill, becomes the street, runs through both
 * gates of the market square and out the far side. The four merchants stand
 * behind four stalls, two on each side of it, facing across it at each other.
 * Six huts sit back from the street in their own fenced yards, doors turned
 * toward it, alternating stilt house and tile house so no two neighbours have
 * the same silhouette. Everything else -- the well, the drying racks, the
 * cook fires, the jars -- is there so the gaps between the buildings look
 * lived in rather than empty.
 */
function buildTown(
  world: VoxelWorld,
  layout: MapLayout,
  rng: () => number,
  townY = TOWN_Y,
  center = TOWN_CENTER,
): void {
  const cx = Math.round(center.x);
  const cz = Math.round(center.z);
  /** Ground surface of the shelf. Everything stands on the layer above it. */
  const g = townY;
  const y = townY + 1;

  // -------------------------------------------------------------------------
  // 1. The shelf: level ground, cleared to the sky
  // -------------------------------------------------------------------------
  for (let z = cz - TOWN_HALF_Z; z <= cz + TOWN_HALF_Z; z++) {
    for (let x = cx - TOWN_HALF_X; x <= cx + TOWN_HALF_X; x++) {
      if (x < 1 || z < 1 || x >= WORLD_X - 1 || z >= WORLD_Z - 1) continue;
      // Fill any dip the flattening left under the rectangle, then clear the
      // headroom. Both are belt and braces on a generated map and the only
      // thing that makes an imported one buildable.
      for (let fy = g - 3; fy <= g; fy++) {
        if (world.get(x, fy, z) === 0) world.setFast(x, fy, z, COL_DIRT, Mat.Dirt);
      }
      clearBox(world, x, g + 1, z, x, Math.min(WORLD_Y - 1, g + 14), z);

      // Trodden ground: bare in the middle where the village walks, thinning
      // back to dry grass at the edges of the clearing.
      const wear = 1 - Math.max(
        Math.abs(x - cx) / TOWN_HALF_X,
        Math.abs(z - cz) / TOWN_HALF_Z,
      );
      // Patches, not pixels: worn ground comes in bald spots a few blocks
      // across with speckled edges, which is what a village floor looks like.
      // Per-voxel noise on its own gives a checkerboard.
      const patch = clamp((fbm(x / 7, z / 7, 4711, 2) - 0.5) * 2.6 + 0.5, 0, 1);
      const n = patch * 0.9 + grain(x, 0, z) * 0.1;
      if (n < 0.32 + wear * 0.4) {
        world.setFast(x, g, z, n < 0.3 ? COL_LATERITE : COL_LATERITE_DARK, Mat.Dirt);
      } else if (n < 0.88) {
        world.setFast(x, g, z, n < 0.7 ? COL_DIRT : COL_GRASS_DRY, Mat.Dirt);
      }
    }
  }

  /** Packed earth, for the street and the paths off it. */
  const paveStrip = (x0: number, z0: number, x1: number, z1: number): void => {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        if (x < 1 || z < 1 || x >= WORLD_X - 1 || z >= WORLD_Z - 1) continue;
        const n = grain(x, 0, z);
        // Ragged at the last block either side, so a path has edges rather
        // than an outline.
        const edge = x === x0 || x === x1 || z === z0 || z === z1;
        if (edge && n > 0.55) continue;
        world.setFast(x, g, z, n < 0.34 ? COL_DIRT_DARK : n < 0.8 ? COL_LATERITE_DARK : COL_MUD, Mat.Dirt);
      }
    }
  };

  // The street, gate to gate and out both ends to meet the road.
  paveStrip(cx - TOWN_HALF_X, cz - STREET_HALF, cx + TOWN_HALF_X, cz + STREET_HALF);

  // -------------------------------------------------------------------------
  // 2. The market square
  // -------------------------------------------------------------------------
  // Packed-earth floor. Colour only -- the material stays Reinforced so the
  // ground can't be dug out from under the merchants.
  for (let z = cz - MARKET_HALF_Z; z <= cz + MARKET_HALF_Z; z++) {
    for (let x = cx - MARKET_HALF_X; x <= cx + MARKET_HALF_X; x++) {
      const n = grain(x, 0, z);
      world.setFast(x, g, z, n < 0.45 ? COL_LATERITE_DARK : n < 0.85 ? COL_LATERITE : COL_DIRT_DARK, Mat.Reinforced);
    }
  }

  // Fence around it: stucco posts with bamboo rails slung between them, which
  // says market square where a solid wall says compound.
  const fenceSide = (
    x0: number, z0: number, x1: number, z1: number,
    skip: (x: number, z: number) => boolean,
    tall = true,
  ): void => {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0));
    const sx = Math.sign(x1 - x0);
    const sz = Math.sign(z1 - z0);
    for (let i = 0; i <= steps; i++) {
      const x = x0 + sx * i;
      const z = z0 + sz * i;
      if (skip(x, z)) continue;
      if (!tall) {
        // Yard fence: posts to the waist with one rail slung between them, so
        // you can see over it into somebody's yard from the street.
        if (i % 3 === 0) fillBox(world, x, y, z, x, y + 1, z, COL_BAMBOO_DARK, Mat.Wood);
        else fillBox(world, x, y + 1, z, x, y + 1, z, COL_BAMBOO, Mat.Wood);
      } else if (i % 4 === 0) {
        fillBox(world, x, y, z, x, y + 2, z, COL_STUCCO_OCHRE, Mat.Stone);
      } else {
        fillBox(world, x, y + 1, z, x, y + 1, z, COL_BAMBOO, Mat.Wood);
        fillBox(world, x, y + 2, z, x, y + 2, z, COL_BAMBOO_DARK, Mat.Wood);
      }
    }
  };
  const inGate = (x: number, z: number): boolean =>
    Math.abs(z - cz) <= STREET_HALF && Math.abs(Math.abs(x - cx) - MARKET_HALF_X) < 0.5;
  fenceSide(cx - MARKET_HALF_X, cz - MARKET_HALF_Z, cx + MARKET_HALF_X, cz - MARKET_HALF_Z, inGate);
  fenceSide(cx - MARKET_HALF_X, cz + MARKET_HALF_Z, cx + MARKET_HALF_X, cz + MARKET_HALF_Z, inGate);
  fenceSide(cx - MARKET_HALF_X, cz - MARKET_HALF_Z, cx - MARKET_HALF_X, cz + MARKET_HALF_Z, inGate);
  fenceSide(cx + MARKET_HALF_X, cz - MARKET_HALF_Z, cx + MARKET_HALF_X, cz + MARKET_HALF_Z, inGate);

  // Gateways: two heavy posts and a thatched lintel over the street, one at
  // each end, so arriving at the village is something you walk through.
  for (const side of [-1, 1]) {
    const gx = cx + side * MARKET_HALF_X;
    for (const gz of [cz - STREET_HALF - 1, cz + STREET_HALF + 1]) {
      fillBox(world, gx, y, gz, gx, y + 4, gz, COL_TRUNK_DARK, Mat.Wood);
    }
    fillBox(world, gx, y + 5, cz - STREET_HALF - 1, gx, y + 5, cz + STREET_HALF + 1, COL_WOOD, Mat.Wood);
    fillBox(world, gx, y + 6, cz - STREET_HALF - 2, gx, y + 6, cz + STREET_HALF + 2, COL_THATCH, Mat.Wood);
  }

  // -------------------------------------------------------------------------
  // 3. Stalls, and the merchants behind them
  // -------------------------------------------------------------------------
  /**
   * One stall. `face` is +1 for a counter on the +Z side and -1 for -Z; the
   * merchant stands in the middle of it with their back to the goods.
   */
  const stall = (
    sx: number, sz: number, face: number, roof: number, roofShade: number,
  ): { x: number; y: number; z: number; yaw: number } => {
    const back = sz - 2 * face;
    const front = sz + 2 * face;

    // Back wall, woven light and dark, on a bamboo frame.
    for (let yy = y; yy <= y + 3; yy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const post = Math.abs(dx) === 3;
        world.setFast(sx + dx, yy, back, post ? COL_TRUNK_DARK
          : grain(sx + dx, yy, back) < 0.42 ? COL_BAMBOO : COL_BAMBOO_DARK, Mat.Wood);
      }
    }
    // Two uprights at the front, and the rail they hang the goods off.
    fillBox(world, sx - 3, y, front, sx - 3, y + 3, front, COL_TRUNK_DARK, Mat.Wood);
    fillBox(world, sx + 3, y, front, sx + 3, y + 3, front, COL_TRUNK_DARK, Mat.Wood);
    fillBox(world, sx - 3, y + 3, front, sx + 3, y + 3, front, COL_BAMBOO, Mat.Wood);
    // Awning: pitched, ridge along the street, oversailing the counter so the
    // goods are in the shade.
    pitchedRoof(
      world, sx, y + 4, sz, 4, 3,
      roof, roofShade, COL_BAMBOO_DARK, COL_CANVAS, false,
    );
    // Counter. One block, deliberately: at two it comes up past the eye of the
    // man standing at it and you are buying a rifle from a hat.
    fillBox(world, sx - 3, y, front, sx + 3, y, front, COL_WOOD, Mat.Wood);
    fillBox(world, sx - 2, y + 1, front, sx - 2, y + 1, front, COL_CANVAS, Mat.Wood);
    fillBox(world, sx + 1, y + 1, front, sx + 2, y + 1, front, COL_RICE_DRY, Mat.Wood);
    // Sacks and crates stacked against the back wall.
    fillBox(world, sx - 3, y, back + face, sx - 2, y, back + face, COL_CANVAS, Mat.Wood);
    fillBox(world, sx + 2, y, back + face, sx + 3, y + 1, back + face, COL_WOOD_DARK, Mat.Wood);
    // Stock hung off the rail, which is where half of a market's stock lives.
    // Only at the ends: the three cells in the middle are the line between the
    // player's eye and the merchant's face, and a sack hanging in it makes the
    // shop a conversation with a sack.
    world.setFast(sx - 2, y + 2, front, COL_RICE_DRY, Mat.Wood);
    world.setFast(sx + 2, y + 2, front, COL_CANVAS, Mat.Wood);

    // Stood at the counter rather than in the middle of the stall: close
    // enough that the goods are within reach of them, which is the difference
    // between a merchant and someone loitering under an awning.
    return { x: sx + 0.5, y, z: sz + 0.5 + face * 0.8, yaw: face > 0 ? 0 : Math.PI };
  };

  // Four stalls, two a side, facing each other across the street. The order
  // here is the order the shop kinds are read off in the client.
  layout.merchantSpots.push(stall(cx - 7, cz - 5, 1, COL_THATCH, COL_THATCH_DARK));
  layout.merchantSpots.push(stall(cx + 7, cz - 5, 1, COL_CANVAS, COL_RICE_DRY));
  layout.merchantSpots.push(stall(cx - 7, cz + 5, -1, COL_CANVAS, COL_RICE_DRY));
  layout.merchantSpots.push(stall(cx + 7, cz + 5, -1, COL_THATCH, COL_THATCH_DARK));

  // The well, in the gap between the two north stalls: stone kerb, dark water,
  // and a windlass over it.
  const wx = cx;
  const wz = cz - 5;
  fillBox(world, wx - 1, y, wz - 1, wx + 1, y + 1, wz + 1, COL_STONE, Mat.Stone);
  fillBox(world, wx, y, wz, wx, y + 1, wz, COL_WATER, Mat.Dirt);
  world.setFast(wx, y, wz, COL_STONE_DARK, Mat.Stone);
  fillBox(world, wx - 1, y + 2, wz, wx - 1, y + 3, wz, COL_WOOD_DARK, Mat.Wood);
  fillBox(world, wx + 1, y + 2, wz, wx + 1, y + 3, wz, COL_WOOD_DARK, Mat.Wood);
  fillBox(world, wx - 1, y + 4, wz, wx + 1, y + 4, wz, COL_WOOD, Mat.Wood);
  fillBox(world, wx, y + 3, wz, wx, y + 3, wz, COL_STEEL_DARK, Mat.Steel);

  // Village flagpole, in the matching gap on the south side.
  addFlagSite(layout, cx, y, cz + 5, 1, 0);

  // -------------------------------------------------------------------------
  // 4. The huts
  // -------------------------------------------------------------------------
  /**
   * A homestead: the hut, a fenced yard around it with a gap toward the
   * street, a path down to the street, and the things a yard has in it.
   */
  const homestead = (
    hx: number, hz: number, stilt: boolean, face: number, yh: number,
  ): void => {
    if (stilt) buildStiltHouse(world, hx, g, hz, face);
    else buildTileHouse(world, hx, g, hz, face);

    const gateZ = hz + face * yh;
    const yardSkip = (x: number, z: number): boolean =>
      z === gateZ && Math.abs(x - hx) <= 1;
    fenceSide(hx - yh, hz - yh, hx + yh, hz - yh, yardSkip, false);
    fenceSide(hx - yh, hz + yh, hx + yh, hz + yh, yardSkip, false);
    fenceSide(hx - yh, hz - yh, hx - yh, hz + yh, yardSkip, false);
    fenceSide(hx + yh, hz - yh, hx + yh, hz + yh, yardSkip, false);
    // Whatever else runs along that line -- the market fence does, where a
    // yard backs onto the square -- the gateway is a way through.
    clearBox(world, hx - 1, y, gateZ, hx + 1, y + 2, gateZ);

    // Path from the yard gate down to the street.
    const streetEdge = cz + Math.sign(-face) * STREET_HALF;
    paveStrip(
      hx - 1, Math.min(gateZ, streetEdge), hx + 1, Math.max(gateZ, streetEdge),
    );

    // Yard clutter, kept clear of the doorway.
    const side = face > 0 ? 1 : -1;
    waterJar(world, hx + 4, y, hz + side * 5);
    dryingRack(world, hx - 5, y, hz + side * 5);
    cookFire(world, hx - 4, y, hz - side * 5, rng);
    fillBox(world, hx + 4, y, hz - side * 5, hx + 5, y, hz - side * 5, COL_TRUNK, Mat.Wood);
    fillBox(world, hx + 4, y + 1, hz - side * 5, hx + 4, y + 1, hz - side * 5, COL_TRUNK_DARK, Mat.Wood);

    layout.villagerSpots.push({ x: hx + 0.5, y, z: gateZ - face * 1.5 + 0.5 });
  };

  // Six of them, three a side, alternating silhouette so no two neighbours are
  // the same building. Each is nudged a block off the row: houses are built
  // where there was room for one, not on a survey line.
  // The nudge is always toward the street, so no yard ever ends up hanging off
  // the edge of the shelf.
  const jitter = (): number => (rng() < 0.45 ? 1 : 0);
  //          x        z                      stilt  faces  yard
  homestead(cx - 18, cz - 13 + jitter(), true, 1, 6);
  homestead(cx, cz - 15 + jitter(), false, 1, 5);
  homestead(cx + 18, cz - 13 + jitter(), true, 1, 6);
  homestead(cx - 18, cz + 13 - jitter(), false, -1, 6);
  homestead(cx, cz + 15 - jitter(), true, -1, 5);
  homestead(cx + 18, cz + 13 - jitter(), false, -1, 6);

  // -------------------------------------------------------------------------
  // 5. Greenery, so the shelf isn't a bare rectangle with buildings on it
  // -------------------------------------------------------------------------
  // Kept out of the street, the yards and the paths between them: a palm
  // growing where the carts go is the fastest way to make a village read as
  // something that was placed rather than something that grew.
  const greenery: [number, number][] = [
    [cx - 8, cz - 11], [cx + 8, cz - 11], [cx - 8, cz + 11], [cx + 8, cz + 11],
    [cx - 13, cz - 6], [cx + 13, cz + 6], [cx - 13, cz + 5], [cx + 13, cz - 5],
  ];
  for (const [px, pz] of greenery) {
    if (px < 2 || pz < 2 || px >= WORLD_X - 2 || pz >= WORLD_Z - 2) continue;
    const roll = rng();
    if (roll < 0.4) plantBanana(world, px, g, pz, rng);
    else if (roll < 0.7) plantPalm(world, px, g, pz, rng);
    else plantBush(world, px, g, pz, rng, 2.2);
  }

  // A few places for people with nothing to sell to stand around: the well,
  // the two gateways, and the middle of the street.
  layout.villagerSpots.push({ x: cx + 2.5, y, z: cz - 3.5 });
  layout.villagerSpots.push({ x: cx - 2.5, y, z: cz + 3.5 });
  layout.villagerSpots.push({ x: cx - MARKET_HALF_X - 3.5, y, z: cz + 2.5 });
  layout.villagerSpots.push({ x: cx + MARKET_HALF_X + 3.5, y, z: cz - 2.5 });
}

/** The glazed jar of drinking water that stands by every door. */
function waterJar(world: VoxelWorld, x: number, y: number, z: number): void {
  fillBox(world, x, y, z, x, y + 1, z, COL_TILE_DARK, Mat.Stone);
  fillBox(world, x, y + 2, z, x, y + 2, z, COL_WOOD_DARK, Mat.Wood);
}

/** Bamboo frame with the harvest hung over it to dry. */
function dryingRack(world: VoxelWorld, x: number, y: number, z: number): void {
  fillBox(world, x, y, z, x, y + 2, z, COL_BAMBOO, Mat.Wood);
  fillBox(world, x + 3, y, z, x + 3, y + 2, z, COL_BAMBOO, Mat.Wood);
  fillBox(world, x, y + 2, z, x + 3, y + 2, z, COL_BAMBOO_DARK, Mat.Wood);
  fillBox(world, x + 1, y + 1, z, x + 2, y + 1, z, COL_RICE_DRY, Mat.Wood);
}

/** Three stones, ash, and a pot over them. */
function cookFire(world: VoxelWorld, x: number, y: number, z: number, rng: () => number): void {
  world.setFast(x, y, z, COL_MUD, Mat.Dirt);
  world.setFast(x - 1, y, z, COL_STONE_DARK, Mat.Stone);
  world.setFast(x + 1, y, z, COL_STONE_DARK, Mat.Stone);
  world.setFast(x, y, z - 1, COL_STONE, Mat.Stone);
  if (rng() < 0.6) world.setFast(x, y + 1, z, COL_STEEL_DARK, Mat.Steel);
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
    villagerSpots: [],
    rampMouths: [],
    spiderHoles: [],
    outposts: [],
    crashSite: null,
    flagSites: [],
    ricePatches: [],
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
  buildTown(world, layout, makeRng(4211), townY, townCenter);
  // No carved ramps here, so the road leaves the pad on the bearing of
  // whichever notional mouth points nearest the village.
  paintRoad(
    world, heights,
    planRoad(base, townCenter, layout.rampMouths.map(
      (m) => Math.atan2(m.z - base.z, m.x - base.x),
    )),
    townCenter,
  );

  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    const sx = clamp(Math.round(cx + Math.cos(a) * 100), 6, WORLD_X - 7);
    const sz = clamp(Math.round(cz + Math.sin(a) * 100), 6, WORLD_Z - 7);
    layout.spawnPoints.push({ x: sx + 0.5, y: Math.max(WATER_LEVEL + 1, surfaceAt(sx, sz)), z: sz + 0.5 });
  }

  world.rebuildHeights();
  return layout;
}

// ---------------------------------------------------------------------------
// Tunnels
// ---------------------------------------------------------------------------
/** How far under the surface the galleries run. Mirrors ai/TunnelNetwork. */
const TUNNEL_DEPTH = 5;
/** Trunk lines driven in toward the hill from the treeline. */
const TUNNEL_LINES = 5;
/** Blocks between the mouths cut along a line. */
const MOUTH_SPACING = 21;
/** How close to the hilltop a line is driven before it stops. */
const TUNNEL_INNER_R = 26;
const TUNNEL_OUTER_R = 104;

/**
 * Cuts the network that is already under the valley at first light.
 *
 * The lines run in toward the firebase from the treeline, a couple of blocks
 * under the topsoil, with a shaft up to daylight every twenty paces or so.
 * They are dug rather than decorated: real air in real voxels, so the player
 * can drop into one and walk it, and so a grenade down a mouth does what a
 * grenade down a mouth should do.
 *
 * The lines meander. A dead straight bore reads as a corridor in a level, and
 * more usefully, a straight line from the treeline to the wire is a line the
 * player can learn once and cover forever.
 */
function digTunnelNetwork(
  world: VoxelWorld,
  layout: MapLayout,
  heights: Int16Array,
  rng: () => number,
): void {
  const surfaceAt = (x: number, z: number): number => {
    if (x < 0 || z < 0 || x >= WORLD_X || z >= WORLD_Z) return 0;
    return heights[z * WORLD_X + x];
  };

  /** Hollows one voxel, refusing bedrock and anything built. */
  const hollow = (x: number, y: number, z: number): void => {
    if (x < 1 || z < 1 || y < 2 || x >= WORLD_X - 1 || z >= WORLD_Z - 1 || y >= WORLD_Y - 1) return;
    const mat = world.materialAt(x, y, z);
    if (world.get(x, y, z) !== 0 && MATERIALS_INDESTRUCTIBLE(mat)) return;
    world.setFast(x, y, z, 0, 0);
  };

  const baseAngle = rng() * Math.PI * 2;

  for (let line = 0; line < TUNNEL_LINES; line++) {
    const a0 = baseAngle + (line / TUNNEL_LINES) * Math.PI * 2;
    // Wander, so no two lines are the same shape and none of them is straight.
    const wobble = 0.5 + rng() * 0.9;
    const wobbleRate = 0.018 + rng() * 0.02;
    let sinceMouth = MOUTH_SPACING * (0.3 + rng() * 0.5);

    for (let r = TUNNEL_OUTER_R; r > TUNNEL_INNER_R; r -= 1) {
      const a = a0 + Math.sin((TUNNEL_OUTER_R - r) * wobbleRate) * wobble * 0.25;
      const x = Math.round(BASE_CENTER.x + Math.cos(a) * r);
      const z = Math.round(BASE_CENTER.z + Math.sin(a) * r);
      if (x < 6 || z < 6 || x >= WORLD_X - 6 || z >= WORLD_Z - 6) continue;

      const surface = surfaceAt(x, z);
      // Nothing to tunnel under: open water, or ground too thin to hold a roof.
      if (surface <= WATER_LEVEL + 2) { sinceMouth += 1; continue; }
      const floor = Math.max(2, surface - TUNNEL_DEPTH);
      if (surface - floor < 3) { sinceMouth += 1; continue; }

      // Gallery: two high, two wide, so a man can move along it and the player
      // can follow him down it.
      for (let w = -1; w <= 0; w++) {
        const ox = Math.round(Math.cos(a + Math.PI / 2) * w);
        const oz = Math.round(Math.sin(a + Math.PI / 2) * w);
        hollow(x + ox, floor, z + oz);
        hollow(x + ox, floor + 1, z + oz);
      }

      sinceMouth += 1;
      if (sinceMouth < MOUTH_SPACING) continue;
      sinceMouth = 0;

      // Shaft to daylight. One voxel across: wide enough to climb, narrow
      // enough that it reads as a hole in the ground and not a stairwell.
      let blocked = false;
      for (let y = floor; y <= surface; y++) {
        if (world.get(x, y, z) !== 0 && MATERIALS_INDESTRUCTIBLE(world.materialAt(x, y, z))) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;

      // The lip has to be found before the shaft is cut: afterwards this column
      // is a hole, and a bot told to stand on it would fall down it.
      let lipX = 0;
      let lipZ = 0;
      let lipY = -1;
      for (let n = 0; n < LIP_DX.length; n++) {
        const nx = x + LIP_DX[n];
        const nz = z + LIP_DZ[n];
        if (nx < 2 || nz < 2 || nx >= WORLD_X - 2 || nz >= WORLD_Z - 2) continue;
        // Level with the mouth, and two clear blocks to stand in.
        if (surfaceAt(nx, nz) !== surface) continue;
        if (world.get(nx, surface + 1, nz) !== 0) continue;
        if (world.get(nx, surface + 2, nz) !== 0) continue;
        lipX = nx;
        lipZ = nz;
        lipY = surface + 1;
        break;
      }
      if (lipY < 0) continue;

      for (let y = floor; y <= surface; y++) hollow(x, y, z);

      layout.spiderHoles.push({
        x: x + 0.5, z: z + 0.5, floorY: floor,
        standX: lipX + 0.5, standZ: lipZ + 0.5, y: lipY,
      });
    }
  }

  world.rebuildHeights();
}

/** Local helper so the carve pass doesn't have to import the material table. */
function MATERIALS_INDESTRUCTIBLE(mat: number): boolean {
  return mat === Mat.Bedrock || mat === Mat.Core;
}

/** Neighbour offsets used to find the ground beside a shaft. */
const LIP_DX = [1, -1, 0, 0, 1, 1, -1, -1];
const LIP_DZ = [0, 0, 1, -1, 1, -1, 1, -1];
