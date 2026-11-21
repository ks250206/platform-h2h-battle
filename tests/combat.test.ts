import { describe, expect, test } from "vite-plus/test";
import { BattleEngine, attackContains, attacksClash, directionInfluence } from "../src/game/engine";
import { ATTACKS, RULES } from "../src/game/tuning";
import { emptyInput, type AttackId, type Fighter, type PlayerInput } from "../src/game/types";

const DT = 1 / 60;

function advance(engine: BattleEngine, seconds: number, input: PlayerInput = emptyInput()) {
  for (let frame = 0; frame < Math.ceil(seconds / DT); frame++) engine.update(DT, input);
}

function fixture() {
  const engine = new BattleEngine(12345);
  engine.start("training");
  engine.state.phase = "playing";
  const player = engine.state.fighters.find((fighter) => fighter.human)!;
  const target = engine.state.fighters.find((fighter) => fighter.id !== player.id)!;
  Object.assign(player, { x: 0, y: 0, z: -3, facing: 0, grounded: true });
  Object.assign(target, { x: 0, y: 0, z: 3, facing: Math.PI, grounded: true });
  return { engine, player, target };
}

function startCharge(engine: BattleEngine, attack: AttackId = "overhead") {
  engine.update(DT, { ...emptyInput(), attackPressed: attack, attackHeld: attack });
}

function makeActive(fighter: Fighter, attack: AttackId = "sweep") {
  Object.assign(fighter, {
    mode: "active",
    modeTime: 0,
    modeDuration: ATTACKS[attack].active,
    attack,
    charge: 0,
    hitTargets: [],
    hitstop: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    swingId: fighter.swingId + 1,
  });
}

describe("committed, stamina-limited greatsword attacks", () => {
  test("a feint consumes the reservation, and cannot be cancelled again to refund it", () => {
    const { engine, player } = fixture();
    startCharge(engine);
    expect(player.mode).toBe("charge");
    expect(player.stamina).toBe(RULES.maxStamina - RULES.chargeCost);
    engine.update(DT, { ...emptyInput(), attackHeld: "overhead", cancel: true });
    expect(player.mode).toBe("cancel");
    expect(player.stamina).toBe(RULES.maxStamina - RULES.chargeCost);
    advance(engine, RULES.cancelDuration + DT, { ...emptyInput(), cancel: true });
    expect(player.mode).toBe("idle");
    expect(player.stamina).toBe(RULES.maxStamina - RULES.chargeCost);
    expect(player.staminaDelay).toBeGreaterThan(0);
  });

  test("releasing charges the remaining cost and commits through step input", () => {
    const { engine, player } = fixture();
    startCharge(engine, "overhead");
    engine.update(DT, emptyInput());
    expect(player.mode).toBe("windup");
    expect(player.stamina).toBe(RULES.maxStamina - ATTACKS.overhead.stamina);
    engine.update(DT, { ...emptyInput(), step: true, move: { x: 1, z: 0 } });
    expect(player.mode).toBe("windup");
    expect(player.stamina).toBe(RULES.maxStamina - ATTACKS.overhead.stamina);
  });

  test("a step feint costs the reservation plus a full step, with a vulnerable delay", () => {
    const { engine, player } = fixture();
    startCharge(engine);
    engine.update(DT, {
      ...emptyInput(),
      attackHeld: "overhead",
      step: true,
      move: { x: 1, z: 0 },
    });
    expect(player.stamina).toBe(RULES.maxStamina - RULES.chargeCost - RULES.stepCost);
    expect(player.stepDelay).toBeGreaterThan(0);
    expect(player.invulnerable).toBeLessThanOrEqual(0);
  });

  test("insufficient stamina rejects attacks and steps but preserves walking and jumping", () => {
    const { engine, player } = fixture();
    player.stamina = 0;
    player.staminaDelay = 10;
    const startX = player.x;
    engine.update(DT, {
      ...emptyInput(),
      attackPressed: "overhead",
      attackHeld: "overhead",
      step: true,
      move: { x: 1, z: 0 },
    });
    expect(["charge", "windup", "step"]).not.toContain(player.mode);
    expect(player.x).toBeGreaterThan(startX);
    engine.update(DT, { ...emptyInput(), jump: true });
    expect(player.grounded).toBe(false);
    expect(player.vy).toBeGreaterThan(0);
  });

  test("landing does not erase committed attack recovery", () => {
    const { engine, player } = fixture();
    Object.assign(player, {
      grounded: false,
      y: 0.01,
      vy: -1,
      mode: "recovery",
      modeTime: 0,
      modeDuration: ATTACKS.overhead.recovery,
      attack: "overhead",
    });
    advance(engine, 0.08);
    expect(player.grounded).toBe(true);
    expect(player.mode).toBe("recovery");
  });
});

