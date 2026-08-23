import * as THREE from 'three';
import { WeaponId } from '../weapons/definitions';

interface Part {
  /** Centre offset, in model-local units. -Z points down the barrel. */
  x: number; y: number; z: number;
  /** Half-extents, so a part spans `centre +/- s`. */
  sx: number; sy: number; sz: number;
  color: number;
}

interface Model {
  parts: readonly Part[];
  /**
   * Height of the sight line: the top of the rear notch's shoulders, which the
   * front post's tip is levelled with. ADS drops the model by exactly this so
   * both land on the crosshair -- anything at this height projects to the
   * centre of the screen no matter how far down the barrel it sits.
   */
  sightY: number;
  /** How far in front of the eye the model sits while aiming. */
  adsZ: number;
  /** Muzzle tip, where the flash quad is parked. */
  muzzle: readonly [number, number, number];
}

/**
 * Shared palette so the guns read as one set of props.
 *
 * AoS' guns have no wood on them at all: they're a single dark gunmetal ramp,
 * near-black in the body with grey catching the top faces, which is what makes
 * them read as one solid silhouette against bright terrain. The ramp is
 * deliberately bottom-heavy -- four of the six steps sit below mid grey -- so
 * the highlights land only on edges and sight furniture.
 */
const GRIP = 0x474a50;
const GRIP_DARK = 0x2b2d32;
const STEEL = 0x585c63;
const STEEL_DARK = 0x35383e;
const STEEL_BLACK = 0x17181b;
const STEEL_LIGHT = 0x9aa0a8;
const TIP_RED = 0x8e2b26;

/**
 * Chunky low-poly gun models, built from many small boxes so they read as
 * voxel props rather than as smooth geometry.
 *
 * The rifle is the hero model: a bolt-action with a slab stock, a squared
 * receiver, a notched rear sight and a red-tipped front post, sized so the
 * ironsight picture fills the screen the way Ace of Spades' does.
 */
