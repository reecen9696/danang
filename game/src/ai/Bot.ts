import * as THREE from 'three';
import { WORLD_Y } from '../core/constants';
import type { VoxelWorld } from '../voxel/VoxelWorld';
import { BOTS, BotKind, BotRole, type BotDef } from './botTypes';
import { BlueprintId } from './blueprints';
import type { Squad } from './Squad';

export const enum BotState {
  /** No contact anywhere in the squad — follow the flow field to the objective. */
  Advance = 0,
  /** Squad has contact but this bot doesn't; close on the last known position. */
  Hunt = 1,
  /** Personal line of sight — fight, using cover and bounds. */
  Engage = 2,
  /** Working a wall voxel down. */
  Breach = 3,
  /** Placing a blueprint, block by block. */
  Build = 4,
  /** Executing a dig plan under or through an obstacle. */
  Tunnel = 5,
  /** Badly hurt — break contact, get behind something, come back. */
  Regroup = 6,
  Dying = 7,
}

/** Longest tunnel a bot will commit to, in voxels. */
export const MAX_TUNNEL = 28;

/**
 * Upper bound on the boxes drawn per bot, which is what the instanced mesh is
 * sized from. The render loop in BotManager must stay under it.
 */
export const BOT_PARTS = 24;

/** Hits kept on a body for drawing blood. Older ones are recycled. */
export const MAX_WOUNDS = 6;

/**
 * Joints that go slack when a bot dies. Each one is a spring chasing the pose
 * gravity wants it in, underdamped so limbs overshoot and wobble instead of
 * locking into place — which is the whole difference between a body going limp
 * and a plank tipping over.
 */
export const enum Joint {
  Head = 0,
  ArmLeft = 1,
  ArmRight = 2,
  LegLeft = 3,
  LegRight = 4,
}
export const JOINTS = 5;

/** How long a body lies on the ground before it's cleaned up, in seconds. */
export const CORPSE_LIFE = 10;
/** Seconds at the end of that during which the body sinks out of sight. */
export const CORPSE_SINK = 1.2;

/**
 * A single enemy. Plain fields only — the manager iterates these in a tight
 * loop every frame, so there's no per-bot Object3D or allocation involved.
 */
export class Bot {
  active = false;
  kind = BotKind.Grunt;
  def: BotDef = BOTS[0];

  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  yaw = 0;
  /** Yaw the bot is turning toward; `yaw` chases this so heads don't snap. */
  desiredYaw = 0;

  hp = 0;
  maxHp = 0;
  damageMultiplier = 1;

  state = BotState.Advance;
  grounded = false;

  // --- squad ---------------------------------------------------------------
  squad: Squad | null = null;
  role = BotRole.Assault;
  /** Which half of the squad's bounding alternation this bot moves on. */
  boundPhase = 0;

  // --- perception ----------------------------------------------------------
  /** Personal line of sight to the target, refreshed on a rotating schedule. */
  seesTarget = false;
  /** Seconds since this bot last had eyes on the target. */
  sightAge = 999;
  /** Seconds of unbroken sight, which is what settles the archetype's aim. */
  aimHeld = 0;
  /** Counts down after acquiring before the bot is allowed to shoot. */
  reactionTimer = 0;
  /** Smoothed aim point, so bots track rather than snap onto a moving player. */
  readonly aimPoint = new THREE.Vector3();
  aimValid = false;
  /** Cone half-angle the next shot scatters within, in radians. */
  aimSpread = 0.1;
  /** Firing at a last known position rather than a visible target. */
  suppressing = false;

  // --- combat --------------------------------------------------------------
  fireTimer = 0;
  burstLeft = 0;
  burstTimer = 0;
  /** Seconds of incoming fire recently taken; drives the flinch to cover. */
  pressure = 0;

  // --- movement ------------------------------------------------------------
  /** Deliberate destination (cover, flank waypoint); NaN-free, gated by the flag. */
  moveTargetX = 0;
  moveTargetZ = 0;
  hasMoveTarget = false;
  /** Seconds until this bot may look for a new position. */
  repositionTimer = 0;
  /** Time since the bot last improved its path cost; unsticks wedged bots. */
  stuckTimer = 0;
  lastProgressCost = 0x3fffffff;
  /** Separation push accumulated from squadmates this frame. */
  pushX = 0;
  pushZ = 0;

  // --- engineering ---------------------------------------------------------
  /** Voxel currently being torn down, or -1. */
  breachX = -1;
  breachY = -1;
  breachZ = -1;
  breachTimer = 0;

