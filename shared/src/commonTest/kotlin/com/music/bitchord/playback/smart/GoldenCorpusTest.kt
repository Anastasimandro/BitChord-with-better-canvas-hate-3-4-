/*
 * BitChord, Automix 2.0 Phase 2: Golden Corpus CI test (Android/JVM)
 * Runs the Kotlin planner against the shared golden corpus fixture.
 * Asserts produced == expected within +/-1 beat. Prints a readable DIFF on failure.
 */

package com.music.bitchord.playback.smart

import com.google.gson.Gson
import com.google.gson.JsonObject
import java.io.File
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.test.Test
import kotlin.test.assertTrue

class GoldenCorpusTest {

    private data class Fixture(
        val version: Int,
        val pairs: List<Pair>
    )

    private data class Pair(
        val id: String,
        val category: String,
        val trackA: TrackFixture,
        val trackB: TrackFixture,
        val expected: ExpectedPlan,
        val knownIssue: String? = null
    )

    private data class TrackFixture(
        val title: String,
        val artist: String,
        val bpm: Double,
        val gridConfidence: Double,
        val beatConfidence: Double,
        val energy: Double,
        val camelot: String,
        val durationSec: Double,
        val musicVideo: Boolean = false,
        val lufs: Double? = null,
        val firstDownbeatSec: Double? = null,
        val contentEndSec: Double? = null,
        val introEndSec: Double? = null,
        val outroStartSec: Double? = null,
        /** Raw whole-track energy curve, as the web fixture writes it; null when the pair carries none. */
        val energyCurve: List<Double>? = null
    )

    private data class ExpectedPlan(
        val style: String,
        val entryBeatB: Int,
        val overlapBars: Int,
        val bassSwapBeat: Int?,
        val gesture: String,
        val gestureSeconds: Double? = null,
        val reason: String? = null
    )

    private data class ProducedPlan(
        val style: String,
        val entryBeatB: Int,
        val overlapBars: Int,
        val bassSwapBeat: Int?,
        val gesture: String,
        val gestureSeconds: Double = 0.0,
        val rejectedGesturesAndWhy: List<Pair<String, String>> = emptyList(),
        val reason: String? = null
    )

    @Test
    fun goldenCorpusTest() {
        // Use absolute path to fixtures from project root
        val fixturePath = File("C:/Users/A/Proyectos/BitChord-with-better-canvas-hate-3-4-/fixtures/golden-corpus.json").canonicalFile
        println("FIXTURE PATH: ${fixturePath.absolutePath}, exists: ${fixturePath.exists()}")
        val json = fixturePath.readText()
        val gson = Gson()
        val fixture = gson.fromJson(json, Fixture::class.java)

        var totalPassed = 0
        var totalFailed = 0
        var totalSkipped = 0

        for (pair in fixture.pairs) {
            val testName = "${pair.category}/${pair.id}"
            val isKnownIssue = pair.knownIssue != null

            if (isKnownIssue) {
                println("⏭ SKIPPED (known issue): $testName — ${pair.knownIssue}")
                totalSkipped++
                continue
            }

            val trackA = fixtureToAnalysis(pair.trackA)
            val trackB = fixtureToAnalysis(pair.trackB)

            val produced = planPair(trackA, trackB, pair.trackA.gridConfidence, pair.trackB.gridConfidence)
            val expected = pair.expected

            val diff = diffExpectedVsProduced(expected, produced)
            val pass = matchesExpected(expected, produced, analysisA.beatInterval)

            if (pass) {
                println("✓ $testName")
                totalPassed++
            } else {
                System.err.println("\n❌ GOLDEN CORPUS MISMATCH: ${pair.id}")
                System.err.println(diff)
                totalFailed++
            }

            // Fail the test with the diff if there's a mismatch
            assertTrue(pass, "Golden corpus mismatch for ${pair.id}:\n$diff")
        }

        println("\n=== Golden Corpus Summary ===")
        println("Passed: $totalPassed")
        println("Failed: $totalFailed")
        println("Skipped (known issues): $totalSkipped")
        println("Total: ${fixture.pairs.size}")
    }

