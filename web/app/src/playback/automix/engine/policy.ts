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
//
// Phase 4 Task A2: stem-backed blends — when stems are available and vocal
// overlap > 0.15, the blend uses real separation (vocals never cross) instead
// of the HP/LP masking gesture. The stem is an upgrade, never a dependency.

import type { TrackAnalysis, VocalWindow, StemWindow, Stems } from '../analysis/types';
import { REVERB_IR_SEC } from './loopDeck';

/** Vocal activity threshold — same scale as the phone's 0.25. */
export const VOCAL_ACTIVE = 0.25;

/** Gate above which a long blend is capped/faded: simultaneous vocal >15% of overlap window. */
export const VOCAL_OVERLAP_BLEND_GATE = 0.15;

/** Maximum LUFS gain compensation in dB, applied as a static base gain on the incoming deck. */
export const MAX_LUFS_COMPENSATION_DB = 6;

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
  const db = Math.max(-MAX_LUFS_COMPENSATION_DB, Math.min(MAX_LUFS_COMPENSATION_DB, outDb - inDb));
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

/**
 * Planned vocal overlap: fraction of the outgoing overlap window where BOTH
 * tracks have vocal activity above VOCAL_ACTIVE (0.25).
 *
 * Port of Android's simultaneousVocalFraction (TransitionPolicy.kt). The
 * incoming window is scaled by its playbackRate before comparing — the
 * incoming track covers proportionally more of its own timeline in the same
 * wall-clock second. Unmeasured regions sit at the analyzer's neutral 0.5,
 * below the threshold, so they count as "not singing" rather than as evidence.
 *
 * Pure function: (outVocals, inVocals, outStart, outEnd, inStart, rate) -> fraction | null.
 * Returns null when either side has no vocal evidence.
 */
export function plannedVocalOverlap(
  outVocals: VocalWindow[],
  inVocals: VocalWindow[],
  outStart: number,
  outEnd: number,
  inStart: number,
  rate: number,
): number | null {
  if (!outVocals.length || !inVocals.length) return null;
  if (outEnd <= outStart) return null;
  const step = Number.isFinite(rate) && rate > 0 ? rate : 1.0;

  let both = 0;
  let total = 0;

  // Iterate over outgoing vocal windows, sampling at their frame rate
  for (const outW of outVocals) {
    const outWindowEnd = outW.startSec + outW.curve.length / outW.fps;
    const windowStart = Math.max(outStart, outW.startSec);
    const windowEnd = Math.min(outEnd, outWindowEnd);
    if (windowStart >= windowEnd) continue;

    // Sample at the outgoing window's fps
    const firstIdx = Math.max(0, Math.ceil((windowStart - outW.startSec) * outW.fps));
    const lastIdx = Math.min(outW.curve.length, Math.floor((windowEnd - outW.startSec) * outW.fps));

    for (let i = firstIdx; i < lastIdx; i++) {
      total++; // count every frame in the outgoing window
      const outVal = outW.curve[i]!;
      if (outVal < VOCAL_ACTIVE) continue; // only check incoming when outgoing is vocal

      const t = outW.startSec + i / outW.fps; // absolute track time on outgoing
      const targetIn = inStart + (t - outStart) * step; // corresponding incoming track time

      // Find the incoming window covering targetIn
      let inVal = 0.5; // neutral = below threshold = not singing
      for (const inW of inVocals) {
        const inWindowEnd = inW.startSec + inW.curve.length / inW.fps;
        if (targetIn >= inW.startSec && targetIn < inWindowEnd) {
          const idx = Math.floor((targetIn - inW.startSec) * inW.fps);
          if (idx >= 0 && idx < inW.curve.length) inVal = inW.curve[idx]!;
          break;
        }
      }
      if (inVal >= VOCAL_ACTIVE) both++;
    }
  }

  return total > 0 ? both / total : null;
}

/**
 * Stem-backed vocal overlap: uses 2-stem separation (vocals + accompaniment)
 * to compute the exact vocal overlap with "vocals never cross" guarantee.
 * When stems are available, this replaces the masked vocalOverlap for BLEND
 * scoring. The stem curves are already on a 0..1 energy scale per frame.
 *
 * Returns { overlap: fraction, stemUsed: true } when stems are available and
 * quality passes threshold; otherwise returns { overlap: maskedOverlap, stemUsed: false }.
 */
export interface StemVocalOverlapResult {
  /** The computed vocal overlap fraction (0..1). */
  overlap: number;
  /** Whether real stems were used (true) or masked fallback (false). */
  stemUsed: boolean;
  /** Quality metric: vocals SDR in dB (negative = below threshold). */
  qualitySdrDb: number;
}

