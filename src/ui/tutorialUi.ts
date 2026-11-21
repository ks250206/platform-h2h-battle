import "./tutorial.css";
import { anyPressed, readStick, type PadSnapshot } from "../game/gamepad";
import type { ControlDevice } from "../game/match";
import { LESSONS, TutorialBattle, type LessonId } from "../game/tutorial";

export type PromptDevice = "keyboard" | "gamepad" | "touch";
export const TUTORIAL_CONTROLS = {
  keyboard: {
    move: "WASD",
    jump: "Space",
    aim: "Tabでロック切替。解除中はマウスか矢印キーで照準",
    overhead: "J",
    thrust: "L",
    rising: "I",
    step: "Shift",
    cancel: "Q",
    grab: "U",
    pause: "Esc",
  },
  gamepad: {
    move: "左スティック",
    jump: "A",
    aim: "R3でロック切替。解除中は右スティックで照準",
    overhead: "RT",
    thrust: "LB",
    rising: "LT",
    step: "B",
    cancel: "Y",
    grab: "X",
    pause: "Start",
  },
  touch: {
    move: "移動スティック",
    jump: "跳ぶ",
    aim: "自動ロックで相手に照準",
    overhead: "振下",
    thrust: "突き",
    rising: "上昇",
    step: "回避",
    cancel: "取消",
    grab: "掴む",
    pause: "一時停止ボタン",
  },
} as const;

export function lessonPrompt(id: LessonId, device: PromptDevice): string {
  const c = TUTORIAL_CONTROLS[device];
  switch (id) {
    case "basics":
      return `${c.move}で移動、${c.jump}で跳ぶ。${c.aim}。${c.overhead}で振り下ろし。`;
    case "attacks":
      return `突きは${c.thrust}を短押し。振り下ろしは${c.overhead}を約0.9秒押して放すと威力と吹き飛びが増す。`;
    case "dodge":
      return `${c.move}で方向を選び、${c.step}で回避。${c.jump}で跳ぶ。空中回避は着地まで1回。`;
    case "cancel":
      return `${c.overhead}でため、${c.cancel}で取消。放した後も剣を振りかぶる間は間に合う。`;
    case "throw":
      return `${c.grab}でつかむ。保持中に${c.move}で方向を選ぶと自動で投げる。`;
    case "ko":
      return `${c.overhead}で外へ。%が高いほど遠くへ飛ぶ。場外で残機を1つ失い、残機があれば復帰する。`;
    case "recovery":
      return `${c.jump}で跳ぶ。場外では足場へ${c.move}＋${c.step}、続いて${c.rising}（上昇）か${c.thrust}（突進）を短押し。空中ジャンプはできない。`;
    case "zone":
      return `${c.move}で破線の円へ。実線の外では毎秒7%のダメージ。ゲージは5秒で退場、内側で減少する。`;
    case "ukemi":
      return `${c.move}で接近。吹き飛んだら方向を入れ、着地まで約0.17秒の間に${c.step}を押し直す。`;
  }
}

interface Hooks {
  play: (battle: TutorialBattle) => void;
  resume: () => void;
  deviceChanged: (device: ControlDevice) => void;
  exit: (mode?: "duel" | "training") => void;
}
type Page = "catalog" | "brief" | "result" | "summary";
type Source = ControlDevice | "touch";

export class TutorialUi {
  private battle: TutorialBattle | null = null;
  private chosen: LessonId = "basics";
  private source: Source;
  private page: Page = "catalog";
  private readonly dialog: HTMLDialogElement;
  private readonly hud: HTMLElement;
  private readonly abort = new AbortController();
  private previousPads: readonly (PadSnapshot | null)[] = [];
  private hudKey = "";
  private resumeOnBack = false;

