import { describe, expect, test } from "vite-plus/test";
import { fxSpot, fxStyle, type FxKind } from "../src/render/finishFx";

const KINDS: FxKind[] = ["trainingKo", "stockKo", "elimination", "finish"];

describe("finish highlights", () => {
  test("each moment is bigger than the one before; a finish is unmistakable", () => {
    for (const reduced of [false, true]) {
      const styles = KINDS.map((kind) => fxStyle(kind, reduced));
      for (let i = 1; i < styles.length; i++) {
        expect(styles[i]!.life).toBeGreaterThan(styles[i - 1]!.life);
        expect(styles[i]!.ringRadius).toBeGreaterThan(styles[i - 1]!.ringRadius);
        expect(styles[i]!.rings).toBeGreaterThanOrEqual(styles[i - 1]!.rings);
      }
    }
  });

  test("short and thin: nothing stands over the arena for long", () => {
    for (const kind of KINDS) {
      const style = fxStyle(kind, false);
      expect(style.life).toBeLessThanOrEqual(1.5);
      expect(style.beamRadius).toBeLessThanOrEqual(0.6);
    }
  });

  test("a stock KO adds no extra shake (the KO impact already has its own)", () => {
    expect(fxStyle("stockKo", false).shake).toBe(0);
    expect(fxStyle("trainingKo", false).shake).toBe(0);
  });

  test("reduced flash drops the bright core and softens the jolt but keeps the shapes", () => {
    for (const kind of KINDS) {
      const normal = fxStyle(kind, false);
      const reduced = fxStyle(kind, true);
      expect(reduced.core).toBe(false);
      expect(reduced.shake).toBeLessThanOrEqual(0.5);
      expect(reduced.rings).toBe(normal.rings);
      expect(reduced.beamHeight).toBe(normal.beamHeight);
    }
  });

  test("a fighter blasted far away gets its beam at the edge of the view", () => {
    expect(fxSpot(40, -30, -50, 7)).toEqual({ x: 8.5, y: 0, z: -8.5 });
    expect(fxSpot(1, 2, 3, 7)).toEqual({ x: 1, y: 2, z: 3 });
    expect(fxSpot(Number.NaN, Number.POSITIVE_INFINITY, 0, 7)).toEqual({ x: 0, y: 0, z: 0 });
  });
});
