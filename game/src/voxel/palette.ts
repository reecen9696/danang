/**
 * 256-entry colour palette. Every voxel stores a 1-byte palette index, which
 * keeps the world arrays small and lets the mesher bake vertex colours without
 * touching a texture.
 *
 * The world colours below are matched to Ace of Spades Classic, measured off
 * the gameplay captures in `../../../gamephotos` rather than guessed. (The
 * reference tree has no terrain palette to read: AoS stores colour per voxel in
 * the map file, and the only map OpenSpades ships -- Title.vxl -- is greyscale.)
 * Anchors, each the median pixel over a flat lit face:
 *
 *   grass  #50674b .. #5b7454      concrete  #545454 top, #646466 side
 *   sand   #c5b675                 dirt      #744c3e
 *   water  #1917ba                 deep green build block  #24511b
 *
 * The through-line is that AoS is *duller* than an obvious voxel palette wants
 * to be: greens are olive rather than lime, stone is neutral and fairly dark,
 * and water is the one saturated thing on screen. Water aside, a brighter and
 * more saturated set of numbers is exactly what makes the world read washed out
 * once the sun is on it.
 *
 * One mismatch worth remembering: AoS shades a voxel per-face and calls it
 * done, so a screenshot pixel is near enough its own albedo. Here these values
 * are albedo that then gets multiplied by sun + sky (core/lighting.ts), which
 * lands at ~1.0 on a lit upward face. Lit surfaces therefore match the captures
 * closely, and shaded ones sit darker than AoS would have drawn them.
 *
 * Layout:
 *   0        air
 *   1..63    fixed world colours (terrain, foliage, building materials)
 *   64..255  the player-selectable build palette (8 hues x 24 shades)
 */

export const PALETTE_SIZE = 256;
export const AIR = 0;

/** RGB triplets, 3 bytes per entry. */
export const palette = new Uint8Array(PALETTE_SIZE * 3);

function set(i: number, r: number, g: number, b: number): void {
  palette[i * 3] = r;
  palette[i * 3 + 1] = g;
  palette[i * 3 + 2] = b;
}

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------
export const COL_GRASS = 1;
export const COL_GRASS_DARK = 2;
export const COL_GRASS_LIGHT = 3;
export const COL_GRASS_DRY = 4;
export const COL_MOSS = 5;

export const COL_DIRT = 6;
export const COL_DIRT_DARK = 7;
export const COL_MUD = 8;

export const COL_SAND = 9;
export const COL_SAND_DARK = 10;

export const COL_ROCK = 11;
export const COL_ROCK_DARK = 12;
export const COL_CLIFF = 13;
export const COL_CLIFF_DARK = 14;
export const COL_GRAVEL = 15;
export const COL_SNOW = 16;

export const COL_WATER = 17;
export const COL_BEDROCK = 18;

set(COL_GRASS, 85, 110, 78);
set(COL_GRASS_DARK, 66, 88, 62);
set(COL_GRASS_LIGHT, 104, 130, 90);
set(COL_GRASS_DRY, 128, 130, 84);
set(COL_MOSS, 74, 98, 66);

set(COL_DIRT, 120, 84, 62);
set(COL_DIRT_DARK, 92, 64, 48);
set(COL_MUD, 76, 60, 46);

set(COL_SAND, 197, 182, 117);
set(COL_SAND_DARK, 168, 152, 96);

set(COL_ROCK, 92, 92, 94);
set(COL_ROCK_DARK, 72, 72, 74);
set(COL_CLIFF, 104, 98, 92);
set(COL_CLIFF_DARK, 80, 76, 70);
set(COL_GRAVEL, 114, 110, 104);
set(COL_SNOW, 222, 228, 236);

set(COL_WATER, 28, 32, 176);
set(COL_BEDROCK, 34, 34, 38);

