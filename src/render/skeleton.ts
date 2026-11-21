import {
  add,
  clamp,
  clamp01,
  cross,
  dot,
  len,
  lerp,
  lerpV,
  mul,
  norm,
  qEuler,
  qFromBasis,
  qLook,
  qNlerp,
  qRotate,
  reject,
  slerpDir,
  sub,
  twoBone,
  v3,
} from "./math3";
import type { Quat, V3 } from "./math3";

/**
 * Body space: origin at the fighter's feet, +Y up, +Z the way the fighter faces, +X the
 * fighter's LEFT (right-handed, like the scene). All lengths are world units.
 */
export const BODY = {
  /** Pelvis height when standing at ease (legs slightly bent). */
  hipRest: 0.69,
  hipHalfWidth: 0.16,
  thigh: 0.33,
  shin: 0.33,
  /** Height of the ankle joint above the sole. */
  ankle: 0.07,
  /** Pelvis to chest pivot; the spine bends half way. */
  spine: 0.28,
  /** Chest pivot to the base of the neck. */
  neck: 0.25,
  shoulderX: 0.29,
  shoulderY: 0.17,
  upperArm: 0.35,
  foreArm: 0.33,
  /** Centre of mass, the pivot of a tumbling knock-back. */
  pivot: 0.95,
  /** Hilt offsets from the grip centre along the blade axis. */
  gripLead: 0.15,
  gripRear: -0.13,
  bladeBase: 0.34,
  bladeTip: 2.06,
} as const;

/** Everything the animation authors; the solver turns it into joint transforms. */
export interface Pose {
  /** Pelvis offset from its rest position. */
  hip: V3;
  hipPitch: number;
  hipRoll: number;
  /** Yaw of the pelvis and feet relative to the facing direction. */
  lowerYaw: number;
  /** Chest orientation in body space (not relative to the pelvis). */
  chestYaw: number;
  chestPitch: number;
  chestRoll: number;
  /** Head orientation relative to the chest. */
  headYaw: number;
  headPitch: number;
  headRoll: number;
  /** Grip centre relative to the base of the neck, in body axes. */
  grip: V3;
  /** Unit blade direction in body space. */
  dir: V3;
  /** Sole positions; y is the height above the fighter's ground level. */
  footL: V3;
  footR: V3;
  footLYaw: number;
  footRYaw: number;
  footLPitch: number;
  footRPitch: number;
  /** +1: right hand next to the guard (sword carried on the right). -1: mirrored. */
  side: number;
  /** How far the pommel hand has let go, and where it goes relative to its own shoulder. */
  offFree: number;
  offHand: V3;
  /** Vertical squash (positive) or stretch (negative) of the whole body. */
  squash: number;
  /** Whole-body rotation vector (axis × angle) about the centre of mass. */
  tumble: V3;
}

export function clonePose(p: Pose): Pose {
  return {
    ...p,
    hip: { ...p.hip },
    grip: { ...p.grip },
    dir: { ...p.dir },
    footL: { ...p.footL },
    footR: { ...p.footR },
    offHand: { ...p.offHand },
    tumble: { ...p.tumble },
  };
}

export function blendPose(a: Pose, b: Pose, t: number): Pose {
  if (t <= 0) return clonePose(a);
  if (t >= 1) return clonePose(b);
  return {
    hip: lerpV(a.hip, b.hip, t),
    hipPitch: lerp(a.hipPitch, b.hipPitch, t),
    hipRoll: lerp(a.hipRoll, b.hipRoll, t),
    lowerYaw: lerp(a.lowerYaw, b.lowerYaw, t),
    chestYaw: lerp(a.chestYaw, b.chestYaw, t),
    chestPitch: lerp(a.chestPitch, b.chestPitch, t),
    chestRoll: lerp(a.chestRoll, b.chestRoll, t),
    headYaw: lerp(a.headYaw, b.headYaw, t),
    headPitch: lerp(a.headPitch, b.headPitch, t),
    headRoll: lerp(a.headRoll, b.headRoll, t),
    grip: lerpV(a.grip, b.grip, t),
    dir: slerpDir(a.dir, b.dir, t),
    footL: lerpV(a.footL, b.footL, t),
    footR: lerpV(a.footR, b.footR, t),
    footLYaw: lerp(a.footLYaw, b.footLYaw, t),
    footRYaw: lerp(a.footRYaw, b.footRYaw, t),
    footLPitch: lerp(a.footLPitch, b.footLPitch, t),
    footRPitch: lerp(a.footRPitch, b.footRPitch, t),
    side: lerp(a.side, b.side, t),
    offFree: lerp(a.offFree, b.offFree, t),
    offHand: lerpV(a.offHand, b.offHand, t),
    squash: lerp(a.squash, b.squash, t),
    tumble: lerpV(a.tumble, b.tumble, t),
  };
}

