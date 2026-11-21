import { describe, expect, test } from "vite-plus/test";
import { TrainingPadRelease } from "../src/game/input";
import { BUTTON, isDown } from "../src/game/gamepad";
import { BattleEngine } from "../src/game/engine";
import { attackContains, isInvulnerable } from "../src/game/combat";
import { ladderMatchOptions, LADDER_ROUNDS } from "../src/game/ladder";
import { trainingSnapshot, RECORDING_LIMIT } from "../src/game/training";
import type { StageId } from "../src/game/stages";
import { ATTACKS, RULES, UKEMI } from "../src/game/tuning";
import { emptyInput, type AttackId, type FighterMode, type PlayerInput } from "../src/game/types";
import { debugGeometry } from "../src/render/trainingDebug";

const dt = RULES.fixedStep;
const input = (values: Partial<PlayerInput> = {}) => ({ ...emptyInput(), ...values });
function training(stage: StageId = "garden") {
  const e = new BattleEngine(12);
  e.start("training", { difficulty: "hard", stage });
  e.state.phase = "playing";
  return e;
}
function ticks(e: BattleEngine, count: number, frame = emptyInput()) {
  for (let i = 0; i < count; i++) e.update(dt, frame);
}
const attacks = Object.keys(ATTACKS) as AttackId[];

