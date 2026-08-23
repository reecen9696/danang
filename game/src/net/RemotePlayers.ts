/**
 * Renders the other players.
 *
 * Bodies are drawn as instanced boxes in the same blocky idiom as the bots —
 * head, torso, two legs — so a squadmate reads at a glance without needing a
 * skinned model. Positions are interpolated toward the last server snapshot
 * rather than snapped, because state arrives at ~20Hz and the camera runs far
 * faster than that.
 */
import * as THREE from 'three';
import type { RemoteSnapshot } from './NetClient';

/** head, torso, leg, leg */
const PARTS = 4;
const MAX_REMOTES = 8;

/** How fast a remote catches up to its snapshot. Higher is snappier. */
const LERP_RATE = 12;

interface Remote {
  sessionId: string;
  name: string;
  /** Rendered position, chasing the snapshot. */
  pos: THREE.Vector3;
  yaw: number;
  alive: boolean;
  hp: number;
  /** Latest values from the server, which `pos`/`yaw` ease toward. */
  targetX: number;
  targetY: number;
  targetZ: number;
  targetYaw: number;
}

const tmpMatrix = new THREE.Matrix4();
const tmpQuat = new THREE.Quaternion();
const tmpEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const tmpPos = new THREE.Vector3();
const tmpScale = new THREE.Vector3();
const tmpColor = new THREE.Color();

/** Part offsets and sizes, in the player's local frame (y is feet-relative). */
const LAYOUT: { dy: number; sx: number; sy: number; sz: number; dx: number }[] = [
  { dy: 2.35, sx: 0.62, sy: 0.62, sz: 0.62, dx: 0 },     // head
  { dy: 1.55, sx: 0.86, sy: 1.05, sz: 0.52, dx: 0 },     // torso
  { dy: 0.5, sx: 0.34, sy: 1.0, sz: 0.42, dx: -0.22 },   // left leg
  { dy: 0.5, sx: 0.34, sy: 1.0, sz: 0.42, dx: 0.22 },    // right leg
];

export class RemotePlayers {
  readonly mesh: THREE.InstancedMesh;

  private readonly remotes = new Map<string, Remote>();
  /** Marks who was present in the latest snapshot, so leavers can be culled. */
  private readonly seen = new Set<string>();

  constructor() {
    const geom = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshBasicMaterial({ fog: true });
    this.mesh = new THREE.InstancedMesh(geom, mat, MAX_REMOTES * PARTS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_REMOTES * PARTS * 3), 3,
    );
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
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
        alive: p.alive,
        hp: p.hp,
        targetX: p.x,
        targetY: p.y,
        targetZ: p.z,
        targetYaw: p.yaw,
      };
      this.remotes.set(p.sessionId, r);
    }
    r.name = p.name;
    r.alive = p.alive;
    r.hp = p.hp;
    r.targetX = p.x;
    r.targetY = p.y;
    r.targetZ = p.z;
    r.targetYaw = p.yaw;
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

    for (const r of this.remotes.values()) {
      if (!r.alive) continue;

      r.pos.x += (r.targetX - r.pos.x) * t;
      r.pos.y += (r.targetY - r.pos.y) * t;
      r.pos.z += (r.targetZ - r.pos.z) * t;
      // Shortest-arc yaw, or a remote spinning past PI unwinds the long way.
      let dYaw = r.targetYaw - r.yaw;
      while (dYaw > Math.PI) dYaw -= Math.PI * 2;
      while (dYaw < -Math.PI) dYaw += Math.PI * 2;
      r.yaw += dYaw * t;

      // Teammates are blue-green; hurt ones wash toward red so you can see who
      // needs cover without reading a health bar.
      const hurt = 1 - Math.max(0, Math.min(1, r.hp / 100));
      tmpColor.setRGB(0.25 + hurt * 0.7, 0.62 - hurt * 0.35, 0.78 - hurt * 0.5);

      tmpEuler.set(0, r.yaw, 0);
      tmpQuat.setFromEuler(tmpEuler);

      for (let i = 0; i < PARTS; i++) {
        const L = LAYOUT[i];
        const ox = Math.cos(r.yaw) * L.dx;
        const oz = -Math.sin(r.yaw) * L.dx;
        tmpPos.set(r.pos.x + ox, r.pos.y + L.dy, r.pos.z + oz);
        tmpScale.set(L.sx, L.sy, L.sz);
        tmpMatrix.compose(tmpPos, tmpQuat, tmpScale);
        this.mesh.setMatrixAt(n, tmpMatrix);
        colorAttr.setXYZ(n, tmpColor.r, tmpColor.g, tmpColor.b);
        n++;
      }
    }

    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    colorAttr.needsUpdate = true;
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
