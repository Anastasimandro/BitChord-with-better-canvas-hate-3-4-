// Phase 2 Task 5: unit tests for strict skip cap (first downbeat entry)

import { describe, it, expect, vi } from 'vitest';

// Mock AudioContext for happy-dom
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
import { scheduleTransition, scheduleFilterMix, INCOMING_MAX_ADVANCE_BARS, MAX_INCOMING_SKIP_FRACTION } from './transition-scheduler';
import { gridOf } from './grid';

// Minimal mock Deck
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
  return {
    ctx,
    gain: { gain: mockAudioParam },
    eq,
    sweep,
    timeline,
    expectedTrackTime: 0,
    scheduleAhead: 0.1,
    playAt: () => { },
    pauseAt: () => { },
    setRate: () => { },
    setVolume: () => { },
  };
}

function makeAnalysis(overrides: Partial<TrackAnalysis> = {}): TrackAnalysis {
  const bpm = overrides.bpm ?? 120;
  const beatIntervalSec = 60 / bpm;
  const barSec = beatIntervalSec * 4;
  const firstDownbeatSec = overrides.firstDownbeatSec ?? 1.0; // 1s in
  const durationSec = overrides.durationSec ?? 240; // 4 minutes
  const introEndSec = overrides.introEndSec ?? 30; // full energy at 30s (~7.5 bars)
  const gridConfidence = overrides.gridConfidence ?? 0.8;

  // Create a head energy span with low energy for first 3s, then rising
  // This simulates a track that starts quiet for 3 seconds
  const energySpans = overrides.energySpans ?? [{
    startSec: 0,
    windowSec: 0.5,
    // 6 frames of low energy (0.1), then rising
    curve: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.3, 0.5, 0.7, 0.8, 0.9, 1.0],
  }];

  // Head beats: downbeats at 1s, 5s, 9s, 13s, 17s, 21s, 25s, 29s (every 4s = 1 bar at 120 BPM)
  const headBeats = {
    beats: [],
    downbeats: [1.0, 5.0, 9.0, 13.0, 17.0, 21.0, 25.0, 29.0],
    bpm,
    confidence: 0.9,
  };

  return {
    fileKey: 'test',
    path: '/mock/test.mp3',
    tags: { title: 'Test', artist: 'Test', album: '' },
    durationSec,
    bpm,
    beatIntervalSec,
    firstDownbeatSec,
    gridConfidence,
    camelot: null,
    keyName: null,
    keyConfidence: 0,
    energy: 0.5,
    energyCurve: [],
    energySpans,
    introEndSec,
    outroStartSec: durationSec - 30,
    tailGrid: {
      bpm,
      beatIntervalSec,
      firstDownbeatSec: durationSec - 30,
      gridConfidence,
    },
    headBeats,
    tailBeats: headBeats,
    musicVideo: false,
    vocals: undefined,
    lufs: -14,
    lufsHead: -14,
    lufsTail: -14,
    contentEndSec: durationSec - 5,
    analysisVersion: 9,
    gridVersion: 1,
    vocalVersion: 1,
    miscVersion: 1,
    manualOverrides: {},
    ...overrides,
  };
}

