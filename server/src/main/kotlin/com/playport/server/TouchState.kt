// Copyright (c) 2026 机械小鸽
// SPDX-License-Identifier: GPL-3.0-only
package com.playport.server

/** Releases vanished contacts at their last position, including on browser disconnect. */
internal class TouchState {
    private val active = linkedMapOf<Int, TouchContactMessage>()

    @Synchronized
    fun update(contacts: List<TouchContactMessage>): List<TouchContactMessage> {
        val supplied = contacts.map { it.id }.toSet()
        val released = active.values.filter { it.id !in supplied }.map { it.copy(down = false) }
        val current = contacts.map { contact ->
            if (contact.down) contact else (active[contact.id] ?: contact).copy(down = false)
        }
        active.clear()
        current.filter { it.down }.forEach { active[it.id] = it }
        return current + released
    }

    @Synchronized
    fun clear() = active.clear()
}
