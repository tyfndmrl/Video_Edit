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

Gereksinimler: Node ≥ 22, pnpm ≥ 10, .NET 10 SDK, Docker (postgres/redis için).

```bash
pnpm install
docker compose -f compose.dev.yml up -d   # postgres + redis
dotnet run --project backend/src/VideoEdit.Api
pnpm dev                                   # Vite dev server (http://localhost:5173)
```

Şema değişikliği sonrası: `pnpm schema:generate` (JSON Schema + C# DTO yeniden üretilir).

## Yol Haritası

M0 sözleşme+iskelet → M1 upload+işleme → M2 timeline+player → M3 export v1 → M4 çok katman/geçişler → M5 keyframe/hız/renk → M6 dayanıklılık. Detay: `docs/design/05-chief-architect-review.md` §4.
