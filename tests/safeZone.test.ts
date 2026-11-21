import { describe, expect, test } from "vite-plus/test";
import { BattleEngine } from "../src/game/engine";
import { AI_LEVEL_IDS, type AiLevel } from "../src/game/match";
import { clearWalk } from "../src/game/navigation";
import { NO_GIMMICKS, timeLimitFor, TIME_RULES } from "../src/game/rules";
import {
  announcedZoneIn,
  INACTIVE_ZONE,
  RESPAWN_LOOKAHEAD,
  safeZoneAt,
  zoneWalkingGoal,
} from "../src/game/safeZone";
import { canStandAtStage, STAGES, STAGE_IDS, type StageId } from "../src/game/stages";
import { RULES } from "../src/game/tuning";
import { emptyInput, type Fighter, type PlayerInput, type Vec2 } from "../src/game/types";
import { zoneDirections, zoneStatus } from "../src/ui/zoneHud";

const dt = RULES.fixedStep;
const distance = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);
const cases = TIME_RULES.flatMap((time) => [1, 3, 5].map((stocks) => ({ time, stocks })));

function match(stage: StageId, stocks = 3, difficulty: AiLevel = "normal") {
  const engine = new BattleEngine(41);
  engine.start("duel", {
    stage,
    stocks,
    time: "short",
    difficulty,
    gimmicks: { ...NO_GIMMICKS, collapse: true, safeZone: true },
  });
  engine.state.phase = "playing";
  return engine;
}

describe("match clock and published route", () => {
  test.each(cases)(
    "$stocks stocks / $time has recurring late legs on permanent floor",
    ({ time, stocks }) => {
      const limit = timeLimitFor(stocks, time);
      for (const stage of STAGE_IDS) {
        const size = STAGES[stage].minHalfSize;
        const phases = new Set<string>();
        let firstLate = limit;
        let warnings = 0;
        let lastDeparture = 0;
        let previous = safeZoneAt(stage, 0, limit);
        for (let t = 0.25; t < limit; t += 0.25) {
          const zone = safeZoneAt(stage, t, limit);
          phases.add(zone.phase);
          if (zone.active && previous.active) {
            expect(distance(previous, zone)).toBeLessThanOrEqual(0.25 * 1.7);
            expect(Math.abs(zone.radius - previous.radius)).toBeLessThan(0.25);
          }
          if (zone.phase === "late") firstLate = Math.min(firstLate, t);
          if (zone.motion === "warning" && previous.motion !== "warning") {
            expect(zone.startsIn).toBeGreaterThan(2.75);
            const end = zone.destination!;
            expect(clearWalk(stage, size, zone, end, 0.55)).toBe(true);
            const arrival = safeZoneAt(stage, t + zone.startsIn + zone.travelLeft, limit);
            expect(distance(arrival, end)).toBeCloseTo(0);
            expect(arrival.radius).toBeCloseTo(end.radius);
            if (zone.phase === "late") {
              // The preceding safe disc and the announced disc are disjoint, including on the deck.
              expect(distance(zone, end)).toBeGreaterThan(zone.radius + end.radius);
              warnings++;
              lastDeparture = t;
            }
          }
          if (zone.motion === "travel" && previous.motion !== "travel")
            expect(previous.motion).toBe("warning");
          if (zone.motion === "hold") expect(zone.destination).toBeNull();
          previous = zone;
        }
        expect(phases).toEqual(new Set(["off", "early", "mid", "late"]));
        expect(firstLate).toBeLessThan(limit * 0.67);
        expect(warnings).toBeGreaterThanOrEqual(3);
        expect(limit - lastDeparture).toBeLessThanOrEqual(11);
      }
    },
  );

  test.each(cases)(
    "$stocks stocks / $time drives duel and rumble from their effective clocks",
    ({ time, stocks }) => {
      for (const mode of ["duel", "rumble"] as const) {
        const engine = new BattleEngine(57);
        engine.start(mode, { stage: "ruins", time, stocks });
        engine.state.phase = "playing";
        const limit = timeLimitFor(stocks, time);
        for (const fraction of [0.25, 0.48, 0.8, 0.99]) {
          engine.state.elapsed = limit * fraction;
          engine.update(dt);
          expect(engine.state.arena.safeZone).toEqual(
            safeZoneAt("ruins", engine.state.elapsed, limit),
          );
        }
      }
    },
  );

  test.each(STAGE_IDS)("%s can follow on foot after a one-second delay", (stage) => {
    const engine = match(stage);
    const [player, rival] = engine.state.fighters;
    // Short clock: 27s until the first warning, two mid legs, then the first late warning at 49s.
    engine.state.elapsed = 60;
    engine.update(dt);
    const start = engine.state.arena.safeZone;
    expect(start.phase).toBe("late");
    const end = start.destination!;
    Object.assign(player, { x: start.x, z: start.z });
    Object.assign(rival, { mode: "dead", respawnTimer: 30 });
    for (let i = 0; i < 9 / dt; i++) {
      const zone = engine.state.arena.safeZone;
      const dx = zone.x - player.x,
        dz = zone.z - player.z;
      const gap = Math.hypot(dx, dz);
      const walk = i * dt >= 4 && gap > 0.15;
      engine.update(dt, {
        ...emptyInput(),
        move: walk ? { x: dx / gap, z: dz / gap } : { x: 0, z: 0 },
      });
      expect(canStandAtStage(stage, player.x, player.z, engine.state.arena.halfSize)).toBe(true);
      expect(player.grounded).toBe(true);
      expect(player.stamina).toBe(RULES.maxStamina);
      expect(player.outsideTime).toBe(0);
      expect(zone.active).toBe(true);
    }
    expect(distance(player, end)).toBeLessThan(0.5);
  });
});

