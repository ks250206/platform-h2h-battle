import { describe, expect, test } from "vite-plus/test";
import { BattleEngine, canStandAt, matchTimeLimit } from "../src/game/engine";
import { DEFAULT_MATCH_OPTIONS, sanitizeMatchOptions, type MatchOptions } from "../src/game/match";
import {
  applyPreset,
  createMatchStore,
  loadMatchOptions,
  MATCH_STORAGE_KEY,
  type MatchStorage,
} from "../src/game/matchStore";
import {
  ALL_GIMMICKS,
  describeRules,
  effectiveRules,
  FLOATING_GARDEN,
  GIMMICK_IDS,
  NO_GIMMICKS,
  PRESET_IDS,
  presetOf,
  presetRules,
  RULE_PRESETS,
  SHORT_TIME_LIMIT,
  timeLimitFor,
  type GimmickId,
  type Gimmicks,
  type StageInfo,
} from "../src/game/rules";
import { RULES } from "../src/game/tuning";
import { emptyInput, type MatchMode } from "../src/game/types";

const DT = 1 / 60;

function memoryStorage(initial?: string): MatchStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(MATCH_STORAGE_KEY, initial);
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

const only = (id: GimmickId, on: boolean): Gimmicks => ({ ...ALL_GIMMICKS, [id]: on });

/** A match with frozen CPUs (long hitstop) so only the arena moves anything. */
function fixture(options: Partial<MatchOptions>, mode: MatchMode = "duel", seed = 4242) {
  const engine = new BattleEngine(seed);
  engine.start(mode, options);
  engine.state.phase = "playing";
  for (const cpu of engine.state.fighters.slice(1)) cpu.hitstop = 1e6;
  return { engine, player: engine.state.fighters[0]!, cpu: engine.state.fighters[1]! };
}

function advance(engine: BattleEngine, seconds: number, each?: () => void) {
  for (let frame = 0; frame < Math.round(seconds / DT); frame++) {
    engine.update(DT, emptyInput());
    each?.();
  }
}

/** Jumps the clock to `at` (fighters stay put) and runs `seconds` more. */
function jump(engine: BattleEngine, at: number, seconds = DT, each?: () => void) {
  engine.state.elapsed = at;
  advance(engine, seconds, each);
}

describe("presets", () => {
  test("standard, short and no-gimmicks set the documented rules", () => {
    expect(PRESET_IDS).toEqual(["standard", "short", "noGimmicks"]);
    expect(presetRules("standard")).toEqual({
      stocks: 3,
      time: "standard",
      gimmicks: ALL_GIMMICKS,
    });
    expect(presetRules("short")).toEqual({ stocks: 1, time: "short", gimmicks: ALL_GIMMICKS });
    expect(presetRules("noGimmicks")).toEqual({
      stocks: 3,
      time: "standard",
      gimmicks: NO_GIMMICKS,
    });
  });

  test("the defaults are the standard preset", () => {
    expect(presetOf(DEFAULT_MATCH_OPTIONS)).toBe("standard");
  });

  test("presetRules hands out copies", () => {
    const rules = presetRules("standard");
    rules.gimmicks.bombs = false;
    rules.stocks = 5;
    expect(RULE_PRESETS.standard.rules.gimmicks.bombs).toBe(true);
    expect(presetRules("standard").stocks).toBe(3);
  });

  test("each preset is recognised from its rules", () => {
    for (const id of PRESET_IDS) expect(presetOf(presetRules(id))).toBe(id);
  });

  test("any change of stocks, time or a single gimmick makes it custom", () => {
    for (const id of PRESET_IDS) {
      const rules = presetRules(id);
      expect(presetOf({ ...rules, stocks: rules.stocks === 2 ? 4 : 2 })).toBe("custom");
      expect(presetOf({ ...rules, time: rules.time === "short" ? "standard" : "short" })).toBe(
        "custom",
      );
      for (const g of GIMMICK_IDS)
        expect(
          presetOf({ ...rules, gimmicks: { ...rules.gimmicks, [g]: !rules.gimmicks[g] } }),
        ).toBe("custom");
    }
  });

  test("tweaking back to a preset's exact values shows that preset again", () => {
    const store = createMatchStore(memoryStorage());
    store.preset("noGimmicks");
    store.toggleGimmick("wind");
    expect(presetOf(store.get())).toBe("custom");
    store.toggleGimmick("wind");
    expect(presetOf(store.get())).toBe("noGimmicks");
    store.set({ stocks: 1 });
    expect(presetOf(store.get())).toBe("custom");
    store.set({ gimmicks: { ...ALL_GIMMICKS }, time: "short" });
    expect(presetOf(store.get())).toBe("short");
  });

  test("switching presets never touches devices or CPU strength", () => {
    const players: Partial<MatchOptions> = {
      controls: { 0: "pad2", 1: "keyboard", 3: "pad1" },
      difficulty: "hard",
      overrides: { 2: "easy", 3: "normal" },
    };
    const base = sanitizeMatchOptions({ ...DEFAULT_MATCH_OPTIONS, ...players });
    for (const id of PRESET_IDS) {
      const next = applyPreset(base, id);
      expect(next.controls).toEqual(players.controls);
      expect(next.difficulty).toBe("hard");
      expect(next.overrides).toEqual(players.overrides);
      expect(presetOf(next)).toBe(id);
    }
    const store = createMatchStore(memoryStorage());
    store.set(players);
    for (const id of [...PRESET_IDS, "standard"] as const) {
      store.preset(id);
      const now = store.get();
      expect(now.controls).toEqual(players.controls);
      expect(now.difficulty).toBe("hard");
      expect(now.overrides).toEqual(players.overrides);
    }
  });

  test("applyPreset does not share maps with its input", () => {
    const base = sanitizeMatchOptions(DEFAULT_MATCH_OPTIONS);
    const next = applyPreset(base, "noGimmicks");
    next.controls[1] = "pad1";
    next.gimmicks.wind = true;
    expect(base.controls[1]).toBeUndefined();
    expect(base.gimmicks).toEqual(ALL_GIMMICKS);
  });
});

