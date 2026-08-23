import * as THREE from 'three';
import { BoxBuilder, Face, FACE_OFFSET } from './boxMesh';
import { SUN_TO_LIGHT } from '../core/lighting';

/**
 * A sky made of blocks: a slab cloud layer and a stepped sun disc.
 *
 * AoS deliberately has no sky at all -- the background is flat fog colour, so
 * the horizon dissolves rather than meeting anything. That reads as clean and
 * empty, which is wrong for a jungle: the thing you notice standing under a
 * canopy is exactly the low, heavy cloud sitting on top of the haze.
 *
 * Three details make this work rather than just being geometry in the air:
 *
 *  - The whole group is parented to the camera *position* each frame (never its
 *    rotation), so the clouds never get closer no matter how far you walk. It
 *    is a cloud plane at infinity, done cheaply.
 *  - Nothing here writes depth, so the world always paints over it. Both parts
 *    keep the depth *test*, being translucent and therefore drawn after the
 *    opaque world -- without it a cloud or the sun would burn straight through
 *    any hill standing in front of it.
 *  - The clouds run the world's own fog. It keys off *horizontal* distance and
 *    saturates at RENDER.fogDistance, so a cloud out past that is pure fog
 *    colour on a fog-coloured sky, i.e. gone. What survives is the cone more or
 *    less overhead, thinning as it drops toward the horizon -- the terrain and
 *    the sky then dissolve into exactly the same wall, with no seam where they
 *    meet. That is why CLOUD_RADIUS only slightly exceeds the fog distance:
 *    anything further is geometry that can never be seen.
 */

/**
 * Height of the cloud layer above the eye.
 *
 * Lower than it looks like it should be, and the fog is why: the layer is only
 * visible where it is nearer than RENDER.fogDistance *horizontally*, so raising
 * it narrows the cone of sky that still has cloud in it. Dropping it widens
 * that cone and coarsens the pixels at the same time.
 */
const CLOUD_Y = 46;
/**
 * Edge of one cloud voxel, in world units. This is the pixel size of the sky:
 * at CLOUD_Y overhead it subtends about 3 degrees, so the layer reads as
 * coarse pixel art rather than as geometry that happens to be up there.
 */
const CLOUD_VOXEL = 3;
/** Cloud blob extent, in cloud voxels. */
const CLOUD_FOOTPRINT = 11;
const CLOUD_THICK = 3;
/** Clouds are placed on a jittered grid of this pitch, out to CLOUD_RADIUS. */
const CLOUD_CELL = 40;
/**
 * Only a little past RENDER.fogDistance (58, and ~68 up at cloud height where
 * the fog thins). Anything beyond that is fully
 * fogged to the sky colour, so it is geometry that can never be seen -- at 150
 * more than half the quads were exactly that.
 */
const CLOUD_RADIUS = 105;
/** Fraction of grid cells that actually carry a cloud. */
const CLOUD_COVERAGE = 0.72;
/**
 * Deliberately faint. These are humidity, not weather -- the fog does most of
 * the work and the clouds only have to suggest something above it.
 */
const CLOUD_OPACITY = 0.26;

const CLOUD_TOP = new THREE.Color(0xf2f4f6);
const CLOUD_SIDE = new THREE.Color(0xd2dae4);
const CLOUD_UNDER = new THREE.Color(0x9fb0c4);

/** Distance to the sun disc, and the size of one of its cells. */
const SUN_DIST = 190;
const SUN_CELL = 1.7;
/** Solid core out to this radius in cells; glow fades to zero by SUN_GLOW_R. */
const SUN_CORE_R = 5;
const SUN_GLOW_R = 9;
const SUN_CORE = new THREE.Color(0xfff6dc);

