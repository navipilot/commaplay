# Copyright (c) 2026 机械小鸽; SPDX-License-Identifier: GPL-3.0-only
"""Map the Tesla viewer address only on active NetworkManager IPv4 hotspots."""
import ipaddress
import json
import logging
import re
import signal
import subprocess
import threading
from pathlib import Path

CHAIN = "COMMAPLAY_TESLA"
VIRTUAL_IP = "99.99.99.99"
INTERVAL = 2
STATUS = Path("/run/commaplay-hotspot/status.json")
IPTABLES = "/usr/sbin/iptables-legacy"
RESTORE = "/usr/sbin/iptables-legacy-restore"
JUMP = ["-d", VIRTUAL_IP + "/32", "-p", "tcp", "--dport", "8080", "-j", CHAIN]


def run(args, **kwargs):
    return subprocess.run(args, text=True, capture_output=True, timeout=5, **kwargs)


def checked(args, **kwargs):
    result = run(args, **kwargs)
    if result.returncode:
        raise RuntimeError(f"{Path(args[0]).name} failed ({result.returncode})")
    return result.stdout


def hotspots():
    active = checked(["nmcli", "-t", "-f", "UUID,TYPE,DEVICE", "connection", "show", "--active"])
    result = []
    for line in active.splitlines():
        fields = line.split(":")
        if len(fields) != 3:
            continue
        uuid, kind, interface = fields
        if kind != "802-11-wireless" or not re.fullmatch(r"[A-Za-z0-9_.-]{1,15}", interface):
            continue
        settings = checked(["nmcli", "-g", "802-11-wireless.mode,ipv4.method",
                            "connection", "show", uuid]).splitlines()
        if settings != ["ap", "shared"]:
            continue
        addresses = json.loads(checked(["ip", "-j", "-4", "address", "show", "dev", interface]))
        for entry in addresses:
            for address in entry.get("addr_info", []):
                if address.get("scope") != "global":
                    continue
                value = ipaddress.IPv4Address(address["local"])
                if value.is_private and not value.is_loopback and not value.is_link_local:
                    result.append((interface, str(value)))
                    break
    return tuple(sorted(set(result)))


class Nat:
    def __init__(self):
        self.current = None

    def prepare(self):
        if run([IPTABLES, "-w", "2", "-t", "nat", "-S", CHAIN]).returncode:
            checked([IPTABLES, "-w", "2", "-t", "nat", "-N", CHAIN])

    def remove_jump(self):
        while run([IPTABLES, "-w", "2", "-t", "nat", "-C", "PREROUTING", *JUMP]).returncode == 0:
            checked([IPTABLES, "-w", "2", "-t", "nat", "-D", "PREROUTING", *JUMP])

    def update(self, active):
        # Reconcile even without a state change: NetworkManager may rebuild firewall rules.
        self.prepare()
        rules = [f"-A {CHAIN} -i {interface} -d {VIRTUAL_IP}/32 -p tcp --dport 8080 "
                 f"-j DNAT --to-destination {address}:8080" for interface, address in active]
        checked([RESTORE, "-w", "2", "--noflush"],
                input="\n".join(["*nat", f"-F {CHAIN}", *rules, "COMMIT", ""]))
        if active:
            if run([IPTABLES, "-w", "2", "-t", "nat", "-C", "PREROUTING", *JUMP]).returncode:
                checked([IPTABLES, "-w", "2", "-t", "nat", "-I", "PREROUTING", "1", *JUMP])
        else:
            self.remove_jump()
        if self.current != active:
            logging.info("Tesla hotspot mapping %s", "enabled" if active else "disabled")
        self.current = active

    def close(self):
        self.remove_jump()
        if run([IPTABLES, "-w", "2", "-t", "nat", "-S", CHAIN]).returncode == 0:
            checked([IPTABLES, "-w", "2", "-t", "nat", "-F", CHAIN])
            checked([IPTABLES, "-w", "2", "-t", "nat", "-X", CHAIN])


def status(active, error=None):
    STATUS.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    temporary = STATUS.with_suffix(".tmp")
    temporary.write_text(json.dumps({"enabled": bool(active) and error is None,
                                    "url": f"http://{VIRTUAL_IP}:8080/",
                                    "hotspots": [{"interface": interface, "address": address}
                                                 for interface, address in active],
                                    "error": error}) + "\n")
    temporary.chmod(0o644)
    temporary.replace(STATUS)


def main():
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    nat = Nat()
    failed = False
    try:
        while not stop.is_set():
            try:
                active = hotspots()
                nat.update(active)
                status(active)
                failed = False
            except Exception as error:
                if not failed:
                    logging.warning("Hotspot mapping unavailable: %s", error)
                failed = True
                # A failed detection must not retain a stale mapping to a former Wi-Fi address.
                try:
                    nat.update(())
                except Exception:
                    logging.warning("Unable to clear hotspot mapping")
                status((), "detection_or_nat_failed")
            stop.wait(INTERVAL)
    finally:
        try:
            nat.close()
        finally:
            status(())


if __name__ == "__main__":
    main()
