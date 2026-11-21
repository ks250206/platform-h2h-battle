import { describe, expect, test } from "vite-plus/test";
import { BattleEngine, matchTimeLimit } from "../src/game/engine";
import type { ControlDevice, MatchOptions } from "../src/game/match";
import { RULES } from "../src/game/tuning";
import {
  emptyInput,
  type Fighter,
  type MatchMode,
  type PlayerInput,
  type PlayerInputs,
} from "../src/game/types";

const DT = 1 / 60;

type Controls = Partial<Record<number, ControlDevice>>;

function fixture(mode: MatchMode, controls: Controls, options: Partial<MatchOptions> = {}) {
  const engine = new BattleEngine(4242);
  engine.start(mode, { controls, ...options });
  engine.state.phase = "playing";
  return { engine, fighters: engine.state.fighters };
}

const press = (input: Partial<PlayerInput>): PlayerInput => ({ ...emptyInput(), ...input });
const walk = (x: number, z: number): PlayerInput => press({ move: { x, z } });
const at = (f: Fighter) => ({ x: f.x, z: f.z });

/** CPUs (and anyone else listed) frozen in place so only the rule under test moves anything. */
function freeze(fighters: Fighter[]) {
  for (const f of fighters) f.hitstop = 1e6;
}

/** Knocks `f` far below the floor; the next tick eliminates it. */
function drop(engine: BattleEngine, f: Fighter, input: PlayerInputs = {}) {
  Object.assign(f, { y: -20, vy: 0, grounded: false, hitstop: 0 });
  engine.update(DT, input);
}

function advance(engine: BattleEngine, seconds: number, input: PlayerInputs = {}) {
  for (let frame = 0; frame < Math.ceil(seconds / DT); frame++) engine.update(DT, input);
}

describe("who is human", () => {
  test.each([
    ["duel", { 0: "keyboard" }, [1, null]],
    ["duel", { 0: "keyboard", 1: "pad1" }, [1, 2]],
    ["duel", { 0: "pad2", 3: "keyboard" }, [1, null]],
    ["rumble", { 0: "keyboard" }, [1, null, null, null]],
    ["rumble", { 0: "keyboard", 2: "pad1", 3: "pad2" }, [1, null, 2, 3]],
    ["rumble", { 0: "pad3", 1: "keyboard", 2: "pad1", 3: "pad2" }, [1, 2, 3, 4]],
    ["rumble", { 1: "pad1" }, [1, 2, null, null]],
    ["training", { 0: "keyboard", 1: "pad1" }, [1, 2]],
    ["training", { 0: "keyboard", 2: "pad1", 3: "pad2" }, [1, null]],
  ] as [MatchMode, Controls, (number | null)[]][])(
    "%s with %j gives player numbers %j",
    (mode, controls, players) => {
      const { fighters } = fixture(mode, controls);
      expect(fighters.map((f) => f.player)).toEqual(players);
      expect(fighters.map((f) => f.human)).toEqual(players.map((p) => p !== null));
    },
  );
});