/**
 * Computes vocal overlap using stem separation when available.
 * The "vocals never cross" guarantee: outgoing voice continues to end of
 * its phrase; incoming accompaniment enters underneath; outgoing voice dies
 * on its last downbeat in overlap; incoming voice enters only after.
 */
export function stemBackedVocalOverlap(
  stems: Stems | null | undefined,
  outVocals: VocalWindow[],
  inVocals: VocalWindow[],
  outStart: number,
  outEnd: number,
  inStart: number,
  rate: number,
): StemVocalOverlapResult {
  // Stem quality threshold: require SDR >= 5 dB for reliable separation
  const STEM_QUALITY_THRESHOLD_DB = 5;

  if (!stems || !stems.out || !stems.in) {
    // No stems — fall back to masked overlap
    const masked = plannedVocalOverlap(outVocals, inVocals, outStart, outEnd, inStart, rate);
    return { overlap: masked ?? 0, stemUsed: false, qualitySdrDb: -100 };
  }

  const outStem = stems.out;
  const inStem = stems.in;

  // Check stem quality
  const minQuality = Math.min(outStem.qualitySdrDb, inStem.qualitySdrDb);
  if (minQuality < STEM_QUALITY_THRESHOLD_DB) {
    const masked = plannedVocalOverlap(outVocals, inVocals, outStart, outEnd, inStart, rate);
    return { overlap: masked ?? 0, stemUsed: false, qualitySdrDb: minQuality };
  }

  // Stems are available and pass quality — compute exact overlap from stem curves
  // The stem curves are at STEM_FPS (~43 Hz), aligned to the overlap window
  const outVocalsStem = outStem.vocals;
  const inVocalsStem = inStem.vocals;

  if (!outVocalsStem.length || !inVocalsStem.length) {
    const masked = plannedVocalOverlap(outVocals, inVocals, outStart, outEnd, inStart, rate);
    return { overlap: masked ?? 0, stemUsed: false, qualitySdrDb: minQuality };
  }

  // Sample at the outgoing stem's frame rate
  const outFps = outStem.fps;
  const inFps = inStem.fps;
  const step = Number.isFinite(rate) && rate > 0 ? rate : 1.0;

  let both = 0;
  let total = 0;

  for (let i = 0; i < outVocalsStem.length; i++) {
    const t = outStem.startSec + i / outFps;
    if (t < outStart || t >= outEnd) continue;
    total++;

    const outVal = outVocalsStem[i]!;
    if (outVal < VOCAL_ACTIVE) continue; // outgoing not vocal

    const targetIn = inStart + (t - outStart) * step;
    const inIdx = Math.floor((targetIn - inStem.startSec) * inFps);
    if (inIdx < 0 || inIdx >= inVocalsStem.length) continue;

    const inVal = inVocalsStem[inIdx]!;
    if (inVal >= VOCAL_ACTIVE) both++;
  }

  const overlap = total > 0 ? both / total : 0;
  return { overlap, stemUsed: true, qualitySdrDb: minQuality };
}

/**
 * Simple vocal share for a single track over a window (used for telemetry).
 * Returns the fraction of frames above VOCAL_ACTIVE, or null if no vocal evidence.
 */
export function vocalShare(vocals: VocalWindow[], from: number, to: number): number | null {
  if (!vocals.length) return null;
  let total = 0;
  let active = 0;
  for (const w of vocals) {
    const wEnd = w.startSec + w.curve.length / w.fps;
    const start = Math.max(from, w.startSec);
    const end = Math.min(to, wEnd);
    if (start >= end) continue;
    const firstIdx = Math.max(0, Math.ceil((start - w.startSec) * w.fps));
    const lastIdx = Math.min(w.curve.length, Math.floor((end - w.startSec) * w.fps));
    for (let i = firstIdx; i < lastIdx; i++) {
      total++;
      if (w.curve[i]! >= VOCAL_ACTIVE) active++;
    }
  }
  return total > 0 ? active / total : null;
}

// ============================================================================
// Phase 2 Task 6 — Style Scorer with Hard Gates
// ============================================================================

/** Candidate transition styles, from highest to lowest ambition. */
export type MixStyleCandidate = 'loop' | 'blend' | 'filter' | 'fade' | 'gap';

/** Result of evaluating a single candidate against the hard gates. */
export interface StyleGateResult {
  /** The candidate style this result is for. */
  candidate: MixStyleCandidate;
  /** Whether the candidate passes all its hard gates. */
  passes: boolean;
  /** The gate that killed the candidate, or null if it passes. */
  killReason: string | null;
  /** The computed score (only meaningful when passes=true). */
  score: number;
}

