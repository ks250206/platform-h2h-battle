import { BgmPlayer, midiToFrequency } from "./bgm";
import { musicCue, type FinishKind, type PresentationEvent } from "./presentation";
import type { AttackId, EffectKind, Fighter, FighterMode, GameState } from "./types";

/** What the audio layer remembers about a fighter between rendered frames. */
export interface SwordMemory {
  mode: FighterMode;
  attack: AttackId | null;
  swingId: number;
  /** `state.elapsed` of the last charge-hum tick (only meaningful while charging). */
  lastHumAt: number;
}

/** The fighter fields the sword cues depend on. */
export type SwordFighter = Pick<
  Fighter,
  "mode" | "attack" | "charge" | "grounded" | "swingId" | "human"
>;

export type SwordCue =
  /** Blade starts moving: `power` scales loudness (grows with charge), `depth` scales pitch (falls with charge). */
  | { kind: "whoosh"; attack: AttackId; power: number; depth: number; voice: number }
  /** Grounded overhead buries itself in the floor. */
  | { kind: "slam"; power: number; voice: number }
  /** Quiet grunt of effort when an attack is committed. */
  | { kind: "heave"; voice: number }
  /** Periodic tick while charging; pitch follows `charge` (0..1). */
  | { kind: "hum"; charge: number; voice: number };

export const CHARGE_HUM_INTERVAL = 0.22;

/** CPU fighters sit a little behind the human in the mix. */
function voiceFor(fighter: SwordFighter): number {
  return fighter.human ? 1 : 0.6;
}

/**
 * Pure decision of which sword sounds a fighter should trigger this frame, from its
 * remembered previous state. `now` is `state.elapsed`. No cues the first time a fighter is seen.
 */
export function swordCues(
  previous: SwordMemory | undefined,
  fighter: SwordFighter,
  now: number,
): SwordCue[] {
  if (!previous || fighter.mode === "dead") return [];
  const cues: SwordCue[] = [];
  const voice = voiceFor(fighter);
  const charge = Math.min(1, Math.max(0, fighter.charge));
  // A short active window can fall between two rendered frames (windup -> recovery).
  const skippedActive = previous.mode === "windup" && fighter.mode === "recovery";
  const enteredActive =
    (fighter.mode === "active" &&
      (previous.mode !== "active" || previous.swingId !== fighter.swingId)) ||
    skippedActive;
  if (fighter.mode === "windup" && previous.mode !== "windup") cues.push({ kind: "heave", voice });
  if (enteredActive && fighter.attack)
    cues.push({
      kind: "whoosh",
      attack: fighter.attack,
      power: 0.7 + 0.5 * charge,
      depth: 1 - 0.18 * charge,
      voice,
    });
  if (
    (previous.mode === "active" || skippedActive) &&
    fighter.mode === "recovery" &&
    (fighter.attack ?? previous.attack) === "overhead" &&
    fighter.grounded
  )
    cues.push({ kind: "slam", power: 0.8 + 0.3 * charge, voice });
  if (
    fighter.mode === "charge" &&
    (previous.mode !== "charge" || now - previous.lastHumAt >= CHARGE_HUM_INTERVAL)
  )
    cues.push({ kind: "hum", charge, voice });
  return cues;
}

// ---------------------------------------------------------------------------------------------
// Mix: buses, levels and voice limits. Pure parts are exported for tests.
// ---------------------------------------------------------------------------------------------

/** What the player chose for the sound (persisted with the other settings). */
export interface AudioMix {
  bgmVolume: number;
  seVolume: number;
  muted: boolean;
}

export const DEFAULT_MIX: Readonly<AudioMix> = Object.freeze({
  bgmVolume: 0.6,
  seVolume: 0.8,
  muted: false,
});

/** Sound effects at full slider; the default 0.8 matches the original 0.24 master. */
export const SFX_LEVEL = 0.3;
/** Music at full slider: always under the effects, which carry the gameplay. */
export const MUSIC_LEVEL = 0.34;

const unit = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

/**
 * Bus gains for a mix. Music and effects are independent (either at 0 leaves the other as it
 * was); mute closes the master and silences both.
 */
