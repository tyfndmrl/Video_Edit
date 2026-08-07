/**
 * uploadApi — UploadApi port implementation over the backend REST contract.
 *
 * Endpoint shapes (backend M1 contract; do not change without the backend):
 *   POST /api/projects/{projectId}/assets      {fileName,sizeBytes,contentType}
 *   POST /api/assets/{id}/parts/presign        {partNumbers:[...]} (max 20)
 *   POST /api/assets/{id}/complete             {parts:[{partNumber,etag}]} ordered
 *   POST /api/assets/{id}/abort                -> 204
 *   GET  /api/assets/{id}/upload/status
 */
import { apiFetch } from '../../../entities/apiClient';
import type {
  CompletedPart,
  InitUploadRequest,
  InitUploadResponse,
  PresignedPart,
  UploadApi,
  UploadStatusResponse,
} from './uploadEngine';

export const uploadApi: UploadApi = {
  initUpload(projectId: string, req: InitUploadRequest): Promise<InitUploadResponse> {
    return apiFetch<InitUploadResponse>(`/api/projects/${projectId}/assets`, {
      method: 'POST',
      body: req,
    });
  },

  presignParts(assetId: string, partNumbers: number[]): Promise<PresignedPart[]> {
    return apiFetch<PresignedPart[]>(`/api/assets/${assetId}/parts/presign`, {
      method: 'POST',
      body: { partNumbers },
    });
  },

  completeUpload(assetId: string, parts: CompletedPart[]): Promise<{ status: string }> {
    return apiFetch<{ status: string }>(`/api/assets/${assetId}/complete`, {
      method: 'POST',
      body: { parts },
    });
  },

  async abortUpload(assetId: string): Promise<void> {
    await apiFetch<void>(`/api/assets/${assetId}/abort`, { method: 'POST' });
  },

  getUploadStatus(assetId: string): Promise<UploadStatusResponse> {
    return apiFetch<UploadStatusResponse>(`/api/assets/${assetId}/upload/status`);
  },
};
