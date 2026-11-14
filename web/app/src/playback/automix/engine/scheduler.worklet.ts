// BitChord: AudioWorklet for real-time scheduling — fires exact timestamps from the audio thread.
// Replaces JS timers (setInterval) that browsers throttle in background tabs.
// Messages: 'at-handoff', 'at-release', 'at-beat'. The worklet NEVER makes musical decisions.

interface SchedulerMessage {
  type: 'set-plan' | 'clear';
  plan?: {
    t0: number;
    handoffAt: number;
    releaseAt: number;
    beatSec?: number;
  };
}

interface SchedulerOutput {
  type: 'at-handoff' | 'at-release' | 'at-beat';
  scheduledTime: number;
  actualTime: number;
  driftMs: number;
}

class SchedulerProcessor extends AudioWorkletProcessor {
  private plan: SchedulerMessage['plan'] | null = null;
  private handoffFired = false;
  private releaseFired = false;
  private beatIndex = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<SchedulerMessage>) => {
      if (e.data.type === 'set-plan') {
        this.plan = e.data.plan ?? null;
        this.handoffFired = false;
        this.releaseFired = false;
        this.beatIndex = 0;
      } else if (e.data.type === 'clear') {
        this.plan = null;
      }
    };
  }

  process(_inputs: Float32Array[][], _outputs: Float32Array[][], _parameters: Record<string, Float32Array>): boolean {
    if (!this.plan) return true;

    const now = currentTime;

    // at-handoff
    if (!this.handoffFired && now >= this.plan.handoffAt) {
      this.handoffFired = true;
      const driftMs = (now - this.plan.handoffAt) * 1000;
      this.port.postMessage({
        type: 'at-handoff',
        scheduledTime: this.plan.handoffAt,
        actualTime: now,
        driftMs,
      } satisfies SchedulerOutput);
    }

    // at-release
    if (!this.releaseFired && now >= this.plan.releaseAt) {
      this.releaseFired = true;
      const driftMs = (now - this.plan.releaseAt) * 1000;
      this.port.postMessage({
        type: 'at-release',
        scheduledTime: this.plan.releaseAt,
        actualTime: now,
        driftMs,
      } satisfies SchedulerOutput);
    }

    // at-beat (optional, for LoopDeck dispatch)
    if (this.plan.beatSec && this.plan.beatSec > 0) {
      const nextBeatTime = this.plan.t0 + this.beatIndex * this.plan.beatSec;
      while (now >= nextBeatTime - 0.001) { // fire slightly early to account for render quantum
        this.port.postMessage({
          type: 'at-beat',
          scheduledTime: nextBeatTime,
          actualTime: now,
          driftMs: (now - nextBeatTime) * 1000,
          beatIndex: this.beatIndex,
        } satisfies SchedulerOutput & { beatIndex: number });
        this.beatIndex++;
      }
    }

    return true;
  }
}

registerProcessor('automix-scheduler', SchedulerProcessor);