import * as THREE from 'three';
import { WORLD_X, WORLD_Z, Mat, RENDER } from '../core/constants';
import {
  palette,
  COL_GRASS, COL_GRASS_DARK, COL_GRASS_LIGHT, COL_GRASS_DRY, COL_MOSS,
  COL_JUNGLE, COL_JUNGLE_DARK, COL_JUNGLE_LIGHT,
} from '../voxel/palette';
import { BladeBuilder, bladeHash, applyWind, WIND_X, WIND_Z } from './blades';
import type { VoxelWorld } from '../voxel/VoxelWorld';

/**
 * The ground cover.
 *
 * The rice in the paddy (fx/Rice.ts) proved the technique and this is the rest
 * of it: short, ragged tufts scattered over every square of open ground on the
 * map, drawn as geometry rather than voxels so that walking through them is
 * exactly nothing -- no collision, no step up, no cover.
 *
 * It exists because of what the map became. The firebase now stands in the
 * middle of a hundred-block clearing, and a clearing is a hundred blocks of one
 * flat colour unless something is growing on it. Ground cover is the cheapest
 * possible answer to that and the only honest one: it gives the field a texture
 * that moves, a sense of scale at the player's own feet, and -- because a tuft
 * is tied to the colour of the block it stands on -- it makes the difference
 * between the lush ground and the burnt-off ground legible from a long way out
 * instead of only from directly overhead.
 *
 * ## Where it goes
 *
 * Nowhere is authored. A column gets grass when the topmost solid voxel in it
 * is earth (`Mat.Dirt`) *and* one of the grassland colours. That one test does
 * all the work:
 *
 *  - under a canopy the topmost voxel is a leaf, so nothing grows in the dark;
 *  - a canopy voxel is `Mat.Wood`, so nothing grows on top of a tree -- which
 *    matters, because the jungle greens are used for leaves and for the jungle
 *    floor alike and colour alone would put grass in the treetops;
 *  - roads, paddy mud, the scraped hilltop and the village square are all
 *    earth-coloured rather than grass-coloured, so the grass stops at the edge
 *    of them without anything having to say so.
 *
 * ## Why it is tiled
 *
 * One mesh for the whole map would be forty thousand tufts in a single draw
 * call with a bounding sphere the size of the world, i.e. always drawn. Cut
 * into tiles it culls twice over: by the frustum, and by distance -- everything
 * past the fog is solid fog colour, so a tile out there is geometry that cannot
 * be seen. In practice a handful of tiles are visible at once out of several
 * hundred.
 */

/** Edge of one tile, in blocks. Matches the voxel chunk pitch. */
const TILE = 32;
const TILES_X = Math.ceil(WORLD_X / TILE);
const TILES_Z = Math.ceil(WORLD_Z / TILE);

/** One candidate tuft per column; how many take is the interesting part. */
const PITCH = 1;

/**
 * How thick the cover gets, at its thinnest and at its thickest.
 *
 * Grass does not grow evenly and a field that does reads as turf. What is
 * wanted is patches: long stretches of thin scrubby ground with the odd
 * genuinely rank tussock in it, so that crossing the clearing is crossing
 * something with texture rather than something with a texture applied. So the
 * density is a noise field ({@link CLUMP_SCALE}) rather than a number, and the
 * curve below is weighted hard toward the thin end -- most of the map gets
 * almost nothing, and the thick patches are worth noticing because they are
 * rare.
 */
const DENSITY_MIN = 0.02;
const DENSITY_MAX = 0.72;
/** Blocks across one patch of thicker grass. */
const CLUMP_SCALE = 23;
/**
 * Where on the noise the grass starts coming in, and how much of the range is
 * left above it. Everything below the threshold is effectively bare.
 */
const CLUMP_FLOOR = 0.46;
const CLUMP_SPAN = 0.34;

/** Blades in a tuft. */
const BLADES = 3;

/**
 * How tall a tuft comes up, in blocks.
 *
 * Ankle to mid-shin, and deliberately nowhere near the rice. The crop in the
 * paddy is 1.55 and hides a crouched man; this has to be unmistakably shorter
 * than that from any distance, because the moment ground cover looks like it
 * might be concealment the player starts trying to hide in it. Wide range on
 * purpose -- an even sward reads as a lawn.
 */
