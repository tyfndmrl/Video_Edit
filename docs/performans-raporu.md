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

### 3.6 Timeline dikey boyutlandırma — sürükleme fazı (2026-09-03, `panel-2b`)

Yeni özellik: timeline satırı tutamaktan sürüklenerek büyütülüp küçültülüyor. Her kare CSS
grid satırını (`gridTemplateRows`) değiştirdiği için canvas yığını yeniden ölçülüyor —
bu fazın kare maliyeti §3.2 YÖNTEMİYLE ölçüldü (rAF delta, ısınma + 3 tekrar, gerçek CDP
fare girdisi, etkinin gerçekleştiği DOM'dan doğrulandı: her tekrarda satır 280 → 580 px'e
çıkıp 280'e döndü). Ortam farkları: seed projesi (2 track / 2 klip; §3.2'nin 50-500 klipli
belgeleri DEĞİL), başlı Edge, 165 Hz ekran, Vite dev sunucusu, 1440×900. Jest: tutamak
300 px yukarı + 300 px aşağı, yön başına 60 kademe (~8 ms arayla).

| Faz | n (kare) | p50 ms | p95 ms | max ms | >33.3 ms |
|---|---|---|---|---|---|
| idle (taban) | 497 | 6.1 | 6.4 | 7.4 | 0 |
| resize — tekrar 1 | 555 | 6.1 | 6.3 | 6.6 | 0 |
| resize — tekrar 2 | 534 | 6.1 | 6.1 | 6.3 | 0 |
| resize — tekrar 3 | 529 | 6.1 | 6.1 | 6.2 | 0 |

