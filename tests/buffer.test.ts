import { describe, expect, test } from "vite-plus/test";
import { BattleEngine } from "../src/game/engine";
import type { MatchOptions } from "../src/game/match";
import { ATTACKS, INPUT_BUFFER_TICKS, RULES } from "../src/game/tuning";
import {
  emptyInput,
  type AttackId,
  type Fighter,
  type FighterMode,
  type MatchMode,
  type PlayerInput,
  type PlayerInputs,
} from "../src/game/types";

const TICK = RULES.fixedStep;

const press = (input: Partial<PlayerInput> = {}): PlayerInput => ({ ...emptyInput(), ...input });
const tap = (attack: AttackId): PlayerInput => press({ attackPressed: attack });
const hold = (attack: AttackId): PlayerInput =>
  press({ attackPressed: attack, attackHeld: attack });

/** Training with a still partner placed out of reach: only the player under test acts. */
function fixture() {
  const engine = new BattleEngine(5150);
  engine.start("training");
  engine.state.phase = "playing";
  const player = engine.state.fighters.find((f) => f.human)!;
  const partner = engine.state.fighters.find((f) => f.id !== player.id)!;
  Object.assign(player, { x: 0, y: 0, z: -3, facing: 0, grounded: true });
  Object.assign(partner, { x: 0, y: 0, z: 6, facing: Math.PI, grounded: true });
  return { engine, player, partner };
}

function versus(mode: MatchMode, options: Partial<MatchOptions>) {
  const engine = new BattleEngine(5150);
  engine.start(mode, options);
  engine.state.phase = "playing";
  return { engine, fighters: engine.state.fighters };
}

/** Runs `count` fixed ticks with the same input (presses are consumed by the first one). */
function ticks(
  engine: BattleEngine,
  count: number,
  input: PlayerInput | PlayerInputs = emptyInput(),
) {
  for (let i = 0; i < count; i++) engine.update(TICK, i === 0 ? input : release(input));
}

/** `input` with its presses dropped and everything held kept. */
function release(input: PlayerInput | PlayerInputs): PlayerInput | PlayerInputs {
  const strip = (i: PlayerInput): PlayerInput => ({
    ...i,
    attackPressed: null,
    jump: false,
    step: false,
    cancel: false,
    grab: false,
  });
  if ("move" in input) return strip(input as PlayerInput);
  const out: PlayerInputs = {};
  for (const [id, i] of Object.entries(input)) if (i) out[Number(id)] = strip(i);
  return out;
}

/**
 * Puts `f` in a lockout it leaves on the `count`-th tick from now: that tick it is idle again
 * and may act. Recovery keeps the attack it belongs to, as a real one does.
 */
function lockFor(f: Fighter, count: number, mode: FighterMode = "recovery") {
  Object.assign(f, {
    mode,
    modeTime: 0,
    modeDuration: count * TICK,
    attack: mode === "recovery" ? "sweep" : null,
    charge: 0,
    hitstop: 0,
  });
}

/** Presses `input` `lead` ticks before `f`'s lockout ends, then plays the ticks up to and including the first free one. */
function pressAhead(engine: BattleEngine, f: Fighter, lead: number, input: PlayerInput) {
  lockFor(f, lead + 1);
  ticks(engine, 1, input);
  ticks(engine, lead - 1, release(input));
}

describe("the buffer window", () => {
  test("is 0.10 s, six fixed ticks at 60 Hz", () => {
    expect(RULES.inputBuffer).toBe(0.1);
    expect(INPUT_BUFFER_TICKS).toBe(6);
  });

  test("a press on the window's edge fires on the very first free tick, not before", () => {
    const { engine, player } = fixture();
    lockFor(player, INPUT_BUFFER_TICKS + 1);
    ticks(engine, 1, press({ step: true }));
    expect(player.inputBuffer).toMatchObject({ action: "step", age: 0, pressedIn: "recovery" });
    ticks(engine, INPUT_BUFFER_TICKS - 1);
    expect(player.mode).toBe("recovery");
    expect(player.inputBuffer?.age).toBe(INPUT_BUFFER_TICKS - 1);
    ticks(engine, 1);
    expect(player.mode).toBe("step");
    expect(player.stamina).toBe(RULES.maxStamina - RULES.stepCost);
    expect(player.inputBuffer).toBeNull();
  });

  test("a press one tick earlier than the window expires and never fires late", () => {
    const { engine, player } = fixture();
    lockFor(player, INPUT_BUFFER_TICKS + 2);
    ticks(engine, 1, press({ step: true }));
    ticks(engine, INPUT_BUFFER_TICKS);
    expect(player.inputBuffer).not.toBeNull();
    ticks(engine, 1);
    expect(player.inputBuffer).toBeNull();
    expect(player.mode).toBe("idle");
    ticks(engine, 60);
    expect(player.mode).toBe("idle");
    expect(player.stamina).toBe(RULES.maxStamina);
    expect(engine.state.stats.dodges).toBe(0);
  });

  test("a press while already free acts at once and buffers nothing", () => {
    const { engine, player } = fixture();
    ticks(engine, 1, press({ step: true, move: { x: 1, z: 0 } }));
    expect(player.mode).toBe("step");
    expect(player.inputBuffer).toBeNull();
  });

  test("a press made on the tick the lockout ends acts that tick", () => {
    const { engine, player } = fixture();
    lockFor(player, 1);
    ticks(engine, 1, press({ step: true }));
    expect(player.mode).toBe("step");
    expect(player.inputBuffer).toBeNull();
  });
});

