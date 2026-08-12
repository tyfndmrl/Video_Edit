# POC Demo Senaryosu

Ürünü canlı gösterirken izlenecek, **adım adım koşulmuş ve doğrulanmış** akış.
Toplam **~11 dakika** (hazırlanmış proje ile ~10 dk).

Bu dosyadaki her adım, çalışan uygulamada (Vite 5173 + API 5000 + worker + MinIO)
**gerçek fare ve gerçek klavye** ile iki kez ardışık koşuldu; ikisinde de 41/41
adım geçti. Doğrulama kaydı en altta (§7). Doğrulanamayan hiçbir adım burada
değil; ölçüm sırasında çıkan ürün kısıtları §6'da açıkça yazılı.

---

## 1. Ön koşullar

| Gereksinim | Kontrol |
|---|---|
| Docker servisleri | `docker compose -f compose.dev.yml up -d postgres redis minio` |
| API | `dotnet run --project backend/src/VideoEdit.Api` → http://localhost:5000/health `{"status":"ok"}` |
| Medya worker'ı | `dotnet run --project backend/src/VideoEdit.Worker` (yoksa yüklenen medya "Sırada"da kalır) |
| Editör (DEV) | `pnpm --filter @videoedit/editor dev` → http://localhost:5173 |
| ffmpeg + ffprobe | Demo medyasını üretmek için PATH'te olmalı |
| Fontlar | API `VIDEOEDIT_FONT_ROOT` ayarlı olmalı (metin adımı için) |

> Tarayıcı: Chrome/Edge, pencere **1440×900** ya da daha geniş. Timeline'daki
> hedefler (kesim rozeti, kırpma tutamağı) dar pencerede küçülür.

---

## 2. Hazırlık (demo başlamadan önce, sayaç dışı)

### 2.1 Demo medyasını üret (bir kez, ~5 sn)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\make-demo-media.ps1
```

```bash
scripts/make-demo-media.sh          # Linux/macOS
```

`<repo>/.artifacts/demo-media/` altına üç dosya yazar (repoya ikili dosya
konmaz, `.artifacts/` gitignore'da):

| Dosya | İçerik | Boyut |
|---|---|---|
| `demo-01-gradyan.mp4` | 10 sn · 1920×1080 · 30 fps · sesli, sıcak renkli hareketli gradyan | ~7–8 MB |
| `demo-02-test-deseni.mp4` | 10 sn · 1920×1080 · 30 fps · sesli, renk barları + hareketli ögeler + kare sayacı | ~7,9 MB |
| `demo-03-logo.png` | 640×640 RGBA, saydam zeminli halka (kütüphane/format çeşitliliği için) | ~7 KB |

İki videonun renk imzası bilerek farklıdır: geçiş ve renk düzeltme adımlarında
ekrandaki değişim gözle görülür.

### 2.2 İki demo modundan birini seç

**Mod A — "her şeyi canlı göster"** (varsayılan, senaryo bunu anlatır)
Hazırlık yok; §3'ün 1-3. adımlarında proje ve yükleme canlı yapılır.
Bu makinede 3 dosyanın yüklenip işlenmesi **~9 sn** sürdü — anlatacak kadar
kısa, sıkacak kadar uzun değil.

**Mod B — "yükleme beklemesi olmasın"**
Projeyi ve medyayı önceden hazırla:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\seed-demo.ps1
```

Çıktının son satırındaki bağlantıyı aç (`http://localhost:5173/?project=<id>`)
ve senaryoya **4. adımdan** başla. Betik `demo@videoedit.test` / `demo1234`
kullanıcısını (yoksa) oluşturur, yeni bir proje açar, üç dosyayı REST üzerinden
yükler ve hepsi "Hazır" olana kadar bekler. Ölçüldü: **8,6 sn**.

---

## 3. Akış

Süreler konuşma temposu dahildir. "→" tıklanacak yeri, `kısayol` klavyeyi
gösterir.

