// From AutoMix (https://github.com/heydavidf/automix), Copyright (C) 2026 David Finnegan.
// AGPL-3.0-only: see ./LICENSE and ./NOTICE.md in playback/automix.

export interface CamelotKey {
  num: number; // 1-12
  letter: 'A' | 'B'; // A = minor, B = major
}

export interface TrackTags {
  title: string;
  artist: string;
  album?: string;
}

// BitChord: 9 adds the Phase 0 loudness fields (lufs, lufsHead, lufsTail) and
// the policy gestures' contentEndSec; 8 records music videos, 7 widens the
// vocal mask to the loop searches, 6 adds Beat This! (re-exported), 5 the
// vocal mask; 3 since the gap-tolerant fitGrid (beatgrid.ts) and the
// head/tail grids; AutoMix's whole-track grids were mostly unusable on real
// songs. Phase 1 keeps 9 as the record's shape and moves invalidation to the
// per-component versions (components.ts) this record carries.
export const ANALYSIS_VERSION = 9;

/** BitChord: Beat This!'s beats and downbeats over one window, on the track's timeline. */
export interface BeatSide {
  beats: number[];
  downbeats: number[];
  bpm: number;
  /** The phone's scale: 0.35-0.95, beatmatchable from 0.55. */
  confidence: number;
}

/**
 * BitChord: the open-unmix vocal curve over one window: curve[i] is at
 * startSec + i / fps. Phase 1 adds the cheap detector as a second source; its
 * output is rescaled onto this same scale (cheapvocal.ts), so a reader and
 * its VOCAL_ACTIVE threshold cannot tell the two apart — the source is only
 * recorded, never read.
 */
export interface VocalWindow {
  startSec: number;
  fps: number;
  curve: number[];
  /** BitChord, Phase 1: which detector produced this curve, for the escalation rule. */
  source?: 'model' | 'cheap';
}

/** BitChord, Phase 1: RMS energy over one edge window: curve[i] is at startSec + i * windowSec. */
export interface EnergySpan {
  startSec: number;
  windowSec: number;
  /** Normalized to the span's own peak (energy.ts's whole-curve convention). */
  curve: number[];
}

/** BitChord: a beat grid fitted to one stretch of the track. */
export interface LocalGrid {
  bpm: number;
  beatIntervalSec: number;
  firstDownbeatSec: number;
  gridConfidence: number;
}

export interface TrackAnalysis {
  fileKey: string;
  path: string;
  tags: TrackTags;
  durationSec: number;
  /**
   * BitChord: bpm, beatIntervalSec, firstDownbeatSec and gridConfidence are
   * fitted to the track's opening (where it is mixed in); [tailGrid] to its
   * last two minutes (where it is mixed out). A breakdown that comes back on
   * a different phase can't break either one.
   */
  bpm: number | null;
  /** Seconds per beat of the regressed constant grid. */
  beatIntervalSec: number | null;
  firstDownbeatSec: number | null;
  /** 0-1; below threshold we fall back to plain crossfades. */
  gridConfidence: number;
  camelot: CamelotKey | null;
  keyName: string | null;
  keyConfidence: number;
  /** 0-1 overall energy. */
  energy: number;
  /**
   * Per-phrase energy, 0-1, over the WHOLE track. Only the L3 pass fills
   * this; until then the edge windows below are what the gestures read.
   */
  energyCurve: number[];
  /**
   * BitChord, Phase 1: energy over the track's edges, filled at L0/L1 — the
   * tail the track is mixed out of and the head it is mixed in on. The
   * gestures (policy.ts) read these when the whole-track curve is absent, so
   * L0 alone already plans a valid transition.
   */
  energySpans?: EnergySpan[];
  introEndSec: number | null;
  outroStartSec: number | null;
  /** BitChord: the grid where the track is mixed out; null when no beat was found there. */
  tailGrid?: LocalGrid | null;
  /** BitChord: Beat This! over the opening (where it's mixed in) and the end (where it's mixed out). */
  headBeats?: BeatSide | null;
  tailBeats?: BeatSide | null;
  /**
   * BitChord: YouTube serves this as a music video, not the song. Its audio
   * often differs from the album cut (a spoken intro, a longer outro), so its
   * synced lyrics don't line up, and the loop mix leaves it alone.
   */
  musicVideo?: boolean;
  /** BitChord: vocal curves over the opening and the end; empty when the model couldn't run. */
  vocals?: VocalWindow[];
  /**
   * BitChord, Phase 0: integrated K-weighted loudness (ITU-R BS.1770), of the
   * whole span, its head and its tail. Null when the span is silent.
   */
  lufs?: number | null;
  lufsHead?: number | null;
  lufsTail?: number | null;
  /**
   * BitChord, Phase 0: where the last audible content ends, excluding
   * trailing silence. The silence trim anchors the mix-out here, and a
   * rejected outro (false ending) mixes out at it; null when nothing is
   * distinguishable from silence.
   */
  contentEndSec?: number | null;
  analysisVersion: number;
  /**
   * BitChord, Automix 2.0 Phase 1: per-component versions (components.ts).
   * A bump invalidates only its own fields — a gridVersion bump re-runs the
   * Beat This! windows and leaves every vocal curve in place. Absent (or 0)
   * on a record that predates the ladder; the migrator stamps the components
   * a cached record already holds and leaves the rest to be computed.
   */
  gridVersion?: number;
  vocalVersion?: number;
  miscVersion?: number;
  manualOverrides?: {
    bpm?: number;
    camelot?: CamelotKey;
    gridNudgeBeats?: number;
  };
}
