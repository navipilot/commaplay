#!/usr/bin/env bash
# Copyright (c) 2026 机械小鸽; SPDX-License-Identifier: GPL-3.0-only
set -euo pipefail
if [[ "$(id -u)" != 0 ]]; then
  echo "Run with sudo to initialize the radio." >&2
  exit 1
fi
if systemctl is-active --quiet commaplay-bluetooth-radio.service; then
  echo "CommaPlay radio is already running."
  exit 0
fi
if [[ -e /sys/class/bluetooth/hci0 ]] || systemctl is-active --quiet carrot-bluetooth-radio.service; then
  echo "Bluetooth is managed elsewhere; leave the existing radio unchanged."
  exit 0
fi
install -m 644 /data/commaplay/deploy/commaplay-bluetooth-radio.service /run/systemd/system/commaplay-bluetooth-radio.service
systemctl daemon-reload
if systemctl is-failed --quiet commaplay-bluetooth-radio.service; then
  systemctl reset-failed commaplay-bluetooth-radio.service
fi
systemctl start commaplay-bluetooth-radio.service
timeout 8 bluetoothctl --timeout 5 system-alias CommaPlay
timeout 8 bluetoothctl --timeout 5 discoverable off
timeout 8 bluetoothctl --timeout 5 pairable off
test -e /sys/class/bluetooth/hci0
echo "Radio ready. Pairing/discovery remain off until an interactive user opens a pairing window."
