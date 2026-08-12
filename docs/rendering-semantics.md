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

`decrease` aspect'i koruyup kutuya sığdırdığı için sonuç tam olarak `w_fit*scale × h_fit*scale`
(= §2.2'nin `w_d × h_d`'si) olur. Filtre çıkışındaki gerçek boyut `w_px × h_px` ile gösterilir
(`w_px ≤ boxW`, `h_px ≤ boxH`).

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
Dg = ceil(hypot(padW, padH))                  // dönen kutuyu her açıda kapsar
rotate=a=<θ_rad>:c=none:ow=hypot(iw\,ih):oh=ow
```

`ow/oh` ffmpeg ifadesiyle yazılır çünkü compiler `w_px/h_px`'i bilmez; ifade **config anında bir
kez** değerlendirilir (frame başına değil) → determinism korunur. `Dg` yine de compiler
tarafından kutudan (üst sınır olarak) hesaplanır — **bellek tavanı bu değerden doğrulanır**:

```
MaxLayerDimension = 8192       // ara tuval kenarı; 8192² rgba ≈ 256 MB/kare
Dg ≤ MaxLayerDimension  (θ = 0 iken boxW, boxH ≤ MaxLayerDimension)
```

Tavanı **scale kutusuna** uygulamak yetmez: pad 2x, rotate ~1.41x büyütür; kutudan doğrulamak
gerçek tavanı ≈23170 piksele (rgba'da ~2.1 GB/kare → worker OOM) taşır (denetim bulgusu #2).

**Adım 4 — overlay pozisyonu:** çapa, dönen katmanda tuvalin tam ortasındadır; dönmeyende kendi
kutusundaki oranındadır:

```
θ ≠ 0:   overlay_x = P.x - 0.5 * w        overlay_y = P.y - 0.5 * h
θ = 0:   overlay_x = P.x - anchorX * w    overlay_y = P.y - anchorY * h
```

(`w/h` = overlay girişinin ffmpeg değişkenleridir; adım 3'ten sonra ikisi de `Dg`'dir.)

**Konum kuantalanması (NORMATİF):** overlay konumu **alt örneklenmemiş** bir kompozisyon
tuvalinde değerlendirilmelidir. ffmpeg `overlay`, 4:2:0 tuvalde `x/y`'yi chroma adımına kırpar
(`normalize_xy`) — `overlay=x=201` yuv420'de **200**'e oturur, rgb'de 201'de kalır. Bu yüzden
kompozisyon tuvali daima RGB'dir (§6.3); aksi halde aynı transform, katmanın opaklığına göre
1 px farklı yere düşerdi.

#### 2.5.1 Eşdeğer kapalı form (bilgilendirici)

Kaynak boyutu biliniyorsa aynı sonuç pad'siz de yazılabilir — iki hat aritmetik olarak eşdeğerdir:

```
cx = w_px / 2;  cy = h_px / 2                          // çizim merkezi
ax = anchorX * w_px;  ay = anchorY * h_px              // çapa
D  = ceil(hypot(w_px, h_px))
a'x = D/2 + cos(θ)*(ax - cx) - sin(θ)*(ay - cy)
a'y = D/2 + sin(θ)*(ax - cx) + cos(θ)*(ay - cy)
overlay_x = P.x - a'x ;   overlay_y = P.y - a'y
```

Bu form daha küçük bir ara tuval kullanır (`D ≤ Dg`) ama kaynak boyutuna bağımlıdır; MVP'de
tercih edilmemiştir. Geçilirse §2.5'in tavan kuralı `D` üzerinden uygulanır.

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
