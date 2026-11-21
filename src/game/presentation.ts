// What the match *means* for the music, the sound effects and the finish visuals: a pure read of
// the game state, frame by frame. Nothing here feeds back into the simulation, so the winner, the
// clock and every rule stay exactly as the engine decides them. Importable in node (tests).

import { RULES } from "./tuning";
import type { Fighter, GameState } from "./types";

/** The music loop a state asks for. `silent` plays nothing. */
export type MusicScene = "silent" | "menu" | "practice" | "battle" | "climax" | "result";
/** How the result loop feels: it follows who took the game. */
export type ResultMood = "victory" | "defeat" | "draw";

export interface MusicCue {
  scene: MusicScene;
  /** Only for `result`; null otherwise. */
  mood: ResultMood | null;
  /** The match is paused (or a dialog paused it): the loop keeps its place, muffled. */
  paused: boolean;
}

/** The very end of a game, from the loudest to the plainest. */
export type FinishKind = "ladderClear" | "setWin" | "win" | "defeat" | "draw";

interface At {
  x: number;
  y: number;
  z: number;
  /** The fighter's colour (KO) or the winner's (finish); a neutral tint for a draw. */
  color: number;
}

export type PresentationEvent =
  /** A life lost, the fighter comes back: never the end of anything. */
  | ({ kind: "stockKo"; fighterId: number; stocksLeft: number } & At)
  /** Out for good while the others fight on (four-player matches). */
  | ({ kind: "elimination"; fighterId: number; remaining: number } & At)
  /** Practice falls: no lives, no climax, no finish. */
  | ({ kind: "trainingKo"; fighterId: number } & At)
  /** The game is decided. `byKo` is false for a time-up. */
  | ({ kind: "finish"; finish: FinishKind; winnerId: number | null; byKo: boolean } & At)
  /** The match has entered its decisive stretch (latched until it ends). */
  | { kind: "climax"; reason: ClimaxReason }
  /** New bomb circles were marked on the floor. */
  | { kind: "bombWarning"; count: number }
  /** The outer ring is about to fall. */
  | { kind: "collapseWarning" }
  /** The safe zone appeared, or announced its next move. */
  | { kind: "zoneWarning"; first: boolean }
  /** A human is outside the zone; `urgency` 0..1 grows with the outside gauge. */
  | { kind: "zoneDanger"; fighterId: number; urgency: number };

export type ClimaxReason = "zone" | "clock" | "finalStock";

export interface PresentationContext {
  /** The CPU ladder has just been cleared with this game. */
  ladderClear?: boolean;
  /** Interactive tutorial: uses calm practice music and suppresses match climax/finish banners. */
  tutorial?: boolean;
}

/** Seconds left on the clock at which a match counts as late: a fifth of it, at most 30 s. */
export function lateClockSeconds(timeLimit: number): number {
  return Math.min(30, timeLimit * 0.2);
}

/** Lives left that keep a fighter in the match (alive, or down with a life to come back on). */
const contenders = (state: GameState): Fighter[] => state.fighters.filter((f) => f.stocks > 0);

/**
 * Why the match is in its decisive stretch, or null. Only duels and rumbles that are being played
 * (or paused mid-play) can be; never the title, the countdown, practice or a finished game.
 *
 * - `zone`: the moving safe zone has reached its late phase (`safeZone.phase === "late"`).
 * - `clock`: the time limit is in its last fifth (at most the last 30 s).
 * - `finalStock`: at most two fighters remain and every one of them is on the last life, which
 *   is only news when the match did not start that way (more lives, or more fighters).
 *
 * Each condition can only switch on as the match goes on (lives never come back, the clock and
 * the zone only advance), so the climax never flickers.
 */
