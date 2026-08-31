/**
 * "SONRADAN TEKRAR DÜZENLEME" — gerçek medyalı projede düzenle → "Kaydedildi" →
 * çıkış → yeniden giriş → proje seçici → AYNI belge + medya gerçekten servis
 * ediliyor (proxy Range GET 206).
 *
 * Neden var: bu akış 12. turda gerçek fare/klavyeyle ÖLÇÜLDÜ (poc-bilinen-sinirlar
 * §4.2) ama pakette KORUNMUYORDU — backlog'un açık borcu ("mevcut e2e/support/media.ts
 * fixture'ı ile pakete alınabilir, dosya boyutuyla ilgisi yok"). Ürünün "kaydet,
 * çık, sonra dön ve kaldığın yerden düzenle" vaadinin tek kalıcı kanıtı budur:
 *  - "Kaydedildi" rozeti SUNUCUNUN 200'üne bağlıdır (autosave.ts putTimeline) —
 *    burada rozetten sonra sunucu dokümanı API'den ayrıca okunarak bölmenin
 *    gerçekten yazıldığı doğrulanır (rozet yalan söyleyemez);
 *  - yeniden girişte belge SUNUCUDAN birebir geri gelir (revision dahil — proje
 *    açmak salt-okurdur, sessiz bir yeniden-yazım revision'ı oynatırdı);
 *  - medya URL'leri ölü bağlantı değildir: sayfanın KENDİ media-urls isteği 200
 *    döner ve dönen proxy URL'sine Range GET gerçek bir 206 + Content-Range verir
 *    (oynatıcının <video> elemanının yaptığı isteğin sınıfı).
 *
 * Kurulum (yükleme) REST üzerinden yapılır — bu spec'in İDDİASI dosya seçici
 * değil (o iddia media-upload.spec.ts'in, review-gate kural 3 notu apiUpload
 * başlığında); düzenleme/çıkış/giriş/seçici etkileşimlerinin TAMAMI gerçek
 * fare/klavyedir. Oturum worker-scope hesabı AYRI bir tarayıcı context'inde
 * kullanır: logout per-device'dır (AuthEndpoints), diğer spec'lerin paylaştığı
 * context'in oturumu düşmez.
 */
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';
import { test, expect } from './fixtures/test';
import { getProject } from './fixtures/seed';
import { createEmptyProject, emptyVideoTrackDoc } from './support/projects';
import { fetchProxyUrls, uploadAssetViaApi, waitAssetReady } from './support/apiUpload';
import { FFMPEG_SKIP_REASON, ensureTestVideo, ffmpegVersion } from './support/media';
import { EditorApp } from './support/editor';
import { bridgeRecorderInitScript, installAppBridge, readAppState } from './support/appBridge';
import { E2E_BASE_URL, E2E_VIEWPORT } from './support/constants';

const SECOND_US = 1_000_000;

interface ServerClip {
  id: string;
  timelineStartUs: number;
  timelineDurationUs: number;
}

interface ServerProjectDetail {
  revisionNumber: number;
  timeline: { tracks: { id: string; clips: ServerClip[] }[] };
}

