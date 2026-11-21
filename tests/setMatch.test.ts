import { describe, expect, test, vi } from "vite-plus/test";
import { BattleEngine } from "../src/game/engine";
import { BUTTON, type PadSnapshot } from "../src/game/gamepad";
import { BattleInput } from "../src/game/input";
import { DEFAULT_MATCH_OPTIONS, type MatchOptions } from "../src/game/match";
import { createMatchStore } from "../src/game/matchStore";
import { formatAccuracy, MatchStats } from "../src/game/matchStats";
import { PadHub } from "../src/game/pads";
import { finishSetGame } from "../src/game/setMatch";
import { ATTACKS, RULES } from "../src/game/tuning";
import { emptyInput, type Fighter, type MatchMode } from "../src/game/types";

const DT = RULES.fixedStep;
const NO_GIMMICKS = { collapse: false, safeZone: false, bombs: false, wind: false };

function fight(mode: MatchMode = "duel", options: Partial<MatchOptions> = {}) {
  const engine = new BattleEngine(777);
  engine.start(mode, { stocks: 1, gimmicks: NO_GIMMICKS, ...options });
  engine.state.phase = "playing";
  for (const cpu of engine.state.fighters.filter((f) => !f.human)) cpu.hitstop = 1e6;
  return engine;
}

function tick(engine: BattleEngine, frames = 1) {
  for (let i = 0; i < frames; i++) engine.update(DT, emptyInput());
}

function drop(fighter: Fighter) {
  Object.assign(fighter, { y: -20, vy: 0, grounded: false, hitstop: 0 });
}

function win(engine: BattleEngine, winner: number) {
  engine.state.phase = "playing";
  for (const f of engine.state.fighters) if (f.id !== winner) drop(f);
  tick(engine);
  expect(engine.state.winnerId).toBe(winner);
}

function at(fighter: Fighter, x: number, z: number, facing = 0) {
  Object.assign(fighter, { x, y: 0, z, facing, grounded: true });
}

/** The next tick runs the real windup-to-active transition. */
function ready(fighter: Fighter, attack: "sweep" | "overhead" = "sweep") {
  Object.assign(fighter, {
    mode: "windup",
    modeTime: ATTACKS[attack].startup - DT / 2,
    modeDuration: ATTACKS[attack].startup,
    attack,
    charge: 0,
    hitTargets: [],
    hitstop: 0,
    swingId: fighter.swingId + 1,
  });
}

function bomb(engine: BattleEngine, x: number, z: number) {
  engine.state.bombs.push({
    id: engine.state.bombs.length,
    x,
    z,
    radius: 1.45,
    timer: DT / 2,
    duration: 1,
    exploded: false,
  });
}

