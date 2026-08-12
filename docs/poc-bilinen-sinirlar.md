# POC — Bilinen Sınırlar

**Bu doküman ürünü SATMAK için değil, DÜRÜST tanıtmak için yazıldı.** VideoEdit bir POC'tur:
uçtan uca çalışan, testli, ama üretim yükü altında denenmemiş bir sistem. Aşağıdaki maddelerin
her biri **kodda doğrulandı** — iddia edilen her sınırın yanında dosya/satır ya da ölçüm var.

Okuma sırası: önce **§1 kullanıcıyı ilk gün ısırabilecekler**, sonra §2–§6.

- Doğrulama tarihi: **2026-08-12**, `6ef7498` + **3. tur** düzeltmeleri (dosya/satır atıfları
  bu ağaçta yeniden denetlendi; §5'teki sayılar bu turda bizzat koşuldu)
- Ölçüm makinesi: Intel Core i9-10850K (10 çekirdek / 20 iş parçacığı), 32 GB RAM, Windows 11
- Yığın: .NET 10.0.302, Node v22.14.0, ffmpeg 8.0, PostgreSQL 17, Redis 7, MinIO (R2 yerine)

> **§1'de iki kapanmış madde var.** §1.1 (görsel/sticker önizlemesi) ve §1.2 (frame ızgarası)
> teslim düzeltme turlarında kapandı. Numaraları ve yerleri korundu, çünkü bu dokümanın daha
> eski bir sürümünü okumuş biri onları aramaya gelir; her ikisi de kendi başlığında
> "[DÜZELTİLDİ]" olarak işaretli ve neyin nasıl değiştiğini yazıyor.

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

Bu tablonun **son iki satırı** dokümanın taşıyıcı export ölçümüdür; başka bir export sayısı
vermiyoruz. Önceki sürümde burada geliştirme veritabanındaki başarılı iş sayısı ve ortalaması
duruyordu ("47 iş, ort. 2.58 sn"); o satır **her e2e koşumundan sonra kendiliğinden
yanlışlanıyordu**: yalnız bu doküman turunda 47'den 69'a çıktı, çünkü e2e paketi kısa
fixture'larla export koşuyor. Sayıyı düzeltmek yerine kaldırdık: bir teslim
dokümanında, okunduğu anda yanlış olacağı bilinen bir sayının yeri yoktur. Ortalamanın
anlattığı şeyi zaten yukarıdaki iki satır daha dürüst anlatıyor.

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
   (`backend/src/VideoEdit.Worker/Jobs/ProcessAssetJob.cs:392`, yorum: "Image için proxy
   ÜRETİLMEZ"; `ThumbnailKey` set edilir, `ProxyKey` edilmez). *Bu hâlâ böyledir; değişen,
   önizlemenin ne istediğidir.*
2. `GET /api/projects/{id}/media-urls` bu yüzden görsel için `proxy: null` döner.
3. Oynatıcının asset çözücüsü **koşulsuz `proxyUrl` okuyordu** → `url` null → `imageDrawItem`
   çizmeden dönüyordu (`engine-video/engineV1.ts:1076`).

**Düzeltme (bu teslim turu).** Kaynak seçimi asset **KIND'ına** göre karar veren tek bir saf
fonksiyona alındı: `apps/editor/src/features/player/previewSource.ts` — video/ses `proxy`,
görsel **`poster`** okur. Poster her hazır görselde zaten vardır; `PosterRecipe` kaynak
en-boy oranını korur, genişliği **1280 px**'e sınırlar (`PosterRecipe.MaxWidth`) ve HDR
kaynakta proxy/export ile **aynı** tonemap zincirini koşar — yani görselin "proxy"
karşılığıdır. `PlayerPanel.tsx:51` artık `previewSourceUrl(asset)` çağırıyor. Sticker'ın ayrı
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

1. **Derleyici kapısı kenarlara alındı** — `ExportCompiler.cs:270-279`: artık
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

### 1.3 [YÜKSEK] LUT (.cube): dört bacaklı sözleşmenin İKİ bacağı yok (editör UI + önizleme)

Bu projede bir özellik ancak **dört bacağın dördü** de varsa "var" sayılır: **şema**,
**editör UI'ı**, **önizleme (WebGL2)** ve **dışa aktarma (ffmpeg)**. LUT'ta ikisi var,
ikisi yok — ve eksik olanlar kullanıcının dokunduğu iki bacak.

| Bacak | Durum | Kanıt |
|---|---|---|
| Şema | **VAR** | `packages/timeline-schema/src/schema.ts:123` — `EffectTypeSchema = z.enum(['colorAdjust','lut'])` |
| Dışa aktarma (ffmpeg) | **VAR** | `ClipEffects.cs:238` `lut3d=file=…:interp=trilinear`; worker `.cube`'u ayrı varlık defterinden indirir (`ExportPlan.LutAssetIds`); intensity < 1 için split/blend zinciri; **pikselin gerçekten değiştiğini doğrulayan test**: `ExportJobPipelineTests.Export_WithLutEffect_DownloadsTheCubeFile_AndActuallyChangesPixels` |
| Editör UI'ı | **YOK** | Yükleme whitelist'i `SUPPORTED_EXTENSIONS` = `.mp4 .mov .webm .mp3 .m4a .wav .png .jpg .jpeg .webp` (`apps/editor/src/features/library/fileTypes.ts:12`) → `.cube` **yüklenemez**; efekt UI'ı yalnız `colorAdjust` sunar (`apps/editor/src/features/inspector/clipInspectorModel.ts:426`) → efekt **seçilemez** |
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

**Kullanıcı ne görür.** Bunu **açıkça söyleyen** bir uyarı (`LibraryPanel.tsx:599-600`):
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
`apps/editor/src/features/player/engine-video/engineV1.ts:1189-1215` — hedef kaynak
zamanına yarım kare toleransla 3 deneme, sonra kabul).

**Neden.** Bilinçli ürün kararı — kare-kesin önizleme WebCodecs gerektirir (§2.1).
Zaman/pozisyon matematiğinde tolerans YOKTUR; tolerans yalnız "hangi kaynak karesi ekranda"
sorusuna aittir. Golden-frame testleri bu toleransla yazılmıştır.

### 1.7 [DÜŞÜK] Track yeniden sıralama ve yeniden adlandırma yok

`timelineOps` yalnız `addTrack` ve `deleteTrack` sunar; bayraklar (sessiz/gizli/kilitli)
değiştirilebilir ama **track'lerin sırası** ve **adı** değiştirilemez
(`apps/editor/src/state/timelineOps.ts` — `addTrack` / `deleteTrack`; track sağ tık menüsü
`features/timeline/contextMenu.ts:262` yalnız yapıştır + üç bayrak + sil sunar). `addTrack`
yeni katmanı diziye **sona** ekler (`d.tracks.push`), yani görsel yığında en alta; `tracks[0]`
en üsttedir. Klipler katmanlar arasında taşınabildiği için bu bir
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
(`player/PlayerPanel.tsx:291`). **Export etkilenmez** — ffmpeg tüm katmanları çizer.

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
(`inspector/ClipPropertiesPanel.tsx:996`, `data-testid="clip-text-raster-note"`).

### 2.6 Ses parity'si (preview ↔ export RMS) ÖLÇÜLMEDİ

Kazanç zinciri birim testlerle pinlendi (geçişte toplam kazanç her an 1), ama
OfflineAudioContext tabanlı sayısal RMS karşılaştırması yazılmadı. Yani "önizlemedeki ses
export'takiyle aynı" iddiası **test edilmiş değil, tasarımla gerekçelendirilmiş**tir.

---

## 3. Şema / export motoru sınırları (tipli hata verir, sessiz bozulma yok)

Ortak nokta: hiçbiri **sessizce yanlış çıktı vermez**. Ama **kapının NEREDE olduğu** satırdan
satıra değişir ve bu fark kullanıcı için gerçektir: 422 istek anında gelir, kuyruk-sonrası bir
düşüş ise dakikalar sonra "başarısız" olarak görünür.

- **Şema düzeyi** (ilk iki satır) — sınır dokümanda **ifade bile edilemez**, o yüzden ortada
  reddedilecek bir şey yoktur: `speed` tek skalerdir (rampa yazılamaz) ve `KeyframeTracks`
  STRICT'tir (`fx.*` kanalı eklenemez, zod reddeder).
- **Derleyici 422'si** (3.–8. satırlar) — kural `ExportCompiler.Validate` **içindedir**; API
  export isteğinde onu çağırır (`ExportEndpoints.cs`), iş **kuyruğa hiç girmez** ve açık
  gerekçeli 422 döner. Hata tipli: `transition-keyframes`, `scale-keyframes-with-rotation`,
  `keyframes-audio-clip` / `effects-audio-clip`, `keyframe-sample-budget`, `transform-scale`,
  `overlay-too-large`.
- **Doküman değişmezi** (9. satır) — kural derleyicide VAR ama `Validate`'te DEĞİL, `Compile`
  aşamasındadır; API'nin ön kapısı yalnız `Validate`'i çağırdığı için onu **göremez**. Kapı bu
  yüzden **editördedir**: editör böyle bir doküman üretmez (yerleşimi geçiş zincirine yayar) ve
  DEV doküman kapısı her `commit`'te doğrular. Editörden gelen iş kuyruğa hiç girmez — ama
  API'ye **doğrudan** yazılmış bir doküman 202 alır ve worker'da düşer. Bu, §4.7'nin (sunucuda
  tam şema doğrulaması yok) doğrudan sonucudur, ayrı bir sürpriz değil.
