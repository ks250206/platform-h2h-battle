export type FullscreenSupport = "api" | "standalone" | "install-ios" | "none";

export interface FullscreenState {
  active: boolean;
  support: FullscreenSupport;
}

export interface FullscreenController {
  readonly state: FullscreenState;
  toggle(): Promise<FullscreenState>;
  enter(): Promise<FullscreenState>;
  exit(): Promise<FullscreenState>;
  subscribe(listener: (state: FullscreenState) => void): () => void;
  destroy(): void;
}

type FullscreenTarget = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

type FullscreenDocument = Document & {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

type FullscreenNavigator = Pick<Navigator, "userAgent"> & { standalone?: boolean };

interface FullscreenEnvironment {
  matchMedia?: (query: string) => Pick<MediaQueryList, "matches">;
  navigator?: FullscreenNavigator;
  document?: Partial<Pick<FullscreenDocument, "fullscreenEnabled" | "webkitFullscreenEnabled">>;
  target?: Partial<Pick<FullscreenTarget, "requestFullscreen" | "webkitRequestFullscreen">>;
}

function browserEnvironment(target: HTMLElement): FullscreenEnvironment {
  const doc = target.ownerDocument;
  const win = doc.defaultView;
  return {
    document: doc,
    target,
    matchMedia: win?.matchMedia?.bind(win),
    navigator: win?.navigator,
  };
}

export function detectFullscreenSupport(
  env: FullscreenEnvironment = typeof document === "undefined"
    ? {}
    : browserEnvironment(document.documentElement),
): FullscreenSupport {
  if (
    env.matchMedia?.("(display-mode: standalone), (display-mode: fullscreen)").matches ||
    env.navigator?.standalone === true
  ) {
    return "standalone";
  }
  if (
    (env.document?.fullscreenEnabled || env.document?.webkitFullscreenEnabled) &&
    (env.target?.requestFullscreen || env.target?.webkitRequestFullscreen)
  ) {
    return "api";
  }
  return /iPhone|iPod/i.test(env.navigator?.userAgent ?? "") ? "install-ios" : "none";
}

export function createFullscreen(
  target: FullscreenTarget = document.documentElement,
): FullscreenController {
  const doc: FullscreenDocument = target.ownerDocument;
  const support = detectFullscreenSupport(browserEnvironment(target));
  const isActive = () =>
    support === "standalone" || Boolean(doc.fullscreenElement || doc.webkitFullscreenElement);
  let state: FullscreenState = { active: isActive(), support };
  let destroyed = false;
  const listeners = new Set<(state: FullscreenState) => void>();

  function sync(): FullscreenState {
    const active = isActive();
    if (!destroyed && state.active !== active) {
      state = { active, support };
      for (const listener of listeners) listener(state);
    }
    return state;
  }

  async function setActive(active: boolean): Promise<FullscreenState> {
    if (destroyed || support !== "api" || isActive() === active) return state;
    try {
      if (active) {
        const request = doc.fullscreenEnabled
          ? (target.requestFullscreen ?? target.webkitRequestFullscreen)
          : (target.webkitRequestFullscreen ?? target.requestFullscreen);
        await request?.call(target);
      } else {
        const exit = doc.fullscreenElement
          ? (doc.exitFullscreen ?? doc.webkitExitFullscreen)
          : (doc.webkitExitFullscreen ?? doc.exitFullscreen);
        await exit?.call(doc);
      }
    } catch {
      // Browsers can deny fullscreen, including when transient user activation has expired.
    }
    return sync();
  }

  doc.addEventListener("fullscreenchange", sync);
  doc.addEventListener("webkitfullscreenchange", sync);
  return {
    get state() {
      return state;
    },
    toggle: () => setActive(!isActive()),
    enter: () => setActive(true),
    exit: () => setActive(false),
    subscribe(listener) {
      if (!destroyed) listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      destroyed = true;
      doc.removeEventListener("fullscreenchange", sync);
      doc.removeEventListener("webkitfullscreenchange", sync);
      listeners.clear();
    },
  };
}