describe("set play", () => {
  test.each([
    { format: "bo3", sequence: [0, 0], score: [2, 0], target: 2 },
    { format: "bo3", sequence: [1, 0, 0], score: [2, 1], target: 2 },
    { format: "bo5", sequence: [0, 1, 1, 0, 1], score: [2, 3], target: 3 },
  ] as const)("$format stops exactly at $score", ({ format, sequence, score, target }) => {
    const engine = fight("duel", { setFormat: format, controls: { 0: "keyboard", 1: "pad1" } });
    sequence.forEach((winner, index) => {
      expect(engine.state.set).toMatchObject({ gameNumber: index + 1, winsNeeded: target });
      win(engine, winner);
      const result = engine.state.set;
      expect(finishSetGame(result!, winner, engine.state.playerStats)).toBe(result);
      tick(engine, 30);
      expect(engine.state.set).toEqual(result);
      expect(engine.nextSetGame()).toBe(index < sequence.length - 1);
    });
    expect(engine.state.phase).toBe("ended");
    expect(engine.state.set).toMatchObject({ wins: score, winnerId: sequence.at(-1) });
  });

  test("time-up ties and simultaneous ring-outs preserve the score and required wins", () => {
    const engine = fight("duel", { setFormat: "bo3" });
    win(engine, 0);
    expect(engine.nextSetGame()).toBe(true);
    engine.state.phase = "playing";
    engine.state.elapsed = engine.state.rules.timeLimit!;
    tick(engine);
    expect(engine.state.winnerId).toBeNull();
    expect(engine.state.drawReason).toBe("timeUp");
    expect(engine.state.set).toMatchObject({ wins: [1, 0], winsNeeded: 2 });
    expect(engine.nextSetGame()).toBe(true);
    engine.state.phase = "playing";
    engine.state.fighters.forEach(drop);
    tick(engine);
    expect(engine.state.drawReason).toBe("allOut");
    expect(engine.state.set).toMatchObject({ gameNumber: 3, wins: [1, 0], winsNeeded: 2 });
    expect(engine.nextSetGame()).toBe(true);
    win(engine, 0);
    expect(engine.nextSetGame()).toBe(false);
  });

  test("the next game clears combat and arena state while retaining both players and rules", () => {
    const engine = fight("duel", {
      setFormat: "bo3",
      controls: { 0: "pad1", 1: "keyboard" },
      stage: "ruins",
      time: "short",
      loadouts: [...DEFAULT_MATCH_OPTIONS.loadouts].reverse(),
    });
    expect(engine.nextSetGame()).toBe(false);
    const { options, rules } = engine.state;
    const resetArena = structuredClone(engine.state.arena);
    const [player, opponent] = engine.state.fighters;
    at(player, 0, 0);
    at(opponent, 0, 1.2);
    ready(player);
    tick(engine);
    expect(engine.state.playerStats[0].damageDealt).toBe(ATTACKS.sweep.damage);
    Object.assign(player, { damage: 15, stamina: 12, outsideTime: 4 });
    engine.state.arena.halfSize = 4;
    engine.state.arena.warningRing = true;
    bomb(engine, 7, 7);
    win(engine, 0);
    expect(engine.state.effects.length).toBeGreaterThan(0);
    expect(engine.nextSetGame()).toBe(true);
    expect(engine.state).toMatchObject({
      phase: "countdown",
      elapsed: 0,
      arena: resetArena,
      options,
      rules,
      bombs: [],
      effects: [],
      set: { gameNumber: 2, wins: [1, 0], totals: [{ damageDealt: ATTACKS.sweep.damage }, {}] },
    });
    expect(
      engine.state.fighters.map((f) => [f.damage, f.stocks, f.stamina, f.outsideTime]),
    ).toEqual([
      [0, 1, RULES.maxStamina, 0],
      [0, 1, RULES.maxStamina, 0],
    ]);
    expect(engine.state.playerStats[0].damageDealt).toBe(0);
    win(engine, 0);
    expect(engine.state.set?.totals[0]).toMatchObject({
      damageDealt: ATTACKS.sweep.damage,
      kos: 1,
    });
    engine.start("duel");
    expect(engine.state.set).toMatchObject({ gameNumber: 1, wins: [0, 0], winnerId: null });
    expect(engine.state.options).toEqual(options);
  });

  test("pausing and resuming a game preserves the set and awards no win", () => {
    const engine = fight("duel", { setFormat: "bo5", controls: { 0: "keyboard", 1: "pad1" } });
    win(engine, 1);
    engine.nextSetGame();
    const set = structuredClone(engine.state.set);
    engine.pause();
    expect(engine.state.phase).toBe("paused");
    tick(engine, 240);
    expect(engine.state.set).toEqual(set);
    expect(engine.state.options.controls).toEqual({ 0: "keyboard", 1: "pad1" });
    engine.resume();
    expect(engine.state.phase).toBe("countdown");
    expect(engine.state.set).toEqual(set);
  });

  test("leaving a running or finished game discards the set before a new line-up starts", () => {
    const engine = fight("duel", { setFormat: "bo3" });
    win(engine, 0);
    engine.nextSetGame();
    engine.menu("duel");
    expect(engine.state.set).toBeNull();
    expect(engine.nextSetGame()).toBe(false);
    engine.start("duel", {
      controls: { 0: "pad1", 1: "keyboard" },
      time: "short",
      stage: "factory",
    });
    expect(engine.state.set).toMatchObject({ gameNumber: 1, wins: [0, 0] });
    expect(engine.state.options.controls).toEqual({ 0: "pad1", 1: "keyboard" });
    win(engine, 1);
    engine.menu("rumble");
    expect(engine.state.set).toBeNull();
    engine.start("duel");
    expect(engine.state.set).toMatchObject({ gameNumber: 1, wins: [0, 0] });
  });

  test.each(["rumble", "training"] as const)("%s enforces single games", (mode) => {
    const engine = fight(mode, { setFormat: "bo5" });
    expect(engine.state.options.setFormat).toBe("single");
    expect(engine.state.set).toBeNull();
    expect(engine.nextSetGame()).toBe(false);
  });

  test("the store remembers set format and safely defaults legacy or unknown values", () => {
    let stored = JSON.stringify({ stocks: 2 });
    const storage = {
      getItem: () => stored,
      setItem: (_key: string, value: string) => {
        stored = value;
      },
    };
    const store = createMatchStore(storage);
    expect(store.get().setFormat).toBe("single");
    store.set({ setFormat: "bo5" });
    store.preset("short");
    expect(createMatchStore(storage).get().setFormat).toBe("bo5");
    store.set({ setFormat: "unknown" as never });
    expect(createMatchStore(storage).get().setFormat).toBe("single");
  });

  test("Next Game consumes held A and Start until the pad player presses them again", () => {
    const element = Object.assign(new EventTarget(), {
      append() {},
      remove() {},
      querySelector: (): EventTarget => element,
      querySelectorAll: () => [],
      style: { transform: "" },
    });
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("document", {
      createElement: () => element,
      getElementById: () => element,
      querySelector: () => null,
    });
    try {
      const pads = new PadHub();
      const released: PadSnapshot = { axes: [], buttons: [] };
      const held: PadSnapshot = {
        axes: [],
        buttons: Array.from({ length: BUTTON.START + 1 }, (_, i) => {
          const pressed = i === BUTTON.A || i === BUTTON.START;
          return { pressed, value: Number(pressed) };
        }),
      };
      const engine = fight("duel", { setFormat: "bo3", controls: { 0: "pad1" } });
      const onPause = vi.fn(() => engine.pause());
      const input = new BattleInput(element as unknown as HTMLCanvasElement, pads, {
        toWorld: () => null,
        onPause,
        onGesture() {},
        onCameraToggle() {},
        onPadLost() {},
        rumble: () => false,
      });
      const sample = () => {
        input.updateVisibility(engine.state);
        return input.sample(engine.state);
      };

      pads.current[0] = released;
      sample();
      win(engine, 0);
      pads.current[0] = held;
      expect(sample()).toEqual({});

      expect(engine.nextSetGame()).toBe(true);
      input.reset();
      input.newMatch();
      expect(engine.state.phase).toBe("countdown");
      expect(sample()[0]?.jump).toBe(false);
      for (let i = Math.ceil(engine.state.countdown / DT) + 1; i > 0; i--) {
        engine.update(DT, sample());
      }
      expect(engine.state.phase).toBe("playing");
      expect(sample()[0]?.jump).toBe(false);
      expect(onPause).not.toHaveBeenCalled();

      pads.current[0] = released;
      sample();
      pads.current[0] = held;
      expect(sample()[0]?.jump).toBe(true);
      expect(onPause).toHaveBeenCalledTimes(1);
      expect(engine.state.phase).toBe("paused");
      input.destroy();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("per-player match stats", () => {
  test.each(["duel", "rumble"] as const)(
    "%s counts damage per target and one landed swing",
    (mode) => {
      const engine = fight(mode);
      expect(engine.state.set).toBeNull();
      const [a, b, c, d] = engine.state.fighters;
      at(a, 0, 0);
      at(b, -0.7, 1.2);
      if (c) at(c, 0.7, 1.2);
      if (d) at(d, 0, -2);
      ready(a);
      tick(engine, 2);
      const stats = engine.state.playerStats;
      expect(stats).toHaveLength(mode === "duel" ? 2 : 4);
      expect(stats[0]).toMatchObject({
        damageDealt: ATTACKS.sweep.damage * (mode === "duel" ? 1 : 2),
        damageTaken: 0,
        swings: 1,
        landedSwings: 1,
      });
      expect(stats[1].damageTaken).toBe(ATTACKS.sweep.damage);
      expect(formatAccuracy(stats[0])).toBe("100%");
      if (c && d) {
        expect(stats[2].damageTaken).toBe(ATTACKS.sweep.damage);
        expect(stats[3].damageTaken).toBe(0);
      }
    },
  );

  test("cancelled charges and windups leave the accuracy denominator at zero", () => {
    const engine = fight();
    const [a] = engine.state.fighters;
    engine.update(DT, { ...emptyInput(), attackPressed: "sweep" });
    expect(a.mode).toBe("charge");
    engine.update(DT, { ...emptyInput(), cancel: true });
    expect(a.mode).toBe("cancel");
    tick(engine, 20);
    engine.update(DT, { ...emptyInput(), attackPressed: "sweep" });
    tick(engine);
    expect(a.mode).toBe("windup");
    engine.update(DT, { ...emptyInput(), cancel: true });
    expect(a.mode).toBe("cancel");
    tick(engine, 60);
    expect(engine.state.playerStats[0]).toMatchObject({ swings: 0, landedSwings: 0 });
    expect(formatAccuracy(engine.state.playerStats[0])).toBe("—");
  });

  test("clashing swings each count once, with no hit for the clash", () => {
    const engine = fight();
    const [a, b] = engine.state.fighters;
    at(a, 0, -1, 0);
    at(b, 0, 1, Math.PI);
    ready(a);
    ready(b);
    tick(engine);
    expect(engine.state.stats.clashes).toBe(1);
    expect(engine.state.playerStats).toMatchObject([
      { swings: 1, landedSwings: 0, damageDealt: 0 },
      { swings: 1, landedSwings: 0, damageDealt: 0 },
    ]);
    expect(formatAccuracy(engine.state.playerStats[0])).toBe("0%");
  });

  test("a recent throw credits damage and a KO without counting as a sword swing", () => {
    const engine = fight();
    const [a, b] = engine.state.fighters;
    at(a, 0, 0);
    at(b, 0, 0.95);
    engine.update(DT, { ...emptyInput(), grab: true });
    tick(engine, Math.ceil((RULES.grabStartup + RULES.grabHold) / DT) + 4);
    drop(b);
    tick(engine);
    expect(engine.state.playerStats).toMatchObject([
      { damageDealt: 6, kos: 1, swings: 0 },
      { damageTaken: 6, stocksLost: 1, opponentLosses: 1, environmentLosses: 0 },
    ]);
  });

  test("a hit at elapsed zero credits a subsequent ring-out to the attacker", () => {
    const engine = fight();
    const [attacker, target] = engine.state.fighters;
    const stats = new MatchStats(engine.state.playerStats);
    stats.recordLaunch(target, attacker.id, engine.state.elapsed);
    drop(target);
    tick(engine);
    expect(engine.state.playerStats).toMatchObject([
      { kos: 1 },
      { stocksLost: 1, opponentLosses: 1, environmentLosses: 0 },
    ]);
  });

  test("bombs, expired hits and untouched fighters produce environmental losses in a rumble", () => {
    const engine = fight("rumble");
    const [a, b, c, d] = engine.state.fighters;
    at(a, 0, 0);
    at(b, -0.7, 1.2);
    at(c, 0.7, 1.2);
    at(d, 7, 7);
    ready(a);
    tick(engine);
    bomb(engine, b.x - 0.4, b.z);
    tick(engine);
    expect(engine.state.playerStats[1].damageTaken).toBe(ATTACKS.sweep.damage + 10);
    drop(b);
    drop(d);
    tick(engine);
    c.hitstop = 1e6;
    tick(engine, 241);
    drop(c);
    tick(engine);
    expect(engine.state.playerStats.map((row) => row.kos)).toEqual([0, 0, 0, 0]);
    expect(engine.state.playerStats.slice(1)).toMatchObject([
      { stocksLost: 1, opponentLosses: 0, environmentLosses: 1 },
      { stocksLost: 1, opponentLosses: 0, environmentLosses: 1 },
      { stocksLost: 1, opponentLosses: 0, environmentLosses: 1 },
    ]);
  });

  test("same-tick strikes from different players credit their damage but leave the fall unattributed", () => {
    const engine = fight("rumble");
    const [a, b, c, d] = engine.state.fighters;
    at(a, -0.9, 0);
    at(b, 0.9, 0);
    at(c, 0, 1.2);
    at(d, 7, 7);
    ready(a, "overhead");
    ready(b, "overhead");
    tick(engine);
    expect(engine.state.stats.clashes).toBe(0);
    expect(engine.state.playerStats[2].damageTaken).toBe(2 * ATTACKS.overhead.damage);
    drop(c);
    tick(engine);
    expect(engine.state.playerStats.slice(0, 3)).toMatchObject([
      { damageDealt: ATTACKS.overhead.damage, landedSwings: 1, kos: 0 },
      { damageDealt: ATTACKS.overhead.damage, landedSwings: 1, kos: 0 },
      { stocksLost: 1, opponentLosses: 0, environmentLosses: 1 },
    ]);
  });

  test("the safe zone deals environmental damage and can defeat a recently hit fighter", () => {
    const engine = fight("duel", { gimmicks: { ...NO_GIMMICKS, safeZone: true } });
    const [a, b] = engine.state.fighters;
    engine.state.elapsed = RULES.safeZoneStart + 1;
    at(a, 0, 0);
    at(b, 0, 1.2);
    ready(a);
    tick(engine);
    at(b, 22, 0);
    b.outsideTime = RULES.outsideLimit - DT / 2;
    tick(engine);
    expect(engine.state.playerStats[0]).toMatchObject({
      damageDealt: ATTACKS.sweep.damage,
      kos: 0,
    });
    expect(engine.state.playerStats[1].damageTaken).toBeCloseTo(
      ATTACKS.sweep.damage + RULES.outsideDamage * (DT / 2),
      10,
    );
    expect(engine.state.playerStats[1].environmentLosses).toBe(1);
  });

  test("stock loss attribution is cleared on respawn", () => {
    const engine = fight("duel", { stocks: 2 });
    const [a, b] = engine.state.fighters;
    at(a, 0, 0);
    at(b, 0, 1.2);
    ready(a);
    tick(engine);
    drop(b);
    tick(engine);
    while (b.respawnTimer > 0) tick(engine);
    expect(b.lastAttacker).toBeNull();
    drop(b);
    tick(engine);
    expect(engine.state.playerStats[0].kos).toBe(1);
    expect(engine.state.playerStats[1]).toMatchObject({
      stocksLost: 2,
      opponentLosses: 1,
      environmentLosses: 1,
    });
  });

  test("an overlapping sword swing and in-range bomb count once each during step i-frames", () => {
    const engine = fight();
    const [a, b] = engine.state.fighters;
    at(a, 0, 0);
    at(b, 0, -1.1);
    engine.update(DT, { ...emptyInput(), step: true });
    expect(a.mode).toBe("step");
    expect(engine.state.playerStats[0].dodges).toBe(0);
    a.modeTime = RULES.stepInvulStart;
    a.stepDirection = { x: 0, z: 0 };
    ready(b);
    bomb(engine, 0, 0);
    bomb(engine, 6, 6);
    tick(engine, 5);
    expect(engine.state.playerStats[0]).toMatchObject({ damageTaken: 0, dodges: 2 });
    expect(engine.state.playerStats[1]).toMatchObject({ swings: 1, landedSwings: 0 });
  });

  test("a sword hit cancels dodge credit when step invulnerability ends during the same swing", () => {
    const engine = fight();
    const [target, attacker] = engine.state.fighters;
    at(target, 0, 0);
    at(attacker, 0, -1.1);
    engine.update(DT, { ...emptyInput(), step: true });
    target.modeTime = RULES.stepInvulEnd - DT * 1.5;
    target.stepDirection = { x: 0, z: 0 };
    ready(attacker);

    tick(engine);
    expect(engine.state.playerStats[0]).toMatchObject({ damageTaken: 0, dodges: 1 });
    tick(engine);
    expect(engine.state.playerStats[0]).toMatchObject({
      damageTaken: ATTACKS.sweep.damage,
      dodges: 0,
    });
    expect(engine.state.playerStats[1]).toMatchObject({ swings: 1, landedSwings: 1 });
  });

  test("timed protection during a step is not credited as a successful dodge", () => {
    const engine = fight();
    const [a, b] = engine.state.fighters;
    at(a, 0, 0);
    at(b, 0, -1.1);
    Object.assign(a, {
      mode: "step",
      modeTime: RULES.stepInvulStart,
      modeDuration: RULES.stepDuration,
      invulnerable: 1,
    });
    ready(b);
    bomb(engine, 0, 0);
    tick(engine, 2);
    expect(engine.state.playerStats[0]).toMatchObject({ damageTaken: 0, dodges: 0 });
  });
});
