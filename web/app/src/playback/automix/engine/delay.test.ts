// BitChord, Automix 2.0 Phase 3 Task 2: the delay gesture's CI harness.
//
// No browser in CI, so this renders the REAL DeckDelay code against a small
// simulated Web Audio engine: nodes are the real classes' constructors (the
// globals are stubbed), connections are real, parameters automate per
// sample, and the feedback loop (delay -> lowpass -> feedback -> delay) is
// evaluated sample-accurately. The click-track fixture goes through the
// engaged delay and the render must land every repeat ON the beat grid
// within one render quantum (128 samples), and the outgoing wet must be
// silent from the close instant (the handover instant) on.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { DeckDelay } from './loopDeck';

const SR = 44100;
const BEAT_SEC = 0.5; // 120 BPM
const RENDER_QUANTUM = 128;

// ---- The simulated Web Audio engine -------------------------------------------------------

type MockNode = {
  inputs: MockNode[];
  cache: Map<number, number>;
  process: (n: number) => number;
};

class MockParam {
  private events: { type: 'set' | 'ramp'; time: number; value: number }[] = [];
  constructor(public initial: number) {}
  setValueAtTime(value: number, time: number): void {
    this.events.push({ type: 'set', time, value });
  }
  linearRampToValueAtTime(value: number, time: number): void {
    this.events.push({ type: 'ramp', time, value });
  }
  cancelScheduledValues(cancelTime: number): void {
    this.events = this.events.filter((e) => e.time < cancelTime);
  }
  /** The automated value at [tSec], holds and linear ramps, per sample. */
  valueAt(tSec: number): number {
    const sorted = [...this.events].sort((a, b) => a.time - b.time);
    let v = this.initial;
    let prevTime = 0;
    for (const ev of sorted) {
      if (ev.time > tSec) {
        if (ev.type === 'ramp') {
          const span = ev.time - prevTime;
          const frac = span > 0 ? Math.min(1, Math.max(0, (tSec - prevTime) / span)) : 1;
          return v + (ev.value - v) * frac;
        }
        break;
      }
      v = ev.value;
      prevTime = ev.time;
    }
    return v;
  }
}

class MockContext {
  readonly sampleRate = SR;
  get currentTime(): number {
    return 0; // offline: everything is scheduled from zero
  }
  /** Every node this context created, in creation order â€” the render walks this. */
  readonly nodes: MockNode[] = [];
  readonly destination: MockGainNode;

  constructor() {
    this.destination = new MockGainNode(this, { gain: 1 });
  }

  createGain(): MockGainNode {
    return new MockGainNode(this, { gain: 1 });
  }
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): MockAudioBuffer {
    return new MockAudioBuffer(numberOfChannels, length, sampleRate);
  }
  createBufferSource(): MockBufferSource {
    return new MockBufferSource(this);
  }
}

