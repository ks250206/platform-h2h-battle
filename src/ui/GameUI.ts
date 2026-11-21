import type { Fighter, GameState, MatchMode, Phase } from "../game/types";
import { RULES } from "../game/tuning";
import { effectiveSamples, FPS_LIMITS, MSAA_SAMPLES, RESOLUTION_OPTIONS } from "../game/settings";
import type { GraphicsSettings, MsaaSamples, SettingsStore, ShadowLevel } from "../game/settings";
import { AI_LEVEL_IDS, humanSlots, padIndex, STOCK_CHOICES } from "../game/match";
import type { AiLevel, ControlDevice, MatchOptions } from "../game/match";
import { playableOptions, type MatchStore } from "../game/matchStore";
import type { PlayerLock } from "../game/input";
import { PAD_COUNT } from "../game/pads";
import type { TitleButton } from "./padMenu";

export interface GameUICallbacks {
  /** Starts a match with the title menu's mode and match options. */
  onStart: (mode: MatchMode, options: MatchOptions) => void;
  onPause: () => void;
  onResume: () => void;
  onRestart: () => void;
  onMenu: () => void;
  onSound: (enabled: boolean) => void;
  /** The remembered 対戦設定 (who plays what, lives and CPU strength). */
  match: MatchStore;
  graphics: GraphicsSettingsBinding;
}

/** What the graphics settings dialog reads and writes; renderer values are null until it is ready. */
export interface GraphicsSettingsBinding {
  store: SettingsStore;
  renderSize: () => { width: number; height: number } | null;
  supportedMsaa: (ambientOcclusion: boolean) => readonly MsaaSamples[] | null;
  supportsAmbientOcclusion: () => boolean | null;
}

const shadowOptions: { value: ShadowLevel; label: string }[] = [
  { value: "off", label: "なし" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
];

function settingsDialogMarkup(): string {
  const toggle = (key: keyof GraphicsSettings, label: string, hint = "") =>
    `<div class="setting-row"><label class="setting-toggle"><span>${label}</span><input type="checkbox" data-setting="${key}"${hint ? ` aria-describedby="hint-${key}"` : ""}></label>${hint ? `<p class="setting-hint" id="hint-${key}">${hint}</p>` : ""}</div>`;
  return `
      <dialog class="settings-dialog" aria-labelledby="settings-title">
        <div class="help-head flex items-center justify-between"><div><div class="eyebrow">GRAPHICS</div><h2 id="settings-title">グラフィック設定</h2></div><button class="icon-button" data-action="close-settings" aria-label="グラフィック設定を閉じる">×</button></div>
        <div class="settings-body">
          <section class="settings-section" aria-labelledby="settings-display">
            <h3 id="settings-display">DISPLAY / 表示</h3>
            <div class="setting-row">
              <div class="setting-label"><label for="setting-resolution">解像度</label><output class="setting-value" for="setting-resolution" data-output="resolution"></output></div>
              <select id="setting-resolution" data-setting="resolution" aria-describedby="hint-resolution">${RESOLUTION_OPTIONS.map((o) => `<option value="${o.value}">${o.label}</option>`).join("")}</select>
              <p class="setting-hint" id="hint-resolution">3D を描く画面の短い辺のピクセル数です。重いときは下げてください。文字と HUD はくっきりしたままです。</p>
            </div>
            ${toggle("dynamicResolution", "負荷に合わせて解像度を自動調整", "描画が遅いときだけ 3D の解像度を下げます")}
            <div class="setting-row">
              <div class="setting-label"><label for="setting-antialiasing">アンチエイリアス</label></div>
              <select id="setting-antialiasing" data-setting="antialiasing" aria-describedby="hint-antialiasing"><option value="off">なし</option><option value="msaa">MSAA</option><option value="fxaa">FXAA（軽量）</option><option value="ssaa">SSAA（高画質・高負荷）</option></select>
              <p class="setting-hint" id="hint-antialiasing">SSAA は縦横 2 倍で描いて縮小します。GPU の上限で倍率が下がることがあります。<span class="msaa-note" hidden>この端末の現在の描画設定では MSAA を使えません。</span></p>
            </div>
            <div class="setting-row msaa-row">
              <div class="setting-label"><label for="setting-msaa">MSAA 倍率</label></div>
              <select id="setting-msaa" data-setting="msaaSamples" aria-describedby="hint-msaa">${MSAA_SAMPLES.map((n) => `<option value="${n}">${n}x</option>`).join("")}</select>
              <p class="setting-hint" id="hint-msaa">この端末と現在の設定で使える倍率です。</p>
            </div>
            <div class="setting-row">
              <div class="setting-label"><label for="setting-fps">FPS 上限</label></div>
              <select id="setting-fps" data-setting="fpsLimit" aria-describedby="hint-fps">${FPS_LIMITS.map((n) => `<option value="${n}">${n ? `${n} FPS` : "制限なし"}</option>`).join("")}</select>
              <p class="setting-hint" id="hint-fps">制限なしでは画面のリフレッシュレートに合わせます。</p>
            </div>
            <div class="setting-row">
              <div class="setting-label"><span id="setting-shadows-label">影の品質</span></div>
              <div class="segmented" role="group" aria-labelledby="setting-shadows-label">${shadowOptions.map((o) => `<button type="button" data-shadow="${o.value}" aria-pressed="false">${o.label}</button>`).join("")}</div>
            </div>
          </section>
          <section class="settings-section" aria-labelledby="settings-effects">
            <h3 id="settings-effects">EFFECTS / 演出</h3>
            ${toggle("ambientOcclusion", "陰影を強調 (SSAO・重い)")}
            ${toggle("showFps", "FPS を表示")}
            ${toggle("cameraShake", "画面の揺れ")}
            ${toggle("cameraFollow", "視点の自動追随", "オフにすると足場全体を固定で映します。<kbd>V</kbd> キーかパッドの View でも切り替え。")}
            ${toggle("padRumble", "パッドの振動", "パッドで遊ぶ人が攻撃を受けた・当てた・相殺したときに震えます。")}
          </section>
        </div>
        <div class="settings-foot"><button class="text-button" data-action="reset-settings">初期設定に戻す</button><button class="primary-button" data-action="close-settings">閉じる ${icons.arrow}</button></div>
      </dialog>`;
}

const icons = {
  sword:
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 18 12-12 1-4-4 1L3 15m0-3 9 9M2 22l5-5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  arrow:
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 12h16m-6-6 6 6-6 6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  sound:
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m12 4-6 5H3v6h3l6 5V4Zm4 4a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  mute: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m12 4-6 5H3v6h3l6 5V4Zm4 5 6 6m0-6-6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="2.8" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="6.3" stroke="currentColor" stroke-width="1.6"/><path d="M12 2.6v2.6m0 13.6v2.6M2.6 12h2.6m13.6 0h2.6M5.4 5.4l1.8 1.8m9.6 9.6 1.8 1.8m0-13.2-1.8 1.8m-9.6 9.6-1.8 1.8" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/></svg>',
  camera:
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3.5 8.5A1.5 1.5 0 0 1 5 7h2.2l1.6-2.2h6.4L16.8 7H19a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5v-9Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="12" cy="13" r="3.4" stroke="currentColor" stroke-width="1.6"/></svg>',
  cameraOff:
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3.5 8.5A1.5 1.5 0 0 1 5 7h2.2l1.6-2.2h6.4L16.8 7H19a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5v-9Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="12" cy="13" r="3.4" stroke="currentColor" stroke-width="1.6"/><path d="m3 3 18 18" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  pause:
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8 5v14M16 5v14" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>',
  paw: '<svg viewBox="0 0 32 32" fill="currentColor" aria-hidden="true"><ellipse cx="9" cy="8" rx="3" ry="4" transform="rotate(-24 9 8)"/><ellipse cx="23" cy="8" rx="3" ry="4" transform="rotate(24 23 8)"/><ellipse cx="3.8" cy="16" rx="2.8" ry="3.5" transform="rotate(-30 3.8 16)"/><ellipse cx="28.2" cy="16" rx="2.8" ry="3.5" transform="rotate(30 28.2 16)"/><path d="M7 25c0-4 5-12 9-12s9 8 9 12c0 5-5 3-9 3s-9 2-9-3Z"/></svg>',
};

const modes: Record<MatchMode, { label: string; en: string; detail: string; number: string }> = {
  duel: { label: "一騎打ち", en: "DUEL", detail: "1対1、剣一本の読み合い。", number: "01" },
  rumble: {
    label: "乱闘",
    en: "RUMBLE",
    detail: "4人の浮島。最後のひとりになろう。",
    number: "02",
  },
  training: {
    label: "稽古",
    en: "PRACTICE",
    detail: "静かな道場で、間合いと復帰を試す。",
    number: "03",
  },
};

const levelLabels: Record<AiLevel, string> = { easy: "よわい", normal: "ふつう", hard: "つよい" };

/** The fighters each mode puts on the island, by slot (slot 0 is always a player). */
const FIGHTER_NAMES = ["コハク", "シロ", "モカ", "スミ"] as const;
const fighterCount = (mode: MatchMode) => (mode === "rumble" ? 4 : 2);

/** On a phone or tablet the keyboard player's slot is played with the touch controls. */
const touchOnly = (): boolean =>
  typeof matchMedia === "function" &&
  matchMedia("(pointer: coarse)").matches &&
  !matchMedia("(any-pointer: fine)").matches;

const deviceLabel = (device: ControlDevice) =>
  device === "keyboard" ? (touchOnly() ? "タッチ" : "キーボード") : `パッド${device.slice(3)}`;

/** One row per fighter slot: who plays it, and how strong it is when a CPU does. */
function playerRowMarkup(id: number): string {
  const name = FIGHTER_NAMES[id];
  return `<div class="player-row" data-slot="${id}"><span class="player-name" data-fighter="${id}"><i aria-hidden="true"></i>${name}</span><select class="player-device" data-slot-device="${id}" aria-label="${name}の操作"></select><span class="player-badge" hidden></span><select class="player-level" data-slot-level="${id}" data-override="${id}" aria-label="${name}の強さ" hidden>${(["auto", ...AI_LEVEL_IDS] as const).map((level) => `<option value="${level}">${level === "auto" ? "おまかせ" : levelLabels[level]}</option>`).join("")}</select><span class="player-still" hidden>動かない</span></div>`;
}

function matchOptionsMarkup(): string {
  const segment = (attribute: string, value: string | number, label: string, extra = "") =>
    `<button type="button" data-${attribute}="${value}" aria-pressed="false"${extra}>${label}</button>`;
  return `
          <section class="match-options" aria-labelledby="match-options-title">
            <div class="match-options-head"><h2 id="match-options-title">対戦設定</h2><span>MATCH RULES</span></div>
            <div class="match-options-body">
              <div class="match-option match-rule">
                <span class="match-option-label" id="match-stocks-label">残機</span>
                <div class="segmented match-segmented" role="group" aria-labelledby="match-stocks-label">${STOCK_CHOICES.map((n) => segment("stocks", n, String(n), ` aria-label="${n}機"`)).join("")}</div>
              </div>
              <div class="match-option match-rule">
                <span class="match-option-label" id="match-level-label">CPU の強さ</span>
                <div class="segmented match-segmented" role="group" aria-labelledby="match-level-label">${AI_LEVEL_IDS.map((level) => segment("difficulty", level, levelLabels[level])).join("")}</div>
              </div>
              <div class="player-rows"></div>
              <p class="join-hint" aria-live="polite"></p>
              <p class="match-options-note" hidden>稽古は残機が無制限。CPU の相手は動きません。</p>
            </div>
          </section>`;
}

const statusLabels: Record<Fighter["mode"], string> = {
  idle: "READY",
  charge: "CHARGING",
  windup: "WINDUP",
  active: "SWING",
  recovery: "RECOVERY",
  step: "STEP",
  cancel: "FEINT",
  hitstun: "HIT",
  grab: "GRAB",
  grabbed: "CAUGHT",
  throw: "THROW",
  clash: "CLASH",
  dead: "OUT",
};

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
}

