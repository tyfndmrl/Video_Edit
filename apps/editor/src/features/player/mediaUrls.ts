/**
 * media-urls sync — populates assetStore's presigned derivative URLs.
 *
 * Contract (design 02 §4 + backend AssetEndpoints):
 *   GET /api/projects/{id}/media-urls ->
 *     { expiresAt, assets: { [assetId]: { original, proxy, filmstrip,
 *       filmstripManifest, waveform, poster, sprites } } }
 * URLs are presigned for 12 h; the client refreshes in the background when
 * less than 1 h remains, and refetches when a newly READY asset has no url yet.
 * That reactive refetch is throttled, and the throttle DEFERS — it must never
 * DROP the request (see requestReactiveRefresh: the asset poll stops as soon as
 * nothing is processing, so a dropped refetch is never retriggered and the
 * project stays URL-less for 12 h). Only ready assets appear in the response.
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
import { previewDerivative } from './previewSource';

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
/** Re-check delay while a fetch is already in flight (deferred reactive refetch). */
const REACTIVE_INFLIGHT_RECHECK_MS = 250;
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

  /**
   * Is there a READY asset whose url neither the store nor `cached` knows?
   *
   * "Its url" is KIND-dependent and the rule is previewSource's
   * (`previewDerivative`), not a copy of it: a still image's preview source is
   * the POSTER — the worker never writes a proxy for an image (ProcessAssetJob:
   * "Image için proxy ÜRETİLMEZ"). Asking for `proxy` here counted every ready
   * image as permanently url-less, and since each /media-urls response carries
   * FRESH presigned strings (new signature per call), every fetch re-armed the
   * store subscription below — a project with one photo re-polled the endpoint
   * every 5 s for as long as the tab lived.
   */
  const hasUrllessReadyAsset = (
    assets: ReadonlyMap<string, AssetSummary> = useAssetStore.getState().assets,
  ): boolean =>
    [...assets.values()].some((a) => {
      if (a.status !== 'ready') return false;
      const field = previewDerivative(a.kind);
      const storeUrl = field === 'poster' ? a.posterUrl : a.proxyUrl;
      return !storeUrl && !(cached && cached.assets[a.id]?.[field]);
    });

  /**
   * Deferred reactive refetch timer. Kept SEPARATE from `timer` (the presigned
   * URL renewal): sharing one handle would mean either the 12 h renewal or the
   * missing-url request silently cancels the other.
   */
  let reactiveTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * "A ready asset has no url" — refetch, or WAIT OUT the throttle window and
   * refetch then. The window must never DROP the request.
   *
   * Why this is load bearing: the asset list poll (entities/assets.ts,
   * useProjectAssets) stops the moment nothing is `uploaded`/`processing`, so
   * the update that writes `ready` is the LAST change assetStore ever sees. A
   * request dropped at that instant is never retriggered — the project keeps
   * NO presigned urls until the 12 h renewal fires: timeline filmstrips stay
   * flat and the player stays black. It is not a rare corner either: it happens
   * whenever an upload becomes ready within 5 s of the previous fetch, i.e. on
   * every small file with a warm worker (measured: ~4 s for a 2 MB clip, vs
   * ~7 s when the machine was busy — the pass/fail coin flip behind the
   * library-manage e2e failure).
   *
   * Terminates: each request produces AT MOST ONE fetch started after it
   * (`lastFetchAt > requestedAt` short-circuits every later attempt), and the
   * attempt stops early once nothing is missing. No retry storm.
   */
  const requestReactiveRefresh = (): void => {
    if (stopped || reactiveTimer !== null) return;
    const requestedAt = Date.now();
    const attempt = (): void => {
      reactiveTimer = null;
      if (stopped) return;
      // A fetch started after the request already answered it.
      if (lastFetchAt > requestedAt) return;
      if (!hasUrllessReadyAsset()) return;
      const waitMs = inFlight
        ? REACTIVE_INFLIGHT_RECHECK_MS
        : REACTIVE_REFETCH_MIN_MS - (Date.now() - lastFetchAt);
      if (waitMs > 0) {
        reactiveTimer = setTimeout(attempt, waitMs);
        return;
      }
      void refresh();
    };
    attempt();
  };

  // React to store changes: a newly READY asset without its preview url
  // (kind rule above) either gets the cached url applied, or triggers a
  // throttled refetch.
  const unsubscribe = useAssetStore.subscribe((state, prev) => {
    if (stopped || state.assets === prev.assets) return;
    applyCached();
    if (hasUrllessReadyAsset(state.assets)) requestReactiveRefresh();
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
    if (reactiveTimer !== null) clearTimeout(reactiveTimer);
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
