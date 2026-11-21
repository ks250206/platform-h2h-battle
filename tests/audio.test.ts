import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  BattleAudio,
  DEFAULT_MIX,
  effectCategory,
  effectsOpen,
  eventLength,
  mixGains,
  MUSIC_LEVEL,
  SFX_LEVEL,
  stackGain,
  swordCategory,
  swordCues,
  VOICE_LIMITS,
  VoiceLimiter,
  type SwordCue,
  type SwordFighter,
  type SwordMemory,
} from "../src/game/audio";
import { BattleEngine } from "../src/game/engine";
import { PresentationTracker, type PresentationEvent } from "../src/game/presentation";
import { NO_GIMMICKS } from "../src/game/rules";
import { DEFAULT_BGM_VOLUME, DEFAULT_SE_VOLUME } from "../src/game/settings";
import { emptyInput, type AttackId, type FighterMode, type GameState } from "../src/game/types";
import { FakeAudioContext, installFakeAudio, uninstallFakeAudio } from "./fakeAudio";

const ATTACK_IDS: AttackId[] = ["overhead", "rising", "sweep", "thrust"];

function memory(mode: FighterMode, attack: AttackId | null = null, swingId = 1): SwordMemory {
  return { mode, attack, swingId, lastHumAt: 0 };
}

function fighter(overrides: Partial<SwordFighter> = {}): SwordFighter {
  return {
    mode: "idle",
    attack: null,
    charge: 0,
    grounded: true,
    swingId: 1,
    human: true,
    ...overrides,
  };
}

const kinds = (cues: SwordCue[]) => cues.map((cue) => cue.kind);

describe("swordCues", () => {
  test.each(ATTACK_IDS)("whooshes when a %s enters active", (attack) => {
    const cues = swordCues(memory("windup", attack), fighter({ mode: "active", attack }), 1);
    expect(cues).toEqual([expect.objectContaining({ kind: "whoosh", attack })]);
  });

  test("slams only for a grounded overhead leaving active into recovery", () => {
    const leaving = (attack: AttackId, grounded: boolean, mode: FighterMode = "recovery") =>
      kinds(swordCues(memory("active", attack), fighter({ mode, attack, grounded }), 1));
    expect(leaving("overhead", true)).toEqual(["slam"]);
    expect(leaving("overhead", false)).toEqual([]);
    expect(leaving("overhead", true, "clash")).toEqual([]);
    for (const attack of ["rising", "sweep", "thrust"] as const)
      expect(leaving(attack, true)).toEqual([]);
  });

  test("still whooshes and slams when the active window fell between frames", () => {
    const cues = swordCues(
      memory("windup", "overhead"),
      fighter({ mode: "recovery", attack: "overhead" }),
      1,
    );
    expect(kinds(cues)).toEqual(["whoosh", "slam"]);
  });

  test("heaves when an attack is committed", () => {
    const cues = swordCues(
      memory("charge", "overhead", 1),
      fighter({ mode: "windup", attack: "overhead", swingId: 2 }),
      1,
    );
    expect(kinds(cues)).toEqual(["heave"]);
  });

  test("no cue while the mode is unchanged", () => {
    for (const mode of ["idle", "windup", "active", "recovery", "step", "hitstun"] as const)
      expect(swordCues(memory(mode, "overhead"), fighter({ mode, attack: "overhead" }), 1)).toEqual(
        [],
      );
  });

  test("no cue for a fighter seen for the first time or dead", () => {
    expect(swordCues(undefined, fighter({ mode: "active", attack: "sweep" }), 1)).toEqual([]);
    expect(swordCues(memory("active", "sweep"), fighter({ mode: "dead" }), 1)).toEqual([]);
  });

  test("charge hum ticks on entry and then every 0.22 s", () => {
    const charging = fighter({ mode: "charge", attack: "overhead", charge: 0.5 });
    expect(kinds(swordCues(memory("idle"), charging, 5))).toEqual(["hum"]);
    const held = { ...memory("charge", "overhead"), lastHumAt: 5 };
    expect(swordCues(held, charging, 5.1)).toEqual([]);
    expect(kinds(swordCues(held, charging, 5.23))).toEqual(["hum"]);
  });

  test("higher charge makes whooshes louder and deeper, and the hum higher", () => {
    let previousPower = -Infinity;
    let previousDepth = Infinity;
    let previousHum = -Infinity;
    for (let charge = 0; charge <= 1.0001; charge += 0.1) {
      const [whoosh] = swordCues(
        memory("windup", "overhead"),
        fighter({ mode: "active", attack: "overhead", charge }),
        1,
      );
      const [hum] = swordCues(memory("idle"), fighter({ mode: "charge", charge }), 1);
      if (whoosh?.kind !== "whoosh" || hum?.kind !== "hum") throw new Error("missing cue");
      expect(whoosh.power).toBeGreaterThan(previousPower);
      expect(whoosh.depth).toBeLessThan(previousDepth);
      expect(hum.charge).toBeGreaterThan(previousHum);
      previousPower = whoosh.power;
      previousDepth = whoosh.depth;
      previousHum = hum.charge;
    }
  });

  test("CPU fighters are quieter than the human", () => {
    const cue = (human: boolean) =>
      swordCues(
        memory("windup", "sweep"),
        fighter({ mode: "active", attack: "sweep", human }),
        1,
      )[0];
    expect(cue(false)!.voice).toBeLessThan(cue(true)!.voice);
  });
});

