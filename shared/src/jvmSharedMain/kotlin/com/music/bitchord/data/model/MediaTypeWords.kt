package com.music.bitchord.data.model

import java.text.Normalizer
import java.util.Locale

private val COMBINING_MARKS = Regex("\\p{InCombiningDiacriticalMarks}+")
private val WHITESPACE = Regex("\\s+")

/**
 * The words YouTube Music uses to label what a row *is* — "Song", "Album",
 * "Video" — in every language the app can run in.
 *
 * The app sends its own language as `hl`, which is deliberate: a listener who
 * picked Spanish should get Spanish names, dates and labels from YouTube. But
 * the row type is not decoration: the parser uses it to keep "Album" out of
 * the artist credit and to tell a music video from a catalogue track. Until
 * this table existed, only the English words were known, so with `hl=es` the
 * word "Álbum" looked like an artist's name and was joined onto the credit.
 *
 * This is deliberately a *word* table rather than a locale switch. The parser
 * does not know which language a response came from, and does not need to:
 * a segment that is exactly one of these words is a label, never a name. The
 * structural signal (`pageType` on a run's browse endpoint) remains the first
 * choice; this is the fallback for rows that carry no links at all.
 */
private val TYPE_WORDS: Map<String, String> = buildMap {
    fun add(type: String, vararg words: String) {
        words.forEach { put(normalizeTypeToken(it), type) }
    }

    add(
        "song",
        "song", "songs", "track", "tracks",
        // Spanish
        "canción", "canciones", "tema", "temas", "pista", "pistas",
        // French
        "titre", "titres", "chanson", "chansons", "morceau", "morceaux",
        // German
        "titel", "lied", "lieder",
        // Polish
        "piosenka", "piosenki", "utwór", "utwory", "kawałek", "kawałki",
        // Portuguese
        "música", "músicas", "canção", "canções", "faixa", "faixas",
        // Indonesian
        "lagu", "lagu-lagu",
        // Hindi
        "गाना", "गाने", "गीत", "गीतों", "ट्रैक",
        // Japanese
        "曲", "楽曲", "歌",
        // Russian
        "песня", "песни", "трек", "треки", "композиция",
        // Chinese
        "歌曲", "歌",
        // Hebrew
        "שיר", "שירים", "רצועה", "רצועות",
        // Italian
        "brano", "brani", "canzone", "canzoni", "traccia",
        // Turkish
        "şarkı", "şarkılar", "parça", "parçalar",
        // Thai
        "เพลง",
        // Vietnamese
        "bài hát", "ca khúc",
        // Korean
        "노래", "곡", "트랙",
    )

    add(
        "video",
        "video", "videos", "music video", "music videos", "clip", "clips",
        // Spanish
        "vídeo", "vídeos", "videoclip", "videoclips",
        // French
        "vidéo", "vidéos",
        // German
        "musikvideo", "musikvideos",
        // Polish
        "wideo", "teledysk", "teledyski", "film",
        // Portuguese
        "videoclipe", "videoclipes",
        // Indonesian
        "video musik", "klip",
        // Hindi
        "वीडियो", "वीडियोज़", "म्यूज़िक वीडियो",
        // Japanese
        "動画", "ビデオ", "ミュージックビデオ",
        // Russian
        "видео", "клип", "клипы", "видеоклип",
        // Chinese
        "视频", "影片", "音乐视频", "視頻", "音樂影片",
        // Hebrew
        "סרטון", "סרטונים", "וידאו", "קליפ",
        // Italian
        "videoclip",
        // Turkish
        "video klibi",
        // Thai
        "มิวสิกวิดีโอ",
        // Vietnamese
        "video âm nhạc",
        // Korean
        "동영상", "비디오", "뮤직비디오",
    )

    add(
        "album",
        "album", "albums",
        // Spanish
        "álbum", "álbumes", "disco", "discos",
        // German
        "alben",
        // Polish
        "albumy", "płyta", "płyty",
        // Portuguese
        "álbum", "álbuns",
        // Indonesian
        "album musik",
        // Hindi
        "एल्बम", "एल्बम्स", "एल्बमें",
        // Japanese
        "アルバム",
        // Russian
        "альбом", "альбомы",
        // Chinese
        "专辑", "專輯",
        // Hebrew
        "אלבום", "אלבומים",
        // Turkish
        "albüm", "albümler",
        // Thai
        "อัลบั้ม",
        // Korean
        "앨범",
    )

    add(
        "single",
        "single", "singles",
        // Spanish
        "sencillo", "sencillos",
        // Polish
        "singel",
        // Indonesian
        "singel",
        // Hindi
        "सिंगल", "सिंगल्स",
        // Japanese
        "シングル",
        // Russian
        "сингл", "синглы",
        // Chinese
        "单曲", "單曲",
        // Hebrew
        "סינגל", "סינגלים",
        // Italian
        "singolo", "singoli",
        // Turkish
        "tekli", "tekliler",
        // Thai
        "ซิงเกิล",
        // Vietnamese
        "đĩa đơn",
        // Korean
        "싱글",
    )

    add(
        "ep",
        "ep", "eps",
        // Hindi
        "ईपी", "ई.पी.",
        // Russian
        "мини-альбом",
        // Chinese
        "迷你专辑", "迷你專輯",
        // Hebrew
        "אי.פי", "מיני-אלבום",
    )

    add(
        "artist",
        "artist", "artists",
        // Spanish
        "artista", "artistas",
        // French
        "artiste", "artistes",
        // German
        "künstler", "künstlerin", "künstlerinnen", "interpret", "interpreten",
        // Polish
        "artysta", "artyści", "wykonawca", "wykonawcy",
        // Portuguese
        "artista", "artistas",
        // Indonesian
        "artis",
        // Hindi
        "कलाकार", "कलाकारों",
        // Japanese
        "アーティスト", "ミュージシャン",
        // Russian
        "исполнитель", "исполнители", "артист", "артисты",
        // Chinese
        "艺人", "艺术家", "歌手", "藝人", "藝術家",
        // Hebrew
        "אמן", "אמנים", "אומן", "זמר",
        // Italian
        "artista", "artisti",
        // Turkish
        "sanatçı", "sanatçılar",
        // Thai
        "ศิลปิน",
        // Vietnamese
        "nghệ sĩ",
        // Korean
        "아티스트", "가수",
    )

    add(
        "playlist",
        "playlist", "playlists",
        // Spanish
        "lista de reproducción", "listas de reproducción",
        // French
        "liste de lecture", "listes de lecture",
        // German
        "wiedergabeliste", "wiedergabelisten",
        // Polish
        "playlista", "playlisty", "lista odtwarzania", "listy odtwarzania",
        // Portuguese
        "lista de reprodução", "listas de reprodução",
        // Indonesian
        "daftar putar",
        // Hindi
        "प्लेलिस्ट", "प्लेलिस्ट्स", "प्लेलिस्टें",
        // Japanese
        "プレイリスト", "再生リスト",
        // Russian
        "плейлист", "плейлисты", "список воспроизведения",
        // Chinese
        "播放列表", "歌单", "播放清單", "歌單",
        // Hebrew
        "פלייליסט", "פלייליסטים", "רשימת השמעה", "רשימות השמעה",
        // Italian
        "playlist",
        // Turkish
        "çalma listesi", "çalma listeleri",
        // Thai
        "เพลย์ลิสต์", "รายการเพลง",
        // Vietnamese
        "danh sách phát",
        // Korean
        "재생목록", "플레이리스트",
    )

    add(
        "podcast",
        "podcast", "podcasts",
        // Spanish
        "pódcast", "pódcasts",
        // French
        "balado",
        // Polish
        "podcasty",
        // Indonesian
        "siniar",
        // Hindi
        "पॉडकास्ट", "पॉडकास्ट्स",
        // Japanese
        "ポッドキャスト",
        // Russian
        "подкаст", "подкасты",
        // Chinese
        "播客",
        // Hebrew
        "פודקאסט", "פודקאסטים",
        // Turkish
        "podcastler",
        // Thai
        "พอดแคสต์",
        // Korean
        "팟캐스트",
    )

    add(
        "episode",
        "episode", "episodes",
        // Spanish
        "episodio", "episodios",
        // French
        "épisode", "épisodes",
        // German
        "folge", "folgen", "episoden",
        // Polish
        "odcinek", "odcinki",
        // Portuguese
        "episódio", "episódios",
        // Indonesian
        "episode",
        // Hindi
        "एपिसोड", "एपिसोड्स",
        // Japanese
        "エピソード", "放送回",
        // Russian
        "эпизод", "эпизоды", "выпуск", "выпуски",
        // Chinese
        "单集", "剧集", "集", "單集", "劇集",
        // Hebrew
        "פרק", "פרקים",
        // Italian
        "episodio", "episodi",
        // Turkish
        "bölüm", "bölümler",
        // Thai
        "ตอน",
        // Vietnamese
        "tập",
        // Korean
        "에피소드", "회차",
    )
}

