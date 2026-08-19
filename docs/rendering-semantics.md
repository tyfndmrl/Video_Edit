# Rendering Semantics — Normatif Doküman

> **Statü: NORMATİF.** Bu doküman, tarayıcı önizlemesi (WebGL kompozitör) ile sunucu export'u
> (ffmpeg FilterGraph Compiler) arasındaki birebir eşleşmenin **tek doğruluk kaynağıdır**.
> `docs/design/04-export-render-pipeline.md` §6 ve `docs/design/05-chief-architect-review.md`
> §1.a'da tespit edilen tüm boşlukları kapatır. Buradaki formüllerle çelişen her kod **hatalıdır**;
> davranış değişikliği önce bu dokümanda yapılır, sonra iki tarafta birden uygulanır.
>
> Kapsam (MVP): zaman modeli, koordinat/transform, easing/keyframe, `colorAdjust` + `lut`
> efektleri (`blur`/`chromaKey` MVP dışı — şemada yok), geçişler, renk hattı, metin, ses,
> doğrulama protokolü. Efekt parametreleri (`fx.*`) MVP'de **keyframe'lenemez**.

---

## 1. Zaman

### 1.1 Tamsayı mikrosaniye sözleşmesi

- Tüm zaman değerleri **tamsayı mikrosaniye**dir (TS: `number`, C#: `long`). Float saniye,
  milisaniye veya `Date` tabanlı temsil **yasaktır**. ffmpeg'e saniye yazılırken yalnız
  son adımda, `CultureInfo.InvariantCulture` ile ondalığa çevrilir:

```csharp
static string Sec(long us) => (us / 1_000_000m).ToString("0.######", CultureInfo.InvariantCulture);
```

- JS tarafında µs değerleri en fazla ~10^15 mertebesindedir (saatlerce timeline × fps payları);
  `Number.MAX_SAFE_INTEGER = 2^53-1 ≈ 9·10^15` içinde kalır. Ara çarpımlar bu sınırı aşacaksa
  bölme önce yapılır ya da `BigInt` kullanılır — sessiz taşma yasaktır.

### 1.2 Yuvarlama: half-up (Math.round semantiği)

Tüm yuvarlamalar **half-up** kuralıyla yapılır: `round(x) = floor(x + 0.5)`.
Bu, JS `Math.round` ile birebir aynıdır (negatiflerde de: `round(-0.5) = 0`).
C# `Math.Round` **varsayılan olarak banker's rounding yapar ve YASAKTIR**; şu yardımcı zorunludur:

```ts
// packages/timeline-schema — time.ts
export const roundHalfUp = (x: number): number => Math.floor(x + 0.5);
```

```csharp
// VideoEdit.Media — TimeMath.cs
public static long RoundHalfUp(double x) => (long)Math.Floor(x + 0.5);
```

Cross-language test vektörleri dosyası (`time-vectors.json`) her iki test paketinde de koşar;
`-0.5, 0.5, 1.5, 2.5` gibi kritik girdiler dahildir.

### 1.3 Süre formülü

```
timelineDurationUs = roundHalfUp((sourceOutUs - sourceInUs) / speed.rate)
```

Frontend (`time.ts`) ve C# compiler **aynı formülü** kullanır. Zincirleme hız
(atempo katlama, bkz. §8) süre hesabını değiştirmez — süre daima bu tek formülden gelir.

### 1.4 Proje fps grid'i

Proje ayarı `fps: Rational { num, den }` (örn. `30000/1001`, `30/1`). Tüm UI frame-step,
snapping ve timecode **proje fps grid'inde** çalışır — export ile aynı grid. Dönüşümler:

```
frameFromUs(us) = roundHalfUp(us * num / (den * 1e6))
usFromFrame(n)  = roundHalfUp(n * den * 1e6 / num)
snapUs(us)      = usFromFrame(frameFromUs(us))
```

- Export compiler'ın ilk pass'i her klibin `timelineStartUs`'unu `snapUs` ile grid'e oturtur;
  aynı snap editörde clip bırakma/trim anında da uygulanır (yani dokümandaki değerler zaten
  grid üstündedir, compiler snap'i bir güvenlik ağıdır).
- Keyframe `timeUs` değerleri clip başlangıcına görelidir; kompozit eksene çeviri tek noktada:
  `t_composite = timelineStartUs + kf.timeUs`.

### 1.5 Non-drop timecode

Timecode daima **non-drop** `HH:MM:SS:FF` (iki nokta ayraçlı, noktalı virgül yok):

```
fpsTC = roundHalfUp(num / den)      // 30000/1001 -> 30
FF    = n mod fpsTC                 // n: frameFromUs(playheadUs)
totalS= floor(n / fpsTC)
SS = totalS mod 60; MM = floor(totalS/60) mod 60; HH = floor(totalS/3600)
```

29.97'de non-drop timecode gerçek saat zamanından yavaşça sapar — bu bilinçli üründür,
drop-frame MVP'de yoktur.

### 1.6 VFR → CFR normalizasyonu

VFR (değişken frame süreli, tipik telefon kaydı) kaynak **hiçbir katmana sızmaz**:

- Ingest'te ffprobe `avg_frame_rate` / `r_frame_rate` karşılaştırmasıyla VFR tespit edilir ve
  `probe.json`'a işlenir.
- Proxy üretimi kaynağı **kaynağın nominal CFR'ına** normalize eder (`fps=<kaynakCFR>` filtresi,
  normatif proxy reçetesi plan §3'te). Nominal CFR: `avg_frame_rate`'e en yakın standart oran
  `{23.976, 24, 25, 29.97, 30, 50, 59.94, 60}` kümesinden seçilir.
- Export aynı kaynağa aynı normalizasyonu uygular: her video zinciri
  `fps=<projeFps>,settb=AVTB,setpts=PTS-STARTPTS` ile çıktı grid'ine oturur.

### 1.7 ±1 frame önizleme toleransı (ürün kararı — BEYAN)

Proxy kendi kaynak-CFR grid'inde, UI proje fps grid'inde çalışır. Playhead bir proje-frame'ine
oturduğunda önizleme **en yakın proxy frame'ini** gösterir; bu, export çıktısına göre en fazla
**±1 proje frame'i** görsel sapma demektir. Bu tolerans kabul edilmiş bir ürün kararıdır ve
golden-frame testleri bu toleransla yazılır (bkz. §9). Zaman/pozisyon matematiğinde tolerans
YOKTUR — tolerans yalnız "hangi kaynak karesi ekranda" sorusuna aittir.

> Bu madde **zamansaldır**. Uzaysal tarafta AYRI ve bağımsız bir tolerans vardır ve §2.5'te
> NORMATİF olarak beyan edilir; **İKİ kaynağı** vardır, biri değil: (a) katmanın **boyutunu**
> çift piksele niceleyen `force_divisible_by=2`, (b) katmanın **konumunu** tamsayı piksele
> KIRPAN `overlay` filtresi.
>
> **"Pozisyon matematiğinde tolerans YOKTUR" cümlesi ne demektir, ne demek değildir.** Doğru
> okuması: *hesapta* tolerans yoktur — compiler `P = (W/2 + x·W, H/2 + y·H)`'yi kesirli haliyle,
> yuvarlamadan yazar ve iki taraf aynı sayıyı kullanır. YANLIŞ okuması: "iki rasterin merkezi
> aynı piksele düşer". Düşmez: export koordinatı `floor` ile aşağı kırpılır (§2.5 adım 4),
> önizleme ise kesirli konuma çizer. Sapma rastgele değil, **tam olarak `P`'nin kesirli
> kısmıdır** — yani öngörülebilir, ama sıfır değil (ölçümler §2.5'te). Bu son cümle
> **dönmeyen katman ile 90°'nin katı dönmeler için** ölçülmüştür; ara açılarda katmanın kendi
> DIŞ KENARI ayrıca yeniden örneklenir ve ≤ 1 px'lik bir pay ekler (§2.5(b) ve §9.3).

---

## 2. Koordinat Sistemi ve Transform → Piksel Matrisi

### 2.1 Tanımlar

- `W, H`: proje çıktı çözünürlüğü (px). Önizlemede kompozisyon aynı oranda küçük bir
  tuvale çizilse bile matematik daima `W×H` uzayında kurulur, en sonda tek bir uniform
  ölçekle ekrana taşınır.
- Ekran koordinatı: orijin **sol üst**, +x sağa, +y aşağı. Pozitif `rotationDeg` **saat yönü**
  (CSS/Canvas uzlaşımı; ffmpeg `rotate` da pozitifte saat yönüdür — uyumlu).
- `w_s, h_s`: kaynağın **autorotate uygulanmış** doğal boyutu (rotate metadata'lı telefon
  videosunda probe'un ham değil, döndürülmüş boyutu).
- Normalize koordinat: `x, y ∈ [-0.5 .. 0.5]` tipik aralık, **kompozisyon merkezine göre**;
  `1.0 = tam genişlik/yükseklik` (yani `x=0.5` → merkezden yarım kompozisyon genişliği sağda).
- `anchorX, anchorY ∈ [0..1]`: elemanın kendi kutusu içindeki çapa noktası (default `0.5, 0.5`).

### 2.2 "Fit" tanımı ve ölçek

**fit = contain**: aspect oranı korunur, kaynak kompozisyona sığdırılır, artan alan boş kalır
(letterbox/pillarbox — pad değil, sadece boşluk; taban track tam kaplamıyorsa altına siyah
tuval kompozisyonu girer):

```
fitScale = min(W / w_s, H / h_s)
w_fit = w_s * fitScale          h_fit = h_s * fitScale
```

`scale = 1` **fit boyutu** demektir (kaynağın doğal pikseli değil). Çizim boyutu:

```
w_d = w_fit * scale             h_d = h_fit * scale
```

### 2.3 İşlem sırası (NORMATİF)

Sıra kesindir ve değiştirilemez:

1. Kaynağı fit boyutuna ölçekle (`fitScale`).
2. `scale` uygula (birlikte tek çarpan: `s = fitScale * scale`).
3. Çapa noktası etrafında `rotationDeg` döndür.
4. Çapa noktasını hedef noktaya taşı:

```
P = (W/2 + x*W,  H/2 + y*H)     // çapa noktasının kompozisyondaki yeri
```

Yani: **elemanın çapa noktası P'ye oturur; rotasyonun sabit noktası da çapadır.**

### 2.4 WebGL matris zinciri

Kaynak piksel `p_src ∈ [0..w_s]×[0..h_s]` için (kolon vektör, soldan uygulanır):

```
θ  = rotationDeg * PI / 180
s  = fitScale * scale
a  = (anchorX * w_d, anchorY * h_d)          // çapa, çizim-uzayında
M  = T(P) · R(θ) · T(-a) · S(s)
p_screen = M · p_src
```

Açık piksel formülü (herhangi bir kaynak pikselinin ekran yeri):

```
u = p_src.x * s;  v = p_src.y * s              // çizim-uzayı
p_screen.x = P.x + cos(θ)*(u - a.x) - sin(θ)*(v - a.y)
p_screen.y = P.y + sin(θ)*(u - a.x) + cos(θ)*(v - a.y)
```

NDC'ye geçiş (vertex shader'ın son adımı):

```
ndc.x =  2 * p_screen.x / W - 1
ndc.y =  1 - 2 * p_screen.y / H
```

### 2.5 ffmpeg karşılığı (scale + çapa pad'i + rotate + overlay)

ffmpeg `rotate` filtresi **daima görüntü merkezinde döner ve anchor desteklemez**; telafi
şeffaf bir pad'e ve overlay pozisyonuna taşınır.

> **SÖZLEŞME GÜNCELLEMESİ (M4 dalga 1 denetimi, bulgu #4).** Bu bölüm önceden çapa telafisini
> kapalı formda (`a'x/a'y` ile) tarif ediyordu ve o reçete **kaynağın doğal boyutunu (`w_s,h_s`)
> bilmeyi zorunlu kılıyordu**. Uygulama bilinçli olarak kaynak boyutundan BAĞIMSIZ kurulur:
> ölçek hedefi yalnız proje tuvali × `scale`'dir, aspect'i ffmpeg'in kendi
> `force_original_aspect_ratio=decrease` kuralı korur. Böylece hatalı/eksik bir probe
> geometriyi kaydıramaz ve `fit=contain × scale` TEK resample'da birleşir. Aşağıdaki dört adım
> artık **normatif reçetedir**; eski kapalı form §2.5.1'de *bilgilendirici* olarak durur.
> İki taraf da §2.4'ün açık piksel formülüne uyar — bağlayıcı olan odur.

**Adım 1 — scale (kaynak boyutundan bağımsız):** hedef kutu proje tuvalinin `scale` katıdır:

```
boxW = roundHalfUp(W * scale);  boxH = roundHalfUp(H * scale)
scale=w=<boxW>:h=<boxH>:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic
```

Filtre çıkışındaki gerçek boyut `w_px × h_px` ile gösterilir. Kutu bir **ÜST SINIRDIR**, sonucun
kendisi değil: `decrease` aspect'i korur, `force_divisible_by=2` sonucu **çifte indirir** ve artan
farkı **SAR'a taşır**. Yani `w_px ≤ boxW`, `h_px ≤ boxH` (ffmpeg 8.0 ile ölçüldü: kutu `962×541` +
16:9 kaynak → `962×540`, `sar 480/481`; kare kaynak → `542×540`, `sar 270/271`).
`w_fit*scale × h_fit*scale` yalnız o çarpım zaten çift tamsayıyken birebir tutar; genel kural
yukarıdaki eşitsizliktir.

> **ÖNKOŞUL — DEJENERELİK (NORMATİF).** "Çıktı ≤ kutu" sözleşmesi, sığdırılan boyut **≥ 1 px**
> olduğu sürece geçerlidir. Bir eksen alt-piksele düşerse ffmpeg o ekseni `0` hesaplar ve `scale`
> `0`'ı *"girdi boyutunu koru"* diye yorumlar — çıktı kutudan **büyük** olur ve bu bölümün
> aritmetiği çöker. Tamsayı yüklemi (kutu ≥ 2 iken):
>
> ```
> dejenere  ⟺  boxW * h_s < w_s   ∨   boxH * w_s < h_s
> ```
>
> **Böyle bir katman derlenmez:** `degenerate-layer` tipli hatasıyla reddedilir — kaynak boyutu
> DB'den biliniyorsa API'de **senkron 422**, bilinmiyorsa worker'da `Compile` aşamasında tipli
> hata (`LayerGeometry.IsDegenerate` / `ExportCompiler.EnsureLayerFloor`). Kaynak boyutu hiç
> bilinmiyorsa tam model yerine kaynaktan bağımsız yarısı (`LayerGeometry.IsBelowScaleFloor`:
> kutu her eksende ≥ 2) sorulur — ölçüm yokluğu yanlış ret üretmez, yalnız kapının gördüğü
> kümeyi daraltır.
>
> > **METİN KLİBİNDE "ÖLÇÜM YOKSA KAPI ATLANIR" ARTIK TEK BAŞINA DOĞRU DEĞİL.** Metin katmanının
> > kutusu rasterin kendi bbox'ından türer; bbox ölçülemiyorsa TABAN kapısı gerçekten sorulamaz
> > (metin genişliğinin fonttan bağımsız bir ÜST sınırı yoktur, dolayısıyla alt sınırdan
> > "kutu çok küçük" sonucu çıkarılamaz). Ama bunun sessizce geçilmesi bir KURULUM arızasını
> > gizliyordu: canlı A/B ile ölçüldü — md5-özdeş iki API, tek fark `VIDEOEDIT_FONT_ROOT`;
> > font kökü sağlamken aynı belge **422** alıyor, font kökü yokken **202** alıp dakikalar
> > sonra worker'da `failed` oluyordu. Kural artık şu: **ölçer kayıtlıysa ve ölçüm DENENİP
> > BAŞARISIZ olduysa** istek tipli bir **503** (`text-measure-unavailable`) ile durur — 422
> > değil, çünkü kusur belgede değil kurulumdadır. Hiç ölçer kayıtlı OLMAYAN kurulumlarda eski
> > hoşgörülü davranış aynen korunur. Ayrıntı ve gerekçe: `docs/poc-bilinen-sinirlar.md` §3.3.
>
> **ÇİFTLİK BU ÖNKOŞULA BAĞLIDIR.** Dejenere OLMAYAN rejimde `w_px` ve `h_px` **daima ÇİFTTİR**;
> dejenere rejimde bu da düşer, çünkü ikame edilen değer kaynağın kendi boyutudur ve o tek
> olabilir (ölçüldü: kaynak `1920×101`, kutu `19×11` → çıktı `18×101`). Bölümün geri kalanındaki
> "çıktı çift ve kutudan küçük/eşit" cümleleri bu yüzden **koşulludur** ve o koşul bir KAPIYLA
> sağlanır, varsayımla değil.
>
> *Neden ret, neden "zaten görünmezdi" değil.* Bu rejimin İKİ sonuç sınıfı vardır ve gerçek
> render'la ölçülmüştür; ikisi de kabul edilemez:
>
> 1. **GÜRÜLTÜLÜ** — ikame edilen kaynak boyutu normalize pad hedefini **AŞAR**. Ölçüldü: kaynak
>    `1920×100`, kutu `19×11` → çıktı `18×100`, pad hedefi `18×10` →
>    `Padded dimensions cannot be smaller than input dimensions`, ffmpeg `-22`; iş **kuyruk
>    sonrası** ölür.
> 2. **SESSİZ** — ikame edilen boyut pad hedefine **SIĞAR**. Ölçüldü: kaynak `200×10`, kutu
>    `19×11` → çıktı `18×10`; ffmpeg **hiç şikâyet etmez** (exit 0) ve katman, önizlemenin çizdiği
>    `20×1` yerine `18×10` çizilir — **10 kat** yüksek, tamamen sessiz. (Canlı worker'la da
>    doğrulandı: kural devre dışıyken tek klipli afiş belgesi hatasız render edildi.)
>
> "Katman zaten görünmez ölçektedir" **YANLIŞTIR**: dejenere katman `1920×1080` karede `18×100`'lük
> **görünür bir bant** olarak çizilir. Sessiz sınıf bu düzeltmeden **önce de** vardı ve hiçbir kapı
> onu görmüyordu; kapı yalnız yeni bir sınıfı değil, o eski sessiz bozulmayı da kapatır.
>
> *Erişilebilirlik (bilgilendirici).* Yüklemin **kaynak-oranı** yarısına `1920×1080` tuvalde ancak
> kaynak en-boy oranı **> 19:1** ya da **< 1:11** iken girilir; normal medya (16:9, 4:3, kare,
> dikey, 21:9) STATİK olarak editörün yazabildiği hiçbir ölçekte oraya giremez.
>
> **Yüklemin ikinci yarısı (kutu < 2) RASTER katmanlarda EDİTÖRDEN ULAŞILABİLİRDİR** —
> metin/şekil/çıkartma. Bu, "her katman türünde ulaşılabilir" DEMEK DEĞİLDİR ve o genelleme
> düzeltilmiştir: medya/görsel klibinde kutu PROJE TUVALİNDEN türer, yani editörün ölçek tabanı
> `TRANSFORM_SCALE_MIN = 0.01`'de kutu `1920×1080` tuvalde `19×11`'dir. Bir eksenin `< 2`'ye
> inmesi için (kısa eksen bağlar) ölçeğin statik yolda `1.5/1080 ≈ 0.0014`, animasyonlu yolda
> `2/1080 ≈ 0.0019` altına düşmesi gerekir — editör alanının tabanından **beş kattan fazla**
> aşağısı, ve editör (statik alan da, ölçek keyframe'i de) oraya **yazamaz**.
> O yarıya medya klibiyle ancak **ham API'ye doğrudan yazarak** girilir; kapı orada
> da koşar, ama "kullanıcı bunu farkında olmadan kurabilir" cümlesi YALNIZ raster katmanları için
> doğrudur. "Raster yapısal olarak bağışıktır" cümlesi ise 5. tur denetiminde ÖLÇÜLEREK
> yanlışlandı: bağışıklık, kutunun her eksende ≥ 2 kalmasına KOŞULLUDUR ve ölçek **animasyonu**
> o koşulu kırar (kutu, animasyonun en küçük keyframe'inde `bbox × scale`'e iner). Gerçek fareyle
> ölçüldü: metin klibi + ölçek keyframe'i `0.010` → bbox `223×104` için kutu `2×1`; bbox `6×20`
> için kutu `0×0` ve ffmpeg 99 kare yazdıktan SONRA `Picture size 0x4 is invalid` ile öldü.
> Kapı bu yüzden raster kliplerinde de koşar (`ExportCompiler.EnsureRasterFits` → `EnsureLayerFloor`),
> ve taraması bu koşulu adıyla söyler
> (`LayerGeometryTests.SweptRasterBboxes_AreNotDegenerate_WhenTheScaleFloorHolds`).

**Adım 2 — çapa pad'i (yalnız θ ≠ 0 **ve** çapa merkezde değilse):** görüntü, ÇAPASI padded
tuvalin tam merkezine gelecek şekilde şeffaf tuvale yerleştirilir:

```
mx = max(anchorX, 1-anchorX);   my = max(anchorY, 1-anchorY)
pad=w=iw*<2*mx>:h=ih*<2*my>:x=iw*<mx-anchorX>:y=ih*<my-anchorY>:color=#00000000
padW = w_px * 2*mx;   padH = h_px * 2*my
```

Çapa `0.5` iken `2*mx = 1` ve offset `0`'dır → pad **üretilmez** (no-op).

**Adım 3 — rotate (yalnız θ ≠ 0 ise):** merkez etrafında dönme, çapa merkeze taşındığı için
fiilen **çapa etrafında** dönmedir:

```
ÇİZİLEN tuval:  D = 2*ceil(hypot(w_px, h_px)/2)     // ffmpeg'in gerçek iw/ih'siyle
DEFTER (tavan):  Dg = 2*ceil(hypot(padW, padH)/2)   // compiler'ın KUTUDAN hesabı
rotate=a=<θ_rad>:c=none:ow=2*ceil(hypot(iw\,ih)/2):oh=ow
```

`ow/oh` ffmpeg ifadesiyle yazılır çünkü compiler `w_px/h_px`'i bilmez; ifade **config anında bir
kez** değerlendirilir (frame başına değil) → determinism korunur.

> **`Dg` ÇİZİLEN TUVAL DEĞİL, YALNIZ BELLEK ÜST SINIRIDIR (ölçüldü).** İkisi aynı fonksiyondur
> ("x'ten büyük/eşit en küçük çift sayı") ama **farklı girdilerden** hesaplanır: `Dg` KUTUDAN
> (`padW/padH`), çizilen tuval ise `scale`'in GERÇEK çıktısından (`w_px/h_px`). Kutu bir üst
> sınır olduğu ve dönüşüm monoton olduğu için `D ≤ Dg`'dir — ama **eşit değildir**. Ölçüldü
> (gerçek ffmpeg 8.0, `ow` ifadesi tek tek soruldu): 16:9 kaynak, ölçek `0.555` → kutu
> `1066×599`, gerçek çıktı `1064×598`; defter `Dg = 1224`, ÇİZİLEN tuval `1222`. Tavan
> doğrulaması bilerek `Dg` üzerinden yapılır (güvenli taraf), ama §2.5'in **konum** aritmetiği
> daima ÇİZİLEN tuvale (`overlay` girişinin kendi `w`'sine) aittir — `Dg` oraya konursa 2 px
> kayar. Bu ayrım **koşulludur**: dejenere rejimde gerçek çıktı kaynağın kendi boyutuna sıçrar
> ve `D ≤ Dg` de düşer (ölç.: kutu `19×11` → gerçek `18×100`; `hypot(18,100) = 101.6` iken
> defter `hypot(19,11) = 22` der). O rejim adım 1'in önkoşuluyla reddedilir.

**Bellek tavanı `Dg`'den doğrulanır:**

> **TUVAL NEDEN ÇİFT (NORMATİF, ölçüldü).** `rotate` `ow` ifadesini **round-half-up** ile
> tamsayılar ve ham `hypot` sıklıkla **TEK** çıkar (gerçek ffmpeg 8.0, `ow=hypot(iw\,ih)` ile
> ölçüldü: `960×540 → 1101`, `962×540 → 1103`, `100×100 → 141`, `480×270 → 551`, `1064×598 →
> 1221`, `1066×599 → 1223`; aynı girdilerde `ow=2*ceil(hypot(iw\,ih)/2)` sırasıyla `1102`,
> `1104`, `142`, `552`, `1222`, `1224` verdi). TEK tuvalde içerik tuvalin **ortasına oturamaz**:
> ölçüldü (`a=0`, interpolasyon yok) — `1101`'lik tuvalde içerik merkezi tuval merkezinin
> **+0.5 px** sağında, `1102`'de **tam ortada** (`100×100` kaynakta da aynısı: `141` → `+0.5`,
> `142` → `0.000`). Üstelik overlay telafisi `0.5*w` de yarım tamsayı olurdu. İki yarım piksel
> `a=90°`'de eksenlere **ZIT işaretle** düşüyordu (ölç.: x `−0.5`, y `+0.5`) — yani "sapma daima
> tek yönlü" iddiası orada yanlıştı. Çift tuvalde iki eksende de `0.000` ve dönen katmanın
> merkezi tam olarak `floor(P)`'ye oturur, yani **dönen katman dönmeyenle aynı modele uyar**
> (uçtan uca ölçüm §2.5(b)'de; ara açıların kenar rampası ORADA ayrıca beyan edilir).
> Sabitleyen testler:
> `GoldenFrameTests.RotateCanvas_CentersTheContent_OnlyWhenTheCanvasIsEven` (dış sözleşme —
> canlı ffmpeg'e `a=0` ile sorar, TEK tuvalde 0.5 px, ÇİFT tuvalde 0.0 px ölçer) ve
> `…RotatedLayer_LandsOnTheSameCenterAsTheUnrotatedOne` (uçtan uca piksel, `a=90°`).
> Defter tarafı (`LayerGeometry.CeilEven`) aynı sayıyı üretir: "x'ten büyük/eşit en küçük çift
> sayı" iki biçimde de aynıdır ve monoton olduğu için üst sınır olma özelliği korunur.

```
MaxLayerDimension = 8192       // ara tuval kenarı; 8192² rgba ≈ 256 MB/kare
Dg ≤ MaxLayerDimension  (θ = 0 iken boxW, boxH ≤ MaxLayerDimension)
```

Tavanı **scale kutusuna** uygulamak yetmez: pad 2x, rotate ~1.41x büyütür; kutudan doğrulamak
gerçek tavanı ≈23170 piksele (rgba'da ~2.1 GB/kare → worker OOM) taşır (denetim bulgusu #2).

**Adım 4 — overlay pozisyonu:** çapa, dönen katmanda tuvalin tam ortasındadır; dönmeyende kendi
kutusundaki oranındadır. Hedef **ifadenin İÇİNDE** `floor` ile tamsayılanır:

```
θ ≠ 0:   overlay_x = floor(P.x - 0.5 * w)        overlay_y = floor(P.y - 0.5 * h)
θ = 0:   overlay_x = floor(P.x - anchorX * w)    overlay_y = floor(P.y - anchorY * h)
```

(`w/h` = **overlay girişinin** ffmpeg değişkenleridir. Adım 3'ten sonra ikisi de ÇİZİLEN kare
tuvalin kenarıdır — yani `D = 2*ceil(hypot(w_px,h_px)/2)`, defterdeki `Dg` DEĞİL; ikisi
eşit olmak zorunda değildir, bkz. adım 3'ün kutusu.)

> **`floor` NEDEN ZORUNLU (NORMATİF, ölçüldü).** overlay'in **kendi** tamsayı çevrimi
> (`normalize_xy`'nin `(int)`'i) **SIFIRA DOĞRU** kırpar, `floor` ile değil. Gerçek ffmpeg 8.0,
> 64 px tuval + 20 px katman: `x=-10.1 / -10.5 / -10.9 / -10.999` → **hepsi** sol kenar `-10`;
> `x=-11` → `-11`. Pozitif tarafta ikisi aynıdır, yani `floor` **pozitif rejimi hiç
> değiştirmez**. Hedef negatifleştiği an ise iki bağımsız sözleşme kırılırdı:
>
> 1. **pad'li ve pad'siz yol ayrışırdı** (§5.2 invaryantı). Pad'li yolda sol kenar
>    `⌊·⌋(P − nb/2) + (nb − w)/2`, pad'siz yolda `⌊·⌋(P − w/2)`'dir; `(nb − w)/2` **tam sayı**
>    olduğu için `floor` altında iki ifade **özdeştir**, `trunc` altında değildir. Ölçüldü
>    (1080p, ölçek `1.005`, `x=0.0025`, kutu `1930×1085`): 16:9 / 4:3 / kare / 9:16 / 3:4
>    kaynakların **beşi de** 1 px ayrıştı, `floor` ile **beşi de** eşitlendi.
> 2. **ölçek > 1'de sapmanın İŞARETİ değişirdi.** Katman tuvali taştığı an (her yakınlaştırma)
>    hedef negatife düşer. Ölçüldü (1080p, 16:9, ölçek `1.2`, `x=-0.1026`, hedef `-388.992`):
>    `trunc` ile merkez `P`'nin **+0.992 px sağına**, `floor` ile `-0.008 px` soluna düştü.
>
> `floor` ffmpeg ifade değerlendiricisinde **vardır** ve overlay onu kabul eder; negatif kontrol
> aynı testtedir (uydurma bir fonksiyon adı `Unknown function` ile reddedilir, yani `floor`
> sessizce yutulmuyor). Sonuç tamsayı olduğu için overlay'in kendi `(int)`'i no-op'a düşer.
> Sabitleyen testler: `GoldenFrameTests.OverlayExpression_TruncatesTowardZero_AndAcceptsFloor`
> (dış sözleşme), `…ZoomedLayer_LandsOnTheFlooredTarget_EvenWhenItIsNegative` (piksel),
> `ExportCompilerSnapshotTests.EveryOverlayCoordinate_IsFloored` (yapısal muhafız).

**Konum kuantalanması (NORMATİF):** overlay konumu **alt örneklenmemiş** bir kompozisyon
tuvalinde değerlendirilmelidir. ffmpeg `overlay`, 4:2:0 tuvalde `x/y`'yi chroma adımına kırpar
(`normalize_xy`) — `overlay=x=11` yuv420'de **10**'a, `x=−11` ise **−12**'ye oturur; `:format=rgb`
ile ikisi de yerinde kalır (ölçüldü; tablo ve bekçi test §6.3'te). Bu yüzden kompozisyon tuvali
daima RGB'dir (§6.3); aksi halde aynı transform, katmanın opaklığına göre 1 px farklı yere
düşerdi.

**Tamsayı kırpmasının DİĞER İKİ kaynağı (NORMATİF).** Chroma kuantalaması tek kaynak değildir;
aşağıdaki ikisi de tamsayıya kırpar ve **aynı yöne toplanabilir**:

1. kutuya normalize eden pad'in ofseti — `(ow-iw)/2`;
2. overlay ifadesinin kendisi — `P - anchor*w`.

Kutu TEK boyutluyken ikisi birlikte katmanı **1 tam piksel** kaydırır (ölç.: kutu `962×541`,
içerik `962×540` → ham kutuya pad'lenirse `y[269..808]`, doğrusu `y[270..809]`). Kural bu yüzden:

> **Kutuya normalize eden pad'in HEDEFİ, kutunun ÇİFTE İNDİRİLMİŞ halidir (`Box & ~1`, alt sınır 2);
> `scale`'in hedefi ise HAM kutudur.** Çıktı daima çift ve kutudan küçük/eşit olduğu için bu hedef
> kırpmaz; çift hedef + çift içerik `(ow-iw)/2`'yi tam böler. Ölçek hedefini de indirmek YASAKTIR:
> içeriği küçültür (`962 → 960`) ve pad'siz yolla ayrıştırır.

**MERKEZ ÇAPADA KAYNAK 2 ARTIK HİÇ KIRPMAZ (ölçüldü).** Yukarıdaki çift-hedef kuralı `(ow-iw)/2`'yi
tam böldürür, adım 4'ün `floor`'u ise overlay ifadesini `trunc`'un işaret bağımlılığından kurtarır.
İkisi birlikte şunu verir: pad'li yolun sol kenarı `⌊·⌋(P − nb/2) + (nb − w)/2`, pad'siz yolunki
`⌊·⌋(P − w/2)`; `(nb − w)/2` tam sayı olduğu için **iki ifade özdeştir** (`⌊a⌋ + k = ⌊a + k⌋`).
Yani merkez çapada toplanacak İKİ kırpma kalmaz, **bir** tane kalır. Merkez DIŞI çapada pad ofseti
`(ow-iw)*anchor` ile oransaldır, tam bölünmez ve iki kırpma **hâlâ** toplanabilir — o rejim
editörden ulaşılamaz ve §5.2'nin invaryantı bu yüzden merkez çapayla koşulludur.

**UZAYSAL TOLERANS — önizleme ↔ export (ürün kararı, BEYAN; NORMATİF).** §1.7 yalnız **zamansal**
toleransı (±1 frame) beyan eder. Uzaysal sapmanın **İKİ BAĞIMSIZ kaynağı** vardır; ikisi de gerçek
ffmpeg 8.0 ve gerçek tarayıcı ölçümüyle kurulmuştur ve **aynı eksende toplanabilirler**.

**(a) BOYUT nicelemesi — simetrik, merkezi korur.** `force_divisible_by=2` her ekseni çift
tamsayıya niceler, yani çizilen kutu önizlemenin kesirli kutusundan sapar:

```
her eksende:  w_px − w_fit*scale ∈ [−1.600, +1.480] px  (ÖLÇÜLEN zarf);  kenar başına ≤ 1 px
bu bileşen MERKEZİ KORUR  (w_px ÇİFT olduğu için merkez = floor(P), w_px'ten BAĞIMSIZ)
```

- Ölçüm (kaynak taraması: 16:9, 9:16, 4:3, kare, 21:9 kaynak × editörün yazabildiği bütün ölçek
  ızgarası; taramanın bulduğu uç vakalar tek tek gerçek ffmpeg'e sorulup doğrulandı): tam kutuda
  sapma **[−1.600, +1.480] px** aralığında kaldı → kenar başına **[−0.80, +0.74] px**. En büyük
  negatif: 16:9 kaynak, ölçek `1.08` → kutu `2074×1166`, çıkış `2072×1166` (ideal `2073.6`);
  aynı `−1.600` ölçek `0.555`'te de ölçüldü (kutu `1066×599` → `1064×598`, ideal `1065.6`).
  En büyük **pozitif**: KARE kaynak, ölçek `3.819` → kutu `7332×4125`, çıkış `4126×4124`
  (ideal `4124.52`) → **+1.480**. 720p'de zarf `[−1.600, +1.440]`. Üç uç da gerçek ffmpeg 8.0'a
  tek tek soruldu ve tarama modelinin verdiği sayının aynısı çıktı.

  > **"Kapalı bir üst sınır vardır" DEMEK YANLIŞTI (ölçümle düzeltildi).** Buraya bir tur önce
  > *"kutu `roundHalfUp` ile idealden en çok 0.5 px sapar, `force_divisible_by=2` en çok 2 px
  > indirir"* yazılmıştı; **iki yarısı da yanlış.**
  >
  > 1. `force_divisible_by=2` **yalnız İNDİRMEZ, ARTIRABİLİR de.** ffmpeg aspect'i koruyan adayı
  >    `av_rescale` ile **en yakın** 2 katına çeker (yarım → sıfırdan uzağa), ancak ondan sonra
  >    kutuya `min` ile kırpıp `/2*2` ile aşağı indirir. Doğrudan ölçüldü (kare kaynak, kutu
  >    `7332×4125`): `force_divisible_by` **YOKKEN** çıkış `4125×4125`, **VARKEN** `4126×4124` —
  >    genişlik 1 px **YUKARI** gitti. Zaten `+1.480` ucu tam olarak budur.
  > 2. İndirme payı da 2 değil **en çok 1 px**'tir (`w/2*2` bir tamsayıdan en çok 1 götürür).
  >
  > Gerçek zarf tek bir sabit değildir: aspect'in BAĞLADIĞI eksende hata, diğer eksenin kutu
  > yuvarlamasıyla **aspect oranı kadar çarpılarak** taşınır (16:9'da 0.5 px → 0.89 px) ve
  > üstüne `av_rescale`'in ≤1 px'i biner. Bu yüzden burada kapalı bir formül değil, **taranan
  > küme üstünde ölçülmüş bir zarf** beyan edilir; kapsam dışı bir kaynak aspect'i eklenirse
  > zarf yeniden ölçülmelidir.
- Sapma **simetriktir** (her iki kenardan eşit): bu bileşen katmanı **kaydırmaz**. Ölçüldü
  (1080p, `x=0`): ölçek `0.501` → kutu `962×541`, çizilen `962×540`, merkez `960.0` — ideal de
  `960.0`. Ölçek `0.555` → kenarlar `+0.8 / −0.8`, merkez yine tam.
- Editörün yazabildiği ölçeklerin **%98'inde** en az bir eksende oluşur (1080p, 16:9 kaynak;
  `0.010…4.266` ızgarasının 4257 değerinden 4172'si). 720p'de **%96**. Yani istisna değil,
  **normal** haldir.

**(b) KONUM kırpması — tek yönlü, merkezi KAYDIRIR.** Derleyici çapa hedefini **ifadenin içinde
`floor` ile** aşağı kırpar (adım 4). Ölçüldü (gerçek ffmpeg 8.0, 64 px tuval + 20 px katman,
aydınlanan sütunlar okunarak): `x=10.1`, `10.5`, `10.9` → **hepsi 10. sütundan başlar**; `x=11`
→ 11. Yuvarlama olsaydı `10.5+` değerleri 11'e giderdi.

**Genel form (NORMATİF).** `w` = **overlay GİRİŞİNİN** genişliği (adım 3'ten sonraki akışın
`w`'si), `a` = o girişteki çapa oranı (dönende `0.5`, dönmeyende `anchorX`). overlay TAMSAYI bir
sol kenara yerleşir; çapa oradan `a*w` kadar içeridedir:

```
sol kenar   = floor(P − a*w)
çapa nerede = floor(P − a*w) + a*w
sapma       = P − (çapa nerede) = frac(P − a*w) ∈ [0, 1)   // DAİMA AŞAĞI/SOLA
```

Sapmanın **büyüklüğü** (< 1 px, tek yönlü) `a*w`'den bağımsızdır. `a*w`'nin TAMSAYI olması ise
ayrı ve daha güçlü iki şey verir: (i) sapma tam olarak **`frac(P)`** olur — yani §9.3'ün
"beklenen değer hesaplanabilir" satırı ancak o zaman geçerlidir; (ii) çapa tamsayı bir piksel
sınırına oturur. İki koşul birlikte bunu garanti eder ve ikisi de bu dokümanın başka bir
yerinde zaten zorunludur:

1. **`a = 0.5`** — editör çapa alanı sunmaz, dokümana daima `0.5` yazar (§5.2'nin merkez-çapa
   koşulu). Dönen katmanda `a` zaten sözleşme gereği `0.5`'tir (adım 2'nin pad'i çapayı tuval
   merkezine taşır).
2. **`w` ÇİFT** — dönmeyende `force_divisible_by=2` (dejenere OLMAYAN rejimde, bkz. adım 1'in
   önkoşulu), dönende `ow = 2*ceil(hypot(iw,ih)/2)` (adım 3).

Koşullardan biri düşerse `a*w` yarım tamsayı olur; sapma yine `[0, 1)`'dedir ama artık
`frac(P)` DEĞİL `frac(P ∓ 0.5)`'tir — yani önizlemeyle karşılaştırma için **öngörülebilir
referans kaybolur**. **İki rejim de KAPSAM DIŞIDIR ve ölçülmemiştir:** merkez dışı çapa
editörden ulaşılamaz (§5.2), tek `w` yalnız dejenere rejimde doğar ve o rejim tipli hatayla
**reddedilir** (adım 1'in önkoşulu).

> **`(int)` SIFIRA DOĞRU kırpar, `floor` ile DEĞİL.** Yukarıdaki `floor` ffmpeg'in kendi
> çevrimi değil, **bizim ifadeye yazdığımızdır**. overlay'in `normalize_xy`'sindeki `(int)`
> sıfıra doğru kırpar: aynı koşumda `x=-10.1 / -10.5 / -10.9 / -10.999` → **hepsi** sol kenarı
> `-10`'a koydu, `x=-11` → `-11`; `floor(-10.1)` ise sol kenarı `-11`'e koydu. Pozitif tarafta
> ikisi **aynıdır** — `x=10.1` ile `x=floor(10.1)` aynı sütundan (`10`) başladı — yani `floor`
> pozitif rejimi hiç değiştirmez. İfadenin sonucu zaten tamsayı olduğu için `(int)` no-op'a
> düşer. Negatif kontrol AYNI koşumda: uydurma bir fonksiyon adı (`gloor(-10.5)`) ffmpeg'i
> `Unknown function in 'gloor(-10.5)'` ile düşürdü, yani bilinmeyen bir ad sessizce yutulmuyor
> — `floor`'un gerçekten değerlendirildiği bu şekilde kanıtlanır.
>
> **Ölçek > 1 rejimi (ölçüldü).** Hedef ancak katman tuvali taştığında negatifleşir — yani her
> yakınlaştırmada. `trunc` orada sapmanın **işaretini** çevirirdi; `floor` altında sapma her
> ölçekte ve her işarette aynı pencerede kalır. Ölçümler adım 4'ün altındaki kutuda.
>
> **Dönme rejimi (ölçüldü).** Ara tuval ÇİFT olduğu için `0.5*w` tamsayıdır ve dönen katmanın
> merkezi de `floor(P)`'ye oturur. Uçtan uca ölçüm (gerçek ffmpeg, 1080p, 16:9 kaynak,
> ölçek `0.555`, `P = (964.992, 540)` → `floor(P) = (964, 540)`; katmanın parlaklık ağırlık
> merkezi): `a=0` → `(964.000, 539.998)`, `a=90°` → `(964.002, 540.000)`. **ARA AÇILAR AYRI BİR
> ŞEYDİR ve konumla ilgili değildir:** `rotate` katmanın DIŞ KENARINI yeniden örneklerken kenar
> rampasını asimetrik bırakır ve ağırlık merkezi ölçümü ~0.4–0.7 px sapar (aynı düzenekte
> `a=15/30/45` → `x` 963.6–963.7). Bunun kaynağı yerleşim DEĞİLDİR: aynı ölçüm dönmeye duyarsız
> bir DİSKLE her açıda `0.000` verdi, ve kendi çerçevesine DEĞMEYEN bir kareyle de
> (`a=0/1/30/45/90`) `0.000` verdi. Yani sapma katmanın kendi alfa kenarındadır, merkezinde
> değil. Bu etki §9.3'ün merkez satırında ayrıca koşullandırılmıştır.

- Uçtan uca ölçüm — AYNI belge, iki taraf. 1080p tuval, `320×320` kaynak, ölçek `0.5`
  (kutu `960×540` → çizim `540×540`, boyut nicelemesi YOK), `x = 0.0026` → `P = 964.992`:
  **önizleme** (gerçek tarayıcı, kompozitörün kendi `probePixel`'i, proje koordinatında
  `gl.readPixels`) katmanı `695…1234` sütunlarına çizdi; **export** (gerçek ffmpeg, derleyicinin
  yazdığı `overlay=x=964.992-0.5*w` biçimiyle) `694…1233`. İki raster **tam 1 piksel** ayrı.
- Negatif kontrol AYNI ölçümde: `x = 0.0125` → `P = 984` (TAMSAYI) → önizleme de export de
  ideal sol kenarı `714`'e koydu — **0 px**. Yani sapma tam olarak `frac(P)`'dir.
- **ULAŞILABİLİRLİK.** `x`/`y` 4 ondalıkla saklanır (`POSITION_DECIMALS = 4`, `timelineOps` ve
  gizmo). 1920 px tuvalde `P` ancak `x` 0.0125'in katıyken tamsayıdır → 4 ondalıklı ızgaranın
  yalnız **%0.8'i**; kalan **%99.2'sinde merkez KAYAR** (1280 px'te de aynı oran: orada da
  koşul `x`'in 0.0125'in katı olmasıdır). Gerçek fareyle ölçüldü: gizmo ile katmanı yana
  sürükleyen **7 jestin 7'sinde** de `P` kesirli çıktı.

**(c) İKİSİ AYNI EKSENDE TOPLANIR.** (a) simetriktir, (b) tek yönlü; bir kenarda birbirini götürür,
KARŞI kenarda toplanır. Ölçüldü (gerçek ffmpeg, 1080p, 16:9 kaynak, ölçek `0.555`, `x = 0.0026`):

```
sol kenar : 432  (ideal 432.192)  → −0.19 px
sağ kenar : 1496 (ideal 1497.792) → −1.79 px     ← iki kaynak AYNI YÖNE toplandı
merkez    : 964  (ideal 964.992)  → −0.99 px
```

Yani **kenar başına sapmanın üst sınırı ~1.8 pikseldir**, "≤ 1 px" değil; ve **merkez birebir
korunmaz**. Golden-frame eşikleri (§9.3) bu üç ölçüme göre yazılır.

**Dejenere rejim bu toleransın DIŞINDADIR** — orada sapma sınırsızdır (10–100 kat) ve o yüzden
tolere edilmez, **reddedilir** (yukarıdaki dejenerelik önkoşulu).

> **Bu blok neden yeniden yazıldı (kayda geçsin).** Önceki hali "MERKEZ birebir korunur" ve
> "sapma simetriktir" diyordu; ikisi de yalnız (a) için doğrudur ve (b) ölçülmeden yazılmıştı.
> §9.3'ün "çapa/merkez 0 px — tolerans yok" satırı da bu yüzden ürünle çelişiyordu: kullanıcının
> gizmoyla yaptığı hemen her taşımada merkez bir piksel kayıyor ve hiçbir test bunu görmüyordu.

#### 2.5.1 Eşdeğer kapalı form (bilgilendirici)

Kaynak boyutu biliniyorsa aynı sonuç pad'siz de yazılabilir — iki hat aritmetik olarak eşdeğerdir:

```
cx = w_px / 2;  cy = h_px / 2                          // çizim merkezi
ax = anchorX * w_px;  ay = anchorY * h_px              // çapa
Dc = ceil(hypot(w_px, h_px))                           // KAPALI FORMUN kendi tuvali
a'x = Dc/2 + cos(θ)*(ax - cx) - sin(θ)*(ay - cy)
a'y = Dc/2 + sin(θ)*(ax - cx) + cos(θ)*(ay - cy)
overlay_x = P.x - a'x ;   overlay_y = P.y - a'y
```

Bu form daha küçük bir ara tuval kullanır (`Dc ≤ Dg`) ama kaynak boyutuna bağımlıdır; MVP'de
tercih edilmemiştir. Geçilirse §2.5'in tavan kuralı `Dc` üzerinden uygulanır — ve `Dc` de
ÇİFTE tamamlanmalıdır, aksi halde §2.5 adım 3'ün ölçülmüş yarım-piksel sorunu bu hatta
yeniden doğar (`a'x` yarım tamsayı olur).

Doğrulama invaryantı (unit test): her iki hattın formülüne aynı `(x, y, scale, rotationDeg,
anchor)` girildiğinde **çapa pikselinin ekran koordinatı birebir aynı çıkmalı**; köşe
noktalarında fark ≤ 0.5 px (yuvarlama payı).

**Keyframe'li transform:** `overlay x/y` piecewise-linear `if` expression'ı ya da sendcmd
ile beslenir (design 04 §2.5); expression'daki değerler yukarıdaki formüllerin `t`'ye bağlı
halidir — yani compiler önce her keyframe zamanı için `overlay_x/y` çözer, aralar §3'e göre
interpole edilir.

---

## 3. Easing ve Keyframe İnterpolasyonu

### 3.1 Preset katsayıları (NORMATİF)

Cubic-bezier `P0=(0,0)`, `P1=(x1,y1)`, `P2=(x2,y2)`, `P3=(1,1)` (CSS eşdeğerleri):

| Preset      | x1   | y1 | x2   | y2 |
|-------------|------|----|------|----|
| `linear`    | —  (kimlik fonksiyonu: `e(p) = p`) | | | |
| `easeIn`    | 0.42 | 0  | 1    | 1  |
| `easeOut`   | 0    | 0  | 0.58 | 1  |
| `easeInOut` | 0.42 | 0  | 0.58 | 1  |

Şemadaki `{ type: 'cubicBezier', x1, y1, x2, y2 }` serbest katsayıya izin verir;
`x1, x2 ∈ [0..1]` zorunludur (zod + compiler doğrular), `y` serbesttir.

### 3.2 Değerlendirme algoritması (NORMATİF — iki dilde aynı)

Zaman ilerlemesi `p ∈ [0..1]` verildiğinde `x(t) = p` denklemi **32 iterasyonlu bisection**
ile çözülür (Newton YASAK — yakınsama farkları iki dilde farklı sonuç üretebilir; sabit
iterasyonlu bisection deterministiktir):

```ts
function cubicBezierEase(x1: number, y1: number, x2: number, y2: number, p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const bx = (t: number) => 3*t*(1-t)*(1-t)*x1 + 3*t*t*(1-t)*x2 + t*t*t;
  const by = (t: number) => 3*t*(1-t)*(1-t)*y1 + 3*t*t*(1-t)*y2 + t*t*t;
  let lo = 0, hi = 1, t = p;
  for (let i = 0; i < 32; i++) {          // sabit 32 iterasyon — deterministik
    t = (lo + hi) / 2;
    if (bx(t) < p) lo = t; else hi = t;
  }
  return by(t);
}
```

C# implementasyonu satır satır aynı algoritmadır (`double`, 32 iterasyon). Cross-language
test vektörleri (`easing-vectors.json`): her preset için `p ∈ {0, 0.1, …, 1}` noktalarında
beklenen değerler, tolerans `1e-6`.

### 3.3 Keyframe interpolasyon kuralı

- `Keyframe { timeUs, value, easing }` — **easing, bu keyframe'den SONRAKİ segmente aittir.**
  Son keyframe'in easing'i etkisizdir.
- `t` anında değer (clip-göreli zaman, timeline-zamanında, speed'den bağımsız):

```
t <  kf[0].timeUs                  ->  kf[0].value
t >= kf[last].timeUs               ->  kf[last].value
kf[i].timeUs <= t < kf[i+1].timeUs ->
    p = (t - kf[i].timeUs) / (kf[i+1].timeUs - kf[i].timeUs)
    e = ease(kf[i].easing, p)
    value = kf[i].value + (kf[i+1].value - kf[i].value) * e
```

- Track'te keyframe yoksa taban (statik) değer geçerlidir.
- MVP'de yalnız `x, y, scale, rotationDeg, opacity, volume` keyframe'lenebilir;
  **`fx.*` anahtarları şemadan çıkarılmıştır** (baş mimar kararı).

### 3.4 sendcmd frame örnekleme kuralı (NORMATİF)

ffmpeg tarafında lineer olmayan easing'ler expression'a gömülmez; **proje fps'inde her çıktı
frame'ine bir örnek** üretilir ve sendcmd dosyasına yazılır:

```
for n in [firstFrame .. lastFrame]:           // clip'in kompozit eksendeki frame aralığı
    t_us   = usFromFrame(n)                   // §1.4 formülü, kompozit eksen
    t_clip = t_us - timelineStartUs
    v      = evalKeyframes(track, t_clip)     // §3.3
    emit:  "<Sec(t_us)> <filterInstance> <param> <v with InvariantCulture, 6 hane>"
```

- Örnekleme noktası **frame'in başlangıç zamanıdır** (frame ortası değil).
- Preview aynı `evalKeyframes`'i her render karesinde çağırır; iki taraf aynı fonksiyon
  ailesini (aynı vektör testlerinden geçen) kullandığı için eğri özdeştir.
- Lineer segmentler için compiler sendcmd yerine piecewise-linear `if` expression'ı
  üretebilir (ucuz yol); sonuç matematiksel olarak aynıdır.

---

## 4. Efekt Eşleme Tablosu (`colorAdjust` + `lut`)

MVP efekt seti: **`colorAdjust`** ve **`lut`**. `blur` ve `chromaKey` MVP dışıdır ve şemada
yoktur (baş mimar kararı). Efektler klip pikseline **transform/overlay'den ÖNCE** uygulanır
(kaynak zincirinde), sıra: `colorAdjust` → `lut`.

### 4.1 `colorAdjust` — parametre başına üçlü eşleme

Tüm UI parametreleri `v ∈ [-1..1]`, default `0` (etkisiz). Uygulama sırası **NORMATİF**
(iki tarafta aynı): `exposure → temperature → tint → contrast+brightness (tek afin op) →
saturation`. Her aşama sonucu `[0..1]`'e clamp edilir (ffmpeg 8-bit ara formatların doğal
davranışıyla eşleşmek için GLSL'de de aşama başına `clamp`).

Aşağıdaki `<…>` yer tutucuları **derleme zamanında hesaplanmış sayı literalleri**dir
(InvariantCulture, en fazla 6 kesir hanesi); negatif literaller ffmpeg eval'de çift işaret
tuzağına düşmesin diye paranteze alınır (`255*(-0.02)`). Efekt zinciri **RGB'de** koşar:
çağıran önüne `format=rgba` koyar ve zincir boyunca renk uzayı DEĞİŞMEZ (§6.3).

| Param | UI aralığı | ffmpeg formülü | WebGL GLSL formülü | Matematik |
|---|---|---|---|---|
| `exposure` | -1..1 | `exposure=exposure=<v>:black=0` | `c.rgb = clamp(c.rgb * exp2(v), 0., 1.);` | Çarpımsal gain `2^v`. **Gamma DEĞİL.** ffmpeg `exposure` filtresi `black=0` ile tam `in * 2^ev` uygular. |
| `temperature` | -1..1 | `lutrgb=r='clip(val+255*<0.10*v>,0,255)':b='clip(val-255*<0.10*v>,0,255)'` | `c.r = clamp(c.r + 0.10*v, 0., 1.);`<br>`c.b = clamp(c.b - 0.10*v, 0., 1.);` | Lineer RGB kanal ofseti, katsayı `K_TEMP = 0.10`. Pozitif v = sıcak (+R, −B). |
| `tint` | -1..1 | `lutrgb=g='clip(val-255*<0.10*v>,0,255)'` | `c.g = clamp(c.g - 0.10*v, 0., 1.);` | Lineer yeşil ofseti, katsayı `K_TINT = 0.10`. Pozitif v = magenta (−G). |
| `brightness` | -1..1 | contrast ile **AYNI** `lutrgb` ifadesinde (`+<255*b>` terimi) | bkz. contrast satırı | Toplamsal: her RGB kanalına `b` ekler. |
| `contrast` | -1..1 | `lutrgb=r='<E>':g='<E>':b='<E>'` — üç kanalda AYNI ifade, `<E>` = `clip((val-127.5)*<1+v>+127.5+<255*b>,0,255)` | `c.rgb = clamp((c.rgb - 0.5)*(1.0+v) + 0.5 + b, 0., 1.);` | KANAL BAŞINA tek afin op: `out = (in-0.5)*(1+v) + 0.5 + b`. 8-bit ekseninde `0.5 → 127.5`, `b → 255*b`. contrast ve brightness'ı ayrı filtrelere bölmek YASAK (sıra farkı üretir). |
| `saturation` | -1..1 | `colorchannelmixer=rr=<k+m*Lr>:rg=<m*Lg>:rb=<m*Lb>:gr=<m*Lr>:gg=<k+m*Lg>:gb=<m*Lb>:br=<m*Lr>:bg=<m*Lg>:bb=<k+m*Lb>` (`k = 1+v`, `m = -v`, `L = BT.709`) | `float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));`<br>`c.rgb = clamp(mix(vec3(l), c.rgb, 1.0+v), 0., 1.);` | `out = luma + (in-luma)*(1+v)` RGB'de LİNEER bir matristir → `colorchannelmixer` ile birebir. Alfa'ya dokunulmaz (`aa` varsayılanı 1; opaklık AYRI bir `colorchannelmixer`'dır). |

ffmpeg zinciri (compiler çıktısı, `exposure=0.30, temperature=0.45, tint=-0.20,
contrast=0.15, brightness=0.05, saturation=0.20` — `ExportSnapshots/color-adjust.txt`
fixture'ının birebir aynısı; okunurluk için satırlara bölünmüştür, compiler tek satır yazar):

```
exposure=exposure=0.3:black=0,
lutrgb=r='clip(val+255*0.045,0,255)':b='clip(val-255*0.045,0,255)',
lutrgb=g='clip(val-255*(-0.02),0,255)',
lutrgb=r='clip((val-127.5)*1.15+127.5+12.75,0,255)'
      :g='clip((val-127.5)*1.15+127.5+12.75,0,255)'
      :b='clip((val-127.5)*1.15+127.5+12.75,0,255)',
colorchannelmixer=rr=1.15748:rg=-0.14304:rb=-0.01444:gr=-0.04252:gg=1.05696:gb=-0.01444
                 :br=-0.04252:bg=-0.14304:bb=1.18556
```

Notlar:

- `colortemperature` (Kelvin tabanlı) **kullanılmaz** — GLSL'de birebir eşi kurulamayan
  nonlineer eğri; yerine yukarıdaki sabit katsayılı lineer ofset normatiftir. `colorbalance`
  da (shadows/midtones/highlights nonlineer ağırlıklama) aynı gerekçeyle reddedildi;
  `lutrgb` lineer formülü **bit-yaklaşık** uygular.
- `lutrgb` 8-bit kanal üstünde çalışır → GPU float sonuçla en fazla ±1/255 kanal farkı;
  §9 ΔE eşiklerinin çok altındadır, kabul edilir.
- Tüm parametreler 0 ise compiler efekt filtresi **hiç üretmez**; shader da no-op'tur
  (uniform default 0 iken formüller kimliğe düşer — ayrı bypass yolu gerekmez ama filtre
  üretmemek export'u hızlandırır).

#### 4.1.1 `eq` NEDEN KULLANILMIYOR (sözleşme değişikliği — baş mimar kararı, M5)

Bu tablo daha önce contrast+brightness için `eq=contrast=<1+v>:brightness=<b>`, saturation
için `eq=saturation=<1+v>` diyordu ve gerekçe olarak "luma-afin dönüşüm RGB'de aynı afin
dönüşüme denktir" yazıyordu. **Bu gerekçe yanlıştır ve tablo koda göre düzeltilmiştir**
(önizleme + export zaten yukarıdaki RGB eşlemesini uyguluyordu; doküman sapmıştı).

`eq` contrast'ı YALNIZ luma düzlemine uygular, chroma'yı ayrıca `saturation` ile ölçekler;
kanal-başına afin op ile ancak `R=G=B` (nötr gri) piksellerde çakışır. Ölçüm (ffmpeg 8.0,
`format=rgba` zinciri, `contrast=+0.50, brightness=+0.05`):

```
kaynak (226,188,122)   →  §4.1 matematiği / GLSL / lutrgb : (255,231,132)
                          eq                              : (255,233,166)   |ΔB| = 34
kaynak ( 88,152,192)   →  §4.1 matematiği / GLSL / lutrgb : ( 81,177,237)
                          eq                              : (105,169,209)   |ΔR| = 24, |ΔB| = 28
```

Yani `eq` yolu §9.3'ün golden-frame eşiğini (ortalama ΔE2000 ≤ 2.0) kat kat aşar; "ffmpeg
sütunu"nu birebir uygulamak dokümanın KENDİ parity sözleşmesini bozardı. `lutrgb` eşlemesi
ise matematik sütununu **birebir** verir (yukarıdaki iki ölçümde 0 kod değeri fark).

Saturation'da sayısal fark küçüktür — aynı kaynakta (88,152,192), `v=+0.6` için matematik
sütunu (56,158,222) diyor; `colorchannelmixer` (57,159,223) verdi (≤1 kod değeri), `eq`
(58,162,222) verdi (≤4 kod değeri) — ama `eq` yine de kullanılmaz:
`eq` bir YUV filtresidir ve rgba zincirinin ORTASINA renk uzayı gidiş-dönüşü soktuğu
ölçülmüştür —

```
auto_scale_1: rgba → yuva444p     (Parsed_format_0 → Parsed_eq_1 arasına otomatik eklendi)
auto_scale_2: yuva444p → rgba     (Parsed_eq_1 → Parsed_format_2 arasına)
```

— bu da §6.3'ün "zincir ortasında renk uzayı değişimi YASAK" kuralının ta kendisidir. Aynı
ölçümde `format=rgba,lutrgb=…,colorchannelmixer=…,format=rgb24` zincirinde efekt filtrelerinin
ARASINA hiç `auto_scale` girmez (yalnız zincirin girişinde/çıkışında, yani beklenen yerde
vardır). İki gerekçe birlikte `eq`'yu eler.

Regresyon bekçileri: `ExportM5GoldenTests.ColorAdjust_MatchesTheNormativeStageFormulas_PerChannel`
(her aşama, gerçek render, referans hattı bu tablodur) ve
`ColorAdjust_Contrast_IsCloserToTheNormativeMathThanTheEqMappingWouldBe` (iki eşlemeyi AYNI
kare üstünde ölçer). Tablo tekrar `eq`'ya çevrilirse ikisi de kırmızıya döner.

### 4.2 `lut` — 3D LUT + intensity

Şema: `lut: { assetId, intensity: 0..1 }` (.cube dosyası asset olarak yüklenir).

Matematik (iki tarafta aynı): `out = mix(original, LUT(original), intensity)`.

**WebGL:** .cube dosyası 3D texture'a yüklenir (`LINEAR` filtre = **trilinear** interpolasyon):

```glsl
vec3 lutted = texture(uLut3D, c.rgb * uLutScale + uLutOffset).rgb;  // yarım-texel ofsetli
c.rgb = mix(c.rgb, lutted, uIntensity);
```

`uLutScale = (N-1)/N`, `uLutOffset = 1/(2N)` (N = LUT kenar boyutu) — texel merkezi
örneklemesi; bu ofset olmadan uç değerlerde kayma olur.

**ffmpeg:** interpolasyon GPU ile eşleşsin diye `interp=trilinear` (tetrahedral DEĞİL):

```
[src]split[o][t];
[t]lut3d=file=lut.cube:interp=trilinear[l];
[o][l]blend=all_expr='A*(1-0.75)+B*0.75'[out]      // 0.75 = intensity, InvariantCulture
```

`intensity = 1` ise `split/blend` atlanır, düz `lut3d` uygulanır.

---

## 5. Geçiş Semantiği

### 5.1 Adjacency modeli

Timeline dokümanında klipler **bitişiktir, overlap YOKTUR** (invaryant:
`clip[i].end <= clip[i+1].start`). Geçiş, kesim noktasına iliştirilmiş metadata'dır:
`Transition { type, durationUs: D }`. Timeline süreleri ve tüm sonraki kliplerin
pozisyonları geçişten **etkilenmez**.

### 5.2 D/2 handle türetmesi (export compiler)

Kesim noktası `T` (= A'nın timeline sonu = B'nin timeline başı). `D` proje frame grid'ine
snap edilir ve **çift frame sayısına** yuvarlanır (`D/2` tam frame olsun):

```
D_frames = 2 * max(1, roundHalfUp(frameFromUs(D) / 2))
D = usFromFrame(D_frames)
```

Compiler kaynak aralıklarını genişletir (source-domain, hız dahil):

```
A: sourceOut' = sourceOut + roundHalfUp((D/2) * A.speed.rate)
B: sourceIn'  = sourceIn  - roundHalfUp((D/2) * B.speed.rate)
```

**Handle invaryantı** (zod `superRefine` + compiler validasyonu, aynı formül):

```
sourceOut + roundHalfUp((D/2)*rateA) <= assetA.durationUs
sourceIn  - roundHalfUp((D/2)*rateB) >= 0
```

**Üst sınır invaryantı (NORMATİF, editör-düzeyi):** `D`, kesime komşu iki klipten
**kısasının timeline süresinin yarısını aşamaz**:

```
D * 2 <= min(A.timelineDurationUs, B.timelineDurationUs)
```

Gerekçe: geçiş penceresi kesimden `D/2` önce başlayıp `D/2` sonra bittiği için (§5.3),
bir klibin iki kenarındaki geçiş pencereleri klibin yarısından uzun geçişlerde üst üste
binebilir ve xfade zinciri tanımsız hale gelir; ayrıca klibin "geçişsiz" görünür orta
bölümü kalmalıdır (UX kararı). Bu kural kaynak payından (handle) bağımsız, **timeline-domain**
bir üst sınırdır; hem zod `superRefine` hem compiler aynı kuralı doğrular. İhlal görürse
compiler job'ı `failed` + `error_code=transition_handle` ile bitirir (sessiz kısaltma YOK).

**Simetri invaryantı (NORMATİF):** geçiş, kesimin İKİ tarafına da yazılır —
`A.transitionOut` ve `B.transitionIn` aynı kesimde **birlikte var olmalı ve derin-eşit
olmalıdır** (`type` + `durationUs`). Tek taraflı geçiş sözleşme ihlalidir.

**Yerleşim eşitliği invaryantı (NORMATİF):** geçişli bir kesimin **İKİ klibinin
`transform`'u EŞİT olmalıdır** — altı alanın hepsi: `x`, `y`, `scale`, `rotationDeg`,
`anchorX`, `anchorY`.

*Gerekçe.* `xfade` kesimin iki tarafını **TEK bir akışa katlar** ve iki girişin **aynı
boyutta** olmasını şart koşar; §5.3'ün offset matematiği de o tek birleşik akışın kendi
zamanında tanımlıdır. Farklı yerleşim = farklı boyutta iki giriş. Derleyici bunu sessizce
ortak bir kutuya oturtsaydı katman geçiş boyunca **kayardı** — sessiz düzeltme yerine
görünür hata (M4 dalga 1 denetiminin "1 px sessiz kayma" kararının aynısı).

*Transform eşitliği neden tam olarak yerleşim eşitliğidir.* Medya (video/görsel) klibinde
ölçek kutusunun tabanı **proje tuvalidir** (§2.2 `fit=contain`) — kaynağın kendi boyutu
hesaba girmez — dolayısıyla yerleşim yalnız transform'un fonksiyonudur. Doğal boyutunu
hesaba katan raster klipleri (metin/şekil/çıkartma) bu kuralın kapsamına giremez, çünkü
bir geçişin **tarafı olamazlar**: geçiş yalnız bitişik iki MEDYA klibi arasında kurulur.
Keyframe de farkı geri sızdıramaz — geçiş penceresindeki klipte görsel keyframe zaten
yasaktır (`transition-keyframes`), yani animasyonlu bir kanal bu iki klibin yerleşimini
ayıramaz.

*Zincir kuralı.* Geçiş bir **eşdeğerlik sınıfı** kurar: A—B geçişliyse ikisi, B—C de
geçişliyse üçü aynı yerleşimi paylaşır. Kural bu yüzden bir **engel değil bir YAYILIM**
olarak uygulanır: bir klibin yerleşimini yazan her işlem (transform yazma/sıfırlama **ve
geçiş EKLEME**) zincirin tamamını hizalar ve kullanıcıya bunu bildirir; kullanıcı komşuyu
elle düzeltmek zorunda kalmaz.

**Geçişten bağımsız geometri invaryantı (NORMATİF — çapa MERKEZDE).** Çapası merkezde olan
(`anchor = 0.5, 0.5`) bir katmanın **ekrandaki geometrisi**, kesiminde geçiş olup olmamasından
**BAĞIMSIZDIR**. Kullanıcı bir kesime geçiş ekleyip kaldırdığında katman **tek piksel**
oynamamalıdır. Editör çapa alanı sunmaz ve dokümana daima `0.5` yazar — yani bu koşul
**kullanıcının görebildiği her belgede** sağlanır.

> **İNVARYANT DÖNEN KATMANDA DA GEÇERLİDİR — bu tur öyle OLMADIĞI ölçüldü ve düzeltildi.**
>
> - **DÖNMEYEN katmanda: BAYT AYNI.** Gerçek ffmpeg 8.0 ile ölçüldü (1080p, pad'li ve pad'siz
>   iki hat aynı `P` ile render edilip kare kareye çıkarıldı): **5 kaynak aspect'i** (16:9, 4:3,
>   kare, 9:16, 3:4) × **2 rejim** (`ölçek 0.555` → kutu `1066×599` TEK, hedef pozitif; ve
>   `ölçek 1.005, x=0.0025` → kutu `1930×1085` TEK, hedef NEGATİF) = 10 vakanın **hepsinde**
>   farklı piksel sayısı **0**, merkez farkı `0.000`, aydınlanan sınır kutusu birebir aynı.
> - **DÖNEN katmanda: ÖNCE ayrışıyordu, ARTIK ayrışmıyor.** Ayrışmanın kaynağı konum değil
>   **rotate'in GİRİŞİYDİ**: kare ara tuvalin kenarı `2*ceil(hypot(iw,ih)/2)` ile GİRİŞTEN doğar;
>   pad'siz yolda giriş gerçek `scale` çıktısıdır (kaynağın aspect'ine bağlı), pad'li yolda kutuya
>   normalize edilmiş halidir. İki farklı giriş → iki farklı kare tuval → içerik farklı ızgaraya
>   oturur. Ölçüldü (16:9, `s=0.503`, `a=90`, 320×240 tuval): pad'siz `(114,39,205,200)`, pad'li
>   `(115,39,204,200)`.
>
>   **DÜZELTME:** dönen ve çapası merkezde olan katmanda kutuya normalize eden pad artık
>   **KESİM DURUMUNDAN BAĞIMSIZ** olarak üretilir (`ExportCompiler.BuildPlacementChain`). Böylece
>   `rotate`'in girişi her iki yolda da kutudur ve kare tuval **kaynağın aspect'inden bağımsız**
>   hale gelir. Nedeni kaldırır, sonucu telafi etmez.

*Bu invaryantı bugün CI'da koşan şey.* `GoldenFrameTests.AddingATransition_`
`DoesNotMoveTheLayerByASinglePixel` — **16 satır**: 8'i DÖNMEYEN (4 kaynak aspect'i × 2 rejim),
8'i DÖNEN — `a=90` dört aspect'te (birinci rejim) ve iki aspect'te (ikinci rejim), `a=30` iki
aspect'te. `a=90` interpolasyon üretmez (kenarlar kesindir), `a=30` üretir: kural yalnız dik
açılarda tutuyorsa yeterli olmazdı, o yüzden eğik açı da koşar. İddia sınır kutusu
**eşitliğidir** (merkez eşitliği değil), yani dış kenar rampası dahil. Dönen 8 satır bu turda
eklendi; öncesinde `rotationDeg` hiçbir satırda YAZILMIYORDU, yani invaryantın dönen yarısı
**üç tur boyunca hiç koşmamıştı** — ayrışma tam olarak orada yaşıyordu.

> **KAPSAM: çapası merkezde OLMAYAN dönen katman DIŞARIDADIR.** §2.5'in çapa telafisi pad'i
> GERÇEK görüntü boyutuna oranlanır (`iw*2*mx`); normalize önce yapılırsa `iw` kutu boyutu olur ve
> çapa, görüntü içindeki oranından kayar. Aynı gerekçeyle o katman zaten **bölünemez**
> (`transition-rotated-anchor` kapısı onu 422 ile reddeder) — yani karşılaştırılacak bir pad'li
> yolu da yoktur. Editör çapa alanı sunmadığı için bu rejim kullanıcıdan ULAŞILAMAZ.

> Bu invaryant **EXPORT İÇİDİR**: aynı belgenin iki derleme yolu (pad'li ve pad'siz) aynı
> pikselleri boyamalıdır. §2.5'in **uzaysal toleransı** ise önizleme ↔ export arasındadır ve
> ayrı bir sorudur; ikisi karıştırılmamalıdır.
>
> **DÜZELTME (ölçüldü).** Bu satır bir tur önce "konum kırpması her iki yolda AYNI `P`'den
> doğduğu için invaryantı bozmaz" diyordu; **yanlıştı** ve gerçek ffmpeg ölçümüyle yanlışlandı.
> İki yol aynı `P`'yi kullanır ama kırpılan **ifade** farklıdır: pad'li yolda `P − nb/2`, pad'siz
> yolda `P − w/2`. `nb > w` olduğunda pad'li ifade **negatife** düşebilir ve overlay'in kendi
> `(int)`'i sıfıra doğru kırptığı için iki yol 1 px ayrışırdı. Ölçüldü (1080p, ölçek `1.005`,
> `x=0.0025`): 16:9 / 4:3 / kare / 9:16 / 3:4 — **beşi de** ayrıştı. Çözüm ifadeye `floor`
> yazmaktır (§2.5 adım 4); `floor` altında `(nb − w)/2` tam sayı olduğu için iki ifade
> **özdeşleşir** ve invaryant aritmetik olarak sağlanır.

> **BU KURAL DEĞİŞİKLİĞİNİN GERİYE DÖNÜK BEDELİ (ölçüldü, kayda geçsin).** Aynı belge eski
> kuralla (overlay'de `floor` YOK + rotate tuvali ham `hypot` + pad hedefi HAM kutu) ve yeni
> kuralla render edilip karşılaştırıldı; **DÖNEN katmanın** pad'li (birleşen run) yolunda çıktı
> kayıyor. Ölçüm (gerçek ffmpeg 8.0, 1080p, 16:9 kaynak, ölçek `0.555` → kutu `1066×599`,
> `P = (964.992, 540)`, katmanın parlaklık ağırlık merkezi; eski → yeni fark):
>
> ```
> a=  0   (−0.376, +0.498)      a= 45   (−1.434, +0.347)
> a= 15   (−0.845, +0.786)      a= 90   (−1.498, −0.376)
> a= 30   (−1.167, +0.653)
> ```
>
> Yani sınıf **≤ 1.5 px / eksen**tir ve tek yönlü değildir. Doğru yorum: kayan taraf ESKİ
> kuraldır — yeni kural `a=0` ve `a=90`'da tam olarak `floor(P) = (964, 540)`'a oturuyor
> (`964.000/539.998` ve `964.002/540.000`), eski kural `0.38`–`1.50` px uzağında duruyordu.
> Bu sınıf HEAD'te de vardı (dönen katman + pad'li yol her zaman mümkündü); bu turda **KÜMESİ
> GENİŞLEDİ**, çünkü kutu paritesi kapısının kalkması TEK kutulu bitişik klipleri de birleşen
> (pad'li) yola soktu — yani aynı belge artık daha sık bu yoldan geçiyor. Snapshot/golden
> tarafında bu, "aynı belge HEAD'e göre birkaç piksel farklı" olarak görünür ve **beklenen**
> davranıştır.

*Neden ayrı bir kural.* Geçiş, run'ın bölünmesini **YASAKLAR** (kesim tek `xfade` akışında
katlanır) ve bu yüzden segmentleri kutuya normalize eden pad'i **ZORUNLU** kılar. İki yol aynı
pikselleri boyamak zorundadır — pad hedefi §2.5'in `Box & ~1` kuralına, overlay hedefi de §2.5
adım 4'ün `floor`'una uyduğu sürece uyar. Gerçek ffmpeg render'ıyla ölçüldü: **dört kaynak
aspect'i** (16:9, 4:3, kare, 9:16) × **iki rejim** — `(ölçek 0.503, x=0)` yani kutu TEK ama
overlay hedefi pozitif, ve `(ölçek 1.005, x=0.0025)` yani overlay hedefi NEGATİF. Ayrışma yalnız
ikinci rejimde doğar ve orada da yalnız katmanın yatayda tuvale sığdığı iki aspect'te GÖRÜNÜR
olur.

**PAD'İN NE ZAMAN ÜRETİLDİĞİ (NORMATİF — bu turda değişti).** Kutuya normalize eden pad iki
sebepten BİRİ yeterlidir:

1. **run BÖLÜNDÜ** (geçiş/birleşen bitişik klipler) — `concat`/`xfade` girişleri aynı boyutta
   olmalıdır; **ya da**
2. **katman DÖNÜYOR ve çapası merkezde** — kesimde geçiş olsun olmasın. Sebep yukarıdaki
   düzeltmedir: `rotate`'in kare tuvali GİRİŞİNDEN doğduğu için girişin iki yolda da aynı olması
   gerekir.

Yani **dönmeyen** tek klip hâlâ pad'siz yoldan geçer (tek katmanlı belgelerin filtre grafikleri
bayt bayt korunur), **dönen** tek klip ise artık pad kazanır. Bunu koşan iddia yukarıdaki testin
son satırındadır: pad'in varlığı `rotationDeg != 0` ile birebir eşitlenir.

*Koşulun NEDEN koşul olduğu (merkez dışı çapa).* Merkez dışı çapada pad ofseti simetrik değildir,
`(ow-iw) * anchor` ile **oransal** yazılır ki §2.5'in "çapa görüntünün kendi kutusundaki
oranındadır" kuralı korunsun. O halde pad'li yolda katmanın kenarı **iki** bağımsız tamsayı
kırpmasından geçer (`pad` ofseti ve `overlay` ifadesi), pad'siz yolda **bir** — `floor` yalnız
ikincisini tekilleştirir, pad ofsetinin kendi kırpmasını kaldırmaz. İki kırpma aynı yöne
toplandığında ≤ 1 px ayrışma doğar. Bu ayrışma **editörden ULAŞILAMAZ** (editör çapa alanı sunmaz
ve dokümana daima `0.5` yazar) ve **ÖLÇÜLMEMİŞTİR**; invaryant bu yüzden merkez çapayla
koşullandırılmıştır — kanıtlanandan fazlasını iddia etmemek için. **Merkez dışı çapa KAPSAM
DIŞIDIR:** desteklenirse bu satır önce **ölçülmeli**, sonra genişletilmelidir.

*Dejenere rejim bu invaryantın kapsamı DIŞINDADIR.* Orada geçişsiz yol (pad yok) ile geçişli yol
(pad zorunlu) farklı sonuçlar üretirdi — biri sessizce yanlış çizer, diğeri `-22` ile ölür. §2.5'in
dejenerelik önkoşulu tam da bu yüzden bir **kapıdır**: o rejimdeki belge **iki yolda da** aynı
tipli hatayla (`degenerate-layer`) reddedilir, dolayısıyla "geometri geçişten bağımsızdır"
invaryantı orada da **ihlal edilmez** — belge hiç render edilmez.

*Bunun bir sonucu:* geometriyi geçişe uydurmak için **ölçeği nicelemek YASAKTIR**. Ölçeği
"geçişe uygun" bir ızgaraya çekmek, geçiş eklendiğinde görüntüyü zıplatır (üstelik yerleşim
eşitliği yüzünden **komşu klibi de** zıplatır) ve geçiş kaldırılınca geri gelmez — asimetrik ve
kayıplı. Kutu paritesi de bu yüzden bir kabul kapısı **değildir**.

*Nerede uygulanır (bilgilendirici).* Doküman değişmezi: `packages/timeline-schema` →
`invariants.ts` `checkTransitionPlacement` (DEV doküman kapısı her `commit`'te koşar).
Editör: `state/timelineOps.ts` → `propagateTransformToChain` (yerleşim yazan op'lar) ve
`alignTransitionChainTransforms` (geçiş uzlaştırma pass'i — kesim YARATAN düzenlemeler de
buradan geçer). Derleyici: `ExportCompiler.EnsureTransitionPlacement` — kural artık
**`Validate`** aşamasındadır, yani API'nin ön kapısı onu **GÖRÜR** ve ham API'ye doğrudan
yazılmış bir belge de 202 değil **senkron 422** alır. Buraya taşınabilmesinin nedeni hesabın
saf doküman aritmetiği olmasıdır: `LayerGeometry.Compute` yalnız transform + proje tuvali
okur, kaynak dosyasına dokunmaz. `Compile`'daki eski dal (`open.Placement != placement`)
KALDIRILMADI — aynı fabrika metodunu çağıran ucuz bir sigortadır ve iki kapının mesajı
bayt-aynıdır (testle sabitlendi). Ayrıntı: `docs/poc-bilinen-sinirlar.md` §3.

### 5.3 xfade offset matematiği

Zincirdeki klip `i`'nin timeline süresi `d_i`, klip `i` ile `i+1` arasındaki geçiş `D_i`
(geçiş yoksa `D_i = 0`). Genişletilmiş segment süresi:

```
e_i = d_i + D_{i-1}/2 + D_i/2        // D_0 = D_N = 0
```

Kümülatif offset (xfade `offset`'i birleşik akışın kendi zamanındadır):

```
offset_0 = 0
offset_i = offset_{i-1} + e_i - D_i
```

Kapalı form (doğrulama için): `offset_i = (Σ_{j<=i} d_j) - D_i/2` — yani geçiş, timeline'daki
kesim noktasından **D/2 önce** başlar, D/2 sonra biter. Birleşik akışın toplam süresi
`Σ d_i`'ye eşit kalır → **sonraki kliplerin timeline pozisyonları kaymaz** (adjacency
modelinin bütün amacı budur).

Önizleme aynı pencereyi uygular: `[T - D/2, T + D/2)` aralığında A ve B birlikte decode
edilir, karışım oranı `p = (t - (T - D/2)) / D` lineerdir (xfade `fade` ile aynı).

**Önizleme geçişleri (NORMATİF, M4 dalga 2'de uygulandı).** Pencere, ilerleme ve kaynak
zamanı kuralları önizlemede de bağlayıcıdır:

- Pencere **yarı açıktır**: `t ∈ [T - D/2, T + D/2)`. Kliplerin etkinlik aralığıyla aynı
  uç kuralı (§1) — kapanış anında yalnız B görünür.
- Pencere boyunca **iki klip de canlıdır**: `resolveVisualStack` o track için İKİ klip
  döndürür (A önce), `computeSlotRequests` ikisini de `priority 0` yapar (geçiş çifti her
  preload'ı yener) ve iki `<video>` elemanı da OYNAMAYA devam eder.
- Her iki taraf da **handle malzemesi** okur: kaynak zamanı `[sourceIn, sourceOut]`
  dışına, tam olarak `roundHalfUp((D/2)*rate)` kadar taşabilir — export compiler'ın
  genişlettiği aralığın aynısı. Kelepçelenmiş (donmuş) bir kare ile yapılan geçiş
  sözleşme ihlalidir.
- Ses (§5.4): `[T - D/2, T + D/2]` boyunca A'nın kazancı lineer olarak 1→0, B'ninki 0→1
  gider; toplam her an 1'dir. Geçişli kenarda §8.4'ün 5 ms mikro-fade'i **uygulanmaz**
  (rampanın kendisi zaten fade'dir; içine 5 ms'lik çentik koymak duyulur).
- Karışım **tek geçişte** (tek shader pass, iki sampler) yapılır: wipe/dissolve piksel
  başına KAYNAK SEÇER, alpha karışımı değildir; iki ayrı çizimle taklit edilemez.

**Önizleme yaklaşıklıkları (kapsam beyanı).** Aşağıdaki noktalarda önizleme, ffmpeg
xfade'in birebir aynısı DEĞİLDİR; hepsi bilinçli ve `docs/backlog.md`'de izlenir:

| Tip | Önizleme | ffmpeg xfade | Fark |
|---|---|---|---|
| `crossfade` | `mix(A, B, p)` (straight-alpha, premultiply→mix→unpremultiply) | `fade` | yok (aynı lineer ağırlık) |
| `dissolve` | piksel başına hash eşiği `hash(uv) < p ? B : A` | `dissolve` | eşik **deseni** farklı (PRNG farkı); istatistiksel davranış aynı |
| `fadeToBlack` | parça parça lineer: `p<0.5` → `A*(1-2p)`, `p>=0.5` → `B*(2p-1)` | `fadeblack` | ffmpeg kenarlarda `smoothstep` yumuşatması kullanır; önizleme lineerdir |
| `wipeLeft` / `wipeRight` | kenar `x = 1-p` / `x = p` (sert kenar) | `wipeleft` / `wiperight` | yok (aynı kenar konumu) |
| `slideUp` | iki görüntü de `p` kadar yukarı kayar, örnekleme noktası ötelenir | `slideup` | yok (aynı öteleme) |

Ayrıca: geçiş pass'i tam kare bir dörtgen çizip her iki tarafı KENDİ yerleşim matrisinin
tersiyle örneklediği için, karenin dışında kalan pikseller keskin kenarlıdır (normal
çizim yolunda kenarı geometri verir). Tam kare kaplayan kliplerde farkı yoktur; küçük
(ölçeklenmiş/döndürülmüş) bir katmanın geçişinde kenar hafif tırtıklı görünebilir.

Tip eşlemesi:

| Şema `TransitionType` | ffmpeg `xfade=transition=` |
|---|---|
| `crossfade` | `fade` |
| `fadeToBlack` | `fadeblack` |
| `wipeLeft` | `wipeleft` |
| `wipeRight` | `wiperight` |
| `slideUp` | `slideup` |
| `dissolve` | `dissolve` |

### 5.4 Ses: acrossfade eşleşmesi

`acrossfade=d=<D>` (offset parametresi yoktur; A'nın son D'si ile B'nin ilk D'sini otomatik
bindirir). Ses segmentleri videoyla **aynı D/2 handle genişletmesini** aldığı için bindirme
penceresi video xfade'iyle örtüşür; toplam ses süresi de `Σ d_i` kalır → A/V senkron.
Eğri: `c1=tri:c2=tri` (lineer, §8.2 ile tutarlı).

### 5.5 Handle yetersizse editör davranışı (NORMATİF)

Kaynakta yeterli pay yoksa editör geçişi **kısaltır**:

```
avail_A = assetA.durationUs - sourceOut          // A'nın kuyruk payı (source-domain)
avail_B = sourceIn                               // B'nin baş payı
D_max   = 2 * min(avail_A / rateA, avail_B / rateB)   // timeline-domain
D_eff   = evenFrameSnap(min(D, D_max))           // §5.2'deki çift-frame snap
```

- `D_eff >= 2 frame` ise geçiş `D_eff` ile uygulanır ve şemaya `D_eff` yazılır
  (UI kullanıcıya "geçiş kısaltıldı" bildirir).
- `D_eff < 2 frame` ise geçiş **reddedilir/kaldırılır** (metadata yazılmaz).
- Compiler aynı invaryantı doğrular; ihlal görürse job `failed` + `error_code=transition_handle`
  (editör kaçırdıysa sessiz düzeltme YOK — sözleşme ihlali görünür olmalı).

---

## 6. Renk Hattı

### 6.1 BT.709 varsayımı ve çıkış tag'leri

- Ingest'te ffprobe renk metadata'sı (`color_primaries/transfer/space/range`) `probe.json`'a
  kaydedilir. **Untagged SDR kaynak BT.709 / tv (limited) range varsayılır** (çözünürlükten
  bağımsız tek kural — MVP'de BT.601 tahmini yapılmaz; SD kaynaklar nadir ve tahmin
  tutarsızlık üretir).
- Export çıktısı **daima açıkça tag'lenir**:

```
-color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv
```

- Proxy da aynı varsayımla üretilir; tarayıcı ve ffmpeg aynı yorumu yapar.

### 6.2 HDR tespiti ve tonemap zinciri (proxy ve export'ta ÖZDEŞ)

Tespit: `color_trc ∈ {smpte2084, arib-std-b67}` **veya** `color_primaries = bt2020`.
Tespit edilirse aşağıdaki zincir uygulanır; bu string `VideoEdit.Media` içinde **tek sabit**
(`ColorChain.HdrToSdr`) olarak yaşar ve proxy üreticisi ile export compiler **aynı sabiti**
kullanır — kopyalanmaz, parametreleştirilmez:

```
zscale=t=linear:npl=100,format=gbrpf32le,tonemap=tonemap=hable:desat=0,
zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p
```

Önizleme proxy'den çalıştığı için tarayıcı hiçbir zaman HDR görmez; export aynı zincirden
geçtiği için "preview'de gördüğün SDR = export'taki SDR". HLG/PQ ayrımını `zscale` girişteki
transfer tag'inden otomatik alır; untagged-ama-BT.2020 kaynakta compiler `tin=` parametresini
probe değerinden ekler (proxy üreticisi de aynı mantıkla — ortak kod).

### 6.3 Alpha kompozisyon kuralı

- Kompozisyon **non-linear sRGB değerler üstünde, straight (unassociated) alpha** ile yapılır
  (tarayıcı davranışı). Normatif blend denklemi:

```
out.rgb = src.rgb * src.a + dst.rgb * (1 - src.a)
out.a   = src.a + dst.a * (1 - src.a)
```

- **Kompozisyon renk modu GRAFİK BAŞINADIR, katman başına DEĞİL (NORMATİF).** Bir grafikteki
  taban tuval ve TÜM katmanlar `format=rgba` ile girer, **her** overlay `:format=rgb` ile blend
  eder. `format=auto`/yuv420 blend **YASAK**. Gerekçe iki ölçülmüş hatadır (M4 dalga 1 denetimi):
  1. **Zincir ortasında renk uzayı değişimi.** Katman başına seçildiğinde alpha'lı katmanın
     overlay'i RGB'de, üstündeki opak katmanın overlay'i 4:2:0'da çalışır; ffmpeg birikmiş RGB
     kompozisyonu araya sıkışan dönüşümle yuv'a çevirir ve **alttaki katmanların renkleri kayar**.
     Gerçek render ölçümü: üstteki katmanın *örtmediği* bölgede MSE 89.07 (doygun renklerde 24
     birim); grafik başına RGB modunda aynı ölçüm 0.05.
  2. **Konum kuantalanması.** 4:2:0 tuval tek piksellik overlay konumunu temsil edemez
     (`normalize_xy`, §2.5): opak katman çift piksele snap olur, alpha'lı katman olmaz → *aynı*
     transform opaklığa göre 1 px farklı yere oturur. Alt örneklemesiz tuval bunu kaldırır.

     **ÖLÇÜLMÜŞ KANIT (gerçek ffmpeg 8.0; bu satırı koşan test
     `GoldenFrameTests.CompositingInRgb_IsWhatKeepsOddOverlayPositionsFromSnapping`).**
     `320×240` taban + `64×48` katman, ürünün kendi zinciri, tek fark overlay'in son parçası:

     | overlay | `x = 11` | `x = 10` | `x = −11` | `x = −12` |
     |---|---|---|---|---|
     | `format=auto` (varsayılan) | sol kenar **10** | 10 | sağ kenar **51** | 51 |
     | `:format=rgb` | sol kenar **11** | 10 | sağ kenar **52** | 51 |

     Okunuşu: `auto` kolunda TEK konum en yakın ÇİFTE **aşağı** iniyor (`11 → 10`, `−11 → −12`);
     yön `floor`'dur, sıfıra doğru DEĞİL. `:format=rgb` ile kırpma yok. ÇİFT konumlarda (`10`,
     `−12`) iki kol AYNI kutuyu verir — yani fark tam olarak ve yalnızca tek-konum
     nicelemesidir, genel bir geometri farkı değil. Aynı davranış `y` ekseninde de ölçüldü
     (`yuv420`'de `vsub` de 1'dir).

     **`format=rgba` tek başına YETMEZ — yükü taşıyan parça overlay'in kendi seçeneğidir.**
     Ölçüldü: taban ve katman `format=rgba` ile girse bile overlay'in `format=auto` pazarlığı
     `yuva420p`'ye iniyor (ffmpeg'in kendi satırı: `main … fmt:yuva420p overlay … fmt:yuva420p`)
     ve niceleme aynen oluşuyor; `:format=rgb` ile pazarlık `rgba`'da kalıyor. Bu yüzden kural
     "zincirde bir yerde rgba olsun" değil, **her overlay `:format=rgb` taşısın**dır.

  Bedeli ölçüldü ve kabul edildi: 1080p/150 kare/2 katman filtre hattı ~0.86 s → ~1.20 s.
  "Hızlı yol" (yalnız alpha varken RGB'ye geçmek) doğru sonucu üretemez, çünkü 2. madde
  alpha'dan bağımsızdır.
- **Kaynak renk beyanı dönüşümden ÖNCE gelir.** §6.1'in "untagged SDR = BT.709/tv" varsayımı,
  katman zincirinin BAŞINDA (`setparams=colorspace=bt709:...:range=tv`) beyan edilmelidir.
  Sonra beyan etmek pikselleri değiştirmez, yalnız etiketi düzeltir: RGB'ye geçişi swscale kendi
  varsayılanıyla (SD çözünürlükte BT.601) yapar ve kompozisyon renkleri kayar (ölçüm: 68 birime
  varan sapma). Varsayımın **hesaba girmesi** bu beyanla sağlanır.
- Klip `opacity`'si (statik veya keyframe'li) `src.a` çarpanıdır: `src.a *= opacity`.
  ffmpeg'de `format=rgba,colorchannelmixer=aa=<opacity>` (statik) veya fade/sendcmd (animasyonlu,
  design 04 §2.5).

### 6.4 Premultiplied alpha uyarısı

- PNG **daima straight alpha** taşır; SkiaSharp surface'tan encode ederken `Unpremul`
  kullanılması ZORUNLUDUR (Skia içte premultiplied çalışır — direkt encode koyu kenar
  halkası üretir).
- WebGL'de `texImage2D` öncesi `UNPACK_PREMULTIPLY_ALPHA_WEBGL = false` ve context
  `premultipliedAlpha: false`; blend fonksiyonu `gl.blendFuncSeparate(SRC_ALPHA,
  ONE_MINUS_SRC_ALPHA, ONE, ONE_MINUS_SRC_ALPHA)` (straight alpha karşılığı).
- Belirti sözlüğü: koyu/siyah kenar halkası = premultiply çift uygulanmış; açık hale =
  premultiply hiç uygulanmamış blend'e premultiplied veri girmiş. İkisi de sözleşme ihlalidir.

---

## 7. Metin (ve Sticker/Şekil Rasterleri)

- **Layout'un tek doğruluk kaynağı SkiaSharp'tır (bağlayıcı):** satır kırma, hizalama,
  shaping (HarfBuzz), emoji, RTL — hepsi sunucuda ölçülür; sonuç `{ lines[], bboxPx }`
  türev olarak saklanır. Frontend bu bbox'ı yerleşim/gizmo/çarpışma için kullanır.
- **Client canlı raster GEÇİCİDİR:** metin düzenlenirken anlık UX için Canvas2D raster
  gösterilir; idle/kayıt anında sunucudan SkiaSharp PNG + bbox çekilir ve önizleme
  texture'ı onunla **değiştirilir**. Export **daima** SkiaSharp çıktısını kullanır.
  Canvas raster hiçbir zaman export'a girmez; SkiaSharp bbox ile Canvas ölçümü çelişirse
  SkiaSharp kazanır.
- **`fontId` manifest sözleşmesi:** şemada `fontFamily` serbest string YOKTUR; `fontId`
  vardır. Manifest (R2'de, sürümlü):

```json
{
  "fonts": {
    "inter": {
      "family": "Inter", "version": "4.0",
      "files": { "400": "fonts/inter-4.0/Inter-Regular.ttf",
                 "700": "fonts/inter-4.0/Inter-Bold.ttf" },
      "sha256": { "400": "…", "700": "…" }
    }
  }
}
```

  Aynı TTF dosyası hem tarayıcı `@font-face`'ine hem SkiaSharp'a gider. **Sürüm pinlidir**:
  font güncellemesi yeni `fontId` sürümü üretir; mevcut projeler eski dosyayı kullanmaya
  devam eder (eski projelerin layout'u değişmez). Küratörlü set OFL lisanslıdır.
- **@2x raster kuralı:** PNG, proje çıktı çözünürlüğündeki bbox boyutunun **2 katında**
  rasterize edilir (`rasterPx = bboxPx * 2`) ve kompozisyona `0.5` ek çarpanla çizilir.
  Böylece `scale <= 2` aralığında upsample bulanıklığı olmaz. `scale > 2` beklenen klipler
  için compiler raster çarpanını `ceil(scale)`'e yükseltebilir (aynı kural iki tarafta).
  Statik klip başına **tek** PNG üretilir; pozisyon/ölçek/rotasyon/opaklık animasyonları
  bu bitmap'e §2 transformlarıyla uygulanır — **aynı bitmap'i transform etmek = garanti
  parity** (drawtext hiçbir yerde kullanılmaz).

---

## 8. Ses

### 8.1 Lineer gain

- UI `volume ∈ [0..2]` **lineer genlik çarpanıdır** (dB değil). `1 = dokunulmamış`,
  `2 = +6.02 dB`.
- ffmpeg: `volume=<v>` (lineer mod). WebAudio: `gainNode.gain.value = v`. Keyframe'li
  volume §3 kurallarıyla interpole edilir; WebAudio'da `setValueCurveAtTime` ile örneklenmiş
  eğri, ffmpeg'de `volume` sendcmd örneklemesi (§3.4) — örnekleme yine proje fps'inde.
- Ses zincirinde komut filtresi **`asendcmd`**'dir (`sendcmd` VİDEO medya tipidir; ses
  zincirine konursa grafik "Media type mismatch" ile kurulmadan düşer). Filtre örneği
  `volume@<tag>` ile etiketlenir ve komut AYNI LİNEER ZİNCİRDEDİR — çok girişli filtrelerdeki
  framesync gecikmesi (§3.4 notu) burada yoktur.
- **Zaman çözünürlüğü beyanı:** ffmpeg komutu SES KARESİ sınırında uygular (1024 örnek =
  21.3 ms @48 kHz), §3.4 örneği ise proje karesindedir (30 fps'te 33.3 ms). Bu ikisinin
  birleşimi export'taki gain eğrisini preview'a göre en fazla ~50 ms geciktirir (ölçüldü).
  Preview `setValueCurveAtTime` ile örnek-kesindir; fark bir gain RAMPASINDA duyulamaz ve
  kabul edilmiş asimetridir (§8.3'teki limiter asimetrisinin kardeşi).

### 8.2 Fade eğrisi

- Fade-in/out eğrisi **lineerdir**: `g(t) = t / D` (in), `g(t) = 1 - t/D` (out).
- ffmpeg: `afade=t=in:st=<S>:d=<D>:curve=tri` (`tri` = lineer; default'a güvenilmez, açıkça
  yazılır). WebAudio: `linearRampToValueAtTime`.
- Geçişlerdeki `acrossfade` de `c1=tri:c2=tri` (§5.4).

### 8.3 Miks

- Her klip zinciri (NORMATİF sıra, compiler çıktısıyla birebir):

  ```
  [atempo …]                     hız (0.5–100 dışı katlanır); zincirin EN BAŞI
  [adelay=<C>:all=1]             atempo WSOLA telafisi (aşağı bkz.)
  [atrim=start:end]              yalnız geçiş payı kırpılacaksa
  asetpts=PTS-STARTPTS
  aformat=fltp/stereo/48000
  apad, atrim=end=<pencere>      UZUNLUK KİLİDİ
  volume=<v>  |  asendcmd + volume@tag        (§8.1)
  [afade in] [afade out]         §8.2
  [5 ms micro-fade in/out]       §8.4
  ```

  ardından GRUP seviyesinde `[acrossfade …]` (§5.4) ve timeline ofseti için `adelay=<start>`.
- **Uzunluk kilidi (`apad` + `atrim=end`) ZORUNLUDUR.** Ses akışı, klibin sözleşme
  penceresine (`headIn + süre + headOut`) sabitlenir. Gerekçe ölçüm: `atempo` zinciri akıştan
  pay yutuyor — 8 sn kaynakta rate 2/4/0.5/0.25 için sırasıyla **10.7 / 16.0 / 53.3 / 160.0 ms
  eksik** akış ölçüldü (ffmpeg 8.0). Kaynağın ses stream'i videosundan kısa bittiğinde de aynı
  boşluk oluşur. `apad` eksiği sessizlikle doldurur, `atrim` fazlayı kırpar ve EOF verir.
- **atempo telafisi `C = round(8.43/rate + 1.12)` ms.** atempo WSOLA'dır ve akışın BAŞINDAN
  sabit bir pay yutar, yani ses timeline'da ERKENE kayar. Kapılanmış burst kaynağıyla ölçülen
  en büyük sapma (patlama enerji merkezi), telafi ÖNCESİ → SONRASI:
  `rate 2: 8.7 → 3.7 ms`, `rate 4: 7.0 → 4.0 ms`, `rate 0.5: 18.8 → 1.6 ms`,
  `rate 0.25: 46.5 → 11.5 ms`. Sözleşme tavanı **bir çıkış karesi**dir (30 fps → 33.3 ms);
  telafisiz hâlde rate 0.25 bunu 1.4 kare aşıyordu. Katsayılar AMPİRİKTİR (kapalı formu yok,
  tempo taraması 0.5–8 aralığında ±1 ms içinde oturur) ve `ExportM5GoldenTests`
  `.Speed_PutsAudioOnTheTimeline_MeasuredStreamLengthAndBurstPositions` testine bağlıdır —
  ffmpeg davranışı değişirse sabit sessizce bayatlamaz, test kırmızıya döner.
- **`amix=inputs=N:duration=longest:normalize=0`** — `normalize=0` zorunludur (default her
  girişi 1/N zayıflatır: "müzik ekleyince konuşma kısıldı" bug'ı).
- Çıkışta `alimiter=limit=0.98`. Preview'de Web Audio zinciri sonuna `DynamicsCompressorNode`
  KONMAZ — limiter yalnız export'ta clipping sigortasıdır; preview'de clipping duyulması
  kullanıcıya doğru sinyaldir (kabul edilmiş asimetri, tek istisna).

### 8.4 Micro-fade (kesim tıklaması önleme) — 5 ms kuralı

- Sıfırdan/sıfıra inmeyen her **sert kesim sınırında** 5 ms (`= 240 sample @48 kHz`) lineer
  micro-fade uygulanır: klip başında fade-in, sonunda fade-out (kullanıcının açık fade'i
  varsa micro-fade o kenarda atlanır — açık fade zaten sıfıra iner).
- **İki tarafta da uygulanır** (preview Web Audio + export `afade=d=0.005`), yoksa export'ta
  tıklama sesi preview'den farklı olurdu.
- **İstisna — seamless splice:** aynı track'te ardışık iki klip aynı asset'in kaynağında tam
  bitişik devamıysa (`B.sourceIn == A.sourceOut`, aynı `speed.rate`, timeline'da boşluksuz)
  ortak kenarda micro-fade uygulanmaz (split edilmiş klipte ses çukuru olmasın).

### 8.5 Format normalizasyonu

Her ses zinciri miks öncesi normalize edilir (iki taraf aynı hedef):

```
aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates=48000
```

- Preview `AudioContext({ sampleRate: 48000 })` ile açılır; mono kaynaklar stereo'ya
  upmix edilir (her iki kanala aynı sinyal — ffmpeg `aformat` davranışıyla aynı).
- Export ses çıkışı AAC 48 kHz stereo.

---

## 9. Doğrulama: Golden-Frame Test Protokolü

### 9.1 Düzenek

- Sabit test asset'leri: küçük (ör. 640×360) sentetik klipler — SMPTE bar, gradyan,
  hareketli marker (frame numarası gömülü), alpha'lı PNG, metin klibi. Proxy == kaynak
  çözünürlüğü seçilir ki proxy keskinlik farkı ölçümü kirletmesin.
- Her test timeline'ı için: (1) export path'ten frame çıkarımı
  `-vf "select=eq(n\,K)" -frames:v 1 -f image2`; (2) Playwright, preview player'ı frame `K`'ya
  `seekToFrame(K)` API'siyle götürüp kompozitör canvas'ının screenshot'ını alır
  (`preserveDrawingBuffer` test build'inde açık); (3) iki görüntü aynı boyuta getirilip
  (export karesi preview tuval boyutuna `bicubic` downscale) karşılaştırılır.
- ±1 frame toleransı (§1.7): preview screenshot'ı export'un `{K-1, K, K+1}` kareleriyle
  karşılaştırılır, **en iyi skor** alınır; rapora hangi kaymanın kazandığı yazılır
  (sistematik +1 kayması ayrıca alarm üretir).

### 9.2 Hangi frame'ler

Her test timeline'ında zorunlu örnekleme noktaları:

| Nokta | Amaç |
|---|---|
| `n = 0` ve son frame | Uç sınırlar, süre formülü |
| Her klibin orta frame'i | Transform/fit/renk taban doğruluğu |
| Her kesimin `n_cut - 1` ve `n_cut` | Kesim hizası (off-by-one avcısı) |
| Her geçişin başlangıcı, tam ortası (`offset + D/2`), sonu | xfade/karışım eğrisi |
| Keyframe animasyonlarında segment ortaları + her keyframe anı | Easing/interpolasyon |
| Efektli kliplerde 1 orta frame (efekt açık) + aynı frame efekt kapalı referans | colorAdjust/lut formülleri |

### 9.3 Eşikler (öneri — CI'da sabitlenir)

| Metrik | Statik/efekt frame'leri | Geçiş/animasyon frame'leri |
|---|---|---|
| SSIM (gri, global) | ≥ 0.98 | ≥ 0.95 |
| Ortalama ΔE2000 | ≤ 2.0 | ≤ 3.0 |
| 95. yüzdelik ΔE2000 | ≤ 5.0 | ≤ 8.0 |
| Katman **çapası/merkezi** (px) — DÖNMEYEN, ya da dönme 90°'nin katı | **`P` tamsayıysa 0; değilse `P − floor(P)`, ±0.5 px pay** | aynı |
| Katman **çapası/merkezi** (px) — dönme 90°'nin katı DEĞİL | yukarıdakinin üstüne **+1 px kenar-rampası payı** (aşağıdaki üçüncü madde) | aynı |
| Katman **kenarı** (px, her eksen) | ≤ 2 (kenar başına; `frac(P)` + boyut nicelemesi) | ≤ 2 |

Son ÜÇ satır §2.5'in **uzaysal tolerans** beyanının test karşılığıdır ve o bölümün ölçümlerine
birebir dayanır:

- **Merkez bir "tolerans" değil, HESAPLANABİLİR bir ofsettir.** Beklenen değer `floor(P)`'dir
  (derleyici overlay hedefini ifadenin içinde `floor`'lar, §2.5 adım 4); önizleme `P`'ye çizer.
  Golden karşılaştırma bu yüzden merkezi `P` ile değil **`floor(P)`** ile sınar. `P` tamsayı
  olduğunda fark sıfırdır — ölçüldü. Kural `floor`'dur, `trunc` DEĞİL: ikisi yalnız hedef
  negatifken ayrışır (ölçek > 1) ve orada `trunc` sapmanın işaretini ters çevirirdi.
- **"`frac(P)`'den farklı her sapma HATADIR" cümlesi KOŞULLUDUR (ölçümle daraltıldı).** Bir tur
  önce burada koşulsuz yazıyordu; **ara dönme açılarında yanlıştır**. Kural şu ikisinde geçerlidir
  ve orada gerçekten sapmasızdır: (i) dönmeyen katman, (ii) dönme 90°'nin katı. Uçtan uca ölçüm
  (gerçek ffmpeg, 1080p, 16:9 kaynak, ölçek `0.555`, `P = (964.992, 540)`, katmanın parlaklık
  ağırlık merkezi): `a=0` → `(964.000, 539.998)`, `a=90°` → `(964.002, 540.000)`, beklenen
  `floor(P) = (964, 540)`.
- **ARA AÇILARDA ek bir pay vardır ve bu bir konum hatası DEĞİLDİR.** `rotate` katmanın DIŞ
  KENARINI yeniden örneklerken alfa rampasını asimetrik bırakır; ağırlık merkezi ölçümü bu yüzden
  kayar. Aynı düzenekte `a=15/30/45` → `x` `963.712 / 963.608 / 963.709` (yani ≤ 0.4 px);
  çerçevesini tam dolduran `100×100` bir karede aynı etki `+0.68 px`'e kadar çıktı. Bu pay
  katmanın **kendi kenarına** aittir, merkezine değil; eşiğe **+1 px** olarak yazılır ve tuval
  paritesinden BAĞIMSIZDIR (tek tuvalde de aynı büyüklükte ölçüldü). Gerekçe iki negatif
  kontroldür — ama ikisi de **koşullu**dur, koşulları bir sonraki maddededir.

- **NEGATİF KONTROLLERİN İKİ ÖNKOŞULU (yeniden üretilebilirlik şartı).** Aşağıdaki iki kontrol
  "sapma katmanın kendi kenarındandır, konumundan değildir" iddiasını taşır: (i) dönmeye duyarsız
  bir **disk**, (ii) kendi çerçevesine **değmeyen** bir kare. Bir tur önce burada yalnız sonuçları
  (`0.000`) yazılıydı; o haliyle kurulum **yeniden üretilemezdi** — aşağıdaki iki koşuldan biri
  ihlal edilirse aynı kontrol `0.000` yerine gerçek katmanınkiyle AYNI BÜYÜKLÜK BANDINDA bir sapma
  verir ve hiçbir şey ayırt etmez. Ölçüm düzeneği: `100×100` kaynak çerçevesi, ürünün kendi
  zinciri (`format=rgba` → `rotate=a:c=none:ow=2*ceil(hypot(iw\,ih)/2):oh=ow` →
  `overlay=x=floor(P−0.5*w)`), `P = (964.992, 540)`, ölçülen büyüklük kompozitin parlaklık ağırlık
  merkezi, açılar `0/1/15/30/45/90/180`.

  1. **MERKEZLEME (zorunlu).** Kaynağın KENDİ ağırlık merkezi `(X, Y)`, kendi çerçevesinin piksel
     merkezine TAM oturmalıdır:

     ```
     hypot(X − (w−1)/2,  Y − (h−1)/2) = 0        (piksel indeks koordinatında)
     ```

     Ölçüldü — koşul sağlandığında disk ve kare her açıda `0.000`; kaynak yalnız **yarım piksel**
     kaçık kurulduğunda (`hypot = 0.5`) aynı kontroller açı boyunca `0.500 … 0.508` (kare) ve
     `0.499 … 0.505` (disk) veriyor. Gerçek katmanın bandı `0.000 … 0.707` olduğuna göre bu
     değerler onun İÇİNDE kalır: kaçık kurulmuş bir negatif kontrol, kanıtlamaya çalıştığı şeyi
     çürütür gibi görünür. Sapmanın açıyla DEĞİŞMESİ (`a=0` → `0.500`, `a=180` → `0.500`, ama
     bileşenler `+0.500/+0.000` → `−0.500/+0.000` diye dönmesi) kurulum hatasının imzasıdır.
  2. **ÇERÇEVE PAYI ≥ 2 px (zorunlu).** İçerik kendi çerçevesinin kenarına yaklaşırsa `rotate`'in
     yeniden örneklemesi rampayı yine asimetrik bırakır — şekil dönmeye duyarsız OLSA BİLE.
     Merkezli disk, `100×100` çerçevede yarıçapa göre ölçüldü: pay `0 px` (çerçeveye değiyor) →
     `≤ 0.077`; pay `1 px` → `≤ 0.068`; pay **`2 px` ve üstü → her açıda tam `0.000`**. Yani
     "dönmeye duyarsız disk" tek başına yetmez; kontrolün geçerli olduğu rejim **payı ≥ 2 px olan**
     disktir. (Aynı çerçeveyi TAM DOLDURAN `100×100` kare, yani gerçek katmanın analogu, aynı
     düzenekte `0.000 … 0.707` verir: `a ∈ {0, 90, 180}` → `0.000`, ara açılarda `y` bileşeni
     `+0.682`'ye kadar çıkar. Mekanizmanın atfı bu karşıtlıkla kurulur.)
  3. **DİSKİN RASTERLEŞTİRMESİ (zorunlu — 8. turda ölçülerek eklendi).** Yukarıdaki iki sayı
     (`0.077` / `0.068`) diskin **nasıl çizildiğine** bağlıdır ve önceki sürümde bu koşul
     yazılı olmadığı için kontrol **yeniden üretilemiyordu**: aynı düzenek, alfası ikili
     (kenarı sert) bir diskle sınırı AŞIYOR. Ölçüm (8. tur, gerçek ffmpeg 8.0, aynı zincir,
     `overlay` ürünün `format=rgb` kompozisyonuyla; her hücre `a ∈ {0,1,15,30,45,90,180}`
     üzerinden EN KÖTÜ sapma):

     | Diskin alfası | pay 0 px | pay 1 px | pay 2 px | pay 3 px |
     |---|---|---|---|---|
     | ikili / sert kenar (AA yok) | **0.089** | 0.072 | **0.000** | **0.000** |
     | 4×4 süperörnekli kapsama | 0.079 | 0.068 | **0.000** | **0.000** |
     | 16×16 süperörnekli kapsama | 0.077 | 0.068 | **0.000** | 0.0001 |

     Yani dokümandaki `0.077 / 0.068` çifti **süperörnekli (kapsama-alfalı) diskin** sayısıdır;
     sert kenarlı diskle pay `0 px`'te `0.089` ölçülür ve yazılı sınır aşılır. Sayıyı
     alıntılayan bir kurulum diskin alfasını da söylemek zorundadır. **Taşıyıcı iddia —
     "pay ≥ 2 px'te sapma yok" — üç rasterleştirmenin ÜÇÜNDE de ayakta**: pay `2 px`'te üçü de
     her açıda **tam `0.000`**, pay `3 px`'te ikisi `0.000` ve 16×16 örnekli disk `0.0001`
     (yani `0` değil ama gerçek katmanın bandından — `0.000 … 0.707` — **binlerce kat** küçük;
     sıfırdan ayırt edilebilir bir mekanizma değil, sayısal artık). Yani negatif kontrolün mekanizma atfı
     rasterleştirmeden BAĞIMSIZDIR; kırılgan olan yalnız pay `0–1 px`'teki artık sayılardır. (Aynı koşumda tam çerçeveli kare `0.000 … 0.707`
     verdi — yukarıdaki karşıtlık yeniden üretildi.)

  > Bu iki koşul KURULUM koşuludur, ürün sözleşmesi değil: ürünün kendi katmanları çerçevesini
  > doldurur ve merkezleme kaynağın içeriğine bağlıdır. Koşullar yalnız §9.3'ün negatif
  > kontrollerini kuranı bağlar.
- **Kenar** iki bileşenin toplamıdır: boyut nicelemesi (kenar başına ölçülen aralık
  `[−0.80, +0.74]`) + konum kırpması (`[0, 1)`). Ölçülen en kötü tek kenar **1.79 px**; eşik bu
  yüzden 2 px'tir. Eşiği 1 px'te tutmak, ürünün ULAŞILABİLİR normal davranışını "hata" ilan
  ederdi — 4. tur öncesinde tam olarak bu yazıyordu ve hiçbir test bunu koşmadığı için fark
  edilmemişti.
- **±0.5 px pay** yalnız rasterleştirme farkı içindir: önizleme kenarı piksel MERKEZİNE göre
  yuvarlar (kaplanan ilk piksel `round(kenar)`), ffmpeg ise tamsayı sütun indeksiyle çalışır.

> **KAPSAM UYARISI (bu satırlar bugün TESTLE KORUNMUYOR).** Yukarıdaki merkez/kenar eşikleri
> ölçülmüştür ama
> onları koşan bir CI testi **yoktur**: preview ↔ export tam-kare golden karşılaştırması hâlâ
> yazılmadı (`docs/poc-bilinen-sinirlar.md` §5, "test edilmeyen yüzeyler"). Bugün koşan şey, bu
> bölümün ölçümlerinin **her iki yarısı ayrı ayrı**: export tarafında gerçek ffmpeg golden'ları
> (`GoldenFrameTests`), önizleme tarafında nokta örneklemeli `probePixel` e2e'leri. Eşik tablosu
> bu yüzden bir **beyandır**, bir bekçi değil — golden hattı kurulduğunda ilk sabitlenecek satır
> budur.

- ΔE2000, sRGB → Lab dönüşümüyle piksel başına hesaplanır; kenar antialias farklarını
  ayıklamak için karşılaştırma öncesi her iki görüntüye `1px` Gauss blur uygulanır.
- Ses parity'si için ayrı test: export WAV dökümü ile Web Audio `OfflineAudioContext`
  render'ı arasında örnek bazlı RMS fark ≤ -40 dBFS (miks/fade/gain formüllerini doğrular).
- Eşik ihlali = CI fail; eşik gevşetme PR'ı bu dokümana gerekçe yazmadan merge edilemez.
- Kurulum zamanı: golden-frame CI **M3'te** (ilk export milestone'ı) kurulur, her compiler
  PR'ında koşar; M4-M5'te geçiş/keyframe/efekt senaryoları eklenir.

---

## Ek: Sözleşme Değişiklik Kuralı

Bu dokümandaki herhangi bir formülün değişmesi: (1) önce burada değişir (PR açıklamasında
gerekçe), (2) `timeline-schema` test vektörleri güncellenir, (3) frontend + compiler aynı
PR zincirinde güncellenir, (4) golden-frame eşikleri yeniden doğrulanır. Tek taraflı
davranış değişikliği — testler yeşil kalsa bile — sözleşme ihlalidir.
