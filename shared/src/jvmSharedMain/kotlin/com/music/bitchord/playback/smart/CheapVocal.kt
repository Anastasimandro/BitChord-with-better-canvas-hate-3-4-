/*
 * BitChord, Automix 2.0 Phase 1: the cheap vocal detector (L2).
 *
 * Ported from the web player's analysis/cheapvocal.ts — same constants, same
 * features, tuned against the same fixtures. open-unmix is seconds of
 * inference per window and lives on the critical path of a loop mix; this
 * detector is one STFT and a few passes over its bins, so the overlap window
 * is measured in tens of milliseconds. It is NOT a vocal separation model —
 * it is three vocal-shaped features (harmonic salience, mid-band flux,
 * formant presence) fused into one 0..1 score, and that score is then
 * RESCALED onto the open-unmix mask's scale so every reader downstream
 * (LoopMix's maskStats, VOCAL_ACTIVE_THRESHOLD = 0.25) reads it unchanged.
 * The rescale is this platform's own heuristicVocalOnModelScale pattern
 * (TransitionPolicy.kt): this detector's own decision boundary (0.42, where
 * its features separate a sung line from a sustained pad) lands on the
 * model's 0.25 threshold, linearly on either side. The threshold does not
 * move; the detector meets it where it is. The boundary sits where the
 * fixtures' separation does: a confident sung line fuses ~0.45-0.5, a
 * sustained pad ~0.34, noise ~0.17.
 *
 * On vocal doubt the detector answers in the middle: frames that are neither
 * clearly sung nor clearly instrumental land in the model-scale 0.15-0.35
 * band, which is "uncertain" — the caller shrinks the overlap (golden rule)
 * and escalates to open-unmix at L3 only when a loop mix is imminent.
 *
 * Pure JVM: no native library, no ONNX runtime. Runs on the analysis
 * executor thread; the pass over a 30 s window is a few hundred thousand
 * FFT butterflies and a strided autocorrelation, comfortably under a second
 * on a phone core.
 */

package com.music.bitchord.playback.smart

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

object CheapVocal {

    const val SR = 44100.0
    const val FFT = 2048
    const val HOP = 512

    /** Frames per second of the detector's output. */
    const val CHEAP_FPS: Double = SR / HOP // 86.13

    private const val MELS = 64

    /** The sung band: consonants and sibilance, where a voice moves and a synth pad doesn't. */
    private const val FLUX_LO_HZ = 2000.0
    private const val FLUX_HI_HZ = 5000.0

    /** The formant band: where a lead voice lives in the mix. */
    private const val PRESENCE_LO_HZ = 300.0
    private const val PRESENCE_HI_HZ = 3500.0

    /** The f0 search range for the harmonic salience. */
    private const val F0_LO_HZ = 80.0
    private const val F0_HI_HZ = 1000.0

    /** The detector's own decision boundary, on its raw scale (see the rescale). */
    const val CHEAP_VOCAL_BOUNDARY = 0.42

    /** The model's vocal threshold (the policy's VOCAL_ACTIVE_THRESHOLD, 0.25 on both platforms). */
    private const val VOCAL_ACTIVE_ON_MODEL = 0.25

    /**
     * A raw score inside this band is doubt, not evidence: the model-scale
     * 0.15-0.35 straddling the threshold, mapped back through the rescale
     * (0.15 sits below it, 0.35 above).
     */
    val CHEAP_UNCERTAIN_BAND: ClosedFloatingPointRange<Double> =
        cheapVocalRawToModelInverse(VOCAL_ACTIVE_ON_MODEL * 0.6)..cheapVocalOnModelScaleInverse(0.35)

    /** Sustained doubt: this share of uncertain frames escalates the window to open-unmix. */
    const val CHEAP_UNCERTAIN_SHARE = 0.5

    /** The smoothing window: a syllable is ~0.2 s; its edges stay soft but real. */
    private const val SMOOTH_FRAMES = 22 // ~0.26 s at CHEAP_FPS

    // ---- The Slaney mel scale, as the model front end's ----

