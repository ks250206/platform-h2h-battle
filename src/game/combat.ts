import { canStandAtStage } from "./stages";
import { ATTACKS, RULES } from "./tuning";
import type { Fighter, GameState, Vec2 } from "./types";

export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
export const length = (v: Vec2): number => Math.hypot(v.x, v.z);
export function normalize(v: Vec2): Vec2 {
  const d = length(v);
  return d > 0.00001 ? { x: v.x / d, z: v.z / d } : { x: 0, z: 0 };
}
export const forward = (f: Pick<Fighter, "facing">): Vec2 => ({
  x: Math.sin(f.facing),
  z: Math.cos(f.facing),
});
export const angleDelta = (from: number, to: number): number =>
  Math.atan2(Math.sin(to - from), Math.cos(to - from));

/** DI rotates the horizontal impulse; it never changes its length or vertical sign. */
export function directionInfluence(velocity: { x: number; y: number; z: number }, input: Vec2) {
  const magnitude = Math.hypot(velocity.x, velocity.z);
  if (magnitude < 0.001 || length(input) < 0.05) return { ...velocity };
  const heading = Math.atan2(velocity.x, velocity.z);
  const inputHeading = Math.atan2(input.x, input.z);
  const delta =
    Math.sin(angleDelta(heading, inputHeading)) * RULES.diAngle * Math.min(1, length(input));
  return {
    x: Math.sin(heading + delta) * magnitude,
    y: velocity.y,
    z: Math.cos(heading + delta) * magnitude,
  };
}

/** Floor under (x, z) right now: the stage's tiles that the collapse has not taken (stages.ts). */
export function canStandAt(state: GameState, x: number, z: number): boolean {
  return canStandAtStage(state.arena.stageId, x, z, state.arena.halfSize);
}

export function isInvulnerable(f: Fighter): boolean {
  return (
    f.invulnerable > 0 ||
    (f.mode === "step" &&
      f.stepDelay <= 0 &&
      f.modeTime >= RULES.stepInvulStart &&
      f.modeTime < RULES.stepInvulEnd)
  );
}

export function attackContains(a: Fighter, b: Pick<Fighter, "mode" | "x" | "y" | "z">): boolean {
  if (!a.attack || a.mode !== "active" || b.mode === "dead") return false;
  const attack = ATTACKS[a.attack];
  const dx = b.x - a.x,
    dz = b.z - a.z;
  const f = forward(a);
  const ahead = dx * f.x + dz * f.z;
  const side = Math.abs(dx * f.z - dz * f.x);
  const vertical = b.y - a.y;
  const r = RULES.fighterRadius;
  if (a.attack === "rising") {
    if (vertical < -1.5 || vertical > 3.2) return false;
  } else if (a.attack === "overhead" && !a.grounded) {
    if (vertical < -2.5 || vertical > 1.1) return false;
  } else if (Math.abs(vertical) > 1.35) return false;
  if (a.attack === "sweep") {
    return (
      ahead >= -0.12 &&
      Math.hypot(dx, dz) <= attack.reach + r &&
      ahead >= Math.cos(Math.PI * 0.44) * Math.hypot(dx, dz) - r
    );
  }
  return ahead >= 0.1 - r && ahead <= attack.reach + r && side <= attack.width + r;
}

function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x,
    dz = b.z - a.z;
  const t = clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1), 0, 1);
  return Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t);
}

function segmentDistance(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number {
  const cross = (u: Vec2, v: Vec2) => u.x * v.z - u.z * v.x;
  const u = { x: b.x - a.x, z: b.z - a.z };
  const v = { x: d.x - c.x, z: d.z - c.z };
  const w = { x: c.x - a.x, z: c.z - a.z };
  const denominator = cross(u, v);
  if (Math.abs(denominator) > 0.00001) {
    const t = cross(w, v) / denominator,
      s = cross(w, u) / denominator;
    if (t >= 0 && t <= 1 && s >= 0 && s <= 1) return 0;
  }
  return Math.min(
    pointSegmentDistance(a, c, d),
    pointSegmentDistance(b, c, d),
    pointSegmentDistance(c, a, b),
    pointSegmentDistance(d, a, b),
  );
}

/** Sword volumes, rather than proximity between attacking characters, decide clashes. */
export function attacksClash(a: Fighter, b: Fighter): boolean {
  if (
    a.mode !== "active" ||
    b.mode !== "active" ||
    !a.attack ||
    !b.attack ||
    a.hitstop > 0 ||
    b.hitstop > 0 ||
    Math.abs(a.y - b.y) > 1.2
  )
    return false;
  const blades = (f: Fighter): [Vec2, Vec2][] => {
    const definition = ATTACKS[f.attack!];
    const angles = f.attack === "sweep" ? [-1.05, -0.52, 0, 0.52, 1.05] : [0];
    return angles.map((offset) => {
      const x = Math.sin(f.facing + offset),
        z = Math.cos(f.facing + offset);
      return [
        { x: f.x + x * 0.6, z: f.z + z * 0.6 },
        { x: f.x + x * definition.reach, z: f.z + z * definition.reach },
      ];
    });
  };
  return blades(a).some(([p, q]) => blades(b).some(([r, s]) => segmentDistance(p, q, r, s) < 0.3));
}
