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
| Çoklu katman timeline | ✅ tam ⚠︎ track yeniden sıralama/adlandırma yok | sonraki dilim |
| Kırpma/kesme/ayırma/taşıma/katman | ✅ tam (frame ızgarası çelişkisi teslim düzeltme turunda kapandı — aşağıya bakınız) | — |
| Frame, zoom, timecode, player, kısayollar | ✅ tam | — |
| Undo/Redo + işlem geçmişi | ✅ tam | — |
| Hesap + proje yönetimi, autosave | ✅ tam (versiyon geçmişi UI'ı M6'da geldi) | — |
| **Ses katmanları** (waveform, seviye, fade, detach) | ✅ tam (M4 dalga 1) ⚠︎ *dışa aktarma yolu 8. tura kadar KIRIKTI — aşağıya bakınız* | — |
| **Çoklu katman export + transform** | ✅ tam (M4 dalga 1) | — |
| **Görseller (PNG/JPG/WebP)** | ✅ tam (önizleme kusuru teslim düzeltme turunda kapandı — aşağıya bakınız) | — |
| **Yazı & overlay** (metin, sticker, şekil) | ✅ tam (M4 dalga 2) ⚠︎ emoji yok; shaping iki motorda | sonraki dilim |
| **Geçişler** (xfade/acrossfade) | ✅ tam (M4 dalga 2 — doküman/op/export + oynatıcı önizlemesi) ⚠︎ dissolve/fadeToBlack önizlemesi piksel-eşit değil | parity → dalga 3 |
| Pis-dosya korpusu (iPhone HDR/VFR/döndürülmüş) testleri | ❌ yok | **M4 dalga 3** |
| **Renk düzeltme — colorAdjust** (parlaklık/kontrast/doygunluk/sıcaklık/ton/pozlama) | ✅ tam (M5 — Inspector + önizleme shader'ı + export) | — |
| **Filtreler — LUT (.cube)** | ⚠️ yalnız export + şema hazır; **editör UI'ı VE önizleme shader'ı YOK** (dört bacağın ikisi) — **M6'da yapılmadı** | **sonraki dilim** |
| **Hız değiştirme** (slow-mo/timelapse) | ✅ tam (M5) ⚠︎ hız rampası yok | sonraki dilim |
| **Keyframe animasyonları** | ✅ tam (M5, sınırlarıyla — aşağıya bakınız) ⚠︎ `fx.*` kanalı yok | sonraki dilim |
| **1-2 GB'lık dosyalarda performans** ("dosya boyutları ortalama 1-2 gb aralıklarında oluyor… performanslı ve hızlı olmalı") | ⚠️ **bir kez uçtan uca ÖLÇÜLDÜ** (12. tur; 1,51 GiB / 10:40 kaynak: seçiciden "Hazır"a **75,6 sn**, 60 sn'lik kesimin export'u **19,5 sn**, tam 10:40'ın export'u **184 sn**) — ama **TEK koşum, TEK makine, LOKAL nesne deposu**; gerçek ağ/R2, eşzamanlı kullanıcı, >2 GB ve LRU süpürmesi **ölçülmedi** | ölçüm: [`poc-bilinen-sinirlar.md`](poc-bilinen-sinirlar.md) §0.1 · açık borçlar: aşağıdaki "12. tur" |
| **R2'de saklayıp SONRADAN tekrar düzenleme** | ⚠️ İKİ YARI AYRI: "sonradan tekrar düzenleme" ✅ gerçek fare/klavyeyle ölçüldü (düzenle → "Kaydedildi" → çıkış → yenile → yeniden giriş → seçici → aynı belge + aynı medya); "**R2'de saklayıp**" ❌ **gerçek Cloudflare R2 HİÇ denenmedi** — dev de CI da MinIO | R2 doğrulaması: **ilk gerçek dağıtım** ([`poc-bilinen-sinirlar.md`](poc-bilinen-sinirlar.md) §4.2 + [`deploy/README.md`](../deploy/README.md) §4) |

> **M6 KAPSAM KAYDI (review-gate kural 4, 2026-08-12).** M6 planı bu dosyada altı madde
> listeliyordu; teslim edilen M6 **iki** maddedir: **sürüm geçmişi UI'ı** (`features/versions`,
> e2e `versions.spec.ts`) ve **kota/silme UX'i** (`quotaModel.ts`, `AssetDeleteDialog.tsx`,
> e2e `library-manage.spec.ts`). Yapılmayan dört madde sessizce düşmedi, aşağıdaki
> "M6 (Dayanıklılık)" bölümünde **açık** kalmaya devam ediyor: `fx.*` keyframe'i,
> LUT editör yüzeyi, revision retention job, container sertleştirme (+ per-device logout,
> Dockerfile restore, tsconfig.node tip denetimi). Bunların hepsi
> [`docs/poc-bilinen-sinirlar.md`](poc-bilinen-sinirlar.md) §1.3, §4.3, §4.5, §4.6'da
> kullanıcıya da anlatıldı.

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
> Kalan iş yalnız editör yüzeyidir: `.cube` yükleme yolu (`fileTypes.ts` whitelist'i +
> backend contentType whitelist'i + probe'suz asset türü), efekt UI'ı ve önizleme
> shader'ında 3D doku örneklemesi.

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
- **Dalga 3**: pis-dosya korpusu (iPhone HLG, WhatsApp re-encode, OBS VFR, dikey/döndürülmüş MOV) uçtan uca testleri + parity sertleştirme.