const hex = (color: number) => `#${color.toString(16).padStart(6, "0")}`;

function setText(element: HTMLElement, value: string): void {
  if (element.textContent !== value) element.textContent = value;
}

interface FighterCard {
  element: HTMLElement;
  damage: HTMLElement;
  stamina: HTMLElement;
  staminaValue: HTMLElement;
  status: HTMLElement;
  danger: HTMLElement;
  dangerFill: HTMLElement;
  dangerValue: HTMLElement;
  airRising: HTMLElement;
  airThrust: HTMLElement;
  airStep: HTMLElement;
  level: HTMLElement;
  life: HTMLElement;
  invulnerable: HTMLElement;
  lock: HTMLElement;
  /** What the life display last drew, so it is rebuilt only when it changes. */
  lifeKey: string;
  /** Who the card was drawn for (player number, CPU); a change rebuilds it. */
  identity: string;
}

/** DOM HUD stays independent of the deterministic combat and the Pixi scene. */
export class GameUI {
  private readonly host: HTMLElement;
  private readonly callbacks: GameUICallbacks;
  private readonly abort = new AbortController();
  private readonly menu: HTMLElement;
  private readonly hud: HTMLElement;
  private readonly result: HTMLElement;
  private readonly pausePanel: HTMLElement;
  private readonly dialog: HTMLDialogElement;
  private readonly settingsDialog: HTMLDialogElement;
  private readonly fpsCounter: HTMLElement;
  private readonly graphics: GraphicsSettingsBinding;
  private readonly match: MatchStore;
  private playerRowsMode: MatchMode | null = null;
  private connectedPads: number[] = [];
  private locks: PlayerLock[] = [];
  private lockKey = "";
  /** The running match's players by fighter id: player number and colour. */
  private players = new Map<number, { number: number; color: string }>();
  private keyboardFighter: number | null = null;
  private readonly cards = new Map<number, FighterCard>();
  private currentPhase: Phase = "menu";
  private selectedMode: MatchMode = "duel";
  private sound = true;
  private resumeAfterHelp = false;
  private resumeAfterSettings = false;
  private previousFocus: HTMLElement | null = null;
  private renderSizeFrame = 0;
  private lastFpsText = 0;

