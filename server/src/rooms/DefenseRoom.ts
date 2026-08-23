/**
 * Co-op wave-survival room.
 *
 * Authority split (see the project README): the server owns the terrain seed,
 * every voxel edit, the wave schedule and all bot AI. Clients own their own
 * movement and report their own hits — the right trade for co-op, where the
 * failure mode of trusting a friend is a worse score, not a ruined match.
 */
import { Room, Client } from '@colyseus/core';
import { Mat, PHYS } from '../../../game/src/core/constants';
import { BotState as BotAiState } from '../../../game/src/ai/Bot';
import { ServerSim, Phase, type VoxelOp } from '../sim/ServerSim';
import { RoomState, PlayerState, BotSnapshot } from '../schema/RoomState';

/** Simulation step. Bots and waves advance at this rate regardless of clients. */
const TICK_MS = 50;

/** Compact the edit log once it gets long enough to matter on join. */
const COMPACT_EVERY = 2000;

interface MoveMessage {
  x: number; y: number; z: number;
  yaw: number; pitch: number;
  hp: number; alive: boolean;
  slot: number; weapon: string; sprinting: boolean;
}

export class DefenseRoom extends Room<RoomState> {
  maxClients = 8;

  private sim!: ServerSim;
  private accumulator = 0;
  private opsSinceCompact = 0;
  /** Arrival time of each client's last move, for deriving velocity. */
  private readonly lastMoveAt = new Map<string, number>();

  onCreate(options: { seed?: number }): void {
    this.state = new RoomState();
    this.state.phase = 0;
    this.state.wave = 0;
    this.state.prepTimer = 0;
    this.state.remaining = 0;
    this.state.progress = 0;
    this.state.runOver = false;

    // A fixed seed can be passed in for debugging; otherwise every room gets
    // its own map. Kept inside uint32 because that is how it is replicated.
    const seed = options?.seed ?? (1 + Math.floor(Math.random() * 0xffffffe));
    this.state.seed = seed;

    this.sim = new ServerSim(seed, {
      onAnnounce: (text, tone) => this.broadcast('announce', { text, tone }),
      onPhaseChange: (phase, wave) => {
        this.state.phase = phase;
        this.state.wave = wave;
        this.state.runOver = phase === Phase.GameOver;
        this.broadcast('phase', { phase, wave });
      },
      onWaveCleared: (wave) => this.broadcast('waveCleared', { wave }),
      onBotFire: (bot, tx, ty, tz) => {
        // Clients render the shot; the targeted client applies the damage to
        // itself and reports the new hp back through `move`.
        this.broadcast('botFire', {
          slot: this.sim.bots.bots.indexOf(bot),
          weapon: bot.def.weapon,
          x: bot.position.x, y: bot.position.y, z: bot.position.z,
          tx, ty, tz,
          target: this.focusId,
        });
      },
      onBotVoice: (bot, cue) => {
        this.broadcast('botVoice', { slot: this.sim.bots.bots.indexOf(bot), cue });
      },
      onBotDeath: (bot) => {
        this.broadcast('botDeath', { slot: this.sim.bots.bots.indexOf(bot) });
      },
      onVoxelOp: (op) => this.broadcast('voxel', op),
    });

    const core = this.sim.layout.corePosition;
    this.state.coreMaxHp = this.sim.world.maxHpAt(core.x, core.y, core.z);
    this.state.coreHp = this.state.coreMaxHp;

    this.registerHandlers();
    this.setSimulationInterval((dt) => this.tick(dt), TICK_MS);
  }

  // -------------------------------------------------------------- messages --
  private registerHandlers(): void {
    this.onMessage('move', (client, m: MoveMessage) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      p.x = m.x; p.y = m.y; p.z = m.z;
      p.yaw = m.yaw; p.pitch = m.pitch;
      p.hp = m.hp; p.alive = m.alive;
      p.slot = m.slot; p.weapon = m.weapon; p.sprinting = m.sprinting;

      const sp = this.sim.getPlayer(client.sessionId);
      if (sp) {
        const now = Date.now();
        const last = this.lastMoveAt.get(client.sessionId) ?? 0;
        const dt = last ? Math.min(0.5, (now - last) / 1000) : 0;
        if (dt > 0.001) {
          sp.vx = (m.x - sp.x) / dt;
          sp.vy = (m.y - sp.y) / dt;
          sp.vz = (m.z - sp.z) / dt;
        }
        this.lastMoveAt.set(client.sessionId, now);
        sp.x = m.x; sp.y = m.y; sp.z = m.z;
        sp.eyeY = m.y + PHYS.eyeStand;
        sp.alive = m.alive;
      }
    });

