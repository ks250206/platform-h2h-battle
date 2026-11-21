import { clamp, isInvulnerable, normalize } from "./combat";
import { RULES, UKEMI } from "./tuning";
import { armedTech } from "./ukemi";
import { emptyInput, type AttackId, type Fighter, type GameState, type PlayerInput } from "./types";

export const RECORDING_LIMIT = 600;
export const DAMAGE_LIMIT = 999;
export const TRAINING_RESPAWN = 1.5;
export type DummyBehavior = "still" | "repeatAttack" | "move" | "dodge" | "cpu";
export interface TrainingSettings {
  behavior: DummyBehavior;
  attack: AttackId;
  infinite: boolean;
  hitboxes: boolean;
  overlay: boolean;
  loop: boolean;
}

export function trainingDamage(raw: unknown): number | null {
  if (typeof raw !== "number" && (typeof raw !== "string" || !raw.trim())) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? clamp(Math.round(value), 0, DAMAGE_LIMIT) : null;
}

/** The opposite spawn faces the other way. Rotate world-space movement and aim together. */
function mirror(input: PlayerInput): PlayerInput {
  return {
    ...input,
    move: { x: -input.move.x, z: -input.move.z },
    aim: input.aim && { x: -input.aim.x, z: -input.aim.z },
  };
}

export class TrainingSession {
  settings: TrainingSettings = {
    behavior: "still",
    attack: "overhead",
    infinite: false,
    hitboxes: false,
    overlay: false,
    loop: false,
  };
  damage: [number, number] = [0, 0];
  private frames: PlayerInput[] = [];
  transport: "idle" | "recording" | "playing" = "idle";
  cursor = 0;
  get ticks() {
    return this.frames.length;
  }

  stop(): void {
    this.transport = "idle";
    this.cursor = 0;
  }

  record(): void {
    this.frames = [];
    this.cursor = 0;
    this.transport = "recording";
  }

  play(): void {
    this.cursor = 0;
    this.transport = this.ticks ? "playing" : "idle";
  }

  /** Called exactly once per simulation tick, even while either fighter is dead or frozen. */
  sample(player: PlayerInput): PlayerInput | null {
    if (this.transport === "playing") return mirror(this.frames[this.cursor++]!);
    if (this.transport === "recording") {
      this.frames.push({
        ...player,
        move: { ...player.move },
        aim: player.aim && { ...player.aim },
      });
      if (this.ticks === RECORDING_LIMIT) this.stop();
    }
    return null;
  }

  dummy(state: GameState, cpu: () => PlayerInput): PlayerInput {
    const { behavior, attack } = this.settings;
    if (behavior === "cpu") return cpu();
    const input = emptyInput();
    if (behavior === "still") return input;
    const [player, dummy] = state.fighters;
    const toward = normalize({ x: player.x - dummy.x, z: player.z - dummy.z });
    input.aim = toward;
    if (behavior === "repeatAttack" && dummy.mode === "idle") input.attackPressed = attack;
    const sign = Math.floor((state.elapsed + 1e-8) / 0.8) % 2 ? -1 : 1;
    if (behavior === "move") input.move = { x: toward.x * sign, z: toward.z * sign };
    if (behavior === "dodge" && dummy.mode === "idle" && dummy.stamina >= RULES.stepCost) {
      input.step = true;
      input.move = { x: toward.z * sign, z: -toward.x * sign };
    }
    return input;
  }
}

const ticks = (seconds: number) => Math.max(0, Math.ceil(seconds / RULES.fixedStep - 1e-7));

export function trainingSnapshot(state: GameState, f: Fighter) {
  // A grabbed fighter is released by the thrower's clock, including after hitstop.
  const owner = f.mode === "grabbed" ? (state.fighters.find((o) => o.id === f.grabbedBy) ?? f) : f;
  const timer =
    f.mode === "dead"
      ? TRAINING_RESPAWN - (state.elapsed - (f.eliminatedAt ?? state.elapsed))
      : owner.modeDuration - owner.modeTime + (owner.mode === "step" ? owner.stepDelay : 0);
  return {
    mode: f.mode,
    remaining: f.mode === "idle" ? null : ticks(timer),
    hitstop: ticks(f.hitstop),
    cancellable: f.mode === "charge" || f.mode === "windup",
    invulnerable: isInvulnerable(f),
    air: { rising: !f.airRisingUsed, thrust: !f.airThrustUsed, step: !f.airStepUsed },
    buffer: f.inputBuffer && { ...f.inputBuffer },
    tumbling: f.tumbling,
    pendingLaunch: !!f.pendingLaunch,
    techTicks: armedTech(f) ? Math.max(0, UKEMI.windowTicks - f.inputBuffer!.age) : null,
  };
}
