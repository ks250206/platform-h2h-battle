import { describe, expect, test } from "vite-plus/test";
import { BattleEngine, canStandAt, isInvulnerable } from "../src/game/engine";
import { freshPadMemory, readPad } from "../src/game/gamepad";
import type { StageId } from "../src/game/stages";
import { RULES, UKEMI } from "../src/game/tuning";
import { emptyInput, type Fighter } from "../src/game/types";
import { cpuTechOpportunity } from "../src/game/ukemi";
import { FighterMotion } from "../src/render/motion";

const dt = RULES.fixedStep;
const step = { ...emptyInput(), step: true };

function fixture(stage: StageId = "garden", mode: "duel" | "training" = "training") {
  const engine = new BattleEngine(5150);
  engine.start(mode, { stage });
  engine.state.phase = "playing";
  const [f, other] = engine.state.fighters;
  Object.assign(f, { x: 0, z: 0, facing: 0 });
  Object.assign(other, { x: -5, z: -5 });
  return { engine, f, other };
}

// Start at a height that crosses the floor on exactly the Nth semi-implicit gravity tick.
function tumble(f: Fighter, ticks = 1) {
  const fallSpeed = 3;
  Object.assign(f, {
    mode: "hitstun",
    modeTime: 0,
    modeDuration: 2,
    tumbling: true,
    y: fallSpeed * (ticks - 0.5) * dt + (RULES.gravity * dt * dt * ticks * (ticks + 1)) / 2,
    vy: -fallSpeed,
    grounded: false,
    vx: 0,
    vz: 0,
  });
}

function advance(engine: BattleEngine, ticks: number) {
  for (let i = 0; i < ticks; i++) engine.update(dt);
}

