import * as THREE from 'three';

/**
 * Leaves torn out of the canopy.
 *
 * Everything else in the world breaks into cubes, and for earth and stone and
 * corrugated iron that is right. Foliage was going the same way, and a burst
 * into a tree threw a puff of green points that read as gas rather than as a
 * tree being shot: a canopy is not made of chips, it is made of flat things
 * that come off whole and take a long time to reach the ground.
 *
 * So a round into the jungle throws leaves. They are real quads with a real
 * orientation rather than billboards -- a leaf that always faces you never
 * reads as flat -- and each one tumbles about its own axis while a slow spiral
 * carries it sideways on the way down, which is the whole of what makes a
 * falling leaf recognisable. When one meets a surface it stops turning and lies
 * down flat on it, and the ground under a tree that has been worked over ends
 * up covered before the leaves time out.
 *
 * One instanced draw call, lit by the same sun as the terrain, and pooled the
 * way the particles are: a dead leaf is swapped with the last live one.
 */

/**
 * Leaves alive at once. A magazine into a treeline spends them fast, which is
 * the point at which the oldest ones are worth dropping.
 */
const MAX_LEAVES = 640;

/** Blocks/sec^2. Far below the 22-24 the debris particles fall at. */
const GRAVITY = 5.5;
/** Blocks/sec a leaf settles to. Anything faster stops reading as a leaf. */
const TERMINAL = 2.6;
/** How hard the air bleeds off whatever threw the leaf, per second. */
const DRAG = 1.6;
/** Blocks/sec^2 of sideways push from the spiral, and how fast it turns. */
const SWAY = 3.2;
const SWAY_RATE = 3.4;
/** How far above a surface a settled leaf lies, to keep it off the face. */
const LIFT = 0.02;
/** Seconds a leaf shrinks away over once its time is up. */
const FADE = 0.4;

const tmpQuat = new THREE.Quaternion();
const tmpAxis = new THREE.Vector3();
const tmpPos = new THREE.Vector3();
const tmpScale = new THREE.Vector3();
const tmpMatrix = new THREE.Matrix4();
/** Lays the quad -- which is built standing in XY -- down onto the ground. */
const FLAT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI * 0.5);
const UP = new THREE.Vector3(0, 1, 0);

export class LeafSystem {
  readonly mesh: THREE.InstancedMesh;

  private readonly px = new Float32Array(MAX_LEAVES);
  private readonly py = new Float32Array(MAX_LEAVES);
  private readonly pz = new Float32Array(MAX_LEAVES);
  private readonly vx = new Float32Array(MAX_LEAVES);
  private readonly vy = new Float32Array(MAX_LEAVES);
  private readonly vz = new Float32Array(MAX_LEAVES);
  /** Tumble axis, one per leaf, and where it has turned to so far. */
  private readonly ax = new Float32Array(MAX_LEAVES);
  private readonly ay = new Float32Array(MAX_LEAVES);
  private readonly az = new Float32Array(MAX_LEAVES);
  private readonly angle = new Float32Array(MAX_LEAVES);
  private readonly spin = new Float32Array(MAX_LEAVES);
  /** Where the leaf is in its own spiral, and how wide that spiral is. */
  private readonly phase = new Float32Array(MAX_LEAVES);
  private readonly sway = new Float32Array(MAX_LEAVES);
  private readonly size = new Float32Array(MAX_LEAVES);
  private readonly life = new Float32Array(MAX_LEAVES);
  /** 0 while it is still in the air; otherwise it is lying on something. */
  private readonly landed = new Uint8Array(MAX_LEAVES);
  /** Which way a settled leaf is pointing. Meaningless until it has landed. */
  private readonly yaw = new Float32Array(MAX_LEAVES);

  private count = 0;
  /** Where the next leaf goes once the pool is full. */
  private cursor = 0;