  constructor(host: HTMLElement, callbacks: GameUICallbacks) {
    this.host = host;
    this.callbacks = callbacks;
    this.graphics = callbacks.graphics;
    this.match = callbacks.match;
    host.innerHTML = `
      <div class="screen-grain" aria-hidden="true"></div>
      <header class="topbar flex items-center justify-between">
        <a class="wordmark flex items-center gap-3" href="#" aria-label="BRAMBLE ホーム" data-action="brand">
          <span class="wordmark-icon">${icons.paw}</span>
          <span>BRAMBLE<span class="wordmark-edition">GREAT SWORD ARENA</span></span>
        </a>
        <div class="top-actions flex items-center gap-2">
          <span class="prototype-chip"><span></span> PLAYABLE PROTOTYPE</span>
          <button class="icon-button" data-action="sound" aria-label="音をオフにする" aria-pressed="true" title="効果音">${icons.sound}</button>
          <button class="icon-button camera-button" data-action="camera" aria-label="視点の自動追随をオフにする" aria-pressed="true" title="視点の自動追随 · V">${icons.camera}</button>
          <button class="icon-button settings-button" data-action="settings" aria-label="グラフィック設定を開く" title="グラフィック設定">${icons.gear}</button>
          <button class="icon-button help-button" data-action="help" aria-label="操作方法を表示" title="操作方法">?</button>
          <button class="icon-button pause-button" data-action="pause" aria-label="一時停止" title="一時停止 · Esc" hidden>${icons.pause}</button>
        </div>
      </header>

      <main class="menu-screen" aria-label="タイトル画面">
        <div class="menu-content">
          <div class="eyebrow"><span class="tiny-rule"></span> LITTLE PAWS. HEAVY SWORDS.</div>
          <h1>小さな体に、<br>大きな<span>一撃。</span></h1>
          <p class="menu-description">ためて、かわして、吹っ飛ばす。<br>浮島で繰り広げる、大剣の駆け引き。</p>
          <div class="mode-picker" role="group" aria-label="ゲームモード">
            ${Object.entries(modes)
              .map(
                ([id, mode]) =>
                  `<button class="mode-option ${id === "duel" ? "selected" : ""}" data-mode="${id}" aria-pressed="${id === "duel"}"><span class="mode-number">${mode.number}</span><span class="mode-label">${mode.label}<small>${mode.en}</small></span></button>`,
              )
              .join("")}
          </div>
          <p class="mode-description">${modes.duel.detail}</p>
          ${matchOptionsMarkup()}
          <button class="start-button flex items-center justify-between" data-action="start"><span>アリーナへ<span>ENTER THE ARENA</span></span>${icons.arrow}</button>
          <div class="menu-links"><button class="menu-controls-link" data-action="help">操作方法を見る <span>↗</span></button><button class="menu-controls-link" data-action="settings">グラフィック設定 <span>↗</span></button></div>
          <div class="menu-features flex items-center"><span>重い一撃</span><i></i><span>自由なフェイント</span><i></i><span>一瞬の読み合い</span></div>
        </div>
        <div class="arena-caption"><span class="caption-cross">+</span><div>THE FLOATING GARDEN<small>浮遊庭園 / 終わりゆく足場</small></div><span class="caption-line"></span></div>
        <div class="menu-bottom"><span>01 / BRAMBLE</span><span>NO SHIELD. FIND YOUR OPENING.</span><span>v0.1</span></div>
      </main>

      <section class="game-hud" aria-label="対戦情報" hidden>
        <div class="match-heading"><span class="match-mode">DUEL</span><span class="heading-separator"></span><time class="match-time">00:00</time><span class="heading-separator"></span><span class="match-alive">2 ALIVE</span></div>
        <div class="arena-status" aria-live="polite"></div>
        <div class="center-announcement" aria-live="polite"></div>
        <div class="countdown-display" aria-live="assertive" hidden><span>READ YOUR RIVAL</span><strong>3</strong></div>
        <div class="fighter-cards"></div>
        <div class="keyboard-legend" aria-label="操作の一覧">
          <span><kbd>WASD</kbd> 移動</span><span class="legend-lock"><kbd>Tab</kbd> ロックオン</span><span class="legend-target"><kbd>E</kbd> 相手切替</span><span class="legend-mouse"><kbd>↗</kbd> マウスで照準</span><span><kbd>I</kbd> 振り上げ</span><span><kbd>J</kbd> 振り下ろし</span><span><kbd>K</kbd> 横振り</span><span><kbd>L</kbd> 突き</span><span><kbd>U</kbd> つかむ</span><span><kbd>Space</kbd> 跳ぶ</span><span><kbd>Shift</kbd> ステップ</span><span><kbd>Q</kbd> キャンセル</span><span><kbd>V</kbd> 視点</span>
        </div>
        <div class="pad-legend" aria-label="パッド操作の一覧" hidden>
          <span class="pad-legend-title">PAD</span><span><kbd>RB</kbd> 横振り</span><span><kbd>RT</kbd> 振り下ろし</span><span><kbd>LB</kbd> 突き</span><span><kbd>LT</kbd> 振り上げ</span><span><kbd>A</kbd> 跳ぶ</span><span><kbd>B</kbd> ステップ</span><span><kbd>X</kbd> つかむ</span><span><kbd>Y</kbd> キャンセル</span><span><kbd>R3</kbd> ロックオン</span>
        </div>
      </section>

      <section class="pause-screen modal-scrim" role="dialog" aria-modal="true" aria-label="一時停止" hidden>
        <div class="modal-panel pause-panel"><div class="eyebrow">TAKE A BREATH</div><h2>ひと休み。</h2><p>次の一撃を、じっくり考えよう。</p><p class="pause-notice" role="status" hidden></p><button class="primary-button" data-action="resume">対戦に戻る ${icons.arrow}</button><button class="secondary-button" data-action="restart">はじめから</button><button class="secondary-button" data-action="settings">グラフィック設定</button><button class="text-button" data-action="menu">タイトルへ戻る</button></div>
      </section>

      <section class="result-screen modal-scrim" role="dialog" aria-modal="true" aria-label="対戦結果" hidden>
        <div class="modal-panel result-panel"><div class="result-paw">${icons.paw}</div><div class="eyebrow result-eyebrow">LAST PAWS STANDING</div><h2 class="result-title">勝負あり。</h2><p class="result-subtitle"></p><div class="result-stats"><div><strong data-stat="hits">0</strong><span>HITS</span></div><div><strong data-stat="clashes">0</strong><span>CLASHES</span></div><div><strong data-stat="time">0:00</strong><span>TIME</span></div></div><button class="primary-button" data-action="restart">もう一度、勝負 ${icons.arrow}</button><button class="text-button" data-action="menu">タイトルへ戻る</button></div>
      </section>

      <dialog class="help-dialog" aria-labelledby="help-title">
        <div class="help-head flex items-center justify-between"><div><div class="eyebrow">FIELD GUIDE</div><h2 id="help-title">剣の振り方。</h2></div><button class="icon-button" data-action="close-help" aria-label="操作方法を閉じる">×</button></div>
        <div class="help-body">
          <p class="help-intro">%が高いほど、遠くへ吹っ飛ぶ。落ちても残機があれば安全地帯の中へ戻り、点滅しているあいだは少しだけ無敵。相手の残機を削りきり、最後まで生き残ろう。</p>
          <div class="help-columns">
            <section><h3>MOVE / 移動と回避</h3><dl class="key-list"><div><dt><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></dt><dd>移動 / 吹っ飛び方向の微調整</dd></div><div><dt><kbd>Tab</kbd> ロックオン　<kbd>E</kbd> / ホイール 相手切替</dt><dd>ロックオン中は相手に向き続ける。Tab で解除するとマウス・矢印キー・右スティックで自由に向ける</dd></div><div><dt><kbd>Space</kbd></dt><dd>ジャンプ（空中ジャンプなし）</dd></div><div><dt><kbd>Shift</kbd> + 移動</dt><dd>向きを変えずにステップ / 空中でも1回</dd></div><div><dt><kbd>V</kbd> / <kbd>Esc</kbd></dt><dd>視点の自動追随の切り替え / 一時停止</dd></div></dl></section>
            <section><h3>ATTACK / 大剣の4つの技</h3><dl class="key-list"><div><dt><kbd>J</kbd> 振り下ろし</dt><dd>重い一撃 / 空中ではメテオ</dd></div><div><dt><kbd>I</kbd> 振り上げ</dt><dd>斜め上へ上昇 / 復帰にも</dd></div><div><dt><kbd>K</kbd> 横振り</dt><dd>広い横幅 / 横ステップを狩る</dd></div><div><dt><kbd>L</kbd> 突き</dt><dd>前へ踏み込む / 空中の横復帰</dd></div><div><dt><kbd>U</kbd> つかむ</dt><dd>近距離でつかみ、移動方向に投げる</dd></div></dl></section>
          </div>
          <div class="help-callout"><span class="callout-icon">${icons.sword}</span><div><strong>長押しでためる。<kbd>Q</kbd> でフェイント。</strong><p>ため中はキャンセルやステップに移れる。振りかぶり中は向きをゆっくり直せて、Qで止めることもできるが、スタミナは戻らず、遅く止めるほど隙が残る。斬りかかった剣は向きが固まり、最後まで振り抜く。</p></div></div>
          <div class="help-tips"><div><span>01</span><p><strong>剣と剣がぶつかると相殺。</strong>被弾時は移動入力で吹っ飛び方向を少し調整できる。</p></div><div><span>02</span><p><strong>復帰は上昇・突き・空中回避で。</strong>空中で各1回。着地すれば再び使える。</p></div><div><span>03</span><p><strong>光る円の内側が安全地帯。</strong>外では%とゲージが増加。5秒分たまるとアウト、内側ではゲージが回復する。</p></div><div><span>04</span><p><strong>赤い予告は爆撃、縁の点滅は崩壊。</strong>足場とスタミナを残して攻めよう。</p></div></div>
          <p class="controller-note">マウス左クリックは振り下ろし、右クリックは横振り。中ボタンでロックオンの切り替え。</p>
          <section class="pad-help" aria-labelledby="pad-help-title">
            <h3 id="pad-help-title">GAMEPAD / パッド</h3>
            <p class="pad-help-lead">パッドは4台まで、何人でも参加できます。キーボードとマウス（タッチ）はひとり分。タイトルでパッドの <kbd>A</kbd> か <kbd>Start</kbd> を押すと参加、<kbd>B</kbd> で抜けます。</p>
            <dl class="pad-table">
              <div><dt><kbd>RB</kbd></dt><dd>横振り</dd></div>
              <div><dt><kbd>RT</kbd></dt><dd>振り下ろし</dd></div>
              <div><dt><kbd>LB</kbd></dt><dd>突き</dd></div>
              <div><dt><kbd>LT</kbd></dt><dd>振り上げ</dd></div>
              <div><dt><kbd>A</kbd></dt><dd>ジャンプ</dd></div>
              <div><dt><kbd>B</kbd></dt><dd>ステップ（空中でも1回）</dd></div>
              <div><dt><kbd>X</kbd></dt><dd>つかむ</dd></div>
              <div><dt><kbd>Y</kbd></dt><dd>キャンセル</dd></div>
              <div><dt><kbd>L</kbd> スティック</dt><dd>移動</dd></div>
              <div><dt><kbd>R</kbd> スティック</dt><dd>照準 / ロック中は弾いて相手切替</dd></div>
              <div><dt><kbd>R3</kbd></dt><dd>ロックオン切替</dd></div>
              <div><dt><kbd>◀</kbd><kbd>▶</kbd> 十字キー</dt><dd>相手切替</dd></div>
              <div><dt><kbd>View</kbd></dt><dd>視点の自動追随</dd></div>
              <div><dt><kbd>Start</kbd></dt><dd>一時停止 / 再開</dd></div>
            </dl>
            <p class="pad-help-foot">技はボタンを押し続けるとためられます。メニューも十字キーと <kbd>A</kbd>（決定）・<kbd>B</kbd>（戻る）で操作できます。</p>
          </section>
          <p class="touch-note">タッチ操作では左スティックで移動、右の技ボタンを長押しでためます。照準は常に相手へロックオンし、乱闘では「相手切替」ボタンで狙う相手を変えられます。視点は右上のカメラボタンで切り替えられます。</p>
        </div>
        <button class="primary-button help-done" data-action="close-help">準備できた ${icons.arrow}</button>
      </dialog>
      ${settingsDialogMarkup()}
      <div class="fps-counter" aria-hidden="true" hidden>-- FPS</div>
    `;
    this.menu = this.query(".menu-screen");
    this.hud = this.query(".game-hud");
    this.result = this.query(".result-screen");
    this.pausePanel = this.query(".pause-screen");
    this.dialog = this.query<HTMLDialogElement>(".help-dialog");
    this.settingsDialog = this.query<HTMLDialogElement>(".settings-dialog");
    this.fpsCounter = this.query(".fps-counter");
    host.addEventListener("click", this.handleClick, { signal: this.abort.signal });
    for (const [dialog, close] of [
      [this.dialog, () => this.closeHelp()],
      [this.settingsDialog, () => this.closeSettings()],
    ] as const) {
      dialog.addEventListener("keydown", (event) => event.stopPropagation(), {
        signal: this.abort.signal,
      });
      dialog.addEventListener("cancel", close, { signal: this.abort.signal });
      dialog.addEventListener(
        "click",
        (event) => {
          if (event.target !== dialog) return;
          const rect = dialog.getBoundingClientRect();
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            close();
        },
        { signal: this.abort.signal },
      );
    }
    this.settingsDialog.addEventListener("change", this.handleSettingChange, {
      signal: this.abort.signal,
    });
    const unsubscribe = this.graphics.store.subscribe(() => this.syncSettings());
    this.abort.signal.addEventListener("abort", unsubscribe);
    window.addEventListener("resize", () => this.refreshRenderSize(), {
      signal: this.abort.signal,
    });
    this.syncSettings();
    this.query(".match-options").addEventListener("change", this.handleMatchChange, {
      signal: this.abort.signal,
    });
    const unsubscribeMatch = this.match.subscribe(() => this.syncMatchOptions());
    this.abort.signal.addEventListener("abort", unsubscribeMatch);
    this.syncMatchOptions();
  }

