// BitChord, Automix 2.0 Phase 1: the cheap vocal detector (L2).
//
// open-unmix is seconds of inference per window and lives on the critical
// path of a loop mix today; this detector is one STFT and a few passes over
// its bins, so the overlap window is measured in tens of milliseconds. It is
// NOT a vocal separation model — it is three vocal-shaped features (harmonic
// salience, mid-band flux, formant presence) fused into one 0..1 score, and
// that score is then RESCALED onto the open-unmix mask's scale so every
// reader downstream (loopMix's maskStats, VOCAL_ACTIVE = 0.25) reads it
// unchanged. The rescale is the phone's heuristicVocalOnModelScale pattern
// (TransitionPolicy.kt): this detector's own decision boundary (0.6, where
// its features separate a sung line from a busy instrumental) lands on the
// model's 0.25 threshold, linearly on either side. The threshold does not
// move; the detector meets it where it is. The boundary sits where the
// fixtures' separation does: a confident sung line fuses ~0.45-0.5, a
// sustained pad ~0.34, noise ~0.17.
//
// On vocal doubt the detector answers in the middle: frames that are neither
// clearly sung nor clearly instrumental land in the model-scale 0.15-0.35
// band, which is "uncertain" — the caller shrinks the overlap (golden rule)
// and escalates to open-unmix at L3 only when a loop mix is imminent.

import type { VocalWindow } from './types';

const SR = 44100;
const FFT = 2048;
const HOP = 512;
export const CHEAP_FPS = SR / HOP; // 86.13
const MELS = 64;
/** The sung band: consonants and sibilance, where a voice moves and a synth pad doesn't. */
const FLUX_LO_HZ = 2000;
const FLUX_HI_HZ = 5000;
/** The formant band: where a lead voice lives in the mix. */
const PRESENCE_LO_HZ = 300;
const PRESENCE_HI_HZ = 3500;
/** The f0 search range for the harmonic salience. */
const F0_LO_HZ = 80;
const F0_HI_HZ = 1000;
/** The detector's own decision boundary, on its raw scale (see the rescale). */
export const CHEAP_VOCAL_BOUNDARY = 0.42;
/** A raw score inside this band is doubt, not evidence: the model-scale 0.15-0.35 straddling the threshold, mapped back through the rescale (0.15 below it, 0.35 above). */
export const CHEAP_UNCERTAIN_BAND = [0.252, 0.4973] as const;
/** Sustained doubt: this share of uncertain frames escalates the window to open-unmix. */
export const CHEAP_UNCERTAIN_SHARE = 0.5;
/** The smoothing window: a syllable is ~0.2 s; its edges stay soft but real. */
const SMOOTH_FRAMES = 22; // ~0.26 s at CHEAP_FPS

// ---- The front end (mel_spectrogram.cpp's shape, 64 bands at 44.1 kHz) ----

// The Slaney mel scale, as models.ts's Beat This! front end; duplicated here
// so this file stays free of the onnx runtime and the tests can import it.
function hzToMel(hz: number): number {
  const fSp = 200 / 3;
  const minLogHz = 1000;
  const minLogMel = minLogHz / fSp;
  const logstep = Math.log(6.4) / 27;
  return hz >= minLogHz ? minLogMel + Math.log(hz / minLogHz) / logstep : hz / fSp;
}

function melToHz(mel: number): number {
  const fSp = 200 / 3;
  const minLogHz = 1000;
  const minLogMel = minLogHz / fSp;
  const logstep = Math.log(6.4) / 27;
  return mel >= minLogMel ? minLogHz * Math.exp(logstep * (mel - minLogMel)) : fSp * mel;
}

function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let start = 0; start < n; start += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = start + k;
        const b = a + len / 2;
        const or = re[b]! * cr - im[b]! * ci;
        const oi = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - or;
        im[b] = im[a]! - oi;
        re[a] = re[a]! + or;
        im[a] = im[a]! + oi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** Periodic Hann, as torch.hann_window(periodic=True). */
function hann(size: number): Float64Array {
  const w = new Float64Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  return w;
}

interface Filterbank {
  first: Int32Array;
  last: Int32Array;
  weights: Float64Array[];
  /** Linear bin index of each band edge, for the band-limited features. */
  binOf: (hz: number) => number;
}

let bank: Filterbank | null = null;

