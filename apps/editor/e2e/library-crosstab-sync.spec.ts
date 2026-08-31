/**
 * B6 — çapraz-sekme/çapraz-istemci kitaplık senkronu (user-feed grubu).
 *
 * Ölçülmüş kusur (backlog M2/B6): asset listesi yoklaması yalnız listede
 * uploaded/processing satır varken koşar; pasif bir sekme, BAŞKA bir istemcinin
 * yüklediği asseti ve kota değişimini odak/yenileme olmadan HİÇ görmüyordu.
 * id-bazlı hub abonelikleri (`job:{id}`/`asset:{id}`) bunu kapatamaz — sekme o
 * id'leri zaten bilmiyor. Kapanış: worker'ın her progress publish'i sahibinin
 * `user:{id}` feed grubuna DA düşer; kitaplığı açık her sekme kendi feed'ine
 * abonedir ve BİLMEDİĞİ bir assetId gördüğünde listeyi + kotayı invalidate eder.
 *
 * Kurulum orijinal ölçümün birebir kendisi: sekme B kitaplıkta pasif İZLERKEN
 * yükleme HAM API'den (başka istemci) yapılır — sekmeye tek bir gerçek-girdi
 * jesti bile gönderilmez, sayfa yeniden yüklenmez. Kanıt dört ölçümden kurulur:
 *
 *  1. SESSİZ PENCERE: yükleme öncesi pasif sekme asset listesini YOKLAMIYOR
 *     (kusurun mekanizması — meşgul satır yokken interval false).
 *  2. Yeni satır + "Hazır" rozeti odak/yenileme olmadan görünür (kusurun kapanışı).
 *  3. Kota göstergesi aynı şekilde kendiliğinden değişir.
 *  4. Kanal kanıtı: `/hubs/progress` WS'inden bu assetId'nin feed mesajı AKTI ve
 *     yükleme sonrası İLK liste GET'i o mesajdan SONRA atıldı (tetikleyen odak
 *     ya da yoklama değil, hub olayıdır); sayfa hiç yeniden yüklenmedi.
 *
 * Bu spec'in NEGATİF KONTROLÜ istemcinin feed aboneliğinin sökülmesidir:
 * hub bağlanır ama feed'e girilmez → (2) kırmızı. Sunucu yarısının (feed grubuna
 * yayın + parametresiz abonelik) birim kanıtı ProgressHubTests / CrossUserAccessTests'te.
 */
import { test, expect } from './fixtures/test';
import { EditorApp } from './support/editor';
import { LibraryPanelHarness } from './support/library';
import { ensureTestVideo, FFMPEG_SKIP_REASON, ffmpegVersion } from './support/media';
import { createEmptyProject } from './support/projects';
import { uploadAssetViaApi } from './support/apiUpload';

interface FeedFrame {
  at: number;
  assetId: string | null;
  status: string;
}

/** SignalR JSON çerçevesinden (0x1e ayraçlı) progress mesajlarını çıkarır. */
function parseProgressFrames(payload: string): Array<{ assetId: string | null; status: string }> {
  const out: Array<{ assetId: string | null; status: string }> = [];
  for (const part of payload.split(String.fromCharCode(0x1e))) {
    if (part === '') continue;
    try {
      const frame = JSON.parse(part) as {
        type?: number;
        target?: string;
        arguments?: Array<{ assetId?: string | null; status?: string }>;
      };
      if (frame.type === 1 && frame.target === 'progress') {
        for (const arg of frame.arguments ?? []) {
          out.push({ assetId: arg.assetId ?? null, status: arg.status ?? '' });
        }
      }
    } catch {
      // handshake/ping çerçeveleri JSON progress değildir — atla
    }
  }
  return out;
}

