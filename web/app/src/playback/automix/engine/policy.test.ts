import { describe, expect, it } from 'vitest';
import type { TrackAnalysis, VocalWindow } from '../analysis/types';
import {
  contentEndOf,
  detectGap,
  headView,
  incomingGainCompensation,
  isFalseEnding,
  mixLufsOf,
  mixOutAnchor,
  percentile,
  plannedVocalOverlap,
  tailView,
  trailingSilenceSec,
  VOCAL_ACTIVE,
  VOCAL_OVERLAP_BLEND_GATE,
  vocalShare,
  wholeView,
  type CurveView,
} from './policy';

function analysis(fields: Partial<TrackAnalysis>): TrackAnalysis {
  return {
    fileKey: 'a',
    path: '',
    tags: { title: 'a', artist: '' },
    durationSec: 0,
    bpm: 120,
    beatIntervalSec: 0.5,
    firstDownbeatSec: 0,
    gridConfidence: 0.8,
    camelot: null,
    keyName: null,
    keyConfidence: 0,
    energy: 0.5,
    energyCurve: [],
    introEndSec: 0,
    outroStartSec: null,
    analysisVersion: 9,
    ...fields,
  };
}

/** A CurveView over one curve at one frame size. */
function view(curve: number[], windowSec: number, startSec: number, durationSec: number): CurveView {
  return { curve, windowSec, startSec, endSec: startSec + curve.length * windowSec };
}

describe('percentile', () => {
  it('takes the 60th the way loopMix reads its stretch', () => {
    expect(percentile([3, 1, 4, 1, 5, 9, 2, 6, 5, 3], 0.6)).toBe(5);
    expect(percentile([], 0.6)).toBe(0);
  });
});

describe('curve views', () => {
  it('the whole view is the whole curve at duration/len frames', () => {
    const v = wholeView(analysis({ durationSec: 20, energyCurve: [1, 2, 3, 4] }))!;
    expect(v.startSec).toBe(0);
    expect(v.windowSec).toBe(5);
    expect(v.endSec).toBe(20);
  });
  it('tailView prefers a span that reaches the end, headView one that starts at the top', () => {
    const a = analysis({
      durationSec: 136.5,
      energySpans: [
        { startSec: 0, windowSec: 0.5, curve: [0.2, 0.4, 0.3, 0.5, 0.6, 0.7] },
        { startSec: 135, windowSec: 0.5, curve: [0.6, 0.8, 0.9] },
      ],
    });
    const tail = tailView(a, 8)!;
    expect(tail.startSec).toBe(135);
    expect(tail.curve).toEqual([0.6, 0.8, 0.9]);
    const head = headView(a, 65)!;
    expect(head.startSec).toBe(0);
  });
  it('falls back to the whole curve when no span covers the edge', () => {
    const a = analysis({ durationSec: 200, energyCurve: [0.3, 0.5], energySpans: [{ startSec: 0, windowSec: 0.5, curve: [0.2] }] });
    expect(tailView(a, 8)!.curve).toEqual([0.3, 0.5]);
  });
});

describe('SILENCE TRIM', () => {
  it('anchors a long silent tail at the last audible content', () => {
    const a = analysis({ durationSec: 200, outroStartSec: 150, contentEndSec: 130 });
    expect(mixOutAnchor(a)).toBe(130);
  });
  it('keeps the outro when the tail is short', () => {
    const a = analysis({ durationSec: 200, outroStartSec: 150, contentEndSec: 145 });
    expect(mixOutAnchor(a)).toBe(150);
  });
  it('finds the content end of a curve that decays into silence', () => {
    const curve = [...Array(20).fill(0.8), ...Array(12).fill(0.001)];
    expect(contentEndOf(view(curve, 1, 0, 32), 32, 0.8)).toBe(20);
    expect(trailingSilenceSec(view(curve, 1, 0, 32), 0, 0.04)).toBeCloseTo(12, 5);
  });
  it('reads the content end from an L0 tail span alone, in track time', () => {
    // 65 s of tail at 0.5 s frames, starting at track second 135
    const span = [...Array(120).fill(0.8), ...Array(10).fill(0.001)];
    const a = analysis({ durationSec: 200, energySpans: [{ startSec: 135, windowSec: 0.5, curve: span }] });
    const tail = tailView(a, 8)!;
    expect(contentEndOf(tail, 200, 0.8)).toBeCloseTo(195, 5);
  });
});

