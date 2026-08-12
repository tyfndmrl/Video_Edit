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
import { LibraryPanelHarness } from './support/library';
import { ensureTestVideo, FFMPEG_SKIP_REASON, ffmpegVersion } from './support/media';
import { createEmptyProject } from './support/projects';
import { TRACK_H } from '../src/features/timeline/geometry';

/** Rozet, şeridin ALTINDA duruyor (geometry.ts TRANSITION_BADGE_*). */
const BADGE_H = 14;
const BADGE_BOTTOM_GAP = 3;

/** clipA [60s,66s) — şekil klibi buraya, playhead'in üstüne düşer. */
const SHAPE_START_US = 63 * SECOND_US;

interface DocTransform {
  x: number;
  y: number;
  scale: number;
  rotationDeg: number;
  anchorX: number;
  anchorY: number;
}

interface DocClip {
  id: string;
  transform: DocTransform;
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

// ---------------------------------------------------------------------------
// (c2) TERS SIRA — önce yerleşim, SONRA geçiş; ve işin GERÇEKTEN render olması
//
// (c) geçişi ÖNCE ekleyip yerleşimi SONRA yazıyor. Kullanıcının doğal sırası ise
// çoğu zaman tersidir: klibi böl, birinci yarıyı büyüt, sonra kesime geçiş koy.
// O sırada editör sessiz kalıyordu, PUT 200 ve POST /exports 202 dönüyordu, iş
// KUYRUĞA GİRİYOR ve worker'da "geçişli kliplerin yerleşimi aynı olmalıdır" ile
// düşüyordu — yani "desteklenmeyen bileşim kuyruğa hiç girmez" vaadi ölçülerek
// yanlıştı.
//
// Bu yüzden burada iddia UI'da BİTMİYOR: iş gerçekten render ediliyor. Derleme
// aşaması worker'ın içinde, dokümanın tamamı üzerinde çalışır; "Tamamlandı"
// rozeti o aşamanın geçildiğinin tek dürüst kanıtıdır.
// ---------------------------------------------------------------------------

/** Gizmo kutusunun EKRANDAKİ geometrisi — SVG'nin kendi çizdiği noktalardan. */
async function gizmoBox(page: Page): Promise<{
  centre: { x: number; y: number };
  cornerSe: { x: number; y: number };
}> {
  const geo = await page.evaluate(() => {
    const svg = document.querySelector('[data-testid="player-gizmo"]');
    const box = document.querySelector('[data-testid="player-gizmo-box"]');
    const se = document.querySelector('[data-testid="player-gizmo-corner-se"]');
    if (!svg || !box || !se) return null;
    const r = svg.getBoundingClientRect();
    const corners = (box.getAttribute('points') ?? '')
      .trim()
      .split(/\s+/)
      .map((pair) => {
        const [x, y] = pair.split(',').map(Number);
        return { x: r.left + x, y: r.top + y };
      });
    if (corners.length !== 4) return null;
    return {
      centre: {
        x: corners.reduce((s, p) => s + p.x, 0) / 4,
        y: corners.reduce((s, p) => s + p.y, 0) / 4,
      },
      cornerSe: {
        x: r.left + Number(se.getAttribute('x')) + Number(se.getAttribute('width')) / 2,
        y: r.top + Number(se.getAttribute('y')) + Number(se.getAttribute('height')) / 2,
      },
    };
  });
  expect(geo, 'Gizmo ekranda bulunamadı (player-gizmo* testid\'leri yok).').not.toBeNull();
  return geo as { centre: { x: number; y: number }; cornerSe: { x: number; y: number } };
}

/** Gerçek fare: bas -> eşiği aşan kademeli hareket -> bırak. */
async function dragMouse(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + Math.sign(to.x - from.x || 1) * 6, from.y, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.move(to.x, to.y);
  await page.mouse.up();
  await page.waitForTimeout(150);
}

/** Track'in kliplerini zaman sırasına dizer. */
function clipsInOrder(state: { tracks: { type: string; clips: { id: string; timelineStartUs: number; timelineDurationUs: number }[] }[] }) {
  const track = state.tracks.find((t) => t.clips.length > 0);
  expect(track, 'Dokümanda klipli bir track yok.').toBeDefined();
  return [...track!.clips].sort((a, b) => a.timelineStartUs - b.timelineStartUs);
}

test.describe('(c2) böl -> ölçekle -> geçiş ekle: iş kuyrukta ölmez', () => {
  test('gerçek fareyle kurulan sıra dışa aktarımda RENDER edilir', async ({ page, account }) => {
    test.skip(ffmpegVersion() === null, FFMPEG_SKIP_REASON);
    // Yükleme + worker işleme + ffmpeg render.
    test.setTimeout(480_000);

    // GERÇEK medya şart: sahte assetId'li bir doküman worker'da zaten kaynak
    // bulamadan düşerdi ve "derleme aşamasını geçti mi?" sorusu yanıtsız kalırdı.
    const video = ensureTestVideo();
    const project = await createEmptyProject(
      account.context.request,
      account.accessToken,
      'E2E gecis yerlesim',
    );

    const app = new EditorApp(page);
    await app.open(project.projectId, { email: account.email, password: account.password });

    const library = new LibraryPanelHarness(page);
    await library.pickFiles([video.path]);
    await library.waitForReady(video.fileName);
    await library.doubleClickAsset(video.fileName);
    await expect
      .poll(async () => (await app.state()).clipCount, {
        timeout: 20_000,
        message: 'Kütüphaneden timeline\'a klip eklenemedi.',
      })
      .toBe(1);

    // --- 1. GERÇEK sağ tık menüsüyle böl ---
    let st = await app.state();
    const source = clipsInOrder(st)[0];
    const cutUs = source.timelineStartUs + Math.round(source.timelineDurationUs / 2);
    await app.timeline.scrubTo(cutUs);
    await app.timeline.click(await app.timeline.clipCenter(source.id, await app.state()), 'right');
    await expect(app.contextMenu).toBeVisible();
    await app.contextMenuItem(/playhead.?de b[öo]l/i).click();
    await page.waitForTimeout(250);

    st = await app.state();
    expect(st.clipCount, 'Bölme iki klip üretmeliydi.').toBe(2);
    const [first, second] = clipsInOrder(st);
    expect(
      first.timelineStartUs + first.timelineDurationUs,
      'Bölmenin iki yarısı BİTİŞİK olmalı (geçişin ön koşulu).',
    ).toBe(second.timelineStartUs);

    // --- 2. İlk yarıyı seç ve GİZMO ile ölçekle (henüz geçiş YOK) ---
    await app.timeline.click(await app.timeline.clipCenter(first.id));
    await app.timeline.scrubTo(first.timelineStartUs + Math.round(first.timelineDurationUs / 2));
    await expect(
      page.getByTestId('player-gizmo'),
      'Seçili klibin üstünde playhead varken gizmo görünmeli.',
    ).toHaveCount(1);

    const geo = await gizmoBox(page);
    // Köşeyi çapaya doğru çek: ölçek küçülür (yön önemli değil, FARK önemli).
    await dragMouse(page, geo.cornerSe, {
      x: geo.cornerSe.x - (geo.cornerSe.x - geo.centre.x) * 0.4,
      y: geo.cornerSe.y - (geo.cornerSe.y - geo.centre.y) * 0.4,
    });

    const scaledA = await readClip(page, first.id);
    const untouchedB = await readClip(page, second.id);
    expect(
      scaledA.transform.scale,
      'Gizmo sürüklemesi ilk yarının ölçeğini DEĞİŞTİRMELİYDİ (ön koşul).',
    ).toBeLessThan(1);
    expect(
      untouchedB.transform.scale,
      'ÖN KOŞUL: geçiş yokken komşuya dokunulmaz — ayrışma tam olarak burada doğuyor.',
    ).toBe(1);

    // --- 3. Kesim rozetinden GERÇEK fareyle geçiş ekle ---
    await addTransitionByMouse(app, first.id);

    // Komşunun yerleşimi değiştiyse bu SESSİZ olmamalı.
    const warning = page.getByTestId('timeline-warning');
    await expect(warning, 'Komşuya yayılma bildirilmeli (sessiz komşu düzenlemesi yok).').toBeVisible();
    await expect(warning).toContainText(/yerleşim/i);

    // --- 4. Doküman iddiası: tek xfade akışı, TEK yerleşim ---
    const a = await readClip(page, first.id);
    const b = await readClip(page, second.id);
    expect(a.transitionOut, 'Kesime geçiş yazılmalıydı.').toBeDefined();
    expect(b.transitionIn).toBeDefined();
    expect(
      b.transform,
      'Geçişli iki klibin yerleşimi AYNI olmalı — derleyici farkı InvalidTimeline ile reddediyor.',
    ).toEqual(a.transform);
    expect(
      a.transform.scale,
      'Eşitlenen değer VARSAYILAN olmamalı, yoksa test ölçeklemenin korunduğunu kanıtlamaz.',
    ).toBeLessThan(1);

    // --- 5. GERÇEK dışa aktarım: 202 + worker'da render ---
    const exportPost = page.waitForResponse(
      (r) => r.url().includes('/exports') && r.request().method() === 'POST',
      { timeout: 90_000 },
    );
    const openExport = page.getByRole('button', { name: 'Dışa Aktar', exact: true });
    await expect(openExport).toBeEnabled();
    await openExport.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Dışa aktar' }).click();

    const posted = await exportPost;
    expect(
      posted.status(),
      'POST /exports 202 dönmeliydi (ön kapı bu belgeyi kabul ediyor).',
    ).toBe(202);
    await expect(dialog, 'Başarılı başlatmada diyalog kapanır.').toBeHidden({ timeout: 30_000 });

    // Render edilen şey KAYDEDİLEN belgedir: sunucudaki belgede geçiş ve ORTAK
    // yerleşim gerçekten var mı? (Yoksa aşağıdaki "Tamamlandı" hiçbir şey
    // kanıtlamazdı — geçişsiz bir belge zaten sorunsuz render olur.)
    const detail = (await (
      await account.context.request.get(`/api/projects/${project.projectId}`, {
        headers: { Authorization: `Bearer ${account.accessToken}` },
      })
    ).json()) as { timeline: { tracks: { clips: (DocClip & { timelineStartUs: number })[] }[] } };
    const savedClips = detail.timeline.tracks
      .flatMap((t) => t.clips)
      .sort((x, y) => x.timelineStartUs - y.timelineStartUs);
    expect(savedClips[0].transitionOut, 'Kaydedilen belgede geçiş olmalı.').toBeDefined();
    expect(
      savedClips[1].transform,
      'Kaydedilen belgede de iki klibin yerleşimi aynı olmalı.',
    ).toEqual(savedClips[0].transform);
    expect(savedClips[0].transform.scale).toBeLessThan(1);

    // --- 6. İş DERLEME aşamasını geçti mi? Tek dürüst kanıt: render bitti. ---
    const exportsSection = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Dışa Aktarmalar' }) })
      .first();
    const jobRow = exportsSection.locator('li').first();
    await expect(jobRow).toBeVisible({ timeout: 20_000 });
    await expect(
      jobRow.getByText('Tamamlandı', { exact: true }),
      'Geçişli kesimde yerleşim eşitlenmediyse iş worker\'da "geçişli kliplerin yerleşimi aynı '
        + 'olmalıdır" ile düşer. Kart burada "Tamamlandı" göstermelidir.',
    ).toBeVisible({ timeout: 300_000 });
    await expect(
      jobRow.locator('p.text-danger'),
      'Başarısız bir iş sessizce geçmemeli.',
    ).toHaveCount(0);
  });
});
