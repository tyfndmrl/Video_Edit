/**
 * Geçişler — GERÇEK fareyle (page.mouse.*), uçtan uca.
 *
 * ---------------------------------------------------------------------------
 * SENARYONUN NEDEN BU KADAR KURULUMU VAR
 * ---------------------------------------------------------------------------
 * Seed dokümanı iki klibi ARALARINDA BOŞLUKLA koyar (clipA [60,66), clipB
 * [76,82)) ve her ikisi de `sourceIn = 0` ile başlar. Geçiş sözleşmesi
 * (rendering-semantics §5) iki şey ister:
 *   1. klipler BİTİŞİK olacak (kesim var),
 *   2. gelen klibin başında D/2'lik KAYNAK PAYI olacak (`sourceIn >= D/2`).
 * Seed ikisini de sağlamaz — bu bir eksiklik değil, testin iki ayrı davranışı
 * (pay VAR / pay YOK) aynı projede kanıtlayabilmesi demek.
 *
 * Kurulumun tamamı GERÇEK jestlerle yapılır (sürükleme + kırpma), yani testin
 * ön koşulu bile ürünün kendi etkileşim hattından geçer:
 *   - clipB'nin sol kenarını sağa kırp -> `sourceIn` büyür (pay doğar),
 *   - clipA'yı sağa sürükle -> iki klip bitişir (kesim doğar).
 * Her adımın SONUCU okunur ve tutmazsa test o adımda, gerekçesiyle düşer.
 *
 * Doküman doğrulaması Node tarafında ŞEMANIN KENDİSİYLE yapılır
 * (`validateTimelineDoc`): "editörün yazdığı doküman kendi sözleşmesinden
 * geçiyor mu?" sorusunun tek dürüst yanıtı budur.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  frameToUs,
  usToFrame,
  validateTimelineDoc,
  type Rational,
  type TimelineDoc,
} from '@videoedit/timeline-schema';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/test';
import { readProjectSettings } from './support/appBridge';
import { EditorApp } from './support/editor';
import { LibraryPanelHarness, listProjectAssets } from './support/library';
import { FFMPEG_SKIP_REASON, ffmpegVersion } from './support/media';
import { createEmptyProject } from './support/projects';
import { mixTransitionRef, toBytes, type Rgba } from '../src/features/player/core/transitionRef';
import { TRACK_H } from '../src/features/timeline/geometry';
import { SECOND_US, SEED_TIMES, saveTimeline } from './fixtures/seed';

/** Rozet, şeridin ALTINDA duruyor (geometry.ts TRANSITION_BADGE_*). */
const BADGE_H = 14;
const BADGE_BOTTOM_GAP = 3;

/** Konum belirsizliğinin (fare yuvarlaması + kare ızgarası) üst sınırı. */
const TOLERANCE_PX = 2;

interface DocClip {
  id: string;
  timelineStartUs: number;
  timelineDurationUs: number;
  sourceInUs?: number;
  sourceOutUs?: number;
  transitionIn?: { type: string; durationUs: number };
  transitionOut?: { type: string; durationUs: number };
}

/**
 * Dokümanın TAMAMI (appBridge.readAppState klipleri kırpılmış döner; geçiş
 * metadata'sı ve kaynak aralıkları burada lazım).
 */
async function readDoc(page: Page): Promise<TimelineDoc> {
  return page.evaluate(() => {
    const bridge = (window as unknown as {
      __ve: { doc: { useDocStore: { getState(): { doc: unknown } } } };
    }).__ve;
    return JSON.parse(JSON.stringify(bridge.doc.useDocStore.getState().doc)) as TimelineDoc;
  });
}

function clipOf(doc: TimelineDoc, clipId: string): DocClip {
  for (const track of doc.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return clip as unknown as DocClip;
  }
  throw new Error(`Klip dokümanda yok: ${clipId}`);
}

/**
 * Dokümanı ŞEMA + invariant'larla doğrula.
 *
 * `assetDurations` olarak BOŞ bir harita verilir — E2E projesindeki assetId
 * gerçek bir varlığa karşılık gelmiyor. Bu, uygulamanın kendi davranışının
 * aynısıdır (`knownAssetDurations()` bilinmeyen varlığı atlar) ve geçişin
 * GELEN taraf payı (`sourceIn >= D/2`) yine de doğrulanır — testin asıl
 * kanıtlamak istediği kural da odur.
 */
function expectDocValid(doc: TimelineDoc, context: string): void {
  const result = validateTimelineDoc(doc, new Map<string, number>());
  if (!result.success) {
    throw new Error(
      `${context}: editörün yazdığı doküman kendi invariant'larından geçmiyor:\n  ` +
        result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  '),
    );
  }
}

/** Kesim rozetinin ekran koordinatı (giden klibin SONU = kesim). */
async function badgePoint(editor: EditorApp, outgoingClipId: string): Promise<{ x: number; y: number }> {
  const box = await editor.timeline.clipBox(outgoingClipId);
  return {
    x: box.x + box.width,
    y: box.y + TRACK_H - BADGE_BOTTOM_GAP - BADGE_H / 2,
  };
}

/**
 * Klibin SOL kenarını hedef zamana sürükler.
 *
 * Harness'ta yalnız sağ kenar sürükleyicisi var; sol kenar bu dilime özgü
 * (kaynak payı ancak sol kenarı SAĞA kırparak doğar). Aynı sözleşme:
 * kırpma imlecin BULUNDUĞU zamanı yeni kenar yapar, dolayısıyla yakalama
 * noktasının kenardan 3 px içeride olması sonucu etkilemez.
 */
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

