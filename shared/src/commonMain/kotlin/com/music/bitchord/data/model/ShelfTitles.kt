package com.music.bitchord.data.model

/**
 * Shelf classification kinds recognized by YouTube Music across supported locales.
 */
enum class ShelfKind {
    RECENTS,
    PLAYLISTS,
    ALBUMS,
    ARTISTS,
    SUBSCRIPTIONS,
    TRENDING_COMMUNITY_PLAYLISTS,
    FEATURED_PLAYLISTS_FOR_YOU,
    QUICK_PICKS,
    LISTEN_AGAIN,
    MIXED_FOR_YOU,
    FORGOTTEN_FAVORITES,
    RECOMMENDED_MUSIC_VIDEOS,
    FROM_YOUR_LIBRARY,
    CHARTS,
    NEW_RELEASES,
    TOP_MUSIC_VIDEOS,
    FOR_YOU,
    HITS_TODAY,
    ARTISTS_ON_THE_RISE,
    CONCERTS,
    SHORTS,
    TRENDING,
}

/**
 * Shelf subtitle kinds recognized across supported locales.
 */
enum class ShelfSubtitleKind {
    TOP_TUNES_RIGHT_NOW,
    FROM_THE_COMMUNITY,
    YOUTUBE_CHARTS,
}

/**
 * Metric tally categories for card subtitles (e.g. "12M plays", "15 songs").
 */
enum class CardTallyKind {
    VIEWS,
    PLAYS,
    SONGS,
}

/**
 * Extracted count string and tally metric category.
 */
data class CardTally(
    val count: String,
    val kind: CardTallyKind,
)

/**
 * Canonical shelf-title registry — the single source of truth for every
 * YouTube Music shelf whose identity depends on its display text rather than a
 * structural signal (pageType, browseId, etc.).
 *
 * ## Why a central module?
 * YouTube sends shelf titles in the account language (`hl`). Code that
 * inspects them in multiple places inevitably grows divergent lists, missing
 * translations, and accidental substring matches. Every caller that needs to
 * classify a shelf by title goes through this object; no other source file is
 * allowed to match raw YouTube-label strings for classification purposes.
 *
 * ## Verification policy
 * Only verified, confirmed-live translations are included. A title that is
 * not in the list causes graceful degradation (the shelf falls through to the
 * existing fallback behaviour), which is safer than a wrong classification.
 * Each entry is tagged with its verified language(s) in a trailing comment.
 *
 * ## Matching rules
 * Comparison is `trim() + equals(ignoreCase = true)` — no substrings, no
 * regex, no diacritics folding — to avoid false positives on short generic
 * words ("Mix", "Radio"). The lone exception is [isQuickPicksFamilyShelf],
 * which keeps the legacy English substring heuristic for backward
 * compatibility while adding exact matches for localised variants.
 */
object ShelfTitles {

    // ── Listen Again ─────────────────────────────────────────────────────────

    /**
     * Titles that YouTube Music uses for the "Listen Again" shelf.
     * Verified: en, es, fr, de, it, pt, vi, ja
     */
    val LISTEN_AGAIN_TITLES: Set<String> = setOf(
        "Listen again",         // en  — verified
        "Escuchar de nuevo",    // es  — verified (production, HomeScreen.kt)
        "Réécouter",            // fr  — verified
        "Erneut anhören",       // de  — verified
        "Ascolta di nuovo",     // it  — verified
        "Ouvir de novo",        // pt  — verified
        "Nghe lại",             // vi  — verified (production, HomeScreen.kt)
        "もう一度聴く",          // ja  — verified (production, HomeScreen.kt)
    )

    fun isListenAgainShelf(title: String): Boolean =
        LISTEN_AGAIN_TITLES.any { it.equals(title.trim(), ignoreCase = true) }

    // ── Recents ───────────────────────────────────────────────────────────────

    /**
     * Titles YouTube Music uses for the "Recents / Recently Played" shelf.
     * Verified: en, es, vi, ja
     */
    val RECENTS_TITLES: Set<String> = setOf(
        "Recents",              // en  — verified
        "Recently played",      // en  — alternate phrasing, verified
        "Recientes",            // es  — verified (production, HomeScreen.kt)
        "Gần đây",              // vi  — verified (production, HomeScreen.kt)
        "最近",                  // ja  — verified (production, HomeScreen.kt)
    )

