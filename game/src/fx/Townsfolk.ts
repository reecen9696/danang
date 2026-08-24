import * as THREE from 'three';

/**
 * The people in the village.
 *
 * The merchants used to be a coloured box with a smaller box on top of it,
 * which is fine as a marker and no good at all as a person: you walk up to buy
 * a rifle off something that reads as a traffic cone. These are built the same
 * way the farmers in the paddy are -- a stack of boxes on a small rig, one
 * InstancedMesh for the lot of them -- so they have legs, hands, a face and a
 * nón lá, they shift their weight, and they turn their head to look at you when
 * you come up to the counter. That last part is most of it. Nothing else on the
 * map acknowledges the player at all.
 *
 * They are scenery in the sense the farmers in the paddy are: no collision and
 * no server state, but not inert either. A round that goes through the market
 * kills the person it finds, and one that goes anywhere near it empties the
 * street -- the villagers drop what they are carrying and run for the edge of
 * the map, and the ones with a voice are heard doing it. Between waves they
 * come back, because they live here.
 *
 * The merchants are the exception, and deliberately: they are the shop, not
 * scenery, so rounds pass through them and a panic does not move them off
 * their counters. Everything else in the village can be killed.
 */

/**
 * Boxes drawn per person. The pose builder must stay under this: the most
 * anyone costs is the body, a hat, and a shoulder pole with a basket slung on
 * a cord at each end of it.
 */
const PARTS = 28;

/** Blocks/sec. An unhurried walk across a market square. */
const WALK_SPEED = 1.5;
/** Blocks/sec once the shooting starts. A market street is not a paddy: there
 * are walls to get behind and they are all close, so this is a bolt rather
 * than the long open run the field turns into. */
const RUN_SPEED = 5.6;
/** Radians of leg swing per block covered, for a full-size pair of legs. */
const STRIDE = 2.4;
/** How far away someone will look up at the player. */
const NOTICE_RANGE = 11;
/** Radians the neck will turn before the body has to come round with it. */
const NECK_LIMIT = 1.15;

/**
 * How much a body can take -- the same as a farmer's, and for the same reason:
 * one rifle round through the chest, two from an SMG. Nobody in the village is
 * wearing anything, and the street should never read as a place where shooting
 * people is cheap.
 */
const VILLAGER_HP = 30;
/** Seconds a body takes to go down. */
const FALL_TIME = 0.55;
/** A panicked run gives up and goes to ground after this long, wherever it is. */
const FLEE_TIMEOUT = 14;
/** How far from where they live someone has to get before they are out of it. */
const ESCAPE_DIST = 55;
/**
 * Fraction of the village with a voice. The rest run without a sound, which is
 * what keeps the ones who do scream from reading as a stock panic loop.
 */
const SCREAM_FRACTION = 0.5;
/** Seconds between one person's cries, give or take another of the same. */
const SCREAM_GAP = 3.2;

/** Dark indigo, black and faded brown -- what áo bà ba actually comes in. */
const SHIRTS = [0x2b2f38, 0x1a1c20, 0x3b3a30, 0x4a4436, 0x2a3038, 0x584f3e];
const TROUSERS = [0x1c1e23, 0x24262c, 0x15171b, 0x2f3038];
const SKIN = [0xc9a077, 0xb98f68, 0xd0a97f, 0xa8815d];
const STRAW = [0xd9c184, 0xd2b678, 0xc9aa6b, 0xe0cb95, 0xbf9f5e];
const HAIR = 0x1b1512;
const EYE = 0x14110e;
const SANDAL = 0x3a2b20;
const BASKET = 0xb9975a;
const POLE = 0x8a6a44;

const enum Pose {
  /** Stood about: weight shifting from one foot to the other. */
  Idle = 0,
  /** Walking between two places in the village. */
  Walk = 1,
  /** Behind a counter, hands on it. */
  Counter = 2,
  /** Running, hands up, away from whatever just went off. */
  Flee = 3,
  /** Hit. Folding over and going down, and then lying where it landed. */
  Down = 4,
}

/** What someone is carrying. */
export const enum Carry {
  None = 0,
  /** Đòn gánh: a springy pole across one shoulder with a basket on each end. */
  Pole = 1,
  /** A basket on the hip. */
  Basket = 2,
}

/** Which chain of joints carries a box. */
const enum Rig {
  Body = 0,
  Head = 1,
  ArmL = 2,
  ArmR = 3,
  LegL = 4,
  LegR = 5,
}