- **Ayrı kapılar** (son üç satır) — doküman tavanları kaydetmede **400**, kaynak süresi tavanı
  işlemede `too-long`, profil ise basitçe tek seçenektir.

> **Bu ayrım 3. tur denetiminde ÖLÇÜLEREK doğdu — ve dokümanın kendi vaadini yanlışladı.**
> Bu bölümün ve README'nin önceki hali "desteklenmeyen bileşim kuyruğa hiç girmez, 422 ile
> gerekçe döner" diyordu; baş mimar **iki bileşimin 202 alıp canlı worker'da `failed`
> olduğunu ölçtü**. Kök neden tek bir cümleydi: bazı derleyici kuralları `Validate`'te değil
> `Compile`/raster aşamasında yaşıyordu ve API'nin ön kapısı yalnız `Validate`'i çağırıyor.
> İki kural da bu turda kapatıldı — **overlay katman tavanı `Validate`'e taşındı**, **geçiş
> yerleşimi editöre + doküman değişmezine alındı** — ve tablo artık hangi kuralın hangi
> kapıda olduğunu satır satır söylüyor. Ölçülen iki kural aşağıda **8. ve 9.** satırlardır.

| Sınır | Ne olur | Kanıt |
|---|---|---|
| **Hız rampası yok** *(şema)* | Bir klip = tek sabit oran (0.1×–10×). Klip içinde hızlanma/yavaşlama kurulamaz. | `schema.ts:195` `speed: z.object({ rate: … })` tek skaler |
| **Efekt parametresi keyframe'i yok** (`fx.*`) *(şema)* | colorAdjust/LUT değerleri animasyonlanamaz. Keyframe kanalları yalnız `x, y, scale, rotationDeg, opacity, volume`. | `schema.ts:109` `KeyframeTracksSchema` STRICT |
| **Geçişli kesimde keyframe yasak** | Geçiş penceresine giren klipte animasyon varsa 422. | `ExportCompiler.cs:1516` `transition-keyframes` |
| **Ölçek animasyonu + dönme birlikte yasak** | ffmpeg `rotate` çıkış tuvalini bir kez kurar, büyüyen girişi sessizce KIRPARDI — sessiz kırpma yerine tipli hata. | `ExportCompiler.cs:1867` `scale-keyframes-with-rotation` |
| **Ses klibinde görsel keyframe / renk efekti yasak** | Ses görüntü üretmez; sessizce yok saymak "animasyonum çalışmıyor" bug'ı olurdu. | `ExportCompiler.cs:1701` `keyframes-audio-clip`, `:1708` `effects-audio-clip` |
| **Keyframe örnek bütçesi 60 000** | Easing'li animasyon KARE KARE örneklenir; çok uzun animasyon 422. | `ClipAnimation.cs:83` `MaxSamples = 60_000`; hata `ExportCompiler.cs:864`, `:2402` `keyframe-sample-budget` |
| **Katman boyutu tavanı 8192 px** *(medya / görsel / çıkartma)* | Aşırı ölçek (ve dönmenin açtığı ara tuval) reddedilir. Editör bu satırda **önden korur**: ölçek alanının tavanı proje çözünürlüğünden türer (`maxClipScale`, 1080p'de ~4.266) — ama tavan **ara tuvalden** doğrulanır, editörün tavanı ise KUTUDAN; dönme (~1.41×) ve merkez dışı çapa (2×) ara tuvali büyüttüğü için dönmüş bir katman hâlâ 422 alabilir. | `LayerGeometry.cs:81` `MaxLayerDimension = 8192`; hata `transform-scale` (`ExportCompiler.EnsureLayerFits`); editör tavanı `invariants.ts` `maxScaleFor` |
| **Overlay katman tavanı 8192 px** *(metin / şekil)* | Metin/şekil klibinin çizim kutusu proje tuvalinden değil **rasterin kendi bbox'ından** türer (§7 @2x kuralı). Kural bu yüzden eskiden yalnız `Compile`'da bakılıyordu ve iş **kuyruk sonrası** düşüyordu — 3. tur denetiminde ölçülen iki vakadan biri. Artık `Validate`'te: **şekilde** kutu kesindir (sözleşme gereği proje karesi), **metinde** ölçüm yolu varsa gerçek bbox, yoksa **fonttan bağımsız kesin ALT SINIR** kullanılır — yani ölçüm yokluğu yanlış 422 üretmez, yalnız kapıyı zayıflatır. `Compile`'daki tavan **yedek olarak duruyor** (orada bbox her zaman gerçektir). Editör de önden korur: Inspector'ın **ölçek** ve **font boyutu** tavanları klibin KENDİ kutusundan türer (proje çözünürlüğünden değil) — 2000 px'lik bir başlık, bir video klibinden çok önce sınıra çarpar. | `ExportCompiler.EnsureRasterFits` / `TextBoxLowerBound`, hata `overlay-too-large`; ölçüm yolu: `Api/Program.cs` (`ITextRasterService` DI) → `ExportEndpoints.cs` `ExportCompiler.Validate(doc, overlayMeasurer)`; editör tavanları: `inspector/clipInspectorModel.ts` (`maxScale`, `maxFontSizePx`); GERÇEK KLAVYE kanıtı: `e2e/text-layer-limit.spec.ts` |
| **Geçişli kesimde iki klibin yerleşimi aynı olmalı** *(doküman değişmezi — girişteki 3. madde)* | `xfade` kesimin iki tarafını TEK akışa katlar ve iki girişin **aynı boyutta** olmasını şart koşar; farklı yerleşim, katmanın geçiş boyunca sessizce kaymasına yol açardı. Kullanıcı bunu bir **hata olarak görmez**: yerleşim yazan her işlem (transform yazma/sıfırlama **ve geçiş ekleme**) yerleşimi geçiş zincirinin tamamına **yayar** ve bunu bildirir. Derleyicideki kapı `Compile` aşamasındadır — API'nin 422 ön kapısı onu göremez, o yüzden asıl kapı editördedir. | Normatif kural: `docs/rendering-semantics.md` §5.2; değişmez: `packages/timeline-schema/src/invariants.ts` `checkTransitionPlacement`; editör: `state/timelineOps.ts` `alignTransitionChainTransforms` + `propagateTransformToChain`; derleyici (Compile): `ExportCompiler.cs:462`; GERÇEK FARE kanıtı: `e2e/guard-paths.spec.ts` — "böl → ölçekle → geçiş ekle" sırası kurulup iş **gerçekten render ediliyor** (kuyrukta ölmüyor) |
| **Tek export profili: 1080p** | 720p/4K/dikey ön ayarı yok; libx264 CRF18 `veryfast` + AAC 192k sabit. | `ExportProfiles.cs` |
| **Doküman tavanları** | En fazla 50 track, 2000 klip, ~2 MB timeline gövdesi; sample rate 44 100 veya 48 000. | `TimelineRequestValidation.cs:18-27` |
| **Kaynak süresi tavanı 4 saat** | Aşan medya probe SONRASI, transcode ÖNCESİ `too-long` ile düşer. | `Worker/Jobs/ProcessingOptions.cs:14` (`MaxDurationUs`), düşüş: `ProcessAssetJob.cs:167` |

### 3.1 Emoji font seti YOK

Küratörlü set 4 aile × 4 stil = 16 TTF (Roboto, Open Sans, Noto Sans, Noto Serif) — **emoji
fontu içermez**. Emoji içeren metin `.notdef` kutusu ("tofu") olarak çizilir. Sessiz kalmaz:
raster sonucu `HasMissingGlyphs = true` döner ve worker etkilenen klipleri **loglar**
(`Text/SkiaGlyphMeasurer.cs:97`, `Worker/Jobs/ExportJob.cs:300`) — ama iş DÜŞMEZ, kullanıcı
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

`AddHangfireServer` iki AYRI server ile iki kuyruk kurar (`Worker/Program.cs:103-119`):

- `transcode` kuyruğu: `WorkerCount = 2`
- `export` kuyruğu: **`WorkerCount = 1`** — ffmpeg render'ı zaten tüm çekirdekleri kullanır

Yatay ölçekleme (birden çok worker konteyneri) **denenmedi**. Kullanıcı başına eşzamanlı
(`Queued`|`Running`) export tavanı **2**'dir; aşımı 429 döner
(`ExportEndpoints.cs:33` `MaxConcurrentExportsPerUser`, `:77-80`). Pratikte: iki kullanıcı aynı
anda export başlatırsa **sıraya girerler**.

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
kotayı **kıl payı** aşabilir (`Api/Assets/UploadQuota.cs:16-17` — bilinçli MVP kabulü; kod
yorumu kesin çözümü "DB kısıtı değil periyodik mutabakat" olarak not eder).

**Varsayılan kotalar** (`Assets/QuotasOptions.cs`, `appsettings.json` "Quotas" ile ezilir):

| Ayar | Varsayılan | Anlamı |
|---|---|---|
| `MaxTotalBytesPerUser` | **20 GiB** | Kullanıcının silinmemiş tüm asset'lerinin toplamı |
| `MaxFileSizeBytes` | **4 GiB** | Tek dosya üst sınırı |
| `MaxConcurrentUploads` | **5** | Aynı anda "yükleniyor" durumundaki asset sayısı |

Ayrıca worker LRU cache tavanı 20 GiB (`Worker/Jobs/ProcessingOptions.cs:23` `MaxCacheBytes`)
ve upload parça boyutu sabit 64 MiB'dir
(`Domain/Services/UploadRules.cs:13` `PartSizeBytes` — R2 son parça hariç tüm parçaların eşit
olmasını zorunlu kıldığı için istemci bu değeri asla kendi seçmez).

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

**Nerede reddedildiği önemlidir.** Kuralların çoğu `ExportCompiler.Validate` içindedir ve
export isteğinde **422** ile döner; iş kuyruğa hiç girmez. Ama §3'ün 9. satırındaki kural
(geçişli kliplerin yerleşim eşitliği) derleyicide `Compile` aşamasındadır — ön kapı onu
göremez, dolayısıyla böyle bir doküman **202 alır ve worker'da `failed` olur**. Editör bu
dokümanı üretmez (§3), yani kullanıcının göreceği bir durum değildir; API'ye doğrudan yazan
bir istemci içinse bu maddenin doğrudan sonucudur. Sessiz bozulma yine YOKTUR: iş açık
gerekçeyle düşer, yanlış video üretilmez.

---

## 5. Neyin test edildiği — neyin edilmediği

Aşağıdaki sayılar **bu turda bizzat koşularak** alındı (2026-08-12, `6ef7498` + 3. tur
düzeltmeleri):

| Paket | Komut | Sonuç |
|---|---|---|
| Backend | `MINIO_AVAILABLE=1 dotnet test backend/VideoEdit.sln` | **980 / 980 geçti** (0 atlandı, 52 sn) |
| Backend (MinIO env'siz) | `dotnet test backend/VideoEdit.sln` | 967 geçti, **13 atlandı** |
| Editör | `pnpm --filter @videoedit/editor test` | **1186 / 1186 geçti** (72 dosya) |
| Şema paketi | `pnpm --filter @videoedit/timeline-schema test` | **191 / 191 geçti** (3 dosya) |
| Tip denetimi | `tsc -b` + `tsc -p e2e/tsconfig.json --noEmit` | **ikisi de temiz** (çıkış kodu 0) |
| E2E (gerçek fare) | `pnpm --filter @videoedit/editor test:e2e` | **129 / 129 geçti** (Chromium, tek worker, 28 spec dosyası, 6.0 dk) |

**Atlanan 13 test** `MINIO_AVAILABLE=1` olmadan `Skip` olur: `ProcessAssetPipelineTests` (7),
`MinioStorageSmokeTests` (2), `ExportJobPipelineTests` (4 — LUT piksel testi dâhil). CI'da
MinIO konteyneri ayağa kalktığı için hepsi **gerçekten** koşar.

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
dört e2e paketi motorun kendi `probePixel` köprüsünden (`engineV1.ts:899`, çizimle aynı
karede `gl.readPixels`) gerçek piksel okur — `image-preview.spec.ts` (fotoğraf/çıkartma),
`transitions.spec.ts` (iki kaynağın karışması), `speed-color.spec.ts`, `keyframes.spec.ts`.
Bu, kapsamlı bir görsel regresyon paketi **değildir**: nokta örneklemesidir, tam kare
karşılaştırması (golden frame) hâlâ yalnız export tarafındadır —
`backend/tests/GoldenFrames/` (11 PNG, export karesi) ve `backend/tests/RasterGoldens/`
(4 PNG, yalnız şekil rasteri; **metin golden'ı yok**, bkz. `docs/backlog.md` font bölümü).

**Test edilmeyen yüzeyler:** önizlemenin tam-kare golden karşılaştırması, preview↔export ses
RMS parity'si (§2.6), yük/eşzamanlılık testi, güvenlik penetrasyon testi, tarayıcı matrisi
(yalnız Chromium), mobil, gerçek R2, çoklu worker, uzun süreli (haftalarca ayakta) çalışma,
gerçek telefon/pis-dosya korpusu (§3.2).

---

## 6. Bu POC ne İÇİN uygun, ne için değil

**Uygun:** akış doğrulama, iç demo, tasarım/UX geri bildirimi, "bu mimari çalışıyor mu"
sorusuna cevap, tek kullanıcılı gerçek düzenleme işi, **fotoğraf/slayt gösterisi**
(önizleme + geçişler + export uçtan uca çalışıyor — §1.1).

**Uygun değil:** halka açık çok kullanıcılı servis (§4.4, §4.5, §4.6), SLA'lı export
(§4.1), mobil kullanıcılar (§1.5), profesyonel renk işi (LUT'un editör UI'ı ve önizleme
shader'ı yok — §1.3), kare-kesin scrubbing gerektiren iş (§1.6, §2.1), gerçek dünya
telefon/pis-dosya korpusuyla üretim kullanımı (§3.2).

> **Bu listeden iki madde ÇIKTI.** Frame ızgarası sorunu (§1.2) ve fotoğraf/slayt gösterisi
> iş akışı (§1.1) buradaydı; ikisi de düzeltildi. Kaydın tamamı ilgili başlıklarda.

---

### İlgili dokümanlar

- [`docs/backlog.md`](backlog.md) — kapsam tablosu + milestone'a eşlenmiş borçlar
- [`docs/rendering-semantics.md`](rendering-semantics.md) — normatif render semantiği (§1.7 tolerans, §5.3 geçiş tablosu, §7 font sözleşmesi)
- [`fonts/README.md`](../fonts/README.md) — üç modlu font politikası ve belirlenimcilik
- [`deploy/README.md`](../deploy/README.md) — VPS + R2 çıkış adımları
