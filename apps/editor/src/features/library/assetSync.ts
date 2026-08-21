/**
 * assetSync — merges the server asset list (react-query poll) into assetStore.
 *
 * MERGE, not replace (M2 chief-architect finding 11): the presigned URL fields
 * (proxyUrl, posterUrl, filmstrip/sprite URLs, waveformUrl) are owned by the
 * media-urls sync, which writes them into the same store records. A blind
 * upsert from the asset poll would wipe them every 3 s and blank the
 * filmstrip/waveform/player until the next media-urls refresh.
 */
import { queryClient } from '../../app/queryClient';
import { quotaQueryKey, type AssetDto } from '../../entities/assets';
import { useAssetStore, type AssetKind, type AssetSummary } from '../../state/assetStore';

export function toAssetKind(kind: AssetDto['kind']): AssetKind {
  return kind === 'audio' || kind === 'image' || kind === 'lut' ? kind : 'video';
}

/**
 * `durationMicros` -> `durationUs`, narrowed to `number | undefined`.
 *
 * The DTO type says `number | undefined`, but the WIRE says otherwise: the API
 * serializes a missing duration as JSON `null` (AssetDto.DurationMicros is
 * `long?` and the asset endpoints do not ignore nulls), and a still image has
 * no duration to report — ffprobe's `png_pipe` demuxer emits none at all.
 *
 * Storing that null is not a cosmetic type lie. `durationUs` feeds the source
 * bounds invariant (`sourceOutUs > assetDuration`), and in JS `4000000 > null`
 * is TRUE — so adding a photo to the timeline made the editor's own validator
 * reject the document it had just written, assertDocValidDev threw, and the
 * new clip could not even be selected. Cut it at the source: `null` never
 * enters the store, so no downstream comparison can be poisoned by it.
 */
function toDurationUs(dto: AssetDto): number | undefined {
  const raw: number | null | undefined = dto.durationMicros;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

export function toAssetSummary(dto: AssetDto): AssetSummary {
  return {
    id: dto.id,
    kind: toAssetKind(dto.kind),
    name: dto.fileName,
    status: dto.status,
    progress: dto.progress,
    durationUs: toDurationUs(dto),
    width: dto.width,
    height: dto.height,
    errorCode: dto.errorCode,
  };
}

/**
 * Sync a server asset page into the store:
 * - unknown asset  -> insert as-is,
 * - known asset    -> update ONLY the fields the asset endpoint owns (identity,
 *   status, metadata); undefined DTO fields do not clobber known values and the
 *   presigned URL fields are left untouched,
 * - a locally-running upload's progress is fresher than the poll — skipped.
 *
 * Quota side effect: the server adds an asset's DERIVED bytes (proxy,
 * filmstrip, waveform, poster) to the storage quota the moment the asset turns
 * ready — a moment no user gesture owns. The upload manager invalidates the
 * quota query on upload complete/fail and the delete dialog on delete, but
 * processing->ready happens worker-side; without this hook the header
 * indicator kept showing the pre-derivative figure until the next full reload
 * (measured live: server 21.7 MB vs UI 21.0 MB). The poll observing the flip
 * to 'ready' is therefore the ONE place that can refresh the figure.
 */
export function syncServerAssets(items: readonly AssetDto[]): void {
  const store = useAssetStore.getState();
  let becameReady = false;
  for (const dto of items) {
    const existing = store.assets.get(dto.id);
    // While a local upload is running, its progress is fresher than the poll.
    if (existing?.status === 'uploading' && dto.status === 'uploading') continue;
    if (existing !== undefined && existing.status !== 'ready' && dto.status === 'ready') {
      becameReady = true;
    }
    const summary = toAssetSummary(dto);
    if (!existing) {
      store.upsertAsset(summary);
      continue;
    }
    const patch: Partial<Omit<AssetSummary, 'id'>> = {};
    for (const [key, value] of Object.entries(summary) as [
      keyof AssetSummary,
      AssetSummary[keyof AssetSummary],
    ][]) {
      if (key === 'id' || value === undefined) continue;
      (patch as Record<string, unknown>)[key] = value;
    }
    store.updateAsset(dto.id, patch);
  }
  if (becameReady) {
    // One invalidation per poll batch, not per asset.
    void queryClient.invalidateQueries({ queryKey: quotaQueryKey });
  }
}
