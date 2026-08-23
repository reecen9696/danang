import * as THREE from 'three';
import type { VoxelWorld } from '../voxel/VoxelWorld';
import type { NavGrid } from './NavGrid';
import { UNREACHABLE } from './NavGrid';
import {
  Bot, BotState, Joint, JOINTS, MAX_TUNNEL, BOT_PARTS, CORPSE_LIFE, CORPSE_SINK,
  findStandingY, blockingVoxel,
} from './Bot';
import { BotKind, BotRole, type BotDef } from './botTypes';
import { SquadManager, CONTACT_MEMORY } from './Squad';
import {
  BLUEPRINTS, BlueprintId, evaluateSite, rotateX, rotateZ, rotationToward,
  forwardX, forwardZ,
} from './blueprints';
import { findCoverSpot, rateCover, type CoverSpot } from './cover';
import { hasLineOfSight } from '../voxel/raycast';
import { WORLD_X, WORLD_Z, WORLD_Y, WATER_LEVEL, MATERIALS, Mat } from '../core/constants';
import { AIR } from '../voxel/palette';
import { WeaponId } from '../weapons/definitions';
import { VoiceCue } from '../audio/cues';

export const MAX_BOTS = 72;
const PARTS = BOT_PARTS;

/** Wet blood, for the stains a round leaves on a body. */
const BLOOD = 0x7c0d0d;

/** Frames between a bot's line-of-sight checks. */
const SIGHT_STRIDE = 3;
/** Cover searches allowed per frame across the whole horde. */
const COVER_BUDGET = 3;
/** How far ahead of itself a bot probes for walls, past its own radius. */
const PROBE_AHEAD = 0.7;
/** Shoulder rotation that brings the arms forward into a weapon carry. */
const CARRY = -1.22;
/** Radians of walk cycle per block covered — one full stride every ~3 blocks. */
const STRIDE = 2.1;
/** Thickest wall a bot will consider boring through rather than going around. */
const MAX_BORE = 8;

/**
 * Where a round went through a bot and which way it was travelling. Drives the
 * blood on the body and, for a killing shot, which way the body goes over.
 */
export interface BotImpact {
  x: number;
  y: number;
  z: number;
  dirX: number;
  dirZ: number;
  /** Scales the knock-down: 1 for a rifle round, more for a blast. */
  force: number;
}

export interface BotWorldContext {
  world: VoxelWorld;
  nav: NavGrid;
  playerPos: THREE.Vector3;
  playerVel: THREE.Vector3;
  playerEyeY: number;
  playerAlive: boolean;
  /** Where bots head when they have no contact. */
  objective: THREE.Vector3;
  /** Bot wants to shoot at the given world point. */
  onFire: (bot: Bot, tx: number, ty: number, tz: number) => void;
  /** Bot is tearing at a voxel. */
  onBreach: (bot: Bot, x: number, y: number, z: number) => void;
  /** Bot wants to place a blueprint block. False means the placement was refused. */
  onBuild: (bot: Bot, x: number, y: number, z: number, color: number, material: Mat) => boolean;
  onDeath: (bot: Bot) => void;
  /**
   * A body has finished falling and come to rest. Optional: the server runs
   * this simulation too and has no use for the presentation hooks.
   */
  onCorpseRest?: (bot: Bot) => void;
  /**
   * Bot wants to say something. Whether it actually gets to is the audio
   * director's call — see audio/Voices.ts — so this is a request, not an event.
   */
  onVoice: (bot: Bot, cue: VoiceCue) => void;
}

const flowOut = new Float32Array(2);
const coverOut: CoverSpot = { x: 0, y: 0, z: 0, quality: 0 };
const tmpMatrix = new THREE.Matrix4();
const tmpQuat = new THREE.Quaternion();
const tmpEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const tmpPos = new THREE.Vector3();
const tmpScale = new THREE.Vector3();
const tmpColor = new THREE.Color();
const partQuat = new THREE.Quaternion();
const pitchQuat = new THREE.Quaternion();
const AXIS_X = new THREE.Vector3(1, 0, 0);
/** x, y, z, sx, sy, sz, colour, pitch, pivot y, pivot z — all bot-local. */
type Part = [
  number, number, number, number, number, number, number, number, number, number,
];
const EYE = 0x14110e;
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const HALF_PI = Math.PI * 0.5;
const fallAxis = new THREE.Vector3();
const rollAxis = new THREE.Vector3();
const yawQuat = new THREE.Quaternion();
const rollQuat = new THREE.Quaternion();
const hatQuat = new THREE.Quaternion();
const flatQuat = new THREE.Quaternion();
const hatPos = new THREE.Vector3();

/** Multiplies each channel of a packed RGB colour, for cheap shading. */
function shade(hex: number, f: number): number {
  const r = Math.min(255, Math.round(((hex >> 16) & 0xff) * f));
  const g = Math.min(255, Math.round(((hex >> 8) & 0xff) * f));
  const b = Math.min(255, Math.round((hex & 0xff) * f));
  return (r << 16) | (g << 8) | b;
}

/** Blends two packed RGB colours. */
function mixHex(a: number, b: number, t: number): number {
  const k = Math.max(0, Math.min(1, t));
  const r = Math.round(((a >> 16) & 0xff) + (((b >> 16) & 0xff) - ((a >> 16) & 0xff)) * k);
  const g = Math.round(((a >> 8) & 0xff) + (((b >> 8) & 0xff) - ((a >> 8) & 0xff)) * k);
  const bl = Math.round((a & 0xff) + ((b & 0xff) - (a & 0xff)) * k);
  return (r << 16) | (g << 8) | bl;
}

/** Muzzle velocity used to lead a target, or 0 for hitscan weapons. */
function projectileSpeed(weapon: WeaponId): number {
  switch (weapon) {
    case WeaponId.Rocket: return 38;
    case WeaponId.Grenade: return 22;
    default: return 0;
  }
}

