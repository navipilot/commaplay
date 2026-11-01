#!/usr/bin/env python3
"""Private Unix-socket broker for authenticated, stationary browser setup."""
# Copyright (c) 2026 机械小鸽
# SPDX-License-Identifier: GPL-3.0-only
import argparse
import asyncio
from contextlib import suppress
import json
import os
from pathlib import Path
import signal

from bluetooth_policy import Lease, address, client_id, selected_phone, select_phone, stationary
from bluez_client import Bluez


class Broker:
    def __init__(self, root, state_file, bluez=None, clock=None):
        self.root = Path(root)
        self.state_file = Path(state_file)
        self.bluez = bluez or Bluez()
        self.lease = Lease() if clock is None else Lease(clock)
        self.lock = asyncio.Lock()
        self.radio_task = None
        self.radio_state = 'idle'

    async def snapshot(self, client):
        self.lease.heartbeat(client, 90 if self.bluez.target else 15)
        try:
            result = await self.bluez.snapshot()
            result['available'] = True
        except Exception:
            result = {'available': False, 'adapters': [], 'devices': [], 'pair': {'state': 'idle'}, 'prompt': None, 'scanning': False}
        result.update(safety=stationary(self.state_file), selectedPhone=selected_phone(self.root),
                      owned=self.lease.owner == client, busy=self.lease.owner is not None and self.lease.owner != client,
                      radioState=self.radio_state)
        return result

    async def stop(self):
        await self.bluez.cancel_pair()
        await self.bluez.stop_scan()
        if self.radio_task and not self.radio_task.done():
            self.radio_task.cancel()
            with suppress(asyncio.CancelledError):
                await self.radio_task
        self.lease.release()

    async def radio(self):
        if self.radio_task and not self.radio_task.done():
            return
        if Path('/sys/class/bluetooth/hci0').exists():
            self.radio_state = 'ready'
            return
        self.radio_state = 'starting'

        async def initialize():
            process = None
            try:
                process = await asyncio.create_subprocess_exec('sudo', '-n', str(self.root / 'deploy/start-radio.sh'),
                    stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
                await asyncio.wait_for(process.wait(), 80)
                self.radio_state = 'ready' if process.returncode == 0 else 'error'
            except asyncio.CancelledError:
                self.radio_state = 'cancelled'
                stop = await asyncio.create_subprocess_exec('sudo', '-n', 'systemctl', 'stop', '--no-block', 'commaplay-bluetooth-radio.service',
                    stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
                with suppress(Exception):
                    await asyncio.wait_for(stop.wait(), 5)
                raise
            except Exception:
                self.radio_state = 'error'
            finally:
                if process and process.returncode is None:
                    process.kill()
                    await process.wait()
        self.radio_task = asyncio.create_task(initialize())

    async def request(self, body):
        if not isinstance(body, dict) or set(body) - {'operation', 'client', 'address', 'promptId', 'value'}:
            raise ValueError('invalid request fields')
        operation = body.get('operation')
        client = client_id(body.get('client'))
        if operation == 'status':
            return await self.snapshot(client)
        async with self.lock:
            if operation == 'cancel':
                if self.lease.owner is not None and self.lease.owner != client:
                    raise ValueError('another debug page owns setup')
                await self.stop()
                return {'cancelled': True}
            if operation not in ('radio', 'scan', 'pair', 'answer', 'select'):
                raise ValueError('unsupported operation')
            if not stationary(self.state_file)['allowed']:
                raise ValueError('fresh_stationary_disengaged_state_required')
            if operation == 'answer':
                if self.lease.owner != client:
                    raise ValueError('pairing session expired')
                self.bluez.respond(body.get('promptId'), body.get('value'))
                return {'answered': True}
            mac = address(body.get('address')) if operation in ('pair', 'select') else None
            self.lease.acquire(client)
            try:
                if operation == 'radio':
                    if self.bluez.target:
                        raise ValueError('cancel pairing before initializing radio')
                    await self.radio()
                elif operation == 'scan':
                    if self.bluez.target:
                        raise ValueError('pairing already in progress')
                    await self.bluez.scan()
                elif operation == 'pair':
                    await self.bluez.start_pair(mac)
                    self.lease.heartbeat(client, 90)
                elif operation == 'select':
                    devices = (await self.bluez.snapshot())['devices']
                    if not any(device['address'].upper() == mac and device['paired'] for device in devices):
                        raise ValueError('pair this iPhone before selecting it')
                    select_phone(self.root, mac)
                return {'accepted': True}
            except Exception:
                if not self.bluez.target and not (self.bluez.scan_task and not self.bluez.scan_task.done()) and not (self.radio_task and not self.radio_task.done()):
                    self.lease.release()
                raise

    async def watchdog(self):
        while True:
            await asyncio.sleep(.5)
            if self.lease.owner and (self.lease.expired() or not stationary(self.state_file)['allowed']):
                async with self.lock:
                    await self.stop()

    async def connection(self, reader, writer):
        try:
            line = await asyncio.wait_for(reader.readline(), 3)
            if not line.endswith(b'\n') or len(line) > 4096:
                raise ValueError('request too large')
            data = await self.request(json.loads(line))
            result = {'ok': True, 'data': data}
        except (ValueError, TypeError, KeyError, json.JSONDecodeError) as error:
            result = {'ok': False, 'error': str(error)[:250], 'status': 409}
        except Exception:
            result = {'ok': False, 'error': 'Bluetooth operation unavailable', 'status': 503}
        try:
            encoded = json.dumps(result, ensure_ascii=True).encode() + b'\n'
            if len(encoded) > 65536:
                encoded = b'{"ok":false,"error":"Bluetooth response too large","status":503}\n'
            writer.write(encoded)
            await asyncio.wait_for(writer.drain(), 3)
        finally:
            writer.close()
            with suppress(Exception):
                await writer.wait_closed()


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--socket', type=Path, default=Path('/run/commaplay-bluetooth/web.sock'))
    parser.add_argument('--vehicle-state', type=Path, default=Path('/dev/shm/carrot-bluetooth/status.json'))
    args = parser.parse_args()
    os.umask(0o077)
    args.socket.unlink(missing_ok=True)
    broker = Broker(args.root, args.vehicle_state)
    stopped = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stopped.set)
    server = await asyncio.start_unix_server(broker.connection, str(args.socket), limit=4096)
    watchdog = asyncio.create_task(broker.watchdog())
    try:
        async with server:
            await stopped.wait()
    finally:
        watchdog.cancel()
        with suppress(asyncio.CancelledError):
            await watchdog
        await broker.stop()
        await broker.bluez.close()
        args.socket.unlink(missing_ok=True)


if __name__ == '__main__':
    asyncio.run(main())