const MODELS: Record<string, Model> = {
  [WeaponId.Rifle]: {
    sightY: 0.225,
    adsZ: -0.50,
    muzzle: [0, 0.055, -1.32],
    parts: [
      // --- Wooden stock -----------------------------------------------
      { x: 0, y: -0.075, z: 0.20, sx: 0.052, sy: 0.090, sz: 0.15, color: GRIP_DARK },
      { x: 0, y: -0.055, z: -0.02, sx: 0.052, sy: 0.075, sz: 0.09, color: GRIP },
      { x: 0, y: -0.020, z: -0.14, sx: 0.050, sy: 0.055, sz: 0.06, color: GRIP },
      { x: 0, y: -0.115, z: -0.14, sx: 0.042, sy: 0.045, sz: 0.05, color: GRIP_DARK },
      // Cheek rest, the little step the reference model has behind the bolt.
      { x: 0, y: 0.035, z: -0.02, sx: 0.045, sy: 0.030, sz: 0.08, color: GRIP },

      // --- Receiver ---------------------------------------------------
      { x: 0, y: 0.000, z: -0.33, sx: 0.056, sy: 0.066, sz: 0.15, color: STEEL },
      { x: 0, y: 0.072, z: -0.33, sx: 0.042, sy: 0.020, sz: 0.13, color: STEEL_DARK },
      { x: 0, y: -0.072, z: -0.33, sx: 0.046, sy: 0.018, sz: 0.13, color: STEEL_DARK },
      // Bolt handle sticking out to the right.
      { x: 0.070, y: 0.020, z: -0.245, sx: 0.026, sy: 0.017, sz: 0.017, color: STEEL_LIGHT },
      { x: 0.100, y: 0.000, z: -0.245, sx: 0.021, sy: 0.021, sz: 0.021, color: STEEL_LIGHT },
      // Magazine box and trigger group.
      { x: 0, y: -0.110, z: -0.345, sx: 0.040, sy: 0.038, sz: 0.065, color: STEEL_DARK },
      { x: 0, y: -0.105, z: -0.235, sx: 0.018, sy: 0.026, sz: 0.028, color: STEEL_BLACK },

      // --- Rear sight: base plus two ears with a notch between them ----
      { x: 0, y: 0.128, z: -0.47, sx: 0.076, sy: 0.025, sz: 0.050, color: STEEL },
      { x: -0.051, y: 0.189, z: -0.47, sx: 0.026, sy: 0.036, sz: 0.046, color: STEEL_DARK },
      { x: 0.051, y: 0.189, z: -0.47, sx: 0.026, sy: 0.036, sz: 0.046, color: STEEL_DARK },

      // --- Handguard and barrel ---------------------------------------
      { x: 0, y: 0.010, z: -0.70, sx: 0.046, sy: 0.048, sz: 0.20, color: GRIP },
      { x: 0, y: 0.055, z: -0.72, sx: 0.026, sy: 0.026, sz: 0.20, color: STEEL_DARK },
      { x: 0, y: 0.030, z: -0.90, sx: 0.038, sy: 0.042, sz: 0.030, color: STEEL },
      { x: 0, y: 0.055, z: -1.05, sx: 0.024, sy: 0.024, sz: 0.30, color: STEEL_DARK },
      { x: 0, y: 0.055, z: -1.30, sx: 0.031, sy: 0.031, sz: 0.038, color: STEEL_BLACK },

      // --- Front sight: post on a base, red tip on top ----------------
      { x: 0, y: 0.116, z: -1.22, sx: 0.017, sy: 0.037, sz: 0.019, color: STEEL_DARK },
      { x: 0, y: 0.177, z: -1.22, sx: 0.010, sy: 0.024, sz: 0.012, color: STEEL_BLACK },
      { x: 0, y: 0.213, z: -1.22, sx: 0.011, sy: 0.012, sz: 0.013, color: TIP_RED },
    ],
  },

  [WeaponId.Pistol]: {
    sightY: 0.093,
    adsZ: -0.40,
    muzzle: [0, 0.020, -0.50],
    parts: [
      { x: 0, y: 0.020, z: -0.30, sx: 0.034, sy: 0.038, sz: 0.16, color: STEEL_DARK },
      { x: 0, y: -0.030, z: -0.28, sx: 0.030, sy: 0.028, sz: 0.13, color: STEEL },
      { x: 0, y: 0.020, z: -0.47, sx: 0.017, sy: 0.017, sz: 0.03, color: STEEL_BLACK },
      { x: 0, y: -0.130, z: -0.14, sx: 0.032, sy: 0.082, sz: 0.048, color: GRIP_DARK },
      { x: 0, y: -0.075, z: -0.235, sx: 0.017, sy: 0.024, sz: 0.024, color: STEEL_BLACK },
      { x: -0.024, y: 0.076, z: -0.20, sx: 0.011, sy: 0.017, sz: 0.014, color: STEEL_BLACK },
      { x: 0.024, y: 0.076, z: -0.20, sx: 0.011, sy: 0.017, sz: 0.014, color: STEEL_BLACK },
      { x: 0, y: 0.077, z: -0.44, sx: 0.009, sy: 0.016, sz: 0.012, color: STEEL_BLACK },
    ],
  },

  [WeaponId.SMG]: {
    sightY: 0.134,
    adsZ: -0.42,
    muzzle: [0, 0.030, -0.82],
    parts: [
      { x: 0, y: 0.000, z: -0.36, sx: 0.044, sy: 0.052, sz: 0.24, color: STEEL_DARK },
      { x: 0, y: 0.062, z: -0.36, sx: 0.034, sy: 0.024, sz: 0.22, color: STEEL },
      { x: 0, y: -0.030, z: -0.58, sx: 0.036, sy: 0.034, sz: 0.12, color: STEEL_BLACK },
      { x: 0, y: 0.030, z: -0.66, sx: 0.019, sy: 0.019, sz: 0.16, color: STEEL_DARK },
      { x: 0, y: 0.030, z: -0.80, sx: 0.025, sy: 0.025, sz: 0.03, color: STEEL_BLACK },
      { x: 0, y: -0.165, z: -0.30, sx: 0.030, sy: 0.115, sz: 0.046, color: STEEL_DARK },
      { x: 0, y: -0.115, z: -0.11, sx: 0.030, sy: 0.072, sz: 0.042, color: STEEL_BLACK },
      { x: 0, y: -0.070, z: -0.20, sx: 0.016, sy: 0.024, sz: 0.024, color: STEEL_BLACK },
      { x: 0, y: 0.000, z: -0.03, sx: 0.018, sy: 0.018, sz: 0.12, color: STEEL },
      { x: 0, y: -0.010, z: 0.11, sx: 0.028, sy: 0.048, sz: 0.020, color: STEEL_DARK },
      { x: -0.030, y: 0.108, z: -0.22, sx: 0.013, sy: 0.026, sz: 0.016, color: STEEL_BLACK },
      { x: 0.030, y: 0.108, z: -0.22, sx: 0.013, sy: 0.026, sz: 0.016, color: STEEL_BLACK },
      { x: 0, y: 0.076, z: -0.76, sx: 0.020, sy: 0.022, sz: 0.018, color: STEEL_DARK },
      { x: 0, y: 0.116, z: -0.76, sx: 0.008, sy: 0.018, sz: 0.012, color: STEEL_BLACK },
    ],
  },

  [WeaponId.Shotgun]: {
    sightY: 0.100,
    adsZ: -0.62,
    muzzle: [0, 0.048, -1.18],
    parts: [
      { x: 0, y: 0.000, z: -0.38, sx: 0.050, sy: 0.058, sz: 0.19, color: STEEL_DARK },
      { x: 0, y: 0.062, z: -0.38, sx: 0.038, sy: 0.020, sz: 0.17, color: STEEL },
      { x: 0, y: -0.055, z: 0.14, sx: 0.050, sy: 0.078, sz: 0.20, color: GRIP_DARK },
      { x: 0, y: -0.030, z: -0.15, sx: 0.044, sy: 0.055, sz: 0.11, color: GRIP },
      { x: 0, y: -0.098, z: -0.26, sx: 0.018, sy: 0.026, sz: 0.028, color: STEEL_BLACK },
      { x: 0, y: -0.048, z: -0.70, sx: 0.044, sy: 0.040, sz: 0.15, color: GRIP },
      { x: 0, y: -0.030, z: -0.88, sx: 0.021, sy: 0.021, sz: 0.28, color: STEEL_DARK },
      { x: 0, y: 0.048, z: -0.80, sx: 0.027, sy: 0.027, sz: 0.42, color: STEEL_DARK },
      { x: 0, y: 0.048, z: -1.20, sx: 0.032, sy: 0.032, sz: 0.035, color: STEEL_BLACK },
      { x: 0, y: 0.088, z: -1.14, sx: 0.010, sy: 0.012, sz: 0.012, color: TIP_RED },
    ],
  },

  [WeaponId.Spade]: {
    sightY: 0, adsZ: -0.7, muzzle: [0, 0, -0.7],
    parts: [
      { x: 0, y: -0.05, z: -0.20, sx: 0.030, sy: 0.030, sz: 0.14, color: 0x6b4a2c },
      { x: 0, y: -0.05, z: -0.42, sx: 0.026, sy: 0.026, sz: 0.10, color: 0x7d5836 },
      { x: 0, y: -0.03, z: -0.58, sx: 0.030, sy: 0.024, sz: 0.08, color: 0x8d9099 },
      { x: 0, y: 0.010, z: -0.70, sx: 0.100, sy: 0.018, sz: 0.10, color: 0x9aa0a8 },
      { x: 0, y: 0.010, z: -0.82, sx: 0.075, sy: 0.014, sz: 0.05, color: 0xaab0b8 },
    ],
  },

  [WeaponId.Block]: {
    sightY: 0, adsZ: -0.7, muzzle: [0, 0, -0.6],
    parts: [
      { x: 0, y: -0.06, z: -0.42, sx: 0.16, sy: 0.16, sz: 0.16, color: 0xb0824f },
    ],
  },

  [WeaponId.Grenade]: {
    sightY: 0, adsZ: -0.7, muzzle: [0, 0, -0.4],
    parts: [
      { x: 0, y: -0.06, z: -0.34, sx: 0.075, sy: 0.095, sz: 0.075, color: 0x39421f },
      { x: 0, y: 0.05, z: -0.34, sx: 0.045, sy: 0.022, sz: 0.045, color: 0x2c331a },
      { x: 0, y: 0.08, z: -0.34, sx: 0.022, sy: 0.020, sz: 0.022, color: 0x8d9099 },
      { x: 0.05, y: 0.07, z: -0.34, sx: 0.035, sy: 0.008, sz: 0.010, color: 0x8d9099 },
    ],
  },
};

