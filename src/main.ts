import "./styles.css";
import "./touch.css";
import { BattleEngine } from "./game/engine";
import { BattleInput } from "./game/input";
import { BattleAudio } from "./game/audio";
import { createSettingsStore, defaultSettings, detectTouch } from "./game/settings";
import { createMatchStore, playableOptions } from "./game/matchStore";
import { humanSlots, padIndex, type MatchOptions } from "./game/match";
import { LadderSession } from "./game/ladder";
import { PadHub } from "./game/pads";
import { ArenaRenderer, hasSoftwareRenderer } from "./render/renderer";
import { TrainingUI } from "./ui/trainingUi";
import { GameUI } from "./ui/GameUI";
import { TutorialBattle } from "./game/tutorial";
import { TutorialUi } from "./ui/tutorialUi";
import { PadMenu } from "./ui/padMenu";
import { emptyInput } from "./game/types";
import type { GameState, MatchMode, PlayerInput } from "./game/types";

const root = document.getElementById("app")!;
root.innerHTML =
  '<div id="arena"></div><div id="interface"></div><div class="loading-screen"><span class="loading-paw">✦</span><strong>BRAMBLE</strong><p>浮島を準備しています…</p></div>';
const host = document.getElementById("arena")!;
const overlay = document.getElementById("interface")!;
const matchEngine = new BattleEngine();
let engine = matchEngine;
const sound = new BattleAudio();
let input: BattleInput | null = null;
let renderer: ArenaRenderer | null = null;
let selectedMode: MatchMode = "duel";
// The title menu's remembered choices, and the ones the current match was started with (a pad
// that is not connected leaves its slot to a CPU; a restart checks again).
const match = createMatchStore();
let matchOptions: MatchOptions = match.get();
const pads = new PadHub();
const connected = (index: number) => pads.isConnected(index);
let ladder: LadderSession | null = null;
let ladderAttempt: symbol | null = null;
/** Starts (or restarts) a match with what can play right now. */
const startMatch = (mode: MatchMode, options: MatchOptions) => {
  leaveTutorial();
  selectedMode = mode;
  matchOptions = options;
  const count = mode === "rumble" ? 4 : 2;
  const playable = playableOptions(options, count, connected);
  engine.start(mode, playable.options);
  prepareGame();
};
/** The mode the title menu shows, for the line-up of fighters behind it. */
let titleMode: MatchMode = "duel";
let titleOptions = match.get();
/**
 * The title screen: the fighters of the selected mode in the looks the menu shows, with a CPU on
 * every slot whose pad is away, exactly as a match would start.
 */
