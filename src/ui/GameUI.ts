import type { Fighter, GameState, MatchMode, Phase } from "../game/types";
import { ZONE_KO_REASON } from "../game/safeZone";
import { zoneDirections, zoneStatus } from "./zoneHud";
import { RULES } from "../game/tuning";
import { effectiveSamples, FPS_LIMITS, MSAA_SAMPLES, RESOLUTION_OPTIONS } from "../game/settings";
import type { GraphicsSettings, MsaaSamples, SettingsStore, ShadowLevel } from "../game/settings";
import {
  ACCESSORIES,
  ACCESSORY_IDS,
  CHARACTERS,
  cssColor,
  PALETTE_IDS,
  PALETTES,
  sameLoadout,
  SPECIES_IDS,
} from "../game/characters";
import type { AccessoryId, Loadout, PaletteId, Species } from "../game/characters";
import { isClimax, type PresentationEvent } from "../game/presentation";
import {
  countHumans,
  fighterTag,
  fighterTitle,
  SLOT_SHAPE_LABELS,
  SLOT_SHAPE_POINTS,
  slotShape,
} from "../game/identity";
import { AI_LEVEL_IDS, humanSlots, padIndex, STOCK_CHOICES } from "../game/match";
import type { AiLevel, ControlDevice, MatchOptions } from "../game/match";
import { playableOptions, type MatchStore } from "../game/matchStore";
import {
  LADDER_ROUNDS,
  ladderMatchOptions,
  type LadderOpponent,
  type LadderProgress,
} from "../game/ladder";
import {
  formatAccuracy,
  formatDamage,
  KO_CREDIT_SECONDS,
  type PlayerMatchStats,
} from "../game/matchStats";
import {
  describeRules,
  effectiveRules,
  formatClock,
  GIMMICK_DETAILS,
  GIMMICK_IDS,
  GIMMICK_LABELS,
  PRESET_IDS,
  PRESET_LABELS,
  presetOf,
  RULE_PRESETS,
  timeLimitFor,
  TIME_RULES,
  type GimmickId,
  type PresetId,
  type StageInfo,
  type TimeRule,
} from "../game/rules";
import { SET_FORMAT_LABELS, type SetFormat } from "../game/setMatch";
import {
  GIMMICK_IDS as STAGE_GIMMICK_IDS,
  GIMMICK_LABELS as STAGE_GIMMICK_LABELS,
  STAGE_LIST,
  STAGES,
  stageInfoFor,
} from "../game/stages";
import type { GimmickState, StageDefinition, StageId } from "../game/stages";
import type { PlayerLock } from "../game/input";
import { PAD_COUNT } from "../game/pads";
import type { TitleButton } from "./padMenu";

export interface GameUICallbacks {
  /** Starts a match with the title menu's mode and match options. */
  onStart: (mode: MatchMode, options: MatchOptions) => void;
  onStartLadder: (options: MatchOptions) => void;
  onLadderContinue: () => void;
  onPause: () => void;
  onResume: () => void;
  onRestart: () => void;
  onNextGame: () => void;
  onMenu: () => void;
  onSound: (enabled: boolean) => void;
  /** The title's mode or match options changed: the line-up of fighters behind the menu follows. */
  onPreview: (mode: MatchMode, options: MatchOptions) => void;
  /** The slot whose look is being chosen, for a close-up of its fighter; null when done. */
  onSpotlight: (slot: number | null) => void;
  /** The remembered 対戦設定 (who plays what, their looks, lives, time limit, gimmicks and CPU strength). */
  match: MatchStore;
  graphics: GraphicsSettingsBinding;
  /**
   * The stage the next match runs on (THE FLOATING GARDEN when absent). Its gimmick constraints
   * lock the matching toggles on the title and are explained there before the match starts.
   */
  stage?: () => StageInfo;
}

