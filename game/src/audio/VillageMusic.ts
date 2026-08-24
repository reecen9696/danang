/**
 * The song playing over the market square.
 *
 * It is not on the boombox and it is not the jungle bed: it belongs to the
 * village, so it is only there when you are. Structurally it borrows from both
 * — it streams from an `<audio>` element the way the radio's tracks do, because
 * four and a half minutes is far too much to hold decoded (Ambience explains
 * the trade the other way round), and it is gated by where the listener is
 * standing the way the radio is.
 *
 * What it deliberately does *not* borrow is the radio's chain. Nothing here is
 * squared off or band-limited on purpose: the boombox is a cheap speaker in a
 * field and is meant to sound like one, while this is simply what the village
 * sounds like. The only colour is distance — a lowpass that closes as you walk
 * out of the square, so from the road it is something carried across the paddy
 * rather than something being played at you.
 */

import type { AudioEngine } from './Audio';

/** File in public/music, without the extension (tools/prep-music.sh). */
const FILE = 'village-folk';

/** Level in the square itself, before the master limiter. */
const GAIN = 0.21;

/**
 * Blocks past the edge of the village shelf that it still carries. It reaches
 * the road down from the firebase and gives out well before the treeline, so
 * walking up to the market is walking into it.
 */
const FALLOFF = 30;

/** Band at the edge of the range, where all that is left is what carries. */
const FAR_HZ = 900;
/** Band in the square, i.e. no band at all. */
const NEAR_HZ = 16000;

/**
 * Seconds of silence before the element is actually paused. Gating the gain is
 * enough to make it inaudible, but a tab that has walked back to the firebase
 * shouldn't keep a decoder running for the rest of the wave. It resumes from
 * wherever it stopped, so the song is still going on when you come back — it
 * doesn't start over every time you visit, which is the whole point of it
 * belonging to the place rather than to the player.
 */
const IDLE_BEFORE_PAUSE = 4;

export class VillageMusic {
  private built = false;
  private element: HTMLAudioElement | null = null;
  private out: GainNode | null = null;
  private far: BiquadFilterNode | null = null;
  private idle = 0;
  /** Whether the element is meant to be running, play() being async. */
  private running = false;

  constructor(private readonly audio: AudioEngine) {}

  /**
   * Called every frame with how far outside the village the listener is, in
   * blocks — zero anywhere on the shelf. Safe before the audio context exists;
   * it no-ops until {@link AudioEngine.resume} has run.
   */
  setListener(distanceOutside: number, dt: number): void {
    if (distanceOutside >= FALLOFF) {
      // Out of earshot entirely: don't build a graph or fetch three megabytes
      // for a player who is up at the base and may never walk down.
      if (this.built) this.fade(0, dt);
      return;
    }
    if (!this.build()) return;
    const t = distanceOutside / FALLOFF;
    // Squared, so most of the song is still there for the length of the street
    // and the loss happens out on the road.
    this.fade((1 - t) * (1 - t), dt);
    this.far!.frequency.value = FAR_HZ + (NEAR_HZ - FAR_HZ) * (1 - t) * (1 - t);
  }

  /** Stops it and gives the decoder back. The next approach picks it up again. */
  stop(): void {
    this.running = false;
    this.element?.pause();
    const ctx = this.audio.context;
    if (this.out && ctx) this.out.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
  }

  // -------------------------------------------------------------------------
  private fade(level: number, dt: number): void {
    const ctx = this.audio.context;
    if (!this.out || !ctx || !this.element) return;
    // Ramped rather than assigned: walking the street shouldn't zipper.
    this.out.gain.setTargetAtTime(level * GAIN, ctx.currentTime, 0.25);

    if (level > 0.001) {
      this.idle = 0;
      if (!this.running) {
        this.running = true;
        void this.element.play().catch(() => { this.running = false; });
      }
      return;
    }
    if (!this.running) return;
    this.idle += dt;
    if (this.idle >= IDLE_BEFORE_PAUSE) {
      this.running = false;
      this.element.pause();
    }
  }

  private build(): boolean {
    if (this.built) return true;
    const ctx = this.audio.context;
    const bus = this.audio.output;
    if (!ctx || !bus) return false;

    const el = new Audio(`${import.meta.env.BASE_URL || './'}music/${FILE}.mp3`);
    el.preload = 'none';
    // A song a village plays is a song a village keeps playing. The gap an
    // element leaves at the seam is a handful of milliseconds of encoder
    // padding, and unlike the jungle bed this is a piece of music with a start
    // and an end — a breath between takes reads as the take ending.
    el.loop = true;

    const far = ctx.createBiquadFilter();
    far.type = 'lowpass';
    far.frequency.value = FAR_HZ;
    far.Q.value = 0.7;

    const out = ctx.createGain();
    out.gain.value = 0;

    ctx.createMediaElementSource(el).connect(far).connect(out).connect(bus);

    this.element = el;
    this.far = far;
    this.out = out;
    this.built = true;
    return true;
  }
}
