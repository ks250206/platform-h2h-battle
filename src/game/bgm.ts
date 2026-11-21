// Background music, synthesized on the fly with WebAudio: no audio files, nothing to license.
//
// Three layers, each testable on its own:
// - PATTERNS: plain data, one short original loop per scene (menu, practice, battle, climax and
//   three result moods), written as note names on a 16-step grid.
// - BgmSequencer: pure timing. Given the scene the game asks for and the audio clock, it says
//   which notes to schedule and when a scene starts or stops. Asking for the same scene every
//   frame changes nothing; asking for another one fades the old loop out completely before the
//   new one begins, so two loops never sound together and a loop is never started twice.
// - BgmPlayer: turns the sequencer's notes into short-lived oscillators on one music bus.

import type { MusicCue, MusicScene, ResultMood } from "./presentation";

export type BgmVoice = "pad" | "bass" | "lead" | "bell" | "pluck" | "kick" | "snare" | "hat";

export interface BgmPattern {
  bpm: number;
  /** One chord per bar, lowest note first (MIDI numbers). */
  chords: readonly (readonly number[])[];
  /** Sustained chord on every bar's first step. */
  pad: number;
  /** 16 characters per bar: `x` root an octave down, `o` root, `f` fifth an octave down. */
  bass: string;
  /** 16 characters: digits pick chord tones, rising an octave every three. */
  pluck: string;
  kick: string;
  snare: string;
  hat: string;
  /** Per bar: 16 space-separated tokens, a note name or `.` (hold / rest). */
  lead: readonly string[];
  leadVoice: "lead" | "bell";
  /** Relative loudness of each voice in this scene. */
  levels: Partial<Record<BgmVoice, number>>;
}

export interface BgmNote {
  voice: BgmVoice;
  /** MIDI number; 0 for drums. */
  midi: number;
  /** Audio-clock seconds. */
  at: number;
  duration: number;
  velocity: number;
  /** The scene instance it belongs to (see BgmSequencer). */
  instance: number;
}

const NOTE_INDEX: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "A4" -> 69, "Bb2" -> 46, "F#3" -> 54. */
export function midiOf(name: string): number {
  const match = /^([A-G])(#|b)?(-?\d)$/.exec(name);
  if (!match) throw new Error(`bad note ${name}`);
  const accidental = match[2] === "#" ? 1 : match[2] === "b" ? -1 : 0;
  return 12 * (Number(match[3]) + 1) + NOTE_INDEX[match[1]!]! + accidental;
}

export const midiToFrequency = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);

const chord = (...names: string[]) => names.map(midiOf);

const REST = "................";

/** Every scene's loop. All four bars long; tempo and texture tell them apart. */
export const PATTERNS: Readonly<
  Record<Exclude<MusicScene, "silent" | "result"> | `result:${ResultMood}`, BgmPattern>