export function mixGains(mix: AudioMix): { master: number; music: number; sfx: number } {
  return {
    master: mix.muted ? 0 : 1,
    music: MUSIC_LEVEL * unit(mix.bgmVolume),
    sfx: SFX_LEVEL * unit(mix.seVolume),
  };
}

/**
 * Effects are gated (not the music) on the title and while paused: nothing new starts there, and
 * a sound already ringing is cut short rather than heard over a pause screen.
 */
export const effectsOpen = (phase: GameState["phase"]): boolean =>
  phase !== "menu" && phase !== "paused";

/**
 * - `quiet`: footsteps, jumps, landings.
 * - `impact`: hits, clashes, throws, cancels and every sword sound but the charge hum.
 * - `cue`: what the player must never miss: the charge hum, warnings (bombs, collapse, zone),
 *   KOs, the climax and the finish. Cues skip the impact compressor and have their own budget, so
 *   a pile of four-player hits can neither pump them down nor use up their voices.
 */
export type VoiceCategory = "quiet" | "impact" | "cue";

export const VOICE_LIMITS: Readonly<
  Record<VoiceCategory, { concurrent: number; perFrame: number; minGap: number }>
> = {
  quiet: { concurrent: 3, perFrame: 2, minGap: 0.05 },
  impact: { concurrent: 8, perFrame: 4, minGap: 0 },
  cue: { concurrent: 12, perFrame: 6, minGap: 0 },
};

const EFFECT_CATEGORY: Record<EffectKind, VoiceCategory> = {
  step: "quiet",
  jump: "quiet",
  land: "quiet",
  ukemi: "quiet",
  hit: "impact",
  clash: "impact",
  throw: "impact",
  cancel: "impact",
  bomb: "cue",
  charge: "cue",
  ko: "cue",
};
export const effectCategory = (kind: EffectKind): VoiceCategory => EFFECT_CATEGORY[kind];
export const swordCategory = (cue: SwordCue): VoiceCategory =>
  cue.kind === "hum" ? "cue" : "impact";

/**
 * Loudness of the n-th (0-based) sound of one category started in the same frame: four hits
 * landing together sum to about twice one hit, not four times.
 */
export const stackGain = (index: number): number => 1 / Math.sqrt(1 + 1.5 * index);

/** Counts voices per category on the audio clock and refuses those over the limits. */
export class VoiceLimiter {
  private readonly ends: Record<VoiceCategory, number[]> = { quiet: [], impact: [], cue: [] };
  private readonly frame: Record<VoiceCategory, number> = { quiet: 0, impact: 0, cue: 0 };
  private readonly last: Record<VoiceCategory, number> = {
    quiet: -Infinity,
    impact: -Infinity,
    cue: -Infinity,
  };

  beginFrame(): void {
    this.frame.quiet = this.frame.impact = this.frame.cue = 0;
  }

  active(category: VoiceCategory, now: number): number {
    const ends = this.ends[category];
    for (let i = ends.length - 1; i >= 0; i--) if (ends[i]! <= now) ends.splice(i, 1);
    return ends.length;
  }

  /** The loudness factor for a granted voice, or null when it must be dropped. */
  acquire(category: VoiceCategory, now: number, duration: number): number | null {
    const limit = VOICE_LIMITS[category];
    if (this.frame[category] >= limit.perFrame) return null;
    if (now - this.last[category] < limit.minGap) return null;
    if (this.active(category, now) >= limit.concurrent) return null;
    const gain = stackGain(this.frame[category]);
    this.frame[category]++;
    this.last[category] = now;
    this.ends[category].push(now + duration);
    return gain;
  }
}

/** How long each effect sound rings, for the voice count. */
const EFFECT_LENGTH: Record<EffectKind, number> = {
  hit: 0.18,
  clash: 0.22,
  step: 0.1,
  jump: 0.12,
  land: 0.08,
  ukemi: 0.1,
  ko: 0.5,
  bomb: 0.48,
  cancel: 0.085,
  throw: 0.18,
  charge: 0.12,
};