/**
 * Açık overlay'i (geçiş düzenleyicisi) BOŞ ALANA gerçek tıklamayla kapatır.
 *
 * Neden gerekli: kısayol dağıtıcısı, odak bir metin alanındayken hiçbir
 * kısayolu ele almaz (`isEditableTarget` — "yazmak kısayollara üstün gelir",
 * Inspector alanlarıyla aynı kural). Süre alanına yazdıktan sonra Ctrl+Z
 * doğrudan basılırsa tarayıcının METİN geri alması çalışır, dokümanınki değil.
 * Kullanıcı da bir yere tıklayıp öyle geri alır; test aynısını yapar.
 */
async function dismissOverlays(editor: EditorApp): Promise<void> {
  const wrap = await editor.timeline.wrapBox();
  // İkinci track satırı (V2) boş: klibe/rozete değmeyen kesin bir boşluk.
  await editor.timeline.click({
    x: wrap.x + 30,
    y: wrap.y + 28 + (TRACK_H + 6) + TRACK_H / 2,
  });
}

/**
 * Ön koşulu GERÇEK jestlerle kurar: clipB'ye kaynak payı açar ve clipA'yı
 * clipB'ye yapıştırır. Kurulan kesimin zamanını döndürür.
 */
async function makeAdjacentCutWithHandle(
  editor: EditorApp,
  seed: { clipAId: string; clipBId: string },
  handleUs: number,
): Promise<number> {
  // 1) clipB'nin SOL kenarını sağa kırp -> sourceIn = handleUs.
  const targetStartUs = SEED_TIMES.clipBStartUs + handleUs;
  await dragLeftEdgeToTime(editor, seed.clipBId, targetStartUs);

  let doc = await readDoc(editor.page);
  const clipB = clipOf(doc, seed.clipBId);
  expect(
    clipB.sourceInUs,
    `Ön koşul: clipB'nin sol kenarı kırpılıp ${handleUs}µs kaynak payı açılmalıydı ` +
      `(sourceIn=${String(clipB.sourceInUs)}).`,
  ).toBeGreaterThan(handleUs / 2);

  // 2) clipA'yı sağa sürükle -> sonu clipB'nin başına otursun (yapışma yakalar).
  const clipA = clipOf(doc, seed.clipAId);
  const deltaUs = clipB.timelineStartUs - (clipA.timelineStartUs + clipA.timelineDurationUs);
  await editor.timeline.dragClipByTime(seed.clipAId, deltaUs);

  doc = await readDoc(editor.page);
  const movedA = clipOf(doc, seed.clipAId);
  const movedB = clipOf(doc, seed.clipBId);
  const cutUs = movedA.timelineStartUs + movedA.timelineDurationUs;
  expect(
    cutUs,
    'Ön koşul: clipA sürüklenip clipB ile BİTİŞİK hale gelmeliydi (yapışma kesime oturtur).',
  ).toBe(movedB.timelineStartUs);
  return cutUs;
}

