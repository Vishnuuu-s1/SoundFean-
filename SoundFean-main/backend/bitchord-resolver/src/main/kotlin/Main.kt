// SPDX-License-Identifier: GPL-3.0-only
// Backend adaptation of the supplied BitChord playback flow.
import com.metrolist.innertubex.InnerTube
import com.metrolist.innertubex.InnerTubeLogger
import com.metrolist.innertubex.cipher.PlayerConfigRepository
import com.metrolist.innertubex.cipher.RemotePlayerConfigStore
import com.metrolist.innertubex.cipher.YouTubeCipherService
import com.metrolist.innertubex.extraction.AudioQuality
import com.metrolist.innertubex.extraction.ContentHints
import com.metrolist.innertubex.extraction.InnerTubeExtractor
import com.metrolist.innertubex.extraction.YtConfigParserImpl
import com.metrolist.innertubex.extraction.generateClientPlaybackNonce
import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import okhttp3.OkHttpClient
import okhttp3.RequestBody.Companion.toRequestBody
import org.schabi.newpipe.extractor.MediaFormat
import org.schabi.newpipe.extractor.NewPipe
import org.schabi.newpipe.extractor.ServiceList
import org.schabi.newpipe.extractor.downloader.Downloader
import org.schabi.newpipe.extractor.downloader.Request
import org.schabi.newpipe.extractor.downloader.Response
import org.schabi.newpipe.extractor.exceptions.AgeRestrictedContentException
import org.schabi.newpipe.extractor.stream.DeliveryMethod
import java.util.concurrent.TimeUnit

private class Restricted : Exception()
private val network = OkHttpClient.Builder()
    .connectTimeout(10, TimeUnit.SECONDS).readTimeout(12, TimeUnit.SECONDS)
    .callTimeout(20, TimeUnit.SECONDS).build()

private class BackendDownloader : Downloader() {
    override fun execute(request: Request): Response {
        // BitChord's queue supplies recommendations; playback does not need this fetch.
        if (java.net.URI(request.url()).path == "/youtubei/v1/next") {
            return Response(200, "OK", emptyMap(),
                """{"responseContext":{},"contents":{},"currentVideoEndpoint":{},"trackingParams":""}""",
                request.url())
        }
        val builder = okhttp3.Request.Builder().url(request.url())
            .method(request.httpMethod(), request.dataToSend()?.toRequestBody())
        request.headers().forEach { (key, values) -> values.forEach { builder.addHeader(key, it) } }
        return network.newCall(builder.build()).execute().use { response ->
            Response(response.code, response.message, response.headers.toMultimap(),
                response.body?.string(), response.request.url.toString())
        }
    }
}

private data class Audio(val url: String, val mime: String, val kbps: Int,
    val headers: Map<String, String>, val engine: String)

private suspend fun resolve(videoId: String): Audio {
    NewPipe.init(BackendDownloader())
    val fallback = ServiceList.YouTube.getStreamExtractor("https://www.youtube.com/watch?v=$videoId")
    // Reuse this page for fallback; do not expose restricted or sign-in-only content.
    fallback.fetchPage()
    if (fallback.ageLimit > 0) throw Restricted()
    val http = HttpClient(OkHttp) {
        engine { preconfigured = network }
        install(ContentNegotiation) {
            json(Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = true })
        }
        install(HttpTimeout) {
            requestTimeoutMillis = 20_000; connectTimeoutMillis = 10_000; socketTimeoutMillis = 12_000
        }
    }
    try {
        val logger = InnerTubeLogger { /* Do not log signed media URLs. */ }
        val innerTube = InnerTube(http, logger = logger)
        val store = RemotePlayerConfigStore(http, PlayerConfigRepository.disabled(), logger)
        val cipher = YouTubeCipherService(http, store, logger)
        val extractor = InnerTubeExtractor(
            configParser = YtConfigParserImpl(http, innerTube, store, logger),
            cipherService = cipher, innerTube = innerTube, logger = logger)
        // No Android WebView, account cookies or token generation in this backend.
        val found = try {
            withTimeoutOrNull(30_000) {
                extractor.extract(videoId = videoId,
                    hints = ContentHints().withStreamCapabilities(
                        allowHls = false, allowSabr = false, allowBoundedRange = true),
                    audioQuality = AudioQuality.MP4,
                    clientPlaybackNonce = generateClientPlaybackNonce())
            }
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Exception) {
            null
        }
        if (found != null && found.sabrBootstrap == null) {
            return Audio(found.audioUrl, found.mimeType.orEmpty(), (found.bitrate ?: 0) / 1000,
                found.headers, "innertubex")
        }
        val audio = fallback.audioStreams
            .filter { !it.content.isNullOrBlank() && it.deliveryMethod == DeliveryMethod.PROGRESSIVE_HTTP }
            .sortedWith(compareByDescending<org.schabi.newpipe.extractor.stream.AudioStream> {
                it.format == MediaFormat.M4A
            }.thenByDescending { it.averageBitrate })
            .firstOrNull() ?: error("No progressive audio")
        return Audio(audio.content, audio.format?.mimeType.orEmpty(), audio.averageBitrate,
            PlayerClient.forStreamUrl(audio.content).mediaHeaders(), "newpipe")
    } finally {
        http.close()
    }
}

fun main(args: Array<String>) {
    if (args.singleOrNull() == "--version") {
        println("{\"engine\":\"BitChord playback adapter\",\"innertubex\":\"v0.7.0\",\"newpipe\":\"v0.26.3\"}")
        return
    }
    val id = args.singleOrNull()
    if (id == null || !Regex("[A-Za-z0-9_-]{11}").matches(id)) {
        println("{\"error\":\"invalid_video_id\"}")
        return
    }
    try {
        val audio = runBlocking { withTimeout(55_000) { resolve(id) } }
        // stdout is a private pipe to Python, never a public HTTP response.
        println(buildJsonObject {
            put("url", audio.url); put("mimeType", audio.mime)
            put("bitrateKbps", audio.kbps); put("engine", audio.engine)
            putJsonObject("headers") { audio.headers.forEach { (name, value) -> put(name, value) } }
        })
    } catch (e: Throwable) {
        if (System.getenv("SOUNDFEAN_RESOLVER_DIAGNOSTIC") == "1") {
            val message = e.message.orEmpty().replace(Regex("https?://\\S+"), "[url]")
            System.err.println("${e.javaClass.simpleName}: ${message.take(300)}")
        }
        val restricted = e is Restricted || e is AgeRestrictedContentException
        println(buildJsonObject {
            put("error", if (restricted) "restricted_content" else "stream_unavailable")
            put("reason", e.javaClass.simpleName)
        })
    } finally {
        network.connectionPool.evictAll()
        network.dispatcher.executorService.shutdown()
    }
}
