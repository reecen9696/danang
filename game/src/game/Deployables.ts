import * as THREE from 'three';
import type { Bot } from '../ai/Bot';
import type { BotManager } from '../ai/BotManager';
import type { VoxelWorld } from '../voxel/VoxelWorld';
import { hasLineOfSight } from '../voxel/raycast';
import { WORLD_Y } from '../core/constants';

/**
 * Things the player buys from the Defense Merchant and physically puts down in
 * the base during prep.
 *
 * Barricades are not in here as entities: they're stamped straight into the
 * voxel world as sandbags, so they collide, take fire, block pathing and can be
 * patched with the block tool exactly like anything else the player builds.
 * Only the two that need behaviour of their own — a gun that aims, and a crate
 * you take ammo out of — live as entities.
 */
export const enum DeployId {
  Barricade = 'barricade',
  FiringBarricade = 'firing-barricade',
  Turret = 'turret',
  AmmoCrate = 'ammo-crate',
}

export interface DeployDef {
  readonly id: DeployId;
  readonly name: string;
  /** Footprint in blocks; the placement check needs room for all of it. */
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  /** How many of this kind may stand at once. */
  readonly maxPlaced: number;
  /**
   * Barricades only: the wall as a vertical slice, bottom row first, read left
   * to right along the wall. `#` is a sandbag, `.` is left open.
   */
  readonly pattern?: readonly string[];
}

/**
 * The firing barricade is the same two blocks high as the plain one, with the
 * middle of its top row left out. That puts the loophole at 1..2, which is
 * crouched eye height (1.35): duck behind it and you are fully covered and
 * still shooting, stand up and you fight over the top of it like any other
 * sandbag wall.
 */
export const DEPLOYABLES: Readonly<Record<DeployId, DeployDef>> = {
  [DeployId.Barricade]: {
    id: DeployId.Barricade, name: 'Sandbag Barricade',
    width: 3, depth: 1, height: 2, maxPlaced: Infinity,
    pattern: ['###', '###'],
  },
  [DeployId.FiringBarricade]: {
    id: DeployId.FiringBarricade, name: 'Firing Barricade',
    width: 3, depth: 1, height: 2, maxPlaced: Infinity,
    pattern: ['###', '#.#'],
  },
  [DeployId.Turret]: {
    id: DeployId.Turret, name: 'Sentry Turret',
    width: 1, depth: 1, height: 2, maxPlaced: 4,
  },
  [DeployId.AmmoCrate]: {
    id: DeployId.AmmoCrate, name: 'Ammo Crate',
    width: 1, depth: 1, height: 1, maxPlaced: 3,
  },
};

/** Order the deploy slot cycles through. */
export const DEPLOY_ORDER: readonly DeployId[] = [
  DeployId.Barricade, DeployId.FiringBarricade, DeployId.Turret, DeployId.AmmoCrate,
];

/** Does this deployable's wall fill the cell at column `col`, row `row`? */
export function occupies(def: DeployDef, col: number, row: number): boolean {
  if (!def.pattern) return true;
  return def.pattern[row]?.[col] === '#';
}

// --- Turret tuning ---------------------------------------------------------
export const TURRET = {
  hp: 500,
  /** Rounds it holds. Out of ammo is the turret's real limit, not its health. */
  ammo: 260,
  range: 40,
  damage: 24,
  delay: 0.17,
  /** Radians per second the head swings. */
  turnRate: 5.2,
  /** How far off-target it will still take the shot. */
  aimTolerance: 0.11,
  /** Seconds between target searches — one sweep per turret, not per frame. */
  retarget: 0.3,
  /** Height of the muzzle above the turret's feet. */
  muzzleY: 1.15,
} as const;

export const CRATE = {
  hp: 220,
  /** Resupplies before it's empty. */
  charges: 4,
  /** How close the player has to stand to take from it. */
  reach: 3.2,
} as const;

const CRATE_OLIVE = 0x4c5533;
const CRATE_TRIM = 0x2f3620;
const TURRET_BODY = 0x40474b;
const TURRET_DARK = 0x272c2f;
const TURRET_BARREL = 0x1b1f21;
const LAMP_LIVE = 0x59d16b;
const LAMP_DRY = 0xd14a3a;

const box = new THREE.BoxGeometry(1, 1, 1);