  /** Reflects the stored match options, the selected mode and the connected pads in the title. */
  private syncMatchOptions(): void {
    const options = this.match.get();
    const block = this.query(".match-options");
    const mode = this.selectedMode;
    const training = mode === "training";
    const count = fighterCount(mode);
    block.classList.toggle("practice", training);
    block.classList.toggle("four-players", count > 2);
    for (const rule of block.querySelectorAll<HTMLElement>(".match-rule")) rule.hidden = training;
    this.query(".match-options-note").hidden = !training;
    const rows = this.query(".player-rows");
    if (this.playerRowsMode !== mode) {
      this.playerRowsMode = mode;
      rows.innerHTML = Array.from({ length: count }, (_, id) => playerRowMarkup(id)).join("");
    }
    const pressed = (selector: string, isOn: (button: HTMLElement) => boolean) => {
      for (const button of block.querySelectorAll<HTMLElement>(selector))
        button.setAttribute("aria-pressed", String(isOn(button)));
    };
    pressed("[data-stocks]", (b) => Number(b.dataset.stocks) === options.stocks);
    pressed("[data-difficulty]", (b) => b.dataset.difficulty === options.difficulty);

    const connected = (pad: number) => this.connectedPads.includes(pad);
    const { options: playable, substitutes } = playableOptions(options, count, connected);
    const players = humanSlots(playable, count);
    for (let id = 0; id < count; id++) {
      const row = rows.querySelector<HTMLElement>(`[data-slot="${id}"]`)!;
      const stored = options.controls[id] ?? null;
      const device = row.querySelector<HTMLSelectElement>(".player-device")!;
      // Sensible choices only: the keyboard, the connected pads, and this slot's own pad even
      // while it is away. A CPU slot cannot take slot 0's device (slot 0 would be left empty).
      const choices: { value: string; label: string }[] = [];
      for (const candidate of [
        "keyboard",
        ...Array.from({ length: PAD_COUNT }, (_, i) => `pad${i + 1}`),
      ] as ControlDevice[]) {
        const pad = padIndex(candidate);
        if (pad !== null && !connected(pad) && candidate !== stored) continue;
        if (id > 0 && stored === null && options.controls[0] === candidate) continue;
        choices.push({
          value: candidate,
          label: deviceLabel(candidate) + (pad !== null && !connected(pad) ? "（未接続）" : ""),
        });
      }
      if (id > 0) choices.push({ value: "cpu", label: "CPU" });
      const markup = choices.map((c) => `<option value="${c.value}">${c.label}</option>`).join("");
      if (device.dataset.markup !== markup) {
        device.dataset.markup = markup;
        device.innerHTML = markup;
      }
      device.value = stored ?? "cpu";
      device.disabled = choices.length < 2;
      const player = players.findIndex((slot) => slot.id === id);
      const missing = substitutes.some((sub) => sub.slot === id);
      row.classList.toggle("human", player >= 0);
      row.classList.toggle("missing", missing);
      const badge = row.querySelector<HTMLElement>(".player-badge")!;
      badge.hidden = player < 0;
      setText(badge, players.length > 1 ? `P${player + 1}` : "YOU");
      const level = row.querySelector<HTMLSelectElement>(".player-level")!;
      level.hidden = player >= 0 || training;
      level.value = options.overrides[id] ?? "auto";
      row.querySelector<HTMLElement>(".player-still")!.hidden = player >= 0 || !training;
    }
    const lost = substitutes.find((sub) => padIndex(sub.device) !== null);
    const hint = this.query(".join-hint");
    hint.classList.toggle("warning", Boolean(lost));
    const markup = lost
      ? lost.by === "keyboard"
        ? `${deviceLabel(lost.device)}が未接続のため、${FIGHTER_NAMES[lost.slot]}は${deviceLabel("keyboard")}で操作します`
        : `未接続のパッドの枠は CPU が戦います`
      : `<span class="pad-key">A</span>パッドのボタンを押して参加<span class="hint-dot"></span><span class="pad-key">B</span>抜ける`;
    if (hint.innerHTML !== markup) hint.innerHTML = markup;
  }

