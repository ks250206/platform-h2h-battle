// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { BattleEngine } from "../src/game/engine";
import { BUTTON, type PadSnapshot } from "../src/game/gamepad";
import { PadHub } from "../src/game/pads";
import type { Phase } from "../src/game/types";
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
