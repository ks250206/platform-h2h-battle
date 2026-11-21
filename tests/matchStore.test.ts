import { describe, expect, test, vi } from "vite-plus/test";
import { DEFAULT_MATCH_OPTIONS } from "../src/game/match";
import {
  assignDevice,
  createMatchStore,
  joinPad,
  leavePad,
  loadMatchOptions,
  MATCH_STORAGE_KEY,
  playableOptions,
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

describe("who plays what", () => {
  test("a device another slot uses swaps with this slot's device", () => {
    expect(assignDevice({ 0: "keyboard", 1: "pad1" }, 1, "keyboard", 2)).toEqual({
      0: "pad1",
      1: "keyboard",
    });
    expect(assignDevice({ 0: "keyboard", 1: "pad1" }, 0, "pad1", 2)).toEqual({
      0: "pad1",
      1: "keyboard",
    });
    // A free device just takes the slot.
    expect(assignDevice({ 0: "keyboard" }, 1, "pad2", 2)).toEqual({ 0: "keyboard", 1: "pad2" });
    expect(assignDevice({ 0: "keyboard", 1: "pad2" }, 0, "pad3", 2)).toEqual({
      0: "pad3",
      1: "pad2",
    });
  });

  test("a CPU slot taking another human's device leaves that one a CPU", () => {
    expect(assignDevice({ 0: "keyboard", 1: "pad1" }, 2, "pad1", 4)).toEqual({
      0: "keyboard",
      2: "pad1",
    });
  });

  test("slot 0 never ends up without a human", () => {
    const controls = { 0: "keyboard", 1: "pad1" } as const;
    expect(assignDevice(controls, 0, null, 2)).toEqual(controls);
    // A CPU slot cannot take slot 0's device: slot 0 would have nothing left.
    expect(assignDevice(controls, 2, "keyboard", 4)).toEqual(controls);
    // Out of range slots are ignored.
    expect(assignDevice(controls, 2, "pad2", 2)).toEqual(controls);
  });

  test("a device parked on a slot the mode does not have moves instead of swapping", () => {
    expect(assignDevice({ 0: "keyboard", 3: "pad2" }, 1, "pad2", 2)).toEqual({
      0: "keyboard",
      1: "pad2",
    });
  });

  test("a CPU slot goes back to a CPU", () => {
    expect(assignDevice({ 0: "keyboard", 1: "pad1" }, 1, null, 2)).toEqual({ 0: "keyboard" });
  });

  test("joining takes the first CPU slot of the mode", () => {
    expect(joinPad({ 0: "keyboard" }, 0, 2)).toEqual({
      controls: { 0: "keyboard", 1: "pad1" },
      slot: 1,
    });
    expect(joinPad({ 0: "keyboard", 1: "pad1" }, 1, 4)).toEqual({
      controls: { 0: "keyboard", 1: "pad1", 2: "pad2" },
      slot: 2,
    });
    expect(joinPad({ 0: "keyboard", 1: "pad1", 2: "pad3" }, 1, 4)?.slot).toBe(3);
    // Already in, or no CPU left.
    expect(joinPad({ 0: "keyboard", 1: "pad1" }, 0, 2)).toBeNull();
    expect(joinPad({ 0: "keyboard", 1: "pad1" }, 1, 2)).toBeNull();
    expect(joinPad({ 0: "pad1", 1: "keyboard" }, 0, 2)).toBeNull();
  });

  test("a pad parked in a rumble slot joins a duel from there", () => {
    expect(joinPad({ 0: "keyboard", 3: "pad2" }, 1, 2)).toEqual({
      controls: { 0: "keyboard", 1: "pad2" },
      slot: 1,
    });
  });

  test("leaving frees the slot for a CPU, except slot 0", () => {
    expect(leavePad({ 0: "keyboard", 1: "pad1", 2: "pad2" }, 1, 4)).toEqual({
      controls: { 0: "keyboard", 1: "pad1" },
      slot: 2,
    });
    expect(leavePad({ 0: "pad1", 1: "keyboard" }, 0, 2)).toBeNull();
    expect(leavePad({ 0: "keyboard" }, 2, 4)).toBeNull();
    // Only slots of the mode count.
    expect(leavePad({ 0: "keyboard", 3: "pad1" }, 0, 2)).toBeNull();
  });

  test("pads that are not connected play as CPUs for the match", () => {
    const options = {
      ...DEFAULT_MATCH_OPTIONS,
      controls: { 0: "keyboard", 1: "pad1", 2: "pad2", 3: "pad3" },
    } as const;
    const result = playableOptions(options, 4, (pad) => pad === 1);
    expect(result.options.controls).toEqual({ 0: "keyboard", 2: "pad2" });
    expect(result.substitutes).toEqual([
      { slot: 1, device: "pad1", by: null },
      { slot: 3, device: "pad3", by: null },
    ]);
    // Slots the mode does not have are dropped.
    expect(playableOptions(options, 2, () => true).options.controls).toEqual({
      0: "keyboard",
      1: "pad1",
    });
  });

  test("slot 0 without its pad falls back to the keyboard", () => {
    const options = { ...DEFAULT_MATCH_OPTIONS, controls: { 0: "pad1", 1: "keyboard" } } as const;
    const result = playableOptions(options, 2, () => false);
    expect(result.options.controls).toEqual({ 0: "keyboard" });
    expect(result.substitutes).toEqual([
      { slot: 0, device: "pad1", by: "keyboard" },
      { slot: 1, device: "keyboard", by: null },
    ]);
    const alone = playableOptions(
      { ...DEFAULT_MATCH_OPTIONS, controls: { 0: "pad2" } },
      2,
      () => false,
    );
    expect(alone.options.controls).toEqual({ 0: "keyboard" });
  });

  test("the store assigns, joins and leaves, and saves each change", () => {
    const storage = memoryStorage();
    const store = createMatchStore(storage);
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.join(0, 2)).toBe(1);
    expect(store.join(1, 4)).toBe(2);
    expect(store.get().controls).toEqual({ 0: "keyboard", 1: "pad1", 2: "pad2" });
    store.assign(0, "pad2", 4);
    expect(store.get().controls).toEqual({ 0: "pad2", 1: "pad1", 2: "keyboard" });
    expect(store.leave(0, 4)).toBe(1);
    expect(store.leave(1, 4)).toBeNull();
    expect(JSON.parse(storage.data.get(MATCH_STORAGE_KEY)!).controls).toEqual({
      0: "pad2",
      2: "keyboard",
    });
    expect(createMatchStore(storage).get().controls).toEqual({ 0: "pad2", 2: "keyboard" });
    expect(listener).toHaveBeenCalledTimes(4);
    // No-ops do not notify.
    store.assign(0, null, 4);
    expect(store.join(0, 1)).toBeNull();
    expect(listener).toHaveBeenCalledTimes(4);
  });

  test("a stored device list with duplicates or junk is cleaned on load", () => {
    const stored = JSON.stringify({
      controls: { 0: "pad1", 1: "pad1", 2: "mouse", 3: "keyboard" },
    });
    expect(loadMatchOptions(memoryStorage(stored)).controls).toEqual({ 0: "pad1", 3: "keyboard" });
  });
});
