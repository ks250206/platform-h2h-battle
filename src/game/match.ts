// Match options the player chooses before a fight. Importable in node (tests): no DOM access.

import {
  DEFAULT_LOADOUTS,
  LOADOUT_SLOTS,
  defaultLoadout,
  sanitizeLoadouts,
  type Loadout,
} from "./characters";
import {
  isTimeRule,
  presetRules,
  sanitizeGimmicks,
  DEFAULT_PRESET,
  type Gimmicks,
  type TimeRule,
} from "./rules";
import { DEFAULT_STAGE, isStageId, type StageId } from "./stages";
import { sanitizeSetFormat, type SetFormat } from "./setMatch";

/** How well a CPU fighter plays. */
export type AiLevel = "easy" | "normal" | "hard";
export const AI_LEVEL_IDS: readonly AiLevel[] = ["easy", "normal", "hard"];

/** Lives per fighter the menu offers. */
export const STOCK_CHOICES = [1, 2, 3, 4, 5] as const;

/** What a human plays with. One keyboard (with the mouse, or the touch screen) and up to four pads. */
export type ControlDevice = "keyboard" | "pad1" | "pad2" | "pad3" | "pad4";
export const CONTROL_DEVICES: readonly ControlDevice[] = [
  "keyboard",
  "pad1",
  "pad2",
  "pad3",
  "pad4",
];
/** Fighter slots a match can have: 2 in a duel, 4 in a rumble. */
export const MAX_FIGHTERS = LOADOUT_SLOTS;

export interface MatchOptions {
  /**
   * Which device drives which fighter, keyed by fighter id (0-3). A slot without an entry is a
   * CPU. Slot 0 is always a human, and no device drives two slots.
   */
  controls: Partial<Record<number, ControlDevice>>;
  /** The selected 1v1 format. Other modes use a single game. */
  setFormat: SetFormat;
  /** Lives per fighter. Training ignores it: everyone there respawns for ever. */
  stocks: number;
  /** Strength of every CPU that has no override. */
  difficulty: AiLevel;
  /** Per-CPU strength keyed by fighter id (1-3). A missing id follows `difficulty`. */
  overrides: Partial<Record<number, AiLevel>>;
  /** The time limit rule (see `timeLimitFor`). Training ignores it. */
  time: TimeRule;
  /** Which arena gimmicks run. Training ignores it: it never has any. */
  gimmicks: Gimmicks;
  /**
   * What each slot (0-3) looks like: animal, colours and accessory. Always four entries. It is
   * independent of everything above: a look belongs to its slot whoever plays it, any two slots
   * may share one, and none of it changes how a fighter plays.
   */
  loadouts: Loadout[];
  /** Where the match is fought (see stages.ts). Every mode, training included, uses it. */
  stage: StageId;
}

export const DEFAULT_MATCH_OPTIONS: MatchOptions = {
  controls: { 0: "keyboard" },
  setFormat: "single",
  difficulty: "normal",
  overrides: {},
  ...presetRules(DEFAULT_PRESET),
  loadouts: DEFAULT_LOADOUTS.map((loadout) => ({ ...loadout })),
  stage: DEFAULT_STAGE,
};

/** A deep copy: changing it never changes `options`. */
export function copyMatchOptions(options: MatchOptions): MatchOptions {
  return {
    ...options,
    controls: { ...options.controls },
    overrides: { ...options.overrides },
    gimmicks: { ...options.gimmicks },
    loadouts: options.loadouts.map((loadout) => ({ ...loadout })),
  };
}

/** The look of slot `fighterId`; a slot the options somehow lack wears its default. */
export function loadoutFor(options: Pick<MatchOptions, "loadouts">, fighterId: number): Loadout {
  return options.loadouts[fighterId] ?? defaultLoadout(fighterId);
}

/** The strength a given CPU fighter plays at. */
export function levelFor(options: MatchOptions, fighterId: number): AiLevel {
  return options.overrides[fighterId] ?? options.difficulty;
}

const isLevel = (value: unknown): value is AiLevel => AI_LEVEL_IDS.includes(value as AiLevel);
const isDevice = (value: unknown): value is ControlDevice =>
  CONTROL_DEVICES.includes(value as ControlDevice);

/** The gamepad index (0-3) a device stands for, or null for the keyboard. */
export function padIndex(device: ControlDevice): number | null {
  return device === "keyboard" ? null : Number(device.slice(3)) - 1;
}

/**
 * The human slots of a match with `fighterCount` fighters, in slot order. Slots beyond the count
 * are ignored (a duel has two), and slot 0 always has a device.
 */
export function humanSlots(
  options: MatchOptions,
  fighterCount: number,
): { id: number; device: ControlDevice }[] {
  const slots: { id: number; device: ControlDevice }[] = [];
  for (let id = 0; id < Math.min(fighterCount, MAX_FIGHTERS); id++) {
    const device = options.controls[id];
    if (device) slots.push({ id, device });
  }
  if (slots[0]?.id !== 0) slots.unshift({ id: 0, device: firstFree(slots.map((s) => s.device)) });
  return slots;
}

const firstFree = (taken: readonly ControlDevice[]): ControlDevice =>
  CONTROL_DEVICES.find((device) => !taken.includes(device)) ?? "keyboard";

function sanitizeControls(raw: unknown): Partial<Record<number, ControlDevice>> {
  const controls: Partial<Record<number, ControlDevice>> = {};
  const taken: ControlDevice[] = [];
  if (raw && typeof raw === "object") {
    for (let id = 0; id < MAX_FIGHTERS; id++) {
      const device = (raw as Record<string, unknown>)[id];
      if (!isDevice(device) || taken.includes(device)) continue;
      controls[id] = device;
      taken.push(device);
    }
  }
  if (!controls[0]) controls[0] = firstFree(taken);
  return controls;
}

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
    controls: sanitizeControls(source.controls),
    setFormat: sanitizeSetFormat(source.setFormat),
    stocks: (STOCK_CHOICES as readonly number[]).includes(source.stocks as number)
      ? (source.stocks as number)
      : DEFAULT_MATCH_OPTIONS.stocks,
    difficulty: isLevel(source.difficulty) ? source.difficulty : DEFAULT_MATCH_OPTIONS.difficulty,
    overrides,
    time: isTimeRule(source.time) ? source.time : DEFAULT_MATCH_OPTIONS.time,
    gimmicks: sanitizeGimmicks(source.gimmicks),
    loadouts: sanitizeLoadouts(source.loadouts),
    // Options saved before stages existed have no stage: they play on the garden, as they did.
    stage: isStageId(source.stage) ? source.stage : DEFAULT_MATCH_OPTIONS.stage,
  };
}
