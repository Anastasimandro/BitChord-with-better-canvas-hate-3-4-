// From AutoMix (https://github.com/heydavidf/automix), Copyright (C) 2026 David Finnegan.
// AGPL-3.0-only: see ./LICENSE and ./NOTICE.md in playback/automix.

import type { TrackAnalysis } from '../analysis/types';
import type { Deck } from './deck';
import { gridOf, phraseAtOrBefore, phraseAtOrAfter, downbeatAtOrAfter, BEATS_PER_BAR } from './grid';
import { mixOutAnchor, VOCAL_ACTIVE, VOCAL_OVERLAP_BLEND_GATE, plannedVocalOverlap, tailView, headView, percentile, incomingGainCompensation, MAX_LUFS_COMPENSATION_DB, type CurveView } from './policy';
import type { MixStyle } from '../telemetry';
import { chooseBassSwapBeat, shouldSuppressBassSwap } from './bass-swap';
import type { BassSwapCurves, BassSwapParams } from './bass-swap';

export interface TransitionRequest {
  from: Deck;
  to: Deck;
  fromAnalysis: TrackAnalysis;
  toAnalysis: TrackAnalysis;
  /** Blend length in bars (of the outgoing track's tempo). */
  bars: number;
  /** Start at the outgoing track's next downbeat instead of its natural mix-out point. */
  forceNow?: boolean;
}

export interface TransitionPlan {
  /** AudioContext time the blend starts. */
  t0: number;
  /** Blend duration in seconds (output time). */
  durationSec: number;
  /** Incoming track position at t0. */
  mixInTrackTime: number;
  /** Outgoing track position at t0. */
  mixOutTrackTime: number;
  /** Rate the incoming deck plays at during the blend. */
  rate: number;
  /** True when grids were unusable and a plain crossfade was scheduled. */
  fallback: boolean;
  /**
   * BitChord: how the blend is played. 'blend' is AutoMix's beatmatch;
   * 'filter' the phone's DJ_FILTER for a pair that can't be beatmatched;
   * 'crossfade' AutoMix's fallback; 'gap' the Phase 0 style — a melodic
   * close into a clear opener hands over at the silence point instead of
   * overlapping.
   */
  style: MixStyle;
  /** BitChord: why a pair wasn't beatmatched, for stats for nerds. */
  reason: string | null;
}

// Below this, a beat-lock is more likely confidently WRONG than right (a
// 0.17 grid locked precisely off-beat) — a clean crossfade beats a bad
// beatmatch. 0.3 proved too aggressive on loose lofi (every mix fell back);
// 0.2-0.45 grids now beatmatch but only for the short 4-bar tier, so a
// wrong lock costs ~11s, not a 46s blend.
export const MIN_GRID_CONFIDENCE = 0.2;
// Bass swap depth: full on long blends with room for it; gentle on short
// blends so piano-led lows aren't gutted but the cross is still audible.
const KILL_DB = -12;
const SHORT_BLEND_KILL_DB = -6;
const FULL_SWAP_MIN_BARS = 8;

/** Phase 2 Task 5: hard ceiling on how far the entry may advance from the first audible downbeat. */
export const INCOMING_MAX_ADVANCE_BARS = 8;
/** Phase 2 Task 5: max fraction of track duration the entry may skip (mirrors Android). */
export const MAX_INCOMING_SKIP_FRACTION = 0.25;

/**
 * Low-energy threshold for the head span: a frame is "low energy" if it's below
 * 30% of the span's 60th percentile (typical level). Matches the contentEndOf
 * convention of typical * 0.3.
 */
function lowEnergyThreshold(view: CurveView): number {
  const typical = percentile(view.curve, 0.6);
  return Math.max(0.04, typical * 0.3);
}

/**
 * Checks if [timeSec] falls inside a contiguous low-energy region of at least
 * [minSpanSec] seconds in the given view. Used to reject downbeats that land
 * in >2 s of near-silence (Phase 2 Task 5: "audible" downbeat).
 */
function isInLongLowEnergySpan(view: CurveView, timeSec: number, minSpanSec = 2): boolean {
  const threshold = lowEnergyThreshold(view);
  const idx = Math.floor((timeSec - view.startSec) / view.windowSec);
  if (idx < 0 || idx >= view.curve.length) return false;
  if (view.curve[idx]! > threshold) return false;

  // Expand left and right to find the full contiguous low-energy region
  let left = idx;
  while (left > 0 && view.curve[left - 1]! <= threshold) left--;
  let right = idx;
  while (right + 1 < view.curve.length && view.curve[right + 1]! <= threshold) right++;

  const spanSec = (right - left + 1) * view.windowSec;
  return spanSec >= minSpanSec;
}

/**
 * Finds the first "audible" downbeat of the incoming track: the first downbeat
 * that is NOT inside a >2 s low-energy span. Falls back to the grid's first
 * downbeat if no head beats are available or all are in low-energy spans.
 * Phase 2 Task 5: invert selection order — start here, then advance by score
 * within hard caps, never search the whole intro for a "better drop".
 */