> = {
  // Calm and airy: soft pad, a slow bell tune, almost no rhythm.
  menu: {
    bpm: 88,
    chords: [
      chord("F3", "A3", "C4"),
      chord("D3", "F3", "A3"),
      chord("Bb2", "D3", "F3"),
      chord("C3", "E3", "G3"),
    ],
    pad: 1,
    bass: "x.......x.......",
    pluck: "0.1.2.1.0.1.2.1.",
    kick: REST,
    snare: REST,
    hat: "..x...x...x...x.",
    lead: [
      "A4 . . . C5 . . . A4 . G4 . F4 . . .",
      "F4 . . . A4 . . . D5 . . . C5 . . .",
      "D5 . . . C5 . Bb4 . A4 . . . F4 . . .",
      "G4 . . . . . . . E4 . . . . . . .",
    ],
    leadVoice: "bell",
    levels: { pad: 0.5, bass: 0.55, pluck: 0.35, hat: 0.18, bell: 0.55 },
  },
  // Practice: light groove that stays out of the way of the sword sounds.
  practice: {
    bpm: 100,
    chords: [
      chord("C3", "E3", "G3"),
      chord("A2", "C3", "E3"),
      chord("F2", "A2", "C3"),
      chord("G2", "B2", "D3"),
    ],
    pad: 0,
    bass: "x...x...x...x.o.",
    pluck: "0..1..2.0..1..2.",
    kick: "x.......x.......",
    snare: REST,
    hat: "x.x.x.x.x.x.x.x.",
    lead: [],
    leadVoice: "bell",
    levels: { bass: 0.55, pluck: 0.4, kick: 0.45, hat: 0.16 },
  },
  // The fight: minor key, driving bass, backbeat and a short heroic hook.
  battle: {
    bpm: 132,
    chords: [
      chord("D3", "F3", "A3"),
      chord("Bb2", "D3", "F3"),
      chord("F2", "A2", "C3"),
      chord("C3", "E3", "G3"),
    ],
    pad: 0,
    bass: "x.xox.xox.xox.xo",
    pluck: REST,
    kick: "x.....x.x.......",
    snare: "....x.......x...",
    hat: "x.x.x.x.x.x.x.x.",
    lead: [
      "D5 . . . . . A4 . D5 . E5 . F5 . . .",
      "D5 . . . . . . . Bb4 . . . . . . .",
      "C5 . . . . . A4 . C5 . D5 . E5 . . .",
      "G5 . . . F5 . . . E5 . . . C5 . . .",
    ],
    leadVoice: "lead",
    levels: { bass: 0.7, kick: 0.75, snare: 0.5, hat: 0.22, lead: 0.42 },
  },
  // The decisive stretch: a step higher, faster, sixteenth bass, rising arpeggios.
  climax: {
    bpm: 152,
    chords: [
      chord("E3", "G3", "B3"),
      chord("C3", "E3", "G3"),
      chord("D3", "F#3", "A3"),
      chord("B2", "D#3", "F#3"),
    ],
    pad: 0,
    bass: "xxoxxxoxxxoxxxox",
    pluck: "0120120120120345",
    kick: "x...x...x...x...",
    snare: "....x.......x.xx",
    hat: "xxxxxxxxxxxxxxxx",
    lead: [
      "E5 . . . G5 . . . B5 . . . A5 . G5 .",
      "E5 . . . . . . . C5 . D5 . E5 . . .",
      "F#5 . . . A5 . . . D6 . . . C6 . A5 .",
      "B5 . . . . . . . D#5 . . . F#5 . . .",
    ],
    leadVoice: "lead",
    levels: { bass: 0.7, pluck: 0.3, kick: 0.85, snare: 0.55, hat: 0.18, lead: 0.45 },
  },
  // Results: slow and warm after a win, unresolved after a draw, gentle and low after a loss.
  "result:victory": {
    bpm: 84,
    chords: [
      chord("C3", "E3", "G3"),
      chord("A2", "C3", "E3"),
      chord("F2", "A2", "C3"),
      chord("G2", "B2", "D3"),
    ],
    pad: 1,
    bass: "x.......x.......",
    pluck: "0...1...2...1...",
    kick: REST,
    snare: REST,
    hat: "....x.......x...",
    lead: [
      "E5 . . . G5 . . . C6 . . . . . . .",
      "A5 . . . G5 . . . E5 . . . . . . .",
      "F5 . . . A5 . . . G5 . . . F5 . . .",
      "D5 . . . . . . . G4 . . . . . . .",
    ],
    leadVoice: "bell",
    levels: { pad: 0.5, bass: 0.5, pluck: 0.3, hat: 0.14, bell: 0.55 },
  },
  "result:draw": {
    bpm: 80,
    chords: [
      chord("A2", "D3", "E3"),
      chord("F2", "C3", "G3"),
      chord("D3", "G3", "A3"),
      chord("E3", "A3", "B3"),
    ],
    pad: 1,
    bass: "x...............",
    pluck: "0...2...1...2...",
    kick: REST,
    snare: REST,
    hat: REST,
    lead: [],
    leadVoice: "bell",
    levels: { pad: 0.5, bass: 0.45, pluck: 0.32 },
  },
  "result:defeat": {
    bpm: 76,
    chords: [
      chord("A2", "C3", "E3"),
      chord("D3", "F3", "A3"),
      chord("F2", "A2", "C3"),
      chord("E2", "G#2", "B2"),
    ],
    pad: 1,
    bass: "x.......x.......",
    pluck: REST,
    kick: REST,
    snare: REST,
    hat: REST,
    lead: [
      "E5 . . . D5 . . . C5 . . . B4 . . .",
      "A4 . . . . . . . F4 . . . . . . .",
      "A4 . . . C5 . . . B4 . . . A4 . . .",
      "G#4 . . . . . . . . . . . . . . .",
    ],
    leadVoice: "bell",
    levels: { pad: 0.5, bass: 0.45, bell: 0.45 },
  },
};

