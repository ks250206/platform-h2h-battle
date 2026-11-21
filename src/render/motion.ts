import { ATTACKS, RULES } from "../game/tuning";
import type { AttackId, Fighter, FighterMode } from "../game/types";
import {
  add,
  clamp,
  clamp01,
  cross,
  dot,
  easeInOut,
  easeOut,
  len,
  lerp,
  lerpV,
  mul,
  norm,
  qAxis,
  qRotate,
  reject,
  Spring,
  sub,
  TAU,
  v3,
  wrapAngle,
} from "./math3";
import type { V3 } from "./math3";
import {
  airPose,
  attackPose,
  CLASH,
  CROSSES_BODY,
  grabPose,
  grabWhiffPose,
  GUARD,
  HELD,
  holdPose,
  OVERHEAD_IMPACT,
  SHOULDER,
  throwPose,
} from "./poses";
import { blendPose, clonePose, mirrorPose, solve, tumbled } from "./skeleton";
import type { Pose, Skeleton } from "./skeleton";

export interface MotionContext {
  /** Whether there is floor under the fighter (blade and feet rest on it). */
  floor: boolean;
  /** Off-duty stance: title screen, pre-fight, victory. */
  atEase: boolean;
}

export type MotionEventKind = "slam" | "stomp" | "scrape" | "land" | "skid";
export interface MotionEvent {
  kind: MotionEventKind;
  /** World position. */
  x: number;
  y: number;
  z: number;
  /** 0-1, already scaled by charge / speed. */
  power: number;
}

export interface MotionFrame {
  skeleton: Skeleton;
  /** World-space root position including hit vibration. */
  origin: V3;
  facing: number;
  /** World-space blade ends, for the trail and contact effects. */
  bladeBase: V3;
  bladeTip: V3;
  /** 0 when the blade is at rest, 1 through the cutting part of a swing. */
  trail: number;
  /** Yaw / pitch of each tail segment relative to the previous one. */
  tail: { yaw: number; pitch: number }[];
  /** Backward flop of the ears and the scarf ends. */
  ears: number;
  scarf: { yaw: number; pitch: number };
  events: MotionEvent[];
}

const TAIL_SEGMENTS = 3;
const RUN_SPEED = RULES.moveSpeed;

/** How long a change of action takes to take over from the previous pose. */
function blendTime(from: FighterMode, to: FighterMode): number {
  switch (to) {
    case "charge":
      return 0.2;
    case "windup":
      return from === "charge" ? 0.06 : 0.14;
    case "active":
    case "recovery":
      return from === "throw" || from === "grab" ? 0.05 : 0;
    case "hitstun":
      return 0.05;
    case "clash":
      return 0.05;
    case "step":
      return 0.07;
    case "cancel":
      return 0.1;
    case "grab":
      return 0.06;
    case "throw":
      return 0.1;
    case "grabbed":
      return 0.1;
    case "idle":
      return from === "step" ? 0.2 : from === "hitstun" ? 0.26 : from === "cancel" ? 0.14 : 0.12;
    default:
      return 0.1;
  }
}

/**
 * Turns the simulation's sparse fighter state into a full-body pose every rendered frame.
 * Purely presentational: it reads the fighter and never writes to it.
 */
export class FighterMotion {
  /** Which side the sword is carried on: +1 right, -1 left. Sweeps and risers swap it. */
  private side = 1;
  private clock = 0;
  /** Wall time that keeps running through hit-stop (the hit vibration needs it). */
  private wall = 0;
  private initialised = false;
  private lastX = 0;
  private lastY = 0;
  private lastZ = 0;
  private lastFacing = 0;
  /** Smoothed horizontal velocity in body space. */
  private velocity = v3();
  private travel = v3(0, 0, 1);
  private speed = 0;
  private gait = 0;
  private lowerYaw = 0;
  private airborne = 0;
  private atEase = 0;
  private previousMode: FighterMode = "idle";
  private previousAttack: AttackId | null = null;
  /** What the current `recovery` is recovering from. */
  private recovering: "attack" | "grab" | "throw" = "attack";
  private from: Pose = clonePose(GUARD);
  private blend = 1;
  private blendDuration = 0.1;
  private base: Pose = clonePose(GUARD);
  private wasGrounded = true;
  private fallSpeed = 0;
  private wasOnGround = false;
  private previousAt = 0;
  private scrapeCooldown = 0;
  private stride = [false, false];
  private tumbleAngle = 0;
  private tumbleAxis = v3(1, 0, 0);
  private knock = v3(0, 0, -1);
  private flat = v3(1, 0, 0);
  private previousDir: V3 | null = null;
  private readonly turn = new Spring(10, 0.7);
  private readonly leanX = new Spring(13, 0.6);
  private readonly leanZ = new Spring(13, 0.6);
  private readonly bounce = new Spring(19, 0.38);
  private readonly swordYaw = new Spring(11, 0.5);
  private readonly swordPitch = new Spring(12, 0.45);
  private readonly earSpring = new Spring(15, 0.3);
  private readonly tailYaw = [new Spring(9, 0.42), new Spring(7.5, 0.4), new Spring(6.5, 0.38)];
  private readonly tailPitch = new Spring(8, 0.45);
  private readonly scarfYaw = new Spring(10, 0.35);
  private readonly scarfPitch = new Spring(9, 0.4);

