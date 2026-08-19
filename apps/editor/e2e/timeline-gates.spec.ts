/**
 * Denetim bulgularının GERÇEK GİRDİ kanıtı (docs/review-gate.md kural 3).
 *
 * Buradaki her etkileşim `page.mouse` / `page.keyboard` iledir; store yalnızca
 * DOĞRULAMA için okunur. Kapsanan bulgular:
 *
 *  1 (KRİTİK) undo/redo/jumpTo kilit + 409 çakışma kapılarını atlıyordu.
 *  2 (yüksek) Sağ tık menüsü açıkken global kısayollar çalışıyordu.
 *  3 (yüksek) Menü, op'un reddedeceği eylemi aktif gösteriyordu ("Çoğalt").
 *  4 (yüksek) Menü içeriği canlı playhead ile üretiliyordu (bayatlıyordu).
 *  5 (yüksek) Orta tuş pan'inin üst sınırı yoktu -> "boş timeline".
 */
import { test, expect } from './fixtures/test';
import { findClip } from './support/appBridge';
import { SECOND_US, SEED_TIMES, buildSeedDoc, getProject, saveTimeline } from './fixtures/seed';

/** Menü öğesinin BUTONU (metin span'i değil) — disabled durumu için gerekli. */
function menuItem(editor: { contextMenu: import('@playwright/test').Locator }, name: RegExp) {
  return editor.contextMenu.getByRole('menuitem').filter({ hasText: name }).first();
}

test.describe('Sağ tık menüsü açıkken klavye (bulgu 2 + 4)', () => {
  test.beforeEach(async ({ editor, seed }) => {
    await editor.ensureContentVisible(seed.clipAId);
  });

  test('menü açıkken Delete / c / ArrowDown dokümanı ve playhead\'i DEĞİŞTİRMEZ', async ({
    editor,
    seed,
  }) => {
    // Playhead'i klibin ortasına gerçek fareyle götür (bu tuşların hepsi
    // menü kapalıyken burada iş yapardı: Delete siler, c böler, ↓ playhead'i atlatır).
    const clipA = findClip(await editor.state(), seed.clipAId).clip;
    const midUs = clipA.timelineStartUs + Math.round(clipA.timelineDurationUs / 2);
    await editor.timeline.scrubTo(midUs);

    const before = await editor.state();
    expect(before.playheadUs).toBeGreaterThan(clipA.timelineStartUs);
    expect(before.playheadUs).toBeLessThan(clipA.timelineStartUs + clipA.timelineDurationUs);

    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId, before), 'right');
    await expect(editor.contextMenu).toBeVisible();

    // GERÇEK klavye — menü açıkken hiçbiri geçmemeli.
    for (const k of ['Delete', 'c', 'ArrowDown', 'ArrowRight', 'm', 'Control+d']) {
      await editor.page.keyboard.press(k);
      await editor.page.waitForTimeout(60);
    }

    const after = await editor.state();
    expect(after.clipCount, 'menü açıkken Delete/c doküman değiştirmemeli').toBe(before.clipCount);
    expect(after.playheadUs, 'menü açıkken ok tuşları playhead\'i oynatmamalı').toBe(
      before.playheadUs,
    );
    expect(after.historyLabels, 'menü açıkken hiçbir işlem kaydedilmemeli').toEqual(
      before.historyLabels,
    );
    await expect(editor.contextMenu, 'menü hâlâ açık olmalı').toBeVisible();

    // Menü kapanınca kısayollar geri gelir (kapı kalıcı susturma değil).
    await editor.page.keyboard.press('Escape');
    await expect(editor.contextMenu).toBeHidden();
    await editor.page.keyboard.press('ArrowDown');
    await editor.page.waitForTimeout(120);
    expect((await editor.state()).playheadUs).not.toBe(before.playheadUs);
  });

  test('menü, açıldığı andaki playhead ile tutarlı kalır: "Playhead\'de böl" o noktada böler', async ({
    editor,
    seed,
  }) => {
    const clipA = findClip(await editor.state(), seed.clipAId).clip;
    const midUs = clipA.timelineStartUs + Math.round(clipA.timelineDurationUs / 2);
    await editor.timeline.scrubTo(midUs);

    const opened = await editor.state();
    const frozenPlayhead = opened.playheadUs;

    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId, opened), 'right');
    await expect(editor.contextMenu).toBeVisible();

    // Menü açıkken playhead'i klip dışına ATMAYA çalış (bulgu 4'ün senaryosu).
    for (let i = 0; i < 3; i++) await editor.page.keyboard.press('ArrowDown');
    await editor.page.waitForTimeout(120);
    expect((await editor.state()).playheadUs, 'menü açıkken playhead donmuş kalmalı').toBe(
      frozenPlayhead,
    );

    const splitItem = menuItem(editor, /playhead.?de b[öo]l/i);
    await expect(splitItem, '"Playhead\'de böl" aktif kalmalı').toBeEnabled();
    await splitItem.click();
    await editor.page.waitForTimeout(200);

    const after = await editor.state();
    expect(after.clipCount).toBe(opened.clipCount + 1);
    // Kesme MENÜNÜN gösterdiği yerde: yeni klip donmuş playhead'de başlar.
    const starts = after.tracks.flatMap((t) => t.clips.map((c) => c.timelineStartUs));
    const nearFrozen = starts.some((s) => Math.abs(s - frozenPlayhead) <= 34_000); // 1 kare tolerans
    expect(nearFrozen, `kesme noktası ${frozenPlayhead} civarında olmalı, bulunan: ${starts}`).toBe(
      true,
    );
  });
});

