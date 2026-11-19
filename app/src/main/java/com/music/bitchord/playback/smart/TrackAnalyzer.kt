package com.music.bitchord.playback.smart

import android.content.ContentResolver
import android.media.AudioDecoder
import android.net.Uri
import android.os.SystemClock
import android.util.Log
import androidx.concurrent.futures.CallbackToFutureAdapter
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import com.music.bitchord.data.LocalAudioSource
import com.music.bitchord.data.settings.TrackAnalysisState
import com.music.bitchord.data.settings.AppSettings
import com.music.bitchord.playback.AudioCache
import com.music.bitchord.playback.loopmix.LoopMixPort
import com.music.bitchord.playback.loopmix.LoopRegion
import com.music.bitchord.playback.loopmix.MixWaveform
import com.music.bitchord.data.model.Song
import com.music.bitchord.data.model.BrowseType
import com.music.bitchord.data.spotify.SpotifyMatch
import com.music.bitchord.data.YtMusicRepository
import com.music.bitchord.data.spotify.SourceResolver
import com.music.bitchord.data.model.TrackMatcher
import com.music.bitchord.data.canvas.AutomixAnalysisSource
import com.music.bitchord.data.canvas.CanvasRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.Locale
import java.util.concurrent.Executors
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * BitChord, Automix 2.0 — track analysis engine.
 *
 * Every track played gets analysed exactly once, on a background executor,
 * and the results are cached in a concurrent map keyed by the track id.
 *
 * The analysis is split into two passes that both run on the same executor:
 *
 * Pass 1 (Phase 1, DSP-only): the analyzer needs the whole track — the energy
 * curve, phrase structure and mix-out anchor all read the tail, not just a
 * window of it — at its own low sample rate, so this is a much smaller decode
 * than a full-rate pass would be.
 *
 * In a frame of its own, and handing back only the features, because of what
 * it allocates to get them: the whole track decoded to mono at the container's
 * rate (35 MB for a 3.5-minute song) plus the resampled copy the DSP reads
 * (8 MB). Neither is touched again after this line, but a local holding either
 * stays reachable to the end of the method, and the rest of the method is
 * Pass 2 — the most allocation-heavy part of the analysis. Measured on the
 * API 28 emulator: those two buffers were 43 MB of an 82 MB live set, still
 * held while the models ran, in a process that was reaching a 256 MB heap
 * limit and had died on it. Returning is what releases them — a `val` cannot
 * be nulled, and a narrower scope alone does not make ART treat one as dead.
 *
 * Pass 2 (Phases 2 and 3, models): the Beat This! grid and the open-unmix
 * vocal mask, over the opening and the ending only. A transition only ever
 * reads the tail of the outgoing track and the head of the incoming one, and
 * a track is both of those at different moments, so the middle is never
 * decoded for this. Both models read the same decoded window, so its stereo
 * buffer is paid for once. The spans match the loop mix's searches: its
 * incoming loop is looked for in the first 45 s, its outgoing one in the last
 * 60.
 *
 * Concurrency:
 *
 * [results] is a concurrent map holding every finished analysis; it is read
 * by the playback thread on every tick. The key is the track id (the video
 * id for YouTube, the URI for local files and addons).
 *
 * [provisional] holds the track ids whose head pass has landed but whose
 * whole-track pass has not yet arrived. A reader on the playback thread
 * must treat a provisional result as usable but will not see the full
 * content-end/outro/mix-out data until the whole pass lands.
 *
 * [running] holds the track ids currently being decoded — whether head,
 * whole, or both — so a second request does not spawn a second job.
 *
 * [badRenditions], [discarded], [shortDecodes], [triedRenditions] and
 * [headAttempts] are per-session mutation guards that prevent retry loops
 * and ensure a broken copy is discarded once.
 *
 * [headSkipLogged] prevents log spam from the short-head check.
 *
 * [sourceAnalysisUris], [sourceResolutions], [sourceResolutionAttempted]
 * handle the YouTube Opus resolution for addon tracks.
 */
