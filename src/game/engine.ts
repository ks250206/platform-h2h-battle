import { CHARACTERS, PALETTES } from "./characters";
import { CAMERA_FORWARD, CAMERA_RIGHT } from "./coordinates";
import { fighterTitle } from "./identity";
import {
  copyMatchOptions,
  DEFAULT_MATCH_OPTIONS,
  humanSlots,
  levelFor,
  loadoutFor,
  sanitizeMatchOptions,
  type MatchOptions,
} from "./match";
import { emptyPlayerStats, MatchStats } from "./matchStats";
import { clearWalk, routeDirection } from "./navigation";
import { effectiveRules, timeLimitFor, type StageInfo, type TimeRule } from "./rules";
import {
  advanceSet,
  createSetMatch,
  effectiveSetFormat,
  finishSetGame,
  type SetMatch,
} from "./setMatch";
import { advanceRoll, cpuTechOpportunity, rollDirection } from "./ukemi";
import {
  canStandAtStage,
  conveyorVelocityAt,
  hasClearance,
  hasConveyors,
  nearestWalkablePoint,
  respawnCandidates,
  safeZoneAt,
  spawnPoints,
  stageInfoFor,
  STAGES,
} from "./stages";
import { AI_LEVELS, ATTACKS, INPUT_BUFFER_TICKS, RULES, UKEMI, type AiProfile } from "./tuning";
import {
  angleDelta,
  attackContains,
  attacksClash,
  canStandAt,
  clamp,
  directionInfluence,
  forward,
  isInvulnerable,
  length,
  normalize,
} from "./combat";
import {
  emptyInput,
  type AttackId,
  type Bomb,
  type BufferedAction,
  type BufferedInput,
  type DrawReason,
  type EffectKind,
  type Fighter,
  type GameState,
  type MatchMode,
  type PlayerInput,
  type PlayerInputs,
  type Vec2,
} from "./types";

export {
  attackContains,
  attacksClash,
  canStandAt,
  directionInfluence,
  isInvulnerable,
} from "./combat";

/**
 * Seconds before time-up: under the standard rule the base clock plus extra time for every life
 * beyond the first; under the short rule a flat `SHORT_TIME_LIMIT`.
 */
export function matchTimeLimit(stocks: number, time: TimeRule = "standard"): number {
  return timeLimitFor(stocks, time);
}

/**
 * Where the title screen lines the fighters up, as [screen right, away from the camera] on the
 * floor: slot order from left to right, in a shallow zigzag so nobody hides a neighbour.
 */
const SHOWCASE_SPOTS: Readonly<Record<number, readonly (readonly [number, number])[]>> = {
  2: [
    [-2.8, 2.1],
    [2.8, -2.1],
  ],
  4: [
    [-6, 2],
    [-2, -1],
    [2, 1],
    [6, -2],
  ],
};

function makeFighter(id: number, count: number, options: MatchOptions): Fighter {
  // Player numbers follow slot order: the first human slot is P1.
  const player = humanSlots(options, count).findIndex((slot) => slot.id === id) + 1;
  // The slot's look. Nothing below this block reads it: every animal plays exactly alike.
  const loadout = loadoutFor(options, id);
  const spawn = spawnPoints(options.stage, count)[id]!;
  return {
    name: CHARACTERS[loadout.species].name,
    species: loadout.species,
    color: PALETTES[loadout.palette].color,
    palette: loadout.palette,
    accessory: loadout.accessory,
    id,
    human: player > 0,
    player: player > 0 ? player : null,
    x: spawn.x,
    z: spawn.z,
    y: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    facing: spawn.facing,
    grounded: true,
    mode: "idle",
    modeTime: 0,
    modeDuration: 0,
    attack: null,
    charge: 0,
    damage: 0,
    stamina: 100,
    staminaDelay: 0,
    hitstop: 0,
    invulnerable: 0,
    outsideTime: 0,
    airRisingUsed: false,
    airThrustUsed: false,
    airStepUsed: false,
    stocks: options.stocks,
    respawnTimer: 0,
    aiLevel: levelFor(options, id),
    stepDirection: { x: 0, z: 0 },
    stepDelay: 0,
    hitTargets: [],
    swingId: 0,
    grabbedId: null,
    grabbedBy: null,
    throwDirection: { x: 0, z: 0 },
    tumbling: false,
    pendingLaunch: null,
    diInput: { x: 0, z: 0 },
    lastAttacker: null,
    lastHitAt: 0,
    kills: 0,
    eliminatedAt: null,
    eliminationReason: null,
    aiThink: 0,
    aiCharge: 0,
    aiIntent: { x: 0, z: 0 },
    inputBuffer: null,
  };
}

/**
 * The presses in `input` the buffer can hold, highest priority first. When several land on the
 * same tick and none can be done, only the first is kept: a dodge, then a grab, an attack, a jump.
 */
function pressedActions(input: PlayerInput): { action: BufferedAction; attack: AttackId | null }[] {
  const pressed: { action: BufferedAction; attack: AttackId | null }[] = [];
  if (input.step) pressed.push({ action: "step", attack: null });
  if (input.grab) pressed.push({ action: "grab", attack: null });
  if (input.attackPressed) pressed.push({ action: "attack", attack: input.attackPressed });
  if (input.jump) pressed.push({ action: "jump", attack: null });
  return pressed;
}

export class BattleEngine {
  state: GameState;
  private randomState: number;
  private effectId = 0;
  private bombId = 0;
  private nextBomb = RULES.bombStart as number;
  private inputs = new Map<number, PlayerInput>();
  private timeRemainder = 0;
  /** Each human's input, with button presses held until a simulation tick has consumed them. */
  private pending = new Map<number, PlayerInput>();
  private options: MatchOptions = sanitizeMatchOptions(DEFAULT_MATCH_OPTIONS);
  private matchStats: MatchStats;
  /** Explicit stage constraint override when passed to `start`; null derives from `options.stage`. */
  private stageOverride: StageInfo | null = null;

  constructor(seed = 20261121) {
    this.randomState = seed >>> 0;
    this.state = this.createState("duel", seed);
    this.matchStats = new MatchStats(this.state.playerStats);
    this.state.phase = "menu";
  }

  private random(): number {
    this.randomState = (Math.imul(1664525, this.randomState) + 1013904223) >>> 0;
    return this.randomState / 4294967296;
  }

  private createState(mode: MatchMode, seed: number, set: SetMatch | null = null): GameState {
    const count = mode === "rumble" ? 4 : 2;
    return {
      phase: "countdown",
      mode,
      elapsed: 0,
      countdown: 3,
      fighters: Array.from({ length: count }, (_, i) => makeFighter(i, count, this.options)),
      arena: {
        stageId: this.options.stage,
        halfSize: STAGES[this.options.stage].halfSize,
        initialHalfSize: STAGES[this.options.stage].halfSize,
        tileSize: RULES.tileSize,
        warningRing: false,
        nextCollapse: RULES.collapseStart,
        safeZone: { x: 0, z: 0, radius: 10.8, active: false },
        wind: { x: 0, z: 0 },
        windActive: false,
      },
      bombs: [],
      effects: [],
      winnerId: null,
      drawReason: null,
      set,
      message: "",
      messageTime: 0,
      seed,
      pausedFrom: "playing",
      options: {
        ...copyMatchOptions(this.options),
        setFormat: effectiveSetFormat(mode, this.options.setFormat),
      },
      rules: effectiveRules(
        this.options,
        mode,
        this.stageOverride ?? stageInfoFor(this.options.stage),
      ),
      playerStats: Array.from({ length: count }, emptyPlayerStats),
      stats: { hits: 0, clashes: 0, dodges: 0, maxDamage: 0 },
    };
  }

  /**
   * Starts a match. Options (and the stage) given once are kept for later restarts until new
   * ones arrive. The stage's gimmick constraints are applied to `state.rules` before the match
   * begins and never change during it.
   */
  start(mode: MatchMode, options?: Partial<MatchOptions>, stage?: StageInfo): void {
    if (options) this.options = sanitizeMatchOptions({ ...this.options, ...options });
    if (stage !== undefined) this.stageOverride = stage;
    else if (options?.stage !== undefined) this.stageOverride = null;
    this.resetGame(mode, createSetMatch(effectiveSetFormat(mode, this.options.setFormat)));
  }

  /** A result can advance only once, and only while the set is still open. */
  nextSetGame(): boolean {
    if (this.state.phase !== "ended" || !this.state.set) return false;
    const next = advanceSet(this.state.set);
    if (!next) return false;
    this.resetGame(this.state.mode, next);
    return true;
  }

  private resetGame(mode: MatchMode, set: SetMatch | null): void {
    this.state = this.createState(mode, this.state.seed, set);
    this.matchStats = new MatchStats(this.state.playerStats);
    this.randomState = this.state.seed >>> 0;
    this.nextBomb = RULES.bombStart;
    this.effectId = 0;
    this.bombId = 0;
    this.timeRemainder = 0;
    this.inputs.clear();
    this.pending.clear();
  }

