// Gamepad bindings, as pure functions over plain snapshots so they can be unit-tested in node.
// The layout follows the "standard" mapping (Xbox names): Dark Souls for the attacks, the dodge and
// the lock-on, Smash / Elden Ring for the jump.

import type { AttackId, FighterMode } from "./types";

export interface PadButton {
  pressed: boolean;
  value: number;
}

/** What one poll of a pad looks like: `navigator.getGamepads()[i]`, copied. */
export interface PadSnapshot {
  axes: readonly number[];
  buttons: readonly PadButton[];
}

/** Button indices of the standard mapping. */
export const BUTTON = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  VIEW: 8,
  START: 9,
  L3: 10,
  R3: 11,
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15,
} as const;

/** Radial dead zone of both sticks; the rest of the throw is rescaled to start at 0. */
export const DEAD_ZONE = 0.2;
/** An analog trigger counts as pressed from half-way down. */
export const TRIGGER_THRESHOLD = 0.5;
/** A right-stick flick switches target past this sideways throw, and re-arms below `FLICK_REARM`. */
export const FLICK_THRESHOLD = 0.7;
export const FLICK_REARM = 0.3;

/** The four attacks on the shoulders: RB / RT / LB / LT, also the order a simultaneous press picks. */
export const ATTACK_BUTTONS: readonly { button: number; attack: AttackId }[] = [
  { button: BUTTON.RB, attack: "sweep" },
  { button: BUTTON.RT, attack: "overhead" },
  { button: BUTTON.LB, attack: "thrust" },
  { button: BUTTON.LT, attack: "rising" },
];

export type ScreenVec = { x: number; y: number };

const finite = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

/** Is button `index` down? Triggers by their analog value, other buttons by `pressed` (or value). */
export function isDown(snapshot: PadSnapshot | null | undefined, index: number): boolean {
  const button = snapshot?.buttons?.[index];
  if (!button) return false;
  const value = finite(button.value);
  if (index === BUTTON.LT || index === BUTTON.RT) return value >= TRIGGER_THRESHOLD;
  return Boolean(button.pressed) || value >= TRIGGER_THRESHOLD;
}

/** Down now and not in the previous snapshot. */
export function justPressed(
  current: PadSnapshot | null | undefined,
  previous: PadSnapshot | null | undefined,
  index: number,
): boolean {
  return isDown(current, index) && !isDown(previous, index);
}

/**
 * One stick with a radial dead zone: inside `DEAD_ZONE` it reads 0, and the remaining throw is
 * rescaled so the edge of the dead zone is 0 and full throw is 1 (never longer than 1).
 * Screen convention: +x right, +y down.
 */
export function readStick(axes: readonly number[] | undefined, xIndex: number): ScreenVec {
  const x = finite(axes?.[xIndex]);
  const y = finite(axes?.[xIndex + 1]);
  const length = Math.hypot(x, y);
  if (length <= DEAD_ZONE) return { x: 0, y: 0 };
  const scaled = Math.min(1, (length - DEAD_ZONE) / (1 - DEAD_ZONE));
  return { x: (x / length) * scaled, y: (y / length) * scaled };
}

/** Everything a pad says in one frame, in screen space; `BattleInput` turns it into a `PlayerInput`. */
export interface PadCommands {
  /** Left stick. */
  move: ScreenVec;
  /** Right stick when pushed out of the dead zone: the free aim while the lock-on is off. */
  aim: ScreenVec | null;
  attackPressed: AttackId | null;
  attackHeld: AttackId | null;
  jump: boolean;
  step: boolean;
  cancel: boolean;
  grab: boolean;
  /** R3. */
  toggleLock: boolean;
  /** D-pad left / right, or a sideways flick of the right stick: switch target (when locked). */
  cycle: -1 | 0 | 1;
  /** View / Back. */
  camera: boolean;
  /** Start. */
  pause: boolean;
}

/** What a pad's reading carries from one frame to the next. */
export interface PadMemory {
  /** The right stick has come back near the centre since the last flick. */
  flickArmed: boolean;
  /** The attack pressed last, while its button is still held. */
  lastAttack: AttackId | null;
}

export const freshPadMemory = (): PadMemory => ({ flickArmed: true, lastAttack: null });

/**
 * Maps a pad snapshot to commands. Presses fire on the frame a button goes down (compared with
 * `previous`); attacks also report the one being held, so holding a shoulder button charges.
 * Short or non-standard arrays read as released / centred.
 */