  /** Sword side, exposed for tests and tooling. */
  get swordSide(): number {
    return this.side;
  }

  update(f: Fighter, dt: number, context: MotionContext): MotionFrame {
    const events: MotionEvent[] = [];
    if (!this.initialised) {
      this.initialised = true;
      this.lastX = f.x;
      this.lastY = f.y;
      this.lastZ = f.z;
      this.lastFacing = f.facing;
      this.previousMode = f.mode;
      this.previousAttack = f.attack;
      this.wasGrounded = f.grounded;
      this.atEase = context.atEase ? 1 : 0;
    }
    // Hit-stop freezes the pose exactly as the simulation freezes the fighter.
    const frozen = f.hitstop > 0;
    const step = frozen ? 0 : dt;
    this.clock += step;
    this.wall += dt;
    const cosF = Math.cos(f.facing),
      sinF = Math.sin(f.facing);
    const toBody = (x: number, z: number): V3 => v3(x * cosF - z * sinF, 0, x * sinF + z * cosF);

    // --- Movement, derived from rendered positions (walking is positional in the sim) ----
    let yawRate = 0;
    let vertical = 0;
    if (step > 0) {
      const dx = f.x - this.lastX,
        dz = f.z - this.lastZ;
      const teleported = Math.hypot(dx, dz) > 3;
      const raw = teleported ? v3() : toBody(dx / step, dz / step);
      const previous = this.velocity;
      this.velocity = lerpV(previous, raw, 1 - Math.exp(-step * 14));
      const acceleration = mul(sub(this.velocity, previous), 1 / step);
      vertical = teleported ? 0 : (f.y - this.lastY) / step;
      yawRate = wrapAngle(f.facing - this.lastFacing) / step;
      // Lean into acceleration and against braking; the trunk has to catch up with the feet.
      this.leanX.step(clamp(acceleration.x * 0.012, -0.34, 0.34), step);
      this.leanZ.step(clamp(acceleration.z * 0.012, -0.34, 0.34), step);
      this.lastX = f.x;
      this.lastY = f.y;
      this.lastZ = f.z;
      this.lastFacing = f.facing;
    }
    this.speed = Math.hypot(this.velocity.x, this.velocity.z);
    if (this.speed > 0.25) {
      this.travel = norm(
        lerpV(this.travel, mul(this.velocity, 1 / this.speed), 1 - Math.exp(-step * 16)),
        this.travel,
      );
    }

    // --- Action changes ------------------------------------------------------------------
    if (f.mode !== this.previousMode || (f.attack !== this.previousAttack && f.attack)) {
      if (f.mode === "recovery") {
        this.recovering =
          this.previousMode === "throw"
            ? "throw"
            : this.previousMode === "grab"
              ? "grab"
              : "attack";
      }
      // The sword has crossed the body once its swing is under way; from there it settles
      // on the far side, so every later pose is authored mirrored.
      const finishedCrossing =
        this.previousAttack !== null &&
        CROSSES_BODY[this.previousAttack] &&
        this.previousMode === "recovery" &&
        this.recovering === "attack" &&
        f.mode !== "recovery";
      const interruptedCrossing =
        this.previousAttack !== null &&
        CROSSES_BODY[this.previousAttack] &&
        this.previousMode === "active" &&
        f.mode !== "recovery" &&
        this.previousAt > 1.5;
      if (finishedCrossing || interruptedCrossing) this.side = -this.side;
      let duration = blendTime(this.previousMode, f.mode);
      // A tapped attack commits before the sword has even left the guard: it still has to be
      // heaved up, and that takes a good part of the wind-up.
      if (f.mode === "windup" && this.previousMode === "charge" && this.blend < 1 && f.attack)
        duration = Math.min(0.26, ATTACKS[f.attack].startup * 0.55);
      // Stopping a swing takes as long as the simulation says it does: a blade arrested late in
      // its wind-up is lowered slowly, not snapped back.
      if (f.mode === "cancel") duration = clamp(f.modeDuration, 0.1, 0.34);
      this.from = clonePose(this.base);
      this.blend = duration > 0 ? 0 : 1;
      this.blendDuration = duration;
      if (f.mode === "hitstun") this.beginKnock(f, toBody);
      if (f.mode === "active" && f.attack && f.attack !== "rising" && f.grounded)
        events.push(this.event("stomp", f, v3(0, 0, 0.45), 0.4 + f.charge * 0.4));
      this.previousMode = f.mode;
      this.previousAttack = f.attack;
    }
    if (this.blend < 1 && this.blendDuration > 0)
      this.blend = Math.min(1, this.blend + step / this.blendDuration);

    const easeTarget = context.atEase ? 1 : 0;
    this.atEase += (easeTarget - this.atEase) * (1 - Math.exp(-step * (context.atEase ? 4 : 6.5)));
    this.airborne += ((f.grounded ? 0 : 1) - this.airborne) * (1 - Math.exp(-step * 16));

    // --- Authored pose for the current action -------------------------------------------
    const target = this.authored(f, toBody);
    this.base =
      this.blend < 1 ? blendPose(this.from, target.pose, easeOut(this.blend)) : target.pose;
    const pose = clonePose(this.base);

    // --- Layers on top: locomotion, air, secondary motion --------------------------------
    this.locomotion(pose, f, step, target.planted, events);
    // Turning starts at the shoulders: the hips and feet are left behind for a moment, then
    // shuffle round to catch up.
    const lag = this.turn.step(clamp(-yawRate * 0.055, -0.75, 0.75), step) * target.planted;
    if (f.grounded && Math.abs(lag) > 0.002) {
      const c = Math.cos(lag),
        s = Math.sin(lag);
      pose.footL = v3(
        pose.footL.x * c + pose.footL.z * s,
        pose.footL.y,
        pose.footL.z * c - pose.footL.x * s,
      );
      pose.footR = v3(
        pose.footR.x * c + pose.footR.z * s,
        pose.footR.y,
        pose.footR.z * c - pose.footR.x * s,
      );
      pose.lowerYaw += lag;
      pose.chestYaw += lag * 0.3;
      pose.headYaw -= lag * 0.2;
    }
    if (this.airborne > 0.01 && target.legs > 0) {
      const rise = clamp(f.vy / 7, -1, 1);
      const air = airPose(pose, rise);
      const weight = this.airborne * target.legs;
      pose.footL = lerpV(pose.footL, air.footL, weight);
      pose.footR = lerpV(pose.footR, air.footR, weight);
      pose.footLPitch = lerp(pose.footLPitch, air.footLPitch, weight);
      pose.footRPitch = lerp(pose.footRPitch, air.footRPitch, weight);
      pose.hip = lerpV(pose.hip, air.hip, weight * 0.7);
      pose.chestPitch = lerp(pose.chestPitch, air.chestPitch, weight * target.carry);
      pose.headPitch = lerp(pose.headPitch, air.headPitch, weight * target.carry);
    }

    // Landing: the knees take the weight, then push back up.
    if (f.grounded && !this.wasGrounded) {
      const impact = clamp01(this.fallSpeed / 13);
      this.bounce.kick(1.5 + impact * 5.5);
      events.push(this.event("land", f, v3(), 0.25 + impact * 0.75));
    }
    if (!f.grounded) this.fallSpeed = Math.max(0, -f.vy);
    this.wasGrounded = f.grounded;
    const settle = this.bounce.step(0, step);
    pose.hip.y -= clamp(settle, -0.3, 0.6) * 0.2;
    pose.squash += clamp(settle, -0.5, 0.8) * 0.16;
    pose.chestPitch += clamp(settle, -0.4, 0.8) * 0.12;
    // Stretch along a fast vertical launch.
    if (!f.grounded) pose.squash -= clamp(Math.abs(f.vy) / 60, 0, 0.14);

    pose.chestPitch += this.leanZ.value;
    pose.chestRoll -= this.leanX.value;
    pose.hipPitch += this.leanZ.value * 0.35;
    pose.hip.x += this.leanX.value * 0.12;
    pose.hip.z += this.leanZ.value * 0.12;

    // The blade is heavy: it trails any turn or lift of the body carrying it.
    const lagYaw = this.swordYaw.step(clamp(-yawRate * 0.045, -0.75, 0.75), step);
    const lagPitch = this.swordPitch.step(clamp(-vertical * 0.035, -0.55, 0.55), step);
    if (target.carry > 0) {
      const up = v3(0, 1, 0);
      let dir = qRotate(qAxis(up, lagYaw * target.carry), pose.dir);
      const lateral = reject(cross(up, dir), dir, v3(1, 0, 0));
      dir = qRotate(qAxis(lateral, -lagPitch * target.carry), dir);
      pose.dir = norm(dir, pose.dir);
    }

    // Trembling under a fully charged blade.
    if (f.mode === "charge") {
      const strain = f.charge * f.charge * 0.011;
      pose.grip.x += Math.sin(this.clock * 47) * strain;
      pose.grip.y += Math.sin(this.clock * 61 + 1.3) * strain;
      pose.chestRoll += Math.sin(this.clock * 39) * strain * 1.2;
    }

    // --- Knock-back tumble ----------------------------------------------------------------
    if (f.mode === "hitstun") {
      if (!f.grounded && !frozen) {
        const flying = Math.hypot(f.vx, f.vz) + Math.abs(f.vy) * 0.4;
        this.tumbleAngle += step * clamp(1.4 + flying * 0.42, 1.4, 7.5);
      }
      if (frozen) this.tumbleAngle = Math.max(this.tumbleAngle, 0.34);
      if (f.grounded) this.tumbleAngle += (0.5 - this.tumbleAngle) * (1 - Math.exp(-step * 9));
    } else if (f.mode === "grabbed") {
      this.tumbleAxis = v3(1, 0, 0);
      this.tumbleAngle += (-0.28 - this.tumbleAngle) * (1 - Math.exp(-step * 10));
    } else if (this.tumbleAngle !== 0) {
      // Come out of the spin the short way round.
      this.tumbleAngle = wrapAngle(this.tumbleAngle);
      this.tumbleAngle *= Math.exp(-step * (f.grounded ? 16 : 9));
      if (Math.abs(this.tumbleAngle) < 0.002) this.tumbleAngle = 0;
    }
    pose.tumble = mul(this.tumbleAxis, this.tumbleAngle);

    // --- Edge alignment: the flat of the blade is the axis it is turning about ------------
    const dir = norm(pose.dir, v3(0, 0, -1));
    const rest = reject(cross(dir, v3(0, 1, 0)), dir, v3(1, 0, 0));
    let desired = rest;
    if (this.previousDir && step > 0) {
      const turning = cross(this.previousDir, dir);
      const rate = len(turning) / step;
      if (rate > 2.5) desired = norm(turning, rest);
    }
    if (dot(desired, this.flat) < 0) desired = mul(desired, -1);
    this.flat = reject(
      lerpV(this.flat, desired, step > 0 ? 1 - Math.exp(-step * 22) : 0),
      dir,
      rest,
    );
    this.previousDir = dir;

    const skeleton = solve(pose, {
      ground: context.floor && f.y > -0.3 ? -f.y : null,
      flat: this.flat,
    });

    // --- World transform and contact events ----------------------------------------------
    let shakeX = 0,
      shakeZ = 0;
    if (frozen && (f.mode === "hitstun" || f.mode === "clash")) {
      const amount = Math.min(0.09, 0.03 + f.hitstop * 0.6);
      const wobble = Math.sin(this.wall * 90);
      shakeX = this.knock.x * wobble * amount;
      shakeZ = this.knock.z * wobble * amount;
    }
    const origin = v3(
      f.x + shakeX * cosF + shakeZ * sinF,
      f.y,
      f.z - shakeX * sinF + shakeZ * cosF,
    );
    const toWorld = (point: V3): V3 => {
      const p = tumbled(point, skeleton.tumble);
      return v3(
        origin.x + p.x * cosF + p.z * sinF,
        origin.y + p.y,
        origin.z - p.x * sinF + p.z * cosF,
      );
    };
    const bladeBase = toWorld(skeleton.bladeBase);
    const bladeTip = toWorld(skeleton.bladeTip);

    const at = target.at;
    if (f.attack === "overhead" && f.mode !== "charge" && skeleton.tipOnGround) {
      if (this.previousAt < OVERHEAD_IMPACT && at >= OVERHEAD_IMPACT - 0.2 && !this.wasOnGround) {
        events.push({
          kind: "slam",
          x: bladeTip.x,
          y: origin.y,
          z: bladeTip.z,
          power: 0.6 + f.charge * 0.4,
        });
        this.bounce.kick(1.6 + f.charge);
      }
    }
    this.scrapeCooldown -= dt;
    if (skeleton.tipOnGround && target.cutting > 0.2 && this.scrapeCooldown <= 0 && !frozen) {
      this.scrapeCooldown = 0.045;
      events.push({ kind: "scrape", x: bladeTip.x, y: origin.y, z: bladeTip.z, power: 0.5 });
    }
    this.wasOnGround = skeleton.tipOnGround;
    this.previousAt = at;

    // --- Tail, ears, scarf ------------------------------------------------------------------
    const sway = Math.sin(this.clock * 1.7) * 0.1 + Math.sin(this.gait * TAU) * this.speed * 0.05;
    let drive = clamp(-yawRate * 0.07 - this.velocity.x * 0.07, -1.1, 1.1) + sway;
    const tail: { yaw: number; pitch: number }[] = [];
    const lift = this.tailPitch.step(
      clamp(-vertical * 0.07 + this.speed * 0.05 - (f.mode === "hitstun" ? 0.5 : 0), -0.9, 0.9),
      step,
    );
    for (let i = 0; i < TAIL_SEGMENTS; i++) {
      drive = this.tailYaw[i]!.step(drive, step);
      tail.push({ yaw: drive * (i === 0 ? 0.7 : 0.9), pitch: lift * (0.5 + i * 0.25) });
    }
    const ears = this.earSpring.step(
      clamp(this.velocity.z * 0.06 - vertical * 0.05 + pose.chestPitch * 0.3, -0.7, 0.9),
      step,
    );
    const scarf = {
      yaw: this.scarfYaw.step(clamp(-yawRate * 0.06 - this.velocity.x * 0.1, -1.2, 1.2), step),
      pitch: this.scarfPitch.step(
        clamp(0.25 + this.velocity.z * 0.16 - vertical * 0.06, -0.5, 1.35),
        step,
      ),
    };

    return {
      skeleton,
      origin,
      facing: f.facing,
      bladeBase,
      bladeTip,
      trail: target.cutting,
      tail,
      ears,
      scarf,
      events,
    };
  }

