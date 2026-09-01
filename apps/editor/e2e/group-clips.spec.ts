/**
 * Klip grupları (groupId) — ozellik-4 (GERÇEK fare/klavye).
 *
 * CapCut davranışı: "Grupla" (Ctrl+G) ile bağlanan klipler taşımada BİRLİKTE
 * hareket eder; "Grubu dağıt" (Ctrl+Shift+G) dokunulan grupları TÜMDEN çözer
 * (üye çıkarma yok — tek üyeli ara durum hiç doğmaz). Silme üye-kapsamlıdır:
 * tek üyeyi silmek grubu silmez; grup 2 üyenin altına düşerse temizlenir.
 * Kapanış OP İÇİNDEDİR (expandSelectionForOp 'move' kapsamı groupId'yi işler).
 *
 * KURAL (docs/review-gate.md §3): yalnız gerçek girdi — marquee/sürükleme
 * page.mouse, kısayollar page.keyboard, menü gerçek sağ tık. Store yalnız
 * DOĞRULAMA için okunur (readAppState.groupId — appBridge alanı taşır).
 *
 * Seed 2 klip verir; üçüncü klip GERÇEK jestle üretilir: playhead klibin
 * ortasına scrub + sağ tık "Playhead'de böl".
 */
import { test, expect } from './fixtures/test';
import { findClip, type AppState } from './support/appBridge';

const SECOND_US = 1_000_000;

function allClips(state: AppState) {
  return state.tracks.flatMap((t) => t.clips);
}

/** Üç üyenin groupId'si: tanımlı ve ÜÇÜNDE AYNI ise o değeri döndürür. */
function commonGroupId(state: AppState, ids: string[]): string | null {
  const groups = ids.map((id) => findClip(state, id).clip.groupId);
  if (groups[0] === undefined) return null;
  return groups.every((g) => g === groups[0]) ? (groups[0] as string) : null;
}

