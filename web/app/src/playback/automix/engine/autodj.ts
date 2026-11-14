// Adapted from AutoMix's src/lib/engine/autodj.ts (https://github.com/heydavidf/automix),
// Copyright (C) 2026 David Finnegan. AGPL-3.0-only: see ../LICENSE and ../NOTICE.md.
//
// BitChord: AutoMix picks every next track from a local library. Here the
// queue decides what comes next, as on the phone, and only the playing and
// the next song are analysed, so AutoMix's selector isn't used. Tracks
// are analyzed from YouTube on the way (analysis/analyzer.ts); a track whose
// analysis isn't ready in time mixes through AutoMix's own fallback, a plain
// 12-second equal-power crossfade. The handoff to the incoming track happens
// at the blend's midpoint, where the phone's CrossfadeController hands over.
import type { TrackAnalysis } from '../analysis/types';
import { analyzer } from '../analysis/analyzer';
import { recordTransition, markHandoff, type RejectedStyle, type TransitionEvent } from '../telemetry';
import type { Deck } from './deck';
import type { Candidate } from './selector';
import { scheduleTransition, scheduleGapMix, plannedBars, MIN_GRID_CONFIDENCE, type TransitionPlan } from './transition-scheduler';
import { asOutgoing, gridOf, phraseAtOrBefore } from './grid';
import { detectGap, incomingGainCompensation, mixLufsOf } from './policy';
import type { LoopDeck } from './loopDeck';
import {
  IN_REGION_SEC,
  mixBeatPhaseAt,
  mixPositionAt,
  OUT_REGION_SEC,
  OUT_SEARCH_SEC,
  planLoopMix,
  scheduleLoopMix,
  sungShare,
  type LoopMixPlan,
  type LoopMixTimes,
  type SungSpans,
} from './loopMix';

export type AutoDJState = 'idle' | 'playing' | 'scheduled';

export interface QueuedTrack {
  videoId: string;
  title: string;
  artist: string;
}

/** What the player gives the mix loop: its decks and its queue. */
export interface AutomixHost {
  ctx: AudioContext;
  /** The deck in front (the one the app shows and controls). */
  front(): Deck;
  back(): Deck;
  /** The track in front, if one is playing. */
  current(): QueuedTrack | null;
  /** What the queue plays next on its own (repeat and AutoPlay applied), or null at the end. */
  next(): QueuedTrack | null;
  /**
   * BitChord, Phase 1: the track after the next one, when the queue knows
   * it — the L0 prefetch target. Optional; without it nothing prefetches.
   */
  nextAfter?(): QueuedTrack | null;
  /** Loads [videoId] onto the back deck, paused. Resolves false if it can't play. */
  loadBack(videoId: string): Promise<boolean>;
  /** The blend's midpoint: the incoming track becomes the one playing, as far as the app knows. */
  handoff(): void;
  /** The blend is over: the old deck can let go of its track. */
  finished(): void;
  /** BitChord: the two stretch decks the loop mix plays on (built on first use). */
  loopDecks(): Promise<[LoopDeck, LoopDeck]>;
  /**
   * BitChord: where [videoId] is sung, from its synced lyrics; null when it
   * has none. The loop mix never loops a sung word, and these are its truest
   * answer (the vocal mask is the fallback).
   */
  sungSpans(videoId: string): Promise<SungSpans | null>;
  /**
   * BitChord: while a loop mix runs, the elements are paused and started by
   * the mix, not the user; the player must not read that as a pause or an end.
   */
  hold(on: boolean): void;
}

export interface AutoDJSnapshot {
  state: AutoDJState;
  currentKey: string | null;
  nextKey: string | null;
  nextLoaded: boolean;
  candidates: Candidate[];
  /** AudioContext time of the next blend start, when scheduled. */
  transitionAt: number | null;
  transitionDuration: number | null;
  plan: TransitionPlan | null;
  /**
   * The stretch of the playing (outgoing) track the next blend covers, in its
   * own seconds: planned while it is ahead, the real one once scheduled. For
   * the seek bar's highlight, as on the phone.
   */
  window: MixWindow | null;
  /** Seconds until the blend starts (negative once it has), when scheduled. */
  startsInSec: number | null;
  /** The outgoing track's beat at the rate it plays, for a pulse in time with the blend; null without a grid. */
  beatSec: number | null;
  /** BitChord: the loop mix planned or running, for stats for nerds. */
  loop: LoopMixPlan | null;
}

export interface MixWindow {
  videoId: string;
  startSec: number;
  endSec: number;
}

const PRELOAD_WINDOW_SEC = 60;
/** BitChord: the loop mix is prepared (bars chosen, decks loaded) from this far before the end. */
const LOOP_PREPARE_SEC = OUT_SEARCH_SEC + 40;
/** BitChord: the outgoing loop starts at least this far ahead of the playhead when it's planned. */
const LOOP_SETUP_SEC = 15;
const SCHEDULE_WINDOW_SEC = 12;
const EMERGENCY_REMAINING_SEC = 10;
/**
 * BitChord, Automix 2.0 Phase 1: the planning deadline. When this much of
 * the outgoing track remains, a plan EXISTS — Apple AutoMix's whole scope is
 * intro/outro by t-60, and the tick must never discover at -12 s that there
 * is nothing. A plan without L0 evidence is a phrase-aligned FADE, recorded
 * as such in the telemetry.
 */