  private event(kind: MotionEventKind, f: Fighter, local: V3, power: number): MotionEvent {
    const cosF = Math.cos(f.facing),
      sinF = Math.sin(f.facing);
    return {
      kind,
      x: f.x + local.x * cosF + local.z * sinF,
      y: f.y,
      z: f.z - local.x * sinF + local.z * cosF,
      power: clamp01(power),
    };
  }

  private beginKnock(f: Fighter, toBody: (x: number, z: number) => V3): void {
    const launch = f.pendingLaunch ?? { x: f.vx, y: f.vy, z: f.vz };
    const flat = toBody(launch.x, launch.z);
    this.knock = len(flat) > 0.05 ? norm(flat) : v3(0, 0, -1);
    // Head goes with the blow: rotate about the horizontal axis square to it.
    this.tumbleAxis = norm(cross(v3(0, 1, 0), this.knock), v3(1, 0, 0));
    this.tumbleAngle = 0;
  }

  /** Mirrors a right-side pose when the sword is on the left. */
  private sided(pose: Pose): Pose {
    return this.side > 0 ? pose : mirrorPose(pose);
  }

  private authored(
    f: Fighter,
    toBody: (x: number, z: number) => V3,
  ): {
    pose: Pose;
    /** Timeline position for attacks (0 otherwise). */
    at: number;
    /** 0-1: how much of the blade's sweep is a cut (trail and floor sparks). */
    cutting: number;
    /** How much the locomotion layer may move the feet. */
    planted: number;
    /** How much the airborne leg pose applies. */
    legs: number;
    /** How much the idle carry (sword lag, air trunk) applies. */
    carry: number;
  } {
    const progress = f.modeDuration > 0 ? clamp01(f.modeTime / f.modeDuration) : 0;
    const guard = this.sided(
      this.atEase > 0.001 ? blendPose(GUARD, SHOULDER, easeInOut(this.atEase)) : GUARD,
    );
    const result = { pose: guard, at: 0, cutting: 0, planted: 1, legs: 1, carry: 1 };
    const attack = f.attack;
    switch (f.mode) {
      case "charge":
      case "windup":
      case "active":
      case "recovery": {
        if (!attack) {
          if (f.mode === "recovery" && this.recovering === "grab")
            result.pose = this.sided(grabWhiffPose(progress));
          else if (f.mode === "recovery" && this.recovering === "throw") {
            const local = toBody(f.throwDirection.x, f.throwDirection.z);
            const canonical = this.side > 0 ? local : v3(-local.x, 0, local.z);
            result.pose = this.sided(throwPose(progress, canonical));
          }
          result.planted = 0.2;
          result.carry = 0.4;
          return result;
        }
        const at =
          f.mode === "charge"
            ? 0
            : f.mode === "windup"
              ? progress
              : f.mode === "active"
                ? 1 + progress
                : 2 + progress;
        result.pose = this.sided(attackPose(attack, at, f.charge));
        result.at = at;
        // The cut proper: the end of the wind-up, the whole active window, the follow-through.
        result.cutting =
          f.mode === "charge" ? 0 : clamp01((at - 0.72) / 0.2) * clamp01((2.42 - at) / 0.3);
        result.planted = f.mode === "charge" ? 0.85 : 0;
        result.carry = f.mode === "charge" ? 0.5 : 0.15;
        // The riser authors its own airborne legs until it has topped out.
        result.legs = attack === "rising" && at >= 1 && at < 2.5 ? 0 : 1;
        return result;
      }
      case "step": {
        result.pose = this.stepPose(f, guard, toBody);
        result.planted = 0;
        result.carry = 1;
        return result;
      }
      case "hitstun": {
        result.pose = this.hurtPose(f, guard);
        result.planted = 0;
        result.legs = f.grounded ? 1 : 0;
        result.carry = 0.6;
        return result;
      }
      case "clash": {
        result.pose = this.sided(CLASH);
        result.planted = 0;
        result.carry = 0.3;
        return result;
      }
      case "grab": {
        result.pose = this.sided(grabPose(progress));
        result.planted = 0;
        result.carry = 0.5;
        return result;
      }
      case "throw": {
        const local = toBody(f.throwDirection.x, f.throwDirection.z);
        const yaw = Math.atan2(local.x, local.z) * this.side;
        result.pose = this.sided(holdPose(clamp01(f.modeTime / RULES.grabHold), yaw));
        result.planted = 0;
        result.carry = 0.5;
        return result;
      }
      case "grabbed": {
        const held = clonePose(this.sided(HELD));
        const kick = Math.sin(this.clock * 13);
        held.footL.z += kick * 0.14;
        held.footR.z -= kick * 0.14;
        held.footL.y += Math.max(0, kick) * 0.08;
        held.footR.y += Math.max(0, -kick) * 0.08;
        held.chestRoll += Math.sin(this.clock * 9) * 0.1;
        held.offHand.y += Math.sin(this.clock * 11) * 0.08;
        result.pose = held;
        result.planted = 0;
        result.legs = 0;
        result.carry = 0.8;
        return result;
      }
      case "cancel": {
        // Arresting the blade: the knees and back take the load, then let it go.
        const heavy = clamp01((f.modeDuration - RULES.cancelDuration) / 0.2);
        const brace = Math.sin(progress * Math.PI);
        const braced = clonePose(guard);
        braced.hip.y -= (0.05 + 0.08 * heavy) * brace;
        braced.hipPitch += 0.06 * heavy * brace;
        braced.chestPitch += (0.06 + 0.1 * heavy) * brace;
        braced.headPitch -= 0.05 * heavy * brace;
        result.pose = braced;
        result.planted = 0.3;
        result.carry = 0.6;
        return result;
      }
      case "idle":
      case "dead":
      default: {
        // Slow breath when standing still.
        const breathing = clonePose(guard);
        const breath = Math.sin(this.clock * 2.1);
        breathing.hip.y += breath * 0.01;
        breathing.chestPitch += breath * 0.018;
        breathing.grip.y += Math.sin(this.clock * 2.1 - 0.7) * 0.008;
        breathing.headPitch -= breath * 0.012;
        result.pose = breathing;
        return result;
      }
    }
  }