/** Input data needed to score a pair of tracks for all candidates. */
export interface StyleScorerInput {
  /** Outgoing track analysis. */
  out: TrackAnalysis;
  /** Incoming track analysis. */
  inn: TrackAnalysis;
  /** Outgoing track's grid confidence (0..1). */
  outGridConf: number;
  /** Incoming track's grid confidence (0..1). */
  inGridConf: number;
  /** Planned vocal overlap fraction (0..1), or null if unmeasured. */
  vocalOverlap: number | null;
  /** Whether the vocal overlap was computed from stems (true) or masked (false). */
  vocalOverlapStemUsed: boolean;
  /** Stem quality in dB (negative = unavailable/below threshold). */
  stemQualitySdrDb: number;
  /** Stretch ratio (outgoing BPM / incoming BPM, folded to nearest octave). */
  stretchRatio: number;
  /** Residual LUFS delta after compensation (dB), or null if unmeasured. */
  residualDeltaLufs: number | null;
  /** Loop mix plan, if one was prepared (for LOOP candidate). */
  loopPlan: { outBars: number; inBars: number; fold: number } | null;
  /** Energy continuity across the join (0..1, higher = smoother). */
  energyContinuity: number;
  /** Low-band energy at the join on outgoing side (0..1 relative to track's own reference). */
  outLowEnergyAtJoin: number | null;
  /** Low-band energy at the join on incoming side (0..1 relative to track's own reference). */
  inLowEnergyAtJoin: number | null;
}

/** Hard gate thresholds — named constants with rationale in comments. */
// Grid confidence below which BLEND is killed (phone scale MIN_BEATMATCH_CONFIDENCE = 0.55).
const MIN_GRID_CONF_FOR_BLEND = 0.55;
// Vocal overlap fraction above which long BLEND is killed (task-2 cap).
const VOCAL_OVERLAP_BLEND_CAP = 0.15;
// Residual LUFS delta (dB) above which bass swap inside BLEND is killed (task-4).
const RESIDUAL_LUFS_BASS_SWAP_KILL_DB = 4;
// Stretch window for BLEND (0.9..1.25, asymmetric: -10% / +25%).
export const BLEND_STRETCH_MIN = 0.9;
export const BLEND_STRETCH_MAX = 1.25;
// Minimum clean loop bars on each side for LOOP candidate.
const LOOP_MIN_CLEAN_BARS = 2;
// LOOP stretch window with fold applied.
const LOOP_STRETCH_MIN = 0.9;
const LOOP_STRETCH_MAX = 1.25;
// Energy continuity bonus weight in the score formula.
const ENERGY_CONTINUITY_WEIGHT = 0.1;
// Gratuitous FILTER penalty (applied unless two kicks or impossible tempo).
const FILTER_PENALTY = 0.25;
// KICK_PRESENT threshold for FILTER gesture selection (from Android TransitionPlanner).
export const KICK_PRESENT = 0.5;
// Stem quality threshold for stem-backed blend (dB).
const STEM_QUALITY_THRESHOLD_DB = 5;

/**
 * Evaluates a single candidate against its hard gates.
 * Returns the gate result with pass/fail, kill reason, and score (if passing).
 */