const showTitle = () => {
  const count = titleMode === "rumble" ? 4 : 2;
  const playable = playableOptions(titleOptions, count, connected);
  engine.menu(titleMode, playable.options);
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

/** A set keeps its starting line-up, including during a disconnect between games. */
const missingRequiredPad = (): number | null => {
  if (!engine.state.set && !(engine instanceof TutorialBattle)) return null;
  for (const { device } of humanSlots(engine.state.options, 2)) {
    const pad = padIndex(device);
    if (pad !== null && !pads.isConnected(pad)) return pad + 1;
  }
  return null;
};
const prepareGame = () => {
  input?.reset();
  input?.newMatch(engine instanceof TutorialBattle);
  lostPad = null;
  ui.setPadNotice(null);
  const missing = missingRequiredPad();
  if (missing !== null) padLost(missing);
  updateUI();
};
const pause = () => {
  if (document.querySelector("dialog[open]")) return;
  if (engine.state.phase === "paused") resume();
  else engine.pause();
};
const resume = () => {
  const missing = missingRequiredPad();
  if (missing !== null) {
    padLost(missing);
    return;
  }
  if (ladder && lostPad !== null) {
    // Keep the current duel intact. A later attempt resolves the preferred pad again.
    engine.state.options.controls = playableOptions(matchOptions, 2, connected).options.controls;
  }
  lostPad = null;
  ui.setPadNotice(null);
  if (engine instanceof TutorialBattle) {
    input?.reset();
    input?.newMatch(true);
  }
  engine.resume();
};
/** A pad of the running match went away: pause and say which one. */
const padLost = (padNumber: number) => {
  lostPad = padNumber;
  engine.pause();
  const hint =
    ladder || engine instanceof TutorialBattle
      ? "つなぎ直すか、キーボード・マウス（タッチ）で再開できます。"
      : "つなぎ直してから再開してください。";
  ui.setPadNotice(
    `パッド${padNumber} の接続が切れました。${hint}`,
    engine.state.set !== null || engine instanceof TutorialBattle,
  );
};
/** V / the top-bar camera button / the settings dialog all write the same stored setting. */
const toggleCameraFollow = () => {
  if (document.querySelector("dialog[open]")) return;
  settings.set({ cameraFollow: !settings.get().cameraFollow });
};
const updateUI = () => {
  const state = engine.state;
  if (ladder && ladderAttempt !== null && state.phase === "ended") {
    ladder.finish(ladderAttempt, state.winnerId, state.elapsed);
    ladderAttempt = null;
  }
  ui.update(state, ladder?.progress);
  trainingUI.update();
  tutorialUi.update();
};
const playLadderAttempt = () => {
  const attempt = ladder?.startAttempt();
  if (!attempt) return;
  sound.unlock();
  ladderAttempt = attempt.id;
  startMatch("duel", attempt.options);
};
const leaveLadder = () => {
  ladder?.exit();
  ladder = null;
  ladderAttempt = null;
};
function returnToTitle() {
  leaveTutorial();
  leaveLadder();
  input?.reset();
  lostPad = null;
  ui.setPadNotice(null);
  renderer?.setSpotlight(null);
  showTitle();
  updateUI();
}
const ui = new GameUI(overlay, {
  onStart: (mode, options) => {
    leaveLadder();
    sound.unlock();
    startMatch(mode, options);
  },
  onStartLadder: (options) => {
    if (engine.state.phase !== "menu") return;
    ladder = new LadderSession(options);
    playLadderAttempt();
  },
  onLadderContinue: () => {
    if (!ladder || engine.state.phase !== "ended") return;
    if (ladder.progress.phase === "clear") ladder = new LadderSession(match.get());
    playLadderAttempt();
  },
  onPause: () => engine.pause(),
  onResume: resume,
  onRestart: () => {
    if (engine instanceof TutorialBattle) return tutorialUi.retry();
    if (ladder) return;
    sound.unlock();
    if (engine.training) {
      engine.resetTraining();
      prepareGame();
    } else if (engine.state.set) {
      engine.start(engine.state.mode);
      prepareGame();
    } else startMatch(selectedMode, matchOptions);
  },
  onNextGame: () => {
    if (!engine.nextSetGame()) return;
    sound.unlock();
    prepareGame();
  },
  onMenu: returnToTitle,
  onPreview: (mode, options) => {
    titleMode = mode;
    titleOptions = options;
    if (engine.state.phase === "menu") showTitle();
  },
  onSpotlight: (slot) => renderer?.setSpotlight(slot),
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
const trainingUI = new TrainingUI(overlay, engine, () => input?.reset(), updateUI);
const leaveTutorial = () => {
  tutorialUi.leave();
  if (engine instanceof TutorialBattle) input?.newMatch();
  engine = matchEngine;
};
const tutorialUi = new TutorialUi(
  overlay,
  {
    resume,
    play: (battle) => {
      leaveLadder();
      engine = battle;
      sound.unlock();
      prepareGame();
    },
    deviceChanged: (device) => {
      if (!(engine instanceof TutorialBattle)) return;
      engine.state.options.controls = { 0: device };
      input?.reset();
      input?.updateVisibility(engine.state);
      if (lostPad !== null && missingRequiredPad() === null) {
        lostPad = null;
        ui.setPadNotice(null);
      }
    },
    exit: (mode) => {
      const options = {
        ...match.get(),
        controls: { 0: tutorialUi.device },
        setFormat: "single" as const,
      };
      if (mode) startMatch(mode, options);
      else {
        returnToTitle();
        overlay.querySelector<HTMLButtonElement>(".tutorial-entry")?.focus();
      }
    },
  },
  detectTouch(),
);
updateUI();
pads.subscribe((connected) => {
  ui.setPads(connected);
  // Notice immediately if the set's roster is missing a pad. Results can still be browsed.
  if (engine.state.phase !== "ended") {
    const missing = missingRequiredPad();
    if (missing !== null) {
      padLost(missing);
      return;
    }
  }
  if (lostPad !== null && connected.includes(lostPad - 1)) {
    lostPad = null;
    ui.setPadNotice(null);
  }
});
const padMenu = new PadMenu(overlay, pads, {
  phase: () => engine.state.phase,
  openTraining: () => trainingUI.open(),
  resetTraining: () => trainingUI.quickReset(),
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
      if (engine.state.phase === "menu" || engine instanceof TutorialBattle)
        tutorialUi.observePads(pads.current);
      padMenu.update(now / 1000);
      input.updateVisibility(engine.state);
      const control = input.sample(
        engine.state,
        engine instanceof TutorialBattle && tutorialUi.promptDevice === "touch",
      );
      if (!manualStepping) {
        engine.update(dt, control);
        renderer.render(engine.state, dt, engine.training?.settings.hitboxes);
      }
      sound.update(engine.state);
      if (now - lastUI > 33) {
        updateUI();
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
              leaveLadder();
              startMatch(mode, match.get());
              if (engine.state.phase === "countdown") engine.state.phase = "playing";
            },
            get engine() {
              return engine;
            },
            renderer,
            manual: (on: boolean) => {
              manualStepping = on;
            },
            step: (dt: number, control: Partial<PlayerInput> = {}) => {
              engine.update(dt, { ...emptyInput(), ...control });
              renderer!.render(engine.state, dt, engine.training?.settings.hitboxes);
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
    tutorialUi.destroy();
    padMenu.destroy();
    trainingUI.destroy();
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