test.describe('Klip grupları — Ctrl+G grupla, grup birlikte taşınır', () => {
  test('böl -> marquee -> Grupla -> üçü birlikte taşınır; tek üye silinir; Ctrl+Shift+G dağıtır; Ctrl+G klavyeden gruplar', async ({
    editor,
    seed,
  }) => {
    test.setTimeout(120_000);
    await editor.ensureContentVisible(seed.clipAId);

    // Üçüncü klibi GERÇEK jestle üret: playhead'i A'nın ortasına scrub et,
    // sağ tık -> "Playhead'de böl".
    let st = await editor.state();
    const clipA = findClip(st, seed.clipAId).clip;
    const midUs = clipA.timelineStartUs + Math.round(clipA.timelineDurationUs / 2);
    await editor.timeline.scrubTo(midUs);
    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId), 'right');
    await expect(editor.contextMenu).toBeVisible();
    await editor.page.getByTestId('timeline-menu-splitAtPlayhead').click();
    await expect
      .poll(async () => (await editor.state()).clipCount, {
        message: 'Bölme üçüncü klibi doğurmalıydı.',
      })
      .toBe(3);

    st = await editor.state();
    const memberIds = allClips(st).map((c) => c.id);
    expect(memberIds).toHaveLength(3);
    const rightHalfId = memberIds.find((id) => id !== seed.clipAId && id !== seed.clipBId)!;
    expect(rightHalfId, 'Bölmeden doğan sağ yarının kimliği bulunamadı.').toBeDefined();

    // (a) Marquee ile ÜÇ klibi seç: boş alandan (alt satır, A'nın solundan)
    // başlayıp B'nin merkezine gerçek fareyle sürükle (kesişim yeter).
    const from = await editor.timeline.point(clipA.timelineStartUs - 2 * SECOND_US, 1, st);
    const to = await editor.timeline.clipCenter(seed.clipBId, st);
    await editor.timeline.drag(from, to);
    st = await editor.state();
    expect(st.selection.sort(), 'Marquee üç klibi de seçmeli.').toEqual([...memberIds].sort());

    // Sağ tık -> "Grupla": üçünde ORTAK taze groupId.
    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId, st), 'right');
    await expect(editor.contextMenu).toBeVisible();
    const groupItem = editor.page.getByTestId('timeline-menu-groupClips');
    await expect(groupItem, 'Üç klip seçiliyken "Grupla" açık olmalı.').toBeEnabled();
    await groupItem.click();
    await expect
      .poll(async () => commonGroupId(await editor.state(), memberIds), {
        message: '"Grupla" üç klibe AYNI groupId\'yi yazmalı.',
      })
      .not.toBeNull();

    // (b) TEK üyeyi gerçek fareyle sürükle -> ÜÇÜ birden kayar (op-içi kapanış).
    // ÖNCE seçim TEKE indirilir (düz tık seçimi daraltır): üçlü marquee seçimi
    // dursaydı taşıma "seçim üzerinden" de yayılırdı ve kapanış kanıtlanmazdı.
    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId, st));
    st = await editor.state();
    expect(st.selection, 'Düz tık seçimi tek üyeye daraltmalı.').toEqual([seed.clipAId]);
    const startsBefore = memberIds.map((id) => findClip(st, id).clip.timelineStartUs);
    await editor.timeline.dragClipByTime(seed.clipAId, 3 * SECOND_US);
    st = await editor.state();
    const deltas = memberIds.map(
      (id, i) => findClip(st, id).clip.timelineStartUs - startsBefore[i],
    );
    expect(deltas[0], 'Sürüklenen üye kaymalı.').toBeGreaterThan(0);
    expect(deltas[1], 'Grup üyesi (sağ yarı) AYNI delta ile kaymalı.').toBe(deltas[0]);
    expect(deltas[2], 'Grup üyesi (B) AYNI delta ile kaymalı.').toBe(deltas[0]);

    // (c) Tek üye seç + Delete -> YALNIZ o gider; kalan İKİLİ grup YAŞAR
    //     (2 üye >= 2 — kural 11 temizliği tetiklenmez).
    await editor.timeline.click(await editor.timeline.clipCenter(rightHalfId, st));
    st = await editor.state();
    expect(st.selection, 'Tek üye seçilmeliydi.').toEqual([rightHalfId]);
    await editor.page.keyboard.press('Delete');
    await expect
      .poll(async () => (await editor.state()).clipCount, {
        message: 'Delete YALNIZ seçili üyeyi silmeliydi (grup kapanışı silmeye yayılmaz).',
      })
      .toBe(2);
    st = await editor.state();
    const survivors = [seed.clipAId, seed.clipBId];
    expect(
      commonGroupId(st, survivors),
      'Kalan iki üye hâlâ AYNI grubu taşımalı (grup 2 üyeyle yaşar).',
    ).not.toBeNull();

    // Tek Ctrl+Z üyeyi geri getirir; grup yine üç üyeli.
    await editor.page.keyboard.press('Control+z');
    await expect
      .poll(async () => (await editor.state()).clipCount, {
        message: 'TEK undo silinen üyeyi geri getirmeliydi.',
      })
      .toBe(3);
    st = await editor.state();
    expect(commonGroupId(st, memberIds), 'Undo sonrası üçlü grup geri gelmeli.').not.toBeNull();

    // (d) Ctrl+Shift+G -> grup dağılır -> sürüklemede yalnız BİRİ kayar (negatif).
    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId, st));
    await editor.page.keyboard.press('Control+Shift+g');
    await expect
      .poll(async () => {
        const s = await editor.state();
        return allClips(s).every((c) => c.groupId === undefined);
      }, { message: 'Ctrl+Shift+G dokunulan grubu TÜMDEN dağıtmalı.' })
      .toBe(true);

    st = await editor.state();
    const othersBefore = [rightHalfId, seed.clipBId].map(
      (id) => findClip(st, id).clip.timelineStartUs,
    );
    const soloBefore = findClip(st, seed.clipAId).clip.timelineStartUs;
    await editor.timeline.dragClipByTime(seed.clipAId, -2 * SECOND_US);
    st = await editor.state();
    expect(
      findClip(st, seed.clipAId).clip.timelineStartUs,
      'Dağıtılmış klip tek başına kaymalı.',
    ).toBeLessThan(soloBefore);
    expect(
      [rightHalfId, seed.clipBId].map((id) => findClip(st, id).clip.timelineStartUs),
      'Grup dağıldıktan sonra diğerleri YERİNDE kalmalı (kapanış artık onları görmez).',
    ).toEqual(othersBefore);

    // (f) Ctrl+G KLAVYEDEN de çalışır (menüsüz yol): Ctrl+A + Ctrl+G.
    await editor.page.keyboard.press('Control+a');
    st = await editor.state();
    expect(st.selection.sort(), 'Ctrl+A üç klibi de seçmeli.').toEqual([...memberIds].sort());
    await editor.page.keyboard.press('Control+g');
    await expect
      .poll(async () => commonGroupId(await editor.state(), memberIds), {
        message: 'Ctrl+G (klavye) üç klibe AYNI taze groupId\'yi yazmalı.',
      })
      .not.toBeNull();
    st = await editor.state();
    expect(st.historyLabels.at(-1), 'Undo etiketi gruplamayı söylemeli.').toBe('Klipler gruplandı');
  });

  test('tek klip seçiliyken "Grupla" gri: data-block-reason + Türkçe title asılı', async ({
    editor,
    seed,
  }) => {
    await editor.ensureContentVisible(seed.clipAId);
    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId), 'right');
    await expect(editor.contextMenu).toBeVisible();

    // Gerekçe op'un KENDİ ret kodudur (groupBlockReason) ve Türkçesi title'da.
    const groupItem = editor.page.getByTestId('timeline-menu-groupClips');
    await expect(groupItem, 'Tek klip seçiliyken "Grupla" gri olmalı.').toBeDisabled();
    await expect(groupItem).toHaveAttribute(
      'data-block-reason',
      'need at least two clips to group',
    );
    await expect(groupItem).toHaveAttribute('title', 'Gruplamak için en az iki klip seçin');

    // Grupsuz dokümanda "Grubu dağıt" da kendi gerekçesiyle gri.
    const ungroupItem = editor.page.getByTestId('timeline-menu-ungroupClips');
    await expect(ungroupItem).toBeDisabled();
    await expect(ungroupItem).toHaveAttribute('data-block-reason', 'no group in selection');
    await expect(ungroupItem).toHaveAttribute('title', 'Seçimde grup yok');

    // Gri öğeler hiçbir şey üretmez.
    await editor.page.keyboard.press('Escape');
    const st = await editor.state();
    expect(st.clipCount).toBe(2);
    expect(allClips(st).every((c) => c.groupId === undefined)).toBe(true);
  });
});