function firstAudibleDownbeat(toAnalysis: TrackAnalysis, toGrid: NonNullable<ReturnType<typeof gridOf>>): number {
  const headBeats = toAnalysis.headBeats?.downbeats;
  const downbeats: number[] = headBeats ?? [toGrid.downbeatSec];
  if (downbeats.length === 0) return toGrid.downbeatSec;

  // Get the energy view for the head region (where the mix-in point lives)
  const view = headView(toAnalysis, toGrid.barSec * 16) ?? { curve: [], windowSec: 1, startSec: 0, endSec: 0 };
  if (!view.curve.length) return downbeats[0]; // no energy data — assume first downbeat is audible

  for (const db of downbeats) {
    if (db < 0 || db >= toAnalysis.durationSec) continue;
    if (!isInLongLowEnergySpan(view, db, 2)) return db;
  }
  // All downbeats in low-energy spans — return the first one (least bad)
  return downbeats[0];
}

/**
 * Confidence-scaled blend length: the UI's bar count is a MAX, not a command.
 * Long overlaps are a house/techno assumption — two melodic tracks over a
 * shaky grid for 46s is mush, so weaker grids get shorter blends.
 */
export function effectiveBlendBars(
  requestedBars: number,
  fromConfidence: number,
  toConfidence: number,
): number {
  const conf = Math.min(fromConfidence, toConfidence);
  if (conf >= 0.6) return requestedBars;
  if (conf >= 0.45) return Math.min(requestedBars, 8);
  return Math.min(requestedBars, 4);
}

/**
 * Schedule a phrase-aligned DJ blend on the Web Audio clock:
 * - incoming starts at its pre-full-energy phrase boundary, stretched to the
 *   outgoing tempo
 * - equal-power gain cross over the window
 * - bass swap over 1 bar at the midpoint, gentle high-shelf cross over the window
 * - outgoing stops at the end; incoming glides back to rate 1
 */
