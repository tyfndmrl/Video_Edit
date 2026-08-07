# R2 Yükleme & Medya İşleme Hattı — Tasarım Dokümanı

## 0. Genel Akış (kuş bakışı)

```
Tarayıcı ──(1) POST /api/assets (init)──────────────▶ .NET API ──▶ PostgreSQL (asset kaydı, status=uploading)
Tarayıcı ◀─(2) uploadId + part presigned URL'leri ──┘
Tarayıcı ──(3) PUT part'lar DOĞRUDAN R2'ye (paralel)─▶ Cloudflare R2
Tarayıcı ──(4) POST /api/assets/{id}/complete ──────▶ .NET API ──▶ R2 CompleteMultipartUpload
                                                        │
                                                        ▼ (status=uploaded, kuyruğa iş at)
                                              Redis (kuyruk) ──▶ Worker (ffmpeg/ffprobe/audiowaveform)
                                                        │  orijinali R2'den indirir (egress $0)
                                                        ▼
                                              türevler R2'ye ──▶ status=ready, SignalR/polling ile UI'a bildir
```

VPS bant genişliği yükleme yolunda hiç kullanılmaz; sadece worker'ın işleme sırasındaki indirme/yüklemesi VPS'ten geçer (R2 egress ücretsiz olduğundan maliyet yok, sadece VPS trafiği/süresi).

---

## 1. Tarayıcıdan R2'ye Doğrudan Multipart Upload

### 1.1 R2 S3 API kısıtları (doğrulanmış)

| Kısıt | Değer |
|---|---|
| Min part boyutu | **5 MiB** (son part hariç) |
| Max part boyutu | 5 GiB |
| Max part sayısı | **10.000** |
| Max obje boyutu (multipart) | ~5 TiB |
| **R2'ye özgü:** part boyutları | **Son part hariç TÜM part'lar EŞİT boyutta olmak ZORUNDA.** S3'te part'lar farklı boyutta olabilir; R2 farklı boyutlu part'ları reddeder. İstemci tarafında chunk boyutunu sabitle, asla "kalan bant genişliğine göre" dinamik değiştirme. |
| Region | SigV4 imzalarken `region = "auto"` |
| Varsayılan lifecycle | Tamamlanmamış multipart'lar **7 gün** sonra otomatik abort edilir (bucket bazında değiştirilebilir) |

### 1.2 Önerilen part boyutu (1–2 GB dosya için)

**64 MiB sabit part boyutu.**
- 2 GB dosya → 32 part; 1 GB → 16 part. 10.000 limitinin çok altında, Class A operasyon sayısı (her UploadPart 1 Class A) düşük kalır.
- 64 MiB, kopan bağlantıda kaybedilen işi makul tutar; 5–10 MiB gibi küçük part'lar ise hem operasyon maliyetini hem HTTP overhead'ini artırır.
- Paralellik: **aynı anda 4 part** (tarayıcı per-origin bağlantı limiti 6; 4 upload + 1 API çağrısı payı). 4 × 64 MiB = 256 MiB in-flight bellek — `File.slice()` tembel olduğu için dosyanın tamamı asla RAM'e alınmaz.
- 5 TiB'a kadar ölçeklemek isteyen ileri senaryo için: partSize = `max(64 MiB, ceil(fileSize / 9500))` formülü; ama MVP'de sabit 64 MiB yeterli.

### 1.3 API sözleşmesi (.NET tarafı)

.NET'te `AWSSDK.S3` NuGet paketi R2 ile çalışır:

```csharp
var s3 = new AmazonS3Client(accessKey, secretKey, new AmazonS3Config {
    ServiceURL = "https://<account_id>.r2.cloudflarestorage.com",
    // R2 için:
    AuthenticationRegion = "auto",
    ForcePathStyle = true,
    // AWS SDK v3.7.9xx+ 'da checksum davranışı için:
    RequestChecksumCalculation = RequestChecksumCalculation.WHEN_REQUIRED,
    ResponseChecksumValidation = ResponseChecksumValidation.WHEN_REQUIRED
});
```

