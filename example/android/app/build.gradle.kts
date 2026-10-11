import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "com.johnkueh.flare.groceries"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.johnkueh.flare.groceries"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
        // The Worker in example/. 10.0.2.2 is the emulator's name for the
        // Mac's localhost. -Pserver=https://… points at a deployed one.
        val server = providers.gradleProperty("server").getOrElse("http://10.0.2.2:8787")
        buildConfigField("String", "SERVER", "\"$server\"")
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    // Any version: settings.gradle.kts swaps in this checkout's :sync.
    implementation("com.github.johnkueh:flare:local")
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.activity.compose)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.material3)
}
