package com.music.bitchord.playback.smart

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * BitChord, Automix 2.0 Phase 0: every mix decision, recorded and readable.
 *
 * The later phases (analysis ladder, scoring) are decided against real pairs,
 * not intentions, so each planned transition is recorded — style, what was
 * rejected and why, the confidences the gates read — and a skip of the
 * incoming track within the skip window annotates the event it followed.
 * Local only: a JSON file ring of ~500 events beside the analyses, read back
 * by the mix report (PlayerControls' SleeveNerdStats). Nothing leaves the
 * device.
 *
 * Shaped after [AnalysisStore]: a directory resolved lazily through
 * [directoryOf], because the playback service builds its players before it
 * has a base context, and a file ring rather than one file per event,
 * because the report reads the whole span every time. The in-memory ring
 * carries the session when no directory has been set (desktop, early boot):
 * recording never fails, persisting just waits.
 */
object MixTelemetry {

    /** A user advance of the incoming track counts only this long after the handoff. */
    const val TRANSITION_SKIP_WINDOW_SEC = 30.0

    /** Styles as the report prints them; mirrors the web client's own report. */
    const val STYLE_LOOP = "loop"
    const val STYLE_BLEND = "blend"
    const val STYLE_FILTER = "filter"
    const val STYLE_CROSSFADE = "crossfade"
    const val STYLE_GAP = "gap"

    const val OUTCOME_COMPLETED = "completed"
    const val OUTCOME_ABORTED = "aborted"
    const val OUTCOME_IN_FLIGHT = "in-flight"

    private const val MAX_EVENTS = 500
    private const val DIRECTORY = "mix_telemetry"
    private const val FILE_NAME = "automix_events.json"

    /**
     * Where the ring is kept, resolved lazily on first persist, for the same
     * reason [AnalysisStore] resolves its directory late: a field
     * initializer on the service runs before the service has a base context.
     * Null — desktop, or a test — keeps the ring in memory only.
     */
    @Volatile
    var directoryOf: (() -> File)? = null

    @Serializable
    data class RejectedStyle(
        val style: String,
        /** The gate that killed the candidate, in the plan's own words. */
        val reason: String,
    )

    @Serializable
    data class MixConfidences(
        val outGrid: Double,
        val inGrid: Double,
        val vocalOverlap: Double? = null,
        val deltaTempoPct: Double? = null,
        val deltaLufs: Double? = null,
    )

    @Serializable
    data class TransitionEvent(
        /** Wall-clock ms the plan was scheduled. */
        val at: Long,
        /** "outId>inId": outgoing > incoming. */
        val pair: String,
        val styleChosen: String,
        val rejectedStylesAndWhy: List<RejectedStyle> = emptyList(),
        /** The plan's own reason field (why the pair wasn't beatmatched, etc.). */
        val reason: String? = null,
        val confidences: MixConfidences,
        /**
         * Both songs' analyses were ready with usable grids when the mix was
         * planned — the analysis race Phase 1 fixes, counted per event.
         */
        val bothGridsReady: Boolean = false,
        var outcome: String = OUTCOME_IN_FLIGHT,
        /** Seconds from handoff to the user advancing the incoming track, or null. */
        var skipAfterSec: Double? = null,
        /** Wall-clock ms of the handoff; null when the mix aborted before it. */
        var handedOffAt: Long? = null,
    )

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    private val lock = Any()
    private val events = ArrayDeque<TransitionEvent>()
    /** The most recent planned transition still in flight, patched by the skip hook. */
    private var openEvent: TransitionEvent? = null
    /** The ring is read back from disk on first use, once [directoryOf] can answer. */
    private var loadedFromDisk = false

    private fun file(): File? = directoryOf?.invoke()?.let { File(it, DIRECTORY).apply { mkdirs() } }

    private fun persistLocked() {
        val target = file() ?: return
        runCatching {
            val temporary = File(target, "$FILE_NAME.tmp")
            try {
                temporary.writeText(json.encodeToString(Events.serializer(), Events(events.toList())))
                // Atomic where the filesystem allows it, replacing where it
                // does not — see AnalysisStore.moveInto for the Windows note.
                try {
                    Files.move(
                        temporary.toPath(),
                        File(target, FILE_NAME).toPath(),
                        StandardCopyOption.ATOMIC_MOVE,
                        StandardCopyOption.REPLACE_EXISTING,
                    )
                } catch (_: java.nio.file.AtomicMoveNotSupportedException) {
                    Files.move(
                        temporary.toPath(),
                        File(target, FILE_NAME).toPath(),
                        StandardCopyOption.REPLACE_EXISTING,
                    )
                }
            } finally {
                temporary.delete()
            }
        }
    }

    /** Reads the ring back once, on first use rather than at class init: the
     * directory only becomes answerable after the service has set it, and an
     * object initializer runs before any assignment the first touch makes. */
    private fun ensureLoadedLocked() {
        if (loadedFromDisk) return
        loadedFromDisk = true
        runCatching {
            val target = file()?.let { File(it, FILE_NAME) } ?: return
            if (!target.exists()) return
            val stored = json.decodeFromString(Events.serializer(), target.readText()).events
            events.clear()
            events.addAll(stored.takeLast(MAX_EVENTS))
        }
    }

    @Serializable
    private data class Events(val events: List<TransitionEvent>)

    init {
        // Read the ring back once. A missing or unreadable file is an empty
        // ring, not an error: the session keeps recording either way.
        runCatching {
            val f = file() ?: return@runCatching
            val target = File(f, FILE_NAME)
            if (!target.exists()) return@runCatching
            val stored = json.decodeFromString(Events.serializer(), target.readText()).events
            synchronized(lock) {
                events.clear()
                events.addAll(stored.takeLast(MAX_EVENTS))
            }
        }
    }

    /**
     * Records a planned transition, in flight. The caller keeps the returned
     * event and closes it with [complete]; a skip annotated before that
     * rides along on the same object.
     */
    fun record(event: TransitionEvent) {
        synchronized(lock) {
            ensureLoadedLocked()
            if (openEvent === event) openEvent = null
            events.addLast(event)
            while (events.size > MAX_EVENTS) events.removeFirst()
            persistLocked()
        }
    }

    /** The mix handed over to [event]'s incoming track: opens the skip window. */
    fun markHandoff(event: TransitionEvent) {
        synchronized(lock) {
            event.handedOffAt = System.currentTimeMillis()
            openEvent = event
            persistLocked()
        }
    }

    /** The mix ended, one way or the other. */
    fun complete(event: TransitionEvent, outcome: String) {
        synchronized(lock) {
            event.outcome = outcome
            if (openEvent === event) openEvent = null
            persistLocked()
        }
    }

    /**
     * The user advanced the current track on purpose. If it is the incoming
     * track of a recent handoff, inside the window, that transition gets
     * skipAfterSec. Nothing more: Phase 0 records, it does not score.
     */
    fun annotateSkip(mediaId: String, nowMs: Long = System.currentTimeMillis()) {
        if (mediaId.isBlank()) return
        synchronized(lock) {
            ensureLoadedLocked()
            fun patch(event: TransitionEvent): Boolean {
                if (event.skipAfterSec != null || event.handedOffAt == null) return false
                if (nowMs - event.handedOffAt!! > TRANSITION_SKIP_WINDOW_SEC * 1000) return false
                if (!event.pair.endsWith(">$mediaId")) return false
                event.skipAfterSec = (nowMs - event.handedOffAt!!) / 1000.0
                return true
            }
            val open = openEvent
            if (open != null && patch(open)) {
                persistLocked()
                return
            }
            // Already closed: patch the recent stored events.
            for (event in events.asReversed().take(5)) {
                if (patch(event)) {
                    persistLocked()
                    return
                }
            }
        }
    }

    fun load(): List<TransitionEvent> = synchronized(lock) {
        ensureLoadedLocked()
        events.toList()
    }

    // ---- The mix report ------------------------------------------------------

    data class StyleStat(
        val style: String,
        val count: Int,
        /** Events with a skip / completed events of the style, or null with none completed. */
        val skipRate: Double?,
    )

    data class ReportStats(
        /** All events in the span, completed and aborted. */
        val total: Int,
        val completed: Int,
        val styles: List<StyleStat>,
        /** The plan's degradation reasons, most common first. */
        val topReasons: List<Pair<String, Int>>,
        /** Share of events planned with both grids ready: the analysis race. */
        val hitRate: Double,
    )

    fun aggregate(all: List<TransitionEvent>): ReportStats {
        val completed = all.filter { it.outcome == OUTCOME_COMPLETED }
        val byStyle = all.groupBy { it.styleChosen }
        val styles = byStyle.entries
            .map { (style, list) ->
                val done = list.filter { it.outcome == OUTCOME_COMPLETED }
                val skipped = done.count { it.skipAfterSec != null }
                StyleStat(style, list.size, if (done.isNotEmpty()) skipped.toDouble() / done.size else null)
            }
            .sortedByDescending { it.count }
        val reasons = LinkedHashMap<String, Int>()
        for (event in completed) {
            for (reason in listOfNotNull(event.reason) + event.rejectedStylesAndWhy.map { it.reason }) {
                if (reason.isBlank()) continue
                reasons[reason] = (reasons[reason] ?: 0) + 1
            }
        }
        val ready = all.count { it.bothGridsReady }
        return ReportStats(
            total = all.size,
            completed = completed.size,
            styles = styles,
            topReasons = reasons.entries.sortedByDescending { it.value }.take(5).map { it.key to it.value },
            hitRate = if (all.isNotEmpty()) ready.toDouble() / all.size else 0.0,
        )
    }

    /** The whole ring, aggregated: what the mix report prints. */
    fun report(): ReportStats = aggregate(load())
}
