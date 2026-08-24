/**
 * Global tuning constants.
 *
 * Movement / weapon numbers are taken from Ace of Spades Classic (0.75/0.76)
 * behaviour so the game "feels" right; see reference/openspades for the values
 * these were derived from. All code here is an original implementation.
 */

// ---------------------------------------------------------------------------
// World dimensions. 1 unit == 1 voxel. Y is up (AoS used Z-up; we convert).
// ---------------------------------------------------------------------------
export const WORLD_X = 256;
export const WORLD_Y = 64;
export const WORLD_Z = 256;

export const CHUNK = 32;
export const CHUNKS_X = WORLD_X / CHUNK; // 8
export const CHUNKS_Y = WORLD_Y / CHUNK; // 2
export const CHUNKS_Z = WORLD_Z / CHUNK; // 8
export const CHUNK_COUNT = CHUNKS_X * CHUNKS_Y * CHUNKS_Z;

export const WATER_LEVEL = 18;

/** Flat index into the world voxel arrays. X is contiguous (fast X sweeps). */
export function voxelIndex(x: number, y: number, z: number): number {
  return (y * WORLD_Z + z) * WORLD_X + x;
}

export function inBounds(x: number, y: number, z: number): boolean {
  return x >= 0 && y >= 0 && z >= 0 && x < WORLD_X && y < WORLD_Y && z < WORLD_Z;
}

// ---------------------------------------------------------------------------
// Materials. Index stored in the `mat` array; 0 is only meaningful when the
// matching `blocks` entry is non-zero (0 there means air).
// ---------------------------------------------------------------------------
export const enum Mat {
  Dirt = 0,
  Wood = 1,
  Stone = 2,
  Reinforced = 3,
  Steel = 4,
  Core = 5,
  Bedrock = 6,
}

export interface MaterialDef {
  readonly name: string;
  readonly hp: number;
  /** Multiplier applied to incoming block damage. */
  readonly resist: number;
  /**
   * Spade swings needed to break an undamaged block of this material. The
   * spade works off this number rather than `hp` * `resist` so digging stays
   * tunable on its own: gunfire that softens a wall still shortens the dig,
   * but making steel tougher to shoot never silently makes it unmineable.
   */
  readonly digHits: number;
  readonly indestructible: boolean;
}

export const MATERIALS: readonly MaterialDef[] = [
  { name: 'Dirt', hp: 30, resist: 1.0, digHits: 2, indestructible: false },
  { name: 'Wood', hp: 60, resist: 0.85, digHits: 3, indestructible: false },
  { name: 'Stone', hp: 150, resist: 0.6, digHits: 5, indestructible: false },
  { name: 'Reinforced', hp: 400, resist: 0.4, digHits: 8, indestructible: false },
  { name: 'Steel', hp: 1000, resist: 0.25, digHits: 12, indestructible: false },
  { name: 'Core', hp: 6000, resist: 0.35, digHits: 20, indestructible: false },
  { name: 'Bedrock', hp: 1, resist: 0, digHits: 0, indestructible: true },
];