/** How long each presentation cue rings (stingers included), for the voice count. */
export function eventLength(event: PresentationEvent): number {
  switch (event.kind) {
    case "finish":
      return event.finish === "ladderClear" ? 2.6 : event.finish === "setWin" ? 2.1 : 1.6;
    case "elimination":
      return 0.9;
    case "stockKo":
      return 0.6;
    case "climax":
      return 1.3;
    default:
      return 0.4;
  }
}

/** Events that belong to a real match only: never sounded in practice. */
const MATCH_ONLY = new Set<PresentationEvent["kind"]>(["finish", "climax", "elimination"]);

interface NoiseShape {
  /** Filter centre/cutoff at the end of the burst (exponential sweep). */
  endFrequency?: number;
  q?: number;
  /** Swell time before the decay; 0 starts at full volume like the original bursts. */
  attack?: number;
}

type Buses = {
  master: GainNode;
  limiter: DynamicsCompressorNode;
  music: GainNode;
  sfx: GainNode;
  gate: GainNode;
  impact: GainNode;
  cue: GainNode;
};

const note = (name: number) => midiToFrequency(name);

/**
 * Small, synthesized sounds and music: no network assets and no autoplay before a gesture. A
 * suspended or missing AudioContext only means silence; the game never waits for it.
 *
 * Graph: impact voices -> impact compressor -> effects bus; cue voices -> effects bus (direct);
 * effects bus -> pause gate -> master; music (BgmPlayer) -> music bus -> master;
 * master (mute) -> limiter -> speakers.
 */
export class BattleAudio {
  private context: AudioContext | null = null;
  private buses: Buses | null = null;
  private bgm: BgmPlayer | null = null;
  private mix: AudioMix = { ...DEFAULT_MIX };
  private disposed = false;
  private readonly played = new Set<number>();
  private previousElapsed = 0;
  private previousFighters: Fighter[] | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private readonly swords = new Map<number, SwordMemory>();
  private readonly limiter = new VoiceLimiter();
  private gateOpen = true;
  /** Where the next tone/noise goes and how loud, set by the sound being played. */
  private target: AudioNode | null = null;
  private scale = 1;