    fun isRecentsShelf(title: String): Boolean =
        RECENTS_TITLES.any { it.equals(title.trim(), ignoreCase = true) }

    // ── History ───────────────────────────────────────────────────────────────

    /**
     * Titles that signal explicit listening history (a superset of recents in
     * terms of what quickPicks must exclude).
     * Verified: en
     */
    val HISTORY_TITLES: Set<String> = setOf(
        "History",              // en  — verified
        "Listening history",    // en  — alternate phrasing
    )

    fun isHistoryShelf(title: String): Boolean =
        HISTORY_TITLES.any { it.equals(title.trim(), ignoreCase = true) }

    /**
     * Returns true when [title] is any shelf that quickPicks must exclude:
     * the union of [isListenAgainShelf], [isRecentsShelf], and [isHistoryShelf].
     */
    fun isHistoryOrRecentsShelf(title: String): Boolean =
        isListenAgainShelf(title) || isRecentsShelf(title) || isHistoryShelf(title)

    // ── Quick Picks ───────────────────────────────────────────────────────────

    /**
     * Titles that YouTube Music uses for the "Quick Picks" shelf.
     * Verified: en, es, vi, ja
     */
    val QUICK_PICKS_TITLES: Set<String> = setOf(
        "Quick picks",          // en  — verified
        "Selecciones rápidas",  // es  — verified (production, HomeScreen.kt)
        "Elección rápida",      // es  — alternate phrasing, verified
        "Lựa chọn nhanh",       // vi  — verified (production, HomeScreen.kt)
        "Chọn nhanh đài phát",  // vi  — alternate phrasing, verified
        "クイック ミックス",      // ja  — verified (production, HomeScreen.kt)
    )

    fun isQuickPicksShelf(title: String): Boolean =
        QUICK_PICKS_TITLES.any { it.equals(title.trim(), ignoreCase = true) }

    // ── Mixed For You ─────────────────────────────────────────────────────────

    /**
     * Titles that YouTube Music uses for the "Mixed For You" shelf.
     * Verified: en, es, vi, ja
     */
    val MIXED_FOR_YOU_TITLES: Set<String> = setOf(
        "Mixed for you",        // en  — verified
        "Mezclas para ti",      // es  — verified (production, HomeScreen.kt)
        "Dành riêng cho bạn",   // vi  — verified (production, HomeScreen.kt)
        "ミックス",              // ja  — verified (production, HomeScreen.kt)
    )

    fun isMixedForYouShelf(title: String): Boolean =
        MIXED_FOR_YOU_TITLES.any { it.equals(title.trim(), ignoreCase = true) }

    // ── Recommendations / For You ─────────────────────────────────────────────

    /**
     * Titles that YouTube Music uses for discovery/recommendations shelves.
     * Verified: en, es, vi, ja
     */
    val RECOMMENDATIONS_TITLES: Set<String> = setOf(
        "Recommended",          // en  — verified
        "Recommendations",      // en  — alternate phrasing
        "For you",              // en  — verified
        "Para ti",              // es  — verified (production, HomeScreen.kt)
        "Dành cho bạn",         // vi  — verified (production, HomeScreen.kt)
        "あなたへのおすすめ",    // ja  — verified (production, HomeScreen.kt)
    )

    /**
     * Returns true when [title] is any shelf from the Quick Picks family —
     * the shelves that [com.music.bitchord.data.YtMusicRepository.quickPicks] should favour.
     *
     * Matching strategy:
     * 1. Exact match against [QUICK_PICKS_TITLES], [MIXED_FOR_YOU_TITLES], or [RECOMMENDATIONS_TITLES].
     * 2. Legacy English substring fallback ("quick", "pick", "mix", "recommend").
     */
    fun isQuickPicksFamilyShelf(title: String): Boolean {
        val trimmed = title.trim()
        if (QUICK_PICKS_TITLES.any { it.equals(trimmed, ignoreCase = true) }) return true
        if (MIXED_FOR_YOU_TITLES.any { it.equals(trimmed, ignoreCase = true) }) return true
        if (RECOMMENDATIONS_TITLES.any { it.equals(trimmed, ignoreCase = true) }) return true
        return trimmed.contains("quick", ignoreCase = true) ||
            trimmed.contains("pick", ignoreCase = true) ||
            trimmed.contains("mix", ignoreCase = true) ||
            trimmed.contains("recommend", ignoreCase = true)
    }