class TrackAnalyzer(
    private val resolver: ContentResolver,
    private val cache: AudioCache,
) {
    private val executor = Executors.newSingleThreadExecutor()
    private val scope = CoroutineScope(Dispatchers.Default + executor.asCoroutineDispatcher())

    /** All finished analyses, keyed by track id. Read by playback on every tick. */
    private val results = java.util.concurrent.ConcurrentHashMap<String, TrackAnalysis>()

    /** Tracks whose head pass has landed but whole-track pass has not. */
    private val provisional = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

    /** Tracks currently being decoded — head, whole, or both — so we don't double-spawn. */
    private val running = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

    /** Tracks whose analysis failed in a way that should not be retried. */
    private val badRenditions = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

    /** Renditions thrown off disk because they decoded short. */
    private val discarded = java.util.concurrent.ConcurrentHashMap<String, Int>()

    /** Short-decode strikes per track id. Three strikes writes the track off. */
    private val shortDecodes = java.util.concurrent.ConcurrentHashMap<String, Int>()

    /** Renditions we have already tried for the current track id. */
    private val triedRenditions = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

    /** How many times a rendition has been discarded. */
    private val discardedCount = java.util.concurrent.ConcurrentHashMap<String, Int>()

    /** Head-decode attempts per track, for logging skip logic. */
    private val headAttempts = java.util.concurrent.ConcurrentHashMap<String, Int>()

    /** Whether we already logged that a track's head was skipped. */
    private val headSkipLogged = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

    /** Tracks whose head pass was restored from a short decode. */
    private val restoreAttempted = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

    /** YouTube Opus URI for addon tracks, keyed by the addon's track id. */
    private val sourceAnalysisUris = java.util.concurrent.ConcurrentHashMap<String, Uri>()

    /** Tracks for which we have already launched a YouTube match. */
    private val sourceResolutionAttempted = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

    /** Tracks for which a YouTube match is in flight. */
    private val sourceResolutions = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

    private val tracker = BeatTracker()
    private val vocals = VocalTracker()

    private var stopped = false

    /**
     * Entry point from [CrossfadeController.requestAnalysis]. Returns a ready
     * analysis, or null if a decode is in flight — in which case the caller
     * will find it on the next tick.
     */
    fun requestAnalysis(trackId: String, durationSeconds: Double) {
        if (durationSeconds.isNaN() || durationSeconds <= 0) return
        if (trackId in results || trackId in running) return
        executor.execute { analyze(trackId, uriFromTrackId(trackId), durationSeconds) }
    }

    private fun uriFromTrackId(trackId: String): Uri {
        return if (trackId.startsWith("webdav:") || trackId.startsWith("smb:") || trackId.startsWith("local:")) {
            Uri.parse(trackId)
        } else {
            AutomixAnalysisSource.opusUri(trackId)
        }
    }

    fun analysisFor(trackId: String): TrackAnalysis = results[trackId] ?: TrackAnalysis(trackId = trackId)

    fun analysisRunningFor(trackId: String): Boolean = trackId in running

    fun analysisProvisionalFor(trackId: String): Boolean = trackId in provisional

    fun requestAnalysis(trackId: String, uri: Uri, durationSeconds: Double) {
        if (durationSeconds.isNaN() || durationSeconds <= 0) return
        if (trackId in results || trackId in running) return
        executor.execute { analyze(trackId, uri, durationSeconds) }
    }

    fun requestAnalysisHead(trackId: String, uri: Uri, durationSeconds: Double, headRendition: AudioCache.Rendition) {
        if (durationSeconds.isNaN() || durationSeconds <= 0) return
        if (trackId in running) return
        executor.execute {
            analyzeHead(trackId, uri, durationSeconds, headRendition)?.let { head ->
                provisional.add(trackId)
                results[trackId] = head
            }
        }
    }

    fun headWorthTrying(trackId: String): Boolean = trackId !in headAttempts

    /** Returns the cached analysis, or a fresh empty one if nothing is cached. */
    fun cached(trackId: String): TrackAnalysis = results[trackId] ?: TrackAnalysis(trackId = trackId)

    /** A track the user is actually playing right now gets a background decode. */
    suspend fun canvasFor(song: Song): TrackAnalysis? {
        if (song.videoId.isBlank()) return null
        val cached = results[song.videoId]
        if (cached != null && cached.isUsable) return cached
        return withContext(Dispatchers.Default) {
            val uri = AutomixAnalysisSource.opusUri(song.videoId)
            val duration = song.durationMs / 1000.0
            analyze(song.videoId, uri, duration).analysis
        }
    }

    /**
     * Head-only analysis: reads the opening window and returns a provisional
     * analysis with tempo/beat info, used for the incoming side of a transition
     * while the whole-track pass runs in the background.
     *
     * Returns null if the opening window is not yet on disk.
     */
    private fun analyzeHead(
        trackId: String,
        uri: Uri,
        durationSeconds: Double,
        rendition: AudioCache.Rendition,
    ): TrackAnalysis? {
        fun openSource(): MediaDataSource? = cache.renditionDataSource(uri, rendition)

        // Same guard the whole-track pass applies, for the same reason: a
        // sibling rendition can be a different cut, and a beat grid borrowed
        // across that would put every anchor seconds out. Skipped for the
        // player's own copy, which is the track by definition. A header that
        // will not parse yet is not held against the rendition — more bytes may
        // well fix it — but a length that genuinely disagrees is.
        val expected = durationSeconds.takeIf { it.isFinite() && it > 0 }
        if (expected != null && rendition.key != cache.cacheKeyOf(uri)) {
            val length = openSource()?.use(AudioDecoder::containerDurationSeconds)
            if (length == null || length <= 0) {
                // Logged rather than returned quietly. This is the likeliest way
                // for a head pass to do nothing — a partial container the
                // extractor will not read a duration out of — and while it was
                // silent the whole path looked like it had never run.
                Log.d(TAG, "Head rendition ${rendition.key} for $trackId has no readable duration yet")
                return null
            }
            if (abs(length - expected) > RENDITION_DURATION_TOLERANCE) {
                Log.d(
                    TAG,
                    "Head rendition ${rendition.key} rejected for $trackId: " +
                        "${"%.1f".format(Locale.ROOT, length)}s against ${"%.1f".format(Locale.ROOT, expected)}s expected",
                )
                badRenditions.add(rendition.key)
                return null
            }
        }

        val window = BeatTracker.WINDOW_SECONDS
        val head = region(::openSource, 0.0, window, features = null, deriveFeatures = true)
            ?: run {
                // An abandoned decode comes back the same way a broken one
                // does, and only one of the two is worth a warning: see
                // [stopped]. Nothing is recorded either way — the caller
                // publishes only a non-null result — so the track is simply
                // left unmeasured, which is what it is.
                if (stopped) return null
                Log.d(TAG, "Head pass for $trackId could not decode rendition ${rendition.key}")
                return null
            }
        // What was decoded, not what was asked for: the source stops where the
        // cache does. A tempo read off a few seconds is not a weaker measurement
        // than one read off thirty, it is a different and much more credulous
        // one, and the planner cannot see the difference — so it is refused here
        // and the next attempt gets more of the file.
        if (head.seconds < MIN_HEAD_SECONDS) {
            Log.d(TAG, "Head pass for $trackId decoded only ${"%.1f".format(Locale.ROOT, head.seconds)}s; too short")
            return null
        }
        val grid = head.grid
        val entry = head.features
        if (grid == null && entry == null) {
            Log.d(TAG, "Head pass for $trackId produced nothing usable")
            return null
        }

        Log.d(
            TAG,
            "Analysed head of $trackId: bpm=${grid?.bpm ?: entry?.bpm} " +
                "conf=${grid?.beatConfidence ?: entry?.beatConfidence} " +
                "audibleStart=${entry?.audibleStartTime} pickup=${entry?.pickupTime} " +
                "introEnd=${entry?.introEndTime} mixInCandidates=${entry?.mixInCandidates?.size ?: 0} " +
                "over ${"%.1f".format(Locale.ROOT, head.seconds)}s",
        )

        val beatIntervalVal = grid?.beatInterval ?: entry?.beatInterval ?: 0.0
        val bpmVal = (grid?.bpm ?: entry?.bpm)?.takeIf { it > 0.0 }
            ?: (beatIntervalVal.takeIf { it > 0.0 }?.let { 60.0 / it } ?: 0.0)

        return TrackAnalysis(
            status = TrackAnalysis.STATUS_READY,
            trackId = trackId,
            duration = durationSeconds,
            bpm = bpmVal,
            beatInterval = beatIntervalVal,
            beatConfidence = grid?.beatConfidence ?: entry?.beatConfidence ?: 0.0,
            downbeats = grid?.downbeats ?: entry?.downbeats.orEmpty(),
            firstBeat = grid?.firstBeat ?: entry?.firstBeat ?: 0.0,
            key = entry?.key.orEmpty(),
            keyConfidence = entry?.keyConfidence ?: 0.0,
            audibleStartTime = entry?.audibleStartTime,
            pickupTime = entry?.pickupTime,
            introEndTime = entry?.introEndTime ?: 0.0,
            mixInTime = entry?.mixInTime ?: 0.0,
            mixInCandidates = entry?.mixInCandidates.orEmpty(),
            headBeats = grid?.let { BeatSide(it.beats, it.downbeats, it.bpm, it.beatConfidence) },
            cheapVocalWindows = listOfNotNull(head.cheapVocalWindow),
        )
    }

    /**
     * Picks which rendition of [uri]'s recording to analyse: the lightest one
     * that is both complete and the same cut as the track being played.
     *
     * A recording can be on disk two or three times over — the Opus stream
     * YouTube served, a substituted source's copy, a later quality upgrade —
     * and they hold the same music, so an analysis of any of them describes
     * all of them. Analysing the smallest is not merely cheaper: it is the one
     * that finished downloading first, and a lossless upgrade can take most of
     * a track's play time to arrive. Waiting for it is why analysis was landing
     * seconds *after* the transition it was meant to inform.
     *
     * The duration check is what makes the sharing safe. A `#alt` rendition
     * comes from an entirely different source and may be a different cut —
     * a radio edit, a version with a longer intro — and a beat grid borrowed
     * across that difference would put every anchor seconds out. Comparing
     * container durations catches exactly that, and costs a header parse per
     * candidate.
     */
    private fun chooseRendition(
        trackId: String,
        uri: Uri,
        durationSeconds: Double,
    ): AudioCache.Rendition? {
        val complete = cache.renditionsOf(uri)
            .filter { AutomixAnalysisSource.isCanonicalYouTubeRendition(uri.getQueryParameter("v"), it.key) }
            .filter { it.isComplete && it.key !in badRenditions }
        if (complete.isEmpty()) return null

        val expected = durationSeconds.takeIf { it.isFinite() && it > 0 }
        // Without a length to check a sibling against, sharing would be a guess,
        // so only the rendition actually being played can be trusted.
        if (expected == null) {
            val own = cache.cacheKeyOf(uri)
            complete.firstOrNull { it.key == own }?.let { return it }
            // Nothing to cross-check against — but one copy is not ambiguous
            // either, and refusing it outright is a dead end rather than a
            // safeguard. [cacheKeyOf] answers with whichever rendition the key
            // factory resolves to *now*, which with substitution on is the `#alt`
            // entry; the copy actually on disk is routinely the plain one, so
            // this asked for a rendition that did not exist and returned null on
            // every tick, silently, for as long as the track stayed queued.
            //
            // The risk the duration check exists to catch is borrowing a beat
            // grid across two different cuts of a song. That needs two copies to
            // choose wrongly between. With exactly one there is no choice being
            // made, and the worst case degrades from "never analysed" to "a grid
            // measured off the only audio we have".
            return complete.singleOrNull()?.also {
                Log.d(
                    TAG,
                    "Analysing $trackId from its only cached rendition ${it.key}; " +
                        "no duration to check it against",
                )
            }
        }

        for (candidate in complete) {
            val length = cache.renditionDataSource(uri, candidate)
                .use(AudioDecoder::containerDurationSeconds)
            if (length == null || length <= 0) {
                // Every candidate here is complete, so no more bytes are coming
                // to make the header readable: remembered for the reason below.
                badRenditions.add(candidate.key)
                continue
            }
            if (abs(length - expected) > RENDITION_DURATION_TOLERANCE) {
                Log.d(
                    TAG,
                    "Rendition ${candidate.key} rejected for $trackId: " +
                        "${"%.1f".format(Locale.ROOT, length)}s against ${"%.1f".format(Locale.ROOT, expected)}s expected",
                )
                // Remembered, as the head pass remembers its own rejections. A
                // cut that is the wrong length now is the wrong length on the
                // next tick too, and while it counted as complete [request]
                // queued a pass on every one of them — reopening and parsing the
                // same file four times a second for as long as the track played.
                badRenditions.add(candidate.key)
                continue
            }
            if (candidate.key != cache.cacheKeyOf(uri)) {
                Log.d(
                    TAG,
                    "Analysing $trackId from lighter rendition ${candidate.key} " +
                        "(${candidate.contentLength / 1024}kB)",
                )
            }
            return candidate
        }
        return null
    }

    /**
     * Where a whole-track pass reads its audio from, and the identity the retry
     * bookkeeping keys off.
     *
     * Two kinds of copy exist and they are not interchangeable. A **cached
     * rendition** is one of several copies of a streamed recording: chosen
     * between by [chooseRendition], cross-checked for being the same cut, and
     * when it turns out undecodable — thrown off disk so a clean one can replace
     * it. A **local file** is the track itself: exactly one of it, complete from
     * the moment it exists, nothing to choose between, and not ours to delete.
     *
     * [rendition] is what tells the two apart. Null means the audio is a file on
     * the device, which is why the blame-and-discard half of [structure] is
     * conditional on it rather than on a flag.
     */
    private class Copy(
        val key: String,
        val rendition: AudioCache.Rendition?,
        val open: () -> MediaDataSource?,
    )

    /**
     * Which copy of [trackId]'s audio to read, or null when there isn't a usable
     * one yet.
     *
     * A local URI short-circuits the entire rendition search: none of what that
     * search decides between applies to a file the user already has, and asking
     * the cache about one only ever produced the empty answer that kept Automix
     * from analysing local tracks at all. The URI stands in as the cache key,
     * which is what [request]'s `untried` check reads so a file that will not
     * decode is not re-decoded on every tick for the rest of the session.
     */
    private fun copyToRead(trackId: String, uri: Uri, durationSeconds: Double): Copy? {
        if (LocalAudioSource.isLocal(uri)) {
            return Copy(key = uri.toString(), rendition = null) { LocalAudioSource.open(resolver, uri) }
        }
        val rendition = chooseRendition(trackId, uri, durationSeconds) ?: return null
        return Copy(key = rendition.key, rendition = rendition) { cache.renditionDataSource(uri, rendition) }
    }

    /**
     * Source-backed playback URIs (JioSaavn, module/lossless, etc.) carry the
     * same title/artist/runtime matching hints as a YouTube item. Resolve that
     * identity once, then keep playback on its original URI while analysis
     * fills and reads the separately pinned YouTube Opus entry.
     */
    private fun analysisUriFor(trackId: String, playbackUri: Uri): Uri? {
        if (playbackUri.getQueryParameter("v") != null || playbackUri.authority != "source") return playbackUri
        // Never for a row picked from the Addons search: that would put a
        // YouTube search and its Opus on the network under a track whose whole
        // point is not being YouTube. Left unmeasured, as a party leaves every
        // track — see [SourceResolver.MIX_PARAM].
        if (SourceResolver.isPickedAddonRow(playbackUri)) return null
        sourceAnalysisUris[trackId]?.let { return it }
        if (trackId in sourceResolutionAttempted) return null
        if (!sourceResolutions.add(trackId)) return null
        val target = SourceResolver.targetIn(playbackUri)
        sourceResolutionScope.launch {
            try {
                val match = findYouTubeMatch(target)
                if (match != null) {
                    sourceAnalysisUris[trackId] = Uri.parse(AutomixAnalysisSource.opusUri(match.videoId))
                    Log.d(TAG, "Automix analysis for $trackId will use YouTube Opus ${match.videoId}")
                } else {
                    Log.d(TAG, "No YouTube match for Automix analysis of $trackId")
                }
            } catch (error: Throwable) {
                Log.d(TAG, "YouTube match failed for Automix analysis of $trackId: ${error.message}")
            } finally {
                sourceResolutionAttempted.add(trackId)
                sourceResolutions.remove(trackId)
            }
        }
        return null
    }

    private suspend fun findYouTubeMatch(target: TrackMatcher.Target): com.music.bitchord.data.model.Song? {
        if (target.title.isBlank()) return null
        for (query in TrackMatcher.queries(target)) {
            val candidates = YtMusicRepository.search(query, SearchFilter.SONGS)
                .getOrNull()
                ?.filterIsInstance<SearchResult.Track>()
                ?.map { it.song }
                .orEmpty()
            TrackMatcher.best(candidates, target)?.let { return it }
        }
        return null
    }

    /**
     * What a whole-track pass came back with.
     *
     * [decodedShort] is the difference between "this copy is broken, strike it"
     * and "there was no copy to read", which the caller counts very differently:
     * three strikes writes a track off for the session. Conflating the two spent
     * all three in 922ms on a track whose only complete copy had just been
     * rejected — the following two attempts decoded nothing because there was
     * nothing left to decode, and were counted as though they had tried.
     */
    private class WholeTrack(val analysis: TrackAnalysis?, val decodedShort: Boolean = false)

    /**
     * What Pass 1 came back with.
     *
     * [decodedShort] has to survive the return rather than collapsing into a null [features]: it is
     * the same distinction [WholeTrack.decodedShort] draws, between a broken copy and no copy, and
     * only one of the two is a strike.
     */
    private class Structural(,
        val features: TrackFeatures.Features?,
        val decodedShort: Boolean = false,
        /** Integrated loudness of the whole decoded span, and of its edges; see [Loudness]. */
        val lufs: Double? = null,
        val lufsHead: Double? = null,
        val lufsTail: Double? = null,
    )

    /**
     * Decodes the whole track and reduces it to DSP features.
     *
     * A method rather than a block in [analyze] for a reason that is about memory, not tidiness —
     * see the call site. Everything it decodes is dead by the time it returns, and returning is
     * what makes that true of the heap as well as of the program.
     */
    private fun structure(
        trackId: String,
        uri: Uri,
        copy: Copy,
        effectiveDuration: Double,
    ): Structural {
        val structRate = TrackFeatures.sampleRate
        val decoded = copy.open()?.use { AudioDecoder.decodeRegion(it, 0.0, effectiveDuration) { stopped } }
            ?: return Structural(null)
        val (pcm, _) = decoded

        // A decode that stops early is indistinguishable, downstream, from a
        // track that simply goes quiet: [TrackFeatures] is handed the
        // container's full duration alongside a short buffer, reads the
        // difference as trailing silence, and puts the mix-out anchor where the
        // bytes ran out. Nothing about the result looks wrong — it is a complete
        // analysis with a plausible contentEnd — and the audible symptom is the
        // track being faded out minutes early. Refused outright rather than
        // published, because a missing analysis degrades to a plain crossfade
        // while a confidently wrong one does not degrade at all.
        val decodedSeconds = if (pcm.sampleRate > 0) pcm.samples.size / pcm.sampleRate else 0.0
        if (decodedSeconds < effectiveDuration * MIN_DECODED_FRACTION) {
            Log.w(
                TAG,
                "Analysis of $trackId refused: ${copy.key} decoded " +
                    "${"%.1f".format(Locale.ROOT, decodedSeconds)}s of a " +
                    "${"%.1f".format(Locale.ROOT, effectiveDuration)}s " +
                    // The two causes are different enough to be worth naming. A
                    // cached rendition stops at the first hole read-ahead left in
                    // it; a file on the device has no holes, so a short decode
                    // there means the container itself is truncated or damaged.
                    if (copy.rendition != null) "container — cached with holes?" else "container — truncated file?",
            )
            // Both halves of this are about *renditions*, so both are conditional
            // on there being one. A local file has no sibling copy to be routed to
            // instead and is not ours to delete either way; the three-strike count
            // in [request] is the whole bound there, and it is enough, because a
            // file on disk that decodes short will decode short again.
            copy.rendition?.let { rendition ->
                // Remembered, so the retry reaches for a *different* rendition. This
                // is the whole reason the lightest one is only a preference: a
                // rendition the cache index calls complete can still decode short if
                // it was written badly, and without this the retries would pick the
                // same broken copy three times over and give up on a track whose
                // heavier rendition would have analysed perfectly well.
                badRenditions.add(rendition.key)
                // And thrown off disk, not merely remembered. A file the cache calls
                // complete and the decoder gives up on partway is not going to
                // improve: nothing else will ever write to it, because as far as the
                // cache is concerned it is finished. Remembering it only helps for as
                // long as this process lives — a restart clears the set, the same
                // bytes are read again, and the same seconds are spent reaching the
                // same conclusion. Deleting it is what lets a clean copy be fetched.
                // Skipped for whatever the player is reading from; see
                // [AudioCache.discardBadRendition].
                if (rendition.isComplete && discardsOf(rendition.key) < MAX_RENDITION_DISCARDS &&
                    cache.discardBadRendition(uri, rendition.key)
                ) {
                    // Every memory of that copy goes with the bytes. Deleting the
                    // file and then still refusing its key is the worst of both: the
                    // clean copy [AudioCache.requestAnalysisHead] fetches in its place
                    // is filtered straight back out by [badRenditions], the track is
                    // written off for the session anyway, and the download was spent
                    // on nothing. The strike count goes too — the next attempt reads
                    // genuinely different bytes, so it starts level.
                    discarded.merge(rendition.key, 1, Int::plus)
                    badRenditions.remove(rendition.key)
                    triedRenditions.remove(rendition.key)
                    shortDecodes.remove(trackId)
                }
            }
            return Structural(null, decodedShort = true)
        }

        val samples = if (abs(pcm.sampleRate - structRate) > 1.0) {
            TrackFeatures.resample(pcm.samples, pcm.sampleRate, structRate) ?: return Structural(null)
        } else {
            pcm.samples
        }

        // LUFS is measured on the mono container-rate span the decoder just
        // handed back, before the resample the DSP pass reads. The weighting
        // is rate-independent (its coefficients are derived per rate), so the
        // number agrees with whatever rate the container holds — and the
        // head/tail slices are views, not copies, so the memory cost of the
        // whole measurement is one array of ~4 hop sums per second.
        // The decoder reports the rate as a Double; the weighting wants the
        // integer rate the coefficients are derived at.
        val decodeRate = pcm.sampleRate.roundToInt()
        val lufs = Loudness.integratedLufs(pcm.samples, decodeRate)
        val edge = min(pcm.samples.size, (LUFS_EDGE_SECONDS * decodeRate).roundToInt())
        val lufsHead = Loudness.integratedLufs(pcm.samples, 0, edge, decodeRate)
        val tailStart = pcm.samples.size - edge
        val lufsTail = Loudness.integratedLufs(pcm.samples, tailStart, edge, decodeRate)

        return Structural(
            TrackFeatures.analyze(samples, effectiveDuration),
            lufs = lufs,
            lufsHead = lufsHead,
            lufsTail = lufsTail,
        )
    }

    /**
     * The whole-track pass. A null [WholeTrack.analysis] means "not now, try
     * again"; see the short-decode guard below, which is the one condition that
     * produces a confident-looking analysis that is wrong by minutes rather than
     * merely absent, and the only one that counts as a strike.
     */
    private fun analyze(trackId: String, uri: Uri, durationSeconds: Double): WholeTrack {
        val copy = copyToRead(trackId, uri, durationSeconds) ?: return WholeTrack(null)
        // Recorded before the outcome is known, because what this gates is
        // whether a *written-off* track is worth reopening, and the answer is
        // only ever "yes" for a copy that has not been read yet. Recording it on
        // success alone would leave a failure looking permanently reopenable and
        // re-decode the same file on every tick.
        triedRenditions.add(copy.key)
        val openSource = copy.open

        var effectiveDuration = durationSeconds
        if (!effectiveDuration.isFinite() || effectiveDuration <= 0) {
            effectiveDuration = openSource()?.use(AudioDecoder::containerDurationSeconds) ?: 0.0
        }
        if (effectiveDuration <= 0) {
            Log.d(TAG, "Skipping $trackId: ${copy.key} has no readable duration")
            return WholeTrack(empty(trackId, 0.0))
        }

        // Pass 1 (Phase 1, DSP-only): the analyzer needs the whole track — the energy curve,
        // phrase structure and mix-out anchor all read the tail, not just a window of it — at its
        // own low sample rate, so this is a much smaller decode than a full-rate pass would be.
        //
        // In a frame of its own, and handing back only the features, because of what it allocates
        // to get them: the whole track decoded to mono at the container's rate (35 MB for a
        // 3.5-minute song) plus the resampled copy the DSP reads (8 MB). Neither is touched again
        // after this line, but a local holding either stays reachable to the end of the method, and
        // the rest of the method is Pass 2 — the most allocation-heavy part of the analysis.
        // Measured on the API 28 emulator: those two buffers were 43 MB of an 82 MB live set, still
        // held while the models ran, in a process that was reaching a 256 MB heap limit and had
        // died on it. Returning is what releases them — a `val` cannot be nulled, and a narrower
        // scope alone does not make ART treat one as dead.
        val structural = structure(trackId, uri, copy, effectiveDuration)
        // A party started while Pass 1 was decoding. Dropped as "no result"
        // rather than as a failure — the track was never measured, so nothing
        // should be recorded against it and nothing should stop it being
        // measured properly once the party ends.
        //
        // Read *before* the two lines below, not after, because an abort comes
        // back from [structure] as a decode that produced nothing, and that is
        // exactly what those lines write a permanent "cannot be analysed" for.
        if (stopped) return WholeTrack(null)
        if (structural.decodedShort) return WholeTrack(null, decodedShort = true)
        val features = structural.features ?: return WholeTrack(empty(trackId, effectiveDuration))

        // Pass 2 (Phases 2 and 3, models): the Beat This! grid and the open-unmix vocal mask, over
        // the opening and the ending only. A transition only ever reads the tail of the outgoing
        // track and the head of the incoming one, and a track is both of those at different
        // moments, so the middle is never decoded for this. Both models read the same decoded
        // window, so its stereo buffer is paid for once. The spans match the loop mix's searches:
        // its incoming loop is looked for in the first 45 s, its outgoing one in the last 60.
        val span = modelWindowSeconds()
        // Spans that the windows tile exactly, overlaps included: one window more
        // here is a whole extra pass of both models.
        val headEnd = minOf(effectiveDuration, HEAD_MODEL_WINDOWS * span - (HEAD_MODEL_WINDOWS - 1) *
            WINDOW_OVERLAP_SECONDS)
        val tailStart = max(0.0, effectiveDuration - (TAIL_MODEL_WINDOWS * span - (TAIL_MODEL_WINDOWS - 1) *
            WINDOW_OVERLAP_SECONDS))
        val regions = ArrayList<Region>()
        for ((from, to) in modelWindows(headEnd, tailStart, effectiveDuration, span)) {
            // Checked between windows: an abort leaves a window missing, which
            // is indistinguishable from one the models found nothing in — and
            // that would be published, and persisted, with the DSP estimate
            // standing in. A result assembled out of a half-finished analysis
            // is worse than none.
            if (stopped) return WholeTrack(null)
            region(openSource, from, to, features)?.let(regions::add)
        }
        if (stopped) return WholeTrack(null)

        val beats = seamBeats(regions)
        val headSide = beatSide(beats, 0.0, headEnd)
        val tailSide = beatSide(beats, tailStart, effectiveDuration)
        val headGrid = headSide?.toGrid()
        val tailGrid = tailSide?.toGrid()

        // The tail governs where the outgoing track is mixed out, so it takes precedence; the
        // head is what a track uses when it is the *incoming* side of a different transition.
        val leading = tailGrid ?: headGrid

        Log.d(
            TAG,
            "Analysed $trackId: bpm=${leading?.bpm ?: features.bpm} " +
                "conf=${leading?.beatConfidence ?: features.beatConfidence} " +
                "key=${features.key} contentEnd=${features.contentEndTime} " +
                "mixOutCandidates=${features.mixOutCandidates.size} " +
                "grid=${if (leading != null) "model" else "dsp"} " +
                "beats=${headGrid?.beats?.size ?: 0}+${tailGrid?.beats?.size ?: 0} " +
                "downbeats=${headGrid?.downbeats?.size ?: 0}+${tailGrid?.downbeats?.size ?: 0} " +
                "vocalMask=${if (regions.any { it.vocalMask != null }) "model" else "dsp"} " +
                "windows=${regions.size} vocalWindows=${regions.count { it.vocalWindow != null }} " +
                "cheapWindows=${regions.count { it.cheapVocalWindow != null }} " +
                "lufs=${structural.lufs?.let { "%.1f".format(Locale.ROOT, it) }}",
        )

        val beatIntervalVal = leading?.beatInterval ?: features.beatInterval ?: 0.0
        val bpmVal = (leading?.bpm ?: features.bpm)?.takeIf { it > 0.0 }
            ?: (beatIntervalVal.takeIf { it > 0.0 }?.let { 60.0 / it } ?: 0.0)

        return WholeTrack(
                TrackAnalysis(
                    status = TrackAnalysis.STATUS_READY,
                    trackId = trackId,
                    duration = effectiveDuration,
                    contentEndTime = features.contentEndTime.takeIf { it > 0 } ?: effectiveDuration,
                    bpm = bpmVal,
                    beatInterval = beatIntervalVal,
                    beatConfidence = leading?.beatConfidence ?: features.beatConfidence,
                    downbeats = (headGrid?.downbeats.orEmpty() + tailGrid?.downbeats.orEmpty())
                        .ifEmpty { features.downbeats }
                        .sorted(),
                    firstBeat = headGrid?.firstBeat ?: features.firstBeat,
                    phraseBoundaries = features.phraseBoundaries,
                    key = features.key,
                    keyConfidence = features.keyConfidence,
                    audibleStartTime = features.audibleStartTime,
                    pickupTime = features.pickupTime,
                    introEndTime = features.introEndTime,
                    outroStartTime = features.outroStartTime,
                    mixInTime = features.mixInTime,
                    mixOutTime = features.mixOutTime,
                    mixInCandidates = features.mixInCandidates,
                    mixOutCandidates = features.mixOutCandidates,
                    energyCurve = features.energyCurve,
                    lowEnergyCurve = features.lowEnergyCurve,
                    // The mask falls through three sources in order: the model's
                    // own mask where it ran, the cheap detector's windows over the
                    // energy curve where it didn't (Phase 1, L2), and only then
                    // the DSP heuristic. Falling back rather than stopping matters
                    // because the policy reads an absent mask and a neutral one
                    // identically — as "no evidence" — so a failed model pass
                    // would otherwise silently discard every estimate Phase 1 had.
                    vocalActivityMask = mergeMasks(features.energyCurve.size, regions.mapNotNull { it.vocalMask })
                        ?: cheapVocalMask(features.energyCurve, regions.mapNotNull { it.cheapVocalWindow })
                        ?: features.vocalActivityMask.map(::heuristicVocalOnModelScale),
                    vocalProbability = features.vocalProbability,
                    headBeats = headSide,
                    tailBeats = tailSide,
                    vocalWindows = regions.mapNotNull { it.vocalWindow },
                    cheapVocalWindows = regions.mapNotNull { it.cheapVocalWindow },
                    levelWindows = regions.mapNotNull { it.levelWindow },
                    lufs = structural.lufs,
                    lufsHead = structural.lufsHead,
                    lufsTail = structural.lufsTail,
                ),
            )
        }
    }catch (e: Exception) {
        e.printStackTrace()
    }

    /**
     * Everything a decoded region contributes, once its audio has been let go
     * of. [seconds] is what was actually decoded, which for a partially cached
     * file is not what was asked for.
     */
    private class Region(
        val grid: BeatTracker.Grid?,
        val vocalMask: DoubleArray?,
        val seconds: Double,
        /** Only populated when the caller asked for it; see [region]'s `deriveFeatures`. */
        val features: TrackFeatures.Features? = null,
        /** Where the decode really began (the extractor seeks to a sync sample at or before the ask). */
        val start: Double = 0.0,
        /** The vocal model's raw output over this window, for the loop mix's vocal check. */
        val vocalWindow: CurveWindow? = null,
        /** The cheap detector's output over this window, when the model is not available to. */
        val cheapVocalWindow: CurveWindow? = null,
        /** RMS level over this window, for the loop mix's loudness check. */
        val levelWindow: CurveWindow? = null,
    )

    /**
     * Seconds of audio one model window covers: the vocal model's fixed input,
     * which is the shorter of the two models' (the beat model's 1500 frames run
     * to ~30 s). One window is then exactly one inference of each.
     */
    private fun modelWindowSeconds(): Double =
        if (VocalSpectrogram.available) {
            (VocalTracker.FIXED_FRAMES - 2) * VocalSpectrogram.hop / VocalSpectrogram.sampleRate
        } else {
            BeatTracker.WINDOW_SECONDS
        }

    /**
     * The windows the models run over: [HEAD_MODEL_WINDOWS] from the start and
     * [TAIL_MODEL_WINDOWS] up to the end, each [span] long and overlapping its
     * neighbour by [WINDOW_OVERLAP_SECONDS] so the beat at a seam is seen from
     * both sides. A short track, where the two spans meet, is covered once.
     */
    private fun modelWindows(headEnd: Double, tailStart: Double, duration: Double, span: Double): List<Pair<Double,