test.describe('Geçişler — gerçek fare', () => {
  test.beforeEach(async ({ editor, seed }) => {
    await editor.ensureContentVisible(seed.clipAId);
  });

  test('kesim rozetine tıklayıp tip seçmek simetrik ve geçerli bir geçiş yazar', async ({
    editor,
    seed,
  }) => {
    const cutUs = await makeAdjacentCutWithHandle(editor, seed, 2 * SECOND_US);
    const settings = await readProjectSettings(editor.page);
    const fps: Rational = settings.fps;

    // Kesimde rozet var mı? -> gerçek tıklama ile düzenleyici açılmalı.
    await editor.timeline.click(await badgePoint(editor, seed.clipAId));
    await expect(
      editor.page.getByTestId('transition-editor'),
      'Kesim rozetine tıklayınca geçiş düzenleyicisi açılmalı ' +
        '([data-testid="transition-editor"]).',
    ).toBeVisible();

    await editor.page.getByTestId('transition-type-crossfade').click();
    await editor.page.waitForTimeout(150);

    const doc = await readDoc(editor.page);
    const a = clipOf(doc, seed.clipAId);
    const b = clipOf(doc, seed.clipBId);

    expect(a.transitionOut, 'Giden klipte transitionOut olmalı.').toBeDefined();
    expect(b.transitionIn, 'Gelen klipte transitionIn olmalı.').toBeDefined();
    // Simetri invariant'ı (§5.2): iki taraf DERİN-EŞİT.
    expect(a.transitionOut).toEqual(b.transitionIn);
    expect(a.transitionOut!.type).toBe('crossfade');

    // Süre çift KARE sayısına oturmuş olmalı (§5.2 D/2 tam kare).
    const durationUs = a.transitionOut!.durationUs;
    const frames = usToFrame(durationUs, fps);
    expect(frameToUs(frames, fps), 'Süre proje kare ızgarasında olmalı.').toBe(durationUs);
    expect(frames % 2, 'Kare sayısı ÇİFT olmalı (D/2 tam kare).').toBe(0);
    // Üst sınır: D*2 <= kısa komşunun süresi.
    expect(durationUs * 2).toBeLessThanOrEqual(
      Math.min(a.timelineDurationUs, b.timelineDurationUs),
    );
    // Pay: gelen klibin başında D/2 kadar kaynak olmalı.
    expect(b.sourceInUs!).toBeGreaterThanOrEqual(Math.round(durationUs / 2));

    // Ve dokümanın TAMAMI şemadan geçmeli.
    expectDocValid(doc, 'Geçiş eklendikten sonra');

    // Kesim yeri değişmedi: geçiş metadata'dır, timeline'ı kaydırmaz (§5.1).
    expect(a.timelineStartUs + a.timelineDurationUs).toBe(cutUs);
    expect(b.timelineStartUs).toBe(cutUs);
  });

  test('süreyi değiştirmek dokümanı günceller, Ctrl+Z geri alır', async ({ editor, seed }) => {
    await makeAdjacentCutWithHandle(editor, seed, 2 * SECOND_US);
    const settings = await readProjectSettings(editor.page);
    const fps: Rational = settings.fps;

    await editor.timeline.click(await badgePoint(editor, seed.clipAId));
    await editor.page.getByTestId('transition-type-crossfade').click();
    await editor.page.waitForTimeout(150);

    const added = await readDoc(editor.page);
    const durationBefore = clipOf(added, seed.clipAId).transitionOut!.durationUs;
    const historyBefore = (await editor.state()).historyLabels.length;

    // Süre alanına GERÇEK klavyeyle yaz (0.5 sn) ve Enter'la uygula.
    const field = editor.page.getByTestId('transition-duration');
    await field.click();
    await editor.page.keyboard.press('Control+a');
    await editor.page.keyboard.type('0.5');
    await editor.page.keyboard.press('Enter');
    await editor.page.waitForTimeout(150);

    const changed = await readDoc(editor.page);
    const a = clipOf(changed, seed.clipAId);
    const b = clipOf(changed, seed.clipBId);

    // BEKLENEN DEĞER, uygulamadan değil SÖZLEŞMEDEN türetilir (§5.2):
    //   D_frames = 2 * max(1, roundHalfUp(frameFromUs(D) / 2))
    // 0.5 sn @30fps = 15 kare, yani TEK; çift-kare kuralı 16 kareye yuvarlar
    // (D/2 tam kare olmak zorunda). Yani "0.5 yazdım, 0.533 oldu" bir hata
    // değil, sözleşmenin ta kendisidir — test de tam bunu kilitler.
    const requestedFrames = usToFrame(SECOND_US / 2, fps);
    expect(requestedFrames % 2, 'Bu testin anlamı 0.5 sn\'nin TEK kare olmasına dayanıyor.').toBe(1);
    const expectedUs = frameToUs(2 * Math.max(1, Math.round(requestedFrames / 2)), fps);
    expect(
      a.transitionOut!.durationUs,
      `0.5 sn isteği çift kare ızgarasında ${expectedUs}µs olmalıydı.`,
    ).toBe(expectedUs);
    expect(usToFrame(a.transitionOut!.durationUs, fps) % 2).toBe(0);
    expect(a.transitionOut!.durationUs).not.toBe(durationBefore);
    expect(b.transitionIn, 'Süre değişimi de İKİ tarafa yazılmalı.').toEqual(a.transitionOut);
    expectDocValid(changed, 'Süre değiştikten sonra');

    const afterState = await editor.state();
    expect(
      afterState.historyLabels.length,
      'Süre değişimi tek bir history girdisi olmalı.',
    ).toBe(historyBefore + 1);
    expect(afterState.historyLabels.at(-1)).toMatch(/geçiş/i);

    // Ctrl+Z: önceki süreye dön. Önce odağı süre alanından çıkar (bkz.
    // dismissOverlays) — aksi halde tarayıcının metin geri alması çalışır.
    await dismissOverlays(editor);
    await expect(editor.page.getByTestId('transition-editor')).toHaveCount(0);
    await editor.page.keyboard.press('Control+z');
    await editor.page.waitForTimeout(200);
    const undone = await readDoc(editor.page);
    expect(
      clipOf(undone, seed.clipAId).transitionOut!.durationUs,
      'Ctrl+Z süre değişimini geri almalı.',
    ).toBe(durationBefore);
    expect(clipOf(undone, seed.clipBId).transitionIn!.durationUs).toBe(durationBefore);
    expectDocValid(undone, 'Undo sonrası');

    // Bir kez daha: geçişin kendisi de kalkmalı.
    await editor.page.keyboard.press('Control+z');
    await editor.page.waitForTimeout(200);
    const undoneTwice = await readDoc(editor.page);
    expect(clipOf(undoneTwice, seed.clipAId).transitionOut).toBeUndefined();
    expect(clipOf(undoneTwice, seed.clipBId).transitionIn).toBeUndefined();
    expectDocValid(undoneTwice, 'İkinci undo sonrası');
  });

  test('sağ tık menüsünden geçiş eklenir ve kaldırılır', async ({ editor, seed }) => {
    await makeAdjacentCutWithHandle(editor, seed, 2 * SECOND_US);

    // Kesime YAKIN sağ tık: menü "sağ kesim"i hedeflemeli (clipA'nın sonu).
    const box = await editor.timeline.clipBox(seed.clipAId);
    const nearCut = { x: box.x + box.width - 20, y: box.y + TRACK_H / 2 };
    await editor.timeline.click(nearCut, 'right');
    await expect(editor.contextMenu).toBeVisible();

    const addItem = editor.contextMenuItem(/geçiş ekle/i);
    await expect(addItem, 'Klip menüsünde "Geçiş ekle" bekleniyor.').toBeVisible();
    await expect(addItem).toContainText(/sağ kesim/i);
    await addItem.click();
    await editor.page.waitForTimeout(200);

    let doc = await readDoc(editor.page);
    expect(
      clipOf(doc, seed.clipAId).transitionOut,
      'Menüden eklenen geçiş dokümanda olmalı.',
    ).toBeDefined();
    expect(clipOf(doc, seed.clipBId).transitionIn).toEqual(
      clipOf(doc, seed.clipAId).transitionOut,
    );
    expectDocValid(doc, 'Menüden ekleme sonrası');

    // Kaldır.
    await editor.timeline.click(nearCut, 'right');
    await expect(editor.contextMenu).toBeVisible();
    const removeItem = editor.contextMenuItem(/geçişi kaldır/i);
    await expect(removeItem).toContainText(/sağ kesim/i);
    await removeItem.click();
    await editor.page.waitForTimeout(200);

    doc = await readDoc(editor.page);
    expect(clipOf(doc, seed.clipAId).transitionOut).toBeUndefined();
    expect(clipOf(doc, seed.clipBId).transitionIn).toBeUndefined();
    expectDocValid(doc, 'Menüden kaldırma sonrası');
  });

  /**
   * PAY YOK senaryosu — ürün kararının kanıtı.
   *
   * clipB `sourceIn = 0` ile durur: gelen tarafta D/2'lik kaynak yoktur, yani
   * §5.5'e göre D_eff 2 karenin altına düşer ve geçiş REDDEDİLİR. Beklenen
   * davranış sessiz ret DEĞİL: rozet düzenleyiciyi hiç açmaz, gerekçe görünür
   * bir uyarı olur ve menü öğesi gri kalır.
   */
  test('kaynak payı olmayan kesimde geçiş reddedilir ve gerekçe GÖRÜNÜR', async ({
    editor,
    seed,
  }) => {
    // Yalnız bitişiklik kur; clipB'ye pay AÇMA (sourceIn = 0 kalsın).
    const before = await readDoc(editor.page);
    const a = clipOf(before, seed.clipAId);
    const b = clipOf(before, seed.clipBId);
    expect(b.sourceInUs, 'Seed clipB sourceIn=0 ile gelmeli (bu testin ön koşulu).').toBe(0);
    await editor.timeline.dragClipByTime(
      seed.clipAId,
      b.timelineStartUs - (a.timelineStartUs + a.timelineDurationUs),
    );

    const adjacent = await readDoc(editor.page);
    const movedA = clipOf(adjacent, seed.clipAId);
    expect(
      movedA.timelineStartUs + movedA.timelineDurationUs,
      'Ön koşul: klipler bitişik olmalı.',
    ).toBe(clipOf(adjacent, seed.clipBId).timelineStartUs);

    // Rozete tıkla: düzenleyici AÇILMAMALI, uyarı görünmeli.
    await editor.timeline.click(await badgePoint(editor, seed.clipAId));
    await expect(
      editor.page.getByTestId('transition-editor'),
      'Pay yokken düzenleyici açılmamalı (altı tipi gösterip her birinde ret vermek ' +
        '"tıklıyorum bir şey olmuyor" demektir).',
    ).toHaveCount(0);
    await expect(
      editor.warningToast,
      'Reddin gerekçesi kullanıcıya GÖRÜNÜR bir uyarı olarak söylenmeli.',
    ).toBeVisible();
    await expect(editor.warningToast).toContainText(/geçiş/i);

    // Menü öğesi de gri olmalı (menü, op'un reddedeceğini teklif etmez).
    const box = await editor.timeline.clipBox(seed.clipAId);
    await editor.timeline.click(
      { x: box.x + box.width - 20, y: box.y + TRACK_H / 2 },
      'right',
    );
    await expect(editor.contextMenu).toBeVisible();
    const addItem = editor.page
      .locator('[data-testid="timeline-context-menu"] button')
      .filter({ hasText: /geçiş ekle/i })
      .first();
    await expect(addItem, '"Geçiş ekle" pay yokken devre dışı olmalı.').toBeDisabled();
    await editor.page.keyboard.press('Escape');

    // Ve doküman gerçekten temiz kaldı.
    const after = await readDoc(editor.page);
    expect(clipOf(after, seed.clipAId).transitionOut).toBeUndefined();
    expect(clipOf(after, seed.clipBId).transitionIn).toBeUndefined();
    expectDocValid(after, 'Reddedilen ekleme sonrası');
  });

  /**
   * Kırpma geçişli kenarı bozarsa: sessiz düzeltme YOK.
   * clipA'nın sağ kenarını sola çekmek kesimi koparır -> geçiş kalkar, uyarı
   * çıkar. (Kısaltma/kaldırma kararının kendisi birim testlerde; burada
   * kanıtlanan şey GERÇEK bir kırpma jestinin bunu tetiklediği ve kullanıcının
   * bunu GÖRDÜĞÜ.)
   */
  test('geçişli kenarı gerçek fareyle kırpmak sessiz kalmaz', async ({ editor, seed }) => {
    const cutUs = await makeAdjacentCutWithHandle(editor, seed, 2 * SECOND_US);
    await editor.timeline.click(await badgePoint(editor, seed.clipAId));
    await editor.page.getByTestId('transition-type-crossfade').click();
    await editor.page.waitForTimeout(150);
    expect(clipOf(await readDoc(editor.page), seed.clipAId).transitionOut).toBeDefined();

    // Düzenleyiciyi kapat (Escape), sonra sağ kenarı 2 sn sola çek.
    await editor.page.keyboard.press('Escape');
    await editor.page.waitForTimeout(100);
    await editor.timeline.dragRightEdgeToTime(seed.clipAId, cutUs - 2 * SECOND_US);

    // Uyarı ÖNCE okunur: balonun ömrü kısıtlı (feedback.ts WARNING_TTL_MS),
    // araya doküman okuması koymak testi zamanlamaya bağımlı kılardı.
    await expect(
      editor.warningToast,
      'Geçişin kaldırılması SESSİZ olamaz — kullanıcı ne olduğunu görmeli.',
    ).toBeVisible();

    const doc = await readDoc(editor.page);
    const a = clipOf(doc, seed.clipAId);
    expect(
      a.timelineStartUs + a.timelineDurationUs,
      `Kırpma clipA'nın sonunu ${cutUs - 2 * SECOND_US}µs civarına çekmeliydi.`,
    ).toBeLessThan(cutUs - SECOND_US);
    expect(a.transitionOut, 'Kesim koptu -> geçiş kalkmalı.').toBeUndefined();
    expect(clipOf(doc, seed.clipBId).transitionIn, 'Karşı taraf da temizlenmeli.').toBeUndefined();
    expectDocValid(doc, 'Geçişli kenar kırpıldıktan sonra');
  });

  /**
   * Rozet kesimin ÜSTÜNDE duruyor ve trim tutamakları da aynı x'te. Rozet
   * bilerek şeridin ALT bandına yerleştirildi (geometry.ts): kenarın DİKEY
   * ORTASINDAN başlayan kırpma/roll jesti — timeline-mouse.spec'in kullandığı
   * yol — bozulmamalı. Bozulsaydı geçiş özelliği, çalışan bir kırpmayı
   * öldürerek gelirdi.
   */
  test('geçiş rozeti trim tutamağını çalmaz (kesimde roll hâlâ çalışıyor)', async ({
    editor,
    seed,
  }) => {
    const cutUs = await makeAdjacentCutWithHandle(editor, seed, 2 * SECOND_US);
    const before = await readDoc(editor.page);
    const durationBefore = clipOf(before, seed.clipAId).timelineDurationUs;
    const state = await editor.state();

    // Hedef: kesimi 2 sn sola yuvarla. Ön koşul — hedef, YAPIŞMA eşiğinin
    // dışında olmalı; yoksa test kırpmayı değil snap'i ölçerdi (ilk koşuda tam
    // bu oldu: 1 sn'lik hedef 8 px eşiğinin içine düşüp jesti no-op yaptı).
    const targetEndUs = cutUs - 2 * SECOND_US;
    expect(
      8 / state.pxPerUs,
      'Yapışma eşiği 2 sn\'yi aşarsa bu test snap davranışını ölçer, kırpmayı değil.',
    ).toBeLessThan(2 * SECOND_US);

    await editor.timeline.dragRightEdgeToTime(seed.clipAId, targetEndUs);

    const after = await readDoc(editor.page);
    const a = clipOf(after, seed.clipAId);
    const b = clipOf(after, seed.clipBId);
    await expect(
      editor.page.getByTestId('transition-editor'),
      'Kenarın dikey ortasından sürüklemek rozeti AÇMAMALI (bu bir kırpma jesti).',
    ).toHaveCount(0);
    expect(
      a.timelineDurationUs,
      'Rozet, kesimdeki trim tutamağını yutmamalı (jest bir kırpma üretmeliydi).',
    ).toBeLessThan(durationBefore);

    const tolUs = TOLERANCE_PX / state.pxPerUs;
    expect(
      Math.abs(a.timelineStartUs + a.timelineDurationUs - targetEndUs),
      `Kesim ${targetEndUs}µs'ye taşınmalıydı (±${TOLERANCE_PX} px).`,
    ).toBeLessThan(tolUs);
    // Bitişik kenarda kırpma ROLL'dür: komşu kesimi takip eder, boşluk açılmaz.
    expect(b.timelineStartUs, 'Roll sonrası klipler hâlâ bitişik olmalı.').toBe(
      a.timelineStartUs + a.timelineDurationUs,
    );
  });
});

