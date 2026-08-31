/**
 * Silme senkronu — B6'nın SİLME yarısı (gelistirme-3 #2a).
 *
 * Ölçülmüş kusur (2026-08-31 keşif turu): AssetEndpoints.SoftDelete yalnız DB
 * ExecuteUpdate + 204 idi — hiçbir yayın tetiklenmiyordu. Silme worker işi
 * doğurmadığı için user:{id} feed'ine mesaj DÜŞMEZ; pasif sekme silinen asseti
 * süresiz görür, kota göstergesi de bayat kalır (B6 dilimi yalnız "yeni satır
 * doğdu"yu kapatmıştı). Kapanış: API (hub'ı kendisi barındırır) silme sonrası
 * sahibinin feed grubuna süreç-içi `assetRemoved` mesajı yollar; istemci satırı
 * liste cache'lerinden DÜŞÜRÜR (liste GET'i yok) ve kotayı BİR kez invalidate eder.
 *
 * Kurulum library-crosstab-sync.spec.ts'in aynası: sekme kitaplıkta pasif
 * İZLERKEN silme BAŞKA istemciden (ham API DELETE) yapılır — sekmeye tek bir
 * gerçek-girdi jesti bile gönderilmez, sayfa yeniden yüklenmez. Kanıt:
 *
 *  1. SESSİZ PENCERE: silme öncesi pasif sekme listeyi YOKLAMIYOR (satır
 *     "Hazır" — meşgul satır yokken interval false; kusurun mekanizması).
 *  2. Satır odak/yenileme olmadan kaybolur (kusurun kapanışı).
 *  3. Kota göstergesi kendiliğinden düşer.
 *  4. Kanal kanıtı: /hubs/progress WS'inden bu assetId'nin `assetRemoved`
 *     çerçevesi AKTI; silme sonrası HİÇ liste GET'i atılmadı (satır cache
 *     cerrahisiyle düştü — tetikleyici hub olayıdır, yoklama/odak değil);
 *     kota GET'i o çerçeveden SONRA geldi; sayfa hiç yeniden yüklenmedi.
 *
 * Bu spec'in NEGATİF KONTROLÜ istemcinin `assetRemoved` dinleyicisinin
 * sökülmesidir → (2) kırmızı. Sunucu yarısının (yalnız SAHİBİNİN feed grubuna
 * yayın — IDOR) birim kanıtı AssetEndpointsTests.SoftDelete_Publishes*'tadır.
 */
import { test, expect } from './fixtures/test';
import { EditorApp } from './support/editor';
import { LibraryPanelHarness } from './support/library';
import { ensureTestVideo, FFMPEG_SKIP_REASON, ffmpegVersion } from './support/media';
import { createEmptyProject } from './support/projects';
import { uploadAssetViaApi, waitAssetReady } from './support/apiUpload';

interface RemovedFrame {
  at: number;
  assetId: string | null;
}

/** SignalR JSON çerçevelerinden (0x1e ayraçlı) `assetRemoved` mesajlarını çıkarır. */
function parseAssetRemovedFrames(payload: string): Array<{ assetId: string | null }> {
  const out: Array<{ assetId: string | null }> = [];
  for (const part of payload.split(String.fromCharCode(0x1e))) {
    if (part === '') continue;
    try {
      const frame = JSON.parse(part) as {
        type?: number;
        target?: string;
        arguments?: Array<{ assetId?: string | null }>;
      };
      if (frame.type === 1 && frame.target === 'assetRemoved') {
        for (const arg of frame.arguments ?? []) {
          out.push({ assetId: arg.assetId ?? null });
        }
      }
    } catch {
      // handshake/ping çerçeveleri JSON progress değildir — atla
    }
  }
  return out;
}

