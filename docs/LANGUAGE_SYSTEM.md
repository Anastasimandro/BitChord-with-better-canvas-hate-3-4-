# The language system

How BitChord's eighteen UI languages are defined, resolved, verified and
extended. Written after the seven-part language-system redesign
(`docs/language-system-prompts/`); it describes the repo as it stands now.

## The catalog — one canonical list

`shared/src/jvmSharedMain/kotlin/com/music/bitchord/data/LanguageCatalog.kt`
defines `SUPPORTED_LANGUAGES`, the single canonical list of app languages. It
is the **only** definition of that list — every picker, test and platform file
derives from it:

- the pickers (`AppLanguageDialog` on the phone, `TvLanguageDialog` on TV,
  the picker in `wearos/.../ui/ListScreens.kt`) render it directly;
- `LocaleStringsTest` parameterises its per-locale key-parity checks from it;
- `LocalizationTest` verifies `locales_config.xml` against it;
- `SharedUiStringsTest` derives its sharedUi locale list from it;
- display names are not stored per language: `selfDisplayName()` derives the
  own-language spelling from the platform (CLDR) at runtime, with the eight
  overrides documented in the catalog (capitalisation, and the 简体中文/繁體中文
  pair that CLDR would collapse to one 中文).

Catalog tags are BCP-47 with region for Chinese (`zh-CN` / `zh-TW`, never bare
`zh`): shared Compose resources match on language + region, and
`LocaleTags.normalizeAppTag` maps both forms to the same script downstream.
Android resource directories use `-r` regions — `values-zh` (Simplified) and
`values-zh-rTW` (Traditional); `LocaleStringsTest.tagToQualifier` mirrors that
mapping.

## Tag normalization — one place

`shared/src/jvmSharedMain/kotlin/com/music/bitchord/data/LocaleTags.kt` is the
only tag-normalization and wire-mapping point:

- `normalizeAppTag(raw)` — any incoming tag to `zh-Hant` / `zh-Hans` / base
  language, with the legacy Google spellings (`iw`→`he`, `in`→`id`, `ji`→`yi`,
  `jw`→`jv`) handled here and nowhere else. Bare `zh` reads as Simplified.
- `sameLanguageScriptAware(first, second)` — script-aware equality:
  `zh-Hant` ≠ `zh-Hans` ≠ `zh`. Used by the lyrics pipeline's "already in your
  language" check (`LyricsTranslation`) so Simplified lyrics are not offered to
  a Traditional-Chinese reader.
- Wire helpers: `ytHl` / `ytGl` / `ytSearchGl` (Innertube context), 
  `acceptLanguage`, `translationWireTarget` (lyrics `tl`; maps Chinese script
  to `zh-TW` / `zh-CN` because the endpoint always returns Simplified for bare
  `zh`). `Innertube.currentLanguage` is `ytHl(currentLocaleTag)` — every `hl`
  the app sends goes through that one spelling, stats pings included.

`LocaleTagsTest` (in `shared/src/jvmTest`) guards these invariants: Chinese
compares script-aware, bare `zh` does not collapse into either script, legacy
spellings normalize, and the wire helpers always hyphenate.

## Which module ships which language resources, and how language is resolved

| Module | Resource folders | Language resolution |
|---|---|---|
| `app` (phone) | `app/src/main/res/values` + `values-{de,es,fr,he,hi,id,it,ja,ko,pl,pt,ru,th,tr,vi,zh,zh-rTW}`; `xml/locales_config.xml` | Per-app locale: `AppLanguageDialog` writes `AppCompatDelegate.setApplicationLocales`; persisted/restored via the manifest's `AppLocalesMetadataHolderService` (`autoStoreLocales`). `android:localeConfig="@xml/locales_config"` exposes the list to the system. |
| `tv` | No full set of its own: `tv/build.gradle.kts` reuses `../app/src/main/res` wholesale and adds `tv/src/main/res/values` + `values-{de,es,fr,ja,pt,ru}` with the `tv_*` keys | Same per-app locale mechanism as the phone; the picker is `TvLanguageDialog`, opened from `TvSettingsScreen`. Its `@xml/locales_config` reference resolves into the app module's file. |
| `wearos` | `wearos/src/main/res/values` + the same 17 locale folders as the phone (only the handful of wearable strings) | Its own picker in `ListScreens.kt` writing `AppCompatDelegate.setApplicationLocales`; manifest carries `android:localeConfig="@xml/locales_config"` and `AppLocalesMetadataHolderService` for persistence (`wearos/src/main/res/xml/locales_config.xml`). Deliberately its own picker — not "follow the phone". |
| `sharedUi` | `sharedUi/src/commonMain/composeResources/values` + the same 17 locale folders (player/lyrics/queue strings) | No picker and no persistence — sharedUi always follows the host surface's app locale. |
| `web` | — | Web has no language system; i18n on web was considered (part-6 of the redesign) and deliberately skipped. |

The Innertube/YouTube language (`Innertube.currentLanguage`) is derived from the
app locale on every surface through `LocaleTags.ytHl(currentLocaleTag)`; the
apps hook `Innertube.appLanguage` to the per-app locale so content catalogues
follow the picker, not the device.

## Verification

The invariants are enforced by tests that all derive their locale list from the
catalog — nothing hand-copied:

| Check | Where | What it proves |
|---|---|---|
| `LocaleStringsTest` | `app/src/test` (parameterised per catalog locale) | Every non-English app `values-*/strings.xml` carries **all** translatable keys of `values/strings.xml` — a missing key would silently fall back to English mid-screen. |
| `LocalizationTest` | `app/src/test` | `locales_config.xml` exists, covers every catalog language (and never carries a bare `zh`); display names resolve at runtime. |
| `SharedUiStringsTest` | `sharedUi/src/jvmTest` (parameterised per catalog locale) | Every sharedUi compose-resource locale carries all sharedUi must-translate keys. |
| `LocaleTagsTest` | `shared/src/jvmTest` | Tag normalization / wire-mapping invariants (see above). |

Gradle entry points (names are flavor-scoped by the env dimension, so the bare
`:app:testDebugUnitTest` does not exist — `testDevDebugUnitTest` is the real
one):

- `:app:i18nParityTest` — runs the app parity tests (`testDevDebugUnitTest`)
  and prints the coverage table; `app/check` depends on it.
- `:app:localeCoverage` — prints expected-vs-present translatable keys per
  language, plus the **untranslated-value report** (below). Prints rather than
  fails; `LocaleStringsTest` is the hard gate.
- `:sharedUi:sharedUiI18nParityTest` — runs `:sharedUi:jvmTest`;
  `sharedUi/check` depends on it.
- `:sharedUi:sharedUiLocaleCoverage` — the same tables for sharedUi's
  compose-resource catalogues.
- `:shared:jvmTest` — `LocaleTagsTest` and the rest of the shared JVM tests.

CI (`.github/workflows/check.yml`, "Tests" step) runs all of it on every push
to `main` and every PR:

```
./gradlew testDevDebugUnitTest :shared:jvmTest :app:localeCoverage :sharedUi:jvmTest :sharedUi:sharedUiLocaleCoverage
```

followed by the assemble battery (`:app:assembleDevDebug :wearos:assembleDevDebug
:tv:assembleDevDebug` — the modules carry a dev/prod flavor, so the
DevDebug tasks stand in for the doc's bare `assembleDebug` names).

### The untranslated-value report

Both `localeCoverage` and `sharedUiLocaleCoverage` end with a non-blocking
report: locales whose value for a translatable key is **identical to the
English source**. It prints rather than fails — brand names, technical terms
and genre words ("Discord", "Jazz", "Mono") are legitimately identical
everywhere, so a hard failure would flood CI for pre-existing catalogues. A
useful cut when reading it: keys identical in *every* locale are almost always
intentional; keys identical in *some* locales while others translate them are
the genuine gaps a translator can pick up. Known pre-existing examples carried
in the report: `no_audio_version`, `no_video_version` and
`version_switch_in_party`, left identical to English in the `zh` and `zh-rTW`
app files (and in most other non-English app files).

## How to add a new language — the `ar` walkthrough

Exactly five steps, all mechanical. Adding `ar` (Arabic):

1. **Catalog entry** — one line in
   `shared/src/jvmSharedMain/kotlin/com/music/bitchord/data/LanguageCatalog.kt`:
   `AppLanguage("ar")`. No display-name override needed: CLDR's self-name
   ("العربية") is derived at runtime and `LocalizationTest`
   (`supportedLanguages_haveRuntimeDisplayNames`) verifies it is not blank.
2. **Resource folders per module** — create `values-ar` beside the existing
   folders:
   - `app/src/main/res/values-ar/strings.xml` — copy of
     `app/src/main/res/values/strings.xml` to translate. It must contain
     **every translatable key** of the English file or `LocaleStringsTest`
     fails CI (that is the designed guard, not an accident).
   - `sharedUi/src/commonMain/composeResources/values-ar/strings.xml` — copy
     of the sharedUi `values/strings.xml`; `SharedUiStringsTest` enforces the
     same completeness.
   - `tv/src/main/res/values-ar/strings.xml` — the `tv_*` keys, same rule as
     the other TV locales (translate what the TV surfaces show).
   - `wearos/src/main/res/values-ar/strings.xml` — the wearable strings.
   The resource qualifiers use plain `values-ar` — no region, no `-r` (only
   Chinese needs the region form, and it already has it).
3. **`locales_config.xml` per module that declares it** — add
   `<locale android:name="ar" />` to `app/src/main/res/xml/locales_config.xml`
   (which TV also resolves through) and
   `wearos/src/main/res/xml/locales_config.xml`. `LocalizationTest` fails if
   the app file misses a catalog language, so the test — not memory — closes
   this step.
4. **Translations** — fill the four files above, sharedUi included (its
   strings are what the player screen shows on phone, TV and Wear alike).
   Arabic is RTL; both `app` and `tv`/`wearos` manifests already declare
   `android:supportsRtl="true"`, so no extra wiring — but walk a screen or two
   on a device, as for any new locale.
5. **Tests green in CI** — push. The Check workflow runs
   `testDevDebugUnitTest` (→ `LocaleStringsTest`, `LocalizationTest`),
   `:shared:jvmTest`, `:app:localeCoverage`,
   `:sharedUi:jvmTest` (→ `SharedUiStringsTest`) and
   `:sharedUi:sharedUiLocaleCoverage`, then assembles `app`, `wearos` and
   `tv`. A catalogue that misses a key, a `locales_config` entry or the
   catalog entry itself fails a named test with a message naming the gap —
   no surprises.

No other file changes. Nothing else in the repo holds a language list.
