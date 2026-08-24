import * as THREE from 'three';
import type { VoxelWorld } from '../voxel/VoxelWorld';
import type { NavGrid } from './NavGrid';
import { UNREACHABLE } from './NavGrid';
import {
  Bot, BotState, Joint, JOINTS, MAX_TUNNEL, BOT_PARTS, CORPSE_LIFE, CORPSE_SINK,
  findStandingY, blockingVoxel,
} from './Bot';
import type { BotTarget } from './Bot';
import { BotKind, BotRole, type BotDef } from './botTypes';
import { SquadManager, CONTACT_MEMORY } from './Squad';
import {
  BLUEPRINTS, BlueprintId, evaluateSite, rotateX, rotateZ, rotationToward,
  forwardX, forwardZ,
} from './blueprints';
import { findCoverSpot, rateCover, type CoverSpot } from './cover';
import {
  VIEW_CONE, VIEW_CONE_ALERT, SPOT_RATE, FORGET_RATE, ALERT_FORGET_SCALE,
  SUSPICIOUS, SQUAD_CONTACT_SCALE, rangeFactor, inViewCone, noiseFalloff,
} from './stealth';
import {
  TunnelNetwork, tunnelY, canCutMouth, findLip, TUNNEL_DEPTH, type SpiderHole,
} from './TunnelNetwork';
import { hasLineOfSight } from '../voxel/raycast';
import { riceConceals } from '../voxel/worldgen';
import { WORLD_X, WORLD_Z, WORLD_Y, WATER_LEVEL, MATERIALS, Mat } from '../core/constants';
import { AIR } from '../voxel/palette';
import { WeaponId, WEAPONS } from '../weapons/definitions';
import { VoiceCue } from '../audio/cues';

export const MAX_BOTS = 72;

/**
 * How close a bot has to be before the rice stops working.
 *
 * Concealment is not invisibility: walk into somebody in the crop and you see
 * him. Kept a little over three metres so a plot can still be searched, and a
 * long way under any weapon's range so it is worth getting down in.
 */
const RICE_SPOT_RANGE = 7;
const PARTS = BOT_PARTS;

/**
 * Skin the exposed forearms and shins come in.
 *
 * Deliberately not read off the kind's `headColor`: what a man has on his face
 * is a fact about his archetype -- the Tank's is a mask and the Warlord's is
 * paint -- and what his hands look like is a fact about him.
 */
const SKIN = [0xc9a077, 0xb98f68, 0xd0a97f, 0xa8815d, 0xbb9166];
/**
 * Khăn rằn, the checked scarf, flattened to the one colour a voxel gets. Grey,
 * off-white and a washed red are what it actually turns up in.
 */
const SCARF = [0x9a9188, 0x8a4038, 0x6d6a62, 0xb5aa9c, 0x4a4a52, 0x7d3630];

/** Wet blood, for the stains a round leaves on a body. */
const BLOOD = 0x7c0d0d;

/** Frames between a bot's line-of-sight checks. */
const SIGHT_STRIDE = 3;
/**
 * Cover searches allowed per frame across the whole horde. The search is a
 * ring of candidates and a handful of rays each, so this is the knob that
 * decides how quickly a squad under fire actually gets behind something.
 */
const COVER_BUDGET = 8;
/** How far ahead of itself a bot probes for walls, past its own radius. */
const PROBE_AHEAD = 0.7;
/** Shoulder rotation that brings the arms forward into a weapon carry. */
const CARRY = -1.22;
/** Radians of walk cycle per block covered — one full stride every ~3 blocks. */
const STRIDE = 2.1;
/** Thickest wall a bot will consider boring through rather than going around. */
const MAX_BORE = 8;

/**
 * Blocks/sec the player clears with the spade, derived rather than written
 * down: `digHits` swings at the spade's own cadence, through the dirt that
 * most of the valley is made of. Retuning either end moves this with it.
 */
const PLAYER_DIG_RATE = 1
  / (MATERIALS[Mat.Dirt].digHits * WEAPONS[WeaponId.Spade].delay);

/**
 * Blocks/sec cutting fresh ground: half again as fast as the player manages
 * with a spade, and no faster.
 *
 * They are better at this than you are — it is what they do — but only by the
 * margin a practised man has over an unpractised one. The consequence is that
 * a rat opening new ground is slow, and slow is what makes the spoil trail a
 * warning you can actually act on rather than a puff of dirt arriving with the
 * man.
 */
const BURROW_DIG_SPEED = PLAYER_DIG_RATE * 1.5;

/**
 * Blocks/sec along a gallery that has already been cut.
 *
 * Moving down a finished tunnel is not digging and shouldn't be priced as if
 * it were — it's a crouched jog through a corridor somebody else already paid
 * for. This is the abstraction the network buys: the long leg of a trip runs
 * at this speed because the tunnels are there, and only the last stretch to a
 * new hole is dug.
 */
const BURROW_GALLERY_SPEED = 3.6;
/** Seconds to come up out of a mouth, and to drop back into one. */
const EMERGE_TIME = 0.85;
const SUBMERGE_TIME = 0.65;
/** Longest a rat will stay above ground before going back down regardless. */
const SURFACE_DWELL = 7;
/** Bursts it gets away on one trip up. */
const BURSTS_PER_TRIP = 2;
/**
 * How often a bot reconsiders which man it is trying to kill.
 *
 * Not every frame: a bot standing between two players would spend the fight
 * turning from one to the other instead of shooting either.
 */
const RETARGET_INTERVAL = 1.5;
/**
 * How much nearer a new man has to be before a bot swaps onto him, as a
 * fraction of the range to the one it already has. The margin is the whole
 * point — without it two players walking abreast make the horde oscillate.
 */
const RETARGET_HYSTERESIS = 0.75;

/** Longest a rat will look for somewhere worth surfacing before settling. */
const BURROW_PATIENCE = 22;

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

// Re-exported so callers wiring up a horde only need this module.
export type { BotTarget };

export interface BotWorldContext {
  world: VoxelWorld;
  nav: NavGrid;
  /**
   * Everyone the horde is willing to kill, live.
   *
   * A list rather than a single player because a co-op squad is several men
   * standing in different places: each bot picks its own out of this, so a
   * player off on a flank draws the men nearest him instead of being ignored
   * by a wave that has all decided to walk at somebody else. Single-player
   * passes a list of one and behaves exactly as it always did.
   *
   * Held by reference — the owner mutates the entries in place — and may be
   * empty, which is how "nobody left alive" reaches the AI.
   */
  targets: BotTarget[];
  /** Where bots head when they have no contact. */
  objective: THREE.Vector3;
  /** Bot wants to shoot at the given world point. */
  onFire: (bot: Bot, tx: number, ty: number, tz: number) => void;
  /** Bot is tearing at a voxel. */
  onBreach: (bot: Bot, x: number, y: number, z: number) => void;
  /** Bot wants to place a blueprint block. False means the placement was refused. */
  onBuild: (bot: Bot, x: number, y: number, z: number, color: number, material: Mat) => boolean;
  /**
   * Bot wants a voxel gone outright rather than worn down: the shaft a tunnel
   * rat cuts to come up through. Breaching a wall is a fight with it; this is
   * a spade in soft earth, and the timing of an ambush can't wait on hit points.
   */
  onDig: (bot: Bot, x: number, y: number, z: number) => void;
  /**
   * Earth moving where a burrower is passing underneath, or the spray as one
   * comes up. Presentation only — the server has no use for it.
   */
  onSpoil?: (bot: Bot, x: number, y: number, z: number, strength: number) => void;
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
  /**
   * The tunnels under the valley. Burrowers travel between its mouths and cut
   * new ones as they go, so this grows over a run.
   */
  tunnels: TunnelNetwork;
  /**
   * 0..1 — how badly the valley wants the player dead, driven by what the
   * player has done to the people in it. Raises the horde's willingness to
   * push, and how close to your boots the tunnel rats will surface.
   */
  aggression: number;
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

