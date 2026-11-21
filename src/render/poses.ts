import {
  dirYE,
  easeIn,
  easeInCubic,
  easeInOut,
  easeOut,
  easeOutBack,
  easeOutCubic,
  norm,
  sub,
  v3,
} from "./math3";
import type { V3 } from "./math3";
import { blendPose, mirrorPose, neckBase } from "./skeleton";
import type { Pose } from "./skeleton";
import type { AttackId } from "../game/types";

/**
 * Key poses are authored for a fighter carrying the sword on the RIGHT (side = +1); the
 * animator mirrors them when the sword sits on the left. Body space: +Z forward, +X left.
 */
interface PoseInit extends Partial<Omit<Pose, "grip">> {
  /** Grip centre in absolute body coordinates; converted to the neck-relative channel. */
  gripAt?: V3;
}

const NEUTRAL: Pose = {
  hip: v3(),
  hipPitch: 0,
  hipRoll: 0,
  lowerYaw: 0,
  chestYaw: 0,
  chestPitch: 0,
  chestRoll: 0,
  headYaw: 0,
  headPitch: 0,
  headRoll: 0,
  grip: v3(-0.27, -0.52, -0.04),
  dir: dirYE(-172, -19),
  footL: v3(0.16, 0, 0.1),
  footR: v3(-0.16, 0, -0.1),
  footLYaw: 0,
  footRYaw: 0,
  footLPitch: 0,
  footRPitch: 0,
  side: 1,
  offFree: 0,
  offHand: v3(0.1, -0.5, 0.1),
  squash: 0,
  tumble: v3(),
};

function make(init: PoseInit, base: Pose = NEUTRAL): Pose {
  const { gripAt, ...channels } = init;
  const pose: Pose = { ...base, ...channels };
  pose.dir = norm(pose.dir, base.dir);
  if (gripAt) pose.grip = sub(gripAt, neckBase(pose));
  return pose;
}

/** Tail guard: the blade trails behind on the dominant side with its point on the floor. */
export const GUARD = make({
  hip: v3(0, -0.035, 0),
  hipPitch: 0.04,
  lowerYaw: -0.3,
  chestYaw: -0.42,
  chestPitch: 0.13,
  headYaw: 0.36,
  headPitch: -0.03,
  gripAt: v3(-0.27, 0.7, -0.04),
  dir: dirYE(-172, -19),
  footL: v3(0.17, 0, 0.17),
  footLYaw: 0.4,
  footR: v3(-0.2, 0, -0.17),
  footRYaw: -0.32,
});

/** Off duty: the blade resting on the shoulder, free hand on the hip. Title and victory. */
export const SHOULDER = make({
  hip: v3(0.02, -0.015, 0),
  lowerYaw: -0.12,
  chestYaw: -0.1,
  chestPitch: -0.03,
  headYaw: 0.08,
  headPitch: -0.02,
  gripAt: v3(-0.3, 0.98, 0.32),
  dir: dirYE(-168, 30),
  offFree: 1,
  offHand: v3(0.07, -0.45, 0.12),
  footL: v3(0.17, 0, 0.07),
  footLYaw: 0.25,
  footR: v3(-0.17, 0, -0.05),
  footRYaw: -0.2,
});

export interface Key {
  /** Position on the attack timeline: 0-1 wind-up, 1-2 active, 2-3 recovery. */
  at: number;
  pose: Pose;
  /** Easing used while arriving at this key from the previous one. */
  ease: (t: number) => number;
}
const linear = (t: number): number => t;
const key = (at: number, pose: Pose, ease: (t: number) => number = easeInOut): Key => ({
  at,
  pose,
  ease,
});

/** Blade direction in the sagittal plane: 0° forward, 90° up, 180° back. */
const sagittal = (deg: number, lean = 0): V3 =>
  norm(v3(lean, Math.sin((deg * Math.PI) / 180), Math.cos((deg * Math.PI) / 180)));

