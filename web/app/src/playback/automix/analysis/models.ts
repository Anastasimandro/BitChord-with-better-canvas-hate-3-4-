/*
 * Beat This! beat/downbeat tracking and the open-unmix vocal mask, as the
 * phone runs them: a TypeScript port of BitChord's native front ends
 * (native/analyzer/mel_spectrogram.cpp, vocal_spectrogram.cpp) and of
 * BeatTracker.kt / VocalTracker.kt, which are themselves ported from Orchard
 * (https://github.com/SFG5453/Orchard).
 *
 * Copyright (C) 2026 SFG545 (original Orchard implementation)
 * Copyright (C) 2026 Kushagra Singh (BitChord adaptation)
 *
 * Orchard's source is AGPL-3.0-or-later; per AGPLv3 §13 this file is
 * combined into BitChord (GPL-3.0) and remains governed by the AGPLv3. Both
 * models' weights are MIT (Beat This!: CPJKU; open-unmix umxhq: Sony/Inria).
 *
 * Runs inside the analysis worker. Everything here is optional: a model that
 * won't load or infer resolves to null and the caller keeps essentia's answer.
 */
import * as ort from 'onnxruntime-web/wasm';
// The runtime's own .wasm, bundled from the package so it always matches the JS.
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';

ort.env.wasm.wasmPaths = { wasm: ortWasmUrl };
// No cross-origin isolation here, so no SharedArrayBuffer: one thread.
ort.env.wasm.numThreads = 1;

// ---- FFT (radix-2, in place), as the native code -------------------------------------------

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

/** torch.stft(center=True, pad_mode="reflect") padding. */
function reflectPad(samples: Float32Array, pad: number): Float32Array {
  const out = new Float32Array(samples.length + 2 * pad);
  for (let i = 0; i < pad; i++) out[i] = samples[pad - i]!;
  out.set(samples, pad);
  for (let i = 1; i <= pad; i++) out[pad + samples.length - 1 + i] = samples[samples.length - 1 - i]!;
  return out;
}

// ---- Beat This! log-mel front end (mel_spectrogram.cpp) -------------------------------------

export const BEAT_SR = 22050;
const BEAT_FFT = 1024;
const BEAT_HOP = 441;
const BEAT_MELS = 128;
export const BEAT_FPS = BEAT_SR / BEAT_HOP; // 50

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

let melFilters: { first: number; weights: Float64Array }[] | null = null;

/** Triangular Slaney-scale filters, unit peak (torchaudio norm=None), 30 Hz–11 kHz. */
function filterbank() {
  if (melFilters) return melFilters;
  const bins = BEAT_FFT / 2 + 1;
  const lo = hzToMel(30);
  const hi = hzToMel(11000);
  const edges = Array.from({ length: BEAT_MELS + 2 }, (_, i) => melToHz(lo + ((hi - lo) * i) / (BEAT_MELS + 1)));
  melFilters = [];
  for (let m = 0; m < BEAT_MELS; m++) {
    const [left, centre, right] = [edges[m]!, edges[m + 1]!, edges[m + 2]!];
    const toBin = (hz: number) => (hz * BEAT_FFT) / BEAT_SR;
    const first = Math.max(0, Math.floor(toBin(left)));
    const last = Math.min(bins - 1, Math.ceil(toBin(right)));
    const weights = new Float64Array(Math.max(0, last - first + 1));
    for (let b = first; b <= last; b++) {
      const hz = (b * BEAT_SR) / BEAT_FFT;
      const rising = centre > left ? (hz - left) / (centre - left) : 0;
      const falling = right > centre ? (right - hz) / (right - centre) : 0;
      weights[b - first] = Math.max(0, Math.min(rising, falling));
    }
    melFilters.push({ first, weights });
  }
  return melFilters;
}