/** x, y, z, sx, sy, sz, colour, rig. */
type Part = readonly [number, number, number, number, number, number, number, Rig];

const tmpMatrix = new THREE.Matrix4();
const tmpQuat = new THREE.Quaternion();
const tmpPos = new THREE.Vector3();
const tmpScale = new THREE.Vector3();
const tmpColor = new THREE.Color();
const yawQuat = new THREE.Quaternion();
const partQuat = new THREE.Quaternion();
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);

function shade(hex: number, f: number): number {
  const r = Math.min(255, Math.round(((hex >> 16) & 0xff) * f));
  const g = Math.min(255, Math.round(((hex >> 8) & 0xff) * f));
  const b = Math.min(255, Math.round((hex & 0xff) * f));
  return (r << 16) | (g << 8) | b;
}

function shortestAngle(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Where someone can walk, in world blocks. Villagers stay inside it. */
export interface WanderBox {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export interface PersonSpec {
  x: number;
  y: number;
  z: number;
  /** Which way they face when they have no reason to face anywhere else. */
  yaw?: number;
  /** Overrides the random shirt -- the merchants are colour-coded by trade. */
  shirt?: number;
  /** 1 is an adult; children are drawn at 0.55. */
  scale?: number;
  hat?: boolean;
  pose?: 'stand' | 'counter';
  carry?: Carry;
  /** Set to let them walk about; omitted, they stay put. */
  wander?: WanderBox;
  /**
   * Whether rounds and blasts touch them at all. Defaults to true -- the only
   * people it is turned off for are the merchants, who are a shop counter with
   * a face on it rather than someone living here.
   */
  killable?: boolean;
}

class Person {
  x = 0;
  y = 0;
  z = 0;
  yaw = 0;
  /** The direction they hold when nothing has their attention. */
  homeYaw = 0;
  desiredYaw = 0;
  /** Neck angle relative to the body, eased toward whatever they're watching. */
  neck = 0;
  nod = 0;

  pose = Pose.Idle;
  basePose = Pose.Idle;
  timer = 0;
  targetX = 0;
  targetZ = 0;
  wander: WanderBox | null = null;

  walkPhase = 0;
  /** Runs at the person's own rate, so a crowd never breathes in lockstep. */
  clock = 0;
  breathRate = 1;
  /** Weight on one foot or the other, -1..1. */
  sway = 0;

  scale = 1;
  shirt = 0;
  trousers = 0;
  skin = 0;
  straw = 0;
  hat = true;
  carry = Carry.None;
  speedMul = 1;

  /** Where they were put, so the next morning can put them back there. */
  homeX = 0;
  homeZ = 0;
  /** Which way they were facing when they were put there. */
  spawnYaw = 0;

  /** Merchants are furniture: rounds go through them and panics go past them. */
  killable = true;
  /** What is left of them. At or below zero they go down. */
  hp = VILLAGER_HP;
  /** 0 upright, 1 flat on the ground. Drives the whole-body fold on death. */
  fall = 0;
  /** Made it out of the village, or a body left long enough. Not drawn. */
  gone = false;
  /**
   * This one screams. Rolled per person rather than per size, so half of the
   * adults and half of the children are the ones you hear.
   */
  screams = false;
  /** Seconds until they could cry out again. One voice, not a siren. */
  screamCd = 0;

  /**
   * Drop everything and run, directly away from whatever just went off. The
   * direction is taken from the noise rather than from the street, so nobody
   * ever bolts towards the muzzle that scared them.
   */
  flee(fromX: number, fromZ: number, rand: () => number): void {
    let dx = this.x - fromX;
    let dz = this.z - fromZ;
    const d = Math.hypot(dx, dz);
    if (d < 0.001) {
      const a = rand() * Math.PI * 2;
      dx = Math.sin(a);
      dz = Math.cos(a);
    } else {
      dx /= d;
      dz /= d;
    }
    // A crowd running from one bang does not run as one body: everyone breaks
    // at their own angle, which is what makes it read as panic.
    const jitter = (rand() - 0.5) * 1.1;
    const jx = dx * Math.cos(jitter) - dz * Math.sin(jitter);
    const jz = dx * Math.sin(jitter) + dz * Math.cos(jitter);
    this.pose = Pose.Flee;
    this.timer = FLEE_TIMEOUT;
    this.targetX = this.x + jx * 90;
    this.targetZ = this.z + jz * 90;
    this.desiredYaw = Math.atan2(jx, jz);
    // The first thing that happens is the head coming up, so the yaw snaps
    // rather than easing, and the neck lets go of whatever it was watching.
    this.yaw = this.desiredYaw;
    this.neck = 0;
    this.nod = 0;
  }

  /** Takes a round. Returns true if that was the one that killed them. */
  hit(damage: number, fromX: number, fromZ: number, rand: () => number): boolean {
    if (!this.killable || this.pose === Pose.Down || this.gone) return false;
    this.hp -= damage;
    if (this.hp > 0) {
      this.flee(fromX, fromZ, rand);
      return false;
    }
    this.pose = Pose.Down;
    this.fall = 0;
    this.timer = 0;
    return true;
  }

  /** Far enough from where they live to be out of the picture. */
  clearOfTown(): boolean {
    const dx = this.x - this.homeX;
    const dz = this.z - this.homeZ;
    return dx * dx + dz * dz > ESCAPE_DIST * ESCAPE_DIST;
  }
}

/** What a bullet found in the village. */
export interface TownsfolkHit {
  /** Opaque to callers: hand it straight back to {@link Townsfolk.hit}. */
  person: Person;
  distance: number;
  /** The round went in above the shoulders. */
  head: boolean;
  /** Body scale, so a caller can size the blood to the person. */
  scale: number;
}

/** Where one of them went down, for the blood that gets left behind. */
export interface TownsfolkDown {
  x: number;
  y: number;
  z: number;
  scale: number;
}

export interface TownsfolkOptions {
  rand?: () => number;
  /**
   * One of them has cried out, at their chest. `child` is the body scale rather
   * than anything the simulation knows: it is there so the caller can pick a
   * voice that belongs to the person who was shot at.
   */
  onScream?: (x: number, y: number, z: number, child: boolean) => void;
}

export class Townsfolk {
  readonly mesh: THREE.InstancedMesh;
  private readonly people: Person[] = [];
  private readonly rand: () => number;
  private readonly onScream:
    ((x: number, y: number, z: number, child: boolean) => void) | undefined;
  private capacity = 0;

  constructor(capacity = 16, opts: TownsfolkOptions = {}) {
    this.rand = opts.rand ?? Math.random;
    this.onScream = opts.onScream;
    this.capacity = capacity;

    const geom = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshLambertMaterial({ fog: true });
    this.mesh = new THREE.InstancedMesh(geom, mat, capacity * PARTS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;

    const colors = new Float32Array(capacity * PARTS * 3);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  }

  /** Puts one more person in the village. Ignored past the capacity. */
  add(spec: PersonSpec): void {
    if (this.people.length >= this.capacity) return;
    const rand = this.rand;
    const p = new Person();
    p.x = spec.x;
    p.y = spec.y;
    p.z = spec.z;
    p.yaw = p.homeYaw = p.desiredYaw = spec.yaw ?? rand() * Math.PI * 2;
    p.scale = spec.scale ?? 1;
    p.shirt = spec.shirt ?? SHIRTS[Math.floor(rand() * SHIRTS.length)];
    p.trousers = TROUSERS[Math.floor(rand() * TROUSERS.length)];
    p.skin = SKIN[Math.floor(rand() * SKIN.length)];
    p.straw = STRAW[Math.floor(rand() * STRAW.length)];
    p.hat = spec.hat ?? true;
    p.carry = spec.carry ?? Carry.None;
    p.speedMul = 0.85 + rand() * 0.3;
    p.breathRate = 0.8 + rand() * 0.5;
    p.clock = rand() * 100;
    p.basePose = spec.pose === 'counter' ? Pose.Counter : Pose.Idle;
    p.pose = p.basePose;
    p.wander = spec.wander ?? null;
    p.timer = 1 + rand() * 6;
    p.homeX = spec.x;
    p.homeZ = spec.z;
    p.spawnYaw = p.yaw;
    p.killable = spec.killable ?? true;
    p.screams = p.killable && rand() < SCREAM_FRACTION;
    this.people.push(p);
  }

  /**
   * Advances everyone and redraws.
   *
   * The player position is what the heads track. It is passed in rather than
   * held, because during the title-screen orbit there is no player yet and the
   * village still has to look alive.
   */
  update(dt: number, px: number, py: number, pz: number): void {
    const rand = this.rand;
    for (const p of this.people) {
      if (p.gone) continue;
      p.clock += dt;
      p.timer -= dt;
      p.screamCd -= dt;

      if (p.pose === Pose.Down) {
        p.fall = Math.min(1, p.fall + dt / FALL_TIME);
        // A body does not watch anybody. Whatever the head was doing when the
        // round arrived unwinds as it goes over.
        p.neck += (0 - p.neck) * Math.min(1, dt * 4);
        p.nod += (0 - p.nod) * Math.min(1, dt * 3);
        continue;
      }

      if (p.pose === Pose.Flee) {
        // Panic is not one shout at the moment of the bang: someone running
        // the length of the street keeps going the whole way, which is the
        // half of it you hear long after the round has gone.
        this.cry(p);
        const dx = p.targetX - p.x;
        const dz = p.targetZ - p.z;
        const dist = Math.hypot(dx, dz);
        p.desiredYaw = Math.atan2(dx, dz);
        const move = Math.min(dist, RUN_SPEED * p.speedMul * dt);
        p.x += (dx / dist || 0) * move;
        p.z += (dz / dist || 0) * move;
        // Running legs go over faster than walking ones for the same ground.
        p.walkPhase += (move * STRIDE * 1.25) / p.scale;
        p.yaw += shortestAngle(p.yaw, p.desiredYaw) * Math.min(1, dt * 5);
        p.sway += (0 - p.sway) * Math.min(1, dt * 4);
        // Once they are off the shelf they are somebody else's problem, and
        // the street stays empty until the next morning puts them back.
        if (dist < 0.5 || p.timer <= 0 || p.clearOfTown()) p.gone = true;
        continue;
      }

      if (p.pose === Pose.Walk) {
        const dx = p.targetX - p.x;
        const dz = p.targetZ - p.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.4 || p.timer <= 0) {
          p.pose = p.basePose;
          p.timer = 3 + rand() * 9;
          p.homeYaw = p.yaw;
        } else {
          p.desiredYaw = Math.atan2(dx, dz);
          const move = Math.min(dist, WALK_SPEED * p.speedMul * dt);
          p.x += (dx / dist) * move;
          p.z += (dz / dist) * move;
          p.walkPhase += (move * STRIDE) / p.scale;
        }
      } else if (p.timer <= 0) {
        if (p.wander) {
          const w = p.wander;
          p.targetX = w.x0 + rand() * (w.x1 - w.x0);
          p.targetZ = w.z0 + rand() * (w.z1 - w.z0);
          p.pose = Pose.Walk;
          p.timer = 20;
        } else {
          // Stood still: turn to look at something else for a while.
          p.homeYaw += (rand() - 0.5) * 0.9;
          p.timer = 4 + rand() * 8;
        }
        p.walkPhase = 0;
      }

      // Attention. Anyone within earshot watches the player go past, up to the
      // point where they would have to turn their body, and merchants keep
      // watching a little further out than everyone else.
      const dxp = px - p.x;
      const dzp = pz - p.z;
      const range = p.basePose === Pose.Counter ? NOTICE_RANGE + 4 : NOTICE_RANGE;
      const near = dxp * dxp + dzp * dzp < range * range;
      let bodyYaw = p.pose === Pose.Walk ? p.desiredYaw : p.homeYaw;
      let wantNeck = 0;
      let wantNod = 0;
      if (near && p.pose !== Pose.Walk) {
        const toPlayer = Math.atan2(dxp, dzp);
        const off = shortestAngle(bodyYaw, toPlayer);
        wantNeck = Math.max(-NECK_LIMIT, Math.min(NECK_LIMIT, off));
        // The player is a head taller than most of the village and standing
        // close; the chin comes up rather than the eyes going through them.
        const flat = Math.max(0.7, Math.hypot(dxp, dzp));
        wantNod = Math.max(-0.5, Math.min(0.45, (py + 0.6 - (p.y + 2.1 * p.scale)) / flat));
        // Too far round to follow with the neck alone: the merchant squares up.
        if (p.basePose === Pose.Counter && Math.abs(off) > NECK_LIMIT) {
          bodyYaw = toPlayer - Math.sign(off) * NECK_LIMIT;
        }
      }
      p.neck += (wantNeck - p.neck) * Math.min(1, dt * 4);
      p.nod += (wantNod - p.nod) * Math.min(1, dt * 3);

      p.desiredYaw = bodyYaw;
      p.yaw += shortestAngle(p.yaw, p.desiredYaw) * Math.min(1, dt * 5);

      // Weight shifts from foot to foot when stood still. It is a small thing
      // and it is the difference between a person and a mannequin.
      const target = p.pose === Pose.Walk ? 0 : Math.sin(p.clock * 0.55 * p.breathRate);
      p.sway += (target - p.sway) * Math.min(1, dt * 2);
    }

    this.draw();
  }

  /**
   * Puts the village back on the street: everyone alive again, at the door
   * they came out of, facing the way they were facing. Called between waves,
   * the way the paddy refills -- the field still has to be worked and the
   * market still has to open, whatever happened in them last night.
   */
  respawn(): void {
    for (const p of this.people) {
      if (!p.killable) continue;
      p.x = p.homeX;
      p.z = p.homeZ;
      p.yaw = p.homeYaw = p.desiredYaw = p.spawnYaw;
      p.hp = VILLAGER_HP;
      p.fall = 0;
      p.gone = false;
      p.neck = 0;
      p.nod = 0;
      p.walkPhase = 0;
      p.screamCd = 0;
      p.pose = p.basePose;
      p.timer = 1 + this.rand() * 6;
    }
  }

  /**
   * Something loud happened at `x, z`. Everyone inside `radius` runs.
   *
   * A flat radius rather than a line of sight test, for the same reason the
   * field uses one: the crack of a round going past is the thing that moves a
   * street of people, and they do not have to see where it came from.
   *
   * Returns how many were actually put to flight by this one.
   */
  alarm(x: number, z: number, radius: number): number {
    const r2 = radius * radius;
    let startled = 0;
    for (const p of this.people) {
      if (!p.killable || p.gone || p.pose === Pose.Down) continue;
      const dx = p.x - x;
      const dz = p.z - z;
      if (dx * dx + dz * dz > r2) continue;
      // Already running, and still running away from this one: leave them to
      // it rather than restarting the panic every shot.
      if (p.pose === Pose.Flee && p.timer > FLEE_TIMEOUT - 1.2) continue;
      p.flee(x, z, this.rand);
      this.cry(p);
      startled++;
    }
    return startled;
  }

  /**
   * Nearest villager along a ray, for a bullet that might be about to hit one.
   *
   * The body is a box rather than anything cleverer. At the range the market
   * gets shot up at -- which is across a street -- the difference between that
   * and a real hull is a few pixels, and the box is the one that is free.
   */
  raycast(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDist: number,
  ): TownsfolkHit | null {
    let best: Person | null = null;
    let bestT = maxDist;
    let bestY = 0;

    for (const p of this.people) {
      if (!p.killable || p.gone || p.pose === Pose.Down) continue;
      const r = 0.46 * p.scale;
      const h = 2.45 * p.scale;

      let t0 = 0;
      let t1 = bestT;
      const slab = (o: number, d: number, lo: number, hi: number): boolean => {
        if (Math.abs(d) < 1e-8) return o >= lo && o <= hi;
        const inv = 1 / d;
        let a = (lo - o) * inv;
        let b = (hi - o) * inv;
        if (a > b) { const t = a; a = b; b = t; }
        if (a > t0) t0 = a;
        if (b < t1) t1 = b;
        return t0 <= t1;
      };

      if (!slab(ox, dx, p.x - r, p.x + r)) continue;
      if (!slab(oy, dy, p.y, p.y + h)) continue;
      if (!slab(oz, dz, p.z - r, p.z + r)) continue;
      if (t0 < 0 || t0 >= bestT) continue;

      best = p;
      bestT = t0;
      bestY = oy + dy * t0;
    }

    if (!best) return null;
    const head = bestY > best.y + 2.45 * best.scale * 0.78;
    return { person: best, distance: bestT, head, scale: best.scale };
  }

  /**
   * Resolves a round on one of them.
   *
   * A hit in the head is fatal whatever the round was, which keeps a rifle
   * from ever needing a second one; anything else runs through the same hit
   * points a rifle chest shot is sized against.
   */
  hit(target: TownsfolkHit, damage: number, fromX: number, fromZ: number): boolean {
    const p = target.person;
    const killed = p.hit(target.head ? VILLAGER_HP * 4 : damage, fromX, fromZ, this.rand);
    // The one who was hit is already running by the time the alarm goes out,
    // so alarm() leaves them alone -- their own cry has to come from here. A
    // kill is silent on this channel: the caller has a death for that.
    if (!killed) this.cry(p);
    // A body going down in the middle of the market empties the rest of it.
    this.alarm(p.x, p.z, killed ? 34 : 22);
    return killed;
  }

  /**
   * A blast in or near the village.
   *
   * Everyone inside the radius takes it with a linear falloff, and everyone
   * well outside it runs anyway. Returns where the dead went down, so the
   * caller can put blood on the ground for them.
   */
  blast(x: number, y: number, z: number, radius: number, damage: number): TownsfolkDown[] {
    const down: TownsfolkDown[] = [];
    for (const p of this.people) {
      if (!p.killable || p.gone || p.pose === Pose.Down) continue;
      const dx = p.x - x;
      const dy = p.y + 1 - y;
      const dz = p.z - z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist >= radius) continue;
      if (p.hit(Math.round(damage * (1 - dist / radius)), x, z, this.rand)) {
        down.push({ x: p.x, y: p.y, z: p.z, scale: p.scale });
      } else {
        this.cry(p);
      }
    }
    // The bang carries a great deal further than the fragments do.
    this.alarm(x, z, radius * 3 + 20);
    return down;
  }

  /** Someone still on their feet out there, for anything that wants to know. */
  get livingCount(): number {
    let n = 0;
    for (const p of this.people) {
      if (p.killable && !p.gone && p.pose !== Pose.Down) n++;
    }
    return n;
  }

  /**
   * One of them cries out, if they are one of the ones with a voice and have
   * not just used it.
   *
   * The cooldown is what keeps a street under sustained fire from turning into
   * a wall of screaming: each person is a voice that goes off, is spent for a
   * few seconds, and comes back while they are still running.
   */
  private cry(p: Person): void {
    if (!this.onScream || !p.screams || p.screamCd > 0) return;
    if (p.gone || p.pose === Pose.Down) return;
    p.screamCd = SCREAM_GAP * (0.7 + this.rand() * 0.8);
    this.onScream(p.x, p.y + 1.4 * p.scale, p.z, p.scale < 0.7);
  }

  private draw(): void {
    const colorAttr = this.mesh.instanceColor!;
    let n = 0;

    for (const p of this.people) {
      if (p.gone) continue;
      const s = p.scale;
      const running = p.pose === Pose.Flee;
      const down = p.pose === Pose.Down;
      const walking = p.pose === Pose.Walk || running;
      const counter = p.pose === Pose.Counter;

      // A run is the same gait opened right up.
      const swing = walking ? Math.sin(p.walkPhase) * (running ? 0.95 : 0.6) : 0;
      const breath = Math.sin(p.clock * 1.6 * p.breathRate) * 0.012 * s;
      const bob = (walking ? (Math.abs(Math.sin(p.walkPhase)) - 0.5) * (running ? 0.1 : 0.06) * s : 0)
        + breath - Math.abs(p.sway) * 0.02 * s;
      const lean = p.sway * 0.05 * s;

      const hipY = 0.86 * s;
      const legY = 0.43 * s;
      const legSpread = 0.19 * s;
      const torsoY = 1.34 * s + bob;
      const shoulderY = 1.74 * s + bob;
      const neckY = 1.9 * s + bob;
      const headY = 2.14 * s + bob;
      const brimY = 2.32 * s + bob;
      const hatT = 0.085 * s;

      // Shoulders: hands on the counter, swinging with the walk, or hanging.
      // Hands over the head, not pumping: this is a street of people running
      // out of a firefight, and that silhouette says so from across the square.
      const armBase = running ? -2.5 - Math.sin(p.clock * 9) * 0.18
        : counter ? -1.0 : walking ? swing * 0.55 : -0.06 + p.sway * 0.05;
      const armL = running || counter ? armBase : walking ? -swing * 0.55 : armBase;
      const armR = running || counter ? armBase : walking ? swing * 0.55 : armBase - p.sway * 0.1;
      const armLen = 0.86 * s;
      // Where each hand ends up, for the box that stands in for it.
      const handY = (a: number): number => shoulderY - armLen * Math.cos(a);
      const handZ = (a: number): number => -armLen * Math.sin(a);

      const sleeve = shade(p.shirt, 0.9);
      const strawMid = shade(p.straw, 0.94);
      const strawTip = shade(p.straw, 0.86);

      const parts: Part[] = [
        // Legs, feet first so a bare foot reads against the trouser.
        [-legSpread, legY, 0, 0.24 * s, 0.86 * s, 0.34 * s, p.trousers, Rig.LegL],
        [legSpread, legY, 0, 0.24 * s, 0.86 * s, 0.34 * s, p.trousers, Rig.LegR],
        [-legSpread, 0.05 * s, 0.05 * s, 0.26 * s, 0.1 * s, 0.44 * s, SANDAL, Rig.LegL],
        [legSpread, 0.05 * s, 0.05 * s, 0.26 * s, 0.1 * s, 0.44 * s, SANDAL, Rig.LegR],
        // Body.
        [lean, torsoY, 0, 0.76 * s, 1.0 * s, 0.5 * s, p.shirt, Rig.Body],
        [lean, 0.99 * s + bob, 0, 0.8 * s, 0.16 * s, 0.54 * s, shade(p.shirt, 0.66), Rig.Body],
        // Collar, so the shirt has a top to it under the chin.
        [lean, 1.8 * s + bob, 0, 0.72 * s, 0.14 * s, 0.48 * s, shade(p.shirt, 1.12), Rig.Body],
        // Arms and hands.
        [-0.49 * s + lean, shoulderY - 0.43 * s, 0, 0.23 * s, 0.88 * s, 0.32 * s, sleeve, Rig.ArmL],
        [0.49 * s + lean, shoulderY - 0.43 * s, 0, 0.23 * s, 0.88 * s, 0.32 * s, sleeve, Rig.ArmR],
        [-0.49 * s + lean, handY(armL), handZ(armL), 0.24 * s, 0.22 * s, 0.26 * s, p.skin, Rig.Body],
        [0.49 * s + lean, handY(armR), handZ(armR), 0.24 * s, 0.22 * s, 0.26 * s, p.skin, Rig.Body],
        // Head.
        [0, neckY, 0, 0.24 * s, 0.18 * s, 0.24 * s, shade(p.skin, 0.86), Rig.Body],
        [0, headY, 0, 0.56 * s, 0.56 * s, 0.56 * s, p.skin, Rig.Head],
        [0, headY + 0.24 * s, -0.04 * s, 0.58 * s, 0.14 * s, 0.5 * s, HAIR, Rig.Head],
        [0, headY + 0.06 * s, -0.28 * s, 0.5 * s, 0.36 * s, 0.06 * s, HAIR, Rig.Head],
        [-0.135 * s, headY + 0.05 * s, 0.285 * s, 0.16 * s, 0.06 * s, 0.02 * s, EYE, Rig.Head],
        [0.135 * s, headY + 0.05 * s, 0.285 * s, 0.16 * s, 0.06 * s, 0.02 * s, EYE, Rig.Head],
        [0, headY - 0.16 * s, 0.29 * s, 0.1 * s, 0.05 * s, 0.02 * s, shade(p.skin, 0.7), Rig.Head],
      ];

      // Nón lá: each ring is two crossed slabs, because an octagon reads as the
      // round hat it is where a single box reads as a board.
      if (p.hat) {
        parts.push(
          [0, brimY, 0, 1.16 * s, hatT, 0.78 * s, p.straw, Rig.Head],
          [0, brimY, 0, 0.78 * s, hatT, 1.16 * s, p.straw, Rig.Head],
          [0, brimY + 0.1 * s, 0, 0.5 * s, hatT, 0.34 * s, strawMid, Rig.Head],
          [0, brimY + 0.1 * s, 0, 0.34 * s, hatT, 0.5 * s, strawMid, Rig.Head],
          [0, brimY + 0.19 * s, 0, 0.16 * s, 0.1 * s, 0.16 * s, strawTip, Rig.Head],
        );
      }

      // The pole goes down in the road the moment they run, and stays where it
      // fell once they are hit -- nobody carries a hundredweight of rice out of
      // a firefight. It is simply not drawn; the load is scenery either way.
      const carry = running || down ? Carry.None : p.carry;

      if (carry === Carry.Pole) {
        // Across one shoulder and clear of the head, with the loads swinging
        // well below the ends of it. Carried fore-and-aft, which is how you
        // get a loaded pole down a path with people on it.
        const poleY = shoulderY + 0.08 * s;
        const poleX = -0.3 * s;
        const drop = 0.62 * s;
        parts.push(
          [poleX, poleY, 0, 0.1 * s, 0.1 * s, 3.4 * s, POLE, Rig.Body],
          [poleX, poleY - drop * 0.5, -1.5 * s, 0.05 * s, drop, 0.05 * s, POLE, Rig.Body],
          [poleX, poleY - drop * 0.5, 1.5 * s, 0.05 * s, drop, 0.05 * s, POLE, Rig.Body],
          [poleX, poleY - drop - 0.22 * s, -1.5 * s, 0.64 * s, 0.46 * s, 0.64 * s, BASKET, Rig.Body],
          [poleX, poleY - drop - 0.22 * s, 1.5 * s, 0.64 * s, 0.46 * s, 0.64 * s, BASKET, Rig.Body],
        );
      } else if (carry === Carry.Basket) {
        parts.push(
          [0.62 * s, 1.15 * s + bob, 0.1 * s, 0.56 * s, 0.4 * s, 0.5 * s, BASKET, Rig.Body],
        );
      }

      yawQuat.setFromAxisAngle(AXIS_Y, p.yaw);

      // Going down folds the whole body forward about the feet, so it lands
      // face down along the line it was facing. Smoothstepped: the knees go
      // first and the rest follows, rather than the whole thing tipping like a
      // plank at a constant rate.
      const fallEase = p.fall * p.fall * (3 - 2 * p.fall);
      const fallAngle = fallEase * Math.PI * 0.5;
      const fallC = Math.cos(fallAngle);
      const fallS = Math.sin(fallAngle);
      // The fold is about the soles, so a body all the way over ends up on its
      // own centreline -- half of it below the road. Lift it by about half a
      // torso so it lies *on* the ground instead of in it.
      const fallLift = fallEase * 0.3 * s;

      const headYaw = p.yaw + p.neck;
      const headC = Math.cos(p.neck);
      const headS = Math.sin(p.neck);
      const nodC = Math.cos(p.nod);
      const nodS = Math.sin(p.nod);

      for (let i = 0; i < parts.length && n < this.mesh.instanceMatrix.count; i++) {
        const [ox, oy, oz, sx, sy, sz, col, rig] = parts[i];

        let lx = ox;
        let ly = oy;
        let lz = oz;
        let pitch = 0;
        let yaw = p.yaw;

        switch (rig) {
          case Rig.Head: {
            // Nod about the neck first, then turn the whole head on it.
            const ry = oy - neckY;
            const ny = neckY + ry * nodC - oz * nodS;
            const nz = ry * nodS + oz * nodC;
            lx = ox * headC + nz * headS;
            lz = -ox * headS + nz * headC;
            ly = ny;
            pitch = p.nod;
            yaw = headYaw;
            break;
          }
          case Rig.ArmL:
          case Rig.ArmR: {
            const a = rig === Rig.ArmL ? armL : armR;
            const c = Math.cos(a);
            const sn = Math.sin(a);
            const ry = oy - shoulderY;
            ly = shoulderY + ry * c - oz * sn;
            lz = ry * sn + oz * c;
            pitch = a;
            break;
          }
          case Rig.LegL:
          case Rig.LegR: {
            const a = rig === Rig.LegL ? swing : -swing;
            if (a !== 0) {
              const c = Math.cos(a);
              const sn = Math.sin(a);
              const ry = oy - hipY;
              ly = hipY + ry * c - oz * sn;
              lz = ry * sn + oz * c;
              pitch = a;
            }
            break;
          }
          default:
            break;
        }

        if (p.fall > 0) {
          const ry = ly;
          const rz = lz;
          ly = ry * fallC - rz * fallS + fallLift;
          lz = ry * fallS + rz * fallC;
          pitch += fallAngle;
        }

        let q: THREE.Quaternion;
        if (yaw !== p.yaw) {
          tmpQuat.setFromAxisAngle(AXIS_Y, yaw);
          q = partQuat.copy(tmpQuat);
          if (pitch !== 0) {
            tmpQuat.setFromAxisAngle(AXIS_X, pitch);
            q.multiply(tmpQuat);
          }
        } else if (pitch !== 0) {
          tmpQuat.setFromAxisAngle(AXIS_X, pitch);
          q = partQuat.copy(yawQuat).multiply(tmpQuat);
        } else {
          q = yawQuat;
        }

        tmpPos.set(lx, ly, lz).applyQuaternion(yawQuat);
        tmpPos.x += p.x;
        tmpPos.y += p.y;
        tmpPos.z += p.z;
        tmpScale.set(sx, sy, sz);
        tmpMatrix.compose(tmpPos, q, tmpScale);
        this.mesh.setMatrixAt(n, tmpMatrix);
        tmpColor.setHex(col);
        colorAttr.setXYZ(n, tmpColor.r, tmpColor.g, tmpColor.b);
        n++;
      }
    }

    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    colorAttr.needsUpdate = true;
  }
}
