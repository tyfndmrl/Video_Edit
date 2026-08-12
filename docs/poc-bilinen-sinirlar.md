# POC — Bilinen Sınırlar

**Bu doküman ürünü SATMAK için değil, DÜRÜST tanıtmak için yazıldı.** VideoEdit bir POC'tur:
uçtan uca çalışan, testli, ama üretim yükü altında denenmemiş bir sistem. Aşağıdaki maddelerin
her biri **kodda doğrulandı** — iddia edilen her sınırın yanında dosya/satır ya da ölçüm var.

Okuma sırası: önce **§1 kullanıcıyı ilk gün ısırabilecekler**, sonra §2–§6.

- Doğrulama tarihi: **2026-08-12**, commit `f39e0b4`
- Ölçüm makinesi: Intel Core i9-10850K (10 çekirdek / 20 iş parçacığı), 32 GB RAM, Windows 11
- Yığın: .NET 10.0.302, Node v22.14.0, ffmpeg 8.0, PostgreSQL 17, Redis 7, MinIO (R2 yerine)

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

Depoda birikmiş **47 başarılı export işi** var (yukarıdaki iki ölçüm + e2e koşumlarının kısa
fixture'ları): ortalama 2.58 sn, en kısa 0.75 sn, en uzun 28.85 sn.

---

## 1. Kullanıcıyı ilk gün ısırabilecek sınırlar

### 1.1 [YÜKSEK] Fotoğraf ve sticker klipleri ÖNİZLEMEDE görünmüyor (export'ta görünüyor)

**Ne çalışmıyor.** Timeline'a bir görsel (PNG/JPG/WebP) klibi ya da sticker koyduğunuzda
oynatıcı tuvali o klip boyunca **siyah** kalır. Klip timeline'da vardır, seçilebilir,
gizmo ile taşınabilir, **export'a doğru şekilde girer** — ama önizlemede çizilmez.

**Kanıt (gerçek tarayıcı + gerçek dosya, 2026-08-12).** 1920×1080 macenta PNG yüklendi,
API üzerinden `ready` oldu, 5 sn'lik bir image klibi olarak `t=0`'a kondu; Chromium'da giriş
yapılıp proje açıldı.

```
uygulama store'u (window.__videoeditTest):
  session=ready  projectId=019ff375-…  tracks=1  clips=[1]
  clip={kind:"image", start:0, dur:5_000_000}   playheadUs=0
  asset={kind:"image", status:"ready", proxyUrl:NULL, posterUrl:VAR}

oynatıcı canvas'ı (1920x1080) ekran görüntüsü:  TAMAMEN SİYAH
aynı projenin EXPORT'u (2. saniyedeki kare):    YAVG=104 UAVG=210 VAVG=234  → MACENTA ✅
```

**Neden.** Zincir üç yerde birden tutarsız:

1. Worker görsel asset için **proxy ÜRETMEZ** — yalnız poster üretir
   (`backend/src/VideoEdit.Worker/Jobs/ProcessAssetJob.cs:392`, yorum: "Image için proxy
   ÜRETİLMEZ"; `ThumbnailKey` set edilir, `ProxyKey` edilmez).
2. `GET /api/projects/{id}/media-urls` bu yüzden görsel için `proxy: null` döner
   (`AssetMediaUrlBuilder.cs:37` — canlı doğrulandı).
3. Oynatıcının asset çözücüsü **yalnız `proxyUrl`'e bakar**:
   `url: asset.status === 'ready' ? (asset.proxyUrl ?? null) : null`
   (`apps/editor/src/features/player/PlayerPanel.tsx:44`). `url` null olunca
   `imageDrawItem` çizmeden döner (`engine-video/engineV1.ts:1095`).

**Pratik etkisi.** Slayt gösterisi / logo bindirme / sticker gibi görsel odaklı akışlarda
kullanıcı **kör çalışır**: konumu ve zamanlamayı ancak export'tan sonra görür. Veri kaybı
yok, export doğru — ama POC'un en görünür kusuru budur.

**Ne zaman.** Küçük bir düzeltme: çözücü `kind === 'image'` için `posterUrl`'e (gerekirse
`original`'a) düşmeli — poster zaten en fazla 1280 px genişlikte JPEG olarak üretiliyor
(`PosterRecipe.MaxWidth = 1280`), yani proxy'nin görsel karşılığıdır. **Sonraki dilimin ilk
maddesi olmalı.** Bu bulgu POC dokümantasyon turunda çıktı; hiçbir e2e testi görsel klibin
tuvale çizildiğini doğrulamıyordu (`transitions-image.spec.ts` yalnız doküman durumuna bakar).

### 1.2 [DÜZELTİLDİ — teslim düzeltme turu, 2026-08-12] Frame ızgarası çelişkisi: bazı klipler export'ta 422 alıyordu

> Bu madde **kapandı**; kayıtta kalmasının nedeni, doğrulama tarihinden (`f39e0b4`) önce
> ürünü denemiş olanların gördüğü davranışı ve düzeltmenin ne olduğunu açıklamaktır.

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

**Düzeltme (bu teslim turu).**

1. **Derleyici kapısı kenarlara alındı** — `backend/src/VideoEdit.Media/Export/ExportCompiler.cs`:
   artık `timelineStartUs` VE `timelineStartUs + timelineDurationUs` ızgarada mı diye
   bakılır (hata metni de değişti: *"clip … edges are not on the project frame grid"*).
   Süre, tanımı gereği bir ızgara büyüklüğü değildir.
2. **Editör süreyi "kendi başlangıcına göre TAM KARE" seçiyor** — şema paketine `frameSpanUs`,
   `frameSpanCount`, `snapDurationToFrameSpan`, `floorDurationToFrameSpan`, `isClipOnFrameGrid`
   eklendi (`packages/timeline-schema/src/time.ts`) ve `timelineOps` bunları kullanıyor.
   Asset ekleme **kuyruktan kısaltır** (`floorDurationToFrameSpan`): klip kaynağın bitişinden
   ÖNCEKİ kare sınırında biter — böylece hem iki kenar ızgarada olur, hem süre formülü
   (`sourceOut - sourceIn == süre`), hem de kaynak sınırı (`sourceOut ≤ asset süresi`) aynı
   anda sağlanır.
3. **Dev modunda kapı editöre de kondu** — `assertDocValidDev` artık her işlemden sonra
   `exportFrameGridIssues` çalıştırır: editörün kabul edip worker'ın 422 ile reddettiği bir
   doküman geliştirme sırasında ANINDA patlar. (Bu kural şema paketinde vardı, uygulamada
   **tek bir çağıranı bile yoktu** — sorunun teslime kadar hayatta kalma nedeni budur.)

**Doğrulama (bu doküman turunda bizzat koşuldu).**
`dotnet test backend/tests/VideoEdit.UnitTests --filter ExportCompilerSnapshotTests` →
**130/130 geçti**; `pnpm --filter @videoedit/timeline-schema test` → **170/170 geçti**.

### 1.3 [YÜKSEK] LUT (.cube): dört bacaklı sözleşmenin İKİ bacağı yok (editör UI + önizleme)

Bu projede bir özellik ancak **dört bacağın dördü** de varsa "var" sayılır: **şema**,
**editör UI'ı**, **önizleme (WebGL2)** ve **dışa aktarma (ffmpeg)**. LUT'ta ikisi var,
ikisi yok — ve eksik olanlar kullanıcının dokunduğu iki bacak.

| Bacak | Durum | Kanıt |
|---|---|---|
| Şema | **VAR** | `packages/timeline-schema/src/schema.ts:123` — `EffectTypeSchema = z.enum(['colorAdjust','lut'])` |
| Dışa aktarma (ffmpeg) | **VAR** | `ClipEffects.cs:238` `lut3d=file=…:interp=trilinear`; worker `.cube`'u ayrı varlık defterinden indirir (`ExportPlan.LutAssetIds`); intensity < 1 için split/blend zinciri; **pikselin gerçekten değiştiğini doğrulayan test**: `ExportJobPipelineTests.Export_WithLutEffect_DownloadsTheCubeFile_AndActuallyChangesPixels` |
| Editör UI'ı | **YOK** | Yükleme whitelist'i `.mp4 .mov .webm .mp3 .m4a .wav .png .jpg .jpeg .webp` ile sınırlı (`apps/editor/src/features/library/fileTypes.ts`) → `.cube` **yüklenemez**; efekt UI'ı yalnız `colorAdjust` sunar (`apps/editor/src/features/inspector/clipInspectorModel.ts:423`) → efekt **seçilemez** |
| Önizleme (WebGL2) | **YOK** | `docs/rendering-semantics.md` §4.2 önizleme shader'ını NORMATİF olarak tarif eder (`uLut3D`, `uLutScale = (N-1)/N`, `uLutOffset = 1/(2N)`) — bu üç uniform'un tamamı `apps/` ve `packages/` altında **0 kez** geçer; `player/compositor/shaders.ts` içinde `sampler3D` ya da 3D doku yükleme kodu yoktur. Önizleme çözücüsü `lut` efektini **bilerek atlar** — `player/core/resolve.ts:391` `colorAdjustOf` yalnız `colorAdjust` tipini okur; testi: `core/resolve.test.ts:403` *"ignores lut/disabled"* |

**Pratik etkisi.** Bu, "UI'ı yok ama motoru hazır" değildir: LUT dokümana elle
yazılsa (ör. API'ye doğrudan istek) bile **önizlemede hiçbir etkisi görünmez**, yalnız
export'ta uygulanır. Yani renk işi yapan bir kullanıcı için LUT **kör** bir özelliktir.

**Neden.** M5'te renk düzeltme uçtan uca kapatıldı, LUT'un editör yüzeyi M6'ya yazıldı;
M6 sonra versiyon geçmişi + kota/silme UX'ine daraltıldı ve LUT **teslim edilmedi**.
Panel metnindeki "LUT efekti → M6" ifadesi bu yüzden bayattı; düzeltildi
(`inspector/ClipPropertiesPanel.tsx`, "Kapsam" bölümü artık "MVP kapsamı dışında" der).

**Ne zaman.** Sonraki dilim ve **iki** iş kalemi: (1) `.cube` yükleme yolu (yeni asset
türü + whitelist + worker tarafında doğrulama) ve efekt UI'ı; (2) önizleme shader'ında
3D doku örneklemesi (`sampler3D` + tetrahedral/trilineer interpolasyon, ffmpeg
`lut3d=interp=trilinear` ile parite). İkincisi yapılmadan özellik "var" sayılamaz.

### 1.4 [ORTA] Yarım kalan yükleme, tarayıcı kapanınca devam ETMEZ

**Ne çalışıyor.** Aynı sekmede duraklat/devam et, parça bazlı yeniden deneme, iptal
(`upload/uploadEngine.ts`). Yarım kalan oturumlar IndexedDB'ye yazılıyor ve kitaplıkta
"Yarım kalan yükleme" rozetiyle listeleniyor; oradan **silinebilir**.

**Ne çalışmıyor.** Tarayıcı kapanıp açıldıktan sonra kaldığı yerden **devam ettirme**.
Dosya İÇERİĞİ IndexedDB'ye kopyalanmıyor (1–2 GB) ve File System Access API tutamacı
saklanmıyor — dolayısıyla dosya yeniden seçilmeden sürdürülemez
(`apps/editor/src/features/library/upload/uploadSessions.ts:2`). Sunucu tarafı hazır:
`GET /api/assets/{id}/upload/status` R2/MinIO'daki gerçek `ListParts` durumunu döner.

**Kullanıcı ne görür.** Bunu **açıkça söyleyen** bir uyarı (`LibraryPanel.tsx:599`):
"Tarayıcı yeniden açıldıktan sonra devam ettirme ileri bir milestone'da gelecek; yarım kalan
yüklemeler sunucuda 7 gün saklanır."

**Ne zaman.** Sonraki dilim: FileSystemFileHandle akışı + ilk 1 MiB parmak iziyle
"dosya değişti mi" tespiti.

### 1.5 [ORTA] Mobil / tablet desteklenmiyor

**Ne çalışmıyor.** Uygulama tek bir sabit masaüstü ızgarasına kurulu:
`grid-cols-[280px_minmax(0,1fr)_320px] grid-rows-[auto_minmax(0,1fr)_280px]`
(`apps/editor/src/app/App.tsx:48`). Duyarlı kesme noktası, dokunma hedefi büyütmesi,
dokunmatik jest yolu **yok**; timeline etkileşimleri pointer capture + fare tekerleği üzerine
kurulu. Playwright paketi de tek bir masaüstü viewport'unda koşar.

**Neden.** Bilinçli kapsam kararı — POC masaüstü tarayıcı hedefli.

**Ne zaman.** Yol haritasında değil; mobil ayrı bir tasarım dilimi gerektirir.

### 1.6 [ORTA] Önizleme ile export arasında ±1 kare sapma olabilir

**Ne çalışmıyor.** Önizleme 540p proxy'den, proxy kendi kaynak-CFR ızgarasında oynar; UI ise
proje fps ızgarasındadır. Playhead bir proje karesine oturduğunda ekranda **en yakın proxy
karesi** gösterilir → export çıktısına göre en fazla **±1 proje karesi** görsel sapma
(`docs/rendering-semantics.md` §1.7; uygulama:
`apps/editor/src/features/player/engine-video/engineV1.ts:1215`).

**Neden.** Bilinçli ürün kararı — kare-kesin önizleme WebCodecs gerektirir (§2.1).
Zaman/pozisyon matematiğinde tolerans YOKTUR; tolerans yalnız "hangi kaynak karesi ekranda"
sorusuna aittir. Golden-frame testleri bu toleransla yazılmıştır.

### 1.7 [DÜŞÜK] Track yeniden sıralama ve yeniden adlandırma yok

`timelineOps` yalnız `addTrack` ve `deleteTrack` sunar; bayraklar (sessiz/gizli/kilitli)
değiştirilebilir ama **track'lerin sırası** ve **adı** değiştirilemez
(`apps/editor/src/state/timelineOps.ts:492`, `:541`; sağ tık menüsü
`features/timeline/contextMenu.ts:262`). Klipler katmanlar arasında taşınabildiği için bu bir
engel değil, bir **rahatsızlık**tır: istenen katman sırası ancak track'leri doğru sırada
ekleyerek kurulabilir.

---

## 2. Motor / önizleme sınırları

### 2.1 WebCodecs (v2) oynatıcı motoru YOK

`apps/editor/src/features/player/` altında tek motor var: `engine-video/engineV1.ts` —
gizli `<video>` havuzu tabanlı. `engine.ts:10` v2 WebCodecs motorundan **plan olarak**
söz eder, kod yoktur (`VideoDecoder` deposunda hiç geçmez). Sonucu: kare-kesin scrubbing
yerine ±1 kare toleransı (§1.6) ve aynı anda **en fazla 4 video** (`POOL_SIZE = 4`,
`player/core/scheduler.ts:26`).

### 2.2 Kalabalık kompozisyonda katman düşebilir — ve geçiş bunu ikiye katlar

Havuz 4 elemanlıdır; daha fazla eşzamanlı video klibi olan bir kompozisyonda önizleme
bazılarını **atlar**. Geçiş penceresi açıkken A ve B birlikte `priority 0` olur, yani
havuzun ikisini birden yer → geçiş boyunca bir katman/ses DAHA düşebilir.

Sessiz değil: oynatıcıda `previewShortfallNote` rozeti bunu bildirir
(`player/PlayerPanel.tsx:256`). **Export etkilenmez** — ffmpeg tüm katmanları çizer.

### 2.3 `dissolve` ve `fadeToBlack` önizlemede ffmpeg ile piksel-eşit DEĞİL

Önizleme dissolve'da kendi hash gürültüsünü, fadeToBlack'te düz lineer rampayı kullanır;
ffmpeg'in PRNG'si ve `smoothstep` yumuşatması farklıdır
(`docs/rendering-semantics.md` §5.3 tablosu; shader
`player/compositor/shaders.ts:195`). Gözle fark edilmez ama **piksel-eşit değildir** →
bu iki tip için preview↔export golden karşılaştırması yazılamıyor. Diğer dört geçiş
(`crossfade`, `wipeLeft`, `wipeRight`, `slideUp`) matematiksel olarak aynıdır.

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
(`inspector/ClipPropertiesPanel.tsx:946`, `data-testid="clip-text-raster-note"`).

### 2.6 Ses parity'si (preview ↔ export RMS) ÖLÇÜLMEDİ

Kazanç zinciri birim testlerle pinlendi (geçişte toplam kazanç her an 1), ama
OfflineAudioContext tabanlı sayısal RMS karşılaştırması yazılmadı. Yani "önizlemedeki ses
export'takiyle aynı" iddiası **test edilmiş değil, tasarımla gerekçelendirilmiş**tir.

---

## 3. Şema / export motoru sınırları (tipli hata verir, sessiz bozulma yok)

Ortak nokta: hiçbiri **sessizce yanlış çıktı vermez**. İlk yedi satır export isteğinde
**açık gerekçeli 422** üretir (iş kuyruğa bile girmez); son üçü ayrı kapılardır — doküman
tavanları kaydetmede **400**, kaynak süresi tavanı işlemede `too-long`, profil ise
basitçe tek seçenektir.

| Sınır | Ne olur | Kanıt |
|---|---|---|
| **Hız rampası yok** | Bir klip = tek sabit oran (0.1×–10×). Klip içinde hızlanma/yavaşlama kurulamaz. | `schema.ts:195` `speed: z.object({ rate: … })` tek skaler |
| **Efekt parametresi keyframe'i yok** (`fx.*`) | colorAdjust/LUT değerleri animasyonlanamaz. Keyframe kanalları yalnız `x, y, scale, rotationDeg, opacity, volume`. | `schema.ts:109` `KeyframeTracksSchema` STRICT |
| **Geçişli kesimde keyframe yasak** | Geçiş penceresine giren klipte animasyon varsa 422. | `ExportCompiler.cs:1498` `transition-keyframes` |
| **Ölçek animasyonu + dönme birlikte yasak** | ffmpeg `rotate` çıkış tuvalini bir kez kurar, büyüyen girişi sessizce KIRPARDI — sessiz kırpma yerine tipli hata. | `ExportCompiler.cs:1831` `scale-keyframes-with-rotation` |
| **Ses klibinde görsel keyframe / renk efekti yasak** | Ses görüntü üretmez; sessizce yok saymak "animasyonum çalışmıyor" bug'ı olurdu. | `ExportCompiler.cs:1675`, `:1682` |
| **Keyframe örnek bütçesi 60 000** | Easing'li animasyon KARE KARE örneklenir; çok uzun animasyon 422. | `ClipAnimation.cs:83` `MaxSamples = 60_000` |
| **Katman boyutu tavanı 8192 px** | Aşırı ölçek (ve dönmenin açtığı ara tuval) reddedilir. | `LayerGeometry.cs:81` `MaxLayerDimension = 8192` |
| **Tek export profili: 1080p** | 720p/4K/dikey ön ayarı yok; libx264 CRF18 `veryfast` + AAC 192k sabit. | `ExportProfiles.cs` |
| **Doküman tavanları** | En fazla 50 track, 2000 klip, ~2 MB timeline gövdesi. | `TimelineRequestValidation.cs:20-23` |
| **Kaynak süresi tavanı 4 saat** | Aşan medya probe SONRASI, transcode ÖNCESİ `too-long` ile düşer. | `ProcessingOptions.cs:14` |

### 3.1 Emoji font seti YOK

Küratörlü set 4 aile × 4 stil = 16 TTF (Roboto, Open Sans, Noto Sans, Noto Serif) — **emoji
fontu içermez**. Emoji içeren metin `.notdef` kutusu ("tofu") olarak çizilir. Sessiz kalmaz:
raster sonucu `HasMissingGlyphs = true` döner ve worker etkilenen klipleri **loglar**
(`Text/SkiaGlyphMeasurer.cs:96`, `Worker/Jobs/ExportJob.cs:300`) — ama iş DÜŞMEZ, kullanıcı
tofu'lu bir video alır. Çözüm ayrı bir `fontId` (ör. Noto Color Emoji) + glif düzeyinde
fallback zinciri gerektirir.

### 3.2 Pis-dosya korpusu test edilmedi

iPhone HLG/HDR, VFR (OBS kayıtları), döndürme metadata'lı dikey MOV, WhatsApp re-encode gibi
gerçek dünya dosyaları için **uçtan uca korpus testi yok**. Motorda karşılıkları var (HDR→SDR
zinciri, VFR→CFR sabitleme, autorotate) ve birim/snapshot testleri var
(`ExportSnapshots/hdr-source.txt`, `ntsc-fps.txt`, `MediaProbeParserTests`), ama gerçek
telefon dosyalarıyla doğrulanmadı. **POC'ta beklenmedik kaynak dosyalarla sorun yaşayabilirsiniz.**

---

## 4. İşletim / dayanıklılık sınırları

### 4.1 Tek worker, tek eşzamanlı export

`AddHangfireServer` iki kuyruk kurar (`Worker/Program.cs:104-124`):

- `transcode` kuyruğu: `WorkerCount = 2`
- `export` kuyruğu: **`WorkerCount = 1`** — ffmpeg render'ı zaten tüm çekirdekleri kullanır

Yatay ölçekleme (birden çok worker konteyneri) **denenmedi**. Kullanıcı başına eşzamanlı
export tavanı da vardır (aşımda 429, `ExportEndpoints.cs`). Pratikte: iki kullanıcı aynı anda
export başlatırsa **sıraya girerler**.

### 4.2 Gerçek Cloudflare R2 hiç denenmedi

Tüm geliştirme ve test **lokal MinIO** ile yapıldı (`appsettings.Development.json` →
`ServiceUrl: http://localhost:9000`; CI'da da MinIO konteyneri). S3 API uyumlu olduğu için
kod yolu aynıdır, ama şunlar **doğrulanmamıştır**: gerçek R2 CORS davranışı, presigned URL
imza uyumu, çok parçalı `ETag` biçimi, hesap düzeyi hız sınırları, lifecycle kuralları.
`deploy/README.md` §4 gerekli adımları tarif eder — **ilk gerçek dağıtımda buraya vakit ayırın.**

### 4.3 Versiyon (revision) temizleme işi YOK

Autosave her kaydetmede revision üretir; `SnapshotPolicy` bunların bir kısmını snapshot'lar
(20 revision'da bir VEYA 5 dakikada bir + değişiklik VEYA manuel checkpoint/restore öncesi).
**Eskiyenleri silen periyodik iş yoktur** — worker'da kayıtlı tek yinelenen iş
`asset-reaper`'dır (`Worker/Program.cs:155`, 15 dakikada bir). Yani `ProjectRevisions`
tablosu **sınırsız büyür**. Plandaki kural ("son 50 auto + eskilerde inceltme") yazılmadı.
POC ölçeğinde sorun değil; aylarca kullanılan bir kurulumda disk ve sorgu maliyeti olur.

### 4.4 Kota kontrolü check-then-act (yarış mümkün)

`UploadQuota.Evaluate` init anında okur ve karar verir; DB kısıtı yoktur. Eşzamanlı iki init
kotayı **kıl payı** aşabilir (`Assets/UploadQuota.cs:16` — bilinçli MVP kabulü).

**Varsayılan kotalar** (`Assets/QuotasOptions.cs`, `appsettings.json` "Quotas" ile ezilir):

| Ayar | Varsayılan | Anlamı |
|---|---|---|
| `MaxTotalBytesPerUser` | **20 GiB** | Kullanıcının silinmemiş tüm asset'lerinin toplamı |
| `MaxFileSizeBytes` | **4 GiB** | Tek dosya üst sınırı |
| `MaxConcurrentUploads` | **5** | Aynı anda "yükleniyor" durumundaki asset sayısı |

Ayrıca worker LRU cache tavanı 20 GiB (`ProcessingOptions.MaxCacheBytes`) ve upload parça
boyutu sabit 64 MiB'dir.

### 4.5 Çıkış (logout) TÜM cihazları düşürür

`POST /api/auth/logout` kullanıcının **bütün** refresh token'larını iptal eder
(`AuthEndpoints.cs:169` `RevokeAllForUserAsync`). Cihaz bazlı oturum yönetimi yok: telefonda
çıkış yapmak masaüstündeki oturumu da kapatır.

### 4.6 Konteynerler root olarak koşuyor

`VideoEdit.Api/Dockerfile` ve `VideoEdit.Worker/Dockerfile` içinde `USER` direktifi **yoktur**;
seccomp profili ve ffmpeg kaynak sınırı da tanımlı değildir. Worker'a bellek limiti
(`compose.yml`: 6 GB) konmuştur, CPU limiti konmamıştır. **İnternete açık bir kurulumda
kapatılması gereken bir sertleştirme borcudur.**

### 4.7 Sunucuda tam şema doğrulaması yok

`PUT /api/projects/{id}/timeline` **yüzeysel** doğrular (schemaVersion, projectId, track/klip
sayısı, gövde boyutu, sample rate — `TimelineRequestValidation.cs`). Tam invaryant kontrolü
istemcide (zod) ve export öncesi derleyicide koşar. Yani API'ye doğrudan istek atan bir
istemci, geçersiz bir doküman kaydedebilir — **kaydeder, ama export edemez** (derleyici
tipli hatayla reddeder).

---

## 5. Neyin test edildiği — neyin edilmediği

Aşağıdaki sayılar **bu doküman yazılırken bizzat koşularak** alındı (2026-08-12, `f39e0b4`):

| Paket | Komut | Sonuç |
|---|---|---|
| Backend | `MINIO_AVAILABLE=1 dotnet test backend/VideoEdit.sln` | **834 / 834 geçti** |
| Backend (MinIO env'siz) | `dotnet test backend/VideoEdit.sln` | 821 geçti, **13 atlandı** |
| Editör | `pnpm --filter @videoedit/editor test` | **1048 / 1048 geçti** (68 dosya) |
| Şema paketi | `pnpm --filter @videoedit/timeline-schema test` | **169 / 169 geçti** |
| E2E (gerçek fare) | `pnpm --filter @videoedit/editor test:e2e` | **118 / 118 geçti** (Chromium, tek worker, 4.9 dk) |

**Atlanan 13 test** `MINIO_AVAILABLE=1` olmadan `Skip` olur: `ProcessAssetPipelineTests` (7),
`MinioStorageSmokeTests` (2), `ExportJobPipelineTests` (4 — LUT piksel testi dâhil). CI'da
MinIO konteyneri ayağa kalktığı için hepsi **gerçekten** koşar.

> **Yeşil test ≠ çalışan ürün.** §1.1'deki bulgu (görsel klipler önizlemede çizilmiyor) bu
> 2051 birim testi ve 118 e2e testinin **tamamı yeşilken** vardı: hiçbir test görsel klibin
> oynatıcı tuvaline çizildiğini kontrol etmiyordu. Bu dokümanın sayılarını mutlak bir güvence
> olarak değil, "hangi sınıf hata yakalanır" bilgisi olarak okuyun.

**Test edilmeyen yüzeyler:** oynatıcı tuvalinin GÖRSEL doğrulaması (piksel karşılaştırması
yalnız export tarafında var — `GoldenFrames/`, `RasterGoldens/`), yük/eşzamanlılık testi,
güvenlik penetrasyon testi, tarayıcı matrisi (yalnız Chromium), mobil, gerçek R2, çoklu
worker, uzun süreli (haftalarca ayakta) çalışma.

---

## 6. Bu POC ne İÇİN uygun, ne için değil

**Uygun:** akış doğrulama, iç demo, tasarım/UX geri bildirimi, "bu mimari çalışıyor mu"
sorusuna cevap, tek kullanıcılı gerçek düzenleme işi.

**Uygun değil:** halka açık çok kullanıcılı servis (§4.4, §4.5, §4.6), SLA'lı export
(§4.1), mobil kullanıcılar (§1.5), profesyonel renk işi (LUT'un editör UI'ı ve önizleme
shader'ı yok — §1.3), **fotoğraf/slayt gösterisi ağırlıklı iş akışı** (önizlemede
görünmüyor — §1.1).

> Frame ızgarası sorunu (§1.2) bu listedeydi; **düzeltildi** ve listeden çıkarıldı.

---

### İlgili dokümanlar

- [`docs/backlog.md`](backlog.md) — kapsam tablosu + milestone'a eşlenmiş borçlar
- [`docs/rendering-semantics.md`](rendering-semantics.md) — normatif render semantiği (§1.7 tolerans, §5.3 geçiş tablosu, §7 font sözleşmesi)
- [`fonts/README.md`](../fonts/README.md) — üç modlu font politikası ve belirlenimcilik
- [`deploy/README.md`](../deploy/README.md) — VPS + R2 çıkış adımları
