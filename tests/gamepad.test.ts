import { describe, expect, test } from "vite-plus/test";
import {
  BUTTON,
  freshPadMemory,
  heldNav,
  isDown,
  menuDirection,
  NAV_DELAY,
  NAV_INTERVAL,
  readPad,
  readStick,
  rumbleFor,
  stepNav,
  type PadMemory,
  type PadSnapshot,
} from "../src/game/gamepad";

/** A standard pad at rest, with the given buttons down (value 1) and axes. */
function pad(down: number[] = [], axes: number[] = [0, 0, 0, 0]): PadSnapshot {
  return {
    axes,
    buttons: Array.from({ length: 17 }, (_, i) => ({
      pressed: down.includes(i),
      value: down.includes(i) ? 1 : 0,
    })),
  };
}

/** Feeds snapshots in order, like frames; returns each frame's commands. */
function play(...frames: PadSnapshot[]) {
  let previous: PadSnapshot | null = null;
  let memory: PadMemory = freshPadMemory();
  return frames.map((frame) => {
    const result = readPad(frame, previous, memory);
    previous = frame;
    memory = result.memory;
    return result.commands;
  });
}

const rest = pad();

describe("pad bindings", () => {
  test("shoulders and triggers are the four attacks (Dark Souls layout)", () => {
    expect(play(rest, pad([BUTTON.RB]))[1]!.attackPressed).toBe("sweep");
    expect(play(rest, pad([BUTTON.RT]))[1]!.attackPressed).toBe("overhead");
    expect(play(rest, pad([BUTTON.LB]))[1]!.attackPressed).toBe("thrust");
    expect(play(rest, pad([BUTTON.LT]))[1]!.attackPressed).toBe("rising");
  });

  test("face buttons: A jumps, B steps, X grabs, Y cancels", () => {
    const [, a] = play(rest, pad([BUTTON.A]));
    expect(a).toMatchObject({ jump: true, step: false, grab: false, cancel: false });
    expect(play(rest, pad([BUTTON.B]))[1]).toMatchObject({ step: true, jump: false });
    expect(play(rest, pad([BUTTON.X]))[1]).toMatchObject({ grab: true, jump: false });
    expect(play(rest, pad([BUTTON.Y]))[1]).toMatchObject({ cancel: true, jump: false });
    // Face buttons are never attacks.
    expect(a!.attackPressed).toBeNull();
    expect(a!.attackHeld).toBeNull();
  });

  test("R3 toggles the lock-on, D-pad left / right switch target, View and Start", () => {
    expect(play(rest, pad([BUTTON.R3]))[1]!.toggleLock).toBe(true);
    expect(play(rest, pad([BUTTON.LEFT]))[1]!.cycle).toBe(-1);
    expect(play(rest, pad([BUTTON.RIGHT]))[1]!.cycle).toBe(1);
    expect(play(rest, pad([BUTTON.VIEW]))[1]!.camera).toBe(true);
    expect(play(rest, pad([BUTTON.START]))[1]!.pause).toBe(true);
  });

  test("the D-pad does not move; up / down do nothing in a match", () => {
    const [, up] = play(rest, pad([BUTTON.UP, BUTTON.DOWN]));
    expect(up!.move).toEqual({ x: 0, y: 0 });
    expect(up!.cycle).toBe(0);
  });

  test("the left stick moves, the right stick aims", () => {
    const [frame] = play(pad([], [1, 0, 0, -1]));
    expect(frame!.move.x).toBeCloseTo(1);
    expect(frame!.move.y).toBeCloseTo(0);
    expect(frame!.aim!.x).toBeCloseTo(0);
    expect(frame!.aim!.y).toBeCloseTo(-1);
    expect(play(rest)[0]!.aim).toBeNull();
  });

  test("presses fire once, on the frame the button goes down", () => {
    const frames = play(
      rest,
      pad([BUTTON.A, BUTTON.RB]),
      pad([BUTTON.A, BUTTON.RB]),
      rest,
      pad([BUTTON.A]),
    );
    expect(frames.map((f) => f.jump)).toEqual([false, true, false, false, true]);
    expect(frames.map((f) => f.attackPressed)).toEqual([null, "sweep", null, null, null]);
  });

  test("a held attack keeps reporting itself until released (charging)", () => {
    const frames = play(rest, pad([BUTTON.RT]), pad([BUTTON.RT]), pad([BUTTON.RT]), rest);
    expect(frames.map((f) => f.attackHeld)).toEqual([
      null,
      "overhead",
      "overhead",
      "overhead",
      null,
    ]);
  });

  test("the attack pressed last is the one held while two are down", () => {
    const frames = play(
      rest,
      pad([BUTTON.LT]),
      pad([BUTTON.LT, BUTTON.RB]),
      pad([BUTTON.LT, BUTTON.RB]),
      pad([BUTTON.LT]),
    );
    expect(frames.map((f) => f.attackPressed)).toEqual([null, "rising", "sweep", null, null]);
    expect(frames.map((f) => f.attackHeld)).toEqual([null, "rising", "sweep", "sweep", "rising"]);
  });

  test("simultaneous presses pick RB, RT, LB, LT in that order", () => {
    expect(play(rest, pad([BUTTON.LT, BUTTON.LB, BUTTON.RT]))[1]!.attackPressed).toBe("overhead");
  });

  test("triggers count from half-way, with the edge on that threshold", () => {
    const trigger = (value: number): PadSnapshot => {
      const snapshot = pad();
      (snapshot.buttons as { pressed: boolean; value: number }[])[BUTTON.RT] = {
        pressed: value > 0.05,
        value,
      };
      return snapshot;
    };
    expect(isDown(trigger(0.3), BUTTON.RT)).toBe(false);
    expect(isDown(trigger(0.5), BUTTON.RT)).toBe(true);
    const frames = play(
      trigger(0.2),
      trigger(0.45),
      trigger(0.6),
      trigger(0.9),
      trigger(0.4),
      trigger(0.7),
    );
    expect(frames.map((f) => f.attackPressed)).toEqual([
      null,
      null,
      "overhead",
      null,
      null,
      "overhead",
    ]);
    expect(frames.map((f) => f.attackHeld)).toEqual([
      null,
      null,
      "overhead",
      "overhead",
      null,
      "overhead",
    ]);
  });
});

