#!/usr/bin/env bash
# Copyright (c) 2026 机械小鸽; SPDX-License-Identifier: GPL-3.0-only
set -euo pipefail
if [[ "$(id -u)" != 0 ]]; then
  echo "Run with sudo to register the runtime service unit." >&2
  exit 1
fi
# comma's system partition is read-only; keep the source unit on /data.
install -m 644 /data/commaplay/deploy/commaplay.service /run/systemd/system/commaplay.service
install -m 644 /data/commaplay/deploy/commaplay-bluetooth-web.service /run/systemd/system/commaplay-bluetooth-web.service
install -m 644 /data/commaplay/deploy/commaplay-hotspot.service /run/systemd/system/commaplay-hotspot.service
systemctl daemon-reload
systemctl start --no-block commaplay-bluetooth-web.service
systemctl start --no-block commaplay.service
systemctl start --no-block commaplay-hotspot.service
