import { describe, expect, test } from "vite-plus/test";
import { BattleEngine } from "../src/game/engine";
import type { AiLevel } from "../src/game/match";
import { AI_LEVELS, ATTACKS, RULES } from "../src/game/tuning";
import {
  emptyInput,
  type AttackId,
  type Fighter,
  type PlayerInput,
  type Vec2,
} from "../src/game/types";

const DT = 1 / 60;
const LEVELS: AiLevel[] = ["easy", "normal", "hard"];

const unit = (v: Vec2): Vec2 => {
  const d = Math.hypot(v.x, v.z);
  return d > 1e-5 ? { x: v.x / d, z: v.z / d } : { x: 0, z: 0 };
};

const think = (engine: BattleEngine, f: Fighter): PlayerInput =>
  (engine as unknown as { ai(f: Fighter, dt: number): PlayerInput }).ai(f, DT);

function duel(seed: number, difficulty: AiLevel, stocks = 1) {
  const engine = new BattleEngine(seed);
  engine.start("duel", { stocks, difficulty, overrides: {} });
  engine.state.phase = "playing";
  const [human, cpu] = engine.state.fighters;
  return { engine, human, cpu };
}

describe("the difficulty table", () => {
  test("each CPU's level comes from the match options: the global level or its override", () => {
    const engine = new BattleEngine(1);
    engine.start("duel", { difficulty: "hard" });
    expect(engine.state.fighters[1].aiLevel).toBe("hard");
    engine.start("rumble", { difficulty: "easy", overrides: { 2: "hard" } });
    expect(engine.state.fighters.slice(1).map((f) => f.aiLevel)).toEqual(["easy", "hard", "easy"]);
    engine.start("rumble");
    expect(engine.state.fighters.slice(1).map((f) => f.aiLevel)).toEqual(["easy", "hard", "easy"]);
  });
});

describe("measurable differences between levels", () => {
  /** Counts wind-up frames in which the CPU's facing moved, against an opponent circling it. */
  function windupTurns(level: AiLevel): { turned: number; windupFrames: number } {
    let turned = 0;
    let windupFrames = 0;
    for (let episode = 0; episode < 16; episode++) {
      const { engine, human, cpu } = duel(300 + episode, level, 5);
      Object.assign(human, { x: 0, z: -2.4 });
      Object.assign(cpu, { x: 0, z: 0 });
      for (let frame = 0; frame < 12 / DT && engine.state.phase === "playing"; frame++) {
        const to = { x: cpu.x - human.x, z: cpu.z - human.z };
        const d = Math.hypot(to.x, to.z);
        const n = unit(to);
        const input = {
          ...emptyInput(),
          aim: n,
          move: unit({ x: n.z + n.x * (d - 2.4), z: -n.x + n.z * (d - 2.4) }),
        };
        const before = { mode: cpu.mode, facing: cpu.facing };
        engine.update(DT, input);
        if (before.mode === "windup" && cpu.mode === "windup" && cpu.hitstop <= 0) {
          windupFrames++;
          if (Math.abs(cpu.facing - before.facing) > 1e-9) turned++;
        }
      }
    }
    return { turned, windupFrames };
  }

  test("easy keeps its wind-up facing when it moves sideways without a living target", () => {
    const { engine, human, cpu } = duel(61, "easy", 3);
    Object.assign(human, { mode: "dead", respawnTimer: 1 });
    Object.assign(cpu, {
      x: engine.state.arena.halfSize - 0.4,
      z: 0,
      facing: 0,
      mode: "windup",
      modeDuration: ATTACKS.overhead.startup,
      attack: "overhead",
    });
    engine.update(DT);
    expect(cpuInput(engine, cpu).move.x).toBeLessThan(-0.9);
    expect(cpu.facing).toBe(0);
  });

  test("easy never turns during its wind-up; hard keeps tracking", () => {
    const easy = windupTurns("easy");
    const hard = windupTurns("hard");
    expect(easy.windupFrames).toBeGreaterThan(100);
    expect(easy.turned).toBe(0);
    expect(hard.windupFrames).toBeGreaterThan(50);
    expect(hard.turned).toBeGreaterThan(hard.windupFrames * 0.5);
  });
});