    private fun fixtureToAnalysis(t: TrackFixture): TrackAnalysis {
        val camelotParts = t.camelot.toCharArray()
        val num = camelotParts.dropLast(1).joinToString("").toIntOrNull() ?: 1
        val letter = camelotParts.last().toString()

        val beatInterval = if (t.bpm > 0) 60.0 / t.bpm else 0.0
        val firstDownbeat = t.firstDownbeatSec ?: 0.0
        val introEnd = t.introEndSec ?: (if (t.bpm > 0) beatInterval * 16 else 0.0)
        val outroStart = t.outroStartSec ?: (t.durationSec - 30.0).coerceAtLeast(0.0)
        val contentEnd = t.contentEndSec

        // The curve as the policy reads it: samples over the whole track, the
        // sample time the window size puts each value at (web's windowSec).
        val curve = t.energyCurve.orEmpty()
        val windowSec = if (curve.isNotEmpty()) t.durationSec / curve.size else 0.0
        val energyCurve = curve.mapIndexed { i, value -> EnergySample(i * windowSec, value) }

        val headBeats = if (t.beatConfidence > 0.2) {
            BeatSide(emptyList(), emptyList(), t.bpm, t.beatConfidence)
        } else null

        val tailBeats = if (t.beatConfidence > 0.2) {
            BeatSide(emptyList(), emptyList(), t.bpm, t.beatConfidence)
        } else null

        val tailGrid = if (t.gridConfidence > 0.2) {
            BeatSide(emptyList(), emptyList(), t.bpm, t.gridConfidence)
        } else null

        return TrackAnalysis(
            status = TrackAnalysis.STATUS_READY,
            trackId = t.title.lowercase().replace(" ", "-"),
            duration = t.durationSec,
            bpm = t.bpm,
            beatInterval = beatInterval,
            beatConfidence = t.beatConfidence,
            downbeats = emptyList(),
            phraseBoundaries = emptyList(),
            firstBeat = firstDownbeat,
            key = t.camelot,
            keyConfidence = 0.8,
            audibleStartTime = firstDownbeat,
            pickupTime = firstDownbeat,
            introEndTime = introEnd,
            contentEndTime = contentEnd ?: t.durationSec,
            outroStartTime = outroStart,
            mixInTime = firstDownbeat,
            mixOutTime = outroStart,
            mixInCandidates = emptyList(),
            mixOutCandidates = emptyList(),
            energyCurve = energyCurve,
            lowEnergyCurve = emptyList(),
            vocalActivityMask = emptyList(),
            vocalProbability = 0.0,
            headBeats = headBeats,
            tailBeats = tailBeats,
            vocalWindows = emptyList(),
            cheapVocalWindows = emptyList(),
            levelWindows = emptyList(),
            lufs = t.lufs,
            lufsHead = null,
            lufsTail = null,
            analysisVersion = TrackAnalysis.ANALYSIS_VERSION,
            gridVersion = 1,
            vocalVersion = 1,
            miscVersion = 1
        )
    }

