/**
 * The village civilians: do they stay out of the walls, and can the buffalo
 * be killed?
 *
 * Runs against a real generated world rather than a synthetic one, because the
 * bug being guarded here is specifically about the huts the worldgen puts in
 * the town.
 */
import { VoxelWorld } from '../../game/src/voxel/VoxelWorld';
import { generateWorld } from '../../game/src/voxel/worldgen';
import { Townsfolk } from '../../game/src/fx/Townsfolk';
import { Ox } from '../../game/src/fx/Ox';
import { walkClear } from '../../game/src/fx/walk';

const world = new VoxelWorld();
const layout = generateWorld(world, 4242);
world.rebuildHeights();

const town = layout.townCenter;
const say = (...a: unknown[]) => console.log('[village]', ...a);

/** Is a body of `radius` at (x, z) standing inside solid rock? */
function inside(x: number, y: number, z: number, radius: number): boolean {
  const fy = Math.floor(y);
  for (let cx = -1; cx <= 1; cx += 2) {
    for (let cz = -1; cz <= 1; cz += 2) {
      for (let dy = 0; dy < 3; dy++) {
        if (world.isSolid(Math.floor(x + cx * radius), fy + dy, Math.floor(z + cz * radius))) {
          return true;
        }
      }
    }
  }
  return false;
}

// --- 1. walkClear never leaves a body inside geometry ----------------------
// Walk a body across the whole town from many starting points and headings.
// Any frame that ends up inside a hut is the bug this exists to catch.
let steps = 0;
let embedded = 0;
let blockedRuns = 0;
for (let a = 0; a < 64; a++) {
  const ang = (a / 64) * Math.PI * 2;
  const w = { x: town.x, y: town.y, z: town.z };
  // Start somewhere clear, then walk outward through whatever is there.
  if (inside(w.x, w.y, w.z, 0.46)) continue;
  let moved = 0;
  for (let i = 0; i < 400; i++) {
    const ok = walkClear(world, w, Math.sin(ang) * 0.12, Math.cos(ang) * 0.12, 0.46);
    steps++;
    if (ok) moved++;
    if (inside(w.x, w.y, w.z, 0.46)) embedded++;
  }
  if (moved === 0) blockedRuns++;
}
say(`walked ${steps} steps on ${64 - blockedRuns} headings out of the town centre`);
say('frames ending inside a block:', embedded, embedded === 0 ? 'PASS' : 'FAIL');

// --- 2. a villager pushed at a wall stops at it ----------------------------
// Find a solid wall near the town and try to walk through it.
let wallX = -1, wallY = 0, wallZ = -1;
outer: for (let r = 2; r < 26 && wallX < 0; r++) {
  for (let a = 0; a < 90; a++) {
    const ang = (a / 90) * Math.PI * 2;
    const x = Math.round(town.x + Math.sin(ang) * r);
    const z = Math.round(town.z + Math.cos(ang) * r);
    const y = world.surfaceHeight(x, z);
    // A wall: solid at head height with clear ground a step back.
    // A wall face: ground here stands well proud of the town's own level.
    if (y >= town.y + 2) {
      wallX = x; wallY = y; wallZ = z;
      break outer;
    }
  }
}
if (wallX < 0) {
  say('no wall found near town — skipping the push test');
} else {
  say(`wall at ${wallX},${wallY},${wallZ}`);
  // Stand 4 blocks out and walk straight at it for a long time.
  const dirX = Math.sign(town.x - wallX) || 1;
  const dirZ = Math.sign(town.z - wallZ) || 1;
  const w = {
    x: wallX + dirX * 4 + 0.5,
    y: world.surfaceHeight(Math.round(wallX + dirX * 4), Math.round(wallZ + dirZ * 4)),
    z: wallZ + dirZ * 4 + 0.5,
  };
  for (let i = 0; i < 600; i++) walkClear(world, w, -dirX * 0.08, -dirZ * 0.08, 0.46);
  const through = inside(w.x, w.y, w.z, 0.46);
  say('after 600 steps straight at it, inside the wall:', through, through ? 'FAIL' : 'PASS');
}

