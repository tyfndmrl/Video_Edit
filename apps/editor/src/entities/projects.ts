/**
 * projects — proje API tipleri + çağrıları (liste / oluşturma).
 *
 * Contract (backend ProjectEndpoints):
 * - GET  /api/projects?page=&pageSize= -> PagedResult<ProjectSummaryDto>
 *   ({items, page, pageSize, totalCount}, updatedAt DESC sıralı)
 * - POST /api/projects {name, fpsNum, fpsDen, width, height, audioSampleRate}
 *   -> 201 ProjectDetailDto (timeline dahil — burada yalnız meta kullanılır)
 *
 * Detay GET'i (proje açma) projectSession.openProject'te yaşar; bu modül
 * yalnız seçicinin ihtiyacı olan liste/oluşturma yüzeyini taşır.
 */
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './apiClient';

/** backend/src/VideoEdit.Contracts/ProjectDtos.cs `ProjectSummaryDto` aynası (camelCase). */
export interface ProjectSummaryDto {
  id: string;
  name: string;
  revisionNumber: number;
  fpsNum: number;
  fpsDen: number;
  width: number;
  height: number;
  audioSampleRate: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectListResponse {
  items: ProjectSummaryDto[];
  page: number;
  pageSize: number;
  totalCount: number;
}

/**
 * MVP proje varsayılanları: 1080p30, 48 kHz. Seçici yalnız ad sorar; ayar
 * formu ileri milestone'a kaldı (backend zaten aynı varsayılanları uygular).
 */
export const NEW_PROJECT_DEFAULTS = {
  fpsNum: 30,
  fpsDen: 1,
  width: 1920,
  height: 1080,
  audioSampleRate: 48000,
} as const;

export function listProjects(page = 1, pageSize = 50): Promise<ProjectListResponse> {
  return apiFetch<ProjectListResponse>(`/api/projects?page=${page}&pageSize=${pageSize}`);
}

/** Yeni proje oluşturur (201 gövdesi detay DTO'sudur; meta kısmı yeter). */
export function createProject(name: string): Promise<ProjectSummaryDto> {
  return apiFetch<ProjectSummaryDto>('/api/projects', {
    method: 'POST',
    body: { name, ...NEW_PROJECT_DEFAULTS },
  });
}

export const projectsListQueryKey = ['projects', 'list'] as const;

/** Proje listesi (seçici görünümü). Seçici açıkken taze kalsın diye mount'ta yenilenir. */
export function useProjectsList() {
  return useQuery({
    queryKey: projectsListQueryKey,
    queryFn: () => listProjects(),
    refetchOnMount: 'always',
  });
}
