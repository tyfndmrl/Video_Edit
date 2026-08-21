# POC — Bilinen Sınırlar

**Bu doküman ürünü SATMAK için değil, DÜRÜST tanıtmak için yazıldı.** VideoEdit bir POC'tur:
uçtan uca çalışan, testli, ama üretim yükü altında denenmemiş bir sistem. Aşağıdaki maddelerin
her biri **kodda doğrulandı** — iddia edilen her sınırın yanında bir **üye/test adı** ya da bir
**ölçüm** var.

> **Satır numarası atıfları KALDIRILDI (5. tur).** Doküman eskiden "dosya adı + iki nokta +
> satır numarası" biçiminde atıf veriyordu; denetimde 61 atıfın tamamı çözüldü ve **çoğunun
> bayatladığı** görüldü — `scale-keyframes-with-rotation` diye işaret edilen satır artık ilgisiz
> bir `switch` kolunu, frame ızgarası kapısı diye işaret edilen blok başka bir metodu
> gösteriyordu. Satır numarası, ilk düzenlemede yanlışlanan ama yanlışlandığı fark edilmeyen bir
> iddiadır. Yerine **üye ve test adları** yazıldı; onlar yeniden adlandırıldığında derleme ya da
> arama anında yakalanır. (`docs/audits/` altındaki JSON'lar bilinçli olarak DOKUNULMADAN
> bırakıldı: onlar denetim anının ham kaydıdır, düzeltilmesi arşivi tahrif etmek olurdu.)

Okuma sırası: önce **§1 kullanıcıyı ilk gün ısırabilecekler**, sonra §2–§6.

- Doğrulama tarihi: **2026-08-20**, `a1b3a73` + **10.–12. tur** düzeltmeleri (üye/test adı
  atıfları 5. turda ağaca karşı yeniden denetlendi; §5'teki test sayıları ve §0.1'deki
  1,5 GiB'lık uçtan uca ölçüm **12. turda** — bu doküman turunda — bizzat koşuldu)
  - *Bu satır 12. tura kadar "2026-08-13, `d9f045f` + 8. tur" diyordu, oysa §5 kendi giriş
    paragrafında çoktan 2026-08-20 / `a1b3a73` / 10.–11. tur sayılarını taşıyordu: başlık ile
    gövde birbirini yalanlıyordu. İç tutarsızlık 12. turda kapatıldı.*
- Ölçüm makinesi: Intel Core i9-10850K (10 çekirdek / 20 iş parçacığı), 32 GB RAM, Windows 11
- Yığın: .NET 10.0.302, Node v22.14.0, ffmpeg 8.0, PostgreSQL 17, Redis 7, MinIO (R2 yerine)

> **§1'de ÜÇ kapanmış madde var.** §1.1 (görsel/sticker önizlemesi), §1.2 (frame ızgarası) ve
> §1.8 (müzik/ses dosyasıyla export) teslim düzeltme turlarında kapandı. Numaraları ve yerleri
> korundu, çünkü bu dokümanın daha eski bir sürümünü okumuş biri onları aramaya gelir; her biri
> kendi başlığında "[DÜZELTİLDİ]" olarak işaretli ve neyin nasıl değiştiğini yazıyor.

---

## 0. Ölçülmüş performans (gerçek boru hattı, uydurma yok)

Ölçüm yöntemi: API (`:5000`) + worker + MinIO ayaktayken **gerçek HTTP çağrılarıyla** kayıt →
proje → çok parçalı yükleme → worker işleme → timeline kaydetme → export; süreler `Jobs`
tablosundaki `StartedAt`/`CompletedAt` ve istemci duvar saatinden.

**Kaynak dosya:** 122 MB / 120 sn / 1920×1080 / 30 fps / 8.1 Mbps H.264 + AAC.

| Aşama | Ölçüm | Gerçek zamana göre | Not |
|---|---|---|---|
| Çok parçalı yükleme (116 MiB, 2 parça) | **0.6 – 1.0 sn** | — | LOKAL MinIO (120–184 MiB/s). Gerçek R2'de bu sayı tamamen **internet hızınıza** bağlıdır — bu satır bir performans vaadi DEĞİLDİR. |
| İşleme: 540p proxy + filmstrip + waveform + poster | **10.8 – 12.8 sn** | 120 sn kaynak → ~**10× hızlı** | Bu süre boyunca medya kitaplıkta "İşleniyor" görünür; timeline'a eklenemez. |
| Export — 60 sn çıktı, TEK klip, efekt/overlay yok | **10.8 sn** (render 7.7 sn) | ~**7.8× hızlı** | Kuyruk + indirme + yükleme payı dâhil 10.8 sn |
| Export — 60 sn çıktı, 2 klip + crossfade + colorAdjust + metin + şekil | **33.4 sn** (render 28.9 sn) | ~**2.1× hızlı** | Aynı süre, aynı çözünürlük — sadece kompozisyon karmaşık |

> **Nasıl okunmalı.** 1080p CRF18 `veryfast` libx264 tek makinede koşuyor. Aynı uzunluktaki
> iki çıktı arasındaki **3.8 kat fark** kompozisyon karmaşıklığından gelir: katman sayısı,
> geçiş, keyframe ve overlay rasteri filtre grafiğini büyütür. Yani "60 saniyelik video 10
> saniyede çıkar" **doğru değildir** — projeye bağlıdır. Uzun ve katmanlı projelerde
> (10+ dakika) export'un dakikalar süreceğini varsayın.

Bu tablonun **son iki satırı** 122 MB'lık kaynağın taşıyıcı export ölçümüdür. Dokümanın
verdiği DİĞER export sayıları **yalnız** aşağıdaki §0.1'dedir (1,5 GiB'lık kaynak); başka
hiçbir yerde export süresi iddia edilmiyor. Önceki sürümde burada geliştirme veritabanındaki başarılı iş sayısı ve ortalaması
duruyordu ("47 iş, ort. 2.58 sn"); o satır **her e2e koşumundan sonra kendiliğinden
yanlışlanıyordu**: yalnız bu doküman turunda 47'den 69'a çıktı, çünkü e2e paketi kısa
fixture'larla export koşuyor. Sayıyı düzeltmek yerine kaldırdık: bir teslim
dokümanında, okunduğu anda yanlış olacağı bilinen bir sayının yeri yoktur. Ortalamanın
anlattığı şeyi zaten yukarıdaki iki satır daha dürüst anlatıyor.

### 0.1 1,5 GiB'lık kaynak — kullanıcının SÖYLEDİĞİ boyutta tek bir uçtan uca ölçüm (12. tur, 2026-08-20)

Kullanıcının ilk mesajı **"dosya boyutları ortalama 1-2 gb aralıklarında oluyor. Bu süreç nasıl
olmalı performanslı ve hızlı olmalı"** diyordu. Yukarıdaki §0 tablosu **122 MB**'lık bir kaynakla
ölçülmüştü; 1-2 GB rejimi **hiç denenmemişti** (depoda 4 GiB yalnız bir doğrulama SABİTİ olarak
duruyordu). Aşağıdaki satırların tamamı **tek bir koşumda**, ürünün KENDİ yolundan ölçüldü.

**Kaynak dosya (ffmpeg ile üretildi).** 1 618 733 974 bayt = **1,51 GiB**; 640,000 sn (10:40);
1920×1080; 30 fps; H.264 **20,0 Mbps** + AAC 196 kbps stereo 48 kHz; 19 200 video karesi.
İçerik `testsrc2` üstüne **zamansal film greni** (`noise=alls=18:allf=t+u`) ve frekansı gezinen
stereo ton: her kare farklıdır ve gren kareler-arası tahmini işe yaramaz kılar — yani çözücü de
kodlayıcı da gerçekten yorulur (statik kare DEĞİL). Üretimi bu makinede 156 sn sürdü.

**Yol.** Tarayıcıda **gerçek fareyle** "Dosya seç" düğmesine basıldı, tarayıcının KENDİ dosya
seçici olayı yakalandı ve dosya oraya verildi; parçalama, imzalı PUT'lar, ETag toplama ve
`complete` çağrısı ürünün istemci motorudur (`features/library/upload/uploadEngine.ts`).
**İşletim sistemi dosya diyaloğu sentetik girdiyle sürülemez** — betiğin yaptığı tek "yapay" iş
seçiciye dosya yolunu vermektir; ondan sonrası üründür. Süreler `Jobs` tablosunun
`StartedAt`/`CompletedAt`/`ProgressStage` alanlarından **0,4 sn çözünürlüklü** bir yoklayıcıyla
ve istemcinin duvar saatinden alındı (aşama sınırlarının payı ±0,4 sn).

| Aşama | Ölçüm | Gerçek zamana göre | Not |
|---|---|---|---|
| Çok parçalı yükleme (**25 parça**: 24 × 64 MiB + 8 121 238 B artık) | **5,04 sn** → ~321 MB/sn | — | Seçiciden `complete` 200'e kadar. Parça PUT'ları tek başına 4,53 sn (~357 MB/sn), **en fazla 4 eşzamanlı** PUT; `init` 28 ms, **2** presign isteği (7,7 / 18,7 ms — parti başına en çok 20 parça), `complete` 49 ms. **LOKAL MinIO, loopback** — gerçek R2'de bu satır tamamen internet hızınızdır, performans vaadi DEĞİLDİR. |
| Kuyruğa alınma | 1,6 sn | — | `complete` 200 → worker işi aldı |
| **İşleme (toplam)** | **68,9 sn** | 640 sn kaynak → ~**9,3× hızlı** | İş satırının `StartedAt`→`CompletedAt` farkı |
| ├ orijinali indirme (1,51 GiB) | ~2,7 sn | — | MinIO → worker diski, lokal |
| ├ ffprobe | ~0,8 sn | — | |
| ├ **540p CFR proxy** | **38,7 sn** | ~**16,5× hızlı** | İşlemenin **%56**'sı |
| ├ **filmstrip (3 sprite)** | **24,7 sn** | — | İşlemenin **%36**'sı |
| ├ waveform | ~0,4 sn | — | |
| └ türev yükleme + poster | ~1,5 sn | — | Alt aşamalar aşama geçişlerinin ORTA noktasından hesaplandı; toplamları 68,9 sn'yi verir |
| **Dosya seçiciden "Hazır" rozetine** | **75,6 sn** | — | Kullanıcının GÖRDÜĞÜ toplam (yükleme + kuyruk + işleme + UI yoklaması) |
| Timeline'a alma (kitaplıkta çift tık) | **0,34 sn** | — | Klip süresi tam 640 000 000 µs |

**Türevler (bir 1,51 GiB kaynağın ürettiği her şey).**

| Türev | Boyut | Not |
|---|---|---|
| 540p proxy (H.264 + AAC) | 123 263 560 B (**117,6 MiB**) | orijinalin **%7,6**'sı |
| filmstrip | **3 sprite** + manifest | `sprite_1..3.jpg`, 30×10 döşeme, 160×90 karo, 1 sn aralık, **640 kare**; toplam 1 283 649 B |
| waveform | 165 243 B | |
| poster | 51 232 B | |
| **toplam türev** | 124 763 684 B | orijinalin **%7,7**'si |

**Export (aynı kaynak, dört koşum).** Kesme GERÇEK fareyle yapıldı: "Fit" → cetvele tıklayarak
playhead **tam 60,000000 sn**'ye → klip üstünde sağ tık → "Playhead'de böl" → kuyruk klibi
seçilip `Delete`. Kalan klip **tam 60 000 000 µs**.

| Export | Kaynak cache'te? | İş süresi | render | çıktı |
|---|---|---|---|---|
| 60 sn'lik kesim (1.) | hayır (SOĞUK) | **16,62 sn** | **12,4 sn** (~4,8× hızlı) | 215 311 057 B |
| 60 sn'lik kesim (2.) | evet | 15,36 sn | 13,2 sn | 215 311 057 B |
| 60 sn'lik kesim (3.) | evet | 16,22 sn | 13,9 sn | 215 311 057 B |
| **TAM 10:40'lık çizelge** | evet | **181,3 sn** | **162,7 sn** (~3,9× hızlı) | 2 308 102 557 B |

- Kullanıcının gördüğü duvar saati (diyalogdaki "Dışa aktar"a basıştan "Tamamlandı" rozetine):
  60 sn'lik kesimde **19,5 / 20,5 sn**, tam 10:40'lık çizelgede **184,2 sn**. Aradaki fark
  kuyruk gecikmesi + UI yoklamasıdır; kuyruğa alınma bu koşumlarda **0,4 – 4,3 sn** arasında
  gezindi (Hangfire yoklaması).
- **Üç 60 sn'lik koşumun çıktısı bayt sayısı olarak BİREBİR aynı** (215 311 057) — render bu
  belgede belirlenimci davrandı. Bu bir belirlenimcilik İSPATI değildir (boyut eşitliği içerik
  eşitliği demek değil), yalnız gözlemdir.
- Çıktı profili 1080p CRF18 `veryfast`: 60 sn çıktı **28,5 Mbps**, 10:40'lık çıktı **28,85 Mbps**
  — yani **kaynaktan (20 Mbps) DAHA BÜYÜK**. Grenli/gürültülü kaynakta CRF18 bunu yapar.