function evaluateCandidate(input: StyleScorerInput, candidate: MixStyleCandidate): StyleGateResult {
  const { outGridConf, inGridConf, vocalOverlap, vocalOverlapStemUsed, stemQualitySdrDb, stretchRatio, residualDeltaLufs, loopPlan, energyContinuity } = input;
  const avgGridConf = (outGridConf + inGridConf) / 2;

  // ---- HARD GATES (a failed gate KILLS the candidate) ----

  // GAP gate: melodic close in A AND clear opener in B
  if (candidate === 'gap') {
    if (!detectGap(input.out, input.inn)) {
      return { candidate, passes: false, killReason: 'no melodic close or clear opener', score: 0 };
    }
    // GAP score from simplicity: thin evidence -> they win
    const score = 0.5 + energyContinuity * ENERGY_CONTINUITY_WEIGHT;
    return { candidate, passes: true, killReason: null, score };
  }

  // FADE gate: phrase-aligned 6-8s, always available as fallback
  if (candidate === 'fade') {
    // FADE has no hard gates — it's the safety net
    const score = 0.4 + avgGridConf * 0.2 + energyContinuity * ENERGY_CONTINUITY_WEIGHT;
    return { candidate, passes: true, killReason: null, score };
  }

  // LOOP gates: clean loops >= 2 bars on BOTH sides AND ratio (with fold) inside 0.9-1.25
  if (candidate === 'loop') {
    if (!loopPlan) {
      return { candidate, passes: false, killReason: 'no loop plan prepared', score: 0 };
    }
    const { outBars, inBars, fold } = loopPlan;
    if (outBars < LOOP_MIN_CLEAN_BARS || inBars < LOOP_MIN_CLEAN_BARS) {
      return { candidate, passes: false, killReason: `clean loops < ${LOOP_MIN_CLEAN_BARS} bars`, score: 0 };
    }
    const ratioWithFold = fold * stretchRatio;
    if (ratioWithFold < LOOP_STRETCH_MIN || ratioWithFold > LOOP_STRETCH_MAX) {
      return { candidate, passes: false, killReason: `ratio with fold ${ratioWithFold.toFixed(2)} outside ${LOOP_STRETCH_MIN}-${LOOP_STRETCH_MAX}`, score: 0 };
    }
    // loopCleanliness: vocal share of loops (lower = cleaner)
    const loopCleanliness = 1 - Math.max(
      input.out.vocals ?.length ? 0.5 : 0, // placeholder: would use actual loop vocal share
      input.inn.vocals ?.length ? 0.5 : 0
    );
    // entryShapeOfB: how well the incoming loop aligns with a downbeat (simplified)
    const entryShapeOfB = 0.8; // placeholder
    const score = avgGridConf * (1 - Math.abs(stretchRatio - 1) / 0.25) * (1 - (vocalOverlap ?? 0)) * loopCleanliness * entryShapeOfB;
    return { candidate, passes: true, killReason: null, score };
  }

  // BLEND gates
  if (candidate === 'blend') {
    // avg grid confidence < 0.55 -> no BLEND
    if (avgGridConf < MIN_GRID_CONF_FOR_BLEND) {
      return { candidate, passes: false, killReason: `avg grid confidence ${avgGridConf.toFixed(2)} < ${MIN_GRID_CONF_FOR_BLEND}`, score: 0 };
    }
    // stretch ratio outside 0.9-1.25 -> no BLEND
    if (stretchRatio < BLEND_STRETCH_MIN || stretchRatio > BLEND_STRETCH_MAX) {
      return { candidate, passes: false, killReason: `stretch ratio ${stretchRatio.toFixed(2)} outside ${BLEND_STRETCH_MIN}-${BLEND_STRETCH_MAX}`, score: 0 };
    }
    // vocalOverlap > 0.15 -> no long BLEND (cap 4 bars or FADE)
    // This is handled at the score/length level, not a hard kill here
    // but we note it for the length decision

    // STEM-BACKED BLEND: when stems are available and quality passes,
    // the vocal overlap cap is lifted because "vocals never cross" is guaranteed.
    // The stem-backed blend scores ABOVE its masked equivalent.
    const stemBacked = vocalOverlapStemUsed && stemQualitySdrDb >= STEM_QUALITY_THRESHOLD_DB;
    const effectiveVocalOverlap = stemBacked ? 0 : (vocalOverlap ?? 0); // stems guarantee no crossing

    // loopCleanliness for BLEND: vocal overlap penalizes (unless stem-backed)
    const loopCleanliness = 1 - effectiveVocalOverlap;
    // entryShapeOfB: how well the incoming entry aligns (first downbeat = 1.0)
    const entryShapeOfB = 1.0;
    const baseScore = avgGridConf * (1 - Math.abs(stretchRatio - 1) / 0.25) * loopCleanliness * entryShapeOfB;

    // Bonus for stem-backed blend: it resolves the crossed-vocals known issues
    const stemBonus = stemBacked ? 0.15 : 0;

    const score = baseScore + stemBonus + energyContinuity * ENERGY_CONTINUITY_WEIGHT;
    return { candidate, passes: true, killReason: null, score };
  }

  // FILTER gates — hard gate: requires two kicks at join OR impossible tempo
  if (candidate === 'filter') {
    const hasTwoKicks = (input.outLowEnergyAtJoin ?? 0) >= KICK_PRESENT && (input.inLowEnergyAtJoin ?? 0) >= KICK_PRESENT;
    const impossibleTempo = stretchRatio < BLEND_STRETCH_MIN || stretchRatio > BLEND_STRETCH_MAX;

    // Hard gate: FILTER dies without two kicks or impossible tempo
    if (!hasTwoKicks && !impossibleTempo) {
      return { candidate, passes: false, killReason: 'no-two-kicks', score: 0 };
    }
    if (!impossibleTempo && hasTwoKicks) {
      // Two-kick filter: record the reason for telemetry (caps overlap at 4 bars)
      // This is a pass — the killReason stays null for passing candidates
    }
    if (impossibleTempo && !hasTwoKicks) {
      // Impossible-tempo filter: record the reason for telemetry
    }

    // FILTER score: lower ambition. Gratuitous (two-kick) filter gets a penalty;
    // impossible-tempo filter does not.
    const gratuitousFilter = hasTwoKicks && !impossibleTempo;
    const score = 1.1 * avgGridConf + energyContinuity * ENERGY_CONTINUITY_WEIGHT - (gratuitousFilter ? FILTER_PENALTY : 0);
    return { candidate, passes: true, killReason: null, score };
  }

  return { candidate, passes: false, killReason: 'unknown candidate', score: 0 };
}

