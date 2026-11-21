// @vitest-environment happy-dom
import { describe, expect, test, vi, afterEach } from "vite-plus/test";
import { BattleEngine, canStandAt } from "../src/game/engine";
import { LESSONS, TutorialBattle, type LessonId } from "../src/game/tutorial";
import { RULES } from "../src/game/tuning";
import { emptyInput, type PlayerInput, type AttackId } from "../src/game/types";
import { BUTTON, type PadSnapshot } from "../src/game/gamepad";
import { BattleInput } from "../src/game/input";
import { PadHub } from "../src/game/pads";
import { lessonPrompt, TUTORIAL_CONTROLS } from "../src/ui/tutorialUi";

const dt = RULES.fixedStep;
const right = { x: 1, z: 0 };
const left = { x: -1, z: 0 };
function lesson(id: LessonId) {
  const b = new TutorialBattle();
  b.begin(id, "keyboard");
  return b;
}
function tick(b: BattleEngine, input: Partial<PlayerInput> = {}, frames = 1) {
  for (let i = 0; i < frames; i++) b.update(dt, { ...emptyInput(), ...input });
}
function until(
  b: TutorialBattle,
  predicate: () => boolean,
  input: Partial<PlayerInput> = {},
  limit = 240,
) {
  for (let i = 0; !predicate() && i < limit && b.status === "playing"; i++) tick(b, input);
  expect(predicate(), `${b.lesson.id} step ${b.step}, ${b.status}: ${b.feedback}`).toBe(true);
}
function swing(b: TutorialBattle, attack: AttackId, held = 0, aim: PlayerInput["aim"] = right) {
  tick(b, { attackPressed: attack, attackHeld: attack, aim });
  tick(b, { attackHeld: attack, aim }, held);
  tick(b, { aim });
}
function waitIdle(b: TutorialBattle) {
  const [p, r] = b.state.fighters;
  until(b, () => p.mode === "idle" && r.mode === "idle" && r.grounded);
}
function approach(b: TutorialBattle, spacing: number) {
  const [p, r] = b.state.fighters;
  until(b, () => r.x - p.x <= spacing, { move: right, aim: right });
}
function success(b: TutorialBattle) {
  expect(b.status).toBe("success");
  expect(b.completed.has(b.lesson.id)).toBe(true);
}

