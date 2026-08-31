# CHANGELOG — ters kronolojik
Kaynaklar: `git log`, `PROGRESS.md`, `docs/backlog.md` tur kayıtları. Commit aralıkları doğrulanabilir.

## 2026-08-31
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
