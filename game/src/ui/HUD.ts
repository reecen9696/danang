import { MATERIALS, VITALS } from '../core/constants';
import { paletteHex } from '../voxel/palette';
import { BUILDABLE, MATERIAL_COLOR, Slot } from '../player/Loadout';
import { DEPLOYABLES } from '../game/Deployables';
import type { Loadout } from '../player/Loadout';
import { WeaponId } from '../weapons/definitions';
import { iconSvg, type IconId } from './icons';
import { money } from './format';

export type LogTone = 'info' | 'good' | 'bad' | 'warn';

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Missing HUD element #${id}`);
  return e as T;
}


/** Two digits, the way the reference HUD counts grenades: `01`, not `1`. */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * DOM-based heads-up display.
 *
 * Every value is cached and only written back when it actually changes — a HUD
 * that touches the DOM 60 times a second is a surprisingly effective way to
 * lose frames.
 */
export class HUD {
  private readonly points = el('points');
  private readonly weaponIcon = el('weapon-icon');
  private readonly heldName = el('held-name');
  private readonly ammo = el('ammo');
  private readonly ammoClip = el('ammo-clip');
  private readonly ammoReserve = el('ammo-reserve');
  private readonly gren = el('gren');
  private readonly grenCount = el('gren-count');
  private readonly reloadHint = el('reload-hint');
  private readonly announce = el('announce');
  private readonly crosshair = el('crosshair');
  private readonly hitmarker = el('hitmarker');
  private readonly popups = el('popups');
  private readonly damageFlash = el('damage-flash');
  /** The whole vitals readout: blood closing in as the pool empties. */
  private readonly hurtVignette = el('low-hp');
  private readonly prompt = el('prompt');
  private readonly blocksBox = el('blocks-box');
  private readonly matList = el('mat-list');
  private readonly perf = el('perf');
  private readonly hud = el('hud');

  private readonly crossParts: HTMLElement[];

  // cached values
  private cHurt = -1;
  private cRecovering = false;
  private cPoints = -1;
  private cClip = '';
  private cReserve = '';
  private cGren = -1;
  private cIcon = '';
  private cHeldName = '';
  private cPrompt = '';
  private cSpread = -1;
  private cReload = '';

  private damageTimer = 0;
  private popupSeed = 0;

  constructor() {
    this.crossParts = Array.from(this.crosshair.querySelectorAll('.q')) as HTMLElement[];
    this.buildMaterialList();
    // The grenade pin never changes; the count beside it does.
    el('gren-icon').innerHTML = iconSvg(WeaponId.Grenade);
  }

  setVisible(on: boolean): void {
    this.hud.style.display = on ? '' : 'none';
  }

  // -------------------------------------------------------------------------
  private buildMaterialList(): void {
    this.matList.innerHTML = '';
    for (const m of BUILDABLE) {
      const div = document.createElement('div');
      div.className = 'mat';
      div.dataset.mat = String(m);
      const swatch = document.createElement('i');
      swatch.style.background = paletteHex(MATERIAL_COLOR[m]);
      div.appendChild(swatch);
      const label = document.createElement('span');
      label.textContent = MATERIALS[m].name;
      div.appendChild(label);
      const count = document.createElement('b');
      count.style.marginLeft = '6px';
      count.dataset.count = '1';
      div.appendChild(count);
      this.matList.appendChild(div);
    }
  }

