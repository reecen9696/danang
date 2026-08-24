/**
 * Flat silhouettes for the bottom-right readout.
 *
 * The original HUD art has no weapon icons — the map markers in `gfx/Map` are
 * 16x16 triangles, not guns — so these are drawn here instead. They're plain
 * `currentColor` fills, which is what lets the ammo block tint them (white
 * while you have rounds, red when you're dry) without a second copy of each.
 */

import { WeaponId } from '../weapons/definitions';
import { DeployId } from '../game/Deployables';

/**
 * Everything the held-item slot can show: the guns, the generic build glyph,
 * and one silhouette per structure so the build wheel can be read by shape
 * rather than by its labels.
 */
export type IconId = WeaponId | 'deploy' | DeployId;

interface Icon {
  readonly viewBox: string;
  readonly body: string;
}

/* All guns share a 100x44 box so they line up at the same optical size. */
const ICONS: Partial<Record<IconId, Icon>> = {
  [WeaponId.Pistol]: {
    viewBox: '0 0 100 44',
    body:
      '<path d="M26 11h48v9H26z"/>'
      + '<path d="M28 20h20v6H28z"/>'
      + '<path d="M30 26h15l-6 16H24z"/>'
      + '<path d="M48 20h4v4h-4z"/>',
  },
  [WeaponId.SMG]: {
    viewBox: '0 0 100 44',
    body:
      '<path d="M6 16h13v9H6z"/>'
      + '<path d="M19 18h5v5h-5z"/>'
      + '<path d="M24 13h28v12H24z"/>'
      + '<path d="M28 8h4v5h-4z"/>'
      + '<path d="M52 15h14v8H52z"/>'
      + '<path d="M66 17h14v4H66z"/>'
      + '<path d="M28 25h9l-3 11h-9z"/>'
      + '<path d="M42 25h9l4 17h-9z"/>',
  },
  [WeaponId.Rifle]: {
    viewBox: '0 0 100 44',
    body:
      // Top rail sits clear of the receiver: butted against it the whole
      // upper reads as one slab at HUD size.
      '<path d="M28 9h34v3H28z"/>'
      + '<path d="M4 14h16v11H4z"/>'
      + '<path d="M20 17h6v6h-6z"/>'
      + '<path d="M26 14h40v10H26z"/>'
      + '<path d="M66 15h16v8H66z"/>'
      + '<path d="M82 17h12v3H82z"/>'
      + '<path d="M77 7h4v8h-4z"/>'
      + '<path d="M32 24h9l-4 12h-9z"/>'
      + '<path d="M46 24h11l3 14H49z"/>',
  },
  [WeaponId.Shotgun]: {
    viewBox: '0 0 100 44',
    body:
      '<path d="M2 15h18v12H2z"/>'
      + '<path d="M20 14h20v13H20z"/>'
      + '<path d="M40 16h54v5H40z"/>'
      + '<path d="M48 21h20v7H48z"/>'
      + '<path d="M24 27h8l-3 11h-8z"/>',
  },
  [WeaponId.MachineGun]: {
    viewBox: '0 0 100 44',
    body:
      '<path d="M2 16h16v11H2z"/>'
      + '<path d="M18 13h34v14H18z"/>'
      + '<path d="M22 7h13v6H22z"/>'
      + '<path d="M52 17h34v5H52z"/>'
      + '<path d="M86 15h8v9h-8z"/>'
      + '<path d="M24 27h9l-3 11h-9z"/>'
      + '<path d="M36 27h14v10H36z"/>'
      // Bipod: the M60's tell at a glance, more than the belt is.
      + '<path d="M74 22h4l-8 16h-4z"/>'
      + '<path d="M78 22h4l8 16h-4z"/>',
  },
  [WeaponId.Thumper]: {
    viewBox: '0 0 100 44',
    body:
      '<path d="M4 24 24 16v14H4z"/>'
      + '<path d="M24 16h20v14H24z"/>'
      + '<path d="M44 13h36v13H44z"/>'
      + '<path d="M46 7h4v6h-4z"/>'
      + '<path d="M28 30h9l-3 10h-9z"/>',
  },
  [WeaponId.Spade]: {
    viewBox: '0 0 100 44',
    body:
      '<path d="M4 15h7v14H4z"/>'
      + '<path d="M11 19h51v6H11z"/>'
      + '<path d="M62 13h6v18h-6z"/>'
      + '<path d="M68 6h6l16 6 5 10-5 10-16 6h-6z"/>',
  },
  [WeaponId.Block]: {
    viewBox: '0 0 100 44',
    body:
      // Three faces with a seam between them: butted together they merge into
      // one hexagon and stop reading as a cube.
      '<path d="M50 3 82 14 50 25 18 14z"/>'
      + '<path d="M18 16 49 27v15L18 31z"/>'
      + '<path d="M82 16 51 27v15l31-11z"/>',
  },
  deploy: {
    viewBox: '0 0 100 44',
    body:
      '<path d="M14 8h72v28H14z" fill="none" stroke="currentColor" stroke-width="5"/>'
      + '<path d="M22 8 46 36h-9L16 12z"/>'
      + '<path d="M78 8 54 36h9l21-24z"/>',
  },

  /*
   * Structures. Drawn square-ish rather than in the guns' 100x44 letterbox,
   * because the wheel stacks them over a name and a count and a wide glyph
   * leaves the column looking empty.
   */
  [DeployId.Barricade]: {
    viewBox: '0 0 64 44',
    // Two courses of bags, offset like real coursing so the wall reads as
    // stacked sacks and not as a brick texture.
    body:
      '<rect x="3" y="22" width="18" height="8" rx="3"/>'
      + '<rect x="23" y="22" width="18" height="8" rx="3"/>'
      + '<rect x="43" y="22" width="18" height="8" rx="3"/>'
      + '<rect x="13" y="32" width="18" height="8" rx="3"/>'
      + '<rect x="33" y="32" width="18" height="8" rx="3"/>',
  },
  [DeployId.FiringBarricade]: {
    viewBox: '0 0 64 44',
    // The same wall with the middle of the top course left out: the loophole
    // is the whole point of it, so the gap is the silhouette.
    body:
      '<rect x="3" y="22" width="18" height="8" rx="3"/>'
      + '<rect x="43" y="22" width="18" height="8" rx="3"/>'
      + '<rect x="13" y="32" width="18" height="8" rx="3"/>'
      + '<rect x="33" y="32" width="18" height="8" rx="3"/>'
      + '<path d="M24 22h16v3H24z" opacity="0.45"/>',
  },
  [DeployId.Turret]: {
    viewBox: '0 0 64 44',
    // Barrel over a tripod: the legs are what separate it from a gun icon.
    body:
      '<path d="M18 12h28v7H18z"/>'
      + '<path d="M46 14h14v3H46z"/>'
      + '<path d="M28 19h8v6h-8z"/>'
      + '<path d="M31 25 18 40h-6l16-15z"/>'
      + '<path d="M33 25 46 40h6L36 25z"/>'
      + '<path d="M30 25h4v15h-4z"/>',
  },
  [DeployId.AmmoCrate]: {
    viewBox: '0 0 64 44',
    // A banded box with a lid line, which is the one shape nobody mistakes.
    body:
      '<path d="M8 12h48v28H8z" fill="none" stroke="currentColor" stroke-width="5"/>'
      + '<path d="M8 19h48v4H8z"/>'
      + '<path d="M28 23h8v17h-8z"/>',
  },
  [WeaponId.Grenade]: {
    viewBox: '0 0 44 60',
    body:
      '<path d="M16 11h12v8H16z"/>'
      + '<rect x="7" y="17" width="30" height="36" rx="13"/>'
      + '<path d="M28 4h8v4h-5v11h-3z"/>'
      + '<circle cx="11" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="3"/>',
  },
};

/** Markup for one silhouette, ready to drop into `innerHTML`. */
export function iconSvg(id: IconId): string {
  const icon = ICONS[id] ?? ICONS[WeaponId.Pistol]!;
  return `<svg viewBox="${icon.viewBox}" preserveAspectRatio="xMidYMid meet"`
    + ` fill="currentColor" aria-hidden="true">${icon.body}</svg>`;
}
