# Yarım İşler — İlerleme Defteri

> 2026-08-22 durum tespitiyle çıkarılan ve kullanıcının onayladığı yarım işlerin kaydı.
> Tam liste ve gerekçeler: `docs/backlog.md`. Sıra kullanıcı onayıyla:
> #1 → #2 → #13 → #14 → #3 → #4 → #6 → #12 → #5.
> Kapsam dışı (kullanıcı kararı): #7 lint (hayır), #8 push (sonra), #9/#10/#11 (seçilmedi), #15 R2 (en sona).

| # | İş | Durum | Not |
|---|---|---|---|
| 1 | Sessiz videoda "Sesi ayır" tuzağı (`hasAudio` editöre bağlandı) | ✅ YAPILDI | Önce ölçüldü (gerçek fare → 422 `asset-clip-type`), sonra kapatıldı; menü gri + Türkçe gerekçe; birim+e2e+negatif kontrol. Editör 1306 / şema 212 / tsc temiz. |
| 2 | Inspector "ripple'sız en yavaş hız" sınırı yarım kare eksik | ✅ YAPILDI | Önce ölçüldü (backlog'un fazı frame 0'da: panel 0.5x önerdi, op "sonraki klibe giriyor" dedi). Sınır artık op'un KENDİ planlayıcısıyla türetiliyor (`minSpeedRateWithoutRipple`: `planClipSpeed` kabul kâhini, ikinci aritmetik kopyası yok); öneri her zaman uygulanabilir, bir ızgara adımı yavaşı RET (30/29.97/24 fps 144'lük tarama). Gerçek-klavye e2e: 0.497 RET + 0.498 KABUL. Negatif kontrol md5 birebir. Editör 1313 / tsc + e2e tsc temiz. |
| 13 | 503 font-kökü varsayımına sağlık kontrolü | ✅ YAPILDI | "API ile worker AYNI kökü görür" varsayımı artık ölçülebilir: iki uç aynı türetimi (`FontRootHealth` — fontId/dosya sayıları + manifest+lock pin setinin sha256 parmak izi) raporlar; API `GET /health` `fonts` bölümü (font eksiğinde de 200 — rapor dürüst, kapı değil), worker açılış satırı. RPC yok; karşılaştırma işletmecide (deploy/README §5.2 adım 4). Canlı ölçüldü: sağlam kökte iki taraf birebir aynı parmak izi (`f862…861d`), env'siz ikinci API süreci `found:false` + bakılan yol + sebep döndü. 5 yeni test (köklü/köksüz uç + lock tutarlılığı + sıra bağımsızlığı); negatif kontrol: iki mekanizma ayrı ayrı kırmızı, md5 birebir geri. Backend 1420/1420, skip 0. |
| 14 | Kod yorumlarında tur numarası ayrışması | ✅ YAPILDI | Kaynak koddaki (apps/backend/packages) TÜM tarihsel tur/dalga/"M6 denetimi" yorum atıfları kalıcı gerekçeye çevrildi (ölçülmüş sayılar korundu); milestone etiketleri ve bulgu numaraları (#1, N1 — arşiv kimliği) yerinde. Test ADLARI ve dizge literalleri bilerek dokunulmadı (davranış sıfır). Mekanik kanıt: diff'te (75 kod dosyası, 181+/171−) yorum-olmayan değişen satır sayısı 0 (scratchpad taraması). Build -warnaserror 0/0; backend 1420/1420 skip 0 (MinIO'lu); editör 1313 + şema 212; tsc -b temiz. Backlog kaydı KAPANDI. |
| 3 | 2160p bellek kabul kapısı | ⏳ | |
| 4 | media-urls manifest optimizasyonu | ⏳ | |
| 6 | IDOR regresyon test paketi | ⏳ | |
| 12 | GenerateDocumentationFile / XML doc borcu | ⏳ | |
| 5 | Export filtre grafiği performansı (EN SON — golden'lar elle) | ⏳ | |

## Ortam notları

- 2026-08-22: Docker Desktop kapanmış bulundu; kaldırıldıktan sonra taban çizgisi
  1415/1415 yeşil doğrulandı (dünkü 31 kırmızı ortamsaldı).
- Servisler scratchpad `api-run21` / `worker-run21` altından koşuyor.
