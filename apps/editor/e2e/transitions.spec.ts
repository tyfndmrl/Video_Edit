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
import type { EditorApp } from './support/editor';
import { TRACK_H } from '../src/features/timeline/geometry';
import { SECOND_US, SEED_TIMES } from './fixtures/seed';

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
