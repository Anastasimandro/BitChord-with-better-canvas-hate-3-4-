package com.music.bitchord.playback.smart

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.sin
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The integrated loudness measurement: calibrated against the one number
 * everyone quotes from BS.1770 — a full-scale 997 Hz sine reads -3 LUFS —
 * and checked for the invariances the planner leans on: +6 dB of signal is
 * +6 LUFS, and a view of a span measures the same as the span itself.
 */
class LoudnessTest {

    private fun sine(sampleRate: Int, seconds: Double, peak: Double, hz: Double = 997.0): FloatArray {
        val count = (sampleRate * seconds).toInt()
        return FloatArray(count) { i -> (peak * sin(2.0 * PI * hz * i / sampleRate)).toFloat() }
    }

    @Test
    fun silenceMeasuresNothing() {
        assertNull(Loudness.integratedLufs(FloatArray(44100 * 5), 44100))
    }

    @Test
    fun aSpanShorterThanOneBlockMeasuresNothing() {
        assertNull(Loudness.integratedLufs(FloatArray(44100 / 2), 44100))
    }

    @Test
    fun aFullScaleSineReadsNearMinusThreeLufs() {
        val lufs = Loudness.integratedLufs(sine(44100, 5.0, 1.0), 44100)!!
        assertEquals(-3.0, lufs, 0.5, "full-scale 997 Hz sine: $lufs LUFS")
    }

    @Test
    fun sixDecibelsOfSignalIsSixLufs() {
        val loud = Loudness.integratedLufs(sine(48000, 4.0, 1.0), 48000)!!
        val quiet = Loudness.integratedLufs(sine(48000, 4.0, 0.5), 48000)!!
        assertEquals(6.02, loud - quiet, 0.2, "loud $loud LUFS, quiet $quiet LUFS")
    }

    @Test
    fun theHeadAndTailViewsMeasureLikeTheSpansTheyCut() {
        val head = sine(44100, 30.0, 0.9, hz = 440.0)
        val tail = sine(44100, 30.0, 0.3, hz = 440.0)
        val whole = FloatArray(head.size + tail.size)
        head.copyInto(whole)
        tail.copyInto(whole, head.size)
        val headLufs = Loudness.integratedLufs(head, 44100)!!
        val tailLufs = Loudness.integratedLufs(tail, 44100)!!
        assertEquals(
            headLufs,
            Loudness.integratedLufs(whole, 0, head.size, 44100)!!,
            1e-9,
        )
        assertEquals(
            tailLufs,
            Loudness.integratedLufs(whole, head.size, tail.size, 44100)!!,
            1e-9,
        )
        assertTrue(abs(tailLufs - headLufs) > 2.0, "the two edges should differ clearly")
    }
}