export function readPad(
  current: PadSnapshot,
  previous: PadSnapshot | null,
  memory: PadMemory,
): { commands: PadCommands; memory: PadMemory } {
  const pressed = (index: number) => justPressed(current, previous, index);
  const move = readStick(current.axes, 0);
  const right = readStick(current.axes, 2);
  const rightLength = Math.hypot(right.x, right.y);

  let attackPressed: AttackId | null = null;
  for (const { button, attack } of ATTACK_BUTTONS) {
    if (pressed(button)) {
      attackPressed = attack;
      break;
    }
  }
  const held = ATTACK_BUTTONS.filter(({ button }) => isDown(current, button)).map((b) => b.attack);
  const lastAttack =
    attackPressed ??
    (memory.lastAttack && held.includes(memory.lastAttack) ? memory.lastAttack : null);
  const attackHeld = lastAttack ?? held[0] ?? null;

  let cycle: -1 | 0 | 1 = 0;
  if (pressed(BUTTON.LEFT)) cycle = -1;
  else if (pressed(BUTTON.RIGHT)) cycle = 1;
  let flickArmed = memory.flickArmed;
  if (rightLength < FLICK_REARM) flickArmed = true;
  else if (
    flickArmed &&
    Math.abs(right.x) > FLICK_THRESHOLD &&
    Math.abs(right.x) > Math.abs(right.y)
  ) {
    flickArmed = false;
    if (!cycle) cycle = right.x > 0 ? 1 : -1;
  }

  return {
    commands: {
      move,
      aim: rightLength > 0 ? right : null,
      attackPressed,
      attackHeld,
      jump: pressed(BUTTON.A),
      step: pressed(BUTTON.B),
      cancel: pressed(BUTTON.Y),
      grab: pressed(BUTTON.X),
      toggleLock: pressed(BUTTON.R3),
      cycle,
      camera: pressed(BUTTON.VIEW),
      pause: pressed(BUTTON.START),
    },
    memory: { flickArmed, lastAttack },
  };
}

/** Did any button of the pad go down (a gesture, for unlocking audio)? */
export function anyPressed(current: PadSnapshot, previous: PadSnapshot | null): boolean {
  const count = Array.isArray(current.buttons) ? current.buttons.length : 0;
  for (let index = 0; index < count; index++)
    if (justPressed(current, previous, index)) return true;
  return false;
}

// ---- Menus ----------------------------------------------------------------------------------

export type MenuDirection = "up" | "down" | "left" | "right";

/** The direction the D-pad or the left stick (pushed past half-way) points, or null. */
export function menuDirection(snapshot: PadSnapshot | null | undefined): MenuDirection | null {
  if (!snapshot) return null;
  if (isDown(snapshot, BUTTON.UP)) return "up";
  if (isDown(snapshot, BUTTON.DOWN)) return "down";
  if (isDown(snapshot, BUTTON.LEFT)) return "left";
  if (isDown(snapshot, BUTTON.RIGHT)) return "right";
  const stick = readStick(snapshot.axes, 0);
  if (Math.hypot(stick.x, stick.y) < 0.5) return null;
  if (Math.abs(stick.x) > Math.abs(stick.y)) return stick.x > 0 ? "right" : "left";
  return stick.y > 0 ? "down" : "up";
}

/** Auto-repeat of a held menu direction: the first step at once, then after a delay, then faster. */
export interface NavRepeat {
  direction: MenuDirection | null;
  /** Time (seconds) the next repeat is due. */
  next: number;
}
export const NAV_DELAY = 0.38;
export const NAV_INTERVAL = 0.13;

/**
 * Feeds the held direction at time `now`; returns the direction to step this frame (or null) and
 * the new repeat state. Starting from `held` (a direction already down when a layer took over),
 * nothing fires until it is released.
 */
export function stepNav(
  repeat: NavRepeat,
  direction: MenuDirection | null,
  now: number,
): { step: MenuDirection | null; repeat: NavRepeat } {
  if (!direction) return { step: null, repeat: { direction: null, next: 0 } };
  if (direction !== repeat.direction)
    return { step: direction, repeat: { direction, next: now + NAV_DELAY } };
  if (now >= repeat.next)
    return { step: direction, repeat: { direction, next: now + NAV_INTERVAL } };
  return { step: null, repeat };
}

/** A held direction at takeover: blocked (never repeats) until it changes. */
export const heldNav = (direction: MenuDirection | null): NavRepeat => ({
  direction,
  next: direction ? Infinity : 0,
});

// ---- Vibration ------------------------------------------------------------------------------

/** The bits of a fighter the rumble compares between two frames. */
export interface RumbleSample {
  mode: FighterMode;
  hitstop: number;
  damage: number;
}

export interface Rumble {
  /** Milliseconds. */
  duration: number;
  strongMagnitude: number;
  weakMagnitude: number;
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/**
 * The rumble for what happened to a fighter since the last frame: a new hit-stop while in hitstun
 * (was hit: scaled by the damage taken), in a clash, or swinging (landed a hit). Null otherwise.
 */
export function rumbleFor(previous: RumbleSample | null, current: RumbleSample): Rumble | null {
  if (!previous || !(current.hitstop > previous.hitstop + 1e-6)) return null;
  if (current.mode === "hitstun") {
    const strength = clamp01(0.35 + Math.max(0, current.damage - previous.damage) / 30);
    return {
      duration: Math.round(110 + 170 * strength),
      strongMagnitude: strength,
      weakMagnitude: clamp01(strength + 0.2),
    };
  }
  if (current.mode === "clash") return { duration: 150, strongMagnitude: 0.5, weakMagnitude: 0.85 };
  if (current.mode === "active" || current.mode === "recovery")
    return { duration: 90, strongMagnitude: 0.2, weakMagnitude: 0.55 };
  return null;
}
