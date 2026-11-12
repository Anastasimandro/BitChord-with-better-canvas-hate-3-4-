package com.music.bitchord.ui.tv.dialogs

import androidx.appcompat.app.AppCompatDelegate
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Check
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.os.LocaleListCompat
import com.music.bitchord.R
import com.music.bitchord.data.LocaleTags
import com.music.bitchord.data.SUPPORTED_LANGUAGES
import com.music.bitchord.data.languageDisplayName
import com.music.bitchord.data.selfDisplayName
import com.music.bitchord.ui.tv.components.TvDialog
import com.music.bitchord.ui.tv.components.TvListRow
import com.music.bitchord.ui.tv.components.tvInitialFocus
import java.util.Locale

/**
 * The phone's AppLanguageDialog, as a tvOS list: the shared catalog, each row
 * leading with the language's own spelling and — when it reads differently —
 * that language's name in the language the dialog is being read in, a check
 * on the active one. Selecting applies through AppCompatDelegate — the same
 * single writer the phone uses — and closes; on Android 13+ the system
 * applies the locale and recreates the activity into the new language
 * (per-app locales are system-managed there).
 */
@Composable
fun TvLanguageDialog(onDismiss: () -> Unit) {
    // Full script tag (zh-Hans / zh-Hant preserved); legacy bare "zh" reads
    // as Simplified — the same normalization the phone's dialog applies.
    val currentLanguage = remember {
        LocaleTags.normalizeAppTag(
            AppCompatDelegate.getApplicationLocales().get(0)?.toLanguageTag()
                ?: Locale.getDefault().toLanguageTag(),
        )
    }
    val displayLocale = remember(currentLanguage) { Locale.forLanguageTag(currentLanguage) }
    // The row that starts focused: the active language, or the first row when
    // the device's locale is one the catalog does not offer — a remote has no
    // cursor, so an unfocused list would be a dead one.
    val focusIndex = remember(currentLanguage) {
        SUPPORTED_LANGUAGES.indexOfFirst { LocaleTags.normalizeAppTag(it.tag) == currentLanguage }
            .takeIf { it >= 0 } ?: 0
    }

    TvDialog(
        title = stringResource(R.string.app_language),
        message = stringResource(R.string.app_language_description),
        onDismissRequest = onDismiss,
    ) {
        // Capped and scrolled like TvLyricsSourcesDialog — eighteen rows is
        // taller than the dialog should get to stay centred.
        LazyColumn(
            modifier = Modifier.heightIn(max = 304.dp),
            verticalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            itemsIndexed(SUPPORTED_LANGUAGES, key = { _, language -> language.tag }) { index, language ->
                val selected = LocaleTags.normalizeAppTag(language.tag) == currentLanguage
                val nativeName = language.selfDisplayName()
                val localizedName = languageDisplayName(language.tag, displayLocale)
                TvListRow(
                    title = nativeName,
                    subtitle = if (localizedName.equals(nativeName, ignoreCase = true)) null else localizedName,
                    trailingIcon = if (selected) Icons.Rounded.Check else null,
                    modifier = if (index == focusIndex) Modifier.tvInitialFocus() else Modifier,
                    onClick = {
                        AppCompatDelegate.setApplicationLocales(
                            LocaleListCompat.forLanguageTags(language.tag),
                        )
                        onDismiss()
                    },
                )
            }
        }
    }
}