  /**
   * Living enemies that belong to a wave.
   *
   * Garrisons are excluded on purpose: they are standing on the map before the
   * first wave arrives and they are still standing after it is beaten, so
   * counting them would leave the wave permanently uncleared and the run
   * permanently in combat.
   */
  get livingWaveCount(): number {
    let n = 0;
    for (const b of this.bots) if (b.alive && !b.garrison) n++;
    return n;
  }

  /** Living men posted at outposts, which is what a raid's field cap gives way to. */
  get livingGarrisonCount(): number {
    let n = 0;
    for (const b of this.bots) if (b.alive && b.garrison) n++;
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
          if (slot.def.burrower) this.enterGround(slot);
          return slot;
        }
      }
    }
    return null;
  }

  /**
   * Posts one man at an outpost.
   *
   * Same placement search as a wave spawn, then everything that makes him a
   * garrison rather than an attacker: he holds ground instead of walking to the
   * objective, he starts in his own camp's squad rather than whichever one the
   * last wave left half-full, and he stays off the minimap until he gives
   * himself away.
   */
  spawnGuard(
    kind: BotKind,
    x: number, y: number, z: number,
    hpMul: number, dmgMul: number,
    post: { x: number; z: number; radius: number },
  ): Bot | null {
    // Under a roof is no use to anybody. A man posted inside the lean-to or in
    // the lee of the berm has his own eyeline in a wall, and a sentry who
    // cannot see out is not a sentry -- so the spot is checked for standing
    // room *and* headroom before anyone is put in it.
    const spot = this.openStandingSpot(x, y, z);
    if (spot === null) return null;

    const bot = this.spawn(kind, spot.x, y, spot.z, hpMul, dmgMul);
    if (bot === null) return null;
    // The pool's own search starts at the top of the column, which in jungle is
    // the canopy. Put him where the camp actually is.
    bot.position.set(spot.x, spot.y, spot.z);

    bot.garrison = true;
    bot.postX = post.x;
    bot.postZ = post.z;
    bot.postRadius = post.radius;
    bot.state = BotState.Guard;
    bot.revealed = false;
    // Facing outward from the fire, which is where a man on watch stands.
    bot.yaw = Math.atan2(bot.position.x - post.x, bot.position.z - post.z);
    bot.desiredYaw = bot.yaw;
    this.squads.assignPost(bot, post.x, post.z);
    return bot;
  }

  /**
   * Nearest column to (x, z) with a man's worth of open air over it.
   *
   * `findStandingY` only asks for two clear blocks, which is enough to walk
   * through and not enough to see from: a bot is 2.7 tall and its eye sits at
   * the top of that, so a spot with a roof three blocks up puts the eye inside
   * the roof. Everything posted at an outpost goes through here instead.
   */
  private openStandingSpot(x: number, yHint: number, z: number): { x: number; y: number; z: number } | null {
    const world = this.ctx.world;
    const cx = Math.floor(x);
    const cz = Math.floor(z);
    for (let r = 0; r <= 3; r++) {
      for (let oz = -r; oz <= r; oz++) {
        for (let ox = -r; ox <= r; ox++) {
          if (r > 0 && Math.abs(ox) !== r && Math.abs(oz) !== r) continue;
          const fx = cx + ox;
          const fz = cz + oz;
          if (fx < 3 || fz < 3 || fx >= WORLD_X - 3 || fz >= WORLD_Z - 3) continue;
          // Searched from the camp floor rather than from the top of the
          // column: `surfaceHeight` in jungle is the canopy, and a sentry
          // standing in the treetops is neither a sentry nor believable.
          const y = findStandingY(world, fx, fz, yHint, 1, 3);
          if (y < 0) continue;
          // Head and a hand's width above it: clear of thatch, clear of eaves.
          if (world.isSolid(fx, y + 2, fz) || world.isSolid(fx, y + 3, fz)) continue;
          return { x: fx + 0.5, y, z: fz + 0.5 };
        }
      }
    }
    return null;
  }

  clear(): void {
    for (const b of this.bots) b.active = false;
    this.squads.clear();
    for (const h of this.ctx.tunnels.holes) {
      h.claimedBy = -1;
      h.cooldown = 0;
    }
    this.aliveCount = 0;
    this.mesh.count = 0;
  }

  /**
   * Puts a freshly spawned burrower where it belongs, which is not on the walk
   * in with everybody else.
   *
   * It starts under the ground at one of the far mouths, so its first
   * appearance is out of a hole rather than over the treeline — and so it has
   * a plausible amount of ground to cover before it gets anywhere, which is
   * what gives the player the spoil trail to read.
   */
  private enterGround(bot: Bot): void {
    const tunnels = this.ctx.tunnels;
    const mark = bot.target ?? this.nearestTarget(bot) ?? null;
    const px = mark !== null ? mark.pos.x : this.ctx.objective.x;
    const pz = mark !== null ? mark.pos.z : this.ctx.objective.z;

    // Somewhere out in the network, back from the target but within a trip the
    // gallery speed can actually make — a rat that enters the ground eighty
    // blocks out now spends most of a minute getting anywhere, which is a rat
    // the player never meets.
    let best: SpiderHole | null = null;
    let bestScore = -Infinity;
    for (const h of tunnels.holes) {
      const d = Math.hypot(h.standX - px, h.standZ - pz);
      if (d < 28) continue;
      const score = -Math.abs(d - 45) + this.rand() * 18;
      if (score <= bestScore) continue;
      bestScore = score;
      best = h;
    }

    if (best !== null) {
      bot.position.set(best.x, best.floorY, best.z);
    } else {
      // No network out here yet — go under where it stands.
      bot.position.y = tunnelY(this.ctx.world, bot.position.x, bot.position.z);
    }

    bot.state = BotState.Burrow;
    bot.submerged = 1;
    bot.hasExit = false;
    bot.exitHole = -1;
    bot.burrowTime = 0;
    bot.ambushHold = 0;
    bot.grounded = true;
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

    // A bot shot from behind still knows roughly where it came from, and the
    // man it was fighting is the best guess it has. One that had nobody yet
    // takes the nearest, which is the same guess the horde used to make.
    const seen = bot.target ?? this.nearestTarget(bot);
    if (seen !== null && seen.alive && bot.squad !== null && !bot.squad.hasContact) {
      bot.squad.report(seen.pos.x, seen.eyeY, seen.pos.z);
      // Second-hand intel, so don't let it masquerade as a live sighting.
      bot.squad.contactAge = CONTACT_MEMORY * 0.5;
    }

    if (bot.hp <= 0) {
      bot.hp = 0;
      // Whatever mouth it had called is free again the moment it goes down,
      // or the network slowly locks itself shut over a long run.
      if (bot.def.burrower) this.ctx.tunnels.release(this.bots.indexOf(bot));
      bot.submerged = 0;
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
    this.ctx.onVoice(bot, VoiceCue.Hurt);
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
    ctx.tunnels.update(dt);
    this.coverBudget = COVER_BUDGET;
    this.tickCursor = (this.tickCursor + 1) % SIGHT_STRIDE;
    this.computeSeparation();

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
      // Men whose whole job is to shoot from behind something re-sign it as
      // long as the position is still working, so a firing line stays a firing
      // line instead of dissolving into a walk every few seconds.
      if (bot.inCover) {
        bot.coverTimer -= dt;
        if (bot.coverTimer <= 0) {
          const holds = bot.coverQuality === 2 && bot.sightAge < 5
            && (bot.def.coverSeek > 0.5 || bot.role === BotRole.Support);
          if (holds) bot.coverTimer = 3 + this.rand() * 4;
          else bot.inCover = false;
        }
      }
      if (!bot.inCover) {
        bot.peeking = false;
        bot.peekTimer = 0;
      }
      // Stand by default; only a bot settled behind a parapet asks to duck.
      bot.crouchTarget = 0;

      // Movement is applied straight to `position` by tryMove, so the gait is
      // measured from where the bot actually ended up rather than from a
      // velocity it never stores.
      const wasX = bot.position.x;
      const wasZ = bot.position.z;

      if (!bot.burrowing) bot.surfaceTime += dt;

      // Who this man is fighting is his own decision, so the whole tick below
      // — what he can see, where he moves, what he shoots at — runs against
      // his target rather than against a single player the horde shares.
      this.retarget(bot, dt);
      const t = bot.target;
      const px = t !== null ? t.pos.x : ctx.objective.x;
      const py = t !== null ? t.eyeY : ctx.objective.y;
      const pz = t !== null ? t.pos.z : ctx.objective.z;

      this.perceive(bot, dt, i, px, py, pz);
      this.decide(bot);
      this.chatter(bot);
      this.act(bot, dt, px, py, pz);
      // Gravity is for men standing on the ground. A burrower drives its own
      // height off the tunnel depth and the rise out of the shaft, and running
      // the faller over it would either drop it through the map or surface it
      // mid-trip.
      if (!bot.burrowing) this.applyPhysics(bot, dt);

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
  // Target selection
  // -------------------------------------------------------------------------
  /**
   * Nearest living man to this bot, by ground distance.
   *
   * Ground distance and not "closest to the objective": the question a
   * rifleman actually answers is which of them he can reach, and ranking by
   * the base would put the whole horde onto one player again the moment
   * somebody stepped inside the wire.
   */
  private nearestTarget(bot: Bot): BotTarget | null {
    let best: BotTarget | null = null;
    let bestDist = Infinity;
    for (const t of this.ctx.targets) {
      if (!t.alive) continue;
      const dx = t.pos.x - bot.position.x;
      const dz = t.pos.z - bot.position.z;
      const d = dx * dx + dz * dz;
      if (d >= bestDist) continue;
      bestDist = d;
      best = t;
    }
    return best;
  }

  /**
   * Settles who this bot is fighting.
   *
   * Three rules, in order. A man who is dead or gone stops being a target
   * immediately, whatever the clock says. A bot with eyes on someone keeps
   * him -- the problem in front of you is the problem, and a horde that
   * re-optimises mid-firefight reads as broken rather than as clever. Failing
   * both, it takes the nearest, but only if that man is enough nearer than the
   * one it already had to be worth turning around for.
   */
  private retarget(bot: Bot, dt: number): void {
    bot.retargetTimer -= dt;

    let cur = bot.target;
    if (cur !== null && (!cur.alive || this.ctx.targets.indexOf(cur) < 0)) {
      cur = bot.target = null;
      bot.retargetTimer = 0;
    }
    if (cur !== null && bot.retargetTimer > 0) return;
    // Staggered, so a wave doesn't re-decide in lockstep.
    bot.retargetTimer = RETARGET_INTERVAL * (0.7 + this.rand() * 0.6);
    if (cur !== null && bot.seesTarget) return;

    const best = this.nearestTarget(bot);
    if (best === null || cur === null) {
      bot.target = best;
      return;
    }
    if (best === cur) return;

    const bdx = best.pos.x - bot.position.x;
    const bdz = best.pos.z - bot.position.z;
    const cdx = cur.pos.x - bot.position.x;
    const cdz = cur.pos.z - bot.position.z;
    const bestDist = bdx * bdx + bdz * bdz;
    const curDist = cdx * cdx + cdz * cdz;
    // Squared throughout, so the margin is squared with it.
    if (bestDist < curDist * RETARGET_HYSTERESIS * RETARGET_HYSTERESIS) bot.target = best;
  }

  // -------------------------------------------------------------------------
  // Perception
  // -------------------------------------------------------------------------
  private perceive(bot: Bot, dt: number, index: number, px: number, py: number, pz: number): void {
    const ctx = this.ctx;
    const def = bot.def;
    // A bot that has deliberately ducked below its own parapet hasn't lost the
    // target, it has stopped looking at it. Ageing the sighting through the
    // down half of the peek cycle would have slow-firing archetypes decide the
    // player had gone and walk out from behind the wall to check.
    const hiding = bot.inCover && bot.crouch > 0.5 && !bot.peeking;
    if (!hiding) bot.sightAge += dt;

    const target = bot.target;
    if (target === null || !target.alive) {
      this.forget(bot, dt);
      return;
    }

    // Head still in the dirt. There is nothing to see from down here, and more
    // to the point a rat that could see out of the ground would be shooting
    // through it.
    if (bot.underground) {
      this.forget(bot, dt);
      return;
    }

    const dist = Math.hypot(px - bot.position.x, pz - bot.position.z);
    // Bots notice you further out than they'll shoot, so they can start moving.
    if (dist > def.maxRange + 14) {
      this.forget(bot, dt);
      return;
    }

    // Standing rice is concealment. It stops nothing -- rounds go through it
    // and so does everybody -- but a man who gets down in a grown plot is
    // under the crop, and from any distance the field is just a field. The
    // stance test is free: `py` is the player's eye, which drops nearly a
    // metre on crouching, so this asks the only question that matters, which
    // is whether his head is above the rice or in it.
    if (dist > RICE_SPOT_RANGE && riceConceals(px, pz, py)) {
      this.forget(bot, dt);
      return;
    }

    // Line of sight is the expensive half, so it stays on its rota and every
    // frame in between works off the last answer.
    if (index % SIGHT_STRIDE === this.tickCursor) {
      bot.hasLos = hasLineOfSight(
        ctx.world, bot.position.x, bot.eyeY, bot.position.z, px, py, pz,
      );
    }

    // ...and the cheap half is where you are relative to the way he is facing.
    // Being behind a man is the whole game out here: the cone is narrow enough
    // that crossing in front of a sentry is a decision and crossing behind one
    // is a route.
    const cone = bot.alerted ? VIEW_CONE_ALERT : VIEW_CONE;
    const looking = bot.hasLos
      && inViewCone(bot.yaw, bot.position.x, bot.position.z, px, pz, cone);

    if (!looking) {
      this.forget(bot, dt);
      return;
    }

    // He has you in his arc. What happens next is arithmetic: how much of you
    // there is to see, how far away it is, and whether anyone has already told
    // him where to look.
    const squad = bot.squad;
    const told = squad !== null && squad.hasContact ? SQUAD_CONTACT_SCALE : 1;
    const vis = target.visibility ?? 1;
    bot.awareness = Math.min(1, bot.awareness + SPOT_RATE * vis * rangeFactor(dist) * told * dt);

    if (bot.awareness < 1) {
      // Not there yet -- but he is turning his head, and that is the only
      // warning the player gets. Engineering and burrowing bots keep their
      // heads where their work is.
      if (bot.awareness >= SUSPICIOUS && !bot.working && !bot.underground) {
        bot.desiredYaw = Math.atan2(px - bot.position.x, pz - bot.position.z);
      }
      bot.seesTarget = false;
      bot.aimHeld = 0;
      return;
    }

    const saw = bot.seesTarget;
    bot.seesTarget = true;
    if (!saw) {
      // Fresh contact: the archetype's reaction time has to run out first.
      // Coming back up from behind a wall isn't fresh contact, though -- the
      // bot already knows where you are and has its weapon there, so it pays a
      // fraction of the reaction and keeps most of its settled aim.
      const reacquire = bot.sightAge < 3.5;
      bot.reactionTimer = def.reaction * (reacquire ? 0.3 : 1) * (0.7 + this.rand() * 0.6);
      bot.aimHeld = reacquire ? def.aimTime * 0.5 : 0;
      bot.aimPoint.set(px, py, pz);
      if (!reacquire) ctx.onVoice(bot, VoiceCue.Contact);
      this.raiseAlarm(bot);
    }
    bot.sightAge = 0;
    bot.aimHeld += dt;
    squad?.report(px, py, pz);
  }

  /**
   * Nothing to see. Bleeds awareness back down.
   *
   * An alerted man keeps most of it: he has already shouted, and men who have
   * shouted do not go back to wondering. That asymmetry is what makes the first
   * few seconds of an approach the ones that matter, and everything after
   * contact a fight rather than a stealth puzzle.
   */
  private forget(bot: Bot, dt: number): void {
    bot.seesTarget = false;
    bot.aimHeld = 0;
    const rate = FORGET_RATE * (bot.alerted ? ALERT_FORGET_SCALE : 1);
    bot.awareness = Math.max(0, bot.awareness - rate * dt);
  }

  /**
   * This bot is now certain, and everything downstream of that happens here:
   * it stops being a shape in the trees on the minimap, it stays switched on
   * for the rest of its life, and the men it is posted with are pulled up with
   * it. A camp is a unit -- one sentry seeing you is the camp seeing you.
   */
  private raiseAlarm(bot: Bot): void {
    bot.alerted = true;
    bot.revealed = true;
    bot.awareness = 1;
    const squad = bot.squad;
    if (squad === null) return;
    for (const mate of squad.members) {
      if (mate === bot || !mate.alive) continue;
      // Not full contact -- he has been shouted at, not shown. He turns, he
      // comes, and he finds you himself.
      mate.awareness = Math.max(mate.awareness, 0.75);
      mate.alerted = true;
      mate.revealed = true;
    }
  }

  /**
   * Something loud happened at (x, z).
   *
   * Sound is the one thing that goes through the ground: a shot fired outside a
   * camp wakes it whether or not anybody was facing that way, which is what
   * stops "crouch and shoot everything" from being a stealth build. `strength`
   * scales what a man at the centre of it makes of the noise -- a rifle is not
   * a footstep, and neither is a spade.
   */
  hearNoise(x: number, z: number, radius: number, strength = 1): void {
    for (const bot of this.bots) {
      if (!bot.alive) continue;
      const heard = noiseFalloff(Math.hypot(bot.position.x - x, bot.position.z - z), radius);
      if (heard <= 0) continue;
      const before = bot.awareness;
      bot.awareness = Math.min(1, bot.awareness + heard * strength);
      // A noise tells you a direction, not a target: he looks that way and
      // goes to check, but he still has to find you with his eyes.
      if (!bot.working && !bot.underground && bot.awareness > SUSPICIOUS && !bot.seesTarget) {
        bot.desiredYaw = Math.atan2(x - bot.position.x, z - bot.position.z);
      }
      if (bot.awareness >= 1 && before < 1) {
        bot.squad?.report(x, bot.position.y + 1.5, z);
        this.raiseAlarm(bot);
      }
    }
  }

  /** The most any one enemy has put together, and whether anybody is certain. */
  get detection(): { level: number; spotted: boolean } {
    let level = 0;
    let spotted = false;
    for (const bot of this.bots) {
      if (!bot.alive) continue;
      if (bot.seesTarget) spotted = true;
      if (bot.awareness > level) level = bot.awareness;
    }
    return { level, spotted };
  }

  // -------------------------------------------------------------------------
  // Decision
  // -------------------------------------------------------------------------
  private decide(bot: Bot): void {
    const squad = bot.squad;

    // Anything happening below the surface owns the bot outright: coming up
    // and going down are commitments, not preferences, and a rat halfway out
    // of a hole has no business reconsidering.
    if (bot.state === BotState.Emerge || bot.state === BotState.Submerge) return;
    if (bot.state === BotState.Burrow) return;

    // Surfaced, and done here: a magazine's worth of work, or too long in the
    // open, or hurt. Back down the hole and come up somewhere else. Standing
    // and trading is what every other archetype is for.
    if (bot.def.burrower && this.wantsToSubmerge(bot)) {
      this.beginSubmerge(bot);
      return;
    }

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
      // A garrison hunts, but only as far as its own ground. Past that it
      // turns round and goes back: five camps that empty into the valley the
      // moment one of them hears a shot is one big wave with extra steps, and
      // the whole point of a camp is that it is still there when you come back.
      if (!bot.garrison || this.nearPost(bot, bot.postRadius + 24)) {
        bot.state = BotState.Hunt;
        return;
      }
    }
    bot.state = bot.garrison ? BotState.Guard : BotState.Advance;
  }

  /** True while a garrison bot is inside `slack` blocks of the post it holds. */
  private nearPost(bot: Bot, slack: number): boolean {
    return Math.hypot(bot.postX - bot.position.x, bot.postZ - bot.position.z) <= slack;
  }

  /**
   * Idle chatter, which is the half of this that isn't reactive: men walking
   * onto an objective talk to each other, and hearing that from behind a ridge
   * is the only warning you get before a squad comes over it.
   */
  private chatter(bot: Bot): void {
    if (bot.voiceTimer > 0) return;
    if (bot.state !== BotState.Advance && bot.state !== BotState.Hunt
      && bot.state !== BotState.Guard) return;
    this.ctx.onVoice(bot, VoiceCue.Advance);
  }

  // -------------------------------------------------------------------------
  // Action
  // -------------------------------------------------------------------------
  private act(bot: Bot, dt: number, px: number, py: number, pz: number): void {
    switch (bot.state) {
      case BotState.Burrow:
        this.burrow(bot, dt, px, pz);
        return;
      case BotState.Emerge:
        this.emerge(bot, dt, px, py, pz);
        return;
      case BotState.Submerge:
        this.submerge(bot, dt);
        return;
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
      case BotState.Guard:
        this.guard(bot, dt);
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

  /**
   * Manning a post.
   *
   * This bot has no idea where the player is -- that is entirely the perception
   * system's business. What it decides is where a man who is waiting happens to
   * be looking, and that is the only reason sneaking past one is possible at
   * all: a sentry who swept a full circle every second would be a turret.
   *
   * He drifts between spots inside his camp, stops, looks somewhere else, and
   * spends most of his time facing outward -- toward the trees, which is where
   * he expects trouble to come from and where the player usually is.
   */
  private guard(bot: Bot, dt: number): void {
    const dx = bot.postX - bot.position.x;
    const dz = bot.postZ - bot.position.z;
    const home = Math.hypot(dx, dz);

    // Wandered off, or came back from a fight: walk in before doing anything.
    if (home > bot.postRadius) {
      bot.hasMoveTarget = false;
      this.trackProgress(bot, dt);
      this.move(bot, dt, dx / Math.max(1e-4, home), dz / Math.max(1e-4, home), 0.72);
      return;
    }

    bot.scanTimer -= dt;
    if (bot.scanTimer <= 0) {
      bot.scanTimer = 2.4 + this.rand() * 4.5;
      if (this.rand() < 0.4) {
        // Shift position: somewhere else inside the berm.
        const a = this.rand() * Math.PI * 2;
        const r = bot.postRadius * (0.25 + this.rand() * 0.6);
        bot.moveTargetX = bot.postX + Math.cos(a) * r;
        bot.moveTargetZ = bot.postZ + Math.sin(a) * r;
        bot.hasMoveTarget = true;
      } else {
        // Stand and look. Biased outward from the middle of the camp, with a
        // wide wobble on it -- a sentry watches the treeline, not the fire.
        bot.hasMoveTarget = false;
        const out = home > 0.6
          ? Math.atan2(-dx, -dz)
          : this.rand() * Math.PI * 2;
        bot.desiredYaw = out + (this.rand() - 0.5) * 2.2;
      }
    }

    if (!bot.hasMoveTarget) return;

    const mx = bot.moveTargetX - bot.position.x;
    const mz = bot.moveTargetZ - bot.position.z;
    const md = Math.hypot(mx, mz);
    if (md < 0.9) {
      bot.hasMoveTarget = false;
      return;
    }
    this.move(bot, dt, mx / md, mz / md, 0.42);
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

    // In contact in the open? Find something to get behind. Rationed so a
    // whole wave taking fire at once can't spike the frame.
    //
    // Waiting to be shot at first means every bot spends its opening seconds
    // standing in a field, which is where they die. Anything with more than a
    // token instinct for cover looks for it the moment it has a target.
    if (bot.repositionTimer <= 0 && this.coverBudget > 0 && !bot.hasMoveTarget && !bot.inCover) {
      bot.repositionTimer = 0.35 + this.rand() * 0.5;
      const wantsCover = bot.pressure > 0.12 || def.coverSeek > 0.25;
      if (wantsCover) {
        this.coverBudget--;
        const here = rateCover(
          this.ctx.world, bot.position.x, bot.position.y, bot.position.z,
          def.height, px, py, pz,
        );
        const exposed = here === 0;
        if (!exposed) {
          // Already behind something. Walking off to look for better cover
          // when there's a wall right here is how a bot ends up crossing open
          // ground to reach a rock it was standing next to.
          bot.inCover = true;
          bot.coverQuality = here;
          bot.coverTimer = 3.5 + def.coverSeek * 5 + this.rand() * 3;
          bot.peeking = false;
          bot.peekTimer = 0.15 + this.rand() * 0.3;
        } else if (findCoverSpot(this.ctx.world, bot, px, py, pz, toX, toZ, coverOut)) {
          bot.moveTargetX = coverOut.x;
          bot.moveTargetZ = coverOut.z;
          bot.hasMoveTarget = true;
          // Claim it now: the bot has to stop when it arrives, or it walks
          // straight through its own cover and back into the open.
          bot.inCover = true;
          bot.coverQuality = coverOut.quality;
          // The lease is time spent fighting from the position, so it's timed
          // from arrival — see the move-target block below. This only has to
          // outlast the walk.
          bot.coverTimer = 3 + def.coverSeek * 5 + this.rand() * 3;
        } else if (this.canBuildNow(bot)) {
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
    if (bot.inCover && !bot.hasMoveTarget) this.workCover(bot, dt);

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
        // Arrived: the lease covers the fight, not the walk to it. Start the
        // cycle down behind the wall — a man reaching cover gets behind it
        // first and looks second.
        if (bot.inCover) {
          bot.coverTimer = 3.5 + def.coverSeek * 5 + this.rand() * 3;
          bot.peeking = false;
          bot.peekTimer = 0.2 + this.rand() * 0.35;
        }
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

  /**
   * Runs the duck-and-peek cycle for a bot settled behind something it can
   * shoot over.
   *
   * Default is down. The bot comes up only when it's actually ready to fire and
   * drops again the moment the burst is away, so the seconds it's exposed are
   * the seconds it's shooting — and because ducking really does shorten the
   * body (see Bot.poseHeight), that window is the only one either of you has.
   *
   * Cover you can't shoot over is left alone: a bot fully hidden by a wall is
   * already safe standing, and bobbing behind it would just be a man doing
   * press-ups at the enemy.
   */
  private workCover(bot: Bot, dt: number, downScale = 1): void {
    if (bot.coverQuality !== 2) return;

    bot.peekTimer -= dt;

    if (bot.peeking) {
      bot.crouchTarget = 0;
      // Down again once the burst is away. The timer is a floor on how long
      // it stays up, so a bot that comes up isn't back down before its shot.
      if (bot.peekTimer <= 0 && bot.burstLeft === 0) {
        bot.peeking = false;
        bot.peekTimer = (0.5 + this.rand() * 0.7) * downScale;
      }
      return;
    }

    bot.crouchTarget = 1;
    // Ready means the weapon is off cooldown — the fire timer keeps running
    // while the bot is hidden, so the cycle is paced by the weapon rather than
    // adding a second clock on top of it.
    const ready = bot.burstLeft > 0 || (bot.fireTimer <= 0.3 && bot.reactionTimer <= 0);
    if (bot.peekTimer <= 0 && ready) {
      bot.peeking = true;
      bot.peekTimer = 0.5 + this.rand() * 0.45;
    }
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
      // Made it. Stay down and let the health situation improve — a hurt man
      // keeps his head down longer between shots than a fresh one.
      dirX = 0;
      dirZ = 0;
      this.workCover(bot, dt, 1.6);
    }

    this.move(bot, dt, dirX, dirZ, 1.15);
  }

  // -------------------------------------------------------------------------
  // Burrowing
  // -------------------------------------------------------------------------
  /**
   * Is this rat done up here?
   *
   * A tunnel rat's whole proposition is that it is somewhere it shouldn't be
   * for a few seconds and then it isn't there any more. Left to fight it out
   * like a rifleman it is just a weak rifleman, so the decision to go back down
   * is made on a magazine and a clock rather than on how the fight is going —
   * the one exception being a man who is hit, who goes down immediately.
   */
  private wantsToSubmerge(bot: Bot): boolean {
    if (bot.state === BotState.Engage || bot.state === BotState.Hunt
      || bot.state === BotState.Advance || bot.state === BotState.Regroup) {
      if (bot.hurt) return true;
      if (bot.shotsUp >= BURSTS_PER_TRIP) return true;
      if (bot.surfaceTime > SURFACE_DWELL) return true;
      // Came up on nothing: the target has moved, or was never there. Don't
      // stand in the open working it out, and above all don't start walking at
      // the base like a rifleman — go back down and pick another hole.
      if (bot.surfaceTime > 2.5 && bot.sightAge > 2) return true;
    }
    return false;
  }

  /**
   * Drops out of the fight and into the ground, cutting a shaft on the spot if
   * there isn't a mouth to hand.
   *
   * Going down where you stand is the point: the hole appears under the man,
   * which is both the fantasy and — because the shaft is real voxels that stay
   * cut — a mouth the player can find, watch, or drop a grenade into later.
   */
  private beginSubmerge(bot: Bot): void {
    const tunnels = this.ctx.tunnels;

    // A mouth within a stride is worth using rather than cutting another.
    let hole = tunnels.nearest(bot.position.x, bot.position.z, 5);
    if (hole === null) {
      hole = this.cutShaft(bot, bot.position.x, bot.position.z);
      if (hole === null) {
        // Steel plate, bedrock, water, or a hole nobody could climb out of.
        // Nothing to dig, so it has to fight after all — which is the point at
        // which a firebase with a proper floor stops being ambushable.
        bot.shotsUp = 0;
        bot.surfaceTime = 0;
        bot.state = BotState.Engage;
        return;
      }
    }

    // Drop into the shaft itself, not the ground beside it.
    bot.position.x = hole.x;
    bot.position.z = hole.z;
    bot.position.y = hole.y;

    bot.state = BotState.Submerge;
    bot.submerged = 0;
    bot.hasExit = false;
    bot.hasMoveTarget = false;
    bot.inCover = false;
    bot.burstLeft = 0;
    bot.clearJobs();
  }

  /** Sinking out of sight. */
  private submerge(bot: Bot, dt: number): void {
    const rise = bot.def.height + 0.4;
    const base = bot.position.y + rise * bot.submerged;

    bot.submerged = Math.min(1, bot.submerged + dt / SUBMERGE_TIME);
    bot.position.y = base - rise * bot.submerged;
    bot.velocity.set(0, 0, 0);
    this.ctx.onSpoil?.(bot, bot.position.x, base, bot.position.z, 0.6);

    if (bot.submerged < 1) return;
    bot.state = BotState.Burrow;
    bot.burrowTime = 0;
    bot.hasExit = false;
    bot.exitHole = -1;
    bot.velocity.set(0, 0, 0);
  }

  /**
   * Moving through the earth toward somewhere worth coming up.
   *
   * There is no pathfinding down here and there deliberately isn't: below the
   * surface there is nothing to path around, so the rat goes in a straight line
   * at digging speed and the only decision that matters is which mouth. What
   * the player gets instead of a route is the spoil — earth turning over along
   * the ground above the line of travel, which is the one warning the whole
   * archetype gives you.
   */
  private burrow(bot: Bot, dt: number, px: number, pz: number): void {
    bot.burrowTime += dt;
    bot.seesTarget = false;
    bot.aimValid = false;
    bot.burstLeft = 0;
    bot.submerged = 1;

    if (!bot.hasExit && !this.chooseExit(bot, px, pz)) {
      // Nowhere to come up near the target. Keep moving toward them under the
      // ground and try again shortly; the network grows as the run goes on.
      //
      // Unless it has been down there far too long — a rat that can never find
      // an exit (target sealed inside steel, or standing in the river) would
      // otherwise tunnel back and forth under them for the rest of the run.
      // Coming up somewhere useless at least puts it back in the game.
      if (bot.burrowTime > BURROW_PATIENCE) {
        bot.burrowTime = 0;
        if (this.surfaceInPlace(bot)) return;
      }
      const dx = px - bot.position.x;
      const dz = pz - bot.position.z;
      const d = Math.max(1e-4, Math.hypot(dx, dz));
      // Nowhere known to head for, so this is all fresh ground.
      this.burrowStep(bot, dt, dx / d, dz / d, true);
      return;
    }

    const dx = bot.exitX - bot.position.x;
    const dz = bot.exitZ - bot.position.z;
    const d = Math.hypot(dx, dz);

    if (d > 0.9) {
      // Making for a mouth that already exists is a trip through the network;
      // making for one that doesn't is a trip the rat has to dig.
      this.burrowStep(bot, dt, dx / d, dz / d, bot.exitHole < 0);
      return;
    }

    // Under the mouth. Wait on the squad's clock so a fireteam comes up in one
    // movement rather than feeding itself into the fight a man at a time.
    bot.position.x = bot.exitX;
    bot.position.z = bot.exitZ;
    if (bot.ambushHold <= 0) {
      const squad = bot.squad;
      if (squad !== null) {
        if (squad.ambushTimer <= 0) squad.ambushTimer = 0.7 + this.rand() * 1.3;
        // Whoever gets there late inherits what's left of the clock, so
        // everyone still comes up on the same beat.
        bot.ambushHold = Math.max(0.15, squad.ambushTimer);
      } else {
        bot.ambushHold = 0.2 + this.rand() * 0.3;
      }
    }

    bot.ambushHold -= dt;
    if (bot.ambushHold > 0) return;

    bot.state = BotState.Emerge;
    bot.reactionTimer = bot.def.reaction * 0.5;
  }

  /**
   * Comes up wherever the rat happens to be, useful or not.
   *
   * The escape hatch for a burrower that can't find anywhere worth surfacing.
   * Better a man in the wrong place than a man permanently under the map.
   */
  private surfaceInPlace(bot: Bot): boolean {
    const cut = this.cutShaft(bot, bot.position.x, bot.position.z);
    if (cut === null) return false;
    bot.exitHole = this.ctx.tunnels.holes.indexOf(cut);
    bot.exitX = cut.x;
    bot.exitZ = cut.z;
    bot.hasExit = true;
    bot.state = BotState.Emerge;
    return true;
  }

  /**
   * One step of underground travel: no collision, riding the tunnel depth.
   *
   * `digging` is the difference between cutting new ground and running down a
   * gallery that is already there, and it is most of what the player feels —
   * it sets both how long the rat takes and whether it throws spoil where they
   * can see it.
   */
  private burrowStep(
    bot: Bot, dt: number,
    dirX: number, dirZ: number,
    digging: boolean,
  ): void {
    const world = this.ctx.world;
    const base = digging ? BURROW_DIG_SPEED : BURROW_GALLERY_SPEED;
    // Angry men work faster, at either job. Anger is the only thing that lifts
    // it: at rest the dig rate is exactly the 1.5x above, so the comparison
    // with the player's spade holds as written.
    const speed = base * (1 + this.ctx.aggression * 0.35);
    bot.position.x = Math.max(3, Math.min(WORLD_X - 4, bot.position.x + dirX * speed * dt));
    bot.position.z = Math.max(3, Math.min(WORLD_Z - 4, bot.position.z + dirZ * speed * dt));
    bot.position.y = tunnelY(world, bot.position.x, bot.position.z);
    bot.desiredYaw = Math.atan2(dirX, dirZ);
    bot.yaw = bot.desiredYaw;
    bot.grounded = true;
    bot.velocity.set(0, 0, 0);

    // Spoil on the surface above, and only while there is ground being moved:
    // a man walking down a finished tunnel turns nothing over. That makes the
    // trail mean something specific — somebody is cutting new ground toward
    // you, right now — rather than being a generic "enemy underground" tell.
    if (!digging) return;
    bot.trailTimer -= dt;
    if (bot.trailTimer > 0) return;
    bot.trailTimer = 0.07;
    const fx = Math.floor(bot.position.x);
    const fz = Math.floor(bot.position.z);
    const surface = this.ctx.world.surfaceHeight(fx, fz);
    this.ctx.onSpoil?.(bot, bot.position.x, surface + 1, bot.position.z, 0.35);
  }

  /**
   * Picks the mouth to come up out of, and cuts one if the network doesn't
   * reach far enough.
   *
   * The ring it wants is set by how angry the valley is: ordinarily they come
   * up at a respectful distance and shoot, but a player who has been working
   * through the village finds them surfacing close enough to hear.
   */
  private chooseExit(bot: Bot, px: number, pz: number): boolean {
    const tunnels = this.ctx.tunnels;
    const slot = this.bots.indexOf(bot);
    const rage = this.ctx.aggression;
    // Close. A rat that only ever surfaces at rifle range is a rifleman with a
    // gimmick — the threat is the one that comes up inside the wire, and the
    // second it spends climbing out is the counterplay.
    const minR = 6 - rage * 2;
    const maxR = 30 + rage * 14;

    // Come up off the squad's axis of advance, so a fireteam rings the target.
    const squad = bot.squad;
    let biasX = 0;
    let biasZ = 0;
    if (squad !== null) {
      const a = squad.approachBearing + (bot.boundPhase ? 1 : -1) * 1.1;
      biasX = Math.cos(a);
      biasZ = Math.sin(a);
    }

    // Coming up somewhere you can't see the target is coming up for nothing,
    // so a mouth with a clear line to them is worth going a long way past a
    // nearer one for. Measured from head height at the lip, which is where the
    // man's eyes will be a second later.
    const world = this.ctx.world;
    const eye = bot.def.height * 0.82;
    const targetEyeY = bot.target !== null ? bot.target.eyeY : this.ctx.objective.y;
    const sees = (hx: number, hy: number, hz: number): boolean => hasLineOfSight(
      world, hx, hy + eye, hz, px, targetEyeY, pz,
    );

    // First choice is a mouth already in the network that has a line to the
    // target. Second is cutting a fresh one that does. Only if neither exists
    // does it settle for a hole it can't shoot out of — because that trip is
    // worth something anyway: it moves the rat, and it cuts ground.
    let hole = tunnels.pickExit(px, pz, minR, maxR, slot, this.rand, biasX, biasZ, sees, true);
    if (hole === null && this.cutBlindExit(bot, px, pz, minR, maxR, sees)) return true;
    if (hole === null) hole = tunnels.pickExit(px, pz, minR, maxR, slot, this.rand, biasX, biasZ, sees);
    if (hole !== null) {
      bot.exitX = hole.x;
      bot.exitZ = hole.z;
      bot.exitHole = tunnels.holes.indexOf(hole);
      bot.hasExit = true;
      return true;
    }


    return this.cutBlindExit(bot, px, pz, minR, maxR, sees, false);
  }

  /**
   * Looks for somewhere to open a brand new shaft near the target.
   *
   * Samples a handful of columns rather than committing to the first, because
   * what's wanted is one that can be cut *and* has a line to the target from
   * head height. Ground inside the player's own wire qualifies, and that is the
   * whole reason the base floor is worth looking at.
   */
  private cutBlindExit(
    bot: Bot,
    px: number, pz: number,
    minR: number, maxR: number,
    sees: (x: number, y: number, z: number) => boolean,
    requireSee = true,
  ): boolean {
    const world = this.ctx.world;
    // Only once the rat is actually out there, or every rat would open its own
    // shaft at the spawn line and walk in from it like everybody else.
    if (Math.hypot(px - bot.position.x, pz - bot.position.z) > maxR + 6) return false;

    let fallbackX = 0;
    let fallbackZ = 0;
    let haveFallback = false;

    for (let i = 0; i < 8; i++) {
      const a = this.rand() * Math.PI * 2;
      const r = minR + this.rand() * Math.max(1, maxR - minR) * 0.5;
      const cx = Math.floor(px + Math.cos(a) * r) + 0.5;
      const cz = Math.floor(pz + Math.sin(a) * r) + 0.5;
      if (!canCutMouth(world, cx, cz)) continue;

      if (!haveFallback) {
        fallbackX = cx;
        fallbackZ = cz;
        haveFallback = true;
      }
      const groundY = world.surfaceHeight(Math.floor(cx), Math.floor(cz));
      if (!sees(cx, groundY, cz)) continue;
      bot.exitX = cx;
      bot.exitZ = cz;
      bot.exitHole = -1;
      bot.hasExit = true;
      return true;
    }

    if (requireSee || !haveFallback) return false;
    bot.exitX = fallbackX;
    bot.exitZ = fallbackZ;
    bot.exitHole = -1;
    bot.hasExit = true;
    return true;
  }

  /**
   * Coming up.
   *
   * The shaft is cut on the first frame of this and the body rises through it,
   * so for most of a second there is a man half out of the ground: visible,
   * hittable, and not yet shooting. That window is the price of the ambush and
   * it is meant to be payable — a player watching the spoil trail gets to
   * collect on it.
   */
  private emerge(bot: Bot, dt: number, px: number, py: number, pz: number): void {
    const tunnels = this.ctx.tunnels;

    if (bot.exitHole < 0) {
      // Fresh mouth: dig it at the moment of use, so the hole appears with the
      // man rather than being telegraphed a minute early.
      const cut = this.cutShaft(bot, bot.exitX, bot.exitZ);
      if (cut === null) {
        // Ground turned out to be undiggable. Go and find somewhere else.
        bot.hasExit = false;
        bot.state = BotState.Burrow;
        return;
      }
      bot.exitHole = tunnels.holes.indexOf(cut);
      bot.exitX = cut.x;
      bot.exitZ = cut.z;
      this.ctx.onVoice(bot, VoiceCue.Contact);
    }

    const hole = tunnels.holes[bot.exitHole];
    if (!hole) {
      bot.hasExit = false;
      bot.exitHole = -1;
      bot.state = BotState.Burrow;
      return;
    }

    // Rising through the shaft: drawn coming up out of the hole, with the body
    // still mostly in the ground until the last moment of it.
    const rise = bot.def.height + 0.4;
    bot.submerged = Math.max(0, bot.submerged - dt / EMERGE_TIME);
    bot.position.x = hole.x;
    bot.position.z = hole.z;
    bot.position.y = hole.y - rise * bot.submerged;
    bot.desiredYaw = Math.atan2(px - bot.position.x, pz - bot.position.z);
    bot.yaw = bot.desiredYaw;
    this.ctx.onSpoil?.(bot, hole.x, hole.y, hole.z, 0.8);

    // Aim comes up with the man, so the first burst is away the moment he is.
    this.updateAim(bot, dt, px, py, pz);

    if (bot.submerged > 0) return;

    // Out. He steps off the hole onto the lip — there is no floor in a hole,
    // and a man left standing on the shaft column would drop straight back
    // down the one he just came up.
    bot.position.set(hole.standX, hole.y, hole.standZ);
    bot.state = BotState.Engage;
    bot.surfaceTime = 0;
    bot.shotsUp = 0;
    bot.sightAge = 0;
    bot.aimHeld = bot.def.aimTime * 0.6;
    bot.hasExit = false;
    bot.lastProgressCost = 0x3fffffff;
    tunnels.markUsed(hole);
    bot.exitHole = -1;
  }

  /**
   * Opens a shaft from the gallery depth to daylight at (x, z), and registers
   * the mouth so the rest of the horde can use it afterwards.
   *
   * Returns false when the column can't be cut, which is what stops rats
   * appearing through the Core or out of the middle of the river.
   */
  private cutShaft(bot: Bot, x: number, z: number): SpiderHole | null {
    const world = this.ctx.world;
    if (!canCutMouth(world, x, z)) return null;

    const fx = Math.floor(x);
    const fz = Math.floor(z);
    const surface = world.surfaceHeight(fx, fz);
    const floor = Math.max(2, surface - TUNNEL_DEPTH);

    // Where the man will be standing when he's out. Found before the hole is
    // cut, because afterwards this column is a hole and nothing about it is
    // ground any more.
    const lip = findLip(world, fx, fz, surface);
    if (lip === null) return null;

    for (let y = floor; y <= surface; y++) {
      if (world.isSolid(fx, y, fz)) this.ctx.onDig(bot, fx, y, fz);
    }
    return this.ctx.tunnels.add(fx + 0.5, fz + 0.5, floor, lip.x, lip.y, lip.z, true);
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

    // A tunnel rat's answer to anything in its way is the same answer it has
    // to everything: go under it. Letting one stand at a wall chipping at it
    // turns the whole archetype into a bad sapper.
    if (def.burrower) {
      this.beginSubmerge(bot);
      return;
    }
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
      if (!a.alive || a.burrowing) continue;
      for (let j = i + 1; j < bots.length; j++) {
        const b = bots[j];
        if (!b.alive || b.burrowing) continue;
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
      // Lead whoever is actually on the end of this shot. A bot firing at a
      // squad's last-seen mark has no velocity to lead, and shouldn't borrow
      // somebody else's.
      const lead = bot.seesTarget ? bot.target : null;
      if (lead !== null) {
        tx += lead.vel.x * flight * skill;
        tz += lead.vel.z * flight * skill;
      }
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

    // Never shoot while nose-deep in a wall, nor with half a body still in
    // the ground.
    if (bot.state === BotState.Build || bot.state === BotState.Tunnel) return;
    if (bot.burrowing || bot.submerged > 0.02) return;

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

    // Weapon is ready but the man isn't up yet: a ducked bot is below its own
    // cover, so the round would go into the wall it's hiding behind. Holding
    // here rather than earlier is deliberate — the fire timer has to keep
    // running while the bot is down, because a ready weapon is what brings it
    // back up. See workCover.
    if (bot.inCover && bot.crouch > 0.5 && !bot.peeking) return;

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
    // A rat's trip up is measured in magazines, not seconds.
    if (def.burrower && !suppressing) bot.shotsUp++;
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
      //
      // The kind's four colours are the anchor and every one of them is moved
      // by this man's own rolls, so a squad of Raiders is a squad of men in
      // the same uniform rather than one man drawn eight times.
      const bodyCol = shade(def.bodyColor, bot.clothTone);
      const headCol = def.headColor;
      const hatCol = shade(def.hatColor, bot.hatTone);
      const legCol = shade(def.bodyColor, bot.clothTone * bot.legTone);
      const rigCol = shade(def.rigColor, bot.rigTone);
      // The hat's straw darkens as it narrows, so the cone reads as a cone
      // rather than a flat stack of identical slabs.
      const hatMid = shade(hatCol, 0.9);
      const hatTip = shade(hatCol, 0.8);
      const skinCol = SKIN[Math.min(SKIN.length - 1, Math.floor(bot.skinRoll * SKIN.length))];

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

      // Sleeves shoved up past the elbow and trousers cut off at the knee. Each
      // piece rides the limb it belongs to and sits a hair proud of it, so it
      // swings with the stride, sprawls with the body, and takes its share of
      // the blood without fighting the box underneath for depth.
      if (bot.sleevesUp) {
        const cuffY = shoulderY - 0.72 * s;
        parts.push(
          [-armSpread, cuffY, 0, 0.245 * s, 0.3 * s, 0.345 * s, skinCol,
            offArmPitch, shoulderY, 0],
          [armSpread, cuffY, 0, 0.245 * s, 0.3 * s, 0.345 * s, skinCol,
            armPitch, shoulderY, 0],
        );
      }
      if (bot.shorts) {
        const shinY = legY - legH * 0.28;
        parts.push(
          [-legSpread, shinY, 0, 0.245 * s, legH * 0.42, 0.405 * s, skinCol, legLeft, hipY, 0],
          [legSpread, shinY, 0, 0.245 * s, legH * 0.42, 0.405 * s, skinCol, legRight, hipY, 0],
        );
      }
      // The scarf is worn at the neck, so it turns with the head rather than
      // with the chest, and it goes down with the head when he does.
      if (bot.scarfRoll >= 0) {
        const scarfCol = SCARF[Math.min(SCARF.length - 1, Math.floor(bot.scarfRoll * SCARF.length))];
        parts.push(
          [0, neckY + 0.02 * s, 0, 0.62 * s, 0.16 * s, 0.56 * s, scarfCol, headPitch, neckY, 0],
        );
      }

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