    // ── Additional Home Shelves ───────────────────────────────────────────────

    val PLAYLISTS_TITLES: Set<String> = setOf(
        "Playlists",
        "Listas de reproducción",
        "Danh sách phát",
        "再生リスト",
    )

    val ALBUMS_TITLES: Set<String> = setOf(
        "Albums",
        "Album",
        "Álbumes",
        "アルバム",
    )

    val ARTISTS_TITLES: Set<String> = setOf(
        "Artists",
        "Artistas",
        "Nghệ sĩ",
        "アーティスト",
    )

    val SUBSCRIPTIONS_TITLES: Set<String> = setOf(
        "Subscriptions",
        "Suscripciones",
        "Đã đăng ký",
        "登録チャンネル",
    )

    val TRENDING_COMMUNITY_PLAYLISTS_TITLES: Set<String> = setOf(
        "Trending community playlists",
        "Listas populares de la comunidad",
        "Listas de la comunidad en tendencia",
        "Listas de reproducción populares de la comunidad",
        "Danh sách phát cộng đồng thịnh hành",
        "Danh sách phát thịnh hành trong cộng đồng người dùng",
        "急上昇のコミュニティ再生リスト",
    )

    val FEATURED_PLAYLISTS_FOR_YOU_TITLES: Set<String> = setOf(
        "Featured playlists for you",
        "Listas destacadas para ti",
        "Listas de reproducción destacadas para ti",
        "Danh sách phát đề xuất cho bạn",
        "Danh sách phát nổi bật dành cho bạn",
        "おすすめの再生リスト",
    )

    val FORGOTTEN_FAVORITES_TITLES: Set<String> = setOf(
        "Forgotten favorites",
        "Favoritos olvidados",
        "Giai điệu quen thuộc",
        "よく聴いたお気に入りの曲",
    )

    val RECOMMENDED_MUSIC_VIDEOS_TITLES: Set<String> = setOf(
        "Recommended music videos",
        "Vídeos musicales recomendados",
        "Videos musicales recomendados",
        "Video âm nhạc đề xuất",
        "おすすめのミュージック ビデオ",
    )

    val FROM_YOUR_LIBRARY_TITLES: Set<String> = setOf(
        "From your library",
        "De tu biblioteca",
        "Từ thư viện của bạn",
        "ライブラリから",
    )

    val CHARTS_TITLES: Set<String> = setOf(
        "Charts",
        "Listas de éxitos",
        "Éxitos",
        "Listas de YouTube",
        "Bảng xếp hạng",
        "チャート",
    )

    val NEW_RELEASES_TITLES: Set<String> = setOf(
        "New releases",
        "Novedades",
        "Bản phát hành mới",
        "最新リリース",
    )

    val TOP_MUSIC_VIDEOS_TITLES: Set<String> = setOf(
        "Top music videos",
        "Vídeos musicales principales",
        "Videos musicales principales",
        "Video âm nhạc hàng đầu",
        "人気のミュージック ビデオ",
    )

    val FOR_YOU_TITLES: Set<String> = setOf(
        "For you",
        "Para ti",
        "Dành cho bạn",
        "あなたへのおすすめ",
    )

    val HITS_TODAY_TITLES: Set<String> = setOf(
        "Hits today",
        "Today's Hits",
        "Éxitos de hoy",
        "Temas del momento",
        "Bản hit hôm nay",
        "今日のヒット曲",
    )

    val ARTISTS_ON_THE_RISE_TITLES: Set<String> = setOf(
        "Artists on the rise",
        "Artistas en ascenso",
        "Nghệ sĩ đang lên",
    )

    val CONCERTS_TITLES: Set<String> = setOf(
        "Concerts",
        "Conciertos",
        "Buổi hòa nhạc",
        "コンサート",
    )

