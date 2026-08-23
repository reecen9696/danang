/**
 * Keyboard + pointer-lock mouse input.
 *
 * Key state is a flat lookup so the movement code never touches a Map, and
 * mouse deltas accumulate between frames so a 1000 Hz mouse isn't truncated.
 */
export class Input {
  private readonly down = new Set<string>();
  private readonly pressedThisFrame = new Set<string>();
  private readonly releasedThisFrame = new Set<string>();

  mouseDX = 0;
  mouseDY = 0;
  wheelDelta = 0;

  mouseLeft = false;
  mouseRight = false;
  mouseLeftPressed = false;
  mouseRightPressed = false;

  locked = false;
  /** AoS turns `mouseDelta * 0.003` radians at cg_mouseSensitivity 1. */
  sensitivity = 0.003;
  invertY = false;

  /** Set while any UI overlay wants the keyboard (shop, pause). */
  uiCapture = false;

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    if (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    this.down.add(e.code);
    this.pressedThisFrame.add(e.code);
  };

  private readonly onKeyUp = (e: KeyboardEvent) => {
    this.down.delete(e.code);
    this.releasedThisFrame.add(e.code);
  };

  private readonly onMouseMove = (e: MouseEvent) => {
    if (!this.locked) return;
    this.mouseDX += e.movementX;
    this.mouseDY += e.movementY;
  };

  private readonly onMouseDown = (e: MouseEvent) => {
    if (!this.locked) return;
    if (e.button === 0) { this.mouseLeft = true; this.mouseLeftPressed = true; }
    if (e.button === 2) { this.mouseRight = true; this.mouseRightPressed = true; }
  };

  private readonly onMouseUp = (e: MouseEvent) => {
    if (e.button === 0) this.mouseLeft = false;
    if (e.button === 2) this.mouseRight = false;
  };

  private readonly onWheel = (e: WheelEvent) => {
    if (!this.locked) return;
    e.preventDefault();
    this.wheelDelta += Math.sign(e.deltaY);
  };

  private readonly onBlur = () => {
    this.down.clear();
    this.mouseLeft = false;
    this.mouseRight = false;
  };

  private readonly onPointerLockChange = () => {
    this.locked = document.pointerLockElement === this.element;
    if (!this.locked) this.onBlur();
  };

  constructor(private readonly element: HTMLElement) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('mousedown', this.onMouseDown);
    document.addEventListener('mouseup', this.onMouseUp);
    document.addEventListener('wheel', this.onWheel, { passive: false });
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    element.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  requestLock(): void {
    if (!this.locked) void this.element.requestPointerLock();
  }

  exitLock(): void {
    if (this.locked) document.exitPointerLock();
  }

  isDown(code: string): boolean {
    return !this.uiCapture && this.down.has(code);
  }

  /** True only on the frame the key went down. Ignores uiCapture for hotkeys. */
  wasPressed(code: string): boolean {
    return this.pressedThisFrame.has(code);
  }

  wasReleased(code: string): boolean {
    return this.releasedThisFrame.has(code);
  }

  /** Call once at the end of every frame. */
  endFrame(): void {
    this.pressedThisFrame.clear();
    this.releasedThisFrame.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheelDelta = 0;
    this.mouseLeftPressed = false;
    this.mouseRightPressed = false;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('mousedown', this.onMouseDown);
    document.removeEventListener('mouseup', this.onMouseUp);
    document.removeEventListener('wheel', this.onWheel);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
  }
}
