import * as THREE from 'three';
import { PADDY, paddyGroundY } from '../voxel/worldgen';

/**
 * The people working the rice paddy under the firebase.
 *
 * These are scenery with a gait, not actors: no health, no collision, no line
 * in the protocol -- the same trade Flags.ts makes. What they buy is the thing
 * a rectangle of green voxels cannot say on its own, which is that the ground
 * the enemy walks in over is somebody's field, and was somebody's field before
 * the hill above it had sandbags on it.
 *
 * The whole crowd is one InstancedMesh of boxes, so a village of them costs a
 * single draw call and one more in the shadow pass.
 *
 * The loop each of them runs is deliberately small: walk out to a patch of mud,
 * bend over it and work the hoe for a while, straighten up, pick another patch.
 * Everything readable about the field from the parapet -- who is bent over, who
 * is crossing a bund, which of them are children -- falls out of that plus the
 * two body scales.
 */

/** Boxes drawn per farmer. The pose builder must stay under this. */
const PARTS = 16;

/** Blocks/sec on the flat. A loaded walk across a bund, not a march. */
const WALK_SPEED = 1.8;
/** Blocks/sec of shuffle while working a row, which is how a row gets worked. */
const HOE_CREEP = 0.2;
/** Radians of leg swing per block covered, for a full-size pair of legs. */
const STRIDE = 2.4;
/** How far forward the back folds when working. */
const BEND_WORK = 1.05;
/** The permanent stoop of someone who has done this all their life. */
const BEND_WALK = 0.16;
/** Hoe strokes per second. */
const STROKE_RATE = 1.1;

/** Shoulder angle at the bottom and top of a stroke, measured from straight down. */
const ARM_STRIKE = -0.7;
const ARM_RAISED = 1.7;
/** The wrist breaks, so the blade leads the hands through the swing. */
const HOE_LAG = 0.35;
/** Hands to blade, in blocks. */
const SHAFT = 1.35;
/** Elbows are bent at the bottom of the stroke and straight at the top. */
const REACH_STRIKE = 0.6;

const enum Task {
  /** Crossing the field to the next patch. */
  Walk = 0,
  /** Bent over, working the hoe. */
  Hoe = 1,
  /** Straightened up: a breather, a look at the hill, a word with a neighbour. */
  Rest = 2,
}

/** Dark indigo, black and faded brown -- what áo bà ba actually comes in. */
const SHIRTS = [0x2b2f38, 0x1a1c20, 0x3b3a30, 0x4a4436, 0x2a3038, 0x584f3e];
const TROUSERS = [0x1c1e23, 0x24262c, 0x15171b, 0x2f3038];
const SKIN = [0xc9a077, 0xb98f68, 0xd0a97f, 0xa8815d];
/** Straw, sun-bleached to different degrees depending on the hat's age. */
const STRAW = [0xd9c184, 0xd2b678, 0xc9aa6b, 0xe0cb95, 0xbf9f5e];
const HOE_SHAFT = 0x6b4f33;
const HOE_BLADE = 0x4e4a44;
const EYE = 0x14110e;