  updateLoadout(loadout: Loadout): void {
    const showBlocks = loadout.slot === Slot.Block;
    this.blocksBox.classList.toggle('show', showBlocks);
    if (showBlocks) {
      for (const child of Array.from(this.matList.children) as HTMLElement[]) {
        const m = Number(child.dataset.mat);
        const n = loadout.blocks[m];
        child.classList.toggle('active', m === loadout.material);
        child.classList.toggle('empty', n <= 0);
        const b = child.querySelector('b')!;
        if (b.textContent !== String(n)) b.textContent = String(n);
      }
    }

    const w = loadout.activeWeapon;

    // The silhouette says what is in your hands. The build slot borrows the
    // block tool's weapon state, so it has to name its own icon — and it names
    // the *structure*, not a generic build glyph, so what the readout shows is
    // the same shape you just pointed at on the wheel.
    const icon: IconId = loadout.slot === Slot.Build ? loadout.deploySelected : w.def.id;
    if (icon !== this.cIcon) {
      this.cIcon = icon;
      this.weaponIcon.innerHTML = iconSvg(icon);
    }

    // A gun is recognisable from its outline; a crate, a barricade and a stack
    // of stone are not, so only those spell themselves out.
    const held = loadout.slot === Slot.Build ? DEPLOYABLES[loadout.deploySelected].name
      : loadout.slot === Slot.Block ? MATERIALS[loadout.material].name
      : '';
    if (held !== this.cHeldName) {
      this.cHeldName = held;
      this.heldName.textContent = held;
    }

    // Clip over reserve, the reference layout. Anything that isn't a magazine
    // -- blocks, grenades, deployables -- is a single stock figure.
    let clip: string;
    let reserve = '';
    let dry: boolean;
    if (loadout.slot === Slot.Build) {
      const stock = loadout.deployStock(loadout.deploySelected);
      clip = pad2(stock);
      dry = stock === 0;
    } else if (loadout.slot === Slot.Grenade) {
      clip = pad2(loadout.grenades.stock);
      dry = loadout.grenades.stock === 0;
    } else if (loadout.slot === Slot.Block) {
      clip = String(loadout.blockCount);
      dry = loadout.blockCount === 0;
    } else if (w.needsAmmo) {
      clip = String(w.ammo);
      reserve = String(w.stock);
      dry = w.ammo === 0;
    } else {
      clip = '\u221e';
      dry = false;
    }
    if (clip !== this.cClip) { this.cClip = clip; this.ammoClip.textContent = clip; }
    if (reserve !== this.cReserve) { this.cReserve = reserve; this.ammoReserve.textContent = reserve; }
    this.ammo.classList.toggle('empty', dry);

    // Grenades are shown whatever you are holding: they are the thing you reach
    // for when the answer to the room isn't the gun in your hands.
    const nades = loadout.grenades.stock;
    if (nades !== this.cGren) {
      this.cGren = nades;
      this.grenCount.textContent = pad2(nades);
      this.gren.classList.toggle('empty', nades === 0);
    }

    // Being dry is a shopping instruction, not just a status: say where the
    // ammo comes from, because a crate is a few steps and the market is a run.
    const hint = w.reloading ? 'RELOADING…'
      : (w.needsAmmo && w.ammo === 0 && w.stock > 0 ? 'PRESS R TO RELOAD'
        : (w.needsAmmo && w.totalAmmo === 0 ? 'OUT OF AMMO — RESUPPLY AT A CRATE OR THE WEAPON MERCHANT' : ''));
    if (hint !== this.cReload) {
      this.cReload = hint;
      this.reloadHint.textContent = hint;
    }
  }

  /**
   * The only vitals readout there is.
   *
   * `hurt` runs 0 (untouched) to 1 (one more burst and you are down) and drives
   * how far the blood reaches in from the edges; past the critical mark it
   * starts pulsing. `recovering` is on while the pool is ticking back up, and
   * only tints the vignette -- the fact that it is *shrinking* is the real cue.
   * Quantised to twentieths so a regen tick isn't a style write every frame.
   */
  setVitals(hurt: number, recovering: boolean): void {
    const q = Math.round(Math.max(0, Math.min(1, hurt)) * 20) / 20;
    if (q !== this.cHurt) {
      this.cHurt = q;
      this.hurtVignette.style.setProperty('--hurt', String(q));
      this.hurtVignette.style.opacity = q > 0.03 ? String(0.25 + q * 0.75) : '0';
      this.hurtVignette.classList.toggle('critical', q >= 1 - VITALS.criticalAt);
    }
    if (recovering !== this.cRecovering) {
      this.cRecovering = recovering;
      this.hurtVignette.classList.toggle('recovering', recovering);
    }
  }

  /** What you have to spend, in the currency the merchants price in. */
  updatePoints(points: number): void {
    const p = Math.round(points);
    if (p === this.cPoints) return;
    this.cPoints = p;
    this.points.textContent = money(p);
  }