  unlock(): void {
    if (this.disposed) return;
    if (!this.context) {
      const AudioContextClass =
        typeof window === "undefined"
          ? undefined
          : (window.AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
      if (!AudioContextClass) return;
      try {
        this.context = new AudioContextClass();
        this.buses = this.createBuses(this.context);
        this.noiseBuffer = this.context.createBuffer(
          1,
          this.context.sampleRate,
          this.context.sampleRate,
        );
        const samples = this.noiseBuffer.getChannelData(0);
        for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
        this.bgm = new BgmPlayer(this.context, this.buses.music, this.noiseBuffer);
        this.applyMix(true);
      } catch {
        // The game remains fully playable in browsers without audio support.
        this.context = null;
        this.buses = null;
        this.bgm = null;
        return;
      }
    }
    if (this.context.state === "suspended") void this.context.resume().catch(() => {});
  }

  private createBuses(ctx: AudioContext): Buses {
    const master = ctx.createGain();
    // A brick-wall-ish limiter: whatever piles up, the output never clips.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -4;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
    master.connect(limiter);
    limiter.connect(ctx.destination);
    const music = ctx.createGain();
    music.connect(master);
    const gate = ctx.createGain();
    gate.connect(master);
    const sfx = ctx.createGain();
    sfx.connect(gate);
    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -20;
    glue.knee.value = 8;
    glue.ratio.value = 5;
    glue.attack.value = 0.003;
    glue.release.value = 0.12;
    glue.connect(sfx);
    const impact = ctx.createGain();
    impact.connect(glue);
    const cue = ctx.createGain();
    cue.gain.value = 1.1;
    cue.connect(sfx);
    return { master, limiter, music, sfx, gate, impact, cue };
  }

  /** The mix from the settings: music and effect volumes and the master mute. */
  setMix(mix: AudioMix): void {
    // Never creates the context itself: that waits for a gesture (`unlock`), so applying the
    // stored settings at boot cannot trip the browser's autoplay policy.
    this.mix = { bgmVolume: mix.bgmVolume, seVolume: mix.seVolume, muted: mix.muted };
    this.applyMix(false);
  }

  get currentMix(): Readonly<AudioMix> {
    return this.mix;
  }

  /** The music player once audio is unlocked (tooling and tests). */
  get music(): BgmPlayer | null {
    return this.bgm;
  }

  /** The effect and music bus gains once audio is unlocked (tooling and tests). */
  get busGains(): { master: number; music: number; sfx: number; gate: number } | null {
    if (!this.buses) return null;
    const { master, music, sfx, gate } = this.buses;
    return {
      master: master.gain.value,
      music: music.gain.value,
      sfx: sfx.gain.value,
      gate: gate.gain.value,
    };
  }

  /** Kept for callers of the old on/off switch: it is the master mute. */
  setEnabled(enabled: boolean): void {
    this.setMix({ ...this.mix, muted: !enabled });
  }

  private applyMix(immediate: boolean): void {
    if (!this.context || !this.buses) return;
    const gains = mixGains(this.mix);
    const now = this.context.currentTime;
    for (const [node, value] of [
      [this.buses.master, gains.master],
      [this.buses.music, gains.music],
      [this.buses.sfx, gains.sfx],
    ] as const) {
      if (immediate) node.gain.value = value;
      else node.gain.setTargetAtTime(value, now, 0.03);
    }
  }

  private setGate(open: boolean): void {
    if (!this.context || !this.buses || open === this.gateOpen) return;
    this.gateOpen = open;
    this.buses.gate.gain.setTargetAtTime(open ? 1 : 0, this.context.currentTime, 0.025);
  }

  private get running(): boolean {
    return !!this.context && this.context.state === "running";
  }

  /**
   * Called once per rendered frame with the state and the presentation events the frame produced
   * (see PresentationTracker). Never throws and never blocks when audio is unavailable.
   */
  update(state: GameState, events: readonly PresentationEvent[] = [], tutorial = false): void {
    if (this.disposed) return;
    if (state.elapsed < this.previousElapsed || state.fighters !== this.previousFighters) {
      this.played.clear();
      this.swords.clear();
    }
    this.previousElapsed = state.elapsed;
    this.previousFighters = state.fighters;
    const running = this.running;
    this.bgm?.update(
      musicCue(state, tutorial),
      running && !this.mix.muted && this.mix.bgmVolume > 0,
    );
    const open = effectsOpen(state.phase);
    this.setGate(open);
    const effectsAudible = open && running && !this.mix.muted && this.mix.seVolume > 0;
    this.limiter.beginFrame();
    const now = this.context?.currentTime ?? 0;
    for (const event of events) {
      if (!effectsAudible) break;
      if ((state.mode === "training" || tutorial) && MATCH_ONLY.has(event.kind)) continue;
      const gain = this.limiter.acquire("cue", now, eventLength(event));
      if (gain === null) continue;
      this.route("cue", gain);
      this.playEvent(event);
    }
    for (const effect of state.effects) {
      if (this.played.has(effect.id)) continue;
      this.played.add(effect.id);
      // KOs and the finish are voiced from the presentation events, which know what they mean.
      if (!effectsAudible || state.phase === "ended") continue;
      if (effect.kind === "ko" || effect.kind === "ukemi") continue;
      const category = effectCategory(effect.kind);
      const gain = this.limiter.acquire(category, now, EFFECT_LENGTH[effect.kind]);
      if (gain === null) continue;
      this.route(category, gain);
      this.play(effect.kind);
    }
    const swordsAudible = effectsAudible && state.phase !== "ended";
    for (const fighter of state.fighters) {
      if (fighter.mode === "dead") {
        this.swords.delete(fighter.id);
        continue;
      }
      const previous = this.swords.get(fighter.id);
      const cues = swordCues(previous, fighter, state.elapsed);
      let lastHumAt = previous?.lastHumAt ?? state.elapsed;
      for (const cue of cues) {
        if (cue.kind === "hum") lastHumAt = state.elapsed;
        if (!swordsAudible) continue;
        const category = swordCategory(cue);
        const gain = this.limiter.acquire(category, now, cue.kind === "whoosh" ? 0.4 : 0.15);
        if (gain === null) continue;
        this.route(category, gain);
        this.playSword(cue);
      }
      this.swords.set(fighter.id, {
        mode: fighter.mode,
        attack: fighter.attack,
        swingId: fighter.swingId,
        lastHumAt,
      });
    }
    if (this.played.size > 512) {
      const liveIds = new Set(state.effects.map((effect) => effect.id));
      for (const id of this.played) if (!liveIds.has(id)) this.played.delete(id);
    }
  }

  private route(category: VoiceCategory, gain: number): void {
    this.target = this.buses ? (category === "cue" ? this.buses.cue : this.buses.impact) : null;
    this.scale = gain;
  }

  private tone(
    frequency: number,
    endFrequency: number,
    duration: number,
    volume: number,
    type: OscillatorType = "sine",
    delay = 0,
    attack = 0.005,
  ): void {
    if (!this.context || !this.target) return;
    const start = this.context.currentTime + delay;
    const oscillator = this.context.createOscillator();
    const envelope = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), start + duration);
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(
      Math.max(0.0001, volume * this.scale),
      start + attack,
    );
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(envelope);
    envelope.connect(this.target);
    oscillator.onended = () => {
      oscillator.disconnect();
      envelope.disconnect();
    };
    oscillator.start(start);
    oscillator.stop(start + duration + 0.01);
  }

  private noise(
    duration: number,
    volume: number,
    frequency: number,
    type: BiquadFilterType = "lowpass",
    shape: NoiseShape = {},
    delay = 0,
  ): void {
    if (!this.context || !this.target || !this.noiseBuffer) return;
    const now = this.context.currentTime + delay;
    const source = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const envelope = this.context.createGain();
    source.buffer = this.noiseBuffer;
    filter.type = type;
    filter.frequency.value = frequency;
    if (shape.endFrequency !== undefined) {
      filter.frequency.setValueAtTime(frequency, now);
      filter.frequency.exponentialRampToValueAtTime(
        Math.max(20, shape.endFrequency),
        now + duration,
      );
    }
    filter.Q.value = shape.q ?? 0.6;
    const peak = Math.max(0.0001, volume * this.scale);
    if (shape.attack) {
      envelope.gain.setValueAtTime(0.0001, now);
      envelope.gain.exponentialRampToValueAtTime(peak, now + shape.attack);
    } else envelope.gain.setValueAtTime(peak, now);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    source.connect(filter);
    filter.connect(envelope);
    envelope.connect(this.target);
    source.onended = () => {
      source.disconnect();
      filter.disconnect();
      envelope.disconnect();
    };
    source.start(now, Math.random() * 0.5);
    source.stop(now + duration + 0.01);
  }

  /** A short tune on the cue bus: `notes` as MIDI numbers, `gap` seconds apart from `delay`. */
  private arpeggio(
    notes: readonly number[],
    gap: number,
    length: number,
    volume: number,
    type: OscillatorType,
    delay = 0,
  ): void {
    notes.forEach((midi, i) => {
      const f = note(midi);
      this.tone(f, f, length, volume, type, delay + i * gap, 0.006);
    });
  }

  private chordHold(notes: readonly number[], length: number, volume: number, delay: number): void {
    for (const midi of notes) {
      const f = note(midi);
      this.tone(f, f * 1.002, length, volume, "triangle", delay, 0.02);
      this.tone(f * 2, f * 2, length * 0.7, volume * 0.25, "sine", delay, 0.01);
    }
  }

  private playEvent(event: PresentationEvent): void {
    switch (event.kind) {
      case "stockKo":
        // A life lost: the falling KO sweep, then a small two-note "down" chime.
        this.tone(320, 45, 0.5, 0.26, "triangle");
        this.noise(0.4, 0.28, 1200);
        this.tone(note(79), note(79), 0.14, 0.08, "sine", 0.12);
        this.tone(note(74), note(74), 0.22, 0.08, "sine", 0.24);
        this.bgm?.duckFor(0.6, 0.35);
        break;
      case "elimination":
        // Out for good while the match goes on: deeper and longer, a falling minor figure.
        this.tone(240, 32, 0.75, 0.32, "triangle");
        this.noise(0.55, 0.32, 1000, "lowpass", { endFrequency: 220 });
        this.arpeggio([76, 72, 69], 0.13, 0.2, 0.06, "square", 0.15);
        this.bgm?.duckFor(0.45, 0.6);
        break;
      case "trainingKo":
        this.tone(320, 60, 0.4, 0.14, "triangle");
        this.noise(0.3, 0.14, 1100);
        break;
      case "finish":
        this.finish(event.finish);
        break;
      case "climax":
        // A rising sweep into the faster loop.
        this.noise(1.1, 0.2, 380, "bandpass", { endFrequency: 3200, q: 1.4, attack: 0.95 });
        this.tone(196, 392, 1.1, 0.05, "sawtooth", 0, 0.9);
        this.tone(note(64), note(64), 0.25, 0.08, "triangle", 1.05);
        break;
      case "bombWarning":
        this.tone(1320, 1300, 0.08, 0.07, "sine");
        this.tone(1320, 1300, 0.08, 0.07, "sine", 0.13);
        break;
      case "collapseWarning":
        this.tone(330, 330, 0.16, 0.08, "square");
        this.tone(247, 247, 0.22, 0.08, "square", 0.18);
        break;
      case "zoneWarning":
        if (event.first) this.arpeggio([76, 80, 83], 0.09, 0.35, 0.07, "sine");
        else this.arpeggio([83, 88], 0.11, 0.3, 0.07, "sine");
        break;
      case "zoneDanger": {
        const f = 880 + 660 * event.urgency;
        this.tone(f, f, 0.06, 0.05 + 0.05 * event.urgency, "square");
        break;
      }
    }
  }

  /** The finish: one heavy impact, then a fanfare that says what was won. */
  private finish(kind: FinishKind): void {
    this.tone(190, 30, 0.95, 0.42, "triangle");
    this.noise(0.85, 0.42, 1700, "lowpass", { endFrequency: 180 });
    this.noise(0.6, 0.16, 5200, "highpass", { endFrequency: 2400 });
    this.bgm?.duckFor(0.2, 2.2);
    const at = 0.38;
    switch (kind) {
      case "win":
        this.arpeggio([72, 76, 79], 0.1, 0.16, 0.07, "square", at);
        this.chordHold([72, 76, 79, 84], 0.95, 0.05, at + 0.32);
        break;
      case "setWin":
        this.arpeggio([67, 72, 76, 79, 84], 0.08, 0.14, 0.07, "square", at);
        this.arpeggio([76, 79, 84, 88], 0.07, 0.14, 0.05, "square", at + 0.45);
        this.chordHold([67, 72, 76, 79, 84], 1.4, 0.05, at + 0.78);
        break;
      case "ladderClear":
        this.arpeggio([60, 64, 67, 72, 76, 79, 84], 0.075, 0.14, 0.065, "square", at);
        this.chordHold([65, 69, 72, 77], 0.55, 0.045, at + 0.6);
        this.chordHold([67, 72, 76, 79, 84], 1.6, 0.05, at + 1.15);
        this.arpeggio([96, 91, 88, 84], 0.12, 0.5, 0.025, "sine", at + 1.2);
        break;
      case "defeat":
        this.arpeggio([76, 72, 69], 0.2, 0.3, 0.06, "triangle", at);
        this.chordHold([57, 60, 64], 1.0, 0.045, at + 0.62);
        break;
      case "draw":
        this.arpeggio([69, 74, 76], 0.14, 0.22, 0.06, "triangle", at);
        this.chordHold([62, 67, 69], 1.0, 0.045, at + 0.45);
        break;
    }
  }

  private play(kind: EffectKind): void {
    switch (kind) {
      case "hit":
        this.tone(155, 49, 0.18, 0.6, "triangle");
        this.tone(420, 200, 0.075, 0.16);
        this.noise(0.11, 0.6, 1300);
        break;
      case "clash":
        this.tone(810, 760, 0.22, 0.25, "triangle");
        this.tone(1353, 1260, 0.18, 0.12);
        this.tone(260, 100, 0.13, 0.3);
        this.noise(0.065, 0.35, 3200, "highpass");
        break;
      case "step":
        this.noise(0.1, 0.24, 900, "bandpass");
        break;
      case "jump":
        this.tone(180, 380, 0.12, 0.1, "triangle");
        this.noise(0.065, 0.1, 1100);
        break;
      case "land":
        this.tone(105, 55, 0.08, 0.15, "triangle");
        this.noise(0.065, 0.18, 700);
        break;
      case "ko":
        this.tone(320, 45, 0.5, 0.26, "triangle");
        this.noise(0.4, 0.28, 1200);
        break;
      case "bomb":
        this.tone(95, 28, 0.48, 0.6, "triangle");
        this.noise(0.42, 0.65, 550);
        break;
      case "cancel":
        this.noise(0.085, 0.15, 1800, "bandpass");
        this.tone(340, 210, 0.065, 0.06);
        break;
      case "throw":
        this.tone(170, 70, 0.18, 0.32, "triangle");
        this.noise(0.15, 0.26, 800);
        break;
      case "charge":
        this.tone(250, 330, 0.12, 0.08);
        break;
    }
  }

  private playSword(cue: SwordCue): void {
    switch (cue.kind) {
      case "whoosh": {
        const v = cue.power * cue.voice;
        const d = cue.depth;
        switch (cue.attack) {
          case "overhead":
            // Long, deep, falling: the heaviest swing.
            this.noise(0.42, 0.55 * v, 950 * d, "bandpass", {
              endFrequency: 240 * d,
              q: 0.9,
              attack: 0.12,
            });
            this.tone(120 * d, 52 * d, 0.4, 0.07 * v, "sine", 0, 0.1);
            break;
          case "rising":
            this.noise(0.3, 0.48 * v, 320 * d, "bandpass", {
              endFrequency: 1150 * d,
              q: 0.9,
              attack: 0.09,
            });
            this.tone(70 * d, 135 * d, 0.28, 0.05 * v, "sine", 0, 0.08);
            break;
          case "sweep":
            // Broad (low Q) and a little longer than a plain swing.
            this.noise(0.38, 0.5 * v, 420 * d, "bandpass", {
              endFrequency: 780 * d,
              q: 0.4,
              attack: 0.13,
            });
            this.tone(95 * d, 70 * d, 0.36, 0.05 * v, "sine", 0, 0.1);
            break;
          case "thrust":
            this.noise(0.16, 0.45 * v, 1500 * d, "bandpass", {
              endFrequency: 650 * d,
              q: 1.3,
              attack: 0.03,
            });
            this.tone(170 * d, 95 * d, 0.13, 0.04 * v, "sine", 0, 0.02);
            break;
        }
        break;
      }
      case "slam": {
        const v = cue.power * cue.voice;
        this.tone(70, 35, 0.3, 0.55 * v);
        this.noise(0.2, 0.42 * v, 280);
        break;
      }
      case "heave":
        this.tone(105, 78, 0.12, 0.045 * cue.voice, "triangle", 0, 0.03);
        this.noise(0.1, 0.05 * cue.voice, 420, "lowpass", { attack: 0.03 });
        break;
      case "hum": {
        const frequency = 130 + 190 * cue.charge;
        this.tone(
          frequency,
          frequency * 1.08,
          0.12,
          (0.025 + 0.02 * cue.charge) * cue.voice,
          "sine",
          0,
          0.02,
        );
        break;
      }
    }
  }

  destroy(): void {
    this.disposed = true;
    this.played.clear();
    this.swords.clear();
    this.bgm?.destroy();
    this.buses?.master.disconnect();
    if (this.context) void this.context.close().catch(() => {});
    this.context = null;
    this.buses = null;
    this.bgm = null;
    this.target = null;
    this.noiseBuffer = null;
  }
}
