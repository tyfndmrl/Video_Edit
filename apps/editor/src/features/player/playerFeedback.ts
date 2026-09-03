/**
 * playerFeedback — oynatıcı transport çubuğunun ret/bildirim metinleri.
 *
 * Neden ayrı tablo (emsal: `features/inspector/inspectorFeedback.ts`): buradaki
 * kodlar bir OP sonucu değil, bir GİRDİ DOĞRULAMA sonucudur ve yalnız transport
 * alanından ulaşılır; mesaj da o alanın yanında, satır içinde gösterilir.
 * Ortak tablo (`features/timeline/feedback.ts`) yine ilk duraktır — iki yüzeyin
 * de gördüğü bir kodun TEK çevirisi olmalı, ayrışan iki çeviri değil.
 *
 * `feedbackCoverage.test.ts` bu dosyayı ve `timecodeInput.ts`'i ÇİFT YÖNLÜ
 * karşılaştırır: çevrilmemiş kod da, kaynakta artık üretilmeyen bayat anahtar
 * da testi kırmızıya düşürür.
 */
import { opFailureMessage, opNoticeMessage } from '../timeline/feedback';

/** timecodeInput ret kodları -> Türkçe cümle. */
const TIMECODE_REASONS: Record<string, string> = {
  'timecode not understood': 'Zaman kodu anlaşılmadı — SS:DD:SN:KR bekleniyor',
  'drop-frame timecode not supported': 'Drop-frame zaman kodu (noktalı virgül) desteklenmiyor',
  'timecode field out of range': 'Zaman kodu alanı aralık dışı',
  'timecode too large': 'Zaman kodu çok büyük',
};

/** timecodeInput bildirim (kelepçe) kodları -> Türkçe cümle. */
const TIMECODE_NOTICES: Record<string, string> = {
  'timecode clamped to project end': 'Proje sonuna oturtuldu',
  'timecode clamped on empty project': 'Proje boş — playhead başta kaldı',
};

/**
 * Ret kodu -> Türkçe cümle (bilinmeyen kod ortak tabloya düşer).
 *
 * `maxFrame` verildiğinde kare alanının ÜST SINIRINI söyleyen varyant döner:
 * "aralık dışı" tek başına, 30 fps'te 30 yazan kullanıcıya nerede durması
 * gerektiğini söylemez.
 */
export function timecodeFailureMessage(
  reason: string | null | undefined,
  opts?: { maxFrame?: number },
): string {
  if (!reason) return 'İşlem uygulanamadı';
  const base = TIMECODE_REASONS[reason] ?? opFailureMessage(reason);
  const maxFrame = opts?.maxFrame;
  if (reason === 'timecode field out of range' && typeof maxFrame === 'number') {
    return `${base} — kare alanı en çok ${maxFrame} olabilir`;
  }
  return base;
}

/** Bildirim kodu -> Türkçe cümle, ya da söylenecek bir şey yoksa null. */
export function timecodeNoticeMessage(notice: string | null | undefined): string | null {
  if (!notice) return null;
  return TIMECODE_NOTICES[notice] ?? opNoticeMessage(notice);
}
