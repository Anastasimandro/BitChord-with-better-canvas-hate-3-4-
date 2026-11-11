package com.music.bitchord.ui.components

import androidx.appcompat.app.AppCompatDelegate
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.os.LocaleListCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.music.bitchord.R
import com.music.bitchord.data.AppLanguage
import com.music.bitchord.data.LocaleTags
import com.music.bitchord.data.SUPPORTED_LANGUAGES
import com.music.bitchord.data.languageDisplayName
import com.music.bitchord.data.selfDisplayName
import com.music.bitchord.data.settings.AppSettings
import com.music.bitchord.data.sources.addon.AddonAuth
import dev.chrisbanes.haze.HazeState
import dev.chrisbanes.haze.materials.ExperimentalHazeMaterialsApi
import dev.chrisbanes.haze.materials.HazeMaterials
import java.util.Locale

/** How much of the screen the list may take before it scrolls inside the card. */
private val LANGUAGE_LIST_MAX_HEIGHT = 340.dp

/** Taps on the title that open the hidden tester-code field. */
private const val TESTER_TAPS = 10

/** A pause longer than this between taps starts the count again. */
private const val TESTER_TAP_GAP_MS = 2_000L

/**
 * Same frosted iOS alert as [LyricsSourcesDialog], but single-select rather
 * than checkable — there's no order or multiple-participation question here,
 * just one active language, so tapping a row applies it and closes the sheet
 * immediately rather than waiting on a separate Done action.
 */
