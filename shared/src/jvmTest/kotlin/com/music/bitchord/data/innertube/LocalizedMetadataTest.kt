package com.music.bitchord.data.innertube

import com.music.bitchord.data.canvas.CanvasArtwork
import com.music.bitchord.data.model.SearchResult
import com.music.bitchord.data.model.ShelfLayout
import com.music.bitchord.data.model.ShelfTitles
import com.music.bitchord.data.model.isTally
import com.music.bitchord.data.model.isTypeWord
import com.music.bitchord.data.model.stripTypeSegments
import com.music.bitchord.data.model.typeOf
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The app sends its own language as `hl`, so YouTube labels rows in that
 * language: "Canción", "Álbum", "Vídeo". These are trimmed response shapes for
 * those rows. The parser has to read them structurally (the run's pageType)
 * and fall back to the word table only where a row carries no links.
 */
class LocalizedMetadataTest {

    private fun json(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject

    private fun artistRun(name: String, id: String = "UC_KEN") = """
        { "text": "$name", "navigationEndpoint": { "browseEndpoint": {
          "browseId": "$id", "browseEndpointContextSupportedConfigs": {
            "browseEndpointContextMusicConfig": { "pageType": "MUSIC_PAGE_TYPE_ARTIST" }
          }
        } } }
    """.trimIndent()

    private fun albumRun(name: String, id: String = "MPRE_AGK") = """
        { "text": "$name", "navigationEndpoint": { "browseEndpoint": {
          "browseId": "$id", "browseEndpointContextSupportedConfigs": {
            "browseEndpointContextMusicConfig": { "pageType": "MUSIC_PAGE_TYPE_ALBUM" }
          }
        } } }
    """.trimIndent()

    /** The runs of a subtitle, with the labels the request's `hl` asked for. */
    private fun subtitleRuns(
        typeLabel: String,
        artist: String,
        albumLabel: String,
        album: String,
        duration: String,
    ) = """
        [
          { "text": "$typeLabel" }, { "text": " • " },
          ${artistRun(artist)}, { "text": ", " }, { "text": "$albumLabel" },
          { "text": " • " }, ${albumRun(album)}, { "text": " • " },
          { "text": "$duration" }
        ]
    """.trimIndent()

    /** A responsive row's second flex column. */
    private fun rowSubtitle(
        typeLabel: String,
        artist: String,
        albumLabel: String,
        album: String,
        duration: String,
    ) = """{ "text": { "runs": ${subtitleRuns(typeLabel, artist, albumLabel, album, duration)} } }"""

    /** A card shelf's subtitle, which carries its runs directly. */
    private fun cardSubtitle(
        typeLabel: String,
        artist: String,
        albumLabel: String,
        album: String,
        duration: String,
    ) = """{ "runs": ${subtitleRuns(typeLabel, artist, albumLabel, album, duration)} }"""

    private fun responsiveRow(
        id: String,
        title: String,
        typeLabel: String,
        artist: String,
        albumLabel: String,
        album: String,
        duration: String,
    ) = """
        {
          "musicResponsiveListItemRenderer": {
            "playlistItemData": { "videoId": "$id" },
            "flexColumns": [
              { "musicResponsiveListItemFlexColumnRenderer": {
                "text": { "runs": [{ "text": "$title" }] }
              } },
              { "musicResponsiveListItemFlexColumnRenderer": ${rowSubtitle(
                  typeLabel, artist, albumLabel, album, duration,
              )} }
            ]
          }
        }
    """.trimIndent()

    private fun cardShelf(
        id: String,
        title: String,
        typeLabel: String,
        artist: String,
        albumLabel: String,
        album: String,
        duration: String,
    ) = """
        {
          "musicCardShelfRenderer": {
            "title": { "runs": [{ "text": "$title" }] },
            "subtitle": ${cardSubtitle(typeLabel, artist, albumLabel, album, duration)},
            "onTap": { "watchEndpoint": { "videoId": "$id" } }
          }
        }
    """.trimIndent()

    private fun searchSong(renderer: String) =
        InnertubeParser.parseSearchPage(json("""{ "contents": [ $renderer ] }"""))
            .rows.filterIsInstance<SearchResult.Track>().single().song

    private fun cardSong(renderer: String) =
        InnertubeParser.parseSearchPage(json("""{ "contents": [ $renderer ] }"""))
            .rows.filterIsInstance<SearchResult.TopTrack>().single().song

    @Test
    fun `spanish search row keeps the album label out of the artist`() {
        val song = searchSong(
            responsiveRow(
                "great-chaos", "A Great Chaos", "Canción", "Ken Carson", "Álbum", "A Great Chaos", "3:03",
            ),
        )

        assertEquals("Ken Carson", song.artist)
        assertEquals(listOf("Ken Carson"), song.artists.map { it.name })
        assertEquals("UC_KEN", song.artistId)
        assertEquals("A Great Chaos", song.albumName)
        assertEquals("MPRE_AGK", song.albumId)
        assertEquals("3:03", song.durationText)
        assertFalse(song.isVideo)
    }

    @Test
    fun `spanish promoted card keeps the album label out of the artist`() {
        val song = cardSong(
            cardShelf(
                "great-chaos", "A Great Chaos", "Canción", "Ken Carson", "Álbum", "A Great Chaos", "3:03",
            ),
        )

        assertEquals("Ken Carson", song.artist)
        assertEquals(listOf("Ken Carson"), song.artists.map { it.name })
        assertEquals("A Great Chaos", song.albumName)
        assertFalse(song.isVideo)
    }

    @Test
    fun `spanish video label marks the row as a video`() {
        val page = InnertubeParser.parseSearchPage(
            json(
                """{ "contents": [ ${
                    responsiveRow(
                        "great-chaos-video", "A Great Chaos", "Vídeo", "Ken Carson",
                        "Álbum", "A Great Chaos", "3:03",
                    )
                } ] }""",
            ),
            includeVideos = true,
        )
        val song = page.rows.filterIsInstance<SearchResult.Track>().single().song

        assertEquals("Ken Carson", song.artist)
        assertEquals("3:03", song.durationText)
        assertTrue(song.isVideo)
    }

    @Test
    fun `spanish album header credits its bare rows without an artist link`() {
        val page = json(
            """
            {
              "header": { "musicResponsiveHeaderRenderer": {
                "title": { "runs": [{ "text": "A Great Chaos" }] },
                "straplineTextOne": { "runs": [{ "text": "Ken Carson" }] },
                "subtitle": { "runs": [
                  { "text": "Álbum" }, { "text": " • " }, { "text": "2023" }
                ] }
              } },
              "contents": [{ "musicResponsiveListItemRenderer": {
                "playlistItemData": { "videoId": "great-chaos" },
                "flexColumns": [
                  { "musicResponsiveListItemFlexColumnRenderer": {
                    "text": { "runs": [{ "text": "A Great Chaos" }] }
                  } }
                ]
              } }]
            }
            """.trimIndent(),
        )

        val song = InnertubeParser.collectSongsDeep(page).single()
        assertEquals("Ken Carson", song.artist)
        assertFalse(song.isVideo)
    }

    @Test
    fun `spanish watch queue keeps the credit and the album`() {
        val page = json(
            """
            {
              "contents": [{ "playlistPanelVideoRenderer": {
                "videoId": "great-chaos",
                "title": { "runs": [{ "text": "A Great Chaos" }] },
                "longBylineText": { "runs": [
                  ${artistRun("Ken Carson")}, { "text": " • " },
                  { "text": "Álbum" }, { "text": " • " },
                  ${albumRun("A Great Chaos")}, { "text": " • " },
                  { "text": "2023" }
                ] },
                "lengthText": { "runs": [{ "text": "3:03" }] },
                "thumbnail": { "thumbnails": [{ "url": "https://example.test/cover.jpg" }] }
              } }]
            }
            """.trimIndent(),
        )

        val song = InnertubeParser.parseWatchQueue(page).single()
        assertEquals("Ken Carson", song.artist)
        assertEquals("A Great Chaos", song.albumName)
        assertEquals("MPRE_AGK", song.albumId)
        assertFalse(song.isVideo)
    }

    @Test
    fun `localised episode runtime is read as a duration`() {
        fun episode(videoId: String, runtime: String) = """
            { "musicMultiRowListItemRenderer": {
              "onTap": { "watchEndpoint": {
                "videoId": "$videoId",
                "watchEndpointMusicSupportedConfigs": { "watchEndpointMusicConfig": {
                  "musicVideoType": "MUSIC_VIDEO_TYPE_PODCAST_EPISODE"
                } }
              } },
              "title": { "runs": [{ "text": "Episode" }] },
              "playbackProgress": { "musicPlaybackProgressRenderer": {
                "durationText": { "runs": [{ "text": "$runtime" }] }
              } }
            } }
        """.trimIndent()

        val songs = InnertubeParser.collectSongsDeep(
            json("""{ "contents": [ ${episode("es", "2 horas 43 minutos")} ] }"""),
            "Un show",
        )
        assertEquals("2:43:00", songs.single().durationText)

        val german = InnertubeParser.collectSongsDeep(
            json("""{ "contents": [ ${episode("de", "2 Stunden 43 Minuten")} ] }"""),
            "Ein Podcast",
        )
        assertEquals("2:43:00", german.single().durationText)
    }

    @Test
    fun `english and spanish rows with linked artists produce the same track`() {
        val english = searchSong(
            responsiveRow("great-chaos", "A Great Chaos", "Song", "Ken Carson", "Album", "A Great Chaos", "3:03"),
        )
        val spanish = searchSong(
            responsiveRow("great-chaos", "A Great Chaos", "Canción", "Ken Carson", "Álbum", "A Great Chaos", "3:03"),
        )

        assertEquals(english.artist, spanish.artist)
        assertEquals(english.artists, spanish.artists)
        assertEquals(english.albumName, spanish.albumName)
        assertEquals(english.albumId, spanish.albumId)
        assertEquals(english.durationText, spanish.durationText)
        assertEquals(english.isVideo, spanish.isVideo)
    }

    @Test
    fun `type words and tally words are recognised in the supported languages`() {
        for ((label, type) in listOf(
            "Canción" to "song",
            "Canciones" to "song",
            "Álbum" to "album",
            "Vídeo" to "video",
            "Sencillo" to "single",
            "Artista" to "artist",
            "Lista de reproducción" to "playlist",
            "Episodio" to "episode",
            "Lagu" to "song",
            "Bài hát" to "song",
            "песня" to "song",
            "альбом" to "album",
            "गाना" to "song",
            "שיר" to "song",
            "曲" to "song",
            "노래" to "song",
        )) {
            assertEquals(type, typeOf(label), label)
            assertTrue(isTypeWord(label), label)
        }
        assertFalse(isTypeWord("Ken Carson"))
        assertTrue(isTally("12 M de reproducciones"))
        assertTrue(isTally("1.2K vistas"))
        assertTrue(isTally("2 hr 43 min"))
        // The two names the old English-only regex had to be careful about.
        assertFalse(isTally("21 Savage"))
        assertFalse(isTally("50 Cent"))
    }

    @Test
    fun `a type label is removed from a credit line before it is compared`() {
        assertEquals("Ken Carson", stripTypeSegments("Ken Carson, Álbum"))
        assertEquals("Ken Carson", stripTypeSegments("Ken Carson • Vídeo"))
        assertEquals("", stripTypeSegments("Álbum"))
        assertEquals("Ken Carson", stripTypeSegments("Ken Carson"))
        assertEquals("Earth, Wind & Fire", stripTypeSegments("Earth, Wind & Fire"))
    }

    @Test
    fun `canvas matching tolerates a label that survived in the credit`() {
        val clip = CanvasArtwork(
            url = "https://example.test/canvas.mp4",
            title = "A Great Chaos",
            artist = "Ken Carson",
            album = "A Great Chaos",
        )

        assertTrue(clip.matches("A Great Chaos", "Ken Carson, Álbum", "A Great Chaos"))
        assertTrue(clip.matches("A Great Chaos", "Álbum", "A Great Chaos"))

        val contaminated = clip.copy(artist = "Ken Carson, Álbum")
        assertTrue(contaminated.matches("A Great Chaos", "Ken Carson", "A Great Chaos"))
    }

    @Test
    fun `spanish home shelf Escuchar de nuevo gets LIST layout and is recognized by ShelfTitles`() {
        val homeJson = json("""
            {
              "contents": {
                "singleColumnBrowseResultsRenderer": {
                  "tabs": [
                    {
                      "tabRenderer": {
                        "content": {
                          "sectionListRenderer": {
                            "contents": [
                              {
                                "musicCarouselShelfRenderer": {
                                  "header": {
                                    "musicCarouselShelfBasicHeaderRenderer": {
                                      "title": { "runs": [{ "text": "Escuchar de nuevo" }] }
                                    }
                                  },
                                  "contents": [
                                    {
                                      "musicTwoRowItemRenderer": {
                                        "title": { "runs": [{ "text": "Track 1" }] },
                                        "subtitle": { "runs": [{ "text": "Artist 1" }] },
                                        "navigationEndpoint": {
                                          "watchEndpoint": { "videoId": "v1" }
                                        }
                                      }
                                    }
                                  ]
                                }
                              },
                              {
                                "musicCarouselShelfRenderer": {
                                  "header": {
                                    "musicCarouselShelfBasicHeaderRenderer": {
                                      "title": { "runs": [{ "text": "Selecciones rápidas" }] }
                                    }
                                  },
                                  "contents": [
                                    {
                                      "musicTwoRowItemRenderer": {
                                        "title": { "runs": [{ "text": "Track 2" }] },
                                        "subtitle": { "runs": [{ "text": "Artist 2" }] },
                                        "navigationEndpoint": {
                                          "watchEndpoint": { "videoId": "v2" }
                                        }
                                      }
                                    }
                                  ]
                                }
                              }
                            ]
                          }
                        }
                      }
                    }
                  ]
                }
              }
            }
        """.trimIndent())

        val shelves = InnertubeParser.parseHome(homeJson)
        assertEquals(2, shelves.size)

        val listenAgain = shelves[0]
        assertEquals("Escuchar de nuevo", listenAgain.title)
        assertEquals(ShelfLayout.LIST, listenAgain.layout)
        assertTrue(ShelfTitles.isListenAgainShelf(listenAgain.title))
        assertTrue(ShelfTitles.isHistoryOrRecentsShelf(listenAgain.title))

        val quickPicks = shelves[1]
        assertEquals("Selecciones rápidas", quickPicks.title)
        assertTrue(ShelfTitles.isQuickPicksFamilyShelf(quickPicks.title))
        assertFalse(ShelfTitles.isHistoryOrRecentsShelf(quickPicks.title))
    }
}
