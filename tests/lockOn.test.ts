import { describe, expect, test } from "vite-plus/test";
import { BattleEngine } from "../src/game/engine";
import { screenToWorldMovement } from "../src/game/coordinates";
import { cycleTarget, lockCandidates, resolveTarget, screenBearing } from "../src/game/lockOn";
import type { GameState } from "../src/game/types";

/** A match with the player (id 0) at the origin and each opponent at a screen offset. */
function arena(mode: "duel" | "rumble", offsets: Record<number, [number, number]>): GameState {
  const engine = new BattleEngine();
  engine.start(mode);
  const state = structuredClone(engine.state);
  for (const f of state.fighters) {
    const [sx, sy] = f.id === 0 ? [0, 0] : (offsets[f.id] ?? [0, 0]);
    const world = screenToWorldMovement(sx, sy);
    f.x = world.x;
    f.z = world.z;
    f.mode = "idle";
  }
  return state;
}

// Screen offsets: +x right, +y down. Opponent 1 above the player, 2 to the right, 3 to the left.
const around = { 1: [0, -3], 2: [5, 0], 3: [-7, 0] } satisfies Record<number, [number, number]>;

describe("screen bearing", () => {
  test("is clockwise from screen up", () => {
    const at = (sx: number, sy: number) =>
      screenBearing({ x: 0, z: 0 }, screenToWorldMovement(sx, sy));
    expect(at(0, -1)).toBeCloseTo(0);
    expect(at(1, 0)).toBeCloseTo(Math.PI / 2);
    expect(at(0, 1)).toBeCloseTo(Math.PI);
    expect(at(-1, 0)).toBeCloseTo((3 * Math.PI) / 2);
  });
});

describe("resolveTarget", () => {
  test("acquires the nearest living opponent", () => {
    expect(resolveTarget(arena("rumble", around), 0, null)).toBe(1);
  });

  test("is sticky when another opponent is nearer", () => {
    const state = arena("rumble", around);
    expect(resolveTarget(state, 0, 3)).toBe(3);
  });

  test("falls to the nearest when the target is down for good", () => {
    const state = arena("rumble", around);
    state.fighters[3]!.mode = "dead";
    state.fighters[3]!.stocks = 0;
    expect(resolveTarget(state, 0, 3)).toBe(1);
  });

  test("falls to the nearest when the target is waiting to respawn", () => {
    const state = arena("rumble", around);
    state.fighters[1]!.mode = "dead";
    state.fighters[1]!.stocks = 2;
    state.fighters[1]!.respawnTimer = 1;
    expect(resolveTarget(state, 0, 1)).toBe(2);
    expect(lockCandidates(state, 0).map((f) => f.id)).toEqual([2, 3]);
  });

  test("is null with nobody to lock, and re-acquires once someone is back", () => {
    const state = arena("duel", { 1: [0, -3] });
    state.fighters[1]!.mode = "dead";
    expect(resolveTarget(state, 0, 1)).toBeNull();
    state.fighters[1]!.mode = "idle";
    expect(resolveTarget(state, 0, null)).toBe(1);
  });

  test("never locks the player itself", () => {
    const state = arena("duel", { 1: [0, 0] });
    expect(resolveTarget(state, 0, 0)).toBe(1);
  });
});

describe("cycleTarget", () => {
  test("goes clockwise on screen for next", () => {
    const state = arena("rumble", around);
    expect(cycleTarget(state, 0, 1, 1)).toBe(2);
    expect(cycleTarget(state, 0, 2, 1)).toBe(3);
    expect(cycleTarget(state, 0, 3, 1)).toBe(1);
  });

  test("goes anticlockwise for previous", () => {
    const state = arena("rumble", around);
    expect(cycleTarget(state, 0, 1, -1)).toBe(3);
    expect(cycleTarget(state, 0, 3, -1)).toBe(2);
    expect(cycleTarget(state, 0, 2, -1)).toBe(1);
  });

  test("skips opponents that are down", () => {
    const state = arena("rumble", around);
    state.fighters[2]!.mode = "dead";
    expect(cycleTarget(state, 0, 1, 1)).toBe(3);
  });

  test("does nothing with a single opponent", () => {
    const state = arena("duel", { 1: [2, 2] });
    expect(cycleTarget(state, 0, 1, 1)).toBe(1);
    expect(cycleTarget(state, 0, 1, -1)).toBe(1);
  });

  test("acquires the nearest without a valid current target", () => {
    const state = arena("rumble", around);
    expect(cycleTarget(state, 0, null, 1)).toBe(1);
    state.fighters[1]!.mode = "dead";
    expect(cycleTarget(state, 0, 1, 1)).toBe(2);
  });

  test("visits opponents standing on the same bearing", () => {
    const state = arena("rumble", { 1: [0, -2], 2: [0, -4], 3: [0, -6] });
    const seen = new Set<number | null>();
    let id: number | null = 1;
    for (let i = 0; i < 3; i++) {
      id = cycleTarget(state, 0, id, 1);
      seen.add(id);
    }
    expect(seen).toEqual(new Set([1, 2, 3]));
  });
});
