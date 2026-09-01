# CHANGELOG — ters kronolojik
Kaynaklar: `git log`, `PROGRESS.md`, `docs/backlog.md` tur kayıtları. Commit aralıkları doğrulanabilir.

## 2026-09-01
- ozellik-5a — J sessiz geri tarama: transport store + tek-hız shuttle (özellik turu
  dilim 5a, FRONTEND-only; `engineV1.ts` dokunulmadı): YENİ `shortcuts/shuttle.ts` —
  33 ms metronom, İÇ FLOAT akümülatör (kare-yapışık store değerinden geri hesap
  yuvarlanma-stall'ı üretirdi), her yazım kare-ızgara-yapışık `setPlayheadUs('user')`
  → mevcut scrub yolu kareyi getirir; motor paused kaldığı için sessizlik YAPISAL.
  `useTransportStore` ({forwardRate, shuttleRate}) — dispatcher'ın forwardRate
  modül-let'i store'a taşındı. İptal tik içinde: isPlaying / dış user seek (userSeekSeq
  farkı) / BOF'ta TAM 0 + dur. Geçiş matrisi: J=pause+shuttle (repeat yutulur; eski
  stepSeconds(-1) dalı silindi), K=dur+pause, L=dur+ileri 1x'ten, Space=dur AMA
  OYNATMAZ (NLE uzlaşımı). PlayerPanel rozeti `transport-shuttle-note` ('Geri tarama
  1x — ses kapalı' + v2 dürüstlük title'ı; previewRate$ rozeti kullanılmadı — plan
  reddi). +9 birim (shuttle 4 + dispatcher matrisi 5; editör 1414→1423) + YENİ gerçek
  klavye `e2e/jkl-shuttle.spec.ts` (2 test: J iki örnekte kesin küçülme + isPlaying
  false kalır + rozet; K sabitler; L ileri; BOF tam 0 + rozet kalkar). Negatif kontrol
  md5-birebir: BOF kelepçesi söküldü → birim `expected 1 to be null` + e2e rozet
  `unexpected value "visible"` kırmızı. Defter: `PROGRESS.md` §Özellik turu.
