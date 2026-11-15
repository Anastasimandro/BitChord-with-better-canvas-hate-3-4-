/*
 * Ported from Orchard (https://github.com/SFG5453/Orchard).
 *
 * Copyright (C) 2026 SFG545 (original Orchard implementation)
 * Copyright (C) 2026 Kushagra Singh (BitChord adaptation)
 *
 * Orchard's original source is licensed under the GNU Affero General Public
 * License, version 3 or later. Per AGPLv3 section 13, this file is combined
 * here into BitChord -- a work licensed under the GNU General Public
 * License, version 3 or later -- and remains itself governed by the AGPLv3
 * as part of that combination.
 *
 * This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero
 * General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

package com.music.bitchord.playback.smart

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * The confidence-aware transition policy.
 *
 * Analysis happens ahead of playback (see [TrackAnalyzer]), and the runtime
 * only decides how ambitious a transition the stored evidence can support.
 * Ambition degrades in explicit tiers as certainty falls (see
 * [TransitionTier]) rather than letting one engine quietly do beat math on
 * junk data.
 *
 * Every judgement here is made from stored analysis fields and their
 * confidences; nothing in this file touches PCM.
 */

/**
 * Below this the analyzer's beat grid is treated as a guess, and no renderer
 * may stretch or phase-align against it. Catalog tempo lookups merge in with
 * `beatConfidence` 0, so a metadata BPM alone can never authorize
 * beat-matching.
 *
 * Not the web player's `MIN_GRID_CONFIDENCE` (0.2) despite the similar job:
 * that gate reads a *coverage* score — the share of a window's beats the grid
 * explained — while this one reads Beat This!'s own per-beat confidence, a
 * different measure on a different scale. The web window needs 0.2 of
 * coverage to be trusted; a grid that explained a fifth of its window would
 * never clear 0.55 of confidence here. The two numbers are both "the floor a
 * grid must clear", not the same number wearing two hats — neither is the
 * other's value, and porting one across platforms would silently strand
 * every pair one rung down the ladder.
 */
const val MIN_BEATMATCH_CONFIDENCE = 0.55

/**
 * Below this on both tracks, even the DJ-assisted crossfade (beat-quantized
 * anchors, EQ handoff) is off the table and the mix degrades to a plain fade.
 */
const val MIN_DJ_CONFIDENCE = 0.2

/** One octave either side of a typical dance tempo; outside this the analysis is noise. */
const val MIN_BPM = 40.0
const val MAX_BPM = 220.0

/**
 * The blend's stretch window: the incoming song may be slowed down by at most
 * 10% and sped up by at most 25% to meet the outgoing tempo. Asymmetric
 * because the two directions fail differently: a stretch that speeds up drops
 * slivers of audio and stays clean far past 10%, while one that slows down has
 * to repeat them, which is where the metallic smear comes from. Past either
 * end the pair is not beatmatched (the filter mix). The web player uses the
 * same window.
 */
const val MIN_INCOMING_RATE = 0.9
const val MAX_INCOMING_RATE = 1.25

/**
 * The rate the incoming song plays at to meet [outgoingBpm] (its tempo folded
 * into the outgoing octave first): above 1 speeds it up.
 */
fun incomingRateBetween(outgoingBpm: Double, incomingBpm: Double): Double {
    if (outgoingBpm <= 0 || incomingBpm <= 0) return Double.NaN
    return outgoingBpm / alignTempoOctave(outgoingBpm, incomingBpm)
}

/** Whether a blend can beatmatch this pair inside [MIN_INCOMING_RATE]..[MAX_INCOMING_RATE]. */
fun stretchReachable(outgoingBpm: Double, incomingBpm: Double): Boolean {
    val rate = incomingRateBetween(outgoingBpm, incomingBpm)
    return rate.isFinite() && rate >= MIN_INCOMING_RATE - 1e-9 && rate <= MAX_INCOMING_RATE + 1e-9
}

/**
 * A vocal-activity mask value at or above this counts as singing.
 *
 * Measured on the open-unmix mask (Hymn for the Weekend, 2026-10-23): a clear
 * chorus reads 0.57–0.71, a soft verse over the music 0.2–0.4, an instrumental
 * break 0.02–0.15. The old 0.6 called a soft verse instrumental. The DSP
 * fallback mask is rescaled onto this scale when it is stored (see
 * [heuristicVocalOnModelScale]), and unmeasured instants are stored just under
 * it, so neither trips vocal logic on its own.
 */
const val VOCAL_ACTIVE_THRESHOLD = 0.25

/**
 * The DSP heuristic's vocal value, moved onto the model's scale: its own
 * decision boundary (0.6, where it was tuned) lands on [VOCAL_ACTIVE_THRESHOLD],
 * linearly on either side, so it decides exactly what it used to.
 */
