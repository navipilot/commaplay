// Copyright (c) 2026 机械小鸽
// SPDX-License-Identifier: GPL-3.0-only
package com.playport.server

import com.shilapi.xcertplay.airplay.VideoCodec
import java.io.Closeable
import java.nio.file.Files
import java.nio.file.Path
import java.io.ByteArrayOutputStream
import java.util.concurrent.atomic.AtomicBoolean

/** Explicit synthetic media fixture; never opens a CarPlay listener or uses an MFi identity. */
class DemoStream(path: Path, private val hub: WebHub, private val display: DisplayState) : Closeable {
    private val stopped = AtomicBoolean(false)
    private val units = splitAnnexB(Files.readAllBytes(path))
    private val frames = mutableListOf<ByteArray>()
    private val config: ByteArray
    private var worker: Thread? = null

    init {
        val sps = units.first { it[0].toInt() and 31 == 7 }
        val pps = units.first { it[0].toInt() and 31 == 8 }
        config = ByteArrayOutputStream().apply {
            write(byteArrayOf(1, sps[1], sps[2], sps[3], 0xff.toByte(), 0xe1.toByte()))
            write(sps.size shr 8); write(sps.size and 255); write(sps)
            write(1); write(pps.size shr 8); write(pps.size and 255); write(pps)
        }.toByteArray()
        var current = ByteArrayOutputStream()
        var hasPicture = false
        for (unit in units) {
            val kind = unit[0].toInt() and 31
            if (kind == 9 && hasPicture) {
                frames += current.toByteArray()
                current = ByteArrayOutputStream()
                hasPicture = false
            }
            if (kind != 7 && kind != 8) {
                current.write(byteArrayOf(0, 0, 0, 1))
                current.write(unit)
                if (kind == 1 || kind == 5) hasPicture = true
            }
        }
        if (hasPicture) frames += current.toByteArray()
        require(frames.isNotEmpty()) { "Demo fixture contains no pictures" }
    }

    fun start() {
        hub.setVideoCodec(110, VideoCodec.H264)
        hub.broadcastVideoConfig(110, config)
        hub.setSessionState(true, "TEST STREAM - NOT CARPLAY")
        worker = Thread({
            try {
                while (!stopped.get()) {
                    for (frame in frames) {
                        if (stopped.get()) break
                        hub.broadcastVideoFrame(110, Wire.isKeyFrame(frame, VideoCodec.H264), frame)
                        Thread.sleep(1_000L / display.fps)
                    }
                }
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
            }
        }, "diagnostic-video").apply { isDaemon = true; start() }
    }

    override fun close() {
        stopped.set(true)
        worker?.interrupt()
    }

    companion object {
        fun splitAnnexB(bytes: ByteArray): List<ByteArray> {
            val starts = mutableListOf<Pair<Int, Int>>()
            var i = 0
            while (i + 3 <= bytes.size) {
                val length = when {
                    i + 4 <= bytes.size && bytes[i] == 0.toByte() && bytes[i + 1] == 0.toByte() &&
                        bytes[i + 2] == 0.toByte() && bytes[i + 3] == 1.toByte() -> 4
                    bytes[i] == 0.toByte() && bytes[i + 1] == 0.toByte() && bytes[i + 2] == 1.toByte() -> 3
                    else -> 0
                }
                if (length > 0) { starts += i to length; i += length } else i++
            }
            return starts.mapIndexedNotNull { index, (offset, length) ->
                val end = starts.getOrNull(index + 1)?.first ?: bytes.size
                if (end > offset + length) bytes.copyOfRange(offset + length, end) else null
            }
        }
    }
}