function exchange(
  level: AiLevel,
  trial: number,
  style: "tap" | "hold" | "charge feint" | "windup feint" | "whiff" | "spam",
) {
  const { engine, human, cpu } = duel((trial + 1) * 7919, level);
  Object.assign(human, { x: 0, z: 0, facing: 0 });
  Object.assign(cpu, { x: 0, z: 2.2, facing: Math.PI, aiThink: (8 + (trial % 15)) * DT });
  if (style === "whiff")
    Object.assign(human, {
      mode: "active",
      attack: "overhead",
      facing: Math.PI,
      modeDuration: DT,
      swingId: 1,
    });
  let firstStep = -1;
  let early = false;
  let caught = false;
  let punished = false;
  let cancelFrame = -1;
  let followHit = false;
  let followed = false;
  let hits = 0;
  for (let tick = 0; tick < (style === "spam" ? 240 : 115); tick++) {
    const input = emptyInput();
    input.aim = unit({ x: cpu.x - human.x, z: cpu.z - human.z });
    if (style === "spam") {
      if (tick % 4 === 0) input.attackPressed = "overhead";
      if (Math.hypot(cpu.x - human.x, cpu.z - human.z) > 2) input.move = input.aim;
    } else if (style !== "whiff") {
      if (tick === 0) input.attackPressed = "overhead";
      const hold = style === "hold" ? 16 + (trial % 20) : style === "charge feint" ? 45 : 1;
      if (tick < hold) input.attackHeld = "overhead";
      const cancelMode = style === "charge feint" ? "charge" : "windup";
      if (
        (style === "charge feint" || style === "windup feint") &&
        firstStep >= 0 &&
        cancelFrame < 0 &&
        human.mode === cancelMode
      ) {
        input.cancel = true;
        cancelFrame = tick;
      }
      if (cancelFrame >= 0 && tick > cancelFrame) {
        input.move = input.aim;
        if (human.mode === "idle" && !followed) {
          input.attackPressed = "thrust";
          followed = true;
        }
      }
    }
    const previousMode = human.mode;
    const beforeDamage = cpu.damage;
    const playerDamage = human.damage;
    engine.update(DT, input);
    if (firstStep < 0 && cpu.mode === "step") {
      firstStep = tick;
      early = previousMode === "charge";
    }
    if (input.cancel && cpu.mode === "step" && human.mode === "cancel") caught = true;
    if (human.damage > playerDamage && previousMode === "recovery") punished = true;
    if (cpu.damage > beforeDamage) {
      hits++;
      if (followed) followHit = true;
    }
  }
  return { firstStep, early, caught, punished, followHit, hits };
}

// Same seeds, facing, opening spacing and decision phases on all levels. Count discrete
// events over a cohort: small floating-point differences cannot invalidate an entire replay.
const trials = (level: AiLevel, style: Parameters<typeof exchange>[2]) =>
  Array.from({ length: 96 }, (_, i) => exchange(level, i, style));

test("tap pressure leaves basic openings on easy, while normal and hard answer more often", () => {
  const steps = LEVELS.map(
    (level) => trials(level, "tap").filter((row) => row.firstStep >= 0).length,
  );
  expect(steps[0]).toBeLessThan(30);
  expect(steps[1]).toBeGreaterThan(steps[0] + 20);
  expect(steps[2]).toBeGreaterThan(steps[1] + 15);
  const hits = LEVELS.map((level) => trials(level, "spam").reduce((n, row) => n + row.hits, 0));
  expect(hits[0]).toBeGreaterThan(hits[1] + 25);
  expect(hits[1]).toBeGreaterThan(hits[2] + 15);
});

test.each(LEVELS)("%s can misread a hold, or spend a dodge on either kind of feint", (level) => {
  const tap = trials(level, "tap");
  const held = trials(level, "hold");
  expect(tap.some((row) => row.early)).toBe(false);
  expect(held.some((row, i) => row.hits > 0 && tap[i].hits === 0)).toBe(true);
  expect(held.filter((row) => row.early).length).toBeGreaterThan(2);
  expect(held.some((row) => !row.early)).toBe(true);
  for (const style of ["charge feint", "windup feint"] as const) {
    const rows = trials(level, style);
    expect(rows.filter((row) => row.caught).length).toBeGreaterThan(2);
    const thrustPunishes = rows.filter((row) => row.caught && row.followHit).length;
    const minimum = style === "charge feint" && level !== "easy" ? 20 : 3;
    expect(thrustPunishes).toBeGreaterThanOrEqual(minimum);
  }
  const stepFrames = tap.filter((row) => row.firstStep >= 0).map((row) => row.firstStep);
  expect(Math.max(...stepFrames) - Math.min(...stepFrames)).toBeGreaterThan(2);
});

