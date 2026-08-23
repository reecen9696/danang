# Ace Defense — co-op server

Authoritative Colyseus server for co-op wave survival.

## How it fits together

The server **imports the client's simulation modules directly** from
`../game/src` — `VoxelWorld`, `worldgen`, `NavGrid`, `BotManager`,
`WaveManager`. None of them contain rendering code (the only three.js they touch
is `Vector3` maths, which runs fine headless), so both sides agree by
construction instead of by two implementations being kept in step by hand.

That is also why the build uses esbuild rather than `tsc`: a plain `tsc` build
cannot emit sources from outside its `rootDir`. `npm run build` bundles
everything reachable from `src/index.ts` into `build/index.js` and leaves
node_modules external.

**The world is never sent over the wire.** At 256×64×256 it is four million
voxels. Terrain generation is a pure function of the seed, so every client
regenerates identical terrain locally and only *edits* are replicated — as
messages, not schema state. A late joiner receives the seed plus the accumulated
edit log and replays it.

## Authority

| Owned by the server | Owned by the client |
| --- | --- |
| Terrain seed, every voxel edit | Its own movement and camera |
| Wave schedule and phase clock | Its own hit detection |
| All bot AI, pathing and health | Its own damage taken |
| Core health, run-over state | Effects, audio, rendering |

Clients report their own position and their own hits. That is the right trade
for co-op: the failure mode of trusting a friend is a worse scoreboard, not a
ruined match. It is **not** cheat-resistant — don't run this as a public
competitive server without moving hit detection server-side.

Bots path toward the objective *and* every living player: `NavGrid.setSeeds()`
takes a seed list, so the flow field splits the squad toward whoever is nearest
rather than funnelling everyone down one lane.

## Run it

```bash
npm install          # .npmrc sets legacy-peer-deps; see "Dependency notes"
npm run dev          # tsx watch, port 2567
npm run build        # -> build/index.js
npm start
```

Then point a client at it:

```
http://localhost:5173/?server=ws://localhost:2567&name=YourName
```

`?solo` forces the original single-player path. With no `?server` and no
`VITE_SERVER_URL`, the game runs single-player exactly as before — multiplayer
is additive.

## Deploying to Colyseus Cloud

You need to be logged in as yourself for this; it cannot be done on your behalf.

```bash
cd server
npx @colyseus/cloud deploy      # prompts for login on first run
```

Cloud runs `npm install && npm run build && npm start` and sets `PORT`.
`/health` is there for its probe.

**One caveat:** Cloud uploads the deploy directory, and this server's build
reads `../game/src`. Either deploy from the repo root, or vendor the shared
modules into `server/src/shared/` before deploying. The Dockerfile takes the
first approach (build context = repo root) and is the simpler path if Cloud's
uploader gives you trouble.

Then build the client against the deployed URL:

```bash
cd game && VITE_SERVER_URL=wss://your-app.colyseus.cloud npm run build
```

A page served over https cannot open a `ws://` socket — the client rewrites
`ws://` to `wss://` automatically when it detects this, but the server must
actually terminate TLS. Cloud does.

## Self-hosting instead

```bash
docker build -f server/Dockerfile -t ace-defense-server .   # from the repo root
docker run -p 2567:2567 ace-defense-server
```

## Dependency notes

Three things in the Colyseus 0.16 line are worth knowing, because they cost real
time to diagnose:

1. **`@colyseus/core` is pinned to exactly `0.16.24`, not `^0.16.24`.** Version
   `0.16.25` shipped with an unresolvable `"@colyseus/greeting-banner":
   "workspace:^"` dependency — an internal reference that escaped into the
   release — and any range that admits it breaks `npm install` outright.

2. **`.npmrc` sets `legacy-peer-deps=true`.** `colyseus@0.16` declares empty
   `dependencies` and lists everything as peers, including the redis and
   uWebSockets drivers this deployment does not use. Without the flag npm fails
   to resolve; the peers actually needed are pinned explicitly instead.

3. **We import `@colyseus/core` directly rather than the `colyseus` barrel.**
   The barrel eagerly imports `@colyseus/redis-presence`, which then has to be
   installed even for a single-process server.

Why 0.16 and not 0.17: the newest published browser client, `colyseus.js@0.16.22`,
depends on `@colyseus/schema@^3`. Server 0.17 moved to schema v4 and the two wire
formats do not interoperate, so 0.16 on both sides is the only matching pair
currently on npm.

### Schema definitions

`src/schema/RoomState.ts` uses the `schema()` helper rather than `defineTypes`
or decorators. In `@colyseus/schema@3.0.76` `defineTypes` fails to register the
child type of a `{ map: X }` field, and encoding the first map entry throws
`Cannot read properties of undefined (reading Symbol.metadata)`. Decorators need
`experimentalDecorators`, which the esbuild bundle does not pick up reliably.

The helper's one sharp edge: **it does not install default values.** An untouched
numeric field is `undefined`, so the first `++` yields `NaN` and the encoder
rejects it. Every field is therefore assigned explicitly on creation. Keep it
that way when adding fields.