// ---------------------------------------------------------------------------
// ÖNİZLEME (rendering-semantics §5.3) — denetim bulgusu
// ---------------------------------------------------------------------------
//
// Bulgu (YÜKSEK): geçiş dokümana yazılıyordu ama OYNATICI hiç uygulamıyordu —
// `resolveVisualStack` track başına tek klip döndürüyor, kullanıcı önizlemede
// SERT KESİM görüp export'ta crossfade alıyordu. Aşağıdaki iki test o iddianın
// iki ayrı kanıt seviyesidir:
//
//   1. "pencere oynatıcıya ULAŞIYOR mu?"  -> gerçek fareyle scrub + gösterge
//      (medya gerektirmez, her ortamda koşar),
//   2. "iki kaynak GERÇEKTEN karışıyor mu?" -> gerçek medya + canvas PİKSELİ;
//      geçiş kaldırılınca aynı karede imza TEK kaynağa döner (negatif kontrol).

/** Oynatıcıdaki geçiş göstergesi (PlayerPanel). */
function transitionNote(editor: EditorApp) {
  return editor.page.getByTestId('preview-transition-note');
}

/**
 * Kesimin çevresinde, bir pikselin `maxUsPerPx`'ten az zamana denk geldiği bir
 * yakınlığa kadar GERÇEK Ctrl+wheel ile yakınlaşır.
 *
 * Neden şart: sığdırılmış görünümde 82 sn ~670 px'e sığar, yani bir piksel ~8 sn
 * eder — 1 sn'lik bir geçiş penceresinin İÇİNE cetvelden tıklayarak girmek
 * imkânsızdır. Zoom olmadan bu test "pencere yok" derdi, oysa ölçüm aleti kördü.
 */
