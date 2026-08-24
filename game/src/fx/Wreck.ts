import * as THREE from 'three';
import type { CrashSite } from '../voxel/crashsite';
import { BoxBuilder } from './boxMesh';

/**
 * Everything on the downed Huey that is finer than a block.
 *
 * The airframe itself is voxels -- you can shelter behind it, shoot through the
 * doorway, dig into the deck (see voxel/crashsite.ts). This is the other half:
 * the rotor, the skids, the door rail, the pintle the gun came off, the seats,
 * the glass. None of it would survive being written into the world grid. A
 * rotor blade is fifteen centimetres thick and nine metres long, and at one
 * block per metre that is a plank; skids at block resolution are two walls.
 *
 * So they are drawn the way the flags are: ordinary merged geometry at a
 * fraction of a voxel per cell, no collision, never reaching the server. The
 * trade is the same one the flags make and it is the right one here -- nobody
 * needs to take cover behind a rotor blade, and everybody needs to be able to
 * tell at two hundred blocks that the thing in the trees is an aircraft.
 *
 * ## Frames
 *
 * Four rigid pieces, each its own mesh with its own rotation, because they are
 * genuinely at different angles and pretending otherwise is what makes a wreck
 * look like a model kit:
 *
 * - the **hull**, at the airframe's attitude;
 * - the **boom**, which snapped off and landed on its side somewhere else;
 * - the **thrown blade**, which is stuck in the ground on its own;
 * - the **litter**, which is level with the ground and only yawed, so panels
 *   lie flat in the furrow instead of floating at the hull's angle.
 *
 * Each is authored in its own coordinates -- +X out the nose, +Y up, +Z out the
 * starboard door -- and the group rotation is set with Euler order `YZX`, which
 * composes as Ry * Rz * Rx and so matches the stamp's basis exactly. Get that
 * order wrong and the rotor sits at a plausible angle that is not the hull's.
 */

// --- Palette ---------------------------------------------------------------
// Free RGB rather than palette indices: none of this is a voxel, so none of it
// has to live inside the 63 fixed colours the world grid gets. That is what
// lets the airframe be actual olive drab out here while the blocks behind it
// settle for the nearest khaki the palette can express.
const OD = 0x4a5230;
const OD_DARK = 0x333a22;
const METAL = 0x8d9196;
const METAL_DARK = 0x585c62;
const BLADE = 0x2c2f2d;
/** The high-visibility stripe on the last few feet of a rotor blade. */
const BLADE_TIP = 0xc9ccc4;
const SOOT = 0x1b1a19;
const RUST = 0x7a4c30;
/** Perspex, in the pale green everything on an aircraft is tinted. */
const GLASS = 0x8fb0a6;
const BRASS = 0xa8863a;
const CANVAS = 0x8a8462;

// --- Geometry tuning -------------------------------------------------------
/** Half-length of one main rotor blade, in blocks. Twice this is the disc. */
const BLADE_SPAN = 10.2;
/** How the intact blade is authored: this many boxes from root to tip. */
const BLADE_SEGMENTS = 17;
const BLADE_CHORD = 0.62;
const BLADE_THICK = 0.17;
/** Height of the rotor head above the cabin floor. */
const HUB_Y = 8.0;

function colorOf(hex: number): THREE.Color {
  return new THREE.Color(hex);
}

/**
 * A box given as centre and half-extents, which is how the parts below read.
 *
 * {@link BoxBuilder.box} wants a minimum corner and a size, and converting at
 * every call site buries the numbers that matter -- where a thing is and how
 * big it is -- under arithmetic.
 */
function put(
  b: BoxBuilder,
  cx: number, cy: number, cz: number,
  hx: number, hy: number, hz: number,
  color: THREE.Color,
): void {
  b.box(cx - hx, cy - hy, cz - hz, hx * 2, hy * 2, hz * 2, color);
}

