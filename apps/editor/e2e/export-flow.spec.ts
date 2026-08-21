/**
 * Gerçek export akışı — GERÇEK medya, GERÇEK ffmpeg render, GERÇEK indirme.
 *
 * Ürünün "medya koy, kes, çıkar" vaadinin İKİNCİ yarısı. Snapshot testleri
 * (backend ExportCompilerSnapshotTests) filtre grafiğinin METNİNİ doğrular;
 * burada doğrulanan şey o metnin GERÇEKTEN çalışan bir MP4 ürettiği ve
 * kullanıcının o dosyaya UI'daki bağlantıdan ulaşabildiğidir.
 *
 * Test kendi projesini + kendi medyasını kurar (diğer spec'lere bağlı değil).
 */
import { test, expect } from './fixtures/test';
import { EditorApp } from './support/editor';
import { LibraryPanelHarness } from './support/library';
import { ensureTestVideo, FFMPEG_SKIP_REASON, ffmpegVersion } from './support/media';
import { createEmptyProject } from './support/projects';

test.describe('Dışa aktarma — uçtan uca', () => {
  test('gerçek medyalı proje MP4 olarak render edilir ve indirme bağlantısı ÇALIŞIR', async ({
    page,
    account,
  }) => {
    test.skip(ffmpegVersion() === null, FFMPEG_SKIP_REASON);
    // Yükleme + worker işleme + ffmpeg render: uzun sürebilir.
    test.setTimeout(420_000);

    const video = ensureTestVideo();
    const project = await createEmptyProject(
      account.context.request,
      account.accessToken,
      'E2E export',
    );

    const app = new EditorApp(page);
    await app.open(project.projectId, { email: account.email, password: account.password });
    const library = new LibraryPanelHarness(page);

    // --- hazırlık: gerçek medya + timeline'da gerçek bir klip ---
    await library.pickFiles([video.path]);
    await library.waitForReady(video.fileName);
    await library.doubleClickAsset(video.fileName);
    await expect
      .poll(async () => (await app.state()).clipCount, {
        timeout: 15_000,
        message: 'Export için klip eklenemedi.',
      })
      .toBe(1);

    // --- export: TopBar "Dışa Aktar" -> diyalog -> "Dışa aktar" ---
    const openExport = page.getByRole('button', { name: 'Dışa Aktar', exact: true });
    await expect(openExport).toBeEnabled();
    await openExport.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // exact: profil seçici "Dikey 1080p · H.264" de listeler; alt-dize eşleşmesi
    // strict-mode'da ikili çözünürdü.
    await expect(dialog.getByText('1080p · H.264', { exact: true })).toBeVisible();
    // Export SON KAYDEDİLEN dokümanı render eder — diyalog bunu açıkça yazar.
    await expect(page.getByTestId('export-autosave-summary')).toBeVisible();

    await dialog.getByRole('button', { name: 'Dışa aktar' }).click();
    // Başarıda diyalog kapanır (hata olsaydı içeride kırmızı bir alert kalırdı).
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    // --- job kartı: Inspector "Dışa Aktarmalar" bölümü ---
    const exportsSection = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Dışa Aktarmalar' }) })
      .first();
    const jobRow = exportsSection.locator('li').first();
    await expect(jobRow).toBeVisible({ timeout: 20_000 });

    // 'succeeded' rozeti (kuyruk + render). Aradaki durumlar: Sırada/Render…
    await expect(
      jobRow.getByText('Tamamlandı', { exact: true }),
      'Export işi tamamlanmadı. Worker (VideoEdit.Worker) ve ffmpeg ayakta mı?',
    ).toBeVisible({ timeout: 300_000 });

    // Başarısız bir iş sessizce geçmesin: hata satırı olmamalı.
    await expect(jobRow.locator('p.text-danger')).toHaveCount(0);

    // --- indirme bağlantısı GERÇEKTEN çalışıyor mu? ---
    const download = jobRow.getByRole('link', { name: 'İndir' });
    await expect(download).toBeVisible();
    const href = await download.getAttribute('href');
    expect(href, 'İndirme bağlantısının href\'i yok.').toBeTruthy();

    const res = await account.context.request.get(href!);
    expect(res.status(), `İndirme bağlantısı HTTP ${res.status()} döndü.`).toBe(200);
    expect(res.headers()['content-type']).toContain('video/mp4');
    const body = await res.body();
    expect(body.byteLength, 'İndirilen MP4 boş.').toBeGreaterThan(1024);
    // MP4 imzası: ilk kutunun tipi 'ftyp' (offset 4..8).
    expect(
      String.fromCharCode(...body.subarray(4, 8)),
      'İndirilen dosya MP4 değil (ftyp kutusu yok).',
    ).toBe('ftyp');
  });
});