/** The canonical type a label word names, or null when it is not a type word. */
fun typeOf(text: String): String? = TYPE_WORDS[normalizeTypeToken(text)]

/** Whether [text] is exactly one of YouTube's row-type labels in any language. */
fun isTypeWord(text: String): Boolean = typeOf(text) != null

/** Whether [text] is the word a release header uses — "Album", "Single", "EP". */
fun isReleaseWord(text: String): Boolean = typeOf(text) in RELEASE_TYPES

private val RELEASE_TYPES = setOf("album", "single", "ep")

/**
 * A counted quantity rather than a name — "12.4M plays", "13 songs",
 * "1 hour, 4 minutes", "12 M de reproducciones". Deliberately narrow: it has
 * to leave "21 Savage" and "50 Cent" alone, so a number only disqualifies a
 * segment when it is counting one of the words YouTube counts with.
 *
 * The text is folded first, so accented labels ("reproduções") and the
 * languages' own unit words match the same table. The multiplier is optional
 * because the scripts that write "12万回再生" do not put a space before it.
 */
fun isTally(text: String): Boolean = TALLY.matches(normalizeTypeToken(text))

private val TALLY_WORDS: List<String> = listOf(
    // English
    "play", "plays", "view", "views", "like", "likes", "song", "songs",
    "track", "tracks", "subscriber", "subscribers", "hour", "hours", "hr",
    "hrs", "minute", "minutes", "min", "mins", "second", "seconds", "sec", "secs",
    // Spanish
    "reproducción", "reproducciones", "vista", "vistas", "visualización",
    "visualizaciones", "me gusta", "suscriptor", "suscriptores", "canción",
    "canciones", "hora", "horas", "minuto", "minutos", "segundo", "segundos",
    // French
    "écoute", "écoutes", "vue", "vues", "j'aime", "abonné", "abonnés",
    "titre", "titres", "chanson", "chansons", "heure", "heures", "minute",
    "minutes", "seconde", "secondes",
    // German
    "wiedergabe", "wiedergaben", "aufruf", "aufrufe", "gefällt mir",
    "gefallt mir", "abonnent", "abonnenten", "lied", "lieder", "stunde",
    "stunden", "minute", "minuten", "sekunde", "sekunden",
    // Polish
    "odsłuchanie", "odsłuchania", "wyświetlenie", "wyświetlenia",
    "polubienie", "polubienia", "subskrybent", "subskrybenci", "utwór",
    "utwory", "godzina", "godziny", "minuta", "minuty", "sekunda", "sekundy",
    // Portuguese
    "reprodução", "reproduções", "visualização", "visualizações", "curtida",
    "curtidas", "inscrito", "inscritos", "música", "músicas", "hora", "horas",
    "minuto", "minutos", "segundo", "segundos",
    // Indonesian
    "pemutaran", "tayangan", "suka", "pelanggan", "lagu", "jam", "menit", "detik",
    // Hindi
    "बार", "प्ले", "व्यूज़", "पसंद", "सदस्य", "गाना", "गाने", "गीत",
    "घंटा", "घंटे", "मिनट", "सेकंड",
    // Japanese
    "再生", "回再生", "視聴", "回視聴", "高評価", "登録者", "曲", "時間", "分", "秒",
    // Russian
    "воспроизведение", "воспроизведений", "просмотр", "просмотров", "лайк",
    "лайков", "подписчик", "подписчиков", "песня", "песни", "час", "часа",
    "часов", "минута", "минуты", "минут", "секунда", "секунды", "секунд",
    // Chinese
    "播放", "次播放", "观看", "次观看", "点赞", "订阅者", "歌曲", "小时",
    "小時", "分钟", "分鐘", "秒",
    // Hebrew
    "השמעה", "השמעות", "צפייה", "צפיות", "לייק", "לייקים", "מנוי", "מנויים",
    "שיר", "שירים", "שעה", "שעות", "דקה", "דקות", "שנייה", "שניות",
    // Italian
    "riproduzione", "riproduzioni", "visualizzazione", "visualizzazioni",
    "mi piace", "iscritto", "iscritti", "brano", "brani", "canzone",
    "canzoni", "ora", "ore", "minuto", "minuti", "secondo", "secondi",
    // Turkish
    "dinlenme", "dinlenmeler", "görüntüleme", "beğenme", "abone", "aboneler",
    "şarkı", "saat", "dakika", "saniye",
    // Thai
    "ครั้ง", "การเล่น", "ถูกใจ", "ผู้ติดตาม", "เพลง", "ชั่วโมง", "นาที", "วินาที",
    // Vietnamese
    "lượt phát", "lượt xem", "lượt thích", "người đăng ký", "bài hát",
    "giờ", "phút", "giây",
    // Korean
    "재생", "회", "좋아요", "구독자", "곡", "노래", "시간", "분", "초",
).map(::normalizeTypeToken)

