/**
 * exports — export job API types + react-query hooks (M3).
 *
 * Contract:
 * - POST /api/projects/{id}/exports {profile} -> 202 {jobId}
 *   (422 = unsupported feature, ProblemDetails detail explains; 429 = concurrent limit)
 * - GET  /api/jobs/{jobId} -> ExportJobDto (downloadUrl only when succeeded, 24 h)
 * - POST /api/jobs/{jobId}/cancel -> 204
 * - GET  /api/projects/{id}/exports -> paged list, newest first
 */
import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './apiClient';
import {
  hubAwareExportsInterval,
  hubAwareJobInterval,
  syncJobSubscriptions,
} from './progressHub';

/**
 * Wire names of the export profiles — mirror of `ExportProfiles.TryParse` on the
 * server (720p / 2160p / dikey dahil). The target geometry of each
 * profile lives in `exportLogic.PROFILE_TARGETS`, guarded against the server by
 * `ExportGateInventoryTests.TheClientAndServerAgreeOnTheProfileGeometry`.
 */
export type ExportProfile = '1080p' | '720p' | '2160p' | 'dikey';

export type ExportJobStatusDto = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

/**
 * Mirror of backend/src/VideoEdit.Contracts/ExportDtos.cs `ExportJobDto`
 * (System.Text.Json web defaults: camelCase, nulls serialized as null).
 * Keep field names/nullability in sync with the C# record.
 */
export interface ExportJobDto {
  id: string;
  projectId: string | null;
  status: ExportJobStatusDto;
  profile: string | null;
  progressPercent: number;
  /** Worker stage key: 'download' | 'compile' | 'render' | 'probe' | 'upload' | 'done' | 'disk-wait' | 'memory-wait' | 'canceled' — null before the worker first reports. */
  progressStage: string | null;
  /** Failure reason (status === 'failed'); null otherwise. */
  error: string | null;
  /** Present only when status === 'succeeded'; valid for 24 hours. */
  downloadUrl: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ExportListResponse {
  items: ExportJobDto[];
  page: number;
  pageSize: number;
  totalCount: number;
}

export interface StartExportResponse {
  jobId: string;
}

export function startExport(
  projectId: string,
  profile: ExportProfile = '1080p',
): Promise<StartExportResponse> {
  return apiFetch<StartExportResponse>(`/api/projects/${projectId}/exports`, {
    method: 'POST',
    body: { profile },
  });
}

export function getJob(jobId: string): Promise<ExportJobDto> {
  return apiFetch<ExportJobDto>(`/api/jobs/${jobId}`);
}

export function cancelJob(jobId: string): Promise<void> {
  return apiFetch<void>(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
}

export function listProjectExports(
  projectId: string,
  page = 1,
  pageSize = 20,
): Promise<ExportListResponse> {
  return apiFetch<ExportListResponse>(
    `/api/projects/${projectId}/exports?page=${page}&pageSize=${pageSize}`,
  );
}

export const projectExportsQueryKey = (projectId: string) =>
  ['projects', projectId, 'exports'] as const;

export const jobQueryKey = (jobId: string) => ['jobs', jobId] as const;

// ---------------------------------------------------------------------------
// Polling policy (pure — unit tested without react-query)
// ---------------------------------------------------------------------------

/**
 * Poll cadence while an export job is in flight. SignalR canlı kanalı (entities/progressHub)
 * birincildir; bu yoklama YEDEKTİR ve hub bir işi kapsamadığı anda aynen devreye girer —
 * saf fonksiyonlar bugünkü politikayı tanımlar, hook'lar hub-farkındalı kapıdan geçirir.
 */
export const EXPORTS_POLL_MS = 2000;

export function isJobActive(status: ExportJobStatusDto): boolean {
  return status === 'queued' || status === 'running';
}

/**
 * refetchInterval for the export LIST: poll every 2 s while any job is
 * queued/running, stop entirely once everything is terminal.
 */
export function exportsRefetchInterval(items: ExportJobDto[] | undefined): number | false {
  if (!items) return false;
  return items.some((j) => isJobActive(j.status)) ? EXPORTS_POLL_MS : false;
}

/** refetchInterval for a SINGLE job: poll while queued/running, stop when terminal. */
export function jobRefetchInterval(job: ExportJobDto | undefined): number | false {
  if (!job) return false;
  return isJobActive(job.status) ? EXPORTS_POLL_MS : false;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Export job list for a project (newest first). Canlı yol: aktif işler SignalR hub'ına
 * abone edilir ve ilerleme push ile gelir — hub bir işi kapsıyorken o iş İÇİN yoklama
 * durur. Hub yoksa/düşerse/susarsa bugünkü davranış aynen: 2 s poll (background dahil),
 * her şey terminal olunca stop (hubAwareExportsInterval kapısı).
 */
export function useProjectExports(projectId: string | null) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: projectExportsQueryKey(projectId ?? 'none'),
    queryFn: () => listProjectExports(projectId as string),
    enabled: projectId !== null,
    refetchInterval: (query) => hubAwareExportsInterval(query.state.data?.items),
    refetchIntervalInBackground: true,
  });

  // Aktif işlerin abonelik senkronu. Effect id listesinin İÇERİĞİNE bağlanır ki no-op
  // fetch'ler (items referansı her fetch'te değişir) yeniden senkron tetiklemesin; owner
  // anahtarı bu hook'un katkısını useJob'unkinden ayırır (progressHub katkı modeli).
  // Unmount/proje değişiminde katkı boşaltılır — hayalet abonelik kalmaz.
  const activeKey = (query.data?.items ?? [])
    .filter((j) => isJobActive(j.status))
    .map((j) => j.id)
    .join(',');
  useEffect(() => {
    const owner = `exports-list:${projectId ?? 'none'}`;
    syncJobSubscriptions(queryClient, owner, activeKey === '' ? [] : activeKey.split(','));
    return () => syncJobSubscriptions(queryClient, owner, []);
  }, [queryClient, projectId, activeKey]);

  return query;
}

/** Single export job (hub kapsıyorken push; aksi halde queued/running boyunca poll). */
export function useJob(jobId: string | null) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: jobQueryKey(jobId ?? 'none'),
    queryFn: () => getJob(jobId as string),
    enabled: jobId !== null,
    refetchInterval: (query) => hubAwareJobInterval(query.state.data),
    refetchIntervalInBackground: true,
  });

  const active = query.data !== undefined && isJobActive(query.data.status);
  useEffect(() => {
    if (jobId === null) return;
    const owner = `job:${jobId}`;
    syncJobSubscriptions(queryClient, owner, active ? [jobId] : []);
    return () => syncJobSubscriptions(queryClient, owner, []);
  }, [queryClient, jobId, active]);

  return query;
}
