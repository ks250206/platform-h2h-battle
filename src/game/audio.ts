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

interface NoiseShape {
  /** Filter centre/cutoff at the end of the burst (exponential sweep). */
  endFrequency?: number;
  q?: number;
  /** Swell time before the decay; 0 starts at full volume like the original bursts. */
  attack?: number;
}

/** Small, synthesized sounds: no network assets and no autoplay before a gesture. */
export class BattleAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private enabled = true;
  private disposed = false;
  private readonly played = new Set<number>();
  private previousElapsed = 0;
  private previousFighters: Fighter[] | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private lastQuietSound = -1;
  private readonly swords = new Map<number, SwordMemory>();
  private currentVolume = -1;

  unlock(): void {
    if (this.disposed) return;
    if (!this.context) {
      const AudioContextClass =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) return;
      try {
        this.context = new AudioContextClass();
        this.master = this.context.createGain();
        this.master.gain.value = this.enabled ? 0.24 : 0;
        this.master.connect(this.context.destination);
        this.noiseBuffer = this.context.createBuffer(
          1,
          this.context.sampleRate,
          this.context.sampleRate,
        );
        const samples = this.noiseBuffer.getChannelData(0);
        for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
      } catch {
        // The game remains fully playable in browsers without audio support.
        this.context = null;
        this.master = null;
        return;
      }
    }
    if (this.context.state === "suspended") void this.context.resume().catch(() => {});
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) this.unlock();
    this.setVolume(enabled ? 0.24 : 0);
  }

  private setVolume(volume: number): void {
    if (!this.context || !this.master || this.currentVolume === volume) return;
    this.currentVolume = volume;
    this.master.gain.setTargetAtTime(volume, this.context.currentTime, 0.025);
  }

  update(state: GameState): void {
    if (this.disposed) return;
    if (state.elapsed < this.previousElapsed || state.fighters !== this.previousFighters) {
      this.played.clear();
      this.swords.clear();
    }
    this.previousElapsed = state.elapsed;
    this.previousFighters = state.fighters;
    const canPlay = this.enabled && state.phase !== "menu" && state.phase !== "paused";
    this.setVolume(canPlay ? 0.24 : 0);
    let soundsThisFrame = 0;
    for (const effect of state.effects) {
      if (this.played.has(effect.id)) continue;
      this.played.add(effect.id);
      if (!canPlay || !this.context || this.context.state !== "running" || soundsThisFrame >= 5)
        continue;
      if (state.phase === "ended" && effect.kind !== "ko") continue;
      this.play(effect.kind);
      soundsThisFrame++;
    }
    const swordsAudible =
      canPlay && !!this.context && this.context.state === "running" && state.phase !== "ended";
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
        if (!swordsAudible || soundsThisFrame >= 5) continue;
        this.playSword(cue);
        soundsThisFrame++;
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

  private tone(
    frequency: number,
    endFrequency: number,
    duration: number,
    volume: number,
    type: OscillatorType = "sine",
    delay = 0,
    attack = 0.005,
  ): void {
    if (!this.context || !this.master) return;
    const start = this.context.currentTime + delay;
    const oscillator = this.context.createOscillator();
    const envelope = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), start + duration);
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume), start + attack);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(envelope);
    envelope.connect(this.master);
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
  ): void {
    if (!this.context || !this.master || !this.noiseBuffer) return;
    const now = this.context.currentTime;
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
    if (shape.attack) {
      envelope.gain.setValueAtTime(0.0001, now);
      envelope.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume), now + shape.attack);
    } else envelope.gain.setValueAtTime(volume, now);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    source.connect(filter);
    filter.connect(envelope);
    envelope.connect(this.master);
    source.onended = () => {
      source.disconnect();
      filter.disconnect();
      envelope.disconnect();
    };
    source.start(now, Math.random() * 0.5);
    source.stop(now + duration + 0.01);
  }

  private play(kind: EffectKind): void {
    const now = this.context?.currentTime ?? 0;
    if (["step", "land", "jump"].includes(kind)) {
      if (now - this.lastQuietSound < 0.05) return;
      this.lastQuietSound = now;
    }
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
        this.tone(620, 400, 0.3, 0.09, "sine", 0.09);
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
    this.master?.disconnect();
    if (this.context) void this.context.close().catch(() => {});
    this.context = null;
    this.master = null;
    this.noiseBuffer = null;
  }
}
