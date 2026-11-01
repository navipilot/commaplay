#!/usr/bin/env python3
"""Read-only iPhone preflight. Output flags only, never keys, passwords or device names."""
# Copyright (c) 2026 机械小鸽; SPDX-License-Identifier: GPL-3.0-only
import argparse
import json
from pathlib import Path
import subprocess


def command(*args):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=3)
        return result.stdout if result.returncode == 0 else ''
    except (OSError, subprocess.SubprocessError):
        return ''


def private_settings(root):
    settings = {}
    try:
        loaded = json.loads((root / 'state/config.json').read_text())
        if isinstance(loaded, dict):
            settings.update(loaded)
    except (OSError, ValueError):
        pass
    try:
        args = (root / 'receiver.args').read_text().splitlines()
    except OSError:
        args = []
    for index, arg in enumerate(args):
        for flag, key in (('--wifi-passphrase', 'wifiPassphrase'), ('--wifi-ssid', 'wifiSsid'), ('--bt-address', 'bluetoothDeviceAddress')):
            if arg == flag and index + 1 < len(args):
                settings[key] = args[index + 1]
            elif arg.startswith(flag + '='):
                settings[key] = arg.split('=', 1)[1]
    return settings


def inspect(root, run=command, controller_path=Path('/sys/class/bluetooth/hci0')):
    settings = private_settings(root)
    identity = root / 'identity/offline-mfi'
    key = (identity / 'identity.pk8').is_file()
    certificate = (identity / 'certificate.p7b').is_file()
    adapter = run('bluetoothctl', '--timeout', '2', 'show')
    powered = 'Powered: yes' in adapter
    pairable = 'Pairable: yes' in adapter
    discoverable = 'Discoverable: yes' in adapter
    paired = run('bluetoothctl', '--timeout', '2', 'devices', 'Paired')
    paired_count = sum(line.startswith('Device ') for line in paired.splitlines())
    wifi = run('nmcli', '--terse', '--escape', 'no', '--fields', 'ACTIVE,CHAN', 'device', 'wifi', 'list', '--rescan', 'no')
    channel = next((line.split(':', 1)[1] for line in wifi.splitlines() if line.startswith('yes:')), '')
    bridge = root / 'native/linux-platform.py'
    controller = controller_path.exists()
    bluez = run('systemctl', 'is-active', 'bluetooth.service').strip() == 'active'
    try:
        mode = (root / 'mode').read_text().strip()
    except OSError:
        mode = 'unknown'
    blockers = []
    if not controller or not bluez or not powered:
        blockers.append('bluetooth_radio_not_ready')
    if not key or not certificate:
        blockers.append('authorized_mfi_identity_files_missing')
    if paired_count == 0:
        blockers.append('iphone_not_paired')
    if not channel and not settings.get('wifiSsid'):
        blockers.append('wifi_network_not_configured')
    if not bridge.is_file():
        blockers.append('linux_bluetooth_bridge_missing')
    return {
        'mode': mode,
        'radio': {'controllerPresent': controller, 'bluezRunning': bluez, 'powered': powered,
                  'pairable': pairable, 'discoverable': discoverable},
        'identity': {'privateKeyPresent': key, 'certificatePresent': certificate,
                     'validity': 'not_verified', 'authorization': 'must_be_supplied_by_owner'},
        'wifi': {'connected': bool(channel), 'channel': int(channel) if channel.isdigit() else None,
                 'passphraseConfigured': bool(settings.get('wifiPassphrase'))},
        'pairedDeviceCount': paired_count,
        'blockers': blockers,
        'notice': 'Preflight only. File presence or Bluetooth pairing does not prove CarPlay authentication.',
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    print(json.dumps(inspect(parser.parse_args().root), ensure_ascii=True))