fun heuristicVocalOnModelScale(value: Double): Double {
    if (!value.isFinite()) return value
    val v = value.coerceIn(0.0, 1.0)
    return if (v < HEURISTIC_VOCAL_THRESHOLD) {
        v / HEURISTIC_VOCAL_THRESHOLD * VOCAL_ACTIVE_THRESHOLD
    } else {
        VOCAL_ACTIVE_THRESHOLD + (v - HEURISTIC_VOCAL_THRESHOLD) / (1 - HEURISTIC_VOCAL_THRESHOLD) * (1 - VOCAL_ACTIVE_THRESHOLD)
    }
}

/** Where the DSP heuristic was tuned to call a frame sung. */
private const val HEURISTIC_VOCAL_THRESHOLD = 0.6

/**
 * How much of the outgoing track's remaining *music* a transition may skip by
 * ending before its content does. A transition is allowed to leave a short
 * tail unplayed; it is not allowed to cut the song short.
 */
const val MAX_DISCARDED_MUSIC_SECONDS = 12.0

/**
 * Fraction of a track's own loud-end reference below which a sample counts as
 * silence rather than music, so a genuine gap costs nothing against the budget.
 */
private const val AUDIBLE_ENERGY_FRACTION = 0.1

/**
 * How much each candidate type is trusted as an entry point before scoring.
 * Drops are where an arrangement arrives, so they dominate; a pickup is just
 * "the file starts making sound" and a phrase boundary is only a grid line.
 */
private val MIX_IN_TYPE_WEIGHT = mapOf(
    "main_drop" to 0.5,
    "intro_drop" to 0.4,
    "pickup" to 0.15,
    "phrase" to 0.1,
)

/**
 * Mirrors the analyzer's own scoring of mix-out candidates, used when an
 * analysis carries the scalar fields but not the candidate list.
 */
private val MIX_OUT_TYPE_SCORE = mapOf(
    "energy_cliff" to 0.95,
    "interior_mix_out" to 0.95,
    "outro_start" to 0.9,
    "content_end" to 0.75,
)

/** Non-finite guards, matching the desktop planner's coercion of `NaN`/`Infinity` to zero. */
fun Double.orZero(): Double = if (isFinite()) this else 0.0

fun Double?.orZero(): Double = if (this != null && isFinite()) this else 0.0

fun clamp(value: Double, min: Double, max: Double): Double =
    if (value.isFinite()) max(min, min(max, value)) else min

/**
 * Halves or doubles [incomingBpm] until it is as close as possible to
 * [outgoingBpm], the way a DJ counts a 63 BPM track against a 126 BPM one.
 */
fun alignTempoOctave(outgoingBpm: Double, incomingBpm: Double): Double {
    if (outgoingBpm <= 0 || incomingBpm <= 0) return incomingBpm
    var aligned = incomingBpm
    while (aligned / outgoingBpm > 1.5) aligned /= 2
    while (aligned / outgoingBpm < 0.67) aligned *= 2
    return aligned
}

/**
 * Mean vocal activity over [start]..[end] on a track's own timeline, or null
 * when the analysis carries no usable mask there. The mask is indexed against
 * [TrackAnalysis.energyCurve] times.
 */
fun vocalActivityBetween(analysis: TrackAnalysis, start: Double, end: Double): Double? {
    val mask = analysis.vocalActivityMask
    val curve = analysis.energyCurve
    if (mask.isEmpty() || mask.size != curve.size || end <= start) return null
    var sum = 0.0
    var count = 0
    for (index in mask.indices) {
        val time = curve[index].time
        if (!time.isFinite() || time < start || time > end) continue
        val value = mask[index]
        if (!value.isFinite()) continue
        sum += value
        count += 1
    }
    return if (count > 0) sum / count else null
}

/**
 * Both windows measurably singing at once. Null means "no evidence", which
 * never blocks; absence of a mask is not absence of a vocal, but acting on it
 * would punish every track a fallback analyzer handled.
 */
fun isVocalClash(outgoingActivity: Double?, incomingActivity: Double?): Boolean =
    outgoingActivity != null &&
        incomingActivity != null &&
        outgoingActivity >= VOCAL_ACTIVE_THRESHOLD &&
        incomingActivity >= VOCAL_ACTIVE_THRESHOLD

/**
 * How strongly two windows sing over each other: 0 for nothing worth acting on,
 * 1 for two fully vocal passages landing on one another.
 *
 * [isVocalClash]'s graded counterpart, and the reason for having both. A boolean
 * is the right shape for a routing decision — shorten the overlap or don't — but
 * it is the wrong shape for the renderer, which has to decide *how hard* to pull
 * the two voices apart. A pair scraping over the threshold and two choruses
 * colliding are the same `true` and want visibly different treatment.
 *
 * Governed by the quieter of the two, because a clash needs both sides: an
 * instrumental passage under a vocal is not a clash however loud the vocal is,
 * and taking a mean would let one strong side manufacture one.
 *
 * Null on either side is no evidence and answers zero, which leaves whatever the
 * caller would have done anyway. Absence of a mask is not absence of a vocal —
 * but acting on it would filter every track a fallback analyzer handled.
 */
