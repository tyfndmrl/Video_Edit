# VPS Dagitimi

Prod stack: Caddy (otomatik HTTPS) + api + worker + migrator + Postgres 17 + Redis 7. Upload/download trafigi VPS'e ugramaz (browser <-> R2 presigned URL).

## 1. On kosullar

- Ubuntu/Debian VPS, Docker Engine + Compose plugin kurulu
- DNS: `A` kaydi -> VPS IP (`.env` icindeki `DOMAIN`)
- 80 ve 443 portlari acik

## 2. Kurulum

```bash
git clone <repo> videoedit && cd videoedit
cp .env.example .env
# .env'i doldur: DOMAIN, PG_PASSWORD, JWT_SECRET (openssl rand -base64 32), R2_* degerleri

docker compose build
docker compose up -d
docker compose logs -f migrator   # migration'in basariyla bittigini dogrula
```

## 3. Frontend dagitimi

Frontend statik dist Caddy'nin `caddy_srv` volume'undan servis edilir:

```bash
# lokalde / CI'da:
pnpm --filter editor build

# dist'i volume'a kopyala:
docker compose cp apps/editor/dist/. caddy:/srv/editor/
```

## 4. R2 kurulumu

Cloudflare dashboard > R2:

1. Iki bucket olustur: `videoedit-media-prod` ve `videoedit-exports-prod` (.env ile ayni isimler).
2. API Token olustur (Object Read & Write, bucket-scoped) -> `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`.
3. Medya bucket'ina CORS uygula (docs/design/02 §1.7 — `ExposeHeaders: ETag` olmadan multipart complete IMKANSIZ):

```json
[
  {
    "AllowedOrigins": ["https://app.seninuygulaman.com", "http://localhost:5173"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["content-type", "content-length", "range"],
    "ExposeHeaders": ["ETag", "Content-Range", "Accept-Ranges", "Content-Length"],
    "MaxAgeSeconds": 3600
  }
]
```

4. Lifecycle kurallari:
   - Medya bucket — tamamlanmamis multipart'lari 7 gunde abort et (R2 varsayilani, acikca sabitle):

```json
{ "rules": [{
    "id": "abort-incomplete-mpu",
    "conditions": { "prefix": "" },
    "abortIncompleteMultipartUploadsTransition": { "condition": { "type": "Age", "maxAge": 604800 } }
}]}
```

   - Exports bucket — objelere 30 gun TTL (sil ya da IA sinifina gecir).

## 5. Isletme

```bash
docker compose ps                  # durum
docker compose logs -f api worker  # loglar
docker compose pull && docker compose build && docker compose up -d   # guncelleme
# Migration yeniden calistirma:
docker compose run --rm migrator
# Gunluk yedek (cron'a ekle):
docker compose exec postgres pg_dump -U app videoedit | gzip > backup_$(date +%F).sql.gz
```

Gelistirme ortami icin sadece altyapi: `docker compose -f compose.dev.yml up -d` (Postgres 5432 + Redis 6379; API `dotnet run` ile 5000, Vite 5173).
