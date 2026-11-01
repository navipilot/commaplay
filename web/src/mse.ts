// Copyright (c) 2026 机械小鸽
// SPDX-License-Identifier: GPL-3.0-only
// fMP4 layout adapted from map2tesla's usb_carplay_player.html (GPLv3).
import { annexBToAvcc, avcCodecString, type VideoConfigMessage, type VideoFrameMessage } from './protocol';
import { join, ascii, zero, integer, u16, u32, box, full } from './mp4';

export function initialization(config: VideoConfigMessage): Uint8Array<ArrayBuffer> {
  const matrix = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].map(u32);
  const sample = box('avc1', zero(6), u16(1), zero(16), u16(config.width), u16(config.height),
    u32(0x480000), u32(0x480000), u32(0), u16(1), zero(32), u16(24), u16(65535), box('avcC', config.codecData));
  const table = box('stbl', full('stsd', 0, 0, u32(1), sample), full('stts', 0, 0, u32(0)),
    full('stsc', 0, 0, u32(0)), full('stsz', 0, 0, u32(0), u32(0)), full('stco', 0, 0, u32(0)));
  const media = box('mdia', full('mdhd', 0, 0, u32(0), u32(0), u32(90000), u32(0), u16(0x55c4), u16(0)),
    full('hdlr', 0, 0, u32(0), ascii('vide'), zero(12), ascii('CommaPlay'), zero(1)),
    box('minf', full('vmhd', 0, 1, zero(8)), box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))), table));
  const track = box('trak', full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(0),
    zero(8), zero(8), ...matrix, u32(config.width * 65536), u32(config.height * 65536)), media);
  return join(box('ftyp', ascii('isom'), u32(512), ascii('isomiso6mp41')),
    box('moov', full('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(0), u32(0x10000), u16(0x100),
      zero(10), ...matrix, zero(24), u32(2)), track,
    box('mvex', full('trex', 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0)))));
}

export function fragment(sequence: number, data: Uint8Array, key: boolean, time: number, duration: number): Uint8Array<ArrayBuffer> {
  const header = (offset: number) => box('moof', full('mfhd', 0, 0, u32(sequence)),
    box('traf', full('tfhd', 0, 0x020000, u32(1)), full('tfdt', 1, 0, integer(8, time)),
      full('trun', 0, 0x701, u32(1), u32(offset), u32(duration), u32(data.length), u32(key ? 0x02000000 : 0x01010000))));
  return join(header(header(0).length + 8), box('mdat', data));
}

/** Browser-side remux only; the comma never decodes or re-encodes this video. */
export class MsePlayer {
  private readonly video = document.createElement('video');
  private source: MediaSource | null = null;
  private buffer: SourceBuffer | null = null;
  private url = '';
  private queue: Uint8Array<ArrayBuffer>[] = [];
  private queuedBytes = 0;
  private previous: VideoFrameMessage | null = null;
  private needsKey = true;
  private sequence = 0;
  private time = 0;
  private closed = false;
  private timer = 0;
  private lastKeyRequest = -Infinity;
  private prunedUntil = 0;
  private cancelOpen: (() => void) | null = null;
  ready = false;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly onFrame: () => void,
    private readonly onError: (message: string) => void, private readonly requestKey: () => void) {
    this.video.muted = true;
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.className = 'mse-video';
    this.video.addEventListener('error', () => this.fail('MSE video playback failed'));
    this.video.addEventListener('timeupdate', () => this.onFrame());
    canvas.parentElement?.append(this.video);
  }

  async configure(config: VideoConfigMessage): Promise<void> {
    const mime = `video/mp4; codecs="${avcCodecString(config.codecData)}"`;
    if (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported(mime)) {
      throw new Error('This browser cannot play H.264 through MSE. A compatible Tesla browser is required.');
    }
    this.source = new MediaSource();
    this.url = URL.createObjectURL(this.source);
    this.video.src = this.url;
    await new Promise<void>((resolve, reject) => {
      const source = this.source!;
      const finish = () => {
        clearTimeout(timer);
        source.removeEventListener('sourceopen', open);
        this.cancelOpen = null;
      };
      const open = () => { finish(); resolve(); };
      const timer = window.setTimeout(() => { finish(); reject(new Error('MSE startup timed out')); }, 5000);
      this.cancelOpen = () => { finish(); reject(new Error('MSE startup cancelled')); };
      source.addEventListener('sourceopen', open, { once: true });
    });
    if (this.closed) return;
    this.buffer = this.source.addSourceBuffer(mime);
    this.buffer.addEventListener('updateend', () => this.pump());
    this.buffer.addEventListener('error', () => this.fail('MSE SourceBuffer failed'));
    this.queue.push(initialization(config));
    this.queuedBytes = this.queue[0].length;
    this.canvas.width = config.width;
    this.canvas.height = config.height;
    this.ready = true;
    this.pump();
    void this.video.play().catch(error => this.onError(`Browser playback blocked: ${String(error)}`));
    this.timer = window.setInterval(() => {
      if (this.closed || !this.video.buffered.length) return;
      const lag = this.video.buffered.end(this.video.buffered.length - 1) - this.video.currentTime;
      this.video.playbackRate = lag > .2 ? 1.08 : 1;
      if (lag > .45) {
        const end = this.video.buffered.end(this.video.buffered.length - 1);
        this.video.currentTime = Math.max(this.video.buffered.start(this.video.buffered.length - 1), end - .12);
      }
      this.pump();
    }, 100);
    this.onError('');
  }

  push(message: VideoFrameMessage): void {
    if (!this.ready || this.closed) return;
    if (this.needsKey && !message.keyframe) {
      const now = performance.now();
      if (now - this.lastKeyRequest > 1000) { this.lastKeyRequest = now; this.requestKey(); }
      return;
    }
    this.needsKey = false;
    const previous = this.previous;
    this.previous = message;
    if (!previous) return;
    const duration = Math.round(Math.max(1_000, Math.min(200_000, message.timestampUs - previous.timestampUs || 33_333)) * .09);
    const bytes = fragment(++this.sequence, annexBToAvcc(previous.data), previous.keyframe, this.time, duration);
    this.time += duration;
    if (this.queue.length >= 32 || this.queuedBytes + bytes.length > 4 * 1024 * 1024) {
      this.fail('MSE client is too slow; refresh the video to restart at a keyframe');
      return;
    }
    this.queue.push(bytes);
    this.queuedBytes += bytes.length;
    this.pump();
  }

  private pump(): void {
    if (!this.buffer || this.buffer.updating || this.closed) return;
    const trim = this.video.currentTime - 3;
    if (trim > 0 && trim > this.prunedUntil + 1) {
      this.prunedUntil = trim;
      try { this.buffer.remove(0, trim); } catch (error) {
        this.fail(`MSE buffer cleanup failed: ${String(error)}`);
      }
      return;
    }
    if (!this.queue.length) return;
    const bytes = this.queue.shift()!;
    this.queuedBytes = Math.max(0, this.queuedBytes - bytes.length);
    try { this.buffer.appendBuffer(bytes); } catch (error) { this.fail(`MSE append failed: ${String(error)}`); }
  }

  private fail(message: string): void {
    if (this.closed) return;
    this.close();
    this.onError(message);
    this.requestKey();
  }

  close(): void {
    this.closed = true;
    this.ready = false;
    this.cancelOpen?.();
    clearInterval(this.timer);
    this.queue = [];
    this.previous = null;
    this.video.removeAttribute('src');
    this.video.load();
    this.video.remove();
    if (this.url) URL.revokeObjectURL(this.url);
  }
}
