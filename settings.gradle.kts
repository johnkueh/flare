// The Kotlin library, as its own Gradle build so JitPack (and anyone with a
// checkout) can build it: `./gradlew :sync:assembleRelease`.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

// The prebuilt Rust libraries (scripts/publish-binaries.sh). Apps add this
// repository too.
val syncBinaries = "https://pub-796846793f3e431ab3a92e0577c57dde.r2.dev/maven"

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        maven(syncBinaries) { content { includeGroup("com.johnkueh.sync") } }
    }
}

rootProject.name = "flare"
include(":sync")
project(":sync").projectDir = file("kotlin")
