// From AutoMix (https://github.com/heydavidf/automix), Copyright (C) 2026 David Finnegan.
// AGPL-3.0-only: see ./LICENSE and ../NOTICE.md in playback/automix.
//
// Automix 2.0 Phase 1: the worker is level-scoped. A request carries exactly
// the audio the asked-for rung needs, and answers with exactly the fields it
// computed:
//
// - L0 (critical path): ONE edge of the track — Beat This! over it, the
//   edge's integrated LUFS, its RMS energy span, and (from the tail span)
//   the silence trim and the false-ending rule. With L0 alone the planner
//   produces a valid blend/filter/fade/gap plan. essentia runs here ONLY as
//   a fallback, and its WASM is imported the first time a fallback actually
//   fires — never on the way in.
// - L2: the cheap vocal detector (cheapvocal.ts) over the overlap windows.
//   open-unmix is not in this file's L2 path at all.
// - L3 (idle): the whole track — key (essentia, lazy), the whole-track
//   energy curve and intro/outro, whole-track LUFS, and the open-unmix
//   windows for the cache. RhythmExtractor2013 runs only for an edge whose
//   Beat This! pass failed outright.
//
// One wasm session runs one inference at a time; requests stay sequential
// (the analyzer sends one and waits).
import { fitGrid, normalizeTempo, findDownbeat } from './beatgrid';
import { energyCurve, detectIntroOutro } from './energy';
import { toCamelot } from './camelot';
import { integratedLufs } from './loudness';
import { contentEndOf, isFalseEnding, percentile, type CurveView } from '../engine/policy';
import { cheapVocalWindow, CHEAP_UNCERTAIN_SHARE } from './cheapvocal';
import { trackBeats, vocalCurve, VOCAL_FPS, type ModelGrid } from './models';
import { MISC_VERSION, VOCAL_VERSION } from './components';
import type { EnergySpan, LocalGrid, TrackAnalysis, VocalWindow, BeatSide } from './types';
import type Essentia from 'essentia.js/dist/essentia.js-core.es.js';

export interface EdgePcm {
  /** 'head' is the track's opening, 'tail' its ending. */
  edge: 'head' | 'tail';
  /** Mono 22,050 Hz: Beat This!'s input. */
  mono22: Float32Array;
  /** Mono 44.1 kHz: LUFS and the energy span. */
  mono44: Float32Array;
  /** Track time the edge's first sample sits at. */
  offsetSec: number;
  /** Track time the edge's last sample ends at. */
  endSec: number;
}

export interface AnalyzeRequest {
  type: 'analyze';
  fileKey: string;
  /** The track's length, so the spans' absolute times clamp to something real. */
  durationSec: number;
  /** L0: one edge of the track. */
  edge?: EdgePcm;
  /**
   * L1: re-window the edge's energy span (and its intro/outro) at the phrase
   * resolution the grid has since produced, instead of L0's coarse 0.5 s.
   * The edge audio is the same decode the analyzer still holds.
   */
  spanOnly?: boolean;
  /** L2: stereo 44.1 kHz windows for the cheap vocal detector. */
  cheapVocalWindows?: { offsetSec: number; left: Float32Array; right: Float32Array }[];
  /** L3: the whole track, mono 44.1 kHz. */
  samples?: Float32Array;
  /** The energy window L1 re-windows at (and L3's whole curve uses). */
  energyWindowSec?: number;
  /** L3: stereo 44.1 kHz windows for the open-unmix model. */
  vocalModelWindows?: { offsetSec: number; left: Float32Array; right: Float32Array }[];
  /** L3: run KeyExtractor (the pair-rejection key; never on the critical path). */
  needKey?: boolean;
}

export interface AnalyzeResponse {
  type: 'result' | 'error';
  fileKey: string;
  message?: string;
  /** Exactly the fields this request computed, in TrackAnalysis's own names. */
  result?: Partial<TrackAnalysis> & { edge?: 'head' | 'tail'; vocalUncertain?: boolean };
}

self.onmessage = async (ev: MessageEvent<AnalyzeRequest>) => {
  const req = ev.data;
  try {
    if (req.edge && req.spanOnly) {
      postMessage({ type: 'result', fileKey: req.fileKey, result: analyzeEdgeSpan(req) } satisfies AnalyzeResponse);
    } else if (req.edge) {
      postMessage({ type: 'result', fileKey: req.fileKey, result: await analyzeEdge(req) } satisfies AnalyzeResponse);
    } else if (req.cheapVocalWindows) {
      postMessage({ type: 'result', fileKey: req.fileKey, result: analyzeCheapVocal(req) } satisfies AnalyzeResponse);
    } else if (req.samples) {
      postMessage(
        { type: 'result', fileKey: req.fileKey, result: await analyzeWholeTrack(req) } satisfies AnalyzeResponse,
      );
    } else {
      throw new Error('empty analysis request');
    }
  } catch (e) {
    postMessage({ type: 'error', fileKey: req.fileKey, message: String(e) } satisfies AnalyzeResponse);
  }
};