export function scheduleTransition(req: TransitionRequest): TransitionPlan {
  const { from, to, fromAnalysis, toAnalysis, bars, forceNow } = req;
  const ctx = from.ctx;
  const now = ctx.currentTime;
  const earliest = now + Math.max(from.scheduleAhead, to.scheduleAhead) + 0.1;

  const fromGrid = gridOf(fromAnalysis);
  const toGrid = gridOf(toAnalysis);
  const gridsUsable =
    fromGrid !== null &&
    toGrid !== null &&
    fromAnalysis.gridConfidence >= MIN_GRID_CONFIDENCE &&
    toAnalysis.gridConfidence >= MIN_GRID_CONFIDENCE;

  // BitChord: only the outgoing side's grid decides between a beat-aware mix
  // and AutoMix's plain crossfade. An incoming track without one, or a tempo
  // too far off to stretch, gets the phone's filter mix (scheduleFilterMix):
  // a radio queue isn't picked for tempo the way AutoMix's library was, and
  // falling back on all of those left nearly every join a plain fade.
  if (fromGrid === null || fromAnalysis.gridConfidence < MIN_GRID_CONFIDENCE) {
    return scheduleFallback(req, earliest, 'this song has no beat grid at its end');
  }
  if (!gridsUsable) return scheduleFilterMix(req, earliest, fromGrid, null, 'next song has no beat grid');

  const outRate = from.timeline.rateAt(now) || 1;
  const effectiveFromBpm = fromGrid.bpm * outRate;
  // fold half/double-time so the stretch stays near 1 (64 vs 128 BPM still beat-locks)
  const rawRate = effectiveFromBpm / toGrid.bpm;
  const rate = [rawRate, rawRate / 2, rawRate * 2].reduce((best, r) =>
    Math.abs(r - 1) < Math.abs(best - 1) ? r : best,
  );
  // tempo gap too wide to beatmatch musically. BitChord: the next song slowed
  // at most 10% or sped up at most 25% (stretchAllowed) rather than AutoMix's
  // 8%; past it, a filter mix.
  if (!stretchAllowed(rate)) {
    return scheduleFilterMix(req, earliest, fromGrid, toGrid, `tempos ${Math.round(Math.abs(rate - 1) * 100)}% apart`);
  }
  // blend length measured in output seconds at the outgoing tempo
  const effBars = effectiveBlendBars(bars, fromAnalysis.gridConfidence, toAnalysis.gridConfidence);
  const durationSec = effBars * BEATS_PER_BAR * (60 / effectiveFromBpm);

  // --- outgoing mix-out point (track time) ---
  let mixOutTrackTime: number;
  const fromPos = from.expectedTrackTime ?? 0;
  if (forceNow) {
    const earliestTrack = from.timeline.trackTimeAt(earliest) ?? fromPos;
    mixOutTrackTime = downbeatAtOrAfter(fromGrid, earliestTrack);
  } else {
    // BitChord: the silence trim and the false-ending rule live in the
    // analysis (contentEndSec / a rejected outro); this anchor reads both.
    const outro = mixOutAnchor(fromAnalysis);
    const blendInputSec = durationSec * outRate;
    mixOutTrackTime = phraseAtOrBefore(fromGrid, outro - blendInputSec);
    const latestStart = fromAnalysis.durationSec - blendInputSec - fromGrid.barSec;
    mixOutTrackTime = Math.min(mixOutTrackTime, phraseAtOrBefore(fromGrid, latestStart));
    if (mixOutTrackTime < fromPos) {
      // too late for the natural point — go at the next phrase instead
      mixOutTrackTime = phraseAtOrAfter(fromGrid, from.timeline.trackTimeAt(earliest) ?? fromPos);
    }
  }

  let t0 = from.timeline.ctxTimeAt(mixOutTrackTime, now);
  if (t0 === null || t0 < earliest) {
    mixOutTrackTime = downbeatAtOrAfter(fromGrid, from.timeline.trackTimeAt(earliest) ?? fromPos);
    t0 = from.timeline.ctxTimeAt(mixOutTrackTime, now);
    if (t0 === null) return scheduleFallback(req, earliest);
  }

  // --- incoming mix-in point (track time) ---
  // Phase 2 Task 5: invert selection order — start at first AUDIBLE downbeat,
  // advance only by score within hard caps (8 bars, 25% duration). Delete the
  // global search for fullEnergyPhrase; structure is not negotiable.
  const firstDownbeat = firstAudibleDownbeat(toAnalysis, toGrid);
  const barSec = toGrid.barSec;
  const capByBars = firstDownbeat + INCOMING_MAX_ADVANCE_BARS * barSec;
  const capByFraction = firstDownbeat + (MAX_INCOMING_SKIP_FRACTION * toAnalysis.durationSec);
  const hardCap = Math.min(capByBars, capByFraction, toAnalysis.durationSec - barSec);

  // Base entry is the first audible downbeat. The "score" that could justify
  // advancing is the vocal overlap gate: if the base entry would cause crossed
  // vocals, we may advance to the next downbeat (up to hardCap). But the
  // default is the base — no free search for a "better drop".
  let mixInTrackTime = firstDownbeat;

  // Align to a downbeat at or after the base, not exceeding hardCap.
  const alignedEntry = downbeatAtOrAfter(toGrid, mixInTrackTime);
  if (alignedEntry <= hardCap) mixInTrackTime = alignedEntry;

  // --- Vocal overlap gate & gesture (port of plannedVocalOverlap) ---
  // Calculate the fraction of the overlap where both voices sing.
  // Outgoing window: [mixOutTrackTime, mixOutTrackTime + durationSec * outRate]
  // Incoming window: [mixInTrackTime, mixInTrackTime + durationSec * rate]
  const outOverlapStart = mixOutTrackTime;
  const outOverlapEnd = mixOutTrackTime + durationSec * outRate;
  const inOverlapStart = mixInTrackTime;
  const vocalOverlap = plannedVocalOverlap(
    fromAnalysis.vocals ?? [],
    toAnalysis.vocals ?? [],
    outOverlapStart,
    outOverlapEnd,
    inOverlapStart,
    rate,
  );

  let finalEffBars = effBars;
  let finalDurationSec = durationSec;
  let vocalGesture = false;

  if (vocalOverlap !== null && vocalOverlap > VOCAL_OVERLAP_BLEND_GATE) {
    // GATE: crossed voices — first try capping the blend to 4 bars (shorter
    // overlap window). If that still exceeds the gate, advance the entry to the
    // next downbeat (up to hardCap) as the "score" justifying an upgrade.
    const cappedBars = Math.min(finalEffBars, 4);
    const cappedDurationSec = cappedBars * BEATS_PER_BAR * (60 / effectiveFromBpm);

    // Re-check with capped blend at current entry
    const cappedOutEnd = mixOutTrackTime + cappedDurationSec * outRate;
    const cappedInEnd = mixInTrackTime + cappedDurationSec * rate;
    const cappedOverlap = plannedVocalOverlap(
      fromAnalysis.vocals ?? [],
      toAnalysis.vocals ?? [],
      outOverlapStart,
      cappedOutEnd,
      mixInTrackTime,
      rate,
    );

    let finalMixInTrackTime = mixInTrackTime;
    let finalCappedBars = cappedBars;
    let finalCappedDurationSec = cappedDurationSec;

    if (cappedOverlap !== null && cappedOverlap > VOCAL_OVERLAP_BLEND_GATE) {
      // Even 4 bars has too much crossed vocal — try advancing entry to next
      // downbeat (up to hardCap) as the score-justified upgrade.
      const nextDownbeat = downbeatAtOrAfter(toGrid, mixInTrackTime + barSec);
      if (nextDownbeat <= hardCap) {
        const advancedOutEnd = mixOutTrackTime + cappedDurationSec * outRate;
        const advancedInEnd = nextDownbeat + cappedDurationSec * rate;
        const advancedOverlap = plannedVocalOverlap(
          fromAnalysis.vocals ?? [],
          toAnalysis.vocals ?? [],
          outOverlapStart,
          advancedOutEnd,
          nextDownbeat,
          rate,
        );
        if (advancedOverlap === null || advancedOverlap <= VOCAL_OVERLAP_BLEND_GATE) {
          finalMixInTrackTime = nextDownbeat;
        } else {
          // Even advancing doesn't help — fall back to plain crossfade
          return scheduleFallback(req, earliest, `crossed vocals (${Math.round(vocalOverlap * 100)}%) exceed gate`);
        }
      } else {
        // Can't advance past hardCap — fall back
        return scheduleFallback(req, earliest, `crossed vocals (${Math.round(vocalOverlap * 100)}%) exceed gate`);
      }
    }

    finalEffBars = finalCappedBars;
    finalDurationSec = finalCappedDurationSec;
    mixInTrackTime = finalMixInTrackTime;
  } else if (vocalOverlap !== null && vocalOverlap > 0) {
    // GESTURE: some crossed vocal but under the gate — deepen the HP/LP sweep
    // during the overlap so the voices separate spectrally.
    vocalGesture = true;
  }

  // --- schedule transport ---
  to.playAt({ ctxTime: t0, trackTime: mixInTrackTime, rate });
  from.pauseAt(t0 + finalDurationSec + 0.05);

  // --- LUFS gain compensation: incoming deck base gain (static, pre-cross) ---
  const lufsCompensation = incomingGainCompensation(fromAnalysis, toAnalysis);
  const preCrossTime = t0 - 0.02;
  to.gain.gain.setValueAtTime(lufsCompensation, preCrossTime);

  // --- gains: equal-power cross (shapes the transition; compensation flattens the field first) ---
  applyEqualPowerCross(from.gain.gain, to.gain.gain, t0, finalDurationSec);

  // --- EQ: bass swap at scored beat over 1 bar, highs cross the whole window ---
  const barOutSec = fromGrid.barSec / outRate;
  const overlapBeats = finalEffBars * BEATS_PER_BAR;
  const outgoingBeatSeconds = fromGrid.beatSec / outRate;
  const incomingBeatSeconds = toGrid!.beatSec / rate;

  // Level-jump gate: if RESIDUAL LUFS delta (post-compensation) > 4 dB, suppress bass swap
  const lufsOut = fromAnalysis.lufsTail ?? fromAnalysis.lufs ?? null;
  const lufsIn = toAnalysis.lufsHead ?? toAnalysis.lufs ?? null;
  const rawDeltaDb = lufsOut !== null && lufsIn !== null ? lufsOut - lufsIn : null;
  const appliedCompensationDb = rawDeltaDb !== null ? Math.max(-MAX_LUFS_COMPENSATION_DB, Math.min(MAX_LUFS_COMPENSATION_DB, rawDeltaDb)) : 0;
  const residualDeltaDb = rawDeltaDb !== null ? rawDeltaDb - appliedCompensationDb : null;
  const suppressBassSwap = residualDeltaDb !== null ? Math.abs(residualDeltaDb) > 4 : false;

  let swapDb = finalEffBars >= FULL_SWAP_MIN_BARS ? KILL_DB : SHORT_BLEND_KILL_DB;
  let swapTime = t0 + finalDurationSec / 2;
  let swapDuration = barOutSec;

  if (!suppressBassSwap) {
    const outgoingView = tailView(fromAnalysis, finalDurationSec * outRate);
    const incomingView = headView(toAnalysis, finalDurationSec);

    if (outgoingView && incomingView) {
      const curves: BassSwapCurves = { outgoing: outgoingView, incoming: incomingView };
      const params: BassSwapParams = {
        transitionStart: mixOutTrackTime,
        incomingCueTime: mixInTrackTime,
        outgoingBeatSeconds,
        incomingBeatSeconds,
        overlapSeconds: finalDurationSec,
        overlapBeats,
      };

      const result = chooseBassSwapBeat(curves, params);

      if (result.beatIndex !== null) {
        swapTime = t0 + result.depth * finalDurationSec;
        const outgoingSamples = curves.outgoing.curve;
        const incomingSamples = curves.incoming.curve;
        const outIdx = Math.floor(result.depth * outgoingSamples.length);
        const inIdx = Math.floor(result.depth * incomingSamples.length);
        const outEnergy = outgoingSamples[Math.min(outIdx, outgoingSamples.length - 1)] ?? 0;
        const inEnergy = incomingSamples[Math.min(inIdx, incomingSamples.length - 1)] ?? 0;
        const outRef = Math.max(...outgoingSamples) * 0.5;
        const inRef = Math.max(...incomingSamples) * 0.5;
        const bassBothSides = outEnergy > outRef && inEnergy > inRef;
        swapDb = bassBothSides ? KILL_DB : SHORT_BLEND_KILL_DB;
      } else {
        swapTime = t0 + result.depth * finalDurationSec;
        swapDb = SHORT_BLEND_KILL_DB;
      }
    }
  } else {
    swapDb = SHORT_BLEND_KILL_DB;
  }

  to.eq.setGainAt('low', swapDb, t0 - 0.02);
  from.eq.rampGain('low', 0, swapDb, swapTime - swapDuration / 2, swapDuration);
  to.eq.rampGain('low', swapDb, 0, swapTime - swapDuration / 2, swapDuration);
  from.eq.rampGain('high', 0, -8, t0, finalDurationSec);
  to.eq.setGainAt('high', -8, t0 - 0.02);
  to.eq.rampGain('high', -8, 0, t0, finalDurationSec);

  // --- Vocal gesture: deepen HP/LP sweep during overlap when crossed vocal ---
  if (vocalGesture) {
    const hp = from.sweep.highpass.frequency;
    const lp = to.sweep.lowpass.frequency;
    hp.cancelScheduledValues(t0 - 0.03);
    lp.cancelScheduledValues(t0 - 0.03);
    // Deeper than the filter mix: outgoing HP rises further, incoming LP opens less
    hp.setValueAtTime(FILTER_OPEN_LOW_HZ, t0);
    hp.exponentialRampToValueAtTime(3500, t0 + finalDurationSec); // was 1800
    lp.setValueAtTime(150, t0 - 0.02); // was 350
    lp.exponentialRampToValueAtTime(FILTER_OPEN_HIGH_HZ, t0 + finalDurationSec);
  }

  // --- after the blend: outgoing cleanup + incoming rate glide to 1 ---
  const tEnd = t0 + finalDurationSec;
  scheduleAfter(ctx, tEnd + 0.2, () => {
    from.eq.reset();
    from.setVolume(1);
  });
  glideRateToUnity(to, rate, tEnd);

  return { t0, durationSec: finalDurationSec, mixInTrackTime, mixOutTrackTime, rate, fallback: false, style: 'blend', reason: null };
}