fun vocalOverlapAmount(outgoingActivity: Double?, incomingActivity: Double?): Double {
    if (outgoingActivity == null || incomingActivity == null) return 0.0
    val both = min(outgoingActivity, incomingActivity)
    if (both <= VOCAL_ACTIVE_THRESHOLD) return 0.0
    return ((both - VOCAL_ACTIVE_THRESHOLD) / (1.0 - VOCAL_ACTIVE_THRESHOLD)).coerceIn(0.0, 1.0)
}

/**
 * The fraction of a planned overlap where **both** tracks are singing at the
 * same instant, or null when either side has no mask.
 *
 * Why this exists alongside [vocalActivityBetween]: that one answers with a
 * *mean* over the window, and a mean is the wrong statistic for a clash. Twelve
 * seconds holding three seconds of vocal and nine of instrumental averages well
 * under [VOCAL_ACTIVE_THRESHOLD] and reads as clear — while the listener plainly
 * hears two voices for those three seconds. Every clash short of about half the
 * overlap was being averaged into silence, which is why a transition could be
 * planned as clean and still land two vocals on top of each other.
 *
 * Instant by instant instead. The outgoing track's own energy-curve samples are
 * the clock; each is mapped onto the incoming timeline through [rate], because a
 * stretched incoming track covers proportionally more of its own timeline in the
 * same wall-clock second. Unmeasured regions sit at the analyzer's neutral 0.5,
 * below the threshold, so they count as "not singing" rather than as evidence.
 *
 * Both curves are time-ascending, so the incoming index only ever moves forward:
 * this is one pass over each, not a search per sample.
 */
fun simultaneousVocalFraction(
    outgoing: TrackAnalysis,
    incoming: TrackAnalysis,
    outStart: Double,
    outEnd: Double,
    inStart: Double,
    rate: Double,
): Double? {
    val outMask = outgoing.vocalActivityMask
    val outCurve = outgoing.energyCurve
    val inMask = incoming.vocalActivityMask
    val inCurve = incoming.energyCurve
    if (outMask.isEmpty() || outMask.size != outCurve.size) return null
    if (inMask.isEmpty() || inMask.size != inCurve.size) return null
    if (outEnd <= outStart) return null
    val step = if (rate.isFinite() && rate > 0) rate else 1.0

    var inIndex = 0
    var both = 0
    var total = 0
    for (index in outMask.indices) {
        val time = outCurve[index].time
        if (!time.isFinite() || time < outStart) continue
        if (time > outEnd) break
        total += 1
        if (outMask[index] < VOCAL_ACTIVE_THRESHOLD) continue
        val target = inStart + (time - outStart) * step
        while (inIndex + 1 < inCurve.size && inCurve[inIndex + 1].time <= target) inIndex += 1
        if (inMask[inIndex] >= VOCAL_ACTIVE_THRESHOLD) both += 1
    }
    return if (total > 0) both.toDouble() / total else null
}

/**
 * How much simultaneous vocal a transition may carry before it counts as a
 * clash worth reshaping the overlap for.
 *
 * Not zero. A mask is a model's estimate sampled on a coarse grid, and both
 * edges of a vocal phrase are soft, so demanding literal zero would refuse
 * overlaps that sound clean and spend the fade budget chasing a rounding error.
 * A twentieth of the window is roughly one energy-curve sample either side of a
 * boundary.
 */
const val VOCAL_CLASH_TOLERANCE = 0.05

/**
 * Seconds of audible music in [start]..[end] on a track's own timeline,
 * judged against the track's own loud-end reference so the measure is
 * independent of how the analyzer scales energy. Returns null when there is
 * no usable curve.
 */
fun audibleSecondsBetween(analysis: TrackAnalysis, start: Double, end: Double): Double? {
    val curve = analysis.energyCurve
    if (curve.size < 2 || end <= start) return null
    val energies = curve.map { it.energy }.filter { it.isFinite() && it >= 0 }.sorted()
    if (energies.isEmpty()) return null
    val reference = energies[floor((energies.size - 1) * 0.85).toInt()].orZero()
    if (reference <= 0) return 0.0
    val threshold = reference * AUDIBLE_ENERGY_FRACTION
    val first = curve.first().time
    val last = curve.last().time
    if (!first.isFinite() || !last.isFinite() || last <= first) return null
    val sampleSeconds = (last - first) / (curve.size - 1)
    var audible = 0.0
    for (point in curve) {
        if (!point.time.isFinite() || point.time < start || point.time > end) continue
        if (point.energy >= threshold) audible += sampleSeconds
    }
    return audible
}

/**
 * The earliest point the analysis claims the track makes sound.
 *
 * [TrackAnalysis.firstBeat] is not nullable the way the other two are, and
 * the analyzer uses 0.0 as its "nothing was measured" fallback. Counting that
 * zero as a real audible start pins this to 0 for any track without a beat
 * grid, which silently overrides a measured `audibleStartTime` and tells the
 * planner the whole head of the track is intro it can fade across.
 */