// ---- essentia, lazy ------------------------------------------------------------------------

/**
 * essentia.js, imported the first time something actually needs it. The WASM
 * is megabytes; on the L0 critical path it only ever loads when Beat This!
 * fails on an edge, and the key extraction waits for L3 regardless.
 */
let essentiaBundle: Promise<Essentia | null> | null = null;

function essentia(): Promise<Essentia | null> {
  essentiaBundle ??= (async () => {
    try {
      const [{ EssentiaWASM }, { default: EssentiaCtor }] = await Promise.all([
        import('essentia.js/dist/essentia-wasm.es.js'),
        import('essentia.js/dist/essentia.js-core.es.js'),
      ]);
      await new Promise<void>((resolve) => {
        if (EssentiaWASM.calledRun) resolve();
        else EssentiaWASM.onRuntimeInitialized = () => resolve();
      });
      return new EssentiaCtor(EssentiaWASM);
    } catch (e) {
      console.warn('automix: essentia unavailable', e);
      return null;
    }
  })();
  return essentiaBundle;
}

const ANALYSIS_SR = 44100; // RhythmExtractor2013 assumes 44.1 kHz

// ---- L0: one edge --------------------------------------------------------------------------

/**
 * A model grid is worth its essentia fallback only when it carries a loop's
 * worth of downbeats: the loop mix cuts bar lines from them (4 bars needs 5),
 * and a grid with fewer is a tempo, not a map.
 */
const LOOP_MIN_DOWNBEATS = 5;

async function analyzeEdge(req: AnalyzeRequest): Promise<Partial<TrackAnalysis> & { edge: 'head' | 'tail' }> {
  const edge = req.edge!;
  const durationSec = req.durationSec;

  // 1. Beat This! first — always. essentia is the fallback, not the opener.
  const model = await trackBeats(edge.mono22, edge.offsetSec).catch(() => null);
  const fromModel = model && model.downbeats.length >= LOOP_MIN_DOWNBEATS ? localGrid(model) : null;

  // 2. The fallback: essentia's rhythm chain over the same edge, only when
  // the model failed or came back too thin to cut a loop with.
  let grid = fromModel;
  if (!grid) {
    const fallback = await essentiaGrid(edge.mono44, edge.offsetSec, edge.endSec).catch(() => null);
    if (fallback && (!fromModel || fallback.gridConfidence > modelConfidence(model!) + 0.1)) grid = fallback;
  }

  // 3. The edge's loudness and its coarse energy span, from the same decode.
  const lufs = integratedLufs(edge.mono44, ANALYSIS_SR);
  const span = energySpanOf(edge.mono44, ANALYSIS_SR, edge.offsetSec);
  const view: CurveView = { curve: span.curve, windowSec: span.windowSec, startSec: span.startSec, endSec: edge.endSec };
  const typical = percentile(span.curve, 0.6);

  // 4. The windows' own intro/outro — of the EDGE, never of the whole track.
  // The head's intro end and the tail's outro start are the two the planner
  // reads; the other edge leaves its side null and the planner degrades.
  const { introEndSec, outroStartSec } = detectIntroOutro(
    span.curve,
    span.windowSec,
    span.curve.length * span.windowSec,
  );
  const result: Partial<TrackAnalysis> & { edge: 'head' | 'tail' } = { edge: edge.edge };
  if (lufs !== null) {
    if (edge.edge === 'head') result.lufsHead = lufs;
    else result.lufsTail = lufs;
  }
  result.energySpans = [span];
  if (edge.edge === 'head') result.introEndSec = Math.min(introEndSec + edge.offsetSec, edge.endSec);
  else result.outroStartSec = Math.max(0, Math.min(outroStartSec + edge.offsetSec, edge.endSec));

  // 5. The tail's silence trim and false ending, from the tail span alone —
  // a rejected outro mixes out at the content end (policy.ts's rule).
  if (edge.edge === 'tail') {
    result.contentEndSec = contentEndOf(view, Math.min(durationSec, edge.endSec), typical);
    if (
      result.outroStartSec != null &&
      isFalseEnding(view, result.outroStartSec, edge.endSec, typical)
    ) {
      result.outroStartSec = null;
    }
  }

  // 6. The grid, mapped onto the record's fields. The model's beats ride
  // along (the loop mix cuts on them); an essentia fallback has no model
  // beats, and the loop's constant-grid path takes over from the anchors.
  if (grid) {
    if (edge.edge === 'head') {
      result.headBeats = grid === fromModel && model ? beatSide(model) : null;
      result.bpm = grid.bpm;
      result.beatIntervalSec = grid.beatIntervalSec;
      result.firstDownbeatSec = grid.firstDownbeatSec;
      result.gridConfidence = grid.gridConfidence;
    } else {
      result.tailBeats = grid === fromModel && model ? beatSide(model) : null;
      result.tailGrid = {
        bpm: grid.bpm,
        beatIntervalSec: grid.beatIntervalSec,
        firstDownbeatSec: grid.firstDownbeatSec,
        gridConfidence: grid.gridConfidence,
      };
    }
  }
  return result;
}