describe("several humans, one input each", () => {
  test("two humans move independently and CPUs keep acting on their own", () => {
    const { engine, fighters } = fixture("rumble", { 0: "keyboard", 1: "pad1" });
    const [walker, swinger, cpuA, cpuB] = fighters;
    const start = fighters.map(at);
    engine.update(DT, {
      0: walk(1, 0),
      1: press({ attackPressed: "overhead", attackHeld: "overhead" }),
    });
    expect(walker.mode).toBe("idle");
    expect(walker.x).toBeGreaterThan(start[0].x);
    expect(walker.stamina).toBe(RULES.maxStamina);
    expect(swinger.mode).toBe("charge");
    expect(swinger.attack).toBe("overhead");
    expect(at(swinger)).toEqual(start[1]);
    advance(engine, 0.15, { 0: walk(1, 0), 1: press({ attackHeld: "overhead" }) });
    expect(walker.x).toBeGreaterThan(start[0].x + 0.3);
    expect(walker.z).toBeCloseTo(start[0].z, 6);
    expect(swinger.mode).toBe("charge");
    expect(at(swinger)).toEqual(start[1]);
    // Nobody tells the CPUs what to do, yet they close in on someone.
    expect(at(cpuA)).not.toEqual(start[2]);
    expect(at(cpuB)).not.toEqual(start[3]);
  });

  test("a human missing from the map gets no input: it stands still instead of playing as a CPU", () => {
    const { engine, fighters } = fixture("rumble", { 0: "keyboard", 2: "pad1" });
    const [idle, , other] = fighters;
    const start = at(idle);
    advance(engine, 0.3, { 2: walk(0, 1) });
    expect(at(idle)).toEqual(start);
    expect(idle.mode).toBe("idle");
    expect(idle.aiThink).toBe(0);
    expect(other.z).toBeGreaterThan(0.3);
  });

  test("a bare input drives only the first human", () => {
    const { engine, fighters } = fixture("duel", { 0: "keyboard", 1: "pad1" });
    const [first, second] = fighters;
    const start = fighters.map(at);
    engine.update(DT, press({ move: { x: 0, z: 1 }, attackPressed: "sweep", attackHeld: "sweep" }));
    for (let frame = 0; frame < 12; frame++)
      engine.update(DT, press({ move: { x: 0, z: 1 }, attackHeld: "sweep" }));
    expect(first.mode).toBe("charge");
    expect(first.z).toBeGreaterThan(start[0].z);
    expect(second.mode).toBe("idle");
    expect(at(second)).toEqual(start[1]);
    expect(second.stamina).toBe(RULES.maxStamina);
  });

  test("each human's press waits for the next tick and is used once", () => {
    const { engine, fighters } = fixture("rumble", { 0: "keyboard", 3: "pad1" });
    freeze([fighters[1], fighters[2]]);
    const [swinger, , , dodger] = fighters;
    engine.update(DT / 2, {
      0: press({ attackPressed: "thrust", attackHeld: "thrust" }),
      3: press({ step: true, move: { x: 1, z: 0 } }),
    });
    expect(swinger.mode).toBe("idle");
    expect(dodger.mode).toBe("idle");
    engine.update(DT / 2, { 0: press({ attackHeld: "thrust" }) });
    expect(swinger.mode).toBe("charge");
    expect(dodger.mode).toBe("step");
    expect(engine.state.stats.dodges).toBe(1);
    // Later ticks do not replay either press.
    engine.update(DT, { 0: press({ attackHeld: "thrust" }) });
    engine.update(DT, { 0: press({ attackHeld: "thrust" }) });
    expect(swinger.mode).toBe("charge");
    expect(swinger.stamina).toBe(RULES.maxStamina - RULES.chargeCost);
    advance(engine, RULES.stepDuration + DT, { 0: press({ attackHeld: "thrust" }) });
    expect(dodger.mode).toBe("idle");
    expect(dodger.stamina).toBe(RULES.maxStamina - RULES.stepCost);
    expect(engine.state.stats.dodges).toBe(1);
  });

  test("the stamina warning is shown only when the match has a single human", () => {
    const warning = "スタミナ不足 — 歩いて間合いを取り直そう";
    const solo = fixture("duel", { 0: "keyboard" });
    solo.fighters[0].stamina = 0;
    solo.engine.update(DT, press({ step: true }));
    expect(solo.engine.state.message).toBe(warning);

    const pair = fixture("duel", { 0: "keyboard", 1: "pad1" });
    pair.fighters[0].stamina = 0;
    pair.fighters[1].stamina = 0;
    pair.engine.update(DT, { 0: press({ step: true }), 1: press({ step: true }) });
    expect(pair.engine.state.message).not.toBe(warning);
    expect(pair.fighters.map((f) => f.mode)).toEqual(["idle", "idle"]);
  });

  test("training says the partner stands still only when a CPU plays it", () => {
    const opening = (controls: Controls) => {
      const engine = new BattleEngine(4242);
      engine.start("training", { controls });
      for (let frame = 0; frame < 600 && engine.state.phase === "countdown"; frame++)
        engine.update(DT);
      expect(engine.state.phase).toBe("playing");
      return engine.state.message;
    };
    expect(opening({ 0: "keyboard" })).toBe("練習開始 — 相手は動きません");
    expect(opening({ 0: "keyboard", 1: "pad1" })).toBe("練習開始");
  });
});

