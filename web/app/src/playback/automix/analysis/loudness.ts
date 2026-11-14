// BitChord, Automix 2.0 Phase 0: integrated K-weighted loudness (ITU-R
// BS.1770-4) over the mono 44.1 kHz span the analysis worker already holds.
// Weighted RMS with the standard's gating — no model, no second decode.
//
// The K-weighting stages are derived from the analog prototypes the standard
// specifies (libebur128's derivation), so the response matches BS.1770's
// 48 kHz tables at 44.1 kHz: a high-shelf at 1682 Hz (~+4 dB above it) and a
// 2nd-order high-pass at 38.1 Hz.

interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * Stage 1: head-diffraction high shelf (+3.9998 dB, f0 1682 Hz, Q 0.7072).
 * Stage 2: RLB high-pass (Butterworth, 38.13 Hz, Q 0.5003).
 */
function kWeightCoeffs(sampleRate: number): [BiquadCoeffs, BiquadCoeffs] {
  const shelf = {
    db: 3.999843853973347,
    f0: 1681.974450955533,
    q: 0.7072131958060476,
  };
  const k = Math.tan(Math.PI * shelf.f0 / sampleRate);
  const vh = 10 ** (shelf.db / 20);
  const vb = vh ** 0.5;
  const denom = 1 + k / shelf.q + k * k;
  const stage1: BiquadCoeffs = {
    b0: (vh + vb * k / shelf.q + k * k) / denom,
    b1: (2 * (k * k - vh)) / denom,
    b2: (vh - vb * k / shelf.q + k * k) / denom,
    a1: (2 * (k * k - 1)) / denom,
    a2: (1 - k / shelf.q + k * k) / denom,
  };

  const f1 = 38.13456658075627;
  const q2 = 0.5003169838435891;
  const k2 = Math.tan(Math.PI * f1 / sampleRate);
  const denom2 = 1 + k2 / q2 + k2 * k2;
  const stage2: BiquadCoeffs = {
    b0: 1 / denom2,
    b1: -2 / denom2,
    b2: 1 / denom2,
    a1: (2 * (k2 * k2 - 1)) / denom2,
    a2: (1 - k2 / q2 + k2 * k2) / denom2,
  };
  return [stage1, stage2];
}

/** Direct-form II transposed biquad; state resets per call, never between tracks. */
function applyBiquad(input: Float32Array, c: BiquadCoeffs): Float32Array {
  const out = new Float32Array(input.length);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i]!;
    const y = c.b0 * x + s1;
    s1 = c.b1 * x - c.a1 * y + s2;
    s2 = c.b2 * x - c.a2 * y;
    out[i] = y;
  }
  return out;
}

/** The K-weighted signal: shelf, then high-pass. */
function kWeight(samples: Float32Array, sampleRate: number): Float32Array {
  const [stage1, stage2] = kWeightCoeffs(sampleRate);
  return applyBiquad(applyBiquad(samples, stage1), stage2);
}

/** Mean square per 400 ms block, 75% overlap (BS.1770's gating grid). */
function blockMeanSquares(weighted: Float32Array, sampleRate: number): number[] {
  const block = Math.round(0.4 * sampleRate);
  const hop = Math.round(0.1 * sampleRate);
  const blocks: number[] = [];
  for (let start = 0; start + block <= weighted.length; start += hop) {
    let ss = 0;
    for (let i = start; i < start + block; i++) ss += weighted[i]! * weighted[i]!;
    blocks.push(ss / block);
  }
  return blocks;
}

const lufsOfMs = (ms: number) => -0.691 + 10 * Math.log10(Math.max(ms, 1e-12));
/** LUFS back to mean square, for the gate thresholds. */
const msOfLufs = (lufs: number) => 10 ** ((lufs + 0.691) / 10);

/**
 * Integrated loudness (LUFS-I) of one mono span: absolute gate at -70 LUFS,
 * relative gate at -10 LU below the gated mean. Null when nothing survives
 * the absolute gate (silence).
 */
export function integratedLufs(samples: Float32Array, sampleRate: number): number | null {
  if (samples.length === 0) return null;
  const blocks = blockMeanSquares(kWeight(samples, sampleRate), sampleRate);
  if (!blocks.length) return null;
  const absGateMs = msOfLufs(-70);
  const surviving = blocks.filter((z) => z >= absGateMs);
  if (!surviving.length) return null;
  const gatedMean = surviving.reduce((a, b) => a + b, 0) / surviving.length;
  const relGateMs = msOfLufs(lufsOfMs(gatedMean) - 10);
  const above = blocks.filter((z) => z >= absGateMs && z >= relGateMs);
  if (!above.length) return null;
  return lufsOfMs(above.reduce((a, b) => a + b, 0) / above.length);
}
