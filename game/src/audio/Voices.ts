/**
 * Enemy chatter.
 *
 * Two voice actors cover the whole horde, so the job here is mostly restraint:
 * a wave is up to seventy men, and if each one shouted every time it saw you
 * the map would be a football crowd. Every line goes through this director,
 * which holds a floor on the gap between any two lines and a separate cooldown
 * per cue, so what you actually hear is one man calling contact and another
 * answering — not all of them at once.
 *
 * Which recorded line gets used is decided by its length, because length is the
 * only thing the slicer can know without understanding Vietnamese: a grunt is
 * short, a called sighting is a beat or two, an order is longer. Retag lines by
 * hand in voiceLines.ts once you have heard them.
 */

import type { AudioEngine } from './Audio';
import { VoiceCue } from './cues';
import { VOICE_TAKES, type VoiceLine, type VoiceTag } from './voiceLines';

export { VoiceCue };

interface CueDef {
  /** Preferred line length, longest-lived preference first. */
  readonly tags: readonly VoiceTag[];
  /** Seconds before any bot may use this cue again. */
  readonly cooldown: number;
  /**
   * Cues below the one currently speaking wait their turn: a man hit while
   * somebody else is calling contact still gets his grunt out, but idle
   * chatter never interrupts anything.
   */
  readonly priority: number;
}

const CUES: Readonly<Record<VoiceCue, CueDef>> = {
  [VoiceCue.Contact]: { tags: ['mid', 'short', 'long'], cooldown: 3.2, priority: 2 },
  [VoiceCue.Advance]: { tags: ['long', 'mid', 'short'], cooldown: 7, priority: 0 },
  [VoiceCue.Hurt]: { tags: ['short', 'mid', 'long'], cooldown: 1.8, priority: 3 },
  [VoiceCue.Grenade]: { tags: ['short', 'mid', 'long'], cooldown: 4.5, priority: 3 },
};

/** Nothing speaks within this of the last line, whatever the cue. */
const FLOOR = 0.4;

/** Lines of each take grouped by tag, built once. */
const BY_TAG: readonly Readonly<Record<VoiceTag, readonly VoiceLine[]>>[] = VOICE_TAKES.map((take) => ({
  short: take.lines.filter((l) => l.tag === 'short'),
  mid: take.lines.filter((l) => l.tag === 'mid'),
  long: take.lines.filter((l) => l.tag === 'long'),
}));

export class VoiceDirector {
  /** Seconds until the floor lifts. */
  private gate = 0;
  /** Priority of the line currently holding the floor down. */
  private speaking = 0;
  private readonly cooldowns = new Float32Array(Object.keys(CUES).length);
  /** Last line played per take, so a speaker doesn't repeat itself back to back. */
  private readonly lastLine: number[] = VOICE_TAKES.map(() => -1);

  constructor(
    private readonly audio: AudioEngine,
    private readonly rand: () => number = Math.random,
  ) {}

  update(dt: number): void {
    this.gate = Math.max(0, this.gate - dt);
    if (this.gate === 0) this.speaking = 0;
    for (let i = 0; i < this.cooldowns.length; i++) {
      this.cooldowns[i] = Math.max(0, this.cooldowns[i] - dt);
    }
  }

  /** Drops every cooldown, so a fresh wave isn't gagged by the last one. */
  reset(): void {
    this.gate = 0;
    this.speaking = 0;
    this.cooldowns.fill(0);
  }

  /**
   * Speaks a line if the horde has room for one. Returns false when it was
   * swallowed, which is the common case and is what the caller should use to
   * decide whether the bot has actually had its say.
   */
  say(cue: VoiceCue, take: number, pitch: number, distance: number): boolean {
    const def = CUES[cue];
    if (this.cooldowns[cue] > 0) return false;
    if (this.gate > 0 && def.priority <= this.speaking) return false;

    const lines = this.pick(take);
    if (lines === null) return false;
    const line = this.choose(take, lines, def.tags);
    if (line === null) return false;

    this.audio.playVoice(VOICE_TAKES[take].file, line.at, line.len, distance, pitch);

    // A line holds the floor for as long as it runs, plus a beat to answer in.
    this.gate = line.len / pitch + FLOOR;
    this.speaking = def.priority;
    this.cooldowns[cue] = def.cooldown;
    return true;
  }

  private pick(take: number): Readonly<Record<VoiceTag, readonly VoiceLine[]>> | null {
    return BY_TAG[take] ?? null;
  }

  /** First non-empty bucket in preference order, minus the line just used. */
  private choose(
    take: number,
    buckets: Readonly<Record<VoiceTag, readonly VoiceLine[]>>,
    tags: readonly VoiceTag[],
  ): VoiceLine | null {
    for (const tag of tags) {
      const pool = buckets[tag];
      if (pool.length === 0) continue;
      const all = VOICE_TAKES[take].lines;
      for (let attempt = 0; attempt < 3; attempt++) {
        const line = pool[Math.floor(this.rand() * pool.length) % pool.length];
        const index = all.indexOf(line);
        if (pool.length === 1 || index !== this.lastLine[take]) {
          this.lastLine[take] = index;
          return line;
        }
      }
      const line = pool[0];
      this.lastLine[take] = all.indexOf(line);
      return line;
    }
    return null;
  }
}
