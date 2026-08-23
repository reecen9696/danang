/**
 * Paths to the original Ace of Spades HUD art copied into `public/gfx`, plus
 * the effect textures under `public/tex`.
 *
 * These are served as static assets, so they're plain URLs rather than bundled
 * imports — nothing is fetched until something asks for it. See
 * `public/gfx/README.md` for provenance and licensing.
 */

const base = import.meta.env.BASE_URL;

function asset(path: string): string {
  return `${base}${path}`.replace(/([^:])\/\/+/g, '$1/');
}

/** Resolve a path under `public/gfx`, honouring the configured base URL. */
export const gfx = (path: string): string => asset(`gfx/${path}`);
/** Resolve a path under `public/tex`. */
export const tex = (path: string): string => asset(`tex/${path}`);

export const GFX = {
  // Crosshairs and hit feedback
  sight: gfx('Sight.png'),
  dotSight: gfx('DotSight.png'),
  hitFeedback: gfx('HitFeedback.png'),
  ball: gfx('Ball.png'),

  // Damage overlays
  hurtRing: gfx('HurtRing.png'),
  hurtRingSoft: gfx('HurtRing2.png'),
  hurtSprite: gfx('HurtSprite.png'),
  alertIcon: gfx('AlertIcon.png'),

  // Minimap
  mapBg: gfx('MapBg.png'),
  mapBorder: gfx('MapBorder.png'),
  minimapBorder: gfx('MinimapBorder.png'),
  mapPlayer: gfx('Map/Player.png'),
  mapView: gfx('Map/View.png'),
  mapCommandPost: gfx('Map/CommandPost.png'),
  mapIntel: gfx('Map/Intel.png'),

  // Ammo counter
  ammo9mm: gfx('Bullet/9mm.png'),
  ammo762: gfx('Bullet/7.62mm.png'),
  ammo12gauge: gfx('Bullet/12gauge.png'),

  // Panels and menu chrome
  menuItem: gfx('Limbo/MenuItem.png'),
  menuItemRing: gfx('Limbo/MenuItemRing.png'),
  bigMenuItem: gfx('Limbo/BigMenuItem.png'),
  banner: gfx('Banner.png'),
  button: gfx('UI/Button.png'),
  cursor: gfx('UI/Cursor.png'),
  close: gfx('UI/Close.png'),
  scrollArrow: gfx('UI/ScrollArrow.png'),

  // Progress bar (256x32)
  progressBar: gfx('TC/ProgressBar.png'),
  progressBg: gfx('TC/ProgressBg.png'),

  // Scoreboard
  scoreboardPlayersBg: gfx('Scoreboard/PlayersBg.png'),
  scoreboardScoresBg: gfx('Scoreboard/ScoresBg.png'),
  scoreboardTopShadow: gfx('Scoreboard/TopShadow.png'),

  // Utility fills
  white: gfx('White.png'),
  dashLine: gfx('DashLine.png'),
  dither: gfx('DitherPattern4x4.png'),
  circleGradient: gfx('CircleGradient.png'),
  palette: gfx('Palette.png'),
} as const;

export const TEX = {
  /** Soft round falloff — used as the particle point sprite. */
  softBall: tex('SoftBall.png'),
  fluid: tex('Fluid.png'),
  waterExpl: tex('WaterExpl.png'),
  monoNoise: tex('MonoNoise.png'),
  spotlight: tex('Spotlight.jpg'),
  ambientOcclusion: tex('AmbientOcclusion.png'),
  ambientOcclusionNarrow: tex('AmbientOcclusionNarrow.png'),
  lensFlare: [1, 2, 3].map((n) => tex(`LensFlare/${n}.png`)),
  lensFlareDirt: tex('LensFlare/4.jpg'),
  lensFlareMasks: [1, 2, 3].map((n) => tex(`LensFlare/mask${n}.png`)),
} as const;

/** A flipbook packed into a single row-major atlas. */
export interface Flipbook {
  readonly url: string;
  readonly cols: number;
  readonly rows: number;
  readonly frames: number;
  readonly cell: number;
}

/**
 * The two smoke flipbooks, repacked from their original one-PNG-per-frame form
 * into single atlases so they cost one request instead of 228.
 */
export const SMOKE: Record<'thick' | 'thin', Flipbook> = {
  thick: { url: tex('Smoke1.png'), cols: 16, rows: 12, frames: 180, cell: 128 },
  thin: { url: tex('Smoke2.png'), cols: 8, rows: 6, frames: 48, cell: 128 },
};

/**
 * Publishes the sprite URLs as custom properties on :root.
 *
 * The stylesheet can't hardcode these: it's bundled out of `src/` while the art
 * is served from `public/`, so a literal `url()` would resolve against the
 * wrong directory in dev or in a relative-base build. Going through variables
 * lets `BASE_URL` do the work once, here.
 */
export function installSpriteVars(): void {
  const s = document.documentElement.style;
  const set = (name: string, url: string) => s.setProperty(name, `url("${url}")`);
  set('--sprite-sight', GFX.sight);
  set('--sprite-hit', GFX.hitFeedback);
  set('--sprite-hurt', GFX.hurtSprite);
  set('--sprite-hurt-ring', GFX.hurtRing);
  set('--sprite-menu-item', GFX.menuItem);
  set('--sprite-big-menu-item', GFX.bigMenuItem);
  set('--sprite-progress-bar', GFX.progressBar);
  set('--sprite-progress-bg', GFX.progressBg);
  set('--sprite-alert', GFX.alertIcon);
  set('--sprite-cursor', GFX.cursor);
  set('--sprite-close', GFX.close);
  set('--sprite-map-bg', GFX.mapBg);
  set('--sprite-minimap-border', GFX.minimapBorder);
}
