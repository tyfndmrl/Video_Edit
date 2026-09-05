# SKILLS — operasyonel prosedür envanteri
Son güncelleme: 2026-09-05. Bu dosya, oturum hafızasında yaşayıp tekrar tekrar keşfedilen
prosedürleri kalıcılaştırır. Her girdi bu depoda fiilen koşulmuş komutlardan türetildi.

### ortam-kaldirma
- Amaç: Sıfır durumdan çalışır dev ortamı (DB+depo+API+Worker+editör).
- Ne zaman tetiklenir: Session başı; "servisler ayakta mı" şüphesi; Docker Desktop kapanmışsa.
- Ne zaman KULLANILMAZ: Yalnız birim testi koşulacaksa API/Worker gerekmez (testler in-process).
- Girdi: Docker Desktop, .NET 10 SDK, pnpm, ffmpeg+ffprobe PATH'te.
- Çıktı: postgres/redis/minio healthy; API :5000 `/health` ok; Worker ayakta; Vite :5173.
- Bağımlılıklar: `compose.dev.yml`; fontlar (`pwsh fonts/fetch-fonts.ps1`) — yoksa metin ölçümü 503 sınıfına düşer.
- TAZE KLON ek dizisi (bir kez): `pnpm install` (prepare script'i timeline-schema dist'ini kurar) →
  `pnpm exec playwright install chromium` (apps/editor içinde; e2e tarayıcısı) → `pwsh fonts/fetch-fonts.ps1` →
  BOŞ pg volume'unda İLK açılışta `migration-uygulama` (API `--migrate-only`) — restart şemayı kurmaz.
- Dev kimlik kaynakları: API/Worker bağlantıları `appsettings.Development.json` (Host=localhost,
  `app`/`devpassword`); MinIO kimliği `compose.dev.yml` (`videoedit`/`devpassword123`, konsol :9001);
  MinIO bucket'ları API açılışında OTOMATİK kurulur (elle bucket adımı yok).
- Çalıştırma (sırayla):
  ```
  docker compose -f compose.dev.yml up -d
  dotnet publish backend/src/VideoEdit.Api/VideoEdit.Api.csproj -c Debug -o <scratch>\api-run
  dotnet publish backend/src/VideoEdit.Worker/VideoEdit.Worker.csproj -c Debug -o <scratch>\worker-run
  # API: VIDEOEDIT_FONT_ROOT=<repo>\fonts, ASPNETCORE_ENVIRONMENT=Development, ASPNETCORE_URLS=http://localhost:5000
  #   çalışma dizini api-run içinde:  dotnet ./VideoEdit.Api.dll
  # Worker: DOTNET_ENVIRONMENT=Development;  worker-run içinde:  dotnet ./VideoEdit.Worker.dll
  # Editör: Claude Code'da preview_start name=editor (.claude/launch.json) — Bash ile dev server başlatma
  ```
- Doğrulama: `GET :5000/health` → `{"status":"ok"}` + `fonts.found:true` (parmak izi worker açılış
  satırıyla birebir olmalı); `GET :5000/api/fonts` → 200; `:5173` → 200. Demo girişi: `demo@videoedit.test` / `demo1234`.