describe("storage", () => {
  test("preset and gimmicks survive a reload", () => {
    const storage = memoryStorage();
    const store = createMatchStore(storage);
    store.preset("short");
    store.toggleGimmick("bombs", false);
    const reloaded = loadMatchOptions(storage);
    expect(reloaded).toMatchObject({
      stocks: 1,
      time: "short",
      gimmicks: { collapse: true, safeZone: true, bombs: false, wind: true },
    });
    expect(presetOf(reloaded)).toBe("custom");
    store.toggleGimmick("bombs");
    expect(presetOf(loadMatchOptions(storage))).toBe("short");
  });

  test("a save from before the toggles runs every gimmick with the standard clock", () => {
    const legacy = JSON.stringify({
      controls: { 0: "keyboard", 1: "pad1" },
      stocks: 3,
      difficulty: "easy",
      overrides: { 1: "hard" },
    });
    const options = loadMatchOptions(memoryStorage(legacy));
    expect(options).toEqual({
      controls: { 0: "keyboard", 1: "pad1" },
      stocks: 3,
      difficulty: "easy",
      overrides: { 1: "hard" },
      time: "standard",
      gimmicks: ALL_GIMMICKS,
    });
    expect(presetOf(options)).toBe("standard");
    expect(presetOf(loadMatchOptions(memoryStorage(JSON.stringify({ stocks: 1 }))))).toBe("custom");
  });

  test("corrupt rule fields fall back one by one", () => {
    const load = (raw: unknown) => loadMatchOptions(memoryStorage(JSON.stringify(raw)));
    expect(load({ time: "forever", gimmicks: "none" })).toMatchObject({
      time: "standard",
      gimmicks: ALL_GIMMICKS,
    });
    expect(load({ time: 90, gimmicks: null }).time).toBe("standard");
    expect(load({ gimmicks: [false, false] }).gimmicks).toEqual(ALL_GIMMICKS);
    expect(
      load({ gimmicks: { collapse: false, safeZone: "no", bombs: 0, wind: false, lava: true } })
        .gimmicks,
    ).toEqual({ collapse: false, safeZone: true, bombs: true, wind: false });
    expect(load({ time: "short", gimmicks: NO_GIMMICKS })).toMatchObject({
      time: "short",
      gimmicks: NO_GIMMICKS,
    });
    expect(loadMatchOptions(memoryStorage("{broken"))).toEqual(DEFAULT_MATCH_OPTIONS);
  });

  test("a bad patch through the store is sanitized too", () => {
    const store = createMatchStore(memoryStorage());
    store.set({ time: "eternal" as never, gimmicks: { wind: false } as never });
    expect(store.get().time).toBe("standard");
    expect(store.get().gimmicks).toEqual(only("wind", false));
  });
});