> **Tuzak:** Yeni AWS SDK sürümleri varsayılan olarak `x-amz-checksum-crc32` + `STREAMING-UNSIGNED-PAYLOAD-TRAILER` gönderiyor; R2 bunların bir kısmını desteklemiyor. `WHEN_REQUIRED` ayarı şart, aksi halde `CreateMultipartUpload`/`PutObject` 501 döner. Bunu entegrasyon testine bağla.

Endpoint'ler:

```
POST /api/assets
  body: { projectId, fileName, fileSize, contentType }
  → sunucu: asset kaydı (ULID), key üret, CreateMultipartUpload
  → resp: { assetId, uploadId, partSize: 67108864, partCount,
            parts: [{ partNumber, url (presigned PUT, 1h) }] }   // ilk N part'ın URL'i

POST /api/assets/{assetId}/upload/parts
  body: { partNumbers: [5,6,7] }        // URL süresi dolan/eksik part'lar için yeniden presign
  → resp: [{ partNumber, url }]

POST /api/assets/{assetId}/upload/complete
  body: { parts: [{ partNumber, etag }] }   // partNumber'a göre SIRALI gönder (zorunlu)
  → sunucu: CompleteMultipartUpload; HeadObject ile boyut == fileSize doğrula
  → status: uploaded, işleme kuyruğuna at

POST /api/assets/{assetId}/upload/abort     // kullanıcı iptali → AbortMultipartUpload
GET  /api/assets/{assetId}/upload/status    // resume için: sunucu ListParts çağırır
  → resp: { uploadId, partSize, uploadedParts: [{ partNumber, size, etag }] }
```

Presign örneği (part başına):

```csharp
var url = s3.GetPreSignedURL(new GetPreSignedUrlRequest {
    BucketName = bucket, Key = key, Verb = HttpVerb.PUT,
    UploadId = uploadId, PartNumber = partNumber,
    Expires = DateTime.UtcNow.AddHours(1)
});
```

### 1.4 İstemci yükleme motoru (React tarafı)

Hazır kütüphane olarak **Uppy** (`@uppy/aws-s3` + `shouldUseMultipart`) bu akışın tamamını (presign callback'leri, paralellik, retry, pause/resume) sağlar ve backend'e sadece yukarıdaki 4 endpoint'i ister — MVP için öneri bu. Kendin yazacaksan:

- `file.slice(i*partSize, (i+1)*partSize)` → `fetch(url, { method:'PUT', body: blob })`.
- Yanıttaki **`ETag` header'ını sakla** (Complete için gerekli). CORS'ta `ExposeHeaders: ["ETag"]` yoksa JS ETag'i OKUYAMAZ — en sık yapılan hata.
- Retry: part başına exponential backoff (3 deneme), 403 (URL süresi doldu) → re-presign endpoint'i.
- Progress: part başına `XMLHttpRequest.upload.onprogress` (fetch'te upload progress hâlâ güvenilmez; XHR ya da `ReadableStream` duplex kullan — MVP'de XHR).

### 1.5 Pause / Resume ve tarayıcı kapanması

- **Pause:** in-flight XHR'ları abort et; `{ assetId, uploadId, partSize, tamamlanan partNumber+etag listesi }` durumunu tut.
- **Aynı oturumda resume:** kaldığı part'tan devam.
- **Tarayıcı kapanıp açıldığında:** `File` handle'ı kaybolur; dosya içeriği IndexedDB'ye kopyalanMAZ (1–2 GB). Akış:
  1. IndexedDB'ye upload oturumu yaz: `{ assetId, fileName, fileSize, lastModified, partSize }` (+ mümkünse **File System Access API** `FileSystemFileHandle` — Chromium'da IndexedDB'de saklanabilir, izinle yeniden açılır; hedef tarayıcı Chromium olduğu için bunu birinci yol yap, kullanıcıya dosyayı tekrar seçtirme fallback olsun).
  2. Açılışta yarım upload varsa: handle'dan izin iste ya da "dosyayı tekrar seçin" diyaloğu; `name+size+lastModified` eşleşmesini doğrula (eşleşmezse ilk part'ın ilk 1 MiB'inin SHA-256'sını sakladığın parmak iziyle karşılaştır).
  3. Sunucudan `GET .../upload/status` → sunucu **ListParts** ile R2'deki gerçek durumu döner (istemci state'ine güvenme; yarım kalan part R2'de yoktur, tekrar yüklenir).
  4. Eksik part'lar için re-presign, devam.