describe("cancelling a committed wind-up", () => {
  const cancelInput = (): PlayerInput => ({ ...emptyInput(), cancel: true });

  /** Tap (press, then release on the next tick) so the attack commits into its wind-up. */
  function tap(engine: BattleEngine, attack: AttackId = "overhead") {
    startCharge(engine, attack);
    engine.update(DT, emptyInput());
  }

  /** Steps with no input until the fighter reaches `mode`; fails instead of looping forever. */
  function advanceUntil(engine: BattleEngine, fighter: Fighter, mode: Fighter["mode"]) {
    for (let frame = 0; frame < 240 && fighter.mode !== mode; frame++) engine.update(DT);
    expect(fighter.mode).toBe(mode);
  }

  /** Cancels once the wind-up has run `fraction` of its startup; returns the cancel's cost. */
  function cancelAt(fraction: number) {
    const { engine, player } = fixture();
    tap(engine);
    const startup = ATTACKS.overhead.startup;
    while (player.modeTime + DT < fraction * startup) engine.update(DT);
    const progress = (player.modeTime + DT) / startup;
    engine.update(DT, cancelInput());
    expect(player.mode).toBe("cancel");
    const duration = player.modeDuration;
    let frames = 0;
    while (player.mode === "cancel" && frames < 120) {
      engine.update(DT);
      frames++;
    }
    expect(player.mode).toBe("idle");
    return { duration, frames, progress };
  }

  test("a tapped attack cancelled in its wind-up never becomes active and cannot hit", () => {
    const { engine, player, target } = fixture();
    Object.assign(target, { z: -1 });
    tap(engine);
    expect(player.mode).toBe("windup");
    advance(engine, 0.1);
    engine.update(DT, cancelInput());
    expect(player.mode).toBe("cancel");
    expect(player.attack).toBeNull();
    expect(player.charge).toBe(0);
    expect(engine.state.effects.some((effect) => effect.kind === "cancel")).toBe(true);
    const modes = new Set<Fighter["mode"]>();
    const swing = ATTACKS.overhead;
    for (let frame = 0; frame < (swing.startup + swing.active + swing.recovery) / DT; frame++) {
      engine.update(DT);
      modes.add(player.mode);
    }
    expect(modes.has("idle")).toBe(true);
    expect(modes.has("active")).toBe(false);
    expect(modes.has("recovery")).toBe(false);
    expect(target.damage).toBe(0);
    expect(engine.state.stats.hits).toBe(0);
  });

  test("a wind-up cancel keeps the full attack cost spent, unlike a charge cancel", () => {
    const windup = fixture();
    tap(windup.engine);
    windup.engine.update(DT, cancelInput());
    expect(windup.player.mode).toBe("cancel");
    expect(windup.player.stamina).toBe(RULES.maxStamina - ATTACKS.overhead.stamina);
    expect(windup.player.staminaDelay).toBe(RULES.staminaDelay);

    const charge = fixture();
    startCharge(charge.engine);
    charge.engine.update(DT, { ...cancelInput(), attackHeld: "overhead" });
    expect(charge.player.mode).toBe("cancel");
    expect(charge.player.modeDuration).toBe(RULES.cancelDuration);
    expect(charge.player.stamina).toBe(RULES.maxStamina - RULES.chargeCost);

    advanceUntil(windup.engine, windup.player, "idle");
    expect(windup.player.stamina).toBe(RULES.maxStamina - ATTACKS.overhead.stamina);
  });

  test("a later wind-up cancel takes longer to arrest the blade", () => {
    const early = cancelAt(0);
    const late = cancelAt(0.9);
    expect(early.duration).toBeCloseTo(
      RULES.cancelDuration + RULES.windupCancelPenalty * early.progress,
      8,
    );
    expect(early.duration).toBeLessThan(RULES.cancelDuration + 0.01);
    expect(late.progress).toBeGreaterThan(0.85);
    expect(late.progress).toBeLessThan(1);
    expect(late.duration).toBeCloseTo(
      RULES.cancelDuration + RULES.windupCancelPenalty * late.progress,
      8,
    );
    expect(late.duration).toBeLessThanOrEqual(RULES.cancelDuration + RULES.windupCancelPenalty);
    expect(late.frames).toBeGreaterThan(early.frames + 6);
  });

  test.each(["active", "recovery"] as const)(
    "the cancel input does nothing during %s and the attack completes",
    (mode) => {
      const { engine, player } = fixture();
      tap(engine);
      advanceUntil(engine, player, mode);
      engine.update(DT, cancelInput());
      expect(player.mode).toBe(mode);
      expect(player.attack).toBe("overhead");
      if (mode === "active") advanceUntil(engine, player, "recovery");
      advanceUntil(engine, player, "idle");
    },
  );

  test("a cancel arriving on the tick the wind-up ends is too late", () => {
    const { engine, player } = fixture();
    tap(engine);
    while (player.modeTime + DT + 1e-7 < ATTACKS.overhead.startup) engine.update(DT);
    expect(player.mode).toBe("windup");
    engine.update(DT, cancelInput());
    expect(player.mode).toBe("active");
  });

  test("a grounded cancelled rising cut leaves the air riser available for the next jump", () => {
    const { engine, player } = fixture();
    tap(engine, "rising");
    expect(player.airRisingUsed).toBe(true);
    engine.update(DT, cancelInput());
    expect(player.grounded).toBe(true);
    expect(player.airRisingUsed).toBe(false);
    expect(player.airThrustUsed).toBe(false);
    advanceUntil(engine, player, "idle");
    engine.update(DT, { ...emptyInput(), jump: true });
    advance(engine, 0.05);
    expect(player.grounded).toBe(false);
    tap(engine, "rising");
    expect(player.mode).toBe("windup");
    advanceUntil(engine, player, "active");
    expect(player.grounded).toBe(false);
    expect(player.vy).toBeGreaterThan(0);
    expect(player.airRisingUsed).toBe(true);
  });

  test.each(["rising", "thrust"] as const)(
    "an airborne cancelled %s keeps its air use consumed until landing",
    (attack) => {
      const { engine, player } = fixture();
      const token = attack === "rising" ? "airRisingUsed" : "airThrustUsed";
      Object.assign(player, { grounded: false, y: 5, vy: 0 });
      tap(engine, attack);
      expect(player[token]).toBe(true);
      engine.update(DT, cancelInput());
      expect(player.mode).toBe("cancel");
      expect(player[token]).toBe(true);
      advanceUntil(engine, player, "idle");
      expect(player.grounded).toBe(false);
      const stamina = player.stamina;
      startCharge(engine, attack);
      expect(player.mode).not.toBe("charge");
      expect(player.stamina).toBe(stamina);
      Object.assign(player, { y: 0.01, vy: -1 });
      advance(engine, 0.05);
      expect(player.grounded).toBe(true);
      expect(player[token]).toBe(false);
    },
  );
});