  constructor(
    private root: HTMLElement,
    private hooks: Hooks,
    touch: boolean,
  ) {
    this.source = touch ? "touch" : "keyboard";
    this.dialog = document.createElement("dialog");
    this.dialog.className = "tutorial-dialog";
    this.dialog.setAttribute("aria-labelledby", "tutorial-heading");
    this.hud = document.createElement("aside");
    this.hud.className = "tutorial-hud";
    this.hud.hidden = true;
    this.hud.innerHTML =
      '<strong></strong><p aria-live="polite"></p><small></small><div><button type="button" data-tutor="retry">やり直す</button><button type="button" data-tutor="catalog">課題一覧</button></div>';
    root.append(this.dialog);
    root.querySelector(".game-hud")!.append(this.hud);
    const signal = this.abort.signal;
    root.addEventListener(
      "click",
      (event) => {
        const action = (event.target as Element).closest<HTMLElement>("[data-tutor]")?.dataset
          .tutor;
        if (action) this.act(action);
      },
      { signal },
    );
    this.dialog.addEventListener(
      "cancel",
      (event) => {
        event.preventDefault();
        this.dialog.querySelector<HTMLButtonElement>("[data-pad-back]")?.click();
      },
      { signal },
    );
    window.addEventListener(
      "pointerdown",
      (e) => this.use(e.pointerType === "touch" ? "touch" : "keyboard"),
      { signal, capture: true },
    );
    window.addEventListener(
      "keydown",
      (e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        this.use("keyboard");
        if (
          e.code === "KeyR" &&
          !e.repeat &&
          this.battle &&
          (this.dialog.open
            ? this.page === "result"
            : this.battle.state.phase === "playing" && !document.querySelector("dialog[open]"))
        ) {
          e.preventDefault();
          this.retry();
        }
      },
      { signal, capture: true },
    );
  }

  get device(): ControlDevice {
    return this.source === "touch" ? "keyboard" : this.source;
  }
  get promptDevice(): PromptDevice {
    return this.source === "keyboard" || this.source === "touch" ? this.source : "gamepad";
  }

  private use(source: Source): void {
    if (this.source === source) return;
    this.source = source;
    if (this.battle) this.hooks.deviceChanged(this.device);
    if (this.dialog.open && this.page === "brief")
      this.dialog.querySelector(".tutorial-prompt")!.textContent = lessonPrompt(
        this.chosen,
        this.promptDevice,
      );
  }

  observePads(pads: readonly (PadSnapshot | null)[]): void {
    pads.forEach((pad, index) => {
      if (!pad) return;
      const previous = this.previousPads[index] ?? null;
      const stickMoved = [0, 2].some((axis) => {
        const now = readStick(pad.axes, axis);
        const was = readStick(previous?.axes ?? [], axis);
        return Math.hypot(now.x, now.y) > 0.2 && Math.hypot(was.x, was.y) <= 0.2;
      });
      if (anyPressed(pad, previous) || stickMoved) this.use(`pad${index + 1}` as ControlDevice);
    });
    this.previousPads = pads.slice();
  }

  private play(id: LessonId, notice = ""): void {
    this.battle ??= new TutorialBattle();
    this.resumeOnBack = false;
    this.dialog.close();
    this.battle.begin(id, this.device);
    this.battle.feedback = notice;
    this.hudKey = "";
    this.hooks.play(this.battle);
    // Space belongs to jump during play. A hidden dialog button must not retain focus.
    (document.activeElement as HTMLElement | null)?.blur();
  }
  retry(): void {
    if (this.battle) this.play(this.battle.lesson.id);
  }

  private act(action: string): void {
    const lesson = LESSONS.find((l) => l.id === action);
    if (lesson) {
      this.chosen = lesson.id;
      this.show("brief");
    } else if (action === "catalog") {
      if (!this.dialog.open)
        this.resumeOnBack =
          this.battle?.state.phase === "playing" && this.battle.status === "playing";
      if (this.battle?.status === "playing") this.battle.pause();
      this.show("catalog");
    } else if (action === "play") this.play(this.chosen);
    else if (action === "retry") this.retry();
    else if (action === "next" && this.battle) {
      const next = LESSONS[LESSONS.indexOf(this.battle.lesson) + 1];
      if (next && this.battle.completed.size < LESSONS.length) {
        this.chosen = next.id;
        this.show("brief");
      } else this.show("summary");
    } else if (action === "summary") this.show("summary");
    else if (action === "title" || action === "duel" || action === "training") {
      this.hooks.exit(action === "title" ? undefined : action);
    } else if (action === "back") {
      this.dialog.close();
      if (this.battle && this.battle.status !== "playing") this.show("result");
      else if (this.resumeOnBack) this.hooks.resume();
      else if (this.battle?.state.phase === "paused")
        this.root.querySelector<HTMLButtonElement>('.pause-panel [data-action="resume"]')?.focus();
      this.resumeOnBack = false;
    }
  }

