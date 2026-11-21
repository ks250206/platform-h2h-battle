// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { BattleEngine } from "../src/game/engine";
import { BUTTON, type PadSnapshot } from "../src/game/gamepad";
import { PadHub } from "../src/game/pads";
import { emptyInput, type Phase } from "../src/game/types";
import { PadMenu } from "../src/ui/padMenu";
import { TrainingUI } from "../src/ui/trainingUi";

function pad(buttons: number[] = [], axes = [0, 0, 0, 0]): PadSnapshot {
  return {
    axes,
    buttons: Array.from({ length: 16 }, (_, i) => ({
      pressed: buttons.includes(i),
      value: Number(buttons.includes(i)),
    })),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("PadMenu reconnect held-button safety", () => {
  test("reconnecting a pad with Start or A held does not auto-resume pause or confirm results, while title join still works", () => {
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
      new DOMRect(0, 0, 80, 32),
    ] as unknown as DOMRectList);
    document.body.innerHTML = `
      <div id="root">
        <div class="topbar"></div>
        <div class="menu-screen"><button data-action="start">START</button></div>
        <div class="pause-screen"><button data-action="resume">RESUME</button></div>
        <div class="result-screen"><button data-pad-primary>NEXT</button></div>
      </div>`;
    const root = document.getElementById("root")!;
    const resumeClicks = vi.fn();
    const nextClicks = vi.fn();
    root.querySelector('[data-action="resume"]')!.addEventListener("click", resumeClicks);
    root.querySelector("[data-pad-primary]")!.addEventListener("click", nextClicks);

    let phase: Phase = "paused";
    const titleButton = vi.fn(() => true);
    const pads = new PadHub();
    const menu = new PadMenu(root, pads, { phase: () => phase, titleButton });

    // Disconnect while paused, then reconnect with Start + A + stick held.
    pads.current[0] = null;
    menu.update(1);
    pads.current[0] = pad([BUTTON.START, BUTTON.A], [0, 1, 0, 0]);
    menu.update(2);
    expect(resumeClicks).not.toHaveBeenCalled();

    // Releasing then freshly pressing Start resumes normally.
    pads.current[0] = pad();
    menu.update(3);
    pads.current[0] = pad([BUTTON.START]);
    menu.update(4);
    expect(resumeClicks).toHaveBeenCalledTimes(1);

    // Same reconnect safety on the result screen.
    phase = "ended";
    pads.current[0] = null;
    menu.update(5);
    pads.current[0] = pad([BUTTON.START, BUTTON.A]);
    menu.update(6);
    expect(nextClicks).not.toHaveBeenCalled();

    // Title keeps press-to-join when a newly connected pad presses Start.
    phase = "menu";
    pads.current[0] = null;
    menu.update(7);
    pads.current[0] = pad([BUTTON.START]);
    menu.update(8);
    expect(titleButton).toHaveBeenCalledWith(0, "start");
    menu.destroy();
  });
});