/**
 * BitChord: the bars the scheduler will use for this pair, so the mix loop
 * times the mix-out for the same length: a filter mix (no incoming grid, or
 * tempos too far apart) is up to FILTER_MAX_BARS, a beatmatch is AutoMix's
 * confidence-scaled length.
 */
export function plannedBars(
  requestedBars: number,
  fromAnalysis: TrackAnalysis,
  toAnalysis: TrackAnalysis | null,
  outRate: number,
): number {
  const fromGrid = gridOf(fromAnalysis);
  const toGrid = toAnalysis ? gridOf(toAnalysis) : null;
  if (!toAnalysis) return effectiveBlendBars(requestedBars, fromAnalysis.gridConfidence, 1);
  if (!fromGrid || !toGrid || toAnalysis.gridConfidence < MIN_GRID_CONFIDENCE) return Math.min(requestedBars, FILTER_MAX_BARS);
  const raw = (fromGrid.bpm * outRate) / toGrid.bpm;
  const rate = [raw, raw / 2, raw * 2].reduce((best, r) => (Math.abs(r - 1) < Math.abs(best - 1) ? r : best));
  if (!stretchAllowed(rate)) return Math.min(requestedBars, FILTER_MAX_BARS);
  return effectiveBlendBars(requestedBars, fromAnalysis.gridConfidence, toAnalysis.gridConfidence);
}

