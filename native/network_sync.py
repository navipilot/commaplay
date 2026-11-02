# Copyright (c) 2026 机械小鸽; SPDX-License-Identifier: GPL-3.0-only
"""Follow active Wi-Fi topology without changing NetworkManager or saved settings."""
from dataclasses import dataclass
import grp
import ipaddress
import json
import logging
import math
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import threading
import time

DIRECTORY = Path("/run/commaplay-network")
SAFETY = Path("/dev/shm/carrot-bluetooth/status.json")


def command(*args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=5)
    if result.returncode:
        raise RuntimeError(f"{Path(args[0]).name} failed")
    return result.stdout.strip()


@dataclass(frozen=True)
class Network:
    interface: str
    address: str
    ssid: str
    passphrase: str
    channel: int
    security: str
    hotspot: bool

    def args(self):
        return ["--bind", self.address, "--wifi-ssid", self.ssid,
                "--wifi-passphrase", self.passphrase, "--wifi-channel", str(self.channel),
                "--wifi-security", self.security]


def detect(run=command):
    active = run("nmcli", "-t", "-f", "UUID,TYPE,DEVICE", "connection", "show", "--active")
    candidates = []
    for line in active.splitlines():
        fields = line.split(":")
        if len(fields) != 3:
            continue
        uuid, kind, interface = fields
        if kind != "802-11-wireless" or not re.fullmatch(r"[A-Za-z0-9_.-]{1,15}", interface):
            continue
        def field(name):
            return run("nmcli", "-g", name, "connection", "show", uuid)
        mode, method = field("802-11-wireless.mode"), field("ipv4.method")
        hotspot = mode == "ap" and method == "shared"
        if not hotspot and mode != "infrastructure":
            continue
        addresses = json.loads(run("ip", "-j", "-4", "address", "show", "dev", interface))
        address = next((info["local"] for dev in addresses for info in dev.get("addr_info", [])
                        if info.get("scope") == "global"
                        and ipaddress.IPv4Address(info["local"]).is_private
                        and not ipaddress.IPv4Address(info["local"]).is_loopback
                        and not ipaddress.IPv4Address(info["local"]).is_link_local), None)
        if not address:
            continue
        ssid = field("802-11-wireless.ssid")
        security = field("802-11-wireless-security.key-mgmt")
        if security not in ("wpa-psk", "sae", "", "--"):
            raise RuntimeError("Unsupported Wi-Fi security")
        psk = run("nmcli", "--show-secrets", "-g", "802-11-wireless-security.psk",
                  "connection", "show", uuid) if security in ("wpa-psk", "sae") else ""
        if security in ("wpa-psk", "sae") and (not psk or psk == "--"):
            raise RuntimeError("Wi-Fi passphrase unavailable")
        scan = run("nmcli", "-t", "--escape", "no", "-f", "ACTIVE,SSID,CHAN",
                   "device", "wifi", "list", "ifname", interface, "--rescan", "no")
        channel = next((int(row.rsplit(":", 1)[1]) for row in scan.splitlines()
                        if row.startswith("yes:") and row[4:].rsplit(":", 1)[0] == ssid), 0)
        if not ssid or channel <= 0 or any("\n" in value or "\r" in value for value in (ssid, psk)):
            raise RuntimeError("Incomplete Wi-Fi parameters")
        candidates.append(Network(interface, address, ssid, psk, channel,
                                  "wpa3" if security == "sae" else "wpa2" if psk else "open", hotspot))
    if not candidates:
        return None
    # Hotspot takes precedence over a concurrent management Wi-Fi connection.
    return sorted(candidates, key=lambda network: (not network.hotspot, network.interface))[0]


def safe(path=SAFETY, now=None):
    try:
        state = path.read_text()
        data = json.loads(state)
        stamp = data.get("time")
        age = (time.monotonic() if now is None else now) - stamp
        return (type(stamp) in (int, float) and math.isfinite(stamp) and 0 <= age < 2
                and data.get("stationary") is True and data.get("started") is False)
    except (OSError, ValueError, TypeError):
        return False


def publish(network, directory=DIRECTORY, group=None):
    directory.mkdir(mode=0o750, parents=True, exist_ok=True)
    if group is not None:
        os.chown(directory, 0, group)
    temporary = directory / "receiver.args.tmp"
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o640)
    with os.fdopen(fd, "w") as stream:
        stream.write("\n".join(network.args()) + "\n")
    temporary.chmod(0o640)
    if group is not None:
        os.chown(temporary, 0, group)
    temporary.replace(directory / "receiver.args")


class Sync:
    def __init__(self):
        self.applied = None
        self.pending = None
        self.samples = 0

    def update(self, network, allowed, write, restart, running=True):
        if network is None:
            self.pending = None
            self.samples = 0
            return False
        self.samples = self.samples + 1 if network == self.pending else 1
        self.pending = network
        if self.samples < 2 or network == self.applied or (running and not allowed):
            return False
        write(network)
        if running:
            restart()
        self.applied = network
        return True


def main():
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    group = grp.getgrnam("comma").gr_gid
    if "--prepare" in sys.argv:
        network = detect()
        if network:
            publish(network, group=group)
        else:
            (DIRECTORY / "receiver.args").unlink(missing_ok=True)
        return
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    sync = Sync()
    failed = False
    while not stop.is_set():
        try:
            if Path("/data/commaplay/mode").read_text().strip() != "carplay":
                stop.wait(2)
                continue
            network = detect()
            running = subprocess.run(["systemctl", "is-active", "--quiet", "commaplay.service"]).returncode == 0
            if sync.update(network, safe(), lambda value: publish(value, group=group),
                           lambda: command("systemctl", "restart", "commaplay.service"), running):
                logging.info("Receiver network updated: %s %s %s", "hotspot" if network.hotspot else "LAN",
                             network.interface, network.address)
            failed = False
        except Exception:
            if not failed:
                logging.warning("Network detection/reconfiguration unavailable; retained last configuration")
            failed = True
            sync.pending = None
            sync.samples = 0
        stop.wait(2)


if __name__ == "__main__":
    main()