describe("time limit", () => {
  test("standard grows with stocks; short is a flat 90 seconds", () => {
    expect(SHORT_TIME_LIMIT).toBe(90);
    expect(timeLimitFor(1)).toBe(RULES.maxMatchTime);
    expect(timeLimitFor(3)).toBe(RULES.maxMatchTime + 2 * RULES.matchTimePerStock);
    for (const stocks of [1, 3, 5]) expect(timeLimitFor(stocks, "short")).toBe(90);
    expect(matchTimeLimit(3, "short")).toBe(90);
    expect(matchTimeLimit(3)).toBe(timeLimitFor(3));
    expect(timeLimitFor(1, "short")).toBeLessThan(timeLimitFor(1));
  });

  test.each(["duel", "rumble"] as const)("the short preset ends a %s at 90 seconds", (mode) => {
    const { engine, player, cpu } = fixture(presetRules("short"), mode);
    expect(engine.state.rules.timeLimit).toBe(90);
    Object.assign(player, { x: -0.5, z: 0, damage: 10 });
    Object.assign(cpu, { x: 0.5, z: 0, damage: 60 });
    jump(engine, 89);
    expect(engine.state.phase).toBe("playing");
    jump(engine, 90 - DT / 2);
    expect(engine.state.phase).toBe("ended");
    expect(engine.state.message).toBe("TIME UP — 蓄積ダメージの少ない選手が勝利");
    if (mode === "duel") expect(engine.state.winnerId).toBe(player.id);
  });

  test("the short clock applies with more lives too, ranking by lives first", () => {
    const { engine, player, cpu } = fixture({ ...presetRules("short"), stocks: 3 });
    Object.assign(player, { x: -0.5, z: 0, stocks: 3, damage: 120 });
    Object.assign(cpu, { x: 0.5, z: 0, stocks: 2, damage: 0 });
    jump(engine, 90 - DT / 2);
    expect(engine.state.phase).toBe("ended");
    expect(engine.state.winnerId).toBe(player.id);
  });
});

describe("effective rules", () => {
  test("duel and rumble share the same rules", () => {
    for (const id of PRESET_IDS) {
      const chosen = presetRules(id);
      expect(effectiveRules(chosen, "rumble")).toEqual(effectiveRules(chosen, "duel"));
    }
    const duel = new BattleEngine(1);
    const rumble = new BattleEngine(1);
    duel.start("duel", presetRules("noGimmicks"));
    rumble.start("rumble", presetRules("noGimmicks"));
    expect(rumble.state.rules).toEqual(duel.state.rules);
  });

  test("training always has infinite lives, no clock and no gimmicks", () => {
    for (const id of PRESET_IDS) {
      const rules = effectiveRules(presetRules(id), "training");
      expect(rules.stocks).toBeNull();
      expect(rules.timeLimit).toBeNull();
      expect(rules.gimmicks).toEqual(NO_GIMMICKS);
    }
    expect(describeRules(effectiveRules(presetRules("standard"), "training"))).toBe(
      "残機 無制限 · 時間制限なし · ギミックなし",
    );
  });

  test("a stage constraint overrides the choice and says why", () => {
    const stage: StageInfo = {
      id: "test",
      name: "TEST",
      constraints: {
        wind: { forced: false, reason: "屋内のため風は吹かない" },
        collapse: { forced: true, reason: "崩れやすい島" },
      },
    };
    const rules = effectiveRules(presetRules("standard"), "duel", stage);
    expect(rules.gimmicks).toEqual({ collapse: true, safeZone: true, bombs: true, wind: false });
    // Collapse was already on, so only the wind is reported.
    expect(rules.notes).toEqual([
      { gimmick: "wind", chosen: true, effective: false, reason: "屋内のため風は吹かない" },
    ]);
    const off = effectiveRules(presetRules("noGimmicks"), "rumble", stage);
    expect(off.notes.map((n) => n.gimmick)).toEqual(["collapse"]);
    expect(FLOATING_GARDEN.constraints).toEqual({});
    expect(effectiveRules(presetRules("standard"), "duel").notes).toEqual([]);
  });

  test("the summary names lives, clock and every active gimmick", () => {
    expect(describeRules(effectiveRules(presetRules("standard"), "duel"))).toBe(
      "残機 3 · 制限時間 4:30 · ギミック: 外周崩壊・セーフゾーン・爆撃・風",
    );
    expect(describeRules(effectiveRules(presetRules("short"), "duel"))).toBe(
      "残機 1 · 制限時間 1:30 · ギミック: 外周崩壊・セーフゾーン・爆撃・風",
    );
    expect(describeRules(effectiveRules(presetRules("noGimmicks"), "rumble"))).toBe(
      "残機 3 · 制限時間 4:30 · ギミック: なし",
    );
    expect(
      describeRules(
        effectiveRules({ ...presetRules("standard"), gimmicks: only("bombs", false) }, "duel"),
      ),
    ).toBe("残機 3 · 制限時間 4:30 · ギミック: 外周崩壊・セーフゾーン・風");
  });
});