    private fun hzToMel(hz: Double): Double {
        val fSp = 200.0 / 3.0
        val minLogHz = 1000.0
        val minLogMel = minLogHz / fSp
        val logstep = ln(6.4) / 27.0
        return if (hz >= minLogHz) minLogMel + ln(hz / minLogHz) / logstep else hz / fSp
    }

    private fun melToHz(mel: Double): Double {
        val fSp = 200.0 / 3.0
        val minLogHz = 1000.0
        val minLogMel = minLogHz / fSp
        val logstep = ln(6.4) / 27.0
        return if (mel >= minLogMel) minLogHz * exp(logstep * (mel - minLogMel)) else fSp * mel
    }

    /** Periodic Hann, as torch.hann_window(periodic=true). */
    private fun hann(size: Int): DoubleArray = DoubleArray(size) { 0.5 - 0.5 * cos(2.0 * PI * it / size) }

    /** In-place iterative radix-2 FFT, same shape as the web port. */
    private fun fft(re: DoubleArray, im: DoubleArray) {
        val n = re.size
        var j = 0
        for (i in 1 until n) {
            var bit = n shr 1
            while (j and bit != 0) {
                j = j xor bit
                bit = bit shr 1
            }
            j = j xor bit
            if (i < j) {
                val tr = re[i]; re[i] = re[j]; re[j] = tr
                val ti = im[i]; im[i] = im[j]; im[j] = ti
            }
        }
        var len = 2
        while (len <= n) {
            val ang = -2.0 * PI / len
            val wr = cos(ang)
            val wi = sin(ang)
            var start = 0
            while (start < n) {
                var cr = 1.0
                var ci = 0.0
                for (k in 0 until len / 2) {
                    val a = start + k
                    val b = a + len / 2
                    val br = re[b]
                    val bi = im[b]
                    val orr = br * cr - bi * ci
                    val oi = br * ci + bi * cr
                    re[b] = re[a] - orr
                    im[b] = im[a] - oi
                    re[a] += orr
                    im[a] += oi
                    val ncr = cr * wr - ci * wi
                    ci = cr * wi + ci * wr
                    cr = ncr
                }
                start += len
            }
            len = len shl 1
        }
    }

    /** Triangular Slaney-scale filters, unit peak, 30 Hz-11 kHz — 64 bands. */
    private class Filterbank {
        val first = IntArray(MELS)
        val last = IntArray(MELS)
        val weights = ArrayList<DoubleArray>(MELS)

        companion object {
            fun build(): Filterbank {
                val fb = Filterbank()
                val bins = FFT / 2 + 1
                val lo = hzToMel(30.0)
                val hi = hzToMel(11000.0)
                val edges = DoubleArray(MELS + 2) { melToHz(lo + (hi - lo) * it / (MELS + 1)) }
                for (m in 0 until MELS) {
                    val left = edges[m]
                    val centre = edges[m + 1]
                    val right = edges[m + 2]
                    val f = max(0, floor(left * FFT / SR).toInt())
                    val l = min(bins - 1, kotlin.math.ceil(right * FFT / SR).toInt())
                    fb.first[m] = f
                    fb.last[m] = l
                    val w = DoubleArray(max(0, l - f + 1))
                    for (b in f..l) {
                        val hz = b * SR / FFT
                        val rising = if (centre > left) (hz - left) / (centre - left) else 0.0
                        val falling = if (right > centre) (right - hz) / (right - centre) else 0.0
                        w[b - f] = min(rising, falling).coerceIn(0.0, 1.0)
                    }
                    fb.weights.add(w)
                }
                return fb
            }
        }
    }

    private val bank: Filterbank by lazy { Filterbank.build() }

    // ---- The features -----------------------------------------------------------------------

