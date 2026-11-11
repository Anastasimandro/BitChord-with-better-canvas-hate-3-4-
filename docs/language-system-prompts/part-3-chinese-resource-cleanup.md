# Part 3 — Consolidate the Chinese resource directories

You are working in the BitChord repository (Kotlin Multiplatform; Gradle modules `:app`, `:tv`,
`:wearos`, `:shared`, `:sharedUi`). Code comments in English. This part removes redundant Chinese
resource folders without changing what users see.

## Fresh-session bootstrap (read first)

- Work in the repo root `C:\Users\A\Proyectos\BitChord-with-better-canvas-hate-3-4-`
  (Windows: invoke Gradle as `.\gradlew` or `gradlew.bat`). Every path below is relative to that root.
- This prompt is self-contained: no prior conversation or document is needed. Line numbers and
  counts were verified on 2026-11-11 — re-check them before editing.
- **Pre-flight**: `shared/src/jvmSharedMain/kotlin/com/music/bitchord/data/LanguageCatalog.kt`
  must exist (Part 1 done) — if not, STOP and tell the user to run Part 1 first. This part can
  run before, after or in parallel with Parts 2 and 4; the only interaction is that if Part 4
  already ran, sharedUi's zh folders may differ from the counts below. If `values-b+zh+Hant`
  and `values-zh-rHK` are already gone from all modules, Part 3 is already done — verify the
  acceptance criteria and stop.
- **Report format**: when done, list every file changed (including deletions), paste the output
  of the verification commands, state your (a)/(b) merge decision with the reasoning, list the
  untranslated-English keys found, and explicitly confirm each acceptance criterion.

## Problem

app and wearos each carry **four** Chinese resource variants; sharedUi carries three. One of them
is a content-identical duplicate and one is (almost) never selected.

## Verified current state

- `app/src/main/res`: `values-zh`, `values-zh-rHK`, `values-zh-rTW`, `values-b+zh+Hant`
  — each exactly **1182 keys** (counts verified).
- `wearos/src/main/res`: the same four directories — each **40 keys**.
- `sharedUi/src/commonMain/composeResources`: `values-zh`, `values-zh-rHK`, `values-zh-rTW`
  (no `values-b+zh+Hant`).
- **Verified content relationships:**
  - All four app variants share the *same key set* (no coverage drift).
  - `values-b+zh+Hant` is **content-identical to `values-zh-rTW`** (0 string-value diffs) — it is
    a pure duplicate kept in a different line order.
  - `values-zh-rHK` differs from `values-zh-rTW` in the wording of only **6 keys**:
    `tester_code_message`, `tester_code_message_saved`, `replay_story_songs`,
    `replay_story_songs_week`, `animated_cover_shape_portrait`, `offline_playlist_empty`
    (genuine regional wording variants, e.g. 直向 vs 直式).
  - `no_audio_version`, `no_video_version`, `version_switch_in_party` are **untranslated English
    in every zh variant** (a translation-quality gap across all of them, not a drift).
- Runtime mapping (from Part 1's catalog + `shared/.../data/LocaleTags.kt`): catalog tags are
  `zh-CN` / `zh-TW`; `LocaleStringsTest.tagToQualifier` (66–70) maps `zh-CN→values-zh`,
  `zh-TW→values-zh-rTW`; `LocaleTags.normalizeAppTag` sends bare `zh` to Simplified.
- `app/src/main/res/xml/locales_config.xml` lists **19** locales: the catalog's 18 **plus bare
  `zh`** (lines 3–21).
- `sharedUi` has no parity test yet (added in Part 4).

## Tasks

1. **Delete the duplicate**: remove `values-b+zh+Hant` from `app/src/main/res` and
   `wearos/src/main/res`. (Verified content-identical to `values-zh-rTW`, so behavior is
   unchanged: a `zh-Hant` runtime locale resolves through `values-zh-rTW` via the `zh-TW`
   catalog tag and `LocaleTags` mapping.)
2. **Merge the HK variants**: the 6 differing keys in `values-zh-rHK` are legitimate HK-worded
   alternatives, but no catalog tag can ever select `values-zh-rHK` (tags are `zh-CN`/`zh-TW`;
   Android resolves `zh-HK` device locales to `values-zh` or `values-zh-rTW` depending on script).
   Pick one and be explicit:
   - (a) delete `values-zh-rHK` from app, wearos and sharedUi, folding the 6 regional wordings
     into `values-zh-rTW` only if a maintainer confirms TW wording should win, **or**
   - (b) keep them by folding the 6 HK wordings into `values-zh-rTW` and deleting the folder.
   Either way the repo must end with exactly two Chinese directories per module:
   `values-zh` and `values-zh-rTW`. Document the 6-key decision in the commit message.
3. **locales_config.xml**: keep the 19 entries only if some real flow can request bare `zh`
   (a `zh` system locale resolving before `normalizeAppTag` maps it). If you keep it, add a
   comment in the XML explaining why; if not, drop bare `zh` and adjust `LocalizationTest`
   (`app/src/test/java/com/music/bitchord/LocalizationTest.kt`, lines 62–94) accordingly.
4. **Untranslated leftovers** (do not fix silently): the three English strings
   (`no_audio_version`, `no_video_version`, `version_switch_in_party`) exist in all zh variants
   (and possibly other languages). Do **not** translate them yourself; instead list every key
   whose value in a non-`values` locale equals its English source, and report it for Part 4 to
   fold into the translation work.
5. Verify no build file references the deleted dirs: `grep -rn "b+zh" --include=*.kts --include=*.gradle`,
   and `grep -rn "zh-rHK"` after the merge.

## Acceptance criteria

- Every Gradle module that ships strings has exactly `values-zh` + `values-zh-rTW` for Chinese
  (plus `values`), and `grep -rn "b+zh"` / `grep -rn "zh-rHK"` return nothing.
- `gradlew :app:assembleDebug :tv:assembleDebug :wearos:assembleDebug` succeeds.
- Manual smoke (or `connectedDebugAndroidTest` if present): selecting 繁體中文 (zh-TW) shows
  Traditional in Settings; 简体中文 (zh-CN) shows Simplified.
- `gradlew :app:testDebugUnitTest` passes; `LocalizationTest` and `LocaleStringsTest` reflect the
  final `locales_config.xml` decision.
- The list of untranslated-English keys is reported (not lost).
