// BitChord, Automix 2.0 Phase 0: every mix decision, recorded and readable.
//
// The later phases (analysis ladder, scoring) are decided against real pairs,
// not intentions, so each planned transition is recorded — style, what was
// rejected and why, the confidences the gates read — and a skip of the
// incoming track within the skip window annotates the event it followed.
// Local only: a localStorage ring of ~500 events, read back by the mix
// report (shell/NerdStats.tsx). Nothing leaves the device.

export type MixStyle = 'loop' | 'blend' | 'filter' | 'crossfade' | 'gap';

export interface RejectedStyle {
  style: MixStyle;
  /** The gate that killed the candidate, in the plan's own words. */
  reason: string;
}

export interface MixConfidences {
  outGrid: number;
  inGrid: number;
  vocalOverlap: number | null;
  deltaTempoPct: number | null;
  deltaLufs: number | null;
}

export interface TransitionEvent {
  /** Wall-clock ms the plan was scheduled. */
  at: number;
  /** "videoIdA>videoIdB": outgoing > incoming. */
  pair: string;
  styleChosen: MixStyle;
  rejectedStylesAndWhy: RejectedStyle[];
  /** The plan's own reason field (why the pair wasn't beatmatched, etc.). */
  reason: string | null;
  confidences: MixConfidences;
  /**
   * Both songs' analyses were ready with usable grids when the blend was
   * planned — the analysis race Phase 1 fixes, counted per event.
   */
  bothGridsReady: boolean;
  /**
   * BitChord, Phase 1: the plan was made at the t-60 deadline on whatever
   * evidence existed — a phrase-aligned FADE standing in for the real mix.
   * The race was lost for this pair; the report counts these apart.
   */
  deadlinePlanned?: boolean;
  outcome: 'completed' | 'aborted';
  /** Seconds from handoff to the user advancing the incoming track, or null. */
  skipAfterSec: number | null;
  /** Wall-clock ms of the handoff; null when the mix aborted before it. */
  handedOffAt: number | null;
}

/** A user advance of the incoming track counts only this long after the handoff. */
export const TRANSITION_SKIP_WINDOW_SEC = 30;

const STORAGE_KEY = 'bitchord:automix-events';
const MAX_EVENTS = 500;

/** The most recent planned transition still in flight, patched by the skip hook. */
let openEvent: TransitionEvent | null = null;

function readEvents(): TransitionEvent[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TransitionEvent[]) : [];
  } catch {
    return [];
  }
}

function writeEvents(events: TransitionEvent[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(events.slice(-MAX_EVENTS)));
  } catch {
    // private mode or a full quota: the session report still reads from memory
  }
}

/**
 * Records a finished (or aborted) transition. [event] is the same object the
 * AutoDJ built when it scheduled the mix, so a skip annotated before
 * completion rides along.
 */
export function recordTransition(event: TransitionEvent): void {
  if (openEvent === event) openEvent = null;
  writeEvents([...readEvents(), event]);
}

/** The mix handed over to [event]'s incoming track: opens the skip window. */
export function markHandoff(event: TransitionEvent): void {
  event.handedOffAt = Date.now();
  openEvent = event;
}

/**
 * The user advanced the current track on purpose. If it is the incoming
 * track of a recent handoff, inside the window, that transition gets
 * skipAfterSec. Nothing more: Phase 0 records, it does not score.
 */
export function annotateSkip(videoId: string, nowMs: number = Date.now()): void {
  const patch = (event: TransitionEvent) => {
    if (event.skipAfterSec !== null || event.handedOffAt === null) return false;
    if (nowMs - event.handedOffAt > TRANSITION_SKIP_WINDOW_SEC * 1000) return false;
    if (!event.pair.endsWith(`>${videoId}`)) return false;
    event.skipAfterSec = (nowMs - event.handedOffAt) / 1000;
    return true;
  };
  if (openEvent && patch(openEvent)) return;
  // already recorded (the transition completed): patch the stored event
  const events = readEvents();
  for (let i = events.length - 1; i >= 0 && i >= events.length - 5; i--) {
    if (patch(events[i]!)) {
      writeEvents(events);
      return;
    }
  }
}

export function loadEvents(): TransitionEvent[] {
  return readEvents();
}

// ---- The mix report -----------------------------------------------------------------------

export interface StyleStat {
  style: MixStyle;
  count: number;
  /** Events with a skip / completed events of the style, or null with none completed. */
  skipRate: number | null;
}

export interface ReportStats {
  /** All events in the span, completed and aborted. */
  total: number;
  completed: number;
  styles: StyleStat[];
  /** The plan's degradation reasons, most common first. */
  topReasons: { reason: string; count: number }[];
  /** Share of events planned with both grids ready: the analysis race. */
  hitRate: number;
  /** Events planned at the t-60 deadline on whatever evidence existed (Phase 1). */
  deadlinePlanned: number;
}

export function aggregate(events: TransitionEvent[]): ReportStats {
  const completed = events.filter((e) => e.outcome === 'completed');
  const byStyle = new Map<MixStyle, TransitionEvent[]>();
  for (const e of events) {
    const list = byStyle.get(e.styleChosen) ?? [];
    list.push(e);
    byStyle.set(e.styleChosen, list);
  }
  const styles: StyleStat[] = [...byStyle.entries()]
    .map(([style, list]) => {
      const done = list.filter((e) => e.outcome === 'completed');
      const skipped = done.filter((e) => e.skipAfterSec !== null).length;
      return { style, count: list.length, skipRate: done.length ? skipped / done.length : null };
    })
    .sort((a, b) => b.count - a.count);
  const reasons = new Map<string, number>();
  for (const e of completed) {
    for (const reason of [e.reason, ...e.rejectedStylesAndWhy.map((r) => r.reason)]) {
      if (!reason) continue;
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
  }
  const ready = events.filter((e) => e.bothGridsReady).length;
  return {
    total: events.length,
    completed: completed.length,
    styles,
    topReasons: [...reasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
    hitRate: events.length ? ready / events.length : 0,
    deadlinePlanned: events.filter((e) => e.deadlinePlanned).length,
  };
}

/** The page-load wall time, so a session is the events since the app opened. */
function sessionOriginMs(): number {
  return Date.now() - performance.now();
}

export function mixReport(): { session: ReportStats; aggregate: ReportStats } {
  const events = loadEvents();
  const origin = sessionOriginMs();
  return { session: aggregate(events.filter((e) => e.at >= origin)), aggregate: aggregate(events) };
}