describe("buffered actions out of attack recovery", () => {
  test("a step fires once, with the direction held when it fires", () => {
    const { engine, player } = fixture();
    lockFor(player, 4);
    ticks(engine, 1, press({ step: true, move: { x: 1, z: 0 } }));
    ticks(engine, 3, press({ move: { x: -1, z: 0 } }));
    expect(player.mode).toBe("step");
    expect(player.stepDirection.x).toBeCloseTo(-1, 8);
    expect(player.stamina).toBe(RULES.maxStamina - RULES.stepCost);
    ticks(engine, Math.ceil(RULES.stepDuration / TICK) + 30);
    expect(player.mode).toBe("idle");
    expect(engine.state.stats.dodges).toBe(1);
  });

  /** Swings a tapped sweep for real and stops with `left` ticks of its recovery remaining. */
  function swingUntilRecoveryLeft(engine: BattleEngine, player: Fighter, left: number) {
    ticks(engine, 1, tap("sweep"));
    for (let i = 0; i < 200; i++) {
      if (player.mode === "recovery" && player.modeDuration - player.modeTime <= left * TICK + 1e-9)
        return;
      ticks(engine, 1);
    }
    throw new Error("never reached recovery");
  }

  test("a tapped-and-released attack fires as a quick tap: one swing, never stuck charging", () => {
    const { engine, player } = fixture();
    swingUntilRecoveryLeft(engine, player, 3);
    const swings = player.swingId;
    const stamina = player.stamina;
    // Down and up again within the frame: pressed, never held.
    ticks(engine, 1, tap("thrust"));
    expect(player.mode).toBe("recovery");
    ticks(engine, 2);
    expect(player.mode).toBe("charge");
    expect(player.attack).toBe("thrust");
    expect(player.stamina).toBe(stamina - RULES.chargeCost);
    ticks(engine, 1);
    expect(player.mode).toBe("windup");
    expect(player.charge).toBeLessThan(0.05);
    expect(player.swingId).toBe(swings + 1);
    expect(player.stamina).toBe(stamina - ATTACKS.thrust.stamina);
    ticks(engine, 120);
    expect(player.mode).toBe("idle");
    expect(player.swingId).toBe(swings + 1);
  });

  test("a tapped attack still taps when a different attack is held as it fires", () => {
    const { engine, player } = fixture();
    swingUntilRecoveryLeft(engine, player, 4);
    const swings = player.swingId;
    const stamina = player.stamina;
    // B (overhead) goes down and stays down; A (thrust) is tapped and released over it.
    ticks(engine, 1, hold("overhead"));
    ticks(engine, 1, press({ attackPressed: "thrust", attackHeld: "overhead" }));
    expect(player.inputBuffer).toMatchObject({ action: "attack", attack: "thrust" });
    ticks(engine, 1, press({ attackHeld: "overhead" }));
    expect(player.mode).toBe("recovery");
    ticks(engine, 1, press({ attackHeld: "overhead" }));
    expect(player.mode).toBe("charge");
    expect(player.attack).toBe("thrust");
    // A is not the held button, so it commits on the next tick as a tap.
    ticks(engine, 1, press({ attackHeld: "overhead" }));
    expect(player.mode).toBe("windup");
    expect(player.attack).toBe("thrust");
    expect(player.charge).toBeLessThan(0.05);
    expect(player.swingId).toBe(swings + 1);
    expect(player.stamina).toBe(stamina - ATTACKS.thrust.stamina);
    // Holding B afterwards never charges it or swings again: it was never pressed while free.
    ticks(engine, 150, press({ attackHeld: "overhead" }));
    expect(player.mode).toBe("idle");
    expect(player.swingId).toBe(swings + 1);
    expect(player.inputBuffer).toBeNull();
  });

  test("an attack button released before the buffer fires still taps", () => {
    const { engine, player } = fixture();
    lockFor(player, 5);
    ticks(engine, 1, hold("overhead"));
    ticks(engine, 2, press({ attackHeld: "overhead" }));
    ticks(engine, 2);
    expect(player.mode).toBe("charge");
    ticks(engine, 1);
    expect(player.mode).toBe("windup");
    expect(player.charge).toBeLessThan(0.05);
  });

  test("an attack still held when it fires charges until released", () => {
    const { engine, player } = fixture();
    lockFor(player, 4);
    ticks(engine, 4, hold("overhead"));
    expect(player.mode).toBe("charge");
    ticks(engine, 30, press({ attackHeld: "overhead" }));
    expect(player.mode).toBe("charge");
    ticks(engine, 1);
    expect(player.mode).toBe("windup");
    expect(player.charge).toBeGreaterThan(0.5);
  });

  test("a held attack still commits at maxHold", () => {
    const { engine, player } = fixture();
    lockFor(player, 3);
    ticks(engine, 3, hold("sweep"));
    expect(player.mode).toBe("charge");
    ticks(engine, Math.ceil(RULES.maxHold / TICK) + 1, press({ attackHeld: "sweep" }));
    expect(player.mode).not.toBe("charge");
  });

  test("one press never makes two attacks, even pressed again before it fires", () => {
    const { engine, player } = fixture();
    lockFor(player, 6);
    const swings = player.swingId;
    ticks(engine, 1, tap("sweep"));
    ticks(engine, 1);
    ticks(engine, 1, tap("sweep"));
    ticks(engine, 200);
    expect(player.swingId).toBe(swings + 1);
  });

  test("a buffered grab fires out of recovery", () => {
    const { engine, player } = fixture();
    pressAhead(engine, player, 3, press({ grab: true }));
    ticks(engine, 1);
    expect(player.mode).toBe("grab");
    expect(player.stamina).toBe(RULES.maxStamina - RULES.grabCost);
  });

  test("buffered presses wait out cancel lag, clashes and step ends too", () => {
    for (const mode of ["cancel", "clash", "step"] as const) {
      const { engine, player } = fixture();
      lockFor(player, 3, mode);
      ticks(engine, 1, tap("sweep"));
      ticks(engine, 2);
      expect([mode, player.mode]).toEqual([mode, "charge"]);
    }
  });
});