describe("independent lessons on the real fixed-step simulation", () => {
  test.each(LESSONS.map((l) => l.id))(
    "%s starts independently, with clean state even after a pending input",
    (id) => {
      const b = lesson(id);
      const initial = structuredClone(b.state);
      tick(b, { attackPressed: "overhead", jump: true, step: true });
      b.update(dt / 2, { ...emptyInput(), attackPressed: "thrust", jump: true });
      b.state.fighters[0].damage = 91;
      b.state.fighters[1].mode = "dead";
      b.state.fighters[0].airStepUsed = true;
      b.begin(id, "keyboard");
      expect(b.state).toEqual(initial);
      expect(b.step).toBe(0);
      expect(b.completed.size).toBe(0);
      tick(b);
      expect(b.state.fighters[0].mode).toBe("idle");
      expect(b.state.fighters[0].grounded).toBe(true);
      expect(b.status).toBe("playing");
    },
  );

  test("movement, a real jump and a sword hit with aim resolved toward the opponent", () => {
    const b = lesson("basics");
    tick(b, { jump: true, aim: right, attackPressed: "overhead" });
    tick(b, {}, 100);
    expect(b.step).toBe(0);
    approach(b, 2);
    expect(b.step).toBe(1);
    tick(b, { jump: true });
    tick(b, {}, 58);
    expect(b.step).toBe(2);
    // The fighter still faces the opponent. A sword can even land without an aim sample.
    tick(b, { attackPressed: "sweep" });
    tick(b, {}, 110);
    expect(b.state.stats.hits).toBe(1);
    expect(b.step).toBe(2);
    expect(b.feedback).toContain("照準");
    approach(b, 2);
    // With lock-on off, releasing the aim key or stick leaves the fighter facing the rival.
    tick(b, { aim: left }, 20);
    tick(b, { aim: right }, 20);
    tick(b);
    swing(b, "overhead", 0, null);
    until(b, () => b.status === "success");
    success(b);
  });

  test("a tapped thrust and a near-full overhead count, but a tapped overhead gives feedback", () => {
    const b = lesson("attacks");
    tick(b, { aim: left }, 20);
    swing(b, "thrust", 0, left);
    tick(b, { aim: left }, 80);
    expect(b.step).toBe(0);
    approach(b, 2);
    tick(b, { aim: right }, 20);
    swing(b, "thrust");
    until(b, () => b.step === 1, { aim: right });
    waitIdle(b);
    approach(b, 2);
    swing(b, "overhead");
    waitIdle(b);
    expect(b.step).toBe(1);
    expect(b.feedback).toContain("ためて");
    approach(b, 2);
    swing(b, "overhead", 45);
    expect(b.state.fighters[0].charge).toBeGreaterThanOrEqual(0.85);
    expect(b.state.fighters[0].charge).toBeLessThan(1);
    until(b, () => b.status === "success", { aim: right });
    success(b);
  });

  test("requires a ground step, a spent/refused air step, landing reset, and a second-airtime step", () => {
    const b = lesson("dodge");
    const p = b.state.fighters[0];
    tick(b, { step: true, move: left });
    expect(b.step).toBe(1);
    until(b, () => p.mode === "idle");
    tick(b, { jump: true });
    tick(b, { step: true, move: right });
    until(b, () => p.mode === "idle");
    expect(p.airStepUsed).toBe(true);
    expect(b.step).toBe(2);
    tick(b, { step: true });
    expect(b.step).toBe(3);
    expect(p.mode).toBe("idle");
    until(b, () => p.grounded);
    expect(b.step).toBe(4);
    expect(p.airStepUsed).toBe(false);
    tick(b, { jump: true });
    tick(b, { step: true, move: left });
    success(b);
  });
  test("landing before testing the spent dodge explains the miss", () => {
    const b = lesson("dodge");
    tick(b, { step: true });
    tick(b, {}, 22);
    tick(b, { jump: true });
    tick(b, { step: true });
    tick(b, {}, 90);
    expect(b.status).toBe("failed");
    expect(b.feedback).toContain("着地");
  });

  test.each(["charge", "windup", "active", "recovery"] as const)("cancel during %s", (mode) => {
    const b = lesson("cancel");
    const p = b.state.fighters[0];
    tick(b, { cancel: true });
    expect(b.step).toBe(0);
    tick(b, { attackPressed: "overhead", attackHeld: "overhead" });
    until(b, () => p.mode === mode);
    tick(b, { cancel: true });
    if (mode === "charge" || mode === "windup") {
      expect(p.mode).toBe("cancel");
      success(b);
    } else {
      expect(b.status).toBe("failed");
      expect(b.feedback).toContain("判定中と後隙");
      expect(b.completed.size).toBe(0);
    }
  });

  test("a missed grab cannot score; both capture and attributed throw are required", () => {
    const b = lesson("throw");
    tick(b, { aim: left }, 14);
    tick(b, { grab: true, aim: left });
    tick(b, { aim: left }, 75);
    expect(b.step).toBe(0);
    tick(b, { aim: right }, 14);
    tick(b, { grab: true, aim: right });
    until(b, () => b.step === 1);
    expect(b.state.fighters[1].mode).toBe("grabbed");
    until(b, () => b.status === "success", { move: right });
    expect(b.state.fighters[1].lastAttacker).toBe(0);
    const release = b.state.fighters[1].x;
    tick(b, {}, 15);
    expect(b.state.fighters[1].x).toBeGreaterThan(release + 0.5);
    expect(b.resultReady).toBe(false);
    success(b);
  });

  test("a high-damage hit only advances the launch objective; a credited stock loss completes KO", () => {
    const b = lesson("ko");
    const rival = b.state.fighters[1];
    swing(b, "overhead");
    until(b, () => b.step === 1);
    expect(rival.damage).toBeGreaterThan(120);
    expect(rival.stocks).toBe(2);
    expect(b.completed.size).toBe(0);
    until(b, () => b.status === "success");
    expect(rival.stocks).toBe(1);
    expect(rival.respawnTimer).toBeGreaterThan(0);
    expect(b.state.playerStats[0].kos).toBe(1);
    success(b);
  });
  test("an uncredited fall after hitting does not earn the KO", () => {
    const b = lesson("ko");
    swing(b, "overhead");
    until(b, () => b.step === 1);
    b.state.fighters[1].lastHitAt = -Infinity;
    until(b, () => b.status === "failed");
    expect(b.completed.size).toBe(0);
  });

  test.each(["rising", "thrust"] as const)(
    "offstage recovery with a jump, air dodge and %s",
    (attack) => {
      const b = lesson("recovery");
      const p = b.state.fighters[0];
      tick(b, { jump: true });
      expect(b.step).toBe(1);
      expect(canStandAt(b.state, p.x, p.z)).toBe(false);
      tick(b, {}, 120);
      expect(p.y).toBe(6.5);
      tick(b, { step: true, move: left });
      expect(b.step).toBe(2);
      until(b, () => p.mode === "idle", { move: left });
      swing(b, attack, 0, left);
      until(b, () => b.step === 3, { move: left, aim: left });
      expect(p.grounded).toBe(false);
      until(b, () => b.status === "success", { move: left, aim: left });
      expect(p.grounded).toBe(true);
      success(b);
    },
  );
  test("falling retries just recovery; previous lesson credit survives an exact reset", () => {
    const b = lesson("cancel");
    tick(b, { attackPressed: "thrust" });
    tick(b, { cancel: true });
    success(b);
    b.begin("recovery", "pad2");
    const initial = structuredClone(b.state);
    tick(b, { jump: true });
    tick(b, { step: true, move: right });
    tick(b, { move: right }, 180);
    expect(b.status).toBe("failed");
    expect(b.feedback).toContain("場外");
    b.begin("recovery", "pad2");
    expect(b.state).toEqual(initial);
    expect([...b.completed]).toEqual(["cancel"]);
  });
  test.each([{ jump: true }, { attackPressed: "thrust" }, { grab: true }, { cancel: true }] as const)(
    "the recovery air pause explains how to continue after %j",
    (action) => {
      const b = lesson("recovery");
      tick(b, { jump: true });
      const elapsed = b.state.elapsed;
      tick(b, action);
      expect(b.feedback).toContain("足場方向へ回避");
      expect(b.state.elapsed).toBe(elapsed);
      expect(b.step).toBe(1);
      tick(b, { step: true, move: left });
      expect(b.feedback).toBe("");
      expect(b.step).toBe(2);
    },
  );
  test("landing before spending a recovery attack is a retry", () => {
    const b = lesson("recovery");
    tick(b, { jump: true });
    tick(b, { step: true, move: left });
    tick(b, { move: left }, 150);
    expect(b.status).toBe("failed");
    expect(b.feedback).toContain("復帰技");
  });

  test("zone requires real exposure, entering the announced destination, and safety during travel", () => {
    const b = lesson("zone");
    const p = b.state.fighters[0];
    expect(b.state.arena.safeZone.startsIn).toBeGreaterThan(2.9);
    tick(b);
    expect(b.step).toBe(0);
    expect(p.outsideTime).toBeGreaterThan(0);
    tick(b, {}, 34);
    expect(p.outsideTime).toBeLessThan(0.6);
    expect(b.step).toBe(0);
    until(b, () => b.step === 1);
    expect(p.outsideTime).toBeGreaterThanOrEqual(0.6);
    expect(p.damage).toBeCloseTo(p.outsideTime * RULES.outsideDamage);
    expect(b.step).toBe(1);
    expect(b.state.arena.safeZone.motion).toBe("warning");
    const preview = b.state.arena.safeZone.destination!;
    const current = b.state.arena.safeZone;
    expect(Math.hypot(preview.x - current.x, preview.z - current.z)).toBeGreaterThan(
      preview.radius + current.radius,
    );
    tick(b, { move: right }, 32);
    expect(Math.hypot(p.x - current.x, p.z - current.z)).toBeLessThan(current.radius);
    expect(b.status).toBe("playing");
    // Waiting inside the old safe circle cannot satisfy the destination objective.
    until(b, () => b.state.arena.safeZone.motion === "travel");
    expect(b.step).toBe(1);
    for (let i = 0; i < 360 && b.status === "playing"; i++) {
      const zone = b.state.arena.safeZone;
      tick(b, { move: { x: zone.x - p.x, z: zone.z - p.z } });
    }
    expect(b.state.arena.safeZone.motion, b.feedback).toBe("travel");
    expect(p.outsideTime).toBe(0);
    success(b);
  });
  test("waiting just inside the far edge of the destination succeeds on the arrival tick", () => {
    const b = lesson("zone");
    until(b, () => b.step === 1);
    const p = b.state.fighters[0];
    const zone = b.state.arena.safeZone;
    const destination = zone.destination!;
    // Set up the last half-second of travel, with arrival between two simulation ticks.
    b.state.elapsed += zone.startsIn + zone.travelLeft - 0.5 + dt / 2;
    const edge = destination.x + destination.radius;
    p.x = edge + RULES.moveSpeed * dt - 0.001;
    p.z = destination.z;
    tick(b, { move: left });
    expect(p.x).toBeCloseTo(edge - 0.001, 6);
    expect(b.state.arena.safeZone.motion).toBe("travel");
    until(b, () => b.state.arena.safeZone.motion === "hold");
    expect(p.x).toBeCloseTo(edge - 0.001, 6);
    success(b);
  });
  test("staying outside loses a stock without completing the zone objective", () => {
    const b = lesson("zone");
    tick(b, {}, 310);
    expect(b.status).toBe("failed");
    expect(b.feedback).toContain("ゲージ");
  });

  test.each(["early", "none", "neutral", "timed"] as const)(
    "opponent's actual launch and %s landing input",
    (timing) => {
      const b = lesson("ukemi");
      const p = b.state.fighters[0];
      until(b, () => b.state.fighters[1].mode === "windup", { move: right });
      until(b, () => b.step === 1);
      expect(p.tumbling && p.mode === "hitstun").toBe(true);
      if (timing === "early") tick(b, { step: true, move: right });
      until(b, () => p.vy < 0 && p.y < 0.14);
      if (timing === "neutral" || timing === "timed")
        tick(b, { step: true, move: timing === "timed" ? left : { x: 0, z: 0 } });
      until(b, () => p.grounded, { move: timing === "timed" ? left : { x: 0, z: 0 } });
      if (timing === "timed") {
        expect(p.mode).toBe("ukemi");
        const landing = p.x;
        until(b, () => b.status === "success", { move: left });
        expect(p.x).toBeLessThan(landing);
        success(b);
      } else {
        expect(b.status).toBe("failed");
        expect(p.mode).toBe(timing === "neutral" ? "ukemi" : "knockdown");
        expect(b.feedback).toContain("受け身");
      }
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function pad(...buttons: number[]): PadSnapshot {
  return {
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 16 }, (_, i) => ({
      pressed: buttons.includes(i),
      value: Number(buttons.includes(i)),
    })),
  };
}
const key = (code: string, type = "keydown") =>
  window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
const pointer = (element: Element, pointerType: string, type = "pointerdown") =>
  element.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType, pointerId: 1 }));