  /** A low, driving dodge: one leg pushes, the other reaches. */
  private stepPose(f: Fighter, guard: Pose, toBody: (x: number, z: number) => V3): Pose {
    const pose = clonePose(guard);
    const d = norm(toBody(f.stepDirection.x, f.stepDirection.z), v3(0, 0, 1));
    const waiting = f.stepDelay > 0;
    const progress = waiting ? 0 : clamp01(f.modeTime / RULES.stepDuration);
    const drive = waiting ? 0.35 : 1;
    const low = waiting ? -0.2 : -0.25 + Math.sin(progress * Math.PI) * 0.05;
    pose.hip = v3(d.x * 0.16 * drive, low, d.z * 0.16 * drive);
    pose.chestPitch = 0.14 + d.z * 0.46 * drive;
    pose.chestRoll = -d.x * 0.5 * drive;
    pose.hipPitch = d.z * 0.16 * drive;
    pose.hipRoll = -d.x * 0.16 * drive;
    pose.headPitch = -d.z * 0.22 * drive;
    // The foot on the side we are going to leads.
    const leftLeads = Math.abs(d.x) > 0.25 ? d.x > 0 : this.side > 0 ? d.z >= 0 : d.z < 0;
    const across = v3(d.z, 0, -d.x);
    const lateral = (sign: number): V3 =>
      mul(across, sign * 0.1 * (dot(across, v3(1, 0, 0)) >= 0 ? 1 : -1));
    const reach = add(mul(d, 0.42 * drive), lateral(leftLeads ? 1 : -1));
    const push = add(mul(d, -0.44 * drive), lateral(leftLeads ? -1 : 1));
    const reaching = progress < 0.5;
    const lead = v3(reach.x, reaching ? 0.12 * Math.sin((progress / 0.5) * Math.PI) : 0, reach.z);
    const trail = v3(push.x, reaching ? 0 : 0.06, push.z);
    const leadPitch = reaching ? -0.3 : 0;
    const trailPitch = reaching ? 0.5 : 0.75;
    if (leftLeads) {
      pose.footL = lead;
      pose.footR = trail;
      pose.footLPitch = leadPitch;
      pose.footRPitch = trailPitch;
    } else {
      pose.footR = lead;
      pose.footL = trail;
      pose.footRPitch = leadPitch;
      pose.footLPitch = trailPitch;
    }
    return pose;
  }

