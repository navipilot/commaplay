# Copyright (c) 2026 机械小鸽; SPDX-License-Identifier: GPL-3.0-only
"""Run with sudo unshare --net: never tests NAT in the host network namespace."""
import http.server
import importlib.util
import os
import json
from pathlib import Path
import subprocess
import threading
import tempfile
import time

assert os.readlink("/proc/self/ns/net") != os.readlink("/proc/1/ns/net"), "Requires isolated network namespace"
spec = importlib.util.spec_from_file_location("hotspot_nat", Path(__file__).resolve().parents[1] / "native/hotspot_nat.py")
hotspot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hotspot)


def command(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=5).stdout


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"commaplay-hotspot-ok")

    def log_message(self, *_):
        pass


client = subprocess.Popen(["unshare", "--net", "sleep", "90"])
server = None
nat = hotspot.Nat()
try:
    for _ in range(100):
        if os.readlink(f"/proc/{client.pid}/ns/net") != os.readlink("/proc/self/ns/net"):
            break
        threading.Event().wait(.01)
    else:
        raise RuntimeError("Client namespace not ready")
    command("ip", "link", "set", "lo", "up")
    command("ip", "link", "add", "ap0", "type", "veth", "peer", "name", "client0")
    command("ip", "addr", "add", "192.168.43.1/24", "dev", "ap0")
    command("ip", "link", "set", "ap0", "up")
    command("ip", "link", "set", "client0", "netns", str(client.pid))
    prefix = ["nsenter", "-t", str(client.pid), "-n"]
    command(*prefix, "ip", "link", "set", "lo", "up")
    command(*prefix, "ip", "link", "set", "client0", "up")
    command(*prefix, "ip", "addr", "add", "192.168.43.2/24", "dev", "client0")
    command(*prefix, "ip", "route", "add", "default", "via", "192.168.43.1")
    server = http.server.ThreadingHTTPServer(("0.0.0.0", 8080), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    command(hotspot.IPTABLES, "-t", "nat", "-N", "UNRELATED_TEST")
    def request(port=8080):
        return subprocess.run([*prefix, "curl", "--noproxy", "*", "--max-time", "2", "-fsS",
                               f"http://99.99.99.99:{port}/"], capture_output=True, timeout=4)
    nat.update((("ap0", "192.168.43.1"),))
    assert request().stdout == b"commaplay-hotspot-ok"
    assert request(8081).returncode != 0, "Other ports must not be mapped"
    nat.update((("other0", "192.168.43.1"),))
    assert request().returncode != 0, "Non-hotspot ingress must not be mapped"
    command("ip", "addr", "add", "192.168.43.3/24", "dev", "ap0")
    nat.update((("ap0", "192.168.43.3"),))
    assert request().stdout == b"commaplay-hotspot-ok", "Address change must be reconciled"
    nat.update(())
    assert request().returncode != 0, "Turning off hotspot must remove the mapping"
    nat.close()
    command(hotspot.IPTABLES, "-t", "nat", "-S", "UNRELATED_TEST")
    with tempfile.TemporaryDirectory(prefix="commaplay-hotspot-monitor-") as directory:
        fixture = Path(directory) / "hotspots.json"
        state = Path(directory) / "status.json"
        fixture.write_text("[]")
        code = """import importlib.util,json,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('monitor',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
m.STATUS=Path(sys.argv[3])
m.hotspots=lambda:tuple(tuple(x) for x in json.loads(Path(sys.argv[2]).read_text()))
m.main()
"""
        monitor = subprocess.Popen(["python3", "-c", code, str(spec.origin), str(fixture), str(state)],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            def await_state(enabled, address=None):
                deadline = time.monotonic() + 8
                while time.monotonic() < deadline:
                    if monitor.poll() is not None:
                        raise RuntimeError("Monitor exited before state transition")
                    if state.exists():
                        value = json.loads(state.read_text())
                        if value["enabled"] == enabled and (address is None or
                                value["hotspots"][0]["address"] == address):
                            return
                    time.sleep(.1)
                raise RuntimeError("Monitor did not reconcile hotspot transition")
            await_state(False)
            fixture.write_text(json.dumps([["ap0", "192.168.43.1"]]))
            await_state(True, "192.168.43.1")
            assert request().stdout == b"commaplay-hotspot-ok"
            fixture.write_text(json.dumps([["ap0", "192.168.43.3"]]))
            await_state(True, "192.168.43.3")
            assert request().stdout == b"commaplay-hotspot-ok"
            fixture.write_text("[]")
            await_state(False)
            assert request().returncode != 0
            fixture.write_text(json.dumps([["ap0", "192.168.43.1"]]))
            await_state(True, "192.168.43.1")
        finally:
            monitor.terminate()
            monitor.wait(timeout=20)
        assert request().returncode != 0, "Stopping monitor must remove its active mapping"
        command(hotspot.IPTABLES, "-t", "nat", "-S", "UNRELATED_TEST")
    print("Isolated network test passed: real client DNAT, port/interface isolation, continuous on/off/address monitoring, stop cleanup, unrelated chain preserved.")
finally:
    if server:
        server.shutdown()
        server.server_close()
    client.terminate()
    client.wait(timeout=5)
