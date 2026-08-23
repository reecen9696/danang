/**
 * The boombox in the base.
 *
 * Two things are going on here. The tracks stream from `<audio>` elements
 * rather than being decoded into buffers — a four-minute song is forty-odd
 * megabytes of float once decoded, and an element gives us play, pause and
 * end-of-track for free — and everything they produce is dragged through a
 * chain built to sound like a cheap speaker in a field rather than like music.
 *
 * That chain is deliberately brutal: two poles of highpass take the bass out
 * entirely, a hard midrange lift gives it the cupped-hands honk of a paper
 * cone, saturation squares off anything loud, and two poles of lowpass throw
 * away the top before the harmonics that saturation just made can be heard as
 * detail. Hiss and crackle sit underneath, and the whole thing drifts a few
 * percent in level because nothing running off a battery in 1969 held still.
 *
 * It is positional: the boombox is an object standing in one place, so the
 * level and what's left of the top end both fall off as you walk away from it.
 */

import type { AudioEngine } from './Audio';

export interface RadioTrack {
  /** File in public/music, without the extension. */
  readonly file: string;
  readonly title: string;
}

export const TRACKS: readonly RadioTrack[] = [
  { file: 'fortunate-son', title: 'Fortunate Son — Creedence Clearwater Revival' },
  { file: 'grapevine', title: 'I Heard It Through The Grapevine — Creedence Clearwater Revival' },
];

/** How far the boombox carries before it's lost, in blocks. */
const RANGE = 70;
/**
 * Level at the speaker itself. Everything on the box — music, hiss and the
 * crackles — runs through this one node, so it scales the lot.
 *
 * The saturation upstream is normalised to full scale, so whatever the mp3 was
 * mastered at, this node sees a signal peaking at 1.0 and this number *is* the
 * level going into the master limiter. That limiter is why the useful range
 * here is lower than it looks: it starts squeezing at -6 dBFS with a 6 dB knee
 * at 12:1, so anything above about 0.35 lands inside the knee and turning it
 * down mostly gets given straight back as makeup. Below that the box responds
 * roughly one-for-one again.
 */
const GAIN = 0.13;

/** Band the chain passes. Everything outside it is gone, not merely quieter. */
const HP_HZ = 420;
const LP_HZ = 2600;
/** The honk: a fat lift where a small paper cone has its only real output. */
const PEAK_HZ = 1750;
const PEAK_DB = 11;
/** Saturation amount. Above about 4 it stops being a speaker and starts buzzing. */
const DRIVE = 3.2;

const HISS_GAIN = 0.022;
/** Seconds between crackles, on average. */
const CRACKLE_EVERY = 2.6;

export class Radio {
  private built = false;
  private readonly elements: HTMLAudioElement[] = [];
  /** Set by the distance update; the last node before the bus. */
  private out: GainNode | null = null;
  /** Air absorption on top of the chain's own band limit. */
  private far: BiquadFilterNode | null = null;
  private analyser: AnalyserNode | null = null;
  private hissGain: GainNode | null = null;
  private samples: Float32Array<ArrayBuffer> | null = null;
  private crackleTimer = CRACKLE_EVERY;

  private index = 0;
  playing = false;

  constructor(private readonly audio: AudioEngine) {}

  get track(): RadioTrack {
    return TRACKS[this.index];
  }

  /** How far through the current track, 0..1. Zero when nothing has loaded. */
  get progress(): number {
    const el = this.elements[this.index];
    if (!el || !el.duration) return 0;
    return el.currentTime / el.duration;
  }

  /**
   * Loudness right now, 0..1, tapped before the distance gain — the meter on
   * the front of the box is showing what the speaker is doing, not what
   * survives the walk over to you.
   */
  get level(): number {
    if (!this.playing || !this.analyser || !this.samples) return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (let i = 0; i < this.samples.length; i++) sum += this.samples[i] * this.samples[i];
    return Math.min(1, Math.sqrt(sum / this.samples.length) * 4.5);
  }

  /**
   * Red button. Returns the new state, or null if the audio context isn't up
   * yet and there was nothing to toggle.
   */
  toggle(): boolean | null {
    if (!this.build()) return null;
    if (this.playing) {
      this.pause();
      return false;
    }
    void this.elements[this.index].play().catch(() => { this.playing = false; });
    this.playing = true;
    this.setHiss(true);
    return true;
  }

  /** Blue button. Steps to the next track, and keeps playing if it was. */
  next(): RadioTrack | null {
    if (!this.build()) return null;
    const wasPlaying = this.playing;
    const el = this.elements[this.index];
    el.pause();
    el.currentTime = 0;
    this.index = (this.index + 1) % TRACKS.length;
    if (wasPlaying) {
      void this.elements[this.index].play().catch(() => { this.playing = false; });
    }
    return this.track;
  }

