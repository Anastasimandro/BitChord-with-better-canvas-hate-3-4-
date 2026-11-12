import org.jetbrains.kotlin.gradle.dsl.JvmTarget

/*
 * The Compose UI both applications draw from — the player first.
 *
 * Library versions are pinned to the Compose Multiplatform release whose
 * Android artifacts are the androidx ones the phone app already runs (CMP
 * 1.10.x -> androidx 1.10.x, material3 1.7.3 -> androidx material3 1.3.1), so
 * depending on this module never moves the phone's Compose underneath it. The
 * desktop resolves its own newer versions over these at the top of its graph.
 *
 * The pin is the *Android* anchor only. On the JVM it is a floor, not a
 * ceiling — and there it matters which version compiles this module, because
 * the desktop resolves ui-desktop 1.12.0 / skiko 0.150.x at runtime. Skia's
 * Matrix33 became an inline float[9] between skiko 0.9 and 0.15
 * (`makeTranslate` went from returning a Matrix33 to a name-mangled float[]
 * overload), so bytecode compiled against 0.9 linked its object call and
 * crashed with NoSuchMethodError on the desktop the first time a lyric line
 * grew. Compiling the module against the version the desktop actually
 * resolves keeps the compile-time link and the runtime link the same.
 */
val cmp = "1.10.3"

/** What the desktop graph resolves; see the comment above. */
val CMP_DESKTOP =
    // Haze 1.7.x, which the Windows build uses, was compiled
    // against a ShaderBrush.createShader that returns skia's Shader; 1.12 changed that return
    // type, so on 1.12 every blur dies with NoSuchMethodError. Windows stays on the plugin's
    // own 1.10.3 / skiko 0.9; only Linux moves to 1.12.
    if (System.getProperty("os.name").contains("Windows", ignoreCase = true)) "1.10.3" else "1.12.0"