/** Triangular Slaney-scale filters, unit peak, 30 Hz–11 kHz — 64 bands. */
function filterbank(): Filterbank {
  if (bank) return bank;
  const bins = FFT / 2 + 1;
  const lo = hzToMel(30);
  const hi = hzToMel(11000);
  const edges = Array.from({ length: MELS + 2 }, (_, i) => melToHz(lo + ((hi - lo) * i) / (MELS + 1)));
  const first = new Int32Array(MELS);
  const last = new Int32Array(MELS);
  const weights: Float64Array[] = [];
  for (let m = 0; m < MELS; m++) {
    const [left, centre, right] = [edges[m]!, edges[m + 1]!, edges[m + 2]!];
    const toBin = (hz: number) => (hz * FFT) / SR;
    const f = Math.max(0, Math.floor(toBin(left)));
    const l = Math.min(bins - 1, Math.ceil(toBin(right)));
    first[m] = f;
    last[m] = l;
    const w = new Float64Array(Math.max(0, l - f + 1));
    for (let b = f; b <= l; b++) {
      const hz = (b * SR) / FFT;
      const rising = centre > left ? (hz - left) / (centre - left) : 0;
      const falling = right > centre ? (right - hz) / (right - centre) : 0;
      w[b - f] = Math.max(0, Math.min(rising, falling));
    }
    weights.push(w);
  }
  bank = { first, last, weights, binOf: (hz) => Math.min(bins - 1, Math.round((hz * FFT) / SR)) };
  return bank;
}

// ---- The features --------------------------------------------------------------------------

/**
 * The detector's raw score per STFT frame of a mono window (44.1 kHz), 0..1
 * before the rescale. Null when the window is too short to analyse.
 *
 * Per frame: harmonic salience (how strongly the spectral envelope spikes at
 * one f0 lag — a sung line holds one, a hi-hat doesn't), rectified spectral
 * flux in 2-5 kHz (a voice keeps making consonants), and formant presence
 * (the 300-3500 Hz energy share). All three are absolute ratios, so a quiet
 * acoustic take and a loud master land on the same scale.
 */
export function cheapVocalRaw(mono: Float32Array): Float32Array | null {
  const pad = FFT / 2;
  if (mono.length <= pad + 1) return null;
  const frames = Math.floor((mono.length - FFT) / HOP) + 1;
  if (frames < 4) return null;

  const b = filterbank();
  const window = hann(FFT);
  const re = new Float64Array(FFT);
  const im = new Float64Array(FFT);
  const mag = new Float64Array(FFT / 2 + 1);
  const prevMag = new Float64Array(FFT / 2 + 1);
  // The windowed frame, kept for the time-domain harmonic pass (the FFT
  // clobbers re in place).
  const frame = new Float64Array(FFT);
  // f0 search in time-domain lags at the 11 kHz effective rate: 80-1000 Hz.
  const LAG_MIN = Math.max(2, Math.round(SR / 4 / F0_HI_HZ));
  const LAG_MAX = Math.min(Math.floor(FFT / 8), Math.round(SR / 4 / F0_LO_HZ));

  // [frame][MELS] linear band energies (power, not log — the flux needs a
  // difference that means "energy arrived", and log1p would flatten it).
  const band = new Float32Array(frames * MELS);
  // The band-limited features read BIN magnitudes, not mel bands: a bin
  // index into the band array walks into the NEXT frame's data.
  const binAt = (hz: number) => Math.max(1, Math.min(mag.length - 1, Math.round((hz * FFT) / SR)));
  const fluxLoBin = binAt(FLUX_LO_HZ);
  const fluxHiBin = binAt(FLUX_HI_HZ);
  const presenceLoBin = binAt(PRESENCE_LO_HZ);
  const presenceHiBin = binAt(PRESENCE_HI_HZ);

  const flux = new Float64Array(frames);
  const presence = new Float64Array(frames);
  const harmonicity = new Float64Array(frames);

  for (let f = 0; f < frames; f++) {
    const start = f * HOP;
    for (let i = 0; i < FFT; i++) {
      const s = mono[start + i]! * window[i]!;
      frame[i] = s;
      re[i] = s;
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < mag.length; k++) {
      const p = re[k]! * re[k]! + im[k]! * im[k]!;
      mag[k] = Math.sqrt(p);
    }

    // rectified flux in the sung band, as a share of that band's energy now.
    // A frame with no real energy up there (a bass-only frame, or a low
    // tone's spectral sidelobes) has a meaningless ratio — dust over dust —
    // and its flux is gated off rather than read.
    let moved = 0;
    let held = 0;
    if (f > 0) {
      for (let k = fluxLoBin; k <= fluxHiBin; k++) {
        const d = mag[k]! - prevMag[k]!;
        if (d > 0) moved += d;
        held += mag[k]!;
      }
    }
    let bandTotal = 0;
    for (let k = 0; k < mag.length; k++) bandTotal += mag[k]!;
    flux[f] = held > bandTotal * 0.01 ? Math.min(1, moved / held) : 0;

    // formant presence: the share of the frame's energy in 300-3500 Hz
    let formant = 0;
    for (let k = presenceLoBin; k <= presenceHiBin; k++) formant += mag[k]!;
    presence[f] = bandTotal > 1e-9 ? formant / bandTotal : 0;
    prevMag.set(mag);

    // the mel bands, for the harmonic salience
    const at = (m: number) => band[f * MELS + m]!;
    for (let m = 0; m < MELS; m++) {
      let e = 0;
      const w = b.weights[m]!;
      for (let k = 0; k < w.length; k++) e += mag[b.first[m]! + k]! * w[k]!;
      band[f * MELS + m] = e;
    }

    // harmonic salience: TIME-DOMAIN autocorrelation of the frame's own
    // samples, over the f0 lag range, as a contrast (peak against the mean).
    // The spectral-envelope version died on two fixtures: adjacent mel bands
    // share filter overlap, so lag-1 correlation inflated ANY spectrum (white
    // noise read maximally periodic), and a sparse three-partial pad then
    // needed a richness dampener that broke the ordering the other way.
    // In the time domain a tone peaks at its period, noise flattens to ~0,
    // and there is nothing to patch. Strided by 4 (11 kHz effective, Nyquist
    // 5.5 kHz > the 1 kHz f0 ceiling), so the pass is a few thousand mults.
    let frameEnergy = 0;
    for (let i = 0; i < frame.length; i += 4) frameEnergy += frame[i]! * frame[i]!;
    let bestR = 0;
    let meanR = 0;
    let lagCount = 0;
    if (frameEnergy > 1e-9) {
      const iMax = frame.length - LAG_MAX * 4;
      for (let lag = LAG_MIN; lag <= LAG_MAX; lag++) {
        let r = 0;
        for (let i = 0; i < iMax; i += 4) r += frame[i]! * frame[i + lag * 4]!;
        const rho = r / frameEnergy;
        if (rho > bestR) bestR = rho;
        meanR += rho;
        lagCount++;
      }
      meanR /= lagCount;
    }
    harmonicity[f] = Math.max(0, Math.min(1, (bestR - meanR) / (1 - meanR + 1e-9)));
  }

  // Fuse: harmonicity says "periodic", presence says "lead-band", flux says
  // "moving". On real signals the sung line separates from a sustained pad
  // through presence and onsets (the pad is as periodic as a voice), and
  // from noise through harmonicity alone. Weights picked against the
  // fixtures' measured spreads; all three are absolute 0..1 ratios.
  const raw = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    raw[f] = Math.max(0, Math.min(1, 0.35 * harmonicity[f]! + 0.25 * flux[f]! + 0.4 * presence[f]!));
  }
  return smooth(raw, SMOOTH_FRAMES);
}

