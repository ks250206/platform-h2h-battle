import { describe, expect, test } from "vite-plus/test";
import { BattleEngine, canStandAt } from "../src/game/engine";
import { RULES } from "../src/game/tuning";
import { emptyInput } from "../src/game/types";

const DT = 1 / 60;

function advance(engine: BattleEngine, seconds: number) {
  for (let frame = 0; frame < Math.ceil(seconds / DT); frame++) engine.update(DT, emptyInput());
}

function fixture() {
  const engine = new BattleEngine(54321);
  engine.start("duel");
  engine.state.phase = "playing";
  for (const fighter of engine.state.fighters) {
    // Stop movement/AI while preserving the world clock and environmental rules.
    Object.assign(fighter, { x: 0, y: 0, z: 0, hitstop: 1000, invulnerable: 1000 });
  }
  const player = engine.state.fighters.find((fighter) => fighter.human)!;
  return { engine, player };
}

describe("platform support and shrinking geometry", () => {
  test("only the current platform supports standing", () => {
    const { engine } = fixture();
    expect(canStandAt(engine.state, 0, 0)).toBe(true);
    expect(canStandAt(engine.state, engine.state.arena.halfSize + 1, 0)).toBe(false);
    expect(canStandAt(engine.state, 0, -engine.state.arena.halfSize - 1)).toBe(false);
    expect((RULES.minHalfSize * 2) / RULES.tileSize).toBe(5);
    engine.state.arena.halfSize = RULES.minHalfSize;
    expect(canStandAt(engine.state, RULES.minHalfSize + 1, 0)).toBe(false);
    expect(canStandAt(engine.state, 0, 0)).toBe(true);
  });

  test("the first collapse is telegraphed and removes an outer tile ring", () => {
    const { engine } = fixture();
    const initialSize = engine.state.arena.halfSize;
    engine.state.elapsed = RULES.collapseStart - RULES.collapseWarning / 2;
    engine.update(DT, emptyInput());
    expect(engine.state.arena.warningRing).toBe(true);
    expect(engine.state.arena.halfSize).toBe(initialSize);
    engine.state.elapsed = RULES.collapseStart + DT;
    engine.update(DT, emptyInput());
    expect(engine.state.arena.halfSize).toBe(initialSize - RULES.tileSize);
    expect(engine.state.arena.halfSize).toBeGreaterThanOrEqual(RULES.minHalfSize);
  });

  test.each([19, 31, 33, 55, 77, 111, 149])(
    "the moving safe zone remains on surviving floor at %ss",
    (elapsed) => {
      const { engine } = fixture();
      engine.state.elapsed = elapsed;
      engine.update(DT, emptyInput());
      const { safeZone, halfSize } = engine.state.arena;
      expect(safeZone.active).toBe(true);
      expect(safeZone.radius).toBeGreaterThan(0);
      expect(Math.abs(safeZone.x) + safeZone.radius).toBeLessThanOrEqual(halfSize + 1e-6);
      expect(Math.abs(safeZone.z) + safeZone.radius).toBeLessThanOrEqual(halfSize + 1e-6);
      expect(canStandAt(engine.state, safeZone.x, safeZone.z)).toBe(true);
    },
  );
});

describe("outside exposure and environmental pressure", () => {
  function outsideFixture() {
    const { engine, player } = fixture();
    engine.state.elapsed = RULES.safeZoneStart + 1;
    engine.update(DT, emptyInput());
    const edge = engine.state.arena.halfSize - 0.7;
    Object.assign(player, { x: edge, z: edge });
    const zone = engine.state.arena.safeZone;
    expect(Math.hypot(player.x - zone.x, player.z - zone.z)).toBeGreaterThan(zone.radius);
    return { engine, player };
  }

  test("outside damage and exposure progress through hitstop; five seconds eliminates", () => {
    const { engine, player } = outsideFixture();
    advance(engine, 1);
    expect(player.hitstop).toBeGreaterThan(0);
    expect(player.outsideTime).toBeCloseTo(1, 1);
    expect(player.damage).toBeGreaterThanOrEqual(RULES.outsideDamage - 0.1);
    advance(engine, RULES.outsideLimit - 1 + 0.05);
    expect(player.mode).toBe("dead");
    expect(player.eliminationReason).toBeTruthy();
  });

  test("re-entering safety recovers exposure gradually while accumulated damage remains", () => {
    const { engine, player } = outsideFixture();
    advance(engine, 2);
    const exposure = player.outsideTime;
    const damage = player.damage;
    Object.assign(player, {
      x: engine.state.arena.safeZone.x,
      z: engine.state.arena.safeZone.z,
    });
    engine.update(DT, emptyInput());
    expect(player.outsideTime).toBeGreaterThan(0);
    expect(player.outsideTime).toBeLessThan(exposure);
    advance(engine, 0.4);
    expect(player.outsideTime).toBeCloseTo(exposure - RULES.outsideRecovery * (0.4 + DT), 1);
    expect(player.damage).toBeGreaterThanOrEqual(damage);
    advance(engine, 1);
    expect(player.outsideTime).toBe(0);
  });

  test("bombardments warn before dealing damage and damage occupants when they land", () => {
    const { engine, player } = fixture();
    engine.state.elapsed = RULES.bombStart + DT;
    engine.update(DT, emptyInput());
    const warning = engine.state.bombs.find((bomb) => !bomb.exploded);
    expect(warning).toBeDefined();
    Object.assign(player, { x: warning!.x, z: warning!.z, invulnerable: 0 });
    const damage = player.damage;
    advance(engine, 0.2);
    expect(player.damage).toBe(damage);
    advance(engine, RULES.bombWarning);
    expect(player.damage).toBeGreaterThan(damage);
  });

  test("pausing freezes the world and resuming preserves its elapsed state", () => {
    const { engine, player } = outsideFixture();
    advance(engine, 0.5);
    engine.pause();
    const before = {
      elapsed: engine.state.elapsed,
      outsideTime: player.outsideTime,
      damage: player.damage,
    };
    advance(engine, 1);
    expect({
      elapsed: engine.state.elapsed,
      outsideTime: player.outsideTime,
      damage: player.damage,
    }).toEqual(before);
    engine.resume();
    engine.update(DT, emptyInput());
    expect(engine.state.elapsed).toBeGreaterThan(before.elapsed);
    expect(player.outsideTime).toBeGreaterThan(before.outsideTime);
  });
});
