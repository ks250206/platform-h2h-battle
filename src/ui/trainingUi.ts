import type { BattleEngine } from "../game/engine";
import { ATTACKS, INPUT_BUFFER_TICKS, UKEMI } from "../game/tuning";
import {
  DAMAGE_LIMIT,
  RECORDING_LIMIT,
  trainingSnapshot,
  type DummyBehavior,
  type TrainingSettings,
} from "../game/training";
import type { AttackId, Fighter } from "../game/types";

const behaviors: Record<DummyBehavior, string> = {
  still: "静止",
  repeatAttack: "攻撃を反復",
  move: "前後に移動",
  dodge: "ステップを反復",
  cpu: "通常CPU",
};
const damageRow = (
  slot: number,
  label: string,
) => `<fieldset><legend>${label}の蓄積ダメージ</legend>
  <div class="training-damage"><input type="number" min="0" max="${DAMAGE_LIMIT}" step="1" inputmode="numeric" data-slot="${slot}" aria-label="${label}の開始・現在ダメージ"> %
  ${[0, 50, 100, 150].map((n) => `<button data-slot="${slot}" data-value="${n}">${n}%</button>`).join("")}
  <button data-slot="${slot}" data-delta="-1">−1</button><button data-slot="${slot}" data-delta="1">+1</button></div></fieldset>`;

function describe(engine: BattleEngine, fighter: Fighter) {
  const s = trainingSnapshot(engine.state, fighter);
  const b = s.buffer;
  const buffer = b ? `${b.attack ?? b.action} ${b.age}F前（${b.pressedIn}）` : "空";
  const tech =
    s.techTicks !== null
      ? `受付済・残${s.techTicks}F`
      : s.tumbling || s.pendingLaunch
        ? "着地前に回避"
        : "対象外";
  return [
    `${fighter.id === 0 ? "1P" : "相手"}  ${s.mode} ${s.remaining === null ? "" : `残${s.remaining}F`}${s.hitstop ? `  停止 ${s.hitstop}F` : ""}`,
    `取消${s.cancellable ? "可" : "不可"} · ${s.invulnerable ? "無敵" : "無敵なし"}`,
    `空中残  上昇 ${+s.air.rising}  突き ${+s.air.thrust}  回避 ${+s.air.step}`,
    `先行入力  ${buffer} · 受け身  ${tech}${s.tumbling ? "（吹き飛び中）" : s.pendingLaunch ? "（吹き飛び待ち）" : ""}`,
  ].join("\n");
}

