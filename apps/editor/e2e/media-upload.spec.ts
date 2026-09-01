/**
 * Gerçek medya yükleme akışı — ffmpeg ile ÜRETİLEN gerçek bir MP4, GERÇEK
 * dosya seçici, GERÇEK çok parçalı yükleme, GERÇEK worker işleme.
 *
 * Neden bu test en değerlisi: diğer tüm testler şema-geçerli ama var olmayan
 * asset'lere dayanır (fixtures/seed.ts gerekçesi). Ürünün "medya koy, kes,
 * çıkar" vaadinin İLK yarısı yalnızca burada uçtan uca doğrulanır — dosya
 * seçiciden başlayıp sunucudaki ffprobe/proxy/filmstrip üretimine ve o
 * filmstrip'in timeline'a ÇİZİLMESİNE kadar.
 *
 * Ön koşullar ve dürüst atlama: ffmpeg yoksa test net bir mesajla atlanır;
 * medya worker'ı kapalıysa "Hazır" beklemesi worker'ı işaret eden bir mesajla
 * düşer (support/library.ts).
 */
import { test, expect } from './fixtures/test';
import { EditorApp } from './support/editor';
import { clipContentColors } from './support/canvasProbe';
import { LibraryPanelHarness, listProjectAssets } from './support/library';
import { ensureTestVideo, FFMPEG_SKIP_REASON, ffmpegVersion } from './support/media';
import { createEmptyProject } from './support/projects';

test.describe('Kitaplık — gerçek medya yükleme', () => {
  test('dosya seçiciden yüklenen video işlenir, "Hazır" olur ve timeline\'a eklenince filmstrip ÇİZİLİR', async ({
    page,
    account,
  }) => {
    test.skip(ffmpegVersion() === null, FFMPEG_SKIP_REASON);
    // Yükleme + worker işleme + ilk çizim: 60 sn'lik varsayılan yetmez.
    test.setTimeout(300_000);

    const video = ensureTestVideo();
    const project = await createEmptyProject(
      account.context.request,
      account.accessToken,
      'E2E medya',
    );

    const app = new EditorApp(page);
    await app.open(project.projectId, { email: account.email, password: account.password });
    const library = new LibraryPanelHarness(page);

    // "Yükleniyor" fazını GÖZLEMLENEBİLİR kıl: 2 MB'lık dosya localhost'ta
    // göz açıp kapayana kadar biterdi. Part imzalama isteği (küçük bir JSON
    // POST) geciktirilir — yüklemenin KENDİ gövdesine dokunulmaz, yani
    // yüklenen baytlar birebir dosyadır.
    let delayedOnce = false;
    await page.route('**/api/assets/*/parts/presign', async (route) => {
      if (!delayedOnce) {
        delayedOnce = true;
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
      await route.continue();
    });

    await library.pickFiles([video.path]);

    // 1) Yükleme kartı: dosya adı + faz etiketi + yüzde göstergesi.
    const card = library.row(video.fileName);
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.getByText(/Başlatılıyor…|Yükleniyor/)).toBeVisible({ timeout: 20_000 });
    await expect(card.getByText(/\d+%/)).toBeVisible({ timeout: 20_000 });

    // (Yönlendirme sökülmez: sökme, o an bekleyen handler'ı iptal edip yüklemeyi
    //  askıda bırakıyor — ölçüldü. Gecikme zaten yalnız İLK part imzalamasında.)

    // 2) Sunucu tarafı işleme bitene kadar bekle ("Sırada"/"İşleniyor" ->
    //    "Hazır"). Worker kapalıysa mesaj bunu söyler.
    await library.waitForReady(video.fileName);

    // 3) Asset kartı gerçek metadata gösteriyor (ffprobe çıktısı).
    const meta = await library.metaText(video.fileName);
    expect(meta, `Asset kartı meta satırı: "${meta}"`).toContain(
      `${video.width}×${video.height}`,
    );
    // 4 sn'lik kaynak (kart formatı m:ss — features/library/format.ts).
    expect(meta).toMatch(/\b0:04\b/);
    expect(meta).toMatch(/\bMB\b/);

    const assets = await listProjectAssets(
      account.context.request,
      account.accessToken,
      project.projectId,
    );
    const asset = assets.find((a) => a.fileName === video.fileName);
    expect(asset, 'Yüklenen asset sunucu listesinde yok.').toBeTruthy();
    expect(asset!.status).toBe('ready');

    // 4) Çift tık -> timeline'a ekleme (DnD'nin yedek yolu, gerçek fare).
    //    Kaynak SESLİ (worker ffprobe: hasAudio=true) → otomatik AV ayrımı
    //    (ozellik-3): video klip + linkli ses ikizi = 2 klip.
    const before = await app.state();
    expect(before.clipCount).toBe(0);
    await library.doubleClickAsset(video.fileName);

    await expect
      .poll(async () => (await app.state()).clipCount, {
        timeout: 10_000,
        message:
          'Çift tık sonrası 2 klip (video + otomatik ayrılan ses ikizi) eklenmeliydi.',
      })
      .toBe(2);

    const after = await app.state();
    const clip = after.tracks.flatMap((t) => t.clips).find((c) => c.kind === 'video')!;
    expect(clip, 'Video klibi bulunamadı.').toBeTruthy();
    // Klip süresi kaynağın GERÇEK süresinden gelir (kare ızgarasına oturur):
    // 4 sn ± 1 kare (33 333 µs).
    expect(Math.abs(clip.timelineDurationUs - (asset!.durationMicros ?? 0))).toBeLessThanOrEqual(
      34_000,
    );

    // 5) Filmstrip GERÇEKTEN çizildi mi? Klip gövdesindeki içerik şeridi düz
    //    dolgu değil, kaynak karelerin renklerini taşımalı.
    await app.ensureContentVisible(clip.id);
    const box = await app.timeline.clipBox(clip.id);
    await expect
      .poll(async () => (await clipContentColors(page, box)).unique, {
        timeout: 30_000,
        message:
          'Klip gövdesi tek renkli kaldı: filmstrip çizilmedi (sprite indirilemedi ya da ' +
          'manifest okunamadı). Beklenen: kaynak karelerden gelen ONLARCA farklı renk.',
      })
      .toBeGreaterThan(24);

    const colors = await clipContentColors(page, box);
    expect(
      colors.dominantRatio,
      `Baskın renk oranı ${colors.dominantRatio.toFixed(2)} — düz blok boyaması gibi.`,
    ).toBeLessThan(0.9);
  });
});