describe('Phase 2 Task 5 — Strict Skip Cap', () => {
  const ctx = new AudioContext({ sampleRate: 44100 });
  const deckA = createMockDeck(ctx);
  const deckB = createMockDeck(ctx);

  it('constants are defined correctly', () => {
    expect(INCOMING_MAX_ADVANCE_BARS).toBe(8);
    expect(MAX_INCOMING_SKIP_FRACTION).toBe(0.25);
  });

  it('entry caps at firstDownbeat + 8 bars even when full energy is at 20 bars', () => {
    // Track with full energy at ~20 bars (80s at 120 BPM), first downbeat at 1s
    const trackA = makeAnalysis({ durationSec: 240, introEndSec: 80, firstDownbeatSec: 1.0 });
    const trackB = makeAnalysis({ durationSec: 240, introEndSec: 80, firstDownbeatSec: 1.0 });

    const plan = scheduleTransition({ from: deckA, to: deckB, fromAnalysis: trackA, toAnalysis: trackB, bars: 16 });

    const toGrid = gridOf(trackB)!;
    const barSec = toGrid.barSec;
    const firstDownbeat = trackB.firstDownbeatSec!;
    const maxEntry = firstDownbeat + INCOMING_MAX_ADVANCE_BARS * barSec;

    // Entry should be at or near first downbeat (1s), capped at +8 bars (1s + 32s = 33s)
    // NOT at full energy (80s)
    expect(plan.mixInTrackTime).toBeLessThanOrEqual(maxEntry);
    expect(plan.mixInTrackTime).toBeGreaterThanOrEqual(firstDownbeat);
    // Should be close to first downbeat (0-2 bars advance per acceptance criteria)
    expect(plan.mixInTrackTime - firstDownbeat).toBeLessThanOrEqual(2 * barSec + 0.1); // allow small tolerance
  });

  it('entry never lands on a silent downbeat (skips >2s low-energy span)', () => {
    // Track with first 3 seconds being low energy (silence)
    // First downbeat at 1s is in low-energy span (>2s), so should skip to 5s
    const trackA = makeAnalysis({ durationSec: 240, introEndSec: 30, firstDownbeatSec: 1.0 });
    const trackB = makeAnalysis({
      durationSec: 240,
      introEndSec: 30,
      firstDownbeatSec: 1.0,
      energySpans: [{
        startSec: 0,
        windowSec: 0.5,
        // First 6 frames (3s) at 0.1 (low), then rising
        curve: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.3, 0.5, 0.7, 0.8, 0.9, 1.0],
      }],
      headBeats: {
        beats: [],
        downbeats: [1.0, 5.0, 9.0, 13.0, 17.0, 21.0, 25.0, 29.0],
        bpm: 120,
        confidence: 0.9,
      },
    });

    const plan = scheduleTransition({ from: deckA, to: deckB, fromAnalysis: trackA, toAnalysis: trackB, bars: 16 });

    // First downbeat (1s) is in >2s low-energy span, so entry should be at 5s (next downbeat)
    expect(plan.mixInTrackTime).toBeGreaterThanOrEqual(4.9); // ~5s
    expect(plan.mixInTrackTime).toBeLessThanOrEqual(5.1);
  });

  it('filter mix also uses first audible downbeat with caps', () => {
    const trackA = makeAnalysis({ durationSec: 240, gridConfidence: 0.8 });
    const trackB = makeAnalysis({ durationSec: 240, gridConfidence: 0.1, introEndSec: 80 }); // low incoming confidence -> filter mix

    const fromGrid = gridOf(trackA)!;
    const plan = scheduleFilterMix(
      { from: deckA, to: deckB, fromAnalysis: trackA, toAnalysis: trackB, bars: 16 },
      ctx.currentTime + 0.2,
      fromGrid,
      null,
      'next song has no beat grid'
    );

    const toGrid = gridOf(trackB);
    if (toGrid) {
      const barSec = toGrid.barSec;
      const firstDownbeat = trackB.firstDownbeatSec!;
      const maxEntry = firstDownbeat + INCOMING_MAX_ADVANCE_BARS * barSec;

      expect(plan.mixInTrackTime).toBeLessThanOrEqual(maxEntry);
      expect(plan.mixInTrackTime).toBeGreaterThanOrEqual(firstDownbeat);
    }
  });

  it('entry respects 25% duration cap', () => {
    // Very short track: 30s duration, 25% = 7.5s, 8 bars at 120 BPM = 16s
    // Cap should be 7.5s (25% duration)
    const trackA = makeAnalysis({ durationSec: 30, introEndSec: 20, firstDownbeatSec: 1.0 });
    const trackB = makeAnalysis({ durationSec: 30, introEndSec: 20, firstDownbeatSec: 1.0 });

    const plan = scheduleTransition({ from: deckA, to: deckB, fromAnalysis: trackA, toAnalysis: trackB, bars: 16 });

    const firstDownbeat = trackB.firstDownbeatSec!;
    const maxEntryByFraction = firstDownbeat + MAX_INCOMING_SKIP_FRACTION * trackB.durationSec; // 1 + 7.5 = 8.5s
    expect(plan.mixInTrackTime).toBeLessThanOrEqual(maxEntryByFraction + 0.1);
  });
});