import { describe, expect, test, vi } from "vite-plus/test";
import { BattleEngine } from "../src/game/engine";
import { LADDER_ROUNDS, LadderSession, ladderMatchOptions } from "../src/game/ladder";
import { DEFAULT_MATCH_OPTIONS, copyMatchOptions } from "../src/game/match";
import { createMatchStore, playableOptions } from "../src/game/matchStore";
import { STAGES } from "../src/game/stages";
import { RULES } from "../src/game/tuning";
import { emptyInput } from "../src/game/types";
import { GameUI } from "../src/ui/GameUI";

const newRun = () => new LadderSession(DEFAULT_MATCH_OPTIONS);

describe("CPU ladder", () => {
  test("clears after four distinct opponents and starts a fresh run with zero totals", () => {
    const run = newRun();
    expect(LADDER_ROUNDS.map(({ stage, difficulty }) => [stage, difficulty])).toEqual([
      ["garden", "easy"],
      ["ruins", "normal"],
      ["factory", "normal"],
      ["bridges", "hard"],
    ]);
    expect(new Set(LADDER_ROUNDS.map(({ loadout }) => loadout.species)).size).toBe(4);
    run.finish(run.startAttempt()!.id, 1, 15);
    run.finish(run.startAttempt()!.id, null, 21);

    for (const [index, opponent] of LADDER_ROUNDS.entries()) {
      const attempt = run.startAttempt()!;
      expect(run.progress).toMatchObject({
        round: index + 1,
        phase: "playing",
        opponent,
        nextOpponent: null,
      });
      expect(attempt.options).toMatchObject({
        stage: opponent.stage,
        difficulty: opponent.difficulty,
      });
      expect(attempt.options.loadouts[1]).toEqual(opponent.loadout);
      expect(run.finish(attempt.id, 0, 30 + index)).toBe(true);
      expect(run.progress).toMatchObject({
        round: index + 1,
        phase: index === 3 ? "clear" : "result",
        outcome: "win",
        nextOpponent: LADDER_ROUNDS[index + 1] ?? null,
      });
    }
    expect(run.progress.totals).toEqual({
      wins: 4,
      losses: 1,
      draws: 1,
      retries: 2,
      elapsed: 162,
    });
    const cleared = run.progress;
    expect(run.startAttempt()).toBeNull();
    expect(run.progress).toEqual(cleared);

    const fresh = newRun();
    const attempt = fresh.startAttempt()!;
    expect(fresh.progress).toMatchObject({
      round: 1,
      phase: "playing",
      outcome: null,
      totals: { wins: 0, losses: 0, draws: 0, retries: 0, elapsed: 0 },
    });
    expect(attempt.options.stage).toBe("garden");
  });

  test("records a loss then retries the same opponent and advances after a win", () => {
    const run = newRun();
    const first = run.startAttempt()!;
    run.finish(first.id, 0, 31);
    const second = run.startAttempt()!;
    run.finish(second.id, 1, 55);
    expect(run.progress).toMatchObject({
      round: 2,
      phase: "result",
      outcome: "loss",
      nextOpponent: null,
      totals: { wins: 1, losses: 1, draws: 0, retries: 0, elapsed: 86 },
    });

    const retry = run.startAttempt()!;
    expect(retry.options).toEqual(second.options);
    expect(run.progress.totals.retries).toBe(1);
    run.finish(retry.id, 0, 25);
    expect(run.startAttempt()!.options.stage).toBe("factory");
    expect(run.progress.totals).toEqual({
      wins: 2,
      losses: 1,
      draws: 0,
      retries: 1,
      elapsed: 111,
    });
  });

  test("a real duel time-up draw counts once and retries the same round", () => {
    const run = newRun();
    const attempt = run.startAttempt()!;
    const engine = new BattleEngine(1);
    engine.start("duel", attempt.options);
    engine.state.phase = "playing";
    engine.state.elapsed = engine.state.rules.timeLimit!;
    engine.update(1 / 60, emptyInput());
    expect(engine.state.phase).toBe("ended");
    expect(engine.state.winnerId).toBeNull();
    run.finish(attempt.id, engine.state.winnerId, engine.state.elapsed);
    expect(run.progress).toMatchObject({
      phase: "result",
      round: 1,
      outcome: "draw",
      nextOpponent: null,
      totals: { wins: 0, losses: 0, draws: 1, retries: 0 },
    });
    expect(run.startAttempt()!.options).toEqual(attempt.options);
    expect(run.progress).toMatchObject({ round: 1, totals: { retries: 1 } });
  });

  test.each([0, 1])("shows the engine's time-up reason with a stock lead of %i", (lead) => {
    const run = newRun();
    const attempt = run.startAttempt()!;
    const engine = new BattleEngine(1);
    engine.start("duel", attempt.options);
    engine.state.phase = "playing";
    engine.state.fighters[1].stocks -= lead;
    engine.state.elapsed = engine.state.rules.timeLimit!;
    engine.update(1 / 60, emptyInput());
    expect(engine.state.message).toMatch(/^TIME UP/);
    expect(engine.state.winnerId).toBe(lead === 0 ? null : 0);
    run.finish(attempt.id, engine.state.winnerId, engine.state.elapsed);

    const element = () => ({
      classList: { toggle: vi.fn() },
      children: [{}, {}, {}],
      dataset: {},
      querySelector: () => ({}),
      setAttribute: vi.fn(),
    });
    const subtitle = { textContent: "" };
    const ui: GameUI = Object.assign(Object.create(GameUI.prototype), {
      currentPhase: "playing",
      host: {
        dataset: {},
        querySelector: (selector: string) => (selector === ".result-subtitle" ? subtitle : element()),
      },
      menu: element(),
      hud: element(),
      result: element(),
      pausePanel: element(),
      dialog: { open: true },
      cards: new Map(),
      locks: [],
    });
    // The result panel doesn't need fighter HUD cards.
    ui.update({ ...engine.state, fighters: [] }, run.progress);
    expect(subtitle.textContent).toContain("第1戦 / 全4戦 · 庭園の見習い");
    expect(subtitle.textContent).toContain(engine.state.message);
    if (lead === 0) expect(subtitle.textContent).toContain("この戦を同じ相手と再戦");
  });

  test.each([-10, 0])(
    "a duel lasting %i seconds leaves the total elapsed time unchanged",
    (elapsed) => {
      const run = newRun();
      run.finish(run.startAttempt()!.id, 0, 15);
      expect(run.finish(run.startAttempt()!.id, 1, elapsed)).toBe(true);
      expect(run.progress.totals.elapsed).toBe(15);
    },
  );

  test("the final opponent has no next opponent on a retry or on clear", () => {
    const run = newRun();
    for (let round = 1; round < LADDER_ROUNDS.length; round++) {
      run.finish(run.startAttempt()!.id, 0, 10);
    }
    const finalOpponent = LADDER_ROUNDS.at(-1);
    run.finish(run.startAttempt()!.id, null, 10);
    expect(run.progress).toMatchObject({
      phase: "result",
      outcome: "draw",
      opponent: finalOpponent,
      nextOpponent: null,
    });
    run.finish(run.startAttempt()!.id, 0, 10);
    expect(run.progress).toMatchObject({
      phase: "clear",
      opponent: finalOpponent,
      nextOpponent: null,
    });
  });

  test("rejects overlapping starts, repeat finishes and stale finishes after advancing", () => {
    const run = newRun();
    const first = run.startAttempt()!;
    expect(run.startAttempt()).toBeNull();
    expect(run.finish(first.id, 0, 32)).toBe(true);
    expect(run.finish(first.id, 0, 99)).toBe(false);
    const second = run.startAttempt()!;
    expect(run.finish(first.id, 0, 99)).toBe(false);
    expect(run.progress).toMatchObject({
      round: 2,
      phase: "playing",
      outcome: null,
      totals: { wins: 1, elapsed: 32 },
    });
    expect(run.finish(second.id, 0, 10)).toBe(true);
    const fresh = newRun();
    fresh.startAttempt();
    expect(fresh.finish(first.id, 0, 99)).toBe(false);
  });

  test("exiting mid-run closes the session without clearing or recording a late result", () => {
    const run = newRun();
    run.finish(run.startAttempt()!.id, 0, 27);
    const second = run.startAttempt()!;
    run.exit();
    expect(run.finish(second.id, 0, 25)).toBe(false);
    const exited = run.progress;
    expect(run.startAttempt()).toBeNull();
    expect(run.progress).toEqual(exited);
    expect(run.progress).toMatchObject({
      round: 2,
      phase: "exited",
      totals: { wins: 1, elapsed: 27 },
    });
  });

  test("resolves only slot 0 and keeps its look and preferred device without touching the store", () => {
    const setItem = vi.fn();
    const store = createMatchStore({ getItem: () => null, setItem });
    store.set({
      controls: { 0: "pad4", 1: "keyboard", 2: "pad1", 3: "pad2" },
      difficulty: "hard",
      overrides: { 1: "hard", 2: "easy" },
      stage: "bridges",
      stocks: 1,
      time: "short",
    });
    store.setLoadout(0, { species: "bear", palette: "berry", accessory: "beret" });
    const saved = store.get();
    const run = new LadderSession(saved);
    const first = run.startAttempt()!;
    expect(first.options).toEqual(ladderMatchOptions(saved, LADDER_ROUNDS[0]));
    expect(first.options).toMatchObject({
      controls: { 0: "pad4" },
      difficulty: "easy",
      overrides: {},
      stage: "garden",
      stocks: 3,
      time: "standard",
    });
    expect(first.options.controls).toEqual({ 0: "pad4" });
    expect(first.options.overrides).toEqual({});
    expect(first.options.loadouts[0]).toEqual(saved.loadouts[0]);
    const disconnected = playableOptions(first.options, 2, () => false);
    expect(disconnected.options.controls).toEqual({ 0: "keyboard" });
    expect(disconnected.substitutes).toEqual([{ slot: 0, device: "pad4", by: "keyboard" }]);

    const before = copyMatchOptions(saved);
    first.options.loadouts[0].palette = "sky";
    expect(saved).toEqual(before);
    run.finish(first.id, 0, 15);
    const second = run.startAttempt()!;
    const reconnected = playableOptions(second.options, 2, (pad) => pad === 3);
    expect(reconnected.options.controls).toEqual({ 0: "pad4" });
    expect(reconnected.options.loadouts[0]).toEqual(before.loadouts[0]);
    expect(store.get()).toEqual(before);
    expect(setItem).toHaveBeenCalledTimes(2);
  });

  test("starting a retry or the next round replaces the fighter and arena state", () => {
    const run = newRun();
    const engine = new BattleEngine(1);
    const first = run.startAttempt()!;
    engine.start("duel", first.options);
    const dirty = () => {
      const state = engine.state;
      Object.assign(state, { phase: "ended", elapsed: 79, winnerId: 1 });
      Object.assign(state.fighters[0], { stocks: 0, damage: 125, stamina: 9, outsideTime: 4 });
      Object.assign(state.arena, { halfSize: 3, warningRing: true, windActive: true });
      state.arena.safeZone.active = true;
      state.bombs.push({ id: 1, x: 0, z: 0, radius: 3, timer: 1, duration: 2, exploded: false });
      state.stats.hits = 8;
    };
    const expectClean = (stage: "garden" | "ruins") => {
      expect(engine.state).toMatchObject({
        phase: "countdown",
        mode: "duel",
        elapsed: 0,
        countdown: 3,
        winnerId: null,
        bombs: [],
        stats: { hits: 0 },
        arena: {
          stageId: stage,
          halfSize: STAGES[stage].halfSize,
          warningRing: false,
          windActive: false,
          safeZone: { active: false },
        },
      });
      expect(engine.state.bombs).toHaveLength(0);
      for (const fighter of engine.state.fighters) {
        expect(fighter).toMatchObject({
          stocks: 3,
          damage: 0,
          stamina: RULES.maxStamina,
          outsideTime: 0,
        });
      }
    };

    dirty();
    run.finish(first.id, 1, engine.state.elapsed);
    const retry = run.startAttempt()!;
    engine.start("duel", retry.options);
    expectClean("garden");
    dirty();
    run.finish(retry.id, 0, engine.state.elapsed);
    engine.start("duel", run.startAttempt()!.options);
    expectClean("ruins");
  });
});
