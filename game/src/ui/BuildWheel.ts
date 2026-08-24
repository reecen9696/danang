import { DEPLOYABLES, DEPLOY_ORDER, DeployId } from '../game/Deployables';
import type { Loadout } from '../player/Loadout';
import { iconSvg } from './icons';

/**
 * Hold-to-open picker for the build slot.
 *
 * The old build slot cycled: tap 5 again and again until the thing you wanted
 * came round. That is fine with two entries and miserable with four, and it is
 * especially miserable under fire, because cycling makes you look at the HUD
 * to find out what you are now holding.
 *
 * A wheel replaces "press until right" with "point at it". You hold the build
 * key, the four structures fan out around the crosshair, you flick the mouse
 * at one and let go. The choice is made by direction rather than by count, so
 * it is muscle memory after about three uses and it never needs reading.
 *
 * Two details do most of the work:
 *
 * - The pointer is locked, so there is no cursor to put on a menu. Instead the
 *   raw mouse delta drives a virtual stick from the centre and the sector is
 *   picked by its *angle*. Distance past a small deadzone only decides whether
 *   anything is selected at all, which means a hard flick in roughly the right
 *   direction is as good as a careful one.
 * - Tapping the key doesn't open it. Below the hold threshold the key just
 *   equips the slot, so the fast path for "put the thing I already have in my
 *   hands" stays a single tap.
 */

/** How far the virtual stick must travel before a sector is picked, in px. */
const DEADZONE = 34;
/** Ceiling on the stick, so a long flick doesn't fling the dot off-screen. */
const MAX_REACH = 96;
/** Mouse delta to stick travel. Deliberately brisk: this is a flick, not aim. */
const STICK_GAIN = 0.85;

export class BuildWheel {
  private readonly root: HTMLDivElement;
  private readonly ring: HTMLDivElement;
  private readonly dot: HTMLDivElement;
  private readonly caption: HTMLDivElement;
  private readonly cells: HTMLDivElement[] = [];

  /** Which structures the wheel is currently showing, in ring order. */
  private ids: DeployId[] = [];

  private stickX = 0;
  private stickY = 0;

  open = false;
  /** The sector under the stick, or null while inside the deadzone. */
  highlighted: DeployId | null = null;

  constructor() {
    this.root = document.createElement('div');
    this.root.id = 'build-wheel';
    this.root.className = 'hidden';

    this.ring = document.createElement('div');
    this.ring.className = 'bw-ring';

    this.dot = document.createElement('div');
    this.dot.className = 'bw-dot';

    this.caption = document.createElement('div');
    this.caption.className = 'bw-caption';

    this.ring.appendChild(this.dot);
    this.root.appendChild(this.ring);
    this.root.appendChild(this.caption);
    document.body.appendChild(this.root);
  }

  /**
   * Opens the wheel around the crosshair.
   *
   * Everything is shown, including what the player has none of, and the empty
   * ones are drawn greyed with a zero. A picker that hides what you can't
   * afford teaches you nothing about what exists; one that shows it greyed is
   * also the shopping list.
   */
  show(loadout: Loadout): void {
    this.ids = [...DEPLOY_ORDER];
    this.buildCells(loadout);
    this.stickX = 0;
    this.stickY = 0;
    this.open = true;
    // Whatever is already equipped starts under the stick, so releasing
    // immediately is a no-op rather than a surprise.
    this.highlighted = this.ids.includes(loadout.deploySelected) ? loadout.deploySelected : null;
    this.applyHighlight();
    this.root.classList.remove('hidden');
  }

  hide(): void {
    this.open = false;
    this.root.classList.add('hidden');
  }

  /** Feeds one frame of raw mouse movement into the virtual stick. */
  move(dx: number, dy: number): void {
    if (!this.open) return;
    this.stickX += dx * STICK_GAIN;
    this.stickY += dy * STICK_GAIN;

    const len = Math.hypot(this.stickX, this.stickY);
    if (len > MAX_REACH) {
      this.stickX = (this.stickX / len) * MAX_REACH;
      this.stickY = (this.stickY / len) * MAX_REACH;
    }

    this.dot.style.transform = `translate(${this.stickX.toFixed(1)}px, ${this.stickY.toFixed(1)}px)`;

    const next = len < DEADZONE ? null : this.sectorAt(this.stickX, this.stickY);
    if (next === this.highlighted) return;
    this.highlighted = next;
    this.applyHighlight();
  }

  /**
   * Which sector a direction falls in.
   *
   * Screen Y grows downward, so the angle is measured from straight up and the
   * sectors are laid out clockwise from there — the same order they are drawn
   * in, which is the only way "the one at the top" means the same thing to the
   * code and to the player.
   */
  private sectorAt(x: number, y: number): DeployId {
    const n = this.ids.length;
    let a = Math.atan2(x, -y) / (Math.PI * 2);
    if (a < 0) a += 1;
    // Offset by half a sector so each icon sits in the middle of its wedge
    // rather than on the boundary between two.
    const i = Math.floor(a * n + 0.5) % n;
    return this.ids[i];
  }

  private buildCells(loadout: Loadout): void {
    // Rebuilt on every open: stock changes between openings, and four nodes is
    // not worth the bookkeeping of a diff.
    for (const cell of this.cells) cell.remove();
    this.cells.length = 0;

    const n = this.ids.length;
    for (let i = 0; i < n; i++) {
      const id = this.ids[i];
      const def = DEPLOYABLES[id];
      const stock = loadout.deployStock(id);

      const cell = document.createElement('div');
      cell.className = stock > 0 ? 'bw-cell' : 'bw-cell empty';
      // Clockwise from the top, matching sectorAt.
      const a = (i / n) * Math.PI * 2;
      const r = 108;
      cell.style.left = `${Math.sin(a) * r}px`;
      cell.style.top = `${-Math.cos(a) * r}px`;
      cell.innerHTML =
        `<div class="bw-icon">${iconSvg(id)}</div>`
        + `<div class="bw-name">${def.name}</div>`
        + `<div class="bw-stock">${stock}</div>`;
      this.ring.appendChild(cell);
      this.cells.push(cell);
    }
  }

  private applyHighlight(): void {
    for (let i = 0; i < this.cells.length; i++) {
      this.cells[i].classList.toggle('on', this.ids[i] === this.highlighted);
    }
    this.caption.textContent = this.highlighted === null
      ? 'RELEASE TO KEEP CURRENT'
      : DEPLOYABLES[this.highlighted].name.toUpperCase();
  }
}
