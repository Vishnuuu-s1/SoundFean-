# SoundFean adapter for BitChord playback

This folder is required at runtime. Upload the complete folder, including every
file in `lib/`. The compiled adapter is included; Vercel only installs the Python
requirements. No Gradle or JDK compilation is required during deployment.

The adapter uses the playback libraries from the supplied BitChord project:

- InnerTubeX JVM/desktop v0.7.0: https://github.com/MetrolistGroup/innertubex/tree/v0.7.0
- NewPipe Extractor v0.26.3: https://github.com/TeamNewPipe/NewPipeExtractor/tree/v0.26.3
- `PlayerClient.kt` is adapted from BitChord's client-specific media headers.

InnerTubeX is attempted first and NewPipe is the extraction fallback. Python
validates the returned audio with a bounded byte request before exposing a
same-origin stream. Browser playback uses SoundFean's HTML audio element.
BitChord's Android player/foreground service is not a browser component.

The adapter accepts public, unrestricted content only. It does not use account
cookies, Android WebView token generation, or age-restriction bypasses.

## Source and rebuilding

Adapter source is in `src/`; the two extractor source archives are in
`dependency-sources/`. GPL licensing is retained in `COPYING`. Other runtime
dependencies retain their own licenses in their JAR metadata; pinned dependency
versions are listed in `DEPENDENCIES.txt`. Sources, licenses and release records
for the extractors are also available at the URLs above.

With JDK 17 installed, run from this folder:

```sh
java -classpath gradle/wrapper/gradle-wrapper.jar org.gradle.wrapper.GradleWrapperMain installDist
```

Copy the generated `build/install/soundfean-bitchord-resolver/lib/` contents into
`lib/` when rebuilding. Compiler and dependency downloads require access to
Gradle, Maven Central and JitPack. The included runtime libraries are already
compiled. Python installs its Java runtime through `jdk4py==25.0.2.1`.

## Operational limits

Extraction can take several seconds on a cold backend. Audio requests consume
backend bandwidth and function execution. A host/CDN refusal results in a clear
playback error; this adapter does not silently return to the hidden iframe.

The compiled resolver and local route/player tests passed. A public test video's
AAC URL was resolved through InnerTubeX, but CDN audio reads timed out in the
test environment. Vercel deployment and playback with a locked physical phone
have not been verified. Test a preview deployment before updating production.
