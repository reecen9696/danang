import { MAX_BOTS, type BotManager } from '../ai/BotManager';
import { BotKind, composeWave, pickKind, unlockedKinds, type WaveComposition } from '../ai/botTypes';
import type { Aggression } from './Aggression';

export const enum Phase {
  /** Nobody scheduled to arrive. Merchants open, the field gets worked. */
  Prep = 0,
  /** A raid is running. */
  Combat = 1,
  /** The raid has spent itself and the valley is going quiet again. */
  Cleared = 2,
  GameOver = 3,
}

export interface WaveEvents {
  onPhaseChange: (phase: Phase, wave: number) => void;
  onAnnounce: (text: string, tone?: 'info' | 'warn' | 'good' | 'bad') => void;
  onWaveCleared: (wave: number) => void;
}

export interface SpawnPoint {
  x: number;
  y: number;
  z: number;
}

/**
 * How long the player gets on the first morning. Long, because this is the one
 * lull whose length they can actually plan against.
 */
const FIRST_LULL = 75;

/** Bounds on every lull after that. The exact figure is rolled each time. */
const LULL_MIN = 26;
const LULL_MAX = 62;
/** A raid runs for somewhere in here before it's called spent. */
const RAID_MIN = 48;
const RAID_MAX = 105;
/** Beat between a raid being spent and the lull starting. */
const SETTLE = 5;

/**
 * Hard ceiling on enemies on the field at once. Below MAX_BOTS on purpose: the
 * spare slots are what the freshly dead fall into, and a pool with none left
 * recycles bodies out from under their own death animation.
 */
const MAX_ON_FIELD = MAX_BOTS - 10;

/**
 * How many the field is allowed to hold. Climbs with the raids and again with
 * how angry the valley is, so a player who has been through the paddy meets a
 * thicker fight at the same raid number.
 */
function fieldCap(wave: number, rage: number): number {
  return Math.min(MAX_ON_FIELD, Math.round((13 + wave * 2.6) * (1 + rage * 0.5)));
}

/**
 * Decides when the valley comes at you.
 *
 * The old shape here was a contract: clear every man on the field and you were
 * given a guaranteed minute of quiet. That contract is what made the game a
 * series of rounds rather than a place — you could always see the end of the
 * fight, and the end of the fight was always in your gift.
 *
 * This one makes no promises. Raids are rolled: they start on a clock the
 * player can't see, they run for as long as they run, and when one is spent the
 * survivors are still out there. Quiet is a thing that happens, not a thing you
 * earn, and the only lever the player has on it is the same lever they always
 * had on the enemy, which is killing them.
 *
 * What replaces the guarantee is a warning. A raid announces itself, so the
 * player is never simply ambushed by the schedule — only by the men.
 */
export class WaveManager {
  phase = Phase.Prep;
  /** Raids survived. Still the difficulty clock and still what the HUD shows. */
  wave = 0;
  prepTimer = FIRST_LULL;

  /** What `prepTimer` was set to, so the HUD bar has a denominator. */
  private prepDuration = FIRST_LULL;
  /** Bots in the current raid, for the same reason. */
  private waveTotal = 0;

  /** Bots still waiting to be sent in on this raid. */
  private toSpawn = 0;
  private spawnTimer = 0;
  /** Seconds left before the raid is called spent, whatever is left of it. */
  private raidTimer = 0;
  private composition: WaveComposition = composeWave(1);
  private bossSpawned = false;
  /**
   * Set once a raid has been warned about. The warning goes out a few seconds
   * before the men do, so contact is a surprise but the schedule never is.
   */
  private warned = false;

  /** Set when the player takes any base damage during the raid. */
  baseDamagedThisWave = false;
  repairedThisWave = false;

  constructor(
    private readonly bots: BotManager,
    private readonly spawnPoints: SpawnPoint[],
    private readonly events: WaveEvents,
    private readonly aggression: Aggression,
    private readonly rand: () => number = Math.random,
  ) {}

  get inCombat(): boolean {
    return this.phase === Phase.Combat;
  }

  /** Men still to arrive, plus the ones already here. */
  get remaining(): number {
    return this.toSpawn + this.bots.livingWaveCount;
  }

  /** Lull elapsed, 0..1 — fills as the countdown runs out. */
  get prepFraction(): number {
    if (this.prepDuration <= 0) return 1;
    return 1 - Math.max(0, Math.min(1, this.prepTimer / this.prepDuration));
  }