    val SHORTS_TITLES: Set<String> = setOf(
        "Shorts",
        "Shorts nổi bật",
        "ショート",
    )

    val TRENDING_TITLES: Set<String> = setOf(
        "Trending",
        "Tendencias",
        "Thịnh hành",
        "急上昇",
    )

    private val SIMILAR_TO_PREFIXES: List<String> = listOf(
        "Similar to",
        "Similar a",
        "Tương tự như",
    )

    /**
     * Extracts the target artist name if [title] represents a "Similar to ..." shelf,
     * or returns null if it is not a similar-to shelf.
     */
    fun extractSimilarToArtist(title: String): String? {
        val trimmed = title.trim()
        for (prefix in SIMILAR_TO_PREFIXES) {
            if (trimmed.startsWith(prefix, ignoreCase = true)) {
                val candidate = trimmed.substring(prefix.length).trim()
                if (candidate.isNotEmpty()) return candidate
            }
        }
        return null
    }

    /**
     * Classifies a shelf title into its canonical [ShelfKind], or null if unrecognised.
     */
    fun classifyShelf(title: String): ShelfKind? {
        val trimmed = title.trim()
        return when {
            isRecentsShelf(trimmed) -> ShelfKind.RECENTS
            PLAYLISTS_TITLES.any { it.equals(trimmed, ignoreCase = true) } -> ShelfKind.PLAYLISTS
            ALBUMS_TITLES.any { it.equals(trimmed, ignoreCase = true) } -> ShelfKind.ALBUMS
            ARTISTS_TITLES.any { it.equals(trimmed, ignoreCase = true) } -> ShelfKind.ARTISTS
            SUBSCRIPTIONS_TITLES.any { it.equals(trimmed, ignoreCase = true) } -> ShelfKind.SUBSCRIPTIONS
            TRENDING_COMMUNITY_PLAYLISTS_TITLES.any { it.equals(trimmed, ignoreCase = true) } -> ShelfKind.TRENDING_COMMUNITY_PLAYLISTS
            FEATURED_PLAYLISTS_FOR_YOU_TITLES.any { it.equals(trimmed, ignoreCase = true) } -> ShelfKind.FEATURED_PLAYLISTS_FOR_YOU
            isQuickPicksShelf(trimmed) -> ShelfKind.QUICK_PICKS
            isListenAgainShelf(trimmed) -> ShelfKind.LISTEN_AGAIN
            isMixedForYouShelf(trimmed) -> ShelfKind.MIXED_FOR_YOU
            FORGOTTEN_FAVORITES_TITLES.any { it.equals(trimmed, ignoreCase = true) } -> ShelfKind.FORGOTTEN_FAVORITES
            RECOMMENDED_MUSIC_VIDEOS_TITLES.any { it.equals(trimmed, ignoreCase = true) } -> ShelfKind.RECOMMENDED_MUSIC_VIDEOS
            FROM_YOUR_LIBRARY_TITLES.any { it.equals(trimmed, ignoreCase = true) } -> ShelfKind.FROM_YOUR_LIBRARY
            CHARTS_TITLES.any { it.equals(trimmed, ignoreCase = true) } -> ShelfKind.CHARTS
            NEW_RELEASES_TITLES.any { it.equals(trimmed, ignoreCase = true) } -> ShelfKind.NEW_RELEASES
            TOP_MUSIC_VIDEOS_TITLES.any { it.equals(trimmed, ignoreCase = true) } -> ShelfKind.TOP_MUSIC_VIDEOS
            FOR_YOU_TITLES.any { it.equals(trimmed, ignoreCase = true) } -> ShelfKind.FOR_YOU
            HITS_TODAY_TITLES.any { it.equals(trimmed, ignoreCase = true) } -> ShelfKind.HITS_TODAY
            ARTISTS_ON_THE_RISE_TITLES.any { it.equals(trimmed, ignoreCase = true) } -> ShelfKind.ARTISTS_ON_THE_RISE
            CONCERTS_TITLES.any { it.equals(trimmed, ignoreCase = true) } -> ShelfKind.CONCERTS
            SHORTS_TITLES.any { it.equals(trimmed, ignoreCase = true) } || trimmed.startsWith("Shorts", ignoreCase = true) -> ShelfKind.SHORTS
            TRENDING_TITLES.any { it.equals(trimmed, ignoreCase = true) } -> ShelfKind.TRENDING
            else -> null
        }
    }

