/**
 * Parks a puppet player near the spawn so the third-person avatar can be
 * eyeballed from a real client. Walks a slow circle facing the centre, so the
 * stride, the aim pitch and the weapon in the hands all get exercised.
 *
 *   node test/poser.mjs [weapon] [radius]
 */
import { Client } from 'colyseus.js';

const endpoint = process.env.SMOKE_SERVER || 'ws://localhost:2567';
const weapon = process.argv[2] || 'rifle';
const radius = Number(process.argv[3] || 4);
const NAME = process.env.POSER_NAME || 'Bravo';

// The spawn the server hands out; the puppet orbits it so it crosses the view
// whichever way the watching client happens to be facing.
const CX = 128, CY = 31, CZ = 133;

const client = new Client(endpoint);
const room = await client.joinOrCreate('defense', { name: NAME });
console.log(`[poser] ${NAME} joined ${room.roomId} as ${room.sessionId} with ${weapon}`);

let a = 0;
setInterval(() => {
  a += 0.02;
  const x = CX + Math.cos(a) * radius;
  const z = CZ + Math.sin(a) * radius;
  // Face the centre, so the watcher sees the front of the model.
  const yaw = Math.atan2(CX - x, CZ - z);
  room.send('move', {
    x, y: CY, z,
    yaw,
    pitch: Math.sin(a * 3) * 0.35,
    hp: 100, alive: true, slot: 2, weapon,
    sprinting: false,
  });
}, 50);

process.on('SIGINT', async () => { await room.leave(); process.exit(0); });