/**
 * Where the ground is, expressed in the hull's own coordinates.
 *
 * The blades and the skids need it: a blade that stops in mid air has not
 * finished falling, and a skid floating half a block off the dirt is the single
 * clearest tell that a thing was placed rather than crashed. Because the hull
 * is pitched and rolled, "the ground" is a sloping plane in model space rather
 * than a constant, so it is solved per point.
 */
function groundPlane(site: CrashSite): (mx: number, mz: number) => number {
  const sinP = Math.sin(site.pitch), cosP = Math.cos(site.pitch);
  const sinR = Math.sin(site.roll), cosR = Math.cos(site.roll);
  // The Y row of the basis: model X, Y and Z each contribute this much height.
  const ay = sinP;
  const by = cosP * cosR;
  const cy = -cosP * sinR;
  const drop = site.groundY - site.y;
  return (mx, mz) => (drop - ay * mx - cy * mz) / by;
}

// ---------------------------------------------------------------------------
// The hull's furniture
// ---------------------------------------------------------------------------

/**
 * The main rotor: a see-saw head with one blade still on it and one snapped
 * off at the root.
 *
 * The intact blade is the piece that does the most work in the whole model. It
 * is built as a chain of seventeen short boxes rather than one long one, and
 * the only reason for that is the droop: a blade that came to rest is bent, and
 * the bend is what says the ship is dead. A straight blade -- however long, at
 * whatever angle -- reads as parked.
 *
 * It sweeps aft over the tail stub, bending harder the further out it goes,
 * until the tip reaches dirt and stops there.
 */
function mainRotor(b: BoxBuilder, ground: (mx: number, mz: number) => number): void {
  const blade = colorOf(BLADE);
  const tip = colorOf(BLADE_TIP);
  const metal = colorOf(METAL);
  const metalDark = colorOf(METAL_DARK);
  const soot = colorOf(SOOT);

  // --- Head ------------------------------------------------------------
  // Hub, the see-saw trunnion it rocks on, and the two grips the blades bolt
  // into. Small, but it is the only part of the machine above the roofline
  // with any complexity in it, and a bare post reads as a chimney.
  put(b, 0, HUB_Y - 0.5, 0, 0.42, 0.5, 0.42, metalDark);
  put(b, 0, HUB_Y, 0, 1.05, 0.30, 0.55, metal);
  put(b, 0, HUB_Y + 0.28, 0, 0.42, 0.22, 0.42, metalDark);
  // Pitch links and the stabiliser bar across the head, one of the two things
  // that make a Huey rotor recognisable at all.
  put(b, -1.9, HUB_Y - 0.05, 0, 0.9, 0.08, 0.08, metalDark);
  put(b, 1.9, HUB_Y - 0.05, 0, 0.9, 0.08, 0.08, metalDark);
  put(b, -2.75, HUB_Y - 0.05, 0, 0.14, 0.18, 0.18, metal);
  put(b, 2.75, HUB_Y - 0.05, 0, 0.14, 0.18, 0.18, metal);
  put(b, 0, HUB_Y - 0.42, 0.62, 0.10, 0.34, 0.10, metalDark);
  put(b, 0, HUB_Y - 0.42, -0.62, 0.10, 0.34, 0.10, metalDark);

  // --- The blade that is still attached --------------------------------
  const rootX = -1.0;
  const step = (BLADE_SPAN - 1.0) / BLADE_SEGMENTS;
  for (let i = 0; i < BLADE_SEGMENTS; i++) {
    const t = (i + 0.5) / BLADE_SEGMENTS;
    const x = rootX - 0.5 * step - i * step;
    // Bends harder the further out it goes -- a blade is stiff at the root and
    // whips at the tip, so the curve has to be well past linear.
    let y = HUB_Y - 8.9 * Math.pow(t, 1.75);
    // A little sideways set as well: dead straight in plan is another way to
    // look manufactured.
    const z = -0.9 * t * t;
    const floor = ground(x, z) + 0.18;
    if (y < floor) y = floor;
    const outer = t > 0.86;
    put(b, x, y, z, step * 0.55, BLADE_THICK, BLADE_CHORD, outer ? tip : blade);
    // Spar cap catching the light along the leading edge.
    if (!outer && i % 2 === 0) {
      put(b, x, y + BLADE_THICK * 0.7, z - BLADE_CHORD * 0.7, step * 0.5, 0.05, 0.14, metalDark);
    }
  }

  // --- The blade that isn't --------------------------------------------
  // Two feet of root and then a splintered end. Where the rest of it went is
  // the thrown blade, built in its own frame below.
  put(b, 1.9, HUB_Y - 0.35, 0.15, 1.0, BLADE_THICK, BLADE_CHORD, blade);
  put(b, 2.75, HUB_Y - 0.55, 0.2, 0.28, 0.22, 0.5, soot);
  put(b, 3.05, HUB_Y - 0.7, 0.28, 0.22, 0.14, 0.3, metal);
}

