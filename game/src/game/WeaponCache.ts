import * as THREE from 'three';
import type { WeaponCacheSpot } from '../voxel/crashsite';
import { WEAPONS, WeaponId } from '../weapons/definitions';
import { weaponParts } from '../player/ViewModel';
import { BoxBuilder } from '../fx/boxMesh';

/**
 * The arms crates in the wreck's cargo bay.
 *
 * Everything else the player carries is bought: you walk to the village, you
 * stand at a merchant, you pay. These two are the exception and the only one --
 * the guns in them cost nothing and are not for sale anywhere, so the only way
 * to get an M60 or a Thumper is to walk out to the crash site and take one.
 * That is the entire reason the wreck is on the map.
 *
 * A crate is not a deployable and not a bot: it never moves, never fights, and
 * the only thing that happens to it is being opened once. So it lives here
 * rather than in game/Deployables.ts, which is about things the player puts
 * down, and it holds no state beyond `taken`.
 *
 * ## The gun in the box is the gun you get
 *
 * The prop lying in each crate is assembled from the same part list the first
 * person view model is built from ({@link weaponParts}), at world scale. That
 * is deliberate and it is worth the small amount of machinery it costs: a crate
 * that advertises a silhouette the player does not then end up holding is worse
 * than a closed crate, and a second hand-authored model for the same weapon
 * would drift out of step with the first the day either one is touched.
 */

export const CACHE = {
  /** How close the player has to stand to open one, from the eye. */
  reach: 3.6,
} as const;

// --- Crate colours ---------------------------------------------------------
// Unpainted timber with olive banding and a stencil, which is what an air
// delivery crate actually looked like. Kept lighter than everything on the
// airframe around it, because the crates are the one thing in the cargo bay
// the player is meant to notice from outside the door.
const TIMBER = 0x9c8358;
const TIMBER_DARK = 0x6f5c3c;
const BAND = 0x4a5230;
const BAND_DARK = 0x333a22;
const STENCIL = 0xc9c3ac;
const STRAW = 0xb0a072;

/** Wall thickness of a crate, in world units. */
const WALL = 0.09;
/** Clearance left round the gun inside. */
const PACKING = 0.22;

const MATERIAL = new THREE.MeshLambertMaterial({ vertexColors: true, fog: true });

function put(
  b: BoxBuilder,
  cx: number, cy: number, cz: number,
  hx: number, hy: number, hz: number,
  color: THREE.Color,
): void {
  b.box(cx - hx, cy - hy, cz - hz, hx * 2, hy * 2, hz * 2, color);
}

/** Bounding half-extents of a weapon's part list, and where its centre sits. */
function gunBounds(id: WeaponId): { cx: number; cy: number; cz: number; hx: number; hy: number; hz: number } {
  const parts = weaponParts(id) ?? [];
  let x0 = Infinity, y0 = Infinity, z0 = Infinity;
  let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const p of parts) {
    x0 = Math.min(x0, p.x - p.sx); x1 = Math.max(x1, p.x + p.sx);
    y0 = Math.min(y0, p.y - p.sy); y1 = Math.max(y1, p.y + p.sy);
    z0 = Math.min(z0, p.z - p.sz); z1 = Math.max(z1, p.z + p.sz);
  }
  return {
    cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, cz: (z0 + z1) / 2,
    hx: (x1 - x0) / 2, hy: (y1 - y0) / 2, hz: (z1 - z0) / 2,
  };
}

/**
 * The gun itself, laid flat in the bottom of the crate.
 *
 * The view model is authored lying along -Z with +Y up, which is already the
 * orientation a gun lies in when you put it in a box, so nothing has to be
 * rotated -- only recentred on the crate's own origin.
 */
function gunProp(id: WeaponId, cy: number): THREE.Mesh | null {
  const parts = weaponParts(id);
  if (!parts) return null;
  const bounds = gunBounds(id);
  const b = new BoxBuilder();
  const color = new THREE.Color();
  for (const p of parts) {
    color.setHex(p.color);
    put(b, p.x - bounds.cx, p.y - bounds.cy + cy, p.z - bounds.cz, p.sx, p.sy, p.sz, color);
  }
  const mesh = new THREE.Mesh(b.finish(), MATERIAL);
  mesh.name = `cache-gun-${id}`;
  mesh.castShadow = true;
  return mesh;
}

/**
 * One crate: body, propped lid, packing and the gun.
 *
 * The lid is a child with its own rotation rather than a stepped stack of small
 * boxes, because it is the one part here that is genuinely a flat plane at an
 * angle -- stepping it would put a staircase on the most visible face of the
 * most visible object in the wreck.
 */
export class WeaponCache {
  readonly group = new THREE.Group();
  taken = false;

  private readonly gun: THREE.Mesh | null;

