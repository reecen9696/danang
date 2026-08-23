/**
 * Game audio.
 *
 * Gunfire, reloads and weapon handling are real field recordings (Snake's
 * Authentic Gun Sounds 2 — see public/sfx and tools/prep-sfx.sh). Everything
 * else — impacts, digging, UI stingers — is still synthesised with WebAudio at
 * runtime, and the synthesised voice also stands in for any sample that hasn't
 * finished decoding yet, so the game is never silent while it loads.
 *
 * Enemy speech is separate again: two long takes from two actors, decoded whole
 * and sliced into lines at playback (see playVoice and audio/Voices.ts). It
 * carries further than gunfire but arrives in far worse shape: filtered down to
 * a mumble and mostly reflection rather than direct sound, so you can tell how
 * far off a man is from how little of him actually reaches you.
 */

import { VOICE_TAKES } from './voiceLines';

interface SampleDef {
  /** File in public/sfx, without the extension. */
  readonly file: string;
  /** Interchangeable takes of the same sound; one is picked at random. */
  readonly alts?: readonly string[];
  readonly gain: number;
  /**
   * Base playback rate. It doubles as a pitch shift, which is how one
   * recording covers several calibres the pack doesn't include.
   */
  readonly rate?: number;
  /** ± fraction of random pitch wobble, so repeat shots aren't clones. */
  readonly jitter?: number;
  /** Simultaneous copies allowed before the oldest one is stolen. */
  readonly voices?: number;
  /** Fade out over this many seconds — stops fast guns stacking reverb tails. */
  readonly tail?: number;
  /** Low sine layered underneath for weight the recording doesn't have. */
  readonly sub?: readonly [start: number, end: number, duration: number, gain: number];
  /** Also fire the synthesised voice of the same name, layered under. */
  readonly synth?: boolean;
  /** Synthesised voice to stand in while the sample is still loading. */
  readonly fallback?: string;
  /**
   * Cutoff at the listener's own ear, in Hz — where the sweep out to AIR_FLOOR
   * starts. Only meaningful alongside `range`, and only worth setting when the
   * sound should be dull even at no distance at all.
   */
  readonly muffle?: number;
  /**
   * Blocks past which this isn't heard at all, with the steeper falloff to
   * match. For anything with a man behind it: gunfire carries across the whole
   * map, a voice does not.
   */
  readonly range?: number;
}

export interface PlayOptions {
  /** Squeeze the sample into this many seconds (speeds it up, then fades). */
  fit?: number;
  /** Start late enough that the sample *ends* this many seconds from now. */
  endAt?: number;
  /** Extra start delay, in seconds. */
  delay?: number;
  /** Pitch multiplier on top of the sample's own rate. */
  rate?: number;
}

/**
 * The pack ships .22LR, 5.56, 7.62x39 and 7.62x54R. The shotgun and the
 * launcher are the 7.62s pitched down and given a synthesised sub, which reads
 * as a bigger bore far better than a stand-in from another library would.
 */