describe("TrainingUI pad disconnect safety", () => {
  test("a pad disconnect while training settings are open blocks resume, reset-to-play, record and playback", () => {
    document.body.innerHTML = `
      <div id="root">
        <div class="game-hud"></div>
        <div class="pause-panel"><button type="button" data-action="resume">再開</button></div>
      </div>`;
    const root = document.getElementById("root")!;
    const engine = new BattleEngine(21);
    engine.start("training", { controls: { 0: "pad1" } });
    engine.state.phase = "playing";

    let padConnected = true;
    const onResume = vi.fn(() => engine.resume());
    const trainingUI = new TrainingUI(
      root,
      engine,
      () => {},
      () => {},
      () => padConnected,
      onResume,
    );

    // Open training settings from live play -> pauses engine.
    trainingUI.open();
    expect(engine.state.phase).toBe("paused");
    const dialog = root.querySelector<HTMLDialogElement>("dialog.training-dialog")!;
    expect(dialog.open).toBe(true);

    // Pad disconnects while dialog is open.
    padConnected = false;
    trainingUI.onPadLost();

    // Record and play refuse while disconnected.
    dialog.querySelector<HTMLButtonElement>("[data-record]")!.click();
    expect(dialog.open).toBe(true);
    expect(dialog.querySelector("[data-tape]")!.textContent).toContain("未接続");
    expect(engine.training!.transport).toBe("idle");

    // Resetting from dialog keeps the match paused and hands focus to pause Resume.
    engine.state.fighters[0].x = 4;
    dialog.querySelector<HTMLButtonElement>("[data-reset]")!.click();
    expect(dialog.open).toBe(false);
    expect(engine.state.phase).toBe("paused");
    expect(onResume).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(root.querySelector('.pause-panel [data-action="resume"]'));

    // Quick reset does not bypass disconnected pause either.
    engine.state.fighters[0].x = 5;
    trainingUI.quickReset();
    expect(engine.state.fighters[0].x).toBe(5);

    // Reopen and close with 戻る while disconnected: stays paused.
    trainingUI.open();
    dialog.querySelector<HTMLButtonElement>("[data-pad-back]")!.click();
    expect(dialog.open).toBe(false);
    expect(engine.state.phase).toBe("paused");
    expect(onResume).not.toHaveBeenCalled();

    // Once reconnected and playing, opening & closing with 戻る resumes normally.
    padConnected = true;
    engine.resume();
    expect(engine.state.phase).toBe("playing");
    trainingUI.open();
    expect(engine.state.phase).toBe("paused");
    dialog.querySelector<HTMLButtonElement>("[data-pad-back]")!.click();
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(engine.state.phase).toBe("playing");
    trainingUI.destroy();
  });

  test("in production wiring, pause Resume and Restart stay paused in Training while the assigned pad is missing", async () => {
    document.body.innerHTML = '<div id="app"></div>';
    const canvas = document.createElement("canvas");
    vi.resetModules();
    vi.doMock("../src/render/renderer", () => ({
      hasSoftwareRenderer: () => false,
      ArenaRenderer: {
        create: async (host: HTMLElement) => {
          host.append(canvas);
          return {
            canvas,
            render() {},
            present() {},
            applySettings() {},
            screenToWorld: () => null,
            setSpotlight() {},
            destroy() {},
          };
        },
      },
    }));
    vi.doMock("../src/game/audio", () => ({
      BattleAudio: class {
        unlock() {}
        setMix() {}
        update() {}
        setEnabled() {}
        destroy() {}
      },
    }));
    let current: PadSnapshot | null = pad();
    Object.defineProperty(navigator, "getGamepads", {
      configurable: true,
      value: () => [current && { ...current, connected: true }],
    });
    let now = performance.now();
    let handle = 0;
    const frames = new Map<number, FrameRequestCallback>();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.set(++handle, cb);
      return handle;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const draw = (count = 1) => {
      for (let i = 0; i < count; i++) {
        now += 34;
        const batch = [...frames.values()];
        frames.clear();
        batch.forEach((cb) => cb(now));
      }
    };
    try {
      await import("../src/main");
      draw(2);
      const app = window.__BRAMBLE__!;
      // Assign P1 to pad1 in Training and start playing.
      document.querySelector<HTMLButtonElement>('button[data-mode="training"]')!.click();
      const select = document.querySelector<HTMLSelectElement>(
        '.player-row[data-slot="0"] .player-device',
      )!;
      select.value = "pad1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      document.querySelector<HTMLButtonElement>('[data-action="start"]')!.click();
      draw(2);
      expect(app.engine!.training).not.toBeNull();
      expect(app.engine!.state.options.controls[0]).toBe("pad1");
      app.engine!.state.phase = "playing";
      draw(2);

      // Open Training settings, disconnect pad1, and close settings -> stays paused.
      document.querySelector<HTMLButtonElement>(".training-hud [data-open]")!.click();
      draw();
      current = null;
      draw(2);
      document.querySelector<HTMLButtonElement>("dialog.training-dialog [data-pad-back]")!.click();
      draw();
      expect(app.engine!.state.phase).toBe("paused");

      // Both Resume and Restart on the pause panel must refuse to resume while pad1 is missing.
      document.querySelector<HTMLButtonElement>('.pause-screen [data-action="resume"]')!.click();
      draw();
      expect(app.engine!.state.phase).toBe("paused");
      document.querySelector<HTMLButtonElement>('.pause-screen [data-action="restart"]')!.click();
      draw();
      expect(app.engine!.state.phase).toBe("paused");

      // Reconnecting pad1 allows Resume to restore play cleanly.
      current = pad();
      draw(2);
      document.querySelector<HTMLButtonElement>('.pause-screen [data-action="resume"]')!.click();
      draw();
      expect(app.engine!.state.phase).toBe("playing");
    } finally {
      window.dispatchEvent(new Event("pagehide"));
      Reflect.deleteProperty(navigator, "getGamepads");
      vi.unstubAllGlobals();
      vi.doUnmock("../src/render/renderer");
      vi.doUnmock("../src/game/audio");
    }
  });
});