  /**
   * Opens the crosshair to match the weapon's current cone by pushing each
   * bracket diagonally away from the centre.
   */
  updateCrosshair(spreadPixels: number): void {
    const s = Math.round(spreadPixels);
    if (s === this.cSpread) return;
    this.cSpread = s;
    const g = s * 0.7;
    this.crossParts[0].style.transform = `translate(${-g}px, ${-g}px)`;
    this.crossParts[1].style.transform = `translate(${g}px, ${-g}px)`;
    this.crossParts[2].style.transform = `translate(${-g}px, ${g}px)`;
    this.crossParts[3].style.transform = `translate(${g}px, ${g}px)`;
  }

  setPrompt(text: string): void {
    if (text === this.cPrompt) return;
    this.cPrompt = text;
    this.prompt.innerHTML = text;
    this.prompt.classList.toggle('show', text.length > 0);
  }

  /**
   * How close the jungle is to noticing you.
   *
   * The meter is deliberately not drawn: the detection system still runs and
   * still drives the AI, but the player reads it off the world -- calls,
   * postures, muzzle flashes -- rather than off a bar. Kept as a no-op sink so
   * the sim can keep reporting without the HUD caring.
   */
  setDetection(_level: number, _spotted: boolean): void {}

  /** The on-screen event log was removed; kept as a no-op so callers still work. */
  log(_text: string, _tone: LogTone = 'info'): void {}

  showAnnounce(text: string, tone: LogTone = 'info'): void {
    this.announce.textContent = text;
    this.announce.style.color = tone === 'bad' ? 'var(--bad)'
      : tone === 'good' ? 'var(--good)'
      : tone === 'warn' ? 'var(--warn)' : 'var(--hud-text)';
    this.announce.classList.remove('show');
    // Force a reflow so the animation restarts.
    void this.announce.offsetWidth;
    this.announce.classList.add('show');
  }

  showHitmarker(kill: boolean): void {
    this.hitmarker.classList.toggle('kill', kill);
    this.hitmarker.classList.remove('show');
    void this.hitmarker.offsetWidth;
    this.hitmarker.classList.add('show');
  }

  showPoints(amount: number, label?: string): void {
    const div = document.createElement('div');
    div.className = 'popup';
    div.textContent = label ? `+${amount} ${label}` : `+${amount}`;
    // Scatter them a little so rapid kills don't stack into one blob.
    this.popupSeed = (this.popupSeed + 1) % 5;
    div.style.left = `${(this.popupSeed - 2) * 42}px`;
    div.style.top = `${this.popupSeed * 6}px`;
    this.popups.appendChild(div);
    window.setTimeout(() => div.remove(), 1200);
  }

  /**
   * The splatter that punches in on a hit, on top of the standing vignette.
   * `severity` is the fraction of the pool that hit just cost, so a rifle round
   * reads heavier than a stray pellet instead of every hit looking the same.
   */
  flashDamage(severity = 0.25): void {
    const s = Math.max(0, Math.min(1, severity));
    this.damageFlash.style.opacity = String(0.45 + s * 0.55);
    this.damageTimer = 0.3 + s * 0.25;
  }

  /** Red wedge pointing at whatever just shot you. */
  showDamageDirection(angleRad: number): void {
    const div = document.createElement('div');
    div.className = 'dmg-dir';
    div.style.transform = `rotate(${angleRad}rad)`;
    this.hud.appendChild(div);
    window.setTimeout(() => div.remove(), 1150);
  }

  updateCompass(yaw: number): void {
    // North is -Z (yaw 0); bearings run clockwise, and yaw grows anticlockwise.
    const deg = ((-yaw * 180) / Math.PI + 360) % 360;
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const i = Math.round(deg / 45) % 8;
    const c = document.getElementById('compass')!;
    if (c.textContent !== dirs[i]) c.textContent = dirs[i];
  }

  setPerf(text: string): void {
    this.perf.textContent = text;
  }

  togglePerf(): boolean {
    this.perf.classList.toggle('show');
    return this.perf.classList.contains('show');
  }

  update(dt: number): void {
    if (this.damageTimer > 0) {
      this.damageTimer -= dt;
      if (this.damageTimer <= 0) this.damageFlash.style.opacity = '0';
    }
  }
}