/** The edge's grid through essentia, for the fallback path only. */
async function essentiaGrid(mono44: Float32Array, startSec: number, endSec: number): Promise<LocalGrid | null> {
  const ess = await essentia();
  if (!ess) return null;
  return rhythmGrid(ess, mono44, ANALYSIS_SR, startSec, endSec);
}

/** essentia's "excellent" beat-tracking confidence. */
const ESS_EXCELLENT = 3.5;
/** The residual a steady beat still shows, from essentia's 11.6 ms hop and its tick wobble. */
const TICK_JITTER_MS = 20;

/** AutoMix's rhythm step (RhythmExtractor2013 -> fitGrid -> downbeat -> confidence) over one edge. */
function rhythmGrid(ess: Essentia, samples: Float32Array, sampleRate: number, startSec: number, endSec: number): LocalGrid | null {
  // The edge IS the slice: its mono44 starts at [startSec] by construction.
  const slice = samples.subarray(0, Math.min(samples.length, Math.round((endSec - startSec) * sampleRate)));
  const vec = ess.arrayToVector(slice);
  try {
    const rhythm = ess.RhythmExtractor2013(vec, 208, 'multifeature', 60);
    const ticks = ess.vectorToArray(rhythm.ticks);
    rhythm.ticks.delete();
    rhythm.estimates.delete();
    rhythm.bpmIntervals.delete();
    // essentia multifeature confidence ranges 0..5.32; BitChord reads it on
    // essentia's documented scale, where 1.5-3.5 is "good" and above is
    // "excellent" (AutoMix divided by 5.32, so a well-tracked song topped out
    // near 0.3 and almost nothing cleared MIN_GRID_CONFIDENCE).
    const essConfidence = Math.max(0, Math.min(1, rhythm.confidence / ESS_EXCELLENT));
    const rawFit = fitGrid(ticks);
    if (!rawFit) return null;
    const fit = normalizeTempo(rawFit);
    const db = findDownbeat(slice, sampleRate, fit.beatIntervalSec, fit.offsetSec);
    return {
      bpm: fit.bpm,
      beatIntervalSec: fit.beatIntervalSec,
      firstDownbeatSec: startSec + db.firstDownbeatSec,
      // jittery ticks (vs the constant grid) and a weak downbeat both reduce trust
      // (BitChord: less the ~20 ms essentia's own tick jitter always leaves)
      gridConfidence: essConfidence * Math.exp(-Math.max(0, fit.residualMs - TICK_JITTER_MS) / 50) * (0.5 + 0.5 * db.confidence),
    };
  } finally {
    vec.delete();
  }
}

/** The model's confidence on the LocalGrid scale, for comparing a fallback against it. */
function modelConfidence(g: ModelGrid): number {
  return Math.max(0, Math.min(1, (g.confidence - 0.35) / 0.6));
}

/** A model grid as AutoMix's constant grid (the Phase 0 mapping, unchanged). */
function localGrid(g: ModelGrid): LocalGrid {
  const fit = fitGrid(g.beats);
  const beatIntervalSec = fit ? normalizeTempo(fit).beatIntervalSec : 60 / g.bpm;
  return {
    bpm: 60 / beatIntervalSec,
    beatIntervalSec,
    firstDownbeatSec: g.downbeats[0] ?? g.beats[0]!,
    gridConfidence: modelConfidence(g),
  };
}

function beatSide(g: ModelGrid): BeatSide {
  return { beats: g.beats, downbeats: g.downbeats, bpm: g.bpm, confidence: g.confidence };
}

/** The edge's RMS energy span, normalized to its own peak (energy.ts's convention, edge-scoped). */
function energySpanOf(mono: Float32Array, sampleRate: number, offsetSec: number, windowSec: number = SPAN_WINDOW_SEC): EnergySpan {
  const windowSamples = Math.max(1, Math.round(windowSec * sampleRate));
  const curve: number[] = [];
  for (let start = 0; start < mono.length; start += windowSamples) {
    const end = Math.min(mono.length, start + windowSamples);
    let acc = 0;
    for (let i = start; i < end; i++) acc += mono[i]! * mono[i]!;
    curve.push(Math.sqrt(acc / (end - start)));
  }
  const peak = Math.max(...curve, 1e-9);
  // The span is [offsetSec, offsetSec + curve.length * windowSec) by construction.
  return { startSec: offsetSec, windowSec, curve: curve.map((v) => v / peak) };
}