describe("directional step and attack geometry", () => {
  test("a side step preserves facing even when aim changes during it", () => {
    const { engine, player } = fixture();
    player.facing = 0.7;
    const facing = player.facing;
    const startX = player.x;
    engine.update(DT, { ...emptyInput(), step: true, move: { x: 1, z: 0 } });
    advance(engine, 0.12, { ...emptyInput(), aim: { x: -1, z: 0 } });
    expect(player.mode).toBe("step");
    expect(player.x).toBeGreaterThan(startX);
    expect(player.facing).toBeCloseTo(facing, 8);
  });

  test.each([
    { age: 0.03, shouldHit: true, phase: "startup" },
    { age: 0.12, shouldHit: false, phase: "invulnerable middle" },
    { age: 0.24, shouldHit: true, phase: "recovery" },
  ])("the step is vulnerable only outside its middle window: $phase", ({ age, shouldHit }) => {
    const { engine, player, target } = fixture();
    engine.update(DT, { ...emptyInput(), step: true, move: { x: 1, z: 0 } });
    advance(engine, age);
    Object.assign(target, { x: player.x, y: player.y, z: player.z - 0.9, facing: 0 });
    makeActive(target);
    engine.update(DT, emptyInput());
    expect(player.damage > 0).toBe(shouldHit);
  });

  test("thrust has forward reach but rejects a sidestep and an overhead height mismatch", () => {
    const { player, target } = fixture();
    Object.assign(player, { x: 0, y: 0, z: 0, facing: 0 });
    makeActive(player, "thrust");
    Object.assign(target, { x: 0, y: 0, z: 2 });
    expect(attackContains(player, target)).toBe(true);
    target.x = 1.6;
    expect(attackContains(player, target)).toBe(false);
    Object.assign(target, { x: 0, y: RULES.bodyHeight + 4 });
    expect(attackContains(player, target)).toBe(false);
  });

  test("one swing cannot hit the same fighter twice, even when the target re-enters it", () => {
    const { engine, player, target } = fixture();
    Object.assign(player, { x: 0, z: 0, facing: 0 });
    Object.assign(target, { x: 0, z: 1.2 });
    makeActive(player);
    engine.update(DT, emptyInput());
    const damage = target.damage;
    expect(damage).toBeGreaterThan(0);
    expect(player.hitTargets).toContain(target.id);
    // Remove the target's hit response so only per-swing deduplication can protect it.
    Object.assign(player, { hitstop: 0 });
    Object.assign(target, {
      x: 0,
      y: 0,
      z: 1.2,
      vx: 0,
      vy: 0,
      vz: 0,
      mode: "idle",
      hitstop: 0,
      invulnerable: 0,
      pendingLaunch: null,
    });
    engine.update(DT, emptyInput());
    expect(target.damage).toBe(damage);
  });
});