/** Left/right reflection: the same motion with the sword on the other side. */
export function mirrorPose(p: Pose): Pose {
  const flip = (v: V3): V3 => ({ x: -v.x, y: v.y, z: v.z });
  return {
    hip: flip(p.hip),
    hipPitch: p.hipPitch,
    hipRoll: -p.hipRoll,
    lowerYaw: -p.lowerYaw,
    chestYaw: -p.chestYaw,
    chestPitch: p.chestPitch,
    chestRoll: -p.chestRoll,
    headYaw: -p.headYaw,
    headPitch: p.headPitch,
    headRoll: -p.headRoll,
    grip: flip(p.grip),
    dir: flip(p.dir),
    footL: flip(p.footR),
    footR: flip(p.footL),
    footLYaw: -p.footRYaw,
    footRYaw: -p.footLYaw,
    footLPitch: p.footRPitch,
    footRPitch: p.footLPitch,
    side: -p.side,
    offFree: p.offFree,
    offHand: flip(p.offHand),
    squash: p.squash,
    // A rotation vector is a pseudovector: mirroring X keeps its X and flips the rest.
    tumble: { x: p.tumble.x, y: -p.tumble.y, z: -p.tumble.z },
  };
}

/** Base of the neck for a pose, before the solver lowers the hips for a wide stance. */
export function neckBase(pose: Pose): V3 {
  const half = BODY.spine / 2;
  const pelvisQ = qEuler(pose.lowerYaw, pose.hipPitch, pose.hipRoll);
  const chestQ = qEuler(pose.chestYaw, pose.chestPitch, pose.chestRoll);
  return add(
    add(
      add(v3(pose.hip.x, BODY.hipRest + pose.hip.y, pose.hip.z), qRotate(pelvisQ, v3(0, half, 0))),
      qRotate(chestQ, v3(0, half, 0)),
    ),
    qRotate(chestQ, v3(0, BODY.neck, 0)),
  );
}

export interface Joint {
  p: V3;
  q: Quat;
}
export interface Limb {
  upper: Joint;
  lower: Joint;
  end: Joint;
}
export interface Skeleton {
  pelvis: Joint;
  belly: Joint;
  chest: Joint;
  head: Joint;
  sword: Joint;
  /** Index 0 is the fighter's left (+X), 1 the right. */
  arms: [Limb, Limb];
  legs: [Limb, Limb];
  bladeBase: V3;
  bladeTip: V3;
  /** True when the blade was held up by the floor this frame. */
  tipOnGround: boolean;
  squash: number;
  tumble: V3;
}

export interface SolveOptions {
  /** Floor height in body space, or null when there is nothing under the fighter. */
  ground: number | null;
  /** Blade flat normal to aim for (body space); the solver keeps it perpendicular to the blade. */
  flat: V3;
}

/** A limb segment hangs along its local -Y; its local +Z faces the bend direction. */
function segment(from: V3, to: V3, bend: V3): Quat {
  const down = norm(sub(to, from), { x: 0, y: -1, z: 0 });
  const y = mul(down, -1);
  const z = reject(bend, y, { x: 0, y: 0, z: 1 });
  return qFromBasis(cross(y, z), y, z);
}

