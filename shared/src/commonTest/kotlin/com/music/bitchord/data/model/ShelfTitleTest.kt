package com.music.bitchord.data.model

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ShelfTitleTest {

    @Test
    fun listenAgainCanonicalTitlesClassifyCorrectly() {
        val canonical = listOf(
            "Listen again",
            "Escuchar de nuevo",
            "Réécouter",
            "Erneut anhören",
            "Ascolta di nuovo",
            "Ouvir de novo",
            "Nghe lại",
            "もう一度聴く",
        )
        for (title in canonical) {
            assertTrue(ShelfTitles.isListenAgainShelf(title), "Failed for '$title'")
            assertTrue(ShelfTitles.isHistoryOrRecentsShelf(title), "Failed history/recents for '$title'")
            assertEquals(ShelfKind.LISTEN_AGAIN, ShelfTitles.classifyShelf(title), "Classification failed for '$title'")
        }
    }

    @Test
    fun recentsCanonicalTitlesClassifyCorrectly() {
        val canonical = listOf(
            "Recents",
            "Recently played",
            "Recientes",
            "Gần đây",
            "最近",
        )
        for (title in canonical) {
            assertTrue(ShelfTitles.isRecentsShelf(title), "Failed for '$title'")
            assertTrue(ShelfTitles.isHistoryOrRecentsShelf(title), "Failed history/recents for '$title'")
            assertEquals(ShelfKind.RECENTS, ShelfTitles.classifyShelf(title), "Classification failed for '$title'")
        }
    }

    @Test
    fun historyCanonicalTitlesClassifyCorrectly() {
        val canonical = listOf(
            "History",
            "Listening history",
        )
        for (title in canonical) {
            assertTrue(ShelfTitles.isHistoryShelf(title), "Failed for '$title'")
            assertTrue(ShelfTitles.isHistoryOrRecentsShelf(title), "Failed history/recents for '$title'")
        }
    }

    @Test
    fun quickPicksFamilyClassifiesQuickPicksAndMixedForYou() {
        val qpTitles = listOf(
            "Quick picks",
            "Selecciones rápidas",
            "Elección rápida",
            "Lựa chọn nhanh",
            "Chọn nhanh đài phát",
            "クイック ミックス",
        )
        for (title in qpTitles) {
            assertTrue(ShelfTitles.isQuickPicksFamilyShelf(title), "Failed for '$title'")
            assertEquals(ShelfKind.QUICK_PICKS, ShelfTitles.classifyShelf(title))
        }

        val mixedTitles = listOf(
            "Mixed for you",
            "Mezclas para ti",
            "Dành riêng cho bạn",
            "ミックス",
        )
        for (title in mixedTitles) {
            assertTrue(ShelfTitles.isQuickPicksFamilyShelf(title), "Failed mixed for '$title'")
            assertEquals(ShelfKind.MIXED_FOR_YOU, ShelfTitles.classifyShelf(title))
        }

        val recTitles = listOf(
            "Recommended",
            "Recommendations",
            "For you",
            "Para ti",
            "Dành cho bạn",
            "あなたへのおすすめ",
        )
        for (title in recTitles) {
            assertTrue(ShelfTitles.isQuickPicksFamilyShelf(title), "Failed rec for '$title'")
        }
    }

    @Test
    fun whitespaceToleranceAndNonMatchingTitlesDoNotBreak() {
        // Leading / trailing whitespace
        assertTrue(ShelfTitles.isListenAgainShelf("  Escuchar de nuevo  "))
        assertTrue(ShelfTitles.isRecentsShelf("\nRecientes\t"))
        assertTrue(ShelfTitles.isQuickPicksFamilyShelf("  Selecciones rápidas  "))

        // Names and type words should NOT be recognized as shelf titles
        assertFalse(ShelfTitles.isListenAgainShelf("Ken Carson"))
        assertFalse(ShelfTitles.isListenAgainShelf("Álbum"))
        assertFalse(ShelfTitles.isRecentsShelf("Ken Carson"))
        assertFalse(ShelfTitles.isRecentsShelf("Álbum"))
        assertNull(ShelfTitles.classifyShelf("Ken Carson"))
        assertNull(ShelfTitles.classifyShelf("Álbum"))
    }

    @Test
    fun shelfLayoutForRecognizesListenAgainAcrossLanguages() {
        val sampleItem = listOf(ShelfItem("id1", "Track 1", null, "vid1", null))

        // Listen again in multiple languages should get LIST
        assertEquals(ShelfLayout.LIST, shelfLayoutFor("Listen again", sampleItem, fromList = false))
        assertEquals(ShelfLayout.LIST, shelfLayoutFor("Escuchar de nuevo", sampleItem, fromList = false))
        assertEquals(ShelfLayout.LIST, shelfLayoutFor("Réécouter", sampleItem, fromList = false))
        assertEquals(ShelfLayout.LIST, shelfLayoutFor("Erneut anhören", sampleItem, fromList = false))
        assertEquals(ShelfLayout.LIST, shelfLayoutFor("Ascolta di nuovo", sampleItem, fromList = false))
        assertEquals(ShelfLayout.LIST, shelfLayoutFor("Ouvir de novo", sampleItem, fromList = false))
        assertEquals(ShelfLayout.LIST, shelfLayoutFor("Nghe lại", sampleItem, fromList = false))
        assertEquals(ShelfLayout.LIST, shelfLayoutFor("もう一度聴く", sampleItem, fromList = false))

        // Tolerates extra whitespace
        assertEquals(ShelfLayout.LIST, shelfLayoutFor("  Escuchar de nuevo  ", sampleItem, fromList = false))

        // Unrecognized titles with fromList=false fallback to CARDS
        assertEquals(ShelfLayout.CARDS, shelfLayoutFor("Unrecognized Shelf", sampleItem, fromList = false))
        assertEquals(ShelfLayout.CARDS, shelfLayoutFor("Ken Carson", sampleItem, fromList = false))
        assertEquals(ShelfLayout.CARDS, shelfLayoutFor("Álbum", sampleItem, fromList = false))
    }

    @Test
    fun similarToArtistExtraction() {
        assertEquals("Radiohead", ShelfTitles.extractSimilarToArtist("Similar to Radiohead"))
        assertEquals("Rosalía", ShelfTitles.extractSimilarToArtist("Similar a Rosalía"))
        assertEquals("Sơn Tùng", ShelfTitles.extractSimilarToArtist("Tương tự như Sơn Tùng"))
        assertNull(ShelfTitles.extractSimilarToArtist("Listen again"))
        assertNull(ShelfTitles.extractSimilarToArtist("Trending"))
    }

    @Test
    fun cardTallyParsing() {
        val views = ShelfTitles.parseCardTally("12M visualizaciones")
        assertEquals("12M", views?.count)
        assertEquals(CardTallyKind.VIEWS, views?.kind)

        val plays = ShelfTitles.parseCardTally("150K reproducciones")
        assertEquals("150K", plays?.count)
        assertEquals(CardTallyKind.PLAYS, plays?.kind)

        val songs = ShelfTitles.parseCardTally("14 canciones")
        assertEquals("14", songs?.count)
        assertEquals(CardTallyKind.SONGS, songs?.kind)

        val jaPlays = ShelfTitles.parseCardTally("12万回再生")
        assertEquals("12万", jaPlays?.count)
        assertEquals(CardTallyKind.PLAYS, jaPlays?.kind)

        assertNull(ShelfTitles.parseCardTally("Ken Carson"))
        assertNull(ShelfTitles.parseCardTally("Canción"))
    }
}
