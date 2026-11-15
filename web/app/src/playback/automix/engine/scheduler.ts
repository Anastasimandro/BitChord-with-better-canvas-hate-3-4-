// BitChord: AudioWorklet scheduler wrapper — manages the scheduler worklet lifecycle,
// handles fallback to timers when the worklet is unavailable, and exposes a clean API
// for LoopDeck and AutoDJ. The worklet fires exact timestamps from the audio render
// thread; decisions stay on the main thread.

import type { LoopChange } from './loopDeck';
import { recordTransition, type TransitionEvent } from '../telemetry';

export interface SchedulerPlan {
  t0: number;
  handoffAt: number;
  releaseAt: number;
  beatSec?: number;
}

type SchedulerMessage =
  | { type: 'at-handoff'; scheduledTime: number; actualTime: number; driftMs: number }
  | { type: 'at-release'; scheduledTime: number; actualTime: number; driftMs: number }
  | { type: 'at-beat'; scheduledTime: number; actualTime: number; driftMs: number; beatIndex: number };

type SchedulerListener = (msg: SchedulerMessage) => void;

const DRIFT_GUARD_MS = 250;
const WORKLET_NAME = 'automix-scheduler';
const WORKLET_URL = new URL('./scheduler.worklet.ts', import.meta.url).href;

export class Scheduler {
  private node: AudioWorkletNode | null = null;
  private ctx: AudioContext;
  private listeners = new Set<SchedulerListener>();
  private fallbackTimer: ReturnType<typeof setInterval> | null = null;
  private fallbackPlan: SchedulerPlan | null = null;
  private fallbackHandoffFired = false;
  private fallbackReleaseFired = false;
  private fallbackBeatIndex = 0;
  private workletAvailable = false;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
  }

  /** Initializes the worklet. Returns true if the worklet loaded, false if falling back. */
  async init(): Promise<boolean> {
    try {
      await this.ctx.audioWorklet.addModule(WORKLET_URL);
      this.node = new AudioWorkletNode(this.ctx, WORKLET_NAME);
      this.node.port.onmessage = (e: MessageEvent<SchedulerMessage>) => {
        this.handleWorkletMessage(e.data);
      };
      this.workletAvailable = true;
      return true;
    } catch (error) {
      console.warn('[automix] scheduler worklet unavailable, falling back to timers', error);
      this.workletAvailable = false;
      return false;
    }
  }

  /** Sets the active plan. Replaces any previous plan entirely. */
  setPlan(plan: SchedulerPlan | null): void {
    if (this.workletAvailable && this.node) {
      this.node.port.postMessage({ type: plan ? 'set-plan' : 'clear', plan });
    } else {
      this.fallbackPlan = plan;
      this.fallbackHandoffFired = false;
      this.fallbackReleaseFired = false;
      this.fallbackBeatIndex = 0;
      this.startFallbackTimer();
    }
  }

  /** Subscribe to scheduler events (at-handoff, at-release, at-beat). */
  onMessage(listener: SchedulerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private handleWorkletMessage(msg: SchedulerMessage): void {
    // Drift guard: log if handoff fires >250ms late
    if (msg.type === 'at-handoff' && msg.driftMs > DRIFT_GUARD_MS) {
      console.warn(`[automix] handoff drift guard: fired ${msg.driftMs.toFixed(1)}ms late`);
      // Log to Phase 0 telemetry (local only)
      this.logDriftEvent('handoff', msg.driftMs);
    }
    if (msg.type === 'at-release' && msg.driftMs > DRIFT_GUARD_MS) {
      console.warn(`[automix] release drift guard: fired ${msg.driftMs.toFixed(1)}ms late`);
      this.logDriftEvent('release', msg.driftMs);
    }

    for (const listener of this.listeners) {
      try {
        listener(msg);
      } catch (error) {
        console.error('[automix] scheduler listener error', error);
      }
    }
  }

  private logDriftEvent(phase: 'handoff' | 'release', driftMs: number): void {
    // Record drift in telemetry as a pseudo-transition event for the Mix report
    // This is local-only, no external telemetry
    const driftEvent: TransitionEvent = {
      at: Date.now(),
      pair: `drift:${phase}`,
      styleChosen: 'crossfade',
      rejectedStylesAndWhy: [],
      reason: `audio-thread ${phase} drift ${driftMs.toFixed(1)}ms`,
      confidences: { outGrid: 0, inGrid: 0, vocalOverlap: null, deltaTempoPct: null, deltaLufs: null },
      bothGridsReady: false,
      outcome: 'completed',
      skipAfterSec: null,
      handedOffAt: null,
      gesture: 'none',
      gestureSeconds: 0,
      rejectedGesturesAndWhy: [],
    };
    recordTransition(driftEvent);
  }

  private startFallbackTimer(): void {
    this.stopFallbackTimer();
    this.fallbackTimer = setInterval(() => this.fallbackTick(), 10); // 10ms for tighter timing
    this.fallbackTick();
  }

  private stopFallbackTimer(): void {
    if (this.fallbackTimer !== null) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
    }
  }

  private fallbackTick(): void {
    if (!this.fallbackPlan) {
      this.stopFallbackTimer();
      return;
    }

    const now = this.ctx.currentTime;

    // at-handoff
    if (!this.fallbackHandoffFired && now >= this.fallbackPlan.handoffAt) {
      this.fallbackHandoffFired = true;
      const driftMs = (now - this.fallbackPlan.handoffAt) * 1000;
      this.handleWorkletMessage({
        type: 'at-handoff',
        scheduledTime: this.fallbackPlan.handoffAt,
        actualTime: now,
        driftMs,
      });
    }

    // at-release
    if (!this.fallbackReleaseFired && now >= this.fallbackPlan.releaseAt) {
      this.fallbackReleaseFired = true;
      const driftMs = (now - this.fallbackPlan.releaseAt) * 1000;
      this.handleWorkletMessage({
        type: 'at-release',
        scheduledTime: this.fallbackPlan.releaseAt,
        actualTime: now,
        driftMs,
      });
    }

    // at-beat
    if (this.fallbackPlan.beatSec && this.fallbackPlan.beatSec > 0) {
      const nextBeatTime = this.fallbackPlan.t0 + this.fallbackBeatIndex * this.fallbackPlan.beatSec;
      while (now >= nextBeatTime - 0.001) {
        this.handleWorkletMessage({
          type: 'at-beat',
          scheduledTime: nextBeatTime,
          actualTime: now,
          driftMs: (now - nextBeatTime) * 1000,
          beatIndex: this.fallbackBeatIndex,
        });
        this.fallbackBeatIndex++;
      }
    }

    // Clean up when both handoff and release have fired and no beats pending
    if (this.fallbackHandoffFired && this.fallbackReleaseFired &&
        (!this.fallbackPlan.beatSec || this.fallbackBeatIndex > this.fallbackPlan.releaseAt / (this.fallbackPlan.beatSec || 1) + 2)) {
      this.stopFallbackTimer();
    }
  }

  /** Returns true if the worklet is active (not falling back). */
  isWorkletActive(): boolean {
    return this.workletAvailable;
  }

  /** Cleans up the scheduler. */
  dispose(): void {
    this.setPlan(null);
    this.stopFallbackTimer();
    this.node?.disconnect();
    this.node = null;
    this.listeners.clear();
  }
}

