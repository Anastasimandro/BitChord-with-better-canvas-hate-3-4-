// BitChord, Automix 2.0 Phase 2 Task 3: port of bassSwapFractionFor from
// TransitionPlanner.kt (lines 850-916). Chooses a scored beat for the low-end
// handoff inside a filter mix overlap, replacing the fixed midpoint.
//
// Pure function: (lowBandCurveA, lowBandCurveB, candidateBeats, params) -> { beatIndex | null, depth }.

import type { CurveView } from './policy';

/** Prior for where the low end hands over when no structural cue moves it. */
export const DEFAULT_BASS_SWAP_FRACTION = 0.7;
/** Analysis may move the swap later than the prior, but never so late the outgoing low end survives almost to silence. */
export const MAX_BASS_SWAP_FRACTION = 0.85;
/** A normalized low-band step smaller than this is too weak to move the swap away from its prior. */
export const MIN_BASS_STRUCTURE_SCORE = 0.25;
/** Capped in absolute seconds too, so a long overlap does not scale the hold up with it. */
export const BASS_SWAP_MAX_SECONDS = 6.0;

/** Energy sample at a specific track time (port of Kotlin EnergySample). */
export interface EnergySample {
  time: number;
  energy: number;
}

/**
 * Converts a CurveView to an array of EnergySample for easier indexing.
 * The CurveView already has curve[], windowSec, startSec.
 */
function curveViewToSamples(view: CurveView): EnergySample[] {
  const samples: EnergySample[] = [];
  for (let i = 0; i < view.curve.length; i++) {
    const time = view.startSec + i * view.windowSec;
    const energy = view.curve[i]!;
    if (Number.isFinite(time) && Number.isFinite(energy) && energy >= 0) {
      samples.push({ time, energy });
    }
  }
  return samples;
}

/**
 * Reference level for a low-band curve: the higher of the 90th percentile
 * and 25% of the peak. Port of lowEnergyReference.
 */
export function lowEnergyReference(curve: EnergySample[]): number | null {
  if (curve.length === 0) return null;
  const energies = curve.map((s) => s.energy).filter((e) => Number.isFinite(e) && e >= 0).sort((a, b) => a - b);
  if (energies.length === 0) return null;
  const idx = Math.floor((energies.length - 1) * 0.9);
  const upperDecile = energies[idx] ?? 0;
  const peak = energies.at(-1) ?? 0;
  const reference = Math.max(upperDecile, peak * 0.25);
  return reference > 1e-9 ? reference : null;
}

/**
 * Median gap between consecutive samples (port of lowEnergyResolution).
 * Used to scale the analysis window to the curve's native resolution.
 */
export function lowEnergyResolution(curve: EnergySample[]): number {
  if (curve.length < 2) return 0;
  const gaps: number[] = [];
  for (let i = 0; i < curve.length - 1; i++) {
    const gap = curve[i + 1]!.time - curve[i]!.time;
    if (Number.isFinite(gap) && gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return 0;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)]!;
}

/**
 * Average energy in [from, until) on a curve of EnergySample (port of averageEnergy).
 */
function averageEnergy(curve: EnergySample[], from: number, until: number): number | null {
  if (until <= from) return null;
  let sum = 0;
  let count = 0;
  for (const s of curve) {
    if (s.time >= until) break;
    if (s.time >= from && Number.isFinite(s.energy) && s.energy >= 0) {
      sum += s.energy;
      count++;
    }
  }
  return count > 0 ? sum / count : null;
}

/**
 * Change in low-band energy across one beat either side of [at], normalized per track.
 * Port of lowEnergyChange.
 */
function lowEnergyChange(
  curve: EnergySample[],
  reference: number | null,
  at: number,
  windowSeconds: number,
): number | null {
  if (curve.length === 0 || reference == null || windowSeconds <= 0) return null;
  const before = averageEnergy(curve, at - windowSeconds, at);
  const after = averageEnergy(curve, at, at + windowSeconds);
  if (before == null || after == null) return null;
  return (after / reference).clamp(0, 1.5) - (before / reference).clamp(0, 1.5);
}

/** Clamp helper for numbers. */
declare global {
  interface Number {
    clamp(min: number, max: number): number;
  }
}
Number.prototype.clamp = function (min: number, max: number): number {
  return Math.max(min, Math.min(max, this.valueOf()));
};

/**
 * Input curves for bass swap scoring. Each is a CurveView (from policy.ts)
 * representing the low-band energy around the transition edges.
 */
export interface BassSwapCurves {
  /** Outgoing track's low-band curve covering the transition-out edge. */
  outgoing: CurveView;
  /** Incoming track's low-band curve covering the transition-in edge. */
  incoming: CurveView;
}

/**
 * Parameters for the bass swap search.
 */
export interface BassSwapParams {
  /** Transition start on outgoing track (seconds). */
  transitionStart: number;
  /** Incoming cue time on incoming track (seconds). */
  incomingCueTime: number;
  /** Outgoing beat duration in seconds. */
  outgoingBeatSeconds: number;
  /** Incoming beat duration in seconds. */
  incomingBeatSeconds: number;
  /** Total overlap duration in seconds. */
  overlapSeconds: number;
  /** Total overlap in beats (outgoing track's beats). */
  overlapBeats: number;
}

/**
 * Result of the bass swap search.
 */
export interface BassSwapResult {
  /** Chosen beat index (1-based within overlap), or null if no structural beat found. */
  beatIndex: number | null;
  /** Depth as a fraction of overlap (0..1). */
  depth: number;
}