    private fun planPair(analysisA: TrackAnalysis, analysisB: TrackAnalysis, gridConfA: Double, gridConfB: Double): ProducedPlan {
        val verdict = assessTransitionTier(analysisA, analysisB)

        // Phase 3 Task 3: the gesture scored off the outgoing close — the same
        // gates as the web's scoreDelayGesture, asserted against the same
        // fixture the web test reads.
        val delayDecision = scoreDelayGesture(analysisA, gridConfA)
        val gesture = if (delayDecision.chosen) "delay" else "none"
        val gestureSeconds = if (delayDecision.chosen) delayDecision.delaySec ?: 0.0 else 0.0
        val rejectedGestures = if (delayDecision.chosen) {
            emptyList()
        } else {
            listOf("delay" to (delayDecision.killReason ?: "unknown"))
        }

        // Confidence-scaled blend length (mirrors web's effectiveBlendBars) using grid confidence
        fun effectiveBlendBars(requestedBars: Int, fromConf: Double, toConf: Double): Int {
            val conf = min(fromConf, toConf)
            return when {
                conf >= 0.6 -> requestedBars
                conf >= 0.45 -> min(requestedBars, 8)
                else -> min(requestedBars, 4)
            }
        }

        return when (verdict.tier) {
            TransitionTier.PLAIN_CROSSFADE -> ProducedPlan(
                style = "crossfade",
                entryBeatB = 1,
                overlapBars = 12,
                bassSwapBeat = null,
                gesture = gesture,
                gestureSeconds = gestureSeconds,
                rejectedGesturesAndWhy = rejectedGestures,
                reason = verdict.reasons.firstOrNull()
            )
            TransitionTier.DJ_ASSISTED -> {
                // Filter mix: incoming track has no grid or tempo too far
                val rate = incomingRateBetween(analysisA.bpm, analysisB.bpm)
                val stretchOk = rate.isFinite() && rate >= 0.9 && rate <= 1.25
                val incomingHasGrid = analysisB.beatConfidence >= MIN_DJ_CONFIDENCE

                if (!incomingHasGrid || !stretchOk) {
                    ProducedPlan(
                        style = "filter",
                        entryBeatB = 1,
                        overlapBars = 8,
                        bassSwapBeat = null,
                        gesture = gesture,
                        gestureSeconds = gestureSeconds,
                        rejectedGesturesAndWhy = rejectedGestures,
                        reason = if (!incomingHasGrid) "next song has no beat grid" else "tempos ${(abs(rate - 1) * 100).roundToInt()}% apart"
                    )
                } else {
                    // Beatmatched but short blend - confidence scaled using grid confidence
                    val requestedBars = 16
                    val bars = effectiveBlendBars(requestedBars, gridConfA, gridConfB).coerceAtMost(8)
                    val bassSwapBeat = if (bars >= 16) (bars * 0.75).roundToInt() else max(1, bars / 2)
                    ProducedPlan(
                        style = "blend",
                        entryBeatB = 1,
                        overlapBars = bars,
                        bassSwapBeat = bassSwapBeat,
                        gesture = gesture,
                        gestureSeconds = gestureSeconds,
                        rejectedGesturesAndWhy = rejectedGestures,
                        reason = null
                    )
                }
            }
            TransitionTier.BEATMATCHED -> {
                // Check for GAP
                val gapDetected = detectGapKotlin(analysisA, analysisB)
                if (gapDetected) {
                    ProducedPlan(
                        style = "gap",
                        entryBeatB = 1,
                        overlapBars = 0,
                        bassSwapBeat = null,
                        gesture = gesture,
                        gestureSeconds = gestureSeconds,
                        rejectedGesturesAndWhy = rejectedGestures,
                        reason = "melodic close into clear opener"
                    )
                } else {
                    // Full blend - confidence scaled using grid confidence
                    val requestedBars = 16
                    val bars = effectiveBlendBars(requestedBars, gridConfA, gridConfB)
                    val bassSwapBeat = if (bars >= 16) (bars * 0.75).roundToInt() else max(1, bars / 2)
                    ProducedPlan(
                        style = "blend",
                        entryBeatB = 1,
                        overlapBars = bars,
                        bassSwapBeat = bassSwapBeat,
                        gesture = gesture,
                        gestureSeconds = gestureSeconds,
                        rejectedGesturesAndWhy = rejectedGestures,
                        reason = null
                    )
                }
            }
        }
    }

