# .NET Backend Tasarımı — Web Tabanlı Video Editörü

## 0. Sürüm Kararı

**.NET 10 (LTS)** — Kasım 2025'te yayınlandı, Kasım 2028'e kadar destekli. .NET 8, Kasım 2026'da (3 ay sonra) destek dışı kalıyor; greenfield projede .NET 8'e başlamak anlamsız. C# 14, EF Core 10, ASP.NET Core 10.

---

## 1. Solution Yapısı

```
VideoEdit.sln
├── src/
│   ├── VideoEdit.Api/              # ASP.NET Core Web API (Minimal API + endpoint grupları)
│   │   ├── Endpoints/              # Auth, Projects, Assets, Jobs, Export
│   │   ├── Hubs/                   # SignalR (JobProgressHub)
│   │   └── Program.cs
│   ├── VideoEdit.Worker/           # .NET Worker Service — Hangfire Server host'u
│   │   ├── Jobs/                   # ProxyTranscodeJob, ExportJob, WaveformJob, FilmstripJob
│   │   └── Program.cs
│   ├── VideoEdit.Domain/           # Entity'ler, enum'lar, domain kuralları (bağımlılıksız)
│   ├── VideoEdit.Infrastructure/   # EF Core DbContext + migrations, R2 storage client,
│   │                               # Redis, Identity store, Hangfire konfig
│   ├── VideoEdit.Media/            # ffmpeg/ffprobe süreç yönetimi, komut üreticileri,
│   │                               # Timeline JSON -> filter_complex derleyici (export compiler)
│   └── VideoEdit.Contracts/        # DTO'lar, Timeline JSON şema tipleri, SignalR mesaj tipleri
│                                   # (frontend codegen için OpenAPI kaynağı)
└── tests/
    ├── VideoEdit.UnitTests/        # özellikle Media: timeline -> ffmpeg komut snapshot testleri
    └── VideoEdit.IntegrationTests/ # Testcontainers (postgres+redis), API akış testleri
```

Kritik ayrım: **`VideoEdit.Media` hem Api hem Worker tarafından referans alınır.** Timeline JSON'u parse eden ve ffmpeg komutu üreten kod tek yerde yaşar; API tarafı bunu validasyon/ön-tahmin (süre, çözünürlük) için, Worker gerçek çalıştırma için kullanır.

