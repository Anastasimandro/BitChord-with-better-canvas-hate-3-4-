package com.music.bitchord

import com.music.bitchord.data.SUPPORTED_LANGUAGES
import com.music.bitchord.data.languageDisplayName
import com.music.bitchord.data.languageDisplayNameDetailed
import com.music.bitchord.data.selfDisplayName
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.Locale
import javax.xml.parsers.DocumentBuilderFactory

/**
 * The language catalog has one canonical list — [SUPPORTED_LANGUAGES] — and
 * everything else is checked against it rather than hand-copied: the parity
 * test derives its locales from it structurally (see [LocaleStringsTest]),
 * and the platform's `locales_config.xml` is verified to cover it here. A new
 * language is therefore added in exactly one place, and forgetting any of the
 * three downstream artefacts fails a test instead of shipping silently.
 */
class LocalizationTest {

    @Test
    fun supportedLanguages_containsVietnamese() {
        assertNotNull(
            "Vietnamese language must be in SUPPORTED_LANGUAGES",
            SUPPORTED_LANGUAGES.firstOrNull { it.tag == "vi" },
        )
    }

    @Test
    fun supportedLanguages_haveRuntimeDisplayNames() {
        // Every entry's own-language spelling is derived (or overridden) at
        // runtime, so a missing name would show up here as a blank row rather
        // than as a crash when the picker renders it.
        for (language in SUPPORTED_LANGUAGES) {
            assertTrue(
                "Language ${language.tag} must have a display name",
                language.selfDisplayName().isNotBlank(),
            )
        }
    }

    @Test
    fun languageDisplayName_resolvesAtRuntime() {
        // Names come from the platform's locale data, not from resources: the
        // same tag spells differently per reading language, and the pickers
        // rely on that rather than on per-language pointer keys.
        assertEquals("Vietnamese", languageDisplayName("vi", Locale.forLanguageTag("en")))
        assertEquals("español", languageDisplayName("es", Locale.forLanguageTag("es")))
        // The detailed form keeps the script distinction the plain display
        // language drops for Chinese — which is why the catalog carries a
        // 简体中文/繁體中文 pair at all.
        assertEquals(
            "Chinese (Simplified)",
            languageDisplayNameDetailed("zh-CN", Locale.forLanguageTag("en")),
        )
    }

    @Test
    fun localesConfig_matchesSupportedLanguages() {
        val projectRoot = File(".").canonicalFile
        val resDir = if (File(projectRoot, "app/src/main/res").exists()) {
            File(projectRoot, "app/src/main/res")
        } else {
            File(projectRoot, "src/main/res")
        }
        val localesConfigFile = File(resDir, "xml/locales_config.xml")
        assertTrue("locales_config.xml must exist", localesConfigFile.exists())

        val factory = DocumentBuilderFactory.newInstance()
        val builder = factory.newDocumentBuilder()
        val doc = builder.parse(localesConfigFile)
        val localeNodes = doc.getElementsByTagName("locale")

        val configuredLocales = mutableListOf<String>()
        for (i in 0 until localeNodes.length) {
            val node = localeNodes.item(i)
            val name = node.attributes.getNamedItem("android:name")?.nodeValue
            if (name != null) configuredLocales.add(name)
        }

        assertTrue("locales_config.xml must include 'vi'", configuredLocales.contains("vi"))

        // One direction only, deliberately: the platform file carries a bare
        // "zh" for the system picker that the catalog intentionally does not
        // mirror (the catalog's zh-CN/zh-TW pair is what resource resolution
        // needs — see the comment on AppLanguage). What matters here is that
        // no catalog language is missing from the platform's list.
        for (lang in SUPPORTED_LANGUAGES) {
            assertTrue(
                "locales_config.xml must include '${lang.tag}'",
                configuredLocales.contains(lang.tag),
            )
        }

        // Bare "zh" is not listed: the only writers of per-app locales are
        // AppLanguageDialog (catalog tags zh-CN/zh-TW only) and the one-time
        // script-tag migration in BitChordApplication (zh-Hant→zh-TW,
        // zh-Hans→zh-CN). Nothing can produce a bare "zh" entry, and
        // LocaleTags.normalizeAppTag maps any persisted legacy "zh" to
        // Simplified before it could ever be written back.
        assertTrue(
            "locales_config.xml must not carry a bare 'zh' entry",
            !configuredLocales.contains("zh"),
        )
    }
}
