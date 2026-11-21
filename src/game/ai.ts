import {
  angleDelta,
  attackContains,
  canStandAt,
  clamp,
  forward,
  length,
  normalize,
} from "./combat";
import { clearWalk, routeDirection } from "./navigation";
import {
  canStandAtStage,
  conveyorVelocityAt,
  hasClearance,
  hasConveyors,
  nearestWalkablePoint,
  STAGES,
} from "./stages";
import { AI_LEVELS, ATTACKS, RULES, type AiProfile } from "./tuning";
import {
  emptyInput,
  type Fighter,
  type GameState,
  type PlayerInput,
  type Vec2,
  type AttackId,
  type Bomb,
} from "./types";

// Only visible pose and animation fields cross the observation boundary. No input, buffer,
// next attack, RNG state or future movement is available to the opponent model.
type Pose = Pick<
  Fighter,
  | "x"
  | "y"
  | "z"
  | "grounded"
  | "facing"
  | "mode"
  | "modeTime"
  | "modeDuration"
  | "attack"
  | "stepDirection"
  | "invulnerable"
>;

export interface AiMemory {
  targetId: number;
  history: Pose[];
  lastMode: Fighter["mode"];
  lastSwing: AttackId | null;
  defend: boolean;
  chargeRead: boolean;
  lead: number;
  spentRead: boolean;
  counterAim: Vec2 | null;
}

function observe(target: Fighter): Pose {
  return {
    x: target.x,
    y: target.y,
    z: target.z,
    grounded: target.grounded,
    facing: target.facing,
    mode: target.mode,
    modeTime: target.modeTime,
    modeDuration: target.modeDuration,
    attack: target.attack,
    // A feint-step has a startup pose before it moves. Its chosen heading is still hidden.
    stepDirection:
      target.mode === "step" && target.stepDelay <= 0
        ? { ...target.stepDirection }
        : { x: 0, z: 0 },
    invulnerable: target.invulnerable,
  };
}

// Selection uses visible location and spawn protection. Stay on a rival until a challenger
// is a full stride closer. When everyone is protected, approach but withhold the attack.
function selectTarget(f: Fighter, fighters: Fighter[]): Fighter | undefined {
  const living = fighters.filter((other) => other.id !== f.id && other.mode !== "dead");
  const vulnerable = living.filter((other) => other.invulnerable <= 0);
  const pool = vulnerable.length ? vulnerable : living;
  const distance = (other: Fighter) => Math.hypot(other.x - f.x, other.z - f.z);
  const current = pool.find((other) => other.id === f.aiMemory?.targetId);
  return pool.reduce<Fighter | undefined>(
    (best, other) =>
      !best || distance(other) < distance(best) - (best === current ? 1 : 0) ? other : best,
    current,
  );
}

function isTell(mode: Fighter["mode"]): boolean {
  return mode === "charge" || mode === "windup" || mode === "active";
}

export class CpuController {
  private readonly state: GameState;
  private readonly random: () => number;

  constructor(state: GameState, random: () => number) {
    this.state = state;
    this.random = random;
  }

  decide(f: Fighter, dt: number): PlayerInput {
    const input = this.choose(f, dt);
    if (f.mode === "windup" && input.aim) {
      const limit = RULES.windupTurnRate * AI_LEVELS[f.aiLevel].tracking * dt;
      const wanted = Math.atan2(input.aim.x, input.aim.z);
      const angle = f.facing + clamp(angleDelta(f.facing, wanted), -limit, limit);
      input.aim = { x: Math.sin(angle), z: Math.cos(angle) };
    }
    return input;
  }

