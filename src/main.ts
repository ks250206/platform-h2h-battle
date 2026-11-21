import "./styles.css";
import "./touch.css";
import { BattleEngine } from "./game/engine";
import { BattleInput } from "./game/input";
import { BattleAudio } from "./game/audio";
import { createSettingsStore, defaultSettings, detectTouch } from "./game/settings";
import { createMatchStore, playableOptions } from "./game/matchStore";
import type { MatchOptions } from "./game/match";
import { PadHub } from "./game/pads";
import { ArenaRenderer, hasSoftwareRenderer } from "./render/renderer";
import { GameUI } from "./ui/GameUI";
import { PadMenu } from "./ui/padMenu";
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
// The title menu's remembered choices, and the ones the current match was started with (a pad
// that is not connected leaves its slot to a CPU; a restart checks again).
const match = createMatchStore();
let matchOptions: MatchOptions = match.get();
// The title shows the stage that is picked there: at once, and again on every return to it.
engine.menu({ stage: matchOptions.stage });
match.subscribe((next, previous) => {
  if (next.stage !== previous.stage && engine.state.phase === "menu")
    engine.menu({ stage: next.stage });
});
const pads = new PadHub();
/** Starts (or restarts) a match with what can play right now. */
const startMatch = (mode: MatchMode, options: MatchOptions) => {
  selectedMode = mode;
  matchOptions = options;
  const count = mode === "rumble" ? 4 : 2;
  const playable = playableOptions(options, count, (pad) => pads.isConnected(pad));
  input?.reset();
  input?.newMatch();
  lostPad = null;
  ui.setPadNotice(null);
  engine.start(mode, playable.options);
};
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
/** The pad (1-based) whose loss paused the match, until it is back or the match goes on. */
let lostPad: number | null = null;

const pause = () => {
  if (document.querySelector("dialog[open]")) return;
  if (engine.state.phase === "paused") resume();
  else engine.pause();
};
const resume = () => {
  lostPad = null;
  ui.setPadNotice(null);
  engine.resume();
};
/** A pad of the running match went away: pause and say which one. */
const padLost = (padNumber: number) => {
  lostPad = padNumber;
  engine.pause();
  ui.setPadNotice(`パッド${padNumber} の接続が切れました。つなぎ直してから再開してください。`);
};
/** V / the top-bar camera button / the settings dialog all write the same stored setting. */
const toggleCameraFollow = () => {
  if (document.querySelector("dialog[open]")) return;
  settings.set({ cameraFollow: !settings.get().cameraFollow });
};
const ui = new GameUI(overlay, {
  onStart: (mode, options) => {
    sound.unlock();
    startMatch(mode, options);
    ui.update(engine.state);
  },
  onPause: () => engine.pause(),
  onResume: resume,
  onRestart: () => {
    sound.unlock();
    startMatch(selectedMode, matchOptions);
    ui.update(engine.state);
  },
  onMenu: () => {
    input?.reset();
    engine.menu({ stage: match.get().stage });
  },
  onSound: (enabled) => {
    sound.unlock();
    sound.setEnabled(enabled);
  },
  match,
  graphics: {
    store: settings,
    renderSize: () => renderer?.renderSize ?? null,
    supportedMsaa: (ambientOcclusion) => renderer?.supportedMsaa(ambientOcclusion) ?? null,
    supportsAmbientOcclusion: () => renderer?.supportsAmbientOcclusion ?? null,
  },
});
ui.update(engine.state);
pads.subscribe((connected) => {
  ui.setPads(connected);
  // The pad that went away during the match is back (another pad connecting changes nothing).
  if (lostPad !== null && connected.includes(lostPad - 1)) {
    lostPad = null;
    ui.setPadNotice(null);
  }
});
const padMenu = new PadMenu(overlay, pads, {
  phase: () => engine.state.phase,
  titleButton: (index, button) => ui.padTitleButton(index, button),
});

async function boot() {
  try {
    renderer = await ArenaRenderer.create(host, settings.get(), software);
    input = new BattleInput(renderer.canvas, pads, {
      toWorld: (x, y) => renderer!.screenToWorld(x, y),
      onPause: pause,
      onGesture: () => sound.unlock(),
      onCameraToggle: toggleCameraFollow,
      onPadLost: padLost,
      rumble: () => settings.get().padRumble,
    });
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
      // Pads are read once a frame: the menus first (a press there may start or resume the
      // match), then the match input, which treats buttons still held as already pressed.
      pads.poll();
      padMenu.update(now / 1000);
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
        ui.setLock(input.playerLocks);
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
              startMatch(mode, match.get());
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
    padMenu.destroy();
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
