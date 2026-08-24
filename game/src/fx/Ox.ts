import * as THREE from 'three';
import type { VoxelWorld } from '../voxel/VoxelWorld';
import { walkClear } from './walk';

/**
 * The village buffalo.
 *
 * Con trâu -- the water buffalo, not an ox in the European sense. It is the
 * single most valuable thing a household here owns, worth more than the house
 * it stands next to, and it spends its day doing exactly what this one does:
 * standing about on the good grass at the edge of the village with its head
 * down, moving a few metres when it has finished what is in front of it.
 *
 * It is here for the same reason the farmers in the paddy are. A village with
 * nothing alive in it but shopkeepers is a shop; a village with a buffalo
 * wandering loose at the end of the street is somewhere people live. It walks
 * slowly on purpose -- everything else on this map moves at a run, and the one
 * thing on it that has no idea there is a war on should read that way from the
 * far end of the road.
 *
 * Scenery in the sense that the server knows nothing about it, but not in the
 * sense that it is furniture: it can be shot, and shooting it is the worst
 * thing you can do to this village short of shooting the people in it. A
 * buffalo is a household's plough, its cart and its savings in one animal, and
 * a valley that finds theirs dead in the grass takes it personally.
 *
 * One InstancedMesh of boxes, one draw call.
 */

/** Boxes drawn. The pose builder must stay under this. */
const PARTS = 26;

/** Blocks/sec on the move. A buffalo's walk, which is barely a walk. */
const WALK_SPEED = 0.72;
/** Blocks/sec of shuffle while grazing -- a step every few seconds. */
const GRAZE_CREEP = 0.1;
/** Radians of leg swing per block covered. Long legs, few steps. */
const STRIDE = 1.5;
/** How fast it comes round onto a new heading. It is in no hurry. */
const TURN_RATE = 1.1;
/** Blocks/sec running from a bang. Heavy, and faster than you expect. */
const BOLT_SPEED = 5.4;
/** How long it keeps running once something has started it. */
const BOLT_TIME = 4.5;
/**
 * What it takes to put one down.
 *
 * High on purpose. A buffalo is six hundred kilos and this should never be
 * something that happens by accident to a round that went wide -- if the
 * valley is going to hold it against you, you have to have meant it.
 */
const OX_HP = 320;
/** Seconds to go over once it is dead. */
const FALL_TIME = 1.1;

/**
 * Height it rolls about when it goes down: the middle of the barrel, so the
 * body pivots onto its flank instead of pinwheeling off its hooves.
 */
const ROLL_PIVOT_Y = 1.05;

/** How far the head drops to reach the grass. */
const HEAD_DOWN = 0.92;

/**
 * Slate grey, not black. A buffalo photographs almost black in shade, but a
 * black animal in a voxel scene reads as a hole in the ground -- there is no
 * shading left to describe its shape with. These are lifted well up off the
 * true colour so the barrel, the legs and the drop of the neck stay legible
 * against the grass at the far end of a street.
 */
const HIDE = 0x6f6a62;
const HIDE_LIT = 0x7d7870;
const HIDE_DARK = 0x565149;
/** Dried mud up the flanks, which is where a buffalo spends its afternoons. */
const MUD = 0x6b5642;
const HORN = 0xb7b1a4;
const HOOF = 0x3a3630;
const MUZZLE = 0x4c453d;
const EYE = 0x14110e;

const enum Task {
  /** Head down, working over one patch. */
  Graze = 0,
  /** Moving to somewhere else worth standing. */
  Walk = 1,
  /** Head up, chewing, looking at nothing in particular. */
  Chew = 2,
  /**
   * Something went off. A buffalo panics slowly and then all at once, and when
   * it goes it goes in a straight line through whatever it was doing.
   */
  Bolt = 3,
  /** Down in the grass. */
  Dead = 4,
}