function overhead(c: number): Key[] {
  // Shouldered high on the dominant side; the body arches back as the charge builds.
  const loaded = make({
    hip: v3(0, -0.06 - 0.05 * c, -0.07 - 0.03 * c),
    hipPitch: -0.05,
    lowerYaw: -0.38,
    chestYaw: -0.52 - 0.1 * c,
    chestPitch: -0.14 - 0.1 * c,
    headYaw: 0.46,
    headPitch: 0.12,
    headRoll: 0.12,
    gripAt: v3(-0.37, 1.38 + 0.03 * c, 0.12),
    dir: sagittal(138 + 14 * c, -0.14),
    footL: v3(0.17, 0, 0.22),
    footLYaw: 0.42,
    footR: v3(-0.21, 0, -0.2),
    footRYaw: -0.34,
  });
  const coil = make(
    {
      hip: v3(0, -0.13 - 0.04 * c, -0.12),
      hipPitch: -0.1,
      chestPitch: -0.3 - 0.06 * c,
      chestYaw: -0.6 - 0.08 * c,
      gripAt: v3(-0.37, 1.4, 0.06),
      dir: sagittal(166 + 10 * c, -0.12),
      footL: v3(0.17, 0.09, 0.24),
      footLPitch: -0.25,
    },
    loaded,
  );
  // The hips have already started forward and the blade is only now coming over the top.
  const commit = make(
    {
      hip: v3(0, -0.1, 0.1),
      hipPitch: 0.1,
      lowerYaw: -0.18,
      chestYaw: -0.16,
      chestPitch: 0.14,
      headYaw: 0.14,
      headPitch: -0.05,
      headRoll: 0.04,
      gripAt: v3(-0.2, 1.46, 0.4),
      dir: sagittal(108, -0.06),
      footL: v3(0.16, 0.05, 0.46),
      footLYaw: 0.2,
      footLPitch: -0.3,
      footR: v3(-0.21, 0, -0.22),
      footRPitch: 0.25,
    },
    loaded,
  );
  // The blade buries itself in the floor in front; the whole body folds over it.
  const impact = make(
    {
      hip: v3(0, -0.27, 0.2),
      hipPitch: 0.3,
      lowerYaw: -0.05,
      chestYaw: 0.06,
      chestPitch: 0.66,
      headYaw: 0,
      headPitch: -0.32,
      headRoll: 0,
      gripAt: v3(-0.06, 0.62, 0.64),
      dir: sagittal(-22),
      footL: v3(0.17, 0, 0.52),
      footLYaw: 0.1,
      footR: v3(-0.2, 0, -0.26),
      footRYaw: -0.3,
      footRPitch: 0.55,
    },
    loaded,
  );
  const sink = make(
    {
      hip: v3(0, -0.35, 0.25),
      hipPitch: 0.36,
      chestPitch: 0.78,
      headPitch: -0.22,
      gripAt: v3(-0.06, 0.56, 0.68),
    },
    impact,
  );
  const hold = make(
    {
      hip: v3(0, -0.29, 0.22),
      chestPitch: 0.64,
      headPitch: -0.36,
      gripAt: v3(-0.06, 0.6, 0.65),
    },
    impact,
  );
  // Heaving it back: the point is dragged round the dominant side along the floor.
  const drag = make(
    {
      hip: v3(-0.02, -0.12, 0.06),
      hipPitch: 0.1,
      lowerYaw: -0.26,
      chestYaw: -0.3,
      chestPitch: 0.3,
      headYaw: 0.25,
      headPitch: -0.12,
      gripAt: v3(-0.31, 0.68, 0.1),
      dir: dirYE(-96, -19),
      footL: v3(0.17, 0, 0.34),
      footLYaw: 0.3,
      footR: v3(-0.2, 0, -0.2),
      footRYaw: -0.32,
      footRPitch: 0,
    },
    GUARD,
  );
  return [
    key(0, loaded),
    key(0.36, coil, easeInOut),
    key(1, commit, easeInCubic),
    key(1.62, impact, linear),
    key(1.98, sink, easeOutCubic),
    key(2.3, hold, easeInOut),
    key(2.74, drag, easeInOut),
    key(3, GUARD, easeOut),
  ];
}