const HEIGHT_MIN = 0.24;
const HEIGHT_MAX = 0.86;
/** Width of a strap at the root and at the tip. */
const BLADE_BASE = 0.075;
const BLADE_TIP = 0.022;
/** How far a tuft spreads from its own centre, in blocks. */
const SPREAD = 0.44;
/** Tip lean, as a fraction of the blade's height. Grass flops further than rice. */
const LEAN = 0.5;
/** Downwind push at the tips. Short blades move less than tall ones. */
const SWAY = 0.11;

/**
 * Ground a tuft will stand on.
 *
 * The jungle greens are in here as well as the meadow ones, because the floor
 * of a clearing in the trees is painted with them -- the `Mat.Dirt` test above
 * is what keeps them from also meaning "the top of a tree".
 */
const GROUND = new Set<number>([
  COL_GRASS, COL_GRASS_DARK, COL_GRASS_LIGHT, COL_GRASS_DRY, COL_MOSS,
  COL_JUNGLE, COL_JUNGLE_DARK, COL_JUNGLE_LIGHT,
]);

/** Past this the tile is inside the fog wall and drawing it achieves nothing. */
const CULL = RENDER.fogDistance + TILE;

/** Smoothstep, so the patches have soft edges rather than contour lines. */
function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * Value noise on a unit grid, in 0..1.
 *
 * Two octaves is plenty: this is deciding how thick the grass is, not carving
 * terrain, and the second octave is only there to stop the patches all being
 * the same size.
 */
function patchNoise(x: number, z: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let freq = 1;
  for (let o = 0; o < 2; o++) {
    const px = x * freq;
    const pz = z * freq;
    const xi = Math.floor(px);
    const zi = Math.floor(pz);
    const xf = smooth(px - xi);
    const zf = smooth(pz - zi);
    const a = bladeHash(xi, zi, 71 + o);
    const b = bladeHash(xi + 1, zi, 71 + o);
    const c = bladeHash(xi, zi + 1, 71 + o);
    const d = bladeHash(xi + 1, zi + 1, 71 + o);
    sum += ((a * (1 - xf) + b * xf) * (1 - zf) + (c * (1 - xf) + d * xf) * zf) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.3;
  }
  return sum / norm;
}

export class Grass {
  readonly group = new THREE.Group();

  private readonly time: { value: number };
  private readonly material: THREE.MeshLambertMaterial;
  private readonly tiles: THREE.Mesh[] = [];
  /** Tuft count, for the perf overlay. */
  tuftCount = 0;

  constructor(world: VoxelWorld) {
    this.group.name = 'grass';
    this.group.matrixAutoUpdate = false;

    // Double sided: a strap is one quad, so without this it is invisible from
    // behind and a patch of grass thins out as you walk round it.
    this.material = new THREE.MeshLambertMaterial({
      vertexColors: true,
      fog: true,
      side: THREE.DoubleSide,
    });
    this.time = applyWind(this.material, {
      sway: SWAY, windX: WIND_X, windZ: WIND_Z, speed: 2.1,
    });

    for (let tz = 0; tz < TILES_Z; tz++) {
      for (let tx = 0; tx < TILES_X; tx++) {
        const mesh = this.buildTile(world, tx, tz);
        if (!mesh) continue;
        this.tiles.push(mesh);
        this.group.add(mesh);
      }
    }
  }

