# CHANGELOG — ters kronolojik
Kaynaklar: `git log`, `PROGRESS.md`, `docs/backlog.md` tur kayıtları. Commit aralıkları doğrulanabilir.

## 2026-08-31
- gelistirme-3 #2 — üç alt iş, üç commit: **(2a) asset silme çapraz-sekme senkronu**: SoftDelete
  artık sahibinin `user:{id}` feed grubuna SÜREÇ-İÇİ `assetRemoved` yollar (Contracts tek tanım
  `AssetRemovedMessage`; Redis turu yok — olay hub'la aynı süreçte); istemci satırı liste
  cache'lerinden cerrahiyle düşürür + yalnız kotayı invalidate eder + noticed setiyle geç worker
  mesajının diriltmesini keser. Kusur HEAD'de yeni spec'le yeniden üretildi (pasif sekme 30 sn
  görmedi); kapanış `e2e/library-crosstab-delete.spec.ts` (satır 33 ms'de odak/yenilemesiz,
  silme sonrası liste GET 0) + IDOR birim aynası; WS-engelli yedek yol değişmedi.
  **(2b) ProjectRevisions retention**: `ProjectRevisionRetentionJob` (saatlik recurring
  `revision-retention`) — proje başına son 50 Auto + 24 sa'ten eskilerde saat kovasına inceltme;
  Checkpoint/PreRestore hiç silinmez (sorgu + silmede çifte Kind kilidi); sabitler
  `RevisionRetention__*` config'i (açılışta Validate + etkin-değer logu). Önce ölçüldü: dev DB'de
  15 861 Auto / 29 MB birikmişti; canlı tetiklenen iş seed'in 10 eskisini süpürdü, korumalılar
  kaldı; muhafız `WorkerProgram_RegistersBothRecurringJobs`. **(2c) e2e hesap temizliği**:
  `scripts/cleanup-e2e.ps1` (dev-yönlü, elle; ürüne uç açılmadı, teardown'a bağlanmadı —
  DECISIONS) 946 e2e hesabını + 15 435 proje / 15 290 revizyon / 2 122 asset satırını ve ~7 GiB
  / 10 376 MinIO objesini sildi; demo birebir korundu (fail-fast desen kilidi — negatif kontrol:
  genişletilmiş desen exit 2 ile hiçbir şey silmeden durdu). Üç işte de negatif kontrol md5
  birebir; kapanış kapıları: build 0/0 · backend 1591/1591 skip 0 · şema 222 · editör 1342 ·
  tsc + e2e tsc + prod build temiz · Playwright TAM 164/164 (temizlik sonrası koşum).
- gelistirme-3 #1 — Defter/doküman senkronu (bayatlık sınıfı; DAVRANIŞ SIFIR — yalnız doküman
  metinleri + kod yorumları): README test sayıları/anlatısı güncel yeşile eşitlendi (1560→1579,
  1313→1339, 160→163; "pakete en son eklenen" relogin-reopen→library-crosstab-sync; UnitTests
  satırı STATE işaretine çevrildi — B4/CLAUDE.md deseni); backlog'da 4 bayat kayıt KAPANDI
  (ci.yml doğrulanamayan-sayı→B4 `3a1c256`; fitButton bayat-locator→`37a11b1`'de uygulanmış;
  bayat-dist prosedürü→SKILLS "schema-dist-tazeleme"; refetchIntervalInBackground kaydı
  "kaldırılMAYACAK — polling bilinçli yedek" kararıyla) + 503 font-kökü kaydı FontRootHealth
  gerçeğine daraltıldı (kalan iş: işletmeci karşılaştırması, deploy/README §5.2 adım 4);
  poc §3.2 başlığı gerçeğe döndü (sentetik korpus TEST EDİLDİ — `DirtyMediaCorpusTests`;
  gerçek telefon dosyası nüansı korundu); ci.yml "~9 dk (94 test)" yorumu sayısızlaştırıldı
  (timeout değeri DOKUNULMADI) ve e2e job'unun "backend'de Redis tüketicisi yok" yorumu
  düzeltildi (SignalR sonrası YANLIŞTI; job'un redis başlatmayışı AÇIK SORU olarak STATE'e
  yazıldı — davranış değişikliği bu dilimin dışı); MinioStorageSmokeTests "CI'da koşmaz"
  xmldoc'u düzeltildi (CI dotnet job'u MINIO_AVAILABLE=1 set eder); PlayerPanel/editorBridge
  "transitional/until the store carries userSeekSeq" yorumları savunma-dalı gerçeğine çevrildi
  (editorStore userSeekSeq'i tanımlar+0'la ilkler; KOD değişmedi); deploy/README durum notu
  damgası 2026-08-31 teyidiyle tazelendi. Kapılar: build -warnaserror 0/0 · backend 1579/1579
  skip 0 (MinIO+ffmpeg) · editör 1339 + şema 222 · tsc -b + e2e tsc temiz. Playwright
  GEREKMEDİ, negatif kontrol UYGULANAMAZ (davranış yok) — her düzeltmenin "önce yanlıştı"
  kanıtı PROGRESS satırında eski↔gerçek çiftleriyle.
- yarim-is-2 #5 — B6 çapraz-sekme kitaplık senkronu KAPANDI (user-feed grubu): worker'ın her
  progress publish'i artık `ownerId` (Jobs.RequestedBy) taşır; forwarder mesajı sahibinin
  `user:{id}` feed grubuna DA yollar (eski, alansız payload'da feed atlanır); hub'a
  PARAMETRESİZ `SubscribeUserFeed`/`UnsubscribeUserFeed` (kimlik JWT'den — başkasının feed'i
  adreslenemez; IDOR aynası `CrossUserAccessTests.Hub_SubscribeUserFeed_*`). İstemci:
  `useProjectAssets` kitaplık açıkken feed katkısı verir (bağlantı meşgul satır olmadan da
  yaşar), `handleProgressMessage` ardışık kopya teslimi süzer ve BİLİNMEYEN assetId'de listeyi
  + kotayı BİR kez invalidate eder (bilinen id'ler mevcut `asset:{id}` yolunda — fırtına yok).
  Önce ölçüldü: kusur yeni spec'le HEAD'de yeniden üretildi; complete→ilk publish n=3
  0,62-1,79 s (p50 0,74) → worker-publish yeterli, API'ye ikinci publish yönü AÇILMADI
  (DECISIONS). Kanıt: `e2e/library-crosstab-sync.spec.ts` (pasif sekme + ham-API yükleme:
  satır 2,85 sn'de, kota kendiliğinden, sayfa yüklemesi 0, ilk liste GET'i ilk feed
  mesajından SONRA; toplam 2 liste GET'i) + 5 yeni birim (novelty/dedupe/kota) + 4 backend
  (feed üyeliği, forwarder 3-grup, eski-payload atlanır, tel `ownerId` pini). Negatif kontrol
  ×3, md5 birebir. Yedek yol değişmedi (progress-fallback + export-progress-hub yeşil).
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
