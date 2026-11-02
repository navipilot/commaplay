// Copyright (c) 2026 机械小鸽
// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const compile = file => ts.transpileModule(readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const protocolUrl = moduleUrl(compile('src/protocol.ts'));
const mp4Url = moduleUrl(compile('src/mp4.ts'));
const protocol = await import(protocolUrl);
const mux = await import(moduleUrl(compile('src/mse.ts')
  .replace(/from ['"]\.\/protocol['"]/, `from '${protocolUrl}'`)
  .replace(/from ['"]\.\/mp4['"]/, `from '${mp4Url}'`)));
const longGop = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:size=1280x720:rate=30',
  '-t', '24', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
  '-g', '900', '-keyint_min', '900', '-sc_threshold', '0', '-x264-params', 'aud=1',
  '-f', 'h264', 'pipe:1'], { maxBuffer: 32 * 1024 * 1024 });
assert.equal(longGop.status, 0, longGop.stderr.toString());
const raw = longGop.stdout;
const starts = [];
for (let i = 0; i + 3 < raw.length; i++) {
  const length = raw[i] === 0 && raw[i + 1] === 0 ?
    (raw[i + 2] === 1 ? 3 : raw[i + 2] === 0 && raw[i + 3] === 1 ? 4 : 0) : 0;
  if (length) { starts.push([i, length]); i += length - 1; }
}
const units = starts.map(([offset, length], i) => raw.subarray(offset + length, starts[i + 1]?.[0] ?? raw.length));
const sps = units.find(unit => (unit[0] & 31) === 7);
const pps = units.find(unit => (unit[0] & 31) === 8);
assert.ok(sps && pps);
const size = unit => Buffer.from([unit.length >> 8, unit.length & 255]);
const config = Buffer.concat([Buffer.from([1, sps[1], sps[2], sps[3], 255, 225]), size(sps), sps,
  Buffer.from([1]), size(pps), pps]);
const packets = [mux.initialization({ width: 1280, height: 720, codecData: config })];
let frame = [];
let picture = false;
let count = 0;
const frames = [];
const emit = () => {
  const data = Buffer.concat(frame.flatMap(unit => [Buffer.from([0, 0, 0, 1]), unit]));
  frames.push({ data: Array.from(data), keyframe: frame.some(unit => (unit[0] & 31) === 5) });
  packets.push(mux.fragment(++count, protocol.annexBToAvcc(data), frame.some(unit => (unit[0] & 31) === 5), (count - 1) * 3000, 3000));
  frame = []; picture = false;
};
for (const unit of units) {
  const kind = unit[0] & 31;
  if (kind === 9 && picture) emit();
  if (kind !== 7 && kind !== 8) frame.push(unit);
  if (kind === 1 || kind === 5) picture = true;
}
if (picture) emit();
const result = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries',
  'stream=width,height,nb_read_frames', '-of', 'json', '-i', 'pipe:0'], {
  input: Buffer.concat(packets), maxBuffer: 4 * 1024 * 1024,
});
assert.equal(result.status, 0, result.stderr.toString());
const stream = JSON.parse(result.stdout).streams[0];
assert.deepEqual(stream, { width: 1280, height: 720, nb_read_frames: String(count) });
assert.equal(count, 720);
assert.equal(frames.filter(frame => frame.keyframe).length, 1, 'Fixture must contain one 24-second GOP');
console.log(`fMP4 check passed: ffprobe decoded all ${count} H.264 frames at 1280x720.`);

const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (/^\/src\/[a-z0-9-]+$/.test(path)) {
    response.setHeader('Content-Type', 'application/javascript');
    response.end(compile(path.slice(1) + '.ts'));
  } else {
    response.setHeader('Content-Type', 'text/html');
    response.end('<div><canvas></canvas></div>');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.addInitScript(() => Object.defineProperty(window, 'VideoDecoder', { value: undefined }));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(async ({ frames, config }) => {
    const { VideoPlayer } = await import('/src/video');
    window.videoErrors = [];
    window.rendered = 0;
    window.keyRequests = 0;
    window.index = 0;
    window.config = { codec: 1, width: 1280, height: 720, codecData: new Uint8Array(config) };
    window.player = new VideoPlayer(document.querySelector('canvas'),
      message => { if (message) videoErrors.push(message); },
      () => rendered++, () => { keyRequests++; index = 0; });
    player.configure(window.config);
    window.sendFrame = () => {
      const frame = frames[index++ % frames.length];
      player.pushFrame({ ...frame, data: new Uint8Array(frame.data), timestampUs: index * 33333 });
    };
    window.feed = setInterval(sendFrame, 33);
  }, { frames, config: Array.from(config) });
  await page.waitForFunction(() => document.querySelector('video')?.currentTime > .3, null, { timeout: 10000 }).catch(async error => {
    throw new Error(`${error.message}; ${JSON.stringify(await page.evaluate(() => ({
      errors: window.videoErrors, requests: window.keyRequests, configured: window.player?.isConfigured,
      video: Array.from(document.querySelectorAll('video'), video => ({
        error: video.error?.message, time: video.currentTime, paused: video.paused,
        buffered: Array.from({ length: video.buffered.length }, (_, index) => [video.buffered.start(index), video.buffered.end(index)]),
      })),
    })))}`);
  });
  await page.evaluate(() => {
    window.originalVideo = document.querySelector('video');
    window.repeatConfig = setInterval(() => player.configure(config), 1000);
  });
  await page.waitForTimeout(18000);
  assert.equal(await page.evaluate(() => document.querySelector('video').buffered.start(0)), 0,
    'Retain the active long GOP: removing its prefix also evicts pictures still needed for playback');
  assert.ok(await page.evaluate(() => document.querySelector('video').currentTime > 15),
    'Long GOP playback must advance past the old three-second pruning boundary');
  assert.equal(await page.evaluate(() => document.querySelector('video') === originalVideo), true,
    'Continuous playback, GOP pruning and repeated identical config must not rebuild the player');
  await page.evaluate(() => { clearInterval(feed); clearInterval(repeatConfig); });
  await page.waitForTimeout(250);
  const tail = await page.evaluate(() => {
    const v = document.querySelector('video');
    return v.buffered.end(v.buffered.length - 1);
  });
  await page.evaluate(() => sendFrame());
  await page.waitForFunction(end => {
    const v = document.querySelector('video');
    return v.buffered.end(v.buffered.length - 1) > end;
  }, tail, { timeout: 1500 });
  const idleRequests = await page.evaluate(() => keyRequests);
  await page.evaluate(() => {
    window.beforeEmptyEnd = document.querySelector('video').buffered.end(0);
    for (let i = 0; i < 10; i++) player.pushFrame({
      keyframe: false, data: new Uint8Array(), timestampUs: (index + i + 1) * 33333,
    });
  });
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => document.querySelector('video').buffered.end(0)),
    await page.evaluate(() => beforeEmptyEnd), 'Empty heartbeat packets must not become MP4 picture samples');
  await page.waitForTimeout(7000);
  assert.equal(await page.evaluate(() => keyRequests), idleRequests,
    'A static screen with no new pictures must not provoke an encoder recovery loop');
  assert.equal(await page.evaluate(() => document.querySelector('video') === originalVideo), true,
    'An idle CarPlay screen must not trigger periodic recovery flicker');
  await page.evaluate(() => { window.feed = setInterval(sendFrame, 33); });
  await page.waitForFunction(() => !document.querySelector('video')?.paused, null, { timeout: 5000 });
  await page.evaluate(() => {
    window.beforeRequests = keyRequests;
    document.querySelector('video').pause();
  });
  await page.waitForTimeout(5000);
  assert.equal(await page.evaluate(() => keyRequests), await page.evaluate(() => beforeRequests),
    'An intentionally paused video must not request keyframes');
  await page.evaluate(() => document.querySelector('video').play());
  await page.waitForFunction(() => {
    const v = document.querySelector('video');
    return v.buffered.end(v.buffered.length - 1) - v.currentTime < 1;
  }, null, { timeout: 8000 });
  await page.evaluate(() => {
    window.beforeRequests = keyRequests;
    window.beforeVideo = document.querySelector('video');
    window.beforeRendered = rendered;
    const video = document.querySelector('video');
    video.currentTime = video.buffered.end(video.buffered.length - 1);
    video.dispatchEvent(new Event('timeupdate'));
    clearInterval(feed);
  });
  await page.waitForTimeout(4000);
  assert.equal(await page.evaluate(() => keyRequests), await page.evaluate(() => beforeRequests));
  assert.equal(await page.evaluate(() => document.querySelector('video') === beforeVideo), true,
    'An exhausted buffer must retain the last picture without requesting keyframes or rebuilding');
  await page.evaluate(() => { window.feed = setInterval(sendFrame, 33); });
  await page.waitForFunction(() => rendered > beforeRendered, null, { timeout: 8000 });
  assert.deepEqual(await page.evaluate(() => videoErrors), []);
  await page.evaluate(() => { clearInterval(feed); player.close(); });
  assert.equal(await page.locator('video').count(), 0);
  console.log('HTTP MSE check passed: sparse last frames, idle screens, bounded backlog and unchanged player.');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
