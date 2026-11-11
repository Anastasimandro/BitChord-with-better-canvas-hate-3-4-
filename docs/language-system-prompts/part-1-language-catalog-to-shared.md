# Part 1 — Move the canonical language catalog into `shared`

You are working in the BitChord repository (Kotlin Multiplatform Android app; Gradle modules
`:app`, `:tv`, `:wearos`, `:shared`, `:sharedUi`; `web/` and `backend/` are separate npm/other
projects). Code comments are written in English — keep that style. Do not change behavior in
this part; it is a pure relocation.

## Fresh-session bootstrap (read first)

- Work in the repo root `C:\Users\A\Proyectos\BitChord-with-better-canvas-hate-3-4-`
  (Windows: invoke Gradle as `.\gradlew` or `gradlew.bat`). Every path below is relative to that root.
- This prompt is self-contained: no prior conversation or document is needed. Line numbers were
  verified on 2026-11-11 — re-check each cited line before editing.
- **Pre-flight**: open `app/src/main/java/com/music/bitchord/ui/components/AppLanguageDialog.kt`.
  If it still defines `AppLanguage` / `SUPPORTED_LANGUAGES` locally, proceed. If instead
  `shared/src/jvmSharedMain/kotlin/com/music/bitchord/data/LanguageCatalog.kt` already exists with
  the same content, Part 1 is already done — verify the acceptance criteria below and stop.
- **Report format**: when done, list every file changed, paste the output of the verification
  commands, and explicitly confirm each acceptance criterion. Do not declare the task complete
  otherwise.

## Problem

The canonical list of app languages, `SUPPORTED_LANGUAGES`, is defined in the **UI layer of the
app module**, so `shared` and `sharedUi` cannot see it. Everything else that needs the language
list re-implements fragments of it (translation catalog, zh rules, display-name helpers), which is
the root of the current divergence.

## Verified current state

- `app/src/main/java/com/music/bitchord/ui/components/AppLanguageDialog.kt` defines, in the UI layer:
  - `data class AppLanguage(val tag: String, val nativeName: String = "")` — line 64.
  - `val SUPPORTED_LANGUAGES` — lines 77–96, exactly these 18 tags:
    `en, es, fr, de, pl, pt, id, hi, ja, ru, zh-CN, zh-TW, he, it, tr, th, vi, ko`
    (with nativeName overrides on es, fr, pl, pt, ru, zh-CN, zh-TW, it — see the file for exact strings).
  - `AppLanguage.selfDisplayName()` — line 112; `languageDisplayName(tag, displayLocale)` — line 123;
    `languageDisplayNameDetailed(tag, displayLocale)` — line 133. The two display helpers already
    call `com.music.bitchord.data.LocaleTags.normalizeAppTag` (in `shared`).
- Tests importing the catalog from the UI package:
  - `app/src/test/java/com/music/bitchord/LocalizationTest.kt` (line 3 import).
  - `app/src/test/java/com/music/bitchord/LocaleStringsTest.kt` (line 3 import; `locales()` at line 27).
- `shared/src/jvmSharedMain/kotlin/com/music/bitchord/data/LocaleTags.kt` already uses
  `java.util.Locale`, so the target source set can host the catalog with no new dependencies.

## Tasks

1. Create `shared/src/jvmSharedMain/kotlin/com/music/bitchord/data/LanguageCatalog.kt` containing:
   - `data class AppLanguage(val tag: String, val nativeName: String = "")` — identical contract.
   - `val SUPPORTED_LANGUAGES: List<AppLanguage>` — byte-identical entries (tags and nativeName
     overrides) to today's list.
   - The three display-name helpers (`selfDisplayName`, `languageDisplayName`,
     `languageDisplayNameDetailed`) moved here with their existing doc comments, adapted to the
     new location.
   - A short doc comment stating this file is the single canonical list: `locales_config.xml`,
     the resource folders, and all parity tests derive from it.
2. In `AppLanguageDialog.kt`: delete the local definitions, import from
   `com.music.bitchord.data`, and keep the dialog UI untouched.
3. Update the two test files' imports to the new package. Search the whole repo for other
   references to `SUPPORTED_LANGUAGES` or `AppLanguage` (e.g. `SettingsSheet.kt` imports
   `languageDisplayNameDetailed` at line 149) and repoint them.
4. Confirm nothing Android-specific leaked into `shared`: the new file must compile with only
   `java.util.Locale` and `LocaleTags`.

## Constraints

- Tags and nativeName strings must be **identical** — `LocaleStringsTest` and `LocalizationTest`
  pin them against `locales_config.xml` and the resource folders.
- Do not touch `TranslationLanguages.kt` in this part (that is Part 2).

## Acceptance criteria

- `gradlew :app:testDebugUnitTest` passes (includes `LocalizationTest` and `LocaleStringsTest`).
- `grep -rn "SUPPORTED_LANGUAGES" --include=*.kt` finds exactly **one definition**, in
  `shared/src/jvmSharedMain/kotlin/com/music/bitchord/data/LanguageCatalog.kt`.
- `gradlew :app:assembleDebug` succeeds and the app-language dialog behaves exactly as before
  (same 18 rows, same names, same selection).
