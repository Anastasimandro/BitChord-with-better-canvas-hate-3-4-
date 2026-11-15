// Adapted from AutoMix's src/lib/engine/deck.ts (https://github.com/heydavidf/automix),
// Copyright (C) 2026 David Finnegan. AGPL-3.0-only: see ../LICENSE and ../NOTICE.md.
//
// BitChord: AutoMix's own deck (signalsmith-stretch over decoded audio), used
// for the loop mix only. It plays a decoded region of a track, so it can loop
// whole bars sample-accurately and change tempo with the pitch kept, over any
// ratio, which an <audio> element can't.
import SignalsmithStretch, { type SignalsmithStretchNode } from 'signalsmith-stretch';
import { ThreeBandEQ } from './eq';
import { Scheduler, createLoopDeckDispatcher } from './scheduler';

/** One scheduled change, in the track's own seconds (not the region's). */
export interface LoopChange {
  output: number;
  input: number;
  rate: number;
  active: boolean;
  /** Track seconds; null for no loop. */
  loop: [number, number] | null;
}

/**
 * The worklet keeps only one pending future change (each schedule() prunes
 * everything after "now"), so changes wait here and go out just before
 * their time, as in AutoMix's Deck. Beats are at least 0.33 s apart at
 * 180 BPM; this is comfortably under that.
 */
const POST_AHEAD_SEC = 0.25;

/**
 * Phase 3 Task 2: the delay gesture's render graph — one throw of the deck's
 * tail into a beat-synced echo. The delay time is one beat of the outgoing
 * grid at the deck's effective playback rate, so every repeat lands on the
 * beat; a 0.35 feedback through a 2.5 kHz low-pass darkens each repeat until
 * the tail dissolves. The dry path never passes through it: the deck keeps
 * its own chain and taps it here. Nodes live in the deck's context, connect
 * to the destination on engagement and release on teardown — no module-level
 * audio node state, no leaks.
 */
export const DELAY_FEEDBACK = 0.35;
export const DELAY_FEEDBACK_LOWPASS_HZ = 2500;
/** Ceiling on the delay time: covers every beat down to 30 BPM; a longer, corrupt beat is a refused order. */
const DELAY_MAX_SEC = 2;

/**
 * Phase 3 Task 4: the reverb gesture's render graph — a short synthetic
 * impulse response convolved on the outgoing deck's tail for melodic-sustained
 * closes. The IR is exponentially decaying noise (0.5-1.0 s, stereo),
 * generated ONCE at module init. The wet gain stays at 0 until the last 2
 * beats of the outgoing track, then rises following the plan's release curve
 * timing. Dry path untouched. Same teardown discipline as the delay: wet dies
 * before the handover, no leaks.
 */
export const REVERB_IR_SEC = 0.75; // fixed IR length for the synthetic IR
export const REVERB_WET_ATTACK_SEC = 0.02; // fast attack to avoid click

export class DeckDelay {
  /** The deck taps its chain into here; the dry path never passes through the delay. */
  readonly input: GainNode;
  private readonly ctx: AudioContext;
  private readonly destination: AudioNode;
  private readonly delay: DelayNode;
  private readonly feedbackLowpass: BiquadFilterNode;
  private readonly feedback: GainNode;
  private readonly wet: GainNode;
  private wetConnected = false;

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.destination = destination;
    this.delay = new DelayNode(ctx, { maxDelayTime: DELAY_MAX_SEC });
    this.feedbackLowpass = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: DELAY_FEEDBACK_LOWPASS_HZ, Q: 0.7 });
    this.feedback = new GainNode(ctx, { gain: DELAY_FEEDBACK });
    this.wet = new GainNode(ctx, { gain: 0 });
    this.delay.connect(this.feedbackLowpass).connect(this.feedback).connect(this.delay);
    this.delay.connect(this.wet);
    this.input = new GainNode(ctx, { gain: 1 });
    this.input.connect(this.delay);
  }

  /**
   * Opens the wet at [openAt] and kills it at [closeAt] — the engagement
   * window, always inside the transition; the outgoing wet dies before any
   * handover. [beatSec] is one beat of the outgoing grid in output seconds.
   */
  engage(beatSec: number, openAt: number, closeAt: number): void {
    // a corrupt plan (non-finite beat, past the ceiling, an empty window) is refused, never engaged
    if (!Number.isFinite(beatSec) || beatSec <= 0 || beatSec > DELAY_MAX_SEC) return;
    if (!Number.isFinite(openAt) || !Number.isFinite(closeAt) || closeAt <= openAt) return;
    const now = this.ctx.currentTime;
    if (!this.wetConnected) {
      this.wet.connect(this.destination);
      this.wetConnected = true;
    }
    this.delay.delayTime.cancelScheduledValues(now);
    this.delay.delayTime.setValueAtTime(beatSec, now);
    this.wet.gain.cancelScheduledValues(now);
    this.wet.gain.setValueAtTime(0, now);
    this.wet.gain.setValueAtTime(0, openAt);
    this.wet.gain.linearRampToValueAtTime(1, openAt + 0.01);
    // the tail is already dissolving as the window ends: the wet dies at closeAt,
    // before the element<->deck handover can inherit it
    this.wet.gain.setValueAtTime(1, Math.max(openAt + 0.01, closeAt - 0.01));
    this.wet.gain.linearRampToValueAtTime(0, closeAt);
  }

  /** Teardown: wet silent now and released from the destination. Nodes stay reusable. */
  release(): void {
    const now = this.ctx.currentTime;
    this.wet.gain.cancelScheduledValues(now);
    this.wet.gain.setValueAtTime(0, now);
    if (this.wetConnected) {
      this.wet.disconnect();
      this.wetConnected = false;
    }
  }
}