  /** The connected pads (indices 0-3), for the title's device choices. */
  setPads(connected: number[]): void {
    this.connectedPads = connected.slice();
    this.syncMatchOptions();
  }

  /**
   * The title's join shortcut, from the pad menu: A or Start on a pad that does not play in the
   * selected mode puts it on the first CPU slot; B on a pad that does (not slot 0) removes it.
   * Returns true when the press did that.
   */
  padTitleButton(index: number, button: TitleButton): boolean {
    if (this.dialog.open || this.settingsDialog.open) return false;
    const count = fighterCount(this.selectedMode);
    const slot = button === "b" ? this.match.leave(index, count) : this.match.join(index, count);
    if (slot === null) return false;
    const row = this.host.querySelector<HTMLElement>(`.player-row[data-slot="${slot}"]`);
    if (row) {
      row.classList.remove("flash");
      void row.offsetWidth;
      row.classList.add("flash");
    }
    return true;
  }

  /** The line under the pause title: a pad that went away, or null. */
  setPadNotice(text: string | null): void {
    const notice = this.query(".pause-notice");
    notice.hidden = !text;
    setText(notice, text ?? "");
  }

  /** The title rows' selects: who plays a slot, and a CPU's strength. */
  private handleMatchChange = (event: Event): void => {
    const control = event.target as HTMLSelectElement;
    const count = fighterCount(this.selectedMode);
    if (control.dataset.slotDevice !== undefined) {
      const value = control.value;
      this.match.assign(
        Number(control.dataset.slotDevice),
        value === "cpu" ? null : (value as ControlDevice),
        count,
      );
      // A refused change (slot 0 cannot become a CPU) puts the select back.
      this.syncMatchOptions();
    } else if (control.dataset.slotLevel !== undefined) {
      const overrides = { ...this.match.get().overrides };
      const id = Number(control.dataset.slotLevel);
      if (control.value === "auto") delete overrides[id];
      else overrides[id] = control.value as AiLevel;
      this.match.set({ overrides });
    }
  };

