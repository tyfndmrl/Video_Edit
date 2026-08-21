/**
 * Track yeniden sıralama + adlandırma — GERÇEK fare/klavye ile.
 *
 * Sözleşmeler:
 *  - tracks[0] = EN ÜST katman (şema + export render sırası); "Aşağı taşı"
 *    dizide bir indeks ileri gider. Katman sırasının export'a yansıdığı
 *    kanıtı editör tarafında timelineOps.test.ts (resolveVisualStack) ve
 *    derleyici tarafında reorder filtergraph karşılaştırmasıyla ayrıca
 *    sabitlendi; bu dosya UI yolunu (sağ tık menüsü) gerçek fareyle sınar.
 *  - Yeniden adlandırma başlığa çift tıkla açılır, Enter kaydeder, Escape
 *    vazgeçer; kural op'unkidir (kilitli track'te açılmaz).
 *  - NEGATİF: en üst track'te "Yukarı taşı" menüde GRİDİR ve gerekçesi
 *    op'un ret koduyla birebir aynıdır — tıklanamaz, doküman değişmez.
 */
import { test, expect } from './fixtures/test';

test.describe('Track yönetimi (sağ tık menüsü + satır içi ad)', () => {
  test.beforeEach(async ({ editor, seed }) => {
    await editor.ensureContentVisible(seed.clipAId);
  });

  function headerOf(editor: { page: import('@playwright/test').Page }, trackId: string) {
    return editor.page.locator(`[data-testid="track-header"][data-track-id="${trackId}"]`);
  }

  test('"Aşağı taşı" gerçek fareyle track sırasını değiştirir ve geri alınabilir', async ({
    editor,
    seed,
  }) => {
    const before = await editor.state();
    expect(before.tracks.map((t) => t.id)).toEqual([seed.trackTopId, seed.trackBottomId]);

    const box = await headerOf(editor, seed.trackTopId).boundingBox();
    expect(box, 'track başlığı DOM sütununda görünür olmalı').not.toBeNull();
    await editor.timeline.click({ x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }, 'right');
    await expect(editor.contextMenu).toBeVisible();

    await editor.page.getByTestId('timeline-menu-moveTrackDown').click();
    await editor.page.waitForTimeout(120);

    const after = await editor.state();
    expect(after.tracks.map((t) => t.id)).toEqual([seed.trackBottomId, seed.trackTopId]);
    expect(after.historyLabels.at(-1)).toBe('Track aşağı taşındı');
    // Klipler track'leriyle birlikte taşındı; içerik değişmedi.
    expect(after.clipCount).toBe(before.clipCount);

    // Geri al: sıra ilk haline döner (tek geçmiş girdisi).
    await editor.page.keyboard.press('Control+z');
    await editor.page.waitForTimeout(120);
    const undone = await editor.state();
    expect(undone.tracks.map((t) => t.id)).toEqual([seed.trackTopId, seed.trackBottomId]);
  });

  test('NEGATİF: en üst track için "Yukarı taşı" gridir ve doküman değişmez', async ({
    editor,
    seed,
  }) => {
    const before = await editor.state();
    expect(before.tracks[0].id).toBe(seed.trackTopId);

    const box = await headerOf(editor, seed.trackTopId).boundingBox();
    await editor.timeline.click({ x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }, 'right');
    await expect(editor.contextMenu).toBeVisible();

    const up = editor.page.getByTestId('timeline-menu-moveTrackUp');
    await expect(up).toBeDisabled();
    // Gri öğenin gerekçesi op'un ret kodudur (menü sözleşmesi).
    await expect(up).toHaveAttribute('data-block-reason', 'track already at the top');
    // Aşağı taşı aynı menüde AÇIK — menü aşırı kısıtlamıyor.
    await expect(editor.page.getByTestId('timeline-menu-moveTrackDown')).toBeEnabled();

    await editor.page.keyboard.press('Escape');
    await expect(editor.contextMenu).toBeHidden();

    const after = await editor.state();
    expect(after.tracks.map((t) => t.id)).toEqual(before.tracks.map((t) => t.id));
    expect(after.historyLabels).toEqual(before.historyLabels);
  });

  test('çift tık + gerçek klavye: track adı yazılır, Enter kaydeder, undo geri alır', async ({
    editor,
    seed,
  }) => {
    const header = headerOf(editor, seed.trackBottomId);
    const nameSpan = header.getByTestId('track-name');
    const box = await nameSpan.boundingBox();
    expect(box).not.toBeNull();

    await editor.page.mouse.dblclick(box!.x + Math.min(20, box!.width / 2), box!.y + box!.height / 2);
    const input = editor.page.getByTestId('track-rename-input');
    await expect(input).toBeVisible();

    await editor.page.keyboard.type('Müzik katmanı');
    await editor.page.keyboard.press('Enter');
    await expect(input).toBeHidden();

    const after = await editor.state();
    const renamed = after.tracks.find((t) => t.id === seed.trackBottomId);
    expect(renamed?.name).toBe('Müzik katmanı');
    expect(after.historyLabels.at(-1)).toBe('Track yeniden adlandırıldı');
    await expect(header.getByTestId('track-name')).toHaveText('Müzik katmanı');

    // Undo, seed'in verdiği ada ('V2') geri döner — tek geçmiş girdisi.
    await editor.page.keyboard.press('Control+z');
    await editor.page.waitForTimeout(120);
    const undone = await editor.state();
    expect(undone.tracks.find((t) => t.id === seed.trackBottomId)?.name).toBe('V2');
    await expect(header.getByTestId('track-name')).toHaveText('V2');
  });

  test('Escape yeniden adlandırmayı İPTAL eder — op hiç çağrılmaz', async ({ editor, seed }) => {
    const before = await editor.state();
    const nameSpan = headerOf(editor, seed.trackTopId).getByTestId('track-name');
    const box = await nameSpan.boundingBox();
    await editor.page.mouse.dblclick(box!.x + Math.min(20, box!.width / 2), box!.y + box!.height / 2);
    const input = editor.page.getByTestId('track-rename-input');
    await expect(input).toBeVisible();

    await editor.page.keyboard.type('vazgeçilecek ad');
    await editor.page.keyboard.press('Escape');
    await expect(input).toBeHidden();

    const after = await editor.state();
    // Ad seed'in verdiği değerde ('V1') kalır; geçmişe hiçbir girdi düşmez.
    expect(after.tracks.find((t) => t.id === seed.trackTopId)?.name).toBe('V1');
    expect(after.historyLabels).toEqual(before.historyLabels);
  });

  test('yeniden adlandırma girişinde kısayol tuşları klibe SIZMAZ (c yazmak bölmez)', async ({
    editor,
    seed,
  }) => {
    const before = await editor.state();
    const nameSpan = headerOf(editor, seed.trackTopId).getByTestId('track-name');
    const box = await nameSpan.boundingBox();
    await editor.page.mouse.dblclick(box!.x + Math.min(20, box!.width / 2), box!.y + box!.height / 2);
    await expect(editor.page.getByTestId('track-rename-input')).toBeVisible();

    // 'c' timeline'da "playhead'de böl" kısayoludur; input açıkken metindir.
    await editor.page.keyboard.type('cccc');
    await editor.page.keyboard.press('Enter');
    await editor.page.waitForTimeout(120);

    const after = await editor.state();
    expect(after.clipCount, 'kısayol sızsaydı klip sayısı artardı').toBe(before.clipCount);
    expect(after.tracks.find((t) => t.id === seed.trackTopId)?.name).toBe('cccc');
  });
});
