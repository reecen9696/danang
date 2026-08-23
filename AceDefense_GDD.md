# ACE DEFENSE — Game Design Document
### A browser-based, Three.js voxel FPS survival game inspired by *Ace of Spades* Classic (Beta 0.x, 2011, Ben Aksoy)

**Version:** 1.0 (design draft)
**Genre:** Voxel FPS · Wave-survival PvE · Base-building tower defense
**Platform:** Browser (Three.js / WebGL), desktop keyboard + mouse
**Core pitch:** *"Ace of Spades meets Call of Duty: Zombies."* You dig, build, and shoot your way through escalating waves of armed bots. Between rounds you repair your base and visit merchants to buy weapons and building materials with points earned from every kill and every shot that lands.

---

## 1. Design Pillars

1. **Faithful AoS Classic feel.** Digging, block-placing, jumping, spade melee, and the rifle/SMG/shotgun gunplay should feel like the original 0.75/0.76 build — voxel world, ~100 HP, chunky bullets, satisfying block destruction.
2. **The base is the game.** Unlike original AoS where building is optional, here your fort is your lifeline. Bullets and explosives *permanently damage voxels*, and damage persists between rounds until you repair it. Round downtime = repair + fortify time.
3. **Escalating threat.** Waves get harder: more bots, tougher bots, bigger weapons (pistol → SMG → shotgun → rifle → grenadier → bazooka → tank). Every few waves introduces a new enemy archetype.
4. **Economy-driven progression (CoD Zombies loop).** Points from shots and kills → spend at physical in-world merchants (weapon merchant + materials merchant) during the between-round window. Nothing is menu-magic; you physically walk to the town to shop.

---

## 2. Reference: What We're Copying from AoS Classic

These are the confirmed mechanics from the original 2011 prototype that the screenshots depict. We replicate them 1:1 where possible.

| Mechanic | Original AoS Classic value | Our implementation |
|---|---|---|
| Player health | 100 HP | 100 HP (upgradable) |
| Starting blocks | 50 blocks, refilled at base | Materials are now a *currency-bought* resource (see §6) |
| Dig tool | Spade/shovel — removes 1 voxel; also melee weapon (high melee damage, 1–2 hit kill) | Same. Spade digs 1 voxel per swing; melee does big damage |
| Rifle | Semi-auto, ~10 rnd clip; body 49–70, headshot ~100 (1-shot), limb ~33; ~3 hits to destroy a block; 2 RPS | Copied as the mid-tier accurate weapon |
| SMG | ~20 dmg/hit anywhere (5 body shots to kill), high fire rate, big mag, weaker vs blocks | Copied |
| Shotgun | 8 shells, pellet spread, headshot-dependent, strong close range | Copied |
| Grenades | 3 grenades; classic grenade ~130 dmg, radius ~2, block damage ~15 per blast | Copied; buyable |
| Movement | WASD, Space jump, Shift sprint, Ctrl crouch (2 blocks tall vs 3), V sneak (silent) | Copied |
| Block placement | Place 1 voxel; color palette selectable; sample color with right-click | Copied |
| Fall damage | Yes, height-based | Copied |
| Base refill | Walking into your base refills ammo + health + blocks | Reworked into "repair phase + safe zone" (see §5) |
| Block/base damage tracking | Original tracked "blocks of damage to enemy base" | Core mechanic — persistent voxel damage (see §5) |

**Historical note for you:** AoS Classic already had a community "Zombie" siege mode where AI-like zombies broke through blocks to reach players defending a fort — so a PvE siege-defense mode is squarely in the spirit of the original. We're formalizing that into a structured, wave-based, economy-driven mode.

---

## 3. Core Gameplay Loop

```
┌─────────────────────────────────────────────────────────┐
│  BUILD / PREP PHASE  (timer, e.g. 45–90s)               │
│  • Repair voxel damage from last wave                    │
│  • Walk to TOWN → buy weapons (Weapon Merchant)          │
│    and blocks/materials (Materials Merchant)             │
│  • Reposition, dig, fortify, place traps                 │
└───────────────┬─────────────────────────────────────────┘
                │  (timer ends OR player presses "Ready")
                ▼
┌─────────────────────────────────────────────────────────┐
│  COMBAT PHASE  (the wave)                                │
│  • Bots spawn at map edges and advance on your base      │
│  • Their bullets/rockets DAMAGE your voxels permanently  │
│  • You earn points per hit + per kill                    │
│  • Wave clears when all bots are dead                    │
└───────────────┬─────────────────────────────────────────┘
                │  (last bot killed)
                ▼
        WAVE CLEAR BONUS  →  back to BUILD/PREP PHASE
                             (next wave, +difficulty)
```

