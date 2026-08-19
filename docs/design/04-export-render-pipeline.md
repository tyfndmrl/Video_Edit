# EXPORT/RENDER HATTI TASARIMI — Timeline JSON → ffmpeg → Final MP4

## 0. Genel Bakış

```
[React Editor] --POST /api/projects/{id}/exports--> [ASP.NET Core API]
                                                        |  (job kaydı: Postgres, durum: queued)
                                                        v
                                                  [Job Queue]  (Postgres SKIP LOCKED, Redis sadece pub/sub bildirim)
                                                        |
                                                        v
                                              [Export Worker (Docker)]
                                                        |
              1. Timeline JSON'u yükle + doğrula (schema versiyonu)
              2. Asset'leri R2'den indir (LRU disk cache)
              3. Overlay varlıklarını hazırla (metin PNG'leri — bkz. Bölüm 4)
              4. FilterGraph Compiler: JSON -> filter_complex_script dosyası
              5. ffmpeg çalıştır, -progress pipe'ından yüzde yayınla (Redis pub/sub -> SignalR)
              6. Çıktıyı R2'ye yükle (multipart), job: completed, kullanıcıya bildirim
```

Tek kritik tasarım kararı: **ffmpeg komutu elle string birleştirme ile değil, bir "FilterGraph Compiler" katmanıyla üretilir.** Timeline JSON → normalize edilmiş IR (intermediate representation) → filtergraph node listesi → `-filter_complex_script` dosyası. Bu compiler unit-test edilebilir (JSON girer, deterministik graph string'i çıkar) ve projenin en çok test yazılması gereken parçasıdır.

---

## 1. Zaman Modeli ve Normalizasyon Pass'i

Sözleşme gereği tüm zamanlar **tamsayı mikrosaniye** (`long`). ffmpeg'e verirken:

```csharp
static string Sec(long us) => (us / 1_000_000m).ToString("0.######", CultureInfo.InvariantCulture);
```

- `CultureInfo.InvariantCulture` zorunlu — Türkçe locale'de `0,5` yazılırsa ffmpeg patlar. (Klasik tuzak.)
- Export başında **çıktı fps'i sabitlenir** (proje ayarı, örn. 30000/1001 veya 30). Compiler'ın ilk pass'i her klibin başlangıcını çıktı frame grid'ine "snap" eder: `frameIndex = round(timelineStartUs * fps / 1e6)`. Böylece xfade offset'leri, enable aralıkları ve keyframe zamanları hep frame sınırına oturur; "yarım frame" kaynaklı tek-frame kaymalar biter.
- Her video zinciri `fps=FPS,settb=AVTB,setpts=PTS-STARTPTS` ile normalize edilir. `xfade` iki girişin **aynı çözünürlük, aynı fps, aynı timebase, aynı pix_fmt** olmasını şart koşar — normalize etmeden xfade %90 ihtimalle "first input link ... parameters do not match" hatası verir.

### Compiler IR (özet)

```
CompiledGraph {
  Inputs: [ { path, inputSs, inputT, loop?, framerate? } ]      // -ss/-t input seviyesinde
  VideoChains: [ { inputIdx, filters: [...], label } ]
  CompositeOps: [ Xfade{a,b,offset,dur,kind} | Overlay{base,top,xExpr,yExpr,enable} ]
  AudioChains + AudioMix
  OutputMaps
}
```

`-filter_complex` yerine daima **`-filter_complex_script graph.txt`**: uzun timeline'larda komut satırı limitine (Windows'ta 32K, Linux'ta ARG_MAX) takılmazsınız ve graph dosyası job artefaktı olarak loglanıp debug edilebilir.

---

## 2. Timeline JSON → ffmpeg Filtergraph Üretimi

### 2.1 Klip trim

Trim'i **input seviyesinde** yap (`-ss X -t D -i file`), filtergraph'ta değil:

- Input-level `-ss` keyframe'e seek edip oradan decode ettiği için frame-accurate **ve** hızlıdır (modern ffmpeg'te re-encode ile birlikte doğrudur). 2 GB'lık dosyanın 40. dakikasındaki 10 saniyelik klip için tüm dosyayı decode etmezsiniz.
- `-to` yerine `-t` (süre) kullan: input `-ss` sonrası timestamp'ler sıfırlandığı için `-to` semantiği kafa karıştırır. `inputT = (sourceOut - sourceIn)`.
- Aynı asset'ten N klip = N ayrı `-i` girişi (aynı dosya, farklı `-ss/-t`). `split` filter ile tek input'u bölmek decode'u seri hale getirir; ayrı input daha basit ve paraleldir.
- Filtergraph içinde yine de `trim/atrim` gerekebilecek tek yer: hız rampalarında segment bölme (bkz. 2.4).

### 2.2 Çoklu katman kompozisyonu (overlay zinciri)