export interface SceneKey {
  scene: MusicScene;
  mood: ResultMood | null;
}

export function patternFor(key: SceneKey): BgmPattern | null {
  if (key.scene === "silent") return null;
  if (key.scene === "result") return PATTERNS[`result:${key.mood ?? "victory"}`];
  return PATTERNS[key.scene];
}

export const STEPS_PER_BAR = 16;
export const stepSeconds = (pattern: BgmPattern): number => 60 / pattern.bpm / 4;

interface LeadSlot {
  midi: number;
  steps: number;
}

const leadCache = new WeakMap<BgmPattern, (LeadSlot | null)[][]>();
function leadSlots(pattern: BgmPattern): (LeadSlot | null)[][] {
  let slots = leadCache.get(pattern);
  if (slots) return slots;
  slots = pattern.lead.map((bar) => {
    const tokens = bar.split(/\s+/);
    if (tokens.length !== STEPS_PER_BAR) throw new Error(`lead bar needs 16 steps: ${bar}`);
    return tokens.map((token, index) => {
      if (token === ".") return null;
      let steps = 1;
      while (index + steps < STEPS_PER_BAR && tokens[index + steps] === ".") steps++;
      return { midi: midiOf(token), steps };
    });
  });
  leadCache.set(pattern, slots);
  return slots;
}

/** The notes one step of `pattern` plays, starting at `at`. Pure. */
export function stepNotes(pattern: BgmPattern, step: number, at: number, instance = 0): BgmNote[] {
  const bars = pattern.chords.length;
  const bar = Math.floor(step / STEPS_PER_BAR) % bars;
  const s = step % STEPS_PER_BAR;
  const tones = pattern.chords[bar]!;
  const unit = stepSeconds(pattern);
  const level = (voice: BgmVoice) => pattern.levels[voice] ?? 0;
  const notes: BgmNote[] = [];
  const push = (voice: BgmVoice, midi: number, steps: number, accent = 1) => {
    const velocity = level(voice) * accent;
    if (velocity > 0) notes.push({ voice, midi, at, duration: unit * steps, velocity, instance });
  };
  if (pattern.pad && s === 0)
    for (const tone of tones) push("pad", tone + 12, STEPS_PER_BAR * 0.98, pattern.pad);
  const bass = pattern.bass[s];
  if (bass === "x") push("bass", tones[0]! - 12, 1.6);
  else if (bass === "o") push("bass", tones[0]!, 1.4);
  else if (bass === "f") push("bass", tones[2]! - 12, 1.4);
  const pluck = pattern.pluck[s];
  if (pluck && pluck >= "0" && pluck <= "9") {
    const index = Number(pluck);
    push("pluck", tones[index % 3]! + 12 * (1 + Math.floor(index / 3)), 2);
  }
  if (pattern.kick[s] === "x") push("kick", 0, 1);
  if (pattern.snare[s] === "x") push("snare", 0, 1);
  if (pattern.hat[s] === "x") push("hat", 0, 1, s % 4 === 0 ? 1 : 0.7);
  const lead = leadSlots(pattern)[bar]?.[s];
  if (lead) push(pattern.leadVoice, lead.midi, lead.steps * 0.92);
  return notes;
}

export interface SceneStart {
  instance: number;
  key: SceneKey;
  at: number;
  fadeIn: number;
}
export interface SceneStop {
  instance: number;
  at: number;
  fadeOut: number;
}
export interface SequencerOutput {
  notes: BgmNote[];
  starts: SceneStart[];
  stops: SceneStop[];
}

