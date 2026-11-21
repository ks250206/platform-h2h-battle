// Match options the player chooses before a fight. Importable in node (tests): no DOM access.

/** How well a CPU fighter plays. */
export type AiLevel = "easy" | "normal" | "hard";
export const AI_LEVEL_IDS: readonly AiLevel[] = ["easy", "normal", "hard"];

/** Lives per fighter the menu offers. */
export const STOCK_CHOICES = [1, 2, 3, 4, 5] as const;

export interface MatchOptions {
  /** Lives per fighter. Training ignores it: everyone there respawns for ever. */
  stocks: number;
  /** Strength of every CPU that has no override. */
  difficulty: AiLevel;
  /** Per-CPU strength keyed by fighter id (1-3). A missing id follows `difficulty`. */
  overrides: Partial<Record<number, AiLevel>>;
}

export const DEFAULT_MATCH_OPTIONS: MatchOptions = {
  stocks: 3,
  difficulty: "normal",
  overrides: {},
};

/** The strength a given CPU fighter plays at. */
export function levelFor(options: MatchOptions, fighterId: number): AiLevel {
  return options.overrides[fighterId] ?? options.difficulty;
}

const isLevel = (value: unknown): value is AiLevel => AI_LEVEL_IDS.includes(value as AiLevel);

/** Keeps every valid field of `raw` and replaces each missing, corrupt or out-of-range one. */
export function sanitizeMatchOptions(raw: unknown): MatchOptions {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const overrides: Partial<Record<number, AiLevel>> = {};
  if (source.overrides && typeof source.overrides === "object") {
    for (const [key, value] of Object.entries(source.overrides as Record<string, unknown>)) {
      const id = Number(key);
      if (Number.isInteger(id) && id >= 1 && id <= 3 && isLevel(value)) overrides[id] = value;
    }
  }
  return {
    stocks: (STOCK_CHOICES as readonly number[]).includes(source.stocks as number)
      ? (source.stocks as number)
      : DEFAULT_MATCH_OPTIONS.stocks,
    difficulty: isLevel(source.difficulty) ? source.difficulty : DEFAULT_MATCH_OPTIONS.difficulty,
    overrides,
  };
}