/**
 * Skids: the starboard one still under the ship, the port one folded flat.
 *
 * Splaying one and not the other is the whole point. Two matching skids means
 * it landed; one collapsed means it arrived. The cross tubes stay put either
 * way, because they are forged and the skid tubes are not.
 */
function skids(b: BoxBuilder, ground: (mx: number, mz: number) => number): void {
  const metal = colorOf(METAL_DARK);
  const od = colorOf(OD_DARK);

  // Starboard: intact, sitting proud of the dirt with the toe turned up.
  const sz = 2.15;
  for (let i = 0; i < 12; i++) {
    const x = 4.0 - i * 0.72;
    // The forward end of a skid curves up into the cross tube.
    const lift = i < 2 ? (2 - i) * 0.34 : 0;
    put(b, x, -0.34 + lift, sz, 0.36, 0.18, 0.18, metal);
  }
  // Cross tubes: up into the belly, out and down to the skid.
  for (const cx of [2.3, -1.5]) {
    put(b, cx, 0.05, sz - 0.55, 0.22, 0.22, 0.75, od);
    put(b, cx, -0.16, sz, 0.20, 0.22, 0.25, od);
  }

  // Port: folded under, so it lies flatter, further out and half in the ground.
  const pz = -2.55;
  for (let i = 0; i < 11; i++) {
    const x = 3.4 - i * 0.72;
    const y = ground(x, pz) + 0.16;
    put(b, x, y, pz - i * 0.06, 0.36, 0.16, 0.18, metal);
  }
  // The two struts that gave way, still attached at the top and bent outward.
  for (const cx of [2.3, -1.5]) {
    put(b, cx, 0.05, -1.55, 0.22, 0.22, 0.6, od);
    put(b, cx, -0.55, -2.15, 0.20, 0.5, 0.24, od);
  }
}

/**
 * The starboard doorway: the rail, the door rolled back on it, and the pintle.
 *
 * The gun is deliberately not on the mount. An M60 modelled hanging in the
 * doorway is the best-looking single object on the wreck and it would be a
 * trap: the player would walk up to it, press E at it, and find that the gun
 * they can see is scenery while the gun they can have is in a box behind it.
 * An empty cradle with the belt still trailing out of it says the same thing
 * about what this aircraft was and points at the crates instead.
 */