/** What the preset (or カスタム) means, shown under the picker for touch and pad players too. */
const PRESET_DETAILS: Record<PresetId | "custom", string> = {
  standard: RULE_PRESETS.standard.detail,
  short: RULE_PRESETS.short.detail,
  noGimmicks: RULE_PRESETS.noGimmicks.detail,
  custom: "プリセットから残機・制限時間・ギミックを変えた自分だけのルール",
};

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
  const volume = (key: "bgmVolume" | "seVolume", label: string, hint: string) =>
    `<div class="setting-row"><div class="setting-label"><label for="setting-${key}">${label}</label><output class="setting-value" for="setting-${key}" data-output="${key}"></output></div><input id="setting-${key}" class="setting-range" type="range" min="0" max="100" step="5" data-setting="${key}" aria-describedby="hint-${key}"><p class="setting-hint" id="hint-${key}">${hint}</p></div>`;
  return `
      <dialog class="settings-dialog" aria-labelledby="settings-title">
        <div class="help-head flex items-center justify-between"><div><div class="eyebrow">GRAPHICS · SOUND</div><h2 id="settings-title">設定</h2></div><button class="icon-button" data-action="close-settings" aria-label="グラフィック設定を閉じる">×</button></div>
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
            ${toggle("reducedFlash", "強い光・決着演出を控えめに", "KO と決着の白いフラッシュや光の柱の芯をやめ、色の縁取りと文字だけで伝えます。")}
          </section>
          <section class="settings-section" aria-labelledby="settings-sound">
            <h3 id="settings-sound">SOUND / サウンド</h3>
            ${volume("bgmVolume", "BGM の音量", "0 にしても効果音は鳴ります。")}
            ${volume("seVolume", "効果音の音量", "0 にしても BGM は鳴ります。ため・爆撃・崩落・エリアの警告音は混んだ場面でも埋もれにくく調整しています。")}
            ${toggle("muted", "ミュート (すべての音を消す)", "上部バーの音ボタンと同じ設定です。")}
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
  edit: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5 19 1-4.2L16.6 4.2a1.6 1.6 0 0 1 2.3 0l.9.9a1.6 1.6 0 0 1 0 2.3L9.2 18 5 19Zm9.6-12.8 3.2 3.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  paw: '<svg viewBox="0 0 32 32" fill="currentColor" aria-hidden="true"><ellipse cx="9" cy="8" rx="3" ry="4" transform="rotate(-24 9 8)"/><ellipse cx="23" cy="8" rx="3" ry="4" transform="rotate(24 23 8)"/><ellipse cx="3.8" cy="16" rx="2.8" ry="3.5" transform="rotate(-30 3.8 16)"/><ellipse cx="28.2" cy="16" rx="2.8" ry="3.5" transform="rotate(30 28.2 16)"/><path d="M7 25c0-4 5-12 9-12s9 8 9 12c0 5-5 3-9 3s-9 2-9-3Z"/></svg>',
};

type TitleMode = MatchMode | "ladder";

const modes: Record<TitleMode, { label: string; en: string; detail: string; number: string }> = {
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
  ladder: {
    label: "CPUラダー",
    en: "LADDER",
    detail: "1Pの操作と見た目は「対戦設定」の先頭枠を使います。",
    number: "04",
  },
};

/** Where the title's secondary rules fold into a bottom sheet (mirrors styles.css). */
const RULES_SHEET_MEDIA = "(max-width: 700px) and (orientation: portrait)";
const levelLabels: Record<AiLevel, string> = { easy: "よわい", normal: "ふつう", hard: "つよい" };

const ladderRound = (round: number) => `第${round}戦 / 全${LADDER_ROUNDS.length}戦`;
const ladderOpponentName = (opponent: LadderOpponent) =>
  `${opponent.title} ${CHARACTERS[opponent.loadout.species].name}`;
const ladderOpponentDetails = (opponent: LadderOpponent) =>
  `${levelLabels[opponent.difficulty]} · ${STAGES[opponent.stage].name}`;

function ladderOverviewMarkup(): string {
  return `<section class="ladder-overview" aria-label="CPUラダーのルール" hidden>
    <h2>全${LADDER_ROUNDS.length}戦勝ち抜き</h2>
    <p class="ladder-curve">${LADDER_ROUNDS.map((opponent) => levelLabels[opponent.difficulty]).join(" → ")}</p>
    <p>敗北・引き分け時は同じ相手から再挑戦。<br>各戦は標準ルール（残機${RULE_PRESETS.standard.rules.stocks}）。進行はこの挑戦中のみ。</p>
    <p class="ladder-player" aria-live="polite"></p>
    <div class="ladder-opponent-card">
      <span>${ladderRound(1)}</span>
      <strong>${ladderOpponentName(LADDER_ROUNDS[0])}</strong>
      <span>${ladderOpponentDetails(LADDER_ROUNDS[0])}</span>
    </div>
  </section>`;
}

/** Short button labels; the rules summary under them spells every gimmick out. */
const gimmickShort: Record<GimmickId, string> = {
  collapse: "崩壊",
  safeZone: "ゾーン",
  bombs: "爆撃",
  wind: "風",
};
const fighterCount = (mode: MatchMode) => (mode === "rumble" ? 4 : 2);

/**
 * A slot's shape as an inline SVG, from the same outline the 3D markers use. It says which slot a
 * fighter is without relying on colour, and adds no text to the tag it sits in.
 */
function glyph(slot: number): string {
  const points = SLOT_SHAPE_POINTS[slotShape(slot)]
    .map(([x, y]) => `${x.toFixed(2)},${(-y).toFixed(2)}`)
    .join(" ");
  return `<svg class="slot-glyph" viewBox="-1.3 -1.3 2.6 2.6" aria-hidden="true"><polygon points="${points}"/></svg>`;
}

const accessoryIcon = (paths: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const accessoryIcons: Record<AccessoryId, string> = {
  none: accessoryIcon('<circle cx="12" cy="12" r="7.5"/><path d="m6.7 17.3 10.6-10.6"/>'),
  headband: accessoryIcon(
    '<path d="M3.5 10.4c5.5-2 11-2 16.5 0v3.2c-5.5-2-11-2-16.5 0Zm16.5 1.6 2.2 4.2M20 12l-.5 5.2"/>',
  ),
  crown: accessoryIcon('<path d="M5 17.5h14l1.5-9-4.6 3.7L12 6.3l-3.9 5.9L3.5 8.5Z"/>'),
  goggles: accessoryIcon(
    '<circle cx="7.6" cy="12" r="3.7"/><circle cx="16.4" cy="12" r="3.7"/><path d="M11.3 12h1.4M3.9 12H2m20 0h-1.9"/>',
  ),
  beret: accessoryIcon(
    '<path d="M3.5 14.6c0-4.3 4-7.2 9-7.2 4.6 0 8 2.3 8 5.2 0 2.7-3.6 4.4-8.5 4.4-4.6 0-8.5-.8-8.5-2.4Zm9-7.2.8-2.4"/>',
  ),
  flower: accessoryIcon(
    '<circle cx="12" cy="12" r="2"/><circle cx="12" cy="7.2" r="2.6"/><circle cx="16.6" cy="10.5" r="2.6"/><circle cx="14.8" cy="15.9" r="2.6"/><circle cx="9.2" cy="15.9" r="2.6"/><circle cx="7.4" cy="10.5" r="2.6"/>',
  ),
};

/** On a phone or tablet the keyboard player's slot is played with the touch controls. */
const touchOnly = (): boolean =>
  typeof matchMedia === "function" &&
  matchMedia("(pointer: coarse)").matches &&
  !matchMedia("(any-pointer: fine)").matches;

const deviceLabel = (device: ControlDevice) =>
  device === "keyboard" ? (touchOnly() ? "タッチ" : "キーボード") : `パッド${device.slice(3)}`;

/**
 * One row per fighter slot: its character (a button that opens the look picker), who plays it,
 * and how strong it is when a CPU does. The name, colour and labels follow the slot's loadout.
 */
function playerRowMarkup(id: number): string {
  return `<div class="player-row" data-slot="${id}"><button type="button" class="player-character" data-customize="${id}" title="見た目を変える">${glyph(id)}<span class="player-character-name"></span><span class="player-character-edit">${icons.edit}</span></button><select class="player-device" data-slot-device="${id}"></select><span class="player-badge" hidden></span><select class="player-level" data-slot-level="${id}" data-override="${id}" hidden>${(["auto", ...AI_LEVEL_IDS] as const).map((level) => `<option value="${level}">${level === "auto" ? "おまかせ" : levelLabels[level]}</option>`).join("")}</select><span class="player-still" hidden>動かない</span></div>`;
}

/**
 * The look picker: animal, colours and accessory of one slot, docked beside the arena so the
 * fighter itself is the preview. Every choice shows at once; 決定 keeps them, キャンセル puts
 * back what was there when the picker opened.
 */
function characterDialogMarkup(): string {
  const option = (attribute: string, value: string, content: string, extra = "") =>
    `<button type="button" data-${attribute}="${value}" aria-pressed="false"${extra}>${content}</button>`;
  return `
      <dialog class="character-dialog" aria-labelledby="character-title">
        <div class="help-head flex items-center justify-between"><div><div class="eyebrow">CHARACTER</div><h2 id="character-title">見た目をえらぶ</h2></div><button class="icon-button" data-action="cancel-character" aria-label="変更を取り消して閉じる">×</button></div>
        <div class="character-slots" role="group" aria-label="見た目を変える枠" data-pad-tabs></div>
        <p class="character-summary" aria-live="polite"></p>
        <section class="character-section" aria-labelledby="character-species-title">
          <h3 id="character-species-title">ANIMAL / 動物</h3>
          <div class="character-options character-species" role="group" aria-labelledby="character-species-title">${SPECIES_IDS.map((id) => option("species", id, `<strong>${CHARACTERS[id].name}</strong><small>${CHARACTERS[id].animal}</small>`)).join("")}</div>
        </section>
        <section class="character-section" aria-labelledby="character-palette-title">
          <h3 id="character-palette-title">COLOR / カラー</h3>
          <div class="character-options character-palettes" role="group" aria-labelledby="character-palette-title">${PALETTE_IDS.map((id) => option("palette", id, `<i aria-hidden="true"></i><span>${PALETTES[id].label}</span>`, ` style="--swatch: ${cssColor(PALETTES[id].color)}"`)).join("")}</div>
        </section>
        <section class="character-section" aria-labelledby="character-accessory-title">
          <h3 id="character-accessory-title">ACCESSORY / アクセサリ</h3>
          <div class="character-options character-accessories" role="group" aria-labelledby="character-accessory-title">${ACCESSORY_IDS.map((id) => option("accessory", id, `${accessoryIcons[id]}<span>${ACCESSORIES[id].label}</span>`)).join("")}</div>
        </section>
        <p class="character-note"><strong>見た目だけの変更です。</strong>動物・色・アクセサリで、速さ・攻撃・スタミナ・当たり判定は変わりません。同じ動物や同じ色を何人で選んでもかまいません。</p>
        <p class="character-pad-hint" hidden><span class="pad-key">A</span>えらぶ<span class="hint-dot"></span><span class="pad-key">B</span>キャンセル<span class="hint-dot"></span><kbd>Start</kbd>決定<span class="hint-dot"></span><kbd>LB</kbd><kbd>RB</kbd>枠の切り替え</p>
        <div class="character-foot"><button class="text-button" data-action="revert-character">元に戻す</button><button class="secondary-button" data-action="cancel-character" data-pad-back>キャンセル</button><button class="primary-button" data-action="confirm-character" data-pad-start>決定 ${icons.arrow}</button></div>
      </dialog>`;
}

/** How a gimmick behaves on a stage, as the mark on its chip. */
const gimmickMarks: Record<GimmickState, { mark: string; label: string }> = {
  on: { mark: "○", label: "あり" },
  limited: { mark: "△", label: "制限つき" },
  off: { mark: "×", label: "なし" },
};

/** One chip per gimmick: 崩落 △ … with what it does here as the tooltip and for screen readers. */
function gimmickChipsMarkup(stage: StageDefinition): string {
  return STAGE_GIMMICK_IDS.map((id) => {
    const rule = stage.gimmicks[id];
    const { mark, label } = gimmickMarks[rule.state];
    return `<li class="gimmick-chip" data-state="${rule.state}" title="${STAGE_GIMMICK_LABELS[id]}: ${rule.note}"><span>${STAGE_GIMMICK_LABELS[id]}</span><b aria-hidden="true">${mark}</b><span class="visually-hidden">${label}（${rule.note}）</span></li>`;
  }).join("");
}

/**
 * What a stage is about and what its gimmicks do there. The title screen has it twice and shows
 * one: on the card beside the 3D preview where there is room, else under the stage buttons.
 */
const stageInfoMarkup = (): string =>
  `<p class="stage-summary"></p><ul class="gimmick-chips" aria-label="このステージのギミック"></ul><p class="stage-rules"></p>`;

/** The stage list of the help dialog: name, what it plays like, and its gimmick rules. */
function stageHelpMarkup(): string {
  return STAGE_LIST.map(
    (stage) =>
      `<div class="stage-help-item" data-stage-help="${stage.id}"><dt>${stage.name}<small>${stage.title}</small></dt><dd><p>${stage.summary}</p><p class="stage-help-rules">${stage.gimmickNote}</p></dd></div>`,
  ).join("");
}

function matchOptionsMarkup(): string {
  const segment = (attribute: string, value: string | number, label: string, extra = "") =>
    `<button type="button" data-${attribute}="${value}" aria-pressed="false"${extra}>${label}</button>`;
  return `
          <section class="match-options" aria-labelledby="match-options-title">
            <div class="rules-sheet-backdrop" data-rules-close aria-hidden="true"></div>
            <div class="match-options-head"><h2 id="match-options-title">対戦設定</h2><span class="rule-preset-badge match-rule" role="status" aria-label="現在のルール"></span><span>MATCH RULES</span></div>
            <div class="match-options-body">
              <div class="match-option stage-option">
                <span class="match-option-label" id="match-stage-label">ステージ</span>
                <div class="segmented match-segmented stage-picker" role="group" aria-labelledby="match-stage-label">${STAGE_LIST.map((stage) => segment("stage", stage.id, stage.label, ` aria-label="${stage.name}" aria-describedby="stage-detail" title="${stage.name} / ${stage.title}"`)).join("")}</div>
              </div>
              <div class="stage-detail stage-info" id="stage-detail" aria-live="polite">
                <p class="stage-detail-name"><strong></strong><span></span></p>
                ${stageInfoMarkup()}
              </div>
              <button type="button" class="rules-toggle match-rule" aria-expanded="false" aria-controls="match-rules-panel">
                <span class="rules-toggle-label">ルール・CPU</span>
                <span class="rules-toggle-summary"></span>
                <span class="rules-toggle-chevron" aria-hidden="true">›</span>
              </button>
              <div class="match-rules-panel" id="match-rules-panel" role="group" aria-labelledby="rules-sheet-title">
              <div class="rules-sheet-head">
                <h3 id="rules-sheet-title">ルール詳細</h3>
                <button type="button" class="rules-sheet-done" data-rules-close>完了</button>
              </div>
              <div class="match-option match-set-format" hidden>
                <span class="match-option-label" id="match-set-format-label">対戦形式</span>
                <div class="segmented match-segmented" role="group" aria-labelledby="match-set-format-label">${Object.entries(
                  SET_FORMAT_LABELS,
                )
                  .map(([format, label]) => segment("set-format", format, label))
                  .join("")}</div>
              </div>
              <div class="match-option match-rule">
                <span class="match-option-label" id="match-preset-label">ルール</span>
                <div class="segmented match-segmented" role="group" aria-labelledby="match-preset-label">${PRESET_IDS.map((id) => segment("preset", id, RULE_PRESETS[id].label, ` title="${RULE_PRESETS[id].detail}"`)).join("")}</div>
              </div>
              <div class="match-option match-rule">
                <span class="match-option-label" id="match-stocks-label">残機</span>
                <div class="segmented match-segmented" role="group" aria-labelledby="match-stocks-label">${STOCK_CHOICES.map((n) => segment("stocks", n, String(n), ` aria-label="${n}機"`)).join("")}</div>
              </div>
              <div class="match-option match-rule">
                <span class="match-option-label" id="match-time-label">制限時間</span>
                <div class="segmented match-segmented" role="group" aria-labelledby="match-time-label">${TIME_RULES.map((time) => segment("time", time, "")).join("")}</div>
              </div>
              <div class="match-option match-rule">
                <span class="match-option-label" id="match-gimmicks-label">ギミック</span>
                <div class="segmented match-segmented gimmick-toggles" role="group" aria-labelledby="match-gimmicks-label">${GIMMICK_IDS.map((id) => segment("gimmick", id, gimmickShort[id], ` aria-label="${GIMMICK_LABELS[id]}" title="${GIMMICK_LABELS[id]}：${GIMMICK_DETAILS[id]}"`)).join("")}</div>
              </div>
              <p class="rules-preset-detail match-rule"><strong class="rules-preset-name"></strong><span class="rules-preset-text"></span></p>
              <p class="rules-summary match-rule" aria-live="polite"></p>
              <ul class="rules-notes match-rule" hidden></ul>
              <div class="match-option match-rule">
                <span class="match-option-label" id="match-level-label">CPU の強さ</span>
                <div class="segmented match-segmented" role="group" aria-labelledby="match-level-label">${AI_LEVEL_IDS.map((level) => segment("difficulty", level, levelLabels[level])).join("")}</div>
              </div>
              </div>
              <div class="player-rows"></div>
              <p class="join-hint" aria-live="polite"></p>
              <p class="match-options-note" hidden>稽古は残機が無制限・時間制限なし・ギミックなし。稽古設定で相手の行動・記録再生を変更できます。</p>
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
  ukemi: "UKEMI",
  knockdown: "DOWN",
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

