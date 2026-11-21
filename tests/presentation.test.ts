import { describe, expect, test } from "vite-plus/test";
import { BattleEngine } from "../src/game/engine";
import {
  climaxReason,
  finishKind,
  isClimax,
  lateClockSeconds,
  musicCue,
  PresentationTracker,
  type PresentationEvent,
} from "../src/game/presentation";
import { ALL_GIMMICKS, NO_GIMMICKS, TIME_RULES, timeLimitFor } from "../src/game/rules";
import { RULES } from "../src/game/tuning";
import { emptyInput, type Fighter, type MatchMode } from "../src/game/types";
import type { MatchOptions } from "../src/game/match";

const DT = 1 / 60;

function play(mode: MatchMode, options: Partial<MatchOptions> = {}, seed = 99): BattleEngine {
  const engine = new BattleEngine(seed);
  engine.start(mode, { stage: "garden", gimmicks: { ...NO_GIMMICKS }, ...options });
  engine.state.phase = "playing";
  // Frozen CPUs: only the rules under test move anything.
  for (const f of engine.state.fighters) if (!f.human) f.hitstop = 1e6;
  return engine;
}

/** Knocks `f` far below the floor; the next tick eliminates it. */
function drop(engine: BattleEngine, f: Fighter): void {
  Object.assign(f, { y: -20, vy: 0, grounded: false, hitstop: 0 });
  engine.update(DT, emptyInput());
}

const kinds = (events: PresentationEvent[]) => events.map((e) => e.kind);

describe("climax", () => {
  test.each(TIME_RULES.flatMap((time) => [1, 3, 5].map((stocks) => ({ time, stocks }))))(
    "never at the start: $stocks stocks / $time, gimmicks on and off, duel and rumble",
    ({ time, stocks }) => {
      for (const mode of ["duel", "rumble"] as const)
        for (const gimmicks of [ALL_GIMMICKS, NO_GIMMICKS]) {
          const engine = new BattleEngine(5);
          engine.start(mode, { time, stocks, gimmicks: { ...gimmicks } });
          expect(engine.state.phase).toBe("countdown");
          expect(isClimax(engine.state)).toBe(false);
          // Through the countdown and the first seconds of play.
          for (let i = 0; i < 6 * 60; i++) engine.update(DT, emptyInput());
          expect(engine.state.phase).toBe("playing");
          expect(climaxReason(engine.state)).toBeNull();
        }
    },
  );

  test("always on while the moving safe zone is in its late phase", () => {
    for (const time of TIME_RULES)
      for (const stocks of [1, 3]) {
        const engine = play("duel", {
          time,
          stocks,
          stage: "ruins",
          gimmicks: { ...NO_GIMMICKS, safeZone: true },
        });
        const limit = timeLimitFor(stocks, time);
        let sawLate = false;
        for (let t = 0; t < limit; t += 0.5) {
          engine.state.elapsed = t;
          engine.update(RULES.fixedStep);
          if (engine.state.phase !== "playing") break;
          const zone = engine.state.arena.safeZone;
          if (zone.phase === "late") {
            sawLate = true;
            expect(isClimax(engine.state)).toBe(true);
          }
        }
        expect(sawLate).toBe(true);
      }
  });

  test("the clock alone brings it on in the last fifth (at most 30 s), gimmicks off", () => {
    for (const time of TIME_RULES) {
      const engine = play("duel", { time, stocks: 3 });
      const limit = engine.state.rules.timeLimit!;
      const late = lateClockSeconds(limit);
      engine.state.elapsed = limit - late - 1;
      expect(climaxReason(engine.state)).toBeNull();
      engine.state.elapsed = limit - late + 0.01;
      expect(climaxReason(engine.state)).toBe("clock");
      expect(late).toBeLessThanOrEqual(30);
    }
  });

  test("final stock: both duelists on their last life, only if they started with more", () => {
    const three = play("duel", { stocks: 3 });
    const [a, b] = three.state.fighters;
    a.stocks = 1;
    expect(climaxReason(three.state)).toBeNull();
    b.stocks = 1;
    expect(climaxReason(three.state)).toBe("finalStock");
    const one = play("duel", { stocks: 1 });
    expect(climaxReason(one.state)).toBeNull();
  });

  test("a one-life rumble turns decisive when two fighters are left", () => {
    const engine = play("rumble", { stocks: 1 });
    const [, b, c] = engine.state.fighters;
    drop(engine, b!);
    expect(climaxReason(engine.state)).toBeNull();
    drop(engine, c!);
    expect(climaxReason(engine.state)).toBe("finalStock");
  });

  test("never in training, however long it runs", () => {
    const engine = new BattleEngine(3);
    engine.start("training", { gimmicks: { ...ALL_GIMMICKS } });
    engine.state.phase = "playing";
    for (const elapsed of [0, 100, 1000, 10000]) {
      engine.state.elapsed = elapsed;
      engine.update(DT, emptyInput());
      expect(isClimax(engine.state)).toBe(false);
      expect(musicCue(engine.state).scene).toBe("practice");
    }
  });

  test("countdown, menu and a finished game are never climax", () => {
    const engine = play("duel", { stocks: 3 });
    engine.state.fighters.forEach((f) => (f.stocks = 1));
    expect(isClimax(engine.state)).toBe(true);
    engine.state.phase = "countdown";
    expect(isClimax(engine.state)).toBe(false);
    engine.state.phase = "ended";
    expect(isClimax(engine.state)).toBe(false);
    engine.menu("duel");
    expect(isClimax(engine.state)).toBe(false);
  });
});

