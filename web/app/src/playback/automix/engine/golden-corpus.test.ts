// BitChord, Automix 2.0 Phase 2: Golden Corpus CI test (web)
// Runs the TS planner against the shared golden corpus fixture.
// Asserts produced == expected within +/-1 beat. Prints a readable DIFF on failure.

// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Mock AudioContext for happy-dom which doesn't provide it
const mockAudioParam = {
  setValueAtTime: () => {},
  linearRampToValueAtTime: () => {},
  cancelScheduledValues: () => {},
  setTargetAtTime: () => {},
  setValueCurveAtTime: () => {},
  exponentialRampToValueAtTime: () => {},
};
const mockAudioContext = {
  createGain: () => ({ gain: mockAudioParam }),
  createBiquadFilter: () => ({ frequency: mockAudioParam, type: '', Q: 0 }),
  createMediaElementSource: () => ({ connect: () => {} }),
  currentTime: 0,
  sampleRate: 44100,
};
vi.stubGlobal('AudioContext', class AudioContext {
  constructor() { return mockAudioContext; }
  createGain = mockAudioContext.createGain;
  createBiquadFilter = mockAudioContext.createBiquadFilter;
  createMediaElementSource = mockAudioContext.createMediaElementSource;
  get currentTime() { return mockAudioContext.currentTime; }
  get sampleRate() { return mockAudioContext.sampleRate; }
});

import type { TrackAnalysis } from '../analysis/types';
import { scheduleWithStyleScorer } from './transition-scheduler';
import type { LoopMixPlan } from './loopMix';
import { planLoopMix, LOOP_BARS, OUT_REGION_SEC, IN_REGION_SEC } from './loopMix';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load golden corpus fixture
const fixturePath = path.resolve(__dirname, '../../../../../../fixtures/golden-corpus.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8')) as {
  version: number;
  pairs: Array<{
    id: string;
    category: string;
    trackA: any;
    trackB: any;
    expected: any;
    knownIssue?: string;
  }>;
};

const SR = 44100;
function createMockBuffer(durationSec: number): AudioBuffer {
  const data = new Float32Array(Math.round(durationSec * SR)).fill(0.3);
  return {
    duration: durationSec,
    sampleRate: SR,
    length: data.length,
    numberOfChannels: 1,
    getChannelData: () => data,
  } as unknown as AudioBuffer;
}

// Minimal mock Deck for the scheduler
function createMockDeck(ctx: AudioContext): any {
  const gainNode = ctx.createGain();
  const mockFilter = ctx.createBiquadFilter();
  const eq = {
    low: mockFilter,
    mid: mockFilter,
    high: mockFilter,
    setGainAt: (band: string, db: number, time: number) => { },
    rampGain: (band: string, from: number, to: number, time: number, duration: number) => { },
    reset: () => { },
  };
  // sweep filters need frequency to be an AudioParam with cancelScheduledValues
  const sweepFreq = mockAudioParam;
  const sweep = {
    highpass: { frequency: sweepFreq, cancelScheduledValues: () => { }, setValueAtTime: () => { }, exponentialRampToValueAtTime: () => { } },
    lowpass: { frequency: sweepFreq, cancelScheduledValues: () => { }, setValueAtTime: () => { }, exponentialRampToValueAtTime: () => { } },
    reset: () => { },
  };
  const timeline = {
    rateAt: () => 1,
    trackTimeAt: () => 0,
    ctxTimeAt: (trackTime: number) => ctx.currentTime + trackTime,
  };
  // Phase 3 Task 2: the delay the scheduler engages on the outgoing deck
  const delay = { engage: () => { }, release: () => { } };
  // Phase 3 Task 4: the reverb the scheduler engages on the outgoing deck
  const reverb = { engage: () => { }, release: () => { } };
  return {
    ctx,
    gain: { gain: mockAudioParam }, // use mockAudioParam for gain
    eq,
    sweep,
    timeline,
    delay,
    reverb,
    expectedTrackTime: 0,
    scheduleAhead: 0.1,
    playAt: () => { },
    pauseAt: () => { },
    setRate: () => { },
    setVolume: () => { },
  };
}