/**
 * BitChord: how far the element blend may stretch the incoming song (the
 * user's call, 2026-10-23; the phone's STRETCH_WINDOW is 0.9..1.1). [rate] is
 * the incoming song's playback rate, outgoing BPM over incoming BPM:
 * - below 1, the incoming song is slowed down: at most 10%;
 * - above 1, it is sped up: at most 25%.
 * The loop mix ramps any gap; this is for the blend it falls back on.
 */
export function stretchAllowed(rate: number): boolean {
  return rate >= 1 ? rate - 1 <= MAX_SPEED_UP : 1 - rate <= MAX_SLOW_DOWN;
}
const MAX_SLOW_DOWN = 0.1;
const MAX_SPEED_UP = 0.25;
/** BitChord: a filter mix is at most this many outgoing bars (the phone's DJ_FILTER length). */
const FILTER_MAX_BARS = 8;

/**
 * BitChord, after the phone's DJ_FILTER (TransitionPlanner.kt): a pair that
 * can't be beatmatched still mixes on the outgoing track's phrase. The
 * incoming track starts on its own downbeat exactly on the outgoing one's, at
 * its own tempo, low-passed; the outgoing track drains away through a
 * rising high-pass; the bass hands over in one bar at the midpoint, so two
 * kick drums at two tempi never play at full weight together.
 */
