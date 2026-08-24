/**
 * How badly the valley wants you dead.
 *
 * The firebase is on somebody's hill, above somebody's field, and the game has
 * always known that — the farmers are out there, the log says "Civilian killed"
 * and nothing else happens. This is the "and nothing else happens" part being
 * wrong. Every one of them you put in the mud is remembered, and what it buys
 * you is the rest of the valley taking the firebase personally: raids come
 * sooner and heavier, the tunnel rats surface closer, and past a point the
 * horde stops walking at your Core and starts walking at you.
 *
 * Two numbers do this. `heat` is what just happened and bleeds off over a few
 * minutes; `grudge` is the floor it bleeds off *to*, and that only ever goes
 * up. A player who has cleared the paddy once can wait out the anger; a player
 * who keeps doing it cannot.
 */

/** Where a fresh kill puts the heat. */
const KILL_HEAT = 0.17;
/** A round that hurt somebody without killing them still gets noticed. */
const WOUND_HEAT = 0.055;
/** Rounds cracking through the field with nobody hit. */
const SCARE_HEAT = 0.008;
/** What one death adds to the floor, permanently. */
const KILL_GRUDGE = 0.05;
/**
 * The village buffalo, shot dead in its own grass.
 *
 * Not quite a person, and not remotely an accident: a con trau is the plough,
 * the cart and the savings of the household that owns it, and killing one is
 * the clearest possible statement about what the firebase thinks of the people
 * below it. Heavier than wounding somebody, and it leaves a mark that does not
 * cool off, because that household's year is gone either way.
 */
const OX_HEAT = 0.13;
const OX_GRUDGE = 0.04;
/** Ceiling on the floor: there has to be somewhere left to escalate to. */
const MAX_GRUDGE = 0.62;
/** Heat shed per second. About three minutes to walk one killing off. */
const COOL_RATE = 0.0016;

export const enum Rage {
  /** Business as usual: they're here for the Core. */
  Calm = 0,
  /** Word has got round. */
  Roused = 1,
  /** They're coming heavy and they're coming often. */
  Angry = 2,
  /** They are not interested in the Core any more. */
  Hunting = 3,
}

export const RAGE_NAMES: readonly string[] = ['CALM', 'ROUSED', 'ANGRY', 'HUNTING'];

export class Aggression {
  /** Recent anger, 0..1. Decays toward `grudge`. */
  private heat = 0;
  /** The floor heat decays to. Only ever rises. */
  private grudge = 0;
  /** Civilians killed this run, for the record and for the log lines. */
  civiliansKilled = 0;

  /** 0..1 — the number everything else reads. */
  get value(): number {
    return Math.max(0, Math.min(1, Math.max(this.heat, this.grudge)));
  }

  get level(): Rage {
    const v = this.value;
    if (v >= 0.72) return Rage.Hunting;
    if (v >= 0.45) return Rage.Angry;
    if (v >= 0.2) return Rage.Roused;
    return Rage.Calm;
  }

  get name(): string {
    return RAGE_NAMES[this.level];
  }

  /**
   * Past this they come for the player rather than the Core.
   *
   * It is the one effect with a hard edge rather than a curve, because it is
   * the one the player has to be able to feel arriving: the horde walking past
   * your wall to get to you is a different game, and it should announce itself.
   */
  get huntsPlayer(): boolean {
    return this.level >= Rage.Angry;
  }

  /** Multiplier on how often raids come and how big they are. */
  get pressure(): number {
    return 1 + this.value * 1.35;
  }

  reset(): void {
    this.heat = 0;
    this.grudge = 0;
    this.civiliansKilled = 0;
  }

  update(dt: number): void {
    if (this.heat > this.grudge) {
      this.heat = Math.max(this.grudge, this.heat - COOL_RATE * dt);
    }
  }

  /** Returns the level crossed into, or -1 if this didn't move the needle. */
  private bump(amount: number): number {
    const before = this.level;
    this.heat = Math.min(1, Math.max(this.heat, this.grudge) + amount);
    const after = this.level;
    return after > before ? after : -1;
  }

  civilianKilled(): number {
    this.civiliansKilled++;
    this.grudge = Math.min(MAX_GRUDGE, this.grudge + KILL_GRUDGE);
    return this.bump(KILL_HEAT);
  }

  civilianWounded(): number {
    return this.bump(WOUND_HEAT);
  }

  /**
   * The buffalo is dead.
   *
   * Deliberately not counted as a civilian: the log line and the tally are
   * about people, and quietly folding an animal into that number would make
   * the one figure the game reports about your conduct a lie.
   */
  livestockKilled(): number {
    this.grudge = Math.min(MAX_GRUDGE, this.grudge + OX_GRUDGE);
    return this.bump(OX_HEAT);
  }

  /** Fire through the field that hit nobody. Cheap, but not free. */
  civiliansScared(): number {
    return this.bump(SCARE_HEAT);
  }
}
