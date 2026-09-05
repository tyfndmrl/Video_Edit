# VideoEdit
Son güncelleme: 2026-09-05

## Nedir

Tarayıcıda çalışan, CapCut benzeri çok katmanlı video editörü POC'u. Kullanıcı videosunu
yükler (tarayıcıdan doğrudan multipart → MinIO/R2), canvas timeline'da düzenler (kes/böl/taşı,
geçişler, metin/şekil/sticker, renk, LUT, hız, keyframe), WebGL2 önizlemede izler ve final
videoyu sunucuda ffmpeg render eder. Frontend React 19 + zustand + WebGL2; backend .NET 10
Minimal API + Hangfire worker; PostgreSQL (timeline jsonb) + MinIO (dev'de R2 yerine) +
Redis (canlı ilerleme pub/sub'ı — zorunlu değil, yoklama yedeği durur).

## Kapsam

**Yapar:** çoklu katman timeline (ses/video track partisyonu; otomatik AV ayrımlı ekleme +
link/unlink; klip grupları Ctrl+G; J sessiz kademeli geri tarama — özellik turu 2026-09-01);
kırpma/kesme/ayırma/taşıma; frame/zoom/timecode/player/kısayollar (transport zaman koduna
ELLE değer yazıp atlama + proje sonu kelepçesi — panel turu dilim 1, 2026-09-03; timeline'ın
sürükle/klavye ile DİKEY boyutlandırılması — dilim 2, yükseklik tarayıcıda kalıcı, belgeye
YAZILMAZ; timeline'ın sağında her zaman açık master stereo SES ÖLÇERİ — tepe tutucu + klip
mandalı + dBFS skalası, dilim 3, ÖNİZLEME miksini ölçer — önizlemede limiter YOKTUR, limiter export'tadır; poc §2.9);
undo-redo + işlem geçmişi; geçişler; metin/şekil/sticker; colorAdjust + LUT (.cube); hız; keyframe;
ses/müzik miksi; export profilleri (720p/1080p/2160p/dikey); hesap + kota + versiyon geçmişi;
SignalR canlı ilerleme (worker→Redis→`/hubs/progress`; polling YEDEK — 2026-08-31; `user:{id}`
feed'iyle çapraz-sekme kitaplık senkronu dahil).

**Yapmaz (bilinçli, kayıtlı):** gerçek Cloudflare R2 (hiç denenmedi — dev+CI MinIO), `fx.*`
keyframe kanalı, hız rampası, emoji/tam shaping, mobil, çoklu-worker işletimi, lint (kullanıcı
kararı). (SignalR user-feed grubu 2026-08-31'de GELDİ — çapraz-sekme kitaplık senkronu / B6
KAPANDI, `yarim-is-2 #5`.) Ayrıntı: `docs/poc-bilinen-sinirlar.md`.

## Yetenek Haritası

### Bu dokümanlarla yeni bir session şunları yapabilir
- Ortamı sıfırdan kaldırıp dört test paketini koşmak (`docs/SKILLS.md` → ortam-kaldirma, test-paketleri)
- Yeni bir borç/özellik maddesini yerleşik protokole uygun kapatmak (`docs/WORKFLOWS.md` → borç kapama)
- Canlı ikilinin tazeliğini kanıtlamak, negatif kontrol koşmak, perf ölçmek (SKILLS.md ilgili girdiler)
- Denetim (baş mimar / baş geliştirici) turu düzenlemek (`docs/WORKFLOWS.md` → denetim turu)
- Demo verisi kurup uçtan uca akışı gerçek fare/klavye ile doğrulamak
- e2e hesap birikimini güvenli silmek (`docs/SKILLS.md` → e2e-hesap-temizligi; demo korumalı)

### Yapamaz / önce insana sormalı
- `git push` — kullanıcı "sonra" dedi; origin bilinçli geride (karar: kullanıcı)
- Gerçek R2 dağıtımı — R2 hesap anahtarları kullanıcıdan gelmeli
- MVP-dışı özellik başlatmak (fx.*, hız rampası, emoji…) — kapsam kararı kullanıcının
- SkiaSharp yükseltmesi — tüm golden PNG'ler 3.116'ya kalibre; yeniden kalibrasyon kararı ister
- Lint kurulumu — kullanıcı açıkça HAYIR dedi (`PROGRESS.md` başlığı)

## Okuma Sırası

1. `docs/STATE.md` — her zaman, ilk (mevcut durum + açık sorular)
2. `docs/SKILLS.md` — herhangi bir iş yürütmeden önce (ortam/tuzaklar burada)
3. `docs/WORKFLOWS.md` — çok adımlı işlerde (borç kapama / denetim protokolleri)
4. `docs/DECISIONS.md` — mimari/yaklaşım değiştirmeden önce (reddedilen alternatifler!)
5. Derin bağlam gerektiğinde: `docs/backlog.md` (tam borç tarihçesi),
   `docs/poc-bilinen-sinirlar.md` (ölçülmüş sınırlar), `docs/rendering-semantics.md` (normatif
   render sözleşmesi), `docs/review-gate.md` (bağlayıcı denetim kuralları), `DURUM.md` (son denetim raporu)

## Session Protokolleri

**Açılış (P2 — kullanıcı promptu yapıştırmasa da uygula):** Okuma sırasını izle; ilk mesajda somut
iş talimatı YOKSA önce ≤15 satırlık rapor ver (ne/neredeyiz/yapabilirim/yapamam+eksik/tutarsızlık),
işi bloke eden en fazla 3 soru sor ve dosya değiştirmeden bekle. İş talimatı VARSA raporu 3-5 satıra
indir ve işe başla. Doküman ile gerçek dosya çelişirse GERÇEK DOSYA doğrudur; çelişkiyi bildir.

**Kapanış (P3 — her session sonunda; dilim içinde de sürekli):** `docs/CHANGELOG.md` + `docs/STATE.md`
güncelle; dokunulan SKILLS girdilerinin "Son doğrulanma" tarihini çek; yeni karar varsa DECISIONS'a
(reddedilen alternatifiyle); yetenek haritası değiştiyse bu dosyayı. Değişmeyene dokunma. Son satır:
bir sonraki session'ın ilk işi. Güncellenmeyen set, yanlış bilgi verdiği için hiç set olmamasından kötüdür.

## Kırmızı Çizgiler

- `docs/review-gate.md` BAĞLAYICIDIR: (1) başka bir ajanın/raporun çıktısı kanıt değildir — iddiayı
  KENDİN koşarak doğrula; (2) UI iddiası yalnız GERÇEK girdiyle kanıtlanır (Playwright
  `page.mouse`/`page.keyboard`; `dispatchEvent`/store çağrısı kanıt DEĞİLDİR).
- `docs/audits/` altındaki arşiv dosyalarına DOKUNULMAZ (denetim anının ham kaydı).
- Sessiz düzeltme yerine görünür hata: bir belge ya doğru render edilir ya tipli senkron 422 alır;
  kuyruk-sonrası ölüm ve sessiz yanlış geometri kabul edilmez.
- Her davranış düzeltmesi NEGATİF KONTROL ister (boz → test kırmızı → geri al, md5 kanıtıyla).
- Bir cümle kanıtlanandan fazlasını iddia ediyorsa yanlıştır; sınanmamış rejim KAPSAM DIŞI ilan edilir.
- `docs/DECISIONS.md`'de reddedilmiş bir alternatifi, neyin değiştiğini gerekçelendirmeden yeniden önerme.
- Kod yorumlarına satır numarası ve doğrulanmamış sayı yazılmaz (bayatlama sınıfı — kayıtlı ders).

## Dizin (özet — tamamı `docs/STRUCTURE.md`)

| Yol | İçerik |
|---|---|
| `apps/editor/` | React editör + `e2e/` Playwright (yalnız gerçek girdi) |
| `packages/timeline-schema/` | zod şema + invariants + `test-vectors/` (çift-dil parite) |
| `backend/src/` | 6 .NET projesi (Api/Worker/Media/Domain/Infrastructure/Contracts) |
| `backend/tests/` | golden/snapshot/muhafız defterleri/korpus (güncel sayılar: `docs/STATE.md`) |
| `docs/` | kanonik tarihçe + normatif sözleşmeler + bu setin dosyaları |
| `PROGRESS.md` | yarım-iş ve B-borçları turlarının defteri |