describe("landing", () => {
  /** Falling, a few ticks above the floor. */
  function airborne(player: Fighter, y: number, vy: number) {
    Object.assign(player, { y, vy, grounded: false, mode: "idle" });
  }

  function untilLanded(engine: BattleEngine, player: Fighter, max = 60): number {
    for (let i = 1; i <= max; i++) {
      ticks(engine, 1);
      if (player.grounded) return i;
    }
    throw new Error("never landed");
  }

  test("a jump pressed just before landing jumps on the first grounded tick, never in the air", () => {
    const { engine, player } = fixture();
    airborne(player, 0.2, -3);
    ticks(engine, 1, press({ jump: true }));
    expect(player.vy).toBeLessThan(0);
    expect(player.inputBuffer?.action).toBe("jump");
    const landed = untilLanded(engine, player);
    expect(landed).toBeLessThan(INPUT_BUFFER_TICKS);
    ticks(engine, 1);
    expect(player.grounded).toBe(false);
    expect(player.vy).toBeGreaterThan(RULES.jumpSpeed - 1);
    expect(player.inputBuffer).toBeNull();
  });

  /** Ticks from a fall of `airborne(player, 2, 0)` until the tick `physics` lands it. */
  function landingTick(): number {
    const { engine, player } = fixture();
    airborne(player, 2, 0);
    return untilLanded(engine, player);
  }

  /**
   * Presses `input` `lead` ticks before the landing tick (0 = on it), plays up to and including the
   * landing tick, then the first grounded tick.
   */
  function pressBeforeLanding(lead: number, input: PlayerInput) {
    const landing = landingTick();
    expect(landing).toBeGreaterThan(INPUT_BUFFER_TICKS + 1);
    const { engine, player } = fixture();
    airborne(player, 2, 0);
    ticks(engine, landing - lead - 1);
    ticks(engine, 1, input);
    ticks(engine, lead);
    expect(player.grounded).toBe(true);
    expect(player.mode).toBe("idle");
    ticks(engine, 1);
    return { engine, player };
  }

  test.each([0, 1, INPUT_BUFFER_TICKS])(
    "a jump pressed %i ticks before the landing tick jumps on the first grounded tick",
    (lead) => {
      const { player } = pressBeforeLanding(lead, press({ jump: true }));
      expect(player.grounded).toBe(false);
      expect(player.vy).toBeGreaterThan(RULES.jumpSpeed - 1);
      expect(player.inputBuffer).toBeNull();
    },
  );

  test("a jump pressed one tick before the landing window expires and never fires", () => {
    const { engine, player } = pressBeforeLanding(INPUT_BUFFER_TICKS + 1, press({ jump: true }));
    expect(player.grounded).toBe(true);
    expect(player.inputBuffer).toBeNull();
    ticks(engine, 30);
    expect(player.grounded).toBe(true);
    expect(player.vy).toBe(0);
  });

  test("the landing window for a grab has the same edges", () => {
    const edge = pressBeforeLanding(INPUT_BUFFER_TICKS, press({ grab: true }));
    expect(edge.player.mode).toBe("grab");
    const late = pressBeforeLanding(INPUT_BUFFER_TICKS + 1, press({ grab: true }));
    expect(late.player.mode).toBe("idle");
    expect(late.player.stamina).toBe(RULES.maxStamina);
  });

  test("the landing grace never lengthens a window that recovery, not the landing, closes", () => {
    const landing = landingTick();
    const { engine, player } = fixture();
    airborne(player, 2, 0);
    // Recovery ends the tick after the landing tick, so recovery, not the landing, frees the jump,
    // and a press INPUT_BUFFER_TICKS + 1 ticks before that is too old.
    lockFor(player, landing + 1);
    ticks(engine, landing - INPUT_BUFFER_TICKS - 1);
    ticks(engine, 1, press({ jump: true }));
    ticks(engine, INPUT_BUFFER_TICKS);
    expect(player.grounded).toBe(true);
    expect(player.mode).toBe("recovery");
    expect(player.inputBuffer?.landingGrace).toBe(false);
    ticks(engine, 1);
    expect(player.mode).toBe("idle");
    expect(player.grounded).toBe(true);
    expect(player.inputBuffer).toBeNull();
  });

  test("a jump pressed long before landing expires in the air", () => {
    const { engine, player } = fixture();
    airborne(player, 2, 0);
    ticks(engine, 1, press({ jump: true }));
    untilLanded(engine, player);
    ticks(engine, 30);
    expect(player.grounded).toBe(true);
    expect(player.vy).toBe(0);
  });

  test("a grab pressed just before landing grabs once grounded, never in the air", () => {
    const { engine, player } = fixture();
    airborne(player, 0.2, -3);
    ticks(engine, 1, press({ grab: true }));
    expect(player.mode).toBe("idle");
    untilLanded(engine, player);
    expect(player.mode).toBe("idle");
    ticks(engine, 1);
    expect(player.mode).toBe("grab");
    expect(player.stamina).toBe(RULES.maxStamina - RULES.grabCost);
  });
});