    // Simplified GAP detection matching policy.ts logic
    private fun detectGapKotlin(out: TrackAnalysis, inn: TrackAnalysis): Boolean {
        if (out.energyCurve.size < 2 || inn.energyCurve.size < 2) return false
        if (out.duration <= 0 || inn.duration <= 0) return false

        val GAP_TAIL_SEC = 8.0
        val tailStart = out.duration - GAP_TAIL_SEC
        val tailCurve = out.energyCurve.filter { it.time >= tailStart && it.time <= out.duration }
        if (tailCurve.size < 2) return false

        val typical = tailCurve.map { it.energy }.sorted()[tailCurve.size * 60 / 100]
        val threshold = max(0.04, typical * 0.3)

        // Check sustained low in tail
        var sustainedLow = true
        var sum = 0.0
        for (point in tailCurve) {
            if (point.energy >= typical * 0.5) { sustainedLow = false; break }
            sum += point.energy
        }
        if (!sustainedLow) return false
        if (sum / tailCurve.size >= typical * 0.35) return false

        // Check clear opener: first downbeat on rising energy
        val fd = inn.firstBeat
        if (fd <= 0 || fd >= inn.duration - tailCurve.first().time) return false

        val headCurve = inn.energyCurve.filter { it.time >= 0 && it.time <= fd + 4 }
        if (headCurve.size < 3) return false

        val k = min(headCurve.size - 2, (fd / (headCurve.last().time / headCurve.size)).toInt())
        return headCurve[k + 1].energy > headCurve[k].energy
    }

    private fun matchesExpected(expected: ExpectedPlan, produced: ProducedPlan, beatSeconds: Double): Boolean {
        if (expected.style != produced.style) return false
        if (abs(expected.entryBeatB - produced.entryBeatB) > 1) return false
        if (abs(expected.overlapBars - produced.overlapBars) > 1) return false
        if (expected.bassSwapBeat != null && produced.bassSwapBeat != null) {
            if (abs(expected.bassSwapBeat!! - produced.bassSwapBeat!!) > 1) return false
        } else if (expected.bassSwapBeat != produced.bassSwapBeat) {
            return false
        }
        // Phase 3 Task 3: gesture parity with the web scorer — the same field,
        // and the delay length within +/-1 beat of the web's.
        if (expected.gesture != produced.gesture) return false
        val expectedSeconds = expected.gestureSeconds ?: 0.0
        if (abs(expectedSeconds - produced.gestureSeconds) > beatSeconds) return false
        return true
    }

    private fun diffExpectedVsProduced(expected: ExpectedPlan, produced: ProducedPlan): String {
        val lines = mutableListOf<String>()
        val checks = listOf(
            Triple("style", expected.style, produced.style),
            Triple("entryBeatB", expected.entryBeatB, produced.entryBeatB),
            Triple("overlapBars", expected.overlapBars, produced.overlapBars),
            Triple("bassSwapBeat", expected.bassSwapBeat?.toString() ?: "null", produced.bassSwapBeat?.toString() ?: "null"),
            Triple("gesture", expected.gesture, produced.gesture),
            Triple("gestureSeconds", (expected.gestureSeconds ?: 0.0).toString(), produced.gestureSeconds.toString()),
            Triple("rejectedGestures", "", produced.rejectedGesturesAndWhy.joinToString("; ") { "${it.first}: ${it.second}" })
        )

        for ((key, exp, prod) in checks) {
            val match = when {
                key == "entryBeatB" || key == "overlapBars" || key == "bassSwapBeat" -> {
                    val expNum = exp.toString().toIntOrNull() ?: -999
                    val prodNum = prod.toString().toIntOrNull() ?: -999
                    abs(expNum - prodNum) <= 1
                }
                else -> exp == prod
            }
            lines.add("  $key: expected $exp, got $prod ${if (match) "✓" else "❌"}")
        }
        if (expected.reason != null && produced.reason != null && expected.reason != produced.reason) {
            lines.add("  reason: expected \"${expected.reason}\", got \"${produced.reason}\"")
        }
        return lines.joinToString("\n")
    }
}