# VPS Dagitimi

Prod stack: Caddy (otomatik HTTPS) + api + worker + migrator + Postgres 17 + Redis 7. Upload/download trafigi VPS'e ugramaz (browser <-> R2 presigned URL).

> **Durum notu (2026-08-12, `f39e0b4`): bu adimlarin tamami HENUZ GERCEK BIR VPS'te ve
> GERCEK R2 hesabinda kosulmadi.** Tum gelistirme ve CI lokal MinIO ile yapildi. Kod yolu
> S3 API uyumlu oldugu icin ayni, ama gercek R2'nin CORS davranisi, presigned imza uyumu,
> multipart ETag bicimi ve lifecycle kurallari dogrulanmamistir. Ilk dagitimda §4 ve §7'ye
> vakit ayirin. Bkz. [`docs/poc-bilinen-sinirlar.md`](../docs/poc-bilinen-sinirlar.md) §4.2.

## 1. On kosullar

- Ubuntu/Debian VPS, Docker Engine + Compose plugin kurulu
- DNS: `A` kaydi -> VPS IP (`.env` icindeki `DOMAIN`)
- 80 ve 443 portlari acik
- Yerelde (ya da CI'da) Node >= 22 + pnpm >= 10: frontend `dist`'i burada uretilir (§3)
- `curl` + `jq` (font kurulum scripti icin — §5)

## 2. Kurulum

```bash
git clone <repo> videoedit && cd videoedit
cp .env.example .env
# .env'i doldur: DOMAIN, PG_PASSWORD, JWT_SECRET (openssl rand -base64 32), R2_* degerleri

docker compose build
docker compose up -d
docker compose logs -f migrator   # migration'in basariyla bittigini dogrula
```

Migration ayri bir **one-shot** `migrator` servisidir (api imajini `--migrate-only` ile
calistirir); `api` ve `worker` onun `service_completed_successfully` kosuluna baglidir, yani
replika sayisi artsa bile migration yarisi olmaz. Elle yeniden calistirmak icin:

```bash
docker compose run --rm migrator
```

### Ortam degiskenleri: ASPNETCORE_ENVIRONMENT ve DOTNET_ENVIRONMENT

Iki servis ortam adini FARKLI degiskenlerden okur ve compose.yml IKISINI BIRDEN acikca set eder:

- `api` (ASP.NET Core web host) -> `ASPNETCORE_ENVIRONMENT=Production`
- `worker` (generic host) -> `DOTNET_ENVIRONMENT=Production` (`ASPNETCORE_ENVIRONMENT`'i OKUMAZ)

Prod guard'lari (zorunlu `ConnectionStrings__Postgres`, `R2__*`, api'de `Jwt__Secret`) ve
"localhost fallback yalniz Development" kurali bu ortam adina bakar. Degiskenler silinirse
varsayilan yine Production'dur, ama acik set etmek yanlislikla `Development`'a dusup
guard'larin atlanmasini onler. Worker ayrica acilista `ffmpeg -version` / `ffprobe -version`
kontrolu yapar — imajda ffmpeg yoksa fail-fast olur (Dockerfile kurar; ozel imajda
`Ffmpeg__FfmpegPath` / `Ffmpeg__FfprobePath` ile tam yol verilebilir).

### compose.yml'in set ETTIGI / ETMEDIGI degiskenler

| Degisken | api | worker | Not |
|---|---|---|---|
| `ConnectionStrings__Postgres` / `__Redis` | ✅ | ✅ | `.env`'deki `PG_PASSWORD`'dan turetilir |
| `Jwt__Secret` | ✅ | — | worker JWT uretmez |
| `R2__AccountId` / `AccessKeyId` / `SecretAccessKey` / `Bucket` / `ExportsBucket` | ✅ | ✅ | `.env`'den |
| `Processing__CacheDirectory` | — | ✅ `/data/cache` | kalici `worker_data` volume'u; bos birakilirsa her restart'ta GB'larca yeniden indirme |
| `VIDEOEDIT_FONT_ROOT` | ❌ **elle eklenmeli** | ✅ `/data/fonts` (Dockerfile'da) | §5 |
| `Fonts__AllowSystemFallback` | — | ❌ **elle eklenmeli** | §5 — uretimde `false` olmali |
| `Quotas__*`, `Processing__MaxDurationUs`, `Processing__MaxCacheBytes` | opsiyonel | opsiyonel | varsayilanlar: 20 GiB/kullanici, 4 GiB/dosya, 5 esz. upload, 4 saat medya, 20 GiB cache |

## 3. Frontend dagitimi

Frontend statik dist Caddy'nin `caddy_srv` volume'undan servis edilir:

```bash
# lokalde / CI'da:
pnpm --filter editor build

# dist'i volume'a kopyala:
docker compose cp apps/editor/dist/. caddy:/srv/editor/
```

> **Dikkat:** `apps/editor/public/e2e-test-video.mp4` (122 MB, gitignore'lu E2E fixture'i)
> lokalde varsa `vite build` onu `dist/`e kopyalar. Surum build'inden ONCE silin, yoksa
> 122 MB'lik bir dosyayi Caddy volume'una tasirsiniz.

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

4. **Exports bucket'ina da CORS uygula.** Indirme baglantisi presigned GET'tir ve tarayicidan
   cagrilir; `AllowedMethods: ["GET", "HEAD"]` yeterlidir.

5. Lifecycle kurallari:
   - Medya bucket — tamamlanmamis multipart'lari 7 gunde abort et (R2 varsayilani, acikca sabitle):

```json
{ "rules": [{
    "id": "abort-incomplete-mpu",
    "conditions": { "prefix": "" },
    "abortIncompleteMultipartUploadsTransition": { "condition": { "type": "Age", "maxAge": 604800 } }
}]}
```

   - Exports bucket — objelere 30 gun TTL (sil ya da IA sinifina gecir).

> **COEP uyarisi (dogrulanmadi).** Caddyfile ve Vite dev sunucusu
> `Cross-Origin-Embedder-Policy: require-corp` gonderir. Bu politika altinda capraz kaynakli
> medya, CORS ile yuklenmek zorundadir — editor `<video>`/`<img>` uzerinde
> `crossOrigin = 'anonymous'` kullanir — uc yerde: `player/engine-video/videoPool.ts`
> (`<video>` havuzu), `player/engine-video/engineV1.ts` (gorsel/sticker `<img>`) ve
> `timeline/render/mediaCache.ts` (serit kucuk resimleri) — ve MinIO ile bu **calisiyor**.
> R2'de dogrulayin: onizleme siyah
> kaliyor / konsolda `ERR_BLOCKED_BY_RESPONSE` goruyorsaniz once R2 CORS'unu, sonra
> `Cross-Origin-Embedder-Policy`'yi `credentialless`a dusurmeyi deneyin — **ve dev/prod'u
> BIRLIKTE degistirin** (`deploy/Caddyfile` + `apps/editor/vite.config.ts`).

## 5. Fontlar — dagitimin ZORUNLU adimi

Metin kliplerinin tek font kaynagi `fonts/manifest.json`'daki kuratorlu settir
([`fonts/README.md`](../fonts/README.md) baglayici). **TTF dosyalari depoya girmez ve
imajlara da gomulmez** (build context'i `./backend`). Kurulmazsa:

- **api**: `GET /api/fonts` **503** doner, `GET /api/fonts/{id}/{style}.ttf` **404**.
  Editor derlenmis 4 id'ye duser ama `@font-face` dosyasi gelmedigi icin tarayici KENDI
  fallback fontuyla olcer -> **onizleme, export'un rasterledigi metinle ayni degildir**.
- **worker**: Linux imaji `SkiaSharp.NativeAssets.Linux.NoDependencies` kullanir; fontconfig
  YOKTUR, yani sistem fontu fallback'i de calismaz -> metin klibi iceren export
  **`font-missing` ile duser**.

### 5.1 Fontlari her iki container'a kur

```bash
# VPS'te, depo kokunde: TTF'leri bir kez indir (curl + jq gerekir).
# Script manifest.json'daki resmi adreslerden indirir ve manifest.lock.json'a sha256 yazar.
./fonts/fetch-fonts.sh
find fonts -name '*.ttf' | wc -l    # beklenen: 16
```

Sonra `compose.yml`'de **iki servise de** ayni bind mount'u ekleyin (en basit ve
restart'a dayanikli yol — repo VPS'te zaten var):

```yaml
  api:
    environment:
      # ... mevcut degiskenler ...
      - VIDEOEDIT_FONT_ROOT=/data/fonts
    volumes:
      - ./fonts:/data/fonts:ro          # api imajinda font YOKTUR; disaridan baglanir

  worker:
    environment:
      # ... mevcut degiskenler ...
      # Kuratorlu TTF yoksa SESSIZCE sistem fontuna kayma: deterministik hata ver.
      - Fonts__AllowSystemFallback=false
    volumes:
      - worker_data:/data               # (mevcut)
      - ./fonts:/data/fonts:ro          # VIDEOEDIT_FONT_ROOT zaten /data/fonts (Dockerfile)
```

```bash
docker compose up -d api worker        # yeni mount'lar icin yeniden olusturur
```

> Repo VPS'te DEGILSE (yalniz imaj dagitiyorsaniz) alternatif: fontlari kalici volume'a
> kopyalayin — `docker compose cp fonts/. worker:/data/fonts/` — ve api icin ayri bir
> named volume kurup ayni kopyayi oraya yapin. Bind mount daha az hareketli parca icerir.

### 5.2 Dogrulama

```bash
# 1) Katalog pinli mi (pinned:true = sha256 pinleri tutuyor)
curl -s https://$DOMAIN/api/fonts | jq '{manifestVersion, lockVersion, pinned, ids:[.fonts[].id]}'
# beklenen: pinned true, 4 id (noto-sans, noto-serif, open-sans, roboto)

# 2) TTF gercekten servis ediliyor mu (HEAD mapli DEGIL -> 405 doner; GET kullanin)
curl -s -o /dev/null -w '%{http_code} %{content_type} %{size_download}\n' \
     https://$DOMAIN/api/fonts/roboto/400.ttf
# beklenen: 200 font/ttf 515100

# 3) Worker acilis logunda manifest yuklendi mi
docker compose logs worker | grep -i "Font manifesti"
# beklenen: "Font manifesti yuklendi (4 fontId, 16/16 dosya, parmak izi <64 hex>): ... — kok: /data/fonts"

# 4) API ile worker AYNI koku mu goruyor? (metin kapilarinin 422/503 kararlari bu varsayima
#    dayanir — docs/poc-bilinen-sinirlar.md §3.3)
curl -s https://$DOMAIN/health | jq .fonts
# beklenen: found:true, fontIds:4, filesPresent == filesDeclared == 16, fingerprint dolu.
# fingerprint degeri 3. adimdaki worker satirinin "parmak izi" degeriyle BIREBIR ayni olmali:
# ayni tureyis (manifest + lock pin setinin sha256'si) iki ucta da kullanilir. Degerler
# ayrisiyorsa iki surec FARKLI kok ya da farkli manifest.lock goruyor — §5.1'deki bind
# mount'lari esitleyin ve iki servisi yeniden olusturun.
```

Font kokunu bulamayan worker **acilista UYARIR, dusmez**; sorunu ilk metin klipli export'ta
gorursunuz. Yukaridaki 3. komut bunu dagitim aninda yakalar; 4. komut ayrica API'nin de ayni
kurulumu gordugunu kanitlar (`/health` font eksiginde de **200 doner** — rapor durustur ama
saglik kapisi degildir; `found:false` + bakilan yol + sebep gosterir).

## 6. Isletme

```bash
docker compose ps                  # durum
docker compose logs -f api worker  # loglar
docker compose pull && docker compose build && docker compose up -d   # guncelleme
# Migration yeniden calistirma:
docker compose run --rm migrator
# Gunluk yedek (cron'a ekle):
docker compose exec postgres pg_dump -U app videoedit | gzip > backup_$(date +%F).sql.gz
```

**Yedeklenmesi gerekenler:** `pg_data` (timeline + revision gecmisi + kullanicilar) ve R2
bucket'lari. `worker_data` yeniden uretilebilir (cache + fontlar), `caddy_data` sertifika
tutar — silmeyin, Let's Encrypt rate limit'ine takilirsiniz.

**Olceklendirme notu.** `export` kuyrugu `WorkerCount = 1`'dir (ffmpeg zaten tum cekirdekleri
kullanir), `transcode` kuyrugu 2. Yani **ayni anda tek export** render edilir; ikinci
kullanici siraya girer. Coklu worker container'i ile yatay olcekleme **denenmedi**
(Hangfire/Postgres storage buna izin verir, ama dogrulanmadi).

## 7. Ilk dagitim kontrol listesi

- [ ] `.env` dolduruldu; `JWT_SECRET` gercekten rastgele (`openssl rand -base64 32`)
- [ ] DNS A kaydi VPS'e isaret ediyor, 80/443 acik
- [ ] `docker compose logs migrator` -> migration basarili
- [ ] `curl -fsS https://$DOMAIN/api/fonts` -> 200 **ve** `pinned: true` (§5.2)
- [ ] `docker compose logs worker | grep "Font manifesti"` -> yuklendi
- [ ] `curl -s https://$DOMAIN/health | jq .fonts` -> `found:true` ve `fingerprint` worker
      satirindaki "parmak izi" ile ayni (§5.2 adim 4)
- [ ] R2 CORS: medya bucket (`ExposeHeaders: ETag`) **ve** exports bucket
- [ ] R2 lifecycle: multipart abort 7 gun, exports 30 gun TTL
- [ ] Frontend `dist` kopyalandi, `e2e-test-video.mp4` **icinde degil**
- [ ] Duman testi: kayit -> proje -> kucuk bir MP4 yukle -> "Hazir" oluyor mu -> timeline'a
      ekle -> **metin klibi ekle** -> export -> indirme baglantisi calisiyor mu
- [ ] Postgres yedegi cron'a eklendi

Gelistirme ortami icin sadece altyapi: `docker compose -f compose.dev.yml up -d` (Postgres 5432 + Redis 6379 + MinIO 9000/9001; API `dotnet run` ile 5000, Vite 5173).