describe("what the buffer can never do", () => {
  test("cut short active or recovery frames", () => {
    const { engine, player } = fixture();
    lockFor(player, 20);
    for (let i = 0; i < 19; i++) {
      ticks(engine, 1, press({ step: true, grab: true, jump: true, attackPressed: "thrust" }));
      expect(player.mode).toBe("recovery");
    }
    ticks(engine, 1);
    expect(player.mode).toBe("step");
  });

  test("spend stamina it does not have: an unaffordable step is refused for free, once", () => {
    const { engine, player } = fixture();
    Object.assign(player, { stamina: 10 });
    pressAhead(engine, player, 3, press({ step: true }));
    player.staminaDelay = 10;
    ticks(engine, 1);
    expect(player.mode).toBe("idle");
    expect(player.stamina).toBe(10);
    expect(player.inputBuffer).toBeNull();
    // Refused, not kept waiting for stamina to come back.
    player.stamina = RULES.maxStamina;
    ticks(engine, 10);
    expect(player.mode).toBe("idle");
    expect(player.stamina).toBe(RULES.maxStamina);
  });

  test("spend stamina it does not have: an unaffordable attack charges nothing", () => {
    const { engine, player } = fixture();
    lockFor(player, 3);
    Object.assign(player, { stamina: ATTACKS.overhead.stamina - 1, staminaDelay: 10 });
    ticks(engine, 3, hold("overhead"));
    expect(player.mode).toBe("idle");
    expect(player.stamina).toBe(ATTACKS.overhead.stamina - 1);
    expect(player.inputBuffer).toBeNull();
  });

  test("spend stamina it does not have: an unaffordable grab is refused for free", () => {
    const { engine, player } = fixture();
    Object.assign(player, { stamina: RULES.grabCost - 1, staminaDelay: 10 });
    pressAhead(engine, player, 2, press({ grab: true }));
    ticks(engine, 1);
    expect(player.mode).toBe("idle");
    expect(player.stamina).toBe(RULES.grabCost - 1);
  });

  test("dodge twice in one airtime", () => {
    const { engine, player } = fixture();
    Object.assign(player, { y: 5, vy: 0, grounded: false, airStepUsed: true });
    lockFor(player, 3, "step");
    ticks(engine, 1, press({ step: true }));
    ticks(engine, INPUT_BUFFER_TICKS + 2);
    expect(player.grounded).toBe(false);
    expect(player.mode).toBe("idle");
    expect(player.inputBuffer).toBeNull();
    expect(engine.state.stats.dodges).toBe(0);
  });

  test("swing a second rising slash or thrust in one airtime", () => {
    for (const attack of ["rising", "thrust"] as const) {
      const { engine, player } = fixture();
      Object.assign(player, {
        y: 5,
        vy: 0,
        grounded: false,
        airRisingUsed: true,
        airThrustUsed: true,
      });
      lockFor(player, 3);
      ticks(engine, 1, tap(attack));
      ticks(engine, INPUT_BUFFER_TICKS + 2);
      expect([attack, player.mode]).toEqual([attack, "idle"]);
      expect(player.stamina).toBe(RULES.maxStamina);
    }
  });

  test("jump or grab in the air out of an airborne recovery", () => {
    for (const key of ["jump", "grab"] as const) {
      const { engine, player } = fixture();
      Object.assign(player, { y: 5, vy: 0, grounded: false });
      lockFor(player, 3);
      ticks(engine, 1, press({ [key]: true }));
      ticks(engine, 3);
      expect(player.mode).toBe("idle");
      expect(player.vy).toBeLessThan(0);
      expect(player.stamina).toBe(RULES.maxStamina);
    }
  });

  test("carry a spent air attack or air dodge on to the landing", () => {
    for (const keys of [{ attackPressed: "rising" as AttackId }, { step: true }]) {
      const { engine, player } = fixture();
      Object.assign(player, {
        y: 0.2,
        vy: -3,
        grounded: false,
        airRisingUsed: true,
        airStepUsed: true,
      });
      // Free but spent: tried at once, refused for free, and not kept.
      ticks(engine, 1, press(keys));
      expect(player.inputBuffer).toBeNull();
      ticks(engine, INPUT_BUFFER_TICKS + 2);
      expect(player.grounded).toBe(true);
      expect(player.mode).toBe("idle");
      expect(player.stamina).toBe(RULES.maxStamina);
    }
  });

  test("a spent air dodge pressed with an allowed air attack: the attack acts, nothing is kept", () => {
    const { engine, player } = fixture();
    Object.assign(player, { y: 5, vy: 0, grounded: false, airStepUsed: true });
    ticks(engine, 1, press({ step: true, attackPressed: "thrust" }));
    expect(player.mode).toBe("charge");
    expect(player.inputBuffer).toBeNull();
  });
});

