/**
 * The authoritative simulation.
 *
 * This deliberately imports the *same* modules the client renders with, from
 * `game/src`. `VoxelWorld`, `worldgen`, `NavGrid`, `BotManager` and
 * `WaveManager` carry no rendering code — the only three.js they touch is
 * `Vector3` maths, which runs fine headless — so the server and the client
 * agree by construction rather than by two implementations staying in step.
 *
 * The world itself is never sent over the wire. Terrain generation is a pure
 * function of the seed, so every client regenerates an identical world locally
 * and we only replicate the *edits* made to it.
 */
import * as THREE from 'three';
import { VoxelWorld } from '../../../game/src/voxel/VoxelWorld';
import { generateWorld, type MapLayout } from '../../../game/src/voxel/worldgen';
import { NavGrid } from '../../../game/src/ai/NavGrid';
import { BotManager } from '../../../game/src/ai/BotManager';
import type { Bot } from '../../../game/src/ai/Bot';
import { WaveManager, Phase } from '../../../game/src/game/WaveManager';
import { Aggression } from '../../../game/src/game/Aggression';
import { TunnelNetwork } from '../../../game/src/ai/TunnelNetwork';
import { BotKind } from '../../../game/src/ai/botTypes';

export { Phase, BotKind };
export type { Bot, MapLayout };

// The wire protocol lives with the client so there is one definition, not two.
export type { VoxelOp } from '../../../game/src/net/protocol';
import type { VoxelOp } from '../../../game/src/net/protocol';

export interface SimEvents {
  onAnnounce: (text: string, tone: string) => void;
  onPhaseChange: (phase: Phase, wave: number) => void;
  onWaveCleared: (wave: number) => void;
  onBotFire: (bot: Bot, tx: number, ty: number, tz: number) => void;
  onBotDeath: (bot: Bot) => void;
  /** Bot barked something; purely cosmetic, relayed so every client hears it. */
  onBotVoice: (bot: Bot, cue: number) => void;
  /** A voxel the bots tore down; needs relaying to every client. */
  onVoxelOp: (op: VoxelOp) => void;
}

/** A player as the simulation needs to see them: a position, a pulse, a drift. */
export interface SimPlayer {
  id: string;
  x: number;
  y: number;
  z: number;
  /** Velocity, so bots can lead their shots at a moving target. */
  vx: number;
  vy: number;
  vz: number;
  eyeY: number;
  alive: boolean;
}

export class ServerSim {
  readonly world = new VoxelWorld();
  readonly layout: MapLayout;
  readonly nav: NavGrid;
  readonly bots: BotManager;
  readonly waves: WaveManager;
  /** The tunnels under this room's copy of the valley. */
  readonly tunnels = new TunnelNetwork();
  /**
   * Server rooms have no villagers to shoot — the paddy is client-side scenery
   * — so nothing here can anger the valley. Held anyway so the schedule reads
   * the same code as the single-player one rather than a second copy of it.
   */
  private readonly aggression = new Aggression();

  /**
   * Every edit made since the world was generated, in order.
   *
   * A client joining mid-game replays this on top of its freshly generated
   * terrain to arrive at the current state. It grows without bound over a long
   * session; see `compactOps`.
   */
  readonly ops: VoxelOp[] = [];

  private readonly players = new Map<string, SimPlayer>();

  /** Scratch target the bots steer at, rewritten each tick. */
  private readonly focus = new THREE.Vector3();

  /** Reused seed list, so the per-tick reseed doesn't allocate. */
  private readonly seedScratch: { x: number; z: number }[] = [];

  /** Velocity of the engagement target, for shot leading. */
  private readonly focusVel = new THREE.Vector3();

  constructor(readonly seed: number, private readonly events: SimEvents) {
    this.layout = generateWorld(this.world, seed);
    this.world.rebuildHeights();

    this.nav = new NavGrid(this.world);
    this.nav.setSeeds([{ x: this.layout.baseCenter.x, z: this.layout.baseCenter.z }]);
    this.nav.rebuild();

    this.bots = new BotManager({
      world: this.world,
      nav: this.nav,
      // Bots chase whichever player is currently closest; `focus` is rewritten
      // in step() and the manager holds the reference, not a copy.
      playerPos: this.focus,
      playerVel: this.focusVel,
      playerEyeY: 0,
      playerAlive: false,
      objective: new THREE.Vector3(
        this.layout.baseCenter.x, this.layout.baseCenter.y, this.layout.baseCenter.z,
      ),
      onFire: (bot, tx, ty, tz) => this.events.onBotFire(bot, tx, ty, tz),
      onBreach: (bot, x, y, z) => this.breach(x, y, z),
      onBuild: (_bot, x, y, z, color, material) => this.build(x, y, z, color, material),
      onDig: (_bot, x, y, z) => this.dig(x, y, z),
      onVoice: (bot, cue) => this.events.onBotVoice(bot, cue),
      onDeath: (bot) => this.events.onBotDeath(bot),
      // The room owns the tunnels the same way it owns the terrain: they are
      // voxel edits, so they replicate through the op log like anything else,
      // and every client's copy of the map grows the same holes.
      tunnels: this.tunnels,
      aggression: 0,
    });

    for (const h of this.layout.spiderHoles) {
      this.tunnels.add(h.x, h.z, h.floorY, h.standX, h.y, h.standZ, false);
    }

    this.waves = new WaveManager(this.bots, this.layout.spawnPoints, {
      onPhaseChange: (phase, wave) => this.events.onPhaseChange(phase, wave),
      onAnnounce: (text, tone) => this.events.onAnnounce(text, tone ?? 'info'),
      onWaveCleared: (wave) => this.events.onWaveCleared(wave),
    }, this.aggression);
  }

