import { MATERIALS } from '../core/constants';
import { paletteHex } from '../voxel/palette';
import { BUILDABLE, MATERIAL_COLOR, Slot } from '../player/Loadout';
import type { Loadout } from '../player/Loadout';
import { classDef } from '../player/classes';
import { WeaponId } from '../weapons/definitions';
import { GFX } from './gfx';

export type LogTone = 'info' | 'good' | 'bad' | 'warn';

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Missing HUD element #${id}`);
  return e as T;
}

const MAX_LOG_LINES = 6;

/** Which round sprite each weapon feeds, and whether it stands up or lies flat. */
const AMMO_ICON: Partial<Record<WeaponId, { url: string; wide: boolean }>> = {
  [WeaponId.Pistol]: { url: GFX.ammo9mm, wide: false },
  [WeaponId.SMG]: { url: GFX.ammo9mm, wide: false },
  [WeaponId.Rifle]: { url: GFX.ammo762, wide: false },
  [WeaponId.Shotgun]: { url: GFX.ammo12gauge, wide: true },
};

/** Drawing one icon per round gets silly past a full SMG mag. */
const MAX_AMMO_ICONS = 30;

/**
 * DOM-based heads-up display.
 *
 * Every value is cached and only written back when it actually changes — a HUD
 * that touches the DOM 60 times a second is a surprisingly effective way to
 * lose frames.
 */
export class HUD {
  private readonly hpText = el('hp-text');
  private readonly hpFill = el('hp-fill');
  private readonly tickets = el('tickets');
  private readonly matLabel = el('mat-label');
  private readonly blockCount = el('block-count');
  private readonly points = el('points');
  private readonly weaponName = el('weapon-name');
  private readonly classChip = el('class-chip');
  private readonly ammo = el('ammo');
  private readonly reloadHint = el('reload-hint');
  private readonly waveLabel = el('wave-label');
  private readonly waveValue = el('wave-value');
  private readonly waveSub = el('wave-sub');
  private readonly logLines = el('log-lines');
  private readonly announce = el('announce');
  private readonly crosshair = el('crosshair');
  private readonly hitmarker = el('hitmarker');
  private readonly popups = el('popups');
  private readonly damageFlash = el('damage-flash');
  private readonly lowHp = el('low-hp');
  private readonly prompt = el('prompt');
  private readonly blocksBox = el('blocks-box');
  private readonly matList = el('mat-list');
  private readonly ammoIcons = el('ammo-icons');
  private readonly waveBarFill = el('wave-bar-fill');
  private readonly perf = el('perf');
  private readonly hud = el('hud');

  private readonly crossParts: HTMLElement[];

  // cached values
  private cHp = -1;
  private cTickets = -1;
  private cPoints = -1;
  private cAmmo = '';
  private cWeapon = '';
  private cClass = '';
  private cWave = '';
  private cWaveLabel = '';
  private cWaveSub = '';
  private cBlocks = -1;
  private cMat = -1;
  private cPrompt = '';
  private cSpread = -1;
  private cReload = '';
  private cAmmoIcons = '';
  private cWaveBar = -1;

  private damageTimer = 0;
  private popupSeed = 0;

  constructor() {
    this.crossParts = Array.from(this.crosshair.querySelectorAll('.q')) as HTMLElement[];
    this.buildMaterialList();
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

    if (loadout.material !== this.cMat) {
      this.cMat = loadout.material;
      this.matLabel.textContent = MATERIALS[loadout.material].name.toUpperCase();
    }
    const n = loadout.blockCount;
    if (n !== this.cBlocks) {
      this.cBlocks = n;
      this.blockCount.textContent = String(n);
    }

    const cls = classDef(loadout.classId).name;
    if (cls !== this.cClass) {
      this.cClass = cls;
      // The TAB hint lives in a child span, so only the label is rewritten.
      this.classChip.firstChild!.textContent = `${cls} `;
    }

    const w = loadout.activeWeapon;
    if (w.def.name !== this.cWeapon) {
      this.cWeapon = w.def.name;
      this.weaponName.textContent = w.def.name;
    }

    let ammoStr: string;
    if (loadout.slot === Slot.Grenade) {
      ammoStr = `${loadout.grenades.stock}`;
      this.ammo.innerHTML = `${loadout.grenades.stock}<span class="reserve"> grenades</span>`;
    } else if (w.needsAmmo) {
      ammoStr = `${w.ammo}/${w.stock}`;
      this.ammo.innerHTML = `${w.ammo}<span class="reserve"> / ${w.stock}</span>`;
    } else {
      ammoStr = '-';
      this.ammo.innerHTML = `<span class="reserve">&infin;</span>`;
    }
    if (ammoStr !== this.cAmmo) this.cAmmo = ammoStr;
    this.ammo.classList.toggle('empty', w.needsAmmo && w.ammo === 0);
    this.updateAmmoIcons(loadout);

    const hint = w.reloading ? 'RELOADING…' : (w.needsAmmo && w.ammo === 0 && w.stock > 0 ? 'PRESS R TO RELOAD' : (w.needsAmmo && w.totalAmmo === 0 ? 'OUT OF AMMO' : ''));
    if (hint !== this.cReload) {
      this.cReload = hint;
      this.reloadHint.textContent = hint;
    }
  }