describe("several presses", () => {
  test("a newer press replaces the buffered one", () => {
    const { engine, player } = fixture();
    lockFor(player, 5);
    ticks(engine, 1, press({ step: true }));
    ticks(engine, 1);
    ticks(engine, 1, tap("sweep"));
    expect(player.inputBuffer).toMatchObject({ action: "attack", attack: "sweep", age: 0 });
    ticks(engine, 2);
    expect(player.mode).toBe("charge");
    expect(player.attack).toBe("sweep");
    ticks(engine, 200);
    expect(engine.state.stats.dodges).toBe(0);
  });

  test("a newer press extends the window from its own tick", () => {
    const { engine, player } = fixture();
    lockFor(player, INPUT_BUFFER_TICKS + 4);
    ticks(engine, 1, press({ grab: true }));
    ticks(engine, 2);
    ticks(engine, 1, press({ step: true }));
    ticks(engine, INPUT_BUFFER_TICKS);
    expect(player.mode).toBe("step");
  });

  test.each([
    [{ step: true, grab: true, attackPressed: "sweep" as AttackId, jump: true }, "step"],
    [{ grab: true, attackPressed: "sweep" as AttackId, jump: true }, "grab"],
    [{ attackPressed: "sweep" as AttackId, jump: true }, "charge"],
  ])("same-tick presses keep the highest priority only: %j → %s", (keys, mode) => {
    const { engine, player } = fixture();
    lockFor(player, 3);
    ticks(engine, 1, press(keys));
    ticks(engine, 2);
    expect(player.mode).toBe(mode);
    expect(player.grounded).toBe(true);
    expect(player.inputBuffer).toBeNull();
  });

  test("a fresh press on the first free tick beats the buffered one", () => {
    const { engine, player } = fixture();
    lockFor(player, 3);
    ticks(engine, 1, press({ step: true }));
    ticks(engine, 1);
    ticks(engine, 1, tap("overhead"));
    expect(player.mode).toBe("charge");
    expect(player.inputBuffer).toBeNull();
    ticks(engine, 200);
    expect(engine.state.stats.dodges).toBe(0);
  });
});