export class TrainingUI {
  private readonly abort = new AbortController();
  private readonly dialog: HTMLDialogElement;
  private readonly hud: HTMLElement;
  private readonly pauseButton: HTMLButtonElement;
  private resumeOnClose = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly engine: BattleEngine,
    private readonly resetDevices: () => void,
  ) {
    this.hud = document.createElement("aside");
    this.hud.className = "training-hud";
    this.hud.hidden = true;
    this.hud.innerHTML = `<button data-open>稽古設定 · T / 十字↑</button><button data-reset>リセット · R</button><button data-stop hidden>停止</button>
      <span class="training-status"></span><div class="training-state" hidden><pre></pre><pre></pre></div>`;
    root.querySelector(".game-hud")!.append(this.hud);
    this.pauseButton = document.createElement("button");
    this.pauseButton.hidden = true;
    this.pauseButton.className = "secondary-button";
    this.pauseButton.textContent = "稽古設定・入力記録";
    root.querySelector(".pause-panel [data-action=resume]")!.after(this.pauseButton);
    this.dialog = document.createElement("dialog");
    this.dialog.className = "training-dialog";
    this.dialog.setAttribute("aria-label", "稽古設定");
    this.dialog.innerHTML = `<div class="help-head"><h2>稽古設定</h2></div>
      <fieldset><legend>練習相手</legend>
      <label>行動 <select data-key="behavior" data-pad-primary>${Object.entries(behaviors)
        .map(([id, label]) => `<option value="${id}">${label}</option>`)
        .join("")}</select></label>
      <label>反復する技 <select data-key="attack">${Object.entries(ATTACKS)
        .map(([id, a]) => `<option value="${id}">${a.label}</option>`)
        .join("")}</select></label><small data-partner></small></fieldset>
      ${damageRow(0, "1P")}${damageRow(1, "相手")}
      <p>ダメージは現在とリセット後の両方に適用します。</p>
      <fieldset><legend>補助・表示</legend>
      <label><input type="checkbox" data-key="infinite"> スタミナ無限</label>
      <label><input type="checkbox" data-key="hitboxes"> 判定表示（赤＝相手の足元が当たる範囲、緑＝体半径）</label>
      <label><input type="checkbox" data-key="overlay"> 戦闘状態（先行入力${INPUT_BUFFER_TICKS}F・受け身${UKEMI.windowTicks}F）</label></fieldset>
      <fieldset><legend>入力記録</legend><p>1Pの入力を60 Hzで最大10秒（${RECORDING_LIMIT}F）記録します。記録・再生・各ループの開始時に両者をリセット。相手は移動と照準を180°回して再生します。</p>
      <p>記録はこの稽古中だけ保持します。再記録で上書き。ポーズ・設定変更・リセットで停止します。</p>
      <label><input type="checkbox" data-key="loop"> 繰り返し再生</label>
      <p data-tape role="status"></p><button data-record>記録開始</button> <button data-play>相手で再生</button></fieldset>
      <div class="training-footer"><button data-reset>開始位置にリセット</button><button data-pad-back>戻る</button></div>`;
    root.append(this.dialog);
    const signal = this.abort.signal;
    const open = () => this.open();
    this.pauseButton.addEventListener("click", open, { signal });
    this.hud.querySelector("[data-open]")!.addEventListener("click", open, { signal });
    this.hud.querySelector("[data-stop]")!.addEventListener(
      "click",
      () => {
        this.engine.stopTraining();
        this.resetDevices();
        this.update();
      },
      { signal },
    );
    const reset = () => {
      this.engine.resetTraining();
      this.resetDevices();
      this.update();
    };
    this.hud.querySelector("[data-reset]")!.addEventListener("click", reset, { signal });
    window.addEventListener(
      "keydown",
      (e) => {
        if (
          !this.engine.training ||
          e.repeat ||
          e.ctrlKey ||
          e.metaKey ||
          e.altKey ||
          root.querySelector("dialog[open]")
        )
          return;
        if (e.code === "KeyT") open();
        if (e.code === "KeyR" && this.engine.state.phase !== "paused") reset();
      },
      { signal },
    );
    this.dialog.addEventListener(
      "cancel",
      (e) => {
        e.preventDefault();
        this.close();
      },
      { signal },
    );
    this.dialog.addEventListener(
      "click",
      (e) => {
        const button = e.target instanceof Element && e.target.closest("button");
        const session = this.engine.training;
        if (!button || !session) return;
        const d = button.dataset;
        if ("slot" in d) {
          const slot = Number(d.slot) as 0 | 1;
          this.engine.setTrainingDamage(slot, d.value ?? session.damage[slot] + Number(d.delta));
          this.sync();
        } else if ("record" in d || "play" in d) {
          if (this.engine.beginTraining("record" in d ? "record" : "play")) this.close();
          else
            this.dialog.querySelector("[data-tape]")!.textContent =
              "記録が空です。先に1Pの入力を記録してください。";
        } else if ("reset" in d) {
          this.engine.resetTraining();
          this.close();
        } else this.close();
      },
      { signal },
    );
    this.dialog.addEventListener(
      "change",
      (e) => {
        const el = e.target;
        if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) return;
        const key = el.dataset.key;
        if (el.dataset.slot !== undefined)
          this.engine.setTrainingDamage(Number(el.dataset.slot) as 0 | 1, el.value);
        else if (key === "behavior")
          this.engine.configureTraining({ behavior: el.value as DummyBehavior });
        else if (key === "attack") this.engine.configureTraining({ attack: el.value as AttackId });
        else if (el instanceof HTMLInputElement && key)
          this.engine.configureTraining({ [key]: el.checked });
        this.sync();
      },
      { signal },
    );
  }

  open() {
    if (!this.engine.training || this.root.querySelector("dialog[open]")) return;
    this.resumeOnClose = this.engine.state.phase !== "paused";
    this.engine.pause();
    this.resetDevices();
    this.sync();
    this.dialog.showModal();
    this.dialog.querySelector<HTMLElement>("[data-pad-primary]:enabled, button")?.focus();
  }

  private close() {
    this.dialog.close();
    this.resetDevices();
    if (this.resumeOnClose) this.engine.resume();
    this.resumeOnClose = false;
    this.update();
  }

  private tapeLabel() {
    const t = this.engine.training!;
    const mode =
      t.transport === "recording"
        ? "記録中"
        : t.transport === "playing"
          ? t.settings.loop
            ? "ループ中"
            : "再生中"
          : "待機";
    return `${mode} · ${t.ticks ? `記録 ${t.ticks}F（${(t.ticks / 60).toFixed(2)}秒）` : "記録なし"}`;
  }

  private sync() {
    const t = this.engine.training!;
    const dummy = this.engine.state.fighters[1];
    for (const select of this.dialog.querySelectorAll("select")) {
      const key = select.dataset.key as "behavior" | "attack";
      select.value = t.settings[key];
      select.disabled = dummy.human || (key === "attack" && t.settings.behavior !== "repeatAttack");
    }
    this.dialog.querySelector("[data-partner]")!.textContent = dummy.human
      ? "相手は2Pが操作します。入力再生中のみ記録に切り替わります。"
      : `CPU難度 · ${dummy.aiLevel}`;
    for (const input of this.dialog.querySelectorAll("input")) {
      if (input.type === "checkbox")
        input.checked = !!t.settings[input.dataset.key as keyof TrainingSettings];
      else input.value = String(t.damage[Number(input.dataset.slot)]);
    }
    this.dialog.querySelector("[data-tape]")!.textContent = this.tapeLabel();
  }

  update() {
    const t = this.engine.training;
    this.pauseButton.hidden = !t;
    this.hud.hidden = !t || this.engine.state.phase === "paused";
    if (!t) {
      if (this.dialog.open) this.dialog.close();
      return;
    }
    const status = this.hud.querySelector(".training-status")!;
    const label = `${this.tapeLabel()}${t.settings.infinite ? " · スタミナ∞" : ""}`;
    if (status.textContent !== label) status.textContent = label;
    this.hud.querySelector<HTMLButtonElement>("[data-stop]")!.hidden = t.transport === "idle";
    const state = this.hud.querySelector<HTMLElement>(".training-state")!;
    state.hidden = !t.settings.overlay;
    if (!state.hidden)
      state.querySelectorAll("pre").forEach((pre, i) => {
        const content = describe(this.engine, this.engine.state.fighters[i]);
        if (content !== pre.textContent) pre.textContent = content;
      });
  }

  destroy() {
    this.abort.abort();
    this.dialog.remove();
    this.hud.remove();
    this.pauseButton.remove();
  }
}
