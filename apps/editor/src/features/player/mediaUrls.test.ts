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

describe('reaktif yenileme — throttle ERTELER, DÜŞÜRMEZ', () => {
  /**
   * Regresyon: asset, son media-urls isteğinden < 5 sn sonra "ready" olursa
   * reaktif yenileme throttle'a takılıyordu ve DÜŞÜYORDU. Asset listesi anketi
   * (useProjectAssets) hiçbir asset işlenmiyorken DURDUĞU için "ready" yazan
   * güncelleme store'un SON değişimidir: düşen istek bir daha tetiklenmez,
   * proje 12 saat boyunca URL'siz kalır (filmstrip çizilmez, oynatıcı siyah).
   * Küçük dosya + sıcak worker'da ready ~4 sn'de geliyor, yani nadir değil.
   */
  it('throttle penceresi İÇİNDE ready olan asset\'in URL\'leri yine de iner', async () => {
    // Sunucu yalnız READY asset döndürür: ilk yanıt boştur.
    apiFetchMock.mockResolvedValueOnce({
      expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
      assets: {},
    });
    apiFetchMock.mockResolvedValue(response());
    useAssetStore
      .getState()
      .setAssets([{ id: 'a1', kind: 'video', name: 'clip.mp4', status: 'processing' }]);

    stop = startMediaUrlSync('p1');
    await flushMicrotasks();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);

    // Pencere KAPALIYKEN ready olur — ve bu, store'un son değişimidir.
    await vi.advanceTimersByTimeAsync(1_000);
    useAssetStore.getState().updateAsset('a1', { status: 'ready' });
    await flushMicrotasks();
    expect(apiFetchMock, 'pencere içinde ANINDA istek atılmamalı (throttle)').toHaveBeenCalledTimes(
      1,
    );

    // Pencere açılınca ERTELENEN istek gider: store bir daha değişmese bile.
    await vi.advanceTimersByTimeAsync(5_000);
    await flushMicrotasks();
    expect(apiFetchMock, 'ertelenen reaktif yenileme hiç gitmedi').toHaveBeenCalledTimes(2);
    const asset = useAssetStore.getState().getAsset('a1')!;
    expect(asset.proxyUrl).toBe('https://cdn/proxy');
    expect(asset.filmstripManifestUrl).toBe('https://cdn/manifest');
  });

  it('erteleme yeniden deneme fırtınasına dönüşmez', async () => {
    // Yanıt asset'i HİÇ getirmezse bile istek başına TEK fetch yapılır.
    apiFetchMock.mockResolvedValue({
      expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
      assets: {},
    });
    useAssetStore
      .getState()
      .setAssets([{ id: 'a1', kind: 'video', name: 'clip.mp4', status: 'processing' }]);

    stop = startMediaUrlSync('p1');
    await flushMicrotasks();
    useAssetStore.getState().updateAsset('a1', { status: 'ready' });
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();
    // 1 = açılış, 2 = ertelenen reaktif yenileme. Sonrası SESSİZ.
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
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
