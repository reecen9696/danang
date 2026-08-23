import * as THREE from 'three';
import { RENDER } from './constants';

/**
 * WebGL renderer plus an adaptive-resolution controller.
 *
 * Frame times are tracked with a rolling median; when we're consistently over
 * budget the internal render scale drops (and rises again when there's
 * headroom), which keeps the framerate stable on weaker GPUs without changing
 * anything about the scene.
 */
// Palette colours are authored in the shade they should appear on screen, so
// three.js must not apply its own linear<->sRGB conversion on top of them. The
// sun and ambient terms therefore multiply gamma-space albedo, which is why the
// intensities in core/lighting.ts are tuned by eye rather than derived.
THREE.ColorManagement.enabled = false;

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;

  /** Current internal resolution multiplier. */
  scale = 1;
  adaptive = true;

  private readonly samples = new Float32Array(30);
  private sampleIndex = 0;
  private sampleCount = 0;
  /** Wall-clock frame intervals, which is what "fps" actually means. */
  private readonly intervals = new Float32Array(30);
  private lastFrameStamp = 0;
  private cooldown = 0;
  private width = 1;
  private height = 1;
  private basePixelRatio = 1;

  onResize: ((w: number, h: number) => void) | null = null;

  constructor(container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'game-canvas';
    container.appendChild(this.canvas);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      // The voxel look has no need for tone mapping or colour grading.
      preserveDrawingBuffer: false,
    });

    // Sun shadows. PCF-soft rather than hard: voxel shadow edges are already
    // perfectly straight, and a hard map turns every one of them into a
    // staircase the moment the sun grazes a wall.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.renderer.setClearColor(RENDER.skyColor, 1);
    // We render the world and the first-person viewmodel as two passes, so
    // clearing is driven explicitly rather than per-render.
    this.renderer.autoClear = false;
    this.renderer.sortObjects = true;
    // Two render passes per frame, so stats are reset manually once per frame.
    this.renderer.info.autoReset = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.basePixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private resize(): void {
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.applyScale();
    this.onResize?.(this.width, this.height);
  }

  private applyScale(): void {
    const ratio = this.basePixelRatio * this.scale;
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(this.width, this.height, true);
  }

  get displayWidth(): number { return this.width; }
  get displayHeight(): number { return this.height; }

  /**
   * Feed each frame's CPU cost in ms. Frame *intervals* are timed here too, so
   * the overlay can distinguish "we have headroom" from "we're hitting vsync".
   */
  sample(frameMs: number): void {
    const now = performance.now();
    if (this.lastFrameStamp > 0) this.intervals[this.sampleIndex] = now - this.lastFrameStamp;
    this.lastFrameStamp = now;
    this.samples[this.sampleIndex] = frameMs;
    this.sampleIndex = (this.sampleIndex + 1) % this.samples.length;
    if (this.sampleCount < this.samples.length) this.sampleCount++;

    if (!this.adaptive) return;
    this.cooldown -= frameMs;
    if (this.cooldown > 0 || this.sampleCount < this.samples.length) return;
    this.cooldown = 700;

    const median = this.medianFrameMs();
    const target = RENDER.targetFrameMs;

    if (median > target * 1.35 && this.scale > RENDER.minScale) {
      this.scale = Math.max(RENDER.minScale, this.scale - 0.1);
      this.applyScale();
    } else if (median < target * 0.75 && this.scale < RENDER.maxScale) {
      this.scale = Math.min(RENDER.maxScale, this.scale + 0.05);
      this.applyScale();
    }
  }

  medianFrameMs(): number {
    const n = this.sampleCount;
    if (n === 0) return 0;
    const copy = Array.from(this.samples.subarray(0, n)).sort((a, b) => a - b);
    return copy[n >> 1];
  }

  /** Median wall-clock frame interval in ms. */
  medianIntervalMs(): number {
    const n = this.sampleCount;
    if (n === 0) return 0;
    const copy = Array.from(this.intervals.subarray(0, n)).filter((v) => v > 0).sort((a, b) => a - b);
    return copy.length ? copy[copy.length >> 1] : 0;
  }

  get fps(): number {
    const m = this.medianIntervalMs();
    return m > 0 ? 1000 / m : 0;
  }

  setAdaptive(on: boolean): void {
    this.adaptive = on;
    if (!on) {
      this.scale = 1;
      this.applyScale();
    }
  }
}