const enum Rig {
  Body = 0,
  /** Neck and head, swinging down from the withers to reach the ground. */
  Head = 1,
  LegFL = 2,
  LegFR = 3,
  LegBL = 4,
  LegBR = 5,
  Tail = 6,
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
const AXIS_Z = new THREE.Vector3(0, 0, 1);
const rollQuat = new THREE.Quaternion();
/** Reused so a step costs no allocation; the animal's own fields stay private. */
const walkScratch = { x: 0, y: 0, z: 0 };

function shortestAngle(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Where it is allowed to wander, in world blocks. */
export interface Pasture {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export interface OxOptions {
  x: number;
  /** Standing level. Follows the ground once it starts moving. */
  y: number;
  z: number;
  pasture: Pasture;
  rand?: () => number;
  /**
   * The world it stands in, so it walks round the huts rather than through
   * them. Optional so a test can raise one without a world.
   */
  world?: VoxelWorld;
}

/** Where a round found it, for the caller's blood and impact effects. */
export interface OxHit {
  distance: number;
}

export class Ox {
  readonly mesh: THREE.InstancedMesh;

  private readonly rand: () => number;
  private readonly pasture: Pasture;
  private readonly world: VoxelWorld | null;

  private x: number;
  private y: number;
  private z: number;
  /** Where it was raised, so a new run puts it back. */
  private readonly homeX: number;
  private readonly homeY: number;
  private readonly homeZ: number;

  private hp = OX_HP;
  /** 0 standing, 1 lying on its side. */
  private fall = 0;
  /** Which side it goes over on. Fixed at birth so it never flips mid-fall. */
  private fallSide = 1;
  /** Whether it has found the ground under it yet. */
  private grounded = false;
  private yaw: number;
  private desiredYaw: number;

  private task = Task.Graze;
  private timer = 0;
  private targetX = 0;
  private targetZ = 0;

  private walkPhase = 0;
  private clock = 0;
  /** 0 head up, 1 muzzle in the grass. Eased, because a neck has weight. */
  private headDown = 1;

  constructor(opts: OxOptions) {
    this.rand = opts.rand ?? Math.random;
    this.pasture = opts.pasture;
    this.world = opts.world ?? null;
    this.x = this.homeX = opts.x;
    this.y = this.homeY = opts.y;
    this.z = this.homeZ = opts.z;
    this.fallSide = this.rand() < 0.5 ? -1 : 1;
    this.yaw = this.desiredYaw = this.rand() * Math.PI * 2;
    this.clock = this.rand() * 100;
    this.timer = 4 + this.rand() * 10;

    const geom = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshLambertMaterial({ fog: true });
    this.mesh = new THREE.InstancedMesh(geom, mat, PARTS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;

    const colors = new Float32Array(PARTS * 3);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  }

  /** Still on its feet. */
  get alive(): boolean {
    return this.task !== Task.Dead;
  }

  update(dt: number): void {
    const rand = this.rand;
    this.clock += dt;
    this.timer -= dt;

    // Settle onto the actual ground the first time it runs. The caller passes
    // the town's level, which is the right block to within a step but not
    // necessarily the one under its hooves.
    if (!this.grounded) {
      this.grounded = true;
      this.step(0, 0);
    }

    if (this.task === Task.Dead) {
      this.fall = Math.min(1, this.fall + dt / FALL_TIME);
      // The head goes with the body rather than staying in the grass.
      this.headDown += (0.35 - this.headDown) * Math.min(1, dt * 2.5);
      this.draw();
      return;
    }

    switch (this.task) {
      case Task.Walk: {
        const dx = this.targetX - this.x;
        const dz = this.targetZ - this.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.6 || this.timer <= 0) {
          this.task = Task.Graze;
          this.timer = 12 + rand() * 20;
          break;
        }
        this.desiredYaw = Math.atan2(dx, dz);
        // It will not walk sideways: the head comes round first, then the body
        // follows, which is most of what makes a big animal read as heavy.
        const facing = Math.max(0, Math.cos(shortestAngle(this.yaw, this.desiredYaw)));
        const move = Math.min(dist, WALK_SPEED * facing * dt);
        // Walked into something: pick somewhere else rather than lean on it.
        if (!this.step((dx / dist) * move, (dz / dist) * move)) this.timer = 0;
        this.walkPhase += move * STRIDE;
        this.headDown += (0.25 - this.headDown) * Math.min(1, dt * 1.5);
        break;
      }

      case Task.Graze: {
        // Creeping down a patch, a mouthful at a time.
        const move = GRAZE_CREEP * dt;
        this.step(Math.sin(this.yaw) * move, Math.cos(this.yaw) * move);
        this.walkPhase += move * STRIDE;
        this.headDown += (1 - this.headDown) * Math.min(1, dt * 1.2);
        if (this.timer <= 0) {
          this.task = Task.Chew;
          this.timer = 5 + rand() * 9;
        }
        break;
      }

      case Task.Bolt: {
        // Head up and straight on. It does not pick its way round anything at
        // this speed; whatever it meets, it meets.
        const move = BOLT_SPEED * dt;
        const ran = this.step(Math.sin(this.yaw) * move, Math.cos(this.yaw) * move);
        this.walkPhase += move * STRIDE;
        this.headDown += (0 - this.headDown) * Math.min(1, dt * 6);
        // Stopped by something, or run far enough: it stands and blows, then
        // goes back to the only thing it knows how to do.
        if (!ran || this.timer <= 0) {
          this.task = Task.Chew;
          this.timer = 6 + rand() * 8;
        }
        break;
      }

      case Task.Chew: {
        this.headDown += (0.1 - this.headDown) * Math.min(1, dt * 1.5);
        if (this.timer <= 0) {
          if (rand() < 0.55) {
            this.beginWalk();
          } else {
            // Not worth moving for. Turn a little and start again.
            this.desiredYaw = this.yaw + (rand() - 0.5) * 1.6;
            this.task = Task.Graze;
            this.timer = 12 + rand() * 20;
          }
        }
        break;
      }
    }

    // Stay on the grass it is allowed to be on -- by walking back onto it,
    // never by being snapped back onto it. Clamping the position was fine
    // while nothing could stop the animal moving; now that a wall can, the
    // clamp would be the one thing on the map still able to put it inside a
    // hut. An animal running for its life is not consulting the fence either,
    // so the pasture only steers it while it is calm.
    if (this.task !== Task.Bolt) {
      const p = this.pasture;
      if (this.task !== Task.Walk
        && (this.x < p.x0 || this.x > p.x1 || this.z < p.z0 || this.z > p.z1)) {
        this.beginWalk();
      }
    }

    // Bolting, the head goes where the body is already going.
    const turnRate = this.task === Task.Bolt ? TURN_RATE * 4 : TURN_RATE;
    this.yaw += shortestAngle(this.yaw, this.desiredYaw) * Math.min(1, dt * turnRate);
    this.draw();
  }

  /**
   * One step, through whatever is in the way. Returns whether it moved.
   *
   * With no world wired up it moves freely, which is what a bare `new Ox()` in
   * a test wants.
   */
  private step(stepX: number, stepZ: number): boolean {
    if (this.world === null) {
      this.x += stepX;
      this.z += stepZ;
      return true;
    }
    walkScratch.x = this.x;
    walkScratch.y = this.y;
    walkScratch.z = this.z;
    // Wide: this is a barrel on legs, and half of it going into a hut wall is
    // as wrong as all of it.
    const moved = walkClear(this.world, walkScratch, stepX, stepZ, 0.75);
    this.x = walkScratch.x;
    this.y = walkScratch.y;
    this.z = walkScratch.z;
    return moved;
  }

  /**
   * Something banged near enough to start it.
   *
   * Returns whether this was the shot that actually moved it, so the caller
   * can tell a fresh panic from one already in progress.
   */
  alarm(x: number, z: number, radius: number): boolean {
    if (this.task === Task.Dead) return false;
    const dx = this.x - x;
    const dz = this.z - z;
    if (dx * dx + dz * dz > radius * radius) return false;
    const already = this.task === Task.Bolt;
    this.bolt(x, z);
    return !already;
  }

  /** Away from whatever made the noise, flat out. */
  private bolt(fromX: number, fromZ: number): void {
    const dx = this.x - fromX;
    const dz = this.z - fromZ;
    // Standing exactly where the bang was: any direction will do.
    this.desiredYaw = (dx === 0 && dz === 0)
      ? this.rand() * Math.PI * 2
      : Math.atan2(dx, dz);
    this.yaw = this.desiredYaw;
    this.task = Task.Bolt;
    this.timer = BOLT_TIME;
    this.headDown = 0;
  }

  /**
   * Ray against the standing animal, in its own frame.
   *
   * Tested un-yawed against a local box rather than as a circle: a buffalo is
   * two and a half blocks long and one wide, and a round that goes past its
   * nose should miss it the way it looks like it did.
   */
  raycast(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDist: number,
  ): OxHit | null {
    if (this.task === Task.Dead) return null;

    // Into the animal's frame: translate to its feet, then turn the world the
    // other way by its yaw.
    const c = Math.cos(-this.yaw);
    const sn = Math.sin(-this.yaw);
    const rx = ox - this.x;
    const rz = oz - this.z;
    const lx = rx * c + rz * sn;
    const lz = -rx * sn + rz * c;
    const ly = oy - this.y;
    const ldx = dx * c + dz * sn;
    const ldz = -dx * sn + dz * c;

    let t0 = 0;
    let t1 = maxDist;
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

    // The body, not the horns. Missing a horn tip is not a hit anybody feels
    // cheated by; being shot through them is.
    if (!slab(lx, ldx, -0.62, 0.62)) return null;
    if (!slab(ly, dy, 0, 2.4)) return null;
    if (!slab(lz, ldz, -1.8, 2.9)) return null;
    if (t0 < 0 || t0 >= maxDist) return null;
    return { distance: t0 };
  }

  /**
   * A round into it. Returns whether that was the one that killed it.
   *
   * A wounded buffalo runs, which is the tell that you have done something to
   * it rather than missed: the animal that has stood in the same patch of
   * grass all game is suddenly going the other way.
   */
  hit(damage: number, fromX: number, fromZ: number): boolean {
    if (this.task === Task.Dead) return false;
    this.hp -= damage;
    if (this.hp > 0) {
      this.bolt(fromX, fromZ);
      return false;
    }
    this.kill();
    return true;
  }

  /**
   * A blast near it. Returns whether it died of it.
   *
   * Falls off with distance the way the people in the street do, so a shell in
   * the market is what kills it and one over the wire is what starts it.
   */
  blast(x: number, y: number, z: number, radius: number, damage: number): boolean {
    if (this.task === Task.Dead) return false;
    const dist = Math.hypot(this.x - x, this.y + 1.4 - y, this.z - z);
    if (dist > radius) return false;
    const falloff = 1 - dist / radius;
    return this.hit(damage * falloff, x, z);
  }

  private kill(): void {
    this.hp = 0;
    this.task = Task.Dead;
    this.fall = 0;
    this.walkPhase = 0;
  }

  /** Where to put the blood and the carcass, at the middle of the barrel. */
  get bodyX(): number { return this.x; }
  get bodyY(): number { return this.y; }
  get bodyZ(): number { return this.z; }

  /** Back on its feet for a new run. */
  respawn(): void {
    this.x = this.homeX;
    this.y = this.homeY;
    this.z = this.homeZ;
    this.hp = OX_HP;
    this.fall = 0;
    this.headDown = 1;
    this.task = Task.Graze;
    this.timer = 4 + this.rand() * 10;
    this.grounded = false;
  }

  private beginWalk(): void {
    const rand = this.rand;
    const p = this.pasture;
    this.task = Task.Walk;
    this.timer = 40;
    this.targetX = p.x0 + rand() * (p.x1 - p.x0);
    this.targetZ = p.z0 + rand() * (p.z1 - p.z0);
  }

  private draw(): void {
    const colorAttr = this.mesh.instanceColor!;
    const dead = this.task === Task.Dead;
    const bolting = this.task === Task.Bolt;
    const walking = this.task === Task.Walk || bolting;
    const down = this.headDown;

    // Diagonal pairs, the way a walking quadruped actually goes. A gallop is
    // the same cycle run hard: longer in the leg and faster over the ground.
    const gait = bolting ? 0.85 : 0.45;
    const swingA = walking ? Math.sin(this.walkPhase) * gait : 0;
    const swingB = walking ? Math.sin(this.walkPhase + Math.PI) * gait : 0;
    // Breathing, and the shoulders rolling over each step.
    const bob = (walking ? Math.abs(Math.sin(this.walkPhase)) * 0.05 : 0)
      + Math.sin(this.clock * 0.9) * 0.02;
    // The tail never stops -- it is the only part of a resting buffalo that
    // moves -- right up until it does.
    const tail = dead
      ? 0
      : Math.sin(this.clock * 1.9) * 0.34 + Math.sin(this.clock * 0.7) * 0.12;
    // Chewing: the jaw works while the head is up.
    const chew = this.task === Task.Chew ? Math.sin(this.clock * 4.5) * 0.05 : 0;

    const NECK_Y = 1.98 + bob;
    const NECK_Z = 1.05;
    const HIP_Y = 1.22;

    const parts: Part[] = [
      // Barrel, withers and rump. A buffalo is mostly a barrel on short legs.
      [0, 1.62 + bob, -0.1, 1.16, 0.96, 2.5, HIDE, Rig.Body],
      [0, 2.14 + bob, 0.55, 1.0, 0.34, 1.15, HIDE_LIT, Rig.Body],
      [0, 1.66 + bob, -1.42, 1.06, 0.86, 0.7, HIDE, Rig.Body],
      // Belly, caked to the knee in dried mud.
      [0, 1.16 + bob, -0.1, 1.04, 0.24, 2.3, MUD, Rig.Body],

      // Neck and head, hung off the withers so the whole thing swings down.
      [0, 1.9 + bob, 1.5, 0.78, 0.72, 0.9, HIDE, Rig.Head],
      [0, 1.82 + bob, 2.24, 0.7, 0.6, 0.72, HIDE, Rig.Head],
      [0, 1.66 + bob + chew, 2.7, 0.58, 0.42, 0.34, MUZZLE, Rig.Head],
      [-0.3, 1.96 + bob, 2.5, 0.14, 0.12, 0.06, EYE, Rig.Head],
      [0.3, 1.96 + bob, 2.5, 0.14, 0.12, 0.06, EYE, Rig.Head],
      [-0.52, 1.94 + bob, 2.1, 0.42, 0.14, 0.3, HIDE_DARK, Rig.Head],
      [0.52, 1.94 + bob, 2.1, 0.42, 0.14, 0.3, HIDE_DARK, Rig.Head],
      // The pale chevron under the throat. Small, and the one marking that
      // stops the whole animal being a single flat colour.
      [0, 1.62 + bob, 1.86, 0.44, 0.14, 0.5, HORN, Rig.Head],
      // Horns: out from the poll, then swept back and up in a flat crescent.
      // Getting these wrong is the difference between a buffalo and a cow, and
      // they have to stay thin -- at any thickness they read as planks.
      [-0.5, 2.14 + bob, 2.04, 0.56, 0.15, 0.2, HORN, Rig.Head],
      [0.5, 2.14 + bob, 2.04, 0.56, 0.15, 0.2, HORN, Rig.Head],
      [-0.82, 2.2 + bob, 1.74, 0.16, 0.15, 0.64, HORN, Rig.Head],
      [0.82, 2.2 + bob, 1.74, 0.16, 0.15, 0.64, HORN, Rig.Head],
      [-0.82, 2.46 + bob, 1.48, 0.15, 0.38, 0.16, HORN, Rig.Head],
      [0.82, 2.46 + bob, 1.48, 0.15, 0.38, 0.16, HORN, Rig.Head],

      // Legs. Front pair under the withers, back pair under the rump.
      [-0.44, 0.62, 0.92, 0.32, 1.24, 0.36, HIDE_DARK, Rig.LegFL],
      [0.44, 0.62, 0.92, 0.32, 1.24, 0.36, HIDE_DARK, Rig.LegFR],
      [-0.44, 0.62, -1.16, 0.32, 1.24, 0.36, HIDE_DARK, Rig.LegBL],
      [0.44, 0.62, -1.16, 0.32, 1.24, 0.36, HIDE_DARK, Rig.LegBR],
      [-0.44, 0.09, 0.94, 0.36, 0.18, 0.4, HOOF, Rig.LegFL],
      [0.44, 0.09, 0.94, 0.36, 0.18, 0.4, HOOF, Rig.LegFR],
      [-0.44, 0.09, -1.14, 0.36, 0.18, 0.4, HOOF, Rig.LegBL],
      [0.44, 0.09, -1.14, 0.36, 0.18, 0.4, HOOF, Rig.LegBR],

      // Tail, hanging off the rump with the tuft on the end.
      [0, 1.5, -1.78, 0.14, 0.62, 0.14, HIDE_DARK, Rig.Tail],
      [0, 1.06, -1.78, 0.2, 0.32, 0.2, HIDE_DARK, Rig.Tail],
    ];

    yawQuat.setFromAxisAngle(AXIS_Y, this.yaw);
    // Going over sideways: the whole animal rolls about its own spine, which
    // for this rig is the local Z axis, pivoting at the height of the barrel
    // so it lands on its flank rather than swinging off its feet.
    const roll = this.fall * (Math.PI / 2) * this.fallSide;
    const rollC = Math.cos(roll);
    const rollS = Math.sin(roll);
    if (roll !== 0) {
      rollQuat.setFromAxisAngle(AXIS_Z, roll);
      yawQuat.multiply(rollQuat);
    }
    const headPitch = down * HEAD_DOWN;
    const headC = Math.cos(headPitch);
    const headS = Math.sin(headPitch);

    let n = 0;
    for (let i = 0; i < parts.length && n < PARTS; i++) {
      const [ox, oy, oz, sx, sy, sz, col, rig] = parts[i];

      let ly: number = oy;
      let lz = oz;
      let pitch = 0;

      switch (rig) {
        case Rig.Head: {
          // Swing about the base of the neck, so the muzzle arcs to the ground
          // rather than the head sliding down it.
          const ry = oy - NECK_Y;
          const rz = oz - NECK_Z;
          ly = NECK_Y + ry * headC - rz * headS;
          lz = NECK_Z + ry * headS + rz * headC;
          pitch = headPitch;
          break;
        }
        case Rig.LegFL:
        case Rig.LegBR:
        case Rig.LegFR:
        case Rig.LegBL: {
          const a = (rig === Rig.LegFL || rig === Rig.LegBR) ? swingA : swingB;
          if (a !== 0) {
            const c = Math.cos(a);
            const s = Math.sin(a);
            const ry = oy - HIP_Y;
            const rz = oz - (rig === Rig.LegFL || rig === Rig.LegFR ? 0.92 : -1.16);
            ly = HIP_Y + ry * c - rz * s;
            lz = (rig === Rig.LegFL || rig === Rig.LegFR ? 0.92 : -1.16) + ry * s + rz * c;
            pitch = a;
          }
          break;
        }
        case Rig.Tail: {
          const c = Math.cos(tail);
          const s = Math.sin(tail);
          const ry = oy - 1.72;
          const rz = oz + 1.78;
          ly = 1.72 + ry * c - rz * s;
          lz = -1.78 + ry * s + rz * c;
          pitch = tail;
          break;
        }
        default:
          break;
      }

      let q: THREE.Quaternion;
      if (pitch !== 0) {
        tmpQuat.setFromAxisAngle(AXIS_X, pitch);
        q = partQuat.copy(yawQuat).multiply(tmpQuat);
      } else {
        q = yawQuat;
      }

      // The roll happens in the animal's own frame, before the yaw that puts
      // it in the world, so a body lying down keeps pointing the way it was
      // facing when it went.
      let lx = ox;
      if (roll !== 0) {
        const ry = ly - ROLL_PIVOT_Y;
        lx = ox * rollC - ry * rollS;
        ly = ROLL_PIVOT_Y + ox * rollS + ry * rollC;
      }

      tmpPos.set(lx, ly, lz).applyQuaternion(yawQuat);
      tmpPos.x += this.x;
      tmpPos.y += this.y;
      tmpPos.z += this.z;
      tmpScale.set(sx, sy, sz);
      tmpMatrix.compose(tmpPos, q, tmpScale);
      this.mesh.setMatrixAt(n, tmpMatrix);
      tmpColor.setHex(col);
      colorAttr.setXYZ(n, tmpColor.r, tmpColor.g, tmpColor.b);
      n++;
    }

    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    colorAttr.needsUpdate = true;
  }
}
