/**
 * SignalR canlı ilerleme kanalı — GERÇEK WebSocket, GERÇEK fare, AĞ ÖLÇÜMÜ.
 *
 * İddia (tasarım 03 §5 + DECISIONS 2026-08-31): export ilerlemesi hub'dan
 * (worker → Redis → forwarder → `job:{id}` grubu) akarken istemci export
 * YOKLAMASI yapmaz — yoklama YEDEĞE iner. Kanıt üç ölçümden kurulur:
 *
 *  1. `/hubs/progress` WebSocket'i kurulur ve üzerinden bu işin EXPORT
 *     mesajları (running → succeeded) gerçekten AKAR (frame payload'ları
 *     parse edilir; asset-işleme frame'leri ayrı sayılır).
 *  2. İlk export frame'i ile terminal frame arasındaki CANLI pencerede tek
 *     bir export yoklama GET'i bile atılmaz (pencere sınırındaki kapı-kapanış
 *     yoklaması ±1.2 sn payla dışarıda bırakılır — kapsama, aboneliğin ACK'i
 *     SONRAKİ sorgu değerlendirmesinde görülür, bkz. progressHub yorumu).
 *  3. Tıklamadan rozete toplam yoklama sayısı ≤ 4 (başlangıç invalidate'i +
 *     kapı kapanana kadarki ≤2 tur + terminal invalidate'i). Salt yoklamalı
 *     akış aynı sürede bunun katlarını üretirdi (2 sn kadans) — eşik iki
 *     rejimi ayırır.
 *
 * Bu spec'in NEGATİF KONTROLÜ forwarder'ın sökülmesidir: hub bağlanır ama
 * mesaj akmaz → (1) kırmızı. Sahiplik kapısının negatif kontrolü backend
 * testindedir (CrossUserAccessTests.Hub_*).
 */
import { test, expect } from './fixtures/test';
import { EditorApp } from './support/editor';
import { LibraryPanelHarness } from './support/library';
import { ensureTestVideo, FFMPEG_SKIP_REASON, ffmpegVersion } from './support/media';
import { createEmptyProject } from './support/projects';

interface ProgressFrame {
  at: number;
  assetId: string | null;
  status: string;
  progressPercent: number;
}

/** SignalR JSON çerçevesinden (0x1e ayraçlı) progress mesajlarını çıkarır. */
function parseProgressFrames(payload: string): Array<{ assetId: string | null; status: string; progressPercent: number }> {
  const out: Array<{ assetId: string | null; status: string; progressPercent: number }> = [];
  for (const part of payload.split(String.fromCharCode(0x1e))) {
    if (part === '') continue;
    try {
      const frame = JSON.parse(part) as {
        type?: number;
        target?: string;
        arguments?: Array<{ assetId?: string | null; status?: string; progressPercent?: number }>;
      };
      if (frame.type === 1 && frame.target === 'progress') {
        for (const arg of frame.arguments ?? []) {
          out.push({
            assetId: arg.assetId ?? null,
            status: arg.status ?? '',
            progressPercent: arg.progressPercent ?? 0,
          });
        }
      }
    } catch {
      // handshake/ping çerçeveleri JSON progress değildir — atla
    }
  }
  return out;
}

