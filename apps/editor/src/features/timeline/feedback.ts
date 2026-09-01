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
  // Taşı/yapıştır/çoğalt kare disiplini: kopya, hedef konumda kare sayısını
  // koruyamıyorsa (kaynak penceresi bir kareye bile yetmiyorsa) op reddedilir.
  'clip cannot keep its frame span here': 'Klip bu konumda kare sayısını koruyamıyor',
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
  'no room to ripple the following clips': 'Sonraki klipler kaydırılınca sığmıyor',
  'clip not found': 'Klip bulunamadı',
  'track not found': 'Track bulunamadı',
  'cannot delete the last video track': 'Son video track silinemez',
  'track already at the top': 'Track zaten en üstte',
  'track already at the bottom': 'Track zaten en altta',
  // Partisyon politikası (ozellik-1): ses track'leri yığının altında yaşar;
  // ihlal eden takas reddedilir, düzeltici yön (karışık eski belgede sesi
  // aşağı / videoyu yukarı taşımak) serbesttir.
  'audio tracks stay below video tracks': "Ses track'leri video track'lerinin altında durur",
  // Kırpma/bölme/kaydırma çözücüleri: istenen kenar için kare ızgarasında
  // uygulanabilir bir uzunluk bulunamadı (uç durum — tipik olarak 1 karelik
  // klipler ya da kaynak penceresi tükenmiş yavaşlatılmış klipler).
  'trim failed': 'Kırpma bu konumda uygulanamıyor',
  'split failed': 'Bölme bu konumda uygulanamıyor',
  'split rounding failed': 'Bölme noktası kare ızgarasına oturtulamadı',
  'roll rounding failed': 'Kaydırma kare ızgarasına oturtulamadı',
  'unchanged': 'Değişiklik yok',
  'nothing to move': 'Taşınacak klip yok',
  // Sağ tık menüsü hedef uyuşmazlıkları (menuActions): menü bir klip/track/cetvel
  // hedefiyle açılmadıysa eylemin muhatabı yoktur.
  'no clip target': 'Bu eylem için bir klibe sağ tıklayın',
  'no track target': "Bu eylem için bir track'e sağ tıklayın",
  'no ruler target': 'Bu eylem için cetvele sağ tıklayın',
  'no overlay track': 'Uygun katman track’i yok',
  // Sesi ayırma ön koşulları.
  'only a video clip has detachable audio': 'Yalnız video klibinin ayrılabilir sesi var',
  'clip has no embedded audio': 'Klipte gömülü ses yok (zaten ayrılmış olabilir)',
  // Sessiz kaynak: dosyada ses akışı hiç yok — ayrılacak ses de yok. Aynı
  // gerçeği export'un 'asset-clip-type' kapısı söylerdi; artık menü önden söylüyor.
  'source has no audio stream': 'Kaynak videoda ses akışı yok (sessiz video) — ayrılacak ses yok',
  // AV bağı (linkClips/unlinkClips + sil/böl/taşı kapanışı — ozellik-2).
  'select a video and an audio clip to link': 'Bağlamak için bir video ve bir ses klibi seçin',
  'clip is already linked': 'Klip zaten bağlı — önce bağlantıyı kaldırın',
  'clips are in different groups': 'Klipler farklı gruplarda — önce grupları dağıtın',
  'no linked clip in selection': 'Seçimde bağlı klip yok',
  'linked clip is on a locked track': "Bağlı klip kilitli bir track'te",
  // Kütüphaneden ekleme yolu (asset kapıları).
  'asset not found': 'Medya bulunamadı',
  'asset is not ready': 'Medya henüz hazır değil — işlenmesi bitince ekleyin',
  'asset has no known duration': 'Medyanın süresi bilinmiyor, klip oluşturulamadı',
  'lut is not a clip source': "LUT (.cube) timeline'a eklenmez — Inspector'daki LUT bölümünden bir klibe uygulayın",
  // Otomatik AV ayrımı (ozellik-3): yeni track gerektiren ekleme, sunucu
  // tavanını (50 track) aşacaksa TÜMÜYLE reddedilir — kısmi başarı yasak.
  'track limit reached': 'Track sınırına ulaşıldı (50)',
  'only an image asset can be a sticker': 'Çıkartma yalnız görsel (resim) dosyadan eklenir',
  'invalid opacity': 'Geçersiz opaklık değeri',
  'no text clip in selection': 'Seçimde metin klibi yok',
  'no shape clip in selection': 'Seçimde şekil klibi yok',
  // Keyframe op'ları (features/keyframes) — aynı uyarı yüzeyini kullanır.
  'no keyframe at this time': 'Bu karede keyframe yok',
  'a keyframe already exists at this time': 'Bu karede zaten bir keyframe var',
  'invalid keyframe value': 'Geçersiz keyframe değeri',
  'empty transform patch': 'Uygulanacak dönüşüm değişikliği yok',
  // Geçişler (rendering-semantics §5).
  'no adjacent clip at this cut': 'Geçiş yalnız bitişik iki klip arasına eklenir',
  'clips are not adjacent': 'Geçiş yalnız bitişik iki klip arasına eklenir',
  'a transition is already here': 'Bu kesimde zaten bir geçiş var',
  'no transition at this cut': 'Bu kesimde geçiş yok',
  'no room for a transition':
    'Geçiş için yer yok — kaynak payı ya da klip süresi 2 kareye yetmiyor',
  // Dışa aktarıcının reddettiği bileşimlerin ÖN engelleri (timelineOps'taki
  // "yönlendir-sonra-reddet" bölümü). Metinler ÇIKIŞ YOLUNU da söyler: kapalı
  // bir düğmenin yanında "olmaz" demek kullanıcıyı çıkmazda bırakıyor.
  'a keyframed clip cannot take a transition':
    'Kesimin kliplerinde keyframe var — geçişte iki klip tek akışa katlandığı için '
    + 'yerleşim sabit olmalı. Önce animasyonu temizleyin',
  'the clip has a transition':
    'Bu klipte geçiş var — geçişli kliplerin yerleşimi sabit olmalı, keyframe eklenemez. '
    + 'Önce geçişi kaldırın',
  'scale keyframes cannot be combined with rotation':
    'Ölçek animasyonu ile döndürme birlikte kullanılamaz — dışa aktarım katmanı kırpardı',
  'rotation cannot be combined with scale keyframes':
    'Ölçek animasyonu varken döndürme değiştirilemez — önce ölçek animasyonunu temizleyin',
  'channel is not animatable on this clip': 'Bu klipte bu özellik animasyonlanamaz',
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
  'transform applied to transition neighbours':
    'Yerleşim geçişli komşu klibe de uygulandı (geçişli kliplerin yerleşimi aynı olmalı)',
  // Dönme ara tuvali büyütür (köşegen): dönme yazılınca mevcut ölçek yeni
  // tavanın üstünde kaldıysa op ölçeği tavana indirir ve bunu söyler.
  'scale clamped by rotation canvas':
    'Ölçek, dönme ara tuvali 8192 px sınırına sığsın diye küçültüldü',
  // Otomatik AV ayrımı (ozellik-3): ses ikizi boş/kilitsiz bir ses şeridi
  // bulamayınca yeni bir track açıldı — sessizce değil, söyleyerek.
  'audio placed on a new track': "Ses yeni bir track'e yerleştirildi",
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
