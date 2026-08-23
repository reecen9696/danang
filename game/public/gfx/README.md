# HUD / overlay art

The original Ace of Spades HUD and menu art, taken from the OpenSpades
reference checkout at `reference/openspades/Resources/Gfx`. The directory
layout mirrors the source tree so every file can be traced back.

`.tga` sources (`Sight`, `White`, `DashLine`, `HurtRing`, `Scoreboard/TopShadow`,
`Fonts/MapFont`) were converted to 32-bit RGBA PNG — browsers cannot decode TGA.
Nothing else was altered.

## What's here, and where it's used

| Path | Used by |
| --- | --- |
| `Sight.png` | The reticle. Four corner brackets on one 64×64 sheet; each quadrant is masked out and pushed diagonally by the weapon cone (`styles.css` `#crosshair`) |
| `HitFeedback.png` | Hit marker (`#hitmarker`), tinted red on a kill |
| `HurtSprite.png` | Blood bands masked onto the top and bottom screen edges when you take damage |
| `HurtRing.png` | The arc that swings around screen centre to point at whatever hit you (`.dmg-dir`) |
| `AlertIcon.png` | Glyph on `warn`/`bad` log lines and the merchant header |
| `Limbo/MenuItem.png` | Nine-sliced as the mask for every `.panel` — that's where the cut top-right corner comes from |
| `Limbo/BigMenuItem.png` | Same, for shop item cards |
| `MinimapBorder.png` | Nine-sliced frame around the minimap canvas |
| `MapBg.png` | Tiled as the minimap backdrop |
| `Map/Player.png`, `Map/View.png` | Player arrow and view cone at the minimap centre |
| `Map/CommandPost.png`, `Map/Intel.png` | Base and town markers, tinted per state |
| `Bullet/9mm.png`, `7.62mm.png`, `12gauge.png` | One icon per round in the clip, above the ammo counter |
| `TC/ProgressBar.png`, `ProgressBg.png` | The wave box bar — amber for the prep countdown, red for wave progress |
| `DotSight.png`, `Ball.png`, `HurtRing2.png` | Alternates, wired up in `src/ui/gfx.ts` but not currently used |
| `Scoreboard/*`, `UI/*`, `Banner.png`, `Palette.png`, `White.png`, `DashLine.png`, `DitherPattern4x4.png`, `CircleGradient.png`, `Fonts/*` | Available via `GFX` in `src/ui/gfx.ts`; not yet placed |

Paths are never hardcoded in the stylesheet. `installSpriteVars()` in
`src/ui/gfx.ts` publishes them as `--sprite-*` custom properties on `:root`,
because the CSS is bundled out of `src/` while the art is served from `public/`
and a literal `url()` would resolve against the wrong directory.

## Effect textures

`public/tex/` holds the non-HUD art: `SoftBall.png` (bound as the particle point
sprite, which is what stops particles rendering as hard squares), `Fluid.png`,
`WaterExpl.png`, `MonoNoise.png`, `Spotlight.jpg`, `AmbientOcclusion*.png` and
`LensFlare/`.

The two smoke flipbooks shipped as 180 and 48 separate PNGs. They're repacked
into single row-major atlases — `Smoke1.png` (16×12 cells) and `Smoke2.png`
(8×6), 128px cells — so they cost one request each instead of 228. Geometry is
described by `SMOKE` in `src/ui/gfx.ts`. Note that Smoke2's frames were 16-bit
`rgba64be`; they need a depth conversion before tiling or the alpha is lost.
Nothing draws these yet — an animated billboard system would be needed first.

## Not copied

The nonfree pak (`pak000-Nonfree.pak`) isn't in the reference checkout and must
not be redistributed.

Layered Photoshop sources for the weapon markers are in `game/art/gfx/Map/`,
outside `public/` so they aren't shipped.

`Title/Logo.png` and `Title/LogoSmall.png` are the *OpenSpades* wordmark, so
they were moved to `game/art/gfx/Title/` as a type reference rather than being
served. Don't ship another project's branding — the title screens use styled
text instead.

## Licence

Copyright 2017 OpenSpades Contributors. Distributed under the **GNU GPL v3** —
see `reference/openspades/LICENSE` and
`reference/openspades/Resources/License/Credits-pak002-Base.md`.

Shipping these files makes the build subject to the GPLv3.
