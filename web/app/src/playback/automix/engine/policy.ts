// BitChord, Automix 2.0 Phase 0: the cheap policy gestures — silence trim,
// false ending, and the GAP style — as pure functions over the analysis, plus
// the gain compensation LUFS feeds the loop decks. Phase 1 scores and tunes
// these; here they only hold the obvious lines.
//
// Phase 1 change: the gestures read ENERGY SPANS. The ladder measures the
// track's edges first (L0) and its whole curve last (L3), so every curve read
// here goes through a CurveView — "this curve, its frame size, and where it
// starts on the track" — and takes whichever span covers the edge it cares
// about, falling back to the whole-track curve a monolithic analysis stored.
// All thresholds are relative to the view's own spread, so a span normalized
// to its own peak and a curve normalized to the track's read the same.

import type { TrackAnalysis } from '../analysis/types';

/** The [p] quantile of [values], as loopMix reads its loudness stretch (60th percentile). */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

/** A curve read as a gesture reads it: samples, their frame size, and the track time sample 0 sits at. */
export interface CurveView {
  curve: number[];
  windowSec: number;
  startSec: number;
  /** The track time the view's coverage ends at. */
  endSec: number;
}

/** The whole-track curve, when the analysis carries one. */
export function wholeView(a: TrackAnalysis): CurveView | null {
  if (!a.energyCurve.length || a.durationSec <= 0) return null;
  return { curve: a.energyCurve, windowSec: a.durationSec / a.energyCurve.length, startSec: 0, endSec: a.durationSec };
}

/** The first energy span, when it covers the track's opening. */
export function headView(a: TrackAnalysis, headSec: number): CurveView | null {
  const span = a.energySpans?.find((s) => s.startSec <= 0.5);
  if (!span || !span.curve.length) return wholeView(a);
  const end = span.startSec + span.curve.length * span.windowSec;
  // The gesture wants the opening; a span that stops short of it is still
  // the best evidence there is (the mix-in point lives in the first bars).
  if (end < Math.min(headSec * 0.5, 2)) return wholeView(a);
  return { curve: span.curve, windowSec: span.windowSec, startSec: span.startSec, endSec: end };
}

/** The last energy span, when it reaches the track's end. */
export function tailView(a: TrackAnalysis, tailSec: number): CurveView | null {
  const spans = a.energySpans ?? [];
  let span = null;
  for (const s of spans) {
    const end = s.startSec + s.curve.length * s.windowSec;
    if (a.durationSec - end <= 0.5 && (span === null || s.startSec < span.startSec)) span = s;
  }
  if (!span || !span.curve.length) return wholeView(a);
  const end = span.startSec + span.curve.length * span.windowSec;
  if (a.durationSec - end > tailSec) return wholeView(a);
  return { curve: span.curve, windowSec: span.windowSec, startSec: span.startSec, endSec: end };
}

/** Seconds of curve that stays under [threshold] from [fromSec] to the view's end. */
export function trailingSilenceSec(view: CurveView, fromSec: number, threshold: number): number {
  const fromIdx = Math.max(0, Math.ceil((fromSec - view.startSec) / view.windowSec));
  let last = fromIdx * view.windowSec;
  for (let i = fromIdx; i < view.curve.length; i++) {
    if (view.curve[i]! > threshold) last = (i + 1) * view.windowSec;
  }
  return Math.max(0, view.curve.length * view.windowSec - last);
}

/**
 * Where the last audible content ends (track seconds), or null when nothing
 * is distinguishable from silence. Audible means above the span's own floor:
 * the higher of a small absolute floor and a third of the typical (60th
 * percentile) energy — relative, as the false-ending rule asks.
 */
export function contentEndOf(view: CurveView, durationSec: number, typical: number): number | null {
  const threshold = Math.max(0.04, typical * 0.3);
  for (let i = view.curve.length - 1; i >= 0; i--) {
    if (view.curve[i]! > threshold) return Math.min(durationSec, view.startSec + (i + 1) * view.windowSec);
  }
  return null;
}

/**
 * FALSE ENDING: energy rises again more than 8 s after the outro — the outro
 * is suspicious. Typical is the span's own 60th percentile, never an
 * absolute value.
 */
