/**
 * Kitaplık paneli — reddetme yolları ve asset kartının bilgi sözleşmesi.
 *
 * media-upload.spec.ts mutlu yolu (yükle -> işlen -> timeline) kanıtlar;
 * burada kanıtlanan, kullanıcının YANLIŞ yaptığı anlarda panelin sessiz
 * kalmadığıdır: desteklenmeyen format Türkçe bir mesapla düşer, aynı dosyayı
 * ikinci kez seçmek yeni bir yükleme başlatmaz (ve BİRİNCİYİ de bozmaz).
 */
import { test, expect } from './fixtures/test';
import { EditorApp } from './support/editor';
import { LibraryPanelHarness, listProjectAssets } from './support/library';
import {
  ensureTestVideo,
  FFMPEG_SKIP_REASON,
  ffmpegVersion,
  unsupportedFixtureFile,
} from './support/media';
import { createEmptyProject } from './support/projects';

test.describe('Kitaplık — reddetme ve kart bilgisi', () => {
  test('desteklenmeyen format (.mkv) Türkçe mesajla reddedilir, sunucuya İSTEK GİTMEZ', async ({
    page,
    account,
  }) => {
    const project = await createEmptyProject(
      account.context.request,
      account.accessToken,
      'E2E format',
    );
    const app = new EditorApp(page);
    await app.open(project.projectId, { email: account.email, password: account.password });
    const library = new LibraryPanelHarness(page);

    // Reddetme İSTEMCİDE olmalı (uzantı whitelist'i, features/library/fileTypes.ts):
    // desteklenmeyen dosya için asset init isteği hiç atılmamalı.
    let initRequests = 0;
    page.on('request', (req) => {
      if (req.method() === 'POST' && /\/api\/projects\/[^/]+\/assets$/.test(req.url())) {
        initRequests++;
      }
    });

    await library.pickFiles([unsupportedFixtureFile()]);

    const rejection = library.rejectionMessages.first();
    await expect(rejection).toBeVisible({ timeout: 10_000 });
    await expect(rejection).toContainText('Desteklenmeyen format: .mkv');
    await expect(rejection).toContainText('MP4/MOV/WebM');

    // Yükleme kartı açılmadı, sunucuya init gitmedi.
    await expect(page.getByText('Yükleniyor', { exact: true })).toHaveCount(0);
    expect(initRequests, 'Desteklenmeyen dosya için sunucuya init isteği atıldı.').toBe(0);
    const assets = await listProjectAssets(
      account.context.request,
      account.accessToken,
      project.projectId,
    );
    expect(assets).toHaveLength(0);
  });

  test('aynı dosyayı iki kez seçmek İKİNCİ yüklemeyi başlatmaz ve uyarı gösterir', async ({
    page,
    account,
  }) => {
    test.skip(ffmpegVersion() === null, FFMPEG_SKIP_REASON);
    test.setTimeout(240_000);

    const video = ensureTestVideo();
    const project = await createEmptyProject(
      account.context.request,
      account.accessToken,
      'E2E kopya',
    );
    const app = new EditorApp(page);
    await app.open(project.projectId, { email: account.email, password: account.password });
    const library = new LibraryPanelHarness(page);

    // Aynı dosyayı TEK seçimde iki kez vermek, "iki kez bırakma"nın
    // deterministik karşılığıdır: startUpload iki kez AYNI turda çağrılır,
    // yani ilk yükleme kesin olarak hâlâ aktifken ikincisi denenir.
    await library.pickFiles([video.path, video.path]);

    await expect(library.warning('Bu dosya zaten yükleniyor.')).toBeVisible({ timeout: 15_000 });
    // Kart TEK: ikinci seçim yeni bir yükleme açmadı.
    await expect(library.row(video.fileName)).toHaveCount(1);

    // Ve birincisi bozulmadı — sonuna kadar gidip hazır oluyor.
    await library.waitForReady(video.fileName);
    const assets = await listProjectAssets(
      account.context.request,
      account.accessToken,
      project.projectId,
    );
    expect(assets, 'Yinelenen seçim ikinci bir asset kaydı yarattı.').toHaveLength(1);
    expect(assets[0].status).toBe('ready');
  });

  test('hazır asset kartı süre, çözünürlük, boyut ve "Hazır" rozetini gösterir', async ({
    page,
    account,
  }) => {
    test.skip(ffmpegVersion() === null, FFMPEG_SKIP_REASON);
    test.setTimeout(240_000);

    const video = ensureTestVideo();
    const project = await createEmptyProject(
      account.context.request,
      account.accessToken,
      'E2E kart',
    );
    const app = new EditorApp(page);
    await app.open(project.projectId, { email: account.email, password: account.password });
    const library = new LibraryPanelHarness(page);

    await library.pickFiles([video.path]);
    await library.waitForReady(video.fileName);

    const row = library.row(video.fileName);
    await expect(row).toContainText(video.fileName);
    await expect(row.getByText('VID', { exact: true })).toBeVisible();

    const meta = await library.metaText(video.fileName);
    expect(meta, `Kart meta satırı: "${meta}"`).toMatch(/\b0:04\b/);
    expect(meta).toContain(`${video.width}×${video.height}`);
    expect(meta).toMatch(/\d+([.,]\d+)?\s?(KB|MB)/);

    // Hazır asset sürüklenebilir olduğunu SÖYLER (DnD + çift tık ipucu).
    await expect(row.locator('div[title*="Çift tık"]').first()).toBeVisible();
  });
});
