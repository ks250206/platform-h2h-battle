import { RULES } from "../game/tuning";
import type { AttackId, Fighter, FighterMode } from "../game/types";
import { clamp01, lerp, TAU } from "./math3";

/**
 * How a fighter's state reads on screen, so a glance tells when to dodge, when to punish and
 * whether a swing can still be called off. Pure and presentational: it reads the simulation's
 * own fields (mode, timers, hit list) at the instant it is drawn and keeps no memory, so it can
 * never trail a phase change, whatever the frame rate.
 *
 * The visual language, which never relies on colour alone:
 * - Charge and wind-up (cancellable): the blade warms up and its glow breathes; the floor halo
 *   holds through the charge and closes in over the wind-up like a countdown; the heading
 *   chevron still turns with the aim.
 * - Active (committed, live): white-hot blade, a steady glow, the cutting trail, and the heading
 *   chevron thrown out as a locked arrow along the cut.
 * - Recovery and cancel lag (committed, exposed): the trail is gone at once, the blade goes dark,
 *   the foot ring breaks into dashes and the chevron disappears until the fighter can act.
 */
export type SwordPhase =
  | "ready"
  | "charge"
  | "windup"
  | "active"
  | "recovery"
  | "cancel"
  | "clash"
  | "other";

export interface CombatCue {
  phase: SwordPhase;
  attack: AttackId | null;
  /** 0-1 through the current mode; 0 for modes without a fixed length. */
  progress: number;
  /** Charge or wind-up: a cancel input still stops the swing (engine `handleInput`). */
  cancellable: boolean;
  /** The blade can hit right now: `attackContains` only ever counts an `active` swing. */
  live: boolean;
  /** The facing still follows the aim (the engine's turn rate is above zero). */
  canTurn: boolean;
  /** A recovery from a swing that touched nobody: the opening a punish is for. */
  whiffed: boolean;
  /**
   * Extra lag of a cancel: 0 when called off from the charge, rising to 1 for a wind-up stopped
   * at its very end (`RULES.windupCancelPenalty`).
   */
  cancelLag: number;
  /** 0-1: locked out and open to a punish (recovery, cancel lag). Strongest after a whiff. */
  exposed: number;
  /** Blade core luminance: -1 spent (dark), 0 plain steel, 1 white-hot. */
  blade: number;
  /** Opacity of the glow round the blade, 0-1. */
  glow: number;
  /** Strength of the cutting trail: full exactly while the swing is live. */
  trail: number;
  /** Floor halo radius (0 hidden): steady through a charge, closing in through the wind-up. */
  halo: number;
}

/** A slow breath (well under 3 Hz): it marks a swing that can still be called off, never a strobe. */
export const CANCELLABLE_BREATH_HZ = 2.2;
/** How long a clash keeps both blades flared after the hit-stop. */
const CLASH_FLARE = 0.1;
/** Floor halo radius: where the charge holds it, and where a wind-up has drawn it in to. */
export const HALO_CHARGED = 0.97;
export const HALO_FIRED = 0.42;

/** Turning follows the aim in exactly these modes (`BattleEngine.turnRate`). */
export function canTurn(mode: FighterMode): boolean {
  return mode === "idle" || mode === "charge" || mode === "windup";
}

type CueSource = Pick<
  Fighter,
  "mode" | "modeTime" | "modeDuration" | "attack" | "charge" | "hitTargets"
>;

/** A finished swing that hit nobody (dodged, out of reach, or into thin air). */
export function whiffed(f: CueSource): boolean {
  return f.mode === "recovery" && f.attack !== null && f.hitTargets.length === 0;
}

/** 0 for a cancel out of a charge, up to 1 for one at the end of a wind-up. */
export function cancelLag(f: Pick<Fighter, "mode" | "modeDuration">): number {
  if (f.mode !== "cancel") return 0;
  return clamp01((f.modeDuration - RULES.cancelDuration) / RULES.windupCancelPenalty);
}

/** How open the fighter is: 1 after a whiff or a late cancel, less after a connected swing. */
export function exposure(f: CueSource): number {
  if (f.mode === "cancel") return 0.75 + 0.25 * cancelLag(f);
  if (f.mode !== "recovery") return 0;
  // A grab or throw recovery has no sword in it, but is just as open.
  if (f.attack === null) return 0.8;
  return whiffed(f) ? 1 : 0.55;
}

/** `time` only drives the breathing of the cancellable glow. */
export function combatCue(f: CueSource, time = 0): CombatCue {
  const progress = f.modeDuration > 0 ? clamp01(f.modeTime / f.modeDuration) : 0;
  const cue: CombatCue = {
    phase: "other",
    attack: f.attack,
    progress,
    cancellable: false,
    live: false,
    canTurn: canTurn(f.mode),
    whiffed: false,
    cancelLag: 0,
    exposed: 0,
    blade: 0,
    glow: 0,
    trail: 0,
    halo: 0,
  };
  const breath = 0.78 + 0.22 * Math.sin(time * TAU * CANCELLABLE_BREATH_HZ);
  switch (f.mode) {
    case "idle":
      cue.phase = "ready";
      return cue;
    case "charge": {
      if (!f.attack) return cue;
      const c = clamp01(f.charge);
      cue.phase = "charge";
      cue.cancellable = true;
      cue.blade = 0.2 + 0.3 * c;
      cue.glow = (0.22 + 0.3 * c) * breath;
      cue.halo = lerp(0.76, HALO_CHARGED, c);
      return cue;
    }
    case "windup": {
      if (!f.attack) return cue;
      cue.phase = "windup";
      cue.cancellable = true;
      cue.blade = 0.45 + 0.4 * progress;
      cue.glow = (0.4 + 0.3 * progress) * breath;
      // The halo closes on the fighter as the cut approaches; it is gone the instant it lands.
      cue.halo = lerp(HALO_CHARGED, HALO_FIRED, progress);
      return cue;
    }
    case "active": {
      if (!f.attack) return cue;
      cue.phase = "active";
      cue.live = true;
      cue.blade = 1;
      cue.glow = 0.9;
      cue.trail = 1;
      return cue;
    }
    case "recovery": {
      cue.phase = "recovery";
      cue.whiffed = whiffed(f);
      cue.exposed = exposure(f);
      cue.blade = -cue.exposed;
      return cue;
    }
    case "cancel": {
      cue.phase = "cancel";
      cue.cancelLag = cancelLag(f);
      cue.exposed = exposure(f);
      cue.blade = -cue.exposed;
      return cue;
    }
    case "clash": {
      // Steel on steel: both blade cores flash white through the hit-stop (the clock stands still
      // in it), then go dull for the rest of the stagger. No glow shell: neither blade can hit.
      const flare = clamp01(1 - f.modeTime / CLASH_FLARE);
      cue.phase = "clash";
      cue.blade = lerp(-0.4, 1, flare);
      return cue;
    }
    default:
      return cue;
  }
}
