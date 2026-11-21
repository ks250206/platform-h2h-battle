// Match rules: the arena gimmicks a match runs with, the presets the title offers, the time limit,
// and per-stage constraints. Importable in node (tests): no DOM access, no engine import.

import { RULES } from "./tuning";
import type { MatchMode } from "./types";

/** The arena's four gimmicks. Each one can be switched off before a duel or a rumble. */
export type GimmickId = "collapse" | "safeZone" | "bombs" | "wind";
export const GIMMICK_IDS: readonly GimmickId[] = ["collapse", "safeZone", "bombs", "wind"];

/** Which gimmicks are on. */
export type Gimmicks = Record<GimmickId, boolean>;

export const GIMMICK_LABELS: Record<GimmickId, string> = {
  collapse: "外周崩壊",
  safeZone: "セーフゾーン",
  bombs: "爆撃",
  wind: "風",
};

export const GIMMICK_DETAILS: Record<GimmickId, string> = {
  collapse: "時間とともに外周の足場が崩れ、浮島が狭くなる",
  safeZone: "光の円の外では%とエリア外ゲージが増える",
  bombs: "赤い予告円の位置に爆撃が落ちる",
  wind: "ときどき風が吹き、地上の選手を押し流す",
};

export const ALL_GIMMICKS: Readonly<Gimmicks> = {
  collapse: true,
  safeZone: true,
  bombs: true,
  wind: true,
};
export const NO_GIMMICKS: Readonly<Gimmicks> = {
  collapse: false,
  safeZone: false,
  bombs: false,
  wind: false,
};

/**
 * How long a match may run. "standard" grows with the lives (`RULES.maxMatchTime` plus
 * `RULES.matchTimePerStock` per life beyond the first); "short" is a flat `SHORT_TIME_LIMIT`.
 */
export type TimeRule = "standard" | "short";
export const TIME_RULES: readonly TimeRule[] = ["standard", "short"];
/** Seconds of a "short" match, whatever the lives. */
export const SHORT_TIME_LIMIT = 90;

export const TIME_RULE_LABELS: Record<TimeRule, string> = {
  standard: "標準",
  short: `短め ${SHORT_TIME_LIMIT}秒`,
};

/** Seconds before time-up for `stocks` lives under `time`. */
export function timeLimitFor(stocks: number, time: TimeRule = "standard"): number {
  if (time === "short") return SHORT_TIME_LIMIT;
  return RULES.maxMatchTime + RULES.matchTimePerStock * (Math.max(1, stocks) - 1);
}

/** The rule fields a preset sets. Players, devices and CPU strength are never part of it. */
export interface RuleSet {
  stocks: number;
  time: TimeRule;
  gimmicks: Gimmicks;
}

export type PresetId = "standard" | "short" | "noGimmicks";
export const PRESET_IDS: readonly PresetId[] = ["standard", "short", "noGimmicks"];

export interface RulePreset {
  id: PresetId;
  label: string;
  detail: string;
  rules: Readonly<RuleSet>;
}

export const RULE_PRESETS: Record<PresetId, RulePreset> = {
  standard: {
    id: "standard",
    label: "標準",
    detail: "おすすめ。残機3、ギミックすべてあり",
    rules: { stocks: 3, time: "standard", gimmicks: { ...ALL_GIMMICKS } },
  },
  short: {
    id: "short",
    label: "短時間",
    detail: `残機1、${SHORT_TIME_LIMIT}秒で決着。ギミックすべてあり`,
    rules: { stocks: 1, time: "short", gimmicks: { ...ALL_GIMMICKS } },
  },
  noGimmicks: {
    id: "noGimmicks",
    label: "ギミックなし",
    detail: "残機3、足場は崩れず爆撃も風もない純粋な剣の勝負",
    rules: { stocks: 3, time: "standard", gimmicks: { ...NO_GIMMICKS } },
  },
};

export const DEFAULT_PRESET: PresetId = "standard";

/** A fresh copy of a preset's rules, ready to merge into the match options. */
export function presetRules(id: PresetId): RuleSet {
  const { stocks, time, gimmicks } = RULE_PRESETS[id].rules;
  return { stocks, time, gimmicks: { ...gimmicks } };
}