fun audibleStartOf(analysis: TrackAnalysis): Double {
    val firstBeat = analysis.firstBeat.takeIf { it.isFinite() && it > 0 }
    val candidates = listOfNotNull(analysis.audibleStartTime, analysis.pickupTime, firstBeat)
        .filter { it.isFinite() && it >= 0 }
    return candidates.minOrNull() ?: 0.0
}

/** The value in [values] closest to [target] within [tolerance], or null when none qualifies. */
fun nearestValue(values: List<Double>, target: Double, tolerance: Double): Double? =
    values.filter { it.isFinite() && abs(it - target) <= tolerance }
        .minByOrNull { abs(it - target) }

/**
 * Ranks a track's analyzed mix-in candidates as entry points for a
 * transition, best first.
 *
 * Selection is a scoring problem, not a type lookup: the analyzer's own
 * score, the candidate type, downbeat alignment, whether there is any intro
 * before the point to bed under the outgoing track, and how vocal that intro
 * is all move a candidate up or down.
 */
fun rankMixInCandidates(analysis: TrackAnalysis): List<RankedMixCandidate> {
    val candidates = analysis.mixInCandidates.filter { it.time.isFinite() && it.time >= 0 }
    if (candidates.isEmpty()) return emptyList()
    val beatSeconds = analysis.beatInterval.orZero()
        .takeIf { it > 0 }
        ?: if (analysis.bpm.orZero() > 0) 60 / analysis.bpm else 0.5
    val audibleStart = audibleStartOf(analysis)
    return candidates.map { candidate ->
        var rankScore = candidate.score.orZero() + (MIX_IN_TYPE_WEIGHT[candidate.type] ?: 0.0)
        if (nearestValue(analysis.downbeats, candidate.time, beatSeconds / 2) != null) rankScore += 0.1
        // A cold open: nothing before the point to play underneath the outgoing track, so entering
        // here means starting the blend on the arrangement.
        if (candidate.time - audibleStart < beatSeconds * 4) rankScore -= 0.2
        // Prefer entries whose run-up is instrumental; an intro that already sings will sing over
        // the outgoing track for the whole pre-roll.
        val vocal = vocalActivityBetween(
            analysis,
            max(audibleStart, candidate.time - beatSeconds * 16),
            candidate.time,
        )
        if (vocal != null) rankScore += (0.5 - vocal) * 0.4
        RankedMixCandidate(
            time = candidate.time,
            score = candidate.score.orZero(),
            type = candidate.type,
            rankScore = rankScore,
        )
    }.sortedByDescending { it.rankScore }
}

/** Falls back to the scalar mix-out fields when the analysis carries no candidate list. */
private fun mixOutCandidatesOf(analysis: TrackAnalysis, contentEnd: Double): List<MixCandidate> {
    val supplied = analysis.mixOutCandidates.filter { it.time.isFinite() && it.time > 0 }
    val candidates = supplied.map {
        MixCandidate(time = it.time, score = it.score.orZero(), type = it.type)
    }.toMutableList()
    if (supplied.isEmpty()) {
        val mixOut = analysis.mixOutTime.orZero()
        val outroStart = analysis.outroStartTime.orZero()
        if (mixOut > 0 && mixOut < contentEnd - 1) {
            candidates += MixCandidate(mixOut, 0.95, "energy_cliff")
        }
        if (outroStart > 0 && outroStart < contentEnd - 1) {
            candidates += MixCandidate(outroStart, 0.9, "outro_start")
        }
    }
    // Vocals describe how the overlap should be shaped, not where the outgoing song stops. The
    // incoming instrumental runway can begin under an outgoing vocal; promoting vocal boundaries
    // to exit anchors waits for the easy gap (or skips the vocal tail entirely) instead of asking
    // the filter ride and gain curves to blend it. Only structural and energy candidates choose
    // the exit. The transition always has somewhere to end: where the content does.
    if (candidates.none { abs(it.time - contentEnd) < 0.05 }) {
        candidates += MixCandidate(contentEnd, 0.75, "content_end")
    }
    return candidates
}

/** Resolves the content end from the analysis and the caller's overrides, in priority order. */
private fun resolveContentEnd(analysis: TrackAnalysis, contentEnd: Double, duration: Double): Double =
    contentEnd.orZero().takeIf { it != 0.0 }
        ?: analysis.contentEndTime.orZero().takeIf { it != 0.0 }
        ?: duration.orZero().takeIf { it != 0.0 }
        ?: analysis.duration.orZero()

/**
 * Ranks a track's analyzed mix-out candidates as places for a transition to
 * end, best first.
 *
 * Candidates that would skip more than [MAX_DISCARDED_MUSIC_SECONDS] of
 * remaining music are dropped outright: how confidently the analyzer marked a
 * boundary is no argument for cutting a song short, and both an outro marker
 * and a mid-track silence gap will happily do exactly that. Silence is free,
 * so a genuine interior gap still wins the anchor it deserves.
 */
