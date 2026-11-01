# Copyright (c) 2026 机械小鸽; SPDX-License-Identifier: GPL-3.0-only
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("hotspot_nat", Path(__file__).resolve().parents[1] / "native/hotspot_nat.py")
hotspot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hotspot)


class HotspotTest(unittest.TestCase):
    def test_only_active_shared_ap_with_global_private_address_is_mapped(self):
        def execute(args, **kwargs):
            if "--active" in args:
                output = "ap-id:802-11-wireless:wlan0\nsta-id:802-11-wireless:wlan1\nlo-id:loopback:lo\n"
            elif args[0] == "nmcli":
                output = "ap\nshared\n" if args[-1] == "ap-id" else "infrastructure\nauto\n"
            else:
                output = json.dumps([{"addr_info": [
                    {"scope": "link", "local": "169.254.1.1"},
                    {"scope": "global", "local": "192.168.43.1"},
                ]}])
            return subprocess.CompletedProcess(args, 0, output, "")
        with patch.object(hotspot, "run", side_effect=execute):
            self.assertEqual(hotspot.hotspots(), (("wlan0", "192.168.43.1"),))

    def test_inactive_hotspot_and_nonshared_ap_are_not_mapped(self):
        with patch.object(hotspot, "checked", return_value=""):
            self.assertEqual(hotspot.hotspots(), ())
        with patch.object(hotspot, "checked", side_effect=["ap-id:802-11-wireless:wlan0", "ap\nmanual\n"]):
            self.assertEqual(hotspot.hotspots(), ())

    def test_detection_failure_is_not_treated_as_active(self):
        with patch.object(hotspot, "run", return_value=subprocess.CompletedProcess([], 1, "", "")):
            with self.assertRaises(RuntimeError):
                hotspot.hotspots()

    def test_reconcile_updates_address_and_removes_only_owned_rules(self):
        commands = []
        jump = False
        def execute(args, **kwargs):
            nonlocal jump
            commands.append((args, kwargs.get("input", "")))
            code = 0
            if "-C" in args:
                code = 0 if jump else 1
            elif "-I" in args:
                jump = True
            elif "-D" in args:
                jump = False
            return subprocess.CompletedProcess(args, code, "", "")
        with patch.object(hotspot, "run", side_effect=execute):
            nat = hotspot.Nat()
            nat.update((("wlan0", "192.168.43.1"),))
            nat.update((("wlan0", "192.168.43.1"),))
            self.assertEqual(sum("-I" in args for args, _ in commands), 1)
            nat.update((("wlan1", "192.168.44.1"),))
            restore = commands[-2][1]
            self.assertIn("-i wlan1", restore)
            self.assertIn("192.168.44.1:8080", restore)
            self.assertNotIn("192.168.43.1", restore)
            nat.update(())
            self.assertFalse(jump)
            nat.close()
        for args, payload in commands:
            self.assertNotIn("FORWARD", args)
            self.assertNotIn("POSTROUTING", args)
            self.assertNotIn("--flush", args)
            if payload:
                self.assertIn("*nat\n-F COMMAPLAY_TESLA", payload)
                self.assertNotIn("-F PREROUTING", payload)
                if "DNAT" in payload:
                    self.assertIn("-d 99.99.99.99/32 -p tcp --dport 8080", payload)

    def test_firewall_jump_deleted_externally_is_restored(self):
        commands = []
        def execute(args, **kwargs):
            commands.append(args)
            return subprocess.CompletedProcess(args, 1 if "-C" in args else 0, "", "")
        with patch.object(hotspot, "run", side_effect=execute):
            nat = hotspot.Nat()
            nat.update((("wlan0", "192.168.43.1"),))
            nat.update((("wlan0", "192.168.43.1"),))
        self.assertEqual(sum("-I" in args for args in commands), 2)


if __name__ == "__main__":
    unittest.main()