describe("clashes and directional influence", () => {
  function clashResult(reverseOrder: boolean) {
    const { engine, player, target } = fixture();
    Object.assign(player, { x: 0, z: -0.8, facing: 0 });
    Object.assign(target, { x: 0, z: 0.8, facing: Math.PI });
    makeActive(player);
    makeActive(target);
    expect(attacksClash(player, target)).toBe(true);
    if (reverseOrder) engine.state.fighters.reverse();
    engine.update(DT, emptyInput());
    return {
      fighters: engine.state.fighters
        .map(({ id, damage, mode }) => ({ id, damage, mode }))
        .sort((a, b) => a.id - b.id),
      clashes: engine.state.stats.clashes,
    };
  }

  test("clashes resolve before body hits and do not depend on fighter iteration order", () => {
    const forward = clashResult(false);
    const reverse = clashResult(true);
    expect(forward).toEqual(reverse);
    expect(forward.clashes).toBe(1);
    for (const fighter of forward.fighters) {
      expect(fighter.damage).toBe(0);
      expect(fighter.mode).toBe("clash");
    }
  });

  test("attacking fighters cannot clash through distance or a large height difference", () => {
    const { player, target } = fixture();
    makeActive(player);
    makeActive(target);
    Object.assign(target, { x: 30, y: 0, z: 0 });
    expect(attacksClash(player, target)).toBe(false);
    Object.assign(player, { x: 0, z: 0 });
    Object.assign(target, { x: 0, z: 1, y: 7 });
    expect(attacksClash(player, target)).toBe(false);
  });

  test("DI bends the horizontal trajectory within its limit without cancelling momentum or a meteor", () => {
    const launch = { x: 0, y: -11, z: 10 };
    const result = directionInfluence(launch, { x: 1, z: 0 });
    expect(Math.hypot(result.x, result.z)).toBeCloseTo(10, 8);
    expect(result.y).toBe(launch.y);
    expect(Math.abs(Math.atan2(result.x, result.z))).toBeLessThanOrEqual(RULES.diAngle + 1e-8);
    expect(Math.abs(result.x)).toBeGreaterThan(0);
    expect(directionInfluence(launch, { x: 0, z: 0 })).toEqual(launch);
  });

  test("DI on purely vertical knockback remains finite and retains the vertical velocity", () => {
    const result = directionInfluence({ x: 0, y: -8, z: 0 }, { x: 1, z: 1 });
    expect(
      Number.isFinite(result.x) && Number.isFinite(result.y) && Number.isFinite(result.z),
    ).toBe(true);
    expect(result).toEqual({ x: 0, y: -8, z: 0 });
  });
});