const SAMPLES: Readonly<Record<string, SampleDef>> = {
  pistol: { file: 'shot-22lr', gain: 0.8, rate: 0.92, jitter: 0.04 },
  smg: { file: 'shot-556', gain: 0.55, rate: 1.06, jitter: 0.05, voices: 8, tail: 0.9 },
  rifle: { file: 'shot-762x54r', gain: 0.9, jitter: 0.03, voices: 6 },
  shotgun: { file: 'shot-762x39', gain: 1, rate: 0.74, jitter: 0.03, sub: [120, 45, 0.26, 0.3] },
  rocket: { file: 'shot-762x54r', gain: 0.85, rate: 0.52, jitter: 0.02, sub: [90, 38, 0.4, 0.26] },
  explosion: { file: 'shot-762x54r', gain: 0.85, rate: 0.4, jitter: 0.05, synth: true },

  'reload-pistol-out': { file: 'reload-pistol-out', gain: 0.6, fallback: 'reload' },
  'reload-pistol-in': { file: 'reload-pistol-in', gain: 0.6, fallback: 'reload' },
  'reload-ar-out': { file: 'reload-ar-out', gain: 0.6, fallback: 'reload' },
  'reload-ar-in': { file: 'reload-ar-in', gain: 0.6, fallback: 'reload' },
  'reload-rifle-out': { file: 'reload-rifle-out', gain: 0.6, fallback: 'reload' },
  'reload-rifle-in': { file: 'reload-rifle-in', gain: 0.6, fallback: 'reload' },
  'reload-ak-out': { file: 'reload-ak-out', gain: 0.6, rate: 0.9, fallback: 'reload' },
  'reload-ak-in': { file: 'reload-ak-in', gain: 0.6, rate: 0.9, fallback: 'reload' },

  'shell-load': { file: 'shell-load', gain: 0.6, jitter: 0.05, fallback: 'reload' },
  // The bolt and pump recordings are close-mic'd with no reverb, so they peak
  // far higher than their perceived loudness — held well down against the shot.
  'cycle-bolt': { file: 'cycle-bolt', gain: 0.32, jitter: 0.03, fallback: 'reload' },
  'cycle-pump': { file: 'cycle-pump', gain: 0.5, jitter: 0.03, fallback: 'reload' },
  'bolt-release': { file: 'bolt-release', gain: 0.5, fallback: 'reload' },
  rack: { file: 'charging-handle', gain: 0.4, fallback: 'reload' },

  // The wave-start bugle (see tools/prep-stinger.sh). Non-diegetic: it is
  // played at distance 0, so it arrives dry while everything else is being
  // pushed through air. One voice, because a second call over the first reads
  // as a mistake rather than as urgency.
  wave: { file: 'wave-horn', gain: 1, jitter: 0, voices: 1 },

  // Two takes, picked between at random, because a wave is seventy men and one
  // scream on repeat is a sound effect rather than a death.
  'death-cry': {
    file: 'death-cry-a', alts: ['death-cry-b'],
    gain: 1, jitter: 0.05, voices: 3, range: 90, muffle: 2400, fallback: 'death',
  },
};

/** How far a shout carries before it's lost entirely, in blocks. */
const VOICE_RANGE = 130;
/** Level the voice takes sit at against the gunfire. */
const VOICE_GAIN = 1.45;
/**
 * Cap on how late a voice may arrive. Longer than the one on gunfire: a shot
 * has to read as immediate feedback, a shout is better off sounding like it
 * came from wherever the man actually is.
 */
const VOICE_MAX_DELAY = 0.45;
/**
 * Cutoff a voice has been eaten down to by the far edge of its range, in Hz.
 *
 * There is no reverb anywhere in this engine, deliberately: an echo on every
 * shout turns open ground into a cave. Distance is level and the highs going
 * with it, nothing else — so the sweep between a sound's ceiling and this is
 * doing all of the work the falloff isn't.
 */
const AIR_FLOOR = 420;
/** Distance, as a fraction of a sound's range, by which it is down to the floor. */
const AIR_FLOOR_AT = 0.6;
/** Cutoff the voice takes reach the ear at, and how fast the air eats it. */
const VOICE_CEILING = 9000;
const VOICE_SOAK = 0.28;
/**
 * How hard the falloff bites for a ranged sample. Two is a death cry: full
 * force over the man's shoulder, a thin far-off thing by twenty blocks out.
 */
const RANGE_BITE = 2;
/**
 * Enemies talking over each other at once. Past three it stops being a squad
 * calling contact and turns into a crowd.
 */
const VOICE_CAP = 3;

/** World units per second. Blocks are metre-scale, so this is the real value. */
const SPEED_OF_SOUND = 340;
/** Cap on propagation delay, so far-off fire still reads as immediate feedback. */
const MAX_PROPAGATION_DELAY = 0.25;

interface Voice {
  readonly source: AudioBufferSourceNode;
  readonly gain: GainNode;
  /** Context time this voice is expected to be finished at. */
  readonly end: number;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** Everything connects here: a limiter sitting in front of the master gain. */
  private bus: AudioNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly voices = new Map<string, Voice[]>();
  enabled = true;
  volume = 0.5;

  /** Must be called from a user gesture. */
  resume(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);

      // The recordings peak near 0 dBFS, so a firefight's worth of overlapping
      // shots would clip the output without something holding the ceiling.
      const limiter = this.ctx.createDynamicsCompressor();
      limiter.threshold.value = -6;
      limiter.knee.value = 6;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.25;
      limiter.connect(this.master);
      this.bus = limiter;

      this.noiseBuffer = this.makeNoise(1.0);
      void this.loadSamples();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /**
   * The context and the node everything hangs off, for effect chains that live
   * outside this class. Both are null until {@link resume} has run, which is
   * the caller's cue to build nothing yet.
   */
  get context(): AudioContext | null {
    return this.ctx;
  }

