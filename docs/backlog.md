# Teknik Backlog — Baş Mimar Denetim Bulguları

M0 denetiminde (2026-08-06, 37 bulgu) tespit edilip **bilinçli olarak ertelenen** maddeler. Her madde hedef milestone'a eşlendi. Kritik + yüksek bulguların tamamı ve ucuz orta bulgular M0'da düzeltildi (bkz. git geçmişi).

---

## KAPSAM DURUMU — kullanıcının MVP listesi (review-gate kural 4)

M4 dalga 1 denetimi, seçilen MVP özelliklerinden altısının "eksik **ve kayıtsız**" olduğunu
tespit etti. Aşağıdaki tablo bundan sonra her teslim notunun kaynağıdır; buraya yazılmadan
hiçbir özellik ertelenmiş sayılmaz.

| MVP özelliği (kullanıcı seçimi) | Durum | Hedef |
|---|---|---|
| Çoklu katman timeline | ✅ tam | — |
| Kırpma/kesme/ayırma/taşıma/katman | ✅ tam | — |
| Frame, zoom, timecode, player, kısayollar | ✅ tam | — |
| Undo/Redo + işlem geçmişi | ✅ tam | — |
| Hesap + proje yönetimi, autosave | ✅ tam (versiyon geçmişi UI'ı hariç) | UI → M6 |
| **Ses katmanları** (waveform, seviye, fade, detach) | ✅ tam (M4 dalga 1) | — |
| **Çoklu katman export + transform** | ✅ tam (M4 dalga 1) | — |
| **Görseller (PNG/JPG/WebP)** | ✅ tam (dalga 1 + dalga 2 denetim düzeltmesi: geçiş de kurulabiliyor) | — |
| **Yazı & overlay** (metin, sticker, şekil) | ✅ tam (M4 dalga 2) | — |
| **Geçişler** (xfade/acrossfade) | ✅ tam (M4 dalga 2 — doküman/op/export + oynatıcı önizlemesi) | — |
| Pis-dosya korpusu (iPhone HDR/VFR/döndürülmüş) testleri | ❌ yok | **M4 dalga 3** |
| **Renk düzeltme / filtreler** | ⚠️ motor hazır, UI yok | **M5** |
| **Hız değiştirme** (slow-mo/timelapse) | ❌ UI yok | **M5** |
| **Keyframe animasyonları** | ❌ editör yok | **M5** |

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
  `fetch-fonts.sh`) ve worker'da `Fonts:AllowSystemFallback = false` yapılmalıdır. Bugün TTF'ler
  depoda olmadığından metin klipleri **sistem fontuyla** çiziliyor (2. mod, `fonts/README.md`):
  export başarılı ve uyarılı, ama **belirlenimci değil** (iki worker farklı piksel üretebilir)
  ve sistem fontları **yeniden dağıtılamaz** (lisans). POC için kabul, üretim için blocker.
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

## M6 (Dayanıklılık / hardening)
- **Revision retention job**: plandaki "son 50 auto + eskilerde inceltme" (denetim #5).
- **Container hardening**: non-root `USER app` + volume sahipliği; worker için ayrıca seccomp/ffmpeg kaynak sınırları (denetim #35).
- **Per-device logout**: mevcut logout tüm cihazların refresh token'larını iptal ediyor — cihaz bazlı oturum yönetimi (denetim #30).
- **Snapshot'ın autosave ile aynı transaction'a alınması** değerlendirmesi: bugünkü tasarım "kaçan snapshot bir sonraki save'de telafi edilir" kabulüyle yaşıyor (denetim #29).
- **Dockerfile restore aşaması sln-üyesi tüm csproj'ları kopyalamalı** (SchemaGen/UnitTests) — bugün zararsız, sln-scoped restore'a geçilirse patlar (denetim #34).
- **apps/editor `tsconfig.node.json` tip-denetimi** build zincirine eklenmeli (denetim #36).

## M1 denetiminden ertelenenler (2026-08-07, 37 bulgu; kritik+yüksek tümü M1'de düzeltildi)
- **M2**: IDOR korumaları kod olarak doğru ama regresyon test paketi yok — sahiplik ihlali senaryolarını (başka kullanıcının assetId/projectId'si) kapsayan endpoint testleri eklenmeli. SignalR progress kanalı gelince `refetchIntervalInBackground` geçici çözümü kaldırılacak.
- **M6**: Kota kontrolü check-then-act (bilinçli MVP kabulü) — eşzamanlı init'lerle sınırlı aşım mümkün; transactional/advisory-lock çözümü. Upload resume sertleştirme: dosya-değişti tespiti (ilk 1 MiB parmak izi), IndexedDB hayalet satırlarının tam yaşam döngüsü, FileSystemFileHandle akışı.
- **Not**: E2E fixture (`apps/editor/public/e2e-test-video.mp4`) gitignore'da; lokal `vite build` dist'ine kopyalanır — sürüm build'i öncesi silinmeli (commit'lere girmez).

## M2 denetiminden ertelenenler (2026-08-07, 33 bulgu; 4 kritik + 6 yüksek + tüm ortalar M2'de düzeltildi)
- **Düşük öncelikli 12 bulgu** ertelendi — tam liste `docs/audits/m2-denetim.json` içinde (tüm milestone denetim raporları artık `docs/audits/` altında arşivleniyor).
- **Teslimat-anı görsel doğrulama borcu**: playback'in görsel/işitsel doğrulaması ve gerçek pointer ile library sürükle-bırak, gizli tarayıcı panelinde yapılamadı (rAF duraklı + untrusted gesture) — görünür panelde/kullanıcı testinde doğrulanacak; M3 golden-frame CI'ı görsel tarafı kalıcı güvenceye alacak.

## M3 denetiminden ertelenenler (2026-08-07, 25 bulgu; yüksek+orta tümü M3'te düzeltildi)
- **M4**: OfflineAudioContext tabanlı ses parity testi (rendering-semantics §9.3 — micro-fade/gain zincirinin preview↔export RMS karşılaştırması). Editör↔compiler kapsam haritasının UI'da gösterimi (hangi özellik hangi milestone'da export edilebilir — 422 mesajlarının ötesinde proaktif rozet).
- **Sürekli**: API DTO'ları için C#→TS tip üretimi (timeline-schema'daki desenin API kontratlarına genişletilmesi) — FE/BE alan-adı drift sınıfını (M3'te yakalanan error/errorMessage vakası) CI'da kalıcı önler.
- **Düşük öncelikli 8 bulgu**: `docs/audits/m3-denetim.json`.

## Kayda geçen doğrulamalar (aksiyon gerekmez)
- Restore'da "PreRestore satırı görünmüyor" davranışı veri kaybı DEĞİL — aynı revision'da zaten snapshot varsa terfi ediliyor; invaryant korunuyor (denetim #32).
- `.gitignore` üretilen-artefakt-commit'lenir kararıyla tutarlı (denetim #37).