/** The models are authored at world scale; shrink them for the view camera. */
const MODEL_SCALE = 1.25;
/**
 * The scale the ADS offsets in `MODELS` were authored against. Growing
 * `MODEL_SCALE` also pushes the sights further down -Z, so the ADS offsets are
 * scaled by the same ratio -- otherwise a bigger model would shove its rear
 * sight into the eye.
 */
const ADS_REFERENCE_SCALE = 0.55;
/**
 * Extra pull towards the eye while aiming, on top of that ratio. Under 1 the
 * sight picture grows, which is what AoS' oversized ironsights look like.
 */
const ADS_CLOSENESS = 0.85;

/**
 * Hipfire hold angles, in radians. AoS never points the gun straight down the
 * view axis -- the model is yawed in towards the crosshair, pitched up a touch
 * and rolled so its top face catches the light, which is what gives that
 * signature barrel running diagonally across the lower right of the screen.
 *
 * All three blend out to zero as the sights come up: at full ADS the model has
 * to sit square on the view axis or the sight picture skews.
 */
const HIP_YAW = 0.14;
const HIP_PITCH = 0.03;
const HIP_ROLL = 0.06;

/**
 * Per-face brightness, in BoxGeometry's face order (+X, -X, +Y, -Y, +Z, -Z).
 *
 * The viewmodel uses unlit materials so it can't be lit by the world's light,
 * and without this every box reads as one flat silhouette. Baking a fixed key
 * light into vertex colours costs nothing and gives the parts the same faceted
 * look the terrain has.
 */
