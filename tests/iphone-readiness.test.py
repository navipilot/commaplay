import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import subprocess

spec = importlib.util.spec_from_file_location('iphone_check', Path(__file__).resolve().parents[1] / 'deploy/check-iphone.py')
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


class ReadinessTests(unittest.TestCase):
    def test_pairing_helper_refuses_an_unattended_terminal(self):
        script = Path(check.__file__).with_name('pair-iphone.sh')
        result = subprocess.run(['bash', str(script)], capture_output=True, text=True, timeout=3)
        self.assertEqual(result.returncode, 1)
        self.assertIn('unattended pairing is not allowed', result.stderr)

    def test_configured_address_does_not_prove_pairing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'receiver.args').write_text('--bt-address\nAA:BB:CC:DD:EE:FF\n')
            result = check.inspect(root, run=lambda *args: '', controller_path=root / 'absent')
            self.assertIn('iphone_not_paired', result['blockers'])

    def test_missing_hardware_and_identity_are_explicit_blockers(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = check.inspect(root, run=lambda *args: '', controller_path=root / 'absent')
            self.assertIn('bluetooth_radio_not_ready', result['blockers'])
            self.assertIn('authorized_mfi_identity_files_missing', result['blockers'])
            self.assertIn('iphone_not_paired', result['blockers'])
            self.assertEqual(result['identity']['validity'], 'not_verified')

    def test_report_never_exports_private_values_or_paired_names(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'state').mkdir()
            (root / 'native').mkdir()
            (root / 'identity/offline-mfi').mkdir(parents=True)
            (root / 'native/linux-platform.py').touch()
            (root / 'identity/offline-mfi/identity.pk8').write_text('fixture-key-not-a-real-key')
            (root / 'identity/offline-mfi/certificate.p7b').write_text('fixture-not-a-certificate')
            (root / 'state/config.json').write_text(json.dumps({'wifiPassphrase': 'fixture-old-password'}))
            (root / 'receiver.args').write_text('--wifi-passphrase=fixture-new-password\n')
            (root / 'mode').write_text('diagnostics\n')
            (root / 'controller').touch()
            def run(*args):
                if 'show' in args:
                    return 'Powered: yes\nPairable: no\nDiscoverable: no\n'
                if 'Paired' in args:
                    return 'Device AA:BB:CC:DD:EE:FF fixture-private-phone-name\n'
                if args[0] == 'nmcli':
                    return 'no:1\nyes:6\n'
                return 'active\n'
            result = check.inspect(root, run, root / 'controller')
            encoded = json.dumps(result)
            for private in ('fixture-key', 'fixture-old-password', 'fixture-new-password', 'fixture-private-phone-name', 'AA:BB:CC:DD:EE:FF'):
                self.assertNotIn(private, encoded)
            self.assertEqual(result['blockers'], [])
            self.assertEqual(result['identity']['validity'], 'not_verified', 'Presence is not cryptographic validation')
            self.assertTrue(result['wifi']['passphraseConfigured'])
            self.assertEqual(result['wifi']['channel'], 6)
            self.assertFalse(result['radio']['pairable'])

    def test_invalid_private_settings_do_not_break_diagnostics(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'state').mkdir()
            (root / 'state/config.json').write_text('[]')
            (root / 'receiver.args').write_text('--wifi-passphrase\n')
            self.assertEqual(check.private_settings(root), {})


if __name__ == '__main__':
    unittest.main()