function doorway(b: BoxBuilder): void {
  const od = colorOf(OD);
  const odDark = colorOf(OD_DARK);
  const metal = colorOf(METAL_DARK);
  const brass = colorOf(BRASS);

  // Upper and lower rails, running the length of the bay.
  put(b, -1.3, 4.35, 2.86, 3.1, 0.11, 0.14, metal);
  put(b, -1.3, 1.15, 2.86, 3.1, 0.10, 0.14, metal);
  // The door itself, rolled aft and stopped against its buffer. Left slightly
  // proud of the fuselage line, the way a door on an external rail sits.
  put(b, -3.5, 2.75, 2.95, 0.85, 1.5, 0.13, od);
  put(b, -3.5, 3.55, 2.99, 0.8, 0.55, 0.05, colorOf(GLASS));
  put(b, -3.5, 1.35, 2.98, 0.85, 0.16, 0.06, odDark);

  // --- Pintle, with nothing on it --------------------------------------
  put(b, 0.15, 1.55, 2.5, 0.16, 0.5, 0.16, metal);
  put(b, 0.15, 2.1, 2.5, 0.13, 0.3, 0.13, colorOf(METAL));
  put(b, 0.15, 2.42, 2.5, 0.34, 0.09, 0.2, colorOf(METAL));
  // The cradle, empty and swung out over the sill.
  put(b, 0.15, 2.6, 2.62, 0.12, 0.22, 0.34, metal);
  put(b, 0.15, 2.78, 2.62, 0.3, 0.08, 0.1, metal);

  // Ammo can bolted to the mount, and the belt that ran out of it -- still fed
  // up to a gun that is not there any more, which is the whole story in one
  // detail. Stepped down in small boxes, the way the belt on the view model is.
  put(b, -0.35, 1.5, 2.55, 0.42, 0.38, 0.3, colorOf(OD_DARK));
  put(b, -0.35, 1.9, 2.55, 0.45, 0.06, 0.33, metal);
  for (let i = 0; i < 7; i++) {
    const t = i / 6;
    put(
      b,
      -0.32 + t * 0.42, 1.98 + Math.sin(t * 2.6) * 0.32, 2.6 + t * 0.06,
      0.11, 0.06, 0.1, brass,
    );
  }
}

/**
 * Inside the cockpit: two seats, the coaming, the sticks, and what is left of
 * the glass.
 *
 * All of it visible only through the smashed windscreen, which is exactly why
 * it is worth having -- the wreck has to reward walking round to the front of
 * it, and an empty shell does not.
 */
function cockpit(b: BoxBuilder): void {
  const canvas = colorOf(CANVAS);
  const metal = colorOf(METAL_DARK);
  const glass = colorOf(GLASS);
  const soot = colorOf(SOOT);

  for (const z of [-0.95, 0.95]) {
    // Armoured seat back and pan.
    put(b, 2.55, 2.7, z, 0.16, 0.7, 0.42, metal);
    put(b, 2.9, 2.05, z, 0.35, 0.12, 0.42, canvas);
    // Cyclic between the pilot's knees, collective outboard of it.
    put(b, 3.35, 2.3, z, 0.07, 0.35, 0.07, soot);
    put(b, 3.1, 1.95, z + (z > 0 ? 0.5 : -0.5), 0.3, 0.07, 0.07, soot);
  }
  // Instrument coaming and the pedestal between the seats, burnt through.
  put(b, 3.6, 2.85, 0, 0.3, 0.28, 1.3, soot);
  put(b, 3.5, 2.2, 0, 0.3, 0.5, 0.3, metal);

  // Glass left in the frame: three shards along the top edge and one corner.
  // Deliberately sparse. A windscreen with most of it still in is a windscreen
  // somebody opened, not one somebody went through.
  put(b, 4.2, 3.6, -1.1, 0.06, 0.22, 0.4, glass);
  put(b, 4.2, 3.5, 0.2, 0.06, 0.3, 0.3, glass);
  put(b, 4.25, 2.3, 1.35, 0.06, 0.4, 0.2, glass);
}

/** Whip antennae and the pitot boom: the last few thin things on the airframe. */
function antennae(b: BoxBuilder): void {
  const metal = colorOf(METAL_DARK);
  // Roof whip, bent back where the canopy came down on it.
  put(b, -3.2, 5.7, 0.7, 0.06, 0.5, 0.06, metal);
  put(b, -3.5, 6.15, 0.7, 0.36, 0.06, 0.06, metal);
  // Belly whip, still straight.
  put(b, -1.2, -0.5, -0.8, 0.05, 0.5, 0.05, metal);
  // Pitot tube off the nose.
  put(b, 6.8, 2.2, 0.5, 0.35, 0.06, 0.06, metal);
}

// ---------------------------------------------------------------------------
// The pieces that are somewhere else
// ---------------------------------------------------------------------------