  private choose(f: Fighter, dt: number): PlayerInput {
    const input = emptyInput();
    if (this.state.mode === "training") return input;
    const level = AI_LEVELS[f.aiLevel];
    const target = selectTarget(f, this.state.fighters);
    // A stage with pits or bridges (`gaps`) is walked along its floor (navigation.ts) and every
    // move is checked for a drop first. One with gaps or belts (`careful`) also plans its footing:
    // Avoid starting a lunge or step over a drop on every stage, including the garden rim.
    const gaps = !STAGES[this.state.arena.stageId].solid;
    const careful = gaps || hasConveyors(this.state.arena.stageId);
    if (!target) {
      f.aiMemory = null;
      return this.bide(f, level, input);
    }
    const { memory, enemy } = this.observeRival(f, target, level);
    // Extrapolate only a manifested, direction-locked step. A new stick direction, release,
    // cancel, landing or subsequent dodge is unknowable. A counter aims at its chosen spot.
    const stepRead =
      level.punishRecovery && enemy?.mode === "step" && length(enemy.stepDirection) > 0;
    let goal: Vec2 = enemy ?? memory.history[0]!;
    if (stepRead) {
      const travel = Math.max(0, RULES.stepDuration - enemy.modeTime) * RULES.stepSpeed * 0.8;
      goal = {
        x: enemy.x + enemy.stepDirection.x * travel,
        z: enemy.z + enemy.stepDirection.z * travel,
      };
    }
    goal = memory.counterAim ?? goal;
    const toEnemy = { x: goal.x - f.x, z: goal.z - f.z };
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
    if (
      f.mode === "windup" &&
      level.cancelWhiffs &&
      enemy &&
      !memory.counterAim &&
      this.windupWillWhiff(f, enemy)
    ) {
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
      // Pull out of a long charge when the observed rival retreats beyond thrust range.
      // A read already committed to a dodge landing or a whiff keeps its original aim.
      if (!memory.counterAim && enemy && distance > 3.8 && f.modeTime > 0.18) input.cancel = true;
      // Occasional deliberate feint; never perfectly react to the player's input.
      if (
        f.modeTime > 0.18 &&
        enemy?.mode === "windup" &&
        !memory.counterAim &&
        memory.defend &&
        !memory.spentRead &&
        distance < level.feintRange &&
        f.stamina >= RULES.stepCost &&
        f.aiCharge > 0.4
      ) {
        // CPUs keep their dodges on the ground (the air dodge is for recovering).
        input.step = f.grounded;
        input.move = { x: dir.z, z: -dir.x };
        if (input.step) {
          const landing = this.safeStep(f, input.move);
          input.step = landing !== null;
          memory.spentRead ||= input.step;
          input.move = landing ?? { x: 0, z: 0 };
        }
      }
      return input;
    }
    const punish = level.punishRecovery && (enemy?.mode === "recovery" || stepRead);
    if (outside || edge)
      input.move = gaps
        ? this.walkToward(f, zone)
        : normalize({ x: zone.x - f.x, z: zone.z - f.z });
    else if (distance > 2.4 || punish) input.move = gaps ? this.walkToward(f, goal) : dir;
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
    if (f.mode !== "idle" || !enemy || enemy.invulnerable > 0 || target.invulnerable > 0)
      return input;
    if (this.defend(f, input, memory, enemy, distance, edge, danger)) return input;
    if (f.aiThink > 0 && !(punish && distance < 3.3 && f.stamina >= level.attackStamina))
      return input;
    f.aiThink = level.thinkMin + this.random() * level.thinkRange;
    if (
      distance < 3.3 &&
      f.stamina >= level.attackStamina &&
      !outside &&
      !unsteady &&
      !(careful && this.beltCarriesOff(f, 1.6))
    ) {
      if (punish) {
        input.attackPressed = this.punishAttack(
          enemy,
          distance,
          level.observationTicks * RULES.fixedStep,
        );
        memory.counterAim = { x: goal.x, z: goal.z };
        f.aiCharge = 0.03;
      } else if (f.grounded && distance < 1.2 && this.random() < 0.22) input.grab = true;
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
      if (input.attackPressed)
        input.attackPressed = this.attackThatStays(f, dir, distance, input.attackPressed);
      input.attackHeld = input.attackPressed;
    }
    return input;
  }

