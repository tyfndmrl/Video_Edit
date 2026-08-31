# STATE — mevcut durum
Son güncelleme: 2026-08-25, HEAD `1f964d0` (main). Ayrıntılı fotoğraf: `DURUM.md` (çift-rol denetim raporu).

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
- Son yeşil sayılar (2026-08-25, bizzat koşuldu): backend **1557/1557** (0 skip) · editör 1313 ·
  şema 222 · Playwright **159/159** · build -warnaserror 0 uyarı · prod bağımlılıklarında 0 açık.

## Devam edenler

- Yok. Çalışma ağacı temiz; süreklilik seti (bu dosyalar + `DURUM.md`) henüz commit'lenmedi.

## Sıradakiler (öncelik sırasıyla — `DURUM.md` §6-7 ile aynı)

1. Süreklilik setini commit'le (bu dosyalar).
2. `git push` — **kullanıcı onayı bekliyor** (origin 24+ commit geride).
3. **Gerçek R2 + dağıtım** — kullanıcı anahtarları verince (`deploy/README.md` §4 adımları hazır).
4. SignalR/Redis kararı: getir ya da iskeleyi sök (kod tüketicisi 0; compose+proxy+README şeması duruyor).
5. Küçükler: SaveTimeline 409 birim sözleşme pini — sözleşme: bayat `baseRevision` ile PUT /timeline
  → 409 + güncel doküman gövdesi (`ProjectEndpoints.cs` Conflict dalı; komşu test dosyası
  `TimelineRequestValidationTests`); "tekrar düzenleme" gerçek-medya e2e'sinin pakete alınması;
  README sayı/şema senkronu (`README:225/241` bayat); `compose.dev.yml:1` yorumu.
6. Seçilmemiş borçlar (kullanıcı onayı yok): #9 `POST /api/overlays/measure`, #10 kota advisory-lock,
  #11 upload resume sertleştirme.

## Bilinen sorunlar

- `DURUM.md` §5 risk tablosu geçerli: R2 denenmemiş; tek export worker'ı + poll; 409 birim-pinsiz;
  kota check-then-act + tamamlanma son-yazan-kazanır yarışları (düşük); SkiaSharp pin.
- Frontend'de 8+ gerekçeli-yorumlu boş `catch {}` — abort başarısızlığı telemetrisiz (tam envanter
  çıkarılmadı `[DOĞRULANMADI — tam sayı]`).
- Dev bağımlılığı: nanoid <3.3.18 high (yalnız vite zinciri, prod'a girmez).

## Açık sorular (insana sorulacaklar)

1. Push şimdi mi? ("sonra" kararı hâlâ geçerli mi?)
2. R2 dağıtımına ne zaman başlanacak; R2 hesap anahtarları?
3. SignalR/Redis: özellik olarak gelsin mi, iskele sökülsün mü?
4. SkiaSharp yükseltme penceresi (golden yeniden-kalibrasyon maliyetiyle) planlansın mı?
5. Import-yönü/katman kuralı (dep-cruiser sınıfı; lint'ten ayrı) istenir mi, mevcut gevşemeler kabul mü?

## Ortam notu (2026-08-25 sonu)

Servisler `api-run-bfinal`/`worker-run-bfinal` (HEAD kod-eşdeğeri) + Vite :5173 çalışır bırakıldı;
Docker üçlüsü healthy. Yeni session ortamı `docs/SKILLS.md → ortam-kaldirma` ile doğrulamalı
(Docker Desktop kapanmış olabilir — bilinen desen).
