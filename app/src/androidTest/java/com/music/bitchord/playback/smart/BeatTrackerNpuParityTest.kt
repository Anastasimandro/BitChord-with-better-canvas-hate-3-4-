/*
 * NPU delegate parity test for Beat This! model.
 *
 * Verifies that the NNAPI delegate produces identical (or within tolerance)
 * beat/downbeat grids and confidences compared to CPU inference.
 *
 * This test is run on a physical device or emulator with NNAPI support.
 * Results are printed for manual comparison; the test passes if both
 * delegates produce valid grids (correctness gate).
 */
package com.music.bitchord.playback.smart

import android.content.Context
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import java.io.File
import java.io.FileOutputStream
import kotlin.math.abs
import kotlin.math.min

@RunWith(AndroidJUnit4::class)
class BeatTrackerNpuParityTest {

    companion object {
        /** Tolerance for BPM difference (absolute). */
        private const val BPM_TOLERANCE = 0.5

        /** Tolerance for beat confidence difference (absolute). */
        private const val CONFIDENCE_TOLERANCE = 0.05

        /** Tolerance for beat time difference (seconds). */
        private const val BEAT_TIME_TOLERANCE = 0.05
    }

    @Test
    fun npuDelegateParity() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext

        // Unpack the model asset to a file
        val modelFile = File(context.filesDir, BeatTracker.MODEL_ASSET)
        if (!modelFile.exists() || modelFile.length() == 0L) {
            context.assets.open(BeatTracker.MODEL_ASSET).use { input ->
                modelFile.outputStream().use { output -> input.copyTo(output) }
            }
        }

        // Generate a synthetic test signal (click track at 120 BPM)
        val pcm = generateClickTrack(sampleRate = MelSpectrogram.sampleRate.toInt(), bpm = 120.0, durationSec = 30.0)

        // Test CPU inference
        val cpuTracker = BeatTracker.forTest(
            modelPath = modelFile.absolutePath,
            preferredDelegate = null,
            forceCpu = true,
            threads = 1,
        )
        val cpuGrid = cpuTracker.track(pcm)
        cpuTracker.release()

        // Test NNAPI inference (if available)
        val nnapiTracker = BeatTracker.forTest(
            modelPath = modelFile.absolutePath,
            preferredDelegate = BeatTracker.NpuDelegate.NNAPI,
            forceCpu = false,
            threads = 1,
        )
        val nnapiAvailable = nnapiTracker.activeDelegate == BeatTracker.NpuDelegate.NNAPI
        val nnapiGrid = if (nnapiAvailable) nnapiTracker.track(pcm) else null
        nnapiTracker.release()

        // Log results for comparison
        println("=== BeatTracker NPU Parity Test ===")
        println("Model: ${BeatTracker.MODEL_ASSET}")
        println("NNAPI available: $nnapiAvailable")

        cpuGrid?.let { grid ->
            println("CPU Grid: bpm=${String.format("%.2f", grid.bpm)}, " +
                    "confidence=${String.format("%.3f", grid.beatConfidence)}, " +
                    "beats=${grid.beats.size}, downbeats=${grid.downbeats.size}, " +
                    "firstBeat=${String.format("%.3f", grid.firstBeat)}")
        } ?: println("CPU Grid: null (inference failed)")

        nnapiGrid?.let { grid ->
            println("NNAPI Grid: bpm=${String.format("%.2f", grid.bpm)}, " +
                    "confidence=${String.format("%.3f", grid.beatConfidence)}, " +
                    "beats=${grid.beats.size}, downbeats=${grid.downbeats.size}, " +
                    "firstBeat=${String.format("%.3f", grid.firstBeat)}")
        } ?: if (nnapiAvailable) println("NNAPI Grid: null (inference failed)") else println("NNAPI Grid: N/A (delegate not available)")

        // Verify CPU produced a valid grid (baseline)
        assertNotNull("CPU inference should produce a valid grid", cpuGrid)

        // If NNAPI is available, verify parity
        if (nnapiAvailable) {
            assertNotNull("NNAPI inference should produce a valid grid", nnapiGrid)

            val cpu = cpuGrid!!
            val nnapi = nnapiGrid!!

            // Compare BPM
            val bpmDiff = abs(cpu.bpm - nnapi.bpm)
            println("BPM diff: ${String.format("%.3f", bpmDiff)} (tolerance: $BPM_TOLERANCE)")
            assertTrue("BPM difference within tolerance", bpmDiff <= BPM_TOLERANCE)

            // Compare confidence
            val confDiff = abs(cpu.beatConfidence - nnapi.beatConfidence)
            println("Confidence diff: ${String.format("%.3f", confDiff)} (tolerance: $CONFIDENCE_TOLERANCE)")
            assertTrue("Confidence difference within tolerance", confDiff <= CONFIDENCE_TOLERANCE)

            // Compare beat times (first N beats)
            val beatsToCompare = min(cpu.beats.size, nnapi.beats.size).coerceAtMost(32)
            for (i in 0 until beatsToCompare) {
                val timeDiff = abs(cpu.beats[i] - nnapi.beats[i])
                if (timeDiff > BEAT_TIME_TOLERANCE) {
                    println("Beat $i time diff: ${String.format("%.3f", timeDiff)} (tolerance: $BEAT_TIME_TOLERANCE) - cpu=${cpu.beats[i]}, nnapi=${nnapi.beats[i]}")
                }
                assertTrue("Beat $i time difference within tolerance", timeDiff <= BEAT_TIME_TOLERANCE)
            }

            // Compare downbeat times
            val downbeatsToCompare = min(cpu.downbeats.size, nnapi.downbeats.size).coerceAtMost(8)
            for (i in 0 until downbeatsToCompare) {
                val timeDiff = abs(cpu.downbeats[i] - nnapi.downbeats[i])
                if (timeDiff > BEAT_TIME_TOLERANCE) {
                    println("Downbeat $i time diff: ${String.format("%.3f", timeDiff)} (tolerance: $BEAT_TIME_TOLERANCE)")
                }
                assertTrue("Downbeat $i time difference within tolerance", timeDiff <= BEAT_TIME_TOLERANCE)
            }

            println("✓ NPU parity test PASSED")
        } else {
            println("⚠ NNAPI not available on this device; parity test skipped")
            println("  This is expected on devices without NNAPI support or in CI environments.")
        }

        // Also check delegate availability reporting
        val delegates = BeatTracker.checkAvailableDelegates(modelFile.absolutePath, threads = 1)
        println("Delegate availability: $delegates")
    }

    /**
     * Generates a synthetic click track for testing.
     * Returns mono PCM at [sampleRate] Hz.
     */
    private fun generateClickTrack(sampleRate: Int, bpm: Double, durationSec: Double): FloatArray {
        val samples = FloatArray((sampleRate * durationSec).toInt())
        val intervalSec = 60.0 / bpm
        val intervalSamples = (intervalSec * sampleRate).toInt()
        val clickDurationSamples = (0.01 * sampleRate).toInt() // 10 ms clicks

        var pos = 0
        while (pos < samples.size) {
            // Generate a short sine wave click
            for (i in 0 until clickDurationSamples) {
                val idx = pos + i
                if (idx >= samples.size) break
                val t = i.toDouble() / sampleRate
                // 1 kHz sine wave with Hann envelope
                val envelope = 0.5 - 0.5 * Math.cos(2.0 * Math.PI * i / clickDurationSamples)
                samples[idx] = (envelope * Math.sin(2.0 * Math.PI * 1000.0 * t) * 0.5).toFloat()
            }
            pos += intervalSamples
        }
        return samples
    }
}
