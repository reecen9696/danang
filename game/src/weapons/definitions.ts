/**
 * Weapon table.
 *
 * Damage, clip sizes, fire delays, reload times and spread for the Rifle, SMG
 * and Shotgun match Ace of Spades Classic exactly so the gunplay feels right.
 * The Pistol and the launcher-style enemy weapons are our own additions.
 */

export const enum WeaponId {
  Spade = 'spade',
  Block = 'block',
  Pistol = 'pistol',
  SMG = 'smg',
  Rifle = 'rifle',
  Shotgun = 'shotgun',
  Grenade = 'grenade',
  Rocket = 'rocket',
  /** The Huey's door gun, prised off its pintle. */
  MachineGun = 'm60',
  /** Break-action 40mm launcher. */
  Thumper = 'm79',
}

export const enum HitZone {
  Torso = 0,
  Head = 1,
  Arms = 2,
  Legs = 3,
}

export interface WeaponDef {
  readonly id: WeaponId;
  readonly name: string;
  /** Damage per hit by zone: [torso, head, arms, legs]. */
  readonly damage: readonly [number, number, number, number];
  /** Damage dealt to a voxel per bullet. */
  readonly blockDamage: number;
  readonly clipSize: number;
  readonly maxStock: number;
  /** Seconds between shots. */
  readonly delay: number;
  readonly reloadTime: number;
  /** Shotgun-style shell-at-a-time reload. */
  readonly reloadSlow: boolean;
  /** Radians of cone half-angle at the muzzle. */
  readonly spread: number;
  readonly pellets: number;
  readonly automatic: boolean;
  /** Vertical/horizontal kick applied per shot, in radians. */
  readonly recoil: readonly [number, number];
  /** FOV when aiming down sights; 0 = no ADS. */
  readonly adsFov: number;
  readonly range: number;
  readonly muzzleFlash: number;
  readonly sound: string;
  /** Recording of the magazine coming out, played at the start of a reload. */
  readonly reloadOut?: string;
  /** Recording of the magazine going home, timed to land as the reload ends. */
  readonly reloadIn?: string;
  /** Action-cycling sound played just after each shot, for bolt and pump guns. */
  readonly cycle?: string;
  /**
   * Launchers only: what leaves the muzzle instead of a bullet.
   *
   * `damage` above is still the table the explosion reads its numbers from, so
   * a launcher's row stays legible next to the rifles; `explosion` names the
   * blast the round makes and `muzzleSpeed` how hard it is thrown. Anything
   * without this field is hitscan, which is every other gun in the game.
   */
  readonly projectile?: 'shell' | 'rocket';
  readonly explosion?: ExplosionKind;
  readonly muzzleSpeed?: number;
}

const base = {
  reloadSlow: false,
  pellets: 1,
  automatic: false,
  adsFov: 45,
  range: 256,
  muzzleFlash: 0.05,
} as const;