function shortestAngle(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * Pools, simulates and renders every enemy.
 *
 * The horde is organised into squads (see Squad.ts) rather than being a bag of
 * independent actors: sightings are shared, half of a squad shoots while the
 * other half moves, and engineering work is pointed at one spot so a wall
 * actually comes down. Individual bots layer cover-seeking and range discipline
 * on top of that.
 *
 * Expensive work is amortised — each bot checks line of sight every few frames,
 * and cover searches are rationed across the whole horde per frame — so cost
 * stays flat as the wave count climbs.
 *
 * All bots share a single InstancedMesh (four boxes each), so the entire horde
 * costs one draw call regardless of count.
 */
export class BotManager {
  readonly mesh: THREE.InstancedMesh;
  readonly bots: Bot[] = [];
  readonly squads = new SquadManager();

  private aliveCount = 0;
  private tickCursor = 0;
  private coverBudget = COVER_BUDGET;
  private rand: () => number;

  constructor(private readonly ctx: BotWorldContext, rand: () => number = Math.random) {
    this.rand = rand;
    for (let i = 0; i < MAX_BOTS; i++) this.bots.push(new Bot());

    const geom = new THREE.BoxGeometry(1, 1, 1);
    // Lit like the terrain, so an enemy stepping out of a doorway visibly
    // brightens instead of staying a flat silhouette.
    const mat = new THREE.MeshLambertMaterial({ vertexColors: false, fog: true });
    this.mesh = new THREE.InstancedMesh(geom, mat, MAX_BOTS * PARTS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    // One instanced draw covers the whole horde in the shadow pass too, so
    // every enemy throwing a shadow costs a single extra call.
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;

    const colors = new Float32Array(MAX_BOTS * PARTS * 3);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  }

  get count(): number {
    return this.aliveCount;
  }

  /** Number of bots still alive (excludes bodies playing their death fall). */
  get livingCount(): number {
    let n = 0;
    for (const b of this.bots) if (b.alive) n++;
    return n;
  }

  get squadCount(): number {
    return this.squads.squads.length;
  }

  /**
   * Spawns a bot, snapping it to somewhere it can actually stand.
   *
   * Spawn points are jittered, so the requested column is often not the one the
   * caller measured the ground on — dropping a bot into the side of a hill
   * leaves it buried, with no standing position at any height, falling through
   * the map. Returns null when there's nowhere nearby to put it, which lets the
   * wave manager simply try again next tick.
   */
  spawn(kind: BotKind, x: number, _y: number, z: number, hpMul: number, dmgMul: number): Bot | null {
    let slot: Bot | null = null;
    let recycled = false;
    for (const b of this.bots) {
      if (b.active) continue;
      slot = b;
      break;
    }
    if (slot === null) {
      // Bodies hold their slot for a while after they fall, so a heavy wave
      // can find the pool full of corpses. Clear out the one closest to
      // vanishing rather than refusing to spawn.
      let oldest = Infinity;
      for (const b of this.bots) {
        if (b.alive || b.deathTimer >= oldest) continue;
        oldest = b.deathTimer;
        slot = b;
      }
      if (slot === null) return null;
      recycled = true;
    }

    const world = this.ctx.world;
    const cx = Math.floor(x);
    const cz = Math.floor(z);
    for (let r = 0; r <= 3; r++) {
      for (let oz = -r; oz <= r; oz++) {
        for (let ox = -r; ox <= r; ox++) {
          // Ring walk: only the newly reached edge at each radius.
          if (r > 0 && Math.abs(ox) !== r && Math.abs(oz) !== r) continue;
          const fx = cx + ox;
          const fz = cz + oz;
          if (fx < 3 || fz < 3 || fx >= WORLD_X - 3 || fz >= WORLD_Z - 3) continue;
          const standY = findStandingY(world, fx, fz, world.surfaceHeight(fx, fz), 1, 3);
          if (standY < 0) continue;
          // The body that was in this slot is gone; it was counted as active.
          if (recycled) this.aliveCount--;
          slot.spawn(kind, fx + 0.5, standY, fz + 0.5, hpMul, dmgMul, this.rand);
          this.squads.enlist(slot);
          this.aliveCount++;
          return slot;
        }
      }
    }
    return null;
  }

  clear(): void {
    for (const b of this.bots) b.active = false;
    this.squads.clear();
    this.aliveCount = 0;
    this.mesh.count = 0;
  }

  /**
   * Applies damage and returns true if this killed the bot.
   *
   * Being hit is also information: a bot that takes a round it never saw coming
   * still knows roughly where it came from, and tells its squad. Sniping from
   * cover pulls a fireteam onto you rather than being free.
   */
  damage(bot: Bot, amount: number, impact?: BotImpact): boolean {
    if (!bot.alive) return false;
    bot.hp -= amount;
    bot.hitFlash = 0.14;
    bot.pressure = Math.min(3, bot.pressure + 0.9);
    if (impact) {
      // Bloody the spot the round went through, harder for a heavier hit, and
      // harder again for the one that puts him down.
      const fatal = bot.hp <= 0;
      bot.wound(impact.x, impact.y, impact.z, 0.4 + Math.min(0.5, amount / 90) + (fatal ? 0.5 : 0));
    }

    const ctx = this.ctx;
    if (ctx.playerAlive && bot.squad !== null && !bot.squad.hasContact) {
      bot.squad.report(ctx.playerPos.x, ctx.playerEyeY, ctx.playerPos.z);
      // Second-hand intel, so don't let it masquerade as a live sighting.
      bot.squad.contactAge = CONTACT_MEMORY * 0.5;
    }

    if (bot.hp <= 0) {
      bot.hp = 0;
      bot.state = BotState.Dying;
      bot.clearJobs();
      bot.deathTimer = CORPSE_LIFE;
      bot.startRagdoll(
        impact ? impact.dirX : 0,
        impact ? impact.dirZ : 0,
        impact ? impact.force : 1,
        this.rand,
      );
      this.ctx.onDeath(bot);
      return true;
    }
    ctx.onVoice(bot, VoiceCue.Hurt);
    return false;
  }

  // -------------------------------------------------------------------------
  // Bodies
  // -------------------------------------------------------------------------
  /**
   * Runs a dead bot's ragdoll: it topples the way the shot pushed it, slides a
   * little, falls if the ground under it isn't there, then lies where it
   * landed for the rest of `deathTimer` before sinking out of sight.
   */
  private updateCorpse(bot: Bot, dt: number): void {
    bot.deathTimer -= dt;
    if (bot.deathTimer <= 0) {
      bot.active = false;
      this.aliveCount--;
      return;
    }
    if (bot.hitFlash > 0) bot.hitFlash = Math.max(0, bot.hitFlash - dt);
    if (bot.settled) {
      // Dig the floor out from under a body and it should drop, not hang.
      const world = this.ctx.world;
      if (!world.isSolid(
        Math.floor(bot.position.x), Math.floor(bot.position.y - 0.5), Math.floor(bot.position.z),
      )) {
        bot.settled = false;
      }
      return;
    }

    const step = Math.min(dt, 0.05);
    this.animateCorpse(bot, step);

    // Slide, but never into a wall: a body shoved at a parapet piles up
    // against it rather than sinking halfway through.
    if (bot.slideX !== 0 || bot.slideZ !== 0) {
      const world = this.ctx.world;
      const nx = bot.position.x + bot.slideX * step;
      const nz = bot.position.z + bot.slideZ * step;
      const fy = Math.floor(bot.position.y + 0.2);
      if (!world.isSolid(Math.floor(nx), fy, Math.floor(bot.position.z))) bot.position.x = nx;
      else bot.slideX = 0;
      if (!world.isSolid(Math.floor(bot.position.x), fy, Math.floor(nz))) bot.position.z = nz;
      else bot.slideZ = 0;
      const damp = 1 - Math.min(0.9, 4.5 * step);
      bot.slideX *= damp;
      bot.slideZ *= damp;
      if (Math.abs(bot.slideX) < 0.05 && Math.abs(bot.slideZ) < 0.05) {
        bot.slideX = 0;
        bot.slideZ = 0;
      }
    }

    // Bodies still obey gravity, so digging the floor out from under one drops
    // it rather than leaving it hanging in the air.
    this.applyPhysics(bot, dt);
    if (bot.position.y < -4) {
      bot.active = false;
      this.aliveCount--;
      return;
    }

    if (bot.grounded && bot.slideX === 0 && bot.slideZ === 0 && this.corpseIsStill(bot)) {
      bot.fallPitch = HALF_PI;
      bot.fallPitchVel = 0;
      bot.settled = true;
      this.ctx.onCorpseRest?.(bot);
    }
  }

  /**
   * Advances the ragdoll: the topple, the roll, the legs folding, and every
   * slack joint.
   *
   * Each joint is an underdamped spring chasing the pose the fall is dragging
   * it toward, so limbs trail behind the body on the way down and wobble when
   * it lands rather than arriving in formation. Nothing here touches where the
   * body is — multiplayer clients call this directly, taking the position from
   * the server and running the fall locally at frame rate.
   */
  animateCorpse(bot: Bot, dt: number): void {
    if (bot.settled) return;
    const rand = this.rand;

    // The knees go first, which is what drops a body rather than tipping it.
    bot.collapseVel += ((1 - bot.collapse) * 70 - bot.collapseVel * 11) * dt;
    bot.collapse = Math.max(0, Math.min(1, bot.collapse + bot.collapseVel * dt));

    // Constant angular acceleration about the axis the shot knocked it over.
    const wasDown = bot.fallPitch >= HALF_PI;
    bot.fallPitchVel += 7.5 * dt;
    bot.fallPitch += bot.fallPitchVel * dt;
    if (bot.fallPitch >= HALF_PI) {
      bot.fallPitch = HALF_PI;
      if (!wasDown) {
        // It hits the ground: everything loose gets thrown about by the impact.
        for (let i = 0; i < JOINTS; i++) bot.jointVel[i] += (rand() - 0.5) * 7;
        bot.fallRollVel += (rand() - 0.5) * 3;
      }
      // Bodies land heavily and mostly stay put; a fast fall gets one bounce.
      bot.fallPitchVel = bot.fallPitchVel > 1.4 ? -bot.fallPitchVel * 0.22 : 0;
    } else if (bot.fallPitch < 0) {
      bot.fallPitch = 0;
      bot.fallPitchVel = 0;
    }

    // How far through the fall we are; the slack pose is dragged in by it.
    const t = bot.fallPitch / HALF_PI;

    // Roll settles onto whichever side it was already turning toward.
    const rollRest = bot.fallRollRest * t;
    bot.fallRollVel += ((rollRest - bot.fallRoll) * 26 - bot.fallRollVel * 5) * dt;
    bot.fallRoll += bot.fallRollVel * dt;

    for (let i = 0; i < JOINTS; i++) {
      const target = bot.jointRest[i] * t;
      bot.jointVel[i] += ((target - bot.joints[i]) * 55 - bot.jointVel[i] * 6.5) * dt;
      bot.joints[i] += bot.jointVel[i] * dt;
    }

    // The hat is knocked clear by the hit and tumbles away on its own.
    if (bot.hatFall < 1) bot.hatFall = Math.min(1, bot.hatFall + dt * 1.7);
  }

  /** True once the fall has run out of energy and the body is just lying there. */
  private corpseIsStill(bot: Bot): boolean {
    if (bot.fallPitch < HALF_PI - 1e-3 || Math.abs(bot.fallPitchVel) >= 0.9) return false;
    if (Math.abs(bot.fallRollVel) >= 0.35) return false;
    for (let i = 0; i < JOINTS; i++) {
      if (Math.abs(bot.jointVel[i]) >= 0.4) return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------
  update(dt: number): void {
    const ctx = this.ctx;
    this.squads.update(dt);
    this.coverBudget = COVER_BUDGET;
    this.tickCursor = (this.tickCursor + 1) % SIGHT_STRIDE;
    this.computeSeparation();

    const px = ctx.playerPos.x;
    const py = ctx.playerEyeY;
    const pz = ctx.playerPos.z;

    for (let i = 0; i < this.bots.length; i++) {
      const bot = this.bots[i];
      if (!bot.active) continue;

      if (bot.state === BotState.Dying) {
        this.updateCorpse(bot, dt);
        continue;
      }

      if (bot.hitFlash > 0) bot.hitFlash = Math.max(0, bot.hitFlash - dt);
      bot.pressure = Math.max(0, bot.pressure - dt * 0.55);
      bot.voiceTimer -= dt;
      bot.repositionTimer -= dt;
      bot.buildCooldown -= dt;
      // Cover is a lease, not a home: it runs out and the bot moves up again.
      if (bot.inCover) {
        bot.coverTimer -= dt;
        if (bot.coverTimer <= 0) bot.inCover = false;
      }
      // Stand by default; only a bot settled behind a parapet asks to duck.
      bot.crouchTarget = 0;

      // Movement is applied straight to `position` by tryMove, so the gait is
      // measured from where the bot actually ended up rather than from a
      // velocity it never stores.
      const wasX = bot.position.x;
      const wasZ = bot.position.z;

      this.perceive(bot, dt, i, px, py, pz);
      this.decide(bot);
      this.chatter(bot);
      this.act(bot, dt, px, py, pz);
      this.applyPhysics(bot, dt);

      this.animate(bot, dt, wasX, wasZ);

      // Turn toward what we're doing rather than snapping.
      bot.yaw += shortestAngle(bot.yaw, bot.desiredYaw) * Math.min(1, dt * 9);
    }

    this.syncInstances();
  }

  /**
   * Advances the gait and settles the crouch. Nothing here feeds back into the
   * simulation except `crouch`, which shortens the bot — a ducked bot really is
   * behind the wall as far as sight lines and bullets are concerned.
   *
   * Public because the multiplayer client doesn't run this simulation at all:
   * it eases bots toward server snapshots and has to drive the walk cycle off
   * that motion itself, or the whole horde slides around with frozen legs.
   */
  animate(bot: Bot, dt: number, wasX: number, wasZ: number): void {
    bot.animTime += dt;

    const moved = Math.hypot(bot.position.x - wasX, bot.position.z - wasZ);
    const speed = dt > 1e-5 ? moved / dt : 0;
    // Smoothed so a bot clipping a corner for one frame doesn't stutter.
    bot.moveSpeed += (speed - bot.moveSpeed) * Math.min(1, dt * 12);
    bot.walkPhase += moved * STRIDE;
    if (bot.walkPhase > Math.PI * 2) bot.walkPhase -= Math.PI * 2;

    // Ease the crouch rather than snapping, so peeking reads as a movement.
    const rate = bot.crouchTarget > bot.crouch ? 7 : 5.5;
    bot.crouch += (bot.crouchTarget - bot.crouch) * Math.min(1, dt * rate);

    // Aim line elevation, for pitching the arms and head onto the target.
    if (bot.aimValid) {
      const dx = bot.aimPoint.x - bot.position.x;
      const dz = bot.aimPoint.z - bot.position.z;
      const dy = bot.aimPoint.y - bot.eyeY;
      const want = Math.atan2(dy, Math.max(0.25, Math.hypot(dx, dz)));
      bot.aimPitch += (want - bot.aimPitch) * Math.min(1, dt * 8);
    } else {
      bot.aimPitch += (0 - bot.aimPitch) * Math.min(1, dt * 4);
    }
  }

  // -------------------------------------------------------------------------
  // Perception
  // -------------------------------------------------------------------------
  private perceive(bot: Bot, dt: number, index: number, px: number, py: number, pz: number): void {
    const ctx = this.ctx;
    const def = bot.def;
    bot.sightAge += dt;

    if (!ctx.playerAlive) {
      bot.seesTarget = false;
      bot.aimHeld = 0;
      return;
    }

    const dist = Math.hypot(px - bot.position.x, pz - bot.position.z);
    // Bots notice you further out than they'll shoot, so they can start moving.
    if (dist > def.maxRange + 14) {
      bot.seesTarget = false;
      bot.aimHeld = 0;
      return;
    }

    if (index % SIGHT_STRIDE === this.tickCursor) {
      const saw = bot.seesTarget;
      bot.seesTarget = hasLineOfSight(
        ctx.world, bot.position.x, bot.eyeY, bot.position.z, px, py, pz,
      );
      if (bot.seesTarget) {
        if (!saw) {
          // Fresh contact: the archetype's reaction time has to run out first.
          bot.reactionTimer = def.reaction * (0.7 + this.rand() * 0.6);
          bot.aimHeld = 0;
          bot.aimPoint.set(px, py, pz);
          ctx.onVoice(bot, VoiceCue.Contact);
        }
        bot.sightAge = 0;
        bot.squad?.report(px, py, pz);
      }
    }

    if (bot.seesTarget) bot.aimHeld += dt;
    else bot.aimHeld = 0;
  }

  // -------------------------------------------------------------------------
  // Decision
  // -------------------------------------------------------------------------
  private decide(bot: Bot): void {
    const squad = bot.squad;

    // Engineering jobs run to completion — a half-dug hole or half-built ramp
    // helps nobody, so only death or the job finishing interrupts them.
    if (bot.state === BotState.Build && bot.buildActive) return;
    if (bot.state === BotState.Tunnel && bot.tunnelCursor < bot.tunnelLen) return;
    if (bot.state === BotState.Breach && bot.breachX >= 0) {
      // Line of sight to the target means the wall isn't between us any more —
      // dedicated breachers stay on the job, everyone else turns and fights.
      const stayOnWall = !bot.seesTarget || bot.role === BotRole.Breacher || bot.def.sapper;
      if (stayOnWall && this.ctx.world.isSolid(bot.breachX, bot.breachY, bot.breachZ)) return;
      bot.breachX = -1;
      squad?.clearBreach();
    }

    // Badly hurt: break contact and get behind something. Heavies don't flinch.
    const stubborn = bot.kind === BotKind.Tank || bot.kind === BotKind.Boss;
    if (bot.hurt && !stubborn && bot.pressure > 0.4) {
      bot.state = BotState.Regroup;
      return;
    }
    if (bot.state === BotState.Regroup && (!bot.hurt || bot.pressure <= 0)) {
      bot.hasMoveTarget = false;
    }

    if (bot.seesTarget) {
      bot.state = BotState.Engage;
      return;
    }
    // A bot ducked behind its cover can't see out — that's the point of ducking.
    // It stays in the fight on what it knew a moment ago instead of deciding
    // the target is gone and walking out from behind the wall to look.
    if (bot.inCover && bot.coverTimer > 0 && bot.sightAge < 3.5) {
      bot.state = BotState.Engage;
      return;
    }
    if (squad !== null && squad.hasContact) {
      bot.state = BotState.Hunt;
      return;
    }
    bot.state = BotState.Advance;
  }

  /**
   * Idle chatter, which is the half of this that isn't reactive: men walking
   * onto an objective talk to each other, and hearing that from behind a ridge
   * is the only warning you get before a squad comes over it.
   */
  private chatter(bot: Bot): void {
    if (bot.voiceTimer > 0) return;
    if (bot.state !== BotState.Advance && bot.state !== BotState.Hunt) return;
    this.ctx.onVoice(bot, VoiceCue.Advance);
  }

  // -------------------------------------------------------------------------
  // Action
  // -------------------------------------------------------------------------
  private act(bot: Bot, dt: number, px: number, py: number, pz: number): void {
    switch (bot.state) {
      case BotState.Build:
        this.buildTick(bot, dt);
        break;
      case BotState.Tunnel:
        this.tunnelTick(bot, dt);
        break;
      case BotState.Breach:
        this.breachTick(bot, dt);
        break;
      case BotState.Engage:
        this.engage(bot, dt, px, py, pz);
        break;
      case BotState.Hunt:
        this.hunt(bot, dt);
        break;
      case BotState.Regroup:
        this.regroup(bot, dt, px, py, pz);
        break;
      default:
        this.advance(bot, dt);
        break;
    }

    this.updateAim(bot, dt, px, py, pz);
    this.shoot(bot, dt, px, pz);
  }

  // --- travel ---------------------------------------------------------------
  /** No contact: walk the flow field to the objective, dealing with what's in the way. */
  private advance(bot: Bot, dt: number): void {
    const nav = this.ctx.nav;
    const reachable = nav.sample(bot.position.x, bot.position.z, flowOut);

    let dirX = flowOut[0];
    let dirZ = flowOut[1];
    if (!reachable || (dirX === 0 && dirZ === 0)) {
      // Nothing routed here at all — head for the objective and go through
      // whatever stands in the way.
      const obj = this.ctx.objective;
      const dx = obj.x - bot.position.x;
      const dz = obj.z - bot.position.z;
      const len = Math.max(1e-4, Math.hypot(dx, dz));
      dirX = dx / len;
      dirZ = dz / len;
    }

    this.trackProgress(bot, dt);
    this.move(bot, dt, dirX, dirZ, 1);
  }

  /**
   * Squad has contact but this bot doesn't. Close on the reported position; the
   * flow field already leads there because the player is one of its seeds, so
   * this mostly adds the flanker's arc on top.
   */
  private hunt(bot: Bot, dt: number): void {
    const squad = bot.squad!;
    const nav = this.ctx.nav;
    const dxs = squad.lastSeenX - bot.position.x;
    const dzs = squad.lastSeenZ - bot.position.z;
    const dist = Math.hypot(dxs, dzs);

    // Beeline only once we're close enough that the straight line is the route;
    // further out the field knows about the walls and cliffs in between.
    const len = Math.max(1e-4, dist);
    let dirX = dxs / len;
    let dirZ = dzs / len;
    const routed = nav.sample(bot.position.x, bot.position.z, flowOut);
    if (dist > 22 && routed && (flowOut[0] !== 0 || flowOut[1] !== 0)) {
      dirX = flowOut[0];
      dirZ = flowOut[1];
    }

    // Flankers peel off the squad's axis until they're close, then turn in.
    if (bot.role === BotRole.Flanker && dist > 16) {
      const arc = bot.strafeBias * 0.85;
      const cos = Math.cos(arc);
      const sin = Math.sin(arc);
      const rx = dirX * cos - dirZ * sin;
      const rz = dirX * sin + dirZ * cos;
      dirX = rx;
      dirZ = rz;
    }

    this.trackProgress(bot, dt);
    this.move(bot, dt, dirX, dirZ, 1);
  }

  // --- fighting -------------------------------------------------------------
  private engage(bot: Bot, dt: number, px: number, py: number, pz: number): void {
    const def = bot.def;
    const squad = bot.squad;
    let toX = px - bot.position.x;
    let toZ = pz - bot.position.z;
    const dist = Math.max(1e-4, Math.hypot(toX, toZ));
    toX /= dist;
    toZ /= dist;

    bot.desiredYaw = Math.atan2(toX, toZ);

    // Sappers don't fight — they head for the nearest wall and start working.
    if (def.sapper) {
      this.advance(bot, dt);
      return;
    }

    // Under fire in the open? Find something to get behind. Rationed so a
    // whole wave taking fire at once can't spike the frame.
    if (bot.repositionTimer <= 0 && this.coverBudget > 0 && !bot.hasMoveTarget && !bot.inCover) {
      bot.repositionTimer = 0.7 + this.rand() * 0.8;
      const wantsCover = bot.pressure > 0.35 || def.coverSeek > 0.55;
      if (wantsCover) {
        this.coverBudget--;
        const exposed = rateCover(
          this.ctx.world, bot.position.x, bot.position.y, bot.position.z,
          def.height, px, py, pz,
        ) === 0;
        if (exposed && findCoverSpot(this.ctx.world, bot, px, py, pz, toX, toZ, coverOut)) {
          bot.moveTargetX = coverOut.x;
          bot.moveTargetZ = coverOut.z;
          bot.hasMoveTarget = true;
          // Claim it now: the bot has to stop when it arrives, or it walks
          // straight through its own cover and back into the open.
          bot.inCover = true;
          bot.coverQuality = coverOut.quality;
          bot.coverTimer = 3 + this.rand() * 3;
        } else if (exposed && this.canBuildNow(bot)) {
          // Nothing to hide behind out here, so make some. A base of fire that
          // intends to stay puts up a proper sangar; everyone else throws down
          // a barricade and gets on with it.
          const settled = bot.role === BotRole.Support && bot.aimHeld > 1.5;
          if (settled) this.startStructure(bot, BlueprintId.Sangar, toX, toZ, 0);
          // Taking rounds at all is enough — a barricade is six blocks and a
          // second of work, and standing in the open is the worse option.
          else if (bot.pressure > 0.25) this.startStructure(bot, BlueprintId.Barricade, toX, toZ, 1);
        }
      }
    } else if (bot.inCover && !bot.hasMoveTarget && bot.repositionTimer <= 0) {
      // Cover gets shot away. Re-rate what the bot is actually standing behind
      // and turn it loose the moment the wall stops being one.
      bot.repositionTimer = 0.5;
      const quality = rateCover(
        this.ctx.world, bot.position.x, bot.position.y, bot.position.z,
        def.height, px, py, pz,
      );
      if (quality === 0) bot.inCover = false;
      else bot.coverQuality = quality;
    }

    // Settled behind a parapet: duck below it and rise to shoot, rather than
    // standing in the open beside it for the whole engagement.
    if (bot.inCover && !bot.hasMoveTarget) {
      const peeking = bot.burstLeft > 0 || bot.fireTimer < 0.35 || bot.reactionTimer > 0
        || bot.sightAge > 1.6;
      if (bot.coverQuality === 2 && !peeking) bot.crouchTarget = 1;
    }

    // Range the archetype wants to fight at, stretched for the base of fire.
    const want = def.preferredRange * (bot.role === BotRole.Support ? 1.35 : 1);
    let dirX = 0;
    let dirZ = 0;

    if (bot.hasMoveTarget) {
      const mx = bot.moveTargetX - bot.position.x;
      const mz = bot.moveTargetZ - bot.position.z;
      const md = Math.hypot(mx, mz);
      if (md < 1.2) {
        bot.hasMoveTarget = false;
      } else {
        dirX = mx / md;
        dirZ = mz / md;
      }
    } else if (bot.inCover) {
      // Hold what we took. Pushing on toward the target from here would undo
      // the whole point of having found something to stand behind.
      dirX = 0;
      dirZ = 0;
    } else if (squad !== null && !squad.mayBound(bot)) {
      // Not this bot's bound — hold position and keep shooting so the half
      // that is moving has covering fire.
      dirX = 0;
      dirZ = 0;
    } else if (dist > want) {
      const closing = 0.55 + def.aggression * 0.45;
      dirX = toX * closing;
      dirZ = toZ * closing;
    } else if (dist < want * 0.55) {
      dirX = -toX;
      dirZ = -toZ;
    } else {
      // In the pocket: keep moving laterally so they aren't free target practice.
      const s = Math.sin(bot.phase + performance.now() * 0.0011) * bot.strafeBias;
      dirX = -toZ * s;
      dirZ = toX * s;
    }

    this.trackProgress(bot, dt);
    this.move(bot, dt, dirX, dirZ, 1);
  }

  /** Hurt and under fire: put something solid between us and them. */
  private regroup(bot: Bot, dt: number, px: number, py: number, pz: number): void {
    let awayX = bot.position.x - px;
    let awayZ = bot.position.z - pz;
    const len = Math.max(1e-4, Math.hypot(awayX, awayZ));
    awayX /= len;
    awayZ /= len;
    bot.desiredYaw = Math.atan2(-awayX, -awayZ);

    if (!bot.hasMoveTarget && bot.repositionTimer <= 0 && this.coverBudget > 0) {
      bot.repositionTimer = 0.9;
      this.coverBudget--;
      if (findCoverSpot(this.ctx.world, bot, px, py, pz, awayX, awayZ, coverOut)) {
        bot.moveTargetX = coverOut.x;
        bot.moveTargetZ = coverOut.z;
        bot.hasMoveTarget = true;
        bot.inCover = true;
        bot.coverQuality = coverOut.quality;
        bot.coverTimer = 4 + this.rand() * 3;
      }
    }

    let dirX = awayX;
    let dirZ = awayZ;
    if (bot.hasMoveTarget) {
      const mx = bot.moveTargetX - bot.position.x;
      const mz = bot.moveTargetZ - bot.position.z;
      const md = Math.hypot(mx, mz);
      if (md < 1.2) bot.hasMoveTarget = false;
      else { dirX = mx / md; dirZ = mz / md; }
    } else if (bot.inCover) {
      // Made it. Stay down and let the health situation improve.
      dirX = 0;
      dirZ = 0;
      if (bot.coverQuality === 2) bot.crouchTarget = 1;
    }

    this.move(bot, dt, dirX, dirZ, 1.15);
  }

  // -------------------------------------------------------------------------
  // Movement + obstacle resolution
  // -------------------------------------------------------------------------
  private trackProgress(bot: Bot, dt: number): void {
    const cost = this.ctx.nav.costAt(bot.position.x, bot.position.z);
    if (cost < bot.lastProgressCost) {
      bot.lastProgressCost = cost;
      bot.stuckTimer = 0;
      if (bot.squad !== null) bot.squad.stalledFor = Math.max(0, bot.squad.stalledFor - dt);
    } else {
      bot.stuckTimer += dt;
      // A squad in contact is fighting, not stalled — only count time spent
      // failing to get anywhere with nobody to shoot at.
      const squad = bot.squad;
      if (squad !== null && bot.stuckTimer > 1.5 && squad.spotters === 0) {
        squad.stalledFor = Math.min(8, squad.stalledFor + dt);
      }
    }
  }

  private move(bot: Bot, dt: number, dirX: number, dirZ: number, speedScale: number): void {
    // Squadmates shoulder each other aside so a wave arrives as a line, not a stack.
    dirX += bot.pushX;
    dirZ += bot.pushZ;

    const mag = Math.hypot(dirX, dirZ);
    if (mag > 1e-4) {
      dirX /= mag;
      dirZ /= mag;
      if (bot.state !== BotState.Engage) bot.desiredYaw = Math.atan2(dirX, dirZ);
    } else {
      return;
    }

    const speed = bot.def.speed * speedScale * Math.min(1, mag);
    const stepX = dirX * speed * dt;
    const stepZ = dirZ * speed * dt;

    if (this.tryMove(bot, stepX, stepZ)) return;

    // Blocked. Work out whether to go over it, through it, or under it.
    this.resolveObstacle(bot, dirX, dirZ);
  }

  /**
   * Something is in the way. Bots pick between ramping over, boring through, or
   * chipping at the face, based on how tall and how thick it is — which is what
   * stops them standing in a line chewing a mountain one block at a time.
   */
  private resolveObstacle(bot: Bot, dirX: number, dirZ: number): void {
    const world = this.ctx.world;
    const def = bot.def;
    const footY = Math.floor(bot.position.y);
    const reach = def.radius + PROBE_AHEAD;

    const wx = Math.floor(bot.position.x + dirX * reach);
    const wz = Math.floor(bot.position.z + dirZ * reach);
    const blockY = blockingVoxel(world, wx, footY, wz);

    if (blockY < 0) {
      // Open water ahead is a different problem from a wall: bots can wade, but
      // slowly and in full view, so a builder spans it instead.
      const aheadSurface = world.surfaceHeight(wx, wz);
      if (aheadSurface <= WATER_LEVEL && this.canBuildNow(bot)
        && this.startStructure(bot, BlueprintId.Bridge, dirX, dirZ, 1, true)) {
        return;
      }
      // Not a wall — a ledge, a corner, or another bot. Shuffle out of it.
      if (bot.stuckTimer > 2) {
        bot.position.x += (this.rand() - 0.5) * 0.7;
        bot.position.z += (this.rand() - 0.5) * 0.7;
        bot.stuckTimer = 0;
        bot.hasMoveTarget = false;
      }
      return;
    }

    // How tall is it, and how deep does it go?
    const top = world.surfaceHeight(wx, wz);
    const rise = top - footY;
    let thickness = 0;
    for (let s = 0; s < MAX_BORE; s++) {
      const sx = Math.floor(bot.position.x + dirX * (reach + s));
      const sz = Math.floor(bot.position.z + dirZ * (reach + s));
      if (blockingVoxel(world, sx, footY, sz) < 0) break;
      thickness++;
    }

    // A ramp beats a wall you could never dig through in time, and leaves the
    // squad a route onto the parapet rather than a hole at ground level.
    const rampable = rise >= 2 && rise <= 5 && this.canBuildNow(bot);
    const squadCanBuild = bot.squad === null || bot.squad.builders < 2;
    if (rampable && squadCanBuild && thickness >= 2) {
      // A base of fire behind a low wall doesn't want to cross it, it wants to
      // see over it — so it builds a step to shoot from instead of a ramp.
      const wantsElevation = bot.role === BotRole.Support && rise <= 3
        && bot.squad !== null && bot.squad.hasContact;
      if (wantsElevation && this.startStructure(bot, BlueprintId.FiringStep, -dirX, -dirZ, 1)) return;
      if (this.startRamp(bot, wx, wz, dirX, dirZ, rise)) return;
    }

    // Thick and tall: bore straight through at foot height.
    if (def.tunneler && thickness >= 3 && this.startTunnel(bot, dirX, dirZ, thickness, footY)) return;

    this.startBreach(bot, wx, blockY, wz);
  }

  /** Attempts a horizontal move, allowing a 1-block step up. Returns success. */
  private tryMove(bot: Bot, stepX: number, stepZ: number): boolean {
    const world = this.ctx.world;
    const r = bot.def.radius;
    const footY = Math.floor(bot.position.y);

    const canStandAt = (x: number, z: number): number => {
      const cx = Math.floor(x);
      const cz = Math.floor(z);
      // Check the bot's footprint corners, not just its centre.
      for (let ox = -1; ox <= 1; ox += 2) {
        for (let oz = -1; oz <= 1; oz += 2) {
          const fx = Math.floor(x + ox * r);
          const fz = Math.floor(z + oz * r);
          if (blockingVoxel(world, fx, footY, fz) >= 0) {
            return findStandingY(world, cx, cz, bot.position.y, 1, 1);
          }
        }
      }
      return findStandingY(world, cx, cz, bot.position.y, 1, 2);
    };

    const nx = bot.position.x + stepX;
    const nz = bot.position.z + stepZ;
    if (nx < 2 || nz < 2 || nx > WORLD_X - 3 || nz > WORLD_Z - 3) return false;

    const y = canStandAt(nx, nz);
    if (y >= 0 && y - bot.position.y <= 1.05) {
      bot.position.x = nx;
      bot.position.z = nz;
      if (y > bot.position.y) bot.position.y = y;
      return true;
    }

    // Try each axis alone so bots slide along walls instead of stopping dead.
    if (stepX !== 0) {
      const yx = canStandAt(bot.position.x + stepX, bot.position.z);
      if (yx >= 0 && yx - bot.position.y <= 1.05) {
        bot.position.x += stepX;
        if (yx > bot.position.y) bot.position.y = yx;
        return true;
      }
    }
    if (stepZ !== 0) {
      const yz = canStandAt(bot.position.x, bot.position.z + stepZ);
      if (yz >= 0 && yz - bot.position.y <= 1.05) {
        bot.position.z += stepZ;
        if (yz > bot.position.y) bot.position.y = yz;
        return true;
      }
    }
    return false;
  }

  private applyPhysics(bot: Bot, dt: number): void {
    const world = this.ctx.world;
    const standY = findStandingY(
      world, Math.floor(bot.position.x), Math.floor(bot.position.z), bot.position.y, 1, 1,
    );
    if (standY >= 0 && Math.abs(standY - bot.position.y) < 1.2) {
      bot.position.y += (standY - bot.position.y) * Math.min(1, dt * 14);
      bot.velocity.y = 0;
      bot.grounded = true;
      return;
    }

    const prevY = bot.position.y;
    bot.velocity.y -= 26 * dt;
    bot.position.y += bot.velocity.y * dt;
    bot.grounded = false;

    // Search from where the bot *was*, over a window that covers the whole
    // distance it just fell. Searching from where it landed instead lets a fast
    // fall step straight past the ground: the surface sits above the new
    // position's search window on one frame and below it on the next, and the
    // bot drops through the map.
    const swept = Math.max(3, Math.ceil(prevY - bot.position.y) + 1);
    const below = findStandingY(
      world, Math.floor(bot.position.x), Math.floor(bot.position.z), prevY, 0, swept,
    );
    if (below >= 0 && bot.position.y <= below) {
      bot.position.y = below;
      bot.velocity.y = 0;
      bot.grounded = true;
      return;
    }

    // Buried: a bot with solid rock at its feet has no standing position at any
    // height in this column, so it would fall straight through the map. This
    // happens whenever the world closes over a bot — a block placed on top of
    // it, terrain collapsing onto it — so surface it rather than kill it.
    const fx = Math.floor(bot.position.x);
    const fz = Math.floor(bot.position.z);
    if (world.isSolid(fx, Math.floor(bot.position.y), fz)) {
      const surfaced = findStandingY(world, fx, fz, world.surfaceHeight(fx, fz), 1, 2);
      if (surfaced >= 0) {
        bot.position.y = surfaced;
        bot.velocity.y = 0;
        bot.grounded = true;
        return;
      }
    }

    if (bot.position.y < -4) this.damage(bot, bot.hp);
  }

  /** Cheap all-pairs shoulder-check. 72 bots is 2.5k pairs of plain arithmetic. */
  private computeSeparation(): void {
    const bots = this.bots;
    for (let i = 0; i < bots.length; i++) {
      bots[i].pushX = 0;
      bots[i].pushZ = 0;
    }
    for (let i = 0; i < bots.length; i++) {
      const a = bots[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < bots.length; j++) {
        const b = bots[j];
        if (!b.alive) continue;
        const dx = b.position.x - a.position.x;
        const dz = b.position.z - a.position.z;
        const min = a.def.radius + b.def.radius + 0.45;
        const d2 = dx * dx + dz * dz;
        if (d2 >= min * min || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const push = (1 - d / min) * 0.9;
        const nx = dx / d;
        const nz = dz / d;
        a.pushX -= nx * push;
        a.pushZ -= nz * push;
        b.pushX += nx * push;
        b.pushZ += nz * push;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Engineering
  // -------------------------------------------------------------------------
  /**
   * Commits the bot — and, where possible, the whole squad — to one voxel.
   * Five bots chipping five different blocks never opens a hole; five bots on
   * the same block opens one in a fifth of the time.
   */
  private startBreach(bot: Bot, x: number, y: number, z: number): void {
    const squad = bot.squad;
    if (squad !== null) {
      const sx = squad.breachX;
      if (sx >= 0 && this.ctx.world.isSolid(sx, squad.breachY, squad.breachZ)) {
        const d = Math.hypot(sx + 0.5 - bot.position.x, squad.breachZ + 0.5 - bot.position.z);
        // Only join the squad's breach if it's actually within reach.
        if (d < 4.5) {
          x = sx;
          y = squad.breachY;
          z = squad.breachZ;
        } else {
          squad.designateBreach(x, y, z);
        }
      } else {
        squad.designateBreach(x, y, z);
      }
    }

    bot.state = BotState.Breach;
    bot.breachX = x;
    bot.breachY = y;
    bot.breachZ = z;
    bot.hasMoveTarget = false;
    bot.desiredYaw = Math.atan2(x + 0.5 - bot.position.x, z + 0.5 - bot.position.z);
  }

  private breachTick(bot: Bot, dt: number): void {
    const world = this.ctx.world;
    if (bot.breachX < 0 || !world.isSolid(bot.breachX, bot.breachY, bot.breachZ)) {
      bot.breachX = -1;
      bot.state = BotState.Advance;
      bot.lastProgressCost = UNREACHABLE;
      bot.squad?.clearBreach();
      return;
    }

    // Drifted out of reach (knocked back, or the squad moved on).
    const d = Math.hypot(
      bot.breachX + 0.5 - bot.position.x,
      bot.breachZ + 0.5 - bot.position.z,
    );
    if (d > 4.5) {
      const dx = (bot.breachX + 0.5 - bot.position.x) / d;
      const dz = (bot.breachZ + 0.5 - bot.position.z) / d;
      this.move(bot, dt, dx, dz, 1);
      return;
    }

    bot.desiredYaw = Math.atan2(bot.breachX + 0.5 - bot.position.x, bot.breachZ + 0.5 - bot.position.z);
    bot.breachTimer -= dt;
    if (bot.breachTimer > 0) return;
    bot.breachTimer = bot.def.sapper ? 0.35 : 0.7;
    this.ctx.onBreach(bot, bot.breachX, bot.breachY, bot.breachZ);
  }

  /** Lays out a bore straight through a wall at the bot's own foot height. */
  private startTunnel(bot: Bot, dirX: number, dirZ: number, thickness: number, footY: number): boolean {
    const world = this.ctx.world;
    const reach = bot.def.radius + PROBE_AHEAD;
    const plan = bot.tunnelPlan;
    let n = 0;

    for (let s = 0; s <= thickness && n < MAX_TUNNEL; s++) {
      const sx = Math.floor(bot.position.x + dirX * (reach + s));
      const sz = Math.floor(bot.position.z + dirZ * (reach + s));
      for (let dy = 0; dy < 2 && n < MAX_TUNNEL; dy++) {
        const y = footY + dy;
        if (y < 1 || y >= WORLD_Y) continue;
        if (!world.isSolid(sx, y, sz)) continue;
        if (MATERIALS[world.materialAt(sx, y, sz)].indestructible) return false;
        plan[n * 3] = sx;
        plan[n * 3 + 1] = y;
        plan[n * 3 + 2] = sz;
        n++;
      }
    }
    if (n === 0) return false;

    bot.tunnelLen = n;
    bot.tunnelCursor = 0;
    bot.state = BotState.Tunnel;
    bot.hasMoveTarget = false;
    return true;
  }

  private tunnelTick(bot: Bot, dt: number): void {
    const world = this.ctx.world;
    const plan = bot.tunnelPlan;

    // Skip anything that's already gone — explosions do a lot of this for us.
    while (bot.tunnelCursor < bot.tunnelLen) {
      const i = bot.tunnelCursor * 3;
      if (world.isSolid(plan[i], plan[i + 1], plan[i + 2])) break;
      bot.tunnelCursor++;
    }
    if (bot.tunnelCursor >= bot.tunnelLen) {
      bot.tunnelLen = 0;
      bot.state = BotState.Advance;
      bot.lastProgressCost = UNREACHABLE;
      return;
    }

    const i = bot.tunnelCursor * 3;
    const tx = plan[i];
    const ty = plan[i + 1];
    const tz = plan[i + 2];
    bot.desiredYaw = Math.atan2(tx + 0.5 - bot.position.x, tz + 0.5 - bot.position.z);

    // Follow the bore in as it opens up.
    const dx = tx + 0.5 - bot.position.x;
    const dz = tz + 0.5 - bot.position.z;
    const d = Math.hypot(dx, dz);
    if (d > 2.2) this.move(bot, dt, dx / d, dz / d, 0.8);

    bot.breachTimer -= dt;
    if (bot.breachTimer > 0) return;
    bot.breachTimer = bot.def.sapper ? 0.3 : 0.6;
    this.ctx.onBreach(bot, tx, ty, tz);
  }

  /**
   * Picks a site for an assault ramp against the wall the bot just walked into,
   * backing the footprint off so the top step lands against the parapet.
   */
  private startRamp(bot: Bot, wx: number, wz: number, dirX: number, dirZ: number, rise: number): boolean {
    const id = rise <= 3 ? BlueprintId.RampShort : BlueprintId.RampTall;
    const bp = BLUEPRINTS[id];
    const rot = rotationToward(dirX, dirZ);
    const fx = forwardX(rot);
    const fz = forwardZ(rot);

    const ox = wx - fx * bp.depth;
    const oz = wz - fz * bp.depth;
    const oy = this.ctx.world.surfaceHeight(ox, oz);
    if (oy <= 0 || oy >= WORLD_Y - bp.rise - 2) return false;

    return this.startBuild(bot, id, ox, oy, oz, rot);
  }

  /**
   * Plants a blueprint on the ground ahead of the bot, facing the way it's
   * looking. `atFootLevel` founds the structure at the bot's own standing
   * height rather than on whatever is underneath it — which is the difference
   * between a bridge deck and a pile of planks on the riverbed.
   */
  private startStructure(
    bot: Bot, id: BlueprintId,
    dirX: number, dirZ: number, aheadCells: number,
    atFootLevel = false,
  ): boolean {
    const rot = rotationToward(dirX, dirZ);
    const ox = Math.floor(bot.position.x) + forwardX(rot) * aheadCells;
    const oz = Math.floor(bot.position.z) + forwardZ(rot) * aheadCells;
    const oy = atFootLevel ? Math.floor(bot.position.y) : this.ctx.world.surfaceHeight(ox, oz);
    if (oy <= 0 || oy >= WORLD_Y - 6) return false;
    if (this.startBuild(bot, id, ox, oy, oz, rot)) return true;
    // Don't re-test a site that just failed on every single frame.
    bot.buildCooldown = 1.5;
    return false;
  }

  /** True when this bot is allowed to stop and put something up right now. */
  private canBuildNow(bot: Bot): boolean {
    return bot.def.builder && bot.buildCooldown <= 0 && !bot.buildActive;
  }

  private startBuild(bot: Bot, id: BlueprintId, ox: number, oy: number, oz: number, rot: number): boolean {
    const bp = BLUEPRINTS[id];
    const remaining = evaluateSite(this.ctx.world, bp, ox, oy, oz, rot);
    if (remaining < 0) return false;

    bot.buildId = id;
    bot.buildOriginX = ox;
    bot.buildOriginY = oy;
    bot.buildOriginZ = oz;
    bot.buildRot = rot;
    bot.buildCursor = 0;
    bot.buildTimer = 0;
    bot.buildActive = true;
    // Generous, but bounded: a site that can't be finished gets abandoned.
    bot.buildPatience = 6 + remaining * bp.placeInterval * 2.5;
    bot.state = BotState.Build;
    bot.hasMoveTarget = false;
    return true;
  }

  private buildTick(bot: Bot, dt: number): void {
    const world = this.ctx.world;
    const bp = BLUEPRINTS[bot.buildId];

    bot.buildPatience -= dt;
    if (bot.buildPatience <= 0) {
      this.finishBuild(bot, 3);
      return;
    }

    bot.buildTimer -= dt;
    if (bot.buildTimer > 0) return;

    while (bot.buildCursor < bp.cells.length) {
      const cell = bp.cells[bot.buildCursor];
      const x = bot.buildOriginX + rotateX(cell[0], cell[2], bot.buildRot);
      const y = bot.buildOriginY + cell[1];
      const z = bot.buildOriginZ + rotateZ(cell[0], cell[2], bot.buildRot);

      if (world.get(x, y, z) !== AIR) {
        bot.buildCursor++;
        continue;
      }

      const dx = x + 0.5 - bot.position.x;
      const dz = z + 0.5 - bot.position.z;
      const d = Math.hypot(dx, dz);
      if (d > 4.5) {
        // Walk into arm's reach of the next block rather than placing at range.
        this.move(bot, dt, dx / d, dz / d, 0.9);
        return;
      }

      bot.desiredYaw = Math.atan2(dx, dz);
      if (this.ctx.onBuild(bot, x, y, z, bp.color, bp.material)) {
        bot.buildTimer = bp.placeInterval;
      }
      bot.buildCursor++;
      return;
    }

    this.finishBuild(bot, 8);
  }

  private finishBuild(bot: Bot, cooldown: number): void {
    bot.buildActive = false;
    bot.buildCursor = 0;
    bot.buildCooldown = cooldown;
    bot.state = BotState.Advance;
    bot.lastProgressCost = UNREACHABLE;
  }

  // -------------------------------------------------------------------------
  // Shooting
  // -------------------------------------------------------------------------
  /**
   * Tracks the aim point rather than teleporting it onto the player, leads
   * projectiles, and widens the cone while the bot is still settling or moving.
   * Together these are what stop bots feeling like either aimbots or dice.
   */
  private updateAim(bot: Bot, dt: number, px: number, py: number, pz: number): void {
    const def = bot.def;
    const squad = bot.squad;

    let tx: number;
    let ty: number;
    let tz: number;
    if (bot.seesTarget) {
      tx = px; ty = py; tz = pz;
    } else if (squad !== null && squad.hasContact) {
      tx = squad.lastSeenX; ty = squad.lastSeenY; tz = squad.lastSeenZ;
    } else {
      bot.aimValid = false;
      return;
    }

    // Lead the shot for anything with travel time.
    const speed = projectileSpeed(def.weapon);
    if (speed > 0) {
      const flight = Math.hypot(tx - bot.position.x, tz - bot.position.z) / speed;
      const skill = def.accuracy;
      tx += this.ctx.playerVel.x * flight * skill;
      tz += this.ctx.playerVel.z * flight * skill;
    }

    if (!bot.aimValid) {
      bot.aimPoint.set(tx, ty, tz);
      bot.aimValid = true;
    } else {
      // Faster archetypes swing onto target quicker.
      const rate = 1 - Math.exp(-dt * (5 + def.accuracy * 8));
      bot.aimPoint.x += (tx - bot.aimPoint.x) * rate;
      bot.aimPoint.y += (ty - bot.aimPoint.y) * rate;
      bot.aimPoint.z += (tz - bot.aimPoint.z) * rate;
    }

    const steady = Math.min(1, bot.aimHeld / Math.max(0.05, def.aimTime));
    const moving = bot.hasMoveTarget || bot.state === BotState.Regroup ? 1.7 : 1;
    // Suppressive fire is pressure, not marksmanship — it goes near the target,
    // not at it.
    const blind = bot.suppressing ? 2.2 : 1;
    bot.aimSpread = (1 - def.accuracy) * 0.12 * (1.5 - steady * 0.75) * moving * blind;
  }

  private shoot(bot: Bot, dt: number, px: number, pz: number): void {
    const def = bot.def;
    if (def.sapper) return;

    // Never shoot while nose-deep in a wall.
    if (bot.state === BotState.Build || bot.state === BotState.Tunnel) return;

    if (bot.burstLeft > 0) {
      bot.burstTimer -= dt;
      if (bot.burstTimer <= 0) {
        bot.burstLeft--;
        bot.burstTimer = 0.11;
        this.ctx.onFire(bot, bot.aimPoint.x, bot.aimPoint.y, bot.aimPoint.z);
      }
      return;
    }

    bot.fireTimer -= dt;
    if (bot.reactionTimer > 0) {
      bot.reactionTimer -= dt;
      return;
    }
    if (bot.fireTimer > 0) return;
    if (!bot.aimValid) return;

    const dist = Math.hypot(px - bot.position.x, pz - bot.position.z);
    const inRange = bot.seesTarget && dist <= def.maxRange;

    // Suppression: keep rounds landing on the last known position so the target
    // can't lean out freely while the rest of the squad moves.
    let suppressing = false;
    if (!inRange && def.suppresses && bot.state !== BotState.Breach) {
      const squad = bot.squad;
      if (squad !== null && squad.hasContact && squad.contactAge < 3.5 && squad.spotters > 0) {
        const sd = Math.hypot(squad.lastSeenX - bot.position.x, squad.lastSeenZ - bot.position.z);
        suppressing = sd <= def.maxRange && hasLineOfSight(
          this.ctx.world, bot.position.x, bot.eyeY, bot.position.z,
          bot.aimPoint.x, bot.aimPoint.y, bot.aimPoint.z,
        );
      }
    }
    if (!inRange && !suppressing) return;

    // Suppressive fire is deliberately loose and slow — it's pressure, not aim.
    bot.suppressing = suppressing;
    bot.fireTimer = def.fireInterval * (suppressing ? 1.8 : 1) * (0.8 + this.rand() * 0.4);
    bot.burstLeft = def.burst;
    bot.burstTimer = 0;
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------
  /**
   * Re-uploads the instance buffers without running any AI.
   *
   * Multiplayer clients don't simulate bots — they write server snapshots
   * straight into the pool and then call this to redraw them.
   */
  refreshInstances(): void {
    this.syncInstances();
  }

  private syncInstances(): void {
    let n = 0;
    const colorAttr = this.mesh.instanceColor!;

    for (const bot of this.bots) {
      if (!bot.active) continue;
      const def = bot.def;
      const s = def.scale;
      const dying = bot.state === BotState.Dying;

      // A standing bot only yaws. A body goes over around a horizontal axis at
      // right angles to the way the killing round was travelling, so it falls
      // away from the shot instead of always folding neatly forward, and rolls
      // about that same direction so it lands on a shoulder rather than
      // perfectly on its face.
      if (dying && (bot.fallPitch > 1e-4 || bot.fallRoll !== 0)) {
        fallAxis.set(bot.fallDirZ, 0, -bot.fallDirX).normalize();
        rollAxis.set(bot.fallDirX, 0, bot.fallDirZ).normalize();
        yawQuat.setFromAxisAngle(AXIS_Y, bot.yaw);
        rollQuat.setFromAxisAngle(rollAxis, bot.fallRoll);
        tmpQuat.setFromAxisAngle(fallAxis, bot.fallPitch)
          .multiply(rollQuat)
          .multiply(yawQuat);
      } else {
        tmpEuler.set(0, bot.yaw, 0, 'YXZ');
        tmpQuat.setFromEuler(tmpEuler);
      }

      // Toppling pivots on the feet, so a body lying flat has every box
      // centred on the floor line and half-buried in it. Lift it back out as
      // it goes over. Bodies then sink out of sight over the last second or so
      // of their life rather than blinking out from under the player.
      let rise = dying ? Math.sin(bot.fallPitch) * 0.32 * s : 0;
      if (dying && bot.deathTimer < CORPSE_SINK) {
        rise -= (1 - bot.deathTimer / CORPSE_SINK) * (def.height + 0.5);
      }

      // Being hit never changes a man's colour — the only thing a round leaves
      // behind is the blood, drawn per box further down.
      const bodyCol = def.bodyColor;
      const headCol = def.headColor;
      const hatCol = def.hatColor;
      const legCol = shade(def.bodyColor, 0.72);
      const rigCol = def.rigColor;
      // The hat's straw darkens as it narrows, so the cone reads as a cone
      // rather than a flat stack of identical slabs.
      const hatMid = shade(def.hatColor, 0.9);
      const hatTip = shade(def.hatColor, 0.8);

      // --- pose ------------------------------------------------------------
      // Legs swing on the distance-driven walk cycle, at an amplitude set by
      // how fast the bot is actually travelling, so a bot edging around a
      // corner shuffles and a raider sprinting in strides.
      const gait = dying ? 0 : Math.min(1, bot.moveSpeed / Math.max(0.6, def.speed));
      // A dead man's knees give way, which folds him down the same way a
      // crouch does — so the collapse rides the crouch plumbing.
      const crouch = dying ? bot.collapse : bot.crouch;
      // How far into the fall the body is, which is what the limbs sprawl with.
      const down = dying ? bot.fallPitch / HALF_PI : 0;
      const swing = dying ? 0 : Math.sin(bot.walkPhase) * 0.62 * gait * (1 - crouch * 0.5);
      // Every limb hangs off its own slack joint once the bot is dead.
      const legLeft = dying ? bot.joints[Joint.LegLeft] : swing;
      const legRight = dying ? bot.joints[Joint.LegRight] : -swing;

      // Crouching folds the legs and drops everything above the waist, which
      // is what actually puts the bot behind the wall it picked.
      const legSquash = 1 - 0.5 * crouch;
      const dip = 0.92 * crouch * s;
      // Weight shifts up and down with the stride.
      const bob = (Math.abs(Math.sin(bot.walkPhase)) - 0.5) * 0.07 * gait * s;

      const hipY = 0.86 * s * legSquash;
      const legY = 0.42 * s * legSquash;
      // Arms and legs finish up thrown wide, by an amount drawn per bot.
      const legSpread = (0.21 + 0.08 * crouch + 0.2 * down * bot.sprawlLeg) * s;
      const armSpread = (0.5 + 0.3 * down * bot.sprawlArm) * s;
      const legH = 0.85 * s * legSquash;
      const upper = -dip + bob;
      const torsoY = 1.35 * s + upper;
      const shoulderY = 1.74 * s + upper;
      const neckY = 1.86 * s + upper;
      const headY = 2.16 * s + upper;
      const beltY = 0.92 * s * legSquash + upper * 0.35;

      // A soldier carries his weapon up in both hands, not swinging at his
      // sides. The arms come forward off the shoulder to CARRY and the aim
      // line pitches them from there, so a bot is holding its gun whether or
      // not it currently has anything to shoot at.
      const aiming = !dying && bot.aimValid && bot.seesTarget;
      let armPitch: number;
      if (dying) armPitch = bot.joints[Joint.ArmRight];
      else if (bot.working) armPitch = CARRY + 0.3 + Math.sin(bot.animTime * 11) * 0.55;
      else armPitch = CARRY - (aiming ? bot.aimPitch : 0) - swing * 0.1;
      // Both hands are on the weapon — until he lets go of it, and then each
      // arm falls wherever the fall throws it.
      const offArmPitch = dying ? bot.joints[Joint.ArmLeft] : armPitch;
      const headPitch = dying ? bot.joints[Joint.Head] : -bot.aimPitch * 0.6;

      // Where the hands end up once the arms have swung forward. The weapon
      // hangs off that point rather than off the shoulder, so it stays in the
      // grip instead of sweeping through the chest as the bot aims.
      const armLen = 0.84 * s;
      const handY = shoulderY - armLen * Math.cos(armPitch);
      const handZ = -armLen * Math.sin(armPitch);
      // The weapon itself stays level with the aim line; while digging it
      // swings with the arms so the spade actually bites.
      const weaponPitch = dying ? armPitch : bot.working ? armPitch - CARRY : -bot.aimPitch;

      // Nón lá. Each ring is two crossed slabs rather than one square one: an
      // octagon reads as the round hat it is, where a single box reads as a
      // board. Wide and shallow, the way the real thing sits.
      const brimY = 2.33 * s + upper;
      const hatT = 0.085 * s;
      const ring = (y: number, w: number, d: number, col: number): Part[] => [
        [0, y, 0, w * s, hatT, d * s, col, headPitch, neckY, 0],
        [0, y, 0, d * s, hatT, w * s, col, headPitch, neckY, 0],
      ];

      // legs / body / arms / head / hat / weapon, all relative to the bot's feet.
      // x, y, z, sx, sy, sz, colour, pitch, pivot y, pivot z
      const parts: Part[] = [
        [-legSpread, legY, 0, 0.24 * s, legH, 0.4 * s, legCol, legLeft, hipY, 0],
        [legSpread, legY, 0, 0.24 * s, legH, 0.4 * s, legCol, legRight, hipY, 0],
        [0, torsoY, 0, 0.8 * s, 1.05 * s, 0.52 * s, bodyCol, 0, 0, 0],
        // Belt at the waist and a bandolier across the chest, both sitting
        // proud of the uniform so the torso doesn't read as one long slab.
        [0, beltY, 0, 0.84 * s, 0.16 * s, 0.56 * s, rigCol, 0, 0, 0],
        [0, torsoY + 0.17 * s, 0, 0.84 * s, 0.3 * s, 0.58 * s, rigCol, 0, 0, 0],
        [-armSpread, shoulderY - 0.42 * s, 0, 0.24 * s, 0.9 * s, 0.34 * s, bodyCol,
          offArmPitch, shoulderY, 0],
        [armSpread, shoulderY - 0.42 * s, 0, 0.24 * s, 0.9 * s, 0.34 * s, bodyCol,
          armPitch, shoulderY, 0],
        [0, headY, 0, 0.6 * s, 0.6 * s, 0.6 * s, headCol, headPitch, neckY, 0],
        // Eyes: two dark slits on the front face, under the brim.
        [-0.145 * s, headY + 0.06 * s, 0.305 * s, 0.17 * s, 0.07 * s, 0.02 * s, EYE,
          headPitch, neckY, 0],
        [0.145 * s, headY + 0.06 * s, 0.305 * s, 0.17 * s, 0.07 * s, 0.02 * s, EYE,
          headPitch, neckY, 0],
        // Weapon, held in both hands out in front of the chest.
        [0.12 * s, handY + 0.04 * s, handZ - 0.02 * s, 0.16 * s, 0.16 * s, 1.15 * s, 0x222222,
          weaponPitch, handY, handZ],
      ];

      // The hat comes last and is tracked separately, because a hit knocks it
      // off: from the moment a bot dies it stops being part of him and becomes
      // an object tumbling to the ground beside the body.
      const hatStart = parts.length;
      parts.push(
        ...ring(brimY, 1.16, 0.78, hatCol),
        ...ring(brimY + 0.09 * s, 0.8, 0.54, hatCol),
        ...ring(brimY + 0.18 * s, 0.46, 0.31, hatMid),
        [0, brimY + 0.27 * s, 0, 0.15 * s, 0.1 * s, 0.15 * s, hatTip, headPitch, neckY, 0],
      );

      // Where the hat has got to on its way down: an arc out in the direction
      // of the fall, turning flat as it goes, landing brim-down on the ground.
      const hatOff = dying;
      if (hatOff) {
        const k = bot.hatFall;
        const ease = k * k * (3 - 2 * k);
        flatQuat.setFromAxisAngle(AXIS_Y, bot.yaw + bot.hatSpin * ease);
        hatQuat.copy(tmpQuat).slerp(flatQuat, ease);
        const throwOut = (0.6 + bot.sprawlArm) * s;
        hatPos.set(0, brimY, 0).applyQuaternion(tmpQuat).add(bot.position);
        hatPos.x += bot.fallDirX * throwOut * ease;
        hatPos.z += bot.fallDirZ * throwOut * ease;
        hatPos.y += (bot.position.y + 0.06 - hatPos.y) * ease + Math.sin(Math.PI * k) * 0.45;
      }

      const wounds = bot.wounds;
      const nWounds = bot.woundCount;
      // How far a hit spreads across the body, in the bot's own units.
      const spread = 0.62 * s;
      for (let p = 0; p < parts.length && n < this.mesh.instanceMatrix.count; p++) {
        const [ox, oy, oz, sx, sy, sz, col, pitch, pvY, pvZ] = parts[p];

        if (hatOff && p >= hatStart) {
          // Off the head: laid out about the hat's own centre, not the feet.
          tmpPos.set(ox, oy - brimY, oz).applyQuaternion(hatQuat).add(hatPos);
          tmpScale.set(sx, sy, sz);
          tmpMatrix.compose(tmpPos, hatQuat, tmpScale);
          this.mesh.setMatrixAt(n, tmpMatrix);
          tmpColor.setHex(col);
          colorAttr.setXYZ(n, tmpColor.r, tmpColor.g, tmpColor.b);
          n++;
          continue;
        }

        let ly = oy;
        let lz = oz;
        let q = tmpQuat;
        if (pitch !== 0) {
          // Swing the part around its own joint, in the bot's local frame.
          const c = Math.cos(pitch);
          const sn = Math.sin(pitch);
          const ry = oy - pvY;
          const rz = oz - pvZ;
          ly = pvY + ry * c - rz * sn;
          lz = pvZ + ry * sn + rz * c;
          pitchQuat.setFromAxisAngle(AXIS_X, pitch);
          q = partQuat.copy(tmpQuat).multiply(pitchQuat);
        }
        // Rotate the local offset into world space.
        tmpPos.set(ox, ly, lz).applyQuaternion(tmpQuat).add(bot.position);
        tmpPos.y += rise;
        tmpScale.set(sx, sy, sz);
        tmpMatrix.compose(tmpPos, q, tmpScale);
        this.mesh.setMatrixAt(n, tmpMatrix);

        // Blood goes where the rounds went: every wound bleeds onto the boxes
        // near it, so a leg shot marks the leg and a chest shot soaks the
        // uniform. The stains ride the body down onto the ground.
        let stain = 0;
        for (let w = 0; w < nWounds; w++) {
          const wi = w * 4;
          const wx = wounds[wi] - ox;
          const wy = wounds[wi + 1] - oy;
          const wz = wounds[wi + 2] - oz;
          const d = Math.sqrt(wx * wx + wy * wy + wz * wz);
          if (d >= spread) continue;
          stain += wounds[wi + 3] * (1 - d / spread);
        }
        tmpColor.setHex(stain > 0 ? mixHex(col, BLOOD, Math.min(0.92, stain)) : col);
        colorAttr.setXYZ(n, tmpColor.r, tmpColor.g, tmpColor.b);
        n++;
      }
    }

    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    colorAttr.needsUpdate = true;
  }

  /** Ray/AABB sweep over every living bot. Returns the nearest hit. */
  raycast(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDist: number,
  ): { bot: Bot; distance: number; zoneY: number } | null {
    let best: Bot | null = null;
    let bestT = maxDist;
    let bestY = 0;

    for (const bot of this.bots) {
      if (!bot.alive) continue;
      const def = bot.def;
      const r = def.radius;
      const h = bot.poseHeight;

      const minX = bot.position.x - r, maxX = bot.position.x + r;
      const minY = bot.position.y, maxY = bot.position.y + h;
      const minZ = bot.position.z - r, maxZ = bot.position.z + r;

      let t0 = 0;
      let t1 = bestT;

      const slab = (o: number, d: number, lo: number, hi: number): boolean => {
        if (Math.abs(d) < 1e-8) return o >= lo && o <= hi;
        const inv = 1 / d;
        let a = (lo - o) * inv;
        let b = (hi - o) * inv;
        if (a > b) { const t = a; a = b; b = t; }
        if (a > t0) t0 = a;
        if (b < t1) t1 = b;
        return t0 <= t1;
      };

      if (!slab(ox, dx, minX, maxX)) continue;
      if (!slab(oy, dy, minY, maxY)) continue;
      if (!slab(oz, dz, minZ, maxZ)) continue;
      if (t0 < 0 || t0 >= bestT) continue;

      best = bot;
      bestT = t0;
      bestY = oy + dy * t0;
    }

    return best ? { bot: best, distance: bestT, zoneY: bestY } : null;
  }

  /** Every living bot within `radius` of a point — used by explosions. */
  forEachInRadius(x: number, y: number, z: number, radius: number, fn: (bot: Bot, dist: number) => void): void {
    const r2 = radius * radius;
    for (const bot of this.bots) {
      if (!bot.alive) continue;
      const cx = bot.position.x - x;
      const cy = bot.position.y + bot.def.height * 0.5 - y;
      const cz = bot.position.z - z;
      const d2 = cx * cx + cy * cy + cz * cz;
      if (d2 <= r2) fn(bot, Math.sqrt(d2));
    }
  }
}

export type { BotDef };
