/**
 * Audio meter — real mouse, real keyboard, real audio.
 *
 * The meter's contract is not "a bar moves": it is that the bar moves when a
 * mix is actually playing and that the panel SAYS WHY when it is not. Both
 * halves are asserted here, through the throttled data-* surface the component
 * publishes (canvas pixels would be a fragile proxy for the same fact).
 *
 * Timing is polled, never slept: the sampling cadence rides on rAF, and rAF is
 * not a promise about wall-clock time -- a background tab, a loaded machine or
 * a throttled headless run all stretch it. (Headless is not automatically slow:
 * measured 2026-09-04 at 60.0 Hz here. That is exactly why the wait is polled
 * rather than sized to any assumed cadence.)
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/test';
import { EditorApp } from './support/editor';
import { LibraryPanelHarness } from './support/library';
import {
  FFMPEG_SKIP_REASON,
  ensureLoudAudio,
  ensureTestAudio,
  ffmpegVersion,
} from './support/media';
import { createEmptyProject } from './support/projects';

const METER = '[data-testid="audio-meter"]';

function meterAttr(page: Page, name: string): Promise<string | null> {
  return page.locator(METER).getAttribute(name);
}

async function meterDb(
  page: Page,
  name: 'data-meter-db-l' | 'data-meter-db-r' | 'data-meter-hold-db',
): Promise<number> {
  const raw = await meterAttr(page, name);
  return raw === null || raw === '-inf' ? Number.NEGATIVE_INFINITY : Number(raw);
}

/** Transport state from the DEV bridge (player.spec.ts uses the same reader). */
function isPlaying(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const bridge = (
      window as unknown as {
        __ve: { editor: { useEditorStore: { getState(): { isPlaying: boolean } } } };
      }
    ).__ve;
    return bridge.editor.useEditorStore.getState().isPlaying;
  });
}

async function doubleClickRow(
  page: Page,
  library: LibraryPanelHarness,
  fileName: string,
): Promise<void> {
  const box = await library.row(fileName).boundingBox();
  expect(box, `Kitaplıkta "${fileName}" satırı görünmüyor.`).not.toBeNull();
  const point = { x: box!.x + 40, y: box!.y + box!.height / 2 };
  await page.mouse.move(point.x, point.y);
  await page.mouse.dblclick(point.x, point.y);
}

