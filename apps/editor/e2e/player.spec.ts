/**
 * Önizleme oynatıcısı — transport çubuğu ve dürüst kapasite notu.
 *
 * Kapsam ayrımı (tekrar üretmemek için): gizmo'nun GÖRÜNÜRLÜK kuralları ve
 * sürükleme jestleri player-gizmo.spec.ts'te GERÇEK fareyle doğrulanır
 * (seçim + playhead klibin üstünde -> kutu var; oynatırken kutu gizlenir).
 * Burada kanıtlanan: oynat/duraklat düğmesi gerçek tıkla çalışır, zaman kodu
 * GERÇEKTEN ilerler, duraklatınca durur ve kare ızgarasına oturur; ve önizleme
 * kapasitesi yetmediğinde kullanıcı bunu EKRANDA görür (sessiz kayıp yok).
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/test';
import { EditorApp } from './support/editor';
import { getProject, saveTimeline } from './fixtures/seed';
import { LibraryPanelHarness, listProjectAssets } from './support/library';
import { ensureTestVideo, FFMPEG_SKIP_REASON, ffmpegVersion } from './support/media';
import { createEmptyProject } from './support/projects';

const SECOND_US = 1_000_000;

function transportButton(page: Page) {
  return page.getByRole('button', { name: /^(Oynat|Duraklat)$/ });
}

/** Transport çubuğundaki playhead zaman kodu (proje fps). */
function playheadTimecode(page: Page) {
  return page.getByTitle('Playhead (proje fps zaman kodu)');
}

async function isPlaying(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const bridge = (window as unknown as {
      __ve: { editor: { useEditorStore: { getState(): { isPlaying: boolean } } } };
    }).__ve;
    return bridge.editor.useEditorStore.getState().isPlaying;
  });
}

test.describe('Player — transport', () => {
  test('oynat/duraklat GERÇEK tıkla çalışır; zaman kodu ilerler ve duraklayınca durur', async ({
    editor,
  }) => {
    const page = editor.page;
    const button = transportButton(page);
    await expect(button).toHaveAttribute('aria-label', 'Oynat');
    await expect(playheadTimecode(page)).toHaveText('00:00:00:00');

    // Gerçek fare tıklaması (düğmenin ortasına).
    const box = await button.boundingBox();
    expect(box, 'Transport düğmesi görünmüyor.').not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.up();

    await expect
      .poll(() => isPlaying(page), { message: 'Tıklama oynatmayı başlatmadı.' })
      .toBe(true);
    await expect(button).toHaveAttribute('aria-label', 'Duraklat');

    // Zaman kodu GERÇEKTEN ilerliyor mu (motor saati playhead'e bağlı mı)?
    await expect
      .poll(async () => (await playheadTimecode(page).innerText()).trim(), {
        timeout: 10_000,
        message: 'Oynatma başladı ama zaman kodu 00:00:00:00\'da kaldı.',
      })
      .not.toBe('00:00:00:00');

    // Duraklat.
    await page.mouse.down();
    await page.mouse.up();
    await expect.poll(() => isPlaying(page)).toBe(false);
    await expect(button).toHaveAttribute('aria-label', 'Oynat');

    // Duraklatınca playhead SABİT kalır ve kare ızgarasına oturur
    // (PlayerPanel playState$ -> snapUsToFrameGrid; 30 fps -> kare < 30).
    const frozen = (await playheadTimecode(page).innerText()).trim();
    await page.waitForTimeout(600);
    expect(
      (await playheadTimecode(page).innerText()).trim(),
      'Duraklatıldığı halde zaman kodu ilerliyor.',
    ).toBe(frozen);
    expect(frozen).toMatch(/^\d{2}:\d{2}:\d{2}:\d{2}$/);
    const frames = Number(frozen.slice(-2));
    expect(frames, `Kare alanı 30 fps ızgarasının dışında: ${frozen}`).toBeLessThan(30);

    const playhead = (await editor.state()).playheadUs;
    expect(playhead, 'Duraklatma sonrası playhead sıfırlanmamalı.').toBeGreaterThan(0);
    // Kare ızgarası: 30 fps -> 1 kare = 100000/3 µs; playhead tam kareye oturmalı.
    const frameUs = SECOND_US / 30;
    expect(Math.abs(playhead / frameUs - Math.round(playhead / frameUs))).toBeLessThan(0.001);
  });

  test('transport proje SÜRESİNİ gösterir (dokümandan türetilir)', async ({ editor }) => {
    // Seed içeriği 82. saniyede biter (fixtures/seed.ts) -> 00:01:22:00.
    await expect(editor.page.getByTitle('Proje süresi')).toHaveText('00:01:22:00');
  });
});

