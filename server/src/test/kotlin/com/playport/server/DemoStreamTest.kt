package com.playport.server

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class DemoStreamTest {
    @Test
    fun splitsMixedStartCodesWithoutIncludingEmptyUnits() {
        val data = byteArrayOf(0, 0, 0, 1, 7, 11, 0, 0, 1, 8, 12, 0, 0, 0, 1)
        val units = DemoStream.splitAnnexB(data)
        assertEquals(2, units.size)
        assertArrayEquals(byteArrayOf(7, 11), units[0])
        assertArrayEquals(byteArrayOf(8, 12), units[1])
        assertEquals(emptyList<ByteArray>(), DemoStream.splitAnnexB(byteArrayOf(1, 2, 3)))
    }
}
