import { WeaponId } from '../weapons/definitions';

/**
 * What a bot is doing for its squad this engagement. Assigned by the squad, not
 * baked into the archetype — a squad with no breacher will draft one.
 */
export const enum BotRole {
  /** Closes on the target, moving in bounds while others shoot. */
  Assault = 0,
  /** Holds at range and keeps the target's head down so Assault can move. */
  Support = 1,
  /** Swings wide to come in off the squad's axis of advance. */
  Flanker = 2,
  /** Works on the wall: digs the breach, or builds the ramp over it. */
  Breacher = 3,
}

export const enum BotKind {
  Grunt = 0,
  Raider = 1,
  Shotgunner = 2,
  Rifleman = 3,
  Sapper = 4,
  Grenadier = 5,
  Rocketeer = 6,
  Tank = 7,
  Boss = 8,
  /** Comes at you through the ground rather than across it. */
  Tunneler = 9,
}

export interface BotDef {
  readonly kind: BotKind;
  readonly name: string;
  readonly hp: number;
  readonly weapon: WeaponId;
  /** Movement speed in blocks/sec. */
  readonly speed: number;
  /** Preferred engagement distance; bots hold at roughly this range. */
  readonly preferredRange: number;
  /** Max distance at which it will open fire. */
  readonly maxRange: number;
  /** Seconds between bursts. */
  readonly fireInterval: number;
  readonly burst: number;
  /** 0..1 — chance a shot is on target rather than scattered. */
  readonly accuracy: number;
  /** Score awarded for the kill. */
  readonly points: number;
  /** Prefers tearing down walls over shooting the player. */
  readonly sapper: boolean;
  /** Seconds between spotting a target and opening fire. */
  readonly reaction: number;
  /** Seconds of held aim before the archetype shoots at its full accuracy. */
  readonly aimTime: number;
  /** 0..1 — how far past its preferred range it will push to keep pressure on. */
  readonly aggression: number;
  /** 0..1 — how strongly it breaks contact to get behind something solid. */
  readonly coverSeek: number;
  /** Will place blueprint structures (ramps, firing steps, cover). */
  readonly builder: boolean;
  /** Will tunnel under walls it can't get over. */
  readonly tunneler: boolean;
  /**
   * Fights from under the ground: travels through the earth between the
   * mouths of the tunnel network, comes up near the target, empties a magazine
   * and drops back down. See BotManager's burrow/emerge/submerge states.
   */
  readonly burrower: boolean;
  /** Will keep firing at a target's last known position to pin it down. */
  readonly suppresses: boolean;
  /** Block damage per swing/shot when working on a wall. */
  readonly breachPower: number;
  /** Role this archetype is drafted into first. */
  readonly role: BotRole;
  readonly bodyColor: number;
  readonly headColor: number;
  /** Straw of the conical farmer hat every enemy wears. */
  readonly hatColor: number;
  /** Chest webbing / ammo bandolier worn over the uniform. */
  readonly rigColor: number;
  /** Visual scale multiplier. */
  readonly scale: number;
  /** Height in blocks (collision + hit box). */
  readonly height: number;
  readonly radius: number;
}

