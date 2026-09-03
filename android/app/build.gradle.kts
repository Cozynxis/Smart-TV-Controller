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

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
    }

    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/webassets"))
}

kotlin {
    jvmToolchain(17)
}

val syncWebAssets by tasks.registering(Copy::class) {
    from(rootProject.projectDir.parentFile) {
        include("manifest.json")
        include("css/**")
        include("js/**")
    }
    from(rootProject.projectDir.parentFile) {
        include("index.html")
        filter { line: String ->
            line
                .replace("<script src=\"js/app.js\"></script>", "<script src=\"js/android-native.js\"></script>\n<script src=\"js/app.js\"></script>")
                .replace("<script src=\"js/enhancements.js\"></script>", "<script src=\"js/enhancements.js\"></script>\n<script src=\"js/animation-creator.js\"></script>\n<script src=\"js/custom-animation-fixes.js\"></script>\n<script src=\"js/remote-secure.js\"></script>\n<script src=\"js/announcements.js\"></script>\n<script src=\"js/countdown.js\"></script>\n<script src=\"js/apps-enhanced.js\"></script>")
        }
    }
    into(layout.buildDirectory.dir("generated/webassets"))
}

tasks.named("preBuild").configure { dependsOn(syncWebAssets) }
