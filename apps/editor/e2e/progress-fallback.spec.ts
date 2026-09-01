/**
 * Polling YEDEĞİ — WebSocket kanalı ENGELLİYKEN akış bugünkü gibi tamamlanır.
 *
 * Tasarım şartı (03 §5 + DECISIONS 2026-08-31): SignalR birincil kanaldır ama
 * polling YEDEK kalır — "WebSocket düşerse frontend poll'a döner". Burada
 * `/hubs/**` istekleri (negotiate dahil) tarayıcı katında iptal edilir: hub
 * HİÇ kurulamaz. Beklenen davranış, dünkü ürünün davranışının aynısıdır:
 *
 *  - yükleme + işleme "Hazır" rozetine ulaşır (asset listesi 3 sn yoklamayla),
 *  - export işi karta düşer, ilerler ve "Tamamlandı" olur (2 sn yoklamayla),
 *  - indirme bağlantısı çalışır,
 *  - ve bunun yoklamayla olduğu AĞ ÖLÇÜMÜYLE kanıtlanır (export GET'leri
 *    akmıştır; tek bir hub WebSocket'i kurulmamıştır).
 *
 * Bu spec, canlı-yol spec'inin (export-progress-hub.spec.ts) ikizidir: orada
 * hub varken yoklamanın SUSTUĞU, burada hub yokken yoklamanın KONUŞTUĞU ölçülür.
 */
import { test, expect } from './fixtures/test';
import { EditorApp } from './support/editor';
import { LibraryPanelHarness } from './support/library';
import { ensureTestVideo, FFMPEG_SKIP_REASON, ffmpegVersion } from './support/media';
import { createEmptyProject } from './support/projects';

test.describe('SignalR ilerleme kanalı — polling yedeği', () => {
  test('WS engelliyken export bugünkü yoklamayla yine tamamlanır', async ({ page, account }) => {
    test.skip(ffmpegVersion() === null, FFMPEG_SKIP_REASON);
    test.setTimeout(420_000);

    const video = ensureTestVideo('fallback');
    const project = await createEmptyProject(
      account.context.request,
      account.accessToken,
      'E2E signalr fallback',
    );

    // ── Hub tamamen ENGELLİ: negotiate POST'u da WS upgrade adayları da iptal.
    // Sayfa açılmadan kurulur ki asset-aşaması aboneliği de hub'sız kalsın.
    let blockedHubRequests = 0;
    await page.route('**/hubs/**', (route) => {
      blockedHubRequests += 1;
      void route.abort();
    });
    let hubSocketCount = 0;
    page.on('websocket', (ws) => {
      if (ws.url().includes('/hubs/progress')) hubSocketCount += 1;
    });

    const exportPolls: number[] = [];
    let measurePolls = false;
    const pollPattern = new RegExp(
      `/api/projects/${project.projectId}/exports|/api/jobs/[0-9a-f-]+$`,
    );
    page.on('request', (request) => {
      if (!measurePolls || request.method() !== 'GET') return;
      if (pollPattern.test(request.url())) exportPolls.push(Date.now());
    });

    const app = new EditorApp(page);
    await app.open(project.projectId, { email: account.email, password: account.password });
    const library = new LibraryPanelHarness(page);

    // ── Yükleme + işleme: hub'sız da "Hazır" (asset yoklaması yaşıyor).
    await library.pickFiles([video.path]);
    await library.waitForReady(video.fileName);
    // Sesli kaynak: otomatik AV ayrımı (ozellik-3) video + ses ikizi ekler.
    await library.doubleClickAsset(video.fileName);
    await expect
      .poll(async () => (await app.state()).clipCount, { timeout: 15_000 })
      .toBe(2);

    // ── Export: gerçek fare.
    const openExport = page.getByRole('button', { name: 'Dışa Aktar', exact: true });
    await expect(openExport).toBeEnabled();
    measurePolls = true;
    await openExport.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Dışa aktar' }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    const exportsSection = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Dışa Aktarmalar' }) })
      .first();
    const jobRow = exportsSection.locator('li').first();
    await expect(jobRow).toBeVisible({ timeout: 20_000 });
    await expect(
      jobRow.getByText('Tamamlandı', { exact: true }),
      'Hub engelliyken export tamamlanmadı — polling yedeği çalışmıyor demektir.',
    ).toBeVisible({ timeout: 300_000 });
    measurePolls = false;

    // ── Yedek kanıtı: hub hiç kurulamadı, ilerlemeyi yoklama taşıdı.
    expect(hubSocketCount, 'Engelli ortamda /hubs WebSocket\'i kurulmamalıydı.').toBe(0);
    expect(
      blockedHubRequests,
      'İstemci hub\'a hiç başvurmadı — bu koşumda "engellendi ve yedeğe düştü" iddiası ölçülmemiş olur.',
    ).toBeGreaterThan(0);
    expect(
      exportPolls.length,
      'Export sürerken hiç yoklama GET\'i sayılmadı — ilerlemeyi hangi kanal taşıdı?',
    ).toBeGreaterThanOrEqual(2);

    // ── İndirme bağlantısı yine çalışır.
    const download = jobRow.getByRole('link', { name: 'İndir' });
    await expect(download).toBeVisible();
    const href = await download.getAttribute('href');
    expect(href).toBeTruthy();
    const res = await account.context.request.get(href!);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('video/mp4');
  });
});
