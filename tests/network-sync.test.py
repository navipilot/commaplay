# Copyright (c) 2026 机械小鸽; SPDX-License-Identifier: GPL-3.0-only
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("network_sync", Path(__file__).resolve().parents[1] / "native/network_sync.py")
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


def fixture(hotspot=True, address="192.168.43.1", secret="test-password", interfaces=("wlan0",)):
    def run(*args):
        if args[:5] == ("nmcli", "-t", "-f", "UUID,TYPE,DEVICE", "connection"):
            return "\n".join(f"id-{interface}:802-11-wireless:{interface}" for interface in interfaces)
        if args[0] == "ip":
            return json.dumps([{"addr_info": [{"local": address, "scope": "global"}]}])
        if "list" in args:
            return "yes:Test:Network:11"
        field = args[args.index("-g") + 1]
        ap = hotspot and args[-1] == "id-wlan0"
        return {"802-11-wireless.mode": "ap" if ap else "infrastructure",
                "ipv4.method": "shared" if ap else "auto",
                "802-11-wireless.ssid": "Test:Network",
                "802-11-wireless-security.key-mgmt": "wpa-psk",
                "802-11-wireless-security.psk": secret}[field]
    return run


class NetworkTest(unittest.TestCase):
    def test_detects_lan_and_hotspot_and_prioritizes_hotspot(self):
        ap = module.detect(fixture(interfaces=("aaa", "wlan0")))
        self.assertTrue(ap.hotspot)
        self.assertEqual(ap.interface, "wlan0")
        self.assertEqual(ap.address, "192.168.43.1")
        self.assertEqual(ap.channel, 11)
        lan = module.detect(fixture(False, "192.168.31.204"))
        self.assertFalse(lan.hotspot)
        self.assertIn("192.168.31.204", lan.args())

    def test_missing_secret_or_line_injection_fails_closed(self):
        for secret in ("", "--", "password\n--diagnostics"):
            with self.subTest(secret=secret), self.assertRaises(RuntimeError):
                module.detect(fixture(secret=secret))

    def test_debounce_safe_transition_and_no_repeated_restarts(self):
        sync = module.Sync()
        writes, restarts = [], []
        ap, lan = module.detect(fixture()), module.detect(fixture(False, "192.168.31.204"))
        def tick(network, allowed=True):
            return sync.update(network, allowed, writes.append, lambda: restarts.append(True))
        self.assertFalse(tick(ap))
        self.assertFalse(tick(ap, False))
        self.assertTrue(tick(ap))
        self.assertFalse(tick(ap))
        self.assertFalse(tick(None))
        self.assertFalse(tick(lan))
        self.assertTrue(tick(lan))
        self.assertEqual(writes, [ap, lan])
        self.assertEqual(len(restarts), 2)

    def test_retry_failed_restart_and_do_not_start_stopped_receiver(self):
        sync, ap = module.Sync(), module.detect(fixture())
        sync.update(ap, True, lambda _: None, lambda: None)
        def failed():
            raise RuntimeError("restart failed")
        with self.assertRaises(RuntimeError):
            sync.update(ap, True, lambda _: None, failed)
        self.assertIsNone(sync.applied)
        self.assertTrue(sync.update(ap, False, lambda _: None, failed, running=False))

    def test_private_atomic_args_and_fresh_safety(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            module.publish(module.detect(fixture()), path)
            self.assertEqual((path / "receiver.args").stat().st_mode & 0o777, 0o640)
            safety = path / "safety.json"
            for stamp, stationary, started, expected in (
                (10, True, False, True), (8, True, False, False),
                (10, False, False, False), (10, True, True, False),
                (float("nan"), True, False, False),
            ):
                safety.write_text(json.dumps(dict(time=stamp, stationary=stationary, started=started)))
                self.assertEqual(module.safe(safety, now=11), expected)


if __name__ == "__main__":
    unittest.main()