  pause(): void {
    if (this.state.phase === "playing" || this.state.phase === "countdown") {
      this.pending.clear();
      this.clearBuffers();
      this.state.pausedFrom = this.state.phase;
      this.state.phase = "paused";
    }
  }
  resume(): void {
    if (this.state.phase === "paused") this.state.phase = this.state.pausedFrom;
  }
  /**
   * The title screen: the fighters `mode` would have, in the looks and stage `options` give them.
   * Solid stages line fighters up for the camera; stages with pits or narrow bridges keep their
   * floor-guaranteed spawn points. Nothing is simulated until a match starts.
   */
  menu(mode?: MatchMode, options?: Partial<MatchOptions>): void;
  menu(options?: Partial<MatchOptions>): void;
  menu(
    modeOrOptions: MatchMode | Partial<MatchOptions> = "duel",
    maybeOptions?: Partial<MatchOptions>,
  ): void {
    const mode: MatchMode = typeof modeOrOptions === "string" ? modeOrOptions : "duel";
    const options = typeof modeOrOptions === "string" ? maybeOptions : modeOrOptions;
    this.start(mode, options);
    this.state.phase = "menu";
    this.state.set = null;
    if (STAGES[this.state.arena.stageId].solid) {
      const spots = SHOWCASE_SPOTS[this.state.fighters.length];
      this.state.fighters.forEach((f, index) => {
        const spot = spots?.[index];
        if (!spot) return;
        f.x = CAMERA_RIGHT.x * spot[0] + CAMERA_FORWARD.x * spot[1];
        f.z = CAMERA_RIGHT.z * spot[0] + CAMERA_FORWARD.z * spot[1];
      });
    }
  }

  /** Drops every buffered press (a fresh match starts with empty buffers anyway). */
  private clearBuffers(): void {
    for (const f of this.state.fighters) f.inputBuffer = null;
  }

