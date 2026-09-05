# WORKFLOWS — uçtan uca akışlar
Son güncelleme: 2026-09-05. Skill'lerin hangi sırayla bağlandığı. Skill ayrıntıları: `docs/SKILLS.md`.

## W1 — Borç/madde kapama (yerleşik ana akış)

- Tetikleyici: `docs/STATE.md` ya da kullanıcıdan onaylı bir iş maddesi.
- Adımlar:
  1. `ortam-kaldirma` (gerekiyorsa) + `ikili-tazelik-dogrulama`
  2. ÖNCE ÖLÇ: kusuru/iddiayı kendin üret (canlı ham API, gerçek fare, gerçek ffmpeg — hangisi uygunsa)
  3. Uygula: mevcut mimari desenleri izle (kapı ekliyorsan muhafız defterine kayıt ŞART — aşağıda W4)
  4. `negatif-kontrol-protokolu`
  5. `test-paketleri` (+ UI'a dokunduysa ilgili spec'ler; şemaya dokunduysa `schema-dist-tazeleme`)
  6. AYRI commit (`yarim-is #N:` / `borc BN:` deseni) + `PROGRESS.md` satırı
  7. Takılınca DUR, kullanıcıya sor.
- Çıktı: kapanmış madde + kanıt satırı.
- Başarı kriteri: dört kapı yeşil + negatif kontrol kanıtı + PROGRESS güncel.

## W2 — Denetim turu (ÜÇ rol: baş mimar / baş mühendis / baş geliştirici)

- Tetikleyici: Dilim ailesi bitti; kullanıcı denetim istedi; teslim öncesi.
- Adımlar:
  1. ÜÇ mercek, SIRAYLA (paralel DEĞİL — ortamın tek sahibi kuralı):
     **Baş mühendis** dört kapıyı + TAM Playwright'ı KENDİ koşar (ağır koşumların sahibi odur);
     **baş mimar** sözleşme/belge ↔ kod okuması + hedefli koşumlar (canlı servisleri YÖNETMEZ);
     **baş geliştirici** kod kalitesi, muhafız defterleri, sahte/mock SADAKATİ (mock gerçek
     API'den saparsa muhafız yanlış şeyi kanıtlıyor demektir — ölçülmüş bulgu sınıfı).
  2. **AYNI HEAD** (review-gate kural 9): roller aynı commit'i denetler, ARALARINDA DÜZELTME
     YAPILMAZ. Sırayla düzeltmek bulguları zincirler ve tur kapanmaz.
  3. Her bulgu **MADDİ / KANIT / KOZMETİK** diye sınıflanır ve rapor "sürüm engelleyici kusur
     var mı?" sorusuna AÇIKÇA cevap verir (review-gate kural 8). RED yalnız MADDİ için.
  4. Triyaj: MADDİ bulgular bağımsız YENİDEN ÜRETİLİR; üretilemeyen reddedilir.
  5. Kabul edilenler W1 ile kapatılır; KANIT/KOZMETİK olanlar gerekçesiyle `docs/backlog.md`'ye.
- Başarı kriteri: her bulgu "kendi koşumumla" kanıtlı; rapor kanıt sayılmaz (review-gate kural 2).
- Bilinen tuzak: iki ajan aynı anda Playwright/servis yönetirse sahte kırmızılar doğar — canlı ortamın
  TEK sahibi olur, diğerleri hedefli/okuma kalır.
- ÖLÇÜLMÜŞ DERS (panel turu, 8 commit): kural 8 yazılmadan önce altı ardışık tur RED verdi ve
  HİÇBİRİ ürün kusuru değildi — her tur bir öncekinin yamasında daha dar bir delik buldu.
  Sınıflandırma ölçütü olmadan denetim döngüsü kendiliğinden kapanmaz.

## W3 — Kapanış doğrulaması (tur sonu mühür)

- Tetikleyici: Bir tur/aile tamamen commit'lendiğinde.
- Adımlar: HEAD'den taze yayın → `ikili-tazelik-dogrulama` → `playwright-tam-suite` + backend paketi →
  `docs/demo-senaryosu.md` gerçek fare/klavyeyle uçtan uca → turun HER maddesinden birer canlı kanıt →
  önceki turların kazanımlarından örneklem → `git status`/worktree/kaçak-ffmpeg temizliği →
  PROGRESS kapanış satırı + commit.
- Başarı kriteri: tek kırmızı yok; her madde kendi reprodüksiyonuyla teyitli.

## W4 — Yeni kural/kapı ekleme (muhafız disiplini)

- Tetikleyici: Export/upload yoluna yeni bir doğrulama kuralı ya da ret gerekçesi eklenecek.
- Adımlar:
  1. Kural SENKRON kapıda mı yaşayabilir? Saf doküman/DB aritmetiği → `ExportCompiler.Validate`
     (422, kuyruğa girmeden). Yalnız worker'da öğrenilebilen olgu → tipli worker gerekçesi.
  2. Muhafız defterine kayıt (aksi halde defter testi KIRMIZI verir): `ExportGateInventoryTests`
     (SyncGate/WorkerFailures/DocumentStrings/RasterRefusals); yeni HTTP ucu ise
     `CrossUserAccessTests` + mekanik uç envanteri.
  3. Çift-dil kuralıysa parite vektörü ekle (`packages/timeline-schema/test-vectors/` deseni —
     iki dilde de tüketilir; negatif kontrolde İKİ taraf birden kırmızı olmalı).
  4. Kullanıcı mesajı: Türkçe, uygulanabilir eylem söyleyen; 422 cümle sınıfı doğru seçilmiş
     (desteklenmeyen özellik / kaynak tavanı / değer hatası / asset olgusu — `ExportEndpoints` aynaları).
- Başarı kriteri: yanlış RET yok (sınırın iki yanı testli); defterler yeşil; mesaj eyleme dönük.

## W5 — Süreklilik seti bakımı (bu dokümanlar)

- Tetikleyici: Session sonu (P3) ya da davranış/karar değişikliği.
- Adımlar: CHANGELOG'a tarihli madde → STATE'i taşı/güncelle → SKILLS'te dokunulan girdilerin
  "Son doğrulanma" tarihi → DECISIONS'a yeni karar + reddedilen alternatif → CLAUDE.md yetenek
  haritası değiştiyse güncelle. Değişmeyen dosyaya dokunma.
- Başarı kriteri: yeni bir session P2 açılışıyla bağlamı kurabiliyor.
