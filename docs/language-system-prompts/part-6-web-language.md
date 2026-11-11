# Part 6 — Web: stop being outside the language system (OPTIONAL)

You are working in the BitChord repository. The `web/` directory is a separate TypeScript project
(not part of the Gradle build). Code comments in English. **Run this part only if the user
explicitly confirms they want i18n on the web.** If they do not confirm, skip it and say so.

## Fresh-session bootstrap (read first)

- Work in the repo root `C:\Users\A\Proyectos\BitChord-with-better-canvas-hate-3-4-`
  (Windows: `web/` uses npm/its own toolchain, not Gradle). Every path below is relative to that root.
- This prompt is self-contained: no prior conversation or document is needed. Line numbers were
  verified on 2026-11-11 — re-check them before editing.
- **Pre-flight**: `shared/src/jvmSharedMain/kotlin/com/music/bitchord/data/LanguageCatalog.kt`
  must exist (Part 1 done) — if not, STOP and tell the user to run Part 1 first. This part is
  OPTIONAL: before anything else, ask the user to confirm they want web i18n; without an explicit
  yes, stop and say the part was skipped.
- **STOP and ask**: the implementation plan (item 1) must be presented and approved by the user
  before any code is written.
- **Report format**: when done, list every file changed, paste the output of the verification
  commands, record the approved plan, and explicitly confirm each acceptance criterion.

## Problem

Android (phone/TV/wear) has two language pickers and a guarded translation pipeline; the web has
no language system at all.

## Verified current state

- No translation files, no picker, no locale detection in `web/`; UI is English-only.
- Lyrics: Translate and Romanise are **am-lyrics' own buttons** (Google's endpoint — the same one
  `shared/.../data/lyrics/LyricsTranslation.kt` uses on Android) and they translate **to English
  only**. Documented at `web/docs/lyrics.md:61`, and "Choosing a translation language other than
  English" is listed under "Not done or not verified" at `web/docs/lyrics.md:82`.
- `web/app/src/playback/youtube/innertube.ts:59`: only `accept`, `accept-language`,
  `content-language` are safelisted as request headers; no `hl` parameter handling.
- The extension reports `navigator.language` to Discord
  (`web/extension/lib/discord.ts:73` — re-verify the path/line before citing).
- The Android catalog after Part 1 lives in
  `shared/src/jvmSharedMain/kotlin/com/music/bitchord/data/LanguageCatalog.kt`
  (`SUPPORTED_LANGUAGES`, 18 tags; `zh-CN`/`zh-TW` script semantics in `LocaleTags.kt`).

## Tasks (only after user confirmation)

1. **Propose before implementing.** Present a short plan covering:
   - translation format (suggest JSON files keyed the same way as
     `sharedUi/src/commonMain/composeResources/values/strings.xml` so key names stay consistent
     across platforms);
   - language detection (`navigator.language`) plus a manual override persisted in
     localStorage;
   - which of the 18 catalog languages ship at first (do not promise all 18 on day one).
   Wait for approval.
2. **Catalog sync**: mirror the 18-language catalog into `web/` and add a test (Vitest or the
   project's runner) that fails if the web catalog drifts from
   `LanguageCatalog.kt` (parse the Kotlin file or generate the mirror with a small script —
   pick the approach that fits how `web/` already syncs anything else).
3. **Minimum viable implementation** of the approved plan:
   - picker + persisted override + `navigator.language` fallback;
   - lyrics translation with a target-language selector wired to the same Google endpoint
     am-lyrics already uses, including Simplified/Traditional handling equivalent to
     `LocaleTags.translationWireTarget` (`zh-TW`/`zh-CN` on the wire, never bare `zh`);
   - replace (or wrap) am-lyrics' English-only Translate button when a non-English target is set.
4. Update `web/docs/lyrics.md` (lines 61 and 82) to describe the new behavior honestly.

## Acceptance criteria

- Web respects the browser language with a working manual override.
- Lyrics translate to the chosen target, including both Chinese scripts; no bare `zh` leaves
  the client.
- Catalog-sync test passes and demonstrably fails on drift.
- `web/docs/lyrics.md` no longer lists "translation language other than English" as not-done.
