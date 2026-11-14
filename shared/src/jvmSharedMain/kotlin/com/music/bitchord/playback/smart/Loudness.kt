package com.music.bitchord.playback.smart

import kotlin.math.PI
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.tan

/**
 * BitChord, Automix 2.0 Phase 0: integrated K-weighted loudness (ITU-R
 * BS.1770-4) over a mono span the analyzer has already decoded. Weighted RMS
 * with the standard's gating — no model, no second decode.
 *
 * The K-weighting stages are derived from the analog prototypes the standard
 * specifies (libebur128's derivation), so the response matches BS.1770's
 * 48 kHz tables at any rate the container decodes to: a high-shelf at
 * ~1682 Hz (~+4 dB above it) and a 2nd-order high-pass at ~38.1 Hz. That
 * rate-independence is the point — the analyzer measures at whatever the
 * container holds, the planner compares the numbers with each other, and
 * neither depends on the rate.
 *
 * The weighting runs as a single streaming pass: two biquads' worth of state
 * and one mean-square accumulator per 100 ms hop, so a whole track costs no
 * buffer beyond its input. The analyzer is memory-frugal by design and this
 * must not be the exception — see [com.music.bitchord.playback.smart].
 * (app: TrackAnalyzer.structure, which hands this the live mono buffer).
 */
object Loudness {

    private class Biquad(val b0: Double, val b1: Double, val b2: Double, val a1: Double, val a2: Double)

    /**
     * Stage 1: head-diffraction high shelf (+3.9998 dB, f0 1682 Hz, Q 0.7072).
     * Stage 2: RLB high-pass (Butterworth, 38.13 Hz, Q 0.5003).
     */
    private fun kWeightCoeffs(sampleRate: Int): Pair<Biquad, Biquad> {
        val shelfDb = 3.999843853973347
        val f0 = 1681.974450955533
        val q = 0.7072131958060476
        val k = tan(PI * f0 / sampleRate)
        val vh = 10.0.pow(shelfDb / 20.0)
        val vb = vh.pow(0.5)
        val denom = 1.0 + k / q + k * k
        val stage1 = Biquad(
            b0 = (vh + vb * k / q + k * k) / denom,
            b1 = 2.0 * (k * k - vh) / denom,
            b2 = (vh - vb * k / q + k * k) / denom,
            a1 = 2.0 * (k * k - 1.0) / denom,
            a2 = (1.0 - k / q + k * k) / denom,
        )

        val f1 = 38.13456658075627
        val q2 = 0.5003169838435891
        val k2 = tan(PI * f1 / sampleRate)
        val denom2 = 1.0 + k2 / q2 + k2 * k2
        val stage2 = Biquad(
            b0 = 1.0 / denom2,
            b1 = -2.0 / denom2,
            b2 = 1.0 / denom2,
            a1 = 2.0 * (k2 * k2 - 1.0) / denom2,
            a2 = (1.0 - k2 / q2 + k2 * k2) / denom2,
        )
        return stage1 to stage2
    }

    /** Mean square per 400 ms block, 75% overlap (BS.1770's gating grid). */
    private fun blockMeanSquares(
        samples: FloatArray,
        offset: Int,
        length: Int,
        sampleRate: Int,
    ): DoubleArray {
        // The block grid is hops of 100 ms; the block is four of them. At the
        // rates the containers actually hold (44.1/48 kHz and friends) this is
        // exactly the standard's 400 ms; a rate that rounds the two apart by a
        // sample shifts the grid by a hair, which no gate can hear.
        val hop = max(1, (0.1 * sampleRate).roundToInt())
        val block = 4 * hop
        val hops = (length + hop - 1) / hop
        if (hops < 4) return DoubleArray(0)

        val (stage1, stage2) = kWeightCoeffs(sampleRate)
        val hopSums = DoubleArray(hops)
        // Direct-form II transposed biquads, one state pair per stage. State
        // is carried across the whole span and never reset between tracks —
        // the caller passes a fresh span per measurement.
        var s1a = 0.0
        var s1b = 0.0
        var s2a = 0.0
        var s2b = 0.0
        var hopIndex = 0
        var hopSum = 0.0
        for (i in 0 until length) {
            val x = samples[offset + i].toDouble()
            val y1 = stage1.b0 * x + s1a
            s1a = stage1.b1 * x - stage1.a1 * y1 + s1b
            s1b = stage1.b2 * x - stage1.a2 * y1
            val y2 = stage2.b0 * y1 + s2a
            s2a = stage2.b1 * y1 - stage2.a1 * y2 + s2b
            s2b = stage2.b2 * y1 - stage2.a2 * y2
            hopSum += y2 * y2
            if ((i + 1) % hop == 0) {
                hopSums[hopIndex++] = hopSum
                hopSum = 0.0
            }
        }
        if (hopIndex < hops) hopSums[hopIndex] = hopSum

        val blockCount = (length - block) / hop + 1
        val blocks = DoubleArray(max(0, blockCount))
        for (k in blocks.indices) {
            blocks[k] = hopSums[k] + hopSums[k + 1] + hopSums[k + 2] + hopSums[k + 3]
        }
        // hopSums held raw sums; the caller compares against thresholds in
        // mean-square terms, so divide the block by its length once here.
        for (k in blocks.indices) blocks[k] /= block
        return blocks
    }

    private fun lufsOfMs(ms: Double) = -0.691 + 10.0 * log10(max(ms, 1e-12))
    private fun msOfLufs(lufs: Double) = 10.0.pow((lufs + 0.691) / 10.0)

    /**
     * Integrated loudness (LUFS-I) of one mono span: absolute gate at
     * -70 LUFS, relative gate at -10 LU below the gated mean. Null when
     * nothing survives the absolute gate (silence) or the span is shorter
     * than one block.
     */
    fun integratedLufs(samples: FloatArray, sampleRate: Int): Double? =
        integratedLufs(samples, 0, samples.size, sampleRate)

    /** [integratedLufs] over a view of [samples], without copying the span. */
    fun integratedLufs(samples: FloatArray, offset: Int, length: Int, sampleRate: Int): Double? {
        if (length <= 0 || sampleRate <= 0 || offset < 0 || offset + length > samples.size) return null
        val blocks = blockMeanSquares(samples, offset, length, sampleRate)
        if (blocks.isEmpty()) return null
        val absGateMs = msOfLufs(-70.0)
        var gatedSum = 0.0
        var gatedCount = 0
        for (ms in blocks) {
            if (ms >= absGateMs) {
                gatedSum += ms
                gatedCount++
            }
        }
        if (gatedCount == 0) return null
        val relGateMs = msOfLufs(lufsOfMs(gatedSum / gatedCount) - 10.0)
        var aboveSum = 0.0
        var aboveCount = 0
        for (ms in blocks) {
            if (ms >= absGateMs && ms >= relGateMs) {
                aboveSum += ms
                aboveCount++
            }
        }
        if (aboveCount == 0) return null
        return lufsOfMs(aboveSum / aboveCount)
    }
}