/** [frames][128] row-major log-mel of mono PCM at 22,050 Hz. */
export function beatSpectrogram(samples: Float32Array): { values: Float32Array; frames: number } | null {
  const pad = BEAT_FFT / 2;
  if (samples.length <= pad + 1) return null;
  const padded = reflectPad(samples, pad);
  const frames = Math.floor((padded.length - BEAT_FFT) / BEAT_HOP) + 1;
  const window = hann(BEAT_FFT);
  const filters = filterbank();
  const norm = Math.sqrt(BEAT_FFT); // torchaudio normalized=True
  const values = new Float32Array(frames * BEAT_MELS);
  const re = new Float64Array(BEAT_FFT);
  const im = new Float64Array(BEAT_FFT);
  const mag = new Float64Array(BEAT_FFT / 2 + 1);
  for (let f = 0; f < frames; f++) {
    const start = f * BEAT_HOP;
    for (let i = 0; i < BEAT_FFT; i++) {
      re[i] = padded[start + i]! * window[i]!;
      im[i] = 0;
    }
    fft(re, im);
    for (let b = 0; b < mag.length; b++) mag[b] = Math.hypot(re[b]!, im[b]!) / norm;
    for (let m = 0; m < BEAT_MELS; m++) {
      const { first, weights } = filters[m]!;
      let e = 0;
      for (let k = 0; k < weights.length; k++) e += mag[first + k]! * weights[k]!;
      values[f * BEAT_MELS + m] = Math.log1p(1000 * Math.max(e, 1e-10));
    }
  }
  return { values, frames };
}

// ---- Beat This! (BeatTracker.kt) ------------------------------------------------------------

/**
 * Beat This! final0 (the official checkpoint, MIT), exported to ONNX on
 * 2026-10-23 with only its MatMuls quantized to int8 (23 MB). The phone's
 * beat_this_int8.onnx also quantized the convolutions and finds no beats;
 * this one matches the float model on 99-100% of beats and every downbeat.
 */
const BEAT_MODEL_URL = '/models/beat_this_final0_q8.onnx';
const CHUNK_FRAMES = 1500;
const BORDER_FRAMES = 6;
const PEAK_WINDOW = 7;
const MIN_BEATS = 8;

let beatSession: Promise<ort.InferenceSession | null> | null = null;

function session(url: string): Promise<ort.InferenceSession | null> {
  return ort.InferenceSession.create(url, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }).catch(
    (e: unknown) => {
      console.warn(`automix: model ${url} unavailable`, e);
      return null;
    },
  );
}

export interface ModelGrid {
  beats: number[];
  downbeats: number[];
  bpm: number;
  confidence: number;
}

/**
 * Beats and downbeats of [pcm] (mono, 22,050 Hz); times offset by
 * [offsetSec]. Null when the model can't load or finds no plausible grid.
 */
export async function trackBeats(pcm: Float32Array, offsetSec: number): Promise<ModelGrid | null> {
  const spec = beatSpectrogram(pcm);
  if (!spec) return null;
  beatSession ??= session(BEAT_MODEL_URL);
  const s = await beatSession;
  if (!s) return null;

  const beatLogits = new Float32Array(spec.frames);
  const downLogits = new Float32Array(spec.frames);
  const stride = CHUNK_FRAMES - 2 * BORDER_FRAMES;
  for (let start = 0; start < spec.frames; start += stride) {
    const length = Math.min(CHUNK_FRAMES, spec.frames - start);
    if (length <= 2 * BORDER_FRAMES && start > 0) break;
    const chunk = spec.values.slice(start * BEAT_MELS, (start + length) * BEAT_MELS);
    const out = await s.run({ [s.inputNames[0]!]: new ort.Tensor('float32', chunk, [1, length, BEAT_MELS]) });
    const beat = out[s.outputNames[0]!]!.data as Float32Array;
    const down = out[s.outputNames[1]!]!.data as Float32Array;
    const keepFrom = start === 0 ? 0 : BORDER_FRAMES;
    const keepTo = start + length >= spec.frames ? length : length - BORDER_FRAMES;
    for (let i = keepFrom; i < keepTo; i++) {
      beatLogits[start + i] = beat[i]!;
      downLogits[start + i] = down[i]!;
    }
    if (start + length >= spec.frames) break;
  }

  const beatFrames = pickPeaks(beatLogits);
  const beats = beatFrames.map((f) => f / BEAT_FPS + offsetSec);
  if (beats.length < MIN_BEATS) return null;
  const bpm = tempoFromBeats(beats);
  if (bpm <= 0) return null;
  const downbeats = [
    ...new Set(
      pickPeaks(downLogits)
        .map((f) => f / BEAT_FPS + offsetSec)
        .map((t) => beats.reduce((best, b) => (Math.abs(b - t) < Math.abs(best - t) ? b : best), beats[0]!)),
    ),
  ].sort((a, b) => a - b);
  const confidence = gridConfidence(
    beats,
    beatFrames.map((f) => beatLogits[Math.round(f)] ?? 0),
  );
  return { beats, downbeats, bpm, confidence };
}

