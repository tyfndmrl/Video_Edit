# BAŞ MİMAR ELEŞTİRİSİ — Çapraz Denetim Raporu

## 1. TUTARSIZLIKLAR

### 1.a Timeline JSON şeması: Frontend ↔ Export Compiler

**KRİTİK — Geçiş (transition) modeli birbirini dışlıyor.**
- Frontend invaryant #1: `clip[i].end <= clip[i+1].start` (çakışma YASAK) + geçiş `transitionIn/transitionOut` alanı olarak clip üzerinde.
- Export tasarımı §2.3: "geçiş = komşu kliplerin timeline'da x kadar üst üste binmesi" (overlap modeli) ve `offset_i = offset_{i-1} + dur(c_i) - x_i` matematiği overlap varsayar; toplam süre `durA + durB - x` olur.
- Bu iki model aynı anda doğru olamaz. Overlap'siz bitişik klipler + xfade uygulanırsa toplam süre geçiş süresi kadar KISALIR ve tüm sonraki kliplerin timeline pozisyonları kayar.
- **Karar önerisi:** Frontend'in adjacency + `transition` metadata modeli sözleşme olsun (invaryant korunur, editör basit kalır). Export compiler geçişi şöyle türetir: geçiş süresi D, kesim noktası etrafında A'nın `sourceOut`'u D/2 ileri, B'nin `sourceIn`'i D/2 geri uzatılır (**handle** gereksinimi). Yeni invaryant: geçişli kenarda `sourceOut + D/2 <= asset.durationUs` ve `sourceIn - D/2 >= 0`; editör bu handle yoksa geçişi reddetmeli/kısaltmalı. Bu kural şemaya (`superRefine`) ve compiler validasyonuna aynı formülle yazılmalı. Alternatif (overlap modeli) seçilirse frontend invaryant #1 ve trim/snapping mantığı baştan değişir — daha pahalı.

**Efekt parametreleri eşlenmemiş.**
- Frontend `colorAdjust`: `brightness/contrast/saturation/temperature/tint/exposure` hepsi `-1..1`. Export: ffmpeg `eq` (brightness -1..1 toplamsal, contrast 0..2 çarpımsal, saturation 0..3) + `colortemperature` (Kelvin). `tint` ve `exposure` export tasarımında hiç yok.
- Frontend `blur` ve `chromaKey` efekt tipleri tanımlı; export compiler'da karşılığı tasarlanmamış (`boxblur/gblur`, `chromakey/colorkey` map'i eksik).
- Frontend `lut: { assetId }` — .cube dosyasının asset olarak upload/lifecycle'ı hiçbir tasarımda yok.
- **Gerekli:** Sözleşmeye normatif eşleme tablosu: her param için `UI değeri → ffmpeg formülü → WebGL shader formülü` tek dokümanda; MVP efekt seti `blur/chromaKey` çıkarılarak daraltılsın ya da compiler'a eklensin.

