// Lock-on target selection: which opponent the player keeps facing. Pure (no DOM), so it can be
// unit-tested; `BattleInput` owns the on/off state and calls in here every frame.

import { CAMERA_FORWARD, CAMERA_RIGHT } from "./coordinates";
import type { Fighter, GameState } from "./types";

/** +1 = next (clockwise on screen), -1 = previous (anticlockwise). */
export type CycleDirection = 1 | -1;

const TAU = Math.PI * 2;

/** Opponents that can be locked: everyone else who is on the island (not down or respawning). */
export function lockCandidates(state: GameState, selfId: number): Fighter[] {
  return state.fighters.filter((f) => f.id !== selfId && f.mode !== "dead");
}

/**
 * Bearing of `to` as seen from `from` on the screen, in radians clockwise from screen up, in
 * [0, 2π). Uses the camera axes, so "clockwise" here is clockwise on the player's screen.
 */
export function screenBearing(from: { x: number; z: number }, to: { x: number; z: number }) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const right = dx * CAMERA_RIGHT.x + dz * CAMERA_RIGHT.z;
  const up = dx * CAMERA_FORWARD.x + dz * CAMERA_FORWARD.z;
  const angle = Math.atan2(right, up);
  return angle < 0 ? angle + TAU : angle;
}

function nearest(self: Fighter, candidates: Fighter[]): number | null {
  let best: Fighter | null = null;
  let bestDistance = Infinity;
  for (const f of candidates) {
    const d = Math.hypot(f.x - self.x, f.z - self.z);
    if (d < bestDistance || (d === bestDistance && best && f.id < best.id)) {
      best = f;
      bestDistance = d;
    }
  }
  return best?.id ?? null;
}

/**
 * The fighter to stay locked on: `currentId` while it is still a candidate (sticky, even when
 * someone else is nearer), otherwise the nearest candidate; null when nobody can be locked.
 */
export function resolveTarget(
  state: GameState,
  selfId: number,
  currentId: number | null,
): number | null {
  const self = state.fighters.find((f) => f.id === selfId);
  if (!self) return null;
  const candidates = lockCandidates(state, selfId);
  if (currentId !== null && candidates.some((f) => f.id === currentId)) return currentId;
  return nearest(self, candidates);
}

/**
 * Switches to the next candidate around the player on screen: the smallest clockwise (direction
 * 1) or anticlockwise (-1) turn from the current target's bearing. A no-op with one candidate;
 * without a valid current target it acquires the nearest.
 */
export function cycleTarget(
  state: GameState,
  selfId: number,
  currentId: number | null,
  direction: CycleDirection,
): number | null {
  const self = state.fighters.find((f) => f.id === selfId);
  if (!self) return null;
  const candidates = lockCandidates(state, selfId);
  const current = candidates.find((f) => f.id === currentId);
  if (!current) return nearest(self, candidates);
  const from = screenBearing(self, current);
  let best: Fighter = current;
  let bestTurn = Infinity;
  for (const f of candidates) {
    if (f.id === current.id) continue;
    let turn = (screenBearing(self, f) - from) * direction;
    turn = ((turn % TAU) + TAU) % TAU;
    // Two opponents on the exact same bearing: the one with the higher id comes first going
    // clockwise, so cycling still visits both.
    if (turn === 0) turn = (f.id - current.id) * direction > 0 ? 1e-9 : TAU;
    if (turn < bestTurn || (turn === bestTurn && f.id < best.id)) {
      best = f;
      bestTurn = turn;
    }
  }
  return best.id;
}