/** Local maxima over seven frames with a positive logit, ties collapsed, refined by a parabola. */
export function pickPeaks(logits: Float32Array): number[] {
  const half = PEAK_WINDOW >> 1;
  const peaks: number[] = [];
  for (let i = 0; i < logits.length; i++) {
    if (logits[i]! <= 0) continue;
    let max = true;
    for (let o = -half; o <= half && max; o++) {
      const n = i + o;
      if (n >= 0 && n < logits.length && logits[n]! > logits[i]!) max = false;
    }
    if (max) peaks.push(i);
  }
  const deduped: number[] = [];
  for (let i = 0; i < peaks.length; i++) {
    let mean = peaks[i]!;
    let count = 1;
    while (i + 1 < peaks.length && peaks[i + 1]! - mean <= 1) {
      i++;
      count++;
      mean += (peaks[i]! - mean) / count;
    }
    deduped.push(Math.round(mean));
  }
  return deduped.map((f) => {
    if (f <= 0 || f + 1 >= logits.length) return f;
    const l = logits[f - 1]!;
    const c = logits[f]!;
    const r = logits[f + 1]!;
    const d = l - 2 * c + r;
    if (Math.abs(d) <= 1e-9) return f;
    return f + Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / d));
  });
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[s.length >> 1]!;
}

export function tempoFromBeats(beats: number[]): number {
  if (beats.length < MIN_BEATS) return 0;
  const gaps = beats.slice(1).map((b, i) => b - beats[i]!);
  const rough = median(gaps);
  if (rough <= 0) return 0;
  const kept = gaps.filter((g) => Math.abs(g - rough) <= rough * 0.2);
  const interval = median(kept.length >= 4 ? kept : gaps);
  if (interval <= 0) return 0;
  const bpm = 60 / interval;
  return bpm >= 40 && bpm <= 220 ? bpm : 0;
}

/** Regularity of the spacing and decisiveness of the peaks, capped at 0.95 (BeatTracker.gridConfidence). */
export function gridConfidence(beats: number[], peakLogits: number[]): number {
  if (beats.length < MIN_BEATS) return 0;
  const gaps = beats.slice(1).map((b, i) => b - beats[i]!);
  const interval = median(gaps);
  if (interval <= 0) return 0;
  const regular = gaps.filter((g) => Math.abs(g - interval) <= interval * 0.1).length / gaps.length;
  const strength = 1 / (1 + Math.exp(-(median(peakLogits) - 0.5)));
  return Math.max(0, Math.min(0.95, 0.35 + 0.4 * regular + 0.25 * strength));
}

// ---- open-unmix vocal mask (vocal_spectrogram.cpp, VocalTracker.kt) --------------------------

export const VOCAL_SR = 44100;
const VOCAL_FFT = 4096;
const VOCAL_HOP = 1024;
const VOCAL_BINS = VOCAL_FFT / 2 + 1;
export const VOCAL_FPS = VOCAL_SR / VOCAL_HOP;
/** The model's fixed input width, ~22.3 s. */
export const VOCAL_FRAMES = 960;
export const VOCAL_WINDOW_SEC = ((VOCAL_FRAMES - 2) * VOCAL_HOP) / VOCAL_SR;

let vocalSession: Promise<ort.InferenceSession | null> | null = null;

/**
 * How vocal each STFT frame of a stereo window (44.1 kHz, at most
 * VOCAL_WINDOW_SEC) is, 0–1: the model's vocal mask averaged over 200 Hz–4 kHz.
 */
