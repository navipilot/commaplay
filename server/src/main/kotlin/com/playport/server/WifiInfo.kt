package com.playport.server

import org.slf4j.LoggerFactory

data class WifiNetwork(val ssid: String, val channel: Int)

/** Reads current Wi-Fi metadata without changing the network or retrieving its password. */
object WifiInfo {
    private val log = LoggerFactory.getLogger("wifi")

    fun detect(config: ServerConfig): WifiNetwork? {
        val linux = System.getProperty("os.name").startsWith("Linux", ignoreCase = true)
        val current = if (linux) runCatching {
            parseLinuxNetwork(run("nmcli", "--terse", "--escape", "no", "--fields", "ACTIVE,SSID,CHAN", "device", "wifi", "list", "--rescan", "no"))
        }.getOrNull() else null
        val ssid = config.wifiSsid?.takeIf { it.isNotBlank() } ?: if (linux) current?.ssid else currentSsid()
        if (ssid.isNullOrBlank()) return null
        val channel = if (config.wifiChannel > 0) config.wifiChannel else if (linux) current?.channel ?: 0 else currentChannel() ?: 0
        return WifiNetwork(ssid, channel)
    }

    internal fun parseLinuxNetwork(output: String): WifiNetwork? {
        val line = output.lineSequence().firstOrNull { it.startsWith("yes:") }?.removePrefix("yes:") ?: return null
        val ssid = line.substringBeforeLast(':', "")
        val channel = line.substringAfterLast(':').trim().toIntOrNull() ?: return null
        return if (ssid.isNotBlank() && channel > 0) WifiNetwork(ssid, channel) else null
    }

    private fun currentSsid(): String? {
        // networksetup on the Wi-Fi hardware port (usually en0).
        wifiHardwarePort()?.let { device ->
            val output = runCatching { run("networksetup", "-getairportnetwork", device) }.getOrNull()
            output?.lineSequence()
                ?.firstOrNull { it.startsWith("Current Wi-Fi Network:") }
                ?.substringAfter(':')
                ?.trim()
                ?.takeIf { it.isNotEmpty() }
                ?.let { return it }
        }
        // Fallback: ipconfig summaries. macOS redacts SSID unless the calling app has Location
        // Services permission, which surfaces here as "<redacted>".
        for (iface in interfaceNames()) {
            val summary = runCatching { run("ipconfig", "getsummary", iface) }.getOrNull() ?: continue
            val ssid = summary.lineSequence()
                .firstOrNull { it.trim().startsWith("SSID :") }
                ?.substringAfter(':')
                ?.trim()
                ?: continue
            when {
                ssid.isEmpty() -> continue
                ssid == "<redacted>" -> {
                    log.warn(
                        "macOS hides the Wi-Fi name from this process (Location Services). " +
                            "Grant Location Services to your terminal, or pass --wifi-ssid and --wifi-passphrase.",
                    )
                    return null
                }
                else -> return ssid
            }
        }
        return null
    }

    private fun wifiHardwarePort(): String? = runCatching {
        val lines = run("networksetup", "-listallhardwareports").lines()
        val index = lines.indexOfFirst { it.trim().equals("Hardware Port: Wi-Fi", ignoreCase = true) }
        if (index >= 0 && index + 1 < lines.size) lines[index + 1].substringAfter(':').trim() else null
    }.getOrNull()

    private fun interfaceNames(): List<String> = runCatching {
        java.net.NetworkInterface.getNetworkInterfaces().toList().map { it.name }
    }.getOrDefault(emptyList())

    private fun currentChannel(): Int? = runCatching {
        val output = run("system_profiler", "SPAirPortDataType")
        Regex("Channel:\\s*(\\d+)").find(output)?.groupValues?.get(1)?.toIntOrNull()
    }.getOrNull()

    private fun run(vararg command: String): String {
        val process = ProcessBuilder(*command).redirectErrorStream(true).start()
        val output = process.inputStream.bufferedReader().readText()
        process.waitFor()
        return output
    }
}
