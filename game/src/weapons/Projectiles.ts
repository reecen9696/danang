import * as THREE from 'three';
import type { VoxelWorld } from '../voxel/VoxelWorld';
import { WORLD_Y } from '../core/constants';
import type { ExplosionKind } from './definitions';

const MAX_PROJECTILES = 96;

export const enum ProjectileKind {
  Grenade = 0,
  Rocket = 1,
  TankShell = 2,
}

export interface Projectile {
  active: boolean;
  kind: ProjectileKind;
  explosion: ExplosionKind;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** Seconds until it detonates on its own (grenade fuse). */
  fuse: number;
  /** True when the owner is an enemy. */
  hostile: boolean;
  damageMultiplier: number;
  /** Trail emission accumulator. */
  trailTimer: number;
}

export interface ProjectileHooks {
  onExplode: (p: Projectile, x: number, y: number, z: number) => void;
  onTrail: (p: Projectile, x: number, y: number, z: number) => void;
  onBounce: (x: number, y: number, z: number) => void;
}

const tmpMatrix = new THREE.Matrix4();
const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpScale = new THREE.Vector3();
const tmpColor = new THREE.Color();
const tmpDir = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Pooled grenades and rockets.
 *
 * Grenades arc under gravity and bounce off voxels; rockets fly straight and
 * detonate on first contact. Everything renders from one InstancedMesh.
 */
export class ProjectileSystem {
  readonly mesh: THREE.InstancedMesh;
  private readonly pool: Projectile[] = [];

  constructor(private readonly world: VoxelWorld, private readonly hooks: ProjectileHooks) {
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      this.pool.push({
        active: false, kind: ProjectileKind.Grenade, explosion: 'grenade',
        x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        fuse: 0, hostile: false, damageMultiplier: 1, trailTimer: 0,
      });
    }

    const geom = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshLambertMaterial({ fog: true });
    this.mesh = new THREE.InstancedMesh(geom, mat, MAX_PROJECTILES);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PROJECTILES * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    // A grenade's shadow racing along the ground is the clearest read a player
    // gets on where it is about to land.
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
  }

  spawn(
    kind: ProjectileKind, explosion: ExplosionKind,
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    fuse: number, hostile: boolean, damageMultiplier = 1,
  ): Projectile | null {
    for (const p of this.pool) {
      if (p.active) continue;
      p.active = true;
      p.kind = kind;
      p.explosion = explosion;
      p.x = x; p.y = y; p.z = z;
      p.vx = vx; p.vy = vy; p.vz = vz;
      p.fuse = fuse;
      p.hostile = hostile;
      p.damageMultiplier = damageMultiplier;
      p.trailTimer = 0;
      return p;
    }
    return null;
  }

  clear(): void {
    for (const p of this.pool) p.active = false;
    this.mesh.count = 0;
  }

  update(dt: number): void {
    for (const p of this.pool) {
      if (!p.active) continue;

      if (p.kind === ProjectileKind.Grenade) {
        this.stepGrenade(p, dt);
      } else {
        this.stepRocket(p, dt);
      }
    }
    this.syncInstances();
  }

  private stepGrenade(p: Projectile, dt: number): void {
    p.fuse -= dt;

    p.vy -= 26 * dt;
    // Substep so fast grenades don't tunnel through thin walls.
    const speed = Math.hypot(p.vx, p.vy, p.vz);
    const steps = Math.max(1, Math.min(6, Math.ceil((speed * dt) / 0.4)));
    const sdt = dt / steps;

    for (let s = 0; s < steps; s++) {
      const nx = p.x + p.vx * sdt;
      const ny = p.y + p.vy * sdt;
      const nz = p.z + p.vz * sdt;

      if (this.solid(nx, ny, nz)) {
        // Resolve per axis so it bounces off the face it actually struck.
        if (this.solid(nx, p.y, p.z)) { p.vx *= -0.42; }
        else if (this.solid(p.x, ny, p.z)) { p.vy *= -0.38; p.vx *= 0.72; p.vz *= 0.72; }
        else if (this.solid(p.x, p.y, nz)) { p.vz *= -0.42; }
        else { p.vx *= -0.4; p.vy *= -0.4; p.vz *= -0.4; }
        if (Math.hypot(p.vx, p.vy, p.vz) > 3) this.hooks.onBounce(p.x, p.y, p.z);
        break;
      }
      p.x = nx; p.y = ny; p.z = nz;
    }

    if (p.y < -4) { p.active = false; return; }
    if (p.fuse <= 0) this.detonate(p);
  }

  private stepRocket(p: Projectile, dt: number): void {
    p.fuse -= dt;
    if (p.fuse <= 0) { this.detonate(p); return; }

    const speed = Math.hypot(p.vx, p.vy, p.vz);
    const steps = Math.max(1, Math.min(10, Math.ceil((speed * dt) / 0.5)));
    const sdt = dt / steps;

    for (let s = 0; s < steps; s++) {
      const nx = p.x + p.vx * sdt;
      const ny = p.y + p.vy * sdt;
      const nz = p.z + p.vz * sdt;
      if (this.solid(nx, ny, nz)) {
        p.x = nx; p.y = ny; p.z = nz;
        this.detonate(p);
        return;
      }
      p.x = nx; p.y = ny; p.z = nz;
    }

    p.trailTimer -= dt;
    if (p.trailTimer <= 0) {
      p.trailTimer = 0.012;
      this.hooks.onTrail(p, p.x, p.y, p.z);
    }
  }

  /** Detonates early — used when a rocket clips a bot or the player. */
  detonate(p: Projectile): void {
    if (!p.active) return;
    p.active = false;
    this.hooks.onExplode(p, p.x, p.y, p.z);
  }

  forEachActive(fn: (p: Projectile) => void): void {
    for (const p of this.pool) if (p.active) fn(p);
  }

  private solid(x: number, y: number, z: number): boolean {
    if (y < 0 || y >= WORLD_Y) return y < 0;
    return this.world.isSolid(Math.floor(x), Math.floor(y), Math.floor(z));
  }

  private syncInstances(): void {
    let n = 0;
    const colorAttr = this.mesh.instanceColor!;
    for (const p of this.pool) {
      if (!p.active) continue;
      tmpPos.set(p.x, p.y, p.z);

      if (p.kind === ProjectileKind.Grenade) {
        tmpQuat.identity();
        tmpScale.set(0.3, 0.3, 0.3);
        // Flash faster as the fuse runs out.
        const blink = p.fuse < 1 && Math.sin(p.fuse * 40) > 0;
        tmpColor.setHex(blink ? 0xff5533 : 0x39421f);
      } else {
        tmpDir.set(p.vx, p.vy, p.vz).normalize();
        tmpQuat.setFromUnitVectors(UP, tmpDir);
        tmpScale.set(0.22, 0.9, 0.22);
        tmpColor.setHex(0xd8d8d0);
      }

      tmpMatrix.compose(tmpPos, tmpQuat, tmpScale);
      this.mesh.setMatrixAt(n, tmpMatrix);
      colorAttr.setXYZ(n, tmpColor.r, tmpColor.g, tmpColor.b);
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    colorAttr.needsUpdate = true;
  }
}