  private handleSettingChange = (event: Event): void => {
    const control = event.target as HTMLInputElement | HTMLSelectElement;
    const key = control.dataset.setting as keyof GraphicsSettings | undefined;
    if (!key) return;
    const value =
      control instanceof HTMLInputElement && control.type === "checkbox"
        ? control.checked
        : key === "msaaSamples" || key === "fpsLimit"
          ? Number(control.value)
          : control.value;
    this.graphics.store.set({ [key]: value } as Partial<GraphicsSettings>);
  };

  /** Reflects the stored settings (and what this GPU supports) in every control. */
  private syncSettings(): void {
    const s = this.graphics.store.get();
    const dialog = this.settingsDialog;
    const supported = this.graphics.supportedMsaa(s.ambientOcclusion);
    const samples = supported ? effectiveSamples(s.msaaSamples, supported) : s.msaaSamples;
    const msaaUnavailable = supported !== null && samples === undefined;
    const mode = s.antialiasing === "msaa" && msaaUnavailable ? "off" : s.antialiasing;
    const select = (key: keyof GraphicsSettings) =>
      dialog.querySelector<HTMLSelectElement>(`select[data-setting="${key}"]`)!;
    select("resolution").value = s.resolution;
    const aa = select("antialiasing");
    aa.value = mode;
    aa.querySelector<HTMLOptionElement>('option[value="msaa"]')!.disabled = msaaUnavailable;
    dialog.querySelector<HTMLElement>(".msaa-note")!.hidden = !msaaUnavailable;
    const msaa = select("msaaSamples");
    for (const option of msaa.options) {
      const unsupported =
        supported !== null && !supported.includes(Number(option.value) as MsaaSamples);
      option.hidden = unsupported;
      option.disabled = unsupported;
    }
    msaa.value = String(samples ?? s.msaaSamples);
    dialog.querySelector<HTMLElement>(".msaa-row")!.hidden = mode !== "msaa";
    select("fpsLimit").value = String(s.fpsLimit);
    for (const button of dialog.querySelectorAll<HTMLButtonElement>("[data-shadow]"))
      button.setAttribute("aria-pressed", String(button.dataset.shadow === s.shadows));
    for (const input of dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
      const key = input.dataset.setting as keyof GraphicsSettings;
      input.checked = Boolean(s[key]);
    }
    const ao = dialog.querySelector<HTMLInputElement>('input[data-setting="ambientOcclusion"]')!;
    ao.disabled = this.graphics.supportsAmbientOcclusion() === false;
    this.fpsCounter.hidden = !s.showFps;
    const camera = this.query('[data-action="camera"]');
    if (camera.getAttribute("aria-pressed") !== String(s.cameraFollow)) {
      camera.setAttribute("aria-pressed", String(s.cameraFollow));
      camera.setAttribute(
        "aria-label",
        s.cameraFollow ? "視点の自動追随をオフにする" : "視点の自動追随をオンにする",
      );
      camera.innerHTML = s.cameraFollow ? icons.camera : icons.cameraOff;
    }
    this.refreshRenderSize();
  }

  /** The renderer applies a change on the same tick; its drawn size is read on the next frame. */
  private refreshRenderSize(): void {
    cancelAnimationFrame(this.renderSizeFrame);
    this.renderSizeFrame = requestAnimationFrame(() => {
      const size = this.graphics.renderSize();
      const output = this.settingsDialog.querySelector<HTMLOutputElement>(
        '[data-output="resolution"]',
      )!;
      output.textContent = size ? `${size.width} × ${size.height}` : "";
    });
  }

  /** Smoothed frames per second for the optional counter; the text changes at most 4× a second. */
  setFps(fps: number): void {
    if (this.fpsCounter.hidden) return;
    const now = performance.now();
    if (now - this.lastFpsText < 250) return;
    this.lastFpsText = now;
    setText(this.fpsCounter, `${Math.round(fps)} FPS`);
  }

  /**
   * Every player's lock-on, from the input each UI tick: a chip on each target's card. With one
   * player it reads LOCK; with several it names the player (P1 LOCK) in that player's colour.
   */
  setLock(locks: PlayerLock[]): void {
    this.locks = locks;
    this.applyLock();
  }

  private applyLock(): void {
    const several = this.players.size > 1;
    const key = JSON.stringify([several, this.locks, [...this.cards.keys()]]);
    if (key !== this.lockKey) {
      this.lockKey = key;
      for (const [id, card] of this.cards) {
        const chips = this.locks.filter((lock) => lock.on && lock.targetId === id);
        card.lock.hidden = chips.length === 0;
        card.lock.innerHTML = chips
          .map((lock) => {
            const player = this.players.get(lock.fighterId);
            if (!several || !player) return '<span class="fighter-lock">LOCK</span>';
            return `<span class="fighter-lock player-lock" style="--lock-color: ${player.color}">P${player.number} LOCK</span>`;
          })
          .join("");
      }
    }
    // The keyboard legend follows the keyboard player's lock (or the only player's).
    const legendLock =
      this.locks.find((lock) => lock.fighterId === this.keyboardFighter) ??
      (this.locks.length === 1 ? this.locks[0] : undefined);
    this.hud.classList.toggle("lock-off", legendLock ? !legendLock.on : false);
  }

  private query<T extends HTMLElement = HTMLElement>(selector: string): T {
    const element = this.host.querySelector<T>(selector);
    if (!element) throw new Error(`Missing UI element: ${selector}`);
    return element;
  }

  private handleClick = (event: MouseEvent): void => {
    // Buttons only: the host itself carries data-mode (the running match's mode).
    const target = (event.target as Element).closest<HTMLElement>(
      "[data-action], button[data-mode], [data-shadow], [data-stocks], [data-difficulty]",
    );
    if (!target) return;
    const shadow = target.dataset.shadow as ShadowLevel | undefined;
    if (shadow) {
      this.graphics.store.set({ shadows: shadow });
      return;
    }
    if (target.dataset.stocks) {
      this.match.set({ stocks: Number(target.dataset.stocks) });
      return;
    }
    if (target.dataset.difficulty) {
      this.match.set({ difficulty: target.dataset.difficulty as AiLevel });
      return;
    }
    const mode = target.dataset.mode as MatchMode | undefined;
    if (mode) {
      this.selectedMode = mode;
      this.host.querySelectorAll<HTMLElement>("button[data-mode]").forEach((button) => {
        button.classList.toggle("selected", button.dataset.mode === mode);
        button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
      });
      this.query(".mode-description").textContent = modes[mode].detail;
      this.syncMatchOptions();
      return;
    }
    switch (target.dataset.action) {
      case "start":
        this.callbacks.onStart(this.selectedMode, this.match.get());
        break;
      case "camera":
        this.graphics.store.set({ cameraFollow: !this.graphics.store.get().cameraFollow });
        break;
      case "pause":
        this.callbacks.onPause();
        break;
      case "resume":
        this.callbacks.onResume();
        break;
      case "restart":
        this.callbacks.onRestart();
        break;
      case "menu":
        this.callbacks.onMenu();
        break;
      case "brand":
        event.preventDefault();
        if (this.currentPhase === "menu") this.callbacks.onMenu();
        else this.callbacks.onPause();
        break;
      case "help":
        this.openHelp();
        break;
      case "close-help":
        this.closeHelp();
        break;
      case "settings":
        this.openSettings();
        break;
      case "close-settings":
        this.closeSettings();
        break;
      case "reset-settings":
        this.graphics.store.reset();
        break;
      case "sound": {
        this.sound = !this.sound;
        target.innerHTML = this.sound ? icons.sound : icons.mute;
        target.setAttribute("aria-pressed", String(this.sound));
        target.setAttribute("aria-label", this.sound ? "音をオフにする" : "音をオンにする");
        this.callbacks.onSound(this.sound);
        break;
      }
    }
  };