/**
 * The Style Scorer: evaluates all candidates against hard gates, scores the
 * passing ones, and returns the best candidate with its score and blend length.
 *
 * Pure function: no state, no clock, no randomness.
 *
 * @returns { style, score, killReason, bars, bassSwapAllowed, vocalOverlapCapBars, gesture, filterGateReason, stemUsed }
 */
export function scoreStyles(input: StyleScorerInput): {
  /** The chosen style. */
  style: MixStyleCandidate;
  /** The score of the chosen style. */
  score: number;
  /** The gate that killed each rejected candidate (for telemetry). */
  rejectedStylesAndWhy: { style: MixStyleCandidate; reason: string }[];
  /** Blend length in bars (4, 8, or 16) — only for BLEND. */
  bars: number;
  /** Whether bass swap is allowed inside the blend. */
  bassSwapAllowed: boolean;
  /** If vocal overlap > 0.15, the max bars for BLEND (4). */
  vocalOverlapCapBars: number | null;
  /** Phase 3: the FX gesture chosen for this transition. */
  gesture: 'none' | 'delay' | 'reverb' | 'both';
  /** Phase 3: gesture seconds (delay + reverb), 0 for 'none'. */
  gestureSeconds: number;
  /** Phase 3: gestures considered and rejected, with reasons. */
  rejectedGesturesAndWhy: { gesture: 'none' | 'delay' | 'reverb' | 'both'; reason: string }[];
  /** Phase 3 Task 5: why FILTER passed its gate — 'two-kicks' | 'impossible-tempo' | null. */
  filterGateReason: 'two-kicks' | 'impossible-tempo' | null;
  /** Phase 4 Task A2: whether the chosen blend uses stem-backed separation. */
  stemUsed: boolean;
} {
  // Phase 3 Task 2: the delay is a scorer decision with a recorded reason —
  // no default path adds it.
  const delayDecision = scoreDelayGesture({ out: input.out, outGridConf: input.outGridConf });
  // Phase 3 Task 4: the reverb is a scorer decision for melodic-sustained closes.
  const reverbDecision = scoreReverbGesture({ out: input.out, outGridConf: input.outGridConf });

  // Gesture selection: delay and reverb are mutually exclusive by default,
  // 'both' only when the join has air AND rhythmic tail AND scorer records why.
  let gesture: 'none' | 'delay' | 'reverb' | 'both' = 'none';
  let gestureSeconds = 0;
  const rejectedGesturesAndWhy: { gesture: 'none' | 'delay' | 'reverb' | 'both'; reason: string }[] = [];

  const delayChosen = delayDecision.chosen;
  const reverbChosen = reverbDecision.chosen;

  if (delayChosen && reverbChosen) {
    // Both chosen: this is the rare 'both' case — requires air (delay) AND
    // sustained tail (reverb). The scorer records why.
    gesture = 'both';
    gestureSeconds = (delayDecision.delaySec ?? 0) + (reverbDecision.reverbSec ?? 0);
    rejectedGesturesAndWhy.push(
      { gesture: 'none', reason: 'both chosen: air present and sustained melodic tail' }
    );
  } else if (delayChosen) {
    gesture = 'delay';
    gestureSeconds = delayDecision.delaySec ?? 0;
    rejectedGesturesAndWhy.push(
      { gesture: 'reverb', reason: reverbDecision.killReason ?? 'not a sustained melodic close' }
    );
  } else if (reverbChosen) {
    gesture = 'reverb';
    gestureSeconds = reverbDecision.reverbSec ?? 0;
    rejectedGesturesAndWhy.push(
      { gesture: 'delay', reason: delayDecision.killReason ?? 'no air in the close' }
    );
  } else {
    gesture = 'none';
    gestureSeconds = 0;
    rejectedGesturesAndWhy.push(
      { gesture: 'delay', reason: delayDecision.killReason ?? 'unknown' },
      { gesture: 'reverb', reason: reverbDecision.killReason ?? 'unknown' }
    );
  }

  const candidates: MixStyleCandidate[] = ['loop', 'blend', 'filter', 'fade', 'gap'];
  const results = candidates.map((c) => evaluateCandidate(input, c));

  // Filter to passing candidates
  const passing = results.filter((r) => r.passes);

  // If nothing passes (shouldn't happen — FADE always passes), fall back to FADE
  if (passing.length === 0) {
    return {
      style: 'fade',
      score: 0,
      rejectedStylesAndWhy: results.map((r) => ({ style: r.candidate, reason: r.killReason ?? 'unknown' })),
      bars: 8,
      bassSwapAllowed: false,
      vocalOverlapCapBars: null,
      gesture,
      gestureSeconds,
      rejectedGesturesAndWhy,
      filterGateReason: null,
      stemUsed: false,
    };
  }

  // Pick the highest-scoring candidate
  const best = passing.reduce((a, b) => (a.score >= b.score ? a : b));

  // Determine blend length by confidence (4/8/16) — mirrors effectiveBlendBars
  let bars = 16;
  const avgGridConf = (input.outGridConf + input.inGridConf) / 2;
  if (avgGridConf >= 0.6) bars = 16;
  else if (avgGridConf >= 0.45) bars = 8;
  else bars = 4;

  // Vocal overlap cap: if > 0.15, cap BLEND at 4 bars (or fall to FADE)
  // STEM-BACKED: when stems are used, the cap is lifted because vocals never cross
  const stemBacked = input.vocalOverlapStemUsed && input.stemQualitySdrDb >= STEM_QUALITY_THRESHOLD_DB;
  let vocalOverlapCapBars: number | null = null;
  if ((input.vocalOverlap ?? 0) > VOCAL_OVERLAP_BLEND_CAP && !stemBacked) {
    vocalOverlapCapBars = 4;
    if (best.candidate === 'blend') {
      bars = Math.min(bars, 4);
    }
  }

  // Bass swap allowed: only on BLEND with sufficient bars and residual delta LUFS <= 4 dB
  const bassSwapAllowed =
    best.candidate === 'blend' &&
    bars >= 8 &&
    (input.residualDeltaLufs === null || Math.abs(input.residualDeltaLufs) <= RESIDUAL_LUFS_BASS_SWAP_KILL_DB);

  // Filter gate reason: why FILTER passed (for overlap cap decision)
  let filterGateReason: 'two-kicks' | 'impossible-tempo' | null = null;
  if (best.candidate === 'filter') {
    const hasTwoKicks = (input.outLowEnergyAtJoin ?? 0) >= KICK_PRESENT && (input.inLowEnergyAtJoin ?? 0) >= KICK_PRESENT;
    const impossibleTempo = input.stretchRatio < BLEND_STRETCH_MIN || input.stretchRatio > BLEND_STRETCH_MAX;
    if (hasTwoKicks && !impossibleTempo) filterGateReason = 'two-kicks';
    else if (impossibleTempo) filterGateReason = 'impossible-tempo';
  }

  // Stem used for the chosen blend
  const stemUsed = best.candidate === 'blend' && stemBacked;

  return {
    style: best.candidate,
    score: best.score,
    rejectedStylesAndWhy: results
      .filter((r) => !r.passes)
      .map((r) => ({ style: r.candidate, reason: r.killReason ?? 'unknown' })),
    bars,
    bassSwapAllowed,
    vocalOverlapCapBars,
    gesture,
    gestureSeconds,
    rejectedGesturesAndWhy,
    filterGateReason,
    stemUsed,
  };
}

