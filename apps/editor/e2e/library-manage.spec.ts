/**
 * Kitaplık yönetimi (M6) — medya SİLME ve kota göstergesi, GERÇEK fareyle.
 *
 * Neden bu testler: silme yıkıcı bir işlemdir ve tek koruması bir onay
 * diyaloğudur. "Diyalog var" demek yetmez; kanıtlanması gerekenler:
 *  1. kullanılmayan medya sağ tık menüsünden silinebiliyor ve listeden DÜŞÜYOR,
 *  2. TIMELINE'DA KULLANILAN medyada uyarı GÖRÜNÜYOR (kaç projede kaç klip) —
 *     yani sunucu kullanım sorgusu gerçekten çalışıyor,
 *  3. onaydan sonra timeline o klibi "medya eksik" olarak boyuyor ve Inspector
 *     ne olduğunu YAZIYOR (sessiz bozuk klip = kullanıcının en kötü sürprizi),
 *  4. ⋯ düğmesi (sağ tıkı bulamayan kullanıcının yolu) aynı diyaloğu açıyor ve
 *     "Vazgeç" GERÇEKTEN vazgeçiyor.
 *
 * Tüm jestler page.mouse ile üretilir (docs/review-gate.md §3): dispatchEvent
 * ya da element.click() ile üretilmiş sentetik olay YOKTUR.
 */
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures/test';
import { EditorApp } from './support/editor';
import { clipContentColors } from './support/canvasProbe';
import { LibraryPanelHarness, listProjectAssets } from './support/library';
import { ensureTestVideo, FFMPEG_SKIP_REASON, ffmpegVersion } from './support/media';
import { createEmptyProject } from './support/projects';
// Gösterge metnini uygulamanın KENDİ biçimlendiricisiyle kurar (tek kaynak):
// test kendi "1,7 MB" tahminini yazsaydı biçim değiştiğinde yalancı kırmızı olurdu.
import { formatBytes } from '../src/features/library/format';