describe("cancel", () => {
  test("is never buffered: cancel during recovery does not stop the attack that follows", () => {
    const { engine, player } = fixture();
    lockFor(player, 4);
    ticks(engine, 1, hold("overhead"));
    ticks(engine, 1, press({ attackHeld: "overhead", cancel: true }));
    ticks(engine, 1, press({ attackHeld: "overhead", cancel: true }));
    ticks(engine, 1, press({ attackHeld: "overhead" }));
    expect(player.mode).toBe("charge");
    ticks(engine, 10, press({ attackHeld: "overhead" }));
    expect(player.mode).toBe("charge");
  });

  test("cancel pressed as recovery ends never cancels the next fresh attack", () => {
    const { engine, player } = fixture();
    lockFor(player, 2);
    ticks(engine, 1, press({ cancel: true }));
    ticks(engine, 1, press({ cancel: true }));
    expect(player.mode).toBe("idle");
    ticks(engine, 1, hold("sweep"));
    ticks(engine, 10, press({ attackHeld: "sweep" }));
    expect(player.mode).toBe("charge");
  });

  test("cancelling a charge or a wind-up stays instant, buffer or not", () => {
    const { engine, player } = fixture();
    ticks(engine, 1, hold("overhead"));
    expect(player.mode).toBe("charge");
    // A grab during the charge cannot act, so it sits in the buffer.
    ticks(engine, 1, press({ attackHeld: "overhead", grab: true }));
    expect(player.inputBuffer?.action).toBe("grab");
    ticks(engine, 1, press({ attackHeld: "overhead", cancel: true }));
    expect(player.mode).toBe("cancel");
    expect(player.inputBuffer).toBeNull();

    const second = fixture();
    ticks(second.engine, 1, tap("overhead"));
    ticks(second.engine, 1);
    expect(second.player.mode).toBe("windup");
    ticks(second.engine, 1, press({ cancel: true }));
    expect(second.player.mode).toBe("cancel");
  });
});

describe("hitstop, hitstun and timing", () => {
  test("the buffer keeps ageing through hitstop: a press made early in it expires", () => {
    const { engine, player } = fixture();
    player.hitstop = (INPUT_BUFFER_TICKS + 3 - 0.5) * TICK;
    ticks(engine, 1, press({ step: true }));
    expect(player.inputBuffer?.age).toBe(0);
    ticks(engine, INPUT_BUFFER_TICKS + 2);
    expect(player.hitstop).toBe(0);
    expect(player.mode).toBe("idle");
    expect(player.inputBuffer).toBeNull();
    expect(engine.state.stats.dodges).toBe(0);
  });

  test("a press late in hitstop fires on the tick hitstop ends", () => {
    const { engine, player } = fixture();
    player.hitstop = (INPUT_BUFFER_TICKS + 1 - 0.5) * TICK;
    ticks(engine, 1, press({ step: true }));
    ticks(engine, INPUT_BUFFER_TICKS - 1);
    expect(player.mode).toBe("idle");
    expect(player.hitstop).toBeGreaterThan(0);
    ticks(engine, 1);
    expect(player.hitstop).toBe(0);
    expect(player.mode).toBe("step");
  });

  test("a step pressed in hitstun remembers it came from hitstun and fires when it ends", () => {
    const { engine, player } = fixture();
    lockFor(player, 4, "hitstun");
    ticks(engine, 1, press({ step: true }));
    expect(player.inputBuffer).toMatchObject({ action: "step", pressedIn: "hitstun" });
    ticks(engine, 3);
    expect(player.mode).toBe("step");
  });

  test("a real hit's hitstop and hitstun hold the press, but never past its window", () => {
    const { engine, player, partner } = fixture();
    Object.assign(partner, { z: -1.2, facing: Math.PI, mode: "active", attack: "sweep" });
    Object.assign(partner, { modeTime: 0, modeDuration: ATTACKS.sweep.active, hitTargets: [] });
    ticks(engine, 1);
    expect(player.mode).toBe("hitstun");
    // Pressed at once: hitstop plus hitstun is far longer than the window.
    ticks(engine, 1, press({ step: true }));
    ticks(engine, 120);
    expect(engine.state.stats.dodges).toBe(0);
  });

  test.each([1 / 30, 1 / 60, 1 / 144])("the window is the same at %f s per frame", (dt) => {
    const startAt = (lead: number): number | null => {
      const { engine, player } = fixture();
      lockFor(player, lead + 1);
      engine.update(dt, press({ step: true }));
      for (let t = dt; t < 0.5; t += dt) {
        engine.update(dt, emptyInput());
        if (player.mode === "step") return engine.state.elapsed - player.modeTime;
      }
      return null;
    };
    const fired = startAt(INPUT_BUFFER_TICKS);
    expect(fired).not.toBeNull();
    expect(Math.round(fired! / TICK)).toBe(INPUT_BUFFER_TICKS + 1);
    expect(startAt(INPUT_BUFFER_TICKS + 1)).toBeNull();
  });
});