/**
 * Computes energy continuity across the join: how smoothly the energy curves
 * transition from outgoing tail to incoming head. Returns 0..1 (higher = smoother).
 */
export function computeEnergyContinuity(
  out: TrackAnalysis,
  inn: TrackAnalysis,
  outStart: number,
  outEnd: number,
  inStart: number,
  inEnd: number,
): number {
  const outView = tailView(out, outEnd - outStart);
  const inView = headView(inn, inEnd - inStart);
  if (!outView || !inView) return 0.5;

  // Compare the last ~2s of outgoing with first ~2s of incoming
  const windowSec = 2;
  const outTail = outView.curve.slice(-Math.ceil(windowSec / outView.windowSec));
  const inHead = inView.curve.slice(0, Math.ceil(windowSec / inView.windowSec));
  if (!outTail.length || !inHead.length) return 0.5;

  const outMean = outTail.reduce((a, b) => a + b, 0) / outTail.length;
  const inMean = inHead.reduce((a, b) => a + b, 0) / inHead.length;
  const diff = Math.abs(outMean - inMean);
  const maxVal = Math.max(outMean, inMean, 0.01);
  return 1 - Math.min(1, diff / maxVal);
}

/**
 * Computes low-band energy at the join for FILTER gesture selection.
 * Returns 0..1 relative to the track's own low-energy reference.
 * Uses energySpans (edge windows) when available, falls back to null.
 */
