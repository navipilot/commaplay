package com.playport.server

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import com.shilapi.xcertplay.airplay.AirPlayInfoPlist

class BluetoothBridgeTest {
    @Test
    fun airPlayUsesControllerAddressInsteadOfSyntheticDeviceIdentity() {
        val directory = Files.createTempDirectory("commaplay-bt-config-")
        val helper = directory.resolve("helper")
        try {
            Files.writeString(helper, "#!/bin/sh\nprintf '02:00:00:00:00:12\\n'\n")
            helper.toFile().setExecutable(true)
            CarPlayServer(ServerConfig(
                identityDir = directory, stateDir = directory,
                bluetoothBridge = helper, bindAddress = "127.0.0.1",
            )).use { receiver ->
                assertEquals("02:00:00:00:00:12", receiver.airPlayConfig.btMac)
                assertEquals(receiver.deviceId, receiver.airPlayConfig.deviceId)
                val formats = AirPlayInfoPlist.build(receiver.airPlayConfig)["audioFormats"] as List<*>
                for (category in listOf("compatibility", "default", "telephony", "speechRecognition")) {
                    val entry = formats.filterIsInstance<Map<*, *>>()
                        .single { it["type"] == 100 && it["audioType"] == category }
                    assertTrue("Wireless bidirectional $category must retain the iPhone audio route",
                        (entry["audioInputFormats"] as? Number)?.toLong()?.let { it > 0 } == true)
                }
                assertTrue(formats.filterIsInstance<Map<*, *>>()
                    .any { it["type"] == 102 && it["audioType"] == "media" })
            }
        } finally {
            Files.deleteIfExists(directory.resolve("airplay-identity.properties"))
            Files.deleteIfExists(helper)
            Files.deleteIfExists(directory)
        }
    }

    @Test
    fun onlySuccessfulValidAddressIsAccepted() {
        val directory = Files.createTempDirectory("commaplay-bt-test-")
        val helper = directory.resolve("helper")
        try {
            for ((script, expected) in listOf(
                "printf '02:00:00:00:00:12\\n'" to "02:00:00:00:00:12",
                "printf 'invalid\\n'" to null,
                "printf '02:00:00:00:00:12\\n'; exit 1" to null,
            )) {
                Files.writeString(helper, "#!/bin/sh\n$script\n")
                helper.toFile().setExecutable(true)
                assertEquals(expected, BluetoothBridge.localAddress(helper))
            }
        } finally {
            Files.deleteIfExists(helper)
            Files.deleteIfExists(directory)
        }
    }

    @Test
    fun missingHelperDoesNotPreventReceiverFallback() {
        assertNull(BluetoothBridge.localAddress(java.nio.file.Path.of("/nonexistent/commaplay-helper")))
    }
}
