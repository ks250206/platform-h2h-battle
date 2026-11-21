import { describe, expect, test } from "vite-plus/test";
import {
  CAMERA_FORWARD,
  CAMERA_OFFSET,
  CAMERA_RIGHT,
  screenToWorldMovement,
} from "../src/game/coordinates";
import { screenMoveToWorld } from "../src/game/input";

const dot = (a: { x: number; z: number }, b: { x: number; z: number }) => a.x * b.x + a.z * b.z;

describe("camera yaw shared by renderer and input", () => {
  test("screen up moves away from the camera", () => {
    const up = screenToWorldMovement(0, -1);
    // The camera sits at +CAMERA_OFFSET, so "away" points against its ground offset.
    expect(dot(up, { x: CAMERA_OFFSET.x, z: CAMERA_OFFSET.z })).toBeLessThan(0);
    expect(up.x).toBeCloseTo(-0.6);
    expect(up.z).toBeCloseTo(-0.8);
  });

  test("screen right is perpendicular to screen up and on the camera's right", () => {
    const up = screenToWorldMovement(0, -1);
    const right = screenToWorldMovement(1, 0);
    expect(dot(up, right)).toBeCloseTo(0);
    expect(right.x).toBeCloseTo(0.8);
    expect(right.z).toBeCloseTo(-0.6);
    // Looking along `up` with +Y overhead, the right-hand side is up × Y = (-up.z, up.x).
    expect(dot(right, { x: -up.z, z: up.x })).toBeCloseTo(1);
  });

  test("preserves length for any screen direction", () => {
    for (const [sx, sy] of [
      [1, 0],
      [0, 1],
      [0.3, -0.4],
      [-2, 1.5],
      [0.7071, 0.7071],
    ] as const) {
      const world = screenToWorldMovement(sx, sy);
      expect(Math.hypot(world.x, world.z)).toBeCloseTo(Math.hypot(sx, sy));
    }
  });

  test("agrees with the exported camera constants", () => {
    const ground = Math.hypot(CAMERA_OFFSET.x, CAMERA_OFFSET.z);
    expect(CAMERA_FORWARD.x).toBeCloseTo(-CAMERA_OFFSET.x / ground);
    expect(CAMERA_FORWARD.z).toBeCloseTo(-CAMERA_OFFSET.z / ground);
    expect(screenToWorldMovement(0, -1)).toEqual(CAMERA_FORWARD);
    expect(screenToWorldMovement(1, 0)).toEqual(CAMERA_RIGHT);
    // Same mapping as platform-survival's fixed camera.
    expect(screenToWorldMovement(0.5, 0.25)).toEqual({
      x: 0.5 * 0.8 + 0.25 * 0.6,
      z: -0.5 * 0.6 + 0.25 * 0.8,
    });
  });
});

describe("input movement mapping", () => {
  test("KeyD alone still increases world x", () => {
    expect(screenMoveToWorld(1, 0).x).toBeGreaterThan(0.5);
  });

  test("clamps diagonals and summed sources to unit length", () => {
    const diagonal = screenMoveToWorld(1, -1);
    expect(Math.hypot(diagonal.x, diagonal.z)).toBeCloseTo(1);
    const doubled = screenMoveToWorld(2, 0);
    expect(doubled.x).toBeCloseTo(CAMERA_RIGHT.x);
    expect(doubled.z).toBeCloseTo(CAMERA_RIGHT.z);
  });

  test("keeps partial stick tilt and zero input", () => {
    const half = screenMoveToWorld(0, -0.5);
    expect(Math.hypot(half.x, half.z)).toBeCloseTo(0.5);
    expect(screenMoveToWorld(0, 0)).toEqual({ x: 0, z: 0 });
  });
});
