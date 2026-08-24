import { Economy, ShopKind, itemsFor, stocks, type ShopItem } from '../game/Economy';
import { itemIconSvg } from './itemIcons';
import { money } from './format';

/**
 * Merchant overlay.
 *
 * The player walks to a stall and presses E. There are no tabs: a merchant
 * sells what a merchant stocks, so the panel only ever shows `itemsFor` their
 * own trade -- browsing the armourer's sandbags from the weapon stall was the
 * shop pretending to be four shops.
 *
 * A card is a picture, a name, how many you get and what it costs. The long
 * description is still there on hover, where it costs nothing to look at.
 */
export class ShopUI {
  private readonly root = document.getElementById('shop') as HTMLElement;
  private readonly title = document.getElementById('shop-title') as HTMLElement;
  private readonly pointsEl = document.getElementById('shop-points') as HTMLElement;
  private readonly grid = document.getElementById('shop-grid') as HTMLElement;

  private active: ShopKind = ShopKind.Weapons;
  open = false;

  /** Returns true if the purchase was applied. */
  onBuy: ((item: ShopItem) => boolean) | null = null;
  onClose: (() => void) | null = null;
  /** Extra per-item gating (e.g. the scope needs the rifle). */
  isAvailable: ((item: ShopItem) => boolean) | null = null;

  constructor(private readonly economy: Economy) {
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.close();
    });
  }

  /** The trade of the stall currently open, for the buyer to check against. */
  get kind(): ShopKind { return this.active; }

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
    this.pointsEl.textContent = money(this.economy.points);

    this.grid.innerHTML = '';
    for (const item of itemsFor(this.active)) {
      // Belt and braces: `itemsFor` already filtered, but the card is the thing
      // that becomes a purchase, so it checks the stall itself.
      if (!stocks(this.active, item)) continue;

      const price = this.economy.priceOf(item);
      const gated = this.isAvailable ? !this.isAvailable(item) : false;
      const soldOut = Boolean(item.once && this.economy.purchaseCount(item.id) > 0);
      const affordable = this.economy.points >= price;
      const disabled = gated || soldOut || !affordable;

      const card = document.createElement('div');
      card.className = `shop-item${disabled ? ' disabled' : ''}`;
      card.title = item.description;

      const art = document.createElement('div');
      art.className = 'art';
      art.innerHTML = itemIconSvg(item.id);
      if (item.qty && item.qty > 1) {
        const qty = document.createElement('span');
        qty.className = 'qty';
        qty.textContent = `x${item.qty}`;
        art.appendChild(qty);
      }

      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = item.name;

      const cost = document.createElement('div');
      cost.className = 'cost';
      cost.textContent = soldOut ? 'OWNED' : money(price);

      card.append(art, name, cost);

      if (!disabled) {
        card.addEventListener('click', () => {
          if (this.onBuy?.(item)) this.render();
        });
      }
      this.grid.appendChild(card);
    }
  }
}
