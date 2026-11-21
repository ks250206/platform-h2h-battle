import {
  emptyInput,
  type AttackId,
  type GameState,
  type PlayerInput,
  type PlayerInputs,
  type Vec2,
} from "./types";
import { normalize } from "./combat";
import { screenToWorldMovement } from "./coordinates";
import { cycleTarget, resolveTarget } from "./lockOn";
import { humanSlots, padIndex, type ControlDevice } from "./match";
import {
  anyPressed,
  isDown,
  freshPadMemory,
  readPad,
  readStick,
  rumbleFor,
  type PadCommands,
  type PadMemory,
  type PadSnapshot,
  type RumbleSample,
  type ScreenVec,
} from "./gamepad";
import type { PadHub } from "./pads";

/**
 * Maps a summed screen-space movement (keys, touch stick, gamepad stick) to the world-space
 * ground vector the engine expects, clamped to unit length so diagonals are not faster.
 */
export function screenMoveToWorld(screenX: number, screenY: number): Vec2 {
  const move = screenToWorldMovement(screenX, screenY);
  return Math.hypot(move.x, move.z) > 1 ? normalize(move) : move;
}

const ATTACK_KEYS: Record<string, AttackId> = {
  KeyJ: "overhead",
  KeyI: "rising",
  KeyK: "sweep",
  KeyL: "thrust",
};
const CONTROL_KEYS = new Set([
  ...Object.keys(ATTACK_KEYS),
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "KeyU",
  "KeyQ",
  "KeyE",
  "Space",
  "ShiftLeft",
  "ShiftRight",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Tab",
]);

/** One player's lock-on as the HUD shows it. */
export interface PlayerLock {
  fighterId: number;
  on: boolean;
  targetId: number | null;
}

/** What one device asked for this frame, before the lock-on and the camera are applied. */
interface DeviceFrame {
  /** Screen space: +x right, +y down. */
  move: ScreenVec;
  /** Free aim while unlocked, already in world space; null keeps facing the movement. */
  freeAim: (self: { x: number; z: number }) => Vec2 | null;
  attackPressed: AttackId | null;
  attackHeld: AttackId | null;
  jump: boolean;
  step: boolean;
  cancel: boolean;
  grab: boolean;
  toggleLock: boolean;
  cycle: -1 | 0 | 1;
}

/** Seconds between two target switches from the mouse wheel (a trackpad sends bursts). */
const WHEEL_COOLDOWN = 0.18;

export interface BattleInputHooks {
  /** Ray-casts a pointer position onto the ground. */
  toWorld: (x: number, y: number) => Vec2 | null;
  /** Esc, or Start on a pad that plays in the match. */
  onPause: () => void;
  /** Any press: unlocks audio. */
  onGesture: () => void;
  /** The follow-camera toggle (V, or View on any pad): one shared view setting. */
  onCameraToggle: () => void;
  /** A pad that drives a fighter of the running match went away (1-based pad number). */
  onPadLost: (padNumber: number) => void;
  /** The パッドの振動 setting. */
  rumble: () => boolean;
}

/** The device of each human fighter of the running match, by fighter id. */
function devicesOf(state: GameState): Map<number, ControlDevice> {
  return new Map(
    humanSlots(state.options, state.fighters.length)
      .filter(({ id }) => state.fighters.some((f) => f.id === id && f.human))
      .map(({ id, device }) => [id, device]),
  );
}

/** Controls down at a training/menu handoff stay released until the physical button
 * or stick returns to neutral. Other controls remain available immediately. */
export class TrainingPadRelease {
  private readonly buttons: Set<number>;
  private readonly sticks: Set<number>;

  constructor(pad: PadSnapshot) {
    this.buttons = new Set(pad.buttons.flatMap((_, i) => (isDown(pad, i) ? [i] : [])));
    this.sticks = new Set(
      [0, 2].filter((i) => {
        const stick = readStick(pad.axes, i);
        return stick.x !== 0 || stick.y !== 0;
      }),
    );
  }