  constructor(private readonly isSolid: (x: number, y: number, z: number) => boolean) {
    // A unit quad; the leaf shape itself is the texture's alpha.
    const geom = new THREE.PlaneGeometry(1, 1);

    const mat = new THREE.MeshLambertMaterial({
      map: makeLeafTexture(),
      // Cut out rather than blended: leaves are opaque where they exist, and
      // hundreds of blended quads with no sort order between them would haze
      // over everything behind the tree.
      alphaTest: 0.35,
      // A leaf edge-on is a leaf seen from behind half the time.
      side: THREE.DoubleSide,
      fog: true,
    });

    this.mesh = new THREE.InstancedMesh(geom, mat, MAX_LEAVES);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_LEAVES * 3), 3,
    );
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'leaves';
  }

  get activeCount(): number {
    return this.count;
  }

  /**
   * Throws `count` leaves out of (x, y, z) in the colour the foliage was.
   *
   * `dx, dy, dz` biases the spray -- pass the surface normal a round came in
   * against and the leaves come off the side that was hit, which is the
   * difference between a tree that was shot and a tree that exploded.
   */
  burst(
    x: number, y: number, z: number,
    r: number, g: number, b: number,
    count: number,
    dx: number, dy: number, dz: number,
    speed: number,
  ): void {
    for (let n = 0; n < count; n++) {
      let i: number;
      if (this.count < MAX_LEAVES) {
        i = this.count++;
      } else {
        i = this.cursor;
        this.cursor = (this.cursor + 1) % MAX_LEAVES;
      }

      this.px[i] = x + (Math.random() - 0.5) * 0.7;
      this.py[i] = y + (Math.random() - 0.5) * 0.7;
      this.pz[i] = z + (Math.random() - 0.5) * 0.7;

      const s = speed * (0.35 + Math.random() * 0.65);
      const a = Math.random() * Math.PI * 2;
      const p = Math.acos(2 * Math.random() - 1);
      this.vx[i] = (Math.sin(p) * Math.cos(a) + dx) * s;
      this.vy[i] = (Math.cos(p) + dy) * s + 1.5;
      this.vz[i] = (Math.sin(p) * Math.sin(a) + dz) * s;

      // A random axis, so no two leaves tumble the same way.
      tmpAxis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
      if (tmpAxis.lengthSq() < 1e-6) tmpAxis.set(0, 1, 0);
      tmpAxis.normalize();
      this.ax[i] = tmpAxis.x; this.ay[i] = tmpAxis.y; this.az[i] = tmpAxis.z;
      this.angle[i] = Math.random() * Math.PI * 2;
      // Thrown hard means spinning hard, and it slows as the leaf does.
      this.spin[i] = (Math.random() < 0.5 ? -1 : 1) * (3 + Math.random() * 7);

      this.phase[i] = Math.random() * Math.PI * 2;
      this.sway[i] = 0.4 + Math.random() * 0.8;
      this.size[i] = 0.26 + Math.random() * 0.2;
      this.life[i] = 7 + Math.random() * 6;
      this.landed[i] = 0;
      this.yaw[i] = Math.random() * Math.PI * 2;

      // The canopy is not one green, so neither is what comes off it.
      const shade = 0.82 + Math.random() * 0.36;
      this.mesh.instanceColor!.setXYZ(i, r * shade, g * shade, b * shade);
    }
    this.mesh.instanceColor!.needsUpdate = true;
  }

  update(dt: number): void {
    const step = Math.min(dt, 0.05);
    for (let i = 0; i < this.count;) {
      this.life[i] -= step;
      if (this.life[i] <= 0) {
        this.swapRemove(i);
        continue;
      }

      if (!this.landed[i]) {
        // The spiral: a sideways push that keeps turning, which is what a leaf
        // does on the way down and what a lump of debris never does.
        this.phase[i] += SWAY_RATE * step;
        const drift = this.sway[i] * SWAY * step;
        const damp = 1 - Math.min(0.9, DRAG * step);
        this.vx[i] = this.vx[i] * damp + Math.cos(this.phase[i]) * drift;
        this.vz[i] = this.vz[i] * damp + Math.sin(this.phase[i]) * drift;
        this.vy[i] = Math.max(-TERMINAL, this.vy[i] * damp - GRAVITY * step);

        const nx = this.px[i] + this.vx[i] * step;
        const ny = this.py[i] + this.vy[i] * step;
        const nz = this.pz[i] + this.vz[i] * step;

        // Landing is only tested against the block it is moving *into*, and
        // only from outside one: leaves are born inside the canopy voxel that
        // was hit, and a leaf that started in solid air has to fall clear of it
        // before it is allowed to lie down on anything.
        if (
          this.isSolid(Math.floor(nx), Math.floor(ny), Math.floor(nz))
          && !this.isSolid(Math.floor(this.px[i]), Math.floor(this.py[i]), Math.floor(this.pz[i]))
        ) {
          this.landed[i] = 1;
          // Sideways into a wall, or down onto a face: either way it comes to
          // rest on top of whatever it met.
          this.py[i] = Math.floor(ny) + 1 + LIFT;
          // Long enough to be worth walking through, short enough that a
          // treeline someone has emptied a belt into does clear again.
          this.life[i] = Math.min(this.life[i], 6 + Math.random() * 5);
        } else {
          this.px[i] = nx;
          this.py[i] = ny;
          this.pz[i] = nz;
          this.angle[i] += this.spin[i] * step;
          this.spin[i] *= 1 - Math.min(0.9, 0.9 * step);
        }
      }

      // Shrunk away rather than faded: the material is cut out, not blended,
      // so there is no alpha to take down.
      const k = Math.min(1, this.life[i] / FADE);
      const s = this.size[i] * k;

      tmpPos.set(this.px[i], this.py[i], this.pz[i]);
      if (this.landed[i]) {
        tmpQuat.setFromAxisAngle(UP, this.yaw[i]).multiply(FLAT);
      } else {
        tmpAxis.set(this.ax[i], this.ay[i], this.az[i]);
        tmpQuat.setFromAxisAngle(tmpAxis, this.angle[i]);
      }
      tmpScale.set(s, s, s);
      tmpMatrix.compose(tmpPos, tmpQuat, tmpScale);
      this.mesh.setMatrixAt(i, tmpMatrix);
      i++;
    }

    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear(): void {
    this.count = 0;
    this.cursor = 0;
    this.mesh.count = 0;
  }

  private swapRemove(i: number): void {
    const last = --this.count;
    if (i !== last) {
      this.px[i] = this.px[last]; this.py[i] = this.py[last]; this.pz[i] = this.pz[last];
      this.vx[i] = this.vx[last]; this.vy[i] = this.vy[last]; this.vz[i] = this.vz[last];
      this.ax[i] = this.ax[last]; this.ay[i] = this.ay[last]; this.az[i] = this.az[last];
      this.angle[i] = this.angle[last];
      this.spin[i] = this.spin[last];
      this.phase[i] = this.phase[last];
      this.sway[i] = this.sway[last];
      this.size[i] = this.size[last];
      this.life[i] = this.life[last];
      this.landed[i] = this.landed[last];
      this.yaw[i] = this.yaw[last];
      const c = this.mesh.instanceColor!;
      c.setXYZ(i, c.getX(last), c.getY(last), c.getZ(last));
      c.needsUpdate = true;
    }
    // The cursor indexes a full pool; once we're dropping leaves it's stale.
    this.cursor = 0;
  }
}

