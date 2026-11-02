package com.playport.server

import com.shilapi.xcertplay.airplay.AudioFormat
import com.shilapi.xcertplay.airplay.VideoCodec
import io.ktor.server.application.Application
import io.ktor.server.application.install
import io.ktor.server.request.receiveText
import io.ktor.server.request.uri
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.routing
import io.ktor.websocket.CloseReason
import io.ktor.websocket.Frame
import io.ktor.websocket.close
import io.ktor.websocket.readText
import io.ktor.websocket.send
import io.ktor.server.websocket.WebSockets
import io.ktor.server.websocket.webSocket
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.onFailure
import kotlinx.coroutines.launch
import kotlinx.coroutines.Job
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicBoolean
import java.net.URI
import java.util.concurrent.TimeUnit

@Serializable
data class TouchContactMessage(val id: Int, val x: Double, val y: Double, val down: Boolean)

@Serializable
data class KnobMessage(
    val select: Boolean = false,
    val home: Boolean = false,
    val back: Boolean = false,
    val x: Int = 0,
    val y: Int = 0,
    val wheel: Int = 0,
)

@Serializable
data class ClientMessage(
    val type: String,
    val contacts: List<TouchContactMessage> = emptyList(),
    val media: Int? = null,
    val knob: KnobMessage? = null,
    val night: Boolean? = null,
    val telephony: Int? = null,
)

@Serializable
data class DisplayRequest(
    val width: Int,
    val height: Int,
    val fps: Int = 60,
    val uiScale: Int = 100,
    val hevc: Boolean = false,
)

@Serializable
data class ServerMessage(
    val type: String,
    val deviceName: String? = null,
    val sessionActive: Boolean = false,
    val width: Int? = null,
    val height: Int? = null,
    val viewers: Int = 0,
    val message: String? = null,
    val micActive: Boolean? = null,
    val micRate: Int? = null,
    val micChannels: Int? = null,
    val micCodec: String? = null,
    val micSamplesPerPacket: Int? = null,
    val micBitrate: Int? = null,
    val diagnostics: Boolean = false,
)

private class WsClient(
    val channel: Channel<Frame>,
) {
    val imageReady = java.util.concurrent.atomic.AtomicBoolean(false)
    val keyframeRequested = AtomicLong(0)
    val touches = TouchState()
    var writer: Job? = null

    fun stop() {
        channel.cancel()
        writer?.cancel()
    }
}