    /**
     * The detector's raw score per STFT frame of a mono window (44.1 kHz), 0..1
     * before the rescale. Null when the window is too short to analyse.
     *
     * Per frame: harmonic salience — TIME-DOMAIN autocorrelation of the
     * frame's own samples over the f0 lag range, as a contrast (peak against
     * the mean); a sung line holds one period, noise flattens to ~0, and there
     * is nothing to patch. Strided by 4 (11 kHz effective, Nyquist 5.5 kHz >
     * the 1 kHz f0 ceiling), so the pass is a few thousand mults. Then
     * rectified spectral flux in 2-5 kHz (a voice keeps making consonants),
     * gated off when the band holds no real energy — a bass-only frame's ratio
     * is dust over dust — and formant presence (the 300-3500 Hz energy share).
     * All three are absolute ratios, so a quiet acoustic take and a loud
     * master land on the same scale.
     */
    fun raw(mono: FloatArray): FloatArray? {
        val pad = FFT / 2
        if (mono.size <= pad + 1) return null
        val frames = (mono.size - FFT) / HOP + 1
        if (frames < 4) return null

        val b = bank
        val window = hann(FFT)
        val re = DoubleArray(FFT)
        val im = DoubleArray(FFT)
        val mag = DoubleArray(FFT / 2 + 1)
        val prevMag = DoubleArray(FFT / 2 + 1)
        val frame = DoubleArray(FFT)
        val LAG_MIN = max(2, (SR / 4 / F0_HI_HZ).roundToInt())
        val LAG_MAX = min(FFT / 8, (SR / 4 / F0_LO_HZ).roundToInt())

        val flux = DoubleArray(frames)
        val presence = DoubleArray(frames)
        val harmonicity = DoubleArray(frames)
        val bins = mag.size
        fun binAt(hz: Double): Int = (hz * FFT / SR).roundToInt().coerceIn(1, bins - 1)
        val fluxLoBin = binAt(FLUX_LO_HZ)
        val fluxHiBin = binAt(FLUX_HI_HZ)
        val presenceLoBin = binAt(PRESENCE_LO_HZ)
        val presenceHiBin = binAt(PRESENCE_HI_HZ)

        for (f in 0 until frames) {
            val start = f * HOP
            for (i in 0 until FFT) {
                val s = mono[start + i] * window[i]
                frame[i] = s
                re[i] = s
                im[i] = 0.0
            }
            fft(re, im)
            for (k in mag.indices) {
                mag[k] = sqrt(re[k] * re[k] + im[k] * im[k])
            }

            // Rectified flux in the sung band, as a share of that band's energy now.
            var moved = 0.0
            var held = 0.0
            if (f > 0) {
                for (k in fluxLoBin..fluxHiBin) {
                    val d = mag[k] - prevMag[k]
                    if (d > 0) moved += d
                    held += mag[k]
                }
            }
            var bandTotal = 0.0
            for (k in mag.indices) bandTotal += mag[k]
            flux[f] = if (held > bandTotal * 0.01) min(1.0, moved / held) else 0.0

            // Formant presence: the share of the frame's energy in 300-3500 Hz.
            var formant = 0.0
            for (k in presenceLoBin..presenceHiBin) formant += mag[k]
            presence[f] = if (bandTotal > 1e-9) formant / bandTotal else 0.0
            System.arraycopy(mag, 0, prevMag, 0, mag.size)

            // Harmonic salience, strided time-domain autocorrelation.
            var frameEnergy = 0.0
            var i = 0
            while (i < frame.size) {
                frameEnergy += frame[i] * frame[i]
                i += 4
            }
            var bestR = 0.0
            var meanR = 0.0
            var lagCount = 0
            if (frameEnergy > 1e-9) {
                val iMax = frame.size - LAG_MAX * 4
                for (lag in LAG_MIN..LAG_MAX) {
                    var r = 0.0
                    var ii = 0
                    while (ii < iMax) {
                        r += frame[ii] * frame[ii + lag * 4]
                        ii += 4
                    }
                    val rho = r / frameEnergy
                    if (rho > bestR) bestR = rho
                    meanR += rho
                    lagCount++
                }
                meanR /= lagCount
            }
            harmonicity[f] = ((bestR - meanR) / (1.0 - meanR + 1e-9)).coerceIn(0.0, 1.0)
        }

        // Fuse: harmonicity says "periodic", presence says "lead-band", flux
        // says "moving". On real signals the sung line separates from a
        // sustained pad through presence and onsets (the pad is as periodic as
        // a voice), and from noise through harmonicity alone. Weights picked
        // against the fixtures' measured spreads; all three are absolute
        // 0..1 ratios.
        val fused = FloatArray(frames)
        for (f in 0 until frames) {
            fused[f] = (0.35 * harmonicity[f] + 0.25 * flux[f] + 0.4 * presence[f])
                .coerceIn(0.0, 1.0)
                .toFloat()
        }
        return smooth(fused, SMOOTH_FRAMES)
    }