/** Which chain of joints carries a box. */
const enum Rig {
  /** Rides the fold of the back. */
  Spine = 0,
  /** Rides the back, then swings on the shoulder. */
  Arm = 1,
  LegL = 2,
  LegR = 3,
  /**
   * Already resolved into the farmer's own upright frame. The hoe is placed
   * this way because where it goes is a fact about the world -- the blade has
   * to reach the mud -- not about where the shoulder happens to be pointing.
   */
  World = 4,
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

/** Multiplies each channel of a packed RGB colour, for cheap shading. */
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

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

class Farmer {
  x = 0;
  z = 0;
  /** Rendered foot height, chasing the terrace it is standing on. */
  y = 0;
  yaw = 0;
  desiredYaw = 0;

  targetX = 0;
  targetZ = 0;

  task = Task.Walk;
  /** Seconds left in the current task. */
  timer = 0;

  walkPhase = 0;
  /** Where the back is, eased between the walking stoop and the working fold. */
  bend = BEND_WALK;
  /** 0..1 through the current hoe stroke; wraps at the moment the blade bites. */
  stroke = 0;

  /** 1 for an adult -- the size of the men coming over the wire -- or 0.4. */
  scale = 1;
  shirt = 0;
  trousers = 0;
  skin = 0;
  straw = 0;
  /** Ground covered per second, relative to {@link WALK_SPEED}. */
  speedMul = 1;

  /** Advances the state machine. Returns true if the blade bit this frame. */
  step(dt: number, rand: () => number): boolean {
    let struck = false;
    this.timer -= dt;

    switch (this.task) {
      case Task.Walk: {
        const dx = this.targetX - this.x;
        const dz = this.targetZ - this.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.45 || this.timer <= 0) {
          this.beginWork(rand);
          break;
        }
        this.desiredYaw = Math.atan2(dx, dz);
        const move = Math.min(dist, WALK_SPEED * this.speedMul * dt);
        this.x += (dx / dist) * move;
        this.z += (dz / dist) * move;
        // Short legs take more steps to cover the same ground.
        this.walkPhase += (move * STRIDE) / this.scale;
        this.bend += (BEND_WALK - this.bend) * Math.min(1, dt * 4);
        break;
      }

      case Task.Hoe: {
        // Working a row means creeping down it, a hand's width at a time.
        const creep = HOE_CREEP * this.speedMul * dt;
        this.x += Math.sin(this.yaw) * creep;
        this.z += Math.cos(this.yaw) * creep;
        this.bend += (BEND_WORK - this.bend) * Math.min(1, dt * 3);

        const before = this.stroke;
        this.stroke += dt * STROKE_RATE * this.speedMul;
        // The stroke ends with the blade in the mud, so a wrap is a strike.
        if (Math.floor(this.stroke) > Math.floor(before)) struck = true;

        if (this.timer <= 0) {
          // Straighten up first -- nobody walks off still bent double.
          this.task = Task.Rest;
          this.timer = 1.4 + rand() * 2.6;
          this.desiredYaw = this.yaw + (rand() - 0.5) * 2.4;
        }
        break;
      }

      case Task.Rest: {
        this.bend += (BEND_WALK * 0.35 - this.bend) * Math.min(1, dt * 2.5);
        if (this.timer <= 0) this.beginWalk(rand);
        break;
      }
    }

    this.yaw += shortestAngle(this.yaw, this.desiredYaw) * Math.min(1, dt * 4.5);

    // The terraces step down a block at a time and the bunds stand a block
    // above the mud, so the ground under someone crossing the field is a
    // staircase. Chase it rather than snapping to it, and a step reads as a
    // step up instead of a teleport.
    this.y += (paddyGroundY(this.x, this.z) - this.y) * Math.min(1, dt * 9);

    return struck;
  }

  beginWalk(rand: () => number): void {
    const spot = pickMudSpot(rand);
    this.targetX = spot.x;
    this.targetZ = spot.z;
    this.task = Task.Walk;
    // A generous ceiling. The walk normally ends on arrival; this only catches
    // one that somehow can't close the distance.
    this.timer = 60;
    this.stroke = 0;
  }

  private beginWork(rand: () => number): void {
    this.task = Task.Hoe;
    this.timer = 7 + rand() * 11;
    // Rows mostly run along the furrows, which are cut across Z.
    if (rand() < 0.72) this.desiredYaw = rand() < 0.5 ? 0 : Math.PI;
    else this.desiredYaw = rand() < 0.5 ? Math.PI * 0.5 : -Math.PI * 0.5;
  }
}