export function scheduleFilterMix(
  req: TransitionRequest,
  earliest: number,
  fromGrid: NonNullable<ReturnType<typeof gridOf>>,
  toGrid: ReturnType<typeof gridOf>,
  reason: string,
): TransitionPlan {
  const { from, to, fromAnalysis, toAnalysis, forceNow } = req;
  const ctx = from.ctx;
  const now = ctx.currentTime;
  const outRate = from.timeline.rateAt(now) || 1;
  const barOutSec = fromGrid.barSec / outRate;
  let bars = Math.min(req.bars, FILTER_MAX_BARS);
  let durationSec = bars * barOutSec;
  let blendInputSec = durationSec * outRate;

  const fromPos = from.expectedTrackTime ?? 0;
  let mixOutTrackTime: number;
  if (forceNow) {
    mixOutTrackTime = downbeatAtOrAfter(fromGrid, from.timeline.trackTimeAt(earliest) ?? fromPos);
  } else {
    const outro = mixOutAnchor(fromAnalysis);
    mixOutTrackTime = phraseAtOrBefore(fromGrid, outro - blendInputSec);
    mixOutTrackTime = Math.min(mixOutTrackTime, phraseAtOrBefore(fromGrid, fromAnalysis.durationSec - blendInputSec - fromGrid.barSec));
    if (mixOutTrackTime < fromPos) mixOutTrackTime = phraseAtOrAfter(fromGrid, from.timeline.trackTimeAt(earliest) ?? fromPos);
  }
  let t0 = from.timeline.ctxTimeAt(mixOutTrackTime, now);
  if (t0 === null || t0 < earliest) {
    mixOutTrackTime = downbeatAtOrAfter(fromGrid, from.timeline.trackTimeAt(earliest) ?? fromPos);
    t0 = from.timeline.ctxTimeAt(mixOutTrackTime, now);
    if (t0 === null) return scheduleFallback(req, earliest, reason);
  }

  // never past the outgoing track's end: shorten to the bars that still fit
  const room = fromAnalysis.durationSec - 0.3 - mixOutTrackTime;
  if (blendInputSec > room) {
    bars = Math.max(1, Math.floor(room / fromGrid.barSec));
    durationSec = bars * barOutSec;
    blendInputSec = durationSec * outRate;
  }

  // Phase 2 Task 5: filter mix also uses first audible downbeat with hard caps.
  let mixInTrackTime: number;
  if (toGrid) {
    const firstDownbeat = firstAudibleDownbeat(toAnalysis, toGrid);
    const barSec = toGrid.barSec;
    const capByBars = firstDownbeat + INCOMING_MAX_ADVANCE_BARS * barSec;
    const capByFraction = firstDownbeat + (MAX_INCOMING_SKIP_FRACTION * toAnalysis.durationSec);
    const hardCap = Math.min(capByBars, capByFraction, toAnalysis.durationSec - barSec);
    const alignedEntry = downbeatAtOrAfter(toGrid, firstDownbeat);
    mixInTrackTime = alignedEntry <= hardCap ? alignedEntry : firstDownbeat;
  } else {
    mixInTrackTime = Math.min(toAnalysis.introEndSec ?? 0, 1);
  }
  to.playAt({ ctxTime: t0, trackTime: mixInTrackTime, rate: 1 });
  from.pauseAt(t0 + durationSec + 0.05);

  // --- LUFS gain compensation: incoming deck base gain (static, pre-cross) ---
  const lufsCompensation = incomingGainCompensation(fromAnalysis, toAnalysis);
  const preCrossTime = t0 - 0.02;
  to.gain.gain.setValueAtTime(lufsCompensation, preCrossTime);

  // --- gains: equal-power cross (shapes the transition; compensation flattens the field first) ---
  applyEqualPowerCross(from.gain.gain, to.gain.gain, t0, durationSec);

  // filters: outgoing high-pass rises, incoming low-pass opens
  const hp = from.sweep.highpass.frequency;
  const lp = to.sweep.lowpass.frequency;
  hp.cancelScheduledValues(t0 - 0.03);
  lp.cancelScheduledValues(t0 - 0.03);
  hp.setValueAtTime(FILTER_OPEN_LOW_HZ, t0);
  hp.exponentialRampToValueAtTime(FILTER_HP_END_HZ, t0 + durationSec);
  lp.setValueAtTime(FILTER_LP_START_HZ, t0 - 0.02);
  lp.exponentialRampToValueAtTime(FILTER_OPEN_HIGH_HZ, t0 + durationSec);

  // --- Bass swap: scored beat search (port of bassSwapFractionFor) ---
  // Level-jump gate: if RESIDUAL LUFS delta (post-compensation) > 4 dB, suppress bass swap
  const lufsOut = fromAnalysis.lufsTail ?? fromAnalysis.lufs ?? null;
  const lufsIn = toAnalysis.lufsHead ?? toAnalysis.lufs ?? null;
  const rawDeltaDb = lufsOut !== null && lufsIn !== null ? lufsOut - lufsIn : null;
  const appliedCompensationDb = rawDeltaDb !== null ? Math.max(-MAX_LUFS_COMPENSATION_DB, Math.min(MAX_LUFS_COMPENSATION_DB, rawDeltaDb)) : 0;
  const residualDeltaDb = rawDeltaDb !== null ? rawDeltaDb - appliedCompensationDb : null;
  const suppressBassSwap = residualDeltaDb !== null ? Math.abs(residualDeltaDb) > 4 : false;

  let swapDb = KILL_DB;
  let swapTime = t0 + durationSec / 2; // default midpoint
  let swapDuration = barOutSec; // one bar

  if (!suppressBassSwap) {
    // Build low-band curves for the transition edges using tail/head views
    const outgoingView = tailView(fromAnalysis, durationSec * outRate);
    const incomingView = headView(toAnalysis, durationSec);

    if (outgoingView && incomingView) {
      const overlapBeats = bars * BEATS_PER_BAR;
      const outgoingBeatSeconds = fromGrid.beatSec / outRate;
      const incomingBeatSeconds = toGrid ? toGrid.beatSec : outgoingBeatSeconds; // if no incoming grid, assume same tempo

      const curves: BassSwapCurves = { outgoing: outgoingView, incoming: incomingView };
      const params: BassSwapParams = {
        transitionStart: mixOutTrackTime,
        incomingCueTime: mixInTrackTime,
        outgoingBeatSeconds,
        incomingBeatSeconds,
        overlapSeconds: durationSec,
        overlapBeats,
      };

      const result = chooseBassSwapBeat(curves, params);

      if (result.beatIndex !== null) {
        // Scored beat found: place swap at that beat
        swapTime = t0 + result.depth * durationSec;
        // Bass present on BOTH sides of the beat -> full KILL_DB; thin on either -> SHORT_BLEND_KILL_DB
        // We approximate "bass present" by checking if the low-band energy at the swap beat
        // is above the track's reference level on BOTH sides.
        const outgoingSamples = curves.outgoing.curve;
        const incomingSamples = curves.incoming.curve;
        const outIdx = Math.floor((swapTime - t0) / outgoingBeatSeconds * outgoingSamples.length / overlapBeats);
        const inIdx = Math.floor(result.depth * incomingSamples.length);
        const outEnergy = outgoingSamples[Math.min(outIdx, outgoingSamples.length - 1)] ?? 0;
        const inEnergy = incomingSamples[Math.min(inIdx, incomingSamples.length - 1)] ?? 0;
        const outRef = Math.max(...outgoingSamples) * 0.5;
        const inRef = Math.max(...incomingSamples) * 0.5;
        const bassBothSides = outEnergy > outRef && inEnergy > inRef;
        swapDb = bassBothSides ? KILL_DB : SHORT_BLEND_KILL_DB;
      } else {
        // No structural beat: use prior (0.7) but still apply depth-based kill
        swapTime = t0 + result.depth * durationSec;
        swapDb = SHORT_BLEND_KILL_DB; // shallow swap for prior-based
      }
    }
  } else {
    // LUFS gate triggered: suppress bass swap entirely (shallow blend)
    swapDb = SHORT_BLEND_KILL_DB;
  }

  // Apply the bass swap at the computed time
  to.eq.setGainAt('low', swapDb, t0 - 0.02);
  from.eq.rampGain('low', 0, swapDb, swapTime - swapDuration / 2, swapDuration);
  to.eq.rampGain('low', swapDb, 0, swapTime - swapDuration / 2, swapDuration);

  const tEnd = t0 + durationSec;
  scheduleAfter(ctx, tEnd + 0.2, () => {
    from.eq.reset();
    from.resetSweep();
    to.resetSweep();
    from.setVolume(1);
  });
  return { t0, durationSec, mixInTrackTime, mixOutTrackTime, rate: 1, fallback: false, style: 'filter', reason };
}

