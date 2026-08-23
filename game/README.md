# Ace Defense

A browser voxel FPS wave-survival game built on Three.js — dig, build, and hold
a fort against escalating waves of armed bots. Implements `AceDefense_GDD.md`.

```bash
cd game
npm install
npm run dev      # http://localhost:5173
npm run build    # typecheck + production bundle into dist/
npm run preview  # serve the production build
```

## Controls

| Input | Action |
|---|---|
| `W A S D` | Move |
| Mouse | Look · LMB fire/dig/place · RMB aim (or sample block colour) |
| `Space` / `Ctrl` / `Shift` / `V` | Jump · Crouch · Sprint · Sneak |
| `1` `2` `3` `4` | Spade · Blocks · Gun · Grenade |
| `R` | Reload |
| `E` | Interact — open a merchant, or ready up to start the wave early |
| `Q` / scroll | Cycle block material (or weapon) |
| Arrows / `C` | Cycle build colour / toggle material-colour mode |
| `F3` | Performance overlay |
| `Esc` | Pause |

Aim the block tool at a **damaged** block and hold LMB to repair it; aim at an
intact surface to build outward.

## The map

Generated procedurally each run (seeded, so it's reproducible). The layout is
built around the defense fantasy rather than being pretty scenery:

- **The fort sits on a mesa** with a flat buildable top ringed by a deliberately
  unclimbable cliff. Bots physically cannot walk up it.
- **Three ramps** cut through that cliff. They are the chokepoints the whole
  defense revolves around — the starter ring wall is left open facing each one,
  with a sandbag nest covering it, so your first job is obvious.
- **A watchtower** on the plateau gives a sniper perch.
- **Terrain** uses domain-warped fBm with a ridged-noise highland mask, so ridges
  meander instead of looking like lumpy noise. A river is carved across the
  lowlands and drains to the sea; the island has proper beaches.
- **Biomes** are chosen per-voxel from slope, altitude and a moisture field:
  grass and moss in the wet lowlands, dry grass where it's arid, exposed cliff
  rock wherever the slope is steep, gravel and snow up high, sand at the water.
- **Foliage** — broadleaf trees (occasionally autumn-coloured), layered conifers,
  leaning palms along the shore, bushes, and boulder fields on the rocky ground.
  Scatter uses a jittered grid weighted by the moisture field, and skips the
  plateau, the ramps and the town so nothing blocks a firing lane.
- **The town** is a walled plaza with merchant stalls and houses, linked to the
  fort by a dirt road.

### Importing a classic `.vxl` map

`src/voxel/vxl.ts` implements the original Ace of Spades map format, so you can
play a real AoS map:

```
http://localhost:5173/?map=/maps/yourmap.vxl
```

Put the file in `public/maps/`. The importer crops the 512x512 source to our
256x256 world (no scaling, so voxel detail is preserved 1:1), flips the
Z-down axis to Y-up, and maps each 24-bit colour to the nearest palette entry
with a cache. `prepareImportedMap()` then levels a pad for the fort and the
town and drops the structures and spawns onto it.

**No map files ship with this game.** See `reference/README.md` — the only map in
the OpenSpades checkout is its GPLv3 title-screen backdrop, and vendoring it
would make this project a GPL derivative.

## Architecture

```
src/
  core/        constants, input, renderer (adaptive resolution)
  voxel/       VoxelWorld storage, greedy mesher + worker pool, DDA raycast,
               worldgen (terrain/biomes/foliage), .vxl importer
  player/      physics/controller, loadout, first-person viewmodel
  weapons/     weapon table, ammo/reload state, projectiles
  ai/          bot archetypes, flow-field navigation, bot manager
  game/        Game orchestration, wave manager, economy/shops
  fx/          particles, tracers, damage decals
  ui/          HUD, minimap, merchant shop
  audio/       procedural WebAudio synthesis (no audio assets)
```

## Performance notes

The map is 256 x 64 x 256 (4.2M voxels). The decisions that matter:

- **Flat typed arrays.** Three parallel arrays (`blocks` palette index, `mat`,
  `hp`) so "is this solid?" is one `Uint8` read. Nothing allocates in the hot path.
- **Greedy meshing with baked lighting.** Faces merge into the largest possible
  quads; face shading and per-vertex ambient occlusion are folded straight into
  the vertex colour. The world therefore renders with an *unlit* material — no
  lights, no normals attribute, no texture fetch. The full map is ~120k triangles
  across ~75 chunk meshes.
- **Worker pool.** Meshing runs on up to 4 workers over a 1-voxel-padded copy of
  each chunk. Scratch buffers are pooled and transferred both ways, so a stream
  of block edits allocates nothing. Only dirty chunks remesh, nearest-first.
- **Analytic bounds.** Chunk bounding spheres are computed from the chunk size
  rather than by scanning vertex buffers.
- **Damage as decals, not remeshes.** Re-meshing a chunk per bullet would be far
  too expensive, so voxel damage renders as instanced crack overlays (4 draw calls).
- **One draw call per crowd.** Every bot shares a single `InstancedMesh`;
  particles are one CPU-simulated `Points` buffer; tracers are one `LineSegments`.
- **Flow-field AI.** A single breadth-first sweep over the surface heightmap gives
  every bot its direction in O(1), instead of per-bot A*. The heightmap is
  maintained incrementally on every block edit. It naturally routes the horde
  through whatever gaps you leave, and bots breach walls when no route exists.
- **Adaptive resolution.** Frame times drive an internal render-scale controller
  (0.55x–1.0x) to hold the frame budget on weaker GPUs.
- **Event-driven loading.** Initial meshing is driven by worker-completion events
  rather than a polling timer, which browsers clamp hard in background tabs.

Measured in a production build: ~41 draw calls and ~50k triangles for a typical
view, with roughly 1 ms of CPU per frame. `F3` shows the live numbers.

## Fidelity to Ace of Spades Classic

Movement and gunplay constants are taken from AoS Classic (0.75/0.76) so the feel
matches: the velocity/friction integration and its 32x world-unit scale, the
0.1/0.3/0.5/1.3 air-control, crouch, sneak and sprint multipliers, fall-damage
thresholds, and the Rifle/SMG/Shotgun damage, clip, delay, reload and spread
values. See `reference/README.md` for provenance and licensing.