describe("mix", () => {
  test("music and effects are independent; mute silences both", () => {
    const full = mixGains({ bgmVolume: 1, seVolume: 1, muted: false });
    expect(full).toEqual({ master: 1, music: MUSIC_LEVEL, sfx: SFX_LEVEL });
    const noMusic = mixGains({ bgmVolume: 0, seVolume: 0.8, muted: false });
    expect(noMusic.music).toBe(0);
    expect(noMusic.sfx).toBeCloseTo(0.24);
    expect(noMusic.master).toBe(1);
    const noEffects = mixGains({ bgmVolume: 0.6, seVolume: 0, muted: false });
    expect(noEffects.sfx).toBe(0);
    expect(noEffects.music).toBeGreaterThan(0);
    expect(mixGains({ bgmVolume: 1, seVolume: 1, muted: true }).master).toBe(0);
  });

  test("defaults keep the original effect level and sit the music under it", () => {
    expect(DEFAULT_MIX).toEqual({
      bgmVolume: DEFAULT_BGM_VOLUME,
      seVolume: DEFAULT_SE_VOLUME,
      muted: false,
    });
    const gains = mixGains(DEFAULT_MIX);
    expect(gains.sfx).toBeCloseTo(0.24);
    expect(gains.music).toBeLessThan(gains.sfx);
  });

  test("out-of-range volumes are clamped", () => {
    expect(mixGains({ bgmVolume: 4, seVolume: -1, muted: false })).toEqual({
      master: 1,
      music: MUSIC_LEVEL,
      sfx: 0,
    });
    expect(mixGains({ bgmVolume: Number.NaN, seVolume: 1, muted: false }).music).toBe(0);
  });

  test("effects are gated on the title and while paused, never the music", () => {
    expect(effectsOpen("menu")).toBe(false);
    expect(effectsOpen("paused")).toBe(false);
    for (const phase of ["countdown", "playing", "ended"] as const)
      expect(effectsOpen(phase)).toBe(true);
  });
});

describe("voice limiting", () => {
  test("critical cues (charge, warnings, KO, bombs) never share the impact budget", () => {
    for (const kind of ["charge", "bomb", "ko"] as const) expect(effectCategory(kind)).toBe("cue");
    for (const kind of ["hit", "clash", "throw", "cancel"] as const)
      expect(effectCategory(kind)).toBe("impact");
    expect(effectCategory("step")).toBe("quiet");
    expect(swordCategory({ kind: "hum", charge: 0.5, voice: 1 })).toBe("cue");
    expect(swordCategory({ kind: "heave", voice: 1 })).toBe("impact");
  });

  test("a frame of four-player hits is capped and each extra voice is quieter", () => {
    const limiter = new VoiceLimiter();
    limiter.beginFrame();
    const grants = Array.from({ length: 10 }, () => limiter.acquire("impact", 0, 0.2));
    const granted = grants.filter((g) => g !== null) as number[];
    expect(granted).toHaveLength(VOICE_LIMITS.impact.perFrame);
    for (let i = 1; i < granted.length; i++) expect(granted[i]!).toBeLessThan(granted[i - 1]!);
    // Summed loudness grows far slower than the count (no clipping pile-up).
    expect(granted.reduce((a, b) => a + b, 0)).toBeLessThan(2.6);
    // The cue budget is untouched: a KO and a bomb warning still get through.
    expect(limiter.acquire("cue", 0, 0.5)).toBe(1);
    expect(limiter.acquire("cue", 0, 0.4)).not.toBeNull();
  });

  test("concurrent voices are counted on the audio clock", () => {
    const limiter = new VoiceLimiter();
    let t = 0;
    let granted = 0;
    for (let frame = 0; frame < 6; frame++, t += 0.01) {
      limiter.beginFrame();
      for (let i = 0; i < 4; i++) if (limiter.acquire("impact", t, 1) !== null) granted++;
    }
    expect(granted).toBe(VOICE_LIMITS.impact.concurrent);
    expect(limiter.active("impact", t)).toBe(VOICE_LIMITS.impact.concurrent);
    expect(limiter.active("impact", t + 2)).toBe(0);
    limiter.beginFrame();
    expect(limiter.acquire("impact", t + 2, 1)).toBe(1);
  });

  test("footsteps keep a minimum gap", () => {
    const limiter = new VoiceLimiter();
    limiter.beginFrame();
    expect(limiter.acquire("quiet", 0, 0.1)).not.toBeNull();
    limiter.beginFrame();
    expect(limiter.acquire("quiet", 0.02, 0.1)).toBeNull();
    limiter.beginFrame();
    expect(limiter.acquire("quiet", 0.06, 0.1)).not.toBeNull();
  });

  test("stack gain falls off with the count", () => {
    expect(stackGain(0)).toBe(1);
    expect(stackGain(3)).toBeLessThan(stackGain(1));
  });

  test("finishes ring longest, the ladder clear above all", () => {
    const finish = (kind: "win" | "setWin" | "ladderClear") =>
      eventLength({
        kind: "finish",
        finish: kind,
        winnerId: 0,
        byKo: true,
        x: 0,
        y: 0,
        z: 0,
        color: 0,
      });
    expect(finish("ladderClear")).toBeGreaterThan(finish("setWin"));
    expect(finish("setWin")).toBeGreaterThan(finish("win"));
  });
});

