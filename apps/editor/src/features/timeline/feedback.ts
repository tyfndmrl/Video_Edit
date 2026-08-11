/**
 * feedback — timeline üst barındaki kısa süreli uyarı balonunun metinleri.
 *
 * Sürükleyip bıraktığında hiçbir şey olmaması (sessiz ret) kullanıcıya
 * "çalışmıyor" hissi veriyordu; op sonuçlarının `reason` alanı burada Türkçe
 * bir cümleye çevrilir. Saf ve test edilebilir.
 */

/** Uyarı balonunun ekranda kalma süresi (ms). */
export const WARNING_TTL_MS = 2000;

/** Taşımanın çakışma yüzünden reddedildiği durum (en sık görülen ret). */
export const MOVE_CONFLICT_MESSAGE = 'Buraya sığmıyor — klipler çakışıyor';

const REASONS: Record<string, string> = {
  'overlaps an existing clip': MOVE_CONFLICT_MESSAGE,
  'pasted clips overlap each other': 'Yapıştırılan klipler birbiriyle çakışıyor',
  'track is locked': 'Track kilitli',
  'target track is locked': 'Hedef track kilitli',
  'track type mismatch': 'Track türü uyuşmuyor',
  'target track no longer exists': 'Hedef track artık yok',
  'no track at target position': 'Hedef konumda track yok',
  'before timeline start': 'Zaman çizelgesinin başından öncesine taşınamaz',
  'clipboard empty': 'Pano boş',
  'nothing to delete': 'Silinecek klip yok',
  'nothing to duplicate': 'Çoğaltılacak klip yok',
  'nothing to copy': 'Kopyalanacak klip yok',
  'nothing to cut': 'Kesilecek klip yok',
  'no clip under playhead': "Playhead'in altında klip yok",
  'split point outside clip': 'Bölme noktası klibin dışında',
  'split too close to clip edge': 'Bölme noktası klip kenarına çok yakın',
  'no room to trim': 'Kırpmak için yer yok',
  'no room to roll': 'Kaydırmak için yer yok',
  'clip not found': 'Klip bulunamadı',
  'track not found': 'Track bulunamadı',
  'cannot delete the last video track': 'Son video track silinemez',
  // Geçişler (rendering-semantics §5).
  'no adjacent clip at this cut': 'Geçiş yalnız bitişik iki klip arasına eklenir',
  'clips are not adjacent': 'Geçiş yalnız bitişik iki klip arasına eklenir',
  'a transition is already here': 'Bu kesimde zaten bir geçiş var',
  'no transition at this cut': 'Bu kesimde geçiş yok',
  'no room for a transition':
    'Geçiş için yer yok — kaynak payı ya da klip süresi 2 kareye yetmiyor',
};

/**
 * Başarılı ama KULLANICININ İSTEMEDİĞİ bir düzeltme yapan op'ların bildirimi
 * (OpResult.notice). Geçiş süresinin sessizce kısalması / geçişin sessizce
 * kaybolması "kendi kendine bir şeyler yapıyor" şikayetinin ta kendisidir;
 * rendering-semantics §5.5 kısaltmayı ZORUNLU kılar, bu tablo da onu GÖRÜNÜR
 * kılar.
 */
const NOTICES: Record<string, string> = {
  'transition shortened by source handle':
    'Geçiş süresi kaynak payına göre kısaltıldı',
  'transition shortened by clip length':
    'Geçiş süresi komşu klip süresine göre kısaltıldı',
  'transition removed by edit': 'Kesim bozulduğu için geçiş kaldırıldı',
};

/** timelineOps `reason` -> kullanıcıya gösterilecek Türkçe uyarı. */
export function opFailureMessage(reason: string | null | undefined): string {
  if (!reason) return 'İşlem uygulanamadı';
  return REASONS[reason] ?? 'İşlem uygulanamadı';
}

/** timelineOps `notice` -> Türkçe bilgilendirme (null = gösterilecek bir şey yok). */
export function opNoticeMessage(notice: string | null | undefined): string | null {
  if (!notice) return null;
  return NOTICES[notice] ?? null;
}
