import { describe, expect, test } from "vite-plus/test";
import { BattleEngine } from "../src/game/engine";
import { ATTACKS, RULES } from "../src/game/tuning";
import { emptyInput } from "../src/game/types";
import type { AttackId, Fighter, PlayerInput } from "../src/game/types";
import { FighterMotion } from "../src/render/motion";
import type { MotionFrame } from "../src/render/motion";
import { attackPose, GUARD, SHOULDER } from "../src/render/poses";
import { BODY, mirrorPose, solve } from "../src/render/skeleton";
import type { Pose, Skeleton } from "../src/render/skeleton";
import type { V3 } from "../src/render/math3";

const DT = 1 / 60;
const ATTACK_IDS: AttackId[] = ["overhead", "rising", "sweep", "thrust"];
const FLOOR = { ground: 0, flat: { x: 1, y: 0, z: 0 } };
const distance = (a: V3, b: V3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const yawOf = (v: V3) => (Math.atan2(v.x, v.z) * 180) / Math.PI;

function finite(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(finite);
  if (value && typeof value === "object") return Object.values(value).every(finite);
  return true;
}

function bladeDirection(skeleton: Skeleton): V3 {
  const length = BODY.bladeTip - BODY.bladeBase;
  return {
    x: (skeleton.bladeTip.x - skeleton.bladeBase.x) / length,
    y: (skeleton.bladeTip.y - skeleton.bladeBase.y) / length,
    z: (skeleton.bladeTip.z - skeleton.bladeBase.z) / length,
  };
}

/** Every pose the attack timelines can produce, on both sides and at both ends of the charge. */
function* timelinePoses(): Generator<{ label: string; pose: Pose }> {
  for (const attack of ATTACK_IDS)
    for (const charge of [0, 1])
      for (let at = 0; at <= 3.0001; at += 0.05) {
        const pose = attackPose(attack, at, charge);
        yield { label: `${attack} c${charge} @${at.toFixed(2)}`, pose };
        yield { label: `${attack} c${charge} @${at.toFixed(2)} mirrored`, pose: mirrorPose(pose) };
      }
  yield { label: "guard", pose: GUARD };
  yield { label: "shoulder", pose: SHOULDER };
}

describe("skeleton solver", () => {
  test("keeps every limb its own length and every joint finite", () => {
    for (const { label, pose } of timelinePoses()) {
      const skeleton = solve(pose, FLOOR);
      expect(finite(skeleton), label).toBe(true);
      for (const arm of skeleton.arms) {
        expect(distance(arm.upper.p, arm.lower.p), label).toBeCloseTo(BODY.upperArm, 4);
        expect(distance(arm.lower.p, arm.end.p), label).toBeCloseTo(BODY.foreArm, 4);
      }
      for (const leg of skeleton.legs) {
        expect(distance(leg.upper.p, leg.lower.p), label).toBeCloseTo(BODY.thigh, 4);
        expect(distance(leg.lower.p, leg.end.p), label).toBeCloseTo(BODY.shin, 4);
      }
    }
  });

  test("never pushes the blade or the feet through the floor", () => {
    for (const { label, pose } of timelinePoses()) {
      const skeleton = solve(pose, FLOOR);
      expect(skeleton.bladeTip.y, label).toBeGreaterThanOrEqual(0);
      for (const leg of skeleton.legs)
        expect(leg.end.p.y, label).toBeGreaterThanOrEqual(BODY.ankle - 1e-6);
    }
  });

  test("keeps the leading hand on the hilt through every swing", () => {
    for (const { label, pose } of timelinePoses()) {
      if (pose.offFree > 0 || Math.abs(pose.side) < 0.999) continue;
      const skeleton = solve(pose, FLOOR);
      const direction = bladeDirection(skeleton);
      const lead = pose.side > 0 ? 1 : 0;
      const hilt = {
        x: skeleton.sword.p.x + direction.x * BODY.gripLead,
        y: skeleton.sword.p.y + direction.y * BODY.gripLead,
        z: skeleton.sword.p.z + direction.z * BODY.gripLead,
      };
      expect(distance(skeleton.arms[lead]!.end.p, hilt), label).toBeLessThan(0.02);
    }
  });

  test("mirroring swaps sides exactly and is its own inverse", () => {
    for (const { label, pose } of timelinePoses()) {
      const original = solve(pose, FLOOR);
      const mirrored = solve(mirrorPose(pose), { ground: 0, flat: { x: -1, y: 0, z: 0 } });
      expect(mirrored.bladeTip.x, label).toBeCloseTo(-original.bladeTip.x, 5);
      expect(mirrored.bladeTip.y, label).toBeCloseTo(original.bladeTip.y, 5);
      expect(mirrored.legs[0].end.p.x, label).toBeCloseTo(-original.legs[1].end.p.x, 5);
      const twice = solve(mirrorPose(mirrorPose(pose)), FLOOR);
      expect(twice.bladeTip.x, label).toBeCloseTo(original.bladeTip.x, 6);
      expect(twice.arms[0].end.p.z, label).toBeCloseTo(original.arms[0].end.p.z, 6);
    }
  });
});

describe("the blade is where the hit is", () => {
  const during = (attack: AttackId, from: number, to: number): Skeleton[] => {
    const result: Skeleton[] = [];
    for (let at = from; at <= to + 1e-6; at += 0.02)
      result.push(solve(attackPose(attack, at, 0), FLOOR));
    return result;
  };

  test("the overhead comes down in front and ends on the floor at the attack's reach", () => {
    const active = during("overhead", 1, 2);
    expect(bladeDirection(active[0]!).y).toBeGreaterThan(0.8);
    const end = active[active.length - 1]!;
    expect(end.tipOnGround).toBe(true);
    expect(Math.abs(end.bladeTip.x)).toBeLessThan(ATTACKS.overhead.width);
    expect(end.bladeTip.z).toBeGreaterThan(ATTACKS.overhead.reach * 0.8);
    expect(end.bladeTip.z).toBeLessThan(ATTACKS.overhead.reach + RULES.fighterRadius);
  });

  test("the sweep carries the blade across the whole fan it can hit in", () => {
    const yaws = during("sweep", 1, 2).map((skeleton) => yawOf(bladeDirection(skeleton)));
    expect(Math.min(...yaws)).toBeLessThan(-79);
    expect(Math.max(...yaws)).toBeGreaterThan(79);
    for (const skeleton of during("sweep", 1, 2)) {
      const reach = Math.hypot(skeleton.bladeTip.x, skeleton.bladeTip.z);
      expect(reach).toBeGreaterThan(ATTACKS.sweep.reach * 0.75);
      expect(reach).toBeLessThan(ATTACKS.sweep.reach + RULES.fighterRadius + 0.2);
    }
  });

  test("the thrust drives the point straight out to its reach", () => {
    const end = during("thrust", 1.4, 2);
    for (const skeleton of end) {
      expect(Math.abs(skeleton.bladeTip.x)).toBeLessThan(ATTACKS.thrust.width);
      expect(skeleton.bladeTip.z).toBeGreaterThan(ATTACKS.thrust.reach * 0.92);
      expect(skeleton.bladeTip.z).toBeLessThan(ATTACKS.thrust.reach + RULES.fighterRadius);
    }
  });

  test("the riser scoops from the floor to straight overhead", () => {
    const active = during("rising", 1, 2);
    expect(active[0]!.tipOnGround).toBe(true);
    expect(bladeDirection(active[active.length - 1]!).y).toBeGreaterThan(0.9);
  });
});

/** Runs the real simulation and the animator together, as the renderer does. */
function simulate(
  seconds: number,
  control: (frame: number, fighter: Fighter) => Partial<PlayerInput>,
  prepare?: (engine: BattleEngine) => void,
) {
  const engine = new BattleEngine(7);
  engine.start("training");
  engine.state.phase = "playing";
  const fighter = () => engine.state.fighters[0]!;
  Object.assign(fighter(), { x: 0, z: 0, facing: 0 });
  Object.assign(engine.state.fighters[1]!, { x: -8, z: -8 });
  prepare?.(engine);
  const motion = new FighterMotion();
  const frames: { frame: MotionFrame; fighter: Fighter }[] = [];
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    engine.update(DT, { ...emptyInput(), aim: { x: 0, z: 1 }, ...control(i, fighter()) });
    const frame = motion.update(fighter(), DT, { floor: true, atEase: false });
    frames.push({ frame, fighter: structuredClone(fighter()) });
  }
  return { frames, motion, engine };
}