function hash(x: number, y: number, seed: number): number {
  let h = x * 374761393 + y * 668265263 + seed * 2147483647;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/**
 * One cloud, as a solid-of-revolution blob roughened by noise, voxelised.
 *
 * Returns a flat occupancy grid indexed [ix][iy][iz], which the caller needs
 * anyway to cull interior faces.
 */
function cloudShape(seedX: number, seedZ: number): boolean[] {
  const F = CLOUD_FOOTPRINT;
  const cells = new Array<boolean>(F * CLOUD_THICK * F).fill(false);
  const mid = (F - 1) / 2;
  const midY = (CLOUD_THICK - 1) / 2;
  for (let iy = 0; iy < CLOUD_THICK; iy++) {
    for (let iz = 0; iz < F; iz++) {
      for (let ix = 0; ix < F; ix++) {
        const rr = Math.hypot(ix - mid, iz - mid) / (mid + 0.5);
        // Thickest through the middle layer, tapering to the top and bottom.
        const vt = 1 - Math.abs(iy - midY) / (midY + 0.7);
        const n = hash(seedX * 31 + ix, seedZ * 31 + iz + iy * 977, 211);
        const density = (1 - rr) * (0.45 + 0.8 * vt) + (n - 0.5) * 0.75;
        cells[(iy * F + iz) * F + ix] = density > 0.34;
      }
    }
  }
  return cells;
}

function buildClouds(): THREE.Mesh {
  const F = CLOUD_FOOTPRINT;
  const b = new BoxBuilder();
  const at = (c: boolean[], ix: number, iy: number, iz: number): boolean =>
    ix >= 0 && iy >= 0 && iz >= 0 && ix < F && iy < CLOUD_THICK && iz < F &&
    c[(iy * F + iz) * F + ix];

  for (let gz = -CLOUD_RADIUS; gz <= CLOUD_RADIUS; gz += CLOUD_CELL) {
    for (let gx = -CLOUD_RADIUS; gx <= CLOUD_RADIUS; gx += CLOUD_CELL) {
      if (hash(gx, gz, 17) > CLOUD_COVERAGE) continue;

      const cx = gx + (hash(gx, gz, 31) - 0.5) * CLOUD_CELL;
      const cz = gz + (hash(gx, gz, 47) - 0.5) * CLOUD_CELL;
      if (Math.hypot(cx, cz) > CLOUD_RADIUS) continue;

      const cells = cloudShape(gx, gz);
      const oy = CLOUD_Y + (hash(gx, gz, 107) - 0.5) * 10;
      const ox = cx - (F * CLOUD_VOXEL) / 2;
      const oz = cz - (F * CLOUD_VOXEL) / 2;

      for (let iy = 0; iy < CLOUD_THICK; iy++) {
        for (let iz = 0; iz < F; iz++) {
          for (let ix = 0; ix < F; ix++) {
            if (!at(cells, ix, iy, iz)) continue;
            // Only faces exposed to air; see BoxBuilder.shadedBox on why this
            // matters more for a translucent volume than for a solid one.
            let mask = 0;
            for (let f = 0; f < FACE_OFFSET.length; f++) {
              const [dx, dy, dz] = FACE_OFFSET[f];
              if (!at(cells, ix + dx, iy + dy, iz + dz)) mask |= 1 << f;
            }
            if (mask === 0) continue;
            b.shadedBox(
              ox + ix * CLOUD_VOXEL, oy + iy * CLOUD_VOXEL, oz + iz * CLOUD_VOXEL,
              CLOUD_VOXEL, CLOUD_VOXEL, CLOUD_VOXEL,
              (face) => face === Face.Top ? CLOUD_TOP
                : face === Face.Bottom ? CLOUD_UNDER : CLOUD_SIDE,
              mask,
            );
          }
        }
      }
    }
  }

  const mesh = new THREE.Mesh(b.finish(), new THREE.MeshBasicMaterial({
    vertexColors: true, fog: true,
    transparent: true, opacity: CLOUD_OPACITY,
    depthWrite: false, depthTest: true,
  }));
  mesh.name = 'sky-clouds';
  mesh.frustumCulled = false;
  mesh.renderOrder = -2;
  return mesh;
}

/**
 * The sun, as a stepped disc facing the camera.
 *
 * Additive, with the cell colour falling off past the core radius, so the outer
 * ring reads as glow rather than as a hard blocky edge on a bright disc.
 */
function buildSun(): THREE.Mesh {
  const b = new BoxBuilder();
  const tmp = new THREE.Color();
  const black = new THREE.Color(0, 0, 0);

  for (let cy = -SUN_GLOW_R; cy <= SUN_GLOW_R; cy++) {
    for (let cx = -SUN_GLOW_R; cx <= SUN_GLOW_R; cx++) {
      const r = Math.hypot(cx, cy);
      if (r > SUN_GLOW_R) continue;
      // Full brightness across the core, then a squared falloff to nothing.
      let k = 1;
      if (r > SUN_CORE_R) {
        const t = (r - SUN_CORE_R) / (SUN_GLOW_R - SUN_CORE_R);
        k = (1 - t) * (1 - t) * 0.5;
      }
      if (k <= 0.01) continue;
      tmp.copy(black).lerp(SUN_CORE, k);
      // Flat in local XY; the mesh as a whole is aimed down the sun vector.
      b.box(cx * SUN_CELL, cy * SUN_CELL, 0, SUN_CELL, SUN_CELL, 0.01, tmp);
    }
  }

  // Depth-tested, unlike the clouds. Being additive makes this transparent, so
  // it is drawn after the opaque world -- without the test it would burn
  // through any hill standing between the player and the sun.
  const mesh = new THREE.Mesh(b.finish(), new THREE.MeshBasicMaterial({
    vertexColors: true, fog: false, depthWrite: false, depthTest: true,
    blending: THREE.AdditiveBlending, transparent: true,
  }));
  mesh.name = 'sky-sun';
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  mesh.position.copy(SUN_TO_LIGHT).multiplyScalar(SUN_DIST);
  mesh.lookAt(0, 0, 0);
  return mesh;
}

/**
 * The sky group. Add {@link group} to the scene once, then call
 * {@link update} with the camera position every frame.
 */
export class Sky {
  readonly group = new THREE.Group();

  constructor() {
    this.group.name = 'sky';
    this.group.add(buildClouds(), buildSun());
  }

  /** Keeps the sky centred on the eye, so it never approaches. */
  update(cameraPos: THREE.Vector3): void {
    this.group.position.copy(cameraPos);
  }
}