private val TALLY = Regex(
    """^[\d.,]+\s*(?:[kmb]|mil|milh(?:ão|ões|ao|oes)|million|millions|""" +
        """millionen|mille|tausend|тыс|млн|万|萬|億|천|만)?\s*""" +
        """(?:de\s+|von\s+|di\s+|d'|d’|da\s+|do\s+)?(?:""" +
        TALLY_WORDS.joinToString("|") { Regex.escape(it) } +
        """)(?=$|[^\p{L}\p{N}]).*""",
    RegexOption.IGNORE_CASE,
)

/**
 * Removes the segments of a credit line that are labels rather than names.
 *
 * A contaminated row reads "Ken Carson, Álbum" — the artist run followed by
 * the album's type label. The structural reader already prefers the run that
 * links to an artist page, so this is the last line of defence for rows where
 * that link is missing, and for tracks already in a queue or a cache from
 * before the parser knew the word. It is also what keeps [CanvasArtwork.matches]
 * from rejecting a clip because "Álbum" is not one of the provider's artists.
 *
 * A line with nothing to remove is returned exactly as written. When something
 * is removed the remaining names are joined with ", " — the same separator the
 * parser writes when it reads a byline.
 */
fun stripTypeSegments(artist: String): String {
    val text = artist.trim()
    if (text.isEmpty()) return text
    val parts = text.split(CreditJoiner).map { it.trim() }.filter { it.isNotEmpty() }
    val kept = parts.filterNot { isTypeWord(it) || isTally(it) }
    if (kept.size == parts.size) return text
    return kept.joinToString(", ")
}

/**
 * Folds a label to the form all its spellings have in common: case, accents
 * and spacing. Scripts without case are left untouched, which is why the
 * Devanagari, CJK, Thai and Hebrew tables are compared as written.
 */
fun normalizeTypeToken(raw: String): String =
    Normalizer.normalize(raw, Normalizer.Form.NFD)
        .replace(COMBINING_MARKS, "")
        .lowercase(Locale.ROOT)
        .replace(WHITESPACE, " ")
        .trim()
