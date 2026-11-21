import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  BgmPlayer,
  BgmSequencer,
  FADE_OUT,
  LOOKAHEAD,
  midiOf,
  PATTERNS,
  patternFor,
  sceneGap,
  stepNotes,
  stepSeconds,
  STEPS_PER_BAR,
  type BgmNote,
  type SceneKey,
  type SequencerOutput,
} from "../src/game/bgm";
import type { MusicCue } from "../src/game/presentation";
import { FakeAudioContext } from "./fakeAudio";

const key = (scene: SceneKey["scene"], mood: SceneKey["mood"] = null): SceneKey => ({
  scene,
  mood,
});
const FRAME = 1 / 60;

/** Runs the sequencer frame by frame, collecting everything it produced. */
function run(
  sequencer: BgmSequencer,
  target: SceneKey | ((t: number) => SceneKey),
  from: number,
  to: number,
): SequencerOutput {
  const all: SequencerOutput = { notes: [], starts: [], stops: [] };
  for (let t = from; t < to; t += FRAME) {
    const out = sequencer.advance(typeof target === "function" ? target(t) : target, t);
    all.notes.push(...out.notes);
    all.starts.push(...out.starts);
    all.stops.push(...out.stops);
  }
  return all;
}

describe("patterns", () => {
  test("note names", () => {
    expect(midiOf("A4")).toBe(69);
    expect(midiOf("C4")).toBe(60);
    expect(midiOf("Bb2")).toBe(46);
    expect(midiOf("F#3")).toBe(54);
  });

  test("every loop parses and plays notes on every bar", () => {
    for (const [name, pattern] of Object.entries(PATTERNS)) {
      for (const lane of [pattern.bass, pattern.pluck, pattern.kick, pattern.snare, pattern.hat])
        expect(lane, name).toHaveLength(STEPS_PER_BAR);
      const bars = pattern.chords.length;
      for (let bar = 0; bar < bars; bar++) {
        const notes: BgmNote[] = [];
        for (let s = 0; s < STEPS_PER_BAR; s++)
          notes.push(...stepNotes(pattern, bar * STEPS_PER_BAR + s, 0));
        expect(notes.length, `${name} bar ${bar}`).toBeGreaterThan(0);
        for (const note of notes) {
          expect(note.velocity).toBeGreaterThan(0);
          expect(note.duration).toBeGreaterThan(0);
        }
      }
    }
  });

  test("each scene is its own cue: tempo rises from menu to battle to climax", () => {
    expect(PATTERNS.menu.bpm).toBeLessThan(PATTERNS.battle.bpm);
    expect(PATTERNS.battle.bpm).toBeLessThan(PATTERNS.climax.bpm);
    expect(PATTERNS.practice.bpm).toBeLessThan(PATTERNS.battle.bpm);
    for (const mood of ["victory", "draw", "defeat"] as const)
      expect(PATTERNS[`result:${mood}`].bpm).toBeLessThan(PATTERNS.battle.bpm);
    const signature = (name: keyof typeof PATTERNS) =>
      JSON.stringify([PATTERNS[name].chords, PATTERNS[name].lead, PATTERNS[name].bass]);
    const names = Object.keys(PATTERNS) as (keyof typeof PATTERNS)[];
    expect(new Set(names.map(signature)).size).toBe(names.length);
  });

  test("the climax drives harder than the battle loop", () => {
    const density = (name: "battle" | "climax") => {
      let notes = 0;
      for (let s = 0; s < STEPS_PER_BAR * 4; s++) notes += stepNotes(PATTERNS[name], s, 0).length;
      return notes / (STEPS_PER_BAR * 4 * stepSeconds(PATTERNS[name]));
    };
    expect(density("climax")).toBeGreaterThan(density("battle") * 1.3);
  });

  test("scene keys pick the pattern; silence has none", () => {
    expect(patternFor(key("silent"))).toBeNull();
    expect(patternFor(key("result", "defeat"))).toBe(PATTERNS["result:defeat"]);
    expect(patternFor(key("climax"))).toBe(PATTERNS.climax);
  });
});