describe("sticks", () => {
  test("a radial dead zone of 0.2, rescaled so its edge reads 0", () => {
    expect(readStick([0.19, 0], 0)).toEqual({ x: 0, y: 0 });
    expect(readStick([0.14, 0.14], 0)).toEqual({ x: 0, y: 0 });
    const half = readStick([0.6, 0], 0);
    expect(half.x).toBeCloseTo(0.5);
    const full = readStick([0, -1], 0);
    expect(full.y).toBeCloseTo(-1);
    // Just past the edge is a tiny value, not a jump to 0.2.
    expect(readStick([0.21, 0], 0).x).toBeCloseTo(0.0125);
  });

  test("never longer than 1, direction kept", () => {
    const corner = readStick([1, 1], 0);
    expect(Math.hypot(corner.x, corner.y)).toBeCloseTo(1);
    expect(corner.x).toBeCloseTo(corner.y);
  });

  test("a right-stick flick switches once and re-arms near the centre", () => {
    const flick = (x: number, y = 0) => pad([], [0, 0, x, y]);
    const frames = play(
      rest,
      flick(0.9),
      flick(1),
      flick(0.5),
      flick(0.95),
      flick(0.1),
      flick(-0.9),
    );
    expect(frames.map((f) => f.cycle)).toEqual([0, 1, 0, 0, 0, 0, -1]);
    // Mostly vertical is not a flick.
    expect(play(rest, flick(0.75, 0.9))[1]!.cycle).toBe(0);
  });
});

