/**
 * mediaCache — async caches feeding the canvas painters.
 *
 * - Filmstrip manifests (filmstrip/manifest.json contract, design 02 §3.4):
 *   { intervalUs, tileW, tileH, cols, rows, frameCount, sprites[] }.
 * - Sprite images (crossorigin anonymous — COEP require-corp is on).
 * - Waveform peaks (audiowaveform version:2 JSON: interleaved int8 min/max).
 *
 * Keying (M2 chief-architect finding 9): entries are keyed by STABLE identity
 * (assetId, + sprite file name for images) — presigned URLs rotate every ~12 h
 * and must only be a fetch parameter, never the cache key (URL-keyed caches
 * refetch everything on each rotation and leak the stale copies).
 *
 * Eviction: true LRU (a cache hit refreshes recency) with a byte budget for
 * decoded images (est. w*h*4) and an entry budget for the small JSON caches
 * (design 01 pitfall #9).
 *
 * All getters are synchronous: they return the cached value or null and kick
 * off the fetch, invoking the registered invalidation callback when data
 * arrives so the timeline repaints.
 */

export interface FilmstripManifest {
  intervalUs: number;
  tileW: number;
  tileH: number;
  cols: number;
  rows: number;
  frameCount: number;
  sprites: string[];
}

export interface WaveformPeaks {
  sampleRate: number;
  samplesPerPixel: number;
  /** Interleaved [min0, max0, min1, max1, ...] int8. */
  data: Int8Array;
  /** Peak (pair) count. */
  length: number;
  /** Seconds covered by one peak pair. */
  secondsPerPeak: number;
}

let invalidate: (() => void) | null = null;

/** The timeline registers its repaint scheduler here. */
export function setMediaCacheInvalidator(cb: (() => void) | null): void {
  invalidate = cb;
}

// ---------------------------------------------------------------------------
// LRU with byte budget
// ---------------------------------------------------------------------------

export interface LruCacheOptions {
  /** Evict oldest entries once the summed entry sizes exceed this. */
  maxBytes?: number;
  /** Evict oldest entries once the entry count exceeds this. */
  maxEntries?: number;
}

/**
 * Insertion-ordered Map used as a true LRU: `get` re-inserts the entry
 * (delete+set) so Map iteration order == recency order; eviction pops from the
 * front. Exported for unit tests.
 */
export class LruCache<V> {
  private map = new Map<string, { value: V; bytes: number }>();
  private totalBytes = 0;

  constructor(private readonly opts: LruCacheOptions) {}

  get size(): number {
    return this.map.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  /** Cache hit refreshes recency (real LRU, not FIFO). */
  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (entry === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, bytes = 0): void {
    const existing = this.map.get(key);
    if (existing !== undefined) {
      this.totalBytes -= existing.bytes;
      this.map.delete(key);
    }
    this.map.set(key, { value, bytes });
    this.totalBytes += bytes;
    this.evictOverflow(key);
  }

  delete(key: string): void {
    const entry = this.map.get(key);
    if (entry === undefined) return;
    this.totalBytes -= entry.bytes;
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
    this.totalBytes = 0;
  }

  /** Oldest-first eviction; the just-touched `keep` key survives even oversized. */
  private evictOverflow(keep: string): void {
    const { maxBytes, maxEntries } = this.opts;
    for (const key of this.map.keys()) {
      const overBytes = maxBytes !== undefined && this.totalBytes > maxBytes;
      const overCount = maxEntries !== undefined && this.map.size > maxEntries;
      if (!overBytes && !overCount) return;
      if (key === keep) continue; // never evict the entry we just inserted
      this.delete(key);
    }
  }
}

/** ~256 MB decoded-image budget (w*h*4 bytes per sprite estimate). */
export const IMAGE_CACHE_BUDGET_BYTES = 256 * 1024 * 1024;
const MAX_JSON = 256;

type Loadable<V> = V | 'loading' | 'error';

const images = new LruCache<Loadable<HTMLImageElement>>({ maxBytes: IMAGE_CACHE_BUDGET_BYTES });
const manifests = new LruCache<Loadable<FilmstripManifest>>({ maxEntries: MAX_JSON });
const waveforms = new LruCache<Loadable<WaveformPeaks>>({ maxEntries: MAX_JSON });

// ---------------------------------------------------------------------------
// Getters
// ---------------------------------------------------------------------------

/**
 * Sprite image for `assetId`/`spriteName` ('sprite_000.jpg' from the filmstrip
 * manifest). `url` is only the fetch parameter — a rotated presigned URL for
 * the same sprite hits the existing cache entry.
 */
export function getSpriteImage(
  assetId: string,
  spriteName: string,
  url: string,
): HTMLImageElement | null {
  const key = `${assetId}/${spriteName}`;
  const cached = images.get(key);
  if (cached !== undefined) return cached === 'loading' || cached === 'error' ? null : cached;
  if (typeof Image === 'undefined') return null; // node/test environment
  images.set(key, 'loading');
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    // Decoded size estimate; refreshes recency and applies the byte budget.
    const bytes = Math.max(1, img.naturalWidth * img.naturalHeight * 4);
    images.set(key, img, bytes);
    invalidate?.();
  };
  img.onerror = () => {
    images.set(key, 'error');
  };
  img.src = url;
  return null;
}

/** Filmstrip manifest for `assetId` (URL is only the fetch parameter). */
export function getFilmstripManifest(assetId: string, url: string): FilmstripManifest | null {
  const cached = manifests.get(assetId);
  if (cached !== undefined) return cached === 'loading' || cached === 'error' ? null : cached;
  manifests.set(assetId, 'loading');
  void fetch(url)
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((json: FilmstripManifest) => {
      if (
        typeof json.intervalUs !== 'number' ||
        typeof json.tileW !== 'number' ||
        !Array.isArray(json.sprites)
      ) {
        throw new Error('malformed filmstrip manifest');
      }
      manifests.set(assetId, json);
      invalidate?.();
    })
    .catch(() => {
      manifests.set(assetId, 'error');
    });
  return null;
}

interface RawPeaksJson {
  version: number;
  sample_rate: number;
  samples_per_pixel: number;
  length: number;
  data: number[];
}

/** Waveform peaks for `assetId` (URL is only the fetch parameter). */
export function getWaveformPeaks(assetId: string, url: string): WaveformPeaks | null {
  const cached = waveforms.get(assetId);
  if (cached !== undefined) return cached === 'loading' || cached === 'error' ? null : cached;
  waveforms.set(assetId, 'loading');
  void fetch(url)
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((json: RawPeaksJson) => {
      if (!Array.isArray(json.data) || typeof json.sample_rate !== 'number') {
        throw new Error('malformed peaks json');
      }
      const peaks: WaveformPeaks = {
        sampleRate: json.sample_rate,
        samplesPerPixel: json.samples_per_pixel,
        data: Int8Array.from(json.data),
        length: json.length ?? json.data.length / 2,
        secondsPerPeak: json.samples_per_pixel / json.sample_rate,
      };
      waveforms.set(assetId, peaks, peaks.data.byteLength);
      invalidate?.();
    })
    .catch(() => {
      waveforms.set(assetId, 'error');
    });
  return null;
}

/** Test/HMR hook. */
export function clearMediaCaches(): void {
  images.clear();
  manifests.clear();
  waveforms.clear();
}
