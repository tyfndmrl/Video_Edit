# STATE — mevcut durum
Son güncelleme: 2026-09-01, gelistirme-3 #3 (export perf 2. turu — baş mimar sözleşme
kararıyla üç bacak; öncesi #1 defter senkronu + #2 silme/retention/temizlik, main).
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
- Son yeşil sayılar (2026-09-01, gelistirme-3 #3 kapanışında bizzat koşuldu — dört kapı +
  prod build + TAM Playwright): backend **1626/1626** (0 skip) · editör 1342 · şema 222 ·
  Playwright **164/164** (42 spec, 10,4 dk) · build -warnaserror 0 uyarı · tsc + e2e tsc +
  prod build temiz.

## Devam edenler

- Yok. Çalışma ağacı gelistirme-3 #3 kapanış commit'iyle temiz.

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

## Ortam notu (2026-09-01 sonu, gelistirme-3 #3 dilimi)

Servisler bu session'ın scratchpad'inden: API `api-run-g31` (HEAD 989ddd1 — API davranışı
turda değişmedi) + Worker `worker-run-g3d` (üç bacaklı nihai kod; tazelik yüklü modül yolu +
canlı yakalanan budanmış filtergraph ile kanıtlı) + Vite :5173. Ara yayınlar `worker-run-g3b`
(yalnız füzyon) ve `worker-run-g3c` (füzyon+atlama) A/B sha256 kanıtlarının ikilileri olarak
scratchpad'te duruyor. Docker üçlüsü healthy; kaçak ffmpeg yok. Perf fixtürleri
`perf20@videoedit.test` hesabında (compReal/compCovered/compDikey — `g3perf/seed-fixtures.mjs`).
DİKKAT: yayın dizinleri session-scratchpad'te yaşar — yeni session onları bulamaz/güvenemez,
`ortam-kaldirma` ile kendi yayınını yapmalı.