test.describe('SignalR ilerleme kanalı — canlı yol', () => {
  test('export ilerlemesi hub\'dan akar ve canlı penceredeki export yoklaması SIFIRDIR', async ({
    page,
    account,
  }) => {
    test.skip(ffmpegVersion() === null, FFMPEG_SKIP_REASON);
    test.setTimeout(420_000);

    const video = ensureTestVideo();
    const project = await createEmptyProject(
      account.context.request,
      account.accessToken,
      'E2E signalr canli',
    );

    // ── Ağ ölçüm sondaları SAYFA AÇILMADAN kurulur: hub bağlantısı asset
    // yükleme sırasında (meşgul satır aboneliğiyle) kurulabilir.
    const exportFrames: ProgressFrame[] = [];
    const assetFrames: ProgressFrame[] = [];
    let hubSocketCount = 0;
    page.on('websocket', (ws) => {
      if (!ws.url().includes('/hubs/progress')) return;
      hubSocketCount += 1;
      ws.on('framereceived', (frame) => {
        for (const parsed of parseProgressFrames(String(frame.payload))) {
          (parsed.assetId === null ? exportFrames : assetFrames).push({ at: Date.now(), ...parsed });
        }
      });
    });

    const exportPolls: number[] = []; // GET zaman damgaları (export listesi + tekil iş)
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

    // ── Hazırlık: gerçek medya + 2 klip (timeline 8 sn — render penceresi ölçüme yeter).
    await library.pickFiles([video.path]);
    await library.waitForReady(video.fileName);
    await library.doubleClickAsset(video.fileName);
    await expect
      .poll(async () => (await app.state()).clipCount, { timeout: 15_000 })
      .toBe(1);
    await library.doubleClickAsset(video.fileName);
    await expect
      .poll(async () => (await app.state()).clipCount, { timeout: 15_000 })
      .toBe(2);

    // ── Export: GERÇEK fare; yoklama sayacı tıklamayla başlar.
    const openExport = page.getByRole('button', { name: 'Dışa Aktar', exact: true });
    await expect(openExport).toBeEnabled();
    measurePolls = true;
    await openExport.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Dışa aktar' }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    // ── İş kartı tamamlanana kadar (ilerleme hub'dan gelir).
    const exportsSection = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Dışa Aktarmalar' }) })
      .first();
    const jobRow = exportsSection.locator('li').first();
    await expect(jobRow).toBeVisible({ timeout: 20_000 });
    await expect(
      jobRow.getByText('Tamamlandı', { exact: true }),
      'Export işi tamamlanmadı. Worker ve Redis (compose.dev.yml) ayakta mı?',
    ).toBeVisible({ timeout: 300_000 });
    measurePolls = false;

    // ── 1) Hub gerçekten aktı: WS kuruldu, bu işin running + succeeded mesajları geldi.
    expect(hubSocketCount, 'Hiç /hubs/progress WebSocket\'i kurulmadı.').toBeGreaterThan(0);
    expect(
      exportFrames.length,
      'Hub\'dan hiç export progress mesajı gelmedi (forwarder çalışmıyor mu?).',
    ).toBeGreaterThanOrEqual(2);
    expect(
      exportFrames.some((f) => f.status === 'running'),
      `Hub'dan 'running' mesajı gelmedi. Gelenler: ${exportFrames.map((f) => f.status).join(', ')}`,
    ).toBe(true);
    const terminal = exportFrames.find((f) => f.status === 'succeeded');
    expect(terminal, 'Hub\'dan terminal (succeeded) mesajı gelmedi.').toBeTruthy();

    // ── 2) Canlı pencerede export yoklaması SIFIR. Pencere: ilk export frame'i +1.2 sn
    // (kapı-kapanış yoklaması aboneliğin ACK'inden sonraki İLK sorgu turunda görülür)
    // ile terminal frame arası. Salt yoklamalı akış bu pencerede 2 sn kadansla GET üretirdi.
    const windowStart = exportFrames[0]!.at + 1200;
    const windowEnd = terminal!.at;
    const pollsInLiveWindow = exportPolls.filter((t) => t > windowStart && t < windowEnd);
    expect(
      pollsInLiveWindow,
      `Canlı pencerede (${windowEnd - windowStart} ms) export yoklaması atıldı — hub kapsaması ` +
        'yoklamayı durdurmadı.',
    ).toHaveLength(0);

    // ── 3) Uçtan uca toplam yoklama tavanı (başlangıç + kapı kapanışı + terminal).
    expect(
      exportPolls.length,
      `Tıklama→rozet arasında ${exportPolls.length} export GET'i sayıldı (beklenen ≤4) — ` +
        'yoklama rejimi hâlâ birincil görünüyor.',
    ).toBeLessThanOrEqual(4);

    // ── İndirme bağlantısı yine çalışır (canlı yol sonucu değiştirmez).
    const download = jobRow.getByRole('link', { name: 'İndir' });
    await expect(download).toBeVisible();
    const href = await download.getAttribute('href');
    expect(href).toBeTruthy();
    const res = await account.context.request.get(href!);
    expect(res.status()).toBe(200);
  });
});
