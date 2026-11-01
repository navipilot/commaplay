// Copyright (c) 2026 机械小鸽
// SPDX-License-Identifier: GPL-3.0-only
package com.playport.server

import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.Application
import io.ktor.server.application.ApplicationCall
import io.ktor.server.request.receiveText
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.routing
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import java.io.ByteArrayOutputStream
import java.net.StandardProtocolFamily
import java.net.UnixDomainSocketAddress
import java.net.URI
import java.nio.ByteBuffer
import java.nio.channels.SocketChannel

class BluetoothApi(private val config: ServerConfig) {
    private val json = Json

    private fun authorized(call: ApplicationCall): Boolean {
        if (!config.browserAuth) return true
        val bearer = call.request.headers["Authorization"]?.takeIf { it.startsWith("Bearer ") }?.removePrefix("Bearer ")
        return (bearer ?: call.request.queryParameters["token"]) == config.accessToken
    }

    private suspend fun proxy(call: ApplicationCall, command: JsonObject) {
        val reply = runCatching {
            withTimeout(6_000) {
                runInterruptible(Dispatchers.IO) {
                    SocketChannel.open(StandardProtocolFamily.UNIX).use { channel ->
                        channel.connect(UnixDomainSocketAddress.of(config.bluetoothSocket))
                        val input = ByteBuffer.wrap((command.toString() + "\n").toByteArray(Charsets.UTF_8))
                        while (input.hasRemaining()) channel.write(input)
                        val output = ByteArrayOutputStream()
                        val buffer = ByteBuffer.allocate(4096)
                        var complete = false
                        while (!complete) {
                            buffer.clear()
                            check(channel.read(buffer) > 0) { "Bluetooth broker disconnected" }
                            buffer.flip()
                            while (buffer.hasRemaining()) {
                                val byte = buffer.get()
                                if (byte == 10.toByte()) { complete = true; break }
                                output.write(byte.toInt())
                                check(output.size() <= 65_536) { "Bluetooth response too large" }
                            }
                        }
                        json.parseToJsonElement(output.toString(Charsets.UTF_8)) as JsonObject
                    }
                }
            }
        }.getOrNull()
        val status = reply?.get("status")?.jsonPrimitive?.intOrNull ?: if (reply == null) 503 else 200
        call.respondText(reply?.toString() ?: """{"ok":false,"error":"Bluetooth web service unavailable"}""",
            ContentType.Application.Json, HttpStatusCode.fromValue(status))
    }

    fun install(application: Application) {
        application.routing {
            get("/api/bluetooth") {
                if (!authorized(call)) {
                    call.respondText("""{"error":"invalid token"}""", ContentType.Application.Json, HttpStatusCode.Forbidden)
                    return@get
                }
                proxy(call, JsonObject(mapOf("operation" to JsonPrimitive("status"), "client" to JsonPrimitive(call.request.queryParameters["client"] ?: ""))))
            }
            post("/api/bluetooth/{operation}") {
                if (!authorized(call)) {
                    call.respondText("""{"error":"invalid token"}""", ContentType.Application.Json, HttpStatusCode.Forbidden)
                    return@post
                }
                val origin = call.request.headers["Origin"]
                if (call.request.headers["Sec-Fetch-Site"] == "cross-site" ||
                    (origin != null && runCatching { URI(origin).rawAuthority != call.request.headers["Host"] }.getOrDefault(true))) {
                    call.respondText("""{"error":"same-origin requests only"}""", ContentType.Application.Json, HttpStatusCode.Forbidden)
                    return@post
                }
                if (call.request.headers["Content-Type"]?.substringBefore(';') != "application/json") {
                    call.respondText("""{"error":"application/json required"}""", ContentType.Application.Json, HttpStatusCode.UnsupportedMediaType)
                    return@post
                }
                val length = call.request.headers["Content-Length"]?.toLongOrNull()
                if (length == null || length !in 1..4096) {
                    call.respondText("""{"error":"JSON body must be 1..4096 bytes with Content-Length"}""", ContentType.Application.Json, HttpStatusCode.PayloadTooLarge)
                    return@post
                }
                val body = runCatching { json.parseToJsonElement(call.receiveText()) as JsonObject }.getOrNull()
                if (body == null) {
                    call.respondText("""{"error":"invalid JSON object"}""", ContentType.Application.Json, HttpStatusCode.BadRequest)
                    return@post
                }
                proxy(call, JsonObject(body + ("operation" to JsonPrimitive(call.parameters["operation"] ?: ""))))
            }
        }
    }
}
