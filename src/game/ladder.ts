import { defaultLoadout, LOADOUT_SLOTS, type Loadout } from "./characters";
import { loadoutFor, type AiLevel, type MatchOptions } from "./match";
import { presetRules } from "./rules";
import type { StageId } from "./stages";

export interface LadderOpponent {
  readonly title: string;
  readonly loadout: Readonly<Loadout>;
  readonly difficulty: AiLevel;
  readonly stage: StageId;
}

export const LADDER_ROUNDS: readonly [LadderOpponent, ...LadderOpponent[]] = [
  {
    title: "庭園の見習い",
    loadout: { species: "rabbit", palette: "mint", accessory: "flower" },
    difficulty: "easy",
    stage: "garden",
  },
  {
    title: "遺跡の番人",
    loadout: { species: "bear", palette: "lavender", accessory: "headband" },
    difficulty: "normal",
    stage: "ruins",
  },
  {
    title: "工場の剣士",
    loadout: { species: "raccoon", palette: "marigold", accessory: "goggles" },
    difficulty: "normal",
    stage: "factory",
  },
  {
    title: "天空の王者",
    loadout: { species: "fox", palette: "berry", accessory: "crown" },
    difficulty: "hard",
    stage: "bridges",
  },
];

type LadderPlayerOptions = Pick<MatchOptions, "controls" | "loadouts">;

/** An isolated standard duel. The preferred device is resolved at launch by playableOptions. */
export function ladderMatchOptions(
  saved: LadderPlayerOptions,
  opponent: LadderOpponent,
): MatchOptions {
  const loadouts = Array.from({ length: LOADOUT_SLOTS }, (_, slot) => defaultLoadout(slot));
  loadouts[0] = { ...loadoutFor(saved, 0) };
  loadouts[1] = { ...opponent.loadout };
  return {
    ...presetRules("standard"),
    controls: { 0: saved.controls[0] ?? "keyboard" },
    overrides: {},
    difficulty: opponent.difficulty,
    stage: opponent.stage,
    loadouts,
  };
}

type LadderOutcome = "win" | "loss" | "draw";
type LadderPhase = "ready" | "playing" | "result" | "clear" | "exited";

export interface LadderProgress {
  phase: LadderPhase;
  round: number;
  opponent: LadderOpponent;
  nextOpponent: LadderOpponent | null;
  outcome: LadderOutcome | null;
  totals: Readonly<{
    wins: number;
    losses: number;
    draws: number;
    retries: number;
    /** Sum of duel clocks, in seconds, including failed attempts. */
    elapsed: number;
  }>;
}

/** Tracks one run. Each engine start gets an ID so an old result cannot finish a new duel. */
export class LadderSession {
  private readonly player: LadderPlayerOptions;
  private phase: LadderPhase = "ready";
  private index = 0;
  private outcome: LadderOutcome | null = null;
  private attemptId: symbol | null = null;
  private readonly totals = { wins: 0, losses: 0, draws: 0, retries: 0, elapsed: 0 };

  constructor(saved: LadderPlayerOptions) {
    this.player = { controls: { 0: saved.controls[0] }, loadouts: [{ ...loadoutFor(saved, 0) }] };
  }

  get progress(): LadderProgress {
    return {
      phase: this.phase,
      round: this.index + 1,
      opponent: LADDER_ROUNDS[this.index],
      nextOpponent:
        this.phase === "result" && this.outcome === "win" ? LADDER_ROUNDS[this.index + 1] : null,
      outcome: this.outcome,
      totals: { ...this.totals },
    };
  }

  startAttempt(): { id: symbol; options: MatchOptions } | null {
    if (this.phase !== "ready" && this.phase !== "result") return null;
    if (this.phase === "result") {
      if (this.outcome === "win") this.index++;
      else this.totals.retries++;
    }
    this.phase = "playing";
    this.outcome = null;
    this.attemptId = Symbol();
    return {
      id: this.attemptId,
      options: ladderMatchOptions(this.player, LADDER_ROUNDS[this.index]),
    };
  }

  finish(id: symbol, winnerId: number | null, elapsed: number): boolean {
    if (this.phase !== "playing" || this.attemptId !== id) return false;
    this.attemptId = null;
    this.outcome = winnerId === 0 ? "win" : winnerId === null ? "draw" : "loss";
    this.totals[this.outcome === "win" ? "wins" : this.outcome === "loss" ? "losses" : "draws"]++;
    this.totals.elapsed += elapsed;
    this.phase = this.totals.wins === LADDER_ROUNDS.length ? "clear" : "result";
    return true;
  }

  exit(): void {
    this.phase = "exited";
    this.attemptId = null;
  }
}
