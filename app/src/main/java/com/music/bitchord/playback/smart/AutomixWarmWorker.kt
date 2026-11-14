package com.music.bitchord.playback.smart

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.music.bitchord.data.listentogether.ListenTogether
import com.music.bitchord.data.settings.AppSettings
import com.music.bitchord.data.model.Song
import com.music.bitchord.playback.AudioCache
import com.music.bitchord.playback.LastPlayed
import com.music.bitchord.playback.toMediaItem

/**
 * BitChord, Automix 2.0 Phase 1, L3: warms the analysis cache while the
 * device is idle.
 *
 * The ladder's guarantee — a complete plan standing a minute before every
 * transition — cannot be kept by the playback tick alone. A track whose
 * whole file only finishes downloading as it plays has its head measured
 * (L0/L2) in time, but the model passes that complete the vocal and misc
 * components (L3) can still land seconds *after* the blend it was meant to
 * inform, on exactly the cold starts where the queue was restored from disk
 * and nothing was analysed while the app was closed. So the work moves off
 * the critical path: after playback ends, WorkManager re-runs the restored
 * queue's tracks through a [TrackAnalyzer] of its own.
 *
 * The requests are deliberately the same ones the player makes. A fresh
 * analyzer restores from the shared [com.music.bitchord.playback.smart.AnalysisStore],
 * so a track already measured is one cached read and a no-op, and the
 * per-component versions mean a track holding valid grids is topped up, not
 * recomputed. Nothing new is recorded: this is the same ladder, run when it
 * cannot make a transition late.
 *
 * Skipped entirely while a Listen Together party is running — the host's
 * queue drives the mixes, and idle CPU belongs to the session then.
 */
class AutomixWarmWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        if (!AppSettings.smartFadeEnabled.value) return Result.success()
        if (ListenTogether.state.value.inParty) return Result.success()
        val snapshot = LastPlayed.load() ?: return Result.success()

        // Own instance, own models: the service's analyzer is either gone with
        // its service or serving live playback, and this one releases its
        // arena the moment the queue has been walked.
        val analyzer = TrackAnalyzer(applicationContext, AudioCache)
        try {
            for (song in snapshot.songs) {
                // A party that starts mid-run turns the rest of the queue into
                // someone else's mixes; checked per track so a long walk
                // cannot outlive the condition it was granted under.
                if (ListenTogether.state.value.inParty) break
                val item = song.toMediaItem()
                val uri = item.localConfiguration?.uri ?: continue
                analyzer.request(item.mediaId, uri, durationSecondsOf(song))
            }
        } finally {
            analyzer.release()
        }
        return Result.success()
    }

    /**
     * [Song.durationText] is display copy — "3:45" — and the analyzer only
     * uses a duration to sanity-check a rendition's cut and to size the head
     * fetch. Zero is a legitimate answer here: [TrackAnalyzer] re-reads the
     * container for the real duration, and the head estimate falls back to
     * its bytes floor.
     */
    private fun durationSecondsOf(song: Song): Double {
        val text = song.durationText ?: return 0.0
        val parts = text.split(':')
        if (parts.isEmpty() || parts.size > 3) return 0.0
        var seconds = 0.0
        for (part in parts) {
            val value = part.trim().toIntOrNull() ?: return 0.0
            if (value < 0) return 0.0
            seconds = seconds * 60 + value
        }
        return seconds
    }

    companion object {
        private const val WORK_NAME = "automix_analysis_warm"

        /**
         * Queues one warm pass over the last persisted queue. Unique and
         * [ExistingWorkPolicy.KEEP]: a pass already waiting covers any number
         * of service teardowns, because it reads the queue from
         * [LastPlayed] at run time rather than from whatever was current when
         * it was enqueued.
         *
         * Battery and storage are the two resources the pass spends, and both
         * are conditions it can wait out: a low phone plays its next party
         * without warmed analyses rather than on them.
         */
        fun schedule(context: Context) {
            val request = OneTimeWorkRequestBuilder<AutomixWarmWorker>()
                .setConstraints(
                    Constraints.Builder()
                        .setRequiresBatteryNotLow(true)
                        .setRequiresStorageNotLow(true)
                        .build(),
                )
                .build()
            WorkManager.getInstance(context)
                .enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.KEEP, request)
        }
    }
}