  private defend(
    f: Fighter,
    input: PlayerInput,
    memory: AiMemory,
    enemy: Pose,
    distance: number,
    edge: boolean,
    danger: Bomb | undefined,
  ): boolean {
    const level = AI_LEVELS[f.aiLevel];
    const dir = input.aim!;
    const age = level.observationTicks * RULES.fixedStep;
    const blade = forward(enemy);
    const facesUs = (f.x - enemy.x) * blade.x + (f.z - enemy.z) * blade.z > -0.15;
    const stillThreatening = enemy.mode !== "active" || enemy.modeDuration - enemy.modeTime > age;
    const threat =
      isTell(enemy.mode) &&
      facesUs &&
      stillThreatening &&
      distance < 3.4 &&
      f.grounded &&
      !edge &&
      f.stamina >= RULES.stepCost;
    const expecting =
      threat && !memory.spentRead && (enemy.mode === "charge" ? memory.chargeRead : memory.defend);
    // Hold the chosen read while moving. Imperfect lead time can leave the whole step early
    // or late. Only one dodge per visible swing, even if the player keeps holding the button.
    const ready =
      enemy.mode === "charge"
        ? enemy.modeTime + age >= memory.lead
        : enemy.mode !== "windup" || enemy.modeDuration - enemy.modeTime - age <= memory.lead;
    if (expecting && !ready) return true;
    const bombDodge =
      danger &&
      danger.timer < 0.7 &&
      f.aiThink <= 0 &&
      f.grounded &&
      !edge &&
      f.stamina >= RULES.stepCost &&
      this.random() < level.dodgeChance;
    if (expecting || bombDodge) {
      memory.spentRead ||= expecting;
      f.aiThink = level.thinkMin + this.random() * level.thinkRange;
      const dodge = level.smartDodge
        ? this.dodgeDirection(f, enemy, bombDodge ? danger : null)
        : enemy.attack === "sweep"
          ? { x: -dir.x, z: -dir.z }
          : { x: dir.z, z: -dir.x };
      // Only a dodge that ends on floor: on a bridge that may leave no dodge at all.
      const landing = this.safeStep(f, dodge);
      if (landing) {
        input.step = true;
        input.move = landing;
      }
      return true;
    }
    return false;
  }

  /** Sample once per simulation tick, before inputs execute. Delay is 14 / 9 / 5 ticks
   * (easy / normal / hard at 60 Hz); each switch starts a fresh history. The first location
   * supplies a navigation goal while combat waits for the first delayed animation. */
  private observeRival(f: Fighter, target: Fighter, level: AiProfile) {
    if (!f.aiMemory || f.aiMemory.targetId !== target.id) {
      f.aiMemory = {
        targetId: target.id,
        history: [],
        lastMode: "idle",
        lastSwing: null,
        defend: false,
        chargeRead: false,
        lead: 0,
        spentRead: false,
        counterAim: f.aiMemory?.counterAim ?? null,
      };
    }
    const memory = f.aiMemory;
    memory.history.push(observe(target));
    const enemy =
      memory.history.length > level.observationTicks ? memory.history.shift() : undefined;
    if (enemy) this.readTell(memory, enemy, level);
    if (f.mode !== "windup" && f.mode !== "charge") memory.counterAim = null;
    return { memory, enemy };
  }

  /** Draw once per visible attack, never resample a missed judgment every simulation tick.
   * Hard recognizes the last committed strike by this same rival. A feinted charge alone
   * doesn't establish a pattern. Even a repeated strike can still catch it mid-action. */
  private readTell(memory: AiMemory, enemy: Pose, level: AiProfile): void {
    if (isTell(enemy.mode) && !isTell(memory.lastMode)) {
      const repeat = level.smartDodge && enemy.attack !== null && enemy.attack === memory.lastSwing;
      memory.defend = this.random() < Math.min(0.97, level.dodgeChance + (repeat ? 0.15 : 0));
      memory.chargeRead = this.random() < level.anticipateCharge;
      memory.lead = level.dodgeLead + (2 * this.random() - 1) * level.leadSpread;
      memory.spentRead = false;
    }
    if (enemy.mode === "windup") memory.lastSwing = enemy.attack;
    memory.lastMode = enemy.mode;
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
  private windupWillWhiff(f: Fighter, target: Pose): boolean {
    if (!f.attack) return false;
    const left = Math.max(0, f.modeDuration - f.modeTime);
    if (target.invulnerable > left + AI_LEVELS[f.aiLevel].observationTicks * RULES.fixedStep)
      return true;
    const aim = Math.atan2(target.x - f.x, target.z - f.z);
    const turn = RULES.windupTurnRate * AI_LEVELS[f.aiLevel].tracking * left;
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
  private dodgeDirection(f: Fighter, enemy: Pose, bomb: Bomb | null): Vec2 {
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

  /** Prefer the heavy punish only when the observed recovery leaves time for it. */
  private punishAttack(enemy: Pose, distance: number, age: number): AttackId {
    if (!enemy.grounded) return "rising";
    const left = enemy.modeDuration - enemy.modeTime - age;
    if (distance > 2.2) return "thrust";
    if (distance < 2.5 && left > ATTACKS.overhead.startup + 0.07) return "overhead";
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
}
