import {
  emptyInput,
  type AttackId,
  type Fighter,
  type GameState,
  type PlayerInput,
  type Vec2,
} from "./types";
import { normalize } from "./combat";

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
  "Space",
  "ShiftLeft",
  "ShiftRight",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Tab",
]);

export class BattleInput {
  private held = new Set<string>();
  private edges = emptyInput();
  private mouse: { x: number; y: number } | null = null;
  private touchMove: Vec2 = { x: 0, z: 0 };
  private touchAttack: AttackId | null = null;
  private mouseAttack: AttackId | null = null;
  private joystickId: number | null = null;
  private readonly touch: HTMLElement;
  private readonly abort = new AbortController();
  private lastGamepadButtons: boolean[] = [];
  private previousPhase = "";
  private gamepadAim: Vec2 | null = null;
  private gamepadMove: Vec2 = { x: 0, z: 0 };
  private gamepadAttack: AttackId | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private toWorld: (x: number, y: number) => Vec2 | null,
    private onPause: () => void,
    private onGesture: () => void,
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
        this.onGesture();
        if (event.pointerType === "touch") return;
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
    this.touch = document.createElement("div");
    this.touch.className = "touch-controls";
    this.touch.innerHTML =
      '<div class="touch-stick" aria-label="移動スティック"><span class="stick-label">MOVE</span><span class="stick-knob"></span></div>' +
      '<div class="touch-actions"><div class="touch-attacks"><button data-attack="rising" aria-label="振り上げ">↗<small>上昇</small></button><button data-attack="overhead" aria-label="振り下ろし">↓<small>振下</small></button><button data-attack="sweep" aria-label="横振り">↔<small>横振</small></button><button data-attack="thrust" aria-label="突き">→<small>突き</small></button></div>' +
      '<div class="touch-utility"><button data-command="jump">跳ぶ</button><button data-command="step">回避</button><button data-command="cancel">取消</button><button data-command="grab">掴む</button></div></div>';
    document.getElementById("app")!.append(this.touch);
    const stick = this.touch.querySelector<HTMLElement>(".touch-stick")!;
    const knob = this.touch.querySelector<HTMLElement>(".stick-knob")!;
    const moveStick = (event: PointerEvent) => {
      const rect = stick.getBoundingClientRect();
      const dx = (event.clientX - rect.left - rect.width / 2) / (rect.width * 0.35);
      const dz = (event.clientY - rect.top - rect.height / 2) / (rect.height * 0.35);
      const d = Math.max(1, Math.hypot(dx, dz));
      this.touchMove = { x: dx / d, z: dz / d };
      knob.style.transform =
        "translate(" + this.touchMove.x * 30 + "px," + this.touchMove.z * 30 + "px)";
    };
    stick.addEventListener(
      "pointerdown",
      (event) => {
        event.preventDefault();
        this.onGesture();
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
      this.touchMove = { x: 0, z: 0 };
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
          this.onGesture();
          button.setPointerCapture(event.pointerId);
          const attack = button.dataset.attack as AttackId | undefined;
          if (attack) {
            this.touchAttack = attack;
            this.edges.attackPressed = attack;
          }
          const command = button.dataset.command as "jump" | "step" | "cancel" | "grab" | undefined;
          if (command) this.edges[command] = true;
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

  private keyDown = (event: KeyboardEvent): void => {
    if (document.querySelector("dialog[open]")) return;
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement ||
      event.target instanceof HTMLSelectElement
    )
      return;
    if (event.code === "Escape" && !event.repeat) {
      this.onPause();
      return;
    }
    if (this.previousPhase !== "playing" && this.previousPhase !== "countdown") return;
    if (!CONTROL_KEYS.has(event.code)) return;
    event.preventDefault();
    this.onGesture();
    if (event.repeat || this.held.has(event.code)) return;
    this.held.add(event.code);
    if (event.code === "Tab") this.mouse = null;
    if (ATTACK_KEYS[event.code]) this.edges.attackPressed = ATTACK_KEYS[event.code];
    if (event.code === "Space") this.edges.jump = true;
    if (event.code.startsWith("Shift")) this.edges.step = true;
    if (event.code === "KeyQ") this.edges.cancel = true;
    if (event.code === "KeyU") this.edges.grab = true;
  };
  private keyUp = (event: KeyboardEvent): void => {
    this.held.delete(event.code);
  };

  private pollGamepad(): void {
    const pad = navigator.getGamepads?.().find((item) => item && item.connected);
    this.gamepadMove = { x: 0, z: 0 };
    this.gamepadAim = null;
    this.gamepadAttack = null;
    if (!pad) {
      this.lastGamepadButtons = [];
      return;
    }
    const deadzone = (value: number) => (Math.abs(value) < 0.18 ? 0 : value);
    this.gamepadMove = { x: deadzone(pad.axes[0] ?? 0), z: deadzone(pad.axes[1] ?? 0) };
    const aim = { x: deadzone(pad.axes[2] ?? 0), z: deadzone(pad.axes[3] ?? 0) };
    if (Math.hypot(aim.x, aim.z) > 0.2) this.gamepadAim = aim;
    const attackButtons: Record<number, AttackId> = {
      0: "overhead",
      1: "sweep",
      2: "thrust",
      3: "rising",
    };
    pad.buttons.forEach((button, index) => {
      const pressed = button.pressed;
      if (pressed && attackButtons[index]) this.gamepadAttack = attackButtons[index];
      if (pressed && !this.lastGamepadButtons[index]) {
        this.onGesture();
        if (attackButtons[index]) this.edges.attackPressed = attackButtons[index];
        if (index === 4) this.edges.step = true;
        if (index === 5) this.edges.jump = true;
        if (index === 6) this.edges.cancel = true;
        if (index === 7) this.edges.grab = true;
        if (index === 9) this.onPause();
      }
    });
    this.lastGamepadButtons = pad.buttons.map((button) => button.pressed);
  }

  sample(state: GameState): PlayerInput {
    this.pollGamepad();
    const f = state.fighters.find((fighter) => fighter.human)!;
    let move = {
      x:
        Number(this.held.has("KeyD")) -
        Number(this.held.has("KeyA")) +
        this.touchMove.x +
        this.gamepadMove.x,
      z:
        Number(this.held.has("KeyS")) -
        Number(this.held.has("KeyW")) +
        this.touchMove.z +
        this.gamepadMove.z,
    };
    if (Math.hypot(move.x, move.z) > 1) move = normalize(move);
    let aim: Vec2 | null = {
      x: Number(this.held.has("ArrowRight")) - Number(this.held.has("ArrowLeft")),
      z: Number(this.held.has("ArrowDown")) - Number(this.held.has("ArrowUp")),
    };
    if (Math.hypot(aim.x, aim.z) === 0) {
      aim = this.gamepadAim;
      if (!aim && this.mouse) {
        const world = this.toWorld(this.mouse.x, this.mouse.y);
        if (world) aim = { x: world.x - f.x, z: world.z - f.z };
      }
      if (!aim && !this.mouse) aim = this.autoAim(f, state);
    }
    let attackHeld: AttackId | null = this.touchAttack ?? this.mouseAttack ?? this.gamepadAttack;
    for (const [key, attack] of Object.entries(ATTACK_KEYS))
      if (this.held.has(key)) attackHeld = attack;
    const result = { ...this.edges, move, aim, attackHeld };
    this.edges = emptyInput();
    return result;
  }

  private autoAim(fighter: Fighter, state: GameState): Vec2 | null {
    const enemy = state.fighters
      .filter((f) => f.id !== fighter.id && f.mode !== "dead")
      .sort(
        (a, b) =>
          Math.hypot(a.x - fighter.x, a.z - fighter.z) -
          Math.hypot(b.x - fighter.x, b.z - fighter.z),
      )[0];
    return enemy ? { x: enemy.x - fighter.x, z: enemy.z - fighter.z } : null;
  }

  updateVisibility(state: GameState): void {
    this.touch.hidden = state.phase !== "playing" && state.phase !== "countdown";
    if (this.previousPhase !== state.phase && ["menu", "paused", "ended"].includes(state.phase))
      this.reset();
    this.previousPhase = state.phase;
  }
  reset(): void {
    this.held.clear();
    this.edges = emptyInput();
    this.mouse = null;
    this.mouseAttack = null;
    this.touchAttack = null;
    this.touchMove = { x: 0, z: 0 };
    this.joystickId = null;
    this.touch.querySelector<HTMLElement>(".stick-knob")!.style.transform = "";
    this.touch.querySelectorAll(".pressed").forEach((button) => button.classList.remove("pressed"));
  }
  destroy(): void {
    this.abort.abort();
    this.touch.remove();
  }
}