    // A voxel placed or dug. Applied authoritatively, then relayed to everyone
    // else — the sender already predicted it locally.
    this.onMessage('voxel', (client, op: VoxelOp) => {
      if (!this.validOp(op)) return;
      if (!this.sim.applyOp(op)) return;
      this.opsSinceCompact++;
      this.broadcastExcept(client, 'voxel', op);
      this.syncCoreHp();
    });

    // Weapon or explosion damage against terrain.
    this.onMessage('blockDamage', (client, m: { x: number; y: number; z: number; amount: number }) => {
      if (!Number.isFinite(m?.amount) || m.amount <= 0) return;
      if (!this.inBounds(m.x, m.y, m.z)) return;
      const res = this.sim.world.damage(m.x, m.y, m.z, m.amount);
      if (res.applied === 0) return;
      if (res.destroyed) {
        const op: VoxelOp = { op: 1, x: m.x, y: m.y, z: m.z, color: 0, mat: 0 };
        this.sim.ops.push(op);
        this.opsSinceCompact++;
        this.broadcastExcept(client, 'voxel', op);
      }
      this.syncCoreHp();
    });

    // Client-reported damage on a bot.
    this.onMessage('botHit', (client, m: { slot: number; damage: number }) => {
      const bot = this.sim.bots.bots[m?.slot];
      if (!bot || !bot.active || bot.hp <= 0) return;
      if (!Number.isFinite(m.damage) || m.damage <= 0) return;

      const killed = this.sim.bots.damage(bot, m.damage);
      if (killed) {
        const p = this.state.players.get(client.sessionId);
        if (p) p.kills = (p.kills || 0) + 1;
      }
    });

    // Purely cosmetic relays: tracers, muzzle flashes, explosion fx.
    this.onMessage('shoot', (client, m: unknown) => {
      this.broadcastExcept(client, 'shoot', { ...(m as object), from: client.sessionId });
    });
    this.onMessage('explode', (client, m: unknown) => {
      this.broadcastExcept(client, 'explode', { ...(m as object), from: client.sessionId });
    });

    this.onMessage('points', (client, m: { points: number }) => {
      const p = this.state.players.get(client.sessionId);
      if (p && Number.isFinite(m?.points)) p.points = Math.max(0, Math.floor(m.points));
    });