### Adım 1 — Giriş (40 sn)

**Yap:** http://localhost:5173 → E-posta alanına tıkla, `demo@videoedit.test`
yaz → Şifre alanına tıkla, `demo1234` yaz → **Giriş yap**.

**Görülecek:** Tam ekran proje seçici: "Projeler" başlığı, "Yeni proje" kutusu
ve mevcut projeler listesi.

**Anlat:** JWT + httpOnly refresh cookie; sayfa yenilense de oturum korunur,
`?project=<id>` bağlantısı paylaşılabilir.

---

### Adım 2 — Proje oluştur (25 sn)

**Yap:** "Yeni proje" kutusuna bir ad yaz (ör. `POC Demo`) → **Oluştur**.

**Görülecek:** Editör açılır — üst çubuk, solda **Kitaplık**, ortada
**önizleme**, altta **Timeline**, sağda **Özellikler**. Adres çubuğunda
`?project=<id>` belirir. Timeline sayacı `00:00:00:00 / 00:00:00:00`.

**Anlat:** Proje varsayılanları formun altında yazıyor: **1080p · 30 fps ·
48 kHz**.

---

### Adım 3 — Medya yükle (70 sn — Mod B'de atlanır)

**Yap:** Kitaplık panelinde **Dosya seç** → açılan seçicide
`.artifacts/demo-media` klasöründen **üç dosyayı birden** seç.

**Görülecek (sırayla):**
1. Her dosya için bir yükleme kartı: `Başlatılıyor… → Yükleniyor %NN`,
2. sonra sunucu tarafı: `Sırada → İşleniyor`,
3. sonra yeşil **Hazır** rozeti ve gerçek metadata:
   `0:10 · 1920×1080 · 7.17 MB`, PNG için `0:00 · 640×640 · 6.72 KB`,
4. Kitaplık başlığındaki kota göstergesi güncellenir (`… / 20.0 GB · %N`).