**Sonuç: sürükleme fazı boşta beklemekten AYRIŞMIYOR** (p50 = 6.1 ms = 165 Hz kare süresi);
1 618 karenin hiçbiri 33.3 ms'i aşmadı. Dilim için konan bütçe (p95 ≤ 16.7 ms ve >33.3 ms
oranı ≤ %1) karşılandı, ek iyileştirme (M1) GEREKMEDİ. Maliyeti düşük tutan üç şey uygulamada
zaten var: pointermove'ların rAF ile birleştirilmesi (kare başına ≤1 store yazımı),
panellerin children-as-props ile yeniden render dışında kalması, ve `measure()`'ın
DEĞİŞMEYEN canvas boyutunu yeniden atamaması (atamak backing store'u sıfırlar).
Headless ölçüm KAPSAM DIŞI (rAF ~12 Hz'e kısılıyor — §1 tarayıcı notu).

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

### 6.1 Filtre grafiği turu — ÖNCE/SONRA yeniden ölçümü (2026-08-24)

Aynı bileşim + aynı yöntem (`perf20/export-perf.mjs`: ısınma + profil başına 3 tekrar, süre =
sunucu duvarı), HEAD `dffa484` tabanında AYNI GÜN art arda. ÖNCE = `api/worker-run27`
(değişiklik öncesi ikili; canlı süreç modül listesiyle doğrulandı), SONRA = `api/worker-run28`;
iki yayın arasındaki tek üretim-kodu farkı `ClipEffects.LutBlendFilter` (LUT karışımının yerli
`blend` moduna alınması — §9.1 kapanış notu). Ölçüm bloklarının başında/sonunda kaçak ffmpeg 0.

| Yapılandırma | ÖNCE p50 (min-max) | SONRA p50 (min-max) | x-gerçek-zaman |
|---|---|---|---|
| Bileşim 720p | 67,4 s (67,4-67,8) | **35,6 s** (35,4-36,4) | 0,89x → **1,69x** |
| Bileşim 1080p | 69,3 s (69,3-70,0) | **37,6 s** (37,4-38,1) | 0,87x → **1,60x** |
| Bileşim 2160p | 78,5 s (78,4-78,7) | **47,4 s** (47,2-47,4) | 0,76x → **1,27x** |
| Düz kesim 1080p | 5,2 s (5,2-5,3) | 5,2 s (5,1-5,2) | 11,5x → 11,5x (etkilenmedi) |

Çıktı eşdeğerliği canlıda ölçüldü: aynı comp belgesinin run27 ve run28 1080p çıktı MP4'leri
**SHA256 düzeyinde bayt-aynı** (`C18316BA…EE281B`, 60 050 957 bayt); iki koşumun worker
loglarından alınan filtergraph'ler satır satır karşılaştırıldı — **tek fark blend satırı**.
Bu eşitlik BU BELGEYE ÖZGÜDÜR, iki yazılışın genel özdeşliği değildir: dyadik olmayan
intensity'lerde tamsayı-denk (A,B) çiftleri ±1 LSB ayrışır (ölçülen zarf ve golden sınır
testi: §9.1 kapanış notu + rendering-semantics §4.2); bu belgenin içeriği o çiftlere
düşmüyor, sha256 o yüzden tutuyor.
Not: bu tablonun mutlak ÖNCE değerleri §6'nın 2026-08-21 tablosundan hızlıdır (o oturumun
ortam yükü farklıydı; LRU sıcak, tarayıcı kapalı) — bu yüzden karşılaştırma aynı gün içinde
önce/sonra çifti olarak yapıldı; 2026-08-21 satırları tarihsel bağlam olarak yerinde duruyor.

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
**KISMEN KAPATILDI (2026-08-24 filtre-grafiği turu):** önce maliyet profili çıkarıldı
(çıkar-koş-ölç bisect; canlı worker'ın GERÇEK grafiği + birebir girdiler + aynı PATH ffmpeg
8.0 ikilisi; 24 konfig × 3 tur, ham veri scratchpad `perfcost/`): 1080p tam kodlamada tek
başına **`blend=all_expr` = toplamın %46'sı** (68,7 → 37,4 s — LUT intensity<1 yolunun
per-piksel AVExpr yorumlayıcısı), tamamen örtülü metin+şekil katman zincirleri %19,
colorAdjust zinciri %10, kodlayıcı+mux %6, xfade %5, ses ~%0; süre çözünürlüğe duyarsız
çünkü 2160p aynı grafik + tek çıkış scale'i. UYGULANAN (tek net kazanç): §4.2
LUT karışımı yerli moda alındı — `blend=all_mode=normal:all_opacity=1-intensity`
(`ClipEffects.LutBlendFilter`). Eşdeğerlik İÇERİĞE BAĞLIDIR (2026-08-25'te tam (A,B)
taramasıyla sınırlandı): dyadik intensity'de bayt-aynı, dyadik olmayanda tamsayı-denk
çiftlerde tam ±1 LSB (i=0.8'de 65.536 çiftin 1201'i, i=0.6'da 208'i; zarf + golden sınır
testi rendering-semantics §4.2). Bench fixture'ında framemd5 BAYT-AYNI + çift-grafik
PSNR=inf ölçüldü (o içerik uyuşmazlık çifti üretmiyor — tekil ölçüm, genelleme değil);
canlı önce/sonra §6.1: **1080p 0,87x → 1,60x, 720p 1,69x, 2160p 1,27x**, o belgenin çıktı
MP4'leri sha256-aynı. Bu turun ölçümleriyle KAPANAN öneriler: **(a) İPTAL** —
filter_complex_threads taraması (1/2/4/8/16/auto = 450,9/235,8/126,8/76,5/69,6/68,7 s)
varsayılanın zaten optimum olduğunu, encoder `-threads`'in etkisiz olduğunu gösterdi;
**(b) İPTAL** — pad+fps no-op'ları çıkarınca framemd5 aynı ama kazanç 0,0 s; "no-op" scale'i
çıkarmak hem +1 s YAVAŞ hem BAYT-FARKLI (ffmpeg'in örtük dönüştürücüsü zincir başındaki
setparams BT.709 beyanını görmez, BT.601'e düşer — EmitSegmentChain'deki ölçüm) hem §2.5
"geometri kaynaktan bağımsız" doktrinine aykırı; **(c) İPTAL** — lut/colorAdjust zaten
trim'le kendi etkin aralığında koşuyor, overlay enable penceresini kapatmak ≤2-3 s üst
sınır verdi. Kalan yönler (backlog "Bileşimli render hızı" kaydı): örtülen-katman budaması
(bu fixtürde −13,2 s ve BAYT-AYNI ölçüldü ama karar probe boyutu+alfa bilgisi ister —
`ExportAssetSource.SourceWidth` sözleşmesi "filtergraph'ı HİÇBİR biçimde etkilemez" dediği
için baş mimar sözleşme kararı olmadan yapılamaz), colorAdjust zincir füzyonu (payı 7,2 s;
füzyon varyantı ölçülmedi, piksel LSB riski), tuval-atlama genişletmesi (−3,1 s ama bayt
değiştirir), (d) N-paralel dilimleme (tek grafik zaten ~13,5/20 çekirdek kullanıyor — tavan
sanıldığından dar). Kabul ölçütü (≥2x) BU TURDA KARŞILANMADI: 0,87x → 1,60x'e gelindi;
kalan yol yukarıdaki sözleşme kararlarına bağlı. **[2. TUR KAYDI — 2026-09-01, gelistirme-3
#3 (§12):** kalan üç yön baş mimar sözleşme kararıyla uygulandı — colorAdjust füzyonu,
taban-tuval atlaması, örtülen-katman budaması; (d) N-paralel ERTELENDİ (DECISIONS). Kabul
ölçütü GERÇEKÇİ fixtüre yeniden demirlendi (eski fixtürün overlay'leri örtülü + tuval
DIŞIYDI — §12.1); gerçekçi fixtürde 1080p **38,3 → 32,3 s** aynı-gün zincirinde (nihai
matris §12.5), örtülü (cutaway) sınıfında **41,4 → 20,1 s (2,99x)**. Ayrıntı §12.]**
Regresyon bekçileri:
`ExportCompilerSnapshotTests.TheGraphNeverInvokesThePerPixelExprInterpreter` (tüm fixture
grafiklerinde `all_expr`/`geq` yasağı) + `ExportM5GoldenTests`'in iki canlı-ffmpeg golden'ı
(yarı-karışım pikseli + LSB sınır testi). Negatif kontrol YENİDEN ölçüldü (2026-08-25,
yalnız `LutBlendFilter` gövdesi eski biçime çevrilerek, TAM paket): **6 test kırmızı** —
tüm-fixture taraması (lut-effects) + lut-effects snapshot'ı + TR-kültür literal testi +
`Lut3d_AppliesTheCubeFile…` + LSB sınır golden'ı + GateInventory kaynak-token envanteri;
geri konunca dosya MD5 birebir, paket yeşil. (Önceki "3 test kırmızı" beyanı EKSİKTİ:
`Lut3d…` golden'ını saymıyordu; kalan +2 bu turda eklenen LSB golden'ı ile token
envanterinin düşmesidir.)

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
- ~~"dikey" (1080x1920) export profili~~ (2026-09-01 §12.5'te İLK KEZ ölçüldü: 28,6 s / 2,10x);
  4 saatlik medya sınırı; keyframe örnek bütçesi (60 000) sınırındaki belgeler;
  ses-ağırlıklı belgeler.
- Firefox/WebKit; mobil; farklı ekran tazeleme hızları.
- Vite sunucu-soğuk (dönüşüm önbelleksiz) ilk açılış.

## 11. Yeniden üretme

Betikler (scratchpad, repo dışı): `perf20/seed.mjs` (kullanıcı+projeler+asset'ler),
`perf20/ed-suite.mjs` (open/paint/undo/marquee/inspector/gate/autosave senaryoları),
`perf20/soak.mjs`, `perf20/api-lat.mjs`, `perf20/upload-perf.mjs` (+ Jobs tablosu örnekleyici),
`perf20/minio-probe.mjs`, `perf20/export-perf.mjs`, `perf20/res-mon.ps1`, `perf20/aggregate.py`.
Ham çıktılar `perf20/out-*.json|jsonl|log|tsv` dosyalarındadır. Ölçüm kullanıcı hesabı:
`perf20@videoedit.test` (demo hesabına dokunulmadı).

2026-08-24 filtre-grafiği turunun (§6.1 + §9.1 kapanış notu) ham verisi de scratchpad'dedir:
`perfcost/capture/` (canlı worker'dan yakalanan gerçek grafik + ffmpeg komut satırı),
`perfcost/bench/` (24 konfig × 3 tur bisect zamanlamaları + framemd5/PSNR eşdeğerlik
kanıtları), `perfcost/verify/` (bağımsız doğrulama koşumları, önce/sonra canlı mp4'ler ve
grafik diff'i); önce/sonra canlı koşum satırları `perf20/out-export.jsonl` içindeki
"ONCE (run27" / "SONRA (run28" işaretli bloklardadır.

---

## 12. Export perf 2. turu (2026-09-01 — gelistirme-3 #3, baş mimar sözleşme kararıyla)

Üç commit: `e364f2a` (b füzyon) · `56abab7` (c tuval-atlama) · `6237fcf` (a budama).
Yöntem §6 ile aynı (POST /exports → sunucu duvar saati StartedAt→CompletedAt, 3'er koşum
p50; ölçüm hesabı `perf20@videoedit.test`); ham satırlar scratchpad `g3perf/out-bench.jsonl`,
çıkar-koş-ölç rig'i `g3perf/rig/` (yakalanan GERÇEK compReal grafiği + birebir girdiler +
aynı PATH ffmpeg 8.0, round-robin 3 tur). İkili tazeliği her fazda yüklü modül yolu +
iğne/davranışsal-iğne ile kanıtlandı; koşum pencerelerinde kaçak ffmpeg 0.

### 12.1 Fixtür dürüstlüğü ve kabul ölçütünün yeniden demirlenmesi

Eski bileşim fixtürünün İKİ kusuru KAYNAĞINDAN doğrulandı (`perf20/lib.mjs compDoc`):
metin/şekil overlay'leri (1) EN ÜST video track'inin ALTINDA — yani tamamen örtülü — ve
(2) transform'ları normalize aralığın çok dışında (y=−300 / x=500 → tuval DIŞI). Böyle bir
fixtürle budama benchmark'ı kazanmak öz-aldatma olurdu (backlog 1297-1299 kaydı doğrulandı).
ÜÇ yeni fixtür ham API'yle kuruldu (şema + frame-grid doğrulamalı): **compReal** (aynı
içerik; overlay'ler EN ÜSTTE ve tuval İÇİNDE: metin y=−0.3, şekil x=0.25/y=0.3 opacity 0.8),
**compCovered** ((a)'nın gerçek sınıfı: tam-ekran cutaway [20,40] altında metin [22,38] +
şekil [24,36] + colorAdjust'lı alternatif-açı videosu [21,39]; taban run [0,60] kapsanmaz),
**compDikey** (1080×1920, compReal içeriği). **≥2x kabul ölçütü compReal-1080p'ye
demirlendi** — bu bir kapsam kayması değil ölçüt DÜZELTMESİDİR (review-gate kural 4 gereği
açık beyan): eski fixtür örtülü+tuval-dışı overlay'leriyle kazançları abartırdı.

### 12.2 Bacak 0 — aynı-gün taban (HEAD `989ddd1`, worker-run-g31; p50, n=3)

| fixtür | 720p | 1080p | 2160p |
|---|---|---|---|
| comp (eski, dejenere) | 38,4 s | 40,9 s* | 51,8 s |
| compReal (gerçekçi) | 36,2 s (1,66x) | **38,3 s (1,57x)** | 47,6 s (1,26x) |
| compCovered (örtülü) | 36,1 s | 41,4 s (1,45x) | 51,6 s |

*comp-1080p'nin ilk koşumu 37,8 idi; makine penceresi gün içinde ~%8 kaydı (SKILLS
perf-olcum tuzağına işlendi) — bacak önce/sonra çiftleri bu yüzden BİTİŞİK pencerede alındı.

### 12.3 Bacaklar (her biri bitişik-pencere canlı önce/sonra + rig kanıtı)

**(b) colorAdjust füzyonu (`e364f2a`).** Rig (round-robin ×3): taban p50 41,4 → füzyon
34,4 s (**−7,1 s**; CPU −80 s) — eski zincirin `exposure` float filtresi (rgba↔float dönüşleri)
en pahalı halkaydı. Canlı compReal-1080p: 41,6/41,1 → 36,1/35,5/34,8 (p50 **41,4 → 35,5**).
Piksel sözleşmesi: §4.1 yazılış kutusu — aşama 1-4 tek `lutrgb` bileşik ifadesi (DOUBLE +
aşama-başına clip + tek nihai `round`); 33-vakalık 256-giriş taramasında füzyon↔normatif
double referans ≤ ±1 LSB (24/33 vakada BİREBİR), eski↔füzyon ≤ ±3 LSB — sınır golden'ı
`ColorAdjustFusion_StaysWithinTheMeasuredEnvelope_AndConvergesToTheNormativeTable`.

**(c) taban-tuval atlaması (`56abab7`).** Mekanizma ölçümle çivilendi: eski −3,1 s sınıfını
üreten şey, alt run tam-örtücüyken taban tuval + ilk overlay'in atlanmasıdır (rig
g-real-nocanvas: p50 −2,1 s ve MP4 **SHA256-birebir** — "bayt değiştirir" endişesi topoloji
korunduğu için geçersiz; 2026-08-24'ün bayt-farkı, overlay'siz düz çıkışın encoder'a farklı
ara formattan inmesindendi, o rejime girilmiyor). Canlı compReal-1080p: 35,9/35,6 →
32,7/32,0/32,3 (p50 **35,75 → 32,3**); g3b↔g3c worker'larının AYNI belge çıktıları
sha256-birebir (`832ba5f3…`, 34 878 279 B). Tuval renk-kaybı (PSNR 35,87 sınıfı) bu
mekanizmada NE AÇILDI NE KAPANDI — çıktı bayt-aynı; kaybın kapanışı tek-katman hızlı yol
rejiminin işidir.

**(a) örtülen-katman budaması (`6237fcf`).** §2.6 yüklemi (taze worker-probe olguları:
tamsayı çapraz-çarpım aspect + SAR=1 + alfasız pix_fmt izin listesi + opaklık/animasyon +
tek-run kapsaması; ses/girişler dokunulmaz). Canlı compCovered-1080p: 28,0/28,7 →
20,1/20,1/20,0 (p50 **28,35 → 20,1 = 2,99x**); g3c↔g3d çıktıları sha256-birebir
(`2566a184…`, 59 406 143 B); canlı yakalanan grafik örtülen üç zincirin ([2:v] alt-açı,
[3:v] şekil, [4:v] metin) YOKLUĞUNU ve alt-açının SESİNİN ([2:a]) DURDUĞUNU gösteriyor.
compReal'de budanacak örtülü katman yok — kazancı 0 (fixtür dürüstlüğünün amacı buydu).

### 12.4 İptal/erteleme kayıtları

(d) N-paralel dilimleme ERTELENDİ (DECISIONS 2026-09-01 satırı: ~13,5/20 çekirdek doygunluğu,
örnek başına ~2,1-2,5 GB ek RSS × N bellek çarpanı, dilimli bitstream'in golden şasisiyle
karşılaştırılamazlığı). §9-1'in eski İPTAL kayıtları (threads taraması, no-op normalize,
enable daraltma) geçerli — yeniden denenMEDİ.

### 12.5 Nihai profil matrisi (worker-run-g3d = üç bacak; p50, n=3, tek tur)

| fixtür | 720p | 1080p | 2160p | dikey |
|---|---|---|---|---|
| compReal | 31,0 s (1,94x) | **32,4 s (1,85x)** | 42,7 s (1,41x) | — |
| compCovered | 18,6 s (3,23x) | 20,1 s (2,99x)* | 30,6 s (1,96x) | — |
| compDikey | — | — | — | 28,6 s (2,10x) |
| comp (eski fixtür) | — | 20,7 s (2,90x)** | — | — |

*compCovered-1080p hücresi (a)-bacağının aynı-ikili aynı-gün SONRA koşumudur.
**Eski dejenere fixtür artık kendi örtülü metin/şekil zincirlerini budadığı için 2,90x —
eski turun "budama −13,2 s" öngörüsü canlıda gerçekleşti; ama kabul ölçütü bilinçli olarak
bu fixtüre DEĞİL compReal'e bağlı.

**SONUÇ:** compReal-1080p aynı-gün zincirde 38,3 → 32,4 s (bitişik-pencere bacak çiftleri:
41,4 → 35,5 → 32,3). Hedef (≥2x = ≤30 s) **KARŞILANMADI: 1,85x** — kalan fark ~2,4 s.
Örtülü (cutaway/b-roll) sınıfı 2,99x, dikey 2,10x, 720p 1,94x. Baş mimar kararı gereği (d)
açılmadan kullanıcıya soruluyor (STATE açık soruları): hedef ölçümle tutmadı; seçenekler
(d) N-paralel'i kendi sözleşme turuyla açmak YA DA kapsam ölçütünü gerekçeli daraltmak
(ör. "gerçekçi bileşim ≥1,8x + örtülü sınıf ≥2x" — mevcut ölçülmüş durum).

## 13. Ses ölçer — oynatma fazı A/B (2026-09-03, panel-3b)

Yöntem §3.2 ile aynı: sayfa içi rAF delta toplayıcı, 60 karelik ısınma + 480 ölçülen kare,
GERÇEK medya (440 Hz sinüs, gerçek yükleme + gerçek fare ile transport). A/B tek değişkenle:
ölçer hücresi mount EDİLİ ve `{false && …}` ile SÖKÜLÜ. Ortam: headless Chromium (vsync 60 Hz,
ideal kare 16,67 ms), Vite dev, 1440x900. Geçici prob spec'i ölçümden sonra silindi.

| Koşum | n | p50 (ms) | p95 (ms) | max (ms) | >33,3 ms |
|---|---|---|---|---|---|
| Ölçer MOUNT EDİLİ | 480 | **16,61** | 17,70 | 20,37 | 0 |
| Ölçer SÖKÜLÜ (taban) | 480 | **16,65** | 17,60 | 32,36 | 0 |

Sonuç: p50 farkı **−0,04 ms** — yani ölçmenin çözebildiği eşiğin altında; iki koşum da vsync'e
oturuyor ve hiçbir kare 33,3 ms'i aşmıyor. (Tabanın max'ının daha yüksek çıkması gürültüdür;
aynı sonucu güçlendirir.) DÜRÜSTLÜK NOTU: headless vsync 16,67 ms'e kilitlediği için bu koşum
"p95 ≤ 8 ms" gibi 165 Hz'lik bir eşiği SINAYAMAZ; ölçtüğü şey ölçerin oynatma döngüsüne
ölçülebilir bir maliyet EKLEMEDİĞİDİR. Ölçüm kadansı zaten 30 Hz'dir (rAF başına iş değil).
