// Copyright (c) 2026 机械小鸽; SPDX-License-Identifier: GPL-3.0-only
// Box helpers retained from the map2tesla-adapted video remuxer.
export const join = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
};
export const ascii = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);
export const zero = (size: number): Uint8Array<ArrayBuffer> => new Uint8Array(size);
export function integer(size: number, value: number): Uint8Array<ArrayBuffer> {
  const bytes = zero(size);
  for (let i = size - 1; i >= 0; i--) { bytes[i] = value % 256; value = Math.floor(value / 256); }
  return bytes;
}
export const u16 = (value: number) => integer(2, value);
export const u32 = (value: number) => integer(4, value);
export const box = (name: string, ...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const data = join(...parts);
  return join(u32(data.length + 8), ascii(name), data);
};
export const full = (name: string, version: number, flags: number, ...parts: Uint8Array[]) =>
  box(name, integer(1, version), integer(3, flags), ...parts);