/**
 * Chooses one shared-grid beat for the low-end handoff.
 * Port of TransitionPlanner.kt bassSwapFractionFor (lines 850-916).
 *
 * @param curves Low-band energy curves for both tracks (outgoing edge, incoming edge)
 * @param params Timing and grid parameters for the overlap
 * @returns { beatIndex, depth } where beatIndex is 1-based within the overlap, or null to use prior
 */
export function chooseBassSwapBeat(
  curves: BassSwapCurves,
  params: BassSwapParams,
): BassSwapResult {
  const { transitionStart, incomingCueTime, outgoingBeatSeconds, incomingBeatSeconds, overlapSeconds, overlapBeats } = params;

  if (overlapSeconds <= 0 || overlapBeats < 2) {
    const prior = Math.min(DEFAULT_BASS_SWAP_FRACTION, MAX_BASS_SWAP_FRACTION, BASS_SWAP_MAX_SECONDS / overlapSeconds);
    return { beatIndex: null, depth: prior.clamp(0, 1) };
  }

  const latestFraction = Math.min(MAX_BASS_SWAP_FRACTION, BASS_SWAP_MAX_SECONDS / overlapSeconds).clamp(0, 1);
  const prior = Math.min(DEFAULT_BASS_SWAP_FRACTION, latestFraction);

  const earliestFraction = Math.min(0.5, latestFraction); // HANDOFF_FRACTION = 0.5
  const earliestBeat = Math.ceil(earliestFraction * overlapBeats - 1e-9).clamp(1, overlapBeats - 1);
  const latestBeat = Math.floor(latestFraction * overlapBeats + 1e-9).clamp(earliestBeat, overlapBeats - 1);

  const candidates: number[] = [];
  for (let b = earliestBeat; b <= latestBeat; b++) candidates.push(b);

  if (candidates.length === 0) {
    // Fallback: beat closest to prior, preferring multiples of 4
    const fallbackBeat = candidates.reduce((best, b) => {
      const diffBest = Math.abs(best / overlapBeats - prior);
      const diffB = Math.abs(b / overlapBeats - prior);
      if (diffB !== diffBest) return diffB < diffBest ? b : best;
      return (b % 4 === 0 && best % 4 !== 0) ? b : best;
    }, earliestBeat);
    return { beatIndex: fallbackBeat, depth: fallbackBeat / overlapBeats };
  }

  // Convert CurveViews to EnergySample arrays for the scoring functions
  const outgoingSamples = curveViewToSamples(curves.outgoing);
  const incomingSamples = curveViewToSamples(curves.incoming);

  const outgoingReference = lowEnergyReference(outgoingSamples);
  const incomingReference = lowEnergyReference(incomingSamples);

  const outgoingWindow = Math.max(
    outgoingBeatSeconds,
    lowEnergyResolution(outgoingSamples) * 1.1,
  );
  const incomingWindow = Math.max(
    incomingBeatSeconds,
    lowEnergyResolution(incomingSamples) * 1.1,
  );

  // Score each candidate beat
  let strongest: { beat: number; score: number } | null = null;

  for (const beat of candidates) {
    const outgoingAt = transitionStart + beat * outgoingBeatSeconds;
    const incomingAt = incomingCueTime + beat * incomingBeatSeconds;

    const incomingChange = lowEnergyChange(incomingSamples, incomingReference, incomingAt, incomingWindow);
    const outgoingChange = lowEnergyChange(outgoingSamples, outgoingReference, outgoingAt, outgoingWindow);

    if (incomingChange == null && outgoingChange == null) continue;

    // Score = incoming change - outgoing change (positive = incoming has more bass, outgoing less)
    const score = (incomingChange ?? 0) - (outgoingChange ?? 0);

    if (strongest === null || score > strongest.score ||
        (score === strongest.score && (beat % 4 === 0) !== (strongest.beat % 4 === 0) && beat % 4 === 0) ||
        (score === strongest.score && (beat % 4 === 0) === (strongest.beat % 4 === 0) &&
         Math.abs(beat / overlapBeats - prior) < Math.abs(strongest.beat / overlapBeats - prior))) {
      strongest = { beat, score };
    }
  }

  const chosenBeat = strongest !== null && strongest.score >= MIN_BASS_STRUCTURE_SCORE
    ? strongest.beat
    : candidates.reduce((best, b) => {
        const diffBest = Math.abs(best / overlapBeats - prior);
        const diffB = Math.abs(b / overlapBeats - prior);
        if (diffB !== diffBest) return diffB < diffBest ? b : best;
        return (b % 4 === 0 && best % 4 !== 0) ? b : best;
      }, earliestBeat);

  return { beatIndex: chosenBeat, depth: chosenBeat / overlapBeats };
}

/**
 * Level-jump gate: if the LUFS difference between outgoing tail and incoming head
 * exceeds 4 dB, suppress the bass swap (fall back to FADE/plain crossfade).
 * Structured so Task 4 can trivially switch to read the RESIDUAL delta (post-compensation).
 *
 * @param lufsOut Integrated loudness of outgoing track's tail (or whole track)
 * @param lufsIn Integrated loudness of incoming track's head (or whole track)
 * @returns true if bass swap should be suppressed
 */
export function shouldSuppressBassSwap(lufsOut: number | null, lufsIn: number | null): boolean {
  if (lufsOut === null || lufsIn === null) return false;
  return Math.abs(lufsOut - lufsIn) > 4;
}