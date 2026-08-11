/**
 * pan — orta fare tuşuyla (button === 1) sürükleyerek kaydırma matematiği +
 * yatay kaydırmanın ÜST SINIRI.
 *
 * Tutulan içerik parmakla beraber gider: imleç sağa giderse daha ERKEN zaman
 * görünür (scrollUs azalır), aşağı giderse daha YUKARIDAKİ track'ler görünür
 * (scrollY azalır). Saf fonksiyonlar — pointer kodundan bağımsız test edilir.
 *
 * Neden üst sınır: dikey pan'in [0, maxScrollY] kelepçesi vardı, yatay pan'in
 * yoktu. Tek bir orta-tuş sürüklemesi scrollUs'u içerik sonunun kat kat
 * ötesine atabiliyordu (ölçüldü: 6 sürüklemede 0 -> 486 975 648 µs, içerik sonu
 * 82 000 000 µs) ve kullanıcı "timeline boşaldı" diyordu — bu dilimin kök
 * nedeni buydu. Sınır artık TEK yerde tanımlı ve orta-tuş pan'i, Shift+wheel
 * ve zoom dahil her scrollUs yazımına uygulanır.
 */
import type { MicroSec } from '@videoedit/timeline-schema';

/**
 * İçeriğin sonundan sonra bırakılabilecek boşluk, görünür genişliğin oranı
 * olarak. Sıfır olsaydı içerik sonu tam sağ kenara yapışırdı (son klibin
 * sonuna klip eklemek/uzatmak için nefes payı kalmazdı); 1'e yakın olsaydı
 * ekran yine boşalırdı. 0.25 => içerik sonu en kötü ihtimalle görünür alanın
 * %75'inde durur, yani ekranda DAİMA içerik kalır.
 */
export const PAN_TAIL_FRACTION = 0.25;

/**
 * İzin verilen en büyük scrollUs: içeriğin sonu görünür alandan çıkmasın.
 *
 * max(0, contentEndUs - viewportUs) + kuyruk payı — proje boşken (contentEndUs
 * = 0) yalnız kuyruk payı kadar kaydırılabilir. Geçersiz zoom/genişlikte 0
 * döner (sonsuz/NaN bir sınır her şeyi serbest bırakırdı).
 */
export function maxPanScrollUs(
  contentEndUs: MicroSec,
  viewportWidthPx: number,
  pxPerUs: number,
): MicroSec {
  if (!(pxPerUs > 0) || !Number.isFinite(pxPerUs)) return 0;
  if (!(viewportWidthPx > 0) || !Number.isFinite(viewportWidthPx)) return 0;
  const viewportUs = viewportWidthPx / pxPerUs;
  const end = Number.isFinite(contentEndUs) ? Math.max(0, contentEndUs) : 0;
  return Math.round(Math.max(0, end - viewportUs) + viewportUs * PAN_TAIL_FRACTION);
}

/**
 * scrollUs'u [0, maxScrollUs] aralığına kelepçeler. TimelinePanel'deki TÜM
 * scrollUs yazımları (pan, Shift+wheel, zoom, fit) buradan geçer.
 */
export function clampScrollUs(scrollUs: MicroSec, maxScrollUs: MicroSec): MicroSec {
  const limit = Number.isFinite(maxScrollUs) ? Math.max(0, maxScrollUs) : 0;
  if (!Number.isFinite(scrollUs)) return 0;
  return Math.min(limit, Math.max(0, Math.round(scrollUs)));
}

/**
 * Yatay pan: sürükleme başındaki scrollUs + kat edilen piksel farkı,
 * [0, maxScrollUs] aralığına kelepçelenmiş.
 * pxPerUs geçersizse (0/negatif) scroll değişmez — sonsuz/NaN üretmeyiz.
 */
export function panScrollUs(
  startScrollUs: MicroSec,
  startX: number,
  currentX: number,
  pxPerUs: number,
  maxScrollUs: MicroSec = Number.POSITIVE_INFINITY,
): MicroSec {
  const limit = Number.isFinite(maxScrollUs) ? Math.max(0, maxScrollUs) : Number.POSITIVE_INFINITY;
  if (!(pxPerUs > 0) || !Number.isFinite(pxPerUs)) {
    return Math.min(limit, Math.max(0, Math.round(startScrollUs)));
  }
  const deltaUs = (currentX - startX) / pxPerUs;
  return Math.min(limit, Math.max(0, Math.round(startScrollUs - deltaUs)));
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
