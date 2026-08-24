import {
  COL_CONCRETE, COL_CONCRETE_DARK, COL_DIRT, COL_DIRT_DARK, COL_SANDBAG,
  COL_STEEL, COL_STEEL_DARK, COL_STONE, COL_STONE_DARK, COL_WOOD, COL_WOOD_DARK,
  paletteHex,
} from '../voxel/palette';

/**
 * Shop icons.
 *
 * The stalls sell voxels, so the icons are voxels: every one is a handful of
 * axis-aligned rects on a 24x24 grid, rendered with `crispEdges` so they stay
 * hard-pixelled at any card size. Nothing here loads -- an <img> per item would
 * be a network request and an asset pipeline for pictures of a sandbag.
 *
 * Block icons take their colours straight from the world palette, so the cube
 * on the card is literally the colour of the block you get.
 */

/** [fill, x, y, width, height] on a 24x24 grid. */
type Rect = [string, number, number, number, number];

function lighten(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = (shift: number): number =>
    Math.min(255, Math.round(((n >> shift) & 0xff) * f));
  return `#${((c(16) << 16) | (c(8) << 8) | c(0)).toString(16).padStart(6, '0')}`;
}

const C = {
  steel: '#7c858f',
  steelMid: '#585f68',
  steelDark: '#3a3f45',
  brass: '#c9a227',
  brassLight: '#e6c85a',
  brassDark: '#8f7018',
  copper: '#b0663a',
  olive: '#5f6a3a',
  oliveDark: '#3f4726',
  wood: '#7a5a34',
  woodDark: '#4e3b25',
  leather: '#6b4a2a',
  leatherDark: '#4a3018',
  glass: '#7fd0e8',
  accent: '#ffc63f',
  good: '#7fd96b',
  hole: '#1b1f24',
} as const;

const SAND = paletteHex(COL_SANDBAG);
const SAND_LIGHT = lighten(SAND, 1.18);
const SAND_DARK = lighten(SAND, 0.7);

/** One sandbag: body, lit top edge, shaded underside. */
function bag(x: number, y: number, w: number, h: number): Rect[] {
  return [
    [SAND, x, y, w, h],
    [SAND_LIGHT, x, y, w, 1],
    [SAND_DARK, x, y + h - 1, w, 1],
    [SAND_DARK, x + w - 1, y, 1, h],
  ];
}

/**
 * A block, drawn as a cube with a lit top face -- the same silhouette for every
 * material so the five of them read as one row, differing only in colour and in
 * the surface detail that says which one it is.
 */
function cube(midIdx: number, darkIdx: number, detail: Rect[] = []): Rect[] {
  const mid = paletteHex(midIdx);
  const dark = paletteHex(darkIdx);
  const light = lighten(mid, 1.3);
  return [
    [light, 6, 3, 12, 2],
    [light, 4, 5, 16, 4],
    [mid, 4, 9, 16, 12],
    [dark, 15, 9, 5, 12],
    [dark, 4, 20, 16, 1],
    ...detail,
  ];
}

