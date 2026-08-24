/**
 * Do the enemy actually come for everybody?
 *
 * Drives ServerSim headless with a spread-out squad and checks that the horde
 * distributes itself across them rather than all walking at one man.
 */
import { ServerSim, BotKind } from '../src/sim/ServerSim';

/** Exactly what DefenseRoom puts in the `target` field of each botFire. */
const shotsAt = new Map<string, number>();

const sim: ServerSim = new ServerSim(1234, {
  onAnnounce: () => {},
  onPhaseChange: () => {},
  onWaveCleared: () => {},
  onBotFire: (bot) => {
    const id = sim.targetIdOf(bot) || '(nobody)';
    shotsAt.set(id, (shotsAt.get(id) ?? 0) + 1);
  },
  onBotDeath: () => {},
  onBotVoice: () => {},
  onVoxelOp: () => {},
});

const base = sim.layout.baseCenter;
// Three men, well apart, so "nearest" is unambiguous for each corner of the map.
const spots = [
  { id: 'alice', dx: -30, dz: 0 },
  { id: 'bob', dx: 30, dz: 0 },
  { id: 'carol', dx: 0, dz: 34 },
];
for (const s of spots) {
  const x = base.x + s.dx;
  const z = base.z + s.dz;
  const y = sim.world.surfaceHeight(Math.floor(x), Math.floor(z)) + 1;
  sim.addPlayer({ id: s.id, x, y, z, vx: 0, vy: 0, vz: 0, eyeY: y + 2.4, alive: true });
}

// Spawn a batch of enemies right on top of each man so targeting is decided by
// proximity and nothing else.
for (const s of spots) {
  for (let i = 0; i < 6; i++) {
    sim.bots.spawn(BotKind.Rifleman, base.x + s.dx + (i - 3), 0, base.z + s.dz + 2, 1, 1);
  }
}

for (let i = 0; i < 600; i++) sim.step(1 / 20);

const counts = new Map<string, number>();
let untargeted = 0;
for (const bot of sim.bots.bots) {
  if (!bot.active || !bot.alive) continue;
  const id = sim.targetIdOf(bot);
  if (!id) { untargeted++; continue; }
  counts.set(id, (counts.get(id) ?? 0) + 1);
}
console.log('[targeting] bots per player:', JSON.stringify(Object.fromEntries(counts)));
console.log('[targeting] bots with no target:', untargeted);
console.log('[targeting] distinct players hunted:', counts.size, counts.size === 3 ? 'PASS' : 'FAIL');

// The wire field: every shot is addressed to the man it was aimed at, which is
// what makes a client resolve the damage on itself.
console.log('[targeting] rounds fired at each player:', JSON.stringify(Object.fromEntries(shotsAt)));
const addressed = [...shotsAt.keys()].filter((k) => k !== '(nobody)');
console.log('[targeting] shots addressed to >1 player:', addressed.length > 1 ? 'PASS' : 'FAIL');

// Now kill one and confirm his hunters move on rather than standing around.
const victim = sim.getPlayer('bob')!;
victim.alive = false;
for (let i = 0; i < 60; i++) sim.step(1 / 20);

const after = new Map<string, number>();
for (const bot of sim.bots.bots) {
  if (!bot.active || !bot.alive) continue;
  const id = sim.targetIdOf(bot);
  if (id) after.set(id, (after.get(id) ?? 0) + 1);
}
console.log('[targeting] after bob dies:', JSON.stringify(Object.fromEntries(after)));
console.log('[targeting] nobody still hunting bob:', !after.has('bob') ? 'PASS' : 'FAIL');

// And that a disconnect is handled without leaving a dangling reference.
sim.removePlayer('carol');
for (let i = 0; i < 40; i++) sim.step(1 / 20);
const final = new Set<string>();
for (const bot of sim.bots.bots) {
  if (bot.active && bot.alive) { const id = sim.targetIdOf(bot); if (id) final.add(id); }
}
console.log('[targeting] after carol leaves, hunted:', JSON.stringify([...final]));
console.log('[targeting] only alice left:', final.size === 1 && final.has('alice') ? 'PASS' : 'FAIL');