**Loss condition:** Player dies with no respawn tickets left (see §8), OR the base's core objective ("the Core" / intel-style block) is destroyed. Pick one primary fail state — recommended: **player death with limited respawns**, with base-core destruction as an optional harder mode.

---

## 4. Controls (AoS-faithful)

| Input | Action |
|---|---|
| **W A S D** | Move |
| **Mouse** | Look |
| **Left click** | Fire weapon / swing spade / place-or-mine depending on held tool |
| **Right click** | Aim down sights (guns) / sample block color (block tool) |
| **Space** | Jump |
| **Shift** | Sprint |
| **Ctrl** | Crouch (become 2 blocks tall) |
| **V** | Sneak (silent footsteps) |
| **1** | Spade (dig + melee) |
| **2** | Block tool (place blocks) |
| **3** | Primary gun |
| **4** | Grenades |
| **R** | Reload |
| **Arrow keys / scroll** | Cycle block color palette |
| **G** | Throw grenade (or via slot 4) |
| **E** | Interact (merchants, repair station, ready-up) |
| **B** | Quick-open shop (only works inside town radius) |

---

## 5. The Base & Persistent Voxel Damage (signature mechanic)

- The world is a voxel grid (like AoS). Every block has **HP**.
- **Enemy fire damages blocks.** A block absorbs hits until its HP hits 0, then it's destroyed — leaving a hole exactly like real AoS.
- **Damage persists across rounds.** If a wall is half-blown-out when the wave ends, it stays blown out. During the Prep Phase you must spend materials to rebuild it.
- **Block HP by material tier** (buy tougher blocks as you progress):

| Block type | HP | Cost (materials) | Notes |
|---|---|---|---|
| Dirt/Sand (starter) | 30 | Free-ish / cheap | Default terrain-colored block |
| Wood | 60 | Low | Cheap patch material |
| Stone | 150 | Medium | Standard wall upgrade |
| Reinforced/Concrete | 400 | High | Tanks rifle fire well |
| Steel/Bunker | 1000 | Very high | Resists rockets for a while |

- **Block damage from weapons** scales to the source (rocket blows a crater; SMG barely scratches stone). This mirrors AoS where SMG had reduced block damage and explosives had large block damage.
- **Repair mechanic:** Point the block tool at a damaged block and hold Left click to restore HP over time, consuming materials proportional to HP restored. Or place fresh blocks over destroyed voxels.
- **Digging still works** (spade removes 1 voxel/swing) — so you can carve tunnels, foxholes, murder-holes, and sniper nests exactly like AoS foxhole strategy.

---

## 6. Economy & Points System

### 6.1 Earning points

Every meaningful action grants points (CoD Zombies style — you're rewarded for *participation*, not just kills):

| Action | Points |
|---|---|
| Bullet hits an enemy (per hit) | **+10** |
| Kill — Pistol Grunt | **+50** |
| Kill — SMG Raider | **+60** |
| Kill — Shotgunner | **+75** |
| Kill — Rifleman/Marksman | **+90** |
| Kill — Grenadier | **+120** |
| Kill — Bazooka/Rocketeer | **+150** |
| Kill — Tank (heavy) | **+400** |
| Headshot kill bonus | **+25** on top |
| Melee (spade) kill bonus | **+30** on top (encourages risk) |
| Wave cleared | **+100 × wave number** |
| Full-wave no-damage-to-base bonus | **+250** |
| Repair-less wave (didn't need to repair) | **+150** |

> **Design note:** "+10 per hit" is what makes the SMG viable for farming points even though its per-shot damage is low — deliberately mirrors Zombies where chip damage builds cash.

### 6.2 Spending points — The Town & Merchants

During the Prep Phase, a **Town** area is accessible (a marked safe zone away from the fight, or unlocked via a threshold — e.g. reach the town within the prep timer). Points are *not* an inventory item you spend from a menu mid-fight; you physically **walk to a merchant NPC and press E** to open their stock. Two adjacent merchants:

**A) Weapon Merchant** — sells guns, ammo, grenades, and weapon upgrades.
**B) Materials Merchant** — sells blocks by tier, bulk material packs, traps, and structural upgrades.

Optionally a third:
**C) Utility Merchant** — sells player upgrades (max HP, sprint speed, extra respawn tickets, faster reload).

If the player can't reach town in time, they fight the wave with what they have — creating a risk/reward pace.

### 6.3 Weapon shop pricing (starting reference)