Zaman temsili (paylaşılan sözleşmeye uygun): tüm `sourceIn/sourceOut/timelineStart/duration` alanları **mikrosaniye cinsinden `long`**. `VideoEdit.Contracts` içinde `readonly record struct Timecode(long Micros)` + FPS'e göre frame hizalama yardımcıları. ffmpeg'e verilirken `-ss 12.345678` formatına string dönüşüm tek noktadan yapılır (InvariantCulture — Türkçe locale'de `,` ayracı klasik tuzak).

---

## 2. Veri Modeli (EF Core + PostgreSQL)

### Entity taslakları

```csharp
public class AppUser : IdentityUser<Guid>
{
    public string DisplayName { get; set; } = "";
    public DateTimeOffset CreatedAt { get; set; }
    public List<RefreshToken> RefreshTokens { get; set; } = [];
}

public class RefreshToken
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public string TokenHash { get; set; } = "";        // SHA-256; ham token asla saklanmaz
    public DateTimeOffset ExpiresAt { get; set; }      // 30 gün
    public DateTimeOffset? RevokedAt { get; set; }
    public Guid? ReplacedByTokenId { get; set; }       // rotation zinciri
}

public class Project
{
    public Guid Id { get; set; }
    public Guid OwnerId { get; set; }
    public string Name { get; set; } = "";
    public JsonDocument Timeline { get; set; }          // jsonb — "current" doküman (hot state)
    public long RevisionNumber { get; set; }            // optimistic concurrency için monoton sayaç
    public int FrameRateNum { get; set; } = 30;         // rational fps: 30000/1001 destekli
    public int FrameRateDen { get; set; } = 1;
    public int Width { get; set; } = 1920;
    public int Height { get; set; } = 1080;
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public DateTimeOffset? DeletedAt { get; set; }      // soft delete
}

public class ProjectRevision                            // versiyon geçmişi — snapshot
{
    public Guid Id { get; set; }
    public Guid ProjectId { get; set; }
    public long RevisionNumber { get; set; }            // Project.RevisionNumber'ın o anki değeri
    public JsonDocument Timeline { get; set; }          // jsonb, tam snapshot
    public RevisionKind Kind { get; set; }              // Auto | Checkpoint | PreRestore
    public string? Label { get; set; }                  // kullanıcı checkpoint adı
    public Guid CreatedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

public class Asset
{
    public Guid Id { get; set; }
    public Guid ProjectId { get; set; }                 // MVP: asset proje-scoped (basitlik)
    public Guid OwnerId { get; set; }
    public AssetStatus Status { get; set; }             // Uploading|Uploaded|Processing|Ready|Failed
    public AssetKind Kind { get; set; }                 // Video|Audio|Image
    public string OriginalFileName { get; set; } = "";
    public string StorageKey { get; set; } = "";        // orijinal: assets/{assetId}/original.{ext}
    public long SizeBytes { get; set; }
    public string? UploadId { get; set; }               // R2 multipart upload id (Uploading iken)
    // Türevler (Ready olunca dolar) — hepsi R2 key
    public string? ProxyKey { get; set; }               // assets/{id}/proxy.mp4
    public string? FilmstripKey { get; set; }           // assets/{id}/filmstrip.jpg (sprite)
    public string? WaveformKey { get; set; }            // assets/{id}/waveform.json (peaks)
    public string? ThumbnailKey { get; set; }           // assets/{id}/thumb.jpg
    public JsonDocument? Probe { get; set; }            // jsonb — ffprobe -print_format json çıktısı
    public long? DurationMicros { get; set; }           // probe'dan denormalize
    public int? Width { get; set; }
    public int? Height { get; set; }
    public string? FailureReason { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? DeletedAt { get; set; }
}

public class Job
{
    public Guid Id { get; set; }
    public JobType Type { get; set; }                   // ProxyTranscode|Export|Waveform|Filmstrip
    public JobStatus Status { get; set; }               // Queued|Running|Succeeded|Failed|Canceled
    public Guid? AssetId { get; set; }
    public Guid? ProjectId { get; set; }
    public long? RevisionNumber { get; set; }           // Export: hangi revizyon export edildi
    public Guid RequestedBy { get; set; }
    public int ProgressPercent { get; set; }
    public string? ProgressStage { get; set; }          // "downloading" | "encoding" | "uploading"
    public string? OutputKey { get; set; }              // Export çıktısı R2 key
    public string? ErrorMessage { get; set; }
    public string? HangfireJobId { get; set; }          // iptal için köprü
    public int AttemptCount { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? StartedAt { get; set; }
    public DateTimeOffset? CompletedAt { get; set; }
}
```

### Önemli mapping notları

```csharp
// Timeline jsonb + optimistic concurrency
modelBuilder.Entity<Project>(e => {
    e.Property(p => p.Timeline).HasColumnType("jsonb");
    e.Property(p => p.RevisionNumber).IsConcurrencyToken(); // xmin yerine anlamlı sayaç
});
modelBuilder.Entity<ProjectRevision>()
    .HasIndex(r => new { r.ProjectId, r.RevisionNumber }).IsUnique();
modelBuilder.Entity<Asset>()
    .HasIndex(a => new { a.ProjectId, a.Status });
modelBuilder.Entity<Job>()
    .HasIndex(j => new { j.ProjectId, j.Status });
```

- Asset durum makinesi geçişleri tek bir domain metodunda zorunlu kılınır (`Asset.TransitionTo(...)`) — worker crash sonrası `Processing`'de takılı asset'leri süpüren bir "reaper" recurring job (30 dk'dan eski Processing → Failed + retry enqueue).
- `Probe` alanına ham ffprobe JSON'u koymak bilinçli: ileride codec-bazlı kararlar (ör. HEVC ise proxy zorunlu, rotate metadata) için kaynak veri kaybolmaz.

---

## 3. Auth — ASP.NET Identity + JWT (pragmatik MVP)

- `AddIdentityCore<AppUser>()` (UI'sız çekirdek) + EF store. Şifre politikası default, e-posta doğrulama MVP'de opsiyonel (flag ile).
- **Access token**: JWT, 15 dk, `sub`, `email` claim'leri. İmza: HS256 + 256-bit secret (env'den). MVP'de tek API olduğu için asimetrik anahtara gerek yok.
- **Refresh token**: 32 byte random, client'a ham verilir, DB'de SHA-256 hash. **Rotation**: her refresh'te eski token revoke + yenisi verilir; ROTASYONLA revoke edilmiş (halefi olan) token tekrar kullanılırsa zincirdeki tüm token'lar iptal (theft detection). Logout'la revoke edilen token halefsizdir — replay'i düz 401 alır, cascade tetiklemez (per-device logout vaadi; 14. tur triyajı 2026-08-21).
- Teslim: SPA için refresh token **HttpOnly + Secure + SameSite=Strict cookie** (path=`/api/auth/refresh`), access token response body'de — XSS'e karşı en makul MVP dengesi.
- **SignalR auth**: WebSocket'te header taşınamadığı için `access_token` query string desteği (`OnMessageReceived` event'inde sadece hub path'i için).

```
POST /api/auth/register        { email, password, displayName }
POST /api/auth/login           -> { accessToken, expiresIn } + refresh cookie
POST /api/auth/refresh         (cookie) -> yeni access + rotate edilmiş refresh
POST /api/auth/refresh/logout  (cookie) -> YALNIZ bu cihazın refresh token'ı revoke
GET  /api/auth/me
```

*(2026-08-21: logout, cookie path'inin altına taşındı — `/api/auth/logout` cookie'yi
göremediği için per-device iptal yapamıyordu ve tüm cihazları düşürüyordu; ayrıntı
`poc-bilinen-sinirlar.md` §4.5.)*

.NET 10'un yeni built-in Identity API endpoint'leri (`MapIdentityApi`) refresh rotation ve cookie stratejisinde esneklik vermediği için **kullanılmıyor** — endpoint'ler elle yazılır (~200 satır).

---

## 4. API Yüzeyi

### Projects & Timeline

```
GET    /api/projects                          liste (sayfalı)
POST   /api/projects                          { name, fps, width, height }
GET    /api/projects/{id}                     proje + current timeline + revisionNumber
PATCH  /api/projects/{id}                     ad/ayar değişikliği
DELETE /api/projects/{id}                     soft delete

PUT    /api/projects/{id}/timeline            AUTOSAVE (aşağıda)
GET    /api/projects/{id}/revisions           snapshot listesi (timeline hariç, meta)
GET    /api/projects/{id}/revisions/{rev}     tek snapshot (timeline dahil)
POST   /api/projects/{id}/revisions           manuel checkpoint { label }
POST   /api/projects/{id}/restore             { revisionNumber } -> önce PreRestore snapshot al,
                                              sonra current'ı değiştir, revisionNumber++
```

### Autosave tasarımı

- **Frontend**: her edit'ten sonra 2 sn debounce + maksimum 15 sn'de bir zorunlu flush + `beforeunload`'da `sendBeacon`.
- **İstek**: `PUT /timeline` gövdesi `{ baseRevision: 41, timeline: {...} }`. Tam doküman gönderilir (MVP'de JSON-patch karmaşasına girme; 1-5 MB timeline gzip ile sorun değil, `Accept-Encoding` yeterli).
- **Optimistic concurrency**: sunucu `UPDATE projects SET timeline=@t, revision_number=@base+1 WHERE id=@id AND revision_number=@base`. 0 satır etkilendiyse **409 Conflict** + güncel `revisionNumber` + güncel timeline döner. Frontend 409'da kullanıcıya "başka sekmede değişmiş" diyaloğu gösterir (MVP'de merge yok). Yanıt: `200 { revisionNumber: 42 }`.
- **Snapshot politikası (hibrit)**: her autosave yeni `ProjectRevision` YAZMAZ — current her zaman `Project.Timeline`'da. Snapshot koşulları: (a) son snapshot'tan bu yana ≥ 20 revision, **veya** (b) ≥ 5 dakika geçti ve en az 1 değişiklik var, **veya** (c) manuel checkpoint / restore öncesi. Retention: Auto snapshot'lardan son 50 tutulur + 24 saatten eskilerde saatte 1'e inceltilir (recurring cleanup job); Checkpoint'ler süresiz.

### Asset upload akışı (R2 multipart, presigned)

```
POST   /api/projects/{id}/assets              { fileName, sizeBytes, contentType }
       -> Asset(Uploading) yaratır, R2 CreateMultipartUpload
       -> { assetId, uploadId, partSize: 64MB, partCount }

POST   /api/assets/{id}/parts/presign         { partNumbers: [1,2,...] }  (batch)
       -> [{ partNumber, url }]  — presigned UploadPart URL'leri (1 saat geçerli)

POST   /api/assets/{id}/complete              { parts: [{ partNumber, etag }] }
       -> R2 CompleteMultipartUpload, Status=Uploaded, işleme job'ları enqueue
       -> Status=Processing

DELETE /api/assets/{id}                       abort multipart (gerekiyorsa) + soft delete
GET    /api/assets/{id}                       durum + türev URL'leri (presigned GET, 1 saat)
GET    /api/projects/{id}/assets              medya kütüphanesi listesi
```

R2 notları: S3-compatible ama **tüm part'lar aynı boyutta olmalı (son hariç)** — part boyutunu sunucu belirler, client uymak zorunda. AWS SDK for .NET (`AWSSDK.S3`) `ServiceURL = https://{account}.r2.cloudflarestorage.com` ile kullanılır; R2 için `ChecksumValidation` kapatılabilir ve `ForcePathStyle=true`. R2 bucket CORS'unda `PUT` + `ETag` expose header şart (yoksa browser part ETag'ini okuyamaz, complete başarısız olur — klasik tuzak). 1-2 GB dosyada 64 MB part → 16-32 part, browser 3-4 paralel PUT.

### Jobs & Export

```
POST   /api/projects/{id}/export              { revisionNumber?, format: "mp4",
                                                resolution: "1080p", crf?, preset? }
       -> Job(Export, Queued) + Hangfire enqueue -> { jobId }
GET    /api/jobs/{id}                         durum + progress (polling fallback)
POST   /api/jobs/{id}/cancel
GET    /api/jobs/{id}/download                Succeeded ise presigned GET (24 saat)
WS     /hubs/progress                         SignalR — aşağıda
```

Export daima belirli bir `revisionNumber`'a sabitlenir (istek anında snapshot yoksa alınır) — kullanıcı export sürerken düzenlemeye devam edebilir.

---

## 5. İş Kuyruğu

### Karar: **Hangfire** (PostgreSQL storage — `Hangfire.PostgreSql`)

Gerekçe ve alternatif karşılaştırma:

| Seçenek | Değerlendirme |
|---|---|
| **Hangfire** | Retry, dashboard, recurring job (cleanup/reaper), cancellation, tek ek bağımlılık yok (mevcut Postgres'i kullanır). Uzun job'larda `InvisibilityTimeout` ayarı ile sorunsuz. **Seçim bu.** |
| Redis tabanlı custom (BRPOPLPUSH / Streams) | Tam kontrol ama retry, ölü işçi tespiti, dashboard'u sıfırdan yazarsın — MVP'de gereksiz mühendislik. |
| Quartz.NET | Zamanlama odaklı, kuyruk/progress modeli zayıf. |
| MassTransit + RabbitMQ | Ekstra broker servisi; tek-makine VPS MVP'si için ağır. |

### Kurulum deseni

- **API**: sadece `IBackgroundJobClient` (enqueue) — Hangfire server ÇALIŞTIRMAZ.
- **Worker**: `AddHangfireServer(o => { o.Queues = ["export", "transcode"]; o.WorkerCount = 2; })`. ffmpeg zaten çok çekirdek kullanır; VPS'te `WorkerCount` = 1-2 tutulur, ölçek worker container replikasıyla alınır.
- Job metodu iskeleti: `Task ExportJob.Run(Guid jobId, CancellationToken ct)` — Hangfire cancellation token'ı ffmpeg process kill'e bağlanır.
- **Retry**: `[AutomaticRetry(Attempts = 2, DelaysInSeconds = [60, 300])]`; transcode idempotent (çıktıyı R2'ye deterministik key ile yazar, tekrar çalışırsa üstüne yazar). **Timeout**: job kendi watchdog'u — ffmpeg `progress` çıktısı 120 sn ilerlemezse process kill + fail.
- ffmpeg progress: `-progress pipe:1 -nostats` çıktısındaki `out_time_us` / toplam süre → yüzde. (Mikrosaniye sözleşmesiyle birebir uyumlu.)

### Progress kanalı: **SignalR (Redis backplane) + polling fallback**

- Worker, API'nin hub'ına doğrudan erişemez → worker `StackExchange.Redis` ile `job-progress` kanalına publish eder; API tarafında `Microsoft.AspNetCore.SignalR.StackExchangeRedis` backplane sayesinde hub group'una (`job:{jobId}`) otomatik yayılır. Basitleştirilmiş alternatif: worker'a `HubConnection` (SignalR client) koyup API'ye bağlanmak — tek API instance'lı MVP'de bu da yeterli; backplane zaten Redis var diye bedava.
- Progress DB'ye **her saniye değil**, %5 adımlarla veya 5 sn'de bir yazılır (Postgres'i döğme); SignalR'a her progress tick'i gider.
- Polling (`GET /api/jobs/{id}`) her zaman çalışır — WebSocket düşerse frontend 2 sn aralıkla poll'a döner.

### İşleme pipeline'ı (asset Uploaded olunca)

Tek `ProcessAssetJob` sırayla: ffprobe → proxy → filmstrip → waveform → thumbnail → `Ready`. (Paralel job'lara bölmek MVP'de durum-birleştirme karmaşası yaratır.)

```
# Proxy (timeline scrub için: her frame keyframe — arama anında)
ffmpeg -i in.mp4 -vf "scale=-2:540" -c:v libx264 -preset veryfast -crf 28 \
  -g 30 -pix_fmt yuv420p -c:a aac -b:a 96k -movflags +faststart proxy.mp4

# Filmstrip sprite (saniyede 1 kare, 160px genişlik, tek satır JPEG)
ffmpeg -i in.mp4 -vf "fps=1,scale=160:-2,tile=1000x1" -frames:v 1 -q:v 5 filmstrip.jpg

# Waveform peaks -> ffmpeg ile PCM çek, C#'ta downsample edip JSON yaz
ffmpeg -i in.mp4 -ac 1 -ar 8000 -f s16le -
```

Worker disk: 1-2 GB orijinali R2'den geçici diske indirir (`/scratch` volume) → işler → türevleri yükler → temizler. Disk doluluk kontrolü job başında yapılır (min 3× dosya boyutu boş alan).

---

## 6. Docker Compose (taslak)

```yaml
services:
  caddy:
    image: caddy:2
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
    # Caddyfile: app.example.com { reverse_proxy api:8080 }  — otomatik HTTPS (Let's Encrypt)
    # SignalR için ekstra ayar gerekmez; Caddy WebSocket'i default proxy'ler.

  api:
    build: { context: ., dockerfile: src/VideoEdit.Api/Dockerfile }
    environment:
      - ConnectionStrings__Postgres=Host=postgres;Database=videoedit;Username=app;Password=${PG_PASSWORD}
      - ConnectionStrings__Redis=redis:6379
      - Jwt__Secret=${JWT_SECRET}
      - R2__AccountId=${R2_ACCOUNT_ID}
      - R2__AccessKey=${R2_ACCESS_KEY}
      - R2__SecretKey=${R2_SECRET_KEY}
      - R2__Bucket=videoedit
    depends_on: [postgres, redis]
    restart: unless-stopped

  worker:
    build: { context: ., dockerfile: src/VideoEdit.Worker/Dockerfile }
    # Dockerfile: FROM mcr.microsoft.com/dotnet/aspnet:10.0 + apt-get install ffmpeg
    # (veya multi-stage'de statik ffmpeg binary kopyala — sürüm sabitlemek için tercih edilir)
    environment: *api-env-benzeri
    volumes:
      - worker_scratch:/scratch
    depends_on: [postgres, redis]
    restart: unless-stopped
    deploy: { resources: { limits: { memory: 6g } } }   # ffmpeg OOM koruması

  postgres:
    image: postgres:17
    environment: { POSTGRES_DB: videoedit, POSTGRES_USER: app, POSTGRES_PASSWORD: "${PG_PASSWORD}" }
    volumes: [pg_data:/var/lib/postgresql/data]
    restart: unless-stopped

  redis:
    image: redis:7
    command: redis-server --appendonly yes
    volumes: [redis_data:/data]
    restart: unless-stopped

volumes: { caddy_data: {}, pg_data: {}, redis_data: {}, worker_scratch: {} }
```

**VPS deploy notları**: upload/download trafiği VPS'e uğramaz (presigned URL'lerle browser↔R2 direkt) — bant genişliği maliyeti R2'de, egress ücretsiz; bu mimarinin en büyük kazancı. Migration'lar `api` başlarken değil, ayrı bir `migrator` one-shot servisiyle (veya deploy script'inde `dotnet ef database update`) uygulanır — çoklu instance yarışını önler. Hangfire dashboard `api`'de `/hangfire` altında, sadece admin claim'iyle. Export worker'ı ayrı (daha güçlü CPU'lu) ikinci VPS'e taşımak sadece compose'u bölmek demektir — mimari hazır.

---

## 7. Fazlar

1. **Faz 1 — İskelet (1-2 hafta)**: solution, EF migrations, Identity+JWT, Projects CRUD, timeline PUT + concurrency, revisions.
2. **Faz 2 — Asset pipeline (2 hafta)**: R2 multipart presign akışı, Worker + Hangfire, ffprobe/proxy/filmstrip/waveform pipeline, asset durum makinesi + reaper.
3. **Faz 3 — Progress & Export v1 (2-3 hafta)**: SignalR + Redis backplane, `VideoEdit.Media` export compiler (tek video track + kesme/birleştirme + ses), job cancel/retry.
4. **Faz 4 — Export v2 (3+ hafta)**: çoklu katman `filter_complex` (overlay, text via libass/drawtext, geçişler `xfade`, hız `setpts/atempo`, keyframe animasyonları `zoompan`/expr tabanlı), snapshot cleanup, rate limiting, e-posta doğrulama.

## 8. Bilinen Tuzaklar

- **Float drift**: ffmpeg komut üretiminde `double`'a asla dönmeden mikrosaniyeden string üret; `ToString(CultureInfo.InvariantCulture)` — TR locale `12,5` üretir ve ffmpeg patlar.
- **R2 ETag/CORS**: `ExposeHeaders: ["ETag"]` olmadan multipart complete imkânsız; ayrıca R2'de part boyutları eşit olmalı.
- **AWS SDK v4 + R2**: yeni SDK sürümleri default checksum (CRC32) header'ları ekliyor, R2 bazı kombinasyonları reddediyor — `RequestChecksumCalculation = WHEN_REQUIRED` ayarla.
- **Hangfire uzun job**: default invisibility/heartbeat ayarlarıyla 1+ saatlik export'ta job'ın ikinci worker'a verilmesi riski — `Hangfire.PostgreSql`'de `InvisibilityTimeout`'u en uzun beklenen export süresinin üstüne çek; job'ı idempotent yaz.
- **ffmpeg zombie/orphan process**: worker container SIGTERM alınca ffmpeg child'ı öldür (`Process.Kill(entireProcessTree: true)`); .NET'te `AppDomain.ProcessExit` + Hangfire cancellation birlikte bağlanmalı.
- **jsonb concurrency**: `xmin` yerine `RevisionNumber` concurrency token'ı seçildi çünkü client'a anlamlı, monoton bir sürüm numarası dönmek gerekiyor; ikisini karıştırma.
- **SignalR + JWT**: WebSocket handshake'te Authorization header yok — query string token yolu sadece hub path'ine sınırlanmalı (token loglara sızmasın diye access log'da query redact).
- **Proxy seek performansı**: `-g 30` (sık keyframe) olmadan timeline scrub'ı kullanılmaz halde olur; dosya boyutu artışı kabul edilen bedel.
- **Rotate metadata**: telefon videolarında `displaymatrix` — proxy üretirken ffmpeg autorotate yapar ama probe'daki genişlik/yükseklik ham değerdir; UI'a rotate-uygulanmış boyutları dönün.
- **Disk**: worker scratch volume'u sessiz katil; job öncesi boş alan kontrolü + job sonrası `finally` temizliği şart.

---

Sources: [Announcing .NET 10 — .NET Blog](https://devblogs.microsoft.com/dotnet/announcing-dotnet-10/), [.NET 8 and .NET 9 End of Support — .NET Blog](https://devblogs.microsoft.com/dotnet/dotnet-8-9-end-of-support/), [.NET support policy](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core)