  /** Where an external chain connects: in front of the limiter, as usual. */
  get output(): AudioNode | null {
    return this.bus;
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  /** Decodes every sample once. Failures are silent — play() falls back. */
  private async loadSamples(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    const base = import.meta.env.BASE_URL || './';
    const files = new Set<string>();
    for (const def of Object.values(SAMPLES)) {
      files.add(def.file);
      if (def.alts) for (const alt of def.alts) files.add(alt);
    }
    // The voice takes are decoded whole and sliced at playback, so a speaker's
    // thirty-odd barks cost one fetch and one buffer rather than thirty.
    for (const take of VOICE_TAKES) files.add(take.file);
    await Promise.all([...files].map(async (file) => {
      try {
        const res = await fetch(`${base}sfx/${file}.mp3`);
        if (!res.ok) return;
        this.buffers.set(file, await ctx.decodeAudioData(await res.arrayBuffer()));
      } catch {
        // Leave it unloaded; the synthesised voice covers for it.
      }
    }));
  }

  private makeNoise(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** Distance attenuation without the cost of a full PannerNode graph. */
  private gainFor(distance: number, base: number): number {
    if (distance <= 0) return base;
    return base / (1 + distance * distance * 0.0025);
  }

  /**
   * Distance falloff for a shouted voice. Steeper than gainFor, and with an end
   * to it: gunfire carries across the whole map, a man yelling does not.
   *
   * `bite` steepens both halves of the curve at once, for sounds that should be
   * loud only at arm's length. A scream is either at your shoulder or it is
   * somebody else's problem two streets away; chatter fades more evenly.
   */
  private voiceGainFor(distance: number, range = VOICE_RANGE, bite = 1): number {
    if (distance >= range) return 0;
    return (1 - distance / range) ** bite / (1 + distance * distance * 0.0012 * bite);
  }

  /**
   * Places a sound at a distance. With no reverb in the engine this is half of
   * the whole effect: air soaks up the highs either way, but anything with a
   * man behind it gets it far harder, and has its body thinned out underneath
   * as well, because a voice that far off reaches you as midrange and very
   * little else.
   *
   * `human` is the pair the sweep runs between — the cutoff at the listener's
   * own ear, and how fast the air eats it. A sample can start well down: a
   * scream is a scream, not a man reading the news, and should sound muffled
   * even when he drops at your feet.
   */
  private throughAir(
    source: AudioNode, distance: number,
    human: { ceiling: number; soak: number } | null,
  ): AudioNode {
    const ctx = this.ctx!;
    if (!human) {
      const cutoff = 20000 / (1 + distance * 0.09);
      if (cutoff >= 16000) return source;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = Math.max(500, cutoff);
      return source.connect(filter);
    }

    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = Math.max(AIR_FLOOR, human.ceiling / (1 + distance * human.soak));
    lowpass.Q.value = 0.7;

    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    // Floored under the lowpass on purpose: however far off a man is, what's
    // left of him has to still be a band and not a sliver.
    highpass.frequency.value = Math.min(240, 65 + distance * 1.9);
    highpass.Q.value = 0.7;

    return source.connect(highpass).connect(lowpass);
  }

  /**
   * Speaks one line out of a voice take — `at` seconds in, `len` seconds long.
   *
   * Four things place it. The level drops. The highs go with it, hard, so a man
   * calling from across the paddy is a muffled shape rather than words. The
   * body thins out underneath, because a voice that far off reaches you as
   * midrange and little else. And most of what you hear stops being the man at
   * all and becomes the treeline throwing him back at you a moment later, which
   * is the cue the ear actually reads as distance — level on its own only ever
   * reads as quiet.
   */
  playVoice(file: string, at: number, len: number, distance: number, rate = 1): void {
    if (!this.enabled || !this.ctx || !this.bus) return;
    const atten = this.voiceGainFor(distance) * VOICE_GAIN;
    if (atten < 0.01) return;
    const buffer = this.buffers.get(file);
    if (!buffer) return;

    const ctx = this.ctx;
    const clip = Math.min(len, buffer.duration - at);
    if (clip <= 0.05) return;
    const heard = clip / rate;
    const t = ctx.currentTime + Math.min(distance / SPEED_OF_SOUND, VOICE_MAX_DELAY);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;

    // Both ends of the slice land mid-waveform, so ease through them.
    const gain = ctx.createGain();
    const fade = Math.min(0.03, heard * 0.2);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(atten, t + fade);
    gain.gain.setValueAtTime(atten, t + heard - fade);
    gain.gain.linearRampToValueAtTime(0.0001, t + heard);

    this.throughAir(source, distance, { ceiling: VOICE_CEILING, soak: VOICE_SOAK })
      .connect(gain).connect(this.bus);

    this.claimVoice('voice', VOICE_CAP);
    source.start(t, at, clip);
    source.stop(t + heard + 0.02);
    this.trackVoice('voice', { source, gain, end: t + heard });
  }

  private noiseBurst(
    duration: number, gain: number,
    filterType: BiquadFilterType, freqStart: number, freqEnd: number,
    q = 1,
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.bus || !this.noiseBuffer) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(freqStart, ctx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, freqEnd), ctx.currentTime + duration);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
    src.connect(filter).connect(g).connect(this.bus);
    src.start();
    src.stop(ctx.currentTime + duration + 0.02);
  }

