// Copyright (c) 2026 机械小鸽; SPDX-License-Identifier: GPL-3.0-only
import { integer, join } from './mp4';
import type { AudioConfigMessage } from './protocol';

const element = (id: number[], data: Uint8Array): Uint8Array<ArrayBuffer> => {
  let width = 1;
  while (data.length >= 2 ** (7 * width) - 1) width++;
  return join(new Uint8Array(id), integer(width, data.length + 2 ** (7 * width)), data);
};
const number = (id: number[], value: number, width = 1) => element(id, integer(width, value));
const text = (id: number[], value: string) => element(id, new TextEncoder().encode(value));

export function opusInitialization(config: AudioConfigMessage): Uint8Array<ArrayBuffer> {
  if (![1, 2].includes(config.channels) || ![8000, 12000, 16000, 24000, 48000].includes(config.sampleRate)) {
    throw new Error('Unsupported Opus configuration');
  }
  const head = new Uint8Array(19);
  head.set(new TextEncoder().encode('OpusHead'));
  head[8] = 1; head[9] = config.channels;
  new DataView(head.buffer).setUint32(12, config.sampleRate, true);
  const rate = new Uint8Array(8);
  new DataView(rate.buffer).setFloat64(0, 48000);
  const header = element([0x1a, 0x45, 0xdf, 0xa3], join(
    number([0x42, 0x86], 1), number([0x42, 0xf7], 1), number([0x42, 0xf2], 4),
    number([0x42, 0xf3], 8), text([0x42, 0x82], 'webm'), number([0x42, 0x87], 4), number([0x42, 0x85], 2)));
  const info = element([0x15, 0x49, 0xa9, 0x66], join(number([0x2a, 0xd7, 0xb1], 1000000, 3),
    text([0x4d, 0x80], 'CommaPlay'), text([0x57, 0x41], 'CommaPlay')));
  const track = element([0xae], join(number([0xd7], 1), number([0x73, 0xc5], 1), number([0x83], 2),
    text([0x86], 'A_OPUS'), element([0x63, 0xa2], head),
    number([0x56, 0xaa], 0), number([0x56, 0xbb], 80000000, 4),
    element([0xe1], join(element([0xb5], rate), number([0x9f], config.channels)))));
  return join(header, new Uint8Array([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
    info, element([0x16, 0x54, 0xae, 0x6b], track));
}

export function opusDurationMs(data: Uint8Array): number {
  if (!data.length) throw new Error('Empty Opus packet');
  const config = data[0] >> 3;
  const frame = config >= 16 ? 2.5 * 2 ** (config & 3) : config >= 12 ? 10 * 2 ** (config & 1) :
    (config & 3) === 3 ? 60 : 10 * 2 ** (config & 3);
  const code = data[0] & 3;
  const count = code === 0 ? 1 : code === 3 ? (data[1] ?? 0) & 63 : 2;
  if (!count || frame * count > 120) throw new Error('Invalid Opus packet duration');
  return frame * count;
}

export function opusFragment(timeMs: number, data: Uint8Array): Uint8Array<ArrayBuffer> {
  return element([0x1f, 0x43, 0xb6, 0x75], join(number([0xe7], Math.round(timeMs), 8),
    element([0xa3], join(new Uint8Array([0x81, 0, 0, 0x80]), data))));
}
