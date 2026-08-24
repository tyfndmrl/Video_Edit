# Performans Turu Raporu — Tam Sistem

Tarih: 21 Ağustos 2026 · Çalışma ağacı: `e6f93a5` + 14. tur geliştirme dalgası (commit edilmemiş) ·
Tur türü: ÖLÇÜM (ürün kodu değiştirilmedi; tüm ölçüm betikleri scratchpad `perf20/` altında)

Bu rapordaki her sayı bu turda, bu makinede, aşağıda tanımlı yöntemlerle bizzat üretildi.
Isınma + en az 3 tekrar kuralı uygulandı; dağılım verilen yerlerde p50/p95 raporlandı
(n=3 olan export koşumlarında p50 + min/max verildi, p95 üç örnekle anlamlı değildir).

---

## 1. Ölçüm ortamı

| Bileşen | Değer |
|---|---|
| CPU | Intel Core i9-10850K — 10 çekirdek / 20 iş parçacığı, 3.60 GHz |
| RAM | 32 GB |
| Diskler | Repo `D:` = Samsung 860 EVO 250 GB (SATA SSD); OS + scratchpad + Docker `C:` = Samsung 980 PRO 1 TB (NVMe) |
| OS | Windows 11 Pro 26200 |
| Docker Desktop | 28.3.2 (WSL2) — postgres:17.10, redis:7, minio (tek düğüm, "R2" yerine) |
| Backend | .NET 10.0.302 — API + Worker bu tur için **Release** yayınlandı (`api-run20`/`worker-run20`) |
| Frontend | Vite 7 DEV sunucusu :5173 — React 19 **dev modu**, DEV doküman kapısı AÇIK |
| Tarayıcı | Microsoft Edge 151 (Chromium 151), **başlı (headed)**, 165 Hz ekran (ölçülen kare kadansı 6.06 ms) |
| ffmpeg | 8.0 (gyan full build) — worker'ın kullandığı PATH ikilisi ile aynı |

**Tazelik kanıtı (ortam kuralı):** Release yayın sonrası koşan API sürecinin (PID 586532) ve
Worker sürecinin (PID 586548) modül listesi okundu; `api-run20\VideoEdit.Api.dll`,
`api-run20\VideoEdit.Media.dll`, `worker-run20\VideoEdit.Worker.dll`, `worker-run20\VideoEdit.Media.dll`
dosyalarının bizzat yüklü olduğu görüldü. Aynı dosyalarda çift-hizalamalı UTF-16 iğne taraması:
`outside [0, ` PRESENT, `apad=whole_dur=` PRESENT (freshness13 yöntemi). `bin\Debug` süreci yok,
ölçüm başında/sonunda kaçak ffmpeg yok.

**Yerel ortam uyarısı:** Her şey tek makinede. API gecikmeleri gerçek ağ RTT'si içermez;
"R2" lokal MinIO'dur; upload/download bant genişliğini NVMe + Docker/WSL2 sanal diski belirler.
Gerçek ağ (R2, WAN) davranışı bu turda KAPSAM DIŞI.

**Vite dev modu uyarısı:** Editör ölçümleri dev sunucusunda yapıldı (projenin bağlayıcı test
ortamı budur). React dev modu + her mutasyonda koşan DEV doküman kapısı prod build'de yoktur;
kapının izole maliyeti ayrıca ölçüldü (§4.3) — okur, dev sayılarından bu payı düşebilir.
Prod build editör ölçümü KAPSAM DIŞI ilan edildi.

