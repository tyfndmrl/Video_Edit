/**
 * media-urls sync — populates assetStore's presigned derivative URLs.
 *
 * Contract (design 02 §4 + backend AssetEndpoints):
 *   GET /api/projects/{id}/media-urls ->
 *     { expiresAt, assets: { [assetId]: { original, proxy, filmstrip,
 *       filmstripManifest, waveform, poster, sprites } } }
 * URLs are presigned for 12 h; the client refreshes in the background when
 * less than 1 h remains, and refetches when a newly READY asset has no url yet
 * (throttled). Only ready assets appear in the response.
 *
 * INTERSECTION CONTRACT (B): this module is the single media-url sync for the
 * whole app. Exports:
 *   - useMediaUrlSync(projectId: string | null): void — React hook; mounted
 *     once at App/EditorBoot level (wraps startMediaUrlSync).
 *   - forceRefreshMediaUrls(): void — immediate refetch (throttled); used by
 *     the player's media-error path when a presigned URL expired early.
 * It covers ALL derivative fields: proxy, poster, filmstrip,
 * filmstripManifest, waveform, sprites.
 *
 * The player's <video> pool sources exclusively from the PROXY url.
 */
import { useEffect } from 'react';
import { apiFetch } from '../../entities/apiClient';
import { useAssetStore, type AssetSummary } from '../../state/assetStore';

interface AssetMediaUrls {
  original?: string | null;
  proxy?: string | null;
  filmstrip?: string | null;
  filmstripManifest?: string | null;
  waveform?: string | null;
  poster?: string | null;
  sprites?: Record<string, string> | null;
}

interface MediaUrlsResponse {
  expiresAt: string;
  assets: Record<string, AssetMediaUrls>;
}

/** Refresh when the remaining lifetime drops under 1 hour (design 02 §4). */
const REFRESH_MARGIN_MS = 60 * 60 * 1000;
/** Reactive refetch throttle (new ready assets appearing in the store). */
const REACTIVE_REFETCH_MIN_MS = 5_000;
/** forceRefreshMediaUrls() throttle (media error storms must not DDOS us). */
const FORCE_REFRESH_MIN_MS = 5_000;
/** Retry delay after a failed fetch. */
const RETRY_MS = 30_000;

/** The currently running sync instance (last started wins). */
let activeSync: { refreshNow(): void } | null = null;

/**
 * Ask the running media-urls sync for an immediate refetch (throttled).
 * No-op when no sync is active. Player media-error path calls this when a
 * presigned URL failed before its scheduled refresh.
 */
export function forceRefreshMediaUrls(): void {
  activeSync?.refreshNow();
}

/**
 * Start syncing presigned media URLs for a project into assetStore.
 * Returns a stop function.
 */
export function startMediaUrlSync(projectId: string): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cached: MediaUrlsResponse | null = null;
  let lastFetchAt = 0;
  let inFlight = false;

  const applyCached = (): void => {
    if (!cached) return;
    const store = useAssetStore.getState();
    for (const [assetId, urls] of Object.entries(cached.assets)) {
      const existing = store.assets.get(assetId);
      if (!existing) continue;
      // Only patch actual CHANGES — this runs from a store subscription, so an
      // unconditional update would recurse forever. (`urls` objects keep their
      // identity between applyCached calls, so reference checks are stable.)
      const patch: Partial<Omit<AssetSummary, 'id'>> = {};
      if (urls.proxy && existing.proxyUrl !== urls.proxy) patch.proxyUrl = urls.proxy;
      if (urls.poster && existing.posterUrl !== urls.poster) patch.posterUrl = urls.poster;
      if (urls.filmstrip && existing.filmstripUrl !== urls.filmstrip) {
        patch.filmstripUrl = urls.filmstrip;
      }
      if (urls.filmstripManifest && existing.filmstripManifestUrl !== urls.filmstripManifest) {
        patch.filmstripManifestUrl = urls.filmstripManifest;
      }
      if (urls.waveform && existing.waveformUrl !== urls.waveform) {
        patch.waveformUrl = urls.waveform;
      }
      if (urls.sprites && existing.sprites !== urls.sprites) {
        patch.sprites = urls.sprites;
      }
      if (Object.keys(patch).length > 0) store.updateAsset(assetId, patch);
    }
  };

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void refresh();
    }, Math.max(1_000, delayMs));
  };

  const refresh = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    lastFetchAt = Date.now();
    try {
      const res = await apiFetch<MediaUrlsResponse>(`/api/projects/${projectId}/media-urls`);
      if (stopped) return;
      cached = res;
      applyCached();
      // Presigned URLs live 12 h; renew when < 1 h remains (expiresAt - 1 h).
      const expiresMs = Date.parse(res.expiresAt) - Date.now();
      schedule(Number.isFinite(expiresMs) ? expiresMs - REFRESH_MARGIN_MS : RETRY_MS);
    } catch {
      if (!stopped) schedule(RETRY_MS);
    } finally {
      inFlight = false;
    }
  };

  // React to store changes: a newly READY asset without a proxy url either
  // gets the cached url applied, or triggers a throttled refetch.
  const unsubscribe = useAssetStore.subscribe((state, prev) => {
    if (stopped || state.assets === prev.assets) return;
    applyCached();
    const missing = [...state.assets.values()].some(
      (a) => a.status === 'ready' && !a.proxyUrl && !(cached && cached.assets[a.id]?.proxy),
    );
    if (missing && Date.now() - lastFetchAt > REACTIVE_REFETCH_MIN_MS) {
      void refresh();
    }
  });

  void refresh();

  const handle = {
    refreshNow(): void {
      if (stopped || Date.now() - lastFetchAt < FORCE_REFRESH_MIN_MS) return;
      void refresh();
    },
  };
  activeSync = handle;

  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    if (activeSync === handle) activeSync = null;
    unsubscribe();
  };
}

/**
 * React hook wrapper over startMediaUrlSync — the app mounts this ONCE for
 * the open project (App/EditorBoot); null stops the sync.
 */
export function useMediaUrlSync(projectId: string | null): void {
  useEffect(() => {
    if (!projectId) return;
    return startMediaUrlSync(projectId);
  }, [projectId]);
}