> **DÜZELTME (M4 dalga 1 denetimi, bulgu #5).** Bu bölüm önceden *"Track 0 (en alttaki) taban
> katmandır"* diyordu; bu **yanlıştı** ve şema sözleşmesiyle ÇELİŞİYORDU. Bağlayıcı sözleşme
> `docs/design/01-frontend-editor.md §1.2` ve `packages/timeline-schema/src/schema.ts`
> (`TimelineDocSchema.tracks`: *"Index 0 = top layer (render order: last to first)"*):
> **`tracks[0]` EN ÜST katmandır**, dizi yukarıdan aşağıya sıralıdır (editör katman listesiyle
> aynı okuma yönü). Uygulama da bu sözleşmeye göre çalışır (`ExportCompiler.Validate`
> track'leri SONDAN BAŞA planlar). Metin aşağıda düzeltildi; **şema sözleşmesi kazanır** —
> iki normatif doküman bir daha ters yönde okunmasın.

Kural: **`tracks[^1]` (dizinin SONU = en alttaki katman) taban katmandır; ondan başlayarak
dizide geriye doğru gidilir, `tracks[0]` (EN ÜST katman) en son overlay edilir.** Taban track
çıktı tuvalini tam kaplamıyorsa önce sabit renk tuval üretilir:

```
color=c=black:s=1920x1080:r=30:d=16[canvas]
```

Render sırası (üç track'li örnek):

```
tracks[0]  ── EN ÜST  ─┐  (en son overlay edilir → çakışmada KAZANIR)
tracks[1]              │
tracks[2]  ── EN ALT  ─┘  (tuvale İLK bindirilir)

[canvas][tracks[2]]overlay[c0]; [c0][tracks[1]]overlay[c1]; [c1][tracks[0]]overlay[c2]
```

Her üst klip:

```
[N:v]setparams=colorspace=bt709:...:range=tv,fps=30,scale=w:h,format=rgba,
     settb=AVTB,setpts=PTS-STARTPTS+<timelineStart>/TB[clipN];
[prev][clipN]overlay=x=..:y=..:enable='between(t,start,end)':eval=frame:format=rgb[next]
```

- `setpts=...+start/TB` klibi timeline'daki yerine kaydırır; `enable=between(t,...)` görünürlük penceresini kısıtlar. İkisi birlikte kullanılmalı: setpts olmadan overlay ilk frame'den itibaren gösterir, enable olmadan overlay pencere dışında son frame'i dondurur.
- Overlay zinciri lineer: `[base][c1]overlay[t1]; [t1][c2]overlay[t2]; ...`. 10+ katmanda decode/filter bellek kullanımı artar ama mimari değişmez.
- **Kompozisyon renk modu GRAFİK BAŞINADIR, katman başına DEĞİL** (M4 dalga 1 denetimi, bulgu #1
  + #15 — normatif tanım `rendering-semantics §6.3`). Taban tuval dahil tüm katmanlar `format=rgba`
  ile girer, **her** overlay `:format=rgb` ile blend eder. Katman başına seçmek iki somut hataya
  yol açar:
  1. Alpha'lı katmanın ÜSTÜNE opak katman gelince ffmpeg birikmiş RGB kompozisyonu zincirin
     ortasında yuv'a çevirir → alttaki katmanların renkleri kayar (gerçek render ölçümü: üstteki
     katmanın **örtmediği** bölgede MSE 89.07, doygun renklerde 24 birim sapma; grafik başına
     modda aynı ölçüm 0.05).
  2. 4:2:0 tuval overlay konumunu **temsil edemez**: ffmpeg `overlay` x/y'yi `normalize_xy` ile
     chroma adımına kırpar (ölçüm: `overlay=x=11` → yuv420'de **10**, `x=−11` → **−12**; yani
     yön `floor`'dur, sıfıra doğru değil. `:format=rgb` ile ikisi de yerinde kalır; ÇİFT
     konumlarda iki mod aynı sonucu verir). Opak katman çift piksele snap olurken alpha'lı katman
     olmazdı; yani **aynı transform, opaklığa göre 1 px farklı** yere otururdu. Alt örneklemesiz
     tuval bunu kökten kaldırır. **`format=rgba` tek başına YETMEZ** (ölçüldü): her iki giriş
     rgba olsa bile `overlay`'in `format=auto` pazarlığı `yuva420p`'ye iner ve niceleme aynen
     oluşur — yükü taşıyan parça overlay'in kendi `:format=rgb` seçeneğidir. Bekçi:
     `GoldenFrameTests.CompositingInRgb_IsWhatKeepsOddOverlayPositionsFromSnapping`.
- Kaynak katmanların renk varsayımı (`§6.1`: untagged SDR = BT.709/tv) **RGB'ye geçişten ÖNCE**
  `setparams` ile beyan edilir; sonra beyan etmek dönüşümü etkilemez, yalnız etiketi düzeltir
  (ölçüm: beyansız RGB kompozisyonu SD kaynakta 68 birime varan sapma üretiyor).
- Bedeli ölçüldü ve kabul edildi: 1080p/150 kare/2 katman filtre hattı **~0.86 s → ~1.20 s**
  (%35-40). Alternatifi yok — 4:2:0 kompozisyon tek piksellik konumu temsil edemediği için
  "hızlı yol" doğru sonucu üretemez.

### 2.3 Geçişler — xfade/acrossfade ve zincirde offset matematiği

`xfade` semantiği: `offset`, **birleştirilmiş akışın kendi zamanında** geçişin başlama anıdır; çıktı süresi `durA + durB - transitionDur` olur. Aynı track'te N klip zincirlenirken offset kümülatif hesaplanmalı:

```
offset_1 = dur(c1) - x_1
offset_i = offset_{i-1} + dur(c_i) - x_i        // x_i: i. geçişin süresi
```

Örnek: 8s + 6s + 5s klipler, geçişler 1s ve 0.5s → `offset_1 = 7`, `offset_2 = 7 + 6 - 0.5 = 12.5`, toplam süre 17.5s. **Timeline JSON'da bu overlap editörde de aynı kuralla modellenmiş olmalı** (geçiş = komşu kliplerin timeline'da x kadar üst üste binmesi); yoksa preview ile export süreleri kayar. Compiler geçişli track'i önce tek "birleşik akış"a derler, sonra bu akış üst katman kompozisyonuna girer.

Ses tarafında birebir karşılığı `acrossfade=d=x` (offset parametresi yok, otomatik uçtan bindirir) — video xfade süresiyle aynı `x` verilirse senkron kalır.

Tuzaklar:
- xfade'e giren her iki akışın süresi geçişi kapsamalı; klip geçişten kısa ise compiler hata üretmeli (editörde de engellenmeli).
- 3+ klip zincirinde tüm segmentler aynı fps/tb/çözünürlükte normalize edilmiş olmalı (2.1'deki pass bunu garanti eder).

### 2.4 Hız değiştirme

Sabit hız `k`:
- Video: `setpts=PTS/k` (fps normalize sonrası; ardından tekrar `fps=30` ile çıktı grid'ine oturt).
- Ses: `atempo=k`, geçerli aralık **0.5–100**. `k < 0.5` için zincir: `k=0.25 → atempo=0.5,atempo=0.5`. Compiler yardımcı fonksiyonu:

```csharp
IEnumerable<double> AtempoChain(double k) {
    while (k < 0.5) { yield return 0.5; k /= 0.5; }
    while (k > 100) { yield return 100; k /= 100; }
    yield return k;
}
```

- Yavaşlatmada frame tekrarı yerine akıcılık istenirse `minterpolate` var ama CPU'da felaket yavaştır (gerçek zamanın 20-50x'i) — MVP dışı, "smooth slow-mo" ileride ayrı bir premium özellik.
- Hız **rampası** (keyframe'li hız) MVP dışı bırakılmalı; gerekirse klip sabit hızlı alt segmentlere bölünüp concat edilir. `setpts` ile sürekli hız eğrisi + ses senkronu ffmpeg'te güvenilir kurulamaz.
- Sesin perde korunması istenirse `rubberband` filtresi (librubberband build'i gerekir) — MVP'de atempo yeterli.

### 2.5 Keyframe animasyonları (pozisyon/ölçek/opaklık/rotasyon)

Karar: **MVP'de ffmpeg expression'ları, ama tek tip bir mekanizmayla — compiler her animasyonlu parametreyi piecewise-linear expression'a derler.** İki keyframe (t1,v1)→(t2,v2) için lerp bloğu:

```
if(lt(t,T1), V1, if(lt(t,T2), V1+(V2-V1)*(t-T1)/(T2-T1), V2))
```

N keyframe için iç içe `if` zinciri (compiler üretir, insan yazmaz). Parametre bazında uygulama:

| Parametre | Filtre | Not |
|---|---|---|
| Pozisyon x,y | `overlay=x='floor(EXPR)':y='floor(EXPR)':eval=frame` | Doğrudan desteklenir, ucuz. `eval=frame` şart. `floor` şart: overlay'in kendi `(int)`'i SIFIRA DOĞRU kırpar (rendering-semantics §2.5 adım 4). |
| Ölçek | `scale=w='EXPR':h='EXPR':eval=frame` | Frame başına yeniden ölçekleme; çıktı boyutu değiştiğinde overlay bunu kaldırır. Çift sayıya yuvarla (`trunc(EXPR/2)*2`). |
| Rotasyon | `rotate=a='EXPR':c=none:ow=2*ceil(hypot(iw,ih)/2):oh=ow` | `c=none` şeffaf arka plan; rgba format şart. `t` değişkeni desteklenir. Tuval ÇİFT olmak zorundadır (rendering-semantics §2.5 adım 3): tek tuvalde içerik ortaya oturmaz. |
| Opaklık | Sorunlu — aşağıda | |

**Opaklık ffmpeg'in zayıf noktası:** `overlay`'in alpha'sı, `colorchannelmixer=aa=` ise zaman expression'ı almaz. MVP stratejisi iki kademeli:
1. **Fade-in/out (kullanımın %95'i):** `format=rgba,fade=t=in:st=S:d=D:alpha=1` — hızlı ve doğru. Compiler, "0→1 veya 1→0 lineer segment" şeklindeki opaklık keyframe'lerini fade filtrelerine map eder.
2. **Keyfi opaklık eğrisi:** `sendcmd` ile frame başına `colorchannelmixer aa <v>` komutu içeren bir `.cmd` dosyası üret (compiler easing'i frame'lere örnekler, dosyaya yazar). Bu aynı zamanda **easing (bezier) eğrileri için de genel çözümdür**: expression'a bezier gömmek yerine, eğriyi frame başına örnekleyip sendcmd dosyasına dökmek deterministik ve basittir; `overlay` x/y de sendcmd komutlarını destekler.

Faz 2+'da animasyon karmaşıklaşırsa (motion blur, spring easing, çok parametreli grup animasyonu) expression yaklaşımı terk edilip Bölüm 4(b)'deki "sunucuda frame sequence üret" yoluna genişlenir — mimari buna hazır çünkü overlay zaten hazır varlık (PNG/WebM) kabul ediyor.

### 2.6 Renk düzeltme

- MVP: `eq=brightness=B:contrast=C:saturation=S:gamma=G` + sıcaklık için `colortemperature=temperature=K` (ffmpeg ≥ 4.4) veya `colorbalance`.
- Curves UI'ı gelirse: `curves=master='0/0 0.5/0.55 1/1'` — UI'daki kontrol noktaları doğrudan map edilir.
- En sağlam uzun vade yolu: tüm renk düzeltmeyi **tek bir 3D LUT'a bake edip** `lut3d=file.cube` uygulamak. Preview tarafında aynı LUT WebGL shader'ında uygulanır → renk parity problemi kökten çözülür (Bölüm 7). MVP'de eq ile başla, Faz 3'te LUT altyapısına geç.

### 2.7 Ses miksi

- Her klip zinciri: `asetpts=PTS-STARTPTS` → `atempo` (varsa) → `volume=V` → `afade` (varsa) → `adelay=<timelineStartMs>|<timelineStartMs>` → `aresample=async=1:first_pts=0`.
- Mix: `amix=inputs=N:duration=longest:normalize=0`. **`normalize=0` kritik** — default davranış her girişi 1/N zayıflatır, kullanıcı "müzik ekleyince konuşma kısıldı" diye bug açar.
- Çıkışta `alimiter=limit=0.98` (clipping koruması) + hedef `-14 LUFS` isteyen kullanıcı için opsiyonel `loudnorm` (iki-pass gerektirir, MVP'de kapalı).
- Kanal düzeni: her şeyi `aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates=48000` ile normalize et; mono kaynak + stereo müzik amix'te sürpriz yapmasın.
- "Detach audio" editör tarafı bir kavramdır; export açısından sadece video klibinin `an` (ses zinciri üretme) ve ayrı bir audio clip'in aynı asset'ten trim edilmesi demektir — compiler için ek özellik gerekmez.

### 2.8 Somut örnek: 2 video katmanı + 1 metin + 1 müzik

Senaryo (30 fps, 1080p, toplam 15s):
- **V1 (taban):** `clipA` (A.mp4, source 10s→18s, timeline 0–8s) → 1s `fade` xfade → `clipB` (B.mp4, source 4s→12s, timeline 7–15s)
- **V2:** `pip` (C.mp4, source 2s→9s, timeline 3–10s), 768px genişlik, x pozisyonu t=3→6 arası 50→800 lineer animasyon, sesi kapalı
- **Metin:** `text_42.png` (sunucuda üretilmiş, bkz. Bölüm 4), timeline 2–6s, 0.3s fade-in
- **Müzik:** bgm.m4a, 0–15s, volume 0.35, son 2s fade-out
- clipA ve clipB'nin kendi sesleri 1s acrossfade ile bağlanır.

```bash
ffmpeg -y -hide_banner -nostdin \
  -ss 10 -t 8 -i A.mp4 \
  -ss 4  -t 8 -i B.mp4 \
  -ss 2  -t 7 -i C.mp4 \
  -loop 1 -framerate 30 -t 4 -i text_42.png \
  -t 15 -i bgm.m4a \
  -filter_complex_script graph.txt \
  -map "[vout]" -map "[aout]" \
  -r 30 -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p \
  -color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv \
  -c:a aac -b:a 192k -ar 48000 \
  -movflags +faststart \
  -progress pipe:1 -stats_period 0.5 \
  out.mp4
```

`graph.txt` (compiler çıktısı):

```
[0:v]fps=30,scale=1920:1080:force_original_aspect_ratio=decrease,
     pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,settb=AVTB,setpts=PTS-STARTPTS[v0];
[1:v]fps=30,scale=1920:1080:force_original_aspect_ratio=decrease,
     pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,settb=AVTB,setpts=PTS-STARTPTS[v1];
[v0][v1]xfade=transition=fade:duration=1:offset=7[base];

[2:v]fps=30,scale=768:-2,format=rgba,settb=AVTB,setpts=PTS-STARTPTS+3/TB[pip];
[base][pip]overlay=eval=frame:enable='between(t,3,10)'
     :x='if(lt(t,3),50,if(lt(t,6),50+(800-50)*(t-3)/3,800))':y=120[cmp1];

[3:v]format=rgba,fade=t=in:st=0:d=0.3:alpha=1,settb=AVTB,setpts=PTS-STARTPTS+2/TB[txt];
[cmp1][txt]overlay=x=0:y=0:eval=init:enable='between(t,2,6)'[vout];

[0:a]asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates=48000[a0];
[1:a]asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates=48000[a1];
[a0][a1]acrossfade=d=1[amain];
[4:a]aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates=48000,
     volume=0.35,afade=t=out:st=13:d=2[amus];
[amain][amus]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.98[aout]
```

Notlar: PNG input'u `-loop 1 -t 4` ile 4 saniyelik akışa çevrilir (fade `st=0` kendi akış zamanındadır, setpts ile timeline'a taşınır). `enable` t değerleri **çıktı (birleşik) zaman ekseninde** çalışır; xfade sonrası taban akışın zamanı zaten timeline zamanıdır — compiler bu ekseni tek doğruluk kaynağı olarak kullanır.

---

## 3. Metin / Sticker / Şekil Render Stratejisi

### Karşılaştırma

| | (a) drawtext | (b) Sunucuda SkiaSharp → PNG/PNG-seq/şeffaf video | (c) Headless Chromium frame render |
|---|---|---|---|
| Çoklu stil (kelime bazlı renk/bold), emoji, RTL, outline+shadow+bg kombinasyonu | Çok zayıf. drawtext tek stil/tek font; emoji ve karmaşık shaping (Arapça, Hintçe) fiilen yok | Tam kontrol. HarfBuzz üzerinden shaping (SkiaSharp + SKShaper/SkParagraph), emoji, RTL çalışır | Mükemmel (tarayıcı motoru) |
| Preview ile birebir eşleşme | Düşük — freetype metrikleri Canvas/DOM'dan farklı | Yüksek — aynı TTF/OTF dosyaları, satır kırma tek yerde yapılırsa deterministik | En yüksek (preview de Chromium ise) |
| Animasyon | Sadece x/y/alpha expression | PNG tek kare + ffmpeg transform (2.5) veya frame sequence | Her şey, ama her frame render |
| Maliyet/karmaşıklık | Sıfır ekstra bileşen | Orta: .NET içinde native lib, font yönetimi | Yüksek: worker'da Chromium, RAM, güvenlik, hız (30fps × dakikalar) |
| Hız | Çok hızlı | Hızlı (statik: klip başına 1 PNG) | Yavaş (~5-15 fps screenshot) |

### MVP kararı: **(b) — SkiaSharp ile sunucuda render**

- **Statik metin/sticker/şekil:** klip başına **tek şeffaf PNG** (@2x, çıktı çözünürlüğüne göre) üret; pozisyon/ölçek/rotasyon/opaklık animasyonları ffmpeg transformlarıyla bu bitmap'e uygulanır. Preview tarafında da aynı mantık: metin bir kez rasterize edilir, animasyon CSS/canvas transform'udur. **Aynı bitmap'i transform etmek = garanti parity.**
- Metin layout'u (satır kırma, hizalama) tek doğruluk kaynağından çıkmalı: metin kutusunun ölçümü **sunucuda SkiaSharp'ta yapılır**, sonuç (satır kırılımları, bbox) asset türevi olarak saklanır; frontend bu bbox'ı kullanır. (Alternatif: frontend'in Canvas ölçümüne güvenmek — fontlar aynı olsa da tarayyıcılar arası kırılım farkı riski var.)
- Fontlar: self-host edilen sabit bir font seti (Google Fonts TTF'leri, R2'de). Kullanıcı custom font yüklerse aynı dosya hem `@font-face` hem SkiaSharp'a gider.
- **Karakter bazlı animasyon / kinetik tipografi** (Faz 3+): SkiaSharp ile PNG sequence (`-framerate 30 -i txt_%04d.png`) veya tek geçişli **ProRes 4444 / VP9+alpha WebM** ara dosyası üretilip normal video katmanı gibi overlay edilir. Mimaride "overlay klip = herhangi bir alpha'lı video/görüntü" olduğundan bu genişleme kırılım yaratmaz.
- (c) Chromium yolu, ileride "gelişmiş şablon/motion graphics" özelliği için opsiyon olarak masada kalır (Remotion modeli), MVP'ye sokulmaz.
- Şekiller (dikdörtgen, ok, blur bölgesi hariç): SkiaSharp'ta vektörden PNG; drawbox/drawgrid kullanma — stil sınırları aynı.

---

## 4. Süreç Akışı: Job → Worker → R2

### 4.1 Veri modeli ve API

```
POST /api/projects/{id}/exports        { profileId: "1080p-h264", timelineVersionId }
GET  /api/exports/{jobId}              -> { status, progressPct, etaSec, outputUrl?, error? }
```

```sql
export_jobs(id uuid pk, project_id, timeline_snapshot jsonb, profile jsonb,
  status text,          -- queued|preparing|downloading|rendering|uploading|completed|failed|canceled
  progress_pct real, attempt int default 0, max_attempts int default 3,
  worker_id text, heartbeat_at timestamptz, output_key text,
  error_code text, error_detail text, created_at, started_at, finished_at)
```

- **Timeline snapshot job'a gömülür** — kullanıcı export sürerken editlemeye devam eder, job o anki versiyonu render eder.
- Kuyruk: Postgres `SELECT ... FOR UPDATE SKIP LOCKED` (dayanıklı, ekstra bileşen yok). Redis sadece progress pub/sub → API → SignalR/WebSocket → UI. Hangfire da olur ama SKIP LOCKED + heartbeat daha şeffaf.
- Heartbeat 10 sn'de bir; 60 sn heartbeat'siz `rendering` job'lar reaper tarafından `queued`'a geri alınır (`attempt++`).

### 4.2 Worker akışı ve disk yönetimi

Worker (ayrı Docker imajı: .NET runtime + ffmpeg/ffprobe static build + SkiaSharp native):

1. **Ön kontrol — disk rezervasyonu:** `required = Σ(kaynak boyutları, R2 HEAD ile) + tahmini çıktı (süre × profil bitrate × 1.5) + %20 pay`. Yetersizse LRU cache'ten sil; hâlâ yetmiyorsa job'u `queued`'a bırak, başka worker alsın / alarm üret.
2. **Asset cache:** `/data/cache/{assetId}/{etag}/original.mp4` — job bitince silinmez, LRU (örn. 100 GB tavan) ile yaşar. Aynı projeyi tekrar export eden kullanıcı için 1-2 GB × N indirme tekrarı ortadan kalkar. İndirme: S3 SDK ile paralel ranged GET, `.part` dosyasına yaz + tamamlanınca atomik rename (yarım dosya cache'e girmesin).
3. **Overlay hazırlığı:** metin/şekil PNG'leri `/data/jobs/{jobId}/overlays/` altına render edilir.
4. **Render:** `Process` ile ffmpeg; `graph.txt` ve tam komut job kaydına loglanır. Timeout: `max(30 dk, timelineSüresi × 20)`. stderr'in son ~8 KB'ı ring buffer'da tutulur → hata durumunda `error_detail`.
5. **Progress:** `-progress pipe:1` çıktısındaki `out_time_us` (eski sürümlerde `out_time_ms` — **ismine rağmen mikrosaniyedir**, bilinen ffmpeg tuhaflığı) okunur:
   `pct = out_time_us / totalDurationUs * 100`. İndirme %0-15, render %15-90, upload %90-100 olarak faz ağırlıklı tek bara birleştirilir. `speed=1.34x` alanından ETA hesaplanır.
6. **Upload:** R2 multipart (part 64-128 MB), key: `exports/{projectId}/{jobId}.mp4`. Kullanıcıya presigned GET URL (24h) + kalıcı indirme endpoint'i.
7. **Bildirim:** Redis publish → SignalR; kullanıcı offline ise e-posta (opsiyonel).

### 4.3 Retry ve temizlik

- **Retry sınıflandırması:** ağ/R2/disk hataları → retriable (exponential backoff, max 3). ffmpeg'in deterministik hataları (bozuk graph, geçersiz input) → retry etme, direkt `failed` + `error_code` (aynı hatayı 3 kez almak sadece kaynak yakar). Ayrım: exit code + stderr pattern (örn. `Invalid argument`, `Error initializing filter` → deterministik).
- Kısmi çıktı: her attempt kendi temp dosyasına yazar (`out.attempt2.mp4`), başarıda atomik rename; R2 upload idempotent (aynı key overwrite).
- **Temizlik cron'u (worker içi timer):** `/data/jobs/*` 24 saatten eski ise sil; terminal duruma ulaşan job'ın dizini hemen silinir; cache LRU ayrı çalışır; R2'de `exports/` için 30 gün lifecycle rule (kullanıcı "exportlarım" listesinden yeniden üretebilir — timeline snapshot duruyor).
- Cancel: UI'dan `canceled` işareti → worker heartbeat sırasında görür, ffmpeg process'ini öldürür, temizler.
- Ölçekleme: worker başına eşzamanlılık **1** (ffmpeg zaten tüm çekirdekleri kullanır); yatay ölçek = worker container sayısı.

---

## 5. Çıktı Profilleri ve Süre Tahminleri

| Profil | Codec | Parametreler |
|---|---|---|
| 1080p Standart (default) | libx264 | `-preset veryfast -crf 18 -pix_fmt yuv420p -profile:v high -g 150 -c:a aac -b:a 192k -movflags +faststart` |
| 1080p Yüksek Kalite | libx264 | `-preset medium -crf 17` (2x yavaş, marjinal kazanç — "yüksek kalite" seçeneği olarak sun) |
| 4K H.264 | libx264 | `-preset veryfast -crf 19 -level 5.1` |
| 1080p/4K H.265 (ops.) | libx265 | `-preset fast -crf 22 -tag:v hvc1` — x264'ten 4-8x yavaş; "küçük dosya" seçeneği, uyarıyla |

- CRF > sabit bitrate: içerik uyarlamalı, sosyal medya re-encode ediyor zaten. `+faststart` şart (progressive playback).
- `-g 150` (5 sn GOP) scrub edilebilirlik için makul.

### Donanım hızlandırma gerçekçiliği

Hetzner/DO standart VPS/dedicated'da **GPU yok; QSV yok (Hetzner AX/CCX'lerde iGPU kapalı/yok); NVENC ancak GPU sunucuda** (pahalı, MVP için gereksiz). Ayrıca NVENC/QSV kalite/bit x264'ten kötüdür ve filter_complex zinciri zaten CPU'da çalışır — kazanç sadece encode aşamasında. **Karar: CPU-only libx264, yatay worker ölçeklemesi.** GPU ancak hacim ciddi büyüyünce (günde >1000 export) değerlendirilir.

### Süre tahminleri (10 dk'lık 1080p30 timeline, 2 katman + overlay + ses miksi)

| Makine | veryfast | medium |
|---|---|---|
| 4 vCPU VPS (CPX31/CCX13 sınıfı) | ~1.5–2x realtime → **5–7 dk** | ~0.6–0.9x → **11–17 dk** |
| 8 vCPU (CCX33) | ~2.5–3.5x → **3–4 dk** | ~1.2–1.6x → **6–8 dk** |
| 16 core dedicated (AX41/AX52) | ~4–6x → **2–2.5 dk** | ~2–3x → **3.5–5 dk** |

4K ≈ bu sürelerin 3.5–4.5 katı (10 dk 4K timeline, 8 vCPU veryfast: ~12–18 dk). Not: decode tarafı da maliyetli — 4K H.264/HEVC kaynaklardan çok katmanlı kompozisyonda darboğaz decode olabilir; proxy değil **orijinalden** export ettiğimiz için tahminlere kaynak çözünürlüğü de dahil edilmeli. UI'da ETA'yı ilk 30 sn'nin gerçek `speed` değerinden hesapla, statik tahmin verme.

---

## 6. Doğruluk: Preview (tarayıcı) ↔ Export (ffmpeg) Eşleşmesi

Fark kaynakları ve stratejiler:

1. **Renk uzayı / gamma.** Tarayıcı videoyu BT.709→sRGB display pipeline'ından geçirir; ffmpeg untagged kaynaklarda tahmin yürütür. Strateji: (i) ingest'te ffprobe ile renk metadata'sını kaydet; untagged 1080p+ kaynağı BT.709 varsay; (ii) proxy üretiminde ve exportta **aynı varsayımı** uygula ve çıktıyı daima açıkça tag'le (`-color_primaries/-color_trc/-colorspace bt709 -color_range tv`); (iii) HDR (BT.2020/PQ/HLG) kaynakları MVP'de `zscale=t=bt709:tin=smpte2084:npl=100,tonemap=hable` ile tone-map edip SDR'a indir — hem proxy hem export aynı zincirden geçsin ki preview'de gördüğü exportta çıksın.
2. **Font rendering.** Bölüm 3'teki karar bunu çözer: metin tek yerde (SkiaSharp) rasterize edilir, her iki taraf aynı bitmap'i transform eder. drawtext hiç kullanılmadığı için freetype-vs-Canvas metrik farkı diye bir problem sınıfı yok.
3. **Kompozisyon matematiği.** Canvas/CSS sRGB'de non-linear blend yapar; ffmpeg overlay yuv420'de blend ederse farklı görünür → **grafiğin tamamında** `format=rgba` + `overlay:format=rgb` zorla (2.2; katman başına seçmek yasak — orada ölçümleriyle anlatıldı). Premultiplied alpha'ya dikkat: SkiaSharp çıktı PNG'leri straight alpha ile kaydedilmeli (PNG zaten straight'tir; Skia surface'tan `Unpremul` ile encode et).
4. **Renk düzeltme parity.** eq/curves'ün tarayıcıdaki karşılığı (CSS filter/WebGL shader) formül olarak birebir değildir. MVP: preview'de WebGL shader'ları **ffmpeg eq formülünü aynen implemente ederek** yaz (formüller basit ve dokümante). Faz 3: her ikisi de aynı 3D LUT'u uygular (2.6) → tam eşitlik.
5. **Zamanlama.** Tamsayı µs + frame-snap pass (Bölüm 1) + geçiş overlap kuralının iki tarafta aynı formülle uygulanması. Preview player'ı da frame index üzerinden konuşmalı (`currentFrame`), saniye üzerinden değil.
6. **Proxy farkı.** Preview proxy'den (örn. 960×540) çalışır; keskinlik/detay farkı kaçınılmaz ve kabul edilir — kullanıcıya "önizleme düşük çözünürlüklüdür" bilgisi. Proxy üretiminde renk zinciri exportla aynı olmalı (aynı tonemap/tag), yoksa fark keskinlik değil renk olur ve şikayet üretir.
7. **Regresyon güvencesi — golden frame testleri:** CI'da sabit test timeline'ları için (i) export path'ten `-vf select=eq(n\,K)` ile frame çıkar, (ii) Playwright ile preview'in aynı frame'inin screenshot'ı, (iii) SSIM/ΔE karşılaştırması eşik altındaysa fail. Compiler değişikliklerinde parity kırılmasını otomatik yakalar.

---

## 7. Fazlar / Milestone'lar

- **M1 — Tek katman happy path (2-3 hafta):** job tablosu + SKIP LOCKED worker + R2 indirme/yükleme + tek track trim/concat (geçişsiz) + ses + progress + 1080p profil. Uçtan uca çalışan iskelet.
- **M2 — Kompozisyon (2-3 hafta):** çoklu katman overlay, xfade/acrossfade offset compiler'ı, volume/afade, amix. Golden frame test altyapısı burada kurulur.
- **M3 — Overlay varlıkları (2 hafta):** SkiaSharp metin/şekil/sticker PNG üretimi, font yönetimi, fade-in/out.
- **M4 — Animasyon + hız + renk (2-3 hafta):** keyframe expression compiler'ı, sendcmd easing, setpts/atempo, eq. Compiler unit-test yüzdesi burada kritik.
- **M5 — Dayanıklılık (1-2 hafta):** retry sınıflandırması, reaper, LRU cache, disk rezervasyonu, cancel, temizlik, 4K/H.265 profilleri, ETA.
- **M6 — Parity sıkılaştırma:** HDR tonemap, WebGL eq shader eşitliği, SSIM eşiklerinin CI'a bağlanması.

## 8. Bilinen Tuzaklar (özet kontrol listesi)

1. `CultureInfo` — ondalık ayracı virgül olan locale'de üretilmiş ffmpeg parametreleri (Windows dev makinesinde özellikle).
2. `out_time_ms` mikrosaniyedir; `out_time_us` varsa onu tercih et.
3. xfade girişlerinin fps/tb/çözünürlük/pix_fmt eşitliği; normalize pass atlanırsa link hatası veya sessiz kayma.
4. `amix` default normalize'ının sesleri kısması → `normalize=0`.
5. `atempo` 0.5 altı için zincirleme; 0.5×0.5 kompozisyonunun kümülatif hata üretmemesi için süre hesabını µs'de yap.
6. Input `-ss` sonrası `-to` semantiği → daima `-t` kullan.
7. VFR (değişken fps, özellikle telefon kayıtları) kaynaklar: `fps=30` normalize etmeden ses-video kayar; ingest'te ffprobe ile VFR tespiti + metadata'ya işaret.
8. Dönme metadata'sı (telefon videosu `rotate=90`): yeni ffmpeg autorotate yapar ama proxy/export/preview üçünün aynı davranması test edilmeli.
9. `enable=between(t,...)` sınırlarında kapalı/açık aralık: bitişik iki klipte aynı t değeri iki overlay'i birden tetikleyebilir → compiler bitişi yarım frame geri çeker (`end - 1/(2*fps)`).
10. Komut satırı uzunluk limiti → `-filter_complex_script`.
11. Overlay PNG'lerinde premultiplied/straight alpha karışıklığı (koyu kenar halkası belirtisi).
12. Disk dolması: rezervasyon yapılmadan paralel iki büyük job aynı worker'a düşerse ikisi de ölür → eşzamanlılık 1 + rezervasyon.
13. Retriable olmayan ffmpeg hatasını 3 kez retry edip kaynak yakmak → hata sınıflandırması.
14. Kullanıcı export sürerken timeline'ı değiştirir → snapshot job'a gömülür, referans değil.
15. HDR iPhone videosu (HLG/Dolby Vision): tone-map edilmezse export soluk/patlamış çıkar; MVP'de bile en azından tespit + SDR tonemap şart (iPhone kullanıcı tabanında çok yaygın).
16. `rotate`'in kare ara tuvali **GİRİŞİNDEN** doğar (`ow=2*ceil(hypot(iw,ih)/2)`) — yani aynı katman, girişi kutuya normalize edilmiş yolda (geçiş/concat) ve edilmemiş yolda (tek klip) **farklı tuval** alır ve farklı ızgaraya oturur. Ölçüldü (16:9 kaynak, `s=0.503`, `a=90`, 320×240 tuval): `(114,39,205,200)` vs `(115,39,204,200)`. Çözüm sonucu telafi etmek DEĞİL, girişi eşitlemektir: dönen + çapası merkezde katmanda normalize pad **kesim durumundan bağımsız** üretilir (`rendering-semantics §5.2`).