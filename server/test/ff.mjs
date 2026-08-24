/** Friendly fire: A reports a hit on B, B must receive `hurt`. */
import { Client } from 'colyseus.js';

const endpoint = process.env.SMOKE_SERVER || 'ws://localhost:2567';
const client = new Client(endpoint);
const log = (...a) => console.log('[ff]', ...a);

const a = await client.joinOrCreate('defense', { name: 'Shooter' });
const b = await client.joinOrCreate('defense', { name: 'Victim' });
log('same room:', a.roomId === b.roomId);

let hurt = null;
b.onMessage('hurt', (m) => { hurt = m; log('B received hurt:', JSON.stringify(m)); });
let aHurt = null;
a.onMessage('hurt', (m) => { aHurt = m; });

// Both need to be alive in state before the server will route a hit.
for (const r of [a, b]) {
  r.send('move', { x: 128, y: 31, z: 133, yaw: 0, pitch: 0, hp: 100, alive: true, slot: 2, weapon: 'rifle', sprinting: false });
}
await new Promise(r => setTimeout(r, 600));

a.send('playerHit', { target: b.sessionId, damage: 49, zone: 1, x: 120, z: 130 });
await new Promise(r => setTimeout(r, 800));
log(hurt ? 'PASS: relay delivered' : 'FAIL: no hurt message');
log('named shooter correctly:', hurt?.name === 'Shooter');
log('damage preserved:', hurt?.damage === 49);

// Self-hits must be dropped, or a client could launder its own hp.
a.send('playerHit', { target: a.sessionId, damage: 99, zone: 1, x: 0, z: 0 });
// Non-existent target must not throw on the server.
a.send('playerHit', { target: 'nobody', damage: 99, zone: 1, x: 0, z: 0 });
// Garbage damage must be rejected.
a.send('playerHit', { target: b.sessionId, damage: -500, zone: 1, x: 0, z: 0 });
a.send('playerHit', { target: b.sessionId, damage: 'lots', zone: 1, x: 0, z: 0 });
const before = hurt;
await new Promise(r => setTimeout(r, 800));
log('self-hit ignored:', aHurt === null);
log('bad input ignored:', hurt === before);

// Server still alive after the garbage?
a.send('move', { x: 128, y: 31, z: 133, yaw: 0, pitch: 0, hp: 100, alive: true, slot: 2, weapon: 'rifle', sprinting: false });
await new Promise(r => setTimeout(r, 400));
log('server still responsive:', a.state.players.size >= 2);

await a.leave(); await b.leave();
log('done');
process.exit(0);
