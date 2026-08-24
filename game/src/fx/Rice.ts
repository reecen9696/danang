import * as THREE from 'three';
import { palette, COL_RICE, COL_RICE_DRY } from '../voxel/palette';
import type { MapLayout } from '../voxel/worldgen';

/**
 * The standing crop in the paddy.
 *
 * Rice was voxels once, one block of green per cell, and it had the two faults
 * a block of green always has: you could stand on it, and you could not stand
 * *in* it. Both matter here, because the field is the open ground the enemy
 * crosses and the only thing on it worth using is the crop. So the rice is
 * drawn the way the flags and the farmers are -- ordinary geometry at a finer
 * grain than the grid -- which makes it something you walk into rather than
 * onto, that rounds pass straight through, and that hides a man who gets down
 * in it. The concealment itself is not here: it falls out of the height the
 * blades are built to, and is read back off the field by `riceConceals` in
 * worldgen (see ai/BotManager).
 *
 * The whole field is one merged geometry and one draw call. Nothing about it
 * changes after it is built except the wind, which lives in the vertex shader:
 * every vertex carries how far up its own blade it sits, and the tips are
 * pushed downwind by that fraction. A field of rice that does not move reads
 * as a carpet, and a carpet is not somewhere you would think to hide.
 */

/** Blades in a clump. Enough to fill a cell, few enough to keep the count sane. */
const BLADES = 5;
/** Width of a blade at the mud, and at the tip. A rice leaf tapers hard. */
const BLADE_BASE = 0.085;
const BLADE_TIP = 0.03;
/** How far a clump spreads from its own centre, in blocks. */
const SPREAD = 0.3;
/** How far the tip of a blade leans out from its base, as a fraction of height. */
const LEAN = 0.34;
/** Downwind push at the tips, in blocks, before the gust envelope. */
const SWAY = 0.26;
/** Prevailing wind, normalised. Everything in the field leans the same way. */
const WIND_X = 0.82;
const WIND_Z = 0.57;

function colorOf(index: number): [number, number, number] {
  return [
    palette[index * 3] / 255,
    palette[index * 3 + 1] / 255,
    palette[index * 3 + 2] / 255,
  ];
}

