import * as THREE from 'three';

/**
 * Builds static geometry out of axis-aligned boxes.
 *
 * The world grid can only express whole voxels, but plenty of things want the
 * same blocky look at a finer or coarser grain than one block -- flags, sky.
 * Those are drawn as ordinary meshes assembled here, which keeps the voxel
 * language without paying for it in world data.
 *
 * Boxes are written straight into the shared vertex arrays rather than merged
 * from `BoxGeometry` instances: the merge path allocates a geometry per box,
 * and a cloud layer is thousands of them.
 */

/** Per-face normal, then four corner offsets as flattened (x, y, z) triples. */
const FACES: readonly (readonly [readonly number[], readonly number[]])[] = [
  [[0, 0, 1], [0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]],
  [[0, 0, -1], [1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0]],
  [[1, 0, 0], [1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 1, 1]],
  [[-1, 0, 0], [0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0]],
  [[0, 1, 0], [0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 0]],
  [[0, -1, 0], [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1]],
];

/** Indices into {@link FACES}, for callers that shade per face. */
export const enum Face {
  PosZ = 0, NegZ = 1, PosX = 2, NegX = 3, Top = 4, Bottom = 5,
}

/** Unit neighbour offset for each face, in the same order. */
export const FACE_OFFSET: readonly (readonly [number, number, number])[] = [
  [0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0],
];

/** Every face; the default mask. */
export const ALL_FACES = 0b111111;

export class BoxBuilder {
  private readonly pos: number[] = [];
  private readonly norm: number[] = [];
  private readonly col: number[] = [];
  private readonly idx: number[] = [];

  /** `x, y, z` is the minimum corner; `sx, sy, sz` the extent. */
  box(
    x: number, y: number, z: number,
    sx: number, sy: number, sz: number,
    color: THREE.Color,
  ): void {
    this.shadedBox(x, y, z, sx, sy, sz, () => color);
  }

  /**
   * As {@link box}, but the colour is chosen per face. Unlit sky geometry has
   * no light to shade it, so the only way to keep a box from reading as a flat
   * silhouette is to bake the shading in here.
   *
   * `faceMask` drops individual faces. That matters for translucent volumes
   * built out of many small cubes: leaving the interior faces in makes the
   * blend stack up wherever cubes touch, so a solid blob comes out darker than
   * a hollow one instead of uniform.
   */
  shadedBox(
    x: number, y: number, z: number,
    sx: number, sy: number, sz: number,
    colorFor: (face: Face) => THREE.Color,
    faceMask = ALL_FACES,
  ): void {
    for (let f = 0; f < FACES.length; f++) {
      if ((faceMask & (1 << f)) === 0) continue;
      const [n, corners] = FACES[f];
      const color = colorFor(f as Face);
      const base = this.pos.length / 3;
      for (let v = 0; v < 4; v++) {
        this.pos.push(
          x + corners[v * 3] * sx,
          y + corners[v * 3 + 1] * sy,
          z + corners[v * 3 + 2] * sz,
        );
        this.norm.push(n[0], n[1], n[2]);
        this.col.push(color.r, color.g, color.b);
      }
      this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  /** Quads emitted so far. Boxes vary now that faces can be masked out. */
  get faceCount(): number {
    return this.pos.length / (3 * 4);
  }

  finish(): THREE.BufferGeometry {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geom.setAttribute('normal', new THREE.Float32BufferAttribute(this.norm, 3));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    geom.setIndex(this.idx);
    geom.computeBoundingSphere();
    return geom;
  }
}
