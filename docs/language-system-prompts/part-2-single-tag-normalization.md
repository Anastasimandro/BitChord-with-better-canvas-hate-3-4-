# Part 2 — One tag normalization to rule them all (fixes the Chinese bug)

You are working in the BitChord repository (Kotlin Multiplatform; Gradle modules `:app`, `:tv`,
`:wearos`, `:shared`, `:sharedUi`). Code comments in English. This part changes lyrics-translation
semantics in one place — read the "STOP and ask" rule before doing anything destructive.

## Fresh-session bootstrap (read first)

- Work in the repo root `C:\Users\A\Proyectos\BitChord-with-better-canvas-hate-3-4-`
  (Windows: invoke Gradle as `.\gradlew` or `gradlew.bat`). Every path below is relative to that root.
- This prompt is self-contained: no prior conversation or document is needed. Line numbers were
  verified on 2026-11-11 — re-check each cited line before editing.
- **Pre-flight**: `shared/src/jvmSharedMain/kotlin/com/music/bitchord/data/LanguageCatalog.kt`
  (the catalog from Part 1) must exist and define `SUPPORTED_LANGUAGES`. If it does not, STOP and
  tell the user to run Part 1 first (`docs/language-system-prompts/part-1-language-catalog-to-shared.md`).
  Also verify the baseline files below still contain what this prompt describes before editing.
- **Report format**: when done, list every file changed, paste the output of the verification
  commands, and explicitly confirm each acceptance criterion. Surface every STOP-and-ask case
  instead of resolving it silently. Do not declare the task complete otherwise.

## Problem

There are **three** implementations of "are these two language tags the same language", and they
disagree about Chinese. One of them introduces a real user-facing bug.

## Verified current state

1. **The good one** — `shared/src/jvmSharedMain/kotlin/com/music/bitchord/data/LocaleTags.kt`:
   - `normalizeAppTag(raw)` — lines 23–44. Script-aware for Chinese (`zh-Hant` / `zh-Hans`),
     maps region to script, bare `zh` → Simplified, base-language reduction elsewhere, legacy
     fixups `iw→he`, `in→id`, `ji→yi` (lines 39–41).
   - `sameLanguageScriptAware(first, second)` — lines 114–126. Script-aware equality
     (`zh-Hant ≠ zh-Hans ≠ zh`).
   - Also home of the wire mappings: `ytHl` (50), `ytGl` (60), `ytSearchGl` (78),
     `acceptLanguage` (83), `translationWireTarget` (101), `isChineseTag` (128).
2. **The buggy one** — `shared/src/jvmSharedMain/kotlin/com/music/bitchord/data/lyrics/LyricsTranslation.kt`
   lines 549–559: `canonicalLanguage(tag)` / `sameLanguage(first, second)` are **script-blind**
   (both zh-CN and zh-TW reduce to `zh`). Consequence: Simplified lyrics can be reported as
   "already in your language" to a Traditional-Chinese reader and skipped. Its fixup table
   (552–554) is also missing `jw→jv`.
3. **The inline one** — `sharedUi/src/jvmSharedMain/kotlin/com/music/bitchord/ui/player/PlayerLyrics.kt`
   lines 3081–3088 inside `rememberLyricsTranslation`: a bespoke resolution rule
   (Settings choice passes through untouched; app-language fallback reduces to base language
   except Chinese, which goes through `LocaleTags.translationWireTarget`). Its comments (3076–3080)
   document the intent.
4. **Copy-pasted fixups** — `shared/src/jvmSharedMain/kotlin/com/music/bitchord/data/lyrics/TranslationLanguages.kt`:
   `translationLanguageName` (174–200) re-implements the iw/in/ji/jw fixups inline (181–188);
   `translationLanguageNativeName` (206–221) has **zero callers repo-wide** (dead code).
5. **`hl` wire inconsistency** — `shared/src/jvmSharedMain/kotlin/com/music/bitchord/data/innertube/Innertube.kt`:
   - line 834: `parameter("hl", currentLanguage.replace('-', '_'))` → sends `zh_TW` for
     tracking pings;
   - lines 1133, 1160, 1212, 1221: send `currentLanguage` as-is → `zh-TW`.
   Also `shared/src/jvmSharedMain/kotlin/com/music/bitchord/data/SongInfoRepository.kt:73`
   sends `Innertube.currentLanguage` as `hl`.

## Tasks

1. **LyricsTranslation.kt**: delete `canonicalLanguage` and `sameLanguage`; replace their uses
   with `LocaleTags.sameLanguageScriptAware(...)`. Update the affected doc comment so the intended
   semantics (script-aware for Chinese) is explicit.
2. **PlayerLyrics.kt**: keep the *behavior* documented at lines 3076–3080 but express the
   app-language fallback in terms of `LocaleTags` helpers only (`isChineseTag`,
   `translationWireTarget`, base-language reduction). The observable behavior must not change.
3. **TranslationLanguages.kt**:
   - Delete `translationLanguageNativeName` (dead code; verify with
     `grep -rn "translationLanguageNativeName" --include=*.kt` that only the definition remains
     before deleting).
   - In `translationLanguageName`, replace the inline fixup branch with delegation to
     `LocaleTags.normalizeAppTag` (i.e. resolve display via
     `Locale.forLanguageTag(LocaleTags.normalizeAppTag(code)).getDisplayName(inLocale)`), keeping
     the existing fallback-to-`fallbackName` behavior and the capitalization call.
4. **Innertube `hl` unification**: make one place own the wire spelling so Chinese is always
   `zh-TW` / `zh-CN` (hyphenated). Add a `LocaleTags.ytHlWire(tag)` helper if that is the cleanest
   seam, then use it at line 834 and confirm lines 1133/1160/1212/1221 and
   `SongInfoRepository.kt:73` all go through it. Non-zh behavior must be byte-identical.
5. **Guard test**: add a small JVM test (e.g. `shared/src/jvmTest/kotlin/com/music/bitchord/data/LocaleTagsTest.kt`)
   asserting: `sameLanguageScriptAware("zh-TW","zh-CN") == false`,
   `sameLanguageScriptAware("zh-TW","zh-Hant") == true`, `sameLanguageScriptAware("iw","he") == true`,
   and `ytHlWire` returns `zh-TW`/`zh-CN` with hyphens.

## STOP and ask

If the inline rule in `PlayerLyrics.kt:3081–3088` turns out to behave differently from a direct
`sameLanguageScriptAware` substitution for **any** case you can construct (not just zh), stop and
report the differing cases instead of silently changing behavior.

## Acceptance criteria

- `canonicalLanguage` / `sameLanguage` no longer exist in `LyricsTranslation.kt`.
- `grep -rn "translationLanguageNativeName" --include=*.kt` returns nothing.
- No legacy fixup table (`iw`, `in`, `ji`, `jw`) exists outside `LocaleTags.kt`.
- The new `LocaleTagsTest` passes and would fail if someone reintroduces a script-blind zh compare.
- Unit tests for the touched modules pass: `gradlew :shared:jvmTest :sharedUi:jvmTest :app:testDebugUnitTest`
  (run each module's own test task; verify names with `gradlew tasks` if they differ).