describe("music cue", () => {
  test("follows the scene; pause keeps the loop, muffled", () => {
    const engine = new BattleEngine(1);
    engine.menu("duel");
    expect(musicCue(engine.state)).toEqual({ scene: "menu", mood: null, paused: false });
    engine.start("duel", { stocks: 3, gimmicks: { ...NO_GIMMICKS } });
    expect(musicCue(engine.state).scene).toBe("battle");
    engine.state.phase = "playing";
    engine.pause();
    expect(musicCue(engine.state)).toEqual({ scene: "battle", mood: null, paused: true });
    engine.resume();
    engine.state.fighters.forEach((f) => (f.stocks = 1));
    expect(musicCue(engine.state).scene).toBe("climax");
    engine.pause();
    expect(musicCue(engine.state)).toEqual({ scene: "climax", mood: null, paused: true });
  });

  test("results take the mood of the game", () => {
    const engine = play("duel", { stocks: 1 });
    const [player, cpu] = engine.state.fighters;
    drop(engine, cpu!);
    expect(musicCue(engine.state)).toEqual({ scene: "result", mood: "victory", paused: false });
    const lost = play("duel", { stocks: 1 });
    drop(lost, lost.state.fighters[0]!);
    expect(musicCue(lost.state).mood).toBe("defeat");
    expect(player).toBeDefined();
  });
});