describe("sequencer", () => {
  test("asking for the same scene every frame starts it once and never restarts it", () => {
    const sequencer = new BgmSequencer();
    const out = run(sequencer, key("battle"), 0, 30);
    expect(out.starts).toHaveLength(1);
    expect(out.stops).toHaveLength(0);
    expect(sequencer.started).toBe(1);
    // Steady: one battle step every sixteenth, no duplicates.
    const kicks = out.notes.filter((n) => n.voice === "kick").map((n) => n.at.toFixed(5));
    expect(new Set(kicks).size).toBe(kicks.length);
    expect(out.notes.every((n) => n.instance === 1)).toBe(true);
  });

  test("a change fades the old loop out completely before the new one begins", () => {
    const sequencer = new BgmSequencer();
    run(sequencer, key("battle"), 0, 5);
    const out = run(sequencer, key("climax"), 5, 12);
    expect(out.stops).toHaveLength(1);
    expect(out.starts).toHaveLength(1);
    const stop = out.stops[0]!;
    const start = out.starts[0]!;
    expect(start.at).toBeGreaterThanOrEqual(
      stop.at + stop.fadeOut + sceneGap(key("climax")) - 1e-9,
    );
    // No more notes for the old loop after the stop; none for the new one before its start.
    const old = out.notes.filter((n) => n.instance === stop.instance);
    expect(old.every((n) => n.at <= stop.at + LOOKAHEAD)).toBe(true);
    const fresh = out.notes.filter((n) => n.instance === start.instance);
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.every((n) => n.at >= start.at - 1e-9)).toBe(true);
  });

  test("results wait for the finish stinger: a longer gap", () => {
    expect(sceneGap(key("result", "victory"))).toBeGreaterThan(1);
    const sequencer = new BgmSequencer();
    run(sequencer, key("battle"), 0, 3);
    const out = run(sequencer, key("result", "victory"), 3, 8);
    expect(out.starts[0]!.at - 3).toBeGreaterThanOrEqual(FADE_OUT + 1);
  });

  test("changing target while fading keeps one pending start (no stacked loops)", () => {
    const sequencer = new BgmSequencer();
    run(sequencer, key("result", "victory"), 0, 4);
    // Rematch, then straight back to the title before the battle loop began.
    const out = run(sequencer, (t) => (t < 4.1 ? key("battle") : key("menu")), 4, 10);
    expect(out.stops).toHaveLength(1);
    expect(out.starts).toHaveLength(1);
    expect(out.starts[0]!.key).toEqual(key("menu"));
    expect(sequencer.current?.key).toEqual(key("menu"));
  });

  test("a mood is part of the scene; silence stops everything", () => {
    const sequencer = new BgmSequencer();
    run(sequencer, key("result", "victory"), 0, 3);
    const swapped = run(sequencer, key("result", "draw"), 3, 7);
    expect(swapped.starts).toHaveLength(1);
    const silent = run(sequencer, key("silent"), 7, 12);
    expect(silent.stops).toHaveLength(1);
    expect(silent.starts).toHaveLength(0);
    expect(silent.notes.every((n) => n.at <= 7 + LOOKAHEAD)).toBe(true);
    expect(sequencer.current).toBeNull();
  });

  test("a stalled clock (hidden tab) resyncs instead of firing the backlog at once", () => {
    const sequencer = new BgmSequencer();
    sequencer.advance(key("climax"), 0);
    sequencer.advance(key("climax"), 0.1);
    const after = sequencer.advance(key("climax"), 20);
    const window = LOOKAHEAD + 0.2;
    expect(after.notes.length).toBeLessThan((window / stepSeconds(PATTERNS.climax)) * 12);
    expect(after.notes.every((n) => n.at >= 20 - 0.2)).toBe(true);
    expect(sequencer.started).toBe(1);
  });
});

describe("player", () => {
  let ctx: FakeAudioContext;
  let player: BgmPlayer;
  const cue = (scene: MusicCue["scene"], paused = false): MusicCue => ({
    scene,
    mood: scene === "result" ? "victory" : null,
    paused,
  });

  beforeEach(() => {
    ctx = new FakeAudioContext();
    const out = ctx.createGain();
    player = new BgmPlayer(
      ctx as unknown as BaseAudioContext,
      out as unknown as AudioNode,
      ctx.createBuffer(1, 8) as unknown as AudioBuffer,
    );
  });
  afterEach(() => player.destroy());

  const frames = (c: MusicCue, seconds: number, audible = true) => {
    const end = ctx.currentTime + seconds;
    while (ctx.currentTime < end) {
      player.update(c, audible);
      ctx.currentTime += FRAME;
    }
  };

  test("pause keeps the loop where it is: same instance, no restart", () => {
    frames(cue("battle"), 2);
    expect(player.state.started).toBe(1);
    frames(cue("battle", true), 3);
    frames(cue("battle"), 2);
    expect(player.state.started).toBe(1);
    expect(player.liveInstances).toBe(1);
  });

  test("menu -> battle -> result -> battle (rematch) -> menu: one live loop at each moment", () => {
    for (const scene of ["menu", "battle", "result", "battle", "menu"] as const) {
      frames(cue(scene), 4);
      expect(player.liveInstances).toBe(1);
    }
    expect(player.state.started).toBe(5);
  });

  test("inaudible (volume 0, muted, suspended) creates no voices but keeps time", () => {
    const mark = ctx.started.length;
    frames(cue("battle"), 3, false);
    expect(ctx.startedSince(mark)).toBe(0);
    expect(player.state.started).toBe(1);
    frames(cue("battle"), 1, true);
    expect(ctx.startedSince(mark)).toBeGreaterThan(0);
    expect(player.state.started).toBe(1);
  });
});
