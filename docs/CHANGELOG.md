# CHANGELOG — ters kronolojik
Kaynaklar: `git log`, `PROGRESS.md`, `docs/backlog.md` tur kayıtları. Commit aralıkları doğrulanabilir.

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