describe("presentation events", () => {
  test("a life lost is a stock KO, never a finish", () => {
    const engine = play("duel", { stocks: 3 });
    const tracker = new PresentationTracker();
    tracker.update(engine.state);
    drop(engine, engine.state.fighters[1]!);
    const events = tracker.update(engine.state);
    expect(kinds(events)).toEqual(["stockKo"]);
    expect(events[0]).toMatchObject({ fighterId: 1, stocksLeft: 2 });
    expect(engine.state.phase).toBe("playing");
  });

  test("the deciding fall is one finish (no stock KO alongside)", () => {
    const engine = play("duel", { stocks: 1 });
    const tracker = new PresentationTracker();
    tracker.update(engine.state);
    drop(engine, engine.state.fighters[1]!);
    const events = tracker.update(engine.state);
    expect(kinds(events)).toEqual(["finish"]);
    expect(events[0]).toMatchObject({ finish: "win", winnerId: 0, byKo: true });
    // Later frames of the result never repeat it.
    expect(tracker.update(engine.state)).toEqual([]);
  });

  test("four players: an elimination keeps the match going, the last one finishes it", () => {
    const engine = play("rumble", { stocks: 1 });
    const tracker = new PresentationTracker();
    tracker.update(engine.state);
    const [, b, c, d] = engine.state.fighters;
    drop(engine, b!);
    expect(kinds(tracker.update(engine.state))).toEqual(["elimination"]);
    drop(engine, c!);
    expect(kinds(tracker.update(engine.state))).toEqual(["elimination", "climax"]);
    drop(engine, d!);
    const last = tracker.update(engine.state);
    expect(kinds(last)).toEqual(["finish"]);
    expect(last[0]).toMatchObject({ winnerId: 0, finish: "win" });
  });

  test("a CPU win is a defeat, a double fall a draw, a time-up is not by KO", () => {
    const lost = play("duel", { stocks: 1 });
    const t1 = new PresentationTracker();
    t1.update(lost.state);
    drop(lost, lost.state.fighters[0]!);
    expect(t1.update(lost.state)[0]).toMatchObject({ kind: "finish", finish: "defeat" });

    const draw = play("duel", { stocks: 1 });
    const t2 = new PresentationTracker();
    t2.update(draw.state);
    for (const f of draw.state.fighters)
      Object.assign(f, { y: -20, vy: 0, grounded: false, hitstop: 0 });
    draw.update(DT, emptyInput());
    expect(draw.state.phase).toBe("ended");
    expect(draw.state.winnerId).toBeNull();
    expect(t2.update(draw.state)[0]).toMatchObject({ kind: "finish", finish: "draw", byKo: true });

    const time = play("duel", { stocks: 3, time: "short" });
    const t3 = new PresentationTracker();
    t3.update(time.state);
    time.state.fighters[1]!.damage = 50;
    time.state.elapsed = time.state.rules.timeLimit! - 0.001;
    time.update(DT, emptyInput());
    expect(time.state.phase).toBe("ended");
    const events = t3.update(time.state);
    expect(events.find((e) => e.kind === "finish")).toMatchObject({ byKo: false, winnerId: 0 });
  });

  test("a set: game wins are wins, the deciding game is a set win", () => {
    const engine = play("duel", { stocks: 1, setFormat: "bo3" });
    const tracker = new PresentationTracker();
    tracker.update(engine.state);
    drop(engine, engine.state.fighters[1]!);
    expect(tracker.update(engine.state)[0]).toMatchObject({ kind: "finish", finish: "win" });
    expect(engine.nextSetGame()).toBe(true);
    // The next game is a new state: nothing is replayed.
    expect(tracker.update(engine.state)).toEqual([]);
    engine.state.phase = "playing";
    for (const f of engine.state.fighters) if (!f.human) f.hitstop = 1e6;
    drop(engine, engine.state.fighters[1]!);
    expect(engine.state.set?.phase).toBe("complete");
    expect(tracker.update(engine.state)[0]).toMatchObject({ kind: "finish", finish: "setWin" });
  });

  test("the ladder's last win is a ladder clear", () => {
    const engine = play("duel", { stocks: 1 });
    const tracker = new PresentationTracker();
    tracker.update(engine.state);
    drop(engine, engine.state.fighters[1]!);
    expect(finishKind(engine.state, { ladderClear: true })).toBe("ladderClear");
    expect(tracker.update(engine.state, { ladderClear: true })[0]).toMatchObject({
      finish: "ladderClear",
    });
  });

  test("training: falls are training KOs, never a climax or a finish", () => {
    const engine = new BattleEngine(8);
    engine.start("training", {});
    engine.state.phase = "playing";
    const tracker = new PresentationTracker();
    tracker.update(engine.state);
    const seen: PresentationEvent[] = [];
    for (let round = 0; round < 5; round++) {
      drop(engine, engine.state.fighters[0]!);
      seen.push(...tracker.update(engine.state));
      for (let i = 0; i < 120; i++) {
        engine.update(DT, emptyInput());
        seen.push(...tracker.update(engine.state));
      }
    }
    engine.state.elapsed = 5000;
    engine.update(DT, emptyInput());
    seen.push(...tracker.update(engine.state));
    expect(seen.filter((e) => e.kind === "trainingKo")).toHaveLength(5);
    expect(seen.some((e) => e.kind === "finish" || e.kind === "climax")).toBe(false);
  });

  test("rematch, pause and the title never replay or invent events", () => {
    const engine = play("duel", { stocks: 1 });
    const tracker = new PresentationTracker();
    tracker.update(engine.state);
    engine.pause();
    expect(tracker.update(engine.state)).toEqual([]);
    engine.resume();
    drop(engine, engine.state.fighters[1]!);
    expect(kinds(tracker.update(engine.state))).toEqual(["finish"]);
    engine.start("duel");
    expect(tracker.update(engine.state)).toEqual([]);
    engine.menu("duel");
    expect(tracker.update(engine.state)).toEqual([]);
  });

  test("climax is announced once per match, on the fall that brings it", () => {
    const engine = play("duel", { stocks: 2 });
    const tracker = new PresentationTracker();
    tracker.update(engine.state);
    const [a, b] = engine.state.fighters;
    drop(engine, a!);
    expect(kinds(tracker.update(engine.state))).toEqual(["stockKo"]);
    drop(engine, b!);
    expect(kinds(tracker.update(engine.state))).toEqual(["stockKo", "climax"]);
    for (let i = 0; i < 4 * 60; i++) {
      engine.update(DT, emptyInput());
      expect(tracker.update(engine.state).some((e) => e.kind === "climax")).toBe(false);
    }
    expect(engine.state.fighters.every((f) => f.mode !== "dead")).toBe(true);
  });

  test("warnings: new bomb circles, the collapse ring and the zone", () => {
    const engine = play("duel", {
      stocks: 3,
      stage: "ruins",
      gimmicks: { ...NO_GIMMICKS, bombs: true, collapse: true, safeZone: true },
    });
    const tracker = new PresentationTracker();
    tracker.update(engine.state);
    const seen = new Set<string>();
    for (let i = 0; i < 70 * 60 && engine.state.phase === "playing"; i++) {
      engine.update(DT, emptyInput());
      for (const e of tracker.update(engine.state)) seen.add(e.kind);
    }
    expect(seen).toContain("bombWarning");
    expect(seen).toContain("collapseWarning");
    expect(seen).toContain("zoneWarning");
  });

  test("a non-final stock fall on the exact time-up tick is still a time-up finish, not a KO", () => {
    const engine = play("duel", { stocks: 3, time: "short" });
    const tracker = new PresentationTracker();
    tracker.update(engine.state);
    const [winner, rival] = engine.state.fighters;
    Object.assign(winner!, { x: -3.5, z: 2.25, damage: 10 });
    Object.assign(rival!, {
      x: 4.5,
      z: -4,
      y: -20,
      vy: 0,
      grounded: false,
      hitstop: 0,
      damage: 50,
    });
    engine.state.elapsed = engine.state.rules.timeLimit! - DT / 2;
    engine.update(DT, emptyInput());
    expect(engine.state.phase).toBe("ended");
    expect(engine.state.finishReason).toBe("timeUp");
    expect(rival!.stocks).toBe(2);
    const finish = tracker.update(engine.state).find((e) => e.kind === "finish");
    expect(finish).toMatchObject({
      kind: "finish",
      finish: "win",
      winnerId: winner!.id,
      byKo: false,
      x: winner!.x,
      z: winner!.z,
    });
  });

  test("tutorial context keeps practice music and suppresses climax and finish banners", () => {
    const engine = play("duel", { stocks: 2, time: "short" });
    const tracker = new PresentationTracker();
    tracker.update(engine.state, { tutorial: true });
    expect(musicCue(engine.state, true)).toEqual({
      scene: "practice",
      mood: null,
      paused: false,
    });
    engine.state.fighters.forEach((f) => (f.stocks = 1));
    expect(tracker.update(engine.state, { tutorial: true }).some((e) => e.kind === "climax")).toBe(
      false,
    );
    drop(engine, engine.state.fighters[1]!);
    expect(engine.state.phase).toBe("ended");
    expect(musicCue(engine.state, true)).toEqual({
      scene: "practice",
      mood: null,
      paused: false,
    });
    expect(tracker.update(engine.state, { tutorial: true }).some((e) => e.kind === "finish")).toBe(
      false,
    );
  });
});
