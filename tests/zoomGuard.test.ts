// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { BattleInput } from "../src/game/input";
import { PadHub } from "../src/game/pads";
import { installZoomGuard } from "../src/game/zoomGuard";

const cleanup: (() => void)[] = [];

afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((destroy) => destroy());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  document.documentElement.removeAttribute("data-zoomed");
});

function zoomGuard(ios: boolean) {
  const viewport = Object.assign(new EventTarget(), {
    scale: 1,
    offsetLeft: 0,
    offsetTop: 0,
    width: 390,
  });
  const scrollTo = vi.fn();
  const win = { visualViewport: viewport, scrollTo, ...(ios ? { ongesturestart: null } : {}) };
  const destroy = installZoomGuard(win, document);
  cleanup.push(destroy);
  return { viewport, scrollTo, destroy };
}

function touchend(target: Element, timestamp: number, x = 30, y = 40, fingers = 1) {
  const event = Object.assign(new Event("touchend", { bubbles: true, cancelable: true }), {
    changedTouches: Array.from({ length: fingers }, () => ({ clientX: x, clientY: y })),
    touches: [],
  });
  Object.defineProperty(event, "timeStamp", { value: timestamp });
  target.dispatchEvent(event);
  return event;
}

describe("zoom guard", () => {
  test("cancels a nearby iOS double tap and activates the tapped control once", () => {
    zoomGuard(true);
    document.body.innerHTML = "<button><span>Start</span></button>";
    const button = document.querySelector("button")!;
    const click = vi.fn();
    button.addEventListener("click", click);
    const label = button.firstElementChild!;
    expect(touchend(label, 100).defaultPrevented).toBe(false);
    expect(touchend(label, 420, 54, 66).defaultPrevented).toBe(true);
    expect(click).toHaveBeenCalledTimes(1);
    expect(touchend(label, 500).defaultPrevented).toBe(false);
    expect(touchend(label, 860).defaultPrevented).toBe(false);
    expect(touchend(label, 900, 60, 70).defaultPrevented).toBe(false);
    expect(touchend(label, 950, 60, 70, 2).defaultPrevented).toBe(false);
    expect(touchend(label, 1000, 60, 70).defaultPrevented).toBe(false);
    expect(click).toHaveBeenCalledTimes(1);
  });

  test("keeps native taps on other browsers", () => {
    zoomGuard(false);
    document.body.innerHTML = "<button>Start</button>";
    const button = document.querySelector("button")!;
    touchend(button, 100);
    expect(touchend(button, 200).defaultPrevented).toBe(false);
  });

  test.each(["input", "select", "textarea", ".touch-controls button"])(
    "skips taps on %s",
    (selector) => {
      zoomGuard(true);
      document.body.innerHTML =
        '<input><select></select><textarea></textarea><div class="touch-controls"><button>Attack</button></div>';
      const target = document.querySelector(selector)!;
      touchend(target, 100);
      expect(touchend(target, 200).defaultPrevented).toBe(false);
    },
  );

  test("never activates disabled buttons", () => {
    zoomGuard(true);
    document.body.innerHTML = "<button disabled><span>Start</span></button>";
    const button = document.querySelector("button")!;
    const click = vi.spyOn(button, "click");
    touchend(button.firstElementChild!, 100);
    expect(touchend(button.firstElementChild!, 200).defaultPrevented).toBe(true);
    expect(click).not.toHaveBeenCalled();
  });

  test("allows pinching while zoomed and follows the visual viewport until recovery", () => {
    const { viewport, scrollTo, destroy } = zoomGuard(true);
    const gesture = (type: string) => {
      const event = new Event(type, { cancelable: true });
      document.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(gesture("gesturestart")).toBe(true);
    expect(gesture("gesturechange")).toBe(true);
    Object.assign(viewport, { scale: 1.1, offsetLeft: 23, offsetTop: 40 });
    viewport.dispatchEvent(new Event("resize"));
    expect(document.documentElement.hasAttribute("data-zoomed")).toBe(true);
    expect(gesture("gesturestart")).toBe(false);
    expect(gesture("gesturechange")).toBe(false);
    const notice = document.querySelector<HTMLElement>(".zoom-notice")!;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain("画面が拡大されています。2本指でつまんで戻せます");
    expect(notice.style.left).toBe("23px");
    expect(notice.style.top).toBe("40px");

    viewport.offsetTop = 70;
    viewport.dispatchEvent(new Event("scroll"));
    expect(notice.style.top).toBe("70px");
    scrollTo.mockClear();
    const meta = document.createElement("meta");
    meta.name = "viewport";
    meta.content = "width=device-width, initial-scale=1";
    document.head.append(meta);
    try {
      const update = vi.spyOn(meta, "setAttribute");
      notice.querySelector("button")!.click();
      expect(update).toHaveBeenCalledWith("content", "width=device-width, initial-scale=1");
      expect(scrollTo).toHaveBeenCalledWith(0, 0);
    } finally {
      meta.remove();
    }

    viewport.scale = 1.02;
    scrollTo.mockClear();
    viewport.dispatchEvent(new Event("resize"));
    expect(document.documentElement.hasAttribute("data-zoomed")).toBe(false);
    expect(notice.hidden).toBe(true);
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    scrollTo.mockClear();
    document.dispatchEvent(new Event("focusout"));
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    destroy();
    expect(notice.isConnected).toBe(false);
    expect(gesture("gesturestart")).toBe(false);
    scrollTo.mockClear();
    document.dispatchEvent(new Event("focusout"));
    viewport.scale = 1.5;
    viewport.dispatchEvent(new Event("resize"));
    expect(scrollTo).not.toHaveBeenCalled();
    expect(document.documentElement.hasAttribute("data-zoomed")).toBe(false);
  });
});

describe("BattleInput touch controls", () => {
  function buildInput() {
    document.body.innerHTML = '<div id="app"><canvas></canvas></div>';
    const input = new BattleInput(document.querySelector("canvas")!, new PadHub(), {
      toWorld: () => null,
      onPause: () => {},
      onGesture: () => {},
      onCameraToggle: () => {},
      onPadLost: () => {},
      rumble: () => false,
    });
    cleanup.push(() => input.destroy());
    return input;
  }

  test("blocks native touch start, end and context menu on every control while allowing zoom recovery", () => {
    buildInput();
    const controls = document.querySelectorAll(".touch-stick, .touch-actions button");
    expect(controls).toHaveLength(10);
    const dispatch = (target: Element, type: string) =>
      !target.dispatchEvent(new Event(type, { cancelable: true }));
    for (const control of controls) {
      expect(dispatch(control, "touchstart")).toBe(true);
      expect(dispatch(control, "touchend")).toBe(true);
      expect(dispatch(control, "contextmenu")).toBe(true);
    }
    document.documentElement.setAttribute("data-zoomed", "");
    for (const control of controls) {
      expect(dispatch(control, "touchstart")).toBe(false);
      expect(dispatch(control, "touchend")).toBe(false);
    }
  });

  test.each(["switchDevice", "reset"] as const)(
    "scales knob travel and clears held visuals on %s",
    (clear) => {
      const input = buildInput();
      const stick = document.querySelector<HTMLElement>(".touch-stick")!;
      const knob = stick.querySelector<HTMLElement>(".stick-knob")!;
      const attack = document.querySelector<HTMLButtonElement>("[data-attack]")!;
      vi.spyOn(stick, "setPointerCapture").mockImplementation(() => {});
      vi.spyOn(attack, "setPointerCapture").mockImplementation(() => {});
      let width = 100;
      vi.spyOn(stick, "getBoundingClientRect").mockImplementation(
        () => new DOMRect(0, 0, width, width),
      );
      const down = (target: HTMLElement, pointerId: number) =>
        target.dispatchEvent(
          new PointerEvent("pointerdown", { pointerId, clientX: width, clientY: width / 2 }),
        );
      down(stick, 1);
      down(attack, 2);
      expect(knob.style.transform).toMatch(/^translate\(27px,\s*0px\)$/);
      expect(attack.classList.contains("pressed")).toBe(true);
      input[clear]();
      expect(knob.style.transform).toBe("");
      expect(attack.classList.contains("pressed")).toBe(false);
      width = 120;
      down(stick, 3);
      expect(knob.style.transform).toMatch(/^translate\(32\.4(?:0*\d+)?px,\s*0px\)$/);
    },
  );
});
