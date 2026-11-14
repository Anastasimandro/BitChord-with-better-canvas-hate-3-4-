// BitChord, Automix 2.0 Phase 1: the per-component versioning of TrackAnalysis.
//
// The old cache key was one ANALYSIS_VERSION for the whole record: a vocal
// improvement threw away every grid, a grid fix re-ran the vocal model. The
// ladder made that expensive — an L0 recompute is on the critical path of the
// transition — so validity moved onto the record itself: one version per
// component, checked (and stamped) component by component. A bump here costs
// only its own fields.
//
// The components, and the fields each one owns:
// - grid:   headBeats/tailBeats, bpm/beatIntervalSec/firstDownbeatSec/
//           gridConfidence, tailGrid — Beat This! over the two edge windows
//           (essentia's fallback grids ride with it). Filled at L0.
// - vocal:  vocals — the vocal curves over the edges, from the cheap
//           detector (L2) or open-unmix (L3). Stamped by whichever filled it.
// - misc:   energySpans, energyCurve, energy, introEndSec/outroStartSec,
//           contentEndSec, the LUFS fields, camelot/keyName/keyConfidence,
//           lufs of the whole track. L0 fills the edge half (spans, edge
//           loudness, content end, intro/outro of the windows); L3 completes
//           it (whole-track curve, key, whole-track LUFS) and stamps the
//           version — the stamp means "the component is whole".
//
// musicVideo is NOT a component: it comes from the fetch (whether YouTube
// served a video), and it is re-derived every time the audio is fetched.

import type { TrackAnalysis } from './types';
import { ANALYSIS_VERSION } from './types';

export const GRID_VERSION = 1;
export const VOCAL_VERSION = 1;
export const MISC_VERSION = 1;

/** The versions this build computes. A component missing from a stored record reads as 0. */
export const COMPONENT_VERSIONS = { grid: GRID_VERSION, vocal: VOCAL_VERSION, misc: MISC_VERSION } as const;

export type ComponentName = keyof typeof COMPONENT_VERSIONS;

/**
 * Which analysis versions computed the vocal component in its current
 * meaning. The mask widened to the loop searches at 7; a curve from 6 or
 * older doesn't cover what maskStats now reads, so it is recomputed.
 */
const VOCAL_VALID_SINCE = 7;
/** The loudness fields and contentEndSec arrived at 9 (Phase 0). */
const MISC_LOUDNESS_SINCE = 9;

/**
 * The components a stored record already holds valid data for, so the
 * migrator can stamp them instead of recomputing. A cached record from the
 * monolithic era computed everything at once; its fields are kept field by
 * field, and only what is genuinely missing (or too old to trust) is left
 * for the ladder to fill.
 */
export function heldComponents(a: TrackAnalysis): Set<ComponentName> {
  const held = new Set<ComponentName>();
  // The grid component is whole when BOTH mixable edges are measured: the
  // head the track is mixed in on and the tail it is mixed out of. A head
  // alone is a legitimate mid-ladder state — and it must not read as done.
  const hasHead = (a.headBeats != null && a.headBeats.beats.length >= 2) || (a.bpm != null && a.gridConfidence > 0);
  const hasTail = (a.tailBeats != null && a.tailBeats.beats.length >= 2) || a.tailGrid != null;
  if (hasHead && hasTail) held.add('grid');
  // An empty vocals array is what a record where the model couldn't run
  // stores — a completed measurement of "none", not a missing one, and it holds.
  if (a.vocals != null && a.analysisVersion >= VOCAL_VALID_SINCE) held.add('vocal');
  const hasLoudness = a.lufs != null || a.lufsHead != null || a.lufsTail != null;
  const hasStructure = a.energyCurve.length > 0 || (a.energySpans?.length ?? 0) > 0;
  // The misc stamp means "whole": a monolithic record holds all of it, a
  // ladder-only record holds its edge half and keeps its stamp at 0. A
  // pre-9 record held the structure half (its curve) before loudness
  // existed — structure alone still holds.
  if (hasLoudness && hasStructure) held.add('misc');
  else if (a.analysisVersion < MISC_LOUDNESS_SINCE && hasStructure) held.add('misc');
  return held;
}

/**
 * [a] with its held components stamped, ready to be served from cache and
 * topped up by the ladder. Returns the record unchanged when everything is
 * already stamped (the common case after the first visit).
 */
export function adoptCached(a: TrackAnalysis): TrackAnalysis {
  const held = heldComponents(a);
  return {
    ...a,
    analysisVersion: ANALYSIS_VERSION,
    gridVersion: a.gridVersion ?? (held.has('grid') ? GRID_VERSION : 0),
    vocalVersion: a.vocalVersion ?? (held.has('vocal') ? VOCAL_VERSION : 0),
    miscVersion: a.miscVersion ?? (held.has('misc') ? MISC_VERSION : 0),
  };
}

/**
 * What L0 still owes [a]: its edge grids, or its edge spans (energy,
 * loudness, content end, the windows' intro/outro). Per edge: until the grid
 * component is whole, an edge whose evidence isn't on the record is asked
 * for again — across sessions that can mean re-running a head whose tail
 * never landed, which is the honest price of a record that says "partial".
 */
export function needsLevel0(a: TrackAnalysis): boolean {
  return (a.gridVersion ?? 0) < GRID_VERSION || !hasEdgeSpans(a);
}

/** Whether [a]'s head edge (the mix-in side) still owes an L0 measurement. */
export function needsHeadEdge(a: TrackAnalysis): boolean {
  return (a.gridVersion ?? 0) < GRID_VERSION;
}

/** Whether [a]'s tail edge (the mix-out side) still owes an L0 measurement. */
export function needsTailEdge(a: TrackAnalysis): boolean {
  return (a.gridVersion ?? 0) < GRID_VERSION;
}

/** What L3 still owes [a]: the vocal component and the whole-track misc fields. */
export function needsLevel3(a: TrackAnalysis): boolean {
  return (a.vocalVersion ?? 0) < VOCAL_VERSION || (a.miscVersion ?? 0) < MISC_VERSION;
}

/** What L2 still owes [a]: a vocal curve over its edges, from any source. */
export function needsLevel2(a: TrackAnalysis): boolean {
  return (a.vocalVersion ?? 0) < VOCAL_VERSION;
}

/**
 * Whether [a] carries the edge-window energy the gestures read — the spans
 * L0 produces, or the whole-track curve a monolithic analysis stored (which
 * covers the edges too). The difference between "misc is missing" and "misc
 * is mid-ladder": a record with one or the other has had its edge measured,
 * and asking again would only burn the budget.
 */
function hasEdgeSpans(a: TrackAnalysis): boolean {
  return (a.energySpans?.length ?? 0) > 0 || a.energyCurve.length > 0;
}
