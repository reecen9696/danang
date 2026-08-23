import * as THREE from 'three';
import { BoxBuilder } from './boxMesh';

/**
 * The boombox standing in the base.
 *
 * Built the same way flags are — ordinary geometry on a grid finer than the
 * world's, so it can have buttons at all — and for the same reason it is
 * scenery rather than terrain: it doesn't collide, can't be shot away and
 * never reaches the server. Everyone gets their own, playing their own thing.
 *
 * The two buttons are separate meshes rather than part of the merged shell,
 * because they have to be pickable: the player aims at one and presses it, and
 * a raycast against two small meshes is exact where a hand-written box test
 * would have to know the group's transform.
 */

/** Cell size, in world units. The shell is 10 x 6 x 3 of them. */
const PIXEL = 1 / 8;

const SHELL = 0x41454b;
const GRILLE = 0x191b1e;
const TRIM = 0x9aa1a9;
const DIAL = 0xc4bda6;
const NEEDLE = 0xd0402c;

const RED = 0xc03a2b;
const RED_LIT = 0xff6a52;
const BLUE = 0x2f6fb0;
const BLUE_LIT = 0x5fa8ee;

/** How far a button travels when pressed, and for how long. */
const PRESS_DEPTH = 0.4 * PIXEL;
const PRESS_TIME = 0.14;

export const enum RadioButton {
  /** Red: play and pause. */
  Play = 0,
  /** Blue: next track. */
  Skip = 1,
}

interface ButtonSpec {
  readonly color: number;
  readonly lit: number;
  /** Centre on the front face, in cells from the middle and from the bottom. */
  readonly cx: number;
  readonly cy: number;
}

const BUTTONS: readonly ButtonSpec[] = [
  { color: RED, lit: RED_LIT, cx: -1.1, cy: 2.1 },
  { color: BLUE, lit: BLUE_LIT, cx: 1.1, cy: 2.1 },
];

/** Button face size and how far it stands off the shell, in cells. */
const BTN_W = 2.0;
const BTN_H = 1.6;
const BTN_D = 0.5;

/** Shell extents, in cells. */
const W = 10;
const H = 6;
const D = 3;

const VU_CELLS = 3;

function color(hex: number): THREE.Color {
  return new THREE.Color(hex);
}

export class Boombox {
  readonly group = new THREE.Group();
  /** Indexed by {@link RadioButton}. What the player actually aims at. */
  readonly buttons: THREE.Mesh[] = [];
  /** Where the sound comes from, in world space. */
  readonly speaker = new THREE.Vector3();

  private readonly buttonMats: THREE.MeshLambertMaterial[] = [];
  /** Resting z of each button, so a press can push it in and let it back out. */
  private readonly restZ: number[] = [];
  private readonly pressed = [0, 0];
  private aimed = -1;
  private readonly vu: THREE.MeshBasicMaterial[] = [];
  /** Smoothed meter, so the lamps swing rather than strobe. */
  private meter = 0;