export const BOTS: readonly BotDef[] = [
  {
    kind: BotKind.Grunt, name: 'Pistol Grunt', hp: 60, weapon: WeaponId.Pistol,
    speed: 3.4, preferredRange: 14, maxRange: 44, fireInterval: 1.5, burst: 2,
    accuracy: 0.42, points: 50, sapper: false,
    reaction: 0.4, aimTime: 0.9, aggression: 0.55, coverSeek: 0.6,
    builder: true, tunneler: false, burrower: false, suppresses: true, breachPower: 30, role: BotRole.Assault,
    bodyColor: 0x1e2027, headColor: 0xc9a077, hatColor: 0xd9c184, rigColor: 0x4a4238,
    scale: 1, height: 2.7, radius: 0.42,
  },
  {
    kind: BotKind.Raider, name: 'SMG Raider', hp: 80, weapon: WeaponId.SMG,
    speed: 4.9, preferredRange: 10, maxRange: 40, fireInterval: 1.15, burst: 7,
    accuracy: 0.36, points: 60, sapper: false,
    reaction: 0.28, aimTime: 0.7, aggression: 0.9, coverSeek: 0.35,
    builder: false, tunneler: false, burrower: false, suppresses: true, breachPower: 26, role: BotRole.Flanker,
    bodyColor: 0x37452c, headColor: 0xc9a077, hatColor: 0xd2b678, rigColor: 0x3a3128,
    scale: 1, height: 2.7, radius: 0.42,
  },
  {
    kind: BotKind.Shotgunner, name: 'Shotgunner', hp: 100, weapon: WeaponId.Shotgun,
    speed: 4.4, preferredRange: 4, maxRange: 18, fireInterval: 1.4, burst: 1,
    accuracy: 0.62, points: 75, sapper: false,
    reaction: 0.22, aimTime: 0.5, aggression: 1.0, coverSeek: 0.2,
    builder: false, tunneler: false, burrower: false, suppresses: false, breachPower: 34, role: BotRole.Assault,
    bodyColor: 0x574530, headColor: 0xc9a077, hatColor: 0xc9aa6b, rigColor: 0x35291c,
    scale: 1.08, height: 2.8, radius: 0.46,
  },
  {
    kind: BotKind.Rifleman, name: 'Rifleman', hp: 90, weapon: WeaponId.Rifle,
    speed: 3.0, preferredRange: 34, maxRange: 90, fireInterval: 1.9, burst: 2,
    accuracy: 0.66, points: 90, sapper: false,
    reaction: 0.55, aimTime: 1.4, aggression: 0.2, coverSeek: 0.9,
    builder: true, tunneler: false, burrower: false, suppresses: true, breachPower: 42, role: BotRole.Support,
    bodyColor: 0x3f5236, headColor: 0xc9a077, hatColor: 0xd9c184, rigColor: 0x2f3a26,
    scale: 1, height: 2.7, radius: 0.42,
  },
  {
    kind: BotKind.Sapper, name: 'Sapper', hp: 70, weapon: WeaponId.Spade,
    speed: 5.2, preferredRange: 1.4, maxRange: 3, fireInterval: 0.45, burst: 1,
    accuracy: 1, points: 80, sapper: true,
    reaction: 0.3, aimTime: 0.4, aggression: 0.8, coverSeek: 0.3,
    builder: true, tunneler: true, burrower: false, suppresses: false, breachPower: 95, role: BotRole.Breacher,
    bodyColor: 0x24262b, headColor: 0xc9a077, hatColor: 0xbf9f5e, rigColor: 0x8a2f2f,
    scale: 0.95, height: 2.6, radius: 0.4,
  },
  {
    kind: BotKind.Grenadier, name: 'Grenadier', hp: 110, weapon: WeaponId.Grenade,
    speed: 3.2, preferredRange: 22, maxRange: 46, fireInterval: 3.4, burst: 1,
    accuracy: 0.55, points: 120, sapper: false,
    reaction: 0.7, aimTime: 1.1, aggression: 0.3, coverSeek: 0.8,
    builder: true, tunneler: false, burrower: false, suppresses: true, breachPower: 40, role: BotRole.Support,
    bodyColor: 0x2d3a30, headColor: 0xc9a077, hatColor: 0xd2b678, rigColor: 0x4a3f2a,
    scale: 1.05, height: 2.8, radius: 0.44,
  },
  {
    kind: BotKind.Rocketeer, name: 'Rocketeer', hp: 130, weapon: WeaponId.Rocket,
    speed: 2.6, preferredRange: 30, maxRange: 70, fireInterval: 4.2, burst: 1,
    accuracy: 0.7, points: 150, sapper: false,
    reaction: 0.8, aimTime: 1.3, aggression: 0.15, coverSeek: 0.85,
    builder: false, tunneler: false, burrower: false, suppresses: true, breachPower: 70, role: BotRole.Support,
    bodyColor: 0x22342a, headColor: 0xc9a077, hatColor: 0xc9aa6b, rigColor: 0x2a2f26,
    scale: 1.12, height: 2.9, radius: 0.48,
  },
  {
    kind: BotKind.Tank, name: 'Tank', hp: 800, weapon: WeaponId.Rocket,
    speed: 1.9, preferredRange: 26, maxRange: 80, fireInterval: 3.6, burst: 1,
    accuracy: 0.78, points: 400, sapper: false,
    reaction: 0.9, aimTime: 1.2, aggression: 0.7, coverSeek: 0.1,
    builder: false, tunneler: false, burrower: false, suppresses: true, breachPower: 140, role: BotRole.Breacher,
    bodyColor: 0x3a4030, headColor: 0x4a5240, hatColor: 0xa8894a, rigColor: 0x24281e,
    scale: 2.1, height: 4.2, radius: 1.3,
  },
  {
    kind: BotKind.Boss, name: 'Warlord', hp: 3000, weapon: WeaponId.Rocket,
    speed: 2.4, preferredRange: 20, maxRange: 100, fireInterval: 1.9, burst: 3,
    accuracy: 0.85, points: 1500, sapper: false,
    reaction: 0.5, aimTime: 0.8, aggression: 0.85, coverSeek: 0.15,
    builder: false, tunneler: false, burrower: false, suppresses: true, breachPower: 220, role: BotRole.Assault,
    bodyColor: 0x2a1220, headColor: 0x8a1b3a, hatColor: 0x8f6b34, rigColor: 0x50122a,
    scale: 2.8, height: 5.4, radius: 1.7,
  },
  {
    // Lightly built and lightly armed, because everything it has goes into
    // arriving somewhere it has no business being. Fast off the mark — a man
    // who has spent the last minute in a hole waiting is not surprised to see
    // you — and it does not hang about: a magazine, then back down.
    kind: BotKind.Tunneler, name: 'Tunnel Rat', hp: 70, weapon: WeaponId.SMG,
    speed: 4.6, preferredRange: 8, maxRange: 34, fireInterval: 0.95, burst: 6,
    accuracy: 0.5, points: 130, sapper: false,
    reaction: 0.16, aimTime: 0.45, aggression: 0.95, coverSeek: 0.15,
    // Not a `tunneler` in the wall-boring sense, which is the more important of
    // the two facts about it: a rat that answers a wall by chewing through it
    // is a sapper, and it already has a better answer to walls than anyone.
    builder: false, tunneler: false, burrower: true, suppresses: false, breachPower: 60, role: BotRole.Flanker,
    // Black pyjamas and a dark hat: the one enemy you are meant to fail to see
    // until the ground moves.
    bodyColor: 0x14161a, headColor: 0xc9a077, hatColor: 0x6f5f3a, rigColor: 0x2a2118,
    scale: 0.94, height: 2.6, radius: 0.4,
  },
];

