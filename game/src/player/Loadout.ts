import { Mat, MATERIALS } from '../core/constants';
import { WeaponId } from '../weapons/definitions';
import { WeaponState } from '../weapons/WeaponState';
import { ClassId, DEFAULT_CLASS, classDef } from './classes';
import { buildPaletteIndex, BUILD_SHADES, COL_WOOD, COL_STONE, COL_CONCRETE, COL_STEEL, COL_DIRT } from '../voxel/palette';

export const enum Slot {
  Spade = 0,
  Block = 1,
  Gun = 2,
  Grenade = 3,
}

/** Default colour used when placing a given material. */
export const MATERIAL_COLOR: Record<number, number> = {
  [Mat.Dirt]: COL_DIRT,
  [Mat.Wood]: COL_WOOD,
  [Mat.Stone]: COL_STONE,
  [Mat.Reinforced]: COL_CONCRETE,
  [Mat.Steel]: COL_STEEL,
};

export const BUILDABLE: readonly Mat[] = [Mat.Dirt, Mat.Wood, Mat.Stone, Mat.Reinforced, Mat.Steel];

/**
 * Everything the player owns: weapons, ammo, block stocks, respawn tickets and
 * the upgrades bought from the Utility Merchant.
 */
/** Index of the sidearm and the class primary inside `guns`. */
const SIDEARM = 0;
const PRIMARY = 1;

export class Loadout {
  slot: Slot = Slot.Gun;

  /** The class you're playing; it decides which primary sits in `guns`. */
  classId: ClassId = DEFAULT_CLASS;

  /** `[sidearm, class primary]`; the player cycles between them with 3. */
  readonly guns: WeaponState[] = [];
  gunIndex = PRIMARY;

  /**
   * Every gun the player has ever held, kept alive across class switches.
   *
   * Without this, changing class would hand back a factory-fresh weapon --
   * a free reload and a full reserve any time you tapped the picker.
   */
  private readonly owned = new Map<WeaponId, WeaponState>();

  readonly grenades = new WeaponState(WeaponId.Grenade);
  readonly spade = new WeaponState(WeaponId.Spade);
  readonly blockTool = new WeaponState(WeaponId.Block);

  /** Block counts per material tier. */
  readonly blocks = new Int32Array(MATERIALS.length);
  material: Mat = Mat.Dirt;

  /** Currently selected palette colour for free-form building. */
  colorHue = 0;
  colorShade = BUILD_SHADES - 6;
  useMaterialColor = true;

  tickets = 3;

  // upgrades
  fastReload = false;
  speedBoost = false;
  scoped = false;

  constructor() {
    this.guns.push(this.stateFor(WeaponId.Pistol));
    this.setClass(DEFAULT_CLASS);
    this.blocks[Mat.Dirt] = 50;
    this.grenades.stock = 3;
    this.grenades.ammo = 1;
  }

  get gun(): WeaponState {
    return this.guns[this.gunIndex];
  }

  get activeWeapon(): WeaponState {
    switch (this.slot) {
      case Slot.Spade: return this.spade;
      case Slot.Block: return this.blockTool;
      case Slot.Grenade: return this.grenades;
      default: return this.gun;
    }
  }

  get blockCount(): number {
    return this.blocks[this.material];
  }

  get totalBlocks(): number {
    let n = 0;
    for (let i = 0; i < this.blocks.length; i++) n += this.blocks[i];
    return n;
  }

  /** Palette index used for the next placed block. */
  get placementColor(): number {
    if (this.useMaterialColor) return MATERIAL_COLOR[this.material] ?? COL_DIRT;
    return buildPaletteIndex(this.colorHue, this.colorShade);
  }

  hasWeapon(id: WeaponId): boolean {
    return this.guns.some((g) => g.id === id);
  }

  get sidearm(): WeaponState {
    return this.guns[SIDEARM];
  }

  get primary(): WeaponState {
    return this.guns[PRIMARY];
  }

  private stateFor(id: WeaponId): WeaponState {
    let w = this.owned.get(id);
    if (!w) {
      w = new WeaponState(id);
      this.owned.set(id, w);
    }
    return w;
  }

  /**
   * Swaps the class primary in place, keeping the sidearm.
   *
   * Returns false when nothing changed, so the caller can skip the swap
   * animation and the log line.
   */
  setClass(id: ClassId): boolean {
    if (this.classId === id && this.guns.length > PRIMARY) return false;
    this.classId = id;

    const next = this.stateFor(classDef(id).weapon);
    // A reload in progress belongs to the gun you're putting away.
    this.guns[PRIMARY]?.cancelReload();
    next.cancelReload();

    if (this.guns.length > PRIMARY) this.guns[PRIMARY] = next;
    else this.guns.push(next);

    this.gunIndex = PRIMARY;
    this.slot = Slot.Gun;
    return true;
  }

  cycleGun(dir: number): void {
    if (this.guns.length < 2) return;
    this.gunIndex = (this.gunIndex + dir + this.guns.length) % this.guns.length;
  }

  addBlocks(material: Mat, count: number): void {
    this.blocks[material] += count;
  }

  consumeBlock(): boolean {
    if (this.blocks[this.material] <= 0) return false;
    this.blocks[this.material]--;
    return true;
  }

  /** Picks the next material that the player actually has stock of. */
  cycleMaterial(dir: number): void {
    const i = BUILDABLE.indexOf(this.material);
    for (let k = 1; k <= BUILDABLE.length; k++) {
      const next = BUILDABLE[(i + dir * k + BUILDABLE.length * 2) % BUILDABLE.length];
      if (this.blocks[next] > 0 || k === BUILDABLE.length) {
        this.material = next;
        return;
      }
    }
  }

  refillAllAmmo(): void {
    // Everything ever held, not just what's in hand -- otherwise an ammo
    // refill would silently skip the classes you're not currently playing.
    for (const g of this.owned.values()) g.refill();
  }

  reloadModifier(): number {
    return this.fastReload ? 0.65 : 1;
  }

  /**
   * `onReloadStep` fires whenever a gun finishes a reload — once per shell for
   * shell-at-a-time weapons — so the caller can sound the action.
   */
  update(dt: number, onReloadStep?: (w: WeaponState) => void): void {
    const scale = 1 / this.reloadModifier();
    for (const g of this.guns) {
      if (g.update(dt * scale) && onReloadStep) onReloadStep(g);
    }
    this.grenades.update(dt);
    this.spade.update(dt);
    this.blockTool.update(dt);
  }
}