const FACE_SHADE = [0.88, 0.70, 1.0, 0.55, 0.94, 0.76];

/** A unit cube whose vertex colours carry the face shading above. */
function shadedBox(): THREE.BoxGeometry {
  const geom = new THREE.BoxGeometry(1, 1, 1);
  const count = geom.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let v = 0; v < count; v++) {
    // Four vertices per face, in face order.
    const shade = FACE_SHADE[Math.min(5, (v / 4) | 0)];
    colors[v * 3] = shade;
    colors[v * 3 + 1] = shade;
    colors[v * 3 + 2] = shade;
  }
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geom;
}

/**
 * First-person weapon model with sway, bob, recoil and ADS.
 *
 * It lives on its own camera layer rendered after the world with a cleared
 * depth buffer, so the gun never clips into a wall you're standing against.
 */
export class ViewModel {
  readonly group = new THREE.Group();

  private readonly meshes = new Map<string, THREE.Group>();
  /** Where each model must sit for its sights to land on the crosshair. */
  private readonly adsTargets = new Map<string, THREE.Vector3>();
  private readonly muzzleTargets = new Map<string, THREE.Vector3>();
  private current: THREE.Group | null = null;

  private readonly muzzle = new THREE.PointLight(0xffd08a, 0, 12);
  private readonly muzzleFlash: THREE.Mesh;
  private flashTimer = 0;

  private recoilZ = 0;
  private recoilPitch = 0;
  private swayX = 0;
  private swayY = 0;
  private adsBlend = 0;
  private bobTime = 0;

  // Held close to the eye and hard right, the way AoS parks its gun. At this
  // X the rear of the model sits outside the frustum entirely -- anything
  // nearer than ~0.48 is off-frame -- so the stock reaching the near plane
  // under recoil never shows.
  private readonly basePos = new THREE.Vector3(0.44, -0.24, -0.60);
  private readonly adsPos = new THREE.Vector3(0, -0.1, -0.7);

