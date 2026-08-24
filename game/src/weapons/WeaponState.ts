import { WEAPONS, WeaponId, type WeaponDef } from './definitions';

/** Live ammo / reload / fire-timing state for one owned weapon. */
export class WeaponState {
  readonly def: WeaponDef;
  ammo: number;
  stock: number;

  /**
   * Reserve capacity multiplier. The Bandolier raises it, so `def.maxStock` is
   * the base number of rounds a weapon carries rather than the hard ceiling.
   */
  capacityScale = 1;

  cooldown = 0;
  reloading = false;
  reloadTimer = 0;
  /** Rises while firing, decays when you stop — drives spread growth. */
  heat = 0;

  constructor(id: WeaponId) {
    this.def = WEAPONS[id];
    this.ammo = this.def.clipSize;
    this.stock = this.def.maxStock;
  }

  get id(): WeaponId {
    return this.def.id;
  }

  /** How much reserve ammo this weapon can hold right now. */
  get capacity(): number {
    return Math.round(this.def.maxStock * this.capacityScale);
  }

  get needsAmmo(): boolean {
    return this.def.clipSize > 0;
  }

  get isEmpty(): boolean {
    return this.needsAmmo && this.ammo <= 0;
  }

  get totalAmmo(): number {
    return this.ammo + this.stock;
  }

  canFire(): boolean {
    if (this.cooldown > 0) return false;
    if (this.reloading && !this.def.reloadSlow) return false;
    if (this.needsAmmo && this.ammo <= 0) return false;
    return true;
  }

  /** Consumes a round. Returns false if the shot couldn't happen. */
  consume(): boolean {
    if (!this.canFire()) return false;
    // Firing cancels a shell-by-shell reload, exactly like a pump shotgun.
    if (this.reloading && this.def.reloadSlow) {
      this.reloading = false;
      this.reloadTimer = 0;
    }
    if (this.needsAmmo) this.ammo--;
    this.cooldown = this.def.delay;
    this.heat = Math.min(1, this.heat + 0.34);
    return true;
  }

  beginReload(): boolean {
    if (!this.needsAmmo) return false;
    if (this.reloading) return false;
    if (this.stock <= 0) return false;
    if (this.ammo >= this.def.clipSize) return false;
    this.reloading = true;
    this.reloadTimer = this.def.reloadTime;
    return true;
  }

  cancelReload(): void {
    this.reloading = false;
    this.reloadTimer = 0;
  }

  refill(): void {
    this.stock = this.capacity;
    this.ammo = this.def.clipSize;
  }

  addStock(rounds: number): void {
    this.stock = Math.min(this.capacity, this.stock + rounds);
  }

  /** Adds a fraction of a full reserve — what an ammo box or a crate gives. */
  addFraction(fraction: number): void {
    this.addStock(Math.ceil(this.capacity * fraction));
  }

  /** Returns true on the frame a reload completes (per shell for shotguns). */
  update(dt: number): boolean {
    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - dt);
    this.heat = Math.max(0, this.heat - dt * 1.6);

    if (!this.reloading) return false;
    this.reloadTimer -= dt;
    if (this.reloadTimer > 0) return false;

    if (this.def.reloadSlow) {
      // One shell at a time; keep going until full or out of stock.
      this.ammo++;
      this.stock--;
      if (this.ammo >= this.def.clipSize || this.stock <= 0) {
        this.reloading = false;
      } else {
        this.reloadTimer = this.def.reloadTime;
      }
    } else {
      const needed = this.def.clipSize - this.ammo;
      const taken = Math.min(needed, this.stock);
      this.ammo += taken;
      this.stock -= taken;
      this.reloading = false;
    }
    return true;
  }

  /** Cone half-angle for the next shot, widened by movement and heat. */
  currentSpread(moving: number, airborne: boolean, ads: boolean): number {
    let s = this.def.spread;
    s *= 1 + this.heat * 1.2;
    s *= 1 + moving * 2.2;
    if (airborne) s *= 2.4;
    if (ads) s *= 0.35;
    return s;
  }
}
