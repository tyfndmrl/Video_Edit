/**
 * media-urls sync tests (intersection contract B):
 * - patches ALL derivative url fields into assetStore (proxy, poster,
 *   filmstrip, filmstripManifest, waveform, sprites)
 * - forceRefreshMediaUrls(): immediate refetch, throttled, no-op without an
 *   active sync
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../entities/apiClient', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '../../entities/apiClient';
import { useAssetStore, type AssetSummary } from '../../state/assetStore';
import { forceRefreshMediaUrls, startMediaUrlSync } from './mediaUrls';

const apiFetchMock = vi.mocked(apiFetch);

const SPRITES = { 'filmstrip-0000.jpg': 'https://cdn/s0', 'filmstrip-0001.jpg': 'https://cdn/s1' };

function response(expiresInMs = 12 * 60 * 60 * 1000) {
  return {
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    assets: {
      a1: {
        original: 'https://cdn/original',
        proxy: 'https://cdn/proxy',
        filmstrip: 'https://cdn/filmstrip',
        filmstripManifest: 'https://cdn/manifest',
        waveform: 'https://cdn/waveform',
        poster: 'https://cdn/poster',
        sprites: SPRITES,
      },
    },
  };
}

function seedAsset(): void {
  const asset: AssetSummary = { id: 'a1', kind: 'video', name: 'clip.mp4', status: 'ready' };
  useAssetStore.getState().setAssets([asset]);
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

let stop: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  apiFetchMock.mockReset();
  seedAsset();
});

afterEach(() => {
  stop?.();
  stop = null;
  useAssetStore.getState().setAssets([]);
  vi.useRealTimers();
});

describe('startMediaUrlSync — full field coverage (contract B)', () => {
  it('patches proxy, poster, filmstrip, filmstripManifest, waveform AND sprites', async () => {
    apiFetchMock.mockResolvedValue(response());
    stop = startMediaUrlSync('p1');
    await flushMicrotasks();

    const asset = useAssetStore.getState().getAsset('a1')!;
    expect(asset.proxyUrl).toBe('https://cdn/proxy');
    expect(asset.posterUrl).toBe('https://cdn/poster');
    expect(asset.filmstripUrl).toBe('https://cdn/filmstrip');
    expect(asset.filmstripManifestUrl).toBe('https://cdn/manifest');
    expect(asset.waveformUrl).toBe('https://cdn/waveform');
    expect(asset.sprites).toEqual(SPRITES);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledWith('/api/projects/p1/media-urls');
  });
});

describe('forceRefreshMediaUrls (contract B: player media-error path)', () => {
  it('refetches immediately but is throttled against error storms', async () => {
    apiFetchMock.mockResolvedValue(response());
    stop = startMediaUrlSync('p1');
    await flushMicrotasks();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);

    // Within the 5 s window: throttled, no extra request.
    forceRefreshMediaUrls();
    await flushMicrotasks();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);

    // Past the window: refetches.
    await vi.advanceTimersByTimeAsync(6_000);
    forceRefreshMediaUrls();
    await flushMicrotasks();
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });

  it('is a no-op after the sync stopped (and never throws without one)', async () => {
    apiFetchMock.mockResolvedValue(response());
    const stopNow = startMediaUrlSync('p1');
    await flushMicrotasks();
    stopNow();

    await vi.advanceTimersByTimeAsync(10_000);
    forceRefreshMediaUrls();
    await flushMicrotasks();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });
});
