import { Mat, MATERIALS } from '../core/constants';
import { WeaponId } from '../weapons/definitions';
import { WeaponState } from '../weapons/WeaponState';
import { ClassId, DEFAULT_CLASS, classDef } from './classes';
import { DeployId, DEPLOY_ORDER } from '../game/Deployables';
import { buildPaletteIndex, BUILD_SHADES, COL_WOOD, COL_STONE, COL_CONCRETE, COL_STEEL, COL_DIRT } from '../voxel/palette';

/**
 * What is in the player's hands.
 *
 * The numbering is the hotkey order and the gun comes first, because in a game
 * whose whole loop is being shot at, the thing you reach for under pressure is
 * never the spade.
 */
export const enum Slot {
  Gun = 0,
  Spade = 1,
  Block = 2,
  Grenade = 3,
  /** Sandbags, sentries, crates — everything you put down whole. */
  Build = 4,
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

/** What the Bandolier multiplies every weapon's reserve capacity by. */
const BANDOLIER_SCALE = 1.5;

/**
 * Everything the player owns: weapons, ammo, block stocks and the upgrades
 * bought from the Utility Merchant. There are no respawn tickets -- going down
 * costs you the walk back from the base, nothing else.
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

  /** Barricades, turrets and ammo crates bought but not yet put down. */
  readonly deployables: Record<DeployId, number> = {
    [DeployId.Barricade]: 0,
    [DeployId.FiringBarricade]: 0,
    [DeployId.Turret]: 0,
    [DeployId.AmmoCrate]: 0,
  };
  deploySelected: DeployId = DeployId.Barricade;
  /**
   * Quarter turns added to the way the player is facing when placing.
   *
   * Relative rather than absolute so the ghost still swings round with you by
   * default; Q and E nudge it off that baseline and the offset sticks.
   */
  deployRotation = 0;

  // upgrades
  fastReload = false;
  speedBoost = false;
  scoped = false;
  bandolier = false;

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
      // The deploy slot has no weapon of its own; it borrows the block tool so
      // the view model has something to hold and the placement cooldown is
      // shared with building.
      case Slot.Build: return this.blockTool;
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
      // A class picked up after the Bandolier still gets the bigger reserve.
      if (this.bandolier) w.capacityScale = BANDOLIER_SCALE;
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

  /**
   * Takes a gun found in the field.
   *
   * It goes on the end of `guns` rather than into either of the two fixed
   * slots, so a pickup costs you nothing you were already carrying: the
   * sidearm stays at 0, the class primary stays at 1, and changing class after
   * the fact swaps only the primary out from under it.
   *
   * Picking up one you already have is not nothing -- it hands you the belt or
   * the bandolier that came with it -- so it refills instead of failing. The
   * return value says which of the two happened, because the log line and the
   * swap animation differ.
   */
  pickUpWeapon(id: WeaponId): boolean {
    const already = this.hasWeapon(id);
    const w = this.stateFor(id);
    w.refill();
    if (!already) this.guns.push(w);
    this.gunIndex = this.guns.indexOf(w);
    this.slot = Slot.Gun;
    return !already;
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

  /** Tops every weapon up by a fraction of its reserve. Ammo boxes and crates. */
  addAmmoFraction(fraction: number): void {
    for (const g of this.owned.values()) g.addFraction(fraction);
  }

  /** True when nothing in hand has a round left anywhere. */
  get dryOnAmmo(): boolean {
    for (const g of this.guns) if (g.totalAmmo > 0) return false;
    return true;
  }

  applyBandolier(): void {
    if (this.bandolier) return;
    this.bandolier = true;
    for (const g of this.owned.values()) {
      g.capacityScale = BANDOLIER_SCALE;
      g.refill();
    }
  }

  /** Drops everything not yet put down; a new run starts with nothing. */
  clearDeployables(): void {
    for (const id of DEPLOY_ORDER) this.deployables[id] = 0;
    this.deploySelected = DeployId.Barricade;
  }

  deployStock(id: DeployId): number {
    return this.deployables[id];
  }

  addDeployable(id: DeployId, count: number): void {
    this.deployables[id] += count;
  }

  consumeDeployable(id: DeployId): boolean {
    if (this.deployables[id] <= 0) return false;
    this.deployables[id]--;
    return true;
  }

  /** Q and E, while the deploy slot is up. */
  rotateDeployable(dir: number): void {
    this.deployRotation = (this.deployRotation + dir + 4) % 4;
  }

  /** Picks the next kind the player actually has stock of, like materials. */
  cycleDeployable(dir: number): void {
    const i = DEPLOY_ORDER.indexOf(this.deploySelected);
    const n = DEPLOY_ORDER.length;
    for (let k = 1; k <= n; k++) {
      const next = DEPLOY_ORDER[(i + dir * k + n * 2) % n];
      if (this.deployables[next] > 0 || k === n) {
        this.deploySelected = next;
        return;
      }
    }
  }

  get totalDeployables(): number {
    let n = 0;
    for (const id of DEPLOY_ORDER) n += this.deployables[id];
    return n;
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
