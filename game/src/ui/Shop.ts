import { Economy, ShopKind, itemsFor, type ShopItem } from '../game/Economy';

const TABS: { kind: ShopKind; label: string }[] = [
  { kind: ShopKind.Weapons, label: 'WEAPONS' },
  { kind: ShopKind.Materials, label: 'MATERIALS' },
  { kind: ShopKind.Utility, label: 'UTILITY' },
];

/**
 * Merchant overlay.
 *
 * The player physically walks to a stall and presses E; the panel is only ever
 * open during the prep phase, so nothing here runs while the game is hot.
 */
export class ShopUI {
  private readonly root = document.getElementById('shop') as HTMLElement;
  private readonly title = document.getElementById('shop-title') as HTMLElement;
  private readonly pointsEl = document.getElementById('shop-points') as HTMLElement;
  private readonly tabsEl = document.getElementById('shop-tabs') as HTMLElement;
  private readonly grid = document.getElementById('shop-grid') as HTMLElement;

  private active: ShopKind = ShopKind.Weapons;
  open = false;

  /** Returns true if the purchase was applied. */
  onBuy: ((item: ShopItem) => boolean) | null = null;
  onClose: (() => void) | null = null;
  /** Extra per-item gating (e.g. the scope needs the rifle). */
  isAvailable: ((item: ShopItem) => boolean) | null = null;
  ownedLabel: ((item: ShopItem) => string | null) | null = null;

  constructor(private readonly economy: Economy) {
    this.buildTabs();
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.close();
    });
  }

  private buildTabs(): void {
    this.tabsEl.innerHTML = '';
    for (const t of TABS) {
      const div = document.createElement('div');
      div.className = 'shop-tab';
      div.textContent = t.label;
      div.dataset.kind = t.kind;
      div.addEventListener('click', () => {
        this.active = t.kind;
        this.render();
      });
      this.tabsEl.appendChild(div);
    }
  }

  show(kind: ShopKind, merchantName: string): void {
    this.active = kind;
    this.title.textContent = merchantName;
    this.open = true;
    this.root.classList.add('show');
    this.render();
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.root.classList.remove('show');
    this.onClose?.();
  }

  render(): void {
    this.pointsEl.textContent = `${this.economy.points.toLocaleString()} pts`;

    for (const tab of Array.from(this.tabsEl.children) as HTMLElement[]) {
      tab.classList.toggle('active', tab.dataset.kind === this.active);
    }

    this.grid.innerHTML = '';
    for (const item of itemsFor(this.active)) {
      const price = this.economy.priceOf(item);
      const owned = this.ownedLabel?.(item) ?? null;
      const gated = this.isAvailable ? !this.isAvailable(item) : false;
      const soldOut = Boolean(item.once && this.economy.purchaseCount(item.id) > 0);
      const affordable = this.economy.points >= price;
      const disabled = gated || soldOut || !affordable;

      const card = document.createElement('div');
      card.className = `shop-item${disabled ? ' disabled' : ''}`;

      const row = document.createElement('div');
      row.className = 'row';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = item.name;
      const cost = document.createElement('span');
      cost.className = 'cost';
      cost.textContent = soldOut ? 'OWNED' : `${price.toLocaleString()}`;
      row.append(name, cost);

      const desc = document.createElement('div');
      desc.className = 'desc';
      desc.textContent = item.description;

      card.append(row, desc);

      if (owned) {
        const o = document.createElement('div');
        o.className = 'owned';
        o.textContent = owned;
        card.appendChild(o);
      }

      if (!disabled) {
        card.addEventListener('click', () => {
          if (this.onBuy?.(item)) this.render();
        });
      }
      this.grid.appendChild(card);
    }
  }
}
