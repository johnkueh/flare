// The Android grocery list. Its own Gradle build, so the library's build at
// the repo root stays as JitPack builds it. Run it with the root's wrapper:
//
//   ../../gradlew -p example/android :app:installDebug
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // The prebuilt Rust store, as in any app on Flare.
        maven("https://pub-796846793f3e431ab3a92e0577c57dde.r2.dev/maven") { content { includeGroup("com.johnkueh.sync") } }
    }
    versionCatalogs {
        create("libs") { from(files("../../gradle/libs.versions.toml")) }
    }
}

rootProject.name = "flare-example-android"
include(":app")

// The library from this checkout rather than a tag (SYNC.md, "Working on
// sync and an app together").
includeBuild("../..") {
    dependencySubstitution { substitute(module("com.github.johnkueh:flare")).using(project(":sync")) }
}