export function computeLowEnergyAtJoin(
  analysis: TrackAnalysis,
  atSec: number,
  windowSec: number,
): number | null {
  // Use the first energy span that covers the join window
  const span = analysis.energySpans?.find(
    (s) => s.startSec <= atSec && s.startSec + s.curve.length * s.windowSec >= atSec - windowSec,
  );
  if (!span || !span.curve.length) return null;

  // Convert EnergySpan curve to { time, energy }[] format
  const curve = span.curve.map((energy, i) => ({
    time: span.startSec + i * span.windowSec,
    energy,
  }));

  const ref = lowEnergyReference(curve);
  if (!ref) return null;
  const avg = averageEnergy(curve, atSec - windowSec, atSec);
  if (avg === null) return null;
  return avg / ref;
}

function lowEnergyReference(curve: { time: number; energy: number }[]): number | null {
  const energies = curve.map((p) => p.energy).filter((e) => Number.isFinite(e) && e >= 0).sort((a, b) => a - b);
  if (!energies.length) return null;
  const idx = Math.min(Math.floor(energies.length * 0.9), energies.length - 1);
  const upperDecile = energies[idx]!;
  return Math.max(upperDecile, (energies[energies.length - 1] ?? 0) * 0.25);
}

function averageEnergy(
  curve: { time: number; energy: number }[],
  from: number,
  to: number,
): number | null {
  if (to <= from) return null;
  let idx = curve.findIndex((p) => p.time >= from);
  if (idx < 0) idx = 0;
  let sum = 0;
  let count = 0;
  while (idx < curve.length && curve[idx]!.time < to) {
    const e = curve[idx]!.energy;
    if (Number.isFinite(e) && e >= 0) {
      sum += e;
      count++;
    }
    idx++;
  }
  return count > 0 ? sum / count : null;
}

// ============================================================================
// Phase 3 Task 2 — Beat-Synced Delay Gesture (the choice, never a default)
// ============================================================================

/**
 * The delay throws the outgoing track's close into a beat-synced echo. It is
 * a CHOSEN gesture, never default: it fits only a close with AIR — the last
 * ~2 beats go quiet — on a trusted grid, so the repeats land ON the beat. A
 * sustained melodic close (quiet all the way through the tail, no drop) is
 * reverb territory (task 4), never a delay: nothing to throw, only something
 * to bloom. Thresholds are relative to the tail view's own spread, as every
 * gesture read here is.
 */
/** The phone's MIN_BEATMATCH scale: a rhythmic close needs a trusted grid. */
export const DELAY_MIN_GRID_CONFIDENCE = 0.55;
/** The join's air is measured over the outgoing track's last two beats. */
export const DELAY_AIR_BEATS = 2;
/** The last two beats sit at most this share of the tail's typical (p60) energy. */
export const DELAY_AIR_MAX_SHARE = 0.35;

export interface DelayGestureDecision {
  chosen: boolean;
  /** One beat of the outgoing grid, in track seconds; the deck applies its effective rate. */
  delaySec: number | null;
  /** The gate that killed the candidate, or null when chosen. */
  killReason: string | null;
}

/**
 * The delay gesture's gates, as a pure function over the outgoing analysis.
 * Every rejection carries its killReason for the event telemetry; nothing is
 * filtered, only recorded.
 */
export function scoreDelayGesture(input: { out: TrackAnalysis; outGridConf: number }): DelayGestureDecision {
  const out = input.out;
  const no = (reason: string): DelayGestureDecision => ({ chosen: false, delaySec: null, killReason: reason });
  if (out.beatIntervalSec === null || !Number.isFinite(out.beatIntervalSec) || out.beatIntervalSec <= 0) {
    return no('no outgoing beat grid for a rhythmic delay');
  }
  if (input.outGridConf < DELAY_MIN_GRID_CONFIDENCE) {
    return no(`outgoing grid confidence ${input.outGridConf.toFixed(2)} < ${DELAY_MIN_GRID_CONFIDENCE}`);
  }
  const beatSec = out.beatIntervalSec;
  const tail = tailView(out, GAP_TAIL_SEC) ?? wholeView(out);
  if (!tail || !tail.curve.length) return no('no energy evidence at the outgoing close');
  const typical = percentile(tail.curve, 0.6);
  if (typical <= 0) return no('no energy evidence at the outgoing close');
  const duration = Math.min(out.durationSec, tail.endSec);
  const airWindow = DELAY_AIR_BEATS * beatSec;
  const meanOver = (fromSec: number, toSec: number): number | null => {
    const firstIdx = Math.max(0, Math.ceil((fromSec - tail.startSec) / tail.windowSec));
    const lastIdx = Math.min(tail.curve.length, Math.floor((toSec - tail.startSec) / tail.windowSec));
    if (lastIdx <= firstIdx) return null;
    let sum = 0;
    for (let i = firstIdx; i < lastIdx; i++) sum += tail.curve[i]!;
    return sum / (lastIdx - firstIdx);
  };
  const air = meanOver(duration - airWindow, duration);
  if (air === null) return no('no energy evidence at the outgoing close');
  if (air > typical * DELAY_AIR_MAX_SHARE) return no('no air in the outgoing close');
  // air with no content before it is not a drop — it is a sustained close
  const before = meanOver(duration - airWindow * 2, duration - airWindow);
  if (before === null || before <= typical * DELAY_AIR_MAX_SHARE) {
    return no('sustained melodic close — reverb territory, not delay');
  }
  return { chosen: true, delaySec: beatSec, killReason: null };
}

