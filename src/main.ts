import "./styles.css";
import "./touch.css";
import { BattleEngine } from "./game/engine";
import { BattleInput } from "./game/input";
import { BattleAudio } from "./game/audio";
import { ArenaRenderer } from "./render/renderer";
import { GameUI } from "./ui/GameUI";
import type { GameState, MatchMode } from "./game/types";

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
});
ui.update(engine.state);

async function boot() {
  try {
    renderer = await ArenaRenderer.create(host);
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
      const dt = Math.min(0.1, (now - lastTime) / 1000);
      lastTime = now;
      input.updateVisibility(engine.state);
      const control = input.sample(engine.state);
      engine.update(dt, control);
      renderer.render(engine.state, dt);
      sound.update(engine.state);
      if (now - lastUI > 33) {
        ui.update(engine.state);
        lastUI = now;
      }
      animation = requestAnimationFrame(frame);
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
    };
  }
}