  private buildTile(world: VoxelWorld, tx: number, tz: number): THREE.Mesh | null {
    const b = new BladeBuilder();
    const x0 = tx * TILE;
    const z0 = tz * TILE;
    const x1 = Math.min(WORLD_X - 1, x0 + TILE);
    const z1 = Math.min(WORLD_Z - 1, z0 + TILE);

    for (let cz = z0; cz < z1; cz += PITCH) {
      for (let cx = x0; cx < x1; cx += PITCH) {
        // Jitter inside the cell, so the pitch never shows as a lattice.
        const jx = bladeHash(cx, cz, 11);
        const jz = bladeHash(cx, cz, 23);
        const x = cx + Math.floor(jx * PITCH);
        const z = cz + Math.floor(jz * PITCH);
        if (x < 1 || z < 1 || x >= WORLD_X - 1 || z >= WORLD_Z - 1) continue;

        // How rank the ground is here. Squared on the way in, which is what
        // turns a smooth noise field into "mostly thin, occasionally thick"
        // instead of "half the map is half covered".
        const patch = smooth(Math.min(1, Math.max(0,
          (patchNoise(x / CLUMP_SCALE, z / CLUMP_SCALE) - CLUMP_FLOOR) / CLUMP_SPAN)));
        const thick = patch * patch;
        if (bladeHash(x, z, 37) > DENSITY_MIN + (DENSITY_MAX - DENSITY_MIN) * thick) continue;

        const y = world.surfaceHeight(x, z) - 1;
        if (y < 1) continue;
        if (world.materialAt(x, y, z) !== Mat.Dirt) continue;
        const color = world.get(x, y, z);
        if (!GROUND.has(color)) continue;

        this.tuft(b, x + 0.5 + (jx - 0.5) * 0.6, y + 1, z + 0.5 + (jz - 0.5) * 0.6, color, thick);
      }
    }

    if (b.empty) return null;
    const mesh = new THREE.Mesh(b.finish(), this.material);
    mesh.name = `grass-${tx}-${tz}`;
    // Cheap on purpose, for the reason the rice is: putting tens of thousands
    // of straps through the shadow pass buys a smear of noise on the dirt.
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    return mesh;
  }

  /**
   * One tuft: a few straps out of the same root, each leaning its own way.
   *
   * `thick` is how rank its patch is, 0..1. It drives height as well as
   * density, because that is what actually makes a patch read as a patch: a
   * thick stand of the same short grass just looks like more of it, whereas
   * grass that is both denser and taller where it has got away reads as ground
   * nobody has walked on.
   */
  private tuft(
    b: BladeBuilder, x: number, y: number, z: number, ground: number, thick: number,
  ): void {
    // The tuft takes its colour from the block it is standing on, so burnt-off
    // ground grows burnt-off grass and the two never disagree. Lifted well
    // clear of the ground's own value: a blade the same shade as the dirt under
    // it disappears into it, and what is wanted is the ground reading as
    // *covered* rather than as tinted.
    const r = palette[ground * 3] / 255;
    const g = palette[ground * 3 + 1] / 255;
    const bl = palette[ground * 3 + 2] / 255;
    const rootR = r * 0.72, rootG = g * 0.80, rootB = bl * 0.62;
    const tipR = Math.min(1, r * 1.5 + 0.04);
    const tipG = Math.min(1, g * 1.42 + 0.06);
    const tipB = Math.min(1, bl * 1.3);

    // One height for the tuft, so a clump is a plant rather than a handful of
    // unrelated blades; the blades then vary either side of it.
    const base = (HEIGHT_MIN + bladeHash(x, z, 3) * (HEIGHT_MAX - HEIGHT_MIN))
      * (0.62 + thick * 0.55);

    this.tuftCount++;
    for (let i = 0; i < BLADES; i++) {
      const a = bladeHash(x, z, i * 5 + 41) * Math.PI * 2;
      const rad = SPREAD * (0.15 + bladeHash(x, z, i * 5 + 42) * 0.85);
      const h = base * (0.62 + bladeHash(x, z, i * 5 + 43) * 0.7);
      const lean = LEAN * h * (0.35 + bladeHash(x, z, i * 5 + 44));
      b.strapBlade(
        x + Math.cos(a) * rad, y, z + Math.sin(a) * rad,
        h, Math.cos(a) * lean, Math.sin(a) * lean,
        // Turned across the way it leans, so the flat of the blade faces out.
        a + Math.PI / 2, BLADE_BASE, BLADE_TIP,
        rootR, rootG, rootB, tipR, tipG, tipB,
      );
    }
  }

  /**
   * Advances the wind and hides everything the fog has already swallowed.
   *
   * `focus` is the camera. Measured horizontally, because the fog is: standing
   * on the parapet does not make the far treeline any clearer.
   */
  update(dt: number, focus: THREE.Vector3): void {
    this.time.value += dt;
    for (const tile of this.tiles) {
      const s = tile.geometry.boundingSphere;
      if (!s) continue;
      const dx = s.center.x - focus.x;
      const dz = s.center.z - focus.z;
      tile.visible = dx * dx + dz * dz < CULL * CULL;
    }
  }

  dispose(): void {
    for (const tile of this.tiles) tile.geometry.dispose();
    this.material.dispose();
  }
}
