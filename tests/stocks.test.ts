import { describe, expect, test } from "vite-plus/test";
import { BattleEngine, matchTimeLimit } from "../src/game/engine";
import { ATTACKS, RULES } from "../src/game/tuning";
import { emptyInput, type Fighter, type MatchMode, type PlayerInput } from "../src/game/types";

const DT = 1 / 60;

function advance(engine: BattleEngine, seconds: number) {
  for (let frame = 0; frame < Math.ceil(seconds / DT); frame++) engine.update(DT, emptyInput());
}

/** CPUs frozen in place (long hitstop) so only the rules under test move anything. */
function fixture(stocks: number, mode: MatchMode = "duel") {
  const engine = new BattleEngine(777);
  engine.start(mode, { stocks });
  engine.state.phase = "playing";
  const player = engine.state.fighters[0];
  for (const cpu of engine.state.fighters.slice(1)) cpu.hitstop = 1e6;
  return { engine, player, cpu: engine.state.fighters[1] };
}

/** Knocks `f` far below the floor; the next tick eliminates it. */
function drop(engine: BattleEngine, f: Fighter) {
  Object.assign(f, { y: -20, vy: 0, grounded: false, hitstop: 0 });
  engine.update(DT, emptyInput());
}

function waitForRespawn(engine: BattleEngine, f: Fighter): number {
  let frames = 0;
  while (f.mode === "dead" && frames < 600) {
    engine.update(DT, emptyInput());
    frames++;
  }
  return frames;
}

function makeActive(f: Fighter, attack: "sweep" | "overhead" = "sweep") {
  Object.assign(f, {
    mode: "active",
    modeTime: 0,
    modeDuration: ATTACKS[attack].active,
    attack,
    charge: 0,
    hitTargets: [],
    hitstop: 0,
    swingId: f.swingId + 1,
  });
}

const think = (engine: BattleEngine, f: Fighter): PlayerInput =>
  (engine as unknown as { ai(f: Fighter, dt: number): PlayerInput }).ai(f, DT);

