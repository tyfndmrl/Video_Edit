/**
 * pan — orta fare tuşuyla (button === 1) sürükleyerek kaydırma matematiği.
 *
 * Tutulan içerik parmakla beraber gider: imleç sağa giderse daha ERKEN zaman
 * görünür (scrollUs azalır), aşağı giderse daha YUKARIDAKİ track'ler görünür
 * (scrollY azalır). Saf fonksiyonlar — pointer kodundan bağımsız test edilir.
 */
import type { MicroSec } from '@videoedit/timeline-schema';

/**
 * Yatay pan: sürükleme başındaki scrollUs + kat edilen piksel farkı.
 * pxPerUs geçersizse (0/negatif) scroll değişmez — sonsuz/NaN üretmeyiz.
 */
export function panScrollUs(
  startScrollUs: MicroSec,
  startX: number,
  currentX: number,
  pxPerUs: number,
): MicroSec {
  if (!(pxPerUs > 0) || !Number.isFinite(pxPerUs)) return Math.max(0, Math.round(startScrollUs));
  const deltaUs = (currentX - startX) / pxPerUs;
  return Math.max(0, Math.round(startScrollUs - deltaUs));
}

/** Dikey pan: [0, maxScrollY] aralığına kırpılmış piksel kaydırma. */
export function panScrollY(
  startScrollY: number,
  startY: number,
  currentY: number,
  maxScrollY: number,
): number {
  const limit = Math.max(0, maxScrollY);
  return Math.min(limit, Math.max(0, startScrollY - (currentY - startY)));
}