describe("a fresh dodge edge during a launch", () => {
  test.each([
    ["absent", null, "knockdown"],
    ["early", 11, "knockdown"],
    ["window opens", 10, "ukemi"],
    ["impact", 0, "ukemi"],
    ["late", -1, "knockdown"],
  ] as const)("%s", (_, lead, mode) => {
    const { engine, f } = fixture();
    tumble(f, 15);
    for (let tick = 1; tick <= 16; tick++)
      engine.update(dt, lead !== null && tick === 15 - lead ? step : emptyInput());
    expect(f.mode).toBe(mode);
    expect(engine.state.effects.filter((e) => e.kind === "ukemi")).toHaveLength(
      mode === "ukemi" ? 1 : 0,
    );
    advance(engine, 30);
    expect(f.mode).toBe("idle");
    expect(engine.state.stats.dodges).toBe(0);
    expect(f.inputBuffer).toBeNull();
  });

  test.each([{ attackPressed: "sweep" }, { jump: true }, { grab: true }] as const)(
    "a later press %o preserves the armed step and is discarded on landing",
    (press) => {
      const { engine, f } = fixture();
      tumble(f, 6);
      engine.update(dt, step);
      advance(engine, 2);
      engine.update(dt, { ...emptyInput(), ...press });
      advance(engine, 2);
      expect(f.mode).toBe("ukemi");
      expect(f.inputBuffer).toBeNull();
      advance(engine, 16);
      expect(f.mode).toBe("idle");
      expect(f.attack).toBeNull();
      expect(f.grounded).toBe(true);
    },
  );

  test.each([true, false])("brief throw protection allows a tumbling landing (tech %s)", (tech) => {
    const { engine, f } = fixture();
    tumble(f);
    f.invulnerable = 0.15;
    expect(cpuTechOpportunity(engine.state, f, dt)).toBe(true);
    engine.update(dt, tech ? step : { ...emptyInput(), attackPressed: "sweep" });
    expect(f.invulnerable).toBeGreaterThan(0);
    expect(f.mode).toBe(tech ? "ukemi" : "knockdown");
    expect(f.inputBuffer).toBeNull();
  });

  test("holding gamepad B from outside the window never refreshes the press", () => {
    const { engine, f } = fixture();
    tumble(f, 18);
    const pad = {
      axes: [],
      buttons: [
        { pressed: false, value: 0 },
        { pressed: true, value: 1 },
      ],
    };
    const memory = freshPadMemory();
    for (let i = 0; i < 18; i++) {
      const { commands } = readPad(pad, i ? pad : null, memory);
      engine.update(dt, { ...emptyInput(), step: commands.step });
    }
    expect(f.mode).toBe("knockdown");
  });

  test.each([true, false])("air step previously spent = %s; identical landing reset", (spent) => {
    const { engine, f } = fixture();
    tumble(f, 2);
    Object.assign(f, {
      airStepUsed: spent,
      airRisingUsed: true,
      airThrustUsed: true,
      stamina: 1,
      staminaDelay: 2,
    });
    engine.update(dt, step);
    expect([f.airStepUsed, f.airRisingUsed, f.airThrustUsed]).toEqual([spent, true, true]);
    engine.update(dt);
    expect(f.mode).toBe("ukemi");
    expect([f.airStepUsed, f.airRisingUsed, f.airThrustUsed]).toEqual([false, false, false]);
    advance(engine, 16);
    expect(f.stamina).toBe(1);
  });

  test.each([true, false])("recovery and punish frames (tech %s)", (success) => {
    const { engine, f } = fixture();
    tumble(f);
    engine.update(dt, success ? step : emptyInput());
    const locked = success ? 16 : 28;
    for (let tick = 0; tick < locked; tick++) {
      expect(f.mode).toBe(success ? "ukemi" : "knockdown");
      expect(isInvulnerable(f)).toBe(tick < (success ? 8 : 5));
      expect([f.x, f.z]).toEqual([0, 0]); // neutral
      engine.update(dt, tick === locked - 1 ? { ...emptyInput(), jump: true } : emptyInput());
    }
    expect(f.mode).toBe("idle");
    expect(f.vy).toBeGreaterThan(0);
  });

  test("direction is sampled at contact and the entire diagonal roll is 1.8 units", () => {
    const { engine, f } = fixture();
    tumble(f, 3);
    engine.update(dt, { ...step, move: { x: -1, z: 0 } });
    engine.update(dt);
    engine.update(dt, { ...emptyInput(), move: { x: 1, z: 1 } });
    advance(engine, 24);
    expect(f.x).toBeCloseTo(f.z);
    expect(Math.hypot(f.x, f.z)).toBeCloseTo(1.8);
    expect(f.facing).toBe(0);
  });

  test("a second hit discards the old tech; a high rising slash restores air control before landing", () => {
    const { engine, f, other } = fixture();
    tumble(f, 5);
    Object.assign(other, {
      x: 0,
      z: -1.2,
      facing: 0,
      mode: "active",
      attack: "rising",
      modeDuration: 0.2,
    });
    engine.update(dt, step);
    expect(f.pendingLaunch!.y).toBeGreaterThan(10);
    expect(f.inputBuffer).toBeNull();
    while (f.mode === "hitstun" && f.hitstop > 0) engine.update(dt);
    while (f.modeTime + 4 * dt < f.modeDuration) engine.update(dt);
    engine.update(dt, step);
    advance(engine, 4);
    expect(f.mode).toBe("idle");
    expect(f.grounded).toBe(false);
    expect(f.inputBuffer).toBeNull();
    advance(engine, 80);
    expect(f.grounded).toBe(true);
    expect(engine.state.stats.dodges).toBe(0);
    expect(engine.state.effects.some((e) => e.kind === "ukemi")).toBe(false);
  });

  test("a meteor from above lands while still stunned and can be teched", () => {
    const { engine, f, other } = fixture();
    Object.assign(f, { y: 2.5, grounded: false, vy: 1 });
    Object.assign(other, {
      x: 0,
      y: 3.2,
      z: -1,
      grounded: false,
      facing: 0,
      mode: "active",
      attack: "overhead",
      modeDuration: 0.14,
    });
    engine.update(dt);
    expect(f.pendingLaunch!.y).toBeLessThan(-9);
    for (let i = 0; i < 60 && (f.hitstop > 0 || f.y > 0.9); i++) engine.update(dt);
    expect(f.mode).toBe("hitstun");
    engine.update(dt, step);
    for (let i = 0; i < 10 && !f.grounded; i++) engine.update(dt);
    expect(f.mode).toBe("ukemi");
  });

  test("a swing covering the in-place tech hits as protection ends", () => {
    const { engine, f, other } = fixture();
    tumble(f);
    Object.assign(other, {
      x: 0,
      z: -1.2,
      facing: 0,
      mode: "active",
      attack: "sweep",
      modeDuration: 0.18,
    });
    engine.update(dt, step);
    advance(engine, 7);
    expect(f.mode).toBe("ukemi");
    expect(f.damage).toBe(0);
    engine.update(dt);
    expect(f.mode).toBe("hitstun");
    expect(f.damage).toBeGreaterThan(0);
    expect(f.inputBuffer).toBeNull();
    for (let i = 0; i < 60 && f.mode === "hitstun"; i++) engine.update(dt);
    expect(f.mode).toBe("knockdown");
  });

  test("a jump followed by a fresh airborne dodge spends the normal dodge", () => {
    const { engine, f } = fixture();
    engine.update(dt, { ...emptyInput(), jump: true });
    for (let i = 0; i < 90 && !(f.vy < 0 && f.y < 0.7); i++) engine.update(dt);
    engine.update(dt, step);
    expect(f.mode).toBe("step");
    expect(f.airStepUsed).toBe(true);
    expect(f.stamina).toBe(RULES.maxStamina - RULES.stepCost);
    for (let i = 0; i < 90 && !f.grounded; i++) {
      engine.update(dt);
      expect(engine.state.effects.some((effect) => effect.kind === "ukemi")).toBe(false);
    }
    expect(f.grounded).toBe(true);
    expect(f.airStepUsed).toBe(false);
  });

  test.each([0, RULES.respawnInvulnerable])(
    "a free landing with protection %f is ordinary",
    (invulnerable) => {
      const { engine, f } = fixture();
      Object.assign(f, { y: 0.02, vy: -4, grounded: false, airStepUsed: true, invulnerable });
      engine.update(dt, step);
      expect(f.grounded).toBe(true);
      expect(f.mode).toBe("idle");
      expect(engine.state.effects.map((e) => e.kind)).toEqual(["land"]);
    },
  );
});