/**
 * Phase 3 Task 4: the reverb gesture — a ConvolverNode with a synthetic IR on
 * the outgoing deck. The IR is generated once (module init), stereo, exponentially
 * decaying noise. Wet gain is 0 until the last 2 beats of the outgoing track,
 * then rises per the plan's release timing. Dry path never passes through it.
 * Teardown mirrors DeckDelay: wet killed before handover, nodes reusable.
 */
export class DeckReverb {
  /** The deck taps its chain into here; the dry path never passes through the reverb. */
  readonly input: GainNode;
  private readonly ctx: AudioContext;
  private readonly destination: AudioNode;
  private readonly convolver: ConvolverNode;
  private readonly wet: GainNode;
  private wetConnected = false;
  private static irBuffer: AudioBuffer | null = null;

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.destination = destination;
    this.convolver = new ConvolverNode(ctx);
    this.wet = new GainNode(ctx, { gain: 0 });
    this.input = new GainNode(ctx, { gain: 1 });
    this.input.connect(this.convolver).connect(this.wet);
    this.ensureIR();
  }

  /** Generates the synthetic IR once: exponentially decaying noise, stereo, REVERB_IR_SEC. */
  private ensureIR(): void {
    if (DeckReverb.irBuffer) {
      this.convolver.buffer = DeckReverb.irBuffer;
      return;
    }
    const sr = this.ctx.sampleRate;
    const len = Math.ceil(REVERB_IR_SEC * sr);
    const buffer = this.ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      // Exponential decay: e^(-t/tau) with tau ~ 0.3 * length for natural feel
      const tau = REVERB_IR_SEC * 0.3;
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        const decay = Math.exp(-t / tau);
        // White noise with exponential decay, slight stereo decorrelation
        data[i] = (Math.random() * 2 - 1) * decay * (ch === 0 ? 1 : 0.7);
      }
    }
    DeckReverb.irBuffer = buffer;
    this.convolver.buffer = buffer;
  }

  /**
   * Opens the wet at [openAt] and kills it at [closeAt] — the engagement
   * window, always inside the transition; the outgoing wet dies before any
   * handover. The wet rises from 0 at [openAt] over REVERB_WET_ATTACK_SEC,
   * holds until just before [closeAt], then ramps to 0 at [closeAt].
   */
  engage(openAt: number, closeAt: number): void {
    if (!Number.isFinite(openAt) || !Number.isFinite(closeAt) || closeAt <= openAt) return;
    const now = this.ctx.currentTime;
    if (!this.wetConnected) {
      this.wet.connect(this.destination);
      this.wetConnected = true;
    }
    this.wet.gain.cancelScheduledValues(now);
    this.wet.gain.setValueAtTime(0, now);
    this.wet.gain.setValueAtTime(0, openAt);
    this.wet.gain.linearRampToValueAtTime(1, openAt + REVERB_WET_ATTACK_SEC);
    // hold until just before closeAt, then die
    this.wet.gain.setValueAtTime(1, Math.max(openAt + REVERB_WET_ATTACK_SEC, closeAt - 0.01));
    this.wet.gain.linearRampToValueAtTime(0, closeAt);
  }

  /** Teardown: wet silent now and released from the destination. Nodes stay reusable. */
  release(): void {
    const now = this.ctx.currentTime;
    this.wet.gain.cancelScheduledValues(now);
    this.wet.gain.setValueAtTime(0, now);
    if (this.wetConnected) {
      this.wet.disconnect();
      this.wetConnected = false;
    }
  }
}

