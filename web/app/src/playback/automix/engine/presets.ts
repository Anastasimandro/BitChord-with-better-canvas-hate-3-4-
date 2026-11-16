// BitChord, Automix 2.0 Phase 4 Task B1: named presets.
// Single source of truth for preset -> planOverride mapping.
// No UI in this task; the mapping is used by a debug console command.

import type { TrackAnalysis } from '../analysis/types';

/** Preset names (user-facing). */
export type PresetName = 'Fade' | 'Rise' | 'Blend' | 'Loop';

/** The planOverride each preset expands to. */
export type PlanOverride = NonNullable<TrackAnalysis['manualOverrides']>['planOverride'];

export const PRESET_OVERRIDES: Record<PresetName, PlanOverride> = {
  Fade: { style: 'fade', gesture: 'none' },
  Rise: { style: 'filter', gesture: 'none' },
  Blend: { style: 'blend', gesture: 'none' },
  Loop: { style: 'loop', gesture: 'none' },
};

/** Apply a preset to a track's manualOverrides (per-pair for planOverride). */
export function applyPreset(
  overrides: TrackAnalysis['manualOverrides'] | undefined,
  preset: PresetName,
  isIncoming: boolean,
): TrackAnalysis['manualOverrides'] {
  const base = overrides ?? { bpm: undefined, camelot: undefined, gridNudgeBeats: undefined, planOverride: undefined };
  const presetOverride = PRESET_OVERRIDES[preset];
  if (!presetOverride) return base;

  // planOverride is per-pair, so we apply it to the relevant side's overrides object
  return {
    ...base,
    planOverride: {
      ...(base.planOverride ?? {}),
      ...presetOverride,
    },
  };
}

/** All preset names for iteration/debugging. */
export const ALL_PRESETS: PresetName[] = ['Fade', 'Rise', 'Blend', 'Loop'];

/** Map a preset to its internal style name (for telemetry/display). */
export function presetToStyle(preset: PresetName): string {
  return PRESET_OVERRIDES[preset]?.style ?? 'fade';
}