const ICONS: Record<string, Rect[]> = {
  // --- Weapons -------------------------------------------------------------
  grenades: [
    [C.brass, 6, 2, 4, 1],
    [C.brass, 6, 3, 1, 3],
    [C.brass, 9, 3, 1, 3],
    [C.brass, 6, 6, 4, 1],
    [C.steelMid, 15, 5, 1, 6],
    [C.steelMid, 10, 4, 5, 5],
    [C.steel, 10, 4, 5, 1],
    [C.olive, 7, 9, 10, 12],
    [C.olive, 6, 11, 1, 8],
    [C.olive, 17, 11, 1, 8],
    [C.oliveDark, 6, 12, 12, 1],
    [C.oliveDark, 6, 15, 12, 1],
    [C.oliveDark, 6, 18, 12, 1],
    [C.oliveDark, 10, 9, 1, 12],
    [C.oliveDark, 13, 9, 1, 12],
  ],
  ammo: [
    [C.copper, 10, 2, 4, 2],
    [C.copper, 9, 4, 6, 3],
    [C.copper, 8, 7, 8, 2],
    [C.brass, 8, 9, 8, 10],
    [C.brassLight, 9, 9, 1, 10],
    [C.brassDark, 14, 9, 2, 10],
    [C.brassDark, 7, 19, 10, 2],
  ],
  'ammo-box': [
    [C.copper, 6, 3, 3, 2],
    [C.brass, 6, 5, 3, 6],
    [C.copper, 11, 2, 3, 2],
    [C.brass, 11, 4, 3, 7],
    [C.copper, 16, 3, 3, 2],
    [C.brass, 16, 5, 3, 6],
    [C.wood, 3, 10, 18, 11],
    [C.woodDark, 3, 10, 18, 2],
    [C.woodDark, 3, 14, 18, 1],
    [C.woodDark, 3, 19, 18, 2],
  ],
  bandolier: [
    [C.leatherDark, 2, 3, 5, 5],
    [C.leatherDark, 5, 6, 5, 5],
    [C.leatherDark, 8, 9, 5, 5],
    [C.leatherDark, 11, 12, 5, 5],
    [C.leatherDark, 14, 15, 5, 5],
    [C.leatherDark, 17, 18, 5, 4],
    [C.brass, 3, 4, 3, 3], [C.brassLight, 3, 4, 3, 1],
    [C.brass, 6, 7, 3, 3], [C.brassLight, 6, 7, 3, 1],
    [C.brass, 9, 10, 3, 3], [C.brassLight, 9, 10, 3, 1],
    [C.brass, 12, 13, 3, 3], [C.brassLight, 12, 13, 3, 1],
    [C.brass, 15, 16, 3, 3], [C.brassLight, 15, 16, 3, 1],
  ],
  scope: [
    [C.steelDark, 6, 9, 13, 6],
    [C.steel, 6, 10, 13, 1],
    [C.steelMid, 19, 8, 3, 8],
    [C.steelMid, 10, 5, 4, 4],
    [C.steel, 10, 5, 4, 1],
    [C.steelMid, 2, 7, 4, 10],
    [C.glass, 3, 9, 2, 6],
  ],

  // --- Materials -----------------------------------------------------------
  dirt: cube(COL_DIRT, COL_DIRT_DARK, [
    [paletteHex(COL_DIRT_DARK), 6, 12, 2, 2],
    [paletteHex(COL_DIRT_DARK), 11, 16, 2, 2],
    [paletteHex(COL_DIRT_DARK), 7, 18, 2, 1],
  ]),
  wood: cube(COL_WOOD, COL_WOOD_DARK, [
    [paletteHex(COL_WOOD_DARK), 4, 12, 11, 1],
    [paletteHex(COL_WOOD_DARK), 4, 16, 11, 1],
    [paletteHex(COL_WOOD_DARK), 9, 9, 1, 12],
  ]),
  stone: cube(COL_STONE, COL_STONE_DARK, [
    [paletteHex(COL_STONE_DARK), 6, 13, 4, 1],
    [paletteHex(COL_STONE_DARK), 9, 14, 3, 1],
    [paletteHex(COL_STONE_DARK), 11, 15, 3, 1],
  ]),
  reinforced: cube(COL_CONCRETE, COL_CONCRETE_DARK, [
    [lighten(paletteHex(COL_CONCRETE), 1.35), 6, 11, 2, 2],
    [lighten(paletteHex(COL_CONCRETE), 1.35), 11, 11, 2, 2],
    [lighten(paletteHex(COL_CONCRETE), 1.35), 6, 17, 2, 2],
    [lighten(paletteHex(COL_CONCRETE), 1.35), 11, 17, 2, 2],
  ]),
  steel: cube(COL_STEEL, COL_STEEL_DARK, [
    [lighten(paletteHex(COL_STEEL), 1.4), 4, 13, 11, 1],
    [paletteHex(COL_STEEL_DARK), 6, 10, 2, 2],
    [paletteHex(COL_STEEL_DARK), 11, 10, 2, 2],
    [paletteHex(COL_STEEL_DARK), 6, 18, 2, 2],
    [paletteHex(COL_STEEL_DARK), 11, 18, 2, 2],
  ]),
  'repair-all': [
    [C.steel, 5, 4, 13, 4],
    [C.steelMid, 5, 8, 13, 3],
    [C.steelDark, 5, 4, 2, 7],
    [C.wood, 10, 11, 3, 10],
    [C.woodDark, 10, 17, 3, 4],
    [C.good, 16, 14, 2, 6],
    [C.good, 14, 16, 6, 2],
  ],

  // --- Defense -------------------------------------------------------------
  barricade: [
    ...bag(1, 8, 3, 6), ...bag(4, 8, 7, 6), ...bag(12, 8, 7, 6), ...bag(20, 8, 3, 6),
    ...bag(1, 14, 7, 6), ...bag(8, 14, 7, 6), ...bag(15, 14, 7, 6),
    [C.oliveDark, 0, 20, 24, 2],
  ],
  'firing-barricade': [
    [C.hole, 8, 8, 8, 6],
    ...bag(1, 8, 7, 6), ...bag(16, 8, 7, 6),
    ...bag(1, 14, 7, 6), ...bag(8, 14, 7, 6), ...bag(15, 14, 7, 6),
    [C.oliveDark, 0, 20, 24, 2],
  ],
  turret: [
    [C.steelDark, 6, 16, 2, 6],
    [C.steelDark, 11, 16, 2, 6],
    [C.steelDark, 16, 16, 2, 6],
    [C.steelMid, 5, 14, 14, 2],
    [C.oliveDark, 2, 9, 3, 5],
    [C.olive, 5, 7, 13, 7],
    [C.oliveDark, 5, 12, 13, 2],
    [C.olive, 8, 4, 5, 3],
    [C.accent, 9, 5, 2, 1],
    [C.steelDark, 18, 9, 6, 2],
    [C.steelMid, 21, 8, 2, 4],
  ],
  'turret-ammo': [
    [C.steelMid, 7, 4, 10, 2],
    [C.steelMid, 5, 6, 14, 12],
    [C.steelMid, 7, 18, 10, 2],
    [C.steelDark, 16, 3, 5, 4],
    [C.brass, 17, 4, 3, 2],
    [C.steelDark, 9, 8, 6, 6],
    [C.brass, 10, 9, 4, 4],
  ],
  'ammo-crate': [
    [C.brass, 8, 4, 2, 2],
    [C.brass, 11, 3, 2, 3],
    [C.brass, 14, 4, 2, 2],
    [C.wood, 2, 6, 20, 15],
    [C.woodDark, 2, 6, 20, 2],
    [C.woodDark, 2, 19, 20, 2],
    [C.woodDark, 2, 6, 2, 15],
    [C.woodDark, 20, 6, 2, 15],
    [C.woodDark, 4, 10, 16, 1],
    [C.woodDark, 4, 17, 16, 1],
    [C.steelMid, 4, 12, 16, 3],
    [C.steel, 4, 12, 16, 1],
  ],

  // --- Utility -------------------------------------------------------------
  toughness: [
    [C.oliveDark, 3, 5, 6, 5],
    [C.oliveDark, 15, 5, 6, 5],
    [C.olive, 5, 6, 14, 15],
    [C.oliveDark, 10, 4, 4, 3],
    [C.oliveDark, 11, 7, 2, 14],
    [C.oliveDark, 5, 11, 14, 1],
    [C.oliveDark, 5, 16, 14, 1],
    [C.steelMid, 6, 13, 3, 2],
    [C.steelMid, 15, 13, 3, 2],
  ],
  'fast-reload': [
    [C.accent, 2, 7, 5, 2],
    [C.accent, 3, 11, 4, 2],
    [C.accent, 2, 15, 5, 2],
    [C.steel, 11, 3, 7, 2],
    [C.steelDark, 11, 5, 7, 5],
    [C.steelDark, 12, 10, 7, 5],
    [C.steelDark, 13, 15, 7, 5],
    [C.steelMid, 11, 5, 2, 5],
    [C.steelMid, 12, 10, 2, 5],
    [C.steelMid, 13, 15, 2, 5],
    [C.steel, 13, 20, 7, 1],
    [C.brass, 12, 5, 5, 2],
  ],
  speed: [
    [C.accent, 0, 6, 4, 2],
    [C.accent, 1, 10, 3, 2],
    [C.accent, 0, 14, 4, 2],
    [C.leather, 5, 3, 9, 2],
    [C.leather, 6, 5, 7, 9],
    [C.leather, 6, 13, 11, 5],
    [C.leather, 16, 15, 3, 3],
    [C.steelDark, 5, 18, 15, 3],
    [C.steel, 7, 6, 5, 1],
    [C.steel, 7, 9, 5, 1],
    [C.steel, 7, 12, 5, 1],
  ],
};

/** Anything without art of its own gets a plain crate. */
const FALLBACK: Rect[] = [
  [C.wood, 3, 6, 18, 15],
  [C.woodDark, 3, 6, 18, 2],
  [C.woodDark, 3, 19, 18, 2],
  [C.woodDark, 3, 6, 2, 15],
  [C.woodDark, 19, 6, 2, 15],
];

/** Inline SVG markup for a shop item, sized by the CSS around it. */
export function itemIconSvg(id: string): string {
  const rects = ICONS[id] ?? FALLBACK;
  const body = rects
    .map(([c, x, y, w, h]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${c}"/>`)
    .join('');
  return `<svg viewBox="0 0 24 24" shape-rendering="crispEdges" aria-hidden="true">${body}</svg>`;
}