const PLAN_DEADLINE_SEC = 60;
/** How long the loop mix waits for the cheap vocal detector before planning from what exists. */
const VOCAL_WAIT_MS = 6000;

/**
 * The auto-mix loop: preload the queue's next track into the idle deck as
 * the mix-out point approaches, schedule the blend, flip decks, repeat. All
 * timing decisions read the active deck's timeline; the tick only decides,
 * the Web Audio clock executes.
 */
export class AutoDJ {
  transitionBars = 16;

  private state: AutoDJState = 'idle';
  private history: string[] = [];
  private currentKey: string | null = null;
  private nextKey: string | null = null;
  private nextLoadedKey: string | null = null;
  private candidates: Candidate[] = [];
  private plan: TransitionPlan | null = null;
  private blend: { from: Deck; to: Deck; handedOff: boolean } | null = null;
  /** The deck a finished blend left gliding back to rate 1. */
  private settling: Deck | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private loadToken = 0;
  private window: MixWindow | null = null;
  /** Both songs of the coming mix are analysed (the seek bar shows nothing until they are). */
  private bothAnalyzed = false;
  /**
   * BitChord, Phase 1: the scheduled plan was made without L0 evidence (the
   * t-60 guarantee fired on a stub). Upgraded — torn down and re-planned —
   * the moment real grids land, while the blend is still more than 5 s out.
   */
  private planDegraded = false;
  /** BitChord: the loop mix for the coming pair, once its bars are chosen and loaded on the decks. */
  private loopPlan: LoopMixPlan | null = null;
  private loopPreparing: string | null = null;
  private loopTimes: LoopMixTimes | null = null;
  private loopDecks: [LoopDeck, LoopDeck] | null = null;
  private beatSec: number | null = null;
  /** BitChord, Phase 0: the transition planned and in flight, recorded when it ends. */
  private pendingEvent: TransitionEvent | null = null;
  /** BitChord, Phase 0: why no loop mix was prepared for the coming pair, for the event. */
  private loopRefusal: string | null = null;

  constructor(
    private host: AutomixHost,
    private onUpdate: (snap: AutoDJSnapshot) => void = () => {},
    private onTransition?: (from: TrackAnalysis, to: TrackAnalysis, plan: TransitionPlan, bars: number) => void,
  ) {}

  get snapshot(): AutoDJSnapshot {
    return {
      state: this.state,
      currentKey: this.currentKey,
      nextKey: this.nextKey,
      nextLoaded: this.nextKey !== null && this.nextLoadedKey === this.nextKey,
      candidates: this.candidates.slice(0, 8),
      transitionAt: this.plan?.t0 ?? null,
      transitionDuration: this.plan?.durationSec ?? null,
      plan: this.plan,
      window: this.window,
      startsInSec: this.plan ? this.plan.t0 - this.host.ctx.currentTime : null,
      beatSec: this.beatSec,
      loop: this.loopPlan,
    };
  }

  /**
   * Where [videoId] is right now in its own seconds while a loop mix plays it
   * from a deck (looping, at the ramped tempo); null when its element is
   * what's playing it. The lyrics, the seek bar and a cancelled mix read this.
   */
  mixPlayhead(videoId: string): number | null {
    const plan = this.loopPlan;
    const times = this.loopTimes;
    if (!plan || !times) return null;
    const side = videoId === plan.out.key ? 'out' : videoId === plan.in.key ? 'in' : null;
    return side ? mixPositionAt(plan, times, side, this.host.ctx.currentTime) : null;
  }

  /**
   * The running mix's beat, for the seek bar's pulse: [phase] 0 on the beat,
   * rising to 1; null phase when the tempo isn't known. Null between mixes.
   */
  mixBeat(): { phase: number | null } | null {
    if (this.state !== 'scheduled' || !this.plan) return null;
    const now = this.host.ctx.currentTime;
    if (this.loopTimes) {
      const phase = mixBeatPhaseAt(this.loopTimes, now);
      return phase === null ? null : { phase };
    }
    const { t0, durationSec } = this.plan;
    if (now < t0 || now > t0 + durationSec) return null;
    const beat = this.beatSec;
    if (!beat) return { phase: null };
    const x = (now - t0) / beat;
    return { phase: x - Math.floor(x) };
  }

  /** True while a loop mix runs: both elements are held paused and the decks carry the sound. */
  get loopMixing(): boolean {
    return this.state === 'scheduled' && this.loopTimes !== null;
  }

  /** True between scheduling a blend and its handoff: the back deck carries the next track. */
  get mixing(): boolean {
    return this.state === 'scheduled';
  }

  start(): void {
    if (this.state === 'idle') this.state = 'playing';
    this.timer ??= setInterval(() => void this.tick(), 1000);
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.cancel();
    this.state = 'idle';
    this.push();
  }