/** Tail rotor, driveshaft cover and skid, in the boom's own coordinates. */
function tailRotor(b: BoxBuilder): void {
  const blade = colorOf(BLADE);
  const tip = colorOf(BLADE_TIP);
  const metal = colorOf(METAL_DARK);
  const od = colorOf(OD_DARK);

  // Driveshaft cover, a raised spine the length of the boom.
  for (let i = 0; i < 9; i++) {
    put(b, -0.4 - i * 0.95, 0.72, 0, 0.42, 0.13, 0.22, od);
  }
  // Hub, out to port of the fin, and two blades. One is snapped short.
  const hz = -0.75;
  put(b, -8.1, 2.35, hz, 0.28, 0.28, 0.3, metal);
  for (let i = 0; i < 4; i++) {
    const t = (i + 0.5) / 4;
    put(b, -8.1 - t * 0.2, 2.35 + 0.45 + i * 0.42, hz, 0.1, 0.24, 0.32, i === 3 ? tip : blade);
  }
  put(b, -8.1, 2.35 - 0.6, hz, 0.1, 0.4, 0.3, blade);
  put(b, -8.1, 2.35 - 1.0, hz, 0.14, 0.14, 0.2, colorOf(SOOT));
  // Tail skid under the fin.
  put(b, -8.4, -0.75, 0, 0.12, 0.4, 0.12, metal);
}

/**
 * The blade that came off the head, stuck in the ground where it landed.
 *
 * Built root-at-origin running along +X so the caller can point it wherever it
 * ended up. It is the piece that tells you the rotor was still turning when the
 * ship went in, which is the difference between a crash and a landing.
 */
function thrownBlade(b: BoxBuilder): void {
  const blade = colorOf(BLADE);
  const tip = colorOf(BLADE_TIP);
  const metal = colorOf(METAL_DARK);

  put(b, -0.25, 0, 0, 0.3, 0.22, 0.4, metal);
  const n = 11;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    // A long shallow bow along its length: a blade that hit the ground at speed
    // does not stay flat, and the curve is what stops this reading as a plank.
    put(b, 0.4 + i * 0.66, Math.sin(t * Math.PI) * 0.42, 0, 0.34, BLADE_THICK, BLADE_CHORD, t > 0.84 ? tip : blade);
  }
}

/**
 * What is lying in the furrow.
 *
 * Yawed with the scar but level with the ground, so every piece of it lies flat
 * the way debris does. Positions are relative to the hull, along the heading:
 * -X is back up the approach, which is where anything that came off early ended
 * up. Nothing here is dense -- a wreck ringed by neatly spaced panels reads as a
 * display, and the gaps between them are what make the field look scattered.
 */