fun rankMixOutCandidates(
    analysis: TrackAnalysis,
    contentEnd: Double = 0.0,
    duration: Double = 0.0,
): List<RankedMixCandidate> {
    val end = resolveContentEnd(analysis, contentEnd, duration)
    if (end <= 0) return emptyList()
    return mixOutCandidatesOf(analysis, end)
        .map { candidate ->
            val measured = audibleSecondsBetween(analysis, candidate.time, end)
            // With no energy curve there is no way to tell skipped music from skipped silence, so
            // the raw gap is charged in full and the budget errs toward playing the track.
            RankedMixCandidate(
                time = candidate.time,
                score = candidate.score,
                type = candidate.type,
                rankScore = candidate.score + (MIX_OUT_TYPE_SCORE[candidate.type] ?: 0.0),
                discardedMusicSeconds = measured ?: max(0.0, end - candidate.time),
                measured = measured != null,
            )
        }
        .filter { it.discardedMusicSeconds <= MAX_DISCARDED_MUSIC_SECONDS }
        .sortedWith(compareByDescending<RankedMixCandidate> { it.rankScore }.thenByDescending { it.time })
}

/**
 * Where the outgoing track's transition ends: the best-ranked mix-out
 * candidate that stays inside the discarded-music budget, or the end of
 * content when none does.
 */
fun resolveMixOutAnchor(
    analysis: TrackAnalysis,
    contentEnd: Double = 0.0,
    duration: Double = 0.0,
): MixOutAnchor {
    val end = resolveContentEnd(analysis, contentEnd, duration)
    val best = rankMixOutCandidates(analysis, end, duration).firstOrNull()
    return MixOutAnchor(
        time = best?.time ?: end,
        type = best?.type ?: "content_end",
        discardedMusicSeconds = best?.discardedMusicSeconds ?: 0.0,
    )
}

/**
 * Decides how ambitious a transition the stored analysis supports.
 *
 * Reasons are ordered most-disqualifying first so callers can surface
 * `reasons.first()` as the routing verdict.
 */
fun assessTransitionTier(
    analysis: TrackAnalysis,
    nextAnalysis: TrackAnalysis,
    /** Advanced Automix: the same stretch window as classic ([stretchReachable]); kept for callers. */
    advanced: Boolean = false,
): TransitionPolicyVerdict {
    val outgoingBpm = analysis.bpm.orZero()
    val incomingBpm = nextAnalysis.bpm.orZero()
    val outgoingConfidence = analysis.beatConfidence.orZero()
    val incomingConfidence = nextAnalysis.beatConfidence.orZero()
    val floorConfidence = min(outgoingConfidence, incomingConfidence)
    val reasons = mutableListOf<String>()

    if (outgoingBpm < MIN_BPM || outgoingBpm > MAX_BPM) reasons += "outgoing-tempo"
    if (incomingBpm < MIN_BPM || incomingBpm > MAX_BPM) reasons += "incoming-tempo"
    if (reasons.isNotEmpty()) {
        return TransitionPolicyVerdict(TransitionTier.PLAIN_CROSSFADE, reasons, floorConfidence)
    }

    if (outgoingConfidence < MIN_DJ_CONFIDENCE && incomingConfidence < MIN_DJ_CONFIDENCE) {
        return TransitionPolicyVerdict(
            TransitionTier.PLAIN_CROSSFADE,
            listOf("beat-confidence"),
            floorConfidence,
        )
    }

    if (!stretchReachable(outgoingBpm, incomingBpm)) reasons += "tempo-distance"
    if (outgoingConfidence < MIN_BEATMATCH_CONFIDENCE || incomingConfidence < MIN_BEATMATCH_CONFIDENCE) {
        reasons += "beat-confidence"
    }

    return TransitionPolicyVerdict(
        tier = if (reasons.isEmpty()) TransitionTier.BEATMATCHED else TransitionTier.DJ_ASSISTED,
        reasons = reasons,
        beatConfidence = floorConfidence,
    )
}

// ============================================================================
// Phase 2 Task 6 — Style Scorer with Hard Gates (mirrors web policy.ts)
// ============================================================================

/** Candidate transition styles, from highest to lowest ambition. */
enum class StyleCandidate {
    LOOP, BLEND, FILTER, FADE, GAP
}

/** Result of evaluating a single candidate against the hard gates. */
data class StyleGateResult(
    val candidate: StyleCandidate,
    val passes: Boolean,
    val killReason: String?,
    val score: Double,
    /** Phase 3 Task 5: why FILTER passed its gate - "two-kicks" | "impossible-tempo" | null. */
    val filterGateReason: String? = null,
)

/** Input data needed to score a pair of tracks for all candidates. */
data class StyleScorerInput(
    /** The outgoing track's own analysis: the delay gesture reads its close directly. */
    val out: TrackAnalysis = TrackAnalysis(),
    val outGridConf: Double,
    val inGridConf: Double,
    val vocalOverlap: Double?,
    val stretchRatio: Double,
    val residualDeltaLufs: Double?,
    val hasLoopPlan: Boolean,
    val loopOutBars: Int,
    val loopInBars: Int,
    val loopFold: Double,
    val energyContinuity: Double,
    val outLowEnergyAtJoin: Double?,
    val inLowEnergyAtJoin: Double?,
)