describe("one jump and finite aerial recovery", () => {
  test("a jump press between fixed simulation ticks is retained until the next tick", () => {
    const { engine, player } = fixture();
    engine.update(DT / 2, { ...emptyInput(), jump: true });
    expect(player.grounded).toBe(true);
    engine.update(DT / 2, emptyInput());
    expect(player.grounded).toBe(false);
    expect(player.vy).toBeGreaterThan(0);
  });

  test("an attack press between fixed simulation ticks is retained while the key remains held", () => {
    const { engine, player } = fixture();
    engine.update(DT / 2, { ...emptyInput(), attackPressed: "thrust", attackHeld: "thrust" });
    engine.update(DT / 2, { ...emptyInput(), attackHeld: "thrust" });
    expect(player.mode).toBe("charge");
    expect(player.attack).toBe("thrust");
  });

  test("an input pressed while paused is not replayed on resume", () => {
    const { engine, player } = fixture();
    engine.pause();
    engine.update(DT / 2, { ...emptyInput(), jump: true, attackPressed: "thrust" });
    engine.resume();
    engine.update(DT, emptyInput());
    expect(player.grounded).toBe(true);
    expect(player.mode).toBe("idle");
    expect(player.stamina).toBe(RULES.maxStamina);
  });

  test("jump input while airborne cannot create a second jump", () => {
    const { engine, player } = fixture();
    engine.update(DT, { ...emptyInput(), jump: true });
    advance(engine, 0.1);
    const velocityBefore = player.vy;
    expect(player.grounded).toBe(false);
    engine.update(DT, { ...emptyInput(), jump: true });
    expect(player.vy).toBeLessThan(velocityBefore);
  });

  test.each(["rising", "thrust"] as const)(
    "the airborne %s token is spent on commitment, never on a feint",
    (attack) => {
      const { engine, player } = fixture();
      const token = attack === "rising" ? "airRisingUsed" : "airThrustUsed";
      Object.assign(player, { grounded: false, y: 5, vy: 0 });
      startCharge(engine, attack);
      expect(player[token]).toBe(false);
      engine.update(DT, { ...emptyInput(), cancel: true, attackHeld: attack });
      expect(player[token]).toBe(false);
      advance(engine, RULES.cancelDuration + DT);
      startCharge(engine, attack);
      engine.update(DT, emptyInput());
      expect(player[token]).toBe(true);
    },
  );

  test.each(["rising", "thrust"] as const)(
    "an already used %s token prevents repeated recovery until landing",
    (attack) => {
      const { engine, player } = fixture();
      Object.assign(player, {
        grounded: false,
        y: 3,
        vy: 0,
        airRisingUsed: true,
        airThrustUsed: true,
      });
      startCharge(engine, attack);
      expect(["charge", "windup", "active"]).not.toContain(player.mode);
      Object.assign(player, { y: 0.01, vy: -1 });
      advance(engine, 0.05);
      expect(player.grounded).toBe(true);
      expect(player.airRisingUsed).toBe(false);
      expect(player.airThrustUsed).toBe(false);
    },
  );

  test("hitstop freezes a committed attack but still advances the match clock", () => {
    const { engine, player } = fixture();
    Object.assign(player, {
      mode: "windup",
      modeTime: 0.1,
      modeDuration: ATTACKS.overhead.startup,
      attack: "overhead",
      hitstop: 0.4,
    });
    const elapsed = engine.state.elapsed;
    advance(engine, 0.1);
    expect(player.modeTime).toBeCloseTo(0.1, 8);
    expect(engine.state.elapsed).toBeGreaterThan(elapsed + 0.09);
    expect(player.hitstop).toBeLessThan(0.4);
  });

  test("a below-platform meteor remains below the platform when its hitstop ends", () => {
    const { engine, player } = fixture();
    Object.assign(player, {
      x: 0,
      y: -2,
      z: 0,
      grounded: false,
      mode: "hitstun",
      modeTime: 0,
      modeDuration: 0.5,
      hitstop: DT / 2,
      pendingLaunch: { x: 0, y: -10, z: 0 },
      airRisingUsed: true,
      airThrustUsed: true,
    });
    engine.update(DT, emptyInput());
    expect(player.y).toBeLessThan(-2);
    expect(player.grounded).toBe(false);
    expect(player.airRisingUsed).toBe(true);
    expect(player.airThrustUsed).toBe(true);
  });
});