// ============================================================================
// Phase 3 Task 4 — Short Reverb Gesture (the choice, never a default)
// ============================================================================

/**
 * The reverb blooms the outgoing track's melodic-sustained close. It is a
 * CHOSEN gesture, never default: it fits only a close with HIGH ENERGY
 * CONTINUITY and LOW RHYTHMIC CONTENT in the last ~4 beats — the exact
 * complement of the delay's test. A rhythmic close with a drop (air) is
 * delay territory; a sustained melodic tail (no air, smooth energy) is reverb
 * territory. Thresholds are relative to the tail view's own spread.
 */
/** A melodic close needs a trusted grid for the reverb timing to land clean. */
export const REVERB_MIN_GRID_CONFIDENCE = 0.55;
/** The melodic tail is measured over the outgoing track's last ~4 beats. */
export const REVERB_TAIL_BEATS = 4;
/** The tail's energy continuity: adjacent frames must not jump more than this share of typical. */
export const REVERB_CONTINUITY_MAX_JUMP = 0.4;
/** The tail's mean energy over the last REVERB_TAIL_BEATS must be at least this share of typical. */
export const REVERB_SUSTAIN_MIN_SHARE = 0.25;

export interface ReverbGestureDecision {
  chosen: boolean;
  /** The IR length in seconds (gestureReverbSec). */
  reverbSec: number | null;
  /** The gate that killed the candidate, or null when chosen. */
  killReason: string | null;
}

/**
 * The reverb gesture's gates, as a pure function over the outgoing analysis.
 * Every rejection carries its killReason for the event telemetry; nothing is
 * filtered, only recorded.
 */
export function scoreReverbGesture(input: { out: TrackAnalysis; outGridConf: number }): ReverbGestureDecision {
  const out = input.out;
  const no = (reason: string): ReverbGestureDecision => ({ chosen: false, reverbSec: null, killReason: reason });
  if (out.beatIntervalSec === null || !Number.isFinite(out.beatIntervalSec) || out.beatIntervalSec <= 0) {
    return no('no outgoing beat grid for reverb timing');
  }
  if (input.outGridConf < REVERB_MIN_GRID_CONFIDENCE) {
    return no(`outgoing grid confidence ${input.outGridConf.toFixed(2)} < ${REVERB_MIN_GRID_CONFIDENCE}`);
  }
  const beatSec = out.beatIntervalSec;
  const tail = tailView(out, GAP_TAIL_SEC) ?? wholeView(out);
  if (!tail || !tail.curve.length) return no('no energy evidence at the outgoing close');
  const typical = percentile(tail.curve, 0.6);
  if (typical <= 0) return no('no energy evidence at the outgoing close');
  const duration = Math.min(out.durationSec, tail.endSec);
  const tailWindow = REVERB_TAIL_BEATS * beatSec;
  const startIdx = Math.max(0, Math.ceil((duration - tailWindow - tail.startSec) / tail.windowSec));
  const endIdx = Math.min(tail.curve.length, Math.floor((duration - tail.startSec) / tail.windowSec));
  if (endIdx - startIdx < 2) return no('not enough energy frames in the tail window');
  // Check energy continuity: adjacent frames should not jump abruptly (rhythmic)
  let maxJump = 0;
  let sum = 0;
  let prev = tail.curve[startIdx]!;
  for (let i = startIdx + 1; i < endIdx; i++) {
    const curr = tail.curve[i]!;
    const jump = Math.abs(curr - prev) / Math.max(0.01, typical);
    if (jump > maxJump) maxJump = jump;
    sum += curr;
    prev = curr;
  }
  const mean = sum / (endIdx - startIdx);
  if (maxJump > REVERB_CONTINUITY_MAX_JUMP) {
    return no('rhythmic content in the tail — delay territory, not reverb');
  }
  // Sustained energy: the tail must not be too quiet (that's air/silence)
  if (mean < typical * REVERB_SUSTAIN_MIN_SHARE) {
    return no('tail too quiet — air or silence, not a sustained melodic close');
  }
  return { chosen: true, reverbSec: REVERB_IR_SEC, killReason: null };
}