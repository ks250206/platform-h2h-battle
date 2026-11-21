import { afterEach, describe, expect, test } from "vite-plus/test";
import { BattleEngine } from "../src/game/engine";
import type { AiLevel } from "../src/game/match";
import { AI_LEVELS, ATTACKS, RULES, type AiProfile } from "../src/game/tuning";
import {
  emptyInput,
  type AttackId,
  type Fighter,
  type GameState,
  type MatchMode,
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

/** Temporarily changes a level's profile; restored after each test. */
const saved = new Map<AiLevel, AiProfile>();
function patchLevel(level: AiLevel, patch: Partial<AiProfile>) {
  if (!saved.has(level)) saved.set(level, { ...AI_LEVELS[level] });
  Object.assign(AI_LEVELS[level], patch);
}
afterEach(() => {
  for (const [level, profile] of saved) Object.assign(AI_LEVELS[level], profile);
  saved.clear();
});

describe("the difficulty table", () => {
  test("levels are ordered sensibly from easy to hard", () => {
    const [easy, normal, hard] = LEVELS.map((level) => AI_LEVELS[level]);
    const slowest = (p: AiProfile) => p.thinkMin + p.thinkRange;
    expect(easy.thinkMin).toBeGreaterThan(normal.thinkMin);
    expect(normal.thinkMin).toBeGreaterThan(hard.thinkMin);
    expect(slowest(easy)).toBeGreaterThan(slowest(normal));
    expect(slowest(normal)).toBeGreaterThan(slowest(hard));
    expect(easy.dodgeChance).toBeLessThan(normal.dodgeChance);
    expect(hard.dodgeWindow).toBeLessThan(normal.dodgeWindow);
    expect(normal.dodgeChance).toBeLessThan(hard.dodgeChance);
    expect(easy.chargeChance).toBe(0);
    expect(normal.chargeChance).toBeLessThan(hard.chargeChance);
    expect(easy.feintRange).toBe(0);
    expect(normal.feintRange).toBeLessThanOrEqual(hard.feintRange);
    expect(easy.attackStamina).toBeGreaterThan(normal.attackStamina);
    expect([easy.tracking, normal.tracking, hard.tracking]).toEqual([0, 0.5, 1]);
    expect(easy.bombNotice).toBeLessThan(normal.bombNotice);
    expect([easy.recoverRising, easy.recoverThrust, easy.recoverAirStep]).toEqual([
      true,
      false,
      false,
    ]);
    expect([hard.recoverRising, hard.recoverThrust, hard.recoverAirStep]).toEqual([
      true,
      true,
      true,
    ]);
    for (const flag of ["smartDodge", "cancelWhiffs", "punishRecovery", "aimedThrows"] as const) {
      expect([easy[flag], normal[flag], hard[flag]]).toEqual([false, false, true]);
    }
  });

  test("normal keeps the original CPU's numbers", () => {
    const normal = AI_LEVELS.normal;
    expect([normal.thinkMin, normal.thinkRange, normal.dodgeChance]).toEqual([0.18, 0.16, 0.7]);
    expect([normal.attackStamina, normal.chargeChance, normal.feintRange]).toEqual([30, 0.3, 2.4]);
    expect(normal.bombNotice).toBe(Number.POSITIVE_INFINITY);
    expect(normal.dodgeWindow).toBe(Number.POSITIVE_INFINITY);
  });

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
  /**
   * The human is already committed to an overhead at 2.2 units; the CPU's next decision falls at
   * a seeded point within one of its own think intervals. Did it step before the blade came out?
   */
  function dodges(level: AiLevel, trials: number): { rate: number; windupLeft: number[] } {
    const profile = AI_LEVELS[level];
    let dodged = 0;
    const windupLeft: number[] = [];
    for (let i = 0; i < trials; i++) {
      const { engine, human, cpu } = duel(1000 + i, level);
      Object.assign(human, { x: 0, z: 0, facing: 0 });
      Object.assign(cpu, {
        x: 0,
        z: 2.2,
        facing: Math.PI,
        aiThink: ((i % 25) / 25) * (profile.thinkMin + profile.thinkRange),
      });
      Object.assign(human, {
        mode: "windup",
        modeTime: 0,
        modeDuration: ATTACKS.overhead.startup,
        attack: "overhead",
        hitTargets: [],
        swingId: human.swingId + 1,
      });
      let stepped = false;
      for (let frame = 0; frame < (ATTACKS.overhead.startup + 0.1) / DT; frame++) {
        const left = human.mode === "windup" ? human.modeDuration - human.modeTime : 0;
        engine.update(DT, emptyInput());
        if (cpu.mode === "step" && !stepped) windupLeft.push(left);
        if (cpu.mode === "step") stepped = true;
      }
      if (stepped) dodged++;
    }
    return { rate: dodged / trials, windupLeft };
  }

  test("hard dodges a committed swing far more often than easy", () => {
    const easy = dodges("easy", 200).rate;
    const hard = dodges("hard", 200).rate;
    expect(hard).toBeGreaterThan(0.75);
    expect(easy).toBeLessThan(0.3);
    expect(hard).toBeGreaterThan(easy * 3);
  });

  test("hard holds its dodge for the late part of the wind-up, where tracking cannot follow it", () => {
    const hard = dodges("hard", 60).windupLeft;
    expect(hard.length).toBeGreaterThan(40);
    for (const left of hard) {
      expect(left).toBeLessThanOrEqual(AI_LEVELS.hard.dodgeWindow + 1e-9);
      expect(left).toBeGreaterThan(AI_LEVELS.hard.dodgeWindow - 2 * DT);
    }
    // Normal still reacts as soon as it notices, often early in the wind-up.
    const normal = dodges("normal", 60).windupLeft;
    expect(Math.max(...normal)).toBeGreaterThan(AI_LEVELS.hard.dodgeWindow + 0.1);
  });

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
          if (cpu.facing !== before.facing) turned++;
        }
      }
    }
    return { turned, windupFrames };
  }

  test("easy never turns during its wind-up; hard keeps tracking", () => {
    const easy = windupTurns("easy");
    const hard = windupTurns("hard");
    expect(easy.windupFrames).toBeGreaterThan(100);
    expect(easy.turned).toBe(0);
    expect(hard.windupFrames).toBeGreaterThan(50);
    expect(hard.turned).toBeGreaterThan(hard.windupFrames * 0.5);
  });
});

