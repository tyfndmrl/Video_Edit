# STATE — mevcut durum
Son güncelleme: 2026-08-31, SignalR ilerleme kanalı dilimiyle (öncesi küçükler `b08ce3a`, main).
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
- Son yeşil sayılar (2026-08-31, SignalR dilimi sonunda bizzat koşuldu): backend
  **1575/1575** (0 skip) · editör 1324 · şema 222 · Playwright **162/162** (10,3 dk) ·
  build -warnaserror (tam rebuild) 0 uyarı · tsc + e2e tsc + prod build temiz.

## Devam edenler

- Yok. Çalışma ağacı SignalR dilimi commit'iyle temiz.

## Sıradakiler (öncelik sırasıyla — `DURUM.md` §6-7'nin kalanları)

1. `git push` — **kullanıcı onayı bekliyor** (origin 25+ commit geride).
2. **Gerçek R2 + dağıtım** — kullanıcı anahtarları verince (`deploy/README.md` §4 adımları hazır).
3. Seçilmemiş borçlar (kullanıcı onayı yok): #9 `POST /api/overlays/measure`, #10 kota advisory-lock,
  #11 upload resume sertleştirme. (SignalR maddesi 2026-08-31'de KAPANDI; kalan komşu iş
  backlog B6 — çapraz-sekme kitaplık senkronu user-feed grubu ister, kapsam dışı bırakıldı.)

## Bilinen sorunlar

- `DURUM.md` §5 risk tablosundan geçerli kalanlar: R2 denenmemiş; tek export worker'ı + poll;
  kota check-then-act + tamamlanma son-yazan-kazanır yarışları (düşük); SkiaSharp pin.
  (409 birim-pinsizlik satırı ve "tekrar düzenleme korunmuyor" kaydı 2026-08-31 küçükler
  dilimiyle KAPANDI; DURUM.md arşiv olduğu için orada güncellenmedi.)
- Frontend'de 8+ gerekçeli-yorumlu boş `catch {}` — abort başarısızlığı telemetrisiz (tam envanter
  çıkarılmadı `[DOĞRULANMADI — tam sayı]`).
- Dev bağımlılığı: nanoid <3.3.18 high (yalnız vite zinciri, prod'a girmez).

## Açık sorular (insana sorulacaklar)

1. Push: 2026-08-31'de yeniden soruldu — kullanıcı "beklesin" dedi (karar tazelendi).
2. R2: 2026-08-31'de soruldu — "henüz değil" (beklemede; anahtarlar kullanıcıdan).
3. ~~SignalR/Redis~~ KARAR VERİLDİ (2026-08-31): GETİRİLECEK — AYNI GÜN UYGULANDI (bkz.
   Tamamlananlar; DECISIONS satırı gerekçe + reddedilenlerle güncel).
4. SkiaSharp yükseltme penceresi (golden yeniden-kalibrasyon maliyetiyle) planlansın mı?
5. Import-yönü/katman kuralı (dep-cruiser sınıfı; lint'ten ayrı) istenir mi, mevcut gevşemeler kabul mü?

## Ortam notu (2026-08-31 sonu, SignalR dilimi)

Servisler bu session'ın scratchpad'inden yayınlanan `api-run-signalr`/`worker-run-signalr`
(HEAD kodu; tazelik yüklü modül yolu + 6 iğneyle kanıtlı: `JobProgressHub`,
`RedisProgressForwarder`, `RedisJobProgressPublisher`, `PublishProgressAsync` UTF-8;
`job-progress`, `/hubs/progress` UTF-16) + taze Vite :5173 (yeni `@microsoft/signalr`
bağımlılığı için restart ŞART) çalışır durumda bırakıldı; Docker üçlüsü healthy — Redis
artık canlı kanalın taşıyıcısıdır ama ZORUNLU DEĞİLDİR (kapalıyken API/Worker açılır,
polling taşır; canlıda ölçüldü). DİKKAT: yayın dizinleri session-scratchpad'te yaşar —
yeni session onları bulamaz/güvenemez, `ortam-kaldirma` ile kendi yayınını yapmalı.
