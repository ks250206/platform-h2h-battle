// A tiny stand-in for the WebAudio API, enough to drive BattleAudio and BgmPlayer in node. Gains
// jump straight to their targets, so a test can read the level a bus is heading for.

class FakeParam {
  constructor(public value = 1) {}
  setValueAtTime(value: number) {
    this.value = value;
    return this;
  }
  setTargetAtTime(value: number) {
    this.value = value;
    return this;
  }
  linearRampToValueAtTime(value: number) {
    this.value = value;
    return this;
  }
  exponentialRampToValueAtTime(value: number) {
    this.value = value;
    return this;
  }
  cancelScheduledValues() {
    return this;
  }
}

class FakeNode {
  readonly outputs = new Set<FakeNode>();
  constructor(readonly ctx: FakeAudioContext) {}
  connect(target: FakeNode) {
    this.outputs.add(target);
    return target;
  }
  disconnect() {
    this.outputs.clear();
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam(1);
}

class FakeSource extends FakeNode {
  onended: (() => void) | null = null;
  startedAt = -1;
  stoppedAt = -1;
  start(at = 0) {
    this.startedAt = at;
    this.ctx.started.push(this);
  }
  stop(at = 0) {
    this.stoppedAt = at;
  }
}

class FakeOscillator extends FakeSource {
  type = "sine";
  frequency = new FakeParam(440);
}

class FakeBufferSource extends FakeSource {
  buffer: unknown = null;
}

class FakeFilter extends FakeNode {
  type = "lowpass";
  frequency = new FakeParam(350);
  Q = new FakeParam(1);
}

class FakeCompressor extends FakeNode {
  threshold = new FakeParam(-24);
  knee = new FakeParam(30);
  ratio = new FakeParam(12);
  attack = new FakeParam(0.003);
  release = new FakeParam(0.25);
}

export class FakeAudioContext {
  static created: FakeAudioContext[] = [];
  /** What the next context reports: a blocked autoplay keeps it suspended. */
  static initialState: AudioContextState = "running";
  state: AudioContextState = FakeAudioContext.initialState;
  currentTime = 0;
  sampleRate = 8000;
  readonly destination = new FakeNode(this);
  readonly started: FakeSource[] = [];
  resumeCalls = 0;

  constructor() {
    FakeAudioContext.created.push(this);
  }
  createGain() {
    return new FakeGain(this);
  }
  createOscillator() {
    return new FakeOscillator(this);
  }
  createBufferSource() {
    return new FakeBufferSource(this);
  }
  createBiquadFilter() {
    return new FakeFilter(this);
  }
  createDynamicsCompressor() {
    return new FakeCompressor(this);
  }
  createBuffer(_channels: number, length: number) {
    const data = new Float32Array(length);
    return { getChannelData: () => data };
  }
  resume() {
    this.resumeCalls++;
    return Promise.resolve();
  }
  close() {
    this.state = "closed";
    return Promise.resolve();
  }
  /** Sources started since `mark`. */
  startedSince(mark: number) {
    return this.started.length - mark;
  }
}

/** Installs the fake as `window.AudioContext` for the duration of a test file. */
export function installFakeAudio(): void {
  (globalThis as unknown as { window: unknown }).window = { AudioContext: FakeAudioContext };
}

export function uninstallFakeAudio(): void {
  delete (globalThis as unknown as { window?: unknown }).window;
  FakeAudioContext.created = [];
  FakeAudioContext.initialState = "running";
}