  /**
   * How far through the raid we are.
   *
   * Deliberately measured in men sent rather than men killed: nothing here is
   * gated on the field being emptied, so a bar that filled with kills would be
   * promising a finish line that no longer exists.
   */
  get waveFraction(): number {
    if (this.waveTotal <= 0) return 0;
    const sent = this.waveTotal - this.toSpawn;
    return Math.max(0, Math.min(1, sent / this.waveTotal));
  }

  startRun(): void {
    this.wave = 0;
    this.phase = Phase.Prep;
    this.prepTimer = FIRST_LULL;
    this.prepDuration = FIRST_LULL;
    this.warned = false;
    this.toSpawn = 0;
    this.bots.clear();
    this.events.onPhaseChange(this.phase, this.wave);
    this.events.onAnnounce('Fortify the base. They will come when they come.', 'info');
  }

  gameOver(): void {
    this.phase = Phase.GameOver;
    this.events.onPhaseChange(this.phase, this.wave);
  }

  update(dt: number): void {
    switch (this.phase) {
      case Phase.Prep:
        this.updateLull(dt);
        break;

      case Phase.Combat:
        this.updateRaid(dt);
        break;

      case Phase.Cleared:
        // Still sending nobody, but the survivors are still out there and the
        // spawner keeps trickling the tail of the raid in if any is left.
        this.trickle(dt);
        this.prepTimer -= dt;
        if (this.prepTimer <= 0) this.beginLull();
        break;

      case Phase.GameOver:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Lull
  // -------------------------------------------------------------------------
  private beginLull(): void {
    const rage = this.aggression.value;
    // Anger buys the player less of everything, quiet included.
    const span = LULL_MAX - LULL_MIN;
    const roll = LULL_MIN + this.rand() * span;
    this.prepTimer = Math.max(12, roll / this.aggression.pressure);
    this.prepDuration = this.prepTimer;
    this.warned = false;
    this.phase = Phase.Prep;
    this.events.onPhaseChange(this.phase, this.wave);
    if (rage >= 0.45) {
      this.events.onAnnounce('The valley has gone quiet. It will not stay quiet.', 'warn');
    }
  }

  private updateLull(dt: number): void {
    // The tail of the last raid can still be arriving. A lull is a lull in the
    // schedule, not a ceasefire.
    this.trickle(dt);

    this.prepTimer -= dt;

    // Warning shot: the player is told a raid is inbound before it is.
    if (!this.warned && this.prepTimer <= this.warnLead()) {
      this.warned = true;
      this.announceInbound();
    }

    if (this.prepTimer <= 0) this.beginRaid();
  }

  /** Seconds of warning before a raid lands. Angry raids give you less. */
  private warnLead(): number {
    return Math.max(4, 11 - this.aggression.value * 6);
  }

  private announceInbound(): void {
    const rage = this.aggression.value;
    if (this.aggression.huntsPlayer) {
      this.events.onAnnounce('THEY ARE COMING FOR YOU', 'bad');
    } else if (rage >= 0.2) {
      this.events.onAnnounce('Movement in the treeline', 'bad');
    } else {
      this.events.onAnnounce('Contact expected', 'warn');
    }
  }

  // -------------------------------------------------------------------------
  // Raid
  // -------------------------------------------------------------------------
  private beginRaid(): void {
    this.wave++;
    this.phase = Phase.Combat;

    const rage = this.aggression.value;
    this.composition = composeWave(this.wave);

    // Raid size is rolled rather than fixed, so two raids at the same number
    // are not the same raid, and anger puts a thumb on the scale.
    const spread = 0.62 + this.rand() * 0.85;
    const total = Math.max(
      5,
      Math.round(this.composition.total * spread * this.aggression.pressure),
    );

    // Stragglers from the last raid roll into this one, but only so many: an
    // unpaid debt from three raids ago arriving all at once is a bug, not a
    // difficulty curve.
    this.toSpawn = Math.min(this.toSpawn, 24) + total;
    this.waveTotal = total;
    this.bossSpawned = !this.composition.boss;
    this.spawnTimer = 0;
    this.raidTimer = (RAID_MIN + this.rand() * (RAID_MAX - RAID_MIN))
      / (1 + rage * 0.35);
    this.baseDamagedThisWave = false;
    this.repairedThisWave = false;

    this.events.onPhaseChange(this.phase, this.wave);
    // No raid number in the callout. A number is a round, and the player is
    // not playing rounds — they are being told what is in front of them.
    this.events.onAnnounce(
      this.composition.boss ? 'ENEMIES SPOTTED — WARLORD' : 'ENEMIES SPOTTED',
      this.composition.boss ? 'bad' : 'warn',
    );
  }

  private updateRaid(dt: number): void {
    this.trickle(dt);
    this.raidTimer -= dt;

    // A raid is over when its clock runs out, and on nothing else.
    //
    // Not on the field being empty — that was the old contract, and it is the
    // thing being removed. Not on the raid's roster being spent either: the
    // field has a ceiling, so a player who lets men pile up would otherwise
    // hold a raid open forever by not killing anybody. Whoever hasn't arrived
    // yet keeps walking in through the quiet as stragglers, and whoever is
    // already here is simply still here.
    if (this.raidTimer > 0) return;

    this.phase = Phase.Cleared;
    this.prepTimer = SETTLE;
    this.prepDuration = SETTLE;
    this.events.onWaveCleared(this.wave);
    this.events.onPhaseChange(this.phase, this.wave);
  }

  /**
   * Feeds whatever is owed onto the field, a fireteam at a time.
   *
   * Runs in every phase, so the back end of one raid can still be walking in
   * while the schedule calls it over — which is exactly what it looks like when
   * the shooting doesn't stop just because the attack has.
   */
  private trickle(dt: number): void {
    if (this.toSpawn <= 0) return;
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;

    const rage = this.aggression.value;
    // Garrisons hold slots in the same pool but are none of a raid's business:
    // the raid gets its own head count, and the ceiling is what is left of the
    // field once the jungle camps have taken their share.
    const cap = Math.min(
      fieldCap(this.wave, rage),
      MAX_ON_FIELD - this.bots.livingGarrisonCount,
    );
    const room = Math.max(0, cap - this.bots.livingWaveCount);
    const burst = Math.min(this.toSpawn, room, 2 + Math.floor(this.rand() * 4));
    for (let i = 0; i < burst; i++) this.spawnOne();

    // Room being full is not a skipped spawn — toSpawn keeps them and the next
    // tick tries again, so the count arrives late rather than not at all.
    const gap = Math.max(0.4, 2.4 - this.wave * 0.1) / this.aggression.pressure;
    this.spawnTimer = gap * (0.6 + this.rand() * 0.8);
  }

  /**
   * Sends one man in.
   *
   * A tunnel rat does not use the spawn ring the way the others do — it goes
   * straight under the ground from wherever it is put down (see
   * BotManager.enterGround), so the point picked for it only decides which side
   * of the valley it enters the network from.
   */
  private spawnOne(): void {
    const sp = this.spawnPoints[Math.floor(this.rand() * this.spawnPoints.length)];
    const jitterX = (this.rand() - 0.5) * 6;
    const jitterZ = (this.rand() - 0.5) * 6;

    let kind: BotKind;
    if (!this.bossSpawned) {
      kind = BotKind.Boss;
      this.bossSpawned = true;
    } else {
      kind = pickKind(this.composition.kinds, this.wave, this.rand);
    }

    const bot = this.bots.spawn(
      kind,
      sp.x + jitterX, sp.y + 1, sp.z + jitterZ,
      this.composition.hpMultiplier,
      this.composition.damageMultiplier,
    );
    if (bot) this.toSpawn--;
  }

  /**
   * Sends a handful of tunnel rats after the player right now, outside the
   * schedule.
   *
   * This is what killing the people in the field actually buys: not a harder
   * raid in two minutes, but men in the ground under you inside of one. The
   * caller decides when it's earned; all this does is put them in.
   */
  sendHunters(count: number): number {
    if (this.phase === Phase.GameOver) return 0;
    const kinds = unlockedKinds(Math.max(2, this.wave));
    if (!kinds.includes(BotKind.Tunneler)) return 0;

    // Hunting parties are extra, not exempt: they still have to fit on the
    // field, or a long run at high anger buries the frame rate in tunnel rats.
    const room = Math.max(0, fieldCap(this.wave, this.aggression.value) - this.bots.livingCount);
    const party = Math.min(count, room);

    let sent = 0;
    for (let i = 0; i < party; i++) {
      const sp = this.spawnPoints[Math.floor(this.rand() * this.spawnPoints.length)];
      const bot = this.bots.spawn(
        BotKind.Tunneler,
        sp.x + (this.rand() - 0.5) * 8, sp.y + 1, sp.z + (this.rand() - 0.5) * 8,
        this.composition.hpMultiplier,
        this.composition.damageMultiplier,
      );
      if (bot) sent++;
    }
    return sent;
  }
}
