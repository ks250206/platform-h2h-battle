import type { AiLevel } from "./match";
import type { StageId } from "./stages";
import { RULES } from "./tuning";
import type { Vec2 } from "./types";

export interface ZoneCircle extends Vec2 {
  radius: number;
}

/** Everything a player (or CPU) can know about the zone on this tick. */
export interface SafeZone extends ZoneCircle {
  active: boolean;
  phase: "off" | "early" | "mid" | "late";
  motion: "hold" | "warning" | "travel";
  destination: ZoneCircle | null;
  startsIn: number;
  travelLeft: number;
}

export const INACTIVE_ZONE: Readonly<SafeZone> = Object.freeze({
  x: 0,
  z: 0,
  radius: 0,
  active: false,
  phase: "off",
  motion: "hold",
  destination: null,
  startsIn: 0,
  travelLeft: 0,
});

export const ZONE_KO_REASON = `エリア外ゲージが${RULES.outsideLimit}秒に到達`;

const WARNING = 3;
const TRAVEL = 6;
const HOLD = 2;
const CYCLE = WARNING + TRAVEL + HOLD;
const CPU_LEAD: Record<AiLevel, number> = { easy: 0.8, normal: 1.4, hard: 2 };
const ORIGIN = { x: 0, z: 0 };
const RIM = [
  { x: 5, z: 5 },
  { x: 5, z: -5 },
  { x: -5, z: -5 },
  { x: -5, z: 5 },
];
const ISLANDS = [
  { x: 6.4, z: 0 },
  { x: 0, z: 6.4 },
  { x: -6.4, z: 0 },
  { x: 0, z: -6.4 },
];

function waypoint(stage: StageId, index: number, pressure: number): ZoneCircle {
  if (stage === "ruins") {
    const center = index === 0 ? { x: 0, z: 5 } : RIM[(index - 1) % RIM.length];
    return { ...center, radius: 10.4 - 7.2 * pressure };
  }
  if (stage === "bridges") {
    const center = index % 2 === 0 ? ORIGIN : ISLANDS[((index - 1) / 2) % ISLANDS.length];
    return { x: center.x, z: center.z, radius: 8.4 - 5.7 * pressure };
  }
  // Opposite corners of the permanent 5x5 deck. The whole circle fits at every interpolation.
  const radius = RULES.minHalfSize - (RULES.minHalfSize - 2.65) * pressure;
  const corner = (index % 2 === 0 ? -1 : 1) * (RULES.minHalfSize - radius);
  return { x: corner, z: corner, radius };
}

function between(a: ZoneCircle, b: ZoneCircle, t: number): ZoneCircle {
  return {
    x: a.x + (b.x - a.x) * t,
    z: a.z + (b.z - a.z) * t,
    radius: a.radius + (b.radius - a.radius) * t,
  };
}

/** A null clock disables the entire schedule (including all destination information). */
export function safeZoneAt(stage: StageId, elapsed: number, timeLimit: number | null): SafeZone {
  if (timeLimit === null || elapsed < Math.min(RULES.safeZoneStart, timeLimit * 0.12)) {
    return INACTIVE_ZONE;
  }
  const start = Math.min(48, timeLimit * 0.3);
  const midCycles = Math.max(1, Math.round((timeLimit * 0.6 - start) / CYCLE));
  const age = elapsed - start;
  const leg = Math.max(0, Math.floor(age / CYCLE));
  const at = (index: number) => waypoint(stage, index, Math.min(1, index / midCycles));
  const phase = age < 0 ? "early" : leg < midCycles ? "mid" : "late";
  const clock = age - leg * CYCLE;
  if (age < 0 || clock >= WARNING + TRAVEL) {
    const center = at(age < 0 ? 0 : leg + 1);
    return { ...INACTIVE_ZONE, ...center, active: true, phase };
  }
  const destination = at(leg + 1);
  const progress = Math.max(0, (clock - WARNING) / TRAVEL);
  return {
    ...between(at(leg), destination, progress),
    active: true,
    phase,
    motion: clock < WARNING ? "warning" : "travel",
    destination,
    startsIn: Math.max(0, WARNING - clock),
    travelLeft: TRAVEL * (1 - progress),
  };
}

/** Predict only the announced leg; during a hold the next departure is still private. */
export function announcedZoneIn(zone: SafeZone, seconds: number): ZoneCircle {
  if (!zone.destination) return zone;
  const t = Math.min(1, Math.max(0, seconds - zone.startsIn) / zone.travelLeft);
  return between(zone, zone.destination, t);
}

/** Lead the visible route while leaving room to fight within the current and upcoming circles. */
export function zoneWalkingGoal(zone: SafeZone, fighter: Vec2, level: AiLevel): Vec2 | null {
  if (!zone.active) return null;
  const next = announcedZoneIn(zone, zone.startsIn + CPU_LEAD[level]);
  if (
    Math.hypot(fighter.x - zone.x, fighter.z - zone.z) > zone.radius - 0.5 ||
    Math.hypot(fighter.x - next.x, fighter.z - next.z) > next.radius - 0.5
  )
    return next;
  return null;
}

/** Drop from rest plus enough time on the ground for the slowest sword startup. */
export const RESPAWN_STARTUP = 0.5;
export const RESPAWN_LOOKAHEAD =
  Math.sqrt((2 * RULES.respawnHeight) / RULES.gravity) + RESPAWN_STARTUP;