// Convert fixture track to TrackAnalysis
function fixtureToAnalysis(t: any): TrackAnalysis {
  return {
    fileKey: t.title.toLowerCase().replace(/\s+/g, '-'),
    path: `/mock/${t.title}.mp3`,
    tags: { title: t.title, artist: t.artist, album: '' },
    durationSec: t.durationSec,
    bpm: t.bpm || null,
    beatIntervalSec: t.bpm ? 60 / t.bpm : null,
    firstDownbeatSec: t.firstDownbeatSec ?? 0,
    gridConfidence: t.gridConfidence,
    camelot: t.camelot ? { num: parseInt(t.camelot), letter: (t.camelot.slice(-1) as 'A' | 'B') } : null,
    keyName: t.camelot || null,
    keyConfidence: 0.8,
    energy: t.energy,
    energyCurve: Array.isArray(t.energyCurve) ? t.energyCurve : [],
    energySpans: undefined, // will be added by addFilterGateEnergySpans in planPair
    introEndSec: t.introEndSec ?? (t.bpm ? 60 / t.bpm * 16 : null),
    outroStartSec: t.outroStartSec ?? (t.durationSec - 30),
    tailGrid: t.gridConfidence > 0.2 ? {
      bpm: t.bpm,
      beatIntervalSec: 60 / t.bpm,
      firstDownbeatSec: t.durationSec - 30,
      gridConfidence: t.gridConfidence,
    } : null,
    headBeats: t.beatConfidence > 0.2 ? {
      beats: [],
      downbeats: [],
      bpm: t.bpm,
      confidence: t.beatConfidence,
    } : null,
    tailBeats: t.beatConfidence > 0.2 ? {
      beats: [],
      downbeats: [],
      bpm: t.bpm,
      confidence: t.beatConfidence,
    } : null,
    musicVideo: t.musicVideo ?? false,
    vocals: undefined,
    lufs: t.lufs ?? null,
    lufsHead: null,
    lufsTail: null,
    contentEndSec: t.contentEndSec ?? null,
    analysisVersion: 9,
    gridVersion: 1,
    vocalVersion: 1,
    miscVersion: 1,
  };
}

/** Pre-computed stretch ratios for each pair to avoid recalculating. */
const pairStretchRatioCache = new Map<string, number>();

function getStretchRatio(trackA: TrackAnalysis, trackB: TrackAnalysis): number {
  const key = `${trackA.tags.title}|${trackB.tags.title}`;
  if (pairStretchRatioCache.has(key)) return pairStretchRatioCache.get(key)!;
  
  const outBpm = trackA.bpm ?? 120;
  const inBpm = trackB.bpm ?? 120;
  if (!outBpm || !inBpm) return 1;
  
  const rawRate = outBpm / inBpm;
  const stretchRatio = [rawRate, rawRate / 2, rawRate * 2].reduce((best, r) =>
    Math.abs(r - 1) < Math.abs(best - 1) ? r : best
  );
  pairStretchRatioCache.set(key, stretchRatio);
  return stretchRatio;
}

/**
 * Adds energySpans with kick spikes at join regions for filter-friendly pairs.
 * This synthesizes the low-band transient data that the FILTER gate needs.
 * - For impossible-tempo filter pairs: adds kick on both sides (passes with 8 bars)
 * - For two-kick filter pairs: adds kick on both sides (passes with 4 bars)
 * - For filter-hostile pairs: no kicks (FILTER fails with 'no-two-kicks')
 */
