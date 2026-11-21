// The match options the title menu remembers between visits: a tiny store like the graphics
// settings one. Importable in node (tests): nothing touches `localStorage` at import time, every
// access to it is guarded, and the storage can be injected.

import { DEFAULT_MATCH_OPTIONS, sanitizeMatchOptions, type MatchOptions } from "./match";

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

const copy = (options: MatchOptions): MatchOptions => ({
  ...options,
  overrides: { ...options.overrides },
});

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
  /** Merges `patch` (an `overrides` patch replaces the whole map), sanitizes and saves. */
  set(patch: Partial<MatchOptions>): void;
  /** Called after every change with the new and the previous options. Returns an unsubscribe. */
  subscribe(listener: (options: MatchOptions, previous: MatchOptions) => void): () => void;
}

export function createMatchStore(storage: MatchStorage | null = browserStorage()): MatchStore {
  let current = loadMatchOptions(storage);
  const listeners = new Set<(options: MatchOptions, previous: MatchOptions) => void>();
  return {
    get: () => copy(current),
    set(patch) {
      const previous = current;
      current = sanitizeMatchOptions({ ...current, ...patch });
      saveMatchOptions(current, storage);
      for (const listener of listeners) listener(copy(current), copy(previous));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
