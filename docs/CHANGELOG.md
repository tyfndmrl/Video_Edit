# CHANGELOG — ters kronolojik
Kaynaklar: `git log`, `PROGRESS.md`, `docs/backlog.md` tur kayıtları. Commit aralıkları doğrulanabilir.

## 2026-09-09
- **ffmpeg-8-pin** — **ffmpeg sürümü CI'da VE PROD'DA 8.0'a sabitlendi** (kullanıcı kararı).
  Asıl kusur "eski sürüm" değildi: **test edilen sürümle ÜRETİLEN sürüm farklıydı.** Ölçüm:
  yerel (golden'ların kalibre edildiği yer) **8.0**, CI `apt` **6.1.1**, ve — bu turda fark
  edildi — **prod Worker imajı da `apt` ile 6.1.1** (`docker run mcr.microsoft.com/dotnet/
  runtime:10.0` içinde ölçüldü). İki major sürüm ayrıydı. Worker Dockerfile'ının kendi notu
  bunu zaten öngörmüştü ("ileride sürüm sabitlemek için statik ffmpeg binary'si COPY ile
  gömülmeli. MVP icin apt yeterli") — o varsayım ölçümle çürüdü.
  **Kaynak seçimi ölçülerek yapıldı, tahminle değil:** `johnvansickle old-releases/8.0` → 404;
  `johnvansickle releases/` → HAREKETLİ ve bugün **7.0.2**; `BtbN` `latest` → yalnız master
  derlemesi (`N-126482`), 8.0 varlığı yok. Kalan sağlam kaynak
  `mwader/static-ffmpeg` ve orada **8.0 etiketi VAR** — DIGEST ile sabitlendi
  (`sha256:415a41fa…ab4a`), böylece etiket yeniden işaretlenemez.
  **Uygulama:** (a) Worker Dockerfile'ında `apt-get install ffmpeg` yerine digest'li imajdan
  `COPY --from=ffmpeg /ffmpeg /ffprobe`; (b) CI'ın `dotnet` ve `e2e` job'larında apt yerine
  aynı digest'ten `docker cp` + `$GITHUB_PATH`. Her iki CI adımı ALDIĞI sürümü ayrıca
  DOĞRULAR (`grep -qE "version 8\.0"`) ve tutmazsa `::error::` ile düşer — yanlış sürüm
  sessizce geçemez.
  **KANIT:** Worker imajı gerçekten derlendi ve içinde ölçüldü → `ffmpeg version 8.0` +
  `ffprobe version 8.0` (öncesi: 6.1.1).
  **DÜRÜSTLÜK — bu, CI'daki TÜM kırmızıları çözmeyebilir:** yereldeki 8.0 bir *gyan.dev
  Windows* derlemesi, sabitlenen ise *statik Alpine* derlemesi — aynı sürüm, farklı
  `configure` bayrakları ve muhtemelen farklı x264. Golden'lar Windows derlemesine kalibre
  olduğu için piksel toleransı hatalarının sürmesi MÜMKÜN. Çözülmesi beklenen: `scale`
  ifadesi farkı (`dsth out of range`) — o bir SÜRÜM davranışı. Sonucu CI söyleyecek;
  tahmin edilmedi.
- **push + `harfbuzz-linux`** — 71 commit `origin/main`'e gitti (kullanıcı kararı) ve İLK CI koşumu
  **GERÇEK BİR ÜRÜN KUSURU** ortaya çıkardı: `HarfBuzzSharp.NativeAssets.Linux` paketi hiç
  referanslı değildi.
  **BAĞLAM:** CI bu depoda HİÇ yeşil olmamış (2 koşum, 2 başarısız — diğeri 2026-08-19, 71 commit
  önce, aynı job). Yani push bir şey kırmadı; hiç koşmamış bir boru hattını ilk kez ölçtü.
  **KUSUR — CI'dan büyük, PROD'u vuruyor:** `csproj` `SkiaSharp.NativeAssets.Win32` +
  `SkiaSharp.NativeAssets.Linux.NoDependencies` taşıyordu ama HarfBuzz'ın Linux native'ini DEĞİL.
  `SkiaSharp.HarfBuzz` yalnız YÖNETİLEN köprüdür; `libHarfBuzzSharp` native'i ondan gelmez —
  HarfBuzzSharp ayrı bir paket ailesidir ve AYRI sürüm numarası taşır (Skia 3.116.1 ↔ HarfBuzz
  8.3.0.1). Çözülen grafta `.Win32` ve `.macOS` vardı, `.Linux` yoktu. Prod Api/Worker LİNUX
  konteynerde koşar ve Dockerfile'lar libharfbuzz KURMAZ (Worker yalnız `ffmpeg`, Api yalnız
  `curl`) → **metin içeren her export prod'da `DllNotFoundException` ile düşerdi.** Üstelik
  csproj yorumu "Linux/NoDependencies (worker imajı)" diyerek kapsanmayan bir şeyi kapsanmış
  gibi gösteriyordu (over-claim sınıfı, bu kez csproj yorumunda).
  **KANIT ZİNCİRİ:** Worker `-r linux-x64` publish edildi → paket VARKEN `libHarfBuzzSharp.so`
  çıktıda, `libSkiaSharp.so` ile yan yana. NEGATİF KONTROL: paket çıkarılıp yeniden publish →
  çıktıda YALNIZ `libSkiaSharp.so` kaldı, CI hatasının birebir sebebi. Yerel backend paketi
  düzeltmeden sonra **1626/1626** yeşil (Windows'ta regresyon yok), `-warnaserror` 0 uyarı.
  **KALICI KAPI:** CI'ın `dotnet` job'una YAZILIŞI değil ÇIKTIYI doğrulayan adım eklendi —
  linux-x64 publish edip `libSkiaSharp.so` + `libHarfBuzzSharp.so` varlığını sınıyor.
  **KALAN İKİ SINIF (bu commit KAPSAMINDA DEĞİL, kullanıcı kararı bekliyor):** 37 düşenin geri
  kalanı (a) ffmpeg SÜRÜM farkı — CI apt'ten alıyor, korpus 8.0'a kalibre
  (`GoldenFrameTests.ScaleBoxTruncated_MatchesRealFfmpeg` → `dsth out of range`, `Conversion
  failed!`) ve (b) piksel toleransı — farklı swscale/x264 derlemesi
  (`(137,70,24)` ↔ beklenen `(132,68,28)±4`; LUT `(22,66,134)` ↔ `(32,64,128)`).
  İkisi de SÖZLEŞME kararı ister (CI'da ffmpeg 8.0 sabitlemek mi, toleransı platforma göre
  gevşetmek mi) — onaysız yapılmadı.

## 2026-09-08
- perf-3.6-headless — **panel turunun son açık teknik maddesi KAPANDI.** `performans-raporu §3.6`
  (timeline dikey boyutlandırma, sürükleme fazı) başlı Edge/165 Hz'de ölçülmüştü; headless'i
  dışlayan gerekçe 2026-09-04'te çürümüş ama ölçüm tekrarlanmamıştı. Yeniden koşum **sabit
  bütçeyle DEĞİL** yapıldı: baş mühendisin ölçtüğü gibi "p95 ≤ 16,7 ms" headless'te (60 Hz vsync,
  idle p95 zaten 16,670 ms) maliyet ölçümü değil ikili bir "kare düştü mü" testine döner. Onun
  yerine §13 YÖNTEMİ — bölümün ASIL iddiasını ("sürükleme fazı boştan ayrışmıyor") sınayan
  idle ↔ sürükleme A/B'si. Geçici prob spec'i, GERÇEK CDP fare girdisi (`dragHandleBy`:
  pointer-down + 16 kademe + up), üç tekrar, her tekrarda DOM etkisi doğrulandı (wrap yüksekliği
  +100 px'ten fazla arttı); prob ölçümden sonra SİLİNDİ (spec sayısı 51'de kaldı).
  SONUÇ: idle p50/p95/max **16,665 / 16,670 / 16,670** ms (n=301) ↔ resize tekrarları
  **birebir aynı** (n=98/93/91), 583 karede >33,3 ms **YOK**. İddia ikinci ve BAĞIMSIZ bir
  rejimde de tuttu. DÜRÜSTLÜK kayda geçti: headless bu iddianın DAHA ZAYIF sınayıcısıdır
  (60 Hz'de bütçe 16,67 ms = 165 Hz'deki 6,1 ms'nin 2,7 katı pay); başlı Edge ölçümü güçlü
  olanı olarak KALIR, headless onu doğrular ama yerine geçmez.
  Ayrıca defter tazeliği: `STATE`'in "origin 39+ commit geride" kaydı `git rev-list --count`
  ile ölçülüp **70**'e çekildi (bayattı).

## 2026-09-05
- ci-redis — **CI'ın e2e job'undaki redis boşluğu KAPANDI** (kullanıcının sıradaki iş listesinin
  1. maddesi; `git push`'un tek teknik ön koşuluydu). Kayıt "ilk koşumda bu job kırmızı DÜŞEBİLİR"
  diyordu; ölçtüm ve kesinleştirdi: yerelde `videoedit-redis-1` durdurulup
  `e2e/export-progress-hub.spec.ts` koşuldu → **`Hub'dan 'running' mesajı gelmedi` ile KIRMIZI**.
  Yani boşluk teorik değildi, CI koşsaydı e2e paketi DÜŞERDİ. Düzeltme: altyapı adımı
  `postgres minio redis` başlatıyor + redis healthcheck kapısı eklendi (forwarder abone olamadan
  API açılırsa hub sessiz kalır ve spec'in ölçtüğü tam da o kanaldır). API/Worker Redis adresini
  `appsettings.Development.json`'dan (`localhost:6379`) alıyor, ek env GEREKMEDİ. `ci.yml`'deki
  "ACIK SORU" yorumu ölçülmüş gerçeğe çevrildi; YAML `yaml.safe_load` ile doğrulandı (4 job).
- panel-denetim-10 — **baş mühendis ONAY verdi → PANEL TURU KAPANDI** (üç rolün üçü de 0 MADDİ).
  Baş mühendis dört kapıyı ve TAM suite'i KENDİ koştu — 197/197 (51 spec, 12,2 dk, 0 skip) ·
  backend 1626/1626 (0 skip, 2 dk 11 sn) · editör 1552 · şema 235 · `-warnaserror` 0 uyarı — ve
  kullanıcıya gösterilen HER sayıyı yeniden ölçtü: 0,70/1,20/1,24 dB, limiter tepe 1,163/0,950,
  headless rAF 16,665 ms (n=300), −5 dBFS fikstür eşiği. Hepsi tuttu. `meter.spec.ts` 4/4 kararlı.
  **KANIT — sahtenin ÜÇ YENİ sapması (hepsi kapatıldı).** (1) `getFloatTimeDomainData` tamponun
  TAMAMINI dolduruyordu; gerçek API yalnız `fftSize` örnek yazar, gerisine dokunmaz (denetçi
  gerçek Chromium'da ölçtü). Sonucu ölçtüm: tampon `fftSize * 4` yapılınca muhafız **10/10**,
  editör **1552/1552** ve gerçek girdili `meter.spec` **3/3** YEŞİL kalıyor — oysa gerçek
  tarayıcıda RMS 6,02 dB düşer ve ölçerin BAR GÖVDESİ (RMS'ten çizilir) kullanıcıya yanlış
  seviye gösterir; tepe değişmediği için e2e ve klip mandalı yapı gereği kör. Sahte artık
  `fftSize` kadar yazıyor + yeni iddia RMS'in TAM pencereden geldiğini çiviliyor (NC: `expected
  0.125 to be close to 0.25` — tam olarak √(1/4)). (2) `AudioContext` constructor seçenekleri
  yok sayılıyordu; §8.5 örnekleme hızı sözleşmesinin HİÇBİR kalkanı yoktu → sahte `sampleRate`'i
  saklıyor + yeni iddia (NC: `{ sampleRate }` düşürülünce `expected 48000 to be 44100`).
  (3) `createMediaElementSource` aynı eleman için tekrar çağrılabiliyordu; gerçek API
  `InvalidStateError` fırlatır → taklit edildi.
  **ÜÇ KAYIT HATASI yakalandı ve düzeltildi (hepsi benim kayıtlarımda):** (a) `-9`'un
  "iki takas da 10/10 yeşil" NC imzası ARİTMETİK OLARAK İMKÂNSIZDI — o commit'te dosyada 9 iddia
  vardı ve 10.'su zaten o bulguyu kapatmak için eklendi; imza 9/9 olmalıydı. (b) `-9`'un
  CHANGELOG'u `DECISIONS`'ın da 7 → 10'a çekildiğini söylüyordu, ama `git show 4f27bef --
  docs/DECISIONS.md` BOŞ döner: dosyaya hiç dokunulmamıştı ve satır hâlâ `-9`'un yanlış ilan
  ettiği "erişilebilirlik sorar" ifadesini taşıyordu. Şimdi gerçekten güncellendi.
  (c) **KURAL 9 (AYNI HEAD) BU TURDA İHLAL EDİLDİ:** üç rol sırasıyla `205303d`, `b0f8570` ve
  `4f27bef`'i denetledi — yani aralarında düzeltme yapıldı; kuralı YAZAN tur kuralı uygulamadı.
  Denetçi bunu ölçerek yakaladı (muhafızın iddia sayısı 7 → 9 → 10). Onayları geçersiz kılmaz
  (her rol kendi HEAD'inde MADDİ bulmadı, son HEAD tam koşuldu) ama kayda geçti.
  **KOZMETİK:** `meterHonestyNote()` `running` rejiminde HER örnekte koşuyordu (`readout.title`
  yolundan; `-8`/`-9` onu literal cümleden tablodan-türetmeye çevirmişti) — denetçi ölçtü:
  0,223 → 1,487 µs/çağrı, 30 Hz'de +0,038 ms/s. Modül sabitine alındı ve `title` yalnız
  değişince yazılıyor. Klip mandalı payı kaydı 5,4 → **5,6-5,7 dB** (yeniden ölçüldü).
  `performans-raporu §3.6`'nın headless yeniden koşumu AÇIK İŞ olarak KALIYOR: denetçi ölçtü ki
  o bölümün "p95 ≤ 16,7 ms" bütçesi headless'te (idle p95 = 16,670 ms, pay 0,030 ms) maliyet
  ölçümü değil ikili bir "kare düştü mü" testine dönüşür — dürüst formu §13'teki gibi A/B'dir.
- panel-denetim-9 — **baş mimar ONAY verdi** (0 MADDİ · 3 KANIT · 5 KOZMETİK); bulgular kapatıldı
  ve turun PROSEDÜR dersi bağlayıcı belgelere yazıldı.
  **KANIT-1 — muhafız splitter kablolamasını çiviliyordu ama RAPORLAMAYI değil.** `analyserL`/
  `analyserR` atamalarını ya da `readMeter()`'ın dönüşünü takas etmek, sol/sağ kanalı KALICI
  olarak yer değiştiriyor ve her kapıdan geçiyordu — kendi ölçümüm: iki takas da **9/9 yeşil**
  (denetçinin koşumunda birim 393 + gerçek girdili `meter.spec` 3/3 de yeşildi). (DÜZELTME:
  ilk yazımda "10/10" yazılmıştı; o commit'te dosyada 9 iddia vardı ve 10.'su zaten bu
  bulguyu kapatmak için eklendi — aritmetik olarak imkânsız bir imzaydı, baş mühendisin
  kapanış turunda yakalandı.) e2e'nin
  kapatması YAPI GEREĞİ imkânsız: fikstür MONO (`ffprobe` → `channels=1`), L ve R özdeş.
  Sahtenin analyser'ları artık düğüme özgü bir sinyal "duyuyor"; yeni iddia okunan `peakL`/`peakR`'nin
  splitter'ın 0 ve 1 numaralı çıkışlarına BU SIRAYLA karşılık geldiğini çiviliyor. NC ×2 kırmızı
  (`expected 0.75 to be close to 0.25`). Böylece `panel-denetim-8`'in "`data-meter-db-r` yalan
  söylerdi" gerekçesinin AÇIK KALAN yarısı da kapandı.
  **KANIT-2 — sahte, gerçek Chromium'un reddettiği analyser ayarlarını kabul ediyordu.** Denetçi
  gerçek tarayıcıda ölçtü: `fftSize = 1500` → `IndexSizeError: … not a power of two`,
  `smoothingTimeConstant = 2` → `… outside the range [0, 1]`. Sahtede ikisi de yeşil geçiyordu,
  oysa tarayıcıda `buildMeterTap` fırlatır ve **önizleme hiç başlamaz**. Sahteye setter
  doğrulaması eklendi; NC: `METER_FFT_SIZE = 1500` → gerçek mesajla birebir kırmızı.
  **KANIT-3 — sahtenin `destination`'ı 1 çıkışlıydı; gerçekte 0.** `DECISIONS` reddedilen
  alternatif olarak "`destination`'ı taplamak (imkânsız — çıkışı yok)" diyor; sahte tam onu yasal
  modelliyordu. `numberOfOutputs = 0` yapıldı. (Denetçi dürüstçe not etti: sömürülebilir bir
  delik DEĞİLDİ, tutarsızlıktı.)
  **KOZMETİK-1 (turun asıl dersi) — protokol belgeleri yürürlükteki düzeni ANLATMIYORDU.**
  `WORKFLOWS.md` W2 hâlâ "baş mimar / baş geliştirici ÇİFTİ" ve "İki paralel rol" diyordu;
  `review-gate.md` (BAĞLAYICI) MADDİ/KANIT/KOZMETİK ölçütünü hiç bilmiyordu ve damgası yoktu;
  `CLAUDE.md` yetenek haritası iki rol sayıyordu. Üçü de düzeltildi ve `review-gate`'e ÜÇ YENİ
  BAĞLAYICI KURAL eklendi: **8** (üç rol + bulgu sınıfları + "RED yalnız MADDİ için" — döngünün
  kapanma şartı), **9** (AYNI HEAD: roller arasında düzeltme yapılmaz, yoksa bulgular zincirlenir),
  **10** (bir muhafızı kırmak onu doğrulamaz; kaynak taraması yalnız saydığı yazılışı savunur —
  grafı doğrulamak için grafı KURMAK gerekir). Ölçülmüş gerekçe kurala iliştirildi: kural 8'den
  önce ALTI ardışık tur RED verdi ve hiçbiri ürün kusuru değildi.
  **KOZMETİK 2-5:** `poc §2.9` iddia listesi 7 → 10'a çekildi (DÜZELTME: bu satır ilk yazımında
  `DECISIONS`'ın da güncellendiğini söylüyordu — YANLIŞTI, `git show 4f27bef -- docs/DECISIONS.md`
  BOŞ döner. `DECISIONS` `panel-denetim-10`'da güncellendi; hata baş mühendisin kapanış turunda
  yakalandı); `STRUCTURE`
  `docsFreshness`'i üç iddiasıyla ve kapsam dışı listesiyle anlatıyor; `§8.3`'ün "erişilebilirlikle
  sınanır" ifadesi mekanizmayı yanlış adlandırıyordu ((a) kenar SIRASI, (d) düğüm ÖZELLİĞİ);
  iki test başlığı kanıtladığından fazlasını söylüyordu ("önizleme duyulur" — `master.gain=0`
  ile iddia yeşil kalıyor; "tap yapraktır" — o mutasyonu başka iddia yakalıyor) → başlıklar
  daraltıldı ve gerekçe yorumda.
- panel-denetim-8 — **baş geliştirici ONAY verdi** (0 MADDİ · 3 KANIT · 4 KOZMETİK); bulgular
  yine de kapatıldı, çünkü hepsi ölçer muhafızının KENDİ kanıt zincirindeydi.
  **KANIT-1 + KANIT-2 — sahte AudioContext, gerçek Web Audio'dan SAPIYORDU.** Denetçi bunu
  gerçek Chromium'da `OfflineAudioContext` ile ölçtü, ben de kendi koşumumla doğruladım:
  (a) `FakeNode.connect(dst)` ÇIKIŞ İNDEKSİNİ yok sayıyordu → `splitter.connect(right, 0)`
  yapıldığında 7/7 yeşil kalıyor, oysa gerçek tarayıcıda sağ analyser SOL kanalı okur ve
  `data-meter-db-r` kalıcı olarak yalan söylerdi; mono fikstürlü e2e bunu AYIRT EDEMEZ
  (ölçüm: iki çıkış da −6,02 dBFS). (b) `createChannelSplitter(n)` argümanı yok sayılıyordu →
  `createChannelSplitter(1)` ile 7/7 yeşil, oysa gerçek Chromium `IndexSizeError: output index
  (1) exceeds number of outputs (1)` fırlatır ve `ensureContext()` reddedilir — yani ÖNİZLEME
  HİÇ BAŞLAMAZ. Sahte artık ikisini de taklit ediyor: kenarlar `{dst, output, seq}` olarak
  kaydediliyor ve `output >= numberOfOutputs` fırlatıyor. Yeni iddia: sol analyser çıkış 0'dan,
  sağ analyser çıkış 1'den beslenir. NC ×2 kırmızı — ikincisi gerçek tarayıcının hata mesajını
  BİREBİR üretiyor.
  **KANIT-3 — §8.3'ün "(a)-(d) erişilebilirlikle sınanır" cümlesi (a)'yı kapsamıyordu.**
  (a) bir İNŞA SIRASI şartıdır ve oluşan grafta görünmez; denetçi iki satırı yer değiştirip
  7/7 yeşil kaldığını ölçtü. Sahte artık kenar SIRASINI da kaydediyor ve yeni bir iddia
  `master → destination` kenarının `master → tap`'ten ÖNCE kurulduğunu çiviliyor (NC kırmızı).
  Cümle daraltılmadı çünkü artık DOĞRU.
  **KOZMETİK'ler:** `CLAUDE.md` damgası bayattı — bayat damga sınıfının ALTINCI tekrarı;
  `docsFreshness`'in kapsam paragrafı `CLAUDE.md`/`STRUCTURE.md`/`WORKFLOWS.md`'yi artık ADIYLA
  kapsam dışı sayıyor ve boşluğun bilinçli olduğunu söylüyor (denetçi ölçtü: `CLAUDE.md`
  damgası 6 yıl geriye alınınca muhafız yeşil kalıyor). Sahtedeki ölü `createDynamicsCompressor`
  silindi. `MeterTapReading.windowSamples` üretiliyor ama hiç tüketilmiyordu ve yorumu
  ("ölçer ne ölçtüğünü bildirir") olmayan bir raporu iddia ediyordu → alan kaldırıldı.
  `fontCatalogue.ts`'te `browserStorage` çıkarımından kalan çift boş satır temizlendi.
  **Denetçinin ONAY'ı `205303d` içindir; bu commit onun önerdiği düzeltmeleri uygular.**
- panel-denetim-7 — **baş mimarın 4. turu RED verdi; muhafız KAYNAK TARAMASINDAN
  DAVRANIŞ TESTİNE çevrildi.** Bu tur denetim düzeni değiştirildi: üç rol de AYNI HEAD'i
  denetliyor (aralarında düzeltme yok, böylece bulgular zincirlenmiyor) ve her bulgu
  MADDİ / KANIT / KOZMETİK diye sınıflanıp "sürüm engelleyici mi?" sorusuna cevap veriyor.
  **MADDİ — atama envanteri KİMLİĞİ değil YAZILIŞI çiviliyordu.** Baş mimar iki bağımsız yol
  gösterdi, ikisini de kendim ölçtüm ve muhafız 7/7 YEŞİL kaldı: (a) `this['master'] = tap;`
  (köşeli parantez — regex `this.master =` şeklini arıyordu), (b) `master.disconnect();`
  (kenar EKLEME değil SİLME — süzgeç `disconnect`'i bilerek dışlıyordu). İkisi de
  `this.master = tap;` ile aynı semantik: önizleme SUSAR, ölçer miksi göstermeye devam eder.
  **Çözüm yamamak değil sınıfı kapatmak oldu:** `audioGraphTopology.test.ts` artık bir DAVRANIŞ
  TESTİ. Sahte bir AudioContext `connect`/`disconnect` çağrılarını kaydediyor,
  `ensureContext()` + `attachElement()` GERÇEKTEN koşuyor ve iddialar oluşan grafta
  ERİŞİLEBİLİRLİK soruyor: her klip kazancından `destination`'a yol VAR · `destination`'ın
  gelen kenarı TEK ve o düğüm kliplerin bağlandığı master · klip kazancından analyser'lara yol
  VAR (ölçer duyulan miksi ölçüyor) · analyser'dan `destination`'a yol YOK · tap explicit
  stereo · okuma float veriyle · `dispose` sonrası bağlı düğüm kalmıyor. **NEGATİF KONTROL ×6,
  altısı da kırmızı:** kimlik değişimi (nokta ve köşeli parantez yazılışlarıyla), kenar silme,
  girdi tarafından seri halka, analyser'ın `destination`'a bağlanması, explicit-stereo
  özelliğinin düşürülmesi. Kaynak-tarayan BEŞ sürümün beşi de ölçülerek kör çıkmıştı; kök
  neden dosya başlığında ve `poc §2.9`/`DECISIONS`/`STATE`/`§8.3`'te kayıtlı.
  **Yeni muhafız hemen gerçek bir kusur buldu:** `dispose()` analyser/splitter/tap'i söküyor
  ama `master`'ı hiç `disconnect` etmiyordu (baş mühendisin bir önceki turda "kayda değer"
  dediği asimetri) → `master` de listeye eklendi.
  **KANIT — §8.3'ün (d) maddesi (tap explicit stereo) HİÇBİR ŞEY tarafından çivili değildi.**
  Baş mimar üç satırı silip 7/7 yeşil kaldığını ölçtü; `data-meter-db-r` hiçbir e2e'de
  okunmuyordu, yani mono klipte sağ kanal sessizce ölebilirdi. İki kapı birden eklendi: yeni
  davranış testi (`tap.channelCount/Mode/Interpretation`) ve `meter.spec.ts`'e GERÇEK girdiyle
  `data-meter-db-r > -40` (fikstür MONO'dur; sağ kanalın dolması ancak upmix ile mümkün).
  **KOZMETİK'ler:** `DECISIONS.md` damgası bayattı (damga sınıfının 5. tekrarı) → `docsFreshness`
  aynı git'siz kalıpla DECISIONS'a genişletildi (damga ≥ tablodaki en yeni karar tarihi) ve
  muhafız eklenir eklenmez gerçek bayat damgayı yakaladı; `STATE.md` başlığı bir önceki commit'i
  adlandırıyordu; `WORKFLOWS.md` damgası kendi oluşturulduğu commit'ten (ae700cf, 2026-08-31)
  geriydi — panel turu dışı ama olgusal hata, düzeltildi; `CLAUDE.md`'nin "export'un limiteri
  yoktur" ifadesi §8.3'ü ters okutabiliyordu → "önizlemede limiter YOKTUR, limiter export'tadır".
- panel-denetim-6 — **baş mühendisin 3. turu RED verdi; bulgular kapatıldı.**
  **BLOKER — topoloji muhafızının ÜÇÜNCÜ kör noktası: envanter DÜĞÜM KİMLİĞİNE kördü.**
  Kenar envanteri, tanımlayıcılar ARASINDAKİ `.connect(` ifadelerini çiviliyor; bir
  tanımlayıcının HANGİ DÜĞÜMÜ gösterdiğini değil. `buildMeterTap` sonuna tek satır —
  `this.master = tap;`, içinde `.connect(` YOK — bütün klipleri tap'in üstüne taşıyor, gerçek
  master hiçbir sinyal almıyor: **önizleme SUSARKEN ölçer miksi göstermeye devam ediyor.**
  Kendi ölçümüm: muhafız **6/6 yeşil**, `tsc -b` temiz, 1546 birim testi yeşil, gerçek girdili
  `meter.spec` 3/3 ve `audio-export` yeşil. Muhafıza ATAMA ENVANTERİ eklendi (`this.master` /
  `this.meterTap` atamalarının tam listesi); NC: `+ "this.master = tap;"` ile kırmızı,
  `audioGraph.ts` ELLE geri kondu. **Daha önemlisi İDDİA DARALTILDI:** muhafızın kapsamı artık
  dört yerde (test başlığı, `poc §2.9`, `DECISIONS`, `STATE`) açıkça yazıyor —
  KANITLADIĞI: kaynağın hâlâ §8.3 topolojisini yazdığı; KANITLAMADIĞI: çalışan önizlemenin
  duyulur olduğu. Üç ardışık sürümün "yeterli" ilan edilip ölçülerek kör çıkması bu satırların
  gerekçesi olarak kayda geçti. Ayrıca §8.3 (NORMATİF) ölçer tap'inden HİÇ söz etmiyordu —
  dört maddelik normatif şart eklendi (tap destination'dan SONRA kurulur; hiçbir alt düğüm
  destination'a gitmez; `master`/`meterTap` alanları yeniden bağlanmaz; tap explicit stereo).
  **ORTA-1 — NC hash kayıtları, kuralı YAZAN commit'te ihlal edildi (sınıfın 4. tekrarı).**
  `docs/STATE.md` için yazdığım `7c9e8508…f80e` deponun HİÇBİR sürümüne uymuyor (kendim
  doğruladım: tüm tarih iki satır-sonu biçiminde tarandı, sıfır eşleşme) — NC anındaki ara
  hâldi, sonra dosyayı düzenlemeye devam etmiştim. **Kuralı beşinci kez yamamak yerine KANIT
  BİÇİMİ DEĞİŞTİRİLDİ:** prozada duran, kısaltılmış, satır-sonu biçimi belirsiz bir hash zaten
  okuyucu tarafından doğrulanamaz. NC kaydı bundan sonra (a) tam kırmızı imzayı, (b) geri
  koymanın ELLE yapıldığını, (c) commit diff'inde NC artığı bulunmadığını taşır — okuyucunun
  gerçekten doğrulayabileceği tek şey budur (`SKILLS §negatif-kontrol-protokolu` madde 5).
  **ORTA-2 — `docsFreshness.test.ts` dört damgadan yalnız birini koruyordu** ve kapsamını
  söylemiyordu. Kendi ölçümüm: `STRUCTURE.md` damgası 34 gün geriye alındığında dosya YEŞİL
  kalıyor. Kapsam paragrafı açıkça yazıldı (STRUCTURE ve tek tek SKILLS girdileri KAPSAM DIŞI —
  "dokunuldu mu" sorusu git geçmişi ister, bu muhafız git'e bakmaz) ve git'siz kurulabilen tek
  dürüst ek iddia eklendi: `SKILLS.md`'nin damgası, İÇİNDEKİ en yeni "Son doğrulanma"dan eski
  olamaz (NC: damga 2026-09-01'e çekildi → kırmızı).
  **ORTA-3 — parite tablosu iddiası §2.6'nın NORMATİF sınırlarını sessizce daralttı.**
  Efektif kırmızı çizgi artık `min(normatif tavan, gösterilen + 0,10)`: rampa 1,20 → 0,80,
  limiter 4,50 → 1,30, atempo 2,50 → 1,34. Sözleşme İÇİNDE kalan bir kayma da suite'i kırmızıya
  düşürür. Ödünç BİLEREK verildi (ölçerin "ölçülen" diye gösterdiği sayının sessizce bayatlaması
  daha zararlı) ama artık `poc §2.6`'da alıntı bloğu olarak YAZILI ve e2e mesajı "bu bir
  SÖZLEŞME İHLALİ DEĞİLDİR, gösterilen sayı bayat" diye yanlış teşhisi engelliyor.
  **DÜŞÜK'ler:** `panel-denetim-5`'in parite NC'si iddiayı İZOLE ETMİYORDU (tabloyu değiştirmek
  birim testini de kırmızı yapıyor; e2e'nin BENZERSİZ değeri "tablo sabit, ÖLÇÜM kayıyor"
  hâlidir) → izole NC koşuldu: önizleme zarfı %1,5 kısıldı, tabloya DOKUNULMADI → birim testleri
  **19/19 yeşil**, e2e kırmızı (`"tipik rejimlerde 0.7 dB" diyor ama ÖLÇÜLEN 0.83 dB`,
  `Expected: <= 0.80 / Received: 0.828`) ve `LIMITS` tavanları da yeşil kaldı — yani iddia
  gerçekten sözleşme tavanlarının göremediğini yakalıyor; `gain.ts` ELLE geri kondu.
  "30 Hz pencere" son defterden de temizlendi (pencere 2048 örnek = 42,7 ms, kadans ayrı şey).
  `audio-parity`'nin `src` import'unun `e2e/tsconfig` yan etkisi kayda geçti.
- panel-denetim-5 — **baş mimarın ÜÇÜNCÜ turu RED verdi; bulgular kapatıldı.**
  **BLOKER — topoloji muhafızının KALAN kör noktası + üç yerde evrensel over-claim.**
  `panel-denetim-3`'te muhafızı "dosya düzeyi" yaptım ve üç yere "seri bir tap bu dosyanın
  NERESİNDE yazılırsa yazılsın kırmızıya döner" yazdım. YANLIŞ: iddia yalnız ÇIKIŞ tarafını
  (`destination`) savunuyordu. Kendi ölçümüm — `connectElement`'te klip kazancı
  `gain → meterTap → master` diye yönlendirildi, yani tap duyulan zincirin SERİ HALKASI oldu
  (explicit-stereo upmix'i ve gain'i artık sinyalin üstünde): **5/5 YEŞİL**. Aynı şekilde
  `DECISIONS`'ın kendi reddettiği alternatif (önizleme zincirine `DynamicsCompressor`) da
  yeşil geçiyordu. Muhafız YASAK ŞEKLİ adlandırmayı bırakıp İZİN VERİLEN GRAFI adlandırıyor:
  yorumsuz kaynaktaki her `.connect(` çağrısı yedi kenarlık listeyle BİREBİR eşleşmeli
  (`source→gain→master→destination` + yaprak `master→tap→splitter→L/R`). NC ×2 — girdi tarafı
  (`+ "gain.connect(this.meterTap);" / + "this.meterTap.connect(this.master);"`) ve
  DynamicsCompressor (`+ "gain.connect(limiter);" / + "limiter.connect(this.master);"`), ikisi
  de kırmızı, `audioGraph.ts` md5 `693c7856…1ead` birebir geri. Over-claim cümleleri
  `poc §2.9` ve `DECISIONS`'tan kaldırıldı; kapsam açıkça yazıldı.
  **ORTA-1 — `panel-denetim-4`'ün NC md5'i teslim edilen dosyayı adreslemiyordu.** Kayıtta
  `e6732180…5cab3` yazıyordu; teslim edilen `meter.ts` `9592db1a…4ba7`. Üstelik anlatılan iki
  NC (`PARITY_DELTAS_DB` üzerinde) o sürümde KOŞULAMAZ — tablo orada yok. Bu, `panel-denetim-3`
  DÜŞÜK-1'de bulunup "kayıt nitelendi" diye kapatılan sınıfın BİR COMMIT SONRAKİ tekrarı.
  Kayıtlar düzeltildi ve kural `SKILLS §negatif-kontrol-protokolu`'na yazıldı (madde 5).
  **ORTA-2 — `PARITY_DELTAS_DB` "poc §2.6'ya çivili" DEĞİLDİ.** Hiçbir test belgeyi okumuyordu;
  birim testi literal-literale bakıyordu; `audio-parity`'nin `LIMITS`'i ise TAVAN (0,8/1,2/4,5/2,5),
  ölçülen değer değil. Ölçülen tipik fark 0,70 → 0,79'a kaysa ÜÇÜ DE yeşil kalır ve ölçer
  kullanıcıya bayat sayıyı "ölçülen" diye gösterirdi (kendi ölçümüm: belge tablosunu kaydırdım,
  birim testi 19/19 yeşil kaldı). `audio-parity.spec.ts` artık `PARITY_DELTAS_DB`'yi import edip
  her rejimin ÖLÇÜLEN `maxAbsDb`'sini tablo + 0,10 dB payla karşılaştırıyor — tablo HER tam
  koşumda yük taşıyor. Yalnız üst taraf çivili (ölçüm küçülürse kullanıcı kötümser sayı görür).
  NC: tipik 0,70 → 0,55 → `Expected: <= 0.65 / Received: 0.6967` kırmızı. Karar `DECISIONS`'a
  YENİ SATIR olarak eklendi (eksikti); birim testinin başlığı da "asıl çivi e2e'de" diye dürüstleşti.
  **ORTA-3 — damga bayatlığı, aynı sınıf ÜÇÜNCÜ kez.** `STATE.md` ve `STRUCTURE.md`'nin
  "Son güncelleme" satırları ile `SKILLS`'in iki girdisinin "Son doğrulanma" tarihleri
  gövdeleri güncellenirken geride kalmıştı. Bu kez sadece düzeltmedim: YENİ
  `src/docsFreshness.test.ts` — STATE'in damgası CHANGELOG'un en yeni gününden ESKİ OLAMAZ
  (CLAUDE.md P3'ün mekanik yarısı). NC: damga denetimin bulduğu hâle geri alındı → kırmızı
  ('damgası 2026-09-03, CHANGELOG'un en yeni günü 2026-09-04'), sonra ELLE geri kondu.
  **DÜŞÜK'ler:** `STATE`'in "açık iş olarak kayıtlı TEK teknik madde" cümlesi kapsamsızdı
  (ci.yml redis boşluğu da açık) → "panel turunun" diye daraltıldı; `CHANGELOG`'un
  `meter.spec (2/2)` kaydı bugünkü sayı sanılıyordu → tarihlendi (bugün 3/3); `git log`'un
  `aaef61c` gövdesinin çürütülmüş ÇIKARIMI hâlâ taşıdığı kayda geçti (commit mesajları
  düzeltilemez — geçerli kayıt CHANGELOG + `poc §2.9`).
- panel-denetim-4 — **baş mühendis YENİDEN denetimi RED verdi; bulgular kapatıldı.**
  Baş mühendisin ÖNCEKİ İKİ RED'i kapandı ve bunu kendi ölçümleriyle kanıtladı: klip mandalı
  testinin payı artık eşiğin 0,5 dB ALTINDA değil, +5,4 dBFS ile 5,4 dB ÜSTÜNDE (eski fikstüre
  göre 5,9 dB'lik gerçek kayma); "no-context" iddiası sıfır yayın üretilince kırmızıya dönüyor.
  **BLOKER — "headless rAF ~12 Hz" ÖLÇÜMLE YANLIŞ ÇIKTI.** Panel turunun TEK perf kanıtı olan
  §13'ün ortam kaydı, aynı belgenin §1/§3.6'sı ve `STATE.md` ile çelişiyordu. KENDİ ölçümüm
  (geçici prob spec'i, paketin kendi config'i, editör sayfası açık, 360 kare / ilk 60'ı ısınma):
  **p50 16,665 ms · p95 16,67 · min 16,66 · max 16,67 (n=299) = 60,0 Hz.** Yani headless bu
  düzenekte rAF'ı KISMIYOR. Eski gözlem silinmedi (o gün ölçülmüştü) ama "artık geçerli değil"
  diye tarihlendi; §3.6'nın headless dışlaması ASKIYA alındı ve o ölçümün headless'te yeniden
  koşulması AÇIK İŞ olarak yazıldı (bu turda YAPILMADI). `STATE.md`'nin "§3.6 ve §13 başlı
  Edge'de" cümlesi düzeltildi: §3.6 başlı Edge, §13 HEADLESS — ikisi ayrı rejim. Aynı yanlış
  sayı `SKILLS`, `poc §2.9`, `DECISIONS`, `PROGRESS` ve `meter.spec.ts` başlığından da
  temizlendi. Prob spec'i ölçümden sonra SİLİNDİ.
  **ORTA-1 — dürüstlük notunun "ilişkisel" muhafızı KÂĞITTANDI.** `panel-denetim-3`'te
  eklediğim `/EN B[ÜU]Y[ÜU]K[^.]*1,24 dB/` regex'i tek CÜMLEYE bakıyordu; noktalama değişince
  "ölçülen EN BÜYÜK … tipik rejimlerde 0,70 dB'dir" yalanı 17/17 ve 1541/1541 YEŞİL geçiyordu —
  kendi koşumumla doğruladım. Cümle artık VERİDEN türüyor: yeni `PARITY_DELTAS_DB` tablosu
  (tipik 0,70 · limiter 1,20 · hız 2x 1,24) + `largestParityDelta()`; üstünlüğü kimse elle
  seçmiyor. Testler de aynı tablodan hesaplıyor + tablo `poc §2.6` ölçümüne ayrıca çivili.
  NEGATİF KONTROL ×2: üstünlük elle seçilince `expected 0.7 to be 1.24`; tablo maksimumu
  düşürülünce ÜÇ iddia birden kırmızı. `meter.ts` md5 `9592db1a…4ba7` birebir geri — bu,
  TESLİM EDİLEN dosyanın hash'idir. (İlk yazımda `e6732180…5cab3` yazılmıştı; o, bir önceki
  commit'in sürümü ve anlatılan iki NC orada KOŞULAMAZ bile — tablo o sürümde yok. Aynı
  sınıf `panel-denetim-3` DÜŞÜK-1'de bulunmuş, bir commit sonra tekrarlamıştı; `panel-denetim-5`
  denetiminde yakalandı ve `SKILLS §negatif-kontrol-protokolu`'na kural olarak yazıldı.)
  **ORTA-2 — `ensureLoudAudio()` amacını kaybettiğinde SESSİZDİ.** Kardeşleri
  (`ensureSilentVideo`/`ensureBannerVideo`/`ensureMisalignedVideo`) ffprobe ile amacını doğrulayıp
  adıyla fırlatırken bu fikstür yalnız dosyanın VARLIĞINA bakıyordu; dosya koşumlar arasında
  önbelleklendiği için bayat/yanlış bir kopya kırmızıyı ÜRÜNE yıkıyordu. Artık `probeMeanVolumeDb`
  ile ölçüyor; eşik iki fikstürün ARASINA ölçülerek kondu (kendi ölçümüm: `e2e-loud-3s.m4a`
  mean −3,6 dB / max −0,0 dB · `e2e-muzik-3s.m4a` mean −7,1 dB / max −3,7 dB → eşik −5 dBFS).
  NEGATİF KONTROL: dosya sessiz kardeşiyle değiştirildi → artık ÜRÜN değil FİKSTÜR şikâyet
  ediyor (`"e2e-loud-3s.m4a" ortalama seviyesi -7.1 dBFS çıktı, beklenen ≥ -5 dBFS`);
  fikstür md5 `79601a04…9559` birebir geri.
  **DÜŞÜK'ler:** "30 Hz'de React state yok" iki defterde daha duruyordu (kadans ekrana bağlı) →
  "örnek başına" oldu; `timelineHeight.ts`'in bölüm yorumu `panel-denetim-1`'de taşınan
  sarmalayıcının ESKİ yerini adresliyordu → `lib/browserStorage.ts`; ölçer okumasının STATİK JSX
  metni (`Ölçüm yok`) e2e iddiasını markup'la karşılıyordu → yer tutucu ölçerin asla
  üretmeyeceği bir em dash oldu ve kural 3 okumayı da kapsayacak şekilde genişletildi
  (NC: motor yayın yaparken okuma yazımı kapatıldı → `Expected: "Ölçüm yok" / Received: "—"`;
  `AudioMeter.tsx` md5 `0b60be3d…7da1` birebir geri).
- panel-denetim-3 — **baş mimar YENİDEN denetimi RED verdi; bulgular kapatıldı**
  (review-gate kural 7: bir RED tek turda onaya çevrilmez, düzeltilmiş HEAD yeniden denetlenir).
  **BLOKER:** öldürülen boş-kanıt cümlesi `docs/STATE.md`'nin BAŞLIĞINDA hayatta kalmıştı —
  P3 kapanışı STATE'in gövdesini güncellemiş, yeni bir session'ın okuduğu İLK paragrafı
  güncellememişti (üstelik blok bayattı: "sırada denetim var" diyordu). Başlık `panel-denetim-2`
  gerçeğine çekildi ve parantez yapısal muhafız + kanıt sınırı beyanıyla değiştirildi.
  **ORTA-1 — muhafızın KÖR NOKTASI (kendi ölçümümle doğrulandı):** `audioGraphTopology.test.ts`
  yalnız `buildMeterTap` GÖVDESİNİ tarıyordu; tap'in çıkışı BAŞKA bir metottan (`ensureContext`)
  `destination`'a bağlanınca — yani §8.3'ün tam ihlalinde — dört iddia da YEŞİL kalıyordu
  (ölçüldü: 4/4 yeşil, editör 1540/1540 yeşil). Başlıktaki "tap seri yapılırsa kırmızıya döner"
  cümlesi kanıtlanandan fazlasını iddia ediyordu. Muhafıza DOSYA DÜZEYİNDE yük taşıyan yeni iddia
  eklendi: yorumlar silinmiş kaynakta `destination` kelimesi TEK satırda geçebilir ve o satır
  master'ın kendi bağlantısı olmalı. NEGATİF KONTROL ×2: (a) gövde dışı seri bağlantı → kırmızı,
  suçlu satırı adıyla söylüyor (`+ "this.meterTap?.connect(this.ctx.destination);"`);
  (b) YEREL TAKMA AD üzerinden bağlantı (`const d = ctx.destination; tap.connect(d)`) → üç iddia
  birden kırmızı. İkisinden de md5-birebir geri (`audioGraph.ts` `693c7856…1ead`). Başlık artık
  kapsamı AÇIKÇA yazıyor: iddia BU DOSYAYI kapsar; `meterTap` private olduğu için dışarıdan
  erişilemez. **ORTA-2 — "30 Hz" düzeltmesi üç yerde uygulanmamıştı:** `AudioMeter.tsx` başlığı
  ("The engine emits at 30 Hz"), `performans-raporu` §13 ve `STATE.md`. Üçü de tabana çevrildi
  (aynı turda DECISIONS "ekrana bağlı bir sayıyı sabit gibi göstermek" diyordu — kendi kuralını
  ihlal ediyordu). **DÜŞÜK'ler:** negatif kontrol md5'i teslim edilen dosyayı değil, NC anındaki
  (yorum düzeltmesinden ÖNCEKİ) sürümü adresliyordu → kayıt nitelendi ve teslim hash'i eklendi;
  `AudioMeter.tsx` başlığındaki kurallar 1→3→2 sırasındaydı ve "Two rules" diyordu (üç kural var)
  → sıralandı; dürüstlük notu testi üç sayının VARLIĞINI sınıyordu, "EN BÜYÜK" NİTELEMESİNİ değil
  → ilişkisel iddiaya çevrildi (NC: üç sayı da dururken niteleme 0,70'e kaydırıldı → kırmızı,
  `meter.ts` md5 `e6732180…5cab3` birebir geri).
- panel-denetim-1 / panel-denetim-2 — **panel turunun üç rollü kapanış denetimi** (baş mimar +
  baş mühendis + baş geliştirici; her biri kendi koşumlarıyla — review-gate kural 2: rapor kanıt
  değildir, iddia bizzat koşularak doğrulandı). **denetim-1 (baş geliştirici, ONAY + 3 ORTA +
  6 DÜŞÜK):** `feedbackCoverage` muhafızı YENİ dosyada KÖRDÜ (`fail('…')` arıyordu, `timecodeInput`
  ret yardımcısını `reject(…)` diye adlandırmıştı → çevirisiz kod eklenebilirdi); tarama
  `\b(?:fail|reject)\(` yapıldı ve kendi probumla İKİ iddiada birden kırmızı görüldü.
  "Playhead kelepçesi TEK FONKSİYONDAN" iddiası zaman kodu alanı için YANLIŞTI — alan saf kalmak
  için kelepçeyi kendi içinde uygular; docstring/DECISIONS gerçeğe uyduruldu (paylaşılan şey
  FONKSİYON değil SINIR DEĞERİ) ve iki yolun aynı belgede aynı sayıda durduğu birim testiyle
  çivilendi. `nominalFps` formülünün 4. kopyası şemaya `nominalFpsOf()` olarak çıkarıldı.
  DÜŞÜK'ler: fps ≥ 100 KAPSAM SINIRI yazıldı (`poc §2.10` + `rendering-semantics §1.5`),
  `storage()` sarmalayıcısı `lib/browserStorage.ts`'e çıktı, `clearLatch` prob yüzeyini de
  sıfırlıyor, klip mandalının POZİTİF yolu ilk kez sınandı (gerçek fareyle volume tavana → mandal
  → gerçek tıkla söndü), düğme tıkında çift `clearLatch` (stopPropagation), `panScrollY`
  dejenere girdide `clampScrollY`'den ayrışıyordu → devrediyor, `TransportTimecode` süreyi
  fırlatmayan `displayTimecode` ile basıyor, bayatlayan ordinal yorumlar silindi.
  **denetim-2 (baş mimar + baş mühendis, İKİ RED → kapatıldı):** (1) **Boş kanıt cümlesi** —
  "`audio-parity.spec.ts` dosyaya dokunulmadan yeşil kaldı = yaprak tap duyulan çıkışı
  değiştirmedi" iddiası VAKUMDU: o spec AudioGraph'ı bilinçli kullanmaz (offline context'te
  `createMediaElementSource` yok), topolojiyi sayfada yeniden kurar — denetimde gerçek
  `master.gain` 0'a çekilip (TAM SESSİZLİK) spec'in bit-birebir yeşil kaldığı ÖLÇÜLDÜ. Cümle
  DECISIONS/CHANGELOG/`poc §2.9`/PROGRESS'ten kaldırıldı, yerine YENİ `audioGraphTopology.test.ts`
  (kaynak-yapısal muhafız: master→destination tap'ten ÖNCE; tap gövdesinde `destination` YOK;
  bağlantı zinciri tam olarak master→tap→splitter→(L,R); `getFloatTimeDomainData` var,
  `getByteTimeDomainData` yok) + kanıtın SINIRINI söyleyen dürüst beyan kondu. Muhafız tap seri
  yapılarak KIRMIZI görüldü, md5-birebir geri. (Hash notu: o koşumdaki sürüm `30e6ad89…ff35`
  idi — NC, aynı commit'in kendi yorum düzeltmesinden ÖNCE koşuldu; teslim edilen dosya
  `693c7856…1ead`. Denetim bunu yakaladı, kayıt düzeltildi.) (2) **Klip mandalı e2e'si ~%50
  kırılgandı** — ölçüldü: normal test sesi klip kazancı 2,0'da bile önizleme tepesini eşiğin
  0,5 dB ALTINDA bırakıyordu, test ancak bir decode transient'iyle yeşile dönüyordu; yeni
  `LOUD_AUDIO_SPEC` fikstürü (`volume=8,pan=stereo|c0=c0|c1=c0`; ffmpeg `sine` −18,1 dBFS
  ölçüldü) + ön koşullar AYRI AYRI iddia ediliyor (isPlaying, `db-l > -6`) → kırmızı artık
  NEDENİNİ söylüyor. Ayrıca: ölçerin dürüstlük notu 0,70 dB diyordu ama §2.6 tablosunun ölçülen
  MAKSİMUMU hız 2x rejiminde 1,24 dB'dir (limiter 1,20) — üçü de nota ve birim testine kondu;
  tepe tutucunun düşüşü artık TABANDA duruyor (denetimde prob yüzeyinde −401 dBFS ölçüldü);
  "kadans 30 Hz" iddiası düzeltildi (33 ms bir TABANDIR, gerçek kadans rAF'e yuvarlanır:
  60 Hz ekranda 30 Hz, 165 Hz'de 27,5 Hz — ölçüldü); e2e'nin "no-context" iddiası STATİK JSX
  özniteliğiyle karşılanıyordu (sıfır yayınla da yeşildi) → varsayılanlar kaldırıldı, iddia
  gerçek bir yayını POLL ediyor; cetvel menüsünün "işaret ekle" hedefi de proje sonu kelepçesine
  bağlandı; `jkl-shuttle-frames` örnek ön koşulu ölçülmüş gerekçeyle 60→40.
- panel-3a / panel-3b — **ses ölçer paneli** (panel turu dilim 3, FRONTEND-only).
  **3a (ölçüm hattı, DOM'a sıfır dokunuş):** `audioGraph`'ta master'a PARALEL yaprak tap
  (`master → meterTap(explicit stereo) → ChannelSplitter(2) → analyserL/R`, çıkışlar
  bağlanmaz); `master → destination` aynen kalır — §8.3'ün "önizleme zincirine seri node
  konmaz" kuralı korunur. Yerleşimin muhafızı YENİ `audioGraphTopology.test.ts`'tir
  (master→destination tap'ten önce; tap gövdesinde `destination` yok; analyser'lar yaprak).
  `audio-parity.spec.ts`'in yeşil kalması bu iddianın kanıtı DEĞİLDİR ve öyle sunulmaz:
  o spec AudioGraph'ı kullanmaz, denetimde `master.gain=0` ile (tam sessizlik) yeşil
  kaldığı ÖLÇÜLDÜ (bkz. panel-denetim-2).
  **TARİHÇE UYARISI:** `git log` DEĞİŞMEZ. `aaef61c` (panel-3a) gövdesi çürütülmüş ÇIKARIMI
  hâlâ taşır: "audio-parity.spec.ts DOSYAYA DOKUNULMADAN yesil kaldi: yaprak tap'in duyulan
  cikisi degistirmediginin kaniti budur". (`d77fa05` yalnız OLGUYU söyler — "audio-parity ve
  a11y-smoke dosyaya dokunulmadan yeşil" — o cümle doğrudur, çürütülen ondan çıkarılan
  sonuçtur.) Commit mesajları düzeltilemez (rebase yasak, push bekliyor); geçerli kayıt
  BURASI ve `poc §2.9`'dur. `git log`'dan alıntı yapan biri bu satırı görmeli. `readMeter()` ctx yok/çalışmıyorken NULL döner (sıfır
  döndürmek "miks sessiz" yalanı olurdu). Yeni saf `core/meter.ts`: dBFS/bar/format,
  tepe tutucu (hold 1 s + 20 dB/s, DUVAR SAATİYLE — rAF kısılınca kare-tabanlı düşüş yalan
  söylerdi), klip mandalı (>1.0, tek pencere, duraklatma silmez) ve TÜM kullanıcı metinleri;
  §8.1 `linearToDb`/`dbToLinear` `core/gain.ts`'e taşındı (inspector re-export'la aynen
  çalışır). `engine.meter$` sözleşmesi + engineV1'de LOOP içinde ≥33 ms aralıklı örnekleme (TABAN; rAF'e bindiği için gerçek kadans 60 Hz ekranda 30 Hz, 165 Hz'de 27,5 Hz — ölçüldü) (tick model
  yokken erken döndüğü için gövdeye konmadı). Altı motor mock'u önce KIRMIZI görülüp
  güncellendi (`readMeter is not a function`).
  **3b (panel + kanıt):** `AudioMeter.tsx` timeline gövde satırının 3. hücresi (canvas wrap'ın
  KARDEŞİ — wrap'a canvas eklemek e2e'nin iki sözleşmesini birden yeniden yazardı); örnek
  başına React state yok (canvas + imperatif `textContent`), test yüzeyi 10 Hz throttled
  `data-meter-*` öznitelikleri, sıfırlama düğmesi YALNIZ mandal varken DOM'da (Tab bütçesi).
  Ölçer sessizliği gerekçesiyle söyler: "Ölçüm yok" / "Duraklatıldı" / "Ses kapalı" /
  "Engellendi". Kanıt: yeni `e2e/meter.spec.ts` (o gün 2 test, 2/2, üç ardışık koşumda kararlı; `panel-denetim-1`'de üçüncü test eklendi — bugünkü sayı 3/3) —
  jestten önce `no-context`, gerçek yükleme+oynatmada `db-l > -40`, duraklatmada `paused`,
  `End`+`j` ile `shuttle`. Negatif kontrol ×2 (tap kazancı 0 → seviye kırmızı; `no-context`
  ayrımı silinince ilk iddia kırmızı), md5-birebir geri. Perf A/B (`performans-raporu §13`):
  ölçerli p50 16,61 ms ↔ ölçersiz 16,65 ms, >33,3 ms kare 0. Dürüstlük kaydı: `poc §2.9`
  (ölçer ÖNİZLEME miksini ölçer; limiter asimetrisi, proxy≠orijinal, 4 çözücü tavanı).
- panel-2a / panel-2b — **timeline dikey yeniden boyutlandırma** (panel turu dilim 2,
  FRONTEND-only). **2a (mevcut kusurun düzeltmesi):** `scrollY` YALNIZ iki jestte (wheel +
  orta-tuş pan) yazılıyordu ve üst sınır formülü ikisine KOPYALANMIŞTI; sınırın kendisi
  değişince (track sayısı / gövde yüksekliği) yeniden kelepçeleme YOKTU — Ctrl+Z ile track
  silince altta boş şerit ve BİR SATIR kaymış hit-test doğuyordu. `pan.ts`'e yatay ikizin
  dikey karşılığı iki saf fonksiyon (`maxScrollY`, `clampScrollY`), `TimelinePanel`'e TEK
  yazma yolu `applyScrollY` + `[viewport.h, tracks.length]` bağımlı yeniden-kelepçe efekti;
  iki kopya formül silindi (`panScrollY` korundu — sınırı artık aynı fonksiyondan alır).
  Yeni `e2e/timeline-scroll-clamp.spec.ts` commit ÖNCESİ kırmızıydı (HEAD koduyla koşuldu:
  başlık kolonu `Expected 684.5 / Received 545.5` — 139 px bayat kaydırma; hit-test
  `Expected ["a723dc55-…"] / Received []`). **2b (özellik):** yeni
  `features/timeline/timelineHeight.ts` — ÜÇ ALAN AYRIMI: `preferredPx` KULLANICI NİYETİ
  (localStorage `videoedit.timelineHeight.v1`, YALNIZ commit anında yazılır), `headerPx` ve
  `availablePx` ÖLÇÜLEN efemeral değerler; efektif yükseklik saf `clampTimelineHeight`'ten
  gelir (min = ölçülen başlık + cetvel + bir tam satır + yeni-track bölgesi; max = alan −
  160 px oynatıcı payı; sonuç ayrıca alanı aşamaz; depolama boşken 280 px = eski grid satırı).
  Pencere küçülünce efektif değer kelepçelenir ama NİYETE dokunulmaz. Yeni
  `TimelineResizeHandle.tsx` (panelin içinde, canvas sarmalayıcısının DIŞINDA; pointer-capture
  + üçlü çıkış: pointerup/lostpointercapture = commit, pointercancel/Escape = abort;
  pointermove'lar rAF ile birleştirilir — kare başına ≤1 store yazımı, sürükleme boyunca
  localStorage I/O YOK; `role="separator"` + ok/Shift+ok/Home/End, yalnız ele alınan tuşlarda
  preventDefault+stopPropagation). `App.tsx`: `AppContent` → `EditorGrid` children-as-props
  (yükseklik selector'ı yalnız grid'de; panel elementlerinin kimliği değişmediği için dört
  panel yeniden render OLMAZ), `grid-rows-[…280px]` sınıfı yerine inline `gridTemplateRows`
  (Tailwind JIT çalışma zamanı değeri üretemez); yatay düzlem (grid-cols + tüm yerleşimler)
  AYNEN korundu. `TimelinePanel`: başlık RO ile ölçülür, wrap `data-testid="timeline-canvas"`
  aldı (dört e2e yerinde aranan ama kodda olmayan dal canlandırıldı), `measure()` DEĞİŞMEYEN
  canvas boyutunu yeniden atamaz ve `setViewport` kimlik korur. Yeni `e2e/timeline-resize.spec.ts`
  (8 test, gerçek fare/klavye): asıl sözleşme — 120 px büyütmede klibin x/genişliği ve
  pxPerUs/scrollUs DEĞİŞMEDİ; min/max'ta durma; reload sonrası korunma + anahtarın değeri;
  boyut sonrası sürükleme/tıklama doğru hedefi vuruyor; scrollY yeniden kelepçeleniyor;
  klavye adımları playhead'i OYNATMIYOR; varsayılan 280. Sızıntı önlemi: e2e context'i
  worker-scope olduğu için anahtar her testin önünde ve sonunda silinir (spec paketin
  ortasında koşarken sonrası yeşil). NEGATİF KONTROL ×3 (hepsi md5-birebir geri):
  (1) `clampTimelineHeight`'ten `Math.max(min,…)` çıktı → T2 `Expected 170 / Received 3.75`
  (+1 birim kırmızı); (2) 2a yeniden-kelepçe efekti söküldü → `timeline-scroll-clamp`
  (`Expected 684.5 / Received 545.5`) ve T6 (`Expected 484.5 / Received 345.5`) kırmızı;
  (3) tutamağın `stopPropagation`'ı silindi → T7 `"ArrowUp" dispatcher'a SIZDI:
  Expected 5000000 / Received 0`. PERF (başlı Edge, 165 Hz — `performans-raporu §3.2`
  yöntemi): boyutlandırma fazı 3 tekrar, n=555/534/529 kare, p50 6,1 ms · p95 6,1-6,3 ms ·
  max 6,6 ms · >33,3 ms 0 (bütçe p95 ≤ 16,7 ms ve ≤%1 — karşılandı, M1 gerekmedi).
  Defter: `PROGRESS.md` §Özellik turu 2 dilim 2.
- panel-1a / panel-1b — **elle zaman kodu girişi** (panel turu dilim 1, FRONTEND-only):
  transport çubuğundaki playhead göstergesi düzenlenebilir bir alan oldu; yazılan zaman kodu
  playhead'i o ana götürür. **1a (saf çekirdek):** yeni `features/player/timecodeInput.ts`
  (`parseTimecode` / `commitTimecodeText` / `displayTimecode` — DOM'suz, hiçbir girdide
  fırlatmaz) + `playerFeedback.ts` Türkçe tablosu. Dilbilgisi kullanıcı kararına göre SAAT
  okumasıdır (`1:30:00` = 1 sa 30 dk); baştaki alan takvim-serbest (`90` = 90 sn), iç alanlar
  katı (MM/SS ≤ 59, FF < nominal fps — `maxFrame` mesajda söylenir), `;` ayrı kod alır,
  sonuç 24 saati aşamaz. Hedef µs = `formatTimecode`'u metne eşitleyen EN KÜÇÜK tamsayı
  (`ceil(kare·den·1e6/num)`, taşma-güvenli): `frameToUs` half-up olduğu için 30/1'de kare 1'i
  33 333 µs yapar ve `formatTimecode(33333)` "00:00:00:00" der (`time-vectors.json` pini) —
  alan yazılanı kaybederdi. `feedbackCoverage` muhafızına yeni kaynak+tablo dosyası eklendi.
  **1b (tel + kelepçe):** yeni `TransportTimecode.tsx` (Fragment döndürür — transport çubuğuna
  YENİ SATIR eklemez, sahne yüksekliği ve gizmo kökeni kaymaz); odakta ayna DONAR, Enter
  commit eder ve odak kalır, dokunulmamış blur commit ETMEZ (userSeekSeq artışı shuttle'ı
  iptal ederdi), Escape geri alır, Enter'da ret metni KORUR + kırmızı gerekçe yazar.
  Yazım `setPlayheadUs(t, 'user')` ile (tek yazım yolu; `'engine'` duraklamışken sessizce
  düşer — negatif kontrolde ölçüldü). Kelepçe kullanıcı kararıyla TÜM yollara yayıldı:
  yeni `timelineOps.clampPlayheadUs` (üst sınır `projectEndUs`) alan + dispatcher ok/step +
  cetvel scrub'ı için TEK tanım; boş projede üst sınır 0'dır (bilinçli, teste çivili).
  Negatif kontrol ×4 (hepsi md5-birebir geri): ceil→half-up → e2e off-by-one `Expected 33334 /
  Received 33333`; `'user'`→`'engine'` → e2e `Expected 5000000 / Received 10000000` (yazım
  sessizce düştü); kelepçe söküldü → `Expected 82000000 / Received 90000000`; notice kodu
  tablodan silindi → `feedbackCoverage` 2 test kırmızı. Doküman: `rendering-semantics §1.5`
  sözde-kodu `frameFromUs` (half-up) diyordu — kod/C#/vektör FLOOR kullanıyor, satır düzeltildi
  ve ters yön (girişte ceil) yazıldı; kod DEĞİŞMEDİ. Defter: `PROGRESS.md` §Özellik turu 2.

## 2026-09-02
- ozellik-fix-pin — dip-cover sahiplik bekçisi birim pinleri (bağımsız denetim bulgusu):
  `ownedSlotFrame`'in clipId+epoch kontrolü `!frame`'e zayıflatıldığında 4 mevcut birim +
  e2e jkl-shuttle-frames YEŞİL kalıyordu (bekçi kanıtsızdı — denetçi ölçümü). engineV1
  DEĞİŞMEDİ; `engineV1.scrub.test.ts`'e blok 5 (+3 test, 4→7): yabancı clipId → null,
  eski epoch (slot geri dönüşümü) → null, doğru sahiplik → kare kullanılır (pozitif).
  Negatif kontrol ×2 (md5-birebir `25c79aed…25aa`): clipId dalı söküldü → yalnız clipId
  pini, epoch dalı söküldü → yalnız epoch pini tam imzayla KIRMIZI. Kapılar: editör
  vitest 1445 (1442→1445) · tsc -b + prod build temiz · Playwright jkl-shuttle-frames +
  jkl-shuttle 3/3. Defter: `PROGRESS.md` §Özellik turu satır F (EK PİN notu).
- ozellik-fix — J geri taramada "yabancı kare" (kullanıcı hata bildirimi; teşhis ayrı ajanın
  ölçümü, repro + düzeltme + doğrulama bu session'ın KENDİ koşumu): her scrub seek'i elementin
  readyState'ini 62-86 ms HAVE_CURRENT_DATA altına düşürüyor ve `videoDrawItem` o pencerede
  null dönüp katmanı ARKA PLANA düşürüyordu (geri taramalarda örneklerin %55-61'i siyah flaş,
  ~160 ms periyot; kusur J'ye özgü değil — gerçek fare geri scrub'ı aynı, İLERİ oynatma 0);
  ek: paused upload damgası currentTime'ın set-anı değerini okuduğundan taze kare hiç
  yüklenmiyordu (one-behind) ve geriye preload olmadığından sınırda ~240 ms soğuk pencere.
  ÇÖZÜM (frontend-only; engineV1 + scheduler): (1) `SlotFrame` sahipliği (clipId+epoch+damga+boyut)
  ile DIP-COVER — çukurda slotun son yüklenen karesi çizilir, sahiplik el değiştirdiyse ASLA
  (kısa arka plan > yabancı kare); (2) `'seeked'` damga düşürme (NaN) — taze kare sonraki rAF'ta
  yüklenir; (3) `PRELOAD_LOOKBEHIND_US` (1 sn, ileri double-buffer'ın aynası) — az önce biten
  klip kendi SONUNDA ılık + applyScrub/preciseSeek aktifleşen ısınmış elementten seek-ÖNCESİ
  taban yakalama (kaynak-penceresi bekçili). SONUÇ: teşhis probunun 6 rejiminde (sınır/orta ×
  1x-8x + iki kontrol) siyah=0 yanlisRenk=0 koşu=0 (önce: sinir-2x 127/202 … fare-scrub-geri
  64/106); dürüst kalan maliyet 8x'te rAF ~25 fps (içerik yeniliği zaten 80 ms throttle'la
  12,5 Hz — poc §2.8). Kalıcı kalkan: `engineV1.scrub.test.ts` (4 pin) + scheduler lookbehind
  3 pin + gerçek-klavye `e2e/jkl-shuttle-frames.spec.ts` (renk-ayrımlı gerçek medya, 12,8 sn).
  Negatif kontrol ×3 (md5-birebir): dip-cover söküldü → 2 birim + e2e '148 örnekte siyah=90'
  KIRMIZI; seeked-düşürme söküldü → one-behind birimi 'expected 2 to be 3' KIRMIZI; lookbehind
  söküldü → 3 scheduler pini + sınır birimi KIRMIZI. Güncellenen eski pinler (yeni politika):
  transition negatif kontrolü ('a elementini kaybeder' → 'handle materyaline İLERLETİLMEZ,
  element geriye-preload olarak ılık') + scheduler transition negatif kontrolü (yalnız
  priority-0 pinlenir). DECISIONS satırı + poc-bilinen-sinirlar §2.8 düzeltme paragrafı.
  Defter: `PROGRESS.md` §Özellik turu satır F.

## 2026-09-01
- ozellik-duzeltme — özellik turu kapanış denetimi bulguları (ONAY + 3 bulgu, üçü KAPANDI):
  (1) deleteTrack kilitli link-eşin bağını sessizce siliyordu → kilitli-eş varsa track silme
  TÜMDEN RED `'linked clip is on a locked track'` (deleteClips simetrisi; `trackDeleteBlockReason`'a
  kural — menü gated sözleşmesiyle otomatik gri; kilitsiz-eş bağ temizliği AYNEN; +1 birim +
  guardPaths (f) ayrışmazlık çifti; negatif kontrol md5-birebir). (2) Ctrl+X yarım-çift: pano
  yalnız seçileni alıyor, silme çifti düşürüyordu (ses içeriği kes-yapıştır akışında kayıptı) →
  cutClips kopyayı da LINK-kapanışlı kümeden yapar: pano 2 klip, yapıştırmada remint taze ortak
  linkId; Ctrl+C BİLİNÇLİ asimetrik — kopya belgeden eksiltmez (+3 birim + gerçek-klavye
  Ctrl+X→Ctrl+V e2e `link-clips.spec.ts`; negatif kontrol md5-birebir). (3) CLAUDE.md yetenek
  haritası 5 timeline özelliğiyle senkronlandı (davranış sıfır). DECISIONS 2 satır. Defter:
  `PROGRESS.md` §Özellik turu satır D.
  TUR KAPANIŞI — 5 özellik / 7 dilim tamam): J tekrar basışları kademeyi 1→2→4→8 katlar
  (5. basış 8'de kalır; katlama bir SONRAKİ tikin deltasından itibaren işler — geçmiş
  dilim yeniden fiyatlanmaz); J VE L'ye e.repeat muhafızı (basılı tutmak OS
  auto-repeat'iyle kademeyi fırlatmaz — L'de küçük savunulabilir davranış değişikliği,
  DECISIONS satırında anıldı); rozet dinamik ('Geri tarama {n}x — ses kapalı') ve AYNI
  bileşen L kademesinde 'İleri {n}x' der (yalnız oynarken); shortcutsHelp J/K/L satırı
  güncel. +6 birim (shuttle merdiven matrisi + 2x hız dürüstlüğü; dispatcher: J merdiveni,
  J(repeat)/L(repeat) bumplamaz ama true döner, L 4x'teyken J shuttle 1x'ten; editör
  1423→1429) + e2e ikinci-J '2x' rozet iddiası. Negatif kontrol md5-birebir: katlama
  sabit 1'e söküldü → 4 birim `expected 1 to be 2` + 2x hız dürüstlüğü tam imza + e2e
  `unexpected value "Geri tarama 1x — ses kapalı"` KIRMIZI. Kayıtlar: DECISIONS satırı
  (motor DEĞİL dispatcher-shuttle; reddedilenler: motor API'sine yön — <video> negatif
  playbackRate oynatamaz + üç kritik bölge; SCRUB_THROTTLE_MS düşürmek; previewRate$
  rozetini yeniden kullanmak; geri alma: v2 WebCodecs gerçek reverse getirince J motora
  bağlanır), tasarım 01 §3.4 satır+dipnot güncel, poc-bilinen-sinirlar §2.8 yeni.
  Defter: `PROGRESS.md` §Özellik turu.
- ozellik-5a — J sessiz geri tarama: transport store + tek-hız shuttle (özellik turu
  dilim 5a, FRONTEND-only; `engineV1.ts` dokunulmadı): YENİ `shortcuts/shuttle.ts` —
  33 ms metronom, İÇ FLOAT akümülatör (kare-yapışık store değerinden geri hesap
  yuvarlanma-stall'ı üretirdi), her yazım kare-ızgara-yapışık `setPlayheadUs('user')`
  → mevcut scrub yolu kareyi getirir; motor paused kaldığı için sessizlik YAPISAL.
  `useTransportStore` ({forwardRate, shuttleRate}) — dispatcher'ın forwardRate
  modül-let'i store'a taşındı. İptal tik içinde: isPlaying / dış user seek (userSeekSeq
  farkı) / BOF'ta TAM 0 + dur. Geçiş matrisi: J=pause+shuttle (repeat yutulur; eski
  stepSeconds(-1) dalı silindi), K=dur+pause, L=dur+ileri 1x'ten, Space=dur AMA
  OYNATMAZ (NLE uzlaşımı). PlayerPanel rozeti `transport-shuttle-note` ('Geri tarama
  1x — ses kapalı' + v2 dürüstlük title'ı; previewRate$ rozeti kullanılmadı — plan
  reddi). +9 birim (shuttle 4 + dispatcher matrisi 5; editör 1414→1423) + YENİ gerçek
  klavye `e2e/jkl-shuttle.spec.ts` (2 test: J iki örnekte kesin küçülme + isPlaying
  false kalır + rozet; K sabitler; L ileri; BOF tam 0 + rozet kalkar). Negatif kontrol
  md5-birebir: BOF kelepçesi söküldü → birim `expected 1 to be null` + e2e rozet
  `unexpected value "visible"` kırmızı. Defter: `PROGRESS.md` §Özellik turu.
- ozellik-4 — klip grupları: Ctrl+G grupla, grup birlikte taşınır (özellik turu dilim 4,
  FRONTEND-only): `groupClips`/`ungroupClips` + blockReason'ları (timelineOps — tek modül).
  Grupla: önce LINK kapanışı (linkli üyenin eşi OTOMATİK dahil — invariant kural 10'un grup
  kolu böyle KURULUR), kapanış sonrası <2 klip → 'need at least two clips to group', kilitli
  üye → 'track is locked'; kapanmış kümeye TAZE tek groupId (BİRLEŞTİRME semantiği: üyelerin
  eski üyelikleri ezilir; eski gruplardan tek kalan üyenin groupId'si AYNI mutate'te
  temizlenir — kural 11, tek undo). Dağıt: seçimin dokunduğu HER grubun TÜM üyelerinden
  groupId silinir (üye çıkarma değil grup dağıtma — tek üyeli ara durum hiç doğmaz); linkId
  DOKUNULMAZ (bağ gruptan bağımsız yaşar). Menü: 'Grupla' (Ctrl+G) + 'Grubu dağıt'
  (Ctrl+Shift+G) Bağla bloğunda, gated sözleşme (disabled = op blockReason'ı); dispatcher
  Ctrl+G/Ctrl+Shift+G (docMutationAllowed kapısından) + shortcutsHelp satırı; drawTracks
  gruplu klipte 2px ÜST ŞERİT (satır yüksekliği/geometri değişmedi). Taşıma kod değişikliği
  GEREKMEDİ: dilim-2 'move' kapanışı groupId'yi zaten işliyordu — karışık AV grupta bölüm
  kapsamlı delta dahil grup-odaklı birim pinleriyle sabitlendi. +21 birim (timelineOps +14,
  guardPaths (e) ayrışmazlık çiftleri +5, dispatcher +2; editör 1393→1414) + yeni gerçek
  fare/klavye `e2e/group-clips.spec.ts` (2 test: böl→marquee→Grupla→ortak groupId; TEK
  seçili üye sürüklenince ÜÇÜ kayar; tek üye Delete → kalan ikili grup yaşar; Ctrl+Shift+G
  sonrası yalnız biri kayar; Ctrl+A+Ctrl+G klavye yolu; gri öğe data-block-reason + Türkçe
  title). Negatif kontrol ×2 md5-birebir (kapanış genişletmesi söküldü → 4 birim + e2e tam
  imza; eski-grup temizliği söküldü → MERGE birimi dev doc kapısının kural-11 ihlaliyle
  kırmızı). Defter: `PROGRESS.md` §Özellik turu.
- ozellik-3 — otomatik AV ayrımı: video ekleme linkli çift klip (özellik turu dilim 3,
  FRONTEND-only): SAF planlayıcı `planAddClipFromAsset` EXPORT edildi — commit
  (`addClipFromAsset`), timeline ekleme hayaleti (insertTargetFor) ve blok gerekçeleri AYNI
  planı okur ("ghost geçerli dedi, drop reddetti" imkânsız). Karar tablosu: image/audio TEK
  klip; video+hasAudio=true ÇİFT klip (video yarısı `audio:null` + detachAudio formülüyle ses
  ikizi + ORTAK taze linkId, TEK mutate = TEK undo, İKİSİ birden seçili);
  video+hasAudio=false TEK klip ve `buildClipFromAsset` artık `audio:null` yazar (detach
  menüsü 'clip has no embedded audio' ile doğru grilenir); hasAudio bilinmeyen TEK klip
  gömülü sesle (ikiz üretmek ölçülmüş 422 tuzağı). Ses yerleşimi: ilk kilitsiz+aralıkta boş
  audio track; yoksa YENİ track (partisyon: en alta) + notice 'audio placed on a new track'
  (balon yolu = TRANSITION_DROPPED emsali; drop işleyicisi artık reportOp'tan geçer). KISMİ
  BAŞARI YASAK: plan tavanı aşarsa (frontend `MAX_TRACKS=50`, sunucu aynası) TÜMÜ RED
  'track limit reached'; toplam yeni-track sayısı hesaba girer (49→51 köşesi kapalı). Çoklu
  insert ghost'u (DragVisual.insert `ghosts[]` — AV asset video satırı + ses satırı).
  +14 birim (editör 1393; karar tablosu, tek undo, yerleşim politikası, tavan, plan↔commit
  ayrışmazlığı) + yeni gerçek-fare `e2e/auto-av-add.spec.ts` (2 test: çift doğum + ses
  track'i en altta + notice balonu + tek Ctrl+Z + tekrar ekle→birlikte taşıma; sessiz
  video/görsel negatifleri). Gerçek-medya spec varsayım taraması: media-upload, library-dnd,
  detach-audio-silent (sesli senaryo artık oto-ayrılmış çift), export-flow,
  export-progress-hub, progress-fallback, frame-grid, guard-paths (bölme 4 klip),
  library-manage (kullanım sayacı 2 klip) yeni davranışa güncellendi. Negatif kontrol ×2
  md5-birebir (çift üretim söküldü → 8 birim + e2e tam imza; kısmi-başarı muhafızı söküldü →
  2 'tümü RED' birim testi kırmızı). Defter: `PROGRESS.md` §Özellik turu.
- ozellik-2 — linkId çekirdeği: link/unlink + sil/böl/taşı kapanışı (özellik turu dilim 2):
  SAF kapanış yardımcısı `expandSelectionForOp` ('link' = eş; 'move' = grup üyeleri + eşler,
  K3 sayesinde tek geçiş) OP İÇİNDE uygulanır: deleteClips (eş kilitli track'teyse TÜM silme
  RED — yarım silme dangling linkId üretirdi; küçülen grup temizliği aynı mutate), deleteTrack
  (eş bağı + grup temizliği), splitAtPlayhead (çift taraf bölünürse sağ yarılara taze ORTAK
  linkId; ikinci yarı her zaman bağsız doğar, groupId kalır), moveClips (girişte 'move'
  kapanışı + planMoveClips'te BÖLÜM-KAPSAMLI trackDelta: anchor'ın bölümü şerit değiştirir,
  diğer bölüm kendi şeridinde yatay kayar — CapCut davranışı; tip kapısı kalır).
  `linkClips`/`unlinkClips` + sağ tık 'Bağla'/'Bağlantıyı kaldır' (blockReason sözleşmesi +
  5 Türkçe çeviri); duplicate/paste `remintLinkAndGroupIds` (çift kopya kendi içinde bağlı,
  yarım kopya bağsız); detachAudio çifti bağlı doğurur (zaten-bağlı videoda detach RED —
  invariant koruması); trim bağa DOKUNMAZ (kullanıcı kararı, negatif pinli); zincir rozeti
  (drawTracks, yükseklik değişmedi); appBridge linkId/groupId. +29 birim (editör 1379) +
  yeni gerçek-fare `e2e/link-clips.spec.ts` (2 test) + detach-audio-silent linkId satırı.
  Negatif kontrol ×2 md5-birebir (delete kapanışı → birim+e2e tam imza; bölüm-deltası →
  'track type mismatch'). Defter: `PROGRESS.md` §Özellik turu.
- ozellik-1 — track partisyonu: video/overlay üstte, ses altta (özellik turu dilim 1):
  `insertTrackPositioned` op-politikası (audio→en alta, video/overlay→ilk audio'nun önüne;
  overlay klip-ekleme yolu bilinçli unshift'te — en üst katman kararı korunur, indeks 0
  partisyonu zaten sağlar); `trackMoveBlockReason` ihlal takasına
  'audio tracks stay below video tracks' (düzeltici yön serbest — karışık eski belge kullanıcı
  taşımasıyla düzelir, otomatik normalize yok); görsel ayraç YÜKSEKLİK EKLEMEDEN (canvas'ta
  TRACK_GAP içine 1px çizgi + DOM başlıkta border-top; geometri formülleri değişmedi).
  +8 birim test (timelineOps 65) + track-manage.spec'e gerçek-fare partisyon senaryosu.
  Negatif kontrol: partisyon düz push'a döndürüldü → 5 test tam imzayla kırmızı →
  md5-birebir geri. Defter: `PROGRESS.md` §Özellik turu.
- ozellik-0 — şema linkId/groupId + link-grup-kind invariant pass + codegen (özellik turu
  dilim 0): MediaClipSchema'ya opsiyonel `linkId` (AV çifti bağı), klip tabanına opsiyonel
  `groupId`; invariants.ts'e kural 10-12 + YENİ doküman-geçişli pass
  `checkLinkAndGroupInvariants` (link TAM 2 klip = bir video + bir audio; grup ≥2 üye; link
  eşleri özdeş groupId; kind↔track-tipi savunması). schemaVersion=1 kaldı; codegen zinciri
  (timeline.schema.json + TimelineContracts.g.cs: nullable LinkId/GroupId) koşuldu; +13
  paket testi (235), eski doküman değişmeden-geçerli pini; negatif kontrol md5-birebir.
  Dört kapı + prod build yeşil (backend 1626/1626 skip 0). Defter: `PROGRESS.md` §Özellik turu.
- gelistirme-3 #3 — export perf 2. turu (baş mimar sözleşme kararıyla; üç bacak, üç commit +
  kapanış): **Bacak 0** — eski perf fixtürünün çifte kusuru (overlay'ler örtülü + tuval dışı)
  kaynağından doğrulandı; compReal/compCovered/compDikey fixtürleri kuruldu, **≥2x ölçütü
  gerçekçi compReal-1080p'ye yeniden demirlendi** (taban 38,3 s / 1,57x). **(b) colorAdjust
  füzyonu** (`e364f2a`): aşama 1-4 kanal-başına TEK lutrgb bileşik ifadesi (DOUBLE +
  aşama-başına clip + tek nihai round — ölçümle seçildi: normatif double tabloya 33 vakanın
  24'ünde BİREBİR, kalanı ±1 LSB; eski↔füzyon ≤ ±3 LSB golden'la çivili); rig p50 −7,1 s,
  canlı 41,4→35,5 s. **(c) taban-tuval atlaması** (`56abab7`): §2.6 örtücü yüklemi (taze
  worker-probe olguları: aspect çapraz-çarpımı + SAR=1 + alfasız pix_fmt izin listesi) ile
  en alt tam-örtücü run'da taban tuval + ilk overlay düşer — çıktı BAYT-AYNI (çift-varyant
  canlı golden + g3b↔g3c sha256 eşitliği); canlı 35,75→32,3 s. **(a) örtülen-katman budaması**
  (`6237fcf`): üstteki tek örtücünün penceresi kapsayan run'ın video zinciri üretilmez (ses +
  girişler AYNEN — örtülen duyulur); daraltılmış SourceWidth doktrini + §2.6 bayt-aynılık
  normu; canlı compCovered 28,35→**20,1 s (2,99x)** + g3c↔g3d sha256 eşit; canlı grafik
  budanan zincirlerin yokluğunu gösteriyor. **(d) N-paralel ERTELENDİ** (DECISIONS).
  Nihai matris (§12.5): compReal 1,94x/**1,85x**/1,41x, compCovered 3,23x/2,99x/1,96x,
  dikey 2,10x (ilk ölçüm), eski fixtür 2,90x. Hedef compReal-1080p'de karşılanmadı (1,85x) —
  (d) açılmadan kullanıcıya soruldu (STATE). Negatif kontroller: (b) clip düşürme → 2 kırmızı;
  (c) koşul tersleme → 27 kırmızı; (a) kapsama→kesişme → 5 kırmızı (bayt golden'ı tam
  sözleşme mesajıyla); hepsi md5-birebir geri. Yeni kalıcı muhafızlar: füzyon zarf golden'ı,
  2 çift-varyant bayt-aynılık golden'ı, örtme yüklem envanteri (ExportCoverOptimizationTests),
  pix_fmt/SAR parser testleri, 2 yeni snapshot fixtürü. Dokümanlar: rendering-semantics §4.1
  yazılış kutusu + YENİ §2.6; CompiledExport daraltılmış doktrin; DECISIONS +3 satır;
  performans-raporu §12; backlog "AÇIK KALANLAR" kapandı.

## 2026-08-31
- gelistirme-3 #2 — üç alt iş, üç commit: **(2a) asset silme çapraz-sekme senkronu**: SoftDelete
  artık sahibinin `user:{id}` feed grubuna SÜREÇ-İÇİ `assetRemoved` yollar (Contracts tek tanım
  `AssetRemovedMessage`; Redis turu yok — olay hub'la aynı süreçte); istemci satırı liste
  cache'lerinden cerrahiyle düşürür + yalnız kotayı invalidate eder + noticed setiyle geç worker
  mesajının diriltmesini keser. Kusur HEAD'de yeni spec'le yeniden üretildi (pasif sekme 30 sn
  görmedi); kapanış `e2e/library-crosstab-delete.spec.ts` (satır 33 ms'de odak/yenilemesiz,
  silme sonrası liste GET 0) + IDOR birim aynası; WS-engelli yedek yol değişmedi.
  **(2b) ProjectRevisions retention**: `ProjectRevisionRetentionJob` (saatlik recurring
  `revision-retention`) — proje başına son 50 Auto + 24 sa'ten eskilerde saat kovasına inceltme;
  Checkpoint/PreRestore hiç silinmez (sorgu + silmede çifte Kind kilidi); sabitler
  `RevisionRetention__*` config'i (açılışta Validate + etkin-değer logu). Önce ölçüldü: dev DB'de
  15 861 Auto / 29 MB birikmişti; canlı tetiklenen iş seed'in 10 eskisini süpürdü, korumalılar
  kaldı; muhafız `WorkerProgram_RegistersBothRecurringJobs`. **(2c) e2e hesap temizliği**:
  `scripts/cleanup-e2e.ps1` (dev-yönlü, elle; ürüne uç açılmadı, teardown'a bağlanmadı —
  DECISIONS) 946 e2e hesabını + 15 435 proje / 15 290 revizyon / 2 122 asset satırını ve ~7 GiB
  / 10 376 MinIO objesini sildi; demo birebir korundu (fail-fast desen kilidi — negatif kontrol:
  genişletilmiş desen exit 2 ile hiçbir şey silmeden durdu). Üç işte de negatif kontrol md5
  birebir; kapanış kapıları: build 0/0 · backend 1591/1591 skip 0 · şema 222 · editör 1342 ·
  tsc + e2e tsc + prod build temiz · Playwright TAM 164/164 (temizlik sonrası koşum).
- gelistirme-3 #1 — Defter/doküman senkronu (bayatlık sınıfı; DAVRANIŞ SIFIR — yalnız doküman
  metinleri + kod yorumları): README test sayıları/anlatısı güncel yeşile eşitlendi (1560→1579,
  1313→1339, 160→163; "pakete en son eklenen" relogin-reopen→library-crosstab-sync; UnitTests
  satırı STATE işaretine çevrildi — B4/CLAUDE.md deseni); backlog'da 4 bayat kayıt KAPANDI
  (ci.yml doğrulanamayan-sayı→B4 `3a1c256`; fitButton bayat-locator→`37a11b1`'de uygulanmış;
  bayat-dist prosedürü→SKILLS "schema-dist-tazeleme"; refetchIntervalInBackground kaydı
  "kaldırılMAYACAK — polling bilinçli yedek" kararıyla) + 503 font-kökü kaydı FontRootHealth
  gerçeğine daraltıldı (kalan iş: işletmeci karşılaştırması, deploy/README §5.2 adım 4);
  poc §3.2 başlığı gerçeğe döndü (sentetik korpus TEST EDİLDİ — `DirtyMediaCorpusTests`;
  gerçek telefon dosyası nüansı korundu); ci.yml "~9 dk (94 test)" yorumu sayısızlaştırıldı
  (timeout değeri DOKUNULMADI) ve e2e job'unun "backend'de Redis tüketicisi yok" yorumu
  düzeltildi (SignalR sonrası YANLIŞTI; job'un redis başlatmayışı AÇIK SORU olarak STATE'e
  yazıldı — davranış değişikliği bu dilimin dışı); MinioStorageSmokeTests "CI'da koşmaz"
  xmldoc'u düzeltildi (CI dotnet job'u MINIO_AVAILABLE=1 set eder); PlayerPanel/editorBridge
  "transitional/until the store carries userSeekSeq" yorumları savunma-dalı gerçeğine çevrildi
  (editorStore userSeekSeq'i tanımlar+0'la ilkler; KOD değişmedi); deploy/README durum notu
  damgası 2026-08-31 teyidiyle tazelendi. Kapılar: build -warnaserror 0/0 · backend 1579/1579
  skip 0 (MinIO+ffmpeg) · editör 1339 + şema 222 · tsc -b + e2e tsc temiz. Playwright
  GEREKMEDİ, negatif kontrol UYGULANAMAZ (davranış yok) — her düzeltmenin "önce yanlıştı"
  kanıtı PROGRESS satırında eski↔gerçek çiftleriyle.
- yarim-is-2 #5 — B6 çapraz-sekme kitaplık senkronu KAPANDI (user-feed grubu): worker'ın her
  progress publish'i artık `ownerId` (Jobs.RequestedBy) taşır; forwarder mesajı sahibinin
  `user:{id}` feed grubuna DA yollar (eski, alansız payload'da feed atlanır); hub'a
  PARAMETRESİZ `SubscribeUserFeed`/`UnsubscribeUserFeed` (kimlik JWT'den — başkasının feed'i
  adreslenemez; IDOR aynası `CrossUserAccessTests.Hub_SubscribeUserFeed_*`). İstemci:
  `useProjectAssets` kitaplık açıkken feed katkısı verir (bağlantı meşgul satır olmadan da
  yaşar), `handleProgressMessage` ardışık kopya teslimi süzer ve BİLİNMEYEN assetId'de listeyi
  + kotayı BİR kez invalidate eder (bilinen id'ler mevcut `asset:{id}` yolunda — fırtına yok).
  Önce ölçüldü: kusur yeni spec'le HEAD'de yeniden üretildi; complete→ilk publish n=3
  0,62-1,79 s (p50 0,74) → worker-publish yeterli, API'ye ikinci publish yönü AÇILMADI
  (DECISIONS). Kanıt: `e2e/library-crosstab-sync.spec.ts` (pasif sekme + ham-API yükleme:
  satır 2,85 sn'de, kota kendiliğinden, sayfa yüklemesi 0, ilk liste GET'i ilk feed
  mesajından SONRA; toplam 2 liste GET'i) + 5 yeni birim (novelty/dedupe/kota) + 4 backend
  (feed üyeliği, forwarder 3-grup, eski-payload atlanır, tel `ownerId` pini). Negatif kontrol
  ×3, md5 birebir. Yedek yol değişmedi (progress-fallback + export-progress-hub yeşil).
- SignalR ilerleme kanalı (kullanıcı kararı "GETİR" — tasarım 03 §5'e sadık, tek commit):
  worker her progress DB yazımının yanında Redis `job-progress` publish'i
  (`RedisJobProgressPublisher` — asla fırlatmaz, Redis zorunlu değil); API'de
  `RedisProgressForwarder` (BackgroundService; Redis'siz dayanıklılık canlıda ölçüldü —
  aşağıda) →
  `JobProgressHub` `/hubs/progress` `job:{id}`/`asset:{id}` grupları; kanal/yol/metot/grup
  sabitleri TEK yerde (`Contracts/JobProgress.cs`); JWT query-string YALNIZ hub yolunda +
  istek logu query'siz (redact). İstemci `entities/progressHub.ts`: hub kapsarken export/asset
  yoklaması durur, hub yok/düşük/sessizken (bekçi 15 sn) bugünkü 2 sn / 3 sn polling AYNEN
  yedek. Sahiplik kapısı hub aboneliğinde de (IDOR matrisi uzatıldı: `CrossUserAccessTests.Hub_*`
  + uç envanteri defterine `/hubs/progress` satırları; `MapHub` muhafız gereği
  `ProgressHubEndpoints` grubunda). Kanıt: canlı e2e ağ ölçümü (hub akarken export GET'i
  canlı pencerede 0; WS engelliyken polling ≥2 GET ile iş yine tamamlandı) + canlı
  dayanıklılık (Redis container durdu → koşan API /health+login 200; Redis KAPALIYKEN
  açılan API de /health 200, Redis dönünce forwarder kendiliğinden abone) + iki negatif
  kontrol (kapı söküldü → HubException gelmedi kırmızısı; forwarder söküldü → "hub'dan mesaj
  gelmedi" kırmızısı; md5 birebir geri). Backplane paketi bilinçli YOK (tek instance —
  DECISIONS geri-alma koşuluyla).
- Küçükler dilimi (STATE eski §Sıradakiler 5; dört iş TEK commit): SaveTimeline 409 birim
  sözleşme pini (`SaveTimelineRevisionContractTests`, Sqlite in-memory; + canlı ham-API
  eş-kanıtı; negatif kontrol: concurrency filtresi sökülünce "bayat yazma Ok'landı" kırmızısı);
  "sonradan tekrar düzenleme" gerçek-medya e2e'si pakete (`e2e/relogin-reopen.spec.ts` — böl →
  "Kaydedildi"nin sözü sunucudan doğrulanır → çıkış → yeniden giriş → seçici → aynı belge +
  media-urls 200 + proxy Range 206; negatif kontrol: putTimeline yalanı → "rozet yalan
  söylüyor"); README senkronu (sayılar 2026-08-31 koşumlarından: backend 1560 / e2e 160;
  Redis/SignalR şemasına dürüst "yazılmadı" notu — şema korundu, karar açık; yol haritasında
  pis-dosya korpusu + track sıralama/adlandırma KAPANDI); `compose.dev.yml:1` yorumu
  (+ MinIO). Backlog 12. tur kaydı ve poc §4.2/§5.1 kapanışları işlendi.

## 2026-08-25
- Süreklilik dokümantasyon seti üretildi (CLAUDE.md + docs/{STRUCTURE,SKILLS,WORKFLOWS,DECISIONS,STATE,CHANGELOG}.md) — P1 uygulaması.
- Çift-rol read-only denetim raporu: `DURUM.md` (🟡; R2 denenmemiş + 24 commit push'suz + doc bayatlıkları).
- B borçları kapanış doğrulaması GEÇTİ (`90d5f9f`); iki düşük gözlem backlog'a (`1f964d0`).
- B borçları son partisi: B4 ci.yml sayısızlaştırma (`3a1c256`), B7 tahmin sabitleri config (`ab55dba`),
  B8 tembel backfill (`fe780de`), LUT dyadik-olmayan e2e bacağı (`ddab3d2`), bezier ekstremum kapıları (`780791f`).
- B2 1-2 GB kalıcı perf muhafızı + n=2 (2,53 GB) + 4 GiB tavanı canlı (`395c246`); B6 reaper çok-worker
  iptali — DB satırı iptal kanalı (`3453073`); B1 ses paritesi ilk ölçüm + demo müzik adımı (`935a73c`);
  B5 çıktı-saati bekçisi işleme reçetelerine — filmstrip sprite-saati bulgusu (`6bb5e95`).

## 2026-08-22..24 — Yarım-iş turu (9/9, madde başına ayrı commit)
- #5 export bileşim perf: LUT blend yerli yazılış 0,87x→1,60x + ±1 LSB zarfı golden'lı (`384cf6d`).
- #12 XML-doc yapısal uyarılar sıfırlandı, `Directory.Build.props` kapısı (`dffa484`).
- #6 IDOR regresyon paketi + mekanik uç envanteri muhafızı — açık bulunamadı (`307b156`).
- #4 media-urls: manifest jsonb kopyası + gerçek paralel presign, 55 asset'te 3,7× (`931a0d1`).
- #3 2160p bellek kabul kapısı — commit-boşluğu okuyucu, canlı yanlış-ret kanıtıyla (`810292f`).
- #14 yorum tur-numarası temizliği, 77 dosya davranış-sıfır (`2ec141a`); #13 font-kökü sağlık
  görünürlüğü — iki uçta aynı parmak izi (`a0bae49`); #2 hız sınırı op-kâhinli (`052b2a2`);
  #1 sessiz videoda "Sesi ayır" tuzağı (`06936a9`). Kapanış: `e780143`.

## 2026-08-21 — Geliştirme dalgaları + denetimler
- 13. tur çift-rol denetimi: Ctrl+D/V frame-grid, media-urls döngüsü, zod↔C# keyframe sınırı,
  media-urls sahiplik filtresi (canlı sızıntı kanıtıyla) (`e6f93a5`).
- 14.-15. tur: LUT iki bacak, export profilleri, modal odak (7 test.fail silindi), track
  sıralama/adlandırma, pis-dosya korpusu, per-device logout, performans turu + `docs/performans-raporu.md` (`37a11b1`).

## 2026-08-19..20 — Teslim turları (10-12) + BAŞ MİMAR ONAYI
- Kaynak tavanları (süre/fps), miks `apad` asılması düzeltmesi + `render-overrun` bekçisi,
  `settings.backgroundColor` kapısı + `DocumentStrings` defteri, 1-2 GB ilk uçtan uca ölçüm.
- NİHAİ ONAY **12. turda** (`e8f7770`; arşiv `docs/audits/teslim-12-tur-onay.json` — `"tur": 12`).
  "13. tur" onay-SONRASI ayrı çift-rol denetimidir (2026-08-21, `e6f93a5`).

## 2026-08-12..13 — Denetim turları 4-9
- Dejenerelik kapıları (tavan MAKSİMUM / taban MİNİMUM), Compile-only kural sınıfının senkron
  422'ye taşınması + `ExportGateInventoryTests` muhafızı, overlay `floor(P)` tekliği, editörde beş
  yarış kusuru, ses/müzik export kırığının kapanması (`a1b3a73`).

## 2026-08-06..12 — M0–M6 + ilk teslim
- Plan + M0-M3 (2026-08-06..07): şema/sözleşmeler, M1 upload/işleme (`712262f`), M2 timeline/player
  (`f173f0c`), M3 export (`3e2b41e`), ilk RED→ONAY teslim (`dc70fb6`→`8679f9e`).
- Gerçek-fare e2e katmanı (`56bb2f4`, 08-07 — sentetik girdi dersi); `docs/review-gate.md` bu dersten
  SONRA yazıldı (`8c44075`, 08-11).
- M4-M6 (2026-08-11..12): `6151125`, `4b922f3`, `02c76da`, `f39e0b4`.
