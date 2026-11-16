/*
 * Cold L0 timing benchmark for Beat This! model.
 *
 * Measures cold inference time (first run after session creation) for CPU
 * and NNAPI delegates. Results are printed for the measurement table.
 *
 * Run on a physical device (not emulator) for meaningful numbers.
 * Target: cold L0 <= 1.2 s on mid-range hardware.
 */
package com.music.bitchord.playback.smart

import android.content.Context
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import kotlin.math.min

@RunWith(AndroidJUnit4::class)
class BeatTrackerBenchmarkTest {

    /** Number of warmup runs (discarded). */
    private const val WARMUP_RUNS = 1

    /** Number of measured runs. */
    private const val MEASURED_RUNS = 5

    @Test
    fun coldL0Benchmark() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext

        // Unpack the model asset
        val modelFile = File(context.filesDir, BeatTracker.MODEL_ASSET)
        if (!modelFile.exists() || modelFile.length() == 0L) {
            context.assets.open(BeatTracker.MODEL_ASSET).use { input ->
                modelFile.outputStream().use { output -> input.copyTo(output) }
            }
        }

        // Generate test signal (30 seconds at 22050 Hz = 661500 samples)
        val pcm = generateClickTrack(sampleRate = MelSpectrogram.sampleRate.toInt(), bpm = 120.0, durationSec = 30.0)

        println("=== BeatTracker Cold L0 Benchmark ===")
        println("Model: ${BeatTracker.MODEL_ASSET}")
        println("Input: ${pcm.size} samples (${pcm.size / MelSpectrogram.sampleRate} sec)")
        println("Warmup runs: $WARMUP_RUNS, Measured runs: $MEASURED_RUNS")
        println("")

        // Benchmark CPU
        println("--- CPU Delegate ---")
        val cpuTimes = benchmarkDelegate(
            modelPath = modelFile.absolutePath,
            preferredDelegate = null,
            forceCpu = true,
            pcm = pcm,
        )
        println("CPU times (ms): ${cpuTimes.joinToString(", ") { String.format("%.1f", it) }}")
        val cpuP50 = percentile(cpuTimes, 50)
        val cpuP95 = percentile(cpuTimes, 95)
        println("CPU p50: ${String.format("%.1f", cpuP50)} ms, p95: ${String.format("%.1f", cpuP95)} ms")
        println("")

        // Benchmark NNAPI (if available)
        println("--- NNAPI Delegate ---")
        val nnapiTimes = benchmarkDelegate(
            modelPath = modelFile.absolutePath,
            preferredDelegate = BeatTracker.NpuDelegate.NNAPI,
            forceCpu = false,
            pcm = pcm,
        )
        if (nnapiTimes.isNotEmpty()) {
            println("NNAPI times (ms): ${nnapiTimes.joinToString(", ") { String.format("%.1f", it) }}")
            val nnapiP50 = percentile(nnapiTimes, 50)
            val nnapiP95 = percentile(nnapiTimes, 95)
            println("NNAPI p50: ${String.format("%.1f", nnapiP50)} ms, p95: ${String.format("%.1f", nnapiP95)} ms")
            println("")
            println("=== Summary ===")
            println("CPU  p50: ${String.format("%.1f", cpuP50)} ms (${String.format("%.2f", cpuP50 / 1000.0)} s)")
            println("NNAPI p50: ${String.format("%.1f", nnapiP50)} ms (${String.format("%.2f", nnapiP50 / 1000.0)} s)")
            val speedup = cpuP50 / nnapiP50
            println("Speedup: ${String.format("%.2f", speedup)}x")
            if (nnapiP50 <= 1200) {
                println("✓ TARGET MET: NNAPI cold L0 <= 1.2 s")
            } else {
                println("✗ TARGET MISSED: NNAPI cold L0 > 1.2 s")
            }
        } else {
            println("NNAPI not available on this device")
            println("")
            println("=== Summary ===")
            println("CPU  p50: ${String.format("%.1f", cpuP50)} ms (${String.format("%.2f", cpuP50 / 1000.0)} s)")
            println("NNAPI: N/A")
        }
    }

    /**
     * Runs benchmark for a specific delegate configuration.
     * Returns list of cold inference times in milliseconds.
     */
    private fun benchmarkDelegate(
        modelPath: String,
        preferredDelegate: BeatTracker.NpuDelegate?,
        forceCpu: Boolean,
        pcm: FloatArray,
    ): List<Double> {
        val times = mutableListOf<Double>()

        val tracker = BeatTracker.forTest(
            modelPath = modelPath,
            preferredDelegate = preferredDelegate,
            forceCpu = forceCpu,
            threads = 1,
        )

        // Check if delegate is actually active
        val delegateActive = tracker.activeDelegate != null || forceCpu
        if (!delegateActive) {
            tracker.release()
            return emptyList()
        }

        println("  Active delegate: ${tracker.activeDelegate?.name ?: "CPU"}")

        // Warmup runs (create fresh session each time to measure cold start)
        repeat(WARMUP_RUNS) {
            val warmupTracker = BeatTracker.forTest(
                modelPath = modelPath,
                preferredDelegate = preferredDelegate,
                forceCpu = forceCpu,
                threads = 1,
            )
            warmupTracker.track(pcm)
            warmupTracker.release()
        }

        // Measured runs - each with a fresh session to measure cold start
        repeat(MEASURED_RUNS) {
            val runTracker = BeatTracker.forTest(
                modelPath = modelPath,
                preferredDelegate = preferredDelegate,
                forceCpu = forceCpu,
                threads = 1,
            )
            val start = System.nanoTime()
            val grid = runTracker.track(pcm)
            val elapsedMs = (System.nanoTime() - start) / 1_000_000.0
            runTracker.release()

            if (grid != null) {
                times += elapsedMs
                println("  Run ${times.size}: ${String.format("%.1f", elapsedMs)} ms")
            } else {
                println("  Run ${times.size + 1}: FAILED (null grid)")
            }
        }

        return times
    }

    private fun percentile(sortedValues: List<Double>, percentile: Int): Double {
        if (sortedValues.isEmpty()) return 0.0
        val index = min((sortedValues.size * percentile / 100).toInt(), sortedValues.size - 1)
        return sortedValues.sorted()[index]
    }

    private fun generateClickTrack(sampleRate: Int, bpm: Double, durationSec: Double): FloatArray {
        val samples = FloatArray((sampleRate * durationSec).toInt())
        val intervalSec = 60.0 / bpm
        val intervalSamples = (intervalSec * sampleRate).toInt()
        val clickDurationSamples = (0.01 * sampleRate).toInt()

        var pos = 0
        while (pos < samples.size) {
            for (i in 0 until clickDurationSamples) {
                val idx = pos + i
                if (idx >= samples.size) break
                val t = i.toDouble() / sampleRate
                val envelope = 0.5 - 0.5 * Math.cos(2.0 * Math.PI * i / clickDurationSamples)
                samples[idx] = (envelope * Math.sin(2.0 * Math.PI * 1000.0 * t) * 0.5).toFloat()
            }
            pos += intervalSamples
        }
        return samples
    }
}