**Animasyonlu efekt parametresi (`fx.<id>.<param>` keyframe'leri) export'ta karşılıksız.** `eq` zaman expression'ı almaz; sendcmd ile komut desteği param bazında kısıtlı. MVP kararı net olmalı: efekt paramları keyframe'lenemez (şemadan `fx.*` çıkar) veya sendcmd ile örneklenen paramlar whitelist'lenir.

**Transform → piksel dönüşüm formülü tanımsız.** Frontend normalize koordinat (`x,y ∈ [-0.5..0.5]`, `scale=1 = fit`, anchor, rotationDeg); export örneği doğrudan piksel (`x=50→800`, `scale=768:-2`). "Fit boyutu" tanımı (contain? letterbox?), anchor etrafında rotasyon (ffmpeg `rotate` merkez etrafında döner, anchor desteklemez — pad/crop kombinasyonu gerekir), scale→rotate→translate sıralaması sözleşmede yok. Bu tanımlanmadan piksel parity imkânsız.

**Easing eğrileri:** Frontend `easeIn/easeOut/easeInOut` preset'lerinin tam cubic-bezier katsayıları sözleşmede yok; export sendcmd örneklemesi ile WebGL interpolasyonu farklı eğri kullanırsa animasyonlar kayar. Katsayıları şemaya yaz (örn. CSS eşdeğerleri).

**Keyframe zaman ekseni:** Frontend keyframe'ler clip başlangıcına göreli; export expression'ları birleşik çıktı ekseninde `t` kullanıyor. Dönüşüm (`t_composite = timelineStartUs + kf.timeUs`) compiler'da tek noktada yapılmalı ve geçişli (xfade sonrası) akışta eksenin hâlâ timeline zamanı olduğu test edilmeli — dokümante edilmiş ama testi zorunlu kıl.

**Şema sahipliği çift yönlü tanımlanmış (çatışma):** Frontend "zod → JSON Schema → NJsonSchema ile C#"; backend "VideoEdit.Contracts → OpenAPI → frontend codegen". İkisi aynı anda kaynak olamaz. **Karar:** timeline dokümanı için kaynak `@app/timeline-schema` (zod) → C# üretimi; API DTO'ları için kaynak backend OpenAPI → TS üretimi. Bu ayrımı yazılı hale getirin.

**ID tipi:** Frontend "uuid v7", storage "ULID", backend "Guid". Pratik çözüm: UUIDv7 (Postgres/`Guid` uyumlu, zaman sıralı); storage key'lerinde de aynı değerin string hali. ULID'den vazgeçilsin.

### 1.b Proxy ↔ orijinal zaman/fps eşlemesi

**KRİTİK — Üç dokümanda üç farklı proxy reçetesi:**

| Parametre | Frontend (§4.2) | Storage (§3.3) | Backend (§5) |
|---|---|---|---|
| GOP | 30 (1 s) | **15, `-sc_threshold 0 -bf 0`** | 30, B-frame/sc_threshold ayarı YOK |
| CRF | 23 | 23 | **28** |
| CFR normalize | zorunlu (sözleşme) | `fps=30000/1001` var | **YOK — VFR sızar!** |
| Ses | — | 128k/48kHz stereo | 96k |
| Çözünürlük | 540p veya 720p | 540p | 540p |

Backend'in proxy komutu `fps` filtresi içermediği için "VFR frontend'e hiç sızmaz" sözleşmesini ihlal ediyor — frame-step ve waveform hizası VFR telefon kayıtlarında kırılır. **Tek reçete:** Storage §3.3 komutu (CFR + `-g 15 -sc_threshold 0 -bf 0` + CRF 23 + 128k/48k) normatif kabul edilsin; CI'da ffprobe ile keyframe aralığı/B-frame regresyon testi (storage tuzak #11) korunmalı.

**Filmstrip tasarımı backend'de bozuk:** `tile=1000x1 -frames:v 1` → 160 px × 1000 = **160.000 px genişlik; JPEG limiti 65.535 px** — komut uzun videoda ya patlar ya sessizce kırpar; ayrıca 1000 sn üstü videolarda kareler kaybolur. Storage'ın `tile=30x10` çoklu sprite + `manifest.json` tasarımı (frontend'in beklediği format) esas alınsın.

**Waveform üç farklı spec:** Frontend "100 ve 1000 peak/s iki seviye"; storage "audiowaveform 50 px/s"; backend "PCM + C# downsample". Tek karar: audiowaveform, 50 px/s tek seviye MVP (frontend zoom-out'ta downsample eder, derin zoom v2) — frontend beklentisi buna göre güncellensin.

**Frame-step grid'i belirsiz (frontend kendi içinde de çelişik):** §1.1 "frame-step ve snapping için proxy'nin CFR fps'i"; §3.4 kısayol tablosu "1 frame = proje fps'ine göre"; export §1 her şeyi **proje fps grid'ine** snap'liyor. Kullanıcı-scoped asset'ler farklı projelerde farklı fps'lerle kullanılacağı için proxy proje fps'ine normalize edilemez. **Karar:** tüm UI frame-step/snapping/timecode PROJE fps grid'inde (export ile aynı grid); proxy kendi kaynak-CFR'ında kalır, `precise seek` en yakın proxy frame'ini gösterir ve ±1 frame önizleme toleransı belgelenir. Golden-frame testleri bu eşlemeyi doğrular.

**HDR zinciri proxy'de eksik:** Export §6 "proxy üretiminde ve exportta aynı tonemap zinciri" şart koşuyor; storage'ın proxy pipeline'ında `zscale/tonemap` hiç yok. iPhone HLG kaynak → önizleme soluk/farklı, export başka görünür. Probe'da HDR tespiti + proxy ve export'ta özdeş tonemap zinciri storage pipeline'ına eklenmeli. Aynı şekilde rotation: proxy autorotate davranışı + probe'daki ham width/height'ın UI'a rotate-uygulanmış dönülmesi (backend tuzağı) storage'ın `assets` tablosu tanımına işlenmeli.

### 1.c Autosave / versiyonlama / undo-redo

- **Checkpoint kuralı farklı:** Frontend "≥60 s veya ≥20 entry"; backend "≥20 revision veya ≥5 dk + değişiklik". Kural yalnız SUNUCUDA yaşamalı (client checkpoint'e karışmasın); backend'in kuralı esas alınsın, frontend dokümanından çıkarılsın.
- **Concurrency mekanizması farklı:** Frontend `If-Match: revision` header; backend body `{ baseRevision }`. Birini seçin (öneri: body — sendBeacon/proxy cache tuhaflıklarından bağımsız).
- **`beforeunload` + sendBeacon auth sorunu:** sendBeacon Authorization header taşıyamaz; access token 15 dk'lık JWT. Çözüm tasarlanmamış: ya `fetch(..., {keepalive:true})` + header, ya kısa ömürlü save-token'lı özel endpoint. Boşluk.
- **Export'un versiyon bağlama mekanizması iki farklı tasarım:** Backend `Job.RevisionNumber` (referans, "yoksa snapshot al"); export dokümanı `export_jobs.timeline_snapshot jsonb` (gömülü kopya). Gömülü snapshot daha sağlam (revision cleanup/inceltme job'ı referansı silebilir!) — export'un modeli kazansın; backend `Job` tablosu buna göre düzeltilsin. Endpoint adı da ayrışıyor: `POST .../export` vs `POST .../exports`, `revisionNumber` vs `timelineVersionId` — tekleştirin.
- **Restore ↔ client undo etkileşimi tanımsız:** Sunucuda restore sonrası açık client'ın docStore'u ve undo yığını ne olur? Kural ekleyin: restore yanıtı yeni revision döner, client dokümanı yeniden yükler ve undo history'yi temizler.

### 1.d Asset durum makinesi ve altyapı ayrışmaları

- **Durumlar uyumlu** (uploading→uploaded→processing→ready|failed) — tek sapma storage'ın "expired" durumu; enum'a eklenmesin, `failed` + `error='expired'` olarak map'lensin.
- **KRİTİK — Asset scoping çelişkisi:** Storage: kullanıcı-scoped + `project_assets` many-to-many + `u/{user}/a/{asset}/...` key düzeni. Backend: `Asset.ProjectId` (proje-scoped) + `assets/{id}/...` key. Bu; kota, GC, media-urls endpoint'i ve "aynı videoyu iki projede kullan" hedefini etkiler. **Karar: storage'ın kullanıcı-scoped modeli** (ürün gereksinimi "projeyi tekrar açıp düzenleme + re-upload istmeme" ile uyumlu); backend entity'si ve key düzeni ona uydurulsun. Türevler için `asset_derivatives` tablosu yerine backend'in düz kolonları MVP'de yeterli — ama tek modelde birleştirin.
- **Kuyruk üç farklı seçim:** Storage "Redis Streams veya Hangfire", backend "Hangfire (karar)", export "Hangfire'ı reddedip Postgres SKIP LOCKED + heartbeat". İki ayrı kuyruk altyapısı işletmek MVP'de israf. **Karar önerisi:** tek mekanizma — Hangfire (transcode + export aynı sunucu, ayrı queue adları: `transcode`, `export`) + export dokümanındaki heartbeat/reaper fikirleri Hangfire üstüne uygulanır (`InvisibilityTimeout` + watchdog). SKIP LOCKED tasarımı temiz ama iki sistemin senkron tutulması maliyetli; seçimi yazıya dökün, iki doküman da güncellensin.
- **İşleme pipeline şekli:** Backend "tek sıralı ProcessAssetJob"; storage "probe sonrası paralel iş tipleri". MVP: tek sıralı job (backend) — storage dokümanı uysun.
- **Upload endpoint yüzeyi farklı:** Storage'da `upload/status` (ListParts tabanlı resume) ve `abort` var; backend'de yok. Storage'ın yüzeyi esas; backend endpoint isimleri (`parts/presign` vs `upload/parts`) tekleştirilsin. Complete'te HeadObject boyut doğrulaması backend tasarımına da yazılmalı.
- **Presigned GET stratejisi:** Frontend/storage "proje açılışında toplu `media-urls`, 12 saat, arka planda yenileme"; backend "asset başına GET, 1 saat". Toplu + 12h kazansın; backend'e `GET /api/projects/{id}/media-urls` eklensin.
- **Worker disk modeli:** Backend `/scratch` + iş sonu temizlik; export `/data/cache` LRU (100 GB) + rezervasyon formülü. Tekleştirin: LRU cache + rezervasyon her iki worker tipinde (proxy worker da aynı asset'i export worker'la paylaşabilsin — aynı volume/host ise büyük kazanç).
- **Metin render zinciri çelişkisi:** Frontend "metin client'ta Canvas2D'ye rasterize edilir"; export "layout + rasterizasyon sunucuda SkiaSharp'ta, frontend bbox'ı kullanır, aynı bitmap = garanti parity". İkisi birden olmaz. Pragmatik karar: canlı düzenleme sırasında client Canvas raster (anlık UX), kaydetme/idle'da sunucudan SkiaSharp raster + bbox çekilip önizleme texture'ı onunla değiştirilir; export daima SkiaSharp çıktısını kullanır. Bu hibrit akış iki dokümana da yazılmalı; satır kırma farkları için SkiaSharp bbox'ı bağlayıcı kabul edilsin.

## 2. EKSİKLER

**Güvenlik / kötüye kullanım**
- **Dosya tipi doğrulama yok:** Client'ın beyan ettiği `contentType`'a güveniliyor. Gerekli: uzantı/container whitelist, complete sonrası ffprobe "gate" (parse edilemeyen → `failed`), R2 objesine sunucu-belirlenmiş `Content-Type` + `Content-Disposition` yazımı (presigned GET ile HTML/SVG servis edilip XSS olmasın).
- **Kota yok:** Kullanıcı başına toplam depolama, max dosya boyutu, eşzamanlı upload/iş limiti, max timeline süresi/track sayısı, kullanıcı başına eşzamanlı export sayısı (tek kuyrukta bir kullanıcının 10 export'u herkesi aç bırakır — per-user concurrency cap + FIFO adaleti). Hiçbir tasarımda yok; maliyet analizi (8.4 TB) uygulanamaz varsayım üstünde duruyor.
- **Rate limiting** presign/init endpoint'lerinde (Class A operasyon ve DB satırı şişirme saldırısı) — backend'de "Faz 4" denmiş, upload uçları için M1'e çekilmeli.
- **R2 credential scoping:** API ve worker aynı full-access anahtarı paylaşıyor; bucket-scoped ayrı token'lar kullanılmalı.
- ffmpeg/ffprobe kaynak sınırları: zaman aşımı var ama `-xerror`, decode boyut limiti (100000×100000 görsel bombası), `-max_muxing_queue_size` gibi korumalar tanımsız.

**Hata senaryoları**
- **Transcode `failed` UX'i:** Reaper var ama kullanıcıya bildirim, "yeniden dene" butonu, hangi hataların kullanıcıya nasıl anlatılacağı (bozuk dosya vs sistem hatası) tasarlanmamış.
- **Asset ↔ timeline dangling referansı:** Kullanıcı asset'i silerse timeline'daki `assetId` ne olur? Frontend "medya çevrimdışı" placeholder'ı, export'ta anlamlı hata, silmeden önce "N projede kullanılıyor" uyarısı — hiçbiri yok. Kullanıcı-scoped asset + many-to-many seçilince bu zorunlu tasarım.
- **Audio-only ve image asset pipeline'ı:** `AssetKind: Audio|Image` var ama türev matrisi tanımsız (audio: waveform + AAC proxy? image: sadece thumbnail? `sourceIn/Out` image'da ne?). Compiler'ın image input'u (`-loop 1`) örnekte var ama ingest tarafı boş.
- **Export çıktı doğrulaması:** Upload öncesi çıktıya ffprobe (süre ≈ beklenen, stream sayısı) — yoksa bozuk mp4 "completed" olur.

**Yaşam döngüsü / hijyen**
- **Proje silme → asset GC zinciri eksik:** Soft delete var; hard delete job'ı (grace period sonrası R2 prefix temizliği), referans sayacı (many-to-many'de asset hangi projelerden düşünce silinebilir?), "yetim obje taraması"nın nasıl çalışacağı (R2 list vs DB diff) tanımsız. Storage F5'te bir cümle; gerçek tasarım gerekiyor.
- **Postgres yedekleme + R2 felaket senaryosu** (bucket versioning / silme koruması) hiçbir dokümanda yok. Timeline'lar tek Postgres'te — günlük pg_dump + offsite en azından.

**Font**
- **Font lisans/dağıtım politikası boş:** "Google Fonts self-host" denmiş ama OFL-only küratörlü liste, custom font yüklemede lisans sorumluluğunun ToS'a yazılması, ve en önemlisi **font kimliği sözleşmesi** eksik: `TextClip.fontFamily` serbest string — SkiaSharp hangi TTF'i yükleyecek? Gerekli: font manifest'i (`fontId → dosya, weight'ler`), şemada `fontFamily` yerine `fontId`, aynı dosyanın `@font-face` + SkiaSharp'a gitmesi, font sürüm pinleme (font güncellenirse eski projelerin layout'u değişmesin).

**Tarayıcı / platform**
- **Mobil davranış tanımsız:** Pointer-event DnD, klavye kısayolları, `<video>` pool autoplay kısıtları, bellek — hepsi masaüstü varsayımı. MVP kararı yazılsın: mobil tarayıcıda "masaüstü Chromium kullanın" kapısı (viewport tespiti), en azından proje listesinin mobilde çalışması.
- **COEP `require-corp` + R2:** Frontend tuzak listesinde var ama çözüm ucu açık; presigned yanıtlarda CORP header'ı kontrol edilemiyorsa `crossorigin="anonymous"` + CORS'un yeterliliği M0 smoke testine bağlanmış — bu testin "geçmezse COEP'i v2'ye ertele (`credentialless` dene)" fallback kararı da şimdiden yazılmalı.

**Diğer**
- Multi-tab aynı proje: 409 diyaloğu var ama "hangi sekme kazanır" UX'i ve SignalR ile pasif sekmeyi güncelleme yok (MVP'de kabul edilebilir — ama bilinçli karar olarak yazılsın).
- Animasyonlu WebP sticker (frontend şemada var) → ffmpeg animasyonlu WebP decode desteği kırılgan; MVP'de statik PNG/WebP'ye daraltın.
- İzleme/metrik: storage F5'te iki metrik; sistem genelinde (kuyruk derinliği, export p95, worker disk, 5xx) minimal Prometheus/Grafana veya en azından yapılandırılmış log kararı yok.

## 3. EN RİSKLİ 3 ALAN

**R1 — Preview ↔ Export parity (ürünün güven sözleşmesi).** Kaynaklar: transform→piksel formülü tanımsız, efekt param eşlemesi eksik, easing katsayıları belirsiz, metin çift rasterizasyon, HDR/renk zinciri proxy'de yok, frame grid belirsizliği. *Azaltma:* (1) M0'da "Rendering Semantics" normatif dokümanı — transform matrisi, easing katsayıları, efekt formülleri, geçiş semantiği tek yerde; (2) golden-frame CI'ı export'un İLK milestone'ıyla birlikte kur (SSIM/ΔE eşikli), her compiler PR'ında koşsun; (3) renk için erken LUT-bake yoluna geç (eq formül-eşitleme sürünmesin).

**R2 — FilterGraph Compiler + ffmpeg gerçek dünya girdileri.** xfade normalize şartları, sendcmd/expression kırılganlığı, HDR/VFR/rotate/moov-sonda telefon kayıtları, 10+ katmanda bellek. *Azaltma:* IR + deterministik snapshot testleri; "pis dosya korpusu" (iPhone HLG, WhatsApp re-encode, OBS VFR, dikey video, döndürülmüş MOV) ile entegrasyon testi M1'den itibaren; timeline karmaşıklık tavanları (max track/clip); gerekirse fallback stratejisi: track başına ara dosya (per-track prerender) + basit final birleştirme — compiler tek dev graph'ta boğulursa kaçış yolu.

**R3 — v1 oynatma motoru (`<video>` pool) senkron ve performansı.** A/V drift, seek toleransı, 3+ katman decode, autoplay/suspend davranışları; kullanıcının ilk 5 dakikadaki "editör hissi" buna bağlı. *Azaltma:* proxy GOP disiplini otomatik testle korunur (ffprobe keyframe aralığı CI'ı); pool boyutu `hardwareConcurrency`'ye bağlı; ±1 frame önizleme toleransı ürün kararı olarak belgelenir; WebCodecs v2 yalnız "duraklıyken precise frame" için erken (M5 civarı) feature flag'le devreye alınır — tam oynatma sonra. Kompozitörün ortaklığı (v1/v2) bu riskin sigortası; o karar doğru, korunmalı.

*(Onur listesi: tek-VPS operasyonel dayanıklılık — disk dolması, kuyruk/worker split-brain — R2/R3'ün azaltmalarındaki rezervasyon+reaper+idempotency ile yönetilir; M6'da sertleştirilir.)*

## 4. BİRLEŞİK MVP YOL HARİTASI

Sıralama ilkesi: **export hattı öne çekildi** (orijinal planlarda backend Faz 3-4'teyken frontend M3'te efekt yapıyordu — parity riski en geç değil en erken export'la ölçülür). Her milestone sonunda gösterilebilir dilim var.

- **M0 — Sözleşme + iskelet (1-2 hafta).** `timeline-schema` paketi (zod→JSON Schema→C#; geçiş semantiği, transform formülü, easing katsayıları, efekt eşleme tablosu, tek proxy reçetesi, asset scoping=kullanıcı, ID=UUIDv7, kuyruk=Hangfire kararları YAZILI); solution + docker-compose + Caddy + Postgres/Redis; Identity/JWT; proje CRUD; COEP+R2 CORS smoke testi. *Demo: login olup boş proje açılıyor; şema CI'da iki dilde derleniyor.*
- **M1 — Upload → işleme → kütüphane (2-3 hafta).** Uppy + multipart (64 MiB, ETag, re-presign, abort), complete + HeadObject doğrulama + ffprobe gate; tek sıralı ProcessAssetJob (probe → CFR proxy `-g 15` → filmstrip sprite+manifest → waveform → poster); durum polling; medya kütüphanesi UI. Upload uçlarında rate limit + max boyut. *Demo: 2 GB telefon videosu yükleniyor, <6 dk'da filmstrip'li "ready".*
- **M2 — Timeline + player v1 + autosave (3 hafta).** Canvas timeline (ruler, zoom/pan, playhead), move/trim/split/delete + snapping, patch-tabanlı undo/redo, transaction/coalescing; WebGL kompozitör + `<video>` pool tek video + tek audio track, frame-step (proje fps grid'i), Web Audio volume/fade; autosave (`PUT /timeline`, baseRevision, 409 diyaloğu) + sunucu-taraflı snapshot kuralı. *Demo: kes-taşı-böl, scrub, sayfayı yenile → kaldığın yerden devam.*
- **M3 — Export v1: uçtan uca ürün (2-3 hafta).** Compiler v1: tek video track trim/concat (geçişsiz) + ses miksi (`amix normalize=0`, volume/afade) + 1080p profil; job snapshot gömme, Hangfire + progress (SignalR + polling), cancel, indirme (presigned 24h); **golden-frame CI altyapısı burada kurulur.** *Demo: yükle → kes → export → mp4 indir. Ürün ilk kez uçtan uca.*
- **M4 — Çok katman + overlay + geçişler (3 hafta).** Preview VE export birlikte: çoklu track overlay kompozisyonu, transform gizmo'ları, xfade/acrossfade (handle invaryantlı yeni geçiş sözleşmesi), text/shape/sticker (SkiaSharp sunucu raster + client canlı raster hibriti, font manifest'i), detach audio. Pis-dosya korpusu testleri. *Demo: PiP + yazılı + müzikli video geçişlerle export ediliyor, preview ile karşılaştırma testi yeşil.*
- **M5 — Keyframe + hız + renk (2-3 hafta).** Keyframe editörü + easing; compiler expression/sendcmd üretimi; speed (`setpts`/`atempo` zinciri); colorAdjust (eq eşlemesi veya doğrudan LUT yolu) + LUT; opacity fade/sendcmd; golden testler animasyonlu senaryolarla genişler. WebCodecs precise-seek feature flag (yalnız duraklı frame). *Demo: keyframe'li animasyon + renk düzeltme preview'de ve export'ta birebir.*
- **M6 — Dayanıklılık + hijyen (2 hafta).** Upload resume (IndexedDB + FileSystemFileHandle), reaper'lar, LRU disk cache + rezervasyon, retry sınıflandırması, proje/asset silme + GC + dangling-asset UX'i, kotalar, versiyon geçmişi UI + restore, metrikler, Postgres yedekleme, mobil kapısı. *Demo: tarayıcı kapat-aç upload sürüyor; asset silme "2 projede kullanılıyor" uyarısı veriyor; kota dolunca anlamlı hata.*
- **M7 — Sertleştirme + v2 (sürekli).** WebCodecs tam oynatma, HDR tonemap zinciri (proxy+export özdeş), 4K/H.265 profilleri, Worker proxy servis katmanı (CDN cache), performans, e-posta doğrulama.

**Toplam kaba tahmin:** M0–M3 ≈ 9-11 hafta (ilk satılabilir dilim), M4–M6 ≈ +7-9 hafta. Orijinal dört planın toplam iyimserliğine göre bu sıralama, en pahalı belirsizlikleri (parity, compiler, pipeline) ilk yarıya çeker.