/** Fan-out hub: browsers connect here and the media bridge pushes CarPlay frames to all of them. */
class WebHub(
    private val config: ServerConfig,
    private val display: DisplayState,
    private val scope: CoroutineScope = CoroutineScope(Dispatchers.Default),
) {
    private val json = Json { ignoreUnknownKeys = true }
    private val clients = ConcurrentHashMap.newKeySet<WsClient>()
    private val controllerOccupied = AtomicBoolean(false)
    private val codecsByStream = ConcurrentHashMap<Int, VideoCodec>()
    private val configByStream = ConcurrentHashMap<Int, Pair<VideoCodec, ByteArray>>()
    private val audioFormatByStream = ConcurrentHashMap<Int, AudioFormat>()

    @Volatile var inputHandler: ((ClientMessage) -> Unit)? = null

    /** Invoked (once per client) when a browser is ready to receive; used to request a keyframe. */
    @Volatile var onViewerJoined: ((Int) -> Unit)? = null

    /** Applies a display change; returns null on success or an error message. */
    @Volatile var onApplyDisplay: ((Int, Int, Int, Int, Boolean) -> String?)? = null

    /** Browser microphone payloads: (isOpus, payload). */
    @Volatile var onMicrophoneData: ((Boolean, ByteArray) -> Unit)? = null

    fun microphoneRequested(uplink: MicUplink) {
        broadcastJson(
            ServerMessage(
                type = "mic",
                deviceName = config.deviceName,
                micActive = true,
                micRate = uplink.sampleRate,
                micChannels = uplink.channels,
                micCodec = uplink.codec,
                micSamplesPerPacket = uplink.samplesPerPacket,
                micBitrate = uplink.bitrate,
            ),
        )
    }

    fun microphoneStopped() {
        broadcastJson(ServerMessage(type = "mic", deviceName = config.deviceName, micActive = false))
    }

    @Volatile private var sessionActive = false
    @Volatile var receiverReady = false
    @Volatile private var phoneName: String? = null
    @Volatile private var lastInput: ClientMessage? = null
    private val inputCount = AtomicLong(0)
    private val audioPacketCount = AtomicLong(0)
    @Volatile private var lastAudioAtMs = 0L
    private val videoPacketCount = AtomicLong(0)
    private val videoWindowCount = AtomicLong(0)
    @Volatile private var videoWindowStartMs = System.currentTimeMillis()
    @Volatile private var lastVideoAtMs = 0L
    @Volatile var mainAudioOwner: String? = null

    fun recordDiagnosticInput(message: ClientMessage) {
        lastInput = message
        inputCount.incrementAndGet()
    }

    fun setVideoCodec(type: Int, codec: VideoCodec) {
        codecsByStream[type] = codec
    }

    fun videoCodec(type: Int): VideoCodec? = codecsByStream[type]

    fun setSessionState(active: Boolean, name: String?) {
        if (!active) {
            audioFormatByStream.clear()
            audioPacketCount.set(0)
            lastAudioAtMs = 0L
            mainAudioOwner = null
        }
        if (sessionActive != active) clients.forEach { it.touches.clear() }
        sessionActive = active
        phoneName = name
        broadcastJson(
            ServerMessage(
                type = "session",
                deviceName = config.deviceName,
                sessionActive = active,
                viewers = clients.size,
                message = name,
            ),
        )
    }

    fun broadcastVideoConfig(type: Int, codecData: ByteArray) {
        val codec = codecsByStream[type] ?: VideoCodec.H264
        configByStream[type] = codec to codecData
        val frame = Wire.videoConfig(type, codec, display.width, display.height, codecData)
        broadcastBinary(frame)
    }

    fun broadcastVideoFrame(type: Int, keyframe: Boolean, naluBytes: ByteArray) {
        val now = System.currentTimeMillis()
        if (now - videoWindowStartMs >= 5_000) {
            videoWindowStartMs = now
            videoWindowCount.set(0)
        }
        videoPacketCount.incrementAndGet()
        videoWindowCount.incrementAndGet()
        lastVideoAtMs = now
        val frame = Wire.videoFrame(type, keyframe, naluBytes)
        for (client in clients) {
            if (keyframe) {
                client.imageReady.set(true)
            } else if (!client.imageReady.get()) {
                // Every viewer starts decoding at a keyframe; drop deltas until one arrives.
                maybeRequestKeyframe(client, type)
                continue
            }
            client.channel.trySend(Frame.Binary(true, frame))
                .onFailure { client.stop() }
        }
    }

    fun broadcastScreenActive(type: Int, active: Boolean) {
        broadcastBinary(Wire.screenActive(type, active))
    }

    fun broadcastAudioConfig(type: Int, format: AudioFormat) {
        audioFormatByStream[type] = format
        broadcastBinary(Wire.audioConfig(type, format))
    }

    fun broadcastAudioPacket(type: Int, timestampUs: Long, payload: ByteArray) {
        audioPacketCount.incrementAndGet()
        lastAudioAtMs = System.currentTimeMillis()
        broadcastBinary(Wire.audioPacket(type, timestampUs, payload))
    }

    fun broadcastAudioStopped(type: Int) {
        audioFormatByStream.remove(type)
        broadcastBinary(Wire.audioStopped(type))
    }

    private fun broadcastBinary(bytes: ByteArray) {
        for (client in clients) {
            client.channel.trySend(Frame.Binary(true, bytes)).onFailure { client.stop() }
        }
    }

    private fun broadcastJson(message: ServerMessage) {
        val text = json.encodeToString(ServerMessage.serializer(), message)
        for (client in clients) {
            client.channel.trySend(Frame.Text(text)).onFailure { client.stop() }
        }
    }

    private fun maybeRequestKeyframe(client: WsClient, type: Int) {
        val now = System.nanoTime()
        val last = client.keyframeRequested.get()
        if (now - last > KEYFRAME_REQUEST_INTERVAL_NS && client.keyframeRequested.compareAndSet(last, now)) {
            onViewerJoined?.invoke(type)
        }
    }

    /** Ktor module: WebSocket endpoint with token auth plus status API. */
    fun install(application: Application, webRoot: Path) {
        application.install(WebSockets)
        BluetoothApi(config).install(application)
        application.routing {
            get("/api/status") {
                call.respondText(statusJson(), io.ktor.http.ContentType.Application.Json)
            }
            get("/api/hotspot") {
                val report = withContext(Dispatchers.IO) {
                    runCatching {
                        val file = Path.of("/run/commaplay-hotspot/status.json")
                        check(System.currentTimeMillis() - java.nio.file.Files.getLastModifiedTime(file).toMillis() < 15_000)
                        json.parseToJsonElement(java.nio.file.Files.readString(file)).toString()
                    }.getOrDefault("""{"enabled":false,"error":"monitor_unavailable"}""")
                }
                call.response.headers.append("Cache-Control", "no-store")
                call.respondText(report, io.ktor.http.ContentType.Application.Json)
            }
            get("/api/display") {
                call.respondText(displayJson(), io.ktor.http.ContentType.Application.Json)
            }
            get("/api/readiness") {
                val bearer = call.request.headers["Authorization"]?.takeIf { it.startsWith("Bearer ") }?.removePrefix("Bearer ")
                if (config.browserAuth && (bearer ?: call.request.queryParameters["token"]) != config.accessToken) {
                    call.respondText(
                        """{"error":"invalid token"}""",
                        io.ktor.http.ContentType.Application.Json,
                        io.ktor.http.HttpStatusCode.Forbidden,
                    )
                    return@get
                }
                val report = withContext(Dispatchers.IO) {
                    runCatching {
                        val root = webRoot.parent.parent
                        val process = ProcessBuilder("python3", root.resolve("deploy/check-iphone.py").toString(), "--root", root.toString())
                            .redirectError(ProcessBuilder.Redirect.DISCARD).start()
                        try {
                            check(process.waitFor(15, TimeUnit.SECONDS)) { "preflight timed out" }
                            check(process.exitValue() == 0) { "preflight unavailable" }
                            val output = process.inputStream.bufferedReader().readText()
                            json.parseToJsonElement(output).toString()
                        } finally {
                            if (process.isAlive) process.destroyForcibly()
                        }
                    }.getOrNull()
                }
                call.respondText(
                    report ?: """{"error":"preflight unavailable"}""",
                    io.ktor.http.ContentType.Application.Json,
                    if (report != null) io.ktor.http.HttpStatusCode.OK else io.ktor.http.HttpStatusCode.ServiceUnavailable,
                )
            }
            post("/api/display") {
                val origin = call.request.headers["Origin"]
                if (call.request.headers["Sec-Fetch-Site"] == "cross-site" ||
                    (origin != null && runCatching { URI(origin).rawAuthority != call.request.headers["Host"] }.getOrDefault(true))) {
                    call.respondText("""{"error":"same-origin requests only"}""",
                        io.ktor.http.ContentType.Application.Json, io.ktor.http.HttpStatusCode.Forbidden)
                    return@post
                }
                if (config.browserAuth && call.request.queryParameters["token"] != config.accessToken) {
                    call.respondText(
                        """{"error":"invalid token"}""",
                        io.ktor.http.ContentType.Application.Json,
                        io.ktor.http.HttpStatusCode.Forbidden,
                    )
                    return@post
                }
                val request = try {
                    json.decodeFromString(DisplayRequest.serializer(), call.receiveText())
                } catch (_: Exception) {
                    call.respondText(
                        """{"error":"malformed request"}""",
                        io.ktor.http.ContentType.Application.Json,
                        io.ktor.http.HttpStatusCode.BadRequest,
                    )
                    return@post
                }
                val applier = onApplyDisplay
                if (applier == null) {
                    call.respondText(
                        """{"error":"display control unavailable"}""",
                        io.ktor.http.ContentType.Application.Json,
                        io.ktor.http.HttpStatusCode.ServiceUnavailable,
                    )
                    return@post
                }
                val error = applier(request.width, request.height, request.fps, request.uiScale, request.hevc)
                if (error != null) {
                    call.respondText(
                        "{\"error\":\"$error\"}",
                        io.ktor.http.ContentType.Application.Json,
                        io.ktor.http.HttpStatusCode.BadRequest,
                    )
                    return@post
                }
                call.respondText("""{"ok":true}""", io.ktor.http.ContentType.Application.Json)
            }
            webSocket("/ws") {
                val token = call.request.queryParameters["token"]
                if (config.browserAuth && token != config.accessToken) {
                    close(CloseReason(CloseReason.Codes.VIOLATED_POLICY, "invalid token"))
                    return@webSocket
                }
                val origin = call.request.headers["Origin"]
                val host = call.request.headers["Host"]
                if (origin != null && runCatching { URI(origin).rawAuthority != host }.getOrDefault(true)) {
                    close(CloseReason(CloseReason.Codes.VIOLATED_POLICY, "invalid origin"))
                    return@webSocket
                }
                if (!controllerOccupied.compareAndSet(false, true)) {
                    close(CloseReason(CloseReason.Codes.VIOLATED_POLICY, "one controller allowed"))
                    return@webSocket
                }
                val client = WsClient(Channel(capacity = SEND_QUEUE_CAPACITY))
                val wsSession = this
                val writer = launch(start = CoroutineStart.LAZY) {
                    try {
                        for (frame in client.channel) {
                            wsSession.send(frame)
                        }
                    } catch (_: Exception) {
                        // Cancellation also interrupts blocked sends to a slow browser.
                    } finally {
                        withContext(NonCancellable) {
                            withTimeoutOrNull(1_000) {
                                wsSession.close(CloseReason(1013.toShort(), "viewer output closed"))
                            }
                        }
                    }
                }
                client.writer = writer
                try {
                    wsSession.send(
                        Frame.Text(
                            json.encodeToString(
                                ServerMessage.serializer(),
                                ServerMessage(
                                    type = "hello",
                                    deviceName = config.deviceName,
                                    sessionActive = sessionActive,
                                    width = display.width,
                                    height = display.height,
                                    viewers = 1,
                                    message = phoneName,
                                    diagnostics = config.diagnostics,
                                ),
                            ),
                        ),
                    )
                    // Replay codec/audio setup so a viewer that joins late can decode.
                    configByStream.forEach { (type, value) ->
                        client.channel.trySend(
                            Frame.Binary(true, Wire.videoConfig(type, value.first, display.width, display.height, value.second)),
                        )
                    }
                    audioFormatByStream.forEach { (type, format) ->
                        client.channel.trySend(Frame.Binary(true, Wire.audioConfig(type, format)))
                    }
                    clients.add(client)
                    writer.start()
                    configByStream.keys.forEach { streamType -> onViewerJoined?.invoke(streamType) }
                    for (frame in incoming) {
                        if (frame is Frame.Binary) {
                            val data = frame.data
                            if (data.size >= 2) {
                                val kind = data[0].toInt() and 0xff
                                val payload = data.copyOfRange(1, data.size)
                                when (kind) {
                                    MIC_FRAME_LPCM -> onMicrophoneData?.invoke(false, payload)
                                    MIC_FRAME_OPUS -> onMicrophoneData?.invoke(true, payload)
                                }
                            }
                            continue
                        }
                        val text = (frame as? Frame.Text)?.readText() ?: continue
                        val message = try {
                            json.decodeFromString(ClientMessage.serializer(), text)
                        } catch (_: Exception) {
                            continue
                        }
                        if (message.contacts.size > 2 || message.contacts.map { it.id }.distinct().size != message.contacts.size || message.contacts.any {
                            it.id !in 0..1 || !it.x.isFinite() || !it.y.isFinite() ||
                                it.x !in 0.0..1.0 || it.y !in 0.0..1.0
                        }) {
                            close(CloseReason(CloseReason.Codes.VIOLATED_POLICY, "invalid contacts"))
                            break
                        }
                        if (message.type == "keyframe") {
                            configByStream.keys.forEach { streamType -> maybeRequestKeyframe(client, streamType) }
                        } else if (message.type == "ping") {
                            client.channel.trySend(Frame.Text("""{"type":"pong"}"""))
                        } else {
                            inputHandler?.invoke(
                                if (message.type == "touch") message.copy(contacts = client.touches.update(message.contacts)) else message,
                            )
                        }
                    }
                } finally {
                    runCatching {
                        inputHandler?.invoke(ClientMessage(type = "touch", contacts = client.touches.update(emptyList())))
                        inputHandler?.invoke(ClientMessage(type = "knob", knob = KnobMessage()))
                    }
                    clients.remove(client)
                    client.stop()
                    controllerOccupied.set(false)
                }
            }
            get("/{path...}") {
                val relative = call.request.uri.substringBefore('?').trimStart('/').ifEmpty { "index.html" }
                val resolved = webRoot.resolve(relative).normalize()
                val file = if (resolved.startsWith(webRoot) && Files.isRegularFile(resolved)) resolved else webRoot.resolve("index.html")
                if (!Files.isRegularFile(file)) {
                    call.respondText(
                        "playport: the browser client is not built yet. Run `cd web && npm install && npm run build`, then reload.",
                    )
                    return@get
                }
                call.respondText(Files.readString(file), contentTypeFor(file.fileName.toString()))
            }
        }
    }

    private fun contentTypeFor(name: String): io.ktor.http.ContentType = when {
        name.endsWith(".html") -> io.ktor.http.ContentType.Text.Html
        name.endsWith(".js") -> io.ktor.http.ContentType.Text.JavaScript
        name.endsWith(".css") -> io.ktor.http.ContentType.Text.CSS
        name.endsWith(".svg") -> io.ktor.http.ContentType.Image.SVG
        name.endsWith(".png") -> io.ktor.http.ContentType.Image.PNG
        name.endsWith(".json") -> io.ktor.http.ContentType.Application.Json
        name.endsWith(".wasm") -> io.ktor.http.ContentType.Application.OctetStream
        else -> io.ktor.http.ContentType.Application.OctetStream
    }

    private fun displayJson(): String = kotlinx.serialization.json.buildJsonObject {
        put("width", kotlinx.serialization.json.JsonPrimitive(display.width))
        put("height", kotlinx.serialization.json.JsonPrimitive(display.height))
        put("fps", kotlinx.serialization.json.JsonPrimitive(display.fps))
        put("uiScale", kotlinx.serialization.json.JsonPrimitive(display.uiScale))
        put("hevc", kotlinx.serialization.json.JsonPrimitive(display.hevc))
        put("orientation", kotlinx.serialization.json.JsonPrimitive(display.orientation))
        put(
            "presets",
            kotlinx.serialization.json.buildJsonArray {
                DisplayState.PRESETS.forEach { preset ->
                    add(
                        kotlinx.serialization.json.buildJsonObject {
                            put("label", kotlinx.serialization.json.JsonPrimitive(preset.label))
                            put("width", kotlinx.serialization.json.JsonPrimitive(preset.width))
                            put("height", kotlinx.serialization.json.JsonPrimitive(preset.height))
                            put("orientation", kotlinx.serialization.json.JsonPrimitive(preset.orientation))
                        },
                    )
                }
            },
        )
    }.toString()

    private fun statusJson(): String = kotlinx.serialization.json.buildJsonObject {
        put("deviceName", kotlinx.serialization.json.JsonPrimitive(config.deviceName))
        put("sessionActive", kotlinx.serialization.json.JsonPrimitive(sessionActive))
        put("phone", phoneName?.let { kotlinx.serialization.json.JsonPrimitive(it) } ?: kotlinx.serialization.json.JsonNull)
        put("viewers", kotlinx.serialization.json.JsonPrimitive(clients.size))
        put("diagnostics", kotlinx.serialization.json.JsonPrimitive(config.diagnostics))
        put("receiverReady", kotlinx.serialization.json.JsonPrimitive(receiverReady))
        put("browserAuth", kotlinx.serialization.json.JsonPrimitive(config.browserAuth))
        put("video", kotlinx.serialization.json.buildJsonObject {
            put("packetsReceived", kotlinx.serialization.json.JsonPrimitive(videoPacketCount.get()))
            put("inputFps5s", kotlinx.serialization.json.JsonPrimitive(
                videoWindowCount.get() * 1_000.0 / (System.currentTimeMillis() - videoWindowStartMs).coerceAtLeast(1),
            ))
            put("lastPacketAgeMs", if (lastVideoAtMs == 0L) kotlinx.serialization.json.JsonNull
                else kotlinx.serialization.json.JsonPrimitive((System.currentTimeMillis() - lastVideoAtMs).coerceAtLeast(0)))
            put("recommendation", kotlinx.serialization.json.JsonPrimitive(
                if (display.hevc) "Switch to H.264 before testing HTTP/Tesla playback"
                else if (display.fps > 20) "Start with 15 fps; use 10/20 fps only for comparison"
                else "H.264 1280x720 at ${display.fps} fps is the current compatibility profile",
            ))
        })
        put("audio", kotlinx.serialization.json.buildJsonObject {
            put("resourceOwner", mainAudioOwner?.let { kotlinx.serialization.json.JsonPrimitive(it) }
                ?: kotlinx.serialization.json.JsonNull)
            put("packetsReceived", kotlinx.serialization.json.JsonPrimitive(audioPacketCount.get()))
            put("lastPacketAgeMs", if (lastAudioAtMs == 0L) kotlinx.serialization.json.JsonNull
                else kotlinx.serialization.json.JsonPrimitive((System.currentTimeMillis() - lastAudioAtMs).coerceAtLeast(0)))
            put("streams", kotlinx.serialization.json.buildJsonArray {
                audioFormatByStream.entries.sortedBy { it.key }.forEach { (type, format) ->
                    add(kotlinx.serialization.json.buildJsonObject {
                        put("type", kotlinx.serialization.json.JsonPrimitive(type))
                        put("codec", kotlinx.serialization.json.JsonPrimitive(format.codec.name))
                        put("sampleRate", kotlinx.serialization.json.JsonPrimitive(format.sampleRate))
                        put("channels", kotlinx.serialization.json.JsonPrimitive(format.channels))
                    })
                }
            })
        })
        if (config.diagnostics) {
            put("inputCount", kotlinx.serialization.json.JsonPrimitive(inputCount.get()))
            lastInput?.let { put("lastInput", json.encodeToJsonElement(ClientMessage.serializer(), it)) }
        }
        put(
            "display",
            kotlinx.serialization.json.buildJsonObject {
                put("width", kotlinx.serialization.json.JsonPrimitive(display.width))
                put("height", kotlinx.serialization.json.JsonPrimitive(display.height))
                put("fps", kotlinx.serialization.json.JsonPrimitive(display.fps))
                put("uiScale", kotlinx.serialization.json.JsonPrimitive(display.uiScale))
                put("hevc", kotlinx.serialization.json.JsonPrimitive(display.hevc))
                put("orientation", kotlinx.serialization.json.JsonPrimitive(display.orientation))
            },
        )
    }.toString()

    companion object {
        const val MIC_FRAME_LPCM = 0x10
        const val MIC_FRAME_OPUS = 0x11
        private const val SEND_QUEUE_CAPACITY = 32
        private const val KEYFRAME_REQUEST_INTERVAL_NS = 1_000_000_000L
    }
}
