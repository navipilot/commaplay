package com.playport.server

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WifiInfoTest {
    @Test
    fun linuxMetadataPreservesColonsInNetworkNames() {
        assertEquals(WifiNetwork("Test:network", 36), WifiInfo.parseLinuxNetwork("no:Other:6\nyes:Test:network:36\n"))
    }

    @Test
    fun absentOrMalformedActiveNetworkIsNotAdvertised() {
        for (output in listOf("no:Other:6", "yes::6", "yes:Test:?", "")) assertNull(WifiInfo.parseLinuxNetwork(output))
    }
}
