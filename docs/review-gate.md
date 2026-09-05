# Baş Mimar Denetim Kapısı (bağlayıcı)
Son güncelleme: 2026-09-05.

Hiçbir iş dilimi (milestone parçası, alt sistem, düzeltme turu) bu kapıdan geçmeden
"tamam" sayılmaz ve kullanıcıya teslim edilmez.

## Neden bu doküman var

2026-08-07'de ürün "baş mimar onayı" ile teslim edildi ve kullanıcı ilk denemesinde
"kırpma/taşıma/katman, undo-redo, mouse kısayolları, sağ tık çalışmıyor" dedi. Kök neden
üründe değil **denetim sürecindeydi**: teslime kadar yazılan tüm "E2E" testleri store'u
doğrudan çağırıyordu (sentetik `pointerdown`, `setPointerCapture`'da patladığı için
handler'a hiç girmiyordu). Canvas'a tek bir gerçek fare olayı gitmemişti; denetim de bu
kanıtı sorgulamadı. Aşağıdaki kurallar o hatanın tekrarını engeller.

## Kurallar

1. **Üç mercekli adversarial denetim.** Her dilim en az üç bağımsız denetçiyle incelenir
   (tipik: sözleşme/doğruluk, güvenlik/dayanıklılık, istemci/altyapı). Denetçi bulgularını
   dosya/satır kanıtıyla verir; kanıtsız iddia `low` işaretlenir.

2. **Denetçi iddiaları kabul etmez, kendi koşar.** İnşa ajanının raporundaki test
   sonuçları kanıt değildir. Denetçi (ve kapanışta orkestratör) şunları kendisi çalıştırır:
   - `dotnet build backend/VideoEdit.sln` + `dotnet test` (MinIO ayaktaysa `MINIO_AVAILABLE=1`)
   - `pnpm -r test` + `pnpm --filter @videoedit/editor exec tsc -b`
   - `pnpm --filter @videoedit/editor test:e2e`

3. **UI etkileşimi için tek geçerli kanıt: gerçek girdi.** Bir etkileşimin "çalıştığı"
   ancak Playwright'ta `page.mouse` / `page.keyboard` ile doğrulanmışsa söylenebilir.
   `dispatchEvent`, sentetik `PointerEvent` ve store fonksiyonunu doğrudan çağırmak
   **kanıt sayılmaz**. Yeni etkileşim ekleyen her dilim `apps/editor/e2e/` altına test ekler.

4. **Kapsam kayması kontrolü.** Denetim, kullanıcının **ilk gereksinim listesiyle**
   karşılaştırma yapar. Bir gereksinim sonraki milestone'a itilmişse bu bilinçli bir karar
   olarak `docs/backlog.md`'ye yazılır ve teslim notunda AÇIKÇA belirtilir; sessizce
   ertelenemez. (Sağ tık menüsü ve işlem geçmişi paneli bu şekilde kaçmıştı.)

5. **Kapanış şartı.** Kritik ve yüksek bulguların tamamı kapatılmadan dilim kapanmaz.
   Orta/düşük bulgular `docs/backlog.md`'de milestone'a eşlenir; kaybolmaz.

6. **Karar arşivi.** Her denetimin ham çıktısı `docs/audits/` altına JSON olarak yazılır
   (`m0-denetim.json` … `nihai-degerlendirme.json`). Teslim kararları da buraya arşivlenir.

7. **Teslim kararı ONAY/RED.** Nihai değerlendirmede baş mimar açık karar verir. RED ise
   her blocker için somut çözüm tarifi yazılır; blocker'lar kapatılıp değerlendirme
   TEKRARLANIR (tek turda onaya çevrilmez).

8. **ÜÇ ROL ve BULGU SINIFLARI** (2026-09-05, panel turunun 8 commit'lik denetim
   döngüsünden çıkan kural). Denetim ÜÇ merceklidir: **baş mimar** (sözleşmeler, belge ↔
   kod), **baş mühendis** (dört kapı + tam suite + perf + kararlılık), **baş geliştirici**
   (kod kalitesi, muhafız defterleri, sahte/mock sadakati). Her rol her bulguyu şu üç
   sınıftan birine koyar ve sınıfı GEREKÇELENDİRİR:
   - **MADDİ** — ürünün DAVRANIŞINI ya da kullanıcıya GÖSTERİLEN bir iddiayı yanlış yapar.
   - **KANIT** — davranış doğru ama bir ispat, iddia ettiğinden zayıf.
   - **KOZMETİK** — okunabilirlik/tutarlılık/borç.
   Rapor AÇIKÇA şuna cevap verir: *"Bu HEAD'i sürüm engelleyici bir kusur taşıyor mu?"*
   **RED yalnız MADDİ bulgu için verilir**; KANIT/KOZMETİK bulgular ONAY'ı ENGELLEMEZ,
   `docs/backlog.md`'ye yazılır. Bu ölçüt DÖNGÜNÜN KAPANMA ŞARTIDIR: onsuz her tur bir
   öncekinin yamasında daha dar bir delik bulur ve kapanış gelmez (ölçüldü: kural 8'den
   önce altı ardışık tur, hepsi RED, hiçbiri ürün kusuru değil).

9. **AYNI HEAD kuralı.** Kapanış turunda roller AYNI commit'i denetler ve ARALARINDA
   DÜZELTME YAPILMAZ. Sırayla düzeltmek, her denetçiye bir öncekinin taze yamasını
   inceletir ve bulguları zincirler; ölçülen sonuç ping-pong'dur.

10. **Bir muhafızı kırmak onu DOĞRULAMAZ** — yalnız kırdığın YOLU doğrular. Aynı ihlali
    en az iki farklı yoldan dene. Kaynak taraması yalnız SAYDIĞI YAZILIŞI savunur; bir
    grafı/durumu doğrulamak için onu KURMAK gerekir. (Ölçüldü: ses tap'i muhafızının beş
    kaynak-tarayan sürümü ardışık beş turda kör çıktı — sonuncusu önizleme tamamen
    susarken tüm paketi yeşil bırakıyordu. Davranış testine geçildi; sonra onun SAHTESİ
    gerçek Web Audio'dan üç noktada sapıyor çıktı.)

## Denetimden geçmiş dilimler

| Dilim | Bulgu | Sonuç |
|---|---|---|
| M0 | 37 (1 kritik) | kritik+yüksek kapatıldı |
| M1 | 37 (6 yüksek) | kapatıldı |
| M2 | 33 (4 kritik) | kapatıldı |
| M3 | 25 (7 yüksek) | kapatıldı |
| Nihai teslim (1. tur) | 4 blocker | **RED** |
| Nihai teslim (2. tur) | — | ONAY |
| Teslim sonrası kullanıcı testi | gerçek fare tanısı | auto-fit/sağ tık/geçmiş paneli eksikleri kapatıldı + Playwright katmanı eklendi |
