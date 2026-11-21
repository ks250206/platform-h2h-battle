// Drives the DOM menus with any connected pad: the title, the pause and result panels, and the
// dialogs. D-pad / left stick move the focus to the nearest control in that direction, A
// activates, B goes back, Start starts (title) or resumes (pause). Gameplay input is separate.

import {
  BUTTON,
  heldNav,
  justPressed,
  menuDirection,
  stepNav,
  type MenuDirection,
  type NavRepeat,
  type PadSnapshot,
} from "../game/gamepad";
import type { PadHub } from "../game/pads";
import type { Phase } from "../game/types";

export type TitleButton = "a" | "start" | "b" | "y";

export interface PadMenuHooks {
  phase: () => Phase;
  openTraining?: () => void;
  resetTraining?: () => void;
  /**
   * The title's shortcuts, asked before a press is used to navigate: A or Start joins, B leaves,
   * Y opens the look picker of that pad's fighter. True when the press did that and should do
   * nothing else.
   */
  titleButton: (padIndex: number, button: TitleButton) => boolean;
}

interface Layer {
  key: string;
  /** Where the focusable controls are looked for. */
  scopes: HTMLElement[];
  /** Focused first, when nothing in the layer has the focus. */
  primary: string;
  back?: () => void;
  start?: () => void;
  /** LB / RB: steps through the layer's tabs (the slots of the look picker). */
  cycle?: (delta: 1 | -1) => void;
}

const FOCUSABLE = "button, select, input, summary, a[href], [tabindex]:not([tabindex='-1'])";

function visible(element: HTMLElement): boolean {
  if (element.closest("[hidden]")) return false;
  if ((element as HTMLButtonElement).disabled) return false;
  if (element.getClientRects().length === 0) return false;
  const style = getComputedStyle(element);
  return style.visibility !== "hidden" && style.display !== "none";
}

/** How far `to` is from `from` going `direction`, or null when it is not that way. */
function distance(from: DOMRect, to: DOMRect, direction: MenuDirection): number | null {
  const fx = from.left + from.width / 2;
  const fy = from.top + from.height / 2;
  const tx = to.left + to.width / 2;
  const ty = to.top + to.height / 2;
  const horizontal = direction === "left" || direction === "right";
  const sign = direction === "right" || direction === "down" ? 1 : -1;
  const along = horizontal ? (tx - fx) * sign : (ty - fy) * sign;
  if (along <= 1) return null;
  // The gap between the two boxes along the move counts double; how far apart they are across it
  // (0 while they overlap) counts once, so the next row wins over a farther control straight on.
  const gap = horizontal
    ? Math.max(0, sign > 0 ? to.left - from.right : from.left - to.right)
    : Math.max(0, sign > 0 ? to.top - from.bottom : from.top - to.bottom);
  const across = horizontal
    ? Math.max(0, Math.max(from.top, to.top) - Math.min(from.bottom, to.bottom))
    : Math.max(0, Math.max(from.left, to.left) - Math.min(from.right, to.right));
  const offset = horizontal ? Math.abs(ty - fy) : Math.abs(tx - fx);
  return gap * 2 + across + offset * 0.1;
}

export class PadMenu {
  private previous: (PadSnapshot | null)[] = [];
  private repeat: NavRepeat[] = [];
  private layerKey: string | null = null;
  private readonly abort = new AbortController();

  constructor(
    private readonly root: HTMLElement,
    private readonly pads: PadHub,
    private readonly hooks: PadMenuHooks,
  ) {
    // The focus ring is drawn for pad navigation only; the mouse or keyboard takes it back.
    const leave = () => {
      if (document.documentElement.dataset.padNav !== undefined)
        delete document.documentElement.dataset.padNav;
    };
    for (const type of ["pointerdown", "keydown", "mousemove"])
      window.addEventListener(type, leave, { signal: this.abort.signal, capture: true });
  }

