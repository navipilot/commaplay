# Copyright (c) 2026 机械小鸽; SPDX-License-Identifier: GPL-3.0-only
import importlib.util
from pathlib import Path
import tempfile
import subprocess
import time
import unittest

spec = importlib.util.spec_from_file_location('autostart', Path(__file__).resolve().parents[1] / 'deploy/install-autostart.py')
autostart = importlib.util.module_from_spec(spec)
spec.loader.exec_module(autostart)

ORIGINAL = '''#!/usr/bin/env bash
if ! pgrep -f "bridge can" >/dev/null; then
    ( sleep 15; cd /data/openpilot/cereal/messaging; ./bridge can >/dev/null 2>&1 ) &
fi
cd /data/openpilot
exec ./launch_openpilot.sh
'''


class AutostartTest(unittest.TestCase):
    def test_preserves_original_and_is_idempotent(self):
        result = autostart.updated(ORIGINAL)
        self.assertEqual(autostart.updated(result), result)
        self.assertEqual(autostart.updated(result, remove=True), ORIGINAL)
        self.assertLess(result.index(autostart.BEGIN), result.index(autostart.ANCHOR))

    def test_refuses_ambiguous_or_modified_scripts(self):
        for source in ('#!/bin/bash\n', ORIGINAL + autostart.ANCHOR + '\n',
                       autostart.updated(ORIGINAL).replace('timeout 210', 'timeout 999'),
                       ORIGINAL + autostart.END):
            with self.subTest(source=source), self.assertRaises(ValueError):
                autostart.updated(source)

    def test_atomic_install_backup_permissions_and_remove(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'continue.sh'
            path.write_text(ORIGINAL)
            path.chmod(0o755)
            self.assertTrue(autostart.install(path))
            self.assertFalse(autostart.install(path))
            backup = path.with_name('continue.sh.commaplay-backup')
            self.assertEqual(backup.read_text(), ORIGINAL)
            self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
            self.assertEqual(path.stat().st_mode & 0o777, 0o755)
            self.assertTrue(autostart.install(path, remove=True))
            self.assertEqual(path.read_text(), ORIGINAL)

    def test_refuses_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'target'
            target.write_text(ORIGINAL)
            path = Path(directory) / 'continue.sh'
            path.symlink_to(target)
            with self.assertRaises(ValueError):
                autostart.install(path)

    def test_hook_does_not_wait_for_startup(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / 'started'
            hook = autostart.HOOK.replace('[ -x /data/commaplay/deploy/start.sh ]', '[ -n yes ]')
            hook = hook.replace('sudo -n timeout 210 /data/commaplay/deploy/start.sh',
                                f'sleep 1; touch "{marker}"')
            before = time.monotonic()
            output = Path(directory) / 'boot-output'
            with output.open('w') as file:
                result = subprocess.run(['bash', '-c', hook + 'echo openpilot-can-continue'],
                                        stdout=file, stderr=file, timeout=3)
            self.assertEqual(result.returncode, 0)
            self.assertIn('openpilot-can-continue', output.read_text())
            self.assertLess(time.monotonic() - before, .8)
            for _ in range(30):
                if marker.exists():
                    break
                time.sleep(.1)
            self.assertTrue(marker.exists())


if __name__ == '__main__':
    unittest.main()