  /**
   * The user took over (pause, seek, another track): drop the blend and the
   * preloaded deck. The deck in front plays on, at full volume and rate 1
   * once the glide is gone.
   */
  cancel(): void {
    this.loadToken++;
    // BitChord, Phase 0: a planned mix that never finished is an aborted event.
    if (this.pendingEvent) {
      this.pendingEvent.outcome = 'aborted';
      recordTransition(this.pendingEvent);
      this.pendingEvent = null;
    }
    this.loopRefusal = null;
    if (this.loopTimes && this.blend && this.loopDecks) {
      // Settle onto the song that's ahead in the mix, where its deck is now.
      const [outDeck, inDeck] = this.loopDecks;
      const onIncoming = this.blend.handedOff;
      const keep = onIncoming ? this.blend.to : this.blend.from;
      const drop = onIncoming ? this.blend.from : this.blend.to;
      // where the song really is in the mix (the deck's own report lags and starts stale)
      const at =
        this.mixPlayhead((onIncoming ? this.loopPlan?.in.key : this.loopPlan?.out.key) ?? '') ??
        (onIncoming ? this.loopTimes.elementTrackTime : this.loopPlan?.out.loop[0]) ??
        keep.audio.currentTime;
      outDeck.stop();
      inDeck.stop();
      drop.cancel();
      keep.cancel();
      keep.audio.currentTime = at;
      void keep.audio.play().catch(() => {});
      this.loopTimes = null;
      this.blend = null;
      this.host.hold(false);
    }
    this.loopPlan = null;
    this.loopPreparing = null;
    this.planDegraded = false;
    if (this.blend) {
      this.blend.from.cancel();
      this.blend.to.cancel();
    }
    this.settling?.cancel();
    this.settling = null;
    this.window = null;
    this.blend = null;
    this.plan = null;
    this.nextKey = null;
    this.nextLoadedKey = null;
    this.candidates = [];

    if (this.state === 'scheduled') this.state = 'playing';
    this.push();
  }

  /** The outgoing track ran out before the midpoint (a stalled stream): hand over now. */
  forceHandoff(): boolean {
    if (!this.blend || this.blend.handedOff) return false;
    this.blend.handedOff = true;
    this.host.handoff();
    return true;
  }

  private currentAnalysis(): TrackAnalysis | null {
    return this.currentKey ? analyzer.get(this.currentKey) : null;
  }

  /**
   * Whether [a] has been measured on the edge [side] of the mix reads — the
   * outgoing track's tail, the incoming track's head. `undefined` on the
   * record's tailGrid (or a bare bpm on an adopted legacy record) is the
   * monolithic analysis's shape; both count as measured.
   */
  private edgeMeasured(a: TrackAnalysis | null, side: 'out' | 'in'): boolean {
    if (!a) return false;
    if (side === 'out') return a.tailGrid !== undefined || a.bpm != null;
    return a.headBeats != null || a.bpm != null;
  }

  /** Asks the ladder for an edge's L0, only when the record doesn't hold that edge yet. */
  private ensureEdge(t: QueuedTrack, edge: 'head' | 'tail', urgent: boolean): void {
    const rec = analyzer.get(t.videoId);
    const have =
      rec != null &&
      (edge === 'head'
        ? rec.headBeats != null || rec.bpm != null
        : rec.tailBeats != null || rec.tailGrid != null || rec.bpm != null);
    if (have) return;
    analyzer.request(t.videoId, tags(t), 0, { urgent, edge });
  }

  /** Asks for the edge's phrase-true span (L1) when only the coarse one exists. */
  private ensureSpan(t: QueuedTrack, edge: 'head' | 'tail'): void {
    const rec = analyzer.get(t.videoId);
    if (!rec?.beatIntervalSec) return; // the phrase window is sized from the grid
    const covered = rec.energySpans?.some((s) => {
      if (s.windowSec <= 1) return false; // L0's coarse span, not L1's
      const end = s.startSec + s.curve.length * s.windowSec;
      return edge === 'head' ? s.startSec <= 1 : end >= rec.durationSec - 1;
    });
    if (covered) return;
    analyzer.request(t.videoId, tags(t), 1, { edge });
  }

  /** Asks for the cheap vocal detector over the edge (L2), escalating a doubted window to open-unmix. */
  private ensureVocal(t: QueuedTrack, edge: 'head' | 'tail'): void {
    const rec = analyzer.get(t.videoId);
    const covered = rec?.vocals?.some((w) => {
      const end = w.startSec + w.curve.length / w.fps;
      return edge === 'head' ? w.startSec <= 1 : end >= rec.durationSec - 1;
    });
    if (covered) return;
    analyzer.request(t.videoId, tags(t), 2, { edge });
    // sustained doubt: open-unmix gets an urgent shot at the whole record
    if (analyzer.isVocalUncertain(t.videoId)) analyzer.request(t.videoId, tags(t), 3, { urgent: true });
  }