Double>> {
        val spans = if (tailStart <= headEnd) {
            listOf(0.0 to duration)
        } else {
            listOf(0.0 to headEnd, tailStart to duration)
        }
        val windows = ArrayList<Pair<Double, Double>>()
        for ((from, to) in spans) {
            val length = to - from
            if (length < 1.0) continue
            if (length <= span) {
                windows += from to to
                continue
            }
            // As few windows as cover the span with at least the overlap between
            // neighbours, spread evenly from its start to its end.
            val count = ceil((length - WINDOW_OVERLAP_SECONDS) / (span - WINDOW_OVERLAP_SECONDS) - 1e-6).toInt()
            val stride = (length - span) / (count - 1)
            for (index in 0 until count) {
                val start = from + index * stride
                windows += start to minOf(to, start + span)
            }
        }
        return windows
    }

    /** One beat list across the windows: at each overlap, the earlier window's beats before its midpoint, the later's
after. */
    private class Beats(val beats: List<Double>, val downbeats: List<Double>, val confidence: Double)

    private fun seamBeats(regions: List<Region>): Beats {
        val graded = regions.filter { it.grid != null }.sortedBy { it.start }
        if (graded.isEmpty()) return Beats(emptyList(), emptyList(), 0.0)
        val beats = ArrayList<Double>()
        val downbeats = ArrayList<Double>()
        var weighted = 0.0
        var count = 0
        for ((index, region) in graded.withIndex()) {
            val grid = region.grid!!
            val previous = graded.getOrNull(index - 1)
            val next = graded.getOrNull(index + 1)
            val from = previous?.let { (it.start + it.seconds + region.start) / 2 }
                ?.takeIf { it > region.start } ?: Double.NEGATIVE_INFINITY
            val until = next?.let { (region.start + region.seconds + it.start) / 2 }
                ?.takeIf { it < region.start + region.seconds } ?: Double.POSITIVE_INFINITY
            val kept = grid.beats.filter { it >= from && it < until }
            beats += kept
            downbeats += grid.downbeats.filter { it >= from && it < until }
            weighted += grid.beatConfidence * kept.size
            count += kept.size
        }
        return Beats(beats.sorted(), downbeats.sorted(), if (count > 0) weighted / count else 0.0)
    }

    /** The model's grid over [from]..[to], or null where it found too few beats there. */
    private fun beatSide(all: Beats, from: Double, to: Double): BeatSide? {
        val beats = all.beats.filter { it >= from && it <= to }
        val bpm = BeatTracker.tempoFromBeats(beats)
        if (bpm <= 0) return null
        return BeatSide(
            beats = beats,
            downbeats = all.downbeats.filter { it >= from && it <= to },
            bpm = bpm,
            confidence = all.confidence,
        )
    }

    private fun BeatSide.toGrid() = BeatTracker.Grid(
        beats = beats,
        downbeats = downbeats,
        bpm = bpm,
        beatInterval = 60 / bpm,
        firstBeat = beats.first(),
        beatConfidence = confidence,
    )

    /**
     * Decodes one stereo region and runs both models over it, returning only their results.
     *
     * The point of the function boundary is the audio: the stereo buffer, its mono mix and the
     * resampled copies are all local, so they become collectible the moment this returns rather
     * than staying live until the whole analysis finishes. A 30 s stereo region is several
     * megabytes before either model's own working set is counted.
     *
     * Null, or a null field, means "no model evidence for this window" — a codec that will not
     * configure, a region too short, a missing model — which [analyze] already falls back on.
     *
     * The extractor seeks to a sync sample at or before what was asked for, so the region's real
     * start (not [startSeconds]) is what its beat times must be stated against.
     */
    private fun region(
        openSource: () -> MediaDataSource?,
        startSeconds: Double,
        endSeconds: Double,
        features: TrackFeatures.Features?,
        deriveFeatures: Boolean = false,
    ): Region? {
        val decoded = openSource()?.use { AudioDecoder.decodeRegionStereo(it, startSeconds, endSeconds) { stopped } }
            ?: run {
                // The two ways this comes back empty mean opposite things and
                // were reported identically, which cost a round of guessing:
                // this one is the extractor refusing the container outright, so
                // the bytes are wrong or not enough of them are there to parse.
                Log.d(TAG, "Region [$startSeconds, $endSeconds) would not open")
                return null
            }
        val (stereo, actualStart) = decoded
        if (stereo.left.size < stereo.sampleRate) {
            // And this one is a container that parsed fine and yielded under a
            // second of audio — a decode that started and ran out, not one that
            // never started.
            Log.d(TAG, "Region [$startSeconds, $endSeconds) decoded ${stereo.left.size} frames; too few")
            return null
        }

        val seconds = stereo.left.size / stereo.sampleRate
        // In a frame of its own so the full-rate mono downmix is released before either model runs.
        // It is 23 MB for this window at 48 kHz — the same size as each of the two channels it
        // averages — and it is read exactly twice, to make the resampled model input and the DSP
        // one. As a local it would nonetheless stay reachable through `tracker.track` and
        // `vocalMask` below, which is where the analysis allocates most heavily and where the
        // process was dying. Same reasoning [derived] already had, one level further out.
        val inputs = regionInputs(stereo, seconds, deriveFeatures)

        val vocalValues = if (features != null) vocalValues(stereo) else null
        // Phase 1, L2: where open-unmix is not on this build, the cheap
        // detector stands in over every window the pass decodes — the head
        // pass included, whose window is exactly the edge the incoming side
        // of a transition is read for. It is one STFT and a strided pass over
        // the frame it already cost the decode for.
        val cheapVocal = if (!VocalSpectrogram.available) {
            CheapVocal.window(stereo.left, stereo.right, actualStart)?.first
        } else {
            null
        }
        return Region(
            grid = inputs.forModel?.let { tracker.track(it, offsetSeconds = actualStart) },
            vocalMask = if (features != null && vocalValues != null) vocalMask(vocalValues, features, actualStart)
            else null,
            seconds = seconds,
            features = inputs.derived,
            start = actualStart,
            vocalWindow = vocalValues?.let { CurveWindow(actualStart, VocalSpectrogram.frameRate, it) },
            cheapVocalWindow = cheapVocal,
            levelWindow = if (features != null) levelCurve(stereo, actualStart) else null,
        )
    }

    /**
     * RMS of the stereo mix in frames of 1 / [LEVEL_FRAME_RATE] s, on the
     * [levelFromRms] scale (stored in hundredths, so it has to fit 0..1). Every
     * fourth sample: plenty for a level, and a quarter of the reads.
     */
    private fun levelCurve(stereo: AudioDecoder.StereoPcm, actualStart: Double): CurveWindow? {
        val frame = (stereo.sampleRate / LEVEL_FRAME_RATE).toInt()
        if (frame <= 0) return null
        val count = stereo.left.size / frame
        if (count <= 0) return null
        val values = FloatArray(count)
        for (index in 0 until count) {
            var sum = 0.0
            var n = 0
            var sample = index * frame
            val end = sample + frame
            while (sample < end) {
                val mixed = (stereo.left[sample] + stereo.right[sample]) * 0.5f
                sum += mixed * mixed
                n++
                sample += 4
            }
            values[index] = levelFromRms(kotlin.math.sqrt(sum / n)).toFloat()
        }
        return CurveWindow(actualStart, LEVEL_FRAME_RATE, values)
    }

    /** A region's model input, and its DSP features when the caller asked for them. */
    private class RegionInputs(val forModel: FloatArray?, val derived: TrackFeatures.Features?)

    /**
     * Reduces a decoded region to the buffers the models and the DSP actually read.
     *
     * Both come off one full-rate mono downmix, which is why they are made together rather than on
     * demand: that downmix is the largest single allocation in the analysis, and returning is the
     * only way to be rid of it before the models run.
     */
    private fun regionInputs(
        stereo: AudioDecoder.StereoPcm,
        seconds: Double,
        deriveFeatures: Boolean,
    ): RegionInputs {
        val mono = FloatArray(stereo.left.size) { index -> (stereo.left[index] + stereo.right[index]) * 0.5f }
        val forModel = if (abs(stereo.sampleRate - MelSpectrogram.sampleRate) > 1.0) {
            MelSpectrogram.resample(mono, stereo.sampleRate, MelSpectrogram.sampleRate)
        } else {
            mono
        }

        // Derived here rather than by the caller so the mono buffer is still
        // live: handing it back would keep several megabytes reachable for the
        // rest of the analysis, which is the one thing this function exists to
        // avoid.
        val derived = if (deriveFeatures) {
            val forFeatures = if (abs(stereo.sampleRate - TrackFeatures.sampleRate) > 1.0) {
                TrackFeatures.resample(mono, stereo.sampleRate, TrackFeatures.sampleRate)
            } else {
                mono
            }
            forFeatures?.let { TrackFeatures.analyze(it, seconds) }
        } else {
            null
        }

        return RegionInputs(forModel, derived)
    }

    /**
     * A vocal-presence value for every point on the energy curve, filled only where the model
     * actually ran.
     *
     * The policy indexes the mask against energy-curve sample times and requires the two to be
     * the same length, but the model's window is fixed at about 22 seconds, far less than a track.
     * So the mask is built at full length and filled only over this region.
     *
     * Everywhere else stays at [NEUTRAL_VOCAL]. That is not a guess dressed up as data: it sits
     * below the policy's own VOCAL_ACTIVE_THRESHOLD, so unmeasured material can never trip vocal
     * logic in either direction.
     */
    private fun vocalValues(stereo: AudioDecoder.StereoPcm): FloatArray? {
        if (!VocalSpectrogram.available) return null
        // [VocalTracker.track] refuses anything wider than its graph, so a window that came back a
        // little long is trimmed. Two frames of margin absorb the ±1 sample a rate conversion can
        // land on.
        val maxSeconds = (VocalTracker.FIXED_FRAMES - 2) * VocalSpectrogram.hop / VocalSpectrogram.sampleRate
        val maxSamples = (maxSeconds * stereo.sampleRate).toInt().coerceAtMost(stereo.left.size)
        if (maxSamples <= 0) return null
        val left = if (maxSamples < stereo.left.size) stereo.left.copyOf(maxSamples) else stereo.left
        val right = if (maxSamples < stereo.right.size) stereo.right.copyOf(maxSamples) else stereo.right
        return vocals.track(left, right, stereo.sampleRate)
    }

    private fun vocalMask(
        values: FloatArray,
        features: TrackFeatures.Features,
        actualStart: Double,
    ): DoubleArray? {
        val curve = features.energyCurve
        if (curve.isEmpty()) return null

        val mask = DoubleArray(curve.size) { NEUTRAL_VOCAL }
        for (index in curve.indices) {
            val frame = ((curve[index].time - actualStart) * VocalSpectrogram.frameRate).toInt()
            if (frame in values.indices) mask[index] = values[frame].toDouble()
        }
        return mask
    }

    /**
     * Overlays the head and tail masks onto one full-length curve, or null when neither ran —
     * which the caller answers by keeping the DSP heuristic rather than reporting a mask of
     * nothing but [NEUTRAL_VOCAL].
     */
    private fun mergeMasks(size: Int, masks: List<DoubleArray>): List<Double>? {
        if (size <= 0 || masks.isEmpty()) return null
        val merged = DoubleArray(size) { NEUTRAL_VOCAL }
        for (source in masks) {
            for (index in merged.indices) {
                if (index < source.size && source[index] != NEUTRAL_VOCAL) merged[index] = source[index]
            }
        }
        return merged.toList()
    }

    /**
     * The mask fallback chain's middle rung: the cheap detector's windows
     * resampled onto the energy curve's sample times, [NEUTRAL_VOCAL] beyond
     * their coverage for the same reason [vocalMask] fills with it — unmeasured
     * material sits below the policy's vocal threshold and can never trip
     * vocal logic in either direction. Null when no window ran, which sends
     * the caller to the DSP heuristic.
     */
    private fun cheapVocalMask(curve: List<EnergySample>, windows: List<CurveWindow>): List<Double>? {
        if (curve.isEmpty() || windows.isEmpty()) return null
        val mask = DoubleArray(curve.size) { NEUTRAL_VOCAL }
        for (index in curve.indices) {
            val time = curve[index].time
            val window = windows.firstOrNull { time >= it.startTime && time < it.endTime } ?: continue
            val frame = ((time - window.startTime) * window.frameRate).toInt()
            if (frame in window.values.indices) mask[index] = window.values[frame].toDouble()
        }
        return mask.toList()
    }

    /** Recorded ready-but-empty so a track that cannot be decoded is not retried every tick. */
    private fun empty(trackId: String, durationSeconds: Double) = TrackAnalysis(
        status = TrackAnalysis.STATUS_READY,
        trackId = trackId,
        duration = durationSeconds,
    )

    /**
     * Stereo audio of [fromSeconds]..[toSeconds] of [trackId] at [sampleRate],
     * for a loop mix deck, read off the copy analysis measured (so the deck's
     * loop is cut from the same audio its downbeats were found in). Null for a
     * source-backed track: its analysis reads a matched YouTube recording, not
     * what the player plays, and a deck spliced in from another master would
     * land off the song it takes over from. Blocking — call it off the main
     * thread.
     */
    fun loopRegion(
        trackId: String,
        uri: Uri,
        durationSeconds: Double,
        fromSeconds: Double,
        toSeconds: Double,
        sampleRate: Int,
    ): com.music.bitchord.playback.loopmix.LoopRegion? {
        if (uri.getQueryParameter("v") == null && uri.authority == "source") return null
        val began = SystemClock.elapsedRealtime()
        val copy = runCatching { copyToRead(trackId, uri, durationSeconds) }.getOrNull() ?: return null
        val (stereo, start) = copy.open()?.use { source ->
            AudioDecoder.decodeRegionStereo(source, max(0.0, fromSeconds), toSeconds) { stopped }
        } ?: return null
        if (stereo.left.isEmpty()) return null
        val rate = sampleRate.toDouble()
        val left: FloatArray
        val right: FloatArray
        if (abs(stereo.sampleRate - rate) > 0.5) {
            left = MelSpectrogram.resample(stereo.left, stereo.sampleRate, rate) ?: return null
            right = MelSpectrogram.resample(stereo.right, stereo.sampleRate, rate) ?: return null
        } else {
            left = stereo.left
            right = stereo.right
        }
        Log.d(
            TAG,
            "Loop region $trackId from ${copy.key}: asked ${"%.2f".format(Locale.ROOT, fromSeconds)}s, " +
                "got ${"%.3f".format(Locale.ROOT, start)}s + ${"%.2f".format(Locale.ROOT, left.size / rate)}s " +
                "at ${stereo.sampleRate.toInt()}->$sampleRate Hz in ${SystemClock.elapsedRealtime() - began}ms",
        )
        return com.music.bitchord.playback.loopmix.LoopRegion(left, right, start)
    }

    /**
     * A three-band waveform of [fromSeconds]..[toSeconds] of [trackId], for the
     * Automix popup, read off the same copy analysis measured; null when there
     * is no such copy to read. Blocking — call it off the main thread.
     */
    fun mixWaveform(
        trackId: String,
        uri: Uri,
        durationSeconds: Double,
        fromSeconds: Double,
        toSeconds: Double,
        bins: Int,
    ): MixWaveform.Bands? {
        // Not [analysisUriFor]: that starts a catalogue search, and this only
        // wants whatever analysis already settled on.
        val analysisUri = if (uri.getQueryParameter("v") != null || uri.authority != "source") {
            uri
        } else {
            sourceAnalysisUris[trackId] ?: return null
        }
        val began = SystemClock.elapsedRealtime()
        val copy = runCatching { copyToRead(trackId, analysisUri, durationSeconds) }.getOrNull() ?: return null
        val chosen = SystemClock.elapsedRealtime()
        val bands = copy.open()?.use { source ->
            MixWaveform.build(source, fromSeconds, toSeconds, bins) { stopped }
        }
        Log.d(
            TAG,
            "Mix waveform $trackId: copy ${chosen - began}ms, decode ${SystemClock.elapsedRealtime() - chosen}ms, " +
                "asked ${"%.1f".format(Locale.ROOT, fromSeconds)}s, decoder started " +
                "${bands?.decodedFrom?.let { "%.1f".format(Locale.ROOT, it) } ?: "-"}s",
        )
        return bands
    }

    fun release() {
        executor.shutdownNow()
        sourceResolutionScope.cancel()
        sourceAnalysisUris.clear()
        sourceResolutions.clear()
        sourceResolutionAttempted.clear()
        headAttempts.clear()
        headSkipLogged.clear()
        provisional.clear()
        restoreAttempted.clear()
        shortDecodes.clear()
        badRenditions.clear()
        triedRenditions.clear()
        discarded.clear()
        tracker.release()
        vocals.release()
    }

    private companion object {
        const val TAG = "BitChordTrackAnalyzer"

        /**
         * What an unmeasured instant reads as. Below the policy's VOCAL_ACTIVE_THRESHOLD by
         * design, so absence of measurement is never mistaken for absence of a vocal, or for the
         * presence of one.
         */
        const val NEUTRAL_VOCAL = 0.2

        /** Model windows over the opening (~45 s) and the ending (~68 s); see [modelWindowSeconds]. */
        const val HEAD_MODEL_WINDOWS = 2
        const val TAIL_MODEL_WINDOWS = 3

        /** Overlap between neighbouring model windows, so a beat on a seam is seen from both sides. */
        const val WINDOW_OVERLAP_SECONDS = 1.0

        /**
         * How much more than the average-bitrate estimate of the opening window
         * to insist on before decoding it. Covers the container header and the
         * fact that a track's opening is rarely at its own average bitrate.
         */
        const val HEAD_BYTES_MARGIN = 1.35

        /**
         * Floor under the computed threshold, and the whole requirement when the
         * duration is unknown. Roughly fifteen seconds at 128 kbps — a little
         * over [MIN_HEAD_SECONDS], so it guarantees a parsable container and a
         * usable decode without quietly reinstating the thirty-second demand the
         * bitrate estimate was just lowered away from.
         */
        const val MIN_HEAD_BYTES = 256L * 1024L

        /**
         * How much of the container's stated duration must actually decode
         * before the whole-track pass is trusted. Not 1.0: a decoder legitimately
         * comes up a frame or two short of the container's rounding, and
         * refusing over that would refuse everything.
         */
        const val MIN_DECODED_FRACTION = 0.95

        /**
         * How much of either edge the edge-level LUFS reads: the first and
         * last half minute, the part a transition actually plays across. The
         * whole-track number carries the mix's overall level matching.
         */
        const val LUFS_EDGE_SECONDS = 30.0

        /** Refusals before a track is written off as truncated rather than still filling in. */
        const val MAX_SHORT_DECODE_ATTEMPTS = 3

        /**
         * Clean-slate retries per rendition. One: a discard is worth doing when
         * the bytes on disk are unrecoverable and nothing would otherwise
         * overwrite them, and worth doing exactly once, because a second identical
         * answer means the source is serving that file rather than the cache
         * having mangled it.
         */
        const val MAX_RENDITION_DISCARDS = 1

        /**
         * How far two renditions' container durations may differ and still count
         * as the same cut. Generous enough for codec padding and the player's own
         * rounding, tight enough that a different edit of the same song — where a
         * borrowed beat grid would be useless — is rejected.
         */
        const val RENDITION_DURATION_TOLERANCE = 1.0

        /**
         * Stand-in bitrate for a rendition whose real length isn't recorded yet,
         * used only to rank copies against each other in [headSecondsOf]. About
         * 160kbps, the middle of what the streams in play here run at.
         */
        const val ASSUMED_BYTES_PER_SECOND = 20_000.0

        /**
         * The least decoded audio a head-only tempo estimate is allowed to rest
         * on. Twelve seconds is around 24 beats at 120 bpm — enough for the
         * grid's own confidence measure to mean something.
         */
        const val MIN_HEAD_SECONDS = 12.0

        /**
         * How much more of the file has to be cached before the head is worth
         * decoding again. Doubling bounds the attempts to a handful over a whole
         * download while still catching up quickly on a high-bitrate rendition
         * whose first attempt covered only a few seconds.
         */
        const val HEAD_RETRY_GROWTH = 2
    }
}

    private fun region(
        openSource: () -> MediaDataSource?,
        startSeconds: Double,
        endSeconds: Double,
        features: TrackFeatures.Features?,
        deriveFeatures: Boolean = false,
    ): Region? {
        val decoded = openSource()?.use { AudioDecoder.decodeRegionStereo(it, startSeconds, endSeconds) { stopped } }
            ?: run {
                // The two ways this comes back empty mean opposite things and
                // were reported identically, which cost a round of guessing:
                // this one is the extractor refusing the container outright, so
                // the bytes are wrong or not enough of them are there to parse.
                Log.d(TAG, "Region [$startSeconds, $endSeconds) would not open")
                return null
            }
        val (stereo, actualStart) = decoded
        if (stereo.left.size < stereo.sampleRate) {
            // And this one is a container that parsed fine and yielded under a
            // second of audio — a decode that started and ran out, not one that
            // never started.
            Log.d(TAG, "Region [$startSeconds, $endSeconds) decoded ${stereo.left.size} frames; too few")
            return null
        }

        val seconds = stereo.left.size / stereo.sampleRate
        // In a frame of its own so the full-rate mono downmix is released before either model runs.
        // It is 23 MB for this window at 48 kHz — the same size as each of the two channels it
        // averages — and it is read exactly twice, to make the resampled model input and the DSP
        // one. As a local it would nonetheless stay reachable through `tracker.track` and
        // `vocalMask` below, which is where the analysis allocates most heavily and where the
        // process was dying. Same reasoning [derived] already had, one level further out.
        val inputs = regionInputs(stereo, seconds, deriveFeatures)

        val vocalValues = if (features != null) vocalValues(stereo) else null
        // Phase 1, L2: where open-unmix is not on this build, the cheap
        // detector stands in over every window the pass decodes — the head
        // pass included, whose window is exactly the edge the incoming side
        // of a transition is read for. It is one STFT and a strided pass over
        // the frame it already cost the decode for.
        val cheapVocal = if (!VocalSpectrogram.available) {
            CheapVocal.window(stereo.left, stereo.right, actualStart)?.first
        } else {
            null
        }
        return Region(
            grid = inputs.forModel?.let { tracker.track(it, offsetSeconds = actualStart) },
            vocalMask = if (features != null && vocalValues != null) vocalMask(vocalValues, features, actualStart)
            else null,
            seconds = seconds,
            features = inputs.derived,
            start = actualStart,
            vocalWindow = vocalValues?.let { CurveWindow(actualStart, VocalSpectrogram.frameRate, it) },
            cheapVocalWindow = cheapVocal,
            levelWindow = if (features != null) levelCurve(stereo, actualStart) else null,
        )
    }

    /**
     * RMS of the stereo mix in frames of 1 / [LEVEL_FRAME_RATE] s, on the
     * [levelFromRms] scale (stored in hundredths, so it has to fit 0..1). Every
     * fourth sample: plenty for a level, and a quarter of the reads.
     */
    private fun levelCurve(stereo: AudioDecoder.StereoPcm, actualStart: Double): CurveWindow? {
        val frame = (stereo.sampleRate / LEVEL_FRAME_RATE).toInt()
        if (frame <= 0) return null
        val count = stereo.left.size / frame
        if (count <= 0) return null
        val values = FloatArray(count)
        for (index in 0 until count) {
            var sum = 0.0
            var n = 0
            var sample = index * frame
            val end = sample + frame
            while (sample < end) {
                val mixed = (stereo.left[sample] + stereo.right[sample]) * 0.5f
                sum += mixed * mixed
                n++
                sample += 4
            }
            values[index] = levelFromRms(kotlin.math.sqrt(sum / n)).toFloat()
        }
        return CurveWindow(actualStart, LEVEL_FRAME_RATE, values)
    }

    /** A region's model input, and its DSP features when the caller asked for them. */
    private class RegionInputs(val forModel: FloatArray?, val derived: TrackFeatures.Features?)

    /**
     * Reduces a decoded region to the buffers the models and the DSP actually read.
     *
     * Both come off one full-rate mono downmix, which is why they are made together rather than on
     * demand: that downmix is the largest single allocation in the analysis, and returning is the
     * only way to be rid of it before the models run.
     */
    private fun regionInputs(
        stereo: AudioDecoder.StereoPcm,
        seconds: Double,
        deriveFeatures: Boolean,
    ): RegionInputs {
        val mono = FloatArray(stereo.left.size) { index -> (stereo.left[index] + stereo.right[index]) * 0.5f }
        val forModel = if (abs(stereo.sampleRate - MelSpectrogram.sampleRate) > 1.0) {
            MelSpectrogram.resample(mono, stereo.sampleRate, MelSpectrogram.sampleRate)
        } else {
            mono
        }

        // Derived here rather than by the caller so the mono buffer is still
        // live: handing it back would keep several megabytes reachable for the
        // rest of the analysis, which is the one thing this function exists to
        // avoid.
        val derived = if (deriveFeatures) {
            val forFeatures = if (abs(stereo.sampleRate - TrackFeatures.sampleRate) > 1.0) {
                TrackFeatures.resample(mono, stereo.sampleRate, TrackFeatures.sampleRate)
            } else {
                mono
            }
            forFeatures?.let { TrackFeatures.analyze(it, seconds) }
        } else {
            null
        }

        return RegionInputs(forModel, derived)
    }

    /**
     * A vocal-presence value for every point on the energy curve, filled only where the model
     * actually ran.
     *
     * The policy indexes the mask against energy-curve sample times and requires the two to be
     * the same length, but the model's window is fixed at about 22 seconds, far less than a track.
     * So the mask is built at full length and filled only over this region.
     *
     * Everywhere else stays at [NEUTRAL_VOCAL]. That is not a guess dressed up as data: it sits
     * below the policy's own VOCAL_ACTIVE_THRESHOLD, so unmeasured material can never trip vocal
     * logic in either direction.
     */
    private fun vocalValues(stereo: AudioDecoder.StereoPcm): FloatArray? {
        if (!VocalSpectrogram.available) return null
        // [VocalTracker.track] refuses anything wider than its graph, so a window that came back a
        // little long is trimmed. Two frames of margin absorb the ±1 sample a rate conversion can
        // land on.
        val maxSeconds = (VocalTracker.FIXED_FRAMES - 2) * VocalSpectrogram.hop / VocalSpectrogram.sampleRate
        val maxSamples = (maxSeconds * stereo.sampleRate).toInt().coerceAtMost(stereo.left.size)
        if (maxSamples <= 0) return null
        val left = if (maxSamples < stereo.left.size) stereo.left.copyOf(maxSamples) else stereo.left
        val right = if (maxSamples < stereo.right.size) stereo.right.copyOf(maxSamples) else stereo.right
        return vocals.track(left, right, stereo.sampleRate)
    }

    private fun vocalMask(
        values: FloatArray,
        features: TrackFeatures.Features,
        actualStart: Double,
    ): DoubleArray? {
        val curve = features.energyCurve
        if (curve.isEmpty()) return null

        val mask = DoubleArray(curve.size) { NEUTRAL_VOCAL }
        for (index in curve.indices) {
            val frame = ((curve[index].time - actualStart) * VocalSpectrogram.frameRate).toInt()
            if (frame in values.indices) mask[index] = values[frame].toDouble()
        }
        return mask
    }

    /**
     * Overlays the head and tail masks onto one full-length curve, or null when neither ran —
     * which the caller answers by keeping the DSP heuristic rather than reporting a mask of
     * nothing but [NEUTRAL_VOCAL].
     */
    private fun mergeMasks(size: Int, masks: List<DoubleArray>): List<Double>? {
        if (size <= 0 || masks.isEmpty()) return null
        val merged = DoubleArray(size) { NEUTRAL_VOCAL }
        for (source in masks) {
            for (index in merged.indices) {
                if (index < source.size && source[index] != NEUTRAL_VOCAL) merged[index] = source[index]
            }
        }
        return merged.toList()
    }

    /**
     * The mask fallback chain's middle rung: the cheap detector's windows
     * resampled onto the energy curve's sample times, [NEUTRAL_VOCAL] beyond
     * their coverage for the same reason [vocalMask] fills with it — unmeasured
     * material sits below the policy's vocal threshold and can never trip
     * vocal logic in either direction. Null when no window ran, which sends
     * the caller to the DSP heuristic.
     */
    private fun cheapVocalMask(curve: List<EnergySample>, windows: List<CurveWindow>): List<Double>? {
        if (curve.isEmpty() || windows.isEmpty()) return null
        val mask = DoubleArray(curve.size) { NEUTRAL_VOCAL }
        for (index in curve.indices) {
            val time = curve[index].time
            val window = windows.firstOrNull { time >= it.startTime && time < it.endTime } ?: continue
            val frame = ((time - window.startTime) * window.frameRate).toInt()
            if (frame in window.values.indices) mask[index] = window.values[frame].toDouble()
        }
        return mask.toList()
    }

    /** Recorded ready-but-empty so a track that cannot be decoded is not retried every tick. */
    private fun empty(trackId: String, durationSeconds: Double) = TrackAnalysis(
        status = TrackAnalysis.STATUS_READY,
        trackId = trackId,
        duration = durationSeconds,
    )

    /**
     * Stereo audio of [fromSeconds]..[toSeconds] of [trackId] at [sampleRate],
     * for a loop mix deck, read off the copy analysis measured (so the deck's
     * loop is cut from the same audio its downbeats were found in). Null for a
     * source-backed track: its analysis reads a matched YouTube recording, not
     * what the player plays, and a deck spliced in from another master would
     * land off the song it takes over from. Blocking — call it off the main
     * thread.
     */
    fun loopRegion(
        trackId: String,
        uri: Uri,
        durationSeconds: Double,
        fromSeconds: Double,
        toSeconds: Double,
        sampleRate: Int,
    ): com.music.bitchord.playback.loopmix.LoopRegion? {
        if (uri.getQueryParameter("v") == null && uri.authority == "source") return null
        val began = SystemClock.elapsedRealtime()
        val copy = runCatching { copyToRead(trackId, uri, durationSeconds) }.getOrNull() ?: return null
        val (stereo, start) = copy.open()?.use { source ->
            AudioDecoder.decodeRegionStereo(source, max(0.0, fromSeconds), toSeconds) { stopped }
        } ?: return null
        if (stereo.left.isEmpty()) return null
        val rate = sampleRate.toDouble()
        val left: FloatArray
        val right: FloatArray
        if (abs(stereo.sampleRate - rate) > 0.5) {
            left = MelSpectrogram.resample(stereo.left, stereo.sampleRate, rate) ?: return null
            right = MelSpectrogram.resample(stereo.right, stereo.sampleRate, rate) ?: return null
        } else {
            left = stereo.left
            right = stereo.right
        }
        Log.d(
            TAG,
            "Loop region $trackId from ${copy.key}: asked ${"%.2f".format(Locale.ROOT, fromSeconds)}s, " +
                "got ${"%.3f".format(Locale.ROOT, start)}s + ${"%.2f".format(Locale.ROOT, left.size / rate)}s " +
                "at ${stereo.sampleRate.toInt()}->$sampleRate Hz in ${SystemClock.elapsedRealtime() - began}ms",
        )
        return com.music.bitchord.playback.loopmix.LoopRegion(left, right, start)
    }

    /**
     * A three-band waveform of [fromSeconds]..[toSeconds] of [trackId], for the
     * Automix popup, read off the same copy analysis measured; null when there
     * is no such copy to read. Blocking — call it off the main thread.
     */
    fun mixWaveform(
        trackId: String,
        uri: Uri,
        durationSeconds: Double,
        fromSeconds: Double,
        toSeconds: Double,
        bins: Int,
    ): MixWaveform.Bands? {
        // Not [analysisUriFor]: that starts a catalogue search, and this only
        // wants whatever analysis already settled on.
        val analysisUri = if (uri.getQueryParameter("v") != null || uri.authority != "source") {
            uri
        } else {
            sourceAnalysisUris[trackId] ?: return null
        }
        val began = SystemClock.elapsedRealtime()
        val copy = runCatching { copyToRead(trackId, analysisUri, durationSeconds) }.getOrNull() ?: return null
        val chosen = SystemClock.elapsedRealtime()
        val bands = copy.open()?.use { source ->
            MixWaveform.build(source, fromSeconds, toSeconds, bins) { stopped }
        }
        Log.d(
            TAG,
            "Mix waveform $trackId: copy ${chosen - began}ms, decode ${SystemClock.elapsedRealtime() - chosen}ms, " +
                "asked ${"%.1f".format(Locale.ROOT, fromSeconds)}s, decoder started " +
                "${bands?.decodedFrom?.let { "%.1f".format(Locale.ROOT, it) } ?: "-"}s",
        )
        return bands
    }

    fun release() {
        executor.shutdownNow()
        sourceResolutionScope.cancel()
        sourceAnalysisUris.clear()
        sourceResolutions.clear()
        sourceResolutionAttempted.clear()
        headAttempts.clear()
        headSkipLogged.clear()
        provisional.clear()
        restoreAttempted.clear()
        shortDecodes.clear()
        badRenditions.clear()
        triedRenditions.clear()
        discarded.clear()
        tracker.release()
        vocals.release()
    }

    private companion object {
        const val TAG = "BitChordTrackAnalyzer"

        /**
         * What an unmeasured instant reads as. Below the policy's VOCAL_ACTIVE_THRESHOLD by
         * design, so absence of measurement is never mistaken for absence of a vocal, or for the
         * presence of one.
         */
        const val NEUTRAL_VOCAL = 0.2

        /** Model windows over the opening (~45 s) and the ending (~68 s); see [modelWindowSeconds]. */
        const val HEAD_MODEL_WINDOWS = 2
        const val TAIL_MODEL_WINDOWS = 3

        /** Overlap between neighbouring model windows, so a beat on a seam is seen from both sides. */
        const val WINDOW_OVERLAP_SECONDS = 1.0

        /**
         * How much more than the average-bitrate estimate of the opening window
         * to insist on before decoding it. Covers the container header and the
         * fact that a track's opening is rarely at its own average bitrate.
         */
        const val HEAD_BYTES_MARGIN = 1.35

        /**
         * Floor under the computed threshold, and the whole requirement when the
         * duration is unknown. Roughly fifteen seconds at 128 kbps — a little
         * over [MIN_HEAD_SECONDS], so it guarantees a parsable container and a
         * usable decode without quietly reinstating the thirty-second demand the
         * bitrate estimate was just lowered away from.
         */
        const val MIN_HEAD_BYTES = 256L * 1024L

        /**
         * How much of the container's stated duration must actually decode
         * before the whole-track pass is trusted. Not 1.0: a decoder legitimately
         * comes up a frame or two short of the container's rounding, and
         * refusing over that would refuse everything.
         */
        const val MIN_DECODED_FRACTION = 0.95

        /**
         * How much of either edge the edge-level LUFS reads: the first and
         * last half minute, the part a transition actually plays across. The
         * whole-track number carries the mix's overall level matching.
         */
        const val LUFS_EDGE_SECONDS = 30.0

        /** Refusals before a track is written off as truncated rather than still filling in. */
        const val MAX_SHORT_DECODE_ATTEMPTS = 3

        /**
         * Clean-slate retries per rendition. One: a discard is worth doing when
         * the bytes on disk are unrecoverable and nothing would otherwise
         * overwrite them, and worth doing exactly once, because a second identical
         * answer means the source is serving that file rather than the cache
         * having mangled it.
         */
        const val MAX_RENDITION_DISCARDS = 1

        /**
         * How far two renditions' container durations may differ and still count
         * as the same cut. Generous enough for codec padding and the player's own
         * rounding, tight enough that a different edit of the same song — where a
         * borrowed beat grid would be useless — is rejected.
         */
        const val RENDITION_DURATION_TOLERANCE = 1.0

        /**
         * Stand-in bitrate for a rendition whose real length isn't recorded yet,
         * used only to rank copies against each other in [headSecondsOf]. About
         * 160kbps, the middle of what the streams in play here run at.
         */
        const val ASSUMED_BYTES_PER_SECOND = 20_000.0

        /**
         * The least decoded audio a head-only tempo estimate is allowed to rest
         * on. Twelve seconds is around 24 beats at 120 bpm — enough for the
         * grid's own confidence measure to mean something.
         */
        const val MIN_HEAD_SECONDS = 12.0

        /**
         * How much more of the file has to be cached before the head is worth
         * decoding again. Doubling bounds the attempts to a handful over a whole
         * download while still catching up quickly on a high-bitrate rendition
         * whose first attempt covered only a few seconds.
         */
        const val HEAD_RETRY_GROWTH = 2
    }
}