export const WEAPONS: Readonly<Record<WeaponId, WeaponDef>> = {
  [WeaponId.Spade]: {
    ...base,
    id: WeaponId.Spade, name: 'Spade',
    damage: [50, 60, 40, 40], blockDamage: 100000,
    clipSize: 0, maxStock: 0, delay: 0.45, reloadTime: 0,
    spread: 0, recoil: [0, 0], adsFov: 0, range: 4, muzzleFlash: 0,
    sound: 'spade',
  },
  [WeaponId.Block]: {
    ...base,
    id: WeaponId.Block, name: 'Block Tool',
    damage: [0, 0, 0, 0], blockDamage: 0,
    clipSize: 0, maxStock: 0, delay: 0.18, reloadTime: 0,
    spread: 0, recoil: [0, 0], adsFov: 0, range: 8, muzzleFlash: 0,
    sound: 'place',
  },
  [WeaponId.Pistol]: {
    ...base,
    id: WeaponId.Pistol, name: 'Pistol',
    damage: [35, 70, 25, 25], blockDamage: 25,
    clipSize: 8, maxStock: 96, delay: 0.26, reloadTime: 1.9,
    spread: 0.008, recoil: [0.016, 0.005],
    sound: 'pistol',
    reloadOut: 'reload-pistol-out', reloadIn: 'reload-pistol-in',
  },
  [WeaponId.SMG]: {
    ...base,
    id: WeaponId.SMG, name: 'SMG',
    damage: [29, 75, 18, 18], blockDamage: 34,
    clipSize: 30, maxStock: 150, delay: 0.1, reloadTime: 2.5,
    spread: 0.012, recoil: [0.012, 0.006], automatic: true,
    sound: 'smg',
    reloadOut: 'reload-ar-out', reloadIn: 'reload-ar-in',
  },
  [WeaponId.Rifle]: {
    ...base,
    id: WeaponId.Rifle, name: 'Rifle',
    damage: [49, 100, 33, 33], blockDamage: 50,
    clipSize: 10, maxStock: 60, delay: 0.5, reloadTime: 2.5,
    spread: 0.006, recoil: [0.035, 0.008], adsFov: 32,
    muzzleFlash: 0.07,
    sound: 'rifle',
    reloadOut: 'reload-rifle-out', reloadIn: 'reload-rifle-in', cycle: 'cycle-bolt',
  },
  [WeaponId.Shotgun]: {
    ...base,
    id: WeaponId.Shotgun, name: 'Shotgun',
    damage: [27, 37, 16, 16], blockDamage: 22,
    clipSize: 6, maxStock: 60, delay: 0.85, reloadTime: 0.5,
    reloadSlow: true, spread: 0.024, pellets: 8,
    recoil: [0.05, 0.012], adsFov: 55, range: 90,
    muzzleFlash: 0.09,
    sound: 'shotgun',
    cycle: 'cycle-pump',
  },
  [WeaponId.Grenade]: {
    ...base,
    id: WeaponId.Grenade, name: 'Grenade',
    damage: [130, 130, 130, 130], blockDamage: 60,
    clipSize: 1, maxStock: 6, delay: 0.9, reloadTime: 0.4,
    spread: 0, recoil: [0, 0], adsFov: 0, range: 0, muzzleFlash: 0,
    sound: 'throw',
  },
  /**
   * The door gun off the wreck.
   *
   * A hundred rounds on the belt and enough block damage to open a hut wall,
   * paid for at both ends: it takes eight seconds to feed a fresh belt, and the
   * cone is wide enough that it is a weapon for a lane rather than for a head.
   * Deliberately the only gun in the game with no sights at all -- a pintle
   * gun held at the hip is what it is, and `adsFov: 0` says so.
   */
  [WeaponId.MachineGun]: {
    ...base,
    id: WeaponId.MachineGun, name: 'M60',
    damage: [33, 66, 22, 22], blockDamage: 48,
    clipSize: 100, maxStock: 300, delay: 0.105, reloadTime: 8,
    spread: 0.026, recoil: [0.021, 0.011], automatic: true,
    adsFov: 0, range: 200, muzzleFlash: 0.1,
    sound: 'm60',
    reloadOut: 'reload-ak-out', reloadIn: 'reload-ak-in',
  },
  /**
   * The Thumper.
   *
   * One 40mm at a time, lobbed on an arc, off in the wrong hands. It is the
   * shortest reach of anything that explodes -- the round drops fast enough
   * that a target past forty blocks needs the barrel visibly up -- and that
   * arc is the whole reason to carry one: it is the only thing the player owns
   * that goes over a wall and lands behind it.
   */
  [WeaponId.Thumper]: {
    ...base,
    id: WeaponId.Thumper, name: 'M79 Thumper',
    damage: [150, 150, 150, 150], blockDamage: 95,
    clipSize: 1, maxStock: 14, delay: 1, reloadTime: 2.6,
    spread: 0.004, recoil: [0.05, 0.01], adsFov: 60, range: 0,
    muzzleFlash: 0.08,
    sound: 'm79',
    reloadOut: 'reload-pistol-out', reloadIn: 'reload-pistol-in',
    projectile: 'shell', explosion: 'm79', muzzleSpeed: 42,
  },
  [WeaponId.Rocket]: {
    ...base,
    id: WeaponId.Rocket, name: 'Rocket Launcher',
    damage: [300, 300, 300, 300], blockDamage: 260,
    clipSize: 1, maxStock: 12, delay: 2.4, reloadTime: 2.2,
    spread: 0.01, recoil: [0.06, 0.02], adsFov: 0, range: 200,
    muzzleFlash: 0.12,
    sound: 'rocket',
    reloadOut: 'reload-ak-out', reloadIn: 'reload-ak-in',
  },
};

/** Explosion tuning shared by grenades and rockets. */
export const EXPLOSIONS = {
  grenade: { radius: 4.5, playerDamage: 130, blockDamage: 55, force: 0.5 },
  // Wider than a grenade and harder on blocks, but it kills over a shorter
  // radius than a rocket: the 40mm is a room-clearer, not a wall-remover.
  m79: { radius: 5.2, playerDamage: 150, blockDamage: 95, force: 0.6 },
  rocket: { radius: 6.0, playerDamage: 300, blockDamage: 240, force: 0.9 },
  tankShell: { radius: 7.5, playerDamage: 220, blockDamage: 420, force: 1.0 },
} as const;

export type ExplosionKind = keyof typeof EXPLOSIONS;