/** Which archetypes are legal on a given wave (GDD section 7.2). */
export function unlockedKinds(wave: number): BotKind[] {
  const kinds: BotKind[] = [BotKind.Grunt];
  // The ground opens up early. The tunnels are already there on the first
  // morning, so the second raid is the one that teaches you to watch them.
  if (wave >= 2) kinds.push(BotKind.Tunneler);
  if (wave >= 3) kinds.push(BotKind.Raider);
  if (wave >= 4) kinds.push(BotKind.Shotgunner);
  if (wave >= 5) kinds.push(BotKind.Rifleman);
  if (wave >= 6) kinds.push(BotKind.Sapper);
  if (wave >= 7) kinds.push(BotKind.Grenadier);
  if (wave >= 8) kinds.push(BotKind.Rocketeer);
  if (wave >= 10) kinds.push(BotKind.Tank);
  return kinds;
}

export interface WaveComposition {
  kinds: BotKind[];
  total: number;
  hpMultiplier: number;
  damageMultiplier: number;
  boss: boolean;
}

/**
 * Ceiling on a wave's head count. Past this the wave stops being a fight and
 * starts being a queue: the bot pool is MAX_BOTS deep, so every man over the
 * cap just waits offscreen for a slot while the player stands around.
 */
const MAX_WAVE_SIZE = 80;

export function composeWave(wave: number): WaveComposition {
  const kinds = unlockedKinds(wave);
  // Roughly double the old count. The trickle in WaveManager decides how many
  // of them are on the field at once, so this is the length of the fight;
  // the burst size is its density.
  const total = Math.min(MAX_WAVE_SIZE, 9 + Math.floor(wave * 2.6));
  return {
    kinds,
    total,
    hpMultiplier: 1 + wave * 0.08,
    damageMultiplier: 1 + wave * 0.05,
    boss: wave % 10 === 0,
  };
}

/** Weighted pick that biases toward the newest archetypes as waves climb. */
export function pickKind(kinds: BotKind[], wave: number, rand: () => number): BotKind {
  const weights: number[] = [];
  let sum = 0;
  for (let i = 0; i < kinds.length; i++) {
    // Newer unlocks appear more often, but tanks stay rare.
    let w = 1 + i * 0.35;
    if (kinds[i] === BotKind.Tank) w = 0.18 + wave * 0.012;
    if (kinds[i] === BotKind.Sapper) w = 1.1 + wave * 0.05;
    // Tunnel rats stay a steady presence rather than being crowded out by the
    // newer unlocks — the ground is a threat for the whole run, not a phase.
    if (kinds[i] === BotKind.Tunneler) w = 1.4 + wave * 0.06;
    weights.push(w);
    sum += w;
  }
  let r = rand() * sum;
  for (let i = 0; i < kinds.length; i++) {
    r -= weights[i];
    if (r <= 0) return kinds[i];
  }
  return kinds[kinds.length - 1];
}