function sweep(c: number): Key[] {
  const loaded = make({
    hip: v3(-0.03, -0.09 - 0.04 * c, -0.04),
    hipPitch: 0.04,
    lowerYaw: -0.46,
    chestYaw: -0.78 - 0.1 * c,
    chestPitch: 0.1,
    headYaw: 0.72,
    headPitch: -0.02,
    gripAt: v3(-0.34, 0.95, -0.08),
    dir: dirYE(-146 - 14 * c, 8),
    footL: v3(0.2, 0, 0.2),
    footLYaw: 0.5,
    footR: v3(-0.22, 0, -0.18),
    footRYaw: -0.3,
  });
  const coil = make(
    {
      hip: v3(-0.06, -0.16 - 0.03 * c, -0.07),
      lowerYaw: -0.55,
      chestYaw: -0.98 - 0.08 * c,
      chestPitch: 0.14,
      headYaw: 0.9,
      gripAt: v3(-0.36, 0.93, -0.12),
      dir: dirYE(-172 - 6 * c, 5),
      footL: v3(0.2, 0.08, 0.22),
      footLPitch: -0.2,
    },
    loaded,
  );
  // Hips and chest have unwound ahead of the blade, which is still catching up.
  const commit = make(
    {
      hip: v3(0.02, -0.15, 0.05),
      lowerYaw: 0.02,
      chestYaw: -0.22,
      chestPitch: 0.16,
      headYaw: 0.2,
      gripAt: v3(-0.3, 0.9, 0.14),
      dir: dirYE(-102, -2),
      footL: v3(0.2, 0, 0.32),
      footLYaw: 0.15,
      footR: v3(-0.22, 0, -0.2),
      footRYaw: -0.35,
      footRPitch: 0.2,
    },
    loaded,
  );
  const front = make(
    {
      hip: v3(0.05, -0.17, 0.09),
      lowerYaw: 0.22,
      chestYaw: 0.3,
      chestPitch: 0.2,
      headYaw: -0.2,
      gripAt: v3(0.02, 0.86, 0.52),
      dir: dirYE(0, -4),
      footR: v3(-0.2, 0, -0.2),
      footRYaw: -0.1,
      footRPitch: 0.4,
    },
    commit,
  );
  const through = make(
    {
      hip: v3(0.09, -0.15, 0.07),
      lowerYaw: 0.48,
      chestYaw: 0.74,
      chestPitch: 0.16,
      chestRoll: 0.06,
      headYaw: -0.5,
      gripAt: v3(0.31, 0.9, 0.2),
      dir: dirYE(102, -2),
      footR: v3(-0.17, 0, -0.18),
      footRYaw: 0.2,
      footRPitch: 0.5,
    },
    commit,
  );
  // The blade's momentum drags the swinger round after it: the rear foot has to step through.
  const carried = make(
    {
      hip: v3(0.12, -0.11, 0.03),
      hipRoll: 0.06,
      lowerYaw: 0.62,
      chestYaw: 1.02,
      chestPitch: 0.12,
      chestRoll: 0.12,
      headYaw: -0.7,
      gripAt: v3(0.36, 0.82, 0.0),
      dir: dirYE(156, -15),
      footL: v3(0.22, 0, 0.26),
      footLYaw: -0.15,
      footR: v3(-0.12, 0.04, 0.06),
      footRYaw: 0.25,
      footRPitch: 0.3,
    },
    commit,
  );
  const settled = mirrorPose(GUARD);
  const dropped = make(
    {
      hip: v3(0.05, -0.1, 0.01),
      lowerYaw: 0.42,
      chestYaw: 0.62,
      chestPitch: 0.2,
      headYaw: -0.46,
      gripAt: v3(0.3, 0.74, -0.03),
      dir: dirYE(168, -19),
    },
    settled,
  );
  return [
    key(0, loaded),
    key(0.34, coil, easeInOut),
    key(1, commit, easeInCubic),
    key(1.5, front, linear),
    key(2, through, linear),
    key(2.3, carried, easeOutCubic),
    key(2.66, dropped, easeInOut),
    key(3, settled, easeOut),
  ];
}

