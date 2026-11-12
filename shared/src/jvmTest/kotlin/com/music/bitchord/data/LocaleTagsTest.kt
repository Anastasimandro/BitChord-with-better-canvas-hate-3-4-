package com.music.bitchord.data

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * LocaleTags is the single tag-normalization point, so the invariants the rest
 * of the language system leans on live here: Chinese compares script-aware
 * (the bug a base-language reduction reintroduces silently), legacy Google
 * spellings normalize, and the wire helper always hyphenates.
 */
class LocaleTagsTest {

    @Test
    fun `Chinese scripts compare as different languages`() {
        assertFalse(LocaleTags.sameLanguageScriptAware("zh-TW", "zh-CN"))
        assertFalse(LocaleTags.sameLanguageScriptAware("zh-Hant", "zh-Hans"))
    }

    @Test
    fun `same script compares as the same language`() {
        assertTrue(LocaleTags.sameLanguageScriptAware("zh-TW", "zh-Hant"))
        assertTrue(LocaleTags.sameLanguageScriptAware("zh-CN", "zh-Hans"))
        assertTrue(LocaleTags.sameLanguageScriptAware("zh-TW", "zh_TW"))
        assertTrue(LocaleTags.sameLanguageScriptAware("en", "en-US"))
    }

    @Test
    fun `bare zh does not collapse into either script`() {
        // A base-language reduction would call bare "zh" equal to zh-Hans and
        // skip a translation the reader actually asked for.
        assertFalse(LocaleTags.sameLanguageScriptAware("zh", "zh-Hans"))
        assertFalse(LocaleTags.sameLanguageScriptAware("zh", "zh-Hant"))
    }

    @Test
    fun `legacy Google spellings normalize`() {
        assertTrue(LocaleTags.sameLanguageScriptAware("iw", "he"))
        assertTrue(LocaleTags.sameLanguageScriptAware("in", "id"))
        assertTrue(LocaleTags.sameLanguageScriptAware("ji", "yi"))
        assertEquals("he", LocaleTags.normalizeAppTag("iw"))
        assertEquals("id", LocaleTags.normalizeAppTag("in"))
        assertEquals("yi", LocaleTags.normalizeAppTag("ji"))
        // jw is not a JVM-legacy code, so only the explicit fixup maps it.
        assertEquals("jv", LocaleTags.normalizeAppTag("jw"))
    }

    @Test
    fun `ytHl maps Chinese scripts to region tags with hyphens`() {
        assertEquals("zh-TW", LocaleTags.ytHl("zh-Hant"))
        assertEquals("zh-CN", LocaleTags.ytHl("zh-Hans"))
        assertEquals("zh-TW", LocaleTags.ytHl("zh_TW"))
        assertEquals("zh-CN", LocaleTags.ytHl("zh"))
        assertEquals("pt", LocaleTags.ytHl("pt-BR"))
        assertEquals("en", LocaleTags.ytHl("en-US"))
    }

    @Test
    fun `translationWireTarget never sends bare zh`() {
        assertEquals("zh-TW", LocaleTags.translationWireTarget("zh-Hant"))
        assertEquals("zh-TW", LocaleTags.translationWireTarget("zh-TW"))
        assertEquals("zh-CN", LocaleTags.translationWireTarget("zh-Hans"))
        assertEquals("zh-CN", LocaleTags.translationWireTarget("zh-CN"))
        assertEquals("zh-TW", LocaleTags.translationWireTarget("zh-HK"))
        assertEquals("pt", LocaleTags.translationWireTarget("pt-BR"))
    }
}
