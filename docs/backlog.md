# Teknik Backlog — Baş Mimar Denetim Bulguları

M0 denetiminde (2026-08-06, 37 bulgu) tespit edilip **bilinçli olarak ertelenen** maddeler. Her madde hedef milestone'a eşlendi. Kritik + yüksek bulguların tamamı ve ucuz orta bulgular M0'da düzeltildi (bkz. git geçmişi).

## M1 (Upload + işleme)
- **Waveform üretimi .NET içinde**: `audiowaveform` Debian'da paket olarak yok (denetim bulgusu #6); karar — worker ffmpeg ile PCM çekip C#'ta min/max pencereleme yapacak (tasarım `docs/design/02` §3.5'teki alternatif). Dockerfile'dan bağımlılık kaldırıldı.
- **Rate limiting**: auth (login/register) ve asset presign/init endpoint'leri (`AddRateLimiter`); denetim #5/#19 bağlamı.
- **compose R2__\* env adları ↔ backend config binding birebir eşleşme testi** (R2 istemcisi M1'de yazılırken; denetim #36 notu).

## M2 (Timeline + player + autosave UI)
- **Request decompression middleware**: plan "tam doküman, gzip" diyor; frontend gzip göndermeden önce `UseRequestDecompression` eklenmeli (denetim #5c).
- **409 sonrası UX**: "başka sekmede değişti" diyaloğu + SignalR ile pasif sekme bilgilendirme (plandaki bilinçli MVP kabulü).

## M3 (Export) öncesi
- **sampleKeyframes / easingProgress için paylaşılan cross-language vektörler**: `easing-vectors.json` yalnız eğriyi kapsıyor; keyframe örnekleme vektörleri eklenmeli, C# compiler bunlarla test edilmeli (denetim #13).
- **SchemaGen sertleştirme**: enum tel-değeri regex yaması ve `__schemaN` yeniden adlandırması NJsonSchema çıktı formatına duyarlı — snapshot testi eklenmeli; başlık yorumundaki "byte-for-byte round-trip" iddiası düzeltilmeli; `SchemaVersion` double→int, sabit `Kind` literal'lerinin zorlanması (denetim #24, #26).
- **Timeline tam şema doğrulaması API'de**: M0'da yüzeysel kontrol (schemaVersion/projectId/tavanlar) eklendi; export öncesi üretilen DTO + invariant kontrolü sunucuda da koşmalı (denetim #5b'nin tam hali).

## M6 (Dayanıklılık / hardening)
- **Revision retention job**: plandaki "son 50 auto + eskilerde inceltme" (denetim #5).
- **Container hardening**: non-root `USER app` + volume sahipliği; worker için ayrıca seccomp/ffmpeg kaynak sınırları (denetim #35).
- **Per-device logout**: mevcut logout tüm cihazların refresh token'larını iptal ediyor — cihaz bazlı oturum yönetimi (denetim #30).
- **Snapshot'ın autosave ile aynı transaction'a alınması** değerlendirmesi: bugünkü tasarım "kaçan snapshot bir sonraki save'de telafi edilir" kabulüyle yaşıyor (denetim #29).
- **Dockerfile restore aşaması sln-üyesi tüm csproj'ları kopyalamalı** (SchemaGen/UnitTests) — bugün zararsız, sln-scoped restore'a geçilirse patlar (denetim #34).
- **apps/editor `tsconfig.node.json` tip-denetimi** build zincirine eklenmeli (denetim #36).

## M1 denetiminden ertelenenler (2026-08-07, 37 bulgu; kritik+yüksek tümü M1'de düzeltildi)
- **M2**: IDOR korumaları kod olarak doğru ama regresyon test paketi yok — sahiplik ihlali senaryolarını (başka kullanıcının assetId/projectId'si) kapsayan endpoint testleri eklenmeli. SignalR progress kanalı gelince `refetchIntervalInBackground` geçici çözümü kaldırılacak.
- **M6**: Kota kontrolü check-then-act (bilinçli MVP kabulü) — eşzamanlı init'lerle sınırlı aşım mümkün; transactional/advisory-lock çözümü. Upload resume sertleştirme: dosya-değişti tespiti (ilk 1 MiB parmak izi), IndexedDB hayalet satırlarının tam yaşam döngüsü, FileSystemFileHandle akışı.
- **Not**: E2E fixture (`apps/editor/public/e2e-test-video.mp4`) gitignore'da; lokal `vite build` dist'ine kopyalanır — sürüm build'i öncesi silinmeli (commit'lere girmez).

## M2 denetiminden ertelenenler (2026-08-07, 33 bulgu; 4 kritik + 6 yüksek + tüm ortalar M2'de düzeltildi)
- **Düşük öncelikli 12 bulgu** ertelendi — tam liste `docs/audits/m2-denetim.json` içinde (tüm milestone denetim raporları artık `docs/audits/` altında arşivleniyor).
- **Teslimat-anı görsel doğrulama borcu**: playback'in görsel/işitsel doğrulaması ve gerçek pointer ile library sürükle-bırak, gizli tarayıcı panelinde yapılamadı (rAF duraklı + untrusted gesture) — görünür panelde/kullanıcı testinde doğrulanacak; M3 golden-frame CI'ı görsel tarafı kalıcı güvenceye alacak.

## Kayda geçen doğrulamalar (aksiyon gerekmez)
- Restore'da "PreRestore satırı görünmüyor" davranışı veri kaybı DEĞİL — aynı revision'da zaten snapshot varsa terfi ediliyor; invaryant korunuyor (denetim #32).
- `.gitignore` üretilen-artefakt-commit'lenir kararıyla tutarlı (denetim #37).