// ---------------------------------------------------------------------------
// Foliage
// ---------------------------------------------------------------------------
/**
 * Bark, darkest to palest.
 *
 * Six tones rather than three because a trunk is drawn a block at a time and a
 * single flat colour reads as a painted post. The steps between neighbours are
 * deliberately small -- the point is a grain that catches the eye at two paces,
 * not a barber's pole.
 */
export const COL_TRUNK_SHADOW = 25;
export const COL_TRUNK_DARK = 20;
export const COL_TRUNK_WARM = 26;
export const COL_TRUNK = 19;
export const COL_TRUNK_GREY = 27;
export const COL_TRUNK_PALE = 21;

export const COL_LEAF = 22;
export const COL_LEAF_DARK = 23;
export const COL_LEAF_LIGHT = 24;

export const COL_PALM = 28;
export const COL_BUSH = 29;

set(COL_TRUNK_SHADOW, 56, 42, 32);
set(COL_TRUNK_DARK, 70, 52, 38);
set(COL_TRUNK_WARM, 84, 62, 44);
set(COL_TRUNK, 94, 72, 52);
// Weathered grey-brown: the lichen and sun-bleach side of a jungle trunk.
set(COL_TRUNK_GREY, 106, 92, 74);
set(COL_TRUNK_PALE, 124, 102, 74);

set(COL_LEAF, 66, 98, 54);
set(COL_LEAF_DARK, 48, 74, 42);
set(COL_LEAF_LIGHT, 88, 118, 62);

set(COL_PALM, 80, 116, 58);
set(COL_BUSH, 62, 92, 46);

// ---------------------------------------------------------------------------
// Building materials
// ---------------------------------------------------------------------------
export const COL_WOOD = 30;
export const COL_WOOD_DARK = 31;
export const COL_PLANK = 32;
export const COL_STONE = 33;
export const COL_STONE_DARK = 34;
export const COL_CONCRETE = 35;
export const COL_CONCRETE_DARK = 36;
export const COL_STEEL = 37;
export const COL_STEEL_DARK = 38;
export const COL_CORE = 39;
export const COL_SANDBAG = 40;
export const COL_RUST = 41;
export const COL_ROOF = 42;
export const COL_CANVAS = 43;

set(COL_WOOD, 132, 96, 58);
set(COL_WOOD_DARK, 102, 72, 44);
set(COL_PLANK, 152, 118, 76);
set(COL_STONE, 112, 112, 116);
set(COL_STONE_DARK, 88, 88, 92);
set(COL_CONCRETE, 140, 140, 138);
set(COL_CONCRETE_DARK, 114, 114, 112);
set(COL_STEEL, 100, 106, 118);
set(COL_STEEL_DARK, 78, 84, 96);
set(COL_CORE, 208, 162, 54);
set(COL_SANDBAG, 176, 158, 110);
set(COL_RUST, 122, 76, 48);
set(COL_ROOF, 132, 64, 50);
set(COL_CANVAS, 176, 166, 140);

// ---------------------------------------------------------------------------
// Vietnam
// ---------------------------------------------------------------------------
/**
 * Colours the jungle setting needs that a generic temperate palette has no
 * entry for. Indices 44..62 -- the tail of the fixed range, before the build
 * palette starts at 64.
 *
 * Same discipline as the block colours above: muted, low-saturation, sampled
 * against the AoS anchors. The two flag colours are the deliberate exception --
 * a flag that reads as dull red and dull yellow doesn't read as a flag at all,
 * so those stay close to the real #da251d / #ffff00.
 */
export const COL_LATERITE = 44;
export const COL_LATERITE_DARK = 45;
export const COL_PADDY_WATER = 46;
export const COL_PADDY_MUD = 47;
export const COL_RICE = 48;
export const COL_RICE_DRY = 49;
export const COL_BAMBOO = 50;
export const COL_BAMBOO_DARK = 51;
export const COL_THATCH = 52;
export const COL_THATCH_DARK = 53;
export const COL_TILE = 54;
export const COL_TILE_DARK = 55;
export const COL_STUCCO = 56;
export const COL_STUCCO_OCHRE = 57;
export const COL_JUNGLE = 58;
export const COL_JUNGLE_DARK = 59;
export const COL_JUNGLE_LIGHT = 60;
export const COL_FLAG_RED = 61;
export const COL_FLAG_STAR = 62;
/** Union canton on the fort's colours. Last free slot in the fixed range. */
export const COL_FLAG_NAVY = 63;