- Bilinen sınırlar/tuzaklar: (1) Süreç adı `dotnet` — `Get-Process VideoEdit*` BOŞ döner. (2) `bin\Debug`
  altından koşan eski süreç portu tutarsa yeni yayın "address already in use" ile ölür ve `/health` ESKİ
  süreçten "ok" döner — önce eskiyi öldür. (3) Worker'sız her şey "Sırada/İşleniyor"da takılır, hata vermez.
  (4) Docker kapanmışsa `MINIO_AVAILABLE=1` testleri skip yerine ZAMAN AŞIMIYLA kırmızı düşer (31 kırmızı deseni).
  (5) Worker font kökünü kendi bulur (env → walk-up); API ile worker parmak izi UYUŞMUYORSA iki taraf
  farklı kök görüyordur — worker'ı da `VIDEOEDIT_FONT_ROOT` ile başlat, `deploy/README.md` §5.2 adım 4.
  (6) Windows PowerShell 5.1'in `Start-Process`'inde `-Environment` YOK (PS 7+ özelliği) — servis env'ini
  önce kabuğa yaz (`$env:VIDEOEDIT_FONT_ROOT=...`), süreç mirasla alır (2026-08-31'de ölçüldü).
  (7) Docker Desktop'ı komutla açarken engine ~1-3 dk sonra hazır olur; `docker version` o ana kadar
  pipe hatasıyla ASILIR — zaman aşımı verip yokla.
- Son doğrulanma: 2026-09-02

### ikili-tazelik-dogrulama
- Amaç: Canlı API/Worker'ın gerçekten hedef commit'in kodunu koştuğunu kanıtlamak.
- Ne zaman tetiklenir: HER canlı ölçümden önce (e2e, ham API kanıtı, perf).
- Ne zaman KULLANILMAZ: In-process (WebApplicationFactory'siz doğrudan handler) testlerde gereksiz.
- Girdi: Koşan süreç PID'leri; ayırt edici "iğne" dizeleri.
- Çıktı: "taze" ya da "bayat" kararı, kanıtla.
- Çalıştırma: (1) Sürecin YÜKLEDİĞİ modül yolunu oku (PowerShell `Get-Process -Id <pid> | % Modules`
  ya da WMI) — beklenen yayın dizini mi? (2) DLL baytlarında iğne ara: C# DİZE SABİTLERİ UTF-16'dır,
  ÇİFT hizalamayla tara (tek hizalama kaçırabilir — ölçüldü); tanımlayıcı/metot ADLARI metadata'da UTF-8'dir.
- Doğrulama: Güncel iğne örnekleri (2026-08-25): UTF-16 `blend=all_mode=normal:all_opacity=` VAR /
  eski `blend=all_expr='A*(1-` YOK; UTF-8 `ExportEstimateOptions`, `BezierValueExtrema`, `ExpectedOutputClockUs` VAR.
- Bilinen sınırlar/tuzaklar: DLL md5 farkı TEK BAŞINA bayatlık kanıtı DEĞİL (PDB yolu/MVID değişir) —
  IL bölgesini ya da iğneyi karşılaştır. `Api.dll`'de eski iğnenin XML-doc literalinde görünmesi davranış değildir.
  Değişiklik yeni tanımlayıcı/dize üretmediyse (ör. yalnız mevcut metod gövdesi değişti) iğne YOKTUR —
  o zaman kanıt yüklü modül yolu + DAVRANIŞSAL iğnedir (ör. canlı işten yakalanan filtergraph'ta yeni
  satır şekli; 2026-09-01 budama yayınında böyle kanıtlandı).
- Son doğrulanma: 2026-09-02

### test-paketleri
- Amaç: Dört kapının tamamını koşmak (commit öncesi zorunlu).
- Çalıştırma (Bash aracı; birincil kabuk PowerShell'de `VAR=x cmd` öneki PARSE HATASI verir —
  PowerShell karşılığı: `$env:MINIO_AVAILABLE='1'; dotnet test backend/VideoEdit.sln`):
  ```
  dotnet build backend/VideoEdit.sln -warnaserror        # 0 uyarı beklenir (XML-doc yapısal kapısı dahil)
  MINIO_AVAILABLE=1 dotnet test backend/VideoEdit.sln    # skip 0 beklenir (MinIO+ffmpeg şart)
  pnpm -r test                                           # editör + timeline-schema vitest
  pnpm --filter @videoedit/editor exec tsc -b            # + apps/editor'da: npx tsc -p e2e/tsconfig.json --noEmit
  ```
- Doğrulama: 2026-09-05 (panel-denetim-9 sonu) yeşil sayıları: backend 1626 · editör 1552 · şema 235 (bunlar BÜYÜR; skip 0 sabittir).
- Bilinen sınırlar/tuzaklar: MinIO'suz koşumda MinIO+ffmpeg kapılı testler skip'lenir (2026-08-31 ölçümü: 41) —
  skip>0 görürsen önce Docker'a bak. Lint YOK (kullanıcı kararı); "bitti" tanımı: build + testler + tsc.
- Son doğrulanma: 2026-09-04

### playwright-tam-suite
- Amaç: Gerçek fare/klavye e2e paketinin tamamı.
- Ne zaman tetiklenir: Kapanış doğrulamaları; UI'a dokunan dilimler.
- Ne zaman KULLANILMAZ: Ortamın TEK SAHİBİ değilsen — paralel ajan/koşum sahte kırmızı üretir (ölçülmüş ders).
- Girdi: ortam-kaldirma tamam + ikili-tazelik doğrulanmış + kaçak ffmpeg yok (`Get-Process ffmpeg`).
- Çalıştırma: `pnpm exec playwright test` (apps/editor içinde). 2026-09-05 (panel-denetim-9 sonu): 197 test / 51 spec / 12,2 dk.
- Doğrulama: 0 failed, 0 skipped (ffmpeg PATH'teyse koşullu skip'ler tetiklenmez).
- Bilinen sınırlar/tuzaklar: Sentetik girdi (dispatchEvent) YASAK — kanıt sayılmaz (review-gate kural 3).
  MAKİNE DONMASI SAHTE KIRMIZI ÜRETİR (2026-09-03 panel-denetim-3'te ölçüldü): tam suite 39 dk sürdü ve
  tek bir test `apiRequestContext.post: Timeout 15000ms` ile düştü. AYIRT ETME REÇETESİ — (1) API
  günlüğünde o isteğin KENDİ süresine bak: `POST /api/projects responded 201 in 1594504 ms` (26,6 dk)
  ve hemen ardındaki aynı çağrı 3,7 ms ise sorun üründe değildir; (2) `docker logs videoedit-postgres-1`
  içindeki 5 dakikalık `checkpoint starting: time` zincirine bak — aynı pencerede BOŞLUK varsa
  (ölçülen: 18:06→18:37 UTC, ~6 çevrim atlandı) Postgres'in kendi zamanlayıcısı da durmuştur, yani
  donma ANA MAKİNEDEDİR; (3) düşen spec'i İZOLE koş (ölçülen: 1,8 sn yeşil). Üçü de tutuyorsa suite'i
  yeniden koş; "flake" deyip geçme, kaydı tut.
  Süite testleri sadece Chromium'da. TARAYICI DEPOLAMASI SPEC'LER ARASINDA YAŞAR: context
  worker-scope'tur (fixtures/test.ts, workers:1), yani bir spec'in bıraktığı localStorage
  değeri sonrakilerin düzenini/geometrisini sessizce değiştirir — kalıcı tercih yazan her
  yeni spec before/afterEach'te anahtarı SİLMELİ (desen: `timeline-resize.spec.ts` +
  `TimelineHarness.clearStoredHeight`; kabul ölçütü: spec paketin ORTASINDA koşarken
  sonrakiler yeşil). BAŞLI (headed) mod: ms-playwright Chromium bu makinede başlı
  spawn edilemiyor (`spawn UNKNOWN`); rAF kadansı gereken ölçümlerde `channel: 'msedge'`
  ile başlı Edge kullanılır. (DİKKAT: "headless rAF'ı ~12 Hz'e kısar" gerekçesi 2026-09-04'te
  ÇÜRÜDÜ — kendi ölçümüm: headless p50 16,665 ms = 60,0 Hz, n=299. Başlı Edge hâlâ 165 Hz'lik
  eşikleri sınamak için gerekli; headless'i otomatik kapsam dışı SAYMA, önce ÖLÇ.)
- Son doğrulanma: 2026-09-04

### negatif-kontrol-protokolu
- Amaç: Yeni/değişen her korumanın gerçekten yük taşıdığını kanıtlamak.
- Ne zaman tetiklenir: Her davranış düzeltmesi ve her yeni test için (review-gate şartı).
- Çalıştırma: düzeltmeyi geçici boz → ilgili test(ler) TAM BEKLENEN mesajla kırmızı → geri al →
  dosya md5'inin bozma öncesiyle BİREBİR aynı olduğunu doğrula → yeniden derle → yeşil.
- Bilinen sınırlar/tuzaklar: (1) `Copy-Item`/`Move-Item` mtime'ı korur → MSBuild artımlı derleme BAYAT
  DLL kullanır; geri yükleme sonrası dosyaya touch + rebuild ZORUNLU. (2) PowerShell `Get-Content` ANSI
  okuması Türkçe karakterleri bozar (mojibake) — dosya yazımı daima Write/Edit araçlarıyla. (3) `git checkout`
  autocrlf smudge'ı satır sonlarını değiştirebilir — bayt-birebirlik iddiasını hash'le kur.
  (4) `git stash push/pop` de AYNI smudge'ı yapar: dosyayı Edit ile boz + Edit ile geri al
  (git'e uğratmadan) — md5 birebir kalır; 2026-09-03'te ölçüldü.
  (5) **HASH ARTIK KANIT BİÇİMİ DEĞİLDİR — kayıt yöntemi 2026-09-04'te DEĞİŞTİ.** Kural
  "teslim edilen dosyanın hash'ini yaz" biçiminde DÖRT turda dört kez yazıldı (`panel-denetim-3`,
  `-4`, `-5` ve `-5`'in kuralı yazan commit'inin KENDİSİ) ve dördünde de ihlal edildi: NC'den
  sonra dosya bir daha düzenlenince kayıttaki hash başka bir sürümü adresliyor, hatta hiçbir
  sürüme uymuyor (`docs/STATE.md` için yazılan `7c9e8508…` deponun hiçbir sürümüne uymuyordu).
  Prozada duran, kısaltılmış ve satır-sonu biçimi belirsiz bir hash zaten okuyucu tarafından
  DOĞRULANAMAZ. Bundan sonra NC kaydı ŞUNLARI taşır: (a) bozmanın TAM KIRMIZI İMZASI (mesaj +
  Expected/Received), (b) geri koymanın ELLE yapıldığı (`git checkout`/`stash` DEĞİL), (c) commit
  diff'inde NC artığı BULUNMADIĞI — okuyucunun gerçekten doğrulayabileceği tek şey budur.
  Hash yazmak isteğe bağlıdır; yazılacaksa commit KAPANIRKEN yeniden ölçülmelidir.
  (6) BİR MUHAFIZI KIRMAK ONU DOĞRULAMAZ — yalnız kırdığın YOLU doğrular. Muhafız "X yasak" diyorsa
  aynı ihlali BAŞKA bir yoldan da dene (gövde dışından, takma adla, girdi tarafından). Ölçüldü:
  ses tap'i muhafızı üç ayrı turda üç kez "yeterli" sanıldı; her seferinde ikinci bir yol yeşil
  geçti. İZİN VERİLEN grafı adlandıran envanter iddiası, yasak şekli adlandırandan güçlüdür.
- Son doğrulanma: 2026-09-04

### migration-uygulama
- Amaç: EF migration'ını canlı DB'ye uygulamak.
- Ne zaman tetiklenir: Yeni migration commit'lendiğinde VE taze kurulumda (boş pg volume — ilk açılış).
- Çalıştırma: API'yi `--migrate-only` bayrağıyla bir kez koştur (one-shot migratör).
- Doğrulama: `__EFMigrationsHistory` son satırı + yeni kolonun `information_schema`'da görünmesi.
- Bilinen sınırlar/tuzaklar: SERVİS RESTART'I TEK BAŞINA ŞEMAYI GÜNCELLEMEZ — migration yalnız bu
  bayrakla koşar (ölçülmüş ders). DB erişimi: `docker exec videoedit-postgres-1 psql -U app -d videoedit`.
- Son doğrulanma: 2026-08-24

### schema-dist-tazeleme
- Amaç: timeline-schema'daki değişikliğin editöre/e2e'ye gerçekten ulaşması.
- Ne zaman tetiklenir: `packages/timeline-schema/src` değiştiğinde, canlı e2e'den ÖNCE.
- Çalıştırma: `pnpm --filter @videoedit/timeline-schema build` (+ Vite restart).
- Bilinen sınırlar/tuzaklar: Editör şemayı `dist`'ten çözer; "backend yayını + Vite restart" dist'i
  TAZELEMEZ — bayat dist, TS tarafındaki yeni davranışı sessizce yok sayar (canlıda yakalanmış ders).
  `pnpm install` prepare script'i dist'i kurar (temiz klonda otomatik).
- Son doğrulanma: 2026-09-01

### demo-seed
- Amaç: Gerçek medyalı demo projesi kurmak.
- Çalıştırma: `powershell -ExecutionPolicy Bypass -File scripts\make-demo-media.ps1` →
  `scripts\seed-demo.ps1` → çıktının son satırındaki `?project=<id>` bağlantısı.
- Girdi: ffmpeg+ffprobe PATH'te; API+Worker ayakta.
- Çıktı: demo kullanıcısında 4 medya (2 video + logo + demo-04-muzik.m4a) "Hazır".
- Doğrulama: `docs/demo-senaryosu.md` akışı (müzik adımı 4M dahil) uçtan uca koşulabilir.
- Son doğrulanma: 2026-08-25

### perf-olcum
- Amaç: Performans iddialarını tekrarlanabilir yöntemle ölçmek.
- Çalıştırma: ısınma + en az 3 koşum, p50 raporla; export için sunucu duvar saati (Jobs satırı);
  editör için gerçek tarayıcıda performance.now. Kalıcı muhafız: `MediaPipelinePerfTests`
  (oransal eşikler; SESSİZ ŞERİTTE koşar — paralel yük altında flake ölçülmüştü).
- Doğrulama: Referans tablolar `docs/performans-raporu.md` + `docs/poc-bilinen-sinirlar.md` §0.1.
- Bilinen sınırlar/tuzaklar: (1) Sayılar bu makineye (20 mantıksal çekirdek) ve lokal loopback'e özgü —
  ağ vaadi değil. (2) Tepe RSS ölçümü sürekli örneklemle alt sınır verir (`PeakWorkingSet64` kullan).
  (3) MAKİNE PENCERESİ KAYAR (2026-09-01'de ölçüldü: aynı config aynı gün ~1 saat arayla 37,8 → 41 s):
  önce/sonra çifti BİTİŞİK pencerede alınmalı (eski ikiliyi sakla, arka arkaya koş — run27/run28 deseni);
  varyant kıyası için en sağlamı round-robin çıkar-koş-ölç rig'idir (tur başına her varyanttan bir koşum).
- Son doğrulanma: 2026-09-01

### e2e-hesap-temizligi
- Amaç: Playwright koşumlarının biriktirdiği `e2e-*@videoedit.test` hesaplarını ve TÜM verilerini
  (DB satırları + MinIO objeleri) dev ortamından silmek.
- Ne zaman tetiklenir: Elle/periyodik — dev DB/MinIO şiştiğinde ya da tur kapanışlarında
  (2026-08-31 ölçümü: 946 hesap / 15 435 proje / ~7 GiB obje birikmişti). Playwright
  teardown'ına BİLİNÇLİ bağlanmadı (DECISIONS 2c satırı: süre + yarış + kırık koşum delili).
- Ne zaman KULLANILMAZ: Paralel bir Playwright koşumu sürerken (koşumun aktif hesabını
  silebilir); prod'a karşı ASLA (zaten ifade edilemez — aşağıya bak).
- Çalıştırma: `powershell -ExecutionPolicy Bypass -File scripts\cleanup-e2e.ps1 -DryRun` (önce
  say), sonra aynı komut `-DryRun`suz. Docker üçlüsü ayakta olmalı.
- Doğrulama: Betik kendi doğrular (aday sayısı → silinen sayısı → `demo@videoedit.test` sayısı
  DEĞİŞMEDİ); sonrasında tam Playwright koşumu yeşil kalmalı (temizlik koşumları bozmaz —
  2026-08-31'de ölçüldü).
- Bilinen sınırlar/tuzaklar: (1) Hedef SABİT compose.dev.yml konteynerleridir; bağlantı dizesi
  parametresi YOKTUR + compose-etiket/DB-adı fail-fast'i vardır. (2) Aday deseni iki üreticinin
  birleşimidir (`fixtures/test.ts` `e2e-*`, `auth.spec.ts` `e2e-auth-*`); desen dışı ya da demo
  aday görülürse exit 2 ile HİÇBİR ŞEY silinmez — yeni bir spec farklı e-posta şekli üretirse
  betikteki `$EmailStrictRegex` birlikte güncellenmeli. (3) Eski oturumların elle açtığı
  ölçüm/idor-* hesapları desen DIŞIDIR ve bilerek silinmez. (4) Betik ASCII'dir — repo ps1
  kuralı: BOM'suz UTF-8'i PS 5.1 ANSI okur, Türkçe karakter/em-dash akıllı tırnağa dönüşüp
  parse'ı KIRAR (2026-08-31'de ölçüldü).
- Son doğrulanma: 2026-09-02 (ozellik-fix kapanışı: 64 hesap / 1893 proje süpürüldü, demo korundu)

### borc-kapama-protokolu
- Amaç: Bir işi kullanıcının yerleşik disipliniyle kapatmak.
- Ne zaman tetiklenir: PROGRESS/backlog'dan onaylı bir madde ele alındığında.
- Çalıştırma: (1) ÖNCE ÖLÇ — iddiayı/kusuru kendin üret; (2) düzelt (mevcut desenleri izle, ikinci
  aritmetik kopyası yazma); (3) test + NEGATİF KONTROL; (4) dört kapıyı koş (test-paketleri);
  (5) AYRI commit — mesaj deseni: onaylı yarım-iş `yarim-is #N: ...`, B-borcu `borc BN: ...`,
  bu ikisine girmeyen küçük işler `docs:`/`fix:` + kısa Türkçe özet; hepsinde
  `Co-Authored-By: Claude ...`; (6) PROGRESS.md satırını işle — tablo satırı şablonu:
  `| <no> | <iş> | ✅ YAPILDI | <önce-ölçüm> + <çözüm özeti> + <negatif kontrol> + <suite sayıları> |`;
  (7) takılırsan DUR ve kullanıcıya sor — varsayım yok.
- Doğrulama: Kapanışta bağımsız doğrulayıcı maddeyi kendi reprodüksiyonuyla teyit eder (review-gate kural 2).
- Son doğrulanma: 2026-09-01