describe("robustness", () => {
  test("short, empty or odd arrays read as released and centred", () => {
    const odd = [
      { axes: [], buttons: [] },
      { axes: [0.5], buttons: [{ pressed: true, value: 1 }] },
      { axes: [Number.NaN, Infinity], buttons: [] },
      { axes: undefined, buttons: undefined } as unknown as PadSnapshot,
    ];
    for (const snapshot of odd) {
      expect(() => readPad(snapshot, null, freshPadMemory())).not.toThrow();
      expect(() => menuDirection(snapshot)).not.toThrow();
      const { commands } = readPad(snapshot, rest, freshPadMemory());
      expect(commands.attackHeld).toBeNull();
      expect(commands.pause).toBe(false);
    }
    // Index 0 present: A on a one-button pad still jumps.
    expect(readPad(odd[1]!, rest, freshPadMemory()).commands.jump).toBe(true);
    const nan = readPad(odd[2]!, null, freshPadMemory()).commands;
    expect(nan.move).toEqual({ x: 0, y: 0 });
  });
});

describe("menus", () => {
  test("D-pad or left stick past half-way gives a direction", () => {
    expect(menuDirection(pad([BUTTON.UP]))).toBe("up");
    expect(menuDirection(pad([BUTTON.RIGHT]))).toBe("right");
    expect(menuDirection(pad([], [0, 0.9, 0, 0]))).toBe("down");
    expect(menuDirection(pad([], [-0.8, 0.2, 0, 0]))).toBe("left");
    expect(menuDirection(pad([], [0.4, 0, 0, 0]))).toBeNull();
    expect(menuDirection(pad([], [0, 0, 1, 0]))).toBeNull();
  });

  test("a held direction steps at once, then repeats after a delay", () => {
    let repeat = { direction: null, next: 0 } as ReturnType<typeof heldNav>;
    const at = (t: number, dir: "down" | null) => {
      const result = stepNav(repeat, dir, t);
      repeat = result.repeat;
      return result.step;
    };
    expect(at(0, "down")).toBe("down");
    expect(at(0.1, "down")).toBeNull();
    expect(at(NAV_DELAY + 0.01, "down")).toBe("down");
    expect(at(NAV_DELAY + 0.02, "down")).toBeNull();
    expect(at(NAV_DELAY + NAV_INTERVAL + 0.02, "down")).toBe("down");
    expect(at(1, null)).toBeNull();
    expect(at(1.01, "down")).toBe("down");
  });

  test("a direction held when a layer takes over does nothing until released", () => {
    let repeat = heldNav("left");
    for (const t of [0, 1, 5]) {
      const result = stepNav(repeat, "left", t);
      expect(result.step).toBeNull();
      repeat = result.repeat;
    }
    expect(stepNav(repeat, null, 6).step).toBeNull();
    expect(stepNav(stepNav(repeat, null, 6).repeat, "left", 7).step).toBe("left");
  });
});

describe("rumble", () => {
  const sample = (mode: string, hitstop: number, damage = 0) =>
    ({ mode, hitstop, damage }) as Parameters<typeof rumbleFor>[1];

  test("being hit rumbles, harder for a bigger hit", () => {
    const light = rumbleFor(sample("idle", 0, 10), sample("hitstun", 0.1, 16))!;
    const heavy = rumbleFor(sample("idle", 0, 10), sample("hitstun", 0.12, 40))!;
    expect(light.strongMagnitude).toBeGreaterThan(0);
    expect(heavy.strongMagnitude).toBeGreaterThan(light.strongMagnitude);
    expect(heavy.duration).toBeGreaterThan(light.duration);
    expect(heavy.strongMagnitude).toBeLessThanOrEqual(1);
  });

  test("landing a hit and clashing rumble too, a hit landed the lightest", () => {
    const landed = rumbleFor(sample("active", 0), sample("active", 0.1))!;
    const clash = rumbleFor(sample("active", 0), sample("clash", 0.15))!;
    expect(landed.strongMagnitude).toBeLessThan(clash.strongMagnitude);
    expect(rumbleFor(sample("recovery", 0), sample("recovery", 0.1))).not.toBeNull();
  });

  test("only a new hit-stop counts: it running down, or nothing happening, is quiet", () => {
    expect(rumbleFor(null, sample("hitstun", 0.1))).toBeNull();
    expect(rumbleFor(sample("hitstun", 0.1), sample("hitstun", 0.08))).toBeNull();
    expect(rumbleFor(sample("idle", 0), sample("idle", 0))).toBeNull();
    expect(rumbleFor(sample("charge", 0), sample("charge", 0.1))).toBeNull();
  });
});
