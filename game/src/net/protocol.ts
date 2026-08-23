/**
 * Wire protocol shared by the client and the Colyseus server.
 *
 * The server imports this file directly (see `server/src/sim/ServerSim.ts`), so
 * there is exactly one definition of every message shape rather than two that
 * have to be kept in step by hand.
 */

/** Room name registered on the server. */
export const ROOM_NAME = 'defense';

/** A voxel edit, in the compact form broadcast and replayed to late joiners. */
export interface VoxelOp {
  /** 0 = set, 1 = remove. */
  op: 0 | 1;
  x: number;
  y: number;
  z: number;
  /** Palette colour index; ignored for removals. */
  color: number;
  /** Material index; ignored for removals. */
  mat: number;
}

/** Sent once on join: everything needed to reconstruct the world locally. */
export interface InitMessage {
  seed: number;
  spawn: { x: number; y: number; z: number };
  /** Every edit made since generation, replayed over the fresh terrain. */
  ops: VoxelOp[];
}

/** Client -> server, ~15Hz. */
export interface MoveMessage {
  x: number; y: number; z: number;
  yaw: number; pitch: number;
  hp: number; alive: boolean;
  slot: number; weapon: string; sprinting: boolean;
}

/** Client -> server: damage the reporting client believes it dealt. */
export interface BotHitMessage {
  slot: number;
  damage: number;
}

/** Client -> server: weapon or explosion damage against terrain. */
export interface BlockDamageMessage {
  x: number; y: number; z: number; amount: number;
}

/** Server -> client: a bot took a shot; the target client applies the damage. */
export interface BotFireMessage {
  slot: number;
  weapon: string;
  x: number; y: number; z: number;
  tx: number; ty: number; tz: number;
  /** Session id the shot was aimed at. */
  target: string;
}

/**
 * An enemy shouting. The AI runs on the server, so the cue has to travel; the
 * client owns which recorded line it turns into, since that is per-bot and
 * cosmetic. `cue` is a VoiceCue — see audio/cues.ts.
 */
export interface BotVoiceMessage {
  slot: number;
  cue: number;
}

/** Cosmetic relay so other players see tracers and muzzle flashes. */
export interface ShootMessage {
  from?: string;
  x: number; y: number; z: number;
  dx: number; dy: number; dz: number;
  weapon: string;
}

/** Cosmetic relay for explosion effects. */
export interface ExplodeMessage {
  from?: string;
  x: number; y: number; z: number;
  kind: number;
}

export interface AnnounceMessage {
  text: string;
  tone: 'info' | 'good' | 'bad' | 'warn';
}
