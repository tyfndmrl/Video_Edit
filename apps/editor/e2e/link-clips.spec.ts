/**
 * AV bağı (linkId) çekirdeği — ozellik-2 (GERÇEK fare/klavye).
 *
 * CapCut davranışı: "Sesi ayır" ile doğan (ya da "Bağla" ile kurulan) video+ses
 * çifti taşı/sil/böl operasyonlarında BİRLİKTE hareket eder; "Bağlantıyı
 * kaldır" çifti bağımsızlaştırır. Kapanış OP İÇİNDEDİR (timelineOps
 * expandSelectionForOp): panel hangi yoldan çağırırsa çağırsın eş de işleme
 * girer.
 *
 * KURAL (docs/review-gate.md §3): yalnız gerçek girdi — sürükleme page.mouse,
 * silme/undo page.keyboard, menü gerçek sağ tık. Store yalnız DOĞRULAMA için
 * okunur (readAppState.linkId — appBridge bu dilimde alanı taşır).
 *
 * Seed notu: seed asset'inin `hasAudio` alanı YOKtur (bilinmeyen) — detach
 * kapısı yalnız KESİN hasAudio=false'ta engel kurar, yani "Sesi ayır" burada
 * serbesttir (detach-audio-silent.spec bu kapının iki yönünü ayrıca sabitler).
 */
import { test, expect } from './fixtures/test';
import { findClip, type AppState } from './support/appBridge';

/** Dokümandaki tek ses klibi (yoksa test kırmızı). */
function audioClipOf(state: AppState): { id: string; timelineStartUs: number; linkId?: string } {
  const audio = state.tracks.flatMap((t) => t.clips).filter((c) => c.kind === 'audio');
  expect(audio, 'Dokümanda TAM 1 ses klibi bekleniyor.').toHaveLength(1);
  return audio[0];
}

