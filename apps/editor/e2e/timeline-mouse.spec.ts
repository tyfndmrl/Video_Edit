/**
 * Timeline etkileşimleri — GERÇEK fare olaylarıyla (page.mouse.*).
 *
 * Bu dosyadaki her jest Chromium'un girdi hattından geçer: pointer capture,
 * buton maskesi, wheel modifier'ları, sürükleme eşiği... hepsi gerçek. Store
 * yalnızca SONUCU doğrulamak için okunur.
 */
import { test, expect } from './fixtures/test';
import { findClip } from './support/appBridge';
import { SECOND_US } from './fixtures/seed';

test.describe('Timeline — gerçek fare', () => {
  test.beforeEach(async ({ editor, seed }) => {
    await editor.ensureContentVisible(seed.clipAId);
  });

  test('klibe tıklayınca seçilir (store + canvas boyaması)', async ({ editor, seed }) => {
    const before = await editor.state();
    expect(before.selection).toEqual([]);
    const signatureBefore = await editor.timeline.bodySignature();

    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId, before));

    const after = await editor.state();
    expect(after.selection).toEqual([seed.clipAId]);
    // Seçim yalnızca canvas'a çiziliyor (DOM göstergesi yok): timeline'ın
    // GERÇEKTEN yeniden boyandığını piksel imzasından doğrula.
    expect(
      await editor.timeline.bodySignature(),
      'Seçim sonrası timeline canvas\'ı yeniden boyanmadı (seçim çerçevesi çizilmiyor?).',
    ).not.toBe(signatureBefore);
  });

  test('boş alana sürüklenen klip taşınır (timelineStartUs değişir)', async ({ editor, seed }) => {
    const before = await editor.state();
    const start0 = findClip(before, seed.clipAId).clip.timelineStartUs;

    // clipA [60s,66s) -> boşluk [66s,76s). +8 sn: [68s,74s), clipB'ye (76s) değmez.
    await editor.timeline.dragClipByTime(seed.clipAId, 8 * SECOND_US);

    const after = await editor.state();
    const moved = findClip(after, seed.clipAId);
    expect(moved.clip.timelineStartUs).toBeGreaterThan(start0);
    expect(after.historyLabels.at(-1)).toMatch(/taşın/i);
  });

  test('dolu alana sürüklenen klip taşınmaz VE kullanıcıya uyarı gösterilir', async ({
    editor,
    seed,
  }) => {
    const before = await editor.state();
    const start0 = findClip(before, seed.clipAId).clip.timelineStartUs;
    const history0 = before.historyLabels.length;

    // +19 sn -> [79s,85s), clipB [76s,82s) ile ÇAKIŞIR (snap eşiğinden uzak).
    await editor.timeline.dragClipByTime(seed.clipAId, 19 * SECOND_US);

    const after = await editor.state();
    expect(
      findClip(after, seed.clipAId).clip.timelineStartUs,
      'Çakışan hedefe bırakılan klip taşınmamalı.',
    ).toBe(start0);
    expect(after.historyLabels.length, 'Reddedilen taşıma history\'ye girmemeli.').toBe(history0);

    await expect(
      editor.warningToast,
      'Çakışma nedeniyle reddedilen taşımada kullanıcıya görünür bir uyarı bekleniyor ' +
        '(sessiz ret kullanıcı şikayetinin ta kendisiydi).',
    ).toBeVisible();
    await expect(editor.warningToast).toContainText(/çakış/i);
  });

  test('kenardan sürüklemek klibi kırpar (süre değişir)', async ({ editor, seed }) => {
    const before = await editor.state();
    const duration0 = findClip(before, seed.clipAId).clip.timelineDurationUs;

    await editor.timeline.dragRightEdgeByTime(seed.clipAId, -3 * SECOND_US);

    const after = await editor.state();
    const trimmed = findClip(after, seed.clipAId).clip;
    expect(trimmed.timelineDurationUs).toBeLessThan(duration0);
    expect(trimmed.timelineStartUs).toBe(findClip(before, seed.clipAId).clip.timelineStartUs);
    expect(after.historyLabels.at(-1)).toMatch(/kırp/i);
  });

  test('klibi alt track\'e sürüklemek katman değiştirir', async ({ editor, seed }) => {
    const before = await editor.state();
    expect(findClip(before, seed.clipAId).trackIndex).toBe(0);

    await editor.timeline.dragClipByTime(seed.clipAId, 0, 1);

    const after = await editor.state();
    expect(findClip(after, seed.clipAId).trackIndex).toBe(1);
  });

  test('Ctrl+Z gerçek fareyle yapılan taşımayı geri alır', async ({ editor, seed }) => {
    const before = await editor.state();
    const start0 = findClip(before, seed.clipAId).clip.timelineStartUs;

    await editor.timeline.dragClipByTime(seed.clipAId, 8 * SECOND_US);
    const moved = await editor.state();
    expect(findClip(moved, seed.clipAId).clip.timelineStartUs).not.toBe(start0);

    await editor.page.keyboard.press('Control+z');
    await editor.page.waitForTimeout(120);

    const undone = await editor.state();
    expect(findClip(undone, seed.clipAId).clip.timelineStartUs).toBe(start0);
    expect(undone.cursor).toBe(before.cursor);
  });

  test('Ctrl+wheel zoom seviyesini değiştirir', async ({ editor }) => {
    const before = await editor.state();

    await editor.timeline.ctrlWheel(-120);
    const zoomedIn = await editor.state();
    expect(zoomedIn.pxPerUs).toBeGreaterThan(before.pxPerUs);

    await editor.timeline.ctrlWheel(240);
    const zoomedOut = await editor.state();
    expect(zoomedOut.pxPerUs).toBeLessThan(zoomedIn.pxPerUs);
  });

  test('orta tuşla sürüklemek timeline\'ı kaydırır (pan)', async ({ editor }) => {
    // Kaydırma payı olsun diye önce yakınlaştır (scrollUs 0'da kırpılır).
    await editor.timeline.ctrlWheel(-120);
    await editor.timeline.ctrlWheel(-120);
    const before = await editor.state();

    const center = await editor.timeline.centerOfBody();
    // "Grab" modeli (features/timeline/pan.ts): imleç SOLA giderse daha GEÇ
    // zaman görünür -> scrollUs artar.
    await editor.timeline.drag(center, { x: center.x - 200, y: center.y }, 'middle');
    const panned = await editor.state();
    expect(
      panned.scrollUs,
      'Orta tuşla (middle-drag) sola sürükleme scrollUs\'u artırmalı.',
    ).toBeGreaterThan(before.scrollUs);

    // Ters yön geri getirir.
    await editor.timeline.drag(center, { x: center.x + 200, y: center.y }, 'middle');
    const back = await editor.state();
    expect(back.scrollUs).toBeLessThan(panned.scrollUs);
  });

  test('Shift+wheel yatay kaydırır', async ({ editor }) => {
    await editor.timeline.ctrlWheel(-120);
    const before = await editor.state();

    await editor.timeline.shiftWheel(240);
    const after = await editor.state();

    expect(after.scrollUs).toBeGreaterThan(before.scrollUs);
  });
});