/** Deterministic per-clump noise, so a field looks the same on every machine. */
function hash(x: number, z: number, salt: number): number {
  let h = Math.imul(Math.round(x * 16), 374761393)
    ^ Math.imul(Math.round(z * 16), 668265263)
    ^ Math.imul(salt, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/**
 * Builds one blade: a tapered, leaning box, open at the bottom.
 *
 * The four sides are emitted as quads with a real normal each rather than an
 * axis-aligned guess, because a leaning blade lit as though it were vertical
 * goes flat and the clump stops reading as separate leaves.
 */
class BladeBuilder {
  readonly pos: number[] = [];
  readonly norm: number[] = [];
  readonly col: number[] = [];
  readonly sway: number[] = [];
  readonly base: number[] = [];
  readonly idx: number[] = [];

  private readonly n = new THREE.Vector3();
  private readonly e1 = new THREE.Vector3();
  private readonly e2 = new THREE.Vector3();

  blade(
    bx: number, by: number, bz: number,
    height: number, leanX: number, leanZ: number,
    r: number, g: number, b: number,
    tipR: number, tipG: number, tipB: number,
  ): void {
    const tx = bx + leanX;
    const tz = bz + leanZ;
    const ty = by + height;
    const w0 = BLADE_BASE * 0.5;
    const w1 = BLADE_TIP * 0.5;

    // Corner rings, bottom then top, in the same winding order. Wound so that
    // side quads and the cap both come out facing outward -- a blade with its
    // faces inside out is invisible from every angle you would see it from.
    const ring = (cx: number, cy: number, cz: number, w: number): number[] => [
      cx - w, cy, cz - w,
      cx - w, cy, cz + w,
      cx + w, cy, cz + w,
      cx + w, cy, cz - w,
    ];
    const lo = ring(bx, by, bz, w0);
    const hi = ring(tx, ty, tz, w1);

    for (let side = 0; side < 4; side++) {
      const a = side * 3;
      const c = ((side + 1) % 4) * 3;
      this.quad(
        lo[a], lo[a + 1], lo[a + 2],
        lo[c], lo[c + 1], lo[c + 2],
        hi[c], hi[c + 1], hi[c + 2],
        hi[a], hi[a + 1], hi[a + 2],
        [0, 0, 1, 1], r, g, b, tipR, tipG, tipB, bx, bz,
      );
    }
    // Cap, so a blade seen from the parapet above isn't hollow.
    this.quad(
      hi[0], hi[1], hi[2], hi[3], hi[4], hi[5],
      hi[6], hi[7], hi[8], hi[9], hi[10], hi[11],
      [1, 1, 1, 1], r, g, b, tipR, tipG, tipB, bx, bz,
    );
  }

  /** `up` is how far up the blade each of the four corners sits, 0..1. */
  private quad(
    ax: number, ay: number, az: number,
    bx2: number, by2: number, bz2: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
    up: readonly number[],
    r: number, g: number, b: number,
    tipR: number, tipG: number, tipB: number,
    baseX: number, baseZ: number,
  ): void {
    this.e1.set(bx2 - ax, by2 - ay, bz2 - az);
    this.e2.set(dx - ax, dy - ay, dz - az);
    this.n.crossVectors(this.e1, this.e2).normalize();

    const start = this.pos.length / 3;
    const xs = [ax, bx2, cx, dx];
    const ys = [ay, by2, cy, dy];
    const zs = [az, bz2, cz, dz];
    for (let v = 0; v < 4; v++) {
      this.pos.push(xs[v], ys[v], zs[v]);
      this.norm.push(this.n.x, this.n.y, this.n.z);
      // Tips are paler and drier than the base of the plant, which is what
      // keeps a plot from being one flat slab of green.
      const t = up[v];
      this.col.push(r + (tipR - r) * t, g + (tipG - g) * t, b + (tipB - b) * t);
      // The bend is at the root, so the tip travels furthest and the bottom of
      // the blade barely moves at all.
      this.sway.push(t * t);
      this.base.push(baseX, baseZ);
    }
    this.idx.push(start, start + 1, start + 2, start, start + 2, start + 3);
  }

  finish(): THREE.BufferGeometry {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geom.setAttribute('normal', new THREE.Float32BufferAttribute(this.norm, 3));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    geom.setAttribute('aSway', new THREE.Float32BufferAttribute(this.sway, 1));
    geom.setAttribute('aBase', new THREE.Float32BufferAttribute(this.base, 2));
    geom.setIndex(this.idx);
    geom.computeBoundingSphere();
    return geom;
  }
}

/** The crop in the paddy: one mesh, and the wind that moves it. */
export class Rice {
  readonly mesh: THREE.Mesh;
  private readonly time = { value: 0 };

  constructor(patches: MapLayout['ricePatches']) {
    const b = new BladeBuilder();
    const green = colorOf(COL_RICE);
    const dry = colorOf(COL_RICE_DRY);

    for (const patch of patches) {
      const [r, g, bl] = patch.dry ? dry : green;
      // Root colour is the same leaf in shadow; the tip is where the sun and
      // the dust are.
      const rootR = r * 0.62, rootG = g * 0.66, rootB = bl * 0.55;
      const tipR = Math.min(1, r * 1.18), tipG = Math.min(1, g * 1.16), tipB = Math.min(1, bl * 1.1);

      for (let i = 0; i < BLADES; i++) {
        const a = hash(patch.x, patch.z, i * 7 + 1) * Math.PI * 2;
        const rad = SPREAD * (0.25 + hash(patch.x, patch.z, i * 7 + 2) * 0.75);
        const h = patch.height * (0.7 + hash(patch.x, patch.z, i * 7 + 3) * 0.55);
        // Blades lean away from the middle of their own clump, so a clump
        // opens out like a plant instead of standing like a bundle of sticks.
        const lean = LEAN * h * (0.4 + hash(patch.x, patch.z, i * 7 + 4));
        b.blade(
          patch.x + Math.cos(a) * rad, patch.y, patch.z + Math.sin(a) * rad,
          h, Math.cos(a) * lean, Math.sin(a) * lean,
          rootR, rootG, rootB, tipR, tipG, tipB,
        );
      }
    }

    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, fog: true });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.time;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          uniform float uTime;
          attribute float aSway;
          attribute vec2 aBase;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          // Two waves an octave apart, so the field ripples instead of beating,
          // under a much slower envelope that walks gusts across it.
          float phase = uTime * 1.7 + aBase.x * 0.55 + aBase.y * 0.33;
          float gust = 0.45 + 0.55 * sin(uTime * 0.29 + aBase.x * 0.045 + aBase.y * 0.031);
          float bend = (sin(phase) + 0.35 * sin(phase * 2.3)) * aSway * ${SWAY.toFixed(3)} * gust;
          transformed.x += bend * ${WIND_X.toFixed(3)};
          transformed.z += bend * ${WIND_Z.toFixed(3)};`);
    };
    // Cheap on purpose: the field is thousands of thin blades, and putting
    // them through the shadow pass would double that for a smear of noise on
    // the mud. They take the terrain's shadow, they just don't throw one.
    this.mesh = new THREE.Mesh(b.finish(), mat);
    this.mesh.name = 'rice';
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    // The field is one geometry spanning the whole paddy, so its bounding
    // sphere is enormous and frustum culling it costs more than it saves.
    this.mesh.frustumCulled = false;
  }

  update(dt: number): void {
    this.time.value += dt;
  }
}