- ozellik-4 — klip grupları: Ctrl+G grupla, grup birlikte taşınır (özellik turu dilim 4,
  FRONTEND-only): `groupClips`/`ungroupClips` + blockReason'ları (timelineOps — tek modül).
  Grupla: önce LINK kapanışı (linkli üyenin eşi OTOMATİK dahil — invariant kural 10'un grup
  kolu böyle KURULUR), kapanış sonrası <2 klip → 'need at least two clips to group', kilitli
  üye → 'track is locked'; kapanmış kümeye TAZE tek groupId (BİRLEŞTİRME semantiği: üyelerin
  eski üyelikleri ezilir; eski gruplardan tek kalan üyenin groupId'si AYNI mutate'te
  temizlenir — kural 11, tek undo). Dağıt: seçimin dokunduğu HER grubun TÜM üyelerinden
  groupId silinir (üye çıkarma değil grup dağıtma — tek üyeli ara durum hiç doğmaz); linkId
  DOKUNULMAZ (bağ gruptan bağımsız yaşar). Menü: 'Grupla' (Ctrl+G) + 'Grubu dağıt'
  (Ctrl+Shift+G) Bağla bloğunda, gated sözleşme (disabled = op blockReason'ı); dispatcher
  Ctrl+G/Ctrl+Shift+G (docMutationAllowed kapısından) + shortcutsHelp satırı; drawTracks
  gruplu klipte 2px ÜST ŞERİT (satır yüksekliği/geometri değişmedi). Taşıma kod değişikliği
  GEREKMEDİ: dilim-2 'move' kapanışı groupId'yi zaten işliyordu — karışık AV grupta bölüm
  kapsamlı delta dahil grup-odaklı birim pinleriyle sabitlendi. +21 birim (timelineOps +14,
  guardPaths (e) ayrışmazlık çiftleri +5, dispatcher +2; editör 1393→1414) + yeni gerçek
  fare/klavye `e2e/group-clips.spec.ts` (2 test: böl→marquee→Grupla→ortak groupId; TEK
  seçili üye sürüklenince ÜÇÜ kayar; tek üye Delete → kalan ikili grup yaşar; Ctrl+Shift+G
  sonrası yalnız biri kayar; Ctrl+A+Ctrl+G klavye yolu; gri öğe data-block-reason + Türkçe
  title). Negatif kontrol ×2 md5-birebir (kapanış genişletmesi söküldü → 4 birim + e2e tam
  imza; eski-grup temizliği söküldü → MERGE birimi dev doc kapısının kural-11 ihlaliyle
  kırmızı). Defter: `PROGRESS.md` §Özellik turu.
- ozellik-3 — otomatik AV ayrımı: video ekleme linkli çift klip (özellik turu dilim 3,
  FRONTEND-only): SAF planlayıcı `planAddClipFromAsset` EXPORT edildi — commit
  (`addClipFromAsset`), timeline ekleme hayaleti (insertTargetFor) ve blok gerekçeleri AYNI
  planı okur ("ghost geçerli dedi, drop reddetti" imkânsız). Karar tablosu: image/audio TEK
  klip; video+hasAudio=true ÇİFT klip (video yarısı `audio:null` + detachAudio formülüyle ses
  ikizi + ORTAK taze linkId, TEK mutate = TEK undo, İKİSİ birden seçili);
  video+hasAudio=false TEK klip ve `buildClipFromAsset` artık `audio:null` yazar (detach
  menüsü 'clip has no embedded audio' ile doğru grilenir); hasAudio bilinmeyen TEK klip
  gömülü sesle (ikiz üretmek ölçülmüş 422 tuzağı). Ses yerleşimi: ilk kilitsiz+aralıkta boş
  audio track; yoksa YENİ track (partisyon: en alta) + notice 'audio placed on a new track'
  (balon yolu = TRANSITION_DROPPED emsali; drop işleyicisi artık reportOp'tan geçer). KISMİ
  BAŞARI YASAK: plan tavanı aşarsa (frontend `MAX_TRACKS=50`, sunucu aynası) TÜMÜ RED
  'track limit reached'; toplam yeni-track sayısı hesaba girer (49→51 köşesi kapalı). Çoklu
  insert ghost'u (DragVisual.insert `ghosts[]` — AV asset video satırı + ses satırı).
  +14 birim (editör 1393; karar tablosu, tek undo, yerleşim politikası, tavan, plan↔commit
  ayrışmazlığı) + yeni gerçek-fare `e2e/auto-av-add.spec.ts` (2 test: çift doğum + ses
  track'i en altta + notice balonu + tek Ctrl+Z + tekrar ekle→birlikte taşıma; sessiz
  video/görsel negatifleri). Gerçek-medya spec varsayım taraması: media-upload, library-dnd,
  detach-audio-silent (sesli senaryo artık oto-ayrılmış çift), export-flow,
  export-progress-hub, progress-fallback, frame-grid, guard-paths (bölme 4 klip),
  library-manage (kullanım sayacı 2 klip) yeni davranışa güncellendi. Negatif kontrol ×2
  md5-birebir (çift üretim söküldü → 8 birim + e2e tam imza; kısmi-başarı muhafızı söküldü →
  2 'tümü RED' birim testi kırmızı). Defter: `PROGRESS.md` §Özellik turu.
- ozellik-2 — linkId çekirdeği: link/unlink + sil/böl/taşı kapanışı (özellik turu dilim 2):
  SAF kapanış yardımcısı `expandSelectionForOp` ('link' = eş; 'move' = grup üyeleri + eşler,
  K3 sayesinde tek geçiş) OP İÇİNDE uygulanır: deleteClips (eş kilitli track'teyse TÜM silme
  RED — yarım silme dangling linkId üretirdi; küçülen grup temizliği aynı mutate), deleteTrack
  (eş bağı + grup temizliği), splitAtPlayhead (çift taraf bölünürse sağ yarılara taze ORTAK
  linkId; ikinci yarı her zaman bağsız doğar, groupId kalır), moveClips (girişte 'move'
  kapanışı + planMoveClips'te BÖLÜM-KAPSAMLI trackDelta: anchor'ın bölümü şerit değiştirir,
  diğer bölüm kendi şeridinde yatay kayar — CapCut davranışı; tip kapısı kalır).
  `linkClips`/`unlinkClips` + sağ tık 'Bağla'/'Bağlantıyı kaldır' (blockReason sözleşmesi +
  5 Türkçe çeviri); duplicate/paste `remintLinkAndGroupIds` (çift kopya kendi içinde bağlı,
  yarım kopya bağsız); detachAudio çifti bağlı doğurur (zaten-bağlı videoda detach RED —
  invariant koruması); trim bağa DOKUNMAZ (kullanıcı kararı, negatif pinli); zincir rozeti
  (drawTracks, yükseklik değişmedi); appBridge linkId/groupId. +29 birim (editör 1379) +
  yeni gerçek-fare `e2e/link-clips.spec.ts` (2 test) + detach-audio-silent linkId satırı.
  Negatif kontrol ×2 md5-birebir (delete kapanışı → birim+e2e tam imza; bölüm-deltası →
  'track type mismatch'). Defter: `PROGRESS.md` §Özellik turu.
- ozellik-1 — track partisyonu: video/overlay üstte, ses altta (özellik turu dilim 1):
  `insertTrackPositioned` op-politikası (audio→en alta, video/overlay→ilk audio'nun önüne;
  overlay klip-ekleme yolu bilinçli unshift'te — en üst katman kararı korunur, indeks 0
  partisyonu zaten sağlar); `trackMoveBlockReason` ihlal takasına
  'audio tracks stay below video tracks' (düzeltici yön serbest — karışık eski belge kullanıcı
  taşımasıyla düzelir, otomatik normalize yok); görsel ayraç YÜKSEKLİK EKLEMEDEN (canvas'ta
  TRACK_GAP içine 1px çizgi + DOM başlıkta border-top; geometri formülleri değişmedi).
  +8 birim test (timelineOps 65) + track-manage.spec'e gerçek-fare partisyon senaryosu.
  Negatif kontrol: partisyon düz push'a döndürüldü → 5 test tam imzayla kırmızı →
  md5-birebir geri. Defter: `PROGRESS.md` §Özellik turu.
- ozellik-0 — şema linkId/groupId + link-grup-kind invariant pass + codegen (özellik turu
  dilim 0): MediaClipSchema'ya opsiyonel `linkId` (AV çifti bağı), klip tabanına opsiyonel
  `groupId`; invariants.ts'e kural 10-12 + YENİ doküman-geçişli pass
  `checkLinkAndGroupInvariants` (link TAM 2 klip = bir video + bir audio; grup ≥2 üye; link
  eşleri özdeş groupId; kind↔track-tipi savunması). schemaVersion=1 kaldı; codegen zinciri
  (timeline.schema.json + TimelineContracts.g.cs: nullable LinkId/GroupId) koşuldu; +13
  paket testi (235), eski doküman değişmeden-geçerli pini; negatif kontrol md5-birebir.
  Dört kapı + prod build yeşil (backend 1626/1626 skip 0). Defter: `PROGRESS.md` §Özellik turu.
- gelistirme-3 #3 — export perf 2. turu (baş mimar sözleşme kararıyla; üç bacak, üç commit +
  kapanış): **Bacak 0** — eski perf fixtürünün çifte kusuru (overlay'ler örtülü + tuval dışı)
  kaynağından doğrulandı; compReal/compCovered/compDikey fixtürleri kuruldu, **≥2x ölçütü
  gerçekçi compReal-1080p'ye yeniden demirlendi** (taban 38,3 s / 1,57x). **(b) colorAdjust
  füzyonu** (`e364f2a`): aşama 1-4 kanal-başına TEK lutrgb bileşik ifadesi (DOUBLE +
  aşama-başına clip + tek nihai round — ölçümle seçildi: normatif double tabloya 33 vakanın
  24'ünde BİREBİR, kalanı ±1 LSB; eski↔füzyon ≤ ±3 LSB golden'la çivili); rig p50 −7,1 s,
  canlı 41,4→35,5 s. **(c) taban-tuval atlaması** (`56abab7`): §2.6 örtücü yüklemi (taze
  worker-probe olguları: aspect çapraz-çarpımı + SAR=1 + alfasız pix_fmt izin listesi) ile
  en alt tam-örtücü run'da taban tuval + ilk overlay düşer — çıktı BAYT-AYNI (çift-varyant
  canlı golden + g3b↔g3c sha256 eşitliği); canlı 35,75→32,3 s. **(a) örtülen-katman budaması**
  (`6237fcf`): üstteki tek örtücünün penceresi kapsayan run'ın video zinciri üretilmez (ses +
  girişler AYNEN — örtülen duyulur); daraltılmış SourceWidth doktrini + §2.6 bayt-aynılık
  normu; canlı compCovered 28,35→**20,1 s (2,99x)** + g3c↔g3d sha256 eşit; canlı grafik
  budanan zincirlerin yokluğunu gösteriyor. **(d) N-paralel ERTELENDİ** (DECISIONS).
  Nihai matris (§12.5): compReal 1,94x/**1,85x**/1,41x, compCovered 3,23x/2,99x/1,96x,
  dikey 2,10x (ilk ölçüm), eski fixtür 2,90x. Hedef compReal-1080p'de karşılanmadı (1,85x) —
  (d) açılmadan kullanıcıya soruldu (STATE). Negatif kontroller: (b) clip düşürme → 2 kırmızı;
  (c) koşul tersleme → 27 kırmızı; (a) kapsama→kesişme → 5 kırmızı (bayt golden'ı tam
  sözleşme mesajıyla); hepsi md5-birebir geri. Yeni kalıcı muhafızlar: füzyon zarf golden'ı,
  2 çift-varyant bayt-aynılık golden'ı, örtme yüklem envanteri (ExportCoverOptimizationTests),
  pix_fmt/SAR parser testleri, 2 yeni snapshot fixtürü. Dokümanlar: rendering-semantics §4.1
  yazılış kutusu + YENİ §2.6; CompiledExport daraltılmış doktrin; DECISIONS +3 satır;
  performans-raporu §12; backlog "AÇIK KALANLAR" kapandı.

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