  /**
   * Draws one round sprite per bullet in the clip, greying out the spent ones.
   * Only touches the DOM when the shape of the row actually changes.
   */
  private updateAmmoIcons(loadout: Loadout): void {
    const w = loadout.activeWeapon;
    const icon = loadout.slot === Slot.Grenade ? undefined : AMMO_ICON[w.def.id];
    const clip = icon && w.needsAmmo ? Math.min(w.def.clipSize, MAX_AMMO_ICONS) : 0;
    const key = clip > 0 ? `${w.def.id}:${clip}:${Math.min(w.ammo, clip)}` : '';
    if (key === this.cAmmoIcons) return;
    this.cAmmoIcons = key;

    if (clip === 0 || !icon) {
      this.ammoIcons.replaceChildren();
      return;
    }
    // Rebuild only when the weapon changed; otherwise just retoggle `spent`.
    if (this.ammoIcons.children.length !== clip) {
      const frag = document.createDocumentFragment();
      for (let i = 0; i < clip; i++) {
        const el = document.createElement('i');
        el.style.setProperty('-webkit-mask-image', `url("${icon.url}")`);
        el.style.maskImage = `url("${icon.url}")`;
        frag.appendChild(el);
      }
      this.ammoIcons.replaceChildren(frag);
    }
    this.ammoIcons.className = icon.wide ? 'wide' : 'tall';
    const live = Math.min(w.ammo, clip);
    for (let i = 0; i < clip; i++) {
      // Fill from the right so the row empties toward the counter.
      (this.ammoIcons.children[i] as HTMLElement).classList.toggle('spent', clip - i > live);
    }
  }

  updateVitals(hp: number, maxHp: number, tickets: number): void {
    const pct = Math.max(0, Math.min(100, (hp / maxHp) * 100));
    if (Math.round(hp) !== this.cHp) {
      this.cHp = Math.round(hp);
      this.hpText.textContent = `${Math.max(0, Math.ceil(hp))}`;
      this.hpFill.style.width = `${pct}%`;
      this.hpFill.className = pct > 60 ? 'high' : pct > 30 ? 'mid' : '';
    }
    if (tickets !== this.cTickets) {
      this.cTickets = tickets;
      this.tickets.textContent = String(tickets);
    }
    this.lowHp.style.opacity = pct < 30 ? '1' : '0';
  }

  updatePoints(points: number): void {
    const p = Math.round(points);
    if (p === this.cPoints) return;
    this.cPoints = p;
    this.points.textContent = p.toLocaleString();
  }

  /** `progress` is 0..1; pass a negative value to hide the bar entirely. */
  updateWave(label: string, value: string, sub: string, progress = -1): void {
    if (label !== this.cWaveLabel) { this.cWaveLabel = label; this.waveLabel.textContent = label; }
    if (value !== this.cWave) { this.cWave = value; this.waveValue.textContent = value; }
    if (sub !== this.cWaveSub) { this.cWaveSub = sub; this.waveSub.innerHTML = sub; }

    const pct = progress < 0 ? -1 : Math.round(Math.max(0, Math.min(1, progress)) * 100);
    if (pct !== this.cWaveBar) {
      this.cWaveBar = pct;
      const bar = this.waveBarFill.parentElement!;
      bar.style.visibility = pct < 0 ? 'hidden' : 'visible';
      if (pct >= 0) this.waveBarFill.style.width = `${pct}%`;
    }
    this.waveBarFill.classList.toggle('combat', label === 'IN COMBAT');
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

  log(text: string, tone: LogTone = 'info'): void {
    const div = document.createElement('div');
    div.className = `log-line ${tone === 'info' ? '' : tone}`;
    div.textContent = text;
    this.logLines.appendChild(div);
    while (this.logLines.children.length > MAX_LOG_LINES) {
      this.logLines.removeChild(this.logLines.firstChild!);
    }
    window.setTimeout(() => div.remove(), 9000);
  }

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

  flashDamage(): void {
    this.damageFlash.style.opacity = '1';
    this.damageTimer = 0.35;
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