describe("an interruption drops presses made before it", () => {
  /** Plays ticks until `f` has left `mode`, pressing `input` once `left` ticks of it remain. */
  function pressLateIn(
    engine: BattleEngine,
    f: Fighter,
    mode: FighterMode,
    left: number,
    input: PlayerInput,
  ) {
    for (let i = 0; i < 240 && !(f.mode === mode && f.hitstop <= 0); i++) ticks(engine, 1);
    for (let i = 0; i < 240; i++) {
      if (f.modeDuration - f.modeTime <= left * TICK + 1e-9) break;
      ticks(engine, 1);
    }
    expect(f.mode).toBe(mode);
    ticks(engine, 1, input);
    expect(f.inputBuffer).toMatchObject({ pressedIn: mode });
    for (let i = 0; i < 240 && f.mode === mode; i++) ticks(engine, 1);
  }

  /** The partner's sweep, already cutting, right in front of the player. */
  function partnerSwingsAt(partner: Fighter) {
    Object.assign(partner, { z: -1.2, facing: Math.PI, mode: "active", attack: "sweep" });
    Object.assign(partner, { modeTime: 0, modeDuration: ATTACKS.sweep.active, hitTargets: [] });
  }

  test("a hit drops a press buffered in recovery; a press in its hitstop or hitstun still buffers", () => {
    const { engine, player, partner } = fixture();
    lockFor(player, 40);
    ticks(engine, 1, press({ step: true }));
    expect(player.inputBuffer?.action).toBe("step");
    partnerSwingsAt(partner);
    ticks(engine, 1);
    expect(player.mode).toBe("hitstun");
    expect(player.hitstop).toBeGreaterThan(0);
    expect(player.inputBuffer).toBeNull();
    // Pressed during hitstop: held as usual (it ages out long before the hitstun ends).
    ticks(engine, 1, press({ grab: true }));
    expect(player.inputBuffer).toMatchObject({ action: "grab", pressedIn: "hitstun", age: 0 });
    // The low sweep lands during hitstun: contact claims the new press exactly once.
    pressLateIn(engine, player, "hitstun", 3, press({ step: true }));
    expect(player.mode).toBe("ukemi");
    expect(player.inputBuffer).toBeNull();
    expect(engine.state.stats.dodges).toBe(0);
  });

  test("being grabbed drops a press buffered before the catch; a press while held still buffers", () => {
    const { engine, player, partner } = fixture();
    lockFor(player, 40);
    ticks(engine, 1, tap("sweep"));
    expect(player.inputBuffer?.action).toBe("attack");
    Object.assign(partner, { z: -2, facing: Math.PI, mode: "grab", hitTargets: [] });
    Object.assign(partner, {
      modeTime: RULES.grabStartup,
      modeDuration: RULES.grabStartup + RULES.grabActive,
    });
    ticks(engine, 1);
    expect(player.mode).toBe("grabbed");
    expect(player.inputBuffer).toBeNull();
    ticks(engine, 1, press({ step: true }));
    expect(player.inputBuffer).toMatchObject({ action: "step", pressedIn: "grabbed" });
  });

  test("a clash drops a press buffered in the swing; a press in its hitstop or lag still buffers", () => {
    const { engine, player, partner } = fixture();
    const cutting = {
      mode: "active",
      attack: "overhead",
      modeTime: 0,
      modeDuration: 1,
      hitTargets: [],
    };
    Object.assign(player, { z: -0.8, facing: 0, ...cutting });
    ticks(engine, 1, press({ step: true }));
    expect(player.mode).toBe("active");
    expect(player.inputBuffer?.action).toBe("step");
    Object.assign(partner, { z: 0.8, facing: Math.PI, ...cutting });
    ticks(engine, 1);
    expect(player.mode).toBe("clash");
    expect(player.inputBuffer).toBeNull();
    ticks(engine, 1, press({ grab: true }));
    expect(player.inputBuffer).toMatchObject({ action: "grab", pressedIn: "clash" });
    pressLateIn(engine, player, "clash", 3, tap("sweep"));
    expect(player.mode).toBe("charge");
    expect(player.attack).toBe("sweep");
  });

  test("cancelling a charge drops a press buffered during it; a press in cancel lag still fires", () => {
    const { engine, player } = fixture();
    ticks(engine, 1, hold("overhead"));
    ticks(engine, 1, press({ attackHeld: "overhead", grab: true }));
    expect(player.inputBuffer?.action).toBe("grab");
    ticks(engine, 1, press({ cancel: true }));
    expect(player.mode).toBe("cancel");
    expect(player.inputBuffer).toBeNull();
    pressLateIn(engine, player, "cancel", 3, press({ step: true }));
    expect(player.mode).toBe("step");
  });

  test("cancelling a wind-up drops a press buffered during it; a press in cancel lag still fires", () => {
    const { engine, player } = fixture();
    ticks(engine, 1, tap("overhead"));
    ticks(engine, 1);
    expect(player.mode).toBe("windup");
    ticks(engine, 1, press({ step: true }));
    expect(player.inputBuffer?.action).toBe("step");
    ticks(engine, 1, press({ cancel: true }));
    expect(player.mode).toBe("cancel");
    expect(player.inputBuffer).toBeNull();
    pressLateIn(engine, player, "cancel", 3, tap("sweep"));
    expect(player.mode).toBe("charge");
  });
});