describe('FALSE ENDING', () => {
  const curve = (rise: boolean) => [...Array(20).fill(0.9), ...Array(8).fill(0.05), ...(rise ? [0.9, 0.9] : [0.05, 0.05])];
  it('rejects an outro the energy comes back after', () => {
    expect(isFalseEnding(view(curve(true), 1, 0, 30), 20, 30, 0.9)).toBe(true);
  });
  it('keeps a quiet, honest outro', () => {
    expect(isFalseEnding(view(curve(false), 1, 0, 30), 20, 30, 0.9)).toBe(false);
  });
  it('says nothing when there is no room after the outro', () => {
    expect(isFalseEnding(view(curve(true), 1, 0, 30), 29.5, 30, 0.9)).toBe(false);
  });
  it('a rejected outro mixes out at the content end', () => {
    const a = analysis({ durationSec: 30, outroStartSec: null, contentEndSec: 20 });
    expect(mixOutAnchor(a)).toBe(20);
  });
});

describe('GAP', () => {
  const close = analysis({ durationSec: 24, energyCurve: [...Array(16).fill(0.8), ...Array(8).fill(0.05)] });
  it('pairs a melodic close with a rising first downbeat', () => {
    const opener = analysis({
      durationSec: 30,
      firstDownbeatSec: 0.5,
      energyCurve: [0.1, 0.3, 0.5, 0.7],
    });
    expect(detectGap(close, opener)).toBe(true);
  });
  it('refuses an outgoing tail that is still loud', () => {
    const loud = analysis({ durationSec: 24, energyCurve: [...Array(20).fill(0.8), ...Array(4).fill(0.5)] });
    const opener = analysis({ durationSec: 30, firstDownbeatSec: 0.5, energyCurve: [0.1, 0.3, 0.5, 0.7] });
    expect(detectGap(loud, opener)).toBe(false);
  });
  it('refuses an incoming track that does not open', () => {
    const flat = analysis({ durationSec: 30, firstDownbeatSec: 0.5, energyCurve: [0.4, 0.35, 0.3, 0.25] });
    expect(detectGap(close, flat)).toBe(false);
  });
  it('reads both sides from L0 edge spans, no whole curve needed', () => {
    const out = analysis({
      durationSec: 200,
      energySpans: [{ startSec: 135, windowSec: 0.5, curve: [...Array(114).fill(0.8), ...Array(16).fill(0.02)] }],
    });
    const inn = analysis({
      durationSec: 30,
      firstDownbeatSec: 1,
      energySpans: [{ startSec: 0, windowSec: 0.5, curve: [0.1, 0.2, 0.6, 0.8] }],
    });
    expect(detectGap(out, inn)).toBe(true);
  });
});

describe('gain compensation', () => {
  it('sits the incoming deck at lufsOut - lufsIn, capped at +/-6 dB', () => {
    expect(incomingGainCompensation(analysis({ lufs: -20 }), analysis({ lufs: -24 }))).toBeCloseTo(10 ** (4 / 20), 5);
    expect(incomingGainCompensation(analysis({ lufs: -14 }), analysis({ lufs: -8 }))).toBeCloseTo(10 ** (-6 / 20), 5);
    expect(incomingGainCompensation(analysis({ lufs: -8 }), analysis({ lufs: -20 }))).toBeCloseTo(10 ** (6 / 20), 5);
  });
  it('prefers the edge spans over the whole-track masters', () => {
    const out = analysis({ lufs: -10, lufsTail: -16 });
    const inn = analysis({ lufs: -10, lufsHead: -20 });
    // whole-track figures would answer 1.0; the spans the mix crosses are
    // 4 dB apart, and that is the gain the deck sits at
    expect(incomingGainCompensation(out, inn)).toBeCloseTo(10 ** (4 / 20), 5);
  });
  it('stays neutral without a measurement on either side', () => {
    expect(incomingGainCompensation(analysis({}), analysis({ lufs: -14 }))).toBe(1);
    expect(incomingGainCompensation(null, null)).toBe(1);
  });
  it('mixLufsOf reads the side it is asked for', () => {
    const a = analysis({ lufs: -12, lufsHead: -14, lufsTail: -16 });
    expect(mixLufsOf(a, 'tail')).toBe(-16);
    expect(mixLufsOf(a, 'head')).toBe(-14);
    expect(mixLufsOf(null, 'head')).toBeNull();
  });
});