describe("prompts exercise the game's actual input handlers", () => {
  test("keyboard, pad and rendered touch labels produce the advertised actions", () => {
    document.body.innerHTML = '<div id="app"></div>';
    const canvas = document.createElement("canvas");
    const pads = new PadHub();
    const b = lesson("basics");
    const input = new BattleInput(canvas, pads, {
      toWorld: () => null,
      onPause() {},
      onGesture() {},
      onCameraToggle() {},
      onPadLost() {},
      rumble: () => false,
    });
    const take = (touch = false) => {
      input.updateVisibility(b.state);
      return input.sample(b.state, touch)[0]!;
    };
    take();
    const keys = TUTORIAL_CONTROLS.keyboard;
    for (const action of [
      "step",
      "jump",
      "cancel",
      "grab",
      "rising",
      "overhead",
      "thrust",
    ] as const) {
      const code =
        keys[action] === "Shift"
          ? "ShiftLeft"
          : keys[action] === "Space"
            ? "Space"
            : "Key" + keys[action];
      key(code);
      const f = take();
      if (action === "rising" || action === "thrust" || action === "overhead")
        expect(f.attackPressed).toBe(action);
      else expect(f[action]).toBe(true);
      key(code, "keyup");
    }
    key("KeyD");
    expect(Math.hypot(...Object.values(take().move))).toBeCloseTo(1);
    key("KeyD", "keyup");
    key("Tab");
    take();
    key("Tab", "keyup");
    expect(input.playerLocks[0].on).toBe(false);
    input.newMatch(true);
    expect(take(true).aim).toEqual({ x: 4, z: 0 });
    for (const action of [
      "step",
      "jump",
      "cancel",
      "grab",
      "rising",
      "overhead",
      "thrust",
    ] as const) {
      const button = [...document.querySelectorAll(".touch-actions button")].find((el) =>
        el.textContent.includes(TUTORIAL_CONTROLS.touch[action]),
      )!;
      pointer(button, "touch");
      const f = take(true);
      if (action === "rising" || action === "thrust" || action === "overhead")
        expect(f.attackPressed).toBe(action);
      else expect(f[action]).toBe(true);
      pointer(button, "touch", "pointerup");
    }
    for (const l of LESSONS)
      expect(lessonPrompt(l.id, "touch")).not.toMatch(/Tab|マウス|解除|R3|Shift|Space/);
    expect(lessonPrompt("basics", "touch")).toContain("自動ロック");
    b.begin("basics", "pad1");
    input.newMatch(true);
    for (const action of [
      "step",
      "jump",
      "cancel",
      "grab",
      "rising",
      "overhead",
      "thrust",
    ] as const) {
      pads.current[0] = pad();
      take();
      pads.current[0] = pad(BUTTON[TUTORIAL_CONTROLS.gamepad[action]]);
      const f = take();
      if (action === "rising" || action === "thrust" || action === "overhead")
        expect(f.attackPressed).toBe(action);
      else expect(f[action]).toBe(true);
    }
    // A stick, trigger and confirmation held while navigating do not start or move the lesson.
    b.begin("basics", "pad1");
    input.reset();
    input.newMatch(true);
    pads.current[0] = { ...pad(BUTTON.A, BUTTON.RT, BUTTON.START), axes: [1, 0, 1, 0] };
    for (let i = 0; i < 20; i++) {
      const f = take();
      expect(f.move).toEqual({ x: 0, z: 0 });
      expect(f.attackPressed).toBeNull();
      expect(f.jump).toBe(false);
      b.update(dt, f);
    }
    expect(b.step).toBe(0);
    pads.current[0] = pad();
    take();
    pads.current[0] = { ...pad(BUTTON.A), axes: [1, 0] };
    const fresh = take();
    expect(fresh.jump).toBe(true);
    expect(Math.hypot(...Object.values(fresh.move))).toBeCloseTo(1);
    input.newMatch();
    expect(input.playerLocks[0].on).toBe(false); // the normal session's lock preference
    input.destroy();
  });
});