/** How long a loop takes to fade away when the scene changes. */
export const FADE_OUT = 0.45;
/** Scheduling window ahead of the audio clock. */
export const LOOKAHEAD = 0.2;
/** A clock this far past the next step (a stalled or hidden tab) resyncs instead of catching up. */
const RESYNC = 0.12;

/** Silence between the old loop's fade and the new one: the finish stinger owns the gap. */
export function sceneGap(key: SceneKey | null): number {
  if (!key) return 0;
  return key.scene === "result" ? 1.7 : 0.1;
}
const fadeInFor = (key: SceneKey) => (key.scene === "result" || key.scene === "menu" ? 1.2 : 0.35);

export const sameKey = (a: SceneKey | null, b: SceneKey | null): boolean =>
  a === b || (!!a && !!b && a.scene === b.scene && a.mood === b.mood);

interface Running {
  key: SceneKey;
  instance: number;
  step: number;
  nextAt: number;
}

/**
 * Pure scheduling of one music loop at a time. Each started loop is an *instance* with its own
 * fade; a stop fades the instance to silence before the next one may start.
 */
export class BgmSequencer {
  private running: Running | null = null;
  private next: { key: SceneKey | null; stoppedAt: number; at: number } | null = null;
  private instances = 0;

  /** The scene playing, or the one being faded to. Null is silence. */
  get heading(): SceneKey | null {
    return this.next ? this.next.key : (this.running?.key ?? null);
  }

  /** The instance currently producing notes, if any. */
  get current(): { key: SceneKey; instance: number } | null {
    return this.running ? { key: this.running.key, instance: this.running.instance } : null;
  }

  /** How many loops have been started since creation. */
  get started(): number {
    return this.instances;
  }

  advance(target: SceneKey, now: number, lookahead = LOOKAHEAD): SequencerOutput {
    const out: SequencerOutput = { notes: [], starts: [], stops: [] };
    const wanted = target.scene === "silent" ? null : target;
    if (!sameKey(this.heading, wanted)) {
      if (this.running) {
        out.stops.push({ instance: this.running.instance, at: now, fadeOut: FADE_OUT });
        this.next = {
          key: wanted,
          stoppedAt: now + FADE_OUT,
          at: now + FADE_OUT + sceneGap(wanted),
        };
        this.running = null;
      } else if (this.next) {
        // Still fading out: aim the pending start at the new scene, keeping the silence intact.
        this.next = {
          key: wanted,
          stoppedAt: this.next.stoppedAt,
          at: Math.max(now, this.next.stoppedAt + sceneGap(wanted)),
        };
      } else if (wanted) {
        this.next = { key: wanted, stoppedAt: now, at: now + 0.05 };
      }
    }
    if (this.next && this.next.at <= now + lookahead) {
      const { key, at } = this.next;
      this.next = null;
      if (key) {
        const instance = ++this.instances;
        this.running = { key, instance, step: 0, nextAt: Math.max(at, now) };
        out.starts.push({ instance, key, at: this.running.nextAt, fadeIn: fadeInFor(key) });
      }
    }
    const running = this.running;
    const pattern = running && patternFor(running.key);
    if (running && pattern) {
      const unit = stepSeconds(pattern);
      if (running.nextAt < now - RESYNC) {
        // Skip the steps that could not be played instead of firing them all at once.
        const missed = Math.ceil((now - running.nextAt) / unit);
        running.step += missed;
        running.nextAt += missed * unit;
      }
      while (running.nextAt < now + lookahead) {
        out.notes.push(...stepNotes(pattern, running.step, running.nextAt, running.instance));
        running.step++;
        running.nextAt += unit;
      }
    }
    return out;
  }
}

/** Gain of the music bus while paused: the loop keeps its place, quieter and muffled. */
export const PAUSED_MUSIC_LEVEL = 0.4;
const PAUSED_CUTOFF = 900;
const OPEN_CUTOFF = 18000;