/** A filter at these is as good as open. */
const FILTER_OPEN_LOW_HZ = 20;
const FILTER_OPEN_HIGH_HZ = 20000;
/** Where the outgoing high-pass ends: the body of the track gone, its top still trailing. */
const FILTER_HP_END_HZ = 1800;
/** Where the incoming low-pass starts: kick and bass only, the rest arriving as it opens. */
const FILTER_LP_START_HZ = 350;

/** The gap style's crossfade: a kiss, not a blend. */
const GAP_FADE_SEC = 0.4;

/**
 * BitChord, Phase 0's GAP style: the outgoing track's last audible content
 * hands to the incoming track's first downbeat over a very short crossfade
 * at the silence point — a melodic close into a clear opener overlaps
 * badly, and clean silence between them is the mix. No EQ, no filters: the
 * two tracks barely touch.
 */
export function scheduleGapMix(req: TransitionRequest): TransitionPlan {
  const { from, to, fromAnalysis, toAnalysis } = req;
  const ctx = from.ctx;
  const now = ctx.currentTime;
  const earliest = now + Math.max(from.scheduleAhead, to.scheduleAhead) + 0.1;
  const fromGrid = gridOf(fromAnalysis);
  const toGrid = gridOf(toAnalysis);
  if (fromGrid === null || toGrid === null) return scheduleFallback(req, earliest, 'gap needs both grids');

  // the silence point: where the outgoing track's audible content ends
  const silenceAt = fromAnalysis.contentEndSec ?? fromAnalysis.outroStartSec ?? fromAnalysis.durationSec;
  const mixOutTrackTime = Math.max(0, silenceAt - GAP_FADE_SEC);
  const t0 = from.timeline.ctxTimeAt(mixOutTrackTime, now);
  if (t0 === null || t0 < earliest) return scheduleFallback(req, earliest, 'the silence point is already gone');

  // Phase 2 Task 5: the incoming track enters at its first AUDIBLE downbeat
  // (not in >2s low-energy span) — never a best-drop search.
  const mixInTrackTime = firstAudibleDownbeat(toAnalysis, toGrid);
  to.playAt({ ctxTime: t0, trackTime: mixInTrackTime, rate: 1 });
  from.pauseAt(t0 + GAP_FADE_SEC + 0.05);

  // --- LUFS gain compensation: incoming deck base gain (static, pre-cross) ---
  const lufsCompensation = incomingGainCompensation(fromAnalysis, toAnalysis);
  const preCrossTime = t0 - 0.02;
  to.gain.gain.setValueAtTime(lufsCompensation, preCrossTime);

  applyEqualPowerCross(from.gain.gain, to.gain.gain, t0, GAP_FADE_SEC);
  scheduleAfter(ctx, t0 + GAP_FADE_SEC + 0.2, () => {
    from.eq.reset();
    from.setVolume(1);
  });
  return {
    t0,
    durationSec: GAP_FADE_SEC,
    mixInTrackTime,
    mixOutTrackTime,
    rate: 1,
    fallback: false,
    style: 'gap',
    reason: 'melodic close into a clear opener',
  };
}

