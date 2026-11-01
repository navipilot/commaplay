// Copyright (c) 2026 机械小鸽
// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createConnection } from 'node:net';

const base = process.env.TEST_URL ?? 'http://127.0.0.1:18080';
const token = process.env.TEST_TOKEN ?? 'browser-test-only';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
await context.addInitScript(() => {
  // Exercise HTTP-compatible playback even on localhost, which browsers treat as secure.
  Object.defineProperty(window, 'VideoDecoder', { value: undefined });
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const status = async () => (await fetch(`${base}/api/status`)).json();
const waitFor = async (predicate, description) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await status();
    if (predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${description}`);
};

try {
  const initial = await status();
  assert.equal(initial.diagnostics, true);
  assert.equal(initial.receiverReady, false, 'A test stream must never report real receiver readiness');
  await page.goto(`${base}/?token=${encodeURIComponent(token)}`);
  await page.waitForFunction(() => {
    const video = document.querySelector('.mse-video');
    return video && video.videoWidth === 1280 && video.videoHeight === 720 &&
      video.currentTime > .5 && video.getVideoPlaybackQuality().totalVideoFrames > 10;
  }, { timeout: 15000 });
  assert.equal(await page.locator('#diagnostic-label').isVisible(), true);
  await page.waitForTimeout(6000); // Includes SourceBuffer pruning, not only initial playback.
  assert.equal(await page.locator('#error-banner').isVisible(), false);
  const playback = await page.locator('.mse-video').evaluate(video => ({
    width: video.videoWidth, height: video.videoHeight,
    frames: video.getVideoPlaybackQuality().totalVideoFrames,
    currentTime: video.currentTime, error: video.error?.message ?? null,
  }));
  assert.equal(playback.error, null);
  const previousCount = (await status()).inputCount;
  const surface = await page.locator('#surface').boundingBox();
  assert.ok(surface);
  await page.mouse.click(surface.x + surface.width * .25, surface.y + surface.height * .75);
  const touched = await waitFor(state => state.inputCount >= previousCount + 2, 'immediate tap down and up');
  assert.equal(touched.lastInput.type, 'touch');
  assert.equal(touched.lastInput.contacts[0].down, false);
  assert.ok(Math.abs(touched.lastInput.contacts[0].x - .25) < .02);
  assert.ok(Math.abs(touched.lastInput.contacts[0].y - .75) < .02);

  const closeCode = url => page.evaluate(url => new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => { socket.close(); reject(new Error('Expected policy rejection')); }, 5000);
    socket.onclose = event => { clearTimeout(timer); resolve(event.code); };
  }), url);
  const wsBase = base.replace(/^http/, 'ws');
  assert.equal(await closeCode(`${wsBase}/ws?token=wrong`), 1008);
  assert.equal(await closeCode(`${wsBase}/ws?token=${encodeURIComponent(token)}`), 1008, 'Reject a second controller');
  const target = new URL(base);
  const invalidOriginCode = await new Promise((resolve, reject) => {
    const socket = createConnection({ host: target.hostname, port: Number(target.port || 80) });
    let received = Buffer.alloc(0);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Origin rejection timeout')); }, 5000);
    socket.on('error', error => { clearTimeout(timer); reject(error); });
    socket.on('connect', () => socket.write(
      `GET /ws?token=${encodeURIComponent(token)} HTTP/1.1\r\nHost: ${target.host}\r\n` +
      'Origin: http://untrusted.invalid\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'));
    socket.on('data', bytes => {
      received = Buffer.concat([received, bytes]);
      const header = received.indexOf('\r\n\r\n');
      if (header >= 0 && received.length >= header + 8) {
        const frame = received.subarray(header + 4);
        if ((frame[0] & 15) === 8) {
          clearTimeout(timer); socket.destroy(); resolve(frame.readUInt16BE(2));
        }
      }
    });
  });
  assert.equal(invalidOriginCode, 1008, 'Reject a mismatched Origin');

  await page.mouse.move(surface.x + surface.width * .4, surface.y + surface.height * .6);
  await page.mouse.down();
  await waitFor(state => state.lastInput?.contacts?.some(contact => contact.down), 'held contact');
  await page.close();
  await waitFor(state => state.viewers === 0, 'release controller on disconnect');
  const probe = await context.newPage();
  await probe.goto(`${base}/probe.html`);
  const race = await probe.evaluate(({ url, token }) => Promise.all([0, 1].map(() => new Promise((resolve, reject) => {
    const socket = new WebSocket(`${url}/ws?token=${encodeURIComponent(token)}`);
    const timer = setTimeout(() => { socket.close(); reject(new Error('Admission timeout')); }, 5000);
    socket.onmessage = event => {
      if (typeof event.data === 'string' && JSON.parse(event.data).type === 'hello') {
        clearTimeout(timer); resolve('admitted');
        setTimeout(() => socket.close(), 100);
      }
    };
    socket.onclose = event => { clearTimeout(timer); resolve(event.code); };
  }))), { url: wsBase, token });
  assert.deepEqual(race.sort(), [1008, 'admitted']);
  await waitFor(state => state.viewers === 0, 'cleanup after admission race');
  assert.deepEqual(errors, []);
  console.log('Browser check passed:', JSON.stringify(playback), 'tap, disconnect, token, Origin and single-controller admission');
} finally {
  await browser.close();
}
