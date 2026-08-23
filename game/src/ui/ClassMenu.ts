import { CLASSES, ClassId, classStats } from '../player/classes';

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Missing element #${id}`);
  return e as T;
}

/**
 * Class picker overlay.
 *
 * Unlike the merchants this is reachable at any time, mid-wave included: it
 * releases the pointer while it's up, so opening it in a firefight costs you
 * the seconds you spend deciding. That's the trade, and it's why the panel is
 * deliberately small and readable at a glance.
 */
export class ClassMenu {
  private readonly root = el('class-menu');
  private readonly grid = el('class-grid');

  open = false;

  onPick: ((id: ClassId) => void) | null = null;
  onClose: (() => void) | null = null;

  constructor() {
    this.buildCards();
    // Clicking the backdrop dismisses, same as the shop.
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.close();
    });
  }

  private buildCards(): void {
    this.grid.innerHTML = '';
    for (const def of CLASSES) {
      const card = document.createElement('div');
      card.className = 'class-card';
      card.dataset.class = def.id;

      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = def.name;

      const tagline = document.createElement('div');
      tagline.className = 'tagline';
      tagline.textContent = def.tagline;

      const stats = document.createElement('div');
      stats.className = 'stats';
      for (const s of classStats(def)) {
        const cell = document.createElement('div');
        const label = document.createElement('span');
        label.textContent = s.label;
        const value = document.createElement('b');
        value.textContent = s.value;
        cell.append(label, value);
        stats.appendChild(cell);
      }

      const desc = document.createElement('div');
      desc.className = 'desc';
      desc.textContent = def.description;

      const badge = document.createElement('div');
      badge.className = 'badge';
      badge.textContent = 'EQUIPPED';

      card.append(name, tagline, stats, desc, badge);
      card.addEventListener('click', () => {
        this.onPick?.(def.id);
        this.close();
      });
      this.grid.appendChild(card);
    }
  }

  show(current: ClassId): void {
    this.open = true;
    this.root.classList.add('show');
    this.markCurrent(current);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.root.classList.remove('show');
    this.onClose?.();
  }

  toggle(current: ClassId): void {
    if (this.open) this.close();
    else this.show(current);
  }

  private markCurrent(current: ClassId): void {
    for (const card of Array.from(this.grid.children) as HTMLElement[]) {
      card.classList.toggle('active', card.dataset.class === current);
    }
  }
}
