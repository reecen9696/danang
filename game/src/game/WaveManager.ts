import { MAX_BOTS, type BotManager } from '../ai/BotManager';
import { BotKind, composeWave, pickKind, type WaveComposition } from '../ai/botTypes';

export const enum Phase {
  Prep = 0,
  Combat = 1,
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

const PREP_SECONDS = 60;
const FIRST_PREP_SECONDS = 75;

/**
 * Hard ceiling on enemies on the field at once. Below MAX_BOTS on purpose: the
 * spare slots are what the freshly dead fall into, and a pool with none left
 * recycles bodies out from under their own death animation.
 */
const MAX_ON_FIELD = MAX_BOTS - 10;
/**
 * How many the field is allowed to hold on a given wave. Early waves are held
 * well under the ceiling so wave 1 isn't the same wall of men as wave 15 —
 * what climbs with the waves is the pressure, not just the head count.
 */
function fieldCap(wave: number): number {
  return Math.min(MAX_ON_FIELD, 14 + wave * 3);
}

/**
 * Drives the prep -> combat -> clear loop and trickles enemies in rather than
 * dumping a whole wave at once (GDD section 7.2).
 */
export class WaveManager {
  phase = Phase.Prep;
  wave = 0;
  prepTimer = FIRST_PREP_SECONDS;
  /** What `prepTimer` was set to, so the HUD bar has a denominator. */
  private prepDuration = FIRST_PREP_SECONDS;
  /** Bots in the current wave, for the same reason. */
  private waveTotal = 0;

  /** Bots still waiting to be spawned this wave. */
  private toSpawn = 0;
  private spawnTimer = 0;
  private composition: WaveComposition = composeWave(1);
  private bossSpawned = false;

  /** Set when the player takes any base damage during the wave. */
  baseDamagedThisWave = false;
  repairedThisWave = false;

  constructor(
    private readonly bots: BotManager,
    private readonly spawnPoints: SpawnPoint[],
    private readonly events: WaveEvents,
    private readonly rand: () => number = Math.random,
  ) {}

  get inCombat(): boolean {
    return this.phase === Phase.Combat;
  }

  get remaining(): number {
    return this.toSpawn + this.bots.livingCount;
  }

  /** Prep time elapsed, 0..1 — fills as the countdown runs out. */
  get prepFraction(): number {
    if (this.prepDuration <= 0) return 1;
    return 1 - Math.max(0, Math.min(1, this.prepTimer / this.prepDuration));
  }

  /** Wave cleared, 0..1. */
  get waveFraction(): number {
    if (this.waveTotal <= 0) return 0;
    return 1 - Math.max(0, Math.min(1, this.remaining / this.waveTotal));
  }

  /** Ends the prep phase early. */
  readyUp(): void {
    if (this.phase !== Phase.Prep) return;
    this.prepTimer = 0;
  }

  startRun(): void {
    this.wave = 0;
    this.phase = Phase.Prep;
    this.prepTimer = FIRST_PREP_SECONDS;
    this.prepDuration = FIRST_PREP_SECONDS;
    this.bots.clear();
    this.events.onPhaseChange(this.phase, this.wave);
    this.events.onAnnounce('Fortify the base. Wave 1 incoming.', 'info');
  }

  gameOver(): void {
    this.phase = Phase.GameOver;
    this.events.onPhaseChange(this.phase, this.wave);
  }

  update(dt: number): void {
    switch (this.phase) {
      case Phase.Prep:
        this.prepTimer -= dt;
        if (this.prepTimer <= 0) this.beginCombat();
        break;

      case Phase.Combat:
        this.updateCombat(dt);
        break;

      case Phase.Cleared:
        this.prepTimer -= dt;
        if (this.prepTimer <= 0) {
          this.phase = Phase.Prep;
          this.prepTimer = PREP_SECONDS;
          this.prepDuration = PREP_SECONDS;
          this.events.onPhaseChange(this.phase, this.wave);
        }
        break;

      case Phase.GameOver:
        break;
    }
  }

  private beginCombat(): void {
    this.wave++;
    this.phase = Phase.Combat;
    this.composition = composeWave(this.wave);
    this.toSpawn = this.composition.total;
    this.waveTotal = this.composition.total;
    this.bossSpawned = !this.composition.boss;
    this.spawnTimer = 0;
    this.baseDamagedThisWave = false;
    this.repairedThisWave = false;
    this.events.onPhaseChange(this.phase, this.wave);
    this.events.onAnnounce(
      this.composition.boss ? `WAVE ${this.wave} — WARLORD INCOMING` : `Wave ${this.wave} incoming`,
      this.composition.boss ? 'bad' : 'warn',
    );
  }

  private updateCombat(dt: number): void {
    if (this.toSpawn > 0) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) {
        // Sub-waves: a squad at a time so the player can actually fight back,
        // but never more than the field is allowed to hold. Room being full is
        // not a skipped spawn — toSpawn keeps them and the next tick tries
        // again, so the count arrives late rather than not at all.
        const room = Math.max(0, fieldCap(this.wave) - this.bots.livingCount);
        const burst = Math.min(this.toSpawn, room, 2 + Math.floor(this.rand() * 4));
        for (let i = 0; i < burst; i++) this.spawnOne();
        // Spawn faster on later waves, but never faster than every 0.45s.
        this.spawnTimer = Math.max(0.45, 2.4 - this.wave * 0.1) * (0.7 + this.rand() * 0.6);
      }
    }

    if (this.toSpawn <= 0 && this.bots.livingCount === 0) {
      this.phase = Phase.Cleared;
      this.prepTimer = 4;
      this.prepDuration = 4;
      this.events.onWaveCleared(this.wave);
      this.events.onPhaseChange(this.phase, this.wave);
    }
  }

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
}