  /** Flung limbs and a trunk bent round the blow. */
  private hurtPose(f: Fighter, guard: Pose): Pose {
    const pose = clonePose(guard);
    const k = this.knock;
    const frozen = f.hitstop > 0;
    const out = this.side > 0 ? -1 : 1;
    const time = f.modeTime;
    // Whiplash: the head is left behind for an instant, then snaps the way the body went.
    const whip = frozen ? -0.5 : Math.min(1, time / 0.12) * 1.3 - 0.5;
    if (f.grounded && !frozen) {
      // Skidding to a stop after landing while still stunned.
      pose.hip = v3(-k.x * 0.08, -0.28, -k.z * 0.08);
      pose.chestPitch = 0.34 - k.z * 0.2;
      pose.chestRoll = k.x * 0.2;
      pose.headPitch = -0.2;
      pose.footL = v3(0.22 + k.x * 0.1, 0, 0.18 + k.z * 0.16);
      pose.footR = v3(-0.22 + k.x * 0.1, 0, -0.16 + k.z * 0.16);
      pose.dir = norm(v3(out * 0.5, -0.3, -0.7));
      pose.offFree = 1;
      pose.offHand = v3(-out * 0.2, -0.5, 0.25);
      return pose;
    }
    pose.hip = v3(k.x * 0.1, 0.03, k.z * 0.1);
    pose.hipPitch = -k.z * 0.22;
    pose.hipRoll = k.x * 0.2;
    pose.chestPitch = k.z * 0.52 + (frozen ? -k.z * 0.3 : 0);
    pose.chestRoll = -k.x * 0.52;
    pose.chestYaw = guard.chestYaw * 0.3;
    pose.lowerYaw = guard.lowerYaw * 0.3;
    pose.headPitch = k.z * 0.4 * whip;
    pose.headRoll = -k.x * 0.4 * whip;
    pose.headYaw = 0;
    pose.squash = frozen ? 0.14 : -0.04;
    const flail = Math.sin(time * 15);
    pose.footL = v3(0.22, 0.2 + flail * 0.08, 0.18 - k.z * 0.2);
    pose.footR = v3(-0.2, 0.08 - flail * 0.08, -0.14 - k.z * 0.24);
    pose.footLPitch = 0.5;
    pose.footRPitch = 0.75;
    // The sword is hanging on by one hand, dragged behind the body's flight.
    pose.grip = v3(out * 0.5 - k.x * 0.12, -0.02, -k.z * 0.16);
    pose.dir = norm(v3(out * 0.45 - k.x * 0.6, 0.55, -k.z * 0.6 - 0.1));
    pose.offFree = 1;
    pose.offHand = v3(-out * 0.42, 0.22 + flail * 0.06, -k.z * 0.2);
    return pose;
  }