test.describe('Silme senkronu — çapraz-istemci (user-feed assetRemoved)', () => {
  test('pasif sekme, başka istemcinin sildiği asseti ve kota düşüşünü odak/yenileme olmadan görür', async ({
    page,
    account,
  }) => {
    test.skip(ffmpegVersion() === null, FFMPEG_SKIP_REASON);
    test.setTimeout(240_000);

    const video = ensureTestVideo('crosstab-del');
    const project = await createEmptyProject(
      account.context.request,
      account.accessToken,
      'E2E silme senkronu',
    );

    // Asset SAYFA AÇILMADAN yüklenir ve hazır edilir: silme anında listede meşgul
    // satır kalmaz → yoklama kapalı (kusur mekanizması) ve worker mesajı akmaz
    // (assetRemoved dışında kanal sessiz — kanal kanıtı kirlenmez).
    const uploaded = await uploadAssetViaApi(
      account.context.request,
      account.accessToken,
      project.projectId,
      video.path,
      video.fileName,
      'video/mp4',
    );
    await waitAssetReady(account.context.request, account.accessToken, uploaded.assetId, video.fileName);

    // ── Sondalar SAYFA AÇILMADAN kurulur: WS çerçeveleri + liste/kota GET zamanları.
    const removedFrames: RemovedFrame[] = [];
    let hubSocketCount = 0;
    page.on('websocket', (ws) => {
      if (!ws.url().includes('/hubs/progress')) return;
      hubSocketCount += 1;
      ws.on('framereceived', (frame) => {
        for (const parsed of parseAssetRemovedFrames(String(frame.payload))) {
          removedFrames.push({ at: Date.now(), ...parsed });
        }
      });
    });
    const assetListGets: number[] = [];
    const quotaGets: number[] = [];
    const listPattern = new RegExp(`/api/projects/${project.projectId}/assets`);
    page.on('request', (request) => {
      if (request.method() !== 'GET') return;
      if (listPattern.test(request.url())) assetListGets.push(Date.now());
      if (request.url().includes('/api/quota')) quotaGets.push(Date.now());
    });

    const app = new EditorApp(page);
    await app.open(project.projectId, { email: account.email, password: account.password });
    const library = new LibraryPanelHarness(page);

    // Başlangıç durumu: satır "Hazır" ve kota göstergesi asseti sayıyor.
    await expect(library.readyBadge(video.fileName)).toBeVisible({ timeout: 30_000 });
    const quota = page.getByTestId('library-quota');
    await expect(quota).toBeVisible();
    const quotaBefore = (await quota.innerText()).trim();

    // Bu andan sonra sayfa bir daha YÜKLENMEZ — "odak/yenileme olmadan" iddiasının sayacı.
    let pageLoads = 0;
    page.on('load', () => {
      pageLoads += 1;
    });

    // ── 1) SESSİZ PENCERE: satır hazır (meşgul yok) → pasif sekme listeyi yoklamıyor.
    await page.waitForTimeout(2_000);
    const quietStart = Date.now();
    await page.waitForTimeout(4_000);
    const quietGets = assetListGets.filter((t) => t >= quietStart).length;
    expect(
      quietGets,
      'Sessiz pencerede liste GET\'i sayıldı — "meşgul satır yokken yoklama durur" öncülü ' +
        'değişmiş; bu spec\'in kusur mekanizması ölçümü artık geçerli değil.',
    ).toBe(0);

    // ── 2) Silme BAŞKA İSTEMCİDEN (ham API DELETE — orijinal keşif ölçümündeki yol).
    const tDelete = Date.now();
    const delRes = await account.context.request.delete(`/api/assets/${uploaded.assetId}`, {
      headers: { Authorization: `Bearer ${account.accessToken}` },
    });
    expect(delRes.status(), 'DELETE /api/assets/{id} 204 dönmedi.').toBe(204);

    // ── 3) KUSURUN KAPANIŞI: satır odak/yenileme olmadan kaybolur.
    await expect(
      library.row(video.fileName),
      'Pasif sekme başka istemcinin sildiği asseti göstermeye devam etti — assetRemoved ' +
        'yayını ya da istemcinin cache cerrahisi çalışmıyor (silme-senkronu kusuru açık).',
    ).toHaveCount(0, { timeout: 30_000 });
    const rowGoneAfterMs = Date.now() - tDelete;

    // ── 4) Kota göstergesi de kendiliğinden düştü.
    await expect
      .poll(async () => (await quota.innerText()).trim(), {
        timeout: 30_000,
        message:
          'Kota göstergesi pasif sekmede değişmedi — assetRemoved olayı kota sorgusunu invalidate etmiyor.',
      })
      .not.toBe(quotaBefore);

    // ── 5) Kanal kanıtı: assetRemoved çerçevesi aktı; listeyi kimse ÇEKMEDİ (cerrahî),
    //      kota GET'i çerçeveden SONRA; sayfa hiç yeniden yüklenmedi.
    expect(hubSocketCount, 'Hiç /hubs/progress WebSocket\'i kurulmadı.').toBeGreaterThan(0);
    const frames = removedFrames.filter((f) => f.assetId === uploaded.assetId);
    expect(
      frames.length,
      'Hub\'dan bu asset\'in assetRemoved mesajı gelmedi (feed grubuna silme yayını yok mu?).',
    ).toBeGreaterThanOrEqual(1);
    const listGetsAfterDelete = assetListGets.filter((t) => t >= tDelete).length;
    expect(
      listGetsAfterDelete,
      'Silme sonrası liste GET\'i atıldı — satır cache cerrahisiyle değil refetch\'le düşmüş ' +
        '(tek olay = tek invalidate sözleşmesi bozulmuş olabilir).',
    ).toBe(0);
    const firstQuotaGetAfterDelete = quotaGets.find((t) => t >= tDelete);
    expect(
      firstQuotaGetAfterDelete,
      'Silme sonrası hiç kota GET\'i atılmadı — gösterge nasıl değişti?',
    ).toBeTruthy();
    expect(
      firstQuotaGetAfterDelete!,
      'Kota GET\'i ilk assetRemoved çerçevesinden ÖNCE atıldı — tazelemeyi hub değil başka ' +
        'bir şey tetiklemiş (ölçüm bu koşumda kanalı kanıtlamıyor).',
    ).toBeGreaterThanOrEqual(frames[0]!.at);
    expect(pageLoads, 'Sayfa yeniden yüklendi — "odak/yenileme olmadan" iddiası düşer.').toBe(0);

    // Tanılama satırı (perf iddiası değil; PROGRESS kaydına ham veri).
    console.log(
      `[silme-senkronu] satır ${rowGoneAfterMs} ms'de kayboldu; ` +
        `ilk assetRemoved +${frames[0]!.at - tDelete} ms; silme sonrası liste GET ${listGetsAfterDelete}`,
    );
  });
});
