import type { Bot } from './Bot';
import { BotRole } from './botTypes';

/** Squads bigger than this split; smaller ones can't bound properly. */
export const SQUAD_SIZE = 5;
/** How long a sighting stays actionable before the squad goes back to searching. */
export const CONTACT_MEMORY = 7;

/**
 * A fireteam.
 *
 * The squad is where the teamwork lives. Individually a bot only knows what it
 * can see; the squad is what lets one bot's sighting move the whole group, what
 * keeps half of them shooting while the other half moves, and what points every
 * breacher at the *same* wall block instead of five different ones.
 */
export class Squad {
  readonly members: Bot[] = [];

  // --- shared contact ------------------------------------------------------
  /** Someone in the squad has seen the target recently. */
  hasContact = false;
  lastSeenX = 0;
  lastSeenY = 0;
  lastSeenZ = 0;
  /** Seconds since anyone in the squad last had eyes on. */
  contactAge = CONTACT_MEMORY * 2;
  /** Members with line of sight right now — the squad's base of fire. */
  spotters = 0;

  // --- bounding overwatch --------------------------------------------------
  /** Members whose boundPhase matches this are the ones allowed to move. */
  activeBound = 0;
  private boundTimer = 0;

  // --- ambush --------------------------------------------------------------
  /**
   * Countdown to the squad's burrowers coming up together.
   *
   * The first rat to reach its mouth starts this; anyone who arrives while it
   * runs inherits whatever is left of it. That one shared number is the whole
   * of the coordination, and it's what turns four men surfacing into an
   * ambush rather than four men queueing to be shot.
   */
  ambushTimer = 0;

  // --- siege ---------------------------------------------------------------
  /** The one wall voxel the whole squad works on, or -1. */
  breachX = -1;
  breachY = -1;
  breachZ = -1;
  /** Seconds the squad has been unable to make progress toward the objective. */
  stalledFor = 0;
  /** Set while a member is building; stops five bots stacking five ramps. */
  builders = 0;

  /**
   * Compass bearing this squad attacks along, so two squads converging on the
   * same base come at it from different faces instead of forming one queue.
   */
  approachBearing = 0;

  /**
   * The outpost this squad mans, or null for a wave squad. Camps fight as
   * units: one sentry seeing you is the camp seeing you, and no further.
   */
  post: { x: number; z: number } | null = null;

  private assignTimer = 0;

  constructor(readonly id: number, bearing: number) {
    this.approachBearing = bearing;
  }

  get size(): number {
    return this.members.length;
  }

  add(bot: Bot): void {
    this.members.push(bot);
    bot.squad = this;
    bot.boundPhase = this.members.length & 1;
    this.assignTimer = 0;
  }

  /** Drops dead/despawned members. Returns true when the squad is empty. */
  prune(): boolean {
    for (let i = this.members.length - 1; i >= 0; i--) {
      const b = this.members[i];
      if (b.alive && b.squad === this) continue;
      if (b.squad === this) b.squad = null;
      this.members.splice(i, 1);
    }
    return this.members.length === 0;
  }

  /** Records a sighting from one member and shares it with the rest. */
  report(x: number, y: number, z: number): void {
    this.lastSeenX = x;
    this.lastSeenY = y;
    this.lastSeenZ = z;
    this.contactAge = 0;
    this.hasContact = true;
  }

  update(dt: number): void {
    this.contactAge += dt;
    if (this.ambushTimer > 0) this.ambushTimer = Math.max(0, this.ambushTimer - dt);
    if (this.contactAge > CONTACT_MEMORY) this.hasContact = false;

    this.spotters = 0;
    for (const b of this.members) if (b.seesTarget) this.spotters++;
    if (this.spotters > 0) this.stalledFor = Math.max(0, this.stalledFor - dt * 2);

    // Bounding overwatch: flip which half of the squad is allowed to move.
    // Only worth doing once there's someone left behind to cover the move.
    this.boundTimer -= dt;
    if (this.boundTimer <= 0) {
      this.boundTimer = 1.6 + (this.id % 3) * 0.4;
      this.activeBound ^= 1;
    }

    this.assignTimer -= dt;
    if (this.assignTimer <= 0) {
      this.assignTimer = 2;
      this.assignRoles();
    }

    this.builders = 0;
    for (const b of this.members) if (b.buildActive) this.builders++;
  }

  /**
   * True when this bot is the half of the squad that moves this bound. A lone
   * bot always moves — there is nobody to cover it, so freezing would just make
   * it a stationary target.
   */
  mayBound(bot: Bot): boolean {
    if (this.members.length < 2) return true;
    if (this.spotters === 0) return true;
    // Never let the whole squad freeze: if nobody is left shooting, everyone moves.
    if (this.spotters <= 1 && !bot.seesTarget) return true;
    return bot.boundPhase === this.activeBound;
  }

  /** Points the squad at one wall voxel so the breach concentrates. */
  designateBreach(x: number, y: number, z: number): void {
    this.breachX = x;
    this.breachY = y;
    this.breachZ = z;
  }

  clearBreach(): void {
    this.breachX = -1;
  }

