// Copyright (c) 2026 机械小鸽; SPDX-License-Identifier: GPL-3.0-only
export async function checkReceiver(): Promise<boolean> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch('/api/status', { cache: 'no-store', signal: controller.signal });
    if (!response.ok) return false;
    const status = await response.json() as { sessionActive?: boolean; diagnostics?: boolean };
    return status.sessionActive === true || status.diagnostics === true;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timeout);
  }
}

export function openDebug(reason: string): void {
  location.replace(`/debug.html?reason=${encodeURIComponent(reason)}`);
}