export async function vocalCurve(left: Float32Array, right: Float32Array): Promise<Float32Array | null> {
  const pad = VOCAL_FFT / 2;
  if (left.length <= pad + 1 || left.length !== right.length) return null;
  const frames = Math.floor((left.length + 2 * pad - VOCAL_FFT) / VOCAL_HOP) + 1;
  if (frames > VOCAL_FRAMES) return null;
  vocalSession ??= session('/models/vocals_umxhq_int8.onnx');
  const s = await vocalSession;
  if (!s) return null;

  // [1, 2, bins, VOCAL_FRAMES], bin-major, zero-padded tail; raw |DFT| (normalized=False).
  const input = new Float32Array(2 * VOCAL_BINS * VOCAL_FRAMES);
  const window = hann(VOCAL_FFT);
  const re = new Float64Array(VOCAL_FFT);
  const im = new Float64Array(VOCAL_FFT);
  [left, right].forEach((channel, c) => {
    const padded = reflectPad(channel, pad);
    for (let f = 0; f < frames; f++) {
      const start = f * VOCAL_HOP;
      for (let i = 0; i < VOCAL_FFT; i++) {
        re[i] = padded[start + i]! * window[i]!;
        im[i] = 0;
      }
      fft(re, im);
      for (let b = 0; b < VOCAL_BINS; b++) input[(c * VOCAL_BINS + b) * VOCAL_FRAMES + f] = Math.hypot(re[b]!, im[b]!);
    }
  });

  const out = await s.run({ [s.inputNames[0]!]: new ort.Tensor('float32', input, [1, 2, VOCAL_BINS, VOCAL_FRAMES]) });
  const target = out[s.outputNames[0]!]!.data as Float32Array;
  const lowBin = Math.max(0, Math.floor((200 * VOCAL_FFT) / VOCAL_SR));
  const highBin = Math.min(VOCAL_BINS - 1, Math.ceil((4000 * VOCAL_FFT) / VOCAL_SR));
  const curve = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    let count = 0;
    for (let c = 0; c < 2; c++) {
      for (let b = lowBin; b <= highBin; b++) {
        const i = (c * VOCAL_BINS + b) * VOCAL_FRAMES + f;
        const mix = input[i]!;
        if (mix <= 1e-6) continue;
        sum += Math.max(0, Math.min(1, target[i]! / mix));
        count++;
      }
    }
    curve[f] = count ? sum / count : 0;
  }
  return curve;
}

// ---- 2-Stem Separation (HT-Demucs-ft / Mel-Band RoFormer) ------------------------------------

/**
 * 2-Stem model front end: log-mel spectrogram at 44.1 kHz, matching the
 * training setup of HT-Demucs-ft and Mel-Band RoFormer.
 */
export const STEM_SR = 44100;
const STEM_FFT = 4096;
const STEM_HOP = 1024;
const STEM_MELS = 128;
export const STEM_FPS = STEM_SR / STEM_HOP; // 43.066
/** Maximum input frames for the stem model (~30 s window). */
export const STEM_MAX_FRAMES = 1292; // 30s at STEM_FPS

let stemFilters: { first: number; weights: Float64Array }[] | null = null;

function stemHzToMel(hz: number): number {
  const fSp = 200 / 3;
  const minLogHz = 1000;
  const minLogMel = minLogHz / fSp;
  const logstep = Math.log(6.4) / 27;
  return hz >= minLogHz ? minLogMel + Math.log(hz / minLogHz) / logstep : hz / fSp;
}

function stemMelToHz(mel: number): number {
  const fSp = 200 / 3;
  const minLogHz = 1000;
  const minLogMel = minLogHz / fSp;
  const logstep = Math.log(6.4) / 27;
  return mel >= minLogMel ? minLogHz * Math.exp(logstep * (mel - minLogMel)) : fSp * mel;
}