/** The L0 energy span's frame: coarse — the gestures read shapes, not transients. */
const SPAN_WINDOW_SEC = 0.5;

// ---- L1: the edge's span at the phrase resolution ------------------------------------------

/**
 * The edge's energy span re-windowed at the phrase length, and the intro/
 * outro that resolution can actually see. Same decode, one RMS pass — the
 * rung exists because L0's window is fixed at 0.5 s (the grid that would
 * size a phrase window doesn't exist yet when the edge is first measured).
 */
function analyzeEdgeSpan(req: AnalyzeRequest): Partial<TrackAnalysis> & { edge: 'head' | 'tail' } {
  const edge = req.edge!;
  const windowSec = Math.max(2, Math.min(8, req.energyWindowSec ?? 4));
  const span = energySpanOf(edge.mono44, ANALYSIS_SR, edge.offsetSec, windowSec);
  const { introEndSec, outroStartSec } = detectIntroOutro(span.curve, span.windowSec, span.curve.length * span.windowSec);
  const result: Partial<TrackAnalysis> & { edge: 'head' | 'tail' } = { edge: edge.edge, energySpans: [span] };
  if (edge.edge === 'head') result.introEndSec = Math.min(introEndSec + edge.offsetSec, edge.endSec);
  else result.outroStartSec = Math.max(0, Math.min(outroStartSec + edge.offsetSec, edge.endSec));
  return result;
}

// ---- L2: the cheap vocal detector ----------------------------------------------------------

function analyzeCheapVocal(req: AnalyzeRequest): Partial<TrackAnalysis> & { vocalUncertain: boolean } {
  const windows: VocalWindow[] = [];
  let uncertain = false;
  for (const w of req.cheapVocalWindows ?? []) {
    const made = cheapVocalWindow(w.left, w.right, w.offsetSec);
    if (!made) continue;
    windows.push(made.window);
    // sustained doubt escalates this window to open-unmix (L3) when a loop
    // mix is about to be planned — the analyzer reads the flag, not a score.
    if (made.uncertain >= CHEAP_UNCERTAIN_SHARE) uncertain = true;
  }
  return { vocals: windows, vocalVersion: VOCAL_VERSION, vocalUncertain: uncertain };
}

// ---- L3: the whole track -------------------------------------------------------------------

async function analyzeWholeTrack(req: AnalyzeRequest): Promise<Partial<TrackAnalysis>> {
  const samples = req.samples!;
  const sampleRate = ANALYSIS_SR;
  const durationSec = req.durationSec;
  const result: Partial<TrackAnalysis> = {};

  // --- key (L3 only; it must never block the critical path) ---
  if (req.needKey) {
    const ess = await essentia();
    if (ess) {
      const vec = ess.arrayToVector(samples);
      try {
        const key = ess.KeyExtractor(vec);
        result.camelot = toCamelot(key.key, key.scale);
        result.keyName = `${key.key} ${key.scale}`;
        result.keyConfidence = key.strength;
      } finally {
        vec.delete();
      }
    }
  }

  // --- the whole-track energy curve and intro/outro (the L3 refinement of the edge spans) ---
  const windowSec = Math.max(2, Math.min(8, req.energyWindowSec ?? 4));
  const curve = energyCurve(samples, sampleRate, windowSec);
  const whole: CurveView = { curve, windowSec, startSec: 0, endSec: durationSec };
  const typical = percentile(curve, 0.6);
  const { introEndSec, outroStartSec } = detectIntroOutro(curve, windowSec, durationSec);
  result.energyCurve = curve;
  result.energy = curve.reduce((a, b) => a + b, 0) / Math.max(1, curve.length);
  result.introEndSec = introEndSec;
  result.outroStartSec = isFalseEnding(whole, outroStartSec, durationSec, typical) ? null : outroStartSec;
  result.contentEndSec = contentEndOf(whole, durationSec, typical);

  // --- whole-track loudness (the edge spans are already stored) ---
  const lufs = integratedLufs(samples, sampleRate);
  if (lufs !== null) result.lufs = lufs;

  // --- open-unmix over the model's windows (the cache's vocal record) ---
  const vocals: VocalWindow[] = [];
  for (const w of req.vocalModelWindows ?? []) {
    const mask = await vocalCurve(w.left, w.right).catch(() => null);
    if (mask) vocals.push({ startSec: w.offsetSec, fps: VOCAL_FPS, curve: Array.from(mask), source: 'model' });
  }
  if (vocals.length) {
    result.vocals = vocals;
    result.vocalVersion = VOCAL_VERSION;
  }

  // --- misc is whole now ---
  result.miscVersion = MISC_VERSION;
  return result;
}
