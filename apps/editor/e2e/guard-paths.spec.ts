/**
 * "Yönlendir-sonra-reddet" yolları — GERÇEK fare ve klavye ile (review-gate §3).
 *
 * ---------------------------------------------------------------------------
 * BU DOSYA NEYİ KANITLIYOR
 * ---------------------------------------------------------------------------
 * Dışa aktarma derleyicisi (ExportCompiler) üç bileşimi TİPLİ HATA ile reddeder.
 * Editör onları kurdurabildiği sürece kullanıcı gerekçeyi ancak dışa aktarımda
 * (HTTP 422) öğrenir. Testler kullanıcının yapacağı şeyi yapar — yasak
 * bileşimi GERÇEKTEN kurmayı dener — ve iki şeyi birden arar:
 *   1. doküman o bileşime GİRMEDİ (store okuması),
 *   2. arayüz NEDENİNİ söyledi (kapalı öğenin ipucu metni / panel satırı).
 * "Tıkladım bir şey olmadı" bu testlerde yeşil OLAMAZ: her senaryo görünür bir
 * gerekçe metni arar.
 *
 * `dispatchEvent`, sentetik PointerEvent ve doğrudan store çağrısı YOKTUR.
 * Store yalnız DOĞRULAMA için okunur (keyframe listesi ve transform canvas'ta
 * okunamaz; tek dürüst kaynak dokümandır).
 *
 * Seed kliplerinin arasında boşluk var ve gelen klibin kaynak payı yok; geçiş
 * ön koşulu (bitişiklik + D/2 payı) transitions.spec.ts ile AYNI gerçek
 * jestlerle kurulur (sol kenarı kırp -> pay doğsun, giden klibi sürükle ->
 * kesim doğsun).
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/test';
import { SECOND_US, SEED_TIMES } from './fixtures/seed';
import { EditorApp } from './support/editor';
import { TRACK_H } from '../src/features/timeline/geometry';

/** Rozet, şeridin ALTINDA duruyor (geometry.ts TRANSITION_BADGE_*). */
const BADGE_H = 14;
const BADGE_BOTTOM_GAP = 3;

/** clipA [60s,66s) — şekil klibi buraya, playhead'in üstüne düşer. */
const SHAPE_START_US = 63 * SECOND_US;

interface DocClip {
  id: string;
  transform: { x: number; y: number; scale: number; rotationDeg: number };
  keyframes: Record<string, { timeUs: number; value: number }[] | undefined>;
  transitionIn?: { type: string; durationUs: number };
  transitionOut?: { type: string; durationUs: number };
}

// ---------------------------------------------------------------------------
// Doğrulama okumaları (salt okunur)
// ---------------------------------------------------------------------------

async function readClip(page: Page, clipId: string): Promise<DocClip> {
  const clip = await page.evaluate((id: string) => {
    const bridge = (window as unknown as {
      __ve: { doc: { useDocStore: { getState(): { doc: { tracks: { clips: { id: string }[] }[] } } } } };
    }).__ve;
    for (const track of bridge.doc.useDocStore.getState().doc.tracks) {
      const found = track.clips.find((c) => c.id === id);
      if (found) return JSON.parse(JSON.stringify(found)) as unknown;
    }
    return null;
  }, clipId);
  expect(clip, `Klip dokümanda yok: ${clipId}`).not.toBeNull();
  return clip as DocClip;
}

function keyframeCount(clip: DocClip, channel: string): number {
  return clip.keyframes[channel]?.length ?? 0;
}

// ---------------------------------------------------------------------------
// Gerçek girdi yardımcıları (keyframes.spec.ts ile aynı desen)
// ---------------------------------------------------------------------------

/**
 * Gerçek fare tıklaması. `scrollIntoViewIfNeeded` OLAY ÜRETMEZ (yalnız
 * kaydırma); Inspector kaydırılabilir bir sütun, hedef kıvrımın altında olabilir.
 */
async function clickReal(page: Page, testId: string): Promise<void> {
  const el = page.getByTestId(testId);
  await expect(el, `Öğe ekranda yok: ${testId}`).toBeVisible();
  await el.scrollIntoViewIfNeeded();
  const box = await el.boundingBox();
  expect(box, `Öğenin kutusu okunamadı: ${testId}`).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(140);
}

/** Sayısal alana GERÇEK klavyeyle yazar (tıkla -> hepsini seç -> yaz -> Enter). */
async function typeNumber(page: Page, testId: string, value: string): Promise<void> {
  const el = page.getByTestId(testId);
  await expect(el, `Alan ekranda yok: ${testId}`).toBeVisible();
  await el.scrollIntoViewIfNeeded();
  const box = await el.boundingBox();
  expect(box, `Alanın kutusu okunamadı: ${testId}`).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.press('Control+a');
  await page.keyboard.type(value);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(160);
}

