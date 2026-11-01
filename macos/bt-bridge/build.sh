#!/bin/sh
# Builds the macOS Bluetooth RFCOMM bridge helper.
set -e
cd "$(dirname "$0")"
swiftc -O -o bt-bridge main.swift -framework IOBluetooth
echo "built: $(pwd)/bt-bridge"
