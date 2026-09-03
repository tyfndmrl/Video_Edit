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
 *
 * DİKEY SINIR (maxScrollY/clampScrollY): yatay ikizin aynısı, piksel
 * uzayında. Dikey kelepçe "vardı" ama JESTİN İÇİNDEYDİ — wheel ve orta-tuş
 * pan'i formülü ayrı ayrı kopyalamıştı, dolayısıyla scrollY yalnız kullanıcı
 * kaydırdığında sınıra çekiliyordu. Track sayısı ya da gövde yüksekliği
 * DEĞİŞTİĞİNDE (undo ile track silme, panelin büyümesi) eski scrollY sınırın
 * dışında kalıyor, altta boş şerit ve kaymış hit-test üretiyordu. Sınır artık
 * burada tanımlı ve TimelinePanel'deki tek yazma yolundan (applyScrollY) her
 * scrollY yazımına — jest olmayan yeniden kelepçelemeye de — uygulanır.
 */
import type { MicroSec } from '@videoedit/timeline-schema';
import { tracksContentHeight } from './geometry';

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

/**
 * İzin verilen en büyük scrollY: son track satırı (+ yeni-track bölgesi)
 * gövdenin altına yapıştığında durur.
 *
 * İçerik gövdeye sığıyorsa 0 döner — kaydıracak bir şey yoktur. Geçersiz
 * (NaN/negatif) girdide sayısal olarak güvenli davranır: track sayısı 0'a,
 * gövde yüksekliği 0'a çekilir; sonsuz/NaN bir sınır kelepçeyi anlamsız
 * kılardı.
 */
export function maxScrollY(trackCount: number, bodyHeightPx: number): number {
  const count = Number.isFinite(trackCount) ? Math.max(0, Math.floor(trackCount)) : 0;
  const body = Number.isFinite(bodyHeightPx) ? Math.max(0, bodyHeightPx) : 0;
  return Math.max(0, tracksContentHeight(count) - body);
}

/**
 * scrollY'yi [0, maxScrollY] aralığına kelepçeler. TimelinePanel'deki TÜM
 * scrollY yazımları (wheel, orta-tuş pan, yeniden kelepçeleme) buradan geçer.
 * Piksel uzayı: yatay ikizinin aksine yuvarlama YAPILMAZ (kesirli translateY
 * geçerlidir ve panScrollY'nin kesirli sonucunu bozmayız).
 */
export function clampScrollY(scrollY: number, maxScrollYPx: number): number {
  const limit = Number.isFinite(maxScrollYPx) ? Math.max(0, maxScrollYPx) : 0;
  if (!Number.isFinite(scrollY)) return 0;
  return Math.min(limit, Math.max(0, scrollY));
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