export function climaxReason(state: GameState): ClimaxReason | null {
  if (state.mode === "training") return null;
  const live =
    state.phase === "playing" || (state.phase === "paused" && state.pausedFrom === "playing");
  if (!live) return null;
  if (state.arena.safeZone.active && state.arena.safeZone.phase === "late") return "zone";
  const limit = state.rules.timeLimit;
  if (limit !== null && limit - state.elapsed <= lateClockSeconds(limit)) return "clock";
  const left = contenders(state);
  const startStocks = state.rules.stocks ?? state.options.stocks;
  if (
    left.length === 2 &&
    left.every((f) => f.stocks === 1) &&
    (startStocks > 1 || state.fighters.length > left.length)
  )
    return "finalStock";
  return null;
}

export const isClimax = (state: GameState): boolean => climaxReason(state) !== null;

/** Whether this game ended in a loss for every human playing (a CPU took it). */
function humansLost(state: GameState): boolean {
  if (state.winnerId === null) return false;
  const winner = state.fighters.find((f) => f.id === state.winnerId);
  return !!winner && !winner.human && state.fighters.some((f) => f.human);
}

/** The kind of finish a just-ended game deserves. Never asked for practice (it never ends). */
export function finishKind(state: GameState, context: PresentationContext = {}): FinishKind {
  if (state.winnerId === null) return "draw";
  if (context.ladderClear && state.winnerId === 0) return "ladderClear";
  if (state.set?.phase === "complete" && state.set.winnerId === state.winnerId) return "setWin";
  return humansLost(state) ? "defeat" : "win";
}

export function resultMood(state: GameState): ResultMood {
  if (state.winnerId === null) return "draw";
  return humansLost(state) ? "defeat" : "victory";
}

/** The music a state asks for. Pure: the same state always asks for the same cue. */
export function musicCue(state: GameState, tutorial = false): MusicCue {
  const paused = state.phase === "paused";
  switch (state.phase) {
    case "menu":
      return { scene: "menu", mood: null, paused: false };
    case "ended":
      return state.mode === "training" || tutorial
        ? { scene: "practice", mood: null, paused: false }
        : { scene: "result", mood: resultMood(state), paused: false };
    default:
      if (state.mode === "training" || tutorial) return { scene: "practice", mood: null, paused };
      return { scene: isClimax(state) ? "climax" : "battle", mood: null, paused };
  }
}

export const sameMusic = (a: MusicCue, b: MusicCue): boolean =>
  a.scene === b.scene && a.mood === b.mood;

const NEUTRAL = 0xfff3b8;

interface FighterMemory {
  dead: boolean;
  stocks: number;
  outsideStep: number;
}

/**
 * Turns frame-by-frame states into one-shot presentation events. A new match (a new state or
 * fighter list, or a clock that went back) resets the memory without emitting anything, so a
 * rematch, the next game of a set or a return to the title never replays an old KO or finish.
 */
export class PresentationTracker {
  private state: GameState | null = null;
  private fighters: Fighter[] | null = null;
  private elapsed = 0;
  private phase: GameState["phase"] = "menu";
  private climax = false;
  private warningRing = false;
  private zoneActive = false;
  private zoneMotion: GameState["arena"]["safeZone"]["motion"] = "hold";
  private readonly bombs = new Set<number>();
  private readonly memory = new Map<number, FighterMemory>();

  /** Whether the current match has (latched) entered its climax. */
  get inClimax(): boolean {
    return this.climax;
  }