## M1 (Upload + işleme)
- **Waveform üretimi .NET içinde**: `audiowaveform` Debian'da paket olarak yok (denetim bulgusu #6); karar — worker ffmpeg ile PCM çekip C#'ta min/max pencereleme yapacak (tasarım `docs/design/02` §3.5'teki alternatif). Dockerfile'dan bağımlılık kaldırıldı.
- **Rate limiting**: auth (login/register) ve asset presign/init endpoint'leri (`AddRateLimiter`); denetim #5/#19 bağlamı.
- **compose R2__\* env adları ↔ backend config binding birebir eşleşme testi** (R2 istemcisi M1'de yazılırken; denetim #36 notu).

## M2 (Timeline + player + autosave UI)
- **Request decompression middleware**: plan "tam doküman, gzip" diyor; frontend gzip göndermeden önce `UseRequestDecompression` eklenmeli (denetim #5c).
- **409 sonrası UX**: "başka sekmede değişti" diyaloğu + SignalR ile pasif sekme bilgilendirme (plandaki bilinçli MVP kabulü).

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

- **`dissolve` deseni ve `fadeToBlack` eğrisi ffmpeg ile birebir değil.** Önizleme
  dissolve'da kendi hash gürültüsünü, fadeToBlack'te düz lineer rampayı kullanıyor;
  ffmpeg'in PRNG'si ve `smoothstep` yumuşatması farklı (tablo: rendering-semantics §5.3).
  Gözle fark edilmez ama **piksel-eşit değildir** → bu iki tip için golden-frame
  preview↔export karşılaştırması yazılamaz. Hedef: M4 dalga 3 (pis-dosya korpusu + parity
  sertleştirme) içinde xfade referans karelerinin çıkarılması.
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
- **[ORTA — AÇIK] Inspector'ın "ripple'sız en yavaş hız" sınırı yarım kare eksik.**
  `clipInspectorModel.minRateWithoutRipple` (`clipInspectorModel.ts`) sınırı İDEAL süreden
  türetiyor (`(sourceOut − sourceIn) / (süre + boşluk)`, sonra 3 ondalığa yukarı yuvarlama);
  ızgara snap'i yarım kare ekleyebildiği için panelin önerdiği oran reddedilebiliyor. Ölçülen
  vaka (30 fps): klip frame 2'de (66_667 µs), 1 kare kaynak, sonraki klip frame 4'te
  (133_333 µs) → oda 66_666 µs, panel 0.5x öneriyor, op "sonraki klibe giriyor" diyor.
  Ret ATOMİK ve gerekçesi doğru (UI "Sonrakileri kaydır" sunuyor), veri kaybı yok; doğru
  düzeltme sınırı ızgaraya göre hesaplamaktır — `features/inspector` alanı.
  Davranış testle SABİTLENDİ (`speedColorOps.test.ts`: *"a slow-down that does NOT fit refuses
  atomically — it never overlaps, and never quietly shortens"*), böylece sessizce overlap'e
  dönüşemez.

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

### Diğerleri (düşük/orta) — hepsi HÂLÂ AÇIK

- **Track yeniden sıralama / yeniden adlandırma yok.** `timelineOps` yalnız `addTrack`
  ve `deleteTrack` sunar; track sağ tık menüsü (`contextMenu.trackMenu`)
  yapıştır + üç bayrak + silme ile sınırlı. `addTrack` diziye **sona** ekler (`d.tracks.push`),
  `tracks[0]` en üst katmandır — yani katman sırası ancak track'leri doğru sırada ekleyerek
  kurulabiliyor.
- **Ölçek animasyonu + dönme bileşimi export'ta reddediliyor**
  (`ExportCompiler.ValidateGeometry`, `scale-keyframes-with-rotation`). Gerekçe doğru (ffmpeg `rotate`
  çıkış tuvalini bir kez kurar, büyüyen girişi sessizce kırpardı) ve hata tipli — ama
  **editör bunu önceden uyarmıyor**, kullanıcı 422'yi export anında görüyor. Proaktif rozet
  M3 backlog'undaki "kapsam haritasının UI'da gösterimi" maddesiyle aynı ailedendir.
- **Keyframe örnek bütçesi 60 000** (`ClipAnimation.MaxSamples`) — tipli hata verir
  (`keyframe-sample-budget`), editörde önden uyarı yok.
- **Katman boyut tavanı 8192 px** (`LayerGeometry.MaxLayerDimension`) — *bu satırın "editörde önden uyarı
  yok" iddiası YANLIŞTI, düzeltildi (3. tur).* Editör ölçek alanının tavanını proje
  çözünürlüğünden türetiyor (`invariants.maxScaleFor` → `timelineOps.maxClipScale`, 1080p'de
  ~4.266) ve yazma anında kırpıyor. **Kalan gerçek boşluk:** editörün tavanı ölçek
  KUTUSUNDAN, derleyicininki ARA TUVALDEN hesaplanır — dönme (~1.41×) ve merkez dışı çapa
  (2×) ara tuvali büyütür, dolayısıyla dönmüş bir katman editörün izin verdiği ölçekte hâlâ
  `transform-scale` 422'si alabilir. Editör tarafının dönmeyi hesaba katması açık iş.
- **Tek export profili.** `ExportProfiles.cs` yalnız `Hd1080p` tanır; 720p/4K/dikey ön ayarı yok.
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
| LUT editör yüzeyi **+ önizleme shader'ı** | `apps/editor/src/features/library/fileTypes.ts` `SUPPORTED_EXTENSIONS` içinde `.cube` yok; ayrıca `rendering-semantics.md` §4.2'nin NORMATİF önizleme uniform'ları (`uLut3D`, `uLutScale`, `uLutOffset`) `apps/`+`packages/` altında **0 kez** geçiyor — `player/core/resolve.ts` `colorAdjustOf` yalnız `colorAdjust` okur |
| Revision retention job | `backend/src/VideoEdit.Worker/Program.cs` (`AddOrUpdate<AssetReaperJob>`) — kayıtlı tek yinelenen iş `asset-reaper` |
| Container hardening | `Api/Dockerfile` + `Worker/Dockerfile` içinde `USER` direktifi **0 kez** geçiyor |
| Per-device logout | `AuthEndpoints` `RevokeAllForUserAsync` — tüm cihazlar düşer |
| Dockerfile restore (sln üyesi tüm csproj) | `Api/Dockerfile`'ın restore katmanı **6** csproj kopyalıyor (`COPY src/VideoEdit.*/…csproj` satırları); `backend/VideoEdit.sln` **8** csproj listeliyor (SchemaGen + UnitTests eksik) |
| `tsconfig.node.json` tip denetimi | `.github/workflows/ci.yml` ve `apps/editor/package.json` içinde geçmiyor (`build` = `check-public-assets` + `tsc -b` + `vite build`) |

- **fx.\* keyframe'i** (colorAdjust/LUT parametrelerinin animasyonu): şema `KeyframeTracks`
  STRICT olduğu için doküman düzeyinde de yok; kanal listesi + örnekleme + compiler ifadesi
  birlikte açılmalı (M5 kapsam kaydı).
- **LUT (.cube) editör yüzeyi + önizleme shader'ı**: `.cube` yükleme yolu (yeni asset türü)
  + efekt UI'ı + WebGL2 tarafında 3D doku örneklemesi (`sampler3D`, `uLut3D/uLutScale/uLutOffset`
  — `rendering-semantics.md` §4.2 bunları NORMATİF olarak tarif ediyor, kodda karşılığı yok).
  **İki ayrı iş kalemidir**: yalnız UI yazılırsa kullanıcı LUT'u seçer ama önizlemede hiçbir
  etkisini göremez. Export tarafı hazır (`ExportPlan.LutAssetIds`, `lut3d`).
- **Revision retention job**: plandaki "son 50 auto + eskilerde inceltme" (denetim #5).
- **Container hardening**: non-root `USER app` + volume sahipliği; worker için ayrıca seccomp/ffmpeg kaynak sınırları (denetim #35).
- **Per-device logout**: mevcut logout tüm cihazların refresh token'larını iptal ediyor — cihaz bazlı oturum yönetimi (denetim #30).
- **Snapshot'ın autosave ile aynı transaction'a alınması** değerlendirmesi: bugünkü tasarım "kaçan snapshot bir sonraki save'de telafi edilir" kabulüyle yaşıyor (denetim #29).
- **Dockerfile restore aşaması sln-üyesi tüm csproj'ları kopyalamalı** (SchemaGen/UnitTests) — bugün zararsız, sln-scoped restore'a geçilirse patlar (denetim #34).
- **apps/editor `tsconfig.node.json` tip-denetimi** build zincirine eklenmeli (denetim #36).

## M1 denetiminden ertelenenler (2026-08-07, 37 bulgu; kritik+yüksek tümü M1'de düzeltildi)
- **M2 (KISMEN AÇIK)**: IDOR korumaları kod olarak doğru ama regresyon test paketi **hâlâ
  eksik**. Bugün yalnız iki sahiplik testi var (`AssetUsageQuotaTests.Usage_OtherUsersAsset_Returns404`
  ve `Usage_IgnoresOtherUsersAndDeletedProjects`); projects/exports/timeline uçlarında başka
  kullanıcının `projectId`/`jobId`'siyle çağrı senaryoları **yok**. SignalR progress kanalı
  gelince `refetchIntervalInBackground` geçici çözümü kaldırılacak.
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

- **[DÜŞÜK — AÇIK] `GenerateDocumentationFile` kapalı: XML yorumları derleyici tarafından hiç
  denetlenmiyor.** Bu turda kapatılan F-1 bulgusu (bir `<summary>` bloğu YANLIŞ ÜYEYE yapışmıştı;
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
  - *Yapılacak:* kalan 14 uyarıyı kapat → `Directory.Build.props`'a
    `<GenerateDocumentationFile>true</GenerateDocumentationFile>` +
    `<NoWarn>$(NoWarn);CS1591</NoWarn>` ekle. Bundan sonra F-1 sınıfı bir hata **derlemede**
    yakalanır, denetimde değil — ve yukarıdaki gibi bir 22 uyarılık regresyon sessizce giremez.

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

- **[AÇIK] Tur numaralandırması kodda ayrıştı.** 8. turun bıraktığı bazı kod yorumları bu
  dilimi "6. tur denetimi" ya da "M6 denetimi" diye adlandırıyor
  (`ExportCompiler.EnsureAssetFacts` yorumu, `e2e/audio-export.spec.ts` başlığı). Dokümanlarda
  numaralandırma 8. tura göre düzeltildi; kod yorumları DOKUNULMADI (davranış değiştirmemek
  için) — bir sonraki kod dilimi bunları düzeltmelidir.
- **[AÇIK — 8. turun doküman yüzünde KOD OKUMASIYLA bulundu, ölçülmedi] "Sesi ayır" sessiz bir
  videoda da açık.** Yeni `asset-clip-type` kapısının "ses klibi + SESSİZ video" hücresi,
  matrisin editörden ULAŞILAMAZ sanılan tek istisnası olabilir: ses klibinin üçüncü üretim yolu
  `timelineOps.detachAudio`'dur ve `detachAudioBlockReason` varlığın sesi olup olmadığına
  bakmaz — editör `hasAudio` olgusunu (API `AssetSummary`'de DÖNER) hiçbir yerde okumaz
  (`grep hasAudio apps/editor/src` → 0 sonuç) ve `buildClipFromAsset` her video varlığında
  `audio` alanını dolu doğurur. Sonuç: sessiz bir videoda menü eylemi sunuluyor, belge
  dışa aktarmada 422 alıyor. **Sessiz bozulma yok** ve bu yol düzeltmeden önce de
  çalışmıyordu (worker'da ffmpeg hatası) — eksik olan ÖNDEN UYARI.
  - *Yapılacak:* `AssetSummary`'ye `hasAudio` alanını taşı (API zaten döner) ve
    `detachAudioBlockReason`'a "kaynağında ses yok" dalını ekle (menü otomatik olarak grileşir,
    aynı sözleşme). Gerçek fare e2e'si: sessiz video → sağ tık → "Sesi ayır" DEVRE DIŞI.
  - *Bu turda YAPILMADI:* doküman turu kod davranışı değiştirmez; ayrıca iddia **ölçülmedi**
    (Playwright koşulmadı), yalnız kod okumasıyla kuruldu — düzeltmeden önce ölçülmelidir.
- **[AÇIK] `.github/workflows/ci.yml` içinde doğrulanamayan bir sayı duruyor:** bir yorum
  satırı "temiz klonda 139 test bunsuz kırılır" diyor. Bu, paketin büyüklüğü (bugün 143) değil
  "kaç test kırılır" iddiasıdır ve ancak o adım kaldırılıp suite koşturularak ölçülebilir; bu
  doküman turu Playwright koşmadığı için DOKUNULMADI. Ya ölçülmeli ya sayısızlaştırılmalıdır.
- **[AÇIK] Ses parity'si (preview ↔ export RMS) hâlâ ölçülmedi** (`poc-bilinen-sinirlar.md`
  §2.6). N1 "ses çıktıda var ve seviyesi sıfır değil"i kanıtlar; "önizlemedekiyle aynı"yı
  KANITLAMAZ.
- **[AÇIK] Ses/müzik yolu demo senaryosunun ölçülmüş 41 adımına dâhil değildir.** Kalıcı
  testleri var, ama `demo-senaryosu.md` §7'nin koşumu bu adımı içermez ve demo medyası bir
  müzik dosyası üretmez (senaryoya not olarak yazıldı).

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

- **[AÇIK — B6/1, YÜKSEK sayılmalı] Modal odak yönetimi ürün tarafında YOK ve 143'lük E2E
  sayısı bunu gizliyor.** `apps/editor/e2e/a11y-smoke.spec.ts` içinde **7 test**
  `test.fail(true, FIXME_FOCUS)` taşıyor; Playwright bunları "passed" sayar, yani paket
  sayısı 143 olsa da o 7'si GEÇEN test DEĞİLDİR — "bugün başarısız olması beklenen"
  testlerdir. Kapsanan üç overlay (`ExportDialog.tsx`, `ShortcutsHelpOverlay.tsx`,
  `ConflictDialog.tsx`) `aria-modal="true"` yazar ama odak yönetimi uygulamaz: açılışta odağı
  içeri alma, odak tuzağı ve kapanışta odağı tetikleyiciye döndürme yoktur; `ExportDialog`
  Escape ile de kapanmaz. Sonuç: ekran okuyucuya "burası modal" denir, klavye kullanıcısı
  Tab'la diyaloğun ARKASINDAKİ düğmelere düşer.
  - *Yapılacak:* üç overlay'e odak yönetimi (açılışta ilk odaklanabilir öğeye odak, Tab/Shift+Tab
    tuzağı, kapanışta tetikleyiciye dönüş) + `ExportDialog` için Escape. Sonra
    `a11y-smoke.spec.ts`'teki 7 `test.fail(...)` satırı SİLİNMELİDİR (silinmezse Playwright
    "Expected to fail, but passed" ile kırmızı verir — bulgu kaybolamaz).
  - *Neden bu turda yapılmadı:* bu tur render hattının asılmasını kapattı; düzeltme `src/`
    yüzeyindedir ve kendi gerçek-girdi denetimini ister. **Kayıt burada olduğu için artık
    "sessizce ertelenmiş" değildir** (review-gate kural 4).
- **[AÇIK] Çıktı saati tavanı YALNIZ export reçetesinde açık.** Pay (%10 + 5 sn) export
  grafiğinin `out_time` davranışı ÖLÇÜLEREK seçildi (normal render'ın en büyük `out_time`'ı
  beklenen sürenin 66,7 ms ALTINDA). Varlık işleme reçeteleri (proxy/filmstrip/poster) farklı
  çıktı zaman tabanları kullanır ve o rejim ÖLÇÜLMEDİ; tavan oraya sessizce sızmasın diye
  `RunAsync`'te AÇIK parametredir. O reçeteler bugün yalnız sessizlik bekçisiyle korunuyor.
  - *Yapılacak:* her reçetenin `out_time` davranışını ölçüp kendi payını seçmek.
- **[AÇIK] Reaper'ın süreç iptali TEK SÜREÇ kapsamındadır.** `RunningRenderRegistry` süreç içi
  bir sözlüktür; başka bir makinedeki worker'ın ffmpeg'i bu yoldan öldürülemez. Bugünkü kurulum
  tek worker olduğu için kapsam yeterli.
  - *Yapılacak (çok makineli kurulumda):* süreçler-arası bir iptal kanalı (ör. Hangfire iş
    iptali ya da DB bayrağının worker tarafında yoklanması).

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

- **[AÇIK — ORTA] Export'un disk rezervasyonu tahmini yüksek bit hızlı kaynakta KISA KALIYOR.**
  `ExportJob.EstimateRequiredDiskBytes` çıktıyı `ExportProfiles.EstimatedBitsPerSecond` =
  **10 Mbps** varsayımıyla hesaplıyor. Ölçüldü: 10:40'lık iş için "gerekli" 2 902 480 768 B
  dedi, ölçülen tepe kullanım **3 926 837 249 B** oldu (**1,35 kat**) — çünkü CRF18 `veryfast`
  grenli 1080p kaynakta **28,85 Mbps** üretti. Bu makinede ~390 GB boş alan vardı, kapı hiç
  ısırmadı; dar diskli bir kurulumda kapı "yeter" deyip render ORTASINDA disk bitebilir.
  - *Yapılacak:* tahmini ya kaynağın ölçülmüş bit hızına bağlamak (probe zaten elde) ya da
    profil varsayımını gerçek ölçüme çekip payı büyütmek. Ürün kodu bu turda **değiştirilmedi**
    (tur yalnız ölçüm + dokümandı).
- **[AÇIK — DÜŞÜK] Kota yalnız ORİJİNALLERİ sayıyor.** `UploadQuota.Evaluate` `Assets.SizeBytes`
  toplamını okur; türevler (proxy + filmstrip + waveform + poster) sayılmaz. Ölçüldü: türevler
  orijinalin **%7,7**'si (1,51 GiB kaynak → 119 MiB türev). Yani "20 GiB kota" gerçekte
  ~21,5 GiB'lik nesne deposu demektir ve fatura oradan gelir.
  - *Yapılacak:* ya türev boyutlarını da deftere yazıp kotaya katmak, ya da kotanın "yalnız
    orijinal" olduğunu ürün yüzeyinde (kitaplık göstergesinin başlığında) söylemek.
- **[AÇIK — DÜŞÜK] LRU cache SÜPÜRMESİ ölçülmedi.** Cache **orijinali** tutar; 20 GiB tavan
  bu boyutta ~13 kaynak alır. Ölçülen tek şey tavanın %7,5'inin bir dosyayla dolduğudur;
  14. dosyada devreye girecek süpürme (ve süpürülen kaynağın bir sonraki export'ta yeniden
  indirilmesi) **hiç koşulmadı** — bugüne kadar da koşulmamıştı.
  - *Yapılacak:* cache'i tavana kadar doldurup süpürmenin EN ESKİ girdiyi seçtiğini ve pinli
    (o an koşan export'un) kaynağını KORUDUĞUNU ürün düzeyinde ölçmek.
- **[AÇIK — DÜŞÜK] Ölçüm n=1.** §0.1'in tamamı **tek** koşumdur (yalnız 60 sn'lik export üç
  kez tekrarlandı ve üçünde de bayt sayısı aynı çıktı). Varyans, ısınma etkisi ve eşzamanlı
  kullanıcı yükü **ölçülmedi**; §4.1'in "tek eşzamanlı export" sınırı bu rejimde de geçerlidir.
- **[AÇIK — DÜŞÜK] >2 GB ve 4 GiB tek dosya tavanı denenmedi.** Kullanıcının aralığının üst ucu
  (2 GB) ölçüldü sayılmaz: ölçülen dosya 1,51 GiB'dir. `QuotasOptions.MaxFileSizeBytes` = 4 GiB
  ve `UploadRules.PartCount` o boyutta 64 parça üretir — ölçülmedi.
- **[AÇIK — ORTA] Birim testi MAKİNE GENELİNDEKİ gerçek export cache'ini SİLİYOR (ölçüldü).**
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
  veri siliyor** ve ölçümleri sessizce bozuyor.
  - *Yapılacak:* `CreateJobRunner`'a da test-yerel bir `CacheDirectory` vermek (diğer testlerin
    zaten yaptığı gibi). Ürün kodu bu turda değiştirilmediği için test de değiştirilmedi.
- **[AÇIK — ORTA] Bu turun İKİ ölçümü de KOŞULDU ama KORUNMUYOR.** İkisi de
  `e2e/.artifacts/` altında koşan, repoya girmeyen betiklerdi (`poc-bilinen-sinirlar.md` §5.1):
  otomatik pakette karşılıkları YOK, yani bir regresyon ikisini de sessizce kırar ve
  bir sonraki turda kimse fark etmez. Gerekçesi bilinçli (1,5 GiB'lık kaynak + 5+ dakikalık
  koşum her CI turuna sığmaz), ama borç borçtur.
  - *Yapılacak:* (a) "sonradan tekrar düzenleme" senaryosunun **gerçek medyalı** yarısı
    pakete alınabilir — mevcut `e2e/support/media.ts` fixture'ı (4 sn / ~2 MB) yeter, dosya
    boyutuyla ilgisi yok; (b) 1-2 GB rejimi için ayrı, ELLE tetiklenen bir "perf" projesi
    (Playwright `project`/tag) tanımlanıp CI'da nightly koşturulabilir.
- **[KAYIT] `EditorApp.fitButton` locator'ı BAYAT (test altyapısı, ürün değil).**
  `e2e/support/editor.ts` "Sığdır" adlı bir düğme arıyor; üründe düğmenin adı **"Fit"**
  (`TimelinePanel`). Bugüne kadar yakalanmadı çünkü `ensureContentVisible` yalnız klip ekranda
  DEĞİLSE tıklıyor ve mevcut spec'lerin kısa fixture'larında auto-fit zaten yetiyordu; 640 sn'lik
  klip ilk kez bu dalı zorladı ve locator 15 sn timeout ile düştü. Ölçüm betiği bu turda
  locator'ı baypas etti (`/^(Fit|Sığdır)$/`), **repo dosyası değiştirilmedi**.
  - *Yapılacak:* ya `fitButton`'ı ürünün adıyla hizalamak ya da düğmeye `data-testid` vermek.

## Kayda geçen doğrulamalar (aksiyon gerekmez)
- Restore'da "PreRestore satırı görünmüyor" davranışı veri kaybı DEĞİL — aynı revision'da zaten snapshot varsa terfi ediliyor; invaryant korunuyor (denetim #32).
- `.gitignore` üretilen-artefakt-commit'lenir kararıyla tutarlı (denetim #37).
