// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { createFullscreen, detectFullscreenSupport } from "../src/game/fullscreen";
import { FullscreenUI } from "../src/ui/fullscreenUi";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("fullscreen support", () => {
  const target = { requestFullscreen: async () => {} };
  const api = { fullscreenEnabled: true };
  const iphone = { userAgent: "Mozilla/5.0 (iPhone)" };

  test("installed display modes take priority over the API", () => {
    const matchMedia = vi.fn(() => ({ matches: true }));
    expect(detectFullscreenSupport({ matchMedia, document: api, target })).toBe("standalone");
    expect(matchMedia).toHaveBeenCalledWith(
      "(display-mode: standalone), (display-mode: fullscreen)",
    );
    expect(detectFullscreenSupport({ navigator: { ...iphone, standalone: true } })).toBe(
      "standalone",
    );
  });

  test("requires both API capability and a request method", () => {
    expect(detectFullscreenSupport({ document: api, target, navigator: iphone })).toBe("api");
    expect(detectFullscreenSupport({ document: api, target: {}, navigator: iphone })).toBe(
      "install-ios",
    );
    expect(detectFullscreenSupport({ document: {}, target })).toBe("none");
  });

  test("detects the prefixed API and iPod install guidance", () => {
    expect(
      detectFullscreenSupport({
        document: { webkitFullscreenEnabled: true },
        target: { webkitRequestFullscreen: () => {} },
      }),
    ).toBe("api");
    expect(detectFullscreenSupport({ navigator: { userAgent: "iPod touch" } })).toBe("install-ios");
  });
});

function mockApi(prefix: "standard" | "webkit" = "standard") {
  const target = document.createElement("main");
  document.body.append(target);
  const prefixed = prefix === "webkit";
  const change = prefixed ? "webkitfullscreenchange" : "fullscreenchange";
  let active: Element | null = null;
  const setActive = (element: Element | null) => {
    active = element;
    document.dispatchEvent(new Event(change));
  };
  const request = vi.fn(() => {
    setActive(target);
    return Promise.resolve();
  });
  const exit = vi.fn(() => {
    setActive(null);
    return Promise.resolve();
  });
  const stubs = [
    [document, prefixed ? "webkitFullscreenEnabled" : "fullscreenEnabled", { value: true }],
    [document, prefixed ? "webkitFullscreenElement" : "fullscreenElement", { get: () => active }],
    [document, prefixed ? "webkitExitFullscreen" : "exitFullscreen", { value: exit }],
    [target, prefixed ? "webkitRequestFullscreen" : "requestFullscreen", { value: request }],
  ] as const;
  const originals = stubs.map(([owner, key]) => Object.getOwnPropertyDescriptor(owner, key));
  for (const [owner, key, descriptor] of stubs) {
    Object.defineProperty(owner, key, { ...descriptor, configurable: true });
  }
  const controller = createFullscreen(target);
  return {
    controller,
    request,
    exit,
    setActive,
    destroy() {
      controller.destroy();
      stubs.forEach(([owner, key], i) => {
        const original = originals[i];
        if (original) Object.defineProperty(owner, key, original);
        else Reflect.deleteProperty(owner, key);
      });
    },
  };
}

describe("fullscreen controller", () => {
  test.each(["standard", "webkit"] as const)(
    "enters, exits, toggles and follows external %s fullscreen changes",
    async (prefix) => {
      const api = mockApi(prefix);
      const { controller, request, exit, setActive } = api;
      try {
        const listener = vi.fn();
        const unsubscribe = controller.subscribe(listener);
        expect(controller.state).toEqual({ active: false, support: "api" });
        expect(await controller.enter()).toEqual({ active: true, support: "api" });
        expect(await controller.enter()).toEqual(controller.state);
        expect(request).toHaveBeenCalledTimes(1);
        expect(await controller.toggle()).toEqual({ active: false, support: "api" });
        expect(exit).toHaveBeenCalledTimes(1);
        setActive(document.body);
        expect(listener.mock.calls.map(([state]) => state.active)).toEqual([true, false, true]);
        unsubscribe();
        expect(await controller.exit()).toEqual({ active: false, support: "api" });
        expect(listener).toHaveBeenCalledTimes(3);
        controller.destroy();
        setActive(document.body);
        expect(controller.state.active).toBe(false);
      } finally {
        api.destroy();
      }
    },
  );

  test.each(["standard", "webkit"] as const)(
    "absorbs rejected requests and thrown exits for the %s API",
    async (prefix) => {
      const api = mockApi(prefix);
      try {
        api.request.mockRejectedValueOnce(new Error("denied"));
        expect(await api.controller.enter()).toEqual({ active: false, support: "api" });
        api.setActive(document.body);
        api.exit.mockImplementationOnce(() => {
          throw new Error("denied");
        });
        expect(await api.controller.toggle()).toEqual({ active: true, support: "api" });
        api.exit.mockRejectedValueOnce(new Error("denied"));
        expect(await api.controller.exit()).toEqual({ active: true, support: "api" });
      } finally {
        api.destroy();
      }
    },
  );
});

