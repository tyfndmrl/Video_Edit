/**
 * assetSync — merges the server asset list (react-query poll) into assetStore.
 *
 * MERGE, not replace (M2 chief-architect finding 11): the presigned URL fields
 * (proxyUrl, posterUrl, filmstrip/sprite URLs, waveformUrl) are owned by the
 * media-urls sync, which writes them into the same store records. A blind
 * upsert from the asset poll would wipe them every 3 s and blank the
 * filmstrip/waveform/player until the next media-urls refresh.
 */
import type { AssetDto } from '../../entities/assets';
import { useAssetStore, type AssetKind, type AssetSummary } from '../../state/assetStore';

export function toAssetKind(kind: AssetDto['kind']): AssetKind {
  return kind === 'audio' || kind === 'image' ? kind : 'video';
}

export function toAssetSummary(dto: AssetDto): AssetSummary {
  return {
    id: dto.id,
    kind: toAssetKind(dto.kind),
    name: dto.fileName,
    status: dto.status,
    progress: dto.progress,
    durationUs: dto.durationMicros,
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
 */
export function syncServerAssets(items: readonly AssetDto[]): void {
  const store = useAssetStore.getState();
  for (const dto of items) {
    const existing = store.assets.get(dto.id);
    // While a local upload is running, its progress is fresher than the poll.
    if (existing?.status === 'uploading' && dto.status === 'uploading') continue;
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
}
