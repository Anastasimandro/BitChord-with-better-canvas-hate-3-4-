import { describe, expect, it } from 'vitest';
import {
  CHEAP_FPS,
  CHEAP_VOCAL_BOUNDARY,
  cheapVocalOnModelScale,
  cheapVocalRaw,
  cheapVocalWindow,
  uncertainShare,
} from './cheapvocal';

const SR = 44100;

/** A pseudo-random but deterministic noise fill, so the test is reproducible. */
function noise(n: number, seed = 7): Float32Array {
  let s = seed;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (s / 0x3fffffff - 1) * 0.3;
  }
  return out;
}

/**
 * A sung line, synthesized: a harmonic stack at 200 Hz, syllable-gated at
 * ~4 Hz, with a formant bump around 1.2 kHz so the energy sits where a
 * voice's does. Not a voice — the shape a cheap detector must catch:
 * periodic, moving, formant-heavy.
 */
function vocalLike(seconds: number): Float32Array {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  const f0 = 200;
  const formant = (hz: number) => Math.exp(-((Math.log2(hz / 1200) ** 2) / (2 * 1.2 ** 2)));
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const gate = Math.max(0, Math.sin(2 * Math.PI * 4 * t)) ** 0.5;
    let s = 0;
    for (let k = 1; k <= 12; k++) s += (Math.sin(2 * Math.PI * f0 * k * t + k) / k) * formant(f0 * k) * gate;
    out[i] = s * 0.3;
  }
  return out;
}

describe('cheapVocalOnModelScale (the rescale)', () => {
  it('lands its own boundary on the model threshold, exactly', () => {
    expect(cheapVocalOnModelScale(0)).toBe(0);
    expect(cheapVocalOnModelScale(CHEAP_VOCAL_BOUNDARY)).toBeCloseTo(0.25, 10);
    expect(cheapVocalOnModelScale(1)).toBeCloseTo(1, 10);
  });
  it('is linear below and above the boundary, and monotone through it', () => {
    const b = CHEAP_VOCAL_BOUNDARY;
    expect(cheapVocalOnModelScale(b / 2)).toBeCloseTo(0.125, 10);
    expect(cheapVocalOnModelScale(b + (1 - b) / 2)).toBeCloseTo(0.25 + 0.375, 10);
    let prev = -1;
    for (let v = 0; v <= 1.0001; v += 0.01) {
      const mapped = cheapVocalOnModelScale(v);
      expect(mapped).toBeGreaterThanOrEqual(prev);
      prev = mapped;
    }
  });
  it('carries the doubt band onto 0.15-0.35 around the threshold', () => {
    // model 0.15 sits below the threshold (raw 0.6·b), model 0.35 above it
    // (raw b + ((0.35-0.25)/0.75)·(1-b) ≈ 0.4973)
    expect(cheapVocalOnModelScale(0.252)).toBeCloseTo(0.15, 10);
    expect(cheapVocalOnModelScale(0.4973)).toBeCloseTo(0.35, 2);
  });
});

describe('uncertainShare', () => {
  it('counts only the doubt band', () => {
    const raw = new Float32Array([0.1, 0.4, 0.7, 0.95, 0.4]);
    expect(uncertainShare(raw)).toBeCloseTo(0.4, 10);
    expect(uncertainShare(new Float32Array(0))).toBe(0);
  });
});

describe('cheapVocalRaw (the detector)', () => {
  const mean = (v: Float32Array) => v.reduce((a, b) => a + b, 0) / v.length;

  it('orders a sung line above a sustained pad above noise', () => {
    const sung = mean(cheapVocalRaw(vocalLike(4))!);
    const n = SR * 4;
    const pad = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      pad[i] = (Math.sin(2 * Math.PI * 110 * t) + 0.5 * Math.sin(2 * Math.PI * 220 * t) + 0.3 * Math.sin(2 * Math.PI * 330 * t)) * 0.2;
    }
    const padScore = mean(cheapVocalRaw(pad)!);
    const silent = mean(cheapVocalRaw(noise(n))!);
    // the syllabic movement and the formant share are what lift the line:
    // the pad is as periodic as the voice but static, and noise is neither
    expect(sung).toBeGreaterThan(padScore + 0.08);
    expect(padScore).toBeGreaterThan(silent + 0.05);
    expect(silent).toBeLessThan(0.3);
  });

  it('reads a steady pad as NOT sung: periodic but static', () => {
    const n = SR * 4;
    const pad = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      pad[i] = (Math.sin(2 * Math.PI * 110 * t) + 0.5 * Math.sin(2 * Math.PI * 220 * t) + 0.3 * Math.sin(2 * Math.PI * 330 * t)) * 0.2;
    }
    const curve = cheapVocalRaw(pad)!;
    expect(mean(curve)).toBeLessThan(CHEAP_VOCAL_BOUNDARY);
  });

  it('stays silent on a window too short to analyse', () => {
    expect(cheapVocalRaw(new Float32Array(64))).toBeNull();
  });
});

describe('cheapVocalWindow', () => {
  it('produces a model-scale VocalWindow with the cheap source mark', () => {
    const mono = vocalLike(3);
    const made = cheapVocalWindow(mono, mono, 12.5)!;
    expect(made.window.source).toBe('cheap');
    expect(made.window.startSec).toBe(12.5);
    expect(made.window.fps).toBeCloseTo(CHEAP_FPS, 3);
    for (const v of made.window.curve) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(made.uncertain).toBeGreaterThanOrEqual(0);
    expect(made.uncertain).toBeLessThanOrEqual(1);
  });
});