/** Kesim rozetinin ekran koordinatı (giden klibin SONU = kesim). */
async function badgePoint(
  editor: EditorApp,
  outgoingClipId: string,
): Promise<{ x: number; y: number }> {
  const box = await editor.timeline.clipBox(outgoingClipId);
  return {
    x: box.x + box.width,
    y: box.y + TRACK_H - BADGE_BOTTOM_GAP - BADGE_H / 2,
  };
}

/** Klibin SOL kenarını hedef zamana sürükler (kaynak payı ancak böyle doğar). */
async function dragLeftEdgeToTime(
  editor: EditorApp,
  clipId: string,
  targetStartUs: number,
): Promise<void> {
  const state = await editor.state();
  const box = await editor.timeline.clipBox(clipId, state);
  const wrap = await editor.timeline.wrapBox();
  const from = { x: box.x + 3, y: box.y + TRACK_H / 2 };
  const to = { x: wrap.x + (targetStartUs - state.scrollUs) * state.pxPerUs, y: from.y };
  await editor.timeline.drag(from, to);
}

/** Ön koşul: clipB'ye kaynak payı aç, clipA'yı yapıştır (GERÇEK jestlerle). */
async function makeAdjacentCutWithHandle(
  editor: EditorApp,
  seed: { clipAId: string; clipBId: string },
): Promise<void> {
  const handleUs = 2 * SECOND_US;
  await dragLeftEdgeToTime(editor, seed.clipBId, SEED_TIMES.clipBStartUs + handleUs);

  const clipB = await readClip(editor.page, seed.clipBId);
  expect(
    (clipB as unknown as { sourceInUs: number }).sourceInUs,
    'Ön koşul: clipB kırpılıp kaynak payı açılmalıydı.',
  ).toBeGreaterThan(handleUs / 2);

  const a = (await readClip(editor.page, seed.clipAId)) as unknown as {
    timelineStartUs: number;
    timelineDurationUs: number;
  };
  const b = clipB as unknown as { timelineStartUs: number };
  await editor.timeline.dragClipByTime(
    seed.clipAId,
    b.timelineStartUs - (a.timelineStartUs + a.timelineDurationUs),
  );

  const movedA = (await readClip(editor.page, seed.clipAId)) as unknown as {
    timelineStartUs: number;
    timelineDurationUs: number;
  };
  const movedB = (await readClip(editor.page, seed.clipBId)) as unknown as {
    timelineStartUs: number;
  };
  expect(
    movedA.timelineStartUs + movedA.timelineDurationUs,
    'Ön koşul: clipA sürüklenip clipB ile BİTİŞİK hale gelmeliydi.',
  ).toBe(movedB.timelineStartUs);
}

/** Kesime GERÇEK fareyle geçiş ekler (rozet -> tip düğmesi). */
async function addTransitionByMouse(editor: EditorApp, outgoingClipId: string): Promise<void> {
  await editor.timeline.click(await badgePoint(editor, outgoingClipId));
  await expect(
    editor.page.getByTestId('transition-editor'),
    'Kesim rozetine tıklayınca geçiş düzenleyicisi açılmalı.',
  ).toBeVisible();
  await editor.page.getByTestId('transition-type-crossfade').click();
  await editor.page.waitForTimeout(180);
}

/** Klibi GERÇEK fareyle seçer ve playhead'i içine taşır (keyframe yazılabilsin). */
async function selectClipWithPlayheadInside(editor: EditorApp, clipId: string): Promise<void> {
  const clip = (await readClip(editor.page, clipId)) as unknown as {
    timelineStartUs: number;
    timelineDurationUs: number;
  };
  await editor.timeline.scrubTo(clip.timelineStartUs + Math.round(clip.timelineDurationUs / 2));
  await editor.timeline.click(await editor.timeline.clipCenter(clipId));
  await expect(
    editor.page.getByTestId('clip-inspector-visual'),
    'Klibe tıklayınca Inspector "Görüntü" bölümü açılmalı.',
  ).toBeVisible();
}

/** Şekil katmanı ekler (gerçek fare, TopBar düğmesi) ve id'sini döndürür. */
async function addShapeAtPlayhead(editor: EditorApp): Promise<string> {
  await editor.timeline.scrubTo(SHAPE_START_US);
  await clickReal(editor.page, 'add-shape-clip');
  const state = await editor.state();
  const overlay = state.tracks.find((t) => t.type === 'overlay');
  expect(overlay, '"Şekil ekle" bir overlay track açmalı.').toBeDefined();
  const clip = overlay!.clips.find((c) => c.kind === 'shape');
  expect(clip, "Overlay track'te şekil klibi olmalı.").toBeDefined();
  return clip!.id;
}