test.describe('B6 — çapraz-istemci kitaplık senkronu (user-feed)', () => {
  test('pasif sekme, başka istemcinin yüklediği asseti ve kotayı odak/yenileme olmadan görür', async ({
    page,
    account,
  }) => {
    test.skip(ffmpegVersion() === null, FFMPEG_SKIP_REASON);
    test.setTimeout(240_000);

    const video = ensureTestVideo('crosstab');
    const project = await createEmptyProject(
      account.context.request,
      account.accessToken,
      'E2E B6 crosstab',
    );

    // ── Sondalar SAYFA AÇILMADAN kurulur: WS çerçeveleri + liste GET zamanları.
    const feedFrames: FeedFrame[] = [];
    let hubSocketCount = 0;
    page.on('websocket', (ws) => {
      if (!ws.url().includes('/hubs/progress')) return;
      hubSocketCount += 1;
      ws.on('framereceived', (frame) => {
        for (const parsed of parseProgressFrames(String(frame.payload))) {
          feedFrames.push({ at: Date.now(), ...parsed });
        }
      });
    });
    const assetListGets: number[] = [];
    const listPattern = new RegExp(`/api/projects/${project.projectId}/assets`);
    page.on('request', (request) => {
      if (request.method() === 'GET' && listPattern.test(request.url())) {
        assetListGets.push(Date.now());
      }
    });

    const app = new EditorApp(page);
    await app.open(project.projectId, { email: account.email, password: account.password });
    const library = new LibraryPanelHarness(page);

    // Kitaplık boş ve kota göstergesi dolu — başlangıç durumu.
    await expect(library.dropZoneButton).toBeVisible();
    const quota = page.getByTestId('library-quota');
    await expect(quota).toBeVisible();
    await expect(library.row(video.fileName)).toHaveCount(0);
    const quotaBefore = (await quota.innerText()).trim();

    // Bu andan sonra sayfa bir daha YÜKLENMEZ — "odak/yenileme olmadan" iddiasının sayacı.
    let pageLoads = 0;
    page.on('load', () => {
      pageLoads += 1;
    });

    // ── 1) SESSİZ PENCERE: pasif sekme (meşgul satır yok) listeyi yoklamıyor.
    // Açılış fetch'lerinin oturması için kısa pay, sonra 4 sn'lik ölçüm.
    await page.waitForTimeout(2_000);
    const quietStart = Date.now();
    await page.waitForTimeout(4_000);
    const quietGets = assetListGets.filter((t) => t >= quietStart).length;
    expect(
      quietGets,
      'Sessiz pencerede liste GET\'i sayıldı — "meşgul satır yokken yoklama durur" öncülü ' +
        'değişmiş; bu spec\'in kusur mekanizması ölçümü artık geçerli değil.',
    ).toBe(0);

    // ── 2) Yükleme BAŞKA İSTEMCİDEN (ham API — orijinal ölçümdeki gibi).
    const tUpload = Date.now();
    const uploaded = await uploadAssetViaApi(
      account.context.request,
      account.accessToken,
      project.projectId,
      video.path,
      video.fileName,
      'video/mp4',
    );

    // ── 3) KUSURUN KAPANIŞI: yeni satır odak/yenileme olmadan görünür.
    await expect(
      library.row(video.fileName),
      'Pasif sekme başka istemcinin yüklediği asseti görmedi — user-feed yayını ya da ' +
        'istemcinin bilinmeyen-asset tepkisi çalışmıyor (B6 kusuru açık).',
    ).toBeVisible({ timeout: 30_000 });
    const rowVisibleAfterMs = Date.now() - tUpload;

    // İşleme canlı kanaldan "Hazır"a kadar akar (satır artık bilinen id yolunda).
    await expect(
      library.readyBadge(video.fileName),
      'Satır göründü ama "Hazır" rozetine ulaşmadı — bilinen-id (asset grubu) yolu ya da ' +
        'terminal invalidate bozulmuş olabilir.',
    ).toBeVisible({ timeout: 120_000 });

    // ── 4) Kota göstergesi de kendiliğinden değişti.
    await expect
      .poll(async () => (await quota.innerText()).trim(), {
        timeout: 30_000,
        message:
          'Kota göstergesi pasif sekmede değişmedi — feed olayı kota sorgusunu invalidate etmiyor.',
      })
      .not.toBe(quotaBefore);

    // ── 5) Kanal kanıtı: feed mesajı aktı ve liste tazelemesini O tetikledi.
    expect(hubSocketCount, 'Hiç /hubs/progress WebSocket\'i kurulmadı.').toBeGreaterThan(0);
    const assetFrames = feedFrames.filter((f) => f.assetId === uploaded.assetId);
    expect(
      assetFrames.length,
      'Hub\'dan bu asset\'in hiçbir progress mesajı gelmedi (feed grubu beslenmiyor mu?).',
    ).toBeGreaterThanOrEqual(1);
    const firstListGetAfterUpload = assetListGets.find((t) => t >= tUpload);
    expect(
      firstListGetAfterUpload,
      'Yükleme sonrası hiç liste GET\'i atılmadı — satır nasıl göründü?',
    ).toBeTruthy();
    expect(
      firstListGetAfterUpload!,
      'Yükleme sonrası İLK liste GET\'i ilk feed mesajından ÖNCE atıldı — tazelemeyi hub değil ' +
        'başka bir şey tetiklemiş (ölçüm bu koşumda kanalı kanıtlamıyor).',
    ).toBeGreaterThanOrEqual(assetFrames[0]!.at);
    expect(pageLoads, 'Sayfa yeniden yüklendi — "odak/yenileme olmadan" iddiası düşer.').toBe(0);

    // Tanılama satırı (perf iddiası değil; PROGRESS kaydına ham veri).
    console.log(
      `[b6-crosstab] satır ${rowVisibleAfterMs} ms'de göründü; ` +
        `ilk feed mesajı +${assetFrames[0]!.at - tUpload} ms; liste GET sayısı ` +
        `(yükleme→şimdi) ${assetListGets.filter((t) => t >= tUpload).length}`,
    );
  });
});
