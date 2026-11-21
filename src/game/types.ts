import type { AccessoryId, PaletteId, Species } from "./characters";
import type { AiLevel, MatchOptions } from "./match";
import type { PlayerMatchStats } from "./matchStats";
import type { EffectiveRules } from "./rules";
import type { SetMatch } from "./setMatch";
import type { StageId } from "./stages";

export type { Species } from "./characters";

export type AttackId = "overhead" | "rising" | "sweep" | "thrust";
export type FighterMode =
  | "idle"
  | "charge"
  | "windup"
  | "active"
  | "recovery"
  | "step"
  | "cancel"
  | "hitstun"
  | "grab"
  | "grabbed"
  | "throw"
  | "clash"
  | "dead";
export type MatchMode = "duel" | "rumble" | "training";
export type Phase = "menu" | "countdown" | "playing" | "paused" | "ended";
export type DrawReason = "allOut" | "timeUp";
export type Vec2 = { x: number; z: number };

/**
 * World coordinates: +Y up, ground on X/Z. The camera looks down from the +X/+Z side, so screen
 * up is world (-0.6, -0.8) and screen right is (0.8, -0.6) (see coordinates.ts). Facing 0 is +Z.
 */
export interface Fighter {
  id: number;
  /**
   * The slot's look, from its loadout (`characters.ts`): name, animal, team colour and accessory.
   * Cosmetic only: no rule of the simulation reads any of the five.
   */
  name: string;
  species: Species;
  color: number;
  palette: PaletteId;
  accessory: AccessoryId;
  human: boolean;
  /** 1-based player number among the humans of this match (slot order); null for a CPU. */
  player: number | null;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  facing: number;
  grounded: boolean;
  mode: FighterMode;
  modeTime: number;
  modeDuration: number;
  attack: AttackId | null;
  charge: number;
  damage: number;
  stamina: number;
  staminaDelay: number;
  hitstop: number;
  invulnerable: number;
  outsideTime: number;
  airRisingUsed: boolean;
  airThrustUsed: boolean;
  /** The one air dodge per airtime has been spent; cleared on landing. */
  airStepUsed: boolean;
  /**
   * Lives left, including the one in play. In a duel or rumble a fighter is out for good once this
   * reaches 0; `mode === "dead"` with `stocks > 0` means it is waiting to respawn. Training never
   * spends stocks (everyone there is rebuilt 1.5 s after falling).
   */
  stocks: number;
  /** Seconds until a downed fighter with lives left comes back; 0 otherwise (and in training). */
  respawnTimer: number;
  /** How well a CPU plays; unused for the human. */
  aiLevel: AiLevel;
  stepDirection: Vec2;
  stepDelay: number;
  hitTargets: number[];
  swingId: number;
  grabbedId: number | null;
  grabbedBy: number | null;
  throwDirection: Vec2;
  pendingLaunch: { x: number; y: number; z: number } | null;
  diInput: Vec2;
  lastAttacker: number | null;
  lastHitAt: number;
  kills: number;
  eliminatedAt: number | null;
  eliminationReason: string | null;
  aiThink: number;
  aiCharge: number;
  aiIntent: Vec2;
  /**
   * A press made while this fighter could not act on it, held for a few fixed ticks so it fires on
   * the first tick it becomes legal (see `RULES.inputBuffer`). Humans only; null when empty.
   */
  inputBuffer: BufferedInput | null;
}

/** The presses the input buffer can hold. `cancel` is never buffered. */
export type BufferedAction = "attack" | "step" | "jump" | "grab";

export interface BufferedInput {
  action: BufferedAction;
  /** The attack asked for when `action` is `"attack"`; null otherwise. */
  attack: AttackId | null;
  /**
   * Fixed simulation ticks since the press (0 on its own tick); it may fire while
   * `<= INPUT_BUFFER_TICKS` (one more with `landingGrace`).
   */
  age: number;
  /**
   * What the fighter was doing when the button went down. Lets a later rule (a tech roll on a
   * hitstun landing, say) recognise and take a step that was buffered out of hitstun.
   */
  pressedIn: FighterMode;
  /**
   * Set when a landing frees this jump or grab. Input runs before physics, so it is first tried on
   * the tick after the landing tick; this lets it live one tick past `INPUT_BUFFER_TICKS` so the
   * landing window is as long as recovery's.
   */
  landingGrace: boolean;
}

export interface ArenaState {
  /** The stage being fought on; with `halfSize` it decides where there is floor (stages.ts). */
  stageId: StageId;
  /** Half the side of the square that has not collapsed yet. */
  halfSize: number;
  initialHalfSize: number;
  tileSize: number;
  warningRing: boolean;
  nextCollapse: number;
  safeZone: { x: number; z: number; radius: number; active: boolean };
  wind: Vec2;
  windActive: boolean;
}

export interface Bomb {
  id: number;
  x: number;
  z: number;
  radius: number;
  timer: number;
  duration: number;
  exploded: boolean;
}

export type EffectKind =
  | "hit"
  | "clash"
  | "step"
  | "charge"
  | "jump"
  | "land"
  | "ko"
  | "bomb"
  | "cancel"
  | "throw";
export interface Effect {
  id: number;
  kind: EffectKind;
  x: number;
  y: number;
  z: number;
  color: number;
  life: number;
  duration: number;
  size: number;
}

export interface GameState {
  phase: Phase;
  mode: MatchMode;
  elapsed: number;
  countdown: number;
  fighters: Fighter[];
  arena: ArenaState;
  bombs: Bomb[];
  effects: Effect[];
  winnerId: number | null;
  drawReason: DrawReason | null;
  set: SetMatch | null;
  message: string;
  messageTime: number;
  seed: number;
  pausedFrom: "playing" | "countdown";
  /** What this match was started with. */
  options: MatchOptions;
  /** The rules it runs with: lives, time limit and gimmicks after the mode and stage had a say. */
  rules: EffectiveRules;
  /** Running totals for this game, indexed by fighter slot. */
  playerStats: PlayerMatchStats[];
  /** Match-wide counters. `dodges` counts human step inputs that started a step. */
  stats: { hits: number; clashes: number; dodges: number; maxDamage: number };
}

export interface PlayerInput {
  move: Vec2;
  aim: Vec2 | null;
  attackPressed: AttackId | null;
  attackHeld: AttackId | null;
  jump: boolean;
  step: boolean;
  cancel: boolean;
  grab: boolean;
}

/** One input per human fighter, keyed by fighter id. */
export type PlayerInputs = Partial<Record<number, PlayerInput>>;

export const emptyInput = (): PlayerInput => ({
  move: { x: 0, z: 0 },
  aim: null,
  attackPressed: null,
  attackHeld: null,
  jump: false,
  step: false,
  cancel: false,
  grab: false,
});

export interface AttackDefinition {
  label: string;
  startup: number;
  active: number;
  recovery: number;
  stamina: number;
  damage: number;
  reach: number;
  width: number;
  knockback: number;
  growth: number;
  lift: number;
  lunge: number;
}
