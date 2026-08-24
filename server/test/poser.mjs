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
const TURN = Number(process.env.POSER_TURN || 0);

// The spawn the server hands out; the puppet orbits it so it crosses the view
// whichever way the watching client happens to be facing.
const CX = 128, CY = 31, CZ = 133;

const client = new Client(endpoint);
const room = await client.joinOrCreate('defense', { name: NAME });
console.log(`[poser] ${NAME} joined ${room.roomId} as ${room.sessionId} with ${weapon}`);

// POSER_FREEZE parks him at one bearing instead of orbiting, which is what you
// want when you are inspecting the model rather than the walk cycle.
const frozen = process.env.POSER_FREEZE !== undefined;
let a = frozen ? Number(process.env.POSER_FREEZE) || 0 : 0;
setInterval(() => {
  if (!frozen) a += 0.02;
  const x = CX + Math.cos(a) * radius;
  const z = CZ + Math.sin(a) * radius;
  // Face the centre, so the watcher sees the front of the model.
  //
  // A player's yaw is his camera's, and a camera looks down -z: see
  // Player.getLookDirection, which is where the client reads this back. That
  // is the opposite of a bot's yaw, which is the bearing it walks on, so the
  // two differ by half a turn and a puppet posed with the wrong one stands
  // with its back to whoever is watching.
  // POSER_TURN swings him off that by a fixed amount: a quarter turn puts him
  // in profile, which is the only view that shows whether the weapon is
  // actually in his hands or just pointed at you.
  const yaw = Math.atan2(x - CX, z - CZ) + TURN;
  room.send('move', {
    x, y: CY, z,
    yaw,
    pitch: Math.sin(a * 3) * 0.35,
    hp: 100, alive: true, slot: 2, weapon,
    sprinting: false,
  });
}, 50);

process.on('SIGINT', async () => { await room.leave(); process.exit(0); });
