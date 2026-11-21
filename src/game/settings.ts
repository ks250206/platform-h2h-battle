// Graphics settings: a plain model plus a tiny store. Importable in node (tests): nothing touches
// `window` or `localStorage` at import time, and every access to them is guarded.

export type ResolutionPreset = "native" | "2160" | "1440" | "1080" | "900" | "720" | "540";
export type ShadowLevel = "off" | "low" | "medium" | "high";
export type Antialiasing = "off" | "msaa" | "fxaa" | "ssaa";

export const MSAA_SAMPLES = [2, 4, 8] as const;
export type MsaaSamples = (typeof MSAA_SAMPLES)[number];
export const FPS_LIMITS = [0, 30, 60, 90, 120, 144, 165, 240] as const;
export type FpsLimit = (typeof FPS_LIMITS)[number];
export const ANTIALIASING_MODES = ["off", "msaa", "fxaa", "ssaa"] as const;
export const SHADOW_LEVELS = ["off", "low", "medium", "high"] as const;

export interface GraphicsSettings {
  /** 3D の描画解像度 (画面の短い辺のピクセル数。もう一方は縦横比に合わせる) */
  resolution: ResolutionPreset;
  /** 描画が重いときに 3D の解像度を自動で下げる */
  dynamicResolution: boolean;
  antialiasing: Antialiasing;
  msaaSamples: MsaaSamples;
  /** 0 = 制限なし */
  fpsLimit: FpsLimit;
  shadows: ShadowLevel;
  /** 環境光の遮蔽 (SSAO) */
  ambientOcclusion: boolean;
  showFps: boolean;
  /** 被弾時の画面の揺れ */
  cameraShake: boolean;
  /** 視点の自動追随: 戦っている場所へカメラが寄る。オフで足場全体を固定で映す */
  cameraFollow: boolean;
  /** パッドの振動: 被弾・ヒット・相殺でパッドが震える */
  padRumble: boolean;
}

export const RESOLUTION_OPTIONS: readonly { value: ResolutionPreset; label: string }[] = [
  { value: "native", label: "ネイティブ (画面に合わせる)" },
  { value: "2160", label: "3840 × 2160 (4K)" },
  { value: "1440", label: "2560 × 1440 (WQHD)" },
  { value: "1080", label: "1920 × 1080 (フル HD)" },
  { value: "900", label: "1600 × 900" },
  { value: "720", label: "1280 × 720 (HD)" },
  { value: "540", label: "960 × 540" },
];

export interface DeviceProfile {
  /** WebGL が SwiftShader などのソフトウェア描画 */
  software: boolean;
  /** 指で操作する端末 (pointer: coarse) */
  touch: boolean;
}

/** GPU とマウスのある端末は高画質、ソフトウェア描画やタッチ端末は軽量な設定で始める。 */
export function defaultSettings({ software, touch }: DeviceProfile): GraphicsSettings {
  const light = software || touch;
  return {
    resolution: light ? "540" : "native",
    dynamicResolution: true,
    antialiasing: light ? "off" : "msaa",
    msaaSamples: 4,
    fpsLimit: 0,
    shadows: light ? "off" : "medium",
    ambientOcclusion: false,
    showFps: false,
    cameraShake: true,
    cameraFollow: true,
    padRumble: true,
  };
}

export const STORAGE_KEY = "bramble.settings.v1";

const pick = <T>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;
const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

/** Keeps every valid field of `raw` and replaces each missing, corrupt or out-of-range one. */
export function sanitizeSettings(raw: unknown, defaults: GraphicsSettings): GraphicsSettings {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    resolution: pick(
      source.resolution,
      RESOLUTION_OPTIONS.map((o) => o.value),
      defaults.resolution,
    ),
    dynamicResolution: bool(source.dynamicResolution, defaults.dynamicResolution),
    antialiasing: pick(source.antialiasing, ANTIALIASING_MODES, defaults.antialiasing),
    msaaSamples: pick(source.msaaSamples, MSAA_SAMPLES, defaults.msaaSamples),
    fpsLimit: pick(source.fpsLimit, FPS_LIMITS, defaults.fpsLimit),
    shadows: pick(source.shadows, SHADOW_LEVELS, defaults.shadows),
    ambientOcclusion: bool(source.ambientOcclusion, defaults.ambientOcclusion),
    showFps: bool(source.showFps, defaults.showFps),
    cameraShake: bool(source.cameraShake, defaults.cameraShake),
    cameraFollow: bool(source.cameraFollow, defaults.cameraFollow),
    padRumble: bool(source.padRumble, defaults.padRumble),
  };
}

/** The subset of the Storage API the store needs; `localStorage` in the browser. */
export type SettingsStorage = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): SettingsStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // Some browsers throw on access when site data is blocked.
    return null;
  }
}

export function loadSettings(
  defaults: GraphicsSettings,
  storage: SettingsStorage | null = browserStorage(),
): GraphicsSettings {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return { ...defaults };
    return sanitizeSettings(JSON.parse(raw), defaults);
  } catch {
    return { ...defaults };
  }
}

export function saveSettings(
  settings: GraphicsSettings,
  storage: SettingsStorage | null = browserStorage(),
): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private browsing or a full quota: the settings still apply for this session.
  }
}

export interface SettingsStore {
  get(): GraphicsSettings;
  set(patch: Partial<GraphicsSettings>): void;
  reset(): void;
  /** Called after every change with the new and the previous settings. Returns an unsubscribe. */
  subscribe(listener: (settings: GraphicsSettings, previous: GraphicsSettings) => void): () => void;
  readonly defaults: GraphicsSettings;
}

export function createSettingsStore(
  defaults: GraphicsSettings,
  storage: SettingsStorage | null = browserStorage(),
): SettingsStore {
  let current = loadSettings(defaults, storage);
  const listeners = new Set<(settings: GraphicsSettings, previous: GraphicsSettings) => void>();
  const replace = (next: GraphicsSettings) => {
    const previous = current;
    current = next;
    saveSettings(current, storage);
    for (const listener of listeners) listener(current, previous);
  };
  return {
    defaults,
    get: () => current,
    set: (patch) => replace(sanitizeSettings({ ...current, ...patch }, current)),
    reset: () => replace({ ...defaults }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Rendered pixels per CSS pixel for a preset. `cssShortSide` is the shorter side of the view, so a
 * preset means the same on a landscape monitor (1920 × 1080) and a portrait phone (1080 × 1920).
 */
export function resolutionScale(
  preset: ResolutionPreset,
  cssShortSide: number,
  devicePixelRatio: number,
): number {
  if (preset === "native") return Math.min(Math.max(devicePixelRatio || 1, 0.25), 2);
  const scale = Number(preset) / Math.max(1, cssShortSide);
  return Math.min(4, Math.max(0.25, scale));
}

/** The highest supported sample count not above the request, else the lowest supported one. */
export function effectiveSamples(
  requested: MsaaSamples,
  supported: readonly MsaaSamples[],
): MsaaSamples | undefined {
  let best: MsaaSamples | undefined;
  for (const samples of supported) if (samples <= requested) best = samples;
  return best ?? supported[0];
}

/** Device profile of the current browser; `software` comes from the renderer's probe. */
export function detectTouch(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}