/**
 * LoopDeck dispatch helper — uses scheduler 'at-beat' messages instead of setInterval.
 * The scheduler fires at each beat; we dispatch pending changes whose output time is near.
 */
export function createLoopDeckDispatcher(
  deck: { pending: LoopChange[]; ctx: AudioContext; stretch: { schedule: (opts: any) => void }; regionStart: number },
  scheduler: Scheduler,
  postAheadSec = 0.25,
): () => void {
  return scheduler.onMessage((msg) => {
    if (msg.type !== 'at-beat') return;
    const now = deck.ctx.currentTime;
    while (deck.pending.length && deck.pending[0]!.output - now < postAheadSec) {
      const c = deck.pending.shift()!;
      const r = deck.regionStart;
      deck.stretch.schedule({
        output: c.output,
        input: c.input - r,
        rate: c.rate,
        active: c.active,
        loopStart: c.loop ? c.loop[0] - r : 0,
        loopEnd: c.loop ? c.loop[1] - r : 0,
      });
    }
  });
}

/**
 * AutoDJ handoff helper — uses scheduler 'at-handoff' instead of 1s tick polling.
 * The 1s tick KEEPS its other duties (preload, queueing, L-ladder).
 * Uses getters to read current state (blend/pendingEvent are reassigned on each mix).
 */
export function createAutoDJHandoffHandler(
  getBlend: () => { handedOff: boolean } | null,
  getHost: () => { handoff: () => void },
  getPendingEvent: () => TransitionEvent | null,
  scheduler: Scheduler,
): () => void {
  return scheduler.onMessage((msg) => {
    if (msg.type !== 'at-handoff') return;
    const blend = getBlend();
    if (!blend || blend.handedOff) return;
    blend.handedOff = true;
    getHost().handoff();
    const pendingEvent = getPendingEvent();
    if (pendingEvent) {
      // Reuse the existing markHandoff logic from telemetry
      pendingEvent.handedOffAt = Date.now();
    }
  });
}