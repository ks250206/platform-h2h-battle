import { ATTACKS, RULES } from "./tuning";
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
  type EffectKind,
  type Fighter,
  type GameState,
  type MatchMode,
  type PlayerInput,
  type Vec2,
} from "./types";

export {
  attackContains,
  attacksClash,
  canStandAt,
  directionInfluence,
  isInvulnerable,
} from "./combat";

const CAST = [
  { name: "コハク", species: "fox" as const, color: 0xff7a45 },
  { name: "シロ", species: "rabbit" as const, color: 0x3fb4ff },
  { name: "モカ", species: "bear" as const, color: 0xb57bff },
  { name: "スミ", species: "raccoon" as const, color: 0xffc93c },
];

function makeFighter(id: number, count: number): Fighter {
  const theta =
    count === 2 ? (id === 0 ? -Math.PI / 2 : Math.PI / 2) : (id * Math.PI) / 2 - Math.PI / 2;
  return {
    ...CAST[id],
    id,
    human: id === 0,
    x: Math.sin(theta) * 3.5,
    z: Math.cos(theta) * 3.5,
    y: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    facing: theta + Math.PI,
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
    stepDirection: { x: 0, z: 0 },
    stepDelay: 0,
    hitTargets: [],
    swingId: 0,
    grabbedId: null,
    grabbedBy: null,
    throwDirection: { x: 0, z: 0 },
    pendingLaunch: null,
    diInput: { x: 0, z: 0 },
    lastAttacker: null,
    kills: 0,
    eliminatedAt: null,
    eliminationReason: null,
    aiThink: 0,
    aiCharge: 0,
    aiIntent: { x: 0, z: 0 },
  };
}

export class BattleEngine {
  state: GameState;
  private randomState: number;
  private effectId = 0;
  private bombId = 0;
  private nextBomb = RULES.bombStart as number;
  private inputs = new Map<number, PlayerInput>();
  private timeRemainder = 0;
  private pendingInput = emptyInput();

  constructor(seed = 20261121) {
    this.randomState = seed >>> 0;
    this.state = this.createState("duel", seed);
    this.state.phase = "menu";
  }

  private random(): number {
    this.randomState = (Math.imul(1664525, this.randomState) + 1013904223) >>> 0;
    return this.randomState / 4294967296;
  }

  private createState(mode: MatchMode, seed: number): GameState {
    return {
      phase: "countdown",
      mode,
      elapsed: 0,
      countdown: 3,
      fighters: Array.from({ length: mode === "rumble" ? 4 : 2 }, (_, i) =>
        makeFighter(i, mode === "rumble" ? 4 : 2),
      ),
      arena: {
        halfSize: RULES.arenaHalfSize,
        initialHalfSize: RULES.arenaHalfSize,
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
      message: "",
      messageTime: 0,
      seed,
      pausedFrom: "playing",
      stats: { hits: 0, clashes: 0, dodges: 0, maxDamage: 0 },
    };
  }

  start(mode: MatchMode): void {
    this.state = this.createState(mode, this.state.seed);
    this.randomState = this.state.seed >>> 0;
    this.nextBomb = RULES.bombStart;
    this.effectId = 0;
    this.bombId = 0;
    this.timeRemainder = 0;
    this.inputs.clear();
    this.pendingInput = emptyInput();
  }

  pause(): void {
    if (this.state.phase === "playing" || this.state.phase === "countdown") {
      this.pendingInput = emptyInput();
      this.state.pausedFrom = this.state.phase;
      this.state.phase = "paused";
    }
  }
  resume(): void {
    if (this.state.phase === "paused") this.state.phase = this.state.pausedFrom;
  }
  menu(): void {
    this.start("duel");
    this.state.phase = "menu";
  }

  /** Fixed substeps keep sword contacts stable across refresh rates and slow frames. */
  update(dt: number, input: PlayerInput = emptyInput()): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    if (
      this.state.phase === "paused" ||
      this.state.phase === "menu" ||
      this.state.phase === "ended"
    ) {
      this.pendingInput = emptyInput();
      this.timeRemainder = 0;
      return;
    }
    this.pendingInput = {
      ...input,
      attackPressed: input.attackPressed ?? this.pendingInput.attackPressed,
      jump: input.jump || this.pendingInput.jump,
      step: input.step || this.pendingInput.step,
      cancel: input.cancel || this.pendingInput.cancel,
      grab: input.grab || this.pendingInput.grab,
    };
    this.timeRemainder += Math.min(dt, 0.1);
    while (this.timeRemainder >= RULES.fixedStep - 1e-8) {
      this.tick(RULES.fixedStep, this.pendingInput);
      this.pendingInput = {
        ...input,
        attackPressed: null,
        jump: false,
        step: false,
        cancel: false,
        grab: false,
      };
      this.timeRemainder -= RULES.fixedStep;
    }
  }

