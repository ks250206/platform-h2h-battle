import {
  createFullscreen,
  type FullscreenController,
  type FullscreenState,
} from "../game/fullscreen";

const enterPath = "M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5";
const exitPath = "M4 9h5V4m11 5h-5V4M9 20v-5H4m11 5v-5h5";

export class FullscreenUI {
  private readonly abort = new AbortController();
  private readonly buttons: HTMLButtonElement[] = [];
  private readonly row: HTMLElement | null;
  private readonly guide: HTMLDialogElement | null;
  private readonly unsubscribe: () => void;

  constructor(
    root: HTMLElement,
    private readonly fullscreen: FullscreenController = createFullscreen(
      root.ownerDocument.documentElement,
    ),
  ) {
    const doc = root.ownerDocument;
    const { signal } = this.abort;
    const makeButton = (className: string) => {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = className;
      button.dataset.fullscreen = "toggle";
      button.addEventListener("click", this.toggle, { signal });
      this.buttons.push(button);
      return button;
    };

    root
      .querySelector(".top-actions .settings-button")
      ?.before(makeButton("icon-button fullscreen-button"));
    root
      .querySelector('.pause-panel [data-action="settings"]')
      ?.after(makeButton("secondary-button fullscreen-pause-button"));
    const footer = root.querySelector(".settings-dialog .settings-foot");
    this.row = footer ? doc.createElement("div") : null;
    if (footer && this.row) {
      this.row.className = "setting-row fullscreen-setting-row";
      this.row.innerHTML = '<div class="setting-label">全画面表示</div>';
      this.row.append(makeButton("secondary-button"));
      footer.before(this.row);
    }

    this.guide =
      fullscreen.state.support === "install-ios" && this.buttons.length
        ? doc.createElement("dialog")
        : null;
    if (this.guide) {
      const guide = this.guide;
      guide.className = "fullscreen-ios-dialog";
      guide.setAttribute("aria-labelledby", "fullscreen-ios-title");
      guide.innerHTML = `
        <h2 id="fullscreen-ios-title">iPhoneで全画面表示</h2>
        <p>iPhoneのSafariでは、全画面表示にホーム画面への追加が必要です。</p>
        <ol>
          <li>Safariの「共有」ボタンをタップします。</li>
          <li>「ホーム画面に追加」を選択します。</li>
          <li>ホーム画面のBRAMBLEアイコンから起動します。</li>
        </ol>
        <button type="button" class="secondary-button" data-pad-back>戻る</button>`;
      guide.querySelector("button")!.addEventListener("click", () => guide.close(), { signal });
      guide.addEventListener(
        "cancel",
        (event) => {
          event.preventDefault();
          guide.close();
        },
        { signal },
      );
      guide.addEventListener(
        "click",
        (event) => {
          if (event.target !== guide) return;
          const { left, right, top, bottom } = guide.getBoundingClientRect();
          if (
            event.clientX < left ||
            event.clientX > right ||
            event.clientY < top ||
            event.clientY > bottom
          )
            guide.close();
        },
        { signal },
      );
      // PadMenu chooses the first open dialog, including when settings opened this guide.
      root.prepend(guide);
    }

    this.sync(fullscreen.state);
    this.unsubscribe = fullscreen.subscribe(this.sync);
    doc.defaultView?.addEventListener(
      "keydown",
      (event) => {
        if (
          fullscreen.state.support !== "api" ||
          event.code !== "KeyF" ||
          event.repeat ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          doc.querySelector("dialog[open]") ||
          doc.activeElement?.matches("input, textarea, select") ||
          (event.target instanceof Element && event.target.matches("input, textarea, select"))
        ) {
          return;
        }
        event.preventDefault();
        void fullscreen.toggle();
      },
      { signal },
    );
  }

  private toggle = () => {
    if (this.fullscreen.state.support === "api") void this.fullscreen.toggle();
    else if (this.guide && !this.guide.open) this.guide.showModal();
  };

  private sync = ({ active, support }: FullscreenState) => {
    const visible = support === "api" || support === "install-ios";
    const label =
      support === "install-ios"
        ? "全画面の方法を見る"
        : active
          ? "全画面表示を解除"
          : "全画面表示にする";
    if (this.row) this.row.hidden = !visible;
    for (const button of this.buttons) {
      button.hidden = !visible;
      if (support === "api") button.setAttribute("aria-pressed", String(active));
      if (button.classList.contains("fullscreen-button")) {
        button.setAttribute("aria-label", label);
        button.title = support === "api" ? (active ? `${label} · F` : "全画面表示 · F") : label;
        button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="${active ? exitPath : enterPath}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`;
      } else {
        button.textContent = label;
      }
    }
  };

  destroy(): void {
    this.abort.abort();
    this.unsubscribe();
    this.fullscreen.destroy();
    this.guide?.close();
    this.guide?.remove();
    this.row?.remove();
    for (const button of this.buttons) button.remove();
  }
}