function litter(b: BoxBuilder): void {
  const od = colorOf(OD);
  const odDark = colorOf(OD_DARK);
  const metal = colorOf(METAL);
  const soot = colorOf(SOOT);
  const rust = colorOf(RUST);
  const brass = colorOf(BRASS);

  /** Torn skin panels, face down in the dirt. */
  const panel = (
    x: number, z: number, w: number, d: number, turn: number, color: THREE.Color,
  ): void => {
    // Faked rotation: a couple of overlapping boxes offset along the turn, which
    // at this size reads as a bent panel and costs nothing.
    put(b, x, 0.09, z, w, 0.09, d, color);
    put(b, x + Math.cos(turn) * w * 0.7, 0.16, z + Math.sin(turn) * w * 0.7, w * 0.5, 0.08, d * 0.8, color);
  };

  panel(-7.5, 5.2, 1.1, 0.8, 0.7, od);
  panel(-12.0, -2.4, 0.9, 1.2, 2.2, odDark);
  panel(-4.5, -6.6, 1.3, 0.7, 1.1, od);
  panel(-16.5, 3.1, 0.8, 0.9, 0.3, odDark);
  panel(2.5, -5.4, 0.7, 1.0, 2.6, metal);

  // The engine cowling, hinged open and thrown clear -- the one big piece.
  put(b, -9.5, 0.55, -4.2, 1.5, 0.55, 0.9, soot);
  put(b, -9.5, 1.15, -4.9, 1.4, 0.1, 0.55, metal);

  // Fuel drum out of the cabin, split and rusted at the seam.
  put(b, -3.2, 0.55, 6.0, 0.55, 0.55, 0.75, rust);
  put(b, -3.2, 0.55, 6.0, 0.6, 0.18, 0.8, odDark);

  // Ammo cans that came out of the door, one on its side and open.
  put(b, -1.6, 0.35, 4.1, 0.38, 0.35, 0.28, odDark);
  put(b, -2.4, 0.3, 4.6, 0.3, 0.3, 0.4, odDark);
  put(b, -2.4, 0.62, 4.6, 0.32, 0.05, 0.42, metal);
  // Loose belt spilled out of the open one.
  for (let i = 0; i < 6; i++) {
    put(b, -2.7 - i * 0.16, 0.09, 5.1 + i * 0.2, 0.11, 0.06, 0.1, brass);
  }

  // A gearbox, half buried, with the earth thrown up on the far side of it.
  put(b, -14.0, 0.4, -0.6, 0.7, 0.4, 0.7, metal);
  put(b, -14.9, 0.25, -0.6, 0.35, 0.25, 0.8, soot);
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

const MATERIAL = new THREE.MeshLambertMaterial({ vertexColors: true, fog: true });

function meshOf(b: BoxBuilder, name: string): THREE.Mesh {
  const mesh = new THREE.Mesh(b.finish(), MATERIAL);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Places one piece.
 *
 * Euler order `YZX` composes as Ry * Rz * Rx, matching the basis the voxel
 * stamp is built from. Any other order puts the detail at an angle that looks
 * fine on its own and is visibly not the angle the hull is at.
 */
function place(
  mesh: THREE.Object3D,
  x: number, y: number, z: number,
  yaw: number, pitch: number, roll: number,
): void {
  mesh.position.set(x, y, z);
  mesh.rotation.order = 'YZX';
  mesh.rotation.set(roll, yaw, pitch);
}

/** Builds every sub-voxel piece of the wreck. Static once created. */
export function buildWreck(site: CrashSite): THREE.Group {
  const group = new THREE.Group();
  group.name = 'wreck';

  const ground = groundPlane(site);

  const hull = new BoxBuilder();
  mainRotor(hull, ground);
  skids(hull, ground);
  doorway(hull);
  cockpit(hull);
  antennae(hull);
  const hullMesh = meshOf(hull, 'wreck-hull');
  place(hullMesh, site.x, site.y, site.z, site.yaw, site.pitch, site.roll);
  group.add(hullMesh);

  const boom = new BoxBuilder();
  tailRotor(boom);
  const boomMesh = meshOf(boom, 'wreck-boom');
  place(boomMesh, site.boom.x, site.boom.y, site.boom.z, site.boom.yaw, site.boom.pitch, site.boom.roll);
  group.add(boomMesh);

  // The thrown blade: forward and off to starboard of the hull, driven into the
  // dirt at a steep angle with its tip in the air. Whichever way the rotor was
  // turning, a blade that lets go leaves along the tangent, so it is ahead of
  // the wreck rather than behind it -- the furrow is behind.
  const blade = new BoxBuilder();
  thrownBlade(blade);
  const bladeMesh = meshOf(blade, 'wreck-blade');
  const bx = site.x + site.headingX * 7.5 - site.headingZ * 5.5;
  const bz = site.z + site.headingZ * 7.5 + site.headingX * 5.5;
  place(bladeMesh, bx, site.groundY - 0.4, bz, site.yaw + 1.35, 0.55, 0.25);
  group.add(bladeMesh);

  // The furrow's contents: yawed with the scar, level with the ground.
  const debris = new BoxBuilder();
  litter(debris);
  const debrisMesh = meshOf(debris, 'wreck-litter');
  place(debrisMesh, site.x, site.groundY, site.z, site.yaw, 0, 0);
  group.add(debrisMesh);

  return group;
}
