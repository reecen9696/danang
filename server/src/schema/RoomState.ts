/**
 * Replicated room state.
 *
 * Declared with the `schema()` helper rather than `defineTypes` or decorators.
 * That is not a style preference: in @colyseus/schema 3.0.76 `defineTypes` fails
 * to register the child type of a `{ map: X }` field, so encoding the first map
 * entry throws `Cannot read properties of undefined (reading Symbol.metadata)`.
 * Decorators would need `experimentalDecorators`, which the esbuild bundle
 * doesn't pick up reliably. `schema()` works with no build configuration.
 *
 * Note what is *absent*: the voxel world. At 256x64x256 it is four million
 * cells, which is not something to put in a patch stream. Terrain is a pure
 * function of `seed`, so clients rebuild it locally and receive only edits, as
 * messages.
 */
import { schema, type MapSchema } from '@colyseus/schema';

export const PlayerState = schema({
  sessionId: 'string',
  name: 'string',

  x: 'float32',
  y: 'float32',
  z: 'float32',
  yaw: 'float32',
  pitch: 'float32',

  hp: 'float32',
  alive: 'boolean',
  points: 'uint32',
  kills: 'uint16',

  /** Loadout slot: spade / block / gun / grenade. */
  slot: 'uint8',
  /** Weapon id, for remote view models and the scoreboard. */
  weapon: 'string',
  /** Set while sprinting, so remote avatars can lean into the run. */
  sprinting: 'boolean',
}, 'PlayerState');
export type PlayerState = InstanceType<typeof PlayerState>;

export const BotSnapshot = schema({
  /** Index into the server's bot pool; stable for the bot's lifetime. */
  slot: 'uint16',
  kind: 'uint8',
  x: 'float32',
  y: 'float32',
  z: 'float32',
  yaw: 'float32',
  hp: 'float32',
  maxHp: 'float32',
  state: 'uint8',
  alive: 'boolean',
}, 'BotSnapshot');
export type BotSnapshot = InstanceType<typeof BotSnapshot>;

export const RoomState = schema({
  /** Terrain seed. Clients generate the world from this; it never changes. */
  seed: 'uint32',

  phase: 'uint8',
  wave: 'uint16',
  prepTimer: 'float32',
  /** Enemies left in the current wave. */
  remaining: 'uint16',
  /** 0..1, drives the HUD bar without the client recomputing it. */
  progress: 'float32',

  coreHp: 'float32',
  coreMaxHp: 'float32',

  /** Set once the run is over, so late joiners don't drop into a dead game. */
  runOver: 'boolean',

  players: { map: PlayerState },
  bots: { map: BotSnapshot },
}, 'RoomState');

export type RoomState = InstanceType<typeof RoomState> & {
  players: MapSchema<PlayerState>;
  bots: MapSchema<BotSnapshot>;
};