/** A random point in the mud of some plot, clear of the bunds. */
function pickMudSpot(rand: () => number): { x: number; z: number } {
  const px = Math.floor(rand() * PADDY.plotsX);
  const pz = Math.floor(rand() * PADDY.plotsZ);
  return {
    x: PADDY.x0 + px * PADDY.pitch + 1.8 + rand() * (PADDY.pitch - 3.6),
    z: PADDY.z0 + pz * PADDY.pitch + 1.8 + rand() * (PADDY.pitch - 3.6),
  };
}

export interface FarmerOptions {
  /** How many people are out in the field. */
  count?: number;
  /** Fraction of them drawn at 40% of adult size. */
  childFraction?: number;
  rand?: () => number;
  /** A blade has just gone into the mud here, for a splash of particles. */
  onStrike?: (x: number, y: number, z: number) => void;
}

/** The crowd in the paddy: pooled, simulated and drawn. */
export class Farmers {
  readonly mesh: THREE.InstancedMesh;
  private readonly farmers: Farmer[] = [];
  private readonly rand: () => number;
  private readonly onStrike: ((x: number, y: number, z: number) => void) | undefined;

  constructor(opts: FarmerOptions = {}) {
    const count = opts.count ?? 16;
    const childFraction = opts.childFraction ?? 0.4;
    this.rand = opts.rand ?? Math.random;
    this.onStrike = opts.onStrike;

    const geom = new THREE.BoxGeometry(1, 1, 1);
    // Lit like the terrain and the enemy, so someone stepping into the shadow
    // of the hill darkens the same way everything else does.
    const mat = new THREE.MeshLambertMaterial({ fog: true });
    this.mesh = new THREE.InstancedMesh(geom, mat, count * PARTS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;

    const colors = new Float32Array(count * PARTS * 3);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

    const rand = this.rand;
    for (let i = 0; i < count; i++) {
      const f = new Farmer();
      // Some of the field is worked by people the size of the men who come
      // over the wire at night, and the rest by children who barely clear the
      // rice -- which is the single cheapest way to say that this is a village
      // and not a garrison.
      const child = rand() < childFraction;
      f.scale = child ? 0.4 : 1;
      f.speedMul = child ? 0.72 + rand() * 0.2 : 0.9 + rand() * 0.25;
      f.shirt = SHIRTS[Math.floor(rand() * SHIRTS.length)];
      f.trousers = TROUSERS[Math.floor(rand() * TROUSERS.length)];
      f.skin = SKIN[Math.floor(rand() * SKIN.length)];
      f.straw = STRAW[Math.floor(rand() * STRAW.length)];
      f.stroke = rand();

      const spot = pickMudSpot(rand);
      f.x = spot.x;
      f.z = spot.z;
      f.y = paddyGroundY(f.x, f.z);
      f.yaw = f.desiredYaw = rand() * Math.PI * 2;
      // Stagger the crowd across the loop so they never move in lockstep.
      if (rand() < 0.65) {
        f.task = Task.Hoe;
        f.timer = rand() * 12;
        f.bend = BEND_WORK;
      } else {
        f.beginWalk(rand);
      }
      this.farmers.push(f);
    }
  }

  update(dt: number): void {
    for (const f of this.farmers) {
      if (f.step(dt, this.rand) && this.onStrike) {
        // The splash goes where the blade is, not where the feet are.
        const reach = (SHAFT + 0.9) * f.scale;
        this.onStrike(f.x + Math.sin(f.yaw) * reach, f.y + 0.1, f.z + Math.cos(f.yaw) * reach);
      }
    }
    this.draw();
  }

  private draw(): void {
    let n = 0;
    const colorAttr = this.mesh.instanceColor!;

    for (const f of this.farmers) {
      const s = f.scale;
      const shirt = f.shirt;
      const sleeve = shade(shirt, 0.92);
      const strawMid = shade(f.straw, 0.9);
      const strawTip = shade(f.straw, 0.8);

      // --- pose ------------------------------------------------------------
      const working = f.task === Task.Hoe;
      const walking = f.task === Task.Walk;
      const swing = walking ? Math.sin(f.walkPhase) * 0.55 : 0;

      // How far through the stroke: 0 is the blade in the mud, 1 is the hoe at
      // the top of its arc. Eased so it accelerates coming down rather than
      // sweeping at one rate the whole way.
      const t = f.stroke - Math.floor(f.stroke);
      const lift = working
        ? (t < 0.62 ? Math.sin((t / 0.62) * Math.PI * 0.5) : 1 - ((t - 0.62) / 0.38) ** 2)
        : 0;

      // The swing comes from the waist as much as the shoulders: the back
      // straightens a little as the hoe goes up and folds into the blow.
      const spine = f.bend - lift * 0.2;

      const legSquash = 1 - 0.18 * (f.bend / BEND_WORK);
      const legSpread = (walking ? 0.2 : 0.28) * s;
      const hipY = 0.86 * s * legSquash;
      const legY = 0.42 * s * legSquash;
      const legH = 0.85 * s * legSquash;
      const bob = walking ? (Math.abs(Math.sin(f.walkPhase)) - 0.5) * 0.06 * s : 0;

      const torsoY = 1.32 * s + bob;
      const shoulderY = 1.72 * s + bob;
      const headY = 2.12 * s + bob;
      const brimY = 2.3 * s + bob;
      const hatT = 0.085 * s;

      // Shoulder angle in the farmer's own upright frame, measured from arms
      // hanging straight down; positive swings them back and up.
      const armWorld = working ? lerp(ARM_STRIKE, ARM_RAISED, lift)
        : walking ? -0.5 + swing * 0.4
        : -0.35;
      // What the shoulder joint has to do to get there, given the back is
      // already folded that far forward.
      const armPitch = armWorld - spine;

      // Where the hands finish up, resolved in the upright frame, because that
      // is what the hoe hangs off. Elbows are bent at the bottom of the stroke.
      const armLen = 0.86 * s;
      const reach = armLen * (working ? lerp(REACH_STRIKE, 1, lift) : 0.9);
      const shoulderRise = shoulderY - hipY;
      const shY = hipY + shoulderRise * Math.cos(spine);
      const shZ = shoulderRise * Math.sin(spine);
      const handY = shY - reach * Math.cos(armWorld);
      const handZ = shZ - reach * Math.sin(armWorld);

      // The hoe: a long shaft with the blade turned in at the far end, leading
      // the hands through the swing so it goes in edge-first.
      const hoeAngle = armWorld - HOE_LAG;
      const shaftLen = SHAFT * s;
      const hoeDirY = -Math.cos(hoeAngle);
      const hoeDirZ = -Math.sin(hoeAngle);
      const shaftY = handY + shaftLen * 0.5 * hoeDirY;
      const shaftZ = handZ + shaftLen * 0.5 * hoeDirZ;
      const bladeY = handY + shaftLen * hoeDirY;
      const bladeZ = handZ + shaftLen * hoeDirZ;

      // Nón lá. Each ring is two crossed slabs rather than one square one: an
      // octagon reads as the round hat it is, where a single box reads as a
      // board. Everyone in the field is wearing one, adults and children alike.
      const parts: Part[] = [
        [-legSpread, legY, 0, 0.23 * s, legH, 0.38 * s, f.trousers, Rig.LegL],
        [legSpread, legY, 0, 0.23 * s, legH, 0.38 * s, f.trousers, Rig.LegR],
        [0, torsoY, 0, 0.76 * s, 1.0 * s, 0.5 * s, shirt, Rig.Spine],
        // Waist sash, so the torso isn't one unbroken slab.
        [0, 0.98 * s * legSquash, 0, 0.8 * s, 0.15 * s, 0.54 * s, shade(shirt, 0.68), Rig.Spine],
        [-0.49 * s, shoulderY - 0.43 * s, 0, 0.23 * s, 0.88 * s, 0.32 * s, sleeve, Rig.Arm],
        [0.49 * s, shoulderY - 0.43 * s, 0, 0.23 * s, 0.88 * s, 0.32 * s, sleeve, Rig.Arm],
        [0, headY, 0, 0.56 * s, 0.56 * s, 0.56 * s, f.skin, Rig.Spine],
        [-0.135 * s, headY + 0.05 * s, 0.285 * s, 0.16 * s, 0.06 * s, 0.02 * s, EYE, Rig.Spine],
        [0.135 * s, headY + 0.05 * s, 0.285 * s, 0.16 * s, 0.06 * s, 0.02 * s, EYE, Rig.Spine],
        [0, brimY, 0, 1.16 * s, hatT, 0.78 * s, f.straw, Rig.Spine],
        [0, brimY, 0, 0.78 * s, hatT, 1.16 * s, f.straw, Rig.Spine],
        [0, brimY + 0.1 * s, 0, 0.5 * s, hatT, 0.34 * s, strawMid, Rig.Spine],
        [0, brimY + 0.1 * s, 0, 0.34 * s, hatT, 0.5 * s, strawMid, Rig.Spine],
        [0, brimY + 0.19 * s, 0, 0.16 * s, 0.1 * s, 0.16 * s, strawTip, Rig.Spine],
        [0, shaftY, shaftZ, 0.1 * s, shaftLen, 0.1 * s, HOE_SHAFT, Rig.World],
        [0, bladeY, bladeZ, 0.42 * s, 0.1 * s, 0.36 * s, HOE_BLADE, Rig.World],
      ];

      yawQuat.setFromAxisAngle(AXIS_Y, f.yaw);

      const spineC = Math.cos(spine);
      const spineS = Math.sin(spine);
      const armC = Math.cos(armPitch);
      const armS = Math.sin(armPitch);
      // A box's own +Y has to end up along the hoe, which points down-forward.
      const hoePitch = hoeAngle + Math.PI;

      for (let p = 0; p < parts.length && n < this.mesh.instanceMatrix.count; p++) {
        const [ox, oy, oz, sx, sy, sz, col, rig] = parts[p];

        let ly = oy;
        let lz = oz;
        let pitch = 0;

        switch (rig) {
          case Rig.Spine: {
            const ry = oy - hipY;
            ly = hipY + ry * spineC - oz * spineS;
            lz = ry * spineS + oz * spineC;
            pitch = spine;
            break;
          }
          case Rig.Arm: {
            // Swing on the shoulder in the torso's own frame...
            const ay = oy - shoulderY;
            const sy2 = shoulderY + ay * armC - oz * armS;
            const sz2 = ay * armS + oz * armC;
            // ...then fold the whole upper body forward with the back.
            const ry = sy2 - hipY;
            ly = hipY + ry * spineC - sz2 * spineS;
            lz = ry * spineS + sz2 * spineC;
            pitch = spine + armPitch;
            break;
          }
          case Rig.LegL:
          case Rig.LegR: {
            const legPitch = rig === Rig.LegL ? swing : -swing;
            const c = Math.cos(legPitch);
            const sn = Math.sin(legPitch);
            const ry = oy - hipY;
            ly = hipY + ry * c - oz * sn;
            lz = ry * sn + oz * c;
            pitch = legPitch;
            break;
          }
          case Rig.World:
            pitch = hoePitch;
            break;
        }

        let q = yawQuat;
        if (pitch !== 0) {
          tmpQuat.setFromAxisAngle(AXIS_X, pitch);
          q = partQuat.copy(yawQuat).multiply(tmpQuat);
        }

        tmpPos.set(ox, ly, lz).applyQuaternion(yawQuat);
        tmpPos.x += f.x;
        tmpPos.y += f.y;
        tmpPos.z += f.z;
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