describe("live floor and match rules", () => {
  test.each([
    ["garden", 9.2, 0, 9],
    ["garden", 8, 0, 7],
    ["ruins", 0, 0, 9],
    ["bridges", 3, 2, 9],
  ] as const)("%s gap or missing rim at %f, %f", (stage, x, z, half) => {
    const { engine, f } = fixture(stage);
    tumble(f);
    Object.assign(f, { x, z });
    engine.state.arena.halfSize = half;
    engine.update(dt, step);
    expect(f.grounded).toBe(false);
    advance(engine, 70);
    expect(f.mode).toBe("dead");
    expect(engine.state.effects.some((e) => e.kind === "ukemi")).toBe(false);
  });

  test.each([
    ["garden", 8.8, 0, 1, 0],
    ["ruins", 3.3, 0, -1, 0],
    ["bridges", 3, 0.5, 0, 1],
  ] as const)("%s roll stops at the floor boundary", (stage, x, z, dx, dz) => {
    const { engine, f } = fixture(stage);
    tumble(f);
    Object.assign(f, { x, z });
    engine.update(dt, { ...step, move: { x: dx, z: dz } });
    expect(f.mode).toBe("ukemi");
    for (let i = 0; i < 16; i++) {
      engine.update(dt);
      expect(canStandAt(engine.state, f.x, f.z) && f.grounded).toBe(true);
    }
    expect(Math.hypot(f.x - x, f.z - z)).toBeLessThan(0.4);
  });

  test.each([
    ["garden", 8.85, 8.85, -1],
    ["bridges", 3, 0.72, 1],
  ] as const)("%s roll travels its full distance alongside an edge", (stage, x, z, dx) => {
    const { engine, f } = fixture(stage);
    tumble(f);
    Object.assign(f, { x, z });
    engine.update(dt, { ...step, move: { x: dx, z: 0 } });
    expect(f.mode).toBe("ukemi");
    for (let i = 0; i < 12; i++) {
      engine.update(dt);
      expect(f.grounded).toBe(true);
      expect(f.x).toBeCloseTo(x + dx * UKEMI.rollSpeed * dt * (i + 1));
      expect(f.z).toBeCloseTo(z);
    }
  });

  test("moving inward just below the rim cannot turn a fall into a tech", () => {
    const { engine, f } = fixture();
    tumble(f);
    Object.assign(f, { x: 9.02, y: -0.02, vx: -5 });
    engine.update(dt, step);
    expect(canStandAt(engine.state, f.x, f.z)).toBe(true);
    expect(f.grounded).toBe(false);
    expect(f.y).toBeLessThan(-0.02);
    expect(engine.state.effects).toHaveLength(0);
  });

  test.each([true, false])(
    "losing the rim during get-up shows the falling pose (tech %s)",
    (tech) => {
      const { engine, f, other } = fixture("garden", "duel");
      other.hitstop = 100;
      tumble(f);
      f.x = 7.1;
      engine.state.elapsed = RULES.collapseStart - 1.5 * dt;
      engine.update(dt, { ...emptyInput(), step: tech, move: { x: -1, z: 0 } });
      expect(f.mode).toBe(tech ? "ukemi" : "knockdown");
      engine.update(dt);
      expect(f.x).toBe(7.1);
      expect(f.grounded).toBe(false);
      const context = { floor: false, atEase: false };
      const falling = new FighterMotion().update({ ...f, mode: "idle" }, dt, context).skeleton;
      const pose = new FighterMotion().update(f, dt, context).skeleton;
      // The idle pose also has a small breathing offset.
      expect(pose.pelvis.p.y).toBeCloseTo(falling.pelvis.p.y, 2);
      expect(pose.tumble).toEqual(falling.tumble);
    },
  );

  test.each([false, true])("outside gauge and clock continue; KO on impact = %s", (ko) => {
    const { engine, f, other } = fixture("garden", "duel");
    other.hitstop = 100;
    engine.state.elapsed = RULES.safeZoneStart + 5;
    tumble(f);
    Object.assign(f, { x: -8.8, z: -8.8, outsideTime: ko ? RULES.outsideLimit - dt : 1 });
    engine.update(dt, step);
    if (ko) {
      expect(f.mode).toBe("dead");
      expect(engine.state.effects.some((e) => e.kind === "ukemi")).toBe(false);
    } else {
      expect(f.mode).toBe("ukemi");
      advance(engine, 12);
      expect(f.outsideTime).toBeCloseTo(1 + 13 * dt);
      expect(engine.state.elapsed).toBeCloseTo(RULES.safeZoneStart + 5 + 13 * dt);
    }
  });
});