  private openHelp(): void {
    if (this.dialog.open) return;
    this.previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.resumeAfterHelp = this.currentPhase === "playing" || this.currentPhase === "countdown";
    if (this.resumeAfterHelp) this.callbacks.onPause();
    this.dialog.showModal();
  }

  private closeHelp(): void {
    if (!this.dialog.open) return;
    this.dialog.close();
    this.previousFocus?.focus();
    if (this.resumeAfterHelp) this.callbacks.onResume();
    this.resumeAfterHelp = false;
  }

  private openSettings(): void {
    if (this.settingsDialog.open || this.dialog.open) return;
    this.previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Opened from the pause panel the match stays paused; during play it pauses and resumes.
    this.resumeAfterSettings = this.currentPhase === "playing" || this.currentPhase === "countdown";
    if (this.resumeAfterSettings) this.callbacks.onPause();
    this.syncSettings();
    this.host.dataset.settingsOpen = "";
    this.settingsDialog.showModal();
  }

  private closeSettings(): void {
    if (!this.settingsDialog.open) return;
    this.settingsDialog.close();
    delete this.host.dataset.settingsOpen;
    this.previousFocus?.focus();
    if (this.resumeAfterSettings) this.callbacks.onResume();
    this.resumeAfterSettings = false;
  }

  /** The card's tag: YOU alone, P1 / P2 … with several players, CPU 0n for the others. */
  private identity(fighter: Fighter): string {
    if (!fighter.human) return "CPU " + String(fighter.id).padStart(2, "0");
    return this.players.size > 1 ? `P${fighter.player ?? 1}` : "YOU";
  }

  private createCard(fighter: Fighter): FighterCard {
    const card = document.createElement("article");
    const tag = this.identity(fighter);
    card.className = `fighter-card ${fighter.human ? "player-card" : "opponent-card"}`;
    card.dataset.fighter = String(fighter.id);
    card.style.setProperty("--fighter-color", hex(fighter.color));
    card.setAttribute(
      "aria-label",
      tag === "YOU"
        ? "あなたの状態"
        : fighter.human
          ? `${tag}（${fighter.name}）の状態`
          : `${fighter.name}の状態`,
    );
    card.innerHTML = `
      <div class="fighter-card-top"><span class="fighter-tags"><span class="fighter-tag">${tag}</span><span class="fighter-level"></span></span><span class="fighter-status">READY</span></div>
      <span class="fighter-invulnerable" hidden>無敵</span><span class="fighter-locks" hidden></span>
      <div class="fighter-main"><span class="fighter-avatar species-${fighter.species}">${icons.paw}</span><div class="fighter-ident"><span class="fighter-name">${escapeHtml(fighter.name)}</span><span class="fighter-species">${fighter.species.toUpperCase()}</span><span class="fighter-life" role="img"></span></div><strong class="fighter-damage"><span>0</span><small>%</small></strong></div>
      <div class="stamina-label"><span>STAMINA</span><span class="stamina-value">100</span></div><div class="stamina-track" role="meter" aria-label="スタミナ" aria-valuemin="0" aria-valuemax="100"><span></span></div>
      <div class="fighter-foot"><div class="air-tokens"><span class="air-rising" title="空中振り上げの使用権">↗</span><span class="air-thrust" title="空中突きの使用権">→</span><span class="air-step" title="空中回避の使用権">»</span><small>RECOVERY</small></div></div>
      <div class="outside-warning" hidden><div><span>エリア外</span><strong>0.0 / 5s</strong></div><div class="outside-track"><span></span></div></div>
    `;
    this.query(".fighter-cards").append(card);
    const q = <T extends HTMLElement = HTMLElement>(selector: string): T =>
      card.querySelector<T>(selector)!;
    return {
      element: card,
      damage: q(".fighter-damage span"),
      stamina: q(".stamina-track span"),
      staminaValue: q(".stamina-value"),
      status: q(".fighter-status"),
      danger: q(".outside-warning"),
      dangerFill: q(".outside-track span"),
      dangerValue: q(".outside-warning strong"),
      airRising: q(".air-rising"),
      airThrust: q(".air-thrust"),
      airStep: q(".air-step"),
      level: q(".fighter-level"),
      life: q(".fighter-life"),
      invulnerable: q(".fighter-invulnerable"),
      lock: q(".fighter-locks"),
      lifeKey: "",
      identity: this.identity(fighter),
    };
  }