function rising(c: number): Key[] {
  // Crouched over the blade, which lies low behind: the whole body is the spring.
  const loaded = make({
    hip: v3(0, -0.2 - 0.07 * c, -0.05),
    hipPitch: 0.16,
    lowerYaw: -0.42,
    chestYaw: -0.62 - 0.08 * c,
    chestPitch: 0.32 + 0.06 * c,
    headYaw: 0.52,
    headPitch: -0.28,
    gripAt: v3(-0.32, 0.6, -0.08),
    dir: dirYE(-166, -14),
    footL: v3(0.18, 0, 0.2),
    footLYaw: 0.45,
    footR: v3(-0.22, 0, -0.2),
    footRYaw: -0.3,
  });
  const coil = make(
    {
      hip: v3(-0.02, -0.36 - 0.05 * c, -0.09),
      hipPitch: 0.26,
      chestYaw: -0.84 - 0.08 * c,
      chestPitch: 0.42,
      headPitch: -0.36,
      gripAt: v3(-0.34, 0.5, -0.12),
      dir: dirYE(-173, -12),
    },
    loaded,
  );
  // Launch: the legs fire and the point scrapes forward along the floor.
  const scoop = make(
    {
      hip: v3(0, 0.02, 0.1),
      hipPitch: 0.06,
      lowerYaw: -0.15,
      chestYaw: -0.24,
      chestPitch: 0.18,
      headYaw: 0.2,
      headPitch: -0.2,
      gripAt: v3(-0.3, 0.72, 0.16),
      dir: dirYE(-62, -23),
      footL: v3(0.16, 0, 0.14),
      footLYaw: 0.2,
      footLPitch: 0.5,
      footR: v3(-0.18, 0, -0.14),
      footRYaw: -0.2,
      footRPitch: 0.6,
    },
    loaded,
  );
  const lift = make(
    {
      hip: v3(0, 0.05, 0.1),
      hipPitch: -0.04,
      lowerYaw: 0,
      chestYaw: 0.1,
      chestPitch: -0.04,
      headYaw: -0.05,
      headPitch: 0.16,
      gripAt: v3(-0.12, 0.98, 0.44),
      dir: dirYE(-6, 14),
      footL: v3(0.15, 0.05, 0.08),
      footLPitch: 0.7,
      footR: v3(-0.16, 0, -0.12),
      footRPitch: 0.75,
    },
    scoop,
  );
  // Fully extended at the top of the cut, one knee driving up.
  const top = make(
    {
      hip: v3(0, 0.07, 0.04),
      hipPitch: -0.12,
      lowerYaw: 0.12,
      chestYaw: 0.3,
      chestPitch: -0.3,
      headYaw: -0.2,
      headPitch: 0.3,
      gripAt: v3(0.04, 1.5, 0.3),
      dir: norm(v3(0.1, 0.97, -0.2)),
      footL: v3(0.16, 0.34, 0.2),
      footLPitch: 0.5,
      footR: v3(-0.15, 0, -0.16),
      footRPitch: 0.8,
    },
    scoop,
  );
  // The blade carries on over the far shoulder.
  const over = make(
    {
      hip: v3(0, 0.03, 0),
      hipPitch: -0.04,
      lowerYaw: 0.25,
      chestYaw: 0.5,
      chestPitch: -0.18,
      headYaw: -0.4,
      headPitch: 0.12,
      gripAt: v3(0.37, 1.38, 0.12),
      dir: norm(v3(0.2, 0.55, -0.82)),
      footL: v3(0.17, 0.26, 0.12),
      footLPitch: 0.3,
      footR: v3(-0.16, 0.12, -0.08),
      footRPitch: 0.5,
    },
    scoop,
  );
  const settled = mirrorPose(GUARD);
  const lower = make(
    {
      hip: v3(0, -0.04, 0),
      lowerYaw: 0.3,
      chestYaw: 0.46,
      chestPitch: 0.06,
      headYaw: -0.4,
      gripAt: v3(0.31, 0.92, 0),
      dir: dirYE(168, 6),
    },
    settled,
  );
  return [
    key(0, loaded),
    key(0.42, coil, easeInOut),
    key(1, scoop, easeInCubic),
    key(1.36, lift, linear),
    key(2, top, easeOut),
    key(2.36, over, easeOutCubic),
    key(2.74, lower, easeInOut),
    key(3, settled, easeOut),
  ];
}