describe("fixed-tick inputs and presentation", () => {
  test.each([1, 3, 6])("hitstop counts toward the window with %i ticks per frame", (batch) => {
    for (const [stop, expected] of [
      [6, "ukemi"],
      [7, "knockdown"],
    ] as const) {
      const { engine, f } = fixture();
      tumble(f, 6);
      f.hitstop = (stop - 0.5) * dt;
      for (let tick = 0; tick < 18; tick += batch)
        engine.update(batch * dt, tick === 0 ? step : emptyInput());
      expect(f.mode).toBe(expected);
      expect(f.inputBuffer).toBeNull();
    }
  });

  test.each(["duel", "rumble"] as const)("%s humans each claim their own tech", (mode) => {
    const engine = new BattleEngine();
    engine.start(mode, { controls: { 0: "keyboard", 1: "pad1", 2: "pad2", 3: "pad3" } });
    engine.state.phase = "playing";
    for (const f of engine.state.fighters) tumble(f);
    const inputs = Object.fromEntries(
      engine.state.fighters.map((f) => [f.id, f.id % 2 ? emptyInput() : step]),
    );
    engine.update(dt, inputs);
    for (const f of engine.state.fighters) {
      expect(f.human).toBe(true);
      expect(f.mode).toBe(f.id % 2 ? "knockdown" : "ukemi");
    }
  });

  test.each(["easy", "normal", "hard"] as const)("seeded %s CPU success frequency", (level) => {
    const { engine, other: cpu } = fixture("garden", "duel");
    cpu.aiLevel = level;
    let successes = 0;
    for (let trial = 0; trial < 1000; trial++) {
      tumble(cpu);
      engine.update(dt);
      expect(["ukemi", "knockdown"]).toContain(cpu.mode);
      if (cpu.mode === "ukemi") successes++;
    }
    expect(Math.abs(successes / 1000 - UKEMI.cpuChance[level])).toBeLessThan(0.05);
  });

  test("the 3D tech spins on the travel axis while a missed tech braces on the floor", () => {
    const frame = (success: boolean) => {
      const { engine, f } = fixture();
      const motion = new FighterMotion();
      tumble(f);
      engine.update(dt, success ? { ...step, move: { x: 1, z: 0 } } : emptyInput());
      const context = { floor: true, atEase: false };
      motion.update(f, dt, context);
      for (let i = 0; i < 6; i++) {
        engine.update(dt);
        motion.update(f, dt, context);
      }
      return motion.update(f, 0, context);
    };
    expect(frame(true).skeleton.tumble.z).toBeCloseTo(-Math.PI);
    expect(frame(false).skeleton.tumble.z).toBe(0);
  });
});