test.describe('Ses ölçer — gerçek girdi, gerçek miks', () => {
  test('jestten önce "ölçüm yok" der; oynatınca tabanın üstüne çıkar; duraklatınca ve J geri taramada susar', async ({
    page,
    account,
  }) => {
    test.skip(ffmpegVersion() === null, FFMPEG_SKIP_REASON);
    test.setTimeout(180_000);

    const music = ensureTestAudio();
    const project = await createEmptyProject(
      account.context.request,
      account.accessToken,
      'E2E ses ölçer',
    );
    const app = new EditorApp(page);
    await app.open(project.projectId, { email: account.email, password: account.password });

    // --- 1. İlk jestten ÖNCE: sıfır DEĞİL, "ölçüm yok" ---
    // Ses motoru tarayıcı kuralı gereği ilk oynatmaya kadar kurulmaz; bunu
    // sıfır seviye göstererek gizlemek "miks sessiz" yalanı olurdu.
    await expect(page.locator(METER)).toBeVisible();
    // Öznitelikler JSX'te STATİK DEĞİL: yalnız gerçek bir meter$ yayını yazar.
    // Bu yüzden poll ediyoruz — iddia hem değeri hem ÖLÇÜM HATTININ ÇALIŞTIĞINI
    // kanıtlar (statik varsayılanla ikisi ayrışırdı; denetim bulgusu).
    await expect
      .poll(() => meterAttr(page, 'data-meter-reason'), {
        timeout: 10_000,
        message: 'Ölçer hiç yayın yapmadı ya da gerekçe "no-context" değil.',
      })
      .toBe('no-context');
    expect(
      await meterAttr(page, 'data-meter-live'),
      'Jestten önce ölçer CANLI görünmemeli.',
    ).toBe('false');
    await expect(page.getByTestId('audio-meter-readout')).toHaveText('Ölçüm yok');

    // --- 2. GERÇEK yükleme + gerçek çift tık: sesli klip timeline'a ---
    const library = new LibraryPanelHarness(page);
    await library.pickFiles([music.path]);
    await library.waitForReady(music.fileName);
    await doubleClickRow(page, library, music.fileName);
    await expect
      .poll(async () => (await app.state()).clipCount, {
        timeout: 20_000,
        message: 'Çift tık sesi timeline\'a eklemedi.',
      })
      .toBe(1);

    // --- 3. GERÇEK fare ile oynat: ölçer tabanın ÜSTÜNE çıkmalı ---
    // Transport düğmesine tıklıyoruz, Space'e değil: çift tıktan sonra odak
    // kitaplıkta bir düğmede kalabiliyor ve Space o düğmeyi tetikleyip
    // oynatmayı hiç başlatmıyordu (ölçülen kırılganlık).
    const transport = page.getByRole('button', { name: /^(Oynat|Duraklat)$/ });
    await transport.click();
    await expect
      .poll(() => isPlaying(page), {
        timeout: 15_000,
        message: 'Transport düğmesi oynatmayı başlatmadı.',
      })
      .toBe(true);
    await expect
      .poll(() => meterDb(page, 'data-meter-db-l'), {
        timeout: 20_000,
        message: 'Oynatma sırasında ölçer taban seviyesinde kaldı (tap ölçmüyor).',
      })
      .toBeGreaterThan(-40);
    expect(await meterAttr(page, 'data-meter-live'), 'Çalarken ölçer CANLI olmalı.').toBe('true');
    expect(await meterAttr(page, 'data-meter-reason')).toBe('running');
    // SAĞ KANAL da ölçülmeli. Fikstür MONO'dur; sağ kanalın dolması yalnız
    // tap'in explicit stereo olmasıyla mümkündür (§8.5 upmix). Bu iddia
    // olmadan tap'in `channelCountMode` özelliği düşse mono klipte sağ kanal
    // sessizce ölürdü ve hiçbir test kırmızıya dönmezdi (denetim bulgusu).
    expect(
      await meterDb(page, 'data-meter-db-r'),
      'Sağ kanal tabanda kaldı — mono kaynak stereo tap ile upmix EDİLMEMİŞ olabilir (§8.5).',
    ).toBeGreaterThan(-40);

    // --- 4. Duraklat: ölçer susar ve NEDENİNİ söyler ---
    await transport.click();
    await expect
      .poll(() => meterAttr(page, 'data-meter-reason'), {
        timeout: 10_000,
        message: 'Duraklatmadan sonra ölçer gerekçesi "paused" olmalı.',
      })
      .toBe('paused');
    expect(await meterAttr(page, 'data-meter-live')).toBe('false');
    await expect(page.getByTestId('audio-meter-readout')).toHaveText('Duraklatıldı');

    // --- 5. J geri tarama: sessizlik YAPISAL, ölçer bunu ayrı cümleyle söyler ---
    // Önce sona git: taramanın koşacak yeri olsun. Başlangıca yakın basılan J
    // proje başında kendiliğinden durur (BOF kelepçesi) ve rejim biz bakmadan
    // kapanırdı — testin ölçtüğü şey tarama, kelepçe değil.
    await page.keyboard.press('End');
    await page.keyboard.press('j');
    await expect
      .poll(() => meterAttr(page, 'data-meter-reason'), {
        timeout: 10_000,
        message: 'J geri taramada ölçer gerekçesi "shuttle" olmalı.',
      })
      .toBe('shuttle');
    await expect(page.getByTestId('audio-meter-readout')).toHaveText('Ses kapalı');
    // Oynatıcıdaki rozet ile AYNI cümle: tek kaynak (useTransportStore).
    await expect(page.getByTestId('transport-shuttle-note')).toContainText('ses kapalı');
    await page.keyboard.press('k');
  });

  test('0 dBFS aşımı mandalı yakar; gerçek tık mandalı söndürür', async ({ page, account }) => {
    test.skip(ffmpegVersion() === null, FFMPEG_SKIP_REASON);
    test.setTimeout(180_000);

    // TAM ÖLÇEKLİ kaynak: normal test sesiyle (kaynak -3,7 dBFS, proxy'de
    // mono→stereo matrisiyle -6,5 dBFS) klip kazancı 2,0 bile önizleme tepesini
    // -0,5 dBFS'te bırakıyor, yani mandalın eşiğinin ALTINDA — test ancak bir
    // decode transient'i eşiği aşarsa yeşil oluyordu (denetimde ~%50 kırılgan).
    const music = ensureLoudAudio();
    const project = await createEmptyProject(
      account.context.request,
      account.accessToken,
      'E2E ölçer klip mandalı',
    );
    const app = new EditorApp(page);
    await app.open(project.projectId, { email: account.email, password: account.password });

    const library = new LibraryPanelHarness(page);
    await library.pickFiles([music.path]);
    await library.waitForReady(music.fileName);
    await doubleClickRow(page, library, music.fileName);
    await expect.poll(async () => (await app.state()).clipCount).toBe(1);

    // Klibi seç ve ses seviyesini GERÇEK fareyle tavana çek: kaynak zaten
    // yüksek (volume=5 ile üretilmiş sinüs), 2.0 kazançla önizleme tepesi
    // 0 dBFS'i aşar. Önizlemede limiter YOKTUR (rendering-semantics §8.3) —
    // mandalın yanması tam olarak bu asimetrinin görünür hâlidir.
    const state = await app.state();
    const clipId = state.tracks.flatMap((t) => t.clips)[0]?.id;
    expect(clipId, 'Klip kimliği okunamadı.').toBeTruthy();
    await app.timeline.click(await app.timeline.clipCenter(clipId as string));

    const slider = page.getByTestId('clip-volume');
    await expect(slider).toBeVisible();
    const box = await slider.boundingBox();
    expect(box, "Ses seviyesi slider'ı görünmüyor.").not.toBeNull();
    const y = box!.y + box!.height / 2;
    await page.mouse.move(box!.x + box!.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width, y, { steps: 8 });
    await page.mouse.up();

    const transport = page.getByRole('button', { name: /^(Oynat|Duraklat)$/ });
    await transport.click();
    // ÖN KOŞULLAR AYRI AYRI İDDİA EDİLİR: biri tutmazsa kırmızı NEDENİNİ söyler,
    // 'mandal yanmadı' diye yanlış yere bakmayız (denetim dersi).
    await expect
      .poll(() => isPlaying(page), {
        timeout: 15_000,
        message: 'Ön koşul: transport düğmesi oynatmayı başlatmadı.',
      })
      .toBe(true);
    await expect
      .poll(() => meterDb(page, 'data-meter-db-l'), {
        timeout: 20_000,
        message: 'Ön koşul: ölçer sinyali görmüyor (kaynak/kazanç yolu kırık).',
      })
      .toBeGreaterThan(-6);
    await expect
      .poll(() => meterAttr(page, 'data-meter-clip'), {
        timeout: 25_000,
        message: '0 dBFS aşımında klip mandalı yanmalıydı.',
      })
      .toBe('true');

    const reset = page.getByTestId('audio-meter-reset');
    await expect(reset).toBeVisible();
    await transport.click(); // durdur: yeni aşım mandalı yeniden yakmasın
    await reset.click();
    await expect
      .poll(() => meterAttr(page, 'data-meter-clip'), {
        timeout: 10_000,
        message: 'Sıfırlama düğmesi mandalı söndürmeliydi.',
      })
      .toBe('false');
    await expect(reset).toHaveCount(0);
  });

  test('klip mandalı yokken sıfırlama düğmesi Tab sırasında DEĞİLDİR', async ({
    page,
    account,
  }) => {
    const project = await createEmptyProject(
      account.context.request,
      account.accessToken,
      'E2E ölçer tab hijyeni',
    );
    const app = new EditorApp(page);
    await app.open(project.projectId, { email: account.email, password: account.password });

    await expect(page.locator(METER)).toBeVisible();
    expect(await meterAttr(page, 'data-meter-clip')).not.toBe('true');
    // Mandal yokken düğme DOM'da hiç yoktur — devre dışı bir kontrol bile
    // odak sırasını kirletmesin (a11y-smoke'un 24 duraklık bütçesi).
    await expect(page.getByTestId('audio-meter-reset')).toHaveCount(0);
  });
});
