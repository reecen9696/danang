import { WEAPONS, WeaponId } from '../weapons/definitions';

/**
 * Ace of Spades Classic gives every player the same spade, blocks and
 * grenades, and lets the primary weapon be the only real choice. We keep that:
 * a class *is* its gun, it costs nothing, and you can switch mid-run.
 */
export const enum ClassId {
  Rifleman = 'rifleman',
  Commando = 'commando',
  Shotgunner = 'shotgunner',
}

export interface ClassDef {
  readonly id: ClassId;
  readonly name: string;
  readonly weapon: WeaponId;
  /** One-line role, shown under the name in the picker. */
  readonly tagline: string;
  readonly description: string;
}

export const CLASSES: readonly ClassDef[] = [
  {
    id: ClassId.Rifleman,
    name: 'RIFLEMAN',
    weapon: WeaponId.Rifle,
    tagline: 'Long range · one-shot headshots',
    description:
      'Bolt-action, 10 rounds. Hits hardest per shot and chews through walls, '
      + 'but you pay for every miss with the bolt cycle.',
  },
  {
    id: ClassId.Commando,
    name: 'COMMANDO',
    weapon: WeaponId.SMG,
    tagline: 'Full auto · 30-round mag',
    description:
      'Sprays 10 rounds a second and reloads fast. Weak against blocks, so it '
      + 'farms points off bodies rather than opening breaches.',
  },
  {
    id: ClassId.Shotgunner,
    name: 'SHOTGUNNER',
    weapon: WeaponId.Shotgun,
    tagline: 'Close quarters · 8 pellets a shell',
    description:
      'Deletes anything that reaches your wall. Pellets spread to nothing past '
      + 'a few dozen blocks, so it is a defensive pick.',
  },
];

export const DEFAULT_CLASS = ClassId.Rifleman;

export function classDef(id: ClassId): ClassDef {
  return CLASSES.find((c) => c.id === id) ?? CLASSES[0];
}

/** Headline numbers for the picker, read straight off the weapon table. */
export function classStats(def: ClassDef): { label: string; value: string }[] {
  const w = WEAPONS[def.weapon];
  const dps = w.damage[0] * w.pellets / w.delay;
  return [
    { label: 'BODY', value: w.pellets > 1 ? `${w.pellets} × ${w.damage[0]}` : String(w.damage[0]) },
    { label: 'HEAD', value: String(w.damage[1]) },
    { label: 'MAG', value: String(w.clipSize) },
    { label: 'DPS', value: String(Math.round(dps)) },
  ];
}
