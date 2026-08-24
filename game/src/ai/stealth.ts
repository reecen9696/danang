/**
 * Being noticed.
 *
 * Contact is not a boolean and it is not instant. A man catches movement, turns
 * his head, works out what he is looking at, and *then* shouts — and every one
 * of those steps is time the player can spend not being there any more. This
 * module owns the arithmetic of that: how readable a player is from a given
 * stance, how fast a bot facing them puts it together, and how long it takes
 * one to let go of it again.
 *
 * The state itself lives on the Bot (`awareness`) and the state machine lives
 * in BotManager. Everything here is pure, which is what lets the server run the
 * same numbers without dragging any of the client in.
 */

/**
 * Half-angle of a bot's useful vision, in radians.
 *
 * Deliberately narrower than a real field of view: peripheral vision that
 * notices you as reliably as a direct look would make flanking pointless, and
 * flanking is the only thing the player has out here. About 55 degrees each
 * side — enough that walking across the front of a sentry is suicide and
 * crossing behind one is not.
 */
export const VIEW_CONE = 0.96;

/**
 * The same, once the bot knows something is out there.
 *
 * A man who has heard a shot is turning his head, so the cone he is effectively
 * covering is wider than the one he sweeps while bored.
 */
export const VIEW_CONE_ALERT = 1.5;

/**
 * Range at which a plain upright walk is still read quickly, in blocks, and the
 * range past which nothing is read at all without the fog doing the work.
 *
 * The falloff between them is quadratic: distance buys a great deal of time at
 * first and then very little, which matches the fog — by the time a bot is a
 * shape in the haze it can barely see you at all.
 */
export const SPOT_NEAR = 22;
export const SPOT_FAR = 95;

/**
 * Inside this, being looked at is being seen: no stance saves you from a man
 * you are standing next to, and the multiplier below is what makes walking
 * into a camp a decision rather than a coin flip.
 */
export const SPOT_POINT_BLANK = 8;
export const POINT_BLANK_SCALE = 3;

/** Awareness gained per second at point-blank range by a walking, upright man. */
export const SPOT_RATE = 1.9;

/**
 * Awareness bled off per second with the player out of sight.
 *
 * Slow on purpose. Ducking behind a tree for half a second should not wipe what
 * the sentry had already put together; it should cost him a moment, which is
 * exactly as long as the player has to get somewhere better.
 */
export const FORGET_RATE = 0.4;

/**
 * How much of what it knew an alerted bot keeps.
 *
 * Once a man has shouted he does not un-shout. He hunts, and he stays switched
 * on long after he has lost sight of you — this is what stops "break line of
 * sight for one second" from being a reset button on a firefight.
 */
export const ALERT_FORGET_SCALE = 0.25;

/** Awareness at which a bot starts turning to look, rather than just glancing past. */
export const SUSPICIOUS = 0.28;

/**
 * How visible the player is, as a multiplier on every bot's spot rate.
 *
 * 1.0 is a man walking upright in the open. Everything the player can do about
 * being seen goes through this one number, so the whole stealth system is
 * legible in one place rather than smeared across the AI.
 */
export interface StealthStance {
  /** Horizontal speed in blocks/sec. */
  speed: number;
  sprinting: boolean;
  crouching: boolean;
  /** Holding the sneak key: slow, silent, and deliberately small. */
  sneaking: boolean;
  /** Seconds since the player last fired. A muzzle flash is not subtle. */
  sinceFired: number;
}

/** How long a shot keeps advertising the shooter's position, in seconds. */
export const MUZZLE_TELL = 1.4;

export function visibilityOf(s: StealthStance): number {
  // Movement is most of it: the eye is drawn by things that change, and a man
  // who has stopped moving is a shape among other shapes.
  let vis = 0.62;
  if (s.speed < 0.7) vis = 0.34;
  else if (s.speed > 5.4 || s.sprinting) vis = 1.35;

  // Sneaking is the deliberate act, so it gets the deliberate discount.
  if (s.sneaking) vis *= 0.34;
  if (s.crouching) vis *= 0.62;

  // Nothing you do with your feet outweighs having just fired a rifle.
  if (s.sinceFired < MUZZLE_TELL) {
    const heat = 1 - s.sinceFired / MUZZLE_TELL;
    vis = Math.max(vis, 0.9 + heat * 1.6);
  }
  return vis;
}

/**
 * Distance term of the spot rate, 0..1.
 *
 * Flat inside `SPOT_NEAR` — close enough is close enough — then falling away
 * quadratically to nothing at `SPOT_FAR`.
 */
export function rangeFactor(dist: number): number {
  if (dist <= SPOT_POINT_BLANK) return POINT_BLANK_SCALE;
  if (dist <= SPOT_NEAR) {
    // Ease off the point-blank term rather than stepping off it, or there is a
    // ring on the ground where sneaking abruptly starts working.
    const t = (dist - SPOT_POINT_BLANK) / (SPOT_NEAR - SPOT_POINT_BLANK);
    return POINT_BLANK_SCALE + (1 - POINT_BLANK_SCALE) * t;
  }
  if (dist >= SPOT_FAR) return 0;
  const t = 1 - (dist - SPOT_NEAR) / (SPOT_FAR - SPOT_NEAR);
  return t * t;
}

/**
 * What a squad already knowing where you are is worth to one of its members.
 *
 * A man who has been told is not searching, he is checking — so the wave that
 * walks onto a firebase whose owner is shooting at it does not have to
 * rediscover him one bot at a time.
 */
export const SQUAD_CONTACT_SCALE = 3.5;

/**
 * Whether a point lies inside the cone a bot facing `yaw` is covering.
 *
 * Yaw here is the game's convention — atan2(x, z), zero along +Z — because
 * that is what every bot stores and what `move` writes.
 */
export function inViewCone(
  yaw: number,
  fromX: number, fromZ: number,
  toX: number, toZ: number,
  halfAngle: number,
): boolean {
  const dx = toX - fromX;
  const dz = toZ - fromZ;
  if (dx * dx + dz * dz < 4) return true; // arm's length: he can feel you there
  let da = Math.atan2(dx, dz) - yaw;
  while (da > Math.PI) da -= Math.PI * 2;
  while (da < -Math.PI) da += Math.PI * 2;
  return Math.abs(da) <= halfAngle;
}

/**
 * How loud a noise is at a given distance, 0..1.
 *
 * Linear, and zero past the radius: sound in this game is a gameplay radius
 * with a soft edge, not an acoustic model. What matters is that the edge is
 * soft, so a shot at the limit of a camp's hearing makes a sentry look up
 * rather than instantly bringing the whole camp down on you.
 */
export function noiseFalloff(dist: number, radius: number): number {
  if (radius <= 0 || dist >= radius) return 0;
  const t = 1 - dist / radius;
  return t * t;
}