- Lifecycle'ın 7 günlük abort'u resume penceresinin üst sınırıdır; UI'da "yarım yüklemeler 7 gün saklanır" de.

### 1.6 Bütünlük (integrity)

- **Part düzeyi:** R2'de tek part'ın ETag'i içeriğin MD5'idir. İstemci part MD5'ini hesaplayıp (WebCrypto'da MD5 yok; `hash-wasm` kütüphanesi) dönen ETag ile karşılaştırabilir. MVP'de bu opsiyonel — TLS + boyut kontrolü çoğu bozulmayı yakalar.
- Presigned PUT'a `Content-Length`'i imzaya dahil etmek yerine complete sonrası **HeadObject: toplam boyut == beyan edilen fileSize** kontrolü yap (ucuz ve kesin).
- **Tam dosya doğrulaması:** multipart ETag `md5(md5'ler)-N` formatındadır, tam dosya hash'i değildir. Kesin doğrulama istenirse worker zaten dosyayı indiriyor; indirme sırasında SHA-256 hesaplayıp asset kaydına yaz (ileride dedüplikasyon için de kullanılır). ffprobe'un dosyayı sorunsuz parse etmesi de pratik bir "bozuk mu" testidir.
- R2'nin `x-amz-checksum-*` desteği kısmi ve SDK sürümüne duyarlı — **multipart tarafında checksum header'larına yaslanma**, yukarıdaki yaklaşım yeterli.

### 1.7 CORS konfigürasyonu (R2 bucket)

```json
[
  {
    "AllowedOrigins": ["https://app.seninuygulaman.com", "http://localhost:5173"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["content-type", "content-length"],
    "ExposeHeaders": ["ETag", "Content-Range", "Accept-Ranges", "Content-Length"],
    "MaxAgeSeconds": 3600
  }
]
```

- `ExposeHeaders: ETag` olmadan multipart complete edilemez (yukarıda belirtildi).
- `GET` + `Content-Range/Accept-Ranges` expose'u, `<video>` elementi ve WebCodecs fetch'lerinin Range ile seek yapabilmesi için.
- CreateMultipartUpload/Complete/Abort/ListParts **backend'den** yapıldığı için CORS'a `POST/DELETE` gerekmez — saldırı yüzeyi küçülür.

### 1.8 Tamamlanmamış upload temizliği

Bucket lifecycle kuralı (R2 varsayılanı zaten 7 gün, açıkça sabitle):

```json
{ "rules": [{
    "id": "abort-incomplete-mpu",
    "conditions": { "prefix": "" },
    "abortIncompleteMultipartUploadsTransition": { "condition": { "type": "Age", "maxAge": 604800 } }
}]}
```

Ek olarak backend'de günlük job: `status=uploading` olup 7 günden eski asset kayıtlarını `failed/expired` işaretle (DB ile R2 tutarlılığı). Abort işlemi ücretsizdir.

---

## 2. Bucket / Key Düzeni

**Tek bucket** (`videoedit-media`), ortam ayrımı bucket'la (`videoedit-media-dev` / `-prod`). İkinci bir **`videoedit-exports`** bucket'ı export çıktıları için (farklı lifecycle: export'lar 30 gün sonra IA sınıfına ya da silinebilir).

Asset'ler **kullanıcıya** bağlı, projeye değil (aynı videonun iki projede kullanımı re-upload gerektirmesin; proje-asset ilişkisi DB'de many-to-many):

```
u/{userUlid}/a/{assetUlid}/original/{sanitizedFileName}.mp4
u/{userUlid}/a/{assetUlid}/proxy/540p.mp4
u/{userUlid}/a/{assetUlid}/filmstrip/sprite_{n}.jpg        (+ manifest.json)
u/{userUlid}/a/{assetUlid}/waveform/peaks.json
u/{userUlid}/a/{assetUlid}/meta/probe.json
u/{userUlid}/a/{assetUlid}/thumb/poster.jpg
```

