/**
 * Kitaplık -> timeline SÜRÜKLE-BIRAK — ürünün ASIL ekleme jesti, gerçek fareyle.
 *
 * Neden ayrı bir dosya (YÜKSEK denetim bulgusu): bugüne kadar yalnız
 * ÇİFT TIK yolu test ediliyordu (media-upload.spec.ts). Çift tık, ürünün kendi
 * kodunda "DnD'nin yedek yolu" diye geçer (LibraryPanel.tsx: "Çift tık: DnD'nin
 * yedek yolu") ve TAMAMEN FARKLI bir kod yolundan gider:
 *   - çift tık  -> addAssetToTimelineAtPlayhead()  (konum = playhead)
 *   - sürükleme -> pointerdown/​move/​up + setPointerCapture + libraryDnd store
 *                 + TimelinePanel'in insertTargetFor/​registerTimelineDropTarget
 *                 zinciri (konum = BIRAKILAN piksel).
 * Yani asıl jestin hiçbir parçası — 5 px sürükleme eşiği, pointer capture,
 * hayalet kart, timeline'ın ekleme hayaleti, satır/​zaman hesabı, timeline
 * dışında bırakma — kanıtlanmamıştı. Kullanıcının "sürükleyemiyorum"
 * diyebileceği tam olarak bu boşluktu.
 *
 * KURAL (docs/review-gate.md §3): yalnız page.mouse.*. Sentetik pointer olayı
 * yok — zaten setPointerCapture sentetik olayda patlar, bu projede bir kez
 * yaşandı.
 *
 * Ön koşul: GERÇEK medya. Sürükleme kaynağı yalnız `status === 'ready'` asset
 * için açılır (LibraryPanel/useAssetDragSource) ve 'ready' rozetini yazan tek
 * şey worker'ın gerçek ffprobe/transcode çıktısıdır — sahte asset ile bu jest
 * test EDİLEMEZ.
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/test';
import { EditorApp } from './support/editor';
import { LibraryPanelHarness } from './support/library';
import { ensureTestVideo, FFMPEG_SKIP_REASON, ffmpegVersion } from './support/media';
import { createEmptyProject } from './support/projects';
import { NEW_TRACK_ZONE_H, RULER_H, TRACK_GAP, TRACK_H } from '../src/features/timeline/geometry';

/** Kaynak projesinin kare süresi (30 fps) — ızgara toleransı için. */
const FRAME_US = 1_000_000 / 30;

/**
 * Sürükleme sırasında imleci takip eden hayalet kart (LibraryDragGhost).
 *
 * `data-testid` yok, o yüzden DAVRANIŞINDAN bulunur: konumu `fixed`, metninde
 * dosya adı geçiyor ve içinde başka <div> barındırmıyor (kart yalnız iki
 * <span> içerir — kitaplık satırının kendisi bu üç şartı birden sağlamaz).
 */
async function dragGhostBox(
  page: Page,
  fileName: string,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return page.evaluate((name) => {
    for (const el of document.querySelectorAll<HTMLElement>('div')) {
      if (getComputedStyle(el).position !== 'fixed') continue;
      if (!el.textContent?.includes(name)) continue;
      if (el.querySelector('div')) continue;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    }
    return null;
  }, fileName);
}

/** Gerçek medyayı yükleyip 'ready' olana kadar bekler; editörü açık bırakır. */
async function editorWithReadyAsset(
  page: Page,
  account: { context: { request: import('@playwright/test').APIRequestContext }; accessToken: string; email: string; password: string },
  label: string,
) {
  const video = ensureTestVideo();
  const project = await createEmptyProject(account.context.request, account.accessToken, label);
  const app = new EditorApp(page);
  await app.open(project.projectId, { email: account.email, password: account.password });
  const library = new LibraryPanelHarness(page);
  await library.pickFiles([video.path]);
  await library.waitForReady(video.fileName);
  return { app, library, video, project };
}

/** Kitaplık satırının sol tarafı (Sticker/rozet düğmelerinden uzak yakalama noktası). */
async function grabPoint(library: LibraryPanelHarness, fileName: string) {
  const box = await library.row(fileName).boundingBox();
  expect(box, `Kitaplıkta "${fileName}" satırı görünmüyor.`).not.toBeNull();
  return { x: box!.x + 40, y: box!.y + box!.height / 2 };
}

