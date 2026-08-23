/**
 * The jungle bed: birds and insects, running under everything, forever.
 *
 * Unlike the radio, this streams from nothing — it's decoded into a buffer and
 * looped by the Web Audio graph. That costs about 21 MB of float for the minute
 * of stereo, which is the opposite of the call Radio makes for its songs, and
 * deliberately so: an `<audio>` element's `loop` is not gapless. MP3 carries
 * encoder padding at both ends, so an element restarting the file drops a
 * short hole in the middle of the ambience every minute, which is precisely the
 * kind of thing a listener notices even when they can't say what they heard.
 * An AudioBufferSourceNode loops sample-accurately.
 *
 * The loop point itself is built into the file (tools/prep-ambience.sh); all
 * that's needed here is to keep the decoder's padding out of the loop region.
 */

import type { AudioEngine } from './Audio';

/** File in public/sfx, without the extension. */
const FILE = 'ambience-jungle';

/**
 * Level of the bed. The file is already mastered well down (-26 LUFS), so this
 * is a second cut on top of that: ambience should be the thing you stop hearing
 * after a minute and miss when it's gone, not a layer you mix against.
 *
 * 0.21 of amplitude, about -13.5 dB, and quiet enough that it reads as air
 * rather than as a track that is playing.
 */
const GAIN = 0.21;

/** Seconds to fade up on start, so it arrives rather than switching on. */
const FADE_IN = 3;

/**
 * Trimmed off each end of the loop region. MP3 decoders don't all strip the
 * encoder's delay and padding identically, and whatever they leave is silence
 * at the head or tail — a tick, once per loop. Skipping a few milliseconds of
 * either end sidesteps the whole question. The seam moves by that much, which
 * for a bird bed is not a thing anyone can hear.
 */
const EDGE_TRIM = 0.05;

export class Ambience {
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private loading = false;
  /** Level the bed sits at, before the fade. Survives a stop/start. */
  private level = GAIN;

  constructor(private readonly audio: AudioEngine) {}

  get playing(): boolean {
    return this.source !== null;
  }

  /**
   * Starts the bed, fetching and decoding on first call. Safe to call
   * repeatedly and safe to call before the audio context exists — it no-ops
   * until {@link AudioEngine.resume} has run, since that needs a user gesture.
   */
  start(): void {
    if (this.source || this.loading) return;
    const ctx = this.audio.context;
    const out = this.audio.output;
    if (!ctx || !out) return;

    this.loading = true;
    void (async () => {
      try {
        const base = import.meta.env.BASE_URL || './';
        const res = await fetch(`${base}sfx/${FILE}.mp3`);
        if (!res.ok) return;
        const buffer = await ctx.decodeAudioData(await res.arrayBuffer());
        // The player may have stopped it, or the tab gone, while we decoded.
        if (this.source) return;

        const gain = ctx.createGain();
        gain.gain.value = 0;
        gain.gain.setValueAtTime(0, ctx.currentTime);
        gain.gain.linearRampToValueAtTime(this.level, ctx.currentTime + FADE_IN);
        gain.connect(out);

        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        source.loopStart = EDGE_TRIM;
        source.loopEnd = Math.max(EDGE_TRIM * 2, buffer.duration - EDGE_TRIM);
        source.connect(gain);
        source.start(0, EDGE_TRIM);

        this.gain = gain;
        this.source = source;
      } catch {
        // No ambience is a fine outcome; the game is not quiet without it.
      } finally {
        this.loading = false;
      }
    })();
  }

  stop(): void {
    this.source?.stop();
    this.source?.disconnect();
    this.gain?.disconnect();
    this.source = null;
    this.gain = null;
  }

  /** Scales the bed, 0..1, on top of its own level. */
  setLevel(v: number): void {
    this.level = GAIN * Math.max(0, Math.min(1, v));
    const ctx = this.audio.context;
    if (this.gain && ctx) {
      this.gain.gain.setTargetAtTime(this.level, ctx.currentTime, 0.2);
    }
  }
}