export class LoopDeck {
  readonly eq: ThreeBandEQ;
  readonly gain: GainNode;
  readonly sweep: { highpass: BiquadFilterNode; lowpass: BiquadFilterNode };
  /** Phase 3 Task 2: the beat-synced delay throw, owned by this deck, fed from its chain. */
  readonly delay: DeckDelay;
  /** Phase 3 Task 4: the short reverb for melodic closes, owned by this deck. */
  readonly reverb: DeckReverb;
  /** Track seconds the loaded region starts at. */
  regionStart = 0;
  regionEnd = 0;
  loadedKey: string | null = null;
  latencySec = 0.12;
  private pending: LoopChange[] = [];
  private dispatcherCleanup: (() => void) | null = null;

  private constructor(
    readonly ctx: AudioContext,
    readonly stretch: SignalsmithStretchNode,
    destination: AudioNode,
  ) {
    this.eq = new ThreeBandEQ(ctx);
    this.sweep = {
      highpass: new BiquadFilterNode(ctx, { type: 'highpass', frequency: 20, Q: 0.7 }),
      lowpass: new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 20000, Q: 0.7 }),
    };
    this.gain = new GainNode(ctx, { gain: 0 });
    this.delay = new DeckDelay(ctx, destination);
    this.reverb = new DeckReverb(ctx, destination);
    stretch.connect(this.eq.input);
    // AutoMix's: keeps inputTime current (the default leaves it stale)
    stretch.setUpdateInterval(0.05);
    this.eq.output.connect(this.sweep.highpass).connect(this.sweep.lowpass).connect(this.gain).connect(destination);
    // the tap: the dry path never passes through the delay or reverb
    this.sweep.lowpass.connect(this.delay.input);
    this.sweep.lowpass.connect(this.reverb.input);
  }

  static async create(ctx: AudioContext, destination: AudioNode): Promise<LoopDeck> {
    // NB (AutoMix): default node options only; numberOfInputs: 0 silently kills the processor.
    const stretch = await SignalsmithStretch(ctx);
    const deck = new LoopDeck(ctx, stretch, destination);
    deck.latencySec = await stretch.latency();
    return deck;
  }

  /** Loads [startSec, endSec) of a decoded track. */
  async load(key: string, buffer: AudioBuffer, startSec: number, endSec: number): Promise<void> {
    this.stop();
    await this.stretch.dropBuffers();
    const from = Math.max(0, Math.floor(startSec * buffer.sampleRate));
    const to = Math.min(buffer.length, Math.ceil(endSec * buffer.sampleRate));
    const channels: Float32Array[] = [];
    for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) channels.push(buffer.getChannelData(c).slice(from, to));
    if (channels.length === 1) channels.push(channels[0]!.slice());
    await this.stretch.addBuffers(channels);
    this.regionStart = from / buffer.sampleRate;
    this.regionEnd = to / buffer.sampleRate;
    this.loadedKey = key;
  }

  /** Queues changes (sorted by output); dispatched by scheduler 'at-beat' messages. */
  schedule(changes: LoopChange[]): void {
    this.pending.push(...changes);
    this.pending.sort((a, b) => a.output - b.output);
  }

  /** Attaches this deck to a scheduler for beat-accurate dispatch. */
  attachScheduler(scheduler: Scheduler): void {
    this.detachScheduler();
    this.dispatcherCleanup = createLoopDeckDispatcher(
      { pending: this.pending, ctx: this.ctx, stretch: this.stretch, regionStart: this.regionStart },
      scheduler,
      POST_AHEAD_SEC,
    );
  }

  /** Detaches from the scheduler (falls back to no-op; call before dispose). */
  detachScheduler(): void {
    this.dispatcherCleanup?.();
    this.dispatcherCleanup = null;
  }

  /** Stops now and forgets everything queued; filters, EQ, gain, delay and reverb back to rest. */
  stop(): void {
    this.pending = [];
    this.detachScheduler();
    this.stretch.schedule({ active: false });
    const now = this.ctx.currentTime;
    this.delay.release();
    this.reverb.release();
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(0, now);
    this.eq.reset();
    for (const [param, open] of [
      [this.sweep.highpass.frequency, 20],
      [this.sweep.lowpass.frequency, 20000],
    ] as const) {
      param.cancelScheduledValues(now);
      param.setValueAtTime(open, now);
    }
  }

  /** Track seconds the worklet reports it's at (~50 ms granularity). */
  get inputTime(): number {
    return this.stretch.inputTime + this.regionStart;
  }
}