test.describe('Menü, op\'un reddedeceği eylemi teklif etmez (bulgu 3)', () => {
  test('bitişik komşusu olan klipte "Çoğalt" GRİ, uzakken aktif', async ({ editor, seed }) => {
    await editor.ensureContentVisible(seed.clipAId);

    // Önce durum "yer var": clipA sonrası 66-76 s boş -> kopya (66-72) sığar.
    let state = await editor.state();
    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId, state), 'right');
    await expect(editor.contextMenu).toBeVisible();
    await expect(
      menuItem(editor, /çoğalt/i),
      'boşluk varken "Çoğalt" aktif olmalı',
    ).toBeEnabled();
    await editor.page.keyboard.press('Escape');
    await expect(editor.contextMenu).toBeHidden();

    // GERÇEK fareyle clipB'yi clipA'nın hemen arkasına çek -> kopyaya yer kalmaz.
    await editor.timeline.dragClipByTime(seed.clipBId, -(SEED_TIMES.gapEndUs - SEED_TIMES.gapStartUs));
    state = await editor.state();
    const clipA = findClip(state, seed.clipAId).clip;
    const clipB = findClip(state, seed.clipBId).clip;
    expect(
      clipB.timelineStartUs,
      'clipB, clipA kopyasının ineceği aralığa girmiş olmalı',
    ).toBeLessThan(clipA.timelineStartUs + 2 * clipA.timelineDurationUs);

    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId, state), 'right');
    await expect(editor.contextMenu).toBeVisible();
    await expect(
      menuItem(editor, /çoğalt/i),
      'kopyaya yer yokken "Çoğalt" GRİ olmalı (op zaten reddediyor)',
    ).toBeDisabled();

    // Gri öğe tıklanınca doküman değişmez ve uyarı balonu da çıkmaz.
    const before = await editor.state();
    await menuItem(editor, /çoğalt/i).click({ force: true }).catch(() => {});
    await editor.page.waitForTimeout(200);
    const after = await editor.state();
    expect(after.clipCount).toBe(before.clipCount);
    expect(after.historyLabels).toEqual(before.historyLabels);
  });
});

