# Part 4 — Close the sharedUi translation gap and make parity mandatory

You are working in the BitChord repository (Kotlin Multiplatform; Gradle modules `:app`, `:tv`,
`:wearos`, `:shared`, `:sharedUi`). Code comments in English. This part is additive: translations
plus the tests that keep them from rotting.

## Fresh-session bootstrap (read first)

- Work in the repo root `C:\Users\A\Proyectos\BitChord-with-better-canvas-hate-3-4-`
  (Windows: invoke Gradle as `.\gradlew` or `gradlew.bat`). Every path below is relative to that root.
- This prompt is self-contained: no prior conversation or document is needed. Counts and key
  lists were verified on 2026-11-11 — recompute them (diff `values` vs a missing locale) rather
  than trusting the list blindly.
- **Pre-flight**: `shared/src/jvmSharedMain/kotlin/com/music/bitchord/data/LanguageCatalog.kt`
  must exist (Part 1 done) — if not, STOP and tell the user to run Part 1 first. If
  `sharedUi/src/commonMain/composeResources/values-zh-rHK` no longer exists, Part 3 already ran:
  drop that folder from the locale list below and note it in the report. If all sharedUi locales
  already match `values` key counts, Part 4 is done — verify the acceptance criteria and stop.
- **Report format**: when done, list every file changed, paste the output of the verification
  commands, list any key left as TODO(i18n) with its language, and explicitly confirm each
  acceptance criterion.

## Problem

`sharedUi` ships 80 untranslated keys in 17 of its 18 languages, and nothing guards it — parity
tests and Gradle coverage tasks exist only for the app module.

## Verified current state

- `sharedUi/src/commonMain/composeResources/strings.xml` layout (compose resources):
  `values` = **253 keys**; `values-es` and `values-ko` = **253** (complete);
  the other 17 locale dirs (`values-de, fr, he, hi, id, it, ja, pl, pt, ru, th, tr, vi, zh,
  zh-rHK, zh-rTW`) each have **173**.
  (If Part 3 ran first, `values-zh-rHK` no longer exists.)
- The **80 missing keys** (computed by diffing `values` vs `values-de`; identical set for all
  17 locales):
  `watch_output`, `watch_output_subtitle`, `previously_played`, `search_addons_hint`,
  `search_addons_empty`, `search_addons_no_results`, `sign_in_with_google`,
  `top_picks_for_you`, `top_pick_made_for_you`, `top_pick_mood_for_you`, `top_pick_featuring`,
  `top_pick_and_similar`, `top_pick_named_station`, `top_pick_your_station`,
  `top_pick_discovery_station`, `top_pick_new_from`, `find_your_mood`, `mood_energy`,
  `mood_energy_line`, `mood_relax`, `mood_relax_line`, `mood_feeling_blue`,
  `mood_feeling_blue_line`, `mood_feel_good`, `mood_feel_good_line`, `mood_focus`,
  `mood_focus_line`, `mood_heartbreak`, `mood_heartbreak_line`, `mood_love`, `mood_love_line`,
  `mood_after_hours`, `mood_after_hours_line`, `mood_alone_time`, `mood_alone_time_line`,
  `mood_chill`, `mood_chill_line`, `mood_commuting`, `mood_commuting_line`, `mood_evening`,
  `mood_evening_line`, `mood_fitness`, `mood_fitness_line`, `mood_gaming`, `mood_gaming_line`,
  `mood_home`, `mood_home_line`, `mood_morning`, `mood_morning_line`, `mood_motivation`,
  `mood_motivation_line`, `mood_outdoors`, `mood_outdoors_line`, `mood_party`, `mood_party_line`,
  `mood_sleep`, `mood_sleep_line`, `mood_social`, `mood_social_line`, `mood_sports`,
  `mood_sports_line`, `mood_summertime`, `mood_summertime_line`, `mood_holiday`,
  `mood_holiday_line`, `mood_weekend`, `mood_weekend_line`, `mood_wellbeing`,
  `mood_wellbeing_line`, `mood_work`, `mood_work_line`, `video_quality`, `video_quality_auto`,
  `mix_view_bars`, `mix_view_one_bar`, `mix_view_seconds`, `mix_view_bpm`,
  `automix_overview_unavailable`
  plus the Part-3 leftovers if reported (e.g. `no_audio_version`, `no_video_version`,
  `version_switch_in_party` where they appear in sharedUi locales).
- Guard infrastructure to replicate:
  - `app/src/test/java/com/music/bitchord/LocaleStringsTest.kt` — parameterized key-parity test;
    its `tagToQualifier` (lines 66–70) maps `zh-CN→values-zh`, `zh-TW→values-zh-rTW`.
  - `app/build.gradle.kts` — `i18nParityTest` task (line 587, depends on `localeCoverage` at 592)
    and `localeCoverage` (605); `check` depends on `i18nParityTest` (660).
- Catalog location after Part 1: `shared/src/jvmSharedMain/kotlin/com/music/bitchord/data/LanguageCatalog.kt`
  (`SUPPORTED_LANGUAGES`, 18 tags). sharedUi already has a `jvmTest` source set
  (`sharedUi/src/jvmTest`).
- CI runs Gradle checks via `.github/workflows/check.yml`.

## Tasks

1. **Translate the 80 keys into the 17 incomplete locales** (`de, fr, he, hi, id, it, ja, pl,
   pt, ru, th, tr, vi, zh, zh-rTW` + any locale Part 3 left incomplete). Use `values` as the
   semantic source and the recent `values-es` / `values-ko` files as tone reference.
   - Preserve placeholders exactly (`%s`, `%1$d`, …).
   - For `values-zh` use Simplified and for `values-zh-rTW` use Traditional wording.
   - If you are not confident in a UI term for a language, keep the English string and mark the
     line with `<!-- TODO(i18n): verify <lang> wording -->` for human review. Do not invent.
2. **sharedUi parity test**: create `sharedUi/src/jvmTest/kotlin/com/music/bitchord/SharedUiStringsTest.kt`
   modeled on `LocaleStringsTest`:
   - parameterized over `SUPPORTED_LANGUAGES` (from `shared`, Part 1) minus `en`;
   - reuse the same `tagToQualifier` mapping;
   - parse the compose-resource `values*/strings.xml` files from the repo path and assert
     every translatable key in `values` exists in each locale file.
3. **Gradle coverage**: extend the coverage story so sharedUi is guarded — either make
   `i18nParityTest` in `app/build.gradle.kts` also depend on `:sharedUi:jvmTest`, or add an
   equivalent task in `sharedUi/build.gradle.kts` and wire it into `check` (mirroring lines
   587–605 / 660 of app). Confirm `.github/workflows/check.yml` runs whatever you wire.
4. If Part 3 reported untranslated-English leftovers (values identical to the English source in
   non-English files), fold them into this translation pass for the locales you can do
   confidently, and TODO-flag the rest.

## Acceptance criteria

- Every sharedUi locale directory has the same key count as `values` (253 + whatever it is that
  day — **100% key parity**).
- The new sharedUi parity test **fails** if a key is added to `values` without a translation.
- `gradlew :sharedUi:jvmTest` and the wired parity task pass.
- No placeholder mismatches (spot-check `%s`/`%1$d` counts per translated key).
