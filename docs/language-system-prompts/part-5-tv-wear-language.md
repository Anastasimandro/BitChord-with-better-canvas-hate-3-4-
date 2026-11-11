# Part 5 — TV and Wear: make the shipped translations reachable

You are working in the BitChord repository (Kotlin Multiplatform; Gradle modules `:app`, `:tv`,
`:wearos`, `:shared`, `:sharedUi`). Code comments in English. This part has **one product
decision** (Wear) — ask the user before choosing.

## Fresh-session bootstrap (read first)

- Work in the repo root `C:\Users\A\Proyectos\BitChord-with-better-canvas-hate-3-4-`
  (Windows: invoke Gradle as `.\gradlew` or `gradlew.bat`). Every path below is relative to that root.
- This prompt is self-contained: no prior conversation or document is needed. Line numbers were
  verified on 2026-11-11 — re-check them before editing.
- **Pre-flight**: `shared/src/jvmSharedMain/kotlin/com/music/bitchord/data/LanguageCatalog.kt`
  must exist (Part 1 done) — if not, STOP and tell the user to run Part 1 first. Re-verify the
  baseline claims below (manifest lines, absent TvSettingsScreen language entry, missing
  wearos `localeConfig`) before editing; if Wear already has a `localeConfig` or TV already has
  a language row, Part 5 is (partially) done — verify and stop.
- **STOP and ask**: the Wear question (own picker vs follow the phone/system) is a product
  decision. Ask the user and wait for the answer before implementing item 2.
- **Report format**: when done, list every file changed, paste the output of the verification
  commands, record the Wear decision and its rationale, report the TV `tv_*` coverage gap with
  exact per-language counts, and explicitly confirm each acceptance criterion.

## Problem

TV compiles the phone app's whole language system but exposes no way to change the language from
its own UI; wearos ships 20 complete locale folders that users cannot reach because the manifest
declares no `localeConfig` and there is no picker.

## Verified current state

- **app** (reference behavior): manifest `android:localeConfig="@xml/locales_config"` at
  `app/src/main/AndroidManifest.xml:72`; `AppLocalesMetadataHolderService` with
  `autoStoreLocales` at lines 98–102; picker = `AppLanguageDialog` reachable from `SettingsSheet`
  (category `LANGUAGE`, lines 1801–1817); the single writer is
  `AppCompatDelegate.setApplicationLocales` (`AppLanguageDialog.kt:265–267`).
- **tv**: manifest declares `localeConfig` (`tv/src/main/AndroidManifest.xml:83`) and the
  persistence service (123–127). Build borrows the phone app wholesale
  (`tv/build.gradle.kts:129–139`: `java.srcDir("../app/src/main/java")`,
  `res.srcDir("../app/src/main/res")`). But `tv/src/main/java/com/music/bitchord/ui/tv/screens/TvSettingsScreen.kt`
  contains **zero** matches for language/locale — no entry point. TV ships the phone's 20 locale
  folders plus 7 of its own (269 TV-only `tv_*` keys).
- **wearos**: manifest has only `supportsRtl` (line 28) — no `localeConfig`, no persistence
  service, no picker. It does have 20 complete locale dirs (40 keys each).
  `wearos/src/main/java/com/music/bitchord/wear/WearActivity.kt:31` documents that locale changes
  recreate the activity ("Outlives a rotation-less recreate (theme, locale)…").
  wearos has **no `res/xml/` directory yet** — it must be created for `locales_config.xml`.
- Catalog after Part 1: `shared/.../data/LanguageCatalog.kt` (`SUPPORTED_LANGUAGES`, 18 tags).
- `locales_config.xml` source of truth: `app/src/main/res/xml/locales_config.xml` (19 entries).

## Tasks

1. **TV — add a language entry.**
   - If TV's settings UI is its own screen (`TvSettingsScreen.kt`), add an "App language" row
     that opens a TV-style picker built on `SUPPORTED_LANGUAGES` from `shared`: d-pad navigable,
     focused-row check mark, selection applies via `AppCompatDelegate.setApplicationLocales(...)`
     and closes. Follow the existing dialog idioms in `tv/.../ui/tv/dialogs/`.
   - If TV actually renders the phone's `SettingsSheet`, verify the existing language row is
     operable with a remote (focus, click) and document why nothing new is needed.
   - Also confirm the summary line under the row shows the current language
     (`languageDisplayNameDetailed`), mirroring the phone.
2. **Wear — ask first:** does the watch get its own picker, or does it follow the paired
   phone/system locale?
   - If **own picker**: add `android:localeConfig="@xml/locales_config"` to
     `wearos/src/main/AndroidManifest.xml` (create `wearos/src/main/res/xml/locales_config.xml`
     generated from the catalog — same 18/19 entries as the app's file), add the
     `AppLocalesMetadataHolderService` + `autoStoreLocales` mirror, and add a minimal picker in
     the Wear settings surface reusing `SUPPORTED_LANGUAGES`.
   - If **follow the phone/system**: document that decision in `WearActivity.kt`, and remove the
     19 unreachable locale folders (keep `values`) so the module stops shipping dead
     translations. Either way, one of the two must be true when you finish — no half state.
3. Confirm locale changes recreate activities cleanly on both targets (no stale state): the
   `AppLocalesMetadataHolderService` pattern plus standard recreation; `WearActivity.kt:31`
   already handles the draw-state retention.
4. Check the TV-only `tv_*` strings (269 keys × 7 locales: de, es, fr, ja, pt, ru) — do **not**
   translate the missing 11 languages in this part; instead report the coverage gap so it can be
   scheduled (it is app-module parity's blind spot, guarded by no test today).

## Acceptance criteria

- TV: with a remote/d-pad you can change the app language and the UI re-renders in the new
  language; the summary line stays correct.
- Wear: per-app locale works (or the "follows system/phone" decision is implemented and
  documented, with the dead folders removed).
- `gradlew :tv:assembleDebug :wearos:assembleDebug` succeeds.
- The TV `tv_*` coverage gap is reported with exact per-language missing counts.
