package com.music.bitchord.playback.smart

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The per-component migration: a stored record is stamped for what it
 * genuinely holds and left unstamped for what it doesn't, so the ladder only
 * recomputes the missing pieces. The cases are the ones the store actually
 * sees: a monolithic Phase 0 record, a head-only provisional, and a record
 * whose model never ran.
 */
class ComponentsTest {

    /** A Phase 0 whole-track result: everything measured at once. */
    private fun monolithic(): TrackAnalysis = TrackAnalysis(
        status = TrackAnalysis.STATUS_READY,
        trackId = "t",
        duration = 200.0,
        bpm = 120.0,
        beatInterval = 0.5,
        beatConfidence = 0.8,
        headBeats = BeatSide(listOf(0.0, 0.5, 1.0), emptyList(), 120.0, 0.8),
        tailBeats = BeatSide(listOf(190.0, 190.5, 191.0), emptyList(), 120.0, 0.7),
        energyCurve = List(240) { EnergySample(it * 1.0, 0.5) },
        vocalWindows = listOf(CurveWindow(0.0, 10.0, FloatArray(100) { 0.1f })),
        lufs = -12.0,
        lufsHead = -13.0,
        lufsTail = -11.0,
    )

    @Test
    fun aMonolithicRecordHoldsEverythingAndIsStampedOnce() {
        val adopted = Components.adopt(monolithic())
        assertEquals(TrackAnalysis.ANALYSIS_VERSION, adopted.analysisVersion)
        assertEquals(Components.GRID_VERSION, adopted.gridVersion)
        assertEquals(Components.VOCAL_VERSION, adopted.vocalVersion)
        assertEquals(Components.MISC_VERSION, adopted.miscVersion)
        // Adopting twice changes nothing — the common case after the first visit.
        assertTrue(Components.adopt(adopted) === adopted)
    }

    @Test
    fun aHeadOnlyProvisionalDoesNotHoldTheGrid() {
        val head = monolithic().copy(tailBeats = null)
        assertFalse(Components.held(head).contains("grid"))
        assertTrue(Components.needsLevel0(head))
        assertTrue(Components.needsHeadEdge(head))
        // The vocal and misc components are on the record: a head-only pass
        // measured its own window's structure and (in this fixture) the model
        // ran over it. Only the tail edge is owed.
        assertTrue(Components.held(head).contains("vocal"))
        assertTrue(Components.held(head).contains("misc"))
        assertFalse(Components.needsLevel3(head))
        assertEquals(0, Components.adopt(head).gridVersion)
    }

    @Test
    fun aRecordWhoseModelNeverRanDoesNotHoldTheVocalComponent() {
        val instrumental = monolithic().copy(vocalWindows = emptyList())
        assertFalse(Components.held(instrumental).contains("vocal"))
        assertTrue(Components.needsLevel2(instrumental))
        assertEquals(0, Components.adopt(instrumental).vocalVersion)
    }

    /** One cheap edge window: [startSec] long from [from], at the detector's own frame rate. */
    private fun cheapWindow(from: Double, startSec: Double) = CurveWindow(
        from,
        CheapVocal.CHEAP_FPS,
        FloatArray((startSec * CheapVocal.CHEAP_FPS).toInt()) { 0.2f },
    )

    @Test
    fun cheapWindowsCoveringBothEdgesHoldTheVocalComponent() {
        val warmed = monolithic().copy(
            vocalWindows = emptyList(),
            cheapVocalWindows = listOf(cheapWindow(0.0, 30.0), cheapWindow(170.0, 30.0)),
        )
        assertTrue(Components.held(warmed).contains("vocal"))
        assertFalse(Components.needsLevel2(warmed))
        assertEquals(Components.VOCAL_VERSION, Components.adopt(warmed).vocalVersion)
    }

    @Test
    fun cheapWindowsOnOneEdgeOnlyDoNotHold() {
        val headOnly = monolithic().copy(
            vocalWindows = emptyList(),
            cheapVocalWindows = listOf(cheapWindow(0.0, 30.0)),
        )
        assertFalse(Components.held(headOnly).contains("vocal"))
        assertTrue(Components.needsLevel2(headOnly))
        // And a tail-only record is the same mid-ladder state on the other side.
        val tailOnly = monolithic().copy(
            vocalWindows = emptyList(),
            cheapVocalWindows = listOf(cheapWindow(170.0, 30.0)),
        )
        assertFalse(Components.held(tailOnly).contains("vocal"))
    }

    @Test
    fun cheapSliversAndFarOffWindowsAreNotEdgeEvidence() {
        // A decode that came back two seconds long measured where the cache
        // stopped, not where the music does.
        val sliver = monolithic().copy(
            vocalWindows = emptyList(),
            cheapVocalWindows = listOf(cheapWindow(0.0, 2.0), cheapWindow(198.0, 2.0)),
        )
        assertFalse(Components.held(sliver).contains("vocal"))
        // A window in the middle of the track describes neither edge.
        val middle = monolithic().copy(
            vocalWindows = emptyList(),
            cheapVocalWindows = listOf(cheapWindow(60.0, 30.0), cheapWindow(95.0, 30.0)),
        )
        assertFalse(Components.held(middle).contains("vocal"))
    }

    @Test
    fun aPreLoudnessRecordStillHoldsItsStructure() {
        // analysisVersion 0 says "before the versioned record existed"; the
        // loudness fields absent say "computed before Phase 0". Structure
        // alone still holds — the curve covers what the gestures read.
        val old = monolithic().copy(lufs = null, lufsHead = null, lufsTail = null)
        assertTrue(Components.held(old).contains("misc"))
        // Nothing left to escalate for: vocal and grid are on the record too.
        assertFalse(Components.needsLevel3(old))
    }

    @Test
    fun missingEdgesAreNotReadAsHeld() {
        val bare = TrackAnalysis(trackId = "t", status = TrackAnalysis.STATUS_READY, bpm = 120.0)
        assertTrue(Components.held(bare).isEmpty())
        assertTrue(Components.needsLevel0(bare))
        assertTrue(Components.needsLevel2(bare))
        assertTrue(Components.needsLevel3(bare))
    }
}
