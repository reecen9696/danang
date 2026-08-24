/**
 * Thin wrapper over the Colyseus room.
 *
 * Keeps all the wire handling in one place so `Game` deals in callbacks and
 * plain values rather than schema objects and message strings. Everything here
 * is optional: with no `NetClient` attached the game runs exactly as it did
 * single-player.
 */
import { Client, Room } from 'colyseus.js';
import {
  ROOM_NAME,
  type AnnounceMessage,
  type BotFireMessage,
  type BotVoiceMessage,
  type ExplodeMessage,
  type HurtMessage,
  type InitMessage,
  type MoveMessage,
  type PlayerHitMessage,
  type ShootMessage,
  type VoxelOp,
} from './protocol';

/** A remote player as the renderer needs them. */
export interface RemoteSnapshot {
  sessionId: string;
  name: string;
  x: number; y: number; z: number;
  yaw: number; pitch: number;
  hp: number;
  alive: boolean;
  points: number;
  kills: number;
  weapon: string;
  sprinting: boolean;
}

export interface NetHandlers {
  onInit: (m: InitMessage) => void;
  onVoxel: (op: VoxelOp) => void;
  onAnnounce: (m: AnnounceMessage) => void;
  onBotFire: (m: BotFireMessage) => void;
  onHurt: (m: HurtMessage) => void;
  onBotVoice: (m: BotVoiceMessage) => void;
  onShoot: (m: ShootMessage) => void;
  onExplode: (m: ExplodeMessage) => void;
  onLeave: (code: number) => void;
}

/** Server-authoritative wave state, mirrored each frame. */
export interface NetWaveState {
  phase: number;
  wave: number;
  prepTimer: number;
  remaining: number;
  progress: number;
  runOver: boolean;
}

export class NetClient {
  private room!: Room;

  /** Reused so the per-frame read doesn't allocate. */
  private readonly waveState: NetWaveState = {
    phase: 0, wave: 0, prepTimer: 0, remaining: 0, progress: 0, runOver: false,
  };

  private moveTimer = 0;

  get sessionId(): string {
    return this.room?.sessionId ?? '';
  }

  get connected(): boolean {
    return !!this.room && this.room.connection.isOpen;
  }

  /**
   * Joins (or creates) a room on the given endpoint.
   *
   * `endpoint` is a ws:// or wss:// origin; the caller is responsible for
   * matching the page's scheme, since a https page cannot open a ws://.
   */
  async connect(endpoint: string, name: string, handlers: NetHandlers): Promise<InitMessage> {
    const client = new Client(endpoint);
    this.room = await client.joinOrCreate(ROOM_NAME, { name });

    const init = new Promise<InitMessage>((resolve) => {
      this.room.onMessage('init', (m: InitMessage) => {
        handlers.onInit(m);
        resolve(m);
      });
    });

    this.room.onMessage('voxel', (op: VoxelOp) => handlers.onVoxel(op));
    this.room.onMessage('announce', (m: AnnounceMessage) => handlers.onAnnounce(m));
    this.room.onMessage('botFire', (m: BotFireMessage) => handlers.onBotFire(m));
    this.room.onMessage('hurt', (m: HurtMessage) => handlers.onHurt(m));
    this.room.onMessage('botVoice', (m: BotVoiceMessage) => handlers.onBotVoice(m));
    this.room.onMessage('shoot', (m: ShootMessage) => handlers.onShoot(m));
    this.room.onMessage('explode', (m: ExplodeMessage) => handlers.onExplode(m));
    // Messages we don't act on yet; registering them keeps the client quiet.
    this.room.onMessage('phase', () => {});
    this.room.onMessage('waveCleared', () => {});
    this.room.onMessage('botDeath', () => {});

    this.room.onLeave((code) => handlers.onLeave(code));

    return init;
  }

  disconnect(): void {
    void this.room?.leave();
  }

  // ------------------------------------------------------------- outbound --
  /** Throttled position report. Call every frame; it rate-limits itself. */
  sendMove(dt: number, m: MoveMessage): void {
    this.moveTimer -= dt;
    if (this.moveTimer > 0) return;
    this.moveTimer = 1 / 15;
    this.room.send('move', m);
  }

  sendVoxel(op: VoxelOp): void {
    this.room.send('voxel', op);
  }

  sendBlockDamage(x: number, y: number, z: number, amount: number): void {
    this.room.send('blockDamage', { x, y, z, amount });
  }

  sendBotHit(slot: number, damage: number): void {
    this.room.send('botHit', { slot, damage });
  }

  /** Report a round that found a squadmate. Friendly fire is on. */
  sendPlayerHit(m: PlayerHitMessage): void {
    this.room.send('playerHit', m);
  }

  sendShoot(m: ShootMessage): void {
    this.room.send('shoot', m);
  }

  sendExplode(m: ExplodeMessage): void {
    this.room.send('explode', m);
  }

  sendPoints(points: number): void {
    this.room.send('points', { points });
  }

  // -------------------------------------------------------------- inbound --
  readWaveState(): NetWaveState {
    const s = this.room.state as unknown as NetWaveState;
    this.waveState.phase = s.phase;
    this.waveState.wave = s.wave;
    this.waveState.prepTimer = s.prepTimer;
    this.waveState.remaining = s.remaining;
    this.waveState.progress = s.progress;
    this.waveState.runOver = s.runOver;
    return this.waveState;
  }

  /** Visits every bot slot the server currently considers live. */
  forEachBot(fn: (slot: number, b: {
    kind: number; x: number; y: number; z: number;
    yaw: number; hp: number; maxHp: number; state: number; alive: boolean;
  }) => void): void {
    const bots = (this.room.state as unknown as {
      bots: { forEach: (cb: (v: never, k: string) => void) => void };
    }).bots;
    bots.forEach((b, key) => fn(Number(key), b));
  }

  /** Visits every player except the local one. */
  forEachRemote(fn: (p: RemoteSnapshot) => void): void {
    const players = (this.room.state as unknown as {
      players: { forEach: (cb: (v: RemoteSnapshot, k: string) => void) => void };
    }).players;
    const me = this.sessionId;
    players.forEach((p, key) => {
      if (key === me) return;
      fn(p);
    });
  }

  /** Everyone, including the local player — for the scoreboard. */
  allPlayers(): RemoteSnapshot[] {
    const out: RemoteSnapshot[] = [];
    const players = (this.room.state as unknown as {
      players: { forEach: (cb: (v: RemoteSnapshot, k: string) => void) => void };
    }).players;
    players.forEach((p) => out.push(p));
    return out;
  }
}
