/**
 * VideoPool media-error path tests (media error finding):
 * - an 'error' event on a loaded slot clears its URL (so the next apply()
 *   reloads a — possibly refreshed — presigned URL) and notifies the engine
 * - the clear/notify is throttled per slot (no load/error storm on a
 *   permanently broken URL)
 * - teardown/no-src error noise is ignored
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeVideoElement {
  src = '';
  paused = true;
  crossOrigin = '';
  preload = '';
  playsInline = false;
  muted = false;
  readyState = 0;
  currentTime = 0;
  private listeners = new Map<string, Set<() => void>>();

  pause(): void {
    this.paused = true;
  }
  load(): void {}
  removeAttribute(): void {}
  addEventListener(type: string, cb: () => void): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(cb);
  }
  removeEventListener(type: string, cb: () => void): void {
    this.listeners.get(type)?.delete(cb);
  }
  fire(type: string): void {
    for (const cb of [...(this.listeners.get(type) ?? [])]) cb();
  }
}

(globalThis as Record<string, unknown>)['document'] = {
  createElement: (): FakeVideoElement => new FakeVideoElement(),
};
(globalThis as Record<string, unknown>)['HTMLMediaElement'] = {
  HAVE_METADATA: 1,
  HAVE_CURRENT_DATA: 2,
};

import { VideoPool } from './videoPool';

const URL_A = 'https://r2/proxy-a.mp4';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function loadedPool(onError: (slot: unknown) => void): VideoPool {
  const pool = new VideoPool(2, undefined, onError);
  pool.apply([{ slot: 0, clipId: 'c1', assetId: 'a1' }], () => URL_A);
  return pool;
}

describe('VideoPool media error handling', () => {
  it('clears the slot URL and notifies once; next apply() reloads the URL', () => {
    const onError = vi.fn();
    const pool = loadedPool(onError);
    const slot = pool.slots[0]!;
    expect(slot.url).toBe(URL_A);
    const epochBefore = slot.epoch;

    (slot.video as unknown as FakeVideoElement).fire('error');

    expect(slot.url).toBe(''); // forgotten -> re-appliable
    expect(slot.epoch).toBe(epochBefore + 1); // stale async callbacks fenced off
    expect(onError).toHaveBeenCalledTimes(1);

    // The retry (engine: next tick refreshPool -> apply) re-loads the URL.
    const changed = pool.apply([{ slot: 0, clipId: 'c1', assetId: 'a1' }], () => URL_A);
    expect(changed).toContain(slot);
    expect(slot.url).toBe(URL_A);
    expect(slot.video.src).toBe(URL_A);
  });

  it('throttles per slot: a rapid second error neither clears nor notifies', () => {
    const onError = vi.fn();
    const pool = loadedPool(onError);
    const slot = pool.slots[0]!;
    const video = slot.video as unknown as FakeVideoElement;

    video.fire('error');
    pool.apply([{ slot: 0, clipId: 'c1', assetId: 'a1' }], () => URL_A); // retry

    video.fire('error'); // same broken URL errors again immediately
    expect(onError).toHaveBeenCalledTimes(1); // throttled
    expect(slot.url).toBe(URL_A); // kept -> apply() will NOT reload-spam

    vi.advanceTimersByTime(6_000); // past MEDIA_ERROR_RETRY_MIN_MS
    video.fire('error');
    expect(onError).toHaveBeenCalledTimes(2);
    expect(slot.url).toBe('');
  });

  it('ignores error noise on slots without a URL (teardown/empty src)', () => {
    const onError = vi.fn();
    const pool = new VideoPool(1, undefined, onError);
    (pool.slots[0]!.video as unknown as FakeVideoElement).fire('error');
    expect(onError).not.toHaveBeenCalled();
  });
});
