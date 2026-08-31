/**
 * Dev-only visibility for deliberately swallowed errors (best-effort paths).
 *
 * Bazı hatalar TASARIM GEREĞİ yutulur (ör. iptal edilen yüklemenin sunucu
 * tarafı abort çağrısı: kullanıcı için iş zaten bitmiştir, 7 günlük bucket
 * yaşam döngüsü artıkları süpürür). Ama "yut" ile "hiç iz bırakma" aynı şey
 * değildir — bu yardımcı, yutulan hatayı geliştiriciye gösterir:
 *
 *  - DEV'de: `console.warn('[VideoEdit] <mesaj>', err)` — abort/temizlik
 *    başarısızlıkları geliştirme sırasında görünür olur.
 *  - ÜRETİMDE: tamamen sessiz. Karar gerekçesi: bu sınıftaki hataların
 *    hiçbirinde kullanıcının yapabileceği bir eylem yok (best-effort temizlik);
 *    kullanıcıya görünen davranış değişmemeli. Aynı kapı deseni repoda yerleşik:
 *    docStore.refuseWhenLocked / assertDocGateDev (dev'de gürültülü, prod'da
 *    sessiz).
 *
 * Çağrı YERİNDEKİ catch yine gerekçe yorumunu taşır (silentCatchInventory
 * muhafızı bunu zorlar); devWarn o gerekçenin yerine geçmez, görünürlüğünü ekler.
 */
export function devWarn(message: string, err?: unknown): void {
  if (!import.meta.env?.DEV) return;
  if (err === undefined) {
    console.warn(`[VideoEdit] ${message}`);
  } else {
    console.warn(`[VideoEdit] ${message}`, err);
  }
}