function smooth(v: Float32Array, span: number): Float32Array {
  const out = new Float32Array(v.length);
  const half = span >> 1;
  for (let i = 0; i < v.length; i++) {
    let sum = 0;
    let n = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(v.length - 1, i + half); k++) {
      sum += v[k]!;
      n++;
    }
    out[i] = n ? sum / n : 0;
  }
  return out;
}

/**
 * The detector's raw value, moved onto the model's scale — the phone's
 * heuristicVocalOnModelScale pattern (TransitionPolicy.kt): the detector's
 * decision boundary lands on the model's vocal threshold, linearly on either
 * side, so it decides exactly what it used to while reading as a mask.
 */
export function cheapVocalOnModelScale(value: number): number {
  if (!Number.isFinite(value)) return value;
  const v = Math.max(0, Math.min(1, value));
  if (v < CHEAP_VOCAL_BOUNDARY) return (v / CHEAP_VOCAL_BOUNDARY) * VOCAL_ACTIVE_ON_MODEL;
  return VOCAL_ACTIVE_ON_MODEL + ((v - CHEAP_VOCAL_BOUNDARY) / (1 - CHEAP_VOCAL_BOUNDARY)) * (1 - VOCAL_ACTIVE_ON_MODEL);
}

/** The model's vocal threshold (loopMix's VOCAL_ACTIVE / the phone's 0.25). */
const VOCAL_ACTIVE_ON_MODEL = 0.25;

/**
 * The share of [raw] frames in the uncertainty band — the sustained-doubt
 * measure that escalates a window to open-unmix at L3. The band is the
 * model-scale 0.15-0.35 straddling the vocal threshold, which is raw
 * 0.36-0.84 under the rescale: a window whose doubt is a few breaths stays
 * cheap; one that doubts half its frames never claimed to know.
 */
export function uncertainShare(raw: Float32Array): number {
  if (!raw.length) return 0;
  let n = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i]! >= CHEAP_UNCERTAIN_BAND[0] && raw[i]! <= CHEAP_UNCERTAIN_BAND[1]) n++;
  }
  return n / raw.length;
}

/**
 * The L2 vocal window: the cheap detector's curve on the model's scale, in
 * the VocalWindow shape every reader already consumes. Null when the window
 * is too short to say anything.
 */
export function cheapVocalWindow(left: Float32Array, right: Float32Array, offsetSec: number): { window: VocalWindow; uncertain: number } | null {
  const n = Math.min(left.length, right.length);
  if (n === 0) return null;
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = (left[i]! + right[i]!) * 0.5;
  const raw = cheapVocalRaw(mono);
  if (!raw) return null;
  const curve = new Array<number>(raw.length);
  for (let i = 0; i < raw.length; i++) curve[i] = cheapVocalOnModelScale(raw[i]!);
  return {
    window: { startSec: offsetSec, fps: CHEAP_FPS, curve, source: 'cheap' },
    uncertain: uncertainShare(raw),
  };
}
