package com.playport.server

import org.junit.Assert.assertEquals
import org.junit.Test

class WirelessHandoffTest {
    @Test
    fun phoneRequestCannotCloseBluetoothBeforeTunnelAuthentication() {
        var closed = 0
        val handoff = WirelessHandoff { closed++ }
        handoff.request()
        handoff.request()
        assertEquals(0, closed)
        handoff.tunnelReady()
        handoff.tunnelReady()
        handoff.request()
        assertEquals(1, closed)
    }

    @Test
    fun authenticatedTunnelWaitsForPhoneHandoffRequest() {
        var closed = 0
        val handoff = WirelessHandoff { closed++ }
        handoff.tunnelReady()
        assertEquals(0, closed)
        handoff.request()
        assertEquals(1, closed)
    }
}