const hex = cssColor;

function resultIdentity(fighter: Fighter, humans: number): string {
  return `<span class="winner-tag" style="--fighter-color: ${hex(fighter.color)}">${glyph(fighter.id)}${fighterTag(fighter, humans)}</span><span class="winner-name">${escapeHtml(fighter.name)}</span>`;
}

function playerResults(fighters: readonly Fighter[], stats: readonly PlayerMatchStats[]): string {
  const humans = countHumans(fighters);
  return fighters
    .map((fighter) => {
      const s = stats[fighter.id];
      const metrics = [
        ["与ダメージ", formatDamage(s.damageDealt)],
        ["被ダメージ", formatDamage(s.damageTaken)],
        ["撃墜", s.kos],
        ["失った残機", s.stocksLost],
        ["相手による失点", s.opponentLosses],
        ["自滅・環境など", s.environmentLosses],
        ["剣の命中率", formatAccuracy(s)],
        ["回避成功", s.dodges],
      ];
      return `<article class="result-player">
        <h3>${resultIdentity(fighter, humans)}</h3>
        <dl>${metrics.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join("")}</dl>
      </article>`;
    })
    .join("");
}

const cssHex = (color: number): string => `#${(color & 0xffffff).toString(16).padStart(6, "0")}`;

/** Replays an element's CSS animation from the start. */
function restartAnimation(element: HTMLElement): void {
  element.classList.remove("play");
  void element.offsetWidth;
  element.classList.add("play");
}

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
  dangerLabel: HTMLElement;
  zoneCompass: HTMLElement;
  airRising: HTMLElement;
  airThrust: HTMLElement;
  airStep: HTMLElement;
  level: HTMLElement;
  life: HTMLElement;
  invulnerable: HTMLElement;
  lock: HTMLElement;
  /** What the life display last drew, so it is rebuilt only when it changes. */
  lifeKey: string;
  /** The lock chips the card shows (their markup), so they are redrawn only when they change. */
  lockKey: string;
  /** Who the card was drawn for (tag and look); a change rebuilds it. */
  identity: string;
}

/** A player of the running match, for the lock-on chips. */
interface PlayerMark {
  number: number;
  color: string;
  /** The fighter's slot: its shape goes on the chip, beside the player number. */
  slot: number;
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
  private readonly characterDialog: HTMLDialogElement;
  /** The slot whose look is being chosen, and every slot's look as it was when the picker opened. */
  private customizing: { slot: number; before: Loadout[] } | null = null;
  /** The title's tag of each slot of the selected mode (YOU, P1…, CPU 0n). */
  private slotTags: string[] = [];
  private readonly fpsCounter: HTMLElement;
  private readonly graphics: GraphicsSettingsBinding;
  private readonly match: MatchStore;
  private playerRowsMode: MatchMode | null = null;
  private connectedPads: number[] = [];
  private locks: PlayerLock[] = [];
  /** The running match's players by fighter id: player number, colour and slot shape. */
  private players = new Map<number, PlayerMark>();
  private keyboardFighter: number | null = null;
  private readonly cards = new Map<number, FighterCard>();
  private currentPhase: Phase = "menu";
  private selectedMode: TitleMode = "duel";
  /** Real time (ms) until which a just-finished game shows its finish before the result. */
  private finishHoldUntil = 0;
  private resumeAfterHelp = false;
  private resumeAfterSettings = false;
  private rulesSheetOpen = false;
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
          <button class="icon-button" data-action="sound" aria-label="音をオフにする" aria-pressed="true" title="サウンド (BGM・効果音)">${icons.sound}</button>
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
          ${ladderOverviewMarkup()}
          <div class="menu-cta">
            <button class="start-button flex items-center justify-between" data-action="start"><span><b class="start-label">アリーナへ</b><span class="start-en">ENTER THE ARENA</span></span>${icons.arrow}</button>
            <button type="button" class="tutorial-entry" data-tutor="catalog">はじめての方へ · 実戦チュートリアル</button>
            <div class="menu-links"><button class="menu-controls-link" data-action="help">操作方法を見る <span>↗</span></button><button class="menu-controls-link" data-action="settings">グラフィック設定 <span>↗</span></button></div>
          </div>
          <div class="menu-features flex items-center"><span>重い一撃</span><i></i><span>自由なフェイント</span><i></i><span>一瞬の読み合い</span></div>
        </div>
        <aside class="arena-caption stage-info" aria-label="選択中のステージ" aria-live="polite">
          <div class="caption-head"><span class="caption-cross">+</span><div class="caption-text"><span class="caption-title">THE FLOATING GARDEN</span><small class="caption-name">浮遊庭園 / 終わりゆく足場</small></div><span class="caption-line"></span></div>
          ${stageInfoMarkup()}
        </aside>
        <div class="menu-bottom"><span>01 / BRAMBLE</span><span>NO SHIELD. FIND YOUR OPENING.</span><span>v0.1</span></div>
      </main>

      <section class="game-hud" aria-label="対戦情報" hidden>
        <div class="match-heading"><span class="match-mode">DUEL</span><span class="heading-separator"></span><time class="match-time">00:00</time><span class="heading-separator"></span><span class="match-alive">2 ALIVE</span><span class="match-set-score" hidden></span></div>
        <div class="arena-status" aria-live="polite"><div class="ladder-hud" hidden></div><span class="arena-status-message"></span></div>
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

      <div class="finish-layer" aria-hidden="true"><div class="screen-flash"></div><div class="finish-stamp" hidden><strong></strong><span></span></div></div>

      <section class="pause-screen modal-scrim" role="dialog" aria-modal="true" aria-label="一時停止" hidden>
        <div class="modal-panel pause-panel">
          <div class="eyebrow">TAKE A BREATH</div>
          <h2>ひと休み。</h2>
          <p class="pause-description">次の一撃を、じっくり考えよう。</p>
          <p class="pause-notice" role="status" hidden></p>
          <button class="primary-button" data-action="resume">対戦に戻る ${icons.arrow}</button>
          <button class="secondary-button" data-action="restart">はじめから</button>
          <button type="button" class="secondary-button tutorial-pause-link" data-tutor="catalog">課題を選ぶ</button>
          <button class="secondary-button" data-action="settings">グラフィック設定</button>
          <button class="text-button" data-action="menu">タイトルへ戻る</button>
          <p class="pause-exit-note" hidden>タイトルに戻ると、勝利数を加算せずにこのセットを終了します。</p>
        </div>
      </section>

      <section class="result-screen modal-scrim" role="dialog" aria-modal="true" aria-label="対戦結果" hidden>
        <div class="modal-panel result-panel">
          <div class="result-paw">${icons.paw}</div>
          <div class="eyebrow result-eyebrow">MATCH RESULT</div>
          <h2 class="result-title">試合結果</h2>
          <p class="result-winner" hidden></p>
          <p class="result-score" hidden></p>
          <p class="result-subtitle" hidden></p>
          <div class="ladder-opponent-card ladder-next" hidden><span></span><strong></strong><span></span></div>
          <dl class="ladder-totals" hidden>
            <div><dt>勝利</dt><dd data-ladder-stat="wins"></dd></div>
            <div><dt>敗北</dt><dd data-ladder-stat="losses"></dd></div>
            <div><dt>引き分け</dt><dd data-ladder-stat="draws"></dd></div>
            <div><dt>再挑戦</dt><dd data-ladder-stat="retries"></dd></div>
            <div><dt>合計試合時間</dt><dd data-ladder-stat="elapsed"></dd></div>
          </dl>
          <div class="result-actions">
            <button class="primary-button" data-action="restart" data-pad-primary><span class="result-primary-label">もう一度、勝負</span> ${icons.arrow}</button>
            <button class="secondary-button" data-action="match-settings" aria-describedby="result-exit-note" hidden>対戦設定へ戻る</button>
            <button class="text-button" data-action="menu">タイトルへ戻る</button>
          </div>
          <p class="result-exit-note" id="result-exit-note" hidden>対戦設定やタイトルに戻ると、このセットは終了します。</p>
          <div class="result-stats"><div><strong data-stat="hits">0</strong><span>HITS</span></div><div><strong data-stat="clashes">0</strong><span>CLASHES</span></div><div><strong data-stat="time">0:00</strong><span>TIME</span></div></div>
          <div class="result-stat-picker segmented" role="group" aria-label="戦績の集計範囲" hidden>
            <button type="button" data-result-stats="game" aria-controls="result-game" aria-pressed="true">この試合</button>
            <button type="button" data-result-stats="set" aria-controls="result-set" aria-pressed="false">セット累計</button>
          </div>
          <div class="result-player-grid" id="result-game" role="group" aria-label="この試合の戦績"></div>
          <div class="result-player-grid" id="result-set" role="group" aria-label="セット累計の戦績" hidden></div>
          <details class="result-stat-note">
            <summary>戦績の数え方</summary>
            <p>命中率は、当たった剣技の回数を攻撃判定が出た回数で割った値です。複数人に当てても1回で、相殺だけなら命中には入りません。投げはダメージと撃墜に含まれます。</p>
            <p>撃墜は、相手の攻撃や投げを受けてから${KO_CREDIT_SECONDS}秒以内の場外落下に付きます。爆弾やエリア外ゲージによる失点、撃墜者を一人に絞れない失点は「自滅・環境など」に含まれます。</p>
            <p>回避成功は、ステップ中の無敵時間に剣技や爆風が当たる位置にいた場合に、技や爆発ごとに1回数えます。</p>
          </details>
        </div>
      </section>

