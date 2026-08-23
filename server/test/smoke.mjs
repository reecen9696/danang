import { Client } from 'colyseus.js';

const client = new Client('ws://localhost:2567');
const log = (...a) => console.log('[smoke]', ...a);

const a = await client.joinOrCreate('defense', { name: 'Alice' });
log('A joined, sessionId =', a.sessionId);

let init = null;
a.onMessage('init', (m) => { init = m; log('init: seed =', m.seed, 'ops =', m.ops.length, 'spawn =', JSON.stringify(m.spawn)); });
a.onMessage('announce', (m) => log('announce:', m.text));

// Second player joins the same room.
const b = await client.joinOrCreate('defense', { name: 'Bob' });
log('B joined, sessionId =', b.sessionId, '| same room:', a.roomId === b.roomId);

let bInit = null;
b.onMessage('init', (m) => { bInit = m; });
b.onMessage('voxel', (op) => log('B saw voxel op from A:', JSON.stringify(op)));

await new Promise(r => setTimeout(r, 800));
log('players in state:', a.state.players.size, '| seed matches:', init?.seed === bInit?.seed);

// A digs a block; B should be told about it.
a.send('voxel', { op: 1, x: 128, y: 30, z: 128, color: 0, mat: 0 });
a.send('move', { x: 130, y: 32, z: 130, yaw: 1, pitch: 0, hp: 100, alive: true, slot: 2, weapon: 'rifle', sprinting: false });
await new Promise(r => setTimeout(r, 600));
log('A position replicated to B:', JSON.stringify({
  x: b.state.players.get(a.sessionId)?.x, z: b.state.players.get(a.sessionId)?.z,
}));

// Cut prep short and watch a wave actually spawn bots.
log('phase before ready:', a.state.phase, 'wave', a.state.wave);
a.send('ready');
await new Promise(r => setTimeout(r, 4000));
log('phase after ready:', a.state.phase, 'wave', a.state.wave, '| bots =', a.state.bots.size, '| remaining =', a.state.remaining);

const first = [...a.state.bots.values()][0];
if (first) log('sample bot:', JSON.stringify({ slot: first.slot, kind: first.kind, x: +first.x.toFixed(1), z: +first.z.toFixed(1), hp: first.hp, state: first.state }));

// Report a hit on that bot and confirm the server applies it.
if (first) {
  const before = first.hp;
  a.send('botHit', { slot: first.slot, damage: 25 });
  await new Promise(r => setTimeout(r, 400));
  const after = a.state.bots.get(String(first.slot))?.hp;
  log('botHit: hp', before, '->', after, after < before ? 'OK' : 'NOT APPLIED');
}

// Late joiner must receive the accumulated edit log.
const c = await client.joinOrCreate('defense', { name: 'Carol' });
const cInit = await new Promise(r => c.onMessage('init', r));
log('late joiner got seed', cInit.seed, 'and', cInit.ops.length, 'replay ops');

// Bots should be moving.
const p0 = [...a.state.bots.values()][0];
const snap = p0 ? { x: p0.x, z: p0.z } : null;
await new Promise(r => setTimeout(r, 1500));
const p1 = p0 ? a.state.bots.get(String(p0.slot)) : null;
if (snap && p1) log('bot moved:', Math.hypot(p1.x - snap.x, p1.z - snap.z).toFixed(2), 'units in 1.5s');

await a.leave(); await b.leave(); await c.leave();
log('done');
process.exit(0);
