# Multiplayer

Co-op wave survival: several players defend the same fort against the same
waves. The authoritative server lives in [`../server`](../server/README.md).

## Running it

```bash
# terminal 1
cd server && npm install && npm run dev

# terminal 2
cd game && npm run dev
```

Then open, in as many windows as you have friends:

```
http://localhost:5173/?server=ws://localhost:2567&name=YourName
```

## URL parameters

| Param | Effect |
| --- | --- |
| `?server=ws://host:port` | Connect to that server. Overrides `VITE_SERVER_URL`. |
| `?name=Ace` | Your display name. Remembered in localStorage. |
| `?solo` | Force single-player even when a server is configured. |
| `?map=<url>` | Load a `.vxl` map instead of generating terrain. |

With no `?server` and no `VITE_SERVER_URL`, the game runs single-player exactly
as before — multiplayer is purely additive.

## What changes in multiplayer

`Game` keeps a `net` reference. When it is set:

- the local `WaveManager` and bot AI stop running; both arrive as server state
- bot positions are written into the existing bot pool by slot index and eased
  toward each snapshot, so all the existing rendering keeps working unchanged
- other players render as instanced blocky avatars (`net/RemotePlayers.ts`)
- voxel edits are applied locally for responsiveness, then sent up; edits from
  others arrive as `voxel` messages
- the HUD wave box reads the server's phase, timer and progress
- pressing the ready key sends `ready` instead of ending prep locally

Terrain is never transferred. The server sends a seed; `generateWorld(world,
seed)` is deterministic, so every client builds identical terrain and only the
*edits* need replicating. A late joiner also receives the accumulated edit log.

## What the enemy does about a squad

Every bot picks its own man. `BotWorldContext.targets` is a list — one entry per
connected player, rebuilt in place each tick by `ServerSim` — and each bot takes
the nearest living one, keeps him while it has eyes on him, and only swaps for
somebody meaningfully closer. Pathing splits the same way it always did, through
`NavGrid.setSeeds()`.

That per-bot choice is also what addresses the damage: `botFire` carries the
session id of the man that bot was shooting at, and only that client resolves
the round against itself. Two players under fire at once each take their own.

## Friendly fire

It is on, and there are no teams — a squadmate swept up by your own hitscan
takes the round. The shooter reports it, the server routes it, the victim
applies it, which is the same split used for damage taken from bots. The kill
feed names who did it.

## Known limits

- **Hits are client-reported.** Fine among friends, not cheat-resistant. See the
  authority table in the server README.
- **A backgrounded tab stalls on the loading screen.** World generation awaits
  `requestAnimationFrame`, which Chrome throttles in hidden tabs. Keep the tab
  in front while it loads. This predates multiplayer but you notice it more when
  opening several windows.
- **Two WebGL clients on one machine is heavy.** Expect a crashed tab if you
  open several full-detail windows side by side.