function thrust(c: number): Key[] {
  // Chambered at the hip, weight on the back leg, shoulders turned away.
  const loaded = make({
    hip: v3(-0.02, -0.13 - 0.04 * c, -0.12 - 0.03 * c),
    hipPitch: 0.06,
    lowerYaw: -0.5,
    chestYaw: -0.72 - 0.1 * c,
    chestPitch: 0.16,
    headYaw: 0.68,
    headPitch: -0.04,
    gripAt: v3(-0.21, 0.86, 0.04),
    dir: dirYE(5, -2),
    footL: v3(0.16, 0, 0.26),
    footLYaw: 0.52,
    footR: v3(-0.22, 0, -0.24),
    footRYaw: -0.3,
  });
  const coil = make(
    {
      hip: v3(-0.04, -0.19 - 0.03 * c, -0.2),
      chestYaw: -0.94 - 0.06 * c,
      chestPitch: 0.2,
      headYaw: 0.86,
      gripAt: v3(-0.25, 0.84, -0.04),
      dir: dirYE(7, 0),
      footL: v3(0.16, 0.07, 0.28),
      footLPitch: -0.2,
    },
    loaded,
  );
  const launch = make(
    {
      hip: v3(0, -0.17, 0.12),
      hipPitch: 0.14,
      lowerYaw: -0.3,
      chestYaw: -0.32,
      chestPitch: 0.26,
      headYaw: 0.3,
      gripAt: v3(-0.16, 0.9, 0.34),
      dir: dirYE(2, -1),
      footL: v3(0.15, 0.09, 0.52),
      footLYaw: 0.3,
      footLPitch: -0.3,
      footR: v3(-0.2, 0, -0.22),
      footRPitch: 0.4,
    },
    loaded,
  );
  // Everything in one line behind the point: rear leg, hips, shoulder, blade.
  const extended = make(
    {
      hip: v3(0.02, -0.25, 0.32),
      hipPitch: 0.26,
      lowerYaw: 0.1,
      chestYaw: 0.46,
      chestPitch: 0.42,
      headYaw: -0.4,
      headPitch: -0.22,
      gripAt: v3(-0.05, 0.92, 0.88),
      dir: dirYE(0, -1),
      footL: v3(0.15, 0, 0.76),
      footLYaw: -0.05,
      footR: v3(-0.18, 0, -0.2),
      footRYaw: -0.4,
      footRPitch: 0.7,
    },
    loaded,
  );
  const overreach = make(
    {
      hip: v3(0.02, -0.28, 0.36),
      chestPitch: 0.48,
      gripAt: v3(-0.05, 0.9, 0.92),
    },
    extended,
  );
  const retract = make(
    {
      hip: v3(0, -0.2, 0.22),
      hipPitch: 0.16,
      lowerYaw: -0.05,
      chestYaw: 0.18,
      chestPitch: 0.34,
      headYaw: -0.15,
      gripAt: v3(-0.12, 0.88, 0.58),
      dir: dirYE(-8, -4),
      footL: v3(0.15, 0, 0.6),
      footR: v3(-0.18, 0, -0.2),
      footRPitch: 0.4,
    },
    extended,
  );
  const drag = make(
    {
      hip: v3(0, -0.1, 0.08),
      hipPitch: 0.08,
      lowerYaw: -0.24,
      chestYaw: -0.26,
      chestPitch: 0.24,
      headYaw: 0.22,
      gripAt: v3(-0.3, 0.72, 0.1),
      dir: dirYE(-96, -19),
      footL: v3(0.17, 0, 0.36),
      footLYaw: 0.3,
      footR: v3(-0.2, 0, -0.2),
      footRYaw: -0.32,
    },
    GUARD,
  );
  return [
    key(0, loaded),
    key(0.44, coil, easeInOut),
    key(1, launch, easeInCubic),
    key(1.42, extended, easeOut),
    key(2, overreach, easeOut),
    key(2.3, retract, easeInOut),
    key(2.72, drag, easeInOut),
    key(3, GUARD, easeOut),
  ];
}