class MockAudioBuffer {
  private channels: Float32Array[];
  constructor(numberOfChannels: number, public length: number, public sampleRate: number) {
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  getChannelData(channel: number): Float32Array {
    return this.channels[channel]!;
  }
}

class MockBufferSource implements MockNode {
  inputs: MockNode[] = [];
  cache = new Map<number, number>();
  buffer: MockAudioBuffer | null = null;
  private startAt = Infinity;
  constructor(ctx: MockContext) {
    ctx.nodes.push(this);
  }
  connect(target: MockNode): MockNode {
    target.inputs.push(this);
    return target;
  }
  start(when: number): void {
    this.startAt = Math.round(when * SR);
  }
  process(n: number): number {
    if (n < this.startAt || !this.buffer) return 0;
    const idx = n - this.startAt;
    const data = this.buffer.getChannelData(0);
    return idx >= 0 && idx < data.length ? data[idx]! : 0;
  }
}

class MockGainNode implements MockNode {
  inputs: MockNode[] = [];
  cache = new Map<number, number>();
  readonly gain: MockParam;
  constructor(public ctx: MockContext, options: { gain: number }) {
    this.gain = new MockParam(options.gain);
    ctx.nodes.push(this);
  }
  connect(target: MockNode): MockNode {
    target.inputs.push(this);
    return target;
  }
  disconnect(): void {
    // WebAudio semantics: cut every outgoing connection of this node
    for (const node of this.ctx.nodes) node.inputs = node.inputs.filter((i) => i !== this);
  }
  process(n: number): number {
    let x = 0;
    for (const inp of this.inputs) x += evalNode(inp, n);
    return x * this.gain.valueAt(n / SR);
  }
}

class MockBiquadFilterNode implements MockNode {
  inputs: MockNode[] = [];
  cache = new Map<number, number>();
  readonly frequency: MockParam;
  readonly type = 'lowpass';
  // RBJ lowpass coefficients (fixed frequency) + transposed direct form II state
  private b0 = 0;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private z1 = 0;
  private z2 = 0;
  constructor(
    public ctx: MockContext,
    options: { type: string; frequency: number; Q: number },
  ) {
    this.frequency = new MockParam(options.frequency);
    this.setCoefficients(options.frequency, options.Q);
    ctx.nodes.push(this);
  }
  private setCoefficients(f0: number, q: number): void {
    const w0 = (2 * Math.PI * f0) / SR;
    const alpha = Math.sin(w0) / (2 * q);
    const cos = Math.cos(w0);
    const a0 = 1 + alpha;
    this.b0 = ((1 - cos) / 2) / a0;
    this.b1 = (1 - cos) / a0;
    this.b2 = ((1 - cos) / 2) / a0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }
  connect(target: MockNode): MockNode {
    target.inputs.push(this);
    return target;
  }
  disconnect(): void {
    for (const node of this.ctx.nodes) node.inputs = node.inputs.filter((i) => i !== this);
  }
  reset(): void {
    this.z1 = 0;
    this.z2 = 0;
  }
  process(n: number): number {
    let x = 0;
    for (const inp of this.inputs) x += evalNode(inp, n);
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

class MockDelayNode implements MockNode {
  inputs: MockNode[] = [];
  cache = new Map<number, number>();
  readonly delayTime: MockParam;
  private readonly maxDelaySec: number;
  private buffer: Float64Array = new Float64Array(0);
  constructor(public ctx: MockContext, options: { maxDelayTime: number }) {
    this.delayTime = new MockParam(0);
    this.maxDelaySec = options.maxDelayTime;
    ctx.nodes.push(this);
  }
  connect(target: MockNode): MockNode {
    target.inputs.push(this);
    return target;
  }
  disconnect(): void {
    for (const node of this.ctx.nodes) node.inputs = node.inputs.filter((i) => i !== this);
  }
  process(n: number): number {
    const delaySamples = Math.round(this.delayTime.valueAt(n / SR) * SR);
    const delayed = n - delaySamples >= 0 ? this.buffer[n - delaySamples]! : 0;
    // the value is available to the feedback loop before its input is summed:
    // WebAudio sums this node's inputs (source + feedback) and writes them one
    // delay time ahead
    this.cache.set(n, delayed);
    let x = 0;
    for (const inp of this.inputs) x += evalNode(inp, n);
    const writeAt = n + delaySamples;
    if (writeAt < this.buffer.length) this.buffer[writeAt] = (this.buffer[writeAt] ?? 0) + x;
    return delayed;
  }
  prepare(samples: number): void {
    this.buffer = new Float64Array(samples + Math.ceil(this.maxDelaySec * SR) + 2);
  }
}

function evalNode(node: MockNode, n: number): number {
  const cached = node.cache.get(n);
  if (cached !== undefined) return cached;
  const v = node.process(n);
  node.cache.set(n, v);
  return v;
}

/** Renders [seconds] of the graph the context holds, sample-accurately. */
function render(ctx: MockContext, seconds: number): Float32Array {
  const length = Math.ceil(seconds * SR);
  for (const node of ctx.nodes) {
    node.cache.clear();
    if ('reset' in node) (node as MockBiquadFilterNode).reset();
    if (node instanceof MockDelayNode) node.prepare(length);
  }
  const out = new Float32Array(length);
  for (let n = 0; n < length; n++) {
    let v = 0;
    for (const inp of ctx.destination.inputs) v += evalNode(inp, n);
    out[n] = v;
  }
  return out;
}

// ---- The globals DeckDelay's constructors resolve to --------------------------------------

let ctx: MockContext;

beforeEach(() => {
  ctx = new MockContext();
  vi.stubGlobal('AudioContext', MockContext);
  vi.stubGlobal('GainNode', MockGainNode);
  vi.stubGlobal('DelayNode', MockDelayNode);
  vi.stubGlobal('BiquadFilterNode', MockBiquadFilterNode);
  vi.stubGlobal('AudioBuffer', MockAudioBuffer);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---- Fixtures -----------------------------------------------------------------------------

/** A click track: a half-cycle 500 Hz burst on every beat of the grid. */
function clickTrack(beats: number): MockAudioBuffer {
  const buffer = ctx.createBuffer(1, Math.ceil(beats * BEAT_SEC * SR) + SR, SR);
  const data = buffer.getChannelData(0);
  const clickLen = 45; // ~1 ms â€” content under the 2.5 kHz feedback low-pass
  for (let b = 0; b < beats; b++) {
    const at = Math.round(b * BEAT_SEC * SR);
    for (let i = 0; i < clickLen; i++) data[at + i] = Math.sin((Math.PI * i) / clickLen);
  }
  return buffer;
}

/** Local maxima above [threshold], as seconds. */
function peaksOf(out: Float32Array, threshold: number): number[] {
  const peaks: number[] = [];
  for (let n = 1; n < out.length - 1; n++) {
    if (out[n]! > threshold && out[n]! >= out[n - 1]! && out[n]! > out[n + 1]!) peaks.push(n / SR);
  }
  return peaks;
}

// ---- The harness --------------------------------------------------------------------------

describe('DeckDelay â€” beat-synced delay gesture', () => {
  it('throws a click track so every repeat lands ON the beat grid within one render quantum', () => {
    const source = ctx.createBufferSource();
    source.buffer = clickTrack(5);
    source.start(0);
    const driver = ctx.createGain();
    source.connect(driver);
    const delay = new DeckDelay(ctx as unknown as AudioContext, ctx.destination as unknown as AudioNode);
    driver.connect(delay.input as unknown as MockNode);
    // engaged across the whole fixture: one beat of the outgoing grid
    delay.engage(BEAT_SEC, 0, 3.2);

    const out = render(ctx, 4);
    const peaks = peaksOf(out, 0.2);
    expect(peaks.length).toBeGreaterThanOrEqual(5);

    const quantumSec = RENDER_QUANTUM / SR;
    for (const t of peaks) {
      const nearestBeat = Math.round(t / BEAT_SEC) * BEAT_SEC;
      expect(Math.abs(t - nearestBeat), `peak at ${t.toFixed(4)}s off the beat grid`).toBeLessThanOrEqual(quantumSec);
    }
    // the throw must actually span repeats: energy past the last source click
    const tailPeaks = peaks.filter((t) => t > 2.05);
    expect(tailPeaks.length, 'no repeats survived the last click').toBeGreaterThan(0);
  });

  it('the outgoing wet is silent from the close instant (the handover instant) on', () => {
    const source = ctx.createBufferSource();
    source.buffer = clickTrack(5);
    source.start(0);
    const driver = ctx.createGain();
    source.connect(driver);
    const delay = new DeckDelay(ctx as unknown as AudioContext, ctx.destination as unknown as AudioNode);
    driver.connect(delay.input as unknown as MockNode);
    const closeAt = 2.0;
    delay.engage(BEAT_SEC, 0, closeAt);

    const out = render(ctx, 3);
    let audible = 0;
    for (const v of out) if (Math.abs(v) > 0.01) audible++;
    expect(audible, 'the wet never opened').toBeGreaterThan(0);

    const closeSample = Math.round(closeAt * SR);
    for (let n = closeSample; n < out.length; n++) {
      expect(Math.abs(out[n]!), `wet survived past the handover at sample ${n}`).toBe(0);
    }
  });

  it('refuses a corrupt beat instead of engaging', () => {
    const source = ctx.createBufferSource();
    source.buffer = clickTrack(5);
    source.start(0);
    const driver = ctx.createGain();
    source.connect(driver);
    const delay = new DeckDelay(ctx as unknown as AudioContext, ctx.destination as unknown as AudioNode);
    driver.connect(delay.input as unknown as MockNode);
    delay.engage(2.5, 0, 3.2); // past the 2 s ceiling: a refused order

    const out = render(ctx, 4);
    for (const v of out) expect(v).toBe(0);
  });
});
