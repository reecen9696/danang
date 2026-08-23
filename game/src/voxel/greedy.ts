import { CHUNK } from '../core/constants';

/**
 * Greedy voxel mesher with baked ambient occlusion.
 *
 * Runs inside a worker over a 1-voxel-padded copy of a chunk. Faces are merged
 * into the largest possible quads.
 *
 * Shading is split across three attributes rather than being pre-multiplied
 * into one colour:
 *
 *  - `colors` is the raw palette albedo, untouched.
 *  - `normals` lets the real sun light each face, which used to be a fixed
 *    brightness per face direction.
 *  - `ao` is the corner occlusion, kept separate because it belongs to the
 *    ambient term -- see `useBakedVertexAO` in core/lighting.ts.
 *
 * All three are byte-sized where they can be, so the split costs 4 bytes per
 * vertex over the old single-colour layout.
 */

export const PAD = CHUNK + 2;
const PAD2 = PAD * PAD;

/** Padded-array index for local coords in [-1, CHUNK]. */
function pidx(lx: number, ly: number, lz: number): number {
  return (ly + 1) * PAD2 + (lz + 1) * PAD + (lx + 1);
}

/**
 * Face normals, indexed the same way faces are numbered below: `d * 2` for the
 * negative side of an axis, `+ 1` for the positive one.
 */
const FACE_NORMALS = [
  -1, 0, 0, // -X
  1, 0, 0, // +X
  0, -1, 0, // -Y
  0, 1, 0, // +Y
  0, 0, -1, // -Z
  0, 0, 1, // +Z
];

/**
 * AO level 0..3 -> occlusion multiplier, as a 0..255 byte.
 *
 * Shallower than it used to be: the sun and the hemisphere now supply most of
 * the shape, so corner darkening only has to add contact, not carry the whole
 * read of the geometry.
 */
const AO_SHADE = [140, 184, 224, 255];

// --- growable scratch buffers (module-level: one mesher per worker) ---------
let capQuads = 8192;
let positions = new Float32Array(capQuads * 12);
let normals = new Int8Array(capQuads * 12);
let colors = new Uint8Array(capQuads * 12);
let aoBytes = new Uint8Array(capQuads * 4);
let indices = new Uint32Array(capQuads * 6);

const mask = new Int32Array(CHUNK * CHUNK);

function ensureCapacity(quads: number): void {
  if (quads <= capQuads) return;
  while (capQuads < quads) capQuads *= 2;
  const p = new Float32Array(capQuads * 12);
  p.set(positions);
  positions = p;
  const nrm = new Int8Array(capQuads * 12);
  nrm.set(normals);
  normals = nrm;
  const c = new Uint8Array(capQuads * 12);
  c.set(colors);
  colors = c;
  const a = new Uint8Array(capQuads * 4);
  a.set(aoBytes);
  aoBytes = a;
  const i = new Uint32Array(capQuads * 6);
  i.set(indices);
  indices = i;
}

export interface MeshResult {
  positions: Float32Array;
  /** Signed bytes; upload normalized so +/-127 reads as +/-1. */
  normals: Int8Array;
  colors: Uint8Array;
  /** One occlusion byte per vertex, uploaded normalized. */
  ao: Uint8Array;
  indices: Uint32Array;
}

/**
 * @param padded  (CHUNK+2)^3 palette indices, 0 == air
 * @param palette 256 * 3 RGB bytes
 */