describe("practice partner", () => {
  test("stands still by default, moves back and forth, dodges and uses the match CPU", () => {
    const e = training();
    const f = e.state.fighters[1];
    const distance = () => Math.hypot(f.x, f.z);
    const spawn = distance();
    ticks(e, 100);
    expect(distance()).toBe(spawn);
    expect(e.training!.settings).toMatchObject({
      hitboxes: false,
      overlay: false,
      infinite: false,
    });
    e.configureTraining({ behavior: "move" });
    const first = f.x;
    ticks(e, 34);
    const next = f.x;
    ticks(e, 44);
    expect((next - first) * (f.x - next)).toBeLessThan(0);
    e.configureTraining({ behavior: "dodge" });
    e.update(dt);
    expect(f.mode).toBe("step");
    e.configureTraining({ behavior: "cpu" });
    ticks(e, 90);
    expect(f.aiLevel).toBe("hard");
    expect(f.aiMemory).not.toBeNull();
  });

  describe.each(["move", "dodge"] as const)("%s partner footing", (behavior) => {
    test.each([
      { stage: "garden", x: 8.8, z: 8.8 },
      { stage: "ruins", x: 3.2, z: 0 },
      { stage: "bridges", x: 3.5, z: 0 },
      { stage: "factory", x: 8.8, z: -8.8 },
    ] as const)("keeps moving over solid floor on $stage for 240 ticks", ({ stage, x, z }) => {
      const e = training(stage);
      e.configureTraining({ behavior });
      const dummy = e.state.fighters[1];
      Object.assign(dummy, { x, z });
      let furthest = 0;
      let stepped = false;
      for (let i = 0; i < 240; i++) {
        e.update(dt);
        expect(dummy.grounded).toBe(true);
        expect(dummy.mode).not.toBe("dead");
        stepped ||= dummy.mode === "step";
        furthest = Math.max(furthest, Math.hypot(dummy.x - x, dummy.z - z));
      }
      expect(furthest).toBeGreaterThan(0.5);
      expect(stepped).toBe(behavior === "dodge");
    });
  });

  test.each(attacks)("repeats the selected %s", (attack) => {
    const e = training();
    e.configureTraining({ behavior: "repeatAttack", attack });
    const f = e.state.fighters[1];
    const swings = new Set<number>();
    for (let i = 0; i < 180; i++) {
      e.update(dt);
      if (f.mode === "active") {
        expect(f.attack).toBe(attack);
        swings.add(f.swingId);
      }
    }
    expect(swings.size).toBeGreaterThan(1);
  });

  test("per-slot damage is finite, bounded and used by actual launches", () => {
    const e = training();
    e.setTrainingDamage(0, "75");
    for (const bad of [NaN, "", "   ", undefined, Infinity, "n/a"]) {
      e.setTrainingDamage(0, bad);
      expect(e.state.fighters[0].damage).toBe(75);
    }
    e.setTrainingDamage(1, 1e99);
    expect(e.state.fighters[1].damage).toBe(999);
    e.setTrainingDamage(1, -20);
    expect(e.state.fighters[1].damage).toBe(0);
    function launch(percent: number) {
      e.setTrainingDamage(1, percent);
      e.resetTraining();
      const [a, b] = e.state.fighters;
      expect(a.damage).toBe(75);
      Object.assign(a, {
        x: 0,
        z: 0,
        facing: 0,
        mode: "active",
        attack: "overhead",
        modeDuration: 1,
      });
      Object.assign(b, { x: 0, z: 2 });
      e.update(dt);
      expect(b.damage).toBe(percent + ATTACKS.overhead.damage);
      return b.pendingLaunch!.z;
    }
    expect(launch(100)).toBeGreaterThan(launch(0));
  });

  test("infinite stamina refills immediately and normal costs and recovery resume", () => {
    const e = training();
    e.state.fighters.forEach((f) => {
      f.stamina = 0;
    });
    e.configureTraining({ infinite: true, behavior: "dodge" });
    e.update(dt, input({ step: true }));
    for (const f of e.state.fighters) expect([f.mode, f.stamina]).toEqual(["step", 100]);
    e.configureTraining({ infinite: false, behavior: "still" });
    ticks(e, 30);
    e.update(dt, input({ step: true }));
    const f = e.state.fighters[0];
    expect(f.stamina).toBe(100 - RULES.stepCost);
    ticks(e, 60);
    expect(f.stamina).toBeGreaterThan(100 - RULES.stepCost);
  });

  test.each(["grab", "throw", "hitstun", "ukemi", "knockdown", "dead", "idle"] as const)(
    "instant reset reconstructs both fighters from %s, including outstanding subframe input",
    (mode) => {
      const e = training();
      e.setTrainingDamage(1, 65);
      const fresh = structuredClone(e.state.fighters);
      const [a, b] = e.state.fighters;
      Object.assign(a, {
        mode,
        grabbedId: 1,
        vx: 5,
        x: 100,
        y: -12,
        invulnerable: 2,
        hitstop: 1,
        respawnTimer: 1,
        pendingLaunch: { x: 1, y: 2, z: 0 },
        tumbling: true,
        airStepUsed: true,
        stamina: 2,
      });
      Object.assign(b, { mode: "grabbed", grabbedBy: 0, inputBuffer: { action: "step", age: 0 } });
      e.state.effects.push({
        kind: "hit",
        id: 0,
        life: 1,
        duration: 1,
        size: 1,
        color: 0,
        x: 0,
        y: 0,
        z: 0,
      });
      e.state.bombs.push({ id: 1, x: 0, z: 0, radius: 1, timer: 1, duration: 1, exploded: false });
      e.update(dt / 2, input({ attackPressed: "thrust", jump: true }));
      e.resetTraining();
      expect(e.state.fighters).toEqual(fresh);
      expect(e.state.effects).toEqual([]);
      expect(e.state.bombs).toEqual([]);
      e.update(dt);
      expect(e.state.fighters[0].mode).toBe("idle");
      expect(e.state.fighters[0].grounded).toBe(true);
      e.update(dt, input({ jump: true }));
      expect(e.state.fighters[0].vy).toBeGreaterThan(0);
    },
  );

  test("falls respawn forever at configured damage without consuming stock", () => {
    const e = training();
    e.setTrainingDamage(1, 70);
    const lives = e.state.fighters[1].stocks;
    e.state.fighters[1].x = 50;
    e.update(dt);
    expect(e.state.fighters[1].mode).toBe("dead");
    ticks(e, 95);
    expect(e.state.fighters[1]).toMatchObject({ damage: 70, mode: "idle", stocks: lives });
    expect(e.state.phase).toBe("playing");
  });
});