  constructor(x: number, y: number, z: number, yaw: number) {
    const b = new BoxBuilder();
    const shell = color(SHELL);
    const grille = color(GRILLE);
    const trim = color(TRIM);
    const dial = color(DIAL);
    const needle = color(NEEDLE);

    const px = (cells: number): number => cells * PIXEL;
    const front = px(D / 2);
    const back = -px(D / 2);

    // --- shell -------------------------------------------------------------
    b.box(px(-W / 2), 0, back, px(W), px(H), px(D), shell);

    // Speaker grilles, sunk into the front so they read as cloth not paint,
    // with slats across them — without those they're just dark rectangles.
    for (const side of [-1, 1]) {
      const x0 = side < 0 ? px(-W / 2 + 0.3) : px(2.4);
      b.box(x0, px(1.0), front - px(0.15), px(2.6), px(4.2), px(0.3), grille);
      for (let slat = 0; slat < 4; slat++) {
        b.box(x0, px(1.5 + slat), front - px(0.14), px(2.6), px(0.12), px(0.3), trim);
      }
      // A band of trim above and below each, which is what makes it a boombox
      // rather than a crate with a hole in it.
      b.box(x0 - px(0.2), px(0.8), front - px(0.1), px(3.0), px(0.2), px(0.25), trim);
      b.box(x0 - px(0.2), px(5.2), front - px(0.1), px(3.0), px(0.2), px(0.25), trim);
    }

    // Tuning dial above the controls. A lit strip with a needle parked on a
    // station is the one detail that says radio rather than tape deck.
    b.box(px(-2.4), px(3.3), front - px(0.12), px(4.8), px(2.0), px(0.3), trim);
    b.box(px(-2.2), px(3.5), front - px(0.06), px(4.4), px(1.6), px(0.25), dial);
    for (let tick = 0; tick < 5; tick++) {
      b.box(px(-1.9 + tick), px(3.5), front - px(0.02), px(0.1), px(0.45), px(0.22), grille);
    }
    b.box(px(0.55), px(3.5), front - px(0.01), px(0.18), px(1.6), px(0.22), needle);

    // --- handle ------------------------------------------------------------
    for (const side of [-1, 1]) {
      b.box(px(side * 3.2 - 0.3), px(H), px(-0.4), px(0.6), px(1.6), px(0.8), trim);
    }
    b.box(px(-3.5), px(H + 1.6), px(-0.4), px(7.0), px(0.6), px(0.8), trim);

    // --- antenna -----------------------------------------------------------
    b.box(px(4.2), px(H), px(-1.1), px(0.4), px(7.0), px(0.4), trim);

    const mesh = new THREE.Mesh(
      b.finish(),
      new THREE.MeshLambertMaterial({ vertexColors: true, fog: true }),
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);

    // --- buttons -----------------------------------------------------------
    const btnGeom = new THREE.BoxGeometry(px(BTN_W), px(BTN_H), px(BTN_D));
    for (const spec of BUTTONS) {
      const mat = new THREE.MeshLambertMaterial({ color: spec.color, fog: true });
      const btn = new THREE.Mesh(btnGeom, mat);
      btn.position.set(px(spec.cx), px(spec.cy), front + px(BTN_D / 2) - px(0.1));
      btn.castShadow = true;
      this.buttons.push(btn);
      this.buttonMats.push(mat);
      this.restZ.push(btn.position.z);
      this.group.add(btn);
    }

    // --- level meter -------------------------------------------------------
    const vuGeom = new THREE.BoxGeometry(px(1.2), px(0.5), px(0.2));
    for (let i = 0; i < VU_CELLS; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0x1a2418, fog: true });
      const cell = new THREE.Mesh(vuGeom, mat);
      cell.position.set(px(-1.5 + i * 1.5), px(0.85), front + px(0.05));
      this.vu.push(mat);
      this.group.add(cell);
    }

    this.group.position.set(x, y, z);
    this.group.rotation.y = yaw;
    this.group.updateMatrixWorld(true);
    this.speaker.set(x, y + px(H / 2), z);
  }

  /** Lights the button the player is looking at. -1 for none. */
  setAimed(index: number): void {
    if (index === this.aimed) return;
    this.aimed = index;
    for (let i = 0; i < this.buttonMats.length; i++) {
      this.buttonMats[i].color.set(i === index ? BUTTONS[i].lit : BUTTONS[i].color);
    }
  }

  press(index: number): void {
    if (index >= 0 && index < this.pressed.length) this.pressed[index] = PRESS_TIME;
  }

  update(dt: number, level: number, playing: boolean): void {
    for (let i = 0; i < this.buttons.length; i++) {
      if (this.pressed[i] <= 0) continue;
      this.pressed[i] = Math.max(0, this.pressed[i] - dt);
      // Straight in and straight back out — a button, not a spring.
      const t = this.pressed[i] / PRESS_TIME;
      this.buttons[i].position.z = this.restZ[i] - PRESS_DEPTH * Math.sin(t * Math.PI);
    }

    // Falls faster than it rises, which is what a needle does.
    const target = playing ? level : 0;
    this.meter += (target - this.meter) * Math.min(1, dt * (target > this.meter ? 18 : 7));
    for (let i = 0; i < this.vu.length; i++) {
      const threshold = (i + 0.5) / this.vu.length;
      const on = playing && this.meter >= threshold * 0.85;
      // Last lamp red, the rest green: the universal grammar of a level meter.
      this.vu[i].color.setHex(
        on ? (i === this.vu.length - 1 ? 0xff5c3a : 0x74ff6a)
          : (playing ? 0x24361f : 0x1a2418),
      );
    }
  }
}
