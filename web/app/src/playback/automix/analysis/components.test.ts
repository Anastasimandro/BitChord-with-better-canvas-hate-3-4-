import { describe, expect, it } from 'vitest';
import type { TrackAnalysis } from './types';
import { GRID_VERSION, MISC_VERSION, VOCAL_VERSION, adoptCached, needsHeadEdge, needsLevel0, needsLevel2, needsLevel3 } from './components';

function analysis(fields: Partial<TrackAnalysis>): TrackAnalysis {
  return {
    fileKey: 'a',
    path: '',
    tags: { title: 'a', artist: '' },
    durationSec: 200,
    bpm: 120,
    beatIntervalSec: 0.5,
    firstDownbeatSec: 0,
    gridConfidence: 0.8,
    camelot: null,
    keyName: null,
    keyConfidence: 0,
    energy: 0.5,
    energyCurve: [],
    introEndSec: null,
    outroStartSec: null,
    analysisVersion: 9,
    ...fields,
  };
}

describe('adoptCached (the per-component migration)', () => {
  it('stamps a monolithic record wholesale: no component is re-analysed', () => {
    const full = analysis({
      headBeats: { beats: [0, 0.5, 1], downbeats: [0], bpm: 120, confidence: 0.8 },
      tailBeats: { beats: [199, 199.5], downbeats: [199], bpm: 120, confidence: 0.8 },
      tailGrid: { bpm: 120, beatIntervalSec: 0.5, firstDownbeatSec: 199, gridConfidence: 0.8 },
      energyCurve: [0.5, 0.6],
      lufs: -14,
      lufsHead: -14,
      lufsTail: -15,
      vocals: [{ startSec: 0, fps: 43, curve: [0.1] }],
    });
    const adopted = adoptCached(full);
    expect(adopted.gridVersion).toBe(GRID_VERSION);
    expect(adopted.vocalVersion).toBe(VOCAL_VERSION);
    expect(adopted.miscVersion).toBe(MISC_VERSION);
    expect(needsLevel0(adopted)).toBe(false);
    expect(needsLevel3(adopted)).toBe(false);
  });

  it('does not stamp the grid on a head-only record: the tail is still owed', () => {
    const partial = analysis({
      headBeats: { beats: [0, 0.5, 1], downbeats: [0], bpm: 120, confidence: 0.8 },
      energySpans: [{ startSec: 0, windowSec: 0.5, curve: [0.5] }],
    });
    const adopted = adoptCached(partial);
    expect(adopted.gridVersion ?? 0).toBeLessThan(GRID_VERSION);
    expect(needsLevel0(adopted)).toBe(true);
    // and it is stamped as needing the tail edge, not the head again, once
    // the session's own bookkeeping has the head
    expect(needsHeadEdge(adopted)).toBe(true);
  });

  it('recomputes a pre-v7 vocal mask: its coverage changed under it', () => {
    const old = analysis({
      analysisVersion: 6,
      headBeats: { beats: [0, 0.5, 1], downbeats: [0], bpm: 120, confidence: 0.8 },
      tailBeats: { beats: [199, 199.5], downbeats: [199], bpm: 120, confidence: 0.8 },
      energyCurve: [0.5],
      vocals: [{ startSec: 0, fps: 43, curve: [0.1] }],
    });
    const adopted = adoptCached(old);
    expect(adopted.gridVersion).toBe(GRID_VERSION);
    expect((adopted.vocalVersion ?? 0) < VOCAL_VERSION).toBe(true);
    expect(needsLevel2(adopted)).toBe(true);
  });

  it('stamps misc on a pre-9 record that held structure but no loudness', () => {
    const v8 = analysis({
      analysisVersion: 8,
      headBeats: { beats: [0, 0.5, 1], downbeats: [0], bpm: 120, confidence: 0.8 },
      tailBeats: { beats: [199, 199.5], downbeats: [199], bpm: 120, confidence: 0.8 },
      energyCurve: [0.5],
    });
    const adopted = adoptCached(v8);
    expect(adopted.miscVersion).toBe(MISC_VERSION);
  });

  it('leaves an empty record unstamped: the ladder owes it everything', () => {
    const adopted = adoptCached(analysis({}));
    expect(adopted.gridVersion ?? 0).toBeLessThan(GRID_VERSION);
    expect(adopted.vocalVersion ?? 0).toBeLessThan(VOCAL_VERSION);
    expect(adopted.miscVersion ?? 0).toBeLessThan(MISC_VERSION);
    expect(needsLevel0(adopted)).toBe(true);
    expect(needsLevel3(adopted)).toBe(true);
  });

  it('keeps an already-stamped record untouched (the idempotent visit)', () => {
    const stamped = analysis({
      gridVersion: 99, // a FUTURE grid version: newer than this build's
      vocalVersion: 1,
      miscVersion: 1,
    });
    const adopted = adoptCached(stamped);
    expect(adopted.gridVersion).toBe(99);
    // a future version still means "not this build's computation"
    expect(needsLevel0(adopted)).toBe(true);
  });
});
