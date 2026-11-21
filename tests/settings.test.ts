import { describe, expect, test } from "vite-plus/test";
import {
  createSettingsStore,
  defaultSettings,
  effectiveSamples,
  loadSettings,
  resolutionScale,
  saveSettings,
  STORAGE_KEY,
  type GraphicsSettings,
  type SettingsStorage,
} from "../src/game/settings";

function memoryStorage(initial?: string): SettingsStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(STORAGE_KEY, initial);
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

const hardware = defaultSettings({ software: false, touch: false });

describe("device profile defaults", () => {
  test("a hardware GPU with a fine pointer gets the full profile", () => {
    expect(hardware).toEqual({
      resolution: "native",
      dynamicResolution: true,
      antialiasing: "msaa",
      msaaSamples: 4,
      fpsLimit: 0,
      shadows: "medium",
      ambientOcclusion: false,
      showFps: false,
      cameraShake: true,
    });
  });

  test("software rendering and touch devices get the light profile", () => {
    for (const profile of [
      { software: true, touch: false },
      { software: false, touch: true },
      { software: true, touch: true },
    ]) {
      const light = defaultSettings(profile);
      expect(light.resolution).toBe("540");
      expect(light.antialiasing).toBe("off");
      expect(light.shadows).toBe("off");
      expect(light.ambientOcclusion).toBe(false);
      expect(light.dynamicResolution).toBe(true);
      expect(light.cameraShake).toBe(true);
    }
  });

  test("defaults are fresh objects", () => {
    const a = defaultSettings({ software: false, touch: false });
    a.shadows = "high";
    expect(defaultSettings({ software: false, touch: false }).shadows).toBe("medium");
  });
});

describe("loading and saving", () => {
  test("missing storage, empty and corrupt JSON fall back to the defaults", () => {
    expect(loadSettings(hardware, null)).toEqual(hardware);
    expect(loadSettings(hardware, memoryStorage())).toEqual(hardware);
    expect(loadSettings(hardware, memoryStorage("{not json"))).toEqual(hardware);
    expect(loadSettings(hardware, memoryStorage("null"))).toEqual(hardware);
    expect(loadSettings(hardware, memoryStorage('"msaa"'))).toEqual(hardware);
    expect(loadSettings(hardware, memoryStorage("[1,2,3]"))).toEqual(hardware);
  });

  test("each bad field falls back on its own and valid fields are kept", () => {
    const stored = JSON.stringify({
      resolution: "4320",
      dynamicResolution: "yes",
      antialiasing: "ssaa",
      msaaSamples: 16,
      fpsLimit: 75,
      shadows: "ultra",
      ambientOcclusion: true,
      showFps: 1,
      cameraShake: false,
      unknown: "ignored",
    });
    expect(loadSettings(hardware, memoryStorage(stored))).toEqual({
      ...hardware,
      antialiasing: "ssaa",
      ambientOcclusion: true,
      cameraShake: false,
    });
  });

  test("numbers stored as strings are not accepted", () => {
    const stored = JSON.stringify({ msaaSamples: "8", fpsLimit: "60", resolution: 1080 });
    expect(loadSettings(hardware, memoryStorage(stored))).toEqual(hardware);
  });

  test("a saved choice loads back unchanged", () => {
    const storage = memoryStorage();
    const choice: GraphicsSettings = {
      ...hardware,
      resolution: "1440",
      antialiasing: "msaa",
      msaaSamples: 8,
      fpsLimit: 144,
      shadows: "high",
    };
    saveSettings(choice, storage);
    expect(JSON.parse(storage.data.get(STORAGE_KEY)!)).toEqual(choice);
    expect(loadSettings(hardware, storage)).toEqual(choice);
  });

  test("a storage that throws never breaks loading or saving", () => {
    const broken: SettingsStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(loadSettings(hardware, broken)).toEqual(hardware);
    expect(() => saveSettings(hardware, broken)).not.toThrow();
  });
});

describe("resolutionScale", () => {
  test("native follows the device pixel ratio, capped at 2", () => {
    expect(resolutionScale("native", 900, 1)).toBe(1);
    expect(resolutionScale("native", 900, 1.5)).toBe(1.5);
    expect(resolutionScale("native", 900, 3)).toBe(2);
    expect(resolutionScale("native", 900, 0)).toBe(1);
  });

  test("presets divide the target pixels by the short side", () => {
    expect(resolutionScale("1080", 1080, 1)).toBe(1);
    expect(resolutionScale("540", 1080, 2)).toBe(0.5);
    expect(resolutionScale("2160", 1080, 1)).toBe(2);
    expect(resolutionScale("720", 900, 1)).toBeCloseTo(0.8);
  });

  test("the scale stays within 0.25 and 4", () => {
    expect(resolutionScale("2160", 300, 1)).toBe(4);
    expect(resolutionScale("540", 4000, 1)).toBe(0.25);
    expect(resolutionScale("540", 0, 1)).toBe(4);
  });
});

describe("effectiveSamples", () => {
  test("picks the highest supported count not above the request", () => {
    expect(effectiveSamples(8, [2, 4, 8])).toBe(8);
    expect(effectiveSamples(8, [2, 4])).toBe(4);
    expect(effectiveSamples(4, [2, 4, 8])).toBe(4);
    expect(effectiveSamples(2, [4, 8])).toBe(4);
  });

  test("is undefined when MSAA is unsupported", () => {
    expect(effectiveSamples(4, [])).toBeUndefined();
  });
});

describe("settings store", () => {
  test("starts from storage, applies patches, persists and notifies", () => {
    const storage = memoryStorage(JSON.stringify({ shadows: "low" }));
    const store = createSettingsStore(hardware, storage);
    expect(store.get().shadows).toBe("low");
    const seen: [GraphicsSettings, GraphicsSettings][] = [];
    const unsubscribe = store.subscribe((next, previous) => seen.push([next, previous]));
    store.set({ antialiasing: "fxaa", showFps: true });
    expect(store.get()).toEqual({
      ...hardware,
      shadows: "low",
      antialiasing: "fxaa",
      showFps: true,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]![1].antialiasing).toBe("msaa");
    expect(JSON.parse(storage.data.get(STORAGE_KEY)!).antialiasing).toBe("fxaa");
    unsubscribe();
    store.set({ showFps: false });
    expect(seen).toHaveLength(1);
  });

  test("rejects invalid patch values field by field", () => {
    const store = createSettingsStore(hardware, memoryStorage());
    store.set({ shadows: "high" });
    store.set({ shadows: "ultra", fpsLimit: 60 } as unknown as Partial<GraphicsSettings>);
    expect(store.get().shadows).toBe("high");
    expect(store.get().fpsLimit).toBe(60);
  });

  test("reset restores the profile defaults and persists them", () => {
    const storage = memoryStorage();
    const store = createSettingsStore(hardware, storage);
    store.set({ resolution: "720", shadows: "off", cameraShake: false });
    let calls = 0;
    store.subscribe(() => calls++);
    store.reset();
    expect(store.get()).toEqual(hardware);
    expect(calls).toBe(1);
    expect(JSON.parse(storage.data.get(STORAGE_KEY)!)).toEqual(hardware);
  });
});
