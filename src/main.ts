import "./styles.css";
import "./touch.css";
import { BattleEngine } from "./game/engine";
import { BattleInput } from "./game/input";
import { BattleAudio } from "./game/audio";
import { createSettingsStore, defaultSettings, detectTouch } from "./game/settings";
import { ArenaRenderer, hasSoftwareRenderer } from "./render/renderer";
import { GameUI } from "./ui/GameUI";
import { emptyInput } from "./game/types";
import type { GameState, MatchMode, PlayerInput } from "./game/types";

const root = document.getElementById("app")!;
root.innerHTML =
  '<div id="arena"></div><div id="interface"></div><div class="loading-screen"><span class="loading-paw">✦</span><strong>BRAMBLE</strong><p>浮島を準備しています…</p></div>';
const host = document.getElementById("arena")!;
const overlay = document.getElementById("interface")!;
const engine = new BattleEngine();
const sound = new BattleAudio();
let input: BattleInput | null = null;
let renderer: ArenaRenderer | null = null;
let selectedMode: MatchMode = "duel";
let animation = 0;
let stopped = false;
let lastTime = performance.now();
let lastUI = 0;
// The FPS cap's next due time and the smoothed frame rate for the optional counter.
let nextFrameDue = 0;
let fps = 0;

// The device profile picks the defaults; saved choices override them field by field.
const software = hasSoftwareRenderer();
const settings = createSettingsStore(defaultSettings({ software, touch: detectTouch() }));
settings.subscribe((next) => {
  renderer?.applySettings(next);
  nextFrameDue = 0;
});
/** Development only: freezes the real-time loop so tooling can advance frames by hand. */
let manualStepping = false;

const pause = () => {
  if (document.querySelector("dialog[open]")) return;
  if (engine.state.phase === "paused") engine.resume();
  else engine.pause();
};
const ui = new GameUI(overlay, {
  onStart: (mode) => {
    selectedMode = mode;
    sound.unlock();
    input?.reset();
    engine.start(mode);
    ui.update(engine.state);
  },
  onPause: () => engine.pause(),
  onResume: () => engine.resume(),
  onRestart: () => {
    sound.unlock();
    input?.reset();
    engine.start(selectedMode);
    ui.update(engine.state);
  },
  onMenu: () => {
    input?.reset();
    engine.menu();
  },
  onSound: (enabled) => {
    sound.unlock();
    sound.setEnabled(enabled);
  },
  graphics: {
    store: settings,
    renderSize: () => renderer?.renderSize ?? null,
    supportedMsaa: (ambientOcclusion) => renderer?.supportedMsaa(ambientOcclusion) ?? null,
    supportsAmbientOcclusion: () => renderer?.supportsAmbientOcclusion ?? null,
  },
});
ui.update(engine.state);

async function boot() {
  try {
    renderer = await ArenaRenderer.create(host, settings.get(), software);
    input = new BattleInput(
      renderer.canvas,
      (x, y) => renderer!.screenToWorld(x, y),
      pause,
      () => sound.unlock(),
    );
    root.querySelector(".loading-screen")?.remove();
    lastTime = performance.now();
    const frame = (now: number) => {
      if (stopped || !renderer || !input) return;
      animation = requestAnimationFrame(frame);
      const limit = settings.get().fpsLimit;
      if (limit > 0) {
        // Skip display frames until the cap's budget has elapsed. The due time advances in whole
        // intervals so a 60 FPS cap on a 144 Hz screen averages 60, not the nearest divisor.
        const interval = 1000 / limit;
        if (now < nextFrameDue - 1) return;
        nextFrameDue = now - nextFrameDue > interval ? now + interval : nextFrameDue + interval;
      }
      // The simulation receives the real time since the last rendered frame.
      const elapsed = now - lastTime;
      const dt = Math.min(0.1, elapsed / 1000);
      lastTime = now;
      if (elapsed > 0 && elapsed < 1000)
        fps = fps ? fps + (1000 / elapsed - fps) * Math.min(1, elapsed / 500) : 1000 / elapsed;
      input.updateVisibility(engine.state);
      const control = input.sample(engine.state);
      if (!manualStepping) {
        engine.update(dt, control);
        renderer.render(engine.state, dt);
      }
      sound.update(engine.state);
      if (now - lastUI > 33) {
        ui.update(engine.state);
        ui.setFps(fps);
        lastUI = now;
      }
    };
    animation = requestAnimationFrame(frame);
    // Readable snapshots for automation; mutating helpers are available in development only.
    const inspect = {
      snapshot: (): GameState => structuredClone(engine.state),
      screen: (x: number, y: number, z: number) => renderer?.projectWorld(x, y, z),
    };
    Object.defineProperty(window, "__BRAMBLE__", {
      configurable: true,
      value: import.meta.env.DEV
        ? {
            ...inspect,
            start: (mode: MatchMode) => {
              selectedMode = mode;
              engine.start(mode);
              engine.state.phase = "playing";
            },
            engine,
            renderer,
            manual: (on: boolean) => {
              manualStepping = on;
            },
            step: (dt: number, control: Partial<PlayerInput> = {}) => {
              engine.update(dt, { ...emptyInput(), ...control });
              renderer!.render(engine.state, dt);
            },
          }
        : inspect,
    });
  } catch (error) {
    console.error(error);
    root.querySelector(".loading-screen")?.remove();
    overlay.innerHTML =
      '<section class="boot-error"><h1>3D描画を開始できませんでした</h1><p>WebGL 2に対応したブラウザーで、ハードウェアアクセラレーションを有効にして再読み込みしてください。</p><p class="error-detail"></p><button type="button">再読み込み</button></section>';
    overlay.querySelector(".error-detail")!.textContent =
      error instanceof Error ? error.message : String(error);
    overlay.querySelector("button")!.addEventListener("click", () => location.reload());
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    engine.pause();
    input?.reset();
  }
  lastTime = performance.now();
});
window.addEventListener("blur", () => {
  engine.pause();
  input?.reset();
});
window.addEventListener(
  "pagehide",
  () => {
    stopped = true;
    cancelAnimationFrame(animation);
    input?.destroy();
    ui.destroy();
    sound.destroy();
    renderer?.destroy();
  },
  { once: true },
);
window.addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});
void boot();

declare global {
  interface Window {
    __BRAMBLE__?: {
      snapshot: () => GameState;
      screen: (x: number, y: number, z: number) => { x: number; y: number } | null | undefined;
      start?: (mode: MatchMode) => void;
      engine?: BattleEngine;
      renderer?: ArenaRenderer | null;
      manual?: (on: boolean) => void;
      step?: (dt: number, control?: Partial<PlayerInput>) => void;
    };
  }
}
