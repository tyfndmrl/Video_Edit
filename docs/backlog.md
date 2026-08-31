# Teknik Backlog — Baş Mimar Denetim Bulguları

M0 denetiminde (2026-08-06, 37 bulgu) tespit edilip **bilinçli olarak ertelenen** maddeler. Her madde hedef milestone'a eşlendi. Kritik + yüksek bulguların tamamı ve ucuz orta bulgular M0'da düzeltildi (bkz. git geçmişi).

---

## KAPSAM DURUMU — kullanıcının MVP listesi (review-gate kural 4)

M4 dalga 1 denetimi, seçilen MVP özelliklerinden altısının "eksik **ve kayıtsız**" olduğunu
tespit etti. Aşağıdaki tablo bundan sonra her teslim notunun kaynağıdır; buraya yazılmadan
hiçbir özellik ertelenmiş sayılmaz.

**Son doğrulama: 2026-08-20, `a1b3a73` + 12. tur düzeltmeleri. (5. turda her satır KODDA
denetlendi ve satır numarası atıfları ÜYE/TEST adlarıyla değiştirildi; 8. turda "Ses
katmanları" satırı ölçümle yanlışlanıp düzeltildi — aşağıdaki nota bakın; 12. turda
kullanıcının ilk mesajındaki İKİ gereksinim tabloya EKLENDİ — daha önce hiç satırları
yoktu, bkz. aşağıdaki "12. tur" notu.)** "✅ tam"
yalnızca özelliğin uçtan uca (editör + şema + export) erişilebilir olduğu anlamına gelir;
bilinen sınırlar `⚠︎` dipnotlarıyla ve
[`docs/poc-bilinen-sinirlar.md`](poc-bilinen-sinirlar.md) ile birlikte okunmalıdır.

| MVP özelliği (kullanıcı seçimi) | Durum | Hedef |
|---|---|---|
| Çoklu katman timeline | ✅ tam (track yeniden sıralama + satır içi adlandırma 2026-08-21'de eklendi — sağ tık menüsü `Yukarı/Aşağı taşı` + başlığa çift tık; export katman sırası değişimi filtergraph karşılaştırmasıyla ölçüldü) | — |
| Kırpma/kesme/ayırma/taşıma/katman | ✅ tam (frame ızgarası çelişkisi teslim düzeltme turunda kapandı — aşağıya bakınız) | — |
| Frame, zoom, timecode, player, kısayollar | ✅ tam | — |
| Undo/Redo + işlem geçmişi | ✅ tam | — |
| Hesap + proje yönetimi, autosave | ✅ tam (versiyon geçmişi UI'ı M6'da geldi) | — |
| **Ses katmanları** (waveform, seviye, fade, detach) | ✅ tam (M4 dalga 1) ⚠︎ *dışa aktarma yolu 8. tura kadar KIRIKTI — aşağıya bakınız* | — |
| **Çoklu katman export + transform** | ✅ tam (M4 dalga 1) | — |
| **Görseller (PNG/JPG/WebP)** | ✅ tam (önizleme kusuru teslim düzeltme turunda kapandı — aşağıya bakınız) | — |
| **Yazı & overlay** (metin, sticker, şekil) | ✅ tam (M4 dalga 2) ⚠︎ emoji yok; shaping iki motorda | sonraki dilim |
| **Geçişler** (xfade/acrossfade) | ✅ tam (M4 dalga 2 — doküman/op/export + oynatıcı önizlemesi) · **fadeToBlack paritesi 2026-08-21'de ölçülerek kapandı** (ffmpeg YUV kapalı formu; zincir: GLSL ≡ ref ≡ gerçek ffmpeg vektörleri ≡ üretim golden'ları — §5.3) ⚠︎ dissolve deseni bilinçli yaklaşıklık (ölçüldü: aynı eşik kuralı/yoğunluk, desen korelasyonsuz %50,01; PRNG tam sayı piksel + libm bağımlı) ve fadeToBlack'in kompozisyon-yolu dibi ölçülü ≤ ~15/255 sapar | [`poc-bilinen-sinirlar.md`](poc-bilinen-sinirlar.md) §2.3 |
| Pis-dosya korpusu (iPhone HDR/VFR/döndürülmüş) testleri | ✅ **kapandı (backend borç turu, 2026-08-21)**: 7 sınıf (VFR, display-matrix döndürme, 319×241 tek çözünürlük, kapak resimli MP3, yanlış uzantı, HLG/BT.2020 etiketi, dikey 720×1280) gerçek ffmpeg'le üretilip HEM işleme HEM export hattından geçiriliyor; her sonuç TİPLİ (`DirtyMediaCorpusTests`, MinIO+ffmpeg kapılı, 7/7 yeşil) | — |
| **Renk düzeltme — colorAdjust** (parlaklık/kontrast/doygunluk/sıcaklık/ton/pozlama) | ✅ tam (M5 — Inspector + önizleme shader'ı + export) | — |
| **Filtreler — LUT (.cube)** | ✅ **tam (2026-08-21)**: `.cube` yükleme türü (`AssetKind.Lut` + `application/x-cube-lut`, worker `CubeLutValidator` doğrulaması, türev/probe YOK) + Inspector LUT bölümü (seçici + yoğunluk + etkin + Kaldır) + §4.2 normatif önizleme shader'ı (`uLut3D/uLutScale/uLutOffset/uIntensity`, trilinear, geçişte taraf başına). Parite ÖLÇÜLDÜ (gerçek fare e2e `lut.spec.ts`): önizleme↔export SSIM(gri) **0,99424**, kanal |fark| ort **1,603** (§9.3 eşikleri ≥0,98 / ≤2,0); bozuk .cube `invalid-lut` tipli düşer. Sınırlar: domain [0,1] dışı ve N>129 KAPSAM DIŞI (yükleme kapısı tipli reddeder); `fx.*` keyframe'i hâlâ yok (ayrı satır) | — |
| **Hız değiştirme** (slow-mo/timelapse) | ✅ tam (M5) ⚠︎ hız rampası yok | sonraki dilim |
| **Keyframe animasyonları** | ✅ tam (M5, sınırlarıyla — aşağıya bakınız) ⚠︎ `fx.*` kanalı yok | sonraki dilim |
| **1-2 GB'lık dosyalarda performans** ("dosya boyutları ortalama 1-2 gb aralıklarında oluyor… performanslı ve hızlı olmalı") | ✅ **iki kez uçtan uca ÖLÇÜLDÜ + boru hattı KALICI oransal perf testiyle korunuyor** (B2, 2026-08-25). n=1: 1,51 GiB / 10:40 (seçiciden "Hazır"a 75,6 sn, 60 sn'lik kesim 19,5 sn, tam çizelge 184 sn — 12. tur); n=2: **2,53 GB / 16:40** (seçiciden "Hazır"a **117,6 sn**, 38 parça yükleme 6,7 sn, işleme 109,8 sn ≈ 9,1×, 60 sn'lik kesim 23,3 sn duvar). 4 GiB tavanı canlı denendi (iki yanı — §0.1.1). Rejim muhafızı `MediaPipelinePerfTests` her koşumda (oranlar: işleme ≤ 0,75×, export ≤ 2×, türev ≤ %25). ⚠️ hâlâ: **TEK makine, LOKAL nesne deposu**, eşzamanlı kullanıcı yok; 20 GiB LRU tavanının GB'lık dosya ÖLÇEĞİ değil (mekanizma testli — `OriginalCacheLruTests`) | ölçümler: [`poc-bilinen-sinirlar.md`](poc-bilinen-sinirlar.md) §0.1-§0.1.2 · kalanlar: aşağıdaki "12. tur" |
| **R2'de saklayıp SONRADAN tekrar düzenleme** | ⚠️ İKİ YARI AYRI: "sonradan tekrar düzenleme" ✅ gerçek fare/klavyeyle ölçüldü (düzenle → "Kaydedildi" → çıkış → yenile → yeniden giriş → seçici → aynı belge + aynı medya); "**R2'de saklayıp**" ❌ **gerçek Cloudflare R2 HİÇ denenmedi** — dev de CI da MinIO | R2 doğrulaması: **ilk gerçek dağıtım** ([`poc-bilinen-sinirlar.md`](poc-bilinen-sinirlar.md) §4.2 + [`deploy/README.md`](../deploy/README.md) §4) |

> **M6 KAPSAM KAYDI (review-gate kural 4, 2026-08-12).** M6 planı bu dosyada altı madde
> listeliyordu; teslim edilen M6 **iki** maddedir: **sürüm geçmişi UI'ı** (`features/versions`,
> e2e `versions.spec.ts`) ve **kota/silme UX'i** (`quotaModel.ts`, `AssetDeleteDialog.tsx`,
> e2e `library-manage.spec.ts`). Yapılmayan dört madde sessizce düşmedi, aşağıdaki
> "M6 (Dayanıklılık)" bölümünde **açık** kalmaya devam ediyor: `fx.*` keyframe'i,
> revision retention job, tsconfig.node tip denetimi (LUT editör yüzeyi 2026-08-21'de
> kapandı — kapsam tablosundaki satırı). Bunların hepsi
> [`docs/poc-bilinen-sinirlar.md`](poc-bilinen-sinirlar.md) §1.3, §4.3, §4.5, §4.6'da
> kullanıcıya da anlatıldı. *(Güncelleme 2026-08-21: bu listedeki container sertleştirme
> [non-root `USER app`], per-device logout ve Dockerfile restore backend borç turunda
> KAPANDI — aşağıdaki M6 tablosuna bakınız.)*

> **Görseller satırının hikâyesi (kayda geçer).** Satır M4 dalga 1'den beri "✅ tam" diyordu;
> POC dokümantasyon turu bunun **yanlış** olduğunu buldu: export doğruydu ama görsel ve sticker
> klipleri oynatıcı önizlemesinde hiç çizilmiyordu. Teslim düzeltme turunda kapandı —
> `features/player/previewSource.ts` kaynağı asset KIND'ına göre seçiyor (görsel → poster) ve
> `e2e/image-preview.spec.ts` bunu **gerçek piksel okuyarak** tutuyor. Aynı düzeltmede görsel
> klibin doküman değişmezini ihlal etmesi de kapandı (`knownAssetDurations` görselleri haritaya
> koymuyor). Ayrıntı: [`docs/poc-bilinen-sinirlar.md`](poc-bilinen-sinirlar.md) §1.1.
>
> **Alınacak ders (silmeyin).** Satır M4 dalga 1'den POC dokümantasyon turuna kadar "✅ tam"
> kaldı, çünkü kabul kriteri "doküman doğru mu + export doğru mu" idi; **kullanıcının GÖRDÜĞÜ
> yüzey hiç okunmuyordu.**
> Dört bacaklı kural (şema / editör UI / önizleme / export — §1.3) bu yüzden bağlayıcıdır ve
> önizleme bacağının kanıtı ancak PİKSEL olabilir.

