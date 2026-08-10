# Baş Mimar Denetim Kapısı (bağlayıcı)

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
