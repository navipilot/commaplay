package com.playport.server

import io.ktor.server.engine.applicationEnvironment
import io.ktor.server.engine.embeddedServer
import io.ktor.server.engine.sslConnector
import io.ktor.server.netty.Netty
import java.nio.file.Path
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermission
import kotlin.system.exitProcess
import org.slf4j.LoggerFactory

fun main(args: Array<String>) {
    val log = LoggerFactory.getLogger("playport")
    val identityDir = Path.of("identity").toAbsolutePath().normalize()
    val stateDir = Path.of(System.getProperty("user.home"), ".playport")

    // First pass: honour --state-dir/--identity-dir before looking for a saved config.
    val bootstrap = ServerConfig.fromArgs(args, ServerConfig(identityDir = identityDir, stateDir = stateDir))
    val store = ConfigStore(bootstrap.stateDir)
    val saved = store.load()
    // Second pass: saved settings are defaults; CLI flags still win.
    val config = saved?.let { persisted ->
        ServerConfig.fromArgs(args, persisted.toServerDefaults(bootstrap.identityDir, bootstrap.stateDir))
    } ?: bootstrap

    if (saved != null) {
        log.info("loaded settings from {}", bootstrap.stateDir.resolve("config.json"))
    }

    require(config.demoVideo == null || config.diagnostics) { "--demo-video requires --diagnostics" }
    require(config.accessToken.isNotBlank()) { "A nonempty browser token is required" }
    val server = CarPlayServer(config, store)
    if (!config.diagnostics) {
        try {
            server.mfi
        } catch (error: Exception) {
            System.err.println("MFi identity unavailable: ${error.message}")
            System.err.println(
                "Provide identity/offline-mfi/{identity.pk8,certificate.p7b}; use --diagnostics for browser tests.",
            )
            exitProcess(1)
        }
    }

    val webRoot = Path.of("web/dist").toAbsolutePath().normalize()
    val http = if (config.insecureHttp) {
        embeddedServer(Netty, port = config.httpPort, host = "0.0.0.0") {
            server.hub.install(this, webRoot)
        }
    } else {
        val tls = TlsCertificate.loadOrCreate(config.stateDir, listOf(server.bindAddress))
        embeddedServer(
            Netty,
            environment = applicationEnvironment { },
            configure = {
                sslConnector(tls.keyStore, tls.alias, { tls.password }, { tls.password }) {
                    host = "0.0.0.0"
                    port = config.httpPort
                }
            },
        ) {
            server.hub.install(this, webRoot)
        }
    }

    val demo = config.demoVideo?.let { DemoStream(it, server.hub, server.display) }
    try {
        if (!config.diagnostics) server.start()
        http.start(wait = false)
        demo?.start()
    } catch (error: Exception) {
        runCatching { demo?.close() }
        runCatching { server.close() }
        runCatching { http.stop(1_000, 3_000) }
        System.err.println("Could not start CommaPlay: ${error.message}")
        exitProcess(1)
    }
    if (config.diagnostics) server.hub.inputHandler = { server.hub.recordDiagnosticInput(it) }

    val scheme = if (config.insecureHttp) "http" else "https"
    val url = "$scheme://${server.bindAddress.hostAddress}:${config.httpPort}/" +
        if (config.browserAuth) "?token=${config.accessToken}" else ""
    val linkFile = config.stateDir.resolve("viewer-url.txt")
    Files.writeString(linkFile, "$url\n")
    Files.setPosixFilePermissions(linkFile, setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE))
    println()
    println("  CommaPlay ${projectVersion()} - 机械小鸽 (based on PlayPort)")
    println("  ------------------------------------------------------------------")
    println("  CarPlay device name : ${config.deviceName}")
    println("  Receiver mode       : ${if (config.diagnostics) "DIAGNOSTICS ONLY - NOT CARPLAY" else "CarPlay"}")
    if (!config.diagnostics) println("  AirPlay listener    : ${server.bindAddress.hostAddress}:${config.airPlayPort}")
    println("  Browser UI          : $scheme://${server.bindAddress.hostAddress}:${config.httpPort}/")
    println("  Private viewer link : $linkFile")
    if (!config.insecureHttp) {
        println("  (accept the self-signed certificate warning once; WebCodecs needs HTTPS)")
    }
    if (!config.diagnostics) {
        println("  Pairing PIN         : ${CarPlayServer.PAIRING_PIN}")
        println("  Wireless bootstrap  : ${if (config.wireless) "enabled" else "disabled (start with --wireless)"}")
    }
    println("  ------------------------------------------------------------------")
    if (!config.diagnostics) {
        println("  On the iPhone: Settings > General > CarPlay > available cars, then")
        println("  enter PIN ${CarPlayServer.PAIRING_PIN} when asked.")
    } else {
        println("  Synthetic video/input test only. Do not pair an iPhone in this mode.")
    }
    println()

    Runtime.getRuntime().addShutdownHook(
        Thread {
            log.info("shutting down")
            runCatching { demo?.close() }
            runCatching { server.close() }
            runCatching { http.stop(1_000, 3_000) }
        },
    )
    Thread.currentThread().join()
}

private fun projectVersion(): String =
    CarPlayServer::class.java.`package`?.implementationVersion ?: "0.1.0"
