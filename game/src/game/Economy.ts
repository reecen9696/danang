import { Mat } from '../core/constants';
import { WeaponId } from '../weapons/definitions';

/** Point awards (GDD section 6.1). */
export const POINTS = {
  hit: 10,
  headshotBonus: 25,
  meleeBonus: 30,
  waveClear: 100,
  noBaseDamageBonus: 250,
  noRepairBonus: 150,
} as const;

export const enum ShopKind {
  Weapons = 'weapons',
  Materials = 'materials',
  Utility = 'utility',
}

export const enum ItemEffect {
  RefillAmmo = 'refill-ammo',
  GiveGrenades = 'give-grenades',
  GiveBlocks = 'give-blocks',
  RepairAll = 'repair-all',
  MaxHealth = 'max-health',
  ExtraLife = 'extra-life',
  FastReload = 'fast-reload',
  Speed = 'speed',
  Scope = 'scope',
}

export interface ShopItem {
  readonly id: string;
  readonly shop: ShopKind;
  readonly name: string;
  readonly description: string;
  readonly cost: number;
  readonly effect: ItemEffect;
  /** Weapon granted, block material, quantity — depends on the effect. */
  readonly weapon?: WeaponId;
  readonly material?: Mat;
  readonly amount?: number;
  /** Can only be bought once per run. */
  readonly once?: boolean;
  /** Price grows by this factor each purchase. */
  readonly escalate?: number;
}

export const SHOP_ITEMS: readonly ShopItem[] = [
  // --- Weapon Merchant -----------------------------------------------------
  // The rifle, SMG and shotgun aren't sold: they're the three classes, and
  // TAB swaps between them for free. This stall covers what a class *can't*
  // give you -- consumables and the one weapon upgrade.
  {
    id: 'grenades', shop: ShopKind.Weapons, name: 'Grenades x3', cost: 500,
    description: '130 damage in the blast radius, and it dents walls.',
    effect: ItemEffect.GiveGrenades, amount: 3,
  },
  {
    id: 'ammo', shop: ShopKind.Weapons, name: 'Ammo Refill', cost: 150,
    description: 'Tops up reserve ammo for every weapon you own.',
    effect: ItemEffect.RefillAmmo,
  },
  {
    id: 'scope', shop: ShopKind.Weapons, name: 'Rifle Scope', cost: 1000,
    description: 'Tighter ADS zoom on the rifle. Requires the Rifleman class.',
    effect: ItemEffect.Scope, once: true,
  },

  // --- Materials Merchant --------------------------------------------------
  {
    id: 'dirt', shop: ShopKind.Materials, name: '50 Dirt Blocks', cost: 200,
    description: '30 HP each. Cheap patch material.',
    effect: ItemEffect.GiveBlocks, material: Mat.Dirt, amount: 50,
  },
  {
    id: 'wood', shop: ShopKind.Materials, name: '50 Wood Blocks', cost: 350,
    description: '60 HP each.',
    effect: ItemEffect.GiveBlocks, material: Mat.Wood, amount: 50,
  },
  {
    id: 'stone', shop: ShopKind.Materials, name: '50 Stone Blocks', cost: 600,
    description: '150 HP each. The standard wall upgrade.',
    effect: ItemEffect.GiveBlocks, material: Mat.Stone, amount: 50,
  },
  {
    id: 'reinforced', shop: ShopKind.Materials, name: '25 Reinforced Blocks', cost: 900,
    description: '400 HP each. Tanks rifle fire well.',
    effect: ItemEffect.GiveBlocks, material: Mat.Reinforced, amount: 25,
  },
  {
    id: 'steel', shop: ShopKind.Materials, name: '10 Steel Blocks', cost: 1200,
    description: '1000 HP each. Resists rockets for a while.',
    effect: ItemEffect.GiveBlocks, material: Mat.Steel, amount: 10,
  },
  {
    id: 'repair-all', shop: ShopKind.Materials, name: 'Repair All Damage', cost: 1500,
    description: 'Instantly restores every damaged block on the map to full HP.',
    effect: ItemEffect.RepairAll, escalate: 1.25,
  },

  // --- Utility Merchant ----------------------------------------------------
  {
    id: 'max-hp', shop: ShopKind.Utility, name: '+25 Max Health', cost: 1800,
    description: 'Permanently raises your maximum health for this run.',
    effect: ItemEffect.MaxHealth, amount: 25, escalate: 1.6,
  },
  {
    id: 'life', shop: ShopKind.Utility, name: 'Respawn Ticket', cost: 2500,
    description: 'One more chance when you go down.',
    effect: ItemEffect.ExtraLife, amount: 1, escalate: 1.4,
  },
  {
    id: 'fast-reload', shop: ShopKind.Utility, name: 'Fast Hands', cost: 1400,
    description: 'Reload 35% faster with every weapon.',
    effect: ItemEffect.FastReload, once: true,
  },
  {
    id: 'speed', shop: ShopKind.Utility, name: 'Light Boots', cost: 1200,
    description: 'Move 15% faster on foot.',
    effect: ItemEffect.Speed, once: true,
  },
];

export function itemsFor(shop: ShopKind): ShopItem[] {
  return SHOP_ITEMS.filter((i) => i.shop === shop);
}

/**
 * Tracks the run's points and everything bought so far.
 * Purchase counts drive escalating prices for the repeatable upgrades.
 */
export class Economy {
  points = 0;
  totalEarned = 0;
  private readonly purchases = new Map<string, number>();

  award(amount: number): void {
    this.points += amount;
    this.totalEarned += amount;
  }

  purchaseCount(id: string): number {
    return this.purchases.get(id) ?? 0;
  }

  priceOf(item: ShopItem): number {
    const n = this.purchaseCount(item.id);
    if (!item.escalate || n === 0) return item.cost;
    return Math.round(item.cost * Math.pow(item.escalate, n));
  }

  canAfford(item: ShopItem): boolean {
    if (item.once && this.purchaseCount(item.id) > 0) return false;
    return this.points >= this.priceOf(item);
  }

  /** Deducts the price and records the purchase. Returns false if too poor. */
  buy(item: ShopItem): boolean {
    if (!this.canAfford(item)) return false;
    this.points -= this.priceOf(item);
    this.purchases.set(item.id, this.purchaseCount(item.id) + 1);
    return true;
  }

  reset(): void {
    this.points = 0;
    this.totalEarned = 0;
    this.purchases.clear();
  }
}