    private fun smooth(v: FloatArray, span: Int): FloatArray {
        val out = FloatArray(v.size)
        val half = span shr 1
        for (i in v.indices) {
            var sum = 0.0
            var n = 0
            for (k in max(0, i - half)..min(v.size - 1, i + half)) {
                sum += v[k]
                n++
            }
            out[i] = if (n > 0) (sum / n).toFloat() else 0f
        }
        return out
    }

    /**
     * The detector's raw value, moved onto the model's scale — the phone's
     * heuristicVocalOnModelScale pattern (TransitionPolicy.kt): the detector's
     * decision boundary lands on the model's vocal threshold, linearly on
     * either side, so it decides exactly what it used to while reading as a
     * mask. The threshold does not move.
     */
    fun onModelScale(value: Double): Double {
        if (!value.isFinite()) return value
        val v = value.coerceIn(0.0, 1.0)
        return if (v < CHEAP_VOCAL_BOUNDARY) {
            v / CHEAP_VOCAL_BOUNDARY * VOCAL_ACTIVE_ON_MODEL
        } else {
            VOCAL_ACTIVE_ON_MODEL + (v - CHEAP_VOCAL_BOUNDARY) / (1 - CHEAP_VOCAL_BOUNDARY) * (1 - VOCAL_ACTIVE_ON_MODEL)
        }
    }

    /** The model-scale value whose raw mapping is [model], for band definitions. */
    private fun cheapVocalOnModelScaleInverse(model: Double): Double =
        CHEAP_VOCAL_BOUNDARY + (model - VOCAL_ACTIVE_ON_MODEL) / (1 - VOCAL_ACTIVE_ON_MODEL) * (1 - CHEAP_VOCAL_BOUNDARY)

    private fun cheapVocalRawToModelInverse(model: Double): Double =
        model / VOCAL_ACTIVE_ON_MODEL * CHEAP_VOCAL_BOUNDARY

    /**
     * The share of [raw] frames in the uncertainty band — the sustained-doubt
     * measure that escalates a window to open-unmix at L3. The band is the
     * model-scale 0.15-0.35 straddling the vocal threshold: a window whose
     * doubt is a few breaths stays cheap; one that doubts half its frames
     * never claimed to know.
     */
    fun uncertainShare(raw: FloatArray): Double {
        if (raw.isEmpty()) return 0.0
        var n = 0
        for (v in raw) {
            if (v.toDouble() >= CHEAP_UNCERTAIN_BAND.start && v.toDouble() <= CHEAP_UNCERTAIN_BAND.endInclusive) n++
        }
        return n.toDouble() / raw.size
    }

    /**
     * The L2 vocal window: the cheap detector's curve on the model's scale, in
     * the [CurveWindow] shape every reader already consumes. Null when the
     * window is too short to say anything.
     */
    fun window(left: FloatArray, right: FloatArray, offsetSec: Double): Pair<CurveWindow, Double>? {
        val n = min(left.size, right.size)
        if (n == 0) return null
        val mono = FloatArray(n)
        for (i in 0 until n) mono[i] = (left[i] + right[i]) * 0.5f
        val raw = raw(mono) ?: return null
        val curve = FloatArray(raw.size) { onModelScale(raw[it].toDouble()).toFloat().coerceIn(0f, 1f) }
        return CurveWindow(startTime = offsetSec, frameRate = CHEAP_FPS, values = curve) to uncertainShare(raw)
    }
}