describe("normal reproduces the original CPU", () => {
  const ORDER: AttackId[] = ["overhead", "sweep", "thrust", "rising"];

  /** A deterministic opponent that never turns during its own wind-up and never air-dodges. */
  function scripted(state: GameState, tick: number): PlayerInput {
    const input = emptyInput();
    const me = state.fighters[0];
    const foes = state.fighters.filter((f) => f.id !== me.id && f.mode !== "dead");
    if (me.mode === "dead" || me.mode === "windup" || foes.length === 0) return input;
    const foe = foes.reduce((a, b) =>
      Math.hypot(a.x - me.x, a.z - me.z) <= Math.hypot(b.x - me.x, b.z - me.z) ? a : b,
    );
    const to = unit({ x: foe.x - me.x, z: foe.z - me.z });
    const distance = Math.hypot(foe.x - me.x, foe.z - me.z);
    const nearEdge = Math.max(Math.abs(me.x), Math.abs(me.z)) > state.arena.halfSize - 1.5;
    input.aim = to;
    input.move = nearEdge
      ? unit({ x: -me.x, z: -me.z })
      : distance > 2.6
        ? to
        : tick % 240 < 120
          ? { x: to.z, z: -to.x }
          : { x: -to.z, z: to.x };
    if (tick % 97 === 0 && me.mode === "idle" && me.grounded) {
      input.attackPressed = input.attackHeld = ORDER[Math.floor(tick / 97) % 4];
    }
    if (tick % 173 === 50 && me.mode === "idle" && me.grounded) input.step = true;
    if (tick % 211 === 100 && me.grounded) input.jump = true;
    return input;
  }

  /** FNV-1a over every fighter's state on every tick, until the match ends. */
  function fingerprint(seed: number, mode: MatchMode): string {
    const engine = new BattleEngine(seed);
    engine.start(mode, { stocks: 1, difficulty: "normal", overrides: {} });
    engine.state.phase = "playing" as GameState["phase"];
    let hash = 0x811c9dc5;
    let tick = 0;
    for (; tick < 400 / DT && engine.state.phase !== "ended"; tick++) {
      engine.update(DT, scripted(engine.state, tick));
      for (const f of engine.state.fighters) {
        const text = `${f.mode}${f.attack}${f.x}${f.y}${f.z}${f.facing}${f.damage}${f.stamina}${f.grounded}|`;
        for (let i = 0; i < text.length; i++)
          hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0;
      }
    }
    return `${tick}:${hash.toString(16)}`;
  }

  /**
   * Recorded with the engine as it was before difficulty levels, wind-up tracking, the air dodge
   * and stocks existed (commit c0a9581), running this exact scenario: about 285 simulated seconds.
   * Seeds 13 (duel) and 22 (rumble) are left out on purpose: in them an airborne CPU decides to
   * dodge, which the old engine ignored except that the step press froze its facing for that one
   * tick; the CPU now simply does not press step in the air (no air dodge outside recovery), so it
   * turns on that tick and the runs part ways. With that one-tick quirk patched out of the old
   * engine, those seeds match bit for bit as well.
   */
  const RECORDED: [number, MatchMode, string][] = [
    [11, "duel", "2016:ebe7ef34"],
    [12, "duel", "1692:ac355f86"],
    [14, "duel", "1995:e0952d74"],
    [15, "duel", "913:6e2ff67a"],
    [16, "duel", "1746:e592ac0"],
    [21, "rumble", "3011:6d8460d1"],
    [23, "rumble", "3292:babbfa0b"],
    [24, "rumble", "2437:2bfa7dd"],
  ];

  test("with tracking at 0 and no air dodge, normal replays the old decisions bit for bit", () => {
    patchLevel("normal", { tracking: 0, recoverAirStep: false });
    for (const [seed, mode, recorded] of RECORDED) expect(fingerprint(seed, mode)).toBe(recorded);
  });

  test("with its real settings normal does play differently (the check above is not vacuous)", () => {
    const changed = RECORDED.filter(
      ([seed, mode, recorded]) => fingerprint(seed, mode) !== recorded,
    );
    expect(changed.length).toBeGreaterThan(0);
  });
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