/** No usable grid: plain equal-power volume fade, no beatmatch, no EQ moves. */
export function scheduleFallback(req: TransitionRequest, earliest: number, reason: string | null = null): TransitionPlan {
  const { from, to, fromAnalysis, toAnalysis } = req;
  const ctx = from.ctx;
  const durationSec = 12;
  const t0 = earliest;
  const mixInTrackTime = toAnalysis.introEndSec ?? 0;
  to.playAt({ ctxTime: t0, trackTime: mixInTrackTime, rate: 1 });
  from.pauseAt(t0 + durationSec + 0.05);

  // --- LUFS gain compensation: incoming deck base gain (static, pre-cross) ---
  const lufsCompensation = incomingGainCompensation(fromAnalysis, toAnalysis);
  const preCrossTime = t0 - 0.02;
  to.gain.gain.setValueAtTime(lufsCompensation, preCrossTime);

  applyEqualPowerCross(from.gain.gain, to.gain.gain, t0, durationSec);
  scheduleAfter(ctx, t0 + durationSec + 0.2, () => {
    from.eq.reset();
    from.setVolume(1);
  });
  return {
    t0,
    durationSec,
    mixInTrackTime,
    mixOutTrackTime: from.expectedTrackTime ?? 0,
    rate: 1,
    fallback: true,
    style: 'crossfade',
    reason,
  };
}

function applyEqualPowerCross(outParam: AudioParam, inParam: AudioParam, t0: number, durationSec: number): void {
  const N = 65;
  const fadeOut = new Float32Array(N);
  const fadeIn = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const x = i / (N - 1);
    fadeOut[i] = Math.cos((x * Math.PI) / 2);
    fadeIn[i] = Math.sin((x * Math.PI) / 2);
  }
  outParam.cancelScheduledValues(t0 - 0.03);
  inParam.cancelScheduledValues(t0 - 0.03);
  outParam.setValueAtTime(1, t0 - 0.02);
  inParam.setValueAtTime(0, t0 - 0.02);
  outParam.setValueCurveAtTime(fadeOut, t0, durationSec);
  inParam.setValueCurveAtTime(fadeIn, t0, durationSec);
}

/** Step the incoming deck's rate back to 1.0 in inaudible ~0.8% increments. */
function glideRateToUnity(deck: Deck, fromRate: number, startCtxTime: number): void {
  if (Math.abs(fromRate - 1) < 0.002) {
    deck.setRate(1, startCtxTime + 0.5);
    return;
  }
  const steps = 8;
  const stepSec = 3;
  for (let i = 1; i <= steps; i++) {
    const r = fromRate + (1 - fromRate) * (i / steps);
    deck.setRate(r, startCtxTime + i * stepSec);
  }
}

/** Fire a callback near an AudioContext time (cosmetic cleanup only). */
function scheduleAfter(ctx: AudioContext, ctxTime: number, fn: () => void): void {
  setTimeout(fn, Math.max(0, (ctxTime - ctx.currentTime) * 1000));
}