  /**
   * Tears down a scheduled-but-degraded plan so the same tick can re-plan
   * with the evidence that has since landed. Only legal while the blend is
   * more than 5 s out (the caller checks): after that the audio is close
   * enough to committed that a clean crossfade beats a re-plan.
   */
  private abandonScheduledPlan(): void {
    if (this.pendingEvent) {
      this.pendingEvent.outcome = 'aborted';
      recordTransition(this.pendingEvent);
      this.pendingEvent = null;
    }
    if (this.blend) {
      this.blend.to.cancel();
      this.blend.from.cancel();
      this.host.front().anchor();
    }
    this.plan = null;
    this.planDegraded = false;
    this.blend = null;
    this.window = null;
    this.state = 'playing';
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.state === 'idle') return;
    this.ticking = true;
    try {
      const now = this.host.ctx.currentTime;

      if (this.state === 'scheduled' && this.plan && this.blend) {
        const handoffAt = this.loopTimes?.handoffAt ?? this.plan.t0 + this.plan.durationSec / 2;
        if (!this.blend.handedOff && now >= handoffAt) {
          this.blend.handedOff = true;
          this.host.handoff();
          // the skip window opens at the handoff (Phase 0)
          if (this.pendingEvent) markHandoff(this.pendingEvent);
        }
        if (now > this.plan.t0 + this.plan.durationSec + 0.3) this.completeTransition();
        this.push();
        return;
      }

      const playing = this.host.current();
      const front = this.host.front();
      if (!playing || !front.isPlaying) return;
      if (playing.videoId !== this.currentKey) {
        // A new track in front that this loop didn't mix in (a tap, a skip).
        this.currentKey = playing.videoId;
        this.nextKey = null;
        this.nextLoadedKey = null;

        this.candidates = [];
        this.window = null;
        this.loopPlan = null;
        this.loopRefusal = null;
      }
      front.anchor();

      const queued = this.host.next();
      if (!queued) {
        this.nextKey = null;
        this.window = null;
        this.push();
        return;
      }
      if (queued.videoId !== this.nextKey) {
        this.nextKey = queued.videoId;
        this.nextLoadedKey = null;
        this.loopPlan = null;
        this.loopRefusal = null;
        this.loadToken++;
      }

      // BitChord, Phase 1: the ladder's requests. The pair's mixable edges
      // are urgent (the outgoing tail, the incoming head); the other two
      // edges and the whole-track pass are idle work. The prefetch target's
      // head joins the idle lane, cancellable by setActive when the queue moves.
      const after = this.host.nextAfter?.() ?? null;
      analyzer.setActive([playing.videoId, queued.videoId, after?.videoId].filter((k): k is string => !!k));
      this.ensureEdge(playing, 'tail', true);
      this.ensureEdge(playing, 'head', false);
      this.ensureEdge(queued, 'head', true);
      this.ensureEdge(queued, 'tail', false);
      if (after) this.ensureEdge(after, 'head', false);
      if (this.trackRemaining() > 90) {
        // slack: the phrase-true intro/outro (L1) while nothing is urgent
        this.ensureSpan(playing, 'tail');
        this.ensureSpan(queued, 'head');
      }
      analyzer.requestIdle(
        [playing, queued].map((t) => ({ videoId: t.videoId, tags: tags(t) })),
      );

      // BitChord, as the phone: only with both songs analysed is there a mix
      // to plan. Until then nothing is drawn on the seek bar — and since
      // Phase 1, the t-60 guarantee below plans with what exists rather than
      // letting the tick discover at -12 s that there is nothing.
      this.bothAnalyzed = this.edgeMeasured(this.currentAnalysis(), 'out') && this.edgeMeasured(analyzer.get(queued.videoId), 'in');
      const cur = asOutgoing(
        this.bothAnalyzed ? this.currentAnalysis()! : stubAnalysis(playing, front.durationSec),
      );

      // A plan made on a stub gets replaced the moment real grids land: the
      // degraded plan is a placeholder, never a commitment.
      if (this.plan && this.planDegraded && this.bothAnalyzed && !this.loopTimes && this.plan.t0 - now > 5) {
        this.abandonScheduledPlan();
      }

      // BitChord, Phase 0: a gap pair (melodic close into a clear opener) is
      // not for the loop mix — the outgoing song is leaving, not looping.
      if (this.bothAnalyzed && !this.loopPlan && this.trackRemaining() < LOOP_PREPARE_SEC && !this.gapOffered(cur, analyzer.get(queued.videoId)!)) {
        this.ensureVocal(playing, 'tail');
        this.ensureVocal(queued, 'head');
        void this.prepareLoopMix(cur, analyzer.get(queued.videoId)!);
      }
      const remaining = this.timeToMixOut(cur);
      if (!this.bothAnalyzed) this.window = null;

      if (this.nextKey && this.nextLoadedKey !== this.nextKey && remaining < PRELOAD_WINDOW_SEC) {
        await this.loadNext(this.nextKey);
      }

      const ready = this.nextKey !== null && this.nextLoadedKey === this.nextKey;
      // The t-60 guarantee: a plan exists by here, from whatever evidence
      // the ladder has produced. With L0 it is the real plan; without it a
      // phrase-aligned FADE, flagged in the telemetry so the Mix report can
      // count how often the race was lost.
      if (ready && !this.plan && !this.loopPlan && remaining < PLAN_DEADLINE_SEC && this.loopPreparing === null) {
        const next = analyzer.get(queued.videoId)!;
        if (this.bothAnalyzed && this.gapOffered(cur, next)) {
          this.scheduleGap(cur, next);
        } else {
          this.scheduleBlend(cur, false);
          if (this.pendingEvent && !this.bothAnalyzed) this.pendingEvent.deadlinePlanned = true;
        }
      }
      if (ready && remaining < SCHEDULE_WINDOW_SEC && this.loopPlan) {
        await this.scheduleLoop(cur);
      } else if (ready && remaining < SCHEDULE_WINDOW_SEC && this.gapOffered(cur, analyzer.get(queued.videoId)!)) {
        this.scheduleGap(cur, analyzer.get(queued.videoId)!);
      } else if (ready && remaining < SCHEDULE_WINDOW_SEC) {
        this.scheduleBlend(cur, false);
      } else if (ready && this.trackRemaining() < EMERGENCY_REMAINING_SEC) {
        this.scheduleBlend(cur, true);
      }
      this.push();
    } finally {
      this.ticking = false;
    }
  }

  /** Output seconds until the natural blend start on the active deck. */
  private timeToMixOut(cur: TrackAnalysis): number {
    const front = this.host.front();
    const now = this.host.ctx.currentTime;
    const pos = front.expectedTrackTime ?? 0;
    if (this.loopPlan && this.loopPlan.out.loop[0] > pos + 1) {
      // the loop mix starts where the outgoing loop does; that's the stretch the seek bar shows
      const [start, end] = this.loopPlan.out.loop;
      this.window = { videoId: cur.fileKey, startSec: start, endSec: end };
      this.beatSec = this.loopPlan.out.beatSec;
      const t0 = front.timeline.ctxTimeAt(start, now);
      return t0 === null ? 0 : Math.max(0, t0 - now);
    }
    if (this.loopPlan) this.loopPlan = null; // the playhead went past it
    const grid = gridOf(cur);
    if (!grid || cur.gridConfidence < MIN_GRID_CONFIDENCE) {
      const target = (cur.outroStartSec ?? cur.durationSec) - 12;
      this.window = { videoId: cur.fileKey, startSec: Math.max(0, target), endSec: Math.max(0, target) + 12 };
      this.beatSec = null;
      return Math.max(0, target - pos);
    }
    const outRate = front.timeline.rateAt(now) || 1;
    const effBpm = grid.bpm * outRate;
    const next = this.nextKey ? analyzer.get(this.nextKey) : null;
    // the same length the scheduler will choose for this pair (a filter mix runs longer than a weak-grid blend)
    const bars = plannedBars(this.transitionBars, cur, next ?? null, outRate);
    const blendOutputSec = bars * 4 * (60 / effBpm);
    const blendInputSec = blendOutputSec * outRate;
    let mixOut = phraseAtOrBefore(grid, (cur.outroStartSec ?? cur.durationSec) - blendInputSec);
    mixOut = Math.min(mixOut, phraseAtOrBefore(grid, cur.durationSec - blendInputSec - grid.barSec));
    this.window = { videoId: cur.fileKey, startSec: mixOut, endSec: mixOut + blendInputSec };
    this.beatSec = grid.beatSec / outRate;
    const t0 = front.timeline.ctxTimeAt(mixOut, now);
    return t0 === null ? 0 : Math.max(0, t0 - now);
  }

  private trackRemaining(): number {
    const front = this.host.front();
    const pos = front.expectedTrackTime ?? 0;
    return front.durationSec - pos;
  }

  private async loadNext(videoId: string): Promise<void> {
    const token = ++this.loadToken;
    const ok = await this.host.loadBack(videoId);
    if (token !== this.loadToken) return; // superseded by cancel() or a newer load
    if (ok) this.nextLoadedKey = videoId;
    else this.nextKey = null;
  }

  private scheduleBlend(cur: TrackAnalysis, forceNow: boolean): void {
    const queued = this.host.next();
    if (!this.nextKey || queued?.videoId !== this.nextKey) return;
    const from = this.host.front();
    const to = this.host.back();
    const next = (this.bothAnalyzed ? analyzer.get(this.nextKey) : null) ?? stubAnalysis(queued, to.durationSec);
    // The outgoing deck runs free (only its scheduled stop applies); the incoming one follows it.
    to.lock(from);
    to.setVolume(1);
    to.eq.reset();
    this.plan = scheduleTransition({
      from,
      to,
      fromAnalysis: cur,
      toAnalysis: next,
      bars: this.transitionBars,
      forceNow,
    });
    this.blend = { from, to, handedOff: false };
    const outRate = from.timeline.rateAt(this.host.ctx.currentTime) || 1;
    this.window = {
      videoId: cur.fileKey,
      startSec: this.plan.mixOutTrackTime,
      endSec: this.plan.mixOutTrackTime + this.plan.durationSec * outRate,
    };
    if (!this.bothAnalyzed) this.window = null;
    const grid = this.plan.style === 'crossfade' ? null : gridOf(cur);
    this.beatSec = grid ? grid.beatSec / outRate : null;
    this.state = 'scheduled';
    // a plan built on stubs (the t-60 guarantee on missing L0) is marked for
    // replacement when the real grids land
    this.planDegraded = !this.bothAnalyzed;
    this.pendingEvent = this.eventFor(cur, next, this.plan);
    this.onTransition?.(cur, next, this.plan, this.transitionBars);
  }

  /**
   * BitChord, Phase 0: the GAP style is offered when both grids are trusted
   * and the pair reads as a melodic close into a clear opener.
   */
  private gapOffered(cur: TrackAnalysis, next: TrackAnalysis | null): boolean {
    if (!next) return false;
    const outGrid = gridOf(asOutgoing(cur));
    return (
      outGrid !== null &&
      cur.gridConfidence >= MIN_GRID_CONFIDENCE &&
      next.gridConfidence >= MIN_GRID_CONFIDENCE &&
      detectGap(cur, next)
    );
  }

  /** The gap mix: the outgoing song leaves at its silence point, the incoming enters at its first downbeat. */
  private scheduleGap(cur: TrackAnalysis, next: TrackAnalysis): void {
    const queued = this.host.next();
    if (!this.nextKey || queued?.videoId !== this.nextKey) return;
    const from = this.host.front();
    const to = this.host.back();
    to.lock(from);
    to.setVolume(1);
    to.eq.reset();
    this.plan = scheduleGapMix({ from, to, fromAnalysis: cur, toAnalysis: next, bars: this.transitionBars });
    this.blend = { from, to, handedOff: false };
    const outRate = from.timeline.rateAt(this.host.ctx.currentTime) || 1;
    this.window = {
      videoId: cur.fileKey,
      startSec: this.plan.mixOutTrackTime,
      endSec: this.plan.mixOutTrackTime + this.plan.durationSec * outRate,
    };
    // a 0.4 s handover has no beat to pulse on
    this.beatSec = null;
    this.state = 'scheduled';
    this.pendingEvent = this.eventFor(cur, next, this.plan);
    this.onTransition?.(cur, next, this.plan, this.transitionBars);
  }

  /** BitChord, Phase 0: the event the mix loop records when this transition ends. */
  private eventFor(cur: TrackAnalysis, next: TrackAnalysis, plan: TransitionPlan): TransitionEvent {
    const outGrid = gridOf(asOutgoing(cur));
    const inGrid = gridOf(next);
    const deltaTempoPct =
      plan.style === 'loop' && this.loopPlan
        ? (this.loopPlan.in.bpm / this.loopPlan.fold / this.loopPlan.out.bpm - 1) * 100
        : plan.style === 'blend'
          ? (plan.rate - 1) * 100
          : outGrid && inGrid
            ? ((inGrid.bpm - outGrid.bpm) / outGrid.bpm) * 100
            : null;
    return {
      at: Date.now(),
      pair: `${cur.fileKey}>${next.fileKey}`,
      styleChosen: plan.style,
      rejectedStylesAndWhy: this.rejectionsFor(plan),
      reason: plan.reason,
      confidences: {
        outGrid: cur.gridConfidence,
        inGrid: next.gridConfidence,
        vocalOverlap: this.vocalOverlap(cur, next, plan),
        deltaTempoPct,
        // the spans the mix actually audibly crosses, not the whole-track masters
        deltaLufs: (() => {
          const out = mixLufsOf(cur, 'tail');
          const inn = mixLufsOf(next, 'head');
          return out != null && inn != null ? out - inn : null;
        })(),
      },
      bothGridsReady:
        this.bothAnalyzed &&
        cur.gridConfidence >= MIN_GRID_CONFIDENCE &&
        next.gridConfidence >= MIN_GRID_CONFIDENCE,
      outcome: 'completed',
      skipAfterSec: null,
      handedOffAt: null,
    };
  }

  /** How sung the blend's two windows are, where the vocal mask reaches them. */
  private vocalOverlap(cur: TrackAnalysis, next: TrackAnalysis, plan: TransitionPlan): number | null {
    if (plan.style === 'loop' && this.loopPlan) {
      const { out, in: inn } = this.loopPlan;
      return Math.max(out.vocal ?? 0, inn.vocal ?? 0);
    }
    const outShare = sungShare(cur.vocals ?? [], plan.mixOutTrackTime, plan.mixOutTrackTime + plan.durationSec * (plan.rate || 1));
    const inShare = sungShare(next.vocals ?? [], plan.mixInTrackTime, plan.mixInTrackTime + plan.durationSec * plan.rate);
    const shares = [outShare, inShare].filter((s): s is number => s !== null);
    return shares.length ? Math.max(...shares) : null;
  }

  /** Which candidates lost and the gate that killed each, in the ladder's own words. */
  private rejectionsFor(plan: TransitionPlan): RejectedStyle[] {
    const loopLost = this.loopRefusal ? [{ style: 'loop' as const, reason: this.loopRefusal }] : [];
    switch (plan.style) {
      case 'loop':
        return [];
      case 'gap':
        return [...loopLost, { style: 'blend' as const, reason: 'melodic close into a clear opener: a gap, not an overlap' }];
      case 'blend':
        return loopLost;
      case 'filter':
        return [...loopLost, { style: 'blend' as const, reason: plan.reason ?? 'no beatmatch' }];
      case 'crossfade':
        return [
          ...loopLost,
          { style: 'blend' as const, reason: plan.reason ?? 'no usable grid' },
          { style: 'filter' as const, reason: plan.reason ?? 'no usable outgoing grid' },
        ];
      default:
        return [];
    }
  }

  /**
   * BitChord: picks the bars to loop and loads both decks, in the background
   * while the song plays. Decodes each song's RANGED EDGE (the ~65 s region
   * the deck plays, fetched as bytes) and holds only the stretch each deck
   * plays — a full decode only when a ranged one is refused.
   */
  private async prepareLoopMix(cur: TrackAnalysis, next: TrackAnalysis): Promise<void> {
    const key = `${cur.fileKey}>${next.fileKey}`;
    if (this.loopPreparing === key) return;
    this.loopPreparing = key;
    const stillWanted = () => this.loopPreparing === key && this.currentKey === cur.fileKey && this.nextKey === next.fileKey;
    try {
      const outGrid = asOutgoing(cur);
      if (outGrid.gridConfidence < MIN_GRID_CONFIDENCE || next.gridConfidence < MIN_GRID_CONFIDENCE) {
        this.loopRefusal = 'grids too weak for a loop';
        return;
      }
      this.loopDecks ??= await this.host.loopDecks();
      const ctx = this.host.ctx;
      const [outEdge, inEdge, outSung, inSung] = await Promise.all([
        analyzer.edgeRegion(cur.fileKey, 'tail'),
        analyzer.edgeRegion(next.fileKey, 'head'),
        this.host.sungSpans(cur.fileKey).catch(() => null),
        this.host.sungSpans(next.fileKey).catch(() => null),
      ]);
      // L2: the cheap detector's windows over both search spans, before the
      // loops are picked — a loop is never cut through a sung word, and the
      // detector is what vouches when the lyrics don't. Bounded: on timeout
      // the plan is made from what exists (and it shrinks, never grows).
      await Promise.all([
        analyzer.whenLevel(cur.fileKey, 2, 'tail', VOCAL_WAIT_MS),
        analyzer.whenLevel(next.fileKey, 2, 'head', VOCAL_WAIT_MS),
      ]);
      if (!stillWanted()) return;
      if (analyzer.isVocalUncertain(cur.fileKey) || analyzer.isVocalUncertain(next.fileKey)) {
        // sustained doubt: open-unmix gets one bounded shot at the record
        // before the plan is made without it (the overlap shrinks, never grows)
        const recOut = analyzer.get(cur.fileKey);
        const recIn = analyzer.get(next.fileKey);
        if (recOut) analyzer.request(cur.fileKey, recOut.tags, 3, { urgent: true });
        if (recIn) analyzer.request(next.fileKey, recIn.tags, 3, { urgent: true });
        await Promise.all([
          analyzer.whenLevel(cur.fileKey, 3, undefined, VOCAL_WAIT_MS),
          analyzer.whenLevel(next.fileKey, 3, undefined, VOCAL_WAIT_MS),
        ]);
        if (!stillWanted()) return;
      }
      // fresh records: the L2/L3 merges landed while we waited
      const curNow = analyzer.get(cur.fileKey) ?? cur;
      const nextNow = analyzer.get(next.fileKey) ?? next;
      const [out, inn] = await Promise.all([
        this.decodeEdge(ctx, cur.fileKey, 'tail', outEdge, curNow.durationSec),
        this.decodeEdge(ctx, next.fileKey, 'head', inEdge, nextNow.durationSec),
      ]);
      if (!stillWanted()) return;
      const pos = this.host.front().expectedTrackTime ?? 0;
      const plan = planLoopMix(
        asOutgoing(curNow),
        out.buffer,
        nextNow,
        inn.buffer,
        pos + LOOP_SETUP_SEC,
        { out: outSung, in: inSung },
        (why) => {
          if (!this.loopPlan) this.loopRefusal = why;
        },
        { out: out.offsetSec, in: inn.offsetSec },
      );
      if (!plan) return;
      this.loopRefusal = null;
      const [outDeck, inDeck] = this.loopDecks;
      // the worklet holds only the stretch it plays (the mix's two regions,
      // ~22 MB together); the transient decode buffers die right after
      await outDeck.load(
        cur.fileKey,
        out.buffer,
        Math.max(out.offsetSec, curNow.durationSec - OUT_REGION_SEC),
        out.offsetSec + out.buffer.duration,
      );
      await inDeck.load(
        next.fileKey,
        inn.buffer,
        inn.offsetSec,
        Math.min(inn.offsetSec + IN_REGION_SEC, inn.offsetSec + inn.buffer.duration),
      );
      if (!stillWanted()) return;
      this.loopPlan = plan;
    } catch (error) {
      console.warn('automix: loop mix not prepared', error);
    } finally {
      if (this.loopPreparing === key && !this.loopPlan) this.loopPreparing = null;
    }
  }

  /**
   * Decodes one edge's bytes for the loop decks. The ranged decode is the
   * fast path; a decoder that refuses the concatenation (an MP4 whose chunk
   * table points outside it) gets the full file — the old path, ~80 MB, the
   * thing the ranged one exists to avoid.
   */
  private async decodeEdge(
    ctx: AudioContext,
    videoId: string,
    edge: 'head' | 'tail',
    fetched: { bytes: ArrayBuffer; trackDurationSec: number; fellBackToFull: boolean },
    durationSec: number,
  ): Promise<{ buffer: AudioBuffer; offsetSec: number }> {
    const track = fetched.trackDurationSec > 0 ? fetched.trackDurationSec : durationSec;
    try {
      const buffer = toMono(await ctx.decodeAudioData(fetched.bytes.slice(0)));
      const offsetSec =
        edge === 'head'
          ? 0
          : fetched.fellBackToFull
            ? Math.max(0, track - OUT_REGION_SEC)
            : Math.max(0, track - buffer.duration);
      return { buffer, offsetSec };
    } catch (error) {
      console.warn('automix: ranged decode refused, falling back to the full file', error);
      const full = await analyzer.audioBytes(videoId);
      const buffer = toMono(await ctx.decodeAudioData(full.slice(0)));
      return { buffer, offsetSec: edge === 'head' ? 0 : Math.max(0, track - OUT_REGION_SEC) };
    }
  }

  /** BitChord: puts the loop mix on the clock: the outgoing element hands over at its loop start. */
  private async scheduleLoop(cur: TrackAnalysis): Promise<void> {
    const plan = this.loopPlan!;
    const queued = this.host.next();
    if (!this.loopDecks || queued?.videoId !== plan.in.key || cur.fileKey !== plan.out.key) {
      this.loopPlan = null;
      return;
    }
    const from = this.host.front();
    const to = this.host.back();
    await from.anchorPrecise();
    const now = this.host.ctx.currentTime;
    const t0 = from.timeline.ctxTimeAt(plan.out.loop[0], now);
    if (t0 === null || t0 - now < 1) {
      this.loopPlan = null;
      return;
    }
    const [outDeck, inDeck] = this.loopDecks;
    // BitChord, Phase 0: the incoming deck sits at lufsOut - lufsIn (capped
    // at +/-6 dB), and its element keeps the compensation at the handover.
    const comp = incomingGainCompensation(cur, analyzer.get(plan.in.key));
    const times = scheduleLoopMix(plan, outDeck, inDeck, t0, comp);
    this.host.hold(true);

    // the outgoing element hands its sound to the deck at the loop start, then pauses
    const og = from.gain.gain;
    og.cancelScheduledValues(now);
    og.setValueAtTime(1, t0 - 0.025);
    og.linearRampToValueAtTime(0, t0);
    from.pauseAt(t0 + 0.06);
    // the incoming element starts unheard 1.5 s early, held to the deck's clock, and takes over
    const ig = to.gain.gain;
    ig.cancelScheduledValues(now);
    ig.setValueAtTime(0, now);
    ig.setValueAtTime(0, times.elementAt);
    ig.linearRampToValueAtTime(comp, times.elementAt + 0.025);
    to.eq.reset();
    to.playAt({ ctxTime: times.elementAt - 1.5, trackTime: times.elementTrackTime - 1.5, rate: 1 });
    to.lock(null);

    this.loopTimes = times;
    this.plan = {
      t0,
      durationSec: times.elementAt - t0,
      mixInTrackTime: plan.in.loop[0],
      mixOutTrackTime: plan.out.loop[0],
      rate: plan.fold,
      fallback: false,
      style: 'loop',
      reason: null,
    };
    this.blend = { from, to, handedOff: false };
    this.window = { videoId: cur.fileKey, startSec: plan.out.loop[0], endSec: plan.out.loop[1] };
    this.beatSec = plan.out.beatSec;
    this.state = 'scheduled';
    this.pendingEvent = this.eventFor(cur, analyzer.get(plan.in.key)!, this.plan);
  }

  private completeTransition(): void {
    // BitChord, Phase 0: the mix ended — the event closes, completed. A mix
    // that ends without a handoff hands over right now, opening the window.
    if (this.pendingEvent) {
      if (this.pendingEvent.handedOffAt === null) markHandoff(this.pendingEvent);
      this.pendingEvent.outcome = 'completed';
      recordTransition(this.pendingEvent);
      this.pendingEvent = null;
    }
    const blend = this.blend;
    if (blend && this.loopTimes && this.loopDecks) {
      for (const d of this.loopDecks) d.stop();
      this.loopTimes = null;
      this.host.hold(false);
    }
    this.loopPlan = null;
    this.loopPreparing = null;
    this.planDegraded = false;
    if (blend) {
      if (!blend.handedOff) this.host.handoff();
      blend.from.cancel();
      blend.to.unfollow();
      // the incoming deck keeps its rate glide (posted up to ~24 s ahead); it
      // releases itself once that is played out
      this.settling = blend.to;
      releaseWhenSettled(blend.to, () => this.settling === blend.to);
      this.host.finished();
    }
    if (this.currentKey) this.history.unshift(this.currentKey);
    if (this.nextKey) this.history.unshift(this.nextKey);
    this.history.length = Math.min(this.history.length, 50);
    this.currentKey = this.nextKey;
    this.nextKey = null;
    this.nextLoadedKey = null;
    this.plan = null;
    this.blend = null;
    this.window = null;
    this.candidates = [];

    this.state = 'playing';
  }

  private push(): void {
    this.onUpdate(this.snapshot);
  }
}