/** The WebAudio side: one music bus, one gain per loop instance, notes as short oscillators. */
export class BgmPlayer {
  private readonly sequencer = new BgmSequencer();
  private readonly filter: BiquadFilterNode;
  private readonly pauseGain: GainNode;
  private readonly duck: GainNode;
  private readonly instances = new Map<number, GainNode>();
  /** Stopped instances still fading out, keyed by the timer that disconnects them. */
  private readonly fading = new Map<ReturnType<typeof setTimeout>, GainNode>();
  private paused = false;
  private disposed = false;

  constructor(
    private readonly context: BaseAudioContext,
    output: AudioNode,
    private readonly noise: AudioBuffer | null,
  ) {
    this.duck = context.createGain();
    this.filter = context.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = OPEN_CUTOFF;
    this.pauseGain = context.createGain();
    this.duck.connect(this.filter);
    this.filter.connect(this.pauseGain);
    this.pauseGain.connect(output);
  }

  /** For tests and tooling: what the sequencer is doing. */
  get state(): BgmSequencer {
    return this.sequencer;
  }

  /** Live voices across all instances (each instance gain counts once). */
  get liveInstances(): number {
    return this.instances.size;
  }

  /**
   * Called every rendered frame with the cue the state asks for. `audible` false (music volume 0,
   * muted, or a suspended context) keeps the loop's place without creating any voices.
   */
  update(cue: MusicCue, audible: boolean): void {
    if (this.disposed) return;
    const now = this.context.currentTime;
    if (cue.paused !== this.paused) {
      this.paused = cue.paused;
      this.pauseGain.gain.setTargetAtTime(cue.paused ? PAUSED_MUSIC_LEVEL : 1, now, 0.08);
      this.filter.frequency.setTargetAtTime(cue.paused ? PAUSED_CUTOFF : OPEN_CUTOFF, now, 0.08);
    }
    const out = this.sequencer.advance({ scene: cue.scene, mood: cue.mood }, now);
    for (const stop of out.stops) this.stopInstance(stop);
    for (const start of out.starts) this.startInstance(start);
    if (!audible) return;
    for (const note of out.notes) this.voice(note);
  }

  /** Briefly lowers the music under a big sound effect (a KO, the finish). */
  duckFor(depth: number, hold: number): void {
    if (this.disposed) return;
    const now = this.context.currentTime;
    const gain = this.duck.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(depth, now + 0.03);
    gain.setValueAtTime(depth, now + hold);
    gain.linearRampToValueAtTime(1, now + hold + 0.5);
  }

  private startInstance(start: SceneStart): void {
    const gain = this.context.createGain();
    gain.gain.setValueAtTime(0.0001, start.at);
    gain.gain.exponentialRampToValueAtTime(1, start.at + start.fadeIn);
    gain.connect(this.duck);
    this.instances.set(start.instance, gain);
  }

  private stopInstance(stop: SceneStop): void {
    const gain = this.instances.get(stop.instance);
    if (!gain) return;
    this.instances.delete(stop.instance);
    gain.gain.cancelScheduledValues(stop.at);
    gain.gain.setValueAtTime(Math.max(0.0001, gain.gain.value), stop.at);
    gain.gain.exponentialRampToValueAtTime(0.0001, stop.at + stop.fadeOut);
    // Hard zero at the end of the fade: no tail of the old loop can reach the next one.
    gain.gain.setValueAtTime(0, stop.at + stop.fadeOut);
    const end = stop.at + stop.fadeOut + 0.05;
    const delay = Math.max(0, end - this.context.currentTime) * 1000;
    const timer = setTimeout(() => {
      this.fading.delete(timer);
      gain.disconnect();
    }, delay + 100);
    this.fading.set(timer, gain);
  }