async function zoomForWindow(
  editor: EditorApp,
  clipId: string,
  maxUsPerPx: number,
): Promise<void> {
  for (let i = 0; i < 25; i++) {
    const state = await editor.state();
    if (1 / state.pxPerUs <= maxUsPerPx) return;
    const box = await editor.timeline.clipBox(clipId, state);
    await editor.timeline.ctrlWheel(-120, {
      x: box.x + box.width,
      y: box.y + TRACK_H / 2,
    });
  }
  const state = await editor.state();
  expect(
    1 / state.pxPerUs,
    'Ctrl+wheel ile yeterince yakınlaşılamadı — pencere içine tıklanamaz.',
  ).toBeLessThanOrEqual(maxUsPerPx);
}

/**
 * Klip bloğu verilen genişliğe ulaşana kadar GERÇEK Ctrl+wheel ile yakınlaşır.
 *
 * Neden şart: kesim rozeti dar bloklarda ÇİZİLMEZ (geometry.ts
 * TRANSITION_BADGE_MIN_CLIP_W = 26 px) — 2 sn'lik klipler sığdırılmış görünümde
 * ~20 px olur ve rozete tıklamak imkânsızdır. Kullanıcı da aynı şeyi yapar:
 * çalışacağı kesime yakınlaşır.
 */
