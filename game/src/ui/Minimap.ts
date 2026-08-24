import type { BotManager } from '../ai/BotManager';
import { BotKind } from '../ai/botTypes';
import { GFX } from './gfx';

/**
 * Loads an image and reports when it's usable.
 *
 * The minimap redraws constantly, so it just skips any sprite that hasn't
 * arrived yet rather than blocking on the load.
 */
function sprite(url: string): HTMLImageElement {
  const img = new Image();
  img.src = url;
  return img;
}

const SIZE = 150;
/** World units visible across the minimap. */
const RANGE = 150;

/** How close an unalerted sentry has to be before the radar admits he exists. */
const GARRISON_REVEAL = 12;

/**
 * Radar-style minimap drawn to a small 2D canvas.
 *
 * It renders at a low fixed rate (not once per frame) because the information
 * it carries doesn't change fast enough to justify the fill cost.
 */
export class Minimap {
  private readonly ctx: CanvasRenderingContext2D;
  private timer = 0;

  // The original map markers, drawn in place of hand-rolled canvas shapes.
  private readonly imgPlayer = sprite(GFX.mapPlayer);
  private readonly imgView = sprite(GFX.mapView);
  private readonly imgPost = sprite(GFX.mapCommandPost);
  private readonly imgIntel = sprite(GFX.mapIntel);
  private readonly tintCache = new Map<string, HTMLCanvasElement>();

  constructor(canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    canvas.width = SIZE;
    canvas.height = SIZE;
  }

  update(
    dt: number,
    px: number, pz: number, yaw: number,
    bots: BotManager,
    base: { x: number; z: number },
    town: { x: number; z: number },
    inTown: boolean,
  ): void {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 1 / 15;

    const ctx = this.ctx;
    const half = SIZE / 2;
    const scale = half / (RANGE / 2);

    ctx.clearRect(0, 0, SIZE, SIZE);

    // No backdrop and no frame: the ring below is the whole chrome, so what
    // you read is the contacts rather than a plate with contacts on it.
    ctx.save();
    ctx.beginPath();
    ctx.arc(half, half, half - 1, 0, Math.PI * 2);
    ctx.clip();

    // Rotate so the player always faces "up". Map space is (x, z) with z down,
    // and the player faces (-sin yaw, -cos yaw), so +yaw brings that to the top.
    ctx.translate(half, half);
    ctx.rotate(yaw);

    const plot = (wx: number, wz: number): [number, number] => [
      (wx - px) * scale,
      (wz - pz) * scale,
    ];

    // Range rings, with the outermost doing duty as the rim.
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    for (const r of [0.33, 0.66]) {
      ctx.beginPath();
      ctx.arc(0, 0, (half - 1) * r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, half - 2, 0, Math.PI * 2);
    ctx.stroke();

    // Base marker — the command post icon, counter-rotated so it stays upright.
    {
      const [bx, bz] = plot(base.x, base.z);
      this.drawMarker(this.imgPost, bx, bz, 14, yaw, '#4ea3ff');
    }

    // Town marker — the intel icon, brighter while you're standing in it.
    {
      const [tx, tz] = plot(town.x, town.z);
      this.drawMarker(this.imgIntel, tx, tz, 14, yaw, inTown ? '#ffc63f' : '#c99a2e');
    }

    // Enemies
    for (const bot of bots.bots) {
      if (!bot.alive) continue;
      // A camp you can read off the radar is not an ambush. Garrisons stay off
      // it until they give themselves away -- by opening up, by being shot at,
      // or by being close enough that you would hear them anyway.
      if (bot.garrison && !bot.revealed) {
        const near = Math.hypot(bot.position.x - px, bot.position.z - pz);
        if (near > GARRISON_REVEAL) continue;
      }
      const [bx, bz] = plot(bot.position.x, bot.position.z);
      if (Math.hypot(bx, bz) > half - 2) {
        // Clamp off-screen contacts to the rim so you still know the bearing.
        const a = Math.atan2(bz, bx);
        const r = half - 4;
        ctx.fillStyle = 'rgba(255,92,72,0.55)';
        ctx.fillRect(Math.cos(a) * r - 1.5, Math.sin(a) * r - 1.5, 3, 3);
        continue;
      }
      const big = bot.kind === BotKind.Tank || bot.kind === BotKind.Boss;
      ctx.fillStyle = bot.kind === BotKind.Boss ? '#ff2f6a'
        : bot.kind === BotKind.Sapper ? '#ff8a3f' : '#ff5c48';
      const s = big ? 5 : 3;
      ctx.fillRect(bx - s / 2, bz - s / 2, s, s);
    }

    ctx.restore();

    // North, on the rim.
    //
    // The map turns with you, so north is the one fixed thing on it -- without
    // a mark for it the radar tells you where the contacts are relative to your
    // nose and nothing about where they are on the ground. World north is -Z,
    // which the map rotation carries to (sin yaw, -cos yaw).
    {
      const dirX = Math.sin(yaw);
      const dirY = -Math.cos(yaw);
      ctx.save();
      // A tick straddling the rim, so the letter reads as a bearing rather
      // than as another contact.
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(half + dirX * (half - 7), half + dirY * (half - 7));
      ctx.lineTo(half + dirX * (half - 1), half + dirY * (half - 1));
      ctx.stroke();

      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = 'bold 11px Helvetica, Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('N', half + dirX * (half - 15), half + dirY * (half - 15));
      ctx.restore();
    }

    // Player: the original view cone under the original arrow, both centred.
    if (this.imgView.complete && this.imgView.naturalWidth > 0) {
      ctx.save();
      ctx.globalAlpha = 0.5;
      // View.png points down, so flip it to face the top of the map.
      ctx.translate(half, half);
      ctx.rotate(Math.PI);
      ctx.drawImage(this.imgView, -30, -6, 60, 60);
      ctx.restore();
    }
    if (this.imgPlayer.complete && this.imgPlayer.naturalWidth > 0) {
      ctx.drawImage(this.imgPlayer, half - 7, half - 7, 14, 14);
    } else {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(half, half - 6);
      ctx.lineTo(half + 4.5, half + 5);
      ctx.lineTo(half, half + 2.5);
      ctx.lineTo(half - 4.5, half + 5);
      ctx.closePath();
      ctx.fill();
    }
  }

  /**
   * Recolours a white marker glyph, caching the result.
   *
   * The tint has to happen on its own canvas: compositing it straight onto the
   * map would catch the backdrop underneath the glyph as well.
   */
  private tinted(img: HTMLImageElement, tint: string): HTMLCanvasElement | null {
    if (!img.complete || img.naturalWidth === 0) return null;
    const key = `${img.src}|${tint}`;
    const hit = this.tintCache.get(key);
    if (hit) return hit;

    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = tint;
    g.fillRect(0, 0, c.width, c.height);
    this.tintCache.set(key, c);
    return c;
  }

  /**
   * Draws a map icon at a rotated-space position, undoing the map rotation so
   * the glyph stays upright.
   */
  private drawMarker(
    img: HTMLImageElement,
    x: number, y: number, size: number,
    yaw: number, tint: string,
  ): void {
    const ctx = this.ctx;
    const glyph = this.tinted(img, tint);
    if (!glyph) {
      ctx.fillStyle = tint;
      ctx.fillRect(x - size / 4, y - size / 4, size / 2, size / 2);
      return;
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-yaw);
    ctx.drawImage(glyph, -size / 2, -size / 2, size, size);
    ctx.restore();
  }
}
