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

/**
 * Kota reddi (M6): sunucunun İngİLİZCE ProblemDetails başlığı kartta ham
 * biçimde durursa kullanıcı ne yapacağını bilemez. Statü + başlık örüntüsünden
 * tanınan iki ret, kullanıcıyı kitaplık başlığındaki kota göstergesine ve somut
 * bir çözüme yönlendirir.
 *
 * Tanıma STATÜYE dayanır (403 = toplam kota, 429 = eşzamanlı yükleme sınırı);
 * başlık yalnız doğrulama içindir, çeviri sunucu metnine bağımlı kalmaz.
 */
export function quotaRejectionMessage(status: number, title: string | null): string | null {
  if (status === 403) {
    return (
      'Depolama kotanız dolu — kitaplık başlığındaki kota göstergesine bakın. ' +
      'Yer açmak için kullanılmayan medyayı sağ tıklayıp silin.'
    );
  }
  if (status === 429) {
    return (
      'Aynı anda çok fazla yükleme var. Süren yüklemelerden biri bitsin ya da ' +
      'iptal edin, sonra tekrar deneyin.' + (title ? ` (${title})` : '')
    );
  }
  return null;
}

export function uploadErrorMessage(err: unknown): string {
  if (err instanceof UploadError) {
    const api = findApiError(err);
    const detail = api ? problemDetailsMessage(api.body) : null;
    // Kota reddi YALNIZ init anında olur (AssetEndpoints.InitUpload) — başka bir
    // adımdaki 403/429'u kotaya yormak yanlış yönlendirme olurdu.
    if (api && err.code === 'init-failed') {
      const quota = quotaRejectionMessage(api.status, detail);
      if (quota) return quota;
    }
    if (detail) return `${CODE_PREFIXES[err.code]}: ${detail}`;
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
