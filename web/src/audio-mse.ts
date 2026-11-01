// Copyright (c) 2026 机械小鸽; SPDX-License-Identifier: GPL-3.0-only
import { ascii, box, full, integer, join, u16, u32, zero } from './mp4';
import type { AudioConfigMessage, AudioPacketMessage } from './protocol';
import { AudioCodec } from './protocol';
import { opusDurationMs, opusFragment, opusInitialization } from './audio-webm';

export function audioInitialization(config: AudioConfigMessage): Uint8Array<ArrayBuffer> {
  if (!config.description.length || config.description.length > 32 ||
      ![44100, 48000].includes(config.sampleRate) || ![1, 2].includes(config.channels)) {
    throw new Error('Unsupported AAC configuration');
  }
  const descriptor = (tag: number, data: Uint8Array) => join(integer(1, tag), integer(1, data.length), data);
  const esds = full('esds', 0, 0, descriptor(3, join(u16(1), zero(1),
    descriptor(4, join(new Uint8Array([0x40, 0x15]), zero(3), u32(256000), u32(128000),
      descriptor(5, config.description))), descriptor(6, new Uint8Array([2])))));
  const sample = box('mp4a', zero(6), u16(1), zero(8), u16(config.channels), u16(16),
    zero(4), u32(config.sampleRate * 65536), esds);
  const matrix = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].map(u32);
  const table = box('stbl', full('stsd', 0, 0, u32(1), sample), full('stts', 0, 0, u32(0)),
    full('stsc', 0, 0, u32(0)), full('stsz', 0, 0, u32(0), u32(0)), full('stco', 0, 0, u32(0)));
  const media = box('mdia', full('mdhd', 0, 0, u32(0), u32(0), u32(config.sampleRate), u32(0), u16(0x55c4), u16(0)),
    full('hdlr', 0, 0, u32(0), ascii('soun'), zero(12), ascii('CommaPlay audio'), zero(1)),
    box('minf', full('smhd', 0, 0, zero(4)), box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))), table));
  const track = box('trak', full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(0),
    zero(8), zero(4), u16(0x100), zero(2), ...matrix, zero(8)), media);
  return join(box('ftyp', ascii('isom'), u32(512), ascii('isomiso6mp41')),
    box('moov', full('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(0), u32(0x10000), u16(0x100),
      zero(10), ...matrix, zero(24), u32(2)), track,
    box('mvex', full('trex', 0, 0, u32(1), u32(1), u32(1024), u32(0), u32(0)))));
}

export function audioFragment(sequence: number, time: number, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const header = (offset: number) => box('moof', full('mfhd', 0, 0, u32(sequence)),
    box('traf', full('tfhd', 0, 0x020000, u32(1)), full('tfdt', 1, 0, integer(8, time)),
      full('trun', 0, 0x301, u32(1), u32(offset), u32(1024), u32(data.length))));
  return join(header(header(0).length + 8), box('mdat', data));
}

/** Remux AAC/fMP4 and Opus/WebM for native HTTP playback without WebCodecs. */
export class MseAudio {
  readonly element = document.createElement('audio');
  private readonly source: MediaSource;
  private readonly node: MediaElementAudioSourceNode;
  private readonly url: string;
  private buffer: SourceBuffer | null = null;
  private queue: Uint8Array<ArrayBuffer>[] = [];
  private bytes = 0;
  private sequence = 0;
  private origin: number | null = null;
  private nextTime = 0;
  private closed = false;
  private timer = 0;
  private prunedUntil = 0;
  private readonly deadline = performance.now() + 5000;
  blocked = false;