test("title, lesson navigation, disconnect, retries, summary and normal-mode handoffs use the production wiring", async () => {
  // Exercise main + both UI classes + BattleInput. Replace only WebGL/audio, layout and hardware.
  document.body.innerHTML = '<div id="app"></div>';
  const canvas = document.createElement("canvas");
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
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    new DOMRect(0, 0, 40, 20),
  ] as unknown as DOMRectList);
  let current: PadSnapshot | null = pad();
  Object.defineProperty(navigator, "getGamepads", {
    configurable: true,
    value: () => [current && { ...current, connected: true }],
  });
  let now = performance.now(),
    handle = 0;
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
  const element = (selector: string) => {
    const found = document.querySelector<HTMLButtonElement>(selector);
    expect(found, selector).toBeTruthy();
    return found!;
  };
  const click = (selector: string) => element(selector).click();
  const action = (name: string) => click(`.tutorial-dialog[open] [data-tutor="${name}"]`);
  const open = (id: LessonId) => {
    click(".tutorial-entry");
    action(id);
    action("play");
    draw();
  };
  try {
    await import("../src/main");
    draw();
    const app = window.__BRAMBLE__!;
    const normal = app.engine!;
    const battle = () => app.engine as TutorialBattle;
    const nextPress = (button: number) => {
      current = pad();
      draw();
      current = pad(button);
      draw();
    };

    // A focused title entry accepts the unassigned pad directly, without joining a second player.
    element(".tutorial-entry").focus();
    nextPress(BUTTON.A);
    expect(document.querySelector("dialog.tutorial-dialog[open]")).toBeTruthy();
    element('[data-tutor="cancel"]').focus();
    nextPress(BUTTON.A);
    nextPress(BUTTON.START);
    expect(battle().lesson.id).toBe("cancel");
    expect(battle().state.options.controls).toEqual({ 0: "pad1" });
    expect(battle().state.phase).toBe("playing");

    nextPress(BUTTON.RT);
    expect(battle().state.fighters[0].mode).toBe("charge");
    nextPress(BUTTON.Y);
    expect(battle().status).toBe("success");
    draw(18);
    nextPress(BUTTON.START); // result -> next lesson's briefing
    nextPress(BUTTON.A); // briefing -> play, held A must not jump
    draw(4);
    expect(battle().lesson.id).toBe("throw");
    expect(battle().state.fighters[0].grounded).toBe(true);
    expect(battle().completed.has("cancel")).toBe(true);
    nextPress(BUTTON.X);
    draw(6);
    expect(battle().step).toBe(1);
    const beforeDisconnect = structuredClone(battle().state.fighters);
    current = null;
    draw(4);
    expect(battle().state.phase).toBe("paused");
    expect(document.querySelector(".pause-notice")?.textContent).toContain("パッド1");
    click(".pause-screen [data-action=resume]");
    expect(battle().state.phase).toBe("paused");
    current = pad(BUTTON.A, BUTTON.START);
    draw();
    // A reconnect must not start gameplay with a held jump.
    expect(battle().state.phase).toBe("paused");
    expect(battle().step).toBe(1);
    expect(battle().state.fighters).toEqual(beforeDisconnect);
    click(".tutorial-pause-link");
    action("back");
    expect(battle().state.phase).toBe("paused");
    expect(document.activeElement).toBe(element(".pause-panel [data-action=resume]"));
    nextPress(BUTTON.START);
    expect(battle().state.fighters[0].grounded).toBe(true);
    expect(battle().state.fighters[0].x).toBe(beforeDisconnect[0].x);
    expect(battle().state.options.controls[0]).toBe("pad1");
    expect(battle().completed.has("cancel")).toBe(true);

    // Changing input devices during a lesson updates both control and instructions.
    click('.tutorial-hud [data-tutor="retry"]');
    pointer(canvas, "touch");
    draw();
    expect(battle().state.options.controls[0]).toBe("keyboard");
    expect(element(".tutorial-hud small").textContent).toContain("掴む");
    key("KeyU");
    draw();
    key("KeyU", "keyup");
    expect(battle().state.fighters[0].mode).toBe("grab");
    expect(element(".tutorial-hud small").textContent).toContain("U");
    key("KeyR");
    draw();
    key("KeyR", "keyup");
    expect(battle().state.fighters[0].mode).toBe("idle");
    expect(battle().state.fighters[0].stamina).toBe(100);

    click('.tutorial-hud [data-tutor="catalog"]');
    action("recovery");
    action("play");
    draw();
    tick(battle(), { jump: true });
    tick(battle(), { step: true, move: right });
    tick(battle(), { move: right }, 150);
    draw();
    expect(battle().state.fighters[0].grounded).toBe(true);
    expect(battle().state.fighters[0].airStepUsed).toBe(false);
    expect(battle().step).toBe(0);
    expect(battle().feedback).toContain("縁に戻りました");
    expect([...battle().completed]).toEqual(["cancel"]);

    // The pointer which selects a lesson never reaches the arena as a sword press.
    click('.tutorial-hud [data-tutor="catalog"]');
    action("cancel");
    key("KeyJ");
    pointer(element('.tutorial-dialog [data-tutor="play"]'), "mouse");
    action("play");
    draw(3);
    key("KeyJ", "keyup");
    expect(battle().state.fighters[0].mode).toBe("idle");
    expect(battle().state.fighters[0].stamina).toBe(100);
    key("KeyJ");
    draw();
    key("KeyJ", "keyup");
    until(battle(), () => battle().state.fighters[0].mode === "active");
    key("KeyQ");
    draw();
    key("KeyQ", "keyup");
    expect(element(".tutorial-dialog p").textContent).toContain("取消が遅");
    action("retry");
    draw();
    expect(battle().status).toBe("playing");
    expect(battle().state.fighters[0].stamina).toBe(100);

    const toSummary = () => {
      click('.tutorial-hud [data-tutor="catalog"]');
      action("cancel");
      action("play");
      draw();
      key("KeyJ");
      draw();
      key("KeyQ");
      draw();
      key("KeyJ", "keyup");
      key("KeyQ", "keyup");
      draw(18);
      action("summary");
      expect(element("#tutorial-heading").textContent).toBe("学習のまとめ");
      expect(element(".tutorial-dialog ul").textContent).toContain("達成　ため・前隙");
    };
    for (const mode of ["duel", "training"] as const) {
      if (mode === "duel") toSummary();
      else {
        click('.tutorial-hud [data-tutor="catalog"]');
        action("ukemi");
        action("play");
        draw();
        const b = battle();
        until(b, () => b.step === 1, { move: right });
        until(b, () => b.state.fighters[0].vy < 0 && b.state.fighters[0].y < 0.14);
        tick(b, { step: true, move: left });
        until(b, () => b.status === "success", { move: left });
        draw(18);
        action("next");
        expect(element("#tutorial-heading").textContent).toBe("学習のまとめ");
      }
      action(mode);
      draw();
      expect(app.engine).toBe(normal);
      expect(normal.state.mode).toBe(mode);
      expect(normal.state.phase).toBe("countdown");
      expect(normal.state.elapsed).toBe(0);
      const rival = normal.state.fighters[1];
      expect(rival.human).toBe(false);
      expect(rival.damage).toBe(0);
      const spawn = { x: rival.x, z: rival.z };
      tick(normal, {}, 240);
      const walked = Math.hypot(rival.x - spawn.x, rival.z - spawn.z);
      if (mode === "duel") expect(walked).toBeGreaterThan(0.1);
      else expect(walked).toBe(0);
      expect(document.querySelector("[data-tutorial]")).toBeNull();
      click(".pause-button");
      draw();
      click(".pause-screen [data-action=menu]");
      draw();
      open("ko");
    }
    for (const mode of ["rumble", "ladder"] as const) {
      click('.tutorial-hud [data-tutor="catalog"]');
      action("title");
      click(`button[data-mode="${mode}"]`);
      click('[data-action="start"]');
      draw();
      expect(app.engine).toBe(normal);
      expect(normal.state.mode).toBe(mode === "ladder" ? "duel" : mode);
      expect(normal.state.fighters[1].damage).toBe(0);
      expect(normal.state.rules.gimmicks.bombs).toBe(true);
      expect(document.querySelector("[data-tutorial]")).toBeNull();
      click(".pause-button");
      draw();
      click(".pause-screen [data-action=menu]");
      draw();
      open("ko");
    }
  } finally {
    window.dispatchEvent(new Event("pagehide"));
    Reflect.deleteProperty(navigator, "getGamepads");
    vi.doUnmock("../src/render/renderer");
    vi.doUnmock("../src/game/audio");
  }
});
