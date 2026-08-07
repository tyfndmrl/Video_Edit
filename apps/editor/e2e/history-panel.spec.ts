/**
 * İşlem geçmişi paneli — kullanıcının İLK mesajındaki açık gereksinim
 * ("Undo/Redo ve frontend işlem geçmişi"). docStore.jumpTo hazırdı, UI yoktu.
 *
 * Uygulanan sözleşme (features/history + design 01 §2.3): Inspector içinde
 * DAİMA görünür "İşlem Geçmişi" bölümü, ters kronolojik satırlar (en yeni
 * üstte) ve en altta "Başlangıç" temel satırı; satıra tıklamak jumpTo(index).
 *
 * Buradaki mutasyonlar GERÇEK fare sürüklemeleridir — panel, canvas jestleriyle
 * üretilen history'yi gösterdiğini kanıtlar.
 */
import { test, expect } from './fixtures/test';
import { findClip } from './support/appBridge';
import { SECOND_US } from './fixtures/seed';

test.describe('İşlem geçmişi paneli', () => {
  test.beforeEach(async ({ editor, seed }) => {
    await editor.ensureContentVisible(seed.clipAId);
  });

  test('gerçek fareyle yapılan işlemler panelde listelenir', async ({ editor, seed }) => {
    await editor.openHistoryPanel();
    await expect(
      editor.historyPanel,
      'İşlem geçmişi paneli bekleniyor (Inspector içinde "İşlem Geçmişi" bölümü).',
    ).toBeVisible();
    await expect(editor.historyPanel).toContainText(/henüz işlem yok/i);

    await editor.timeline.dragClipByTime(seed.clipAId, 8 * SECOND_US);
    await editor.timeline.dragRightEdgeByTime(seed.clipAId, -2 * SECOND_US);

    const state = await editor.state();
    expect(state.historyLabels.length, 'İki jest iki history girdisi üretmeli.').toBe(2);

    await expect(editor.historyPanel).toContainText(/taşın/i);
    await expect(editor.historyPanel).toContainText(/kırp/i);
    await expect(editor.historyPanel).toContainText(/başlangıç/i);
  });

  test('"Başlangıç" satırına tıklamak dokümanı jest öncesine götürür', async ({ editor, seed }) => {
    const before = await editor.state();
    const start0 = findClip(before, seed.clipAId).clip.timelineStartUs;
    const duration0 = findClip(before, seed.clipAId).clip.timelineDurationUs;

    await editor.timeline.dragClipByTime(seed.clipAId, 8 * SECOND_US);
    await editor.timeline.dragRightEdgeByTime(seed.clipAId, -2 * SECOND_US);

    const mutated = await editor.state();
    expect(mutated.cursor).toBe(2);
    const startMutated = findClip(mutated, seed.clipAId).clip.timelineStartUs;

    await editor.openHistoryPanel();
    await editor.historyEntryByLabel(/başlangıç/i).click();
    await editor.page.waitForTimeout(150);

    const jumped = await editor.state();
    expect(jumped.cursor, 'jumpTo(-1) cursor\'ı 0\'a çekmeli.').toBe(0);
    const clipBack = findClip(jumped, seed.clipAId).clip;
    expect(clipBack.timelineStartUs).toBe(start0);
    expect(clipBack.timelineDurationUs).toBe(duration0);

    // İleri sarma da aynı panelden: en yeni satıra tıkla -> her iki jest geri gelir.
    await editor.historyEntry(0).click();
    await editor.page.waitForTimeout(150);

    const redone = await editor.state();
    expect(redone.cursor).toBe(2);
    expect(findClip(redone, seed.clipAId).clip.timelineStartUs).toBe(startMutated);
  });

  test('TopBar Geri al/Yinele düğmeleri gerçek tıklamayla çalışır', async ({ editor, seed }) => {
    const before = await editor.state();
    const start0 = findClip(before, seed.clipAId).clip.timelineStartUs;

    await editor.timeline.dragClipByTime(seed.clipAId, 8 * SECOND_US);
    const moved = await editor.state();
    const start1 = findClip(moved, seed.clipAId).clip.timelineStartUs;
    expect(start1).not.toBe(start0);

    await editor.undoButton.click();
    await editor.page.waitForTimeout(120);
    expect(findClip(await editor.state(), seed.clipAId).clip.timelineStartUs).toBe(start0);

    await editor.redoButton.click();
    await editor.page.waitForTimeout(120);
    expect(findClip(await editor.state(), seed.clipAId).clip.timelineStartUs).toBe(start1);
  });
});