  /** Feet that actually walk: planted through each stance, then swung to the next plant. */
  private locomotion(
    pose: Pose,
    f: Fighter,
    step: number,
    planted: number,
    events: MotionEvent[],
  ): void {
    const walking = f.grounded && planted > 0 ? clamp01(this.speed / 0.9) * planted : 0;
    const pace = clamp01(this.speed / RUN_SPEED);
    const cadence = lerp(1.35, 2.4, pace);
    if (f.grounded && this.speed > 0.2) this.gait = (this.gait + cadence * step) % 1;
    else if (this.speed <= 0.2) {
      // Come to rest with the nearer foot down.
      const rest = this.gait < 0.5 ? 0.25 : 0.75;
      this.gait += (rest - this.gait) * (1 - Math.exp(-step * 8));
    }
    // The hips follow the direction of travel; the chest keeps facing the opponent.
    const heading = Math.atan2(this.travel.x, this.travel.z);
    const backing = Math.abs(heading) > 1.9;
    const legYaw = clamp(backing ? wrapAngle(heading - Math.PI) : heading, -0.95, 0.95);
    const yawTarget = lerp(pose.lowerYaw, legYaw, walking);
    this.lowerYaw += wrapAngle(yawTarget - this.lowerYaw) * (1 - Math.exp(-step * 12));
    if (walking <= 0.001) {
      this.lowerYaw = pose.lowerYaw;
      this.stride[0] = this.stride[1] = false;
      return;
    }
    pose.lowerYaw = lerp(pose.lowerYaw, this.lowerYaw, walking);

    const duty = lerp(0.64, 0.38, pace);
    const stride = this.speed / cadence;
    const half = Math.min(0.37, (duty * stride) / 2);
    const liftHeight = lerp(0.07, 0.25, pace);
    const cosL = Math.cos(pose.lowerYaw),
      sinL = Math.sin(pose.lowerYaw);
    const across = v3(cosL, 0, -sinL);
    const direction = this.travel;
    for (let i = 0; i < 2; i++) {
      const phase = (this.gait + (i === 0 ? 0 : 0.5)) % 1;
      let along: number;
      let lift = 0;
      let pitch = 0;
      const stance = phase < duty;
      if (stance) {
        const u = phase / duty;
        along = lerp(half, -half, u);
        // Roll from heel to toe as the body passes over the foot.
        pitch = u < 0.15 ? -0.3 * (1 - u / 0.15) : u > 0.7 ? ((u - 0.7) / 0.3) * 0.55 : 0;
      } else {
        const u = (phase - duty) / (1 - duty);
        along = lerp(-half, half, easeInOut(u));
        lift = Math.sin(u * Math.PI) * liftHeight;
        pitch = lerp(0.6, -0.3, easeInOut(u));
      }
      if (backing) pitch = -pitch * 0.5;
      const side = i === 0 ? 1 : -1;
      const position = add(mul(across, side * 0.14), mul(direction, along));
      const foot = v3(position.x, lift, position.z);
      if (i === 0) {
        pose.footL = lerpV(pose.footL, foot, walking);
        pose.footLPitch = lerp(pose.footLPitch, pitch, walking);
        pose.footLYaw = lerp(pose.footLYaw, 0.1, walking);
      } else {
        pose.footR = lerpV(pose.footR, foot, walking);
        pose.footRPitch = lerp(pose.footRPitch, pitch, walking);
        pose.footRYaw = lerp(pose.footRYaw, -0.1, walking);
      }
      // A footfall at running pace is heavy enough to hear and to raise dust.
      if (stance && !this.stride[i] && pace > 0.55 && walking > 0.6) {
        const cosF = Math.cos(f.facing),
          sinF = Math.sin(f.facing);
        events.push({
          kind: "skid",
          x: f.x + foot.x * cosF + foot.z * sinF,
          y: f.y,
          z: f.z - foot.x * sinF + foot.z * cosF,
          power: 0.25,
        });
      }
      this.stride[i] = stance;
    }
    // Lowest in the middle of each stance, highest in the flight between them.
    const bob = Math.cos(2 * TAU * (this.gait - duty / 2));
    const swing = Math.cos(TAU * (this.gait - duty / 2));
    pose.hip.y += (-bob * lerp(0.012, 0.055, pace) - pace * 0.04) * walking;
    pose.hip.x += across.x * swing * 0.03 * walking;
    pose.hip.z += across.z * swing * 0.03 * walking;
    pose.hipRoll += swing * 0.06 * walking * (backing ? -1 : 1);
    pose.lowerYaw += Math.sin(TAU * this.gait) * 0.14 * pace * walking;
    pose.chestYaw -= Math.sin(TAU * this.gait) * 0.07 * pace * walking;
    // Running leans into the direction of travel.
    pose.chestPitch += direction.z * 0.2 * pace * walking;
    pose.chestRoll -= direction.x * 0.2 * pace * walking;
    pose.hipPitch += direction.z * 0.08 * pace * walking;
    // The point comes off the floor when moving, and the blade bounces with each stride.
    const up = v3(0, 1, 0);
    const lateral = reject(cross(up, pose.dir), pose.dir, v3(1, 0, 0));
    pose.dir = norm(
      qRotate(qAxis(lateral, -(0.1 * pace + bob * 0.03 * pace) * walking), pose.dir),
      pose.dir,
    );
    pose.grip.y += bob * 0.012 * pace * walking;
  }
}