async function zoomUntilClipWide(
  editor: EditorApp,
  clipId: string,
  minWidthPx: number,
): Promise<void> {
  for (let i = 0; i < 25; i++) {
    const box = await editor.timeline.clipBox(clipId);
    if (box.width >= minWidthPx) return;
    await editor.timeline.ctrlWheel(-120, { x: box.x + box.width / 2, y: box.y + TRACK_H / 2 });
  }
  expect(
    (await editor.timeline.clipBox(clipId)).width,
    'Ctrl+wheel ile klip bloğu yeterince genişletilemedi (rozete tıklanamaz).',
  ).toBeGreaterThanOrEqual(minWidthPx);
}

/** Göstergedeki ilerleme yüzdesi ("Geçiş: Çapraz geçiş %48" -> 48). */
async function noteProgressPercent(editor: EditorApp): Promise<number> {
  const text = await transitionNote(editor).innerText();
  const match = /%\s*(\d+)/.exec(text);
  expect(match, `Gösterge metninde yüzde yok: "${text}"`).not.toBeNull();
  return Number(match![1]);
}

test.describe('Geçiş önizlemesi — pencere oynatıcıya ulaşıyor mu (gerçek fare)', () => {
  test('playhead geçiş penceresindeyken oynatıcı "geçiş" göstergesi çıkar, dışında ÇIKMAZ', async ({
    editor,
    seed,
  }) => {
    await editor.ensureContentVisible(seed.clipAId);
    const cutUs = await makeAdjacentCutWithHandle(editor, seed, 2 * SECOND_US);

    await editor.timeline.click(await badgePoint(editor, seed.clipAId));
    await editor.page.getByTestId('transition-type-crossfade').click();
    await editor.page.waitForTimeout(150);

    const doc = await readDoc(editor.page);
    const durationUs = clipOf(doc, seed.clipAId).transitionOut!.durationUs;
    expect(durationUs, 'Ön koşul: geçiş yazılmış olmalı.').toBeGreaterThan(0);

    // Pencere [T-D/2, T+D/2): içine tıklayabilmek için D/20 hassasiyet yeter.
    await zoomForWindow(editor, seed.clipAId, durationUs / 20);

    // --- kesim anı: pencerenin TAM ORTASI ---
    await editor.timeline.scrubTo(cutUs);
    await expect(
      transitionNote(editor),
      'Kesimin üstünde oynatıcı "geçiş" göstergesi göstermeli — geçişin ' +
        'önizlemede uygulandığının kullanıcıya görünen tek işareti bu.',
    ).toBeVisible();
    await expect(transitionNote(editor)).toContainText(/çapraz geçiş/i);
    const half = await noteProgressPercent(editor);
    expect(half, 'Kesim anında ilerleme %50 olmalı (p = 0.5).').toBeGreaterThanOrEqual(44);
    expect(half).toBeLessThanOrEqual(56);

    // --- pencerenin ilk çeyreği: ilerleme ~%25 (p playhead'i İZLİYOR) ---
    await editor.timeline.scrubTo(cutUs - durationUs / 4);
    await expect(transitionNote(editor)).toBeVisible();
    const quarter = await noteProgressPercent(editor);
    expect(quarter, 'Pencerenin ilk çeyreğinde ilerleme ~%25 olmalı.').toBeGreaterThanOrEqual(19);
    expect(quarter).toBeLessThanOrEqual(31);

    // --- NEGATİF KONTROL 1: pencerenin dışında gösterge YOK ---
    await editor.timeline.scrubTo(cutUs - durationUs);
    await expect(
      transitionNote(editor),
      'Pencere dışında gösterge kalmamalı (her karede "geçiş" demek = hiç dememek).',
    ).toHaveCount(0);

    // --- NEGATİF KONTROL 2: geçiş kaldırılınca kesimde de gösterge YOK ---
    const box = await editor.timeline.clipBox(seed.clipAId);
    await editor.timeline.click(
      { x: box.x + Math.max(20, box.width - 20), y: box.y + TRACK_H / 2 },
      'right',
    );
    await expect(editor.contextMenu).toBeVisible();
    await editor.contextMenuItem(/geçişi kaldır/i).click();
    await editor.page.waitForTimeout(200);
    expect(clipOf(await readDoc(editor.page), seed.clipAId).transitionOut).toBeUndefined();

    await editor.timeline.scrubTo(cutUs);
    await expect(
      transitionNote(editor),
      'Geçiş kalktıysa sert kesim vardır — gösterge de olmamalı.',
    ).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Piksel imzası — GERÇEK medya
// ---------------------------------------------------------------------------

/** e2e/.artifacts/media (gitignore) — koşumlar arasında yeniden kullanılır. */
const MEDIA_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '.artifacts', 'media');

/**
 * DÜZ RENKLİ test videosu (4 sn, sessiz).
 *
 * Neden testsrc2 değil: geçişin kanıtı bir PİKSEL İMZASI. Her karesi farklı olan
 * bir kaynakta "beklenen renk" hesaplanamaz (±1 kare kayması imzayı değiştirir);
 * düz renkte ise beklenen değer §5.3'ün formülünden TÜRETİLİR ve handle
 * malzemesi de aynı renktedir, yani kare hassasiyetinden bağımsızdır.
 *
 * Renkler kasten doygun değil: 4:2:0 + limited-range gidiş-dönüşü doygun kırmızıda
 * birkaç birim kayar; orta tonlarda iki kaynak arasında kanal başına ~150 birim
 * fark kalır, bu da imzayı ayırt etmeye fazlasıyla yeter.
 */
const SOLID_A = { name: 'e2e-solid-a.mp4', hex: '0xC83232', rgb: { r: 200, g: 50, b: 50 } };
const SOLID_B = { name: 'e2e-solid-b.mp4', hex: '0x3250C8', rgb: { r: 50, g: 80, b: 200 } };
const SOLID_DURATION_SEC = 4;

function ensureSolidVideo(spec: { name: string; hex: string }): string {
  const path = join(MEDIA_DIR, spec.name);
  if (existsSync(path)) return path;
  mkdirSync(MEDIA_DIR, { recursive: true });
  const res = spawnSync(
    'ffmpeg',
    [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi',
      '-i', `color=c=${spec.hex}:s=640x480:rate=30:duration=${SOLID_DURATION_SEC}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-b:v', '2000k', '-movflags', '+faststart',
      path,
    ],
    { encoding: 'utf8', timeout: 120_000 },
  );
  if (res.status !== 0 || !existsSync(path)) {
    throw new Error(`Duz renkli test videosu uretilemedi (ffmpeg ${res.status}):\n${res.stderr}`);
  }
  return path;
}

/** Önizleme kompozitöründen tek piksel (proje koordinatı) — bkz. speed-color.spec.ts. */
async function probePixel(page: Page, x: number, y: number): Promise<[number, number, number, number]> {
  const value = await page.evaluate(
    async ([px, py]: [number, number]) => {
      const hook = (window as unknown as {
        __videoeditPlayer?: { version: number; probePixel(x: number, y: number): Promise<number[]> };
      }).__videoeditPlayer;
      if (!hook || hook.version !== 1) return null;
      return hook.probePixel(px, py);
    },
    [x, y] as [number, number],
  );
  expect(value, 'window.__videoeditPlayer yok (Vite DEV sunucusuna baglanildi mi?).').not.toBeNull();
  return value as [number, number, number, number];
}

async function centrePixel(page: Page): Promise<[number, number, number, number]> {
  const settings = await readProjectSettings(page);
  return probePixel(page, Math.floor(settings.width / 2), Math.floor(settings.height / 2));
}

/**
 * Kanal toleransı. Kaynak renkler arasında kanal başına ~150 birim var; 20
 * birimlik pay yuvarlama/renk-uzayı gidiş-dönüşünü karşılar ama "karışım mı,
 * tek kaynak mı?" sorusunu asla belirsiz bırakmaz.
 */
const CHANNEL_TOLERANCE = 20;

function near(actual: readonly number[], expected: readonly number[], tol = CHANNEL_TOLERANCE): boolean {
  return [0, 1, 2].every((i) => Math.abs(actual[i]! - expected[i]!) <= tol);
}

function rgba(c: { r: number; g: number; b: number }): Rgba {
  return { r: c.r / 255, g: c.g / 255, b: c.b / 255, a: 1 };
}

/** Bir koşulun verilen süre içinde sağlanıp sağlanmadığı (atlama kararı için). */
async function becomesTrue(
  probe: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

test.describe('Geçiş önizlemesi — canvas piksel imzası (gerçek medya)', () => {
  test('geçişin ortasındaki karede İKİ kaynak karışır; geçiş kalkınca imza TEK kaynağa döner', async ({
    page,
    account,
  }) => {
    test.skip(ffmpegVersion() === null, FFMPEG_SKIP_REASON);
    // Yükleme + worker işleme + ilk decode: varsayılan 60 sn yetmez.
    test.setTimeout(420_000);

    const fileA = ensureSolidVideo(SOLID_A);
    const fileB = ensureSolidVideo(SOLID_B);
    const project = await createEmptyProject(
      account.context.request,
      account.accessToken,
      'E2E gecis piksel',
    );

    const app = new EditorApp(page);
    await app.open(project.projectId, { email: account.email, password: account.password });
    const library = new LibraryPanelHarness(page);

    // --- 1) GERÇEK yükleme: iki düz renkli kaynak, worker işleyene kadar bekle ---
    await library.pickFiles([fileA, fileB]);
    await library.waitForReady(SOLID_A.name);
    await library.waitForReady(SOLID_B.name);

    const assets = await listProjectAssets(
      account.context.request,
      account.accessToken,
      project.projectId,
    );
    const assetA = assets.find((a) => a.fileName === SOLID_A.name);
    const assetB = assets.find((a) => a.fileName === SOLID_B.name);
    expect(assetA, 'A kaynagi listede yok.').toBeDefined();
    expect(assetB, 'B kaynagi listede yok.').toBeDefined();

    // --- 2) Doküman ön koşulu API'den: BİTİŞİK iki klip + gelen tarafta pay ---
    // (fixtures/seed.ts ile aynı gerekçe: kurulum API'den, JEST gerçek fareden.)
    const startUs = 60 * SECOND_US;
    const clipDurUs = 2 * SECOND_US;
    const cutUs = startUs + clipDurUs;
    const clipAId = crypto.randomUUID();
    const clipBId = crypto.randomUUID();
    const trackId = crypto.randomUUID();
    const clip = (id: string, assetId: string, tStart: number, sourceInUs: number) => ({
      id,
      kind: 'video',
      assetId,
      timelineStartUs: tStart,
      timelineDurationUs: clipDurUs,
      sourceInUs,
      sourceOutUs: sourceInUs + clipDurUs,
      speed: { rate: 1 },
      audio: null,
      transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5 },
      keyframes: {},
      effects: [],
      opacity: 1,
    });
    const timeline = {
      schemaVersion: 1,
      projectId: project.projectId,
      settings: {
        width: 1920,
        height: 1080,
        fps: { num: 30, den: 1 },
        audioSampleRate: 48000,
        backgroundColor: '#000000',
      },
      tracks: [
        {
          id: trackId,
          type: 'video',
          name: 'V1',
          muted: false,
          hidden: false,
          locked: false,
          clips: [
            // A: kaynağın [0,2 sn)'si — kuyruk payı 2 sn (varlık 4 sn).
            clip(clipAId, assetA!.id, startUs, 0),
            // B: kaynağın [1 sn,3 sn)'si — baş payı 1 sn (D/2 için fazlasıyla).
            clip(clipBId, assetB!.id, cutUs, 1 * SECOND_US),
          ],
        },
      ],
      markers: [],
    };
    const detail = await account.context.request.get(`/api/projects/${project.projectId}`, {
      headers: { Authorization: `Bearer ${account.accessToken}` },
    });
    const revision = ((await detail.json()) as { revisionNumber: number }).revisionNumber;
    await saveTimeline(
      account.context.request,
      account.accessToken,
      project.projectId,
      timeline,
      revision,
    );
    await app.open(project.projectId, { email: account.email, password: account.password });
    await app.ensureContentVisible(clipAId);

    // --- 3) Ön koşul: önizleme bu kaynakları GERÇEKTEN çözebiliyor mu? ---
    // Çözemiyorsa (tarayıcıda H.264 yok, proxy gelmedi) bu testin ölçtüğü şey
    // ürün değil ORTAMDIR; sahte kırmızı yerine gerekçeli atlama.
    await app.timeline.scrubTo(startUs + SECOND_US);
    const decoded = await becomesTrue(
      async () => near(await centrePixel(page), [SOLID_A.rgb.r, SOLID_A.rgb.g, SOLID_A.rgb.b]),
      30_000,
    );
    test.skip(
      !decoded,
      'Onizleme klip A nin rengini hic gostermedi: tarayici proxy yi (H.264) cozemiyor ' +
        'ya da presigned URL gelmedi. Gecis PIKSEL testi ORTAM nedeniyle atlandi — ' +
        'pencere/gosterge kaniti icin "pencere oynaticiya ulasiyor mu" testine bakin.',
    );

    // Klip B tek başına da doğru renkte mi? (imzaların ayırt ediciliği)
    await app.timeline.scrubTo(cutUs + SECOND_US);
    await expect
      .poll(async () => near(await centrePixel(page), [SOLID_B.rgb.r, SOLID_B.rgb.g, SOLID_B.rgb.b]), {
        timeout: 20_000,
        message: 'On kosul: klip B kendi basina kendi rengini gostermeli.',
      })
      .toBe(true);

    // --- 4) GERÇEK fare: kesim rozeti -> crossfade ---
    // Rozet dar blokta çizilmez: önce kesime yakınlaş (kullanıcının yaptığı gibi).
    await zoomUntilClipWide(app, clipAId, 120);
    await app.timeline.click(await badgePoint(app, clipAId));
    await expect(
      page.getByTestId('transition-editor'),
      'Kesim rozetine tiklayinca gecis duzenleyicisi acilmali.',
    ).toBeVisible();
    await page.getByTestId('transition-type-crossfade').click();
    await page.waitForTimeout(200);

    const doc = await readDoc(page);
    const durationUs = clipOf(doc, clipAId).transitionOut!.durationUs;
    expect(durationUs, 'Gecis dokumana yazilmali.').toBeGreaterThan(0);
    expect(clipOf(doc, clipBId).transitionIn).toEqual(clipOf(doc, clipAId).transitionOut);
    await page.keyboard.press('Escape');

    // --- 5) Pencerenin ortası: piksel İKİ kaynağın karışımı olmalı ---
    await zoomForWindow(app, clipAId, durationUs / 20);
    await app.timeline.scrubTo(cutUs);
    await expect(transitionNote(app), 'Pencerenin icindeyiz (gosterge).').toBeVisible();

    // BEKLENEN DEĞER uygulamadan değil §5.3'ün formülünden gelir.
    const expectedMix = toBytes(
      mixTransitionRef('crossfade', rgba(SOLID_A.rgb), rgba(SOLID_B.rgb), 0.5),
    );
    await expect
      .poll(async () => near(await centrePixel(page), expectedMix), {
        timeout: 20_000,
        message:
          `Gecisin ortasindaki kare §5.3'e gore yari yariya karisim olmali ` +
          `(beklenen ${expectedMix.join(',')}). Sert kesim goruluyorsa onizleme gecisi ` +
          'hic uygulamiyor demektir — denetim bulgusunun ta kendisi.',
      })
      .toBe(true);

    const blended = await centrePixel(page);
    expect(
      near(blended, [SOLID_A.rgb.r, SOLID_A.rgb.g, SOLID_A.rgb.b]),
      'Karisim A nin kendisi OLAMAZ.',
    ).toBe(false);
    expect(
      near(blended, [SOLID_B.rgb.r, SOLID_B.rgb.g, SOLID_B.rgb.b]),
      'Karisim B nin kendisi OLAMAZ.',
    ).toBe(false);

    // --- 6) NEGATİF KONTROL: geçişi kaldır -> AYNI karede imza TEK kaynak ---
    const box = await app.timeline.clipBox(clipAId);
    await app.timeline.click(
      { x: box.x + Math.max(20, box.width - 20), y: box.y + TRACK_H / 2 },
      'right',
    );
    await expect(app.contextMenu).toBeVisible();
    await app.contextMenuItem(/geçişi kaldır/i).click();
    await page.waitForTimeout(200);
    expect(clipOf(await readDoc(page), clipAId).transitionOut).toBeUndefined();

    await app.timeline.scrubTo(cutUs);
    await expect(transitionNote(app)).toHaveCount(0);
    await expect
      .poll(async () => near(await centrePixel(page), [SOLID_B.rgb.r, SOLID_B.rgb.g, SOLID_B.rgb.b]), {
        timeout: 20_000,
        message:
          'Sert kesimde kesim anindaki kare TEK kaynaktir (B). Imza hala karisiksa ' +
          'test kendi olcusunu dogrulamiyor demektir.',
      })
      .toBe(true);
  });
});
