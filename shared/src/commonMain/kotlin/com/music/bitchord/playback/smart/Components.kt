/*
 * BitChord, Automix 2.0 Phase 1: per-component versioning of [TrackAnalysis].
 *
 * Ported from the web player's analysis/components.ts — same components, same
 * semantics, adapted to this platform's field names. The components, and the
 * fields each one owns:
 *
 * - grid:  headBeats/tailBeats, bpm/beatInterval/firstBeat/beatConfidence,
 *          downbeats, phraseBoundaries — Beat This! over the two edge windows.
 *          Filled at L0.
 * - vocal: vocalWindows/vocalActivityMask/vocalProbability — the vocal curves
 *          over the edges, from the cheap detector (L2) or open-unmix (L3).
 *          Stamped by whichever filled it.
 * - misc:  energyCurve/lowEnergyCurve/levelWindows, the intro/outro/content
 *          times, the mix candidates, the LUFS fields, key. L0 fills the edge
 *          half (edge loudness, edge structure, content end, the windows'
 *          intro/outro); L3 completes it (whole-track curve, key, whole-track
 *          loudness) and stamps the version — the stamp means "the component
 *          is whole".
 */

package com.music.bitchord.playback.smart

import kotlin.math.min

/** The versions this build computes. A component missing from a stored record reads as 0. */
object Components {
    const val GRID_VERSION = 1
    const val VOCAL_VERSION = 1
    const val MISC_VERSION = 1

    /**
     * The analysis versions that computed the loudness half of misc in its
     * current meaning (Phase 0). A record stamped below this holds structure
     * alone — which still holds: the stamp below only means "whole" at [ANALYSIS_VERSION].
     */
    const val MISC_LOUDNESS_SINCE = TrackAnalysis.ANALYSIS_VERSION

    /**
     * Which components a stored record already holds valid data for, so the
     * migrator can stamp them instead of recomputing. A cached record from the
     * monolithic era computed everything at once; its fields are kept field by
     * field, and only what is genuinely missing is left for the ladder to fill.
     */
    fun held(a: TrackAnalysis): Set<String> {
        val held = HashSet<String>()
        // The grid component is whole when BOTH mixable edges are measured: the
        // head the track is mixed in on and the tail it is mixed out of. A head
        // alone is a legitimate mid-ladder state — and it must not read as done.
        val hasHead = (a.headBeats?.beats?.size ?: 0) >= 2 || (a.bpm > 0 && a.beatConfidence > 0)
        val hasTail = (a.tailBeats?.beats?.size ?: 0) >= 2
        if (hasHead && hasTail) held += "grid"
        // An empty vocalWindows list is what a record where the model couldn't
        // run stores — a completed measurement of "none", not a missing one,
        // and it holds. The phone never shipped a different vocal meaning, so
        // unlike the web there is no since-version gate here.
        if (a.vocalWindows.isNotEmpty()) held += "vocal"
        val hasLoudness = a.lufs != null || a.lufsHead != null || a.lufsTail != null
        val hasStructure = a.energyCurve.isNotEmpty() || a.levelWindows.isNotEmpty()
        // The misc stamp means "whole": a monolithic record holds all of it, a
        // ladder-only record holds its edge half and keeps its stamp at 0. A
        // pre-loudness record held the structure half before LUFS existed —
        // structure alone still holds.
        if (hasLoudness && hasStructure) held += "misc"
        else if (a.analysisVersion < MISC_LOUDNESS_SINCE && hasStructure) held += "misc"
        return held
    }

    /**
     * [a] with its held components stamped, ready to be served from cache and
     * topped up by the ladder. Returns the record unchanged when everything is
     * already stamped (the common case after the first visit).
     */
    fun adopt(a: TrackAnalysis): TrackAnalysis {
        val held = held(a)
        if (held == setOf("grid", "vocal", "misc") &&
            a.analysisVersion == TrackAnalysis.ANALYSIS_VERSION &&
            a.gridVersion >= GRID_VERSION && a.vocalVersion >= VOCAL_VERSION && a.miscVersion >= MISC_VERSION
        ) {
            return a
        }
        return a.copy(
            analysisVersion = TrackAnalysis.ANALYSIS_VERSION,
            gridVersion = if (held.contains("grid")) GRID_VERSION else min(a.gridVersion, GRID_VERSION),
            vocalVersion = if (held.contains("vocal")) VOCAL_VERSION else min(a.vocalVersion, VOCAL_VERSION),
            miscVersion = if (held.contains("misc")) MISC_VERSION else min(a.miscVersion, MISC_VERSION),
        )
    }

    /**
     * What L0 still owes [a]: its edge grids, or its edge structure (the level
     * windows and loudness the gestures read). Per edge: until the grid
     * component is whole, an edge whose evidence isn't on the record is asked
     * for again — across sessions that can mean re-running a head whose tail
     * never landed, which is the honest price of a record that says "partial".
     */
    fun needsLevel0(a: TrackAnalysis): Boolean =
        a.gridVersion < GRID_VERSION || !hasEdgeEvidence(a)

    /** Whether [a]'s head edge (the mix-in side) still owes an L0 measurement. */
    fun needsHeadEdge(a: TrackAnalysis): Boolean = a.gridVersion < GRID_VERSION

    /** Whether [a]'s tail edge (the mix-out side) still owes an L0 measurement. */
    fun needsTailEdge(a: TrackAnalysis): Boolean = a.gridVersion < GRID_VERSION

    /** What L2 still owes [a]: a vocal curve over its edges, from any source. */
    fun needsLevel2(a: TrackAnalysis): Boolean = a.vocalVersion < VOCAL_VERSION

    /** What L3 still owes [a]: the vocal component and the whole-track misc fields. */
    fun needsLevel3(a: TrackAnalysis): Boolean =
        a.vocalVersion < VOCAL_VERSION || a.miscVersion < MISC_VERSION

    /**
     * Whether [a] carries the edge evidence the gestures read — the level
     * windows L0 produces, or the whole-track curve a monolithic analysis
     * stored (which covers the edges too). The difference between "misc is
     * missing" and "misc is mid-ladder": a record with one or the other has
     * had an edge measured, and asking again would only burn the budget.
     */
    private fun hasEdgeEvidence(a: TrackAnalysis): Boolean =
        a.levelWindows.isNotEmpty() || a.energyCurve.isNotEmpty()
}