// ---------------------------------------------------------------------------
// Player physics. AoS integrates velocity in "ticks"; we keep the same shape
// but express it against real delta time so the feel survives at any framerate.
// ---------------------------------------------------------------------------
export const PHYS = {
  /** AoS multiplies velocity by 32 to reach world units. */
  velocityScale: 32,
  jumpImpulse: 0.36,
  gravity: 1.0,
  /** Ground friction coefficient (f = dt * k + 1; v /= f). */
  groundFriction: 4,
  waterFriction: 6,
  /** Horizontal accel multipliers, straight from AoS. */
  airControl: 0.1,
  crouchSpeed: 0.3,
  sneakSpeed: 0.5,
  sprintSpeed: 1.3,
  /**
   * AoS bleeds forward speed when you look steeply up or down: the penalty
   * ramps in past ~40 degrees and tops out at 90%.
   */
  vertLookSlowdownStart: 0.65,
  vertLookSlowdownMax: 0.9,
  /**
   * Mantling a 1-block lip costs horizontal speed (AoS `climb` halves it). We
   * charge far less than AoS did: on a staircase this lands on every single
   * step, and halving there turns a walk up into a stutter.
   */
  climbSpeedPenalty: 0.85,
  /** Landing speeds at which we slow down / start taking damage. */
  fallSlowDown: 0.24,
  fallDamageVelocity: 0.58,
  fallDamageScalar: 4096,

  /**
   * Footstep cadence. AoS accumulates `dist * 0.3` and steps at 1.0, so a
   * footstep lands every 1/0.3 world units travelled.
   */
  stepDistance: 1 / 0.3,

  // AoS hitbox: 0.9 wide, 2.7 tall standing (eye 2.25), 1.8 crouched (eye 1.35).
  playerRadius: 0.45,
  heightStand: 2.7,
  heightCrouch: 1.8,
  eyeStand: 2.25,
  eyeCrouch: 1.35,
  stepHeight: 1.0,
  /**
   * Stepping up a lip (and being pulled down onto one) moves the body a whole
   * block at once. The camera doesn't follow that instantly -- it keeps an
   * offset that decays at this rate, so stairs read as a climb rather than a
   * teleport. Higher is snappier; ~14 settles a full block in about a tenth
   * of a second.
   */
  stepSmoothRate: 14,
} as const;

/**
 * There is no health bar and there are no lives.
 *
 * What the player has is a punishment pool: every hit spends some of it, the
 * screen bleeds in from the edges as it empties, and it refills on its own
 * once nobody has landed anything for a few seconds. Break contact and you
 * recover; stay in the open and the next burst puts you down. The pool is
 * never shown as a number anywhere in the UI -- the vignette *is* the readout.
 */
export const VITALS = {
  /** Damage absorbed before you go down. 100 so upgrades read as percent. */
  pool: 100,
  /** Seconds of not being hit before the pool starts coming back. */
  regenDelay: 4.5,
  /** Pool per second once it is going -- a little over three seconds to full. */
  regenRate: 34,
  /** Seconds spent easing from nothing up to `regenRate`, so it starts gently. */
  regenRamp: 0.9,
  /** At or below this fraction of the pool the vignette pulses. */
  criticalAt: 0.35,
} as const;

export const PLAYER_MAX_HP: number = VITALS.pool;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
/**
 * AoS has no skybox: the background *is* the fog colour, so distant terrain
 * dissolves into the horizon instead of meeting a differently-coloured sky.
 */
const FOG_COLOR = 0x728ea7;

export const RENDER = {
  /** AoS `cg_fov` default, and it is a vertical FOV there too. */
  fov: 68,
  /** Extra FOV blended in while sprinting, as a speed cue. */
  sprintFov: 5,
  /** First-person weapon camera; narrower so the model doesn't fisheye. */
  vmFov: 55,
  adsFov: 45,
  near: 0.08,
  far: 320,
  /**
   * Horizontal view distance in blocks, past which everything is solid fog.
   *
   * AoS uses 128 (OpenSpades `GLRenderer::fogDistance`); this sits deliberately
   * well inside that for the jungle, where the air is the point. Note the curve
   * is quadratic and saturates *at* this distance, so haze is already heavy at
   * around 60% of it -- roughly 35 blocks here.
   *
   * This is a gameplay number as much as a visual one: worldgen puts the wave
   * spawn ring at 100 blocks, so anything under ~100 means attackers form up
   * inside the fog and emerge from it rather than being visible on approach.
   */
  fogDistance: 58,
  fogColor: FOG_COLOR,
  skyColor: FOG_COLOR,
  /** Dynamic-resolution bounds. */
  minScale: 0.55,
  maxScale: 1.0,
  targetFrameMs: 16.7,
} as const;