  private show(page: Page): void {
    this.page = page;
    const lesson = LESSONS.find((l) => l.id === this.chosen)!;
    const battle = this.battle;
    const done = battle?.completed;
    const button = (action: string, label: string, attrs = "") =>
      `<button type="button" data-tutor="${action}" ${attrs}>${label}</button>`;
    const primary = "data-pad-primary data-pad-start";
    let heading: string, body: string;
    if (page === "catalog") {
      heading = "実戦チュートリアル";
      body = `<p>練習したい課題を選ぼう。どこからでも始められます。</p>
        <div class="tutorial-list">${LESSONS.map((l, i) => button(l.id, `${i + 1}. ${l.title}${done?.has(l.id) ? "　✓" : ""}`, i === 0 ? "data-pad-primary" : "")).join("")}</div>
        ${battle ? button("back", "課題に戻る", "data-pad-back") : ""}${button("title", "タイトルへ戻る", battle ? "" : "data-pad-back")}`;
    } else if (page === "brief") {
      heading = lesson.title;
      body = `<ol>${lesson.steps.map((s) => `<li>${s}</li>`).join("")}</ol><p class="tutorial-prompt">${lessonPrompt(lesson.id, this.promptDevice)}</p>
        ${button("play", "練習を始める", primary)}${button("catalog", "課題一覧へ", "data-pad-back")}${button("title", "タイトルへ戻る")}`;
    } else if (page === "result" && battle) {
      const success = battle.status === "success";
      heading = success ? "課題達成" : "もう一度やってみよう";
      body = `<p>${success ? battle.lesson.recap : battle.feedback}</p>
        ${success ? button("next", battle.lesson === LESSONS.at(-1) || done?.size === LESSONS.length ? "まとめを見る" : "次の課題へ", primary) : ""}
        ${button("retry", "この課題をやり直す", success ? "" : primary)}
        ${button("catalog", "課題一覧へ", "data-pad-back")}${button("summary", "学習のまとめ")}${button("title", "タイトルへ戻る")}`;
    } else {
      heading = "学習のまとめ";
      body = `<p>達成した課題　${done?.size ?? 0} / ${LESSONS.length}</p>
        <ul>${summaryItems(done)}</ul>${button("training", "稽古で自由に試す", primary)}${button("duel", "CPUと一騎打ち")}
        ${button("catalog", "課題を選び直す", "data-pad-back")}${button("title", "タイトルへ戻る")}`;
    }
    this.dialog.innerHTML = `<h2 id="tutorial-heading">${heading}</h2>${body}`;
    if (!this.dialog.open) this.dialog.showModal();
    this.dialog.scrollTop = 0;
    this.dialog.querySelector<HTMLElement>("[data-pad-primary]")?.focus({ preventScroll: true });
  }

  update(): void {
    const b = this.battle;
    if (!b) return;
    if (
      b.status === "failed" &&
      b.lesson.id === "recovery" &&
      b.state.phase === "playing" &&
      b.state.fighters[0].mode === "dead" &&
      !this.dialog.open
    ) {
      this.play("recovery", "場外へ落ちたので縁に戻りました。もう一度試そう。");
      return;
    }
    if (this.root.dataset.tutorial !== this.promptDevice)
      this.root.dataset.tutorial = this.promptDevice;
    this.hud.hidden = b.state.phase !== "playing" || b.status !== "playing";
    if (b.resultReady && !this.dialog.open) this.show("result");
    if (this.hud.hidden) return;
    const key = [b.lesson.id, b.step, b.feedback, this.source].join("/");
    if (key === this.hudKey) return;
    this.hudKey = key;
    this.hud.querySelector("strong")!.textContent =
      `${b.lesson.title}　${b.step + 1}/${b.lesson.steps.length}`;
    this.hud.querySelector("p")!.textContent = [b.feedback, b.lesson.steps[b.step]]
      .filter(Boolean)
      .join(" ");
    this.hud.querySelector("small")!.textContent =
      lessonPrompt(b.lesson.id, this.promptDevice) +
      "　" +
      (this.promptDevice === "keyboard"
        ? "Rでやり直す・Escで中断"
        : TUTORIAL_CONTROLS[this.promptDevice].pause + "で中断");
  }

  leave(): void {
    this.battle = null;
    this.resumeOnBack = false;
    this.dialog.close();
    this.hud.hidden = true;
    delete this.root.dataset.tutorial;
  }
  destroy(): void {
    this.abort.abort();
    this.dialog.remove();
    this.hud.remove();
  }
}

const summaryItems = (done?: ReadonlySet<LessonId>) =>
  LESSONS.map(
    (l) =>
      `<li>${done?.has(l.id) ? "達成" : "未達成"}　${l.title}${done?.has(l.id) ? `<small>${l.recap}</small>` : ""}</li>`,
  ).join("");
