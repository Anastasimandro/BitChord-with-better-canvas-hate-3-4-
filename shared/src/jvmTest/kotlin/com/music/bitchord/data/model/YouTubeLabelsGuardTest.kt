package com.music.bitchord.data.model

import java.io.File
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * Guard test to prevent regressions in YouTube localized label handling.
 *
 * All raw YouTube shelf title and metadata label matching MUST go through
 * the central registry ([ShelfTitles] and [MediaTypeWords]).
 *
 * This test scans source files across commonMain, jvmSharedMain, sharedUi, and app
 * to ensure that forbidden literals like "Listen again", "Quick picks", etc. are
 * not used in ad-hoc .equals / .contains / etc. calls.
 */
class YouTubeLabelsGuardTest {

    private val FORBIDDEN_LITERALS = listOf(
        "Listen again",
        "Quick picks",
        "Escuchar de nuevo",
        "Selecciones rápidas",
        "Elección rápida",
        "Mixed for you",
        "Mezclas para ti",
    )

    private val ALLOWED_FILES = setOf(
        "ShelfTitles.kt",
        "MediaTypeWords.kt",
        // Test files are permitted to assert against canonical strings
        "ShelfTitleTest.kt",
        "LocalizedMetadataTest.kt",
        "YouTubeLabelsGuardTest.kt",
    )

    @Test
    fun noRawYouTubeLabelsOutsideCentralRegistry() {
        var rootDir = File(".").canonicalFile
        while (rootDir != null && !File(rootDir, "settings.gradle.kts").exists()) {
            rootDir = rootDir.parentFile
        }
        val repoRoot = rootDir ?: File(".")

        val sourceDirs = listOf(
            File(repoRoot, "shared/src/commonMain"),
            File(repoRoot, "shared/src/jvmSharedMain"),
            File(repoRoot, "sharedUi/src/jvmSharedMain"),
            File(repoRoot, "app/src/main/java"),
        ).filter { it.exists() }

        val violations = mutableListOf<String>()

        val methodCallRegex = Regex("""\.(equals|contains|startsWith|endsWith|removePrefix|removeSuffix)\s*\([^)]*?"([^"]+)"[^)]*?\)""")

        for (dir in sourceDirs) {
            dir.walkTopDown().filter { it.isFile && it.extension == "kt" }.forEach { file in
                if (file.name in ALLOWED_FILES) return@forEach

                val lines = file.readLines()
                lines.forEachIndexed { index, line ->
                    val trimmed = line.trim()
                    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return@forEachIndexed

                    for (match in methodCallRegex.findAll(line)) {
                        val literal = match.groupValues[2]
                        for (forbidden in FORBIDDEN_LITERALS) {
                            if (literal.equals(forbidden, ignoreCase = true)) {
                                violations.add("${file.relativeTo(repoRoot)}:${index + 1}: found '$forbidden' in method call: $trimmed")
                            }
                        }
                    }
                }
            }
        }

        assertTrue(
            violations.isEmpty(),
            "Found raw YouTube label literals outside ShelfTitles:\n" + violations.joinToString("\n")
        )
    }
}