  constructor(private readonly config: AudioConfigMessage, context: AudioContext, gain: GainNode,
    private readonly onError: (message: string) => void, private readonly onPlaybackState: () => void = () => {}) {
    const opus = config.codec === AudioCodec.Opus;
    const mime = opus ? 'audio/webm; codecs="opus"' : 'audio/mp4; codecs="mp4a.40.2"';
    if (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported(mime)) {
      throw new Error(`This browser cannot decode ${opus ? 'Opus' : 'AAC'} through MSE`);
    }
    const initialization = opus ? opusInitialization(config) : audioInitialization(config);
    this.source = new MediaSource();
    this.url = URL.createObjectURL(this.source);
    this.element.src = this.url;
    this.element.className = 'mse-audio';
    this.element.hidden = true;
    document.body.append(this.element);
    this.node = context.createMediaElementSource(this.element);
    this.node.connect(gain);
    this.enqueue(initialization);
    this.element.addEventListener('error', () => this.fail('浏览器音频解码失败，请重新连接。'));
    this.element.addEventListener('playing', () => {
      this.blocked = false;
      this.onPlaybackState();
    });
    this.source.addEventListener('sourceopen', () => {
      if (this.closed) return;
      try {
        this.buffer = this.source.addSourceBuffer(mime);
        this.buffer.addEventListener('updateend', () => this.pump());
        this.buffer.addEventListener('error', () => this.fail('音频缓冲解码失败，请重新连接。'));
        this.pump();
      } catch { this.fail('浏览器音频缓冲不可用'); }
    }, { once: true });
    this.timer = window.setInterval(() => {
      if (this.closed) return;
      if (!this.buffer) {
        if (performance.now() > this.deadline) this.fail('浏览器音频启动超时');
        return;
      }
      if (this.element.buffered.length) {
        const end = this.element.buffered.end(this.element.buffered.length - 1);
        if (end - this.element.currentTime > .7) this.element.currentTime = Math.max(0, end - .2);
      }
      this.pump();
    }, 500);
  }

  unlock(): void {
    if (this.closed) return;
    void this.element.play().catch(error => {
      if (this.closed) return;
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        this.blocked = true;
        this.onPlaybackState();
      } else if (!(error instanceof DOMException && error.name === 'AbortError')) {
        this.onError('浏览器音频播放失败，请重新连接画面。');
      }
    });
  }

  push(message: AudioPacketMessage): void {
    if (this.closed) return;
    if (this.origin === null) this.origin = message.timestampUs;
    if (this.config.codec === AudioCodec.Opus) {
      try {
        const time = Math.max(this.nextTime, (message.timestampUs - this.origin) / 1000);
        this.nextTime = time + opusDurationMs(message.data);
        this.enqueue(opusFragment(time, message.data));
      } catch (error) { this.fail(`Opus packet rejected: ${String(error)}`); }
      return;
    }
    const time = Math.max(this.nextTime, Math.round((message.timestampUs - this.origin) * this.config.sampleRate / 1_000_000));
    this.nextTime = time + 1024;
    this.enqueue(audioFragment(++this.sequence, time, message.data));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.queue = []; this.bytes = 0;
    this.element.pause();
    this.node.disconnect();
    this.element.removeAttribute('src');
    this.element.load();
    this.element.remove();
    URL.revokeObjectURL(this.url);
  }

  private enqueue(data: Uint8Array<ArrayBuffer>): void {
    if (this.queue.length >= 64 || this.bytes + data.length > 512 * 1024) {
      this.fail('Audio playback backlog exceeded; reconnect the viewer');
      return;
    }
    this.queue.push(data); this.bytes += data.length; this.pump();
  }

  private pump(): void {
    if (this.closed || !this.buffer || this.buffer.updating) return;
    const trim = this.element.currentTime - 3;
    if (trim > 0 && trim > this.prunedUntil + 1) {
      this.prunedUntil = trim;
      try { this.buffer.remove(0, trim); } catch { this.fail('音频缓冲清理失败'); }
      return;
    }
    if (!this.queue.length) return;
    const data = this.queue.shift()!;
    this.bytes -= data.length;
    try { this.buffer.appendBuffer(data); } catch { this.fail('音频缓冲写入失败'); }
  }

  private fail(message: string): void {
    if (this.closed) return;
    this.close();
    this.onError(message);
  }
}
