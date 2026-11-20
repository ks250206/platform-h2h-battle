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
export type Species = "fox" | "rabbit" | "bear" | "raccoon";
export type Vec2 = { x: number; z: number };

/** World coordinates: +Y up, +Z toward camera. Facing 0 is +Z. */
export interface Fighter {
  id: number;
  name: string;
  species: Species;
  color: number;
  human: boolean;
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
  kills: number;
  eliminatedAt: number | null;
  eliminationReason: string | null;
  aiThink: number;
  aiCharge: number;
  aiIntent: Vec2;
}

export interface ArenaState {
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
  message: string;
  messageTime: number;
  seed: number;
  pausedFrom: "playing" | "countdown";
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
