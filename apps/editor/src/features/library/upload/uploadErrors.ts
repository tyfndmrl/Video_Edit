/**
 * uploadErrors — upload hatalarını karttaki Türkçe mesaja çevirir.
 *
 * UploadEngine hataları UploadError olarak gelir; init/complete gibi API
 * kaynaklı hatalarda `cause` zinciri ApiError taşır ve ApiError.body'deki
 * ProblemDetails title/detail/errors içeriği ham "HTTP 400" metni yerine
 * gösterilir (ör. contentType whitelist mesajı, kota mesajı).
 */
import { ApiError } from '../../../entities/apiClient';
import { problemDetailsMessage } from '../../../entities/problemDetails';
import { UploadError, type UploadErrorCode } from './uploadEngine';

const CODE_PREFIXES: Record<UploadErrorCode, string> = {
  'init-failed': 'Yükleme başlatılamadı',
  'presign-failed': 'Yükleme adresi alınamadı',
  'part-failed': 'Parça yüklenemedi',
  'etag-missing': 'Yükleme tamamlanamadı',
  'complete-failed': 'Yükleme tamamlanamadı',
};

/** Hata zincirinde (err -> cause -> ...) ilk ApiError'ı bulur. */
function findApiError(err: unknown, depth = 0): ApiError | null {
  if (depth > 5) return null;
  if (err instanceof ApiError) return err;
  if (err instanceof Error && err.cause !== undefined) return findApiError(err.cause, depth + 1);
  return null;
}

export function uploadErrorMessage(err: unknown): string {
  if (err instanceof UploadError) {
    const api = findApiError(err);
    const detail = api ? problemDetailsMessage(api.body) : null;
    if (detail) return `${CODE_PREFIXES[err.code]}: ${detail}`;
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