const tap = (attack: AttackId) => (frame: number) =>
  frame === 0 ? { attackPressed: attack, attackHeld: attack } : {};

describe("fighter motion", () => {
  test("every frame of every action is finite", () => {
    for (const attack of ATTACK_IDS) {
      const { frames } = simulate(2, tap(attack));
      for (const { frame } of frames) expect(finite(frame), attack).toBe(true);
    }
    const actions = simulate(3, (frame) => ({
      jump: frame === 5,
      step: frame === 80,
      grab: frame === 120,
      move: frame > 30 && frame < 100 ? { x: 1, z: 0.4 } : { x: 0, z: 0 },
    }));
    for (const { frame } of actions.frames) expect(finite(frame)).toBe(true);
  });

  test("a sweep or a riser leaves the sword on the other side; a chop or a thrust does not", () => {
    for (const attack of ATTACK_IDS) {
      const { motion, frames } = simulate(2.4, tap(attack));
      expect(frames[frames.length - 1]!.fighter.mode, attack).toBe("idle");
      expect(motion.swordSide, attack).toBe(attack === "sweep" || attack === "rising" ? -1 : 1);
    }
  });

  test("a second sweep swings back the other way", () => {
    const { motion, frames } = simulate(3.2, (frame) =>
      frame === 0 || frame === 90 ? { attackPressed: "sweep", attackHeld: "sweep" } : {},
    );
    expect(motion.swordSide).toBe(1);
    const firstActive = frames.find((entry) => entry.fighter.mode === "active")!;
    const secondActive = frames.slice(90).find((entry) => entry.fighter.mode === "active")!;
    const side = (entry: typeof firstActive) => entry.frame.bladeTip.x - entry.fighter.x;
    // Facing +Z, the fighter's right is world -X: the first cut starts there, the second mirrors it.
    expect(side(firstActive)).toBeLessThan(-1);
    expect(side(secondActive)).toBeGreaterThan(1);
  });

  test("a grounded overhead slams the floor exactly once, inside its active window", () => {
    const { frames } = simulate(2, tap("overhead"));
    const slams = frames.filter((entry) => entry.frame.events.some((e) => e.kind === "slam"));
    expect(slams).toHaveLength(1);
    expect(slams[0]!.fighter.mode).toBe("active");
    const slam = slams[0]!.frame.events.find((e) => e.kind === "slam")!;
    expect(slam.z).toBeGreaterThan(ATTACKS.overhead.reach * 0.8);
  });

  test("the trail is drawn through the cut and not while the sword is at rest", () => {
    for (const attack of ATTACK_IDS) {
      const { frames } = simulate(2.4, tap(attack));
      for (const { frame, fighter } of frames) {
        if (fighter.mode === "active") expect(frame.trail, attack).toBeGreaterThan(0.9);
        if (fighter.mode === "idle" || fighter.mode === "charge")
          expect(frame.trail, attack).toBe(0);
      }
    }
  });

  test("hit-stop freezes the pose with the simulation", () => {
    const { frames } = simulate(1.2, tap("overhead"), (engine) => {
      // Put the practice dummy in the blade's path so the swing connects.
      Object.assign(engine.state.fighters[1]!, { x: 0, z: 1.8 });
    });
    const frozen = frames.filter((entry) => entry.fighter.hitstop > 0);
    expect(frozen.length).toBeGreaterThan(2);
    const first = frozen[1]!.frame.skeleton,
      last = frozen[frozen.length - 1]!.frame.skeleton;
    expect(distance(first.bladeTip, last.bladeTip)).toBeLessThan(1e-6);
    expect(distance(first.pelvis.p, last.pelvis.p)).toBeLessThan(1e-6);
  });

  test("a running foot stays planted on the ground while it carries the weight", () => {
    const { frames } = simulate(2, () => ({ move: { x: 0, z: 1 } }));
    const settled = frames.slice(60);
    for (const leg of [0, 1] as const) {
      let planted: V3 | null = null;
      let worst = 0;
      let stances = 0;
      for (const { frame, fighter } of settled) {
        const ankle = frame.skeleton.legs[leg].end.p;
        // Facing +Z, body space and world space only differ by the fighter's position.
        const world = { x: fighter.x + ankle.x, y: ankle.y, z: fighter.z + ankle.z };
        if (ankle.y > BODY.ankle + 0.002) {
          planted = null;
          continue;
        }
        if (!planted) {
          planted = world;
          stances++;
        } else worst = Math.max(worst, Math.hypot(world.x - planted.x, world.z - planted.z));
      }
      expect(stances).toBeGreaterThan(1);
      expect(worst).toBeLessThan(0.12);
    }
  });

  test("a knocked-back fighter tumbles the way the blow sent it and comes out upright", () => {
    const engine = new BattleEngine(3);
    engine.start("training");
    engine.state.phase = "playing";
    const [attacker, victim] = engine.state.fighters as [Fighter, Fighter];
    Object.assign(attacker, { x: 0, z: 0, facing: 0 });
    Object.assign(victim, { x: 0, z: 1.8, facing: Math.PI, damage: 60 });
    const motion = new FighterMotion();
    let peak = 0;
    let lastTumble = 0;
    for (let i = 0; i < 240; i++) {
      engine.update(DT, {
        ...emptyInput(),
        aim: { x: 0, z: 1 },
        ...(i === 0 ? { attackPressed: "overhead" as const, attackHeld: "overhead" as const } : {}),
      });
      const target = engine.state.fighters[1]!;
      const frame = motion.update(target, DT, { floor: true, atEase: false });
      lastTumble = Math.hypot(
        frame.skeleton.tumble.x,
        frame.skeleton.tumble.y,
        frame.skeleton.tumble.z,
      );
      peak = Math.max(peak, lastTumble);
    }
    expect(engine.state.stats.hits).toBe(1);
    expect(peak).toBeGreaterThan(1);
    expect(lastTumble).toBeLessThan(0.05);
  });
});
