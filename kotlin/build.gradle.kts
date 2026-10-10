import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// Sync for Kotlin apps. Two parts:
//
//   com.johnkueh.sync.ffi     the Rust store (crate sync-ffi): UniFFI's Kotlin
//                             bindings (generated, checked in) plus
//                             libsync_ffi.so per ABI, prebuilt as the AAR
//                             com.johnkueh.sync:sync-ffi-native (see below)
//   com.johnkueh.sync.client  the HTTP client, sync pass, file transfer and
//                             live socket; the app supplies tokens and storage
//
// An app adds JitPack and the binaries' Maven repository (settings.gradle.kts
// here) and depends on com.github.johnkueh:flare:<tag> (README.md).
//
// The .so files come prebuilt, so an app builds without cargo.
// scripts/publish-binaries.sh builds, uploads and rewrites ffiVersion after a
// Rust change. To try a Rust change before publishing, build it with
// `./gradlew :sync:buildRustLibs`: libraries in build/rustJniLibs win over
// the AAR (from the next build on). Delete that folder to go back.
plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.serialization)
    `maven-publish`
}

val ffiVersion = "6a0bbcb44ec8"

val localRust = layout.buildDirectory.dir("rustJniLibs").get().asFile.isDirectory

android {
    namespace = "com.johnkueh.sync"
    compileSdk = 36

    defaultConfig {
        // Keep in sync with PLATFORM in scripts/build-android.sh.
        minSdk = 26
        consumerProguardFiles("consumer-rules.pro")
    }

    if (localRust) sourceSets["main"].jniLibs.srcDir(layout.buildDirectory.dir("rustJniLibs"))

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    publishing {
        singleVariant("release") { withSourcesJar() }
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
        optIn.add("kotlin.ExperimentalUnsignedTypes")
    }
}

dependencies {
    implementation("${libs.jna.get()}@aar")
    implementation(libs.kotlinx.coroutines.android)
    api(libs.okhttp)
    api(libs.kotlinx.serialization.json)
    if (!localRust) implementation("com.johnkueh.sync:sync-ffi-native:$ffiVersion@aar")
}

val rustWorkspace = rootDir
val rustSources = fileTree(File(rustWorkspace, "crates")) { include("**/*.rs", "**/Cargo.toml", "**/*.toml") } +
    files(File(rustWorkspace, "Cargo.toml"), File(rustWorkspace, "Cargo.lock"))

val buildRustLibs by tasks.registering(Exec::class) {
    group = "build"
    description = "Builds libsync_ffi.so with cargo-ndk and regenerates the Kotlin bindings."
    inputs.files(rustSources).withPropertyName("rustSources")
    outputs.dir(layout.buildDirectory.dir("rustJniLibs"))
    workingDir = rustWorkspace
    commandLine("bash", "scripts/build-android.sh")
    environment("ANDROID_HOME", android.sdkDirectory.absolutePath)
}

// The same library for this machine, for JVM tests against an unpublished
// change (point jna.library.path at target/android-release). Apps' tests
// normally use the published com.johnkueh.sync:sync-ffi-host jar instead.
val buildHostRustLib by tasks.registering(Exec::class) {
    group = "verification"
    description = "Builds libsync_ffi for the host, for unit tests."
    inputs.files(rustSources).withPropertyName("rustSources")
    outputs.dir(File(rustWorkspace, "target/android-release"))
    workingDir = rustWorkspace
    commandLine("cargo", "build", "-p", "sync-ffi", "--lib", "--profile", "android-release")
}

// What JitPack builds (jitpack.yml). It publishes under its own coordinates,
// com.github.johnkueh:flare:<tag>, whatever these say.
afterEvaluate {
    publishing {
        publications {
            create<MavenPublication>("release") {
                from(components["release"])
                groupId = "com.johnkueh.sync"
                artifactId = "sync"
                version = providers.environmentVariable("VERSION").getOrElse("dev")
            }
        }
    }
}