/** Boots the real app (GameUI, TrainingUI, main.ts wiring) on a stub renderer and audio. */
async function bootApp() {
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.clear();
  const canvas = document.createElement("canvas");
  vi.resetModules();
  vi.doMock("../src/render/renderer", () => ({
    hasSoftwareRenderer: () => false,
    ArenaRenderer: {
      create: async (host: HTMLElement) => {
        host.append(canvas);
        return {
          canvas,
          render() {},
          present() {},
          applySettings() {},
          screenToWorld: () => null,
          setSpotlight() {},
          destroy() {},
        };
      },
    },
  }));
  vi.doMock("../src/game/audio", () => ({
    BattleAudio: class {
      unlock() {}
      setMix() {}
      update() {}
      setEnabled() {}
      destroy() {}
    },
  }));
  let now = performance.now();
  let handle = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.set(++handle, cb);
    return handle;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const draw = (count = 1) => {
    for (let i = 0; i < count; i++) {
      now += 34;
      const batch = [...frames.values()];
      frames.clear();
      batch.forEach((cb) => cb(now));
    }
  };
  await import("../src/main");
  draw(2);
  const teardown = () => {
    window.dispatchEvent(new Event("pagehide"));
    vi.unstubAllGlobals();
    vi.doUnmock("../src/render/renderer");
    vi.doUnmock("../src/game/audio");
  };
  return { app: window.__BRAMBLE__!, draw, teardown };
}

