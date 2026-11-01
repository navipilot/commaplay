package com.playport.server

import org.junit.Assert.assertEquals
import org.junit.Test

class TouchStateTest {
    @Test
    fun releaseAndDisconnectRetainCoordinates() {
        val state = TouchState()
        val first = TouchContactMessage(0, .25, .75, true)
        val second = TouchContactMessage(1, .8, .2, true)
        state.update(listOf(first, second))
        assertEquals(listOf(first.copy(down = false), second), state.update(listOf(first.copy(x = 0.0, y = 0.0, down = false), second)))
        assertEquals(listOf(second.copy(down = false)), state.update(emptyList()))
        assertEquals(emptyList<TouchContactMessage>(), state.update(emptyList()))
    }

    @Test
    fun vanishedSlotIsReleasedWhileOtherFingerMoves() {
        val state = TouchState()
        val first = TouchContactMessage(0, .1, .2, true)
        val second = TouchContactMessage(1, .5, .6, true)
        state.update(listOf(first, second))
        val moved = second.copy(x = .7)
        assertEquals(listOf(moved, first.copy(down = false)), state.update(listOf(moved)))
        state.clear()
        assertEquals(emptyList<TouchContactMessage>(), state.update(emptyList()))
    }
}