  private layer(): Layer | null {
    const dialog = this.root.querySelector<HTMLDialogElement>("dialog[open]");
    if (dialog) {
      // A dialog names its own back and start buttons, first control and tabs where it has them
      // (the look picker: B cancels, Start confirms, LB / RB change the slot).
      const close = dialog.querySelector<HTMLElement>("[data-pad-back], [data-action^='close-']");
      const start = dialog.querySelector<HTMLElement>("[data-pad-start]");
      const tabs = dialog.querySelector<HTMLElement>("[data-pad-tabs]");
      return {
        key: "dialog:" + dialog.className,
        scopes: [dialog],
        primary: "[data-pad-primary], .help-done, select, input",
        back: () => close?.click(),
        ...(start ? { start: () => start.click() } : {}),
        ...(tabs
          ? {
              cycle: (delta: 1 | -1) => {
                const buttons = [...tabs.querySelectorAll<HTMLElement>("button")].filter(visible);
                const current = buttons.findIndex((b) => b.getAttribute("aria-pressed") === "true");
                buttons[(current + delta + buttons.length) % buttons.length]?.click();
              },
            }
          : {}),
      };
    }
    const rulesSheet = this.root.querySelector<HTMLElement>(
      ".match-options.rules-open #match-rules-panel",
    );
    if (rulesSheet && visible(rulesSheet)) {
      const close = rulesSheet.querySelector<HTMLElement>("[data-rules-close]");
      return {
        key: "rules-sheet",
        scopes: [rulesSheet],
        primary: "[data-rules-close]",
        back: () => close?.click(),
      };
    }
    const click = (selector: string) => () => {
      const control = this.root.querySelector<HTMLElement>(selector);
      if (control && visible(control)) control.click();
    };
    switch (this.hooks.phase()) {
      case "menu":
        return {
          key: "menu",
          scopes: [".topbar", ".menu-screen"].flatMap((s) => {
            const element = this.root.querySelector<HTMLElement>(s);
            return element ? [element] : [];
          }),
          primary: "[data-action='start']",
          start: click(".menu-screen [data-action='start']"),
        };
      case "paused": {
        const panel = this.root.querySelector<HTMLElement>(".pause-screen")!;
        const resume = click(".pause-screen [data-action='resume']");
        return {
          key: "paused",
          scopes: [panel],
          primary: "[data-action='resume']",
          back: resume,
          start: resume,
        };
      }
      case "ended": {
        const panel = this.root.querySelector<HTMLElement>(".result-screen")!;
        return {
          key: "ended",
          scopes: [panel],
          primary: "[data-pad-primary]",
          start: click(".result-screen [data-pad-primary]"),
        };
      }
      default:
        return null;
    }
  }

  /** Reads the pads (polled by the caller this frame) and acts on the top-most layer. */
  update(now: number): void {
    const layer = this.layer();
    const current = this.pads.current;
    const key = layer?.key ?? null;
    if (key !== this.layerKey) {
      // A new layer: buttons and directions still held from before are already "pressed".
      this.layerKey = key;
      this.previous = current.slice();
      this.repeat = current.map((pad) => heldNav(menuDirection(pad)));
    }
    if (!layer) {
      if (current.some((pad, i) => justPressed(pad, this.previous[i], BUTTON.UP)))
        this.hooks.openTraining?.();
      else if (current.some((pad, i) => justPressed(pad, this.previous[i], BUTTON.DOWN)))
        this.hooks.resetTraining?.();
      this.previous = current.slice();
      return;
    }
    current.forEach((pad, index) => {
      if (!pad) {
        this.previous[index] = null;
        this.repeat[index] = heldNav(null);
        return;
      }
      const previous = this.previous[index] ?? null;
      this.previous[index] = pad;
      const title = layer.key === "menu";
      // Reconnecting with a button or direction held must not resume pause, confirm results, or
      // press dialog actions. Title keeps press-to-join for newly connected pads.
      if (!previous && !title) {
        this.repeat[index] = heldNav(menuDirection(pad));
        return;
      }
      const nav = stepNav(this.repeat[index] ?? heldNav(null), menuDirection(pad), now);
      this.repeat[index] = nav.repeat;
      const pressed = (button: number) => justPressed(pad, previous, button);
      if (pressed(BUTTON.START)) {
        if (!(title && this.hooks.titleButton(index, "start"))) layer.start?.();
        return;
      }
      if (pressed(BUTTON.A)) {
        if (!(title && this.hooks.titleButton(index, "a"))) this.activate(layer);
        return;
      }
      if (pressed(BUTTON.B)) {
        if (title) this.hooks.titleButton(index, "b");
        else layer.back?.();
        return;
      }
      if (title && pressed(BUTTON.Y)) {
        this.hooks.titleButton(index, "y");
        return;
      }
      if (layer.cycle && (pressed(BUTTON.LB) || pressed(BUTTON.RB))) {
        layer.cycle(pressed(BUTTON.RB) ? 1 : -1);
        return;
      }
      if (nav.step) this.move(layer, nav.step);
    });
  }

