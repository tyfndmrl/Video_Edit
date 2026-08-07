# VideoEdit

Web tabanlı video editörü (CapCut/Canva benzeri). React 19 + .NET 10 + Cloudflare R2.

## Mimari Özeti

- **Frontend** ([apps/editor](apps/editor)): Vite + React 19 + TS. Canvas timeline, WebGL2 kompozitör, `<video>` havuzu tabanlı önizleme (v2: WebCodecs). Önizleme 540p proxy'den oynar.
- **Paylaşılan sözleşme** ([packages/timeline-schema](packages/timeline-schema)): Timeline dokümanının tek doğruluk kaynağı — zod v4 şemaları → JSON Schema → C# DTO üretimi. Tüm zamanlar **tamsayı mikrosaniye**; float saniye yasak.
- **Backend** ([backend](backend)): ASP.NET Core Minimal API + Hangfire worker (ffmpeg). PostgreSQL (timeline `jsonb`) + Redis (SignalR backplane).
- **Depolama**: Cloudflare R2 — tarayıcıdan doğrudan multipart upload (sabit 64 MiB part), proxy/filmstrip/waveform türevleri worker'da üretilir.
- **Export**: Timeline JSON → FilterGraph Compiler → `ffmpeg -filter_complex_script` → MP4 → R2.

Ayrıntılar: [docs/design/](docs/design/) (alt sistem tasarımları) ve [docs/rendering-semantics.md](docs/rendering-semantics.md) (normatif render semantiği).

## Geliştirme

Gereksinimler: Node ≥ 22, pnpm ≥ 10, .NET 10 SDK, Docker (postgres/redis/minio için), **ffmpeg + ffprobe (PATH üzerinde)** — worker açılışta varlıklarını doğrular, yoksa başlamaz.

```bash
# 1) Bağımlılıklar (timeline-schema paketi prepare script'i ile otomatik build edilir)
pnpm install

# 2) Altyapı: postgres + redis + minio
docker compose -f compose.dev.yml up -d

# 3) İlk kurulumda (ve her yeni migration sonrası) veritabanı şeması
dotnet run --project backend/src/VideoEdit.Api -- --migrate-only

# 4) API (http://localhost:5000)
dotnet run --project backend/src/VideoEdit.Api

# 5) Worker — AYRI terminalde (proxy/filmstrip/waveform üretimi ve export
#    render'ı yalnız burada koşar; başlatılmazsa medya "İşleniyor"da kalır)
dotnet run --project backend/src/VideoEdit.Worker

# 6) Editör (http://localhost:5173)
pnpm dev
```

Şema değişikliği sonrası: `pnpm schema:generate` (JSON Schema + C# DTO yeniden üretilir).

## Yol Haritası

M0 sözleşme+iskelet → M1 upload+işleme → M2 timeline+player → M3 export v1 → M4 çok katman/geçişler → M5 keyframe/hız/renk → M6 dayanıklılık. Detay: `docs/design/05-chief-architect-review.md` §4.