  filter(pad: PadSnapshot): PadSnapshot {
    const buttons = pad.buttons.map((button, i) => {
      if (!isDown(pad, i)) this.buttons.delete(i);
      return this.buttons.has(i) ? { pressed: false, value: 0 } : button;
    });
    const axes = [...pad.axes];
    for (const i of this.sticks) {
      const stick = readStick(axes, i);
      if (!stick.x && !stick.y) this.sticks.delete(i);
      else axes[i] = axes[i + 1] = 0;
    }
    return { axes, buttons };
  }

  get ready() {
    return !this.buttons.size && !this.sticks.size;
  }
}

/**
 * Every human's input for a frame: the keyboard with the mouse (or the touch controls) for at
 * most one player, and one gamepad each for the others. Each player keeps their own lock-on.
 */
export class BattleInput {
  // ---- the keyboard / mouse / touch player
  private held = new Set<string>();
  private edges = emptyInput();
  private keyToggleLock = false;
  private keyCycle: -1 | 0 | 1 = 0;
  private mouse: { x: number; y: number } | null = null;
  private touchMove: ScreenVec = { x: 0, y: 0 };
  private touchAttack: AttackId | null = null;
  private mouseAttack: AttackId | null = null;
  private joystickId: number | null = null;
  private lastWheel = 0;
  private readonly touch: HTMLElement;
  private readonly touchTarget: HTMLElement;
  private readonly abort = new AbortController();
  // ---- the pads
  private padPrevious: (PadSnapshot | null)[] = [];
  private trainingPadRelease = new Map<number, TrainingPadRelease>();
  private padMemory: PadMemory[] = [];
  /** Pads seen connected during the running match, so a disconnect is reported once. */
  private padsSeen = new Set<number>();
  private rumbleSamples = new Map<number, RumbleSample>();
  // ---- shared
  /**
   * Lock-on per fighter id: on until that player turns it off, and remembered for the page
   * session. While on, the aim always points at the target; mouse, arrows and stick do not aim.
   */
  private readonly sessionLocks = new Map<number, { on: boolean; targetId: number | null }>();
  private locks = this.sessionLocks;
  private heldMenuSticks = new Map<number, { move: boolean; aim: boolean }>();
  private devices = new Map<number, ControlDevice>();
  private previousPhase = "";
  private active = false;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly pads: PadHub,
    private readonly hooks: BattleInputHooks,
  ) {
    const signal = this.abort.signal;
    window.addEventListener("keydown", this.keyDown, { signal });
    window.addEventListener("keyup", this.keyUp, { signal });
    window.addEventListener("blur", () => this.reset(), { signal });
    canvas.addEventListener(
      "pointermove",
      (event) => {
        if (event.pointerType !== "touch") this.mouse = { x: event.clientX, y: event.clientY };
      },
      { signal },
    );
    canvas.addEventListener(
      "pointerdown",
      (event) => {
        this.hooks.onGesture();
        if (event.pointerType === "touch") return;
        if (event.button === 1) {
          // Middle button: no auto-scroll, toggle the lock-on instead.
          event.preventDefault();
          if (this.inMatch()) this.keyToggleLock = true;
          return;
        }
        const attack = event.button === 0 ? "overhead" : event.button === 2 ? "sweep" : null;
        if (attack) {
          this.edges.attackPressed = attack;
          this.mouseAttack = attack;
        }
      },
      { signal },
    );
    window.addEventListener(
      "pointerup",
      (event) => {
        if (event.pointerType !== "touch") this.mouseAttack = null;
      },
      { signal },
    );
    canvas.addEventListener("contextmenu", (event) => event.preventDefault(), { signal });
    canvas.addEventListener(
      "wheel",
      (event) => {
        if (!this.inMatch()) return;
        event.preventDefault();
        const now = performance.now() / 1000;
        if (event.deltaY === 0 || now - this.lastWheel < WHEEL_COOLDOWN) return;
        this.lastWheel = now;
        this.keyCycle = event.deltaY > 0 ? 1 : -1;
      },
      { signal, passive: false },
    );
    this.touch = document.createElement("div");
    this.touch.className = "touch-controls";
    this.touch.innerHTML =
      '<div class="touch-stick" aria-label="移動スティック"><span class="stick-label">MOVE</span><span class="stick-knob"></span></div>' +
      '<div class="touch-actions"><div class="touch-extra" hidden><button data-command="target" class="touch-target" aria-label="相手切替">⇄<small>相手切替</small></button></div><div class="touch-attacks"><button data-attack="rising" aria-label="振り上げ">↗<small>上昇</small></button><button data-attack="overhead" aria-label="振り下ろし">↓<small>振下</small></button><button data-attack="sweep" aria-label="横振り">↔<small>横振</small></button><button data-attack="thrust" aria-label="突き">→<small>突き</small></button></div>' +
      '<div class="touch-utility"><button data-command="jump">跳ぶ</button><button data-command="step">回避</button><button data-command="cancel">取消</button><button data-command="grab">掴む</button></div></div>';
    document.getElementById("app")!.append(this.touch);
    this.touchTarget = this.touch.querySelector<HTMLElement>(".touch-extra")!;
    const stick = this.touch.querySelector<HTMLElement>(".touch-stick")!;
    const knob = this.touch.querySelector<HTMLElement>(".stick-knob")!;
    const moveStick = (event: PointerEvent) => {
      const rect = stick.getBoundingClientRect();
      const dx = (event.clientX - rect.left - rect.width / 2) / (rect.width * 0.35);
      const dy = (event.clientY - rect.top - rect.height / 2) / (rect.height * 0.35);
      const d = Math.max(1, Math.hypot(dx, dy));
      this.touchMove = { x: dx / d, y: dy / d };
      knob.style.transform =
        "translate(" + this.touchMove.x * 30 + "px," + this.touchMove.y * 30 + "px)";
    };
    stick.addEventListener(
      "pointerdown",
      (event) => {
        event.preventDefault();
        this.hooks.onGesture();
        if (this.joystickId !== null) return;
        this.joystickId = event.pointerId;
        stick.setPointerCapture(event.pointerId);
        moveStick(event);
      },
      { signal },
    );
    stick.addEventListener(
      "pointermove",
      (event) => {
        if (event.pointerId === this.joystickId) moveStick(event);
      },
      { signal },
    );
    const releaseStick = (event: PointerEvent) => {
      if (event.pointerId !== this.joystickId) return;
      this.joystickId = null;
      this.touchMove = { x: 0, y: 0 };
      knob.style.transform = "";
    };
    stick.addEventListener("pointerup", releaseStick, { signal });
    stick.addEventListener("pointercancel", releaseStick, { signal });
    stick.addEventListener("lostpointercapture", releaseStick, { signal });
    for (const button of this.touch.querySelectorAll<HTMLButtonElement>("button")) {
      button.addEventListener(
        "pointerdown",
        (event) => {
          event.preventDefault();
          this.hooks.onGesture();
          button.setPointerCapture(event.pointerId);
          const attack = button.dataset.attack as AttackId | undefined;
          if (attack) {
            this.touchAttack = attack;
            this.edges.attackPressed = attack;
          }
          const command = button.dataset.command as
            | "jump"
            | "step"
            | "cancel"
            | "grab"
            | "target"
            | undefined;
          if (command === "target") this.keyCycle = 1;
          else if (command) this.edges[command] = true;
          button.classList.add("pressed");
        },
        { signal },
      );
      const release = () => {
        if (button.dataset.attack === this.touchAttack) this.touchAttack = null;
        button.classList.remove("pressed");
      };
      button.addEventListener("pointerup", release, { signal });
      button.addEventListener("pointercancel", release, { signal });
      button.addEventListener("lostpointercapture", release, { signal });
    }
  }

  private keyboardPlays(): boolean {
    return [...this.devices.values()].includes("keyboard");
  }

  private keyDown = (event: KeyboardEvent): void => {
    if (document.querySelector("dialog[open]")) return;
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement ||
      event.target instanceof HTMLSelectElement
    )
      return;
    if (event.code === "Escape" && !event.repeat) {
      this.hooks.onPause();
      return;
    }
    if (
      event.code === "KeyV" &&
      !event.repeat &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      this.hooks.onCameraToggle();
      return;
    }
    if (!this.inMatch() || !this.keyboardPlays()) return;
    if (!CONTROL_KEYS.has(event.code)) return;
    event.preventDefault();
    this.hooks.onGesture();
    if (event.repeat || this.held.has(event.code)) return;
    this.held.add(event.code);
    if (event.code === "Tab") this.keyToggleLock = true;
    if (event.code === "KeyE") this.keyCycle = 1;
    if (ATTACK_KEYS[event.code]) this.edges.attackPressed = ATTACK_KEYS[event.code];
    if (event.code === "Space") this.edges.jump = true;
    if (event.code.startsWith("Shift")) this.edges.step = true;
    if (event.code === "KeyQ") this.edges.cancel = true;
    if (event.code === "KeyU") this.edges.grab = true;
  };
  private keyUp = (event: KeyboardEvent): void => {
    this.held.delete(event.code);
  };

  /** The keyboard / mouse / touch player's frame; consumes the pending presses. */
  private keyboardFrame(): DeviceFrame {
    const key = (code: string) => Number(this.held.has(code));
    let attackHeld: AttackId | null = this.touchAttack ?? this.mouseAttack;
    for (const [code, attack] of Object.entries(ATTACK_KEYS))
      if (this.held.has(code)) attackHeld = attack;
    const arrows = {
      x: key("ArrowRight") - key("ArrowLeft"),
      y: key("ArrowDown") - key("ArrowUp"),
    };
    const mouse = this.mouse;
    const frame: DeviceFrame = {
      ...this.edges,
      move: {
        x: key("KeyD") - key("KeyA") + this.touchMove.x,
        y: key("KeyS") - key("KeyW") + this.touchMove.y,
      },
      // Free aim: arrow keys, then the mouse (ray-cast onto the ground, so already world space).
      freeAim: (self) => {
        if (arrows.x || arrows.y) return screenToWorldMovement(arrows.x, arrows.y);
        const world = mouse && this.hooks.toWorld(mouse.x, mouse.y);
        return world ? { x: world.x - self.x, z: world.z - self.z } : null;
      },
      attackHeld,
      toggleLock: this.keyToggleLock,
      cycle: this.keyCycle,
    };
    this.clearKeyboardPresses();
    return frame;
  }

  private clearKeyboardPresses(): void {
    this.edges = emptyInput();
    this.keyToggleLock = false;
    this.keyCycle = 0;
  }

  /** A pad player's frame from that pad's commands. */
  private padFrame(commands: PadCommands): DeviceFrame {
    const aim = commands.aim;
    return {
      ...commands,
      freeAim: () => (aim ? screenToWorldMovement(aim.x, aim.y) : null),
    };
  }

  /** Held buttons at a takeover count as already pressed: nothing fires until they come up. */
  private takeOverPads(): void {
    this.heldMenuSticks.clear();
    if (this.locks !== this.sessionLocks) {
      this.pads.current.forEach((pad, index) => {
        if (!pad) return;
        const held = (axis: number) => {
          const stick = readStick(pad.axes, axis);
          return Boolean(stick.x || stick.y);
        };
        this.heldMenuSticks.set(index, { move: held(0), aim: held(2) });
      });
    }
    this.padPrevious = this.pads.current.slice();
    this.padMemory = this.pads.current.map(() => freshPadMemory());
  }

  private lockFor(fighterId: number) {
    let lock = this.locks.get(fighterId);
    if (!lock) {
      lock = { on: true, targetId: null };
      this.locks.set(fighterId, lock);
    }
    return lock;
  }

  /** Applies the lock-on and the camera to a device frame. */
  private toPlayerInput(state: GameState, fighterId: number, frame: DeviceFrame): PlayerInput {
    const f = state.fighters.find((fighter) => fighter.id === fighterId)!;
    const lock = this.lockFor(fighterId);
    if (frame.toggleLock) {
      lock.on = !lock.on;
      // Turned on, it picks the nearest opponent below.
      lock.targetId = null;
    }
    let aim: Vec2 | null = null;
    if (lock.on) {
      // Sticky on the same fighter; re-acquires the nearest when it goes down or is gone.
      lock.targetId = resolveTarget(state, f.id, lock.targetId);
      if (frame.cycle) lock.targetId = cycleTarget(state, f.id, lock.targetId, frame.cycle);
      const target = state.fighters.find((other) => other.id === lock.targetId);
      if (target) aim = { x: target.x - f.x, z: target.z - f.z };
    } else {
      aim = frame.freeAim(f);
      if (aim && Math.hypot(aim.x, aim.z) === 0) aim = null;
    }
    return {
      // Keys, sticks and arrows are screen directions; the engine works on the world ground.
      move: screenMoveToWorld(frame.move.x, frame.move.y),
      aim,
      attackPressed: frame.attackPressed,
      attackHeld: frame.attackHeld,
      jump: frame.jump,
      step: frame.step,
      cancel: frame.cancel,
      grab: frame.grab,
    };
  }

  /**
   * One input per human fighter of `state`, each from that fighter's device. Also handles the
   * pads' Start (pause) and View (camera), the pad-lost check and the rumble.
   */
  sample(state: GameState, touchAutoLock = false): PlayerInputs {
    const inputs: PlayerInputs = {};
    if (touchAutoLock) this.lockFor(0).on = true;
    this.watchPads(state);
    const active =
      (state.phase === "playing" || state.phase === "countdown") &&
      !document.querySelector("dialog[open]");
    if (active && !this.active) {
      this.takeOverPads();
      this.trainingPadRelease.clear();
      if (state.mode === "training")
        this.pads.current.forEach((pad, index) => {
          if (pad) this.trainingPadRelease.set(index, new TrainingPadRelease(pad));
        });
    }
    this.active = active;
    if (!active) {
      this.clearKeyboardPresses();
      return inputs;
    }
    // Every connected pad is read once a frame, whether it plays or not.
    const commands = new Map<number, PadCommands>();
    this.pads.current.forEach((raw, index) => {
      if (!raw) {
        this.trainingPadRelease.delete(index);
        return;
      }
      const release = this.trainingPadRelease.get(index);
      const current = release ? release.filter(raw) : raw;
      if (release?.ready) this.trainingPadRelease.delete(index);
      const previous = this.padPrevious[index] ?? null;
      const result = readPad(current, previous, this.padMemory[index] ?? freshPadMemory());
      if (anyPressed(current, previous)) this.hooks.onGesture();
      this.padPrevious[index] = current;
      this.padMemory[index] = result.memory;
      const held = this.heldMenuSticks.get(index);
      if (held?.move) {
        held.move = Boolean(result.commands.move.x || result.commands.move.y);
        result.commands.move = { x: 0, y: 0 };
      }
      if (held?.aim) {
        held.aim = result.commands.aim !== null;
        result.commands.aim = null;
        result.commands.cycle = 0;
      }
      commands.set(index, result.commands);
    });
    let pause = false;
    for (const [fighterId, device] of this.devices) {
      const pad = padIndex(device);
      const read = pad === null ? null : commands.get(pad);
      if (read) pause ||= read.pause;
      const frame = pad === null ? this.keyboardFrame() : read && this.padFrame(read);
      if (frame) inputs[fighterId] = this.toPlayerInput(state, fighterId, frame);
    }
    if (!this.keyboardPlays()) this.clearKeyboardPresses();
    // View on any pad toggles the shared camera; Start pauses only from a pad that plays.
    if ([...commands.values()].some((read) => read.camera)) this.hooks.onCameraToggle();
    if (pause) this.hooks.onPause();
    this.feelHits(state);
    return inputs;
  }

  /** Every lock-on of the running match's humans, in fighter order. */
  get playerLocks(): PlayerLock[] {
    return [...this.devices.keys()]
      .sort((a, b) => a - b)
      .map((fighterId) => {
        const lock = this.lockFor(fighterId);
        return { fighterId, on: lock.on, targetId: lock.on ? lock.targetId : null };
      });
  }

  /** Reports a pad of the running match that went away, once per disconnect. */
  private watchPads(state: GameState): void {
    const inMatch = ["playing", "countdown", "paused"].includes(state.phase);
    for (const device of this.devices.values()) {
      const pad = padIndex(device);
      if (pad === null) continue;
      if (this.pads.isConnected(pad)) this.padsSeen.add(pad);
      else if (this.padsSeen.delete(pad) && inMatch) this.hooks.onPadLost(pad + 1);
    }
  }

  /** A short rumble on a pad player's pad when they are hit, land a hit or clash. */
  private feelHits(state: GameState): void {
    const enabled = this.hooks.rumble();
    for (const f of state.fighters) {
      const sample: RumbleSample = { mode: f.mode, hitstop: f.hitstop, damage: f.damage };
      const previous = this.rumbleSamples.get(f.id) ?? null;
      this.rumbleSamples.set(f.id, sample);
      const device = this.devices.get(f.id);
      const pad = device ? padIndex(device) : null;
      if (pad === null || !enabled) continue;
      const effect = rumbleFor(previous, sample);
      if (effect) this.pads.rumble(pad, effect);
    }
  }

  /** A new match or a restart: every lock that is on picks the nearest opponent afresh. */
  newMatch(isolatedLocks = false): void {
    this.heldMenuSticks.clear();
    if (!isolatedLocks) this.locks = this.sessionLocks;
    else if (this.locks === this.sessionLocks) this.locks = new Map();
    for (const lock of this.locks.values()) lock.targetId = null;
    this.padsSeen.clear();
    this.rumbleSamples.clear();
    this.active = false;
  }

  private inMatch(): boolean {
    return this.previousPhase === "playing" || this.previousPhase === "countdown";
  }

  updateVisibility(state: GameState): void {
    this.devices = devicesOf(state);
    const inMatch = state.phase === "playing" || state.phase === "countdown";
    // The touch controls belong to the keyboard player's slot.
    this.touch.hidden = !inMatch || !this.keyboardPlays();
    // Only rumble has more than one opponent to switch between.
    this.touchTarget.hidden = state.fighters.length <= 2;
    if (this.previousPhase !== state.phase && ["menu", "paused", "ended"].includes(state.phase))
      this.reset();
    this.previousPhase = state.phase;
  }
  /**
   * In-play device switch (e.g. a tutorial switching from keyboard to a pad mid-lesson): clears
   * stale keyboard/touch state without re-arming menu-takeover pad suppression, so the stick
   * movement that selected the pad moves the fighter on the same frame.
   */
  switchDevice(): void {
    this.held.clear();
    this.clearKeyboardPresses();
    this.mouse = null;
    this.mouseAttack = null;
    this.touchAttack = null;
    this.touchMove = { x: 0, y: 0 };
    this.joystickId = null;
    this.touch.querySelector<HTMLElement>(".stick-knob")!.style.transform = "";
    this.touch.querySelectorAll(".pressed").forEach((button) => button.classList.remove("pressed"));
    this.padsSeen.clear();
    this.rumbleSamples.clear();
  }
  reset(): void {
    this.active = false;
    this.held.clear();
    this.clearKeyboardPresses();
    this.mouse = null;
    this.mouseAttack = null;
    this.touchAttack = null;
    this.touchMove = { x: 0, y: 0 };
    this.joystickId = null;
    this.touch.querySelector<HTMLElement>(".stick-knob")!.style.transform = "";
    this.touch.querySelectorAll(".pressed").forEach((button) => button.classList.remove("pressed"));
  }
  destroy(): void {
    this.abort.abort();
    this.touch.remove();
  }
}