describe("clearing the buffer", () => {
  test("pause (a pad disconnect pauses too) drops it", () => {
    const { engine, player } = fixture();
    lockFor(player, 4);
    ticks(engine, 1, press({ step: true }));
    expect(player.inputBuffer).not.toBeNull();
    engine.pause();
    expect(player.inputBuffer).toBeNull();
    engine.resume();
    ticks(engine, 10);
    expect(player.mode).toBe("idle");
    expect(engine.state.stats.dodges).toBe(0);
  });

  test("elimination drops it and the respawned fighter starts empty", () => {
    const { engine, fighters } = versus("duel", { controls: { 0: "keyboard" }, stocks: 2 });
    const [player, cpu] = fighters;
    cpu.hitstop = 1e6;
    lockFor(player, 4);
    ticks(engine, 1, press({ step: true }));
    expect(player.inputBuffer).not.toBeNull();
    Object.assign(player, { y: -20, vy: 0, grounded: false });
    ticks(engine, 1);
    expect(player.mode).toBe("dead");
    expect(player.inputBuffer).toBeNull();
    ticks(engine, Math.ceil(RULES.respawnDelay / TICK) + 1);
    expect(player.mode).toBe("idle");
    expect(player.inputBuffer).toBeNull();
    ticks(engine, 200);
    expect(engine.state.stats.dodges).toBe(0);
  });

  test("match end drops every buffer", () => {
    const { engine, fighters } = versus("duel", {
      controls: { 0: "keyboard", 1: "pad1" },
      stocks: 1,
    });
    const [p1, p2] = fighters;
    lockFor(p2, 10);
    ticks(engine, 1, { [p2.id]: press({ step: true }) });
    expect(p2.inputBuffer).not.toBeNull();
    Object.assign(p1, { y: -20, vy: 0, grounded: false });
    ticks(engine, 1);
    expect(engine.state.phase).toBe("ended");
    expect(p2.inputBuffer).toBeNull();
  });

  test("restart and the menu start with empty buffers", () => {
    for (const leave of ["start", "menu"] as const) {
      const { engine, player } = fixture();
      lockFor(player, 4);
      ticks(engine, 1, press({ step: true }));
      expect(player.inputBuffer).not.toBeNull();
      if (leave === "start") engine.start("training");
      else engine.menu();
      expect(engine.state.fighters.every((f) => f.inputBuffer === null)).toBe(true);
      engine.state.phase = "playing";
      ticks(engine, 10);
      expect(engine.state.fighters.find((f) => f.human)!.mode).toBe("idle");
    }
  });

  test("CPUs never buffer", () => {
    const { engine, fighters } = versus("duel", { controls: { 0: "keyboard" } });
    const cpu = fighters.find((f) => !f.human)!;
    for (let i = 0; i < 600; i++) {
      engine.update(TICK, emptyInput());
      expect(cpu.inputBuffer).toBeNull();
      if (engine.state.phase !== "playing") break;
    }
  });
});

describe("local multiplayer", () => {
  test("each player's buffer is their own", () => {
    const { engine, fighters } = versus("duel", { controls: { 0: "keyboard", 1: "pad1" } });
    const [p1, p2] = fighters;
    Object.assign(p1, { x: -4, z: 0 });
    Object.assign(p2, { x: 4, z: 0 });
    lockFor(p1, 3);
    lockFor(p2, 5);
    ticks(engine, 1, { [p1.id]: press({ step: true }), [p2.id]: tap("thrust") });
    expect(p1.inputBuffer?.action).toBe("step");
    expect(p2.inputBuffer).toMatchObject({ action: "attack", attack: "thrust" });
    ticks(engine, 2);
    expect(p1.mode).toBe("step");
    expect(p2.mode).toBe("recovery");
    expect(p2.inputBuffer?.action).toBe("attack");
    ticks(engine, 2);
    expect(p2.mode).toBe("charge");
    expect(p2.attack).toBe("thrust");
    expect(p1.mode).toBe("step");
  });

  test("one player's press never lands in an idle opponent's buffer", () => {
    const { engine, fighters } = versus("duel", { controls: { 0: "keyboard", 1: "pad1" } });
    const [p1, p2] = fighters;
    lockFor(p1, 4);
    ticks(engine, 1, { [p1.id]: press({ grab: true }) });
    expect(p2.inputBuffer).toBeNull();
    expect(p2.mode).toBe("idle");
    ticks(engine, 3);
    expect(p1.mode).toBe("grab");
    expect(p2.mode).toBe("idle");
  });
});