  // -------------------------------------------------------------- players --
  addPlayer(p: SimPlayer): void {
    this.players.set(p.id, p);
  }

  removePlayer(id: string): void {
    this.players.delete(id);
  }

  getPlayer(id: string): SimPlayer | undefined {
    return this.players.get(id);
  }

  get playerCount(): number {
    return this.players.size;
  }

  // ---------------------------------------------------------------- world --
  /**
   * Applies an edit and records it.
   *
   * Returns false when the edit is a no-op so callers don't broadcast nothing.
   */
  applyOp(op: VoxelOp, record = true): boolean {
    let changed: boolean;
    if (op.op === 1) {
      changed = this.world.remove(op.x, op.y, op.z);
    } else {
      changed = !this.world.isSolid(op.x, op.y, op.z);
      if (changed) this.world.set(op.x, op.y, op.z, op.color, op.mat);
    }
    if (!changed) return false;
    if (record) this.ops.push(op);
    return true;
  }

  private breach(x: number, y: number, z: number): void {
    const op: VoxelOp = { op: 1, x, y, z, color: 0, mat: 0 };
    if (this.applyOp(op)) this.events.onVoxelOp(op);
  }

  /**
   * A tunnel rat cutting its shaft. Same op as a breach — the block goes — but
   * it is worth its own name because it is what makes the network grow, and
   * because it replicates like any other edit, so every client's ground opens
   * the same holes.
   */
  private dig(x: number, y: number, z: number): void {
    const op: VoxelOp = { op: 1, x, y, z, color: 0, mat: 0 };
    if (this.applyOp(op)) this.events.onVoxelOp(op);
  }

  /** A bot placing a blueprint block. Returns whether the placement took. */
  private build(x: number, y: number, z: number, color: number, material: number): boolean {
    const op: VoxelOp = { op: 0, x, y, z, color, mat: material };
    if (!this.applyOp(op)) return false;
    this.events.onVoxelOp(op);
    return true;
  }

  /**
   * Collapses the op log so a late joiner replays one entry per voxel.
   *
   * Digging and rebuilding the same wall repeatedly would otherwise make the
   * join payload grow forever.
   */
  compactOps(): void {
    const latest = new Map<number, VoxelOp>();
    for (const o of this.ops) {
      latest.set((o.y * 256 + o.z) * 256 + o.x, o);
    }
    this.ops.length = 0;
    for (const o of latest.values()) this.ops.push(o);
  }

  // ----------------------------------------------------------------- tick --
  step(dt: number): void {
    // Seed the flow field with the objective *and* every living player, so the
    // squad splits toward whoever is nearest rather than all funnelling down
    // one lane. Reseeding is cheap; it only bites on the next timed rebuild.
    this.seedScratch.length = 0;
    this.seedScratch.push({ x: this.layout.baseCenter.x, z: this.layout.baseCenter.z });
    for (const p of this.players.values()) {
      if (p.alive) this.seedScratch.push({ x: p.x, z: p.z });
    }
    this.nav.setSeeds(this.seedScratch);

    // BotManager still engages a single target, so give it the player holding
    // the front line — the one nearest the objective.
    const target = this.nearestLivingPlayer();
    const ctx = (this.bots as unknown as {
      ctx: { playerEyeY: number; playerAlive: boolean };
    }).ctx;
    if (target) {
      this.focus.set(target.x, target.y, target.z);
      this.focusVel.set(target.vx, target.vy, target.vz);
      ctx.playerEyeY = target.eyeY;
      ctx.playerAlive = true;
    } else {
      this.focusVel.set(0, 0, 0);
      // Nobody alive: bots fall back to the objective and stop hunting.
      this.focus.set(this.layout.baseCenter.x, this.layout.baseCenter.y, this.layout.baseCenter.z);
      ctx.playerAlive = false;
    }

    this.nav.update(dt);
    this.bots.update(dt);
    this.waves.update(dt);
  }

  private nearestLivingPlayer(): SimPlayer | null {
    let best: SimPlayer | null = null;
    let bestDist = Infinity;
    const bx = this.layout.baseCenter.x;
    const bz = this.layout.baseCenter.z;
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      // Rank by distance to the objective: whoever is defending the front line
      // is the one the wave should be pushing against.
      const d = (p.x - bx) * (p.x - bx) + (p.z - bz) * (p.z - bz);
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
    return best;
  }
}