describe("phone rules bottom sheet", () => {
  test("the summary button opens the sheet; 完了, the backdrop, Escape, a mode switch and Start close it", async () => {
    const { app, draw, teardown } = await bootApp();
    try {
      const $ = <T extends HTMLElement = HTMLElement>(selector: string) =>
        document.querySelector<T>(selector)!;
      const block = $(".match-options");
      const toggle = $<HTMLButtonElement>(".rules-toggle");
      const panel = $("#match-rules-panel");
      const done = panel.querySelector<HTMLButtonElement>("[data-rules-close]")!;
      const isOpen = () => block.classList.contains("rules-open");

      // The toggle sits right before the panel it controls, which holds every secondary rule.
      expect(toggle.getAttribute("aria-controls")).toBe("match-rules-panel");
      expect(toggle.nextElementSibling).toBe(panel);
      for (const selector of [
        ".match-set-format",
        "[data-preset]",
        "[data-stocks]",
        "[data-time]",
        "[data-gimmick]",
        ".rules-preset-detail",
        ".rules-summary",
        ".rules-notes",
        "[data-difficulty]",
      ])
        expect(panel.querySelector(selector), selector).not.toBeNull();
      // Start, the tutorial and the links share the pinned call-to-action block.
      const cta = $(".menu-cta");
      expect(cta.querySelector('[data-action="start"]')).not.toBeNull();
      expect(cta.querySelector(".tutorial-entry")).not.toBeNull();
      expect(cta.querySelector(".menu-links")).not.toBeNull();

      // Open with the toggle: modal semantics + inert background + Tab focus trap.
      toggle.click();
      expect(isOpen()).toBe(true);
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(panel.getAttribute("role")).toBe("dialog");
      expect(panel.getAttribute("aria-modal")).toBe("true");
      expect(toggle.inert).toBe(true);
      expect($(".menu-cta").inert).toBe(true);
      expect($(".topbar").inert).toBe(true);
      expect($(".rules-sheet-backdrop").inert).toBe(false);
      expect(document.activeElement).toBe(done);

      // Shift+Tab from 完了 wraps to the last control inside the sheet instead of the toggle.
      const shiftTab = new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      done.dispatchEvent(shiftTab);
      expect(shiftTab.defaultPrevented).toBe(true);
      expect(panel.contains(document.activeElement)).toBe(true);
      expect(document.activeElement).not.toBe(done);
      // Tab from the last control wraps back to 完了.
      const forwardTab = new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      });
      document.activeElement!.dispatchEvent(forwardTab);
      expect(forwardTab.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(done);

      // Global KeyV shortcut must not toggle the camera setting while the rules sheet is open.
      const cameraButton = $<HTMLButtonElement>(".camera-button");
      const cameraBefore = cameraButton.getAttribute("aria-pressed");
      done.dispatchEvent(new KeyboardEvent("keydown", { key: "v", code: "KeyV", bubbles: true }));
      expect(cameraButton.getAttribute("aria-pressed")).toBe(cameraBefore);

      // 完了 closes, restores inert state & ARIA, and hands focus back to the toggle.
      done.click();
      expect(isOpen()).toBe(false);
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(panel.getAttribute("role")).toBe("group");
      expect(panel.hasAttribute("aria-modal")).toBe(false);
      expect(toggle.inert).toBe(false);
      expect($(".menu-cta").inert).toBe(false);
      expect($(".topbar").inert).toBe(false);
      expect(document.activeElement).toBe(toggle);

      // A tap on the backdrop closes it and returns focus.
      toggle.click();
      $(".rules-sheet-backdrop").click();
      expect(isOpen()).toBe(false);
      expect(document.activeElement).toBe(toggle);

      // Escape closes it, is consumed (no pause, nothing else hears it) and refocuses the toggle.
      toggle.click();
      const bubbled = vi.fn();
      window.addEventListener("keydown", bubbled);
      const escape = new KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        bubbles: true,
        cancelable: true,
      });
      done.dispatchEvent(escape);
      window.removeEventListener("keydown", bubbled);
      expect(isOpen()).toBe(false);
      expect(escape.defaultPrevented).toBe(true);
      expect(bubbled).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(toggle);
      expect(app.snapshot().phase).toBe("menu");
      // With the sheet closed, Escape is left alone.
      const later = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      document.body.dispatchEvent(later);
      expect(later.defaultPrevented).toBe(false);

      // The summary follows the rules: lives, the set format, and a dot for stage overrides.
      const summary = $(".rules-toggle-summary");
      expect(summary.textContent).toMatch(/^標準 · 残機3 · \d+:\d{2} · ふつう$/);
      $<HTMLButtonElement>('[data-stocks="5"]').click();
      draw();
      expect(summary.textContent).toContain("残機5");
      expect(summary.textContent).toContain("カスタム");
      $<HTMLButtonElement>('[data-set-format="bo3"]').click();
      draw();
      expect(summary.textContent).toMatch(/^BO3 · /);
      $<HTMLButtonElement>('[data-difficulty="hard"]').click();
      draw();
      expect(summary.textContent).toMatch(/つよい$/);
      expect(toggle.classList.contains("has-notes")).toBe(false);
      $<HTMLButtonElement>('button[data-stage="bridges"]').click();
      draw();
      expect(toggle.classList.contains("has-notes")).toBe(true);

      // In 稽古 the toggle is hidden with the other rules.
      $<HTMLButtonElement>('button[data-mode="rumble"]').click();
      expect(summary.textContent).not.toMatch(/^BO3/);
      $<HTMLButtonElement>('button[data-mode="training"]').click();
      expect(toggle.hidden).toBe(true);
      $<HTMLButtonElement>('button[data-mode="duel"]').click();
      expect(toggle.hidden).toBe(false);

      // Starting a match closes an open sheet cleanly on phase transition, and pause includes help.
      toggle.click();
      expect(isOpen()).toBe(true);
      app.engine!.start("duel", app.snapshot().options);
      draw(2);
      expect(isOpen()).toBe(false);
      expect(toggle.inert).toBe(false);
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(app.snapshot().phase).not.toBe("menu");
      const pauseHelp = $<HTMLButtonElement>('.pause-panel [data-action="help"]');
      pauseHelp.click();
      expect($<HTMLDialogElement>("dialog.help-dialog").open).toBe(true);
    } finally {
      teardown();
    }
  });

  test("PadMenu treats the open rules sheet as its own modal layer", () => {
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
      new DOMRect(0, 0, 80, 32),
    ] as unknown as DOMRectList);
    document.body.innerHTML = `
      <div id="root">
        <div class="topbar"></div>
        <div class="menu-screen">
          <section class="match-options rules-open">
            <div id="match-rules-panel">
              <button type="button" data-rules-close>完了</button>
              <button type="button" data-stocks="2">2</button>
            </div>
          </section>
          <button data-action="start">START</button>
        </div>
      </div>`;
    const root = document.getElementById("root")!;
    const startClicks = vi.fn();
    const closeClicks = vi.fn();
    root.querySelector('[data-action="start"]')!.addEventListener("click", startClicks);
    root.querySelector("[data-rules-close]")!.addEventListener("click", closeClicks);

    const titleButton = vi.fn(() => true);
    const pads = new PadHub();
    const menu = new PadMenu(root, pads, { phase: () => "menu", titleButton });
    // Connect neutral, then press Start (must neither join nor launch match).
    pads.current[0] = pad();
    menu.update(1);
    pads.current[0] = pad([BUTTON.START]);
    menu.update(2);
    expect(titleButton).not.toHaveBeenCalled();
    expect(startClicks).not.toHaveBeenCalled();

    // Pressing B closes the rules sheet instead of removing a joined title player.
    pads.current[0] = pad();
    menu.update(3);
    pads.current[0] = pad([BUTTON.B]);
    menu.update(4);
    expect(titleButton).not.toHaveBeenCalled();
    expect(closeClicks).toHaveBeenCalledTimes(1);
    menu.destroy();
  });
});