describe('plannedVocalOverlap', () => {
  /** Create a VocalWindow with a simple curve at 10 fps. */
  function vw(startSec: number, curve: number[], fps = 10): VocalWindow {
    return { startSec, fps, curve };
  }

  it('returns null when either side has no vocal windows', () => {
    expect(plannedVocalOverlap([], [vw(0, [0.5])], 0, 10, 0, 1)).toBeNull();
    expect(plannedVocalOverlap([vw(0, [0.5])], [], 0, 10, 0, 1)).toBeNull();
  });

  it('returns null for degenerate windows', () => {
    expect(plannedVocalOverlap([vw(0, [0.5])], [vw(0, [0.5])], 10, 5, 0, 1)).toBeNull();
    expect(plannedVocalOverlap([vw(0, [0.5])], [vw(0, [0.5])], 5, 5, 0, 1)).toBeNull();
  });

  it('returns 0 when no simultaneous vocal (both below threshold)', () => {
    const out = [vw(0, [0.1, 0.1, 0.1])];
    const inn = [vw(0, [0.1, 0.1, 0.1])];
    expect(plannedVocalOverlap(out, inn, 0, 0.3, 0, 1)).toBe(0);
  });

  it('returns 0 when only one side is vocal', () => {
    const out = [vw(0, [0.5, 0.5, 0.5])]; // above 0.25
    const inn = [vw(0, [0.1, 0.1, 0.1])]; // below 0.25
    expect(plannedVocalOverlap(out, inn, 0, 0.3, 0, 1)).toBe(0);
  });

  it('returns 1 when both sides fully vocal at rate 1', () => {
    const out = [vw(0, [0.5, 0.5, 0.5])];
    const inn = [vw(0, [0.5, 0.5, 0.5])];
    expect(plannedVocalOverlap(out, inn, 0, 0.3, 0, 1)).toBe(1);
  });

  it('returns partial fraction when some frames overlap', () => {
    // 3 frames: first 2 both vocal, last 1 only outgoing
    const out = [vw(0, [0.5, 0.5, 0.5])];
    const inn = [vw(0, [0.5, 0.5, 0.1])];
    expect(plannedVocalOverlap(out, inn, 0, 0.3, 0, 1)).toBeCloseTo(2 / 3, 5);
  });

  it('scales incoming window by playbackRate (rate > 1 stretches incoming)', () => {
    // Outgoing 0.3s at 10 fps = 3 frames. Rate 1.25 means incoming covers 0.375s of its own time.
    // If incoming has vocal for 0.375s (3.75 frames at 10 fps), and outgoing has 0.3s vocal,
    // the overlap fraction depends on how the windows align.
    const out = [vw(0, [0.5, 0.5, 0.5])]; // 0.3s vocal
    const inn = [vw(0, [0.5, 0.5, 0.5, 0.5])]; // 0.4s vocal at 10 fps
    // rate=1.25: outgoing 0.3s maps to incoming 0.375s
    // Both fully vocal in their windows -> fraction should be 1
    expect(plannedVocalOverlap(out, inn, 0, 0.3, 0, 1.25)).toBe(1);
  });

  it('rate < 1 compresses incoming window', () => {
    // Rate 0.9: outgoing 0.3s maps to incoming 0.27s
    const out = [vw(0, [0.5, 0.5, 0.5])];
    const inn = [vw(0, [0.5, 0.5, 0.5])];
    expect(plannedVocalOverlap(out, inn, 0, 0.3, 0, 0.9)).toBe(1);
  });

  it('handles offset incoming start (inStart != 0)', () => {
    const out = [vw(0, [0.5, 0.5, 0.5])]; // vocal at [0, 0.3]
    const inn = [vw(1, [0.5, 0.5, 0.5])]; // vocal at [1, 1.3]
    // Overlap window [0, 0.3] on outgoing maps to [1, 1.3] on incoming at rate=1
    // Both fully vocal -> fraction = 1
    expect(plannedVocalOverlap(out, inn, 0, 0.3, 1, 1)).toBe(1);
  });

  it('unmeasured regions default to neutral 0.5 (below VOCAL_ACTIVE)', () => {
    // Outgoing has vocal for 0.3s, incoming window starts at 0.5s (no overlap in vocal regions)
    const out = [vw(0, [0.5, 0.5, 0.5])];
    const inn = [vw(0, [0.1, 0.1, 0.1])]; // no vocal
    expect(plannedVocalOverlap(out, inn, 0, 0.3, 0, 1)).toBe(0);
  });
});

describe('vocalShare', () => {
  function vw(startSec: number, curve: number[], fps = 10): VocalWindow {
    return { startSec, fps, curve };
  }

  it('returns null for empty windows', () => {
    expect(vocalShare([], 0, 10)).toBeNull();
  });

  it('returns fraction above VOCAL_ACTIVE', () => {
    const w = [vw(0, [0.1, 0.5, 0.5, 0.1])]; // 4 frames, 2 above 0.25
    expect(vocalShare(w, 0, 0.4)).toBe(0.5);
  });

  it('returns 0 when all below threshold', () => {
    const w = [vw(0, [0.1, 0.1, 0.1])];
    expect(vocalShare(w, 0, 0.3)).toBe(0);
  });

  it('returns 1 when all above threshold', () => {
    const w = [vw(0, [0.5, 0.5, 0.5])];
    expect(vocalShare(w, 0, 0.3)).toBe(1);
  });
});
