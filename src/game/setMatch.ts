import { addPlayerStats, emptyPlayerStats, type PlayerMatchStats } from "./matchStats";
import type { MatchMode } from "./types";

export const SET_FORMAT_LABELS = {
  single: "単発",
  bo3: "BO3（2勝先取）",
  bo5: "BO5（3勝先取）",
} as const;
export type SetFormat = keyof typeof SET_FORMAT_LABELS;

export function sanitizeSetFormat(value: unknown): SetFormat {
  return value === "bo3" || value === "bo5" ? value : "single";
}

export function effectiveSetFormat(mode: MatchMode, format: SetFormat): SetFormat {
  return mode === "duel" ? format : "single";
}

export interface SetMatch {
  format: Exclude<SetFormat, "single">;
  winsNeeded: number;
  gameNumber: number;
  wins: readonly [number, number];
  totals: readonly [PlayerMatchStats, PlayerMatchStats];
  phase: "playing" | "betweenGames" | "complete";
  winnerId: number | null;
}

export function createSetMatch(format: SetFormat): SetMatch | null {
  if (format === "single") return null;
  return {
    format,
    winsNeeded: format === "bo3" ? 2 : 3,
    gameNumber: 1,
    wins: [0, 0],
    totals: [emptyPlayerStats(), emptyPlayerStats()],
    phase: "playing",
    winnerId: null,
  };
}

/** Records a finished game once. A draw contributes stats but no wins. */
export function finishSetGame(
  set: SetMatch,
  winnerId: number | null,
  stats: readonly PlayerMatchStats[],
): SetMatch {
  if (set.phase !== "playing") return set;
  const wins = [set.wins[0], set.wins[1]] as [number, number];
  if (winnerId === 0 || winnerId === 1) wins[winnerId]++;
  const winner = winnerId !== null && wins[winnerId] === set.winsNeeded ? winnerId : null;
  return {
    ...set,
    wins,
    totals: [addPlayerStats(set.totals[0], stats[0]), addPlayerStats(set.totals[1], stats[1])],
    phase: winner === null ? "betweenGames" : "complete",
    winnerId: winner,
  };
}

export function advanceSet(set: SetMatch): SetMatch | null {
  if (set.phase !== "betweenGames") return null;
  return { ...set, gameNumber: set.gameNumber + 1, phase: "playing" };
}