describe("re-aiming during the wind-up", () => {
  const aimAt = (x: number, z: number): PlayerInput => ({ ...emptyInput(), aim: { x, z } });

  /** Tap (press, then release) so the attack commits into its wind-up facing +Z. */
  function commit(engine: BattleEngine, attack: AttackId) {
    startCharge(engine, attack);
    engine.update(DT, emptyInput());
  }

  test("a committed swing keeps turning toward the aim, but only at the wind-up rate", () => {
    const { engine, player } = fixture();
    commit(engine, "overhead");
    expect(player.mode).toBe("windup");
    expect(player.facing).toBe(0);
    engine.update(DT, aimAt(1, 0));
    expect(player.facing).toBeCloseTo(RULES.windupTurnRate * DT, 10);
    for (let frame = 0; frame < 11; frame++) engine.update(DT, aimAt(1, 0));
    expect(player.mode).toBe("windup");
    expect(player.facing).toBeCloseTo(RULES.windupTurnRate * DT * 12, 8);
    expect(player.facing).toBeLessThan(Math.PI / 2);
    expect(RULES.windupTurnRate).toBeLessThan(RULES.chargeTurnRate);
  });

  test("the move direction is the fallback aim, as when idle", () => {
    const { engine, player } = fixture();
    commit(engine, "overhead");
    engine.update(DT, { ...emptyInput(), move: { x: -1, z: 0 } });
    expect(player.facing).toBeCloseTo(-RULES.windupTurnRate * DT, 10);
  });

  test("facing locks once the blade is cutting: no turning during active or recovery", () => {
    const { engine, player } = fixture();
    commit(engine, "overhead");
    while (player.mode === "windup") engine.update(DT, aimAt(1, 0));
    expect(player.mode).toBe("active");
    const locked = player.facing;
    expect(locked).toBeGreaterThan(0.3);
    const seen = new Set<Fighter["mode"]>();
    for (let frame = 0; frame < 60 && player.mode !== "idle"; frame++) {
      seen.add(player.mode);
      engine.update(DT, aimAt(-1, 0));
      if (player.mode === "active" || player.mode === "recovery")
        expect(player.facing).toBe(locked);
    }
    expect(seen.has("active") && seen.has("recovery")).toBe(true);
  });

  test("the thrust lunges along the adjusted facing", () => {
    const { engine, player } = fixture();
    commit(engine, "thrust");
    while (player.mode === "windup") engine.update(DT, aimAt(1, 0));
    expect(player.mode).toBe("active");
    expect(player.facing).toBeGreaterThan(0.3);
    expect(player.vx).toBeGreaterThan(0);
    expect(Math.atan2(player.vx, player.vz)).toBeCloseTo(player.facing, 8);
  });

  test("the rising launch also follows the adjusted facing", () => {
    const { engine, player } = fixture();
    commit(engine, "rising");
    while (player.mode === "windup") engine.update(DT, aimAt(-1, 0));
    expect(player.mode).toBe("active");
    expect(player.facing).toBeLessThan(-0.3);
    expect(Math.atan2(player.vx, player.vz)).toBeCloseTo(player.facing, 8);
  });

  test("a wind-up cancel still works while re-aiming", () => {
    const { engine, player } = fixture();
    commit(engine, "overhead");
    advance(engine, 0.1, aimAt(1, 0));
    engine.update(DT, { ...aimAt(1, 0), cancel: true });
    expect(player.mode).toBe("cancel");
    expect(player.attack).toBeNull();
  });

  test.each([
    ["easy", 0],
    ["normal", 0.5],
    ["hard", 1],
  ] as const)("a %s CPU tracks at %s of the wind-up rate", (difficulty, factor) => {
    const engine = new BattleEngine(5);
    engine.start("duel", { stocks: 1, difficulty });
    engine.state.phase = "playing";
    const [human, cpu] = engine.state.fighters;
    Object.assign(human, { x: 1, z: 2, hitstop: 100 });
    Object.assign(cpu, {
      x: 0,
      z: 0,
      facing: 0,
      mode: "windup",
      modeTime: 0,
      modeDuration: ATTACKS.overhead.startup,
      attack: "overhead",
    });
    engine.update(DT, emptyInput());
    expect(cpu.mode).toBe("windup");
    expect(cpu.facing).toBeCloseTo(RULES.windupTurnRate * factor * DT, 10);
  });
});

