# STATE — mevcut durum
Son güncelleme: 2026-09-03, `panel-3a`+`panel-3b` — **panel turu dilim 3 (ses ölçer) KAPANDI**:
zaman çizelgesinin sağında master stereo L/R ölçer (dBFS skalası, tepe tutucu, klip mandalı);
ölçüm master'a PARALEL yaprak tap'ten okunur — duyulan zincir değişmedi (`audio-parity` dosyaya
DOKUNULMADAN yeşil). Ölçer sessizliği "0" diye göstermez: ses motoru kurulmadıysa "Ölçüm yok",
duraklatmada "Duraklatıldı", J geri taramada "Ses kapalı" der. FRONTEND-only.
**Panel turunun ÜÇ dilimi de tamam; sırada üç rollü kapanış denetimi var.**
Defter: `PROGRESS.md` §Özellik turu 2. Öncesi: `panel-2a`+`panel-2b` (timeline dikey
boyutlandırma + `scrollY` kelepçe kusuru), `panel-1a`+`panel-1b` (elle zaman kodu girişi).
Ayrıntılı fotoğraf: `DURUM.md` (2026-08-25 çift-rol denetim raporu — arşiv niteliğinde).

## Tamamlananlar (özet)

- **M0–M6 + POC teslimi**: 12 turluk baş mimar denetiminden ONAY (2026-08-20, `e8f7770`;
  arşiv `docs/audits/teslim-12-tur-onay.json`; "13. tur" onay-sonrası 2026-08-21 denetimidir).
- **Geliştirme dalgaları** (2026-08-21, `37a11b1`): LUT tam özellik, export profilleri, modal odak,
  track sıralama/adlandırma, pis-dosya korpusu, per-device logout, disk/kota düzeltmeleri.
- **Yarım-iş turu 9/9** (2026-08-22..25, `06936a9..e780143`): sessiz-video tuzağı, hız sınırı,
  font sağlığı, yorum temizliği, 4K bellek kapısı, media-urls, IDOR paketi, XML-doc, export perf
  (LUT blend 0,87x→1,60x). Defter: `PROGRESS.md`.
- **B borçları 9/9** (2026-08-25, `6bb5e95..1f964d0` + kapanış `90d5f9f`): ses paritesi ilk ölçüm,
  bekçi kapsamı (sprite saati), reaper çok-worker iptali, 1-2 GB kalıcı perf muhafızı + 4 GiB tavanı,
  ci.yml sayısızlaştırma, tahmin sabitleri config, tembel backfill, LUT dyadik-olmayan bacak,
  bezier ekstremum kapıları.
- **Küçükler dilimi** (2026-08-31, tek commit): SaveTimeline 409 birim sözleşme pini
  (`SaveTimelineRevisionContractTests` + canlı ham-API eş-kanıtı), "sonradan tekrar düzenleme"
  gerçek-medya e2e'si pakete (`e2e/relogin-reopen.spec.ts` — böl → Kaydedildi → çıkış →
  yeniden giriş → seçici → aynı belge + proxy Range 206), README sayı/şema senkronu,
  `compose.dev.yml:1` yorumu. Defter: `PROGRESS.md` §Küçükler.