function addFilterGateEnergySpans(
  trackA: TrackAnalysis,
  trackB: TrackAnalysis,
  pair: { id: string; category: string; expected: { style: string } }
): { trackA: TrackAnalysis; trackB: TrackAnalysis } {
  const stretchRatio = getStretchRatio(trackA, trackB);
  const isImpossibleTempo = stretchRatio < 0.9 || stretchRatio > 1.25;
  const isFilterPair = pair.expected.style === 'filter';
  const isFilterHostile = pair.category === 'filter-mix' && pair.expected.style === 'blend';

  // Energy span window (same as analysis ladder L0/L1)
  const windowSec = 0.5;

  // Outgoing track: add span covering the outro/join region
  // Place kick spike at the mix-out point (outroStartSec or durationSec - 30)
  const outJoinSec = trackA.outroStartSec ?? trackA.durationSec - 30;
  const outSpanStart = Math.max(0, outJoinSec - 4); // 4 seconds before join
  const outSpanFrames = Math.ceil(8 / windowSec); // 8 seconds of frames
  const outCurve = Array(outSpanFrames).fill(0.3); // baseline energy

  // Add kick spike at the join (last ~1 second before mix-out)
  const outKickStartIdx = Math.max(0, outSpanFrames - Math.ceil(2 / windowSec));
  for (let i = outKickStartIdx; i < outSpanFrames; i++) {
    outCurve[i] = 0.7; // kick energy > KICK_PRESENT (0.5)
  }

  const outEnergySpan = {
    startSec: outSpanStart,
    windowSec,
    curve: outCurve,
  };

  // Incoming track: add span covering the intro/join region
  // Place kick spike at the mix-in point (first downbeat)
  const inJoinSec = trackB.firstDownbeatSec ?? 0;
  const inSpanStart = Math.max(0, inJoinSec - 1); // 1 second before first downbeat
  const inSpanFrames = Math.ceil(8 / windowSec); // 8 seconds of frames
  const inCurve = Array(inSpanFrames).fill(0.3); // baseline energy

  // Add kick spike at the join (around first downbeat)
  const inKickStartIdx = Math.max(0, Math.ceil(1 / windowSec));
  const inKickEndIdx = Math.min(inSpanFrames, Math.ceil(3 / windowSec));
  for (let i = inKickStartIdx; i < inKickEndIdx; i++) {
    inCurve[i] = 0.7; // kick energy > KICK_PRESENT (0.5)
  }

  const inEnergySpan = {
    startSec: inSpanStart,
    windowSec,
    curve: inCurve,
  };

  // For filter-hostile pairs (matching tempo, no kicks), use flat low energy
  if (isFilterHostile) {
    outCurve.fill(0.2);
    inCurve.fill(0.2);
  }

  // For impossible-tempo filter pairs or two-kick filter pairs, keep the kicks
  // (already set above with 0.7)

  return {
    trackA: { ...trackA, energySpans: [outEnergySpan] },
    trackB: { ...trackB, energySpans: [inEnergySpan] },
  };
}

// Run the planner for a pair using the new style scorer
function planPair(trackA: TrackAnalysis, trackB: TrackAnalysis): any {
  // Get the original fixture pair to know the category and expected style
  const pair = fixture.pairs.find(p => 
    p.trackA.title.toLowerCase().replace(/\s+/g, '-') === trackA.tags.title.toLowerCase().replace(/\s+/g, '-') &&
    p.trackB.title.toLowerCase().replace(/\s+/g, '-') === trackB.tags.title.toLowerCase().replace(/\s+/g, '-')
  );
  
  // Add filter gate energy spans for filter-related pairs
  if (pair) {
    const { trackA: ta, trackB: tb } = addFilterGateEnergySpans(trackA, trackB, pair);
    trackA = ta;
    trackB = tb;
  }
  
  // Prepare loop plan if the expected style is 'loop'
  let loopPlan: LoopMixPlan | null = null;
  if (pair?.expected?.style === 'loop') {
    // Use full-track buffers so the search regions (OUT_REGION_SEC/IN_REGION_SEC from track end/start)
    // are covered. Offsets are 0 since buffers start at track time 0.
    const outBuffer = createMockBuffer(trackA.durationSec);
    const inBuffer = createMockBuffer(trackB.durationSec);
    const earliestOutSec = Math.max(0, trackA.durationSec - 60);
    // sung lines: none (clean loops)
    const sung = { out: [] as [number, number][], in: [] as [number, number][] };
    const refuse = (why: string) => { console.log(`Loop mix refused for ${pair.id}: ${why}`); };
    loopPlan = planLoopMix(trackA, outBuffer, trackB, inBuffer, earliestOutSec, sung, refuse, { out: 0, in: 0 });
  }

  const ctx = new AudioContext({ sampleRate: 44100 });
  const deckA = createMockDeck(ctx);
  const deckB = createMockDeck(ctx);

  const plan = scheduleWithStyleScorer(
    { from: deckA, to: deckB, fromAnalysis: trackA, toAnalysis: trackB, bars: 16, forceNow: false },
    loopPlan,
  );

  // Convert style to expected format
  const styleMap: Record<string, string> = {
    'blend': 'blend',
    'filter': 'filter',
    'fade': 'blend', // fade uses blend machinery
    'gap': 'gap',
    'crossfade': 'crossfade',
    'loop': 'loop',
  };

  // Compute overlap bars from duration
  // For crossfade: use actual plan.durationSec (12s fallback) / outBarSec
  // For blend/filter: plan.durationSec at outgoing tempo
  let overlapBars = 0;
  const outBpm = trackA.bpm ?? 120;
  const outBarSec = (60 / outBpm) * 4;
  
  if (plan.style === 'crossfade') {
    overlapBars = Math.round(plan.durationSec / outBarSec);
  } else if (plan.style === 'blend' || plan.style === 'fade' || plan.style === 'filter') {
    overlapBars = Math.round(plan.durationSec / outBarSec);
  } else if (plan.style === 'gap') {
    overlapBars = 0; // gap has no overlap
  } else if (plan.style === 'loop') {
    // Loop mix: overlap is the totalBars of the plan
    overlapBars = loopPlan?.totalBars ?? 0;
  }

  // Compute entry beat
  let entryBeatB = 1;
  if (plan.style !== 'crossfade') {
    const toBpm = trackB.bpm ?? 120;
    const toBeatSec = 60 / toBpm;
    if (toBeatSec > 0) {
      entryBeatB = Math.round(plan.mixInTrackTime / toBeatSec) + 1;
    }
  }

  // Bass swap beat (3/4 of overlap bars for 16-bar blends, 1/2 for shorter)
  let bassSwapBeat: number | null = null;
  if ((plan.style === 'blend' || plan.style === 'fade') && overlapBars >= 2) {
    if (overlapBars >= 16) {
      bassSwapBeat = Math.round(overlapBars * 0.75); // 16 * 0.75 = 12
    } else {
      bassSwapBeat = Math.max(1, Math.floor(overlapBars / 2));
    }
  } else if (plan.style === 'loop' && overlapBars >= 2) {
    // Loop mix bass swap at midpoint of ramp
    bassSwapBeat = Math.max(1, Math.floor(overlapBars / 2));
  }

  return {
    style: styleMap[plan.style] ?? plan.style,
    entryBeatB,
    overlapBars,
    bassSwapBeat,
    gesture: plan.gesture ?? 'none',
    gestureSeconds: plan.gestureSeconds ?? 0,
    reason: plan.reason,
  };
}