describe("combat inspection", () => {
  test.each(attacks)(
    "rendered %s surface agrees with the combat predicate on both sides",
    (attack) => {
      const f = training().state.fighters[0];
      f.attack = attack;
      expect(debugGeometry(f)!.high).toEqual([]);
      f.mode = "active";
      f.facing = 0.73;
      for (const grounded of [true, false]) {
        f.grounded = grounded;
        const g = debugGeometry(f)!;
        for (const p of g.hurt) {
          expect(Math.hypot(p.x - f.x, p.z - f.z)).toBeCloseTo(RULES.fighterRadius, 10);
          expect(p.y).toBe(f.y);
        }
        for (const [i, p] of g.low.entries()) {
          const target = (scale: number, y: number) => ({
            mode: "idle" as const,
            x: f.x + (p.x - f.x) * scale,
            z: f.z + (p.z - f.z) * scale,
            y,
          });
          expect(attackContains(f, target(0.999, f.y))).toBe(true);
          expect(attackContains(f, target(1.001, f.y))).toBe(false);
          expect(attackContains(f, target(0.5, p.y - 0.001))).toBe(false);
          expect(attackContains(f, target(0.5, p.y + 0.001))).toBe(true);
          expect(attackContains(f, target(0.5, g.high[i].y + 0.001))).toBe(false);
          expect(attackContains(f, target(0.5, g.high[i].y - 0.001))).toBe(true);
        }
      }
      f.mode = "dead";
      expect(debugGeometry(f)).toBeNull();
    },
  );
  test("reports mode, phase timer, actual protection, tokens, input age and armed tech", () => {
    const e = training();
    const f = e.state.fighters[0];
    const modes: FighterMode[] = [
      "idle",
      "charge",
      "windup",
      "active",
      "recovery",
      "cancel",
      "step",
      "ukemi",
      "knockdown",
      "hitstun",
      "grab",
      "grabbed",
      "throw",
      "clash",
      "dead",
    ];
    for (const mode of modes) {
      Object.assign(f, {
        mode,
        modeDuration: 12 * dt,
        modeTime: 4 * dt,
        hitstop: 2 * dt,
        airStepUsed: true,
        tumbling: mode === "hitstun",
        inputBuffer: {
          action: "step",
          attack: null,
          age: 3,
          pressedIn: "hitstun",
          landingGrace: false,
        },
      });
      const snap = trainingSnapshot(e.state, f);
      expect(snap).toMatchObject({
        mode,
        invulnerable: isInvulnerable(f),
        cancellable: mode === "charge" || mode === "windup",
        hitstop: 2,
        air: { rising: true, thrust: true, step: false },
        buffer: { age: 3, action: "step" },
        tumbling: mode === "hitstun",
        techTicks: mode === "hitstun" ? UKEMI.windowTicks - 3 : null,
      });
      if (mode !== "idle" && mode !== "dead") expect(snap.remaining).toBe(8);
    }
  });
});

