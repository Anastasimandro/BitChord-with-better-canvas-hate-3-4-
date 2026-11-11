package com.music.bitchord.data

import java.util.Locale

/**
 * The single canonical list of languages the app offers.
 *
 * This file lives in `shared` so every surface (phone, TV, Wear pickers) and
 * every test sees the same list. Everything downstream derives from it:
 * `locales_config.xml`, the resource folders per module, and all parity tests
 * (`LocaleStringsTest`, `LocalizationTest`, the sharedUi parity test). Adding
 * a language means adding it here plus the mechanical resource folders —
 * nowhere else.
 *
 * Moved verbatim from `app/.../ui/components/AppLanguageDialog.kt`, where it
 * sat in the UI layer and was unreachable from `shared`/`sharedUi`.
 */

/** Language tag paired with an optional display-name override.
 *
 * Tags carry a region (`zh-CN` / `zh-TW`, not bare `zh-Hans` / `zh-Hant`):
 * Android Views understand script qualifiers (`values-b+zh+Hant`) but the
 * shared Compose resources only match language + region, so a region-less
 * script tag shows Traditional in Settings and Simplified on the player.
 * [LocaleTags.normalizeAppTag] maps both forms to the same script downstream.
 *
 * [nativeName] is the row's own-language spelling when CLDR's is not the one
 * this app shows — blank means derive it at runtime, see [selfDisplayName].
 */
data class AppLanguage(val tag: String, val nativeName: String = "")

/**
 * The catalog. A language is added here and nowhere else.
 *
 * The resource system reads it (LocaleStringsTest, LocalizationTest and
 * locales_config.xml are all checked against it), so a language is added here
 * and nowhere else. There are no pointer resources per language ("English",
 * "Spanish", …): names come from CLDR at runtime — a language's own spelling
 * and its spelling in the current language — because a name that needs a
 * translation is one more key to keep in step in eighteen files, for data the
 * platform already carries.
 */
val SUPPORTED_LANGUAGES = listOf(
    AppLanguage("en"),
    AppLanguage("es", "Español"),
    AppLanguage("fr", "Français"),
    AppLanguage("de"),
    AppLanguage("pl", "Polski"),
    AppLanguage("pt", "Português"),
    AppLanguage("id"),
    AppLanguage("hi"),
    AppLanguage("ja"),
    AppLanguage("ru", "Русский"),
    AppLanguage("zh-CN", "简体中文"),
    AppLanguage("zh-TW", "繁體中文"),
    AppLanguage("he"),
    AppLanguage("it", "Italiano"),
    AppLanguage("tr"),
    AppLanguage("th"),
    AppLanguage("vi"),
    AppLanguage("ko"),
)

/**
 * The language's name in its own language — "Deutsch", "日本語" — as the row
 * leads with it.
 *
 * Most entries trust CLDR's self-name, which reads exactly as shipped here
 * (verified against `Locale.forLanguageTag(tag).getDisplayLanguage(...)` for
 * English, German and Japanese before dropping their literals). The eight
 * overrides exist for the two ways CLDR's is not the right spelling for a
 * standalone row: languages whose own orthography writes a mid-sentence name
 * in lower case — "español", "français", "polski", "português", "русский",
 * "italiano" — where the list keeps the capitalised standalone form; and the
 * two Chinese tags, whose CLDR display language is "中文" for both and would
 * lose the Simplified/Traditional distinction the row is there to show.
 */
fun AppLanguage.selfDisplayName(): String =
    nativeName.ifBlank {
        val locale = Locale.forLanguageTag(tag)
        locale.getDisplayLanguage(locale)
    }

/**
 * The language's name in [displayLocale]'s spelling — the subtitle under a
 * row: "Spanish" while the app runs in English, "español" while in Spanish.
 * Falls back to the tag itself when there is no name to show.
 */
fun languageDisplayName(languageTag: String, displayLocale: Locale = Locale.getDefault()): String =
    Locale.forLanguageTag(LocaleTags.normalizeAppTag(languageTag))
        .getDisplayLanguage(displayLocale)
        .ifBlank { languageTag }

/**
 * [languageDisplayName], keeping script and region — "Chinese (Simplified)",
 * not "中文". For a summary line that must tell the two Chinese catalogues
 * apart where the language picker's own rows already do.
 */
fun languageDisplayNameDetailed(languageTag: String, displayLocale: Locale = Locale.getDefault()): String =
    Locale.forLanguageTag(LocaleTags.normalizeAppTag(languageTag))
        .getDisplayName(displayLocale)
        .ifBlank { languageTag }