  /**
   * Re-draws roles from the archetypes present, then patches the gaps: a squad
   * with nobody shooting can't bound, and a stalled squad with no breacher will
   * stand outside a wall forever.
   */
  private assignRoles(): void {
    const n = this.members.length;
    if (n === 0) return;

    for (const b of this.members) b.role = b.def.role;

    let support = 0;
    let breachers = 0;
    let flankers = 0;
    for (const b of this.members) {
      if (b.role === BotRole.Support) support++;
      else if (b.role === BotRole.Breacher) breachers++;
      else if (b.role === BotRole.Flanker) flankers++;
    }

    // Cap flankers — a squad that all swings wide has no weight on the front.
    const maxFlank = Math.max(1, Math.floor(n / 3));
    for (const b of this.members) {
      if (flankers <= maxFlank) break;
      if (b.role !== BotRole.Flanker) continue;
      b.role = BotRole.Assault;
      flankers--;
    }

    // Guarantee a base of fire once the squad is big enough to spare one.
    if (support === 0 && n >= 3) {
      const pick = this.bestFor(BotRole.Support);
      if (pick) { pick.role = BotRole.Support; support++; }
    }

    // Stalled at a wall with nobody working on it: draft the best candidate.
    if (breachers === 0 && this.stalledFor > 2.5) {
      const pick = this.bestFor(BotRole.Breacher);
      if (pick) { pick.role = BotRole.Breacher; breachers++; }
    }
  }

  /** The member whose archetype is least badly suited to a role it isn't in. */
  private bestFor(role: BotRole): Bot | null {
    let best: Bot | null = null;
    let bestScore = -Infinity;
    for (const b of this.members) {
      if (b.role === role) continue;
      let score: number;
      switch (role) {
        // Long reach and a taste for cover make a good base of fire.
        case BotRole.Support: score = b.def.maxRange * 0.1 + b.def.coverSeek * 4; break;
        // Breaching wants raw block damage and a willingness to stand still.
        case BotRole.Breacher: score = b.def.breachPower * 0.05 + (b.def.builder ? 3 : 0); break;
        default: score = b.def.speed; break;
      }
      // Never strip the squad's only spotter to fill a quota.
      if (b.seesTarget && this.spotters <= 1) score -= 10;
      if (score > bestScore) { bestScore = score; best = b; }
    }
    return best;
  }
}

/**
 * Keeps bots grouped into fireteams, opening a new one when the last is full.
 * Squads are handed staggered approach bearings so successive waves fan out
 * around the base instead of tracking through the same gap.
 */
export class SquadManager {
  readonly squads: Squad[] = [];
  private nextId = 0;

  /**
   * Puts a freshly spawned bot into the newest squad with room.
   *
   * Burrowers are kept together. A squad is only worth anything to a tunnel rat
   * for one thing — the shared clock that has them all come up at once — and a
   * lone rat in a squad of riflemen has nobody to come up with. Grouping them
   * is what turns "an enemy pops out of the ground" into "the ground opens on
   * three sides of you".
   */
  enlist(bot: Bot): Squad {
    if (bot.def.burrower) {
      for (let i = this.squads.length - 1; i >= 0; i--) {
        const s = this.squads[i];
        if (s.size >= SQUAD_SIZE) continue;
        if (!s.members.every((m) => m.def.burrower)) continue;
        s.add(bot);
        return s;
      }
      const fresh = new Squad(this.nextId, (this.nextId * 2.399963) % (Math.PI * 2));
      this.nextId++;
      this.squads.push(fresh);
      fresh.add(bot);
      return fresh;
    }

    let squad = this.squads.length > 0 ? this.squads[this.squads.length - 1] : null;
    // A rat's squad is not a home for a rifleman either — the alternation that
    // squad is running is an ambush clock, not a bounding overwatch.
    if (squad !== null && squad.size > 0 && squad.members[0].def.burrower) squad = null;
    if (squad === null || squad.size >= SQUAD_SIZE) {
      // Golden-angle stagger: consecutive squads never share a bearing.
      squad = new Squad(this.nextId, (this.nextId * 2.399963) % (Math.PI * 2));
      this.nextId++;
      this.squads.push(squad);
    }
    squad.add(bot);
    return squad;
  }

  /**
   * Moves a freshly enlisted bot into the squad holding a given post, opening
   * one if there isn't a squad there yet.
   *
   * Garrisons have to be their own units. Enlisting them the normal way drops
   * them into whichever squad the last wave left half-full, which would have a
   * camp forty blocks away sharing sightings with men attacking the base — so a
   * player creeping past one outpost would be reported by another.
   */
  assignPost(bot: Bot, postX: number, postZ: number): Squad {
    for (const s of this.squads) {
      if (!s.post) continue;
      if (Math.hypot(s.post.x - postX, s.post.z - postZ) > 1) continue;
      if (s.size >= SQUAD_SIZE) break;
      this.detach(bot);
      s.add(bot);
      return s;
    }

    this.detach(bot);
    const squad = new Squad(this.nextId, Math.atan2(postX, postZ));
    this.nextId++;
    squad.post = { x: postX, z: postZ };
    this.squads.push(squad);
    squad.add(bot);
    return squad;
  }

  /** Takes a bot out of whatever squad it is currently in. */
  private detach(bot: Bot): void {
    const from = bot.squad;
    if (from === null) return;
    const i = from.members.indexOf(bot);
    if (i >= 0) from.members.splice(i, 1);
    bot.squad = null;
  }

  update(dt: number): void {
    for (let i = this.squads.length - 1; i >= 0; i--) {
      const s = this.squads[i];
      if (s.prune()) {
        this.squads.splice(i, 1);
        continue;
      }
      s.update(dt);
    }
  }

  clear(): void {
    for (const s of this.squads) for (const b of s.members) b.squad = null;
    this.squads.length = 0;
  }
}
