/**
 * fileTypes — yükleme dosya-türü whitelist'i, backend ile senkron.
 *
 * Backend contentType whitelist'i (AssetUploadValidation.ValidateInit /
 * UploadRules.TryGetKind): video/mp4, video/quicktime, video/webm, audio/mpeg,
 * audio/mp4, audio/wav, image/png, image/jpeg, image/webp. Tarayıcı tarafında
 * eşleme UZANTI üzerinden yapılır (File.type tarayıcılar arası güvenilmez);
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
] as const;

/** <input type="file" accept="..."> değeri. */
export const FILE_ACCEPT = SUPPORTED_EXTENSIONS.join(',');

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
    'MP3/M4A/WAV (ses) veya PNG/JPG/WebP (görsel) yükleyebilirsiniz.'
  );
}