  constructor() {
    this.group.name = 'viewmodel';
    this.group.scale.setScalar(MODEL_SCALE);

    const geom = shadedBox();
    for (const [id, model] of Object.entries(MODELS)) {
      const g = new THREE.Group();
      for (const p of model.parts) {
        const mat = new THREE.MeshBasicMaterial({
          color: p.color, fog: false, vertexColors: true,
        });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.position.set(p.x, p.y, p.z);
        mesh.scale.set(p.sx * 2, p.sy * 2, p.sz * 2);
        g.add(mesh);
      }
      g.visible = false;
      this.meshes.set(id, g);
      this.group.add(g);

      // Aiming puts the sight line on the camera axis: the model offset has to
      // cancel the sight's own height, after the group scale is applied.
      const adsZ = model.adsZ * (MODEL_SCALE / ADS_REFERENCE_SCALE) * ADS_CLOSENESS;
      this.adsTargets.set(id, new THREE.Vector3(0, -model.sightY * MODEL_SCALE, adsZ));
      this.muzzleTargets.set(id, new THREE.Vector3(...model.muzzle));
    }

    const flashGeom = new THREE.PlaneGeometry(0.36, 0.36);
    const flashMat = new THREE.MeshBasicMaterial({
      color: 0xffd98a, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    this.muzzleFlash = new THREE.Mesh(flashGeom, flashMat);
    this.muzzleFlash.position.set(0, 0.02, -0.9);
    this.group.add(this.muzzleFlash);
    this.group.add(this.muzzle);
  }

  select(id: WeaponId): void {
    const next = this.meshes.get(id) ?? null;
    if (next === this.current) return;
    if (this.current) this.current.visible = false;
    this.current = next;
    if (next) next.visible = true;

    const ads = this.adsTargets.get(id);
    if (ads) this.adsPos.copy(ads);
    const tip = this.muzzleTargets.get(id);
    if (tip) {
      this.muzzleFlash.position.copy(tip);
      this.muzzle.position.copy(tip);
    }

    // Little raise animation when swapping.
    this.recoilZ = -0.18;
  }

  fire(recoilAmount: number, flashSize: number): void {
    // Capped so a held-down SMG can't walk the stock back through the near plane.
    this.recoilZ = Math.min(0.24, this.recoilZ + 0.09 + recoilAmount * 1.4);
    this.recoilPitch = Math.min(0.24, this.recoilPitch + recoilAmount * 2.2);
    if (flashSize > 0) {
      this.flashTimer = flashSize;
      this.muzzleFlash.scale.setScalar(0.7 + flashSize * 6);
      this.muzzleFlash.rotation.z = Math.random() * Math.PI;
    }
  }

  update(
    dt: number,
    lookDeltaX: number, lookDeltaY: number,
    moveSpeed: number, grounded: boolean,
    ads: boolean, reloading: boolean,
  ): void {
    // Sway trails the mouse for weight.
    this.swayX += (-lookDeltaX * 0.02 - this.swayX) * Math.min(1, dt * 12);
    this.swayY += (-lookDeltaY * 0.02 - this.swayY) * Math.min(1, dt * 12);
    this.swayX = THREE.MathUtils.clamp(this.swayX, -0.06, 0.06);
    this.swayY = THREE.MathUtils.clamp(this.swayY, -0.06, 0.06);

    this.adsBlend += ((ads ? 1 : 0) - this.adsBlend) * Math.min(1, dt * 14);

    this.recoilZ *= Math.max(0, 1 - dt * 11);
    this.recoilPitch *= Math.max(0, 1 - dt * 9);

    this.bobTime += dt * moveSpeed * (grounded ? 1.5 : 0.2);
    const bobAmp = (1 - this.adsBlend * 0.8) * Math.min(0.035, moveSpeed * 0.004);
    const bobX = Math.sin(this.bobTime) * bobAmp;
    const bobY = Math.abs(Math.cos(this.bobTime)) * bobAmp * -0.9;

    // Sway and bob would walk the sights off the crosshair, so they fade out
    // as the aim settles -- at full ADS the sight picture is rock steady.
    const settle = 1 - this.adsBlend;
    const target = this.basePos.clone().lerp(this.adsPos, this.adsBlend);
    this.group.position.set(
      target.x + (this.swayX + bobX) * settle,
      target.y + (this.swayY + bobY) * settle,
      target.z + this.recoilZ,
    );

    // Reload tilt, on top of the hipfire hold. `settle` fades the hold out with
    // the same curve as the sway, so aiming squares the model up.
    const reloadTilt = reloading ? -0.5 : 0;
    const pitch = this.recoilPitch + reloadTilt + HIP_PITCH * settle;
    const yaw = HIP_YAW * settle;
    const roll = (reloading ? 0.35 : 0) + HIP_ROLL * settle;
    this.group.rotation.x += (pitch - this.group.rotation.x) * Math.min(1, dt * 12);
    this.group.rotation.y += (yaw - this.group.rotation.y) * Math.min(1, dt * 12);
    this.group.rotation.z += (roll - this.group.rotation.z) * Math.min(1, dt * 10);

    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      const on = this.flashTimer > 0;
      (this.muzzleFlash.material as THREE.MeshBasicMaterial).opacity = on ? 0.9 : 0;
      this.muzzle.intensity = on ? 4 : 0;
    } else {
      (this.muzzleFlash.material as THREE.MeshBasicMaterial).opacity = 0;
      this.muzzle.intensity = 0;
    }
  }

  get adsAmount(): number {
    return this.adsBlend;
  }
}