/** The preset whose every rule matches exactly, or "custom" once anything differs. */
export function presetOf(rules: RuleSet): PresetId | "custom" {
  for (const id of PRESET_IDS) {
    const preset = RULE_PRESETS[id].rules;
    if (
      preset.stocks === rules.stocks &&
      preset.time === rules.time &&
      GIMMICK_IDS.every((g) => preset.gimmicks[g] === rules.gimmicks[g])
    )
      return id;
  }
  return "custom";
}

export const PRESET_LABELS: Record<PresetId | "custom", string> = {
  standard: RULE_PRESETS.standard.label,
  short: RULE_PRESETS.short.label,
  noGimmicks: RULE_PRESETS.noGimmicks.label,
  custom: "カスタム",
};

/** Every field valid: a missing or non-boolean gimmick is on (saves from before the toggles). */
export function sanitizeGimmicks(raw: unknown): Gimmicks {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const gimmicks = { ...ALL_GIMMICKS };
  for (const id of GIMMICK_IDS) if (typeof source[id] === "boolean") gimmicks[id] = source[id];
  return gimmicks;
}

export const isTimeRule = (value: unknown): value is TimeRule =>
  TIME_RULES.includes(value as TimeRule);

/**
 * What a stage does to a gimmick: `forced` is the value it always has there, whatever the
 * players chose, and `reason` is what the title shows for it.
 */
export interface GimmickConstraint {
  forced: boolean;
  reason: string;
}
export type GimmickConstraints = Partial<Record<GimmickId, GimmickConstraint>>;

export interface StageInfo {
  id: string;
  name: string;
  constraints: GimmickConstraints;
}

/** The one arena so far. Its gimmicks follow the players' choice. */
export const FLOATING_GARDEN: StageInfo = {
  id: "garden",
  name: "THE FLOATING GARDEN",
  constraints: {},
};

/** A gimmick the stage (or the mode) overrides, for the title to explain. */
export interface RuleNote {
  gimmick: GimmickId;
  chosen: boolean;
  effective: boolean;
  reason: string;
}

/** The rules a match actually runs with. */
export interface EffectiveRules {
  /** Lives per fighter; null in training (infinite). */
  stocks: number | null;
  /** Seconds before time-up; null in training (no clock). */
  timeLimit: number | null;
  time: TimeRule;
  gimmicks: Gimmicks;
  /** Every gimmick the stage or the mode changed from the players' choice, with the reason. */
  notes: RuleNote[];
}

const TRAINING_REASON = "稽古ではギミックは常に無効";

/**
 * The rules `mode` on `stage` runs with for the chosen ones. Duel and rumble share the same
 * semantics; training ignores the choice (infinite lives, no clock, no gimmicks).
 */
export function effectiveRules(
  chosen: RuleSet,
  mode: MatchMode,
  stage: StageInfo = FLOATING_GARDEN,
): EffectiveRules {
  const training = mode === "training";
  const gimmicks = { ...chosen.gimmicks };
  const notes: RuleNote[] = [];
  for (const id of GIMMICK_IDS) {
    const constraint = training
      ? { forced: false, reason: TRAINING_REASON }
      : stage.constraints[id];
    if (!constraint) continue;
    gimmicks[id] = constraint.forced;
    if (constraint.forced !== chosen.gimmicks[id])
      notes.push({
        gimmick: id,
        chosen: chosen.gimmicks[id],
        effective: constraint.forced,
        reason: constraint.reason,
      });
  }
  return {
    stocks: training ? null : chosen.stocks,
    timeLimit: training ? null : timeLimitFor(chosen.stocks, chosen.time),
    time: chosen.time,
    gimmicks,
    notes,
  };
}

/** "4:30" for 270 seconds. */
export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** One line for the title: lives, clock and the gimmicks that will be on. */
export function describeRules(rules: EffectiveRules): string {
  if (rules.stocks === null) return "残機 無制限 · 時間制限なし · ギミックなし";
  const on = GIMMICK_IDS.filter((id) => rules.gimmicks[id]).map((id) => GIMMICK_LABELS[id]);
  return `残機 ${rules.stocks} · 制限時間 ${formatClock(rules.timeLimit ?? 0)} · ギミック: ${
    on.length ? on.join("・") : "なし"
  }`;
}
