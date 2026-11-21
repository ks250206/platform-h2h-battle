import { canStandAt, length, normalize } from "./combat";
import { clearWalk } from "./navigation";
import { RULES, UKEMI } from "./tuning";
import type { Fighter, GameState, Vec2 } from "./types";

/** A launched CPU gets one roll of the dice on the actual downward crossing. */
export function cpuTechOpportunity(state: GameState, f: Fighter, dt: number): boolean {
  if (!f.tumbling || f.hitstop > 0 || f.y < 0 || f.invulnerable > 0) return false;
  const nextVy = f.vy - RULES.gravity * dt;
  return (
    nextVy < 0 && f.y + nextVy * dt <= 0 && canStandAt(state, f.x + f.vx * dt, f.z + f.vz * dt)
  );
}

export function rollDirection(move: Vec2): Vec2 {
  return length(move) > 0.1 ? normalize(move) : { x: 0, z: 0 };
}

export function advanceRoll(state: GameState, f: Fighter, dt: number): void {
  if (!f.grounded || f.modeTime > UKEMI.rollTime + 1e-8) return;
  const to = {
    x: f.x + f.stepDirection.x * UKEMI.rollSpeed * dt,
    z: f.z + f.stepDirection.z * UKEMI.rollSpeed * dt,
  };
  const arena = state.arena;
  if (clearWalk(arena.stageId, arena.halfSize, f, to, 0.2)) {
    f.x = to.x;
    f.z = to.z;
  }
}
