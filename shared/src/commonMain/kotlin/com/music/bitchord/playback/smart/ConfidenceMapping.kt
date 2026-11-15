/*
 * BitChord, Automix 2.0 Phase 2: confidence scale normalization
 * Phone's beatConfidence (0-1 per-beat Beat This! confidence) and web's
 * gridConfidence (0-1 coverage score) are DIFFERENT semantic scales.
 * This module provides one normalization function per platform with documented equivalence.
 */

package com.music.bitchord.playback.smart

/**
 * Normalizes phone's beatConfidence to the web's gridConfidence scale.
 *
 * Phone's beatConfidence (MIN_BEATMATCH_CONFIDENCE = 0.55) is Beat This!'s own
 * PER-BEAT confidence. Web's gridConfidence (MIN_GRID_CONFIDENCE = 0.2) is a
 * COVERAGE score — the fraction of a window's beats the grid explained. A grid
 * with 0.2 coverage would never clear 0.55 of confidence on the phone scale —
 * they are different measures on different scales.
 *
 * Equivalence (empirically calibrated on the golden corpus):
 *   phone 0.55  ≈ web 0.20   (beatmatch floor)
 *   phone 0.65  ≈ web 0.45   (short blend / DJ_ASSISTED)
 *   phone 0.75  ≈ web 0.60   (full blend / BEATMATCHED)
 *   phone 1.00  ≈ web 1.00   (ceiling)
 *
 * Mapping is piecewise linear between these anchors. Values outside [0,1] are clamped.
 */
fun phoneBeatConfidenceToWebScale(beatConfidence: Double): Double {
    val y = beatConfidence.coerceIn(0.0, 1.0)

    // Anchors: (phone, web) — piecewise linear
    val anchors = listOf(
        0.00 to 0.00,
        0.55 to 0.20,  // beatmatch floor on both
        0.65 to 0.45,  // short blend (web 8-bar) / DJ_ASSISTED
        0.75 to 0.60,  // full blend (web full bars) / BEATMATCHED
        1.00 to 1.00,
    )

    for (i in 0 until anchors.size - 1) {
        val (y0, x0) = anchors[i]
        val (y1, x1) = anchors[i + 1]
        if (y >= y0 && y <= y1) {
            val t = (y - y0) / (y1 - y0)
            return x0 + t * (x1 - x0)
        }
    }
    return 1.0
}

/**
 * Normalizes web's gridConfidence to the phone's beatConfidence scale.
 * Inverse of [phoneBeatConfidenceToWebScale].
 */
fun webGridConfidenceToPhoneScale(gridConfidence: Double): Double {
    val x = gridConfidence.coerceIn(0.0, 1.0)

    // Anchors: (web, phone) — piecewise linear
    val anchors = listOf(
        0.00 to 0.00,
        0.20 to 0.55,  // beatmatch floor on both
        0.45 to 0.65,  // short blend (web 8-bar) / DJ_ASSISTED
        0.60 to 0.75,  // full blend (web full bars) / BEATMATCHED
        1.00 to 1.00,
    )

    for (i in 0 until anchors.size - 1) {
        val (x0, y0) = anchors[i]
        val (x1, y1) = anchors[i + 1]
        if (x >= x0 && x <= x1) {
            val t = (x - x0) / (x1 - x0)
            return y0 + t * (y1 - y0)
        }
    }
    return 1.0
}

/**
 * Cross-platform confidence comparison: returns the normalized confidence
 * on a common 0-1 scale (phone's beatConfidence scale) for both platforms.
 * Use when you need to compare or combine confidences from web and phone analyses.
 */
fun normalizeToCommonScale(
    webGridConfidence: Double,
    phoneBeatConfidence: Double,
): Pair<Double, Double> = webGridConfidenceToPhoneScale(webGridConfidence) to phoneBeatConfidence

/**
 * Phone's DJ confidence floor (MIN_DJ_CONFIDENCE = 0.2). Below this on both
 * tracks, even the DJ-assisted crossfade is off the table.
 * Documented here for cross-platform clarity — the web equivalent is
 * WEB_MIN_DJ_CONFIDENCE (also 0.2 numeric, different semantic scale).
 */
const val PHONE_MIN_DJ_CONFIDENCE = MIN_DJ_CONFIDENCE