// Laterite: the iron-red earth that shows through wherever the canopy breaks.
set(COL_LATERITE, 138, 82, 54);
set(COL_LATERITE_DARK, 104, 60, 40);
// Standing paddy water is never blue -- it's silt and sky and algae.
set(COL_PADDY_WATER, 86, 104, 78);
set(COL_PADDY_MUD, 78, 66, 48);
set(COL_RICE, 124, 148, 68);
set(COL_RICE_DRY, 156, 152, 82);
set(COL_BAMBOO, 136, 142, 78);
set(COL_BAMBOO_DARK, 104, 112, 60);
set(COL_THATCH, 150, 126, 72);
set(COL_THATCH_DARK, 116, 96, 56);
set(COL_TILE, 140, 74, 52);
set(COL_TILE_DARK, 108, 56, 40);
set(COL_STUCCO, 186, 178, 154);
set(COL_STUCCO_OCHRE, 176, 148, 96);
// Jungle canopy sits a clear step darker than the temperate leaf greens.
set(COL_JUNGLE, 58, 92, 46);
set(COL_JUNGLE_DARK, 40, 68, 36);
set(COL_JUNGLE_LIGHT, 82, 116, 54);
set(COL_FLAG_RED, 198, 36, 32);
set(COL_FLAG_STAR, 246, 214, 46);
// Same licence as the two above: a canton mixed down to match the terrain
// stops reading as a flag, so it stays near the real #3c3b6e.
set(COL_FLAG_NAVY, 58, 58, 108);

// ---------------------------------------------------------------------------
// Build palette
// ---------------------------------------------------------------------------
export const BUILD_PALETTE_START = 64;
export const BUILD_HUES = 8;
export const BUILD_SHADES = 24;
export const BUILD_PALETTE_COUNT = BUILD_HUES * BUILD_SHADES; // 192

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r = 0;
  let g = 0;
  let b = 0;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

for (let hue = 0; hue < BUILD_HUES; hue++) {
  for (let shade = 0; shade < BUILD_SHADES; shade++) {
    const idx = BUILD_PALETTE_START + hue * BUILD_SHADES + shade;
    if (hue === 0) {
      // greyscale ramp
      const v = Math.round((shade / (BUILD_SHADES - 1)) * 255);
      set(idx, v, v, v);
    } else {
      const h = (hue - 1) / (BUILD_HUES - 1);
      // Walk from dark+saturated up to bright+washed for a usable ramp.
      const t = shade / (BUILD_SHADES - 1);
      const sat = 1 - t * 0.75;
      const val = 0.25 + t * 0.75;
      const [r, g, b] = hsvToRgb(h, sat, val);
      set(idx, r, g, b);
    }
  }
}

export function buildPaletteIndex(hue: number, shade: number): number {
  const h = ((hue % BUILD_HUES) + BUILD_HUES) % BUILD_HUES;
  const s = Math.max(0, Math.min(BUILD_SHADES - 1, shade));
  return BUILD_PALETTE_START + h * BUILD_SHADES + s;
}

export function paletteHex(i: number): string {
  const r = palette[i * 3];
  const g = palette[i * 3 + 1];
  const b = palette[i * 3 + 2];
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

/** Nearest palette entry to an RGB triplet — used by the .vxl importer. */
export function nearestPaletteIndex(r: number, g: number, b: number): number {
  let best = 1;
  let bestDist = Infinity;
  for (let i = 1; i < PALETTE_SIZE; i++) {
    const dr = palette[i * 3] - r;
    const dg = palette[i * 3 + 1] - g;
    const db = palette[i * 3 + 2] - b;
    // Weighted to approximate perceptual distance.
    const d = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}
