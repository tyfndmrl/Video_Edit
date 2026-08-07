/**
 * assets — asset API types + react-query hooks.
 *
 * Read side of the asset contract (GET endpoints). The multipart upload write
 * side (init/presign/complete/abort) lives with the upload engine adapter:
 * features/library/upload/uploadApi.ts.
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
  });
}
