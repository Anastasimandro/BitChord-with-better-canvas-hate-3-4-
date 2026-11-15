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
  return {
    ctx,
    gain: { gain: mockAudioParam }, // use mockAudioParam for gain
    eq,
    sweep,
    timeline,
    delay,
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
    energySpans: undefined,
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

// Run the planner for a pair using the new style scorer
function planPair(trackA: TrackAnalysis, trackB: TrackAnalysis): any {
  const ctx = new AudioContext({ sampleRate: 44100 });
  const deckA = createMockDeck(ctx);
  const deckB = createMockDeck(ctx);

  // No loop plan for golden corpus tests
  const loopPlan: LoopMixPlan | null = null;

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
  // For crossfade: 12 seconds at outgoing tempo
  // For blend/filter: plan.durationSec at outgoing tempo
  let overlapBars = 0;
  const outBpm = trackA.bpm ?? 120;
  const outBarSec = (60 / outBpm) * 4;
  
  if (plan.style === 'crossfade') {
    overlapBars = Math.round(12 / outBarSec); // crossfade is always 12 seconds
  } else if (plan.style === 'blend' || plan.style === 'fade' || plan.style === 'filter') {
    overlapBars = Math.round(plan.durationSec / outBarSec);
  } else if (plan.style === 'gap') {
    overlapBars = 0; // gap has no overlap
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
      lines.push(`  ${key}: expected ${JSON.stringify(exp)}, got ${JSON.stringify(prod)} ❌`);
    } else {
      lines.push(`  ${key}: ${JSON.stringify(exp)} ✓`);
    }
  }
  if (expected.reason && produced.reason && expected.reason !== produced.reason) {
    lines.push(`  reason: expected "${expected.reason}", got "${produced.reason}"`);
  }
  return lines.join('\n');
}

describe('Golden Corpus — Web Planner', () => {
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
        console.error(`\n❌ GOLDEN CORPUS MISMATCH: ${pair.id}`);
        console.error(diff);
        if (pair.knownIssue) {
          console.error(`  (KNOWN-ISSUE: ${pair.knownIssue})`);
        }
      }

      expect(pass, `Golden corpus mismatch for ${pair.id}:\n${diff}`).toBe(true);
    });
  }
});