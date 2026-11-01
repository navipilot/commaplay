#!/usr/bin/env bash
# Copyright (c) 2026 机械小鸽; SPDX-License-Identifier: GPL-3.0-only
set -euo pipefail
if [[ "$(id -u)" != 0 ]]; then
  echo "Run with sudo to start CommaPlay." >&2
  exit 1
fi
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
exec 9>/run/commaplay-start.lock
flock -w 110 9
radio_status=0
timeout 90 "$ROOT/deploy/start-radio.sh" || radio_status=$?
# Keep Debug available even if radio initialization fails.
"$ROOT/deploy/start-service.sh"
if [[ "$radio_status" != 0 ]]; then
  echo "Bluetooth initialization failed ($radio_status); check Debug and retry start.sh." >&2
  exit "$radio_status"
fi
