import type { Graphics } from "pixi.js";
import { attackVolume, forward } from "../game/combat";
import { RULES } from "../game/tuning";
import type { Fighter, Vec2 } from "../game/types";

type Point = Vec2 & { y: number };
type Project = (point: Point) => { x: number; y: number } | null;

/** Intersect a ray with the three sweep constraints: reach, rear plane, padded arc. */
function outline(f: Fighter, v: NonNullable<ReturnType<typeof attackVolume>>): Vec2[] {
  const facing = forward(f);
  const point = (side: number, ahead: number) => ({
    x: f.x + facing.x * ahead + facing.z * side,
    z: f.z + facing.z * ahead - facing.x * side,
  });
  if (v.sweepCos === null) {
    return [
      point(-v.halfWidth, v.minAhead),
      point(v.halfWidth, v.minAhead),
      point(v.halfWidth, v.maxAhead),
      point(-v.halfWidth, v.maxAhead),
    ];
  }
  const cos = v.sweepCos;
  return Array.from({ length: 96 }, (_, i) => {
    const angle = (i * Math.PI) / 48;
    const c = Math.cos(angle);
    const r = Math.min(
      v.maxAhead,
      c < 0 ? v.minAhead / c : Infinity,
      c < cos ? RULES.fighterRadius / (cos - c) : Infinity,
    );
    return point(Math.sin(angle) * r, c * r);
  });
}

export function debugGeometry(f: Fighter) {
  if (f.mode === "dead") return null;
  // Combat tests the feet against an already radius-expanded attack. The ring marks the
  // horizontal body radius at precisely that height; there is no vertical body capsule.
  const hurt = Array.from({ length: 48 }, (_, i) => {
    const angle = (i * Math.PI) / 24;
    return {
      x: f.x + RULES.fighterRadius * Math.sin(angle),
      y: f.y,
      z: f.z + RULES.fighterRadius * Math.cos(angle),
    };
  });
  const v = attackVolume(f);
  const edge = v ? outline(f, v) : [];
  const ring = (dy: number) => edge.map((p) => ({ ...p, y: f.y + dy }));
  return { hurt, low: ring(v?.minY ?? 0), high: ring(v?.maxY ?? 0) };
}

export function drawTrainingDebug(graphics: Graphics, fighters: Fighter[], project: Project): void {
  graphics.clear();
  function path(points: Point[], color: number, closed: boolean) {
    if (!points.length) return;
    const screen = points.map(project);
    if (screen.some((p) => !p)) return;
    graphics.moveTo(screen[0]!.x, screen[0]!.y);
    for (const p of screen.slice(1)) graphics.lineTo(p!.x, p!.y);
    if (closed) graphics.closePath();
    graphics.stroke({ width: 2, color, alpha: 0.9 });
  }
  for (const fighter of fighters) {
    const g = debugGeometry(fighter);
    if (!g) continue;
    path(g.hurt, 0x40ffe1, true);
    path(g.low, 0xff543a, true);
    path(g.high, 0xff543a, true);
    for (let i = 0; i < g.low.length; i += Math.max(1, g.low.length / 8)) {
      path([g.low[i], g.high[i]], 0xff543a, false);
    }
  }
}