describe("a disabled gimmick leaves no trace", () => {
  test("collapse off: no warning, no shrinking, the whole floor stays", () => {
    const on = fixture({ gimmicks: ALL_GIMMICKS });
    jump(on.engine, RULES.collapseStart - RULES.collapseWarning + 0.5);
    expect(on.engine.state.arena.warningRing).toBe(true);
    jump(on.engine, RULES.collapseStart + 0.1);
    expect(on.engine.state.arena.halfSize).toBeLessThan(RULES.arenaHalfSize);

    const { engine } = fixture({ gimmicks: only("collapse", false) }, "rumble");
    const edge = RULES.arenaHalfSize - 0.1;
    for (let k = 0; k < 6; k++) {
      const at = RULES.collapseStart + k * RULES.collapseInterval;
      jump(engine, at - RULES.collapseWarning + 0.5);
      expect(engine.state.arena.warningRing).toBe(false);
      jump(engine, at + 0.1);
      expect(engine.state.arena.halfSize).toBe(RULES.arenaHalfSize);
      expect(canStandAt(engine.state, edge, edge)).toBe(true);
    }
  });

  test("safe zone off: never active, no outside damage or gauge", () => {
    const { engine, player } = fixture({ gimmicks: only("safeZone", false) });
    Object.assign(player, { x: RULES.arenaHalfSize - 1, z: RULES.arenaHalfSize - 1 });
    const before = player.damage;
    jump(engine, RULES.safeZoneStart + 30, 3, () => {
      expect(engine.state.arena.safeZone.active).toBe(false);
      expect(player.outsideTime).toBe(0);
    });
    expect(player.damage).toBe(before);
    expect(player.mode).not.toBe("dead");

    const on = fixture({ gimmicks: ALL_GIMMICKS });
    Object.assign(on.player, { x: RULES.arenaHalfSize - 1, z: RULES.arenaHalfSize - 1 });
    jump(on.engine, RULES.safeZoneStart + 30, 1);
    expect(on.engine.state.arena.safeZone.active).toBe(true);
    expect(on.player.outsideTime).toBeGreaterThan(0);
  });

  test("safe zone off: CPUs play a whole rumble without ever seeing a zone", () => {
    const engine = new BattleEngine(31);
    engine.start("rumble", { stocks: 1, gimmicks: only("safeZone", false) });
    engine.state.phase = "playing";
    advance(engine, 120, () => {
      expect(engine.state.arena.safeZone.active).toBe(false);
      for (const f of engine.state.fighters) expect(f.outsideTime).toBe(0);
    });
  });

  test("bombs off: no warning, no blast, ever", () => {
    const { engine } = fixture({ gimmicks: only("bombs", false) }, "rumble");
    jump(engine, RULES.bombStart - 0.5, RULES.bombInterval * 5, () => {
      expect(engine.state.bombs).toEqual([]);
      expect(engine.state.effects.some((e) => e.kind === "bomb")).toBe(false);
      expect(engine.state.message).not.toContain("爆撃");
    });

    const on = fixture({ gimmicks: ALL_GIMMICKS });
    jump(on.engine, RULES.bombStart + 0.1);
    expect(on.engine.state.bombs.length).toBeGreaterThan(0);
  });

  test("wind off: no push and nothing for the renderer to draw", () => {
    // 24-36 s is a wind window (every third 12 s block from 24 s).
    const on = fixture({ gimmicks: ALL_GIMMICKS });
    const x0 = on.player.x;
    jump(on.engine, 25, 2);
    expect(on.engine.state.arena.windActive).toBe(true);
    expect(on.player.x).not.toBeCloseTo(x0, 3);

    const { engine, player } = fixture({ gimmicks: only("wind", false) });
    const start = { x: player.x, z: player.z };
    jump(engine, 25, 10, () => {
      expect(engine.state.arena.windActive).toBe(false);
      expect(engine.state.arena.wind).toEqual({ x: 0, z: 0 });
    });
    expect(player.x).toBeCloseTo(start.x, 6);
    expect(player.z).toBeCloseTo(start.z, 6);
  });
});

