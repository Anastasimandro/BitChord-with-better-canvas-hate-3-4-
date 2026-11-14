package com.music.bitchord.playback.smart

import kotlin.math.PI
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.pow
import kotlin.math.sin
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The cheap vocal detector, against the same synthetic fixtures the web port
 * was tuned on: a sung line reads above a sustained pad, which reads above
 * noise. The web's numbers come from the same generators, so the two
 * implementations are checked against one scale — and the rescale is checked
 * against the policy contract: the detector's own boundary lands on the
 * model's 0.25 threshold, exactly, and the threshold never moves.
 */
class CheapVocalTest {

    private val sr = 44100

    /** A sung line, synthesized: a harmonic stack at 200 Hz, syllable-gated at ~4 Hz. */
    private fun vocalLike(seconds: Double): FloatArray {
        val n = (seconds * sr).toInt()
        val out = FloatArray(n)
        val f0 = 200.0
        fun formant(hz: Double): Double = exp(-((ln(hz / 1200.0) / ln(2.0)).let { it * it } / (2.0 * 1.2 * 1.2)))
        for (i in 0 until n) {
            val t = i.toDouble() / sr
            val gate = maxOf(0.0, sin(2.0 * PI * 4.0 * t)).pow(0.5)
            var s = 0.0
            for (k in 1..12) {
                s += (sin(2.0 * PI * f0 * k * t + k) / k) * formant(f0 * k) * gate
            }
            out[i] = (s * 0.3).toFloat()
        }
        return out
    }

    /** A sustained pad: periodic, static, formant-light. */
    private fun padOf(seconds: Double): FloatArray {
        val n = (seconds * sr).toInt()
        val pad = FloatArray(n)
        for (i in 0 until n) {
            val t = i.toDouble() / sr
            pad[i] = ((sin(2 * PI * 110 * t) + 0.5 * sin(2 * PI * 220 * t) + 0.3 * sin(2 * PI * 330 * t)) * 0.2).toFloat()
        }
        return pad
    }

    /** White noise. */
    private fun noise(seconds: Double, seed: Int = 7): FloatArray {
        val n = (seconds * sr).toInt()
        val out = FloatArray(n)
        var s = seed
        for (i in 0 until n) {
            s = (s * 1103515245 + 12345) and 0x7fffffff
            out[i] = ((s.toDouble() / 0x3fffffff.toDouble() - 1.0) * 0.3).toFloat()
        }
        return out
    }

    private fun mean(v: FloatArray): Double = v.sumOf { it.toDouble() } / v.size

    @Test
    fun ordersASungLineAboveASustainedPadAboveNoise() {
        val sung = mean(CheapVocal.raw(vocalLike(4.0))!!)
        val padScore = mean(CheapVocal.raw(padOf(4.0))!!)
        val silent = mean(CheapVocal.raw(noise(4.0))!!)
        // The syllabic movement and the formant share are what lift the line:
        // the pad is as periodic as the voice but static, and noise is neither.
        assertTrue(sung > padScore + 0.08, "sung $sung vs pad $padScore")
        assertTrue(padScore > silent + 0.05, "pad $padScore vs noise $silent")
        assertTrue(silent < 0.3, "noise $silent")
    }

    @Test
    fun readsASteadyPadAsNotSungPeriodicButStatic() {
        val curve = CheapVocal.raw(padOf(4.0))!!
        val sung = CheapVocal.raw(vocalLike(4.0))!!
        // The pad's fused score sits under the boundary; the sung line over it.
        assertTrue(mean(curve) < CheapVocal.CHEAP_VOCAL_BOUNDARY, "pad ${mean(curve)}")
        assertTrue(mean(sung) > CheapVocal.CHEAP_VOCAL_BOUNDARY, "sung ${mean(sung)}")
    }

    @Test
    fun tooShortAWindowSaysNothing() {
        assertNull(CheapVocal.raw(FloatArray(CheapVocal.FFT / 2 + 1)))
        assertNull(CheapVocal.window(FloatArray(0), FloatArray(0), 0.0))
    }

    @Test
    fun theRescaleLandsItsOwnBoundaryOnTheModelThresholdExactly() {
        assertEquals(0.0, CheapVocal.onModelScale(0.0), 1e-12)
        assertEquals(0.25, CheapVocal.onModelScale(CheapVocal.CHEAP_VOCAL_BOUNDARY), 1e-12)
        assertEquals(1.0, CheapVocal.onModelScale(1.0), 1e-12)
    }

    @Test
    fun theRescaleIsLinearEitherSideAndMonotoneThroughIt() {
        val b = CheapVocal.CHEAP_VOCAL_BOUNDARY
        assertEquals(0.125, CheapVocal.onModelScale(b / 2), 1e-10)
        assertEquals(0.625, CheapVocal.onModelScale(b + (1 - b) / 2), 1e-10)
        var prev = -1.0
        var v = 0.0
        while (v <= 1.0) {
            val mapped = CheapVocal.onModelScale(v)
            assertTrue(mapped >= prev, "rescale not monotone at $v")
            prev = mapped
            v += 0.01
        }
    }

    @Test
    fun theDoubtBandCoversTheModelScalePointOneFiveToPointThreeFive() {
        // The band edges, mapped through the rescale, read 0.15 and 0.35.
        assertEquals(0.15, CheapVocal.onModelScale(CheapVocal.CHEAP_UNCERTAIN_BAND.first), 1e-10)
        assertEquals(0.35, CheapVocal.onModelScale(CheapVocal.CHEAP_UNCERTAIN_BAND.endInclusive), 1e-2)
    }

    @Test
    fun uncertainShareCountsOnlyTheDoubtBand() {
        val low = CheapVocal.CHEAP_UNCERTAIN_BAND.first - 0.01
        val inside = (CheapVocal.CHEAP_UNCERTAIN_BAND.first + CheapVocal.CHEAP_UNCERTAIN_BAND.endInclusive) / 2
        val high = CheapVocal.CHEAP_UNCERTAIN_BAND.endInclusive + 0.01
        val raw = floatArrayOf(low.toFloat(), inside.toFloat(), high.toFloat(), inside.toFloat())
        assertEquals(0.5, CheapVocal.uncertainShare(raw), 1e-12)
        assertEquals(0.0, CheapVocal.uncertainShare(FloatArray(0)), 1e-12)
    }

    @Test
    fun theWindowLandsOnTheModelScaleWithTheRightFrameRate() {
        val left = vocalLike(4.0)
        val (window, uncertain) = CheapVocal.window(left, left, 12.0)!!
        assertEquals(CheapVocal.CHEAP_FPS, window.frameRate, 1e-9)
        assertEquals(12.0, window.startTime, 1e-9)
        // On its own signal the detector is confident: little doubt, values
        // inside 0..1 (the stored curve's clamp).
        assertTrue(uncertain < 0.5, "uncertain $uncertain on a sung line")
        for (v in window.values) {
            assertTrue(v in 0f..1f, "value $v outside the mask scale")
        }
    }
}