| Item | Cost (points) | Notes |
|---|---|---|
| Spade | — | Always owned (dig + melee) |
| Pistol | Starter (owned) | Weak, infinite-ish, your fallback |
| SMG | 800 | High RoF, big mag, low block dmg |
| Rifle | 1,200 | Accurate, 1-shot headshots |
| Shotgun | 1,500 | Devastating close range |
| Grenades (×3) | 500 | 130 dmg, blast radius, dents blocks |
| Rifle → Scoped upgrade | 1,000 | ADS zoom |
| Ammo refill (current gun) | 150 | Buy between waves |
| Sticky/Frag pack | 700 | AoE crowd control |
| Auto-turret (deployable) | 3,000 | Places an allied turret block (echoes AoS turret) |

### 6.4 Materials shop pricing (starting reference)

| Item | Cost (points) | Notes |
|---|---|---|
| 50 Dirt blocks | 200 | Cheap patch |
| 50 Wood blocks | 350 | |
| 50 Stone blocks | 600 | |
| 25 Reinforced blocks | 900 | |
| 10 Steel/Bunker blocks | 1,200 | Rocket-resistant |
| Spike trap (dmg on contact) | 500 | Slows/damages advancing bots |
| Barbed wire (slow) | 300 | Area denial |
| Instant "repair-all visible damage" | 1,500 | Convenience button |

---

## 7. Enemies (bots) & Wave Progression

Bots spawn at the map perimeter and path toward the base/Core. They shoot your blocks and you. Some dig/break through walls (like AoS zombies), some just blast through. Each has a score value (§6.1).

### 7.1 Enemy roster

| # | Enemy | Weapon | HP | Behavior | Threat to base |
|---|---|---|---|---|---|
| 1 | **Pistol Grunt** | Pistol | 60 | Slow advance, pot-shots | Low (chips blocks) |
| 2 | **SMG Raider** | SMG | 80 | Rushes, sprays | Low-med |
| 3 | **Shotgunner** | Shotgun | 100 | Charges to close range | Med (close block dmg) |
| 4 | **Rifleman** | Rifle | 90 | Holds distance, accurate, can headshot you | Med |
| 5 | **Sapper/Digger** | Spade | 70 | Ignores you, digs into your wall | **High** (destroys voxels fast) |
| 6 | **Grenadier** | Grenades | 110 | Lobs grenades over walls | High (AoE block dmg) |
| 7 | **Rocketeer / Bazooka** | Rocket launcher | 130 | Slow, fires explosive rockets | **Very high** (craters walls) |
| 8 | **Tank** | Cannon | 800 | Slow armored vehicle, big splash | **Extreme** (mini-boss) |
| 9 | **Boss (every 10th wave)** | Mixed / mega-cannon | 3,000+ | Special attack patterns | Base-threatening |

### 7.2 Wave scaling formula (tunable)

- **Bot count:** `baseCount + floor(wave × 1.5)` (e.g. wave 1 = 5 bots, wave 10 ≈ 20).
- **Bot HP multiplier:** `1 + (wave × 0.08)` (bots get ~8% tankier per wave).
- **Damage multiplier:** `1 + (wave × 0.05)`.
- **New archetype unlocks** (introduce gradually so the player learns each threat):
  - Wave 1–2: Pistol Grunts only
  - Wave 3: + SMG Raiders
  - Wave 4: + Shotgunners
  - Wave 5: + Riflemen
  - Wave 6: + Sappers/Diggers (now walls really matter)
  - Wave 7: + Grenadiers
  - Wave 8: + Rocketeers
  - Wave 10: first **Tank** + Boss event
  - Wave 11+: remix all types, more tanks, multiple bosses later
- **Spawn pacing:** don't dump all bots at once; spawn in trickles/sub-waves so the player can manage the fight and farm points.

---

## 8. Player Death & Respawning

Two supported models — pick based on desired difficulty:

**Model A — Respawn tickets (recommended, forgiving):**
- Player starts a run with **3 respawn tickets**.
- On death, respawn at the base after a short delay (e.g. 5s), losing 1 ticket. Keep points and weapons.
- Extra tickets buyable at Utility Merchant (e.g. 2,500 pts each).
- Run ends when you die with 0 tickets. (Optionally: clearing a wave with tickets remaining refunds +1, capped.)

**Model B — Core defense (harder):**
- Unlimited respawns, BUT the base has a **Core block** with its own HP.
- If bots destroy the Core, run ends — respawns don't matter if the objective falls.
- This makes wall integrity the true fail condition and leans hardest into the build-defense fantasy.