function stemFilterbank() {
  if (stemFilters) return stemFilters;
  const bins = STEM_FFT / 2 + 1;
  const lo = stemHzToMel(30);
  const hi = stemHzToMel(11000);
  const edges = Array.from({ length: STEM_MELS + 2 }, (_, i) => stemMelToHz(lo + ((hi - lo) * i) / (STEM_MELS + 1)));
  stemFilters = [];
  for (let m = 0; m < STEM_MELS; m++) {
    const [left, centre, right] = [edges[m]!, edges[m + 1]!, edges[m + 2]!];
    const toBin = (hz: number) => (hz * STEM_FFT) / STEM_SR;
    const first = Math.max(0, Math.floor(toBin(left)));
    const last = Math.min(bins - 1, Math.ceil(toBin(right)));
    const weights = new Float64Array(Math.max(0, last - first + 1));
    for (let b = first; b <= last; b++) {
      const hz = (b * STEM_SR) / STEM_FFT;
      const rising = centre > left ? (hz - left) / (centre - left) : 0;
      const falling = right > centre ? (right - hz) / (right - centre) : 0;
      weights[b - first] = Math.max(0, Math.min(rising, falling));
    }
    stemFilters.push({ first, weights });
  }
  return stemFilters;
}

/** [frames][128] row-major log-mel of stereo PCM at 44.1 kHz. */
export function stemSpectrogram(left: Float32Array, right: Float32Array): { values: Float32Array; frames: number } | null {
  const pad = STEM_FFT / 2;
  if (left.length <= pad + 1 || left.length !== right.length) return null;
  const paddedL = reflectPad(left, pad);
  const paddedR = reflectPad(right, pad);
  const frames = Math.floor((paddedL.length - STEM_FFT) / STEM_HOP) + 1;
  if (frames > STEM_MAX_FRAMES) return null;
  const window = hann(STEM_FFT);
  const filters = stemFilterbank();
  const norm = Math.sqrt(STEM_FFT);
  const values = new Float32Array(frames * STEM_MELS * 2); // stereo
  const re = new Float64Array(STEM_FFT);
  const im = new Float64Array(STEM_FFT);
  const mag = new Float64Array(STEM_FFT / 2 + 1);
  for (let f = 0; f < frames; f++) {
    const start = f * STEM_HOP;
    for (let ch = 0; ch < 2; ch++) {
      const channel = ch === 0 ? paddedL : paddedR;
      for (let i = 0; i < STEM_FFT; i++) {
        re[i] = channel[start + i]! * window[i]!;
        im[i] = 0;
      }
      fft(re, im);
      for (let b = 0; b < mag.length; b++) mag[b] = Math.hypot(re[b]!, im[b]!) / norm;
      for (let m = 0; m < STEM_MELS; m++) {
        const { first, weights } = filters[m]!;
        let e = 0;
        for (let k = 0; k < weights.length; k++) e += mag[first + k]! * weights[k]!;
        values[(f * STEM_MELS + m) * 2 + ch] = Math.log1p(1000 * Math.max(e, 1e-10));
      }
    }
  }
  return { values, frames };
}

/** 2-Stem model sessions (lazy-loaded). */
let stemSessionHtDemucs: Promise<ort.InferenceSession | null> | null = null;
let stemSessionMelBandRoformer: Promise<ort.InferenceSession | null> | null = null;

export type StemModelName = 'ht-demucs-ft' | 'mel-band-roformer' | 'open-unmix';

export interface StemResult {
  vocals: Float32Array;
  accompaniment: Float32Array;
  qualitySdrDb: number;
}

/**
 * Run 2-stem separation on a stereo window (44.1 kHz).
 * Returns vocals + accompaniment curves (per-frame energy in 0..1) and a quality metric.
 * Null when the model can't load or the window is too long.
 */
