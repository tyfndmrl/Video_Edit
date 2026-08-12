/**
 * assets — asset API types + react-query hooks.
 *
 * Read side of the asset contract (GET endpoints) plus the two library
 * management calls (delete + the usage lookup that precedes it). The multipart
 * upload write side (init/presign/complete/abort) lives with the upload engine
 * adapter: features/library/upload/uploadApi.ts.
 */
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './apiClient';

export type AssetStatusDto = 'uploading' | 'uploaded' | 'processing' | 'ready' | 'failed';
export type AssetKindDto = 'video' | 'audio' | 'image';

export interface AssetDto {
  id: string;
  fileName: string;
  sizeBytes: number;
  contentType: string;
  kind: AssetKindDto;
  status: AssetStatusDto;
  errorCode?: string;
  durationMicros?: number;
  width?: number;
  height?: number;
  /** 0..1 processing progress; not in the M1 contract yet (SignalR lands in M1-B) but tolerated. */
  progress?: number;
}

export interface AssetListResponse {
  items: AssetDto[];
  page: number;
  pageSize: number;
  totalCount: number;
}

export function getAsset(assetId: string): Promise<AssetDto> {
  return apiFetch<AssetDto>(`/api/assets/${assetId}`);
}

export function listProjectAssets(
  projectId: string,
  page = 1,
  pageSize = 100,
): Promise<AssetListResponse> {
  return apiFetch<AssetListResponse>(
    `/api/projects/${projectId}/assets?page=${page}&pageSize=${pageSize}`,
  );
}

export const projectAssetsQueryKey = (projectId: string) =>
  ['projects', projectId, 'assets'] as const;

/**
 * Project asset list. Polls every 3 s while any asset is queued/processing
 * (uploaded -> processing -> ready happens server-side; SignalR replaces this
 * polling in M1-B).
 */
export function useProjectAssets(projectId: string | null) {
  return useQuery({
    queryKey: projectAssetsQueryKey(projectId ?? 'none'),
    queryFn: () => listProjectAssets(projectId as string),
    enabled: projectId !== null,
    refetchInterval: (query) => {
      const items = query.state.data?.items;
      if (!items) return false;
      const busy = items.some((a) => a.status === 'uploaded' || a.status === 'processing');
      return busy ? 3000 : false;
    },
    // Keep polling while the tab is in the background so processing status is
    // fresh when the user returns (react-query pauses refetchInterval in
    // hidden tabs by default). ACCEPTED interim solution until SignalR push
    // replaces this polling in M2.
    refetchIntervalInBackground: true,
  });
}

// ---------------------------------------------------------------------------
// Library management (M6): usage lookup, delete, quota summary
// ---------------------------------------------------------------------------

/** One project a given asset is used in, with the number of clips showing it. */
export interface AssetUsageProjectDto {
  id: string;
  name: string;
  clipCount: number;
}

/** GET /api/assets/{id}/usage — empty `projects` means "safe to delete". */
export interface AssetUsageDto {
  projects: AssetUsageProjectDto[];
}

/**
 * Where is this media used? Asked ONCE, right before a delete — deliberately
 * NOT part of the asset list DTO, which is polled every 3 s (scanning every
 * timeline on every poll would make the library list expensive).
 */
export function getAssetUsage(assetId: string): Promise<AssetUsageDto> {
  return apiFetch<AssetUsageDto>(`/api/assets/${assetId}/usage`);
}

/**
 * Soft-delete an asset. The server does NOT refuse when the media is on a
 * timeline: the warning + confirmation is the client's job (getAssetUsage),
 * and clips left behind are painted as "media missing" (features/library
 * missingMedia.ts).
 */
export function deleteAsset(assetId: string): Promise<void> {
  return apiFetch<void>(`/api/assets/${assetId}`, { method: 'DELETE' });
}

/** GET /api/quota — the storage figures behind the library header indicator. */
export interface QuotaSummaryDto {
  usedBytes: number;
  maxBytes: number;
  assetCount: number;
  maxConcurrentUploads: number;
}

export function getQuota(): Promise<QuotaSummaryDto> {
  return apiFetch<QuotaSummaryDto>('/api/quota');
}

export const quotaQueryKey = ['quota'] as const;

/**
 * Storage quota for the signed-in user. Not polled: it only moves when an
 * upload lands or an asset is deleted, and both paths invalidate this key
 * (upload/uploadManager.ts, LibraryPanel delete flow).
 */
export function useQuota() {
  return useQuery({
    queryKey: quotaQueryKey,
    queryFn: getQuota,
    staleTime: 30_000,
  });
}