  private voice(note: BgmNote): void {
    const target = this.instances.get(note.instance);
    if (!target) return;
    const ctx = this.context;
    const { at, duration } = note;
    const v = note.velocity;
    switch (note.voice) {
      case "pad": {
        const f = midiToFrequency(note.midi);
        this.osc(target, "triangle", f * 1.0035, at, duration, 0.05 * v, 0.35, 0.5, 1800);
        this.osc(target, "triangle", f * 0.9965, at, duration, 0.05 * v, 0.35, 0.5, 1800);
        break;
      }
      case "bass":
        this.osc(
          target,
          "sawtooth",
          midiToFrequency(note.midi),
          at,
          duration,
          0.12 * v,
          0.008,
          0.08,
          520,
        );
        break;
      case "lead":
        this.osc(
          target,
          "square",
          midiToFrequency(note.midi),
          at,
          duration,
          0.05 * v,
          0.012,
          0.12,
          2600,
        );
        break;
      case "bell": {
        const f = midiToFrequency(note.midi);
        this.osc(target, "sine", f, at, Math.max(duration, 0.6), 0.09 * v, 0.006, 0.6);
        this.osc(target, "sine", f * 2.01, at, 0.35, 0.025 * v, 0.004, 0.25);
        break;
      }
      case "pluck":
        this.osc(
          target,
          "triangle",
          midiToFrequency(note.midi),
          at,
          Math.min(duration, 0.3),
          0.07 * v,
          0.004,
          0.2,
          3200,
        );
        break;
      case "kick": {
        const osc = ctx.createOscillator();
        const env = ctx.createGain();
        osc.frequency.setValueAtTime(140, at);
        osc.frequency.exponentialRampToValueAtTime(42, at + 0.16);
        env.gain.setValueAtTime(0.0001, at);
        env.gain.exponentialRampToValueAtTime(0.32 * v, at + 0.005);
        env.gain.exponentialRampToValueAtTime(0.0001, at + 0.2);
        this.play(osc, env, target, at, at + 0.22);
        break;
      }
      case "snare":
        this.noiseHit(target, at, 0.13, 0.16 * v, 1900, "bandpass");
        this.osc(target, "triangle", 190, at, 0.07, 0.07 * v, 0.002, 0.05);
        break;
      case "hat":
        this.noiseHit(target, at, 0.035, 0.07 * v, 7200, "highpass");
        break;
    }
  }

  private osc(
    target: AudioNode,
    type: OscillatorType,
    frequency: number,
    at: number,
    duration: number,
    volume: number,
    attack: number,
    release: number,
    cutoff?: number,
  ): void {
    const ctx = this.context;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, at);
    const peak = Math.max(0.0002, volume);
    const end = at + Math.max(duration, attack + 0.01);
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(peak, at + attack);
    env.gain.setValueAtTime(peak, Math.max(at + attack, end - release));
    env.gain.exponentialRampToValueAtTime(0.0001, end);
    if (cutoff) {
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = cutoff;
      osc.connect(filter);
      this.play(osc, env, target, at, end + 0.02, filter);
    } else this.play(osc, env, target, at, end + 0.02);
  }

  private noiseHit(
    target: AudioNode,
    at: number,
    duration: number,
    volume: number,
    frequency: number,
    type: BiquadFilterType,
  ): void {
    if (!this.noise) return;
    const ctx = this.context;
    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    const env = ctx.createGain();
    env.gain.setValueAtTime(Math.max(0.0002, volume), at);
    env.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    source.connect(filter);
    this.play(source, env, target, at, at + duration + 0.02, filter, Math.random() * 0.5);
  }

  /** Wires `source (-> filter) -> env -> target` and frees every node when the source ends. */
  private play(
    source: AudioScheduledSourceNode,
    env: GainNode,
    target: AudioNode,
    at: number,
    end: number,
    filter?: BiquadFilterNode,
    offset?: number,
  ): void {
    if (filter) filter.connect(env);
    else source.connect(env);
    env.connect(target);
    source.onended = () => {
      source.disconnect();
      filter?.disconnect();
      env.disconnect();
    };
    if (offset !== undefined) (source as AudioBufferSourceNode).start(at, offset);
    else source.start(at);
    source.stop(end);
  }

  destroy(): void {
    this.disposed = true;
    for (const gain of this.instances.values()) gain.disconnect();
    this.instances.clear();
    for (const [timer, gain] of this.fading) {
      clearTimeout(timer);
      gain.disconnect();
    }
    this.fading.clear();
    this.pauseGain.disconnect();
  }
}