  constructor(readonly spot: WeaponCacheSpot) {
    const bounds = gunBounds(spot.weapon);
    // Sized to its contents: an M60 needs a long box, a Thumper does not, and
    // two identical crates holding visibly different guns look like set
    // dressing rather than like cargo.
    const hz = bounds.hz + PACKING;
    const hx = Math.max(0.3, bounds.hx + PACKING);
    const hy = Math.max(0.22, bounds.hy + PACKING * 0.7);

    const timber = new THREE.Color(TIMBER);
    const timberDark = new THREE.Color(TIMBER_DARK);
    const band = new THREE.Color(BAND);
    const bandDark = new THREE.Color(BAND_DARK);
    const straw = new THREE.Color(STRAW);
    const stencil = new THREE.Color(STENCIL);

    const body = new BoxBuilder();
    // Floor, two long sides, two ends. Built as five boards rather than as a
    // hollowed box so the inside faces read as timber from above.
    put(body, 0, WALL, 0, hx, WALL, hz, timberDark);
    put(body, hx - WALL, hy, 0, WALL, hy, hz, timber);
    put(body, -(hx - WALL), hy, 0, WALL, hy, hz, timber);
    put(body, 0, hy, hz - WALL, hx, hy, WALL, timber);
    put(body, 0, hy, -(hz - WALL), hx, hy, WALL, timber);
    // Reinforcing bands round the ends, and the corner irons.
    for (const z of [hz * 0.62, -hz * 0.62]) {
      put(body, 0, hy, z, hx + 0.012, hy * 0.9, 0.05, band);
    }
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        put(body, sx * hx, hy * 0.25, sz * hz, 0.055, 0.09, 0.055, bandDark);
      }
    }
    // Excelsior the gun is bedded in. Visible whether or not it is still there,
    // which is what makes an emptied crate read as emptied rather than as shut.
    put(body, 0, WALL * 2 + 0.05, 0, hx - WALL * 2, 0.05, hz - WALL * 2, straw);

    const bodyMesh = new THREE.Mesh(body.finish(), MATERIAL);
    bodyMesh.name = 'cache-crate';
    bodyMesh.castShadow = true;
    bodyMesh.receiveShadow = true;
    this.group.add(bodyMesh);

    // --- Lid, hinged at the far side and propped back -------------------
    const lidGeom = new BoxBuilder();
    // Authored with the hinge on the origin so the child rotation swings it.
    put(lidGeom, 0, 0, -hz / 2, hx, WALL * 0.9, hz / 2, timber);
    put(lidGeom, 0, WALL * 1.4, -hz * 0.6, hx * 0.55, WALL * 0.5, hz * 0.16, stencil);
    for (const z of [-hz * 0.28, -hz * 0.82]) {
      put(lidGeom, 0, WALL * 1.2, z, hx + 0.012, 0.045, 0.05, band);
    }
    const lid = new THREE.Mesh(lidGeom.finish(), MATERIAL);
    lid.name = 'cache-lid';
    lid.castShadow = true;
    lid.position.set(0, hy * 2 - WALL, hz - WALL);
    lid.rotation.x = -1.22;
    this.group.add(lid);

    this.gun = gunProp(spot.weapon, WALL * 2 + 0.12 + bounds.hy);
    if (this.gun) this.group.add(this.gun);

    this.group.position.set(spot.x, spot.y, spot.z);
    this.group.rotation.order = 'YZX';
    this.group.rotation.set(spot.roll, spot.yaw + Math.PI / 2, spot.pitch);
  }

  get weapon(): WeaponId {
    return this.spot.weapon;
  }

  get name(): string {
    return WEAPONS[this.spot.weapon].name;
  }

  /** Empties it. Returns false if somebody already did. */
  take(): boolean {
    if (this.taken) return false;
    this.taken = true;
    if (this.gun) this.gun.visible = false;
    return true;
  }
}

/** Every crate on the map, and the one the player is standing at. */
export class WeaponCaches {
  readonly group = new THREE.Group();
  readonly crates: WeaponCache[] = [];

  constructor(spots: readonly WeaponCacheSpot[]) {
    this.group.name = 'weapon-caches';
    for (const spot of spots) {
      const crate = new WeaponCache(spot);
      this.crates.push(crate);
      this.group.add(crate.group);
    }
  }

  /**
   * The nearest unopened crate within reach, or null.
   *
   * Measured from the eye rather than from the feet, because the crates are on
   * a floor a block above the ground the player is standing on and a foot-level
   * measurement makes you climb in to reach something you can see into.
   */
  nearest(x: number, y: number, z: number): WeaponCache | null {
    let best: WeaponCache | null = null;
    let bestD: number = CACHE.reach;
    for (const crate of this.crates) {
      if (crate.taken) continue;
      const p = crate.group.position;
      const d = Math.hypot(p.x - x, p.y - y, p.z - z);
      if (d < bestD) { bestD = d; best = crate; }
    }
    return best;
  }

  dispose(): void {
    for (const crate of this.crates) {
      crate.group.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
    }
  }
}