test("hard lands a counter before an opponent can recover from a missed overhead", () => {
  const hits = LEVELS.map((level) => trials(level, "whiff").filter((row) => row.punished).length);
  expect(hits[1]).toBeGreaterThan(0);
  expect(hits[2]).toBeGreaterThan(Math.max(hits[0], hits[1]) + 30);
});

describe("level-specific skills", () => {
  /** Off the platform, falling, with both air attacks already spent. */
  function stranded(level: AiLevel, used: Partial<Fighter>) {
    const { engine, human, cpu } = duel(9, level);
    Object.assign(human, { x: -3, z: 0 });
    Object.assign(cpu, {
      x: engine.state.arena.halfSize + 1.5,
      z: 0,
      y: 0.5,
      vy: -2,
      grounded: false,
      airRisingUsed: true,
      airThrustUsed: true,
      ...used,
    });
    return { engine, cpu };
  }

  test.each([
    ["easy", false],
    ["normal", true],
    ["hard", true],
  ] as const)(
    "recovering, a %s CPU air-dodges home once its air attacks are spent: %s",
    (level, uses) => {
      const { engine, cpu } = stranded(level, {});
      const input = think(engine, cpu);
      expect(input.step).toBe(uses);
      if (uses) expect(input.move.x).toBeLessThan(0);
    },
  );

  test("easy never uses the air thrust to recover; normal does", () => {
    for (const [level, expected] of [
      ["easy", null],
      ["normal", "thrust"],
    ] as const) {
      const { engine, cpu } = stranded(level, { airThrustUsed: false, y: 2 });
      expect(think(engine, cpu).attackPressed).toBe(expected);
    }
  });

  function windingUp(level: AiLevel, target: Partial<Fighter>) {
    const { engine, human, cpu } = duel(4, level);
    Object.assign(cpu, {
      x: 0,
      z: 0,
      facing: 0,
      mode: "windup",
      modeTime: 0.1,
      modeDuration: ATTACKS.overhead.startup,
      attack: "overhead",
    });
    Object.assign(human, { x: 0, z: 2, ...target });
    for (let tick = 0; tick < AI_LEVELS[level].observationTicks; tick++)
      expect(think(engine, cpu).cancel).toBe(false);
    return think(engine, cpu);
  }

  test("hard cancels a wind-up that would whiff; normal never does", () => {
    expect(windingUp("hard", {}).cancel).toBe(false);
    expect(windingUp("hard", { z: 6 }).cancel).toBe(true);
    expect(windingUp("hard", { invulnerable: 2 }).cancel).toBe(true);
    expect(windingUp("hard", { x: 0, z: -2 }).cancel).toBe(true);
    expect(windingUp("normal", { z: 6 }).cancel).toBe(false);
    expect(windingUp("normal", { invulnerable: 2 }).cancel).toBe(false);
  });

  test("hard closes in on and attacks a target stuck in recovery", () => {
    const { engine, human, cpu } = duel(4, "hard");
    Object.assign(cpu, { x: 0, z: 0, aiThink: 0 });
    Object.assign(human, {
      x: 0,
      z: 1.8,
      mode: "recovery",
      modeTime: 0,
      modeDuration: ATTACKS.overhead.recovery,
      attack: "overhead",
    });
    for (let tick = 0; tick < AI_LEVELS.hard.observationTicks; tick++) think(engine, cpu);
    const input = think(engine, cpu);
    expect(input.move.z).toBeGreaterThan(0.9);
    expect(input.attackPressed).toBe("overhead");
    expect(input.grab).toBe(false);
  });

  test("hard throws toward the nearest edge; normal just keeps walking its usual line", () => {
    for (const level of ["hard", "normal"] as const) {
      const { engine, human, cpu } = duel(4, level);
      const edge = engine.state.arena.halfSize;
      Object.assign(cpu, {
        x: edge - 2,
        z: 1,
        facing: Math.PI / 2,
        mode: "throw",
        grabbedId: human.id,
        modeTime: 0,
        modeDuration: RULES.grabHold,
      });
      Object.assign(human, { x: edge - 1.2, z: 1, mode: "grabbed", grabbedBy: cpu.id });
      const input = think(engine, cpu);
      if (level === "hard") expect(input.move).toEqual({ x: 1, z: 0 });
      else expect(input.move.x).toBeLessThan(0);
    }
  });

  test("training's dummy stays inert at every level", () => {
    for (const difficulty of LEVELS) {
      const engine = new BattleEngine(2);
      engine.start("training", { difficulty });
      engine.state.phase = "playing";
      const dummy = engine.state.fighters[1];
      const before = { x: dummy.x, z: dummy.z, facing: dummy.facing };
      for (let frame = 0; frame < 120; frame++) engine.update(DT, emptyInput());
      expect({ x: dummy.x, z: dummy.z, facing: dummy.facing }).toEqual(before);
      expect(dummy.mode).toBe("idle");
    }
  });
});