function tags(t: QueuedTrack) {
  return { title: t.title, artist: t.artist };
}

/**
 * The loop decks' decode, mono. The ranged edges hold the whole stretch each
 * deck plays; keeping them single-channel is what holds the mix's steady
 * memory near the 22 MB target — the stretch worklet duplicates a mono
 * buffer to stereo itself.
 */
function toMono(buffer: AudioBuffer): AudioBuffer {
  if (buffer.numberOfChannels === 1) return buffer;
  const out = new AudioBuffer({
    numberOfChannels: 1,
    length: buffer.length,
    sampleRate: buffer.sampleRate,
  });
  const data = out.getChannelData(0);
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  for (let i = 0; i < data.length; i++) data[i] = (left[i]! + right[i]!) * 0.5;
  return out;
}

/** A track with no analysis yet: no grid, so the scheduler takes AutoMix's plain-crossfade fallback. */
function stubAnalysis(t: QueuedTrack, durationSec: number): TrackAnalysis {
  return {
    fileKey: t.videoId,
    path: `youtube:${t.videoId}`,
    tags: tags(t),
    durationSec,
    bpm: null,
    beatIntervalSec: null,
    firstDownbeatSec: null,
    gridConfidence: 0,
    camelot: null,
    keyName: null,
    keyConfidence: 0,
    energy: 0.5,
    energyCurve: [],
    introEndSec: null,
    outroStartSec: null,
    analysisVersion: 0,
  };
}

/** The glide's last step lands at blend end + 24 s; hold the servo until no rate change is left ahead. */
function releaseWhenSettled(deck: Deck, isCurrent: () => boolean) {
  const check = () => {
    if (!isCurrent()) return;
    const now = deck.ctx.currentTime;
    if (Math.abs(deck.timeline.rateAt(now + 60) - deck.timeline.rateAt(now)) < 1e-6) deck.release();
    else setTimeout(check, 1000);
  };
  setTimeout(check, 1000);
}
