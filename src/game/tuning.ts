import type { AiLevel } from "./match";
import type { AttackDefinition, AttackId } from "./types";

export const ATTACKS: Record<AttackId, AttackDefinition> = {
  overhead: {
    label: "振り下ろし",
    startup: 0.43,
    active: 0.14,
    recovery: 0.6,
    stamina: 25,
    damage: 18,
    reach: 2.7,
    width: 0.6,
    knockback: 5.8,
    growth: 0.085,
    lift: 5.8,
    lunge: 0,
  },
  rising: {
    label: "振り上げ",
    startup: 0.38,
    active: 0.22,
    recovery: 0.62,
    stamina: 25,
    damage: 12,
    reach: 1.9,
    width: 0.8,
    knockback: 4.2,
    growth: 0.055,
    lift: 10,
    lunge: 2.5,
  },
  sweep: {
    label: "横振り",
    startup: 0.35,
    active: 0.18,
    recovery: 0.48,
    stamina: 20,
    damage: 11,
    reach: 2.05,
    width: 2.0,
    knockback: 4.7,
    growth: 0.062,
    lift: 3.8,
    lunge: 0,
  },
  thrust: {
    label: "突き",
    startup: 0.28,
    active: 0.16,
    recovery: 0.52,
    stamina: 20,
    damage: 10,
    reach: 2.85,
    width: 0.45,
    knockback: 4.7,
    growth: 0.065,
    lift: 3.2,
    lunge: 9,
  },
};

export const RULES = {
  fixedStep: 1 / 60,
  moveSpeed: 4.6,
  airSpeed: 2.5,
  gravity: 24,
  jumpSpeed: 9,
  fighterRadius: 0.42,
  bodyHeight: 1.65,
  maxStamina: 100,
  staminaRegen: 30,
  staminaDelay: 0.5,
  chargeCost: 10,
  maxCharge: 0.9,
  maxHold: 1.3,
  cancelDuration: 0.12,
  windupCancelPenalty: 0.2,
  stepCost: 25,
  stepDuration: 0.3,
  stepSpeed: 10.5,
  stepInvulStart: 0.08,
  stepInvulEnd: 0.2,
  feintStepDelay: 0.1,
  grabCost: 18,
  grabStartup: 0.2,
  grabActive: 0.09,
  grabRecovery: 0.7,
  grabReach: 1.25,
  grabHold: 0.45,
  hitstop: 0.085,
  clashHitstop: 0.11,
  diAngle: Math.PI / 12,
  outsideLimit: 5,
  outsideDamage: 7,
  outsideRecovery: 2,
  arenaHalfSize: 9,
  tileSize: 2,
  collapseStart: 32,
  collapseInterval: 22,
  collapseWarning: 4,
  minHalfSize: 3,
  safeZoneStart: 18,
  bombStart: 14,
  bombInterval: 11,
  bombWarning: 2.1,
  maxMatchTime: 150,
  /** Extra seconds on the clock for every life beyond the first. */
  matchTimePerStock: 60,
  /** Turning speeds (rad/s): free while idle, slowed while charging, slowest once committed. */
  idleTurnRate: 20,
  chargeTurnRate: 3.6,
  windupTurnRate: 2.6,
  /** An air dodge lifts vertical speed to at least this and floats on reduced gravity. */
  airStepHover: 1.5,
  airStepGravity: 0.35,
  /** A fighter with lives left returns after this delay, dropping in from this height. */
  respawnDelay: 1.4,
  respawnHeight: 6,
  respawnInvulnerable: 2.5,
  /**
   * Input buffer (seconds): an attack, step, jump or grab pressed while the fighter cannot do it
   * (recovery, cancel lag, a step, clash, hitstun, hitstop, or in the air for a jump or grab)
   * fires on the first tick it becomes legal, if that comes within this long of the press. Counted
   * in fixed ticks (`INPUT_BUFFER_TICKS`), so it is the same at any render rate.
   */
  inputBuffer: 0.1,
} as const;

/** `RULES.inputBuffer` in fixed simulation ticks: 6 at 60 Hz. */
export const INPUT_BUFFER_TICKS = Math.round(RULES.inputBuffer / RULES.fixedStep);

/** How a CPU of each strength plays. `normal` reproduces the original CPU. */
export interface AiProfile {
  /** Seconds between decisions: `thinkMin + random × thinkRange`. */
  thinkMin: number;
  thinkRange: number;
  /** Chance to dodge a wind-up (or a bomb about to go off) it has noticed. */
  dodgeChance: number;
  /**
   * Holds a dodge until the wind-up it reacts to has at most this long left (seconds), so a
   * tracking swing cannot follow it; infinite reacts at once.
   */
  dodgeWindow: number;
  /** Dodges the way that actually leaves the swing (back from a sweep, away from the blade line, away from a bomb). */
  smartDodge: boolean;
  /** Stamina it wants in hand before starting an attack. */
  attackStamina: number;
  /** Chance that an attack is held as a deliberate charge rather than tapped. */
  chargeChance: number;
  /** Distance within which a charging CPU may feint into a step against a wind-up; 0 never feints. */
  feintRange: number;
  /** Fraction of `RULES.windupTurnRate` it uses to keep aiming during its own wind-up. */
  tracking: number;
  /** A bomb is noticed once its fuse is this short (seconds). */
  bombNotice: number;
  /** Air moves it uses to get back to the platform. */
  recoverRising: boolean;
  recoverThrust: boolean;
  recoverAirStep: boolean;
  /** Cancels its wind-up when the target has left the attack's reach or will still be invulnerable. */
  cancelWhiffs: boolean;
  /** Closes in on, and attacks, a target stuck in attack recovery. */
  punishRecovery: boolean;
  /** Throws toward the nearest edge, or out of the safe zone. */
  aimedThrows: boolean;
}

export const AI_LEVELS: Record<AiLevel, AiProfile> = {
  easy: {
    thinkMin: 0.42,
    thinkRange: 0.28,
    dodgeChance: 0.2,
    dodgeWindow: Number.POSITIVE_INFINITY,
    smartDodge: false,
    attackStamina: 45,
    chargeChance: 0,
    feintRange: 0,
    tracking: 0,
    bombNotice: 0.9,
    recoverRising: true,
    recoverThrust: false,
    recoverAirStep: false,
    cancelWhiffs: false,
    punishRecovery: false,
    aimedThrows: false,
  },
  normal: {
    thinkMin: 0.18,
    thinkRange: 0.16,
    dodgeChance: 0.7,
    dodgeWindow: Number.POSITIVE_INFINITY,
    smartDodge: false,
    attackStamina: 30,
    chargeChance: 0.3,
    feintRange: 2.4,
    tracking: 0.5,
    bombNotice: Number.POSITIVE_INFINITY,
    recoverRising: true,
    recoverThrust: true,
    recoverAirStep: true,
    cancelWhiffs: false,
    punishRecovery: false,
    aimedThrows: false,
  },
  hard: {
    thinkMin: 0.1,
    thinkRange: 0.08,
    dodgeChance: 0.9,
    dodgeWindow: 0.17,
    smartDodge: true,
    attackStamina: 30,
    chargeChance: 0.45,
    feintRange: 2.8,
    tracking: 1,
    bombNotice: Number.POSITIVE_INFINITY,
    recoverRising: true,
    recoverThrust: true,
    recoverAirStep: true,
    cancelWhiffs: true,
    punishRecovery: true,
    aimedThrows: true,
  },
};
