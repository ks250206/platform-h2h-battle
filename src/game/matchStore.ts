// The match options the title menu remembers between visits: a tiny store like the graphics
// settings one. Importable in node (tests): nothing touches `localStorage` at import time, every
// access to it is guarded, and the storage can be injected.

import {
  copyMatchOptions as copy,
  DEFAULT_MATCH_OPTIONS,
  MAX_FIGHTERS,
  padIndex,
  sanitizeMatchOptions,
  type ControlDevice,
  type MatchOptions,
} from "./match";
import { presetRules, type GimmickId, type PresetId } from "./rules";

type Controls = MatchOptions["controls"];

/** The device of each slot below `fighterCount`, or null for a CPU. */
const slotsOf = (controls: Controls, fighterCount: number): (ControlDevice | null)[] =>
  Array.from({ length: Math.min(fighterCount, MAX_FIGHTERS) }, (_, id) => controls[id] ?? null);

/** The slot (any of the four) that `device` drives, or -1. */
const slotOf = (controls: Controls, device: ControlDevice): number => {
  for (let id = 0; id < MAX_FIGHTERS; id++) if (controls[id] === device) return id;
  return -1;
};

/**
 * Puts `device` (null: a CPU) on `slot` of a match with `fighterCount` fighters. A device that
 * another slot of the match uses swaps with this slot's device; taken from a slot the mode does not
 * have (a rumble slot while choosing a duel) it simply moves. Returns the controls unchanged when
 * the change would leave slot 0 without a human.
 */
export function assignDevice(
  controls: Controls,
  slot: number,
  device: ControlDevice | null,
  fighterCount: number,
): Controls {
  const next: Controls = { ...controls };
  if (slot < 0 || slot >= Math.min(fighterCount, MAX_FIGHTERS)) return next;
  const previous = next[slot] ?? null;
  if (device === previous) return next;
  if (device === null) {
    if (slot === 0) return next;
    delete next[slot];
    return next;
  }
  const other = slotOf(next, device);
  if (other >= 0 && other < fighterCount) {
    if (previous === null && other === 0) return next;
    if (previous) next[other] = previous;
    else delete next[other];
  } else if (other >= 0) delete next[other];
  next[slot] = device;
  return next;
}

/**
 * Smash-style joining: pad `index` takes the first CPU slot of a match with `fighterCount`
 * fighters. Null when it already plays in that match or every slot is taken.
 */
export function joinPad(
  controls: Controls,
  index: number,
  fighterCount: number,
): { controls: Controls; slot: number } | null {
  const device = `pad${index + 1}` as ControlDevice;
  const slots = slotsOf(controls, fighterCount);
  if (slots.includes(device)) return null;
  const slot = slots.findIndex((taken, id) => id > 0 && taken === null);
  if (slot < 0) return null;
  return { controls: assignDevice(controls, slot, device, fighterCount), slot };
}

/** Pad `index` leaves the match: its slot goes back to a CPU. Null for slot 0 or a pad not in it. */
export function leavePad(
  controls: Controls,
  index: number,
  fighterCount: number,
): { controls: Controls; slot: number } | null {
  const slot = slotsOf(controls, fighterCount).indexOf(`pad${index + 1}` as ControlDevice);
  if (slot <= 0) return null;
  return { controls: assignDevice(controls, slot, null, fighterCount), slot };
}

/** A slot whose saved device cannot play right now, and who plays it instead. */
export interface Substitute {
  slot: number;
  device: ControlDevice;
  /** The keyboard (slot 0 always has a human) or null for a CPU. */
  by: "keyboard" | null;
}

/**
 * The options a match actually starts with: slots of the match only, and every slot whose pad is
 * not connected played by a CPU. Slot 0 must stay human, so without its pad it takes the keyboard
 * (and the keyboard's slot, if any, becomes a CPU).
 */