  private tick(dt: number, playerInput: PlayerInput): void {
    const state = this.state;
    if (state.phase === "paused" || state.phase === "ended" || state.phase === "menu") return;
    if (state.phase === "countdown") {
      state.countdown = Math.max(0, state.countdown - dt);
      if (state.countdown <= 0) {
        state.phase = "playing";
        this.announce(state.mode === "training" ? "練習開始 — 相手は動きません" : "FIGHT");
      }
      return;
    }

    state.elapsed += dt;
    state.messageTime = Math.max(0, state.messageTime - dt);
    state.effects = state.effects.filter((effect) => (effect.life -= dt) > 0);
    this.updateArena(dt);
    this.inputs.clear();
    for (const f of state.fighters) {
      if ((f.mode as Fighter["mode"]) === "dead") continue;
      this.inputs.set(f.id, f.human ? playerInput : this.ai(f, dt));
    }
    for (const f of state.fighters) {
      if ((f.mode as Fighter["mode"]) === "dead") continue;
      const input = this.inputs.get(f.id)!;
      f.diInput = { ...input.move };
      this.updateZone(f, dt);
      if ((f.mode as Fighter["mode"]) === "dead") continue;
      f.invulnerable = Math.max(0, f.invulnerable - dt);
      if (f.hitstop > 0) {
        f.hitstop = Math.max(0, f.hitstop - dt);
        if (f.hitstop > 0) continue;
        this.applyLaunch(f);
      }
      f.staminaDelay = Math.max(0, f.staminaDelay - dt);
      if (f.staminaDelay <= 0 && (f.mode === "idle" || f.mode === "hitstun")) {
        f.stamina = Math.min(RULES.maxStamina, f.stamina + RULES.staminaRegen * dt);
      }
      this.updateMode(f, input, dt);
      if (f.mode === "dead") continue;
      this.handleInput(f, input, dt);
      this.physics(f, input, dt);
    }
    this.separateBodies();
    this.resolveCombat();
    this.updateBombs(dt);
    this.resolveOutcome();
  }

  private setMode(f: Fighter, mode: Fighter["mode"], duration = 0): void {
    f.mode = mode;
    f.modeTime = 0;
    f.modeDuration = duration;
  }

  private spend(f: Fighter, cost: number): boolean {
    if (f.stamina + 1e-6 < cost) {
      if (f.human) this.announce("スタミナ不足 — 歩いて間合いを取り直そう", 0.8);
      return false;
    }
    f.stamina = Math.max(0, f.stamina - cost);
    f.staminaDelay = RULES.staminaDelay;
    return true;
  }