describe("air dodge", () => {
  const stepInput = (x = 1, z = 0): PlayerInput => ({
    ...emptyInput(),
    step: true,
    move: { x, z },
  });

  function airborne(engine: BattleEngine, player: Fighter, y = 5, vy = -2) {
    Object.assign(player, { grounded: false, y, vy });
  }

  test("a step in the air dashes like a grounded one, costs stamina and floats", () => {
    const { engine, player } = fixture();
    airborne(engine, player);
    const startX = player.x;
    const startY = player.y;
    engine.update(DT, stepInput());
    expect(player.mode).toBe("step");
    expect(player.airStepUsed).toBe(true);
    expect(player.stamina).toBe(RULES.maxStamina - RULES.stepCost);
    expect(player.vy).toBeCloseTo(
      RULES.airStepHover - RULES.gravity * RULES.airStepGravity * DT,
      8,
    );
    while (player.mode === "step") engine.update(DT);
    // The same distance as a grounded step, while barely losing height.
    expect(player.x - startX).toBeGreaterThan(2.3);
    expect(player.x - startX).toBeLessThan(2.9);
    expect(Math.abs(player.y - startY)).toBeLessThan(0.2);
    expect(player.facing).toBe(0);
  });

  test("an upward velocity is never reduced by the air dodge", () => {
    const { engine, player } = fixture();
    airborne(engine, player, 2, 6);
    engine.update(DT, stepInput());
    expect(player.mode).toBe("step");
    expect(player.vy).toBeCloseTo(6 - RULES.gravity * RULES.airStepGravity * DT, 8);
  });

  test("only one air dodge per airtime, and landing gives it back", () => {
    const { engine, player } = fixture();
    airborne(engine, player);
    engine.update(DT, stepInput());
    while (player.mode === "step") engine.update(DT);
    expect(player.mode).toBe("idle");
    expect(player.grounded).toBe(false);
    const stamina = player.stamina;
    engine.update(DT, stepInput());
    expect(player.mode).toBe("idle");
    expect(player.stamina).toBe(stamina);
    expect(player.vy).toBeLessThan(0);
    Object.assign(player, { y: 0.01, vy: -1 });
    advance(engine, 0.05);
    expect(player.grounded).toBe(true);
    expect(player.airStepUsed).toBe(false);
  });

  test("a grounded step never spends the air dodge, and running off the edge falls normally", () => {
    const { engine, player } = fixture();
    Object.assign(player, { x: engine.state.arena.halfSize - 0.3, z: 0 });
    engine.update(DT, stepInput());
    expect(player.mode).toBe("step");
    expect(player.airStepUsed).toBe(false);
    while (player.mode === "step" && player.grounded) engine.update(DT);
    expect(player.grounded).toBe(false);
    expect(player.mode).toBe("step");
    const vy = player.vy;
    engine.update(DT);
    expect(player.mode).toBe("step");
    expect(player.vy).toBeCloseTo(vy - RULES.gravity * DT, 8);
    while (player.mode === "step") engine.update(DT);
    expect(player.airStepUsed).toBe(false);
    engine.update(DT, stepInput());
    expect(player.mode).toBe("step");
    expect(player.airStepUsed).toBe(true);
  });

  test.each([
    { age: 0.03, shouldHit: true, phase: "startup" },
    { age: 0.12, shouldHit: false, phase: "invulnerable middle" },
    { age: 0.24, shouldHit: true, phase: "recovery" },
  ])("the air dodge has the same invulnerability window: $phase", ({ age, shouldHit }) => {
    const { engine, player, target } = fixture();
    airborne(engine, player);
    engine.update(DT, stepInput());
    advance(engine, age);
    expect(player.mode).toBe("step");
    Object.assign(target, {
      x: player.x,
      y: player.y,
      z: player.z - 0.9,
      facing: 0,
      grounded: false,
    });
    makeActive(target);
    engine.update(DT, emptyInput());
    expect(player.damage > 0).toBe(shouldHit);
  });

  test("a charge feints into an air dodge after the usual delay, and floats only once it moves", () => {
    const { engine, player } = fixture();
    airborne(engine, player);
    startCharge(engine, "overhead");
    expect(player.mode).toBe("charge");
    engine.update(DT, { ...stepInput(), attackHeld: "overhead" });
    expect(player.mode).toBe("step");
    expect(player.stepDelay).toBeCloseTo(RULES.feintStepDelay, 8);
    expect(player.airStepUsed).toBe(true);
    expect(player.stamina).toBe(RULES.maxStamina - RULES.chargeCost - RULES.stepCost);
    expect(player.vy).toBeLessThan(0);
    while (player.stepDelay > 0) engine.update(DT);
    engine.update(DT);
    expect(player.vy).toBeGreaterThan(0);
  });

  test("a spent air dodge cannot be used, from idle or as a feint", () => {
    const { engine, player } = fixture();
    airborne(engine, player);
    player.airStepUsed = true;
    engine.update(DT, stepInput());
    expect(player.mode).toBe("idle");
    expect(player.stamina).toBe(RULES.maxStamina);
    startCharge(engine, "overhead");
    const stamina = player.stamina;
    engine.update(DT, { ...stepInput(), attackHeld: "overhead" });
    expect(player.mode).toBe("charge");
    expect(player.stamina).toBe(stamina);
  });

  test("the air dodge and the air attacks never give each other back", () => {
    const { engine, player } = fixture();
    airborne(engine, player);
    Object.assign(player, { airRisingUsed: true, airThrustUsed: true });
    engine.update(DT, stepInput());
    expect(player.airStepUsed).toBe(true);
    expect(player.airRisingUsed && player.airThrustUsed).toBe(true);
    const other = fixture();
    airborne(other.engine, other.player);
    other.player.airStepUsed = true;
    startCharge(other.engine, "thrust");
    other.engine.update(DT, emptyInput());
    expect(other.player.mode).toBe("windup");
    expect(other.player.airThrustUsed).toBe(true);
    expect(other.player.airStepUsed).toBe(true);
  });
});