- 60 sn'lik çıktıyı indirip **kendim ffprobe'ladım**: 60,000000 sn, 1800 kare, 1920×1080@30,
  H.264 + AAC 194 kbps. 2,15 GiB'lık 10:40 çıktısını **indirmedim** — yalnız boyutunu
  (presigned GET + `Range` → HTTP 206) ve işin KENDİ doğrulamasını gördüm (`ExportJob` çıktıyı
  ffprobe'lar ve beklenenden ±1 sn saparsa işi düşürür, bkz. `OutputDurationToleranceUs`).
- **Çıktının depoya yüklenmesi ikiye ayrılıyor:** 205 MiB'lik çıktı tek `PutObject` ile
  **~1,3 sn**'de, 2,15 GiB'lik çıktı **multipart** yolundan (>256 MiB) **~18 sn**'de yüklendi.
- **LRU cache isabeti ÖLÇÜLDÜ:** soğuk export'ta orijinalin indirilmesi ~2,4 sn sürüyor;
  cache isabetli üç export'ta indirme aşaması yoklayıcının **0,4 sn'lik çözünürlüğünün altına**
  düştü (aşama neredeyse hiç görünmedi).

**Disk.**

| Ölçüm | Değer |
|---|---|
| İşleme sırasında worker çalışma dizini (`%TEMP%\videoedit-worker`) tepe | 1 743 497 797 B (**1,62 GiB**) — orijinal + proxy |
| Export sırasında worker çalışma dizini tepe | 2 308 103 275 B (**2,15 GiB**) — 10:40'lık çıktı |
| **Tepe toplam (LRU cache + worker dizini)** | **3 926 837 249 B = 3,66 GiB** |
| İş bittikten sonra worker dizini | **0** (her iki iş türü de temizliyor) |
| LRU cache (export'lardan HEMEN SONRA) | 1 girdi, 1 618 733 974 B = **1,51 GiB** |

- **LRU tavanıyla etkileşim.** Cache **orijinali** tutar (proxy'yi değil). Tavan 20 GiB
  (`ProcessingOptions.MaxCacheBytes`), yani bu boyutta **~13 kaynak** dolduruyor; 14.'sü en
  eskiyi süpürür ve süpürme **asset dizini bütün** olduğu için o kaynağın bir sonraki export'u
  indirmeyi baştan öder. *(Güncelleme 2026-08-21: süpürmenin MEKANİZMASI artık entegrasyon
  testli — `OriginalCacheLruTests`, tavan test-yerel 250 KB'a indirilerek gerçek MinIO
  indirmeleriyle: en eski girdi düşer, cache isabetiyle tazelenen ve PİNLİ girdiler korunur,
  süpürme tavana inince durur; negatif kontrol pin'siz aynı kurulumda en eskinin gerçekten
  silinmesi. 20 GiB tavan + GB'lık dosya ÖLÇEĞİ hâlâ koşulmadı — mekanizma ölçüldü, ölçek
  değil.)*
- **[DÜZELTİLDİ — 2026-08-21] Cache ölçümü ZAMAN DAMGALIDIR — çünkü BİRİM TESTLERİ bu dizini
  siliyordu (ölçülmüştü).** `ExportJobTests` artık test-yerel bir `CacheDirectory` ile kurulur
  ve `Run_DiskFullPath_NeverTouchesTheMachineWideCache` makine köküne konan nöbetçi girdinin
  disk-full koşusundan sağ çıktığını her koşumda doğrular. Tarihçe (kayıt için):
  Yukarıdaki "1 girdi / 1,51 GiB" satırı export'lardan hemen sonra alındı. Daha sonra backend
  paketi koşunca cache **boş** bulundu ve nedeni ölçülerek bulundu: `ExportJobTests`
  `new OriginalCache(storage, new ProcessingOptions())` kuruyor — `CacheDirectory` boş olduğu
  için `OriginalCache.Root` MAKİNE GENELİNDEKİ `%TEMP%\videoedit-cache`'e düşüyor; disk-darlığı
  testi `TrimAsync(0)` çağırınca oradaki **gerçek** girdiler siliniyor. Kanıt (negatif kontrol):
  cache'e 1 MiB'lik sahte bir girdi konup **yalnız** o tek test koşuldu → girdi **silindi**
  (öncesi 1 dizin, sonrası 0). Konteynerde etkisi yoktur (her sürecin kendi `TMPDIR`'i var);
  geliştirici makinesinde gerçek veri siler. Kayıt: `docs/backlog.md` 12. tur.
- **[DÜZELTİLDİ — 2026-08-21] Disk rezervasyonu tahmini bu rejimde KISA KALIYORDU (ölçülmüş
  bulguydu).** Ölçülen kusur: 10 Mbps sabit varsayım 10:40'lık iş için 2 902 480 768 B derken
  gerçek tepe 3 926 837 249 B olmuştu (1,35 kat). Tahmin artık kaynağın ÖLÇÜLMÜŞ bit hızını
  kullanıyor: `ExportJob.EffectiveOutputBitsPerSecond` = max(profil, kaynak SizeBytes×8e6/süre).
  Yeni ölçüm (`ExportDiskEstimateTests`, gerçek export): 113,8 Mbps'lik rastgele-içerikli
  kaynakta gerçek ayak izi 156 436 793 B; eski formül 109 932 895 B derdi (ALTINDA), yeni
  formül 187 793 641 B diyor (KAPSIYOR). Düşük bit hızlı kaynakta yeni tahmin eskisiyle bire
  bir aynı (profil tabanı — şişme yok). Kayıt: `docs/backlog.md` 12. tur (kapanış notuyla).
- Sistem diskinin boş alanı koşum boyunca en dip noktada **9,56 GB** düşmüştü; koşum sonrası
  (worker dizini boşaldıktan sonra) kalıcı düşüş **7,35 GB**. Bunun ~4,70 GB'ı MinIO'nun sakladığı
  nesneler (orijinal + türevler + dört export çıktısı), 1,62 GB'ı LRU cache; kalan ~1 GB
  Docker/WSL2 sanal diskinin geri vermediği alandır (bu son kalem ÜRÜNE ait değildir).

**Kota.** Ölçüm hesabı sıfırdan başladı: `usedBytes` 0 → **1 618 733 974** / 21 474 836 480
(20 GiB); `assetCount` 0 → 1. Kitaplık başlığındaki gösterge kullanıcıya **"1.51 GB / 20.0 GB · %8"**
yazdı ve kart meta satırı **"10:40 · 1920×1080 · 1.51 GB"** oldu. Tek dosya tavanı 4 GiB
(`QuotasOptions.MaxFileSizeBytes`) olduğu için 1-2 GB rahat geçiyor; 20 GiB'lik toplam kotaya
bu boyutta **13 dosya** sığıyor. *(Güncelleme 2026-08-21: kota artık orijinal + TÜREV
toplamını sayar — işleme hattı türev toplamını `Asset.DerivedBytes`'a yazar, InitUpload reddi
ve `/api/quota` göstergesi `SizeBytes + DerivedBytes` okur. Bu ölçüm turundaki "türevler
sayılmaz, 20 GiB aslında ~21,5 GiB" cümlesi ESKİ davranışı anlatıyordu ve kapandı; bu turdan
ÖNCE işlenmiş eski asset'lerin türev defteri NULL'dur ve 0 sayılır — onların türevleri
geçmişe dönük faturalandırılmaz.)*

> **Bu bölümün sınırları — ne İDDİA EDİLMİYOR.** (a) Ölçüm **tek koşumdur** (yalnız 60 sn'lik
> export üç kez tekrarlandı); (b) nesne deposu **lokal MinIO**'dur, gerçek ağ/gerçek R2 yoktur
> (§4.2); (c) tek kullanıcı, tek worker, tek eşzamanlı export (§4.1) — **eşzamanlı yük
> ölçülmedi**; (d) **2 GB'ın üstü ve 4 GiB tavanının kendisi denenmedi**; (e) yarım kalan
> yüklemenin devamı / ağ koparma senaryosu ölçülmedi (§1.4); (f) bu makine: i9-10850K,
> 32 GB RAM, NVMe. Başka bir makinede proxy ve render süreleri **doğrudan** değişir.

---

## 1. Kullanıcıyı ilk gün ısırabilecek sınırlar

### 1.1 [DÜZELTİLDİ — teslim düzeltme turu, 2026-08-12] Fotoğraf ve sticker klipleri önizlemede çizilmiyordu

> Bu madde **kapandı**. Kayıtta kalmasının nedeni, dokümanın ilk sürümünü okuyup ürünü
> denemiş olanlara neyin değiştiğini göstermektir.

**Neydi.** Timeline'a bir görsel (PNG/JPG/WebP) klibi ya da sticker koyduğunuzda oynatıcı
tuvali o klip boyunca **siyah** kalıyordu. Klip timeline'da vardı, seçilebiliyordu, gizmo ile
taşınabiliyordu, **export'a doğru giriyordu** — ama önizlemede çizilmiyordu.

**Neden.** Zincir üç yerde birden tutarsızdı:

1. Worker görsel asset için **proxy ÜRETMEZ** — yalnız poster üretir
   (`ProcessAssetJob.ProcessImageAsync`, yorum: "Image için proxy
   ÜRETİLMEZ"; `ThumbnailKey` set edilir, `ProxyKey` edilmez). *Bu hâlâ böyledir; değişen,
   önizlemenin ne istediğidir.*
2. `GET /api/projects/{id}/media-urls` bu yüzden görsel için `proxy: null` döner.
3. Oynatıcının asset çözücüsü **koşulsuz `proxyUrl` okuyordu** → `url` null → `imageDrawItem`
   çizmeden dönüyordu (`engine-video/engineV1.ts`, `imageDrawItem`).

**Düzeltme (bu teslim turu).** Kaynak seçimi asset **KIND'ına** göre karar veren tek bir saf
fonksiyona alındı: `apps/editor/src/features/player/previewSource.ts` — video/ses `proxy`,
görsel **`poster`** okur. Poster her hazır görselde zaten vardır; `PosterRecipe` kaynak
en-boy oranını korur, genişliği **1280 px**'e sınırlar (`PosterRecipe.MaxWidth`) ve HDR
kaynakta proxy/export ile **aynı** tonemap zincirini koşar — yani görselin "proxy"
karşılığıdır. `PlayerPanel.tsx` artık `previewSourceUrl(asset)` çağırıyor. Sticker'ın ayrı
bir vakası yok: sticker klibi bir IMAGE asset'ine bakar ve karar klip türüne değil asset
türüne göre verilir.

**Doğrulama — GERÇEK PİKSEL** (`apps/editor/e2e/image-preview.spec.ts`, gerçek fare, gerçek
medya). Worker'ın gerçekten işlediği iki görsel (JPEG + macenta PNG) timeline'a konur ve
önizleme kompozitöründen `window.__videoeditPlayer.probePixel` ile — çizimle **aynı karede**
`gl.readPixels` — okuma yapılır. Test şunları ayrı ayrı kanıtlar:

- fotoğrafın `fit=contain` kutusundaki **25 noktanın 25'i** siyah değil;
- aynı örnekte **≥ 4 farklı renk** var (düz bir dolgu "siyah değil" testini geçerdi, bunu
  geçemez);
- kutunun dışındaki **letterbox bandı hâlâ tam siyah** (yani "her yer boyandı" yanlış-pozitifi
  değil, görüntü gerçekten yerine oturmuş);
- süresi sunucuda `null` bildirilen macenta PNG'nin her örneği macenta;
- overlay katmanına eklenen **çıkartma**, altındaki fotoğrafın üstünde macenta okunuyor.

**Aynı turda kapanan yan bulgu.** Timeline'a görsel eklemek doküman değişmezini ihlal
ediyordu (`sourceOutUs (4000000) exceeds asset duration (…)`): API görsel süresini PNG'de
`null`, JPEG'de **40 000 µs** bildiriyor (`image2` demuxer, varsayılan 25 fps'te tek kare) —
yani yalnız `null`'a bakan bir düzeltme JPEG vakasını kaçırırdı. Görselin süresi dosyadan
değil **klipten** gelir (4 sn, `IMAGE_DEFAULT_DURATION_US`), tıpkı derleyicinin `-loop 1` ile
açtığı gibi. `knownAssetDurations()` artık görsel asset'leri haritaya hiç koymuyor
(`apps/editor/src/state/timelineOps.ts`, `knownAssetDurations`) ve sayı olmayan `durationUs` değerlerini
düşürüyor. Test `docInvariantIssues(page)`'in boş kaldığını ve konsola tek bir invariant
hatası düşmediğini de doğruluyor.

### 1.2 [DÜZELTİLDİ — teslim düzeltme turu, 2026-08-12] Frame ızgarası çelişkisi: bazı klipler export'ta 422 alıyordu

> Bu madde **kapandı**; kayıtta kalmasının nedeni, ürünü daha önce denemiş olanların gördüğü
> davranışı ve düzeltmenin ne olduğunu açıklamaktır. Düzeltme **iki turda** tamamlandı — ilk
> tur sözleşmeyi düzeltti, ikinci tur ilk turun iki gerçek boşluğunu kapattı; ikisi de
> aşağıda yazılı, çünkü "kapattık" demenin dürüst hali eksik kalanı da söylemektir.

**Neydi.** Export derleyicisi her klipte HEM `timelineStartUs` HEM `timelineDurationUs`
için frame ızgarası hizası istiyordu. Ama ızgara **toplama altında kapalı değildir**: 30
fps'te frame 1 = 33 333 µs, frame 2 = 66 667 µs, aradaki fark **33 334 µs** ve bu sayı
ızgarada yoktur. Yani kenarları kusursuz hizalı bir klip **süresi yüzünden** reddediliyordu.
Sözleşme kendi içinde çelişkiliydi: frame defterinin ihtiyacı `startFrame`/`endFrame` — yani
**kenarlar**; süreyi ızgarada istemek yanlış invaryanttı.

**Kapsam (ilk kayıtta eksik yazılmıştı).** Sorun yalnız kırpmayı değil, **bir SÜREYE karar
veren her işlemi** vuruyordu:

| İşlem | Nasıl kırılıyordu |
|---|---|
| **Kırpma (trim)** | 30 fps'te kenarları ızgarada olan 144 klip kombinasyonundan **32'si (%22)** süre yüzünden 422 alıyordu |
| **Bölme (split)** | Bölme noktası ızgaraya oturur; ortaya çıkan İKİ parçanın süreleri (fark olarak) ızgarada olmak zorunda değildir |
| **Asset ekleme** | En ağırı: yeni klibin süresi KAYNAK süresinden gelir (ffprobe 7.307300 sn, 12.679333 sn gibi değerler verir) — yani kullanıcının yaptığı **ilk iş** (dosyayı timeline'a bırakmak) ızgara dışı bir klip yazabiliyordu |

Eski metindeki **"geçici çözüm: proje fps'ini 25'e alın" önerisi yanlıştı** ve bu yüzden
kaldırıldı: 25 fps'te ızgara toplama altında kapalıdır (kare = 40 000 µs), ama asset
ekleme vakasında süre kaynaktan gelir; 12.679333 sn'lik bir dosya 25 fps'te de ızgara
dışıdır. Öneri, üç vakadan yalnız birini örtüyordu.

**Düzeltme — 1. tur (sözleşme).**

1. **Derleyici kapısı kenarlara alındı** — `ExportCompiler.Validate` içinde: artık
   `timelineStartUs` VE `timelineStartUs + timelineDurationUs` ızgarada mı diye bakılır
   (hata metni de değişti: *"clip … edges are not on the project frame grid"*). Süre, tanımı
   gereği bir ızgara büyüklüğü değildir.
2. **Editör süreyi "kendi başlangıcına göre TAM KARE" seçiyor** — şema paketine `frameSpanUs`,
   `frameSpanCount`, `snapDurationToFrameSpan`, `floorDurationToFrameSpan`, `isClipOnFrameGrid`
   eklendi (`packages/timeline-schema/src/time.ts`) ve `timelineOps` bunları kullanıyor.
   Asset ekleme **kuyruktan kısaltır** (`floorDurationToFrameSpan`): klip kaynağın bitişinden
   ÖNCEKİ kare sınırında biter — böylece hem iki kenar ızgarada olur, hem süre formülü
   (`sourceOut - sourceIn == süre`), hem de kaynak sınırı (`sourceOut ≤ asset süresi`) aynı
   anda sağlanır.

**Düzeltme — 2. tur (1. turun bıraktığı iki boşluk).** İlk tur denetimde RED aldı, çünkü:

3. **Kırpma, kaynak sınırına dayandığında hâlâ ızgara dışına düşüyordu.** Sağ tutamağı
   kaynağın sonuna kadar çekmek süreyi `min(hedef, kaynak süresi)` ile kırpıyordu ve
   **kaynağın süresi bir kare sınırı değildir** (ffprobe 7.307300 sn gibi değerler verir).
   Yani düzeltilen kapının ta kendisi, kullanıcının en doğal jestinde ihlal ediliyordu.
   Artık her kırpma sabit kenardan (sağ kırpmada BAŞLANGIÇ, sol kırpmada BİTİŞ) sayılan bir
   **tam kare aralığı** seçiyor ve kaynak tavanı da kare aralığına yuvarlanıyor
   (`fitFrameSpan` / `fitSpanFromStart` / `fitSpanToEnd`, `timelineOps.ts`). Kanıt gerçek
   fareyle: `e2e/frame-grid.spec.ts` — **ölçülmüş** (tahmin edilmemiş) ızgara dışı süreli
   gerçek bir kaynak yüklenir, sağ tutamak sonuna kadar çekilir, sonuç export'ta **202** alır.
4. **Editördeki kapı yanlış yerdeydi: interaktif jestler ona hiç uğramıyordu.** Kapı
   op sarmalayıcılarının sonuna elle yazılan `assertDocValidDev(...)` satırlarıydı. Ama bir
   kırpma sürüklemesi, gizmo sürüklemesi ve Inspector slider'ı op sarmalayıcısından değil
   `beginTransaction → tx.update(...) → commit` yolundan geçer — yani **gerçek bir fare
   sürüklemesi, birim testlerin reddedeceği bir doküman yazabiliyordu.** Kapı artık
   **commit noktasında**: `docStore.assertDocGateDev` her `mutate` ve her `commit` sonrası
   iki kapıyı birden koşar (`validateTimelineDoc` + `exportFrameGridIssues`) ve dokümanı
   değiştirmenin bu yoldan kaçan bir hali yoktur. Yalnız `import.meta.env.DEV` altında —
   üretimde kullanıcı ne zod ayrıştırmasının bedelini öder ne de bir throw görür.

**Doğrulama (bu doküman turunda bizzat koşuldu).** Sayılar §5'teki tabloda.

### 1.3 [KAPANDI — 2026-08-21] LUT (.cube): dört bacağın İKİ eksiği tamamlandı (editör UI + önizleme)

Bu projede bir özellik ancak **dört bacağın dördü** de varsa "var" sayılır: **şema**,
**editör UI'ı**, **önizleme (WebGL2)** ve **dışa aktarma (ffmpeg)**. Bu satır açıldığında
LUT'un yalnız şema + export bacağı vardı ("kör özellik"); eksik iki bacak ve beşinci iş
kalemi (.cube yükleme türü) bu turda kapatıldı. Güncel durum:

| Bacak | Durum | Kanıt |
|---|---|---|
| Şema | **VAR** | `packages/timeline-schema/src/schema.ts` — `EffectTypeSchema = z.enum(['colorAdjust','lut'])` (değişmedi) |
| Dışa aktarma (ffmpeg) | **VAR** | `ClipEffects.Lut3dFilter` `lut3d=file=…:interp=trilinear`; `ExportJobPipelineTests.Export_WithLutEffect_DownloadsTheCubeFile_AndActuallyChangesPixels` (fixture artık gerçek yükleme türüyle: `AssetKind.Lut` + `application/x-cube-lut`) |
| .cube yükleme türü | **VAR (yeni)** | `AssetKind.Lut` (`Enums.cs`) + `UploadRules.ContentTypeKinds["application/x-cube-lut"]` + istemci `fileTypes.ts` `.cube`; worker hattı ffprobe'a SOKMAZ, türev üretmez — İÇERİK doğrulaması (`CubeLutValidator`: LUT_3D_SIZE 2..129, N³ veri satırı, [0,1] domain, 1D ret; 14. tur triyajından beri BAYT düzeyinde ffmpeg-hizalı: BOM'lu/UTF-16/yalnız-CR/bitişik-anahtar-kelimeli dosyalar RET — bunları gerçek ffmpeg 8.0 da reddediyor, ölçüldü) sonrası doğrudan Ready (`ProcessAssetJob` Lut dalı). Bozuk dosya `invalid-lut` ile tipli düşer. Testler: `CubeLutValidatorTests` (35), `CubeLutFfmpegParityTests` (12 vaka — canlı ffmpeg'le çift yönlü golden), `ProcessAssetPipelineTests.LutAsset_EndToEnd_ReadyWithoutProbeOrDerivatives` + `InvalidLutAsset_FailsDeterministically_WithTypedReason` (gerçek MinIO) |
| Editör UI'ı | **VAR (yeni)** | Kitaplıkta `LUT` rozetli, sürüklenemez/klip-olamaz satır (`LibraryPanel.tsx`); Inspector "LUT" bölümü: kitaplıktaki hazır .cube'lerden seçici + yoğunluk kaydırıcısı + etkin anahtarı + Kaldır (`ClipPropertiesPanel.tsx`, `clipInspectorModel.LutSection`); yazımlar `timelineOps` lut op'ları (tek-efekt normalizasyonu, params tam `{assetId, intensity}` — invariant kural 6). Testler: `lutOps.test.ts` (13), `clipInspectorModel.speedColor.test.ts` lut bölümü |
| Önizleme (WebGL2) | **VAR (yeni)** | §4.2'nin NORMATİF uniform'ları artık kodda: `uLut3D`/`uLutScale`/`uLutOffset`/`uIntensity` (`compositor/shaders.ts`, katman VE geçiş programı — geçişte taraf başına ayrı LUT); .cube istemci ayrıştırıcısı + CPU trilinear referansı (`player/lut/cubeLut.ts`), 3D doku `RGBA16F` + `LINEAR` (= trilinear) (`compositor.createLutTexture`); motor LUT dokusunu media-urls `original` adresinden çeker, indirme bitene dek klip LUT'suz çizilir (`engineV1.lutFor`). `resolve.lutOf` intensity 0'ı derleyiciyle aynı şekilde "efekt yok"a çöker |

**Uçtan uca ve parite kanıtı (bizzat koşuldu, 2026-08-21).** `e2e/lut.spec.ts`, gerçek
fare/dosya seçici/`<select>`/slider ile: `.cube` yükle → "Hazır" → görsel klibe LUT uygula →
önizleme pikseli §4.2 CPU referansına ±3 kod içinde oturur; yoğunluk 0..1 karışımı aynı
formülde; **negatif kontrol**: LUT anahtarı gerçek fareyle kapatılınca piksel base görüntüye
döner; export 202 → Tamamlandı → indirilen MP4'ün ilk karesi aynı referansa oturur. Parite
(önizleme TAM karesi ↔ export karesi, 1920×1080, degrade + 17³ lineer LUT):
**SSIM(gri, global) = 0,99424** (§9.3 eşiği ≥ 0,98), **kanal başına |fark| ort = 1,603 kod**
(eşik ≤ 2,0), p99 = 4, max = 7. İkinci e2e: bozuk .cube "Başarısız" + `invalid-lut` (worker
kapısı gerçek fare yolundan). NEGATİF: LUT satırına çift tık timeline'a klip EKLEMEZ.

**Bilinçli sınırlar (yeni satırlar değil, tasarım kararları):**
- `DOMAIN_MIN/MAX` yalnız `0 0 0` / `1 1 1` kabul edilir — önizleme shader'ı domain
  ölçeklemesi uygulamaz; farklı domain'li dosya kabul edilseydi önizleme/export AYRIŞIRDI.
  Böyle dosyalar yükleme kapısında tipli reddedilir (KAPSAM DIŞI rejim).
- `LUT_3D_SIZE` üst sınırı 129 (ffmpeg 256 okur): 129³ RGBA float yükleme tamponu ≈ 34 MB —
  tarayıcı güvenli üst sınırı; 256³ (268 MB) önizlemeyi çökertebilirdi.
- Kabul kümesi ffmpeg `parse_cube`'ün ALT KÜMESİDİR (14. tur triyajı, 2026-08-21): BOM'lu
  (UTF-8/16/32), yalnız-CR satır sonlu, anahtar kelimesi bitişik (`LUT_3D_SIZE2`,
  `DOMAIN_MIN0`) ya da kelimesi satır başında olmayan dosyalar ffmpeg 8.0'da öldüğü İÇİN
  yükleme kapısında RET edilir ("Ready ama export'ta lut3d patlar" sınıfı kapalı;
  `CubeLutFfmpegParityTests` bu yönü canlı ffmpeg'le sabitler). ffmpeg'in kabul edip bizim
  RET ettiğimiz bilinçli-daha-katı vakalar (bitişik `TITLEfoo`, N³ sonrası fazla satır,
  boyut argümanında kuyruk) güvenli yöndedir — reddedilen dosya sisteme hiç girmez.
- Ham API'yle medya türü beyan edip .cube olmayan dosya gösteren belgeler için `lut-asset-type`
  kapısı DOSYA ADI üzerinden çalışmaya devam eder; ek olarak LUT varlığını KLİP kaynağı yapan
  belgeler artık senkron `asset-clip-type` alır (`ExportAssetMediaKind.Lut`, 4×4 tam matris:
  `ExportGateInventoryTests.TheWholeClipKindAssetKindMatrixBehavesAsTheLedgerClaims`).

### 1.4 [ORTA] Yarım kalan yükleme, tarayıcı kapanınca devam ETMEZ

**Ne çalışıyor.** Aynı sekmede duraklat/devam et, parça bazlı yeniden deneme, iptal
(`upload/uploadEngine.ts`). Yarım kalan oturumlar IndexedDB'ye yazılıyor ve kitaplıkta
"Yarım kalan yükleme" rozetiyle listeleniyor; oradan **silinebilir**.

**Ne çalışmıyor.** Tarayıcı kapanıp açıldıktan sonra kaldığı yerden **devam ettirme**.
Dosya İÇERİĞİ IndexedDB'ye kopyalanmıyor (1–2 GB) ve File System Access API tutamacı
saklanmıyor — dolayısıyla dosya yeniden seçilmeden sürdürülemez
(`apps/editor/src/features/library/upload/uploadSessions.ts` dosya başlığı). Sunucu tarafı hazır:
`GET /api/assets/{id}/upload/status` R2/MinIO'daki gerçek `ListParts` durumunu döner.

**Kullanıcı ne görür.** Bunu **açıkça söyleyen** bir uyarı (`LibraryPanel.tsx`, yarım kalan yükleme notu):
"Tarayıcı yeniden açıldıktan sonra devam ettirme ileri bir milestone'da gelecek; yarım kalan
yüklemeler sunucuda 7 gün saklanır."

**Ne zaman.** Sonraki dilim: FileSystemFileHandle akışı + ilk 1 MiB parmak iziyle
"dosya değişti mi" tespiti.

### 1.5 [ORTA] Mobil / tablet desteklenmiyor

**Ne çalışmıyor.** Uygulama tek bir sabit masaüstü ızgarasına kurulu:
`grid-cols-[280px_minmax(0,1fr)_320px] grid-rows-[auto_minmax(0,1fr)_280px]`
(`apps/editor/src/app/App.tsx`). Duyarlı kesme noktası, dokunma hedefi büyütmesi,
dokunmatik jest yolu **yok**; timeline etkileşimleri pointer capture + fare tekerleği üzerine
kurulu. Playwright paketi de tek bir masaüstü viewport'unda koşar.

**Neden.** Bilinçli kapsam kararı — POC masaüstü tarayıcı hedefli.

**Ne zaman.** Yol haritasında değil; mobil ayrı bir tasarım dilimi gerektirir.

### 1.6 [ORTA] Önizleme ile export arasında ±1 kare sapma olabilir

**Ne çalışmıyor.** Önizleme 540p proxy'den, proxy kendi kaynak-CFR ızgarasında oynar; UI ise
proje fps ızgarasındadır. Playhead bir proje karesine oturduğunda ekranda **en yakın proxy
karesi** gösterilir → export çıktısına göre en fazla **±1 proje karesi** görsel sapma
(`docs/rendering-semantics.md` §1.7; uygulama:
`engine-video/engineV1.ts` `preciseSeekElement` — hedef kaynak
zamanına yarım kare toleransla 3 deneme, sonra kabul).

**Neden.** Bilinçli ürün kararı — kare-kesin önizleme WebCodecs gerektirir (§2.1). Bu madde
yalnız ZAMANSALdır: tolerans "hangi kaynak karesi ekranda" sorusuna aittir. Konum/boyut
*hesabında* tolerans yoktur (iki taraf aynı formülü, yuvarlamadan kullanır) — ama çizilen
piksel ayrı bir sorudur ve orada ölçülmüş bir sapma VARDIR: bkz. §1.6b. Golden-frame
testleri bu iki toleransla birlikte yazılmıştır (`rendering-semantics.md` §9.3).

### 1.6b [DÜŞÜK] Katmanın export'taki **boyutu VE konumu** birkaç piksele kadar farklı olabilir

**Ne oluyor — İKİ ayrı sapma var, biri değil.** İkisi de bu turda gerçek ffmpeg 8.0 ve gerçek
tarayıcı ölçümüyle yeniden kuruldu (önceki metin yalnız birincisini biliyordu ve ikincisinin
yokluğunu iddia ediyordu).

1. **Boyut nicelemesi.** Önizleme katmanı kesirli boyutta çizer (ör. ölçek `0.501`'de `961.92 × 541.08`); export
   her ekseni **çift tamsayıya** niceler. Sapma **simetriktir**: katman kaymaz, yalnız kenarları
   içeri/dışarı gider. Ölçülen aralık (beş kaynak oranı × ölçek alanının yazabildiği bütün
   değerler): tam kutuda **[−1.60, +1.48] px**, yani **kenar başına ≤ 0.8 px**. 1080p'de ölçek
   alanına yazılabilen 4257 değerin **%98'inde** (4172) en az bir eksende oluşur — istisna değil,
   normal haldir.
2. **Konum kırpması.** Dışa aktarıcı katmanın hedef merkezini kesirli hesaplar ama piksele
   **aşağı kırpar** (`floor` — her ölçekte ve her işarette aynı yöne); önizleme kesirli konuma çizer. Katman bu yüzden export'ta **1 piksele kadar**
   sola/yukarı kayar — ve bu sapma **simetrik değildir**, katmanın tamamı kayar. Konum alanı 4
   ondalık saklar; 1920 px'lik tuvalde hedefin tamsayı çıktığı değerler ızgaranın yalnız
   **%0.8'i**, yani gizmoyla katman taşıyan bir kullanıcının pratikte **hemen her jestinde**
   oluşur (gerçek fareyle ölçüldü: 7 sürüklemenin 7'sinde hedef kesirli).

Uçtan uca ölçüm (aynı belge): `x = 0.0026`, ölçek `0.5` → önizleme katmanı `695…1234` sütunlarına,
export `694…1233` sütunlarına çizdi — **1 tam piksel**. Aynı belgede `x = 0.0125` (hedef tamsayı)
→ ikisi de `714`, fark **0**.

İkisi **aynı eksende toplanabilir**: ölçülen en kötü tek kenar **1.79 px** (ölçek `0.555`,
`x = 0.0026`; sağ kenar).

**Neden.** (1) Video kodlayıcılar (H.264/yuv420p) tek sayılı boyutları kabul etmez; dışa aktarıcı
bu yüzden her katmanı çift boyuta niceler (`force_divisible_by=2`) ve kesirli bir kutuyu çift
tamsayıya yuvarlamanın kayıpsız yolu yoktur. (2) Konum tamsayı piksele oturmak zorundadır;
dışa aktarıcı bunu `floor` ile yapar. Beyanın normatif hali `docs/rendering-semantics.md` §2.5
(**uzaysal tolerans**, üç ölçüm) ve §1.7'nin altındaki nottadır; §9.3 tablosu eşikleri sabitler
(merkez: `P − floor(P)` kadar — sıfır DEĞİL; kenar ≤ 2 px).

> **Bu turda düzeltilen iki KUSUR (ölçüldü, artık geçerli DEĞİL).** Sapmanın yönü eskiden
> **ölçeğe bağlıydı**: ffmpeg `overlay`'in kendi tamsayı çevrimi sıfıra doğru kırpar, dolayısıyla
> katman tuvali taştığı an (ölçek > 1, yani her yakınlaştırma) sapma **ters yöne** dönüyordu
> (ölçüldü: 1080p, ölçek `1.2` → merkez `P`'nin 0.992 px **sağına**). Ayrıca aynı belgenin iki
> derleme yolu (geçişli/geçişsiz) 1 px ayrışabiliyordu. İkisi de `overlay` hedefinin ifade içinde
> açıkça `floor`'lanmasıyla kapandı. Üçüncü bir kusur dönen katmandaydı: rotate ara tuvali TEK
> boyutlu olabiliyor ve katmanın merkezi dönmeyen halinden 1 px ayrılıyordu (ölçüldü: `y` ekseninde
> 121 yerine 120 beklenirken 121); tuval artık ÇİFTE sabitleniyor. **Kalan sapma yalnız yukarıdaki
> iki normal kaynaktır ve yönü artık ölçekten bağımsızdır.**
>
> **BU TURDA KAPANAN DÖRDÜNCÜSÜ — DÖNEN katmana geçiş eklemek onu oynatıyordu.** Yukarıdaki
> "iki derleme yolu ayrışabiliyordu" kusurunun `floor` ile kapanan hali yalnız **dönmeyen**
> yarıydı; dönen yarı açık kalmıştı ve hiçbir kapı ya da test onu görmüyordu. Ölçüldü (gerçek
> ffmpeg 8.0, 320×240 tuval, 16:9 kaynak, `s=0.503`, `a=90`): pad'siz yol katmanı
> `(114,39,205,200)`'e, pad'li yol `(115,39,204,200)`'e koyuyordu. Sebep konum değil rotate'in
> **girişiydi**: kare ara tuvalin kenarı girişten doğar ve iki yolun girişi farklıydı. Düzeltme:
> dönen (ve çapası merkezde olan) katmanda kutuya normalize eden pad artık **kesim durumundan
> bağımsız** olarak üretilir, yani rotate'in girişi her iki yolda da kutudur. Bekçi:
> `AddingATransition_DoesNotMoveTheLayerByASinglePixel` artık `rotationDeg` yazan 8 satır daha
> koşuyor (toplam 16).

**Sizi ne zaman rahatsız eder.** Görecelidir: 500 px'lik bir katmanda 1-2 px görünmez, 20 px'lik
bir katmanda fark eder. Bir uyarı: **"aşırı küçük ölçekler zaten §3'e takılır" DOĞRU DEĞİLDİR** —
§3'ün ölçek tabanı yalnız aşırı geniş/dar kaynaklarda ve kutu 2 pikselin altına indiğinde devreye
girer; **normal medya** (16:9, 4:3, kare, dikey) 1080p'de `0.010` ölçekte kabul edilir ve katman
`18×10` piksel olarak çizilir. Yani çok küçük katmanlar **ulaşılabilirdir** ve göreli sapma orada
en büyüktür.

### 1.7 [KAPANDI — 2026-08-21] Track yeniden sıralama ve yeniden adlandırma eklendi

`timelineOps.moveTrack('up'|'down')` ve `renameTrack` op'ları eklendi (tek kapı
disiplini; `trackMoveBlockReason` / `trackRenameBlockReason` menüyü aynı kuralla
griler). UI: track sağ tık menüsünde `Yeniden adlandır / Yukarı taşı / Aşağı taşı`,
başlığa çift tıkla satır içi input (Enter kaydeder, Escape vazgeçer, boş ad özel adı
siler ve türetilmiş etikete dönülür). `tracks[0] = en üst katman` sözleşmesi
KORUNUYOR ve reorder'ın export katman sırasını gerçekten değiştirdiği iki yarıda da
ölçüldü: önizleme (`resolveVisualStack` sırası, `timelineOps.test.ts`) ve derleyici
(reorder öncesi/sonrası `ExportCompiler.Compile` filtergraph'ları — en üste bindirilen
kaynak yer değiştirir). Gerçek-fare e2e: `e2e/track-manage.spec.ts` (5 test; negatif:
en üst track'te "Yukarı taşı" gri + `track already at the top`, Escape iptali, kısayol
sızdırmazlığı). KAPSAM DIŞI kalan tek parça: başlıktan SÜRÜKLEYEREK sıralama —
bilinçli erteleme (menü aynı op'u sıfır yeni jest maliyetiyle sunar; başlık sütununda
drag ayrı pointer/çizim altyapısı ister), talep gelirse op hazır.

### 1.7b [DÜŞÜK] Dönük METİN klibinde ölçek/yazı boyutu tavanı KONSERVATİF

Dönme ara tuvali köşegen kadar büyütür ve editör tavanı artık bunu birebir hesaplıyor
(`invariants.maxScaleForFit` — medya/görsel/çıkartma/şekilde derleyici defteriyle
maksimal). METİNDE ise kutunun en-boyu yazı boyutuyla birlikte değiştiği için kesin
ters çözüm yerine worst-case çarpan kullanılır (√2 · çapa pad'i): dönük bir başlığın
ölçek/yazı-boyutu tavanı gerekenden bir miktar DÜŞÜK önerilebilir, ama asla export'un
`transform-scale` 422'sine çarpan bir değer önerilmez. Keyframe örnek bütçesi rozeti
de aynı ailedendir: kestirim ÜST SINIRDIR (derleyicinin ardışık-eş-değer teklemesi
sayılmaz), uyarı gerçek harcamadan önce yanar — geç asla kalmaz.

### 1.8 [DÜZELTİLDİ — 8. tur denetimi, 2026-08-13] Müzik eklemek dışa aktarmayı İMKÂNSIZ kılıyordu

> Bu madde **kapandı**. Kayıtta kalmasının nedeni, ürünü daha önce denemiş olanların gördüğü
> davranışı açıklamak ve düzeltmenin **hangi sınırlarla** geldiğini yazmaktır.

**Neydi.** Kitaplığa bir müzik dosyası yükleyip ses track'ine koyan kullanıcı, projesini dışa
aktaramıyordu: `POST /exports` **202** dönüyor, iş dakikalar sonra worker'da
`unsupported-media: source of asset <id> has no video stream` ile **failed** oluyordu. Kontrolle
yalıtıldı: aynı belgede ses klibi bir VİDEO varlığını gösterdiğinde export başarılıydı, yalnız
SES varlığını gösterdiğinde düşüyordu. Yani kusur "ses" özelliğinde değil, worker'ın **indirme
döngüsündeydi**: LUT dışındaki HER varlıkta video akışı şart koşuluyor, klibin TÜRÜNE
bakılmıyordu.

**Aynı kullanıcı yolunun İLK adımı da kırıktı (ölçülerek bulundu).** Bu makinede `.m4a`
yüklemek **zaten imkânsızdı**: istemci içerik tipini tarayıcının `File.type`'ından alıyordu,
Chromium/Windows `.m4a` için `audio/x-m4a` diyor, sunucu whitelist'i (`UploadRules.ContentTypeKinds`
— `audio/mpeg`, `audio/mp4`, `audio/wav`) bunu reddediyordu. Oysa arayüz `.m4a`'yı accept
listesinde gösteriyor ve "MP3/M4A/WAV yükleyebilirsiniz" diyordu — yani ürün kullanıcıyı
yapamayacağı bir işe **aktif olarak** yönlendiriyordu.

**Düzeltme.**

1. **İçerik tipi artık UZANTIDAN türetiliyor** (`library/fileTypes.ts` `contentTypeForFileName`;
   `.m4a → audio/mp4`), tarayıcının tahmini yalnız yedektir (`upload/uploadManager.ts`). Karar
   böylece uzantıya bakan yükleme kapısıyla **aynı kaynaktan** gelir.
2. **Soru değişti:** "dosyada ne var" değil, "o dosyayı okuyan KLİP ne istiyor". Defter
   `ExportPlan.AssetUses` (klip → varlık → ihtiyaç: **Motion / Still / Audio**) TEK yerde
   üretilir (`ExportCompiler.NeedOf`) ve iki kapı da onu sorar: senkron kapı DB olgularıyla
   (`asset-clip-type` → 422), worker aynı defteri ffprobe olgularıyla
   (`ExportCompiler.FindStreamMismatch` → `unsupported-media`). Defter yalnız **gerçekten
   okunan** kullanımları taşır (gizli track'teki video klibi görüntü okumaz, susturulmuş ses
   klibi hiçbir şey okumaz) — yanlış ret üretmemesi buna bağlıdır.

**Kanıt.** `ExportJobPipelineTests.Export_MusicOnAnAudioTrack_Succeeds_AndTheOutputReallyCarriesThatSound`
gerçek worker + gerçek ffmpeg + gerçek MinIO ile koşar ve çıktının ses **SEVİYESİNİ** ölçer
("stream var" yetmez: dijital sessizlik de bir stream'dir). Yanına ses+video karışık belge
(`Export_MusicMixedWithVideo_…`) ve N3'ün vakası (`Export_StickerClipPointingAtAVideoFile_…`)
eklendi. Bu üçü de `MINIO_AVAILABLE=1` ile koşuldu (§5'teki 1232/1232).

**Bugünkü SINIRLARI — düzeltme neyi vaat etmiyor:**

- **Sessiz bir videodan ses klibi kurulamaz**: ses klibi SES akışı ister; kaynağında ses olmayan
  bir video için istek **senkron 422** (`asset-clip-type`) alır. Bu bilinçlidir — sessizce boş
  bir kanal miksletmek "sesim gelmiyor" hatasını sessiz bozulmaya çevirirdi. **Editör bunu
  önden ENGELLEMİYOR:** "Sesi ayır" sessiz bir videoda da menüde açık görünür (editör `hasAudio`
  olgusunu okumaz), kullanıcı sınırı ancak dışa aktarmada öğrenir — §3'ün matris notuna bakın.
- **Ses klibinde görsel keyframe ve renk efekti yasaktır** (`keyframes-audio-clip`,
  `effects-audio-clip`) — §3'ün tablosuna bakın.
- **Preview ↔ export ses parity'si HÂLÂ ölçülmemiştir** (§2.6): "önizlemede duyduğunuz miks
  çıktıdakiyle birebir aynı" iddiası test edilmiş değil, tasarımla gerekçelendirilmiştir.
- Ses tarafının **kendi** e2e'si (`e2e/audio-export.spec.ts`) pakete eklendi; ama bu doküman
  turu Playwright **koşmadı** — §5'teki E2E notu bu satır için de geçerlidir.

### 1.9 [DÜZELTİLDİ — 11. tur denetimi, 2026-08-20] Ardışık iki sesli klip dışa aktarmayı SONSUZA KADAR asıyordu

**Kusur teslim edilmedi** — commit'lenmemiş bir dilimde doğdu ve aynı turda kapandı; buraya
kaydı, *aynı şeklin bir daha yazılmaması* için düşülüyor.

Miks kuyruğuna eklenen **argümansız `apad`** (`…,alimiter=limit=0.98,apad,atrim=end=<toplam>`)
SINIRSIZ bir üreteçtir ve o rejimde `atrim` onu durdurmuyordu.

**Ürün düzeyinde ölçüldü** (ham API; iki 10 sn'lik sesli demo videosu ardışık, ikincisi baştan
kırpılmış — kaynak `[1,10)`, toplam 19 sn):

| | Düzeltmeden ÖNCE | Düzeltmeden SONRA |
|---|---|---|
| Tamamlanan export | **0 / 3** | **6 / 6** |
| İşin son hali | `running`, **%90 / render**, 90 sn'de bitmedi | `succeeded`, ~7,6 sn |
| Kaçak ffmpeg | her koşumda 1, ~135 sn CPU | yok |
| Çıktı | moov atomu YOK, dosya 15,7–16,0 MB'a büyümeye devam | 10,93 MB |
| Çıktının **ses AKIŞI** | ölçülemedi (dosya geçersiz) | **19,000000 sn** (video da 19,000000) |

Kullanıcının gördüğü hâl daha da kötüydü: export kuyruğu tek kanaldır (§4.1), yani böyle **tek
bir belge** o makinedeki **herkesin** export'unu süresiz kilitliyordu.

Düzeltme iki parçalıdır ve ikisi de ayrı ayrı ölçüldü:

1. **Biçim** — kuyruk artık `…,alimiter=limit=0.98,atrim=end=<toplam>,apad=whole_dur=<toplam>`:
   önce fazlalık kırpılır, sonra dolgu **kendi durma noktasını taşıyarak** eksiği tamamlar
   (normatif tanım: `rendering-semantics.md` §8.3).
2. **Bekçi** — §4.1'e bakın: bu sınıf bir grafik bir daha kaçarsa artık iş saniyeler içinde
   `render-overrun` ile düşer, süreç öldürülür ve kanal serbest kalır.

**Rejim (neden testler görmüyordu):** kusur yalnız (a) çok girişli mikste (`amix=inputs≥2`),
(b) TAM A/V grafiğinde ve (c) klip aralığı kaynak dosyasının SONUNA dayandığında doğuyor; üstelik
**yarışsal**: aynı belge 8/10 asıldı. Deponun miks uzunluk testi kendini `amix=inputs=1:` ile tek
girişe sabitlediği için bu rejimi görmüyordu. Artık çok girişli rejimin **süre tavanlı** uçtan uca
karşılığı var: `ExportRenderGoldenTests.AudioMix_WithTwoAudibleGroups_FinishesAndSpansTheWholeTimeline`
(üç koşum; tavana çarparsa test KIRMIZI verir, "yavaş test" gibi görünmez).

---

## 2. Motor / önizleme sınırları

### 2.1 WebCodecs (v2) oynatıcı motoru YOK

`apps/editor/src/features/player/` altında tek motor var: `engine-video/engineV1.ts` —
gizli `<video>` havuzu tabanlı. `engine.ts` dosya başlığı v2 WebCodecs motorundan **plan olarak**
söz eder, kod yoktur (`VideoDecoder` deposunda hiç geçmez). Sonucu: kare-kesin scrubbing
yerine ±1 kare toleransı (§1.6) ve aynı anda **en fazla 4 video** (`POOL_SIZE = 4`,
`player/core/scheduler.ts` `POOL_SIZE`).

### 2.2 Kalabalık kompozisyonda katman düşebilir — ve geçiş bunu ikiye katlar

Havuz 4 elemanlıdır; daha fazla eşzamanlı video klibi olan bir kompozisyonda önizleme
bazılarını **atlar**. Geçiş penceresi açıkken A ve B birlikte `priority 0` olur, yani
havuzun ikisini birden yer → geçiş boyunca bir katman/ses DAHA düşebilir.

Sessiz değil: oynatıcıda `previewShortfallNote` rozeti bunu bildirir
(`player/PlayerPanel.tsx`, `previewShortfallNote`). **Export etkilenmez** — ffmpeg tüm katmanları çizer.

### 2.3 Geçiş önizleme paritesi: `fadeToBlack` KAPANDI (ölçülü artıklarla), `dissolve` bilinçli yaklaşıklık

**`fadeToBlack` (2026-08-21'de ölçülerek eşitlendi).** Önizleme artık ffmpeg `fadeblack`
kapalı formunun kendisini uygular (phase 0.2, YUV düzlem karışımı, süper-siyah `Y=0` —
normatif formül ve ölçüm: `rendering-semantics.md` §5.3). Zincirleme kanıt: GLSL ≡
`transitionRef.ts` (regex nöbetçileri) ≡ gerçek ffmpeg YUV vektörleri (±4/255,
`transitionRef.test.ts`) ≡ üretim hızlı yolu (`ExportRenderGoldenTests.FadeToBlack_OnTheFastPath_…`,
±6). ÖLÇÜLÜ ARTIKLAR (bilerek bırakıldı):

- **Export'un iki yolu iki eğri üretir**: hızlı yol yuv420p'de karışır (siyah `Y=0`),
  kompozisyon yolu rgba'da kanal başına karışır (siyah `0`). Fark yalnız DİP bölgesinde,
  golden fixture'da ≤ ~15/255 (rgb dip (8,42,67) ↔ yuv dip (0,28,52)). Önizleme kanonik
  durumu (tek katmanlı düz kesim = hızlı yol) izler; katmanlı belgede export dibi bir tık
  farklı çıkar. İki eğri de koşan golden'larla ayrı ayrı sabitlidir
  (`FadeToBlack_OnTheComposedPath_…`) — ffmpeg format müzakeresi değişirse test kırmızı yanar.
- **Görsel-görsel (PNG/raster) kaynaklı fadeToBlack** ölçülmedi → KAPSAM DIŞI; rgb
  eğrisini izlemesi beklenir ama sınanmadı.

**`dissolve` bilinçli yaklaşıklık olarak KALIR (ölçüm 2026-08-21, ffmpeg 8.0, 1920×1080).**
Eşik KURALI ve toplam yoğunluk birebir aynıdır (ffmpeg'de B oranı p'yi izler; ölçülen:
p=0.2333→%23.38, p=0.5→%50.01, p=0.7667→%76.88). Piksel DESENİ ise ilkesel olarak
eşitlenemez: ffmpeg `frand(x,y)` TAM SAYI piksel koordinatını libm `sinf` ile hash'ler —
desen çıktı çözünürlüğüne (önizleme proxy ≠ export tuvalı) ve platformun libm
gerçeklemesine bağlıdır (yani ffmpeg build'leri arasında bile sabit değildir). Aynı
çözünürlükte ölçülen desen uyuşması p=0.5'te **%50.01 = istatistiksel bağımsızlık**.
Gözle fark edilmez (aynı yoğunlukta farklı noktalanma) ama piksel-eşit değildir → dissolve
için preview↔export golden karşılaştırması yazılamaz. Diğer dört geçiş (`crossfade`,
`wipeLeft`, `wipeRight`, `slideUp`) matematiksel olarak aynıdır.

### 2.4 Geçiş pass'inde kenar yumuşatma yok

Tam kare dörtgen üstünde her taraf kendi yerleşim matrisinin tersiyle örneklendiği için,
kareye tam oturmayan (ölçekli/döndürülmüş) bir katmanın kenarı geçiş sırasında tırtıklı
görünebilir. Tam kare kliplerde etkisi yoktur.

### 2.5 Metin satır kırılımı iki ayrı motorda ölçülüyor

Tarayıcı Canvas2D ile, sunucu SkiaSharp + HarfBuzz ile ölçer. Aynı TTF dosyası ve aynı kutu
kuralı iki tarafta da kullanıldığı için **basit Latin metinde fark ihmal edilebilir**; ama
**bitişik harfler / RTL / emoji** içeren metinde satır genişliği birkaç piksel kayabilir ve
satır kırılımı teoride farklı düşebilir. Sunucu ölçüm ucu (`POST /api/overlays/measure`)
yazılmadı. Inspector bunu kullanıcıya **olduğu gibi** söyler
(`inspector/ClipPropertiesPanel.tsx`, `data-testid="clip-text-raster-note"`).

### 2.6 Ses parity'si (preview ↔ export RMS) ÖLÇÜLMEDİ

Kazanç zinciri birim testlerle pinlendi (geçişte toplam kazanç her an 1), ama
OfflineAudioContext tabanlı sayısal RMS karşılaştırması yazılmadı. Yani "önizlemedeki ses
export'takiyle aynı" iddiası **test edilmiş değil, tasarımla gerekçelendirilmiş**tir.

### 2.7 [DÜŞÜK] `audioSampleRate` yalnız önizlemeyi etkiler; export her zaman 48 kHz

Proje şeması `audioSampleRate` için `44100 | 48000` kabul eder ve seçilen değer önizleme
`AudioContext`'inin örnekleme hızını belirler. Ölçüm (Chromium / Windows, bu depo):
`AudioContext({ sampleRate: 44100 })` gerçekten 44100, `48000` gerçekten 48000 döndürdü.
**Ama export bu ayarı hiç okumaz** — `ExportCompiler` `aformat=...:sample_rates=48000` +
profil `-ar 48000` ile sabit 48 kHz üretir (`ExportCompiler` içinde `audioSampleRate`'in
geçtiği tek satır yoktur; mevcut export çıktıları ffprobe ile `sample_rate=48000`).

Sonuç: 44100 seçili bir projede önizleme 44100'de, export 48000'de çalışır — yani bu ayar
için önizleme/export **aynı örnekleme hızında değildir**. Duyulur ses içeriği değişmez (her
iki hız da tam bant) ve çıktı her hâlde 48000'e resample edilir; ayarın gözlemlenebilir tek
etkisi önizleme context hızıdır. Kullanıcı "44100 seçince dosyam 44100 olur" beklerse bu
karşılanmaz. Not: `AudioContext` sampleRate seçeneği tarayıcı/OS garantisi değildir; başka
bir tarayıcı/donanım istenen hızı reddedip kendi hızına düşürebilir (bu depoda ölçülmedi —
kapsam dışı). İlgili sözleşme: `rendering-semantics.md` §8.5.

---

## 3. Şema / export motoru sınırları (tipli hata verir, sessiz bozulma yok)

Ortak nokta: hiçbiri **sessizce yanlış çıktı vermez**. Ama **kapının NEREDE olduğu** satırdan
satıra değişir ve bu fark kullanıcı için gerçektir: 422 istek anında gelir, kuyruk-sonrası bir
düşüş ise dakikalar sonra "başarısız" olarak görünür.

- **Şema düzeyi** (ilk iki satır) — sınır dokümanda **ifade bile edilemez**, o yüzden ortada
  reddedilecek bir şey yoktur: `speed` tek skalerdir (rampa yazılamaz) ve `KeyframeTracks`
  STRICT'tir (`fx.*` kanalı eklenemez, zod reddeder).
- **Derleyici 422'si** — kural `ExportCompiler.Validate` **içindedir**; API export isteğinde
  onu çağırır (`ExportEndpoints.cs`), iş **kuyruğa hiç girmez** ve açık gerekçeli 422 döner.
  Hata tipli: `transition-keyframes`, `transition-handle`, `transition-rotated-anchor`,
  `scale-keyframes-with-rotation`, `keyframes-audio-clip` / `effects-audio-clip`,
  `keyframe-sample-budget`, `transform-scale`, `overlay-too-large`, `degenerate-layer`,
  `lut-asset`, `overlay-unsupported-clip`, `project-background-color`,
  `project-fps-out-of-range`, `timeline-too-long` — ve geçiş yerleşimi eşitliği ile metin
  klibinin ölçüleri (kodsuz `InvalidTimelineException`).
- **Asset olgusu 422'si** (`asset-missing`, `source-out-of-range`, `lut-asset-type`,
  `asset-clip-type`, `asset-failed`) — kural yine `Validate`'tedir ama cevabı DOKÜMAN değil
  **kullanıcının kütüphanesi** verir: API referans verilen asset satırlarını (sahiplik +
  soft-delete filtresiyle) TEK sorguda okuyup bir olgu defteri geçirir (`ExportAssetFacts`).
  Başlık bu beş kodda farklıdır — "henüz desteklenmeyen özellik" değil, "dışa aktarılamayan
  dosya". Aynı liste **istemcide de** vardır (`exportLogic.ts` `ASSET_FACT_CODES`, cümleyi o
  seçer) ve iki kaynak bir muhafızla karşılaştırılır
  (`ExportGateInventoryTests.TheClientAndServerAgreeOnWhichCodesMeanAnAssetProblem`):
  ayrışma çökme değil YANLIŞ CÜMLE üretirdi — kullanıcı kendi dosyasını düzeltmesi
  gerekirken "desteklenmeyen özellik" arardı.
- **Ayrı kapılar** — doküman tavanları kaydetmede **400**, kaynak süresi tavanı işlemede
  `too-long`; profil adı bilinmiyorsa **400**, profil tuval oranına uymuyorsa senkron
  **422 `export-profile-aspect`** (dalga 2 — dördüncü cümle sınıfı, `ProfileFeatures`).
- **KURULUM 503'ü** (`text-measure-unavailable`) — 422 DEĞİLDİR ve bu bilinçlidir: metin
  kutusu ölçülemiyorsa kusur belgede değil sunucudadır (font kökü / Skia). Ayrıntı §3.3'te.

> **KAPI YERİ ARTIK YAPISAL OLARAK MUHAFAZA EDİLİYOR.**
> `ExportGateInventoryTests` derleyici kaynağını TARAR: her `UnsupportedFeatureException`
> kodu ve worker'ın her `FailAsync` gerekçesi bir defter satırına sahip olmak ZORUNDADIR.
> "Senkron kapıdan ulaşılabilir" yazan her satır GERÇEKTEN koşturulur — belge kurulur,
> `ExportEndpoints.StartExport` çağrılır, 422 + doğru kod + **iş satırı oluşmadığı**
> doğrulanır. "Ulaşılamaz" yazan satırlar da koşturulur ve isteğin derleyiciye GELMEDEN
> (JSON ayrıştırmada) öldüğü gösterilir. Worker'da bırakılan her kural YAZILI gerekçe taşır.
> Kodsuz `InvalidTimelineException` için dosya başına fırlatma SAYISI sabitlenmiştir: yeni
> bir fırlatma eklenip defter güncellenmezse test KIRMIZI olur.
>
> **MUHAFIZ BU TURDA GENİŞLETİLDİ — çünkü bir KÖRLÜĞÜ vardı.** Eski hali yalnız
> `VideoEdit.Media/Export` altını tarıyordu ve **raster hattını hiç görmüyordu**; `text.fill`
> kaçağı (aşağıdaki tablo satırı) tam olarak oradaydı. Yeni `RasterRefusals` defteri
> `VideoEdit.Media/Text/*.cs` içindeki **her** `UnsupportedOverlayClipException` fırlatmasını
> eşler ve eşleme **KİMLİKLEDİR, sayıyla değil**: "bir gerekçe eklendi, biri silindi" hali de
> kırmızıya düşer. Bugün 9 satır: 6'sı SyncGate (endpoint gerçekten çağrılarak kanıtlanır),
> 2'si "derleyici böyle bir klibi raster hattına hiç yönlendirmez", 1'i "hiçbir geçerli JSON
> belgesiyle üretilemez" — hepsinde yazılı gerekçe. Kural artık şudur: **raster hattına
> eklenen her "bu klibi çizemem" gerekçesi, senkron kapıda karşılığı olduğunu KANITLAMAK ya da
> neden olamayacağını YAZMAK zorundadır.** Kaçak yolu yoktur.
>
> *Defteri kurarken çıkan tuzak (kayda geçsin):* `"text": null` / `"shape": null` yalnız AÇIK
> JSON `null` ile üretilebilir. C#'ta alana `null` atayıp serialize etmek alanı **siler**
> (`WhenWritingNull`) ve DTO'nun property başlatıcısı karşı tarafta **varsayılan gövdeyi geri
> doğurur** — iki defter satırı bu yüzden ham JSON kurar; aksi halde biri YANLIŞ SEBEPLE
> geçiyordu.

> **Bu ayrım 3. tur denetiminde ÖLÇÜLEREK doğdu — ve dokümanın kendi vaadini yanlışladı.**
> Bu bölümün ve README'nin önceki hali "desteklenmeyen bileşim kuyruğa hiç girmez, 422 ile
> gerekçe döner" diyordu; baş mimar **iki bileşimin 202 alıp canlı worker'da `failed`
> olduğunu ölçtü**. Kök neden tek bir cümleydi: bazı derleyici kuralları `Validate`'te değil
> `Compile`/raster aşamasında yaşıyordu ve API'nin ön kapısı yalnız `Validate`'i çağırıyor.
> İki kural o turda kapatıldı — **overlay katman tavanı `Validate`'e taşındı**, **geçiş
> yerleşimi editöre + doküman değişmezine alındı** — ve tablo artık hangi kuralın hangi
> kapıda olduğunu satır satır söylüyor. Ölçülen iki kural aşağıdaki tabloda
> *"Overlay katman tavanı 8192 px"* ve *"Geçişli kesimde iki klibin yerleşimi aynı olmalı"*
> satırlarıdır. **6. tur ekleme:** ikincisinin SUNUCU tarafı da `Validate`'e alındı
> (`EnsureTransitionPlacement`), yani ham API'ye yazan istemci de artık senkron 422 alır.

| Sınır | Ne olur | Kanıt |
|---|---|---|
| **Hız rampası yok** *(şema)* | Bir klip = tek sabit oran (0.1×–10×). Klip içinde hızlanma/yavaşlama kurulamaz. | `schema.ts` `speed: z.object({ rate: … })` tek skaler |
| **Efekt parametresi keyframe'i yok** (`fx.*`) *(şema)* | colorAdjust/LUT değerleri animasyonlanamaz. Keyframe kanalları yalnız `x, y, scale, rotationDeg, opacity, volume`. | `schema.ts` `KeyframeTracksSchema` STRICT |
| **Geçişli kesimde keyframe yasak** | Geçiş penceresine giren klipte animasyon varsa 422. | `ExportCompiler.ResolveTransitions` `transition-keyframes` |
| **Ölçek animasyonu + dönme birlikte yasak** | ffmpeg `rotate` çıkış tuvalini bir kez kurar, büyüyen girişi sessizce KIRPARDI — sessiz kırpma yerine tipli hata. | `ExportCompiler.ValidateGeometry` `scale-keyframes-with-rotation` |
| **Ses klibinde görsel keyframe / renk efekti yasak** | Ses görüntü üretmez; sessizce yok saymak "animasyonum çalışmıyor" bug'ı olurdu. | `ExportCompiler.ValidateClip`: `keyframes-audio-clip`, `effects-audio-clip` |
| **Keyframe örnek bütçesi 60 000 — PAYLAŞILIR** | Eğrili (easing'li) kanallar ve `volume` kanalı KARE KARE örneklenir. Bütçe TEK BİR KLİBE DEĞİL, derlemedeki tüm klip ve kanallara aittir; **`scale` iki kez sayılır** (ScaleWidth + ScaleHeight ayrı ayrı örnekler). Kural bu turda `Validate`'e taşındı (eskiden yalnız `Compile`'daydı: belge 202 alıyor, iş dakikalar sonra düşüyordu). **Mesaj da düzeltildi** — ölçülen kusur şuydu: 30 masum klipten sonuncusuna "bu klip 600 örnek üretiyor, animasyonu kısaltın" deniyordu; 600, 60 000'in yanında hiçbir şeydir ve gerçek neden ÖNCEKİ kliplerin paylaşımlı bütçeyi tüketmesiydi — kullanıcı suçlanan klibi kısaltarak çözemezdi. Yeni mesaj bütçenin paylaşıldığını, önünde kaç klibin ne kadar harcadığını ve İŞE YARAYAN eylemi söyler: **görsel kanalda easing'i LİNEER yapmak** (lineer kanal kapalı forma derlenir, bütçeden SIFIR harcar), **ses kanalında** ise volume keyframe'ini daha az klipte kullanmak — çünkü ses zincirinde kapalı-form yol yoktur ve lineer easing orada bütçeyi DÜŞÜRMEZ (eski mesajın "keyframe sayısını azaltın" önerisi de yanlıştı: örnekleme kare başınadır, keyframe başına değil). | `ClipAnimation.MaxSamples = 60_000`; muhasebe `ExportCompiler.SampleBudget` (tek yer); kapı `ExportCompiler.EnsureSampleBudget` (Validate) + `BuildAnimationCommands` / `BuildAudioChain` (Compile sigortası); kod `keyframe-sample-budget`. **Önerilen eylemin çalıştığı ölçülür**: `ExportEndpointsTests.StartExport_SharedSampleBudget_Returns422_AndTheSuggestedFixIsAccepted` aynı belgeyi iki kez gönderir — eğrili hali 422, YALNIZ easing'i lineere çevrilmiş hali 202 |
| **Var olmayan / başkasının varlığına atıf** | Timeline silinmiş (ya da hiç var olmamış, ya da başka bir hesaba ait) bir asset kullanıyorsa **senkron 422**. Eskiden POST 202 dönüyor, iş worker'da aynı kodla düşüyordu. Kural saf DB aritmetiğidir ve **kalıcıdır**: asset satırı yüklemenin ilk adımında yaratılır, soft-delete geri alınmaz → "birazdan görünür" ihtimali yoktur. `asset-not-ready`'nin **GEÇİCİ** yarısı (Uploading / Uploaded / Processing) BİLEREK bu kapıda değildir: işlenmekte olan bir asset, iş kuyruktan alınana kadar Ready olabilir; senkron reddi YANLIŞ RET olurdu. **TERMİNAL yarısı (`Failed`) 8. turda senkron kapıya alındı** — bir sonraki satır. | `ExportCompiler.EnsureAssetFacts` → `asset-missing`; defter `ExportAssetFacts`; worker yarısı `ExportJob.Run` adım 2'de sigorta olarak durur |
| **Klip TÜRÜ ile dosya TÜRÜ uyuşmalı** *(8. tur denetimi — N1 KRİTİK + N3; §1.8)* | ÖLÇÜLEN KUSUR (N1): kitaplığa `.m4a` yükleyip ses track'ine koymak **export'u imkânsız kılıyordu** — worker'ın indirme döngüsü klip türüne BAKMADAN her varlıkta video akışı arıyordu ve iş `unsupported-media: ... has no video stream` ile ölüyordu. Kontrolle yalıtıldı: aynı belgede ses klibi bir VİDEO varlığını gösterdiğinde export başarılıydı, yalnız SES varlığını gösterdiğinde düşüyordu. İkinci kusur (N3): **çıkartma klibi bir VİDEO varlığını gösterdiğinde** iş `ffmpeg-failed: ... exited with code -1414549496` veriyordu — kullanıcıya tipli hata bile gitmiyordu (durağan giriş `-loop 1` ile açılır, zaman eksenli dosya orada ölür). Doğru soru "dosyada ne var" değil, **o dosyayı okuyan KLİBİN ne istediğidir**: video klibi zaman eksenli görüntü, görsel/çıkartma klibi DURAĞAN görüntü, ses klibi SES ister; LUT hiçbirini istemez. Defter (`ExportPlan.AssetUses`) yalnız GERÇEKTEN okunan kullanımları taşır — gizli track'teki video klibi görüntü okumaz (sesi varsa opsiyoneldir), susturulmuş track'teki ses klibi hiçbir şey okumaz — yoksa kapı yanlış ret üretirdi. Kapı **senkron**: tür beyanı GEÇİCİ durumdaki satırda da sorulabilir, çünkü beyanla dosya çelişirse asset zaten Ready OLAMAZ (`ProcessAssetJob.GateByKind`); tek istisna "bu videonun sesi var mı" olgusudur ve o yalnız Ready satırda sorulur. | Kural TEK yerde: `ExportCompiler.NeedOf` + `ExportAssetUse`; senkron kapı `EnsureAssetFacts` → `asset-clip-type`; worker yarısı `ExportCompiler.FindStreamMismatch` (aynı defter, olgular ffprobe'dan) → `unsupported-media`. TÜM matris (4 klip türü × 3 varlık türü + "sessiz video") uç noktaya GERÇEKTEN gönderilerek koşar: `ExportGateInventoryTests.TheWholeClipKindAssetKindMatrixBehavesAsTheLedgerClaims`. GERÇEK worker + GERÇEK ffmpeg + GERÇEK MinIO kanıtı: `ExportJobPipelineTests.Export_MusicOnAnAudioTrack_Succeeds_AndTheOutputReallyCarriesThatSound` (çıktının ses SEVİYESİ ölçülür — "stream var" yetmez, dijital sessizlik de stream'dir), `Export_MusicMixedWithVideo_...`, `Export_StickerClipPointingAtAVideoFile_FailsWithATypedError` |
| **İşlenmesi KALICI olarak başarısız dosya dışa aktarılamaz** *(8. tur denetimi — N2)* | ÖLÇÜLEN KUSUR: `.mp4` adıyla çöp bayt yüklenip asset `failed` olduktan sonra o asseti gösteren belge POST **202** alıyor, iş dakikalar sonra `asset-not-ready: ... (Failed)` ile ölüyordu. `asset-not-ready` gerekçesinin yazılı savunması ("işlenmekte olan asset iş kuyruktan alınana kadar Ready olabilir") DÖRT durumdan yalnız ÜÇÜNÜ kapsıyordu: `Failed` **terminaldir** — durum makinesinde Failed → Ready doğrudan geçişi yoktur, yeniden deneme ancak kullanıcının başlattığı Failed → Processing ile olur. Artık senkron 422. Geçici durumlar (Uploading / Uploaded / Processing) BİLEREK worker'da kalır ve senkron **202** alır — orada ret yanlış ret olurdu. | `ExportCompiler.EnsureAssetFacts` → `asset-failed`; olgu `ExportAssetFacts.Readiness`. **MUHAFIZ BOŞLUĞU DA KAPATILDI**: eski defter yalnız "her gerekçenin bir SATIRI var mı" diye soruyordu; yeni `AssetStatusOwners` defteri `AssetStatus` enum'ını REFLEKSİYONLA tarar, her durum bir satır ister ve **her durum uç noktaya gönderilerek koşturulur** (`EveryAssetStatusHasAnOwnerRow`, `EveryAssetStatusBehavesAsItsRowClaims`) |
| **Klip kaynağın sonunun ötesini okuyamaz** | Kaynak süresini (+1 çıktı frame'i toleransı) aşan klip ffmpeg'de sessiz kısa segment / donmuş kare üretirdi. **Senkron 422**; geçiş payı D/2 kaynaktan FAZLA okuttuğu için mesaj o payı da söyler (kullanıcı timeline'da göremez). Kural TEK yerde tanımlıdır ve iki veri kaynağıyla çağrılır: API `Asset.DurationMicros` ile, worker indirdiği dosyanın ffprobe süresiyle — iki sayı yapısı gereği aynıdır (`ProcessAssetJob` kolonu `MediaProbe.DurationUs`'ten yazar). | `ExportCompiler.FindSourceOutOfRange` (tek tanım); kapı `EnsureAssetFacts` → `source-out-of-range`; worker sarmalayıcısı `ExportJob.FindSourceOutOfRange` |
| **LUT efekti `.cube` OLMAYAN bir dosyayı gösteremez** | ÖLÇÜLEN KUSUR: bu belge **tipli hata bile üretmiyordu**. `ExportJob` LUT id'lerini ffprobe'a sokmaz (doğru — .cube medya değildir), ama TÜRÜNÜ de kontrol etmiyordu: `lut3d` bir `.mp4` yolu alıyor ve iş `ffmpeg-failed: ffmpeg exited with code -22` ile düşüyordu. Artık senkron 422 ve dosya adını söyler. (Bu satır yazıldığında kapı pratikte her LUT efektini reddediyordu çünkü `.cube` yüklenemiyordu; §1.3 KAPANDI — `.cube` artık gerçek bir yükleme türüdür: `AssetKind.Lut` + `application/x-cube-lut`, worker `CubeLutValidator` doğrulamasıyla Ready. Kapı bugün gerçek işini yapıyor: yalnız .cube olmayan dosyayı gösteren LUT efektlerini reddeder.) Kapı "LUT yasak" DEMEZ: gerçek bir `.cube` satırı kabul edilir (negatif kontrol testi vardır). | `ExportCompiler.EnsureAssetFacts` → `lut-asset-type` (`Asset.OriginalFileName` uzantısı — bilinçli: tür beyanı istemcinin sözüdür, dosya adı yüklemenin; ayrıca LUT varlığını KLİP kaynağı yapan belge senkron `asset-clip-type` alır: `ExportAssetMediaKind.Lut`) |
| **Katman boyutu tavanı 8192 px** *(medya / görsel / çıkartma)* | Aşırı ölçek (ve dönmenin açtığı ara tuval) reddedilir. Editör bu satırda **önden korur**: ölçek alanının tavanı proje çözünürlüğünden türer (`maxClipScale`, 1080p'de ~4.266) — ama tavan **ara tuvalden** doğrulanır, editörün tavanı ise KUTUDAN; dönme (~1.41×) ve merkez dışı çapa (2×) ara tuvali büyüttüğü için dönmüş bir katman hâlâ 422 alabilir. | `LayerGeometry.MaxLayerDimension = 8192`; hata `transform-scale` (`ExportCompiler.EnsureLayerCeiling`); editör tavanı `invariants.ts` `maxScaleFor` |
| **Overlay katman tavanı 8192 px** *(metin / şekil)* | Metin/şekil klibinin çizim kutusu proje tuvalinden değil **rasterin kendi bbox'ından** türer (§7 @2x kuralı). Kural bu yüzden eskiden yalnız `Compile`'da bakılıyordu ve iş **kuyruk sonrası** düşüyordu — 3. tur denetiminde ölçülen iki vakadan biri. Artık `Validate`'te: **şekilde** kutu kesindir (sözleşme gereği proje karesi), **metinde** ölçüm yolu varsa gerçek bbox, yoksa **fonttan bağımsız kesin ALT SINIR** kullanılır — yani ölçüm yokluğu yanlış 422 üretmez, yalnız kapıyı zayıflatır. **Ölçüm yolu KAPALIYSA istek artık sessizce geçmez**: API 503 `text-measure-unavailable` döner (§3.3). `Compile`'daki tavan **yedek olarak duruyor** (orada bbox her zaman gerçektir). Editör de önden korur: Inspector'ın **ölçek** ve **font boyutu** tavanları klibin KENDİ kutusundan türer (proje çözünürlüğünden değil) — 2000 px'lik bir başlık, bir video klibinden çok önce sınıra çarpar. | `ExportCompiler.EnsureRasterFits` / `TextBoxLowerBound`, hata `overlay-too-large`; ölçüm yolu: `Api/Program.cs` (`ITextRasterService` DI) → `ExportEndpoints.cs` `ExportCompiler.Validate(doc, overlayMeasurer)`; editör tavanları: `inspector/clipInspectorModel.ts` (`maxScale`, `maxFontSizePx`); GERÇEK KLAVYE kanıtı: `e2e/text-layer-limit.spec.ts` |
| **Metin/şekil klibinin ÇİZİM SÖZLEŞMESİ** *(bu turda `Validate`'e taşındı → senkron 422)* | ÖLÇÜLEN KUSUR: geçersiz ya da eksik bir `text.fill` (ör. `"rgb(1,2,3)"`) **saf doküman kuralı** olmasına rağmen senkron kapıda yoktu — ham API ile ölçüldü: POST **202**, iş dakikalar sonra worker'da `overlay-unsupported-clip` ile `failed`. Artık istek anında 422. Sorulan koşullar raster hattının AYNADAKİ EŞİDİR: `text.fill` **daima**, `text.stroke.color` yalnız `widthPx > 0` iken, `text.background.color` arka plan varken, `shape.fill` **daima**, `shape.stroke.color` `widthPx > 0` iken; ayrıca **gövdesiz `shape`**. Renk dilbilgisi TEK yerden sorulur (`HexColor.TryParse`) ve şemanın `colorHex` regex'iyle birebir aynıdır — iki ayrıştırıcı zamanla ayrışıp "kapı kabul eder, raster reddeder" halini üretemez. Kapı **yalnız GERÇEKTEN rasterlenecek** klipler üzerinde koşar: gizli/atıl track'in metni hiçbir PNG üretmez, orada sorulsaydı görünmeyen bir klip yüzünden geçerli belge reddedilirdi (negatif kontrolü yazıldı). Aynı taramada bulunan İKİNCİ kaçak da kapatıldı: **yinelenen raster klip kimliği** (iki raster, tek PNG dosya adı) da saf doküman aritmetiğidir ve artık senkron 422. | `ExportCompiler.EnsureRasterContract` (+ `EnsureColor` → `HexColor.TryParse`), kod `overlay-unsupported-clip`; yapısal muhafız `ExportGateInventoryTests` → `RasterRefusals` defteri (9 satır, kimlikle eşleşir) |
| **Proje arkaplan rengi ŞEMA DİLBİLGİSİNE uymalı** *(bu turda `Validate`'e eklendi → senkron 422)* | ÖLÇÜLEN KUSUR: `settings.backgroundColor` ffmpeg grafiğine **doğrudan gömülen tek doküman dizesidir** (`color=c=…`, `pad=…:color=…`) ama hiçbir kapıdan geçmiyordu. Ham API ile ölçüldü (aynı belge, yalnız renk değişiyor): `#GGGGGG` → POST **202**, iş dakikalar sonra `ffmpeg-failed: ffmpeg exited with code -22` (**tipli hata bile yok**); `#12345` / `mavi` / `""` / `#00000000ff` → POST **202**, iş **başarılı**, arkaplan **SESSİZCE SİYAH** — kök neden `FfmpegColor`'ın uzunluğu 3/6/8 olmayan her değeri `000000`'a düşüren dalıydı. Artık istek anında 422 ve `FfmpegColor`'ın sessiz varsayılanı yok (aynı kodla fırlatır). Dilbilgisi klip renkleriyle **AYNI** kaynaktan sorulur (`HexColor.TryParse`), kod ise klip kapsamlı DEĞİLDİR — bu bir proje ayarıdır. **Bugünkü arayüzden ULAŞILAMAZ**: `docStore` proje arkaplanını `#000000` sabitler, `ClipPropertiesPanel`'deki `backgroundColor` ise METİN klibinin arka planıdır (başka alan). **Eksik alan da reddedilir** (mesaj ayrıdır: "alanı yok"); depoda bu şekilde iki belge ölçüldü — settings'i `background`/`sampleRateHz` yazan eski bir denetim betiğinden, editörün ürettiği hiçbir belge değil. | Kapı: `ExportCompiler.Validate` (+ `FfmpegColor` sözleşme muhafızı), kod `project-background-color`; ölçüm: `ExportCompilerSnapshotTests.Validate_ProjectBackgroundColor_*` (9 kabul + 9 ret + eksik alan); yapısal muhafız: `ExportGateInventoryTests` → `DocumentStrings` defteri (şemadaki her doküman dizesi REFLEKSİYONLA taranır; ffmpeg dizesine giren her alan dilbilgisi + senkron ret KANITI ister). **KULLANICIYA KURULAN CÜMLE 11. turda düzeltildi:** bu kod (ve LUT efektinin `assetId`'si için `lut-asset`) bir *"henüz desteklenmeyen özellik"* DEĞİLDİR — arkaplan rengi de LUT da DESTEKLENİR, kusur bir ALANIN DEĞERİNDEDİR. Üçüncü cümle sınıfı: sunucu başlığı *"Timeline contains a value the exporter cannot use"*, editör cümlesi *"Bu projedeki bir ayar geçersiz bir değer taşıyor: …"*; iki liste (`ExportEndpoints.DocumentValueFeatures` ↔ `exportLogic.ts` `VALUE_CODES`) `ExportGateInventoryTests.TheClientAndServerAgreeOnWhichCodesMeanABadValue` ile karşılaştırılır ve üç kümenin AYRIK olduğu aynı testte ölçülür |
| **Proje kare hızı 1–240 fps aralığında olmalı** *(10. tur denetimi → senkron 422)* | ÖLÇÜLEN KUSUR: `settings.fps` yalnız "pozitif rasyonel" isteniyordu, **üst sınır yoktu**. Ham API ile ölçüldü (kapı eklenmeden ÖNCEKİ ikiliyle, bu makinede): `fps = {num:100000, den:1}` + tek **0,5 saniyelik** klip → POST **202**, iş **başarıyla** tamamlandı ama **144,5 sn** sürdü — 0,5 saniyelik bir çıktı için. Çünkü render maliyeti KARE SAYISIYLA doğrusaldır ve o belge 50.000 kare istiyordu (aynı makinede 1080p/30'da 1800 kare **14,1 sn**). Karşılaştırma (ölçüldü): `width = 100000` etkin biçimde zaten kapalıydı — katman tavanı (8192) `transform-scale` koduyla **422** veriyor — ama fps'in eşdeğeri yoktu. Artık istek anında 422. **ARALIĞIN GEREKÇESİ:** pencere yayın hızlarının **tamamını** (23.976 = 24000/1001, 24, 25, 29.97 = 30000/1001, 30, 50, 59.94 = 60000/1001, 60) ve tüketici **yüksek-kare-hızı** çekimlerini (120, 240) kapsar; editör zaten 30 fps sabitler. Karşılaştırma tam sayı çarpımıyla yapılır — rasyonel hızlar (24000/1001) yuvarlama hatası olmadan sınanır. **YANLIŞ RET ÜRETMEZ, ÖLÇÜLDÜ:** yukarıdaki 11 hızın hepsi ham API'de **202** aldı; tavan (240), taban (1), NTSC rasyoneli (24000/1001) ve 60 fps **gerçekten render edildi ve `succeeded` oldu**. | Kapı: `ExportCompiler.Validate` (`MinProjectFps` = 1, `MaxProjectFps` = 240), kod `project-fps-out-of-range`; ölçüm: `ExportGateInventoryTests.FpsWindowBothSidesBehaveAsTheLedgerClaims` (pencerenin İKİ yanı — 11 kabul + 4 ret, hepsi uç noktaya gerçekten gönderilir) |
| **Zaman çizelgesinin toplam süresi ≤ 4 saat** *(10. tur denetimi → senkron 422)* | ÖLÇÜLEN KUSUR: toplam süreye tavan yoktu ve **kusur altyapıya atılıyordu**. Ham API ile ölçüldü (kapı eklenmeden ÖNCEKİ ikiliyle, bu makinede): çizelgesi ~**3,17 yıl** olan bir belge POST **202** aldı, worker **150.000.010.710.108 bayt (≈150 TB)** geçici alan istedi (boş alan 431 GB), `disk-wait` ile üç kez kuyruğa döndü ve **256,2 sn** sonra `disk-full: insufficient disk space after 3 attempts` ile düştü — yani **belgedeki** bir kusur kullanıcıya *"sunucunun diski bitti"* diye gösteriliyor, üstelik sunucunun boş alanı yüzüne yazılıyordu. Disk rezervasyonu formülü `Σkaynak + süre × profil-bitrate` + %20'dir ve baskın terim **süredir** — yani saf doküman aritmetiği. Artık istek anında 422. **TAVANIN GEREKÇESİ (keyfi değil, dört ölçüt):** (0) **deponun kendi sayısı** — `ProcessingOptions.MaxDurationUs` TEK KAYNAK için zaten 4 saatlik bir tavan taşıyor (aşan dosya işlemede `too-long` ile düşer); çizelge tavanı AYNI sayı seçilerek sistem tek cümleye indirgendi: *"yükleyebileceğin en uzun dosya = dışa aktarabileceğin en uzun çizelge"*; (1) **disk** — 4 saatte profil TABANINDAN doğan rezervasyon **21,6 GB**'dir (`EstimateRequiredDiskBytes(0, 4 sa, 10 Mbps)`; testle sabitlenmiştir), kullanıcı başına eşzamanlı export tavanı 2 olduğu için en kötü hâlde 43,2 GB — *dalga 2'de eklenen 2160p profili tabanı 40 Mbps'e taşır: tavandaki 4K rezervasyonu **86,4 GB**, en kötü uç 172,8 GB; bu uç garantiye alınmaz, gerçek darlıkta worker'ın `disk-wait`/`disk-full` hattı tipli düşer (aynı testte 4K ucu da sabitlidir)*; (2) **render süresi** — tek worker, tek `export` kuyruğu (§4.1); bu makinede ölçülen basit-kompozisyon hızı 60 sn / 1800 kare → **14,1 sn** (~4,3× gerçek zaman; aynı hatta 10 sn / 300 kare → 6,0 sn), yani 4 saatlik bir çizelge tek başına **saatler** sürer ve o süre boyunca tek `export` kanalını kilitler — bu **doğrusal bir uzatma**dır, ölçülmüş bir 4 saat koşusu DEĞİLDİR; (3) **kapsam** — kurgu projelerinin tamamı bu pencerenin çok altındadır. **GERÇEK disk darlığı ile karıştırılMAZ:** worker'ın `disk-full` yolu yerinde durur ve tavanın ALTINDAKİ bir belge için de tetiklenebilir — orada kusur gerçekten kurulumdadır. **YANLIŞ RET ÜRETMEZ, ÖLÇÜLDÜ:** tam tavana oturan çizelge (4 sa) **202** alır ve iş satırı oluşur; tavanın **1 kare** ötesi 422 olur. | Kapı: `ExportCompiler.Validate` (`MaxTimelineDurationUs` = 4 saat), kod `timeline-too-long`; ölçümler: `ExportGateInventoryTests.TimelineDurationCeilingBothSidesBehaveAsTheLedgerClaims` (tavanın iki yanı), `ExportJobTests.EstimateRequiredDiskBytes_AtTimelineCeiling_StaysWithinReservationBudget` (21,6 GB sabiti), `ExportJobTests.Run_GenuinelyFullDisk_OnFinalAttempt_StillFailsWithDiskFull` (gerçek darlık HÂLÂ `disk-full`), `ExportJobTests.TimelineCeiling_MatchesTheIngestDurationCeiling` (iki tavan aynı sayı). **KULLANICIYA KURULAN CÜMLE de ayrıldı:** bu iki kod (`timeline-too-long`, `project-fps-out-of-range`) *"henüz desteklenmeyen özellik"* DEĞİLDİR — belge geçerli, özellik destekli, proje yalnız pencerenin dışında. Sunucu başlığı *"Timeline exceeds an export resource limit"*, editör cümlesi *"Bu proje dışa aktarma sınırlarının dışında: …"*; iki liste (`ExportEndpoints.CeilingFeatures` ↔ `exportLogic.ts` `CEILING_CODES`) `ExportGateInventoryTests.TheClientAndServerAgreeOnWhichCodesMeanAResourceCeiling` ile karşılaştırılır |
| **Geçişli kesimde iki klibin yerleşimi aynı olmalı** *(doküman değişmezi + SENKRON 422)* | `xfade` kesimin iki tarafını TEK akışa katlar ve iki girişin **aynı boyutta** olmasını şart koşar; farklı yerleşim, katmanın geçiş boyunca sessizce kaymasına yol açardı. Kullanıcı bunu bir **hata olarak görmez**: yerleşim yazan her işlem (transform yazma/sıfırlama **ve geçiş ekleme**) yerleşimi geçiş zincirinin tamamına **yayar** ve bunu bildirir. **Derleyicideki kapı bu turda `Validate`'e taşındı**: hesap saf doküman aritmetiğidir (`LayerGeometry.Compute` yalnız transform + proje tuvali okur, kaynak dosyasına dokunmaz), dolayısıyla API'nin ön kapısı artık onu GÖRÜR ve ham API'ye doğrudan yazılmış bir belge de 202 yerine 422 alır. Kapı yalnız kesimin GERÇEKTEN xfade'e döndüğü yerde çalışır — gizli track'te ve ses klibinde yerleşimin rolü yoktur (acrossfade yerleşim bilmez), oralarda tetiklenmez. Editördeki kapı da yerinde durur (kullanıcı hatayı hiç görmesin diye). | Normatif kural: `docs/rendering-semantics.md` §5.2; değişmez: `packages/timeline-schema/src/invariants.ts` `checkTransitionPlacement`; editör: `state/timelineOps.ts` `alignTransitionChainTransforms` + `propagateTransformToChain`; derleyici: kural `ExportCompiler.EnsureTransitionPlacement` (Validate → 422), `Compile`'daki dal AYNI mesajla sigortadır; GERÇEK FARE + KLAVYE kanıtı: `e2e/guard-paths.spec.ts` (c2) — "böl → ölçekle → geçiş ekle" sırası kurulup iş **gerçekten render ediliyor** (kuyrukta ölmüyor). Ölçek gizmoya bırakılMAZ, **klavyeyle sabitlenir**: `0.501` (kutu 962×541, TEK) ve `0.502` (kutu 964×542, ÇİFT) — testin eski hali gizmonun rastgele "güvenli" bir değere düşmesi sayesinde üç tur yalancı yeşildi |
| **Geçişli kesimde katman DÖNMÜŞ + çapası merkez dışı olamaz** *(derleyici, `Validate` → senkron 422)* | Geçişte run bölünemez → kutuya normalize pad zorunludur; bu pad §2.5'in çapa telafisini yanlış tabana oturtur (telafi gerçek görüntü boyutuna göre ölçeklenir, normalize sonrası taban kutudur) → çapa letterbox payı kadar kayardı. **Editörden ULAŞILAMAZ**: arayüzde çapa alanı yoktur, doküman daima `anchor = 0.5` yazar. 4. tur öncesinde bu mesaj **kutu paritesi** ihlallerinde de veriliyordu — yani `rotationDeg = 0` ve `anchor = 0.5` olan kliplerde kullanıcıya "katman döndürülmüş ve çapası merkezde değil, çapayı merkeze alın" deniyordu; parite kapısı kalktığı için o yanlış dal da kalktı. | `ExportCompiler.EnsureTransitionPlacement` → `transition-rotated-anchor` (makine-okur kod), `Compile`'daki dal AYNI mesajla sigortadır; testler: `ExportCompilerSnapshotTests.Validate_TransitionOnARotatedOffCenterAnchorLayer_ThrowsUnsupportedFeature` (iki kapının mesajı BAYT AYNI), `Validate_RotatedOffCenterAnchor_WithoutATransition_IsAccepted` (negatif kontrol: kural geçişe bağlıdır), `Compile_TransitionOnARotatedOffCenterAnchorLayer_ThrowsUnsupportedFeature` |
| **Ölçek TABANI: aşırı geniş/dar kaynakta katman "bir pikselin altına" düşemez** *(4. tur ölçümü; 5. turda ANİMASYONLU yola genişletildi)* | Kaynağın en-boy oranı katmanın kutusundan çok büyükse (ör. **1920×100** afiş, 19.2:1), çok küçük ölçekte ffmpeg'in sığdırdığı eksen **1 pikselin altına** iner; filtre o ekseni `0` hesaplar ve `0`'ı *"girdi boyutunu koru"* diye yorumlar → katman **kaynağın kendi boyutunda** çizilir. Ölçüldü: 1080p'de ölçek `0.010` iken kutu `19×11`, gerçek çıktı `18×100` — yani **100 kat** yüksek. İki sonuç sınıfı vardı ve ikisi de kabul edilemezdi: ya iş **kuyruk sonrası** ffmpeg `-22` ile ölüyordu, ya da (kaynak pad hedefine sığdığında, ör. `200×10`) hiç hata vermeden **sessizce** yanlış boyutta çiziliyordu — bu ikincisi **düzeltmeden önce de** vardı ve hiçbir kapı görmüyordu. Artık **senkron 422**: iş kuyruğa hiç girmez, mesaj hem nedeni (kaynağın oranı) hem eylemi (**"ölçeği en az 0.011 yapın"** — kesin bir sayı) söyler. **Normal medya etkilenmez**: 16:9, 4:3, kare, dikey ve 21:9 kaynaklar editörün yazabildiği hiçbir ölçekte bu rejime giremez (1080p'de eşik: oran **> 19:1** ya da **< 1:11**). **Metin/şekil katmanları BAĞIŞIK DEĞİLDİR** (5. tur denetiminde ölçülerek yanlışlandı): kaynak-oranı yarısına giremezler, ama yüklemin ikinci yarısına — kutunun bir ekseninin **2 pikselin altına** inmesi — ölçek ANİMASYONUYLA girerler. Gerçek fareyle ölçüldü: metin klibi + ölçek keyframe'i `0.010` → bbox `223×104` için kutu `2×1` (worker'da `degenerate-layer`), bbox `6×20` için kutu `0×0` (ffmpeg 99 kare yazdıktan SONRA `Picture size 0x4 is invalid`, exit −12). Kapı artık raster kliplerinde de koşuyor ve animasyonlu yolda kutuyu ffmpeg'in KIRPMA aritmetiğiyle sorup mesajı keyframe'e yönlendiriyor. **Editör bu satırda ÖNDEN KORUMAZ** — ölçek alanının tabanı hâlâ `0.01`, ölçek keyframe'inin tabanı da öyle; **dışa aktarma penceresi de istek gönderilmeden önce hiçbir uyarı göstermez** (`ExportDialog.tsx` okumasıyla: tek `role=alert` yalnız istek BAŞARISIZ olduktan sonra basılır, düğme de yalnız gönderim sürerken devre dışı kalır). Kullanıcı sınırı ancak 422'nin mesajından öğrenir; bilinçli kapsam kararı, bkz. `docs/backlog.md`. | Kural: `LayerGeometry.IsDegenerate` / `IsBelowScaleFloor` / `MinScaleFor`; kapı: `ExportCompiler.EnsureLayerFloor` (`Validate` → 422, `Compile` → tipli hata), hata kodu `degenerate-layer`; normatif tanım `rendering-semantics.md` §2.5; GERÇEK FARE kanıtı: `e2e/degenerate-layer.spec.ts` (statik ölçek — POST'un kendisi 422 döner) ve `e2e/degenerate-animated-scale.spec.ts` (ölçek keyframe'i — iki varyant) |
| **Metin/şekil klibinde GEÇİŞ kurulamaz** *(kapsam sınırı — ölçüldü)* | Geçiş rozeti yalnız **medya** kliplerinin kesimlerinde açılır: kesim çözümleyici, iki taraf da medya klibi değilse `null` döner (`if (!isMediaClip(a) \|\| !isMediaClip(b)) return null;`), rozet listesi de onun üstünden kurulur. Yani "yazı yazıdan çapraz geçsin" POC'ta **yapılamaz** — bir hata değil, kapsam dışıdır. Derleyici tarafında böyle bir belge yasak değildir (elle kurulabilir), ama editör onu üretmez. | `state/timelineOps.ts` `findTransitionCut`; rozet kaynağı `transitionEdgesOf`; süre planlayıcısı `planTransitionDuration` zaten yalnız `MediaClip` alır |
| **Export profilleri: 1080p / 720p / 2160p (4K) / dikey (1080×1920)** *(dalga 2, 2026-08-21 — "tek profil" satırı kapandı)* | Profil, BİTMİŞ tuval kompozisyonunu kendi hedef kutusuna tek `scale` ile taşır (bicubic + `setsar=1`; tuval == hedefse ölçek aşaması hiç üretilmez — eski davranış bit-bit korunur). **EN-BOY KURALI KISITTIR, letterbox değil**: profil ancak tuvalle AYNI orandaysa uygulanır; farklı oran senkron tipli **422 `export-profile-aspect`** (Türkçe cümle uyumlu profilleri sayar; ExportDialog uyumsuz profili zaten yerinde devre dışı bırakır). ÖLÇÜLEN GEREKÇE: 16:9→9:16 letterbox'ın tam ölçeği 1080×**607,5** pikseldir (yarım piksel — ffmpeg 608'e yuvarlar, ölçülen içerik satırları 656..1263) ve karenin **%68,3'ü** bant olur; önizleme daima proje tuvalini gösterdiğinden böyle bir kare önizlemesiz üretilmiş olurdu (§9.3 parite doktrini). KAPSAM SINIRI: 16:9/9:16 DIŞI tuval (editör kuramaz, yalnız ham API) artık HİÇBİR profile uymaz ve dışa aktarılamaz — eski davranış (tuval çözünürlüğünde çıktı) bu tuvallerde kaybedildi; 422 cümlesi tuvali 16:9/9:16 yapmayı önerir. Codec: libx264 `veryfast` + AAC 192k; CRF 18 (2160p'de tasarım 04 §5 gereği 19); `-level` bilerek verilmez (x264 otomatiği her çözünürlük/fps'te doğru beyan üretir — sabit 5.1, 4K@60+ karede yanlış olurdu). | `ExportProfiles.cs` (`SpecFor` — karar ölçümleri yorumda); gerçek render kanıtları `ExportProfileGoldenTests`; kapı satırı `ExportGateInventoryTests.CompilerGates` (`export-profile-aspect`) |
| **Doküman tavanları** | En fazla 50 track, 2000 klip, ~2 MB timeline gövdesi; sample rate 44 100 veya 48 000. | `TimelineRequestValidation` |
| **Kaynak süresi tavanı 4 saat** | Aşan medya probe SONRASI, transcode ÖNCESİ `too-long` ile düşer. | `ProcessingOptions.MaxDurationUs`, düşüş: `ProcessAssetJob.Run` |

**KLİP TÜRÜ ↔ VARLIK TÜRÜ: TAM MATRİS** (yukarıdaki iki satırın açılımı). Kapının sorduğu şey
klibin **ne okuduğudur** (`ExportCompiler.NeedOf` → Motion / Still / Audio), dosyanın ne
içerdiği değil. ✅ = 202 (iş kuyruğa girer), **422** = senkron ret, kod `asset-clip-type`.

| Klip (okuduğu) | video varlığı | ses varlığı | görsel varlığı |
|---|---|---|---|
| **video klibi** (Motion: zaman aralığı okur) | ✅ | **422** | **422** |
| **ses klibi** (Audio: ses akışı okur) | ✅ sesli video · **422** SESSİZ video | ✅ | **422** |
| **görsel klibi** (Still: `-loop 1`, tek kare) | **422** | **422** | ✅ |
| **çıkartma** (Still) | **422** | **422** | ✅ |

- 4 × 3 = 12 kombinasyon + **"sessiz video"** özel hali = **13 satır**; hepsi uç noktaya
  GERÇEKTEN gönderilerek koşar (`ExportGateInventoryTests.TheWholeClipKindAssetKindMatrixBehavesAsTheLedgerClaims`)
  ve testin kendisi kombinasyon sayısını enum'lardan sayar — yeni bir klip/varlık türü
  eklenirse satır eklemek ZORUNLUDUR.
- **"Sessiz video" neden ayrı:** ses varlığında ses akışı GARANTİDİR (`ProcessAssetJob.GateByKind`),
  görselde YOKTUR — ama bir videonun sesi olup olmadığı ancak **probe edilmiş (Ready)** satırda
  bilinir. Kapı bu tek olguyu yalnız Ready satırda sorar; geçici durumdaki satırda susar.
- **Tür beyanı geçici durumda da sorulabilir** ve bu yanlış ret üretmez: beyan yükleme anında
  yapılır, worker işleme sonunda beyanı ffprobe ile karşılaştırır ve tutmuyorsa asset Ready
  OLAMAZ — yani beyanla çelişen bir belgenin başarıya giden yolu yoktur.
- **Matriste OLMAYANLAR:** metin/şekil klipleri hiçbir varlık okumaz (raster hattı); LUT efekti
  bir varlık okur ama akış istemez — onun kapısı ayrıdır ve dosya adına bakar (`lut-asset-type`).
- Tabloda **8 uyuşmazlık hücresi** var; **editör bunların YEDİSİNİ üretemez** — klip türü
  varlığın türünden doğar (`timelineOps.buildClipFromAsset`; `addStickerClip` ayrıca
  `asset.kind !== 'image'` ise reddeder); kapı ham API'ye yazan istemci ve
  kullanıcının kütüphanesiyle belgesinin zamanla ayrışması için vardır. **AMA "ses klibi +
  SESSİZ video" hücresi bir istisna gibi duruyor** (kod okumasıyla bulundu, 8. turun doküman
  yüzünde — **gerçek fareyle ÖLÇÜLMEDİ, iddia değil UYARIDIR**): ses klibinin ÜÇÜNCÜ üretim
  yolu **"Sesi ayır"**dır (`timelineOps.detachAudio`) ve o yol varlığın gerçekten sesi olup
  olmadığına BAKMAZ — editör `hasAudio` olgusunu (API `AssetSummary`'de döner) hiçbir yerde
  okumaz, klibin `audio` alanı her video varlığında dolu doğar. Yani sessiz bir videoda
  "Sesi ayır" menüde AÇIK görünür ve ortaya çıkan belge dışa aktarmada 422 alır. **Sessiz
  bozulma yoktur** (mesaj tipli ve nedeni doğru: *"ses klibi yalnız ses akışını kullanır, ama
  bu videonun ses akışı yok"*) ve bu yol **düzeltmeden önce de çalışmıyordu** — worker'da
  anlamsız bir ffmpeg hatasına dönüyordu (`ExportJobPipelineTests.Export_AudioClipOnASilentVideo_FailsWithATypedError_NotAnFfmpegExitCode`).
  Eksik olan **önden uyarıdır**: `docs/backlog.md` 8. tur bölümüne açık madde olarak yazıldı.

### 3.1 Emoji font seti YOK

Küratörlü set 4 aile × 4 stil = 16 TTF (Roboto, Open Sans, Noto Sans, Noto Serif) — **emoji
fontu içermez**. Emoji içeren metin `.notdef` kutusu ("tofu") olarak çizilir. Sessiz kalmaz:
raster sonucu `HasMissingGlyphs = true` döner ve worker etkilenen klipleri **loglar**
(`Text/SkiaGlyphMeasurer.MeasureInk`, `Worker/Jobs/ExportJob.Run`) — ama iş DÜŞMEZ, kullanıcı
tofu'lu bir video alır. Çözüm ayrı bir `fontId` (ör. Noto Color Emoji) + glif düzeyinde
fallback zinciri gerektirir.

### 3.2 Pis-dosya korpusu test edilmedi

iPhone HLG/HDR, VFR (OBS kayıtları), döndürme metadata'lı dikey MOV, WhatsApp re-encode gibi
gerçek dünya dosyaları için **uçtan uca korpus testi yok**. Motorda karşılıkları var (HDR→SDR
zinciri, VFR→CFR sabitleme, autorotate) ve birim/snapshot testleri var
(`ExportSnapshots/hdr-source.txt`, `ntsc-fps.txt`, `MediaProbeParserTests`), ama gerçek
telefon dosyalarıyla doğrulanmadı. **POC'ta beklenmedik kaynak dosyalarla sorun yaşayabilirsiniz.**

---

### 3.3 Metin ölçüm yolu kapalıysa export **422 değil 503** ile durur

> **ÖNCE AYRIMIN KULLANICI DİLİYLE ÖZETİ (bu turda düzeltildi).**
>
> | Cevap | Ne demek | Kullanıcının yapması gereken |
> |---|---|---|
> | **422** `font-missing` | "Belgeniz sunucunun **tanımadığı** bir yazı tipi kullanıyor." | Metin klibinin fontunu listedeki bir fontla değiştirin (`GET /api/fonts`). |
> | **503** `text-measure-unavailable` | "Sunucu **şu anda** metin ölçemiyor (font kurulumu / metin motoru eksik)." | Bir şey değiştirmeyin; yönetici kurulumu düzeltince **aynı istek çalışır**. |
>
> **ÖLÇÜLEN KUSUR (bu turda kapandı):** bilinmeyen bir `fontId` taşıyan belge — ki gerçekçi
> tetikleyicisi editörün ESKİ varsayılanını (`inter`) taşıyan eski bir belgedir — **503**
> alıyordu. Yani kullanıcıya "yeniden deneyin" deniyor ama o istek **asla** çalışmıyordu:
> kusur belgedeydi, kurulumda değil. Kök neden ikiliydi ve **ikisi de düzeltildi**; her biri
> tek başına yük taşıyor, yani biri geri alınırsa diğeri hâlâ doğru cevabı verir:
>
> 1. **TÜR AYRIMI.** Ölçüm hatasını yutan geniş `catch` ikiye bölündü. "Bu id hiçbir manifestte
>    YOK" olgusu **kurulumdan bağımsız ve kalıcıdır** (font kökü düzeltilse bile aynı belge aynı
>    hatayı verir) → tipli **422** `font-missing`. Gerçek kurulum arızaları — TTF indirilmemiş,
>    manifest bozuk, font dosyası açılamıyor, Skia yerel kütüphanesi yüklenemedi — → **503**.
>    Ayrımın taşıyıcısı `FontNotFoundException.ExpectedPath`'tir: `UnknownId` fabrikası yol
>    taşımaz, `FileMissing` taşır.
> 2. **SIRA.** Font ön kontrolü artık `ExportCompiler.Validate`'ten **ÖNCE** koşuyor. Manifest
>    kesin cevabı verebiliyorken ölçüm **hiç denenmez** — ucuz ve kesin kapı önce çalışır.
>
> **YAN BULGU — iki sahte yanlış etiketlenmişti.** Bu ayrımı "zaten koruduğu" sanılan mevcut
> yeşil test (`StartExport_UnknownFontId_Returns422_BeforeQueueing`) `measurer = null` ile
> koştuğu için **canlı kurulumu hiç sınamıyordu**. Ayrıca hem `ExportEndpointsTests`'in hem
> `ExportCompilerSnapshotTests`'in "font kurulu değil" diye adlandırılmış sahteleri aslında
> `UnknownId` (belge hatası) fırlatıyordu — yani 503'ün DARLIĞINI hiç sınamıyorlardı. İkisi de
> gerçek kurulum arızasına (`FileMissing`) çevrildi ve belge yarısı için ayrı sahteler eklendi.
>
> Bugün bu ayrımı koşan testler: `ExportEndpointsTests.StartExport_UnknownFontId_`
> `WithALiveMeasurer_StillReturns422_NotA503` (CANLI ölçer — kusurun kendisi),
> `…_MeasurerDoesNotKnowTheFont_Returns422_NotA503` (tür mekanizması),
> `…_UnknownFontId_IsAnsweredWithoutMeasuringAnything` (sıra mekanizması),
> `…_KnownFontId_DoesReachTheMeasurer` (negatif kontrol: ön kontrol ölçeri GÖLGELEMİYOR),
> `…_CuratedFontIdWithALiveMeasurer_IsAccepted` (negatif kontrol: canlı kurulum çalışıyor),
> `ExportCompilerSnapshotTests.Validate_MeasurerDoesNotKnowTheFontId_IsADocumentFault_NotAnOutage`.

**Ölçülen durum (canlı A/B, iki API süreci, md5-ÖZDEŞ DLL, tek fark `VIDEOEDIT_FONT_ROOT`):**
font kökü sağlamken metin kapıları çalışıyordu (POST 422 `degenerate-layer`, iş satırı yok);
font kökü yokken (`GET /api/fonts` 503) **aynı belge POST 202 alıyor** ve iş dakikalar sonra
worker'da `failed` oluyordu. Kök neden `ExportCompiler.EnsureRasterFits` içindeki
`if (!box.Exact) return;` — ölçüm yoksa TABAN kapısı sorulamaz (metin genişliğinin fonttan
bağımsız bir ÜST sınırı yoktur, dolayısıyla alt sınırdan "kutu çok küçük" sonucu çıkarılamaz).

**Karar: (b) — tipli, senkron `503`.** 422 DEĞİL. Gerekçeler:

1. Ölçüm yolu kapalıyken **aynı kurulumda font manifesti de okunamaz**, yani `font-missing`
   ön kontrolü de sessizce atlanır: tek arızayla İKİ kapı birden kararır.
2. O kurulumda metin export'u **zaten tamamlanamaz** — worker rasterlemek için aynı Skia +
   font köküne muhtaçtır (`OverlayRasterPlanner` → `OverlayRasterException` → `failed`).
   Yani bugünkü davranışın tek çıktısı "202 → dakikalar → başarısız"dı.
3. **422 yanlış olurdu**: kusur kullanıcının belgesinde değil KURULUMDADIR. 503 doğru anlamı
   taşır, yeniden denenebilir ve yönetici font kökünü düzeltince aynı istek çalışır.

**Sınırı dar tutuldu** (yanlış ret riskine karşı): 503 yalnız (i) belgede METİN klibi varsa,
(ii) API'ye bir ölçer GERÇEKTEN kayıtlıysa, (iii) ölçüm DENENİP başarısız olduysa **ve
(iv) başarısızlık BELGEDEN değil KURULUMDAN geliyorsa** doğar. Dördüncü koşul bu turda eklendi
(yukarıdaki iki mekanizma); onsuz bilinmeyen bir `fontId` 503 üretiyordu. Şekil klibi ölçüm
istemez (kutusu sözleşme gereği proje karesidir) ve hiç ölçer kayıtlı olmayan kurulumlarda eski
hoşgörülü davranış AYNEN korunur. Kalan varsayım yazılıdır: API
ile worker aynı `TextRasterOptions.FontRoot`/`FontRootLocator`'ı kullanır — fontları
worker'da olup API'de olmayan bir dağıtımda bu 503 yanlış ret olurdu (o dağıtım metin için
zaten bozuktur: `/api/fonts` 503 döndüğü için editör font bile listeleyemez).

**8. TUR EKLEMESİ (N4) — ÖLÇÜM YAPILDI ama PİNLİ DEĞİL (sistem fontu) hali AYRI bir haldir.**
Küratörlü TTF kurulu değilken üç modlu politikanın 2. modu devreye girer: ölçüm **başarılı**
olur ama yerel bir sistem fontuyla yapılır. Bu kutu, worker'ın çizeceği küratörlü kutunun ne
üst ne alt sınırıdır — **ölçüldü** (Windows 11, SkiaSharp 3.116.1, küratörlü set ↔ sistemin
seçtiği aileler: roboto→Arial, open-sans/noto-sans→Segoe UI, noto-serif→Times New Roman;
düzenek: 4 fontId × 3 punto {24, 64, 200} × 2 ağırlık {400, 700} × 5 metin, aynı içerik iki
kez ölçülüp bbox karşılaştırıldı):

| Ölçü | Ayrışma aralığı | En kötü vaka |
|---|---|---|
| bbox **genişliği** | **−21,1% … +7,9%** | `noto-serif` 700, dar glifli metin (`iiii…`) → Times New Roman **%21,1 DAR** ölçüyor |
| bbox **yüksekliği** | en çok **3,8%** | `noto-serif` 400, tek satır |

Sonuç: kapı bu sayıya güvenseydi 8192 px'lik üst sınır **kurulum durumuna** bağlanırdı — aynı
belge fontları indirilmiş makinede kabul, indirilmemişte RET alabilirdi (+7,9% yönü **yanlış
422** üretir). Bu yüzden **pinlenmemiş ölçüm kutuyu KESİNLEŞTİRMEZ**: kapı font-BAĞIMSIZ alt
sınıra düşer (ölçüm hiç yokmuş gibi), rejim `503` DEĞİLDİR (ölçüm patlamadı; 503 olsaydı
fontları indirilmemiş her kurulumda metin içeren HER export reddedilirdi) ve gerçek tavan
render anında **çizilen rasterin gerçek kutusuyla** sorulmaya devam eder. Ters yön
(−21,1%: sistem DAR ölçer) kapıyı zayıflatır ama sessiz bozulma üretmez — iş worker'da tipli
`overlay-too-large` ile düşer. Taşıyıcı: `TextLayout.FontIsDeterministic`
(`SkiaOverlayRasterService.Measure` → `FontFile.Deterministic`); kapı:
`ExportCompiler.RasterBoxOf`. Testler:
`ExportEndpointsTests.StartExport_SystemFontMeasurement_DoesNotDecideTheCeiling` (aynı sayılar
pinli ölçümle 422 üretiyor, pinsizle 202) ve `…_StillRejectsWhatTheLowerBoundCanSee` (kapı
kapanmıyor: yükseklikten taşan kutu hâlâ 422).

Kural: `ExportCompiler.RasterBoxOf` ölçülemeyen klipleri `ExportPlan.UnmeasuredTextClipIds`
defterine yazar (derleyici HTTP durumu seçmez); kararı `ExportEndpoints.StartExport` verir,
kod `text-measure-unavailable`. Testler:
`ExportEndpointsTests.StartExport_MeasurementFailure_Returns503_NotBlamingTheDocument`,
`…_MeasurementFailureWithoutTextClips_IsUnaffected` (negatif kontrol),
`…_NoMeasurerRegistered_KeepsTheOldLenientBehaviour` (negatif kontrol); istemci tarafı
`exportLogic.mapExportError` 503'ün `detail`'ini **olduğu gibi** gösterir (kuru bir
"tekrar deneyin" sunucu arızasını gizlerdi).

## 4. İşletim / dayanıklılık sınırları

### 4.1 Tek worker, tek eşzamanlı export

`AddHangfireServer` iki AYRI server ile iki kuyruk kurar (`Worker/Program.cs`, iki `AddHangfireServer` çağrısı):

- `transcode` kuyruğu: `WorkerCount = 2`
- `export` kuyruğu: **`WorkerCount = 1`** — ffmpeg render'ı zaten tüm çekirdekleri kullanır

Yatay ölçekleme (birden çok worker konteyneri) **denenmedi**. Kullanıcı başına eşzamanlı
(`Queued`|`Running`) export tavanı **2**'dir; aşımı 429 döner
(`ExportEndpoints.MaxConcurrentExportsPerUser` ve onu okuyan eşzamanlılık sayımı). Pratikte: iki kullanıcı aynı
anda export başlatırsa **sıraya girerler**.

**Tek kanalın bedeli ve iki bekçi.** Kanal tek olduğu için **tek** bir kaçak render herkesin
export'unu kilitler. Bu yüzden ffmpeg'in İKİ tavanı vardır ve **ayrı şeyleri** ölçerler:

| Bekçi | Neyi ölçer | Tetiklenince |
|---|---|---|
| Sessizlik (`FfmpegRunner.DefaultWatchdogTimeout`, 120 sn) | süreç **hiç** çıktı üretmiyor mu | `ffmpeg-timeout` |
| Çıktı saati (`FfmpegRunner.OutputTimeCeilingUs`, beklenen × 1,10 + 5 sn) | süreç beklenenin **ötesine** yazmaya devam mı ediyor | `render-overrun` |

İkincisi 11. turda eklendi, çünkü sessizlik bekçisi kaçak grafiği **göremiyordu**: kaçak süreç
durmadan `-progress` bastığı için asla "sessiz" olmuyor ve 120 sn hiç dolmuyordu (§1.9).
**Pay ölçülerek seçildi:** normal bir render'ın bildirdiği EN BÜYÜK `out_time` beklenen sürenin
**altındadır** (19 sn'lik çizelgede 18,933; 60 sn'lik çizelgede 59,933 — ikisinde de 66,7 ms
eksik), tavan ise beklenenin %10 + 5 sn üstüdür; ayrıca işin çıktı süresi için kabul ettiği
sapmadan (±1 sn) **geniş** olmak zorundadır, yoksa runner işin kabul edeceği bir render'ı
öldürürdü. Ürün düzeyinde ölçüldü: kaçak grafikle iş **6,1 / 7,6 sn**'de `render-overrun` ile
düştü ve kaçak süreç kalmadı; 19 sn'lik ve **60 sn'lik** normal projeler tavana çarpmadan
tamamlandı (6/6 ve 1/1).

**Tavan yalnız EXPORT reçetesinde açıktır** — varlık işleme reçetelerinin (proxy/filmstrip/poster)
`out_time` davranışı ölçülmedi ve onlar bilerek **kapsam dışıdır** (`docs/backlog.md`); orada
yalnız sessizlik bekçisi çalışır.

Ek olarak reaper (`AssetReaperJob`) bir iş satırını `stalled` yaparken **koşan render'ı da
iptal eder** (`RunningRenderRegistry` → `FfmpegRunner`'ın iptal kaydı süreç AĞACINI öldürür);
eskiden satır "başarısız" derken süreç makineyi meşgul tutmaya devam edebiliyordu. Bu iptal
**aynı worker süreci** kapsamındadır (çok makineli kurulum kapsam dışı — `docs/backlog.md`).

### 4.2 Gerçek Cloudflare R2 hiç denenmedi

Tüm geliştirme ve test **lokal MinIO** ile yapıldı (`appsettings.Development.json` →
`ServiceUrl: http://localhost:9000`; CI'da da MinIO konteyneri). S3 API uyumlu olduğu için
kod yolu aynıdır, ama şunlar **doğrulanmamıştır**: gerçek R2 CORS davranışı, presigned URL
imza uyumu, çok parçalı `ETag` biçimi, hesap düzeyi hız sınırları, lifecycle kuralları.
`deploy/README.md` §4 gerekli adımları tarif eder — **ilk gerçek dağıtımda buraya vakit ayırın.**

**Kullanıcının gereksinimi buraya bakıyor.** İlk mesajdaki istek "R2'de saklayıp SONRADAN
TEKRAR DÜZENLEYEBİLME" idi. Bu cümlenin **iki yarısı** var ve ikisi AYNI güvende değildir:

| Yarı | Durum |
|---|---|
| "sonradan tekrar düzenleyebilme" | **ÖLÇÜLDÜ** (12. tur, gerçek fare/klavye — aşağıdaki kayıt) |
| "R2'de saklayıp" | **GERÇEK R2 HİÇ DENENMEDİ** — bu koşum da dâhil her şey MinIO'dur |

**Ölçülen düzenleme yolu (12. tur, GERÇEK girdi; ölçüm betiği `e2e/.artifacts/` altında
koşuldu ve repoya GİRMEDİ — bkz. §5.1).**
1,51 GiB'lık gerçek medyayı taşıyan proje (§0.1) açıldı; playhead cetvele tıklanarak tam
300,000000 sn'ye götürüldü, klip üstünde **sağ tık → "Playhead'de böl"** ile belge değiştirildi
(1 klip → 2 klip: `[0 … 300 sn] + [300 sn … 640 sn]`); autosave çipi **"Kaydedildi"** oldu;
üst çubuktan **"Çıkış"**a basıldı ve giriş formu döndü; **sayfa yenilendi, kullanıcı yine
DIŞARIDAYDI** (yani oturum gerçekten kapandı, sadece ekran değişmedi); adres çubuğu temizlenip
(`/`, derin bağlantı YOK) **gerçek klavyeyle** yeniden giriş yapıldı; **proje seçici** listesi
geldi ("PERF 1.5GB … Son değişiklik: 20.08.2026 21:02"); proje satırına **gerçek fareyle**
tıklandı. Sonuç:
- Belge **birebir** geri geldi: klip listesi `[[0, 300000000], [300000000, 340000000]]` —
  çıkıştan önceki hâlin aynısı.
- Kitaplık satırı geri geldi: `bigclip-1080p.mp4 10:40 · 1920×1080 · 1.51 GB Hazır`.
- **Medya gerçekten servis edildi:** klip gövdesinde filmstrip çizildi ve tuvalden okunan
  **3120 farklı renk** ölçüldü (düz dolgu değil, kaynağın kareleri); `GET /media-urls` **200**;
  presigned proxy GET'i `Range` ile **206** döndü (`bytes 0-0/123263560`).
- Tüm döngü (düzenle → kaydet → çıkış → yenile → yeniden giriş → seçici → proje → doğrulama)
  bu makinede **8,0 sn** sürdü. Bu bir performans vaadi değil, "yol tıkanmıyor" kanıtıdır.

**MinIO'nun S3 uyumluluğu NEYİ kanıtlar (bu turda ölçüldü).** 1,51 GiB'lık dosya
**24 eşit 64 MiB'lik parça + 1 artık parça** olarak tarayıcıdan imzalı PUT'larla yüklendi, her
parçanın `ETag`'i yanıt başlığından **okunabildi** (CORS `ExposeHeaders` çalışıyor), `complete`
25 parçayı sıralı kabul etti; **>256 MiB'lik export çıktısı** sunucu tarafı **multipart**
yolundan yüklendi (2,15 GiB); presigned **GET + `Range`** 206 döndürdü. Yani ürünün S3
sözleşmesini KULLANMA biçimi çalışıyor.

**Neyi kanıtlamaz (R2'ye özgü, hâlâ AÇIK).**
- R2'nin **eşit parça boyutu** kuralını ihlal durumunda verdiği hata biçimi — bizde parça
  boyutu sunucudan sabit geldiği için ihlal hiç DOĞMUYOR, yani kural test EDİLMİŞ değil.
- R2'nin multipart **`ETag` biçimi** (S3'ün `md5-of-md5s-N` sözleşmesiyle aynı olmayabilir);
  istemci onu yalnız geri yolladığı için bugün fark etmiyor, ama ETag'e bakan herhangi bir
  ara katman ayrışır.
- Gerçek bir R2 bucket'ında **CORS yapılandırması** (dev MinIO'su izin verici kurulur).
- **Presigned imza uyumu** (SigV4 ayrıntıları, host/path stili, süre sınırı davranışı).
- **`Range` destekli presigned GET**'in R2'deki davranışı (oynatıcı proxy'yi böyle çeker).
- Hesap düzeyi **hız sınırları / Class A-B operasyon maliyetleri**.
- **Lifecycle kuralları** — özellikle "yarım multipart 7 gün sonra abort" (`AssetReaperJob`
  DB tarafını buna GÖRE hizalıyor). Bu kural R2 panelinden kurulur; dev MinIO'sunda
  yapılandırılmadı, yani **hiçbir turda ölçülmedi**.
- Ve en önemlisi: **ağ**. §0.1'deki 321 MB/sn loopback sayısıdır; gerçek R2'de yükleme
  süresi kullanıcının internet hızıdır.

### 4.3 Versiyon (revision) temizleme işi YOK

Autosave her kaydetmede revision üretir; `SnapshotPolicy` bunların bir kısmını snapshot'lar
(20 revision'da bir VEYA 5 dakikada bir + değişiklik VEYA manuel checkpoint/restore öncesi).
**Eskiyenleri silen periyodik iş yoktur** — worker'da kayıtlı tek yinelenen iş
`asset-reaper`'dır (`Worker/Program.cs`, `AddOrUpdate<AssetReaperJob>` — 15 dakikada bir). Yani `ProjectRevisions`
tablosu **sınırsız büyür**. Plandaki kural ("son 50 auto + eskilerde inceltme") yazılmadı.
POC ölçeğinde sorun değil; aylarca kullanılan bir kurulumda disk ve sorgu maliyeti olur.

### 4.4 Kota kontrolü check-then-act (yarış mümkün)

`UploadQuota.Evaluate` init anında okur ve karar verir; DB kısıtı yoktur. Eşzamanlı iki init
kotayı **kıl payı** aşabilir (`Api/Assets/UploadQuota.Evaluate` — bilinçli MVP kabulü; kod
yorumu kesin çözümü "DB kısıtı değil periyodik mutabakat" olarak not eder).

**Varsayılan kotalar** (`Assets/QuotasOptions.cs`, `appsettings.json` "Quotas" ile ezilir):

| Ayar | Varsayılan | Anlamı |
|---|---|---|
| `MaxTotalBytesPerUser` | **20 GiB** | Kullanıcının silinmemiş tüm asset'lerinin toplamı |
| `MaxFileSizeBytes` | **4 GiB** | Tek dosya üst sınırı |
| `MaxConcurrentUploads` | **5** | Aynı anda "yükleniyor" durumundaki asset sayısı |

Ayrıca worker LRU cache tavanı 20 GiB (`ProcessingOptions.MaxCacheBytes`)
ve upload parça boyutu sabit 64 MiB'dir
(`Domain/Services/UploadRules.PartSizeBytes` — R2 son parça hariç tüm parçaların eşit
olmasını zorunlu kıldığı için istemci bu değeri asla kendi seçmez).

### 4.5 [DÜZELTİLDİ — 2026-08-21] Çıkış (logout) artık YALNIZ o cihazı düşürür

Eski davranış: `POST /api/auth/logout` kullanıcının **bütün** refresh token'larını iptal
ediyordu — telefonda çıkış masaüstünü de kapatıyordu. Kök neden rotaydı: refresh cookie
`Path=/api/auth/refresh` ile verilir, `/api/auth/logout` cookie'yi HİÇ göremediği için
"hangi cihaz çıkıyor" sorusunu yanıtlayamıyor ve tek çare "hepsini iptal" oluyordu.

Yeni davranış: çıkış ucu cookie path'inin ALTINA taşındı — `POST /api/auth/refresh/logout` —
ve yalnız istekle gelen cookie'nin token'ını iptal eder (`IRefreshTokenService.RevokeAsync`;
kimlik cookie'nin kendisidir, Authorization gerekmez — süresi geçmiş access token'la da çıkış
yapılır). Diğer cihazların oturumları AÇIK kalır ve rotasyona devam eder. "Tüm cihazlardan
çıkış" (`RevokeAllForUserAsync`) theft-detection yanıtı olarak ve ileride şifre değişimi için
duruyor. 14. tur triyajı (2026-08-21): theft cascade'i yalnız ROTASYONLA iptal edilmiş
(`ReplacedByTokenId` dolu — canlı bir halefi olan) token'ın replay'i tetikler; logout'la
iptal edilen token HALEFSİZDİR ve replay'i düz 401 alır (`RefreshFailure.Revoked`, cascade
yok). Böylece "tek cihazdan çıkış"ın içinde, logout'la yarışan benign bir refresh'in tüm
cihazları düşürdüğü gizli kapı kapandı; çalıntı kopya senaryosunda savunma DEĞİŞMEDİ (kurban
rotasyona devam ettiği sürece eski token'ın halefi vardır ve replay her şeyi düşürür).
Testler: `RefreshTokenServiceTests` + `LogoutEndpointTests`. Not: eski `/api/auth/logout`
rotası KALDIRILDI (istemci güncellendi; `docs/design/03` uç listesi de).

### 4.6 [KISMEN DÜZELTİLDİ — 2026-08-21] Konteynerler artık non-root; seccomp/CPU sınırı hâlâ yok

`VideoEdit.Api/Dockerfile` ve `VideoEdit.Worker/Dockerfile` artık `USER app` (UID 1654) ile
koşar; worker `/data`'yı USER'dan önce sahiplenir (yeni volume app sahipli doğar; root
döneminden kalan MEVCUT bir `worker_data` volume'u için bir kez
`docker compose run --user root worker chown -R app:app /data` gerekir). İki imaj da yerelde
build edilip konteyner içi `id` ile ölçüldü (`uid=1654(app)`; HEAD Dockerfile'ıyla build
edilen kontrol imajı `uid=0(root)` idi). **Kalan borç:** seccomp profili ve ffmpeg süreç
başına CPU/kaynak sınırı hâlâ tanımlı değildir; worker'da bellek limiti var (`compose.yml`:
6 GB), CPU limiti yok.

### 4.7 Sunucuda tam şema doğrulaması yok

`PUT /api/projects/{id}/timeline` **yüzeysel** doğrular (schemaVersion, projectId, track/klip
sayısı, gövde boyutu, sample rate — `TimelineRequestValidation.cs`). Tam invaryant kontrolü
istemcide (zod) ve export öncesi derleyicide koşar. Yani API'ye doğrudan istek atan bir
istemci, geçersiz bir doküman kaydedebilir — **kaydeder, ama export edemez** (derleyici
tipli hatayla reddeder).

**Nerede reddedildiği önemlidir.** Kurallar `ExportCompiler.Validate` içindedir ve export
isteğinde **422** ile döner; iş kuyruğa hiç girmez. Geçişli kliplerin yerleşim eşitliği de
buna dahildir — bu satır bir tur önce "`Compile` aşamasındadır, ön kapı göremez, böyle bir
doküman 202 alır" diyordu ve **ölçümle yanlışlandı**: kural `EnsureTransitionPlacement` ile
`Validate`'e alındı, `Compile`'daki dal aynı fabrika metodunu çağıran bir sigorta olarak
kaldı. Worker'da kalan tek kural sınıfı, **ancak indirilen dosya ölçülünce** karar
verilebilenlerdir (ffprobe'a bağlı olanlar) — orada da sessiz bozulma YOKTUR: iş açık
gerekçeyle düşer, yanlış video üretilmez. Hangi kuralın hangi kapıda olduğu §3'ün tablosunda
satır satır yazılıdır ve `ExportGateInventoryTests` o defteri **koşarak** doğrular.

**4. tur düzeltmesi (ÖLÇÜLEREK bulundu).** `Compile` aşamasında ikinci bir kural daha vardı ve
o kural **editörden ULAŞILABİLİYORDU**: geçişli bir kesimde ölçek kutusunun boyutları TEK ise
derleme reddediliyordu. 1920×1080'de yazılabilir üç ondalıklı ölçeklerin **%74'ü** (4257 değerin 3152'si),
1280×720'de **%48'i** en az bir TEK boyutlu kutu üretiyor — yani kapının kestiği küme buydu
(bu oran, §1.6b'deki **boyut sapması** oranıyla AYNI ŞEY DEĞİLDİR: o %98'dir); gizmo köşe sürüklemesi keyfi ondalık yazdığı için
kullanıcı bunu hiçbir uyarı görmeden kuruyordu → `PUT 200`, `POST /exports 202`, dakikalar sonra
kartta **"Başarısız"**. Üstelik hata mesajı **yanlış** gerekçeyi söylüyordu (dönme + çapa),
kullanıcıya arayüzde **olmayan** bir eylem öneriyordu ("çapayı merkeze alın") ve bu yolu koruduğu
sanılan e2e testi gizmoyu rastgele bir noktaya sürüklediği için deterministik olarak güvenli
kümeye düşüp **yalancı yeşil** kalıyordu. Kısıt kaldırıldı: kutuya normalize eden pad artık ham
kutuyu değil kutunun **çifte indirilmiş** halini hedefler (bkz. `rendering-semantics` §2.5), yani
tek kutu da geçişte render edilir ve geometri geçişten bağımsız kalır (aynı §'nin yeni normatif
invaryantı). O turda "geriye kalan tek `Compile` kapısı (dönme + merkez dışı çapa)" deniyordu;
**6. turda o da `Validate`'e alındı** (`EnsureTransitionPlacement`) — hâlâ editörden ulaşılamaz,
ama artık ham API'ye yazan bir istemci de 202 yerine 422 alır. §3 tablosunun ilgili satırına bakın.

*Bir yan etki, kayda geçsin:* o kapının fırlattığı istisna tipi değiştiği için worker'ın
`jobs.failure_reason` alanına yazdığı makine-okur kod da değişti —
`invalid-timeline` → `unsupported-feature:transition-rotated-anchor`
(`ExportJob.cs` istisnayı tipine göre ayırır). Bu kodu tüketen bir istemci yoktur (editör
kullanıcıya `error_message`'ı gösterir), yani etkisi sıfırdır; ama "davranış hiç değişmedi"
demek yanlış olurdu.

**4. turun İKİNCİ düzeltmesi: ölçek TABANI (dejenerelik).** Parite kısıtı kalkınca tek kutulu,
geçişsiz, bitişik klipler ilk kez `concat` + normalize pad yoluna girdi ve bu, ffmpeg'in
**alt-piksel** rejimini görünür kıldı: kaynağın oranı kutununkinden çok büyükse sığdırılan eksen
1 pikselin altına düşer, `scale` o ekseni `0` hesaplar ve `0`'ı *"girdi boyutunu koru"* diye
yorumlar. Ölçüm bu rejimin **eskiden de bozuk** olduğunu gösterdi ve iki dala ayırdı: bazı
belgeler `-22` ile ölüyordu, bazıları **hiç hata vermeden** katmanı 10–100 kat yanlış boyutta
çiziyordu (`200×10` kaynak: önizleme `20×1` çizerken export `18×10`). Yani "çalışan export'u
bozduk" çerçevesi **yanlıştı** — geri getirilecek doğru bir davranış yoktu. Kural artık bir
**kapıdır** (`degenerate-layer`): kaynak boyutu DB'den biliniyorsa **senkron 422**, worker'da
ffprobe boyutuyla tipli hata. Böylece hem bu turun açtığı vaka hem de **önceden de var olan
sessiz bozulma** tek kuralla kapandı — §3 tablosunun "Ölçek TABANI" satırına bakın.

**5. turun düzeltmesi: kapı DOĞRU YERDEYDİ ama YANLIŞ UCU ölçüyordu.** 4. turun kapısı ölçek
kutusunu klibin transform'undan kuruyordu; ölçek ANİMASYONLUysa o transform animasyonun
**en büyük** keyframe'inden geliyordu, yani kapı animasyonun tabanını hiç görmüyordu. Gerçek
fareyle ölçüldü: metin klibi + ölçek keyframe'i `0.010` → `POST /exports` **202** aldı ve iş
worker'da öldü. İkinci varyant daha kötüydü (kutu `0×0` → ffmpeg 99 kare yazdıktan SONRA
`Picture size 0x4 is invalid`, exit −12). Kapı ikiye ayrıldı: **tavan** en büyük ölçekten,
**taban** en küçük keyframe'den sorulur. Ayrıca ölçülerek bulunan ikinci bir kök neden: ölçek
animasyonlu yolda filtergraph'a **ham çarpım ifadesi** yazılıyor ve tamsayıya çeviren ffmpeg
oluyor — **yuvarlayarak değil, KIRPARAK**. Kapı iki yolda da yuvarlama varsayıyordu, bu yüzden
önerdiği "güvenli" ölçek bile ffmpeg'i öldürebiliyordu (ölçüldü: bbox `223×104`, statik eşik
`0.015` animasyonlu yolda ölüyor; doğru eşik `0.020`).

---

## 5. Neyin test edildiği — neyin edilmediği

Aşağıdaki sayıların tamamı **12. turda, bu doküman turunda, bizzat koşularak** alındı
(2026-08-20, `a1b3a73` + 10.–**12.** tur düzeltmeleri). **12. tur ürün kodunu
DEĞİŞTİRMEDİ** — yalnız ölçüm + doküman (§0.1 1,5 GiB uçtan uca, §4.2 sonradan tekrar
düzenleme, §5.1 elle koşulan ölçümler); dolayısıyla bu tablonun sayıları 11. turun
sayılarıyla **aynı çıkmalıydı ve aynı çıktı**. 11. tur: miks asılması + rejim testi + çıktı
saati bekçisi + üçüncü cümle sınıfı — §1.9, §4.1. Daha eski liste: 4.–8. tur — parite +
dejenerelik kapısı + ölçek tabanının animasyonlu yolu + kapı defteri +
overlay koordinatının tekliği + 503/422 ayrımı + raster sözleşmesinin senkron kapıya taşınması +
dönen katman/geçiş invaryantı + klip-varlık tür kapısı ve ses yolu (N1–N4) + doküman turu:

| Paket | Komut | Sonuç |
|---|---|---|
| Backend | `MINIO_AVAILABLE=1 dotnet test backend/VideoEdit.sln` | **1240 / 1240 geçti** (0 atlandı, 1 dk 3 sn) |
| Backend (MinIO env'siz) | `dotnet test backend/VideoEdit.sln` | 1223 geçti, **17 atlandı** (57 sn) — atlananlar: `ProcessAssetPipelineTests` 7, `MinioStorageSmokeTests` 2, `ExportJobPipelineTests` 8 |
| Derleme | `dotnet build backend/VideoEdit.sln` | **0 uyarı, 0 hata** |
| Editör | `pnpm --filter @videoedit/editor test` | **1198 / 1198 geçti** (72 dosya) |
| Şema paketi | `pnpm --filter @videoedit/timeline-schema test` | **191 / 191 geçti** (3 dosya) |
| Tip denetimi | `tsc -b` + `tsc -p e2e/tsconfig.json --noEmit` | **ikisi de temiz** (çıkış kodu 0) |
| E2E (gerçek fare) | `pnpm --filter @videoedit/editor test:e2e` | **143 / 143** (33 dosya, **7,6 dk** — 12. tur koşumu) — ama bu sayı iki parçadır: **136 GERÇEK geçiş** + **7 BEKLENEN başarısızlık** (`test.fail`, `a11y-smoke.spec.ts` modal odak sözleşmesi; ürün odak tuzağı/odak geri verme uygulamıyor). Playwright `test.fail`'i "passed" sayar. Koşumun iki ön koşulu da sağlandı: ikili yeniden yayımlandı ve tazeliği koşan sürecin YÜKLEDİĞİ modülün hash'i + UTF-16 dize taramasıyla doğrulandı; ortamın TEK sahibi bu koşumdu (rakip API/Worker/Playwright süreci yoktu). **O 7 `test.fail` artık `docs/backlog.md`'de AÇIK bir madde olarak kayıtlıdır** (11. tur, B6/1); daha önce hiçbir yerde yazılı değildi ve 143 sayısı modal odak eksiğini gizliyordu (review-gate kural 4). **GÜNCELLEME (2026-08-21): B6/1 KAPANDI** — modal odak yönetimi üç overlay'e eklendi (`src/lib/useModalFocus.ts`: açılışta odak içeri, Tab/Shift+Tab tuzağı, kapanışta tetikleyiciye dönüş, ExportDialog'a Escape) ve 7 `test.fail` SİLİNDİ. Kanıt (gerçek klavye): `a11y-smoke.spec.ts` **14/14**, negatif kontrol dahil (tuzak geçici bozuldu → 2 test kırmızı → geri alındı → yeşil). Soldaki 143 sayısı 12. tur koşumunun tarihsel kaydıdır; o koşumdan SONRA pakete başka ajanların spec'leri de eklendiği için güncel tam-paket sayısı bu satırda İDDİA EDİLMİYOR. |

> **E2E SAYISI ARTIK YAZIYOR — İKİ ÖN KOŞUL SAĞLANDIĞI İÇİN (ölçüm dersi).** Önceki tur bir "133 / 133"
> iddiası taşıyordu; o iddia **çürütüldü**. Kök neden testlerde değil ÖLÇÜM YÖNTEMİNDEYDİ:
> suite, o turun kod değişikliklerini taşımayan **bayat bir ikiliye** karşı koşmuştu. Bundan
> sonraki kural şudur ve bağlayıcıdır:
>
> 1. E2E ölçümünden ÖNCE API/Worker ikilisi **yeniden yayımlanır** ve tazeliği **doğrulanır**.
>    DLL'in md5 farkı tek başına tazelik kanıtı DEĞİLDİR (PDB yolu ve MVID her derlemede değişir);
>    doğrulama IL bölgesini karşılaştırmalı ya da beklenen sembolü/dizeyi taramalıdır.
> 2. Toplam suite sayısı ancak ortamın **TEK sahibi** varken anlamlıdır (rakip bir
>    Playwright/API/Worker süreci yokken); paylaşılan bir makinede alınan sayı ölçüm değil
>    gürültüdür.
>
> 7. turda kod tarafı ayrıca `e2e/fixtures/seed.ts`'i değiştirdi (seed artık GERÇEK bir asset
> satırı açıyor — yeni `asset-missing` kapısı yüzünden), yani "133" zaten o kod dilimine ait
> değildi. **GEÇME sayısı** yukarıdaki iki koşul sağlanana kadar yazılmadı; **10. turun nihai
> regresyonunda ikisi de sağlandı** (ikili yeniden yayımlandı, tazeliği koşan sürecin YÜKLEDİĞİ
> modülün md5'i + UTF-16 dize taramasıyla doğrulandı, ve o koşum sırasında makinede rakip bir
> API/Worker/Playwright süreci yoktu) — 10. turun sayısı **143 / 143 (7,9 dk)** idi. **12. turda
> aynı iki ön koşulla yeniden koşuldu** (ikili scratchpad'e publish edilip oradan başlatıldı,
> koşan sürecin YÜKLEDİĞİ modülün md5'i + İKİ hizalamalı UTF-16 dize taramasıyla doğrulandı,
> rakip API/Worker/Playwright süreci yoktu) ve **143 / 143 (7,6 dk)** verdi — tablodaki sayı
> budur. Sayının **136 gerçek geçiş + 7 `test.fail`** olarak okunması şarttır; 12. turda da
> `test.fail` işaretlerinin **tam 7** olduğu ayrıca sayıldı. *(Bu okuma şartı 12. tur ve
> öncesi koşum kayıtları İÇİNDİR: 2026-08-21'de modal odak yönetimi eklendi, 7 `test.fail`
> silindi — B6/1 kapandı; artık paketteki her test gerçek geçiş olmak zorundadır.)*
>
> **8. turda ne YAPILDI:** paket yalnız **listelendi** (`playwright test --list`) — hiçbir test
> çalışmadı, hiçbir servis başlatılmadı: **33 dosyada 143 test**. Listeleme paketin
> BÜYÜKLÜĞÜNÜ verir, sağlığını değil; buradaki değeri şudur: README'de duran "133 / 133"
> iddiası artık paketin büyüklüğünü bile doğru anlatmıyordu (aradaki fark 8. turda eklenen
> `audio-export.spec.ts` ve mevcut spec'lerin vaka değişiklikleridir — hangisinin ne kadar
> katkı yaptığı SAYILMADI, dolayısıyla iddia da edilmiyor).
>
> **Toplam sayı bir KALİTE ölçüsü değildir** ve tek bir nedene bağlanamaz: bir turda
> `degenerate-layer.spec.ts` ve `degenerate-animated-scale.spec.ts` eklendi, ama aynı turda
> mevcut spec'lerin vaka sayıları da değişti — dolayısıyla "artışın nedeni şu iki dosyadır"
> demek yanlış bir nedensellik kurar. Anlamlı olan **hangi davranışın** gerçek fare/klavyeyle
> koşulduğudur; onun listesi tablonun altındaki spec adlarındadır.

> **Negatif kontrol koşuldu (4. tur).** Dejenerelik kuralı (`LayerGeometry.IsDegenerate`) geçici
> olarak devre dışı bırakıldığında **31 test kırmızıya döndü** ve kalan 1019 test yeşil kaldı —
> yani kapı gerçekten yeni bir şey koruyor ve mevcut davranışı değiştirmiyor. Aynı bozuk ikili
> CANLI worker'a da yayımlandı: gerçek fareyle kurulan afiş belgesi `POST /exports` → **202** aldı
> (eski davranış) ve worker `scale=19:11` ile **hatasız** render etti — yani katmanı `18×100`
> çizip **hiçbir şey söylemedi**. Bozma geri alındı; ikili yeniden yayımlandı.

> **"Çalışan hiçbir vaka bozulmadı" iddiasının dayanağı SNAPSHOT DEĞİL, RENDER'dır.** Parite
> kısıtının kaldırılması yeni bir kod yolunu (tek kutulu bitişik kliplerin `concat` + normalize
> pad yolu) ilk kez ULAŞILABİLİR yaptı ve snapshot fixture'ları o yolu **hiç kapsamıyor** — yani
> "29 snapshot bayt bayt korundu" tek başına yetersiz bir kanıttır (doğrudur, ama başka bir şeyi
> kanıtlar: kapının filtergraph'ı değiştirmediğini). Yolun kendisini koruyan kanıt gerçek
> ffmpeg render'ıdır ve CI'da koşar:
>
> - `GoldenFrameTests.ContiguousLayerClips_ConcatIntoOneOverlay_WithoutMovingASinglePixel` —
>   AYNI klip iki yoldan render edilir (tek başına = pad'siz eski yol, run içinde = concat+pad
>   yeni yol) ve **aydınlanan piksellerin sınır kutusu BİREBİR eşit** olmalıdır; test hem ÇİFT
>   (`0.5`) hem **TEK** (`0.503`) kutuyla koşar — tek kutu tam da bu turda açılan vakadır.
> - `GoldenFrameTests.AddingATransition_DoesNotMoveTheLayerByASinglePixel` — geçiş ekli/eksiz
>   aynı geometri, **16 satır**: 4 kaynak aspect'i (16:9, 4:3, kare, 9:16) × 2 rejim, **artı 8
>   DÖNEN satır** (`rotationDeg` 30/90). Dönen yarı **bu turda eklendi**: öncesinde hiçbir satır
>   `rotationDeg` yazmıyordu, yani invaryantın o yarısı üç tur boyunca hiç koşmamıştı — ve
>   ayrışma tam oradaydı (bkz. `rendering-semantics.md` §5.2).
> - `GoldenFrameTests.DegenerateLayer_IsRejectedTyped_WhileTheScaleJustAboveItRendersCorrectly` —
>   kapının reddettiği belgenin bir ızgara adımı üstü GERÇEKTEN render edilir.
> - `ScaleOutput_MatchesRealFfmpeg` (20 çift) ve `ScaleBoxTruncated_MatchesRealFfmpeg` (7 çift) —
>   kapının dayandığı iki kutu aritmetiği CANLI ffmpeg'e karşı yeniden ölçülür.
> - `GoldenFrameTests.CompositingInRgb_IsWhatKeepsOddOverlayPositionsFromSnapping` — **bu turda
>   eklendi**: §6.3'ün "kompozisyon RGB'de yapılır" kuralının KONUM yarısı artık ölçümle
>   korunuyor (alt örneklemeli tuvalde overlay TEK konumu çifte indiriyor). `CompositeFormat`
>   sabiti boşaltılırsa test kırmızıya düşer.

**Atlanan testler** `MINIO_AVAILABLE=1` olmadan `Skip` olur — **toplam 17** (bu turda sayıldı):
`ProcessAssetPipelineTests` (7), `MinioStorageSmokeTests` (2), `ExportJobPipelineTests` (8 — LUT
piksel testi ve 8. turda eklenen GERÇEK ses/çıkartma uçtan uca testleri dâhil). CI'da MinIO
konteyneri ayağa kalktığı için hepsi **gerçekten** koşar. *(Önceki sürümde bu satırın toplamı
13 yazıyordu ve alt kırılımıyla tutmuyordu; sayı yeniden ölçüldü.)*

> **E2E SEED'İNİN PLACEHOLDER VARLIĞI: BİLİNÇLİ KAPSAM KARARI (yazıya geçiyor).**
> `e2e/fixtures/seed.ts` gerçek bir asset SATIRI açar ama **bayt yüklemez** — satır
> `Uploading` durumunda kalır, ffprobe alanları null'dır. Sonucu şudur: **seed belgeleri
> "derlenir ama asla render edilemez"** — POST `/exports` **202** döner (durum GEÇİCİ olduğu
> için senkron kapı bilerek susar, bkz. §3 "İşlenmesi KALICI olarak başarısız dosya"), iş ise
> worker'da `asset-not-ready` ile düşer. Bu bir kusur değil, seed'in **iddiasının sınırıdır**:
> "belge kullanıcının kütüphanesindeki bir varlığı gösteriyor" der, "bu belge render edilir"
> DEMEZ. Gerçekten render edilen e2e senaryoları kendi medyasını yükler
> (`e2e/support/media.ts` + `LibraryPanelHarness`) — `guard-paths.spec.ts` gibi "iş kuyrukta
> ölmüyor" iddiası taşıyan testler o yolu kullanır. 8. turun N2 düzeltmesi bu dengeyi
> DEĞİŞTİRMEZ: senkron ret yalnız TERMİNAL `Failed` satırlarda doğar, `Uploading` satırda
> doğmaz — fixture'ların 202 alması korunmuştur (ölçüldü:
> `ExportGateInventoryTests.EveryAssetStatusBehavesAsItsRowClaims` her durumu ayrı ayrı
> uç noktaya gönderir).

> **Backend sayısı neden sabit değil.** `FrameGridCrossBoundaryTests` bir `[Theory]`'dir ve
> vakalarını paylaşılan `packages/timeline-schema/test-vectors/frame-grid-corpus.json`
> dosyasından okur — korpus büyüdükçe backend test sayısı da büyür (aynı fixture'ın hem
> TypeScript hem C# tarafından koşulması, iki dilin ayrışmasını yakalayan tek mekanizmadır).
> Farklı bir sayı görürseniz sebebi büyük ihtimalle budur, kaybolan bir test değil.

> **Yeşil test ≠ çalışan ürün — bu dokümanın kendi kanıtı.** §1.1'deki kusur (görsel klipler
> önizlemede hiç çizilmiyor) bir önceki turun **tüm** birim ve e2e testleri yeşilken vardı:
> hiçbir test görsel klibin oynatıcı tuvaline çizildiğini kontrol etmiyordu. §1.2'deki frame
> ızgarası çelişkisi de öyle. Bu tablodaki sayıları mutlak bir güvence olarak değil, "hangi
> sınıf hata yakalanır" bilgisi olarak okuyun.

**Oynatıcı tuvalinin piksel doğrulaması artık VAR** (§1.1'in düzeltmesiyle birlikte geldi):
dört e2e paketi motorun kendi `probePixel` köprüsünden (`engineV1.probePixel`, çizimle aynı
karede `gl.readPixels`) gerçek piksel okur — `image-preview.spec.ts` (fotoğraf/çıkartma),
`transitions.spec.ts` (iki kaynağın karışması), `speed-color.spec.ts`, `keyframes.spec.ts`.
Bu, kapsamlı bir görsel regresyon paketi **değildir**: nokta örneklemesidir, tam kare
karşılaştırması (golden frame) hâlâ yalnız export tarafındadır —
`backend/tests/GoldenFrames/` (11 PNG, export karesi) ve `backend/tests/RasterGoldens/`
(4 PNG, yalnız şekil rasteri; **metin golden'ı yok**, bkz. `docs/backlog.md` font bölümü).

### 5.1 Test PAKETİ olmayan, elle koşulan ölçümler (12. tur)

Aşağıdakiler otomatik pakete girmez — CI'da koşmazlar, bir kişinin bir kez koştuğu
ölçümlerdir. Bu yüzden ayrı listeleniyorlar: bir sonraki turda **kendiliğinden
yanlışlanmazlar**, yani "hâlâ doğru mu" sorusu elle sorulmalıdır.

| Ölçüm | Nasıl koşuldu | Sonuç |
|---|---|---|
| **1,51 GiB / 10:40 kaynak, uçtan uca** (yükleme → işleme → timeline → kesme → export) | Playwright, GERÇEK fare + tarayıcının kendi dosya seçicisi; ölçüm betiği `e2e/.artifacts/` altında koştu ve repoya **girmedi** | **geçti** — sayılar §0.1'de |
| **Sonradan tekrar düzenleme** (böl → "Kaydedildi" → Çıkış → yenile → temiz adresten yeniden giriş → proje seçici → aynı proje) | Playwright, GERÇEK fare + GERÇEK klavye; aynı ölçüm paketi | **geçti** — belge birebir geri geldi, filmstrip tuvalinde 3120 farklı renk, `media-urls` 200 (§4.2) |

> **Bu iki ölçüm neden pakette DEĞİL (bilinçli).** Birincisi 1,5 GiB'lık bir dosya üretmeyi
> (156 sn) ve ~1,7 dakikalık bir koşumu gerektiriyor — tam 10:40'lık export'un ölçümüyle
> birlikte 5+ dakika; her CI turunda bunu koşmak paketin maliyetini anlamsız büyütürdü.
> İkincisi paketin `auth.spec.ts`'iyle **kısmen** çakışıyor (çıkış/yeniden
> giriş orada gerçek girdiyle zaten var), ama "gerçek medyalı proje geri geliyor mu" yarısı
> hiçbir pakette yok. Yani ikisi de **koşulmuş ama korunmuyor**: bir regresyon bunları sessizce
> kırabilir. Borç `docs/backlog.md` 12. turda açık duruyor.

**Test edilmeyen yüzeyler:** önizlemenin tam-kare golden karşılaştırması, preview↔export ses
RMS parity'si (§2.6), yük/eşzamanlılık testi, güvenlik penetrasyon testi, tarayıcı matrisi
(yalnız Chromium), mobil, **gerçek R2** (§4.2), çoklu worker, uzun süreli (haftalarca ayakta)
çalışma, gerçek telefon/pis-dosya korpusu (§3.2), **LRU cache süpürmesi ve 2 GB üstü kaynak**
(§0.1).

---

## 6. Bu POC ne İÇİN uygun, ne için değil

**Uygun:** akış doğrulama, iç demo, tasarım/UX geri bildirimi, "bu mimari çalışıyor mu"
sorusuna cevap, tek kullanıcılı gerçek düzenleme işi, **fotoğraf/slayt gösterisi**
(önizleme + geçişler + export uçtan uca çalışıyor — §1.1), **müzik/ses eklenmiş kurgu**
(yükleme → ses track'i → dışa aktarılan dosyada gerçekten duyulan ses — §1.8; parity
ölçülmedi, §2.6), **1-2 GB'lık tek kaynak dosyayla çalışma** (bir kez uçtan uca ölçüldü —
§0.1; nesne deposu LOKAL, gerçek R2 değil), **projeyi kapatıp sonradan geri dönme**
(çıkış → yeniden giriş → aynı belge + aynı medya — §4.2).

**Uygun değil:** halka açık çok kullanıcılı servis (§4.4, §4.5, §4.6), SLA'lı export
(§4.1), mobil kullanıcılar (§1.5), kare-kesin scrubbing gerektiren iş (§1.6, §2.1), gerçek dünya
telefon/pis-dosya korpusuyla üretim kullanımı (§3.2).

> **Bu listeden iki madde ÇIKTI.** Frame ızgarası sorunu (§1.2) ve fotoğraf/slayt gösterisi
> iş akışı (§1.1) buradaydı; ikisi de düzeltildi. Kaydın tamamı ilgili başlıklarda.

---

### İlgili dokümanlar

- [`docs/backlog.md`](backlog.md) — kapsam tablosu + milestone'a eşlenmiş borçlar
- [`docs/rendering-semantics.md`](rendering-semantics.md) — normatif render semantiği (§1.7 tolerans, §5.3 geçiş tablosu, §7 font sözleşmesi)
- [`fonts/README.md`](../fonts/README.md) — üç modlu font politikası ve belirlenimcilik
- [`deploy/README.md`](../deploy/README.md) — VPS + R2 çıkış adımları
