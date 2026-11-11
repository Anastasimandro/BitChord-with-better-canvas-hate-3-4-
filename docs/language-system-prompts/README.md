# Language System Redesign — Prompt Series

Seven self-contained prompts (one file per part, ready to paste into an agent session) that turn
BitChord's scattered language handling into a single-source-of-truth system.

## Running these in a fresh session

Each part file is fully self-contained — paste its entire content as the first message of a new
session (OpenCode, Claude Code, Cursor, …). Every file includes a **"Fresh-session bootstrap"**
section that tells the agent:

- the repo root to work in (`C:\Users\A\Proyectos\BitChord-with-better-canvas-hate-3-4-`, Windows,
  `gradlew.bat`) — all paths are relative to it;
- a **pre-flight check**: it verifies by itself whether the earlier parts it depends on have
  actually run (concrete file/grep checks). If not, it stops and tells you which part is missing
  instead of guessing; if everything is already done, it verifies and stops too — safe to re-run.
- a **report format**: files changed, verification command output, and explicit confirmation of
  each acceptance criterion before it may claim the task is done;
- where it must **STOP and ask** you (Part 2's semantics check, Part 3's merge choice,
  Part 5's Wear product decision, Part 6's plan approval).

Recommended invocation: open the new session in the repo root and send the file's content plus
one line at the top, e.g. *"Follow the prompt below exactly. Do the work in this repository."*

## Read this first

Every file path and line number below was **verified against the repository** (2026-11-11).
If you are running these prompts later, re-check the cited lines before editing — line numbers
shift as earlier parts change things.

## The verified audit (what is wrong today)

### Architecture

- **Two competing catalogs.** `SUPPORTED_LANGUAGES` (18 app languages) is defined in the *UI layer*
  of the app module — `app/src/main/java/com/music/bitchord/ui/components/AppLanguageDialog.kt`
  (data class at line 64, list at 77–96, display helpers at 112 / 123 / 133). `shared` and
  `sharedUi` cannot depend on it, so everything below re-implements fragments of it.
  A second catalog, `TRANSLATION_LANGUAGES` (133 Google-Translate codes), lives in
  `shared/src/jvmSharedMain/kotlin/com/music/bitchord/data/lyrics/TranslationLanguages.kt:20`.
- **Three conflicting zh canonicalizations:**
  1. `shared/.../data/LocaleTags.kt` — `normalizeAppTag` (23–44) and
     `sameLanguageScriptAware` (114–126) are script-aware. **This is the correct one.**
  2. `shared/.../data/lyrics/LyricsTranslation.kt:549–559` — `canonicalLanguage`/`sameLanguage`
     are **script-blind** (zh-CN and zh-TW both reduce to `zh`). Real bug: Simplified lyrics can be
     declared "already in your language" for a Traditional reader. Its legacy fixup table
     (`iw/in/ji`) is also missing `jw→jv`.
  3. `sharedUi/.../ui/player/PlayerLyrics.kt:3081–3088` — a third inline resolution rule.
- **Legacy-code fixups (`iw→he`, `in→id`, `ji→yi`, `jw→jv`) copy-pasted three times:**
  `LocaleTags.kt:39–41`, `TranslationLanguages.kt:181–188` (and 206–221), `LyricsTranslation.kt:552–554`.
- **Dead code:** `translationLanguageNativeName` (`TranslationLanguages.kt:206–221`) has zero
  callers repo-wide.
- **Inconsistent `hl` wire format:** `Innertube.kt:834` sends `zh_TW` (underscore, tracking pings)
  while 1133 / 1160 / 1212 / 1221 send `zh-TW`. Same param, two spellings. Also
  `shared/.../data/SongInfoRepository.kt:73`.
- **Stale migration glue:** `app/.../BitChordApplication.kt:100` wires `Innertube.appLanguage`;
  `migrateScriptOnlyAppLocale` (101, 322–332) fixes pre-`zh-TW` persisted tags.

### Resources

- **app**: 20 locale directories × **1182 keys each** (verified count). `localeConfig` in manifest
  (line 72), `AppLocalesMetadataHolderService`/`autoStoreLocales` (98–102).
- **sharedUi** (`sharedUi/src/commonMain/composeResources`): `values` = **253 keys**; only
  `values-es` and `values-ko` match (253); the **other 17 locales have 173** — **80 keys missing**,
  exact list in [Part 4](part-4-sharedui-parity.md). No test guards this.
- **wearos**: 20 dirs × 40 keys (complete) — **but the manifest declares no `localeConfig`** and
  there is no picker, so 19 of those 20 catalogues are unreachable by users.
- **tv**: builds the *phone app's* sources and resources wholesale
  (`tv/build.gradle.kts:129–139`), then adds its own 7 locale dirs (269 TV-only keys). Its own
  settings screen (`tv/.../ui/tv/screens/TvSettingsScreen.kt`) has **no language entry at all**.
- **Chinese zoo**: app and wearos carry `values-zh`, `values-zh-rHK`, `values-zh-rTW`,
  `values-b+zh+Hant`; sharedUi has three of the four. Verified content:
  - all four have the *same 1182 key set* (no coverage drift);
  - `values-b+zh+Hant` is a **content-identical duplicate** of `values-zh-rTW` (0 string diffs);
  - `values-zh-rHK` differs from `values-zh-rTW` in the wording of only **6 keys** (regional
    variants like 直向/直式);
  - `no_audio_version`, `no_video_version`, `version_switch_in_party` are **untranslated English**
    in *every* zh variant (a translation-quality gap, not a drift between files).
- `app/src/main/res/xml/locales_config.xml` lists **19** locales (catalog's 18 + bare `zh`).

### Tests / CI

- Parity tests (`LocalizationTest.kt`, `LocaleStringsTest.kt` in `app/src/test/...`) and the Gradle
  tasks `i18nParityTest` (587) / `localeCoverage` (605) in `app/build.gradle.kts` cover the
  **app module only**. `LocaleStringsTest.tagToQualifier` (66–70) maps `zh-CN→values-zh`,
  `zh-TW→values-zh-rTW`. CI exists (`.github/workflows/check.yml`, `android.yml`, `tv.yml`).
- `sharedUi` has a `jvmTest` source set ready to host its own parity test.
- **web** has no language system at all: UI English-only; lyrics Translate/Romanise are
  am-lyrics' own buttons and translate to English only (`web/docs/lyrics.md:61`, and line 82
  lists other-than-English translation under "Not done or not verified");
  `web/app/src/playback/youtube/innertube.ts:59` only safelists `accept-language`.
- `docs/LYRICS_TRANSLATION.md:28–31` ("Destination language") still describes the pre-
  `TranslationLanguageDialog` behavior.

## Execution order and dependencies

| Part | File | Depends on | Risk |
|------|------|------------|------|
| 1 | `part-1-language-catalog-to-shared.md` | — | Low (pure move) |
| 2 | `part-2-single-tag-normalization.md` | 1 | Medium (lyrics semantics) |
| 3 | `part-3-chinese-resource-cleanup.md` | 1 | Low-medium |
| 4 | `part-4-sharedui-parity.md` | 1 | Low (additive) |
| 5 | `part-5-tv-wear-language.md` | 1 | Medium (Wear = product decision) |
| 6 | `part-6-web-language.md` | 1 | High (optional, new system) |
| 7 | `part-7-closure-and-verification.md` | all | Low |

Parts 2–5 are independent of each other and can run in parallel sessions once Part 1 is done.

## The golden rule

Adding a new language must require editing exactly one place (the catalog in `shared`) plus the
mechanical resource folders — and no test may fail silently or unexpectedly.
