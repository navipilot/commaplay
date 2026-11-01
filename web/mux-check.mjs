// Copyright (c) 2026 机械小鸽
// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

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
const raw = readFileSync('../testdata/demo.h264');
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
const emit = () => {
  const data = Buffer.concat(frame.flatMap(unit => [Buffer.from([0, 0, 0, 1]), unit]));
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
assert.ok(count >= 60);
console.log(`fMP4 check passed: ffprobe decoded all ${count} H.264 frames at 1280x720.`);
