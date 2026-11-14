package com.music.bitchord.playback.smart

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The telemetry ring in its memory-only mode (no directory is set here):
 * an event is recorded, the skip window annotates it once, and the report
 * aggregates honestly.
 */
class MixTelemetryTest {

    private fun event(
        pair: String,
        style: String = MixTelemetry.STYLE_BLEND,
        reason: String? = null,
    ): MixTelemetry.TransitionEvent =
        MixTelemetry.TransitionEvent(
            at = System.currentTimeMillis(),
            pair = pair,
            styleChosen = style,
            reason = reason,
            confidences = MixTelemetry.MixConfidences(
                outGrid = 0.9,
                inGrid = 0.9,
                deltaLufs = -1.5,
            ),
            bothGridsReady = true,
        )

    @Test
    fun aRecordedEventIsReadBack() {
        val e = event("out>in")
        MixTelemetry.record(e)
        MixTelemetry.complete(e, MixTelemetry.OUTCOME_COMPLETED)
        assertTrue(MixTelemetry.load().any { it === e })
        assertEquals(MixTelemetry.OUTCOME_COMPLETED, e.outcome)
    }

    @Test
    fun aSkipInsideTheWindowAnnotatesOnce() {
        val e = event("outA>inA")
        MixTelemetry.record(e)
        MixTelemetry.markHandoff(e)
        val now = System.currentTimeMillis()
        MixTelemetry.annotateSkip("inA", now + 10_000)
        assertEquals(10.0, e.skipAfterSec!!, 0.01)
        // One skip is one annotation: a second advance adds nothing.
        MixTelemetry.annotateSkip("inA", now + 15_000)
        assertEquals(10.0, e.skipAfterSec!!, 0.01)
    }

    @Test
    fun aSkipOutsideTheWindowOrOfAnotherTrackAnnotatesNothing() {
        val e = event("outB>inB")
        MixTelemetry.record(e)
        MixTelemetry.markHandoff(e)
        val now = System.currentTimeMillis()
        MixTelemetry.annotateSkip("someone-else", now + 5_000)
        assertNull(e.skipAfterSec)
        MixTelemetry.annotateSkip("inB", now + ((MixTelemetry.TRANSITION_SKIP_WINDOW_SEC + 5) * 1000).toLong())
        assertNull(e.skipAfterSec)
    }

    @Test
    fun anUnhandedOffEventIsNeverAnnotated() {
        val e = event("outC>inC")
        MixTelemetry.record(e)
        MixTelemetry.complete(e, MixTelemetry.OUTCOME_COMPLETED)
        MixTelemetry.annotateSkip("inC", System.currentTimeMillis())
        assertNull(e.skipAfterSec)
    }

    @Test
    fun theRingHoldsFiveHundred() {
        repeat(505) { i ->
            val e = event("out$i>in$i")
            MixTelemetry.record(e)
            MixTelemetry.complete(e, MixTelemetry.OUTCOME_ABORTED)
        }
        assertTrue(MixTelemetry.load().size <= 500)
    }

    @Test
    fun theReportCountsStylesSkipsAndHitRate() {
        val completed = event("outR>inR", MixTelemetry.STYLE_GAP, reason = "smart-gap")
        MixTelemetry.record(completed)
        MixTelemetry.complete(completed, MixTelemetry.OUTCOME_COMPLETED)
        val skipped = event("outS>inS", MixTelemetry.STYLE_BLEND, reason = "smart-duration")
        MixTelemetry.record(skipped)
        MixTelemetry.markHandoff(skipped)
        val now = System.currentTimeMillis()
        MixTelemetry.complete(skipped, MixTelemetry.OUTCOME_COMPLETED)
        MixTelemetry.annotateSkip("inS", now + 3_000)

        val report = MixTelemetry.aggregate(MixTelemetry.load())
        assertTrue(report.total >= 2)
        assertTrue(report.completed >= 2)
        assertTrue(report.hitRate in 0.0..1.0)
        val gap = report.styles.firstOrNull { it.style == MixTelemetry.STYLE_GAP }
        assertEquals(1, gap?.count)
        assertEquals(0.0, gap?.skipRate!!, 1e-9)
        val blend = report.styles.firstOrNull { it.style == MixTelemetry.STYLE_BLEND }!!
        assertTrue(blend.skipRate!! > 0.0, "the annotated skip must show on the style")
        assertTrue(report.topReasons.isNotEmpty() || report.styles.isEmpty())
    }

    @Test
    fun theReportCountsPlansThatStoodBeforeTheLastMinute() {
        val early = event("outP1>inP1").copy(plannedRemainingSec = 90.0)
        MixTelemetry.record(early)
        MixTelemetry.complete(early, MixTelemetry.OUTCOME_COMPLETED)
        val late = event("outP2>inP2").copy(plannedRemainingSec = 12.0)
        MixTelemetry.record(late)
        MixTelemetry.complete(late, MixTelemetry.OUTCOME_COMPLETED)
        // No stamp at all reads as late: a plan assembled at the arm itself
        // was not standing before the last minute, whatever armed it.
        val unstamped = event("outP3>inP3")
        MixTelemetry.record(unstamped)
        MixTelemetry.complete(unstamped, MixTelemetry.OUTCOME_COMPLETED)
        val report = MixTelemetry.aggregate(
            MixTelemetry.load().filter { it.pair in setOf("outP1>inP1", "outP2>inP2", "outP3>inP3") },
        )
        assertEquals(1.0 / 3.0, report.plannedBy60Share, 0.01)
        // Aborted events say nothing about timing and are counted nowhere.
        val aborted = event("outP4>inP4").copy(plannedRemainingSec = 300.0)
        MixTelemetry.record(aborted)
        MixTelemetry.complete(aborted, MixTelemetry.OUTCOME_ABORTED)
        val onlyCompleted = MixTelemetry.aggregate(
            MixTelemetry.load().filter { it.pair == "outP4>inP4" },
        )
        assertEquals(0.0, onlyCompleted.plannedBy60Share, 1e-9)
    }
}