describe("fighting while the zone moves", () => {
  test.each(STAGE_IDS)("%s leaves time for an overhead and its recovery", (stage) => {
    const engine = match(stage);
    engine.state.elapsed = 63;
    engine.update(dt);
    const start = engine.state.arena.safeZone;
    const [player, rival] = engine.state.fighters;
    Object.assign(player, { x: start.x, z: start.z, outsideTime: 0, damage: 0 });
    Object.assign(rival, { mode: "dead", respawnTimer: 30 });
    const modes = new Set<string>();
    for (let tick = 0; tick < 6 / dt; tick++) {
      const zone = engine.state.arena.safeZone;
      const input = emptyInput();
      if (tick === 0) input.attackPressed = input.attackHeld = "overhead";
      if (distance(player, zone) > 0.15)
        input.move = { x: zone.x - player.x, z: zone.z - player.z };
      engine.update(dt, input);
      modes.add(player.mode);
      expect(player.outsideTime).toBe(0);
      expect(player.grounded).toBe(true);
    }
    expect(modes).toEqual(new Set(["charge", "windup", "active", "recovery", "idle"]));
    expect(distance(player, start.destination!)).toBeLessThan(0.5);
  });

  test.each(AI_LEVEL_IDS)("%s CPU walks consecutive announced legs on all four stages", (level) => {
    for (const stage of STAGE_IDS) {
      const engine = match(stage, 3, level);
      engine.state.elapsed = 49;
      engine.update(dt);
      const [rival, cpu] = engine.state.fighters;
      const start = engine.state.arena.safeZone;
      Object.assign(cpu, { x: start.x, z: start.z, outsideTime: 0 });
      Object.assign(rival, { mode: "dead", respawnTimer: 40 });
      for (let tick = 0; tick < 33 / dt; tick++) {
        engine.update(dt);
        expect(cpu.stocks, stage).toBe(3);
        expect(cpu.outsideTime, stage).toBeLessThan(1);
        expect(cpu.grounded, stage).toBe(true);
      }
    }
  });
});