export function meshChunk(padded: Uint8Array, palette: Uint8Array): MeshResult {
  let quadCount = 0;

  const x = [0, 0, 0];
  const q = [0, 0, 0];
  const du = [0, 0, 0];
  const dv = [0, 0, 0];

  const solid = (a: number, b: number, c: number): number =>
    padded[pidx(a, b, c)] !== 0 ? 1 : 0;

  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;
    q[0] = 0; q[1] = 0; q[2] = 0;
    q[d] = 1;

    for (x[d] = -1; x[d] < CHUNK;) {
      // ---- build the mask for this slice ----
      let n = 0;
      for (x[v] = 0; x[v] < CHUNK; x[v]++) {
        for (x[u] = 0; x[u] < CHUNK; x[u]++, n++) {
          const ax = x[0], ay = x[1], az = x[2];
          const bx = ax + q[0], by = ay + q[1], bz = az + q[2];
          const va = padded[pidx(ax, ay, az)];
          const vb = padded[pidx(bx, by, bz)];

          if ((va !== 0) === (vb !== 0)) {
            mask[n] = 0;
            continue;
          }

          // The visible face belongs to the solid voxel; AO is sampled from the
          // open (air) side.
          const front = va !== 0;
          const color = front ? va : vb;
          const px = front ? bx : ax;
          const py = front ? by : ay;
          const pz = front ? bz : az;

          // Ambient occlusion for the four corners of this single face.
          let ao = 0;
          for (let corner = 0; corner < 4; corner++) {
            const cu = corner === 1 || corner === 2 ? 1 : -1;
            const cv = corner === 2 || corner === 3 ? 1 : -1;
            const s1x = px + (u === 0 ? cu : 0);
            const s1y = py + (u === 1 ? cu : 0);
            const s1z = pz + (u === 2 ? cu : 0);
            const s2x = px + (v === 0 ? cv : 0);
            const s2y = py + (v === 1 ? cv : 0);
            const s2z = pz + (v === 2 ? cv : 0);
            const cx = s1x + (v === 0 ? cv : 0);
            const cy = s1y + (v === 1 ? cv : 0);
            const cz = s1z + (v === 2 ? cv : 0);
            const s1 = solid(s1x, s1y, s1z);
            const s2 = solid(s2x, s2y, s2z);
            const co = solid(cx, cy, cz);
            const level = s1 && s2 ? 0 : 3 - (s1 + s2 + co);
            ao |= level << (corner * 2);
          }

          const packed = color | (ao << 8);
          mask[n] = front ? packed : -packed;
        }
      }

      x[d]++;

      // ---- greedily merge the mask into quads ----
      n = 0;
      for (let j = 0; j < CHUNK; j++) {
        for (let i = 0; i < CHUNK;) {
          const m = mask[n];
          if (m === 0) { i++; n++; continue; }

          // width
          let w = 1;
          while (i + w < CHUNK && mask[n + w] === m) w++;
          // height
          let h = 1;
          outer: while (j + h < CHUNK) {
            const row = n + h * CHUNK;
            for (let k = 0; k < w; k++) if (mask[row + k] !== m) break outer;
            h++;
          }

          x[u] = i;
          x[v] = j;
          du[0] = 0; du[1] = 0; du[2] = 0; du[u] = w;
          dv[0] = 0; dv[1] = 0; dv[2] = 0; dv[v] = h;

          const front = m > 0;
          const packed = front ? m : -m;
          const color = packed & 0xff;
          const aoBits = (packed >> 8) & 0xff;

          const faceId = d * 2 + (front ? 1 : 0);
          const nx = FACE_NORMALS[faceId * 3];
          const ny = FACE_NORMALS[faceId * 3 + 1];
          const nz = FACE_NORMALS[faceId * 3 + 2];
          const pr = palette[color * 3];
          const pg = palette[color * 3 + 1];
          const pb = palette[color * 3 + 2];

          ensureCapacity(quadCount + 1);
          const vo = quadCount * 12;
          const aoOffset = quadCount * 4;
          const io = quadCount * 6;
          const baseVertex = quadCount * 4;

          // p0, p1 (+du), p2 (+du+dv), p3 (+dv)
          positions[vo + 0] = x[0];
          positions[vo + 1] = x[1];
          positions[vo + 2] = x[2];
          positions[vo + 3] = x[0] + du[0];
          positions[vo + 4] = x[1] + du[1];
          positions[vo + 5] = x[2] + du[2];
          positions[vo + 6] = x[0] + du[0] + dv[0];
          positions[vo + 7] = x[1] + du[1] + dv[1];
          positions[vo + 8] = x[2] + du[2] + dv[2];
          positions[vo + 9] = x[0] + dv[0];
          positions[vo + 10] = x[1] + dv[1];
          positions[vo + 11] = x[2] + dv[2];

          const a0 = AO_SHADE[aoBits & 3];
          const a1 = AO_SHADE[(aoBits >> 2) & 3];
          const a2 = AO_SHADE[(aoBits >> 4) & 3];
          const a3 = AO_SHADE[(aoBits >> 6) & 3];
          aoBytes[aoOffset] = a0;
          aoBytes[aoOffset + 1] = a1;
          aoBytes[aoOffset + 2] = a2;
          aoBytes[aoOffset + 3] = a3;
          for (let c = 0; c < 4; c++) {
            colors[vo + c * 3] = pr;
            colors[vo + c * 3 + 1] = pg;
            colors[vo + c * 3 + 2] = pb;
            normals[vo + c * 3] = nx * 127;
            normals[vo + c * 3 + 1] = ny * 127;
            normals[vo + c * 3 + 2] = nz * 127;
          }

          // Flip the split so the AO gradient stays symmetric.
          const flip = a0 + a2 > a1 + a3;
          if (front) {
            if (flip) {
              indices[io] = baseVertex + 1; indices[io + 1] = baseVertex + 2; indices[io + 2] = baseVertex + 3;
              indices[io + 3] = baseVertex + 1; indices[io + 4] = baseVertex + 3; indices[io + 5] = baseVertex + 0;
            } else {
              indices[io] = baseVertex + 0; indices[io + 1] = baseVertex + 1; indices[io + 2] = baseVertex + 2;
              indices[io + 3] = baseVertex + 0; indices[io + 4] = baseVertex + 2; indices[io + 5] = baseVertex + 3;
            }
          } else {
            if (flip) {
              indices[io] = baseVertex + 3; indices[io + 1] = baseVertex + 2; indices[io + 2] = baseVertex + 1;
              indices[io + 3] = baseVertex + 0; indices[io + 4] = baseVertex + 3; indices[io + 5] = baseVertex + 1;
            } else {
              indices[io] = baseVertex + 2; indices[io + 1] = baseVertex + 1; indices[io + 2] = baseVertex + 0;
              indices[io + 3] = baseVertex + 3; indices[io + 4] = baseVertex + 2; indices[io + 5] = baseVertex + 0;
            }
          }

          quadCount++;

          // clear the consumed region
          for (let jj = 0; jj < h; jj++) {
            const row = n + jj * CHUNK;
            for (let ii = 0; ii < w; ii++) mask[row + ii] = 0;
          }
          i += w;
          n += w;
        }
      }
    }
  }

  return {
    positions: positions.slice(0, quadCount * 12),
    normals: normals.slice(0, quadCount * 12),
    colors: colors.slice(0, quadCount * 12),
    ao: aoBytes.slice(0, quadCount * 4),
    indices: indices.slice(0, quadCount * 6),
  };
}
