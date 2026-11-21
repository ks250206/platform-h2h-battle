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
import {
  TrainingSession,
  TRAINING_RESPAWN,
  trainingDamage,
  type TrainingSettings,
} from "./training";
import { CpuController } from "./ai";
import { emptyPlayerStats, MatchStats } from "./matchStats";
import { effectiveRules, timeLimitFor, type StageInfo, type TimeRule } from "./rules";
import {
  advanceSet,
  createSetMatch,
  effectiveSetFormat,
  finishSetGame,
  type SetMatch,
} from "./setMatch";
import {
  conveyorVelocityAt,
  hasClearance,
  hasConveyors,
  nearestWalkablePoint,
  respawnCandidates,
  spawnPoints,
  stageInfoFor,
  STAGES,
} from "./stages";
import {
  announcedZoneIn,
  INACTIVE_ZONE,
  RESPAWN_LOOKAHEAD,
  RESPAWN_STARTUP,
  safeZoneAt,
  ZONE_KO_REASON,
} from "./safeZone";
import { ATTACKS, INPUT_BUFFER_TICKS, RULES, UKEMI } from "./tuning";
import { advanceRoll, armedTech, cpuTechOpportunity, rollDirection } from "./ukemi";
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
    lastHitAt: -Infinity,
    kills: 0,
    eliminatedAt: null,
    eliminationReason: null,
    aiThink: 0,
    aiCharge: 0,
    aiMemory: null,
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
  training: TrainingSession | null = null;
  private cpu: CpuController;
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
    this.cpu = new CpuController(this.state, () => this.random());
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
        safeZone: { ...INACTIVE_ZONE },
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
    this.training?.stop();
    this.training = mode === "training" ? new TrainingSession() : null;
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

  private resetGame(mode: MatchMode, set: SetMatch | null, keepFrame = false): void {
    this.state = this.createState(mode, this.state.seed, set);
    this.cpu = new CpuController(this.state, () => this.random());
    this.matchStats = new MatchStats(this.state.playerStats);
    this.randomState = this.state.seed >>> 0;
    this.nextBomb = RULES.bombStart;
    this.effectId = 0;
    this.bombId = 0;
    this.inputs.clear();
    if (!keepFrame) {
      this.pending.clear();
      this.timeRemainder = 0;
    }
  }

  stopTraining(): void {
    if (!this.training) return;
    this.training.stop();
    this.pending.clear();
    this.inputs.clear();
    this.clearBuffers();
  }

  configureTraining(settings: Partial<TrainingSettings>): void {
    if (!this.training) return;
    this.stopTraining();
    Object.assign(this.training.settings, settings);
    if (this.training.settings.infinite) {
      for (const f of this.state.fighters) {
        f.stamina = RULES.maxStamina;
        f.staminaDelay = 0;
      }
    }
  }

  setTrainingDamage(slot: 0 | 1, value: unknown): void {
    if (!this.training) return;
    this.stopTraining();
    const damage = trainingDamage(value);
    if (damage === null) return;
    this.training.damage[slot] = this.state.fighters[slot].damage = damage;
  }

  resetTraining(): void {
    if (!this.training) return;
    this.training.stop();
    this.resetPracticeField(false);
  }

  private resetPracticeField(keepFrame: boolean): void {
    this.resetGame("training", null, keepFrame);
    this.state.fighters.forEach((f, i) => {
      f.damage = this.training!.damage[i];
    });
    this.state.countdown = 0;
    this.state.phase = "playing";
  }

  beginTraining(action: "play" | "record"): boolean {
    if (!this.training || (action === "play" && !this.training.ticks)) return false;
    this.resetTraining();
    this.training[action]();
    return true;
  }

  pause(): void {
    if (this.state.phase === "playing" || this.state.phase === "countdown") {
      this.stopTraining();
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
    this.training = null;
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
      const session = this.training;
      if (session?.transport === "playing" && session.cursor === session.ticks) {
        // Rebuild both fighters and the RNG at the loop seam, preserving this frame’s
        // remaining fixed ticks and the live player input for this tick.
        this.resetPracticeField(true);
        session.play();
      }
      this.tick(RULES.fixedStep, this.pending);
      if (
        session?.transport === "playing" &&
        session.cursor === session.ticks &&
        !session.settings.loop
      ) {
        session.stop();
        this.state.fighters[1].inputBuffer = null;
      }
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
        const stillPartner =
          this.training?.settings.behavior === "still" && state.fighters.some((f) => !f.human);
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
    const replay = this.training?.sample(playerInputs.get(0) ?? emptyInput());
    for (const f of state.fighters) {
      if ((f.mode as Fighter["mode"]) === "dead") continue;
      this.inputs.set(
        f.id,
        f.id === 1 && replay
          ? replay
          : f.human
            ? (playerInputs.get(f.id) ?? emptyInput())
            : this.ai(f, dt),
      );
    }
    for (const f of state.fighters) {
      if ((f.mode as Fighter["mode"]) === "dead") continue;
      const input = this.inputs.get(f.id)!;
      const useBuffer = f.human || (f.id === 1 && !!replay);
      f.diInput = { ...input.move };
      this.updateZone(f, dt);
      if ((f.mode as Fighter["mode"]) === "dead") continue;
      f.invulnerable = Math.max(0, f.invulnerable - dt);
      // The buffer ages every tick, hitstop included, so a press never outlives its window.
      this.ageBuffer(f);
      if (f.hitstop > 0) {
        f.hitstop = Math.max(0, f.hitstop - dt);
        if (f.hitstop > 0) {
          if (useBuffer) this.holdPress(f, input);
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
      if (
        !useBuffer &&
        (!this.training || this.training.settings.behavior === "cpu") &&
        cpuTechOpportunity(state, f, dt)
      ) {
        input.step = this.random() < UKEMI.cpuChance[f.aiLevel];
        if (input.step) this.holdPress(f, input);
      }
      this.handleInput(f, useBuffer ? this.bufferedInput(f, input) : input, dt);
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
    if (this.training?.settings.infinite) return true;
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
    if (f.mode === "windup") return RULES.windupTurnRate;
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

  /**
   * One fixed tick older. Launched step presses use the tech window; other presses use six ticks. A jump or
   * grab freed by a landing gets one tick more (`landingGrace`, see `graceLanding`).
   */
  private ageBuffer(f: Fighter): void {
    if (!f.inputBuffer) return;
    f.inputBuffer.age++;
    const limit = armedTech(f)
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
    if (!press || (press.action !== "step" && armedTech(f))) return;
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
      const { stageId, halfSize } = this.state.arena;
      const belt = conveyorVelocityAt(stageId, f.x, f.z, halfSize);
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
    const tech = armedTech(f);
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
    arena.safeZone = safeZoneAt(arena.stageId, elapsed, safeZone ? rules.timeLimit : null);
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
      const exposure = Math.min(dt, RULES.outsideLimit - f.outsideTime);
      f.outsideTime += exposure;
      this.matchStats.damage(f, RULES.outsideDamage * exposure);
      if (f.outsideTime >= RULES.outsideLimit - 1e-9) {
        f.outsideTime = RULES.outsideLimit;
        this.eliminate(f, ZONE_KO_REASON, true);
      }
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

  /** Floor half size remaining after an announced outer collapse. */
  private footingHalfSize(): number {
    const { arena } = this.state;
    return arena.warningRing
      ? Math.max(STAGES[arena.stageId].minHalfSize, arena.halfSize - RULES.tileSize)
      : arena.halfSize;
  }

  /**
   * Inside the safe zone when it is active, else near the middle of the stage; always over floor
   * with a margin, never over a pit or a gap (`respawnCandidates` in stages.ts). Fixed candidates
   * (no RNG): the one farthest from living opponents that is clear of pending bombs.
   */
  private respawnPoint(f: Fighter): Vec2 {
    const { safeZone: zone, stageId } = this.state.arena;
    const floor = this.footingHalfSize();
    const candidates = respawnCandidates(stageId, floor, zone.active ? zone : null);
    const landing = announcedZoneIn(zone, RESPAWN_LOOKAHEAD);
    if (
      zone.active &&
      (landing.x !== zone.x || landing.z !== zone.z || landing.radius !== zone.radius)
    ) {
      candidates.push(...respawnCandidates(stageId, floor, landing));
    }
    const clear = candidates.filter(
      (p) =>
        !this.state.bombs.some(
          (b) => !b.exploded && Math.hypot(p.x - b.x, p.z - b.z) <= b.radius + 0.3,
        ),
    );
    const available = clear.length > 0 ? clear : candidates;
    const safeAtLanding = zone.active
      ? available.filter((p) => {
          // Belts begin carrying the fighter only after touching down.
          const belt = conveyorVelocityAt(stageId, p.x, p.z, floor);
          const x = p.x + belt.x * RESPAWN_STARTUP;
          const z = p.z + belt.z * RESPAWN_STARTUP;
          return (
            Math.hypot(p.x - landing.x, p.z - landing.z) <= landing.radius - 0.15 &&
            Math.hypot(x - landing.x, z - landing.z) <= landing.radius - 0.15 &&
            hasClearance(stageId, x, z, floor, 0.3)
          );
        })
      : available;
    const landingPool = safeAtLanding.length > 0 ? safeAtLanding : available;
    // Exposure starts during the drop. Prefer the overlap when both circles have clear floor.
    const safeThroughout = zone.active
      ? landingPool.filter((p) => Math.hypot(p.x - zone.x, p.z - zone.z) <= zone.radius)
      : landingPool;
    const pool = safeThroughout.length > 0 ? safeThroughout : landingPool;
    const opponents = this.state.fighters.filter((o) => o.id !== f.id && o.mode !== "dead");
    const room = (p: Vec2) =>
      Math.min(...opponents.map((o) => Math.hypot(o.x - p.x, o.z - p.z)), Infinity);
    let best = pool[0];
    for (const p of pool) if (room(p) > room(best) + 1e-9) best = p;
    return best;
  }

  private resolveOutcome(): void {
    const state = this.state;
    if (state.mode === "training") {
      for (let i = 0; i < state.fighters.length; i++) {
        const f = state.fighters[i];
        if (f.mode === "dead" && state.elapsed - (f.eliminatedAt ?? 0) + 1e-8 >= TRAINING_RESPAWN) {
          state.fighters[i] = makeFighter(f.id, 2, this.options);
          state.fighters[i].damage = this.training?.damage[i] ?? 0;
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
    if (this.training) return this.training.dummy(this.state, () => this.cpu.decide(f, dt));
    return this.cpu.decide(f, dt);
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