/** The actual CPU input gathered by the engine, before either player's action was applied. */
function cpuInput(engine: BattleEngine, cpu: Fighter): PlayerInput {
  return (engine as unknown as { inputs: Map<number, PlayerInput> }).inputs.get(cpu.id)!;
}

test.each(LEVELS)(
  "%s sees neither a button edge nor the resulting animation before its delay",
  (level) => {
    const delay = AI_LEVELS[level].observationTicks;
    for (const action of ["tap", "charge", "step", "cancel"] as const) {
      const pair = [duel(7919, level), duel(7919, level)];
      for (const { engine, human, cpu } of pair) {
        Object.assign(cpu, { x: 0, z: 0, aiThink: 99 });
        Object.assign(human, { x: 0, z: 2.7, facing: Math.PI });
        for (let i = 0; i <= delay; i++) engine.update(DT);
        if (action === "cancel")
          engine.update(DT, { ...emptyInput(), attackPressed: "sweep", attackHeld: "sweep" });
      }
      for (let i = 0; i <= delay; i++) {
        for (const [index, { engine }] of pair.entries()) {
          const input = emptyInput();
          if (action === "cancel") input.attackHeld = "sweep";
          if (index === 1) {
            input.move = { x: 1, z: 0 };
            if (i === 0 && (action === "tap" || action === "charge"))
              input.attackPressed = "overhead";
            if (action === "charge") input.attackHeld = "overhead";
            input.step = i === 0 && action === "step";
            input.cancel = i === 0 && action === "cancel";
          }
          engine.update(DT, input);
        }
        const [one, two] = pair.map(({ engine, cpu }) => cpuInput(engine, cpu));
        expect(two).toEqual(one);
      }
      // First changed animation becomes visible to the CPU on precisely the next tick.
      for (const { engine } of pair) engine.update(DT);
      const firstPose = pair[1].cpu.aiMemory!.lastMode;
      expect(firstPose).toBe(action === "tap" ? "charge" : action);
      expect(firstPose).not.toBe(pair[0].cpu.aiMemory!.lastMode);
    }
  },
);

test.each(LEVELS)(
  "%s waits for observed spawn protection before withholding an attack",
  (level) => {
    const { engine, human, cpu } = duel(61, level);
    Object.assign(cpu, { x: 0, z: 0, aiThink: 99 });
    Object.assign(human, { x: 0, z: 2.8, invulnerable: 0 });
    const delay = AI_LEVELS[level].observationTicks;
    for (let i = 0; i <= delay; i++) think(engine, cpu);

    human.invulnerable = RULES.respawnInvulnerable;
    for (let i = 0; i <= delay; i++) {
      cpu.aiThink = 0;
      expect(think(engine, cpu).attackPressed).toBe(i < delay ? "thrust" : null);
    }
  },
);

test("hard punishes the observed dodge landing on either side and whiffs if that read is baited", () => {
  for (const side of [-1, 1]) {
    for (const evade of [false, true]) {
      const { engine, cpu, human } = duel(61, "hard");
      Object.assign(cpu, { x: 0, z: 0, facing: 0, aiThink: 10 });
      Object.assign(human, { x: 0, z: 1.15, facing: Math.PI });
      engine.update(DT, { ...emptyInput(), step: true, move: { x: side, z: 0 } });
      for (let i = 0; i <= AI_LEVELS.hard.observationTicks; i++) engine.update(DT);
      expect(cpu.mode).toBe("charge");
      expect(cpuInput(engine, cpu).aim!.x * side).toBeGreaterThan(0.75);
      for (let i = 0; i < 75 && cpu.mode !== "recovery"; i++) {
        engine.update(DT, {
          ...emptyInput(),
          move: { x: 0, z: evade ? 1 : 0 },
          step: evade && human.mode === "idle",
        });
      }
      expect(cpu.mode).toBe("recovery");
      expect(human.damage === 0).toBe(evade);
    }
  }
});