  pause(): void {
    this.playing = false;
    this.setHiss(false);
    for (const el of this.elements) el.pause();
  }

  /** Called every frame with the listener's distance from the speaker. */
  setListener(distance: number, dt: number): void {
    if (!this.out || !this.far) return;
    const t = Math.min(1, distance / RANGE);
    const level = this.playing ? (1 - t) / (1 + distance * distance * 0.0022) : 0;
    // Ramped rather than assigned: walking past the box shouldn't zipper.
    this.out.gain.setTargetAtTime(level * GAIN, this.audio.context!.currentTime, 0.05);
    this.far.frequency.value = Math.max(700, LP_HZ / (1 + distance * 0.055));

    if (this.playing) this.crackle(dt, level);
  }

  // -------------------------------------------------------------------------
  private build(): boolean {
    if (this.built) return true;
    const ctx = this.audio.context;
    const bus = this.audio.output;
    if (!ctx || !bus) return false;

    const chainIn = ctx.createGain();

    for (const track of TRACKS) {
      const el = new Audio(`${import.meta.env.BASE_URL || './'}music/${track.file}.mp3`);
      el.preload = 'none';
      el.loop = false;
      // A track running out rolls onto the next one, the way a station would.
      el.addEventListener('ended', () => { this.next(); });
      ctx.createMediaElementSource(el).connect(chainIn);
      this.elements.push(el);
    }

    const hp1 = biquad(ctx, 'highpass', HP_HZ, 0.7);
    const hp2 = biquad(ctx, 'highpass', HP_HZ, 0.7);
    const peak = biquad(ctx, 'peaking', PEAK_HZ, 1.0, PEAK_DB);

    const shaper = ctx.createWaveShaper();
    shaper.curve = saturationCurve(DRIVE);
    shaper.oversample = '2x';

    const lp1 = biquad(ctx, 'lowpass', LP_HZ, 0.7);
    // The second pole doubles as the distance filter, so walking away keeps
    // taking the top off past where the speaker itself already had.
    const lp2 = biquad(ctx, 'lowpass', LP_HZ, 0.7);

    // A few percent of level drift. Nothing running off a battery held still.
    const wobble = ctx.createGain();
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.13;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.055;
    lfo.connect(lfoDepth).connect(wobble.gain);
    lfo.start();

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.6;

    const out = ctx.createGain();
    out.gain.value = 0;

    chainIn.connect(hp1).connect(hp2).connect(peak).connect(shaper)
      .connect(lp1).connect(lp2).connect(wobble).connect(out).connect(bus);
    wobble.connect(analyser);

    // Hiss, joined after the band limit so it isn't shaped by the saturation.
    const hiss = ctx.createBufferSource();
    hiss.buffer = noiseBuffer(ctx, 2);
    hiss.loop = true;
    const hissBand = biquad(ctx, 'bandpass', 2200, 0.6);
    const hissGain = ctx.createGain();
    hissGain.gain.value = 0;
    hiss.connect(hissBand).connect(hissGain).connect(out);
    hiss.start();

    this.out = out;
    this.far = lp2;
    this.analyser = analyser;
    this.samples = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
    this.hissGain = hissGain;
    this.built = true;
    return true;
  }

  private setHiss(on: boolean): void {
    const ctx = this.audio.context;
    if (!this.hissGain || !ctx) return;
    this.hissGain.gain.setTargetAtTime(on ? HISS_GAIN : 0, ctx.currentTime, 0.08);
  }

  /** Sparse pops through the same speaker, which is most of what sells AM. */
  private crackle(dt: number, level: number): void {
    const ctx = this.audio.context;
    if (!ctx || !this.out || level < 0.02) return;
    this.crackleTimer -= dt;
    if (this.crackleTimer > 0) return;
    this.crackleTimer = CRACKLE_EVERY * (0.4 + Math.random() * 1.2);

    const pop = ctx.createBufferSource();
    pop.buffer = noiseBuffer(ctx, 0.05);
    const band = biquad(ctx, 'bandpass', 1200 + Math.random() * 1800, 1.4);
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0.28 + Math.random() * 0.3, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    pop.connect(band).connect(g).connect(this.out);
    pop.start(t);
    pop.stop(t + 0.06);
  }
}

function biquad(
  ctx: AudioContext, type: BiquadFilterType, hz: number, q: number, gainDb = 0,
): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = hz;
  f.Q.value = q;
  if (gainDb) f.gain.value = gainDb;
  return f;
}

/** Soft clip. Normalised so the curve still reaches full scale at the edges. */
function saturationCurve(drive: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(new ArrayBuffer(n * 4));
  const norm = Math.tanh(drive);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) / norm;
  }
  return curve;
}

function noiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}
