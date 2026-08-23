import * as THREE from 'three';
import { PHYS, PLAYER_MAX_HP, WORLD_Y } from '../core/constants';
import type { VoxelWorld } from '../voxel/VoxelWorld';

export interface MoveIntent {
  forward: number;
  strafe: number;
  jump: boolean;
  sprint: boolean;
  crouch: boolean;
  sneak: boolean;
  /** Slows movement like AoS does while aiming a tool/weapon. */
  aiming: boolean;
  /** Multiplier on horizontal acceleration, for gear like Light Boots. */
  speedScale: number;
}

const EMPTY_INTENT: MoveIntent = {
  forward: 0, strafe: 0, jump: false, sprint: false, crouch: false, sneak: false, aiming: false,
  speedScale: 1,
};

/** Fixed physics step so the AoS friction formula behaves identically at any FPS. */
const FIXED_STEP = 1 / 120;
const MAX_SUBSTEPS = 8;

/**
 * Player state and voxel collision.
 *
 * Movement reproduces Ace of Spades Classic: velocity is integrated in "ticks"
 * and scaled by 32 to reach world units, with the same friction, air-control
 * and fall-damage curves.
 */
export class Player {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();

  yaw = 0;
  pitch = 0;

  hp = PLAYER_MAX_HP;
  maxHp = PLAYER_MAX_HP;
  alive = true;

  airborne = true;
  wading = false;
  crouching = false;
  sprinting = false;

  /** Seconds of spawn protection remaining. */
  invulnerable = 0;

  /** Drives view bob and the footstep cadence. */
  bobPhase = 0;
  lastStepDistance = 0;

  /**
   * Camera lag over step-ups and step-downs. The body snaps a whole block when
   * it mantles a lip or gets pulled down onto one; this holds the eye where it
   * was and decays to zero, so a flight of stairs is a ramp instead of a series
   * of jolts. Physics never reads it -- it only offsets the eye.
   */
  viewOffset = 0;

  onFallDamage: ((amount: number) => void) | null = null;
  onLand: ((speed: number) => void) | null = null;

  private accumulator = 0;
  /** AoS needs a fresh press to jump; holding space does not auto-hop. */
  private lastJump = false;
  /** Set by resolveAxis when we mantle a lip, so we pay the cost once. */
  private climbed = false;
  private intent: MoveIntent = EMPTY_INTENT;
  private readonly forwardVec = new THREE.Vector3();

  constructor(private readonly world: VoxelWorld) {}

  get height(): number {
    return this.crouching ? PHYS.heightCrouch : PHYS.heightStand;
  }

  get eyeHeight(): number {
    return this.crouching ? PHYS.eyeCrouch : PHYS.eyeStand;
  }

  /** Where the camera actually sits: eye height plus the step-smoothing lag. */
  get eyeY(): number {
    return this.position.y + this.eyeHeight + this.viewOffset;
  }

  get eyePosition(): THREE.Vector3 {
    return this.forwardVec.set(this.position.x, this.eyeY, this.position.z);
  }