- **ULID** (`Ulid` NuGet / `ulid` npm): zaman sıralı, çakışmasız, GUID'den okunaklı. Key çakışması yapısal olarak imkânsız çünkü assetUlid sunucuda üretilir.
- Orijinal dosya adı key'de *sanitize edilmiş* olarak tutulur (indirmede güzel isim için), asıl kimlik ULID'dir; asıl `fileName` DB'de.
- Prefix'ler kısa (`u/`, `a/`) — key'ler timeline JSON'ına girmez, timeline sadece `assetId` taşır; URL çözümlemesi her zaman API üzerinden (Paylaşılan Sözleşme'ye uygun).

DB modeli (özet):

```sql
assets(id ulid PK, user_id, original_key, file_name, file_size, content_type,
       status enum(uploading,uploaded,processing,ready,failed),
       upload_id text NULL, sha256 bytea NULL,
       duration_us bigint, width int, height int, fps_num int, fps_den int,
       has_audio bool, probe_json jsonb, error text, created_at, ready_at)
project_assets(project_id, asset_id, PK(project_id, asset_id))
asset_derivatives(asset_id, kind enum(proxy,filmstrip,waveform,poster,probe), key, meta jsonb)
```

`duration_us` ve `fps_num/fps_den` — sözleşmedeki tamsayı/rational zaman kuralına uygun; float saniye hiçbir tabloya girmez.

---

## 3. Proxy Üretim Hattı

### 3.1 Kuyruk & worker mimarisi

- Kuyruk: **Redis Streams + consumer group** (ya da .NET ekosisteminde hazır istiyorsan **Hangfire**, PostgreSQL storage ile; MVP için Hangfire daha az kod). İş tipleri: `probe`, `proxy`, `filmstrip`, `waveform` — `probe` önce koşar, kalan üçü paralel/apeş sıralı.
- Worker: aynı Docker imajında .NET worker service + `ffmpeg`/`ffprobe`/`audiowaveform` binary'leri. Ölçek: worker replikası = eşzamanlı transcode sayısı; her transcode'a `-threads` sınırı koyma, ffmpeg makineyi kullansın, eşzamanlılığı replika sayısıyla yönet.
- Worker orijinali R2'den **diske** indirir (stream'leyerek; 1–2 GB RAM'e alınmaz). Gigabit VPS'te 2 GB ≈ 20–30 sn. İndirme sırasında SHA-256 hesapla (bkz. 1.6).
- İlerleme: ffmpeg `-progress pipe:1` çıktısı parse edilip Redis'e yazılır; UI SignalR/polling ile `processing %62` gösterir.
- Idempotency: her iş `asset_id + kind` anahtarıyla tekildir; worker çökerse iş yeniden koşar, çıktı key'inin üzerine yazmak güvenlidir.

### 3.2 ffprobe metadata

```
ffprobe -v quiet -print_format json -show_format -show_streams -show_chapters input.mp4
```

Çıktı `meta/probe.json`'a ve özet alanlar (duration → mikrosaniyeye çevrilerek, `r_frame_rate` → `fps_num/fps_den` rational olarak) `assets` tablosuna. **VFR tespiti** burada yapılır (`avg_frame_rate` ≠ `r_frame_rate`) — VFR kaynaklar proxy'de CFR'a sabitlenir, yoksa timeline frame hesapları kayar.

### 3.3 Scrubbing-dostu proxy

```
ffmpeg -i original.mp4 \
  -vf "scale=-2:540:flags=bicubic,fps=30000/1001" \        # kaynak fps'e göre; VFR ise CFR'a zorla
  -c:v libx264 -preset veryfast -crf 23 -profile:v main -pix_fmt yuv420p \
  -g 15 -keyint_min 15 -sc_threshold 0 -bf 0 \
  -c:a aac -b:a 128k -ac 2 -ar 48000 \
  -movflags +faststart \
  proxy/540p.mp4
```

