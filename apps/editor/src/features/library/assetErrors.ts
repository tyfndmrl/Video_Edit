/**
 * assetErrors — işleme hattının deterministik hata KODLARININ kullanıcı yüzü.
 *
 * Worker, job.ErrorMessage'a ayrıntılı İngilizce gerekçe, asset satırına ise kısa bir
 * kod yazar ('invalid-lut' gibi). Türkçe ürün yüzeyinde çıplak kod gösterilmez: bilinen
 * kod Türkçe bir cümleye çevrilir ve kod PARANTEZDE korunur (log/destek/e2e eşleşmesi
 * koda bakmaya devam eder). Bilinmeyen kod olduğu gibi düşer — yanlış çeviri uydurmaktan
 * iyidir.
 *
 * Kapsam beyanı: şimdilik yalnız 'invalid-lut' çevriliyor; önceden kalan kodların
 * ('unsupported-media' vb.) ham gösterimi bilinçli olarak korunuyor — tabloya kod
 * eklemek yeterli, çağrı yolu hazır.
 */
const ERROR_LABELS: Record<string, string> = {
  'invalid-lut': 'Geçersiz .cube dosyası',
};

/** Kitaplık satırı meta'sında gösterilecek hata etiketi. */
export function assetErrorLabel(errorCode: string): string {
  const label = ERROR_LABELS[errorCode];
  return label === undefined ? errorCode : `${label} (${errorCode})`;
}