export const FALSE_ENDING_LAG_SEC = 8;
export function isFalseEnding(
  view: CurveView,
  outroStartSec: number,
  durationSec: number,
  typical: number,
): boolean {
  const from = outroStartSec + FALSE_ENDING_LAG_SEC;
  if (from >= Math.min(durationSec, view.endSec)) return false;
  for (let i = Math.max(0, Math.ceil((from - view.startSec) / view.windowSec)); i < view.curve.length; i++) {
    if (view.curve[i]! >= typical) return true;
  }
  return false;
}

/**
 * The outgoing mix-out anchor after the gestures: where the outro was
 * detected, unless more than 10 s of sub-threshold tail follows it — then
 * the last audible content (SILENCE TRIM; Apple AutoMix's most cited defect
 * was mixing silence) — and when the outro was rejected as false, the
 * content end itself.
 */
export function mixOutAnchor(a: TrackAnalysis): number {
  const outro = a.outroStartSec ?? a.contentEndSec ?? a.durationSec;
  if (a.contentEndSec != null && outro - a.contentEndSec > SILENCE_TRIM_SEC) return a.contentEndSec;
  return outro;
}

/** Silence trim: a tail quieter than this, for longer than this, is not mixed. */
export const SILENCE_TRIM_SEC = 10;

/**
 * GAP: a melodic close in A (sustained low energy over the last ~8 s) and a
 * clear opener in B (rising energy on its first downbeat) — the pair that
 * sounds wrong overlapped and right as clean silence. Read from the edge
 * spans when the ladder has produced them, the whole curve otherwise.
 */
export const GAP_TAIL_SEC = 8;
export function detectGap(out: TrackAnalysis, inn: TrackAnalysis): boolean {
  const tail = tailView(out, GAP_TAIL_SEC);
  if (!tail) return false;
  const typical = percentile(tail.curve, 0.6);
  // sustained low: nothing in the tail at the span's typical level, and its
  // mean well under
  const fromIdx = Math.max(0, Math.ceil((out.durationSec - GAP_TAIL_SEC - tail.startSec) / tail.windowSec));
  if (tail.curve.length - fromIdx < 2) return false;
  let sum = 0;
  for (let i = fromIdx; i < tail.curve.length; i++) {
    if (tail.curve[i]! >= typical * 0.5) return false;
    sum += tail.curve[i]!;
  }
  if (sum / Math.max(1, tail.curve.length - fromIdx) >= typical * 0.35) return false;

  // clear opener: the first downbeat enters on rising energy
  const fd = inn.firstDownbeatSec;
  if (fd === null || fd >= inn.durationSec - tail.windowSec) return false;
  const head = headView(inn, Math.max(4, fd + 4 * tail.windowSec));
  if (!head || head.curve.length < 3 || fd < head.startSec) return false;
  const k = Math.min(head.curve.length - 2, Math.floor((fd - head.startSec) / head.windowSec));
  return head.curve[k + 1]! > head.curve[k]!;
}

/**
 * Gain compensation for the incoming deck: lufsOut - lufsIn, capped at
 * +/-6 dB. 1.0 when either side has no measurement. Phase 1 prefers the
 * edge spans — the tail the outgoing track is leaving through and the head
 * the incoming one enters on are what the mix actually hears — and falls
 * back to the whole-track figures an older analysis carries.
 */
export function incomingGainCompensation(out: TrackAnalysis | null, inn: TrackAnalysis | null): number {
  const outDb = mixLufsOf(out, 'tail');
  const inDb = mixLufsOf(inn, 'head');
  if (outDb === null || inDb === null) return 1;
  const db = Math.max(-6, Math.min(6, outDb - inDb));
  return 10 ** (db / 20);
}

/**
 * The loudness of the track's mixable edge: the tail span for the outgoing
 * side, the head span for the incoming one, the whole track where only that
 * was measured. Null when nothing has.
 */
export function mixLufsOf(a: TrackAnalysis | null, edge: 'head' | 'tail'): number | null {
  if (!a) return null;
  if (edge === 'tail') return a.lufsTail ?? a.lufs ?? null;
  return a.lufsHead ?? a.lufs ?? null;
}
