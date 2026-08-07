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
};

/** timelineOps `reason` -> kullanıcıya gösterilecek Türkçe uyarı. */
export function opFailureMessage(reason: string | null | undefined): string {
  if (!reason) return 'İşlem uygulanamadı';
  return REASONS[reason] ?? 'İşlem uygulanamadı';
}