function solveLimb(root: V3, target: V3, l1: number, l2: number, pole: V3, endQ: Quat): Limb {
  const { mid, end } = twoBone(root, target, l1, l2, pole);
  const bend = norm(sub(mid, lerpV(root, end, 0.5)), pole);
  return {
    upper: { p: root, q: segment(root, mid, bend) },
    lower: { p: mid, q: segment(mid, end, bend) },
    end: { p: end, q: endQ },
  };
}

/** Forward kinematics for the trunk, IK for the limbs, and the sword's floor contact. */
export function solve(pose: Pose, options: SolveOptions): Skeleton {
  const lead = clamp01((pose.side + 1) / 2);
  const legReach = (BODY.thigh + BODY.shin) * 0.985;
  const pelvisQ = qEuler(pose.lowerYaw, pose.hipPitch, pose.hipRoll);
  const hipOffset: [V3, V3] = [
    qRotate(pelvisQ, v3(BODY.hipHalfWidth, 0, 0)),
    qRotate(pelvisQ, v3(-BODY.hipHalfWidth, 0, 0)),
  ];
  const ankles: [V3, V3] = [
    v3(pose.footL.x, pose.footL.y + BODY.ankle, pose.footL.z),
    v3(pose.footR.x, pose.footR.y + BODY.ankle, pose.footR.z),
  ];
  let pelvisP = v3(pose.hip.x, BODY.hipRest + pose.hip.y, pose.hip.z);
  // A wide stance lowers the hips instead of stretching the legs.
  for (let i = 0; i < 2; i++) {
    const foot = i === 0 ? pose.footL : pose.footR;
    if (foot.y > 0.02) continue;
    const hip = add(pelvisP, hipOffset[i]!);
    const horizontal = Math.hypot(ankles[i]!.x - hip.x, ankles[i]!.z - hip.z);
    const allowed =
      ankles[i]!.y + Math.sqrt(Math.max(0.02, legReach * legReach - horizontal * horizontal));
    if (hip.y > allowed) pelvisP = v3(pelvisP.x, pelvisP.y - (hip.y - allowed), pelvisP.z);
  }

  const chestQ = qEuler(pose.chestYaw, pose.chestPitch, pose.chestRoll);
  const half = BODY.spine / 2;
  const chestP = add(
    add(pelvisP, qRotate(pelvisQ, v3(0, half, 0))),
    qRotate(chestQ, v3(0, half, 0)),
  );
  const bellyQ = qNlerp(pelvisQ, chestQ, 0.5);
  const bellyP = add(pelvisP, qRotate(pelvisQ, v3(0, half, 0)));
  const neckP = add(chestP, qRotate(chestQ, v3(0, BODY.neck, 0)));
  // The head only follows part of the chest's lean, so the eyes stay on the opponent.
  const headQ = qEuler(
    pose.chestYaw + pose.headYaw,
    pose.chestPitch * 0.35 + pose.headPitch,
    pose.chestRoll * 0.5 + pose.headRoll,
  );
  const shoulders: [V3, V3] = [
    add(chestP, qRotate(chestQ, v3(BODY.shoulderX, BODY.shoulderY, 0))),
    add(chestP, qRotate(chestQ, v3(-BODY.shoulderX, BODY.shoulderY, 0))),
  ];

  // --- Sword ---------------------------------------------------------------------------
  let dir = norm(pose.dir, { x: 0, y: 0, z: -1 });
  let grip = add(neckP, pose.grip);
  const armReach = (BODY.upperArm + BODY.foreArm) * 0.985;
  // The hand next to the guard keeps its hold: pull the whole sword in if it cannot reach.
  const leadIndex = lead >= 0.5 ? 1 : 0;
  const leadOffset = lerp(BODY.gripRear, BODY.gripLead, leadIndex === 1 ? lead : 1 - lead);
  const leadTarget = add(grip, mul(dir, leadOffset));
  const overreach = len(sub(leadTarget, shoulders[leadIndex]!)) - armReach;
  if (overreach > 0) {
    const pull = norm(sub(shoulders[leadIndex]!, leadTarget));
    grip = add(grip, mul(pull, overreach));
  }
  let tipOnGround = false;
  if (options.ground !== null) {
    const floor = options.ground + 0.025;
    const minimum = (floor - grip.y) / BODY.bladeTip;
    if (dir.y < minimum && minimum < 0.98) {
      const flatLength = Math.hypot(dir.x, dir.z);
      const scale = flatLength > 1e-4 ? Math.sqrt(1 - minimum * minimum) / flatLength : 0;
      dir = norm(v3(dir.x * scale, minimum, dir.z * scale), { x: 0, y: 0, z: 1 });
      tipOnGround = true;
    }
  }
  const swordQ = qLook(dir, options.flat, { x: 1, y: 0, z: 0 });
  const handTargets: [V3, V3] = [
    add(grip, mul(dir, lerp(BODY.gripLead, BODY.gripRear, lead))),
    add(grip, mul(dir, lerp(BODY.gripRear, BODY.gripLead, lead))),
  ];
  // The pommel hand may let go (grabs, knock-backs, carrying the sword on a shoulder).
  const offIndex = lead >= 0.5 ? 0 : 1;
  if (pose.offFree > 0) {
    const free = add(shoulders[offIndex]!, qRotate(qEuler(pose.chestYaw, 0, 0), pose.offHand));
    handTargets[offIndex] = lerpV(handTargets[offIndex]!, free, clamp01(pose.offFree));
  }
  const yawQ = qEuler(pose.chestYaw, 0, 0);
  const arms = [0, 1].map((i) => {
    const out = i === 0 ? 1 : -1;
    const pole = qRotate(yawQ, v3(out * 0.75, -0.55, -0.45));
    const free = i === offIndex ? clamp01(pose.offFree) : 0;
    // A free hand relaxes; a gripping hand follows the hilt.
    const handQ = qNlerp(swordQ, chestQ, free);
    return solveLimb(shoulders[i]!, handTargets[i]!, BODY.upperArm, BODY.foreArm, pole, handQ);
  }) as [Limb, Limb];

  // --- Legs ----------------------------------------------------------------------------
  const legs = [0, 1].map((i) => {
    const out = i === 0 ? 1 : -1;
    const footYaw = pose.lowerYaw + (i === 0 ? pose.footLYaw : pose.footRYaw);
    const footPitch = i === 0 ? pose.footLPitch : pose.footRPitch;
    const pole = qRotate(qEuler(footYaw, 0, 0), v3(out * 0.18, 0.1, 1));
    const hip = add(pelvisP, hipOffset[i]!);
    return solveLimb(hip, ankles[i]!, BODY.thigh, BODY.shin, pole, qEuler(footYaw, footPitch, 0));
  }) as [Limb, Limb];

  return {
    pelvis: { p: pelvisP, q: pelvisQ },
    belly: { p: bellyP, q: bellyQ },
    chest: { p: chestP, q: chestQ },
    head: { p: neckP, q: headQ },
    sword: { p: grip, q: swordQ },
    arms,
    legs,
    bladeBase: add(grip, mul(dir, BODY.bladeBase)),
    bladeTip: add(grip, mul(dir, BODY.bladeTip)),
    tipOnGround,
    squash: clamp(pose.squash, -0.35, 0.4),
    tumble: pose.tumble,
  };
}

/** Body-space point after the whole-body tumble (used for trails and contact effects). */
export function tumbled(point: V3, tumble: V3): V3 {
  const angle = len(tumble);
  if (angle < 1e-4) return point;
  const axis = mul(tumble, 1 / angle);
  const pivot = v3(0, BODY.pivot, 0);
  const local = sub(point, pivot);
  // Rodrigues' rotation formula.
  const c = Math.cos(angle),
    s = Math.sin(angle);
  const rotated = add(
    add(mul(local, c), mul(cross(axis, local), s)),
    mul(axis, dot(axis, local) * (1 - c)),
  );
  return add(pivot, rotated);
}