**Anlat (yükleme sürerken):** Dosya API'den **geçmez** — istemci imzalı bir URL
alıp doğrudan nesne depolamaya (dev'de MinIO, prodda R2) çok parçalı yükler.
Yükleme bitince sunucu iş kuyruğuna girer; worker ffprobe ile metadata çıkarır,
oynatma için proxy, timeline için filmstrip şeridi ve ses için dalga formu
üretir. Kart "Hazır" olana kadar klip timeline'a eklenemez — yarım medya ile
kurgu yapılmaz. Desteklenen formatlar: MP4/MOV/WebM, MP3/M4A/WAV, PNG/JPEG/WebP.

> PNG'yi bu adımda **sadece kütüphanede** gösterin, timeline'a eklemeyin
> (sebep: §6, kısıt 1).

---

### Adım 4 — İlk klibi timeline'a al + görünümü ayarla (35 sn)

**Yap:**
1. Kitaplıkta `demo-01-gradyan.mp4` satırına **çift tık**.
2. `Shift+Z` (Sığdır).
3. `-` tuşuna **iki kez** (uzaklaştır, sağa yer aç).

**Görülecek:** Timeline'da otomatik olarak bir **V1** katmanı açılır ve
10 saniyelik klip düşer; klip gövdesinde **filmstrip** (kaynak kareler) çizilir.
Sağdaki "İşlem Geçmişi" bölümünde `demo-01-gradyan.mp4 eklendi` satırı belirir.
Üst çubuktaki otomatik kayıt çipi `Kaydediliyor… → Kaydedildi` olur.

**Anlat:** Klibin süresi kaynağın **gerçek** süresinden gelir ve kare ızgarasına
oturur. Çift tık playhead'e ekler; orası doluysa proje sonuna düşer.

---

### Adım 5 — İkinciyi sürükle-bırakla, arada boşluk bırak (30 sn)

**Yap:** Kitaplıkta `demo-02-test-deseni.mp4` satırının **sol tarafından**
(küçük resim/ad alanı) tut, timeline'a sürükle, **aynı V1 katmanında** ilk
klibin epey sağına bırak (~13. saniye).

> Satırın **sağ** ucundaki düğmelere (çıkartma, ⋯ menü) basarak sürükleme
> başlamaz — soldan tut.

**Görülecek:** Sürüklerken imlecin yanında hayalet kart, timeline'da ise klibin
nereye düşeceğini gösteren yerleşim hayaleti. Bırakınca klip **bırakılan
zamana** oturur; iki klip arasında görünür bir boşluk kalır.

**Anlat:** Çift tık "playhead'e koy", sürükle-bırak ise "tam buraya koy" demek.

---

### Adım 6 — Seçim ve Özellikler paneli (25 sn)

**Yap:** İlk klibin gövdesine tıkla.

**Görülecek:** Klip seçim çerçevesiyle boyanır; sağdaki **Özellikler** paneli
dolar: Klip kimliği (kaynak in/out, başlangıç, bitiş, süre), **Ses** (seviye,
fade in/out, sessize al), **Görüntü** (konum X/Y, ölçek, döndürme, opaklık),
**Hız**, **Renk**.

**Anlat:** Panel kliple ilgili her şeyi tek yerde tutar; her alan hem sürüklenen
bir slider hem de yazılabilir bir sayı — ikisi de dokümanda **aynı** değere
gider.

---

### Adım 7 — Böl ve geri al (35 sn)

**Yap:**
1. Cetvel (üstteki zaman şeridi) üzerinde **4. saniyeye** tıkla → playhead oraya gider.
2. İlk klibe tıkla (seçili olsun) → `C`.
3. `Ctrl+Z`.

**Görülecek:** Klip playhead'de ikiye ayrılır (klip sayısı 2 → 3), geçmişe
`Klip bölündü` düşer; `Ctrl+Z` bölmeyi tek adımda geri alır.

**Anlat:** Her düzenleme tek bir geçmiş girdisi; geçmiş paneli sağda, satırlara
tıklayarak istenen ana atlanabilir.

---

### Adım 8 — Kırp ve boşluğu kapat (65 sn)

**Yap:**
1. **İlk klibin sağ kenarını** tut, sola çekip **9. saniyede** bırak.
2. **İkinci klibin sol kenarını** tut, sağa doğru ~1 saniye çek.
3. İkinci klibin gövdesinden tut, sola sürükle; ilk klibin sonuna **yapışsın**.

**Görülecek:** Kenar sürüklenirken klip kısalır, filmstrip içeriği kayar.
Üçüncü harekette klip, ilk klibin bitişine tam oturur (yapışma); iki klip
**bitişik** olur, boşluk kapanır.

**Anlat (önemli, sonraki adımı hazırlıyor):** Kırpma yalnızca zaman çizgisini
kesmez, **kaynak payı** açar — klibin görünmeyen ama duran kısmı. Geçiş tam
olarak bu paydan beslenir.

> **Sıra neden böyle:** İki klip **bitişikken** ortadaki kenarı tutmak "roll"
> (kesimi kaydırma) yapar ve kaynak payı yoksa reddedilir. Bu yüzden önce
> boşlukken kırpılır, sonra yaklaştırılır. Ölçüldü: ters sırada geçiş adımı
> çalışmaz.

---

### Adım 9 — Geçiş ekle (40 sn)

**Yap:** İki klibin birleştiği **kesimin üstündeki küçük rozete** tıkla
(kesimde, klip gövdesinin alt şeridinde) → açılan menüden **Çapraz geçiş**.

**Görülecek:** Kesimde geçiş göstergesi belirir. Playhead'i geçiş penceresine
getirince önizlemenin üstünde "geçiş" bilgisi çıkar ve iki kaynak karışır.
`Esc` düzenleyiciyi kapatır.

**Anlat:** Varsayılan süre **1,000 sn** ve iki tarafa **simetrik** yazılır;
süre çift kare sayısına yuvarlanır (D/2 tam kare olmak zorunda). Kaynak payı
yetmezse süre kısaltılır ve gerekçesi ekranda söylenir — sessiz ret yok.
Altı geçiş tipi var: çapraz geçiş, siyaha geçiş, sola/sağa silme, yukarı
kaydırma, erime.

---

### Adım 10 — Metin başlığı (55 sn)

**Yap:**
1. Üst çubukta **Metin ekle**.
2. Özellikler → **METİN** → **İçerik** alanına tıkla, `VideoEdit POC` yaz.
3. Aynı bölümde **Renk** hex kutusuna `#ffcc00` yaz, `Enter`.
4. (İsteğe bağlı) **Yazı tipi** listesinden başka bir font seç, **Boyut**'u değiştir.

**Görülecek:** Playhead'in olduğu ana, videonun **üstünde** yeni bir overlay
katmanı ve 5 saniyelik metin klibi düşer; klip seçili gelir. Yazdıkça önizleme
**anında** güncellenir, rengi değiştirince metin sarıya döner.

**Anlat:** Fontlar sunucudan gelen sabit bir katalogdan seçilir ve dışa
aktarımda **aynı** font dosyası kullanılır — önizlemede gördüğün yazı
çıktıdakiyle aynıdır. Bütün yazım tek bir geçmiş girdisine katlanır.

---

### Adım 11 — İkinci katman (şekil) + transform gizmo (65 sn)

**Yap:**
1. Üst çubukta **Şekil ekle**.
2. Önizlemede beliren kutuyu **ortasından** tutup sürükle (konum).
3. **Köşe tutamağını** sürükle (ölçek), **üstteki tutamağı** sürükle (döndürme).
4. Özellikler → **ŞEKİL** bölümünden türü (dikdörtgen/elips) ve dolgu rengini
   değiştir; **Görüntü** → **Opaklık** ile saydamlaştır.

**Görülecek:** Videonun üstüne yarım boyutta mavi bir dikdörtgen düşer
(önizlemede net görünür), seçili gelir ve etrafında tutamaklı seçim kutusu
belirir. Sürükledikçe şekil gerçek zamanlı hareket eder; Özellikler
panelindeki Konum/Ölçek/Döndürme sayıları eş zamanlı değişir.

**Anlat:** Kutu yalnız **seçim varken ve playhead klibin üstündeyken** görünür
— görünmeyen bir kareyi kimse konumlandıramaz. Oynatma başlayınca kutu gizlenir,
duraklayınca geri gelir. Sürükleme ortasında `Esc` jesti iptal eder. Metin ve
şekil aynı overlay hattını paylaşır: ikisi de videonun üstünde, ikisi de aynı
transform kurallarıyla.

> Bu adım bilerek **şekil** ile yapılıyor; görsel/çıkartma katmanı önizlemede
> henüz çizilmiyor (§6, kısıt 1).

---

### Adım 12 — Hız (30 sn)

**Yap:** İkinci videoya (test deseni) tıkla → Özellikler → **HIZ** → **0.5x**.

**Görülecek:** Klibin süresi **iki katına** çıkar (9 sn → 18 sn), timeline'da
klip uzar, isim çubuğunda hız rozeti belirir.

**Anlat:** Hız kaynağın in/out aralığını değil süresini yeniden ölçekler;
sonraki klibe çarpacaksa değişiklik **reddedilir** ve "Sonrakileri kaydır"
seçeneği önerilir. Tarayıcı önizlemesi 0,0625x–16x aralığında çalışır, dışa
aktarımda bu sınır yoktur.

---

### Adım 13 — Renk düzeltme (30 sn)

**Yap:** Aynı klip seçiliyken Özellikler → **RENK** → **Parlaklık** slider'ını
sağa sürükle (ör. +0,5). İstersen **Sıfırla** ile geri al.

**Görülecek:** Önizleme sürükledikçe anında aydınlanır; tek bir geçmiş girdisi
oluşur (`Ctrl+Z` bir adımda geri alır).

**Anlat:** Değerler −1..1 (0 = etkisiz) ve sıra sabittir: pozlama → sıcaklık →
ton → kontrast+parlaklık → doygunluk. Önizleme tek geçişli bir shader ile,
dışa aktarım **aynı formüllerle** ffmpeg tarafında uygular.

---

### Adım 14 — Keyframe ile opaklık animasyonu (55 sn)

**Yap:**
1. **Şekil klibini** seç (geçişi olmayan klip — aşağıdaki nota bak).
2. Playhead'i klibin **başına** getir → Özellikler → **Görüntü** → **Opaklık**
   satırındaki **elmas** düğmesine tıkla.
3. Playhead'i klibin **sonuna** getir → **Opaklık** slider'ını ~%13'e çek.

**Görülecek:** Elmas dolu hale gelir (`◆`), timeline'da klibin altında keyframe
şeridi ve iki elmas belirir; panelde "Animasyonlu: opaklık" özeti çıkar.
Playhead'i iki keyframe arasında gezdirince şekil **yumuşakça kaybolur**.
Elmasa sağ tık easing menüsünü açar; çift tık keyframe'i siler.

**Anlat:** Gösterilen değerler playhead anındaki örneklerdir; alanı değiştirmek
o andaki keyframe'i yazar, yoksa ekler.

> **Neden şekil klibi:** Aynı klipte hem **geçiş** hem **keyframe** varsa dışa
> aktarım bu projeyi reddeder ("geçişli kesimde iki klip tek akışa katlandığı
> için katmanın yerleşimi sabit olmalıdır"). Ölçüldü — geçişli klibe keyframe
> koyup export denenirse demo dışa aktarma adımında durur.

---

### Adım 15 — Önizlemeyi oynat (25 sn)

**Yap:** Playhead'i başa al (`Home`) → `Space`. Birkaç saniye sonra tekrar
`Space`.

**Görülecek:** Playhead ilerler, önizleme oynar; katmanlar (video + şekil +
metin), geçiş, hız ve renk düzeltmesi **birlikte** görünür. Oynatma sırasında
transform kutusu gizlenir.

**Anlat:** `J/K/L` mekik, `←/→` kare kare, `Shift+←/→` saniye saniye,
`↑/↓` kesme noktaları arası. Tam liste: `?`.

---

### Adım 16 — Sürüm kayıt noktası (30 sn)

**Yap:** Üst çubukta **Sürümler** → "Etiket" kutusuna `Demo kayıt noktası`
yaz → **Şu anki hali kaydet** → **Kapat**.

**Görülecek:** Listede en üstte `Kayıt noktası · Demo kayıt noktası · <tarih>`
satırı ve "Güncel kayıt" işareti; altında otomatik kayıtlar (`#21 Otomatik`,
`#1 Otomatik` …). Her satırda **Bu sürüme dön** düğmesi.

**Anlat:** Düzenledikçe sunucuda otomatik sürümler birikir; kayıt noktası
bunlara isim vermektir. Bir sürüme dönmek açık dokümanı değiştirir ve geri alma
geçmişini temizler — dönüşten önceki hal listeye "Geri dönüş öncesi" olarak
eklenir, yani dönüş de geri alınabilir.

---

### Adım 17 — Dışa aktar ve indir (85 sn)

**Yap:**
1. Üst çubukta **Dışa Aktar** → pencerede profil **1080p · H.264** seçili →
   **Dışa aktar**.
2. Sağdaki **DIŞA AKTARMALAR** kartını göster.
3. İş `Tamamlandı` olunca **İndir**.
4. Tarayıcının indirilenler klasörünü aç, dosyayı çift tıkla ve oynat.

**Görülecek:** Pencerede "Tüm değişiklikler kaydedildi." satırı (export
sunucudaki **son kaydedilen** sürümü render eder). Pencere kapanır, kartta
`Sırada → Çalışıyor` ve yüzdeli ilerleme çubuğu, sonra `Tamamlandı` + **İndir**.
İndirilen dosya bu senaryoda **~9,8 MB MP4** (`video/mp4`) oldu.

**Ölçülen süre (bu makine, 27 sn'lik proje):** iş kuyruğa girdikten **12,7 sn**
sonra tamamlandı (0,7 sn kuyruk + 12,0 sn render).

**Anlat:** İndirme bağlantısı 24 saat geçerli imzalı bir URL'dir. Çalışan bir iş
**İptal** ile durdurulabilir. Açılan dosyada aynı kesim, geçiş, metin, şekil,
hız ve renk düzeltmesi vardır — önizleme ile çıktı aynı kurallarla üretilir.

---

## 4. Kapanış cümlesi (isteğe bağlı, 15 sn)

> "Yükleme, kurgu, katman, metin, geçiş, hız, renk, keyframe, sürüm geçmişi ve
> dışa aktarma — hepsi tarayıcıda, tek projede. Kaydetme düğmesi yok; her
> değişiklik otomatik kaydediliyor ve sürüm geçmişinde duruyor."

---

## 5. Zaman bütçesi

| Adım | Süre |
|---|---|
| 1 Giriş | 40 sn |
| 2 Proje oluştur | 25 sn |
| 3 Medya yükle *(Mod B'de ~15 sn)* | 70 sn |
| 4 İlk klip + görünüm | 35 sn |
| 5 İkinci klip (sürükle-bırak) | 30 sn |
| 6 Seçim + Özellikler | 25 sn |
| 7 Böl + geri al | 35 sn |
| 8 Kırp + taşı (yapışma) | 65 sn |
| 9 Geçiş | 40 sn |
| 10 Metin | 55 sn |
| 11 Şekil katmanı + gizmo | 65 sn |
| 12 Hız | 30 sn |
| 13 Renk | 30 sn |
| 14 Keyframe | 55 sn |
| 15 Oynat | 25 sn |
| 16 Sürüm kayıt noktası | 30 sn |
| 17 Export + indir | 85 sn |
| **Toplam** | **~11 dk 55 sn** (Mod B: ~11 dk) |

Kısa sürüm gerekiyorsa **7, 12, 13, 16** numaralı adımlar çıkarılabilir
(~8 dk 15 sn kalır).

---

## 6. Bilinen kısıtlar — demoda dikkat

Aşağıdakiler bu senaryo koşulurken **ölçülen** davranışlardır; sürpriz olmasın.

1. **Görsel (PNG/JPEG) klipler ve çıkartmalar ÖNİZLEMEDE çizilmiyor**
   (ayrıntı: `docs/poc-bilinen-sinirlar.md` §1.1).
   Bu senaryo hazırlanırken bağımsız olarak da ölçüldü: video + PNG çıkartma
   içeren bir projede önizleme kompozitöründen 27 noktalık piksel taraması
   alındı, çıkartma eklenmeden önce ve sonra **tek piksel bile değişmedi**;
   aynı proje dışa aktarıldığında ise logo çıktıda **doğru ve alfa kanalıyla**
   görünüyor (5. saniyeden çıkarılan kare ile doğrulandı).
   **Demoda:** PNG'yi kütüphanede gösterin, timeline'a **eklemeyin**; ikinci
   katmanı **Şekil ekle** ile gösterin (adım 11).
2. **Görsel klip eklenirse doküman değişmezini (invariant) ihlal ediyor** ve
   DEV yapısında her sonraki düzenlemede konsola
   `Timeline invariant violation … sourceOutUs (…) exceeds asset duration (null)`
   düşüyor (bu senaryonun hazırlığında bulundu; `poc-bilinen-sinirlar.md`'de
   henüz yok). Yan etkisi görünür: hata mutasyondan sonra atıldığı için **yeni
   eklenen klip artık otomatik seçilmiyor** (ör. "Metin ekle"den sonra
   Özellikler paneli eski klipte kalır). Sebep: API görseller için
   `durationMicros: null` döndürüyor, istemci bunu "bilinmiyor" değil "0" gibi
   okuyor. Bu senaryo görseli timeline'a hiç koymadığı için etkilenmez.
3. **Aynı klipte hem geçiş hem keyframe → dışa aktarma reddedilir** (adım 14
   notu). Ekranda gerekçesiyle söylenir, sessiz hata değildir.
4. **Bitişik iki klibin ortak kenarı "roll" kırpmadır**; kaynak payı yoksa
   hareket reddedilir (adım 8 notu).
5. **Videonun ÜSTÜNE bir katman koymanın UI'daki yolu overlay katmanlarıdır**
   (**Metin ekle / Şekil ekle / Çıkartma**). Ölçüldü: dışa aktarılan karede
   overlay katmanı videonun üstünde çiziliyor — `tracks[0]` en üst katman.
   `+V` ile açılan video track'i ve "son track'in altına bırak" jesti diziye
   **sona** eklenir, yani görsel yığında **arkaya** düşer (kod okumasıyla:
   `timelineOps.addTrack` → `tracks.push`); video-üstü-video PiP bu yüzden
   şu an UI'dan kurulamıyor.
6. **Dar pencerede** kesim rozeti ve kırpma tutamakları küçülür — 1440 px veya
   üzeri kullanın.
7. Demo **DEV** sunucusunda (Vite 5173) anlatılır; 2. maddedeki konsol hatası
   yalnız DEV'de görünür (denetim üretimde derlenmiyor) — ama dokümanın
   ihlali gerçektir, düzeltilmeden üretime alınmamalı. Demo sırasında tarayıcı
   konsolunu açmayın.

---

## 7. Doğrulama kaydı

Bu senaryodaki adımlar, çalışan uygulamada gerçek fare/klavye ile (Playwright
`page.mouse` / `page.keyboard`; sentetik olay **yok**) uçtan uca koşularak
doğrulandı. Uygulama durumu yalnızca **doğrulama için** okundu
(`window.__videoeditTest`, DEV köprüsü); önizleme pikselleri motorun kendi
`probePixel` köprüsünden alındı.

**Koşum sonucu: iki ardışık tam koşum, her ikisinde de 41/41 adım geçti.**

| Senaryo adımı | Nasıl doğrulandı | Ölçülen |
|---|---|---|
| 1 Giriş | Gerçek klavyeyle e-posta/şifre + tıklama | Proje seçici açıldı |
| 2 Proje oluştur | "Yeni proje" formu, gerçek yazım + tıklama | `?project=<id>` URL'ye düştü, oturum `ready` |
| 3 Medya yükle | Gerçek dosya seçici (`filechooser`) + gerçek 3 dosya | 3 satır "Hazır", kota göstergesi güncellendi |
| 4 Çift tık ile ekleme | Gerçek çift tık | 1 klip, 1 track, süre 10 000 000 µs, geçmiş: "… eklendi" |
| 4 Sığdır / uzaklaştır | Gerçek `Shift+Z`, `-` | pxPerUs 0,0001 → 0,00006365 → 0,0000407 |
| 5 Sürükle-bırak | Gerçek fare sürüklemesi (eşik + hayalet) | Klip bırakılan zamana ±0,01 sn oturdu (13 166 667 µs) |
| 6 Seçim + Inspector | Gerçek tık | `selection` tek klip, `clip-inspector` görünür |
| 7 Böl + geri al | Cetvele gerçek tık, `C`, `Ctrl+Z` | 2→3→2 klip, geçmiş "Klip bölündü" |
| 8 Kırpma (sağ/sol kenar) | Gerçek kenar sürüklemesi | süre 9 000 000 µs / `sourceIn` 1 000 000 µs |
| 8 Taşıma + yapışma | Gerçek gövde sürüklemesi | Başlangıç **tam** 9 000 000 µs (kesim bitişik) |
| 9 Geçiş | Kesim rozetine gerçek tık + tip seçimi | İki tarafa simetrik `crossfade`, 1 000 000 µs; `Esc` kapattı |
| 10 Metin | "Metin ekle" tıklaması + gerçek yazım + hex alanı | `content="VideoEdit POC"`, `fontId=roboto`, `fill=#ffcc00` |
| 11 Şekil katmanı | "Şekil ekle" tıklaması + **önizleme pikseli** | Merkez piksel `255,204,0` → `90,140,255` (şeklin dolgusu) — gerçekten çizildi |
| 11 Gizmo | Gerçek kutu sürüklemesi (150 px) | `transform.x` 0 → 0,182; beklenen 150/kompozisyon genişliği = 0,182 |
| 12 Hız 0.5x | Ön ayara gerçek tık | `rate=0.5`, süre 9 000 000 → 18 000 000 µs |
| 13 Renk | Slider'a gerçek fare sürüklemesi | `colorAdjust.brightness = 0.53` |
| 14 Keyframe | Elmasa gerçek tık + slider sürüklemesi | 2 keyframe (200 000 µs → 1,0 ; 4 800 000 µs → 0,13), "Animasyonlu" özeti |
| 15 Oynat / duraklat | Gerçek `Space` | `isPlaying=true`, playhead 1,83 sn'ye ilerledi; ikinci `Space` durdurdu |
| 15 `Home` | Gerçek `Home` tuşu | playhead 6 000 000 → 0 |
| 16 Sürüm kayıt noktası | Panel açma + gerçek yazım + tıklama | Liste: "Kayıt noktası · Demo kayıt noktası · Güncel kayıt" |
| 17 Export | Gerçek tıklamalar (Dışa Aktar → Dışa aktar) | İş `Tamamlandı`, "İndir" bağlantısı çıktı; 0,7 sn kuyruk + 12,0 sn render = 12,7 sn |
| 17 İndirme | İndirme URL'sine gerçek istek | HTTP 200, 9 835 706 bayt, `content-type: video/mp4`, imza `ftypisom` |
| Kısayol listesi | Gerçek `?` | "Klavye kısayolları" penceresi açıldı |
| Otomatik kayıt | Üst çubuk çipi okundu | "Kaydedildi" |
| Hazırlık betikleri | `make-demo-media.ps1`, `make-demo-media.sh`, `seed-demo.ps1` koşuldu | 3 dosya üretildi (hepsi <20 MB); seed 8,6 sn'de 3 medyayı "ready" yaptı; hem yeni kullanıcı hem mevcut kullanıcı (login) yolu koşuldu |

Bu koşumla **doğrudan** doğrulanmayan, ama senaryoda geçen ikincil detaylar
mevcut kalıcı e2e paketiyle örtülüdür (`apps/editor/e2e/`):
filmstrip'in piksel bazında çizilmesi (`media-upload.spec.ts`), gizmo köşe/
döndürme tutamakları ve oynatmada gizlenme (`player-gizmo.spec.ts`), geçiş
önizleme göstergesi ve iki kaynağın karışması (`transitions.spec.ts`), hızda
"Sonrakileri kaydır" reddi (`speed-color.spec.ts`), keyframe easing menüsü ve
elmas taşıma/silme (`keyframes.spec.ts`), şekil türü/dolgu değişimi
(`text.spec.ts`), "Bu sürüme dön" akışı
(`versions.spec.ts`), export iptali ve indirilen dosyanın oynatılabilirliği
(`export-flow.spec.ts`).