describe("fixed-tick input tape", () => {
  test("captures fixed ticks, held inputs and single edges; reproducible from either frame rate", () => {
    const e = training();
    expect(e.beginTraining("play")).toBe(false);
    e.beginTraining("record");
    const held = input({
      move: { x: 0.2, z: -0.3 },
      aim: { x: 1, z: 0 },
      attackPressed: "sweep",
      attackHeld: "sweep",
    });
    e.update(dt / 2, held);
    expect(e.training!.ticks).toBe(0);
    e.update(dt * 2.5, { ...held, attackPressed: null });
    held.move.x = -1;
    ticks(e, 75);
    e.stopTraining();
    expect(e.training!.ticks).toBe(78);
    const traces = [1, 0.5].map((rate) => {
      e.beginTraining("play");
      return Array.from({ length: 78 }, () => {
        for (let i = 0; i < 1 / rate; i++) e.update(dt * rate, input({ move: { x: 0.2, z: 0.3 } }));
        const d = e.state.fighters[1];
        return [d.mode, d.modeTime, d.facing, d.x, d.z, d.stamina, d.charge, d.swingId];
      });
    });
    expect(traces[0]).toEqual(traces[1]);
    expect(traces[0].slice(0, 5).map((t) => t[0])).toEqual([
      "charge",
      "charge",
      "charge",
      "windup",
      "windup",
    ]);
    expect(traces[0].some((t) => t[0] === "active")).toBe(true);
    expect(e.training!.transport).toBe("idle");
    expect(e.state.fighters[0].diInput).toEqual({ x: 0.2, z: 0.3 });
  });
  test("loop seam resets damage, positions and tick timing even inside a single display frame", () => {
    const e = training();
    e.configureTraining({ loop: true });
    e.setTrainingDamage(1, 100);
    e.beginTraining("record");
    e.update(dt, input({ jump: true, move: { x: 1, z: 0 } }));
    e.update(dt);
    e.beginTraining("play");
    e.update(dt);
    const first = structuredClone(e.state.fighters[1]);
    e.state.fighters[1].damage = 850;
    e.update(dt * 4);
    expect(e.state.fighters[1]).toEqual(first);
    expect(e.training).toMatchObject({ cursor: 1, ticks: 2, transport: "playing" });
  });
  test("limit is exact even across hitstop and dead ticks; a new recording replaces it", () => {
    const e = training();
    e.beginTraining("record");
    e.state.fighters[0].x = 50;
    ticks(e, RECORDING_LIMIT + 3);
    expect(e.training).toMatchObject({ ticks: RECORDING_LIMIT, transport: "idle" });
    e.beginTraining("record");
    e.update(dt, input({ step: true }));
    e.beginTraining("play");
    e.update(dt);
    expect(e.state.fighters[1].mode).toBe("step");
    expect(e.training).toMatchObject({ ticks: 1, transport: "idle" });
  });
  test.each(["stop", "settings", "damage", "reset", "pause"] as const)(
    "%s releases transient and queued inputs without losing the tape",
    (action) => {
      for (const mode of ["record", "play"] as const) {
        const e = training();
        e.beginTraining("record");
        ticks(e, 5, input({ move: { x: 1, z: 0 }, attackHeld: "sweep" }));
        if (mode === "play") {
          e.beginTraining("play");
          e.update(dt);
        }
        e.update(dt / 2, input({ jump: true, attackPressed: "sweep" }));
        if (action === "pause") {
          e.pause();
          e.resume();
        }
        if (action === "settings") e.configureTraining({ hitboxes: true });
        if (action === "reset") e.resetTraining();
        if (action === "stop") e.stopTraining();
        if (action === "damage") e.setTrainingDamage(0, 30);
        ticks(e, 3);
        expect(e.training).toMatchObject({ ticks: 5, transport: "idle" });
        for (const f of e.state.fighters) {
          expect(f).toMatchObject({
            mode: "idle",
            grounded: true,
            inputBuffer: null,
            diInput: { x: 0, z: 0 },
          });
        }
      }
    },
  );

  test("a human partner keeps their device, including after dummy playback", () => {
    const e = training();
    e.start("training", { controls: { 0: "keyboard", 1: "pad1" } });
    e.beginTraining("record");
    e.update(dt, { 0: input({ step: true }), 1: input({ jump: true }) });
    expect(e.state.fighters[1].grounded).toBe(false);
    e.beginTraining("play");
    e.update(dt, { 1: input({ jump: true }) });
    expect(e.state.fighters[1]).toMatchObject({ mode: "step", grounded: true });
    ticks(e, 30);
    e.update(dt, { 1: input({ jump: true }) });
    expect(e.state.fighters[1].grounded).toBe(false);
  });

  test.each(["duel", "rumble", "ladder"] as const)(
    "exiting to %s restores normal rules",
    (mode) => {
      const e = training();
      e.configureTraining({
        infinite: true,
        overlay: true,
        hitboxes: true,
        behavior: "repeatAttack",
        loop: true,
      });
      e.beginTraining("record");
      ticks(e, 5, input({ step: true }));
      e.beginTraining("play");
      e.menu("training");
      expect(e.training).toBeNull();
      if (mode === "ladder") e.start("duel", ladderMatchOptions(e.state.options, LADDER_ROUNDS[0]));
      else e.start(mode);
      expect(e.training).toBeNull();
      expect(e.beginTraining("play")).toBe(false);
      e.resetTraining();
      e.configureTraining({ infinite: true });
      e.setTrainingDamage(0, 100);
      e.state.phase = "playing";
      e.update(dt, input({ step: true }));
      expect(e.state.fighters[0]).toMatchObject({ damage: 0, stamina: 100 - RULES.stepCost });
      expect(e.state.rules.timeLimit).not.toBeNull();
      e.start("training");
      expect(e.training).toMatchObject({
        ticks: 0,
        transport: "idle",
        settings: { behavior: "still", infinite: false, overlay: false, hitboxes: false },
      });
    },
  );
});