@OptIn(ExperimentalHazeMaterialsApi::class)
@Composable
fun AppLanguageDialog(
    hazeState: HazeState,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val reduceDynamicBlur by AppSettings.reduceDynamicBlur.collectAsStateWithLifecycle()

    // Ten quick taps on the title swap this dialog for the tester-code field.
    // Hidden because it only matters to testers on phones the auth service
    // would otherwise refuse (unlocked bootloader); see AddonAuth.setTesterCode.
    var titleTaps by remember { mutableIntStateOf(0) }
    var lastTapAt by remember { mutableLongStateOf(0L) }
    var showTesterCode by remember { mutableStateOf(false) }
    if (showTesterCode) {
        TesterCodeAlert(hazeState = hazeState, onDismiss = onDismiss)
        return
    }

    val shape = RoundedCornerShape(ALERT_CORNER)
    // Full script tag (zh-Hant / zh-Hans preserved); legacy bare "zh" reads as Simplified.
    val currentLanguage = com.music.bitchord.data.LocaleTags.normalizeAppTag(
        AppCompatDelegate.getApplicationLocales().get(0)?.toLanguageTag()
            ?: Locale.getDefault().toLanguageTag(),
    )

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(SCRIM_COLOR)
            .clickable(
                indication = null,
                interactionSource = remember { MutableInteractionSource() },
                onClick = onDismiss,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier
                .width(ALERT_WIDTH)
                .clip(shape)
                .then(
                    if (reduceDynamicBlur) {
                        Modifier.background(MaterialTheme.colorScheme.surface)
                    } else {
                        Modifier.optimizedHazeEffect(
                            state = hazeState,
                            style = HazeMaterials.regular(MaterialTheme.colorScheme.surface),
                        )
                    },
                )
                // Swallows the tap before it reaches the scrim behind, so
                // touching the card itself never dismisses it.
                .clickable(
                    indication = null,
                    interactionSource = remember { MutableInteractionSource() },
                    onClick = {},
                ),
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 19.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(
                    text = stringResource(R.string.app_language),
                    modifier = Modifier.clickable(
                        indication = null,
                        interactionSource = remember { MutableInteractionSource() },
                    ) {
                        val now = System.currentTimeMillis()
                        titleTaps = if (now - lastTapAt > TESTER_TAP_GAP_MS) 1 else titleTaps + 1
                        lastTapAt = now
                        if (titleTaps >= TESTER_TAPS) showTesterCode = true
                    },
                    style = MaterialTheme.typography.bodyLarge.copy(
                        fontSize = 17.sp,
                        fontWeight = FontWeight.W600,
                    ),
                    color = MaterialTheme.colorScheme.onSurface,
                    textAlign = TextAlign.Center,
                )
                Text(
                    text = stringResource(R.string.app_language_description),
                    modifier = Modifier.padding(top = 4.dp),
                    style = MaterialTheme.typography.bodyMedium.copy(
                        fontSize = 13.sp,
                        lineHeight = 17.sp,
                    ),
                    color = MaterialTheme.colorScheme.onSurface,
                    textAlign = TextAlign.Center,
                )
            }

            // Capped and scrolled rather than laid out at full height, same as
            // [TranslationLanguageDialog] — sixteen rows is short enough not
            // to need that dialog's filter field, but still taller than the
            // card should get to stay centred on a phone.
            // The subtitles are the names in the app's current language — the
            // one the dialog is choosing — so the list is read against the
            // language it leads to.
            val displayLocale = Locale.forLanguageTag(currentLanguage)
            LazyColumn(modifier = Modifier.heightIn(max = LANGUAGE_LIST_MAX_HEIGHT)) {
                items(SUPPORTED_LANGUAGES, key = { it.tag }) { language ->
                    AlertRule()
                    LanguageRow(
                        language = language,
                        displayLocale = displayLocale,
                        selected = LocaleTags.normalizeAppTag(language.tag) == currentLanguage,
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
}

@Composable
private fun LanguageRow(language: AppLanguage, displayLocale: Locale, selected: Boolean, onClick: () -> Unit) {
    val interactionSource = remember { MutableInteractionSource() }
    val pressed by interactionSource.collectIsPressedAsState()
    // Both names read off the platform at render time: the row's own language
    // up top, and — when it reads differently — the same language in the
    // language the dialog is being read in. No per-language pointer resources,
    // so a new entry in [SUPPORTED_LANGUAGES] needs no new keys at all.
    val nativeName = language.selfDisplayName()
    val localizedName = languageDisplayName(language.tag, displayLocale)
    val hasDistinctLocalizedName = !localizedName.equals(nativeName, ignoreCase = true)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = ACTION_HEIGHT)
            .background(
                if (pressed) MaterialTheme.colorScheme.onSurface.copy(alpha = 0.09f) else Color.Transparent,
            )
            .clickable(
                indication = null,
                interactionSource = interactionSource,
                onClick = onClick,
            )
            .padding(horizontal = 16.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                text = nativeName,
                style = MaterialTheme.typography.bodyLarge.copy(fontSize = 15.sp),
                color = MaterialTheme.colorScheme.onSurface,
            )
            if (hasDistinctLocalizedName) {
                Text(
                    text = localizedName,
                    style = MaterialTheme.typography.bodyMedium.copy(fontSize = 12.sp, lineHeight = 15.sp),
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f),
                )
            }
        }
        if (selected) {
            Icon(
                imageVector = Icons.Rounded.Check,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(19.dp),
            )
        }
    }
}

/**
 * The hidden field itself. The saved code is never shown back: the field
 * starts empty, and the message says whether one is saved.
 */
@Composable
private fun TesterCodeAlert(hazeState: HazeState, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val saved = remember { AddonAuth.hasTesterCode() }
    var input by remember { mutableStateOf("") }
    TextValueAlert(
        hazeState = hazeState,
        title = stringResource(R.string.tester_code_title),
        message = stringResource(if (saved) R.string.tester_code_message_saved else R.string.tester_code_message),
        placeholder = stringResource(R.string.tester_code_placeholder),
        value = input,
        onValueChange = { input = it },
        saveEnabled = AddonAuth.normalizeTesterCode(input).isNotEmpty(),
        onSave = {
            if (AddonAuth.normalizeTesterCode(input).isNotEmpty()) {
                AddonAuth.setTesterCode(input)
                android.widget.Toast.makeText(context, R.string.tester_code_saved, android.widget.Toast.LENGTH_SHORT).show()
                onDismiss()
            }
        },
        onRemove = if (saved) {
            {
                AddonAuth.setTesterCode(null)
                android.widget.Toast.makeText(context, R.string.tester_code_removed, android.widget.Toast.LENGTH_SHORT).show()
                onDismiss()
            }
        } else {
            null
        },
        onDismiss = onDismiss,
    )
}