describe("positional grabs", () => {
  test("a close grab allows a directional throw, then releases both fighters", () => {
    const { engine, player, target } = fixture();
    Object.assign(player, { x: 0, z: 0, facing: 0 });
    Object.assign(target, { x: 0, z: 0.95 });
    engine.update(DT, { ...emptyInput(), grab: true });
    advance(engine, RULES.grabStartup + DT);
    expect(player.mode).toBe("throw");
    expect(target.mode).toBe("grabbed");
    expect(player.grabbedId).toBe(target.id);
    advance(engine, RULES.grabHold + 0.12, { ...emptyInput(), move: { x: 1, z: 0 } });
    expect(player.grabbedId).toBeNull();
    expect(target.grabbedBy).toBeNull();
    expect(target.damage).toBeGreaterThan(0);
    expect(target.vx).toBeGreaterThan(0);
    expect(Math.abs(target.vz)).toBeLessThan(0.01);
    expect(player.mode).toBe("recovery");
  });

  test("eliminating a captor releases its victim instead of leaving a permanent grab", () => {
    const { engine, player, target } = fixture();
    Object.assign(player, {
      x: 4,
      z: 0,
      mode: "throw",
      modeTime: 0,
      modeDuration: RULES.grabHold,
      grabbedId: target.id,
      outsideTime: RULES.outsideLimit - DT / 2,
    });
    Object.assign(target, { x: 4, z: 0.8, mode: "grabbed", grabbedBy: player.id });
    engine.state.arena.safeZone = { x: 0, z: 0, radius: 2, active: true };
    engine.update(DT, emptyInput());
    expect(player.mode).toBe("dead");
    expect(player.grabbedId).toBeNull();
    expect(target.mode).not.toBe("grabbed");
    expect(target.grabbedBy).toBeNull();
  });
});