**Tarayıcı notu:** ms-playwright Chromium'u bu ortamda başlı modda spawn edilemedi; aynı motor
ailesinden Edge 151 kullanıldı. Headless mod ilk denemede rAF'ı ~12 Hz'e kıstığı ölçüldüğü için
(idle p50 83.3 ms, 16.7'nin katlarına nicelenmiş — ölçüm artefaktı) boyama ölçümlerinde
KULLANILMADI; rapordaki tüm editör sayıları başlı pencerede, gerçek vsync ile alındı.
Etkileşimler gerçek CDP fare/klavye girdisidir; her senaryoda etkinin gerçekleştiği store
üzerinden doğrulandı (pan'da scrollUs, zoom'da pxPerUs değişimi, marquee'de seçim sayısı = 200,
undo'da işaretleyici sayısının sıfıra dönmesi).

## 2. Yavaşlık eşikleri (gerekçeli)

| Eşik | Değer | Gerekçe |
|---|---|---|
| Kare süresi | > 33.3 ms | 30 fps algı tabanı; 165 Hz ekranda ideal kare 6.06 ms, 33 ms üstü gözle görülür takılma |
| Etkileşim yanıtı | > 100 ms | RAIL modeli: "anında" algısının sınırı |
| POST/PUT (senkron yol) | > 500 ms | Kaydet/istek diyaloğunun "dondu" hissi; senkron 422 kapıları bu bütçenin içinde kalmalı |
| Medya işleme / export | < 1x gerçek zaman | Bekleme süresi içerik süresini aşarsa kullanıcı bunu doğrudan hisseder |
| Arka plan kaydetme | kullanıcıyı bloklamaz | Autosave için eşik yok; gövde boyutu/sıklığı ağ maliyeti olarak raporlanır |

---

## 3. Editör ölçümleri

Projeler: gerçek yüklenmiş ve işlenmiş (ready) bir 10 sn'lik video asset'ini referanslayan
50 / 200 / 500 klipli belgeler (3 video track; her 5. klipte opacity+x keyframe'leri, her 7.
klipte colorAdjust; tüm kenarlar 30 fps karesine oturur).

### 3.1 Proje açılışı (soğuk)

Yeni tarayıcı bağlamı (boş HTTP önbelleği), refresh cookie'siyle `?project=` derin bağlantısı;
süre = navigasyon başlangıcı → oturum 'ready' + ilk çizim (çift rAF). İlk satır tarayıcı soğuk
başlatmayı da içerir. (Vite dönüşüm önbelleği sunucu tarafında sıcaktı; sunucu-soğuk açılış ölçülmedi.)

| Proje | İlk açılış (ms) | Sonraki 3 açılış (ms) |
|---|---|---|
| 50 klip | 603 | 430, 408, 413 |
| 200 klip | 623 | 418, 423, 416 |
| 500 klip | 640 | 438, 413, 423 |

500 klipte bile ~0.44 s — eşiklerin çok altında. Doküman GET'i (246 KB) ~7-11 ms, media-urls ~8 ms,
refresh ~11-13 ms; süre ağırlıkla modül yükleme + ilk render.

### 3.2 Timeline boyaması ve akıcılık (kare süreleri)

rAF delta ölçümü, faz başına 3 tekrar; pan fazından önce Ctrl+wheel ile 12 adım zoom-in yapılır
ki pan GERÇEK iş yapsın (scrollUs değişimi her tekrar doğrulandı; 60 wheel adımı/faz).

| Proje | Faz | n (kare) | p50 ms | p95 ms | max ms | >33.3 ms |
|---|---|---|---|---|---|---|
| 50 | idle | 595 | 6.1 | 6.1 | 6.2 | 0 |
| 50 | pan (Shift+wheel) | 934 | 6.1 | 6.1 | 6.3 | 0 |
| 50 | zoom (Ctrl+wheel) | 777 | 6.1 | 6.1 | 24.1 | 0 |
| 200 | idle | 592 | 6.1 | 6.1 | 30.3 | 0 |
| 200 | pan | 933 | 6.1 | 6.1 | 6.2 | 0 |
| 200 | zoom | 784 | 6.1 | 6.1 | 24.2 | 0 |
| 500 | idle | 592 | 6.1 | 6.1 | 18.2 | 0 |
| 500 | pan | 948 | 6.1 | 6.1 | 6.2 | 0 |
| 500 | zoom | 787 | 6.1 | 6.1 | 54.5 | 1 (%0.1) |

**Sonuç: timeline canvas'ı 500 klipte dahi 165 Hz'i tutturuyor** (p50 = p95 = 6.1 ms).
33 ms eşiğini aşan tek kare, 500 klip zoom fazında 2 348 karede 1 kez görüldü. Yavaş kısım DEĞİL.

### 3.3 200 adımlık undo yığını + JS heap (500 klipli belgede)

200 gerçek işlem (playhead ilerletme + 'm' ile işaretleyici ekleme; her biri tek geçmiş girdisi)
ve ardından 200 × Ctrl+Z. Süreler sayfa içinde keydown → çift rAF (boyama dahil); heap,
`--expose-gc` ile zorlanmış GC sonrası `performance.memory`.

| İşlem | n | p50 ms | p95 ms | max ms |
|---|---|---|---|---|
| İşaretleyici ekle (mutasyon + DEV kapısı + boyama) | 200 | 13.0 | 21.1 | 41.5 |
| Playhead adımı (mutasyonsuz taban çizgisi) | 200 | 13.9 | 21.9 | 44.0 |
| Undo (Ctrl+Z) | 200 | 13.0 | 30.9 | 35.1 |

Mutasyonlu işlemin p50'si mutasyonsuz taban çizgisiyle aynı (13 ms ≈ 165 Hz'te çift rAF tabanı):
işlem maliyeti iki kare bütçesinin içinde eriyor. Doğrulama: 200 girdi kuruldu (history=200,
işaretleyici=200), 200 undo sonrası işaretleyici=0, cursor=0.

Heap (GC'li): taban 15.6 MB → 200 işlem sonrası 18.5 MB (+2.9 MB; 200 girdilik patch geçmişi)
→ 200 undo sonrası 18.7 MB. Beklenen mertebede; yavaş/şişkin kısım değil.

### 3.4 Marquee seçim (200 klip)

Gerçek fare sürüklemesi (30 ara hareket), 3 tekrar; her tekrar tam 200 klip seçti.

- Sürükleme sırasında kare: n=542, p50 6.1 ms, p95 6.2 ms, max 42.3 ms; >33 ms yalnız 1 kare.
- Yavaş kısım değil.

### 3.5 Inspector açılışı (500 klipli belge)

Klibe gerçek tıklama → `clip-inspector` panelinin dolu boyanması (pointerdown → çift rAF);
5 farklı klip × 3 tekrar.

- n=15, p50 27.3 ms, p95 40.9 ms, max 63.9 ms (ilk açılış). 100 ms eşiğinin altında.

---

## 4. Belge boyutu, kaydetme ve DEV kapısı

### 4.1 PUT /timeline — gövde boyutu ve süresi (500 klip + keyframe'ler)

- Gövde: **240 KB** (245 962 bayt; `{baseRevision, timeline}`); proje detay GET yanıtı 246 KB.
- Doğrudan API'ye (Vite proxy'siz), aynı belge arka arkaya, n=15: **p50 59.1 ms, p95 70.9 ms**
  (min 14.5 — dağılım iki tepeli: anlık fark, snapshot politikasının kimi PUT'larda
  ProjectRevisions'a 240 KB'lık ikinci bir jsonb yazması).
- Editörden gerçek yol (Vite proxy + tarayıcı): ilk kayıt 115 ms, sonrakiler 22 / 13 ms.
- 500 eşiğinin çok altında; boyut klip sayısıyla doğrusal (~0.5 KB/klip).

### 4.2 Autosave zinciri (canlı, 500 klipli belgede)

Kod sözleşmesi debounce 2 000 ms / maxWait 15 000 ms / retry 5 000 ms; canlı ölçüm
(gerçek tuş → ağda PUT görülene kadar): **2 015-2 019 ms**, tek kuyruk, PUT üstteki değerlerle.
Zincir tasarlandığı gibi çalışıyor; kullanıcıyı bloklamıyor.

### 4.3 validateTimelineDoc + exportFrameGridIssues (DEV kapısının maliyeti)

Editörün kullandığı Vite dönüşümüyle, canlı belge üzerinde, tarayıcı içinde (5 ısınma + 30 tekrar):

| Klip | validate p50 | frame-grid p50 | Toplam p50 | Toplam p95 |
|---|---|---|---|---|
| 50 | 0.37 ms | 0.010 ms | 0.38 ms | 1.00 ms |
| 200 | 1.26 ms | 0.030 ms | 1.29 ms | 1.91 ms |
| 500 | 2.87 ms | 0.050 ms | **3.10 ms** | 3.91 ms |

Ölçek ~doğrusal. **500 klipte mutasyon başına ~3 ms** — 165 Hz'te yarım kare, 60 Hz'te
kare bütçesinin ~%19'u. Dev-only olduğu ve §3.3'te uçtan uca işlem süresini taban çizgisinden
ayırmadığı ölçüldüğü için bugünkü haliyle kabul edilebilir; 1 000+ klipte dikkat (bkz. §9).

---

## 5. Upload + işleme (aşama aşama)

Yöntem: gerçek dosyalar ffmpeg ile üretildi; upload Node istemcisiyle sunucunun gerçek
sözleşmesi üzerinden (init → parts/presign → MinIO'ya part PUT → complete); işleme aşamaları
Jobs tablosundan 150 ms aralıkla örneklendi (saat sapması ölçülüp düzeltildi: 63-75 ms).
Tarayıcıdaki uploadManager farkı ölçülmedi (KAPSAM DIŞI) — sunucu yolu birebir aynı.

### 5.1 ~100 MB (93.8 MB, 100 sn 1080p30 H.264 + AAC), 3 tekrar

| Tekrar | part PUT | MB/s | kuyruk | download | probe | proxy | filmstrip | waveform | türev upload | complete→ready |
|---|---|---|---|---|---|---|---|---|---|---|
| r0 | 0.7 s | 131 | 0.25 s | 0.20 s | 1.68 s | 3.20 s | 1.10 s | 0.18 s | 0.54 s | **7.3 s** |
| r1 | 0.6 s | 155 | 0.17 s | 0.19 s | 0.78 s | 3.35 s | 0.88 s | 0.18 s | 0.36 s | **9.7 s** |
| r2 | 0.5 s | 197 | 0.18 s | ~0* | 0.77 s | 3.18 s | 1.11 s | 0.18 s | 0.35 s | **9.7 s** |

\* Örnekleyici bağlanmadan bitti (indirme < ~0.5 s). Aşama toplamı ile complete→ready farkı,
Hangfire teslim gecikmesi + durum yazma turlarıdır.

Baskın aşama: **proxy** (~3.2 s; 100 sn içerik → **~31x gerçek zaman**, 540p veryfast CRF23).

### 5.2 ~1.5 GB (1 426.5 MB, 600 sn 1080p60 ~20 Mb/s), 3 tekrar

| Tekrar | part PUT | MB/s | kuyruk | download | probe | proxy | filmstrip | waveform | türev upload | complete→ready |
|---|---|---|---|---|---|---|---|---|---|---|
| r0 | 99.3 s | 14.4 | 0.14 s | 3.40 s | 0.91 s | 38.0 s | 12.9 s | 3.56 s | 1.17 s | **64.4 s** |
| r1 | 39.1 s | 36.5 | 0.13 s | 2.44 s | 0.80 s | 39.8 s | 14.8 s | 1.60 s | 1.26 s | **62.8 s** |
| r2 | 5.3 s | 266.7 | 0.16 s | 1.99 s | 0.82 s | 39.8 s | 12.4 s | 0.36 s | 1.12 s | **59.8 s** |

- Baskın aşama yine **proxy**: 600 sn 60 fps kaynak → 38-40 s = **~15.1x gerçek zaman**.
  İkinci pay **filmstrip** (12.4-14.8 s, işleme süresinin ~%21'i).
- **Upload bant genişliği anomalisi:** aynı kod, aynı dosya; 14.4 → 36.5 → 266.7 MB/s.
  Ayrıştırma probu (9 × 64 MB part; keep-alive havuzu / Connection: close / tekrar havuz):
  her modda **280-370 MB/s** — istemci protokolü değil. Aynı dakikalarda worker günlüğünde
  Hangfire heartbeat'inin Npgsql bağlantı açma zaman aşımı uyarıları görüldü: çok-GB ardışık
  ingest, paylaşılan Docker/WSL2 sanal diskini doyurup aynı VM'deki Postgres'i de yavaşlatıyor.
  Dev-altyapı bulgusudur (bkz. §9, madde 3); ilk denemede bir part PUT'unun ECONNRESET ile
  düşmesi de aynı pencerede yaşandı.
- İlk deneme hatası dışında hiçbir tekrar başarısız olmadı; kuyruk beklemesi hep < 0.3 s.

---

## 6. Export (60 sn'lik bileşim, profil başına)

Bileşim: 2 video klip (gerçek 70 sn 1080p kaynaktan) + 1 sn crossfade + metin overlay +
şekil overlay + colorAdjust (klip A) + gerçek .cube LUT (klip B). Karşılaştırma: tek katman,
tek klip, efektsiz düz kesim. Süre = sunucu duvar saati (StartedAt→CompletedAt), 3'er tekrar
(+1 ısınma, LRU orijinal önbelleğini doldurur; ısınma 89.6 s idi, dahil edilmedi).

| Yapılandırma | n | Duvar p50 | min-max | x-gerçek-zaman | Çıktı boyutu (r0) |
|---|---|---|---|---|---|
| Bileşim 720p | 3 | 89.0 s | 88.0-89.7 | **0.67x** | - |
| Bileşim 1080p | 3 | 90.7 s | 90.5-92.2 | **0.66x** | 57.3 MB |
| Bileşim 2160p | 3 | 103.6 s | 102.9-103.8 | **0.58x** | 115.5 MB |
| Düz kesim 1080p | 3 | 6.4 s | 6.4-6.6 | **9.38x** | - |

Aşama payları (tipik bileşim koşumu): render 86-101 s (%95+), compile 0.4-2.1 s,
overlay rasterleştirme 0.4 s, çıktı probe + upload ~1 s. Download ısınma sonrası ~0
(orijinaller LRU cache'te).

**Ana bulgu:** Bileşimli export HER profilde gerçek zamandan yavaş (0.58-0.67x) ve süre
çıktı çözünürlüğüne neredeyse duyarsız (720p ≈ 1080p!). Düz kesim 9.4x olduğuna göre maliyet
kodlayıcıda değil, **filtre grafiğinde** (compile edilen grafik: giriş başına normalize zinciri
scale/pad/fps/format + xfade + lut3d(trilinear) + 3 × overlay; tuval 1920x1080'de birleştirme,
2160p'de sona tek scale). 2160p koşumunda ffmpeg ~12.3/20 mantıksal çekirdek kullandı —
grafik tam paralelleşemiyor. Öneriler §9 madde 1'de.

**Validate / senkron 422 kapıları (500 klipli belgede):**

| Yol | n | p50 | p95 |
|---|---|---|---|
| POST /exports → 422 (son klip ızgara dışı; tam gezinme + asset olgu defteri) | 15 | 12.6 ms | 14.0 ms |
| POST /exports → 202 (geçerli 500 klip; kapılar + Hangfire kuyruklama) | 5 | 90.8 ms | 92.0 ms |
| POST /exports → 202 (4 klipli bileşim, export koşumlarında) | 13 | 20-25 ms | - |

Senkron kapılar POST'u en kötü ~91 ms tutuyor — 500 ms eşiğinin çok altında. Yavaş kısım değil.

---

## 7. API gecikmeleri (doğrudan :5000, localhost)

5 ısınma + n ölçüm; Node undici istemcisi; gövde okuma dahil.

| Uç | n | p50 ms | p95 ms | max ms |
|---|---|---|---|---|
| GET /health | 30 | 0.5 | 1.2 | 2.0 |
| POST /api/auth/refresh (rotasyonlu zincir) | 20 | 8.3 | 8.8 | 9.9 |
| GET media-urls — 12 ready asset | 30 | **23.7** | 26.3 | 26.8 |
| GET media-urls — 1 asset | 30 | 4.3 | 5.0 | 5.7 |
| GET exports listesi — boş proje | 30 | 2.7 | 3.2 | 3.3 |
| GET exports listesi — 11 işli proje | 30 | 4.5 | 6.2 | 7.0 |
| GET proje listesi | 30 | 2.1 | 2.5 | 2.8 |
| GET proje detayı — 500 klip, 246 KB | 30 | 7.1 | 8.6 | 24.6 |
| PUT timeline — 500 klip, 240 KB | 15 | 59.1 | 70.9 | 72.3 |
| POST exports — 422 kapı reti (500 klip) | 15 | 12.6 | 14.0 | 14.6 |
| POST exports — 202 + iptal (500 klip) | 5 | 90.8 | 92.0 | 92.2 |

Hepsi eşiklerin altında. media-urls asset sayısıyla doğrusal büyüyor (~1.6-1.9 ms/asset:
sıralı presign + filmstrip'li asset başına storage'dan manifest.json GET'i) — §9 madde 4.

---

## 8. Bellek / kaynak

**Worker render sırasında (500 ms hedefli örnekleyici; tarama maliyeti nedeniyle gerçek aralık
~1.5-2.5 s; export paketinin tamamını kapsadı):**

| Metrik | Değer |
|---|---|
| Worker (dotnet) RSS | p50 140 MB, tepe 188 MB |
| ffmpeg RSS tepe | **4 908 MB** (2160p bileşim render'ı; 1080p'de ~2.5 GB gözlendi) |
| Aynı anda ffmpeg | tepe 1 (export WorkerCount=1 tasarımı doğrulandı) |
| Worker temp dizini tepe | 115.5 MB (2160p çıktı dosyası; iş sonunda silindi, kalan 0) |
| Orijinal LRU cache | 240.4 MB (tavan 20 GiB) |
| 2160p sırasında ffmpeg CPU | ~12.3 / 20 mantıksal çekirdek (4 sn örneklem) |

**Editör sekmesi 30 dk oturum (kaba heap eğilimi):** 500 klipli projede dakikada 1 gerçek
mutasyon + sürekli zoom/pan/playhead döngüsü; 20 sn'de bir ham, 5 dk'da bir GC'li örnek.

- GC'li heap: 15.95 → 16.46 → 16.52 → 16.56 → 16.58 → 16.59 → kapanışta 16.61 MB.
- Ham örnekler 16.8-17.5 MB bandında salındı. **30 dakikada +0.66 MB: sızıntı belirtisi yok.**

---

## 9. YAVAŞ KISIMLAR — sıralı liste

Sıralama: kullanıcı etkisi × yaygınlık. Her madde ölçülmüş değere dayanır.

**1. Bileşimli export gerçek zamandan yavaş — filtre grafiği maliyeti (şiddet: YÜKSEK)**
Ölçüm: 60 sn bileşim → 89-104 s duvar (0.58-0.67x) her profilde; düz kesim 6.4 s (9.38x).
Grafik, süreyi kodlayıcıdan bağımsız ~14x katlıyor; 720p ile 1080p arasında fark yok, yani
çözünürlük düşürmek kullanıcıya hız kazandırmıyor. 2160p'de ffmpeg 20 çekirdeğin ~12'sini
kullanabiliyor (grafik serileşiyor).
Öneri (artan maliyet sırasıyla): (a) `-filter_complex_threads` / filtre zinciri iş parçacığı
ayarlarını tarayıp ölçmek; (b) normalize zincirini kaynak zaten tuval boyut/fps/formatındayken
kısaltmak (scale/pad/fps no-op'ları); (c) overlay/lut'u yalnız etkin zaman aralığına
uygulamak (enable= var; segment bazlı ayrı grafiklerle kıyas ölçümü); (d) en büyük kazanç:
timeline'ı zaman dilimlerine bölüp N paralel ffmpeg + concat (dilim sınırlarını geçiş
aralıklarının dışına koyarak) — 10 çekirdekli makinede tahmini 3-5x; (a)-(c) için tahmini %20-40.
Kabul ölçütü: bu bileşim 1080p'de ≥ 2x gerçek zaman.

**2. 2160p render'da ffmpeg tepe RSS ~4.9 GB (şiddet: YÜKSEK — koşullu)**
Ölçüm: tepe 4 908 MB (32 GB makinede tek işte sorunsuz). Export eşzamanlılığı bugün 1;
worker sayısı/eşzamanlılık artarsa iki-üç 4K iş belleği bitirebilir. Disk için kabul kapısı
var (ExportDiskEstimate), bellek için yok.
Öneri: profil başına kaba bellek tahmini + işe başlamadan kabul kapısı; 4K işleri ayrı
kuyruk/tek-uçuş kuralına bağlamak. Tahmini kazanç: ölçek artışında OOM/kasma riskini sıfırlar.
**KAPATILDI (2026-08-24 yarim-is #3):** kabul kapısı eklendi — `ExportJob.EnsureMemoryAsync`
(bekle `memory-wait` / tipli `insufficient-memory`, disk kapısının deseni). Tahmin formülü
YENİ ölçüm turuna sabitli (`ExportMemoryEstimateTests`): `PeakWorkingSet64` ile 10 gerçek
render — düz kesim 461/910/2 921 MB (720p/1080p/2160p), bileşim 3 013/3 009-3 306/5 063-5 563 MB.
Not: bu rapordaki 4 908, 500 ms WorkingSet örneklemesinin ALT SINIRIYMIŞ; çekirdek takipli
gerçek tepe 2160p bileşimde 5 563 MB ölçüldü. Süre sürücü değil; sürücüler çıktı pikselleri
(kodlayıcı) + eşzamanlı görsel giriş × tuval pikselleri (filtre kuyrukları). Ayrı 4K kuyruğu
gerekmedi (WorkerCount=1 tek uçuş; eşzamanlılık artarsa kapı hazır).

**3. Çok-GB ingest paylaşılan Docker diskini doyuruyor (şiddet: ORTA — dev altyapısı)**
Ölçüm: aynı 1.43 GB dosya için part-PUT 14.4 / 36.5 / 266.7 MB/s; sağlıklı durumda prob
280-370 MB/s; aynı pencerede Postgres bağlantı açılışında zaman aşımı uyarıları (Hangfire
heartbeat) ve bir kez istemci ECONNRESET. MinIO + Postgres aynı WSL2 sanal diskinde.
Öneri: dev compose'ta MinIO volümünü ayrı fiziksel diske almak; istemci part eşzamanlılığını
sınırlı tutmak; Npgsql bağlantı açma zaman aşımını/timeout günlüğünü izlemeye almak. Prod'da
R2 + yönetilen Postgres bu kipte değil; yine de yük testini prod-benzeri diske taşımadan
20 GB kotayı dolduran senaryolar dev'de yanıltıcı ölçülür. Tahmini kazanç: dev'de öngörülebilir
ingest; CI/yük testlerinde yanlış-kırmızı riskinin kalkması.

**4. media-urls asset sayısıyla doğrusal — manifest GET + sıralı presign (şiddet: ORTA)**
Ölçüm: 1 asset 4.3 ms → 12 asset 23.7 ms (~1.6-1.9 ms/asset). Kod: asset başına sıralı
presign'lar + filmstrip'li asset başına storage'dan manifest.json okuması. 100+ assetli bir
kütüphanede çağrı ~170-200 ms'e uzar; bu uç proje açılışında ve 12 saatlik yenilemede çağrılıyor.
Öneri: manifest'i işleme sırasında Assets satırına (jsonb sütun) yazıp storage GET'ini kaldırmak;
asset başına URL üretimini `Task.WhenAll` ile paralelleştirmek. Tahmini kazanç: çağrı başına 5-10x.
**KAPATILDI (2026-08-24 yarim-is #4):** iki adımda. (1) 15. turda 8'lik eşzamanlılık kapağıyla
paralel döngü girmişti; bu turun ÖNCE ölçümü (aynı yöntem: 5 ısınma + 30 tekrar, ham API'yle
kurulan 55 assetli proje dahil) o halin ~0,56-0,61 ms/asset'e indiğini ama doğrusal kaldığını
gösterdi: 1/15/55 asset p50 = 4,24 / 12,82 / 34,72 ms. Pay ayrıştırması ölçümle: MinIO
manifest.json GET p50 1,07 ms/obje; `GetPreSignedURL` 244,9 µs/çağrı (tek iş parçacığı,
asset başına ~7 çağrı) — yani baskın pay presign İMZALAMA CPU'suydu. (2) Bu turda manifest,
işleme sırasında `Assets.FilmstripManifest` jsonb kolonuna da yazılıyor (migration
`AddAssetFilmstripManifest`; NULL = eski asset → storage-GET yolu YEDEK, backfill bilinçli yok)
ve döngü `Task.Run` ile gerçek CPU paralelliğine alındı (eşzamanlı presign güvenliği ölçümle:
16 iş parçacığı × 32 000 çağrı, sıfır istisna, örneklenen imzalı URL'ler MinIO'dan 200; verim
27,8 µs/çağrı ≈ 8,8×). SONRA (aynı projeler + yeni işlenmiş 1/15/55'lik eşleri): eski asset'ler
(yedek yol) 3,71 / 7,82 / 17,06 ms; YENİ asset'ler (DB yolu) **2,33 / 3,93 / 9,30 ms** —
55 asset'te 34,72 → 9,30 ms (**3,7×**), asset başına marjinal 0,56 → **0,13 ms** (rapor dönemi
1,6-1,9'a göre ~13×). Eğim hâlâ doğrusaldır (presign CPU'su asset başınadır) ama storage
bağımlılığı tamamen kalktı ve 100+ asset projeksiyonu ~200 ms'ten ~15 ms'e indi. Yanıt şekli
sözleşmesi ölçümle sabit: eski-55 projesinin alan/null/sprites şeması önce↔sonra BİREBİR aynı,
istemciye dokunulmadı (`assetSync` testleri + tsc yeşil).

**5. Filmstrip uzun medyada işleme payını büyütüyor (şiddet: DÜŞÜK)**
Ölçüm: 10 dk video → filmstrip 12.4-14.8 s (complete→ready'nin ~%21'i; proxy 38-40 s ile baskın
kalıyor). İşleme toplamda 15x gerçek zaman olduğundan bugün kabul edilebilir.
Öneri: uzun medyada sprite kare aralığını süreyle logaritmik seyreltmek veya filmstrip'i
orijinal yerine (önce biten) proxy'den üretmek. Tahmini kazanç: 10 dk medyada ~5-10 s.

**6. PUT /timeline tam-belge gövdesi klip sayısıyla doğrusal (şiddet: DÜŞÜK — bugün lokal)**
Ölçüm: 500 klip = 240 KB gövde; lokal p50 59 ms (snapshot yazan PUT'lar üst bandı). Lokalde
sorun değil; gerçek ağda (ör. 5 Mb/s upstream) 240 KB ≈ ~400 ms/kayıt olur ve autosave her
2 sn'de tetiklenebilir; ProjectRevisions da her snapshot'ta 240 KB büyür.
Öneri: istek gövdesine gzip (Content-Encoding) — JSON'da tahmini 5-15x küçülme; orta vadede
delta-save. R2/gerçek ağ ölçümü kapsam dışı olduğundan bu madde "ölçülmüş boyut + hesaplanmış
ağ süresi" olarak işaretlidir.

**7. DEV kapısının mutasyon başına maliyeti 500 klipte ~3.1 ms (şiddet: DÜŞÜK — yalnız dev)**
Ölçüm: §4.3. Bugün işlem sürelerinde görünmüyor (§3.3 taban çizgisiyle aynı). 1 000+ klipte
~6-8 ms'e uzayacağı (doğrusal ölçüm) ve her sürükleme commit'inde koştuğu için dev
deneyimini bozmaya başlayabilir.
Öneri: kapıyı büyük belgelerde örnekleyerek koşmak (ör. her N. commit) veya yalnız değişen
track'i doğrulayan artımlı yol. Tahmini kazanç: dev'de büyük belge sürükleme akıcılığı.

### Yavaş OLMAYANLAR (ölçülmüş ve temiz)

Timeline boyaması 500 klipte p50 6.1 ms (165 Hz'te bile tam kare); marquee 200 klip seçimi
janksız; undo/op başına 13 ms; Inspector 27 ms; soğuk açılış ≤ 0.64 s; tüm API p95'leri
< 100 ms; senkron export kapıları ≤ 92 ms; kuyruk beklemeleri < 0.3 s; proxy 15-31x gerçek
zaman; worker RSS ≤ 188 MB; editör heap'i 30 dk'da düz.

---

## 10. Kapsam dışı (bu turda sınanmadı)

- Prod build editör performansı (tüm editör sayıları Vite dev modundadır).
- R2 / gerçek ağ / WAN; tarayıcı uploadManager'ının kendi yükleme yolu (upload ölçümleri
  Node istemcisiyle sunucu sözleşmesi üzerinden yapıldı).
- Çok kullanıcılı / eşzamanlı yük; rate-limit kuyruklama davranışının kullanıcı etkisi.
- "dikey" (1080x1920) export profili; 4 saatlik medya sınırı; keyframe örnek bütçesi (60 000)
  sınırındaki belgeler; ses-ağırlıklı belgeler.
- Firefox/WebKit; mobil; farklı ekran tazeleme hızları.
- Vite sunucu-soğuk (dönüşüm önbelleksiz) ilk açılış.

## 11. Yeniden üretme

Betikler (scratchpad, repo dışı): `perf20/seed.mjs` (kullanıcı+projeler+asset'ler),
`perf20/ed-suite.mjs` (open/paint/undo/marquee/inspector/gate/autosave senaryoları),
`perf20/soak.mjs`, `perf20/api-lat.mjs`, `perf20/upload-perf.mjs` (+ Jobs tablosu örnekleyici),
`perf20/minio-probe.mjs`, `perf20/export-perf.mjs`, `perf20/res-mon.ps1`, `perf20/aggregate.py`.
Ham çıktılar `perf20/out-*.json|jsonl|log|tsv` dosyalarındadır. Ölçüm kullanıcı hesabı:
`perf20@videoedit.test` (demo hesabına dokunulmadı).