describe("with every gimmick off", () => {
  const none = presetRules("noGimmicks");

  test("a ring-out still ends a match", () => {
    const { engine, player, cpu } = fixture({ ...none, stocks: 1 });
    Object.assign(cpu, { y: -20, vy: 0, grounded: false, hitstop: 0 });
    engine.update(DT, emptyInput());
    expect(engine.state.phase).toBe("ended");
    expect(engine.state.winnerId).toBe(player.id);
  });

  test("stocks are spent and respawns still happen", () => {
    const { engine, cpu } = fixture(none);
    Object.assign(cpu, { y: -20, vy: 0, grounded: false, hitstop: 0 });
    engine.update(DT, emptyInput());
    expect(cpu.stocks).toBe(2);
    advance(engine, RULES.respawnDelay + 0.2);
    expect(cpu.mode).not.toBe("dead");
    expect(engine.state.phase).toBe("playing");
  });

  test.each(["duel", "rumble"] as const)("time-up still decides a %s", (mode) => {
    const { engine, player, cpu } = fixture(none, mode);
    Object.assign(player, { x: -0.5, z: 0, stocks: 3, damage: 80 });
    Object.assign(cpu, { x: 0.5, z: 0, stocks: 2, damage: 0 });
    const limit = timeLimitFor(3);
    expect(engine.state.rules.timeLimit).toBe(limit);
    jump(engine, limit - 1);
    expect(engine.state.phase).toBe("playing");
    jump(engine, limit - DT / 2);
    expect(engine.state.phase).toBe("ended");
    expect(engine.state.message).toContain("TIME UP");
    if (mode === "duel") expect(engine.state.winnerId).toBe(player.id);
  });

  test("a real CPU match finishes, by falls or by the clock", () => {
    const engine = new BattleEngine(5);
    engine.start("rumble", { ...none, stocks: 1 });
    engine.state.phase = "playing";
    const limit = timeLimitFor(1);
    advance(engine, limit + 1, () => {
      expect(engine.state.bombs).toEqual([]);
      expect(engine.state.arena.halfSize).toBe(RULES.arenaHalfSize);
    });
    expect(engine.state.phase).toBe("ended");
    expect(engine.state.elapsed).toBeLessThanOrEqual(limit + DT);
  });
});

describe("training stays apart", () => {
  test.each(PRESET_IDS)("the %s preset changes nothing in training", (id) => {
    const { engine, player } = fixture(presetRules(id), "training");
    expect(engine.state.rules).toMatchObject({
      stocks: null,
      timeLimit: null,
      gimmicks: NO_GIMMICKS,
    });
    jump(engine, 400, 2);
    expect(engine.state.phase).toBe("playing");
    expect(engine.state.bombs).toEqual([]);
    expect(engine.state.arena.safeZone.active).toBe(false);
    expect(engine.state.arena.windActive).toBe(false);
    expect(engine.state.arena.halfSize).toBe(RULES.arenaHalfSize);
    expect(player.outsideTime).toBe(0);
  });
});

describe("rematch", () => {
  test("a restart without new options keeps the rules", () => {
    const engine = new BattleEngine(9);
    engine.start("duel", { ...presetRules("short"), gimmicks: only("wind", false) });
    const first = engine.state.rules;
    engine.start("duel");
    expect(engine.state.rules).toEqual(first);
    expect(engine.state.options.gimmicks).toEqual(only("wind", false));
    engine.menu();
    engine.start("rumble");
    expect(engine.state.rules.timeLimit).toBe(90);
    expect(engine.state.rules.gimmicks.wind).toBe(false);
  });
});