- **SignalR ilerleme kanalı** (2026-08-31, kullanıcı kararı — tasarım 03 §5): worker her
  progress DB yazımının YANINDA Redis `job-progress` publish'i; API'de `RedisProgressForwarder`
  → `JobProgressHub` (`/hubs/progress`) `job:{id}` / `asset:{id}` grupları; istemci
  (`entities/progressHub.ts`) hub kapsarken yoklamayı durdurur. Polling YEDEK (silinmedi;
  sessizlik bekçisi `HUB_SILENCE_TIMEOUT_MS` ile susan kanalda geri gelir); Redis zorunlu
  DEĞİL (Redis'siz API/Worker açılır — canlıda ölçüldü); abonelik REST'le aynı sahiplik
  kapısından (IDOR matrisi hub'a uzatıldı); JWT query-string YALNIZ hub yolunda + istek logu
  query'siz. Backplane bilinçli YOK (DECISIONS). Defter: `PROGRESS.md` §SignalR.
- **Yarım-iş turu 2 — 3/3 KAPANDI** (2026-08-31): #1 bayat defter kayıtları, #6 sessiz catch
  TAM envanteri (35; muhafız `silentCatchInventory.test.ts`), #5 **B6 çapraz-sekme kitaplık
  senkronu (user-feed)**: worker publish'i `ownerId` taşır → forwarder sahibinin `user:{id}`
  feed grubuna DA yollar; hub'da PARAMETRESİZ `SubscribeUserFeed` (kimlik JWT'den — başkasının
  feed'i adreslenemez, IDOR aynası); istemci kitaplık açıkken feed'e abone, BİLİNMEYEN
  assetId'de listeyi+kotayı BİR kez invalidate eder (fırtına yok — kopya-teslim süzgeci +
  noticed seti). Kanıt: `e2e/library-crosstab-sync.spec.ts` (pasif sekme + ham-API yükleme,
  satır 2,85 sn'de odak/yenilemesiz) + publish gecikmesi n=3 (p50 0,74 s → worker-publish
  yeterli, DECISIONS). Defter: `PROGRESS.md` §Yarım-iş turu 2.
- **Geliştirme turu 3 #1 — defter/doküman senkronu** (2026-08-31, davranış SIFIR):
  README sayıları/anlatısı güncel yeşile eşitlendi; backlog'da 4 bayat kayıt KAPANDI +
  503 font-kökü kaydı FontRootHealth gerçeğine daraltıldı; poc §3.2 "korpus test edilmedi"
  başlığı sentetik-korpus gerçeğine döndü; ci.yml/MinioSmoke/PlayerPanel/editorBridge bayat
  yorumları düzeltildi; deploy/README damgası tazelendi. Eski↔gerçek çiftleri:
  `PROGRESS.md` §Geliştirme turu 3 #1.
- **Geliştirme turu 3 #2 — silme senkronu + revision retention + e2e temizliği**
  (2026-08-31, üç commit): (2a) SoftDelete sahibinin feed grubuna süreç-içi `assetRemoved`
  yayar; istemci satırı cache cerrahisiyle düşürür + kotayı tazeler (pasif sekme 33 ms'de
  gördü; `e2e/library-crosstab-delete.spec.ts`). (2b) `ProjectRevisionRetentionJob`
  (saatlik recurring): proje başına son 50 Auto + 24 sa'ten eskilerde saatlik inceltme;
  Checkpoint/PreRestore dokunulmaz; sabitler `RevisionRetention__*`. (2c)
  `scripts/cleanup-e2e.ps1`: 946 e2e hesabı + tüm verileri (15 435 proje, ~7 GiB obje)
  silindi, demo birebir korundu; elle koşum (teardown'a bağlanmadı — DECISIONS).
  Defter: `PROGRESS.md` §Geliştirme turu 3 #2.
- **Geliştirme turu 3 #3 — export perf 2. turu** (2026-09-01, baş mimar sözleşme kararıyla;
  üç commit `e364f2a`/`56abab7`/`6237fcf` + kapanış): kabul ölçütü GERÇEKÇİ fixtüre
  demirlendi (eski perf fixtürü çifte dejenereydi: overlay'ler örtülü + tuval dışı);
  (b) colorAdjust füzyonu (aşama 1-4 tek lutrgb, tek nihai round — normatif double tabloya
  24/33 vakada birebir, zarf golden'la çivili), (c) taban-tuval atlaması + (a) örtülen-katman
  budaması (§2.6: taze worker-probe olguları + tek-run kapsaması + BAYT-AYNILIK normu —
  çift-varyant canlı golden'lar + iki A/B worker sha256 eşitliği; örtülenin SESİ korunur),
  (d) N-paralel ERTELENDİ (DECISIONS). Sonuç: compReal-1080p 38,3→32,4 s (**1,85x**; kabul
  ölçütü 2026-09-01 kullanıcı kararıyla ≥1,8x'e daraltılıp KAPANDI — açık soru 6),
  örtülü sınıf 41,4→**20,1 s (2,99x)**, dikey 2,10x.
  Defter: `PROGRESS.md` §tur3 #3 + `performans-raporu.md` §12.
- **ozellik-fix — J geri taramada yabancı kare** (2026-09-02, kullanıcı hata bildirimi):
  kök neden ölçümle: her scrub seek'i readyState'i 62-86 ms çukura düşürür ve motor katmanı
  ÇİZMEYİP arka planı basardı (geri taramalarda örneklerin %55-61'i siyah; fare geri scrub'ı
  aynı — kusur scrub yolunun); ek olarak paused upload damgası taze kareyi hiç yüklemiyordu
  (one-behind) ve sınırda geriye-preload yoktu (~240 ms soğuk pencere). Düzeltme frontend-only
  (`engineV1` SlotFrame sahiplikli dip-cover + `'seeked'` damga düşürme; scheduler
  `PRELOAD_LOOKBEHIND_US` + seek-öncesi taban yakalama). Sonuç: aynı 6-rejimli probe 6/6
  SIFIR ihlal; 8x'te rAF ~25 fps dürüst maliyet (poc §2.8). Kalkanlar: `engineV1.scrub.test.ts`
  + scheduler lookbehind pinleri + `e2e/jkl-shuttle-frames.spec.ts`; negatif kontrol ×3
  md5-birebir. Defter: `PROGRESS.md` §Özellik turu satır F.
- Son yeşil sayılar (2026-09-03, `panel-2b` kapanışında bizzat koşuldu — dört kapı +
  prod build + TAM Playwright): backend **1626/1626** (0 skip, 2 dk 39 sn) · editör **1516** ·
  şema 235 · Playwright **194/194** (50 spec, 12,2 dk, 0 skip) · build -warnaserror 0 uyarı ·
  tsc -b + e2e tsc + prod build temiz. (Önceki taban 2026-09-03 `panel-1b`: editör 1493 ·
  Playwright 185/185 / 48 spec.)

## Devam edenler

- **Panel turu (2026-09-02 onaylı plan — 3 panel özelliği + kapanış denetimi): dilim 1 ✅,
  dilim 2 ✅, dilim 3 ✅ — ÜÇÜ DE TAMAM; kalan tek iş üç rollü kapanış denetimi
  (baş mimar + baş mühendis + baş geliştirici).** Dilim 3 iki commit: `panel-3a` ölçüm hattı
  (`audioGraph`'a master'ın paralel yaprak tap'i + `readMeter()` null semantiği, saf
  `core/meter.ts`, `engine.meter$`, §8.1 dB dönüşümlerinin `core/gain.ts`'e taşınması, altı
  motor mock'u — DOM'a sıfır dokunuş, tam suite 194/194 ile kanıtlı), `panel-3b` panel
  (`AudioMeter.tsx` timeline gövde satırının 3. hücresi, 30 Hz canvas + imperatif DOM,
  throttled `data-meter-*` test yüzeyi, mandal varken beliren sıfırlama düğmesi) + yeni
  `e2e/meter.spec.ts` (üç ardışık koşumda kararlı) + negatif kontrol ×2 + perf A/B
  (`performans-raporu §13`: p50 farkı −0,04 ms) + `poc §2.9` dürüstlük kaydı.

## Sıradakiler (öncelik sırasıyla — `DURUM.md` §6-7'nin kalanları)

1. `git push` — **kullanıcı onayı bekliyor** (origin 25+ commit geride; öncesinde ci.yml e2e
   redis boşluğu kapatılmalı — bkz. Bilinen sorunlar).
2. **Gerçek R2 + dağıtım** — kullanıcı anahtarları verince (`deploy/README.md` §4 adımları hazır).
3. Seçilmemiş borçlar (kullanıcı onayı yok): #9 `POST /api/overlays/measure`, #10 kota advisory-lock,
  #11 upload resume sertleştirme. (SignalR maddesi 2026-08-31'de KAPANDI; komşusu backlog B6 —
  çapraz-sekme kitaplık senkronu — da AYNI GÜN user-feed grubuyla KAPANDI, yarim-is-2 #5.)

## Bilinen sorunlar

- `DURUM.md` §5 risk tablosundan geçerli kalanlar: R2 denenmemiş; tek export worker'ı + poll;
  kota check-then-act + tamamlanma son-yazan-kazanır yarışları (düşük); SkiaSharp pin.
  (409 birim-pinsizlik satırı ve "tekrar düzenleme korunmuyor" kaydı 2026-08-31 küçükler
  dilimiyle KAPANDI; DURUM.md arşiv olduğu için orada güncellenmedi.)
- ~~Frontend'de 8+ boş `catch {}` / abort telemetrisiz~~ KAPANDI (2026-08-31, yarim-is-2 #6):
  tam envanter 35 sessiz catch (mekanik tarama), hepsi gerekçe-yorumlu; 4 abort sitesi dev-only
  `devWarn` izli (üretimde bilinçli sessiz); muhafız `silentCatchInventory.test.ts` yorumsuz
  sessiz catch eklenmesini kırmızıya düşürür. Defter: `PROGRESS.md` §Yarım-iş turu 2.
- ~~Silme çapraz-sekme senkronsuzluğu · ProjectRevisions sınırsız büyümesi · e2e hesap
  birikimi~~ ÜÇÜ DE KAPANDI (2026-08-31, gelistirme-3 #2 — bkz. Tamamlananlar; keşif turu
  tespitleriydi). e2e birikimi için kalıcı mekanizma ELLE koşulan betiktir (otomatik değil —
  yeniden şişerse `SKILLS e2e-hesap-temizligi`).
- Dev bağımlılığı: nanoid <3.3.18 high (yalnız vite zinciri, prod'a girmez).
- **ci.yml e2e job'u redis BAŞLATMIYOR** (SignalR-öncesi kalıntı; gelistirme-3 #1'de tespit):
  backend'in artık Redis tüketicisi var ve `export-progress-hub.spec.ts` Redis'in ayakta
  olmasını bekler — CI, SignalR sonrası hiç koşmadı (push beklemede), ilk koşumda bu job
  kırmızı düşebilir. Compose adımına redis eklemek DAVRANIŞ değişikliği olduğundan doküman
  diliminde yapılmadı; ci.yml'deki redis yorumu gerçeğe çevrildi + ayrı görev fişi açıldı.
  Push'tan önce kapatılmalı.

## Açık sorular (insana sorulacaklar)

1. Push: 2026-08-31'de yeniden soruldu — kullanıcı "beklesin" dedi (karar tazelendi).
2. R2: 2026-08-31'de soruldu — "henüz değil" (beklemede; anahtarlar kullanıcıdan).
3. ~~SignalR/Redis~~ KARAR VERİLDİ (2026-08-31): GETİRİLECEK — AYNI GÜN UYGULANDI (bkz.
   Tamamlananlar; DECISIONS satırı gerekçe + reddedilenlerle güncel).
4. SkiaSharp yükseltme penceresi (golden yeniden-kalibrasyon maliyetiyle) planlansın mı?
5. Import-yönü/katman kuralı (dep-cruiser sınıfı; lint'ten ayrı) istenir mi, mevcut gevşemeler kabul mü?
6. ~~Export perf hedefi~~ KARAR VERİLDİ (2026-09-01, kullanıcı — AskUserQuestion): kapsam
   ölçütü ölçülmüş duruma DARALTILDI ve KAPANDI — kabul: gerçekçi 1080p ≥1,8x (ölçülen
   1,85x) + örtülü sınıf 2,99x + dikey 2,10x + 720p 1,94x. (d) N-paralel AÇILMADI
   (DECISIONS satırı gerekçe + geri-alma koşuluyla: kullanıcı hedefi yeniden yükseltirse
   kendi sözleşme turuyla).
7. **Zaman kodu büyüklük sınırı (panel-1a, ONAY BEKLİYOR):** ayrıştırıcı sonucu 24 saatle
   sınırlar ve aşanı `'timecode too large'` ile TİPLİ olarak reddeder. Bu kural onaylı planın
   `100:00:00` (100 saat) örneğiyle ÇELİŞİR — plan o örneği "baştaki alan takvim sınırına
   uymaz" serbestliğinin örneği olarak verir; büyüklük kapısı görev talimatındaki ayrı bir
   kuraldır ve öyle uygulandı (gerekçe: `docs/DECISIONS.md` panel-1a satırı). 24 saat altındaki
   her hedef zaten proje sonuna kelepçelenir, yani sınır yalnız absürt girdileri görünür kılar.
   Kullanıcı tavanı kaldırmak ya da değiştirmek isterse tek sabit (`MAX_TIMECODE_US`) ve iki
   test satırı değişir.

## Ortam notu (2026-09-03, `panel-2b` kapanışı)

`panel-1b` turunun yayınları AYAKTA bulundu ve tazeliği doğrulandı: API PID 352088'in YÜKLÜ
modül yolu `…\api-run-p1\VideoEdit.Api.dll`, worker PID 304040 `…\worker-run-p1\…`; ikisi de
HEAD'den (`d0f3a3f`) yayınlanmıştı ve bu dilim FRONTEND-only olduğu için yeniden yayın
GEREKMEDİ. `/health` fonts `f8620403…861d` (16/16). Vite :5173 (200; dev server kaynaktan
servis eder). Docker üçlüsü healthy; kaçak ffmpeg 0 (TAM suite öncesi sayıldı).
Perf ölçümü için başlı tarayıcı: ms-playwright Chromium bu ortamda başlı modda HÂLÂ
spawn edilemiyor (`spawn UNKNOWN`) — ölçüm `channel: 'msedge'` ile başlı Edge'de yapıldı
(geçici config + geçici spec, ölçümden sonra SİLİNDİ; sonuç `performans-raporu §3.6`).
DİKKAT: yayın dizinleri session-scratchpad'te yaşar (`…\5fc88602-…\scratchpad`) — yeni
session onları bulamaz/güvenemez, `ortam-kaldirma` ile kendi yayınını yapmalı.
