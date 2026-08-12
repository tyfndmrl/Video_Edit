# VideoEdit

Tarayıcıda çalışan, çok katmanlı bir video editörü (CapCut / Canva Video benzeri).
Medyanı yükle, zaman çizgisinde kes, katmanla, metin ve geçiş ekle, renk ve hızı ayarla,
1080p MP4 olarak dışa aktar. React 19 + .NET 10 + Cloudflare R2 (S3 uyumlu).

> **Bu bir POC'tur.** Uçtan uca çalışır ve testlidir, ama üretim yükü altında denenmemiştir.
> Neyin çalışmadığı, neden ve ne zaman geleceği tek tek yazılıdır:
> **[docs/poc-bilinen-sinirlar.md](docs/poc-bilinen-sinirlar.md)** — ürünü değerlendirmeden
> önce bunu okuyun.

---

## Neler yapabiliyor

### Zaman çizgisi ve düzenleme
- **Çok katmanlı timeline** — video / ses / overlay track'leri; track ekleme, silme, sessize
  alma, gizleme, kilitleme (en fazla 50 track, 2000 klip). *Track'lerin kendi arasında
  yeniden sıralanması ve yeniden adlandırılması henüz yok — klipler katmanlar arasında
  taşınabilir.*
- **Kırpma, bölme, taşıma, ripple silme, kesim üstünde roll**; katmanlar arası taşıma
- Yapışma (snapping), yakınlaştırma, tam sığdırma, marker'lar, timecode göstergesi
- **Sağ tık menüsü** her klip / kesim / boşluk için bağlama duyarlı eylemlerle
- **Geri al / yinele** ve ayrı bir **işlem geçmişi paneli** (hangi işlem neyi değiştirdi)
- Klavye kısayolları (`?` ile tam liste): `Space`, `J/K/L`, `C` böl, `Q/W` kırp,
  `Ctrl+Z/Y`, `Ctrl+C/X/V/D`, `S` yapışma, `Shift+Z` sığdır

### Medya
- **Yükleme**: MP4 / MOV / WebM, MP3 / M4A / WAV, PNG / JPG / WebP —
  tarayıcıdan doğrudan depoya çok parçalı yükleme (sabit 64 MiB parça), duraklat / devam et
- Worker türe göre türev üretir: **video** → 540p proxy + filmstrip + waveform (sesliyse) +
  poster; **ses** → AAC proxy + waveform; **görsel** → yalnız poster. Önizleme hep bu
  türevlerden oynar — **orijinal dosya tarayıcıya hiç inmez**
- **Görsel klipler** (fotoğraf) — süresi ayarlanabilir, diğer katmanlarla aynı geometri
  zincirinden geçer, aralarına geçiş kurulabilir (slayt gösterisi). Önizlemede de export'ta da
  çizilir; önizleme kaynağı görselde **poster**, video/seste **proxy**'dir
  (`features/player/previewSource.ts`) ve bunu gerçek piksel okuyan bir e2e testi tutar
  (`e2e/image-preview.spec.ts`)
- Depolama **kotası göstergesi**, asset silme akışı ("bu asset şu projelerde kullanılıyor"
  uyarısıyla), eksik medya bildirimi

### Ses
- Track ve klip düzeyinde **ses seviyesi**, fade in / fade out, sessize alma
- **Sesi ayır** (detach): video klibinin sesini ayrı bir ses track'ine indirir
- Waveform çizimi; geçişlerde `acrossfade` ile toplam kazancı 1'de tutan ses rampası

### Kompozisyon ve efektler
- **Transform gizmo** — oynatıcı üzerinde doğrudan taşıma / ölçekleme / döndürme;
  Inspector'da sayısal alanlar: Konum X, Konum Y, Ölçek, Döndürme, Opaklık.
  *Çapa (anchor) noktası merkezde sabittir — panelde alanı yoktur; uygulama bunu
  Özellikler → "Kapsam" bölümünde kendisi söyler*
- **Metin katmanları** — küratörlü font seti (Roboto, Open Sans, Noto Sans, Noto Serif;
  4 ağırlık/stil), boyut, hizalama, satır aralığı, dolgu / kenarlık / arka plan.
  Tarayıcı ve sunucu **aynı TTF dosyasını** kullanır
