#!/usr/bin/env bash
# Copyright (c) 2026 机械小鸽; SPDX-License-Identifier: GPL-3.0-only
set -euo pipefail
umask 077
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
MODE="$(cat "$ROOT/mode")"
args=(--http --http-port 8080 --airplay-port 17000 --device-name CommaPlay
  --state-dir "$ROOT/state" --identity-dir "$ROOT/identity"
  --no-browser-auth)
case "$MODE" in
  diagnostics)
    args+=(--diagnostics --width 1280 --height 720 --fps 30 --demo-video "$ROOT/testdata/demo.h264")
    ;;
  carplay)
    args+=(--wireless --bt-bridge "$ROOT/native/linux-platform.py" --mdns jmdns --fps 30)
    if [[ -f "$ROOT/receiver.args" ]]; then
      mapfile -t receiver_args < "$ROOT/receiver.args"
      args+=("${receiver_args[@]}")
    fi
    ;;
  *) echo "Invalid mode: expected diagnostics or carplay" >&2; exit 1 ;;
esac
exec "$ROOT/runtime/bin/java" -Xms32m -Xmx256m -XX:ActiveProcessorCount=2 -XX:+UseSerialGC \
  -Dorg.slf4j.simpleLogger.defaultLogLevel=info -cp "$ROOT/server/lib/*" \
  com.playport.server.MainKt "${args[@]}"