describe("losing a life and coming back", () => {
  test("a fall with lives left downs the fighter, credits the kill and starts the respawn timer", () => {
    const { engine, player, cpu } = fixture(3);
    player.lastAttacker = cpu.id;
    player.lastHitAt = engine.state.elapsed;
    drop(engine, player);
    expect(player.mode).toBe("dead");
    expect(player.stocks).toBe(2);
    expect(player.respawnTimer).toBeCloseTo(RULES.respawnDelay, 8);
    expect(player.eliminatedAt).toBeCloseTo(engine.state.elapsed, 8);
    expect(player.eliminationReason).toBeTruthy();
    expect(cpu.kills).toBe(1);
    expect(engine.state.effects.some((e) => e.kind === "ko")).toBe(true);
    expect(engine.state.message).toBe(`${player.name} DOWN — 残り2`);
    expect(engine.state.phase).toBe("playing");
  });

  test("after the delay it drops in near the centre, away from the opponent, with a clean state", () => {
    const { engine, player, cpu } = fixture(3);
    Object.assign(player, {
      damage: 88,
      stamina: 12,
      airRisingUsed: true,
      airThrustUsed: true,
      airStepUsed: true,
      kills: 2,
      lastAttacker: cpu.id,
      lastHitAt: engine.state.elapsed,
    });
    drop(engine, player);
    const frames = waitForRespawn(engine, player);
    expect(Math.abs(frames - RULES.respawnDelay / DT)).toBeLessThanOrEqual(1);
    expect(player.mode).toBe("idle");
    expect(player.stocks).toBe(2);
    expect(player.kills).toBe(2);
    expect(player.human).toBe(true);
    expect(player.damage).toBe(0);
    expect(player.stamina).toBe(RULES.maxStamina);
    expect(player.airRisingUsed || player.airThrustUsed || player.airStepUsed).toBe(false);
    expect(player.lastAttacker).toBeNull();
    expect(player.lastHitAt).toBe(-Infinity);
    expect(player.eliminatedAt).toBeNull();
    expect(player.respawnTimer).toBe(0);
    expect(player.grounded).toBe(false);
    expect(player.y).toBeGreaterThan(RULES.respawnHeight - 0.1);
    expect(player.y).toBeLessThanOrEqual(RULES.respawnHeight);
    expect(player.vx).toBe(0);
    expect(player.vz).toBe(0);
    expect(player.invulnerable).toBeGreaterThan(RULES.respawnInvulnerable - 2 * DT);
    // The CPU stands at (3.5, 0): the farthest candidate within 3 of the centre is (-3, 0).
    expect(player.x).toBeCloseTo(-3, 6);
    expect(player.z).toBeCloseTo(0, 6);
    expect(Math.hypot(player.x, player.z)).toBeLessThanOrEqual(3 + 1e-6);
    expect(player.facing).toBeCloseTo(Math.atan2(cpu.x - player.x, cpu.z - player.z), 6);
    advance(engine, 1);
    expect(player.grounded).toBe(true);
    expect(player.y).toBe(0);
  });

  test("it appears inside the active safe zone, over the platform with a margin", () => {
    const { engine, player } = fixture(2);
    engine.state.elapsed = 75;
    engine.update(DT, emptyInput());
    engine.state.bombs = [];
    drop(engine, player);
    waitForRespawn(engine, player);
    const { safeZone: zone, halfSize } = engine.state.arena;
    expect(zone.active).toBe(true);
    expect(Math.hypot(player.x - zone.x, player.z - zone.z)).toBeLessThanOrEqual(
      zone.radius * 0.55 + 1e-6,
    );
    expect(Math.abs(player.x)).toBeLessThanOrEqual(halfSize - 1 + 1e-6);
    expect(Math.abs(player.z)).toBeLessThanOrEqual(halfSize - 1 + 1e-6);
  });

  test("it never appears inside a pending bomb", () => {
    const { engine, player } = fixture(2);
    drop(engine, player);
    engine.state.bombs = [-3, 0, 3].map((x, id) => ({
      id,
      x,
      z: 0,
      radius: 1.45,
      timer: 10,
      duration: 10,
      exploded: false,
    }));
    waitForRespawn(engine, player);
    expect(player.mode).toBe("idle");
    for (const bomb of engine.state.bombs) {
      expect(Math.hypot(player.x - bomb.x, player.z - bomb.z)).toBeGreaterThan(bomb.radius + 0.3);
    }
  });

  test("it is invulnerable for the configured time, then hittable again", () => {
    const { engine, player, cpu } = fixture(3);
    drop(engine, player);
    waitForRespawn(engine, player);
    advance(engine, 1);
    expect(player.grounded).toBe(true);
    expect(player.invulnerable).toBeGreaterThan(0);
    // A swing and a bomb on top of it both do nothing.
    Object.assign(cpu, { x: player.x, z: player.z - 1, facing: 0 });
    makeActive(cpu);
    engine.state.bombs.push({
      id: 99,
      x: player.x,
      z: player.z,
      radius: 1.45,
      timer: DT / 2,
      duration: 1,
      exploded: false,
    });
    engine.update(DT, emptyInput());
    expect(player.damage).toBe(0);
    expect(player.mode).toBe("idle");
    expect(cpu.hitTargets).not.toContain(player.id);
    cpu.hitstop = 1e6;
    advance(engine, RULES.respawnInvulnerable - 1 - 0.1);
    expect(player.invulnerable).toBeGreaterThan(0);
    advance(engine, 0.15);
    expect(player.invulnerable).toBe(0);
    Object.assign(cpu, { x: player.x, z: player.z - 1, facing: 0 });
    makeActive(cpu);
    engine.update(DT, emptyInput());
    expect(player.damage).toBeGreaterThan(0);
  });

  test("an invulnerable newcomer can act normally", () => {
    const { engine, player } = fixture(3);
    drop(engine, player);
    waitForRespawn(engine, player);
    advance(engine, 1);
    engine.update(DT, { ...emptyInput(), attackPressed: "sweep", attackHeld: "sweep" });
    expect(player.mode).toBe("charge");
  });
});