/** Sunucunun gördüğü kullanılan bayt (gösterge iddialarının referansı). */
async function readQuotaUsedBytes(
  request: import('@playwright/test').APIRequestContext,
  accessToken: string,
): Promise<number> {
  const res = await request.get('/api/quota', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  expect(res.ok(), `GET /api/quota HTTP ${res.status()}`).toBe(true);
  return ((await res.json()) as { usedBytes: number }).usedBytes;
}

/**
 * Ön koşul: AYAKTA olan API M6 uçlarını (kullanım + kota) tanıyor mu?
 *
 * Neden açık bir kontrol: bu uçlar yoksa diyalog "kullanım bilgisi alınamadı"
 * durumunda kalır ve test "onay düğmesi disabled" gibi ALAKASIZ bir mesajla
 * düşer — hata mesajı, sebebi (eski derlemeyle koşan API) söylemelidir.
 * Bilerek SKIP değil FAIL: atlanan test kanıt üretmez (support/ciSkipGuard.ts).
 */
async function assertM6EndpointsAvailable(
  request: import('@playwright/test').APIRequestContext,
  accessToken: string,
): Promise<void> {
  const res = await request.get('/api/quota', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  expect(
    res.status(),
    'GET /api/quota bulunamadı (404): ayakta olan VideoEdit.Api M6 ÖNCESİ bir derlemeyle ' +
      'koşuyor. Kod doğru olsa bile bu testler yeşile dönemez — API sürecini yeniden ' +
      'başlatın (dotnet build + dotnet run --project backend/src/VideoEdit.Api).',
  ).not.toBe(404);
  expect(res.ok(), `GET /api/quota HTTP ${res.status()} döndü.`).toBe(true);
}

/** GERÇEK fare tıklaması (sol/sağ) — locator'ın ekran kutusunun ortasına. */
async function realClick(
  page: Page,
  locator: Locator,
  button: 'left' | 'right' = 'left',
): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  expect(box, 'Tıklanacak öğe ekranda değil.').not.toBeNull();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down({ button });
  await page.mouse.up({ button });
}

/**
 * Klip gövdesindeki BASKIN rengin RGB'si. "Medya eksik" boyaması klibin
 * üstüne kırmızı bir yıkama sürer (drawTracks COLORS.missingWash) ve filmstrip
 * artık çizilmez — yani gövde düz ve KIRMIZIYA ÇALAN bir renge döner.
 */
async function clipDominantRgb(
  page: Page,
  box: { x: number; y: number; width: number; height: number },
): Promise<{ r: number; g: number; b: number }> {
  const rgb = await page.evaluate((rect: { x: number; y: number; width: number; height: number }) => {
    const wrap =
      document.querySelector('[data-testid="timeline-canvas"]') ??
      [...document.querySelectorAll('div')].find(
        (d) => [...d.children].filter((c) => c.tagName === 'CANVAS').length >= 3,
      );
    if (!wrap) return null;
    const body = wrap.querySelectorAll('canvas')[1] as HTMLCanvasElement | undefined;
    const ctx = body?.getContext('2d');
    if (!body || !ctx) return null;
    const r = body.getBoundingClientRect();
    const scaleX = body.width / r.width;
    const scaleY = body.height / r.height;
    // İsim çubuğunun ALTI (drawTracks: 2 + NAME_BAR_H(15) + pay).
    const x0 = Math.round((rect.x - r.left + 3) * scaleX);
    const y0 = Math.round((rect.y - r.top + 19) * scaleY);
    const w = Math.round((rect.width - 6) * scaleX);
    const h = Math.round((rect.height - 24) * scaleY);
    if (w <= 1 || h <= 1) return null;
    const data = ctx.getImageData(x0, y0, w, h).data;
    const counts = new Map<number, number>();
    for (let i = 0; i < data.length; i += 4) {
      const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    let best = 0;
    let bestKey = 0;
    for (const [key, count] of counts) {
      if (count > best) {
        best = count;
        bestKey = key;
      }
    }
    return { r: (bestKey >> 16) & 255, g: (bestKey >> 8) & 255, b: bestKey & 255 };
  }, box);
  expect(rgb, 'Timeline gövde canvas\'ı okunamadı.').not.toBeNull();
  return rgb as { r: number; g: number; b: number };
}

test.describe('Kitaplık — silme ve kota', () => {
  test('kullanılmayan medya sağ tık menüsünden silinir ve listeden DÜŞER', async ({
    page,
    account,
  }) => {
    test.skip(ffmpegVersion() === null, FFMPEG_SKIP_REASON);
    test.setTimeout(300_000);

    const video = ensureTestVideo();
    const project = await createEmptyProject(
      account.context.request,
      account.accessToken,
      'E2E silme',
    );
    await assertM6EndpointsAvailable(account.context.request, account.accessToken);

    const app = new EditorApp(page);
    await app.open(project.projectId, { email: account.email, password: account.password });
    const library = new LibraryPanelHarness(page);

    await library.pickFiles([video.path]);
    await library.waitForReady(video.fileName);

    // Kota göstergesi: yükleme sonrası kullanılan alanı GÖSTERİR.
    // (Hesap worker başına PAYLAŞILIR — mutlak bir "0 B" beklemek diğer
    //  spec'lerin bıraktığı medyaya bağımlı olurdu; bu yüzden sayılar sunucu
    //  kotasından okunur ve gösterge ONUNLA karşılaştırılır.)
    const quota = page.getByTestId('library-quota');
    await expect(quota).toBeVisible();
    const usedBefore = await readQuotaUsedBytes(account.context.request, account.accessToken);
    await expect
      .poll(async () => (await quota.innerText()).replace(/\s+/g, ' '), {
        timeout: 15_000,
        message: 'Kota göstergesi yükleme sonrası sunucu kotasıyla aynı sayıyı göstermedi.',
      })
      .toContain(`${formatBytes(usedBefore)} /`);

    // --- GERÇEK sağ tık -> menü -> Sil ---
    const row = library.row(video.fileName);
    await realClick(page, row, 'right');
    const menu = page.getByTestId('library-context-menu');
    await expect(menu).toBeVisible();
    await realClick(page, page.getByTestId('library-menu-delete'));

    // --- diyalog: kullanım sorgusu "kullanılmıyor" demeli ---
    const dialog = page.getByTestId('asset-delete-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('asset-delete-usage-unused')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('asset-delete-usage-warning')).toHaveCount(0);
    await expect(dialog).toContainText(video.fileName);

    await realClick(page, page.getByTestId('asset-delete-confirm'));

    // --- sonuç: diyalog kapandı, satır listeden düştü, sunucu da silmiş ---
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect(row).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText('Henüz medya yok', { exact: false })).toBeVisible();

    const assets = await listProjectAssets(
      account.context.request,
      account.accessToken,
      project.projectId,
    );
    expect(assets, 'Silinen asset sunucu listesinde hâlâ duruyor.').toHaveLength(0);

    // Kota: sunucuda TAM olarak dosya boyutu kadar düşer, gösterge de onu yazar.
    await expect
      .poll(() => readQuotaUsedBytes(account.context.request, account.accessToken), {
        timeout: 15_000,
        message: 'Silinen medya kotadan düşmedi.',
      })
      .toBe(usedBefore - video.sizeBytes);
    await expect
      .poll(async () => (await quota.innerText()).replace(/\s+/g, ' '), {
        timeout: 15_000,
        message: 'Silme sonrası kota göstergesi güncellenmedi.',
      })
      .toContain(`${formatBytes(usedBefore - video.sizeBytes)} /`);
  });

  test('timeline\'da kullanılan medyayı silmek UYARI gösterir; onaydan sonra klip "medya eksik" olur', async ({
    page,
    account,
  }) => {
    test.skip(ffmpegVersion() === null, FFMPEG_SKIP_REASON);
    test.setTimeout(300_000);

    const video = ensureTestVideo();
    const project = await createEmptyProject(
      account.context.request,
      account.accessToken,
      'E2E kullanim',
    );
    await assertM6EndpointsAvailable(account.context.request, account.accessToken);

    const app = new EditorApp(page);
    await app.open(project.projectId, { email: account.email, password: account.password });
    const library = new LibraryPanelHarness(page);

    await library.pickFiles([video.path]);
    await library.waitForReady(video.fileName);

    // --- timeline'a ekle (gerçek çift tık) ---
    await library.doubleClickAsset(video.fileName);
    await expect
      .poll(async () => (await app.state()).clipCount, {
        timeout: 15_000,
        message: 'Klip timeline\'a eklenemedi.',
      })
      .toBe(1);

    // Kullanım sorgusu SUNUCUDAKİ dokümana bakar: autosave inmeden sorulursa
    // "kullanılmıyor" der. Önce kaydı bekle, sonra sunucunun gerçekten öyle
    // gördüğünü API'den doğrula (uç noktanın kendi kanıtı).
    await expect(page.getByText('Kaydedildi', { exact: true })).toBeVisible({ timeout: 30_000 });
    const assets = await listProjectAssets(
      account.context.request,
      account.accessToken,
      project.projectId,
    );
    const assetId = assets.find((a) => a.fileName === video.fileName)?.id;
    expect(assetId, 'Yüklenen asset sunucu listesinde yok.').toBeTruthy();

    await expect
      .poll(
        async () => {
          const res = await account.context.request.get(`/api/assets/${assetId}/usage`, {
            headers: { Authorization: `Bearer ${account.accessToken}` },
          });
          if (!res.ok()) return -1;
          const body = (await res.json()) as { projects: { clipCount: number }[] };
          return body.projects.reduce((sum, p) => sum + p.clipCount, 0);
        },
        { timeout: 30_000, message: 'Sunucu kullanım sorgusu klibi görmedi (autosave inmedi mi?).' },
      )
      .toBe(1);

    // Silmeden ÖNCEKİ klip görüntüsü: filmstrip çizili (çok renkli).
    const stateBefore = await app.state();
    const clipId = stateBefore.tracks.flatMap((t) => t.clips)[0].id;
    await app.ensureContentVisible(clipId);
    const box = await app.timeline.clipBox(clipId);
    await expect
      .poll(async () => (await clipContentColors(page, box)).unique, {
        timeout: 30_000,
        message: 'Filmstrip çizilmedi — "eksik medya" karşılaştırması anlamsız olurdu.',
      })
      .toBeGreaterThan(8);

    // --- GERÇEK sağ tık -> Sil -> UYARI ---
    await realClick(page, library.row(video.fileName), 'right');
    await realClick(page, page.getByTestId('library-menu-delete'));

    const warning = page.getByTestId('asset-delete-usage-warning');
    await expect(warning).toBeVisible({ timeout: 15_000 });
    await expect(warning).toContainText('1 projede 1 klipte kullanılıyor');
    await expect(warning).toContainText('silinirse o klipler bozulur');
    await expect(warning).toContainText(project.projectName); // hangi proje olduğu YAZILI
    const confirm = page.getByTestId('asset-delete-confirm');
    await expect(confirm).toHaveText('Yine de sil');

    await realClick(page, confirm);
    await expect(page.getByTestId('asset-delete-dialog')).toBeHidden({ timeout: 15_000 });
    await expect(library.row(video.fileName)).toHaveCount(0, { timeout: 15_000 });

    // --- timeline: klip DURUYOR ama "medya eksik" olarak boyanıyor ---
    expect((await app.state()).clipCount, 'Silme kullanıcının dokümanına dokunmamalı.').toBe(1);
    await expect
      .poll(
        async () => {
          const rgb = await clipDominantRgb(page, box);
          return rgb.r - Math.max(rgb.g, rgb.b);
        },
        {
          timeout: 15_000,
          message:
            'Klip gövdesi kırmızıya çalmıyor: silinen medya için "medya eksik" boyaması yapılmadı.',
        },
      )
      .toBeGreaterThan(10);

    // --- Inspector: klibe GERÇEK tıklama -> ne olduğunu yazan uyarı ---
    await app.timeline.click(await app.timeline.clipCenter(clipId));
    const notice = page.getByTestId('clip-missing-media');
    await expect(notice).toBeVisible({ timeout: 10_000 });
    await expect(notice).toContainText('medyası kitaplıktan silinmiş');
    await expect(notice).toContainText('asset-missing');
  });

  test('⋯ düğmesi aynı menüyü açar ve "Vazgeç" medyayı SİLMEZ', async ({ page, account }) => {
    test.skip(ffmpegVersion() === null, FFMPEG_SKIP_REASON);
    test.setTimeout(240_000);

    const video = ensureTestVideo();
    const project = await createEmptyProject(
      account.context.request,
      account.accessToken,
      'E2E vazgec',
    );
    await assertM6EndpointsAvailable(account.context.request, account.accessToken);

    const app = new EditorApp(page);
    await app.open(project.projectId, { email: account.email, password: account.password });
    const library = new LibraryPanelHarness(page);

    await library.pickFiles([video.path]);
    // Bu test worker'a bağlı DEĞİL: satır sunucu listesine düştüğü anda (⋯
    // düğmesi göründüğünde) menü/diyalog yolu denenebilir.
    const menuButton = library.row(video.fileName).getByTestId('asset-menu-button');
    await expect(menuButton).toBeVisible({ timeout: 120_000 });

    await realClick(page, menuButton);
    await expect(page.getByTestId('library-context-menu')).toBeVisible();
    await realClick(page, page.getByTestId('library-menu-delete'));

    const dialog = page.getByTestId('asset-delete-dialog');
    await expect(dialog).toBeVisible();
    // Kullanım yanıtı gelmeden onay düğmesi ETKİN OLMAMALI.
    await expect(page.getByTestId('asset-delete-confirm')).toBeEnabled({ timeout: 15_000 });

    await realClick(page, page.getByTestId('asset-delete-cancel'));
    await expect(dialog).toBeHidden();

    // Vazgeçmek SİLMEZ: satır da sunucu kaydı da yerinde.
    await expect(library.row(video.fileName)).toHaveCount(1);
    const assets = await listProjectAssets(
      account.context.request,
      account.accessToken,
      project.projectId,
    );
    expect(assets, '"Vazgeç" medyayı sildi.').toHaveLength(1);
  });
});
