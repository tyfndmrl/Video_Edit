/**
 * mediaCache — true-LRU byte-budget eviction and stable assetId keying
 * (M2 chief-architect finding 9): the presigned URL is only a fetch parameter,
 * so a rotated URL for the same asset must HIT the cache, and eviction drops
 * the least-recently-USED entry (get refreshes recency).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LruCache,
  clearMediaCaches,
  getFilmstripManifest,
  setMediaCacheInvalidator,
  type FilmstripManifest,
} from './mediaCache';

describe('LruCache byte budget', () => {
  it('evicts the OLDEST entries once the byte budget is exceeded', () => {
    const lru = new LruCache<string>({ maxBytes: 100 });
    lru.set('a', 'A', 40);
    lru.set('b', 'B', 40);
    lru.set('c', 'C', 40); // 120 > 100 -> 'a' (oldest) goes
    expect(lru.has('a')).toBe(false);
    expect(lru.has('b')).toBe(true);
    expect(lru.has('c')).toBe(true);
    expect(lru.bytes).toBe(80);
  });

  it('get() refreshes recency — a recently READ entry survives eviction', () => {
    const lru = new LruCache<string>({ maxBytes: 100 });
    lru.set('a', 'A', 40);
    lru.set('b', 'B', 40);
    expect(lru.get('a')).toBe('A'); // touch 'a' -> 'b' is now the oldest
    lru.set('c', 'C', 40);
    expect(lru.has('a')).toBe(true);
    expect(lru.has('b')).toBe(false); // least recently used went first
    expect(lru.has('c')).toBe(true);
  });

  it('the just-inserted entry survives even when it alone exceeds the budget', () => {
    const lru = new LruCache<string>({ maxBytes: 100 });
    lru.set('a', 'A', 40);
    lru.set('big', 'BIG', 500);
    expect(lru.has('a')).toBe(false);
    expect(lru.has('big')).toBe(true);
  });

  it('overwriting a key replaces its byte size instead of double counting', () => {
    const lru = new LruCache<string>({ maxBytes: 100 });
    lru.set('a', 'A', 40);
    lru.set('a', 'A2', 60);
    expect(lru.bytes).toBe(60);
    expect(lru.get('a')).toBe('A2');
  });

  it('supports an entry-count budget for the JSON caches', () => {
    const lru = new LruCache<string>({ maxEntries: 2 });
    lru.set('a', 'A');
    lru.set('b', 'B');
    lru.set('c', 'C');
    expect(lru.size).toBe(2);
    expect(lru.has('a')).toBe(false);
  });
});

describe('assetId keying (URL is only a fetch parameter)', () => {
  const manifest: FilmstripManifest = {
    intervalUs: 1_000_000,
    tileW: 160,
    tileH: 90,
    cols: 8,
    rows: 8,
    frameCount: 10,
    sprites: ['sprite_000.jpg'],
  };
  const fetchMock = vi.fn<(url: string) => Promise<unknown>>();

  beforeEach(() => {
    clearMediaCaches();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve(manifest) });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    setMediaCacheInvalidator(null);
    vi.unstubAllGlobals();
    clearMediaCaches();
  });

  it('a rotated presigned URL for the same asset hits the cache (no refetch)', async () => {
    const invalidated = vi.fn();
    setMediaCacheInvalidator(invalidated);

    expect(getFilmstripManifest('asset-1', 'https://r2/presigned-v1')).toBeNull(); // kicks fetch
    await vi.waitFor(() => expect(invalidated).toHaveBeenCalled());

    // Presign rotation: same asset, brand-new URL -> cached manifest, no fetch.
    const hit = getFilmstripManifest('asset-1', 'https://r2/presigned-v2');
    expect(hit).toEqual(manifest);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://r2/presigned-v1');

    // A DIFFERENT asset with its own URL does fetch.
    getFilmstripManifest('asset-2', 'https://r2/other');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