**On death (either model):**
- Drop nothing / keep loadout (avoid punishing frustration).
- Points are **retained** (they're your run currency; losing them would feel awful — differs from some Zombies variants intentionally).
- Brief invulnerability on respawn to avoid spawn-camping by bots.

---

## 9. Weapons — Full Stat Table (AoS-derived, tunable)

| Weapon | Dmg (body / head / limb) | Mag | Fire | Block dmg | Notes |
|---|---|---|---|---|---|
| **Spade** | ~50 melee (1–2 hit kill) | — | ~fast swing | 1 voxel/swing | Also the dig tool |
| **Pistol** | 35 / 70 / 25 | 8 | semi | very low | Starter fallback |
| **Rifle** | ~49–70 / 100 (1-shot) / 33 | 10 | 2 RPS semi | ~3 hits/block | Accurate; scope upgrade |
| **SMG** | 20 / ~29 / 20 | 30 | fast auto | low | Point-farming gun |
| **Shotgun** | high close / headshot-dependent / poor | 8 shells | pump | med close | Falls off at range |
| **Grenade** | ~130 in radius | 3 carried | lob | ~15/blast | AoE, dents walls |
| **Rocket (enemy)** | ~300 splash | — | slow | huge crater | What wrecks your base |

*(Numbers pulled from AoS Classic wiki stat readings; treat as starting values and balance in playtest.)*

---

## 10. Map & World

- **Voxel terrain** generated like AoS (hills, water, flat build-space) — your screenshots show exactly this palette (desert fort + island water map).
- **Central player build zone** with a starting shell of a base (a few pre-placed blocks / the Core).
- **Perimeter spawn points** for bots (multiple directions so you can't just wall one side).
- **The Town** — a fixed safe structure off to one side with the two merchants standing side by side, reachable during Prep.
- **Minimap / compass** (top-right, like the screenshots) showing bot directions and the town.
- Fog/draw-distance styling to match the chunky low-fi AoS look (cheap to render in Three.js too).

---

## 11. HUD

- **Center:** crosshair (changes with weapon spread when moving/ADS).
- **Bottom-left:** chat/event log (AoS-style server messages, e.g. "Wave 4 incoming", "Base wall breached!").
- **Bottom-center:** current wave number.
- **Bottom-right:** ammo `mag / reserve` (like the `10-50` in your screenshot).
- **Top-left:** health bar + respawn tickets + block/material count.
- **Top-right:** minimap + **points balance** (always visible — it's your currency).
- **Prep phase:** big countdown timer + "Press E at merchant to shop" prompt.

---

## 12. Three.js / Technical Notes (build guidance)

- **Voxel engine:** use chunked greedy-meshed geometry (don't render one mesh per block). Rebuild only dirty chunks when blocks change. This is the single most important performance decision.
- **Block HP:** store per-voxel HP in a typed array parallel to the block-type array; only mesh visible faces.
- **Raycasting:** for dig/place/shoot, DDA voxel raycast against the grid (fast, no per-block colliders).
- **Bots:** simple state machine (spawn → path to base → attack wall/player → die). A* or flow-field pathing over the voxel grid; diggers path *through* walls by damaging blocks.
- **Bullets:** hitscan for guns (raycast) + projectile objects for rockets/grenades (physics arc + explosion that queries voxels in radius for block damage).
- **Persistence between rounds:** keep the voxel array in memory across the prep→combat transitions; never regenerate the map between waves.
- **Physics:** capsule/AABB player collider vs voxel grid; gravity + jump + fall damage from landing velocity.
- **Economy state:** single `points` integer; merchant UIs are simple DOM/overlay panels gated by proximity to the town.
- **AI-powered flavor (optional):** you *could* use the in-artifact Anthropic API to generate dynamic merchant banter or wave taunts, but keep all gameplay logic client-side/deterministic.

---

## 13. Progression Summary (the full "what does the player do" arc)

1. Spawn at a bare-bones base with a spade + pistol + a handful of blocks.
2. **Prep Phase:** dig a foxhole, throw up starter walls, jog to town, buy an SMG + stone blocks.
3. **Wave 1:** kill Pistol Grunts, +10 per hit, +50 per kill — bank points.
4. **Clear** → +100 wave bonus → repair the couple of chipped blocks.
5. Waves ramp: buy the rifle, then shotgun, then grenades. Upgrade walls dirt→stone→reinforced as rockets appear.
6. **Wave 6+:** Sappers dig your walls — now you're actively repairing mid-fight and rethinking layout (murder-holes, layered walls).
7. **Wave 8:** Rocketeers crater your base — steel blocks and turrets become worth it.
8. **Wave 10:** Tank + Boss. Big points, big threat.
9. Loop escalates until the player dies out of tickets (Model A) or the Core falls (Model B). Final score = total points / highest wave reached.

---

## 14. Stretch / Optional Features
- Perks (Zombies-style): "Fast Reload," "Juggernog" (extra HP), "Speed Cola."
- Mystery box weapon gamble.
- Co-op multiplayer (much bigger scope — needs netcode; single-player first).
- Multiple maps with different chokepoints.
- Between-run meta-progression (permanent unlocks).

---

*End of document. All AoS stat values are drawn from the original Classic (0.75/0.76) community wiki and should be treated as starting points for playtest balancing.*