  buildId = BlueprintId.RampShort;
  buildOriginX = 0;
  buildOriginY = 0;
  buildOriginZ = 0;
  buildRot = 0;
  buildCursor = 0;
  buildTimer = 0;
  /** Gives up on a site that can't be finished (blown up mid-build, say). */
  buildPatience = 0;
  buildActive = false;

  /** Packed voxel indices for the current dig plan, in order. */
  readonly tunnelPlan = new Int32Array(MAX_TUNNEL * 3);
  tunnelLen = 0;
  tunnelCursor = 0;

  /** Seconds before this bot may start another construction job. */
  buildCooldown = 0;

  // --- cover ---------------------------------------------------------------
  /** Settled behind something solid: hold this ground and fight from it. */
  inCover = false;
  /** Seconds of cover left before the bot gives it up and moves on. */
  coverTimer = 0;
  /** Quality of the spot being held: 1 = fully hidden, 2 = can shoot over it. */
  coverQuality = 0;
  /** 0 = standing, 1 = fully ducked behind the parapet. */
  crouch = 0;
  /** What `crouch` is easing toward; peeking flips this between bursts. */
  crouchTarget = 0;

  // --- presentation --------------------------------------------------------
  /** Seconds the body has left before it's cleaned up. */
  deathTimer = 0;
  hitFlash = 0;
  /**
   * Where this bot has been hit, in its own frame: x, y, z, strength per
   * wound. Blood is drawn on whatever box is nearest one of these, so it lands
   * on the part the round actually went through and rides the body down onto
   * the ground — and it stays keyed to the model rather than to a part index,
   * which changes whenever the model does.
   */
  readonly wounds = new Float32Array(MAX_WOUNDS * 4);
  woundCount = 0;
  /** Ring cursor: the seventh hit overwrites the first. */
  private woundCursor = 0;

  // --- ragdoll -------------------------------------------------------------
  /** How far the body has toppled from upright, in radians. PI/2 is flat. */
  fallPitch = 0;
  fallPitchVel = 0;
  /**
   * Roll about the direction of the fall. A body that lands square on its face
   * every time reads as a felled tree, so each one goes down onto a shoulder or
   * onto its back instead.
   */
  fallRoll = 0;
  fallRollVel = 0;
  /** The side it ends up rolled onto, drawn once when it goes down. */
  fallRollRest = 0;
  /**
   * How far the legs have given way, 0..1. The knees go first — a dead man
   * drops before he topples, he doesn't pivot on his heels.
   */
  collapse = 0;
  collapseVel = 0;
  /** Current slack angle of each joint, and the rate it's moving at. */
  readonly joints = new Float32Array(JOINTS);
  readonly jointVel = new Float32Array(JOINTS);
  /** Where each joint ends up once everything has stopped moving. */
  readonly jointRest = new Float32Array(JOINTS);
  /** How wide the arms and legs finish up splayed, 0..1 each. */
  sprawlArm = 0;
  sprawlLeg = 0;
  /** How far the hat has come off, 0..1. It's knocked clear by the hit. */
  hatFall = 0;
  /** Extra spin on the hat as it tumbles, so it doesn't land square. */
  hatSpin = 0;
  /** Horizontal direction the body topples toward, from the killing shot. */
  fallDirX = 0;
  fallDirZ = 1;
  /** Horizontal drift the impact gave the body, in blocks/sec. */
  slideX = 0;
  slideZ = 0;
  /** True once the body has stopped moving; it's pure decoration from then on. */
  settled = false;

  /**
   * Walk cycle, advanced by ground covered rather than by time — the same
   * distance-driven gait OpenSpades uses, so a bot slowing down takes shorter
   * steps instead of moonwalking.
   */
  walkPhase = 0;
  /** Horizontal speed over the last frame, in blocks/sec. Smoothed. */
  moveSpeed = 0;
  /** Free-running per-bot clock for animations that aren't gait-driven. */
  animTime = 0;
  /** Elevation of the aim line, for pitching the arms and head onto the target. */
  aimPitch = 0;

  /** Small per-bot jitter so a wave doesn't move in lockstep. */
  phase = 0;
  strafeBias = 1;

  // --- voice ---------------------------------------------------------------
  /** Which of the recorded takes this bot speaks with, for its whole life. */
  voice = 0;
  /**
   * Playback rate for that take. Two actors have to cover a whole horde, so
   * each bot is shifted a little — enough to read as a different man, not
   * enough to sound like a chipmunk.
   */
  voicePitch = 1;
  /** Seconds before this bot may say anything again. */
  voiceTimer = 0;