  private controls(layer: Layer): HTMLElement[] {
    return layer.scopes.flatMap((scope) =>
      [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible),
    );
  }

  private focused(layer: Layer): HTMLElement | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return null;
    return layer.scopes.some((scope) => scope.contains(active)) && visible(active) ? active : null;
  }

  private focus(element: HTMLElement): void {
    document.documentElement.dataset.padNav = "";
    element.focus({ focusVisible: true } as FocusOptions);
    element.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  /** Nothing of the layer focused yet: the first press just shows where the focus is. */
  private focusPrimary(layer: Layer): void {
    const controls = this.controls(layer);
    const primary = controls.find((element) => element.matches(layer.primary)) ?? controls[0];
    if (primary) this.focus(primary);
  }

  private activate(layer: Layer): void {
    const element = this.focused(layer);
    if (!element) {
      this.focusPrimary(layer);
      return;
    }
    if (element instanceof HTMLSelectElement) {
      this.stepSelect(element, 1, true);
      return;
    }
    element.click();
  }

  /** Moves a select to the next / previous enabled option and reports the change. */
  private stepSelect(select: HTMLSelectElement, delta: 1 | -1, wrap = false): void {
    const options = [...select.options];
    const usable = (option: HTMLOptionElement) => !option.disabled && !option.hidden;
    let index = select.selectedIndex;
    for (let i = 0; i < options.length; i++) {
      index += delta;
      if (index < 0 || index >= options.length) {
        if (!wrap) return;
        index = (index + options.length) % options.length;
      }
      if (usable(options[index]!)) break;
    }
    if (index === select.selectedIndex || !usable(options[index]!)) return;
    select.selectedIndex = index;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /** Nudges a slider (the music / effects volume) one step and reports the change. */
  private stepRange(range: HTMLInputElement, delta: 1 | -1): void {
    if (range.disabled) return;
    const before = range.value;
    if (delta > 0) range.stepUp();
    else range.stepDown();
    if (range.value === before) return;
    range.dispatchEvent(new Event("input", { bubbles: true }));
    range.dispatchEvent(new Event("change", { bubbles: true }));
  }

  private move(layer: Layer, direction: MenuDirection): void {
    const from = this.focused(layer);
    if (!from) {
      this.focusPrimary(layer);
      return;
    }
    const sideways = direction === "left" || direction === "right";
    const delta = direction === "right" ? 1 : -1;
    if (sideways && from instanceof HTMLSelectElement) {
      this.stepSelect(from, delta);
      return;
    }
    if (sideways && from instanceof HTMLInputElement && from.type === "range") {
      this.stepRange(from, delta);
      return;
    }
    // Left / right stay inside a segmented control (or the mode picker) until its end.
    const group = sideways ? from.closest<HTMLElement>("[role='group']") : null;
    if (group) {
      const buttons = [...group.querySelectorAll<HTMLElement>("button")].filter(visible);
      const next = buttons[buttons.indexOf(from) + delta];
      if (next) this.focus(next);
      return;
    }
    const origin = from.getBoundingClientRect();
    let best: HTMLElement | null = null;
    let bestScore = Infinity;
    for (const candidate of this.controls(layer)) {
      if (candidate === from) continue;
      const score = distance(origin, candidate.getBoundingClientRect(), direction);
      if (score !== null && score < bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    if (best) this.focus(best);
  }

  destroy(): void {
    this.abort.abort();
  }
}
