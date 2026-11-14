package com.music.bitchord.playback.smart

import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The store's round trip: what goes in as a pre-Phase-1 record comes out
 * stamped for what it genuinely holds, and the ladder owes it nothing. This
 * is the migration the per-component versions exist for — a cache built by
 * the monolithic analyzer keeps working, rather than paying for a re-analysis
 * the version bump was supposed to make unnecessary.
 */
class AnalysisStoreTest {

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
        levelWindows = listOf(CurveWindow(0.0, 10.0, FloatArray(100) { 0.6f })),
        lufs = -12.0,
        lufsHead = -13.0,
        lufsTail = -11.0,
    )

    @Test
    fun aMonolithicRecordMigratesWithoutReanalysis() {
        val dir = Files.createTempDirectory("bitchord-analysis-test").toFile()
        try {
            val store = AnalysisStore { dir }
            // Every version at 0: a record computed before the components
            // existed, exactly what a Phase 0 cache on disk looks like.
            store.save("t", monolithic().copy(analysisVersion = 0))
            val loaded = store.load("t")!!
            // The migrator stamped what the record genuinely holds — all three
            // components — and stamped the record itself.
            assertEquals(setOf("grid", "vocal", "misc"), Components.held(loaded))
            assertEquals(Components.GRID_VERSION, loaded.gridVersion)
            assertEquals(Components.VOCAL_VERSION, loaded.vocalVersion)
            assertEquals(Components.MISC_VERSION, loaded.miscVersion)
            assertEquals(TrackAnalysis.ANALYSIS_VERSION, loaded.analysisVersion)
            // ...so the ladder owes it nothing. This is "no re-analysis": the
            // store answers complete, and nothing downstream escalates.
            assertFalse(Components.needsLevel0(loaded))
            assertFalse(Components.needsLevel2(loaded))
            assertFalse(Components.needsLevel3(loaded))
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun cheapVocalWindowsSurviveTheStore() {
        val dir = Files.createTempDirectory("bitchord-analysis-test").toFile()
        try {
            val store = AnalysisStore { dir }
            val head = CurveWindow(0.0, CheapVocal.CHEAP_FPS, FloatArray((30 * CheapVocal.CHEAP_FPS).toInt()) { 0.2f })
            val tail = CurveWindow(170.0, CheapVocal.CHEAP_FPS, FloatArray((30 * CheapVocal.CHEAP_FPS).toInt()) { 0.2f })
            val warmed = monolithic().copy(vocalWindows = emptyList(), cheapVocalWindows = listOf(head, tail))
            store.save("w", warmed)
            val loaded = store.load("w")!!
            // Both cheap windows land back, coordinates and values intact.
            assertEquals(2, loaded.cheapVocalWindows.size)
            assertEquals(0.0, loaded.cheapVocalWindows[0].startTime, 1e-9)
            assertEquals(170.0, loaded.cheapVocalWindows[1].startTime, 1e-9)
            assertEquals(0.2f, loaded.cheapVocalWindows[0].values.first(), 0.01f)
            // And the loaded record holds the vocal component through the
            // cheap rule: both edges covered, nothing left for L2 to do.
            assertTrue(Components.held(loaded).contains("vocal"))
            assertFalse(Components.needsLevel2(loaded))
        } finally {
            dir.deleteRecursively()
        }
    }
}