describe("winning with stocks", () => {
  test("the match continues until only one fighter has lives left", () => {
    const { engine, player, cpu } = fixture(2);
    drop(engine, player);
    expect(engine.state.phase).toBe("playing");
    waitForRespawn(engine, player);
    drop(engine, player);
    expect(player.stocks).toBe(0);
    expect(player.respawnTimer).toBe(0);
    expect(player.mode).toBe("dead");
    expect(engine.state.phase).toBe("ended");
    expect(engine.state.winnerId).toBe(cpu.id);
    advance(engine, RULES.respawnDelay + 0.2);
    expect(player.mode).toBe("dead");
  });

  test("a fighter waiting to respawn is still in the match", () => {
    const { engine, player, cpu } = fixture(2);
    drop(engine, player);
    drop(engine, cpu);
    expect(engine.state.phase).toBe("playing");
    expect(player.mode).toBe("dead");
    expect(cpu.mode).toBe("dead");
  });

  test("the clock grows with stocks", () => {
    expect(matchTimeLimit(1)).toBe(RULES.maxMatchTime);
    expect(matchTimeLimit(3)).toBe(RULES.maxMatchTime + 2 * RULES.matchTimePerStock);
    const { engine } = fixture(3);
    engine.state.elapsed = RULES.maxMatchTime + 1;
    engine.update(DT, emptyInput());
    expect(engine.state.phase).toBe("playing");
  });

  /** Both fighters inside the late safe zone so the zone adds no damage on the deciding tick. */
  function timeUp(stocks: [number, number], damage: [number, number]) {
    const { engine, player, cpu } = fixture(3);
    Object.assign(player, { x: -0.5, z: 0, stocks: stocks[0], damage: damage[0] });
    Object.assign(cpu, { x: 0.5, z: 0, stocks: stocks[1], damage: damage[1] });
    engine.state.elapsed = matchTimeLimit(3) - DT / 2;
    engine.update(DT, emptyInput());
    expect(engine.state.phase).toBe("ended");
    return engine.state.winnerId;
  }

  test("at time-up the most stocks win, then the least damage, else a draw", () => {
    expect(timeUp([3, 2], [90, 10])).toBe(0);
    expect(timeUp([1, 2], [0, 120])).toBe(1);
    expect(timeUp([2, 2], [40, 30])).toBe(1);
    expect(timeUp([2, 2], [30, 30.005])).toBeNull();
  });
});

describe("one stock and training keep the old rules", () => {
  test("with one stock a fall ends a duel at once", () => {
    const { engine, player, cpu } = fixture(1);
    drop(engine, player);
    expect(player.mode).toBe("dead");
    expect(player.stocks).toBe(0);
    expect(player.respawnTimer).toBe(0);
    expect(engine.state.phase).toBe("ended");
    expect(engine.state.winnerId).toBe(cpu.id);
    expect(engine.state.message).toBe(`${cpu.name} WINS`);
  });

  test("with one stock time-up comes at the old limit and ranks by damage", () => {
    const { engine, player, cpu } = fixture(1);
    Object.assign(player, { x: -0.5, z: 0, damage: 20 });
    Object.assign(cpu, { x: 0.5, z: 0, damage: 50 });
    engine.state.elapsed = RULES.maxMatchTime - DT / 2;
    engine.update(DT, emptyInput());
    expect(engine.state.phase).toBe("ended");
    expect(engine.state.winnerId).toBe(player.id);
    expect(engine.state.message).toBe("TIME UP — 蓄積ダメージの少ない選手が勝利");
  });

  test("with one stock in a rumble the last fighter standing wins", () => {
    const { engine } = fixture(1, "rumble");
    const [a, b, c, d] = engine.state.fighters;
    drop(engine, a);
    drop(engine, b);
    expect(engine.state.phase).toBe("playing");
    drop(engine, d);
    expect(engine.state.phase).toBe("ended");
    expect(engine.state.winnerId).toBe(c.id);
  });

  test("training ignores stocks: anyone who falls is rebuilt after 1.5 s, for ever", () => {
    const { engine } = fixture(2, "training");
    for (let round = 0; round < 3; round++) {
      const player = engine.state.fighters[0];
      drop(engine, player);
      expect(player.mode).toBe("dead");
      expect(player.stocks).toBe(2);
      expect(player.respawnTimer).toBe(0);
      expect(engine.state.message).toBe(`${player.name} OUT`);
      advance(engine, 1.4);
      expect(engine.state.fighters[0].mode).toBe("dead");
      advance(engine, 0.2);
      const rebuilt = engine.state.fighters[0];
      expect(rebuilt).not.toBe(player);
      expect(rebuilt.mode).toBe("idle");
      expect(rebuilt.grounded).toBe(true);
      expect(rebuilt.invulnerable).toBe(0);
      expect(engine.state.phase).toBe("playing");
    }
  });
});