plugins {
    id("org.jetbrains.kotlin.multiplatform")
    id("com.android.library")
    id("org.jetbrains.compose")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

kotlin {
    androidTarget {
        compilerOptions {
            jvmTarget.set(JvmTarget.JVM_17)
        }
    }

    jvm {
        compilerOptions {
            jvmTarget.set(JvmTarget.JVM_17)
        }
    }

    applyDefaultHierarchyTemplate()

    compilerOptions {
        freeCompilerArgs.add("-Xexpect-actual-classes")
    }

    sourceSets {
        // Both targets are JVMs, so the UI is written once against the JDK here
        // rather than in commonMain.
        val jvmSharedMain by creating {
            dependsOn(commonMain.get())
        }
        androidMain.get().dependsOn(jvmSharedMain)
        jvmMain.get().dependsOn(jvmSharedMain)

        commonMain.dependencies {
            api(project(":shared"))
            api("org.jetbrains.compose.runtime:runtime:$cmp")
            api("org.jetbrains.compose.foundation:foundation:$cmp")
            api("org.jetbrains.compose.animation:animation:$cmp")
            api("org.jetbrains.compose.ui:ui:$cmp")
            api("org.jetbrains.compose.material3:material3:1.7.3")
            api("org.jetbrains.compose.material:material-icons-extended:1.7.3")
            api("org.jetbrains.compose.components:components-resources:$cmp")
            api("org.jetbrains.androidx.lifecycle:lifecycle-runtime-compose:2.8.4")
            api("io.coil-kt.coil3:coil-compose:3.0.4")
            api("dev.chrisbanes.haze:haze:1.3.1")
            api("dev.chrisbanes.haze:haze-materials:1.3.1")
            implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0")
            implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
        }
        // Compiled against what the desktop actually resolves, not the phone's
        // pin — see the CMP_DESKTOP comment at the top of this file. Skia's
        // Matrix33 changed shape between skiko 0.9 and 0.15, and bytecode built
        // against 0.9 NoSuchMethodError'd the desktop's 0.15 at draw time.
        jvmMain.dependencies {
            api("org.jetbrains.compose.ui:ui-desktop:$CMP_DESKTOP")
        }
        jvmTest.dependencies {
            implementation(kotlin("test"))
            implementation("junit:junit:4.13.2")
        }
        androidMain.dependencies {
            // The phone's own versions, so nothing here moves them.
            implementation("androidx.activity:activity-compose:1.9.3")
            implementation("androidx.core:core-ktx:1.15.0")
            implementation("androidx.appcompat:appcompat:1.7.0")
            implementation("androidx.palette:palette-ktx:1.0.0")
        }
    }
}

android {
    namespace = "com.music.bitchord.sharedui"
    compileSdk = 36
    defaultConfig {
        minSdk = 26
    }
}

compose.resources {
    publicResClass = true
    packageOfResClass = "com.music.bitchord.sharedui.resources"
    generateResClass = always
}

/*
 * sharedUi's own parity entry points, mirroring the app module's
 * i18nParityTest / localeCoverage (see app/build.gradle.kts).
 *
 * The parity test itself (SharedUiStringsTest in sharedUi/src/jvmTest) is an
 * ordinary unit-test source set, so it already runs under `check` — but the
 * dedicated task is the named entry point, so neither CI nor the next person
 * has to rediscover it, and `check` carries the promise explicitly.
 */
val sharedUiI18nParityTest = tasks.register("sharedUiI18nParityTest") {
    group = "verification"
    description = "Runs the sharedUi locale parity test (SharedUiStringsTest, JVM target)."
    dependsOn("jvmTest")
}

/*
 * The same coverage table as the app's localeCoverage, pointed at this
 * module's compose-resource catalogues. Prints rather than fails —
 * SharedUiStringsTest is the one that fails — because the point here is to
 * see HOW FAR a language is behind, not just that it is.
 *
 * Reads the XML by hand rather than through the resource system: the numbers
 * must come from exactly the files a translator would edit, and this runs on
 * a machine with no device attached.
 */
tasks.register("sharedUiLocaleCoverage") {
    group = "verification"
    description = "Prints expected vs present translatable string keys per sharedUi locale catalogue."
    doLast {
        val resDir = file("src/commonMain/composeResources")
        val baseFile = resDir.resolve("values/strings.xml")

        val parser = javax.xml.parsers.DocumentBuilderFactory.newInstance().newDocumentBuilder()
        // Keys that need translating: `translatable="false"` entries are excluded,
        // matching what SharedUiStringsTest counts as must-translate.
        fun translatableKeys(file: File): Set<String> {
            val keys = mutableSetOf<String>()
            val doc = parser.parse(file)
            for (tagName in listOf("string", "plurals", "string-array")) {
                val nodes = doc.getElementsByTagName(tagName)
                for (i in 0 until nodes.length) {
                    val element = nodes.item(i) as org.w3c.dom.Element
                    if (element.getAttribute("translatable") == "false") continue
                    val name = element.getAttribute("name")
                    if (name.isNotEmpty()) keys.add(name)
                }
            }
            return keys
        }

        val baseKeys = translatableKeys(baseFile)
        logger.lifecycle("")
        logger.lifecycle("sharedUi locale key coverage against values/strings.xml (${baseKeys.size} translatable keys)")
        logger.lifecycle("")
        logger.lifecycle("${"catalogue".padEnd(14)}${"present".padEnd(10)}missing")
        resDir.listFiles { f -> f.isDirectory && f.name.startsWith("values-") }
            ?.sortedBy { it.name }
            ?.forEach { dir ->
                val strings = dir.resolve("strings.xml")
                if (!strings.isFile) {
                    logger.lifecycle("${dir.name.padEnd(14)}${"-".padEnd(10)}(no strings.xml)")
                    return@forEach
                }
                val present = translatableKeys(strings)
                val missing = baseKeys - present
                val shown = missing.sorted().take(12)
                logger.lifecycle(
                    "${dir.name.padEnd(14)}" +
                        "${"${present.size}/${baseKeys.size}".padEnd(10)}" +
                        "${missing.size} missing" +
                        if (missing.isEmpty()) "" else "  e.g. ${shown.joinToString()}${if (missing.size > shown.size) " ." else ""}",
                )
            }

        /*
         * Untranslated-value report (non-blocking): locales whose value for a
         * translatable key is identical to the English source. Same reasoning
         * as the app module's localeCoverage — brand and technical terms are
         * legitimately identical everywhere, so this prints rather than fails;
         * SharedUiStringsTest and the table above stay the hard gates.
         */
        fun valueTexts(file: File): Map<String, String> {
            val doc = parser.parse(file)
            val texts = mutableMapOf<String, String>()
            val nodes = doc.getElementsByTagName("string")
            for (i in 0 until nodes.length) {
                val element = nodes.item(i) as org.w3c.dom.Element
                val name = element.getAttribute("name")
                if (name.isNotEmpty()) texts[name] = element.textContent
            }
            return texts
        }

        fun comparableText(text: String) = text.replace(Regex("\\s+"), " ").trim()

        val english = valueTexts(baseFile)
        logger.lifecycle("sharedUi untranslated values (identical to the English source — report only, no failure):")
        var anyUntranslated = false
        resDir.listFiles { f -> f.isDirectory && f.name.startsWith("values-") }
            ?.sortedBy { it.name }
            ?.forEach { dir ->
                val strings = dir.resolve("strings.xml")
                if (!strings.isFile) return@forEach
                val identical = valueTexts(strings).entries.mapNotNull { (name, value) ->
                    val en = english[name]
                    if (
                        en != null &&
                        comparableText(en).isNotEmpty() &&
                        comparableText(value) == comparableText(en)
                    ) {
                        name
                    } else {
                        null
                    }
                }.sorted()
                if (identical.isEmpty()) return@forEach
                anyUntranslated = true
                val shown = identical.take(12)
                logger.lifecycle(
                    "  ${dir.name.padEnd(14)}${"${identical.size} identical".padEnd(14)}" +
                        "e.g. ${shown.joinToString()}${if (identical.size > shown.size) " …" else ""}",
                )
            }
        if (!anyUntranslated) logger.lifecycle("  (none)")
        logger.lifecycle("")
    }
}

// `check` already runs the jvmTest source set, SharedUiStringsTest included;
// depending on the dedicated task makes that promise explicit and keeps the
// two entry points from drifting apart.
tasks.named("check") { dependsOn(sharedUiI18nParityTest) }
