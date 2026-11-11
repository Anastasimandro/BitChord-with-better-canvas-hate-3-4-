# Part 7 — Closure: docs, dead code, and the full verification battery

You are working in the BitChord repository (Kotlin Multiplatform; Gradle modules `:app`, `:tv`,
`:wearos`, `:shared`, `:sharedUi`). Code comments in English. Run this part **last**, after Parts
1–5 (and 6 if approved).

## Fresh-session bootstrap (read first)

- Work in the repo root `C:\Users\A\Proyectos\BitChord-with-better-canvas-hate-3-4-`
  (Windows: invoke Gradle as `.\gradlew` or `gradlew.bat`). Every path below is relative to that root.
- This prompt is self-contained: no prior conversation or document is needed. Line numbers were
  verified on 2026-11-11 — re-check them before editing.
- **Pre-flight** (must pass, else STOP and report which parts are incomplete):
  - `shared/src/jvmSharedMain/kotlin/com/music/bitchord/data/LanguageCatalog.kt` exists and is the
    only `SUPPORTED_LANGUAGES` definition (`grep -rn "SUPPORTED_LANGUAGES" --include=*.kt`);
  - `LyricsTranslation.canonicalLanguage` and `translationLanguageNativeName` are gone
    (`grep -rn "canonicalLanguage|translationLanguageNativeName" --include=*.kt`);
  - no `values-b+zh+Hant` / `values-zh-rHK` folders remain in any module;
  - the sharedUi parity test from Part 4 exists and passes.
  If a check fails, tell the user which earlier part must be completed first. Parts 5 and 6 are
  exempt from the stop condition only if the user explicitly chose to skip them (record that).
- **Report format**: paste the complete verification battery output, list every file changed,
  and confirm each acceptance criterion explicitly.

## Goal

Make the end state self-explanatory: up-to-date docs, no dead code left from the old system, and
a green verification battery that proves the invariants.

## Verified starting points

- `docs/LYRICS_TRANSLATION.md:28–31` — the "Destination language" section still says the target
  comes from `AppCompatDelegate.getApplicationLocales()` only, predating
  `TranslationLanguageDialog` / `AppSettings.translationLanguage`
  (`app/src/main/java/com/music/bitchord/data/settings/AppSettings.kt` — re-verify the exact
  property lines) and `PlayerLyrics.kt:3076–3089` ("Settings wins where it has been set; blank
  means follow the app").
- Things Parts 1–5 should have already removed (verify, do not assume):
  a second `SUPPORTED_LANGUAGES` definition, `LyricsTranslation.canonicalLanguage`/`sameLanguage`,
  `translationLanguageNativeName`, `values-b+zh+Hant` and `values-zh-rHK`, inline `hl` spellings.

## Tasks

1. **Rewrite the stale docs.**
   - `docs/LYRICS_TRANSLATION.md`: the destination language is the explicit Settings choice
     (`AppSettings.translationLanguage`), falling back to the app language; describe the zh
     script handling via `LocaleTags.translationWireTarget` (`zh-TW`/`zh-CN` on the wire, never
     bare `zh`); mention the script-aware "already in language" check
     (`LocaleTags.sameLanguageScriptAware`).
2. **Write the architecture doc.** Create `docs/LANGUAGE_SYSTEM.md` covering:
   - `LanguageCatalog.kt` in `shared` is the single canonical list (what depends on it:
     `locales_config.xml`, resource folders, all parity tests, TV/Wear pickers);
   - `LocaleTags.kt` is the only tag normalization / wire mapping;
   - which modules ship which resource folders and how each surface resolves language
     (phone per-app locale, TV per-app locale + picker, Wear decision, web decision);
   - the parity test coverage per module (`LocaleStringsTest`, `LocalizationTest`, the sharedUi
     test from Part 4, Gradle tasks `i18nParityTest` / `localeCoverage` / wired `check`);
   - a step-by-step "how to add a new language in N exact steps" that matches the repo as it
     stands **after** this series (catalog entry → resource folders per module → locales_config →
     translations incl. sharedUi → tests green).
3. **Dead-code sweep.** Verify with grep that the removals claimed by earlier parts actually
   happened and nothing new got orphaned:
   - `grep -rn "SUPPORTED_LANGUAGES" --include=*.kt` → one definition (in `shared`);
   - `grep -rn "canonicalLanguage\\|translationLanguageNativeName" --include=*.kt` → nothing;
   - no `iw|in|ji|jw` fixup tables outside `LocaleTags.kt`;
   - no `values-b+zh+Hant` / `values-zh-rHK` folders;
   - `grep -rn "hl\", currentLanguage" --include=*.kt` → all go through the single wire helper.
4. **Untranslated-value sweep** (new guard): extend the app parity test (or `localeCoverage`)
   with a check that flags non-English locale files whose string value is identical to the
   English source for known-translatable keys — as a report, not a failure, unless the user
   wants it hard-failing. (Known pre-existing examples: `no_audio_version`, `no_video_version`,
   `version_switch_in_party` in the zh files.)
5. **Run the battery** and paste a summary of results:
   - `gradlew :app:testDebugUnitTest :shared:jvmTest :sharedUi:jvmTest`
     (use each module's real test task names);
   - `gradlew :app:assembleDebug :tv:assembleDebug :wearos:assembleDebug`;
   - the parity/coverage tasks (`i18nParityTest`, `localeCoverage`, and whatever Part 4 wired);
   - the CI entry points (`.github/workflows/check.yml`, `android.yml`) still reference tasks
     that exist.

## Acceptance criteria

- All greps in task 3 return the expected zero/one results.
- The full battery is green; any pre-existing failures are reported distinctly from new ones.
- `docs/LANGUAGE_SYSTEM.md` exists, is accurate, and its "add a language" steps actually work
  (mentally walk through adding e.g. `ar`: exactly one catalog edit + mechanical folder/parity
  steps, no surprises).
- `docs/LYRICS_TRANSLATION.md` matches the implemented behavior.