// --- 3. townsfolk wander without clipping ----------------------------------
const folk = new Townsfolk(12, { world, rand: mulberry(7) });
for (let i = 0; i < 10; i++) {
  const x = town.x - 12 + i * 2.5;
  const z = town.z + (i % 2 ? 2 : -2);
  folk.add({
    x, y: world.surfaceHeight(Math.floor(x), Math.floor(z)), z,
    wander: { x0: town.x - 20, z0: town.z - 8, x1: town.x + 20, z1: town.z + 8 },
  });
}
// Townsfolk keeps its people private, so this is a smoke run: it proves the
// wiring is live and survives a long session. What their movement actually
// does about walls is tests 1 and 2 above -- that is the same walkClear call
// they make, at the same radius.
for (let t = 0; t < 4000; t++) folk.update(1 / 60, town.x, town.y + 2, town.z);
say('town ran 4000 frames, boxes drawn:', folk.mesh.count, folk.mesh.count > 0 ? 'PASS' : 'FAIL');

// --- 4. the buffalo ---------------------------------------------------------
const ox = new Ox({
  x: town.x - 18, y: world.surfaceHeight(Math.floor(town.x - 18), Math.floor(town.z + 3)),
  z: town.z + 3,
  pasture: { x0: town.x - 23, z0: town.z - 6, x1: town.x - 13, z1: town.z + 6 },
  world, rand: mulberry(11),
});
say('ox alive at rest:', ox.alive === true ? 'PASS' : 'FAIL');

// A ray straight down the animal's length from in front of its nose.
const shotFrom = { x: ox.bodyX, y: ox.bodyY + 1.4, z: ox.bodyZ + 14 };
const hit = ox.raycast(shotFrom.x, shotFrom.y, shotFrom.z, 0, 0, -1, 40);
say('ray at the buffalo hits:', hit !== null ? `yes, at ${hit.distance.toFixed(2)}` : 'no',
  hit !== null ? 'PASS' : 'FAIL');

// A ray well off to the side must miss.
const miss = ox.raycast(shotFrom.x + 6, shotFrom.y, shotFrom.z, 0, 0, -1, 40);
say('ray six blocks wide misses:', miss === null ? 'PASS' : 'FAIL');

// Rifle rounds until it goes down.
let rounds = 0;
let died = false;
while (!died && rounds < 200) {
  rounds++;
  died = ox.hit(35, shotFrom.x, shotFrom.z);
  ox.update(1 / 60);
}
say(`took ${rounds} rifle rounds to kill`, died ? 'PASS' : 'FAIL');
say('dead ox reports alive:', ox.alive, ox.alive === false ? 'PASS' : 'FAIL');
say('dead ox is no longer shootable:',
  ox.raycast(shotFrom.x, shotFrom.y, shotFrom.z, 0, 0, -1, 40) === null ? 'PASS' : 'FAIL');
say('a second killing blow is not a kill:',
  ox.hit(999, 0, 0) === false ? 'PASS' : 'FAIL');

for (let i = 0; i < 200; i++) ox.update(1 / 60);
ox.respawn();
say('respawn puts it back up:', ox.alive === true ? 'PASS' : 'FAIL');

// It must not walk out of the world or into the huts while panicking.
let oxBad = 0;
for (let t = 0; t < 6000; t++) {
  if (t % 900 === 0) ox.alarm(ox.bodyX, ox.bodyZ, 50);
  ox.update(1 / 60);
  if (inside(ox.bodyX, ox.bodyY, ox.bodyZ, 0.75)) oxBad++;
}
say('ox-frames spent inside a block:', oxBad, oxBad === 0 ? 'PASS' : 'FAIL');

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