test("menu-held pad buttons and both sticks wait for release independently", () => {
  const buttons = Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }));
  buttons[BUTTON.A] = buttons[BUTTON.RT] = { pressed: true, value: 1 };
  const pad = { buttons, axes: [0.9, 0.1, 0, -0.7] };
  const release = new TrainingPadRelease(pad);
  const muted = release.filter(pad);
  expect(muted.axes).toEqual([0, 0, 0, 0]);
  expect(isDown(muted, BUTTON.A)).toBe(false);
  expect(isDown(muted, BUTTON.RT)).toBe(false);
  buttons[BUTTON.A] = { pressed: false, value: 0 };
  buttons[BUTTON.B] = { pressed: true, value: 1 };
  const fresh = release.filter({ buttons, axes: [0, 0, 0, -0.8] });
  expect(isDown(fresh, BUTTON.B)).toBe(true);
  expect(fresh.axes[3]).toBe(0);
  buttons[BUTTON.A] = { pressed: true, value: 1 };
  buttons[BUTTON.RT] = { pressed: false, value: 0 };
  const again = release.filter({ buttons, axes: [-1, 0, 0, 0] });
  expect(again.axes[0]).toBe(-1);
  expect(isDown(again, BUTTON.A)).toBe(true);
  expect(release.ready).toBe(true);
});

test("a replayed attack during hitstop buffers and fires on the first legal tick", () => {
  const e = training();
  e.beginTraining("record");
  e.update(dt, input({ attackPressed: "thrust" }));
  ticks(e, 8);
  e.beginTraining("play");
  const dummy = e.state.fighters[1];
  Object.assign(dummy, { mode: "recovery", modeDuration: 3 * dt, hitstop: 2 * dt });
  e.update(dt);
  expect(dummy.inputBuffer).toMatchObject({ action: "attack", attack: "thrust", age: 0 });
  ticks(e, 3);
  expect(dummy).toMatchObject({ mode: "charge", attack: "thrust", inputBuffer: null });
  e.update(dt);
  expect(dummy.mode).toBe("windup");
});

test.each(["record", "play"] as const)(
  "leaving during %s discards the active session",
  (action) => {
    const e = training();
    e.beginTraining("record");
    ticks(e, 3, input({ attackPressed: "overhead", attackHeld: "overhead" }));
    if (action === "play") {
      e.beginTraining("play");
      e.update(dt);
    }
    const session = e.training!;
    e.start("duel");
    expect(session.transport).toBe("idle");
    expect(e.training).toBeNull();
    e.resetTraining();
    expect(e.state.phase).toBe("countdown");
    expect(e.state.fighters.every((f) => f.attack === null && f.inputBuffer === null)).toBe(true);
  },
);