/** Hard gate thresholds — named constants with rationale in comments. */
// Grid confidence below which BLEND is killed (phone scale MIN_BEATMATCH_CONFIDENCE = 0.55).
private const val MIN_GRID_CONF_FOR_BLEND = 0.55
// Vocal overlap fraction above which long BLEND is killed (task-2 cap).
private const val VOCAL_OVERLAP_BLEND_CAP = 0.15
// Residual LUFS delta (dB) above which bass swap inside BLEND is killed (task-4).
private const val RESIDUAL_LUFS_BASS_SWAP_KILL_DB = 4.0
// Stretch window for BLEND (0.9..1.25, asymmetric: -10% / +25%).
private const val BLEND_STRETCH_MIN = 0.9
private const val BLEND_STRETCH_MAX = 1.25
// Minimum clean loop bars on each side for LOOP candidate.
private const val LOOP_MIN_CLEAN_BARS = 2
// LOOP stretch window with fold applied.
private const val LOOP_STRETCH_MIN = 0.9
private const val LOOP_STRETCH_MAX = 1.25
// Energy continuity bonus weight in the score formula.
private const val ENERGY_CONTINUITY_WEIGHT = 0.1
// Gratuitous FILTER penalty (applied unless two kicks or impossible tempo).
private const val FILTER_PENALTY = 0.25
// KICK_PRESENT threshold for FILTER gesture selection.
private const val KICK_PRESENT = 0.5

/**
 * Evaluates a single candidate against its hard gates.
 * Returns the gate result with pass/fail, kill reason, and score (if passing).
 */
private fun evaluateCandidate(input: StyleScorerInput, candidate: StyleCandidate): StyleGateResult {
    val avgGridConf = (input.outGridConf + input.inGridConf) / 2

    return when (candidate) {
        StyleCandidate.GAP -> {
            // GAP gate: would need detectGap ported; for now assume false (no GAP without energy curves)
            StyleGateResult(candidate, false, "no melodic close or clear opener (energy curves unavailable)", 0.0)
        }
        StyleCandidate.FADE -> {
            // FADE has no hard gates — it's the safety net
            val score = 0.4 + avgGridConf * 0.2 + input.energyContinuity * ENERGY_CONTINUITY_WEIGHT
            StyleGateResult(candidate, true, null, score)
        }
        StyleCandidate.LOOP -> {
            if (!input.hasLoopPlan) {
                StyleGateResult(candidate, false, "no loop plan prepared", 0.0)
            } else if (input.loopOutBars < LOOP_MIN_CLEAN_BARS || input.loopInBars < LOOP_MIN_CLEAN_BARS) {
                StyleGateResult(candidate, false, "clean loops < $LOOP_MIN_CLEAN_BARS bars", 0.0)
            } else {
                val ratioWithFold = input.loopFold * input.stretchRatio
                if (ratioWithFold < LOOP_STRETCH_MIN || ratioWithFold > LOOP_STRETCH_MAX) {
                    StyleGateResult(candidate, false, "ratio with fold ${twoDecimals(ratioWithFold)} outside $LOOP_STRETCH_MIN-$LOOP_STRETCH_MAX", 0.0)
                } else {
                    // loopCleanliness: placeholder (would use actual loop vocal share)
                    val loopCleanliness = 0.8
                    val entryShapeOfB = 0.8
                    val score = avgGridConf * (1 - abs(input.stretchRatio - 1) / 0.25) * (1 - (input.vocalOverlap ?: 0.0)) * loopCleanliness * entryShapeOfB
                    StyleGateResult(candidate, true, null, score)
                }
            }
        }
        StyleCandidate.BLEND -> {
            if (avgGridConf < MIN_GRID_CONF_FOR_BLEND) {
                StyleGateResult(candidate, false, "avg grid confidence ${twoDecimals(avgGridConf)} < $MIN_GRID_CONF_FOR_BLEND", 0.0)
            } else if (input.stretchRatio < BLEND_STRETCH_MIN || input.stretchRatio > BLEND_STRETCH_MAX) {
                StyleGateResult(candidate, false, "stretch ratio ${twoDecimals(input.stretchRatio)} outside $BLEND_STRETCH_MIN-$BLEND_STRETCH_MAX", 0.0)
            } else {
                // vocalOverlap > 0.15 caps BLEND at 4 bars (handled at length level)
                val loopCleanliness = 1 - (input.vocalOverlap ?: 0.0)
                val entryShapeOfB = 1.0
                val baseScore = avgGridConf * (1 - abs(input.stretchRatio - 1) / 0.25) * loopCleanliness * entryShapeOfB
                val score = baseScore + input.energyContinuity * ENERGY_CONTINUITY_WEIGHT
                StyleGateResult(candidate, true, null, score)
            }
        }
        StyleCandidate.FILTER -> {
            // Phase 3 Task 5: FILTER hard gate - requires two kicks at join OR impossible tempo
            val hasTwoKicks = (input.outLowEnergyAtJoin ?: 0.0) >= KICK_PRESENT && (input.inLowEnergyAtJoin ?: 0.0) >= KICK_PRESENT
            val impossibleTempo = input.stretchRatio < BLEND_STRETCH_MIN || input.stretchRatio > BLEND_STRETCH_MAX
            if (!hasTwoKicks && !impossibleTempo) {
                // Hard gate: FILTER dies without two kicks or impossible tempo
                StyleGateResult(candidate, false, "no-two-kicks", 0.0, null)
            } else {
                // FILTER passes: score without penalty
                val score = 0.3 * avgGridConf + input.energyContinuity * ENERGY_CONTINUITY_WEIGHT
                val gateReason = if (hasTwoKicks && !impossibleTempo) "two-kicks"
                else if (impossibleTempo) "impossible-tempo"
                else null
                StyleGateResult(candidate, true, null, score, gateReason)
            }
        }
    }
}