test.describe('Player — dürüst kapasite notu', () => {
  test('aynı anda havuzdan FAZLA katman varsa önizleme bunu EKRANDA söyler', async ({
    page,
    account,
  }) => {
    test.skip(ffmpegVersion() === null, FFMPEG_SKIP_REASON);
    test.setTimeout(300_000);

    // Not GERÇEK kapasiteyi ölçer (klibin bir <video> yuvası var mı), bu yüzden
    // gerçek bir medya şart: sahte assetId'li kliplerde havuz zaten hiçbir
    // yuva atamaz ve test "kapasite doldu"yu değil "medya yok"u ölçerdi.
    const video = ensureTestVideo();
    const project = await createEmptyProject(
      account.context.request,
      account.accessToken,
      'E2E katman',
    );

    const app = new EditorApp(page);
    await app.open(project.projectId, { email: account.email, password: account.password });
    const library = new LibraryPanelHarness(page);
    await library.pickFiles([video.path]);
    await library.waitForReady(video.fileName);

    const assets = await listProjectAssets(
      account.context.request,
      account.accessToken,
      project.projectId,
    );
    const assetId = assets[0].id;

    // Havuz 4 elemanlı (core/scheduler POOL_SIZE) — 5 ÜST ÜSTE binen video
    // klibi kapasiteyi bilerek aşar.
    const layers = 5;
    const durationUs = 3 * SECOND_US;
    const detail = await getProject(
      account.context.request,
      account.accessToken,
      project.projectId,
    );
    const doc = {
      schemaVersion: 1,
      projectId: project.projectId,
      settings: {
        width: 1920,
        height: 1080,
        fps: { num: 30, den: 1 },
        audioSampleRate: 48000,
        backgroundColor: '#000000',
      },
      tracks: Array.from({ length: layers }, (_, i) => ({
        id: crypto.randomUUID(),
        type: 'video',
        name: `V${i + 1}`,
        muted: false,
        hidden: false,
        locked: false,
        clips: [
          {
            id: crypto.randomUUID(),
            kind: 'video',
            assetId,
            timelineStartUs: 0,
            timelineDurationUs: durationUs,
            sourceInUs: 0,
            sourceOutUs: durationUs,
            speed: { rate: 1 },
            audio: { volume: 1, fadeInUs: 0, fadeOutUs: 0, muted: false },
            transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5 },
            keyframes: {},
            effects: [],
            opacity: 1,
          },
        ],
      })),
      markers: [],
    };
    await saveTimeline(
      account.context.request,
      account.accessToken,
      project.projectId,
      doc,
      detail.revisionNumber,
    );

    // Sunucudaki yeni dokümanla aç ve playhead'i kliplerin ORTASINA getir.
    await app.open(project.projectId, { email: account.email, password: account.password });
    await app.timeline.scrubTo(1.5 * SECOND_US);

    const note = page.getByTestId('preview-layer-note');
    await expect(
      note,
      'Önizleme kapasitesi aşıldığı halde kullanıcıya hiçbir şey söylenmiyor (sessiz kayıp).',
    ).toBeVisible({ timeout: 30_000 });
    await expect(note).toContainText(`/ ${layers} katman gösteriliyor`);
    await expect(note).toHaveAttribute('role', 'status');
    // Notun ayrıntısı dürüst olmalı: önizleme sınırı EXPORT sınırı değildir.
    expect(await note.getAttribute('title')).toContain('Dışa aktarımda TÜM katmanlar');
  });
});