describe("a fighter waiting to respawn is out of play", () => {
  test("attacks, bombs and body separation pass through it", () => {
    const { engine, player, cpu } = fixture(3);
    drop(engine, cpu);
    expect(cpu.mode).toBe("dead");
    Object.assign(cpu, { x: 0, y: 0, z: 1, hitstop: 0 });
    Object.assign(player, { x: 0, y: 0, z: 0.2, facing: 0 });
    makeActive(player);
    engine.state.bombs.push({
      id: 99,
      x: 0,
      z: 1,
      radius: 1.45,
      timer: DT / 2,
      duration: 1,
      exploded: false,
    });
    const damage = cpu.damage;
    engine.update(DT, emptyInput());
    expect(cpu.damage).toBe(damage);
    expect(player.hitTargets).not.toContain(cpu.id);
    expect(cpu.x).toBe(0);
    expect(cpu.z).toBe(1);
    expect(cpu.mode).toBe("dead");
  });

  test("grabs miss it", () => {
    const { engine, player, cpu } = fixture(3);
    drop(engine, cpu);
    Object.assign(cpu, { x: 0, y: 0, z: 0.95, grounded: true });
    Object.assign(player, { x: 0, z: 0, facing: 0 });
    engine.update(DT, { ...emptyInput(), grab: true });
    advance(engine, RULES.grabStartup + RULES.grabActive);
    expect(player.mode).not.toBe("throw");
    expect(cpu.grabbedBy).toBeNull();
  });

  test("its out-of-zone gauge does not run", () => {
    const { engine, player } = fixture(3);
    engine.state.elapsed = RULES.safeZoneStart + 1;
    drop(engine, player);
    Object.assign(player, { x: 8, z: 8 });
    const outside = player.outsideTime;
    advance(engine, 1);
    expect(player.outsideTime).toBe(outside);
  });

  test("the AI does not target it", () => {
    const duel = fixture(3);
    drop(duel.engine, duel.player);
    duel.cpu.hitstop = 0;
    const alone = think(duel.engine, duel.cpu);
    expect(alone.aim).toBeNull();
    expect(alone.attackPressed).toBeNull();

    const rumble = fixture(3, "rumble");
    const [, hunter, corpse, living] = rumble.engine.state.fighters;
    drop(rumble.engine, corpse);
    Object.assign(hunter, { x: 0, z: 0 });
    Object.assign(corpse, { x: 0, z: 1 });
    Object.assign(living, { x: 3, z: 0 });
    Object.assign(rumble.player, { x: -6, z: -6 });
    const input = think(rumble.engine, hunter);
    expect(input.aim!.x).toBeCloseTo(1, 6);
    expect(input.aim!.z).toBeCloseTo(0, 6);
  });
});