// ---------------------------------------------------------------------------

test.describe('Derleyicinin reddettiği bileşimler UI da ön engelli', () => {
  test.beforeEach(async ({ editor, seed }) => {
    await editor.ensureContentVisible(seed.clipAId);
  });

  test('(a) keyframe li klibe geçiş EKLENEMEZ — menü gri ve gerekçesini söylüyor', async ({
    editor,
    seed,
  }) => {
    const page = editor.page;
    await makeAdjacentCutWithHandle(editor, seed);

    // 1) clipA'ya GERÇEK tıklamayla opaklık keyframe'i yaz.
    await selectClipWithPlayheadInside(editor, seed.clipAId);
    await clickReal(page, 'clip-kf-opacity');
    expect(
      keyframeCount(await readClip(page, seed.clipAId), 'opacity'),
      'Elmas düğmesi playhead\'e bir keyframe yazmalıydı (ön koşul).',
    ).toBe(1);

    // 2) Kesime sağ tık -> "Geçiş ekle" GRİ ve gerekçesi görünür.
    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId), 'right');
    await expect(editor.contextMenu).toBeVisible();

    const addItem = page.getByTestId('timeline-menu-addTransition');
    await expect(
      addItem,
      'Keyframe li klipte "Geçiş ekle" TEKLİF EDİLMEMELİ (derleyici reddediyor).',
    ).toBeDisabled();
    await expect(
      addItem,
      'Gri öğe NEDENİNİ söylemeli — sessiz gri "bozuk düğme" demektir.',
    ).toHaveAttribute('data-block-reason', 'a keyframed clip cannot take a transition');
    const title = await addItem.getAttribute('title');
    expect(title ?? '', 'İpucu Türkçe ve gerekçeli olmalı.').toMatch(/keyframe/i);

    // 3) Gri öğeye gerçek tıklama hiçbir şey yazmamalı.
    const box = await addItem.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(160);
    expect(
      (await readClip(page, seed.clipAId)).transitionOut,
      'Gri öğeye tıklamak geçiş yazmamalı.',
    ).toBeUndefined();

    // 4) Rozet yolu da aynı gerekçeyi veriyor (menü ile tek kaynak).
    await page.keyboard.press('Escape');
    await page.waitForTimeout(120);
    await editor.timeline.click(await badgePoint(editor, seed.clipAId));
    await expect(
      page.getByTestId('timeline-warning'),
      'Rozete tıklayınca da gerekçe görünmeli (sessiz ret yok).',
    ).toBeVisible();
    await expect(page.getByTestId('timeline-warning')).toContainText(/keyframe/i);
    await expect(
      page.getByTestId('transition-editor'),
      'Reddedilen kesimde geçiş düzenleyicisi HİÇ açılmamalı.',
    ).toHaveCount(0);
  });

  test('(a2) geçişli klipte keyframe elması KAPALI ve nedenini söylüyor', async ({
    editor,
    seed,
  }) => {
    const page = editor.page;
    await makeAdjacentCutWithHandle(editor, seed);
    await addTransitionByMouse(editor, seed.clipAId);
    expect(
      (await readClip(page, seed.clipAId)).transitionOut,
      'Ön koşul: kesime geçiş yazılmalıydı.',
    ).toBeDefined();

    await selectClipWithPlayheadInside(editor, seed.clipAId);

    for (const channel of ['x', 'y', 'scale', 'rotationDeg', 'opacity']) {
      const diamond = page.getByTestId(`clip-kf-${channel}`);
      await expect(
        diamond,
        `Geçişli klipte "${channel}" keyframe düğmesi kapalı olmalı.`,
      ).toBeDisabled();
      const title = await diamond.getAttribute('title');
      expect(
        title ?? '',
        `"${channel}" düğmesinin ipucu gerekçeyi söylemeli (gelen: ${String(title)}).`,
      ).toMatch(/geçiş/i);
    }

    // Kapalı düğmeye GERÇEK tıklama (pointer-events kapalı: tıklama panele
    // düşer) hiçbir keyframe yazmamalı.
    const diamond = page.getByTestId('clip-kf-opacity');
    await diamond.scrollIntoViewIfNeeded();
    const box = await diamond.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(160);
    expect(
      keyframeCount(await readClip(page, seed.clipAId), 'opacity'),
      'Kapalı elmasa tıklamak keyframe YAZMAMALI.',
    ).toBe(0);
  });

  test('(b) dönme varken ölçek keyframe i açılamaz; ölçek animasyonluyken dönme kilitli', async ({
    editor,
  }) => {
    const page = editor.page;
    const clipId = await addShapeAtPlayhead(editor);

    // ---- Yön 1: taban dönme != 0 -> ölçek kanalı kapalı ----
    await typeNumber(page, 'clip-rotation', '30');
    expect(
      (await readClip(page, clipId)).transform.rotationDeg,
      'Klavyeyle yazılan dönme dokümana geçmeliydi (ön koşul).',
    ).toBe(30);

    const scaleDiamond = page.getByTestId('clip-kf-scale');
    await expect(
      scaleDiamond,
      'Katman dönüyorken ölçek keyframe i TEKLİF EDİLMEMELİ.',
    ).toBeDisabled();
    expect(await scaleDiamond.getAttribute('title')).toMatch(/döndürme|dönme/i);

    await scaleDiamond.scrollIntoViewIfNeeded();
    const sBox = await scaleDiamond.boundingBox();
    await page.mouse.move(sBox!.x + sBox!.width / 2, sBox!.y + sBox!.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(160);
    expect(
      keyframeCount(await readClip(page, clipId), 'scale'),
      'Kapalı ölçek elmasına tıklamak keyframe yazmamalı.',
    ).toBe(0);

    // ---- Yön 2: dönmeyi 0 yap, ölçek keyframe i aç -> dönme alanı kilitlenir ----
    await typeNumber(page, 'clip-rotation', '0');
    await expect(scaleDiamond, 'Dönme 0 olunca ölçek kanalı yeniden açılmalı.').toBeEnabled();

    await clickReal(page, 'clip-kf-scale');
    expect(
      keyframeCount(await readClip(page, clipId), 'scale'),
      'Ölçek keyframe i yazılmalıydı.',
    ).toBe(1);

    await expect(
      page.getByTestId('clip-rotation'),
      'Ölçek animasyonluyken Döndürme alanı KİLİTLİ olmalı.',
    ).toBeDisabled();
    await expect(
      page.getByTestId('clip-rotation-block'),
      'Kilit gerekçesi alanın yanında YAZILI olmalı.',
    ).toBeVisible();
    await expect(page.getByTestId('clip-rotation-block')).toHaveAttribute(
      'data-reason',
      'rotation cannot be combined with scale keyframes',
    );
    await expect(
      page.getByTestId('clip-kf-rotationDeg'),
      'Dönme keyframe i de açılamamalı (bileşimin öbür yönü).',
    ).toBeDisabled();

    // Gizmo da dönme tutamağını GÖSTERMEMELİ (op reddedeceği bir jesti teklif etmez).
    await expect(
      page.getByTestId('player-gizmo-rotate'),
      'Ölçek animasyonluyken gizmo dönme tutamağı çizilmemeli.',
    ).toHaveCount(0);

    // Alan gerçekten yazılamıyor: klavye ile denemek dokümanı değiştirmemeli.
    const rotation = page.getByTestId('clip-rotation');
    await rotation.scrollIntoViewIfNeeded();
    const rBox = await rotation.boundingBox();
    await page.mouse.move(rBox!.x + rBox!.width / 2, rBox!.y + rBox!.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    await page.keyboard.type('45');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(160);
    expect(
      (await readClip(page, clipId)).transform.rotationDeg,
      'Kilitli alana yazmak dokümanı DEĞİŞTİRMEMELİ.',
    ).toBe(0);
  });

  test('(c) geçişli klipte yerleşim İKİ klibe birden uygulanır ve panel bunu önceden söyler', async ({
    editor,
    seed,
  }) => {
    const page = editor.page;
    await makeAdjacentCutWithHandle(editor, seed);
    await addTransitionByMouse(editor, seed.clipAId);

    await selectClipWithPlayheadInside(editor, seed.clipAId);

    // ÖNCE söylenir: "komşu klip de değişecek".
    await expect(
      page.getByTestId('clip-transform-chain-note'),
      'Geçişli klipte panel, yerleşimin komşuya da uygulanacağını ÖNCEDEN yazmalı.',
    ).toBeVisible();

    // Gerçek klavyeyle ölçek yaz.
    await typeNumber(page, 'clip-scale', '1.5');

    const a = await readClip(page, seed.clipAId);
    const b = await readClip(page, seed.clipBId);
    expect(a.transform.scale, 'Yazılan ölçek klibe geçmeliydi.').toBeCloseTo(1.5, 4);
    expect(
      b.transform,
      'Geçişli komşunun yerleşimi AYNI olmalı — derleyici farkı 422 ile reddediyor.',
    ).toEqual(a.transform);

    // Ve sonuç bildirilir (sessiz komşu düzenlemesi yok).
    const message = page.getByTestId('clip-inspector-message');
    await expect(message, 'Komşuya yayılma bildirilmeli.').toBeVisible();
    await expect(message).toHaveAttribute('data-source', 'visual');
    await expect(message).toContainText(/geçiş/i);
  });
});