test.describe('Kitaplık -> timeline sürükle-bırak (gerçek fare)', () => {
  test('sürüklenen asset BIRAKILAN zamana ve BIRAKILAN track\'e eklenir (çift tıkla aynı yer DEĞİL)', async ({
    page,
    account,
  }) => {
    test.skip(ffmpegVersion() === null, FFMPEG_SKIP_REASON);
    test.setTimeout(300_000);

    const { app, library, video, project } = await editorWithReadyAsset(page, account, 'E2E dnd');

    const before = await app.state();
    expect(before.clipCount, 'Test klipsiz bir projede başlamalı.').toBe(0);
    const signatureBefore = await app.timeline.bodySignature();

    // Bırakma hedefi: playhead'den (0) UZAK bir zaman. Çift tık yolu klibi
    // playhead'e koyar; sürükleme yolu BIRAKILAN yere koymalı — testin ayırt
    // ediciliği buna dayanıyor.
    const DROP_TIME_US = 3_000_000;
    const from = await grabPoint(library, video.fileName);
    const to = await app.timeline.point(DROP_TIME_US, 0, before);

    // --- gerçek jest: bas, eşiği aş, timeline'a taşı, bırak ---
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    // useAssetDragSource 5 px'lik bir eşik uygular: eşiğin ALTINDA kalan
    // hareket sürükleme SAYILMAZ (tıklama/çift tık bozulmasın diye).
    await page.mouse.move(from.x + 3, from.y, { steps: 2 });
    // OLUMSUZ iddia -> beklemek ŞART: yanlışlıkla başlamış bir sürüklemenin
    // boyanmaya fırsatı olmalı, yoksa test yarışı kazanıp bedavaya yeşillenir.
    await page.waitForTimeout(200);
    expect(
      await dragGhostBox(page, video.fileName),
      '5 px eşiğinin ALTINDA hayalet kart çıktı — eşik çalışmıyor, basit bir tık sürüklemeye dönüşür.',
    ).toBeNull();

    await page.mouse.move(from.x + 24, from.y + 6, { steps: 4 });
    // OLUMLU iddia -> yoklama: yavaş bir koşucuda tek okuma render'dan önce
    // düşebilir (CI runner'ları bu makineden belirgin yavaş).
    await expect
      .poll(() => dragGhostBox(page, video.fileName), {
        timeout: 5_000,
        message: 'Eşik aşıldı ama sürükleme hayaleti görünmedi.',
      })
      .not.toBeNull();
    const ghost = await dragGhostBox(page, video.fileName);
    expect(
      Math.hypot(ghost!.x - (from.x + 24), ghost!.y - (from.y + 6)),
      `Hayalet kart imlecin yanında değil (kart: ${ghost!.x},${ghost!.y}).`,
    ).toBeLessThan(60);

    await page.mouse.move(to.x - 80, to.y, { steps: 8 });
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.waitForTimeout(150);

    // Timeline sürükleme SIRASINDA tepki veriyor mu? (ekleme hayaleti gövde
    // canvas'ına çizilir — DOM'da göstergesi yok, piksel imzası tek kanıt.)
    expect(
      await app.timeline.bodySignature(),
      'Asset timeline üzerindeyken gövde canvas\'ı hiç değişmedi: ekleme hayaleti çizilmiyor, ' +
        'kullanıcı klibin NEREYE düşeceğini göremiyor.',
    ).not.toBe(signatureBefore);

    await page.mouse.up();

    await expect
      .poll(async () => (await app.state()).clipCount, {
        timeout: 10_000,
        message: 'Sürükleyip bırakma sonrası timeline\'a klip EKLENMEDİ.',
      })
      .toBe(1);

    // --- bırakma KONUMU gerçekten dikkate alındı mı? ---
    const after = await app.state();
    const track = after.tracks.find((t) => t.id === project.trackId);
    expect(track, 'Klip, bırakılan track yerine başka bir track\'e düştü.').toBeTruthy();
    expect(track!.clips).toHaveLength(1);

    const clip = track!.clips[0];
    expect(clip.kind).toBe('video');
    // Tolerans: bir kare (ızgara yuvarlaması) + 2 px'lik imleç belirsizliği.
    const toleranceUs = FRAME_US + 2 / after.pxPerUs;
    expect(
      Math.abs(clip.timelineStartUs - DROP_TIME_US),
      `Klip ${clip.timelineStartUs} µs'de başladı, beklenen ~${DROP_TIME_US} µs. ` +
        (clip.timelineStartUs < toleranceUs
          ? 'Klip playhead\'e (0) kondu: bırakma KONUMU yok sayılmış, sürükleme yolu çift tık ' +
            'yoluna düşmüş demektir.'
          : 'Bırakma konumu ile eklenen konum tutmuyor.'),
    ).toBeLessThanOrEqual(toleranceUs);

    // Süre kaynağın gerçek süresinden gelir (4 sn ± 1 kare).
    expect(Math.abs(clip.timelineDurationUs - 4_000_000)).toBeLessThanOrEqual(FRAME_US + 1);

    // Jest bitti: hayalet kart temizlendi.
    await expect
      .poll(() => dragGhostBox(page, video.fileName), {
        timeout: 5_000,
        message: 'Bırakmadan sonra sürükleme hayaleti ekranda kaldı.',
      })
      .toBeNull();
  });

  test('timeline DIŞINDA bırakmak hiçbir şey eklemez (jest sessizce iptal olur)', async ({
    page,
    account,
  }) => {
    test.skip(ffmpegVersion() === null, FFMPEG_SKIP_REASON);
    test.setTimeout(300_000);

    const { app, library, video } = await editorWithReadyAsset(page, account, 'E2E dnd iptal');

    const before = await app.state();
    expect(before.clipCount).toBe(0);

    const from = await grabPoint(library, video.fileName);
    // ÖNCE gerçekten timeline'ın üzerine götür (jest canlı ve hedef geçerli),
    // SONRA kitaplığa geri dönüp orada bırak. Böylece test "hiçbir şey olmadı"
    // ile "bırakma sınırı doğru çalıştı"yı birbirinden ayırır.
    const overTimeline = await app.timeline.point(3_000_000, 0, before);

    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 24, from.y + 6, { steps: 4 });
    await page.mouse.move(overTimeline.x, overTimeline.y, { steps: 10 });
    await expect
      .poll(() => dragGhostBox(page, video.fileName), {
        timeout: 5_000,
        message:
          'Timeline üzerindeyken sürükleme hayaleti yok — jest canlı değil, testin geri kalanı anlamsız olurdu.',
      })
      .not.toBeNull();

    // Geri kitaplığa (timeline'ın tamamen dışı) ve orada bırak.
    await page.mouse.move(from.x, from.y, { steps: 10 });
    await page.mouse.up();
    // Bırakma işleyicisi pointerup ile EŞ ZAMANLI çalışır; bu bekleme yanlışlıkla
    // eklenmiş bir klibin dokümana yazılmasına fırsat tanımak içindir.
    await page.waitForTimeout(600);

    expect(
      (await app.state()).clipCount,
      'Timeline DIŞINDA bırakılan asset yine de timeline\'a eklendi.',
    ).toBe(0);
    await expect
      .poll(() => dragGhostBox(page, video.fileName), {
        timeout: 5_000,
        message: 'İptal edilen sürüklemenin hayalet kartı ekranda kaldı.',
      })
      .toBeNull();
  });

  test('son track\'in ALTINA bırakmak YENİ track açar ve klibi oraya koyar', async ({
    page,
    account,
  }) => {
    test.skip(ffmpegVersion() === null, FFMPEG_SKIP_REASON);
    test.setTimeout(300_000);

    const { app, library, video, project } = await editorWithReadyAsset(
      page,
      account,
      'E2E dnd yeni track',
    );

    const before = await app.state();
    expect(before.tracks, 'Test tek track\'li bir projede başlamalı.').toHaveLength(1);

    const from = await grabPoint(library, video.fileName);
    const wrap = await app.timeline.wrapBox();
    // "Yeni track" bölgesi: son satırın altındaki NEW_TRACK_ZONE_H yüksekliğinde
    // şerit (geometry.trackIndexAtY -> 'new'). Ortasını hedefle.
    const to = {
      x: wrap.x + (2_000_000 - before.scrollUs) * before.pxPerUs,
      y: wrap.y + RULER_H + (TRACK_H + TRACK_GAP) + NEW_TRACK_ZONE_H / 2,
    };

    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 24, from.y + 6, { steps: 4 });
    await page.mouse.move(to.x, to.y, { steps: 12 });
    await page.waitForTimeout(150);
    await page.mouse.up();

    await expect
      .poll(async () => (await app.state()).tracks.length, {
        timeout: 10_000,
        message: '"Yeni track" bölgesine bırakma yeni bir track açmadı.',
      })
      .toBe(2);

    const after = await app.state();
    expect(after.clipCount, 'Yeni track açıldı ama klip eklenmedi.').toBe(1);
    const original = after.tracks.find((t) => t.id === project.trackId);
    expect(original?.clips, 'Klip yeni track yerine mevcut track\'e düştü.').toHaveLength(0);
    const created = after.tracks.find((t) => t.id !== project.trackId);
    expect(created?.type).toBe('video');
    expect(created?.clips).toHaveLength(1);
  });
});
