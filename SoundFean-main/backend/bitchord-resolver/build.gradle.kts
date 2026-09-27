import org.jetbrains.kotlin.gradle.dsl.JvmTarget
plugins {
    kotlin("jvm") version "2.4.10"
    application
}
repositories {
    mavenCentral()
    maven("https://jitpack.io")
}
dependencies {
    implementation("com.github.MetrolistGroup.innertubex:innertubex-desktop:v0.7.0")
    implementation("io.ktor:ktor-client-okhttp:3.5.2")
    implementation("io.ktor:ktor-client-content-negotiation:3.5.2")
    implementation("io.ktor:ktor-serialization-kotlinx-json:3.5.2")
    implementation("com.github.TeamNewPipe:NewPipeExtractor:v0.26.3")
}
kotlin { compilerOptions.jvmTarget.set(JvmTarget.JVM_17) }
application { mainClass.set("MainKt") }
tasks.jar {
    manifest { attributes["Main-Class"] = "MainKt" }
}