describe("humans stay human", () => {
  test("through a knock-out and respawn", () => {
    const { engine, fighters } = fixture("rumble", { 0: "keyboard", 2: "pad1" }, { stocks: 3 });
    freeze([fighters[1], fighters[3]]);
    const second = fighters[2];
    drop(engine, second);
    expect(second.mode).toBe("dead");
    advance(engine, RULES.respawnDelay + DT);
    expect(second.mode).not.toBe("dead");
    expect(second.stocks).toBe(2);
    expect(second.human).toBe(true);
    expect(second.player).toBe(2);
    expect(fighters.map((f) => f.player)).toEqual([1, null, 2, null]);
    // And it still answers to its own input, not the first human's.
    const x = second.x;
    advance(engine, 1.2, { 2: walk(-1, 0) });
    expect(second.x).toBeLessThan(x);
  });

  test("through training's rebuild", () => {
    const { engine } = fixture("training", { 0: "keyboard", 1: "pad1" });
    drop(engine, engine.state.fighters[1]);
    expect(engine.state.fighters[1].mode).toBe("dead");
    advance(engine, 1.6);
    const rebuilt = engine.state.fighters[1];
    expect(rebuilt.mode).not.toBe("dead");
    expect(rebuilt.human).toBe(true);
    expect(rebuilt.player).toBe(2);
    const x = rebuilt.x;
    advance(engine, 0.2, { 1: walk(1, 0) });
    expect(rebuilt.x).toBeGreaterThan(x);
  });

  test("CPU difficulty overrides still apply to the CPU slots", () => {
    const { fighters } = fixture(
      "rumble",
      { 0: "keyboard", 2: "pad1" },
      { difficulty: "easy", overrides: { 1: "hard" } },
    );
    expect(fighters[1].human).toBe(false);
    expect(fighters[1].aiLevel).toBe("hard");
    expect(fighters[3].human).toBe(false);
    expect(fighters[3].aiLevel).toBe("easy");
  });
});

describe("outcome with two humans and a CPU", () => {
  /** A rumble whose fourth fighter is already out: humans 0 and 1, CPU 2. */
  function threeWay(stocks: number) {
    const { engine, fighters } = fixture("rumble", { 0: "keyboard", 1: "pad1" }, { stocks });
    Object.assign(fighters[3], { stocks: 0, mode: "dead" });
    freeze([fighters[2]]);
    return { engine, fighters };
  }

  test("the match goes on while a human and the CPU have lives; the last one standing wins", () => {
    const { engine, fighters } = threeWay(1);
    drop(engine, fighters[0]);
    expect(fighters[0].stocks).toBe(0);
    expect(engine.state.phase).toBe("playing");
    drop(engine, fighters[2]);
    expect(engine.state.phase).toBe("ended");
    expect(engine.state.winnerId).toBe(1);
    expect(engine.state.message).toBe(`${fighters[1].name} WINS`);
  });

  test("the CPU wins once both humans are out", () => {
    const { engine, fighters } = threeWay(1);
    drop(engine, fighters[0]);
    drop(engine, fighters[1]);
    expect(engine.state.phase).toBe("ended");
    expect(engine.state.winnerId).toBe(2);
  });

  test("at time-up more lives win, then less damage", () => {
    const { engine, fighters } = threeWay(2);
    fighters[0].stocks = 1;
    fighters[0].damage = 0;
    fighters[1].damage = 40;
    fighters[2].damage = 90;
    engine.state.elapsed = matchTimeLimit(2) - DT / 2;
    engine.update(DT, {});
    expect(engine.state.phase).toBe("ended");
    expect(engine.state.winnerId).toBe(1);
    expect(engine.state.message).toMatch(/^TIME UP/);
  });
});