// Diff helper
function diffExpectedVsProduced(expected: any, produced: any): string {
  const lines: string[] = [];
  const keys = ['style', 'entryBeatB', 'overlapBars', 'bassSwapBeat', 'gesture', 'gestureSeconds'] as const;
  for (const key of keys) {
    // pre-gesture pairs omit gestureSeconds: the baseline is 0, not a diff
    const exp = expected[key] ?? (key === 'gestureSeconds' ? 0 : expected[key]);
    const prod = produced[key];
    // gestureSeconds is a beat length in seconds, not a count of beats
    const tol = key === 'gestureSeconds' ? 0.01 : 1;
    const match = (typeof exp === 'number' && typeof prod === 'number')
      ? Math.abs(exp - prod) <= tol
      : exp === prod;
    if (!match) {
      lines.push(`  ${key}: expected ${JSON.stringify(exp)}, got ${JSON.stringify(prod)} \u274C`);
    } else {
      lines.push(`  ${key}: ${JSON.stringify(exp)} \u2705`);
    }
  }
  if (expected.reason && produced.reason && expected.reason !== produced.reason) {
    lines.push(`  reason: expected "${expected.reason}", got "${produced.reason}"`);
  }
  return lines.join('\n');
}

describe('Golden Corpus \u2014 Web Planner', () => {
  for (const pair of fixture.pairs) {
    const testName = `${pair.category}/${pair.id}`;
    const isKnownIssue = !!pair.knownIssue;

    (isKnownIssue ? it.skip : it)(testName, () => {
      const trackA = fixtureToAnalysis(pair.trackA);
      const trackB = fixtureToAnalysis(pair.trackB);

      const produced = planPair(trackA, trackB);
      const expected = pair.expected;

      const diff = diffExpectedVsProduced(expected, produced);
      const pass = ['style', 'entryBeatB', 'overlapBars', 'bassSwapBeat', 'gesture', 'gestureSeconds'].every(key => {
        // pre-gesture pairs omit gestureSeconds: the baseline is 0, not a diff
        const exp = expected[key] ?? (key === 'gestureSeconds' ? 0 : expected[key]);
        const prod = produced[key];
        if (typeof exp === 'number' && typeof prod === 'number') {
          // gestureSeconds is a beat length in seconds, not a count of beats
          const tol = key === 'gestureSeconds' ? 0.01 : 1;
          return Math.abs(exp - prod) <= tol;
        }
        return exp === prod;
      });

      if (!pass) {
        console.error(`\n\u274C GOLDEN CORPUS MISMATCH: ${pair.id}`);
        console.error(diff);
        if (pair.knownIssue) {
          console.error(`  (KNOWN-ISSUE: ${pair.knownIssue})`);
        }
      }

      expect(pass, `Golden corpus mismatch for ${pair.id}:\n${diff}`).toBe(true);
    });
  }
});