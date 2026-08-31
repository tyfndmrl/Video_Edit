# DECISIONS — karar günlüğü
Son güncelleme: 2026-08-25. Reddedilen alternatifler kritiktir: yeni session aynı yola sapmasın.
Tam gerekçe ve ölçümler için `docs/backlog.md` (tur kayıtları) ve `docs/rendering-semantics.md`.

| Karar | Tarih | Gerekçe | Reddedilen alternatif | Geri alma koşulu |
|---|---|---|---|---|
| Zaman = tamsayı mikrosaniye; float saniye YASAK | 2026-08-06 | İki dilde birebir aynı aritmetik | Float saniye | Yok (temel sözleşme) |
| Geçiş = bitişiklik + D/2 kaynak payı (metadata) | 2026-08-06 | Overlap modeli çakışma değişmezini bozuyordu | Klip overlap'ı | Yok |
| Frame-grid kuralı KENARLARDA (start ve end), sürede değil | 2026-08-07 | Grid toplama altında kapalı değil (NTSC); süre kuralı %36 yanlış ret üretti | Süre-bazlı grid | Yok |
| Kural sınıfı: senkron 422 kapıları + muhafız defterleri | 2026-08-12..21 | "Kural yalnız Compile'da" sınıfı 6 kez kuyruk-sonrası ölüm üretti | Kuralı worker'da bırakmak | Yok — W4 disiplini |
| Geçişli tek-kutu: pad hedefi `Box & ~1`, parite kısıtı KALDIRILDI | 2026-08-12 | Ölçüm: kısıt kendisi 1 px kayma üretiyordu; %74 ölçek yasaklıydı | Editörde ölçek nicelemesi (B planı) — kullanıcıyı anlaşılmaz ızgaraya hapsederdi | ffmpeg scale çift-çıktı sözleşmesi değişirse |
| Overlay koordinatı ifadede açık `floor(P)` | 2026-08-21 | ffmpeg `(int)` SIFIRA doğru kırpar; pad'li/pad'siz yol 1 px ayrışıyordu (dikeyde %43 ulaşılabilir) | trunc davranışına doküman uydurmak | Yok |
| Bellek okuyucu = COMMIT boşluğu (`ullAvailPageFile`) | 2026-08-24 | Fiziksel-boş okuma canlıda 2160p'yi YANLIŞ reddetti (Windows çalışma kümelerini kırpar) | `ullAvailPhys` | Yok — canlı yanlış-ret kanıtı arşivde |
| 503 yalnız KURULUM arızası; belge kusuru daima 422 | 2026-08-13 | Bilinmeyen fontId 503 alıp "yeniden dene" diyordu — asla çalışmazdı | Geniş catch ile hepsine 503 | Yok |
| Export profili farklı en-boy oranını REDDEDER (tipli 422) | 2026-08-21 | Letterbox yarım piksel + önizlemesiz kare doğuruyordu (ölçüldü) | Letterbox | Önizleme letterbox'ı da gösterirse |
| LUT blend yerli yazılış + ±1 LSB zarfı NORMATİF | 2026-08-25 | 0,87x→1,60x; fark yalnız dyadik-olmayan yoğunlukta ±1 LSB (65k çift tam tarama) | Revert (kazanç kaybı); "bayt-aynı" iddiasını sürdürmek (ölçümle yanlıştı) | ffmpeg blend yuvarlaması değişirse (golden sınır testi yakalar) |
| Bezier: şema kelepçesi REDDEDİLDİ; kapılar eğri EKSTREMUMUNU okur | 2026-08-25 | Kelepçe overshoot/back/elastic preset sınıfının önünü keserdi; kapalı-form ekstremum ~2400× hızlı ve kesin | y1/y2'yi [0,1]'e kelepçelemek | Yok |
| media-urls: toplu backfill YOK → TEMBEL backfill | 2026-08-24..25 | Toplu migration satır başına storage GET'li riskliydi; yedek yol zaten doğru servis eder | Toplu backfill migration'ı | Eski asset sayısı sorun olursa (bugün kendiliğinden eriyor) |
| Kota türevleri sayar (`Asset.DerivedBytes`) | 2026-08-21 | Türevler ~%7,7 bedava alandı | Yalnız orijinali saymak | Yok |
| SkiaSharp 3.116 PIN | (csproj yorumu) | Tüm golden PNG'ler bu sürüme kalibre | Serbest yükseltme | Planlı pencere: yükselt + golden'ları yeniden doğrula |
| WorkerCount=1 (export kuyruğu) | tasarım | ffmpeg zaten tüm çekirdekleri kullanır | Süreç içi paralel export | Çok-worker işletim provası yapılırsa (testi var) |
| Lint YOK | 2026-08-22 | KULLANICI KARARI (AskUserQuestion) — "bitti" = build -warnaserror + testler + tsc | ESLint kurulumu | Kullanıcı isterse |
| Push SONRA | 2026-08-22 | KULLANICI KARARI — origin bilinçli geride | Anında push | Kullanıcı "push" derse |
| R2 dağıtımı EN SONA | 2026-08-25 | KULLANICI KARARI — önce tüm borçlar | Önce R2 | Kullanıcı anahtarları verip başlatınca |
| SignalR/Redis: GETİRİLECEK (kullanıcı kararı) | 2026-08-31 | Kullanıcı AskUserQuestion ile "SignalR'ı getir" seçti; tasarım 03 spec'i uygulanacak (JobProgressHub + worker→Redis publish + polling YEDEK kalır) | İskeleyi sökmek; şimdilik dokunmamak | Uygulama tamamlanmadan kullanıcı vazgeçerse |
| XML-doc: yapısal uyarılar hata; CS1591 susturuk; tests/ kapsam dışı | 2026-08-24 | 39 yapısal uyarı gerçek içerikle kapatıldı; 404 şablon özet değersiz; tests ~931 uyarı açardı | Tüm public üyelere özet yazmak | Özet zorunluluğu istenirse NoWarn satırı silinir |
| Kod yorumlarında satır numarası / doğrulanmamış sayı YASAK | 2026-08-22 | Bir turda 61 atıf bayatladı; üç sayı iddiası ölçümle yanlışlandı | Satır atıflı yorumlar | Yok |
| E2E kanıtı yalnız GERÇEK girdi (page.mouse/keyboard) | 2026-08-07 | Sentetik olaylar sahte yeşil üretti; kullanıcı "hiçbir şey çalışmıyor" dedi — kurucu ders | dispatchEvent/store çağrısıyla test | Yok (review-gate kural 3) |