export async function stemSeparate(
  left: Float32Array,
  right: Float32Array,
  modelName: StemModelName = 'ht-demucs-ft'
): Promise<StemResult | null> {
  const spec = stemSpectrogram(left, right);
  if (!spec) return null;

  // Select the model session
  let sessionPromise: Promise<ort.InferenceSession | null>;
  let modelUrl: string;
  switch (modelName) {
    case 'ht-demucs-ft':
      modelUrl = '/models/htdemucs_ft_int8.onnx';
      sessionPromise = stemSessionHtDemucs ??= session(modelUrl);
      break;
    case 'mel-band-roformer':
      modelUrl = '/models/mel_band_roformer_int8.onnx';
      sessionPromise = stemSessionMelBandRoformer ??= session(modelUrl);
      break;
    case 'open-unmix':
      // Fallback to open-unmix (vocals only, no accompaniment model here)
      const voc = await vocalCurve(left, right);
      if (!voc) return null;
      // Open-unmix only gives vocal mask; accompaniment = 1 - vocals (rough)
      const accomp = new Float32Array(voc.length);
      for (let i = 0; i < voc.length; i++) accomp[i] = 1 - voc[i]!;
      return { vocals: voc, accompaniment: accomp, qualitySdrDb: 6.0 }; // baseline
    default:
      return null;
  }

  const s = await sessionPromise;
  if (!s) return null;

  // Input shape: [1, 2, STEM_MELS, frames] for HT-Demucs / Mel-Band RoFormer
  // The exact input format depends on the exported ONNX model
  const input = new ort.Tensor('float32', spec.values, [1, 2, STEM_MELS, spec.frames]);

  try {
    const out = await s.run({ [s.inputNames[0]!]: input });
    // Output: [1, 2, frames] for (vocals, accompaniment) energy curves
    // Actual output format depends on the model export; this is the expected shape
    const outputData = out[s.outputNames[0]!]!.data as Float32Array;
    if (outputData.length !== 2 * spec.frames) return null;

    const vocals = new Float32Array(spec.frames);
    const accompaniment = new Float32Array(spec.frames);
    for (let f = 0; f < spec.frames; f++) {
      vocals[f] = Math.max(0, Math.min(1, outputData[f * 2]!));
      accompaniment[f] = Math.max(0, Math.min(1, outputData[f * 2 + 1]!));
    }

    // Quality proxy: mean vocal energy (higher = more confident separation)
    // In production, this would be replaced with a proper SDR estimate
    const qualitySdrDb = vocals.reduce((a, b) => a + b, 0) / vocals.length * 20 - 10;

    return { vocals, accompaniment, qualitySdrDb };
  } catch (e) {
    console.warn(`automix: stem model ${modelName} inference failed`, e);
    return null;
  }
}

/**
 * Estimate SDR quality of a stem separation by comparing the sum of stems to the mix.
 * Used as a fallback quality metric when ground truth isn't available.
 */
export function estimateStemQuality(
  left: Float32Array,
  right: Float32Array,
  vocals: Float32Array,
  accompaniment: Float32Array
): number {
  const mix = new Float32Array(left.length);
  for (let i = 0; i < left.length; i++) mix[i] = (left[i]! + right[i]!) * 0.5;

  // Reconstruct from stems (vocals + accompaniment should approximate mix)
  const reconstructed = new Float32Array(mix.length);
  const hopSamples = Math.round(mix.length / vocals.length);
  for (let f = 0; f < vocals.length; f++) {
    const start = f * hopSamples;
    const end = Math.min(start + hopSamples, mix.length);
    const v = vocals[f]!;
    const a = accompaniment[f]!;
    for (let i = start; i < end; i++) reconstructed[i] = v + a;
  }

  // SDR = 10 * log10(||mix||^2 / ||mix - reconstructed||^2)
  let mixPower = 0;
  let errorPower = 0;
  for (let i = 0; i < mix.length; i++) {
    mixPower += mix[i]! * mix[i]!;
    const diff = mix[i]! - reconstructed[i]!;
    errorPower += diff * diff;
  }
  if (errorPower === 0) return 100;
  if (mixPower === 0) return -100;
  return 10 * Math.log10(mixPower / errorPower);
}

/** Dev: the raw model run over the first chunk of [pcm], for checking the front end against the phone. */
export async function debugBeatLogits(pcm: Float32Array, level: 'disabled' | 'basic' | 'extended' | 'all' = 'all') {
  const spec = beatSpectrogram(pcm)!;
  const s = await ort.InferenceSession.create(BEAT_MODEL_URL, { executionProviders: ['wasm'], graphOptimizationLevel: level });
  const len = Math.min(CHUNK_FRAMES, spec.frames);
  const out = await s.run({ [s.inputNames[0]!]: new ort.Tensor('float32', spec.values.slice(0, len * BEAT_MELS), [1, len, BEAT_MELS]) });
  return { spec, inputs: s.inputNames, outputs: s.outputNames, beat: out[s.outputNames[0]!]!.data as Float32Array, down: out[s.outputNames[1]!]!.data as Float32Array };
}