/**
 * The Style Scorer: evaluates all candidates against hard gates, scores the
 * passing ones, and returns the best candidate with its score and blend length.
 *
 * Pure function: no state, no clock, no randomness.
 */
data class StyleScoreResult(
    val style: StyleCandidate,
    val score: Double,
    val rejectedStylesAndWhy: List<Pair<StyleCandidate, String>>,
    val bars: Int,
    val bassSwapAllowed: Boolean,
    val vocalOverlapCapBars: Int?,
    /** Phase 3: the FX gesture chosen for this transition ('none' | 'delay' | 'reverb' | 'both'). */
    val gesture: String,
    /** Phase 3: total gesture seconds (delay + reverb), 0 for 'none'. */
    val gestureSeconds: Double,
    /** Phase 3: gestures considered and rejected, with reasons. */
    val rejectedGesturesAndWhy: List<Pair<String, String>>,
    /** Phase 3 Task 5: why FILTER passed its gate - "two-kicks" | "impossible-tempo" | null. */
    val filterGateReason: String?,
)

fun scoreStyles(input: StyleScorerInput): StyleScoreResult {
    val candidates = listOf(StyleCandidate.LOOP, StyleCandidate.BLEND, StyleCandidate.FILTER, StyleCandidate.FADE, StyleCandidate.GAP)
    val results = candidates.map { evaluateCandidate(input, it) }

    // Phase 3 Task 2: the delay is a scorer decision with a recorded reason —
    // no default path adds it. Reverb has no scorer yet (task 4); its absence
    // stays implicit in the 'none'.
    val delayDecision = scoreDelayGesture(input.out, input.outGridConf)
    val gesture = if (delayDecision.chosen) "delay" else "none"
    val gestureSeconds = if (delayDecision.chosen) delayDecision.delaySec ?: 0.0 else 0.0
    val rejectedGesturesAndWhy: List<Pair<String, String>> =
        if (delayDecision.chosen) emptyList()
        else listOf("delay" to (delayDecision.killReason ?: "unknown"))

    val passing = results.filter { it.passes }
    if (passing.isEmpty()) {
        return StyleScoreResult(
            style = StyleCandidate.FADE,
            score = 0.0,
            rejectedStylesAndWhy = results.map { it.candidate to (it.killReason ?: "unknown") },
            bars = 8,
            bassSwapAllowed = false,
            vocalOverlapCapBars = null,
            gesture = gesture,
            gestureSeconds = gestureSeconds,
            rejectedGesturesAndWhy = rejectedGesturesAndWhy,
            filterGateReason = null,
        )
    }

    val best = passing.maxByOrNull { it.score } ?: passing.first()
    val avgGridConf = (input.outGridConf + input.inGridConf) / 2

    // Determine blend length by confidence (4/8/16) — mirrors effectiveBlendBars
    val bars = when {
        avgGridConf >= 0.6 -> 16
        avgGridConf >= 0.45 -> 8
        else -> 4
    }

    // Vocal overlap cap: if > 0.15, cap BLEND at 4 bars
    val vocalOverlapCapBars = if ((input.vocalOverlap ?: 0.0) > VOCAL_OVERLAP_BLEND_CAP) 4 else null

    // Bass swap allowed: only on BLEND with sufficient bars and residual delta LUFS <= 4 dB
    val bassSwapAllowed = best.candidate == StyleCandidate.BLEND &&
        bars >= 8 &&
        (input.residualDeltaLufs == null || abs(input.residualDeltaLufs!!) <= RESIDUAL_LUFS_BASS_SWAP_KILL_DB)

    // Phase 3 Task 5: filterGateReason for overlap cap decision
    val filterGateReason = if (best.candidate == StyleCandidate.FILTER) {
        // Use the gateReason from the passing result if available
        val gateResult = results.first { it.candidate == StyleCandidate.FILTER }
        gateResult.filterGateReason
    } else null

    return StyleScoreResult(
        style = best.candidate,
        score = best.score,
        rejectedStylesAndWhy = results.filter { !it.passes }.map { it.candidate to (it.killReason ?: "unknown") },
        bars = if (best.candidate == StyleCandidate.BLEND && vocalOverlapCapBars != null) min(bars, vocalOverlapCapBars!!) else bars,
        bassSwapAllowed = bassSwapAllowed,
        vocalOverlapCapBars = vocalOverlapCapBars,
        gesture = gesture,
        gestureSeconds = gestureSeconds,
        rejectedGesturesAndWhy = rejectedGesturesAndWhy,
        filterGateReason = filterGateReason,
    )
}

