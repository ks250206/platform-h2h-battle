import type { EffectKind, Fighter, GameState } from "./types";

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
    if (state.elapsed < this.previousElapsed || state.fighters !== this.previousFighters)
      this.played.clear();
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
  ): void {
    if (!this.context || !this.master) return;
    const start = this.context.currentTime + delay;
    const oscillator = this.context.createOscillator();
    const envelope = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), start + duration);
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume), start + 0.005);
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
  ): void {
    if (!this.context || !this.master || !this.noiseBuffer) return;
    const now = this.context.currentTime;
    const source = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const envelope = this.context.createGain();
    source.buffer = this.noiseBuffer;
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = 0.6;
    envelope.gain.setValueAtTime(volume, now);
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

  destroy(): void {
    this.disposed = true;
    this.played.clear();
    this.master?.disconnect();
    if (this.context) void this.context.close().catch(() => {});
    this.context = null;
    this.master = null;
    this.noiseBuffer = null;
  }
}