export function playableOptions(
  options: MatchOptions,
  fighterCount: number,
  connected: (padIndex: number) => boolean,
): { options: MatchOptions; substitutes: Substitute[] } {
  const controls: Controls = {};
  const substitutes: Substitute[] = [];
  slotsOf(options.controls, fighterCount).forEach((device, slot) => {
    if (!device) return;
    const pad = padIndex(device);
    if (pad === null || connected(pad)) controls[slot] = device;
    else if (slot > 0) substitutes.push({ slot, device, by: null });
  });
  if (!controls[0]) {
    const keyboard = slotOf(controls, "keyboard");
    if (keyboard > 0) {
      delete controls[keyboard];
      substitutes.push({ slot: keyboard, device: "keyboard", by: null });
    }
    controls[0] = "keyboard";
    if (options.controls[0])
      substitutes.push({ slot: 0, device: options.controls[0], by: "keyboard" });
    substitutes.sort((a, b) => a.slot - b.slot);
  }
  return { options: { ...copy(options), controls }, substitutes };
}

/**
 * `options` with a preset's rules (lives, time limit, gimmicks). Who plays which slot and how
 * strong the CPUs are stay exactly as they were.
 */
export function applyPreset(options: MatchOptions, id: PresetId): MatchOptions {
  return { ...copy(options), ...presetRules(id) };
}

export const MATCH_STORAGE_KEY = "bramble.match.v1";

/** The subset of the Storage API the store needs; `localStorage` in the browser. */
export type MatchStorage = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): MatchStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // Some browsers throw on access when site data is blocked.
    return null;
  }
}

/** The saved options, every corrupt or missing field replaced by its default. */
export function loadMatchOptions(storage: MatchStorage | null = browserStorage()): MatchOptions {
  try {
    const raw = storage?.getItem(MATCH_STORAGE_KEY);
    return raw ? sanitizeMatchOptions(JSON.parse(raw)) : copy(DEFAULT_MATCH_OPTIONS);
  } catch {
    return copy(DEFAULT_MATCH_OPTIONS);
  }
}

export function saveMatchOptions(
  options: MatchOptions,
  storage: MatchStorage | null = browserStorage(),
): void {
  try {
    storage?.setItem(MATCH_STORAGE_KEY, JSON.stringify(options));
  } catch {
    // Private browsing or a full quota: the choice still applies for this session.
  }
}

export interface MatchStore {
  /** A copy of the current options; changing it does not change the store. */
  get(): MatchOptions;
  /**
   * Merges `patch` (a `controls`, `overrides` or `gimmicks` patch replaces that map), sanitizes
   * and saves.
   */
  set(patch: Partial<MatchOptions>): void;
  /** Applies a rule preset: lives, time limit and gimmicks only (`applyPreset`). */
  preset(id: PresetId): void;
  /** Switches one gimmick on or off; the other rules stay. */
  toggleGimmick(id: GimmickId, on?: boolean): void;
  /** Puts a device (null: a CPU) on a slot, swapping with the slot that had it (`assignDevice`). */
  assign(slot: number, device: ControlDevice | null, fighterCount: number): void;
  /** Pad `index` joins on the first CPU slot; returns that slot, or null (`joinPad`). */
  join(index: number, fighterCount: number): number | null;
  /** Pad `index` leaves; returns the slot it left, or null (`leavePad`). */
  leave(index: number, fighterCount: number): number | null;
  /** Called after every change with the new and the previous options. Returns an unsubscribe. */
  subscribe(listener: (options: MatchOptions, previous: MatchOptions) => void): () => void;
}

export function createMatchStore(storage: MatchStorage | null = browserStorage()): MatchStore {
  let current = loadMatchOptions(storage);
  const listeners = new Set<(options: MatchOptions, previous: MatchOptions) => void>();
  const set = (patch: Partial<MatchOptions>) => {
    const previous = current;
    current = sanitizeMatchOptions({ ...current, ...patch });
    saveMatchOptions(current, storage);
    for (const listener of listeners) listener(copy(current), copy(previous));
  };
  return {
    get: () => copy(current),
    set,
    preset(id) {
      set(presetRules(id));
    },
    toggleGimmick(id, on = !current.gimmicks[id]) {
      set({ gimmicks: { ...current.gimmicks, [id]: on } });
    },
    assign(slot, device, fighterCount) {
      const controls = assignDevice(current.controls, slot, device, fighterCount);
      if (JSON.stringify(controls) !== JSON.stringify(current.controls)) set({ controls });
    },
    join(index, fighterCount) {
      const result = joinPad(current.controls, index, fighterCount);
      if (result) set({ controls: result.controls });
      return result?.slot ?? null;
    },
    leave(index, fighterCount) {
      const result = leavePad(current.controls, index, fighterCount);
      if (result) set({ controls: result.controls });
      return result?.slot ?? null;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