describe("training HUD on touch screens", () => {
  test("buttons carry their shortcuts as hints, and the status is flagged while there is nothing to say", () => {
    document.body.innerHTML = `
      <div id="root">
        <div class="game-hud"></div>
        <div class="pause-panel"><button type="button" data-action="resume">再開</button></div>
      </div>`;
    const root = document.getElementById("root")!;
    const engine = new BattleEngine(5);
    engine.start("training", {});
    engine.state.phase = "playing";
    const trainingUI = new TrainingUI(
      root,
      engine,
      () => {},
      () => {},
    );
    const hud = root.querySelector<HTMLElement>(".training-hud")!;
    const open = hud.querySelector("[data-open]")!;
    const reset = hud.querySelector("[data-reset]")!;
    expect(open.querySelector("span")!.textContent).toBe("稽古設定");
    expect(open.querySelector("kbd.shortcut-hint")!.textContent).toBe("T / 十字↑");
    expect(reset.querySelector("span")!.textContent).toBe("リセット");
    expect(reset.querySelector("kbd.shortcut-hint")!.textContent).toBe("R / 十字↓");
    for (const selector of ["[data-stop]", ".training-status", ".training-state pre"])
      expect(hud.querySelector(selector), selector).not.toBeNull();

    const status = hud.querySelector<HTMLElement>(".training-status")!;
    trainingUI.update();
    // Idle with no tape: flagged, but the words stay for the keyboard layouts.
    expect(status.classList.contains("idle-empty")).toBe(true);
    expect(status.textContent).toContain("待機");

    // Infinite stamina is worth showing.
    engine.configureTraining({ infinite: true });
    trainingUI.update();
    expect(status.classList.contains("idle-empty")).toBe(false);
    expect(status.textContent).toContain("スタミナ∞");
    engine.configureTraining({ infinite: false });
    trainingUI.update();
    expect(status.classList.contains("idle-empty")).toBe(true);

    // Recording, and a recorded tape once stopped, are shown.
    expect(engine.beginTraining("record")).toBe(true);
    trainingUI.update();
    expect(status.classList.contains("idle-empty")).toBe(false);
    expect(status.textContent).toContain("記録中");
    for (let i = 0; i < 3; i++) engine.training!.sample(emptyInput());
    engine.stopTraining();
    trainingUI.update();
    expect(engine.training!.transport).toBe("idle");
    expect(status.classList.contains("idle-empty")).toBe(false);
    expect(status.textContent).toContain("記録 3F");

    // Playing it back too.
    expect(engine.beginTraining("play")).toBe(true);
    trainingUI.update();
    expect(status.classList.contains("idle-empty")).toBe(false);
    trainingUI.destroy();
  });
});