const TIMELINES: Record<AttackId, (charge: number) => Key[]> = {
  overhead,
  sweep,
  rising,
  thrust,
};

/** Attacks that finish with the sword on the other side of the body. */
export const CROSSES_BODY: Record<AttackId, boolean> = {
  overhead: false,
  sweep: true,
  rising: true,
  thrust: false,
};

/** Timeline position where the overhead's point reaches the floor. */
export const OVERHEAD_IMPACT = 1.62;

export function attackPose(attack: AttackId, at: number, charge: number): Pose {
  const keys = TIMELINES[attack](charge);
  if (at <= keys[0]!.at) return keys[0]!.pose;
  for (let i = 1; i < keys.length; i++) {
    const next = keys[i]!;
    if (at > next.at) continue;
    const previous = keys[i - 1]!;
    const local = (at - previous.at) / Math.max(1e-6, next.at - previous.at);
    return blendPose(previous.pose, next.pose, next.ease(local));
  }
  return keys[keys.length - 1]!.pose;
}

// --- One-off actions ------------------------------------------------------------------------

/** The blade thrown back off a parry, the body jarred onto its heels. */
export const CLASH = make({
  hip: v3(0, -0.1, -0.16),
  hipPitch: -0.12,
  lowerYaw: -0.2,
  chestYaw: -0.3,
  chestPitch: -0.38,
  headYaw: 0.2,
  headPitch: 0.26,
  gripAt: v3(-0.36, 1.2, -0.04),
  dir: dirYE(-150, 56),
  footL: v3(0.18, 0, 0.26),
  footLYaw: 0.3,
  footLPitch: -0.35,
  footR: v3(-0.22, 0, -0.26),
  footRYaw: -0.3,
});

const GRAB_READY = make(
  {
    hip: v3(0, -0.1, -0.04),
    chestYaw: -0.2,
    chestPitch: 0.2,
    headYaw: 0.16,
    gripAt: v3(-0.36, 0.72, -0.1),
    offFree: 1,
    offHand: v3(0.06, -0.12, 0.3),
  },
  GUARD,
);
const GRAB_REACH = make(
  {
    hip: v3(0.03, -0.17, 0.24),
    hipPitch: 0.2,
    lowerYaw: -0.1,
    chestYaw: 0.52,
    chestPitch: 0.4,
    headYaw: -0.44,
    headPitch: -0.2,
    gripAt: v3(-0.4, 0.74, -0.02),
    dir: dirYE(-170, -19),
    offFree: 1,
    offHand: v3(-0.14, -0.06, 0.62),
    footL: v3(0.16, 0, 0.56),
    footLYaw: 0.05,
    footR: v3(-0.2, 0, -0.2),
    footRYaw: -0.4,
    footRPitch: 0.5,
  },
  GUARD,
);
const GRAB_STUMBLE = make(
  {
    hip: v3(0.03, -0.24, 0.32),
    hipPitch: 0.3,
    chestPitch: 0.62,
    headPitch: -0.1,
    offHand: v3(-0.1, -0.34, 0.5),
    footR: v3(-0.18, 0.04, 0.02),
    footRPitch: 0.3,
  },
  GRAB_REACH,
);

export function grabPose(progress: number): Pose {
  if (progress < 0.35) return blendPose(GUARD, GRAB_READY, easeOut(progress / 0.35));
  return blendPose(GRAB_READY, GRAB_REACH, easeIn((progress - 0.35) / 0.65));
}
export function grabWhiffPose(progress: number): Pose {
  if (progress < 0.22) return blendPose(GRAB_REACH, GRAB_STUMBLE, easeOutCubic(progress / 0.22));
  if (progress < 0.5) return GRAB_STUMBLE;
  return blendPose(GRAB_STUMBLE, GUARD, easeInOut((progress - 0.5) / 0.5));
}