function uiRoot() {
  const root = document.createElement("div");
  root.innerHTML = `
    <div class="top-actions"><button class="settings-button"></button></div>
    <div class="pause-panel"><button data-action="settings"></button></div>
    <dialog class="settings-dialog"><div class="settings-foot"></div></dialog>
    <input>
  `;
  document.body.append(root);
  return root;
}

describe("FullscreenUI", () => {
  test("injects the three toggles, syncs their state, and handles KeyF outside form controls", async () => {
    const api = mockApi();
    const root = uiRoot();
    const ui = new FullscreenUI(root, api.controller);
    try {
      const top = root.querySelector<HTMLButtonElement>(".fullscreen-button")!;
      const pause = root.querySelector(".fullscreen-pause-button")!;
      const row = root.querySelector(".fullscreen-setting-row")!;
      expect(top.nextElementSibling?.className).toBe("settings-button");
      expect(pause.previousElementSibling?.getAttribute("data-action")).toBe("settings");
      expect(row.nextElementSibling?.className).toBe("settings-foot");
      expect(root.querySelectorAll('[data-fullscreen="toggle"]:not([data-action])')).toHaveLength(
        3,
      );
      expect(top.getAttribute("aria-pressed")).toBe("false");
      const enterIcon = top.innerHTML;
      top.click();
      expect(top.getAttribute("aria-pressed")).toBe("true");
      expect(top.innerHTML).not.toBe(enterIcon);
      expect(pause.textContent).toBe("全画面表示を解除");

      const key = (target: EventTarget, init: KeyboardEventInit = {}) =>
        target.dispatchEvent(
          new KeyboardEvent("keydown", { code: "KeyF", bubbles: true, ...init }),
        );
      key(root, { repeat: true });
      key(root, { shiftKey: true });
      key(root.querySelector("input")!);
      const dialog = root.querySelector("dialog")!;
      dialog.showModal();
      key(root);
      dialog.close();
      expect(api.exit).not.toHaveBeenCalled();
      key(root);
      expect(api.exit).toHaveBeenCalledTimes(1);
      expect(top.getAttribute("aria-label")).toBe("全画面表示にする");
    } finally {
      ui.destroy();
      api.destroy();
    }
    expect(root.querySelector("[data-fullscreen]")).toBeNull();
  });

  test.each(["none", "standalone"] as const)("hides every toggle for %s support", (support) => {
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: support === "standalone",
    } as MediaQueryList);
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Desktop");
    const root = uiRoot();
    const ui = new FullscreenUI(root);
    try {
      expect(
        root.querySelectorAll(
          ".fullscreen-button[hidden], .fullscreen-pause-button[hidden], .fullscreen-setting-row[hidden]",
        ),
      ).toHaveLength(3);
    } finally {
      ui.destroy();
    }
  });

  test("shows and dismisses the iOS guide from the settings dialog even with other anchors absent", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("iPhone");
    const root = uiRoot();
    root.querySelector(".top-actions")!.remove();
    root.querySelector(".pause-panel")!.remove();
    const ui = new FullscreenUI(root);
    try {
      const settings = root.querySelector<HTMLDialogElement>(".settings-dialog")!;
      settings.showModal();
      const toggle = settings.querySelector<HTMLButtonElement>("[data-fullscreen]")!;
      expect(toggle.textContent).toBe("全画面の方法を見る");
      toggle.click();
      const guide = root.querySelector<HTMLDialogElement>(".fullscreen-ios-dialog")!;
      expect(guide.open).toBe(true);
      expect(root.querySelector("dialog[open]")).toBe(guide);
      expect(guide.textContent).toContain("ホーム画面に追加");
      guide.querySelector<HTMLButtonElement>("[data-pad-back]")!.click();
      expect(guide.open).toBe(false);
      toggle.click();
      guide.dispatchEvent(new Event("cancel", { cancelable: true }));
      expect(guide.open).toBe(false);
      toggle.click();
      vi.spyOn(guide, "getBoundingClientRect").mockReturnValue(new DOMRect(30, 30, 300, 200));
      guide.dispatchEvent(new MouseEvent("click", { clientX: 5, clientY: 5 }));
      expect(guide.open).toBe(false);
      expect(settings.open).toBe(true);
    } finally {
      ui.destroy();
    }
    expect(root.querySelector(".fullscreen-ios-dialog")).toBeNull();
  });
});
