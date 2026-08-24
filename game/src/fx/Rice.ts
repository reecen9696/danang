import * as THREE from 'three';
import { palette, COL_RICE, COL_RICE_DRY } from '../voxel/palette';
import { BladeBuilder, bladeHash, applyWind, WIND_X, WIND_Z } from './blades';
import type { MapLayout } from '../voxel/worldgen';

/**
 * The standing crop in the paddy.
 *
 * Rice was voxels once, one block of green per cell, and it had the two faults
 * a block of green always has: you could stand on it, and you could not stand
 * *in* it. Both matter here, because the field is the open ground the enemy
 * crosses and the only thing on it worth using is the crop. So the rice is
 * drawn the way the flags and the farmers are -- ordinary geometry at a finer
 * grain than the grid (fx/blades.ts) -- which makes it something you walk into
 * rather than onto, that rounds pass straight through, and that hides a man who
 * gets down in it. The concealment itself is not here: it falls out of the
 * height the blades are built to, and is read back off the field by
 * `riceConceals` in worldgen (see ai/BotManager).
 *
 * The whole field is one merged geometry and one draw call. Nothing about it
 * changes after it is built except the wind, which lives in the vertex shader.
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

function colorOf(index: number): [number, number, number] {
  return [
    palette[index * 3] / 255,
    palette[index * 3 + 1] / 255,
    palette[index * 3 + 2] / 255,
  ];
}

/** The crop in the paddy: one mesh, and the wind that moves it. */
export class Rice {
  readonly mesh: THREE.Mesh;
  private readonly time: { value: number };

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
        const a = bladeHash(patch.x, patch.z, i * 7 + 1) * Math.PI * 2;
        const rad = SPREAD * (0.25 + bladeHash(patch.x, patch.z, i * 7 + 2) * 0.75);
        const h = patch.height * (0.7 + bladeHash(patch.x, patch.z, i * 7 + 3) * 0.55);
        // Blades lean away from the middle of their own clump, so a clump
        // opens out like a plant instead of standing like a bundle of sticks.
        const lean = LEAN * h * (0.4 + bladeHash(patch.x, patch.z, i * 7 + 4));
        b.boxBlade(
          patch.x + Math.cos(a) * rad, patch.y, patch.z + Math.sin(a) * rad,
          h, Math.cos(a) * lean, Math.sin(a) * lean,
          BLADE_BASE, BLADE_TIP,
          rootR, rootG, rootB, tipR, tipG, tipB,
        );
      }
    }

    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, fog: true });
    this.time = applyWind(mat, { sway: SWAY, windX: WIND_X, windZ: WIND_Z, speed: 1.7 });
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