test.describe('Orta tuş pan\'i içeriği ekrandan atamaz (bulgu 5)', () => {
  test('ne kadar sürüklenirse sürüklensin son klip görünür alandan çıkmaz', async ({
    editor,
    seed,
  }) => {
    await editor.ensureContentVisible(seed.clipAId);
    const wrap = await editor.timeline.wrapBox();
    const y = wrap.y + wrap.height / 2;

    // Altı agresif orta-tuş sürüklemesi (denetimde ölçülen jest dizisi).
    for (let i = 0; i < 6; i++) {
      await editor.timeline.drag(
        { x: wrap.x + wrap.width - 20, y },
        { x: wrap.x + 20, y },
        'middle',
      );
    }

    const state = await editor.state();
    const contentEndX = wrap.x + (SEED_TIMES.contentEndUs - state.scrollUs) * state.pxPerUs;
    expect(
      contentEndX,
      `içerik sonu ekranın solunda kaldı (scrollUs=${state.scrollUs})`,
    ).toBeGreaterThan(wrap.x);
    expect(contentEndX).toBeLessThanOrEqual(wrap.x + wrap.width + 1);

    // Son klip gerçekten görünür alanla KESİŞİYOR.
    const box = await editor.timeline.clipBox(seed.clipBId, state);
    expect(box.x, 'son klip sağa taşmamalı').toBeLessThan(wrap.x + wrap.width);
    expect(box.x + box.width, 'son klip sola kaçmamalı').toBeGreaterThan(wrap.x);
  });

  test('Shift+wheel yolu da aynı sınıra tabidir', async ({ editor, seed }) => {
    await editor.ensureContentVisible(seed.clipAId);
    const wrap = await editor.timeline.wrapBox();

    for (let i = 0; i < 8; i++) await editor.timeline.shiftWheel(4000);
    await editor.page.waitForTimeout(150);

    const state = await editor.state();
    const contentEndX = wrap.x + (SEED_TIMES.contentEndUs - state.scrollUs) * state.pxPerUs;
    expect(contentEndX).toBeGreaterThan(wrap.x);
    const box = await editor.timeline.clipBox(seed.clipBId, state);
    expect(box.x).toBeLessThan(wrap.x + wrap.width);
    expect(box.x + box.width).toBeGreaterThan(wrap.x);
  });
});

test.describe('409 çakışma diyaloğu açıkken geçmişte gezinme (bulgu 1)', () => {
  test('Ctrl+Z dokümanı değiştirmez; Geri al ve geçmiş satırları devre dışı', async ({
    editor,
    seed,
    account,
  }) => {
    test.skip(seed.external, 'Hazır proje modunda sunucu revizyonu ile oynanmaz.');
    await editor.ensureContentVisible(seed.clipAId);

    // BAŞKA bir istemci projeyi kaydeder -> tarayıcının revizyon tabanı bayatlar.
    const detail = await getProject(account.context.request, account.accessToken, seed.projectId);
    // Rakip kayıt da AYNI asset satırını gösterir: seed'in sözleşmesi gereği
    // doküman kullanıcının kütüphanesindeki bir varlığa bağlıdır (fixtures/seed.ts).
    expect(seed.assetId, 'Seed asset satırı kurulmamış (hazır proje modu mu?).').not.toBeNull();
    const fresh = buildSeedDoc(seed.projectId, seed.assetId!);
    await saveTimeline(
      account.context.request,
      account.accessToken,
      seed.projectId,
      fresh.timeline,
      detail.revisionNumber,
    );

    // Bu sekmede GERÇEK fareyle bir düzenleme -> autosave 409 alır.
    await editor.timeline.dragClipByTime(seed.clipAId, 2 * SECOND_US);
    const movedStart = findClip(await editor.state(), seed.clipAId).clip.timelineStartUs;

    const dialog = editor.page.getByRole('alertdialog');
    await expect(dialog, 'autosave 409 -> çakışma diyaloğu bekleniyor').toBeVisible({
      timeout: 30_000,
    });

    // Kapılar: TopBar düğmeleri ve geçmiş satırları kapalı olmalı.
    await expect(editor.undoButton, 'çakışma açıkken Geri al devre dışı olmalı').toBeDisabled();
    await editor.openHistoryPanel();
    await expect(
      editor.historyEntry(0),
      'çakışma açıkken geçmiş satırları devre dışı olmalı',
    ).toBeDisabled();

    // GERÇEK klavye: Ctrl+Z doküman mutasyonudur, geçmemeli.
    for (let i = 0; i < 3; i++) {
      await editor.page.keyboard.press('Control+z');
      await editor.page.waitForTimeout(80);
    }
    await editor.page.keyboard.press('Control+y');
    await editor.page.waitForTimeout(120);

    const after = await editor.state();
    expect(
      findClip(after, seed.clipAId).clip.timelineStartUs,
      'çakışma diyaloğu açıkken Ctrl+Z dokümanı değiştirmemeli',
    ).toBe(movedStart);
    await expect(dialog).toBeVisible();
  });
});
