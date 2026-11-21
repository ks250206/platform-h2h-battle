// Reads the connected gamepads once per frame for everything that listens to them (the match
// input, the menu navigation, the title's join shortcut), and plays rumble effects.

import type { PadSnapshot } from "./gamepad";
import type { Rumble } from "./gamepad";

/** Pads the game addresses: パッド1-4 are `navigator.getGamepads()` indices 0-3. */
export const PAD_COUNT = 4;

interface Actuator {
  playEffect?: (type: string, params: Record<string, number>) => Promise<unknown> | unknown;
}

export class PadHub {
  /** This frame's copy of each pad, by index; null when that index has no connected pad. */
  current: (PadSnapshot | null)[] = Array.from({ length: PAD_COUNT }, () => null);
  private raw: (Gamepad | null)[] = Array.from({ length: PAD_COUNT }, () => null);
  private connectedKey = "";
  private readonly listeners = new Set<(connected: number[]) => void>();

  constructor() {
    // Some browsers only list a pad after its first button press, which also fires this event.
    window.addEventListener("gamepadconnected", () => this.poll());
    window.addEventListener("gamepaddisconnected", () => this.poll());
  }

  /** Reads every pad. Copies the values: a browser may update the same objects in place. */
  poll(): void {
    let list: readonly (Gamepad | null)[] = [];
    try {
      list = navigator.getGamepads?.() ?? [];
    } catch {
      // Blocked by a permissions policy: no pads.
    }
    for (let index = 0; index < PAD_COUNT; index++) {
      const pad = list[index];
      if (!pad || !pad.connected) {
        this.current[index] = null;
        this.raw[index] = null;
        continue;
      }
      this.raw[index] = pad;
      this.current[index] = {
        axes: Array.from(pad.axes ?? [], Number),
        buttons: Array.from(pad.buttons ?? [], (button) => ({
          pressed: Boolean(button?.pressed),
          value: Number(button?.value) || 0,
        })),
      };
    }
    const key = this.connected().join(",");
    if (key !== this.connectedKey) {
      this.connectedKey = key;
      const connected = this.connected();
      for (const listener of this.listeners) listener(connected);
    }
  }

  /** Indices (0-3) of the connected pads. */
  connected(): number[] {
    return this.current.flatMap((pad, index) => (pad ? [index] : []));
  }

  isConnected(index: number): boolean {
    return Boolean(this.current[index]);
  }

  /** Called with the connected indices whenever a pad connects or disconnects. */
  subscribe(listener: (connected: number[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A short dual-rumble on pad `index`, where the browser supports it. */
  rumble(index: number, effect: Rumble): void {
    const actuator = (this.raw[index] as (Gamepad & { vibrationActuator?: Actuator }) | null)
      ?.vibrationActuator;
    if (typeof actuator?.playEffect !== "function") return;
    try {
      const result = actuator.playEffect("dual-rumble", { startDelay: 0, ...effect });
      if (result instanceof Promise) result.catch(() => {});
    } catch {
      // An actuator that refuses the effect is the same as none.
    }
  }
}