  spawn(kind: BotKind, x: number, y: number, z: number, hpMul: number, dmgMul: number, rand: () => number): void {
    this.kind = kind;
    this.def = BOTS[kind];
    this.active = true;
    this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.maxHp = Math.round(this.def.hp * hpMul);
    this.hp = this.maxHp;
    this.damageMultiplier = dmgMul;

    this.state = BotState.Advance;
    this.squad = null;
    this.role = this.def.role;
    this.boundPhase = 0;

    this.seesTarget = false;
    this.sightAge = 999;
    this.aimHeld = 0;
    this.reactionTimer = 0;
    this.aimValid = false;
    this.aimPoint.set(x, y, z);

    this.fireTimer = rand() * this.def.fireInterval;
    this.burstLeft = 0;
    this.burstTimer = 0;
    this.pressure = 0;

    this.hasMoveTarget = false;
    this.repositionTimer = rand() * 1.5;
    this.stuckTimer = 0;
    this.lastProgressCost = 0x3fffffff;
    this.pushX = 0;
    this.pushZ = 0;

    this.breachX = -1;
    this.breachTimer = 0;
    this.buildCursor = 0;
    this.buildTimer = 0;
    this.buildPatience = 0;
    this.buildActive = false;
    this.aimSpread = 0.1;
    this.suppressing = false;
    this.buildCooldown = rand() * 2;
    this.tunnelLen = 0;
    this.tunnelCursor = 0;

    this.inCover = false;
    this.coverTimer = 0;
    this.coverQuality = 0;
    this.crouch = 0;
    this.crouchTarget = 0;

    this.deathTimer = 0;
    this.hitFlash = 0;
    this.wounds.fill(0);
    this.woundCount = 0;
    this.woundCursor = 0;
    this.fallPitch = 0;
    this.fallPitchVel = 0;
    this.fallRoll = 0;
    this.fallRollVel = 0;
    this.fallRollRest = 0;
    this.collapse = 0;
    this.collapseVel = 0;
    this.joints.fill(0);
    this.jointVel.fill(0);
    this.jointRest.fill(0);
    this.hatFall = 0;
    this.hatSpin = 0;
    this.fallDirX = 0;
    this.fallDirZ = 1;
    this.slideX = 0;
    this.slideZ = 0;
    this.settled = false;
    this.walkPhase = rand() * Math.PI * 2;
    this.moveSpeed = 0;
    this.animTime = rand() * 10;
    this.aimPitch = 0;
    this.phase = rand() * Math.PI * 2;
    this.strafeBias = rand() < 0.5 ? -1 : 1;
    this.assignVoice(rand);
    this.yaw = rand() * Math.PI * 2;
    this.desiredYaw = this.yaw;
    this.grounded = false;
  }

  /** Picks the take and pitch this bot speaks with. */
  assignVoice(rand: () => number): void {
    this.voice = rand() < 0.5 ? 0 : 1;
    this.voicePitch = 0.93 + rand() * 0.14;
    this.voiceTimer = rand() * 4;
  }

  /**
   * Standing height less whatever the bot has ducked away. Everything that
   * cares where the body actually is — sight lines, incoming bullets, hit
   * zones — measures against this, so a bot hiding behind a wall is genuinely
   * harder to see and harder to hit, not just drawn smaller.
   */
  get poseHeight(): number {
    return this.def.height * (1 - 0.34 * this.crouch);
  }

  get eyeY(): number {
    return this.position.y + this.poseHeight * 0.82;
  }

  /** Chest height — what cover has to hide for the bot to be safe behind it. */
  get chestY(): number {
    return this.position.y + this.poseHeight * 0.55;
  }

  get alive(): boolean {
    return this.active && this.state !== BotState.Dying;
  }

  get hurt(): boolean {
    return this.hp < this.maxHp * 0.32;
  }

  /** True while the bot is standing still doing engineering work. */
  get working(): boolean {
    return this.state === BotState.Breach || this.state === BotState.Build;
  }