// ============================================================================
// Phase 3 Task 3 — the delay gesture (mirrors web policy.ts scoreDelayGesture)
// ============================================================================

/** Two decimals in a gate reason, without the JVM-only [String.format]. */
internal fun twoDecimals(value: Double): String {
    val rounded = (value * 100).toLong() / 100.0
    return if (rounded == rounded.toLong().toDouble()) "${rounded.toLong()}.00"
    else if ((rounded * 10) == (rounded * 10).toLong().toDouble()) "${rounded}0"
    else "$rounded"
}

/** The [p] quantile of [values], as the web policy reads its tail views (60th percentile). */
fun percentileOf(values: List<Double>, p: Double): Double {
    if (values.isEmpty()) return 0.0
    val sorted = values.sorted()
    return sorted[min(sorted.size - 1, floor(sorted.size * p).toInt())]
}

/** The phone's MIN_BEATMATCH scale: a rhythmic close needs a trusted grid. */
const val DELAY_MIN_GRID_CONFIDENCE = 0.55
/** The join's air is measured over the outgoing track's last two beats. */
const val DELAY_AIR_BEATS = 2
/** The last two beats sit at most this share of the tail's typical (p60) energy. */
const val DELAY_AIR_MAX_SHARE = 0.35
/** Ceiling on the delay time: covers every beat down to 30 BPM; a longer, corrupt beat is a refused order. */
const val DELAY_MAX_SEC = 2.0

/** The delay gesture's decision: chosen with its beat length, or killed with the reason for the telemetry. */
data class DelayGestureDecision(
    val chosen: Boolean,
    /** One beat of the outgoing grid, in track seconds; the deck applies its effective rate. */
    val delaySec: Double?,
    /** The gate that killed the candidate, or null when chosen. */
    val killReason: String?,
)

/**
 * The delay throws the outgoing track's close into a beat-synced echo. It is
 * a CHOSEN gesture, never default: it fits only a close with AIR — the last
 * ~2 beats go quiet — on a trusted grid, so the repeats land ON the beat. A
 * sustained melodic close (quiet all the way through the tail, no drop) is
 * reverb territory (task 4), never a delay: nothing to throw, only something
 * to bloom. Pure function: no state, no clock, no randomness. Ported from the
 * web's [scoreDelayGesture] — the schema's Kotlin curve is one whole-track
 * span (the web's edge spans fold into the same whole view there), so the
 * tail view is the whole curve.
 */
fun scoreDelayGesture(out: TrackAnalysis, outGridConf: Double): DelayGestureDecision {
    fun no(reason: String) = DelayGestureDecision(chosen = false, delaySec = null, killReason = reason)
    val beatSec = out.beatInterval
    if (!(beatSec.isFinite() && beatSec > 0)) {
        return no("no outgoing beat grid for a rhythmic delay")
    }
    if (outGridConf < DELAY_MIN_GRID_CONFIDENCE) {
        return no("outgoing grid confidence ${twoDecimals(outGridConf)} < $DELAY_MIN_GRID_CONFIDENCE")
    }
    if (out.energyCurve.isEmpty() || out.duration <= 0) {
        return no("no energy evidence at the outgoing close")
    }
    val windowSec = out.duration / out.energyCurve.size
    val typical = percentileOf(out.energyCurve.map { it.energy }, 0.6)
    if (typical <= 0) return no("no energy evidence at the outgoing close")
    val duration = min(out.duration, out.energyCurve.size * windowSec)
    val airWindow = DELAY_AIR_BEATS * beatSec

    fun meanOver(fromSec: Double, toSec: Double): Double? {
        val firstIdx = max(0, ceil((fromSec) / windowSec).toInt())
        val lastIdx = min(out.energyCurve.size, floor(toSec / windowSec).toInt())
        if (lastIdx <= firstIdx) return null
        var sum = 0.0
        for (i in firstIdx until lastIdx) sum += out.energyCurve[i].energy
        return sum / (lastIdx - firstIdx)
    }

    val air = meanOver(duration - airWindow, duration)
        ?: return no("no energy evidence at the outgoing close")
    if (air > typical * DELAY_AIR_MAX_SHARE) {
        return no("no air in the outgoing close")
    }
    // air with no content before it is not a drop — it is a sustained close
    val before = meanOver(duration - airWindow * 2, duration - airWindow)
    if (before == null || before <= typical * DELAY_AIR_MAX_SHARE) {
        return no("sustained melodic close — reverb territory, not delay")
    }
    return DelayGestureDecision(chosen = true, delaySec = beatSec, killReason = null)
}