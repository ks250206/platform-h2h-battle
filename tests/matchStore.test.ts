import { describe, expect, test, vi } from "vite-plus/test";
import { DEFAULT_MATCH_OPTIONS } from "../src/game/match";
import {
  createMatchStore,
  loadMatchOptions,
  MATCH_STORAGE_KEY,
  saveMatchOptions,
  type MatchStorage,
} from "../src/game/matchStore";

function memoryStorage(initial?: string): MatchStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(MATCH_STORAGE_KEY, initial);
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

describe("match options store", () => {
  test("starts from the defaults when nothing is saved", () => {
    expect(loadMatchOptions(memoryStorage())).toEqual(DEFAULT_MATCH_OPTIONS);
    expect(createMatchStore(memoryStorage()).get()).toEqual({
      controls: { 0: "keyboard" },
      stocks: 3,
      difficulty: "normal",
      overrides: {},
    });
  });

  test("works without any storage (node, blocked site data)", () => {
    const store = createMatchStore(null);
    store.set({ stocks: 5 });
    expect(store.get().stocks).toBe(5);
    expect(loadMatchOptions(null)).toEqual(DEFAULT_MATCH_OPTIONS);
    expect(() => saveMatchOptions(DEFAULT_MATCH_OPTIONS, null)).not.toThrow();
  });

  test("round trips through storage under its own key", () => {
    const storage = memoryStorage();
    const store = createMatchStore(storage);
    store.set({ stocks: 1, difficulty: "hard", overrides: { 2: "easy" } });
    expect(JSON.parse(storage.data.get(MATCH_STORAGE_KEY)!)).toEqual({
      controls: { 0: "keyboard" },
      stocks: 1,
      difficulty: "hard",
      overrides: { 2: "easy" },
    });
    expect(createMatchStore(storage).get()).toEqual({
      controls: { 0: "keyboard" },
      stocks: 1,
      difficulty: "hard",
      overrides: { 2: "easy" },
    });
  });

  test("corrupt JSON falls back to the defaults", () => {
    expect(loadMatchOptions(memoryStorage("{not json"))).toEqual(DEFAULT_MATCH_OPTIONS);
    expect(loadMatchOptions(memoryStorage("null"))).toEqual(DEFAULT_MATCH_OPTIONS);
    expect(loadMatchOptions(memoryStorage('"hard"'))).toEqual(DEFAULT_MATCH_OPTIONS);
  });

  test("bad fields are replaced one by one, good ones kept", () => {
    const stored = JSON.stringify({ stocks: 9, difficulty: "hard", overrides: "x" });
    expect(loadMatchOptions(memoryStorage(stored))).toEqual({
      controls: { 0: "keyboard" },
      stocks: 3,
      difficulty: "hard",
      overrides: {},
    });
    const other = JSON.stringify({ stocks: 2, difficulty: "insane", overrides: { 1: "mega" } });
    expect(loadMatchOptions(memoryStorage(other))).toEqual({
      controls: { 0: "keyboard" },
      stocks: 2,
      difficulty: "normal",
      overrides: {},
    });
    const store = createMatchStore(memoryStorage());
    store.set({ stocks: 0 });
    expect(store.get().stocks).toBe(3);
  });

  test("overrides for ids outside 1-3 are dropped", () => {
    const stored = JSON.stringify({
      overrides: { 0: "hard", 1: "easy", 3: "hard", 4: "easy", "-1": "hard", "1.5": "easy" },
    });
    expect(loadMatchOptions(memoryStorage(stored)).overrides).toEqual({ 1: "easy", 3: "hard" });
    const store = createMatchStore(memoryStorage());
    store.set({ overrides: { 7: "hard", 2: "hard" } });
    expect(store.get().overrides).toEqual({ 2: "hard" });
  });

  test("throwing storage is tolerated", () => {
    const broken: MatchStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    const store = createMatchStore(broken);
    expect(store.get()).toEqual(DEFAULT_MATCH_OPTIONS);
    expect(() => store.set({ difficulty: "easy" })).not.toThrow();
    expect(store.get().difficulty).toBe("easy");
  });

  test("get returns a copy", () => {
    const store = createMatchStore(memoryStorage());
    const options = store.get();
    options.stocks = 5;
    options.overrides[1] = "hard";
    expect(store.get()).toEqual(DEFAULT_MATCH_OPTIONS);
  });

  test("subscribers hear every change until they unsubscribe", () => {
    const store = createMatchStore(memoryStorage());
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.set({ stocks: 4 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]![0]).toMatchObject({ stocks: 4 });
    expect(listener.mock.calls[0]![1]).toMatchObject({ stocks: 3 });
    unsubscribe();
    store.set({ stocks: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