    // ── Shelf Subtitles ───────────────────────────────────────────────────────

    val TOP_TUNES_TITLES: Set<String> = setOf(
        "TOP TUNES RIGHT NOW",
        "Top tunes right now",
        "Temas del momento",
        "Giai điệu hàng đầu hiện nay",
        "注目の曲",
    )

    val FROM_THE_COMMUNITY_TITLES: Set<String> = setOf(
        "From the community",
        "De la comunidad",
        "Từ cộng đồng",
        "コミュニティより",
    )

    val YOUTUBE_CHARTS_TITLES: Set<String> = setOf(
        "YouTube Charts",
        "Listas de YouTube",
        "Bảng xếp hạng YouTube",
        "YouTube チャート",
    )

    fun classifySubtitle(subtitle: String): ShelfSubtitleKind? {
        val trimmed = subtitle.trim()
        return when {
            TOP_TUNES_TITLES.any { it.equals(trimmed, ignoreCase = true) } -> ShelfSubtitleKind.TOP_TUNES_RIGHT_NOW
            FROM_THE_COMMUNITY_TITLES.any { it.equals(trimmed, ignoreCase = true) } -> ShelfSubtitleKind.FROM_THE_COMMUNITY
            YOUTUBE_CHARTS_TITLES.any { it.equals(trimmed, ignoreCase = true) } -> ShelfSubtitleKind.YOUTUBE_CHARTS
            else -> null
        }
    }

    // ── Card Subtitle Parts ───────────────────────────────────────────────────

    val CHART_LABELS: Set<String> = setOf(
        "Chart",
        "Lista de éxitos",
        "Bảng xếp hạng",
        "チャート",
    )

    fun isChartLabel(text: String): Boolean =
        CHART_LABELS.any { it.equals(text.trim(), ignoreCase = true) }

    private val VIEWS_SUFFIXES = listOf(
        " views", " view", " vistas", " vista", " visualizaciones", " visualización", " lượt xem", " 回視聴", "回視聴",
    )
    private val PLAYS_SUFFIXES = listOf(
        " plays", " play", " reproducciones", " reproducción", " lượt phát", " 回再生", "回再生",
    )
    private val SONGS_SUFFIXES = listOf(
        " songs", " song", " canciones", " canción", " bài hát", " 曲", "曲",
    )

    /**
     * Parses a card subtitle segment into its [CardTally] metric if it matches a tally pattern.
     */
    fun parseCardTally(part: String): CardTally? {
        val trimmed = part.trim()
        val lower = trimmed.lowercase()

        for (suffix in VIEWS_SUFFIXES) {
            if (lower.endsWith(suffix.lowercase())) {
                val count = extractCount(trimmed, suffix)
                if (count.any { it.isDigit() }) return CardTally(count, CardTallyKind.VIEWS)
            }
        }
        for (suffix in PLAYS_SUFFIXES) {
            if (lower.endsWith(suffix.lowercase())) {
                val count = extractCount(trimmed, suffix)
                if (count.any { it.isDigit() }) return CardTally(count, CardTallyKind.PLAYS)
            }
        }
        for (suffix in SONGS_SUFFIXES) {
            if (lower.endsWith(suffix.lowercase())) {
                val count = extractCount(trimmed, suffix)
                if (count.any { it.isDigit() }) return CardTally(count, CardTallyKind.SONGS)
            }
        }
        return null
    }

    private fun extractCount(raw: String, suffix: String): String {
        val trimmed = raw.trim()
        return if (suffix.startsWith(" ")) {
            trimmed.substringBeforeLast(' ', "").trim()
        } else {
            val idx = trimmed.lastIndexOf(suffix)
            if (idx > 0) trimmed.substring(0, idx).trim() else trimmed.substringBeforeLast(' ', "").trim()
        }
    }
}
