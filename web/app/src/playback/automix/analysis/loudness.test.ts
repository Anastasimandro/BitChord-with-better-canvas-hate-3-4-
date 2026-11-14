import { describe, expect, it } from 'vitest';
import { integratedLufs } from './loudness';

const SR = 44100;

/** A sine of [amp] dBFS at [freq] Hz: amp of 0 dBFS is a full-scale sine. */
function sine(freq: number, dbfs: number, durationSec: number): Float32Array {
  const n = Math.round(durationSec * SR);
  const out = new Float32Array(n);
  const amp = 10 ** (dbfs / 20);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

describe('integratedLufs', () => {
  it('reads a -20 dBFS 997 Hz mono sine as about -23.0 LUFS', () => {
    const lufs = integratedLufs(sine(997, -20, 5), SR)!;
    expect(lufs).toBeGreaterThan(-23.5);
    expect(lufs).toBeLessThan(-22.5);
  });

  it('reads a -40 dBFS sine 20 dB lower than a -20 one', () => {
    const loud = integratedLufs(sine(997, -20, 5), SR)!;
    const quiet = integratedLufs(sine(997, -40, 5), SR)!;
    expect(loud - quiet).toBeCloseTo(20, 1);
  });

  it('digital silence reads null', () => {
    expect(integratedLufs(new Float32Array(SR * 3), SR)).toBeNull();
  });

  it('gating keeps a tone over trailing silence at its level', () => {
    const tone = sine(997, -20, 4);
    const withTail = new Float32Array(tone.length + SR * 4);
    withTail.set(tone);
    const lufs = integratedLufs(withTail, SR)!;
    expect(lufs).toBeGreaterThan(-23.5);
    expect(lufs).toBeLessThan(-22.5);
  });
});