/**
 * One leaf, drawn once into a canvas.
 *
 * A single shape is enough because no two leaves are ever seen at the same
 * scale, colour or orientation. The midrib and the pair of veins are painted in
 * grey rather than being modelled: the material multiplies this against the
 * instance colour, so they come through as darker green whatever green the
 * plant they came off was.
 */
function makeLeafTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const tipY = size * 0.05;
  const baseY = size * 0.95;
  const midY = size * 0.44;
  const halfW = size * 0.2;
  const cx = size * 0.5;

  // Lanceolate: pointed at the tip, rounded into the stalk, widest above
  // centre. Two curves out and two back.
  ctx.beginPath();
  ctx.moveTo(cx, tipY);
  ctx.bezierCurveTo(cx + halfW * 0.9, midY * 0.55, cx + halfW, midY, cx + halfW * 0.55, baseY * 0.86);
  ctx.quadraticCurveTo(cx + halfW * 0.2, baseY, cx, baseY);
  ctx.quadraticCurveTo(cx - halfW * 0.2, baseY, cx - halfW * 0.55, baseY * 0.86);
  ctx.bezierCurveTo(cx - halfW, midY, cx - halfW * 0.9, midY * 0.55, cx, tipY);
  ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  // Everything from here on paints inside the leaf only.
  ctx.clip();

  // A little shading across the blade so a leaf caught flat-on isn't a
  // silhouette of one colour.
  const grad = ctx.createLinearGradient(cx - halfW, 0, cx + halfW, 0);
  grad.addColorStop(0, 'rgba(0, 0, 0, 0.22)');
  grad.addColorStop(0.45, 'rgba(0, 0, 0, 0)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0.16)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
  ctx.lineWidth = size * 0.035;
  ctx.beginPath();
  ctx.moveTo(cx, tipY);
  ctx.lineTo(cx, baseY);
  ctx.stroke();

  ctx.lineWidth = size * 0.02;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.2)';
  for (let i = 0; i < 3; i++) {
    const y = midY * 0.6 + (baseY - midY * 0.6) * (i / 3);
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(cx, y);
      ctx.quadraticCurveTo(cx + dir * halfW * 0.5, y + size * 0.02, cx + dir * halfW * 0.8, y - size * 0.09);
      ctx.stroke();
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}
