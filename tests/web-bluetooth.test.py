import asyncio
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
from bluetooth_policy import Lease, selected_phone, select_phone, stationary
from bluetooth_web import Broker
from bluez_client import ADAPTER, AGENT, Bluez
from jeepney import DBusAddress, HeaderFields, new_method_call

A = 'a' * 32
B = 'b' * 32
PHONE = 'AA:BB:CC:DD:EE:01'
TARGET = '/org/bluez/hci0/dev_AA_BB_CC_DD_EE_01'


class PolicyTests(unittest.TestCase):
    def test_stationary_requires_fresh_boolean_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'state.json'
            for state in ({'time': 99, 'stationary': True}, {'time': 100, 'stationary': 'true'},
                          {'time': 97, 'stationary': True}, {'time': 101, 'stationary': True},
                          {'time': float('nan'), 'stationary': True}, {'time': 100, 'stationary': True, 'stopped': True}):
                path.write_text(json.dumps(state))
                self.assertEqual(stationary(path, 100)['allowed'], state == {'time': 99, 'stationary': True})
            path.write_text('invalid')
            self.assertFalse(stationary(path, 100)['allowed'])

    def test_selection_preserves_wifi_and_removes_duplicate_targets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'receiver.args'
            path.write_text('--wifi-passphrase\nfixture-private-password\n--bt-address=AA:BB:CC:DD:EE:02\n--bt-address\nAA:BB:CC:DD:EE:03\n--wifi-channel\n6\n')
            select_phone(root, PHONE.lower())
            self.assertEqual(path.read_text(), '--wifi-passphrase\nfixture-private-password\n--wifi-channel\n6\n--bt-address\n' + PHONE + '\n')
            self.assertEqual(selected_phone(root), PHONE)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(ValueError):
                select_phone(root, PHONE + '; shell')

    def test_foreign_page_cannot_refresh_or_steal_lease(self):
        now = [0]
        lease = Lease(lambda: now[0])
        lease.acquire(A)
        now[0] = 10
        lease.heartbeat(B)
        with self.assertRaises(ValueError):
            lease.acquire(B)
        now[0] = 15
        self.assertTrue(lease.expired())


class FakeBluez:
    def __init__(self):
        self.target = self.scan_task = None
        self.stopped = 0
        self.devices = [{'address': PHONE, 'name': 'Fixture iPhone', 'paired': False}]

    async def snapshot(self):
        return {'devices': self.devices, 'adapters': [], 'pair': {'state': 'idle'}, 'prompt': None}

    async def scan(self):
        self.scan_task = asyncio.create_task(asyncio.sleep(3600))

    async def stop_scan(self):
        if self.scan_task:
            self.scan_task.cancel()
            self.scan_task = None
        self.stopped += 1

    async def cancel_pair(self):
        self.target = None

    async def start_pair(self, mac):
        self.target = TARGET


class BrokerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.state = self.root / 'state.json'
        self.state.write_text(json.dumps({'time': time.monotonic(), 'stationary': True}))
        self.bluez = FakeBluez()
        self.broker = Broker(self.root, self.state, self.bluez)

    async def asyncTearDown(self):
        await self.broker.stop()
        self.temporary.cleanup()

    async def test_scan_owner_and_foreign_cancel(self):
        await self.broker.request({'operation': 'scan', 'client': A})
        with self.assertRaises(ValueError):
            await self.broker.request({'operation': 'cancel', 'client': B})
        self.assertIsNotNone(self.bluez.scan_task)
        await self.broker.request({'operation': 'cancel', 'client': A})
        self.assertIsNone(self.bluez.scan_task)

    async def test_motion_blocks_mutation_but_allows_owner_cancel(self):
        await self.broker.request({'operation': 'scan', 'client': A})
        self.state.write_text(json.dumps({'time': time.monotonic(), 'stationary': False}))
        with self.assertRaises(ValueError):
            await self.broker.request({'operation': 'pair', 'client': A, 'address': PHONE})
        await self.broker.request({'operation': 'cancel', 'client': A})
        self.assertIsNone(self.broker.lease.owner)

    async def test_watchdog_releases_expired_page(self):
        await self.broker.request({'operation': 'scan', 'client': A})
        self.broker.lease.until = 0
        task = asyncio.create_task(self.broker.watchdog())
        try:
            await asyncio.sleep(.6)
            self.assertIsNone(self.bluez.scan_task)
            self.assertIsNone(self.broker.lease.owner)
        finally:
            task.cancel()

    async def test_only_paired_target_can_be_saved(self):
        with self.assertRaises(ValueError):
            await self.broker.request({'operation': 'select', 'client': A, 'address': PHONE})
        self.bluez.devices[0]['paired'] = True
        await self.broker.request({'operation': 'select', 'client': A, 'address': PHONE})
        self.assertEqual(selected_phone(self.root), PHONE)

    async def test_foreign_answers_and_unknown_commands_are_rejected(self):
        await self.broker.request({'operation': 'pair', 'client': A, 'address': PHONE})
        with self.assertRaises(ValueError):
            await self.broker.request({'operation': 'answer', 'client': B, 'promptId': 'old', 'value': True})
        with self.assertRaises(ValueError):
            await self.broker.request({'operation': 'connect', 'client': A, 'address': PHONE})


class AgentTests(unittest.IsolatedAsyncioTestCase):
    async def test_confirmation_requires_correct_sender_target_and_explicit_answer(self):
        bluez = Bluez()
        bluez.owner = ':1.42'
        bluez.target = TARGET
        bluez.pair = {'state': 'pairing', 'address': PHONE}
        sent = []
        class Router:
            async def send(self, message):
                sent.append(message)
        bluez.router = Router()
        def request(sender, path):
            message = new_method_call(DBusAddress(AGENT, bus_name='org.bluez', interface='org.bluez.Agent1'),
                                      'RequestConfirmation', 'ou', (path, 123))
            message.header.fields[HeaderFields.sender] = sender
            return message
        for sender, path in ((':1.other', TARGET), (':1.42', TARGET + '_other')):
            await bluez.agent_reply(request(sender, path))
            self.assertIsNone(bluez.prompt)
            self.assertEqual(sent[-1].header.fields[HeaderFields.error_name], 'org.bluez.Error.Rejected')
        task = asyncio.create_task(bluez.agent_reply(request(':1.42', TARGET)))
        await asyncio.sleep(0)
        self.assertEqual(bluez.prompt['value'], '000123')
        with self.assertRaises(ValueError):
            bluez.respond('stale-prompt', True)
        with self.assertRaises(ValueError):
            bluez.respond(bluez.prompt['id'], 'yes')
        self.assertFalse(bluez.answer.done(), 'No automatic confirmation')
        bluez.respond(bluez.prompt['id'], True)
        await task
        self.assertIsNone(bluez.prompt)

    async def test_immediate_scan_cancel_still_releases_discovery(self):
        bluez = Bluez()
        bluez.objects = AsyncMock(return_value={'/org/bluez/hci0': {ADAPTER: {}}})
        bluez.call = AsyncMock(return_value=())
        await bluez.scan()
        await bluez.stop_scan()
        self.assertEqual(sum(call.args[2] == 'StopDiscovery' for call in bluez.call.call_args_list), 1)

    async def test_pair_timeout_sends_device_cancel(self):
        bluez = Bluez()
        bluez.locate = AsyncMock(return_value=TARGET)
        bluez.agent_registered = True
        calls = []
        async def call(path, interface, method, *args, **kwargs):
            calls.append(method)
            if method == 'Pair':
                raise asyncio.TimeoutError()
            return ()
        bluez.call = call
        await bluez.start_pair(PHONE)
        await bluez.pair_task
        self.assertIn('CancelPairing', calls)
        self.assertEqual(bluez.pair['state'], 'error')


if __name__ == '__main__':
    unittest.main()