- **Şekiller** (dikdörtgen, elips, çizgi, ok) ve **sticker** katmanları (sticker = overlay
  katmanına konmuş, hazır bir görsel asset'i — PNG / JPG / WebP)
- **Geçişler** — `crossfade`, `fadeToBlack`, `wipeLeft`, `wipeRight`, `slideUp`, `dissolve`;
  kesim rozetinden veya sağ tık menüsünden, süre ayarlanabilir, **oynatıcıda önizlenir**
- **Renk düzeltme** — parlaklık, kontrast, doygunluk, sıcaklık, ton, pozlama; aynı matematik
  hem önizleme shader'ında hem export filtresinde
- **Hız değiştirme** — 0.1× – 10× (slow-mo / timelapse), ön ayarlar + serbest oran, ripple
  davranışı seçimi
- **Keyframe animasyonları** — `x`, `y`, `scale`, `rotationDeg`, `opacity`, `volume`
  kanallarında; easing seçimi, timeline şeridinde sürüklenebilir anahtarlar

### Proje ve dayanıklılık
- Hesap (kayıt / giriş / httpOnly refresh cookie), proje listesi, yeniden adlandırma, silme
- **Autosave** + çakışma tespiti (başka sekmede değişti diyaloğu)
- **Sürüm geçmişi paneli** — otomatik kayıtlar, manuel kayıt noktası oluşturma, eski bir
  sürüme dönme (geri dönmeden önce mevcut hal otomatik snapshot'lanır)

### Dışa aktarma
- **1080p MP4** (H.264 CRF18 `veryfast` + AAC 192k), ilerleme göstergesi, iptal, indirme
  bağlantısı
- Timeline JSON → **FilterGraph Compiler** → `ffmpeg -filter_complex_script` → MP4
- Desteklenmeyen bir bileşim varsa export **kuyruğa hiç girmez**: sunucu 422 ile
  **gerekçesini** döner ve dialogda kırmızı olarak gösterilir (dakikalarca render edip
  düşmek yerine). Kapsam hatalarının metni Türkçe, şema ihlallerininki İngilizcedir

**Ölçülmüş export süreleri** (i9-10850K, 1080p30, gerçek boru hattı): 60 sn tek klip →
**10.8 sn**; 60 sn, 2 klip + crossfade + renk + metin + şekil → **33.4 sn**. Aynı uzunluk,
3.8 kat fark — süre kompozisyon karmaşıklığına bağlıdır.
Yöntem ve tüm sayılar: [docs/poc-bilinen-sinirlar.md](docs/poc-bilinen-sinirlar.md) §0.

---

## Mimari Özeti

```
tarayıcı ──(presigned PUT, 64 MiB parça)──► R2 / MinIO ◄──(indir/yükle)── Worker (ffmpeg)
   │                                                                          ▲
   │ REST + JWT                                                               │ Hangfire
   ▼                                                                          │ (postgres)
  API (ASP.NET Core Minimal API) ──► PostgreSQL (timeline jsonb) ─────────────┘
                                 └─► Redis (SignalR backplane)
```

- **Frontend** ([apps/editor](apps/editor)) — Vite + React 19 + TypeScript + Tailwind 4.
  Canvas tabanlı timeline, **WebGL2 kompozitör**, gizli `<video>` havuzu (en fazla 4) üstünde
  kurulu önizleme motoru. Durum: zustand + immer; sunucu durumu: react-query.
- **Paylaşılan sözleşme** ([packages/timeline-schema](packages/timeline-schema)) — timeline
  dokümanının **tek doğruluk kaynağı**: zod v4 şemaları → JSON Schema → C# DTO üretimi.
  Tüm zamanlar **tamsayı mikrosaniye**; float saniye yasaktır. Zaman matematiği (frame
  ızgarası, keyframe örnekleme, easing) iki dilde **aynı test vektörleriyle** pinlenir.
- **Backend** ([backend](backend)) — ASP.NET Core Minimal API + Hangfire worker.
  PostgreSQL (timeline `jsonb` + revision geçmişi), Redis. Katmanlar: `Api`, `Contracts`,
  `Domain`, `Infrastructure`, `Media` (ffmpeg reçeteleri + export derleyicisi + SkiaSharp
  metin rasteri), `Worker`.
- **Depolama** — Cloudflare R2 (geliştirmede MinIO). Tarayıcı doğrudan yükler/indirir;
  upload/download trafiği API'ye **uğramaz**.
- **Fontlar** ([fonts](fonts)) — sürüm pinli, sha256 kilitli küratörlü set. Aynı TTF hem
  tarayıcının `@font-face`'ine hem SkiaSharp'a gider; preview ↔ export parity'sinin şartı budur.

Normatif ayrıntılar: [docs/rendering-semantics.md](docs/rendering-semantics.md)
(koordinat sistemi, transform matrisi, efekt matematiği, geçiş tablosu, font sözleşmesi) ve
[docs/design/](docs/design/) (alt sistem tasarımları).

---

## Kurulum

### Gereksinimler

| Araç | Sürüm | Not |
|---|---|---|
| Node | ≥ 22 | ölçüm makinesinde v22.14.0 |
| pnpm | ≥ 10 | `packageManager: pnpm@10.12.1` |
| .NET SDK | 10.x | ölçüm makinesinde 10.0.302 |
| Docker | — | postgres + redis + minio için |
| **ffmpeg + ffprobe** | PATH üzerinde | worker **açılışta** `-version` ile doğrular, yoksa başlamaz |

### Adımlar

```bash
# 1) Bağımlılıklar (timeline-schema paketi prepare script'iyle otomatik build edilir)
pnpm install

# 2) Altyapı: postgres + redis + minio
docker compose -f compose.dev.yml up -d

# 3) Fontlar — küratörlü set (4 aile x 4 stil = 16 TTF, ~7.8 MB). TTF'ler depoda YOKTUR
#    (fonts/.gitignore: *.ttf), bir kez indirilir.
#    Script manifest.json'daki resmî adreslerden indirir ve manifest.lock.json'a sha256 yazar.
pwsh fonts/fetch-fonts.ps1        # Windows
./fonts/fetch-fonts.sh            # Linux / macOS (curl + jq gerekir)

# 4) Veritabanı şeması (ilk kurulumda ve her yeni migration sonrası)
dotnet run --project backend/src/VideoEdit.Api -- --migrate-only

# 5) API — http://localhost:5000
dotnet run --project backend/src/VideoEdit.Api

# 6) Worker — AYRI terminalde. Proxy/filmstrip/waveform üretimi ve export render'ı
#    YALNIZ burada koşar; başlatılmazsa medya "İşleniyor"da kalır ve export ilerlemez.
dotnet run --project backend/src/VideoEdit.Worker

# 7) Editör — http://localhost:5173
pnpm dev
```

**Font kökü.** API ve worker fontları şu sırayla arar: (1) `Text:FontRoot` ayarı,
(2) `VIDEOEDIT_FONT_ROOT` ortam değişkeni, (3) uygulama dizininden yukarı doğru `fonts/`
klasörü araması. Depo kökünden `dotnet run` ile çalıştırırken (3) genelde yeterlidir; değilse:

```bash
export VIDEOEDIT_FONT_ROOT="$PWD/fonts"        # bash
$env:VIDEOEDIT_FONT_ROOT = "$PWD\fonts"        # PowerShell
```

Fontlar kurulu mu, tek komutla: `curl -s localhost:5000/api/fonts | head -c 200` —
`"pinned":true` görüyorsanız küratörlü set yerindedir. Font olmadan da çalışır ama metin
klipleri **sistem fontuyla** çizilir; o zaman render **belirlenimci değildir**
(bkz. [fonts/README.md](fonts/README.md) — üç modlu politika).

**Şema değişikliği sonrası:** `pnpm schema:generate` (JSON Schema + C# DTO yeniden üretilir).
Üretilen dosyalar commit'lenir; CI drift'i kırmızıya çevirir.

---

## Testler

Tümü **2026-08-12**, `df799df` + teslim düzeltme turu üzerinde bizzat koşuldu:

```bash
# Backend — 966 test.  MinIO ayaktaysa env değişkenini VERİN, yoksa 13 test Skip olur
#   (ProcessAssetPipelineTests, MinioStorageSmokeTests, ExportJobPipelineTests).
MINIO_AVAILABLE=1 dotnet test backend/VideoEdit.sln          # 966/966 ✓

# Editör + şema paketi birlikte
pnpm -r test                                                 # editor 1156 ✓ · schema 180 ✓

# Tip denetimi
pnpm --filter @videoedit/editor exec tsc -b
pnpm --filter @videoedit/editor test:e2e:typecheck

# Production build (teslim edilen artefakt)
pnpm --filter @videoedit/editor build

# E2E — GERÇEK tarayıcıda GERÇEK fare/klavye ile (page.mouse / page.keyboard).
# API (5000), worker ve Vite (5173) AYAKTA olmalı; Playwright hiçbir süreci
# başlatmaz/öldürmez, ayakta olanlara bağlanır.
pnpm --filter @videoedit/editor test:e2e                     # 126/126 ✓ (27 spec, 6.4 dk)
```

> **Neden gerçek fare?** Teslim edilen ilk sürümde "E2E" testleri store'u doğrudan
> çağırıyordu; canvas'a tek bir gerçek pointer olayı gitmemişti ve kullanıcı
> "kırpma/taşıma/sağ tık çalışmıyor" dedi. Kural artık bağlayıcı:
> `dispatchEvent` ve store'u doğrudan çağırmak **kanıt sayılmaz**
> ([docs/review-gate.md](docs/review-gate.md) kural 3).

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) dört paralel iş koşar: **node**
(testler + tip denetimi + production build + şema drift), **dotnet** (gerçek ffmpeg + gerçek
MinIO konteyneri + golden/snapshot drift + contracts drift), **e2e** (Playwright, gerçek medya
üreterek uçtan uca transcode + export) ve **docker** (Api + Worker imaj build'i, matris).

---

## Proje Yapısı

```
apps/editor/                     React editör
  src/app/                       kabuk: TopBar + 4 panelli grid
  src/entities/                  sunucu kaynakları (react-query)
  src/features/
    auth/ projects/ library/     giriş, proje seçici, medya kitaplığı + yükleme motoru
    timeline/                    canvas timeline: çizim, hit-test, sürükleme, sağ tık
    player/                      önizleme: scheduler + <video> havuzu + WebGL2 kompozitör
    inspector/                   klip özellikleri: transform, ses, hız, renk, metin
    keyframes/ text/ export/     keyframe şeridi, overlay ekleme, export dialogu
    history/ versions/ shortcuts/
  src/state/                     docStore (undo/redo), timelineOps (saf düzenleme op'ları), autosave
  e2e/                           Playwright — gerçek fare/klavye

packages/timeline-schema/        zod şemaları, zaman matematiği, invaryantlar,
                                 üretilen JSON Schema + cross-language test vektörleri

backend/
  src/VideoEdit.Api/             Minimal API: auth, projects, assets, exports, fonts
  src/VideoEdit.Contracts/       DTO'lar + şemadan ÜRETİLEN C# timeline tipleri
  src/VideoEdit.Domain/          varlıklar + snapshot politikası
  src/VideoEdit.Infrastructure/  EF Core, R2/S3 istemcisi, JWT
  src/VideoEdit.Media/           ffmpeg reçeteleri, probe, Export/ (FilterGraph compiler), Text/ (SkiaSharp)
  src/VideoEdit.Worker/          Hangfire: ProcessAssetJob, ExportJob, AssetReaperJob
  tests/VideoEdit.UnitTests/     966 test + ExportSnapshots/ (filtre grafiği metin snapshot'ları)
  tests/GoldenFrames/            export karesi piksel golden'ları (11 PNG)
  tests/RasterGoldens/           SkiaSharp şekil rasteri golden'ları (4 PNG)
  tools/SchemaGen/               JSON Schema → C# DTO üretici

fonts/                           küratörlü set: manifest.json + sha256 lock + fetch scriptleri
deploy/                          Caddyfile + VPS/R2 dağıtım rehberi
docs/                            tasarım, render semantiği, backlog, denetim arşivi
```

---

## Yol Haritası

Tamamlanan: **M0** sözleşme + iskelet → **M1** upload + medya işleme → **M2** timeline +
oynatıcı + autosave → **M3** export → **M4** çok katman, klip özellikleri, transform gizmo,
görseller, metin/şekil/sticker, geçişler → **M5** hız, renk, keyframe → **M6** sürüm geçmişi
UI, kota/silme UX.

Teslim düzeltme turlarında kapandı (bu listede DEĞİL, kaydı
[poc-bilinen-sinirlar.md](docs/poc-bilinen-sinirlar.md) §1.1 / §1.2'de):
görsel ve sticker kliplerinin önizlemede çizilmesi, frame ızgarası sözleşmesinin kenarlara
alınması.

Sıradaki (öncelik sırasıyla, gerekçeleriyle
[docs/backlog.md](docs/backlog.md) ve [docs/poc-bilinen-sinirlar.md](docs/poc-bilinen-sinirlar.md)):

1. **LUT (.cube) editör yüzeyi + önizleme shader'ı** — export motoru hazır, yükleme yolu, efekt
   UI'ı ve WebGL2 3D doku örneklemesi yok (iki ayrı iş kalemi — §1.3)
2. **Pis-dosya korpusu** — iPhone HDR/HLG, VFR, döndürülmüş MOV ile uçtan uca testler
3. **`fx.*` keyframe'i** — renk/LUT parametrelerinin animasyonu
4. **Track yeniden sıralama / yeniden adlandırma** — bugün katman sırası ancak track'leri doğru
   sırada ekleyerek kurulabiliyor
5. **Tarayıcı yeniden başlatma sonrası upload resume**
6. **Revision retention job** + container sertleştirme (non-root, kaynak sınırları)
7. **WebCodecs (v2) oynatıcı motoru** — kare-kesin önizleme (±1 kare toleransını kaldırır)

Her iş dilimi, adversarial baş mimar denetiminden geçmeden "tamam" sayılmaz:
[docs/review-gate.md](docs/review-gate.md) (bağlayıcı), denetim arşivi
[docs/audits/](docs/audits/).