  private tone(
    freqStart: number, freqEnd: number, duration: number, gain: number,
    type: OscillatorType = 'square', delay = 0,
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.bus) return;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freqStart, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t + duration);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(g).connect(this.bus);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  play(name: string, distance = 0, opts?: PlayOptions): void {
    if (!this.enabled || !this.ctx) return;

    const sample = SAMPLES[name];
    const d = sample?.range
      ? this.voiceGainFor(distance, sample.range, RANGE_BITE)
      : this.gainFor(distance, 1);
    if (d < 0.008) return;

    if (!sample) {
      this.synth(name, d);
      return;
    }

    const file = sample.alts
      ? [sample.file, ...sample.alts][Math.floor(Math.random() * (sample.alts.length + 1))]
      : sample.file;
    const buffer = this.buffers.get(file);
    if (!buffer) {
      this.synth(sample.fallback ?? name, d);
      return;
    }

    this.playSample(name, sample, buffer, distance, d, opts);
    if (sample.synth) this.synth(name, d);
  }

  private playSample(
    key: string, def: SampleDef, buffer: AudioBuffer,
    distance: number, atten: number, opts?: PlayOptions,
  ): void {
    const ctx = this.ctx!;
    const bus = this.bus!;

    let rate = (def.rate ?? 1) * (opts?.rate ?? 1)
      * (1 + (Math.random() * 2 - 1) * (def.jitter ?? 0.03));

    // Reload recordings are timed to the gun they were taken from, not to ours,
    // so hurry them along when they'd run past the point the magazine is home.
    const window = opts?.fit ?? 0;
    if (window > 0) {
      const over = buffer.duration / rate / window;
      if (over > 1) rate *= Math.min(over, 1.4);
    }

    // Anything with a man behind it is placed the way the voice takes are.
    const human = def.range !== undefined;

    let start = opts?.delay ?? 0;
    if (opts?.endAt) start = Math.max(start, opts.endAt - buffer.duration / rate);
    // Sound travels: distant gunfire arrives a beat after you see the flash.
    // A shot has to read as immediate feedback so its lateness is capped short;
    // a scream is better off sounding like it came from where the man is.
    start += Math.min(distance / SPEED_OF_SOUND, human ? VOICE_MAX_DELAY : MAX_PROPAGATION_DELAY);
    const t = ctx.currentTime + start;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;

    const gain = ctx.createGain();
    const peak = def.gain * atten;
    gain.gain.value = peak;

    // The sweep is scaled to the sound's own range, so however muffled it
    // starts, it is down to the floor well before it is out of earshot.
    const ceiling = def.muffle ?? VOICE_CEILING;
    this.throughAir(source, distance, def.range === undefined ? null : {
      ceiling,
      soak: (ceiling / AIR_FLOOR - 1) / (def.range * AIR_FLOOR_AT),
    }).connect(gain).connect(bus);

    let duration = buffer.duration / rate;
    const limit = Math.min(def.tail ?? duration, window > 0 ? window : duration);
    if (limit < duration) {
      gain.gain.setValueAtTime(peak, t + Math.max(0, limit - 0.12));
      gain.gain.linearRampToValueAtTime(0.0001, t + limit);
      duration = limit;
    }

    this.claimVoice(key, def.voices ?? 8);
    source.start(t);
    source.stop(t + duration + 0.02);
    this.trackVoice(key, { source, gain, end: t + duration });

    if (def.sub) this.tone(def.sub[0], def.sub[1], def.sub[2], def.sub[3] * atten, 'sine', start);
  }

  /** Drops finished voices and steals the oldest one if we're at the cap. */
  private claimVoice(key: string, cap: number): void {
    const ctx = this.ctx!;
    const list = this.voices.get(key);
    if (!list) return;
    const now = ctx.currentTime;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].end <= now) list.splice(i, 1);
    }
    while (list.length >= cap) {
      const v = list.shift()!;
      v.gain.gain.cancelScheduledValues(now);
      v.gain.gain.setValueAtTime(v.gain.gain.value, now);
      v.gain.gain.linearRampToValueAtTime(0.0001, now + 0.04);
      v.source.stop(now + 0.05);
    }
  }

  private trackVoice(key: string, voice: Voice): void {
    const list = this.voices.get(key);
    if (list) list.push(voice);
    else this.voices.set(key, [voice]);
  }

  /** The synthesised voices: impacts, tools, UI, and cover for missing samples. */
  private synth(name: string, d: number): void {
    switch (name) {
      case 'pistol':
        this.noiseBurst(0.11, 0.32 * d, 'bandpass', 2400, 500, 1.2);
        this.tone(320, 90, 0.09, 0.16 * d, 'square');
        break;
      case 'smg':
        this.noiseBurst(0.07, 0.24 * d, 'bandpass', 3000, 700, 1.4);
        this.tone(380, 120, 0.06, 0.11 * d, 'square');
        break;
      case 'rifle':
        this.noiseBurst(0.2, 0.42 * d, 'bandpass', 1800, 260, 0.9);
        this.tone(210, 60, 0.16, 0.22 * d, 'sawtooth');
        break;
      case 'shotgun':
        this.noiseBurst(0.3, 0.5 * d, 'lowpass', 2200, 200, 0.7);
        this.tone(150, 45, 0.22, 0.26 * d, 'sawtooth');
        break;
      case 'rocket':
        this.noiseBurst(0.5, 0.4 * d, 'lowpass', 1200, 140, 0.6);
        this.tone(160, 40, 0.4, 0.2 * d, 'sawtooth');
        break;
      case 'explosion':
        this.noiseBurst(0.85, 0.7 * d, 'lowpass', 900, 60, 0.5);
        this.tone(110, 28, 0.6, 0.34 * d, 'sine');
        break;
      case 'spade':
        this.noiseBurst(0.09, 0.22 * d, 'bandpass', 900, 300, 2);
        break;
      case 'dig':
        this.noiseBurst(0.14, 0.26 * d, 'lowpass', 1400, 320, 1);
        break;
      case 'place':
        this.tone(520, 700, 0.05, 0.14 * d, 'triangle');
        break;
      case 'blockbreak':
        this.noiseBurst(0.18, 0.3 * d, 'lowpass', 1800, 250, 0.8);
        break;
      case 'hit':
        this.tone(900, 1500, 0.05, 0.16 * d, 'sine');
        break;
      case 'headshot':
        this.tone(1400, 2100, 0.08, 0.2 * d, 'sine');
        break;
      case 'hurt':
        this.noiseBurst(0.22, 0.3, 'lowpass', 700, 160, 0.8);
        this.tone(180, 90, 0.2, 0.16, 'sawtooth');
        break;
      case 'reload':
        this.noiseBurst(0.06, 0.16 * d, 'bandpass', 1600, 900, 3);
        break;
      case 'throw':
        this.noiseBurst(0.09, 0.14 * d, 'highpass', 900, 1800, 1);
        break;
      case 'buy':
        this.tone(660, 990, 0.09, 0.2, 'triangle');
        this.tone(990, 1320, 0.09, 0.16, 'triangle', 0.07);
        break;
      case 'deny':
        this.tone(220, 150, 0.16, 0.2, 'square');
        break;
      case 'wave':
        this.tone(180, 240, 0.55, 0.22, 'sawtooth');
        this.tone(240, 320, 0.55, 0.2, 'sawtooth', 0.26);
        break;
      case 'clear':
        this.tone(523, 659, 0.16, 0.2, 'triangle');
        this.tone(659, 784, 0.16, 0.2, 'triangle', 0.13);
        this.tone(784, 1046, 0.28, 0.2, 'triangle', 0.26);
        break;
      case 'death':
        this.tone(300, 60, 1.0, 0.3, 'sawtooth');
        break;
      case 'step':
        this.noiseBurst(0.05, 0.07 * d, 'lowpass', 600, 200, 1);
        break;
      default:
        break;
    }
  }
}