  private handleInput(f: Fighter, input: PlayerInput, dt: number): void {
    if ((f.mode === "idle" || f.mode === "charge") && !input.step) {
      const aim = input.aim && length(input.aim) > 0.05 ? input.aim : input.move;
      if (length(aim) > 0.05) {
        const target = Math.atan2(aim.x, aim.z);
        f.facing += clamp(
          angleDelta(f.facing, target),
          -dt * (f.mode === "charge" ? 3.6 : 20),
          dt * (f.mode === "charge" ? 3.6 : 20),
        );
      }
    }
    if (f.mode === "charge") {
      if (input.step && f.grounded && this.spend(f, RULES.stepCost)) {
        this.startStep(f, input.move, true);
      } else if (input.cancel) {
        this.setMode(f, "cancel", RULES.cancelDuration);
        f.attack = null;
        f.charge = 0;
        f.staminaDelay = RULES.staminaDelay;
        this.effect("cancel", f, 0xbbe4dc, 0.28);
      } else if (input.attackHeld !== f.attack || f.modeTime >= RULES.maxHold) {
        this.commitAttack(f);
      }
      return;
    }
    if (f.mode !== "idle") return;
    if (input.step && f.grounded && this.spend(f, RULES.stepCost)) {
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

  private startStep(f: Fighter, direction: Vec2, feint: boolean): void {
    this.setMode(f, "step", RULES.stepDuration);
    const dir = length(direction) > 0.05 ? normalize(direction) : forward(f);
    f.stepDirection = dir;
    f.stepDelay = feint ? RULES.feintStepDelay : 0;
    f.attack = null;
    f.charge = 0;
    this.effect("step", f, f.color, 0.32);
    if (f.human) this.state.stats.dodges++;
  }

  private updateMode(f: Fighter, input: PlayerInput, dt: number): void {
    if (f.mode === "step" && f.stepDelay > 0) {
      f.stepDelay = Math.max(0, f.stepDelay - dt);
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
    if (this.state.arena.windActive && f.grounded && f.mode !== "throw") {
      f.x += this.state.arena.wind.x * dt;
      f.z += this.state.arena.wind.z * dt;
    }
    f.vx *= Math.exp(-dt * (f.grounded ? 6 : 1.9));
    f.vz *= Math.exp(-dt * (f.grounded ? 6 : 1.9));
    if (f.grounded && !canStandAt(this.state, f.x, f.z)) {
      f.grounded = false;
      if (f.attack === "thrust" && (f.mode === "active" || f.mode === "recovery"))
        f.airThrustUsed = true;
    }
    if (!f.grounded) {
      f.vy -= RULES.gravity * dt;
      f.y += f.vy * dt;
      if (previousY >= -0.08 && f.y <= 0 && f.vy <= 0 && canStandAt(this.state, f.x, f.z)) {
        f.y = 0;
        f.vy = 0;
        f.grounded = true;
        f.airRisingUsed = false;
        f.airThrustUsed = false;
        this.effect("land", f, 0xbed9cc, 0.3);
      }
    } else {
      f.y = 0;
      f.vy = 0;
    }
    if (f.y < -9 || Math.hypot(f.x, f.z) > 26) this.eliminate(f, "場外に落下");
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
          isInvulnerable(target) ||
          target.mode === "grabbed"
        )
          continue;
        if (attackContains(attacker, target)) {
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
      target.damage += definition.damage * multiplier;
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
    f.lastAttacker = attackerId;
    f.attack = null;
    f.charge = 0;
    this.setMode(f, "hitstun", duration);
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
    target.damage += 6;
    const force = 7.5 + target.damage * 0.065;
    const dir = normalize(f.throwDirection);
    this.receiveHit(target, f.id, { x: dir.x * force, y: 6, z: dir.z * force }, 0.42, 0.06);
    target.invulnerable = 0.15;
    this.effect("throw", target, f.color, 0.4);
  }

  private updateArena(_dt: number): void {
    const { arena, elapsed, mode } = this.state;
    if (mode === "training") return;
    arena.warningRing =
      arena.halfSize > RULES.minHalfSize && elapsed >= arena.nextCollapse - RULES.collapseWarning;
    if (elapsed >= arena.nextCollapse && arena.halfSize > RULES.minHalfSize) {
      arena.halfSize = Math.max(RULES.minHalfSize, arena.halfSize - RULES.tileSize);
      arena.nextCollapse += RULES.collapseInterval;
      arena.warningRing = false;
      this.announce("外周の足場が崩れた", 2);
    }
    const zone = arena.safeZone;
    zone.active = elapsed >= RULES.safeZoneStart;
    if (zone.active) {
      const progress = clamp((elapsed - RULES.safeZoneStart) / 100, 0, 1);
      zone.radius = Math.min(arena.halfSize * 0.94, 8.4 - progress * 5.7);
      const margin = Math.max(0, arena.halfSize - zone.radius - 0.12);
      zone.x = Math.sin(elapsed * 0.055) * margin;
      zone.z = Math.cos(elapsed * 0.07) * margin;
    }
    arena.windActive = elapsed >= 24 && Math.floor(elapsed / 12) % 3 === 2;
    arena.wind = arena.windActive
      ? { x: Math.sin(elapsed * 0.1) * 0.35, z: Math.cos(elapsed * 0.1) * 0.25 }
      : { x: 0, z: 0 };
    if (elapsed >= this.nextBomb) {
      this.nextBomb += RULES.bombInterval;
      const count = this.state.mode === "rumble" ? 3 : 2;
      for (let i = 0; i < count; i++) {
        const extent = arena.halfSize - 1.2;
        this.state.bombs.push({
          id: this.bombId++,
          x: (this.random() * 2 - 1) * extent,
          z: (this.random() * 2 - 1) * extent,
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
      f.damage += RULES.outsideDamage * dt;
      if (f.outsideTime >= RULES.outsideLimit - 1e-6)
        this.eliminate(f, "エリア外ゲージが5秒に到達");
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
          isInvulnerable(f) ||
          Math.hypot(f.x - bomb.x, f.z - bomb.z) > bomb.radius + 0.3 ||
          f.y > 3
        )
          continue;
        f.damage += 10;
        const dir = normalize({ x: f.x - bomb.x + 0.01, z: f.z - bomb.z });
        this.receiveHit(f, null, { x: dir.x * 4, y: 6, z: dir.z * 4 }, 0.32, 0.065);
      }
    }
    this.state.bombs = this.state.bombs.filter((bomb) => bomb.timer > -0.7);
  }

  private eliminate(f: Fighter, reason: string): void {
    if (f.mode === "dead") return;
    this.breakGrab(f);
    this.setMode(f, "dead");
    f.eliminatedAt = this.state.elapsed;
    f.eliminationReason = reason;
    const attacker = this.state.fighters.find((other) => other.id === f.lastAttacker);
    if (attacker && attacker.id !== f.id) attacker.kills++;
    this.effect("ko", { x: f.x, y: Math.max(-2, f.y), z: f.z }, f.color, 1.2, 1.8);
    this.announce(f.name + " OUT", 1.8);
  }

  private resolveOutcome(): void {
    const state = this.state;
    if (state.mode === "training") {
      for (let i = 0; i < state.fighters.length; i++) {
        const f = state.fighters[i];
        if (f.mode === "dead" && state.elapsed - (f.eliminatedAt ?? 0) > 1.5) {
          state.fighters[i] = makeFighter(f.id, 2);
        }
      }
      return;
    }
    const alive = state.fighters.filter((f) => f.mode !== "dead");
    if (alive.length <= 1) {
      state.winnerId = alive[0]?.id ?? null;
      state.phase = "ended";
      this.announce(alive[0] ? alive[0].name + " WINS" : "DRAW", 10);
    } else if (state.elapsed >= RULES.maxMatchTime) {
      const sorted = [...alive].sort((a, b) => a.damage - b.damage);
      state.winnerId = Math.abs(sorted[0].damage - sorted[1].damage) < 0.01 ? null : sorted[0].id;
      state.phase = "ended";
      this.announce("TIME UP — 蓄積ダメージの少ない選手が勝利", 10);
    }
  }

  private ai(f: Fighter, dt: number): PlayerInput {
    const input = emptyInput();
    if (this.state.mode === "training") return input;
    const enemies = this.state.fighters.filter(
      (other) => other.id !== f.id && other.mode !== "dead",
    );
    const enemy = enemies.sort(
      (a, b) => Math.hypot(a.x - f.x, a.z - f.z) - Math.hypot(b.x - f.x, b.z - f.z),
    )[0];
    if (!enemy) return input;
    const toEnemy = { x: enemy.x - f.x, z: enemy.z - f.z };
    const distance = length(toEnemy);
    const dir = normalize(toEnemy);
    input.aim = dir;
    const zone = this.state.arena.safeZone;
    const outside = zone.active && Math.hypot(f.x - zone.x, f.z - zone.z) > zone.radius - 0.5;
    const edge = Math.max(Math.abs(f.x), Math.abs(f.z)) > this.state.arena.halfSize - 0.8;
    if (!f.grounded && !canStandAt(this.state, f.x, f.z)) {
      const home = normalize({ x: -f.x, z: -f.z });
      input.move = home;
      input.aim = home;
      if (f.mode === "idle") {
        if (!f.airRisingUsed && f.y < 0.8) input.attackPressed = "rising";
        else if (!f.airThrustUsed) input.attackPressed = "thrust";
        input.attackHeld = input.attackPressed;
      } else if (f.mode === "charge") input.attackHeld = null;
      return input;
    }
    if (f.mode === "charge") {
      input.attackHeld = f.modeTime < f.aiCharge ? f.attack : null;
      // Occasional deliberate feint; never perfectly react to the player's input.
      if (
        f.modeTime > 0.18 &&
        enemy.mode === "windup" &&
        distance < 2.4 &&
        f.stamina >= 25 &&
        f.aiCharge > 0.4
      ) {
        input.step = true;
        input.move = { x: dir.z, z: -dir.x };
      }
      return input;
    }
    if (outside || edge) input.move = normalize({ x: zone.x - f.x, z: zone.z - f.z });
    else if (distance > 2.4) input.move = dir;
    else if (distance < 1.5 || f.stamina < 28) input.move = { x: -dir.x, z: -dir.z };
    else input.move = { x: dir.z * 0.5, z: -dir.x * 0.5 };
    const danger = this.state.bombs.find(
      (b) => !b.exploded && Math.hypot(f.x - b.x, f.z - b.z) < b.radius + 0.6,
    );
    if (danger) input.move = normalize({ x: f.x - danger.x + 0.1, z: f.z - danger.z });
    f.aiThink -= dt;
    if (f.mode !== "idle" || f.aiThink > 0) return input;
    f.aiThink = 0.18 + this.random() * 0.16;
    if (
      (enemy.mode === "windup" || (danger && danger.timer < 0.7)) &&
      distance < 3.4 &&
      f.stamina >= 25 &&
      this.random() < 0.7 &&
      !edge
    ) {
      input.step = true;
      input.move = enemy.attack === "sweep" ? { x: -dir.x, z: -dir.z } : { x: dir.z, z: -dir.x };
    } else if (distance < 3.3 && f.stamina >= 30 && !outside) {
      if (distance < 1.2 && this.random() < 0.22) input.grab = true;
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
        input.attackHeld = input.attackPressed;
        f.aiCharge = this.random() < 0.3 ? 0.4 + this.random() * 0.5 : 0.03;
      }
    }
    return input;
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

  private announce(message: string, duration = 1.2): void {
    this.state.message = message;
    this.state.messageTime = duration;
  }
}