  /**
   * Records where a round went through, in the bot's own frame.
   *
   * Storing it un-rotated means the blood stays on the same patch of the body
   * as it turns, and the render loop can find it without knowing anything
   * about which box is which.
   */
  wound(hx: number, hy: number, hz: number, amount: number): void {
    const dx = hx - this.position.x;
    const dz = hz - this.position.z;
    // Inverse of the yaw the body is drawn with.
    const c = Math.cos(this.yaw);
    const sn = Math.sin(this.yaw);
    const i = this.woundCursor * 4;
    this.wounds[i] = dx * c - dz * sn;
    this.wounds[i + 1] = hy - this.position.y;
    this.wounds[i + 2] = dx * sn + dz * c;
    this.wounds[i + 3] = Math.min(1.4, this.wounds[i + 3] * 0.5 + amount);
    this.woundCursor = (this.woundCursor + 1) % MAX_WOUNDS;
    if (this.woundCount < MAX_WOUNDS) this.woundCount++;
  }

  /**
   * Starts the death fall.
   *
   * `dirX`/`dirZ` is the horizontal direction the killing shot was travelling.
   * The body goes over that way and every joint goes slack at once: the legs
   * fold, the arms and head are left behind by the fall, and where each limb
   * finishes is drawn per bot so no two men land the same way.
   */
  startRagdoll(dirX: number, dirZ: number, force: number, rand: () => number): void {
    const len = Math.hypot(dirX, dirZ);
    if (len > 1e-4) {
      this.fallDirX = dirX / len;
      this.fallDirZ = dirZ / len;
    } else {
      // Nothing directional about it — drop the body over its own toes.
      this.fallDirX = Math.sin(this.yaw);
      this.fallDirZ = Math.cos(this.yaw);
    }
    this.fallPitch = 0;
    // Enough angular speed that the fall reads as a fall, not a slow wilt.
    this.fallPitchVel = 1.1 + rand() * 0.9 + force * 0.7;
    this.fallRoll = 0;
    this.fallRollVel = (rand() - 0.5) * 2.6;
    this.fallRollRest = (this.fallRollVel < 0 ? -1 : 1) * (0.35 + rand() * 0.4);
    this.collapse = 0;
    this.collapseVel = 3 + rand() * 3;

    // Arms are thrown by the fall and land wherever they end up, each one
    // independent of the other. Legs fold under and splay.
    this.jointRest[Joint.Head] = 0.3 + rand() * 0.55;
    this.jointRest[Joint.ArmLeft] = -0.5 - rand() * 1.5;
    this.jointRest[Joint.ArmRight] = -0.4 - rand() * 1.6;
    this.jointRest[Joint.LegLeft] = 0.15 + rand() * 0.5;
    this.jointRest[Joint.LegRight] = -0.1 - rand() * 0.55;
    for (let i = 0; i < JOINTS; i++) {
      // A shove from the round itself, so the limbs are already moving.
      this.jointVel[i] = (rand() - 0.5) * 3 * force;
    }
    this.sprawlArm = 0.4 + rand() * 0.6;
    this.sprawlLeg = 0.3 + rand() * 0.7;
    this.hatFall = 0;
    this.hatSpin = (rand() - 0.5) * 4;

    const slide = (1.1 + rand() * 1.3) * force;
    this.slideX = this.fallDirX * slide;
    this.slideZ = this.fallDirZ * slide;
    this.velocity.set(0, this.velocity.y, 0);
    this.settled = false;
  }

  clearJobs(): void {
    this.breachX = -1;
    this.buildCursor = 0;
    this.buildPatience = 0;
    this.buildActive = false;
    this.tunnelLen = 0;
    this.tunnelCursor = 0;
  }
}

/**
 * Finds a standing surface for a bot at column (x, z), searching near `yHint`.
 * Returns -1 when there's nowhere to stand within the allowed drop.
 */
export function findStandingY(
  world: VoxelWorld,
  x: number,
  z: number,
  yHint: number,
  stepUp: number,
  maxDrop: number,
): number {
  const top = Math.min(WORLD_Y - 3, Math.floor(yHint + stepUp));
  const bottom = Math.max(0, Math.floor(yHint - maxDrop));
  for (let y = top; y >= bottom; y--) {
    if (!world.isSolid(x, y - 1, z)) continue;
    if (world.isSolid(x, y, z)) continue;
    if (world.isSolid(x, y + 1, z)) continue;
    return y;
  }
  return -1;
}

/** First solid voxel obstructing a bot's body at (x, z), or -1. */
export function blockingVoxel(world: VoxelWorld, x: number, footY: number, z: number): number {
  for (let dy = 0; dy < 3; dy++) {
    const y = footY + dy;
    if (y >= WORLD_Y) break;
    if (world.isSolid(x, y, z)) return y;
  }
  return -1;
}