  /**
   * Advances the match in fixed substeps, which keeps sword contacts stable across refresh rates
   * and slow frames. `input` is one input per human fighter keyed by fighter id. A bare
   * `PlayerInput` is taken as the first human's, which is all a single-player match needs.
   */
  update(dt: number, input: PlayerInput | PlayerInputs = emptyInput()): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    if (
      this.state.phase === "paused" ||
      this.state.phase === "menu" ||
      this.state.phase === "ended"
    ) {
      this.pending.clear();
      this.timeRemainder = 0;
      return;
    }
    const humans = this.state.fighters.filter((f) => f.human);
    const given: PlayerInputs =
      "move" in input ? (humans[0] ? { [humans[0].id]: input as PlayerInput } : {}) : input;
    for (const f of humans) {
      const now = given[f.id] ?? emptyInput();
      const held = this.pending.get(f.id) ?? emptyInput();
      this.pending.set(f.id, {
        ...now,
        attackPressed: now.attackPressed ?? held.attackPressed,
        jump: now.jump || held.jump,
        step: now.step || held.step,
        cancel: now.cancel || held.cancel,
        grab: now.grab || held.grab,
      });
    }
    this.timeRemainder += Math.min(dt, 0.1);
    while (this.timeRemainder >= RULES.fixedStep - 1e-8) {
      this.tick(RULES.fixedStep, this.pending);
      for (const f of humans) {
        this.pending.set(f.id, {
          ...(given[f.id] ?? emptyInput()),
          attackPressed: null,
          jump: false,
          step: false,
          cancel: false,
          grab: false,
        });
      }
      this.timeRemainder -= RULES.fixedStep;
    }
  }

  private tick(dt: number, playerInputs: ReadonlyMap<number, PlayerInput>): void {
    const state = this.state;
    if (state.phase === "paused" || state.phase === "ended" || state.phase === "menu") return;
    if (state.phase === "countdown") {
      state.countdown = Math.max(0, state.countdown - dt);
      if (state.countdown <= 0) {
        state.phase = "playing";
        // The practice partner stands still unless a second player has taken it.
        const stillPartner = state.fighters.some((f) => !f.human);
        this.announce(
          state.mode !== "training"
            ? "FIGHT"
            : stillPartner
              ? "練習開始 — 相手は動きません"
              : "練習開始",
        );
      }
      return;
    }

    state.elapsed += dt;
    state.messageTime = Math.max(0, state.messageTime - dt);
    state.effects = state.effects.filter((effect) => (effect.life -= dt) > 0);
    this.updateArena(dt);
    this.updateRespawns(dt);
    this.inputs.clear();
    for (const f of state.fighters) {
      if ((f.mode as Fighter["mode"]) === "dead") continue;
      this.inputs.set(f.id, f.human ? (playerInputs.get(f.id) ?? emptyInput()) : this.ai(f, dt));
    }
    for (const f of state.fighters) {
      if ((f.mode as Fighter["mode"]) === "dead") continue;
      const input = this.inputs.get(f.id)!;
      f.diInput = { ...input.move };
      this.updateZone(f, dt);
      if ((f.mode as Fighter["mode"]) === "dead") continue;
      f.invulnerable = Math.max(0, f.invulnerable - dt);
      // The buffer ages every tick, hitstop included, so a press never outlives its window.
      this.ageBuffer(f);
      if (f.hitstop > 0) {
        f.hitstop = Math.max(0, f.hitstop - dt);
        if (f.hitstop > 0) {
          if (f.human) this.holdPress(f, input);
          continue;
        }
        this.applyLaunch(f);
      }
      f.staminaDelay = Math.max(0, f.staminaDelay - dt);
      if (f.staminaDelay <= 0 && (f.mode === "idle" || f.mode === "hitstun")) {
        f.stamina = Math.min(RULES.maxStamina, f.stamina + RULES.staminaRegen * dt);
      }
      this.updateMode(f, input, dt);
      if (f.mode === "dead") continue;
      if (!f.human && state.mode !== "training" && cpuTechOpportunity(state, f, dt)) {
        input.step = this.random() < UKEMI.cpuChance[f.aiLevel];
        if (input.step) this.holdPress(f, input);
      }
      this.handleInput(f, f.human ? this.bufferedInput(f, input) : input, dt);
      this.physics(f, input, dt);
    }
    this.separateBodies();
    this.resolveCombat();
    this.updateBombs(dt);
    this.resolveOutcome();
  }

  private setMode(f: Fighter, mode: Fighter["mode"], duration = 0): void {
    f.tumbling = false;
    f.mode = mode;
    f.modeTime = 0;
    f.modeDuration = duration;
  }

  private spend(f: Fighter, cost: number): boolean {
    if (f.stamina + 1e-6 < cost) {
      // A shared centre message cannot say whose stamina ran out, so only a lone human gets it.
      if (f.human && this.state.fighters.filter((o) => o.human).length === 1)
        this.announce("スタミナ不足 — 歩いて間合いを取り直そう", 0.8);
      return false;
    }
    f.stamina = Math.max(0, f.stamina - cost);
    f.staminaDelay = RULES.staminaDelay;
    return true;
  }

  /** How fast a fighter may turn toward its aim right now (rad/s); 0 once the blade is cutting. */
  private turnRate(f: Fighter): number {
    if (f.mode === "idle") return RULES.idleTurnRate;
    if (f.mode === "charge") return RULES.chargeTurnRate;
    if (f.mode === "windup")
      return RULES.windupTurnRate * (f.human ? 1 : AI_LEVELS[f.aiLevel].tracking);
    return 0;
  }

  /** A dodge works on the ground, and once per airtime in the air. */
  private canStep(f: Fighter): boolean {
    return f.grounded || !f.airStepUsed;
  }

  /**
   * May this press be tried on this tick, or must it wait in the buffer? It waits only while the
   * fighter is locked out (any mode that ignores it: recovery, cancel lag, a step, clash, hitstun,
   * grab and throw; hitstop never reaches here) and, for a jump or a grab, while airborne. Once it
   * may be tried it is tried exactly once, through the ordinary checks: an unaffordable move, or an
   * air attack or air dodge already spent this airtime, is refused (spending nothing) and gone,
   * never carried on to the landing.
   */
  private canTry(f: Fighter, action: BufferedAction): boolean {
    switch (action) {
      case "step":
        return f.mode === "idle" || f.mode === "charge";
      case "jump":
      case "grab":
        return f.mode === "idle" && f.grounded;
      case "attack":
        return f.mode === "idle";
    }
  }

  private hasArmedTech(f: Fighter): boolean {
    return (
      (f.tumbling || f.pendingLaunch !== null) &&
      f.inputBuffer?.pressedIn === "hitstun" &&
      f.inputBuffer.action === "step"
    );
  }

  /**
   * One fixed tick older. Launched step presses use the tech window; other presses use six ticks. A jump or
   * grab freed by a landing gets one tick more (`landingGrace`, see `graceLanding`).
   */
  private ageBuffer(f: Fighter): void {
    if (!f.inputBuffer) return;
    f.inputBuffer.age++;
    const limit = this.hasArmedTech(f)
      ? UKEMI.windowTicks
      : INPUT_BUFFER_TICKS + (f.inputBuffer.landingGrace ? 1 : 0);
    if (f.inputBuffer.age > limit) f.inputBuffer = null;
  }

  /**
   * Called on the tick `physics` lands `f`. Input runs before physics, so a jump or grab freed by
   * this landing is first tried on the next tick, one tick later than a press freed by recovery
   * ending (which `updateMode` does before input). The grace lets a press made up to
   * `INPUT_BUFFER_TICKS` ticks before the landing tick still fire, and no older one. It applies
   * only when the landing is what frees the press: an idle fighter waiting on a jump or grab.
   */
  private graceLanding(f: Fighter): void {
    const held = f.inputBuffer;
    if (held && f.mode === "idle" && (held.action === "jump" || held.action === "grab"))
      held.landingGrace = true;
  }

  /**
   * Drops a press made before an interruption (a hit, being grabbed, a clash or an explicit cancel)
   * so it cannot fire out of the new lockout; presses made during that lockout buffer as usual.
   */
  private interruptBuffer(f: Fighter): void {
    f.inputBuffer = null;
  }

  /** Only a fresh step can replace an armed tech during hitstun. */
  private holdPress(f: Fighter, input: PlayerInput): void {
    const [press] = pressedActions(input);
    if (!press || (press.action !== "step" && this.hasArmedTech(f))) return;
    f.inputBuffer = { ...press, age: 0, pressedIn: f.mode, landingGrace: false };
  }

  /** Removes and returns the buffered press if it is `action` (any action when omitted). */
  private takeBuffered(f: Fighter, action?: BufferedAction): BufferedInput | null {
    const held = f.inputBuffer;
    if (!held || (action && held.action !== action)) return null;
    f.inputBuffer = null;
    return held;
  }

  /**
   * The input `handleInput` should see this tick, after the buffer has had its say:
   * - If anything pressed this tick may be tried (`canTry`), the tick's
   *   input runs exactly as it always did and the buffer is emptied. Otherwise holdPress decides
   *   whether to replace the buffer.
   * - With no fresh press, a buffered press that may now be tried is replayed once, as if pressed
   *   now: direction and aim come from this tick's stick, and an attack whose button is already
   *   up is a tap (it commits on the next tick) while one still held charges as usual.
   * `cancel` is never buffered and never replayed, so it cannot reach the next attack.
   */
  private bufferedInput(f: Fighter, input: PlayerInput): PlayerInput {
    const pressed = pressedActions(input);
    if (pressed.length > 0) {
      if (pressed.some((p) => this.canTry(f, p.action))) f.inputBuffer = null;
      else this.holdPress(f, input);
      return input;
    }
    const held = f.inputBuffer;
    if (!held || !this.canTry(f, held.action)) return input;
    this.takeBuffered(f);
    switch (held.action) {
      case "attack":
        return { ...input, attackPressed: held.attack };
      case "step":
        return { ...input, step: true };
      case "jump":
        return { ...input, jump: true };
      case "grab":
        return { ...input, grab: true };
    }
  }

  private handleInput(f: Fighter, input: PlayerInput, dt: number): void {
    const turnRate = this.turnRate(f);
    if (turnRate > 0 && !input.step) {
      const aim = input.aim && length(input.aim) > 0.05 ? input.aim : input.move;
      if (length(aim) > 0.05) {
        const target = Math.atan2(aim.x, aim.z);
        f.facing += clamp(angleDelta(f.facing, target), -dt * turnRate, dt * turnRate);
      }
    }
    if (f.mode === "charge") {
      if (input.step && this.canStep(f) && this.spend(f, RULES.stepCost)) {
        this.startStep(f, input.move, true);
      } else if (input.cancel) {
        this.setMode(f, "cancel", RULES.cancelDuration);
        this.interruptBuffer(f);
        f.attack = null;
        f.charge = 0;
        f.staminaDelay = RULES.staminaDelay;
        this.effect("cancel", f, 0xbbe4dc, 0.28);
      } else if (input.attackHeld !== f.attack || f.modeTime >= RULES.maxHold) {
        this.commitAttack(f);
      }
      return;
    }
    if (f.mode === "windup") {
      if (input.cancel) this.cancelWindup(f);
      return;
    }
    if (f.mode !== "idle") return;
    if (input.step && this.canStep(f) && this.spend(f, RULES.stepCost)) {
      this.startStep(f, input.move, false);
      return;
    }
    if (input.jump && f.grounded) {
      f.grounded = false;
      f.vy = RULES.jumpSpeed;
      this.effect("jump", f, 0xd2f2e5, 0.4);
    }
    if (input.grab && f.grounded && this.spend(f, RULES.grabCost)) {
      this.setMode(f, "grab", RULES.grabStartup + RULES.grabActive);
      f.hitTargets = [];
      f.attack = null;
      return;
    }
    if (input.attackPressed) this.startCharge(f, input.attackPressed);
  }

  private startCharge(f: Fighter, attack: AttackId): void {
    if (
      !f.grounded &&
      ((attack === "rising" && f.airRisingUsed) || (attack === "thrust" && f.airThrustUsed))
    )
      return;
    if (f.stamina < ATTACKS[attack].stamina || !this.spend(f, RULES.chargeCost)) return;
    f.attack = attack;
    f.charge = 0;
    this.setMode(f, "charge", RULES.maxHold);
  }

  private commitAttack(f: Fighter): void {
    if (!f.attack) return;
    if (!this.spend(f, ATTACKS[f.attack].stamina - RULES.chargeCost)) {
      this.setMode(f, "cancel", RULES.cancelDuration);
      f.attack = null;
      return;
    }
    if (f.attack === "rising") f.airRisingUsed = true;
    if (f.attack === "thrust" && !f.grounded) f.airThrustUsed = true;
    this.setMode(f, "windup", ATTACKS[f.attack].startup);
    f.hitTargets = [];
    f.swingId++;
  }

  private cancelWindup(f: Fighter): void {
    const progress = clamp(f.modeTime / f.modeDuration, 0, 1);
    this.setMode(f, "cancel", RULES.cancelDuration + RULES.windupCancelPenalty * progress);
    this.interruptBuffer(f);
    f.attack = null;
    f.charge = 0;
    f.staminaDelay = RULES.staminaDelay;
    // A cancelled grounded cut never leaves the floor, so no landing would clear its air use.
    if (f.grounded) {
      f.airRisingUsed = false;
      f.airThrustUsed = false;
    }
    this.effect("cancel", f, 0xbbe4dc, 0.28);
  }

  private startStep(f: Fighter, direction: Vec2, feint: boolean): void {
    this.setMode(f, "step", RULES.stepDuration);
    const dir = length(direction) > 0.05 ? normalize(direction) : forward(f);
    f.stepDirection = dir;
    f.stepDelay = feint ? RULES.feintStepDelay : 0;
    f.attack = null;
    f.charge = 0;
    if (!f.grounded) {
      f.airStepUsed = true;
      if (f.stepDelay <= 0) this.beginAirStep(f);
    }
    this.effect("step", f, f.color, 0.32);
    if (f.human) this.state.stats.dodges++;
  }

  /** The dash of an air dodge starts: it floats instead of dropping (see `isAirStepping`). */
  private beginAirStep(f: Fighter): void {
    f.vy = Math.max(f.vy, RULES.airStepHover);
  }

  /** An air dodge's dash is running; a grounded step that runs off the edge falls normally. */
  private isAirStepping(f: Fighter): boolean {
    return f.mode === "step" && f.stepDelay <= 0 && f.airStepUsed && !f.grounded;
  }

  /**
   * The air dodge holds a fighter up, it does not carry one higher: while still rising faster than
   * the hover speed (a dodge right after a jump or a rising slash) gravity pulls at full strength.
   */
  private gravityScale(f: Fighter): number {
    return this.isAirStepping(f) && f.vy <= RULES.airStepHover ? RULES.airStepGravity : 1;
  }

  private updateMode(f: Fighter, input: PlayerInput, dt: number): void {
    if (f.mode === "step" && f.stepDelay > 0) {
      f.stepDelay = Math.max(0, f.stepDelay - dt);
      if (f.stepDelay <= 0 && f.airStepUsed && !f.grounded) this.beginAirStep(f);
      return;
    }
    f.modeTime += dt;
    if (f.mode === "charge") {
      f.charge = clamp(f.modeTime / RULES.maxCharge, 0, 1);
      return;
    }
    if (f.mode === "throw") {
      if (length(input.move) > 0.1) f.throwDirection = normalize(input.move);
      if (f.modeTime >= RULES.grabHold) this.throwVictim(f);
      return;
    }
    if (f.mode === "grabbed" || f.mode === "idle") return;
    if (f.modeTime + 1e-7 < f.modeDuration) return;
    if (f.mode === "windup" && f.attack) {
      const attack = ATTACKS[f.attack];
      this.setMode(f, "active", attack.active);
      this.matchStats.beginSwing(f);
      const dir = forward(f);
      if (f.attack === "rising") {
        f.grounded = false;
        f.vy = 12;
        f.vx = dir.x * 3.7;
        f.vz = dir.z * 3.7;
        f.airRisingUsed = true;
      } else if (f.attack === "thrust") {
        f.vx = dir.x * attack.lunge;
        f.vz = dir.z * attack.lunge;
        if (!f.grounded) {
          f.airThrustUsed = true;
          f.vy = Math.max(f.vy, 1.8);
        }
      }
      return;
    }
    if (f.mode === "active" && f.attack) {
      this.setMode(f, "recovery", ATTACKS[f.attack].recovery);
    } else if (f.mode === "grab") {
      this.setMode(f, "recovery", RULES.grabRecovery);
    } else {
      if (f.tumbling) this.takeBuffered(f, "step");
      this.setMode(f, "idle");
      f.attack = null;
      f.charge = 0;
    }
  }

  private physics(f: Fighter, input: PlayerInput, dt: number): void {
    if (f.mode === "grabbed") {
      const captor = this.state.fighters.find((other) => other.id === f.grabbedBy);
      if (captor && captor.mode === "throw") {
        const dir = forward(captor);
        f.x = captor.x + dir.x * 0.8;
        f.z = captor.z + dir.z * 0.8;
        f.y = captor.y + 0.3;
        f.vx = f.vy = f.vz = 0;
        f.grounded = false;
        return;
      }
      f.grabbedBy = null;
      this.setMode(f, "hitstun", 0.15);
    }
    // A collapsing tile can disappear before the roll moves, even with wind blowing inland.
    if ((f.mode === "ukemi" || f.mode === "knockdown") && !canStandAt(this.state, f.x, f.z))
      f.grounded = false;
    const previousY = f.y;
    const movement = normalize(input.move);
    let speed = 0;
    if (f.mode === "idle") speed = f.grounded ? RULES.moveSpeed : RULES.airSpeed;
    else if (f.mode === "charge") speed = f.grounded ? 1.35 : 0.9;
    else if (f.mode === "recovery" && !f.grounded) speed = RULES.airSpeed * 0.65;
    f.x += (f.vx + movement.x * speed) * dt;
    f.z += (f.vz + movement.z * speed) * dt;
    if (f.mode === "step" && f.stepDelay <= 0) {
      const ease = 1 - 0.35 * (f.modeTime / RULES.stepDuration);
      f.x += f.stepDirection.x * RULES.stepSpeed * ease * dt;
      f.z += f.stepDirection.z * RULES.stepSpeed * ease * dt;
    }
    if (f.mode === "ukemi") advanceRoll(this.state, f, dt);
    if (this.state.arena.windActive && f.grounded && f.mode !== "throw") {
      f.x += this.state.arena.wind.x * dt;
      f.z += this.state.arena.wind.z * dt;
    }
    // A running belt carries whoever stands on it, player or CPU, whatever they are doing. In the
    // air it has no hold, and a paused or finished match never gets here.
    if (f.grounded && hasConveyors(this.state.arena.stageId)) {
      const belt = this.beltAt(f.x, f.z);
      f.x += belt.x * dt;
      f.z += belt.z * dt;
    }
    f.vx *= Math.exp(-dt * (f.grounded ? 6 : 1.9));
    f.vz *= Math.exp(-dt * (f.grounded ? 6 : 1.9));
    if (f.grounded && !canStandAt(this.state, f.x, f.z)) {
      f.grounded = false;
      if (f.attack === "thrust" && (f.mode === "active" || f.mode === "recovery"))
        f.airThrustUsed = true;
    }
    if (!f.grounded) {
      f.vy -= RULES.gravity * this.gravityScale(f) * dt;
      f.y += f.vy * dt;
      if (
        previousY >= (f.tumbling ? 0 : -0.08) &&
        f.y <= 0 &&
        f.vy <= 0 &&
        canStandAt(this.state, f.x, f.z)
      ) {
        this.land(f, input.move);
      }
    } else {
      f.y = 0;
      f.vy = 0;
    }
    if (f.y < -9 || Math.hypot(f.x, f.z) > 26) this.eliminate(f, "場外に落下");
  }

  /** Ground contact owns both the ordinary air-action reset and the single landing decision. */
  private land(f: Fighter, move: Vec2): void {
    f.y = f.vy = 0;
    f.grounded = true;
    f.airRisingUsed = f.airThrustUsed = f.airStepUsed = false;
    if (!f.tumbling) {
      this.graceLanding(f);
      this.effect("land", f, 0xbed9cc, 0.3);
      return;
    }
    const tech = this.hasArmedTech(f);
    this.interruptBuffer(f);
    f.vx = f.vz = 0;
    if (tech) {
      f.stepDirection = rollDirection(move);
      this.setMode(f, "ukemi", UKEMI.duration);
      this.effect("ukemi", f, 0x008eac, UKEMI.duration, 1.35);
    } else {
      this.setMode(f, "knockdown", UKEMI.knockdownDuration);
      this.effect("land", f, 0xbed9cc, 0.35, 1.3);
    }
  }

  private separateBodies(): void {
    const alive = this.state.fighters.filter(
      (f) => f.mode !== "dead" && f.mode !== "grabbed" && f.mode !== "throw" && f.hitstop <= 0,
    );
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i],
          b = alive[j];
        if (Math.abs(a.y - b.y) > 1.2 || a.mode === "step" || b.mode === "step") continue;
        const dx = b.x - a.x,
          dz = b.z - a.z,
          distance = Math.hypot(dx, dz);
        const overlap = RULES.fighterRadius * 2 - distance;
        if (overlap <= 0) continue;
        const nx = distance > 0.001 ? dx / distance : 1,
          nz = distance > 0.001 ? dz / distance : 0;
        a.x -= (nx * overlap) / 2;
        a.z -= (nz * overlap) / 2;
        b.x += (nx * overlap) / 2;
        b.z += (nz * overlap) / 2;
      }
    }
  }

  private resolveCombat(): void {
    const fighters = this.state.fighters.filter((f) => f.mode !== "dead");
    const active = fighters.filter((f) => f.mode === "active" && f.hitstop <= 0);
    const clashed = new Set<number>();
    const clashPairs: [Fighter, Fighter][] = [];
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        if (attacksClash(active[i], active[j])) {
          clashed.add(active[i].id);
          clashed.add(active[j].id);
          clashPairs.push([active[i], active[j]]);
        }
      }
    }
    for (const [a, b] of clashPairs) {
      this.effect(
        "clash",
        { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + 1.1, z: (a.z + b.z) / 2 },
        0xffe3a0,
        0.5,
        1.2,
      );
      this.state.stats.clashes++;
    }
    for (const f of active) {
      if (!clashed.has(f.id)) continue;
      this.setMode(f, "clash", 0.28);
      this.interruptBuffer(f);
      f.hitstop = RULES.clashHitstop;
      const dir = forward(f);
      f.vx = -dir.x * 2.8;
      f.vz = -dir.z * 2.8;
    }
    // Snapshot contacts before applying damage so simultaneous non-clashing hits trade.
    const hits: {
      attacker: Fighter;
      target: Fighter;
      attack: AttackId;
      charge: number;
      airborne: boolean;
      direction: Vec2;
    }[] = [];
    for (const attacker of active) {
      if (clashed.has(attacker.id) || !attacker.attack) continue;
      for (const target of fighters) {
        if (
          target.id === attacker.id ||
          attacker.hitTargets.includes(target.id) ||
          target.mode === "grabbed"
        )
          continue;
        if (attackContains(attacker, target)) {
          if (isInvulnerable(target)) {
            if (target.mode === "step") this.matchStats.dodgeSword(target, attacker);
            continue;
          }
          hits.push({
            attacker,
            target,
            attack: attacker.attack,
            charge: attacker.charge,
            airborne: !attacker.grounded,
            direction: forward(attacker),
          });
          attacker.hitTargets.push(target.id);
        }
      }
    }
    // Stable order prevents array traversal from deciding multi-attacker knockback.
    hits.sort((a, b) => a.target.id - b.target.id || a.attacker.id - b.attacker.id);
    for (const hit of hits) {
      const { attacker, target, attack, charge, airborne, direction } = hit;
      const definition = ATTACKS[attack];
      const multiplier = 1 + charge * 0.65;
      this.matchStats.swordHit(attacker, target, definition.damage * multiplier);
      const force =
        (definition.knockback + target.damage * definition.growth) * (1 + charge * 0.25);
      const meteor = attack === "overhead" && airborne && !target.grounded;
      const lift = meteor ? -(9 + target.damage * 0.04) : definition.lift + target.damage * 0.022;
      this.receiveHit(
        target,
        attacker.id,
        { x: direction.x * force, y: lift, z: direction.z * force },
        clamp(0.22 + force * 0.022, 0.3, 0.72),
        RULES.hitstop + charge * 0.025,
      );
      attacker.hitstop = Math.max(attacker.hitstop, RULES.hitstop + charge * 0.025);
      this.effect(
        "hit",
        { x: target.x, y: target.y + 1, z: target.z },
        charge > 0.8 ? 0xffd38d : 0xfff5d2,
        0.32,
        0.7 + charge * 0.6,
      );
      this.state.stats.hits++;
      this.state.stats.maxDamage = Math.max(this.state.stats.maxDamage, target.damage);
      if (meteor) this.announce("METEOR", 0.7);
    }
    for (const grabber of fighters) {
      if (
        grabber.mode !== "grab" ||
        grabber.modeTime < RULES.grabStartup ||
        grabber.modeTime >= RULES.grabStartup + RULES.grabActive ||
        grabber.hitstop > 0
      )
        continue;
      const dir = forward(grabber);
      const target = fighters
        .filter(
          (f) =>
            f.id !== grabber.id &&
            f.grounded &&
            f.mode !== "grabbed" &&
            f.mode !== "throw" &&
            !isInvulnerable(f),
        )
        .filter((f) => {
          const dx = f.x - grabber.x,
            dz = f.z - grabber.z;
          return (
            Math.hypot(dx, dz) < RULES.grabReach &&
            dx * dir.x + dz * dir.z > 0.2 &&
            Math.abs(dx * dir.z - dz * dir.x) < 0.6
          );
        })
        .sort(
          (a, b) =>
            Math.hypot(a.x - grabber.x, a.z - grabber.z) -
            Math.hypot(b.x - grabber.x, b.z - grabber.z),
        )[0];
      if (!target) continue;
      this.breakGrab(target);
      grabber.grabbedId = target.id;
      grabber.throwDirection = dir;
      this.setMode(grabber, "throw", RULES.grabHold);
      target.grabbedBy = grabber.id;
      target.pendingLaunch = null;
      target.attack = null;
      this.setMode(target, "grabbed", RULES.grabHold);
      this.interruptBuffer(target);
    }
  }

  private receiveHit(
    f: Fighter,
    attackerId: number | null,
    impulse: { x: number; y: number; z: number },
    duration: number,
    stop: number = RULES.hitstop,
  ): void {
    this.breakGrab(f);
    this.matchStats.recordLaunch(f, attackerId, this.state.elapsed);
    f.attack = null;
    f.charge = 0;
    this.setMode(f, "hitstun", duration);
    this.interruptBuffer(f);
    // Multiple simultaneous impacts combine without removing the previous contact.
    if (f.pendingLaunch) {
      f.pendingLaunch.x += impulse.x * 0.55;
      f.pendingLaunch.z += impulse.z * 0.55;
      f.pendingLaunch.y =
        Math.abs(impulse.y) > Math.abs(f.pendingLaunch.y) ? impulse.y : f.pendingLaunch.y;
    } else f.pendingLaunch = { ...impulse };
    f.hitstop = Math.max(f.hitstop, stop);
    if (stop <= 0) this.applyLaunch(f);
  }

  private applyLaunch(f: Fighter): void {
    if (!f.pendingLaunch) return;
    const launch = directionInfluence(f.pendingLaunch, f.diInput);
    f.vx = launch.x;
    f.vy = launch.y;
    f.vz = launch.z;
    // Lift the grounded capsule slightly so a launch is not treated as an old landing.
    if (f.grounded) f.y = Math.max(f.y, 0.04);
    f.grounded = false;
    f.pendingLaunch = null;
    f.tumbling = true;
  }

  private breakGrab(f: Fighter): void {
    if (f.grabbedId !== null) {
      const victim = this.state.fighters.find((other) => other.id === f.grabbedId);
      if (victim && victim.mode === "grabbed") {
        victim.grabbedBy = null;
        this.setMode(victim, "hitstun", 0.15);
      }
      f.grabbedId = null;
    }
    if (f.grabbedBy !== null) {
      const captor = this.state.fighters.find((other) => other.id === f.grabbedBy);
      if (captor && captor.mode === "throw") {
        captor.grabbedId = null;
        this.setMode(captor, "recovery", 0.35);
      }
      f.grabbedBy = null;
    }
  }

  private throwVictim(f: Fighter): void {
    const target = this.state.fighters.find((other) => other.id === f.grabbedId);
    f.grabbedId = null;
    this.setMode(f, "recovery", 0.4);
    if (!target || target.mode === "dead") return;
    target.grabbedBy = null;
    this.matchStats.damage(target, 6, f.id);
    const force = 7.5 + target.damage * 0.065;
    const dir = normalize(f.throwDirection);
    this.receiveHit(target, f.id, { x: dir.x * force, y: 6, z: dir.z * force }, 0.42, 0.06);
    target.invulnerable = 0.15;
    this.effect("throw", target, f.color, 0.4);
  }

  /**
   * The timed arena gimmicks, governed by both `state.rules.gimmicks` (player choices plus stage
   * constraints) and the stage's geometry (`stages.ts`): disabled gimmicks leave no trace in state,
   * collapse stops at `stage.minHalfSize`, the safe zone follows the stage's path, and bombs only
   * land on walkable floor.
   */
  private updateArena(_dt: number): void {
    const { arena, elapsed, mode, rules } = this.state;
    if (mode === "training") return;
    const { collapse, safeZone, bombs, wind } = rules.gimmicks;
    const stage = STAGES[arena.stageId];
    arena.warningRing =
      collapse &&
      arena.halfSize > stage.minHalfSize &&
      elapsed >= arena.nextCollapse - RULES.collapseWarning;
    if (collapse && elapsed >= arena.nextCollapse && arena.halfSize > stage.minHalfSize) {
      arena.halfSize = Math.max(stage.minHalfSize, arena.halfSize - RULES.tileSize);
      arena.nextCollapse += RULES.collapseInterval;
      arena.warningRing = false;
      this.announce("外周の足場が崩れた", 2);
    }
    const zone = arena.safeZone;
    zone.active = safeZone && elapsed >= RULES.safeZoneStart;
    if (zone.active) {
      const placed = safeZoneAt(arena.stageId, elapsed, arena.halfSize);
      zone.radius = placed.radius;
      zone.x = placed.x;
      zone.z = placed.z;
    }
    arena.windActive = wind && elapsed >= 24 && Math.floor(elapsed / 12) % 3 === 2;
    arena.wind = arena.windActive
      ? { x: Math.sin(elapsed * 0.1) * 0.35, z: Math.cos(elapsed * 0.1) * 0.25 }
      : { x: 0, z: 0 };
    if (bombs && elapsed >= this.nextBomb) {
      this.nextBomb += RULES.bombInterval;
      const count = this.state.mode === "rumble" ? 3 : 2;
      for (let i = 0; i < count; i++) {
        const extent = arena.halfSize - 1.2;
        // Aimed anywhere in the square, then (where the stage has pits or gaps) moved on to the
        // nearest floor: a warning circle is never wasted on thin air.
        const aim = {
          x: (this.random() * 2 - 1) * extent,
          z: (this.random() * 2 - 1) * extent,
        };
        const spot = stage.solid
          ? aim
          : nearestWalkablePoint(arena.stageId, aim.x, aim.z, arena.halfSize, 0.4);
        this.state.bombs.push({
          id: this.bombId++,
          x: spot.x,
          z: spot.z,
          radius: 1.45,
          timer: RULES.bombWarning,
          duration: RULES.bombWarning,
          exploded: false,
        });
      }
      this.announce("爆撃予告 — 赤い円から離れよう", 1.5);
    }
  }

  private updateZone(f: Fighter, dt: number): void {
    const zone = this.state.arena.safeZone;
    if (!zone.active) {
      f.outsideTime = 0;
      return;
    }
    if (Math.hypot(f.x - zone.x, f.z - zone.z) > zone.radius) {
      f.outsideTime = Math.min(RULES.outsideLimit, f.outsideTime + dt);
      this.matchStats.damage(f, RULES.outsideDamage * dt);
      if (f.outsideTime >= RULES.outsideLimit - 1e-6)
        this.eliminate(f, "エリア外ゲージが5秒に到達", true);
    } else {
      f.outsideTime = Math.max(0, f.outsideTime - RULES.outsideRecovery * dt);
    }
  }

  private updateBombs(dt: number): void {
    for (const bomb of this.state.bombs) {
      bomb.timer -= dt;
      if (bomb.timer > 0 || bomb.exploded) continue;
      bomb.exploded = true;
      this.effect("bomb", { x: bomb.x, y: 0.3, z: bomb.z }, 0xffaa71, 0.6, bomb.radius);
      for (const f of this.state.fighters) {
        if (
          f.mode === "dead" ||
          Math.hypot(f.x - bomb.x, f.z - bomb.z) > bomb.radius + 0.3 ||
          f.y > 3
        )
          continue;
        if (isInvulnerable(f)) {
          if (f.mode === "step") this.matchStats.dodgeBomb(f);
          continue;
        }
        this.matchStats.damage(f, 10);
        const dir = normalize({ x: f.x - bomb.x + 0.01, z: f.z - bomb.z });
        this.receiveHit(f, null, { x: dir.x * 4, y: 6, z: dir.z * 4 }, 0.32, 0.065);
      }
    }
    this.state.bombs = this.state.bombs.filter((bomb) => bomb.timer > -0.7);
  }

  private eliminate(f: Fighter, reason: string, environmental = false): void {
    if (f.mode === "dead") return;
    this.breakGrab(f);
    this.setMode(f, "dead");
    f.inputBuffer = null;
    f.eliminatedAt = this.state.elapsed;
    f.eliminationReason = reason;
    const spendsStock = this.state.mode !== "training";
    this.matchStats.recordFall(
      f,
      this.state.fighters,
      this.state.elapsed,
      spendsStock,
      environmental,
    );
    this.effect("ko", { x: f.x, y: Math.max(-2, f.y), z: f.z }, f.color, 1.2, 1.8);
    // Training rebuilds everyone for ever (see resolveOutcome) and keeps no lives.
    if (spendsStock) f.stocks = Math.max(0, f.stocks - 1);
    if (spendsStock && f.stocks > 0) {
      f.respawnTimer = RULES.respawnDelay;
      this.announce(`${this.title(f)} DOWN — 残り${f.stocks}`, 1.8);
    } else this.announce(this.title(f) + " OUT", 1.8);
  }

  /** Counts down downed fighters that still have lives and brings them back. */
  private updateRespawns(dt: number): void {
    for (const f of this.state.fighters) {
      if (f.mode !== "dead" || f.respawnTimer <= 0) continue;
      f.respawnTimer = Math.max(0, f.respawnTimer - dt);
      if (f.respawnTimer <= 1e-9) this.respawn(f);
    }
  }

  /** A clean new life, dropped in over the safest nearby spot, briefly invulnerable. */
  private respawn(f: Fighter): void {
    const spot = this.respawnPoint(f);
    const opponents = this.state.fighters.filter((o) => o.id !== f.id && o.mode !== "dead");
    const nearest = opponents.sort(
      (a, b) => Math.hypot(a.x - spot.x, a.z - spot.z) - Math.hypot(b.x - spot.x, b.z - spot.z),
    )[0];
    const look = nearest ?? { x: 0, z: 0 };
    const fresh = makeFighter(f.id, this.state.fighters.length, this.options);
    Object.assign(f, fresh, {
      human: f.human,
      player: f.player,
      kills: f.kills,
      aiLevel: f.aiLevel,
      stocks: f.stocks,
      // Keeps counting so a renderer or audio cue never mistakes the next swing for an old one.
      swingId: f.swingId,
      x: spot.x,
      z: spot.z,
      y: RULES.respawnHeight,
      grounded: false,
      facing:
        Math.hypot(look.x - spot.x, look.z - spot.z) > 0.01
          ? Math.atan2(look.x - spot.x, look.z - spot.z)
          : fresh.facing,
      invulnerable: RULES.respawnInvulnerable,
    } satisfies Partial<Fighter>);
  }

  /**
   * Inside the safe zone when it is active, else near the middle of the stage; always over floor
   * with a margin, never over a pit or a gap (`respawnCandidates` in stages.ts). Fixed candidates
   * (no RNG): the one farthest from living opponents that is clear of pending bombs.
   */
  private respawnPoint(f: Fighter): Vec2 {
    const { safeZone: zone, halfSize, stageId } = this.state.arena;
    const onFloor = respawnCandidates(stageId, halfSize, zone.active ? zone : null);
    const clear = onFloor.filter(
      (p) =>
        !this.state.bombs.some(
          (b) => !b.exploded && Math.hypot(p.x - b.x, p.z - b.z) <= b.radius + 0.3,
        ),
    );
    const opponents = this.state.fighters.filter((o) => o.id !== f.id && o.mode !== "dead");
    const room = (p: Vec2) =>
      Math.min(...opponents.map((o) => Math.hypot(o.x - p.x, o.z - p.z)), Infinity);
    let best = (clear.length > 0 ? clear : onFloor)[0];
    for (const p of clear) if (room(p) > room(best) + 1e-9) best = p;
    return best;
  }

  private resolveOutcome(): void {
    const state = this.state;
    if (state.mode === "training") {
      for (let i = 0; i < state.fighters.length; i++) {
        const f = state.fighters[i];
        if (f.mode === "dead" && state.elapsed - (f.eliminatedAt ?? 0) > 1.5) {
          state.fighters[i] = makeFighter(f.id, 2, this.options);
        }
      }
      return;
    }
    // Still in the match: alive, or down with a life left to come back on.
    const contenders = state.fighters.filter((f) => f.stocks > 0);
    if (contenders.length <= 1) {
      const survivor = contenders[0];
      this.finishGame(
        survivor?.id ?? null,
        survivor ? this.title(survivor) + " WINS" : "DRAW",
        survivor ? null : "allOut",
      );
    } else if (state.elapsed >= (state.rules.timeLimit ?? Infinity)) {
      // A fighter waiting to respawn already lost the damage it carried with that life.
      const damage = (f: Fighter) => (f.mode === "dead" ? 0 : f.damage);
      const sorted = [...contenders].sort((a, b) => b.stocks - a.stocks || damage(a) - damage(b));
      const [first, second] = sorted;
      const tied =
        first.stocks === second.stocks && Math.abs(damage(first) - damage(second)) < 0.01;
      this.finishGame(
        tied ? null : first.id,
        state.options.stocks > 1
          ? "TIME UP — 残機の多い選手、同数なら蓄積ダメージの少ない選手が勝利"
          : "TIME UP — 蓄積ダメージの少ない選手が勝利",
        tied ? "timeUp" : null,
      );
    }
  }

  private finishGame(
    winnerId: number | null,
    message: string,
    drawReason: DrawReason | null,
  ): void {
    const state = this.state;
    state.winnerId = winnerId;
    state.drawReason = drawReason;
    state.phase = "ended";
    if (state.set) state.set = finishSetGame(state.set, winnerId, state.playerStats);
    this.clearBuffers();
    this.announce(message, 10);
  }

  private ai(f: Fighter, dt: number): PlayerInput {
    const input = emptyInput();
    if (this.state.mode === "training") return input;
    const level = AI_LEVELS[f.aiLevel];
    const enemies = this.state.fighters.filter(
      (other) => other.id !== f.id && other.mode !== "dead",
    );
    const enemy = enemies.sort(
      (a, b) => Math.hypot(a.x - f.x, a.z - f.z) - Math.hypot(b.x - f.x, b.z - f.z),
    )[0];
    // A stage with pits or bridges (`gaps`) is walked along its floor (navigation.ts) and every
    // move is checked for a drop first. One with gaps or belts (`careful`) also plans its footing:
    // no lunge, dodge or ride that ends in a fall. The plain square of the garden needs neither.
    const gaps = !STAGES[this.state.arena.stageId].solid;
    const careful = gaps || hasConveyors(this.state.arena.stageId);
    if (!enemy) return careful ? this.bide(f, level, input) : input;
    const toEnemy = { x: enemy.x - f.x, z: enemy.z - f.z };
    const distance = length(toEnemy);
    const dir = normalize(toEnemy);
    input.aim = dir;
    const zone = this.state.arena.safeZone;
    const outside = zone.active && Math.hypot(f.x - zone.x, f.z - zone.z) > zone.radius - 0.5;
    const edge =
      !gaps &&
      Math.max(Math.abs(f.x), Math.abs(f.z)) >
        (careful ? this.footingHalfSize() : this.state.arena.halfSize) - 0.8;
    if (!f.grounded && !canStandAt(this.state, f.x, f.z)) {
      if (careful) return this.recover(f, level, input);
      const home = normalize({ x: -f.x, z: -f.z });
      input.move = home;
      input.aim = home;
      if (f.mode === "idle") {
        const risingLeft = level.recoverRising && !f.airRisingUsed;
        if (risingLeft && f.y < 0.8) input.attackPressed = "rising";
        else if (level.recoverThrust && !f.airThrustUsed) input.attackPressed = "thrust";
        // The air dodge is the last resort, once the air attacks are spent.
        else if (
          !risingLeft &&
          level.recoverAirStep &&
          !f.airStepUsed &&
          f.stamina >= RULES.stepCost
        )
          input.step = true;
        input.attackHeld = input.attackPressed;
      } else if (f.mode === "charge") input.attackHeld = null;
      return input;
    }
    if (f.mode === "windup" && level.cancelWhiffs && this.windupWillWhiff(f, enemy)) {
      input.cancel = true;
    }
    // Every strength pulls out of a cut that would carry it into a pit or off a belt's end: the
    // target, the floor (a collapse) or the belt may have moved since it was chosen.
    const bail =
      careful &&
      (f.mode === "windup" || f.mode === "charge") &&
      (this.lungeLeavesFloor(f, dir) ||
        this.beltCarriesOff(f, 1) ||
        (gaps && f.grounded && !this.footing(f, 0.12)));
    // Beside a drop it finds room to stand before it fights: wind or a shove must not tip it in.
    const unsteady = gaps && f.grounded && !this.footing(f, this.footingMargin());
    if (bail) input.cancel = true;
    if (f.mode === "charge") {
      input.attackHeld = f.modeTime < f.aiCharge ? f.attack : null;
      // Occasional deliberate feint; never perfectly react to the player's input.
      if (
        f.modeTime > 0.18 &&
        enemy.mode === "windup" &&
        distance < level.feintRange &&
        f.stamina >= 25 &&
        f.aiCharge > 0.4
      ) {
        // CPUs keep their dodges on the ground (the air dodge is for recovering).
        input.step = f.grounded;
        input.move = { x: dir.z, z: -dir.x };
        if (careful && input.step) {
          const landing = this.safeStep(f, input.move);
          input.step = landing !== null;
          input.move = landing ?? { x: 0, z: 0 };
        }
      }
      return input;
    }
    const punish = level.punishRecovery && enemy.mode === "recovery";
    if (outside || edge)
      input.move = gaps
        ? this.walkToward(f, zone)
        : normalize({ x: zone.x - f.x, z: zone.z - f.z });
    else if (distance > 2.4 || punish) input.move = gaps ? this.walkToward(f, enemy) : dir;
    else if (unsteady) input.move = this.towardFooting(f);
    else if (distance < 1.5 || f.stamina < 28) input.move = { x: -dir.x, z: -dir.z };
    else input.move = { x: dir.z * 0.5, z: -dir.x * 0.5 };
    const danger = this.state.bombs.find(
      (b) =>
        !b.exploded &&
        b.timer <= level.bombNotice &&
        Math.hypot(f.x - b.x, f.z - b.z) < b.radius + 0.6,
    );
    if (danger) input.move = normalize({ x: f.x - danger.x + 0.1, z: f.z - danger.z });
    if (f.mode === "throw" && level.aimedThrows)
      input.move = gaps ? this.throwAimOverGaps(f) : this.throwAim(f);
    else {
      if (gaps) input.move = this.keepOnFloor(f, input.move);
      input.move = this.againstBelt(f, input.move);
    }
    f.aiThink -= dt;
    if (f.mode !== "idle" || f.aiThink > 0) return input;
    // Wait (deciding again every tick) for the late part of a wind-up, where tracking cannot follow.
    const windupLeft = enemy.mode === "windup" ? enemy.modeDuration - enemy.modeTime : 0;
    if (distance < 3.4 && windupLeft > level.dodgeWindow) return input;
    f.aiThink = level.thinkMin + this.random() * level.thinkRange;
    if (
      (enemy.mode === "windup" || (danger && danger.timer < 0.7)) &&
      distance < 3.4 &&
      f.stamina >= 25 &&
      this.random() < level.dodgeChance &&
      !edge
    ) {
      const dodge = level.smartDodge
        ? this.dodgeDirection(f, enemy, enemy.mode === "windup" ? null : danger!)
        : enemy.attack === "sweep"
          ? { x: -dir.x, z: -dir.z }
          : { x: dir.z, z: -dir.x };
      if (!careful) {
        input.step = f.grounded;
        input.move = dodge;
      } else if (f.grounded) {
        // Only a dodge that ends on floor: on a bridge that may leave no dodge at all.
        const landing = this.safeStep(f, dodge);
        if (landing) {
          input.step = true;
          input.move = landing;
        }
      }
    } else if (
      distance < 3.3 &&
      f.stamina >= level.attackStamina &&
      !outside &&
      !unsteady &&
      !(careful && this.beltCarriesOff(f, 1.6))
    ) {
      if (punish) {
        input.attackPressed = this.punishAttack(enemy, distance);
        f.aiCharge = 0.03;
      } else if (distance < 1.2 && this.random() < 0.22) input.grab = true;
      else {
        const roll = this.random();
        input.attackPressed = !enemy.grounded
          ? "rising"
          : distance > 2.4
            ? "thrust"
            : roll < 0.42
              ? "sweep"
              : roll < 0.78
                ? "overhead"
                : "thrust";
        f.aiCharge = this.random() < level.chargeChance ? 0.4 + this.random() * 0.5 : 0.03;
      }
      if (careful && input.attackPressed)
        input.attackPressed = this.attackThatStays(f, dir, distance, input.attackPressed);
      input.attackHeld = input.attackPressed;
    }
    return input;
  }

  /** The belt under (x, z): where it carries a grounded fighter, or zero off the belts. */
  private beltAt(x: number, z: number): Vec2 {
    const { stageId, halfSize } = this.state.arena;
    return conveyorVelocityAt(stageId, x, z, halfSize);
  }

  /**
   * The half size a careful CPU plans its footing with: once a collapse has been announced, the
   * one after it, so the doomed ring already counts as a drop and gets left in time.
   */
  private footingHalfSize(): number {
    const { arena } = this.state;
    return arena.warningRing
      ? Math.max(STAGES[arena.stageId].minHalfSize, arena.halfSize - RULES.tileSize)
      : arena.halfSize;
  }

  /** Floor at (x, z) that will still be there after an announced collapse. */
  private firmAt(x: number, z: number): boolean {
    return canStandAtStage(this.state.arena.stageId, x, z, this.footingHalfSize());
  }

  /** A straight walk from the fighter to `to` that stays on firm floor all the way. */
  private firmWalk(f: Fighter, to: Vec2, margin: number): boolean {
    return clearWalk(this.state.arena.stageId, this.footingHalfSize(), f, to, margin);
  }

  /** The nearest firm floor to a fighter, `inset` in from its edge. */
  private nearestFloor(f: Fighter, inset: number): Vec2 {
    return nearestWalkablePoint(this.state.arena.stageId, f.x, f.z, this.footingHalfSize(), inset);
  }

  /** Firm floor under the fighter with `margin` of it in every direction. */
  private footing(f: Fighter, margin: number): boolean {
    return hasClearance(this.state.arena.stageId, f.x, f.z, this.footingHalfSize(), margin);
  }

  /** Room a CPU wants around its feet before it commits to a cut; more while the wind pushes. */
  private footingMargin(): number {
    return this.state.arena.windActive ? 0.7 : 0.45;
  }

  /** To the nearest spot with room to stand: the middle of a bridge, in from a pit's rim. */
  private towardFooting(f: Fighter): Vec2 {
    const spot = this.nearestFloor(f, this.footingMargin() + 0.3);
    return normalize({ x: spot.x - f.x, z: spot.z - f.z });
  }

  /**
   * Nobody to fight for a moment (the rival is down). A careful CPU still looks after itself:
   * back from over a drop, off a running belt, into the safe zone, away from an edge.
   */
  private bide(f: Fighter, level: AiProfile, input: PlayerInput): PlayerInput {
    if (!f.grounded && !canStandAt(this.state, f.x, f.z)) return this.recover(f, level, input);
    if (f.mode === "charge" || f.mode === "windup") input.cancel = true;
    if (!f.grounded) return input;
    const gaps = !STAGES[this.state.arena.stageId].solid;
    const zone = this.state.arena.safeZone;
    const belt = this.beltAt(f.x, f.z);
    const calm = zone.active ? zone : { x: 0, z: 0 };
    let move: Vec2 = { x: 0, z: 0 };
    if (zone.active && Math.hypot(f.x - zone.x, f.z - zone.z) > zone.radius - 0.5)
      move = this.walkToward(f, zone);
    else if (belt.x !== 0 || belt.z !== 0) move = this.walkToward(f, calm);
    else if (gaps && !this.footing(f, this.footingMargin())) move = this.towardFooting(f);
    else if (!gaps && Math.max(Math.abs(f.x), Math.abs(f.z)) > this.footingHalfSize() - 0.8)
      move = normalize({ x: calm.x - f.x, z: calm.z - f.z });
    input.move = this.againstBelt(f, gaps ? this.keepOnFloor(f, move) : move);
    return input;
  }

  /** Toward the nearest floor, aiming a little in from its edge: never blindly at the centre. */
  private wayHome(f: Fighter): Vec2 {
    const floor = this.nearestFloor(f, 0.6);
    const home = normalize({ x: floor.x - f.x, z: floor.z - f.z });
    return length(home) > 0 ? home : normalize({ x: -f.x, z: -f.z });
  }

  /**
   * In the air over a pit, a gap or the outside of a careful stage. Back to the nearest floor,
   * spending no more than it takes: drift when the fall leaves time for it, the air dodge when
   * that alone lands on floor, the riser from low down, the thrust only when it will not
   * overshoot a narrow bridge.
   */
  private recover(f: Fighter, level: AiProfile, input: PlayerInput): PlayerInput {
    const home = this.wayHome(f);
    input.move = home;
    input.aim = home;
    if (f.mode === "charge") input.attackHeld = null;
    if (f.mode !== "idle") return input;
    const floor = this.nearestFloor(f, 0);
    const gap = Math.hypot(floor.x - f.x, floor.z - f.z);
    // Seconds until it has fallen to floor height: nothing to drift with once it is below.
    const fall =
      f.y > 0 ? (f.vy + Math.sqrt(f.vy * f.vy + 2 * RULES.gravity * f.y)) / RULES.gravity : 0;
    if (fall * RULES.airSpeed > gap + 0.4) return input;
    const risingLeft = level.recoverRising && !f.airRisingUsed;
    const stepLeft = level.recoverAirStep && !f.airStepUsed && f.stamina >= RULES.stepCost;
    const thrustLeft = level.recoverThrust && !f.airThrustUsed;
    const dodge = stepLeft && f.y > -0.1 ? this.stepOntoFloor(f, home) : null;
    if (dodge) {
      input.step = true;
      input.move = dodge;
    } else if (risingLeft && f.y < 0.8) input.attackPressed = "rising";
    else if (thrustLeft && this.thrustLands(f, home)) input.attackPressed = "thrust";
    // Still holding the riser: fall until it is low enough to use it.
    else if (!risingLeft && stepLeft) input.step = true;
    input.attackHeld = input.attackPressed;
    return input;
  }

  /** An air dodge (about 2.6 long) that ends over firm floor: toward `home` or a little to a side. */
  private stepOntoFloor(f: Fighter, home: Vec2): Vec2 | null {
    const heading = Math.atan2(home.x, home.z);
    for (const turn of [0, 0.45, -0.45, 0.9, -0.9]) {
      const d = { x: Math.sin(heading + turn), z: Math.cos(heading + turn) };
      if (
        this.firmAt(f.x + d.x * 2.3, f.z + d.z * 2.3) &&
        this.firmAt(f.x + d.x * 2.7, f.z + d.z * 2.7)
      )
        return d;
    }
    return null;
  }

  /**
   * Would an air thrust toward `home` come down on firm floor? It needs height left after its
   * wind-up, and it flies a fixed distance: on a narrow bridge that can be too far.
   */
  private thrustLands(f: Fighter, home: Vec2): boolean {
    const wait = ATTACKS.thrust.startup;
    const height = f.y + f.vy * wait - 0.5 * RULES.gravity * wait * wait;
    if (height < 0.05) return false;
    const air = (1.8 + Math.sqrt(1.8 * 1.8 + 2 * RULES.gravity * height)) / RULES.gravity;
    const travel = (ATTACKS.thrust.lunge * (1 - Math.exp(-1.9 * air))) / 1.9;
    return (
      this.firmAt(f.x + home.x * travel, f.z + home.z * travel) &&
      this.firmAt(f.x + home.x * (travel + 0.4), f.z + home.z * (travel + 0.4))
    );
  }

  /** Walking to `goal` along the floor: round the pit and over the bridges, never across a gap. */
  private walkToward(f: Fighter, goal: Vec2): Vec2 {
    return routeDirection(this.state.arena.stageId, this.footingHalfSize(), f, goal);
  }

  /**
   * The last check before a CPU walks on a stage with drops: when `move` would take it off the
   * floor within a stride, the closest direction to it that does not (sliding along the edge),
   * or standing still. On a ring about to collapse only the real drops count, so it can leave.
   */
  private keepOnFloor(f: Fighter, move: Vec2): Vec2 {
    const size = length(move);
    if (size < 0.05) return move;
    const firm = this.firmAt(f.x, f.z);
    const floor = (x: number, z: number): boolean =>
      firm ? this.firmAt(x, z) : canStandAt(this.state, x, z);
    // The stride itself, and a little room either side of where it ends: walking along an edge
    // drifts back in from it instead of hugging it.
    const ahead = (d: Vec2): boolean => {
      const x = f.x + d.x * 0.9;
      const z = f.z + d.z * 0.9;
      return (
        floor(f.x + d.x * 0.45, f.z + d.z * 0.45) &&
        floor(x, z) &&
        floor(x + d.z * 0.3, z - d.x * 0.3) &&
        floor(x - d.z * 0.3, z + d.x * 0.3)
      );
    };
    const d = normalize(move);
    if (ahead(d)) return move;
    const heading = Math.atan2(d.x, d.z);
    for (const turn of [0.5, -0.5, 1, -1, 1.57, -1.57, 2.2, -2.2, Math.PI]) {
      const turned = { x: Math.sin(heading + turn), z: Math.cos(heading + turn) };
      if (ahead(turned)) return { x: turned.x * size, z: turned.z * size };
    }
    return { x: 0, z: 0 };
  }

  /**
   * A dodge that stays on the floor: `wanted` when the whole step is over floor, else the first
   * of sideways and backwards that is, or null when every way ends in a drop.
   */
  private safeStep(f: Fighter, wanted: Vec2): Vec2 | null {
    const d = normalize(wanted);
    if (length(d) === 0) return null;
    // A step covers about 2.6; the landing needs a little floor beyond it.
    for (const dir of [d, { x: d.z, z: -d.x }, { x: -d.z, z: d.x }, { x: -d.x, z: -d.z }])
      if (this.firmWalk(f, { x: f.x + dir.x * 2.9, z: f.z + dir.z * 2.9 }, 0.2)) return dir;
    return null;
  }

  /** How far a cut carries its user forward: the thrust's lunge (longer in the air), the riser's hop. */
  private lungeTravel(f: Fighter, attack: AttackId): number {
    return attack === "thrust" ? (f.grounded ? 1.7 : 3.8) : attack === "rising" ? 2 : 0;
  }

  /** The cut being charged or wound up would end over a drop, along its facing or its aim. */
  private lungeLeavesFloor(f: Fighter, aim: Vec2): boolean {
    const travel = f.attack ? this.lungeTravel(f, f.attack) : 0;
    if (travel === 0) return false;
    const facing = forward(f);
    return [facing, aim].some(
      (d) => !this.firmWalk(f, { x: f.x + d.x * travel, z: f.z + d.z * travel }, 0.15),
    );
  }

  /**
   * Thrusts and rising cuts carry their user forward. Where that would end over a drop, the
   * heavy overhead or the sweep if the target is in their reach, else no attack this time.
   */
  private attackThatStays(
    f: Fighter,
    dir: Vec2,
    distance: number,
    attack: AttackId,
  ): AttackId | null {
    const travel = this.lungeTravel(f, attack);
    const carried = { x: f.x + dir.x * travel, z: f.z + dir.z * travel };
    if (travel === 0 || this.firmWalk(f, carried, 0.15)) return attack;
    if (distance < ATTACKS.overhead.reach + RULES.fighterRadius) return "overhead";
    if (distance < ATTACKS.sweep.reach + RULES.fighterRadius) return "sweep";
    return null;
  }

  /** Standing on a belt that tips it off the firm floor within `seconds`. */
  private beltCarriesOff(f: Fighter, seconds: number): boolean {
    if (!f.grounded || !hasConveyors(this.state.arena.stageId)) return false;
    const belt = this.beltAt(f.x, f.z);
    if (belt.x === 0 && belt.z === 0) return false;
    return !this.firmAt(f.x + belt.x * seconds, f.z + belt.z * seconds);
  }

  /**
   * Walking on a belt: the stick direction that, once the belt's drift is added, still goes the
   * way `move` meant. Belts are slower than walking, so there always is one.
   */
  private againstBelt(f: Fighter, move: Vec2): Vec2 {
    if (!f.grounded || !hasConveyors(this.state.arena.stageId)) return move;
    const belt = this.beltAt(f.x, f.z);
    if ((belt.x === 0 && belt.z === 0) || length(move) < 0.05) return move;
    const d = normalize(move);
    // Cancel the part of the drift that is across the wanted direction; spend the rest going on.
    const along = belt.x * d.x + belt.z * d.z;
    const acrossX = (belt.x - along * d.x) / RULES.moveSpeed;
    const acrossZ = (belt.z - along * d.z) / RULES.moveSpeed;
    const forward = Math.sqrt(Math.max(0, 1 - acrossX * acrossX - acrossZ * acrossZ));
    return normalize({ x: d.x * forward - acrossX, z: d.z * forward - acrossZ });
  }

  /**
   * Throwing on a stage with pits: toward the nearest drop the victim would land in (the pit
   * counts as much as the outside), otherwise out of the safe zone.
   */
  private throwAimOverGaps(f: Fighter): Vec2 {
    const zone = this.state.arena.safeZone;
    const victim = this.state.fighters.find((o) => o.id === f.grabbedId);
    const reach = 2.4 + (victim?.damage ?? 0) * 0.02;
    let best: Vec2 | null = null;
    let nearest = Infinity;
    for (let k = 0; k < 16; k++) {
      const angle = (k * Math.PI) / 8;
      const d = { x: Math.sin(angle), z: Math.cos(angle) };
      if (canStandAt(this.state, f.x + d.x * reach, f.z + d.z * reach)) continue;
      // How soon the floor ends this way: the sooner, the less a victim can drift back.
      let drop = reach;
      for (let step = 0.3; step < reach; step += 0.3) {
        if (!canStandAt(this.state, f.x + d.x * step, f.z + d.z * step)) {
          drop = step;
          break;
        }
      }
      if (drop < nearest - 1e-9) {
        nearest = drop;
        best = d;
      }
    }
    if (best) return best;
    const out = normalize({ x: f.x - zone.x, z: f.z - zone.z });
    return zone.active && length(out) > 0 ? out : forward(f);
  }

  /**
   * Would this wind-up miss? True when, even turning as fast as it may for the time left and
   * counting the thrust's lunge, the blade cannot reach the target, or the target will still be
   * invulnerable when the blade comes out.
   */
  private windupWillWhiff(f: Fighter, target: Fighter): boolean {
    if (!f.attack) return false;
    const left = Math.max(0, f.modeDuration - f.modeTime);
    if (isInvulnerable(target, left)) return true;
    const aim = Math.atan2(target.x - f.x, target.z - f.z);
    const turn = this.turnRate(f) * left;
    const facing = f.facing + clamp(angleDelta(f.facing, aim), -turn, turn);
    const blade: Fighter = { ...f, mode: "active", facing };
    if (attackContains(blade, target)) return false;
    // Where the thrust's lunge (or the riser's hop) carries the blade during the cut.
    const travel = f.attack === "thrust" ? 1.5 : f.attack === "rising" ? 0.6 : 0;
    const dir = { x: Math.sin(facing), z: Math.cos(facing) };
    const lunged: Fighter = { ...blade, x: f.x + dir.x * travel, z: f.z + dir.z * travel };
    return !(travel > 0 && attackContains(lunged, target));
  }

  /** Back out of a sweep's fan, sideways off a narrow blade's line, or straight away from a bomb. */
  private dodgeDirection(f: Fighter, enemy: Fighter, bomb: Bomb | null): Vec2 {
    if (bomb) return normalize({ x: f.x - bomb.x + 0.01, z: f.z - bomb.z });
    const away = normalize({ x: f.x - enemy.x, z: f.z - enemy.z });
    if (enemy.attack === "sweep") return away;
    // Step further to the side of the blade line it already stands on; if dead centre, inwards.
    const blade = forward(enemy);
    const side = { x: blade.z, z: -blade.x };
    const offset = (f.x - enemy.x) * side.x + (f.z - enemy.z) * side.z;
    const inward = -(f.x * side.x + f.z * side.z);
    const sign = Math.abs(offset) > 0.05 ? Math.sign(offset) : inward >= 0 ? 1 : -1;
    const lateral = { x: away.z, z: -away.x };
    const flip = lateral.x * side.x + lateral.z * side.z >= 0 ? sign : -sign;
    return { x: lateral.x * flip, z: lateral.z * flip };
  }

  /** The quickest cut that still lands before a target in recovery can act again. */
  private punishAttack(enemy: Fighter, distance: number): AttackId {
    if (!enemy.grounded) return "rising";
    const left = enemy.modeDuration - enemy.modeTime;
    if (distance > 2.2) return "thrust";
    if (distance < 2.5 && left > ATTACKS.overhead.startup + 0.05) return "overhead";
    return "sweep";
  }

  /** Toward the nearest edge when a ring-out is in reach, otherwise out of the safe zone. */
  private throwAim(f: Fighter): Vec2 {
    const { halfSize, safeZone: zone } = this.state.arena;
    const toEdge =
      halfSize - Math.abs(f.x) < halfSize - Math.abs(f.z)
        ? { x: Math.sign(f.x) || 1, z: 0 }
        : { x: 0, z: Math.sign(f.z) || 1 };
    const victim = this.state.fighters.find((o) => o.id === f.grabbedId);
    const reach = 2.4 + (victim?.damage ?? 0) * 0.02;
    const edgeDistance = halfSize - Math.max(Math.abs(f.x), Math.abs(f.z));
    if (edgeDistance < reach || !zone.active) return toEdge;
    const out = normalize({ x: f.x - zone.x, z: f.z - zone.z });
    return length(out) > 0 ? out : toEdge;
  }

  private effect(
    kind: EffectKind,
    position: { x: number; y: number; z: number },
    color: number,
    duration: number,
    size = 1,
  ): void {
    this.state.effects.push({
      id: this.effectId++,
      kind,
      x: position.x,
      y: position.y,
      z: position.z,
      color,
      duration,
      life: duration,
      size,
    });
    if (this.state.effects.length > 100)
      this.state.effects.splice(0, this.state.effects.length - 100);
  }

  /** The name an announcement uses: led by the tag (P2, CPU 03) when two fighters share it. */
  private title(f: Fighter): string {
    return fighterTitle(f, this.state.fighters);
  }

  private announce(message: string, duration = 1.2): void {
    this.state.message = message;
    this.state.messageTime = duration;
  }
}
