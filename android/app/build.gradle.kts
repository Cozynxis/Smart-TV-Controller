plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "nl.smarttv.controller"
    compileSdk = 35

    defaultConfig {
        applicationId = "nl.smarttv.controller"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
    }

    buildFeatures {
        buildConfig = true
    }

    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/webassets"))
}

val syncWebAssets by tasks.registering(Copy::class) {
    from(rootProject.projectDir.parentFile) {
        include("manifest.json")
        include("css/**")
        include("js/**")
    }
    from("src/main/android-assets")
    into(layout.buildDirectory.dir("generated/webassets"))
}

tasks.named("preBuild").configure { dependsOn(syncWebAssets) }