test.each(LEVELS)(
  "%s retains a rumble target through small spacing changes and drops a KO'd or protected rival",
  (level) => {
    const engine = new BattleEngine(61);
    engine.start("rumble", { difficulty: level });
    const [a, cpu, b, c] = engine.state.fighters;
    Object.assign(cpu, { x: 0, z: 0 });
    Object.assign(a, { x: 0, z: 2 });
    Object.assign(b, { x: 2.1, z: 0 });
    Object.assign(c, { x: 0, z: -1, mode: "dead", respawnTimer: 0.5 });
    function aimAt(x: number, z: number) {
      for (let i = 0; i <= AI_LEVELS[level].observationTicks; i++) {
        expect(think(engine, cpu).aim).toEqual({ x, z });
      }
    }
    aimAt(0, 1);
    b.x = 1.9;
    aimAt(0, 1);
    Object.assign(a, { mode: "dead", stocks: 0 });
    aimAt(1, 0);
    Object.assign(c, { mode: "idle", respawnTimer: 0, invulnerable: RULES.respawnInvulnerable });
    aimAt(1, 0);
    b.invulnerable = RULES.respawnInvulnerable;
    c.invulnerable = 0;
    aimAt(0, -1);
    c.invulnerable = RULES.respawnInvulnerable;
    // The same rival remains selected. Its new blink takes one observation delay to reach combat.
    for (let i = 0; i < AI_LEVELS[level].observationTicks; i++) think(engine, cpu);
    for (let i = 0; i < 60; i++) {
      const input = think(engine, cpu);
      expect(input.attackPressed).toBeNull();
      expect(input.grab).toBe(false);
    }
  },
);

test.each(LEVELS)("%s can use each cut, a charged release and a close grab", (level) => {
  const actions = new Set<AttackId | "grab" | "held">();
  for (let i = 0; i < 96; i++) {
    const { engine, cpu, human } = duel((i + 1) * 7919, level);
    Object.assign(cpu, { x: 0, z: 0 });
    Object.assign(human, { x: 0, z: [1, 2, 2.9, 2][i % 4], grounded: i % 4 !== 3 });
    for (let tick = 0; tick <= AI_LEVELS[level].observationTicks; tick++) {
      const input = think(engine, cpu);
      if (input.grab) actions.add("grab");
      if (input.attackPressed) {
        actions.add(input.attackPressed);
        if (cpu.aiCharge >= 0.4) actions.add("held");
      }
    }
  }
  expect(actions).toEqual(new Set(["sweep", "overhead", "rising", "thrust", "grab", "held"]));
  const { engine, cpu, human } = duel(61, level);
  Object.assign(cpu, {
    x: 0,
    z: 0,
    mode: "charge",
    modeTime: 0.22,
    attack: "sweep",
    aiCharge: 0.8,
  });
  Object.assign(human, { x: 5, z: 0 });
  for (let tick = 0; tick <= AI_LEVELS[level].observationTicks; tick++) engine.update(DT);
  expect(cpu.mode).toBe("cancel");
  expect(cpu.modeDuration).toBe(RULES.cancelDuration);
  for (let i = 1; i * DT < RULES.cancelDuration; i++) {
    engine.update(DT);
    expect(cpu.mode).toBe("cancel");
  }
});

