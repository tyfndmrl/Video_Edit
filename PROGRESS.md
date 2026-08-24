# Yarım İşler — İlerleme Defteri

> 2026-08-22 durum tespitiyle çıkarılan ve kullanıcının onayladığı yarım işlerin kaydı.
> Tam liste ve gerekçeler: `docs/backlog.md`. Sıra kullanıcı onayıyla:
> #1 → #2 → #13 → #14 → #3 → #4 → #6 → #12 → #5.
> Kapsam dışı (kullanıcı kararı): #7 lint (hayır), #8 push (sonra), #9/#10/#11 (seçilmedi), #15 R2 (en sona).

| # | İş | Durum | Not |
|---|---|---|---|
| 1 | Sessiz videoda "Sesi ayır" tuzağı (`hasAudio` editöre bağlandı) | ✅ YAPILDI | Önce ölçüldü (gerçek fare → 422 `asset-clip-type`), sonra kapatıldı; menü gri + Türkçe gerekçe; birim+e2e+negatif kontrol. Editör 1306 / şema 212 / tsc temiz. |
| 2 | Inspector "ripple'sız en yavaş hız" sınırı yarım kare eksik | ⏳ SIRADA | |
| 13 | 503 font-kökü varsayımına sağlık kontrolü | ⏳ | |
| 14 | Kod yorumlarında tur numarası ayrışması | ⏳ | |
| 3 | 2160p bellek kabul kapısı | ⏳ | |
| 4 | media-urls manifest optimizasyonu | ⏳ | |
| 6 | IDOR regresyon test paketi | ⏳ | |
| 12 | GenerateDocumentationFile / XML doc borcu | ⏳ | |
| 5 | Export filtre grafiği performansı (EN SON — golden'lar elle) | ⏳ | |

## Ortam notları

- 2026-08-22: Docker Desktop kapanmış bulundu; kaldırıldıktan sonra taban çizgisi
  1415/1415 yeşil doğrulandı (dünkü 31 kırmızı ortamsaldı).
- Servisler scratchpad `api-run21` / `worker-run21` altından koşuyor.