function part(color: number, sx: number, sy: number, sz: number, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(box, new THREE.MeshLambertMaterial({ color, fog: true }));
  m.scale.set(sx, sy, sz);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Shared base class: a thing standing on a block column with hit points. */
export abstract class Placed {
  readonly group = new THREE.Group();
  hp: number;
  readonly maxHp: number;
  /** Voxel column it stands on; the group sits at the centre of it. */
  constructor(readonly vx: number, readonly vy: number, readonly vz: number, hp: number) {
    this.hp = hp;
    this.maxHp = hp;
    this.group.position.set(vx + 0.5, vy, vz + 0.5);
  }

  get x(): number { return this.vx + 0.5; }
  get z(): number { return this.vz + 0.5; }

  abstract dispose(): void;
}

export class Turret extends Placed {
  private readonly head = new THREE.Group();
  private readonly lamp: THREE.Mesh;

  ammo: number = TURRET.ammo;
  yaw: number;
  /** Barrel elevation, so it can look down at something at its feet. */
  pitch = 0;
  cooldown = 0;
  /** Counts down to the next target sweep. */
  private searchTimer = 0;
  target: Bot | null = null;
  /** Blinks the muzzle flash for a couple of frames after a shot. */
  flash = 0;

  constructor(vx: number, vy: number, vz: number, yaw: number) {
    super(vx, vy, vz, TURRET.hp);
    this.yaw = yaw;

    const legs = part(TURRET_DARK, 1.0, 0.18, 1.0, 0, 0.09);
    const post = part(TURRET_DARK, 0.34, 0.72, 0.34, 0, 0.54);
    const body = part(TURRET_BODY, 0.86, 0.5, 0.7, 0, 0.25);
    const drum = part(TURRET_DARK, 0.5, 0.34, 0.3, 0, 0.2, -0.42);
    const barrel = part(TURRET_BARREL, 0.14, 0.14, 1.05, 0, 0.06, 0.62);
    this.lamp = part(LAMP_LIVE, 0.12, 0.12, 0.12, 0.3, 0.5, -0.3);
    this.lamp.castShadow = false;

    this.head.position.y = TURRET.muzzleY - 0.2;
    this.head.rotation.order = 'YXZ';
    this.head.add(body, drum, barrel, this.lamp);
    this.group.add(legs, post, this.head);
    this.group.rotation.y = 0;
    this.head.rotation.y = yaw;
  }

  get muzzleY(): number { return this.vy + TURRET.muzzleY; }

  get dry(): boolean { return this.ammo <= 0; }

  refill(): void {
    this.ammo = TURRET.ammo;
  }

  /**
   * Picks a target, tracks it and reports back the frame it fires.
   *
   * The caller owns everything the shot then does — tracer, damage, sound —
   * because all of that already exists on the game side for the player's own
   * bullets and a turret firing should look identical.
   */
  update(dt: number, world: VoxelWorld, bots: BotManager): Bot | null {
    if (this.cooldown > 0) this.cooldown -= dt;
    if (this.flash > 0) this.flash -= dt;
    (this.lamp.material as THREE.MeshLambertMaterial).color.setHex(this.dry ? LAMP_DRY : LAMP_LIVE);

    if (this.dry) return null;

    this.searchTimer -= dt;
    if (this.searchTimer <= 0) {
      this.searchTimer = TURRET.retarget;
      this.target = this.findTarget(world, bots);
    }

    const t = this.target;
    if (!t || !t.alive) { this.target = null; return null; }

    const mx = this.x, my = this.muzzleY, mz = this.z;
    const tx = t.position.x;
    const ty = t.position.y + t.poseHeight * 0.55;
    const tz = t.position.z;

    const wantYaw = Math.atan2(tx - mx, tz - mz);
    const flat = Math.hypot(tx - mx, tz - mz);
    const wantPitch = -Math.atan2(ty - my, Math.max(0.001, flat));

    // Shortest way round, so a target crossing behind it doesn't spin the head
    // the long way.
    let dy = ((wantYaw - this.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    const step = TURRET.turnRate * dt;
    dy = Math.max(-step, Math.min(step, dy));
    this.yaw += dy;
    this.pitch += Math.max(-step, Math.min(step, wantPitch - this.pitch));

    this.head.rotation.y = this.yaw;
    this.head.rotation.x = this.pitch;

    if (this.cooldown > 0) return null;
    if (Math.abs(((wantYaw - this.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI) > TURRET.aimTolerance) {
      return null;
    }

    this.cooldown = TURRET.delay;
    this.ammo--;
    this.flash = 0.05;
    return t;
  }

  /** Nearest living bot in range that the muzzle can actually see. */
  private findTarget(world: VoxelWorld, bots: BotManager): Bot | null {
    const mx = this.x, my = this.muzzleY, mz = this.z;
    let best: Bot | null = null;
    let bestD: number = TURRET.range;
    for (const bot of bots.bots) {
      if (!bot.alive) continue;
      const d = Math.hypot(bot.position.x - mx, bot.position.z - mz);
      if (d >= bestD) continue;
      if (!hasLineOfSight(
        world, mx, my, mz,
        bot.position.x, bot.position.y + bot.poseHeight * 0.55, bot.position.z,
      )) continue;
      best = bot;
      bestD = d;
    }
    return best;
  }

  /** World-space muzzle tip, for the tracer origin. */
  muzzle(out: THREE.Vector3): THREE.Vector3 {
    const cp = Math.cos(this.pitch);
    return out.set(
      this.x + Math.sin(this.yaw) * cp * 1.1,
      this.muzzleY - Math.sin(this.pitch) * 1.1,
      this.z + Math.cos(this.yaw) * cp * 1.1,
    );
  }

  dispose(): void {
    for (const child of this.group.children) {
      if (child instanceof THREE.Mesh) (child.material as THREE.Material).dispose();
    }
    for (const child of this.head.children) {
      if (child instanceof THREE.Mesh) (child.material as THREE.Material).dispose();
    }
  }
}

export class AmmoCrate extends Placed {
  charges: number = CRATE.charges;
  private readonly lid: THREE.Mesh;

  constructor(vx: number, vy: number, vz: number, yaw: number) {
    super(vx, vy, vz, CRATE.hp);
    const body = part(CRATE_OLIVE, 0.9, 0.55, 0.62, 0, 0.28);
    this.lid = part(CRATE_TRIM, 0.94, 0.1, 0.66, 0, 0.58);
    const strap = part(CRATE_TRIM, 0.16, 0.57, 0.64, 0.26, 0.28);
    const strap2 = part(CRATE_TRIM, 0.16, 0.57, 0.64, -0.26, 0.28);
    this.group.add(body, this.lid, strap, strap2);
    this.group.rotation.y = yaw;
  }

  get empty(): boolean { return this.charges <= 0; }

  /** Takes one resupply out of it. */
  take(): boolean {
    if (this.empty) return false;
    this.charges--;
    // The lid drops as it empties, so a spent crate reads as spent from across
    // the base rather than only in the prompt.
    this.lid.position.y = 0.58 - (1 - this.charges / CRATE.charges) * 0.24;
    return true;
  }

  dispose(): void {
    for (const child of this.group.children) {
      if (child instanceof THREE.Mesh) (child.material as THREE.Material).dispose();
    }
  }
}

/**
 * Owns everything the player has put down, and the translucent ghost that
 * shows where the next one would land.
 */
export class DeployableManager {
  readonly turrets: Turret[] = [];
  readonly crates: AmmoCrate[] = [];

  private readonly ghost = new THREE.Group();
  private readonly ghostCells: THREE.Mesh[] = [];
  private readonly ghostMat = new THREE.MeshBasicMaterial({
    color: 0x8fe08f, transparent: true, opacity: 0.3, depthWrite: false,
  });

  constructor(private readonly scene: THREE.Scene, private readonly world: VoxelWorld) {
    this.ghost.visible = false;
    this.scene.add(this.ghost);
  }

  countOf(id: DeployId): number {
    if (id === DeployId.Turret) return this.turrets.length;
    if (id === DeployId.AmmoCrate) return this.crates.length;
    return 0;
  }

  atCapacity(id: DeployId): boolean {
    return this.countOf(id) >= DEPLOYABLES[id].maxPlaced;
  }

  /**
   * Is there room for `def`'s footprint standing on this column?
   *
   * `vx, vz` is the centre column of the footprint and `vy` the first air block
   * above the ground. Every column under it has to be solid — no half-floating
   * turrets off the edge of a wall.
   */
  fits(def: DeployDef, vx: number, vy: number, vz: number, alongX: boolean): boolean {
    if (vy < 1 || vy + def.height > WORLD_Y) return false;
    const half = (def.width - 1) / 2;
    for (let i = -half; i <= half; i++) {
      const cx = vx + (alongX ? i : 0);
      const cz = vz + (alongX ? 0 : i);
      if (!this.world.isSolid(cx, vy - 1, cz)) return false;
      for (let h = 0; h < def.height; h++) {
        // Terrain standing in a loophole is fine — the wall just isn't built
        // there. Only the cells the wall actually fills have to be clear.
        if (!occupies(def, i + half, h)) continue;
        if (this.world.isSolid(cx, vy + h, cz)) return false;
      }
    }
    // Nothing already standing there.
    for (const t of this.turrets) if (t.vx === vx && t.vz === vz) return false;
    for (const c of this.crates) if (c.vx === vx && c.vz === vz) return false;
    return true;
  }

  addTurret(vx: number, vy: number, vz: number, yaw: number): Turret {
    const t = new Turret(vx, vy, vz, yaw);
    this.turrets.push(t);
    this.scene.add(t.group);
    return t;
  }

  addCrate(vx: number, vy: number, vz: number, yaw: number): AmmoCrate {
    const c = new AmmoCrate(vx, vy, vz, yaw);
    this.crates.push(c);
    this.scene.add(c.group);
    return c;
  }

  refillTurrets(): number {
    let n = 0;
    for (const t of this.turrets) {
      if (t.ammo >= TURRET.ammo) continue;
      t.refill();
      n++;
    }
    return n;
  }

  /** Nearest usable crate to a point, or null. */
  crateNear(x: number, y: number, z: number): AmmoCrate | null {
    let best: AmmoCrate | null = null;
    let bestD: number = CRATE.reach;
    for (const c of this.crates) {
      const d = Math.hypot(c.x - x, c.vy - y, c.z - z);
      if (d < bestD) { best = c; bestD = d; }
    }
    return best;
  }

  /**
   * Splash damage. Returns whatever the blast destroyed so the caller can throw
   * debris and say something about it.
   */
  damageInRadius(x: number, y: number, z: number, radius: number, damage: number): Placed[] {
    const dead: Placed[] = [];
    const hit = (p: Placed): void => {
      const d = Math.hypot(p.x - x, p.vy + 0.5 - y, p.z - z);
      if (d > radius) return;
      p.hp -= damage * (1 - d / radius);
      if (p.hp <= 0) dead.push(p);
    };
    for (const t of this.turrets) hit(t);
    for (const c of this.crates) hit(c);
    for (const p of dead) this.remove(p);
    return dead;
  }

  remove(p: Placed): void {
    const ti = this.turrets.indexOf(p as Turret);
    if (ti >= 0) this.turrets.splice(ti, 1);
    const ci = this.crates.indexOf(p as AmmoCrate);
    if (ci >= 0) this.crates.splice(ci, 1);
    this.scene.remove(p.group);
    p.dispose();
  }

  /**
   * Ticks every turret. `onFire` runs once per round that goes out, with the
   * muzzle position already resolved.
   */
  update(
    dt: number, bots: BotManager,
    onFire: (turret: Turret, target: Bot, muzzle: THREE.Vector3) => void,
    scratch: THREE.Vector3,
  ): void {
    for (const t of this.turrets) {
      const target = t.update(dt, this.world, bots);
      if (target) onFire(t, target, t.muzzle(scratch));
    }
  }

  /**
   * Draws the outline of what would be placed.
   *
   * One box per filled cell rather than one box over the whole footprint, so a
   * loophole reads as a loophole before you commit to it — and so a rotation
   * you can't see the effect of doesn't feel like a dead key.
   */
  showGhost(def: DeployDef, vx: number, vy: number, vz: number, alongX: boolean, ok: boolean): void {
    this.ghost.visible = true;
    const color = ok ? 0x8fe08f : 0xe06060;
    (this.ghostMat as THREE.MeshBasicMaterial).color.setHex(color);

    const half = (def.width - 1) / 2;
    let n = 0;
    for (let i = -half; i <= half; i++) {
      for (let h = 0; h < def.height; h++) {
        if (!occupies(def, i + half, h)) continue;
        const cell = this.ghostCell(n++);
        cell.visible = true;
        cell.scale.set(
          alongX ? 0.96 : def.depth * 0.96,
          0.96,
          alongX ? def.depth * 0.96 : 0.96,
        );
        cell.position.set(
          vx + (alongX ? i : 0) + 0.5,
          vy + h + 0.5,
          vz + (alongX ? 0 : i) + 0.5,
        );
      }
    }
    for (let i = n; i < this.ghostCells.length; i++) this.ghostCells[i].visible = false;
  }

  /** Grows the ghost's box pool on demand; footprints are small and fixed. */
  private ghostCell(i: number): THREE.Mesh {
    let cell = this.ghostCells[i];
    if (!cell) {
      cell = new THREE.Mesh(box, this.ghostMat);
      this.ghostCells.push(cell);
      this.ghost.add(cell);
    }
    return cell;
  }

  hideGhost(): void {
    this.ghost.visible = false;
  }

  clear(): void {
    for (const t of this.turrets.slice()) this.remove(t);
    for (const c of this.crates.slice()) this.remove(c);
    this.hideGhost();
  }
}
