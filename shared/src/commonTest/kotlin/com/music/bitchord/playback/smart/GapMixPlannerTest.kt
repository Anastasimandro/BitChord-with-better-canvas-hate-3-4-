package com.music.bitchord.playback.smart

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The gap mix: earned only by a pair whose evidence says the outgoing track
 * closes and the incoming one opens — and never by a weak grid, which falls
 * to the plain crossfade.
 */
class GapMixPlannerTest {

    /** A fully analysed track on a steady grid, matching [PhraseBarAutomixTest]. */
    private fun track(
        id: String,
        bpm: Double,
        energyCurve: List<EnergySample>,
        duration: Double = 200.0,
        beatConfidence: Double = 0.9,
        firstDownbeat: Double = 0.5,
    ): TrackAnalysis {
        val beat = 60.0 / bpm
        val downbeats = generateSequence(firstDownbeat) { it + 4 * beat }.takeWhile { it < duration - 1 }.toList()
        return TrackAnalysis(
            status = TrackAnalysis.STATUS_READY,
            trackId = id,
            duration = duration,
            bpm = bpm,
            beatInterval = beat,
            beatConfidence = beatConfidence,
            downbeats = downbeats,
            firstBeat = firstDownbeat,
            key = "C major",
            keyConfidence = 0.9,
            audibleStartTime = 0.5,
            contentEndTime = duration - 2.0,
            energyCurve = energyCurve,
            vocalProbability = 0.1,
        )
    }

    /** Flat full-level energy: a track that plays to its end at its own level. */
    private fun flatCurve(duration: Double, level: Double = 1.0): List<EnergySample> =
        (0 until (duration * 2).toInt()).map { EnergySample(it / 2.0, level) }

    /**
     * Full level for all but the last stretch, then sustained low energy:
     * the melodic close a gap mix waits for.
     */
    private fun closingCurve(duration: Double, closeFrom: Double): List<EnergySample> =
        (0 until (duration * 2).toInt()).map {
            val time = it / 2.0
            EnergySample(time, if (time >= closeFrom) 0.2 else 1.0)
        }

    /**
     * A quiet first stretch that rises at the first downbeat: the clear
     * opener a gap mix enters on.
     */
    private fun openerCurve(duration: Double, riseAt: Double): List<EnergySample> =
        (0 until (duration * 2).toInt()).map {
            val time = it / 2.0
            EnergySample(time, if (time >= riseAt) 1.0 else 0.3)
        }

    private fun plan(
        current: TrackAnalysis,
        next: TrackAnalysis,
        currentTime: Double = 10.0,
    ): TransitionPlan = planTransition(
        analysis = current,
        nextAnalysis = next,
        currentTrack = TransitionTrackInfo(current.trackId, (current.duration * 1000).toLong()),
        nextTrack = TransitionTrackInfo(next.trackId, (next.duration * 1000).toLong()),
        currentTime = currentTime,
        duration = current.duration,
        mode = CrossfadeMode.SMART,
        advanced = true,
    )

    @Test
    fun aClosingTrackIntoAClearOpenerIsAGapMix() {
        val current = track("a", 120.0, closingCurve(200.0, closeFrom = 188.0))
        val next = track("b", 96.0, openerCurve(200.0, riseAt = 2.0), firstDownbeat = 2.0)
        val plan = plan(current, next)

        assertTrue(plan.isGapMix, "expected a gap mix, got ${plan.transitionStyle} (${plan.reason})")
        assertEquals(TransitionStyle.EQUAL_POWER, plan.transitionStyle)
        assertTrue(plan.fadeSeconds <= GAP_FADE_SECONDS + 1e-6, "fade ${plan.fadeSeconds}s")
        assertEquals(current.duration - 2.0, plan.transitionEnd, 1e-6, "the gap sits at the content end")
        assertEquals(2.0, plan.incomingCueTime, 1e-6, "the incoming track enters on its first downbeat")
        assertEquals(0.0, plan.filterSweep, 1e-6)
        // Long before the mix: the plan is published but not yet armed.
        assertFalse(plan.shouldStart)
    }

    @Test
    fun theGapArmsWhenThePlayheadReachesTheSilencePoint() {
        val current = track("a", 120.0, closingCurve(200.0, closeFrom = 188.0))
        val next = track("b", 96.0, openerCurve(200.0, riseAt = 2.0), firstDownbeat = 2.0)
        val plan = plan(current, next, currentTime = current.duration - 2.0)
        assertTrue(plan.isGapMix)
        assertTrue(plan.shouldStart, "the playhead is inside the 0.4 s window")
    }

    @Test
    fun aTrackThatPlaysToItsEndNeverGaps() {
        val current = track("a", 120.0, flatCurve(200.0))
        val next = track("b", 120.0, openerCurve(200.0, riseAt = 2.0), firstDownbeat = 2.0)
        val plan = plan(current, next)
        assertFalse(plan.isGapMix, "no melodic close, no gap")
        assertEquals(TransitionStyle.DJ_BLEND, plan.transitionStyle)
    }

    @Test
    fun anIncomingTrackThatNeverRisesNeverGaps() {
        val current = track("a", 120.0, closingCurve(200.0, closeFrom = 188.0))
        val next = track("b", 96.0, flatCurve(200.0, level = 0.8))
        val plan = plan(current, next)
        assertFalse(plan.isGapMix, "no clear opener, no gap")
    }

    @Test
    fun weakGridsFallToThePlainCrossfadeNotTheGap() {
        val current = track("a", 120.0, closingCurve(200.0, closeFrom = 188.0), beatConfidence = 0.1)
        val next = track("b", 96.0, openerCurve(200.0, riseAt = 2.0), firstDownbeat = 2.0, beatConfidence = 0.1)
        val plan = plan(current, next)
        assertFalse(plan.isGapMix)
        assertEquals(TransitionStyle.EQUAL_POWER, plan.transitionStyle)
        assertFalse(plan.blocked)
    }
}
