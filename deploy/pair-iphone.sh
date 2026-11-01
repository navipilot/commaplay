#!/usr/bin/env bash
# Copyright (c) 2026 机械小鸽; SPDX-License-Identifier: GPL-3.0-only
set -euo pipefail
if [[ "$(id -u)" != 0 ]] || [[ ! -t 0 ]] || [[ ! -t 1 ]]; then
  echo "Use an interactive SSH terminal with sudo; unattended pairing is not allowed." >&2
  exit 1
fi
if [[ ! -e /sys/class/bluetooth/hci0 ]]; then
  echo "Initialize the radio with deploy/start-radio.sh first." >&2
  exit 1
fi
cleanup() {
  timeout 5 bluetoothctl --timeout 2 discoverable off </dev/null >/dev/null 2>&1 || true
  timeout 5 bluetoothctl --timeout 2 pairable off </dev/null >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
printf '%s\n' \
  "Park before testing. In bluetoothctl enter:" \
  "  default-agent" \
  "  pairable on" \
  "  discoverable-timeout 120" \
  "  discoverable on" \
  "On the iPhone select CommaPlay. Confirm only matching passkeys on both devices." \
  "Enter quit when finished; this helper closes the pairing window on exit." \
  "Bluetooth pairing is not MFi authentication or a working CarPlay connection."
bluetoothctl --agent=KeyboardDisplay
