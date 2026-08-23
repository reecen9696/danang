import * as THREE from 'three';
import {
  palette, COL_FLAG_RED, COL_FLAG_STAR, COL_FLAG_NAVY, COL_SNOW, COL_BAMBOO_DARK,
} from '../voxel/palette';
import { BoxBuilder } from './boxMesh';

/**
 * Flags, built at a finer grain than the voxel grid.
 *
 * A flag made of world voxels is unavoidably enormous -- the star alone needs
 * five cells across to read as a star, so the smallest honest flag is 9x6
 * metres. These are drawn as ordinary geometry instead, at a fraction of a
 * voxel per cell, which is the same trick the first-person weapon models use to
 * get detail the world grid can't express.
 *
 * The consequence is that flags are scenery, not terrain: they don't collide,
 * can't be shot away, and never reach the server. That is the right trade for a
 * decoration, but it does mean a flag will happily hang through anything built
 * underneath it after the fact.
 *
 * Every flag in the map is merged into one geometry and drawn as a single mesh.
 */

/**
 * Panel size in world units -- 1.5 x 1.0 voxels, whatever grid the design on
 * it happens to use. A design with more cells gets finer cells, not a bigger
 * flag, so every pole in the map flies the same size of colours.
 */
const FLAG_WIDTH = 1.5;
const FLAG_HEIGHT = 1;

/** Cell size of the pole, in world units. */
const PIXEL = 1 / 6;

/**
 * A flag's artwork: rows top-down, one character per cell, each keyed to a
 * palette index. Rows must all be the same length.
 */
interface FlagDesign {
  readonly rows: readonly string[];
  readonly colors: Readonly<Record<string, number>>;
}

/** The star flag flown over the hamlet and the village. */
const NLF: FlagDesign = {
  rows: [
    'RRRRRRRRR',
    'RR..#..RR',
    'RR#####RR',
    'RR.###.RR',
    'RR.#.#.RR',
    'RRRRRRRRR',
  ],
  colors: { R: COL_FLAG_RED, '#': COL_FLAG_STAR, '.': COL_FLAG_RED },
};

/**
 * The Stars and Stripes, over the player's fort.
 *
 * Thirteen stripes need thirteen rows, so this design is on a much finer grid
 * than the star flag -- it comes out the same size on the pole, just with
 * smaller cells. The star field is the honest alternating grid rather than
 * fifty stars, which at this scale would be one smear of white.
 */
const US: FlagDesign = (() => {
  const COLS = 19;
  const CANTON_W = 8;
  const CANTON_H = 7;
  const rows: string[] = [];
  for (let r = 0; r < 13; r++) {
    const stripe = r % 2 === 0 ? 'R' : 'W';
    let row = '';
    for (let c = 0; c < COLS; c++) {
      if (r < CANTON_H && c < CANTON_W) {
        // Stars on every other row, offset row to row. Filling every other
        // cell of every row instead would come out a checkerboard, not a
        // field of stars.
        const starRow = r % 2 === 0;
        const star = starRow && (r % 4 === 0 ? c % 2 === 1 : c % 2 === 0 && c > 0);
        row += star ? '*' : 'B';
      } else {
        row += stripe;
      }
    }
    rows.push(row);
  }
  return { rows, colors: { R: COL_FLAG_RED, W: COL_SNOW, B: COL_FLAG_NAVY, '*': COL_SNOW } };
})();

/** Pole thickness, in cells, and its height in world units above the base. */
const POLE_CELLS = 1;
const POLE_HEIGHT = 4.5;
/** Drop from the pole top to the flag's top edge. */
const FLAG_HANG = 0.35;

export interface FlagSite {
  /** Foot of the pole, in world units. */
  x: number; y: number; z: number;
  /** Axis the flag flies along: 1 or -1 on exactly one of the two. */
  dirX: number; dirZ: number;
  /** The fort flies the Stars and Stripes; everywhere else flies the star flag. */
  us?: boolean;
}

function colorOf(index: number): THREE.Color {
  return new THREE.Color(
    palette[index * 3] / 255,
    palette[index * 3 + 1] / 255,
    palette[index * 3 + 2] / 255,
  );
}

/** Builds the merged mesh for every flag in the map. Static once created. */
export function buildFlags(sites: readonly FlagSite[]): THREE.Mesh {
  const pole = colorOf(COL_BAMBOO_DARK);
  const b = new BoxBuilder();
  // One THREE.Color per palette index, not one per cell: a 19x13 flag is 247
  // cells and the builder only reads the colour it's handed.
  const colors = new Map<number, THREE.Color>();
  const cache = (index: number): THREE.Color => {
    let c = colors.get(index);
    if (c === undefined) {
      c = colorOf(index);
      colors.set(index, c);
    }
    return c;
  };

  for (const site of sites) {
    const poleW = POLE_CELLS * PIXEL;
    // Centre the pole on the site so it doesn't sit visibly off-grid.
    const px = site.x - poleW / 2;
    const pz = site.z - poleW / 2;
    b.box(px, site.y, pz, poleW, POLE_HEIGHT, poleW, pole);

    const design = site.us ? US : NLF;
    const rows = design.rows;
    const cols = rows[0].length;
    const cellW = FLAG_WIDTH / cols;
    const cellH = FLAG_HEIGHT / rows.length;

    const topY = site.y + POLE_HEIGHT - FLAG_HANG;
    for (let row = 0; row < rows.length; row++) {
      const y = topY - (row + 1) * cellH;
      for (let col = 0; col < cols; col++) {
        const col3 = cache(design.colors[rows[row][col]]);

        // The panel is one cell thick, spanning whichever axis it flies along.
        // Measured from the pole's outer face so the hoist edge sits flush
        // against it rather than floating half a cell off.
        const along = poleW / 2 + col * cellW;
        const cx = site.x + site.dirX * along - (site.dirX < 0 ? cellW : 0);
        const cz = site.z + site.dirZ * along - (site.dirZ < 0 ? cellW : 0);
        const w = site.dirX !== 0 ? cellW : poleW;
        const d = site.dirZ !== 0 ? cellW : poleW;
        b.box(
          site.dirX !== 0 ? cx : px, y, site.dirZ !== 0 ? cz : pz,
          w, cellH, d,
          col3,
        );
      }
    }
  }

  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, fog: true });
  const mesh = new THREE.Mesh(b.finish(), mat);
  mesh.name = 'flags';
  mesh.castShadow = true;
  return mesh;
}
