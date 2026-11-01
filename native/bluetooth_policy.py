"""Validation and ownership for web-only setup; no vehicle commands."""
# Copyright (c) 2026 机械小鸽
# SPDX-License-Identifier: GPL-3.0-only
import json
import math
import os
from pathlib import Path
import re
import time
import uuid

MAC = re.compile(r'(?:[0-9A-F]{2}:){5}[0-9A-F]{2}')
CLIENT = re.compile(r'[0-9a-f]{32}')


def address(value):
    if not isinstance(value, str) or not MAC.fullmatch(value.upper()):
        raise ValueError('invalid Bluetooth address')
    return value.upper()


def client_id(value):
    if not isinstance(value, str) or not CLIENT.fullmatch(value):
        raise ValueError('invalid debug session')
    return value


def stationary(path, now=None):
    now = time.monotonic() if now is None else now
    try:
        data = json.loads(Path(path).read_text())
        stamp = data.get('time')
        fresh = type(stamp) in (float, int) and math.isfinite(stamp) and 0 <= now - stamp < 2
        allowed = fresh and data.get('stationary') is True and not data.get('stopped')
    except (OSError, ValueError, AttributeError, TypeError):
        allowed = fresh = False
    return {'allowed': bool(allowed), 'fresh': bool(fresh),
            'reason': None if allowed else 'fresh_stationary_disengaged_state_required'}


class Lease:
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.owner = None
        self.until = 0

    def acquire(self, client, seconds=15):
        client_id(client)
        if self.owner is not None and self.owner != client:
            raise ValueError('another debug page owns setup; close it or wait for timeout')
        self.owner = client
        self.until = self.clock() + seconds

    def heartbeat(self, client, seconds=15):
        if self.owner == client:
            self.until = self.clock() + seconds

    def expired(self):
        return self.owner is not None and self.clock() >= self.until

    def release(self):
        self.owner = None
        self.until = 0


def selected_phone(root):
    try:
        args = (Path(root) / 'receiver.args').read_text().splitlines()
    except OSError:
        return None
    for i, arg in enumerate(args):
        value = args[i + 1] if arg == '--bt-address' and i + 1 < len(args) else arg.removeprefix('--bt-address=') if arg.startswith('--bt-address=') else None
        if value:
            try:
                return address(value)
            except ValueError:
                return None
    return None


def select_phone(root, mac):
    mac = address(mac)
    path = Path(root) / 'receiver.args'
    try:
        args = path.read_text().splitlines()
    except FileNotFoundError:
        args = []
    result = []
    index = 0
    while index < len(args):
        arg = args[index]
        if arg == '--bt-address':
            index += 1
            if index < len(args) and not args[index].startswith('--'):
                index += 1
            continue
        if not arg.startswith('--bt-address='):
            result.append(arg)
        index += 1
    result.extend(['--bt-address', mac])
    temporary = path.with_name(f'.{path.name}.{uuid.uuid4().hex}.tmp')
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as stream:
            stream.write('\n'.join(result) + '\n')
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
