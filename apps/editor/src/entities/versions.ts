/**
 * versions — project revision (version history) API types + react-query hooks.
 *
 * Contract (backend/src/VideoEdit.Api/Endpoints/ProjectEndpoints.cs):
 * - GET  /api/projects/{id}/revisions?page=&pageSize= -> PagedResult<RevisionMetaDto>
 *   (revisionNumber DESC = newest first; the timeline is NOT included)
 * - GET  /api/projects/{id}/revisions/{rev} -> RevisionDetailDto (timeline included)
 * - POST /api/projects/{id}/revisions {label} -> RevisionMetaDto
 *   Snapshots the SERVER's CURRENT document. An existing snapshot at the same
 *   revisionNumber is PROMOTED to Checkpoint (200) instead of duplicated (201) —
 *   which is why the client must flush autosave BEFORE calling it, or the
 *   checkpoint captures a stale document.
 * - POST /api/projects/{id}/restore {revisionNumber} -> RestoreResponse
 *   The server first snapshots the current document as PreRestore (the safety
 *   net), then replaces the current document and bumps revisionNumber. The
 *   response carries the NEW state, so the client reloads the doc from it.
 *
 * Same shape as entities/exports.ts: plain call functions + query keys + hooks.
 */
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './apiClient';

/**
 * Mirror of backend/src/VideoEdit.Domain/Enums.cs `RevisionKind`, serialized
 * with `.ToString()` (PascalCase strings, NOT numbers).
 */
export type RevisionKindDto = 'Auto' | 'Checkpoint' | 'PreRestore';

/**
 * Mirror of backend/src/VideoEdit.Contracts/ProjectDtos.cs `RevisionMetaDto`
 * (System.Text.Json web defaults: camelCase, nulls serialized as null).
 * Keep field names/nullability in sync with the C# record.
 */
export interface RevisionMetaDto {
  id: string;
  revisionNumber: number;
  /** 'Auto' | 'Checkpoint' | 'PreRestore' — widened to string so an unknown
   *  server-side kind renders verbatim instead of crashing the panel. */
  kind: string;
  label: string | null;
  createdBy: string;
  createdAt: string;
}

/** `RevisionDetailDto` — meta + the snapshotted timeline document. */
export interface RevisionDetailDto extends RevisionMetaDto {
  timeline: unknown;
}

export interface RevisionListResponse {
  items: RevisionMetaDto[];
  page: number;
  pageSize: number;
  totalCount: number;
}

/** `RestoreResponse` — the project's NEW state after the restore. */
export interface RestoreResponse {
  revisionNumber: number;
  timeline: unknown;
}

/** Backend caps the checkpoint label at 200 characters (ValidationProblem). */
export const CHECKPOINT_LABEL_MAX = 200;

export function listRevisions(
  projectId: string,
  page = 1,
  pageSize = 50,
): Promise<RevisionListResponse> {
  return apiFetch<RevisionListResponse>(
    `/api/projects/${projectId}/revisions?page=${page}&pageSize=${pageSize}`,
  );
}

/** Single revision INCLUDING its timeline (preview / diff surfaces later). */
export function getRevision(projectId: string, revisionNumber: number): Promise<RevisionDetailDto> {
  return apiFetch<RevisionDetailDto>(`/api/projects/${projectId}/revisions/${revisionNumber}`);
}

/**
 * Manual checkpoint of the server's current document. `label` is optional —
 * null is sent when the user leaves the field empty.
 */
export function createCheckpoint(
  projectId: string,
  label: string | null,
): Promise<RevisionMetaDto> {
  return apiFetch<RevisionMetaDto>(`/api/projects/${projectId}/revisions`, {
    method: 'POST',
    body: { label },
  });
}

export function restoreRevision(
  projectId: string,
  revisionNumber: number,
): Promise<RestoreResponse> {
  return apiFetch<RestoreResponse>(`/api/projects/${projectId}/restore`, {
    method: 'POST',
    body: { revisionNumber },
  });
}

export const projectRevisionsQueryKey = (projectId: string) =>
  ['projects', projectId, 'revisions'] as const;

/**
 * Revision list for a project (newest first).
 *
 * No polling: revisions only change through THIS client's own actions
 * (autosave snapshots, checkpoint, restore), and those invalidate the key
 * explicitly. `refetchOnMount: 'always'` makes opening the panel show fresh
 * data even when a cached page is still warm (same as useProjectsList).
 */
export function useProjectRevisions(projectId: string | null) {
  return useQuery({
    queryKey: projectRevisionsQueryKey(projectId ?? 'none'),
    queryFn: () => listRevisions(projectId as string),
    enabled: projectId !== null,
    refetchOnMount: 'always',
  });
}