test.each(LEVELS)("%s respects stamina, air-action and respawn limits", (level) => {
  const { engine, cpu, human } = duel(198, level, 3);
  Object.assign(cpu, { x: 0, z: 0, stamina: 4, staminaDelay: 2 });
  Object.assign(human, { x: 0, z: 2, facing: Math.PI });
  for (let i = 0; i < 35; i++) {
    engine.update(DT, {
      ...emptyInput(),
      attackPressed: i === 0 ? "sweep" : null,
      attackHeld: "sweep",
    });
    expect(cpu.mode).toBe("idle");
    expect(cpu.stamina).toBe(4);
  }
  Object.assign(cpu, {
    x: 10,
    z: 0,
    y: 1,
    grounded: false,
    stamina: 100,
    airRisingUsed: true,
    airThrustUsed: true,
    airStepUsed: true,
  });
  engine.update(DT);
  expect(cpu.mode).toBe("idle");
  expect(cpu.stamina).toBe(100);
  Object.assign(cpu, { mode: "dead", respawnTimer: DT });
  Object.assign(human, { mode: "dead", respawnTimer: DT });
  engine.update(DT);
  expect(cpu.invulnerable).toBeCloseTo(RULES.respawnInvulnerable - DT);
  expect(cpu.invulnerable).toBe(human.invulnerable);
  expect([cpu.airRisingUsed, cpu.airThrustUsed, cpu.airStepUsed]).toEqual([false, false, false]);
});

test.each(LEVELS)("%s reaches melee distance on all four stages without falling", (level) => {
  for (const stage of ["garden", "ruins", "bridges", "factory"] as const) {
    for (const seed of [61, 739, 7069]) {
      const engine = new BattleEngine(seed);
      engine.start("duel", { difficulty: level, stage });
      engine.state.phase = "playing";
      const [human, cpu] = engine.state.fighters;
      let reached = false;
      for (let i = 0; i < 600 && !reached; i++) {
        engine.update(DT);
        expect(cpu.mode).not.toBe("dead");
        expect(cpu.y).toBeGreaterThanOrEqual(-0.2);
        reached = Math.hypot(cpu.x - human.x, cpu.z - human.z) < 3;
      }
      expect(reached, stage).toBe(true);
    }
  }
});

test.each(LEVELS)("%s reads successive attacks from the same rival", (level) => {
  function secondSwing(first: AttackId) {
    let dodges = 0;
    for (let i = 0; i < 192; i++) {
      const { engine, human, cpu } = duel((i + 1) * 7919, level);
      Object.assign(cpu, { x: 0, z: 2, aiThink: 99 });
      // Learn the first strike out of reach. Bring the rival to the same spot and
      // feed the same second overhead in both runs, changing only the previous cut.
      Object.assign(human, {
        x: 0,
        z: -5,
        facing: 0,
        mode: "windup",
        attack: first,
        modeDuration: ATTACKS[first].startup,
      });
      const delay = AI_LEVELS[level].observationTicks;
      for (let tick = 0; tick <= delay; tick++) think(engine, cpu);
      Object.assign(human, { z: 0, mode: "idle", attack: null });
      for (let tick = 0; tick <= delay; tick++) think(engine, cpu);
      Object.assign(human, {
        mode: "windup",
        attack: "overhead",
        modeDuration: ATTACKS.overhead.startup,
      });
      for (let tick = 0; tick * DT < ATTACKS.overhead.startup; tick++) {
        human.modeTime = tick * DT;
        if (think(engine, cpu).step) {
          dodges++;
          break;
        }
      }
    }
    return dodges;
  }
  const repeat = secondSwing("overhead"),
    mixed = secondSwing("sweep");
  if (level === "hard") expect(repeat).toBeGreaterThan(mixed + 4);
  else expect(repeat).toBe(mixed);
});

test("hard cannot read the direction of a charge-cancel step before the dash moves", () => {
  const pair = [-1, 1].map((side) => {
    const { engine, cpu, human } = duel(61, "hard");
    Object.assign(cpu, { x: 0, z: 0, aiThink: 99 });
    Object.assign(human, { x: 0, z: 1.15, mode: "charge", attack: "sweep", facing: Math.PI });
    engine.update(DT, { ...emptyInput(), step: true, move: { x: side, z: 0 } });
    expect(human.stepDelay).toBe(RULES.feintStepDelay);
    return { engine, cpu, human };
  });
  // Identical poses until the feet move, then identical decisions through the observation delay.
  for (let i = 0; i < Math.ceil(RULES.feintStepDelay / DT) + AI_LEVELS.hard.observationTicks; i++) {
    for (const { engine } of pair) engine.update(DT);
    expect(cpuInput(pair[0].engine, pair[0].cpu)).toEqual(cpuInput(pair[1].engine, pair[1].cpu));
  }
  expect(pair[0].human.x).toBeLessThan(pair[1].human.x);
});