  update(state: GameState): void {
    const changedPhase = this.currentPhase !== state.phase;
    this.currentPhase = state.phase;
    this.host.dataset.phase = state.phase;
    this.host.dataset.mode = state.mode;
    const inMatch = state.phase !== "menu";
    this.menu.hidden = inMatch;
    this.hud.hidden = !inMatch;
    this.pausePanel.hidden = state.phase !== "paused";
    this.result.hidden = state.phase !== "ended";
    this.query(".pause-button").hidden = !["playing", "countdown"].includes(state.phase);
    if (changedPhase && !this.dialog.open && !this.settingsDialog.open) {
      if (state.phase === "paused")
        this.pausePanel.querySelector<HTMLButtonElement>('[data-action="resume"]')?.focus();
      if (state.phase === "ended")
        this.result.querySelector<HTMLButtonElement>('[data-action="restart"]')?.focus();
    }

    const time = `${Math.floor(state.elapsed / 60)
      .toString()
      .padStart(2, "0")}:${Math.floor(state.elapsed % 60)
      .toString()
      .padStart(2, "0")}`;
    this.query(".match-time").textContent = time;
    this.query(".match-mode").textContent = modes[state.mode].en;
    // Training respawns everyone for ever; elsewhere a fighter is in the match while it has lives.
    const training = state.mode === "training";
    this.query(".match-alive").textContent = `${
      state.fighters.filter((fighter) => (training ? fighter.mode !== "dead" : fighter.stocks > 0))
        .length
    } ALIVE`;

    const arenaStatus = this.query(".arena-status");
    const nextCollapse = Math.max(0, Math.ceil(state.arena.nextCollapse - state.elapsed));
    arenaStatus.classList.toggle("warning", state.arena.warningRing);
    if (state.mode === "training") setText(arenaStatus, "PRACTICE FIELD  ·  ギミックなし");
    else if (state.arena.warningRing) setText(arenaStatus, `外周崩壊まで ${nextCollapse} 秒`);
    else if (state.arena.safeZone.active) setText(arenaStatus, "SAFE ZONE MOVING  ·  光の円へ");
    else setText(arenaStatus, "THE FLOATING GARDEN");

    const announcement = this.query(".center-announcement");
    setText(announcement, state.message);
    announcement.hidden = state.messageTime <= 0 || state.phase !== "playing";
    const countdown = this.query(".countdown-display");
    countdown.hidden = state.phase !== "countdown";
    setText(
      countdown.querySelector<HTMLElement>("strong")!,
      String(Math.max(1, Math.ceil(state.countdown))),
    );

    // The players of this match: number and colour for the lock chips, devices for the legends.
    const slots = humanSlots(state.options, state.fighters.length);
    this.players = new Map(
      state.fighters
        .filter((fighter) => fighter.human)
        .map((fighter) => [fighter.id, { number: fighter.player ?? 1, color: hex(fighter.color) }]),
    );
    this.keyboardFighter = slots.find((slot) => slot.device === "keyboard")?.id ?? null;
    const padPlayers = slots.some((slot) => slot.device !== "keyboard");
    this.hud.classList.toggle("no-keyboard", this.keyboardFighter === null);
    this.hud.classList.toggle("has-pads", padPlayers);
    this.query(".keyboard-legend").hidden = this.keyboardFighter === null;
    this.query(".pad-legend").hidden = !padPlayers;

    const ids = new Set(state.fighters.map((fighter) => fighter.id));
    let rebuilt = false;
    for (const [id, card] of this.cards) {
      const fighter = state.fighters.find((f) => f.id === id);
      if (!ids.has(id) || !fighter || card.identity !== this.identity(fighter)) {
        card.element.remove();
        this.cards.delete(id);
      }
    }
    for (const fighter of state.fighters) {
      let card = this.cards.get(fighter.id);
      if (!card) {
        card = this.createCard(fighter);
        this.cards.set(fighter.id, card);
        rebuilt = true;
      }
      card.damage.textContent = String(Math.floor(fighter.damage));
      // Down with a life left (or anywhere in training) is a pause, not the end.
      const out = fighter.mode === "dead" && !training && fighter.stocks <= 0;
      const respawning = fighter.mode === "dead" && !out;
      card.element.classList.toggle("eliminated", out);
      card.element.classList.toggle("respawning", respawning);
      card.invulnerable.hidden = fighter.mode === "dead" || fighter.invulnerable <= 0.3;
      setText(card.level, fighter.human || training ? "" : levelLabels[fighter.aiLevel]);
      this.drawLives(card, fighter, state);
      card.element.classList.toggle("high-damage", fighter.damage >= 80);
      card.element.classList.toggle("critical-damage", fighter.damage >= 140);
      card.element.classList.toggle("charging", fighter.mode === "charge");
      card.element.style.setProperty(
        "--charge",
        String(Math.min(1, fighter.charge / RULES.maxCharge)),
      );
      setText(card.status, out ? "OUT" : respawning ? "復帰中" : statusLabels[fighter.mode]);
      card.stamina.style.transform = `scaleX(${Math.max(0, Math.min(1, fighter.stamina / RULES.maxStamina))})`;
      card.stamina.parentElement!.setAttribute(
        "aria-valuenow",
        String(Math.round(fighter.stamina)),
      );
      card.staminaValue.textContent = String(Math.ceil(fighter.stamina));
      card.element.classList.toggle("low-stamina", fighter.stamina < 25);
      card.danger.hidden = fighter.outsideTime <= 0 || fighter.mode === "dead";
      card.dangerFill.style.transform = `scaleX(${Math.min(1, fighter.outsideTime / RULES.outsideLimit)})`;
      card.dangerValue.textContent = `${fighter.outsideTime.toFixed(1)} / 5s`;
      card.airRising.classList.toggle("used", fighter.airRisingUsed);
      card.airThrust.classList.toggle("used", fighter.airThrustUsed);
      card.airStep.classList.toggle("used", fighter.airStepUsed);
    }

    // Cards stay in fighter order (the first, always a player, sits on the left).
    if (rebuilt)
      this.query(".fighter-cards").append(
        ...state.fighters.map((fighter) => this.cards.get(fighter.id)!.element),
      );
    this.applyLock();

    if (state.phase === "ended") {
      const winner = state.fighters.find((fighter) => fighter.id === state.winnerId);
      const humans = state.fighters.filter((fighter) => fighter.human);
      const several = humans.length > 1;
      const tag = winner?.human && several ? `P${winner.player ?? 1}` : null;
      this.query(".result-title").textContent = winner?.human
        ? tag
          ? `${tag} の勝ち。`
          : "あなたの勝ち。"
        : winner
          ? "また、挑もう。"
          : "相打ち。";
      this.query(".result-eyebrow").textContent = winner?.human
        ? "LITTLE PAWS. BIG VICTORY."
        : "EVERY SWING TEACHES SOMETHING.";
      // Lives left only say something when there were several to lose.
      const livesLeft =
        winner && state.options.stocks > 1 && winner.stocks > 0 ? winner.stocks : null;
      // The reason the player went out only reads right with one player.
      const reason = !several ? humans[0]?.eliminationReason : null;
      const who = tag ? `${winner!.name}が` : "";
      this.query(".result-subtitle").textContent = winner?.human
        ? livesLeft
          ? `${who}残機を ${livesLeft} つ残して、足場を守り抜いた。`
          : `${who}最後まで、足場を守り抜いた。`
        : winner
          ? `${winner.name} の勝利${livesLeft ? `（残機 ${livesLeft}）` : ""}${reason ? ` / ${reason}` : ""}`
          : "次の一撃で、決着をつけよう。";
      this.query('[data-stat="hits"]').textContent = String(state.stats.hits);
      this.query('[data-stat="clashes"]').textContent = String(state.stats.clashes);
      this.query('[data-stat="time"]').textContent = time;
    }
  }

  /** One pip per life in the fighter's colour, lost ones hollow; ∞ in training. */
  private drawLives(card: FighterCard, fighter: Fighter, state: GameState): void {
    const training = state.mode === "training";
    const left = Math.max(0, fighter.stocks);
    const total = Math.max(left, state.options.stocks);
    const key = training ? "inf" : `${left}/${total}`;
    if (card.lifeKey === key) return;
    card.lifeKey = key;
    card.life.setAttribute("aria-label", training ? "残機 無制限" : `残機 ${left}`);
    card.life.classList.toggle("infinite", training);
    if (training) card.life.innerHTML = '<span class="life-infinite">∞</span>';
    else if (total > 5)
      card.life.innerHTML = `<i class="${left ? "" : "lost"}"></i><span class="life-count">×${left}</span>`;
    else
      card.life.innerHTML = Array.from(
        { length: total },
        (_, i) => `<i${i < left ? "" : ' class="lost"'}></i>`,
      ).join("");
  }

  destroy(): void {
    this.abort.abort();
    cancelAnimationFrame(this.renderSizeFrame);
    this.dialog.close();
    this.settingsDialog.close();
    this.host.replaceChildren();
  }
}
