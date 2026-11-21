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
});
