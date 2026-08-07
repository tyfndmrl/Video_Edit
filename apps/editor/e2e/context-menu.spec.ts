/**
 * Sağ tık (context) menüsü — kullanıcının "sağ tık çalışmıyor" şikayeti.
 *
 * Teşhis: TimelinePanel'in canvas sarmalayıcısında onContextMenu prop'u bile
 * yoktu; tarayıcının kendi menüsü açılıyordu. Beklenen: canvas üstünde DOM
 * overlay bir menü (design 01 §3.1: "DOM overlay: context menu, ...").
 */
import { test, expect } from './fixtures/test';
import { findClip } from './support/appBridge';

test.describe('Timeline sağ tık menüsü', () => {
  test.beforeEach(async ({ editor, seed }) => {
    await editor.ensureContentVisible(seed.clipAId);
  });

  test('klip üzerinde sağ tık menüyü açar', async ({ editor, seed }) => {
    const state = await editor.state();
    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId, state), 'right');

    await expect(
      editor.contextMenu,
      'Sağ tıkta timeline context menüsü bekleniyor ([data-testid="timeline-context-menu"] veya [role="menu"]).',
    ).toBeVisible();
  });

  test('sağ tık > "Playhead\'de böl" klip sayısını artırır', async ({ editor, seed }) => {
    const before = await editor.state();
    const clipA = findClip(before, seed.clipAId).clip;

    // Playhead'i klibin ortasına GERÇEK fareyle taşı (cetvele tıklama = scrub).
    const midUs = clipA.timelineStartUs + Math.round(clipA.timelineDurationUs / 2);
    await editor.timeline.scrubTo(midUs);

    const afterScrub = await editor.state();
    expect(
      afterScrub.playheadUs,
      'Cetvele tıklamak playhead\'i klibin içine taşımalı.',
    ).toBeGreaterThan(clipA.timelineStartUs);
    expect(afterScrub.playheadUs).toBeLessThan(
      clipA.timelineStartUs + clipA.timelineDurationUs,
    );

    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId, afterScrub), 'right');
    await expect(editor.contextMenu).toBeVisible();

    // "Playhead'de böl" — kısayol listesindeki (shortcutsHelp.ts) etiketle aynı.
    await editor.contextMenuItem(/playhead.?de b[öo]l/i).click();
    await editor.page.waitForTimeout(150);

    const after = await editor.state();
    expect(after.clipCount, 'Bölme sonrası klip sayısı 1 artmalı.').toBe(before.clipCount + 1);
    expect(after.historyLabels.at(-1)).toMatch(/böl/i);
  });

  test('menü dışına tıklayınca menü kapanır', async ({ editor, seed }) => {
    const state = await editor.state();
    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId, state), 'right');
    await expect(editor.contextMenu).toBeVisible();

    // Boş alana (kliplerin çok solu) gerçek sol tık.
    const wrap = await editor.timeline.wrapBox();
    await editor.timeline.click({ x: wrap.x + 8, y: wrap.y + 40 });

    await expect(editor.contextMenu).toBeHidden();
  });
});