/** Holding someone at arm's length, winding up against the direction of the throw. */
export function holdPose(progress: number, throwYaw: number): Pose {
  const wind = easeInOut(progress) * 0.45 * Math.sign(throwYaw || 1);
  return make(
    {
      hip: v3(0, -0.13, -0.08),
      hipPitch: -0.06,
      lowerYaw: -0.1,
      chestYaw: 0.42 - wind,
      chestPitch: -0.1,
      headYaw: -0.36,
      gripAt: v3(-0.4, 0.74, -0.08),
      offFree: 1,
      offHand: v3(-0.12, 0.02, 0.6),
      footL: v3(0.18, 0, 0.3),
      footLYaw: 0.2,
      footR: v3(-0.22, 0, -0.24),
      footRYaw: -0.4,
    },
    GUARD,
  );
}
/** The heave itself and the follow-through; `direction` is the throw in body space. */
export function throwPose(progress: number, direction: V3): Pose {
  const yaw = Math.atan2(direction.x, direction.z);
  const swing = Math.max(-1.4, Math.min(1.4, yaw));
  const heave = make(
    {
      hip: v3(direction.x * 0.14, -0.16, direction.z * 0.14),
      hipPitch: 0.1,
      lowerYaw: swing * 0.35,
      chestYaw: 0.3 + swing * 0.7,
      chestPitch: 0.3,
      headYaw: -0.2 - swing * 0.3,
      gripAt: v3(-0.4, 0.76, -0.1),
      offFree: 1,
      offHand: v3(direction.x * 0.6 - 0.1, 0.08, direction.z * 0.6),
      footL: v3(0.18 + direction.x * 0.2, 0, 0.2 + direction.z * 0.2),
      footR: v3(-0.22, 0, -0.22),
      footRPitch: 0.4,
    },
    GUARD,
  );
  if (progress < 0.3) return blendPose(holdPose(1, yaw), heave, easeOutBack(progress / 0.3));
  if (progress < 0.5) return heave;
  return blendPose(heave, GUARD, easeInOut((progress - 0.5) / 0.5));
}

/** Dangling from someone's fist. */
export const HELD = make(
  {
    hip: v3(0, 0.02, -0.04),
    hipPitch: -0.2,
    lowerYaw: 0,
    chestYaw: 0,
    chestPitch: -0.3,
    headYaw: 0,
    headPitch: 0.34,
    gripAt: v3(-0.44, 0.8, -0.05),
    dir: norm(v3(-0.3, -0.9, -0.3)),
    offFree: 1,
    offHand: v3(0.3, 0.12, 0.16),
    footL: v3(0.16, 0.1, 0.16),
    footLPitch: 0.7,
    footR: v3(-0.16, 0.06, -0.06),
    footRPitch: 0.8,
  },
  GUARD,
);

/** Airborne legs and trunk; `rise` is +1 on the way up, -1 falling. */
export function airPose(base: Pose, rise: number): Pose {
  const up = Math.max(0, rise),
    down = Math.max(0, -rise);
  return make(
    {
      hip: v3(base.hip.x, 0.02 + up * 0.04, base.hip.z),
      hipPitch: base.hipPitch + down * 0.1 - up * 0.06,
      chestPitch: base.chestPitch + up * 0.1 - down * 0.12,
      headPitch: base.headPitch - up * 0.1 + down * 0.16,
      // Pushed long at take-off, tucked at the top, reaching for the floor on the way down.
      footL: v3(0.16, 0.26 - up * 0.2 - down * 0.14, 0.14 + down * 0.08),
      footLYaw: 0.2,
      footLPitch: 0.25 + up * 0.5,
      footR: v3(-0.17, 0.12 - up * 0.1 - down * 0.06, -0.12 - up * 0.06),
      footRYaw: -0.2,
      footRPitch: 0.45 + up * 0.4,
    },
    base,
  );
}