    // Any player can cut the prep phase short; it is a co-op game.
    this.onMessage('ready', () => this.sim.waves.readyUp());
  }

  private validOp(op: VoxelOp): boolean {
    return !!op
      && (op.op === 0 || op.op === 1)
      && this.inBounds(op.x, op.y, op.z);
  }

  private inBounds(x: number, y: number, z: number): boolean {
    return Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(z)
      && x >= 0 && x < 256 && y >= 0 && y < 64 && z >= 0 && z < 256;
  }

  private broadcastExcept(client: Client, type: string, message: unknown): void {
    this.broadcast(type, message, { except: client });
  }

  // ------------------------------------------------------------ lifecycle --
  onJoin(client: Client, options: { name?: string }): void {
    // Every field is set explicitly: the schema() helper does not install
    // defaults, so an untouched numeric field is `undefined` and the first
    // `++` turns it into NaN, which the encoder refuses.
    const spawn = this.sim.layout.playerSpawn;
    const p = new PlayerState();
    p.sessionId = client.sessionId;
    p.name = (options?.name || 'Ace').slice(0, 16);
    p.x = spawn.x; p.y = spawn.y; p.z = spawn.z;
    p.yaw = 0; p.pitch = 0;
    p.hp = 100; p.alive = true;
    p.points = 0; p.kills = 0;
    p.slot = 0; p.weapon = 'pistol'; p.sprinting = false;
    this.state.players.set(client.sessionId, p);

    this.sim.addPlayer({
      id: client.sessionId,
      x: spawn.x, y: spawn.y, z: spawn.z,
      vx: 0, vy: 0, vz: 0,
      eyeY: spawn.y + PHYS.eyeStand,
      alive: true,
    });

    // Everything the client needs to reconstruct the world: the seed it
    // generates from, and every edit made to it since.
    if (this.opsSinceCompact >= COMPACT_EVERY) {
      this.sim.compactOps();
      this.opsSinceCompact = 0;
    }
    client.send('init', {
      seed: this.state.seed,
      spawn,
      ops: this.sim.ops,
    });

    this.broadcast('announce', { text: `${p.name} joined`, tone: 'info' }, { except: client });
  }

  onLeave(client: Client, consented?: boolean): void {
    void consented;
    const p = this.state.players.get(client.sessionId);
    if (p) this.broadcast('announce', { text: `${p.name} left`, tone: 'info' });
    this.state.players.delete(client.sessionId);
    this.sim.removePlayer(client.sessionId);
    this.lastMoveAt.delete(client.sessionId);
  }

  onDispose(): void {
    // setSimulationInterval is torn down by the room itself.
  }

  // ----------------------------------------------------------------- tick --
  private tick(deltaMs: number): void {
    // Clamp so a stalled event loop doesn't teleport a whole wave forward.
    this.accumulator += Math.min(deltaMs, 250);
    const step = TICK_MS / 1000;
    while (this.accumulator >= TICK_MS) {
      this.accumulator -= TICK_MS;
      this.sim.step(step);
    }

    this.syncWaveState();
    this.syncBots();
  }

  private syncWaveState(): void {
    const w = this.sim.waves;
    this.state.phase = w.phase;
    this.state.wave = w.wave;
    this.state.prepTimer = w.prepTimer;
    this.state.remaining = w.remaining;
    this.state.progress = w.phase === Phase.Combat ? w.waveFraction : w.prepFraction;
  }

  private syncCoreHp(): void {
    const c = this.sim.layout.corePosition;
    const hp = this.sim.world.materialAt(c.x, c.y, c.z) === Mat.Core
      ? this.sim.world.hpAt(c.x, c.y, c.z)
      : 0;
    this.state.coreHp = hp;
    if (hp <= 0 && !this.state.runOver) {
      this.state.runOver = true;
      this.sim.waves.gameOver();
      this.broadcast('announce', { text: 'THE CORE HAS FALLEN', tone: 'bad' });
    }
  }

  /**
   * Mirrors the bot pool into the replicated map.
   *
   * Entries are added when a pool slot goes live and removed once its death
   * animation has played out, so clients get a clean spawn/despawn signal
   * rather than having to diff positions.
   */
  private syncBots(): void {
    const pool = this.sim.bots.bots;
    for (let i = 0; i < pool.length; i++) {
      const bot = pool[i];
      const key = String(i);
      const existing = this.state.bots.get(key);

      if (!bot.active) {
        if (existing) this.state.bots.delete(key);
        continue;
      }

      const snap = existing ?? new BotSnapshot();
      snap.slot = i;
      snap.kind = bot.kind;
      snap.x = bot.position.x;
      snap.y = bot.position.y;
      snap.z = bot.position.z;
      snap.yaw = bot.yaw;
      snap.hp = bot.hp;
      snap.maxHp = bot.maxHp;
      snap.state = bot.state;
      snap.alive = bot.hp > 0 && bot.state !== BotAiState.Dying;
      if (!existing) this.state.bots.set(key, snap);
    }
  }

  /** Session id of the player the bots are currently converging on. */
  private get focusId(): string {
    let best = '';
    let bestDist = Infinity;
    const bx = this.sim.layout.baseCenter.x;
    const bz = this.sim.layout.baseCenter.z;
    this.state.players.forEach((p: PlayerState, id: string) => {
      if (!p.alive) return;
      const d = (p.x - bx) * (p.x - bx) + (p.z - bz) * (p.z - bz);
      if (d < bestDist) { bestDist = d; best = id; }
    });
    return best;
  }
}
