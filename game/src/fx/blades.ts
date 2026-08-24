import * as THREE from 'three';

/**
 * Blades of grass, and the wind that moves them.
 *
 * Two things in the world are drawn this way -- the standing rice in the paddy
 * (fx/Rice.ts) and the general ground cover on the field (fx/Grass.ts) -- and
 * they want exactly the same machinery: geometry at a finer grain than the
 * voxel lattice, a per-vertex "how far up my own blade am I", and a vertex
 * shader that pushes the tips downwind by that fraction. What differs is only
 * the shape of one blade and where the clumps go, so that is all either of them
 * has to write.
 *
 * ## Why any of this is geometry rather than voxels
 *
 * A block of green has the two faults a block of green always has: you can
 * stand on it, and you cannot stand *in* it. Both matter. Rice is the only
 * cover on the open ground the enemy crosses, and cover you climb onto is worse
 * than no cover at all; grass on the field has to be something you walk through
 * without noticing, and a lattice of knee-high blocks is something you trip
 * over. Drawn like this, a round goes straight through, a man who gets down in
 * it disappears, and nothing about it changes how anybody moves.
 */

/** Deterministic per-clump noise, so a field looks the same on every machine. */
export function bladeHash(x: number, z: number, salt: number): number {
  let h = Math.imul(Math.round(x * 16), 374761393)
    ^ Math.imul(Math.round(z * 16), 668265263)
    ^ Math.imul(salt, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/**
 * Accumulates blades into one buffer geometry.
 *
 * Every vertex carries a colour and an `aSway` in 0..1 saying how far up its
 * own blade it sits. Nothing carries its clump's position: the wind phase is
 * read off `position.xz` in the shader instead, which is within a fraction of a
 * block of the same thing and saves two floats on every vertex in the map.
 */
export class BladeBuilder {
  private readonly pos: number[] = [];
  private readonly norm: number[] = [];
  private readonly col: number[] = [];
  private readonly sway: number[] = [];
  private readonly idx: number[] = [];

  private readonly n = new THREE.Vector3();
  private readonly e1 = new THREE.Vector3();
  private readonly e2 = new THREE.Vector3();

  get quadCount(): number {
    return this.idx.length / 6;
  }

  get empty(): boolean {
    return this.idx.length === 0;
  }

  /**
   * A tapered, leaning box, open at the bottom.
   *
   * Four sides and a cap, each with a real normal rather than an axis-aligned
   * guess -- a leaning blade lit as though it were vertical goes flat, and the
   * clump stops reading as separate leaves. Five quads a blade is expensive,
   * and worth it only where the player looks down into the crop from above:
   * that is the paddy, seen from the parapet.
   */
  boxBlade(
    bx: number, by: number, bz: number,
    height: number, leanX: number, leanZ: number,
    baseWidth: number, tipWidth: number,
    r: number, g: number, b: number,
    tipR: number, tipG: number, tipB: number,
  ): void {
    const tx = bx + leanX;
    const tz = bz + leanZ;
    const ty = by + height;
    const w0 = baseWidth * 0.5;
    const w1 = tipWidth * 0.5;

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
        UP_FROM_BASE, r, g, b, tipR, tipG, tipB,
      );
    }
    // Cap, so a blade seen from above isn't hollow.
    this.quad(
      hi[0], hi[1], hi[2], hi[3], hi[4], hi[5],
      hi[6], hi[7], hi[8], hi[9], hi[10], hi[11],
      ALL_TIP, r, g, b, tipR, tipG, tipB,
    );
  }

  /**
   * A single tapering strap, leaning over as it rises. One quad.
   *
   * This is the cheap blade, and it is what general ground cover is built from:
   * at ankle height nobody is looking down the throat of a blade of grass, so
   * the four other faces a {@link boxBlade} would spend are four faces bought
   * for nothing. Drawn with a double-sided material so it exists from behind.
   *
   * `yaw` is the direction the strap's width runs in, so a clump built with
   * several different yaws reads as a tuft rather than as a row of flags.
   */
  strapBlade(
    bx: number, by: number, bz: number,
    height: number, leanX: number, leanZ: number,
    yaw: number, baseWidth: number, tipWidth: number,
    r: number, g: number, b: number,
    tipR: number, tipG: number, tipB: number,
  ): void {
    const wx = Math.cos(yaw);
    const wz = Math.sin(yaw);
    const w0 = baseWidth * 0.5;
    const w1 = tipWidth * 0.5;
    const tx = bx + leanX;
    const ty = by + height;
    const tz = bz + leanZ;
    this.quad(
      bx - wx * w0, by, bz - wz * w0,
      bx + wx * w0, by, bz + wz * w0,
      tx + wx * w1, ty, tz + wz * w1,
      tx - wx * w1, ty, tz - wz * w1,
      UP_FROM_BASE, r, g, b, tipR, tipG, tipB,
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
      // keeps a patch from being one flat slab of green.
      const t = up[v];
      this.col.push(r + (tipR - r) * t, g + (tipG - g) * t, b + (tipB - b) * t);
      // The bend is at the root, so the tip travels furthest and the bottom of
      // the blade barely moves at all.
      this.sway.push(t * t);
    }
    this.idx.push(start, start + 1, start + 2, start, start + 2, start + 3);
  }

  finish(): THREE.BufferGeometry {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geom.setAttribute('normal', new THREE.Float32BufferAttribute(this.norm, 3));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    geom.setAttribute('aSway', new THREE.Float32BufferAttribute(this.sway, 1));
    geom.setIndex(this.idx);
    geom.computeBoundingSphere();
    return geom;
  }
}

/** Corner ordering used by the side quads: two at the root, two at the tip. */
const UP_FROM_BASE = [0, 0, 1, 1] as const;
/** ...and by the cap, which is all tip. */
const ALL_TIP = [1, 1, 1, 1] as const;

export interface WindOptions {
  /** Downwind push at the tips, in blocks, before the gust envelope. */
  sway: number;
  /** Prevailing wind, normalised. Everything on the map leans the same way. */
  windX: number;
  windZ: number;
  /** Ripple rate. Lower is a lazier field. */
  speed: number;
}

/**
 * Patches a material so its vertices bend downwind.
 *
 * Two waves an octave apart so the field ripples instead of beating, under a
 * much slower envelope that walks gusts across it. A field that does not move
 * reads as a carpet, and a carpet is not somewhere you would think to hide.
 *
 * The returned uniform is the clock: whoever owns the mesh advances it.
 */
export function applyWind(
  mat: THREE.Material,
  opts: WindOptions,
): { value: number } {
  const time = { value: 0 };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        attribute float aSway;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        float phase = uTime * ${opts.speed.toFixed(3)} + position.x * 0.55 + position.z * 0.33;
        float gust = 0.45 + 0.55 * sin( uTime * 0.29 + position.x * 0.045 + position.z * 0.031 );
        float bend = ( sin( phase ) + 0.35 * sin( phase * 2.3 ) ) * aSway * ${opts.sway.toFixed(3)} * gust;
        transformed.x += bend * ${opts.windX.toFixed(3)};
        transformed.z += bend * ${opts.windZ.toFixed(3)};`);
  };
  return time;
}

/** Prevailing wind. Shared so the rice and the grass lean the same way. */
export const WIND_X = 0.82;
export const WIND_Z = 0.57;
