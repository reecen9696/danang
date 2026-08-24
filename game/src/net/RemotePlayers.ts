/**
 * Renders the other players.
 *
 * Squadmates are drawn on the same blocky humanoid rig the bots use — legs,
 * boots, torso, webbing, arms, hands, head, helmet — so a friendly reads as a
 * soldier rather than as a marker. Everything is one InstancedMesh of boxes, so
 * a full squad costs a handful of draw calls.
 *
 * They are deliberately *not* the bots: the enemy wears a nón lá and pyjama
 * blacks, a friendly wears an M1 helmet and olive drab. At the range where you
 * have to decide whether to shoot, the silhouette is the whole read — helmet
 * dome versus cone — and colour is only the confirmation.
 *
 * Positions are interpolated toward the last server snapshot rather than
 * snapped, because state arrives at ~20Hz and the camera runs far faster.
 */
import * as THREE from 'three';
import { PHYS } from '../core/constants';
import type { RemoteSnapshot } from './NetClient';

const MAX_REMOTES = 8;

/**
 * Hitbox for a squadmate. The standing box, not the crouched one: crouch is
 * not replicated, so a crouching player would otherwise be shot through the
 * head from across the map. Erring tall costs the shooter a few misses;
 * erring short would make crouch an invisibility cloak.
 */
const PLAYER_RADIUS = 0.45;
const PLAYER_HEIGHT = PHYS.heightStand;

/**
 * Boxes per soldier. The rig emits fewer than this — the ceiling only has to
 * cover the worst case so the instance buffer is allocated once.
 */
const MAX_PARTS = 24;

/** How fast a remote catches up to its snapshot. Higher is snappier. */
const LERP_RATE = 12;

/**
 * Shoulder rotation that brings the arms forward into a weapon carry, matching
 * the bots. A soldier holds his rifle up in both hands; arms swinging at the
 * sides is what made these read as mannequins.
 */
const CARRY = -1.22;

/** Horizontal speed at which the walk cycle reaches full amplitude. */
const FULL_STRIDE = 7;

// --- palette ---------------------------------------------------------------
/** Olive drab fatigues. */
const UNIFORM = 0x4a5231;
/** Webbing, flak vest and belt — a shade down so the torso isn't one slab. */
const WEBBING = 0x39402a;
/** Helmet shell, and the band around it. */
const HELMET = 0x4f5533;
const HELMET_BAND = 0x3d4228;
/** Boots. */
const BOOT = 0x241d16;
/** Dark slits on the front of the face, as the bots have. */
const EYE = 0x14110e;
/** Blood, for the damage wash. */
const BLOOD = 0x7c0d0d;

/** A spread of skin tones so a squad isn't four copies of one man. */
const SKIN = [0xd7ab84, 0xc9a077, 0xa8815d, 0x7c5a3e, 0xe0bb96, 0x8d6a4a];

/** Blend two packed hex colours. */
function mixHex(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (
    ((ar + (br - ar) * t) << 16)
    | ((ag + (bg - ag) * t) << 8)
    | (ab + (bb - ab) * t)
  ) & 0xffffff;
}

/**
 * A stable per-player roll in [0, 1) from the session id.
 *
 * Session ids are assigned by the server and stay put for the connection, so
 * the same squadmate keeps the same face for the whole match instead of
 * flickering between skin tones as the map re-orders.
 */