  update(state: GameState, context: PresentationContext = {}): PresentationEvent[] {
    const fresh =
      state !== this.state || state.fighters !== this.fighters || state.elapsed < this.elapsed;
    if (fresh) {
      this.reset(state);
      return [];
    }
    const events: PresentationEvent[] = [];
    const training = state.mode === "training";
    const practice = training || Boolean(context.tutorial);
    const ended = this.phase !== "ended" && state.phase === "ended" && !practice;
    const falls: Fighter[] = [];
    for (const f of state.fighters) {
      const before = this.memory.get(f.id);
      const dead = f.mode === "dead";
      if (before && ((dead && !before.dead) || f.stocks < before.stocks)) falls.push(f);
      const outsideStep = Math.floor(f.outsideTime);
      if (
        before &&
        !training &&
        f.human &&
        !dead &&
        state.phase === "playing" &&
        f.outsideTime > 0 &&
        (before.outsideStep < 0 || outsideStep > before.outsideStep)
      )
        events.push({
          kind: "zoneDanger",
          fighterId: f.id,
          urgency: Math.min(1, f.outsideTime / RULES.outsideLimit),
        });
      this.memory.set(f.id, {
        dead,
        stocks: f.stocks,
        outsideStep: f.outsideTime > 0 ? outsideStep : -1,
      });
    }
    if (ended) {
      // The last fall of the game, if a fall decided it; else the winner stands where it is.
      const finalFall = falls.at(-1);
      const winner = state.fighters.find((f) => f.id === state.winnerId);
      const spot = finalFall ?? winner;
      events.push({
        kind: "finish",
        finish: finishKind(state, context),
        winnerId: state.winnerId,
        byKo: !!finalFall,
        x: spot?.x ?? 0,
        y: spot?.y ?? 0,
        z: spot?.z ?? 0,
        color: winner?.color ?? NEUTRAL,
      });
    } else {
      const remaining = state.fighters.filter((f) => f.stocks > 0).length;
      for (const f of falls) {
        const at = { fighterId: f.id, x: f.x, y: f.y, z: f.z, color: f.color };
        if (training) events.push({ kind: "trainingKo", ...at });
        else if (f.stocks > 0) events.push({ kind: "stockKo", stocksLeft: f.stocks, ...at });
        else events.push({ kind: "elimination", remaining, ...at });
      }
    }
    const reason = practice ? null : climaxReason(state);
    if (!this.climax && reason && !ended) {
      this.climax = true;
      events.push({ kind: "climax", reason });
    }
    if (!training && state.phase === "playing") this.arenaEvents(state, events);
    this.remember(state);
    return events;
  }

  private arenaEvents(state: GameState, events: PresentationEvent[]): void {
    const { arena } = state;
    let marked = 0;
    for (const bomb of state.bombs) {
      if (this.bombs.has(bomb.id)) continue;
      this.bombs.add(bomb.id);
      if (!bomb.exploded) marked++;
    }
    if (marked) events.push({ kind: "bombWarning", count: marked });
    if (arena.warningRing && !this.warningRing) events.push({ kind: "collapseWarning" });
    const zone = arena.safeZone;
    if (zone.active && !this.zoneActive) events.push({ kind: "zoneWarning", first: true });
    else if (zone.active && zone.motion === "warning" && this.zoneMotion !== "warning")
      events.push({ kind: "zoneWarning", first: false });
  }

  private remember(state: GameState): void {
    this.state = state;
    this.fighters = state.fighters;
    this.elapsed = state.elapsed;
    this.phase = state.phase;
    this.warningRing = state.arena.warningRing;
    this.zoneActive = state.arena.safeZone.active;
    this.zoneMotion = state.arena.safeZone.motion;
    if (this.bombs.size > 64) {
      const live = new Set(state.bombs.map((b) => b.id));
      for (const id of this.bombs) if (!live.has(id)) this.bombs.delete(id);
    }
  }

  private reset(state: GameState): void {
    this.memory.clear();
    this.bombs.clear();
    for (const f of state.fighters)
      this.memory.set(f.id, {
        dead: f.mode === "dead",
        stocks: f.stocks,
        outsideStep: f.outsideTime > 0 ? Math.floor(f.outsideTime) : -1,
      });
    for (const bomb of state.bombs) this.bombs.add(bomb.id);
    // A state first seen already late (a reload, tooling) is not a fresh climax to announce.
    this.climax = isClimax(state);
    this.remember(state);
  }
}
