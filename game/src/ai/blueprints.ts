import { Mat, WORLD_Y } from '../core/constants';
import { COL_WOOD, COL_DIRT_DARK, AIR } from '../voxel/palette';
import type { VoxelWorld } from '../voxel/VoxelWorld';

export const enum BlueprintId {
  RampShort = 0,
  RampTall = 1,
  FiringStep = 2,
  Sangar = 3,
  Barricade = 4,
  Bridge = 5,
}

/** A local cell of a blueprint: [x, y, z], +Z forward, +Y up. */
export type Cell = readonly [number, number, number];

export interface Blueprint {
  readonly id: BlueprintId;
  readonly name: string;
  /**
   * Cells in build order — bottom-up, back-to-front, so a structure rises the
   * way someone would actually stack it and the builder never seals itself in.
   */
  readonly cells: readonly Cell[];
  readonly material: Mat;
  readonly color: number;
  /** How far forward the footprint reaches, in cells. */
  readonly depth: number;
  /** Half-width of the footprint. */
  readonly halfWidth: number;
  /** Height the top surface reaches above the origin. */
  readonly rise: number;
  /** Seconds between blocks. Emergency cover goes up faster than a siege ramp. */
  readonly placeInterval: number;
}

function ordered(cells: Cell[]): Cell[] {
  return cells.slice().sort((a, b) => (a[1] - b[1]) || (a[2] - b[2]) || (a[0] - b[0]));
}

/**
 * A flight of floating steps, one block of rise per cell of depth — the same
 * thing an Ace of Spades player throws up to get over a wall, and cheap enough
 * that a squad can finish one while under fire.
 */
function stair(steps: number, halfWidth: number): Cell[] {
  const cells: Cell[] = [];
  for (let z = 0; z < steps; z++)
    for (let x = -halfWidth; x <= halfWidth; x++)
      cells.push([x, z, z]);
  return cells;
}

/** Raised platform with a parapet on the forward edge — shoot over, not through. */
function firingStep(): Cell[] {
  const cells: Cell[] = [];
  // Stepped base so the builder can walk up it: z=0 is one high, z=1..2 are two.
  for (let z = 0; z <= 2; z++) for (let x = -1; x <= 1; x++) cells.push([x, 0, z]);
  for (let z = 1; z <= 2; z++) for (let x = -1; x <= 1; x++) cells.push([x, 1, z]);
  // Parapet: knee-to-chest height for anyone standing on the platform.
  for (let x = -1; x <= 1; x++) cells.push([x, 2, 2]);
  cells.push([-1, 2, 1], [1, 2, 1]);
  return cells;
}

/** Waist-high U of cover, open to the rear so the occupant can fall back. */
function sangar(): Cell[] {
  const cells: Cell[] = [];
  for (let y = 0; y <= 1; y++) {
    for (let x = -2; x <= 2; x++) cells.push([x, y, 2]);
    cells.push([-2, y, 1], [2, y, 1]);
  }
  return cells;
}

/** Six blocks of instant cover, thrown down when caught in the open. */
function barricade(): Cell[] {
  const cells: Cell[] = [];
  for (let y = 0; y <= 1; y++) for (let x = -1; x <= 1; x++) cells.push([x, y, 1]);
  return cells;
}

/** Flat span for crossing water or a blasted-out trench. */
function bridge(): Cell[] {
  const cells: Cell[] = [];
  for (let z = 0; z <= 6; z++) for (let x = -1; x <= 1; x++) cells.push([x, 0, z]);
  return cells;
}

export const BLUEPRINTS: readonly Blueprint[] = [
  {
    id: BlueprintId.RampShort, name: 'Assault Ramp', cells: ordered(stair(3, 1)),
    material: Mat.Dirt, color: COL_DIRT_DARK,
    depth: 3, halfWidth: 1, rise: 3, placeInterval: 0.3,
  },
  {
    id: BlueprintId.RampTall, name: 'Siege Ramp', cells: ordered(stair(5, 1)),
    material: Mat.Dirt, color: COL_DIRT_DARK,
    depth: 5, halfWidth: 1, rise: 5, placeInterval: 0.3,
  },
  {
    id: BlueprintId.FiringStep, name: 'Firing Step', cells: ordered(firingStep()),
    material: Mat.Wood, color: COL_WOOD,
    depth: 3, halfWidth: 1, rise: 2, placeInterval: 0.34,
  },
  {
    id: BlueprintId.Sangar, name: 'Sangar', cells: ordered(sangar()),
    material: Mat.Wood, color: COL_WOOD,
    depth: 3, halfWidth: 2, rise: 2, placeInterval: 0.3,
  },
  {
    id: BlueprintId.Barricade, name: 'Barricade', cells: ordered(barricade()),
    material: Mat.Wood, color: COL_WOOD,
    depth: 2, halfWidth: 1, rise: 2, placeInterval: 0.16,
  },
  {
    id: BlueprintId.Bridge, name: 'Bridge', cells: ordered(bridge()),
    material: Mat.Wood, color: COL_WOOD,
    depth: 7, halfWidth: 1, rise: 1, placeInterval: 0.22,
  },
];

/**
 * Rotation about Y in quarter turns. Rotation 0 points the blueprint's forward
 * axis at +Z; 1 at +X; 2 at -Z; 3 at -X.
 */
export function rotateX(x: number, z: number, rot: number): number {
  switch (rot & 3) {
    case 1: return z;
    case 2: return -x;
    case 3: return -z;
    default: return x;
  }
}

export function rotateZ(x: number, z: number, rot: number): number {
  switch (rot & 3) {
    case 1: return -x;
    case 2: return -z;
    case 3: return x;
    default: return z;
  }
}

/** The quarter turn whose forward axis best matches the given direction. */
export function rotationToward(dx: number, dz: number): number {
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? 1 : 3;
  return dz > 0 ? 0 : 2;
}

/** Forward step of a rotation, as a unit cell offset. */
export function forwardX(rot: number): number {
  return rotateX(0, 1, rot);
}

export function forwardZ(rot: number): number {
  return rotateZ(0, 1, rot);
}

/**
 * Scores a candidate site. Returns -1 when the blueprint can't be built there,
 * otherwise the number of blocks still to place (fewer is better — partially
 * pre-filled sites are cheap wins).
 */
export function evaluateSite(
  world: VoxelWorld,
  bp: Blueprint,
  ox: number, oy: number, oz: number,
  rot: number,
): number {
  let remaining = 0;
  let obstructed = 0;
  for (const [lx, ly, lz] of bp.cells) {
    const x = ox + rotateX(lx, lz, rot);
    const y = oy + ly;
    const z = oz + rotateZ(lx, lz, rot);
    if (y < 1 || y >= WORLD_Y - 1) return -1;
    if (world.get(x, y, z) === AIR) {
      remaining++;
      continue;
    }
    // Already-solid cells are free, but a site buried in terrain is no site.
    obstructed++;
  }
  if (obstructed > bp.cells.length * 0.45) return -1;
  if (remaining === 0) return -1;
  return remaining;
}