  getEye(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.position.x, this.eyeY, this.position.z);
  }

  /**
   * Must match the camera basis exactly (rotation order YXZ, yaw 0 looks down
   * -Z), or aiming and movement drift 180 degrees from what you see.
   */
  getLookDirection(out: THREE.Vector3): THREE.Vector3 {
    const cp = Math.cos(this.pitch);
    return out.set(
      -Math.sin(this.yaw) * cp,
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * cp,
    );
  }

  respawn(x: number, y: number, z: number): void {
    this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.hp = this.maxHp;
    this.alive = true;
    this.invulnerable = 3;
    this.airborne = true;
    this.viewOffset = 0;
  }

  damage(amount: number): boolean {
    if (!this.alive || this.invulnerable > 0) return false;
    this.hp -= amount;
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
      return true;
    }
    return false;
  }

  heal(amount: number): void {
    this.hp = Math.min(this.maxHp, this.hp + amount);
  }

  update(dt: number, intent: MoveIntent): void {
    this.intent = intent;
    if (this.invulnerable > 0) this.invulnerable = Math.max(0, this.invulnerable - dt);
    if (!this.alive) return;

    // Only allow standing up if there's headroom.
    const wantsCrouch = intent.crouch;
    if (this.crouching && !wantsCrouch && this.hasHeadroom(PHYS.heightStand)) this.crouching = false;
    else if (wantsCrouch) this.crouching = true;

    this.sprinting = intent.sprint && !this.crouching && !intent.sneak && intent.forward > 0;

    this.accumulator += Math.min(dt, 0.25);
    let steps = 0;
    while (this.accumulator >= FIXED_STEP && steps < MAX_SUBSTEPS) {
      this.step(FIXED_STEP);
      this.accumulator -= FIXED_STEP;
      steps++;
    }
    if (steps === MAX_SUBSTEPS) this.accumulator = 0;

    // Catch the camera up to the body. Decayed on the real frame delta rather
    // than per substep so the ease looks the same at any framerate.
    if (this.viewOffset !== 0) {
      this.viewOffset *= Math.exp(-dt * PHYS.stepSmoothRate);
      if (Math.abs(this.viewOffset) < 0.002) this.viewOffset = 0;
    }
  }

  private step(dt: number): void {
    const v = this.velocity;

    // Water slows you and lets you bob back up, like AoS wading.
    this.wading = this.isInWater();

    // --- jump (edge triggered, resolved first like AoS MovePlayer) ---
    if (this.intent.jump) {
      if (!this.lastJump && !this.airborne) {
        v.y = PHYS.jumpImpulse;
        this.airborne = true;
        this.lastJump = true;
      }
    } else {
      this.lastJump = false;
    }

    // --- horizontal acceleration ---
    let accel = dt * this.intent.speedScale;
    if (this.airborne) accel *= PHYS.airControl;
    else if (this.crouching) accel *= PHYS.crouchSpeed;
    else if (this.intent.sneak || this.intent.aiming) accel *= PHYS.sneakSpeed;
    else if (this.sprinting) accel *= PHYS.sprintSpeed;

    let fx = this.intent.forward;
    let sx = this.intent.strafe;
    const mag = Math.hypot(fx, sx);
    if (mag > 1e-4) {
      fx /= mag;
      sx /= mag;
      // Steep pitch bleeds forward speed; strafing is untouched, as in AoS.
      const vert = Math.abs(Math.sin(this.pitch));
      const over = Math.max(vert - PHYS.vertLookSlowdownStart, 0);
      fx *= 1 - (over / (1 - PHYS.vertLookSlowdownStart)) * PHYS.vertLookSlowdownMax;
      // Camera basis: forward = (-sin yaw, -cos yaw), right = (cos yaw, -sin yaw).
      const sy = Math.sin(this.yaw);
      const cy = Math.cos(this.yaw);
      v.x += (cy * sx - sy * fx) * accel;
      v.z += (-cy * fx - sy * sx) * accel;
    }

    // --- gravity + air friction (AoS: v += dt; v /= dt + 1) ---
    const airF = dt + 1;
    v.y -= dt * PHYS.gravity;
    v.y /= airF;

    // --- horizontal friction ---
    let f = 1;
    if (this.wading) f = dt * PHYS.waterFriction + 1;
    else if (!this.airborne) f = dt * PHYS.groundFriction + 1;
    v.x /= f;
    v.z /= f;

    const fallSpeed = v.y;
    this.moveAndCollide(dt);

    // Landed this step?
    if (v.y === 0 && fallSpeed < -PHYS.fallSlowDown) {
      const speed = -fallSpeed;
      this.onLand?.(speed);
      if (speed > PHYS.fallDamageVelocity && !this.wading) {
        const over = speed - PHYS.fallDamageVelocity;
        const dmg = Math.floor(over * over * PHYS.fallDamageScalar);
        if (dmg > 0) {
          this.onFallDamage?.(dmg);
          this.damage(dmg);
        }
      }
      // Heavy landings kill your momentum.
      v.x *= 0.5;
      v.z *= 0.5;
    }
  }

  // -------------------------------------------------------------------------
  // Collision
  // -------------------------------------------------------------------------
  private moveAndCollide(dt: number): void {
    const scale = PHYS.velocityScale * dt;
    const dx = this.velocity.x * scale;
    const dy = this.velocity.y * scale;
    const dz = this.velocity.z * scale;

    const wasGrounded = !this.airborne;
    this.airborne = true;
    this.climbed = false;

    // Y first so we land cleanly before resolving horizontal motion.
    if (dy !== 0) {
      this.position.y += dy;
      if (this.overlaps()) {
        this.position.y -= dy;
        // Binary-search onto the surface so we sit flush against it.
        let lo = 0;
        let hi = dy;
        for (let i = 0; i < 8; i++) {
          const mid = (lo + hi) * 0.5;
          this.position.y += mid;
          if (this.overlaps()) hi = mid; else lo = mid;
          this.position.y -= mid;
        }
        this.position.y += lo;
        if (dy < 0) this.airborne = false;
        this.velocity.y = 0;
      }
    }

    this.resolveAxis(dx, 0, wasGrounded);
    this.resolveAxis(0, dz, wasGrounded);

    // AoS charges half your horizontal speed for mantling a lip.
    if (this.climbed) {
      this.velocity.x *= PHYS.climbSpeedPenalty;
      this.velocity.z *= PHYS.climbSpeedPenalty;
    }

    // Snap back to grounded when we're resting on something.
    if (this.airborne && this.velocity.y <= 0) {
      this.position.y -= 0.02;
      if (this.overlaps()) this.airborne = false;
      this.position.y += 0.02;
    }

    // Walked off a one-block lip: stick to the ground and take the drop now
    // instead of falling for a fifth of a second. Keeps friction, control and
    // footsteps alive on the way down a staircase; the camera eases the drop.
    if (this.airborne && wasGrounded && this.velocity.y <= 0 && (dx !== 0 || dz !== 0)) {
      const drop = this.dropToGround(PHYS.stepHeight);
      if (drop > 0) {
        this.position.y -= drop;
        this.velocity.y = 0;
        this.airborne = false;
        this.addViewOffset(drop);
      }
    }

    if (this.position.y < -8) {
      // Fell out of the world.
      this.hp = 0;
      this.alive = false;
    }
  }

  private resolveAxis(dx: number, dz: number, grounded: boolean): void {
    if (dx === 0 && dz === 0) return;
    this.position.x += dx;
    this.position.z += dz;
    if (!this.overlaps()) {
      const moved = Math.hypot(dx, dz);
      this.lastStepDistance += moved;
      // One bob cycle per footstep, so the camera and the audio stay in phase.
      this.bobPhase += moved / PHYS.stepDistance;
      return;
    }

    // Try stepping up over a 1-block lip before giving up. AoS refuses to
    // mantle while crouched, sprinting, or looking steeply down.
    const canClimb = grounded && !this.crouching && !this.sprinting
      && Math.sin(this.pitch) > -0.5;
    if (canClimb) {
      for (let lift = 0.25; lift <= PHYS.stepHeight + 0.001; lift += 0.25) {
        this.position.y += lift;
        if (!this.overlaps() && this.hasHeadroom(this.height)) {
          this.airborne = false;
          this.climbed = true;
          this.addViewOffset(-lift);
          return;
        }
        this.position.y -= lift;
      }
    }

    this.position.x -= dx;
    this.position.z -= dz;
    if (dx !== 0) this.velocity.x = 0;
    if (dz !== 0) this.velocity.z = 0;
  }

  /** Never lag by more than the height of one step, however many we take. */
  private addViewOffset(amount: number): void {
    this.viewOffset = THREE.MathUtils.clamp(
      this.viewOffset + amount, -PHYS.stepHeight, PHYS.stepHeight,
    );
  }

  /**
   * Distance down to the surface under our feet, or 0 if there isn't one
   * within `maxDrop` (i.e. this is a real fall, not a step).
   */
  private dropToGround(maxDrop: number): number {
    const r = PHYS.playerRadius;
    const x0 = Math.floor(this.position.x - r);
    const x1 = Math.floor(this.position.x + r);
    const z0 = Math.floor(this.position.z - r);
    const z1 = Math.floor(this.position.z + r);
    const lowest = Math.floor(this.position.y - maxDrop);
    for (let y = Math.floor(this.position.y - 0.001); y >= lowest; y--)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++)
          if (this.world.isSolid(x, y, z)) {
            const drop = this.position.y - (y + 1);
            return drop > 0 && drop <= maxDrop ? drop : 0;
          }
    return 0;
  }

  /** AABB vs voxel grid. */
  private overlaps(): boolean {
    const r = PHYS.playerRadius;
    const h = this.height;
    const x0 = Math.floor(this.position.x - r);
    const x1 = Math.floor(this.position.x + r);
    const z0 = Math.floor(this.position.z - r);
    const z1 = Math.floor(this.position.z + r);
    const y0 = Math.floor(this.position.y + 0.001);
    const y1 = Math.floor(this.position.y + h - 0.001);

    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++)
          if (this.world.isSolid(x, y, z)) return true;
    return false;
  }

  private hasHeadroom(height: number): boolean {
    const r = PHYS.playerRadius;
    const x0 = Math.floor(this.position.x - r);
    const x1 = Math.floor(this.position.x + r);
    const z0 = Math.floor(this.position.z - r);
    const z1 = Math.floor(this.position.z + r);
    const y0 = Math.floor(this.position.y + this.height);
    const y1 = Math.floor(this.position.y + height - 0.001);
    for (let y = y0; y <= y1 && y < WORLD_Y; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++)
          if (this.world.isSolid(x, y, z)) return false;
    return true;
  }

  private isInWater(): boolean {
    const y = Math.floor(this.position.y + 0.3);
    return this.world.isSolid(Math.floor(this.position.x), y, Math.floor(this.position.z)) === false
      && y <= 18 && this.position.y < 18.5;
  }
}