function roll(sessionId: string): number {
  let h = 2166136261;
  for (let i = 0; i < sessionId.length; i++) {
    h ^= sessionId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}

// --- weapons ---------------------------------------------------------------
/**
 * What each weapon looks like in someone else's hands.
 *
 * Third-person only needs the silhouette that tells you what your squadmate is
 * carrying — length and bulk do that, so this is a box and one detail rather
 * than the viewmodel's full receiver. `len` runs forward from the grip.
 */
interface GunLook {
  len: number;
  thick: number;
  color: number;
  /** Stock/handguard block behind the grip: length, thickness, colour. */
  stock: number;
  stockThick: number;
  stockColor: number;
}

const GUNS: Record<string, GunLook> = {
  rifle: { len: 1.15, thick: 0.15, color: 0x25262a, stock: 0.4, stockThick: 0.17, stockColor: 0x1d1e21 },
  smg: { len: 0.82, thick: 0.15, color: 0x2b2c30, stock: 0.3, stockThick: 0.16, stockColor: 0x202124 },
  shotgun: { len: 1.0, thick: 0.16, color: 0x2a2b2f, stock: 0.42, stockThick: 0.18, stockColor: 0x5a3d22 },
  m60: { len: 1.45, thick: 0.21, color: 0x1f2023, stock: 0.46, stockThick: 0.22, stockColor: 0x4a3a24 },
  m79: { len: 0.72, thick: 0.19, color: 0x2d2e32, stock: 0.34, stockThick: 0.2, stockColor: 0x5a3d22 },
  pistol: { len: 0.34, thick: 0.12, color: 0x2b2c30, stock: 0.16, stockThick: 0.13, stockColor: 0x202124 },
  spade: { len: 0.72, thick: 0.09, color: 0x6b4a2c, stock: 0.26, stockThick: 0.2, stockColor: 0x8d9099 },
  block: { len: 0.34, thick: 0.3, color: 0x9a8f6f, stock: 0, stockThick: 0, stockColor: 0 },
  grenade: { len: 0.24, thick: 0.18, color: 0x3f4a2c, stock: 0, stockThick: 0, stockColor: 0 },
};

/** Anything unrecognised falls back to the rifle rather than vanishing. */
function gunLook(weapon: string): GunLook {
  return GUNS[weapon] ?? GUNS.rifle;
}

// --- rig -------------------------------------------------------------------
/**
 * One box: `x, y, z` centre in the soldier's local frame (y is feet-relative,
 * +z is the way he faces), `sx, sy, sz` extent, packed colour, then the joint
 * it swings on — `pitch` radians about X, pivoting at `pvY, pvZ`.
 *
 * The frame is the bots', deliberately, so that the two rigs are one set of
 * proportions rather than two. Turning a player's yaw into it is `end`'s job.
 */
type Part = [
  x: number, y: number, z: number,
  sx: number, sy: number, sz: number,
  color: number,
  pitch: number, pvY: number, pvZ: number,
];

interface Remote {
  sessionId: string;
  name: string;
  /** Rendered position, chasing the snapshot. */
  pos: THREE.Vector3;
  yaw: number;
  pitch: number;
  alive: boolean;
  hp: number;
  weapon: string;
  sprinting: boolean;
  /** Latest values from the server, which the rendered pose eases toward. */
  targetX: number;
  targetY: number;
  targetZ: number;
  targetYaw: number;
  targetPitch: number;
  /** Walk cycle, advanced by distance actually travelled. */
  walkPhase: number;
  /** Smoothed horizontal speed, for the stride amplitude. */
  speed: number;
  /** Stable per-player appearance roll. */
  skin: number;
}

const tmpMatrix = new THREE.Matrix4();
const tmpQuat = new THREE.Quaternion();
const partQuat = new THREE.Quaternion();
const pitchQuat = new THREE.Quaternion();
const tmpEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const tmpPos = new THREE.Vector3();
const tmpScale = new THREE.Vector3();
const tmpColor = new THREE.Color();
const AXIS_X = new THREE.Vector3(1, 0, 0);

export class RemotePlayers {
  readonly mesh: THREE.InstancedMesh;

  private readonly remotes = new Map<string, Remote>();
  /** Marks who was present in the latest snapshot, so leavers can be culled. */
  private readonly seen = new Set<string>();
  /** Scratch list, reused every frame so the pose costs no allocation. */
  private readonly parts: Part[] = [];

  constructor() {
    const geom = new THREE.BoxGeometry(1, 1, 1);
    // Lambert rather than Basic: a squadmate that takes the scene's light sits
    // in the world instead of glowing out of it, and the shadow is most of what
    // makes them read as standing on the ground.
    const mat = new THREE.MeshLambertMaterial({ fog: true });
    this.mesh = new THREE.InstancedMesh(geom, mat, MAX_REMOTES * MAX_PARTS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_REMOTES * MAX_PARTS * 3), 3,
    );
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
  }

  /** Feeds in this frame's snapshots; call once, then `update`. */
  begin(): void {
    this.seen.clear();
  }

  apply(p: RemoteSnapshot): void {
    this.seen.add(p.sessionId);
    let r = this.remotes.get(p.sessionId);
    if (!r) {
      // First sighting: place them exactly rather than sliding in from origin.
      r = {
        sessionId: p.sessionId,
        name: p.name,
        pos: new THREE.Vector3(p.x, p.y, p.z),
        yaw: p.yaw,
        pitch: p.pitch,
        alive: p.alive,
        hp: p.hp,
        weapon: p.weapon,
        sprinting: p.sprinting,
        targetX: p.x,
        targetY: p.y,
        targetZ: p.z,
        targetYaw: p.yaw,
        targetPitch: p.pitch,
        walkPhase: 0,
        speed: 0,
        skin: roll(p.sessionId),
      };
      this.remotes.set(p.sessionId, r);
    }
    r.name = p.name;
    r.alive = p.alive;
    r.hp = p.hp;
    r.weapon = p.weapon;
    r.sprinting = p.sprinting;
    r.targetX = p.x;
    r.targetY = p.y;
    r.targetZ = p.z;
    r.targetYaw = p.yaw;
    r.targetPitch = p.pitch;
  }

  end(dt: number): void {
    for (const [id] of this.remotes) {
      if (!this.seen.has(id)) this.remotes.delete(id);
    }
    this.update(dt);
  }

  private update(dt: number): void {
    const t = 1 - Math.exp(-LERP_RATE * dt);
    let n = 0;
    const colorAttr = this.mesh.instanceColor!;
    const cap = this.mesh.instanceMatrix.count;

    for (const r of this.remotes.values()) {
      if (!r.alive) continue;

      const px = r.pos.x;
      const pz = r.pos.z;
      r.pos.x += (r.targetX - r.pos.x) * t;
      r.pos.y += (r.targetY - r.pos.y) * t;
      r.pos.z += (r.targetZ - r.pos.z) * t;
      // Shortest-arc yaw, or a remote spinning past PI unwinds the long way.
      let dYaw = r.targetYaw - r.yaw;
      while (dYaw > Math.PI) dYaw -= Math.PI * 2;
      while (dYaw < -Math.PI) dYaw += Math.PI * 2;
      r.yaw += dYaw * t;
      r.pitch += (r.targetPitch - r.pitch) * t;

      // The server sends positions, not velocities, so the stride is driven by
      // the ground actually covered. Smoothed, or the 20Hz snapshot rate shows
      // up as a limp.
      const moved = dt > 0 ? Math.hypot(r.pos.x - px, r.pos.z - pz) / dt : 0;
      r.speed += (moved - r.speed) * Math.min(1, dt * 8);
      const gait = Math.min(1, r.speed / FULL_STRIDE);
      r.walkPhase += r.speed * dt * 2.6;

      this.buildPose(r, gait);

      // A bot's yaw is the bearing it walks on -- `atan2(dx, dz)` -- so the rig
      // these share with the bots was built with local +z as the way the man
      // faces. A player's yaw is his camera's, and a camera looks down -z. The
      // two conventions are exactly half a turn apart, and without this the
      // soldier is mounted backwards on his own position: face, hands and the
      // rifle in them all come out of his back. That is what made a squadmate
      // look like he was holding his weapon across himself.
      tmpEuler.set(0, r.yaw + Math.PI, 0);
      tmpQuat.setFromEuler(tmpEuler);

      // Badly hurt soaks the uniform toward blood, so you can see who needs
      // cover without reading a health bar. Only the cloth takes it — a man
      // whose face and helmet turn red reads as a bug, not as wounded.
      const hurt = 1 - Math.max(0, Math.min(1, r.hp / 100));

      for (let p = 0; p < this.parts.length && n < cap; p++) {
        const [ox, oy, oz, sx, sy, sz, col, pitch, pvY, pvZ] = this.parts[p];

        let ly = oy;
        let lz = oz;
        let q = tmpQuat;
        if (pitch !== 0) {
          // Swing the part around its own joint, in the soldier's local frame.
          const c = Math.cos(pitch);
          const sn = Math.sin(pitch);
          const ry = oy - pvY;
          const rz = oz - pvZ;
          ly = pvY + ry * c - rz * sn;
          lz = pvZ + ry * sn + rz * c;
          pitchQuat.setFromAxisAngle(AXIS_X, pitch);
          q = partQuat.copy(tmpQuat).multiply(pitchQuat);
        }
        // Rotate the local offset into world space.
        tmpPos.set(ox, ly, lz).applyQuaternion(tmpQuat).add(r.pos);
        tmpScale.set(sx, sy, sz);
        tmpMatrix.compose(tmpPos, q, tmpScale);
        this.mesh.setMatrixAt(n, tmpMatrix);

        const cloth = col === UNIFORM || col === WEBBING;
        tmpColor.setHex(cloth && hurt > 0 ? mixHex(col, BLOOD, hurt * 0.55) : col);
        colorAttr.setXYZ(n, tmpColor.r, tmpColor.g, tmpColor.b);
        n++;
      }
    }

    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    colorAttr.needsUpdate = true;
  }

  /**
   * Lays out one soldier into `this.parts`.
   *
   * Proportions are the bots' at scale 1, so a friendly and an enemy standing
   * side by side are the same size — both are men in a 2.7-tall hitbox, and
   * anything else makes range-estimation lie.
   */
  private buildPose(r: Remote, gait: number): void {
    const parts = this.parts;
    parts.length = 0;

    const skinCol = SKIN[Math.min(SKIN.length - 1, Math.floor(r.skin * SKIN.length))];

    // Legs swing on the distance-driven walk cycle, at an amplitude set by how
    // fast the man is actually travelling — edging around a corner shuffles,
    // running for the treeline strides.
    const swing = Math.sin(r.walkPhase) * 0.62 * gait;
    // Weight shifts up and down with the stride.
    const bob = (Math.abs(Math.sin(r.walkPhase)) - 0.5) * 0.07 * gait;
    // Sprinting pitches the whole body forward into the run.
    const lean = r.sprinting ? 0.16 * gait : 0;

    const hipY = 0.86;
    const legY = 0.42;
    const legH = 0.85;
    const legSpread = 0.21;
    const armSpread = 0.5;
    const torsoY = 1.35 + bob;
    const shoulderY = 1.74 + bob;
    const neckY = 1.86 + bob;
    const headY = 2.16 + bob;
    const beltY = 0.92 + bob * 0.35;

    // Both hands stay on the weapon: the arms come forward off the shoulder to
    // CARRY and the aim line pitches them from there, so a squadmate is holding
    // his rifle whether or not he currently has anything to shoot at.
    // Player pitch is positive looking up; a part pitch swings the other way.
    const armPitch = CARRY - r.pitch - swing * 0.08;
    const headPitch = -r.pitch * 0.6;
    const weaponPitch = -r.pitch;

    // Where the hands end up once the arms have swung forward. The weapon hangs
    // off that point rather than off the shoulder, so it stays in the grip
    // instead of sweeping through the chest as he aims.
    const armLen = 0.84;
    const handY = shoulderY - armLen * Math.cos(armPitch);
    const handZ = -armLen * Math.sin(armPitch);

    parts.push(
      // Legs, and boots on the end of them.
      [-legSpread, legY, 0, 0.24, legH, 0.4, UNIFORM, swing, hipY, 0],
      [legSpread, legY, 0, 0.24, legH, 0.4, UNIFORM, -swing, hipY, 0],
      [-legSpread, legY - legH * 0.42, 0, 0.25, legH * 0.3, 0.43, BOOT, swing, hipY, 0],
      [legSpread, legY - legH * 0.42, 0, 0.25, legH * 0.3, 0.43, BOOT, -swing, hipY, 0],

      // Torso, with a flak vest across the chest and a belt at the waist. Both
      // sit proud of the uniform so the trunk doesn't read as one long slab.
      [0, torsoY, 0, 0.8, 1.05, 0.52, UNIFORM, lean, hipY, 0],
      [0, torsoY + 0.17, 0, 0.84, 0.34, 0.58, WEBBING, lean, hipY, 0],
      [0, beltY, 0, 0.84, 0.16, 0.56, WEBBING, lean, hipY, 0],

      // Arms, sleeves rolled to the elbow, and a bare hand on the grip.
      [-armSpread, shoulderY - 0.42, 0, 0.24, 0.9, 0.34, UNIFORM, armPitch, shoulderY, 0],
      [armSpread, shoulderY - 0.42, 0, 0.24, 0.9, 0.34, UNIFORM, armPitch, shoulderY, 0],
      [-armSpread, shoulderY - 0.78, 0, 0.245, 0.28, 0.345, skinCol, armPitch, shoulderY, 0],
      [armSpread, shoulderY - 0.78, 0, 0.245, 0.28, 0.345, skinCol, armPitch, shoulderY, 0],

      // Head, and two dark slits for eyes on the front face.
      [0, headY, 0, 0.6, 0.6, 0.6, skinCol, headPitch, neckY, 0],
      [-0.145, headY + 0.06, 0.305, 0.17, 0.07, 0.02, EYE, headPitch, neckY, 0],
      [0.145, headY + 0.06, 0.305, 0.17, 0.07, 0.02, EYE, headPitch, neckY, 0],
    );

    // M1 helmet: a shallow dome of two slabs with a brim that oversails the
    // head all round. That overhang is the whole silhouette — it is what
    // separates a friendly from a coolie hat at two hundred metres.
    const domeY = headY + 0.34;
    parts.push(
      [0, domeY, 0, 0.68, 0.2, 0.7, HELMET, headPitch, neckY, 0],
      [0, domeY + 0.15, 0, 0.56, 0.14, 0.58, HELMET, headPitch, neckY, 0],
      [0, domeY - 0.12, 0, 0.76, 0.1, 0.8, HELMET, headPitch, neckY, 0],
      [0, domeY - 0.02, 0, 0.7, 0.08, 0.72, HELMET_BAND, headPitch, neckY, 0],
    );

    // The weapon, held in both hands out in front of the chest, level with the
    // aim line rather than with the arms.
    const g = gunLook(r.weapon);
    parts.push(
      [0.1, handY + 0.04, handZ + g.len * 0.28, g.thick, g.thick, g.len, g.color,
        weaponPitch, handY, handZ],
    );
    if (g.stock > 0) {
      parts.push(
        [0.1, handY + 0.02, handZ - g.stock * 0.55, g.stockThick, g.stockThick, g.stock,
          g.stockColor, weaponPitch, handY, handZ],
      );
    }
  }

  /**
   * Ray/AABB sweep over every living squadmate. Returns the nearest hit.
   *
   * Mirrors `BotManager.raycast` deliberately: a round should not care whether
   * the man in front of it is a friend, and the caller picks whichever of the
   * two came back nearer. Friendly fire is on.
   */
  raycast(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDist: number,
  ): { sessionId: string; name: string; distance: number; zoneY: number; footY: number } | null {
    let best: Remote | null = null;
    let bestT = maxDist;
    let bestY = 0;

    for (const r of this.remotes.values()) {
      if (!r.alive) continue;

      const minX = r.pos.x - PLAYER_RADIUS, maxX = r.pos.x + PLAYER_RADIUS;
      const minY = r.pos.y, maxY = r.pos.y + PLAYER_HEIGHT;
      const minZ = r.pos.z - PLAYER_RADIUS, maxZ = r.pos.z + PLAYER_RADIUS;

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

      if (!slab(ox, dx, minX, maxX)) continue;
      if (!slab(oy, dy, minY, maxY)) continue;
      if (!slab(oz, dz, minZ, maxZ)) continue;
      if (t0 < 0 || t0 >= bestT) continue;

      best = r;
      bestT = t0;
      bestY = oy + dy * t0;
    }

    return best
      ? { sessionId: best.sessionId, name: best.name, distance: bestT, zoneY: bestY, footY: best.pos.y }
      : null;
  }

  /** Nameplate data for the HUD, in world space. */
  labels(): { name: string; x: number; y: number; z: number; hp: number }[] {
    const out: { name: string; x: number; y: number; z: number; hp: number }[] = [];
    for (const r of this.remotes.values()) {
      if (!r.alive) continue;
      out.push({ name: r.name, x: r.pos.x, y: r.pos.y + 3.1, z: r.pos.z, hp: r.hp });
    }
    return out;
  }
}
