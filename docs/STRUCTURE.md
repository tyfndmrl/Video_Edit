# STRUCTURE — dizin haritası
Son güncelleme: 2026-09-03. (İşaret: `[G]` = üretilen/derlenen, elle düzenlenmez.)

```
CLAUDE.md                    Giriş noktası (süreklilik seti)
PROGRESS.md                  Yarım-iş + B-borçları turlarının defteri (durum/kanıt satırları)
DURUM.md                     2026-08-25 çift-rol denetim raporu (son durum fotoğrafı)
README.md                    Kurulum + mimari özet (DİKKAT: test sayıları tarihli/bayat olabilir)
compose.dev.yml              Dev altyapı: postgres + redis + minio (redis TÜKETİCİSİZ — DECISIONS'a bak)
compose.yml                  Prod compose (Caddy + api + worker + pg + redis + minio değil R2)
.env.example                 Prod env şablonu
.github/workflows/ci.yml     CI: schema build→codegen→backend test→editör→e2e (golden drift denetimli)

apps/editor/
  src/app/                   Kabuk: App.tsx, TopBar, queryClient
  src/features/              Dilimler: timeline/ player/ inspector/ library/ export/ text/
                             keyframes/ shortcuts/ auth/ projects/ versions/ history/
  …/timeline/timelineHeight.ts        Timeline satırının yüksekliği: KALICI kullanıcı niyeti
                             (localStorage `videoedit.timelineHeight.v1`) + ÖLÇÜLEN efemeral
                             alanlar ayrı; efektif değer saf `clampTimelineHeight`ten (belgeye
                             YAZILMAZ — DECISIONS)
  …/timeline/TimelineResizeHandle.tsx Sürükle-boyutlandır tutamağı (`role="separator"`,
                             pointer-capture + üçlü çıkış, rAF birleştirme, ok/Home/End)
  src/state/                 docStore (patch-undo) · editorStore · assetStore · timelineOps
                             (TÜM doküman mutasyonları tek kapıdan — 4600+ satır, bilinçli)
  src/entities/              API istemci sarmalayıcıları (assets/exports/auth) + progressHub.ts
                             (SignalR canlı ilerleme; polling yedeği kapıları + sessizlik bekçisi)
  e2e/                       Playwright — YALNIZ gerçek fare/klavye; support/ yardımcıları
  e2e/fixtures/seed.ts       API'den gerçek asset kuran test tohumu

packages/timeline-schema/
  src/schema.ts              zod v4 şema (tek doğruluk kaynağı)
  src/invariants.ts          Belge değişmezleri (frame grid, geçiş, keyframe…)
  src/time.ts, easing.ts     µs/frame aritmetiği; bezier ekstremum (C# ile parite)
  test-vectors/*.json        Çift-dil parite vektörleri (iki tarafta da koşulur)
  dist/                      [G] build çıktısı — editör BURADAN çözer (bayat-dist tuzağı: SKILLS.md)

backend/src/
  Directory.Build.props      XML-doc kapısı (yapısal uyarılar = hata; CS1591 gerekçeli susturuk)
  VideoEdit.Contracts/       [G kısmen] NJsonSchema üretimi C# DTO'ları (TimelineContracts.g.cs)
                             + JobProgress.cs (canlı ilerleme kanalının TEK sabit/payload tanımı)
  VideoEdit.Domain/          Entity'ler + UploadRules (EF'siz saf)
  VideoEdit.Infrastructure/  EF Core + AppDbContext + Migrations/ [G-sonra-commit] + R2Storage + Auth
  VideoEdit.Media/           SAF ffmpeg/Skia katmanı (EF'e dokunmaz): ExportCompiler (3800+ satır),
                             ClipEffects, LayerGeometry, FfmpegRunner, Recipes/, Text/, CubeLutValidator
  VideoEdit.Api/             Minimal API: Endpoints/ (Auth/Project/Asset/Export/Font/Health) + kota + rate limit
                             + Hubs/ (JobProgressHub sahiplik-kapılı abonelik; RedisProgressForwarder
                             pub/sub→grup köprüsü; kayıt ProgressHubEndpoints'te — muhafız görür)
  VideoEdit.Worker/          Hangfire host: ProcessAssetJob (proxy/filmstrip/waveform/poster),
                             ExportJob (disk+bellek kapıları, render bekçileri), AssetReaperJob,
                             RedisJobProgressPublisher (progress DB yazımlarının yanında canlı yayın)

backend/tools/SchemaGen/     zod JSON Schema → C# codegen aracı

backend/tests/
  GoldenFrames/ RasterGoldens/                     Gerçek-ffmpeg piksel golden'ları (UnitTests'in kardeşi)
  VideoEdit.UnitTests/  ↓
  ExportCompilerSnapshotTests + ExportSnapshots/   Filtergraph metin pinleri
  GoldenFrameTests                                 Golden PNG'lerin tüketicisi
  ExportGateInventoryTests                         Muhafız defterleri (SyncGate/WorkerFailures/
                                                   DocumentStrings/RasterRefusals) — kaçak kural yakalar
  CrossUserAccessTests                             IDOR matrisi + mekanik uç envanteri muhafızı
  DirtyMediaCorpusTests                            Pis-dosya korpusu (VFR/rotated/HLG/yalan-süre…)
  *ParityTests                                     test-vectors/ tüketicileri (C# yarısı)
  MediaPipelinePerfTests                           Oransal perf muhafızı (sessiz şerit)

docs/
  STRUCTURE.md SKILLS.md WORKFLOWS.md DECISIONS.md STATE.md CHANGELOG.md   ← bu süreklilik seti
  review-gate.md            BAĞLAYICI denetim kuralları
  rendering-semantics.md    NORMATİF render sözleşmesi (zaman/geometri/efekt/ses)
  poc-bilinen-sinirlar.md   Ölçülmüş sınırlar + perf tabloları (§0.1 GB ölçümleri, §2.6 ses paritesi)
  backlog.md                Tam borç tarihçesi (tur tur, kapanış kanıtlarıyla)
  performans-raporu.md      Perf turu ölçümleri + kapanış notları
  demo-senaryosu.md         Ölçülmüş demo akışı (müzik adımı dahil)
  design/                   Onaylı tasarım dokümanları (tarihsel niyet)
  audits/                   Denetim arşivi — DOKUNULMAZ (CLAUDE.md kırmızı çizgisi; review-gate
                            kural 6 arşivlemeyi şart koşar)

deploy/                     Caddy + prod kurulum README'si (R2 doğrulama adımları §4)
scripts/                    make-demo-media.ps1/.sh + seed-demo.ps1
fonts/                      manifest.json + lock (sha256 pinli); TTF'ler gitignore'lu, indirilir
```