Gerekçeler:
- **540p (`-2:540`)**: timeline önizleme penceresi tipik ~800–1000 px genişlikte; 540p yeterli netlik, 720p'ye göre ~%40 küçük dosya ve decode yükü. Dikey videolar için `scale='if(gt(iw,ih),-2,540)':'if(gt(iw,ih),540,-2)'` varyantı.
- **`-g 15 -sc_threshold 0 -bf 0`**: yarım saniyede bir IDR keyframe + B-frame yok → tarayıcı seek'i en yakın keyframe'e ışınlanıp en fazla 14 frame decode eder; scrubbing gecikmesi ~milisaniyeler. Bitrate maliyeti (%20–30 artış) proxy'de kabul edilebilir. Bu, proxy tasarımının en kritik parametresidir.
- **CRF 23 + veryfast**: kalite/hız dengesi; proxy görsel referanstır, arşiv değil. Beklenen çıktı ~2–3 Mbps → 10 dk video için ~150–220 MB.
- **`+faststart`**: moov atomu başa taşınır; `<video>` ilk byte'larla oynamaya başlar (progressive playback, HLS'e gerek kalmaz).
- **AAC 128k/48kHz stereo**: evrensel decode, senkron sorunsuz.
- **H.264/yuv420p**: her Chromium'da donanım decode garantisi. (AV1/HEVC proxy'de kazanç yok, decode uyumluluk riski var.)

### 3.4 Filmstrip thumbnail sprite

```
ffmpeg -i original.mp4 -vf "fps=1,scale=160:-2,tile=30x10" -q:v 5 filmstrip/sprite_%d.jpg
```

- Saniyede 1 kare, 160 px genişlik, sprite başına 300 kare (30×10 grid ≈ 160×90×300 ≈ 4800×900 px, ~600 KB JPEG). 1 saatlik video = 12 sprite.
- `filmstrip/manifest.json`: `{ intervalUs: 1000000, tileW:160, tileH:90, cols:30, rows:10, frameCount, sprites:[...] }` — frontend CSS `background-position` ile çizer.
- Uzun videolarda adaptif aralık: `interval = max(1, ceil(durationSec/3000))` sn (sprite sayısını sınırla).

### 3.5 Waveform peaks

Araç: **`audiowaveform`** (BBC, apt paketi mevcut) — bu iş için standart.

```
ffmpeg -i original.mp4 -vn -ac 1 -ar 8000 -f wav - | \
  audiowaveform --input-format wav -i - -o waveform/peaks.json --pixels-per-second 50 -b 8
```

- 50 peak/sn, 8-bit → 1 saatlik ses ≈ 350 KB JSON (gzip ~%60 küçülür). Frontend zoom-out'ta downsample eder; çok derin zoom gerekirse ikinci seviye (`--pixels-per-second 400`, sadece görünür aralık için lazımsa v2).
- Alternatif (bağımlılık istemezsen): ffmpeg ile PCM çek, .NET'te max/min pencereleme — 50 satır kod; ama audiowaveform'un çıktı formatı (`version:2` JSON) frontend kütüphaneleriyle (ör. waveform-data.js) uyumlu geldiğinden önerim o.

### 3.6 İşlem süresi tahminleri (1–2 GB, ~10–20 dk 1080p kaynak; 4 vCPU Hetzner CCX/CPX)

| Adım | Süre |
|---|---|
| R2'den indirme (1 Gbps) | 20–40 sn |
| ffprobe | < 2 sn |
| Proxy transcode (1080p→540p, veryfast) | gerçek zamanın ~0.15–0.3×: 10 dk video → **1.5–3 dk**; 4K kaynakta 2–3 kat uzar |
| Filmstrip | 30–90 sn (ayrı decode geçişi; proxy ile paralel koşabilir ama CPU paylaşır) |
| Waveform | 10–20 sn |
| Türev upload (R2) | 10–20 sn |
| **Toplam (uçtan uca)** | **~3–6 dk** — UI'da "işleniyor" durumu ve progress şart |

Optimizasyon (v2): tek ffmpeg çağrısında çoklu çıktı (`-filter_complex split`) ile proxy+filmstrip aynı decode'da → toplam ~%30 kısalır.

---