describe("exposure and returning lives", () => {
  test("hitstop counts exposure, pauses freeze it, simultaneous KOs take one life apiece", () => {
    const engine = match("garden");
    engine.state.elapsed = 18;
    for (const f of engine.state.fighters) Object.assign(f, { x: 7, z: 7, hitstop: 90 });
    for (let i = 0; i < 60; i++) engine.update(dt);
    for (const f of engine.state.fighters) {
      expect(f.outsideTime).toBeCloseTo(1);
      expect(f.damage).toBeCloseTo(RULES.outsideDamage);
      Object.assign(f, { x: 0, z: 0 });
    }
    for (let i = 0; i < 15; i++) engine.update(dt);
    engine.pause();
    const snapshot = structuredClone(engine.state);
    engine.update(0.1);
    expect(engine.state).toEqual(snapshot);
    engine.resume();
    for (const f of engine.state.fighters) {
      expect(f.outsideTime).toBeCloseTo(0.5);
      Object.assign(f, { x: 7, z: 7 });
    }
    for (let i = 0; i < 270; i++) engine.update(dt);
    for (const f of engine.state.fighters) {
      expect(f.outsideTime).toBeCloseTo(5);
      expect(f.damage).toBeCloseTo(5.5 * RULES.outsideDamage);
      expect(f.eliminationReason).toBe("エリア外ゲージが5秒に到達");
      expect(f.mode).toBe("dead");
      expect(f.stocks).toBe(2);
    }
    engine.update(dt);
    expect(engine.state.fighters.map((f) => f.stocks)).toEqual([2, 2]);
  });

  test.each(STAGE_IDS)(
    "%s respawn avoids bombs, floor gaps and exposure through landing and startup",
    (stage) => {
      const engine = match(stage);
      engine.state.elapsed = 64;
      engine.update(dt);
      const now = engine.state.arena.safeZone;
      const landing = announcedZoneIn(now, RESPAWN_LOOKAHEAD);
      const [player, rival] = engine.state.fighters;
      Object.assign(player, { mode: "dead", respawnTimer: dt });
      Object.assign(rival, { x: landing.x, z: landing.z, hitstop: 30 });
      const bomb = {
        id: 1,
        x: now.x,
        z: now.z,
        radius: 0.7,
        timer: 2,
        duration: 2,
        exploded: false,
      };
      engine.state.bombs.push(bomb);
      engine.update(dt);
      expect(player.grounded).toBe(false);
      expect(distance(player, bomb)).toBeGreaterThan(bomb.radius + 0.3);
      expect(distance(player, rival)).toBeGreaterThan(0.6);
      expect(distance(player, landing)).toBeLessThan(landing.radius);
      for (let i = 0; i < RESPAWN_LOOKAHEAD / dt; i++) {
        engine.update(dt);
        expect(player.outsideTime).toBe(0);
        expect(canStandAtStage(stage, player.x, player.z, engine.state.arena.halfSize)).toBe(true);
      }
      expect(player.grounded).toBe(true);
    },
  );
});

describe("human and CPU information", () => {
  test.each(AI_LEVEL_IDS)(
    "%s acts on visible warnings only, even while waiting for a rival",
    (level) => {
      const engine = match("garden", 3, level);
      const [rival, cpu] = engine.state.fighters;
      const think = () =>
        (engine as unknown as { ai(f: Fighter, dt: number): PlayerInput }).ai(cpu, dt);
      const warned = safeZoneAt("garden", 60, 90);
      const end = warned.destination!;
      const away = { x: Math.sign(warned.x - end.x), z: Math.sign(warned.z - end.z) };
      Object.assign(cpu, { x: warned.x + away.x * 1.35, z: warned.z + away.z * 1.35, aiThink: 20 });
      Object.assign(rival, { mode: "dead", respawnTimer: 20 });
      engine.state.elapsed = 59.9;
      engine.state.arena.safeZone = safeZoneAt("garden", 59.9, 90);
      expect(think().move).toEqual({ x: 0, z: 0 });
      engine.state.elapsed = 81; // Same published state, private clock would predict another leg.
      expect(think().move).toEqual({ x: 0, z: 0 });
      engine.state.arena.safeZone = warned;
      for (const mode of ["dead", "idle"]) {
        Object.assign(rival, { mode });
        const move = think().move;
        expect(move.x * away.x + move.z * away.z).toBeLessThan(-1);
      }
      expect(zoneStatus(warned)).toContain("3秒");
      expect(zoneDirections(warned, cpu)).toContain("次");
      expect(zoneDirections(safeZoneAt("garden", 59.9, 90), cpu)).not.toContain("次");
    },
  );

  test.each(["training", "duel"] as const)(
    "%s with no effective zone has no cues or bias",
    (mode) => {
      const engine = new BattleEngine(11);
      engine.start(mode, { gimmicks: { ...NO_GIMMICKS, safeZone: mode === "training" } });
      engine.state.phase = "playing";
      for (const f of engine.state.fighters) Object.assign(f, { x: 7, z: 7, hitstop: 100 });
      for (const t of [10, 45, 63, 95, 140]) {
        engine.state.elapsed = t;
        engine.update(dt);
        const zone = engine.state.arena.safeZone;
        expect(zone).toEqual(INACTIVE_ZONE);
        expect(zoneStatus(zone)).toBe("");
        expect(zoneDirections(zone, { x: 7, z: 7 })).toBe("");
        for (const level of AI_LEVEL_IDS)
          expect(zoneWalkingGoal(zone, { x: 7, z: 7 }, level)).toBeNull();
        for (const f of engine.state.fighters) expect([f.outsideTime, f.damage]).toEqual([0, 0]);
      }
    },
  );
});