> **Ses katmanları satırının hikâyesi (8. tur denetimi, 2026-08-13 — kayda geçer).** Satır
> M4 dalga 1'den beri "✅ tam" diyordu ve bu **YANLIŞTI**: kullanıcının en doğal ses işi —
> kitaplığa bir müzik dosyası yükleyip ses track'ine koymak — projeyi **dışa aktarılamaz**
> hale getiriyordu (`POST /exports` 202, iş worker'da `unsupported-media: … has no video
> stream`). Üstelik `.m4a` bu makinede **yüklenemiyordu** bile (istemci içerik tipini
> `File.type`'tan alıyordu; Chromium/Windows `audio/x-m4a` diyor, sunucu whitelist'i
> reddediyor) — yani ürün, arayüzünde vaat ettiği bir formatı kabul etmiyordu.
> İkisi de 8. turda kapandı: içerik tipi **uzantıdan** türetiliyor
> (`library/fileTypes.ts` `contentTypeForFileName`) ve export kapısı artık "dosyada ne var"
> yerine **"o dosyayı okuyan KLİP ne istiyor"** sorusunu soruyor
> (`ExportCompiler.NeedOf` → `ExportPlan.AssetUses`; senkron `asset-clip-type`, worker
> `unsupported-media`). Kullanıcı anlatımı:
> [`docs/poc-bilinen-sinirlar.md`](poc-bilinen-sinirlar.md) **§1.8** + §3 matrisi.
>
> **Alınacak ders (silmeyin) — Görseller satırının dersiyle AYNI SINIF.** Satır M4 dalga 1'den
> 8. tura kadar "✅ tam" kaldı çünkü kabul kriteri "editörde ses özellikleri
> var mı" idi: waveform çiziliyor, seviye/fade/detach çalışıyor, ses klibi export
> **derleyicisinden** geçiyordu. Kimse **uçtan uca** "yalnız ses varlığı gösteren bir belge
> gerçekten render ediliyor mu" diye sormamıştı; worker'ın indirme döngüsü birim testlerde
> `ExportAssetSource` doğrudan verildiği için hiç koşmuyordu. Kural: bir özelliğin
> "tam" sayılması için **kullanıcının kurabileceği en yalın belgenin gerçekten render
> edildiği** ölçülmelidir — yeşil birim testi bunu göstermez.

> **Renk satırının ikiye ayrılma gerekçesi (M5 denetimi, 2026-08-12).** Tek satır "⚠️ motor
> hazır, UI yok" iki farklı gerçeği gizliyordu. `colorAdjust` M5'te uçtan uca kapandı: altı
> §4.1 parametresi Inspector'da, aynı değerler önizleme shader'ında ve export zincirinde.
> `lut` ise HÂLÂ yalnız renderer'da var: compiler `lut3d=file=...:interp=trilinear` üretiyor,
> worker `.cube` dosyasını AYRI bir varlık defterinden indiriyor (`ExportPlan.LutAssetIds` —
> `.cube` probe edilemez), ama editörde ne `.cube` yükleme yolu, ne efekt UI'ı, ne de
> önizlemesi var. Yani kullanıcı LUT'u SEÇEMEZ; şemada legal, üründe erişilemez.
> **M6'ya yazılmıştı, M6'da YAPILMADI** (yukarıdaki kapsam kaydı) — sonraki dilime taşındı.
> Motorun gerçekten çalıştığı testle sabit:
> `ExportJobPipelineTests.Export_WithLutEffect_DownloadsTheCubeFile_AndActuallyChangesPixels`.
> **KAPANIŞ (2026-08-21):** o "kalan iş" bu turda teslim edildi — `.cube` yükleme yolu
> (`fileTypes.ts` + `UploadRules` + `AssetKind.Lut`, worker'da `CubeLutValidator` ile
> probe'suz/türevsiz Ready), Inspector LUT bölümü ve §4.2 önizleme shader'ı
> (`sampler3D` + trilinear + yoğunluk karışımı). Uçtan uca gerçek-fare kanıtı ve
> önizleme↔export parite ölçümü: `e2e/lut.spec.ts` + `poc-bilinen-sinirlar.md` §1.3.

> **Hız satırı (M5).** Inspector'da ön ayarlar + serbest oran (0.1x–10x), ripple/reddet
> davranışı, keyframe zaman yeniden ölçekleme, ses fade'lerinin yeniden sınırlanması ve
> geçiş paylarının yeniden uzlaştırılması. Süre artık `solveSpeedChange`
> (`packages/timeline-schema/src/time.ts`) ile ÇÖZÜLÜYOR: compiler klibi iki bağımsız kapıdan
> geçiriyor (süre formülü **ve** proje frame ızgarası) ve yalnız formülü uygulamak
> ızgara dışı süre üretip export'u 422 ile düşürüyordu (30 fps'te 3 sn @ 0.7x → 4_285_714 µs,
> ızgara komşusu 4_300_000 µs). Sınır: **hız rampası yok** (tek klip = tek sabit oran).
>
> **DÜZELTME (bu tur).** Bu paragrafın eski hali "compiler zaten `speed-ramp` tipli hatasıyla
> reddediyor" diyordu — **öyle bir hata tipi YOK.** `VideoEdit.Media` altındaki tipli export
> hatalarının tamamı: `easing-type`, `effect-type`, `effects-audio-clip`,
> `keyframe-sample-budget`, `keyframes-audio-clip`, `lut-asset`,
> `scale-keyframes-with-rotation`, `transform-scale`, `transition-handle`,
> `transition-keyframes`, `transition-type`, `unknown-clip`. Rampa **şema düzeyinde**
> imkânsızdır (`speed` tek skaler), yani compiler'ın reddedeceği bir rampa hiç doğmaz —
> sınır gerçek, gerekçesi yanlış yazılmıştı.

> **Keyframe satırının SINIRLARI (kayda geçer).** Kanallar yalnız
> `x / y / scale / rotationDeg / opacity / volume` (şema `KeyframeTracks` STRICT). Bilinçli
> olarak YOK: (a) **efekt parametresi keyframe'i** (`fx.*` — colorAdjust/LUT animasyonu),
> (b) **hız rampası**, (c) geçişli kesimde keyframe (compiler `transition-keyframes` tipli
> hatası). Erişim yüzeyleri: Inspector her kanal için elmas düğmesi + (playhead keyframe
> üstündeyken) easing seçici; timeline şeridi en fazla 2 kanal satırı çizer, kalanlar "+N"
> çipinden satır alır. `fx.*` keyframe'i M6'ya yazılmıştı ama M6'da **yapılmadı**; aşağıdaki
> "M6 (Dayanıklılık)" bölümünde açık duruyor.

> **Görseller satırının geçmişi (kayda geçer).** M4 dalga 1'de ürün kullanıcıyı görsel
> yüklemeye AKTİF olarak yönlendiriyordu (`fileTypes.ts` PNG/JPG/WebP diyor, worker işliyor,
> timeline'a eklenebiliyor) ama ExportCompiler görsel klibi 422 ile reddediyordu — kullanıcı
> emeğini dışa aktaramıyordu. Dalga 1 denetiminde kapatıldı: export `-loop 1 -t <süre>` girişi
> açıyor, görsel klip diğer katmanlarla aynı geometri/opaklık zincirinden geçiyor ve ses
> üretmiyor. Görsel klibin `sourceIn/sourceOut`'u dosyada bir zaman aralığına karşılık
> GELMEDİĞİ için worker'ın kaynak-aralığı kapısından muaftır (`ExportPlan.Clips`).

> **Görseller satırı, dalga 2 denetimi (2026-08-12).** Aynı "muafiyet" kuralı editör ve şema
> tarafında EKSİKTİ: D/2 kaynak payı her medya klibine uygulanıyordu, görsel klip ise
> `sourceIn = 0` ile doğduğu için payı daima sıfırdı → iki fotoğraf arasına geçiş
> ("no room for a transition") EKLENEMİYORDU. Slayt gösterisi geçişin en yaygın kullanımıdır
> ve renderer onu zaten destekliyordu. Üç katman hizalandı: pay kuralı artık yalnız
> kaynağında ZAMAN EKSENİ olan tarafa uygulanır (`hasSourceTimeAxis`, compiler'daki
> `ExportClipPlan.IsStillInput`'un aynadaki karşılığı). Karışık kesimde (görsel↔video)
> yalnız video tarafının payı denetlenir. Kanıt: `e2e/transitions-image.spec.ts` (gerçek fare),
> `ExportImageTransitionTests`, `transitions.test.ts` + `invariants.test.ts`.

> **Geçişler satırının kapsamı.** Doküman sözleşmesi (§5 simetri/çift-kare/üst sınır/pay),
> editör op'ları (ekle/kaldır/tip/süre + kırpma-taşıma-bölme sonrası uzlaştırma ve BİLDİRİM),
> rozet + sağ tık menüsü ve xfade/acrossfade export dalga 2'de tamamlandı. Oynatıcı
> önizlemesi de uygulandı; kalan piksel-parity borçları aşağıdaki
> "Geçiş ÖNİZLEMESİ" başlığında listelidir. Not: geçişli kesimde keyframe animasyonu
> compiler tarafından tipli hata ile reddedilir (`transition-keyframes`) — bilinçli sınır.

### M4 dalga planı (denetim #18/#23 gereği yazıldı)
- **Dalga 1** (tamam): çok katman overlay export, transform gizmo, klip özellikleri paneli, detach audio, görsel (still image) klipler.
- **Dalga 2** (tamam): metin/şekil/sticker katmanları (SkiaSharp sunucu raster + client önizleme, font manifesti) + geçişler (xfade/acrossfade, D/2 handle sözleşmesi — pay kuralı görsel kliplerde uygulanmaz).
- **Dalga 3** (backend yarısı kapandı, 2026-08-21): pis-dosya korpusu uçtan uca testleri ✅ (`DirtyMediaCorpusTests` — HLG, VFR, döndürülmüş, tek çözünürlük, dikey, kapak resimli ses, yanlış uzantı; işleme + export, tipli sonuçlar) ve belge-değişmezi parity aileleri ✅ (keyframe sıralaması / geçiş simetrisi / klip yerleşimi vektörleri — aşağıdaki 14. tur başlığı). Önizleme piksel-parity borçlarından **fadeToBlack aynı gün ölçülerek KAPANDI** (§5.3 normatif YUV kapalı formu; kalan artıklar `poc-bilinen-sinirlar.md` §2.3'te); **dissolve** ölçülmüş gerekçeyle bilinçli yaklaşıklık olarak kaldı (desen korelasyonsuz %50,01 — golden yazılamaz).

## M1 (Upload + işleme)
- **Waveform üretimi .NET içinde**: `audiowaveform` Debian'da paket olarak yok (denetim bulgusu #6); karar — worker ffmpeg ile PCM çekip C#'ta min/max pencereleme yapacak (tasarım `docs/design/02` §3.5'teki alternatif). Dockerfile'dan bağımlılık kaldırıldı.
- **Rate limiting**: auth (login/register) ve asset presign/init endpoint'leri (`AddRateLimiter`); denetim #5/#19 bağlamı.
- **compose R2__\* env adları ↔ backend config binding birebir eşleşme testi** (R2 istemcisi M1'de yazılırken; denetim #36 notu).

## M2 (Timeline + player + autosave UI)
- **Request decompression middleware**: plan "tam doküman, gzip" diyor; frontend gzip göndermeden önce `UseRequestDecompression` eklenmeli (denetim #5c).
- **409 sonrası UX**: "başka sekmede değişti" diyaloğu + SignalR ile pasif sekme bilgilendirme (plandaki bilinçli MVP kabulü). *14. tur triyaj ölçümü (2026-08-21, BG bulgu B6):* asset listesi poll'u yalnız listede uploaded/processing satır varken koşuyor (`entities/assets.ts` refetchInterval); başka istemcinin/sekmenin yüklediği asset ve kota göstergesi, odak/yenileme olmadan görünmüyor (canlıda yeniden ölçüldü: API'den yüklenen iki asset ready olduktan sonra açık sekme 192 medyada kaldı, yenilemeyle 194 geldi). Kod içinde "SignalR gelene kadar kabul edilmiş ara çözüm" beyanı doğru — SignalR maddesi kapsamına bu ölçüm dahildir.

## M3 (Export) öncesi
- **sampleKeyframes / easingProgress için paylaşılan cross-language vektörler**: `easing-vectors.json` yalnız eğriyi kapsıyor; keyframe örnekleme vektörleri eklenmeli, C# compiler bunlarla test edilmeli (denetim #13).
- **SchemaGen sertleştirme**: enum tel-değeri regex yaması ve `__schemaN` yeniden adlandırması NJsonSchema çıktı formatına duyarlı — snapshot testi eklenmeli; başlık yorumundaki "byte-for-byte round-trip" iddiası düzeltilmeli; `SchemaVersion` double→int, sabit `Kind` literal'lerinin zorlanması (denetim #24, #26).
- **Timeline tam şema doğrulaması API'de**: M0'da yüzeysel kontrol (schemaVersion/projectId/tavanlar) eklendi; export öncesi üretilen DTO + invariant kontrolü sunucuda da koşmalı (denetim #5b'nin tam hali).

## Fontlar (M4'te açılan üç modlu politika)

- **Üretim dağıtımı öncesi küratörlü font seti KURULMALI** (`fonts/fetch-fonts.ps1` /
  `fetch-fonts.sh`) ve worker'da `Fonts:AllowSystemFallback = false` yapılmalıdır. TTF'ler
  **depoda değildir** (`fonts/.gitignore`: `*.ttf`) — betiği koşmayan bir kurulumda metin
  klipleri **sistem fontuyla** çizilir (2. mod, `fonts/README.md`): export başarılı ve uyarılı,
  ama **belirlenimci değil** (iki worker farklı piksel üretebilir) ve sistem fontları
  **yeniden dağıtılamaz** (lisans). POC için kabul, üretim için blocker.
  *Bu makinede set kurulu ve API `"pinned":true` döndürüyor (16 TTF, 7.8 MB) — yani mod 1'de
  koşuyor; borç, kurulumu bir DAĞITIM KAPISI yapmaktır, bugünkü makinenin durumu değil.*
  - **ÖLÇÜLDÜ (8. tur, N4): sistem fontuyla ölçülen kutu, küratörlü kutunun ne üstü ne altıdır.**
    Windows 11 + SkiaSharp 3.116.1, küratörlü set ↔ sistemin seçtiği aileler (roboto→Arial,
    open-sans/noto-sans→Segoe UI, noto-serif→Times New Roman); düzenek 4 fontId × 3 punto ×
    2 ağırlık × 5 metin: bbox **genişliği −21,1% … +7,9%**, **yüksekliği en çok 3,8%** ayrışıyor.
    Sonuç: 8192 px'lik overlay tavanı bu sayıya güvenseydi **kurulum durumuna** bağlanırdı
    (+ yönü YANLIŞ 422 üretir). **Karar (uygulandı):** ölçüm pinli değilse
    (`TextLayout.FontIsDeterministic = false`) kutu KESİNLEŞTİRİLMEZ — kapı font-bağımsız alt
    sınıra düşer, rejim **503 DEĞİLDİR** (ölçüm patlamadı; 503 olsaydı fontları indirilmemiş her
    kurulumda metin içeren HER export reddedilirdi) ve gerçek tavan render anında çizilen
    rasterin gerçek kutusuyla sorulmaya devam eder. Testler:
    `ExportEndpointsTests.StartExport_SystemFontMeasurement_DoesNotDecideTheCeiling` +
    `…_StillRejectsWhatTheLowerBoundCanSee`. Ayrıntı: `poc-bilinen-sinirlar.md` §3.3.
    *Bu, yukarıdaki borcu KAPATMAZ — yalnız borcun ödenmemiş halinde kapının yanlış 422
    üretmesini engeller; üretimde küratörlü set hâlâ ZORUNLUDUR (belirlenimcilik + lisans).*
- **Worker uyarı kanalı `ILogger`'a bağlanmalı**: `SkiaOverlayRasterService` belirlenimcilik
  uyarısını `onWarning` geri çağrısıyla yayar; bağlanmadığında `stderr`'e yazar. Worker DI'da
  tek satır: `new SkiaOverlayRasterService(opts, onWarning: m => logger.LogWarning("{Msg}", m))`.
  Ayrıca `Configure<FontOptions>(Configuration.GetSection("Fonts"))` bağlanırsa
  `Fonts:SystemFallback:*` appsettings'ten de okunur (bugün env `Fonts__SystemFallback__*` ile
  çalışıyor). `ExportJob` `OverlayRasterSet.ClipsUsingSystemFont` / `SystemFontWarnings`
  defterini `ClipsWithMissingGlyphs` gibi loglamalı, iş DÜŞMEMELİ.
- **Metin piksel golden'ları** küratörlü set kurulunca eklenmeli (`CuratedFontFact` deseni
  hazır; sistem fontu modunda golden ANLAMSIZDIR ve `TestFonts.CreateService` fallback'i
  kapatarak bunu imkânsız kılar).

### AÇIK: Sunucu overlay ölçüm ucu — `POST /api/overlays/measure` (M4 dalga 2 denetimi, bulgu #3b)

Denetimin §7 "uzlaştırma mekanizması" maddesinin **kapatılan** yarısı (bu dilimde yapıldı):

- `GET /api/fonts` — katalog artık `fonts/manifest.json`'dan SUNULUYOR; editörün sabit
  kodlu listesi kalktı, offline yedeği `fontManifest.contract.test.ts` manifest dosyasına
  karşı doğruluyor (KRİTİK bulgu #1).
- `GET /api/fonts/{fontId}/{styleKey}.ttf` + `@font-face` — tarayıcı artık SkiaSharp'ın
  rasterlediği **aynı TTF** ile ölçüyor; `cssStack`teki "benzer sistem fontu" yolu kapandı
  (bulgu #3a). Ailenin adı `ve-<fontId>` (özel): yerel kurulu bir "Roboto" kazanamaz.
- Kutu kuralı tek: `packages/timeline-schema/test-vectors/text-layout-vectors.json` iki
  dilde de okunuyor (bulgu #2).

**Kalan borç:** `POST /api/overlays/measure` (TextClip + settings → `{ lines[], bboxPx }`)
YOK. Yani istemci hâlâ **ikinci bir shaping motoru** çalıştırıyor (Canvas2D vs
HarfBuzz). Aynı kural + aynı dosyayla basit Latin metinde fark ihmal edilebilir, ama
**bitişik harfler / RTL / emoji** içeren metinlerde satır genişliği birkaç piksel kayabilir
ve satır kırılımı teoride farklı düşebilir. Inspector notu bunu **olduğu gibi** söylüyor
(`clip-text-raster-note`).

Hedef tasarım: uç `SkiaOverlayRasterService.Measure`'ı çağırır (zaten var, saf);
önizleme idle'da (klip seçiliyken, ~250 ms yazma duraklamasından sonra) ölçümü ister ve
gizmo kutusunu sunucu bbox'ıyla uzlaştırır; raster PNG'si de aynı uçtan gelebilir
(`overlayRaster.ts` bu durumda canlı düzenleme hızlı yolu olarak kalır). Doğrulama:
cross-language vektörlere ek olarak "aynı TextClip → aynı bbox" birim testi + bir e2e
(gizmo kutusu sunucu cevabından sonra sabit kalıyor mu).

## Geçiş ÖNİZLEMESİ (M4 dalga 2 denetimi — uygulandı, kalan borçlar)

M4 dalga 2 denetimi "önizleme geçişleri hiç uygulamıyor" (yüksek) bulgusunu verdi:
`resolveVisualStack` track başına tek klip döndürüyordu, yani kullanıcı önizlemede SERT
KESİM görüp export'ta crossfade alıyordu. Karar **erteleme değil uygulama** oldu; pencere,
ilerleme, handle ve ses rampası artık `docs/rendering-semantics.md` §5.3'te NORMATİF olarak
yazılı ve motorda uygulanıyor. Aşağıdakiler bilerek dışarıda bırakıldı:

- **`dissolve` deseni ffmpeg ile birebir değil (bilinçli; `fadeToBlack` 2026-08-21'de
  ölçülerek eşitlendi).** fadeToBlack artık ffmpeg `fadeblack`ın YUV kapalı formunun
  kendisidir (normatif formül + ölçüm zinciri: rendering-semantics §5.3; artıklar
  poc-bilinen-sinirlar §2.3). Dissolve'da eşik kuralı ve yoğunluk birebirdir ama desen
  eşitlenemez (ffmpeg tam sayı piksel koordinatını libm `sinf` ile hash'ler — çözünürlük
  ve platform bağımlı; ölçülen desen uyuşması p=0.5'te %50,01 = bağımsız) → dissolve için
  golden-frame preview↔export karşılaştırması yazılamaz.
- **Geçiş penceresinde çözücü bütçesi 2 kat.** Pencere açıkken A ve B birlikte
  `priority 0` olur, yani POOL_SIZE=4'ün ikisini yer. Kalabalık bir kompozisyonda geçiş
  boyunca bir katman/ses DAHA düşebilir. Sessiz değil (mevcut `previewShortfallNote`
  rozetiyle bildiriliyor) ama havuzu büyütmek/geçişte önceliği ayarlamak M5 konusu.
- **Geçiş pass'inde kenar yumuşatma yok.** Tam kare dörtgen üstünde her taraf kendi
  yerleşim matrisinin tersiyle örneklendiği için, kareye tam oturmayan (ölçekli/döndürülmüş)
  bir katmanın kenarı geçiş sırasında tırtıklı görünebilir. Tam kare kliplerde etkisi yok.
- **Ses parity ölçümü hâlâ borç.** §5.4 rampası birim testlerle (toplam kazanç her an 1)
  pinlendi; preview↔export RMS karşılaştırması M3 backlog'undaki OfflineAudioContext
  maddesine bağlı, orada duruyor.

## M5 denetiminden (2026-08-12) — editör tarafı

### Kapatıldı (bu dilimde)
- **[KRİTİK] Hız, proje frame ızgarası DIŞINDA süre üretiyordu** → export compiler'ın
  ikinci kapısı (`SnapUs(TimelineDurationUs) == TimelineDurationUs`) klibi sert hatayla
  reddediyor, editör uyarmıyordu. Sözleşme düzeyinde çözüldü: süre önce tam frame sayısına
  ÇÖZÜLÜYOR, `sourceOutUs` ona göre yeniden türetiliyor (`solveSpeedChange`, tek yardımcı,
  `packages/timeline-schema/src/time.ts`). Naif `sourceOut = sourceIn + round(D*rate)` 1x
  ALTINDA geri dönmediği için (pencere genişliği = `rate`, bazı frame sayıları hiç
  ulaşılamıyor) çözücü ideal frame sayısından dışa doğru yürüyor. Compiler kapısı şema
  paketinde `exportFrameGridIssues()` olarak birebir yeniden yazıldı ve cross-boundary
  testlerde AYNI fixture hem `validateTimelineDoc`'tan hem bu kapıdan geçiriliyor.
  Yan ürün: 1x ALTINDA bazı frame sayıları hiç ulaşılamadığı için süre bazen yarım kareden
  fazla sapıyor (ölçüm, 30 fps: 3 sn @ 4x → 16_667 µs; 5.231733 sn @ 0.5x → 36_534 µs).
  Sessiz kalmıyor: `SPEED_DURATION_SNAPPED` bildirimi Inspector'da Türkçe gösteriliyor
  (`inspectorFeedback.ts`). Sapma KARE cinsinden ölçülür — µs eşiği 30 fps'te
  (kare = 33_333.33 µs) meşru yarım-kare snap'i yanlışlıkla bildirim sayıyordu.
- **[ORTA] Ses kazancının ondalık hassasiyeti iki yerde ayrı yazılıydı** (`timelineOps`
  içinde çıplak `4`, `keyframeModel.channelBounds` içinde çıplak `4`): taban değer ile
  keyframe'in AYNI değerlere inebilmesi gerekir. Tek kaynak: `VOLUME_DECIMALS`.
- **[ORTA] "+N" çipinin üstünde imleç `ew-resize` oluyordu** (altındaki elmas
  vurgulanıyordu) ama basınca sürükleme başlamıyordu — çip artık hem hover hem çift tık
  hem sağ tık yolunda önce test ediliyor.
- **[YÜKSEK] 3+ animasyonlu kanalda easing ve zamanda taşıma ERİŞİLEMEZDİ.** Şerit en fazla
  2 satır çizer; easing'in tek UI'ı şeritteki sağ tıktı. İki yüzey eklendi: Inspector'da
  kanal başına easing seçici (playhead keyframe üstündeyken) ve "+N" çipinin kanal menüsü
  (seçilen kanal şeritte satır alır → sürükle/çift tık/sağ tık geri gelir). Menüler artık
  pencereye SIKIŞTIRILIYOR (`menuPosition.ts`): Inspector sağ sütunda olduğu için menü
  viewport dışına taşıyor ve gerçek fareyle tıklanamıyordu.

### M5'te açık bırakılanların bugünkü durumu (compiler/trim sahibi kapattı)

- **[YÜKSEK — KAPANDI, teslim düzeltme turu] Frame-ızgarası sözleşmesi kendi içinde
  çelişkiliydi.** Compiler her klipte HEM `timelineStartUs` HEM `timelineDurationUs` için
  ızgara hizası istiyordu; ama 25 fps dışında ızgara toplama altında KAPALI DEĞİLDİR
  (30 fps: frame 1 = 33_333 µs, frame 2 = 66_667 µs, 33_333 + 33_333 = 66_666 ızgarada yok).
  Sonuç: BİTİŞİK klip zinciri (geçiş sözleşmesinin şartı) iki kuralı aynı anda sağlayamıyordu;
  30 fps'te kenarları ızgarada olan 144 klip kombinasyonundan **32'si (%22)** ızgara dışı süre
  üretiyordu. Kapsam yalnız kırpma değildi: **bölme** ve **asset ekleme** de bir SÜREYE karar
  verdiği için aynı kapıya çarpıyordu.
  **Düzeltme, 1. tur:** (a) compiler kapısı kenarlara alındı — `ExportCompiler.Validate` (frame ızgarası kapısı),
  artık `timelineStartUs` VE `timelineStartUs + timelineDurationUs` denetleniyor, hata metni
  *"clip … edges are not on the project frame grid"*; (b) editör süreyi kendi başlangıcına göre
  TAM KARE seçiyor (`packages/timeline-schema/src/time.ts`: `frameSpanUs`, `frameSpanCount`,
  `snapDurationToFrameSpan`, `floorDurationToFrameSpan`, `isClipOnFrameGrid`).
  **2. tur (1. tur denetimde RED aldı — iki gerçek boşluk):** (c) *kırpma niceleme hatası* —
  sağ tutamağı kaynağın sonuna kadar çekmek süreyi `min(hedef, kaynak süresi)` ile kırpıyordu
  ve kaynağın süresi bir kare sınırı DEĞİLDİR; her kırpma artık sabit kenardan sayılan bir tam
  kare aralığı seçiyor (`fitFrameSpan`/`fitSpanFromStart`/`fitSpanToEnd`, `timelineOps.ts`) ve
  kaynak tavanı da kare aralığına yuvarlanıyor. (d) *kapı yerleşimi* — kapı, op
  sarmalayıcılarının sonuna elle yazılan `assertDocValidDev` satırlarıydı; kırpma sürüklemesi,
  gizmo ve Inspector slider'ı `beginTransaction → tx.update → commit` yolundan geçtiği için
  kapıya HİÇ uğramıyordu (gerçek fare, birim testlerin reddedeceği dokümanı yazabiliyordu).
  Kapı artık **commit noktasında**: `docStore.assertDocGateDev`, her `mutate`/`commit` sonrası
  `validateTimelineDoc` + `exportFrameGridIssues`, yalnız `import.meta.env.DEV` altında.
  Kanıt: `e2e/frame-grid.spec.ts` (gerçek fare + ölçülmüş ızgara dışı kaynak → export 202).
  Kullanıcı anlatımı: [`docs/poc-bilinen-sinirlar.md`](poc-bilinen-sinirlar.md) **§1.2**
  (eski metinde yanlışlıkla "§1.1" yazıyordu).
- **[ORTA — KAPANDI, 2026-08-24 yarim-is turu] Inspector'ın "ripple'sız en yavaş hız" sınırı
  yarım kare eksikti.** `clipInspectorModel.minRateWithoutRipple` sınırı İDEAL süreden
  türetiyordu (`(sourceOut − sourceIn) / (süre + boşluk)`, sonra 3 ondalığa yukarı yuvarlama);
  ızgara çözümü ideali uygulamadığı için panelin önerdiği oran reddedilebiliyordu.
  **Ölçüm düzeltmesi:** bu kaydın eski metnindeki frame 2 → frame 4 geometrisi aslında KABUL
  edilen vakadır (oda 66_666 µs; `speedColorOps.test.ts` *"fills the room ... EXACTLY"* bunu
  sabitler). Ret, bir faz ötede ÜREDİ ve teste döküldü: klip faz-0 karede (frame 0, 1 kare
  kaynak = 33_333 µs), sonraki klip frame 2'de (66_667 µs) → oda 66_667 µs; panel 0.5x
  öneriyordu, 2 karelik sürede 0.5 için tam sayılı kaynak aralığı YOK (pencere
  [33_333.25, 33_333.75) boş), çözücü 3 kareye (100_000 µs) yürüyor, op "sonraki klibe
  giriyor" diyordu. **Düzeltme:** sınır artık op'un KENDİ planlayıcısından türetiliyor —
  `timelineOps.minSpeedRateWithoutRipple`: ideal formül yalnız ÇAPA, her aday
  `planClipSpeed`'in kendisiyle yargılanıyor (ızgara çözümü + tek-kare tabanı + asset süresi
  tavanı + yerleşim denetimi; İKİNCİ aritmetik kopyası yok, kâhin op'un fonksiyonu), çapadan
  yukarı/aşağı sınırlı yürüyüşle BİTİŞİK kabul bandının alt kenarı bulunuyor. Panel modeli
  op'la aynı `knownAssetDurations()` haritasını alıyor (`buildClipInspectorModel` 5. parametre).
  Sözleşme iki yönlü testle sabit: önerilen oran KABUL, bir ızgara adımı yavaşı RET — backlog
  vakası (0.498 kabul / 0.497 ret / formülün 0.5'i delik), asset-tavanlı vaka, çoklu seçim ve
  30/29.97/24 fps'te 144 ızgara-kritik geometrinin taraması (`speedColorOps.test.ts`
  "minRateWithoutRipple ↔ setClipSpeed"). Gerçek girdi kanıtı: `e2e/speed-color.spec.ts`
  "yarım kare vakası" — gerçek fare/klavyeyle kurulan bir karelik klip + bir karelik boşlukta
  panel 0.498x yazıyor, klavyeyle 0.497 RET (panelde gerekçe), 0.498 KABUL (klip odaya tam
  yaslanıyor). Negatif kontrol: düzeltme geri alınınca 10 yeni/güncel test kırmızı, geri
  konunca md5 birebir.

## POC dokümantasyon turunda kayda geçenler (2026-08-12)

Kapsam tablosunun satır satır kod doğrulaması sırasında bulunan, daha önce **hiçbir yerde
yazılı olmayan** sınırlar. Hepsi kullanıcıya
[`docs/poc-bilinen-sinirlar.md`](poc-bilinen-sinirlar.md) ile anlatıldı.

### [YÜKSEK — KAPANDI, teslim düzeltme turu] Görsel/sticker klipleri ÖNİZLEMEDE çizilmiyordu

Zincir üç yerde birden tutarsızdı ve hiçbir test bunu yakalamıyordu:

1. `ProcessAssetJob.ProcessImageAsync` — görsel asset için **proxy üretilmez** (yorum bunu
   açıkça söylüyor); yalnız `ThumbnailKey` (poster) yazılır. *Bu hâlâ böyle; değişen, önizleme
   tarafının ne istediğidir.*
2. `Api/Endpoints/AssetMediaUrlBuilder.cs` — dolayısıyla `media-urls` görsel için
   `proxy: null` döner.
3. `features/player/PlayerPanel.tsx` — oynatıcı çözücüsü KOŞULSUZ `proxyUrl` okuyordu →
   `url = null` → `engineV1.ts`'in `imageDrawItem`'ı hiçbir şey çizmeden dönüyordu.

**Düzeltme.** Kaynak seçimi asset KIND'ına göre karar veren tek bir saf fonksiyona alındı:
`apps/editor/src/features/player/previewSource.ts` (video/ses → `proxy`, görsel → `poster`);
`PlayerPanel.tsx` (`previewSourceUrl(asset)` çağrısı) bunu çağırıyor. Poster her hazır görselde zaten var, `PosterRecipe`
genişliği 1280 px'e sınırlıyor ve HDR'de proxy/export ile aynı tonemap zincirini koşuyor.
Sticker'ın ayrı vakası yok — karar klip türüne değil ASSET türüne göre veriliyor.

**Kanıt — piksel.** `apps/editor/e2e/image-preview.spec.ts`: gerçek fare + worker'ın gerçekten
işlediği iki görsel; önizleme kompozitöründen `probePixel` (çizimle aynı karede `gl.readPixels`)
ile okuma. 25/25 nokta siyah değil, ≥ 4 farklı renk (düz dolgu yanlış-pozitifini keser),
letterbox bandı hâlâ siyah, macenta PNG macenta okunuyor, overlay'e eklenen çıkartma fotoğrafın
üstünde görünüyor. Birim tarafı: `previewSource.test.ts`.

**Aynı düzeltmede kapandı:** görsel klip eklemek doküman değişmezini ihlal ediyordu
(`sourceOutUs (4000000) exceeds asset duration (…)`). API görsel süresini PNG'de `null`,
JPEG'de `40000` µs bildiriyor — yalnız `null`'a bakan bir düzeltme JPEG'i kaçırırdı.
`knownAssetDurations()` artık görselleri haritaya hiç koymuyor
(`timelineOps.knownAssetDurations`) ve sayı olmayan `durationUs` değerlerini düşürüyor.

**Neden test yakalamamıştı.** `e2e/transitions-image.spec.ts` ve `ExportImageTransitionTests`
doküman durumunu ve export tarafını doğruluyordu; **hiçbir test görsel klibin oynatıcı tuvaline
çizildiğini kontrol etmiyordu**. Golden-frame paketi de export tarafındadır.

### [KAPANDI, 3. tur denetimi] "Desteklenmeyen bileşim kuyruğa hiç girmez" vaadi YANLIŞTI

Baş mimar 3. turda **iki bileşimin export isteğinde 202 alıp canlı worker'da `failed`
olduğunu ölçtü**; README ve `poc-bilinen-sinirlar.md` §3 ise "kuyruğa hiç girmez, 422 ile
gerekçe döner" diyordu. **Ortak kök neden tek cümleyle:** bazı derleyici kuralları
`ExportCompiler.Validate`'te değil `Compile`/raster aşamasında yaşıyordu ve API'nin 422 ön
kapısı (`ExportEndpoints.StartExport`) yalnız `Validate`'i çağırıyor — dolayısıyla o kurallar
ön kapıda **görünmüyordu**.

| Kural | Eskiden | Şimdi |
|---|---|---|
| Overlay katman tavanı 8192 px (metin/şekil) | yalnız `Compile` (`PlacementOf`) → 202 + worker'da düşüş | `Validate` içinde `EnsureRasterFits` → **422 `overlay-too-large`**; şekilde kutu kesin, metinde ölçüm varsa gerçek bbox yoksa font-bağımsız **alt sınır**; `Compile` kapısı yedek olarak duruyor |
| Geçişli kliplerin yerleşim eşitliği | yalnız `Compile` → 202 + worker'da düşüş | **doküman değişmezi** (`invariants.checkTransitionPlacement`) + editör yayılımı (`propagateTransformToChain`, `alignTransitionChainTransforms`); *(3. turda `Compile` kapısı yerinde bırakılmıştı — 6. turda `Validate`'e alındı, aşağıya bkz.)* |

**Neden ikisi o turda farklı çözüldü.** Overlay tavanı sunucunun tek başına karar
verebileceği bir şeydir (bbox ölçülebilir) → ön kapıya taşındı. Yerleşim eşitliği ise bir
**doküman sözleşmesidir** (`rendering-semantics.md` §5.2): kullanıcıya 422 göstermek yanlış
ürün kararı olurdu — editör yerleşimi geçiş zincirine yayar, kullanıcı hiçbir hata görmez.
O tur, sunucudaki kuralı `Compile`'da bırakmakla yetindi.

**[KAPANDI, 6. tur] Yerleşim eşitliği de `Validate`'e taşındı.** Yukarıdaki "açık kalan"
madde kapandı: kapı `ExportCompiler.EnsureTransitionPlacement`'tır, hesap saf doküman
aritmetiğidir (`LayerGeometry.Compute` yalnız transform + proje tuvali okur), dolayısıyla
API'nin ön kapısı onu görür ve ham API'ye doğrudan yazılmış belge de **senkron 422** alır.
`Compile`'daki dal aynı fabrika metodunu çağıran sigorta olarak kaldı — iki kapının mesajı
bayt-aynıdır. Kullanıcı yüzeyi DEĞİŞMEDİ (editör hâlâ yayar, kimse hata görmez); değişen,
API'ye doğrudan yazan istemcinin dakikalar sonra değil **anında** cevap almasıdır.
Bu düzeltme üç teslim dokümanına da işlendi (README dışa aktarma maddesi,
`poc-bilinen-sinirlar.md` §3 + §4.7, `rendering-semantics.md` §5.2 "nerede uygulanır").

**Metin tarafında bir NÜANS eklendi (6. tur).** "Metinde ölçüm varsa gerçek bbox, yoksa
font-bağımsız alt sınır" satırı hâlâ geçerlidir, ama tek başına eksikti: ölçer KAYITLI olup
ölçüm BAŞARISIZ olduğunda istek artık sessizce geçmez, tipli **503 `text-measure-unavailable`**
ile durur (kusur belgede değil kurulumdadır — 422 yanlış olurdu). Gerekçe ve ölçüm:
`poc-bilinen-sinirlar.md` §3.3.

### Diğerleri (düşük/orta)

- **Track yeniden sıralama / yeniden adlandırma** — ✅ **KAPANDI (2026-08-21)**:
  `timelineOps.moveTrack('up'|'down')` + `renameTrack` (tek kapı disiplini, kendi
  `*BlockReason`'ları, Türkçe undo etiketleri). UI: track sağ tık menüsünde
  `Yeniden adlandır / Yukarı taşı / Aşağı taşı`, başlığa çift tıkla satır içi input
  (Enter kaydeder, Escape vazgeçer). `tracks[0] = en üst katman` sözleşmesi korunuyor:
  önizleme yarısı `resolveVisualStack` testiyle, export yarısı reorder öncesi/sonrası
  `ExportCompiler.Compile` filtergraph karşılaştırmasıyla ÖLÇÜLDÜ (en üste bindirilen
  kaynak yer değiştirir). Gerçek-fare e2e: `e2e/track-manage.spec.ts` (negatif dahil:
  en üst track'te "Yukarı taşı" gri, `track already at the top`). Sürükle-bırak
  sıralama BİLİNÇLİ ertelendi: başlık sütununda ayrı bir pointer/çizim altyapısı
  isterken menü aynı op'u sıfır yeni jest maliyetiyle sunuyor; talep gelirse op hazır.
- **Ölçek animasyonu + dönme bileşimi** (`scale-keyframes-with-rotation`) — editör
  ÖNDEN engelliyor (bu dalgada yeniden ölçüldü, `guardPaths.test.ts` (b) bloğu +
  Inspector `clip-rotation-block` rozeti): dönük klipte ölçek kanalı, ölçek animasyonlu
  klipte dönme alanı/kanalı kapalı ve gerekçeli. 422 kapısının durduğu
  `ExportGateInventoryTests` koşumuyla doğrulandı (2026-08-21, 104/104).
- **Keyframe örnek bütçesi 60 000** — ✅ **editör önden uyarıyor (2026-08-21)**:
  `MAX_KEYFRAME_SAMPLES` + `keyframeSampleUpperBound` şema paketine eklendi
  (derleyicinin `EnsureSampleBudget` aritmetiğinin ÜST SINIR ikizi: eğrili görsel
  kanallar kare×1, scale kare×2, opacity/volume lineerken de sayılır) ve Inspector
  %80'de rozet basıyor (`clip-kf-budget-warning`). Kestirim bilinçli üst sınırdır —
  uyarı 422'den önce yanar, hiç geç kalmaz.
- **Katman boyut tavanı 8192 px** — ✅ **dönme boşluğu KAPANDI (2026-08-21)**: editörün
  tavanı artık derleyici gibi ARA TUVALDEN hesaplanıyor (`invariants.maxScaleForFit` +
  `intermediateCanvasLongSidePx` — `LayerGeometry.Compute` defterinin birebir ikizi:
  dönmede köşegen `ceilEven(hypot)`, merkez dışı çapada `ceil(box·2·max(a,1−a))` pad'i).
  1080p 45°'de tavan 4.266→3.718; dönme yazımı mevcut ölçeği taşırırsa op ölçeği tavana
  indirir ve `scale clamped by rotation canvas` bildirimi düşer. Kanıt: şema testleri
  (126 kombinasyonluk güvenli+maksimal tarama), `guardPaths.test.ts` (a2) op taraması,
  gerçek-klavye e2e (`inspector.spec.ts` dönme-tavan testi). Dönük METİN tavanı güvenli
  tarafta KONSERVATİF (√2·pad çarpanı worst-case; kutu oranına göre kesin ters çözüm
  yapılmıyor — asla 422'lik değer önermez, bazen gereğinden düşük önerir).
- **Tek export profili** — ✅ **KAPANDI (dalga 2, 2026-08-21)**: `ExportProfiles.cs` artık
  1080p/720p/2160p(4K)/dikey (1080×1920) tanır; profil, bitmiş tuval kompozisyonunu kendi
  hedef kutusuna ölçekler (yalnız AYNI en-boy oranında — farklı oran tipli 422
  `export-profile-aspect`, letterbox BİLEREK yok; ölçülen gerekçeler `ExportProfiles.SpecFor`
  yorumunda). ExportDialog profil seçicili; uyumsuz profil yerinde devre dışı + Türkçe neden.
  Gerçek render kanıtları: `ExportProfileGoldenTests` (720p küçültme / 4K büyütme / dikey;
  ffprobe boyut + SAR 1:1 + yuv420p + BT.709/tv tam takım + içerik geometrisi ±referans).
  KAPSAM DIŞI: 16:9/9:16 dışı tuval (yalnız ham API kurabilir) hiçbir profile uymaz —
  `poc-bilinen-sinirlar.md` §3'teki satırında beyanlı.
- **Ses klibinde görsel keyframe / renk efekti reddediliyor**
  (`ExportCompiler.ValidateClip`: `keyframes-audio-clip`, `effects-audio-clip`) — doğru
  davranış, editörde önden engellenmiyor.

## M6 (Dayanıklılık / hardening)

> **M6 TESLİM EDİLDİ ama bu listeden HİÇBİRİ değil.** M6 dilimi iki başka maddeyi kapattı:
> **sürüm geçmişi UI'ı** ve **kota/silme UX'i** (yukarıdaki kapsam kaydı). Aşağıdaki maddelerin
> hepsi **HÂLÂ AÇIKTIR** — her biri bu turda yeniden kodda doğrulandı:

| Madde | Doğrulama (2026-08-12) |
|---|---|
| `fx.*` keyframe'i | `packages/timeline-schema/src/schema.ts` `KeyframeTracksSchema` hâlâ STRICT, 6 kanal |
| LUT editör yüzeyi **+ önizleme shader'ı** | ✅ **KAPANDI (2026-08-21)**: `SUPPORTED_EXTENSIONS` artık `.cube` içeriyor; §4.2'nin NORMATİF uniform'ları kodda (`compositor/shaders.ts` — katman + geçiş programı) ve `resolve.lutOf` lut efektini okuyor. Kanıt: `e2e/lut.spec.ts` (gerçek fare, piksel + parite ölçümü) + `poc-bilinen-sinirlar.md` §1.3 |
| Revision retention job | `backend/src/VideoEdit.Worker/Program.cs` (`AddOrUpdate<AssetReaperJob>`) — kayıtlı tek yinelenen iş `asset-reaper` |
| Container hardening | ✅ **KAPANDI (2026-08-21)**: iki Dockerfile'da da `USER app` (UID 1654); worker `/data` USER'dan önce `chown app:app`; iki imaj da yerelde build edilip `id` ile ölçüldü (yeni: `uid=1654(app)`, HEAD'deki Dockerfile ile build edilen negatif kontrol imajı: `uid=0(root)`). Seccomp profili + ffmpeg CPU kaynak sınırı HÂLÂ AÇIK (denetim #35'in kalan yarısı) |
| Per-device logout | ✅ **KAPANDI (2026-08-21)**: logout artık `POST /api/auth/refresh/logout` (cookie path'inin altında — httpOnly refresh cookie'sini GÖREBİLEN tek yer) ve yalnız o cihazın token'ını iptal ediyor (`IRefreshTokenService.RevokeAsync`); `RevokeAllForUserAsync` theft-response + gelecekteki şifre değişimi için duruyor. Testler: `RefreshTokenServiceTests` (öteki cihaz rotasyona devam eder) + `LogoutEndpointTests` (gerçek Cookie başlığı). 14. tur triyajı (2026-08-21): logout'la iptal edilen token HALEFSİZDİR — replay'i artık theft cascade'i TETİKLEMEZ, düz 401 döner (`RefreshFailure.Revoked`); theft cascade yalnız ROTASYONLA iptal edilmiş (halefi olan) token'ın replay'inde çalışır. Logout'la yarışan uçuştaki refresh de aynı ayrımdan geçer (atomik claim 0 satır görünce taze satırdan halef bakılır) |
| Dockerfile restore (sln üyesi tüm csproj) | ✅ **KAPANDI (2026-08-21)**: iki Dockerfile'ın restore katmanına SchemaGen + UnitTests csproj'ları eklendi (8/8 sln üyesi); iki imaj da bu katmanla build edildi |
| `tsconfig.node.json` tip denetimi | `.github/workflows/ci.yml` ve `apps/editor/package.json` içinde geçmiyor (`build` = `check-public-assets` + `tsc -b` + `vite build`) |

- **fx.\* keyframe'i** (colorAdjust/LUT parametrelerinin animasyonu): şema `KeyframeTracks`
  STRICT olduğu için doküman düzeyinde de yok; kanal listesi + örnekleme + compiler ifadesi
  birlikte açılmalı (M5 kapsam kaydı).
- **LUT (.cube) editör yüzeyi + önizleme shader'ı**: ✅ **KAPANDI (2026-08-21)** — iki iş
  kalemi birlikte teslim edildi: (1) `.cube` yükleme yolu (`AssetKind.Lut`,
  `application/x-cube-lut`, worker `CubeLutValidator` — probe/türev yok) + Inspector LUT
  bölümü; (2) WebGL2 3D doku örneklemesi (`sampler3D`, `uLut3D/uLutScale/uLutOffset/uIntensity`,
  trilinear — §4.2 birebir; geçiş programında taraf başına). Önizleme↔export paritesi ölçüldü
  (SSIM 0,99424 / kanal ort 1,603 — `e2e/lut.spec.ts`).
- **Revision retention job**: plandaki "son 50 auto + eskilerde inceltme" (denetim #5).
- **Container hardening**: non-root `USER app` + volume sahipliği; worker için ayrıca seccomp/ffmpeg kaynak sınırları (denetim #35).
- **Per-device logout**: mevcut logout tüm cihazların refresh token'larını iptal ediyor — cihaz bazlı oturum yönetimi (denetim #30).
- **Snapshot'ın autosave ile aynı transaction'a alınması** değerlendirmesi: bugünkü tasarım "kaçan snapshot bir sonraki save'de telafi edilir" kabulüyle yaşıyor (denetim #29).
- **Dockerfile restore aşaması sln-üyesi tüm csproj'ları kopyalamalı** (SchemaGen/UnitTests) — bugün zararsız, sln-scoped restore'a geçilirse patlar (denetim #34).
- **apps/editor `tsconfig.node.json` tip-denetimi** build zincirine eklenmeli (denetim #36).

## M1 denetiminden ertelenenler (2026-08-07, 37 bulgu; kritik+yüksek tümü M1'de düzeltildi)
- **M2 IDOR regresyon paketi**: ✅ **KAPANDI (2026-08-24, yarım-iş #6)** —
  `CrossUserAccessTests`: kurban A + saldırgan B kurgusuyla 24 kimlik-doğrulamalı ucun TAMAMI
  için sahiplik testi (proje CRUD + timeline PUT + revisions/restore, asset upload yaşam
  döngüsü + media-urls/usage/sil, export başlat/listele/izle/iptal, quota). Her test yalın
  404 (kaynağın varlığı sızmaz) + kurban durumu değişmedi + depo sahtesi HER çağrıda
  fırlatarak "reddedilen istek S3'e/presign'a hiç dokunmadı" kanıtı. TAMLIK MUHAFIZI
  (`CrossUserEndpointInventoryTests`, ExportGateInventoryTests defter deseni): rota tablosu
  el yazısı liste değil — ürünün `Map*Endpoints` metotları refleksiyonla keşfedilip boş
  WebApplication'da koşturulur; her uç ya cross-user testinde ([Fact] varlığı refleksiyonla
  doğrulanır) ya gerekçeli muaf listesinde (id parametreli uç muaf OLAMAZ) ya bilinçli-anonim
  defterinde. Program.cs kaynak taraması satır-içi rota kaçağını kapatır. Üç negatif kontrol
  (md5 birebir geri): GetJob sahiplik filtresi gevşetildi → 2 test kırmızı (presign sızıntı
  imzasıyla); yeni `/steal` ucu eklendi → muhafız kırmızı; quota'dan RequireAuthorization
  düşürüldü → muhafız anonim dalda kırmızı.
- **M2 (devam)**: SignalR progress kanalı gelince `refetchIntervalInBackground` geçici
  çözümü kaldırılacak.
- **M6**: Kota kontrolü check-then-act (bilinçli MVP kabulü) — eşzamanlı init'lerle sınırlı aşım mümkün; transactional/advisory-lock çözümü. Upload resume sertleştirme: dosya-değişti tespiti (ilk 1 MiB parmak izi), IndexedDB hayalet satırlarının tam yaşam döngüsü, FileSystemFileHandle akışı.
- **Not (KAPANDI, teslim düzeltme turu 2026-08-12)**: E2E/ölçüm fixture'ı 122 MB ile
  `apps/editor/public/` altında duruyordu ve `vite build` onu `dist/`e kopyalıyordu (üretim
  bundle'ına sızma). "Sürüm build'i öncesi silinmeli" notu bir SÜREÇ dilekçesiydi, kapı değildi.
  Düzeltme: dosya `apps/editor/e2e/fixtures/media/` altına taşındı (Playwright dosyayı
  YOLDAN okur, sunucudan değil) ve `apps/editor/scripts/check-public-assets.mjs` bekçisi
  `build` script'inin ilk adımı yapıldı — `public/` altında medya uzantılı ya da 1 MB'ı aşan
  bir dosya varsa build gerekçesiyle DURUR.

## M2 denetiminden ertelenenler (2026-08-07, 33 bulgu; 4 kritik + 6 yüksek + tüm ortalar M2'de düzeltildi)
- **Düşük öncelikli 12 bulgu** ertelendi — tam liste `docs/audits/m2-denetim.json` içinde (tüm milestone denetim raporları artık `docs/audits/` altında arşivleniyor).
- **Teslimat-anı görsel doğrulama borcu**: playback'in görsel/işitsel doğrulaması ve gerçek pointer ile library sürükle-bırak, gizli tarayıcı panelinde yapılamadı (rAF duraklı + untrusted gesture) — görünür panelde/kullanıcı testinde doğrulanacak; M3 golden-frame CI'ı görsel tarafı kalıcı güvenceye alacak.

## M3 denetiminden ertelenenler (2026-08-07, 25 bulgu; yüksek+orta tümü M3'te düzeltildi)
- **M4**: OfflineAudioContext tabanlı ses parity testi (rendering-semantics §9.3 — micro-fade/gain zincirinin preview↔export RMS karşılaştırması). Editör↔compiler kapsam haritasının UI'da gösterimi (hangi özellik hangi milestone'da export edilebilir — 422 mesajlarının ötesinde proaktif rozet).
- **Sürekli**: API DTO'ları için C#→TS tip üretimi (timeline-schema'daki desenin API kontratlarına genişletilmesi) — FE/BE alan-adı drift sınıfını (M3'te yakalanan error/errorMessage vakası) CI'da kalıcı önler.
- **Düşük öncelikli 8 bulgu**: `docs/audits/m3-denetim.json`.

## 4. tur denetiminden ertelenenler (2026-08-12, dejenerelik kapısı)

- **Editörde ölçek TABANI (kaynak-bağımlı `minScale`)** — *bilinçli olarak ertelendi, review-gate
  kural 4 gereği buraya yazıldı.* Bu turda kapatılan `degenerate-layer` kuralı **sunucu tarafında**
  yaşıyor: kaynak boyutu DB'den biliniyorsa `POST /exports` **senkron 422** döner (iş kuyruğa hiç
  girmez), worker'da da ffprobe boyutuyla tipli hata verir. Editör ise ölçek alanının tabanını
  hâlâ sabit `0.01`'de tutuyor — yani kullanıcı reddedilecek belgeyi **yazabiliyor** ve hatayı
  ancak "Dışa Aktar"a bastığında görüyor.
  - *Yapılacak:* `packages/timeline-schema/src/invariants.ts`'e `maxScaleFor`'un simetriği olan
    `minScaleForSourcePx(fitW, fitH, srcW, srcH)`; `state/timelineOps.ts`'te clamp;
    `clipInspectorModel.ts` → `VisualSection.minScale` ("en katı kazanır"); `ClipPropertiesPanel`
    ölçek alanının `min`'i + limit notu; gizmo `clampScale`'e taban. Kaynak boyutu zaten
    istemcide var (`assetStore` `AssetSummary.width/height`; gizmo onu bugün de okuyor).
  - *Neden bu turda YAPILMADI (üç gerekçe):* (1) **kapatıcı sunucu kapısıdır** — istemci tabanı
    tek başına yeterli olamaz, çünkü asset probe'u gelmeden (yükleme sürerken) ya da belge başka
    bir istemciden geldiğinde taban bilinmez; (2) kural o zaman **üç kopyada** yaşar (C#
    `LayerGeometry`, TS `invariants`, ön kontrol) — `MAX_LAYER_DIMENSION`'ın bugünkü "iki değer
    eşit kalmalı" borcunu üçe çıkarır ve bu borç ayrı bir dilim olarak ödenmelidir; (3) istemci
    tabanı, "POST'un kendisi 422 döner" iddiasının **gerçek fare e2e'siyle kanıtlanmasını
    imkânsız** kılardı (belge hiç kurulamazdı) — kapı önce kanıtlanabilir olmalı.
  - *Bugünkü etkisi (5. tur ölçümüyle GENİŞLETİLDİ).* Kuralın **kaynak-oranı** yarısı gerçekten
    yalnız **19:1'den geniş / 1:11'den dar** kaynaklarda görünür. Ama ikinci yarısı — kutunun bir
    ekseninin **2 pikselin altına** inmesi — **her katman türünde ve ölçek ANİMASYONUYLA
    ulaşılabilir**: metin/şekil klibinde `bbox × en küçük keyframe` doğrudan kutuyu verir
    (ölçüldü: bbox `223×104` @ `0.010` → `2×1`; bbox `6×20` @ `0.010` → `0×0`). Yani "normal
    medyada değişiklik yok" cümlesi **statik** ölçek için doğru, **animasyonlu** ölçek için
    değil.
  - *Kullanıcı bunu ÖNCEDEN BİLMİYOR — bu bir kabul, gerekçe değil.* Ne Inspector ölçek alanının
    tabanı (`0.01`) ne de keyframe editörü bu sınırı gösterir; **dışa aktarma penceresi de istek
    ATILMADAN önce hiçbir uyarı vermez** (`ExportDialog.tsx`: tek `role=alert` yalnız istek
    başarısız olduktan sonra basılır, düğme yalnız gönderim sürerken devre dışı). Kullanıcı
    sınırı ilk kez 422 mesajından öğrenir. Teslim notlarında "kullanıcı önden korunuyor"
    denemez; korunan tek şey **sessiz bozulmanın olmaması**dır.
  - *Ek yapılacak (bu turda doğdu):* ölçek **keyframe'i** de aynı tabana kırpılmalı — yalnız
    statik alana taban koymak animasyonlu yolu açık bırakır.

## 5. tur denetiminden ertelenenler (2026-08-12, doküman/yorum turu)

- **[KAPANDI — yarim-is #12, 2026-08-24] `GenerateDocumentationFile` kapalı: XML yorumları
  derleyici tarafından hiç denetlenmiyor.** *(Kapanış ayrıntısı bu maddenin sonundadır;
  aradaki ölçümler tarihsel kayıttır.)* Bu turda kapatılan F-1 bulgusu (bir `<summary>` bloğu YANLIŞ ÜYEYE yapışmıştı;
  o üye iki `<summary>` taşıyor ve sahip olmadığı parametrelere `paramref` veriyordu, `Validate`
  ise dokümansız kalmıştı) **derleme uyarısı üretmiyordu**, çünkü bayrak kapalı.
  - *Ölçüm (6. turda YENİDEN alındı; ağacın `git ls-files` kopyası scratchpad'e çıkarılıp orada
    derlendi, yani repo'nun `obj/bin`'ine dokunulmadı):*
    `dotnet build backend/src/VideoEdit.Media/VideoEdit.Media.csproj -p:GenerateDocumentationFile=true`
    → MSBuild özeti **244**, ama **benzersiz** (dosya, satır, sütun, kod) uyarı **229**. İki sayı
    farklıdır çünkü MSBuild aynı uyarıyı birden fazla hedefte tekrar sayar; anlamlı olan
    benzersiz olandır. Dağılım: **215 CS1591** ("public üyede XML yorumu yok") + **14 CS1573**
    (bir üyenin parametrelerinin bir kısmı belgelenmiş, kalanı değil). **CS0419 = 0, CS1574 = 0.**
    CS1591'in 68'i bağımlılık projesi `VideoEdit.Contracts`'tandır (bayrak ona da uygulanır),
    147'si `VideoEdit.Media`'dır.
    > Bir tur önce buraya "252 uyarı → CS1591 susturulunca 21 kalıyor, içinde CS0419 var,
    > 6 dosyaya yayılıyor" yazılmıştı. Bu turun ölçümü o sayıları TUTMADI; sayı ağacın
    > durumuna bağlıdır ve alıntılanmadan önce yeniden koşulmalıdır.
  - *Gerçek sinyal 14 satır, 4 dosya:* `ClipAnimation.cs` (8), `Easing.cs` (2),
    `FfmpegRunner.cs` (2), `SkiaOverlayRasterService.cs` (2). Hepsi bu iş diliminin dışında.
  - *Bu turda kapatılan REGRESYON.* Aynı ölçüm 6. tur düzeltmeleri yazıldıktan HEMEN SONRA
    **266 / 251 benzersiz** veriyordu: **36** CS1591-dışı uyarı, **7** dosya, içinde **2 CS0419**
    ve **3 CS1574**. HEAD (`d9f045f`) ile aynı ölçüm 14/4 verdiği için fark birebir bu diffin
    ürünüydü: `ExportCompiler.cs` 14, `CompiledExport.cs` 7, `ExportAssetFacts.cs` 1 = **22**.
    Hepsi bu doküman turunda kapatıldı (yalnız XML yorumu düzenlendi, kod davranışı değişmedi):
    eksik `<param>` blokları yazıldı, çözülemeyen `cref`'ler (`Domain.AssetKind`, `Validate`)
    düzeltildi, belirsiz `LayerGeometry.Compute` cref'i imzayla ayrıştırıldı. Yani "export
    geometrisi tarafı temiz" cümlesi ancak ŞİMDİ doğrudur ve ölçümü yukarıdadır.
  - *YAPILDI (yarim-is #12, 2026-08-24, HEAD `307b156` üzerinde).* Önce YENİDEN ölçüldü
    (tüm 6 src projesi, `-p:GenerateDocumentationFile=true` + ayrı `BaseOutputPath`,
    benzersiz dosya+satır+sütun+kod): **443** = **404 CS1591** (Api 24, Contracts 68,
    Domain 99, Infrastructure 48, Media 151, Worker 14) + **32 CS1573** + **7 CS0419**
    (CS1572 = CS1574 = 0). Eski "14/4 dosya" ve "~21+~230" sayıları TUTMADI — kural bir kez
    daha doğrulandı: sayı alıntılanmadan önce yeniden ölçülür. CS1573 dağılımı:
    `ClipAnimation.cs` 10, `ExportEndpoints.cs` 8, `FfmpegRunner.cs` 5,
    `OriginalDownloader.cs` 4, `Easing.cs` 2, `SkiaOverlayRasterService.cs` 2,
    `UploadQuota.cs` 1; CS0419'un 7'si de `ExportCompiler.cs`'teki `cref="Compile"`
    (profil/spec overload'ları arasında belirsiz).
    - **39 yapısal uyarının tamamı kapatıldı** — tek yolla, tutarlı: eksik parametreler
      GERÇEKTEN belgelendi (içerik koddan türetildi; `<remarks>`e çevirme yolu bilinçli
      REDDEDİLDİ çünkü tam da bu dilimin kurduğu denetimi — derleyicinin param-adı bağını —
      silerdi); belirsiz `Compile` cref'leri imzayla ayrıştırıldı (bağlantı metni `Compile`
      kaldı, cümleler bozulmadı). Davranış değişikliği SIFIR: diff yalnız XML yorumları +
      yeni props dosyası.
    - **Mekanizma: `backend/src/Directory.Build.props`** (kök değil, BİLEREK `src/` altı:
      tests/tools kapsam dışı — orada açmak ölçüldü, 24 CS1573 + 1 CS1574 + 2 CS1570 +
      2 CS1587 + ~902 CS1591'lik test-iskelesi borcu açardı; tüketicisi olmayan yüzey, bu
      dilimin sınırlı kapsamı dışında). İçerik: `GenerateDocumentationFile=true`,
      `NoWarn CS1591` (404 şablon özet gerekçe kaydına değer katmaz — gerekçesi props
      yorumunda) ve **yapısal küme `WarningsAsErrors`**: CS0419, CS1570, CS1572, CS1573,
      CS1574, CS1587. Bu küme sayesinde ihlal `-warnaserror` BEKLEMEDEN, CI'daki sade
      `dotnet build backend/VideoEdit.sln` adımında da hatadır → **F-1 sınıfı hata artık
      derlemede yakalanır ve 22'lik regresyon sessizce GİREMEZ** (ci.yml değişmedi; Docker
      publish de `COPY . .` ile props'u alır).
    - *Bilinen ve kabul edilen yan etki (ölçüldü):* .NET 10'un
      `Microsoft.AspNetCore.OpenApi` source generator'ı XML yorumlarını artık görür →
      YALNIZ dev'de map edilen `/openapi/v1.json` özet metinleri kazanır. Üretim
      `MapOpenApi` çağırmaz, hiçbir test o belgeyi okumaz, generator'ın MSBuild kapatma
      anahtarı yok (paket DLL'i tarandı) — kabul edilip props yorumuna yazıldı.
    - *Negatif kontrol:* `OriginalDownloader.DownloadToFileAsync`'ın `ct` param bloğu
      geçici silindi → sade `dotnet build` DE `-warnaserror` DE KIRMIZI (error CS1573);
      geri kondu, md5 birebir (`cbae71dd…`), ardından sln `-warnaserror` 0 uyarı / 0 hata.

## 6. tur denetiminden — overlay koordinatının TEKLİĞİ (2026-08-12, KAPATILDI + kapsam beyanı)

Kapatılanlar (ölçümler `docs/rendering-semantics.md` §2.5 adım 3-4 ve §5.2'de):
overlay hedefi artık ifadenin içinde `floor`'lanıyor (pad'li/pad'siz yol eşitliği + ölçek > 1'de
işaret bağımlılığı), rotate ara tuvali ÇİFTE sabitlendi (dönen katmanın merkezi).

**KAPSAM DIŞI ilan edilenler — ölçülmedi, iddia da EDİLMİYOR:**

- **[AÇIK — merkez DIŞI çapa]** `floor` overlay ifadesinin kırpmasını tekilleştirir ama kutuya
  normalize eden pad'in kendi ofseti merkez dışı çapada `(ow-iw)*anchor` ile **oransaldır** ve
  tam bölünmez → pad'li yolda hâlâ İKİ bağımsız kırpma vardır. §5.2'nin invaryantı bu yüzden
  merkez çapayla **koşulludur**. Editör çapa alanı sunmadığı için rejim ULAŞILAMAZ; çapa alanı
  açılırsa önce ÖLÇÜLMELİ sonra invaryant genişletilmelidir.
- **[AÇIK — dönme açısı]** Dönen katmanın "merkez = `floor(P)`" iddiası uçtan uca **90°'de**
  ölçüldü (interpolasyon bulanıklığı olmadığı için sınır kutusu kesindir). Ara tuval yerleşimi
  ayrıca `a=0` ve `a=90` ile izole ölçüldü ve TEK tuvalde 0.5 px, ÇİFT tuvalde 0.000 px çıktı;
  **ara açılarda (30°/45°) uçtan uca piksel ölçümü YAPILMADI** — orada bbox kenarları
  interpolasyonla yumuşadığı için mevcut ölçüm aracı ±0.5 px'ten iyisini söyleyemez.
- **[AÇIK — animasyonlu konum]** `floor` animasyonlu (keyframe'li) overlay ifadesine de yazılır ve
  bu **yapısal muhafızla** sabitlenmiştir (`EveryOverlayCoordinate_IsFloored` keyframe
  fixture'larını da tarar), ama animasyonun hedefi negatiften pozitife geçirdiği bir belgede
  **kare kare piksel ölçümü yapılmadı**. Statik rejimde ölçülen davranışın kare başına aynısı
  olması beklenir; bu bir BEKLENTİDİR, ölçüm değil.
- **[AÇIK — rotate tuvalinin köşe kırpması]** `rotate`'in `ow` ifadesini round-half-up'la
  tamsayılaması, ham `hypot` aşağı yuvarlandığında köşeyi kuramsal olarak 0.5 px'e kadar
  kırpabilir. ÇİFTE yuvarlama bu payı kapatır gibi görünüyor (`2*ceil(hypot/2) ≥ hypot`) ama
  **ölçülmedi** — kenar yumuşaması bu mertebeyi mevcut araçla görünmez kılıyor. İddia edilmiyor.

## 7. tur denetiminden (2026-08-13, KAPATILDI + kapsam beyanı)

Kapatılanlar:

- **503 `text-measure-unavailable` BELGE hatasını KURULUM hatası gibi raporluyordu.** Bilinmeyen
  bir `fontId` (gerçekçi tetikleyicisi: editörün eski varsayılanı `inter`'i taşıyan eski belge)
  503 alıyor, kullanıcıya "yeniden deneyin" deniyor ama istek asla çalışmıyordu. İki bağımsız
  mekanizmayla kapandı — **TÜR** (ölçüm istisnası belge/altyapı diye ayrıldı; ayrımın taşıyıcısı
  `FontNotFoundException.ExpectedPath`) ve **SIRA** (font ön kontrolü `Validate`'ten öne alındı).
  Ayrıntı: `poc-bilinen-sinirlar.md` §3.3.
- **Raster çizim sözleşmesi senkron kapıya taşındı.** Geçersiz `text.fill` (ve kardeşleri:
  `text.stroke.color`, `text.background.color`, `shape.fill`, `shape.stroke.color`, gövdesiz
  `shape`, yinelenen raster klip kimliği) artık istek anında 422. Yapısal muhafız **raster
  hattını da kapsayacak** biçimde genişletildi (`RasterRefusals`, kimlikle eşleşir).
- **Geçiş eklemek DÖNEN katmanı oynatıyordu.** Kök neden `rotate`'in GİRİŞİYDİ; giriş artık iki
  yolda da kutuya normalize ediliyor. Bekçi 8'den **16 satıra** çıktı (`rotationDeg` yazan yarı
  ilk kez koşuyor). Ayrıntı: `rendering-semantics.md` §5.2.
- **§6.3'ün "kompozisyon RGB'de yapılır" kuralının KONUM yarısı artık testle korunuyor**
  (`CompositingInRgb_IsWhatKeepsOddOverlayPositionsFromSnapping`). Aynı ölçümle **yeni bir olgu**
  kayda geçti: `format=rgba` tek başına yetmez — overlay'in `format=auto` pazarlığı, her iki
  giriş rgba olsa bile `yuva420p`'ye iner.
- **§9.3'ün negatif kontrolleri artık yeniden üretilebilir**: iki önkoşulu (merkezleme = 0, çerçeve
  payı ≥ 2 px) ölçülerek yazıldı.

**Bu turda ölçülen ama KAPSAM DIŞI kalanlar:**

- **[AÇIK — ara açıda merkez iddiası]** Yukarıdaki "dönme açısı" maddesi **kısmen** daraldı:
  `a=30` artık uçtan uca koşuyor, ama koştuğu iddia *pad'li yol = pad'siz yol* eşitliğidir,
  "merkez = `floor(P)`" DEĞİL. Ara açıda merkezin `floor(P)`'ye oturduğu hâlâ ölçülmemiştir ve
  ölçülemez: §9.3'te gösterildiği gibi orada katmanın kendi kenar rampası ağırlık merkezini
  `0.7 px`'e kadar kaydırır, yani mevcut araç konum hatasıyla rampa payını ayıramaz.
- **[AÇIK — 503'ün kalan varsayımı]** API ile worker'ın AYNI font kökünü gördüğü varsayımı
  sürüyor. Fontları worker'da olup API'de olmayan bir dağıtımda 503 yanlış ret olurdu (o dağıtım
  metin için zaten bozuktur: `/api/fonts` 503 döner). Ölçülmedi, iddia edilmiyor.
- **[AÇIK — raster sözleşmesinin İÇERİK yarısı]** Yeni kapı renk **dilbilgisini** ve gövde
  varlığını sorar; rasterin gerçekten çizilebilir olduğunu (glif kapsamı, aşırı uzun tek satır,
  vb.) SORMAZ. O yarı worker'da kalmaya devam ediyor ve `RasterRefusals` defterinde yazılı
  gerekçesi vardır.

## 8. tur denetiminden (2026-08-13, KAPATILDI + kapsam beyanı)

Kapatılanlar (kullanıcı anlatımı `poc-bilinen-sinirlar.md` §1.8, §3 tablosu + matris, §3.3):

- **[KRİTİK — N1] Müzik eklemek dışa aktarmayı imkânsız kılıyordu.** Worker'ın indirme döngüsü
  klip TÜRÜNE bakmadan (LUT hariç) her varlıkta video akışı şart koşuyordu. Soru yeniden
  tanımlandı — "dosyada ne var" değil, **"o dosyayı okuyan KLİP ne istiyor"**: defter
  `ExportPlan.AssetUses` (Motion / Still / Audio) TEK yerde (`ExportCompiler.NeedOf`) üretilir,
  senkron kapı onu DB olgularıyla (`asset-clip-type`), worker aynı defteri ffprobe olgularıyla
  (`FindStreamMismatch` → `unsupported-media`) sorar. **Aynı kullanıcı yolunun ilk adımı da
  kırıktı:** `.m4a` yüklemek bu makinede imkânsızdı (tarayıcı `audio/x-m4a` der, whitelist
  reddeder); içerik tipi artık uzantıdan türetiliyor (`contentTypeForFileName`).
- **[YÜKSEK — N2] `asset-not-ready` dört durumdan üçünü kapsıyordu.** TERMİNAL `Failed` senkron
  kapıya alındı (`asset-failed`); geçici durumlar (Uploading/Uploaded/Processing) BİLEREK
  worker'da kaldı. Muhafız boşluğu da kapandı: `AssetStatusOwners` defteri `AssetStatus`
  enum'ını refleksiyonla tarar ve **her durumu uç noktaya göndererek** koşar.
- **[ORTA — N3] Çıkartma klibi VİDEO varlığını gösterince tipli hata bile yoktu**
  (`ffmpeg exited with code -1414549496`). Aynı `asset-clip-type` kapısı kapsıyor; TÜM matris
  (4 klip türü × 3 varlık türü + "sessiz video" = 13 satır) uç noktaya gerçekten gönderilerek
  koşuyor.
- **[DÜŞÜK — N4] `Fonts:AllowSystemFallback` ile ölçülen kutu kapıyı kurulum durumuna
  bağlıyordu.** Ölçüm ve karar aşağıdaki "Fontlar" bölümüne işlendi; kapı artık pinli olmayan
  ölçümle kutuyu KESİNLEŞTİRMİYOR.
- **Ek muhafız:** sunucunun `AssetFactFeatures` listesi ile istemcinin `ASSET_FACT_CODES`
  listesi bir testle karşılaştırılıyor (`TheClientAndServerAgreeOnWhichCodesMeanAnAssetProblem`)
  — ayrışma çökme değil YANLIŞ CÜMLE üretirdi.

**8. turun DOKÜMAN yüzünde ölçülen/kapatılan borçlar (aynı turun ikinci yarısı):**

- Teslim paketindeki test sayıları bayatlamıştı; hepsi yeniden koşuldu (README + §5):
  backend **1198** (MinIO'suz 1181 + **17** atlandı — eski metin 13 diyordu ve kendi alt
  kırılımıyla tutmuyordu), editör **1196**, şema **191**. E2E paketi **koşulmadı**, yalnız
  listelendi: 33 dosyada 143 test (geçme sayısı DEĞİL).
- `rendering-semantics.md` §9.3'ün negatif kontrolüne **üçüncü önkoşul** eklendi (diskin
  rasterleştirmesi) — eski `0.077 / 0.068` çifti süperörnekli diskin sayısıdır, sert kenarlı
  diskle sınır aşılıyor (ölçüldü). Taşıyıcı iddia (pay ≥ 2 px → `0.000`) üç rasterleştirmede de
  ayakta.
- `git worktree` kayıtları temizlendi (`degen/pre`, `degen/post`): kayıtlar depoda
  (`.git/worktrees/`) yaşıyor ama oturumluk bir scratchpad dizinini gösteriyordu; `post`'un
  taşıdığı diff, teslim edilen çalışma ağacının **daha eski bir iterasyonuydu** (işlevsel her
  satırın ana ağaçta karşılığı olduğu doğrulandı, fark yalnız yorum ifadeleriydi).

**KAPSAM DIŞI / AÇIK kalanlar (iddia EDİLMİYOR):**

- **[KAPANDI — 2026-08-24, yarim-is #14] Tur numaralandırması kodda ayrıştı.** 8. turun
  bıraktığı bazı kod yorumları bu dilimi "6. tur denetimi" ya da "M6 denetimi" diye
  adlandırıyordu (`ExportCompiler.EnsureAssetFacts` yorumu, `e2e/audio-export.spec.ts`
  başlığı). Kapanış: kaynak koddaki (apps/, packages/, backend/) TÜM tarihsel tur/dalga
  atıfları (yalnız ayrışanlar değil) yorumlardan çıkarıldı ve yerlerine KALICI gerekçe
  yazıldı ("N. turda" gitti, "çünkü X ölçüldü" ve ölçülmüş sayılar kaldı); milestone
  etiketleri (M0–M6, plan/dosya adlarıyla bağlı yapısal adlar) ve denetim-içi bulgu
  numaraları (#1, #2 — docs/audits arşiv kimliği) korundu. Test ADLARI ve dizge
  literalleri bilerek DOKUNULMADI (davranış sıfır): `clipInspectorModel.test.ts`
  describe'ındaki "(M4 dalga 2)", `ExportGateInventoryTests.DocumentStrings` defter
  dizgesindeki "(10. tur, F3)" ve test-vektör JSON'larının `description` alanları
  yerinde duruyor — bunlar yorum değil. Diff'in yalnız yorum satırlarına dokunduğu
  mekanik tarama ile kanıtlandı; build + tüm testler birebir yeşil. Dokümanlar
  (bu dosya, poc-bilinen-sinirlar, README) tarihçe defteridir, atıfları meşru ve
  KAPSAM DIŞI kaldı; docs/audits/ dokunulmazdır (review-gate kural 6).
- **[KAPANDI — 2026-08-24, yarim-is turu] "Sesi ayır" sessiz bir videoda da açıktı.** Yeni
  `asset-clip-type` kapısının "ses klibi + SESSİZ video" hücresi, matrisin editörden
  ULAŞILAMAZ sanılan tek istisnasıydı: ses klibinin üçüncü üretim yolu
  `timelineOps.detachAudio`'dur ve `detachAudioBlockReason` varlığın sesi olup olmadığına
  bakmıyordu — editör `hasAudio` olgusunu hiçbir yerde okumuyordu ve `buildClipFromAsset`
  her video varlığında `audio` alanını dolu doğurur. **Önce ÖLÇÜLDÜ** (gerçek ffmpeg `-an`
  kaynağı + gerçek yükleme + gerçek fare, Playwright): sessiz videoda menü öğesi AÇIK
  (`disabled=false`), tıklanınca ses klibi doğdu, POST /exports **HTTP 422
  `asset-clip-type`** ("bu videonun ses akışı yok") döndü — iddia birebir doğru çıktı.
  Kapanış: `AssetSummary`'ye `hasAudio` taşındı (tel `null` → `undefined` daraltmasıyla,
  `durationMicros` ile aynı desen; `assetSync.toHasAudio`) ve `detachAudioBlockReason`'a
  `hasAudio === false` dalı eklendi (`'source has no audio stream'` → feedback tablosunda
  Türkçe gerekçe; menü aynı sözleşmeyle griler). Yalnız KESİN `false` engeller: API olguyu
  yalnız READY satırda döner, bilinmeyeni engellemek export kapısıyla çelişen yanlış ret
  olurdu. Sürükleme yolu ayrıca kapatılmadı çünkü kapalı doğmuştu: video varlığı yalnız
  `kind:'video'` klip doğurur ve ses track'ine `track type mismatch` ile zaten giremez.
  Kanıt: birim (`clipPropertyOps.test.ts` sessiz/sesli/bilinmeyen + `contextMenu.test.ts`)
  ve gerçek-fare e2e `e2e/detach-audio-silent.spec.ts` (sessiz → öğe GRİ + Türkçe gerekçe;
  SESLİ → hâlâ çalışıyor). Negatif kontrol: dal geri alınınca 2 birim testi + e2e kırmızı,
  geri konunca yeşil (md5 birebir).
- **[AÇIK] `.github/workflows/ci.yml` içinde doğrulanamayan bir sayı duruyor:** bir yorum
  satırı "temiz klonda 139 test bunsuz kırılır" diyor. Bu, paketin büyüklüğü (bugün 143) değil
  "kaç test kırılır" iddiasıdır ve ancak o adım kaldırılıp suite koşturularak ölçülebilir; bu
  doküman turu Playwright koşmadığı için DOKUNULMADI. Ya ölçülmeli ya sayısızlaştırılmalıdır.
- **[KAPANDI — 2026-08-25, B borçları B1] Ses parity'si (preview ↔ export RMS) ölçüldü.**
  Yöntem + 9 vakalı normatif sınır tablosu `poc-bilinen-sinirlar.md` §2.6'da; kalıcı muhafız
  `e2e/audio-parity.spec.ts` (OfflineAudioContext'te uygulamanın KENDİ kazanç modülleri ↔
  gerçek export; negatif kontrol: fade eğimi kasıtlı bozuldu → 6,42 dB ile kırmızı → md5
  birebir geri). Ölçülen en büyük fark limiter vakasında 1,20 dB (bilinçli §8.3 asimetrisi);
  düz vakalarda ≤ 0,60 dB; sistematik +0,175 dB alimiter auto-level olarak adlandırıldı.
- **[KAPANDI — 2026-08-25, B borçları B1] Ses/müzik yolu artık demo senaryosunun ÖLÇÜLMÜŞ
  bir adımı.** Demo medya betikleri `demo-04-muzik.m4a` üretir (220+330 Hz akor + tremolo),
  senaryoya **Adım 4M — Müzik ekle** eklendi ve müziğe dokunan omurga (1→4, 4M, 17) gerçek
  fare/klavye + gerçek dosya seçiciyle bir kez koşuldu — çıktı MP4'te müziğin 220 Hz bandı
  −18,6 dBFS ölçüldü. Kayıt: `demo-senaryosu.md` §7 "4M koşum kaydı".

## 11. tur denetiminden (2026-08-20 — miks asılması, bekçi, cümle sınıfı)

Kapatılanlar:

- **[KRİTİK — B1] Miks kuyruğundaki `apad` export'u SONSUZA KADAR asıyordu.** Kuyruk
  `…,alimiter=limit=0.98,apad,atrim=end=<toplam>` idi; argümansız `apad` SINIRSIZ üreteçtir ve
  bu rejimde `atrim` onu durdurmuyordu. Yeni biçim
  `…,alimiter=limit=0.98,atrim=end=<toplam>,apad=whole_dur=<toplam>` — önce fazlalık kırpılır,
  sonra dolgu KENDİ durma noktasını taşıyarak eksiği tamamlar. Ürün düzeyinde ölçüldü (ham API,
  iki 10 sn'lik sesli kaynak, ikincisi baştan kırpılmış, toplam 19 sn): düzeltmeden önce 0/3
  tamamlandı (üçü de %90/render'da asıldı, her biri ~135 sn CPU yakan kaçak ffmpeg bıraktı),
  düzeltmeden sonra 6/6 tamamlandı ve çıktının SES AKIŞI tam 19,000000 sn ölçüldü.
- **[YÜKSEK — B2] Kusurun rejimini hiçbir test koşmuyordu.** Deponun miks uzunluk testi
  kendini `amix=inputs=1:` ile TEK girişe sabitliyordu; çok girişli rejimin uçtan uca karşılığı
  eklendi (`ExportRenderGoldenTests.AudioMix_WithTwoAudibleGroups_FinishesAndSpansTheWholeTimeline`):
  gerçek ffmpeg, tam A/V grafiği, iki ayrı 10 sn'lik sesli kaynak, ikinci klip baştan kırpılmış,
  toplam 19 sn, üç koşum, SÜRE TAVANI ile (tavana çarpınca KIRMIZI, "yavaş test" değil).
- **[YÜKSEK — B3] Bekçi kaçak süreci göremiyordu.** Sessizlik bekçisi (120 sn) çıktı
  sessizliğini ölçer; kaçak grafik durmadan `-progress` bastığı için asla tetiklenmiyordu.
  İkinci tavan eklendi (`FfmpegRunner.OutputTimeCeilingUs`): çıktı saati beklenen sürenin
  %10 + 5 sn üstüne çıkarsa süreç ağacı öldürülür ve iş TİPLİ `render-overrun` ile düşer.
  Reaper de artık iş satırını `stalled` yaparken koşan render'ı iptal eder
  (`RunningRenderRegistry`).
- **[DÜŞÜK — B6/2] `project-background-color` ve `lut-asset` YANLIŞ CÜMLE kuruyordu**
  ("desteklenmeyen özellik"). Üçüncü 422 cümle sınıfı eklendi — "belge geçerli, özellik
  destekli, proje pencerede; DEĞER hatalı" (`DocumentValueFeatures` ↔ `VALUE_CODES`), üç kümenin
  ayrıklığı ayna testinde ölçülüyor.

**AÇIK kalanlar (bu turda BİLEREK yapılmadı):**

- **[✅ KAPANDI, 2026-08-21 — B6/1] Modal odak yönetimi üç overlay'e eklendi; 7 `test.fail`
  SİLİNDİ, testler gerçek klavyeyle GERÇEKTEN geçiyor.** Ortak desen
  `apps/editor/src/lib/useModalFocus.ts`: açılışta odak ilk odaklanabilir öğeye taşınır,
  Tab/Shift+Tab uçlarda döngü yapar (odak tuzağı), kapanışta odak tetikleyici düğmeye döner;
  `ExportDialog` artık Escape ile de kapanır (hook `stopPropagation` ile dispatcher'a çift
  işletmez). `ConflictDialog` aynı hook'u kullanır ama BİLEREK Escape almaz (tek güvenli
  çıkış “Sunucudaki sürümü yükle”) — ve odak davranışı e2e'de ÖLÇÜLMEDİ: 409 diyaloğunu
  gerçek akışla tetikleyen tek e2e (`timeline-gates.spec.ts`, "Ctrl+Z dokümanı değiştirmez")
  Ctrl+Z kapısını ölçer, odak sözleşmesini değil (aşağıdaki kalan borca bakınız).
  - *Kanıt (2026-08-21, gerçek klavye):* `a11y-smoke.spec.ts` 14/14 — eski 7 `test.fail`
    testi artık normal test. Negatif kontrol yapıldı: tuzak geçici bozuldu → iki “odak
    tuzağı” testi Kırmızı (“Odak … DIŞINA sızdı”) → geri alındı → yeniden yeşil.
  - *Kalan borç (bilinçli):* `ConflictDialog`'un odak sözleşmesi aynı ortak hook'tan gelir ama
    gerçek-girdi e2e kanıtı yok (409 kurulumunu timeline-gates'ten a11y-smoke'a taşıyıp
    odak içeri/tuzak/Escape-yok iddialarını ölçmek ayrı iş); `VersionsOverlay`,
    `AssetDeleteDialog`, `TransitionEditor` gibi diğer `aria-modal` yüzeyleri henüz hook'a
    geçirilmedi — kendi Escape dinleyicileri var, odak tuzağı/geri-verme yok.
  - *(Tarihçe — bulgunun açık hâli:)* üç overlay `aria-modal="true"` yazıyor ama odak
    yönetimi uygulamıyordu; `test.fail` deseni bulguyu görünür tuttu ve
    öngörüldüğü gibi çalıştı — davranış eklenince Playwright "Expected to fail, but passed"
    ile kırmızı verdi ve satırlar silindi (review-gate kural 4 kaydı kaybolmadı).
- **[✅ KAPANDI, 2026-08-25] Çıktı saati tavanı İŞLEME reçetelerine genişledi — her reçetenin
  `out_time` tabanı ÖLÇÜLDÜ, pay aynı (%10 + 5 sn), taban reçeteye göre seçildi.**
  Ölçüm (ffmpeg 8.0, gerçek reçete argümanları + gerçek `FfmpegRunner`, korpusun tamamı):
  - *Proxy (video+ses):* `out_time` kaynak süresini izler — korpusta azami sapma
    VFR'de **−13,8 ms** (CFR normalizasyonu beklenenin ÜSTÜNE taşımıyor), diğerlerinde tam 0.
    Tavan = `OutputTimeCeilingUs(probe.DurationUs)`.
  - *Filmstrip:* `out_time` SPRITE SAATİDİR, kaynak süresi DEĞİL — `tile=30x10` saati sprite
    başına 300×interval sn ilerletir: 2,93 sn'lik kaynak **300,000000 sn** bildirdi (350 sn→600,
    650 sn→900, 3010 sn/interval=2→3600 — dört noktada model TAM eşleşti,
    `FilmstripRecipe.ExpectedOutputClockUs`). Kaynak süresine bağlanan tavan HER filmstrip'i
    yanlış öldürürdü; tavan sprite saatinden türetilir.
  - *Poster:* tavan BİLEREK YOK — `-frames:v 1` çıktı saatini yapısal olarak tek karede keser
    (ölçülen azami `out_time` **33.333 µs**, tüm korpusta aynı); "durmadan üretme" kaçağı
    kurulamaz, kalan risk (hiç ilerlememe) sessizlik bekçisinin işi.
  - *Waveform:* `-progress` kanalı yok (stdout PCM taşır) — çıktı saatinin eşdeğeri PCM BAYT
    SAYISIDIR (16000 B/sn); ölçülen sapmalar +8 ms (AAC payı) / −10,6 ms (VFR) / 0 (mp3, wav).
    Tavan `WaveformGenerator.OutputByteCeiling` ile bayta çevrilir; aşımda süreç öldürülür.
  Aşım TİPLİ düşer: `transcode-overrun` (`ProcessAssetJob.DeterministicFfmpegReason` —
  `ffmpeg-timeout`/`ffmpeg-failed`'den AYRI; export'un `render-overrun` eşi). Korpusa iki yeni
  dosya eklendi: **süresini yalan beyan eden** m4a/mp4 (mvhd/tkhd/mdhd 2 sn'ye kısaltılmış,
  akış 60 sn — `MaxDurationUs` kapısı beyana baktığı için bu sınıfı YALNIZ tavan yakalar);
  ikisi de uçtan uca `transcode-overrun` ile düşüyor, eski 7 korpus dosyası + pipeline e2e
  yanlış öldürülmeden Ready (`DirtyMediaCorpusTests` 9/9, `ProcessAssetPipelineTests` 9/9).
  Negatif kontrol yapıldı: tavan geçici kapatıldı → 3 kaçak testi KIRMIZI (yalancı dosya
  `Ready` olabildi) → geri alındı (md5 doğrulandı, touch+rebuild) → yeşil.
- **[✅ KAPANDI, 2026-08-25 — B6] Reaper'ın süreç iptali artık tek süreçle sınırlı değil: DB
  SATIRININ KENDİSİ süreçler-arası iptal kanalı yapıldı.** "Yapılacak" listesindeki ikinci
  seçenek uygulandı, yeni kanal İCAT EDİLMEDİ: render sırasında zaten var olan cancel
  yoklaması (`ExportJob.CancelPollInterval`, 10 sn'de bir tek satırlık PK SELECT) artık satırın
  GÜNCEL durumunu okur — satır Running değilse (API `Canceled` YA DA reaper — hangi worker'da
  koşarsa koşsun — `Failed('stalled')` yazmıştır) render'ın SAHİBİ süreç kendi ffmpeg ağacını
  öldürür ve satırı yazanın gerekçesiyle OLDUĞU GİBİ bırakır (rethrow yok: Hangfire retry'ı
  `stalled` satırı Running'e çevirip işi DİRİLTİRDİ). Reaper de kararını ÖNCE commit eder,
  SONRA süreç öldürür — ters sıra aynı dirilmeyi üretirdi
  (`Reaper_StalledJob_CommitsTheDbVerdictBeforeKillingTheRender`). Gerekçe ailesi DEĞİŞMEDİ
  (`stalled`/`canceled` aynen); süreç içi `RunningRenderRegistry` DURUYOR — aynı süreçte ANINDA
  ulaşım ve hiç progress üretmeyen asılı işler için (DB yoklaması ancak progress callback'i
  akarken koşar).
  - *Kanıt (gerçek MinIO + gerçek ffmpeg, `ExportJobPipelineTests` orta-render ailesi):* reaper
    BOŞ bir registry ile ("başka worker'da") yalnız DB'ye yazdı → sahibi süreç ffmpeg ağacını
    öldürdü (pid gerçekten düştü), satır `Failed('stalled')` olarak KALDI, exports bucket'ına
    obje çıkmadı; yanlış-öldürme avı — aynı saldırgan yoklama sıklığında (her callback'te bir
    yoklama) dokunulmamış satırla iş Succeeded; orta-render KULLANICI iptali (satır Canceled +
    'canceled' stage) ve Hangfire shutdown'ı (satır Running → rethrow, requeue) ayrı ayrı ölçüldü.
  - *Maliyet (ölçüldü 2026-08-25, dev Postgres 17 konteyneri, 3 535 satırlık Jobs):* sorgu
    SAYISI DEĞİŞMEDİ — aynı yoklama eskiden de aynı tek-satır PK SELECT'ini atıyordu, yalnız
    Canceled'a bakıyordu. Sorgunun kendisi PK index'inden 3 buffer okur; tekil koşum
    `EXPLAIN ANALYZE` 0,26 ms, ısınmış döngüde 5-10 µs/sorgu (3×1000 koşum). Frekans: koşan
    export başına 10 sn'de 1; export kuyruğu WorkerCount=1 → sistem genelinde ≤ 0,1 sorgu/sn.
  - *Negatif kontrol:* yoklama geçici olarak eski hâline (yalnız Canceled'a bakan) çekildi →
    çok-worker testi KIRMIZI → geri alındı (md5 birebir, touch+rebuild) → yeşil.
  - *Kalan sınır (bilinçli — `poc-bilinen-sinirlar.md` §4.1 ve `RunningRenderRegistry`
    xmldoc'u):* DB yoklaması ancak süreç PROGRESS ÜRETİYORKEN koşar. Progress üretmeyen kaçak
    aynı süreçteyse registry/sessizlik bekçisi yakalar; BAŞKA süreçteyse ya da worker çöküp
    ffmpeg'i öksüz bıraktıysa süreç-içi hiçbir mekanizma ulaşamaz — o hâl OS düzeyi süpürme
    işidir ve kapsam dışıdır.

## 12. tur denetiminden (2026-08-20 — kullanıcının İLK mesajındaki iki gereksinim kayda geçti)

Baş mimar **review-gate kural 4 ihlali** saptadı: kullanıcının ilk mesajındaki iki gereksinimin
yukarıdaki kapsam tablosunda **satırı yoktu** — biri hiç ölçülmemişti, diğeri yalnız
`poc-bilinen-sinirlar.md` §4.2'nin içinde gömülü duruyordu. İkisi de bu turda tabloya eklendi;
ölçülebilen ölçüldü.

**(1) "1-2 GB dosyalarda performans" — artık ÖLÇÜLDÜ (daha önce hiç ölçülmemişti).**
Dokümandaki en büyük ölçüm 122 MB / 120 sn idi; 4 GiB yalnız bir doğrulama SABİTİ olarak vardı.
Bu turda ffmpeg ile **1,51 GiB / 10:40 / 1080p30 / 20 Mbps** gerçek bir kaynak üretildi (grenli
içerik — kodlayıcı gerçekten yoruluyor) ve ürünün KENDİ yolundan geçirildi: tarayıcıda gerçek
fareyle dosya seçici → 25 parçalı yükleme → worker işleme → timeline → gerçek fareyle kesme →
export. Bütün sayılar `poc-bilinen-sinirlar.md` **§0.1**'de. Özet: yükleme 5,0 sn (lokal),
işleme 68,9 sn (proxy 38,7 + filmstrip 24,7), "Hazır"a toplam 75,6 sn, 60 sn'lik kesimin
export'u 16,6 sn iş / 19,5 sn duvar saati, tam 10:40'lık çizelgenin export'u 181,3 sn iş /
184,2 sn duvar saati.

**(2) "R2'de saklayıp sonradan tekrar düzenleme" — düzenleme yarısı ölçüldü, R2 yarısı AÇIK.**
Gerçek medyalı proje üzerinde gerçek fare/klavyeyle: böl → "Kaydedildi" → Çıkış → yenile (hâlâ
dışarıda) → temiz adresten yeniden giriş → proje seçici → proje satırına tıkla → **belge birebir
geri geldi** ve medya gerçekten servis edildi (filmstrip tuvalinde 3120 farklı renk okundu,
`media-urls` 200, presigned proxy `Range` GET'i 206). **Gerçek Cloudflare R2 hâlâ hiç
denenmedi**; MinIO'nun neyi kanıtladığı / neyi kanıtlamadığı §4.2'de kalem kalem yazıldı.

**Bu ölçümün ortaya çıkardığı AÇIK borçlar:**

- **[KAPANDI — 2026-08-21, backend borç turu] Export'un disk rezervasyonu tahmini yüksek bit
  hızlı kaynakta KISA KALIYORDU.** Kapanış: tahmin artık kaynağın ÖLÇÜLMÜŞ bit hızını kullanıyor —
  `ExportJob.EffectiveOutputBitsPerSecond` = max(profil 10 Mbps, max(kaynak SizeBytes×8e6/DurationMicros))
  (yalnız Video/Audio türü, süresi bilinen satırlar; görsel/LUT'un boyut/süre oranı anlamsız).
  ÖLÇÜLEREK kanıtlandı (`ExportDiskEstimateTests`, gerçek ffmpeg + MinIO, bu makinede):
  113,8 Mbps'lik gerçek rastgele-içerikli 720p kaynakla gerçek export koşuldu; gerçek ayak izi
  (cache'teki kaynak + üretilen çıktı) **156 436 793 B**, ESKİ formül **109 932 895 B** dedi
  (ALTINDA — negatif kontrol), YENİ formül **187 793 641 B** (KAPSIYOR). Düşük bit hızlı
  kaynakta (124 kb/s) yeni tahmin eskisiyle BİRE BİR aynı (profil tabanı kazanır — şişme yok)
  ve ayak izini kapsamaya devam ediyor. Formül birim testleri: `ExportJobTests`
  `EffectiveOutputBitsPerSecond_*` (taban/karışım/zaman-eksensiz dışlama).
  *Tavan gerekçesine dipnot:* 10. turdaki "4 saatlik çizelge = 21,6 GB rezervasyon" sayısı
  artık ALT SINIRDIR (profil tabanı; `EstimateRequiredDiskBytes_AtTimelineCeiling…` testi bunu
  sabitlemeye devam ediyor) — yüksek bit hızlı kaynakta rezervasyon kaynağın ölçülen hızıyla
  büyür; bu bilinçlidir, çünkü o export gerçekten o kadar disk yazar ve kapının işi "yalan
  yeter" dememektir.
- **[KAPANDI — 2026-08-21, backend borç turu] Kota yalnız ORİJİNALLERİ sayıyordu.** Kapanış:
  işleme hattı türev toplamını asset satırına yazıyor (`Asset.DerivedBytes` — yeni migration
  `AddAssetDerivedBytes`, nullable bigint) ve kota sorguları (InitUpload reddi + `/api/quota`
  göstergesi) depolamayı `SizeBytes + (DerivedBytes ?? 0)` olarak sayıyor. Geriye dönük
  davranış: NULL = 0 (eski asset'ler bir gecede kota doldurmaz; backfill bilinçli YOK).
  Testler: `ProcessAssetPipelineTests` (DerivedBytes MinIO'daki türev objelerinin gerçek bayt
  toplamına EŞİT — video + ses), `AssetUsageQuotaTests` (403 sınırına türevler dahil; negatif
  kontrol: türev defteri NULL'a çekilince AYNI istek 201 alır).
- **[KAPANDI — 2026-08-21, backend borç turu] LRU cache SÜPÜRMESİ hiç ölçülmemişti.** Kapanış:
  `OriginalCacheLruTests` (gerçek MinIO indirmeleri, tavan test-yerel 250 KB'a indirilmiş):
  tavan aşılınca EN ESKİ damgalı girdi düşüyor; cache isabetiyle damgası tazelenen AKTİF girdi
  ve PİNLİ (koşan export'un) girdi — en eski olsa bile — korunuyor; süpürme tavana inince
  duruyor; süpürülen girdinin sonraki isteği indirmeyi baştan ödeyip cache'e dönüyor.
  Negatif kontrol: AYNI kurulum pin OLMADAN koşunca en eski girdi gerçekten siliniyor (pin
  korumasının yeşili tesadüf değil). NOT: 20 GiB'lik GERÇEK tavanla, GB'lık dosyalarla ürün
  düzeyi bir koşum hâlâ yapılmadı — mekanizma ölçüldü, ölçek ölçülmedi.
- **[KAPANDI — 2026-08-25, B borçları B2] Ölçüm n=1'di.** Kapanış: aynı yol (gerçek fare +
  tarayıcının dosya seçicisi + ürünün upload motoru + gerçek fare/klavye kesme + export
  diyaloğu) **2,53 GB / 1000 sn'lik** ikinci bir kaynakla uçtan uca tekrarlandı — farklı
  boyut sınıfı, aynı içerik rejimi. Sayılar `poc-bilinen-sinirlar.md` **§0.1.1**'de (yükleme
  6,7 sn / 38 parça, işleme 109,8 sn ≈ 9,1×, "Hazır"a 117,6 sn, 60 sn'lik kesimin export'u
  18,1 sn iş / 23,3 sn duvar); oranlar n=1 ile tutarlı çıktı (9,1× vs 9,3×; %7,48 vs %7,7
  türev payı). AÇIK KALAN: eşzamanlı kullanıcı yükü ve varyans istatistiği (n=2'den varyans
  iddiası çıkmaz) — §4.1 sınırı geçerli; tarayıcı duvar saatleri hâlâ elle ölçülüyor.
- **[KAPANDI — 2026-08-25, B borçları B2] >2 GB ve 4 GiB tek dosya tavanı denenmedi.**
  Kapanış İKİ bacak: (1) >2 GB sınıfı yukarıdaki 2,53 GB'lık gerçek koşumla ölçüldü;
  (2) 4 GiB tavanı CANLI denendi, sınırın İKİ yanı: ham API'yle tam 4 GiB → **201** +
  `partCount` **64** (`UploadRules.PartCount` beklentisi birebir; multipart hemen abort
  edildi), 4 GiB+1 → **istek anında 400** (32 ms, `sizeBytes must be between 1 and
  4294967296.`); ayrıca 4 295 098 368 B'lik GERÇEK sparse dosya tarayıcının dosya
  seçicisinden verildi → init **400 (4,8 ms)**, tek bayt yüklenmedi, kart "Başarısız —
  Yükleme başlatılamadı: …" gösterdi. Birim düzeyi sınır zaten `AssetUploadValidationTests`'te.
  KALAN (düşük, yeni kayıt): kartın sınır mesajı ham API cümlesidir (İngilizce) — Türkçe
  bir "en fazla 4 GiB" cümlesine çevrilebilir; 4 GiB'e YAKIN (ör. 3,5-4 GiB) gerçek bir
  yükleme+işleme koşumu da yapılmadı (tavanın hemen altındaki bant yalnız init düzeyinde
  doğrulandı).
- **[KAPANDI — 2026-08-21, backend borç turu] Birim testi MAKİNE GENELİNDEKİ gerçek export
  cache'ini SİLİYORDU (ölçülmüştü).** Kapanış: `ExportJobTests` artık test-yerel bir
  `CacheDirectory` ile kurulur (sınıf başına temp dizin, Dispose'ta silinir) ve izolasyonun
  kendisi ölçülür: `Run_DiskFullPath_NeverTouchesTheMachineWideCache` makine köküne
  (`%TEMP%\videoedit-cache`) benzersiz adlı bir nöbetçi girdi koyar, agresif süpürme İÇEREN
  disk-full yolunu koşar ve nöbetçinin YERİNDE olduğunu doğrular; negatif kontrol olarak
  varsayılan `ProcessingOptions`'ın kökünün BUGÜN DE makine dizini olduğu (tehlike hâlâ gerçek,
  izolasyon bilinçli seçim) aynı testte sabitlenir. Aşağıdaki tarihçe kayıt için duruyor:
  `ExportJobTests.CreateJobRunner` `new OriginalCache(storage, new ProcessingOptions())` kuruyor;
  `CacheDirectory` boş olduğu için `OriginalCache.Root` `%TEMP%\videoedit-cache`'e — yani
  **çalışan worker'ın kullandığı AYNI dizine** — düşüyor. `Run_GenuinelyFullDisk_OnFinalAttempt_StillFailsWithDiskFull`
  `FreeSpaceProbe = _ => 1` ile disk-darlığı dalını zorluyor ve o dal `cache.TrimAsync(0)`
  çağırıyor → dizindeki **pinsiz her gerçek girdi siliniyor**. Bu turda ölçülerek bulundu:
  1,51 GiB'lık gerçek cache girdisi backend paketi koştuktan sonra yok olmuştu; negatif kontrol
  olarak dizine 1 MiB'lik sahte bir girdi konup **yalnız o tek test** koşuldu — girdi silindi
  (öncesi 1 dizin, sonrası 0). Diğer iki dosya (`ExportJobPipelineTests`, `ExportJobTests`'in
  iki testi) `CacheDirectory`'yi AÇIKÇA veriyor; kusur yalnız varsayılana düşen yolda.
  CI konteynerinde zararsız (her sürecin kendi `TMPDIR`'i), geliştirici makinesinde **gerçek
  veri siliyordu** ve ölçümleri sessizce bozuyordu. *(Çözüm yukarıdaki kapanış notunda.)*
- **[YARISI KAPANDI — 2026-08-25, B borçları B2] Bu turun İKİ ölçümü de KOŞULDU ama
  KORUNMUYOR(du).** İkisi de `e2e/.artifacts/` altında koşan, repoya girmeyen betiklerdi
  (`poc-bilinen-sinirlar.md` §5.1).
  - **(b) 1-2 GB perf rejimi → KAPANDI.** Eski öneri "elle tetiklenen Playwright perf
    projesi"ydi; uygulanan çözüm daha iyisi: rejimi temsil eden **her koşumda koşan** backend
    ölçüm testi `MediaPipelinePerfTests` (MinIO+ffmpeg kapılı — CI'da da koşar). ~320 MB'lik
    1080p30 20 Mbps grenli kaynağı üretir, 64 MiB'lık 5 parçayla 4-eşzamanlı presigned
    PUT'larla yükler, `ProcessAssetJob` + 30 sn'lik `ExportJob` koşar; iddialar ORANSAL
    (işleme/kaynak ≤ 0,75; export/çıktı ≤ 2,0; türev/orijinal ≤ %25; yükleme ≤ kaynak
    süresi) ve eşikler üç ölçüm koşumundan türetilip gerekçesiyle test dosyasına yazıldı.
    Negatif kontrol: işleme tavanı 0,001'e çekildi → test kırmızı ("işleme oranı 0.183 >
    tavan 0.001"), dosya md5 birebir geri. Kapsam tablosu: `poc-bilinen-sinirlar.md` §0.1.2.
  - **(a) "sonradan tekrar düzenleme"nin gerçek medyalı yarısı → KAPANDI (2026-08-31,
    küçükler dilimi).** Öngörüldüğü gibi `e2e/support/media.ts` fixture'ıyla (4 sn / ~2 MB)
    pakete alındı: `e2e/relogin-reopen.spec.ts` — gerçek fare/klavyeyle böl → "Kaydedildi"
    (rozetin sözü sunucudan ayrıca doğrulanır) → çıkış → yeniden giriş → proje seçici satırı →
    aynı belge (sunucu dokümanı + revision birebir; store karşılaştırması) + sayfanın kendi
    media-urls isteği 200 + proxy'ye Range GET 206. Negatif kontrol: `putTimeline` yalancı
    başarıya çevrildi → "rozet yalan söylüyor" mesajıyla kırmızı → md5 birebir geri. Oturum
    ayrı context'te (per-device logout; paylaşılan worker oturumu düşmez).
  - *Elle kalan öteki parça:* tarayıcı tarafının duvar saatleri (dosya seçici → "Hazır",
    çift tık, diyalog) — Playwright betiği ister, CI maliyeti gerekçesi geçerli (§5.1).
- **[KAYIT] `EditorApp.fitButton` locator'ı BAYAT (test altyapısı, ürün değil).**
  `e2e/support/editor.ts` "Sığdır" adlı bir düğme arıyor; üründe düğmenin adı **"Fit"**
  (`TimelinePanel`). Bugüne kadar yakalanmadı çünkü `ensureContentVisible` yalnız klip ekranda
  DEĞİLSE tıklıyor ve mevcut spec'lerin kısa fixture'larında auto-fit zaten yetiyordu; 640 sn'lik
  klip ilk kez bu dalı zorladı ve locator 15 sn timeout ile düştü. Ölçüm betiği bu turda
  locator'ı baypas etti (`/^(Fit|Sığdır)$/`), **repo dosyası değiştirilmedi**.
  - *Yapılacak:* ya `fitButton`'ı ürünün adıyla hizalamak ya da düğmeye `data-testid` vermek.

## 13. tur denetiminden (2026-08-21 — backend düzeltme turu: kapatılanlar + BG kayıtları)

Kapatılanlar (bu turda):

- **[ORTA — C1] Keyframe `timeUs` üst sınırı C# tarafında hiçbir katmanda yoktu.** zod
  belge kapısı "keyframe timeUs … is outside [0, timelineDurationUs]" ile reddederken
  `KeyframeCompiler` yalnız negatif/sıralılık/sonluluk denetliyordu; ham API'yle süre-ötesi
  opacity rampası PUT 200 + POST 202 + succeeded alıyor ve ffmpeg çıktısı rampayı son
  örneklenen değerde donduruyordu (SESSİZ yanlış çıktı). Kural artık `KeyframeCompiler.Parse`
  içinde (üst sınır KAPSAYICI, zod'la aynı cümle); HTTP karşılığı `ExportEndpointsTests`,
  zod paritesi paylaşılan `keyframe-bounds-vectors.json` üzerinden iki dilde
  (`invariants.test.ts` + `KeyframeBoundsParityTests`) ölçülüyor. Editörden üretilemez
  (remapKeyframes trim'de düşürür) — ham-API-yalnız vaka, ama zod↔Validate eşitliği bu
  projede bağlayıcı sözleşme olduğu için kapatıldı.
- **[DÜŞÜK — BG-3] CI golden-drift denetimi `backend/tests/RasterGoldens`'ı taramıyordu.**
  `RasterAssert.MatchesGolden` golden dosyası yoksa `File.Copy` ile üretip GEÇTİĞİ için
  kaybolan/yeniden üretilen shape golden'ı CI'da iz bırakmadan kendini yazardı. `ci.yml`
  "Golden/snapshot drift kontrolu" adımının PATHS listesine dizin eklendi; adımın komutu
  yerelde koşularak yapay değişikliğin yakalandığı, temiz ağaçta geçtiği doğrulandı.

**AÇIK kalanlar (bu turda BİLEREK yapılmadı — kayıt buraya):**

- **[AÇIK — DÜŞÜK, BG-4] `timelineOps` ret kodlarının bir bölümü iki Türkçe mesaj tablosunun
  (`feedback.ts` REASONS + `inspectorFeedback.ts`) hiçbirinde eşli değil; bu retlerde kullanıcı
  jenerik "İşlem uygulanamadı" görüyor.** Ölçülen alt sınır: literal `fail('…')` kodlarından
  9'u eşlenmemiş (comm diff) + dolaylı reason yollarından en az 2'si ("asset is not ready",
  "clip cannot keep its frame span here") tablolarda 0 geçiş; 21'lik sayım dolaylı reason
  dizeleri dahil sayımdır, yöntem farkı çelişki değil. YANLIŞ eylem öneren mesaj yok —
  mesajlar eksik ama yanıltıcı değil.
  - *Neden ertelendi:* kullanıcı engeli yok (işlem zaten reddediliyor; export/kota/çakışma
    gibi kritik yollar doğru mesajlı — canlı doğrulandı). ~11-21 koda doğru Türkçe cümle
    yazmak UX kararı isteyen hacimli iş; dev-modda "eşlenmemiş reason" `console.warn` alarmı
    da aynı pakete girmeli. Bu turun yüksek/orta düzeltmeleriyle yarışmasın.
- **[AÇIK — DÜŞÜK, BG-5] `timelineOps.ts` 3815 satır; 163 export'un ~30'u dışarıda
  kullanılmıyor, `hasClipboardContent` tam ölü.** Doğrulanan kısım: `hasClipboardContent`
  src ağacında yalnız tanımında geçiyor (1 hit, modül içi çağrı da 0). 30 sembollük liste
  tek tek yeniden üretilmedi (düşük şiddet; tarama yöntemi makul).
  - *Neden ertelendi:* davranış etkisi sıfır (ölü kod + fazla export); dosya bölme "tüm
    mutasyonlar tek kapıda" yazılı tasarım gerekçesine dokunan bir mimari karar.
    `hasClipboardContent` silme ve export budaması, BG-1 düzeltmesi aynı dosyaya dokunurken
    fırsatçı olarak birleştirilebilir; kendi başına tur harcatmaz.

## 14. tur denetiminden (2026-08-21 — 13. turun triyaja ulaşmayan üç bulgusu: M1/M2/M3)

13. turda baş mimarın nihai yapılandırılmış çıktısı taslağa sıkışmış ve üç bulgusu triyaja
ulaşmamıştı; transcript'ten çıkarılıp bu turda canlı ortamda yeniden üretilerek işlendi.

Kapatılanlar (bu turda):

- **[ORTA — M1] `rendering-semantics.md` §8.5 ürünle çelişiyordu.** Doküman "Preview
  `AudioContext({ sampleRate: 48000 })` ile açılır" diyordu; kod ise önizlemeyi projenin
  `settings.audioSampleRate` değeriyle açıyor (`engineV1` → `AudioGraph.setSampleRate` →
  `new AudioContext({ sampleRate })`), şema bu ayara `44100 | 48000` izin veriyor. Ölçüm
  (Chromium/Windows): istenen hız birebir veriliyor (44100→44100, 48000→48000, varsayılan
  48000). Export ise ayardan bağımsız sabit 48 kHz (`aformat …:sample_rates=48000` + profil
  `-ar 48000`; `ExportCompiler` `audioSampleRate`'i hiç okumuyor — grep 0; mevcut export
  çıktıları ffprobe ile `sample_rate=48000`). §8.5 gerçeğe göre yeniden yazıldı,
  `audioGraph.ts` başlık yorumu düzeltildi ve önizleme/export örnekleme-hızı ayrışması
  `poc-bilinen-sinirlar.md` §2.7'ye bilinen sınır olarak eklendi (ayarın gözlemlenebilir tek
  etkisi önizleme hızı; çıktı her hâlde 48000).
- **[ORTA — M2, savunma derinliği] `media-urls` (ve asset `ListForProject`) join'inde
  sahiplik filtresi yoktu.** Güvenlik "ProjectAssets asla cross-user satır içermez"
  değişmezine dayanıyordu (tek yazım noktası InitUpload, korumalı). Aktif sömürü yoktu ama
  değişmez tek noktadan delinirse başka kullanıcının imzalı URL'leri sızardı. Canlı ölçümle
  kanıtlandı: demo projesine kasten cross-user bir `ProjectAssets` satırı enjekte edilince
  düzeltmeden önceki ikili başka kullanıcının `original` imzalı URL'ini döndürdü (URL yolunda
  yabancı `OwnerId`). Sorgulara `a.OwnerId == userId && a.DeletedAt == null` eklendi (defter/
  kota sorgularındaki desenin aynısı); düzeltmeden sonra cross-user satır DÖNMÜYOR, normal 3
  asset'lik yanıt bozulmadan 200 dönüyor (yanlış-ret yok). Diğer uçlar tarandı: `exports`
  (GetJob/CancelJob/ListForProject) `RequestedBy == userId`, `projects`/`revisions`
  `OwnerId == userId` + `OwnsProjectAsync`, `fonts` kullanıcı-verisiz — desen zaten mevcut.
- **[DÜŞÜK — M3, sınıf kaydı] Belge-değişmezi katmanında cross-language parite vektörü
  eksikliği** — aşağıda ayrı başlıkta.

### [AÇIK — DÜŞÜK, M3 sınıfı] Belge-değişmezi ailelerinde zod↔C# parite vektörü eksik

Mevcut cross-language test-vektörleri (`test-vectors/`) HESAP/FORMÜL paritelerini kapsıyor:
`easing-vectors`, `time-vectors`, `text-layout-vectors`, `frame-grid-corpus` ve 13. turda
eklenen `keyframe-bounds-vectors`. Ama **belge-değişmezi** (structural invariant) katmanının
çoğu ailesi tek dilden ölçülüyor — zod tarafı `invariants.test.ts`'te zengin, C# tarafı
(`ExportCompiler.Validate` / `KeyframeCompiler.Parse` / geçiş-el kontrolü) ayrı yazılmış ve
ikisini tek kaynaktan koşan paylaşılan vektör YOK. Vektörsüz aileler:

- **Keyframe sıralaması** — `strictly sorted` / duplike `timeUs` reddi (zod:
  invariants.test.ts "rejects unsorted/duplicate keyframes").
- **Kaynak aralığı** — `sourceOutUs > sourceInUs`; `timelineDurationUs == round((sourceOutUs
  − sourceInUs) / speed.rate)` (half-up yuvarlama — iki dilde ayrışma riski en yüksek burada);
  `sourceOutUs ≤ asset süresi`.
- **Geçiş simetrisi** — süre ≤ kısa komşunun yarısı; bitişiklik; el payı `sourceInUs ≥ D/2`
  ve hız-farkında el hesabı.
- **Klip yerleşimi** — çakışmama; `timelineStartUs`'a göre sıralılık.

**C1 tam bu sınıftan çıktı:** keyframe üst sınırı C# kapısında yokken zod'da vardı; 13. tur
o deliği kapattı ama *keyframe sınırı* ailesiyle sınırlı kaldı. Kök neden (aynı değişmezin
iki dilde ayrı yazılıp tek kaynaktan ölçülmemesi) sıralama/kaynak-aralığı/geçiş ailelerinde
DEVAM EDİYOR. **Önerilen kapatma deseni:** her aile için `keyframe-bounds-vectors.json`
kalıbı — geçerli+geçersiz vakaları tek JSON'da tutan, hem `invariants.test.ts` (zod
`validateTimelineDoc`) hem bir `*ParityTests.cs` (`ExportCompiler.Validate`) tarafından
koşulan, dosyanın iki yönü de taşıdığını ayrıca doğrulayan bir vektör dosyası.

**Bu turda kapatılan aile — KAYNAK ARALIĞI.** `source-range-vectors.json` eklendi ve iki
dilde tüketildi (`invariants.test.ts` "matches the shared source-range vectors" +
`SourceRangeParityTests.cs`). Kabul/ret paritesi ölçülüyor: `sourceInUs >= 0`, `sourceOutUs
> sourceInUs`, `timelineDurationUs == roundHalfUp((sourceOutUs − sourceInUs) / rate)`.
İncelik: C# hakemi (`ExportCompiler.Validate`) frame-grid'i kaynak-aralığından ÖNCE
denetlediği için tüm süreler 30fps ızgarasına oturacak seçildi; geçersiz vakalar ızgara-geçerli
süre tutup yalnız kaynak-aralığı kuralını ihlal ederek onu izole ediyor. Half-up SINIRININ
kendisi ızgara-hizalı gösterilemez (.5 → +1 µs, ızgara dışı) ve zaten `time-vectors.json`
'duration' ile ölçülüyor — bu yeni dosya FORMÜLÜ değil BELGE reddini kapatır. Negatif kontrol:
bir geçerli vaka bozulunca iki taraf da kırmızıya döndü, geri alınca md5 aynı.

**Kalan üç aile de KAPANDI (backend borç turu, 2026-08-21) — aile başına bir vektör dosyası,
iki dilde tüketim, dosya başına negatif kontrol (boz → İKİ taraf kırmızı → geri al, md5 aynı):**

- **Keyframe sıralaması** → `keyframe-order-vectors.json` (8 vaka; her vaka opacity VE volume
  kanalında) — `invariants.test.ts` "matches the shared keyframe-order vectors" +
  `KeyframeOrderParityTests.cs`.
- **Klip yerleşimi** → `clip-placement-vectors.json` (8 vaka: bitişik/boşluklu/zincir kabul;
  yarım-klip/tek-kare çakışma, özdeş aralık, sırasız listeleme ret) —
  `invariants.test.ts` "matches the shared clip-placement vectors" + `ClipPlacementParityTests.cs`.
- **Geçiş simetrisi** → `transition-symmetry-vectors.json` (16 vaka: bitişiklik, derin-eşitlik,
  ızgara/çift-kare/üst-sınır, hız-farkında BAŞ el payı, still-görsel muafiyeti) —
  `invariants.test.ts` "matches the shared transition-symmetry vectors" +
  `TransitionSymmetryParityTests.cs`. KUYRUK payı bilinçli KAPSAM DIŞI: asset süresi ister,
  C# hakemi (`ExportCompiler.Validate`) o süreyi göremez — parite ancak aynı bilgiyle ölçülür
  (zod tarafı da `assetDurations` vermeden koşar).

**Bu aile GERÇEK bir ayrışma da yakaladı ve kapattı:** zod'un el payı formülü naif
`roundHalfUp(D/2 × rate)` idi; derleyici yarımı KARE DEFTERİNDEN türetir
(`halfUs = UsOf(dFrames/2)`), ve `UsOf(dFrames)` TEK sayı olduğunda ikisi ±1 µs ayrışır —
30fps'te 14 karelik geçiş (466 667 µs) için zod 233 334 µs isterken derleyici 233 333 µs
istiyor, yani editör kapısı renderer'ın kabul ettiği bir belgeyi REDDEDİYORDU (yanlış ret).
`invariants.ts` `transitionHandleUs` artık kare-defteri yarımını kullanıyor;
`half-frame-ledger-boundary` ve `minimum-two-frame-transition` vakaları sınırı iki dilde
sabitliyor (düzeltme geri alınırsa vitest kırmızı olur).

## Backend borç kapatma turu (2026-08-21 — sekiz kalem)

Bu turda kapatılanlar (her biri kendi bölümünde işaretlendi; kanıtlar test adlarıyla):

1. **Disk rezervasyonu tahmini** → kaynak bit hızına bağlandı (12. tur maddesi, yukarıda).
2. **Kota türevleri sayıyor** → `Asset.DerivedBytes` + migration (12. tur maddesi, yukarıda).
3. **LRU süpürmesi ölçüldü** → `OriginalCacheLruTests` (12. tur maddesi, yukarıda).
4. **Birim testi makine cache'i** → izole kök + nöbetçi testi (12. tur maddesi, yukarıda).
5. **Container hardening (kısmi) + Dockerfile restore + per-device logout** → M6 tablosu.
   NOT: per-device logout ROTAYI değiştirdi (`/api/auth/logout` → `/api/auth/refresh/logout`;
   `docs/design/03` uç listesi güncellendi); frontend `entities/auth.ts` yeni rotayı çağırıyor
   ve artık Authorization başlığı GEREKMİYOR (kimlik cookie'nin kendisi — süresi geçmiş access
   token'la da çıkış yapılabilir).
6. **Pis-dosya korpusu (M4 dalga 3)** → `DirtyMediaCorpusTests` (kapsam tablosu satırı).
7. **Belge-değişmezi parite aileleri (kalan üç)** → 14. tur bölümü; artı zod el-payı ±1 µs
   yanlış-ret düzeltmesi (`invariants.ts` `transitionHandleUs`).
8. **Doğrulama koşumları (bu makinede):** `dotnet build -warnaserror` 0 uyarı/0 hata;
   `MINIO_AVAILABLE=1 dotnet test` **1371/1371, skip 0**; timeline-schema vitest 196/196;
   `pnpm --filter @videoedit/editor exec tsc -b` temiz. Docker: `videoedit-api:hardened` ve
   `videoedit-worker:hardened` yerelde build edildi; konteyner içi `id` = `uid=1654(app)`,
   HEAD Dockerfile'ıyla build edilen kontrol imajı `uid=0(root)`.

**Bu turun AÇIK bıraktıkları / notları:**

- **[AÇIK — DÜŞÜK] Seccomp + ffmpeg CPU kaynak sınırı** (denetim #35'in kalan yarısı) —
  non-root ile daralttık, süreç-düzeyi sınırlar hâlâ yok.
- **[NOT — DAĞITIM] `AddAssetDerivedBytes` migration'ı** canlı/dev Postgres'e HENÜZ
  uygulanmadı (bu tur canlı servislere bilerek dokunmadı; koşan eski ikililer kolonu
  bilmediği için etkilenmez). Yeni ikililer devreye alınmadan ÖNCE `--migrate-only`
  koşulmalı — aksi halde kota sorguları `DerivedBytes` kolonunu bulamaz.
- **[NOT — DAĞITIM] Worker volume sahipliği:** root döneminden kalan MEVCUT bir
  `worker_data` volume'u root sahipli kalır; bir kez
  `docker compose run --user root worker chown -R app:app /data` gerekir
  (Worker/Dockerfile içindeki not).

## 14. tur denetim TRİYAJI (2026-08-21 — LUT/export/auth dalgasının bulguları)

Triyaj sahibi bu turda kapattı: **BULGU-1** (CubeLutValidator ↔ ffmpeg bayt-düzeyi parite —
7 tehlikeli-yön sapması: BOM×3, boşluksuz `LUT_3D_SIZE2`, öndeki boşluk, yalnız-CR, bitişik
`DOMAIN_MIN0`; `CubeLutFfmpegParityTests` canlı ffmpeg golden'ı), **BULGU-2** (logout'la
iptal edilen halefsiz token'ın replay'i artık theft cascade'i tetiklemiyor —
`RefreshFailure.Revoked`), **BULGU-3** (önizleme-kelepçe/export-422 asimetrisi
rendering-semantics §4.2'de beyan; DEV kapısının invariant kural 6 ile pre-catch ettiği
teyit), **BULGU-5** (doküman iddiaları gerçeğe indirildi), BG **B1-B6** (LUT satırı '0:00',
yazım hatası, LUT doku GC, `invalid-lut` Türkçe etiketi, LUT silme cümlesi, B6 ölçüm notu)
ve perf listesinden **media-urls paralelleştirmesi** (8'lik eşzamanlılık kapağı).

### AÇIK borçlar (milestone eşlemeli)

- **[YÜKSEK — KAPANDI, 2026-08-24 yarim-is turu] 2160p bellek kabul kapısı** (baş mimar
  BULGU-4 = perf raporu §9-2): ÖNCE ÖLÇÜLDÜ — 6 taban + 4 tekrar gerçek render
  (720p/1080p/2160p × düz kesim/bileşim, perf20 projeleri) `PeakWorkingSet64` ile: tepe
  RSS'i SÜRE değil, (a) çıktı profili pikselleri (kodlayıcı: düz kesim 461→910→2 921 MB)
  ve (b) eşzamanlı görsel giriş × TUVAL pikselleri (bileşim grafiği profilden bağımsız
  ~2,1-2,5 GB ekliyor; comp-720p 3 013 ≈ comp-1080p 3 009-3 306; comp-2160p tepe 5 563 MB —
  perf turunun 500 ms örneklemli 4 908'i alt sınırmış) sürüyor. Kapı:
  `ExportJob.EnsureMemoryAsync` — render başlamadan kullanılabilir fiziksel belleğe karşı
  (`EstimateRequiredMemoryBytes`, ölçülen her noktayı kapsayan üst bant + %20 pay;
  eşzamanlılık süpürmesi `MemoryEstimateInputs` — ardışık 500 klip 500 çözücü SAYILMAZ,
  yanlış ret yok); disk kapısının bekle/başarısız deseni: geçici darlıkta `memory-wait` ile
  2 dk erteleme, son denemede tipli `Failed('insufficient-memory')`. Windows okuyucusu
  `GlobalMemoryStatusEx`→**`ullAvailPageFile` (commit boşluğu)** — İKİ ÖLÇÜMLE seçildi:
  ilk sürümün `ullAvailPhys` okuması canlıda 2160p'yi yanlış reddetti (tahmin 7,0 GiB >
  fiziksel-boş 4,9 GiB), oysa aynı yükte aynı render iki kez başarıyla koşmuştu (Windows
  talepte diğer süreçlerin çalışma kümelerini kırpar; gerçek OOM sınırı commit'tir — o an
  commit boşluğu 38,7 GiB ölçüldü). Linux min(`/proc/meminfo MemAvailable`, cgroup
  limit−kullanım — v2/v1; compose'un 6g limiti konteynerde ancak böyle görülür, dosya
  yerleşimi limitli konteynerde ölçüldü; sonuç notu `poc-bilinen-sinirlar.md` §4.6);
  ölçülemezse -1 = kapı atlanır. Kanıt:
  `ExportMemoryEstimateTests` (canlı korpus sabitli + gerçek render'da `ProcessStarted`
  kancasıyla tepe ölçümü) + `ExportJobTests` bekle/başarısız/atlama yolları (enjekte
  okuyucu) + canlı 2160p/1080p/720p exportların kapıdan etkilenmediği koşularak doğrulandı.
  4K işlerine ayrı kuyruk/tek-uçuş kuralı bu kapsamda GEREKMEDİ (WorkerCount=1 zaten tek
  uçuş; eşzamanlılık artırılırsa kapı hazır).
- **[YÜKSEK — KISMEN KAPANDI, 2026-08-24 filtre-grafiği turu] Bileşimli render hızı**
  (perf §"filtre grafiği" + §6.1 önce/sonra tablosu): önce maliyet profili çıkarıldı
  (çıkar-koş-ölç bisect; canlı worker'ın gerçek grafiği + birebir girdiler; ham veri
  scratchpad `perfcost/`): 1080p'de payların **%46'sı tek başına `blend=all_expr`** (LUT
  intensity<1 yolunun per-piksel AVExpr yorumlayıcısı), %19 tamamen örtülü metin+şekil
  zincirleri, %10 colorAdjust, %6 kodlayıcı; süre çözünürlüğe duyarsız (2160p = aynı grafik
  + tek scale). UYGULANAN (tek net kazanç): `ClipEffects.LutBlendFilter`
  yerli moda alındı (`blend=all_mode=normal:all_opacity=1-intensity`; §4.2 formülü
  değişmedi, yalnız yazılışı). Eşdeğerlik İÇERİĞE BAĞLI (2026-08-25 tam (A,B) taraması):
  dyadik intensity'de bayt-aynı, dyadik olmayanda tamsayı-denk çiftlerde tam ±1 LSB
  (i=0.8'de 65.536 çiftin 1201'i, i=0.6'da 208'i; zarf + golden sınır testi
  rendering-semantics §4.2 — bench fixture'ının framemd5 BAYT-AYNI + PSNR=inf ölçümü o
  içeriğe özgü, genelleme değil); canlı önce/sonra
  (aynı yöntem, 3'er koşum): **720p 0,89x→1,69x, 1080p 0,87x→1,60x, 2160p 0,76x→1,27x**;
  düz kesim 11,5x etkilenmedi; aynı belgenin run27/run28 çıktı MP4'leri sha256-aynı, grafik
  diff'i tek satır. Negatif kontrol (2026-08-25'te TAM pakette yeniden ölçüldü; önceki "3
  bekçi" beyanı eksikti): yalnız `LutBlendFilter` gövdesi geri alınınca **6 test kırmızı** —
  `TheGraphNeverInvokesThePerPixelExprInterpreter` + kültür testi + lut-effects snapshot +
  `Lut3d_AppliesTheCubeFile…` + LSB sınır golden'ı + GateInventory kaynak-token envanteri;
  geri konunca dosya MD5 birebir. ÖLÇÜMLE KAPANAN eski maddeler: (1) threads taraması —
  varsayılan zaten optimum (fc_threads 1→450,9 s … auto→68,7 s; encoder -threads etkisiz);
  (2) no-op scale/pad/fps — pad+fps kazanç 0,0 s, scale'i çıkarmak +1 s yavaş + BT.601
  kayması + §2.5 doktrin ihlali; (3) enable/etkin-aralık daraltması — ≤2-3 s üst sınır.
  **AÇIK KALANLAR (sırayla, hepsi sözleşme/golden kararı ister):** (a) örtülen-katman
  budaması — bu fixtürde −13,2 s ve BAYT-AYNI ölçüldü, ama muhafazakâr kapsama tespiti
  probe boyutu (aspect==tuval) + alfa bilgisine muhtaç; `ExportAssetSource.SourceWidth`
  sözleşmesi ("üretilen filtergraph'ı HİÇBİR biçimde etkilemez — geometri kaynaktan
  bağımsız kalır, §2.5") değiştirilmeden yapılamaz ve yanlış probe'un bedeli sessiz eksik
  katman olur → baş mimar sözleşme kararı (Ek: Sözleşme Değişiklik Kuralı) + gerçekçi
  (overlay'leri ÜSTTE) bir fixtürle yeniden ölçüm şart — perf fixtüründe metin/şekil en
  üst katmanın ALTINDA, gerçek bileşimde kazanç 0'a düşebilir; (b) colorAdjust zincir
  füzyonu (exposure+2×lutrgb+colorchannelmixer → tek geçiş): pay 7,2 s, füzyon varyantı
  ÖLÇÜLMEDİ, piksel LSB kayabilir (golden'lar yeniden temellenir); (c) tuval-atlama
  genişletmesi: −3,1 s + belgeli tuval renk-kaybını da giderir ama ÇIKTI BAYTLARI değişir;
  (d) zaman-dilimli N-paralel ffmpeg — tek grafik zaten ~13,5/20 çekirdek kullanıyor,
  kazanç tavanı sınırlı. Hedef (1080p ≥2x) bu turda karşılanmadı (1,60x); (a)+(b)+(c)
  birlikte bu fixtürde ~2,5x'e taşırdı (bench üst sınırı).
- **[ORTA — KAPANDI, 2026-08-24 yarim-is turu] media-urls manifest'i Assets satırına yazmak**
  (perf §"GET media-urls"): paralelleştirme önceki turda yapılmıştı; bu turda kalıcı çözüm
  teslim edildi. ÖNCE ölçüldü (perf yöntemi; 55 assetli proje ham API'yle kuruldu): mevcut
  paralel hal 1/15/55 asset p50 4,24/12,82/34,72 ms — hâlâ doğrusal; pay ayrıştırması baskın
  maliyetin storage GET'i (MinIO manifest.json p50 1,07 ms) değil presign İMZALAMA CPU'su
  olduğunu gösterdi (`GetPreSignedURL` 244,9 µs/çağrı × ~7/asset). Çözüm: `ProcessAssetJob`
  filmstrip manifest'ini `Assets.FilmstripManifest` jsonb kolonuna da yazar (migration
  `AddAssetFilmstripManifest`, DerivedBytes deseni: NULL = eski asset → çağrı anındaki
  storage-GET yolu YEDEK olarak yaşar, backfill bilinçli YOK — gerekçe `Asset.cs` yorumunda);
  `AssetMediaUrlBuilder.BuildAsync` iki kademeli okur; media-urls döngüsü `Task.Run` ile
  gerçek CPU paralelliğinde (eşzamanlı presign güvenliği ÖLÇÜMLE doğrulandı: 16 iş parçacığı ×
  32 000 çağrı sıfır istisna + imzalı URL'ler MinIO'dan 200). SONRA: yeni işlenmiş 1/15/55
  asset p50 **2,33/3,93/9,30 ms** (55'te 3,7×; asset başına marjinal 0,56 → 0,13 ms); eski
  asset'ler yedek yolda 17,06 ms'e indi ve yanıt şekli önce↔sonra birebir. Kanıt: iki yol da
  testli (`AssetMediaUrlBuilderTests` DB/yedek/parite/traversal, `AssetEndpointsTests`
  MediaUrls DB'li + NULL-yedekli, `ProcessAssetPipelineTests` MinIO'lu gerçek koşumda jsonb
  kopya ↔ storage manifest.json eşitliği); negatif kontrol (DB yolu geri alınınca 5 test
  kırmızı, md5 birebir geri); canlıda demo + yeni projelerde 200 ve sprite GET 200.
  Ayrıntı: [`performans-raporu.md`](performans-raporu.md) §9-4 KAPATILDI notu.
- **[ORTA — dev ortamı] Çok-GB ingest'te paylaşılan Docker/WSL2 diski** (perf §"Altyapı"):
  aynı 1,4 GB dosyada part-PUT 14-267 MB/s dalgalanıyor, aynı pencerede Npgsql bağlantı
  zaman aşımı uyarıları (MinIO+Postgres aynı sanal diskte). Dev compose'ta MinIO volümünü
  ayrı fiziksel diske almak + Npgsql zaman aşımı günlüklerini izlemeye almak; yük testleri
  bu dev diskinde yanıltıcı ölçülür (prod R2'de bu kip yok — R2 dağıtımı ayrıca kapsam dışı).
- **[DÜŞÜK — M1 iyileştirme] Uzun medyada filmstrip payı** (perf §"İşleme"): 600 sn videoda
  filmstrip 12-15 s (~%21). Sprite kare aralığını süreyle logaritmik seyreltmek ya da
  filmstrip'i önce biten proxy'den üretmek; 10 dk medyada 5-10 s kazanç.
- **[DÜŞÜK — M2 iyileştirme] PUT /timeline gövde sıkıştırması** (perf §"Kaydetme"): 500 klip
  = 240 KB gövde; gerçek ağda (~5 Mb/s upstream) ~400 ms/kayıt hesaplanıyor (ağ süresi
  ölçülmedi, boyut ölçüldü). İstek gövdesine gzip (`UseRequestDecompression` maddesi zaten
  M2'de) + orta vadede delta-save; ProjectRevisions büyümesi snapshot politikasıyla izlensin.
- **[DÜŞÜK — editör, yalnız DEV] Mutasyon başına doküman kapısı** (perf §"Editör"): 500
  klipte 3,1 ms p50 — bugün taban çizgisinden ayrışmıyor; 1000+ klipte sürükleme
  commit'lerinde hissedilmeden büyük belgelerde örnekleyerek (her N. commit) ya da yalnız
  değişen track'i doğrulayan artımlı yolla koşulmalı. Şimdilik aksiyon YOK (izleme kaydı).
- **[DÜŞÜK — bilinçli kapsam dışı, 2026-08-25 B-kenar/bezier dilimi] Opacity/volume aralık
  kapıları hâlâ keyframe DEĞERLERİNİ okur, eğriyi değil:** ölçek kapıları örneklenen eğrinin
  kapalı-form ekstremumuna taşındı (rendering-semantics §3.1 serbest-`y` notu), ama
  `KeyframeCompiler.Parse`'ın opacity `[0..1]` / volume `[0..2]` kapıları bilerek keyframe
  değerlerinde bırakıldı. Overshoot'lu serbest `cubicBezier` (yalnız ham API) örneklenen
  opacity/volume'u aralık dışına taşıyabilir; sonuç ölçekteki gibi kırık geometri/ffmpeg
  hatası DEĞİL — opacity `colorchannelmixer aa=` içinde piksel düzeyinde kırpılır, volume
  ffmpeg/WebAudio'da aynı katsayıyla uygulanır (önizleme↔export paritesi bozulmaz; negatif
  volume faz çevirir). Eğri-ekstremum altyapısı hazır (`AnimationTrack.CurveMin/CurveMax`);
  kapıları eğriye taşımak bugün kabul edilen belgeleri reddedeceğinden sözleşme kararı ister
  — ihtiyaç doğarsa baş mimara.

## Kayda geçen doğrulamalar (aksiyon gerekmez)
- Restore'da "PreRestore satırı görünmüyor" davranışı veri kaybı DEĞİL — aynı revision'da zaten snapshot varsa terfi ediliyor; invaryant korunuyor (denetim #32).
- `.gitignore` üretilen-artefakt-commit'lenir kararıyla tutarlı (denetim #37).

## B borçları kapanış doğrulamasından (2026-08-25, 90d5f9f) — iki yeni düşük kayıt

- **[DÜŞÜK — işletim prosedürü] Bayat dist tuzağı:** editör paketi (Vite dev dahil) timeline-schema'yı
  `dist`'ten çözer; "backend yayını + Vite restart" tek başına schema paketini TAZELEMEZ —
  `pnpm --filter @videoedit/timeline-schema build` adımı gerekir (CI'da var; canlı ortam
  prosedüründe yazılı değildi, kapanış doğrulaması bunu tazelik iğnesiyle yakaladı: bezier
  commit'i sonrası dist 21.08'den kalmaydı ve editör TS yarısını hiç görmeyecekti).
- **[DÜŞÜK — sözleşme adayı] Export tamamlanma yazımı son-yazan-kazanır:** terminal duruma
  (Failed/stalled) çekilmiş bir satırın üstüne tamamlanma yolu Succeeded+OutputKey yazabiliyor
  (ölçüldü: satır flip'inden sonra render 10 sn'lik yoklamadan önce doğal bitince). Üretimde
  reaper yalnız 6 saat kalp-atışsız satırı çevirdiğinden pencere pratikte açılmaz; yine de
  tamamlanma UPDATE'ine durum-koşulu eklemek ayrı bir sözleşme kararı olarak durur.