      <dialog class="help-dialog" aria-labelledby="help-title">
        <div class="help-head flex items-center justify-between"><div><div class="eyebrow">FIELD GUIDE</div><h2 id="help-title">剣の振り方。</h2></div><button class="icon-button" data-action="close-help" aria-label="操作方法を閉じる">×</button></div>
        <div class="help-body">
          <p class="help-intro">%が高いほど、遠くへ吹っ飛ぶ。落ちても残機があれば安全地帯の中へ戻り、点滅しているあいだは少しだけ無敵。相手の残機を削りきり、最後まで生き残ろう。</p>
          <div class="help-columns">
            <section><h3>MOVE / 移動と回避</h3><dl class="key-list"><div><dt><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></dt><dd>移動 / 吹っ飛び方向の微調整</dd></div><div><dt><kbd>Tab</kbd> ロックオン　<kbd>E</kbd> / ホイール 相手切替</dt><dd>ロックオン中は相手に向き続ける。Tab で解除するとマウス・矢印キー・右スティックで自由に向ける</dd></div><div><dt><kbd>Space</kbd></dt><dd>ジャンプ（空中ジャンプなし）</dd></div><div><dt><kbd>Shift</kbd> + 移動</dt><dd>向きを変えずにステップ / 空中でも1回</dd></div><div><dt>受け身</dt><dd>吹き飛ばされて硬直中、着地まで約0.17秒の間に Shift・パッドの B・タッチの「回避」を押す。方向入力で転がり、ニュートラルならその場で立て直す。成功は UKEMI、失敗は DOWN。READY で再行動できる。</dd></div><div><dt><kbd>V</kbd> / <kbd>Esc</kbd></dt><dd>視点の自動追随の切り替え / 一時停止</dd></div></dl></section>
            <section><h3>ATTACK / 大剣の4つの技</h3><dl class="key-list"><div><dt><kbd>J</kbd> 振り下ろし</dt><dd>重い一撃 / 空中ではメテオ</dd></div><div><dt><kbd>I</kbd> 振り上げ</dt><dd>斜め上へ上昇 / 復帰にも</dd></div><div><dt><kbd>K</kbd> 横振り</dt><dd>広い横幅 / 横ステップを狩る</dd></div><div><dt><kbd>L</kbd> 突き</dt><dd>前へ踏み込む / 空中の横復帰</dd></div><div><dt><kbd>U</kbd> つかむ</dt><dd>近距離でつかみ、移動方向に投げる</dd></div></dl></section>
          </div>
          <div class="help-callout"><span class="callout-icon">${icons.sword}</span><div><strong>長押しでためる。<kbd>Q</kbd> でフェイント。</strong><p>ため中はキャンセルやステップに移れる。振りかぶり中は向きをゆっくり直せて、Qで止めることもできるが、スタミナは戻らず、遅く止めるほど隙が残る。斬りかかった剣は向きが固まり、最後まで振り抜く。</p></div></div>
          <section class="stage-help" aria-labelledby="stage-help-title">
            <h3 id="stage-help-title">STAGES / ステージ</h3>
            <p class="stage-help-lead">一騎打ち・乱闘・稽古のステージは、タイトルの「対戦設定」で選べます。</p>
            <dl class="stage-help-list">${stageHelpMarkup()}</dl>
          </section>
          <div class="help-tips"><div><span>01</span><p><strong>剣と剣がぶつかると相殺。</strong>被弾時は移動入力で吹っ飛び方向を少し調整できる。</p></div><div><span>02</span><p><strong>復帰は上昇・突き・空中回避で。</strong>空中で各1回。着地すれば再び使える。</p></div><div><span>03</span><p><strong>実線が安全地帯、破線が次の円。</strong>選手カードの矢印で円の方向を確認。外では%とゲージが増加し、5秒で退場。内側でゲージが回復する。</p></div><div><span>04</span><p><strong>赤い予告は爆撃、縁の点滅は崩壊。</strong>足場とスタミナを残して攻めよう。</p></div></div>
          <p class="controller-note">マウス左クリックは振り下ろし、右クリックは横振り。中ボタンでロックオンの切り替え。</p>
          <section class="rules-help" aria-labelledby="rules-help-title">
            <h3 id="rules-help-title">RULES / 対戦ルール</h3>
            <p>タイトルの「対戦設定」でルールを選べます。一騎打ちと乱闘は同じルールで戦い、稽古は常に残機無制限・ギミックなしです。</p>
            <dl class="key-list">
              <div><dt>${RULE_PRESETS.standard.label}</dt><dd>${RULE_PRESETS.standard.detail}。制限時間は残機に応じて伸びる</dd></div>
              <div><dt>${RULE_PRESETS.short.label}</dt><dd>${RULE_PRESETS.short.detail}</dd></div>
              <div><dt>${RULE_PRESETS.noGimmicks.label}</dt><dd>${RULE_PRESETS.noGimmicks.detail}</dd></div>
              <div><dt>${PRESET_LABELS.custom}</dt><dd>残機・制限時間・ギミックをプリセットから変えると表示。実際に使われるルールは設定欄の下にいつも表示される</dd></div>
            </dl>
            <p><strong>ギミックは1つずつ切り替えられる。</strong>${GIMMICK_IDS.map((id) => `${GIMMICK_LABELS[id]}（${GIMMICK_DETAILS[id]}）`).join("、")}。オフにしたギミックは表示も効果もなくなる。</p>
            <p><strong>残機と制限時間。</strong>残機を削りきるか場外へ落とせば決着。時間切れになったら残機の多い選手、同数なら蓄積ダメージの少ない選手が勝つ。標準の制限時間は ${formatClock(timeLimitFor(1))}＋残機1つごとに ${formatClock(timeLimitFor(2) - timeLimitFor(1))}、短めは残機に関係なく ${formatClock(timeLimitFor(1, "short"))}。</p>
          </section>
          <section class="character-help" aria-labelledby="character-help-title">
            <h3 id="character-help-title">CHARACTER / キャラクターと見た目</h3>
            <p>タイトルの「対戦設定」で、各枠の名前のボタン（パッドは <kbd>Y</kbd>）を押すと、動物（コハク・シロ・モカ・スミ）、カラー、アクセサリを選べます。人間の枠も CPU の枠も同じように選べ、同じ動物・同じ色を何人で選んでもかまいません。選ぶたびに浮島のキャラクターがその姿に変わり、「決定」（パッドは <kbd>Start</kbd>）で確定、「キャンセル」（<kbd>Esc</kbd> / パッドは <kbd>B</kbd>）で開く前の姿に戻せます。選んだ姿は再戦でも次回の起動でも覚えています。</p>
            <p><strong>見た目による性能差はありません。</strong>どの動物・色・アクセサリでも、移動、攻撃の速さと威力、吹っ飛び方、スタミナ、当たり判定はまったく同じです。操作する端末や CPU の強さも見た目とは別々に決められます。</p>
            <p>同じ姿どうしでも、頭上と HUD のタグ（<kbd>YOU</kbd> / <kbd>P1</kbd>〜<kbd>P4</kbd> / <kbd>CPU</kbd>）と、枠ごとに決まった形（${[0, 1, 2, 3].map((slot) => `<span class="help-shape">${glyph(slot)}${SLOT_SHAPE_LABELS[slotShape(slot)]}</span>`).join("")}）で見分けられます。形は頭上のタグ、足もとの輪、HUD のカード、ロックオン表示で共通です。</p>
          </section>
          <section class="pad-help" aria-labelledby="pad-help-title">
            <h3 id="pad-help-title">GAMEPAD / パッド</h3>
            <p class="pad-help-lead">パッドは4台まで使えます。キーボードとマウス（タッチ）はひとり分。一騎打ち・乱闘・稽古のタイトル設定では、パッドの <kbd>A</kbd> か <kbd>Start</kbd> を押すと参加、<kbd>B</kbd> で抜けます。</p>
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
      ${characterDialogMarkup()}
      <div class="fps-counter" aria-hidden="true" hidden>-- FPS</div>
    `;
    this.menu = this.query(".menu-screen");
    this.hud = this.query(".game-hud");
    this.result = this.query(".result-screen");
    this.pausePanel = this.query(".pause-screen");
    this.dialog = this.query<HTMLDialogElement>(".help-dialog");
    this.settingsDialog = this.query<HTMLDialogElement>(".settings-dialog");
    this.characterDialog = this.query<HTMLDialogElement>(".character-dialog");
    this.fpsCounter = this.query(".fps-counter");
    host.addEventListener("click", this.handleClick, { signal: this.abort.signal });
    // Esc on the look picker is "back": it puts the looks back as they were. A click beside it
    // does nothing, since the fighter being dressed is out there.
    for (const [dialog, close, dismissible] of [
      [this.dialog, () => this.closeHelp(), true],
      [this.settingsDialog, () => this.closeSettings(), true],
      [this.characterDialog, () => this.closeCharacter(false), false],
    ] as const) {
      dialog.addEventListener("keydown", (event) => event.stopPropagation(), {
        signal: this.abort.signal,
      });
      dialog.addEventListener("cancel", close, { signal: this.abort.signal });
      dialog.addEventListener(
        "click",
        (event) => {
          if (!dismissible || event.target !== dialog) return;
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
    // Volume sliders apply while they are dragged, not only when released.
    this.settingsDialog.addEventListener(
      "input",
      (event) => {
        if ((event.target as HTMLInputElement).type === "range") this.handleSettingChange(event);
      },
      { signal: this.abort.signal },
    );
    const unsubscribe = this.graphics.store.subscribe(() => this.syncSettings());
    this.abort.signal.addEventListener("abort", unsubscribe);
    window.addEventListener(
      "resize",
      () => {
        this.refreshRenderSize();
        // The rules sheet only exists on a portrait phone; elsewhere the rows sit in the panel.
        if (this.rulesOpen() && !this.rulesSheetAvailable()) this.setRulesOpen(false);
      },
      { signal: this.abort.signal },
    );
    // Esc closes the phone rules sheet before anything else hears it (pause, pad menus).
    window.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape" || !this.rulesOpen()) return;
        event.preventDefault();
        event.stopPropagation();
        this.setRulesOpen(false, true);
      },
      { capture: true, signal: this.abort.signal },
    );
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
    const mode = this.selectedMode;
    const block = this.query(".match-options");
    const inLadder = mode === "ladder";
    block.hidden = inLadder;
    this.query(".ladder-overview").hidden = !inLadder;
    this.menu.classList.toggle("ladder-menu", inLadder);
    setText(this.query(".start-label"), inLadder ? "CPUラダーを始める" : "アリーナへ");
    setText(this.query(".start-en"), inLadder ? "START LADDER" : "ENTER THE ARENA");
    const connected = (pad: number) => this.connectedPads.includes(pad);
    if (inLadder) {
      const first = ladderMatchOptions(options, LADDER_ROUNDS[0]);
      const { options: playable, substitutes } = playableOptions(first, 2, connected);
      const look = first.loadouts[0];
      const device = deviceLabel(playable.controls[0] ?? "keyboard");
      const fallback = substitutes[0] ? `（${deviceLabel(substitutes[0].device)}が未接続）` : "";
      const character = CHARACTERS[look.species].name;
      const multiplayerNote =
        Object.keys(options.controls).length > 1
          ? "。操作とキャラクターは「対戦設定」の先頭枠を使用します。通常モードに戻ると、保存済みの複数人設定をそのまま使えます。"
          : "";
      setText(
        this.query(".ladder-player"),
        `1P専用 · ${character}（${PALETTES[look.palette].label} / ${ACCESSORIES[look.accessory].label}） · ${device}${fallback}${multiplayerNote}`,
      );
      this.syncStage(STAGES[first.stage], false);
      this.callbacks.onPreview("duel", first);
      return;
    }
    const training = mode === "training";
    const count = fighterCount(mode);
    block.classList.toggle("practice", training);
    block.classList.toggle("four-players", count > 2);
    for (const rule of block.querySelectorAll<HTMLElement>(".match-rule")) rule.hidden = training;
    this.query(".match-set-format").hidden = mode !== "duel";
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
    pressed("[data-set-format]", (b) => b.dataset.setFormat === options.setFormat);
    pressed("[data-difficulty]", (b) => b.dataset.difficulty === options.difficulty);
    pressed("button[data-stage]", (b) => b.dataset.stage === options.stage);
    this.syncStage(STAGES[options.stage], training);
    // The preset is derived from the rules, so the badge can never contradict them.
    const preset = presetOf(options);
    pressed("[data-preset]", (b) => b.dataset.preset === preset);
    pressed("[data-time]", (b) => b.dataset.time === options.time);
    const rules = effectiveRules(options, mode, this.stage());
    // Toggles show what the match will run with; a gimmick the stage fixes can't be switched.
    pressed("[data-gimmick]", (b) => rules.gimmicks[b.dataset.gimmick as GimmickId]);
    for (const button of block.querySelectorAll<HTMLButtonElement>("[data-gimmick]")) {
      const id = button.dataset.gimmick as GimmickId;
      const constraint = rules.locked[id];
      button.disabled = Boolean(constraint);
      button.classList.toggle("locked", Boolean(constraint));
      const label = constraint
        ? `${GIMMICK_LABELS[id]}（${constraint.forced ? "常にあり" : "なし"}：${constraint.reason}）`
        : GIMMICK_LABELS[id];
      if (button.getAttribute("aria-label") !== label) button.setAttribute("aria-label", label);
    }
    for (const button of block.querySelectorAll<HTMLElement>("[data-time]")) {
      const time = button.dataset.time as TimeRule;
      const clock = formatClock(timeLimitFor(options.stocks, time));
      setText(button, time === "short" ? `短め ${clock}` : `標準 ${clock}`);
      button.setAttribute(
        "aria-label",
        time === "short" ? `短め、${clock}で決着` : `標準、残機${options.stocks}で${clock}`,
      );
    }
    const badge = this.query(".rule-preset-badge");
    badge.classList.toggle("custom", preset === "custom");
    setText(badge, PRESET_LABELS[preset]);
    setText(this.query(".rules-preset-name"), `${PRESET_LABELS[preset]}：`);
    setText(this.query(".rules-preset-text"), PRESET_DETAILS[preset]);
    setText(this.query(".rules-summary"), describeRules(rules));
    // Every gimmick the stage fixes is explained, also when the saved choice already matches.
    const notes = this.query(".rules-notes");
    const changed = new Set(rules.notes.map((note) => note.gimmick));
    const lockedIds = GIMMICK_IDS.filter((id) => rules.locked[id]);
    const notesMarkup = lockedIds
      .map((id) => {
        const constraint = rules.locked[id]!;
        const overridden = changed.has(id) ? "（選んだ設定は使われません）" : "";
        return `<li>${GIMMICK_LABELS[id]}: ${constraint.forced ? "常にあり" : "なし"}（${escapeHtml(constraint.reason)}）${overridden}</li>`;
      })
      .join("");
    if (notes.innerHTML !== notesMarkup) notes.innerHTML = notesMarkup;
    notes.hidden = training || lockedIds.length === 0;
    // The phone's one-line digest of the rules behind the sheet.
    const toggle = this.query(".rules-toggle");
    const digest = [
      mode === "duel" && options.setFormat !== "single" ? options.setFormat.toUpperCase() : null,
      PRESET_LABELS[preset],
      `残機${options.stocks}`,
      formatClock(timeLimitFor(options.stocks, options.time)),
      levelLabels[options.difficulty],
    ]
      .filter(Boolean)
      .join(" · ");
    setText(this.query(".rules-toggle-summary"), digest);
    toggle.classList.toggle("has-notes", rules.notes.length > 0);

    const { options: playable, substitutes } = playableOptions(options, count, connected);
    const players = humanSlots(playable, count);
    const nameOf = (id: number) => CHARACTERS[options.loadouts[id]!.species].name;
    this.slotTags = Array.from({ length: count }, (_, id) => {
      const player = players.findIndex((slot) => slot.id === id) + 1;
      return fighterTag({ id, human: player > 0, player: player || null }, players.length);
    });
    for (let id = 0; id < count; id++) {
      const row = rows.querySelector<HTMLElement>(`[data-slot="${id}"]`)!;
      const stored = options.controls[id] ?? null;
      const device = row.querySelector<HTMLSelectElement>(".player-device")!;
      // The slot's character: its name and colour, and labels that still tell two rows with the
      // same character apart.
      const loadout = options.loadouts[id]!;
      const who = `${id + 1}番の枠（${nameOf(id)}）`;
      row.style.setProperty("--slot-color", cssColor(PALETTES[loadout.palette].color));
      setText(row.querySelector<HTMLElement>(".player-character-name")!, nameOf(id));
      const labels: [string, string][] = [
        [
          ".player-character",
          `${who}の見た目を変える。いまは${CHARACTERS[loadout.species].animal}、${PALETTES[loadout.palette].label}、アクセサリ${ACCESSORIES[loadout.accessory].label}`,
        ],
        [".player-device", `${who}の操作`],
        [".player-level", `${who}の強さ`],
      ];
      for (const [selector, label] of labels) {
        const element = row.querySelector<HTMLElement>(selector)!;
        if (element.getAttribute("aria-label") !== label) element.setAttribute("aria-label", label);
      }
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
    hint.classList.toggle("pads-connected", this.connectedPads.length > 0);
    const markup = lost
      ? lost.by === "keyboard"
        ? `${deviceLabel(lost.device)}が未接続のため、${nameOf(lost.slot)}は${deviceLabel("keyboard")}で操作します`
        : `未接続のパッドの枠は CPU が戦います`
      : `<span class="pad-key">A</span>パッドのボタンを押して参加<span class="hint-dot"></span><span class="pad-key">B</span>抜ける<span class="hint-dot"></span><span class="hint-pair"><span class="pad-key">Y</span>見た目</span>`;
    if (hint.innerHTML !== markup) hint.innerHTML = markup;
    this.syncCharacter();
    this.callbacks.onPreview(mode, options);
  }

  /** Reflects the slot being dressed, and its stored look, in the look picker. */
  private syncCharacter(): void {
    const look = this.customizing;
    if (!look) return;
    const dialog = this.characterDialog;
    const options = this.match.get();
    const loadout = options.loadouts[look.slot]!;
    const character = CHARACTERS[loadout.species];
    const palette = PALETTES[loadout.palette];
    dialog.style.setProperty("--slot-color", cssColor(palette.color));
    // One tab per slot of the mode: shape, tag and current name. Rebuilt only when one changes.
    const tabs = dialog.querySelector<HTMLElement>(".character-slots")!;
    const markup = this.slotTags
      .map((tag, id) => {
        const other = options.loadouts[id]!;
        return `<button type="button" data-customize-slot="${id}" aria-pressed="false" style="--slot-color: ${cssColor(PALETTES[other.palette].color)}">${glyph(id)}<span>${tag}</span><small>${CHARACTERS[other.species].name}</small></button>`;
      })
      .join("");
    if (tabs.dataset.markup !== markup) {
      tabs.dataset.markup = markup;
      tabs.innerHTML = markup;
    }
    const press = (selector: string, attribute: string, value: string, primary = false) => {
      for (const button of dialog.querySelectorAll<HTMLElement>(selector)) {
        const on = button.dataset[attribute] === value;
        button.setAttribute("aria-pressed", String(on));
        if (primary) button.toggleAttribute("data-pad-primary", on);
      }
    };
    press("[data-customize-slot]", "customizeSlot", String(look.slot));
    press("[data-species]", "species", loadout.species, true);
    press("[data-palette]", "palette", loadout.palette);
    press("[data-accessory]", "accessory", loadout.accessory);
    setText(
      dialog.querySelector<HTMLElement>(".character-summary")!,
      `${this.slotTags[look.slot] ?? ""} ・ ${character.name}（${character.animal}） ・ ${palette.label} ・ ${ACCESSORIES[loadout.accessory].label}`,
    );
    const changed = options.loadouts.some((now, id) => !sameLoadout(now, look.before[id]!));
    dialog.querySelector<HTMLButtonElement>('[data-action="revert-character"]')!.disabled =
      !changed;
    dialog.querySelector<HTMLElement>(".character-pad-hint")!.hidden =
      this.connectedPads.length === 0;
  }

  /** Opens the look picker on `slot` of the selected mode (title screen only). */
  private openCharacter(slot: number): void {
    if (this.currentPhase !== "menu" || this.host.querySelector("dialog[open]")) return;
    if (this.selectedMode === "ladder") return;
    if (!Number.isInteger(slot) || slot < 0 || slot >= fighterCount(this.selectedMode)) return;
    this.previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.customizing = { slot, before: this.match.get().loadouts };
    this.syncCharacter();
    this.host.dataset.characterOpen = "";
    this.characterDialog.showModal();
    this.characterDialog.querySelector<HTMLElement>("[data-pad-primary]")?.focus();
    this.callbacks.onSpotlight(slot);
  }

  /** Another slot's tab: the choices made so far stay; cancelling still undoes them all. */
  private selectCharacterSlot(slot: number): void {
    if (this.selectedMode === "ladder") return;
    if (!this.customizing || slot < 0 || slot >= fighterCount(this.selectedMode)) return;
    this.customizing.slot = slot;
    this.syncCharacter();
    this.callbacks.onSpotlight(slot);
  }

  /** Closes the look picker; unless `keep`, every slot goes back to how it looked when it opened. */
  private closeCharacter(keep: boolean): void {
    const look = this.customizing;
    if (!look) return;
    this.customizing = null;
    if (!keep) this.match.set({ loadouts: look.before });
    if (this.characterDialog.open) this.characterDialog.close();
    delete this.host.dataset.characterOpen;
    this.callbacks.onSpotlight(null);
    this.previousFocus?.focus();
  }

  /**
   * The chosen stage in words, before the match starts: its name, what fighting there is about,
   * and what each gimmick does there. The caption beside the 3D preview names it too.
   */
  private syncStage(stage: StageDefinition, training: boolean): void {
    // Training has no timed gimmicks; a belt is part of the floor and keeps running there.
    const belts = stage.gimmicks.conveyor.state !== "off";
    const rules = training
      ? belts
        ? "稽古では崩落・安全地帯・爆撃・風は起きません。コンベアだけは動き続けます。"
        : "稽古では崩落・安全地帯・爆撃・風は起きません。"
      : stage.gimmickNote;
    const changed = this.host.dataset.stage !== stage.id;
    this.host.dataset.stage = stage.id;
    if (changed) {
      setText(this.query(".stage-detail-name strong"), stage.name);
      setText(this.query(".stage-detail-name span"), stage.title);
      setText(this.query(".caption-title"), stage.title);
      setText(this.query(".caption-name"), `${stage.name} / ${stage.tagline}`);
    }
    for (const info of this.host.querySelectorAll<HTMLElement>(".stage-info")) {
      if (changed) {
        setText(info.querySelector<HTMLElement>(".stage-summary")!, stage.summary);
        info.querySelector<HTMLElement>(".gimmick-chips")!.innerHTML = gimmickChipsMarkup(stage);
      }
      info.classList.toggle("practice", training);
      setText(info.querySelector<HTMLElement>(".stage-rules")!, rules);
    }
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
    if (this.host.querySelector("dialog[open]")) return false;
    if (this.selectedMode === "ladder") return false;
    if (
      button === "a" &&
      document.activeElement?.matches("button[data-mode='ladder'], .tutorial-entry")
    )
      return false;
    const count = fighterCount(this.selectedMode);
    if (button === "y") {
      // Y opens the look picker on the slot that pad plays (the first slot before it has joined).
      const controls = this.match.get().controls;
      let slot = 0;
      for (let id = 0; id < count; id++) if (controls[id] === `pad${index + 1}`) slot = id;
      this.openCharacter(slot);
      return true;
    }
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
  setPadNotice(text: string | null, blockResume = false): void {
    const notice = this.query(".pause-notice");
    notice.hidden = !text;
    setText(notice, text ?? "");
    const resume = this.query('.pause-screen [data-action="resume"]');
    if (blockResume) resume.setAttribute("aria-disabled", "true");
    else resume.removeAttribute("aria-disabled");
  }

  /** The title rows' selects: who plays a slot, and a CPU's strength. */
  private handleMatchChange = (event: Event): void => {
    if (this.selectedMode === "ladder") return;
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
        : control instanceof HTMLInputElement && control.type === "range"
          ? Number(control.value) / 100
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
    for (const key of ["bgmVolume", "seVolume"] as const) {
      const percent = Math.round(s[key] * 100);
      const range = dialog.querySelector<HTMLInputElement>(`input[data-setting="${key}"]`)!;
      if (document.activeElement !== range) range.value = String(percent);
      range.disabled = s.muted;
      setText(dialog.querySelector<HTMLElement>(`[data-output="${key}"]`)!, `${percent}%`);
    }
    if (s.reducedFlash) this.host.dataset.reducedFlash = "";
    else delete this.host.dataset.reducedFlash;
    const sound = this.query('[data-action="sound"]');
    if (sound.getAttribute("aria-pressed") !== String(!s.muted)) {
      sound.innerHTML = s.muted ? icons.mute : icons.sound;
      sound.setAttribute("aria-pressed", String(!s.muted));
      sound.setAttribute("aria-label", s.muted ? "音をオンにする" : "音をオフにする");
    }
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
    for (const [id, card] of this.cards) {
      const chips = this.locks
        .filter((lock) => lock.on && lock.targetId === id)
        .map((lock) => {
          const player = this.players.get(lock.fighterId);
          if (!several || !player) return '<span class="fighter-lock">LOCK</span>';
          // Number and slot shape: two players in the same colour still have their own chip.
          return `<span class="fighter-lock player-lock" style="--lock-color: ${player.color}">${glyph(player.slot)}P${player.number} LOCK</span>`;
        })
        .join("");
      // Each card remembers the chips it shows. A card drawn anew for a changed look starts
      // without any, and a player's new colour is a different chip: both are drawn again even
      // when every lock-on is what it was in the match before.
      if (card.lockKey === chips) continue;
      card.lockKey = chips;
      card.lock.hidden = chips === "";
      card.lock.innerHTML = chips;
    }
    // The keyboard legend follows the keyboard player's lock (or the only player's).
    const legendLock =
      this.locks.find((lock) => lock.fighterId === this.keyboardFighter) ??
      (this.locks.length === 1 ? this.locks[0] : undefined);
    this.hud.classList.toggle("lock-off", legendLock ? !legendLock.on : false);
  }

  /** The stage the next match runs on. */
  private stage(): StageInfo {
    return this.callbacks.stage?.() ?? stageInfoFor(this.match.get().stage);
  }

  /** Whether the phone rules sheet is open. */
  private rulesOpen(): boolean {
    return this.rulesSheetOpen;
  }

  /** The rules sheet exists on portrait phones (styles.css), in the modes that have rules. */
  private rulesSheetAvailable(): boolean {
    return (
      this.selectedMode !== "training" &&
      this.selectedMode !== "ladder" &&
      (window.matchMedia?.(RULES_SHEET_MEDIA).matches ?? false)
    );
  }

  /**
   * Opens or closes the phone rules sheet. Opening moves focus into it; closing with
   * `returnFocus` hands it back to the toggle.
   */
  private setRulesOpen(open: boolean, returnFocus = false): void {
    if (this.rulesSheetOpen === open) return;
    this.rulesSheetOpen = open;
    const block = this.query(".match-options");
    const toggle = this.query(".rules-toggle");
    block.classList.toggle("rules-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    if (open) this.query("#match-rules-panel [data-rules-close]").focus({ preventScroll: true });
    else if (returnFocus) toggle.focus({ preventScroll: true });
  }

  private query<T extends HTMLElement = HTMLElement>(selector: string): T {
    const element = this.host.querySelector<T>(selector);
    if (!element) throw new Error(`Missing UI element: ${selector}`);
    return element;
  }

  private handleClick = (event: MouseEvent): void => {
    const clicked = event.target as Element;
    if (clicked.closest(".rules-toggle")) {
      this.setRulesOpen(!this.rulesOpen(), true);
      return;
    }
    if (clicked.closest("[data-rules-close]")) {
      this.setRulesOpen(false, true);
      return;
    }
    // Buttons only: the host itself carries data-mode and data-stage (the running match's state).
    const target = (event.target as Element).closest<HTMLElement>(
      "[data-action], button[data-mode], button[data-stage], [data-shadow], [data-stocks], [data-set-format], [data-result-stats], [data-difficulty], [data-preset], [data-time], [data-gimmick], [data-customize], [data-customize-slot], [data-species], [data-palette], [data-accessory]",
    );
    if (!target) return;
    if (target.dataset.customize !== undefined) {
      this.openCharacter(Number(target.dataset.customize));
      return;
    }
    if (target.dataset.customizeSlot !== undefined) {
      this.selectCharacterSlot(Number(target.dataset.customizeSlot));
      return;
    }
    // A choice in the look picker changes that slot's look and nothing else; the fighter in the
    // arena follows at once.
    const look = this.customizing;
    const choice: Partial<Loadout> | null = target.dataset.species
      ? { species: target.dataset.species as Species }
      : target.dataset.palette
        ? { palette: target.dataset.palette as PaletteId }
        : target.dataset.accessory
          ? { accessory: target.dataset.accessory as AccessoryId }
          : null;
    if (choice) {
      if (look) this.match.setLoadout(look.slot, choice);
      return;
    }
    const shadow = target.dataset.shadow as ShadowLevel | undefined;
    if (shadow) {
      this.graphics.store.set({ shadows: shadow });
      return;
    }
    if (target.dataset.stocks) {
      this.match.set({ stocks: Number(target.dataset.stocks) });
      return;
    }
    if (target.dataset.setFormat && this.selectedMode === "duel") {
      this.match.set({ setFormat: target.dataset.setFormat as SetFormat });
      return;
    }
    if (target.dataset.resultStats) {
      this.showResultStats(target.dataset.resultStats === "set");
      return;
    }
    if (target.dataset.difficulty) {
      this.match.set({ difficulty: target.dataset.difficulty as AiLevel });
      return;
    }
    if (target.dataset.preset) {
      this.match.preset(target.dataset.preset as PresetId);
      return;
    }
    if (target.dataset.time) {
      this.match.set({ time: target.dataset.time as TimeRule });
      return;
    }
    if (target.dataset.gimmick) {
      // A gimmick the stage fixes is locked: the choice would have no effect.
      if ((target as HTMLButtonElement).disabled || target.classList.contains("locked")) return;
      this.match.toggleGimmick(target.dataset.gimmick as GimmickId);
      return;
    }
    if (target.dataset.stage) {
      this.match.set({ stage: target.dataset.stage as StageId });
      return;
    }
    const mode = target.dataset.mode as TitleMode | undefined;
    if (mode) {
      this.setRulesOpen(false);
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
        this.setRulesOpen(false);
        if (this.selectedMode === "ladder") this.callbacks.onStartLadder(this.match.get());
        else this.callbacks.onStart(this.selectedMode, this.match.get());
        break;
      case "ladder-continue":
        this.callbacks.onLadderContinue();
        break;
      case "camera":
        this.graphics.store.set({ cameraFollow: !this.graphics.store.get().cameraFollow });
        break;
      case "pause":
        this.callbacks.onPause();
        break;
      case "resume":
        if (target.getAttribute("aria-disabled") !== "true") this.callbacks.onResume();
        break;
      case "restart":
        this.callbacks.onRestart();
        break;
      case "next-game":
        this.callbacks.onNextGame();
        break;
      case "match-settings":
        this.callbacks.onMenu();
        // On a portrait phone the set format lives in the rules sheet: open it first.
        if (this.rulesSheetAvailable()) this.setRulesOpen(true);
        this.query(".match-set-format [aria-pressed='true']").focus();
        break;
      case "menu":
        this.callbacks.onMenu();
        this.query(".menu-screen [data-action='start']").focus({ preventScroll: true });
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
      case "confirm-character":
        this.closeCharacter(true);
        break;
      case "cancel-character":
        this.closeCharacter(false);
        break;
      case "revert-character":
        if (look) this.match.set({ loadouts: look.before });
        break;
      case "sound": {
        // The same stored switch as "ミュート" in the settings; syncSettings redraws the button.
        const enabled = this.graphics.store.get().muted;
        this.callbacks.onSound(enabled);
        this.graphics.store.set({ muted: !enabled });
        break;
      }
    }
  };

  private openHelp(): void {
    if (this.host.querySelector("dialog[open]")) return;
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
    if (this.host.querySelector("dialog[open]")) return;
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
    return fighterTag(fighter, this.players.size);
  }

  /** What a card was drawn for: whose it is and what that fighter looks like. */
  private cardIdentity(fighter: Fighter): string {
    return `${this.identity(fighter)}/${fighter.species}/${fighter.palette}/${fighter.accessory}`;
  }

  private createCard(fighter: Fighter): FighterCard {
    const card = document.createElement("article");
    const tag = this.identity(fighter);
    card.className = `fighter-card ${fighter.human ? "player-card" : "opponent-card"}`;
    card.dataset.fighter = String(fighter.id);
    card.style.setProperty("--fighter-color", hex(fighter.color));
    card.setAttribute(
      "aria-label",
      `${tag === "YOU" ? "あなた" : tag}（${fighter.name}、${SLOT_SHAPE_LABELS[slotShape(fighter.id)]}の印）の状態`,
    );
    // The slot's shape leads the tag: the same shape floats over the fighter and sits on its ring.
    card.innerHTML = `
      <div class="fighter-card-top"><span class="fighter-tags"><span class="fighter-tag">${glyph(fighter.id)}${tag}</span><span class="fighter-level"></span></span><span class="fighter-status">READY</span></div>
      <span class="fighter-invulnerable" hidden>無敵</span><span class="fighter-locks" hidden></span>
      <div class="fighter-main"><span class="fighter-avatar species-${fighter.species}">${icons.paw}</span><div class="fighter-ident"><span class="fighter-name">${escapeHtml(fighter.name)}</span><span class="fighter-species">${fighter.species.toUpperCase()}</span><span class="fighter-life" role="img"></span></div><strong class="fighter-damage"><span>0</span><small>%</small></strong></div>
      <div class="stamina-label"><span>STAMINA</span><span class="stamina-value">100</span></div><div class="stamina-track" role="meter" aria-label="スタミナ" aria-valuemin="0" aria-valuemax="100"><span></span></div>
      <div class="fighter-foot"><div class="air-tokens"><span class="air-rising" title="空中振り上げの使用権">↗</span><span class="air-thrust" title="空中突きの使用権">→</span><span class="air-step" title="空中回避の使用権">»</span><small>RECOVERY</small></div></div>
      <div class="zone-compass" hidden></div>
      <div class="outside-warning" hidden><div><span>エリア外</span><strong>0.0 / ${RULES.outsideLimit}s</strong></div><div class="outside-track"><span></span></div></div>
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
      zoneCompass: q(".zone-compass"),
      dangerLabel: q(".outside-warning div:first-child span"),
      dangerValue: q(".outside-warning strong"),
      airRising: q(".air-rising"),
      airThrust: q(".air-thrust"),
      airStep: q(".air-step"),
      level: q(".fighter-level"),
      life: q(".fighter-life"),
      invulnerable: q(".fighter-invulnerable"),
      lock: q(".fighter-locks"),
      lifeKey: "",
      lockKey: "",
      identity: this.cardIdentity(fighter),
    };
  }

  private syncLadderResult(ladder: LadderProgress, roundLabel: string, message: string): void {
    const clear = ladder.phase === "clear";
    this.result.classList.toggle("ladder-clear", clear);
    this.query(".result-winner").hidden = true;
    this.query(".result-score").hidden = true;
    this.query(".result-screen [data-action='match-settings']").hidden = true;
    this.query(".result-exit-note").hidden = true;
    this.query(".result-stats").hidden = true;
    this.query(".result-stat-picker").hidden = true;
    this.query("#result-game").hidden = true;
    this.query("#result-set").hidden = true;
    this.query(".result-stat-note").hidden = true;
    setText(this.query(".result-eyebrow"), clear ? "LADDER CLEAR" : "CPU LADDER");
    setText(
      this.query(".result-title"),
      clear
        ? "ラダークリア"
        : ladder.outcome === "win"
          ? "あなたの勝ち。"
          : ladder.outcome === "draw"
            ? "引き分け。"
            : "敗北。",
    );
    const summary = clear ? `全${LADDER_ROUNDS.length}戦クリア · ${roundLabel}` : roundLabel;
    const retryNote = ladder.outcome === "draw" ? "この戦を同じ相手と再戦します。" : "";
    const subtitle = this.query(".result-subtitle");
    subtitle.hidden = false;
    setText(subtitle, [summary, message, retryNote].filter(Boolean).join(" · "));
    const next = this.query(".ladder-next");
    next.hidden = !ladder.nextOpponent;
    if (ladder.nextOpponent) {
      setText(next.children[0] as HTMLElement, `次の相手 · ${ladderRound(ladder.round + 1)}`);
      setText(next.children[1] as HTMLElement, ladderOpponentName(ladder.nextOpponent));
      setText(next.children[2] as HTMLElement, ladderOpponentDetails(ladder.nextOpponent));
    }
    this.query(".ladder-totals").hidden = !clear;
    if (clear) {
      const { totals } = ladder;
      for (const key of ["wins", "losses", "draws", "retries"] as const)
        setText(this.query(`[data-ladder-stat="${key}"]`), String(totals[key]));
      setText(this.query('[data-ladder-stat="elapsed"]'), formatClock(totals.elapsed));
    }
    this.query(".result-screen [data-pad-primary]").dataset.action = "ladder-continue";
    setText(
      this.query(".result-primary-label"),
      clear ? "もう一度ラダーに挑戦" : ladder.nextOpponent ? "次の相手へ" : "同じ相手に再挑戦",
    );
    setText(
      this.query(".result-screen [data-action='menu']"),
      clear ? "タイトルへ戻る" : "ラダーを終了",
    );
    this.query(".result-panel").scrollTop = 0;
  }

  /**
   * This frame's KO and finish moments: an edge flash in the fighter's colour for a lost life, a
   * stamp (GAME / DRAW / SET / CLEAR!) and a short hold before the result for the finish. The
   * flash turns into a soft coloured frame with "reduced flash"; the stamp always shows, so the
   * moment reads with effects, shake and sound all off.
   */
  present(events: readonly PresentationEvent[], state: GameState): void {
    for (const event of events) {
      if (event.kind === "stockKo" || event.kind === "elimination") {
        this.flash(event.kind === "elimination" ? "out" : "ko", event.color);
      } else if (event.kind === "finish") {
        this.flash("finish", event.color);
        const winner = state.fighters.find((f) => f.id === event.winnerId);
        const name = winner ? fighterTitle(winner, state.fighters) : "";
        const [title, line, hold] =
          event.finish === "ladderClear"
            ? ["CLEAR!", "CPUラダー制覇", 1800]
            : event.finish === "setWin"
              ? ["SET", `${name} セット勝利`, 1500]
              : event.finish === "draw"
                ? ["DRAW", event.byKo ? "相打ち" : "タイムアップ", 1100]
                : [event.byKo ? "GAME" : "TIME", `${name} WINS`, 1100];
        const stamp = this.query(".finish-stamp");
        stamp.dataset.finish = event.finish;
        stamp.style.setProperty("--finish-color", cssHex(event.color));
        setText(stamp.querySelector("strong")!, title);
        setText(stamp.querySelector("span")!, line);
        stamp.hidden = false;
        restartAnimation(stamp);
        this.finishHoldUntil = performance.now() + hold;
      }
    }
  }

  private flash(kind: "ko" | "out" | "finish", color: number): void {
    const flash = this.query(".screen-flash");
    flash.dataset.flash = kind;
    flash.style.setProperty("--flash-color", cssHex(color));
    restartAnimation(flash);
  }

  private clearFinish(): void {
    this.finishHoldUntil = 0;
    this.query(".finish-stamp").hidden = true;
    delete this.query(".screen-flash").dataset.flash;
  }

  update(state: GameState, ladder?: LadderProgress): void {
    const changedPhase = this.currentPhase !== state.phase;
    this.currentPhase = state.phase;
    // The look picker belongs to the title: a match that starts keeps what was chosen so far.
    if (state.phase !== "menu" && this.customizing) this.closeCharacter(true);
    this.host.dataset.phase = state.phase;
    this.host.dataset.mode = state.mode;
    const inMatch = state.phase !== "menu";
    if (inMatch && this.rulesOpen()) this.setRulesOpen(false);
    this.menu.hidden = inMatch;
    this.hud.hidden = !inMatch;
    this.pausePanel.hidden = state.phase !== "paused";
    if (changedPhase && state.phase !== "ended") this.clearFinish();
    // A finish keeps the arena in view for a moment (the stamp, the highlight) before the result.
    // While a tutorial lesson owns the session, its own dialog handles results and focus.
    const tutorial = this.host.dataset.tutorial !== undefined;
    const showResult =
      !tutorial && state.phase === "ended" && performance.now() >= this.finishHoldUntil;
    const revealed = showResult && this.result.hidden;
    this.result.hidden = !showResult;
    if (!tutorial && isClimax(state)) this.host.dataset.climax = "";
    else delete this.host.dataset.climax;
    this.query(".pause-button").hidden = !["playing", "countdown"].includes(state.phase);
    const ladderLabel = ladder
      ? `${ladderRound(ladder.round)} · ${ladderOpponentName(ladder.opponent)} · ${ladderOpponentDetails(ladder.opponent)}`
      : "";
    const ladderHud = this.query(".ladder-hud");
    ladderHud.hidden = !ladder;
    setText(ladderHud, ladderLabel);
    if (state.phase === "paused") {
      setText(this.query(".pause-description"), ladderLabel || "次の一撃を、じっくり考えよう。");
      const restart = this.query(".pause-screen [data-action='restart']");
      restart.hidden = Boolean(ladder);
      setText(
        restart,
        this.host.hasAttribute("data-tutorial")
          ? "この課題をやり直す"
          : state.mode === "training"
            ? "稽古をリセット"
            : state.set
              ? "セットを最初から"
              : "はじめから",
      );
      setText(
        this.query(".pause-screen [data-action='menu']"),
        ladder ? "ラダーを終了" : "タイトルへ戻る",
      );
      this.query(".pause-exit-note").hidden = !state.set;
    }
    if (changedPhase && state.phase === "ended" && !tutorial) {
      this.result.setAttribute("aria-label", ladder ? "CPUラダーの結果" : "対戦結果");
      if (ladder) this.syncLadderResult(ladder, ladderLabel, state.message);
      else this.drawResult(state);
    }
    if (!this.dialog.open && !this.settingsDialog.open) {
      if (changedPhase && state.phase === "paused")
        this.pausePanel.querySelector<HTMLButtonElement>('[data-action="resume"]')?.focus();
      if (revealed) this.query(".result-screen [data-pad-primary]").focus({ preventScroll: true });
    }

    const clock = (seconds: number) =>
      `${Math.floor(seconds / 60)
        .toString()
        .padStart(2, "0")}:${Math.floor(seconds % 60)
        .toString()
        .padStart(2, "0")}`;
    const time = clock(state.elapsed);
    const limit = state.rules.timeLimit;
    // The clock shows the time limit beside it, so a short match never ends by surprise.
    setText(this.query(".match-time"), limit === null ? time : `${time} / ${clock(limit)}`);
    const set = state.set;
    setText(
      this.query(".match-mode"),
      set
        ? `${set.format.toUpperCase()} · 第${set.gameNumber}試合`
        : ladder
          ? modes.ladder.en
          : modes[state.mode].en,
    );
    const setScore = this.query(".match-set-score");
    setScore.hidden = !set;
    if (set) setText(setScore, this.setScore(state.fighters, set.wins));
    // Training respawns everyone for ever; elsewhere a fighter is in the match while it has lives.
    const training = state.mode === "training";
    const alive = this.query(".match-alive");
    alive.hidden = Boolean(set);
    alive.textContent = `${
      state.fighters.filter((fighter) => (training ? fighter.mode !== "dead" : fighter.stocks > 0))
        .length
    } ALIVE`;

    const arenaStatus = this.query(".arena-status");
    const arenaStatusMessage = this.query(".arena-status-message");
    const nextCollapse = Math.max(0, Math.ceil(state.arena.nextCollapse - state.elapsed));
    arenaStatus.classList.toggle("warning", state.arena.warningRing);
    if (state.mode === "training")
      setText(
        arenaStatusMessage,
        // A belt is part of the floor: it runs in practice too.
        STAGES[state.arena.stageId].gimmicks.conveyor.state === "off"
          ? "PRACTICE FIELD  ·  ギミックなし"
          : "PRACTICE FIELD  ·  コンベアだけ動く",
      );
    else if (state.arena.warningRing || state.arena.safeZone.active) {
      setText(
        arenaStatusMessage,
        [
          state.arena.warningRing ? `外周崩壊まで ${nextCollapse}秒` : "",
          zoneStatus(state.arena.safeZone),
        ]
          .filter(Boolean)
          .join("　/　"),
      );
    } else if (ladder) setText(arenaStatusMessage, "");
    else if (GIMMICK_IDS.every((id) => !state.rules.gimmicks[id])) {
      const stage = STAGES[state.arena.stageId];
      setText(
        arenaStatusMessage,
        stage.gimmicks.conveyor.state === "off"
          ? `${stage.title}  ·  ギミックなし`
          : `${stage.title}  ·  コンベアだけ動く`,
      );
    } else setText(arenaStatusMessage, STAGES[state.arena.stageId].title);

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
        .map((fighter) => [
          fighter.id,
          { number: fighter.player ?? 1, color: hex(fighter.color), slot: fighter.id },
        ]),
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
      if (!ids.has(id) || !fighter || card.identity !== this.cardIdentity(fighter)) {
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
      card.status.classList.toggle(
        "landing-status",
        ["idle", "ukemi", "knockdown"].includes(fighter.mode),
      );
      card.status.classList.toggle("ukemi", fighter.mode === "ukemi");
      card.status.classList.toggle("knockdown", fighter.mode === "knockdown");
      setText(card.status, out ? "OUT" : respawning ? "復帰中" : statusLabels[fighter.mode]);
      card.stamina.style.transform = `scaleX(${Math.max(0, Math.min(1, fighter.stamina / RULES.maxStamina))})`;
      card.stamina.parentElement!.setAttribute(
        "aria-valuenow",
        String(Math.round(fighter.stamina)),
      );
      card.staminaValue.textContent = String(Math.ceil(fighter.stamina));
      card.element.classList.toggle("low-stamina", fighter.stamina < 25);
      const zone = state.arena.safeZone;
      card.zoneCompass.hidden = !zone.active || !fighter.human || fighter.mode === "dead";
      if (!card.zoneCompass.hidden) setText(card.zoneCompass, zoneDirections(zone, fighter));
      const zoneKO = fighter.mode === "dead" && fighter.eliminationReason === ZONE_KO_REASON;
      card.danger.hidden =
        !zone.active || fighter.outsideTime <= 0 || (fighter.mode === "dead" && !zoneKO);
      if (!card.danger.hidden)
        setText(
          card.dangerLabel,
          zoneKO
            ? "エリア外退場"
            : Math.hypot(fighter.x - zone.x, fighter.z - zone.z) > zone.radius
              ? "エリア外"
              : "ゲージ回復中",
        );
      card.dangerFill.style.transform = `scaleX(${Math.min(1, fighter.outsideTime / RULES.outsideLimit)})`;
      card.dangerValue.textContent = `${(Math.floor((fighter.outsideTime + 1e-9) * 10) / 10).toFixed(1)} / ${RULES.outsideLimit}s`;
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
  }

  private setScore(fighters: readonly Fighter[], wins: readonly [number, number]): string {
    const humans = countHumans(fighters);
    return fighters.map((f) => `${fighterTag(f, humans)} ${wins[f.id]}勝`).join(" – ");
  }

  private showResultStats(totals: boolean): void {
    this.query("#result-game").hidden = totals;
    this.query("#result-set").hidden = !totals;
    for (const button of this.result.querySelectorAll<HTMLButtonElement>(
      "button[data-result-stats]",
    ))
      button.setAttribute(
        "aria-pressed",
        String((button.dataset.resultStats === "set") === totals),
      );
  }

  private drawResult(state: GameState): void {
    this.result.classList.remove("ladder-clear");
    this.query(".ladder-next").hidden = true;
    this.query(".ladder-totals").hidden = true;
    this.query(".result-stats").hidden = false;
    this.query(".result-stat-note").hidden = false;
    setText(this.query(".result-screen [data-action='menu']"), "タイトルへ戻る");
    const set = state.set;
    const complete = set?.phase === "complete";
    const between = set?.phase === "betweenGames";
    setText(
      this.query(".result-eyebrow"),
      complete ? "SET WINNER" : between ? "SET GAME" : "MATCH RESULT",
    );
    const winnerId = complete ? set.winnerId : state.winnerId;
    const winner = state.fighters.find((f) => f.id === winnerId);
    const badge = this.query(".result-winner");
    badge.hidden = !winner;
    badge.innerHTML = winner ? resultIdentity(winner, countHumans(state.fighters)) : "";

    const game = set ? `第${set.gameNumber}試合` : "試合";
    setText(
      this.query(".result-title"),
      complete
        ? `${set.format.toUpperCase()} セットの勝者`
        : winner
          ? `${game}の勝者`
          : set
            ? `${game}は引き分け`
            : "引き分け",
    );
    const score = this.query(".result-score");
    score.hidden = !set;
    if (set)
      setText(
        score,
        `${complete ? "最終スコア" : SET_FORMAT_LABELS[set.format]} · ${this.setScore(state.fighters, set.wins)}`,
      );

    const subtitle = this.query(".result-subtitle");
    const details: string[] = [];
    if (winner) {
      if (complete) details.push(`${game}も勝利`);
      if (state.options.stocks > 1) details.push(`残機 ${winner.stocks}`);
      if (countHumans(state.fighters) === 1 && !winner.human) {
        const reason = state.fighters.find((f) => f.human)?.eliminationReason;
        if (reason) details.push(reason);
      }
    } else {
      details.push(
        state.drawReason === "timeUp"
          ? "時間切れ時に首位の残機と蓄積ダメージが同点"
          : "最後に残っていた選手が同時に脱落",
      );
      if (between) details.push("再戦 — 必要勝利数は変わりません");
    }
    subtitle.hidden = details.length === 0;
    setText(subtitle, details.join("。"));

    const primary = this.query<HTMLButtonElement>(".result-screen [data-pad-primary]");
    primary.dataset.action = between ? "next-game" : "restart";
    setText(
      primary.querySelector("span")!,
      between ? "次の試合" : complete ? "同じ条件で新しいセット" : "もう一度、勝負",
    );
    this.query(".result-screen [data-action='match-settings']").hidden = !between;
    this.query(".result-exit-note").hidden = !between;

    this.query(".result-stat-picker").hidden = !set;
    this.query("#result-game").innerHTML = playerResults(state.fighters, state.playerStats);
    this.query("#result-set").innerHTML = set ? playerResults(state.fighters, set.totals) : "";
    this.showResultStats(complete);
    this.query<HTMLDetailsElement>(".result-stat-note").open = false;
    this.query(".result-panel").scrollTop = 0;
    setText(this.query('[data-stat="hits"]'), String(state.stats.hits));
    setText(this.query('[data-stat="clashes"]'), String(state.stats.clashes));
    setText(this.query('[data-stat="time"]'), formatClock(state.elapsed));
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
    this.characterDialog.close();
    this.host.replaceChildren();
  }
}
