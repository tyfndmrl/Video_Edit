/**
 * fileTypes — yükleme dosya-türü whitelist'i, backend ile senkron.
 *
 * Backend contentType whitelist'i (AssetUploadValidation.ValidateInit /
 * UploadRules.TryGetKind): video/mp4, video/quicktime, video/webm, audio/mpeg,
 * audio/mp4, audio/wav, image/png, image/jpeg, image/webp, application/x-cube-lut.
 * Tarayıcı tarafında eşleme UZANTI üzerinden yapılır (File.type tarayıcılar arası
 * güvenilmez; .cube için Chromium BOŞ string bildirir — kayıtlı bir MIME tipi yok);
 * desteklenmeyen dosya sunucuya init isteği atılmadan Türkçe hatayla düşer.
 */

/** Backend whitelist'inin uzantı karşılıkları — dosya seçicinin accept'i de budur. */
export const SUPPORTED_EXTENSIONS = [
  '.mp4',
  '.mov',
  '.webm',
  '.mp3',
  '.m4a',
  '.wav',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.cube',
] as const;

/** <input type="file" accept="..."> değeri. */
export const FILE_ACCEPT = SUPPORTED_EXTENSIONS.join(',');

/**
 * Uzantı → sunucuya BİLDİRİLECEK contentType. Anahtarlar `SUPPORTED_EXTENSIONS`,
 * değerler backend'in `UploadRules.ContentTypeKinds` whitelist'idir; ikisinin
 * eşleştiği `fileTypes.test.ts`'te sabitlenir.
 *
 * NEDEN `File.type` KULLANILMIYOR (ÖLÇÜLDÜ — gerçek tarayıcı, gerçek dosya):
 * Chromium/Windows bir `.m4a` için `audio/x-m4a` bildiriyor; o değer sunucunun
 * whitelist'inde YOKTUR ve yükleme daha ilk adımda İngilizce bir sunucu hatasıyla
 * düşüyordu ("contentType is not allowed. Allowed: …"). Yani kullanıcı arayüzün
 * kendi vaadine (`.m4a` accept listesinde, hata metni "MP3/M4A/WAV
 * yükleyebilirsiniz" diyor) rağmen MÜZİK EKLEYEMİYORDU — makineye/kayıt defterine
 * göre değişen, sessiz ve tam olarak reprodüksiyonu zor bir hata. Dosya türü kararı
 * zaten UZANTIDAN veriliyor (`isSupportedMediaFile`); bildirilen tipin de aynı tek
 * kaynaktan gelmesi bu ayrışmayı imkânsız kılar.
 */
const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  // 3D LUT — IANA'da kayıtlı tipi yok; sunucuyla ORTAK sözleşme bu x-tipidir
  // (UploadRules.ContentTypeKinds → AssetKind.Lut). Tarayıcı File.type'ı .cube
  // için boş döndürür, yani uzantı eşlemesi burada tek güvenilir yoldur.
  '.cube': 'application/x-cube-lut',
};

/**
 * Dosya adının uzantısından sunucunun kabul ettiği contentType; whitelist dışı
 * uzantıda `null` (o dosya zaten `isSupportedMediaFile` kapısından geçemez).
 */
export function contentTypeForFileName(fileName: string): string | null {
  return EXTENSION_CONTENT_TYPES[fileExtension(fileName)] ?? null;
}

/** Küçük harfli uzantı ('.mp4'); uzantı yoksa boş string. */
export function fileExtension(fileName: string): string {
  const i = fileName.lastIndexOf('.');
  if (i <= 0 || i === fileName.length - 1) return '';
  return fileName.slice(i).toLowerCase();
}

export function isSupportedMediaFile(fileName: string): boolean {
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(fileExtension(fileName));
}

/** Desteklenmeyen drop/seçim için anlaşılır Türkçe hata. */
export function unsupportedFileMessage(fileName: string): string {
  const ext = fileExtension(fileName);
  const what = ext !== '' ? `${ext}` : 'uzantısız dosya';
  return (
    `Desteklenmeyen format: ${what} — MP4/MOV/WebM (video), ` +
    'MP3/M4A/WAV (ses), PNG/JPG/WebP (görsel) veya .cube (LUT) yükleyebilirsiniz.'
  );
}