describe("BattleAudio on a fake AudioContext", () => {
  beforeEach(() => installFakeAudio());
  afterEach(() => uninstallFakeAudio());

  const FRAME = 1 / 60;
  function setup(mix = { bgmVolume: 0.6, seVolume: 0.8, muted: false }) {
    const audio = new BattleAudio();
    audio.setMix(mix);
    audio.unlock();
    const ctx = FakeAudioContext.created.at(-1)!;
    const tracker = new PresentationTracker();
    const frame = (state: GameState, extra: PresentationEvent[] = []) => {
      const events = [...tracker.update(state), ...extra];
      audio.update(state, events);
      ctx.currentTime += FRAME;
      return events;
    };
    return { audio, ctx, frame };
  }

  test("no context is created before a gesture, and a missing API is harmless", () => {
    const audio = new BattleAudio();
    audio.setMix({ bgmVolume: 1, seVolume: 1, muted: false });
    expect(FakeAudioContext.created).toHaveLength(0);
    uninstallFakeAudio();
    const engine = new BattleEngine(1);
    expect(() => {
      audio.unlock();
      audio.update(engine.state, []);
    }).not.toThrow();
  });

  test("a blocked (suspended) context never throws and plays nothing", () => {
    FakeAudioContext.initialState = "suspended";
    const { audio, ctx, frame } = setup();
    const engine = new BattleEngine(2);
    engine.start("duel", { stocks: 1, gimmicks: { ...NO_GIMMICKS } });
    for (let i = 0; i < 60; i++) frame(engine.state);
    expect(ctx.started).toHaveLength(0);
    expect(ctx.resumeCalls).toBeGreaterThan(0);
    audio.destroy();
  });

  test("bus gains follow the sliders and the mute", () => {
    const { audio } = setup();
    audio.setMix({ bgmVolume: 0, seVolume: 1, muted: false });
    expect(audio.busGains).toMatchObject({ master: 1, music: 0, sfx: SFX_LEVEL });
    audio.setMix({ bgmVolume: 1, seVolume: 0, muted: false });
    expect(audio.busGains).toMatchObject({ master: 1, music: MUSIC_LEVEL, sfx: 0 });
    audio.setMix({ bgmVolume: 1, seVolume: 1, muted: true });
    expect(audio.busGains?.master).toBe(0);
    audio.setEnabled(true);
    expect(audio.busGains?.master).toBe(1);
  });

  test("title music plays on the menu, the effect gate is shut there and while paused", () => {
    const { audio, frame } = setup();
    const engine = new BattleEngine(3);
    engine.menu("duel");
    for (let i = 0; i < 30; i++) frame(engine.state);
    expect(audio.music?.state.current?.key.scene).toBe("menu");
    expect(audio.busGains?.gate).toBe(0);
    engine.start("duel", { gimmicks: { ...NO_GIMMICKS } });
    for (let i = 0; i < 90; i++) frame(engine.state);
    expect(audio.busGains?.gate).toBe(1);
    engine.state.phase = "playing";
    engine.pause();
    frame(engine.state);
    expect(audio.busGains?.gate).toBe(0);
    audio.destroy();
  });

  test("pause, the settings dialog (a pause), rematch, next set game and the menu never stack loops", () => {
    const { audio, frame } = setup();
    const engine = new BattleEngine(4);
    const playFor = (seconds: number) => {
      for (let i = 0; i < seconds * 60; i++) {
        engine.update(FRAME, emptyInput());
        frame(engine.state);
        const music = audio.music!;
        expect(music.liveInstances).toBeLessThanOrEqual(1);
      }
    };
    engine.menu("duel");
    playFor(2);
    engine.start("duel", { stocks: 1, setFormat: "bo3", gimmicks: { ...NO_GIMMICKS } });
    playFor(5);
    const startedInBattle = audio.music!.state.started;
    engine.pause();
    playFor(3);
    engine.resume();
    playFor(2);
    expect(audio.music!.state.started).toBe(startedInBattle);
    // Game 1 decided: the result loop.
    for (const f of engine.state.fighters) if (!f.human) f.hitstop = 0;
    Object.assign(engine.state.fighters[1]!, { y: -20, vy: 0, grounded: false, hitstop: 0 });
    playFor(4);
    expect(engine.state.phase).toBe("ended");
    expect(audio.music!.state.current?.key.scene).toBe("result");
    expect(engine.nextSetGame()).toBe(true);
    playFor(4);
    expect(audio.music!.state.current?.key.scene).toBe("battle");
    engine.start("duel");
    playFor(2);
    engine.menu("duel");
    playFor(3);
    expect(audio.music!.state.current?.key.scene).toBe("menu");
    // menu, battle, result, battle (next game), menu; the restart kept the battle loop going.
    expect(audio.music!.state.started).toBe(5);
    audio.destroy();
  });

  test("training never sounds a climax, an elimination or a finish", () => {
    const { ctx, frame } = setup({ bgmVolume: 0, seVolume: 1, muted: false });
    const engine = new BattleEngine(5);
    engine.start("training", {});
    engine.state.phase = "playing";
    frame(engine.state);
    const fake = (kind: "climax" | "finish" | "elimination"): PresentationEvent =>
      kind === "climax"
        ? { kind, reason: "clock" }
        : kind === "finish"
          ? { kind, finish: "win", winnerId: 0, byKo: true, x: 0, y: 0, z: 0, color: 0 }
          : { kind, fighterId: 1, remaining: 1, x: 0, y: 0, z: 0, color: 0 };
    const mark = ctx.started.length;
    frame(engine.state, [fake("climax"), fake("finish"), fake("elimination")]);
    expect(ctx.startedSince(mark)).toBe(0);
    // The same finish in a real match is heard.
    const duel = new BattleEngine(6);
    duel.start("duel", { stocks: 1, gimmicks: { ...NO_GIMMICKS } });
    duel.state.phase = "playing";
    frame(duel.state);
    Object.assign(duel.state.fighters[1]!, { y: -20, vy: 0, grounded: false, hitstop: 0 });
    duel.update(FRAME, emptyInput());
    const before = ctx.started.length;
    const events = frame(duel.state);
    expect(events.map((e) => e.kind)).toEqual(["finish"]);
    expect(ctx.startedSince(before)).toBeGreaterThan(5);
  });

  test("SE at 0 or mute starts no effect voices; BGM at 0 keeps effects", () => {
    const hits = (mix: { bgmVolume: number; seVolume: number; muted: boolean }) => {
      const { ctx, frame } = setup(mix);
      const engine = new BattleEngine(7);
      engine.start("duel", { gimmicks: { ...NO_GIMMICKS } });
      engine.state.phase = "playing";
      frame(engine.state);
      engine.state.effects.push({
        id: 999,
        kind: "hit",
        x: 0,
        y: 0,
        z: 0,
        color: 0,
        life: 0.3,
        duration: 0.3,
        size: 1,
      });
      const mark = ctx.started.length;
      frame(engine.state);
      return ctx.startedSince(mark);
    };
    expect(hits({ bgmVolume: 0, seVolume: 1, muted: false })).toBeGreaterThan(0);
    expect(hits({ bgmVolume: 1, seVolume: 0, muted: false })).toBe(0);
    expect(hits({ bgmVolume: 0, seVolume: 1, muted: true })).toBe(0);
  });

  test("a four-player pile-up is capped while the warning still sounds", () => {
    const { ctx, frame } = setup({ bgmVolume: 0, seVolume: 1, muted: false });
    const engine = new BattleEngine(8);
    engine.start("rumble", { gimmicks: { ...NO_GIMMICKS } });
    engine.state.phase = "playing";
    frame(engine.state);
    for (let i = 0; i < 12; i++)
      engine.state.effects.push({
        id: 1000 + i,
        kind: i % 2 ? "clash" : "hit",
        x: 0,
        y: 0,
        z: 0,
        color: 0,
        life: 0.3,
        duration: 0.3,
        size: 1,
      });
    const mark = ctx.started.length;
    frame(engine.state, [{ kind: "bombWarning", count: 3 }]);
    const started = ctx.startedSince(mark);
    // Each hit or clash starts 3-4 sources; only the per-frame budget of them plays, plus the
    // two-ping warning.
    expect(started).toBeLessThanOrEqual(VOICE_LIMITS.impact.perFrame * 4 + 2);
    expect(started).toBeGreaterThanOrEqual(2);
  });
});