/** Sunucudaki güncel proje detayı (revision + timeline) — iddiaların referansı. */
async function readServerProject(
  request: APIRequestContext,
  accessToken: string,
  projectId: string,
): Promise<ServerProjectDetail> {
  const res = await request.get(`/api/projects/${projectId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok()) {
    throw new Error(`Proje detayı okunamadı (HTTP ${res.status()}): ${await res.text()}`);
  }
  return (await res.json()) as ServerProjectDetail;
}

/**
 * Giriş formunu GERÇEK fare/klavyeyle doldurup gönderir; 429 (paylaşılan IP
 * kotası — auth.spec.ts'te ölçülen çakışma sınıfı) görülürse pencerenin
 * sıfırlanmasını bekleyip bir kez daha dener.
 */
async function loginViaForm(page: Page, email: string, password: string): Promise<void> {
  const typeInto = async (testId: string, value: string): Promise<void> => {
    await page.getByTestId(testId).click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Delete');
    await page.keyboard.type(value);
  };
  const heading = page.getByRole('heading', { name: 'Projeler', exact: true });
  const formError = page.locator('form p.text-red-400');

  await expect(page.getByTestId('auth-submit')).toBeVisible({ timeout: 20_000 });
  for (let attempt = 0; attempt < 2; attempt++) {
    await typeInto('auth-email', email);
    await typeInto('auth-password', password);
    await page.getByTestId('auth-submit').click();
    const deadline = Date.now() + 15_000;
    for (;;) {
      if ((await heading.count()) > 0) return; // içeri alındı
      if ((await formError.count()) > 0) {
        const text = (await formError.innerText()).trim();
        if (!/429|too many/i.test(text)) {
          throw new Error(`Giriş beklenmedik biçimde reddedildi: "${text}"`);
        }
        break; // kota doldu → pencereyi bekle, yeniden dene
      }
      if (Date.now() > deadline) {
        throw new Error('Giriş formu 15 sn içinde yerleşmedi (ne seçici ne hata).');
      }
      await page.waitForTimeout(150);
    }
    await page.waitForTimeout(62_000); // Program.cs "auth" policy penceresi
  }
  throw new Error('Giriş 2 denemede de 429 penceresini aşamadı.');
}

test.describe('Sonradan tekrar düzenleme (gerçek medya)', () => {
  test('böl → "Kaydedildi" → çıkış → yeniden giriş → seçici → aynı belge + proxy Range 206', async ({
    browser,
    account,
  }) => {
    test.skip(ffmpegVersion() === null, FFMPEG_SKIP_REASON);
    // Upload + worker işlemesi (≤180 sn) + iki giriş (429 penceresi olasılığı).
    test.setTimeout(420_000);

    const apiRequest = account.context.request;

    // ── 1) KURULUM (REST): gerçek medyalı, tek klipli proje ──
    const video = ensureTestVideo();
    const project = await createEmptyProject(apiRequest, account.accessToken, 'E2E yeniden giriş');
    const uploaded = await uploadAssetViaApi(
      apiRequest, account.accessToken, project.projectId, video.path, video.fileName, video.contentType);
    await waitAssetReady(apiRequest, account.accessToken, uploaded.assetId, video.fileName);

    // Klip: 0..4 sn (30 fps ızgarasında tam 120 kare) — seed.ts mediaClip şekli.
    const clipId = crypto.randomUUID();
    const doc = emptyVideoTrackDoc(project.projectId, project.trackId) as {
      tracks: { clips: unknown[] }[];
    };
    doc.tracks[0].clips.push({
      id: clipId,
      kind: 'video',
      assetId: uploaded.assetId,
      timelineStartUs: 0,
      timelineDurationUs: video.durationUs,
      sourceInUs: 0,
      sourceOutUs: video.durationUs,
      speed: { rate: 1 },
      audio: { volume: 1, fadeInUs: 0, fadeOutUs: 0, muted: false },
      transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5 },
      keyframes: {},
      effects: [],
      opacity: 1,
    });
    const beforeSeed = await getProject(apiRequest, account.accessToken, project.projectId);
    const seedRes = await apiRequest.put(`/api/projects/${project.projectId}/timeline`, {
      headers: { Authorization: `Bearer ${account.accessToken}` },
      data: { baseRevision: beforeSeed.revisionNumber, timeline: doc },
    });
    expect(seedRes.ok(), `Klipli doküman kaydedilemedi (HTTP ${seedRes.status()}).`).toBe(true);

    // ── 2) UI akışı AYRI context'te (logout per-device: paylaşılan oturum düşmez) ──
    let context: BrowserContext | null = null;
    try {
      context = await browser.newContext({ baseURL: E2E_BASE_URL, viewport: E2E_VIEWPORT });
      const page = await context.newPage();
      await page.addInitScript(bridgeRecorderInitScript());

      // İlk giriş: taze context'te cookie yok → gerçek klavyeyle form.
      await page.goto('/');
      await loginViaForm(page, account.email, account.password);

      const editor = new EditorApp(page);
      await editor.open(project.projectId, { email: account.email, password: account.password });

      // ── 3) GERÇEK DÜZENLEME: playhead'i ortaya al, sağ tık → "Playhead'de böl" ──
      await editor.ensureContentVisible(clipId);
      await editor.timeline.scrubTo(2 * SECOND_US);
      const afterScrub = await editor.state();
      await editor.timeline.click(await editor.timeline.clipCenter(clipId, afterScrub), 'right');
      await expect(editor.contextMenu).toBeVisible();
      await editor.contextMenuItem(/playhead.?de b[öo]l/i).click();
      await expect
        .poll(async () => (await editor.state()).clipCount, {
          timeout: 5_000,
          message: 'Bölme sonrası klip sayısı 2 olmalıydı.',
        })
        .toBe(2);

      // ── 4) "Kaydedildi" → ve rozetin SÖZÜNÜ sunucudan doğrula ──
      await expect(page.getByText('Kaydedildi', { exact: true })).toBeVisible({ timeout: 30_000 });
      const savedDetail = await readServerProject(apiRequest, account.accessToken, project.projectId);
      const savedClips = savedDetail.timeline.tracks.find((t) => t.id === project.trackId)?.clips ?? [];
      expect(
        savedClips.length,
        '"Kaydedildi" göründü ama bölme sunucu dokümanına YAZILMAMIŞ — rozet yalan söylüyor.',
      ).toBe(2);
      const savedTimelineJson = JSON.stringify(savedDetail.timeline);

      // ── 5) ÇIKIŞ (gerçek fare): editör → seçici → "Çıkış yap" → giriş formu ──
      await page.getByRole('button', { name: 'Projeler', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Projeler', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Çıkış yap' }).click();
      await expect(page.getByTestId('auth-submit')).toBeVisible({ timeout: 20_000 });

      // ── 6) YENİDEN GİRİŞ → seçici satırından AYNI projeyi aç ──
      await loginViaForm(page, account.email, account.password);
      const row = page.getByTestId(`project-row-${project.projectId}`);
      await expect(row, 'Proje, yeniden girişte seçici listesinde görünmüyor.').toBeVisible({
        timeout: 20_000,
      });
      // Sayfanın KENDİ media-urls isteği (mediaUrls.ts sync'i) 200 dönmeli —
      // dinleyici tıklamadan ÖNCE kurulur ki yanıt kaçmasın.
      const mediaUrlsResponse = page.waitForResponse(
        (r) =>
          r.request().method() === 'GET' &&
          new URL(r.url()).pathname === `/api/projects/${project.projectId}/media-urls`,
        { timeout: 30_000 },
      );
      await row.click();
      await page.locator('canvas').first().waitFor({ state: 'attached', timeout: 30_000 });
      expect(new URL(page.url()).searchParams.get('project')).toBe(project.projectId);
      expect((await mediaUrlsResponse).status(), 'media-urls 200 dönmeli (medya bağlantıları).').toBe(200);

      // ── 7) AYNI BELGE: editör store'u == kaydedilen doküman; sunucu birebir ──
      await installAppBridge(page);
      const reopened = await readAppState(page);
      const reopenedClips = reopened.tracks.find((t) => t.id === project.trackId)?.clips ?? [];
      expect(
        reopenedClips.map((c) => ({ id: c.id, startUs: c.timelineStartUs, durationUs: c.timelineDurationUs })),
        'Yeniden açılan belge, "Kaydedildi" anındaki bölünmüş halle aynı değil.',
      ).toEqual(
        savedClips.map((c) => ({ id: c.id, startUs: c.timelineStartUs, durationUs: c.timelineDurationUs })),
      );
      const afterDetail = await readServerProject(apiRequest, account.accessToken, project.projectId);
      expect(
        JSON.stringify(afterDetail.timeline),
        'Sunucu dokümanı yeniden açılışta DEĞİŞMİŞ — proje açmak salt-okur olmalı.',
      ).toBe(savedTimelineJson);
      expect(afterDetail.revisionNumber, 'Yeniden açılış revision oynatmamalı.').toBe(
        savedDetail.revisionNumber,
      );

      // ── 8) MEDYA GERÇEKTEN SERVİS EDİLİYOR: proxy'ye Range GET → 206 ──
      const proxies = await fetchProxyUrls(apiRequest, account.accessToken, project.projectId);
      const proxyUrl = proxies[uploaded.assetId];
      expect(proxyUrl, 'media-urls yanıtında asset\'in proxy URL\'si yok.').toBeTruthy();
      const rangeRes = await context.request.get(proxyUrl!, {
        headers: { Range: 'bytes=0-1023' },
      });
      expect(
        rangeRes.status(),
        'Proxy URL\'sine Range GET 206 dönmeli (oynatıcının istek sınıfı).',
      ).toBe(206);
      expect(rangeRes.headers()['content-range'] ?? '').toMatch(/^bytes 0-1023\//);
      expect((await rangeRes.body()).byteLength).toBe(1024);
    } finally {
      await context?.close();
    }
  });
});