test.describe('AV bağı — link/unlink + taşı/sil/undo kapanışı', () => {
  test('Sesi ayır -> çift birlikte taşınır ve silinir; tek undo ikisini getirir; unlink bağımsızlaştırır; Bağla yeniden bağlar', async ({
    editor,
    seed,
  }) => {
    test.setTimeout(120_000);
    await editor.ensureContentVisible(seed.clipAId);

    // (a) GERÇEK sağ tık -> "Sesi ayır": iki klip AYNI linkId ile doğar.
    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId), 'right');
    await expect(editor.contextMenu).toBeVisible();
    await editor.page.getByTestId('timeline-menu-detachAudio').click();
    await expect
      .poll(async () => (await editor.state()).clipCount, {
        message: '"Sesi ayır" ses klibi doğurmalıydı.',
      })
      .toBe(3);

    let st = await editor.state();
    const video = findClip(st, seed.clipAId).clip;
    let audio = audioClipOf(st);
    expect(video.linkId, 'Ayrılan çift bağlı doğar (linkId).').toBeDefined();
    expect(audio.linkId, 'Ses yarısı AYNI linkId\'yi taşımalı.').toBe(video.linkId);
    const audioId = audio.id;

    // (b) Videoyu GERÇEK fareyle sağa sürükle -> İKİSİ birden kayar (kapanış).
    const startBefore = video.timelineStartUs;
    await editor.timeline.dragClipByTime(seed.clipAId, 3_000_000);
    st = await editor.state();
    const movedVideo = findClip(st, seed.clipAId).clip;
    audio = audioClipOf(st);
    expect(movedVideo.timelineStartUs, 'Video sürüklemeyle kaymalı.').toBeGreaterThan(startBefore);
    expect(
      audio.timelineStartUs,
      'Bağlı ses, videoyla AYNI konuma kaymalı (op-içi kapanış).',
    ).toBe(movedVideo.timelineStartUs);

    // (c) Delete -> ikisi de gider; TEK Ctrl+Z -> ikisi de döner.
    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId));
    await editor.page.keyboard.press('Delete');
    await expect
      .poll(async () => (await editor.state()).clipCount, {
        message: 'Delete bağlı çifti (video+ses) birlikte silmeliydi.',
      })
      .toBe(1);
    await editor.page.keyboard.press('Control+z');
    await expect
      .poll(async () => (await editor.state()).clipCount, {
        message: 'TEK undo çiftin İKİSİNİ de geri getirmeliydi (tek mutate).',
      })
      .toBe(3);
    st = await editor.state();
    expect(findClip(st, seed.clipAId).clip.linkId).toBe(audioClipOf(st).linkId);

    // (d) "Bağlantıyı kaldır" -> sürükle -> yalnız video kayar (negatif yön).
    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId), 'right');
    await expect(editor.contextMenu).toBeVisible();
    const unlinkItem = editor.page.getByTestId('timeline-menu-unlinkClips');
    await expect(unlinkItem, 'Bağlı klipte "Bağlantıyı kaldır" açık olmalı.').toBeEnabled();
    await unlinkItem.click();
    await expect
      .poll(async () => {
        const s = await editor.state();
        return findClip(s, seed.clipAId).clip.linkId ?? null;
      })
      .toBe(null);
    st = await editor.state();
    expect(audioClipOf(st).linkId, 'Unlink bağı İKİ uçtan da silmeli.').toBeUndefined();

    const audioStartBeforeSolo = audioClipOf(st).timelineStartUs;
    await editor.timeline.dragClipByTime(seed.clipAId, 2_000_000);
    st = await editor.state();
    const soloVideo = findClip(st, seed.clipAId).clip;
    expect(
      audioClipOf(st).timelineStartUs,
      'Bağ koptuktan sonra ses YERİNDE kalmalı (kapanış artık onu görmez).',
    ).toBe(audioStartBeforeSolo);
    expect(soloVideo.timelineStartUs).not.toBe(audioStartBeforeSolo);

    // (e) Shift+tık ile video+ses seç -> sağ tık "Bağla" -> linkId yeniden eşit.
    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId));
    await editor.page.keyboard.down('Shift');
    await editor.timeline.click(await editor.timeline.clipCenter(audioId));
    await editor.page.keyboard.up('Shift');
    st = await editor.state();
    expect(st.selection.sort(), 'Shift+tık iki klibi de seçmeli.').toEqual(
      [seed.clipAId, audioId].sort(),
    );

    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId), 'right');
    await expect(editor.contextMenu).toBeVisible();
    const linkItem = editor.page.getByTestId('timeline-menu-linkClips');
    await expect(linkItem, 'Video+ses seçiliyken "Bağla" açık olmalı.').toBeEnabled();
    await linkItem.click();
    await expect
      .poll(async () => {
        const s = await editor.state();
        const v = findClip(s, seed.clipAId).clip;
        const a = audioClipOf(s);
        return v.linkId !== undefined && v.linkId === a.linkId;
      }, { message: '"Bağla" iki klibe AYNI taze linkId\'yi yazmalı.' })
      .toBe(true);
  });

  test('tek klip seçiliyken "Bağla" gri: data-block-reason + Türkçe title asılı', async ({
    editor,
    seed,
  }) => {
    await editor.ensureContentVisible(seed.clipAId);
    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId), 'right');
    await expect(editor.contextMenu).toBeVisible();

    // Gerekçe op'un KENDİ ret kodudur (linkBlockReason) ve Türkçesi title'da.
    const linkItem = editor.page.getByTestId('timeline-menu-linkClips');
    await expect(linkItem, 'Tek klip seçiliyken "Bağla" gri olmalı.').toBeDisabled();
    await expect(linkItem).toHaveAttribute(
      'data-block-reason',
      'select a video and an audio clip to link',
    );
    await expect(linkItem).toHaveAttribute(
      'title',
      'Bağlamak için bir video ve bir ses klibi seçin',
    );

    // Bağsız dokümanda "Bağlantıyı kaldır" da kendi gerekçesiyle gri.
    const unlinkItem = editor.page.getByTestId('timeline-menu-unlinkClips');
    await expect(unlinkItem).toBeDisabled();
    await expect(unlinkItem).toHaveAttribute('data-block-reason', 'no linked clip in selection');
    await expect(unlinkItem).toHaveAttribute('title', 'Seçimde bağlı klip yok');

    // Gri öğeler hiçbir şey üretmez.
    await editor.page.keyboard.press('Escape');
    const st = await editor.state();
    expect(st.clipCount).toBe(2);
    expect(st.tracks.flatMap((t) => t.clips).every((c) => c.linkId === undefined)).toBe(true);
  });
});
