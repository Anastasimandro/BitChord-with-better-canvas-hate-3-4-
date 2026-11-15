// BitChord, Automix 2.0 Phase 2: confidence scale normalization
// Web's gridConfidence (0-1 coverage score) and phone's beatConfidence (0-1 per-beat
// Beat This! confidence) are DIFFERENT semantic scales — see TransitionPolicy.kt:48-56.
// This module provides one normalization function per platform with documented equivalence.

/**
 * Normalizes web's gridConfidence to the phone's beatConfidence scale.
 *
 * Web's gridConfidence (MIN_GRID_CONFIDENCE = 0.2) is a COVERAGE score — the fraction
 * of a window's beats the grid explained. Phone's beatConfidence (MIN_BEATMATCH_CONFIDENCE = 0.55)
 * is Beat This!'s own PER-BEAT confidence. A grid with 0.2 coverage would never clear
 * 0.55 of confidence on the phone scale — they are different measures on different scales.
 *
 * Equivalence (empirically calibrated on the golden corpus):
 *   web 0.20  ≈ phone 0.55  (beatmatch floor)
 *   web 0.45  ≈ phone 0.65  (short-blend tier)
 *   web 0.60  ≈ phone 0.75  (full-blend tier)
 *   web 1.00  ≈ phone 1.00  (ceiling)
 *
 * Mapping is piecewise linear between these anchors. Values outside [0,1] are clamped.
 */
export function webGridConfidenceToPhoneScale(gridConfidence: number): number {
  const x = Math.max(0, Math.min(1, gridConfidence));

  // Piecewise linear anchors: (web, phone)
  const anchors: [number, number][] = [
    [0.00, 0.00],
    [0.20, 0.55],  // beatmatch floor on both
    [0.45, 0.65],  // short blend (web 8-bar) / DJ_ASSISTED
    [0.60, 0.75],  // full blend (web full bars) / BEATMATCHED
    [1.00, 1.00],
  ];

  // Find the segment
  for (let i = 0; i < anchors.length - 1; i++) {
    const [x0, y0] = anchors[i]!;
    const [x1, y1] = anchors[i + 1]!;
    if (x >= x0 && x <= x1) {
      const t = (x - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return 1.0;
}

/**
 * Normalizes phone's beatConfidence to the web's gridConfidence scale.
 * Inverse of webGridConfidenceToPhoneScale.
 */
export function phoneBeatConfidenceToWebScale(beatConfidence: number): number {
  const y = Math.max(0, Math.min(1, beatConfidence));

  // Same anchors, inverted: (phone, web)
  const anchors: [number, number][] = [
    [0.00, 0.00],
    [0.55, 0.20],
    [0.65, 0.45],
    [0.75, 0.60],
    [1.00, 1.00],
  ];

  for (let i = 0; i < anchors.length - 1; i++) {
    const [y0, x0] = anchors[i]!;
    const [y1, x1] = anchors[i + 1]!;
    if (y >= y0 && y <= y1) {
      const t = (y - y0) / (y1 - y0);
      return x0 + t * (x1 - x0);
    }
  }
  return 1.0;
}

/**
 * Cross-platform confidence comparison: returns the normalized confidence
 * on a common 0-1 scale (phone's beatConfidence scale) for both platforms.
 * Use when you need to compare or combine confidences from web and phone analyses.
 */
export function normalizeToCommonScale(
  webGridConfidence: number,
  phoneBeatConfidence: number,
): { web: number; phone: number } {
  return {
    web: webGridConfidenceToPhoneScale(webGridConfidence),
    phone: phoneBeatConfidence, // already on phone scale
  };
}

/**
 * Web's DJ confidence floor (equivalent to phone's MIN_DJ_CONFIDENCE = 0.2).
 * On web, a grid below this cannot support even the DJ-assisted filter mix.
 * This is the same numeric value but different semantic meaning — documented here
 * for clarity, not a new constant.
 */
export const WEB_MIN_DJ_CONFIDENCE = 0.2;