## 4. Medyanın Tarayıcıya Servisi

Seçenekler:

| Yöntem | Artı | Eksi |
|---|---|---|
| **Presigned GET (R2 endpoint'i)** | En basit; Range destekli; egress $0; erişim doğal olarak yetkili | CDN cache yok (her istek R2'ye = Class B op); URL'ler süreli, `<video src>` yenilemesi gerekir |
| Custom domain + public bucket + CDN | Cloudflare cache, hızlı | **Erişim kontrolü yok** — kullanıcı medyası için elenir |
| **Cloudflare Worker proxy (custom domain, JWT/imzalı cookie doğrular, R2 binding + CF cache)** | Cache + erişim kontrolü + sabit URL'ler | Ekstra bileşen; Worker istek ücreti; ilk kurulumu MVP'yi uzatır |

**Öneri:** MVP'de **presigned GET**, v2'de proxy/filmstrip/waveform gibi sık okunan türevler için **Worker proxy'ye** geç (orijinaller zaten sadece worker ve export tarafından okunur, onlara presigned yeter). R2 Class B $0.36/M olduğundan cache'siz gitmenin maliyeti düşük; Worker'ın asıl getirisi gecikme ve sabit URL.

Uygulama detayları:
- **Range request:** R2, presigned GET'te `Range` header'ını destekler — video seek için zorunlu; CORS `ExposeHeaders`'ta `Content-Range`/`Accept-Ranges` olduğunu unutma (bkz. 1.7). Faststart mp4 + Range = HLS'siz sorunsuz seek.
- **URL süresi/yenileme:** proje açılınca `GET /api/projects/{id}/media-urls` tüm asset türevleri için **12 saatlik** presigned URL'leri toplu döner. İstemci `expiresAt`'i tutar; kalan süre < 1 saat olduğunda arka planda yeniler ve `<video>` elementlerinde `currentTime` korunarak `src` swap edilir. 403 yakalanırsa reaktif yenileme (uyuyan sekme senaryosu).
- Presigned URL'ler kimseye e-posta/DB ile dağıtılmaz, log'lanmaz (query string'de imza taşırlar).

---

## 5. Maliyet Analizi (R2, 2026 fiyatları)

Birimler: Storage **$0.015/GB-ay** (Standard), Class A **$4.50/M** (yazma: PutObject, UploadPart, CreateMPU, ListParts...), Class B **$0.36/M** (okuma: GET, Head), **egress $0**. IA sınıfı: $0.01/GB-ay ama +$0.01/GB retrieval — export/arşiv için düşünülebilir, aktif medyada değmez.

**Varsayımlar (1000 kullanıcı):** kullanıcı başına ort. 5 asset × 1.5 GB orijinal = 7.5 GB; türevler ≈ orijinalin %12'si (~0.9 GB) → **~8.4 GB/kullanıcı → 8.4 TB toplam**.

| Kalem | Hesap | Aylık |
|---|---|---|
| Depolama | 8 400 GB × $0.015 | **~$126** |
| Upload Class A | 5 000 yeni asset/ay × (~24 part + 3 op) ≈ 135 K | ~$0.60 |
| İşleme Class A (türev yazma) | 5 000 × ~15 obje | ~$0.35 |
| Okuma Class B | editör oturumları: 1000 kullanıcı × 20 oturum × ~200 GET (Range istekleri dahil) = 4 M | ~$1.50 |
| Egress | proxy izleme + export indirme dahil | **$0** |
| **Toplam R2** | | **~$130/ay** |

Sonuç: maliyet pratikte **tamamen depolamadır**; operasyonlar yuvarlama hatası. Aynı hacim S3'te egress ile birlikte 3–5 kat pahalı olurdu. Maliyet kontrolü = depolama politikası: silinen projelerin asset'lerini referans sayacıyla temizle, `failed` yüklemeleri lifecycle ile süpür, export çıktılarına 30 günlük TTL koy.

---

## 6. Fazlar / Milestone'lar

1. **F1 – Upload çekirdeği (1–1.5 hafta):** bucket + CORS + lifecycle; asset tablosu; init/presign/complete/abort endpoint'leri; Uppy entegrasyonu; ETag toplama; boyut doğrulama. *Kabul: 2 GB dosya, 4 paralel part, ağ koparıp devam ederek yükleniyor.*
2. **F2 – Resume + dayanıklılık (0.5–1 hafta):** IndexedDB oturum kaydı + FileSystemHandle; ListParts tabanlı resume; expired upload süpürücü job. *Kabul: tarayıcı kapatılıp açıldığında upload kaldığı part'tan sürüyor.*
3. **F3 – İşleme hattı (1.5–2 hafta):** kuyruk + worker imajı (ffmpeg/ffprobe/audiowaveform); probe→proxy→filmstrip→waveform; progress raporlama; retry/idempotency; status=ready bildirimi. *Kabul: 2 GB 1080p dosya < 6 dk'da ready; VFR kaynak CFR proxy üretiyor.*
4. **F4 – Servis katmanı (0.5 hafta):** toplu presigned GET endpoint'i; URL yenileme; player'da Range ile seek doğrulaması.
5. **F5 – Hijyen & maliyet (0.5 hafta):** silme akışı (DB + R2 prefix silme), yetim obje taraması, metrikler (upload başarı oranı, işleme süresi p95).

## 7. Bilinen Tuzaklar (özet kontrol listesi)

1. **R2 eşit part boyutu zorunluluğu** — dinamik chunk boyutu kullanan S3 kütüphaneleri R2'de patlar; sabit 64 MiB.
2. **CORS `ExposeHeaders: ETag` eksikliği** — upload "çalışır" ama complete edilemez; sessizce ilerleyen en yaygın hata.
3. **AWS SDK yeni checksum varsayılanları** (CRC32 trailer) R2'de 501 üretir — `WHEN_REQUIRED` ayarı ve SDK sürüm sabitleme.
4. CompleteMultipartUpload'da part listesi **partNumber sırasında** olmalı.
5. `region="auto"` ve path-style; aksi imza hataları kriptik 403'ler üretir.
6. Presigned URL süresi ile part yükleme süresi yarışır — yavaş bağlantıda 1 saatlik URL 64 MiB'lik part bitmeden dolabilir; re-presign endpoint'i baştan koy.
7. Lifecycle 7 gün: resume penceresini UI'da bildir; DB'yi R2 ile senkron süpür.
8. Fetch ile upload progress alınamaz — XHR kullan.
9. VFR kaynaklar: proxy'yi CFR'a sabitlemeden timeline frame matematiği (tamsayı zaman sözleşmesi) orijinalle proxy arasında kayar.
10. moov atomu sonda olan orijinaller (faststart'sız kaynak): worker Range ile metadata okumaya çalışırsa tüm dosyayı çeker — worker zaten komple indiriyor, sorun değil; ama ileride "orijinalden kısmi okuma" optimizasyonu planlanırsa hatırla.
11. Proxy'de B-frame/uzun GOP bırakmak scrubbing'i mahveder — `-g 15 -sc_threshold 0 -bf 0` regresyona karşı export edilen proxy'de otomatik testle (ffprobe keyframe aralığı) korunmalı.
12. Presigned GET URL'leri cache-key'i bozar (her imza farklı) — CDN cache beklentisiyle presigned kullanma; cache isteniyorsa Worker proxy.
13. Büyük dosyada `File.slice` güvenli ama kullanıcı diskten dosyayı taşır/silerse slice okuma `NotReadableError` verir — part okuma hatasını "dosya değişti, yeniden seçin" akışına bağla.

Sources:
- [Cloudflare R2 docs — Use the R2 multipart API from Workers](https://developers.cloudflare.com/r2/api/workers/workers-multipart-usage/)
- [Cloudflare R2 docs — Object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
- [Cloudflare R2 docs — Rclone example (part size considerations)](https://developers.cloudflare.com/r2/examples/rclone/)
- [cloudflare-docs PR #7396 — multipart part size considerations](https://github.com/cloudflare/cloudflare-docs/pull/7396)
- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing)
- [apache/arrow #41506 — R2 equal part size workaround](https://github.com/apache/arrow/issues/41506)